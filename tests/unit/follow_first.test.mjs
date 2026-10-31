// Follow first: a target you do not follow is followed before ScoreX replies to it (on its post page), or from its
// profile in the background, within the daily follow cap. Already followed -> nothing; no button -> the reply still
// goes out and the background step tries the profile later.
import { resetStorage } from "./_chrome.mjs";
import { install } from "./_engine_env.mjs";
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useMemoryDb } from "../../extension/lib/db.js";
import * as H from "../../extension/lib/history.js";
import * as engine from "../../extension/lib/engine.js";
import { followFirstStep, followRoom, wantsFollow } from "../../extension/lib/follow.js";
import { getState, patchState, save, setSecrets, getTargets, getSettings, sanitizeSettings } from "../../extension/lib/store.js";
import { K, HS, STATUS } from "../../extension/lib/constants.js";
import { newTarget, applyFollow } from "../../extension/lib/targets.js";
import { _setClock, MIN, DAY } from "../../extension/lib/util.js";

const ME = "0x_nation";
const POST_ID = "1983000000000000001";
const TEXT = "ngl the timing on this is what makes it work, the rest is noise";
const base = {
  mode: "auto", account: { handle: ME, verifyAccount: true },
  watch: { strategy: "list", listUrls: ["https://x.com/i/lists/1234567890"], scrolls: 0, catchUp: { enabled: false } },
  safety: { activeHours: { enabled: false }, breaks: { enabled: false }, readDelaySec: { min: 1, max: 1 }, typingCpm: { min: 550, max: 600 } },
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
  // A post page where the reply goes through; follow answers with `followAnswer`.
  function postPage(followAnswer) {
    const box = { text: "" };
    env.content = async (msg, tab) => {
      const page = { ...env.page, url: tab.url };
      switch (msg.sx) {
        case "waitFor": return { ok: true, key: msg.keys[0], page };
        case "scrapeTweets": return { ok: true, tweets: [], articleCount: 0, page };
        case "scrapeStatus": return { ok: true, focal: { id: POST_ID, text: "Most teams ship features.", liked: false }, focalIndex: 0, canReply: true, myReplies: [], page };
        case "follow": return { ...followAnswer, page };
        case "openComposer": return { ok: true, where: "inline", text: "", page };
        case "type": box.text = msg.text; return { ok: true, text: box.text, page };
        case "composerText": return { ok: true, text: box.text, page };
        case "submitReply": return { ok: true, where: "inline", tries: 1, started: true, page };
        case "replyResult": return { ok: true, replyId: "1983000000000000999", replyUrl: `https://x.com/${ME}/status/1983000000000000999`, via: "toast", page };
        default: return { ok: true, page };
      }
    };
  }
  async function queued() {
    const rec = await H.put(H.newRecord({ status: HS.QUEUED, target: "alice", group: "B", postId: POST_ID, postUrl: `https://x.com/alice/status/${POST_ID}`, comment: TEXT, attempts: 1, postCreatedAt: Date.now() - 5 * MIN, scheduledFor: 0 }));
    await patchState({ nextCommentAt: 0, lastCommentAt: 0, lastWatchAt: Date.now() });
    await engine.tick("alarm");
    return H.get(rec.id);
  }
  const order = () => env.cmds().map((c) => c[0]).filter((c) => ["like", "follow", "openComposer", "submitReply"].includes(c));

  test("a target you do not follow is followed on its post page right before the reply; then it counts as followed", async () => {
    await setup({ targets: { alice: notFollowing("alice") } });
    postPage({ ok: true });
    const r = await queued();
    assert.equal(r.status, HS.POSTED);
    assert.deepEqual(order(), ["like", "follow", "openComposer", "submitReply"]);
    const t = (await getTargets()).alice;
    assert.equal(t.rel.youFollow, true);
    assert.ok(t.rel.youFollowSince && t.rel.followedByScoreXAt);
    const st = await getState();
    assert.equal((st.followTimes || []).length, 1);
  });

  test("already followed: no follow click; the setting off or the daily cap reached: no follow either", async () => {
    await setup({ targets: { alice: notFollowing("alice", true) } });
    postPage({ ok: true });
    assert.equal((await queued()).status, HS.POSTED);
    assert.ok(!order().includes("follow"));

    env.commands.length = 0; env.tabs.clear();
    await setup({ settings: { follow: { followFirst: false } }, targets: { alice: notFollowing("alice") } });
    postPage({ ok: true });
    assert.equal((await queued()).status, HS.POSTED);
    assert.ok(!order().includes("follow"));

    env.commands.length = 0; env.tabs.clear();
    await setup({ settings: { follow: { followsPerDay: 2 } }, targets: { alice: notFollowing("alice") }, state: { followTimes: [Date.now() - 1000, Date.now() - 2000] } });
    postPage({ ok: true });
    assert.equal((await queued()).status, HS.POSTED);
    assert.ok(!order().includes("follow"), "cap reached");
  });

  test("no follow button on the post page: the reply still goes out, and the target is marked for the profile step tomorrow", async () => {
    await setup({ targets: { alice: notFollowing("alice") } });
    postPage({ ok: false, error: "follow_button_missing" });
    assert.equal((await queued()).status, HS.POSTED);
    const t = (await getTargets()).alice;
    assert.notEqual(t.rel.youFollow, true);
    assert.ok(t.rel.followTriedAt > 0);
  });

  test("an X warning after the follow click stops the engine before anything is typed", async () => {
    await setup({ targets: { alice: notFollowing("alice") } });
    postPage({ ok: false, state: "rate_limit", detail: "You are unable to follow more people at this time." });
    const r = await queued();
    assert.notEqual(r.status, HS.POSTED);
    assert.ok(!order().includes("openComposer"));
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
    assert.deepEqual(env.navigations.map(([, u]) => u), ["https://x.com/alice"]);
    assert.equal(env.cmds("follow")[0][1], "https://x.com/alice");
    assert.equal((await getTargets()).alice.rel.youFollow, true);
    // Right after: the 3-8 minute gap holds it back.
    assert.equal(await followFirstStep({ tabId: 3, settings, me: ME, shouldStop: async () => false }), null);
    assert.equal(wantsFollow((await getTargets()).fan, settings), false, "an account that follows you is not a follow-first target");
  });

  test("followRoom: the rolling 24 h cap, never above the hard cap, 0 when the setting is off", () => {
    const s = sanitizeSettings({ follow: { followsPerDay: 3 } });
    const ts = Date.now();
    assert.equal(followRoom(s, { followTimes: [ts - 1000, ts - 2 * DAY] }, ts), 2);
    assert.equal(followRoom(sanitizeSettings({ follow: { followFirst: false } }), {}, ts), 0);
    assert.equal(followRoom(sanitizeSettings({ follow: { followsPerDay: 500 } }), {}, ts), 100);
  });
});
