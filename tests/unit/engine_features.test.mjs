// Engine & scheduling features: X footprint + page-load budget, risk meter, adaptive watch cadence, reach hooks.
import { resetStorage } from "./_chrome.mjs";
import { install } from "./_engine_env.mjs";
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useMemoryDb } from "../../extension/lib/db.js";
import * as H from "../../extension/lib/history.js";
import * as engine from "../../extension/lib/engine.js";
import * as tabs from "../../extension/lib/tabs.js";
import * as safety from "../../extension/lib/safety.js";
import { setBadge } from "../../extension/lib/notify.js";
import { getState, patchState, save, setSecrets, sanitizeSettings } from "../../extension/lib/store.js";
import { K, HS, STATUS, MODE, HARD } from "../../extension/lib/constants.js";
import { newTarget, applyFollow } from "../../extension/lib/targets.js";
import { _setClock, _setRandom, MIN, HOUR, DAY } from "../../extension/lib/util.js";

const ME = "0x_nation";
const T0 = Date.UTC(2026, 9, 30, 12, 30); // 12:30 UTC
const H0 = Math.floor(T0 / HOUR);
const baseSettings = {
  mode: "auto",
  account: { handle: ME, verifyAccount: true },
  watch: { strategy: "list", listUrls: ["https://x.com/i/lists/1234567890"], scrolls: 0, catchUp: { enabled: false } },
  safety: { activeHours: { enabled: false }, breaks: { enabled: false } },
  learning: { enabled: false, conversations: { enabled: false } },
  review: { notifyNew: false },
};
const notFollowing = (h) => applyFollow(newTarget(h), false, Date.now() - DAY);

describe("X footprint (pure)", () => {
  test("inferPurpose maps x.com URLs to page-load purposes", () => {
    const cases = {
      "https://x.com/search?q=(from%3Aa)%20-filter%3Areplies&f=live&src=typed_query": "watch",
      "https://x.com/search?q=defi&f=user&src=typed_query": "discovery",
      "https://x.com/i/lists/1234567890": "watch",
      "https://x.com/alice/status/1983000000000000001": "post",
      "https://x.com/notifications/mentions": "mentions",
      "https://x.com/0x_nation/followers": "follow",
      "https://x.com/bigbob/following": "follow",
      "https://x.com/0x_nation/verified_followers": "follow",
      "https://x.com/home": "other",
      "https://x.com/alice": "profile",
      "https://x.com/Alice_99/": "profile",
      "https://x.com/settings/account": "other",
      "not a url": "other",
    };
    for (const [u, p] of Object.entries(cases)) assert.equal(tabs.inferPurpose(u), p, u);
  });

  test("footprintAdd keeps hour buckets of the last 24 h only; footprintSummary totals them oldest first", () => {
    let fp = null;
    fp = tabs.footprintAdd(fp, "watch", T0 - 30 * HOUR); // will fall out of the window
    fp = tabs.footprintAdd(fp, "watch", T0 - 23 * HOUR);
    fp = tabs.footprintAdd(fp, "post", T0 - 2 * HOUR);
    fp = tabs.footprintAdd(fp, "post", T0 - 2 * HOUR);
    fp = tabs.footprintAdd(fp, "nonsense", T0);
    assert.ok(Object.keys(fp).length <= 24);
    assert.ok(!Object.hasOwn(fp, String(H0 - 30)), "older than 24 h dropped on write");
    const s = tabs.footprintSummary(fp, 50, T0);
    assert.equal(s.total, 4);
    assert.equal(s.cap, 50);
    assert.equal(s.byPurpose.watch, 1);
    assert.equal(s.byPurpose.post, 2);
    assert.equal(s.byPurpose.other, 1, "unknown purposes count as other");
    assert.deepEqual(Object.keys(s.byPurpose).sort(), [...tabs.PURPOSES].sort());
    assert.equal(s.hourly.length, 24);
    assert.equal(s.hourly[0], 1, "oldest hour first");
    assert.equal(s.hourly[21], 2);
    assert.equal(s.hourly[23], 1, "current hour last");
    assert.deepEqual(tabs.footprintSummary(null, 0, T0), { total: 0, cap: 0, byPurpose: Object.fromEntries(tabs.PURPOSES.map((p) => [p, 0])), hourly: new Array(24).fill(0) });
  });

  test("pageBudget: room left and when enough loads leave the rolling window", () => {
    const fp = { [H0 - 20]: { watch: 3 }, [H0 - 5]: { post: 2 }, [H0]: { watch: 1 } };
    const settings = sanitizeSettings({ safety: { maxPageLoads24h: 6 } });
    assert.deepEqual(tabs.pageBudget(settings, { footprint: fp }, T0), { cap: 6, used: 6, left: 0, until: (H0 - 20 + 24) * HOUR });
    assert.equal(tabs.pageBudget(settings, { footprint: fp }, T0, 4).until, (H0 - 5 + 24) * HOUR, "4 free loads need the next bucket out too");
    assert.equal(tabs.pageBudget(sanitizeSettings({ safety: { maxPageLoads24h: 10 } }), { footprint: fp }, T0).left, 4);
    const none = tabs.pageBudget(sanitizeSettings({}), { footprint: fp }, T0);
    assert.equal(none.cap, 0);
    assert.equal(none.left, Infinity, "no cap by default");
  });
});

describe("engine features (worker tab)", () => {
  let env;
  before(() => { env = install(); });
  after(() => env.uninstall());
  beforeEach(async () => {
    env.tabs.clear(); env.navigations.length = 0; env.commands.length = 0;
    env.content = async (msg) => (msg.sx === "waitFor" ? { ok: true, key: "tweet" } : msg.sx === "scrapeTweets" ? { ok: true, tweets: [], articleCount: 0 } : { ok: true });
    env.page = { state: "ok", detail: "", me: ME, hidden: false };
    resetStorage();
    useMemoryDb();
    await save({ [K.settings]: baseSettings, [K.targets]: { alice: notFollowing("alice") } });
    await setSecrets({ openaiKey: "sk-test-1234567890abcdef" });
    env.addTab({ id: 3, url: "https://x.com/home", pinned: true, index: 0 });
    await patchState({ status: STATUS.RUNNING, firstStartedAt: Date.now() - 20 * DAY, startedAt: Date.now() - HOUR, workerTabId: 3, workerTabPinned: true, workerTabIndex: 0, workerTabFreshAt: Date.now(), followBadgeOkAt: Date.now(), followersScanAt: Date.now() });
  });
  afterEach(async () => { _setClock(null); _setRandom(null); await engine.pause().catch(() => {}); });

  test("navigate counts every page load under its purpose (explicit > the engine's job > the URL)", async () => {
    await tabs.navigate(3, "https://x.com/alice/status/1983000000000000001");
    await tabs.navigate(3, "https://x.com/alice/status/1983000000000000002", { purpose: "check" });
    await tabs.withPurpose("follow", () => tabs.navigate(3, "https://x.com/bob"));
    await tabs.navigate(3, "https://x.com/i/lists/123456", 45000); // the older timeout argument still works
    await engine.withLease("discovery", () => tabs.navigate(3, "https://x.com/carol/followers"));
    const s = (await engine.getStatus()).footprint;
    assert.equal(s.total, 5);
    assert.deepEqual([s.byPurpose.post, s.byPurpose.check, s.byPurpose.follow, s.byPurpose.watch, s.byPurpose.discovery], [1, 1, 1, 1, 1]);
    assert.equal(s.cap, 0);
    assert.equal(s.hourly[23], 5);
  });

  test("at the page-load budget navigate refuses softly without loading anything", async () => {
    await save({ [K.settings]: { ...baseSettings, safety: { ...baseSettings.safety, maxPageLoads24h: 2 } } });
    assert.ok((await tabs.navigate(3, "https://x.com/a")).ok);
    assert.ok((await tabs.navigate(3, "https://x.com/b")).ok);
    const r = await tabs.navigate(3, "https://x.com/c");
    assert.equal(r.ok, false);
    assert.equal(r.budget, true);
    assert.equal(r.error, "page_budget");
    assert.ok(r.until > Date.now());
    assert.equal(env.navigations.length, 2, "the third page was never loaded");
  });

  test("the engine waits at the page-load budget (never a stop) and the status says so", async () => {
    const h = Math.floor(Date.now() / HOUR);
    await save({ [K.settings]: { ...baseSettings, safety: { ...baseSettings.safety, maxPageLoads24h: 3 } } });
    await patchState({ footprint: { [h - 3]: { watch: 3 } }, lastWatchAt: 0 });
    await engine.tick("alarm");
    let st = await getState();
    assert.equal(st.status, STATUS.RUNNING);
    assert.equal(st.nextTickWhy, safety.GATE_LABEL.footprint);
    assert.ok(st.nextTickAt - Date.now() <= 31 * MIN, "re-checks at least every 30 min");
    assert.equal(env.navigations.length, 0, "no X page was loaded");
    assert.equal(env.reloads.length, 0, "the tab was not even reloaded");
    const status = await engine.getStatus();
    assert.equal(status.footprint.total, 3);
    assert.equal(status.footprint.cap, 3);
    assert.match(status.sub, /X page-load budget reached - waiting/);
    // A queued reply that is due also waits (it needs up to 2 loads), it is not failed.
    await save({ [K.settings]: { ...baseSettings, safety: { ...baseSettings.safety, maxPageLoads24h: 4 } } });
    const rec = await H.put(H.newRecord({ status: HS.QUEUED, target: "alice", group: "B", postId: "19", postUrl: "https://x.com/alice/status/19", comment: "A reply waiting for its slot", attempts: 1, postCreatedAt: Date.now() - 4 * MIN, scheduledFor: 0 }));
    await engine.tick("alarm");
    st = await getState();
    assert.equal(st.nextTickWhy, safety.GATE_LABEL.footprint);
    assert.equal((await H.get(rec.id)).status, HS.QUEUED);
    assert.equal(st.consecutiveFailures || 0, 0);
    assert.equal(env.navigations.length, 0);
  });

  test("adaptive watch: empty checks stretch the interval, a fresh post resets it; the status shows it", async () => {
    await save({ [K.settings]: { ...baseSettings, safety: { ...baseSettings.safety, adaptiveWatch: { enabled: true, afterEmpty: 2, maxIntervalMin: 15 } } } });
    for (let i = 1; i <= 3; i++) {
      await patchState({ lastWatchAt: 0 });
      await engine.tick("alarm");
      assert.equal((await getState()).emptyWatchStreak, i);
    }
    const status = await engine.getStatus();
    assert.equal(status.watch.slow, true);
    assert.equal(status.watch.emptyStreak, 3);
    assert.ok(status.watch.intervalSec > 255, "longer than the normal 150-360 s middle: " + status.watch.intervalSec);
    assert.match(status.sub, /^Watching slowly: nothing new for \d+ min/);
    const p = { id: "1983000000000000077", url: "https://x.com/alice/status/1983000000000000077", author: "alice", authorName: "Alice", text: "A brand new post", lang: "en", createdAt: Date.now() - 30 * 1000, metrics: {} };
    env.content = async (msg) => (msg.sx === "waitFor" ? { ok: true, key: "tweet" } : msg.sx === "scrapeTweets" ? { ok: true, tweets: [p], articleCount: 1 } : { ok: true });
    await patchState({ lastWatchAt: 0 });
    await engine.tick("alarm");
    const st = await getState();
    assert.equal(st.emptyWatchStreak, 0, "a fresh target post resets the streak");
    assert.ok(st.lastFreshAt > 0);
    assert.equal((await engine.getStatus()).watch.slow, false);
  });

  test("getStatus carries footprint, risk, watch and reach in the contract shapes", async () => {
    await patchState({ reach: { checked: 20, medianViews: 40, prevMedianViews: 160, lowShare: 0.6, at: Date.now() }, reachAlert: { at: Date.now(), message: "Your replies are reaching far fewer people than last week", medianNow: 40, medianBefore: 160, lowShare: 0.6, checked: 20, action: "halve" } });
    const s = await engine.getStatus();
    assert.deepEqual(Object.keys(s.footprint).sort(), ["byPurpose", "cap", "hourly", "total"]);
    assert.ok(["low", "medium", "high"].includes(s.risk.level));
    assert.ok(s.risk.score >= 0 && s.risk.score <= 100);
    assert.ok(Array.isArray(s.risk.factors) && s.risk.factors.every((f) => f.id && f.label && typeof f.detail === "string"));
    assert.ok(s.risk.factors.some((f) => f.id === "reach"));
    assert.deepEqual(Object.keys(s.watch).sort(), ["emptyStreak", "intervalSec", "slow"]);
    assert.equal(s.reach.medianViews, 40);
    assert.equal(s.reach.alert.action, "halve");
    assert.equal(s.today.limit, 100, "daily limit halved while the 'halve' reach alert is open");
    await patchState({ reachAlert: null, reachDismissedAt: Date.now() });
    const s2 = await engine.getStatus();
    assert.equal(s2.today.limit, 200, "back to normal once dismissed");
    assert.equal(s2.reach.alert, null);
  });

  test("state.me (account chip) is written from page reports, at most every 10 min unless the handle changes", async () => {
    let t = T0 + 40 * DAY;
    _setClock(() => t);
    env.page = { ...env.page, me: "Main_Acct" };
    await tabs.send(3, "ping");
    assert.deepEqual((await getState()).me, { handle: "main_acct", checkedAt: t }, "a ping's handle is recorded (normalized)");
    const first = t;
    t += 4 * MIN;
    await tabs.send(3, "waitFor", { keys: ["tweet"] });
    assert.equal((await getState()).me.checkedAt, first, "same handle within 10 min: no write");
    t += 1 * MIN;
    env.page = { ...env.page, me: "other_acct" };
    await tabs.send(3, "waitFor", { keys: ["tweet"] });
    assert.deepEqual((await getState()).me, { handle: "other_acct", checkedAt: t }, "a different handle is written at once");
    t += 11 * MIN;
    await tabs.send(3, "ping");
    assert.equal((await getState()).me.checkedAt, t, "refreshed after 10 min");
    env.page = { ...env.page, me: null };
    t += 11 * MIN;
    await tabs.send(3, "ping");
    assert.equal((await getState()).me.handle, "other_acct", "an unreadable handle never clears or changes it");
  });

  test("the toolbar badge shows a red ! for an open reach alert until it is dismissed", async () => {
    env.badges.length = 0;
    await setBadge({ status: STATUS.RUNNING, reachAlert: { message: "Your replies are reaching far fewer people", action: "notify" } }, 0);
    assert.equal(env.badges.at(-1), "!");
    await setBadge({ status: STATUS.RUNNING, reachAlert: null }, 0);
    assert.equal(env.badges.at(-1), "0", "running: the badge counts replies posted in the last 24 h");
  });
});

describe("safety: adaptive cadence, reach hooks, risk meter (pure)", () => {
  afterEach(() => _setRandom(null));

  test("watchCadence: normal until afterEmpty empty checks, then 1.5x per check up to maxIntervalMin; never below the hard floor", () => {
    const s = sanitizeSettings({ safety: { adaptiveWatch: { enabled: true, afterEmpty: 3, maxIntervalMin: 15 } } });
    const base = safety.watchCadence(s, { emptyWatchStreak: 2 });
    assert.equal(base.slow, false);
    assert.deepEqual([base.loMs, base.hiMs], [150000, 360000]);
    const w3 = safety.watchCadence(s, { emptyWatchStreak: 3 });
    assert.equal(w3.slow, true);
    assert.deepEqual([w3.loMs, w3.hiMs], [225000, 540000]);
    const w4 = safety.watchCadence(s, { emptyWatchStreak: 4 });
    assert.deepEqual([w4.loMs, w4.hiMs], [337500, 810000]);
    const w9 = safety.watchCadence(s, { emptyWatchStreak: 40 });
    assert.deepEqual([w9.loMs, w9.hiMs], [15 * MIN, 15 * MIN], "capped at maxIntervalMin");
    assert.equal(safety.watchCadence(sanitizeSettings({ safety: { adaptiveWatch: { enabled: false } } }), { emptyWatchStreak: 40 }).slow, false, "off = today's behaviour");
    assert.equal(safety.watchCadence(s, undefined).slow, false, "no state = today's behaviour");
    // A configured interval longer than the cap is never shortened.
    const long = sanitizeSettings({ watch: { checkIntervalSec: { min: 1200, max: 1800 } }, safety: { adaptiveWatch: { enabled: true, afterEmpty: 2, maxIntervalMin: 5 } } });
    const wl = safety.watchCadence(long, { emptyWatchStreak: 10 });
    assert.deepEqual([wl.loMs, wl.hiMs], [1800000, 1800000]);
    _setRandom(() => 0.5);
    const tiny = { watch: { checkIntervalSec: { min: 10, max: 20 } }, safety: { adaptiveWatch: { enabled: true, afterEmpty: 1, maxIntervalMin: 5 } } };
    assert.ok(safety.nextCheckMs(tiny, { emptyWatchStreak: 0 }) >= HARD.minCheckIntervalSec * 1000);
    assert.equal(safety.nextCheckMs(s), Math.round((150 + 0.5 * 210) * 1000), "old call without state unchanged");
    assert.equal(safety.nextCheckMs(s, { emptyWatchStreak: 3 }), Math.round(225000 + 0.5 * (540000 - 225000)));
  });

  test("reach hooks: 'halve' halves the daily limit (floor, at least 1), until dismissed; 'review' is reach.js's one-time switch", () => {
    const s = sanitizeSettings({ mode: "auto", safety: { ramp: [200, 200, 3] } });
    const st = { firstStartedAt: T0 - 30 * DAY };
    assert.equal(safety.dailyLimit(s, st, T0), 3);
    assert.equal(safety.dailyLimit(s, { ...st, reachAlert: { action: "halve" } }, T0), 1);
    assert.equal(safety.dailyLimit(sanitizeSettings({ safety: { ramp: [200, 200, 1] } }), { ...st, reachAlert: { action: "halve" } }, T0), 1, "at least 1");
    assert.equal(safety.dailyLimit(sanitizeSettings({ safety: { ramp: [0, 0, 0] } }), { ...st, reachAlert: { action: "halve" } }, T0), 0, "0 stays 0");
    assert.equal(safety.dailyLimit(sanitizeSettings({}), { ...st, reachAlert: { action: "halve" } }, T0), 100);
    assert.equal(safety.generationLimit(sanitizeSettings({}), { ...st, reachAlert: { action: "halve" } }, T0), 200, "generations follow the halved limit");
    assert.equal(safety.dailyLimit(sanitizeSettings({}), { ...st, reachAlert: { action: "notify" } }, T0), 200);
    // "review" is applied once by reach.js (settings.mode = "review"); the mode itself follows the settings, so the
    // owner can switch back to Full auto while the alert is still open.
    assert.equal(safety.effectiveMode(s, { reachAlert: { action: "review" } }), MODE.AUTO);
    assert.equal(safety.effectiveMode({ ...s, mode: MODE.REVIEW }, { reachAlert: { action: "review" } }), MODE.REVIEW);
  });

  test("riskReport: a calm setup is low, the owner's busy defaults in Full auto are high, with readable factors", () => {
    const calm = sanitizeSettings({ mode: "review", safety: { ramp: [20, 20, 20], activeHours: { enabled: true, start: "10:00", end: "18:00" }, like: { enabled: false } }, watch: { minPostAgeMin: 8 } });
    const low = safety.riskReport(calm, { startedAt: T0 - 10 * HOUR }, { postedToday: 5 }, { total: 80 }, {}, T0);
    assert.equal(low.level, "low");
    assert.ok(low.score < safety.RISK_LEVELS.medium);
    const busy = sanitizeSettings({ mode: "auto" }); // 200/day, around the clock, likes, 2 min
    const high = safety.riskReport(busy, { startedAt: T0 - 30 * HOUR }, { postedToday: 150 }, { total: 1200, cap: 0 }, {}, T0);
    assert.equal(high.level, "high");
    assert.ok(high.score >= safety.RISK_LEVELS.high && high.score <= 100);
    const ids = high.factors.map((f) => f.id);
    for (const id of ["volume", "hours", "auto", "likes", "speed", "footprint"]) assert.ok(ids.includes(id), id);
    assert.ok(high.factors.every((f) => typeof f.label === "string" && typeof f.detail === "string" && f.points > 0));
    assert.deepEqual(high.factors.map((f) => f.points), [...high.factors.map((f) => f.points)].sort((a, b) => b - a), "biggest factor first");
    assert.equal(high.hoursToLimit, Math.round(((200 - 150) / (150 / 24)) * 10) / 10);
    const def = safety.riskReport(sanitizeSettings({}), {}, { postedToday: 0 }, { total: 0 }, {}, T0);
    assert.equal(def.hoursToLimit, null, "nothing posted yet: no pace");
    assert.equal(def.level, "medium", "the default review setup (200/day around the clock, likes) is not 'low'");
    const reach = safety.riskReport(calm, {}, { postedToday: 5 }, { total: 80 }, { alert: { message: "Views dropped 70%" } }, T0);
    assert.ok(reach.factors.some((f) => f.id === "reach" && /70%/.test(f.detail)));
    assert.ok(reach.score > low.score);
    const trend = safety.riskReport(calm, {}, { postedToday: 5 }, { total: 80 }, { medianViews: 30, prevMedianViews: 100 }, T0);
    assert.ok(trend.factors.some((f) => f.id === "reach"));
    assert.equal(safety.riskReport(busy, {}, { postedToday: 200 }, { total: 0 }, {}, T0).hoursToLimit, 0);
    assert.equal(safety.activeHoursPerDay(sanitizeSettings({ safety: { activeHours: { enabled: true, start: "22:00", end: "06:00" } } })), 8);
    assert.equal(safety.activeHoursPerDay(sanitizeSettings({})), 24);
  });
});
