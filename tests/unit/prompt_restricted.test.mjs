// Posts whose replies are restricted ("Who can reply? Only some accounts can reply") are skipped - never an error,
// never a stop. A prompt X shows that ScoreX does not know is never clicked; with "Stop when errors repeat" off (the
// default) it does not stop the engine either: that post is skipped (or kept as "may have been sent" after the Reply
// click), you get a notification (at most once an hour) and replies wait 10, 20, 40, then 60 minutes. With the switch
// on it stops, as before.
import { resetStorage } from "./_chrome.mjs";
import { install } from "./_engine_env.mjs";
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useMemoryDb } from "../../extension/lib/db.js";
import * as H from "../../extension/lib/history.js";
import * as engine from "../../extension/lib/engine.js";
import { getState, patchState, save, setSecrets } from "../../extension/lib/store.js";
import { K, HS, STATUS } from "../../extension/lib/constants.js";
import { newTarget, applyFollow } from "../../extension/lib/targets.js";
import { _setClock, MIN, HOUR, DAY } from "../../extension/lib/util.js";

const ME = "0x_nation";
const POST_ID = "1983000000000000001";
const TEXT = "ngl the timing on this is what makes it work, the rest is noise";
const base = {
  mode: "auto", genRev: 3, account: { handle: ME, verifyAccount: true },
  watch: { strategy: "list", listUrls: ["https://x.com/i/lists/1234567890"], scrolls: 0, catchUp: { enabled: false } },
  safety: { activeHours: { enabled: false }, breaks: { enabled: false }, readDelaySec: { min: 1, max: 1 }, typingCpm: { min: 550, max: 600 }, like: { enabled: true } },
  learning: { enabled: false, conversations: { enabled: false } }, review: { notifyNew: false },
};
// A target you follow (seen on its profile an hour ago): no follow-first visit, straight to the post.
const followed = (h) => { const t = applyFollow(newTarget(h), false, Date.now() - DAY); t.rel.youFollow = true; t.rel.youFollowVerifiedAt = Date.now() - HOUR; return t; };
const PROMPT = { ok: false, state: "unknown_prompt", detail: "Before you reply: something new from X. Continue?" };
const RESTRICTED = { ok: false, error: "replies_restricted", detail: "Who can reply? Only some accounts can reply. Got It" };

describe("restricted replies and unknown prompts never stop ScoreX by default", () => {
  let env;
  before(() => { env = install(); });
  after(() => env.uninstall());
  beforeEach(() => { env.tabs.clear(); env.navigations.length = 0; env.commands.length = 0; env.notifications.length = 0; env.page = { state: "ok", detail: "", me: ME, hidden: false }; });
  afterEach(async () => { _setClock(null); await engine.pause().catch(() => {}); });

  async function setup({ safety = {}, targets = ["alice", "bob", "carol"] } = {}) {
    resetStorage();
    useMemoryDb();
    await save({ [K.settings]: { ...base, safety: { ...base.safety, ...safety } } });
    await setSecrets({ openaiKey: "sk-test-1234567890abcdef" });
    await save({ [K.targets]: Object.fromEntries(targets.map((h) => [h, followed(h)])) });
    env.addTab({ id: 3, url: "https://x.com/home", pinned: true, index: 0 });
    await patchState({ status: STATUS.RUNNING, firstStartedAt: Date.now() - 20 * DAY, workerTabId: 3, workerTabPinned: true, workerTabIndex: 0, workerTabFreshAt: Date.now(), followBadgeOkAt: Date.now(), followersScanAt: Date.now() });
  }
  // The X page: every step answers normally, except `over` (cmd -> answer).
  function xPage(over = {}) {
    const box = { text: "" };
    env.content = async (msg, tab) => {
      const page = { ...env.page, url: tab.url };
      if (over[msg.sx]) return { ...over[msg.sx](msg), page };
      switch (msg.sx) {
        case "waitFor": return { ok: true, key: msg.keys[0], page };
        case "scrapeTweets": return { ok: true, tweets: [], articleCount: 0, page };
        case "scrapeStatus": return { ok: true, focal: { id: POST_ID, text: "Most teams ship features.", liked: false }, focalIndex: 0, canReply: true, myReplies: [], page };
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
  async function post(target) {
    const rec = await H.put(H.newRecord({ status: HS.QUEUED, target, group: "B", postId: POST_ID, postUrl: `https://x.com/${target}/status/${POST_ID}`, comment: TEXT, attempts: 1, postCreatedAt: Date.now() - 5 * MIN, scheduledFor: 0 }));
    await patchState({ nextCommentAt: 0, lastCommentAt: 0, lastWatchAt: Date.now() });
    await engine.tick("alarm");
    return H.get(rec.id);
  }
  const submits = () => env.cmds("submitReply").length;

  test("\"Who can reply?\" (under the post, at the reply box, or after the click): skipped, ScoreX keeps running", async () => {
    await setup();
    xPage({ scrapeStatus: () => ({ ok: true, focal: { id: POST_ID, text: "x", liked: false }, focalIndex: 0, canReply: false, myReplies: [] }) });
    let r = await post("alice");
    assert.equal(r.status, HS.SKIPPED);
    assert.match(r.reason, /Replies are restricted on this post/);
    xPage({ openComposer: () => RESTRICTED });
    r = await post("bob");
    assert.equal(r.status, HS.SKIPPED);
    assert.match(r.reason, /restricted/);
    xPage({ replyResult: () => ({ ...RESTRICTED, cleared: false, sent: false }) });
    r = await post("carol");
    assert.equal(r.status, HS.SKIPPED, "X answered the click with the notice: it refused the reply");
    const st = await getState();
    assert.equal(st.status, STATUS.RUNNING);
    assert.equal(st.alert || null, null);
    assert.equal(st.promptStreak || 0, 0, "not a prompt: no back-off");
    assert.equal(env.notifications.length, 0, "nothing to notify");
  });

  test("an unknown prompt, switch off: nothing clicked, the post is skipped, a notification, replies wait 10 then 20 minutes; a reply resets it", async () => {
    await setup();
    xPage({ openComposer: () => PROMPT });
    const t0 = Date.now();
    let r = await post("alice");
    assert.equal(r.status, HS.SKIPPED);
    assert.match(r.reason, /prompt ScoreX does not know - skipped, nothing was clicked: Before you reply/);
    let st = await getState();
    assert.equal(st.status, STATUS.RUNNING, "not stopped");
    assert.equal(st.alert || null, null);
    assert.equal(st.promptStreak, 1);
    assert.ok(st.nextCommentAt >= t0 + 10 * MIN && st.nextCommentAt < t0 + 11 * MIN, "replies wait 10 minutes");
    assert.equal(st.workerTabFreshAt, 0, "the next check starts in a fresh X tab");
    assert.equal(submits(), 0, "nothing was submitted");
    assert.equal(env.notifications.filter((n) => n.id === "sx-prompt").length, 1, "you are told");
    r = await post("bob");
    st = await getState();
    assert.equal(r.status, HS.SKIPPED);
    assert.equal(st.promptStreak, 2);
    assert.ok(st.nextCommentAt >= Date.now() + 19 * MIN, "the second in a row waits 20 minutes");
    assert.equal(env.notifications.filter((n) => n.id === "sx-prompt").length, 1, "at most one notification an hour");
    xPage();
    r = await post("carol");
    assert.equal(r.status, HS.POSTED);
    assert.equal((await getState()).promptStreak, 0, "a reply that goes through resets the wait");
  });

  test("an unknown prompt after the Reply click that may have sent it: kept as 'may have been sent', no stop", async () => {
    await setup();
    xPage({ replyResult: () => ({ ...PROMPT, cleared: true, sent: false }) });
    const r = await post("alice");
    assert.equal(r.status, HS.FAILED);
    assert.equal(r.maybePosted, true, "counts toward the limits");
    assert.match(r.reason, /after the Reply click \(it may have been sent\)/);
    assert.equal((await getState()).status, STATUS.RUNNING);
  });

  test("switch on: the same unknown prompt stops ScoreX, as before", async () => {
    await setup({ safety: { stopOnErrors: true } });
    xPage({ openComposer: () => PROMPT });
    const r = await post("alice");
    const st = await getState();
    assert.equal(st.status, STATUS.STOPPED);
    assert.equal(st.stopReason, "unknown_prompt");
    assert.equal(r.status, HS.FAILED);
  });

  test("X's explicit warnings still stop, whatever the switch: a rate-limit toast after Reply", async () => {
    await setup();
    xPage({ replyResult: () => ({ ok: false, state: "rate_limit", detail: "You are over the daily limit for sending posts." }) });
    await post("alice");
    const st = await getState();
    assert.equal(st.status, STATUS.STOPPED);
    assert.equal(st.stopReason, "rate_limit");
  });
});
