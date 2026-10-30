// Phase 3 end-to-end: engagement checks on our replies, follow-back detection (tier/priority updates,
// no more comments), cooldown for non-responders, A/B arm assignment + suggestions, give-up removal +
// blacklist after N days without a follow-back, optional unfollow cleanup.
import { boot, setup, assert, log, sleep, passCount } from "./harness.mjs";

const DAY = 864e5, HOUR = 36e5;
const H = await boot();
const { M } = H;
let failed = false;
const seedHistory = async (recs) => (await H.page()).evaluate(async (rs) => { const X = await import("/lib/history.js"); for (const r of rs) await X.put(X.newRecord(r)); }, recs);
const patchTargets = (patches) => H.patchTargets(patches);

try {
  M.addUser("bigbob", { name: "Big Bob", followers: 40000 });
  await setup(H, { learning: { enabled: true, abTesting: true, explore: 0, abTones: ["insightful", "witty"], abPresets: [], minSamples: 4, coldAfterComments: 3, engagementCheckAfterHours: 24, maxChecksPerRun: 3 } });
  await H.msg("targetsUpsert", { rows: ["bigbob"], defaults: { tier: 2 } });
  await H.msg("start");
  const tb = await H.untilChecked(["bigbob"]);
  assert(tb.bigbob.rel.followsYou === false, "follow check: bigbob does not follow me (my followers list is empty)");

  // ---- one real comment, assigned to an A/B arm ----
  const p = M.addPost("bigbob", "Retention beats acquisition for most seed stage startups, but nobody wants to hear it.", 2);
  await H.runNow();
  const rec = await H.waitFor(async () => (await H.history()).find((x) => x.postId === p.id && x.status === "pending_review"), "pending", 90000);
  assert(rec.abArm && /^(main|insightful|witty)\|balanced$/.test(rec.abArm), "comment assigned to an A/B arm (Tone prompt or a tested tone): " + rec.abArm);
  await H.msg("reviewAction", { id: rec.id, action: "approve" });
  await H.patchState({ nextCommentAt: 0 });
  await H.runNow();
  const posted = await H.waitFor(async () => (await H.history()).find((x) => x.id === rec.id && x.status === "posted"), "posted", 120000);
  const reply = M.replies[0];
  assert(reply && posted.replyId === reply.id, "reply id captured for later checks");

  // ---- 25h later: likes + an author reply on our comment, and a follow-back ----
  reply.likes = 4;
  M.addPost("bigbob", "Exactly this, and the data agrees.", 60, { replyTo: reply.id, reply: "0x_nation" });
  M.users.bigbob.followsMe = true;
  await H.patchHistory(rec.id, { postedAt: Date.now() - 25 * HOUR });
  await patchTargets({ bigbob: { rel: { checkedAt: Date.now() - 4 * DAY, followsYou: false } } }); // profile re-check due (72h)
  await H.runNow(); // follow tracking re-checks the profile and sees the follow-back
  await H.waitFor(async () => (await H.store("sx.targets")).bigbob.rel.followsYou === true, "follow-back seen", 120000);
  await H.msg("learningRun");
  await H.waitFor(async () => { const r = (await H.history()).find((x) => x.id === rec.id); return r.results && r.results.checkedAt && r.results.followedBack ? r : null; }, "engagement + follow-back recorded", 150000);
  const r2 = (await H.history()).find((x) => x.id === rec.id);
  assert(r2.results.likes === 4 && r2.results.authorReplied === true, "engagement check read 4 likes and the author's reply");
  assert(r2.results.followedBack === true, "follow-back credited to the comment");
  const t = await H.waitFor(async () => { const x = (await H.store("sx.targets")).bigbob; return x.tier === 1 ? x : null; }, "priorities updated", 30000).catch(async () => (await H.store("sx.targets")).bigbob);
  assert(t.rel.followsYou === true && t.rel.followedBackAt, "target marked as following back");
  assert(t.group === "A", "the group mirrors the follow-back");
  const pAfter = M.addPost("bigbob", "Another retention post that should not get a comment now that bigbob follows me.", 2);
  await H.runNow();
  await sleep(8000);
  assert(!(await H.history()).find((x) => x.postId === pAfter.id), "no more comments after the follow-back");
  assert(t.tier === 1, "responding target raised to tier 1");
  assert(t.priority >= 80, "priority raised for a responsive target (" + t.priority + ")");

  // ---- conversation alerts: the author's answer is read from your mentions page (nothing is posted) ----
  const repliesBefore = M.replies.length, likesBefore = M.likes.length;
  await H.patchState({ lastMentionsAt: 0 });
  await H.runNow();
  const conv = await H.waitFor(async () => { const c = await H.store("sx.conversations"); return c && (c.items || []).find((x) => x.id === rec.id) ? c : null; }, "conversation alert", 150000);
  const item = conv.items.find((x) => x.id === rec.id);
  assert(item.target === "bigbob" && item.text === "Exactly this, and the data agrees." && item.done === false && /^https:\/\/x\.com\/bigbob\/status\/\d+$/.test(item.authorReplyUrl) && item.replyUrl === posted.replyUrl, "the author's answer is listed in sx.conversations (" + JSON.stringify(item) + ")");
  assert(M.log.some((x) => x.kind === "mentions" && x.count >= 1), "the mentions page was read");
  const rConv = (await H.history()).find((x) => x.id === rec.id);
  assert(rConv.results.authorReplied === true && rConv.results.authorReplyUrl === item.authorReplyUrl, "the reply's history record is marked 'author replied' with the answer's link");
  assert(M.replies.length === repliesBefore && M.likes.length === likesBefore, "nothing was posted or liked by the mentions check");
  let cd = await H.msg("conversationDone", { id: rec.id });
  assert(cd.ok && (await H.store("sx.conversations")).items.find((x) => x.id === rec.id).done === true, "Mark done");
  cd = await H.msg("conversationDone", { id: rec.id, done: false });
  assert(cd.ok && (await H.store("sx.conversations")).items.find((x) => x.id === rec.id).done === false, "Mark done can be undone");

  // ---- cooldown for a target that never responds ----
  M.addUser("quiet", { followers: 9000 });
  await H.msg("targetsUpsert", { rows: ["quiet"], defaults: { tier: 2 } });
  await H.markNotFollowing(["quiet"]);
  const old = Date.now() - 3 * DAY;
  await seedHistory([0, 1, 2].map((i) => ({ status: "posted", target: "quiet", group: "B", tier: 2, postId: "q" + i, postedAt: old + i * HOUR, createdAt: old + i * HOUR, comment: "c" + i, tone: "insightful", preset: "balanced", abArm: "insightful|balanced", results: { likes: 0, replies: 0, checkedAt: Date.now() - HOUR, checks: 2 } })));
  await H.msg("learningRun");
  await H.waitFor(async () => { const q = (await H.store("sx.targets")).quiet; return q && q.coldUntil > Date.now() ? q : null; }, "cooldown", 120000);
  const q = (await H.store("sx.targets")).quiet;
  assert(q.coldUntil > Date.now() + 5 * DAY && q.priority < 50, "non-responder cools down with lower priority");
  const qPost = M.addPost("quiet", "Fresh post from the quiet account that should not get a comment while cooling down.", 2);
  await H.patchState({ nextCommentAt: 0 });
  await H.runNow();
  await sleep(12000);
  assert(!(await H.history()).find((x) => x.postId === qPost.id && x.attempts > 0), "no generation for a cooling-down target");

  // ---- A/B suggestions ----
  const mk = (arm, n, succ) => Array.from({ length: n }, (_, i) => ({ status: "posted", target: "seed" + arm + i, group: "B", tier: 2, postId: arm + i, postedAt: old, createdAt: old, comment: "x", tone: arm.split("|")[0], preset: arm.split("|")[1], abArm: arm, cost: 0.002, results: { likes: i < succ ? 2 : 0, replies: 0, checkedAt: old + HOUR } }));
  await seedHistory([...mk("witty|balanced", 6, 5), ...mk("insightful|balanced", 6, 1)]);
  const sum = await H.msg("learningSummary");
  assert(sum.ok && sum.arms.length >= 2, "learning summary lists arms");
  assert(sum.suggestions.B && sum.suggestions.B.tone === "witty", "suggests the best tone: " + JSON.stringify(sum.suggestions.B));
  assert(!sum.suggestions.A, "no suggestions for accounts that follow you (never commented on)");

  // ---- give-up: 14 days of comments without a follow-back -> removed + blacklisted ----
  M.addUser("stale", { followers: 30000 });
  M.addUser("patient", { followers: 30000, followsMe: true }); // follows back just before the deadline
  await H.msg("targetsUpsert", { rows: ["stale", "patient"], defaults: { tier: 2 } });
  const firstOld = { comments: 6, firstCommentAt: Date.now() - 15 * DAY, lastCommentAt: Date.now() - DAY };
  await patchTargets({ stale: { group: "B", rel: { followsYou: false, checkedAt: Date.now() }, stats: firstOld }, patient: { group: "B", rel: { followsYou: false, checkedAt: Date.now() }, stats: firstOld } });
  await H.runNow();
  await H.waitFor(async () => { const all = await H.store("sx.targets"); return !all.stale && all.patient.rel.followsYou === true; }, "give-up checks", 150000);
  const bl = await H.store("sx.blacklist");
  assert(bl && bl.stale && bl.stale.reason === "no_followback" && bl.stale.days === 15, "after 15 days without a follow-back: removed and blacklisted");
  const pat = (await H.store("sx.targets")).patient;
  assert(pat && pat.rel.followedBackAt && !bl.patient, "a target that follows back on the final check is kept (followed back), not removed");
  assert(/no follow-back after 15 days/.test(JSON.stringify(await H.store("sx.logs"))), "removal logged");
  let up = await H.msg("targetsUpsert", { rows: ["@stale"], defaults: { tier: 2 } });
  assert(up.ok && up.added === 0 && up.blacklisted === 1, "a blacklisted account is not added again");
  const st0 = await H.msg("getStatus");
  assert(st0.status.follow.blacklisted === 1 && st0.status.follow.followedBack >= 2, "status counts the blacklist and follow-backs");
  await H.msg("blacklistRemove", { handles: ["stale"] });
  up = await H.msg("targetsUpsert", { rows: ["stale"], defaults: { tier: 2 } });
  assert(up.added === 1, "after removing it from the blacklist it can be added again");
  const ba = await H.msg("blacklistAdd", { handles: ["stale"] });
  assert(ba.ok && ba.removedTargets === 1 && !(await H.store("sx.targets")).stale, "blacklisting by hand removes the target");

  // ---- cleanup (default OFF) ----
  M.addUser("dave", { followers: 20000, iFollow: true, followsMe: false });
  M.addUser("erin", { followers: 20000, iFollow: true, followsMe: false });
  M.addUser("frank", { followers: 90000, iFollow: true, followsMe: false });
  await H.msg("targetsUpsert", { rows: ["dave", "erin"], defaults: { tier: 2 } });
  await H.msg("targetsUpsert", { rows: ["frank"], defaults: { tier: 1 } });
  const rel8 = { youFollow: true, followsYou: false, youFollowSince: Date.now() - 8 * DAY, checkedAt: Date.now() };
  await patchTargets({ dave: { rel: rel8 }, erin: { rel: rel8 }, frank: { rel: rel8 } });
  // your own followers list (cleanup's daily "Follows you" detection check reads it)
  M.addUser("fan1", { followsMe: true }); M.addUser("fan2", { followsMe: true });
  M.followers["0x_nation"] = ["fan1", "fan2"];
  let pv = await H.msg("cleanupPreview");
  assert(pv.ok && pv.enabled === false, "cleanup is OFF by default");
  await H.settings({ cleanup: { enabled: true, dailyLimit: 1, whitelist: ["erin"], protectTier1: true } });
  pv = await H.msg("cleanupPreview");
  const handles = pv.candidates.map((c) => c.handle);
  assert(handles.includes("dave") && !handles.includes("erin") && !handles.includes("frank"), "preview: whitelist and tier-1 protection respected (" + handles.join(",") + ")");
  await H.patchState({ lastUnfollowAt: 0 });
  await H.runNow();
  await H.waitFor(async () => M.unfollows.includes("dave"), "dave unfollowed", 150000);
  const d = (await H.store("sx.targets")).dave;
  assert(d.rel.youFollow === false && d.enabled === false, "unfollowed target is updated and disabled");
  assert(!M.unfollows.includes("erin") && !M.unfollows.includes("frank"), "whitelisted and tier-1 accounts were not unfollowed");
  await patchTargets({ erin: { rel: { youFollowSince: Date.now() - 9 * DAY } } });
  await H.settings({ cleanup: { whitelist: [] } });
  await H.patchState({ lastUnfollowAt: 0 });
  await H.runNow();
  await sleep(15000);
  assert(!M.unfollows.includes("erin"), "cleanup daily limit (1) respected");

  log(`\nPhase 3 e2e: ${passCount()} checks passed`);
} catch (e) {
  failed = true;
  console.error(e);
  console.error("--- SW logs (last 40) ---\n" + H.swLogs.slice(-40).join("\n"));
  try { console.error("--- activity log ---\n" + JSON.stringify((await H.store("sx.logs") || []).slice(-25).map((x) => x.msg + " " + (x.data || "")), null, 1)); } catch (_) {}
} finally {
  await H.close();
  process.exit(failed ? 1 : 0);
}
