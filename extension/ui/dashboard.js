// ScoreX dashboard - app shell ("Growth ledger"): a grouped left rail (WORK / GROWTH / SETUP) that collapses to an
// icon rail (721-1100 px) and a Menu sheet (<= 720 px), a sticky engine bar (screen title, date/time, account chip,
// mode tag, risk chip, status + reason, ONE primary engine button, Stop, theme menu, saved indicator), a red safety
// banner, a health square in the rail footer, the hash router (#route?h=&view=&s=&resume=1) and the shared ctx.
// Storage rules: the UI reads everything, but writes only settings (sanitized), secrets and selector/provider
// overrides. Everything else goes through messages.
//
// ctx (passed to every tab's render(root, ctx); each render gets its own, inheriting from the shared ctx, whose
// registrations below end with that render - see screenCtx):
//   settings, data[K.x] (watched storage), status (getStatus), counts { pending, queued }, state, targets, targetList()
//   on(evt, fn) (tab-scoped; events: status, counts, settings, tick, secrets, health, params, and each watched key)
//   send(name, payload, opts), field(spec), save(mutator), addRefresher(fn), onDispose(fn), interval/timeout(fn, ms)
//   route (screen id), params ({ h, view, s, ... } from #route?h=..), setParams(patch, { push }) (no re-render; tabs that
//   listen to "params" also get same-screen hash changes instead of a re-render), setTitle(text), navigate(id),
//   openReviewStop(), confirmFullAuto(), setMode(mode), health ({ level, issues }), refreshStatus(), refreshCounts()

import { K, STATUS, STOP_LABEL, VERSION, MODE } from "../lib/constants.js";
import { getSettings, saveSettings, sanitizeSettings, DEFAULT_STATE } from "../lib/store.js";
import { deepClone } from "../lib/util.js";
import * as history from "../lib/history.js";
import {
  h, clear, icon, btn, busy, send, toast, statusInfo, primaryAction, statusPill, isSafetyStop, setTz, debounce,
  fmtDateTime, fmtAgo, fmtTime, fmtWeekday, fill, menu, accountChip, modeTag, riskChip, safetyBanner, reviewStopDialog,
  confirmFullAuto, switchMode, healthCheck, healthLabel, healthShort, diagSquare, resetTableStates, boundField, registerOverlay,
} from "./components.js";

import overview from "./tabs/overview.js";
import review from "./tabs/review.js";
import targets from "./tabs/targets.js";
import discover from "./tabs/discover.js";
import scores from "./tabs/scores.js";
import historyTab from "./tabs/history.js";
import tones from "./tabs/tones.js";
import models from "./tabs/models.js";
import safety from "./tabs/safety.js";
import settingsTab from "./tabs/settings.js";
import { currentLicense, unlocked, watchLicense, showLockPage } from "./license_gate.js";

// Rail: seven screens in three groups; labels are also the screen titles. History holds every comment plus the stats and
// spend (route #history, views Comments | Stats | Spend). Settings holds four tabs - General, Tone, Models & costs, Safety -
// each still its own route (#settings, #tones, #models, #safety), all shown under the one Settings rail item.
const NAV = [
  { group: "Work", items: [
    { id: "overview", label: "Today", icon: "today" },
    { id: "review", label: "Review", icon: "review" },
    { id: "targets", label: "Targets", icon: "targets" },
    { id: "discover", label: "Discover", icon: "discover" },
  ] },
  { group: "Track", items: [
    { id: "history", label: "History", icon: "history" },
    { id: "scores", label: "Scores", icon: "scores" },
  ] },
  { group: "Setup", items: [
    { id: "settings", label: "Settings", icon: "settings" },
  ] },
];
const SETUP_TABS = [["settings", "General"], ["tones", "Tone"], ["models", "Models & costs"], ["safety", "Safety"]];
const RAIL_OF = { tones: "settings", models: "settings", safety: "settings" }; // route -> its rail item
const MODULES = { overview, review, targets, discover, scores, history: historyTab, tones, models, safety, settings: settingsTab };
const NAV_ITEMS = NAV.flatMap((g) => g.items);
const TABS = Object.values(MODULES);
const LABEL = { ...Object.fromEntries(NAV_ITEMS.map((it) => [it.id, it.label])), tones: "Settings", models: "Settings", safety: "Settings" };
// Old and friendly names that open a screen (with default params).
const ALIASES = {
  results: ["history", { view: "ov" }], stats: ["history", { view: "ov" }], comments: ["history", { view: "comments" }],
  diagnostics: ["settings", { view: "diagnostics" }], general: ["settings", {}], today: ["overview", {}], dashboard: ["overview", {}],
};
const WATCH = [K.state, K.targets, K.candidates, K.blacklist, K.discovery, K.logs, K.spend, K.learning, K.scoreboard, K.conversations, K.secretsRev];

// ---------------------------------------------------------------- event bus + scopes

const globalListeners = new Map();
let scope = null; // the current screen's listeners/timers/disposers/refreshers, disposed on navigation
const newScope = () => ({ listeners: new Map(), timers: [], disposers: [], dead: false });
function disposeScope() {
  if (!scope) return;
  const sc = scope;
  scope = null;
  sc.dead = true;
  for (const t of sc.timers) { clearInterval(t); clearTimeout(t); }
  for (const d of sc.disposers) { try { d(); } catch (_) {} }
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
  if (stateName === "saved") saveIndTimer = setTimeout(() => { el.className = "save-ind"; el.textContent = ""; }, 2000);
}

let current = { id: null, params: {} };
const ctx = {
  settings: null,
  data: {},
  status: null,
  counts: { pending: 0, queued: 0 },
  health: null,
  tabs: TABS,
  route: null,
  params: {},
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
  // Update the route params in the URL without re-rendering the screen (e.g. a drawer: #targets?h=naval).
  setParams(patch = {}, { push = false } = {}) {
    const next = { ...ctx.params, ...patch };
    for (const k of Object.keys(next)) if (next[k] == null || next[k] === "" || next[k] === false) delete next[k];
    const qs = new URLSearchParams(next).toString();
    const hash = "#" + (ctx.route || "overview") + (qs ? "?" + qs : "");
    if (location.hash !== hash) window.history[push ? "pushState" : "replaceState"](null, "", hash);
    ctx.params = next;
    current.params = next;
  },
  setTitle(text) {
    const t = text || LABEL[ctx.route] || "ScoreX";
    const el = document.getElementById("screenTitle");
    if (el) el.textContent = t;
    document.title = `${t} · ScoreX`;
  },
  openReviewStop: () => openReviewStop(),
  confirmFullAuto: () => confirmFullAuto(ctx),
  setMode: (mode) => switchMode(ctx, mode),
  refreshStatus: () => refreshStatus(),
  refreshCounts: () => refreshCounts(),
  refreshHealth: () => refreshHealth(),
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
        refreshHealthSoon();
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

// Each render gets its own ctx whose on / interval / timeout / onDispose / addRefresher / field / setParams / setTitle
// are bound to that render's scope. A screen still awaiting when the user moves on cannot register anything into the
// next screen: its late registrations are dropped (a late onDispose runs at once). Its params are the live route
// params only while it is on screen; once left it sees none, so it never acts on the next screen's ?h= (a score check,
// a smart-follower lookup).
const NO_PARAMS = Object.freeze({});
function screenCtx(sc) {
  const c = Object.create(ctx);
  const live = () => !sc.dead;
  Object.defineProperty(c, "params", { get: () => (live() ? ctx.params : NO_PARAMS), enumerable: true });
  c.on = (evt, fn) => (live() ? addListener(sc.listeners, evt, fn) : () => false);
  c.interval = (fn, ms) => { if (!live()) return null; const t = setInterval(fn, ms); sc.timers.push(t); return t; };
  c.timeout = (fn, ms) => { if (!live()) return null; const t = setTimeout(fn, ms); sc.timers.push(t); return t; };
  c.onDispose = (fn) => { if (live()) sc.disposers.push(fn); else { try { fn(); } catch (_) { /* ignore */ } } };
  c.addRefresher = (fn) => { if (!live()) return; refreshers.add(fn); sc.disposers.push(() => refreshers.delete(fn)); };
  c.field = (spec) => boundField(c, spec);
  c.setParams = (patch, opts) => { if (live()) ctx.setParams(patch, opts); };
  c.setTitle = (text) => { if (live()) ctx.setTitle(text); };
  return c;
}

// ---------------------------------------------------------------- status, counts, health

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
async function refreshHealth() {
  try {
    ctx.health = await healthCheck({ settings: ctx.settings, state: ctx.state, secretsRev: ctx.data[K.secretsRev] });
  } catch (e) { console.error("[ScoreX UI] health", e); }
  renderHealth();
  emit("health", ctx.health);
}
const refreshStatusSoon = debounce(refreshStatus, 300);
const refreshHealthSoon = debounce(refreshHealth, 600);

// ---------------------------------------------------------------- shell

const app = document.getElementById("app");
const view = document.getElementById("view");
const nav = document.getElementById("nav");
const alertSlot = document.getElementById("alertSlot");
const railFoot = document.getElementById("railFoot");
const menuBtn = document.getElementById("menuBtn");
const railScrim = document.getElementById("railScrim");

function buildNav() {
  clear(nav);
  NAV.forEach((g, gi) => {
    const gid = "navg-" + g.group.toLowerCase();
    if (gi) nav.appendChild(h("div", { class: "rail-group-sep", "aria-hidden": "true" }));
    nav.appendChild(h("div", { class: "rail-group", id: gid }, g.group));
    nav.appendChild(h("div", { class: "rail-list", role: "group", "aria-labelledby": gid },
      g.items.map((it) => h("a", { href: "#" + it.id, class: "tab rail-item", dataset: { tab: it.id }, title: it.label },
        icon(it.icon, "rail-icon"),
        h("span", { class: "tab-label rail-label" }, it.label),
        it.id === "review" ? h("span", { class: "tab-count rail-count", hidden: true }) : null,
        it.id === "overview" ? h("span", { class: "tab-alert", hidden: true, role: "img", "aria-label": "Safety alert" }) : null))));
  });
  fill(document.getElementById("foot"), `ScoreX v${VERSION}`);
  renderHealth();
}
function updateNavBadges() {
  const b = nav.querySelector('[data-tab="review"] .tab-count');
  if (b) {
    const n = ctx.counts.pending || 0;
    b.hidden = !n; b.textContent = String(n || "");
    b.setAttribute("aria-label", `${n} waiting for review`);
    b.closest(".tab").title = n ? `Review: ${n} waiting` : "Review";
  }
  const a = nav.querySelector('[data-tab="overview"] .tab-alert');
  if (a) a.hidden = !ctx.state.alert;
}
function renderHealth() {
  const hc = ctx.health;
  const lvl = hc ? hc.level : null;
  const label = healthLabel(hc);
  const short = healthShort(hc);
  const tip = [label, ...(hc ? hc.issues.map((i) => "- " + i.text) : []), "Open Settings > Diagnostics"].join("\n");
  fill(railFoot,
    h("a", { class: ["health", lvl && "health-" + lvl], href: "#diagnostics", id: "healthLink", title: tip, "aria-label": label + ". Open Diagnostics." },
      diagSquare(lvl === "fail" ? "fail" : lvl === "warn" ? "warn" : lvl === "ok" ? "pass" : "skip", label),
      h("span", { class: "txt" }, "Health: ", h("b", null, short))),
    h("span", { class: "ver" }, `ScoreX v${VERSION}`));
}

// ---------------------------------------------------------------- Menu sheet (<= 720 px)

const narrowMq = window.matchMedia("(max-width: 720px)");
let railLayer = null, railPrevFocus = null;
function setMenuOpen(open) {
  if (open === app.classList.contains("menu-open")) return;
  app.classList.toggle("menu-open", open);
  railScrim.hidden = !open;
  menuBtn.setAttribute("aria-expanded", String(open));
  const rail = document.getElementById("rail");
  if (open) {
    railPrevFocus = document.activeElement;
    railLayer = registerOverlay("rail");
    rail.setAttribute("role", "dialog");
    rail.setAttribute("aria-modal", "true");
    (nav.querySelector(".tab.active") || nav.querySelector(".tab")).focus();
  } else {
    if (railLayer) { railLayer.release(); railLayer = null; }
    rail.removeAttribute("role");
    rail.removeAttribute("aria-modal");
    if (railPrevFocus && railPrevFocus.isConnected) railPrevFocus.focus();
    else menuBtn.focus();
  }
}
function initMenuSheet() {
  menuBtn.appendChild(icon("menu"));
  const closeBtn = document.getElementById("railClose");
  closeBtn.appendChild(icon("x"));
  menuBtn.addEventListener("click", () => setMenuOpen(!app.classList.contains("menu-open")));
  closeBtn.addEventListener("click", () => setMenuOpen(false));
  railScrim.addEventListener("mousedown", () => setMenuOpen(false));
  nav.addEventListener("click", (e) => { if (e.target.closest(".tab") && app.classList.contains("menu-open")) { railPrevFocus = null; setMenuOpen(false); } });
  document.addEventListener("keydown", (e) => {
    if (!app.classList.contains("menu-open") || !railLayer || !railLayer.isTop()) return;
    if (e.key === "Escape") { e.preventDefault(); setMenuOpen(false); return; }
    if (e.key === "Tab") {
      const rail = document.getElementById("rail");
      const f = [...rail.querySelectorAll("a[href], button:not([disabled])")].filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (!rail.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }, true);
  const onMq = () => { if (!narrowMq.matches) setMenuOpen(false); };
  if (narrowMq.addEventListener) narrowMq.addEventListener("change", onMq); else narrowMq.addListener(onMq);
}

// ---------------------------------------------------------------- engine bar

const THEME_ICON = { system: "monitor", light: "sun", dark: "moon" };
function buildHeader() {
  const themeBtn = h("button", { type: "button", class: "btn btn-sm btn-ghost btn-icon", id: "themeBtn", "aria-haspopup": "menu", "aria-expanded": "false", "aria-label": "Theme", title: "Theme" });
  const setIcon = (pref) => { fill(themeBtn, icon(THEME_ICON[pref] || "monitor")); themeBtn.title = `Theme: ${pref || "system"}`; };
  setIcon((window.sxTheme && window.sxTheme.get()) || "system");
  const setTheme = (v) => {
    if (window.sxTheme) window.sxTheme.set(v);
    if (ctx.settings && ctx.settings.ui && ctx.settings.ui.theme !== v) ctx.save((s) => { s.ui = { ...(s.ui || {}), theme: v }; });
  };
  themeBtn.addEventListener("click", () => {
    const pref = (window.sxTheme && window.sxTheme.get()) || "system";
    menu(themeBtn, [["system", "System", "monitor"], ["light", "Light", "sun"], ["dark", "Dark", "moon"]].map(([v, l]) => ({ label: l, value: v, radio: true, checked: pref === v, onSelect: () => setTheme(v) })),
      { id: "themeSwitch", label: "Theme" });
  });
  window.addEventListener("sx-theme", (e) => setIcon(e.detail && e.detail.pref));
  fill(document.getElementById("themeSlot"), themeBtn);
  updateClock();
  updateHeader(true);
}
function updateClock() {
  const el = document.getElementById("screenSub");
  if (!el || !ctx.settings) return;
  const now = Date.now();
  el.textContent = `${fmtWeekday(now)} · ${fmtTime(now)} ${ctx.settings.timezone || ""}`.trim();
}

function engineAction(label, msg, iconName, kind, extra = {}) {
  return btn(label, (e) => {
    const b = e.currentTarget;
    busy(b, async () => {
      const r = await send(msg, {}, { label });
      if (r) { toast(`${label}: done`, { type: "success" }); refreshStatus(); }
    });
  }, { kind, iconName, size: "sm", id: "btn-" + msg, ...extra });
}

// Short "why" for the bar plus a longer sentence for the tooltip.
function watchLine(w) {
  const mins = w && w.intervalSec ? Math.round(w.intervalSec / 60) : null;
  return `Watching slowly: nothing new in the last ${(w && w.emptyStreak) || "few"} checks${mins ? `, checking every ${mins} min now` : ""}.`;
}
const FOOTPRINT_WAIT = "X page-load budget reached - waiting"; // lib/safety.js GATE_LABEL.footprint
function engineWhy(state, status) {
  const now = Date.now();
  const info = statusInfo(state);
  if (state.status === STATUS.RUNNING) {
    const ah = status && status.activeHours;
    const w = status && status.watch;
    const sub = (status && status.sub) || "";
    const slow = w && w.slow ? (/^Watching slowly/.test(sub) ? sub : watchLine(w)) : "";
    if (ah && ah.inside === false && ah.opensAt) return [`sleeping until ${fmtTime(ah.opensAt)}`, `Outside active hours: sleeping until ${fmtTime(ah.opensAt)}.`];
    if (state.breakUntil && state.breakUntil > now) return [`break until ${fmtTime(state.breakUntil)}`, `On a break until ${fmtTime(state.breakUntil)}.`];
    if (state.nextTickWhy === FOOTPRINT_WAIT && state.nextTickAt > now) return ["page-load budget", `${FOOTPRINT_WAIT} (next check ${fmtTime(state.nextTickAt)}). The engine waits, it never stops.`];
    if (state.nextCommentAt && state.nextCommentAt > now) return [`next comment ${fmtTime(state.nextCommentAt)}`, `Next comment allowed at ${fmtTime(state.nextCommentAt)}.${slow ? " " + slow : ""}`];
    if (slow) return ["watching slowly", slow];
    if (state.nextTickAt && state.nextTickAt > now) return [`next check ${fmtTime(state.nextTickAt)}`, `Next check at ${fmtTime(state.nextTickAt)}.`];
    return ["", "Running"];
  }
  if (info.kind === "danger") return [info.short, [info.reason, info.detail].filter(Boolean).join(": ")];
  if (state.status === STATUS.PAUSED) return ["nothing posts", "Paused: nothing is generated or posted until you resume."];
  return ["", state.lastTickAt ? `Stopped. Last check ${fmtAgo(state.lastTickAt)}.` : "Stopped. Press Start to begin."];
}

let headerSig = "";
function updateHeader(force) {
  const state = ctx.state;
  const st = ctx.status || {};
  updateNavBadges();
  renderAlert();
  if (!ctx.settings) return;
  const [why, whyLong] = engineWhy(state, st);
  // The mode comes from the settings this page just saved (lib/safety.js effectiveMode is settings.mode); the status
  // poll can lag a save or an import by up to 5 s.
  const mode = ctx.settings.mode === MODE.AUTO ? MODE.AUTO : MODE.REVIEW;
  const risk = st.risk && st.risk.level ? st.risk : null;
  const sig = JSON.stringify([state.status, state.stopReason, state.stopDetail, !!state.alert, why, whyLong.replace(/\d+ ?(min|s|h)\b/g, ""), mode, risk, ctx.settings.account && ctx.settings.account.handle, state.me]);
  const box = document.getElementById("engineBox");
  if (!box) return;
  if (!force && sig === headerSig) { box.title = whyLong || statusInfo(state).label; return; } // only the minutes changed
  headerSig = sig;
  // Keep keyboard focus on the same control across re-renders.
  const ae = document.activeElement;
  const keepFocus = ae && ae.id && (box.contains(ae) || document.getElementById("barChips").contains(ae)) ? ae.id : null;
  const [label, msg, ic] = primaryAction(state);
  const canStop = state.status === STATUS.RUNNING || state.status === STATUS.PAUSED;
  const primary = msg === "reviewStop"
    ? btn(label, () => openReviewStop(), { kind: "primary", iconName: ic, size: "sm", id: "btn-reviewStop", title: "See why ScoreX stopped, check your account, then resume" })
    : engineAction(label, msg, ic, "primary");
  fill(box,
    statusPill(state, { why }),
    primary,
    engineAction("Stop", "stop", "stop", "quiet", { disabled: !canStop, title: canStop ? "Stop the engine" : "Already stopped" }));
  box.title = whyLong || statusInfo(state).label;

  const modeBtn = h("button", { type: "button", class: "mode-btn", id: "modeTag", "aria-haspopup": "menu", "aria-expanded": "false", title: (mode === MODE.AUTO ? "Full auto: posts on its own within your limits" : "Review: you approve every reply") + ". Click to change." },
    modeTag(mode), h("span", { class: "sr-only" }, "Change mode"));
  modeBtn.addEventListener("click", () => {
    menu(modeBtn, [
      { label: "Review", hint: "you approve every reply", radio: true, checked: ctx.settings.mode !== MODE.AUTO, value: MODE.REVIEW, onSelect: () => switchMode(ctx, MODE.REVIEW) },
      { label: "Full auto", hint: "posts on its own", radio: true, checked: ctx.settings.mode === MODE.AUTO, value: MODE.AUTO, onSelect: () => switchMode(ctx, MODE.AUTO) },
    ], { id: "modeMenu", label: "Mode" });
  });
  fill(document.getElementById("barChips"), accountChip(ctx.settings, state, { id: "acctChip" }), modeBtn, risk ? riskChip(risk, { id: "riskChip" }) : null);
  if (keepFocus) { const el = document.getElementById(keepFocus); if (el && !el.disabled) el.focus({ preventScroll: true }); }
}

const alertTime = (al) => `${fmtDateTime(al.at)} (${fmtAgo(al.at)}). ScoreX stopped and waits for you.`;
function renderAlert() {
  const state = ctx.state;
  const al = state.alert;
  const sig = al ? JSON.stringify([al, state.status]) : "";
  if (alertSlot.dataset.sig === sig) {
    const t = al && alertSlot.querySelector(".alert-time"); // only the age changed
    if (t) t.textContent = alertTime(al);
    return;
  }
  alertSlot.dataset.sig = sig;
  clear(alertSlot);
  if (!al) return;
  alertSlot.appendChild(safetyBanner({
    id: "safetyBanner",
    title: STOP_LABEL[al.reason] || al.label || al.reason || "Safety stop",
    detail: al.detail || "",
    time: alertTime(al),
    actions: [
      btn("Review and resume…", () => openReviewStop(), { kind: "light", size: "sm", id: "alertReviewBtn" }),
      btn("Dismiss", (e) => {
        const b = e.currentTarget;
        busy(b, async () => { const r = await send("clearAlert", {}, { label: "Dismiss alert" }); if (r) refreshStatus(); });
      }, { kind: "ghost-light", size: "sm", id: "alertDismissBtn", title: "Hide this banner (ScoreX stays stopped)" }),
    ],
  }));
}

let reviewOpen = false;
async function openReviewStop() {
  if (reviewOpen) return;
  if (!isSafetyStop(ctx.state)) { toast("ScoreX is not stopped for safety right now.", { type: "info" }); return; }
  reviewOpen = true;
  try { await reviewStopDialog(ctx); } finally { reviewOpen = false; }
}

// ---------------------------------------------------------------- router

function parseHash() {
  const raw = (location.hash || "").replace(/^#/, "");
  const qi = raw.search(/[?&]/);
  let id = "overview";
  try { id = decodeURIComponent(qi >= 0 ? raw.slice(0, qi) : raw).trim().toLowerCase() || "overview"; } catch (_) { /* bad escape */ }
  let params = {};
  for (const [k, v] of new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : "")) params[k] = v;
  if (ALIASES[id]) {
    const [to, def] = ALIASES[id];
    params = { ...def, ...params };
    id = to;
  }
  return { id, params };
}

function handleResumeParam(params) {
  if (params.resume !== "1") return;
  ctx.setParams({ resume: null });
  if (isSafetyStop(ctx.state)) setTimeout(() => openReviewStop(), 0);
}

// The tab strip at the top of Settings, Tone, Models & costs and Safety (links: each tab is its own route).
function setupTabs(active) {
  return h("nav", { class: "filterbar setup-tabs", id: "setupTabs", "aria-label": "Settings sections" },
    h("div", { class: "seg seg-lg" }, SETUP_TABS.map(([r, label]) => h("a", { href: "#" + r, class: ["seg-btn", r === active && "active"], dataset: { value: r }, "aria-current": r === active ? "page" : null }, label))));
}

let renderSeq = 0;
async function route() {
  const { id, params } = parseHash();
  const tab = MODULES[id] || overview;
  const markRail = (key) => {
    for (const a of nav.querySelectorAll(".tab")) {
      const on = a.dataset.tab === key;
      a.classList.toggle("active", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    }
  };
  // Same screen, only the params changed, and the screen handles "params" itself: no re-render.
  if (current.id === tab.id && scope && scope.listeners.has("params") && scope.listeners.get("params").size) {
    ctx.params = params; current.params = params;
    emit("params", params);
    handleResumeParam(params);
    return;
  }
  const seq = ++renderSeq;
  if (current.id !== tab.id) resetTableStates();
  disposeScope();
  const sc = newScope();
  scope = sc;
  current = { id: tab.id, params };
  ctx.route = tab.id;
  ctx.params = params;
  view.removeAttribute("data-ready");
  clear(view);
  view.dataset.tab = tab.id;
  ctx.setTitle(LABEL[tab.id] || tab.title);
  markRail(RAIL_OF[tab.id] || tab.id);
  // Each render gets its own host inside the view. Navigating clears the view, which detaches the old host,
  // so a slow tab that is still awaiting can only append into its own detached host, never the next tab.
  const host = h("div", { class: "tab-host" });
  view.appendChild(host);
  if (SETUP_TABS.some(([r]) => r === tab.id)) host.appendChild(setupTabs(tab.id));
  if (tab.hint) host.appendChild(h("p", { class: "page-hint" }, tab.hint));
  try {
    await tab.render(host, screenCtx(sc));
  } catch (e) {
    console.error("[ScoreX UI] tab render failed", tab.id, e);
    host.appendChild(h("div", { class: "banner banner-danger" }, h("strong", null, "This tab failed to render. "), String((e && e.message) || e)));
  }
  if (seq === renderSeq) {
    view.dataset.ready = tab.id;
    handleResumeParam(params);
  }
}

// ---------------------------------------------------------------- init

async function init() {
  // Locked until a license key is active (lib/license.js): only the activation card is shown.
  const lic = await currentLicense();
  if (!unlocked(lic)) { showLockPage(lic); watchLicense(false); return; }
  watchLicense(true);
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
        refreshHealthSoon();
      } else if (WATCH.includes(key)) {
        ctx.data[key] = ch.newValue;
        emit(key, ch.newValue);
        if (key === K.state) { updateHeader(); refreshStatusSoon(); refreshHealthSoon(); }
        if (key === K.secretsRev) { emit("secrets"); refreshHealthSoon(); }
      } else if (key === K.secrets) emit("secrets");
      else if (key === K.selectorOverrides || key === K.providerOverrides) emit(key, ch.newValue);
    }
  });

  buildNav();
  initMenuSheet();
  buildHeader();
  window.addEventListener("hashchange", route);
  await route();
  refreshStatus();
  refreshCounts();
  refreshHealth();
  setInterval(() => {
    if (document.visibilityState !== "visible") return;
    refreshStatus();
    refreshCounts();
  }, 5000);
  setInterval(() => { if (document.visibilityState === "visible") refreshHealth(); }, 60000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { refreshStatus(); refreshCounts(); refreshHealthSoon(); } });
  // Relative times (next check, last check, the bar clock, the banner age) refresh twice a minute.
  setInterval(() => { updateClock(); updateHeader(); emit("tick"); }, 30000);
}

init().catch((e) => {
  console.error("[ScoreX UI] init failed", e);
  view.appendChild(h("div", { class: "banner banner-danger" }, "ScoreX could not start the dashboard: " + ((e && e.message) || e)));
});
