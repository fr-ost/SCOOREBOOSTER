// Regression tests for the follow-tracking / discovery / Sorsa findings FOL-1, FOL-3, FOL-6, FOL-7, FOL-8, FOL-9
// and the followers-scan part of XP-4 (Pause/Stop between scrolls).
import { resetStorage, rawGet } from "./_chrome.mjs";
import { install } from "./_fake_xtab.mjs";
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useMemoryDb } from "../../extension/lib/db.js";
import * as H from "../../extension/lib/history.js";
import * as F from "../../extension/lib/follow.js";
import * as T from "../../extension/lib/targets.js";
import { updatePriorities } from "../../extension/lib/learning.js";
import { botFlags, looksLikeBot } from "../../extension/lib/scores.js";
import { runDiscovery } from "../../extension/lib/discovery.js";
import { refreshScores, fetchScore } from "../../extension/lib/sorsa.js";
import { sanitizeSettings, getTargets, updateTargets, setSecrets, save, patchState } from "../../extension/lib/store.js";
import { footprintAdd } from "../../extension/lib/tabs.js";
import { K } from "../../extension/lib/constants.js";
import { DAY, HOUR, MIN, _setClock } from "../../extension/lib/util.js";

const NOW = Date.UTC(2026, 9, 30, 8, 0);
const settings = sanitizeSettings({});
const trusted = { followBadgeOkAt: NOW - HOUR, followersScanAt: NOW - 30 * MIN };
const map = (...ts) => Object.fromEntries(ts.map((x) => [x.handle, x]));

function target(handle, { follows, checkedAgo, addedAgo = HOUR, firstAgo, comments } = {}) {
  const t = T.newTarget(handle);
  t.addedAt = NOW - addedAgo;
  if (follows === true) T.applyFollow(t, true, NOW - 20 * DAY);
  if (follows === false) T.applyFollow(t, false, NOW - 20 * DAY);
  if (checkedAgo != null) t.rel.checkedAt = NOW - checkedAgo;
  if (firstAgo != null) t.stats.firstCommentAt = NOW - firstAgo;
  if (comments != null) t.stats.comments = comments;
  return t;
}

describe("FOL-1: a target added again does not inherit the old first-comment time", () => {
  beforeEach(() => { resetStorage(); useMemoryDb(); _setClock(() => NOW); });
  afterEach(() => _setClock(null));
  after(() => { resetStorage(); useMemoryDb(); }); // later test files start from clean storage / DB

  test("updatePriorities only back-fills firstCommentAt from comments made after the target was (re-)added", async () => {
    for (const d of [30, 25, 20]) await H.put(H.newRecord({ status: "posted", target: "bob", group: "B", tier: 2, postedAt: NOW - d * DAY, createdAt: NOW - d * DAY, comment: "x" + d }));
    const bob = target("bob", { follows: false, addedAgo: 10 * MIN });
    await save({ [K.targets]: map(bob) });
    await updatePriorities(settings, NOW);
    const t = (await getTargets()).bob;
    assert.equal(t.stats.firstCommentAt, null, "comments from before the target was added again do not start the 14-day window");
    assert.equal(F.giveUpDue(t, settings, NOW), false);
    assert.deepEqual(F.followPlan(await getTargets(), settings, trusted, NOW).profiles.filter((p) => p.why === "give_up"), []);
    // A comment in the current life starts the window as before.
    await H.put(H.newRecord({ status: "posted", target: "bob", group: "B", tier: 2, postedAt: NOW - 5 * MIN, createdAt: NOW - 6 * MIN, comment: "new" }));
    await updatePriorities(settings, NOW);
    assert.equal((await getTargets()).bob.stats.firstCommentAt, NOW - 5 * MIN);
  });

  test("history from before the target was added still counts for the no-response streak (cooldown)", async () => {
    const s = sanitizeSettings({ learning: { coldAfterComments: 3 } });
    for (const i of [0, 1, 2]) await H.put(H.newRecord({ status: "posted", target: "quiet", group: "B", tier: 2, postedAt: NOW - 3 * DAY + i * HOUR, createdAt: NOW - 3 * DAY + i * HOUR, comment: "c" + i, results: { likes: 0, replies: 0, checkedAt: NOW - HOUR, checks: 2 } }));
    await save({ [K.targets]: map(target("quiet", { follows: false, addedAgo: MIN })) });
    await updatePriorities(s, NOW);
    const q = (await getTargets()).quiet;
    assert.ok(q.coldUntil > NOW, "cools down");
    assert.equal(q.stats.firstCommentAt, null);
  });
});

describe("FOL-3: 'not found' is cleared when the account is back", () => {
  beforeEach(() => { resetStorage(); _setClock(() => NOW); });
  afterEach(() => _setClock(null));
  after(() => { resetStorage(); useMemoryDb(); }); // later test files start from clean storage / DB

  const goneTarget = () => {
    const t = target("carol", { follows: false, firstAgo: 20 * DAY, comments: 6 });
    t.rel = { ...t.rel, gone: true, checkedAt: NOW - 10 * DAY };
    t.enabled = false;
    return t;
  };

  test("turning the target on again (targetPatch / bulk) clears rel.gone", async () => {
    await save({ [K.targets]: map(goneTarget(), { ...goneTarget(), handle: "dave" }) });
    const t = await T.patch("carol", { enabled: true });
    assert.equal(t.enabled, true);
    assert.ok(!t.rel.gone, "re-enabled target is no longer 'not found'");
    await T.bulk(["dave"], { enabled: true });
    assert.ok(!(await getTargets()).dave.rel.gone);
    // Turning it off keeps the flag.
    await save({ [K.targets]: map(goneTarget()) });
    await T.patch("carol", { notes: "x" });
    assert.equal((await getTargets()).carol.rel.gone, true);
  });

  test("a profile that reads fine clears rel.gone, and follow tracking includes the target again", () => {
    const t = goneTarget();
    t.enabled = true; // re-enabled before this fix (or restored from a backup)
    let plan = F.followPlan({ carol: t }, settings, trusted, NOW);
    assert.deepEqual(plan.profiles.map((p) => p.why), ["give_up"], "an enabled target is tracked even with an old 'gone' flag");
    T.applyProfile(t, { handle: "carol", name: "Carol", followers: 5000, following: 300, followsYou: false, youFollow: false }, []);
    assert.ok(!t.rel.gone);
    plan = F.followPlan({ carol: t }, settings, trusted, NOW);
    assert.equal(plan.counts.active, 1);
  });
});

describe("FOL-6: an unreadable follower count is unknown, not zero", () => {
  test("followers: null creates no audience flags", () => {
    const p = { handle: "builder", followers: null, following: 2600, bio: "building" };
    assert.deepEqual(botFlags(p), []);
    assert.equal(looksLikeBot(botFlags(p)), false);
    assert.deepEqual(botFlags({ handle: "x", followers: 100, following: null }), [], "unknown following: no follows_many");
    assert.deepEqual(botFlags({ handle: "x", followers: "", following: 2600 }), []);
    assert.deepEqual(botFlags({ handle: "x", followers: 100, following: 2500 }), ["follows_many"], "real counts still flag");
    assert.deepEqual(botFlags({ handle: "x", followers: 0, following: 10 }), ["tiny_audience"], "0 followers is a real count");
  });
});

describe("FOL-7: discovery does not spend profile visits on accounts that already follow you", () => {
  let fx;
  before(() => {
    fx = install({
      content: async (url, msg) => {
        if (msg.sx === "scrapeUsers") return { ok: true, users: [{ handle: "fan", name: "Fan", verified: true, followsYou: true }, { handle: "stranger", name: "Stranger", verified: false }] };
        if (msg.sx === "scroll") return { ok: true, atBottom: true };
        if (msg.sx === "scrapeProfile") { const h = new URL(url).pathname.slice(1); return { ok: true, profile: { handle: h, name: h, followers: 20000, following: 900, joinedAt: NOW - 900 * DAY }, tweets: [] }; }
        return { ok: true };
      },
    });
  });
  after(() => fx.uninstall());
  beforeEach(() => { resetStorage(); _setClock(() => NOW); });
  afterEach(() => _setClock(null));
  after(() => { resetStorage(); useMemoryDb(); }); // later test files start from clean storage / DB

  test("followers of a big account: the 'Follows you' cell is skipped, the next candidate is scored", async () => {
    await save({ [K.settings]: { discovery: { enrichMax: 1, minFollowers: 0 } } });
    await patchState({ workerTabId: 7 });
    const r = await runDiscovery({ source: "followersOf", handles: ["big"], enrich: true }, async () => {});
    assert.equal(r.ok, true);
    const profileVisits = fx.navigations.filter((u) => /^https:\/\/x\.com\/[a-z_]+$/.test(u));
    assert.deepEqual(profileVisits, ["https://x.com/stranger"], "only the account that does not follow you is visited");
    const c = rawGet(K.candidates);
    assert.ok(c.stranger.score && c.stranger.score.own > 0, "the usable candidate got a score");
    assert.equal(c.fan.pass, false, "an account that follows you is never a usable candidate");
  });
});

describe("FOL-8: Sorsa refresh backs off on errors and reports failure", () => {
  let fx, realFetch, calls;
  before(() => {
    fx = install();
    realFetch = globalThis.fetch;
    globalThis.chrome.permissions = { contains: async () => true };
  });
  after(() => { fx.uninstall(); globalThis.fetch = realFetch; delete globalThis.chrome.permissions; });
  beforeEach(async () => {
    resetStorage();
    useMemoryDb();
    calls = 0;
    await save({ [K.settings]: { providers: { sorsa: { enabled: true } } } });
    await setSecrets({ sorsaKey: "sorsa-key-123456" });
    const targets = {};
    for (let i = 0; i < 30; i++) targets["t" + i] = T.newTarget("t" + i);
    await save({ [K.targets]: targets });
  });

  test("an outage stops after a few failures in a row and is reported as a failure", async () => {
    globalThis.fetch = async () => { calls++; return { ok: false, status: 502, json: async () => ({ message: "Bad gateway" }) }; };
    const r = await refreshScores([]);
    assert.equal(r.ok, false, "nothing updated: not a success");
    assert.match(r.error, /502|Bad gateway/);
    assert.equal(r.updated, 0);
    assert.ok(r.failed >= 1);
    assert.ok(calls <= 5, "stops instead of sending a request for every target: " + calls);
  });

  test("some failures among successes still report the updates", async () => {
    globalThis.fetch = async (url) => { calls++; const bad = /t1\b|t1$/.test(url); return bad ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ score: 120 }) }; };
    const r = await refreshScores(["t0", "t1", "t2"]);
    assert.equal(r.ok, true);
    assert.equal(r.updated, 2);
    assert.equal(r.failed, 1);
  });

  test("a non-numeric score is stored as null, not NaN", async () => {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ score: "n/a" }) });
    const s = await fetchScore("x", "k");
    assert.equal(s.ok, true);
    assert.equal(s.score, null);
  });
});

describe("FOL-9: accounts that follow you are re-checked now and then", () => {
  let fx, profileFollows;
  before(() => {
    fx = install({
      content: async (url, msg) => {
        if (msg.sx === "scrapeProfile") { const h = new URL(url).pathname.slice(1); return { ok: true, profile: { handle: h, name: h, followers: 9000, following: 700, followsYou: !!profileFollows[h], youFollow: false }, tweets: [] }; }
        return { ok: true };
      },
    });
  });
  after(() => fx.uninstall());
  beforeEach(() => { resetStorage(); useMemoryDb(); _setClock(() => NOW); profileFollows = {}; fx.navigations.length = 0; });
  afterEach(() => _setClock(null));
  after(() => { resetStorage(); useMemoryDb(); }); // later test files start from clean storage / DB

  test("followPlan: followers whose last check is old get a low-priority 'verify' visit (not counted as profiles)", () => {
    const fan = target("fan", { follows: true, checkedAgo: 11 * DAY });
    const fresh = target("fresh", { follows: true, checkedAgo: 2 * DAY });
    const miss = target("miss", { follows: true, checkedAgo: 25 * HOUR });
    miss.rel.notFollowingSeen = 1; // the badge was missing once: confirm it the next day
    const off = target("off", { follows: true, checkedAgo: 30 * DAY });
    off.enabled = false;
    const plan = F.followPlan(map(fan, fresh, miss, off), settings, trusted, NOW);
    assert.deepEqual(plan.profiles, []);
    assert.deepEqual(plan.verify.map((p) => p.handle).sort(), ["fan", "miss"]);
    assert.ok(plan.verify.every((p) => p.why === "verify"));
  });

  test("an account that unfollowed you is treated as not following after two checks, with a fresh 14-day window", async () => {
    const fb = target("fb", { follows: false, firstAgo: 20 * DAY, comments: 4 });
    T.applyFollow(fb, true, NOW - 15 * DAY); // followed back
    fb.rel.checkedAt = NOW - 11 * DAY;
    await save({ [K.targets]: map(fb) });
    await patchState(trusted);
    let r = await F.followStep({ tabId: 7, settings, me: "0x_nation" });
    assert.equal(r.did, "follow");
    assert.deepEqual(fx.navigations, ["https://x.com/fb"]);
    let t = (await getTargets()).fb;
    assert.equal(T.followStatus(t), T.FS.FOLLOWED_BACK, "one missing badge does not downgrade");
    assert.equal(t.rel.notFollowingSeen, 1);
    _setClock(() => NOW + 25 * HOUR);
    await patchState({ followBadgeOkAt: NOW + 24 * HOUR, followersScanAt: NOW + 24 * HOUR });
    r = await F.followStep({ tabId: 7, settings, me: "0x_nation" });
    t = (await getTargets()).fb;
    assert.equal(T.followStatus(t), T.FS.ACTIVE, "second miss: not following any more -> comments allowed again");
    assert.equal(t.stats.firstCommentAt, null, "the give-up window starts again with the next comment");
    assert.equal(F.giveUpDue(t, settings, NOW + 25 * HOUR), false, "not removed right away");
    assert.equal(t.rel.unfollowedYouAt, NOW + 25 * HOUR);
  });

  test("X page-load budget reached: no scan or profile visit, nothing postponed or logged as a failure", async () => {
    await save({ [K.settings]: { safety: { maxPageLoads24h: 1 } } });
    await save({ [K.targets]: map(target("n1", { addedAgo: MIN })) });
    await patchState({ footprint: footprintAdd(null, "watch", NOW) });
    assert.equal(await F.followStep({ tabId: 7, settings, me: "0x_nation" }), null, "followers scan blocked");
    let st = rawGet(K.state);
    assert.ok(!st.followersScanRetryAt && !st.followersScanAt);
    await patchState(trusted);
    assert.equal(await F.followStep({ tabId: 7, settings, me: "0x_nation" }), null, "profile check blocked");
    assert.equal((await getTargets()).n1.rel.followCheckAfter, undefined, "the check is not postponed");
    assert.deepEqual(fx.navigations, []);
    assert.doesNotMatch(JSON.stringify(rawGet(K.logs) || []), /could not read/);
  });

  test("verify visits only use what is left of the per-run budget and only while the badge is trusted", async () => {
    const s = sanitizeSettings({ follow: { checksPerRun: 2 } });
    const targets = map(target("n1", { addedAgo: 50 * MIN }), target("n2", { addedAgo: 40 * MIN }), target("fan", { follows: true, checkedAgo: 12 * DAY }));
    await save({ [K.targets]: targets });
    await patchState(trusted);
    await F.followStep({ tabId: 7, settings: s, me: "0x_nation" });
    assert.deepEqual(fx.navigations, ["https://x.com/n1", "https://x.com/n2"], "new targets first, no verify visit beyond the budget");
    fx.navigations.length = 0;
    await save({ [K.targets]: map(target("fan", { follows: true, checkedAgo: 12 * DAY })) });
    await patchState({ followBadgeOkAt: NOW - 4 * DAY, followersScanAt: NOW - 30 * MIN });
    await F.followStep({ tabId: 7, settings: s, me: "0x_nation" });
    assert.deepEqual(fx.navigations, [], "no profile visits while the badge is not trusted");
  });
});

describe("XP-4: the followers scan honours Pause/Stop between scrolls", () => {
  let fx, stop, scrapes;
  before(() => {
    fx = install({
      content: async (url, msg) => {
        if (msg.sx === "scrapeUsers") { scrapes++; stop = true; return { ok: true, users: Array.from({ length: 20 }, (_, i) => ({ handle: `u${scrapes}_${i}`, followsYou: true })) }; }
        if (msg.sx === "scroll") return { ok: true };
        return { ok: true };
      },
    });
  });
  after(() => fx.uninstall());
  beforeEach(() => { resetStorage(); _setClock(() => NOW); stop = false; scrapes = 0; fx.commands.length = 0; });
  afterEach(() => _setClock(null));
  after(() => { resetStorage(); useMemoryDb(); }); // later test files start from clean storage / DB

  test("Stop pressed during a deep scan: no more scrolling, scraping or page visits", async () => {
    await save({ [K.targets]: map(target("new1", { addedAgo: MIN }), target("new2", { addedAgo: 2 * MIN })) });
    const r = await F.followStep({ tabId: 7, settings, me: "0x_nation", shouldStop: async () => stop });
    assert.equal(r.did, "aborted");
    assert.equal(scrapes, 1);
    const after1 = fx.commands.slice(fx.commands.findIndex((c) => c[0] === "scrapeUsers") + 1);
    assert.deepEqual(after1.filter((c) => ["scroll", "scrapeUsers", "scrapeProfile"].includes(c[0])), []);
    assert.equal(fx.navigations.filter((u) => !/followers$/.test(u)).length, 0, "no profile visits after Stop");
    const st = rawGet(K.state);
    assert.ok(!st.followersScanAt, "an aborted scan is not recorded as a completed one");
  });
});
