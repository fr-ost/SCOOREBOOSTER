// ScoreX dashboard - app shell, hash router, header (status pill, Start/Pause/Resume/Stop, theme),
// shared context for the tabs. Storage rules: the UI reads everything, but writes only
// settings (sanitized), secrets and selector overrides. Everything else goes through messages.

import { K, MODE, STOP_LABEL, VERSION } from "../lib/constants.js";
import { getSettings, saveSettings, sanitizeSettings, DEFAULT_STATE } from "../lib/store.js";
import { deepClone } from "../lib/util.js";
import { warmup } from "../lib/safety.js";
import * as history from "../lib/history.js";
import { h, clear, icon, btn, busy, send, toast, statusPill, statusInfo, segmented, boundField, setTz, debounce, fmtDateTime, fmtAgo, add, fill } from "./components.js";

import overview from "./tabs/overview.js";
import targets from "./tabs/targets.js";
import review from "./tabs/review.js";
import models from "./tabs/models.js";
import tones from "./tabs/tones.js";
import safety from "./tabs/safety.js";
import historyTab from "./tabs/history.js";
import settingsTab from "./tabs/settings.js";

const TABS = [overview, targets, review, models, tones, safety, historyTab, settingsTab];
const WATCH = [K.state, K.targets, K.candidates, K.discovery, K.logs, K.spend, K.learning];

// ---------------------------------------------------------------- event bus + scopes

const globalListeners = new Map();
let scope = null; // per-tab listeners/timers, disposed on navigation
const newScope = () => ({ listeners: new Map(), timers: [], disposers: [] });
function disposeScope() {
  if (!scope) return;
  for (const t of scope.timers) { clearInterval(t); clearTimeout(t); }
  for (const d of scope.disposers) { try { d(); } catch (_) {} }
  scope = null;
}
function addListener(map, evt, fn) {
  if (!map.has(evt)) map.set(evt, new Set());
  map.get(evt).add(fn);
  return () => map.get(evt) && map.get(evt).delete(fn);
}
function emit(evt, ...args) {
  for (const map of [globalListeners, scope && scope.listeners]) {
    if (!map || !map.has(evt)) continue;
    for (const fn of [...map.get(evt)]) {
      try { fn(...args); } catch (e) { console.error("[ScoreX UI]", evt, e); }
    }
  }
}

// ---------------------------------------------------------------- context

const refreshers = new Set();
function runRefreshers(from) {
  for (const fn of [...refreshers]) {
    let keep = true;
    try { keep = fn(ctx.settings, from) !== false; } catch (_) { keep = false; }
    if (!keep) refreshers.delete(fn);
  }
}

let lastSavedJson = "";
let saveChain = Promise.resolve();
let saveIndTimer = null;
function setSaveIndicator(stateName) {
  const el = document.getElementById("saveInd");
  if (!el) return;
  clearTimeout(saveIndTimer);
  el.className = "save-ind is-" + stateName;
  el.textContent = stateName === "saving" ? "Saving…" : stateName === "saved" ? "Saved" : stateName === "error" ? "Not saved" : "";
  if (stateName === "saved") saveIndTimer = setTimeout(() => { el.className = "save-ind"; el.textContent = ""; }, 2200);
}

const ctx = {
  settings: null,
  data: {},
  status: null,
  counts: { pending: 0, queued: 0 },
  tabs: TABS,
  get state() { return { ...DEFAULT_STATE, ...(ctx.data[K.state] || {}) }; },
  get targets() { return ctx.data[K.targets] || {}; },
  targetList() { return Object.values(ctx.data[K.targets] || {}).filter((t) => t && t.handle); },
  on(evt, fn) { return addListener(scope ? scope.listeners : globalListeners, evt, fn); },
  emit,
  interval(fn, ms) { const t = setInterval(fn, ms); if (scope) scope.timers.push(t); return t; },
  timeout(fn, ms) { const t = setTimeout(fn, ms); if (scope) scope.timers.push(t); return t; },
  onDispose(fn) { if (scope) scope.disposers.push(fn); },
  addRefresher(fn) { refreshers.add(fn); },
  send,
  field(spec) { return boundField(ctx, spec); },
  navigate(id) { if (location.hash !== "#" + id) location.hash = "#" + id; else route(); },
  refreshStatus: () => refreshStatus(),
  refreshCounts: () => refreshCounts(),
  // Build the full settings object, sanitize, save, re-render bound fields with the sanitized values.
  save(mutator, { from = null } = {}) {
    const run = async () => {
      setSaveIndicator("saving");
      try {
        const draft = deepClone(ctx.settings);
        const out = mutator ? mutator(draft) : undefined;
        const next = sanitizeSettings(out && typeof out === "object" ? out : draft);
        const saved = deepClone(await saveSettings(next));
        lastSavedJson = JSON.stringify(saved);
        ctx.settings = saved;
        setTz(saved.timezone);
        runRefreshers(from);
        emit("settings", saved, from);
        updateHeader(true);
        setSaveIndicator("saved");
        return saved;
      } catch (e) {
        setSaveIndicator("error");
        toast("Could not save settings: " + ((e && e.message) || e), { type: "error" });
        return null;
      }
    };
    saveChain = saveChain.then(run, run);
    return saveChain;
  },
};

// ---------------------------------------------------------------- status + counts

async function refreshStatus() {
  const r = await send("getStatus", {}, { quiet: true });
  ctx.status = r && r.status ? r.status : null;
  updateHeader();
  emit("status", ctx.status);
}
async function refreshCounts() {
  try {
    const [p, a, q] = await Promise.all([history.byStatus("pending_review"), history.byStatus("approved"), history.byStatus("queued")]);
    const next = { pending: p.length, queued: a.length + q.length };
    const changed = next.pending !== ctx.counts.pending || next.queued !== ctx.counts.queued;
    ctx.counts = next;
    updateNavBadges();
    if (changed) emit("counts", next);
  } catch (_) { /* history not available yet */ }
}
const refreshStatusSoon = debounce(refreshStatus, 300);

// ---------------------------------------------------------------- shell

const view = document.getElementById("view");
const nav = document.getElementById("nav");
const topbar = document.getElementById("topbar");
const alertSlot = document.getElementById("alertSlot");

function buildNav() {
  clear(nav);
  for (const t of TABS) {
    nav.appendChild(h("a", { href: "#" + t.id, class: "nav-link", dataset: { tab: t.id } },
      icon(t.icon || t.id), h("span", { class: "nav-label" }, t.title), h("span", { class: "nav-badge", hidden: true })));
  }
  const foot = document.getElementById("sidebarFoot");
  clear(foot).appendChild(h("div", { class: "muted small" }, `ScoreX v${VERSION}`));
}
function updateNavBadges() {
  const b = nav.querySelector('[data-tab="review"] .nav-badge');
  if (b) { b.hidden = !ctx.counts.pending; b.textContent = String(ctx.counts.pending || ""); b.title = `${ctx.counts.pending} waiting for review`; }
  const a = nav.querySelector('[data-tab="overview"] .nav-badge');
  if (a) { const al = ctx.state.alert; a.hidden = !al; a.textContent = al ? "!" : ""; a.classList.toggle("nav-badge-danger", !!al); a.title = al ? "Safety alert" : ""; }
}

function buildHeader() {
  clear(topbar);
  const themeSeg = segmented(
    [["system", icon("monitor"), false, "System theme"], ["light", icon("sun"), false, "Light theme"], ["dark", icon("moon"), false, "Dark theme"]],
    (window.sxTheme && window.sxTheme.get()) || "system",
    (v) => {
      if (window.sxTheme) window.sxTheme.set(v);
      if (ctx.settings && ctx.settings.ui && ctx.settings.ui.theme !== v) ctx.save((s) => { s.ui = { ...(s.ui || {}), theme: v }; });
    },
    { label: "Theme", cls: "seg-icons" });
  themeSeg.id = "themeSwitch";
  for (const b of themeSeg.querySelectorAll("button")) b.setAttribute("aria-label", b.title);
  window.addEventListener("sx-theme", (e) => themeSeg.set(e.detail.pref));

  add(topbar, 
    h("div", { class: "topbar-left" },
      h("h1", { class: "page-title", id: "pageTitle" }, ""),
      h("span", { class: "save-ind", id: "saveInd", "aria-live": "polite" })),
    h("div", { class: "topbar-right" },
      h("div", { class: "engine", id: "engineBox" }),
      themeSeg));
  updateHeader(true);
}

let headerSig = "";
function updateHeader(force) {
  const state = ctx.state;
  const s = ctx.settings || {};
  const wu = (ctx.status && ctx.status.warmup) || warmup(state);
  const eff = (ctx.status && ctx.status.effectiveMode) || (s.mode === MODE.AUTO && !wu.active ? MODE.AUTO : MODE.REVIEW);
  const sig = JSON.stringify([state.status, state.stopReason, state.stopDetail, s.mode, eff, !!state.alert]);
  updateNavBadges();
  renderAlert();
  if (!force && sig === headerSig) return;
  headerSig = sig;
  const box = document.getElementById("engineBox");
  if (!box) return;
  const info = statusInfo(state);
  const modeLabel = eff === MODE.AUTO ? "Full auto" : s.mode === MODE.AUTO ? "Review (warm-up)" : "Review mode";
  const controls = h("div", { class: "engine-controls" });
  const act = (label, msg, iconName, kind) => btn(label, (e) => {
    const b = e.currentTarget;
    busy(b, async () => {
      const r = await send(msg, {}, { label });
      if (r) { toast(`${label}: done`, { type: "success" }); refreshStatus(); }
    });
  }, { kind, iconName, size: "sm", id: "btn-" + msg });
  if (state.status === "running") add(controls, act("Pause", "pause", "pause"), act("Stop", "stop", "stop", "ghost"));
  else if (state.status === "paused") add(controls, act("Resume", "resume", "play", "primary"), act("Stop", "stop", "stop", "ghost"));
  else if (state.stopReason && state.stopReason !== "user") add(controls, act("Resume", "resume", "play", "primary"));
  else add(controls, act("Start", "start", "play", "primary"));
  fill(box, 
    h("div", { class: "engine-status" }, statusPill(state), h("span", { class: ["mode-chip", eff === MODE.AUTO && "mode-auto"], title: "Mode" }, modeLabel)),
    controls);
  box.title = [info.label, info.reason, info.detail].filter(Boolean).join(" - ");
}

function renderAlert() {
  const al = ctx.state.alert;
  const sig = al ? JSON.stringify(al) : "";
  if (alertSlot.dataset.sig === sig) return;
  alertSlot.dataset.sig = sig;
  clear(alertSlot);
  if (!al) return;
  const reason = STOP_LABEL[al.reason] || al.reason || "Safety stop";
  alertSlot.appendChild(h("div", { class: "alert-banner", role: "alert" },
    icon("alert", "alert-icon"),
    h("div", { class: "alert-text" },
      h("strong", null, reason),
      al.detail ? h("div", null, al.detail) : null,
      h("div", { class: "alert-time" }, `${fmtDateTime(al.at)} (${fmtAgo(al.at)}) · ScoreX stopped and will not continue until you resume.`)),
    h("div", { class: "alert-actions" },
      btn("I checked my account - resume", (e) => {
        const b = e.currentTarget;
        busy(b, async () => { const r = await send("resume", {}, { label: "Resume" }); if (r) { toast("Resumed", { type: "success" }); refreshStatus(); } });
      }, { kind: "light", size: "sm" }),
      btn("Dismiss", (e) => {
        const b = e.currentTarget;
        busy(b, async () => { const r = await send("clearAlert", {}, { label: "Dismiss alert" }); if (r) refreshStatus(); });
      }, { kind: "ghost-light", size: "sm" }))));
}

// ---------------------------------------------------------------- router

let renderSeq = 0;
async function route() {
  const id = (location.hash || "#overview").slice(1).split(/[?&]/)[0];
  const tab = TABS.find((t) => t.id === id) || TABS[0];
  const seq = ++renderSeq;
  disposeScope();
  scope = newScope();
  view.removeAttribute("data-ready");
  clear(view);
  view.dataset.tab = tab.id;
  const title = document.getElementById("pageTitle");
  if (title) title.textContent = tab.title;
  document.title = `${tab.title} · ScoreX`;
  for (const a of nav.querySelectorAll(".nav-link")) {
    const on = a.dataset.tab === tab.id;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
  try {
    await tab.render(view, ctx);
  } catch (e) {
    console.error("[ScoreX UI] tab render failed", tab.id, e);
    view.appendChild(h("div", { class: "card" }, h("div", { class: "card-body" }, h("strong", null, "This tab failed to render. "), String((e && e.message) || e))));
  }
  if (seq === renderSeq) view.dataset.ready = tab.id;
}

// ---------------------------------------------------------------- init

async function init() {
  const [settings, data] = await Promise.all([getSettings(), chrome.storage.local.get(WATCH)]);
  ctx.settings = deepClone(settings);
  lastSavedJson = JSON.stringify(ctx.settings);
  for (const k of WATCH) ctx.data[k] = data[k];
  setTz(ctx.settings.timezone);
  try {
    const stored = window.localStorage.getItem("sx.theme");
    const pref = ctx.settings.ui && ctx.settings.ui.theme;
    if (!stored && pref && pref !== "system" && window.sxTheme) window.sxTheme.set(pref);
  } catch (_) { /* storage blocked */ }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const [key, ch] of Object.entries(changes)) {
      if (key === K.settings) {
        const s = deepClone(sanitizeSettings(deepClone(ch.newValue || {})));
        const j = JSON.stringify(s);
        if (j === lastSavedJson) continue;
        lastSavedJson = j;
        ctx.settings = s;
        setTz(s.timezone);
        runRefreshers(null);
        emit("settings", s, null);
        updateHeader(true);
      } else if (WATCH.includes(key)) {
        ctx.data[key] = ch.newValue;
        emit(key, ch.newValue);
        if (key === K.state) { updateHeader(); refreshStatusSoon(); }
      } else if (key === K.secretsRev || key === K.secrets) emit("secrets");
      else if (key === K.selectorOverrides) emit(key, ch.newValue);
    }
  });

  buildNav();
  buildHeader();
  window.addEventListener("hashchange", route);
  await route();
  refreshStatus();
  refreshCounts();
  setInterval(() => {
    if (document.visibilityState !== "visible") return;
    refreshStatus();
    refreshCounts();
  }, 5000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { refreshStatus(); refreshCounts(); } });
  // Countdown texts (warm-up, next check) tick once a minute.
  setInterval(() => emit("tick"), 30000);
}

init().catch((e) => {
  console.error("[ScoreX UI] init failed", e);
  view.appendChild(h("div", { class: "card" }, h("div", { class: "card-body" }, "ScoreX could not start the dashboard: " + ((e && e.message) || e))));
});

