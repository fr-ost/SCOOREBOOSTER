// Watch checks and profile refreshes (lib/watcher.js) against a scripted fake X tab: Pause/Stop end a check at
// the next page step (XP-4), a missing X List is reported and skipped instead of silently watching nothing (XP-5),
// and a "does not follow you" profile reading only counts while the "Follows you" badge is trusted (ENG-1/FOL-2).
import "./_chrome.mjs";
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetStorage } from "./_chrome.mjs";
import { fakeTab, fast, okPage } from "./_xtab.mjs";
import { watchOnce, refreshProfile, planSource, DEAD_LIST_RETRY_MS, trustedFollowReading } from "../../extension/lib/watcher.js";
import { sanitizeSettings, saveSettings, getState, patchState, getTargets, updateTargets, load } from "../../extension/lib/store.js";
import { newTarget, followStatus, FS } from "../../extension/lib/targets.js";
import { K, STATUS } from "../../extension/lib/constants.js";

const LIST = "https://x.com/i/lists/1234567890";
const active = (h) => { const t = newTarget(h); t.rel.followsYou = false; t.rel.checkedAt = Date.now(); t.group = "B"; return t; };
const profile = (h, followsYou) => ({ handle: h, userId: "1", name: h.toUpperCase(), bio: "", followers: 1000, following: 10, verified: false, protected: false, followsYou, youFollow: false, followPending: false, defaultAvatar: false, avatar: "", joinedAt: null, location: "" });
const go = async () => ({ shouldStop: async () => false });

async function seed(targets) {
  await updateTargets(() => Object.fromEntries(targets.map((t) => [t.handle, t])));
}

describe("watcher: a missing X List (XP-5)", () => {
  beforeEach(() => resetStorage());

  test("not found is reported, the list is skipped and batched search covers the targets meanwhile", async (t) => {
    fast(t);
    const s = sanitizeSettings({ watch: { strategy: "list", listUrls: [LIST], scrolls: 0 } });
    await seed([active("bob"), active("amy")]);
    const env = fakeTab({
      waitFor: (m, tab) => (tab.url.includes("/i/lists/")
        ? { ok: false, settled: "not_found", page: okPage("0x_nation", { state: "not_found", detail: "Hmm...this page doesn't exist. Try searching for something else." }) }
        : { ok: true, key: "tweet" }),
      scrapeTweets: () => ({ ok: true, tweets: [], articleCount: 0, unparsed: 0, emptyState: false }),
    });
    const w = await watchOnce(env.tab.id, s, await getTargets(), Date.now(), await go());
    assert.equal(w.ok, false, "a dead list must not look like 'no new posts'");
    assert.equal(w.soft, "list_not_found");
    const st = await getState();
    assert.ok(st.deadLists && st.deadLists[LIST], "the list is remembered as missing");
    const logs = await load(K.logs, []);
    assert.ok(logs.some((l) => /X List not found/.test(l.msg) && /Settings > Watch/.test(l.msg)), "the user is told what to fix");

    const w2 = await watchOnce(env.tab.id, s, await getTargets(), Date.now(), await go());
    assert.equal(w2.ok, true);
    const navs = env.calls.filter((c) => c.cmd === "navigate").map((c) => c.url);
    assert.match(navs[navs.length - 1], /^https:\/\/x\.com\/search\?q=/, "next check uses the batched search");
    assert.equal(navs.filter((u) => u === LIST).length, 1, "the dead list is not reloaded on every check");

    const later = planSource(s, Object.values(await getTargets()), 0, Date.now() + DEAD_LIST_RETRY_MS + 1000, st.deadLists);
    assert.equal(later.kind, "list", "the list is tried again later");
  });

  test("with two lists only the missing one is skipped", () => {
    const s = sanitizeSettings({ watch: { strategy: "list", listUrls: [LIST, "https://x.com/i/lists/2222222222"] } });
    const ts = Date.now();
    for (let c = 0; c < 4; c++) {
      const p = planSource(s, [active("bob")], c, ts, { [LIST]: ts - 1000 });
      assert.equal(p.kind, "list");
      assert.equal(p.url, "https://x.com/i/lists/2222222222");
    }
  });
});

describe("watcher: Pause/Stop during a check (XP-4)", () => {
  beforeEach(() => resetStorage());

  test("rotation: no more profile visits after Stop", async (t) => {
    fast(t);
    const s = sanitizeSettings({ watch: { strategy: "rotation", rotationPerTick: 3, scrolls: 0 } });
    await seed([active("aa"), active("bb"), active("cc")]);
    let stop = false;
    const env = fakeTab({
      waitFor: () => ({ ok: true, key: "profileUserName" }),
      scrapeProfile: (m, tab) => { stop = true; const h = tab.url.split("/").pop(); return { ok: true, profile: profile(h, false), tweets: [] }; },
    });
    const w = await watchOnce(env.tab.id, s, await getTargets(), Date.now(), { shouldStop: async () => stop });
    assert.equal(env.count("navigate"), 1, "only the profile that was already open");
    assert.equal(w.ok, true);
    assert.equal(w.aborted, true);
    assert.deepEqual(w.posts, []);
  });

  test("search page: Stop between scrolls -> no further scroll and no scrape", async (t) => {
    fast(t);
    const s = sanitizeSettings({ watch: { strategy: "search", scrolls: 3 } });
    await seed([active("bob")]);
    let stop = false;
    const env = fakeTab({
      waitFor: () => ({ ok: true, key: "tweet" }),
      scroll: () => { stop = true; return { ok: true }; },
      scrapeTweets: () => ({ ok: true, tweets: [], articleCount: 0, unparsed: 0 }),
    });
    const w = await watchOnce(env.tab.id, s, await getTargets(), Date.now(), { shouldStop: async () => stop });
    assert.equal(env.count("scroll"), 1);
    assert.equal(env.count("scrapeTweets"), 0);
    assert.equal(w.aborted, true);
  });

  test("without a shouldStop the check follows the engine status (paused -> no page load)", async (t) => {
    fast(t);
    const s = sanitizeSettings({ watch: { strategy: "search", scrolls: 0 } });
    await seed([active("bob")]);
    await patchState({ status: STATUS.PAUSED });
    const env = fakeTab({ waitFor: () => ({ ok: true, key: "tweet" }) });
    const w = await watchOnce(env.tab.id, s, await getTargets(), Date.now());
    assert.equal(w.aborted, true);
    assert.equal(env.count("navigate"), 0);
    await patchState({ status: STATUS.RUNNING });
    const w2 = await watchOnce(env.tab.id, s, await getTargets(), Date.now());
    assert.ok(!w2.aborted);
    assert.equal(env.count("navigate"), 1);
  });

  test("refreshProfile honours shouldStop before loading the profile", async (t) => {
    fast(t);
    const s = sanitizeSettings({});
    await seed([active("bob")]);
    const env = fakeTab({ waitFor: () => ({ ok: true, key: "profileUserName" }) });
    const r = await refreshProfile(env.tab.id, "bob", s, { shouldStop: async () => true });
    assert.equal(r.aborted, true);
    assert.equal(env.count("navigate"), 0);
  });
});

describe("watcher: profile follow readings need a trusted badge (ENG-1 / FOL-2, profile half)", () => {
  beforeEach(() => resetStorage());

  function profilePage(map) {
    return fakeTab({
      waitFor: () => ({ ok: true, key: "profileUserName" }),
      scrapeProfile: (m, tab) => { const h = tab.url.split("/").pop(); return { ok: true, profile: profile(h, map[h]), tweets: [] }; },
    });
  }

  test("badge not trusted: checking stays checking, a follower is not counted toward the downgrade", async (t) => {
    fast(t);
    const s = sanitizeSettings({ watch: { scrolls: 0 } });
    const fan = newTarget("fan"); fan.rel.followsYou = true; fan.group = "A";
    await seed([newTarget("alice"), fan]);
    await patchState({ followBadgeOkAt: null });
    const env = profilePage({ alice: false, fan: false });
    const r = await refreshProfile(env.tab.id, "alice", s);
    assert.equal(r.ok, true);
    assert.equal(r.followUntrusted, true);
    let tg = await getTargets();
    assert.equal(followStatus(tg.alice), FS.CHECKING, "no 'not following' without a verified badge -> no comments");
    assert.ok(tg.alice.profile && tg.alice.profile.name, "the rest of the profile is still refreshed");
    await refreshProfile(env.tab.id, "fan", s);
    await refreshProfile(env.tab.id, "fan", s);
    tg = await getTargets();
    assert.equal(followStatus(tg.fan), FS.FOLLOWS, "two untrusted misses never downgrade a follower");
    assert.ok(!tg.fan.rel.notFollowingSeen);
  });

  test("badge not trusted: a badge seen on the profile is applied", async (t) => {
    fast(t);
    const s = sanitizeSettings({ watch: { scrolls: 0 } });
    await seed([newTarget("gina")]);
    const env = profilePage({ gina: true });
    await refreshProfile(env.tab.id, "gina", s);
    assert.equal(followStatus((await getTargets()).gina), FS.FOLLOWS);
  });

  test("badge trusted (seen in the last 3 days): the negative reading counts", async (t) => {
    fast(t);
    const s = sanitizeSettings({ watch: { scrolls: 0 } });
    await seed([newTarget("alice")]);
    await patchState({ followBadgeOkAt: Date.now() - 3600e3 });
    const env = profilePage({ alice: false });
    const r = await refreshProfile(env.tab.id, "alice", s);
    assert.ok(!r.followUntrusted);
    assert.equal(followStatus((await getTargets()).alice), FS.ACTIVE);
  });

  test("trustedFollowReading is pure and keeps positives / unknowns", () => {
    const ok = { followBadgeOkAt: 1000 }, ts = 2000;
    assert.equal(trustedFollowReading({ followsYou: false }, {}, ts).followsYou, null);
    assert.equal(trustedFollowReading({ followsYou: false }, ok, ts).followsYou, false);
    assert.equal(trustedFollowReading({ followsYou: true }, {}, ts).followsYou, true);
    assert.equal(trustedFollowReading({ followsYou: false }, { followBadgeOkAt: ts - 4 * 86400e3 }, ts).followsYou, null, "older than 3 days");
  });
});

describe("watcher: X page-load budget", () => {
  beforeEach(() => resetStorage());

  test("refused page loads are a soft page_budget result (the engine waits), not an X error", async (t) => {
    fast(t);
    const s = sanitizeSettings({ watch: { strategy: "rotation", rotationPerTick: 3, scrolls: 0 }, safety: { maxPageLoads24h: 2 } });
    await saveSettings(s);
    await seed([active("aa"), active("bb")]);
    await patchState({ footprint: { [Math.floor(Date.now() / 3600e3)]: { watch: 2 } } });
    const env = fakeTab({ waitFor: () => ({ ok: true, key: "profileUserName" }) });
    const w = await watchOnce(env.tab.id, s, await getTargets(), Date.now(), await go());
    assert.equal(w.ok, false);
    assert.equal(w.soft, "page_budget");
    assert.equal(w.budget, true);
    assert.equal(env.count("navigate"), 0);
    const r = await refreshProfile(env.tab.id, "aa", s);
    assert.equal(r.soft, "page_budget");
    assert.equal(r.budget, true);
  });
});

