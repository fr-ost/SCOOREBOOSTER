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
// The comparison form of the composer text (same as the content script's): no whitespace, no zero-width or emoji
// variation characters, straight quotes, NFC. X re-rendering its box never blocks a reply; garbled text still does.
export const loose = (t) => String(t || "").normalize("NFC").replace(/[\u200b-\u200d\u2060\ufeff\ufe0e\ufe0f]/g, "").replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, "");
// How long a person would take to type the text at cpmMin-cpmMax characters per minute (capped at 45 s).
export function typingMs(text, cpmMin, cpmMax) {
  const cpm = Math.max(30, randFloat(cpmMin, cpmMax));
  return Math.min(45000, Math.round((Array.from(String(text || "")).length / cpm) * 60000));
}
// Sleep in slices, false as soon as Pause/Stop is pressed.
async function pauseFor(ms, stopped) {
  let left = Math.max(0, ms);
  while (left > 0) {
    const step = Math.min(2000, left);
    await sleep(step);
    left -= step;
    if (await stopped()) return false;
  }
  return true;
}
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
 *   { ok:false, retry:true, followFailed:true, reason } -> follow first did not work: nothing was liked or typed
 *   { ok:false, capWait:true }            -> you do not follow the account and the daily follow cap is used up:
 *                                            nothing was clicked, liked or typed
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

  // 1) Follow first (ctx.followFirst: settings.follow.followFirst, and "you follow" was not confirmed on the account's
  //    profile in the last 24 h): before anything is liked or typed, open the account's profile - the one page where X
  //    always shows "Follow" / "Following" for it - and follow it unless it already shows Following; a follow counts
  //    once a reload of the profile shows it (followOnProfile). Not confirmed -> no like and no reply now: the item
  //    waits and tries again (engine). ctx.canFollow false (daily follow cap used up): only a look - an account you
  //    do not follow waits ({ capWait }). The outcome is left in ctx.followResult for the engine.
  if (ctx.followFirst) {
    const f = await followOnProfile(tabId, rec.target, settings, { stopped, canFollow: ctx.canFollow !== false });
    if (f.result) ctx.followResult = f.result;
    if (f.aborted) return { ok: false, aborted: true };
    if (f.stop) return { ok: false, stop: f.stop, detail: f.detail };
    if (f.budget) return { ok: false, retry: true, budget: true, reason: "page_budget", until: f.until };
    if (f.soft) return accountUnknown(false);
    if (f.gone) return { ok: false, skip: true, reason: "account_not_found" };
    if (f.capWait) return { ok: false, capWait: true };
    if (!f.ok) return { ok: false, retry: true, followFailed: true, reason: "follow_first_" + f.reason, detail: f.detail || "" };
    await sleep(humanDelay(1200, 3200));
    if (await stopped()) return { ok: false, aborted: true };
  }

  // 2) The post: read it, like it, reply.
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

    // A human typing pause for this reply, then the whole reply goes in at once (one paste event): X's editor garbles
    // synthetic character-by-character typing and later re-renders its own version (ported from UniqueFarm).
    const typeMs = typingMs(text, sf.typingCpm.min, sf.typingCpm.max);
    if (!(await pauseFor(Math.round(typeMs * 0.7), stopped))) { await cleanup(tabId); return { ok: false, aborted: true, liked }; }
    const r = await send(tabId, CMD.TYPE, { text, whole: true }, 15000);
    if (r.state) return { ok: false, stop: stopFor(r.state), detail: r.detail || r.state, liked, unsure: false }; // prompt: touch nothing
    if (r.page) { const vv = pageVerdict(r.page, settings); if (vv && vv.stop) { await cleanup(tabId); return { ok: false, stop: vv.stop, detail: vv.detail, liked }; } }
    // Verify; if the text did not land, clear the box and insert it once more.
    let ct = await send(tabId, CMD.COMPOSER_TEXT, {}, 8000);
    if (loose(ct.text) !== loose(text)) {
      await send(tabId, CMD.CLEAR_COMPOSER, {}, 8000);
      await sleep(humanDelay(400, 900));
      const t2 = await send(tabId, CMD.TYPE, { text, whole: true }, 15000);
      if (t2.state) return { ok: false, stop: stopFor(t2.state), detail: t2.detail || t2.state, liked, unsure: false };
      ct = await send(tabId, CMD.COMPOSER_TEXT, {}, 8000);
      if (loose(ct.text) !== loose(text)) {
        await cleanup(tabId);
        return { ok: false, fail: true, reason: "text_not_accepted_by_composer", liked };
      }
    }
    // The rest of the typing time plus a re-read before sending; last chance for Pause/Stop.
    if (!(await pauseFor(Math.round(typeMs * 0.3) + humanDelay(1200, 3800), stopped))) { await cleanup(tabId); return { ok: false, aborted: true, liked }; }

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
    // X never reacted to the Reply click, the shortcut or the second click: nothing went out. What X showed, if anything,
    // goes into the reason so the owner can see why.
    const ignored = sb.ok && sb.started === false;
    const reason = (rr.cleared ? "sent_but_not_visible" : rr.noAnswer ? "no_answer_after_submit" : ignored ? "x_ignored_reply_click" : "not_confirmed") + (rr.xSaid ? ` (X: ${String(rr.xSaid).slice(0, 160)})` : "");
    await sleep(humanDelay(2500, 4500));
    await navigate(tabId, rec.postUrl);
    await waitForPage(tabId, ["tweet"], 20000);
    const again = await send(tabId, CMD.SCRAPE_STATUS, { tweetId, me }, 20000);
    v = verdictOf(again, settings);
    if (v) return { ok: false, stop: v.stop, detail: v.detail, liked, unsure: true };
    const mine = again.ok && ourReply(again.myReplies, text);
    if (mine) return { ok: true, replyUrl: mine.url, replyId: mine.id, liked, via: "recheck" };
    await cleanup(tabId);
    return { ok: false, fail: true, reason, liked, unsure: !ignored };
  } finally {
    if (restore) await restore();
  }
}

// Follow-first on the account's profile page (x.com/<handle>), where X always shows its Follow / Following button.
// Already following -> nothing is clicked ("already"). Otherwise Follow is clicked, and the follow only counts once a
// fresh load of the profile shows Following: X shows Following the moment the button is clicked, before its server
// has answered, and can still refuse it. canFollow false (the daily follow cap is used up): the profile is only
// looked at, and when it shows Follow nothing is clicked ({ capWait }).
// Returns { ok:true, result: "followed" | "already" | "pending" | "requested" }
//       | { ok:false, result: "missing" | "clicked" | "not_kept", reason, detail }
//       | { stop, detail, result? } | { aborted, result? } | { budget, until } | { soft: "account_unknown" } | { gone }
//       | { capWait }   (result: what to record with lib/follow.js recordFollow)
export async function followOnProfile(tabId, handle, settings, { stopped = async () => false, canFollow = true, settleMs } = {}) {
  const want = expectedHandle(settings);
  if (await stopped()) return { aborted: true };
  const open = await openProfile(tabId, handle, settings, want);
  if (!open.ok) return open;
  await sleep(humanDelay(1500, 3500)); // a look at the profile first, as a person would
  if (await stopped()) return { aborted: true };
  if (!canFollow) {
    const st = await send(tabId, CMD.FOLLOW_STATE, { handle, waitMs: 8000 }, 30000);
    const v = verdictOf(st, settings);
    if (v) return { stop: v.stop, detail: v.detail };
    if (st.ok && st.youFollow === true) return { ok: true, result: "already" };
    if (st.ok && st.pending) return { ok: true, result: "requested" };
    if (st.ok && st.youFollow === false) return { capWait: true };
    return { ok: false, result: "missing", reason: st.error || "follow_button_missing" };
  }
  const fr = await send(tabId, CMD.FOLLOW, { handle, expectMe: want || undefined, ...(settleMs != null ? { settleMs } : {}) }, 45000);
  const clicked = fr && fr.clicked ? { result: "clicked" } : {};
  const v2 = verdictOf(fr, settings);
  if (v2) return { stop: v2.stop, detail: v2.detail, ...clicked };
  const ar = accountRefusal(fr, want);
  if (ar && ar.stop) return { stop: ar.stop, detail: ar.detail };
  if (ar) return { soft: "account_unknown" };
  if (fr.state) return { stop: stopFor(fr.state), detail: fr.detail || "X warning after follow", ...clicked };
  if (fr.ok && fr.already) return { ok: true, result: fr.pending ? "requested" : "already" };
  if (!fr.ok) return { ok: false, result: fr.clicked ? "clicked" : "missing", reason: fr.error || "follow_not_confirmed", detail: fr.detail || "" };
  // X kept showing Following for a few seconds: confirm on a fresh load of the profile that it kept the follow.
  await sleep(humanDelay(1200, 2500));
  if (await stopped()) return { aborted: true, result: "clicked" };
  const again = await openProfile(tabId, handle, settings, want);
  if (!again.ok) {
    if (again.stop || again.aborted) return { ...again, result: "clicked" };
    return { ok: false, result: "clicked", reason: "follow_unverified" };
  }
  const chk = await send(tabId, CMD.FOLLOW_STATE, { handle, waitMs: 8000 }, 30000);
  const v3 = verdictOf(chk, settings);
  if (v3) return { stop: v3.stop, detail: v3.detail, result: "clicked" };
  if (chk.ok && chk.youFollow === true) return { ok: true, result: "followed" };
  if (chk.ok && chk.pending) return { ok: true, result: "pending" };
  if (chk.ok && chk.youFollow === false) return { ok: false, result: "not_kept", reason: "follow_not_kept" };
  return { ok: false, result: "clicked", reason: "follow_unverified" };
}

// Open x.com/<handle> and wait for its header: { ok:true } | { stop, detail } | { gone } | { aborted } | { budget, until }
// | { soft: "account_unknown" } | { ok:false, result: "missing", reason }.
async function openProfile(tabId, handle, settings, want) {
  const nav = await navigate(tabId, `https://x.com/${handle}`, { purpose: "follow", timeoutMs: 45000 });
  if (nav.aborted) return { aborted: true };
  if (nav.budget) return { budget: true, until: nav.until };
  if (!nav.ok) return { ok: false, result: "missing", reason: "profile_" + (nav.error || "not_loaded") };
  const w = await waitForPage(tabId, ["profileUserName", "emptyState"], 20000);
  const v = verdictOf(w, settings);
  if (v) return { stop: v.stop, detail: v.detail };
  const pv = pageVerdict(w.page, settings);
  if (pv && pv.notFound) return { gone: true };
  if (!w.ok) return { ok: false, result: "missing", reason: "profile_not_ready" };
  const av = accountVerdict(w.page, want);
  if (av && av.stop) return { stop: av.stop, detail: av.detail };
  if (av) return { soft: "account_unknown" };
  return { ok: true };
}

// Stops that mean X refused the action outright (nothing was posted).
const REJECTED = new Set([STOP.WARNING, STOP.RATE_LIMIT]);

function stopFor(state) {
  return {
    warning: STOP.WARNING, rate_limit: STOP.RATE_LIMIT, captcha: STOP.CAPTCHA, locked: STOP.LOCKED, logged_out: STOP.LOGGED_OUT,
    unknown_prompt: STOP.UNKNOWN_PROMPT, wrong_account: STOP.WRONG_ACCOUNT,
  }[state] || STOP.WARNING;
}
