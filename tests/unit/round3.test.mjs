// Fixes from review round 3 (what the round-2 fixes left open): the soft-error back-off after a failed watch load holds
// for every early tick, a watch page loaded before Pause counts toward the 90 s minimum, a rotation check with mixed
// failures is not an error-page check, Reset everything is not undone by a score job's write already under way, and
// a second Regenerate of the same reply is refused by the worker.
import { resetStorage, rawGet, chromeLocal } from "./_chrome.mjs";
import { install, mockOpenAI } from "./_engine_env.mjs";
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useMemoryDb } from "../../extension/lib/db.js";
import * as H from "../../extension/lib/history.js";
import * as engine from "../../extension/lib/engine.js";
import * as S from "../../extension/lib/store.js";
import * as SB from "../../extension/lib/scoreboard.js";
import { resetAll } from "../../extension/lib/backup.js";
import { watchOnce } from "../../extension/lib/watcher.js";
import { K, HS, STOP, STATUS, HARD } from "../../extension/lib/constants.js";
import { newTarget, applyFollow } from "../../extension/lib/targets.js";
import { MIN, HOUR, DAY, _setClock } from "../../extension/lib/util.js";
import { fakeTab, fast, okPage } from "./_xtab.mjs";

const ME = "0x_nation";
const LIST = "https://x.com/i/lists/1234567890";
const baseSettings = {
  mode: "auto",
  account: { handle: ME, verifyAccount: true },
  watch: { strategy: "list", listUrls: [LIST], scrolls: 0, catchUp: { enabled: false } },
  safety: { activeHours: { enabled: false }, breaks: { enabled: false } },
  learning: { enabled: false, conversations: { enabled: false } },
  review: { notifyNew: false },
};
const notFollowing = (h, o) => applyFollow(newTarget(h, o), false, Date.now() - DAY);

async function setup(env, { settings = {}, targets = { alice: notFollowing("alice") }, state = {} } = {}) {
  resetStorage();
  useMemoryDb();
  await S.save({ [K.settings]: { ...baseSettings, ...settings }, [K.targets]: targets });
  await S.setSecrets({ openaiKey: "sk-test-1234567890abcdef" });
  env.addTab({ id: 3, url: "https://x.com/home", pinned: true, index: 0 });
  await S.patchState({ status: STATUS.RUNNING, firstStartedAt: Date.now() - 20 * DAY, startedAt: Date.now() - HOUR, workerTabId: 3, workerTabPinned: true, workerTabIndex: 0, followBadgeOkAt: Date.now(), followersScanAt: Date.now(), lastWatchAt: Date.now() - 10 * MIN, ...state });
}

describe("round 3: engine", () => {
  let env;
  let offset = 0;
  const loads = () => env.navigations.filter(([, u]) => u === LIST).length;
  const errorPage = () => {
    env.page = { state: "error_page", detail: "Something went wrong. Try reloading.", me: ME, hidden: false };
    env.content = async (msg) => (msg.sx === "waitFor" ? { ok: true, key: "tweet" } : msg.sx === "scrapeTweets" ? { ok: true, tweets: [], articleCount: 0 } : { ok: true });
  };
  before(() => { env = install(); _setClock(() => Date.now() + offset); });
  after(() => { _setClock(null); env.uninstall(); });
  beforeEach(() => {
    offset = 0;
    env.tabs.clear(); env.navigations.length = 0; env.commands.length = 0; env.notifications.length = 0;
    env.content = null; env.loads = true; env.page = { state: "ok", detail: "", me: ME, hidden: false };
  });
  afterEach(async () => { await engine.pause().catch(() => {}); });

  test("R3B-1: 'Run a check now' inside the 2-5 min back-off after a failed watch load waits for it, then checks", async () => {
    await setup(env);
    errorPage();
    await engine.tick("alarm"); // X shows "Something went wrong" on the list
    let st = await S.getState();
    assert.equal(loads(), 1);
    assert.equal(st.nextTickWhy, "retry after soft error");
    const backoff = st.watchRetryAt - Date.now();
    assert.ok(backoff >= 2 * MIN - 5000 && backoff <= 5 * MIN + 5000, "the back-off is kept in state: " + backoff);
    assert.ok(Math.abs(st.nextTickAt - st.watchRetryAt) < 2000, "the retry tick is the end of the back-off");

    offset = 95 * 1000; // past the 90 s minimum, inside the back-off
    assert.equal((await engine.runNow()).ok, true);
    await engine.tick("manual");
    st = await S.getState();
    assert.equal(loads(), 1, "the failing watch page was reloaded inside the back-off");
    assert.equal(st.nextTickWhy, "manual");
    assert.ok(st.nextTickAt >= st.watchRetryAt, "the manual check is moved to the end of the back-off");

    offset = backoff + 2000; // the back-off is over: the check runs
    await engine.tick("manual");
    assert.equal(loads(), 2, "the check after the back-off loads the watch page");
  });

  test("R3B-1: two presses of 'Run a check now' cannot turn one error page into the 3-in-a-row rate-limit stop", async () => {
    await setup(env);
    errorPage();
    await engine.tick("alarm");
    offset = 95 * 1000; await engine.runNow(); await engine.tick("manual");
    offset = 190 * 1000; await engine.runNow(); await engine.tick("manual");
    const st = await S.getState();
    // The 95 s press waits; the 190 s one checks only if the random 2-5 min back-off was already over.
    assert.ok(loads() <= 2, `watch page loads: ${loads()}`);
    assert.equal(st.status, STATUS.RUNNING, `stopped as '${st.stopReason}'`);
    assert.equal(st.errorPageStreak, loads());
  });

  test("R3B-1: an early tick of another kind (an approval in Review) does not reload the failing watch page either", async () => {
    await setup(env, { settings: { mode: "review" } });
    errorPage();
    await engine.tick("alarm");
    offset = 95 * 1000; // reviewAction("approve") -> requestTick(15-45 s, "approved item") -> tick("timer")
    await engine.tick("timer");
    assert.equal(loads(), 1, "the approval's tick reloaded the failing watch page inside the back-off");
    assert.equal((await S.getState()).status, STATUS.RUNNING);
  });

  test("R3B-1: a successful watch check and Resume clear the back-off", async () => {
    await setup(env);
    errorPage();
    await engine.tick("alarm");
    assert.ok((await S.getState()).watchRetryAt > Date.now());
    await engine.pause();
    await engine.resume();
    assert.equal((await S.getState()).watchRetryAt, null, "Resume starts without the old back-off");
    env.page = { state: "ok", detail: "", me: ME, hidden: false };
    await S.patchState({ watchRetryAt: Date.now() + MIN, lastWatchAt: 0 });
    offset = 2 * MIN;
    await engine.tick("alarm");
    assert.equal(loads(), 2);
    assert.equal((await S.getState()).watchRetryAt, null, "a successful check clears the back-off");
  });

  test("R3B-3: Pause after X loaded the watch page, then Resume: the page is not loaded again within the 90 s minimum", async () => {
    await setup(env);
    let pauseOnce = true;
    env.content = async (msg, tab) => {
      if (msg.sx === "waitFor") {
        if (tab.url === LIST && pauseOnce) { pauseOnce = false; await engine.pause(); } // the page is loaded: Pause
        return { ok: true, key: "tweet" };
      }
      if (msg.sx === "scrapeTweets") return { ok: true, tweets: [], articleCount: 0 };
      return { ok: true };
    };
    await engine.tick("alarm");
    assert.equal(loads(), 1);
    assert.equal((await S.getState()).status, STATUS.PAUSED);
    await engine.resume();
    await engine.tick("timer");
    assert.equal(loads(), 1, `the list was loaded again within seconds (hard minimum ${HARD.minCheckIntervalSec} s)`);
    offset = HARD.minCheckIntervalSec * 1000 + 5000;
    await engine.tick("timer");
    assert.equal(loads(), 2, "after the minimum interval the list is checked again");
  });

  test("R3U-1: a second Regenerate of the same reply while the first one runs is refused (one paid generation)", async () => {
    await setup(env, { settings: { mode: "review" } });
    const rec = H.newRecord({ target: "alice", targetName: "Alice", postId: "1983000000000000901", postUrl: "https://x.com/alice/status/1983000000000000901", postText: "Distribution beats features in crypto infra, every single cycle.", postLang: "en", postCreatedAt: Date.now() - 5 * MIN, comment: "Features get copied in a quarter, distribution compounds for years.", status: HS.PENDING_REVIEW, mode: "review", preset: "balanced" });
    await H.put(rec);
    const replies = ["A sharper angle: the moat is the default slot in the wallet, not the feature list.", "Most teams underrate how long a default placement lasts once users stop comparing apps at all."];
    let n = 0;
    const calls = mockOpenAI(() => replies[n++ % replies.length]);
    const mock = globalThis.fetch;
    let release;
    const gate = new Promise((r) => (release = r));
    globalThis.fetch = async (...a) => { await gate; return mock(...a); }; // the model is still writing
    const first = engine.reviewAction({ id: rec.id, action: "regenerate" });
    await env.wait(20);
    const secondP = engine.reviewAction({ id: rec.id, action: "regenerate" }); // a second press (another visit or window)
    await env.wait(20);
    release();
    const [r1, second] = await Promise.all([first, secondP]);
    assert.equal(second.ok, false);
    assert.match(second.error, /already being written/);
    assert.equal(r1.ok, true, JSON.stringify(r1));
    const gens = calls.filter((b) => !/pass/.test(JSON.stringify((b.text && b.text.format && b.text.format.schema) || {})));
    assert.equal(gens.length, 1, `OpenAI generations: ${gens.length}`);
    // Once it answered, a new Regenerate is possible again.
    const third = await engine.reviewAction({ id: rec.id, action: "regenerate" });
    assert.equal(third.ok, true, JSON.stringify(third));
  });
});

describe("round 3: Reset everything during a score job's write", () => {
  let env;
  let savedPerm;
  const json = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) });
  // Lets resetAll() run until its first removal went through (the read before it has already been answered).
  const firstRemoval = async () => { for (let i = 0; i < 200 && rawGet(K.settings) !== undefined; i++) await env.wait(1); };
  before(() => { env = install(); savedPerm = globalThis.chrome.permissions; globalThis.chrome.permissions = { contains: async () => true }; });
  after(() => { globalThis.chrome.permissions = savedPerm; env.uninstall(); });

  test("R3B-2: a target-score write whose read came before the reset does not bring the deleted targets back", async () => {
    resetStorage();
    useMemoryDb();
    await S.saveSettings(S.sanitizeSettings({ providers: { ethos: { enabled: true, dailyCap: 500 } } }));
    const tg = {};
    for (let i = 0; i < 4; i++) tg["acct" + i] = { handle: "acct" + i, score: null };
    await S.save({ [K.targets]: tg });
    let armed = false;
    let resetP = null;
    const realGet = chromeLocal.get;
    chromeLocal.get = async function (keys) {
      if (armed && keys === K.targets) {
        armed = false;
        const snapshot = await realGet.call(this, keys); // the job's read is answered with the old targets ...
        resetP = resetAll(); //                              ... and "Reset everything" arrives before its write
        await firstRemoval();
        return snapshot;
      }
      return realGet.call(this, keys);
    };
    try {
      const fetchImpl = async () => { armed = true; return json(200, { score: 1400, profileId: 3 }); };
      const r = await SB.refreshTargetScores([], "ethos", { fetchImpl, gapMs: 0 });
      assert.ok(resetP, "setup: the reset ran during the job's write");
      await resetP;
      assert.equal(r.ok, false, JSON.stringify(r));
      const left = rawGet(K.targets);
      assert.ok(!left || !Object.keys(left).length, `targets written back after the reset: ${Object.keys(left || {}).join(", ")}`);
    } finally { chromeLocal.get = realGet; }
  });

  test("R3B-2: a candidates write under way when the reset lands is cleared with the list", async () => {
    resetStorage();
    useMemoryDb();
    await S.saveSettings(S.sanitizeSettings({}));
    await S.save({ [K.candidates]: { smart_1: { handle: "smart_1", smart: true } } });
    let resetP = null;
    await S.updateCandidates(async (all) => {
      resetP = resetAll();
      await firstRemoval();
      all.smart_2 = { handle: "smart_2", smart: true };
      return all;
    });
    await resetP;
    const left = rawGet(K.candidates);
    assert.ok(!left || !Object.keys(left).length, `candidates after Reset everything: ${JSON.stringify(Object.keys(left || {}))}`);
  });
});

describe("round 3: rotation watch with mixed failures", () => {
  beforeEach(() => resetStorage());
  const H3 = 3600e3;
  const active = (h, lastCheckedAt) => { const t = newTarget(h); t.rel.followsYou = false; t.rel.checkedAt = Date.now(); t.group = "B"; t.lastCheckedAt = lastCheckedAt; return t; };
  const handleOf = (tab) => tab.url.split("/").pop();
  const err = okPage(ME, { state: "error_page", detail: "Something went wrong. Try reloading." });
  async function check(errorFirst) {
    const ts = Date.now();
    await S.updateTargets(() => ({ alice: active("alice", ts - 3 * H3), bob: active("bob", ts - 2 * H3) })); // alice first
    const errFor = errorFirst ? "alice" : "bob";
    const tab = fakeTab({
      waitFor: (m, t) => (handleOf(t) === errFor ? { ok: false, settled: "error_page", page: err } : { ok: true, key: "profileUserName" }),
      scrapeProfile: (m, t) => (handleOf(t) === errFor ? { ok: true, profile: null, tweets: [], page: err } : { ok: false, error: "no_answer" }),
    });
    return watchOnce(tab.tab.id, S.sanitizeSettings({ watch: { strategy: "rotation", rotationPerTick: 2, scrolls: 0 } }), await S.getTargets(), Date.now(), { shouldStop: async () => false });
  }

  test("R3B-4: an error page and an unanswered visit are not an error-page check, whatever the visit order", async (t) => {
    fast(t);
    const a = await check(false);
    const b = await check(true);
    for (const r of [a, b]) {
      assert.equal(r.ok, false);
      assert.equal(r.soft, "no_answer", JSON.stringify(r));
    }
  });

  test("R3B-3: an aborted watch check says whether X had already loaded the watch page", async (t) => {
    fast(t);
    await S.updateTargets(() => ({ alice: active("alice", Date.now() - H3) }));
    const settings = S.sanitizeSettings({ watch: { strategy: "list", listUrls: [LIST], scrolls: 0 } });
    const tab = fakeTab({ waitFor: () => ({ ok: true, key: "tweet" }), scrapeTweets: () => ({ ok: true, tweets: [], articleCount: 0 }) });
    const early = await watchOnce(tab.tab.id, settings, await S.getTargets(), Date.now(), { shouldStop: async () => true });
    assert.equal(early.aborted, true);
    assert.ok(!early.loaded, "stopped before anything was loaded: " + JSON.stringify(early));
    assert.equal(tab.count("navigate"), 0);
    let asked = 0; // watchOnce's own check and the one before the navigation pass, the next one (on the page) stops
    const late = await watchOnce(tab.tab.id, settings, await S.getTargets(), Date.now(), { shouldStop: async () => ++asked > 2 });
    assert.equal(tab.count("navigate"), 1);
    assert.equal(late.aborted, true);
    assert.equal(late.loaded, true, JSON.stringify(late));
  });

  test("R3B-4: visits that all showed X's error page are an error-page check", async (t) => {
    fast(t);
    const ts = Date.now();
    await S.updateTargets(() => ({ alice: active("alice", ts - 3 * H3), bob: active("bob", ts - 2 * H3) }));
    const tab = fakeTab({ waitFor: () => ({ ok: false, settled: "error_page", page: err }), scrapeProfile: () => ({ ok: true, profile: null, tweets: [], page: err }) });
    const r = await watchOnce(tab.tab.id, S.sanitizeSettings({ watch: { strategy: "rotation", rotationPerTick: 2, scrolls: 0 } }), await S.getTargets(), Date.now(), { shouldStop: async () => false });
    assert.equal(r.ok, false);
    assert.equal(r.soft, "error_page");
  });
});
