// Phase 1 end-to-end: targets -> new post detection (X List) -> generation with real usage/cost ->
// review queue -> approve -> human-like posting through the page -> history. Plus core auto-stops.
import { boot, setup, assert, log, sleep, passCount } from "./harness.mjs";

const H = await boot();
const { M } = H;
let failed = false;
try {
  // ---- seed X ----
  M.addUser("bigbob", { name: "Big Bob", verified: true, followers: 250000, bio: "Founder. Writing about distribution and growth." });
  M.addUser("alice", { name: "Alice", followsMe: true, followers: 8200, bio: "PM at a fintech. Onboarding nerd." });
  M.addUser("carol", { name: "Carol", followers: 300 });
  const pBob = M.addPost("bigbob", "Most teams ship features. The best teams ship distribution. Building is no longer the hard part.", 5);
  const pAlice = M.addPost("alice", "Spent the weekend rewriting our onboarding flow and activation went from 31% to 44%. Small copy changes did most of it.", 4);
  M.addPost("bigbob", "Old thought from this morning about pricing pages and trust.", 90);
  const pGive = M.addPost("alice", "Giveaway! RT & follow to win 100 USDC, winners announced Friday", 3);
  M.addPost("carol", "Random post from someone who is not a target at all today", 2);

  await setup(H, { learning: { abTesting: false } }); // tone defaults are checked below
  let r = await H.msg("start");
  assert(r && r.ok === false && /target/i.test(r.error), "start refuses without targets: " + (r && r.error));
  r = await H.msg("targetsUpsert", { rows: ["@bigbob"], defaults: { group: "B", tier: 1 } });
  assert(r.ok && r.added === 1, "added bigbob as B/T1");
  r = await H.msg("targetsImport", { text: "handle,group,tier\nalice,A,2\n0x_nation,B,1\n", defaults: { group: "B", tier: 2 } });
  assert(r.ok && r.added === 1, "imported alice from CSV and skipped own handle (added " + r.added + ")");
  const targets = await H.store("sx.targets");
  assert(targets.alice.group === "A" && targets.alice.tier === 2 && targets.bigbob.tier === 1, "groups/tiers stored");

  r = await H.msg("start");
  assert(r.ok, "engine started");
  let st = await H.store("sx.state");
  assert(st.status === "running" && st.firstStartedAt, "state running with firstStartedAt");
  const status = await H.msg("getStatus");
  assert(status.ok && status.status.effectiveMode === "review" && status.status.warmup.active, "warm-up forces review mode");

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
  assert(!hist.find((x) => /Old thought/.test(x.postText || "")), "old post ignored");
  assert(recBob.modelName === "gpt-6.1-sol" && recBob.effort === "high", "B/T1 used High preset (" + recBob.modelName + " " + recBob.effort + ")");
  assert(recAlice.modelName === "gpt-6-luna" && recAlice.effort === "low", "A/T2 used Cheap preset (" + recAlice.modelName + " " + recAlice.effort + ")");
  assert(recBob.calls.length >= 2 && recBob.calls.some((c) => c.kind === "check"), "generation + quality check calls recorded");
  assert(recBob.tokens.input === 1200 * recBob.calls.length && recBob.tokens.reasoning > 0 && recBob.cost > 0, `real usage summed (in ${recBob.tokens.input}, reasoning ${recBob.tokens.reasoning}, $${recBob.cost})`);
  assert(recBob.tone === "insightful" && recAlice.tone === "friendly", "group default tones applied");
  const gen = M.openai.calls.find((c) => !c.isCheck);
  assert(gen.body.store === false && gen.body.text && gen.body.text.format && gen.body.text.format.type === "json_schema", "Responses API body: store:false + json_schema");
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
  await H.msg("targetsUpsert", { rows: ["dave"], defaults: { group: "B", tier: 2 } });
  await H.runNow();
  const recDave = await H.waitFor(async () => (await H.history()).find((x) => x.postId === pDave.id && x.status === "pending_review"), "dave pending", 90000);
  const before = recDave.comment;
  r = await H.msg("reviewAction", { id: recDave.id, action: "regenerate" });
  assert(r.ok && r.record.comment && r.record.comment !== before && r.record.calls.length > recDave.calls.length, "regenerate replaced the comment and appended calls/cost");
  r = await H.msg("reviewAction", { id: recDave.id, action: "skip" });
  assert(r.ok && r.record.status === "skipped", "skip works");

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
  await H.msg("targetsUpsert", { rows: ["erin"], defaults: { group: "B", tier: 2 } });
  await H.msg("resume"); await H.runNow();
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
