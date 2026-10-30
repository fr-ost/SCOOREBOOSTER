// Conversation alerts: matching mentions to your replies (pure), conversationsStep on a fake X tab (mentions page read,
// sx.conversations items, history marked, dedupe, notification, cadence, Pause/Stop, safety pages, nothing posted).
import { resetStorage, rawGet } from "./_chrome.mjs";
import { install } from "./_fake_xtab.mjs";
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useMemoryDb } from "../../extension/lib/db.js";
import * as H from "../../extension/lib/history.js";
import * as C from "../../extension/lib/conversations.js";
import { sanitizeSettings, save, patchState } from "../../extension/lib/store.js";
import { footprintAdd } from "../../extension/lib/tabs.js";
import { K } from "../../extension/lib/constants.js";
import { HOUR, MIN, _setClock } from "../../extension/lib/util.js";

const NOW = Date.UTC(2026, 9, 30, 8, 0);
const settings = sanitizeSettings({});
const posted = (id, target, ageH, extra = {}) => ({ id, status: "posted", target, postedAt: NOW - ageH * HOUR, createdAt: NOW - ageH * HOUR - MIN, comment: "my reply to " + target, replyUrl: `https://x.com/0x_nation/status/${id}9`, replyId: id + "9", results: {}, ...extra });
const tweet = (id, author, agoH, text = "answer from " + author, extra = {}) => ({ id, author, url: `https://x.com/${author}/status/${id}`, text, createdAt: NOW - agoH * HOUR, isReply: true, isRepost: false, ...extra });

describe("matchMentions / cleanText", () => {
  test("answers from accounts you replied to in the last 72 h, matched to your newest reply before them", () => {
    const recs = [posted("a1", "alice", 30), posted("a2", "alice", 5), posted("b1", "bob", 100), { ...posted("c1", "carol", 2), status: "skipped" }];
    const tweets = [
      tweet("t1", "alice", 1), // answers a2 (the newest reply before it)
      tweet("t2", "alice", 20), // older than a2, newer than a1 -> answers a1
      tweet("t3", "alice", 40), // before any reply to alice: not an answer
      tweet("t4", "bob", 1), // your reply to bob is older than 72 h
      tweet("t5", "carol", 1), // not posted
      tweet("t6", "alice", 1, "rt", { isRepost: true }),
      tweet("t7", "0x_nation", 1),
      tweet("t8", "dave", 1),
      tweet("t1", "alice", 1), // duplicate cell
    ];
    const m = C.matchMentions(tweets, recs, { me: "0x_nation", ts: NOW });
    assert.deepEqual(m.map((x) => `${x.tweet.id}->${x.rec.id}`), ["t2->a1", "t1->a2"], "oldest answer first");
    assert.deepEqual(C.matchMentions(tweets, recs, { me: "0x_nation", ts: NOW, seen: new Set(["t1", "t2"]) }), []);
    const noTime = C.matchMentions([{ ...tweet("t9", "alice", 0), createdAt: null }], recs, { ts: NOW });
    assert.equal(noTime[0].rec.id, "a2", "unknown time: your newest reply");
  });
  test("cleanText: plain text without control / bidi characters, max 280", () => {
    assert.equal(C.cleanText("hi\u0000 there\n\n‮evil⁦ <b>x</b>"), "hi there evil <b>x</b>");
    assert.equal(C.cleanText("x".repeat(500)).length, 280);
    assert.equal(C.cleanText(null), "");
    assert.equal(C.cleanText("👨‍👩‍👧 ok"), "👨‍👩‍👧 ok", "emoji joiners are kept");
  });
});

describe("conversationsStep", () => {
  let fx, mentions, pageState;
  before(() => {
    fx = install({
      content: async (url, msg) => {
        if (msg.sx === "waitFor") return mentions.length ? { ok: true, key: "tweet" } : { ok: true, key: "emptyState" };
        if (msg.sx === "scrapeTweets") return { ok: true, tweets: mentions, articleCount: mentions.length, unparsed: 0 };
        return { ok: true };
      },
    });
  });
  after(() => fx.uninstall());
  beforeEach(() => {
    resetStorage(); useMemoryDb(); _setClock(() => NOW);
    fx.navigations.length = 0; fx.commands.length = 0; fx.notifications.length = 0;
    fx.page.state = "ok"; fx.page.detail = "";
    mentions = [];
  });
  afterEach(() => _setClock(null));
  after(() => { resetStorage(); useMemoryDb(); }); // later test files start from clean storage / DB
  const run = (extra = {}) => C.conversationsStep({ tabId: 7, settings, me: "0x_nation", ...extra });

  test("reads the mentions page, lists the answer, marks your reply, notifies - and never posts", async () => {
    await H.put(posted("a2", "alice", 5));
    mentions = [tweet("t1", "alice", 1, "Great point!\u0000 What would you do‮ instead?"), tweet("t8", "dave", 1)];
    const r = await run();
    assert.deepEqual(r, { did: "mentions", ok: true, found: 1 });
    assert.deepEqual(fx.navigations, [C.MENTIONS_URL]);
    const conv = rawGet(K.conversations);
    assert.equal(conv.checkedAt, NOW);
    assert.equal(conv.items.length, 1);
    const it = conv.items[0];
    assert.deepEqual(
      { id: it.id, target: it.target, comment: it.comment, replyUrl: it.replyUrl, authorReplyUrl: it.authorReplyUrl, text: it.text, at: it.at, done: it.done },
      { id: "a2", target: "alice", comment: "my reply to alice", replyUrl: "https://x.com/0x_nation/status/a29", authorReplyUrl: "https://x.com/alice/status/t1", text: "Great point! What would you do instead?", at: NOW - HOUR, done: false },
    );
    const rec = await H.get("a2");
    assert.equal(rec.results.authorReplied, true);
    assert.equal(rec.results.authorReplyUrl, "https://x.com/alice/status/t1");
    assert.equal(fx.notifications.length, 1);
    assert.equal(fx.notifications[0].title, "@alice replied to your comment");
    const acted = fx.commands.filter((c) => ["like", "openComposer", "type", "submitReply", "unfollow", "scroll"].includes(c[0]));
    assert.deepEqual(acted, [], "read only");
    assert.equal(rawGet(K.state).lastMentionsAt, NOW);
  });

  test("every everyMin minutes at most; the same answer is never reported twice; a newer one reopens the item", async () => {
    await H.put(posted("a2", "alice", 5));
    mentions = [tweet("t1", "alice", 1)];
    await run();
    assert.equal(await run(), null, "not due yet: no page load");
    assert.equal(fx.navigations.length, 1);
    await C.markDone("a2");
    _setClock(() => NOW + 41 * MIN);
    const again = await run();
    assert.deepEqual(again, { did: "mentions", ok: true, found: 0 });
    let conv = rawGet(K.conversations);
    assert.equal(conv.items.length, 1);
    assert.equal(conv.items[0].done, true, "an answer seen before does not reopen it");
    assert.equal(fx.notifications.length, 1);
    mentions = [tweet("t2", "alice", 0.2, "One more thought"), tweet("t1", "alice", 1)];
    _setClock(() => NOW + 90 * MIN);
    assert.equal((await run()).found, 1);
    conv = rawGet(K.conversations);
    assert.equal(conv.items.length, 1, "one item per reply of yours");
    assert.deepEqual([conv.items[0].text, conv.items[0].done, conv.items[0].authorReplyUrl], ["One more thought", false, "https://x.com/alice/status/t2"]);
    assert.ok(conv.seen.includes("t1") && conv.seen.includes("t2"));
  });

  test("no page load without replies in the last 72 h, while a 'check now' is pending, when off, or after Pause/Stop", async () => {
    await H.put(posted("old", "alice", 80));
    assert.equal(await run(), null);
    await H.put(posted("a2", "alice", 5));
    await patchState({ learningForce: true });
    assert.equal(await run(), null);
    await patchState({ learningForce: false });
    assert.equal(await C.conversationsStep({ tabId: 7, settings: sanitizeSettings({ learning: { conversations: { enabled: false } } }), me: "0x_nation" }), null);
    assert.equal(await run({ shouldStop: async () => true }), null);
    assert.deepEqual(fx.navigations, []);
    assert.equal(rawGet(K.state).lastMentionsAt, null);
  });

  test("X page-load budget reached: nothing loaded, no warning, read again when due", async () => {
    await H.put(posted("a2", "alice", 5));
    await save({ [K.settings]: { safety: { maxPageLoads24h: 1 } } });
    await patchState({ footprint: footprintAdd(null, "watch", NOW) });
    assert.equal(await run(), null);
    assert.deepEqual(fx.navigations, []);
    assert.doesNotMatch(JSON.stringify(rawGet(K.logs) || []), /did not load/);
  });

  test("an X safety page stops; an empty mentions page is a normal read", async () => {
    await H.put(posted("a2", "alice", 5));
    fx.page.state = "captcha"; fx.page.detail = "Verify you are human";
    assert.deepEqual(await run(), { stop: "captcha", detail: "Verify you are human" });
    fx.page.state = "ok";
    _setClock(() => NOW + HOUR);
    assert.deepEqual(await run(), { did: "mentions", ok: true, found: 0 });
    assert.equal(fx.commands.filter((c) => c[0] === "scrapeTweets").length, 0, "nothing to scrape on an empty page");
  });

  test("keeps the newest 200 items; several answers make one notification", async () => {
    const old = Array.from({ length: 205 }, (_, i) => ({ id: "o" + i, target: "x", comment: "", replyUrl: "", authorReplyUrl: "", authorReplyId: "ot" + i, text: "", at: NOW - (i + 10) * HOUR, done: true }));
    await save({ [K.conversations]: { items: old, checkedAt: null } });
    await H.put(posted("a2", "alice", 5));
    await H.put(posted("b2", "bob", 6));
    mentions = [tweet("t1", "alice", 1), tweet("t3", "bob", 2)];
    assert.equal((await run()).found, 2);
    const conv = rawGet(K.conversations);
    assert.equal(conv.items.length, 200);
    assert.deepEqual(conv.items.slice(0, 2).map((x) => x.id), ["a2", "b2"], "newest first");
    assert.equal(fx.notifications.length, 1);
    assert.match(fx.notifications[0].title, /2 replies to your comments/);
  });
});
