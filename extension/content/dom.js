// ScoreX content script - DOM helpers. Every selector lookup goes through q()/qa() so the
// fallback lists in selectors.js (plus user overrides from storage) are applied consistently.

(function () {
  "use strict";
  if (globalThis.SXDom) return;

  const base = globalThis.SX_SELECTORS;
  let cfg = base;

  function merge(a, b) {
    if (!b || typeof b !== "object") return a;
    const out = Array.isArray(a) ? a.slice() : { ...a };
    for (const k of Object.keys(b)) {
      const bv = b[k];
      if (Array.isArray(bv) || typeof bv !== "object" || bv === null) out[k] = bv;
      else out[k] = merge(a && a[k] ? a[k] : {}, bv);
    }
    return out;
  }

  // Apply user overrides saved from the dashboard (sx.selectorOverrides).
  function loadOverrides() {
    try {
      chrome.storage.local.get("sx.selectorOverrides").then((r) => {
        const o = r && r["sx.selectorOverrides"];
        cfg = o && typeof o === "object" ? merge(base, o) : base;
      }).catch(() => {});
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area === "local" && ch["sx.selectorOverrides"]) {
          const o = ch["sx.selectorOverrides"].newValue;
          cfg = o && typeof o === "object" ? merge(base, o) : base;
        }
      });
    } catch (_) { /* extension context gone */ }
  }
  loadOverrides();

  const list = (key) => {
    const v = cfg.sel[key];
    if (!v) throw new Error("unknown selector key: " + key);
    return Array.isArray(v) ? v : [v];
  };
  const reCache = new Map();
  function re(key, flags = "i") {
    const src = cfg.text[key] != null ? cfg.text[key] : cfg.misc[key];
    const k = key + "|" + src + "|" + flags;
    if (!reCache.has(k)) reCache.set(k, new RegExp(src, flags));
    return reCache.get(k);
  }

  function q(key, root) {
    const r = root || document;
    for (const s of list(key)) {
      try { const el = r.querySelector(s); if (el) return el; } catch (_) { /* bad override */ }
    }
    return null;
  }
  function qa(key, root) {
    const r = root || document;
    for (const s of list(key)) {
      try { const els = r.querySelectorAll(s); if (els.length) return Array.from(els); } catch (_) {}
    }
    return [];
  }
  function matches(el, key) {
    if (!el || !el.matches) return false;
    return list(key).some((s) => { try { return el.matches(s); } catch (_) { return false; } });
  }
  function closest(el, key) {
    if (!el) return null;
    for (const s of list(key)) { try { const c = el.closest(s); if (c) return c; } catch (_) {} }
    return null;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
  }

  function text(el) { return el ? String(el.innerText || el.textContent || "").replace(/ /g, " ").trim() : ""; }

  // Wait until fn() returns a truthy value. Uses a MutationObserver (works in background tabs, where
  // timers are throttled) plus a slow poll as a safety net.
  function waitFor(fn, timeoutMs = 15000, pollMs = 400) {
    return new Promise((resolve) => {
      let done = false, obs = null, poll = null, timer = null;
      const finish = (v) => {
        if (done) return;
        done = true;
        if (obs) obs.disconnect();
        clearInterval(poll); clearTimeout(timer);
        resolve(v);
      };
      const check = () => { try { const v = fn(); if (v) finish(v); } catch (_) {} };
      check();
      if (done) return;
      obs = new MutationObserver(check);
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      poll = setInterval(check, pollMs);
      timer = setTimeout(() => finish(null), timeoutMs);
    });
  }

  // "12.3K" / "1,234" / "1.2M" -> number
  function parseCount(t) {
    if (t == null) return null;
    const s = String(t).replace(/\s/g, "").replace(/,/g, "");
    const m = s.match(/([\d.]+)([KMB])?/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] || "").toLowerCase()] || 1));
  }

  // Click like a person: pointer/mouse sequence at the element's centre, then click().
  function humanClick(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: "center", inline: "nearest" }); } catch (_) {}
    const r = el.getBoundingClientRect();
    const x = r.left + r.width * (0.35 + Math.random() * 0.3);
    const y = r.top + r.height * (0.35 + Math.random() * 0.3);
    const o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window, button: 0 };
    try {
      el.dispatchEvent(new PointerEvent("pointerover", o));
      el.dispatchEvent(new PointerEvent("pointerenter", o));
      el.dispatchEvent(new MouseEvent("mouseover", o));
      el.dispatchEvent(new PointerEvent("pointerdown", o));
      el.dispatchEvent(new MouseEvent("mousedown", o));
      el.dispatchEvent(new PointerEvent("pointerup", o));
      el.dispatchEvent(new MouseEvent("mouseup", o));
    } catch (_) {}
    el.click();
    return true;
  }

  function isDisabled(el) {
    return !el || el.disabled || el.getAttribute("aria-disabled") === "true" || el.getAttribute("disabled") != null;
  }

  function cfgNow() { return cfg; }

  globalThis.SXDom = { q, qa, matches, closest, re, sleep, visible, text, waitFor, parseCount, humanClick, isDisabled, cfg: cfgNow };
})();
