// Regression tests for the round-2 follow-tracking / learning findings FOL2-1 .. FOL2-6.
import { resetStorage } from "./_chrome.mjs";
import { install } from "./_fake_xtab.mjs";
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useMemoryDb } from "../../extension/lib/db.js";
import * as H from "../../extension/lib/history.js";
import * as R from "../../extension/lib/reach.js";
import * as F from "../../extension/lib/follow.js";
import * as T from "../../extension/lib/targets.js";
import * as C from "../../extension/lib/conversations.js";
import { checkPlan, learningStep, processFollowBacks } from "../../extension/lib/learning.js";
import { candidatesToTargets } from "../../extension/lib/discovery.js";
import { valueDetails } from "../../extension/lib/scores.js";
import { sanitizeSettings, save, patchState, getState, getTargets, updateTargets } from "../../extension/lib/store.js";
import { K } from "../../extension/lib/constants.js";
import { DAY, HOUR, MIN, _setClock } from "../../extension/lib/util.js";

const NOW = Date.UTC(2026, 9, 30, 8, 0);
let seq = 0;
// A posted reply `ageH` hours old; `views` read `readAfterH` hours after posting by its first engagement check.
function reply(ageH, views, readAfterH = 24) {
  const postedAt = NOW - ageH * HOUR;
  seq++;
  const results = views === undefined ? {} : { views, viewsAt: postedAt + readAfterH * HOUR, dayViews: views, dayViewsAt: postedAt + readAfterH * HOUR, checkedAt: postedAt + readAfterH * HOUR, checks: 1 };
  return { id: "f2r" + seq, status: "posted", target: "t" + (seq % 9), postedAt, createdAt: postedAt - 5 * MIN, replyUrl: "https://x.com/0x_nation/status/8" + seq, replyId: "8" + seq, comment: "c" + seq, results };
}

describe("FOL2-1: 'Judge after (checked replies)' above 30 still lets the reach monitor alert", () => {
  const s = sanitizeSettings({ safety: { reach: { minChecked: 40, action: "notify" } } });
  let fx;
  before(() => { fx = install(); });
  after(() => { fx.uninstall(); resetStorage(); useMemoryDb(); });
  beforeEach(() => { resetStorage(); useMemoryDb(); _setClock(() => NOW); });
  afterEach(() => _setClock(null));

  test("minChecked 40: 100 checked replies all under 10 views -> low-share alert", async () => {
    assert.equal(s.safety.reach.minChecked, 40);
    for (let i = 0; i < 100; i++) await H.put(reply(26 + i, 2));
    const res = await R.checkReach(s, NOW);
    assert.equal(res.stats.checked, 40, "the window holds minChecked readings");
    assert.equal(res.alert && res.alert.trigger, "low_share");
    assert.ok((await getState()).reachAlert);
  });

  test("minChecked 40: median of the last 40 fell 99% vs the 40 before -> drop alert", async () => {
    for (let i = 0; i < 40; i++) await H.put(reply(26 + i, 3));
    for (let i = 0; i < 80; i++) await H.put(reply(70 + i, 300));
    const res = await R.checkReach(s, NOW);
    assert.deepEqual([res.stats.checked, res.stats.prevChecked, res.alert && res.alert.trigger], [40, 40, "drop"]);
  });

  test("the default (15) keeps the 30-reading windows", () => {
    const st = R.reachStats(Array.from({ length: 100 }, (_, i) => reply(26 + i, 50)), sanitizeSettings({}), NOW);
    assert.deepEqual([st.checked, st.prevChecked, st.totalChecked], [30, 30, 100]);
  });
});

describe("FOL2-2: allowed engagement-check settings never switch the checks off", () => {
  const due = (n, ageH) => Array.from({ length: n }, (_, i) => reply(ageH(i)));

  test("check delay 200 h (UI allows up to 720): replies 200-248 h old are due for their first look", () => {
    const s = sanitizeSettings({ learning: { engagementCheckAfterHours: 200, conversations: { enabled: false } } });
    const plan = checkPlan(due(241, (h) => h), s, NOW);
    assert.ok(plan.regular.length > 0, "a reply is checked");
    assert.ok(plan.regular.every((r) => NOW - r.postedAt >= 200 * HOUR && NOW - r.postedAt <= 248 * HOUR));
  });

  test("check delay 12 h: the first looks are the reach monitor's readings", () => {
    const s = sanitizeSettings({ learning: { engagementCheckAfterHours: 12 } });
    const st = R.reachStats(Array.from({ length: 40 }, (_, i) => reply(14 + i, 4, 13)), s, NOW);
    assert.equal(st.totalChecked, 40);
    assert.equal(R.reachVerdict(st, s).trigger, "low_share");
    const def = R.reachStats(Array.from({ length: 40 }, (_, i) => reply(14 + i, 4, 13)), sanitizeSettings({}), NOW);
    assert.equal(def.totalChecked, 0, "with the default 24 h delay a 13 h reading is still not a day-after reading");
  });

  describe("check delay 12 h end to end: checks run, the reach monitor gets their readings", () => {
    let fx;
    before(() => { fx = install({ content: async (url, msg) => (msg.sx === "replyStats" ? { ok: true, likes: 1, replies: 0, views: 4, authorReplied: false } : { ok: true }) }); });
    after(() => { fx.uninstall(); resetStorage(); useMemoryDb(); });
    afterEach(() => _setClock(null));
    test("40 replies checked at ~13 h -> 40 readings", async () => {
      resetStorage(); useMemoryDb();
      const s = sanitizeSettings({ learning: { engagementCheckAfterHours: 12, maxChecksPerRun: 10, conversations: { enabled: false } } });
      for (let i = 0; i < 40; i++) { const r = reply(13, undefined); r.postedAt -= i * MIN; await H.put(r); }
      for (let run = 0; run < 5; run++) {
        _setClock(() => NOW + run * 31 * MIN);
        await patchState({ lastLearningAt: null });
        await learningStep({ tabId: 7, settings: s, me: "0x_nation" });
      }
      const all = await H.all();
      assert.equal(all.filter((r) => r.results && r.results.dayViews === 4).length, 40);
      assert.equal(R.reachStats(all, s, NOW + 3 * HOUR).totalChecked, 40);
    });
  });

  test("'Max checks per run' 1 with conversation alerts on: one engagement check per run (0 still means none)", () => {
    const s = sanitizeSettings({ learning: { maxChecksPerRun: 1 } });
    assert.equal(s.learning.conversations.enabled, true);
    const plan = checkPlan(due(50, (i) => 25 + i), s, NOW);
    assert.deepEqual([plan.max, plan.early.length + plan.regular.length], [1, 1]);
    assert.equal(checkPlan(due(5, (i) => 25 + i), sanitizeSettings({ learning: { maxChecksPerRun: 0 } }), NOW).max, 0);
    assert.equal(checkPlan(due(5, (i) => 25 + i), sanitizeSettings({}), NOW).max, 2, "the default keeps one slot for the mentions page");
  });
});

describe("FOL2-3: a follow-back after an unfollow is notified and credited again", () => {
  const settings = sanitizeSettings({});
  let fx;
  before(() => { fx = install({}); });
  after(() => { fx.uninstall(); resetStorage(); useMemoryDb(); });
  beforeEach(() => { resetStorage(); useMemoryDb(); fx.notifications.length = 0; });
  afterEach(() => _setClock(null));
  const posted = (id, target, postedAt) => H.newRecord({ id, status: "posted", target, group: "B", tier: 2, postedAt, createdAt: postedAt - 60000, comment: "c-" + id, replyUrl: "https://x.com/0x_nation/status/" + id, replyId: id });
  const at = (ts, fn) => { _setClock(() => ts); return fn(); };

  test("follow-back, unfollow (two misses), comments, follow-back again", async () => {
    const t = T.newTarget("bob");
    t.addedAt = NOW - 40 * DAY;
    T.applyFollow(t, false, NOW - 40 * DAY);
    await save({ [K.targets]: { bob: t } });
    await H.put(posted("1001", "bob", NOW - 39 * DAY));
    await at(NOW - 37 * DAY, () => updateTargets((all) => { T.applyFollow(all.bob, true, NOW - 37 * DAY); return all; }));
    await at(NOW - 37 * DAY, () => processFollowBacks(settings));
    assert.equal(fx.notifications.filter((n) => n.title === "New follow-back").length, 1);

    await at(NOW - 20 * DAY, () => updateTargets((all) => { T.applyFollow(all.bob, false, NOW - 20 * DAY); T.applyFollow(all.bob, false, NOW - 19 * DAY); return all; }));
    let cur = (await getTargets()).bob;
    assert.equal(T.followStatus(cur), T.FS.ACTIVE, "treated as not following again");
    assert.deepEqual([cur.rel.followedBackAt, cur.rel.prevFollowedBackAt, cur.rel.followBackCredited], [null, NOW - 37 * DAY, false]);
    await H.put(posted("2001", "bob", NOW - 5 * DAY));
    await H.put(posted("2002", "bob", NOW - 2 * DAY));

    await at(NOW, () => updateTargets((all) => { T.applyFollow(all.bob, true, NOW); return all; }));
    await at(NOW, () => processFollowBacks(settings));
    cur = (await getTargets()).bob;
    const credited = (await H.byTarget("bob")).filter((r) => r.results && r.results.followedBack).map((r) => r.id).sort();
    assert.equal(T.followStatus(cur), T.FS.FOLLOWED_BACK);
    assert.deepEqual({ notifications: fx.notifications.filter((n) => n.title === "New follow-back").length, credited, followedBackAt: cur.rel.followedBackAt, credit: cur.rel.followBackCredited },
      { notifications: 2, credited: ["1001", "2001", "2002"], followedBackAt: NOW, credit: true });
  });
});

describe("FOL2-4: verify visits keep running when only accounts that follow you are left", () => {
  const settings = sanitizeSettings({});
  let fx;
  before(() => {
    fx = install({
      content: async (url, msg) => {
        if (msg.sx === "scrapeUsers") return { ok: true, users: ["fan1", "fan2", "fan3"].map((h) => ({ handle: h, followsYou: true, badge: true })) };
        if (msg.sx === "scrapeProfile") { const h = new URL(url).pathname.slice(1); return { ok: true, profile: { handle: h, name: h, followers: 5000, following: 800, followsYou: h !== "ex", youFollow: false }, tweets: [] }; }
        return { ok: true };
      },
    });
  });
  after(() => { fx.uninstall(); resetStorage(); useMemoryDb(); });
  afterEach(() => _setClock(null));
  const mk = (h) => { const t = T.newTarget(h); t.addedAt = NOW - 60 * DAY; T.applyFollow(t, true, NOW - 30 * DAY); return t; };

  test("lapsed badge trust: the followers scan renews it, and @ex (unfollowed) is found after two checks", async () => {
    resetStorage(); useMemoryDb();
    await save({ [K.targets]: { fan1: mk("fan1"), fan2: mk("fan2"), ex: mk("ex") } });
    await patchState({ followBadgeOkAt: NOW - 4 * DAY, followersScanAt: NOW - 4 * DAY });
    for (let h = 0; h < 3 * 24; h++) {
      _setClock(() => NOW + h * HOUR);
      await F.followStep({ tabId: 7, settings, me: "0x_nation" });
    }
    assert.equal(fx.navigations[0], "https://x.com/0x_nation/followers", "the scan comes first");
    const ex = (await getTargets()).ex;
    assert.equal(T.followStatus(ex), T.FS.ACTIVE, "@ex unfollowed you: Not following again");
  });

  test("nobody unfollowed: 14 days cost one scan + verify visit per 10-day round", async () => {
    resetStorage(); useMemoryDb();
    fx.navigations.length = 0;
    await save({ [K.targets]: { fan1: mk("fan1"), fan2: mk("fan2"), fan4: mk("fan4") } });
    await patchState({ followBadgeOkAt: NOW - 4 * DAY, followersScanAt: NOW - 4 * DAY });
    for (let h = 0; h < 14 * 24; h++) {
      _setClock(() => NOW + h * HOUR);
      await F.followStep({ tabId: 7, settings, me: "0x_nation" });
    }
    const scans = fx.navigations.filter((u) => u.endsWith("/followers")).length;
    assert.deepEqual([scans, fx.navigations.length - scans], [2, 2], "fan1/fan2 are re-confirmed by the scan, fan4 by its profile");
    assert.ok(Object.values(await getTargets()).every((t) => T.followStatus(t) === T.FS.FOLLOWS));
  });

  test("the plan: a verify-driven scan needs lapsed trust and the routine interval", () => {
    const targets = { fan: mk("fan") };
    assert.equal(F.followPlan(targets, settings, { followBadgeOkAt: NOW - 4 * DAY, followersScanAt: NOW - 4 * DAY }, NOW).scan, true);
    assert.equal(F.followPlan(targets, settings, { followBadgeOkAt: NOW - 4 * DAY, followersScanAt: NOW - 30 * MIN }, NOW).scan, false, "scanned recently");
    assert.equal(F.followPlan(targets, settings, { followBadgeOkAt: NOW - HOUR, followersScanAt: NOW - 4 * DAY }, NOW).scan, false, "trusted: verify visits need no scan");
    const fresh = mk("fresh"); fresh.rel.checkedAt = NOW - DAY;
    assert.equal(F.followPlan({ fresh }, settings, { followBadgeOkAt: NOW - 4 * DAY, followersScanAt: NOW - 4 * DAY }, NOW).scan, false, "nothing due");
  });
});

describe("FOL2-5: smart-follower candidates keep their score-site scores as targets", () => {
  beforeEach(() => resetStorage());
  after(() => resetStorage());

  test("Add as Tier 2 carries providerScores into target.score.providers (value ranking uses them)", async () => {
    await save({ [K.candidates]: { whale: { handle: "whale", name: "Whale", followers: 120000, sources: ["smart follower of @cobie"], overlap: 2,
      providerScores: { sorsa: 1800, twitterscore: 640 }, foundAt: NOW - DAY, seenAt: NOW - HOUR, suggestedTier: 1, smart: true, pass: null, why: [] } } });
    const r = await candidatesToTargets(["whale"], 2, T.upsert);
    assert.equal(r.added, 1);
    const t = (await getTargets()).whale;
    assert.deepEqual(t.score.providers, { sorsa: { score: 1800, max: null, at: NOW - HOUR }, twitterscore: { score: 640, max: null, at: NOW - HOUR } });
    assert.equal(t.score.sorsa, 1800);
    const vd = valueDetails(t, null);
    assert.equal(vd.source, "providers");
    assert.ok(vd.value > 0);
  });
});

describe("FOL2-6: a target's post that only mentions you is not an answer to your reply", () => {
  const recs = [{ id: "a1", status: "posted", target: "alice", postedAt: NOW - 5 * HOUR, createdAt: NOW - 5 * HOUR - MIN, comment: "my reply", replyUrl: "https://x.com/0x_nation/status/19", replyId: "19", results: {} }];
  const tw = (id, extra) => ({ id, author: "alice", url: "https://x.com/alice/status/" + id, text: "thanks to @0x_nation", createdAt: NOW - HOUR, isRepost: false, isQuote: false, ...extra });

  test("isReply false is skipped; a reply (or an unknown isReply) still matches", () => {
    const m = (tweets) => C.matchMentions(tweets, recs, { me: "0x_nation", ts: NOW }).map((x) => `${x.tweet.id}->${x.rec.id}`);
    assert.deepEqual(m([tw("t9", { isReply: false })]), []);
    assert.deepEqual(m([tw("t10", { isReply: true })]), ["t10->a1"]);
    assert.deepEqual(m([tw("t11", {})]), ["t11->a1"]);
  });
});
