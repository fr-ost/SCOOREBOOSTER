// ScoreX content script - atomic page actions. Timing between steps is decided by the service worker
// (background tabs throttle timers, so the worker paces typing/scrolling and these functions stay short).

(function () {
  "use strict";
  if (globalThis.SXActions) return;
  const D = globalThis.SXDom;
  const S = globalThis.SXScrape;
  const X = globalThis.SXDetect;

  const norm = (t) => String(t || "").replace(/ /g, " ").replace(/[​-‍﻿]/g, "").replace(/\s+/g, " ").trim();

  function focalArticle(tweetId) {
    for (const a of S.articles()) {
      const t = S.parseTweet(a);
      if (t && t.id === String(tweetId) && !t.isRepost) return a;
    }
    return null;
  }

  function openDialog() { return D.qa("dialog").find((d) => D.q("composerTextbox", d)) || null; }

  // The composer we are working with: the reply modal if open, else the inline reply box on the status page.
  function composer() {
    const dlg = openDialog();
    if (dlg) return { box: D.q("composerTextbox", dlg), where: "modal", root: dlg };
    const primary = D.q("primaryColumn") || document;
    const box = D.qa("composerTextbox", primary).find((b) => !D.closest(b, "dialog")) || null;
    return { box, where: "inline", root: primary };
  }

  function caretToEnd(box) {
    try {
      box.focus({ preventScroll: true });
      const sel = window.getSelection();
      const r = document.createRange();
      r.selectNodeContents(box);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (_) {}
  }

  function boxText(box) { return box ? norm(box.innerText || box.textContent || "") : ""; }

  async function like({ tweetId }) {
    const a = focalArticle(tweetId);
    if (!a) return { ok: false, error: "post_not_found" };
    if (D.q("unlikeButton", a)) return { ok: true, already: true };
    const btn = D.q("likeButton", a);
    if (!btn) return { ok: false, error: "like_button_missing", dom: true };
    D.humanClick(btn);
    const ok = await D.waitFor(() => D.q("unlikeButton", a) || X.toastState(), 7000, 300);
    const ts = X.toastState();
    if (ts) return { ok: false, error: ts.state, state: ts.state, detail: ts.detail };
    return ok ? { ok: true } : { ok: false, error: "like_not_confirmed" };
  }

  async function openComposer({ tweetId }) {
    const a = focalArticle(tweetId);
    if (!a) return { ok: false, error: "post_not_found" };
    const st = S.scrapeStatus(tweetId);
    if (!st.canReply) return { ok: false, error: "replies_restricted" };
    let c = composer();
    if (!c.box || !D.visible(c.box)) {
      const btn = D.q("replyButton", a);
      if (!btn) return { ok: false, error: "reply_button_missing", dom: true };
      D.humanClick(btn);
      await D.waitFor(() => { const x = composer(); return x.box && D.visible(x.box) ? x : null; }, 8000, 250);
      c = composer();
    }
    if (!c.box) return { ok: false, error: "composer_missing", dom: true };
    try { c.box.scrollIntoView({ block: "center" }); } catch (_) {}
    // Focus like a click into the box (no synthetic click: on some layouts it opens the modal twice).
    caretToEnd(c.box);
    return { ok: true, where: c.where, text: boxText(c.box) };
  }

  // Raw text (no trimming) so a chunk that is only a space still counts as typed.
  const rawText = (box) => (box ? String(box.textContent || "") : "");
  function insertChunk(box, chunk) {
    const before = rawText(box);
    let ok = false;
    try { ok = document.execCommand("insertText", false, chunk); } catch (_) { ok = false; }
    if (!ok && rawText(box) === before) {
      try {
        const dt = new DataTransfer();
        dt.setData("text/plain", chunk);
        box.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true, clipboardData: dt }));
      } catch (_) {}
    }
    return rawText(box) !== before;
  }

  // Type the next chunk of characters at the end of the composer.
  async function type({ text }) {
    const { box } = composer();
    if (!box) return { ok: false, error: "composer_missing", dom: true };
    if (document.activeElement !== box && !box.contains(document.activeElement)) caretToEnd(box);
    const changed = insertChunk(box, String(text || ""));
    return { ok: changed, text: boxText(box), error: changed ? undefined : "typing_ignored" };
  }

  function composerText() {
    const { box, where } = composer();
    return { ok: !!box, text: boxText(box), where };
  }

  async function clearComposer() {
    const { box } = composer();
    if (!box) return { ok: true, text: "" };
    caretToEnd(box);
    for (let i = 0; i < 6 && boxText(box); i++) {
      try { document.execCommand("selectAll", false, null); document.execCommand("delete", false, null); } catch (_) {}
      try { box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null })); } catch (_) {}
      await D.sleep(30);
    }
    return { ok: !boxText(box), text: boxText(box) };
  }

  // Close a reply modal we opened (used after a failure so nothing is left half-written).
  async function closeComposer() {
    const dlg = openDialog();
    if (!dlg) return { ok: true };
    const close = D.q("composerClose", dlg);
    if (close) D.humanClick(close);
    // X asks "Save post?" (Save = confirm, Discard = cancel) or "Discard post?" (Discard = confirm).
    // Always pick the button that says Discard; never Save the AI draft into the account's drafts.
    const sheet = await D.waitFor(() => D.q("confirmSheet") || D.q("discardConfirm"), 2500, 200);
    if (sheet) {
      const root = D.q("confirmSheet") || document;
      const buttons = [D.q("confirmSheetConfirm", root), D.q("confirmSheetCancel", root)].filter(Boolean);
      const discard = buttons.find((b) => /discard/i.test(D.text(b)));
      if (discard) D.humanClick(discard);
      else {
        const cancel = D.q("confirmSheetCancel", root);
        if (cancel && !/save/i.test(D.text(cancel))) D.humanClick(cancel);
      }
    }
    return { ok: !openDialog() };
  }

  async function submitReply({ expectText }) {
    const c = composer();
    if (!c.box) return { ok: false, error: "composer_missing", dom: true };
    const got = boxText(c.box);
    if (expectText && norm(expectText) !== got) return { ok: false, error: "composer_text_mismatch", text: got };
    const key = c.where === "modal" ? "replySubmitModal" : "replySubmitInline";
    const find = () => D.q(key, c.root) || D.q("replySubmitModal") || D.q("replySubmitInline");
    const btn = await D.waitFor(() => { const b = find(); return b && !D.isDisabled(b) ? b : null; }, 6000, 250);
    if (!btn) {
      // A present-but-disabled button usually means X rejects the text (e.g. over its weighted length).
      return find() ? { ok: false, error: "submit_button_disabled" } : { ok: false, error: "submit_button_missing", dom: true };
    }
    D.humanClick(btn);
    return { ok: true, where: c.where };
  }

  // After submitting: wait for X's confirmation (toast with a link, composer cleared, or our reply in the thread).
  async function replyResult({ tweetId, expectText, me, timeoutMs = 20000 }) {
    const want = norm(expectText).slice(0, 60).toLowerCase();
    const res = await D.waitFor(() => {
      const ts = X.toastState();
      if (ts) return { ok: false, state: ts.state, detail: ts.detail };
      for (const t of D.qa("toast")) {
        const txt = D.text(t);
        if (D.re("duplicate").test(txt)) return { ok: false, error: "duplicate", detail: txt.slice(0, 200) };
        const link = t.querySelector('a[href*="/status/"]');
        if (D.re("replySent").test(txt) || link) {
          const m = link && (link.getAttribute("href") || "").match(/\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})/);
          return { ok: true, replyId: m ? m[2] : null, replyUrl: m ? `https://x.com/${m[1]}/status/${m[2]}` : null, via: "toast" };
        }
      }
      if (me) {
        const st = S.scrapeStatus(tweetId, me);
        const mine = st.myReplies.find((r) => norm(r.text).toLowerCase().startsWith(want.slice(0, 40)));
        if (mine) return { ok: true, replyId: mine.id, replyUrl: mine.url, via: "thread" };
      }
      return null;
    }, timeoutMs, 400);
    if (res) return res;
    // No explicit confirmation: if the composer emptied and no modal is left, X most likely accepted it.
    const c = composer();
    const cleared = !openDialog() && (!c.box || !boxText(c.box));
    return { ok: false, error: cleared ? "unconfirmed_cleared" : "not_confirmed", cleared };
  }

  function followState() {
    const { profile } = S.scrapeProfile();
    if (!profile) return { ok: false, error: "profile_not_rendered" };
    return { ok: true, followsYou: profile.followsYou, youFollow: profile.youFollow, pending: profile.followPending, profile };
  }

  async function unfollow({ handle }) {
    const here = (location.pathname.split("/")[1] || "").toLowerCase();
    if (here !== String(handle || "").toLowerCase()) return { ok: false, error: "wrong_page" };
    const primary = D.q("primaryColumn") || document;
    const rb = S.relationButtons(primary);
    if (!rb.un) return rb.fo ? { ok: true, already: true } : { ok: false, error: "follow_button_missing", dom: true };
    D.humanClick(rb.un);
    const confirm = await D.waitFor(() => D.q("confirmSheetConfirm"), 6000, 200);
    if (!confirm) return { ok: false, error: "confirm_missing", dom: true };
    await D.sleep(250 + Math.random() * 450);
    D.humanClick(confirm);
    const done = await D.waitFor(() => { const b = S.relationButtons(primary); return b.fo || X.toastState(); }, 9000, 250);
    const ts = X.toastState();
    if (ts) return { ok: false, state: ts.state, detail: ts.detail };
    return done ? { ok: true } : { ok: false, error: "unfollow_not_confirmed" };
  }

  // On our reply's own page: its metrics and whether the target answered it.
  function replyStats({ replyId, targetHandle }) {
    const st = S.scrapeStatus(replyId);
    if (!st.focal) return { ok: false, error: "reply_not_found" };
    const t = String(targetHandle || "").toLowerCase();
    return {
      ok: true,
      likes: st.focal.metrics.likes || 0,
      replies: st.focal.metrics.replies || 0,
      reposts: st.focal.metrics.reposts || 0,
      views: st.focal.metrics.views,
      authorReplied: (st.focal.metrics.replies || 0) > 0 && !!st.replies.find((r) => r.author === t),
    };
  }

  function scroll({ dy }) {
    const amount = Number(dy) || Math.round(window.innerHeight * (0.5 + Math.random() * 0.4));
    window.scrollBy(0, amount);
    const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 40;
    return { ok: true, y: window.scrollY, atBottom };
  }

  globalThis.SXActions = { like, openComposer, type, composerText, clearComposer, closeComposer, submitReply, replyResult, followState, unfollow, replyStats, scroll, focalArticle };
})();
