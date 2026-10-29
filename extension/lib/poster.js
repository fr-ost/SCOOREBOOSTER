// ScoreX - human-like posting of one approved/queued comment through the x.com page.
// Flow: open the post -> read it (pause scaled to its length) -> small scroll -> optional like ->
// open the reply box -> type at a realistic speed (driven from the worker, so hidden-tab timer
// throttling does not matter) -> verify the text -> submit -> wait for X's confirmation.
// Never retries a submit blindly: if confirmation is unclear it checks the thread for our reply.

import { CMD, STOP } from "./constants.js";
import { navigate, send, waitForPage, bringToFront } from "./tabs.js";
import { pageVerdict, domStop } from "./guard.js";
import { sleep, humanDelay, randInt, randFloat, chance, tweetIdFromUrl } from "./util.js";

const norm = (t) => String(t || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();

// Split text into 1-3 character chunks with per-chunk delays for a given chars-per-minute speed.
export function typingPlan(text, cpmMin, cpmMax) {
  const cpm = randFloat(cpmMin, cpmMax);
  const perChar = 60000 / cpm;
  const chunks = [];
  let i = 0;
  const chars = Array.from(String(text));
  while (i < chars.length) {
    const n = Math.min(chars.length - i, chance(0.55) ? 1 : chance(0.75) ? 2 : 3);
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
 */
export async function postReply(rec, ctx) {
  const { tabId, settings, me } = ctx;
  const sf = settings.safety;
  const tweetId = rec.postId || tweetIdFromUrl(rec.postUrl);
  const text = String(rec.comment || "").trim();
  if (!text) return { ok: false, skip: true, reason: "empty_comment" };

  const nav = await navigate(tabId, rec.postUrl);
  if (!nav.ok) return { ok: false, fail: true, reason: "navigation_" + nav.error };
  const w = await waitForPage(tabId, ["tweet", "emptyState"], 25000);
  let v = verdictOf(w, settings);
  if (v) return { ok: false, stop: v.stop, detail: v.detail };
  const pv = pageVerdict(w.page, settings);
  if (pv && pv.notFound) return { ok: false, skip: true, reason: "post_unavailable" };

  const st = await send(tabId, CMD.SCRAPE_STATUS, { tweetId, me }, 20000);
  v = verdictOf(st, settings);
  if (v) return { ok: false, stop: v.stop, detail: v.detail };
  if (!st.ok || !st.focal) return { ok: false, skip: true, reason: "post_not_found" };
  if (st.myReplies && st.myReplies.length) {
    const mine = st.myReplies[0];
    return { ok: true, already: true, replyUrl: mine.url, replyId: mine.id, liked: !!st.focal.liked };
  }
  if (st.canReply === false) return { ok: false, skip: true, reason: "replies_restricted" };

  // Read the post: base pause + time proportional to its length.
  const readMs = humanDelay(sf.readDelaySec.min * 1000, sf.readDelaySec.max * 1000) + Math.min(9000, norm(st.focal.text).length * randFloat(15, 35));
  await sleep(readMs);
  await send(tabId, CMD.SCROLL, { dy: randInt(120, 420) }, 8000);
  await sleep(humanDelay(700, 2200));

  let liked = false;
  if (ctx.allowLike && !st.focal.liked) {
    const lk = await send(tabId, CMD.LIKE, { tweetId }, 15000);
    v = verdictOf(lk, settings);
    if (v) return { ok: false, stop: v.stop, detail: v.detail };
    if (lk.state) return { ok: false, stop: lk.state === "warning" ? STOP.WARNING : lk.state === "rate_limit" ? STOP.RATE_LIMIT : STOP.WARNING, detail: lk.detail || "X warning after like" };
    liked = !!(lk.ok && !lk.already);
    await sleep(humanDelay(900, 2600));
  }

  const restore = sf.bringTabToFront ? await bringToFront(tabId) : null;
  try {
    const oc = await send(tabId, CMD.OPEN_COMPOSER, { tweetId }, 20000);
    v = verdictOf(oc, settings);
    if (v) return { ok: false, stop: v.stop, detail: v.detail, liked };
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
    for (const ch of typingPlan(text, sf.typingCpm.min, sf.typingCpm.max)) {
      await sleep(ch.delay);
      const r = await send(tabId, CMD.TYPE, { text: ch.text }, 8000);
      if (r.page) { const vv = pageVerdict(r.page, settings); if (vv && vv.stop) { await cleanup(tabId); return { ok: false, stop: vv.stop, detail: vv.detail, liked }; } }
      if (!r.ok) { if (++misses >= 3) break; continue; }
      typed = r.text || typed;
    }
    // Verify; if character typing did not land, fall back to inserting the whole text once.
    let ct = await send(tabId, CMD.COMPOSER_TEXT, {}, 8000);
    if (norm(ct.text) !== norm(text)) {
      await send(tabId, CMD.CLEAR_COMPOSER, {}, 8000);
      await sleep(humanDelay(400, 900));
      await send(tabId, CMD.TYPE, { text }, 8000);
      ct = await send(tabId, CMD.COMPOSER_TEXT, {}, 8000);
      if (norm(ct.text) !== norm(text)) {
        await cleanup(tabId);
        return { ok: false, fail: true, reason: "text_not_accepted_by_composer", liked };
      }
    }
    await sleep(humanDelay(1200, 3800)); // re-read before sending

    const sb = await send(tabId, CMD.SUBMIT_REPLY, { expectText: text }, 15000);
    v = verdictOf(sb, settings);
    if (v) { await cleanup(tabId); return { ok: false, stop: v.stop, detail: v.detail, liked }; }
    if (!sb.ok) { await cleanup(tabId); return { ok: false, fail: true, reason: sb.error || "submit_failed", liked }; }

    const rr = await send(tabId, CMD.REPLY_RESULT, { tweetId, expectText: text, me, timeoutMs: 20000 }, 40000);
    if (rr.state) return { ok: false, stop: stopFor(rr.state), detail: rr.detail || rr.state, liked };
    v = verdictOf(rr, settings);
    if (v) return { ok: false, stop: v.stop, detail: v.detail, liked };
    if (rr.ok) return { ok: true, replyUrl: rr.replyUrl, replyId: rr.replyId, liked, via: rr.via };
    if (rr.error === "duplicate") { await cleanup(tabId); return { ok: false, fail: true, reason: "x_says_duplicate", liked }; }

    // Unclear: look at the thread again for our reply before deciding (never re-submit).
    await sleep(humanDelay(2500, 4500));
    await navigate(tabId, rec.postUrl);
    await waitForPage(tabId, ["tweet"], 20000);
    const again = await send(tabId, CMD.SCRAPE_STATUS, { tweetId, me }, 20000);
    v = verdictOf(again, settings);
    if (v) return { ok: false, stop: v.stop, detail: v.detail, liked };
    const mine = again.ok && again.myReplies && again.myReplies.find((r) => norm(r.text).toLowerCase().startsWith(norm(text).toLowerCase().slice(0, 40)));
    if (mine) return { ok: true, replyUrl: mine.url, replyId: mine.id, liked, via: "recheck" };
    await cleanup(tabId);
    return { ok: false, fail: true, reason: rr.cleared ? "sent_but_not_visible" : "not_confirmed", liked, unsure: !!rr.cleared };
  } finally {
    if (restore) await restore();
  }
}

function stopFor(state) {
  return { warning: STOP.WARNING, rate_limit: STOP.RATE_LIMIT, captcha: STOP.CAPTCHA, locked: STOP.LOCKED, logged_out: STOP.LOGGED_OUT }[state] || STOP.WARNING;
}
