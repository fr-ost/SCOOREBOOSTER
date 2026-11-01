// Scores end-to-end: Sorsa (API with your key) and TwitterScore (free public page, browser-tab mode, API with
// a key) against mock sites: your own scores + history, score checks, smart followers of big accounts
// (Sorsa top 20, TwitterScore's free first 3), the smart-follower search -> candidates, caps and errors.
// The optional permissions are granted by the harness (a test cannot click Chrome's prompt).
import { boot, setup, assert, log, passCount } from "./harness.mjs";

const H = await boot({ grantOptional: true });
const { M } = H;
let failed = false;
try {
  await setup(H, {});
  M.sorsa.scores["0x_nation"] = 512;
  M.sorsa.top.bigvc = [
    { username: "Alpha", display_name: "Alpha", score: 1800, followers_count: 90000 },
    { username: "beta", display_name: "Beta", score: 900, followers_count: 30000 },
    { username: "bigvc", display_name: "Self", score: 1 },
  ];
  M.twitterscore.scores["0x_nation"] = 233;
  M.twitterscore.scores.bigvc = 900;
  M.twitterscore.smart.bigvc = [{ handle: "gamma", score: 700 }, { handle: "alpha", score: 850 }, { handle: "delta", score: 400 }, { handle: "omega", score: 100 }];

  let st = await H.msg("scoresState");
  assert(st.ok && st.providers.length >= 2 && st.providers.every((p) => !p.enabled), "every score provider is off by default");

  await H.settings({ providers: { twitterscore: { enabled: true }, sorsa: { enabled: true } } });
  await H.secrets({ sorsaKey: "sorsa-test" });
  st = await H.msg("scoresState");
  const ts = st.providers.find((p) => p.id === "twitterscore");
  const so = st.providers.find((p) => p.id === "sorsa");
  assert(ts.mode === "public" && ts.granted, "TwitterScore without a key reads the free public page");
  assert(so.mode === "api" && so.hasKey && so.granted, "Sorsa uses its API with your key");
  assert(ts.usage && ts.usage.cap === 100, "TwitterScore is asked at most 100 times a day by default (be polite to the site)");

  // ---- your own scores ----
  let r = await H.msg("scoresRefreshOwn", { force: true });
  assert(r.ok && r.results.twitterscore.ok && r.results.twitterscore.score === 233, "TwitterScore: your score from the public page (233/1000)");
  assert(r.results.sorsa.ok && r.results.sorsa.score === 512, "Sorsa: your score from the API (512)");
  const board = await H.store("sx.scoreboard");
  assert(board.own.twitterscore.history.length === 1 && board.own.twitterscore.max === 1000 && board.own.sorsa.score === 512, "scores stored with a daily history point");
  r = await H.msg("scoresRefreshOwn", {});
  assert(r.results.sorsa.cached, "a refresh within 20 hours uses the stored score (no extra request)");

  // ---- score checks of other accounts: off by default, nothing is sent ----
  const before = M.twitterscore.calls.length + M.sorsa.calls.length;
  r = await H.msg("scoreCheck", { handle: "@BigVC" });
  assert(r && r.ok === false && /other accounts are off/.test(r.error || ""), "checking another account's score is off by default: " + (r && r.error));
  r = await H.msg("targetScores", { handles: ["bigvc"], provider: "sorsa" });
  const offJob = await H.waitFor(async () => { const b = await H.store("sx.scoreboard"); return b.job && b.job.status !== "running" ? b.job : null; }, "target-score job ends", 20000);
  assert(/other accounts are off/.test(offJob.error || ""), "target scores are off too: " + offJob.error);
  assert(M.twitterscore.calls.length + M.sorsa.calls.length === before, "no request was sent");
  await H.settings({ scores: { checkOthers: true } });

  // ---- score check of another account (switched on) ----
  r = await H.msg("scoreCheck", { handle: "@BigVC" });
  assert(r.ok && r.handle === "bigvc" && r.results.twitterscore.score === 900, "score check of @bigvc");
  r = await H.msg("scoreCheck", { handle: "nobody_here" });
  assert(/no data|not found/i.test(r.results.twitterscore.error || ""), "an account the site does not know gives a clear message: " + r.results.twitterscore.error);

  // ---- smart followers ----
  r = await H.msg("smartFollowers", { handle: "bigvc" });
  assert(r.ok, "smart followers of @bigvc");
  const tsList = r.results.twitterscore.list.map((x) => x.handle);
  assert(JSON.stringify(tsList) === JSON.stringify(["gamma", "alpha", "delta"]), "TwitterScore free page: the first 3 smart followers, navigation links ignored (" + tsList + ")");
  assert(r.results.twitterscore.list[1].score === 850, "TwitterScore row scores are read");
  const soList = r.results.sorsa.list.map((x) => x.handle);
  assert(soList.includes("alpha") && soList.includes("beta") && !soList.includes("bigvc"), "Sorsa top followers, the account itself excluded");
  const merged = r.merged.find((x) => x.handle === "alpha");
  assert(merged && merged.providers.length === 2 && merged.scores.sorsa === 1800 && merged.scores.twitterscore === 850, "merged list shows both providers' scores for the same account");

  M.twitterscore.mode = "js";
  M.twitterscore.scores.jsguy = 300;
  M.twitterscore.smart.jsguy = [{ handle: "late1", score: 500 }];
  r = await H.msg("smartFollowers", { handle: "jsguy", fresh: true });
  assert(r.results.twitterscore.list.length === 1 && r.results.twitterscore.list[0].handle === "late1", "a panel filled by JavaScript is read once it renders (no unrelated links)");

  // ---- bot check, tab mode, API mode ----
  M.twitterscore.mode = "blocked";
  r = await H.msg("scoreCheck", { handle: "bigvc" });
  assert(/bot check/i.test(r.results.twitterscore.error || ""), "a bot check gives a clear error: " + r.results.twitterscore.error);
  M.twitterscore.mode = "ok";
  await H.settings({ providers: { twitterscore: { mode: "page" } } });
  r = await H.msg("scoreCheck", { handle: "bigvc" });
  assert(r.results.twitterscore.score === 900, "browser-tab mode reads the rendered page");
  await H.secrets({ twitterscoreKey: "ts-test" });
  await H.settings({ providers: { twitterscore: { mode: "api" } } });
  r = await H.msg("scoreCheck", { handle: "bigvc" });
  assert(r.results.twitterscore.score === 900 && M.twitterscore.calls.some((c) => c.startsWith("/api/v1/get_twitter_score")), "TwitterScore API mode with your key");
  r = await H.msg("smartFollowers", { handle: "bigvc", fresh: true });
  assert(r.results.twitterscore.list.length === 4, "TwitterScore API lists every smart follower (not just the free 3)");

  // ---- your own TwitterScore score never spends the API; a bot check falls back to the browser tab ----
  await H.settings({ providers: { twitterscore: { mode: "auto" } } });
  const apiCalls = () => M.twitterscore.calls.filter((c) => c.startsWith("/api/")).length;
  let api0 = apiCalls();
  r = await H.msg("scoresRefreshOwn", { force: true, only: ["twitterscore"] });
  assert(r.results.twitterscore.ok && r.results.twitterscore.score === 233 && r.results.twitterscore.mode === "public", "own TwitterScore score from the free page, with a key saved: " + JSON.stringify(r.results.twitterscore));
  assert(apiCalls() === api0, "no API request for your own score");
  M.twitterscore.mode = "botcheck";
  r = await H.msg("scoresRefreshOwn", { force: true, only: ["twitterscore"] });
  assert(r.results.twitterscore.ok && r.results.twitterscore.score === 233 && r.results.twitterscore.mode === "page", "bot check on the direct read -> read in a browser tab: " + JSON.stringify(r.results.twitterscore));
  assert(apiCalls() === api0, "still no API request");
  r = await H.msg("smartFollowers", { handle: "bigvc", fresh: true });
  assert(r.results.twitterscore.list.length === 4 && apiCalls() === api0 + 1, "smart followers use the API (mode Auto, key saved)");
  M.twitterscore.mode = "ok";

  // ---- the smart follower database: every page (25 per request), duplicates merged, the daily cap does not stop it ----
  M.twitterscore.smart.whale = Array.from({ length: 60 }, (_, i) => ({ handle: "w_" + i, score: 900 - i }));
  M.twitterscore.smart.shark = [...Array.from({ length: 10 }, (_, i) => ({ handle: "w_" + i, score: 905 - i })), ...Array.from({ length: 5 }, (_, i) => ({ handle: "s_" + i, score: 300 }))];
  await H.settings({ providers: { twitterscore: { dailyCap: 2 } } });
  const dbCalls0 = apiCalls();
  r = await H.msg("smartDbBuild", { handles: ["https://x.com/Whale", "twitterscore.io/twitter/shark", "@nobody_here"] });
  assert(r.ok && r.started, "database scan runs as a background job");
  let dbJob = await H.waitFor(async () => { const b = await H.store("sx.scoreboard"); return b.job && b.job.kind === "smartdb" && b.job.status !== "running" ? b.job : null; }, "database scan finishes", 60000);
  assert(dbJob.status === "done" && dbJob.result.found === 75 && dbJob.result.added === 65, "scan: 60 + 15 smart followers read, 65 different accounts: " + JSON.stringify(dbJob.result));
  assert(apiCalls() - dbCalls0 === 5 && dbJob.result.requests === 5, "25 per request: whale 3 pages (25 + 25 + 10), shark 1, nobody 1 - with a daily cap of 2 (" + (apiCalls() - dbCalls0) + ")");
  assert(M.twitterscore.calls.slice(-5).every((c) => /size=25/.test(c)), "every page asks for 25 (the API's cap)");
  assert(JSON.stringify(dbJob.result.empty) === JSON.stringify(["nobody_here"]), "an account with no smart followers is named: " + JSON.stringify(dbJob.result.empty));
  let db = await H.msg("smartDbList", {});
  const w0 = db.rows.find((x) => x.handle === "w_0");
  assert(db.count === 65 && w0 && w0.score === 905 && JSON.stringify(w0.sources) === JSON.stringify(["whale", "shark"]) && w0.scannedAt > 0, "merged: one row per username with the newest score, the date of scan and both accounts it was found under");
  assert(db.rows[0].handle === "w_0", "best score first");
  // the deprecated endpoint gone: get_followers takes over
  M.twitterscore.oldGone = true;
  M.twitterscore.smart.orca = Array.from({ length: 30 }, (_, i) => ({ handle: "o_" + i, score: 500 }));
  await H.msg("smartDbBuild", { handles: ["orca"] });
  dbJob = await H.waitFor(async () => { const b = await H.store("sx.scoreboard"); return b.job && b.job.kind === "smartdb" && b.job.status !== "running" && b.job.result && b.job.result.found === 30 ? b.job : null; }, "scan via get_followers", 60000);
  assert(M.twitterscore.calls.slice(-2).every((c) => c.startsWith("/api/v1/get_followers")), "top_followers_paginate answers 404: get_followers is used");
  M.twitterscore.oldGone = false;
  db = await H.msg("smartDbList", {});
  assert(db.count === 95, "the second scan adds to the database (95)");
  r = await H.msg("smartDbRemove", { handles: ["o_0", "o_1"] });
  assert(r.ok && r.removed === 2 && (await H.msg("smartDbList", {})).count === 93, "remove selected rows");
  await H.settings({ providers: { twitterscore: { dailyCap: 100 } } });

  // ---- Ethos (free, no key) and Moni (your free key) ----
  M.ethos.scores["0x_nation"] = 1460;
  M.moni.scores["0x_nation"] = 37;
  M.moni.scores.bigvc = 880;
  M.moni.smarts.bigvc = ["alpha", "Epsilon", "bigvc"];
  await H.settings({ providers: { ethos: { enabled: true }, moni: { enabled: true } } });
  await H.secrets({ moniKey: "moni-test" });
  r = await H.msg("scoresRefreshOwn", { force: true, only: ["ethos", "moni"] });
  assert(r.results.ethos.ok && r.results.ethos.score === 1460 && r.results.moni.ok && r.results.moni.score === 37, "Ethos (1460) and Moni (37) scores");
  assert(M.ethos.calls.some((c) => /scorex@/.test(c)), "Ethos requests identify the app (X-Ethos-Client)");
  r = await H.msg("scoreCheck", { handle: "beta" });
  assert(/no Ethos profile/.test(r.results.ethos.error || ""), "an account without an Ethos profile is not shown with Ethos' default score: " + r.results.ethos.error);
  const moniCalls = M.moni.calls.length;
  r = await H.msg("smartFollowers", { handle: "bigvc", fresh: true });
  assert(!r.results.moni && !r.results.ethos && M.moni.calls.length === moniCalls, "Moni and Ethos are kept for your own score: never asked for smart followers");

  // ---- smart-follower search -> candidates ----
  await H.settings({ providers: { twitterscore: { mode: "public" } } });
  await H.msg("targetsUpsert", { rows: ["delta"] });
  await H.msg("blacklistAdd", { handles: ["gamma"] });
  r = await H.msg("smartSweep", { handles: ["bigvc", "jsguy"] });
  assert(r.ok && r.started, "smart-follower search runs as a background job");
  const job = await H.waitFor(async () => { const b = await H.store("sx.scoreboard"); return b.job && b.job.status !== "running" ? b.job : null; }, "search finished", 180000);
  assert(job.status === "done" && job.result && job.result.found >= 3, "search finished: " + JSON.stringify(job.result));
  const cands = await H.store("sx.candidates");
  assert(cands.alpha && cands.alpha.smart && cands.alpha.providerScores.sorsa === 1800, "smart followers became candidates with their provider scores");
  assert(!cands.gamma && !cands.delta && !cands.bigvc, "blacklisted accounts, existing targets and the searched account are skipped");
  r = await H.msg("smartSweep", { handles: ["bigvc"] });
  await H.waitFor(async () => { const b = await H.store("sx.scoreboard"); return b.job && b.job.status !== "running" ? b.job : null; }, "second search finished", 60000);
  assert((await H.store("sx.candidates")).alpha.sources.length === 1, "repeated searches do not duplicate sources");
  // Candidates stay at the newest / best 2,000: 2,100 old ones + a new search.
  const seeded = { ...(await H.store("sx.candidates")) };
  for (let i = 0; i < 2100; i++) seeded["old_cand_" + i] = { handle: "old_cand_" + i, foundAt: 1000 + i, sources: ["seed"], overlap: 1 };
  await H.setStore({ "sx.candidates": seeded });
  const sweep3At = Date.now();
  r = await H.msg("smartSweep", { handles: ["bigvc"] });
  await H.waitFor(async () => { const b = await H.store("sx.scoreboard"); return b.job && b.job.status !== "running" && b.job.startedAt >= sweep3At ? b.job : null; }, "third search finished", 60000);
  const capped = await H.store("sx.candidates");
  assert(Object.keys(capped).length === 2000 && capped.alpha && capped.alpha.seenAt && !capped.old_cand_0, "candidates are capped at the newest 2,000 (a repeat find counts as new): " + Object.keys(capped).length);

  // ---- target scores + caps ----
  M.sorsa.scores.delta = 444;
  r = await H.msg("targetScores", { handles: ["delta"], provider: "sorsa" });
  await H.waitFor(async () => { const b = await H.store("sx.scoreboard"); return b.job && b.job.kind === "targets" && b.job.status !== "running" ? b.job : null; }, "target scores", 60000);
  const tDelta = (await H.store("sx.targets")).delta;
  assert(tDelta.score.providers.sorsa.score === 444 && tDelta.score.sorsa === 444, "target scores stored per provider (Sorsa also in the Sorsa column)");
  assert(tDelta.score.combined != null && tDelta.score.combined > 0, "the combined rank is recomputed from the new Sorsa score: " + tDelta.score.combined);
  const sorsaCalls = M.sorsa.calls.length;
  const targets2At = Date.now();
  r = await H.msg("targetScores", { handles: ["delta"], provider: "sorsa" });
  await H.waitFor(async () => { const b = await H.store("sx.scoreboard"); return b.job && b.job.kind === "targets" && b.job.status !== "running" && b.job.startedAt >= targets2At ? b.job : null; }, "cached target scores", 60000);
  assert(M.sorsa.calls.length === sorsaCalls, "a target score fetched this week is not fetched again");
  await H.settings({ providers: { sorsa: { dailyCap: 1 } } });
  r = await H.msg("scoreCheck", { handle: "beta" });
  assert(/cap/i.test(r.results.sorsa.error || ""), "a provider's daily request cap is respected: " + r.results.sorsa.error);
  const usage = (await H.store("sx.scoreboard")).usage;
  assert(usage.sorsa.n >= 1 && usage.twitterscore.n >= 1, "requests are counted per provider and day");

  // ---- diagnostics self-test against the mock X ----
  M.addUser("0x_nation", { followers: 4200 });
  M.addUser("fan1", { followsMe: true });
  M.followers["0x_nation"] = ["fan1"];
  M.addPost("fan1", "A post so the home timeline is not empty for the self-test today.", 3);
  r = await H.msg("selfTest");
  assert(r.ok && r.checks.length === 4 && r.checks.every((c) => c.ok), "self-test: account, home, profile and followers are readable (" + JSON.stringify(r.checks.map((c) => [c.id, c.ok, c.detail])) + ")");
  M.pageMode = "broken";
  r = await H.msg("selfTest");
  const home = r.checks.find((c) => c.id === "home");
  assert(home && !home.ok && /post text/.test(home.detail), "self-test names what X no longer shows: " + (home && home.detail));
  M.pageMode = "captcha";
  r = await H.msg("selfTest");
  const stAfter = await H.store("sx.state");
  assert(r.ok && r.stop === "captcha" && stAfter.status === "stopped" && stAfter.stopReason === "captcha" && stAfter.alert, "a captcha seen by the self-test is a safety stop like anywhere else: " + JSON.stringify({ stop: r.stop, status: stAfter.status, reason: stAfter.stopReason }));
  await H.msg("clearAlert");
  M.pageMode = "ok";

  // ---- privacy: only handles go out, keys never in logs ----
  const logs = JSON.stringify(await H.store("sx.logs"));
  assert(!/sorsa-test|ts-test/.test(logs), "provider keys never appear in the activity log");

  log(`\nScores e2e: ${passCount()} checks passed`);
} catch (e) {
  failed = true;
  console.error(e);
  console.error("--- SW logs (last 30) ---\n" + H.swLogs.slice(-30).join("\n"));
  try { console.error("--- scoreboard ---\n" + JSON.stringify(await H.store("sx.scoreboard"), null, 1).slice(0, 4000)); } catch (_) {}
} finally {
  await H.close();
  process.exit(failed ? 1 : 0);
}
