// ScoreX - human-like posting of one approved/queued comment through the x.com page.
// Flow: open the post -> read it (pause scaled to its length) -> small scroll -> optional like ->
// open the reply box -> type at a realistic speed (driven from the worker, so hidden-tab timer
// throttling does not matter) -> verify the text -> submit -> wait for X's confirmation.
// Never retries a submit blindly: if confirmation is unclear it checks the thread for our reply.

import { CMD, STOP } from "./constants.js";
import { navigate, send, waitForPage, bringToFront } from "./tabs.js";
import { pageVerdict, domStop } from "./guard.js";
import { sleep, humanDelay, randInt, randFloat, chance, tweetIdFromUrl } from "./util.js";

// Same normalisation as content/actions.js (zero-width joiners are dropped on both sides).
const norm = (t) => String(t || "").replace(/\u00a0/g, " ").replace(/[\u200b-\u200d\ufeff]/g, "").replace(/\s+/g, " ").trim();
// Our reply among your replies in the thread: its text starts like the comment (as content/actions.js replyResult
// compares). Another reply of yours under the post (e.g. one you wrote by hand to another commenter) is not it.
const ourReply = (replies, text) => (replies || []).find((r) => norm(r.text).toLowerCase().startsWith(norm(text).toLowerCase().slice(0, 40)));

// Split text into 1-3 character chunks with per-chunk delays for a given chars-per-minute speed.
export function typingPlan(text, cpmMin, cpmMax) {
  const cpm = randFloat(cpmMin, cpmMax);
  const perChar = 60000 / cpm;
  const chunks = [];
  let i = 0;
  const chars = Array.from(String(text));
  while (i < chars.length) {
    let n = Math.min(chars.length - i, chance(0.55) ? 1 : chance(0.75) ? 2 : 3);
    // attach whitespace to the following character so no chunk is whitespace-only
    while (i + n < chars.length && /^\s+$/.test(chars.slice(i, i + n).join(""))) n++;
    const piece = chars.slice(i, i + n).join("");
    i += n;
    let delay = perChar * n * randFloat(0.6, 1.45);
    if (/[.,!?;:]\s*$/.test(piece)) delay += randInt(120, 520);
    else if (/\s$/.test(piece)) delay += randInt(20, 180);
    if (chance(0.035)) delay += randInt(700, 2200); // short "thinking" pause
    chunks.push({ text: piece, delay: Math.round(delay) });
  }
  return chunks;
}

function verdictOf(resp, settings) {
  const v = pageVerdict(resp && resp.page, settings);
  if (v && v.stop) return v;
  const d = domStop(resp);
  if (d) return d;
  return null;
}

// The account ScoreX must act as (null when "verify account" is off or no handle is set).
function expectedHandle(settings) {
  const a = (settings && settings.account) || {};
  const h = String(a.handle || "").trim().toLowerCase().replace(/^@/, "");
  return a.verifyAccount && h ? h : null;
}

// Before acting on the page: the logged-in account must be the expected one. Unknown -> soft (nothing is done,
// not a posting failure); a different account -> WRONG_ACCOUNT stop.
function accountVerdict(page, want) {
  if (!want) return null;
  const me = page && page.me ? String(page.me).toLowerCase() : null;
  if (!me) return { soft: "account_unknown" };
  if (me !== want) return { stop: STOP.WRONG_ACCOUNT, detail: `Logged in as @${me}, expected @${want}` };
  return null;
}
// What a content action's own account check means for the post.
function accountRefusal(resp, want) {
  if (!resp || resp.ok) return null;
  if (resp.error === "account_unknown") return { soft: "account_unknown" };
  if (resp.error === "wrong_account") return { stop: STOP.WRONG_ACCOUNT, detail: `Logged in as @${resp.me || "?"}, expected @${want}` };
  return null;
}
// Soft "could not verify the account" result: the item stays queued, nothing was typed or submitted.
const accountUnknown = (liked) => ({ ok: false, retry: true, soft: "account_unknown", reason: "account_unknown", liked: !!liked });

// Clean up after a failure so nothing half-written stays in the page.
async function cleanup(tabId) {
  await send(tabId, CMD.CLEAR_COMPOSER, {}, 8000);
  await send(tabId, CMD.CLOSE_COMPOSER, {}, 8000);
}

/**
 * Post rec.comment as a reply to rec.postUrl.
 * ctx: { tabId, settings, me, allowLike }  Returns:
 *   { ok:true, replyUrl, replyId, liked, already? }
 *   { ok:false, stop, detail }            -> engine stops (safety)
 *   { ok:false, skip:true, reason }       -> post gone / replies restricted (not a failure)
 *   { ok:false, fail:true, reason }       -> counts toward "repeated post failures"
 *   { ok:false, retry:true, reason }      -> the page did not load/render; the item stays queued
 *   { ok:false, retry:true, soft:"account_unknown", reason:"account_unknown" }
 *                                         -> the logged-in account could not be verified; nothing was liked,
 *                                            typed or submitted after that (not a posting failure)
 *   { ok:false, aborted:true }            -> Pause/Stop pressed before submitting; nothing was posted
 * unsure:true on a failure or stop means the reply may have been sent (count it toward the limits):
 * every unconfirmed outcome after the Reply click, unless X explicitly rejected it.
 * An unknown X prompt (dialog / sheet / AI-label notice) is the stop STOP.UNKNOWN_PROMPT with a plain-text
 * sample of the prompt as detail; nothing on the page is touched after that.
 */
export async function postReply(rec, ctx) {
  const { tabId, settings, me } = ctx;
  const stopped = ctx.shouldStop || (async () => false);
  const sf = settings.safety;
  const want = expectedHandle(settings);
  const tweetId = rec.postId || tweetIdFromUrl(rec.postUrl);
  const text = String(rec.comment || "").trim();
  if (!text) return { ok: false, skip: true, reason: "empty_comment" };

  const nav = await navigate(tabId, rec.postUrl);
  // The X page-load budget refused it: nothing was loaded, the item waits (not a failure).
  if (nav.budget) return { ok: false, retry: true, budget: true, reason: "page_budget", until: nav.until };
  if (!nav.ok) return { ok: false, fail: true, reason: "navigation_" + nav.error };
  const w = await waitForPage(tabId, ["tweet", "emptyState"], 25000);
  let v = verdictOf(w, settings);
  if (v) return { ok: false, stop: v.stop, detail: v.detail };
  const pv = pageVerdict(w.page, settings);
  if (pv && pv.notFound) return { ok: false, skip: true, reason: "post_unavailable" };
  // Not rendered (hidden tab, "Something went wrong", slow network): keep the item for a later retry.
  if (!w.ok) return { ok: false, retry: true, reason: "page_not_ready_" + (w.settled || (w.timeout ? "timeout" : w.error || "no_answer")) };

  const st = await send(tabId, CMD.SCRAPE_STATUS, { tweetId, me }, 20000);
  v = verdictOf(st, settings);
  if (v) return { ok: false, stop: v.stop, detail: v.detail };
  if (!st.ok) return { ok: false, retry: true, reason: "status_unreadable" };
  if (!st.focal) {
    const pv2 = pageVerdict(st.page, settings);
    if (pv2 && pv2.notFound) return { ok: false, skip: true, reason: "post_not_found" };
    return { ok: false, retry: true, reason: "post_not_rendered" };
  }
  const done = ourReply(st.myReplies, text);
  if (done) return { ok: true, already: true, replyUrl: done.url, replyId: done.id, liked: !!st.focal.liked };
  // You already replied under this post yourself (by hand, other text): no second reply from your account, and the
  // item is not recorded as posted (it was not).
  if (st.myReplies && st.myReplies.length) return { ok: false, skip: true, reason: "already_replied_by_you" };
  if (st.canReply === false) return { ok: false, skip: true, reason: "replies_restricted" };
  if (st.focalIndex > 0) return { ok: false, skip: true, reason: "reply_in_thread_not_original_post" };
  // Nothing is liked, typed or submitted unless this page is logged in as your account.
  const av = accountVerdict(st.page, want);
  if (av && av.stop) return { ok: false, stop: av.stop, detail: av.detail };
  if (av) return accountUnknown(false);

  // Read the post: base pause + time proportional to its length.
  const readMs = humanDelay(sf.readDelaySec.min * 1000, sf.readDelaySec.max * 1000) + Math.min(9000, norm(st.focal.text).length * randFloat(15, 35));
  await sleep(readMs);
  await send(tabId, CMD.SCROLL, { dy: randInt(120, 420) }, 8000);
  await sleep(humanDelay(700, 2200));

  if (await stopped()) return { ok: false, aborted: true };
  let liked = false;
  if (ctx.allowLike && !st.focal.liked) {
    const lk = await send(tabId, CMD.LIKE, { tweetId, expectMe: want || undefined }, 15000);
    v = verdictOf(lk, settings);
    if (v) return { ok: false, stop: v.stop, detail: v.detail };
    const ar = accountRefusal(lk, want);
    if (ar && ar.stop) return { ok: false, stop: ar.stop, detail: ar.detail };
    if (ar) return accountUnknown(false);
    if (lk.state) return { ok: false, stop: stopFor(lk.state), detail: lk.detail || "X warning after like" };
    liked = !!(lk.ok && !lk.already);
    await sleep(humanDelay(900, 2600));
  }

  if (await stopped()) return { ok: false, aborted: true, liked };
  const restore = sf.bringTabToFront ? await bringToFront(tabId) : null;
  try {
    const oc = await send(tabId, CMD.OPEN_COMPOSER, { tweetId, expectMe: want || undefined }, 20000);
    v = verdictOf(oc, settings);
    if (v) return { ok: false, stop: v.stop, detail: v.detail, liked };
    if (oc.state) return { ok: false, stop: stopFor(oc.state), detail: oc.detail || oc.state, liked, unsure: false }; // nothing typed
    const ar = accountRefusal(oc, want);
    if (ar && ar.stop) return { ok: false, stop: ar.stop, detail: ar.detail, liked };
    if (ar) return accountUnknown(liked);
    if (!oc.ok) {
      if (oc.error === "replies_restricted") return { ok: false, skip: true, reason: "replies_restricted", liked };
      if (oc.error === "post_not_found") return { ok: false, skip: true, reason: "post_not_found", liked };
      return { ok: false, fail: true, reason: oc.error || "composer_failed", liked };
    }
    if (oc.text) await send(tabId, CMD.CLEAR_COMPOSER, {}, 8000); // leftover draft
    await sleep(humanDelay(600, 1800));

    // Type at a human speed. Delays live here (worker), each chunk is one quick page command.
    let typed = "";
    let misses = 0;
    let k = 0;
    for (const ch of typingPlan(text, sf.typingCpm.min, sf.typingCpm.max)) {
      await sleep(ch.delay);
      if (++k % 8 === 0 && (await stopped())) { await cleanup(tabId); return { ok: false, aborted: true, liked }; }
      const r = await send(tabId, CMD.TYPE, { text: ch.text }, 8000);
      if (r.state) return { ok: false, stop: stopFor(r.state), detail: r.detail || r.state, liked, unsure: false }; // prompt: touch nothing
      if (r.page) { const vv = pageVerdict(r.page, settings); if (vv && vv.stop) { await cleanup(tabId); return { ok: false, stop: vv.stop, detail: vv.detail, liked }; } }
      if (!r.ok) { if (++misses >= 3) break; continue; }
      typed = r.text || typed;
    }
    // Verify; if character typing did not land, fall back to inserting the whole text once.
    let ct = await send(tabId, CMD.COMPOSER_TEXT, {}, 8000);
    if (norm(ct.text) !== norm(text)) {
      await send(tabId, CMD.CLEAR_COMPOSER, {}, 8000);
      await sleep(humanDelay(400, 900));
      const t2 = await send(tabId, CMD.TYPE, { text }, 8000);
      if (t2.state) return { ok: false, stop: stopFor(t2.state), detail: t2.detail || t2.state, liked, unsure: false };
      ct = await send(tabId, CMD.COMPOSER_TEXT, {}, 8000);
      if (norm(ct.text) !== norm(text)) {
        await cleanup(tabId);
        return { ok: false, fail: true, reason: "text_not_accepted_by_composer", liked };
      }
    }
    await sleep(humanDelay(1200, 3800)); // re-read before sending
    if (await stopped()) { await cleanup(tabId); return { ok: false, aborted: true, liked }; } // last chance: Pause/Stop wins

    // The content script checks the account and looks for prompts once more right before the click.
    const sb = await send(tabId, CMD.SUBMIT_REPLY, { expectText: text, expectMe: want || undefined }, 15000);
    v = verdictOf(sb, settings);
    // (sb.ok: the click happened before the page showed the stop, so the reply may be on X unless X refused it)
    if (v) { await cleanup(tabId); return { ok: false, stop: v.stop, detail: v.detail, liked, unsure: !!sb.ok && !REJECTED.has(v.stop) }; }
    if (sb.state) return { ok: false, stop: stopFor(sb.state), detail: sb.detail || sb.state, liked, unsure: false }; // not clicked
    const ar2 = accountRefusal(sb, want);
    if (ar2) { await cleanup(tabId); return ar2.stop ? { ok: false, stop: ar2.stop, detail: ar2.detail, liked } : accountUnknown(liked); }
    // No answer to the submit (tab frozen or reloaded): the click may have happened, so it is handled like an
    // unconfirmed result below (thread re-check, then "may have been sent"). Never re-submitted.
    if (!sb.ok && !sb.noAnswer) { await cleanup(tabId); return { ok: false, fail: true, reason: sb.error || "submit_failed", liked }; }

    // From here on the Reply button was clicked: anything short of a confirmation or an explicit rejection by
    // X counts as "may have been sent" (unsure), so the daily and per-account limits never under-count.
    let rr = sb.ok ? await send(tabId, CMD.REPLY_RESULT, { tweetId, expectText: text, me, timeoutMs: 20000 }, 40000) : { ok: false, noAnswer: true, error: "no_answer" };
    // The text is still in the box and nothing was confirmed: X may still be sending it. Wait once more
    // before leaving the page (leaving would cancel a request in flight). Never re-submits.
    if (!rr.ok && !rr.state && rr.error === "not_confirmed") {
      const rr2 = await send(tabId, CMD.REPLY_RESULT, { tweetId, expectText: text, me, timeoutMs: 15000 }, 30000);
      if (!rr2.noAnswer) rr = rr2;
    }
    if (rr.state === "unknown_prompt") {
      // Leave the page exactly as it is (no cleanup clicks). It may have been sent if X cleared the box or showed its
      // "sent" toast (X keeps the text while sending, so the page watches the box a few seconds after the prompt).
      return { ok: false, stop: STOP.UNKNOWN_PROMPT, detail: rr.detail || "Unknown dialog", liked, unsure: !!(rr.cleared || rr.sent), replyUrl: rr.replyUrl || "" };
    }
    if (rr.state) { const s = stopFor(rr.state); return { ok: false, stop: s, detail: rr.detail || rr.state, liked, unsure: !REJECTED.has(s) }; } // a warning / limit toast = X refused it
    v = verdictOf(rr, settings);
    if (v) return { ok: false, stop: v.stop, detail: v.detail, liked, unsure: !REJECTED.has(v.stop) };
    if (rr.ok) return { ok: true, replyUrl: rr.replyUrl, replyId: rr.replyId, liked, via: rr.via };
    if (rr.error === "duplicate") { await cleanup(tabId); return { ok: false, fail: true, reason: "x_says_duplicate", liked }; }

    // Unclear (not confirmed, no answer from the tab, an error): look at the thread again for our reply before
    // deciding (never re-submit).
    const reason = rr.cleared ? "sent_but_not_visible" : rr.noAnswer ? "no_answer_after_submit" : "not_confirmed";
    await sleep(humanDelay(2500, 4500));
    await navigate(tabId, rec.postUrl);
    await waitForPage(tabId, ["tweet"], 20000);
    const again = await send(tabId, CMD.SCRAPE_STATUS, { tweetId, me }, 20000);
    v = verdictOf(again, settings);
    if (v) return { ok: false, stop: v.stop, detail: v.detail, liked, unsure: true };
    const mine = again.ok && ourReply(again.myReplies, text);
    if (mine) return { ok: true, replyUrl: mine.url, replyId: mine.id, liked, via: "recheck" };
    await cleanup(tabId);
    return { ok: false, fail: true, reason, liked, unsure: true };
  } finally {
    if (restore) await restore();
  }
}

// Stops that mean X refused the action outright (nothing was posted).
const REJECTED = new Set([STOP.WARNING, STOP.RATE_LIMIT]);

function stopFor(state) {
  return {
    warning: STOP.WARNING, rate_limit: STOP.RATE_LIMIT, captcha: STOP.CAPTCHA, locked: STOP.LOCKED, logged_out: STOP.LOGGED_OUT,
    unknown_prompt: STOP.UNKNOWN_PROMPT, wrong_account: STOP.WRONG_ACCOUNT,
  }[state] || STOP.WARNING;
}
