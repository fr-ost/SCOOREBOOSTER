// ScoreX content script - page state detection. Returns one of the PAGE states
// (ok | loading | logged_out | captcha | locked | rate_limit | warning | error_page | not_found).
// The engine stops on captcha / locked / rate_limit / warning / logged_out and never clicks through them.

(function () {
  "use strict";
  if (globalThis.SXDetect) return;
  const D = globalThis.SXDom;

  function myHandle() {
    const a = D.q("profileNavLink");
    const href = a && a.getAttribute("href");
    const m = href && href.match(D.re("handleHref", ""));
    if (m) return m[1].toLowerCase();
    const sw = D.q("accountSwitcher");
    if (sw) {
      const line = D.text(sw).split("\n").map((s) => s.trim()).find((s) => /^@[A-Za-z0-9_]{1,15}$/.test(s));
      if (line) return line.slice(1).toLowerCase();
    }
    return null;
  }

  function messages() {
    const out = [];
    for (const el of [...D.qa("toast"), ...D.qa("dialog")]) {
      const t = D.text(el);
      if (t) out.push(t.slice(0, 400));
    }
    return out;
  }

  // Inspect toasts / alerts for X's warnings (also used right after an action).
  function toastState() {
    for (const t of messages()) {
      if (D.re("automation").test(t)) return { state: "warning", detail: t };
      if (D.re("captcha").test(t)) return { state: "captcha", detail: t };
      if (D.re("locked").test(t)) return { state: "locked", detail: t };
      if (D.re("rateLimit").test(t)) return { state: "rate_limit", detail: t };
    }
    return null;
  }

  function pageState() {
    const path = location.pathname;
    const base = { url: location.href, me: myHandle(), hidden: document.hidden };
    if (/^\/account\/access/i.test(path)) {
      const body = D.text(document.body).slice(0, 3000);
      if (D.re("captcha").test(body) || D.q("captchaFrames")) return { ...base, state: "captcha", detail: "Verification page (/account/access)" };
      return { ...base, state: "locked", detail: "Account access page (/account/access)" };
    }
    if (/^\/account\/suspended/i.test(path)) return { ...base, state: "locked", detail: "Account suspended page" };
    if (/^\/i\/flow\/(login|signup)/i.test(path) || /^\/(login|logout)\/?$/i.test(path)) return { ...base, state: "logged_out", detail: "Login page" };
    if (D.q("captchaFrames")) return { ...base, state: "captcha", detail: "Captcha frame on page" };

    const ts = toastState();
    if (ts) return { ...base, ...ts };

    const loggedIn = !!D.q("loggedInMarker");
    const primary = D.q("primaryColumn");
    if (!loggedIn && D.q("loginButtons")) return { ...base, state: "logged_out", detail: "Login buttons shown" };

    const err = D.q("errorDetail");
    if (err) {
      const t = D.text(err);
      if (D.re("rateLimit").test(t)) return { ...base, state: "rate_limit", detail: t.slice(0, 200) };
      if (D.re("automation").test(t)) return { ...base, state: "warning", detail: t.slice(0, 200) };
      return { ...base, state: "error_page", detail: t.slice(0, 200) || "Something went wrong" };
    }
    const empty = D.q("emptyState");
    if (empty) {
      const t = D.text(empty);
      if (D.re("accountGone").test(t) || D.re("postGone").test(t)) return { ...base, state: "not_found", detail: t.slice(0, 200) };
    }
    if (primary) {
      const head = D.text(primary).slice(0, 600);
      if (D.re("postGone").test(head) && !D.q("tweet", primary)) return { ...base, state: "not_found", detail: head.slice(0, 200) };
    }
    if (!primary) return { ...base, state: loggedIn ? "loading" : "loading", detail: "Page still loading" };
    if (!loggedIn) return { ...base, state: "loading", detail: "Session markers not rendered yet" };
    return { ...base, state: "ok", detail: "" };
  }

  // Wait until the page is no longer loading (or timeout -> last state).
  async function settle(timeoutMs = 20000) {
    const st = await D.waitFor(() => { const s = pageState(); return s.state !== "loading" ? s : null; }, timeoutMs, 500);
    return st || pageState();
  }

  globalThis.SXDetect = { pageState, toastState, settle, myHandle, messages };
})();
