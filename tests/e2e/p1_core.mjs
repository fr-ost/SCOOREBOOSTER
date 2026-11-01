// Phase 1 end-to-end: targets -> follow check (followers list + profiles) -> new post detection (X List) ->
// generation with real usage/cost -> review queue -> approve -> human-like posting through the page ->
// history -> follow-back stops comments. Plus core auto-stops.
import { boot, setup, assert, log, sleep, passCount } from "./harness.mjs";

const H = await boot();
const { M } = H;
let failed = false;
// Run checks until the follow status of these targets is known (new targets are checked before any comment).
async function untilChecked(handles) {
  return H.waitFor(async () => {
    const t = await H.store("sx.targets");
    if (handles.every((h) => t[h] && t[h].rel.followsYou != null)) return t;
    await H.runNow();
    await sleep(2500);
    return null;
  }, "follow check of " + handles.join(", "), 150000, 1000);
}
try {
  // ---- seed X ----
  M.addUser("bigbob", { name: "Big Bob", verified: true, followers: 250000, bio: "Founder. Writing about distribution and growth." });
  M.addUser("alice", { name: "Alice", followers: 8200, bio: "PM at a fintech. Onboarding nerd." });
  M.addUser("carol", { name: "Carol", followers: 300 });
  // Already follow me: frank shows up in my followers list, gina only on her profile ("Follows you").
  M.addUser("frank", { name: "Frank", followsMe: true, followers: 50000 });
  M.addUser("gina", { name: "Gina", followsMe: true, followers: 70000 });
  M.addUser("fan1", { followsMe: true });
  M.followers["0x_nation"] = ["fan1", "frank"];
  const pBob = M.addPost("bigbob", "Most teams ship features. The best teams ship distribution. Building is no longer the hard part.", 5);
  const pAlice = M.addPost("alice", "Spent the weekend rewriting our onboarding flow and activation went from 31% to 44%. Small copy changes did most of it.", 4);
  M.addPost("bigbob", "Old thought from this morning about pricing pages and trust.", 90);
  const pGive = M.addPost("alice", "Giveaway! RT & follow to win 100 USDC, winners announced Friday", 3);
  M.addPost("carol", "Random post from someone who is not a target at all today", 2);
  const pFrank = M.addPost("frank", "Shipping a new rollup explorer today, feedback welcome from anyone who builds on L2s.", 3);
  const pGina = M.addPost("gina", "Thread on why most token unlock schedules are designed backwards and what to do instead.", 3);

  // 1 comment per account and likes off here: this test checks the per-account cap and plain replies.
  // Targets that follow me stay on the list here (removal is checked at the end), so "never commented on" is tested.
  await setup(H, { learning: { abTesting: false }, safety: { perTargetDay: 1, like: { enabled: false } }, follow: { removeFollowers: false } }); // tone defaults are checked below
  let r = await H.msg("start");
  assert(r && r.ok === false && /target/i.test(r.error), "start refuses without targets: " + (r && r.error));
  r = await H.msg("targetsUpsert", { rows: ["@bigbob"], defaults: { group: "B", tier: 1 } });
  assert(r.ok && r.added === 1, "added bigbob as B/T1");
  r = await H.msg("targetsImport", { text: "handle,group,tier\nalice,A,2\n0x_nation,B,1\nfrank,B,1\ngina,B,1\n", defaults: { tier: 2 } });
  assert(r.ok && r.added === 3, "imported alice, frank, gina from CSV and skipped own handle (added " + r.added + ")");
  let targets = await H.store("sx.targets");
  assert(targets.alice.tier === 2 && targets.bigbob.tier === 1, "tiers stored");
  assert(["alice", "bigbob", "frank", "gina"].every((h) => targets[h].rel.followsYou === null), "follow status unknown until checked (a group column is ignored)");

  r = await H.msg("start");
  assert(r.ok, "engine started with targets that are not checked yet");
  let st = await H.store("sx.state");
  assert(st.status === "running" && st.firstStartedAt, "state running with firstStartedAt");
  const status = await H.msg("getStatus");
  assert(status.ok && status.status.effectiveMode === "review", "Review mode is the default");
  assert(status.status.follow && status.status.follow.checking === 4, "status shows 4 targets waiting for the follow check");

  // ---- follow check: followers list scan + profile badges ----
  targets = await untilChecked(["bigbob", "alice", "frank", "gina"]);
  assert(targets.frank.rel.followsYou === true && !targets.frank.rel.followedBackAt && targets.frank.group === "A", "frank found in my followers list -> follows me (never commented on)");
  assert(targets.gina.rel.followsYou === true && targets.gina.group === "A", "gina's profile shows 'Follows you' -> follows me");
  assert(targets.bigbob.rel.followsYou === false && targets.alice.rel.followsYou === false && targets.alice.group === "B", "bigbob and alice don't follow me -> comments allowed");
  st = await H.store("sx.state");
  assert(st.followersScanAt && st.followBadgeOkAt, "followers list was scanned and the 'Follows you' badge verified");
  const fst = (await H.msg("getStatus")).status.follow;
  assert(fst.active === 2 && fst.follows === 2 && fst.checking === 0, "status: 2 not following, 2 follow you (" + JSON.stringify(fst) + ")");
  await H.runNow();

  // ---- detection + generation ----
  const hist = await H.waitFor(async () => {
    const h = await H.history();
    const pend = h.filter((x) => x.status === "pending_review");
    return pend.length >= 2 ? h : null;
  }, "2 pending review items", 90000);
  const recBob = hist.find((x) => x.postId === pBob.id);
  const recAlice = hist.find((x) => x.postId === pAlice.id);
  const recGive = hist.find((x) => x.postId === pGive.id);
  assert(recBob && recBob.status === "pending_review", "bigbob post generated into review queue");
  assert(recAlice && recAlice.status === "pending_review", "alice post generated into review queue");
  assert(recGive && recGive.status === "skipped" && /giveaway/i.test(recGive.reason), "giveaway skipped by filter: " + (recGive && recGive.reason));
  assert(!hist.find((x) => x.target === "carol"), "non-target ignored");
  assert(!hist.find((x) => x.postId === pFrank.id || x.postId === pGina.id), "accounts that follow me are never commented on");
  assert(!hist.find((x) => /Old thought/.test(x.postText || "")), "old post ignored");
  assert(recBob.modelName === "gpt-4o-mini" && recBob.effort === "none", "B/T1 used the Human preset (" + recBob.modelName + " " + recBob.effort + ")");
  assert(recAlice.modelName === "gpt-4o-mini" && recAlice.effort === "none", "tier 2 used the Human preset (" + recAlice.modelName + " " + recAlice.effort + ")");
  assert(recBob.calls.length >= 2 && recBob.calls.some((c) => c.kind === "check"), "generation + quality check calls recorded");
  assert(recBob.tokens.input === 1200 * recBob.calls.length && recBob.tokens.reasoning > 0 && recBob.cost > 0, `real usage summed (in ${recBob.tokens.input}, reasoning ${recBob.tokens.reasoning}, $${recBob.cost})`);
  assert(recBob.tone === "main" && recAlice.tone === "main" && /Reply like a thoughtful human follower scrolling X/.test(recBob.toneText), "the Tone prompt (default: the UniqueFarm voice) is used");
  assert(!JSON.stringify(M.openai.calls.find((c) => !c.isCheck).body.input).includes("owner_style_examples"), "no pasted comment samples in the prompt");
  const gen = M.openai.calls.find((c) => !c.isCheck);
  assert(gen.body.store === false && !(gen.body.text && gen.body.text.format) && gen.body.temperature === 1 && !gen.body.reasoning, "Responses API body: store:false, plain-text reply, temperature 1.0 on the chat model");
  assert(/real human scrolling fast/.test(gen.body.instructions) && /THIS REPLY LENGTH/.test(gen.body.instructions), "UniqueFarm voice: system prompt + per-reply knobs");
  assert(/untrusted/i.test(gen.body.instructions) && /<<<DATA/.test(gen.body.input[0].content[0].text), "prompt treats post as untrusted data");
  const spend = await H.store("sx.spend");
  const month = Object.values(spend.months || {})[0];
  assert(month > 0, "spend ledger recorded ($" + month + ")");

  // ---- review: edit + approve -> posted ----
  const edited = "Distribution compounds, but only after activation works. What did your first 100 users have in common?";
  r = await H.msg("reviewAction", { id: recBob.id, action: "approve", text: edited });
  assert(r.ok && r.record.status === "approved" && r.record.edited, "approved with edit");
  await H.runNow();
  const posted = await H.waitFor(async () => (await H.history()).find((x) => x.id === recBob.id && x.status === "posted"), "bigbob comment posted", 120000);
  assert(M.replies.length === 1 && M.replies[0].text === edited && M.replies[0].inReplyTo === pBob.id, "reply posted through the page with the exact edited text");
  assert(/\/0x_nation\/status\/\d+/.test(posted.replyUrl), "reply URL captured: " + posted.replyUrl);
  assert(M.likes.length === 0, "no like when like-combo is off");
  st = await H.store("sx.state");
  assert(st.nextCommentAt > Date.now() + 60000, "random gap scheduled before the next comment");
  const t2 = await H.store("sx.targets");
  assert(t2.bigbob.stats.comments === 1 && t2.bigbob.stats.lastCommentAt, "target stats updated");
  assert(t2.bigbob.stats.firstCommentAt === t2.bigbob.stats.lastCommentAt, "first comment starts the follow-back window");
  assert(t2.bigbob.recentPosts && t2.bigbob.recentPosts.length >= 1, "target recent posts cached for prompts");

  // ---- gap respected, then posts ----
  r = await H.msg("reviewAction", { id: recAlice.id, action: "approve" });
  await H.runNow();
  await sleep(8000);
  assert((await H.history()).find((x) => x.id === recAlice.id).status === "approved", "second approved item waits for the gap");
  await H.patchState({ nextCommentAt: 0, lastCommentAt: Date.now() - 15 * 60000 });
  await H.runNow();
  await H.waitFor(async () => (await H.history()).find((x) => x.id === recAlice.id && x.status === "posted"), "alice comment posted", 120000);
  assert(M.replies.length === 2, "second reply posted after the gap");

  // ---- per-target daily cap: a new bigbob post is not generated today ----
  const pBob2 = M.addPost("bigbob", "Second post today about hiring generalists versus specialists in early startups.", 2);
  await H.patchState({ nextCommentAt: 0 });
  await H.runNow();
  await sleep(15000);
  const h3 = await H.history();
  assert(!h3.find((x) => x.postId === pBob2.id && x.attempts > 0), "no generation for a target already commented on today");

  // ---- regenerate + skip on a new target ----
  M.addUser("dave", { name: "Dave", followers: 40000 });
  const pDave = M.addPost("dave", "Hot take: most dashboards are vanity. The metric that matters is weekly active teams.", 3);
  await H.msg("targetsUpsert", { rows: ["dave"], defaults: { tier: 2 } });
  await untilChecked(["dave"]);
  await H.runNow();
  const recDave = await H.waitFor(async () => (await H.history()).find((x) => x.postId === pDave.id && x.status === "pending_review"), "dave pending", 90000);
  const before = recDave.comment;
  r = await H.msg("reviewAction", { id: recDave.id, action: "regenerate" });
  assert(r.ok && r.record.comment && r.record.comment !== before && r.record.calls.length > recDave.calls.length, "regenerate replaced the comment and appended calls/cost");
  r = await H.msg("reviewAction", { id: recDave.id, action: "skip" });
  assert(r.ok && r.record.status === "skipped", "skip works");

  // ---- follow-back: dave follows me -> his waiting comment is dropped and he gets no more comments ----
  const pDave2 = M.addPost("dave", "Second take: retention curves tell you more than any dashboard ever will.", 2);
  await H.runNow();
  const recDave2 = await H.waitFor(async () => (await H.history()).find((x) => x.postId === pDave2.id && x.status === "pending_review"), "dave second comment pending", 90000);
  M.users.dave.followsMe = true;
  M.followers["0x_nation"] = ["dave", ...M.followers["0x_nation"]]; // newest follower first
  await H.patchState({ followersScanAt: 1 }); // routine followers scan is due
  await H.runNow();
  const tDave = await H.waitFor(async () => { const t = (await H.store("sx.targets")).dave; return t.rel.followsYou === true ? t : null; }, "dave follow-back detected", 90000);
  assert(tDave.rel.followedBackAt && tDave.group === "A", "follow-back detected from the newest followers");
  await H.runNow();
  const dropped = await H.waitFor(async () => { const x = (await H.history()).find((r) => r.id === recDave2.id); return x.status === "skipped" ? x : null; }, "dave's waiting comment dropped", 60000);
  assert(/follows you/i.test(dropped.reason), "waiting comment dropped: " + dropped.reason);
  const pDave3 = M.addPost("dave", "Third post today about onboarding emails that actually get read.", 2);
  await H.runNow();
  await sleep(8000);
  assert(!(await H.history()).find((x) => x.postId === pDave3.id), "no comments after the follow-back");
  assert(/followed you back/.test(JSON.stringify(await H.store("sx.logs"))), "follow-back logged");

  // ---- unknown X prompt after Reply: stop, never click it, nothing further posted ----
  M.addUser("hank", { name: "Hank", followers: 30000 });
  M.addUser("ivy", { name: "Ivy", followers: 21000 });
  const pHank = M.addPost("hank", "Why onboarding emails beat in-app product tours for B2B activation, with real numbers.", 2);
  const pIvy = M.addPost("ivy", "Our churn dropped after we moved the pricing page next to the signup form. Small change.", 2);
  await H.msg("targetsUpsert", { rows: ["hank", "ivy"], defaults: { tier: 2 } });
  await untilChecked(["hank", "ivy"]);
  await H.runNow();
  const two = await H.waitFor(async () => {
    const h = await H.history();
    const a = h.find((x) => x.postId === pHank.id && x.status === "pending_review"), b = h.find((x) => x.postId === pIvy.id && x.status === "pending_review");
    return a && b ? [a, b] : null;
  }, "hank + ivy pending", 120000);
  for (const x of two) assert((await H.msg("reviewAction", { id: x.id, action: "approve" })).ok, "approved @" + x.target);
  M.replyMode = "prompt";
  const repliesBefore = M.replies.length;
  const attemptsBefore = M.log.filter((x) => x.kind === "reply").length;
  await H.patchState({ nextCommentAt: 0, lastCommentAt: Date.now() - 15 * 60000 });
  await H.runNow();
  st = await H.waitFor(async () => { const s = await H.store("sx.state"); return s.status === "stopped" ? s : null; }, "stop on an unknown prompt", 150000);
  assert(st.stopReason === "unknown_prompt" && st.alert && st.alert.reason === "unknown_prompt", "AUTO-STOP on an unknown X prompt after Reply (" + st.stopReason + ")");
  assert(st.stopDetail.includes("Before you reply") && st.stopDetail.length <= 300, "the stop shows the prompt's text: " + st.stopDetail);
  assert(!M.log.some((x) => x.kind === "promptClick"), "ScoreX never clicked the prompt");
  assert(M.replies.length === repliesBefore, "nothing was posted");
  let h4 = await H.history();
  const tried = h4.filter((x) => two.some((y) => y.id === x.id) && x.status === "failed");
  assert(tried.length === 1 && !tried[0].maybePosted, "the attempted item failed and does not count as maybe posted (the text was still in the box)");
  assert((await H.msg("runNow")).ok === false, "the engine stays stopped until you resume");
  await sleep(6000);
  h4 = await H.history();
  const left = h4.find((x) => two.some((y) => y.id === x.id) && x.id !== tried[0].id);
  assert(left.status === "approved" && M.replies.length === repliesBefore && M.log.filter((x) => x.kind === "reply").length === attemptsBefore + 1, "nothing further was posted or submitted after the stop");
  await H.msg("reviewAction", { id: left.id, action: "skip" });
  M.replyMode = "ok";
  assert((await H.msg("resume")).ok, "resume after reviewing the prompt");

  // ---- auto-stop: captcha ----
  M.pageMode = "captcha";
  M.addPost("dave", "Another fresh post that should never be acted on while a captcha is up.", 2);
  await H.runNow();
  st = await H.waitFor(async () => { const s = await H.store("sx.state"); return s.status === "stopped" ? s : null; }, "stop on captcha", 60000);
  assert(st.stopReason === "captcha" && st.alert && st.alert.reason === "captcha", "AUTO-STOP on captcha with alert");
  assert((await H.badge()) === "!", "red badge shown");
  const stoppedStatus = (await H.msg("getStatus")).status;
  assert(/Stopped \(Captcha/.test(stoppedStatus.label), "status label: " + stoppedStatus.label);

  // ---- resume, then logged out -> stop ----
  M.pageMode = "logged_out";
  r = await H.msg("resume");
  assert(r.ok, "resume after safety stop");
  await H.runNow();
  st = await H.waitFor(async () => { const s = await H.store("sx.state"); return s.status === "stopped" && s.stopReason === "logged_out" ? s : null; }, "stop on logout", 60000);
  assert(st.stopReason === "logged_out", "AUTO-STOP when logged out");

  // ---- wrong account ----
  M.pageMode = "wrong_account";
  await H.msg("resume"); await H.runNow();
  st = await H.waitFor(async () => { const s = await H.store("sx.state"); return s.status === "stopped" && s.stopReason === "wrong_account" ? s : null; }, "stop on wrong account", 60000);
  assert(/someone_else/.test(st.stopDetail), "AUTO-STOP on a different logged-in account");

  // ---- OpenAI key rejected ----
  M.pageMode = "ok";
  M.openai.mode = "401";
  M.addUser("erin", { followers: 9000 });
  M.addPost("erin", "Shipping a new pricing page tomorrow with usage based tiers for small teams.", 2);
  await H.msg("targetsUpsert", { rows: ["erin"], defaults: { tier: 2 } });
  await H.msg("resume");
  await untilChecked(["erin"]);
  await H.runNow();
  st = await H.waitFor(async () => { const s = await H.store("sx.state"); return s.status === "stopped" && s.stopReason === "openai_auth" ? s : null; }, "stop on 401", 60000);
  assert(st.stopReason === "openai_auth", "AUTO-STOP when the OpenAI key is rejected");
  const logs = JSON.stringify(await H.store("sx.logs"));
  assert(!/sk-test-1234567890abcdefXYZ/.test(logs) && !/sk-test-1234567890abcdefXYZ/.test(H.swLogs.join("\n")), "API key never appears in logs");

  // ---- budget ----
  M.openai.mode = "ok";
  await H.settings({ budget: { monthlyUsd: 0.0001 } });
  await H.msg("resume"); await H.runNow();
  st = await H.waitFor(async () => { const s = await H.store("sx.state"); return s.status === "stopped" && s.stopReason === "budget_reached" ? s : null; }, "stop on budget", 60000);
  assert(st.stopReason === "budget_reached", "AUTO-STOP when the monthly budget is reached");
  await H.settings({ budget: { monthlyUsd: 0 } });

  // ---- remove targets that already follow me (the default) ----
  await H.settings({ follow: { removeFollowers: true } });
  await H.msg("resume");
  const gone = await H.waitFor(async () => {
    const t = await H.store("sx.targets");
    if (!t.frank && !t.gina) return t;
    await H.runNow();
    await sleep(2000);
    return null;
  }, "followers removed from the targets", 90000, 1000);
  assert(!gone.frank && !gone.gina && gone.alice, "targets that already follow me (never commented on) are removed; the others stay");
  assert(/already follow you/.test(JSON.stringify(await H.store("sx.logs"))), "the removal is logged");

  log(`\nPhase 1 e2e: ${passCount()} checks passed`);
} catch (e) {
  failed = true;
  console.error(e);
  console.error("--- SW logs (last 40) ---\n" + H.swLogs.slice(-40).join("\n"));
  try { console.error("--- activity log ---\n" + JSON.stringify((await H.store("sx.logs") || []).slice(-25), null, 1)); } catch (_) {}
} finally {
  await H.close();
  process.exit(failed ? 1 : 0);
}
