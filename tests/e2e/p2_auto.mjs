// Phase 2 end-to-end: full auto from the first day, like + comment combo, ramp limits, active hours,
// X warnings / rate limits / repeated failures / changed page -> auto-stop, service-worker restart,
// closed X tab, queue expiry.
import { boot, setup, assert, log, sleep, passCount } from "./harness.mjs";

const DAY = 864e5, MIN = 60000;
const H = await boot();
const { M } = H;
let failed = false;
const waitStopped = (reason, t = 60000) => H.waitFor(async () => { const s = await H.store("sx.state"); return s.status === "stopped" && s.stopReason === reason ? s : null; }, "stop " + reason, t);
const xTab = async () => (await H.ctx.pages()).find((p) => /^https:\/\/x\.com\//.test(p.url()));

try {
  M.addUser("bigbob", { name: "Big Bob", verified: true, followers: 250000 });
  M.addUser("alice", { name: "Alice", followers: 8200 });
  await setup(H, { mode: "auto", safety: { like: { enabled: true }, ramp: [10, 20, 30] } }); // a ramp, to test ramp stages
  await H.msg("targetsUpsert", { rows: ["bigbob"], defaults: { tier: 1 } });
  await H.msg("targetsUpsert", { rows: ["alice"], defaults: { tier: 2 } });

  // ---- no warm-up: Full auto works from the first day ----
  await H.msg("start");
  await H.untilChecked(["bigbob", "alice"]); // the real follow check runs before any comment
  let s = (await H.msg("getStatus")).status;
  assert(s.effectiveMode === "auto" && s.warmup === undefined, "day 1: Full auto is active immediately (no warm-up)");
  assert(s.today.limit === 10, "week 1 daily limit is 10");
  const p1 = M.addPost("bigbob", "Most founders underestimate how long distribution takes to compound. Start before launch.", 3);
  await H.runNow();
  const r1 = await H.waitFor(async () => (await H.history()).find((x) => x.postId === p1.id && x.attempts > 0), "item for p1", 90000);
  assert(r1.status === "queued", "day-1 item is queued for auto posting, not sent to review");
  await H.msg("reviewAction", { id: r1.id, action: "skip" });

  // ---- ramp ----
  await H.patchState({ firstStartedAt: Date.now() - 8 * DAY });
  s = (await H.msg("getStatus")).status;
  assert(s.today.limit === 20 && s.rampStage === 1, "week 2 daily limit is 20");
  await H.patchState({ firstStartedAt: Date.now() - 15 * DAY });
  s = (await H.msg("getStatus")).status;
  assert(s.today.limit === 30 && s.rampStage === 2, "week 3+ daily limit is 30");
  await H.settings({ safety: { ramp: [10, 20, 999] } });
  s = (await H.msg("getStatus")).status;
  assert(s.today.limit === 300, "ramp is clamped to the hard cap of 300");
  assert(s.today.likeLimit === 300 && s.today.accountsLimit === 100, "no separate like limit (one like per comment), 100 accounts per day");

  // ---- full auto: generate -> queue -> post with like ----
  const p2 = M.addPost("alice", "We cut our signup form from 9 fields to 3 and conversion jumped. Asking for company size later worked fine.", 2);
  await H.runNow();
  const q = await H.waitFor(async () => (await H.history()).find((x) => x.postId === p2.id && x.status === "queued"), "queued auto item", 90000);
  assert(q.scheduledFor > Date.now() + 20000, "auto item is scheduled with a human delay (" + Math.round((q.scheduledFor - Date.now()) / 1000) + "s)");
  await H.patchHistory(q.id, { scheduledFor: 0 });
  await H.patchState({ nextCommentAt: 0, lastCommentAt: 0 });
  await H.runNow();
  const posted = await H.waitFor(async () => (await H.history()).find((x) => x.id === q.id && x.status === "posted"), "auto posted", 120000);
  assert(M.replies.some((r) => r.inReplyTo === p2.id), "Full auto posted the reply");
  assert(posted.liked && M.likes.includes(p2.id), "like + comment combo liked the post first");
  s = (await H.msg("getStatus")).status;
  assert(s.today.liked === 1 && s.today.posted === 1, "today's counters: 1 posted, 1 liked");

  // ---- active hours: outside -> sleeps, no page visits ----
  const now = new Date();
  const hh = (d) => String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
  const start = new Date(now.getTime() + 2 * 3600e3), end = new Date(now.getTime() + 3 * 3600e3);
  await H.settings({ timezone: "UTC", safety: { activeHours: { enabled: true, start: hh(start), end: hh(end) } } });
  const searchesBefore = M.log.length;
  await H.runNow();
  const sl = await H.waitFor(async () => { const x = await H.store("sx.state"); return x.sleepingUntil ? x : null; }, "sleeping", 30000);
  assert(Math.abs(sl.sleepingUntil - start.getTime()) < 2 * MIN, "outside active hours: sleeping until the window opens");
  assert(M.log.length === searchesBefore, "no X activity while sleeping");
  s = (await H.msg("getStatus")).status;
  assert(/Sleeping until/.test(s.sub), "status shows sleeping: " + s.sub);
  await H.settings({ safety: { activeHours: { enabled: false } } });

  // ---- X warning toast on reply -> stop ----
  const p3 = M.addPost("bigbob", "Hiring take: generalists win early, specialists win later. Most teams flip too soon.", 2);
  await H.patchState({ nextCommentAt: 0, lastCommentAt: 0, sleepingUntil: null });
  await H.runNow();
  const q3 = await H.waitFor(async () => (await H.history()).find((x) => x.postId === p3.id && x.status === "queued"), "queued p3", 90000);
  M.replyMode = "warning";
  await H.patchHistory(q3.id, { scheduledFor: 0 });
  await H.runNow();
  let st = await waitStopped("unusual_activity", 120000);
  assert(/automated/i.test(st.stopDetail) && st.alert, "AUTO-STOP on X 'looks automated' warning");
  assert(!M.replies.some((r) => r.inReplyTo === p3.id), "nothing posted on warning");
  assert((await H.history()).find((x) => x.id === q3.id).status === "failed", "item marked failed, never retried blindly");

  // ---- rate limit toast -> stop ----
  M.replyMode = "rate_limit";
  const p4 = M.addPost("bigbob", "Ran a pricing test: annual-first default lifted cash collected by 30 percent.", 2);
  await H.msg("resume");
  await H.patchState({ nextCommentAt: 0, lastCommentAt: 0 });
  await H.runNow();
  const q4 = await H.waitFor(async () => (await H.history()).find((x) => x.postId === p4.id && x.status === "queued"), "queued p4", 90000);
  await H.patchHistory(q4.id, { scheduledFor: 0 });
  await H.runNow();
  st = await waitStopped("rate_limit", 120000);
  assert(st.stopReason === "rate_limit", "AUTO-STOP on X rate limit message");

  // ---- repeated post failures (composer clears but the reply never appears), with "Stop when errors repeat" on ----
  await H.settings({ safety: { stopOnErrors: true } });
  M.replyMode = "drop";
  M.addUser("dave", { followers: 30000 }); M.addUser("erin", { followers: 20000 });
  await H.msg("targetsUpsert", { rows: ["dave", "erin"], defaults: { tier: 2 } });
  await H.markNotFollowing(["dave", "erin"]);
  const pd = M.addPost("dave", "Thread: the three onboarding emails that actually get opened, and why timing beats copy.", 2);
  const pe = M.addPost("erin", "Unpopular opinion: weekly product updates are more valuable than big launches for B2B.", 2);
  await H.msg("resume");
  await H.patchState({ nextCommentAt: 0, lastCommentAt: 0 });
  await H.runNow();
  await H.waitFor(async () => { const h = await H.history(); return h.filter((x) => (x.postId === pd.id || x.postId === pe.id) && x.status === "queued").length === 2; }, "2 queued", 120000);
  for (const x of (await H.history()).filter((x) => x.status === "queued")) await H.patchHistory(x.id, { scheduledFor: 0 });
  await H.runNow();
  await H.waitFor(async () => (await H.history()).some((x) => x.status === "failed" && /not_visible|not_confirmed/.test(x.reason)), "first failure", 120000);
  await H.patchState({ nextCommentAt: 0, lastCommentAt: 0 });
  await H.runNow();
  st = await waitStopped("repeated_post_failures", 150000);
  assert(st.stopReason === "repeated_post_failures", "AUTO-STOP after 2 posting failures in a row");
  const unsure = (await H.history()).filter((x) => x.status === "failed" && x.maybePosted);
  assert(unsure.length === 2, "unclear posts are kept as 'probably sent' and count toward limits");
  M.replyMode = "ok";

  // ---- X changed its markup -> stop ----
  M.pageMode = "broken";
  M.addPost("bigbob", "A post on a page whose markup changed", 2); M.addPost("alice", "x", 2); M.addPost("dave", "y", 2);
  await H.msg("resume"); await H.runNow();
  st = await waitStopped("dom_changed", 60000);
  assert(st.stopReason === "dom_changed", "AUTO-STOP when posts render but can't be read (selectors outdated)");
  M.pageMode = "ok";

  // ---- closed X tab is reopened ----
  await H.msg("resume");
  const tab = await xTab();
  assert(tab, "ScoreX worker tab exists");
  const pinned = await H.sw.evaluate(async () => (await chrome.tabs.query({ url: "https://x.com/*" })).map((t) => t.pinned));
  assert(pinned.includes(true), "worker tab is pinned");
  await tab.close();
  await sleep(1000);
  await H.runNow();
  await H.waitFor(async () => !!(await xTab()), "tab reopened", 60000);
  assert(true, "closed X tab was reopened automatically");

  // ---- service worker killed -> state survives, ticks continue ----
  const before = (await H.store("sx.state")).tickCount || 0;
  await H.stopWorker();
  await sleep(1500);
  s = (await H.msg("getStatus")).status; // wakes the worker
  assert(s.state.status === "running", "after a worker restart the engine is still running (state in storage)");
  await H.runNow();
  await H.waitFor(async () => ((await H.store("sx.state")).tickCount || 0) > before, "tick after restart", 90000);
  assert(true, "ticks continue after the service worker was killed");

  // ---- review queue expiry ----
  await H.settings({ mode: "review" });
  // (erin's earlier unclear post counts as "probably sent", so her 1-per-24h limit is used: new account)
  M.addUser("hank", { followers: 12000 });
  await H.msg("targetsUpsert", { rows: ["hank"], defaults: { tier: 2 } });
  await H.markNotFollowing(["hank"]);
  const p9 = M.addPost("hank", "Shipping our first public roadmap this week, curious how it changes support volume.", 2);
  await H.patchState({ nextCommentAt: 0 });
  await H.runNow();
  const r9 = await H.waitFor(async () => (await H.history()).find((x) => x.postId === p9.id && x.status === "pending_review"), "pending p9", 90000);
  await H.patchHistory(r9.id, { createdAt: Date.now() - 5 * 3600e3 });
  await H.runNow();
  await H.waitFor(async () => (await H.history()).find((x) => x.id === r9.id && x.status === "skipped" && /Expired/.test(x.reason)), "expired", 60000);
  assert(true, "stale review items expire");

  // ---- replies restricted -> skip, not a failure ----
  await H.settings({ mode: "auto" });
  M.hideReplyBox = true;
  M.addUser("frank", { followers: 50000 });
  await H.msg("targetsUpsert", { rows: ["frank"], defaults: { tier: 2 } });
  await H.markNotFollowing(["frank"]);
  const pf = M.addPost("frank", "Only people I mention can reply to this one, testing restricted replies today.", 2);
  await H.patchState({ nextCommentAt: 0, consecutiveFailures: 0 });
  await H.runNow();
  const qf = await H.waitFor(async () => (await H.history()).find((x) => x.postId === pf.id && x.status === "queued"), "queued pf", 90000);
  await H.patchHistory(qf.id, { scheduledFor: 0 });
  await H.runNow();
  const sf = await H.waitFor(async () => (await H.history()).find((x) => x.id === qf.id && x.status === "skipped"), "restricted skipped", 120000);
  assert(/restricted/.test(sf.reason) && (await H.store("sx.state")).status === "running", "restricted replies are skipped without stopping");

  // ---- a target's reply inside someone else's thread is not commented (only original posts) ----
  M.hideReplyBox = false;
  M.addUser("gina", { followers: 15000 });
  await H.msg("targetsUpsert", { rows: ["gina"], defaults: { tier: 2 } });
  await H.markNotFollowing(["gina"]);
  const parent = M.addPost("frank", "Parent post in a thread that gina answers.", 30);
  const pg = M.addPost("gina", "Agree with this thread, the onboarding point is the one most teams miss entirely.", 2, { parentId: parent.id });
  await H.patchState({ nextCommentAt: 0, consecutiveFailures: 0 });
  await H.runNow();
  const qg = await H.waitFor(async () => (await H.history()).find((x) => x.postId === pg.id && x.status === "queued"), "queued pg", 90000);
  await H.patchHistory(qg.id, { scheduledFor: 0 });
  await H.runNow();
  const sg = await H.waitFor(async () => (await H.history()).find((x) => x.id === qg.id && x.status === "skipped"), "thread reply skipped", 120000);
  assert(/reply_in_thread/.test(sg.reason) && !M.replies.some((r) => r.inReplyTo === pg.id), "replies inside threads are skipped at posting time");

  // ---- catch-up: an account's latest earlier posts (from before ScoreX ran) get comments too ----
  M.addUser("ivy", { followers: 30000 });
  const old1 = M.addPost("ivy", "Thread on why most L2 bridges still lose users at the approval step, and what fixes it.", 180);
  const old2 = M.addPost("ivy", "Our retention went up 9 points after we removed the email step from onboarding entirely.", 600);
  const old3 = M.addPost("ivy", "Pricing experiment: annual plans converted better when the monthly price was shown next to them.", 1500);
  await H.msg("targetsUpsert", { rows: ["ivy"], defaults: { tier: 2 } });
  await H.untilChecked(["ivy"]); // the real follow check reads ivy's profile, including her latest posts
  const tIvy = (await H.store("sx.targets")).ivy;
  assert(tIvy.recentPosts.length === 3, "profile check cached ivy's 3 latest posts (" + tIvy.recentPosts.length + ")");
  const catchRecs = await H.waitFor(async () => {
    await H.patchState({ nextCommentAt: 0, lastCommentAt: 0, consecutiveFailures: 0 });
    for (const x of (await H.history()).filter((x) => x.status === "queued")) await H.patchHistory(x.id, { scheduledFor: 0 });
    await H.runNow();
    await sleep(4000);
    const h = (await H.history()).filter((x) => x.target === "ivy");
    return h.filter((x) => x.catchUp && x.status === "posted").length >= 2 ? h : null;
  }, "2 catch-up comments posted for ivy", 300000, 2000);
  const ivyPosted = catchRecs.filter((x) => x.status === "posted").map((x) => x.postId);
  assert(ivyPosted.includes(old1.id) && ivyPosted.includes(old2.id), "catch-up commented on ivy's 2 latest earlier posts");
  assert(!catchRecs.some((x) => x.postId === old3.id), "only the 2 latest per account (setting), the 25 h old one is left alone");
  assert(M.replies.filter((r) => r.inReplyTo === old1.id || r.inReplyTo === old2.id).length === 2, "both catch-up replies are on X");

  // ---- X footprint, risk meter, adaptive watch in the status; the page-load budget makes the engine wait ----
  s = (await H.msg("getStatus")).status;
  assert(s.footprint && s.footprint.total > 0 && s.footprint.hourly.length === 24 && s.footprint.byPurpose.post >= 1 && s.footprint.byPurpose.watch >= 1, "status.footprint counts X page loads by purpose " + JSON.stringify(s.footprint && s.footprint.byPurpose));
  assert(s.footprint.hourly.reduce((a, b) => a + b, 0) === s.footprint.total, "footprint hourly bars add up to the 24 h total (" + s.footprint.total + ")");
  assert(s.risk && ["low", "medium", "high"].includes(s.risk.level) && s.risk.score >= 0 && s.risk.score <= 100 && s.risk.factors.some((f) => f.id === "auto"), "status.risk is an estimate with factors: " + s.risk.level + " " + s.risk.score);
  assert(s.watch && typeof s.watch.intervalSec === "number" && typeof s.watch.slow === "boolean" && typeof s.watch.emptyStreak === "number", "status.watch: " + JSON.stringify(s.watch));
  assert(s.reach && "alert" in s.reach, "status.reach present");
  await H.waitFor(async () => { const x = await H.store("sx.state"); return !x.job || x.job.leaseUntil < Date.now(); }, "idle engine", 180000, 400);
  const capSet = (await H.msg("getStatus")).status.footprint.total;
  await H.settings({ safety: { maxPageLoads24h: capSet } });
  await H.runNow();
  const wst = await H.waitFor(async () => { const x = await H.store("sx.state"); return x.nextTickWhy === "X page-load budget reached - waiting" ? x : null; }, "page-load budget wait", 90000);
  assert(wst.status === "running" && !wst.alert, "at the page-load budget the engine waits, it never stops");
  const loadsAtCap = (await H.msg("getStatus")).status.footprint.total;
  await H.runNow();
  await sleep(4000);
  s = (await H.msg("getStatus")).status;
  assert(s.footprint.total === loadsAtCap && loadsAtCap <= capSet + 2 && s.footprint.cap === capSet, "no X page is loaded over the budget (" + s.footprint.total + "/" + s.footprint.cap + ")");
  assert(/page-load budget reached/.test(s.sub), "status line says it waits for the budget: " + s.sub);
  await H.settings({ safety: { maxPageLoads24h: 0 } });

  log(`\nPhase 2 e2e: ${passCount()} checks passed`);
} catch (e) {
  failed = true;
  console.error(e);
  console.error("--- SW logs (last 40) ---\n" + H.swLogs.slice(-40).join("\n"));
  try { console.error("--- activity log ---\n" + JSON.stringify((await H.store("sx.logs") || []).slice(-25), null, 1)); } catch (_) {}
  try { console.error("--- state ---\n" + JSON.stringify(await H.store("sx.state"), null, 1)); } catch (_) {}
} finally {
  await H.close();
  process.exit(failed ? 1 : 0);
}
