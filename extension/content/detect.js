// ScoreX content script - page state detection. Returns one of the PAGE states
// (ok | loading | logged_out | captcha | locked | rate_limit | warning | error_page | not_found).
// The engine stops on captcha / locked / rate_limit / warning / logged_out and never clicks through them.

(function () {
  "use strict";
  if (globalThis.SXDetect) return;
  const D = globalThis.SXDom;

  // Paths that look like a handle but are X pages, never an account.
  const RESERVED = /^(home|explore|notifications|messages|search|settings|i|compose|login|logout|signup|tos|privacy|hashtag|lists|bookmarks|communities|premium|jobs|grok|account)$/i;

  function handleFromHref(el) {
    const href = el && el.getAttribute && el.getAttribute("href");
    const m = href && href.match(D.re("handleHref", ""));
    return m && !RESERVED.test(m[1]) ? m[1].toLowerCase() : null;
  }
  // "UserAvatar-Container-<handle>" on the element itself or inside it.
  function handleFromAvatar(el) {
    if (!el) return null;
    const re = D.re("avatarTestId", "");
    for (const a of [el, ...D.qa("navAvatar", el)]) {
      const m = String((a.getAttribute && a.getAttribute("data-testid")) || "").match(re);
      if (m && !RESERVED.test(m[1])) return m[1].toLowerCase();
    }
    return null;
  }

  // X's server-rendered session (window.__INITIAL_STATE__ as JSON in an inline script): the screen name of
  // session.user_id. Read once per page load (an account switch reloads the page), only as a last resort.
  let sessionCache;
  function jsonAt(t, start) {
    if (t[start] !== "{") return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return t.slice(start, i + 1);
    }
    return null;
  }
  function sessionHandle() {
    if (sessionCache !== undefined) return sessionCache;
    let found = null;
    const MARK = "window.__INITIAL_STATE__=";
    for (const s of document.scripts) {
      if (s.src || found) continue;
      const t = s.textContent || "";
      for (let i = t.indexOf(MARK); i >= 0 && !found; i = t.indexOf(MARK, i + 1)) {
        try {
          const json = jsonAt(t, i + MARK.length); // only a literal object assignment
          const st = json ? JSON.parse(json) : null;
          const uid = st && st.session && st.session.user_id;
          const users = st && st.entities && st.entities.users && st.entities.users.entities;
          const h = uid && users && Object.hasOwn(users, uid) && users[uid] && users[uid].screen_name;
          if (typeof h === "string" && /^[A-Za-z0-9_]{1,15}$/.test(h)) found = h.toLowerCase();
        } catch (_) { /* not JSON */ }
      }
    }
    if (found || document.readyState === "complete") sessionCache = found;
    return found;
  }

  // The logged-in account, from the navigation only (desktop nav, collapsed nav, account switcher, the
  // narrow/mobile layout's avatar button) or X's session data - never from the page content or the URL,
  // which show other people's handles.
  function myHandle() {
    const fromNav = handleFromHref(D.q("profileNavLink"));
    if (fromNav) return fromNav;
    const sw = D.q("accountSwitcher");
    if (sw) {
      const line = D.text(sw).split("\n").map((s) => s.trim()).find((s) => /^@[A-Za-z0-9_]{1,15}$/.test(s));
      if (line) return line.slice(1).toLowerCase();
      const av = handleFromAvatar(sw);
      if (av) return av;
    }
    const dash = D.q("dashProfileLink");
    if (dash) {
      const h = handleFromAvatar(dash) || handleFromHref(dash);
      if (h) return h;
    }
    return sessionHandle();
  }

  // Short system messages only: toasts/alerts, and dialogs that are not the reply composer and contain no
  // posts (otherwise words like "rate limit" inside someone's tweet would look like an X warning).
  function messages() {
    const out = [];
    const isSystem = (el) => !D.q("composerTextbox", el) && !D.q("tweet", el) && !D.q("tweetText", el) && !D.closest(el, "tweet");
    for (const el of [...D.qa("toast"), ...D.qa("dialog")]) {
      if (!isSystem(el)) continue;
      const t = D.text(el);
      if (t && t.length < 1500) out.push(t.slice(0, 400));
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
    if (primary && !D.q("tweet", primary)) {
      // X's own notices only: user cells, bios, names and post texts are left out, so a follower's bio that
      // says "this page doesn't exist" never turns your followers page or a profile into "not found".
      const head = D.textExcluding(primary, ["userCell", "profileBio", "profileUserName", "profileHeaderItems", "tweetText", "tweetUserName"], 600);
      if (D.re("postGone").test(head)) return { ...base, state: "not_found", detail: head.slice(0, 200) };
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
