// Follow first (a hard rule): before ScoreX likes or replies to an account, it opens that account's profile and
// follows it - unless the profile shows you already do. X shows "Following" the moment Follow is clicked, before its
// server has answered, and can still refuse: so a follow only counts once a fresh load of the profile shows it. A
// record that you follow an account is trusted for 24 h after its profile showed it (an older record, or one from an
// earlier version that never looked, is checked on the profile again). Nothing is liked or typed until then. It
// cannot follow (no button, X does not keep it, the daily follow cap is used up) -> no like and no reply to that
// account now: the item waits and tries again. X refusing the follow (a warning / limit) stops the engine.
import { resetStorage } from "./_chrome.mjs";
import { install } from "./_engine_env.mjs";
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useMemoryDb } from "../../extension/lib/db.js";
import * as H from "../../extension/lib/history.js";
import * as engine from "../../extension/lib/engine.js";
import { followFirstStep, followRoom, followRoomAt, wantsFollow, followConfirmed, FOLLOW_TRUST_MS } from "../../extension/lib/follow.js";
import { getState, patchState, save, setSecrets, getTargets, getSettings, sanitizeSettings } from "../../extension/lib/store.js";
import { K, HS, STATUS, HARD } from "../../extension/lib/constants.js";
import { newTarget, applyFollow, applyProfile } from "../../extension/lib/targets.js";
import { _setClock, MIN, HOUR, DAY } from "../../extension/lib/util.js";
import { runSelfTest } from "../../extension/lib/diagnostics.js";

const ME = "0x_nation";
const POST_ID = "1983000000000000001";
const POST_URL = `https://x.com/alice/status/${POST_ID}`;
const PROFILE = "https://x.com/alice";
const TEXT = "ngl the timing on this is what makes it work, the rest is noise";
const base = {
  mode: "auto", genRev: 3, account: { handle: ME, verifyAccount: true },
  watch: { strategy: "list", listUrls: ["https://x.com/i/lists/1234567890"], scrolls: 0, catchUp: { enabled: false } },
  safety: { activeHours: { enabled: false }, breaks: { enabled: false }, readDelaySec: { min: 1, max: 1 }, typingCpm: { min: 550, max: 600 }, like: { enabled: true } },
  learning: { enabled: false, conversations: { enabled: false } }, review: { notifyNew: false },
};
// A target that does not follow you. youFollow: what ScoreX's record says; verifiedAgo: when its profile last showed
// Following (null: never - e.g. a record from an earlier version).
const target = (h, { youFollow = false, verifiedAgo = null } = {}) => {
  const t = applyFollow(newTarget(h), false, Date.now() - DAY);
  t.rel.youFollow = youFollow;
  if (verifiedAgo != null) t.rel.youFollowVerifiedAt = Date.now() - verifiedAgo;
  return t;
};

describe("follow first", () => {
  let env;
  before(() => { env = install(); });
  after(() => env.uninstall());
  beforeEach(() => { env.tabs.clear(); env.navigations.length = 0; env.commands.length = 0; env.page = { state: "ok", detail: "", me: ME, hidden: false }; });
  afterEach(async () => { _setClock(null); await engine.pause().catch(() => {}); });

  async function setup({ settings = {}, targets = {}, state = {} } = {}) {
    resetStorage();
    useMemoryDb();
    await save({ [K.settings]: { ...base, ...settings, follow: { ...(settings.follow || {}) } } });
    await setSecrets({ openaiKey: "sk-test-1234567890abcdef" });
    await save({ [K.targets]: targets });
    env.addTab({ id: 3, url: "https://x.com/home", pinned: true, index: 0 });
    await patchState({ status: STATUS.RUNNING, firstStartedAt: Date.now() - 20 * DAY, workerTabId: 3, workerTabPinned: true, workerTabIndex: 0, workerTabFreshAt: Date.now(), followBadgeOkAt: Date.now(), followersScanAt: Date.now(), ...state });
  }
  // A fake X. x.following: whom you really follow (what a fresh profile load shows). click: what a Follow click does -
  //   "keep"     X shows Following and keeps it
  //   "notkept"  X shows Following for a few seconds, but a reload shows Follow (X did not keep it)
  //   "reverted" X turns the button back to Follow after the click
  //   "missing"  no Follow button on the profile
  //   "limit"    X refuses with its follow-limit message
  function fakeX({ click = "keep", following = [] } = {}) {
    const x = { following: new Set(following), clicks: 0 };
    const box = { text: "" };
    const handleOf = (url) => (new URL(url).pathname.split("/")[1] || "").toLowerCase();
    env.content = async (msg, tab) => {
      const page = { ...env.page, url: tab.url };
      const h = handleOf(tab.url);
      switch (msg.sx) {
        case "waitFor": return { ok: true, key: msg.keys[0], page };
        case "scrapeTweets": return { ok: true, tweets: [], articleCount: 0, page };
        case "scrapeStatus": return { ok: true, focal: { id: POST_ID, text: "Most teams ship features.", liked: false }, focalIndex: 0, canReply: true, myReplies: [], page };
        case "followState": return { ok: true, followsYou: false, youFollow: x.following.has(h), pending: false, page };
        case "follow": {
          if (x.following.has(h)) return { ok: true, already: true, page };
          if (click === "missing") return { ok: false, error: "follow_button_missing", page };
          x.clicks++;
          if (click === "limit") return { ok: false, clicked: true, state: "rate_limit", detail: "You are unable to follow more people at this time.", page };
          if (click === "reverted") return { ok: false, clicked: true, error: "follow_reverted", detail: "Something went wrong. Try reloading.", page };
          if (click === "keep") x.following.add(h);
          return { ok: true, clicked: true, page };
        }
        case "like": return { ok: true, page };
        case "openComposer": return { ok: true, where: "inline", text: "", page };
        case "type": box.text = msg.text; return { ok: true, text: box.text, page };
        case "composerText": return { ok: true, text: box.text, page };
        case "submitReply": return { ok: true, where: "inline", tries: 1, started: true, page };
        case "replyResult": return { ok: true, replyId: "1983000000000000999", replyUrl: `https://x.com/${ME}/status/1983000000000000999`, via: "toast", page };
        default: return { ok: true, page };
      }
    };
    return x;
  }
  async function queued(target = "alice") {
    const rec = await H.put(H.newRecord({ status: HS.QUEUED, target, group: "B", postId: POST_ID, postUrl: POST_URL, comment: TEXT, attempts: 1, postCreatedAt: Date.now() - 5 * MIN, scheduledFor: 0 }));
    await patchState({ nextCommentAt: 0, lastCommentAt: 0, lastWatchAt: Date.now() });
    await engine.tick("alarm");
    return H.get(rec.id);
  }
  async function again(r) {
    await H.patch(r.id, { scheduledFor: 0 });
    await patchState({ nextCommentAt: 0, lastCommentAt: 0, lastWatchAt: Date.now() });
    await engine.tick("alarm");
    return H.get(r.id);
  }
  const order = () => env.cmds().map((c) => c[0]).filter((c) => ["follow", "followState", "like", "openComposer", "submitReply"].includes(c));
  const visited = () => env.navigations.map(([, u]) => u);
  const follows = async () => ((await getState()).followTimes || []).length;

  test("not followed: profile -> Follow -> the profile again (X kept it) -> the post; like and reply only after that", async () => {
    await setup({ targets: { alice: target("alice") } });
    const x = fakeX();
    const r = await queued();
    assert.equal(r.status, HS.POSTED, r.reason);
    assert.deepEqual(order(), ["follow", "followState", "like", "openComposer", "submitReply"], "follow, confirm, then like and reply");
    assert.deepEqual(visited(), [PROFILE, PROFILE, POST_URL], "the profile, a fresh load of it, then the post");
    assert.equal(env.cmds("follow")[0][1], PROFILE, "Follow is clicked on the profile page");
    assert.equal(x.clicks, 1);
    const t = (await getTargets()).alice;
    assert.equal(t.rel.youFollow, true);
    assert.ok(t.rel.youFollowVerifiedAt && t.rel.followedByScoreXAt && t.rel.youFollowSince);
    assert.equal(await follows(), 1);
    assert.equal(r.follow, "followed", "the posted comment remembers that the follow came first");
  });

  test("X shows Following but does not keep it: nothing liked or typed, the follow is counted, tried again, then skipped", async () => {
    await setup({ targets: { alice: target("alice") } });
    const x = fakeX({ click: "notkept" });
    let r = await queued();
    assert.equal(r.status, HS.QUEUED, "not posted");
    assert.match(r.reason, /Will retry: following @alice first did not work \(follow_first_follow_not_kept\)/);
    assert.deepEqual(order(), ["follow", "followState"], "no like, no reply");
    assert.ok(!visited().includes(POST_URL), "the post page was not even opened");
    const t = (await getTargets()).alice;
    assert.equal(t.rel.youFollow, false);
    assert.ok(t.rel.followNotKeptAt);
    assert.equal(await follows(), 1, "the click counts toward the daily cap");
    r = await again(r);
    r = await again(r);
    assert.equal(r.status, HS.SKIPPED);
    assert.match(r.reason, /Could not follow @alice first .* not commented/);
    assert.equal(x.clicks, 3);
    assert.ok(!order().includes("like") && !order().includes("submitReply"));
    assert.equal((await getState()).status, STATUS.RUNNING, "not a stop: ScoreX goes on");
  });

  test("X turns the button back to Follow: not posted, the reason says what X showed", async () => {
    await setup({ targets: { alice: target("alice") } });
    fakeX({ click: "reverted" });
    const r = await queued();
    assert.equal(r.status, HS.QUEUED);
    assert.match(r.reason, /follow_reverted/);
    assert.deepEqual(order(), ["follow"]);
    assert.deepEqual(visited(), [PROFILE]);
    assert.equal(await follows(), 1);
  });

  test("the profile shows you already follow: nothing clicked or counted, no reload, and the reply goes on", async () => {
    await setup({ targets: { alice: target("alice") } });
    const x = fakeX({ following: ["alice"] });
    const r = await queued();
    assert.equal(r.status, HS.POSTED);
    assert.equal(x.clicks, 0);
    assert.deepEqual(visited(), [PROFILE, POST_URL]);
    const t = (await getTargets()).alice;
    assert.equal(t.rel.youFollow, true);
    assert.ok(t.rel.youFollowVerifiedAt, "seen on the profile: trusted for the next 24 h");
    assert.equal(await follows(), 0, "not a follow: the daily cap is untouched");
    assert.equal(r.follow, "already");
  });

  test("a 'you follow' record that was never checked on the profile (earlier versions) is checked: not followed -> followed first", async () => {
    await setup({ targets: { alice: target("alice", { youFollow: true }) } });
    const x = fakeX();
    const r = await queued();
    assert.equal(r.status, HS.POSTED);
    assert.equal(x.clicks, 1, "the record was wrong: ScoreX followed before replying");
    assert.deepEqual(visited(), [PROFILE, PROFILE, POST_URL]);
    assert.equal(r.follow, "followed");
  });

  test("seen on the profile in the last 24 h: no profile visit; older than that: looked at again; the switch off: never", async () => {
    await setup({ targets: { alice: target("alice", { youFollow: true, verifiedAgo: 2 * HOUR }) } });
    fakeX({ following: ["alice"] });
    assert.equal((await queued()).status, HS.POSTED);
    assert.ok(!order().includes("follow") && !order().includes("followState"));
    assert.deepEqual(visited(), [POST_URL]);

    env.commands.length = 0; env.navigations.length = 0; env.tabs.clear();
    await setup({ targets: { alice: target("alice", { youFollow: true, verifiedAgo: 25 * HOUR }) } });
    fakeX({ following: ["alice"] });
    assert.equal((await queued()).status, HS.POSTED);
    assert.deepEqual(visited(), [PROFILE, POST_URL], "a day-old look is not trusted");

    env.commands.length = 0; env.navigations.length = 0; env.tabs.clear();
    await setup({ settings: { follow: { followFirst: false } }, targets: { alice: target("alice") } });
    fakeX();
    assert.equal((await queued()).status, HS.POSTED);
    assert.ok(!order().includes("follow"), "follow first switched off");
  });

  test("daily follow cap used up: no like and no reply to an account you don't follow - it waits until the cap has room", async () => {
    const ts = Date.now();
    await setup({ settings: { follow: { followsPerDay: 2 } }, targets: { alice: target("alice") }, state: { followTimes: [ts - 1000, ts - 2000] } });
    fakeX();
    const r = await queued();
    assert.equal(r.status, HS.QUEUED, "still waiting, not posted");
    assert.match(r.reason, /Waiting to follow @alice first/);
    assert.ok(r.scheduledFor > ts + 20 * 3600e3, "until the oldest follow leaves the 24 h window");
    assert.deepEqual(order(), [], "nothing liked, followed or typed");
    assert.equal(visited().length, 0, "not even the post page was opened");
  });

  test("cap used up, the record says you follow: the profile is looked at (no click); Following -> replies, Follow -> waits", async () => {
    const ts = Date.now();
    const state = { followTimes: [ts - 1000, ts - 2000] };
    await setup({ settings: { follow: { followsPerDay: 2 } }, targets: { alice: target("alice", { youFollow: true }) }, state });
    let x = fakeX({ following: ["alice"] });
    assert.equal((await queued()).status, HS.POSTED, "a look needs no room under the cap");
    assert.deepEqual(order(), ["followState", "like", "openComposer", "submitReply"]);
    assert.equal(x.clicks, 0);

    env.commands.length = 0; env.navigations.length = 0; env.tabs.clear();
    await setup({ settings: { follow: { followsPerDay: 2 } }, targets: { alice: target("alice", { youFollow: true }) }, state });
    x = fakeX();
    const r = await queued();
    assert.equal(r.status, HS.QUEUED);
    assert.match(r.reason, /Waiting to follow @alice first \(daily follow cap reached\)/);
    assert.deepEqual(order(), ["followState"], "nothing clicked, liked or typed");
    assert.equal(x.clicks, 0);
    assert.deepEqual(visited(), [PROFILE]);
  });

  test("no Follow button: nothing liked or typed; tries again, then skips - never posted", async () => {
    await setup({ targets: { alice: target("alice") } });
    fakeX({ click: "missing" });
    let r = await queued();
    assert.equal(r.status, HS.QUEUED, "waits for another try");
    assert.match(r.reason, /Will retry: following @alice first did not work/);
    assert.deepEqual(order(), ["follow"], "no like, no reply");
    r = await again(r);
    r = await again(r);
    assert.equal(r.status, HS.SKIPPED);
    assert.match(r.reason, /Could not follow @alice first .* not commented/);
    assert.ok(!order().includes("submitReply") && !order().includes("like"));
    assert.equal(await follows(), 0, "nothing was clicked");
  });

  test("X refuses the follow (a warning / follow limit): the engine stops before anything is liked or typed", async () => {
    await setup({ targets: { alice: target("alice") } });
    fakeX({ click: "limit" });
    const r = await queued();
    assert.notEqual(r.status, HS.POSTED);
    assert.deepEqual(order(), ["follow"]);
    assert.equal((await getState()).status, STATUS.STOPPED);
  });

  test("background: follows a target you do not follow and checks a never-checked record; a recent look and followers are left alone", async () => {
    const fan = applyFollow(newTarget("fan"), true, Date.now() - DAY);
    await setup({ targets: { alice: target("alice"), bob: target("bob", { youFollow: true }), carol: target("carol", { youFollow: true, verifiedAgo: 2 * DAY }), fan } });
    fakeX({ following: ["bob", "carol"] });
    const settings = await getSettings();
    const step = () => followFirstStep({ tabId: 3, settings, me: ME, shouldStop: async () => false });
    assert.equal((await step()).did, "follow_first");
    assert.deepEqual(visited(), [PROFILE, PROFILE], "alice: followed, then confirmed on a fresh load");
    assert.equal((await getTargets()).alice.rel.youFollow, true);
    assert.equal(await step(), null, "the 3-8 minute gap holds the next one back");
    await patchState({ lastFollowAt: 0 });
    env.navigations.length = 0;
    assert.equal((await step()).did, "follow_first");
    assert.deepEqual(visited(), ["https://x.com/bob"], "bob's record was never checked: one look, nothing clicked");
    assert.ok((await getTargets()).bob.rel.youFollowVerifiedAt);
    await patchState({ lastFollowAt: 0 });
    env.navigations.length = 0;
    assert.equal(await step(), null, "carol (checked before) and fan (follows you) are not picked");
    assert.equal(wantsFollow((await getTargets()).fan, settings), false);
    assert.equal(await follows(), 1, "only alice's click counts");
  });

  test("followConfirmed / wantsFollow: a profile look is trusted for 24 h; a profile read records it", () => {
    const s = sanitizeSettings({});
    const ts = Date.now();
    assert.equal(FOLLOW_TRUST_MS, DAY);
    assert.equal(followConfirmed(target("a", { youFollow: true }), ts), false, "never looked at");
    assert.equal(followConfirmed(target("a", { youFollow: true, verifiedAgo: HOUR }), ts), true);
    assert.equal(followConfirmed(target("a", { youFollow: true, verifiedAgo: DAY + MIN }), ts), false);
    assert.equal(followConfirmed(target("a", { youFollow: false, verifiedAgo: HOUR }), ts), false);
    assert.equal(wantsFollow(target("a", { youFollow: true, verifiedAgo: HOUR }), s, ts), false);
    assert.equal(wantsFollow(target("a", { youFollow: true }), s, ts), true);
    const t = target("a");
    applyProfile(t, { handle: "a", youFollow: true, followsYou: false }, null);
    assert.ok(t.rel.youFollowVerifiedAt && followConfirmed(t), "a profile page that showed Following");
    applyProfile(t, { handle: "a", youFollow: false, followsYou: false }, null);
    assert.equal(t.rel.youFollowVerifiedAt, null);
    assert.equal(wantsFollow(t, s), true);
  });

  test("Live X test: reads the Follow button on a target's profile you don't follow, never clicks it; no button -> a failed check", async () => {
    const fan = applyFollow(newTarget("fan"), true, Date.now() - DAY);
    await setup({ targets: { fan, carol: target("carol", { youFollow: true, verifiedAgo: HOUR }), alice: target("alice") }, state: { status: STATUS.STOPPED } });
    const counts = { primaryColumn: 1, tweet: 3, tweetText: 3, tweetUserName: 3, tweetTime: 3, replyButton: 3, profileUserName: 1, profileFollowers: 1, userCell: 5, followsYouBadge: 5 };
    let button = false;
    env.content = async (msg, tab) => {
      const page = { ...env.page, url: tab.url };
      if (msg.sx === "waitFor") return { ok: true, key: msg.keys[0], page };
      if (msg.sx === "selfTest") return { ok: true, me: ME, counts, cells: 5, badgeCells: 5, page };
      if (msg.sx === "followState") return { ok: true, followsYou: false, youFollow: button ? false : null, pending: false, page };
      return { ok: true, page };
    };
    button = true;
    let r = await runSelfTest();
    const check = () => r.checks.find((c) => c.id === "follow");
    assert.equal(visited().slice(-1)[0], PROFILE, "alice: a target you don't follow");
    assert.equal(check().ok, true);
    assert.match(check().detail, /@alice's profile shows "Follow"/);
    assert.ok(!env.cmds("follow").length, "nothing is clicked");
    button = false;
    r = await runSelfTest();
    assert.equal(check().ok, false);
    assert.match(check().detail, /No Follow \/ Following button found on @alice's profile/);
  });

  test("followRoom / followRoomAt: the rolling 24 h cap, never above the hard cap, 0 when the switch is off", () => {
    const s = sanitizeSettings({ follow: { followsPerDay: 3 } });
    const ts = Date.now();
    assert.equal(followRoom(s, { followTimes: [ts - 1000, ts - 2 * DAY] }, ts), 2);
    assert.equal(followRoom(sanitizeSettings({ genRev: 3, follow: { followFirst: false } }), {}, ts), 0);
    assert.equal(followRoom(sanitizeSettings({ follow: { followsPerDay: 5000 } }), {}, ts), HARD.dailyFollows);
    assert.equal(sanitizeSettings({}).follow.followsPerDay, 100, "default: as many follows as accounts a day");
    const full = { followTimes: [ts - 3 * 3600e3, ts - 2 * 3600e3, ts - 1 * 3600e3] };
    assert.equal(followRoomAt(s, { followTimes: [] }, ts), ts, "room now");
    const at = followRoomAt(s, full, ts);
    assert.ok(at >= ts - 3 * 3600e3 + DAY && at <= ts - 3 * 3600e3 + DAY + 6 * MIN, "when the oldest of the last 24 h leaves the window");
  });
});
