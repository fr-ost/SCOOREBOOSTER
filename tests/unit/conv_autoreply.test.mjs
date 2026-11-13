// Automatic answers to replies to your comments (settings.learning.conversations.autoReply): each new item in
// sx.conversations gets an answer written from the thread (the post, your comment, their reply). Full auto queues and
// posts it under their reply; Review mode puts it in the review queue. Insults and replies that need no answer are
// skipped (done, with the reason); after maxTurns answers the conversation is left to you.
import { resetStorage, rawGet } from "./_chrome.mjs";
import { install, mockOpenAI } from "./_engine_env.mjs";
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useMemoryDb } from "../../extension/lib/db.js";
import * as H from "../../extension/lib/history.js";
import * as engine from "../../extension/lib/engine.js";
import * as gen from "../../extension/lib/generator.js";
import { pendingAnswers, matchMentions } from "../../extension/lib/conversations.js";
import { getState, patchState, save, setSecrets, sanitizeSettings } from "../../extension/lib/store.js";
import { K, HS, STATUS } from "../../extension/lib/constants.js";
import { newTarget, applyFollow } from "../../extension/lib/targets.js";
import { MIN, HOUR, DAY } from "../../extension/lib/util.js";

const ME = "0x_nation";
const POST_ID = "1983000000000000001", MY_REPLY_ID = "1983000000000000050", THEIR_REPLY_ID = "1983000000000000077";
const THEIR_URL = `https://x.com/alice/status/${THEIR_REPLY_ID}`;
const ANSWER = "fair, which chapter covers the fee side";
const base = (mode) => ({
  mode, genRev: 3, account: { handle: ME, verifyAccount: true },
  watch: { strategy: "list", listUrls: ["https://x.com/i/lists/1234567890"], scrolls: 0, catchUp: { enabled: false } },
  safety: { activeHours: { enabled: false }, breaks: { enabled: false }, readDelaySec: { min: 1, max: 1 }, typingCpm: { min: 550, max: 600 }, like: { enabled: true } },
  learning: { enabled: false, conversations: { enabled: true, everyMin: 240, autoReply: true, maxTurns: 2 } }, review: { notifyNew: false },
});
const followed = (h) => { const t = applyFollow(newTarget(h), false, Date.now() - DAY); t.rel.youFollow = true; t.rel.youFollowVerifiedAt = Date.now() - HOUR; return t; };

describe("automatic answers to replies to your comments", () => {
  let env;
  before(() => { env = install(); });
  after(() => env.uninstall());
  beforeEach(() => { env.tabs.clear(); env.navigations.length = 0; env.commands.length = 0; env.notifications.length = 0; env.page = { state: "ok", detail: "", me: ME, hidden: false }; });
  afterEach(async () => { await engine.pause().catch(() => {}); });

  // You commented on alice's post an hour ago; she answered 20 minutes ago (already found on your mentions page).
  async function setup({ mode = "auto", text = "They are there. Play with it. And read the book.", conv = {}, parent = {} } = {}) {
    resetStorage();
    useMemoryDb();
    const s = base(mode);
    s.learning.conversations = { ...s.learning.conversations, ...conv };
    await save({ [K.settings]: s, [K.targets]: { alice: followed("alice") } });
    await setSecrets({ openaiKey: "sk-test-1234567890abcdef" });
    const rec = await H.put(H.newRecord({ status: HS.POSTED, target: "alice", group: "B", tier: 2, postId: POST_ID, postUrl: `https://x.com/alice/status/${POST_ID}`, postText: "Most L2 fee charts miss where the cost really sits.",
      comment: "where do the sequencer costs show up in these", replyId: MY_REPLY_ID, replyUrl: `https://x.com/${ME}/status/${MY_REPLY_ID}`, postedAt: Date.now() - HOUR, createdAt: Date.now() - HOUR - MIN, attempts: 1, ...parent }));
    await save({ [K.conversations]: { items: [{ id: rec.id, target: "alice", comment: rec.comment, replyUrl: rec.replyUrl, authorReplyUrl: THEIR_URL, authorReplyId: THEIR_REPLY_ID, text, lang: "en", at: Date.now() - 20 * MIN, done: false }], seen: [THEIR_REPLY_ID], checkedAt: Date.now() } });
    env.addTab({ id: 3, url: "https://x.com/home", pinned: true, index: 0 });
    await patchState({ status: STATUS.RUNNING, firstStartedAt: Date.now() - 20 * DAY, workerTabId: 3, workerTabPinned: true, workerTabIndex: 0, workerTabFreshAt: Date.now(), followBadgeOkAt: Date.now(), followersScanAt: Date.now(), lastWatchAt: Date.now(), lastMentionsAt: Date.now(), lastCommentAt: 0, nextCommentAt: 0 });
    return rec;
  }
  // X: their reply's page is a thread (the post, your comment, then their reply as the focal post).
  function xPage() {
    const box = { text: "" };
    env.content = async (msg, tab) => {
      const page = { ...env.page, url: tab.url };
      switch (msg.sx) {
        case "waitFor": return { ok: true, key: msg.keys[0], page };
        case "scrapeTweets": return { ok: true, tweets: [], articleCount: 0, page };
        case "scrapeStatus": return { ok: true, focal: { id: THEIR_REPLY_ID, text: "They are there.", liked: false }, focalIndex: 2, canReply: true, myReplies: [], page };
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
  const convRec = async () => (await H.all()).find((r) => r.conversation);
  const item = () => rawGet(K.conversations).items[0];
  const dataOf = (body) => JSON.parse(body.input[0].content[0].text.match(/<<<DATA\n([\s\S]*)\nDATA>>>/)[1]);

  test("Full auto: the answer is written from the thread, queued, and posted under their reply; the item is done", async () => {
    const parent = await setup();
    xPage();
    const calls = mockOpenAI(ANSWER);
    await engine.tick("alarm");
    let r = await convRec();
    assert.ok(r, "an answer was written");
    assert.deepEqual([r.status, r.target, r.postId, r.postUrl, r.comment, r.convParentId, r.convDepth], [HS.QUEUED, "alice", THEIR_REPLY_ID, THEIR_URL, ANSWER, parent.id, 1]);
    assert.equal(r.postText, "They are there. Play with it. And read the book.", "the 'post' it answers is their reply");
    const g = calls.find((c) => !(c.text && c.text.format));
    assert.ok(g.instructions.includes("=== THIS IS A CONVERSATION ===") && g.instructions.includes("Never reply to an insult"));
    assert.ok(!g.instructions.includes("THE GOAL OF THIS REPLY"), "not the first-comment prompt");
    const d = dataOf(g);
    assert.deepEqual(d.conversation, { original_post: "Most L2 fee charts miss where the cost really sits.", your_earlier_reply: "where do the sequencer costs show up in these" });
    assert.equal(d.post.text, "They are there. Play with it. And read the book.");
    assert.deepEqual([item().done, item().auto], [true, "queued"], "no longer under Needs you");
    // It posts on its own, inside the thread (their reply is not the original post).
    await H.patch(r.id, { scheduledFor: 0 });
    await patchState({ nextCommentAt: 0, lastCommentAt: 0 });
    await engine.tick("alarm");
    r = await H.get(r.id);
    assert.equal(r.status, HS.POSTED, r.reason);
    assert.equal(env.cmds("submitReply")[0][1], THEIR_URL, "the reply is sent on their reply's page");
    assert.equal((await getState()).status, STATUS.RUNNING);
    // Answered once: nothing more is written for the same reply.
    const n = calls.length;
    await engine.tick("alarm");
    assert.equal(calls.length, n);
    assert.equal((await H.all()).filter((x) => x.conversation).length, 1);
  });

  test("Review mode: the answer waits in the review queue (nothing is posted)", async () => {
    await setup({ mode: "review" });
    xPage();
    mockOpenAI(ANSWER);
    await engine.tick("alarm");
    const r = await convRec();
    assert.equal(r.status, HS.PENDING_REVIEW);
    assert.equal(item().auto, "queued");
    assert.equal(env.cmds("submitReply").length, 0);
  });

  test("an insult (the model answers SKIP) is never replied to: the item is done with the reason", async () => {
    await setup({ text: "Sounds like a weak company you're describing, clown." });
    xPage();
    mockOpenAI("SKIP");
    await engine.tick("alarm");
    const r = await convRec();
    assert.equal(r.status, HS.SKIPPED);
    assert.deepEqual([item().done, item().auto], [true, "skipped"]);
    assert.match(item().autoNote, /needs no answer, or is hostile/);
    assert.equal(env.cmds("submitReply").length, 0);
  });

  test("the switch off, an old reply, a long conversation or a removed target: nothing is written", async () => {
    let calls;
    await setup({ conv: { autoReply: false } }); xPage(); calls = mockOpenAI(ANSWER);
    await engine.tick("alarm");
    assert.equal(calls.length, 0, "switch off");
    assert.equal(item().done, false, "stays under Needs you");

    await setup(); xPage(); calls = mockOpenAI(ANSWER);
    await save({ [K.conversations]: { ...rawGet(K.conversations), items: [{ ...item(), at: Date.now() - 49 * HOUR }] } });
    await engine.tick("alarm");
    assert.equal(calls.length, 0, "older than 48 hours");

    // Your comment was itself the 2nd automatic answer in this conversation: the 3rd is yours.
    await setup({ parent: { conversation: true, convDepth: 2, convContext: { original: "the post", mine: "earlier" } } }); xPage(); calls = mockOpenAI(ANSWER);
    await engine.tick("alarm");
    assert.equal(calls.length, 0);
    assert.deepEqual([item().done, item().auto], [false, "skipped"], "left to you, with the note");
    assert.match(item().autoNote, /already answered 2 times/);

    await setup(); xPage(); calls = mockOpenAI(ANSWER);
    await save({ [K.targets]: {} });
    await engine.tick("alarm");
    assert.equal(calls.length, 0);
    assert.match(item().autoNote, /no longer one of your targets/);
  });

  test("answers count toward the daily total, not toward the account's own comment limits; their next reply continues the chain", async () => {
    const parent = await setup();
    xPage();
    mockOpenAI(ANSWER);
    await engine.tick("alarm");
    const r = await convRec();
    await H.patch(r.id, { status: HS.POSTED, postedAt: Date.now() - MIN, replyId: "1983000000000000999" });
    const counts = await engine.computeCounts(sanitizeSettings(base("auto")), Date.now());
    assert.equal(counts.postedToday, 2, "your comment and the answer");
    assert.equal(counts.targets.alice.day, 1, "only the comment counts for alice's own limit");
    // Her next reply is matched to your newest reply to her: the answer (so the depth carries on).
    const recs = await H.all();
    const m = matchMentions([{ id: "1983000000000000200", author: "alice", text: "ch 4", createdAt: Date.now(), url: "https://x.com/alice/status/1983000000000000200" }], recs, { me: ME });
    assert.equal(m[0].rec.id, r.id);
    assert.notEqual(m[0].rec.id, parent.id);
  });

  test("prompt pieces: conversation instructions and data; pendingAnswers picks open, recent, unhandled items", () => {
    const s = sanitizeSettings({});
    assert.deepEqual([s.learning.conversations.autoReply, s.learning.conversations.maxTurns], [true, 2], "on by default, 2 answers per conversation");
    const ins = gen.buildInstructions({ settings: s, toneText: "Bold.", myHandle: ME, conversation: true });
    assert.ok(ins.includes("\nBold.\n") && ins.includes("4 to 16 words") && ins.includes("output only the word SKIP") && ins.includes("Security:"));
    assert.ok(ins.includes("Never claim you did, read, used or will do something specific"));
    const ck = gen.buildCheck({ post: { author: "alice", text: "read the book" }, comment: "which chapter", avoid: [], conversation: { original: "post", mine: "mine" } });
    assert.ok(/conversation/.test(ck.instructions) && ck.input.includes("your_earlier_reply"));
    const ts = Date.now();
    const it = (o) => ({ id: "x", authorReplyId: "1", authorReplyUrl: "https://x.com/a/status/1", at: ts - HOUR, done: false, ...o });
    assert.equal(pendingAnswers({ items: [it({}), it({ done: true }), it({ auto: "queued" }), it({ at: ts - 3 * DAY }), it({ authorReplyUrl: "" })] }, ts).length, 1);
  });
});
