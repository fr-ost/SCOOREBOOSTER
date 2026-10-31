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

  // The reply modal: a dialog with a text box AND X's post textarea / Reply button (composerDialogMarker).
  const isComposerDialog = (d) => !!D.q("composerTextbox", d) && !!D.q("composerDialogMarker", d);
  function openDialog() { return D.qa("dialog").find(isComposerDialog) || null; }

  // The composer we are working with: the reply modal if open, else the inline reply box on the status page.
  function composer() {
    const dlg = openDialog();
    if (dlg) return { box: D.q("composerTextbox", dlg), where: "modal", root: dlg };
    const primary = D.q("primaryColumn") || document;
    const box = D.qa("composerTextbox", primary).find((b) => !D.closest(b, "dialog")) || null;
    return { box, where: "inline", root: primary };
  }

  // Click into the box like a person (mousedown, mouseup, click) and focus it, so X's editor becomes active and takes
  // the paste (UniqueFarm). A box that already has the focus is left as it is.
  function activate(box) {
    if (!box) return;
    if (document.activeElement === box || box.contains(document.activeElement)) return;
    try { for (const t of ["mousedown", "mouseup", "click"]) box.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); } catch (_) {}
    try { box.focus({ preventScroll: true }); } catch (_) {}
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

  // Right before acting: the page must be logged in as the expected account (the worker passes expectMe when
  // "verify account" is on). Unknown -> nothing is clicked or typed.
  function accountCheck(expectMe) {
    if (!expectMe) return null;
    const me = X.myHandle();
    if (!me) return { ok: false, error: "account_unknown" };
    if (me !== String(expectMe).toLowerCase().replace(/^@/, "")) return { ok: false, error: "wrong_account", me };
    return null;
  }

  // Plain-text sample of a prompt for the stop reason (shown as text, never as HTML).
  const sample = (t) => String(t || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  function unknownPrompt(t, why) { return { ok: false, state: "unknown_prompt", detail: sample(t) || "(a dialog without text)", why }; }
  // Text of the reply composer around the box: no typed reply, no quoted post, no names.
  const composerChrome = (el) => D.textExcluding(el, ["composerTextbox", "tweet", "tweetText", "tweetUserName"], 1500);

  // Fail closed on prompts X shows while ScoreX posts: any dialog / sheet / interstitial that is neither the
  // reply composer nor a toast (or a known harmless overlay) is unknown, and text matching text.aiLabel
  // ("made with AI", "may be hidden", ...) is a stop wherever it shows up. ScoreX never clicks such a prompt.
  function promptCheck() {
    // Text nodes joined with spaces (innerText runs adjacent inline elements together: "Made with" + "AI").
    const words = (el) => D.textExcluding(el, [], 1500);
    for (const el of D.qaAll("prompt")) {
      if (!D.shown(el) || D.closest(el, "toast")) continue;
      const own = words(el);
      if (!own && !el.querySelector("button, [role=\"button\"], a[href], input, img, svg")) continue; // empty layer
      if (isComposerDialog(el)) { // the reply composer (or a layer around it)
        const around = composerChrome(el);
        if (D.re("aiLabel").test(around)) return unknownPrompt(around, "ai_label");
        continue;
      }
      if (D.matches(el, "knownOverlay") || D.closest(el, "knownOverlay")) {
        if (D.re("aiLabel").test(own)) return unknownPrompt(own, "ai_label");
        continue;
      }
      return unknownPrompt(own, D.re("aiLabel").test(own) ? "ai_label" : "dialog");
    }
    for (const t of D.qa("toast")) {
      const txt = words(t);
      if (D.re("aiLabel").test(txt)) return unknownPrompt(txt, "ai_label");
    }
    return null;
  }

  async function like({ tweetId, expectMe }) {
    const acct = accountCheck(expectMe);
    if (acct) return acct;
    const p0 = promptCheck();
    if (p0) return p0;
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

  async function openComposer({ tweetId, expectMe }) {
    const acct = accountCheck(expectMe);
    if (acct) return acct;
    const p0 = promptCheck(); // never click anything while X shows something unknown
    if (p0) return p0;
    const a = focalArticle(tweetId);
    if (!a) return { ok: false, error: "post_not_found" };
    const st = S.scrapeStatus(tweetId);
    if (!st.canReply) return { ok: false, error: "replies_restricted" };
    let c = composer();
    if (!c.box || !D.visible(c.box)) {
      const btn = D.q("replyButton", a);
      if (!btn) return { ok: false, error: "reply_button_missing", dom: true };
      D.humanClick(btn);
      await D.waitFor(() => { const x = composer(); return x.box && D.visible(x.box) ? x : promptCheck(); }, 8000, 250);
      c = composer();
    }
    const p1 = promptCheck(); // an interstitial instead of (or over) the reply box
    if (p1) return p1;
    if (!c.box) return { ok: false, error: "composer_missing", dom: true };
    try { c.box.scrollIntoView({ block: "center" }); } catch (_) {}
    // Click straight into the reply box and focus it (UniqueFarm), then give X a moment; a layout that opens the
    // reply modal from that click is picked up by composer() (the modal wins).
    activate(c.box);
    await D.sleep(500 + Math.random() * 500);
    const p2 = promptCheck();
    if (p2) return p2;
    c = composer();
    if (!c.box) return { ok: false, error: "composer_missing", dom: true };
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

  // ---- Inserting the reply (ported from UniqueFarm) ----
  // X's editor (Draft.js) commits a pasted text into its own state. Typing a few characters at a time with synthetic
  // events can desync that state from what the box shows (garbled or doubled text), and X later re-renders the box
  // from its own state. So the whole reply goes in with one real paste event; beforeinput insertFromPaste and
  // execCommand insertText are fallbacks. loose(): the comparison form (no whitespace, no zero-width or emoji
  // variation characters, straight quotes, NFC), so a harmless re-render never blocks a reply.
  const loose = (t) => String(t || "").normalize("NFC").replace(/[\u200b-\u200d\u2060\ufeff\ufe0e\ufe0f]/g, "").replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, "");
  function selectAllIn(box) {
    try { const sel = window.getSelection(); const r = document.createRange(); r.selectNodeContents(box); sel.removeAllRanges(); sel.addRange(r); } catch (_) {}
  }
  function dispatchPaste(box, text) {
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      box.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true, clipboardData: dt }));
      return true;
    } catch (_) { return false; }
  }
  async function insertWhole(box, text) {
    const clean = String(text || "").trim();
    const same = () => loose(boxText(box)) === loose(clean);
    activate(box); // the typing pause may have cost the focus
    try { box.focus({ preventScroll: true }); } catch (_) {}
    await D.sleep(50);
    selectAllIn(box); // replaces whatever is in the box
    await D.sleep(20);
    dispatchPaste(box, clean);
    // X's editor shows the pasted text on its next render, which can lag in a background tab: wait for it before
    // trying a fallback, so the text never goes in twice.
    await D.waitFor(() => (boxText(box) ? true : null), 1200, 100);
    if (!same() && !boxText(box)) {
      selectAllIn(box);
      try { box.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertFromPaste", data: clean, bubbles: true, cancelable: true, composed: true })); } catch (_) {}
      await D.waitFor(() => (boxText(box) ? true : null), 800, 100);
    }
    if (!same() && !boxText(box)) {
      selectAllIn(box);
      try { document.execCommand("insertText", false, clean); } catch (_) {}
      await D.sleep(140);
    }
    if (!same() && boxText(box)) { // doubled or garbled: one more paste over everything
      selectAllIn(box);
      dispatchPaste(box, clean);
      await D.sleep(160);
    }
    caretToEnd(box);
    return same();
  }
  // X keeps the Reply button disabled until its editor state has the text: a real edit that nets out commits it.
  function nudge(box) {
    try {
      box.focus({ preventScroll: true });
      caretToEnd(box);
      document.execCommand("insertText", false, " ");
      document.execCommand("delete", false);
    } catch (_) {}
  }

  // Type the next chunk of characters at the end of the composer, or (whole:true) put the whole reply in at once.
  async function type({ text, whole }) {
    const p = promptCheck(); // a prompt appeared while typing: stop typing, touch nothing
    if (p) return p;
    const { box } = composer();
    if (!box) return { ok: false, error: "composer_missing", dom: true };
    if (whole) {
      const ok = await insertWhole(box, text);
      const p2 = promptCheck();
      if (p2) return p2;
      return { ok, text: boxText(box), error: ok ? undefined : "typing_ignored" };
    }
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

  async function submitReply({ expectText, expectMe }) {
    const acct = accountCheck(expectMe);
    if (acct) return acct;
    const p0 = promptCheck();
    if (p0) return p0;
    const c = composer();
    if (!c.box) return { ok: false, error: "composer_missing", dom: true };
    let got = boxText(c.box);
    // X may have re-rendered the box from its own editor state: paste the reply once more before giving up.
    if (expectText && loose(expectText) !== loose(got)) {
      await insertWhole(c.box, expectText);
      got = boxText(c.box);
      if (loose(expectText) !== loose(got)) return { ok: false, error: "composer_text_mismatch", text: got };
    }
    const key = c.where === "modal" ? "replySubmitModal" : "replySubmitInline";
    const find = () => D.q(key, c.root) || D.q("replySubmitModal") || D.q("replySubmitInline");
    let btn = null;
    // About 8 s for the button to enable; meanwhile the editor is nudged, and every 3rd try the reply is pasted again
    // (UniqueFarm's recovery for a text that sits in the box but not in X's editor state).
    for (let i = 0; i < 12; i++) {
      if (promptCheck()) break;
      const b = find();
      if (b && !D.isDisabled(b)) { btn = b; break; }
      if (i > 0) { if (i % 3 === 0) await insertWhole(c.box, expectText || got); else nudge(c.box); }
      await D.sleep(i === 0 ? 250 : 650);
    }
    // Checked again right before the click: the account, any prompt that showed up while waiting, and the text.
    const late = accountCheck(expectMe) || promptCheck();
    if (late) return late;
    if (expectText && loose(expectText) !== loose(boxText(c.box))) return { ok: false, error: "composer_text_mismatch", text: boxText(c.box) };
    if (!btn || !btn.isConnected || D.isDisabled(btn)) {
      // A present-but-disabled button usually means X rejects the text (e.g. over its weighted length).
      return find() ? { ok: false, error: "submit_button_disabled" } : { ok: false, error: "submit_button_missing", dom: true };
    }
    // Did X start sending? The box empties, the Reply button greys out or goes away, a progress bar shows, or a new
    // toast / prompt appears. If none of that happens, X ignored the click (its handler never ran): then X's own
    // Ctrl/Cmd+Enter shortcut, then one more click (UniqueFarm). Never again once anything has started.
    const toastsBefore = new Set(D.qa("toast").map((t) => D.text(t)));
    const started = () => composerCleared() || !btn.isConnected || D.isDisabled(btn)
      || !!(c.root && c.root.querySelector('[role="progressbar"]'))
      || D.qa("toast").some((t) => !toastsBefore.has(D.text(t))) || !!promptCheck();
    D.humanClick(btn);
    let tries = 1;
    let began = !!(await D.waitFor(() => (started() ? true : null), 5000, 250));
    if (!began && loose(boxText(c.box)) === loose(expectText || got)) {
      keyboardSubmit(c.box);
      tries++;
      began = !!(await D.waitFor(() => (started() ? true : null), 4000, 250));
      if (!began && btn.isConnected && !D.isDisabled(btn) && !promptCheck()) {
        D.humanClick(btn);
        tries++;
        began = !!(await D.waitFor(() => (started() ? true : null), 4000, 250));
      }
    }
    return { ok: true, where: c.where, tries, started: began };
  }

  // X's own submit shortcut in the reply box (Cmd+Enter on a Mac, Ctrl+Enter elsewhere).
  function keyboardSubmit(box) {
    try {
      box.focus({ preventScroll: true });
      caretToEnd(box);
      const mac = /mac/i.test(navigator.platform || "");
      const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, ctrlKey: !mac, metaKey: mac, bubbles: true, cancelable: true, composed: true };
      for (const t of ["keydown", "keypress", "keyup"]) box.dispatchEvent(new KeyboardEvent(t, o));
    } catch (_) {}
  }

  // What X shows right now (toasts and alerts), for the reason of an unconfirmed reply.
  const xMessages = () => D.qa("toast").map((t) => D.text(t).replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 3).join(" | ").slice(0, 200);

  // Did X take the reply? (no composer dialog left and the box is empty)
  function composerCleared() {
    const c = composer();
    return !openDialog() && (!c.box || !boxText(c.box));
  }

  // X keeps the text in the box until its request finishes, so a prompt that shows up while the reply is still being
  // sent (an unrelated sheet) would otherwise look like "not sent": the box is watched this long first.
  const PROMPT_GRACE_MS = 8000;

  // After submitting: wait for X's confirmation (toast with a link, composer cleared, or our reply in the thread).
  // An unknown prompt (or AI-label text) ends the wait as state "unknown_prompt"; cleared/sent tell the worker
  // whether the reply may have gone out anyway. Nothing on the page is touched.
  async function replyResult({ tweetId, expectText, me, timeoutMs = 20000 }) {
    const want = norm(expectText).slice(0, 60).toLowerCase();
    const sentToast = () => D.qa("toast").some((t) => D.re("replySent").test(D.text(t)) || !!t.querySelector('a[href*="/status/"]'));
    const prompted = (p, sent) => ({ ...p, cleared: composerCleared(), sent: !!sent || sentToast() });
    // Our reply's link from X's "sent" toast, if it shows one.
    const toastLink = () => {
      for (const t of D.qa("toast")) {
        const a = t.querySelector('a[href*="/status/"]');
        const m = a && (a.getAttribute("href") || "").match(/\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})/);
        if (m) return { replyId: m[2], replyUrl: `https://x.com/${m[1]}/status/${m[2]}` };
      }
      return {};
    };
    const res = await D.waitFor(() => {
      const ts = X.toastState();
      if (ts) return { ok: false, state: ts.state, detail: ts.detail };
      const p = promptCheck();
      if (p) return prompted(p, false);
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
    if (res && res.state === "unknown_prompt" && !res.cleared && !res.sent) {
      // The text is still in the box, so X may still be sending the reply: watch a few seconds more (touching
      // nothing). A box that empties or a "sent" toast means it went out; an X warning toast means X refused it.
      await D.waitFor(() => composerCleared() || sentToast() || X.toastState(), Math.min(PROMPT_GRACE_MS, timeoutMs), 400);
      const ts = X.toastState();
      if (ts) return { ok: false, state: ts.state, detail: ts.detail };
      const sent = sentToast();
      return { ...res, cleared: composerCleared(), sent, ...(sent ? toastLink() : {}) };
    }
    if (res && res.ok) {
      // X sometimes follows a sent reply with a sheet (e.g. an AI label or "may be hidden" notice): look for a
      // moment before reporting success, so it is never missed.
      const late = await D.waitFor(() => promptCheck(), 1500, 250);
      if (late) return { ...prompted(late, true), replyId: res.replyId, replyUrl: res.replyUrl };
      return res;
    }
    if (res) return res;
    // No explicit confirmation: if the composer emptied and no modal is left, X most likely accepted it.
    const cleared = composerCleared();
    const { box } = composer();
    return { ok: false, error: cleared ? "unconfirmed_cleared" : "not_confirmed", cleared, xSaid: xMessages(), textLeft: !!(box && boxText(box)) };
  }

  function followState() {
    const { profile } = S.scrapeProfile();
    if (!profile) return { ok: false, error: "profile_not_rendered" };
    return { ok: true, followsYou: profile.followsYou, youFollow: profile.youFollow, pending: profile.followPending, profile };
  }

  // Follow an account (follow-first): on its post page the author's button reads "Follow @handle" (UniqueFarm), on its
  // profile it is the header's follow button. Never a "Who to follow" suggestion or an ad. A "Following @handle" /
  // unfollow button means you already follow it; a protected account answers with a pending request.
  async function follow({ handle, expectMe }) {
    const acct = accountCheck(expectMe);
    if (acct) return acct;
    const p0 = promptCheck();
    if (p0) return p0;
    const h = String(handle || "").toLowerCase().replace(/^@/, "");
    if (!h) return { ok: false, error: "no_handle" };
    const inAd = (el) => !!(el && el.closest('[data-testid="placementTracking"]'));
    const labelled = () => [...document.querySelectorAll("button[aria-label], [role=\"button\"][aria-label]")].filter((b) => !inAd(b));
    const label = (b) => (b.getAttribute("aria-label") || "").trim().toLowerCase();
    const following = () => labelled().some((b) => label(b) === "following @" + h || label(b) === "unfollow @" + h)
      || (onProfile() && !!S.relationButtons(D.q("primaryColumn") || document).un);
    const pending = () => labelled().some((b) => label(b) === "pending @" + h) || (onProfile() && !!S.relationButtons(D.q("primaryColumn") || document).pend);
    const onProfile = () => (location.pathname.split("/")[1] || "").toLowerCase() === h;
    if (following()) return { ok: true, already: true };
    if (pending()) return { ok: true, pending: true, already: true };
    let btn = labelled().find((b) => label(b) === "follow @" + h) || null;
    if (!btn && onProfile()) btn = S.relationButtons(D.q("primaryColumn") || document).fo;
    if (!btn) return { ok: false, error: "follow_button_missing" };
    D.humanClick(btn);
    const done = await D.waitFor(() => following() || pending() || X.toastState() || promptCheck(), 8000, 250);
    const ts = X.toastState();
    if (ts) return { ok: false, state: ts.state, detail: ts.detail };
    const p1 = promptCheck();
    if (p1) return p1;
    if (pending()) return { ok: true, pending: true };
    return done && following() ? { ok: true } : { ok: false, error: "follow_not_confirmed" };
  }

  async function unfollow({ handle, expectMe }) {
    const acct = accountCheck(expectMe);
    if (acct) return acct;
    const p0 = promptCheck(); // never click "Following" while X shows something unknown
    if (p0) return p0;
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

  globalThis.SXActions = { like, openComposer, type, composerText, clearComposer, closeComposer, submitReply, replyResult, followState, follow, unfollow, replyStats, scroll, focalArticle };
})();
