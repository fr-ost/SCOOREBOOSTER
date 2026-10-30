// Reply reach monitor: reachStats / reachVerdict (pure), checkReach (state, alert, actions, dismissal), the engagement
// check plan (early ~3 h looks, budget with conversation alerts) and learningStep storing views.
import { resetStorage, rawGet } from "./_chrome.mjs";
import { install } from "./_fake_xtab.mjs";
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useMemoryDb } from "../../extension/lib/db.js";
import * as H from "../../extension/lib/history.js";
import * as R from "../../extension/lib/reach.js";
import { checkPlan, learningStep } from "../../extension/lib/learning.js";
import { sanitizeSettings, save, patchState } from "../../extension/lib/store.js";
import { footprintAdd } from "../../extension/lib/tabs.js";
import { K, STOP } from "../../extension/lib/constants.js";
import { DAY, HOUR, MIN, _setClock } from "../../extension/lib/util.js";

const NOW = Date.UTC(2026, 9, 30, 8, 0);
let seq = 0;
// A posted reply `ageH` hours old whose views were read `readAfterH` hours after posting.
function rec({ ageH, views, readAfterH = 24, earlyViews, results = {}, ...extra }) {
  const postedAt = NOW - ageH * HOUR;
  const res = { ...results };
  if (views !== undefined) { res.views = views; res.viewsAt = postedAt + readAfterH * HOUR; res.checkedAt = res.viewsAt; }
  if (earlyViews !== undefined) { res.earlyViews = earlyViews; res.earlyAt = postedAt + 3 * HOUR; }
  seq++;
  return { id: "r" + seq, status: "posted", target: "t" + (seq % 7), postedAt, createdAt: postedAt - 5 * MIN, replyUrl: `https://x.com/0x_nation/status/9${seq}`, replyId: "9" + seq, comment: "c" + seq, results: res, ...extra };
}
// 30 recent replies with `nowViews` and 30 older ones with `beforeViews` (all read a day after posting).
const series = (nowViews, beforeViews) => [
  ...Array.from({ length: 30 }, (_, i) => rec({ ageH: 30 + i * 3, views: typeof nowViews === "function" ? nowViews(i) : nowViews })),
  ...Array.from({ length: 30 }, (_, i) => rec({ ageH: 130 + i * 3, views: beforeViews })),
];

describe("reachStats / reachVerdict", () => {
  const s = sanitizeSettings({});
  test("median of the last 30 day-after readings vs the 30 before, low-view share", () => {
    const st = R.reachStats(series(20, 200), s, NOW);
    assert.equal(st.checked, 30);
    assert.equal(st.prevChecked, 30);
    assert.equal(st.medianViews, 20);
    assert.equal(st.prevMedianViews, 200);
    assert.equal(st.dropPct, 90);
    assert.equal(st.lowShare, 0);
    const low = R.reachStats(series((i) => (i < 18 ? 4 : 50), 60), s, NOW);
    assert.equal(low.lowShare, 0.6);
    assert.equal(low.lowCount, 18);
  });
  test("only day-after readings count for the main comparison; early readings are compared separately", () => {
    const recs = [
      rec({ ageH: 10, views: 3, readAfterH: 3 }), // an early reading in `views`: never mixed with day-after readings
      rec({ ageH: 200, views: 9999, readAfterH: 150 }), // read 6 days after posting: excluded
      rec({ ageH: 40, views: 100, results: { gone: true } }),
      { ...rec({ ageH: 40, views: 100 }), status: "skipped" },
      rec({ ageH: 50, views: 80 }),
      rec({ ageH: 5, earlyViews: 12 }), rec({ ageH: 6, earlyViews: 40 }),
    ];
    const st = R.reachStats(recs, s, NOW);
    assert.equal(st.checked, 1);
    assert.equal(st.medianViews, 80);
    assert.equal(st.prevMedianViews, null);
    assert.equal(st.dropPct, null);
    assert.deepEqual([st.early.checked, st.early.medianViews], [2, 26]);
    assert.equal(R.median([]), null);
    assert.equal(R.median([5, 1, 3]), 3);
    assert.equal(R.median([4, 1, 3, 2]), 2.5);
  });
  test("verdict: a drop needs minChecked replies on both sides; a low share needs minChecked recent ones", () => {
    assert.equal(R.reachVerdict(R.reachStats(series(20, 200), s, NOW), s).trigger, "drop");
    assert.match(R.reachVerdict(R.reachStats(series(20, 200), s, NOW), s).message, /fell from 200 to 20 \(-90%\)/);
    assert.equal(R.reachVerdict(R.reachStats(series(120, 200), s, NOW), s), null, "a 40% dip is below the 60% threshold");
    assert.equal(R.reachVerdict(R.reachStats(series(20, 200).slice(0, 40), s, NOW), s), null, "10 older replies are not enough to compare");
    const lowSeries = () => series((i) => (i < 16 ? 8 : 30), 15); // median 8 vs 15: a 47% dip, but 53% under 10 views
    const low = R.reachVerdict(R.reachStats(lowSeries(), s, NOW), s);
    assert.equal(low.trigger, "low_share");
    assert.match(low.message, /53% of your last 30 checked replies have fewer than 10 views/);
    assert.equal(R.reachVerdict(R.reachStats(lowSeries().slice(0, 10), s, NOW), s), null);
    assert.equal(R.reachVerdict(R.reachStats(series((i) => (i < 18 ? 4 : 50), 60), s, NOW), s).trigger, "drop", "a drop is reported first");
    const early = [
      ...Array.from({ length: 16 }, (_, i) => rec({ ageH: 4 + i, earlyViews: 5 })),
      ...Array.from({ length: 30 }, (_, i) => rec({ ageH: 40 + i, earlyViews: 60 })),
    ];
    const ev = R.reachVerdict(R.reachStats(early, s, NOW), s);
    assert.equal(ev.trigger, "early_drop");
    assert.equal(ev.basis, "3h");
    assert.deepEqual([ev.checked, ev.medianNow, ev.medianBefore], [30, 5, 60], "the last 30 early looks (16 low ones) vs the 16 before");
  });
});

describe("checkReach", () => {
  let fx;
  before(() => { fx = install(); });
  after(() => fx.uninstall());
  beforeEach(() => { resetStorage(); useMemoryDb(); _setClock(() => NOW); fx.notifications.length = 0; });
  afterEach(() => _setClock(null));
  after(() => { resetStorage(); useMemoryDb(); }); // later test files start from clean storage / DB
  const putAll = async (recs) => { for (const r of recs) await H.put(r); };

  test("always refreshes state.reach; no alert without a condition", async () => {
    await putAll(series(150, 200));
    const r = await R.checkReach(sanitizeSettings({}), NOW);
    assert.equal(r.alert, null);
    const st = rawGet(K.state);
    assert.deepEqual([st.reach.checked, st.reach.medianViews, st.reach.prevMedianViews, st.reach.lowShare, st.reach.at], [30, 150, 200, 0, NOW]);
    assert.equal(st.reachAlert, null);
  });

  test("action review: alert + notification + Review mode; no second alert while one is active", async () => {
    await putAll(series(20, 200));
    await save({ [K.settings]: { mode: "auto" } });
    const r = await R.checkReach(sanitizeSettings({ mode: "auto" }), NOW);
    assert.ok(r.alert);
    const st = rawGet(K.state);
    assert.deepEqual(Object.keys(st.reachAlert).sort(), ["action", "at", "basis", "checked", "lowShare", "medianBefore", "medianNow", "message", "trigger"]);
    assert.deepEqual([st.reachAlert.medianNow, st.reachAlert.medianBefore, st.reachAlert.checked, st.reachAlert.action, st.reachAlert.at], [20, 200, 30, "review", NOW]);
    assert.equal(rawGet(K.settings).mode, "review", "switched to Review mode");
    assert.equal(fx.notifications.length, 1);
    assert.equal(fx.notifications[0].id, "sx-reach");
    assert.match(fx.notifications[0].message, /Review mode/);
    assert.match(fx.notifications[0].message, /Views are a proxy/);
    assert.match(JSON.stringify(rawGet(K.logs)), /Reply reach monitor/);
    const again = await R.checkReach(sanitizeSettings({}), NOW + HOUR);
    assert.equal(again.alert, null);
    assert.equal(rawGet(K.state).reachAlert.at, NOW, "the active alert is kept as it was");
    assert.equal(fx.notifications.length, 1);
  });

  test("dismissed within 24 h: no new alert; after 24 h it can alert again", async () => {
    await putAll(series(20, 200));
    await patchState({ reachAlert: null, reachDismissedAt: NOW - 2 * HOUR });
    assert.equal((await R.checkReach(sanitizeSettings({ safety: { reach: { action: "notify" } } }), NOW)).alert, null);
    await patchState({ reachDismissedAt: NOW - 25 * HOUR });
    assert.ok((await R.checkReach(sanitizeSettings({ safety: { reach: { action: "notify" } } }), NOW)).alert);
  });

  test("action stop returns a REACH_DROP stop for the engine; halve/notify change no settings; off never alerts", async () => {
    await putAll(series(20, 200));
    await save({ [K.settings]: { mode: "auto" } });
    const stop = await R.checkReach(sanitizeSettings({ safety: { reach: { action: "stop" } } }), NOW);
    assert.equal(stop.stop, STOP.REACH_DROP);
    assert.match(stop.detail, /fell from 200 to 20/);
    assert.deepEqual(fx.notifications.map((n) => n.id), ["sx-stop"], "notified under the engine's stop id (its stop notification replaces it)");
    await patchState({ reachAlert: null, reachDismissedAt: null });
    const halve = await R.checkReach(sanitizeSettings({ safety: { reach: { action: "halve" } } }), NOW);
    assert.equal(halve.alert.action, "halve");
    assert.equal(halve.stop, undefined);
    assert.equal(rawGet(K.settings).mode, "auto");
    await patchState({ reachAlert: null });
    assert.equal((await R.checkReach(sanitizeSettings({ safety: { reach: { enabled: false } } }), NOW)).alert, null);
    assert.equal(rawGet(K.state).reachAlert, null);
    assert.equal(rawGet(K.state).reach.checked, 30, "stats are still shown while the monitor is off");
  });
});

describe("engagement check plan", () => {
  const due = () => [
    rec({ ageH: 4 }), rec({ ageH: 5 }), rec({ ageH: 9 }), // early window is 3-8 h
    rec({ ageH: 26 }), rec({ ageH: 30 }), rec({ ageH: 40 }), // first looks
    rec({ ageH: 24 * 8 }), // too old for a first look
    rec({ ageH: 80, results: { checkedAt: NOW - 50 * HOUR, checks: 1 } }), // second look (72 h)
    rec({ ageH: 4, results: { earlyAt: NOW - HOUR } }), // early look done
    rec({ ageH: 30, results: { failures: 3 } }), rec({ ageH: 30, results: { nextCheckAt: NOW + HOUR } }), rec({ ageH: 30, results: { gone: true } }),
    { ...rec({ ageH: 30 }), replyId: "" },
  ];
  test("conversation alerts on (default): one slot fewer, no 72 h second look, 1 early look", () => {
    const p = checkPlan(due(), sanitizeSettings({}), NOW);
    assert.equal(p.max, 2);
    assert.deepEqual(p.early.map((r) => Math.round((NOW - r.postedAt) / HOUR)), [4]);
    assert.deepEqual(p.regular.map((r) => Math.round((NOW - r.postedAt) / HOUR)), [26], "newest due first");
  });
  test("conversation alerts off: full budget, the 72 h second look comes back", () => {
    const s = sanitizeSettings({ learning: { conversations: { enabled: false }, maxChecksPerRun: 6 } });
    const p = checkPlan(due(), s, NOW);
    assert.equal(p.max, 6);
    assert.equal(p.early.length, 2, "1-2 early looks per run");
    assert.deepEqual(p.regular.map((r) => Math.round((NOW - r.postedAt) / HOUR)), [26, 30, 40, 80]);
  });
  test("a reply is never both an early and a regular check in one run (short first-look setting)", () => {
    const s = sanitizeSettings({ learning: { engagementCheckAfterHours: 2, maxChecksPerRun: 6 } });
    const p = checkPlan([rec({ ageH: 5 })], s, NOW);
    assert.deepEqual([p.early.length, p.regular.length], [1, 0]);
  });
  test("reach monitor off: no early looks; a budget of 1 has no room for them either", () => {
    assert.equal(checkPlan(due(), sanitizeSettings({ safety: { reach: { enabled: false } } }), NOW).early.length, 0);
    const one = checkPlan(due(), sanitizeSettings({ learning: { maxChecksPerRun: 2 } }), NOW);
    assert.deepEqual([one.max, one.early.length, one.regular.length], [1, 0, 1]);
    assert.deepEqual(checkPlan(due(), sanitizeSettings({ learning: { maxChecksPerRun: 0 } }), NOW), { early: [], regular: [], max: 0 });
  });
});

describe("learningStep stores views (and early views) from the checks", () => {
  let fx, views;
  before(() => {
    fx = install({
      content: async (url, msg) => {
        if (msg.sx === "waitFor") return { ok: true, key: "tweet" };
        if (msg.sx === "replyStats") return { ok: true, likes: 3, replies: 1, reposts: 0, views: views[msg.replyId] ?? null, authorReplied: false };
        return { ok: true };
      },
    });
  });
  after(() => fx.uninstall());
  beforeEach(() => { resetStorage(); useMemoryDb(); _setClock(() => NOW); fx.navigations.length = 0; views = {}; });
  afterEach(() => _setClock(null));
  after(() => { resetStorage(); useMemoryDb(); }); // later test files start from clean storage / DB

  test("a day-after check keeps views/viewsAt; an early check keeps earlyViews and is not the engagement check", async () => {
    const day = rec({ ageH: 25 }), early = rec({ ageH: 4 }), noViews = rec({ ageH: 27, results: { views: 77, viewsAt: NOW - HOUR } });
    for (const r of [day, early, noViews]) await H.put(r);
    views = { [day.replyId]: 321, [early.replyId]: 45 };
    const s = sanitizeSettings({ learning: { maxChecksPerRun: 4 } }); // 3 with conversation alerts: 1 early + 2 regular
    const r = await learningStep({ tabId: 7, settings: s, me: "0x_nation" });
    assert.deepEqual(r, { did: "learning", visits: 3 });
    assert.deepEqual(fx.navigations, [early.replyUrl, day.replyUrl, noViews.replyUrl]);
    const d = (await H.get(day.id)).results;
    assert.deepEqual([d.views, d.viewsAt, d.checkedAt, d.checks, d.likes], [321, NOW, NOW, 1, 3]);
    const e = (await H.get(early.id)).results;
    assert.deepEqual([e.earlyViews, e.earlyAt, e.views, e.checkedAt], [45, NOW, 45, undefined]);
    const n = (await H.get(noViews.id)).results;
    assert.deepEqual([n.views, n.viewsAt], [77, NOW - HOUR], "an unreadable view count keeps the last reading");
    assert.ok(rawGet(K.state).reach, "state.reach refreshed after the checks");
  });

  test("a reach drop with the 'stop' action stops the engine through learningStep", async () => {
    for (const x of series(20, 200)) await H.put(x);
    const r = await learningStep({ tabId: 7, settings: sanitizeSettings({ safety: { reach: { action: "stop" } } }), me: "0x_nation" });
    assert.equal(r.stop, STOP.REACH_DROP);
    assert.ok(rawGet(K.state).reachAlert);
  });

  test("self-learning off: only the view checks for the reach monitor (no priorities); both off: nothing", async () => {
    const r1 = rec({ ageH: 25 });
    await H.put(r1);
    views = { [r1.replyId]: 88 };
    await save({ [K.targets]: { t1: { handle: "t1", tier: 2, enabled: true, priority: 42, rel: { followsYou: false }, stats: {} } } });
    const off = sanitizeSettings({ learning: { enabled: false } });
    assert.deepEqual(await learningStep({ tabId: 7, settings: off, me: "0x_nation" }), { did: "learning", visits: 1 });
    assert.equal((await H.get(r1.id)).results.views, 88);
    assert.equal(rawGet(K.targets).t1.priority, 42, "priorities are left alone");
    assert.ok(rawGet(K.state).reach);
    await patchState({ lastLearningAt: 0 });
    fx.navigations.length = 0;
    await H.put(rec({ ageH: 26 }));
    assert.equal(await learningStep({ tabId: 7, settings: sanitizeSettings({ learning: { enabled: false }, safety: { reach: { enabled: false } } }), me: "0x_nation" }), null);
    assert.deepEqual(fx.navigations, []);
    const p = checkPlan([rec({ ageH: 80, results: { checkedAt: NOW - 50 * HOUR, checks: 1 } })], sanitizeSettings({ learning: { enabled: false, conversations: { enabled: false } } }), NOW);
    assert.equal(p.regular.length, 0, "no late second look without learning");
  });

  test("X page-load budget reached: nothing loaded, not counted as a failed check", async () => {
    const r1 = rec({ ageH: 25 });
    await H.put(r1);
    await save({ [K.settings]: { safety: { maxPageLoads24h: 1 } } });
    await patchState({ footprint: footprintAdd(null, "watch", NOW) });
    const r = await learningStep({ tabId: 7, settings: sanitizeSettings({ safety: { maxPageLoads24h: 1 } }), me: "0x_nation" });
    assert.equal(r, null);
    assert.deepEqual(fx.navigations, []);
    const res = (await H.get(r1.id)).results;
    assert.equal(res.failures, undefined, "no failure / back-off recorded");
    assert.equal(res.checkedAt, undefined, "still due");
  });

  test("Pause/Stop before a check: no page visit", async () => {
    await H.put(rec({ ageH: 25 }));
    const r = await learningStep({ tabId: 7, settings: sanitizeSettings({}), me: "0x_nation", shouldStop: async () => true });
    assert.deepEqual(r, { did: "aborted" });
    assert.deepEqual(fx.navigations, []);
  });
});
