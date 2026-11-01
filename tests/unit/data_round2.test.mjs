// Round-2 DATA regression tests: Clear history keeps the "post already handled" marks and today's generations,
// "no data" answers from score sites are not failures, Reset everything stops a running score job, a restore keeps
// hand-set priorities, and your own score waits a day after a site refused.
import { resetStorage, rawGet } from "./_chrome.mjs";
import { install, mockOpenAI } from "./_engine_env.mjs";
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as S from "../../extension/lib/store.js";
import * as SB from "../../extension/lib/scoreboard.js";
import * as H from "../../extension/lib/history.js";
import * as engine from "../../extension/lib/engine.js";
import { clearHistory, resetAll, exportData, importData } from "../../extension/lib/backup.js";
import { runCapability, providerDefs } from "../../extension/lib/providers.js";
import { updatePriorities } from "../../extension/lib/learning.js";
import { newTarget, applyFollow } from "../../extension/lib/targets.js";
import { useMemoryDb } from "../../extension/lib/db.js";
import { K, HS, STATUS } from "../../extension/lib/constants.js";
import { _setClock, _setRandom, HOUR, DAY } from "../../extension/lib/util.js";

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) });
const html = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => body });
const FAST = { gapMs: 0 };

describe("DATA2-1: Clear history keeps what the engine's dedupe and generation limit need", () => {
  const ME = "0x_nation";
  const POST_ID = "1983000000000000777";
  const settingsRaw = {
    mode: "review",
    account: { handle: ME, verifyAccount: true },
    watch: { strategy: "list", listUrls: ["https://x.com/i/lists/1234567890"], scrolls: 0 }, // catch-up on (default)
    safety: { activeHours: { enabled: false }, breaks: { enabled: false } },
    learning: { enabled: false, conversations: { enabled: false } },
    review: { notifyNew: false },
  };
  let env;
  before(() => { env = install(); });
  after(() => env.uninstall());
  beforeEach(async () => {
    env.tabs.clear(); env.navigations.length = 0; env.commands.length = 0;
    env.content = async (msg) => (msg.sx === "waitFor" ? { ok: true, key: "tweet" } : msg.sx === "scrapeTweets" ? { ok: true, tweets: [], articleCount: 0 } : { ok: true });
    env.page = { state: "ok", detail: "", me: ME, hidden: false };
    resetStorage();
    useMemoryDb();
    const alice = applyFollow(newTarget("alice"), false, Date.now() - DAY);
    alice.recentPosts = [{ id: POST_ID, text: "Shipping a new zk prover benchmark today: 3x faster proofs on consumer GPUs with the same memory budget.", createdAt: Date.now() - 3 * HOUR, lang: "en" }];
    await S.save({ [K.settings]: settingsRaw, [K.targets]: { alice } });
    await S.setSecrets({ openaiKey: "sk-test-1234567890abcdef" });
    env.addTab({ id: 3, url: "https://x.com/home", pinned: true, index: 0 });
    await S.patchState({ status: STATUS.RUNNING, firstStartedAt: Date.now() - 20 * DAY, startedAt: Date.now() - HOUR, workerTabId: 3, workerTabPinned: true, workerTabIndex: 0, workerTabFreshAt: Date.now(), followBadgeOkAt: Date.now(), followersScanAt: Date.now() });
  });
  afterEach(async () => { _setClock(null); _setRandom(null); await engine.pause().catch(() => {}); });

  test("a post you skipped in Review 30 minutes ago gets no new reply from catch-up after Clear history, and today's generations still count", async () => {
    const skipped = H.newRecord({ status: HS.SKIPPED, reason: "Skipped by you", target: "alice", postId: POST_ID, postUrl: `https://x.com/alice/status/${POST_ID}`, comment: "first draft", attempts: 1, createdAt: Date.now() - 30 * 60000 });
    await H.put(skipped);
    const old = H.newRecord({ status: HS.FAILED, reason: "old", target: "alice", postId: "1900000000000000001", attempts: 1, createdAt: Date.now() - 9 * DAY });
    await H.put(old);
    const calls = mockOpenAI();
    const before = await engine.computeCounts(await S.getSettings());
    const r = await clearHistory();
    assert.equal(r.ok, true);
    assert.deepEqual({ removed: r.removed, shortened: r.shortened }, { removed: 1, shortened: 1 });
    assert.equal(await H.get(old.id), undefined, "records older than 8 days still go");
    const short = await H.get(skipped.id);
    assert.equal(short.postId, POST_ID, "the post id (dedupe) stays");
    assert.equal(short.attempts, 1, "the attempt (generation limit) stays");
    assert.equal(short.comment, undefined, "the text and costs go, like the retention's shortened records");
    const afterClear = await engine.computeCounts(await S.getSettings());
    assert.equal(afterClear.generatedToday, before.generatedToday, "the daily generation limit does not restart");
    await engine.tick("alarm");
    const recs = await H.byPostId(POST_ID);
    assert.deepEqual(recs.map((x) => x.reason), ["Skipped by you"], "no second reply to a post you rejected");
    assert.equal(calls.length, 0, "no OpenAI call");
  });
});

describe("data round 2: providers, scoreboard, import", () => {
  beforeEach(() => { resetStorage(); useMemoryDb(); globalThis.chrome.permissions = { contains: async () => true }; });
  afterEach(() => { delete globalThis.chrome.permissions; _setClock(null); });

  // ---------------------------------------------------------------- DATA2-2
  const KNOWN = { carol: 385 };
  const tsPage = (h) => KNOWN[h] != null
    ? `<!doctype html><html><head><title>@${h} Twitter Score ${KNOWN[h]}/1000</title></head><body><h1>@${h}</h1><div>Twitter Score ${KNOWN[h]}</div><div class="hidden">User not found</div></body></html>`
    : `<!doctype html><html><head><title>TwitterScore</title></head><body><h1>Account not found</h1><p>No data for this account yet.</p></body></html>`;
  const tsFetch = async (url) => html(200, tsPage(String(url).match(/twitter\/([^/]+)\//)[1]));

  test("DATA2-2: a public page saying the account is not found is 'no data', not a changed site; a score on the page wins", async () => {
    const def = providerDefs({}).twitterscore;
    const miss = await runCapability(def, "public", "score", "nobody_small", { fetchImpl: tsFetch });
    assert.equal(miss.error, "not_found", miss.message);
    assert.match(miss.message, /no data for @nobody_small/);
    const hit = await runCapability(def, "public", "score", "carol", { fetchImpl: tsFetch });
    assert.equal(hit.score, 385, "the hidden 'User not found' text does not hide a real score");
    // An override of the not-found text applies too; a page with neither a score nor that text is still a parse error.
    const custom = providerDefs({ twitterscore: { notFound: "nobody here" } }).twitterscore;
    assert.equal((await runCapability(custom, "public", "score", "x1", { fetchImpl: async () => html(200, "<p>Nobody here, sorry</p>") })).error, "not_found");
    assert.equal((await runCapability(def, "public", "score", "x2", { fetchImpl: async () => html(200, "<p>Maintenance</p>") })).error, "parse");
  });

  test("DATA2-2: JSON whose score field is null is 'no data'; a missing field is still a changed API", async () => {
    const def = providerDefs({}).sorsa;
    assert.equal((await runCapability(def, "api", "score", "amy", { key: "k", fetchImpl: async () => json(200, { score: null }) })).error, "not_found");
    assert.equal((await runCapability(def, "api", "score", "amy", { key: "k", fetchImpl: async () => json(200, { data: { score: null } }) })).error, "not_found");
    assert.equal((await runCapability(def, "api", "score", "amy", { key: "k", fetchImpl: async () => json(200, { result: 5 }) })).error, "parse");
    assert.equal((await runCapability(def, "api", "score", "amy", { key: "k", fetchImpl: async () => json(200, { score: 0 }) })).score, 0);
  });

  test("DATA2-2: unknown accounts neither stop a target-score run nor get asked again (TwitterScore page, Sorsa API)", async () => {
    const tg = () => ({ amy: { handle: "amy", score: null }, ben: { handle: "ben", score: null }, cat: { handle: "cat", score: null }, carol: { handle: "carol", score: null } });
    await S.saveSettings(S.sanitizeSettings({ scores: { checkOthers: true }, providers: { twitterscore: { enabled: true, dailyCap: 100 }, sorsa: { enabled: true, mode: "api", dailyCap: 100 } } }));
    await S.setSecrets({ sorsaKey: "sorsa-key-123456" });
    await S.save({ [K.targets]: tg() });
    let calls = 0;
    const counted = (f) => async (url) => { calls++; return f(url); };
    let r = await SB.refreshTargetScores(["amy", "ben", "cat", "carol"], "twitterscore", { fetchImpl: counted(tsFetch), ...FAST });
    assert.deepEqual({ ok: r.ok, updated: r.updated, failed: r.failed }, { ok: true, updated: 1, failed: 0 });
    let t = rawGet(K.targets);
    assert.equal(t.carol.score.providers.twitterscore.score, 385);
    assert.equal(t.amy.score.providers.twitterscore.score, null, "remembered as 'no data'");
    calls = 0;
    await SB.refreshTargetScores([], "twitterscore", { fetchImpl: counted(tsFetch), ...FAST });
    assert.equal(calls, 0, "unknown accounts are not asked again within 7 days");
    const sorsa = counted(async (url) => json(200, { score: new URL(url).searchParams.get("username") === "carol" ? 812 : null }));
    r = await SB.refreshTargetScores(["amy", "ben", "cat", "carol"], "sorsa", { fetchImpl: sorsa, ...FAST });
    assert.equal(r.ok, true, r.error);
    t = rawGet(K.targets);
    assert.equal(t.carol.score.providers.sorsa.score, 812);
    assert.equal(t.ben.score.providers.sorsa.score, null);
  });

  // ---------------------------------------------------------------- DATA2-3
  test("DATA2-3: Reset everything stops a running target-score job before its next request", async () => {
    await S.saveSettings(S.sanitizeSettings({ scores: { checkOthers: true }, providers: { ethos: { enabled: true, dailyCap: 500 } } }));
    const tg = {}; for (let i = 0; i < 10; i++) tg["acct" + i] = { handle: "acct" + i, score: null };
    await S.save({ [K.targets]: tg });
    let resetDone = false;
    const after = [];
    const fetchImpl = async (url) => { if (resetDone) after.push(String(url).split("/").pop()); await new Promise((r) => setTimeout(r, 5)); return json(200, { score: 1400, profileId: 3 }); };
    let first; const started = new Promise((r) => (first = r));
    const job = SB.refreshTargetScores([], "ethos", { fetchImpl, ...FAST, onProgress: (p) => { if (p.done === 1) first(); } });
    await started;
    await resetAll();
    resetDone = true;
    const r = await job;
    assert.deepEqual(after, [], `handles sent after the reset: ${after.join(", ")}`);
    assert.equal(r.ok, false);
    assert.equal(rawGet(K.targets), undefined, "nothing written back into the cleared targets");
  });

  test("DATA2-3: a smart-follower search running during Reset everything does not write its candidates back", async () => {
    await S.saveSettings(S.sanitizeSettings({ scores: { checkOthers: true }, providers: { sorsa: { enabled: true, mode: "api", dailyCap: 100 } } }));
    await S.setSecrets({ sorsaKey: "sorsa-key-123456" });
    let resetNow; const gate = new Promise((r) => (resetNow = r));
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls === 1) { resetNow(); await new Promise((r) => setTimeout(r, 30)); } // the reset happens while @big1 is read
      return json(200, { users: [{ username: "smart_" + calls, display_name: "S", score: 900, followers_count: 20000 }] });
    };
    const sweep = SB.sweepSmartFollowers(["big1", "big2"], { fetchImpl, ...FAST });
    await gate;
    await resetAll();
    const r = await sweep;
    assert.deepEqual(Object.keys(rawGet(K.candidates) || {}), [], "candidates stay cleared");
    assert.equal(calls, 1, "@big2 is not asked");
    assert.equal(r.ok, false);
    assert.match(r.error, /reset/);
    assert.equal((rawGet(K.scoreboard) || {}).smart, undefined, "no smart-follower list written back either");
  });

  test("DATA2-3: a provider turned off while a target-score job runs is not asked again", async () => {
    await S.saveSettings(S.sanitizeSettings({ scores: { checkOthers: true }, providers: { ethos: { enabled: true, dailyCap: 500 } } }));
    const tg = {}; for (let i = 0; i < 6; i++) tg["acct" + i] = { handle: "acct" + i, score: null };
    await S.save({ [K.targets]: tg });
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls === 2) await S.saveSettings(S.sanitizeSettings({ scores: { checkOthers: true }, providers: { ethos: { enabled: false } } })); // you turn Ethos off
      return json(200, { score: 1400, profileId: 3 });
    };
    const r = await SB.refreshTargetScores([], "ethos", { fetchImpl, ...FAST });
    assert.equal(calls, 2);
    assert.equal(r.ok, false);
    assert.match(r.error, /off/);
  });

  // ---------------------------------------------------------------- DATA2-4
  test("DATA2-4: a restored backup keeps hand-set priorities hand-set; automatic ones stay automatic", async () => {
    const NOW = Date.UTC(2026, 9, 30, 8, 0);
    _setClock(() => NOW);
    const target = (handle, priority, manual) => {
      const t = applyFollow(newTarget(handle, { tier: 2 }), false, NOW - 20 * DAY);
      t.profile = { handle, following: 6000, followers: 5000 };
      t.score = { own: 90, combined: 90 };
      t.priority = priority;
      if (manual) t.priorityManual = true;
      return t;
    };
    await S.save({ [K.targets]: { alice: target("alice", 33, true), bob: target("bob", 40, false), cy: target("cy", 45, false) } });
    const backup = JSON.parse(JSON.stringify((await exportData(["targets"])).data));
    // After the backup you set cy's priority by hand: an automatic value from the backup does not replace it.
    await S.updateTargets((all) => { all.cy.priority = 12; all.cy.priorityManual = true; return all; });
    await importData(backup, ["targets"]);
    let t = rawGet(K.targets);
    assert.deepEqual([t.alice.priorityManual, t.bob.priorityManual, t.cy.priorityManual], [true, undefined, true]);
    assert.equal(t.cy.priority, 12);
    await updatePriorities(S.sanitizeSettings({}), NOW);
    t = rawGet(K.targets);
    assert.equal(t.alice.priority, 33, "hand-set priority survives the restore and the next learning run");
    assert.equal(t.cy.priority, 12);
    assert.notEqual(t.bob.priority, 40, "an automatic priority is still set by learning");
  });

  // ---------------------------------------------------------------- DATA2-5
  test("DATA2-5: after a bot check your own score is asked again the next day, not at every 4-hourly refresh", async () => {
    await S.saveSettings(S.sanitizeSettings({ account: { handle: "0x_nation" }, providers: { twitterscore: { enabled: true }, ethos: { enabled: true } } }));
    // A date in the past: the provider pacing map keeps the last call time, and a future one would make later tests
    // (same process under `node --test tests/unit/`) wait until then.
    const T0 = Date.UTC(2026, 8, 1, 6, 0);
    let clock = T0;
    _setClock(() => clock);
    let ts = 0, ethos = 0, tabs = 0;
    // The bot check blocks the direct read; the browser tab is tried next (blocked here too) - never the API.
    const readPage = async () => { tabs++; return { ok: false, error: "blocked", message: "Blocked by the site's bot check" }; };
    const fetchImpl = async (url) => {
      clock += 1000; // the answer arrives a second later
      if (/twitterscore/.test(url)) { ts++; return html(403, "<!doctype html><title>Just a moment...</title><div>challenge-platform</div>"); }
      ethos++; return { status: 0, ok: false, text: async () => { throw new Error("offline"); } };
    };
    for (let i = 0; i < 6; i++) { // the scores alarm: every 240 minutes
      clock = T0 + i * 4 * HOUR;
      await SB.refreshOwn({ fetchImpl, readPage, ...FAST });
    }
    assert.equal(ts, 1, "the blocking site is asked once in 20 hours");
    assert.equal(tabs, 1, "and the browser tab once after the bot check");
    assert.equal(ethos, 6, "a network error is retried at the next refresh");
    assert.equal(rawGet(K.scoreboard).own.twitterscore.errorCode, "blocked");
    clock = T0 + 24 * HOUR;
    await SB.refreshOwn({ fetchImpl, readPage, ...FAST });
    assert.equal(ts, 2, "asked again the next day");
    await SB.refreshOwn({ force: true, only: ["twitterscore"], fetchImpl, readPage, ...FAST });
    assert.equal(ts, 3, "Refresh now / Test always ask");
  });
});
