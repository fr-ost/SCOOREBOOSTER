// ScoreX - theme bootstrap. Classic script loaded in <head> before the stylesheet so the page never
// flashes the wrong colours. Preference lives in localStorage "sx.theme" = system | light | dark.
// Sets <html data-theme="light|dark"> (resolved) and <html data-theme-pref="system|light|dark">.
(function () {
  "use strict";
  var KEY = "sx.theme";
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function pref() {
    var v = null;
    try { v = window.localStorage.getItem(KEY); } catch (e) { v = null; }
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  }
  function resolved(p) {
    if (p === "light" || p === "dark") return p;
    return mq && mq.matches ? "dark" : "light";
  }
  function apply() {
    var p = pref();
    root.setAttribute("data-theme", resolved(p));
    root.setAttribute("data-theme-pref", p);
    try { window.dispatchEvent(new CustomEvent("sx-theme", { detail: { pref: p, theme: resolved(p) } })); } catch (e) { /* old browsers */ }
  }
  function set(p) {
    if (p !== "light" && p !== "dark") p = "system";
    try { window.localStorage.setItem(KEY, p); } catch (e) { /* storage blocked: still apply for this page */ }
    apply();
    if (p === "system") root.setAttribute("data-theme", resolved("system"));
  }

  apply();
  if (mq) {
    var onChange = function () { if (pref() === "system") apply(); };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }
  // Keep every open ScoreX page (dashboard + popup) in sync.
  window.addEventListener("storage", function (e) { if (e.key === KEY) apply(); });

  window.sxTheme = { get: pref, set: set, apply: apply, resolved: function () { return resolved(pref()); } };
})();
