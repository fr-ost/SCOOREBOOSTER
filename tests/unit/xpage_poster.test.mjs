// Posting flow (lib/poster.js) against a scripted fake X tab: unclear results after the Reply click count as
// "may have been sent" (XP-3), unknown X prompts stop without touching the page, and nothing is liked, typed or
// submitted unless the page is logged in as your account (ENG-2 / XP-6).
import "./_chrome.mjs";
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetStorage } from "./_chrome.mjs";
import { fakeTab, fast, okPage, NEVER } from "./_xtab.mjs";
import { postReply } from "../../extension/lib/poster.js";
import { sanitizeSettings, saveSettings, patchState } from "../../extension/lib/store.js";
import { STOP } from "../../extension/lib/constants.js";

const TID = "1900000000000000001";
const TEXT = "Distribution compounds, but only after activation works. What did your first 100 users share?";
const rec = { id: "r1", postId: TID, postUrl: `https://x.com/bigbob/status/${TID}`, comment: TEXT, target: "bigbob" };
const SENT = { ok: true, replyId: "1900000000000000999", replyUrl: "https://x.com/0x_nation/status/1900000000000000999", via: "toast" };

function xPage(over = {}) {
  const box = { text: "" };
  return {
    waitFor: () => ({ ok: true, key: "tweet" }),
    scrapeStatus: () => ({ ok: true, focal: { id: TID, text: "Most teams ship features.", liked: false }, focalIndex: 0, replies: [], canReply: true, myReplies: [] }),
    scroll: () => ({ ok: true }),
    like: () => ({ ok: true }),
    openComposer: () => ({ ok: true, where: "inline", text: "" }),
    type: (m) => { box.text += m.text; return { ok: true, text: box.text }; },
    composerText: () => ({ ok: true, text: box.text }),
    clearComposer: () => { box.text = ""; return { ok: true, text: "" }; },
    closeComposer: () => ({ ok: true }),
    submitReply: () => ({ ok: true, where: "inline" }),
    replyResult: () => SENT,
    ...over,
  };
}

const settings = (patch = {}) => sanitizeSettings({ safety: { readDelaySec: { min: 1, max: 1 } }, ...patch });
const run = (env, s = settings(), extra = {}) => postReply(rec, { tabId: env.tab.id, settings: s, me: "0x_nation", allowLike: true, ...extra });

describe("poster: unclear result after the Reply click (XP-3)", () => {
  beforeEach(() => resetStorage());

  test("a confirmed reply is posted (baseline)", async (t) => {
    fast(t);
    const env = fakeTab(xPage());
    const r = await run(env);
    assert.equal(r.ok, true);
    assert.equal(r.replyId, SENT.replyId);
    assert.equal(env.count("submitReply"), 1);
  });

  test("no answer from the tab after submitting -> failed but counted as maybe sent (unsure)", async (t) => {
    fast(t);
    const env = fakeTab(xPage({ replyResult: NEVER }));
    const r = await run(env);
    assert.equal(r.ok, false);
    assert.equal(r.fail, true);
    assert.equal(r.unsure, true, "an unanswered confirmation after the click must count toward the limits");
    assert.equal(r.reason, "no_answer_after_submit");
    assert.equal(env.count("submitReply"), 1, "never re-submitted");
  });

  test("text still in the box (X still sending) -> waits once more, then unsure", async (t) => {
    fast(t);
    const env = fakeTab(xPage({ replyResult: () => ({ ok: false, error: "not_confirmed", cleared: false }) }));
    const r = await run(env);
    assert.equal(env.count("replyResult"), 2, "a second wait before leaving the page");
    assert.equal(r.fail, true);
    assert.equal(r.unsure, true);
    assert.equal(r.reason, "not_confirmed");
    assert.equal(env.count("submitReply"), 1);
  });

  test("a late confirmation on the second wait is a success", async (t) => {
    fast(t);
    let n = 0;
    const env = fakeTab(xPage({ replyResult: () => (++n === 1 ? { ok: false, error: "not_confirmed", cleared: false } : SENT) }));
    const r = await run(env);
    assert.equal(r.ok, true);
    assert.equal(env.count("navigate"), 1, "no reload needed");
  });

  test("the thread re-check still finds the reply -> success", async (t) => {
    fast(t);
    let reads = 0;
    const env = fakeTab(xPage({
      replyResult: NEVER,
      scrapeStatus: () => ({ ok: true, focal: { id: TID, text: "x", liked: false }, focalIndex: 0, canReply: true, replies: [],
        myReplies: ++reads > 1 ? [{ id: "1900000000000000777", url: "https://x.com/0x_nation/status/1900000000000000777", text: TEXT }] : [] }),
    }));
    const r = await run(env);
    assert.equal(r.ok, true);
    assert.equal(r.via, "recheck");
  });

  test("X explicitly refused it: duplicate -> failure that does not count; warning toast -> stop, not unsure", async (t) => {
    fast(t);
    let env = fakeTab(xPage({ replyResult: () => ({ ok: false, error: "duplicate", detail: "Whoops! You already said that." }) }));
    let r = await run(env);
    assert.equal(r.fail, true);
    assert.ok(!r.unsure);
    env = fakeTab(xPage({ replyResult: () => ({ ok: false, state: "warning", detail: "This request looks like it might be automated." }) }));
    r = await run(env);
    assert.equal(r.stop, STOP.WARNING);
    assert.ok(!r.unsure);
  });
});

describe("poster: unknown X prompts (fail closed)", () => {
  beforeEach(() => resetStorage());
  const PROMPT = { ok: false, state: "unknown_prompt", detail: "Add an AI label? Posts made with AI may be hidden." };

  test("a prompt instead of the reply box -> UNKNOWN_PROMPT stop, nothing typed or submitted", async (t) => {
    fast(t);
    const env = fakeTab(xPage({ openComposer: () => PROMPT }));
    const r = await run(env);
    assert.equal(r.stop, STOP.UNKNOWN_PROMPT);
    assert.equal(r.detail, PROMPT.detail, "the prompt's text sample is the stop detail");
    assert.equal(r.unsure, false);
    assert.deepEqual(env.after("openComposer"), [], "nothing else is sent to the page (no typing, no clicks, no cleanup)");
  });

  test("a prompt while typing -> stop, the rest is not typed and nothing is clicked", async (t) => {
    fast(t);
    let n = 0;
    const box = { text: "" };
    const env = fakeTab(xPage({ type: (m) => { if (++n === 3) return PROMPT; box.text += m.text; return { ok: true, text: box.text }; } }));
    const r = await run(env);
    assert.equal(r.stop, STOP.UNKNOWN_PROMPT);
    assert.equal(env.count("type"), 3);
    assert.deepEqual(env.after("type"), []);
    assert.equal(env.count("submitReply"), 0);
  });

  test("a prompt right before the click -> stop, Reply not clicked, no cleanup", async (t) => {
    fast(t);
    const env = fakeTab(xPage({ submitReply: () => PROMPT }));
    const r = await run(env);
    assert.equal(r.stop, STOP.UNKNOWN_PROMPT);
    assert.equal(r.unsure, false);
    assert.deepEqual(env.after("submitReply"), []);
  });

  test("a prompt after the click: not sent (box still full) -> maybePosted false; box cleared -> unsure", async (t) => {
    fast(t);
    let env = fakeTab(xPage({ replyResult: () => ({ ...PROMPT, cleared: false, sent: false }) }));
    let r = await run(env);
    assert.equal(r.stop, STOP.UNKNOWN_PROMPT);
    assert.equal(r.unsure, false);
    assert.deepEqual(env.after("replyResult"), [], "the prompt is left alone (no clear/close clicks)");
    env = fakeTab(xPage({ replyResult: () => ({ ...PROMPT, cleared: true, sent: false }) }));
    r = await run(env);
    assert.equal(r.stop, STOP.UNKNOWN_PROMPT);
    assert.equal(r.unsure, true);
    env = fakeTab(xPage({ replyResult: () => ({ ...PROMPT, cleared: false, sent: true, replyUrl: SENT.replyUrl }) }));
    r = await run(env);
    assert.equal(r.unsure, true, "sent toast + prompt: counted, but the engine still stops");
  });
});

describe("poster: logged-in account must match (ENG-2 / XP-6)", () => {
  beforeEach(() => resetStorage());

  test("unknown account on the post page -> soft account_unknown: nothing liked, typed or submitted", async (t) => {
    fast(t);
    const env = fakeTab(xPage(), { me: null });
    const r = await run(env);
    assert.equal(r.ok, false);
    assert.equal(r.soft, "account_unknown");
    assert.equal(r.reason, "account_unknown");
    assert.equal(r.retry, true, "not a posting failure: the item stays queued");
    assert.ok(!r.fail && !r.stop);
    for (const c of ["like", "openComposer", "type", "submitReply"]) assert.equal(env.count(c), 0, c + " must not run");
  });

  test("another account -> WRONG_ACCOUNT stop before anything is done", async (t) => {
    fast(t);
    const env = fakeTab(xPage(), { me: "someone_else" });
    const r = await run(env);
    assert.equal(r.stop, STOP.WRONG_ACCOUNT);
    assert.match(r.detail, /someone_else/);
    for (const c of ["like", "openComposer", "type", "submitReply"]) assert.equal(env.count(c), 0, c + " must not run");
  });

  test("the expected handle goes with like / open / submit, so the page re-checks right before each click", async (t) => {
    fast(t);
    const env = fakeTab(xPage());
    await run(env, settings({ account: { handle: "@0x_Nation", verifyAccount: true } }));
    for (const c of ["like", "openComposer", "submitReply"]) assert.equal(env.msgs(c)[0].expectMe, "0x_nation", c);
  });

  test("the page cannot read the account when opening the reply box -> soft, nothing typed", async (t) => {
    fast(t);
    const env = fakeTab(xPage({ openComposer: () => ({ ok: false, error: "account_unknown" }) }));
    const r = await run(env);
    assert.equal(r.soft, "account_unknown");
    assert.ok(!r.fail);
    assert.equal(env.count("type"), 0);
  });

  test("account unknown at the moment of submitting -> soft, typed text is cleared, never clicked", async (t) => {
    fast(t);
    const env = fakeTab(xPage({ submitReply: () => ({ ok: false, error: "account_unknown" }) }));
    const r = await run(env);
    assert.equal(r.soft, "account_unknown");
    assert.ok(!r.fail);
    assert.deepEqual(env.after("submitReply"), ["clearComposer", "closeComposer"]);
    assert.equal(env.count("replyResult"), 0);
  });

  test("a different account at the moment of submitting -> WRONG_ACCOUNT stop", async (t) => {
    fast(t);
    const env = fakeTab(xPage({ submitReply: () => ({ ok: false, error: "wrong_account", me: "other" }) }));
    const r = await run(env);
    assert.equal(r.stop, STOP.WRONG_ACCOUNT);
    assert.match(r.detail, /@other/);
  });

  test("verify account off: no handle check (the owner's choice)", async (t) => {
    fast(t);
    const env = fakeTab(xPage(), { me: null });
    const r = await run(env, settings({ account: { handle: "0x_nation", verifyAccount: false } }));
    assert.equal(r.ok, true);
    assert.equal(env.msgs("openComposer")[0].expectMe, undefined);
  });

  test("an unknown page report on the post page uses the page's me, not the URL", async (t) => {
    fast(t);
    const env = fakeTab(xPage({ scrapeStatus: () => ({ ok: true, focal: { id: TID, text: "x", liked: false }, focalIndex: 0, canReply: true, replies: [], myReplies: [], page: okPage(null) }) }));
    const r = await run(env);
    assert.equal(r.soft, "account_unknown");
  });
});

describe("poster: X page-load budget", () => {
  beforeEach(() => resetStorage());

  test("a post page refused by the page-load budget waits (not a failure) and nothing is sent to X", async (t) => {
    fast(t);
    const s = settings({ safety: { readDelaySec: { min: 1, max: 1 }, maxPageLoads24h: 1 } });
    await saveSettings(s);
    await patchState({ footprint: { [Math.floor(Date.now() / 3600e3)]: { watch: 3 } } });
    const env = fakeTab(xPage());
    const r = await run(env, s);
    assert.equal(r.budget, true);
    assert.ok(!r.fail && !r.stop);
    assert.deepEqual(env.cmds(), [], "no page load, no command");
  });
});

