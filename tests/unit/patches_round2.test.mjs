// Cross-module fixes applied after review round 1: the poster's "account unknown" answer in the engine, the
// account / unknown-prompt checks around cleanup's unfollow click, the reach monitor without self-learning,
// learn-from-edits reaching the model, and post flags kept on stored recent posts.
import { resetStorage } from "./_chrome.mjs";
import { install, mockOpenAI } from "./_engine_env.mjs";
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useMemoryDb } from "../../extension/lib/db.js";
import * as H from "../../extension/lib/history.js";
import * as engine from "../../extension/lib/engine.js";
import { cleanupStep } from "../../extension/lib/cleanup.js";
import { getState, patchState, save, setSecrets, getTargets, getSettings } from "../../extension/lib/store.js";
import { K, HS, STOP, STOP_LABEL, STATUS } from "../../extension/lib/constants.js";
import { newTarget, applyFollow, mergePosts } from "../../extension/lib/targets.js";
import { _setClock, MIN, DAY } from "../../extension/lib/util.js";

const ME = "0x_nation";
const POST_ID = "1983000000000000001";
const baseSettings = {
  mode: "auto",
  account: { handle: ME, verifyAccount: true },
  watch: { strategy: "list", listUrls: ["https://x.com/i/lists/1234567890"], scrolls: 0, catchUp: { enabled: false } },
  safety: { activeHours: { enabled: false }, breaks: { enabled: false }, readDelaySec: { min: 1, max: 1 }, typingCpm: { min: 550, max: 600 } },
  learning: { enabled: false, conversations: { enabled: false } },
  review: { notifyNew: false },
};
const notFollowing = (h, o) => applyFollow(newTarget(h, o), false, Date.now() - DAY);

async function setup(env, { settings = {}, targets = {}, state = {} } = {}) {
  resetStorage();
  useMemoryDb();
  await save({ [K.settings]: { ...baseSettings, ...settings, safety: { ...baseSettings.safety, ...(settings.safety || {}) }, watch: { ...baseSettings.watch, ...(settings.watch || {}) } } });
  await setSecrets({ openaiKey: "sk-test-1234567890abcdef" });
  await save({ [K.targets]: targets });
  env.addTab({ id: 3, url: "https://x.com/home", pinned: true, index: 0 });
  await patchState({ status: STATUS.RUNNING, firstStartedAt: Date.now() - 20 * DAY, workerTabId: 3, workerTabPinned: true, workerTabIndex: 0, workerTabFreshAt: Date.now(), followBadgeOkAt: Date.now(), followersScanAt: Date.now(), ...state });
}

describe("cross-module fixes (round 2)", () => {
  let env;
  before(() => { env = install(); });
  after(() => env.uninstall());
  beforeEach(() => {
    env.tabs.clear(); env.navigations.length = 0; env.commands.length = 0; env.reloads.length = 0; env.notifications.length = 0;
    env.content = null; env.loads = true; env.page = { state: "ok", detail: "", me: ME, hidden: false };
  });
  afterEach(async () => { _setClock(null); await engine.pause().catch(() => {}); });

  test("posting: an unreadable logged-in account puts the item back (no retry used, nothing typed) and 3 in a row stop the engine (Stop when errors repeat on)", async () => {
    await setup(env, { settings: { safety: { stopOnErrors: true } }, targets: { alice: notFollowing("alice") } });
    env.page = { state: "ok", detail: "", me: "", hidden: false }; // X shows no readable account anywhere
    env.content = async (msg, tab) => {
      const page = { ...env.page, url: tab.url };
      if (msg.sx === "waitFor") return { ok: true, key: msg.keys[0], page };
      if (msg.sx === "scrapeTweets") return { ok: true, tweets: [], articleCount: 0, page };
      if (msg.sx === "scrapeStatus") return { ok: true, focal: { id: POST_ID, liked: false }, focalIndex: 0, canReply: true, myReplies: [], page };
      return { ok: true, page };
    };
    const rec = await H.put(H.newRecord({ status: HS.QUEUED, target: "alice", group: "B", postId: POST_ID, postUrl: `https://x.com/alice/status/${POST_ID}`, comment: "Deferring company size is underrated for early funnels", attempts: 1, postCreatedAt: Date.now() - 5 * MIN, scheduledFor: 0 }));
    await patchState({ nextCommentAt: 0, lastCommentAt: 0, lastWatchAt: Date.now() });
    await engine.tick("alarm");
    const typed = env.cmds("typeReply").length + env.cmds("submitReply").length;
    assert.equal(typed, 0, "nothing is typed or submitted without a verified account");
    let r = await H.get(rec.id);
    let st = await getState();
    if (st.status === STATUS.RUNNING) {
      assert.equal(r.status, HS.QUEUED, "the item waits for the next try");
      assert.equal(r.retries || 0, 0, "an unknown account is not a post-page retry");
      assert.equal(r.reason, STOP_LABEL[STOP.ACCOUNT_UNKNOWN]);
      for (let i = 0; i < 3 && (await getState()).status === STATUS.RUNNING; i++) {
        await patchState({ nextCommentAt: 0, lastCommentAt: 0, lastWatchAt: Date.now() });
        await H.patch(rec.id, { scheduledFor: 0 });
        await engine.tick("alarm");
      }
      st = await getState();
      r = await H.get(rec.id);
    }
    assert.equal(st.status, STATUS.STOPPED);
    assert.equal(st.stopReason, STOP.ACCOUNT_UNKNOWN);
    assert.notEqual(r.status, HS.FAILED, "the item itself did not fail");
    assert.equal(r.retries || 0, 0, "no post-page retries were used up");
    assert.notEqual(r.status, HS.POSTED);
  });

  // ---- cleanup: account and unknown-prompt checks around the unfollow click ----
  const oldFollow = () => {
    const t = applyFollow(newTarget("bob", { tier: 2 }), false, Date.now() - DAY);
    t.rel = { ...t.rel, youFollow: true, youFollowSince: Date.now() - 30 * DAY };
    return t;
  };
  async function cleanupEnv(unfollowAnswer) {
    await setup(env, { settings: { cleanup: { enabled: true, afterDays: 7, dailyLimit: 10, whitelist: [], protectTier1: true } }, targets: { bob: oldFollow() }, state: { followsYouCanaryAt: Date.now() } });
    env.content = async (msg, tab) => {
      const page = { ...env.page, url: tab.url };
      if (msg.sx === "waitFor") return { ok: true, key: msg.keys[0], page };
      if (msg.sx === "followState") return { ok: true, followsYou: false, youFollow: true, profile: { handle: "bob", followers: 900, followsYou: false, youFollow: true }, page };
      if (msg.sx === "unfollow") return { ...unfollowAnswer(msg), page };
      return { ok: true, page };
    };
    return getSettings();
  }
  const unfollowMsgs = [];

  test("cleanup: the unfollow click carries the expected account; another account logged in is a safety stop", async () => {
    unfollowMsgs.length = 0;
    const settings = await cleanupEnv((msg) => { unfollowMsgs.push(msg); return { ok: false, error: "wrong_account", me: "someone_else" }; });
    const r = await cleanupStep({ tabId: 3, settings, me: ME });
    assert.equal(unfollowMsgs.length, 1);
    assert.equal(unfollowMsgs[0].expectMe, ME);
    assert.equal(r.stop, STOP.WRONG_ACCOUNT);
    assert.match(r.detail, /someone_else/);
    const t = (await getTargets()).bob;
    assert.equal(t.rel.youFollow, true, "nothing changed on the target");
  });

  test("cleanup: an unknown X prompt at the unfollow click stops as unknown_prompt (not 'unusual activity')", async () => {
    const settings = await cleanupEnv(() => ({ ok: false, state: "unknown_prompt", detail: "Label AI content?", why: "dialog" }));
    const r = await cleanupStep({ tabId: 3, settings, me: ME });
    assert.equal(r.stop, STOP.UNKNOWN_PROMPT);
    assert.match(r.detail, /Label AI content/);
  });

  test("cleanup: an unreadable account at the unfollow click postpones that account for a day (no unfollow, no stop)", async () => {
    const settings = await cleanupEnv(() => ({ ok: false, error: "account_unknown" }));
    const r = await cleanupStep({ tabId: 3, settings, me: ME });
    assert.equal(r.did, "cleanup_skip");
    const t = (await getTargets()).bob;
    assert.ok(t.rel.cleanupSkipUntil > Date.now(), "postponed");
    assert.equal(t.rel.youFollow, true);
    assert.equal(((await getState()).unfollowTimes || []).length, 0);
  });

  test("cleanup: without account verification no expected account is sent", async () => {
    unfollowMsgs.length = 0;
    await cleanupEnv((msg) => { unfollowMsgs.push(msg); return { ok: true }; });
    const s = await getSettings();
    const settings = { ...s, account: { ...s.account, verifyAccount: false } };
    const r = await cleanupStep({ tabId: 3, settings, me: ME });
    assert.equal(r.did, "cleanup");
    assert.equal(unfollowMsgs[0].expectMe, undefined);
  });

  // ---- learn from my edits reaches the model as data ----
  test("generation: owner edits from posted replies go into the DATA block (and only when the setting is on)", async () => {
    await setup(env, { settings: { mode: "review" }, targets: { alice: notFollowing("alice") } });
    await H.put(H.newRecord({ status: HS.POSTED, target: "carol", postId: "1983000000000000009", comment: "Fees dropped because blobs got cheaper, not because demand fell", originalComment: "Great point! Fees are dropping a lot these days.", edited: true, postedAt: Date.now() - DAY }));
    const calls = mockOpenAI();
    const post = { id: POST_ID, url: `https://x.com/alice/status/${POST_ID}`, author: "alice", text: "L2 fees are at an all time low this week", createdAt: Date.now() - 5 * MIN, lang: "en" };
    env.content = async (msg, tab) => {
      const page = { ...env.page, url: tab.url };
      if (msg.sx === "waitFor") return { ok: true, key: msg.keys[0], page };
      if (msg.sx === "scrapeTweets") return { ok: true, tweets: [{ ...post, isRepost: false, isReply: false }], articleCount: 1, page };
      return { ok: true, page };
    };
    await patchState({ lastWatchAt: 0, nextCommentAt: 0 });
    await engine.tick("alarm");
    const gen = calls.find((b) => !(b.text && b.text.format && b.text.format.name === "scorex_check"));
    assert.ok(gen, "a generation call was made");
    const input = JSON.stringify(gen.input);
    assert.match(input, /owner_edits/);
    assert.match(input, /blobs got cheaper/);
    assert.doesNotMatch(String(gen.instructions || ""), /blobs got cheaper/, "edit text never reaches the instructions");

    // Off: no owner edits.
    calls.length = 0;
    const s = await getSettings();
    await save({ [K.settings]: { ...s, prompt: { ...s.prompt, learnFromEdits: false } } });
    await H.put(H.newRecord({ status: HS.SKIPPED, target: "alice", postId: POST_ID })); // keep the first post from being picked again
    const post2 = { ...post, id: "1983000000000000002", url: "https://x.com/alice/status/1983000000000000002", text: "Blob space is still underused" };
    env.content = async (msg, tab) => {
      const page = { ...env.page, url: tab.url };
      if (msg.sx === "waitFor") return { ok: true, key: msg.keys[0], page };
      if (msg.sx === "scrapeTweets") return { ok: true, tweets: [{ ...post2, isRepost: false, isReply: false }], articleCount: 1, page };
      return { ok: true, page };
    };
    await patchState({ lastWatchAt: 0, nextCommentAt: 0 });
    await engine.tick("alarm");
    const gen2 = calls.find((b) => !(b.text && b.text.format && b.text.format.name === "scorex_check"));
    if (gen2) assert.doesNotMatch(JSON.stringify(gen2.input), /owner_edits/);
  });
});

test("mergePosts keeps quote / media / card / link flags on stored recent posts (catch-up needs them)", () => {
  const t = newTarget("alice");
  mergePosts(t, [{ id: "1983000000000000003", text: "see this", createdAt: Date.now(), isQuote: true, hasMedia: true, hasCard: false, links: ["https://example.com/a", "https://example.com/b", "https://example.com/c", "https://example.com/d"] }]);
  const p = t.recentPosts[0];
  assert.equal(p.isQuote, true);
  assert.equal(p.hasMedia, true);
  assert.equal(p.hasCard, false);
  assert.deepEqual(p.links, ["https://example.com/a", "https://example.com/b", "https://example.com/c"]);
  mergePosts(t, [{ id: "1983000000000000004", text: "plain" }]);
  const q = t.recentPosts.find((x) => x.id === "1983000000000000004");
  assert.equal(q.isQuote, false);
  assert.deepEqual(q.links, []);
});
