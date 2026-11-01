// Follow first (a hard rule): before ScoreX likes or replies to an account you do not follow, it opens that account's
// profile and follows it (or sees there that you already do). Nothing is liked or typed until X confirms. It cannot
// follow (no button, X does not confirm, the daily follow cap is used up) -> no like and no reply to that account now:
// the item waits and tries again. X refusing the follow (a warning / limit) stops the engine before anything else.
import { resetStorage } from "./_chrome.mjs";
import { install } from "./_engine_env.mjs";
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useMemoryDb } from "../../extension/lib/db.js";
import * as H from "../../extension/lib/history.js";
import * as engine from "../../extension/lib/engine.js";
import { followFirstStep, followRoom, followRoomAt, wantsFollow } from "../../extension/lib/follow.js";
import { getState, patchState, save, setSecrets, getTargets, getSettings, sanitizeSettings } from "../../extension/lib/store.js";
import { K, HS, STATUS, HARD } from "../../extension/lib/constants.js";
import { newTarget, applyFollow } from "../../extension/lib/targets.js";
import { _setClock, MIN, DAY } from "../../extension/lib/util.js";

const ME = "0x_nation";
const POST_ID = "1983000000000000001";
const POST_URL = `https://x.com/alice/status/${POST_ID}`;
const TEXT = "ngl the timing on this is what makes it work, the rest is noise";
const base = {
  mode: "auto", genRev: 3, account: { handle: ME, verifyAccount: true },
  watch: { strategy: "list", listUrls: ["https://x.com/i/lists/1234567890"], scrolls: 0, catchUp: { enabled: false } },
  safety: { activeHours: { enabled: false }, breaks: { enabled: false }, readDelaySec: { min: 1, max: 1 }, typingCpm: { min: 550, max: 600 }, like: { enabled: true } },
  learning: { enabled: false, conversations: { enabled: false } }, review: { notifyNew: false },
};
const notFollowing = (h, youFollow = false) => { const t = applyFollow(newTarget(h), false, Date.now() - DAY); t.rel.youFollow = youFollow; return t; };

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
  // X: the profile answers the follow with `followAnswer`; the post page lets the reply through.
  function xPages(followAnswer) {
    const box = { text: "" };
    env.content = async (msg, tab) => {
      const page = { ...env.page, url: tab.url };
      switch (msg.sx) {
        case "waitFor": return { ok: true, key: msg.keys[0], page };
        case "scrapeTweets": return { ok: true, tweets: [], articleCount: 0, page };
        case "scrapeStatus": return { ok: true, focal: { id: POST_ID, text: "Most teams ship features.", liked: false }, focalIndex: 0, canReply: true, myReplies: [], page };
        case "follow": return { ...followAnswer, page };
        case "like": return { ok: true, page };
        case "openComposer": return { ok: true, where: "inline", text: "", page };
        case "type": box.text = msg.text; return { ok: true, text: box.text, page };
        case "composerText": return { ok: true, text: box.text, page };
        case "submitReply": return { ok: true, where: "inline", tries: 1, started: true, page };
        case "replyResult": return { ok: true, replyId: "1983000000000000999", replyUrl: `https://x.com/${ME}/status/1983000000000000999`, via: "toast", page };
        default: return { ok: true, page };
      }
    };
  }
  async function queued(target = "alice") {
    const rec = await H.put(H.newRecord({ status: HS.QUEUED, target, group: "B", postId: POST_ID, postUrl: POST_URL, comment: TEXT, attempts: 1, postCreatedAt: Date.now() - 5 * MIN, scheduledFor: 0 }));
    await patchState({ nextCommentAt: 0, lastCommentAt: 0, lastWatchAt: Date.now() });
    await engine.tick("alarm");
    return H.get(rec.id);
  }
  const order = () => env.cmds().map((c) => c[0]).filter((c) => ["follow", "like", "openComposer", "submitReply"].includes(c));
  const visited = () => env.navigations.map(([, u]) => u);

  test("not followed yet: its profile first, Follow, then the post - like and reply only after X confirms", async () => {
    await setup({ targets: { alice: notFollowing("alice") } });
    xPages({ ok: true });
    const r = await queued();
    assert.equal(r.status, HS.POSTED);
    assert.deepEqual(order(), ["follow", "like", "openComposer", "submitReply"], "follow before like and reply");
    assert.deepEqual(visited().slice(0, 2), ["https://x.com/alice", POST_URL], "the profile, then the post");
    assert.equal(env.cmds("follow")[0][1], "https://x.com/alice", "the follow is clicked on the profile page");
    const t = (await getTargets()).alice;
    assert.equal(t.rel.youFollow, true);
    assert.ok(t.rel.youFollowSince && t.rel.followedByScoreXAt);
    assert.equal(((await getState()).followTimes || []).length, 1);
  });

  test("the profile shows you already follow: nothing is clicked or counted, and the reply goes on", async () => {
    await setup({ targets: { alice: notFollowing("alice") } });
    xPages({ ok: true, already: true });
    assert.equal((await queued()).status, HS.POSTED);
    assert.equal((await getTargets()).alice.rel.youFollow, true, "remembered: no profile visit next time");
    assert.equal(((await getState()).followTimes || []).length, 0, "not a follow: the daily cap is untouched");
  });

  test("already following (known): no profile visit; the switch off: no follow either", async () => {
    await setup({ targets: { alice: notFollowing("alice", true) } });
    xPages({ ok: true });
    assert.equal((await queued()).status, HS.POSTED);
    assert.ok(!order().includes("follow"));
    assert.ok(!visited().includes("https://x.com/alice"));

    env.commands.length = 0; env.navigations.length = 0; env.tabs.clear();
    await setup({ settings: { follow: { followFirst: false } }, targets: { alice: notFollowing("alice") } });
    xPages({ ok: true });
    assert.equal((await queued()).status, HS.POSTED);
    assert.ok(!order().includes("follow"), "follow first switched off");
  });

  test("daily follow cap used up: no like and no reply to an account you don't follow - it waits until the cap has room", async () => {
    const ts = Date.now();
    await setup({ settings: { follow: { followsPerDay: 2 } }, targets: { alice: notFollowing("alice") }, state: { followTimes: [ts - 1000, ts - 2000] } });
    xPages({ ok: true });
    const r = await queued();
    assert.equal(r.status, HS.QUEUED, "still waiting, not posted");
    assert.match(r.reason, /Waiting to follow @alice first/);
    assert.ok(r.scheduledFor > ts + 20 * 3600e3, "until the oldest follow leaves the 24 h window");
    assert.deepEqual(order(), [], "nothing liked, followed or typed");
    assert.equal(visited().length, 0, "not even the post page was opened");
  });

  test("Follow does not work (no button, X does not confirm): nothing liked or typed; tries again, then skips - never posted", async () => {
    await setup({ targets: { alice: notFollowing("alice") } });
    xPages({ ok: false, error: "follow_button_missing" });
    let r = await queued();
    assert.equal(r.status, HS.QUEUED, "waits for another try");
    assert.match(r.reason, /Will retry: following @alice first did not work/);
    assert.deepEqual(order(), ["follow"], "no like, no reply");
    assert.ok(!visited().includes(POST_URL), "the post page was not even opened");
    for (let i = 0; i < 2; i++) {
      await H.patch(r.id, { scheduledFor: 0 });
      await patchState({ nextCommentAt: 0, lastCommentAt: 0, lastWatchAt: Date.now() });
      await engine.tick("alarm");
      r = await H.get(r.id);
    }
    assert.equal(r.status, HS.SKIPPED);
    assert.match(r.reason, /Could not follow @alice first .* not commented/);
    assert.ok(!order().includes("submitReply") && !order().includes("like"));
    assert.equal((await getState()).status, STATUS.RUNNING, "not a stop: ScoreX goes on");
  });

  test("X refuses the follow (a warning / follow limit): the engine stops before anything is liked or typed", async () => {
    await setup({ targets: { alice: notFollowing("alice") } });
    xPages({ ok: false, state: "rate_limit", detail: "You are unable to follow more people at this time." });
    const r = await queued();
    assert.notEqual(r.status, HS.POSTED);
    assert.deepEqual(order(), ["follow"]);
    assert.equal((await getState()).status, STATUS.STOPPED);
  });

  test("background: one target you do not follow is followed from its profile; accounts that follow you are never picked", async () => {
    const follower = applyFollow(newTarget("fan"), true, Date.now() - DAY);
    await setup({ targets: { alice: notFollowing("alice"), fan: follower } });
    env.content = async (msg, tab) => {
      const page = { ...env.page, url: tab.url };
      if (msg.sx === "waitFor") return { ok: true, key: msg.keys[0], page };
      if (msg.sx === "follow") return { ok: true, page };
      return { ok: true, page };
    };
    const settings = await getSettings();
    const r = await followFirstStep({ tabId: 3, settings, me: ME, shouldStop: async () => false });
    assert.equal(r.did, "follow_first");
    assert.deepEqual(visited(), ["https://x.com/alice"]);
    assert.equal(env.cmds("follow")[0][1], "https://x.com/alice");
    assert.equal((await getTargets()).alice.rel.youFollow, true);
    assert.equal(await followFirstStep({ tabId: 3, settings, me: ME, shouldStop: async () => false }), null, "the 3-8 minute gap holds the next one back");
    assert.equal(wantsFollow((await getTargets()).fan, settings), false, "an account that follows you is not a follow-first target");
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
