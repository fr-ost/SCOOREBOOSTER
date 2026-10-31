// ScoreX UI - tiny DOM helpers shared by the dashboard tabs and the popup ("Growth ledger" design).
// No framework: h() builds elements; small widgets (toast, modal, drawer, menu, tables, tags, figures) and the
// settings field binder that saves on change. Never put secrets into anything that is logged. Untrusted text
// (posts, replies, X prompts) always goes in as text nodes through h(), never as HTML.
//
// Overview of the helpers added for the redesign (all exported):
//   Layout      ledger(...cells)  figure({ label, value, of, delta, chart, sub, href, id, cls, title, key })
//   Marks       tag(text, kind)  statusSquare(kind, label)  diagSquare(kind)  delta(v, opts)  kbd(t)  keyLegend(items)
//               expiryChip(createdAt, maxAgeMin)  expiresAt(createdAt, maxAgeMin)  providerKey(id)
//               riskChip(risk)  accountChip(settings, state)  modeTag(mode)  followDay(t, settings)  dayMeter(t, settings)
//   Inputs      segFilter([[value, label, count, title]], value, onChange)  (segmented() with counts)
//   Overlays    drawer(opts)  sheet(opts)  menu(anchor, items, opts)  menuButton(opts)  columnsMenu(opts)  helpSheet(opts)
//               hasOverlay()  isTyping(event)  announce(text)  toast(msg, { type, action: { label, onClick } })
//   Tables      renderTable(opts) keeps scroll position, "Show more" limit and the focused row across live redraws
//               (opts.stateKey; on by default), row click / Enter (onRowOpen), row keyboard focus, chevron, column
//               visibility. stableTable(host, opts) also skips the redraw when opts.signature is unchanged.
//   Safety      isSafetyStop(state)  stopGuide(reason, settings)  reviewStopDialog(ctx)  confirmFullAuto(ctx)
//               switchMode(ctx, mode)  safetyBanner(opts)  healthCheck({ settings, state, secretsRev })

import { STATUS, STOP, STOP_LABEL, HS, MODE, HARD } from "../lib/constants.js";
import { fmtUsd, fmtCount, fmtDuration, truncate, num } from "../lib/util.js";
import { FS, FS_LABEL, followStatus, followDays, isActive } from "../lib/targets.js";
import { dailyLimit, accountsLimit } from "../lib/safety.js";
import { PROVIDER_DEFS } from "../lib/providerdefs.js";
import { getSecrets } from "../lib/store.js";
import { segMeter, vizIndex } from "./charts.js";

export { fmtUsd, fmtCount, fmtDuration, truncate };

// ---------------------------------------------------------------- DOM

const PROPS = new Set(["value", "checked", "disabled", "selected", "hidden", "htmlFor", "textContent", "indeterminate", "multiple", "readOnly", "required", "open", "tabIndex"]);

// h("div", { class: "card", onClick: fn, style: {...} }, "text", child, [more children])
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs != null && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  let value;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class" || k === "className") el.className = Array.isArray(v) ? v.filter(Boolean).join(" ") : String(v);
    else if (k === "style") { if (typeof v === "string") el.setAttribute("style", v); else Object.assign(el.style, v); }
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "html") el.innerHTML = v; // trusted static strings only (icons)
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "value") value = v;
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  if (value !== undefined) el.value = value;
  return el;
}
export function append(el, children) {
  for (const c of children) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); return el; }
// Null-safe variadic append (native Element.append would print "null"/"false" as text).
export function add(el, ...kids) { return append(el, kids); }
export function fill(el, ...kids) { return append(clear(el), kids); }
export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

export function debounce(fn, ms = 400) {
  let t = null;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...args); }, ms); };
  d.cancel = () => { clearTimeout(t); t = null; };
  d.pending = () => t != null;
  d.flush = (...args) => { if (t != null) { clearTimeout(t); t = null; fn(...args); } };
  return d;
}

export function uidShort(prefix = "") { return prefix + Math.random().toString(36).slice(2, 8); }

const FOCUSABLE = 'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';
const visibleFocusables = (root) => $$(FOCUSABLE, root).filter((x) => !x.disabled && x.offsetParent !== null);

// True while the user types in a field (keyboard shortcuts must ignore those keys).
export function isTyping(e) {
  const t = (e && e.target) || document.activeElement;
  if (!t || !t.tagName) return false;
  if (t.isContentEditable) return true;
  if (t.tagName === "TEXTAREA" || t.tagName === "SELECT") return true;
  if (t.tagName === "INPUT") return !["checkbox", "radio", "button", "submit", "range", "reset", "color", "file"].includes((t.type || "").toLowerCase());
  return false;
}

// ---------------------------------------------------------------- icons (static SVG strings)

const P = {
  overview: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
  targets: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
  review: '<path d="M4 5h16v11H8l-4 4z"/><path d="M8 9h8M8 12h5"/>',
  discover: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4M11 8v6M8 11h6"/>',
  scores: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  results: '<path d="M3 4h18l-7 8v6l-4 2v-8z"/>',
  models: '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9h6v6H9zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  tones: '<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 6l3 3"/>',
  safety: '<path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  pause: '<path d="M7 4h4v16H7zM13 4h4v16h-4z"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  logo: '<path d="M5 5l14 14M19 5L5 19"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  caret: '<path d="M6 9l6 6 6-6"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  reply: '<path d="M10 9V5l-7 7 7 7v-4c5 0 8 1.5 11 5-1-6-4-10-11-11z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="1"/><path d="M4 16V4h12"/>',
  health: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  columns: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M9 4v16M15 4v16"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="1"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  skip: '<path d="M5 5l9 7-9 7zM17 5v14"/>',
};
P.today = P.overview;
export function icon(name, cls = "") {
  const path = P[name] || P.info;
  return h("span", { class: ["icon", cls], "aria-hidden": "true", html: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>` });
}

// ---------------------------------------------------------------- time & number formatting

let TZ;
export function setTz(tz) { TZ = tz || undefined; }
export function getTz() { return TZ; }
function fmt(ts, opts) {
  if (!ts || !Number.isFinite(Number(ts))) return "-";
  try { return new Intl.DateTimeFormat(undefined, { timeZone: TZ, ...opts }).format(new Date(Number(ts))); }
  catch (_) { return new Date(Number(ts)).toLocaleString(); }
}
export const fmtTime = (ts) => fmt(ts, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export const fmtDate = (ts) => fmt(ts, { year: "numeric", month: "short", day: "numeric" });
export const fmtDay = (ts) => fmt(ts, { month: "short", day: "numeric" });
export const fmtDateTime = (ts) => fmt(ts, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export const fmtWeekday = (ts) => fmt(ts, { weekday: "short", month: "short", day: "numeric" });
export function fmtAgo(ts, nowTs = Date.now()) {
  if (!ts) return "-";
  const s = Math.round((nowTs - Number(ts)) / 1000);
  if (s < 0) return fmtIn(ts, nowTs);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hrs = Math.round(m / 60);
  if (hrs < 36) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
}
export function fmtIn(ts, nowTs = Date.now()) {
  if (!ts) return "-";
  const ms = Number(ts) - nowTs;
  if (ms <= 0) return "now";
  return "in " + fmtDuration(ms);
}
// "2d 4h" style countdown.
export function fmtCountdown(ms) {
  if (ms == null || !Number.isFinite(ms)) return "-";
  const totalMin = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(totalMin / 1440), hh = Math.floor((totalMin % 1440) / 60), mm = totalMin % 60;
  if (d) return `${d}d ${hh}h`;
  if (hh) return `${hh}h ${mm}m`;
  return `${mm}m`;
}
export const fmtPct = (v, digits = 0) => (Number.isFinite(Number(v)) ? `${Number(v).toFixed(digits)}%` : "-");
export const fmtNum = (v) => (v == null || !Number.isFinite(Number(v)) ? "-" : Number(v).toLocaleString());
export const fmtTokens = (v) => (v == null || !Number.isFinite(Number(v)) ? "-" : Number(v) >= 10000 ? fmtCount(Number(v)) : String(Math.round(Number(v))));

// ---------------------------------------------------------------- messaging

// chrome.runtime.sendMessage({ sx: name, ...payload }) -> response or null (error toasted unless quiet).
// With { raw: true } a failed response ({ ok:false, error, ... }) is returned instead of null.
export async function send(name, payload = {}, { quiet = false, label, raw = false } = {}) {
  let res;
  try {
    res = await chrome.runtime.sendMessage({ sx: name, ...(payload || {}) });
    if (!res) throw new Error("No answer from the background worker.");
    if (res.ok === false) throw new Error(res.error || "Unknown error.");
    return res;
  } catch (e) {
    const msg = String((e && e.message) || e).replace(/^Error:\s*/, "");
    if (!quiet) toast(`${label || name}: ${msg}`, { type: "error" });
    return raw ? { ...(res && typeof res === "object" ? res : {}), ok: false, error: msg } : null;
  }
}

// ---------------------------------------------------------------- toast + live announcements

// Inverted ink toast. opts: { type: info|success|warn|error, timeout, action: { label, onClick } } (e.g. Undo).
export function toast(message, opts = {}) {
  const { type = "info", timeout, action } = typeof opts === "string" ? { type: opts } : opts;
  let box = document.getElementById("toasts");
  if (!box) { box = h("div", { id: "toasts", class: "toasts", "aria-live": "polite" }); document.body.appendChild(box); }
  const el = h("div", { class: ["toast", "toast-" + type], role: type === "error" ? "alert" : "status" },
    icon(type === "error" ? "alert" : type === "success" ? "check" : type === "warn" ? "alert" : "info"),
    h("div", { class: "toast-msg" }, message),
    action ? h("button", { class: "toast-act", type: "button", onClick: () => { close(); try { action.onClick && action.onClick(); } catch (e) { console.error(e); } } }, action.label || "Undo") : null,
    h("button", { class: "toast-x", type: "button", "aria-label": "Dismiss", onClick: () => close() }, icon("x")));
  let closed = false;
  const close = () => { if (closed) return; closed = true; el.classList.add("out"); setTimeout(() => el.remove(), 180); };
  box.appendChild(el);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(close, timeout || (action ? 6000 : type === "error" ? 7000 : 3500));
  return close;
}

// Screen-reader announcement through a polite live region (#announce, created on demand).
export function announce(text) {
  let el = document.getElementById("announce");
  if (!el) { el = h("div", { id: "announce", class: "sr-only", "aria-live": "polite", "aria-atomic": "true" }); document.body.appendChild(el); }
  el.textContent = "";
  requestAnimationFrame(() => { el.textContent = String(text || ""); });
}

// ---------------------------------------------------------------- overlay stack (Esc closes the top layer only)

const layers = [];
const pushLayer = (l) => layers.push(l);
const popLayer = (l) => { const i = layers.indexOf(l); if (i >= 0) layers.splice(i, 1); };
const isTop = (l) => layers[layers.length - 1] === l;
// True while a modal, drawer, sheet or menu is open (page shortcuts should do nothing then).
export function hasOverlay() { return layers.length > 0; }
// For overlays built elsewhere (the rail's Menu sheet): { isTop(), release() }.
export function registerOverlay(kind = "custom") {
  const l = { kind };
  pushLayer(l);
  return { isTop: () => isTop(l), release: () => popLayer(l) };
}
function trapTab(e, root) {
  const f = visibleFocusables(root);
  if (!f.length) { e.preventDefault(); return; }
  const first = f[0], last = f[f.length - 1];
  if (!root.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
function restoreFocus(prev) {
  if (prev && prev.isConnected && prev.focus) { try { prev.focus({ preventScroll: true }); } catch (_) { /* gone */ } }
}

// ---------------------------------------------------------------- modal / confirm

// actions: [{ label, kind, value, id, iconName, disabled, onClick(button) -> false keeps it open }]
// initialFocus: element or selector inside the body (default: [autofocus], then the primary/danger button).
// Returns { el, close(value), buttons, footer }.
export function modal({ title, body, actions = [], wide = false, onClose, initialFocus, cls } = {}) {
  const prev = document.activeElement;
  const overlay = h("div", { class: "modal-overlay" });
  const titleId = uidShort("mt_");
  const footer = h("div", { class: "modal-footer" });
  const box = h("div", { class: ["modal", wide && "modal-wide", cls], role: "dialog", "aria-modal": "true", "aria-labelledby": titleId },
    h("div", { class: "modal-header" },
      h("h2", { id: titleId }, title || ""),
      h("button", { type: "button", class: "btn btn-ghost btn-icon btn-sm", "aria-label": "Close", onClick: () => close() }, icon("x"))),
    h("div", { class: "modal-body" }, body),
    footer);
  const layer = { kind: "modal" };
  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    popLayer(layer);
    overlay.remove();
    restoreFocus(prev);
    if (onClose) onClose(result);
  };
  const buttons = [];
  for (const a of actions) {
    const b = h("button", {
      type: "button", id: a.id || null, disabled: !!a.disabled,
      class: ["btn", a.kind ? "btn-" + a.kind : ""],
      onClick: async () => {
        if (b.disabled) return;
        let r;
        if (a.onClick) { b.disabled = true; b.classList.add("is-busy"); try { r = await a.onClick(b); } finally { b.disabled = false; b.classList.remove("is-busy"); } }
        if (r !== false) close(a.value);
      },
    }, a.iconName ? icon(a.iconName) : null, h("span", null, a.label));
    buttons.push(b);
    footer.appendChild(b);
  }
  if (!actions.length) { const b = h("button", { type: "button", class: "btn", onClick: () => close() }, "Close"); buttons.push(b); footer.appendChild(b); }
  const onKey = (e) => {
    if (!isTop(layer)) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "Tab") trapTab(e, box);
  };
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey, true);
  pushLayer(layer);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  const firstBtn = footer.querySelector(".btn-primary:not(:disabled), .btn-danger:not(:disabled)") || footer.querySelector("button:not(:disabled)");
  setTimeout(() => {
    const want = typeof initialFocus === "string" ? box.querySelector(initialFocus) : initialFocus;
    (want || box.querySelector("[autofocus]") || firstBtn || box).focus();
  }, 0);
  return { el: box, close, buttons, footer };
}

export function confirmDialog(message, { title = "Please confirm", okLabel = "OK", cancelLabel = "Cancel", danger = false } = {}) {
  return new Promise((resolve) => {
    modal({
      title,
      body: typeof message === "string" ? h("p", { class: "modal-text" }, message) : message,
      actions: [
        { label: cancelLabel, value: false },
        { label: okLabel, kind: danger ? "danger" : "primary", value: true },
      ],
      onClose: (v) => resolve(v === true),
    });
  });
}

// ---------------------------------------------------------------- tags, squares, deltas, keys

// Mono caps tag (2px radius, outline). kind: "" | solid (lime, AUTO only) | amber | red | green.
export function tag(text, kind = "", title) {
  return h("span", { class: ["tag", kind && "tag-" + kind], title: title || null }, text);
}
// 8px status square + word. kind: green (lime, followed back / pass) | green-o (lime outline) | ink | amber | red | grey.
export function statusSquare(kind, label, { title, cls } = {}) {
  return h("span", { class: ["hs", "hs-" + kind, cls], title: title || null }, label);
}
// 10px diagnostics square: pass | warn | fail | skip (hollow).
export function diagSquare(kind, label) {
  const k = ["pass", "warn", "fail", "skip"].includes(kind) ? kind : "skip";
  return h("span", { class: ["st", "st-" + k], role: "img", "aria-label": label || k, title: label || null });
}
// 8px provider key square in the provider's --viz colour.
export function providerKey(id) { return h("span", { class: ["key", "k" + vizIndex(id)], "aria-hidden": "true" }); }
export const providerName = (id) => (PROVIDER_DEFS[id] && PROVIDER_DEFS[id].name) || String(id || "");
// Enabled score providers (settings.providers.<id>.enabled) in definition order.
export function enabledProviders(settings) {
  const p = (settings && settings.providers) || {};
  const ids = [...Object.keys(PROVIDER_DEFS), ...Object.keys(p).filter((id) => !PROVIDER_DEFS[id])];
  return ids.filter((id) => p[id] && p[id].enabled);
}
// The provider shown as "your score" (Today, popup, review cards): the user's pick (localStorage "sx.primaryScore") when
// enabled, else the first enabled provider that has a score, else the first enabled one. Returns an id or null.
export function primaryProvider(settings, board) {
  const en = enabledProviders(settings);
  let pref = null;
  try { pref = window.localStorage.getItem("sx.primaryScore"); } catch (_) { /* storage blocked */ }
  if (pref && en.includes(pref)) return pref;
  const own = (board && board.own) || {};
  return en.find((id) => own[id] && own[id].score != null) || en[0] || null;
}
export function setPrimaryProvider(id) { try { window.localStorage.setItem("sx.primaryScore", String(id || "")); } catch (_) { /* storage blocked */ } }
// Change in a daily score history [{ d: "YYYY-MM-DD", s }] over `days`: latest minus the last value on or before
// (latest day - days). null when there is not enough history.
export function historyDelta(hist, days) {
  const list = (Array.isArray(hist) ? hist : []).filter((x) => x && x.d && Number.isFinite(Number(x.s))).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  if (list.length < 2) return null;
  const last = list[list.length - 1];
  const cut = new Date(Date.parse(last.d + "T00:00:00Z") - days * 864e5).toISOString().slice(0, 10);
  let base = null;
  for (const x of list) { if (x.d <= cut) base = x; else break; }
  return base ? Number(last.s) - Number(base.s) : null;
}

// Change with glyph + colour (never colour alone). invert: lower is better (costs). Returns "▲ +4 vs prev" etc.
export function delta(v, { unit = "", suffix = "", digits = 0, invert = false, title } = {}) {
  if (v == null || !Number.isFinite(Number(v))) return h("span", { class: "delta flat", title: title || null }, "■ -");
  const n = Number(v);
  const r = Math.round(n * 10 ** digits) / 10 ** digits;
  const good = invert ? r < 0 : r > 0, bad = invert ? r > 0 : r < 0;
  const glyph = r > 0 ? "▲ +" : r < 0 ? "▼ " : "■ ";
  return h("span", { class: ["delta", good ? "up" : bad ? "down" : "flat"], title: title || null }, glyph + r.toFixed(digits) + unit + (suffix ? " " + suffix : ""));
}

export function kbd(text) { return h("kbd", null, text); }
// Key-cap legend: items [[["J", "K"], "next / previous"], ["A", "approve"], ...].
export function keyLegend(items, { label = "Keyboard shortcuts", cls } = {}) {
  return h("div", { class: ["keys", cls], role: "note", "aria-label": label },
    (items || []).map(([keys, text]) => h("span", null, (Array.isArray(keys) ? keys : [keys]).map((k) => kbd(k)), text)));
}

export const expiresAt = (createdAt, maxAgeMin) => Number(createdAt) + Number(maxAgeMin) * 60000;
// "expires 12m" outline chip (amber wash under 15 min) for pending review items.
export function expiryChip(createdAt, maxAgeMin, { now = Date.now(), soonMin = 15, short = false } = {}) {
  if (!createdAt || !maxAgeMin) return null;
  const at = expiresAt(createdAt, maxAgeMin), left = at - now;
  const soon = left < soonMin * 60000;
  return h("span", { class: ["expiry", soon && "soon", left <= 0 && "is-expired"], title: `Skipped automatically at ${fmtTime(at)} (pending replies expire after ${maxAgeMin} min)` },
    left <= 0 ? "expired" : (short ? "" : "expires ") + fmtCountdown(left));
}

// ---------------------------------------------------------------- badges (targets, history)

export const TIER_INFO = {
  1: { label: "Tier 1", short: "T1", desc: "Big influencer" },
  2: { label: "Tier 2", short: "T2", desc: "Smart account" },
};
// Day of the give-up window for a target ScoreX comments on (counting from 1): { day, of, left, near } or null.
export function followDay(t, settings) {
  if (!t || followStatus(t) !== FS.ACTIVE) return null;
  const days = followDays(t);
  if (days == null) return null;
  const f = (settings && settings.follow) || {};
  const of = Math.max(1, Number(f.giveUpDays) || 14);
  return { day: Math.min(days + 1, of), of, left: of - days, near: f.autoRemove !== false && of - days <= 2 };
}
// "day N/14" segment meter (amber close to the give-up day).
export function dayMeter(t, settings) {
  const d = followDay(t, settings);
  return d ? segMeter(d.day, d.of, { warnFrom: d.near ? 1 : null, label: `Day ${d.day} of ${d.of}` }) : null;
}
// Follow status of a target (lib/targets.js followStatus): a small coloured square + the word. Not following shows
// "day N/14" once ScoreX has commented (the give-up countdown, counting from day 1).
export const FS_COLOR = { [FS.CHECKING]: "grey", [FS.ACTIVE]: "ink", [FS.FOLLOWS]: "green-o", [FS.FOLLOWED_BACK]: "green" };
export function followBadge(t, settings, { compact = false } = {}) {
  if (!t) return h("span", { class: "muted" }, "-");
  const rel = t.rel || {};
  if (rel.gone) return h("span", { class: ["hs", "hs-red", "fs"], title: "Profile not found on X (renamed, suspended or deleted). The target was turned off.", dataset: { fs: "gone" } }, "Not found");
  const st = followStatus(t);
  const f = (settings && settings.follow) || {};
  const giveUp = f.giveUpDays || 14;
  const kids = [FS_LABEL[st] || st];
  let title = "";
  if (st === FS.CHECKING) title = "Checked before any comment: ScoreX looks for the \"Follows you\" badge first.";
  else if (st === FS.FOLLOWS) title = "Already follows you - never commented on.";
  else if (st === FS.FOLLOWED_BACK) {
    title = `Followed you back${rel.followedBackAt ? " on " + fmtDate(rel.followedBackAt) : ""}. Comments stopped.`;
    if (rel.followedBackAt && !compact) kids.push(h("span", { class: "fs-extra" }, fmtDay(rel.followedBackAt)));
  } else if (st === FS.ACTIVE) {
    const d = followDay(t, settings);
    title = "Does not follow you - ScoreX comments on this account." + (f.autoRemove === false
      ? " Automatic removal is off."
      : ` Removed after ${giveUp} days of comments without a follow-back${f.blacklist === false ? "" : " (and blacklisted)"}.`);
    if (d) kids.push(h("span", { class: ["fs-extra", "fs-days", d.near && "is-near"] }, `day ${d.day}/${d.of}`));
  }
  return h("span", { class: ["hs", "hs-" + FS_COLOR[st], "fs"], title, dataset: { fs: st } }, kids);
}
export function tierBadge(t) {
  const k = Number(t) === 1 ? 1 : Number(t) === 2 ? 2 : null;
  if (!k) return h("span", { class: "badge" }, "-");
  return h("span", { class: ["badge", "badge-tier-" + k], title: `${TIER_INFO[k].label}: ${TIER_INFO[k].desc}` }, TIER_INFO[k].short);
}
const HS_INFO = {
  [HS.PENDING_REVIEW]: ["Pending review", "amber"],
  [HS.APPROVED]: ["Approved", "blue"],
  [HS.QUEUED]: ["Queued", "blue"],
  [HS.POSTING]: ["Posting", "blue"],
  [HS.POSTED]: ["Posted", "green"],
  [HS.SKIPPED]: ["Skipped", "grey"],
  [HS.FAILED]: ["Failed", "red"],
};
// History status: a small coloured square followed by the word (no pills).
export function statusBadge(status, reason) {
  const [label, color] = HS_INFO[status] || [status || "-", "grey"];
  return h("span", { class: ["hs", "hs-" + color], title: reason || label }, label);
}
export function badge(text, color = "grey", title) { return h("span", { class: ["badge", "badge-" + color], title: title || null }, text); }

// ---------------------------------------------------------------- engine status

// Short reasons for the engine bar ("Stopped · captcha shown"); the full label is STOP_LABEL.
export const STOP_SHORT = Object.freeze({
  captcha: "captcha shown", unusual_activity: "X warning", rate_limit: "rate limited", account_locked: "account locked",
  logged_out: "logged out", wrong_account: "other account", repeated_post_failures: "posting failures", dom_changed: "X page changed",
  budget_reached: "budget reached", openai_auth: "API key rejected", openai_quota: "OpenAI quota", no_api_key: "no API key",
  tab_unavailable: "no X tab", unknown_prompt: "unknown X prompt", account_unknown: "account unknown", reach_drop: "reach dropped",
  internal_error: "internal error",
});

// A stop that needs the deliberate "Review stop…" flow (never a one-click resume): an alert, or any stop not
// made by the user while the engine is not running.
export function isSafetyStop(state) {
  if (!state || state.status === STATUS.RUNNING) return false;
  if (state.alert) return true;
  return state.status === STATUS.STOPPED && !!state.stopReason && state.stopReason !== STOP.USER;
}
// Why the engine drops an approved or queued reply instead of posting it, or "" when it can post. Same rule as its
// posting loop (lib/engine.js tickBody): every item whose target is not active (lib/targets.js isActive) is skipped.
export function dropReasonOf(rec, targets, settings) {
  const who = "@" + ((rec && rec.target) || "?");
  const t = rec && targets && Object.hasOwn(targets, rec.target) ? targets[rec.target] : null;
  if (!t) return `${who} is no longer one of your targets`;
  if (isActive(t, settings)) return "";
  if (!t.enabled) return t.rel && t.rel.gone ? `X says ${who} no longer exists, so the target was turned off` : `${who} is turned off in Targets`;
  return followStatus(t) === FS.CHECKING ? `ScoreX does not know yet whether ${who} follows you` : `${who} follows you now`;
}
// Today and popup line for approved replies: the ones the engine drops are not promised a slot, and while the engine
// is not running the slot waits for Start / resume.
export function approvedSummary(list, targets, settings, state) {
  const dropped = list.filter((r) => dropReasonOf(r, targets, settings)).length, queued = list.length - dropped, st = state || {};
  const when = st.status === STATUS.RUNNING ? "waiting for their posting slot" : `posting after you ${st.status === STATUS.PAUSED || isSafetyStop(st) ? "resume" : "press Start"}`;
  return [queued ? `${queued} approved, ${when}.` : "", dropped ? `${dropped} approved will not post (the account follows you now, was turned off or removed, or its follow status is unknown).` : ""].filter(Boolean).join(" ");
}
// Engine status -> display info. Safety stops are red.
export function statusInfo(state) {
  const st = (state && state.status) || STATUS.STOPPED;
  if (st === STATUS.RUNNING) return { kind: "running", label: "Running", reason: "", short: "" };
  const r = (state && state.alert && state.alert.reason) || (state && state.stopReason);
  if (st === STATUS.PAUSED) {
    if (state && state.alert) return { kind: "danger", label: "Paused", reason: STOP_LABEL[r] || String(r || ""), short: STOP_SHORT[r] || "safety stop", detail: state.alert.detail || state.stopDetail || "" };
    return { kind: "paused", label: "Paused", reason: (state && state.stopDetail) || "", short: "nothing posts" };
  }
  const reason = r ? STOP_LABEL[r] || String(r) : "";
  const safety = isSafetyStop(state);
  return { kind: safety ? "danger" : "stopped", label: "Stopped", reason: safety ? reason : "", short: safety ? STOP_SHORT[r] || reason : "", detail: (state && state.stopDetail) || "" };
}
// The one primary engine action for the current state: [label, message, icon]. During a safety stop the
// message is "reviewStop": open reviewStopDialog() (dashboard) or the dashboard with ?resume=1 (popup).
export function primaryAction(state) {
  const st = (state && state.status) || STATUS.STOPPED;
  if (st === STATUS.RUNNING) return ["Pause", "pause", "pause"];
  if (isSafetyStop(state)) return ["Review stop…", "reviewStop", "alert"];
  if (st === STATUS.PAUSED) return ["Resume", "resume", "play"];
  return ["Start", "start", "play"];
}
// Status dot + label + short reason ("Running · next comment 12:45", "Stopped · captcha shown").
export function statusPill(state, { large = false, why = null } = {}) {
  const i = statusInfo(state);
  const reason = why != null ? why : i.kind === "running" ? "" : i.short || i.reason;
  return h("span", { class: ["status", "status-" + i.kind, large && "status-lg"], title: [i.label, i.reason, i.detail].filter(Boolean).join(" - ") },
    h("span", { class: "dot", "aria-hidden": "true" }),
    h("span", { class: "status-label lbl" }, i.label),
    reason ? h("span", { class: "status-reason why" }, reason) : null);
}

// Thin flat bar. kind: amber | red | grey (anything else = accent).
export function progressBar(pct, { kind } = {}) {
  const p = Math.max(0, Math.min(100, num(pct)));
  const k = ["amber", "red", "grey"].includes(kind) ? kind : !kind && p >= 100 ? "red" : !kind && p >= 80 ? "amber" : "accent";
  return h("div", { class: ["progress", "progress-" + k], role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(p)) },
    h("div", { class: "progress-bar", style: { width: p + "%" } }));
}

// Segmented quota bar: one segment per unit up to 60, a continuous bar above that.
export function quotaBar(value, limit, { label } = {}) {
  const v = Math.max(0, num(value));
  const lim = Math.max(0, Math.round(num(limit)));
  const attrs = { role: "meter", "aria-valuemin": "0", "aria-valuemax": String(lim), "aria-valuenow": String(Math.min(v, lim || v)), "aria-label": label || "Quota" };
  if (lim > 0 && lim <= 60) {
    const segs = [];
    for (let i = 0; i < lim; i++) segs.push(h("span", { class: ["quota-seg", i < v && "on"] }));
    return h("div", { class: ["quota", v >= lim && "is-full"], ...attrs }, segs);
  }
  const pct = lim ? Math.min(100, (v / lim) * 100) : 0;
  return h("div", { class: ["quota", "quota-cont", lim && v >= lim && "is-full"], ...attrs },
    h("span", { class: "quota-seg" }), h("span", { class: "quota-fill", style: { width: pct + "%" } }));
}

export function emptyState(title, text, action) {
  return h("div", { class: "empty" }, h("div", { class: "empty-title" }, title), text ? h("p", null, text) : null, action || null);
}

// ---------------------------------------------------------------- sections, panels, figures

// Flat section separated by a hairline. Default layout: title + hint column on the left, content on the right
// (the "spec sheet" of the setup screens). wide: header above the content (tables, lists, charts).
export function section({ title, hint, actions, id, className, wide = false } = {}, ...children) {
  return h("section", { class: ["sec", wide && "sec-wide", className], id: id || null },
    title || hint || actions ? h("header", { class: "sec-head" },
      h("div", { class: "sec-titles" }, title ? h("h2", { class: "sec-title" }, title) : null, hint ? h("p", { class: "sec-hint" }, hint) : null),
      actions ? h("div", { class: "sec-actions" }, actions) : null) : null,
    h("div", { class: "sec-body" }, children));
}
// Backwards-compatible alias: a wide section.
export function card({ title, subtitle, actions, className, id } = {}, ...children) {
  return section({ title, hint: subtitle, actions, className, id, wide: true }, ...children);
}
// Small labelled group inside a section.
export function sub(title, ...children) {
  return h("div", { class: "sub" }, title ? h("h3", { class: "sub-title" }, title) : null, children);
}

// Collapsed <details> group. Open/closed state is remembered per key in localStorage ("sx.adv.<key>").
function readAdv(key) { try { return window.localStorage.getItem("sx.adv." + key); } catch (_) { return null; } }
function writeAdv(key, open) { try { window.localStorage.setItem("sx.adv." + key, open ? "1" : "0"); } catch (_) { /* storage blocked */ } }
export function advanced({ key, title = "Advanced", desc, tag: tagText, id, open = false } = {}, ...children) {
  const stored = key ? readAdv(key) : null;
  const descEl = h("span", { class: "adv-desc" }, desc || "");
  const tagEl = h("span", { class: "adv-tag", hidden: !tagText }, tagText || "");
  const d = h("details", { class: "adv", id: id || null, dataset: key ? { adv: key } : undefined, open: stored == null ? !!open : stored === "1" },
    h("summary", null, icon("chevron", "adv-caret"), h("span", { class: "adv-title" }, title), tagEl, descEl),
    h("div", { class: "adv-body" }, children));
  // Persist on the click itself (the toggle event fires a task later) and on any other toggle.
  d.firstChild.addEventListener("click", () => { if (key) writeAdv(key, !d.open); });
  d.addEventListener("toggle", () => { if (key) writeAdv(key, d.open); });
  d.setDesc = (text) => { descEl.textContent = text || ""; };
  d.setTag = (text) => { tagEl.textContent = text || ""; tagEl.hidden = !text; };
  return d;
}

// Ledger panel: cells separated by hairlines that wrap cleanly.
export function panel(cls, ...cells) {
  return h("div", { class: ["panel", cls] }, h("div", { class: "panel-in" }, cells));
}
export function ledger(...cells) { return panel(null, ...cells); }
// One compact figure: label, mono value (with optional " / of"), sub line.
export function fig({ label, value, of, sub: subText, href, id, cls, title } = {}) {
  const kids = [
    h("span", { class: "fig-label" }, label),
    h("span", { class: "fig-value", id: id || null }, value, of != null ? h("span", { class: "fig-of" }, ` / ${of}`) : null),
    subText ? h("span", { class: "fig-sub" }, subText) : null,
  ];
  return href
    ? h("a", { class: ["cell", "fig", cls], href, title: title || null }, kids)
    : h("div", { class: ["cell", "fig", cls], title: title || null }, kids);
}
// Ledger figure tile: caps label (optional provider key square), 26px mono value, a sparkline slot on the right,
// and a delta + sub line. chart: any node (e.g. spark(...) or responsive(...)); delta: delta(...) node.
export function figure({ label, value, of, delta: deltaNode, chart, sub: subText, href, id, cls, title, key } = {}) {
  const kids = [
    h("span", { class: "cap fig-label" }, key ? providerKey(key) : null, label),
    h("div", { class: "fig-row" },
      h("span", { class: "fig-value", id: id || null }, value == null || value === "" ? "-" : value, of != null ? h("span", { class: "fig-of" }, ` / ${of}`) : null),
      chart ? h("span", { class: "fig-chart" }, chart) : null),
    deltaNode || subText ? h("div", { class: "fig-sub" }, deltaNode || null, subText ? h("span", null, subText) : null) : null,
  ];
  return href
    ? h("a", { class: ["cell", "fig", "figure", cls], href, title: title || null }, kids)
    : h("div", { class: ["cell", "fig", "figure", cls], title: title || null }, kids);
}

export function btn(label, onClick, { kind = "", size = "", iconName, title, disabled, type = "button", id, cls } = {}) {
  return h("button", { type, id: id || null, class: ["btn", kind && "btn-" + kind, size && "btn-" + size, !label && iconName && "btn-icon", cls], title: title || null, "aria-label": !label && title ? title : null, disabled: !!disabled, onClick },
    iconName ? icon(iconName) : null, label ? h("span", null, label) : null);
}

// Runs an async action with the button disabled + spinner.
export async function busy(button, fn) {
  if (button) { button.disabled = true; button.classList.add("is-busy"); }
  try { return await fn(); } finally { if (button) { button.disabled = false; button.classList.remove("is-busy"); } }
}

export function link(href, text, { external = true, cls } = {}) {
  return h("a", { href, class: cls || null, target: external ? "_blank" : null, rel: external ? "noopener noreferrer" : null }, text);
}
export function xLink(handle) {
  if (!handle) return "-";
  return link(`https://x.com/${encodeURIComponent(handle)}`, "@" + handle, { cls: "handle-link" });
}

// ---------------------------------------------------------------- table

// Per-table UI state that survives live redraws: { scrollTop, scrollLeft, anchorKey, anchorOffset, limit,
// hasFocus, focus: { key, idx, head, col } }. Keyed by opts.stateKey (default: caption + column keys).
// The dashboard clears it when you navigate to another screen.
const TABLE_STATE = new Map();
export function resetTableStates() { TABLE_STATE.clear(); }
export function tableState(key) { if (!TABLE_STATE.has(key)) TABLE_STATE.set(key, {}); return TABLE_STATE.get(key); }
const INTERACTIVE = "a, button, input, select, textarea, label, summary, [role=switch], [role=button], [contenteditable]";
const keySet = (v) => (v == null ? null : v instanceof Set ? v : new Set(Array.isArray(v) ? v : [v]));

// renderTable({ columns, rows, rowKey, selection: Set, onSelectionChange, empty, sortState, maxRows, rowClass, caption,
//   stateKey, onRowOpen(row, event), activeKey, chevron, visibleColumns, hiddenColumns, tall, footer })
// column: { key, label, render(row) -> node|string, sort(row) -> value | false, className, title, align, defaultDir, locked }
// stateKey: string (or false to disable). Keeps scroll (anchored to the top visible row), the "Show more" limit and the
//   focused row/control when the same table is drawn again (e.g. clear(host).appendChild(renderTable(...)) on every
//   storage change). onRowOpen: click on a row (not on a control in it) or Enter on a focused row; ↑/↓ move between rows.
export function renderTable(opts) {
  const { columns: allColumns, rows = [], rowKey = (r) => r.id, selection = null, onSelectionChange, empty = "Nothing here yet.", sortState = {}, maxRows = 0, rowClass, className, caption,
    onRowOpen, onRowClick, activeKey = null, chevron = false, tall = false, footer = null, rowLabel } = opts;
  const vis = keySet(opts.visibleColumns), hid = keySet(opts.hiddenColumns);
  const columns = allColumns.filter((c) => { const k = c.key || c.label; return c.locked || ((!vis || vis.has(k)) && (!hid || !hid.has(k))); });
  const open = onRowOpen || onRowClick || null;
  const stKey = opts.stateKey === false ? null : opts.stateKey || `${caption || ""}|${allColumns.map((c) => c.key || c.label).join(",")}`;
  const st = stKey ? tableState(stKey) : {};
  const wrap = h("div", { class: ["table-wrap", className, tall && "table-tall", open && "table-clickable"] });
  let limit = Math.max(st.limit || 0, maxRows || 0) || Infinity;
  let visible = [];

  const sortedRows = () => {
    const col = allColumns.find((c) => (c.key || c.label) === sortState.key);
    if (!col || col.sort === false) return rows.slice();
    const get = typeof col.sort === "function" ? col.sort : (r) => r[col.key];
    const dir = sortState.dir === "asc" ? 1 : -1;
    return rows.slice().sort((a, b) => {
      let x = get(a), y = get(b);
      if (x == null || x === "") x = dir > 0 ? Infinity : -Infinity;
      if (y == null || y === "") y = dir > 0 ? Infinity : -Infinity;
      if (typeof x === "string" && typeof y === "string") return x.localeCompare(y) * dir;
      return (x > y ? 1 : x < y ? -1 : 0) * dir;
    });
  };
  const rowEls = () => (wrap.querySelector("tbody") ? [...wrap.querySelector("tbody").rows] : []);
  const rowByKey = (k) => rowEls().find((tr) => tr.dataset.key === String(k)) || null;
  const relTop = (el) => el.getBoundingClientRect().top - wrap.getBoundingClientRect().top + wrap.scrollTop;

  // Remember the first row visible under the sticky header (binary search; rows are in document order).
  let rafRec = 0;
  const recordScroll = () => {
    rafRec = 0;
    st.scrollTop = wrap.scrollTop; st.scrollLeft = wrap.scrollLeft;
    const trs = rowEls();
    if (!trs.length || wrap.scrollTop <= 0) { st.anchorKey = null; st.anchorOffset = 0; return; }
    const head = wrap.querySelector("thead");
    const topEdge = wrap.scrollTop + (head ? head.offsetHeight : 0);
    let lo = 0, hi = trs.length - 1, idx = trs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, tr = trs[mid];
      if (relTop(tr) + tr.offsetHeight > topEdge) { idx = mid; hi = mid - 1; } else lo = mid + 1;
    }
    st.anchorKey = trs[idx].dataset.key;
    st.anchorOffset = relTop(trs[idx]) - wrap.scrollTop;
  };
  wrap.addEventListener("scroll", () => { if (!rafRec) rafRec = requestAnimationFrame(recordScroll); }, { passive: true });

  const focusInfo = (el) => {
    const tr = el && el.closest && el.closest("tr");
    if (!tr || !wrap.contains(tr)) return null;
    if (tr.parentElement && tr.parentElement.tagName === "THEAD") { const th = el.closest("th"); return { head: true, col: th ? th.dataset.col : null }; }
    if (el === tr) return { key: tr.dataset.key, idx: -1 };
    return { key: tr.dataset.key, idx: $$(FOCUSABLE, tr).indexOf(el) };
  };
  wrap.addEventListener("focusin", (e) => {
    const fi = focusInfo(e.target); st.hasFocus = true; if (fi) st.focus = fi;
    if (!rafRec) rafRec = requestAnimationFrame(recordScroll); // focusing can scroll the table
  });
  wrap.addEventListener("focusout", (e) => {
    const rt = e.relatedTarget;
    if (rt && !wrap.contains(rt)) st.hasFocus = false;
    else if (!rt) setTimeout(() => { if (wrap.isConnected && !wrap.contains(document.activeElement)) st.hasFocus = false; }, 0);
  });

  const focusRow = (tr, { scroll = true } = {}) => {
    if (!tr) return;
    for (const r of rowEls()) if (r !== tr && r.tabIndex === 0) r.tabIndex = -1;
    tr.tabIndex = 0;
    tr.focus({ preventScroll: !scroll });
    if (scroll) tr.scrollIntoView({ block: "nearest" });
  };
  if (open) {
    wrap.addEventListener("click", (e) => {
      const tr = e.target.closest("tbody tr");
      if (!tr || !wrap.contains(tr) || tr.classList.contains("table-empty-row")) return;
      if (e.target.closest(INTERACTIVE) && e.target.closest(INTERACTIVE) !== tr) return;
      const checkCell = e.target.closest("td.col-check");
      if (checkCell) { const cb = checkCell.querySelector("input"); if (cb && e.target !== cb) cb.click(); return; } // near-miss on the checkbox
      const row = visible.find((r) => String(rowKey(r)) === tr.dataset.key);
      if (row) open(row, e);
    });
    wrap.addEventListener("keydown", (e) => {
      const tr = e.target.closest && e.target.closest("tbody tr");
      if (!tr || e.target !== tr || e.altKey || e.ctrlKey || e.metaKey) return;
      const trs = rowEls(), i = trs.indexOf(tr);
      if (e.key === "ArrowDown" && i < trs.length - 1) { e.preventDefault(); focusRow(trs[i + 1]); }
      else if (e.key === "ArrowUp" && i > 0) { e.preventDefault(); focusRow(trs[i - 1]); }
      else if (e.key === "Home") { e.preventDefault(); focusRow(trs[0]); }
      else if (e.key === "End") { e.preventDefault(); focusRow(trs[trs.length - 1]); }
      else if (e.key === "Enter") { e.preventDefault(); const row = visible.find((r) => String(rowKey(r)) === tr.dataset.key); if (row) open(row, e); }
      else if (e.key === " " && selection) { e.preventDefault(); const cb = tr.querySelector("td.col-check input"); if (cb) cb.click(); }
    });
  }

  const draw = () => {
    const keepTop = wrap.scrollTop, keepLeft = wrap.scrollLeft;
    clear(wrap);
    visible = [];
    if (!rows.length) { wrap.appendChild(h("div", { class: "table-empty" }, empty)); if (footer) wrap.appendChild(h("div", { class: "table-foot" }, footer)); return; }
    const list = sortedRows();
    visible = list.slice(0, limit);
    const headCells = [];
    if (selection) {
      const all = h("input", { type: "checkbox", "aria-label": "Select all rows" });
      const sel = visible.filter((r) => selection.has(rowKey(r))).length;
      all.checked = sel > 0 && sel === visible.length;
      all.indeterminate = sel > 0 && sel < visible.length;
      all.addEventListener("change", () => {
        for (const r of visible) { if (all.checked) selection.add(rowKey(r)); else selection.delete(rowKey(r)); }
        draw();
        if (onSelectionChange) onSelectionChange(selection);
      });
      headCells.push(h("th", { class: "col-check", dataset: { col: "_check" } }, all));
    }
    for (const c of columns) {
      const key = c.key || c.label;
      const sortable = c.sort !== false && (c.sort || c.key);
      const active = sortState.key === key;
      const th = h("th", { class: [c.className, c.align && "align-" + c.align, sortable && "sortable", active && "sorted"], title: c.title || null, scope: "col", dataset: { col: String(key) }, "aria-sort": active ? (sortState.dir === "asc" ? "ascending" : "descending") : null },
        sortable ? h("button", { type: "button", class: "th-btn", onClick: () => {
          if (sortState.key === key) sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
          else { sortState.key = key; sortState.dir = c.defaultDir || "desc"; }
          draw();
          wrap.scrollTop = 0;
        } }, c.label, active ? h("span", { class: "sort-ind", "aria-hidden": "true" }, sortState.dir === "asc" ? "▲" : "▼") : null) : c.label);
      headCells.push(th);
    }
    if (chevron) headCells.push(h("th", { class: "col-chev", "aria-hidden": "true" }));
    const tbody = h("tbody");
    let first = true;
    for (const r of visible) {
      const k = rowKey(r);
      const isActive = activeKey != null && String(activeKey) === String(k);
      const tr = h("tr", { class: [rowClass && rowClass(r), selection && selection.has(k) && "is-selected", isActive && "is-open"], dataset: { key: String(k) },
        tabindex: open ? (first ? "0" : "-1") : null, "aria-current": isActive ? "true" : null, "aria-label": open && rowLabel ? rowLabel(r) : null });
      first = false;
      if (selection) {
        const cb = h("input", { type: "checkbox", "aria-label": "Select row " + k, checked: selection.has(k) });
        cb.addEventListener("change", () => {
          if (cb.checked) selection.add(k); else selection.delete(k);
          tr.classList.toggle("is-selected", cb.checked);
          const head = wrap.querySelector("thead input[type=checkbox]");
          if (head) {
            const n = visible.filter((x) => selection.has(rowKey(x))).length;
            head.checked = n > 0 && n === visible.length;
            head.indeterminate = n > 0 && n < visible.length;
          }
          if (onSelectionChange) onSelectionChange(selection);
        });
        tr.appendChild(h("td", { class: "col-check" }, cb));
      }
      for (const c of columns) {
        let v;
        try { v = c.render ? c.render(r) : r[c.key]; } catch (_) { v = "-"; }
        tr.appendChild(h("td", { class: [c.className, c.align && "align-" + c.align], dataset: { col: String(c.key || c.label) } }, v == null || v === "" ? "-" : v));
      }
      if (chevron) tr.appendChild(h("td", { class: "col-chev", "aria-hidden": "true" }, "›"));
      tbody.appendChild(tr);
    }
    const table = h("table", { class: "table" }, caption ? h("caption", { class: "sr-only" }, caption) : null, h("thead", null, h("tr", null, headCells)), tbody);
    wrap.appendChild(table);
    if (list.length > visible.length) {
      wrap.appendChild(h("div", { class: "table-more" },
        h("span", { class: "muted" }, `Showing ${visible.length} of ${list.length}`),
        btn("Show more", () => { limit += maxRows || 100; st.limit = limit; draw(); }, { size: "sm" })));
    }
    if (footer) wrap.appendChild(h("div", { class: "table-foot" }, footer));
    if (wrap.isConnected) { wrap.scrollTop = keepTop; wrap.scrollLeft = keepLeft; }
  };

  // Restore scroll and focus once the new wrap is in the page (callers append it right after this returns).
  const restore = () => {
    if (!wrap.isConnected) return;
    if (st.anchorKey != null) {
      const tr = rowByKey(st.anchorKey);
      wrap.scrollTop = tr ? Math.max(0, relTop(tr) - (st.anchorOffset || 0)) : 0;
    } else if (st.scrollTop) wrap.scrollTop = st.scrollTop;
    if (st.scrollLeft) wrap.scrollLeft = st.scrollLeft;
    const ae = document.activeElement;
    if (st.hasFocus && st.focus && (!ae || ae === document.body || !ae.isConnected)) {
      let el = null;
      if (st.focus.head) el = st.focus.col ? wrap.querySelector(`thead th[data-col="${CSS.escape(st.focus.col)}"] button, thead th[data-col="${CSS.escape(st.focus.col)}"] input`) : null;
      else {
        const tr = rowByKey(st.focus.key);
        if (tr) el = st.focus.idx >= 0 ? $$(FOCUSABLE, tr)[st.focus.idx] || tr : tr;
      }
      if (el) { if (el.tagName === "TR") { for (const r of rowEls()) r.tabIndex = -1; el.tabIndex = 0; } el.focus({ preventScroll: true }); }
    }
  };
  draw();
  queueMicrotask(() => { if (wrap.isConnected) restore(); else requestAnimationFrame(restore); });
  wrap.redraw = draw;
  wrap.recordScroll = () => { if (rafRec) cancelAnimationFrame(rafRec); if (wrap.isConnected) recordScroll(); else rafRec = 0; };
  wrap.state = st;
  wrap.focusRow = (k) => focusRow(rowByKey(k));
  wrap.rowEl = rowByKey;
  wrap.visibleRows = () => visible.slice();
  return wrap;
}

// Keeps one table in host across live redraws: skips the redraw when opts.signature (e.g. ids + updatedAt) did
// not change, otherwise redraws keeping scroll, "Show more" and the focused row. Returns the table wrap.
export function stableTable(host, opts) {
  const sig = opts.signature;
  if (sig != null && host.__sxSig === sig && host.__sxTable && host.contains(host.__sxTable)) return host.__sxTable;
  if (host.__sxTable && host.__sxTable.recordScroll) host.__sxTable.recordScroll(); // exact anchor before the swap
  const wrap = renderTable({ ...opts, stateKey: opts.stateKey || host.id || undefined });
  host.replaceChildren(wrap);
  host.__sxSig = sig;
  host.__sxTable = wrap;
  return wrap;
}

// ---------------------------------------------------------------- drawer / sheet

let openDrawer = null;
// Right-side drawer (460px, 1px left rule, overlay, no shadow; full screen at 720px and below). Esc closes, Tab is
// trapped, focus returns to where it was. Opening a new drawer replaces the open one.
// opts: { title (text|node), head (node under the title row), body, footer, actions: [{ label, kind, onClick, iconName, id }],
//         onClose(reason), label, id, cls, initialFocus, onKey(event, api) -> true when handled, width }
// Returns { el, head, body, foot, close(reason), setTitle(node), setBody(...nodes), setHead(...nodes), isOpen() }.
export function drawer({ title = "", head = null, body = null, footer = null, actions = null, onClose, label, id, cls, initialFocus, onKey, width } = {}) {
  if (openDrawer) openDrawer.close("replaced");
  const prev = document.activeElement;
  const titleId = uidShort("dw_");
  const scrim = h("div", { class: "scrim" });
  const titleEl = h("h2", { class: "drawer-title", id: titleId }, title);
  const headExtra = h("div", { class: "drawer-head-extra" }, head);
  const headEl = h("div", { class: "drawer-head" },
    h("div", { class: "drawer-head-row" }, titleEl, h("button", { type: "button", class: "btn btn-sm btn-ghost btn-icon drawer-close", "aria-label": "Close", title: "Close (Esc)", onClick: () => api.close("button") }, icon("x"))),
    headExtra);
  const bodyEl = h("div", { class: "drawer-body" }, body);
  const footEl = h("div", { class: "drawer-foot", hidden: !(footer || (actions && actions.length)) }, footer,
    (actions || []).map((a) => btn(a.label, (e) => a.onClick && a.onClick(e, api), { kind: a.kind, iconName: a.iconName, id: a.id, size: a.size || "" })));
  const el = h("aside", { class: ["drawer", cls], id: id || null, role: "dialog", "aria-modal": "true", "aria-labelledby": label ? null : titleId, "aria-label": label || null, style: width ? `--drawer-w:${width}px` : null }, headEl, bodyEl, footEl);
  const layer = { kind: "drawer" };
  let closed = false;
  const keyHandler = (e) => {
    if (!isTop(layer)) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); api.close("escape"); return; }
    if (e.key === "Tab") { trapTab(e, el); return; }
    if (onKey && (el.contains(e.target) || e.target === document.body) && onKey(e, api) === true) e.preventDefault();
  };
  const api = {
    el, head: headExtra, body: bodyEl, foot: footEl,
    isOpen: () => !closed,
    setTitle: (node) => { clear(titleEl); append(titleEl, [node]); },
    setBody: (...nodes) => { clear(bodyEl); append(bodyEl, nodes); bodyEl.scrollTop = 0; },
    setHead: (...nodes) => { clear(headExtra); append(headExtra, nodes); },
    close: (reason = "close") => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", keyHandler, true);
      popLayer(layer);
      if (openDrawer === api) openDrawer = null;
      el.classList.add("is-closing");
      scrim.remove();
      el.remove();
      if (reason !== "replaced") restoreFocus(prev);
      if (onClose) { try { onClose(reason); } catch (e) { console.error(e); } }
    },
  };
  scrim.addEventListener("mousedown", () => api.close("scrim"));
  document.addEventListener("keydown", keyHandler, true);
  pushLayer(layer);
  document.body.append(scrim, el);
  openDrawer = api;
  setTimeout(() => {
    if (closed) return;
    const want = typeof initialFocus === "string" ? el.querySelector(initialFocus) : initialFocus;
    (want || el.querySelector("[autofocus]") || el.querySelector(".drawer-close")).focus({ preventScroll: true });
  }, 0);
  return api;
}
// A drawer for forms ("Add targets", "Edit rules"): same panel, footer actions.
export function sheet(opts = {}) { return drawer({ ...opts, cls: ["sheet", opts.cls].filter(Boolean).join(" ") }); }

// Fixed help sheet bottom-right (300px, the only element besides menus allowed a shadow). Esc / the close button
// hide it. rows: [[label, keys[]]]. Returns { el, close, toggle, isOpen }.
export function helpSheet({ title = "Keyboard shortcuts", rows = [], onClose } = {}) {
  const layer = { kind: "help" };
  let el = null;
  const keyHandler = (e) => { if (isTop(layer) && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); api.close(); } };
  const api = {
    isOpen: () => !!el,
    open() {
      if (el) return;
      el = h("div", { class: "sheet-help", role: "dialog", "aria-label": title },
        h("div", { class: "sheet-help-head" }, h("b", null, title), h("button", { type: "button", class: "btn btn-xs btn-ghost", onClick: () => api.close(), "aria-label": "Close" }, kbd("Esc"))),
        rows.map(([l, keys]) => h("div", { class: "row" }, h("span", { class: "muted" }, l), h("span", null, (Array.isArray(keys) ? keys : [keys]).map((k) => kbd(k))))));
      document.body.appendChild(el);
      pushLayer(layer);
      document.addEventListener("keydown", keyHandler, true);
    },
    close() {
      if (!el) return;
      el.remove(); el = null;
      popLayer(layer);
      document.removeEventListener("keydown", keyHandler, true);
      if (onClose) onClose();
    },
    toggle() { if (el) api.close(); else api.open(); },
  };
  return api;
}

// ---------------------------------------------------------------- menus

// Popover menu anchored to a button. items: [{ label, hint, iconName, checked (menuitemcheckbox), radio (true ->
// menuitemradio), disabled, danger, value, onSelect(item, event), keepOpen }] | "-" (separator) | { heading }.
// Arrow keys move, Enter/Space selects, Esc closes and refocuses the anchor. Returns { el, close }.
let openMenu = null;
export function menu(anchor, items, { align = "end", cls, label, id, onClose } = {}) {
  if (openMenu) openMenu.close();
  const layer = { kind: "menu" };
  const el = h("div", { class: ["menu", cls], role: "menu", id: id || null, "aria-label": label || null, tabindex: "-1" });
  const entries = [];
  const build = () => {
    clear(el);
    entries.length = 0;
    for (const it of items || []) {
      if (it === "-") { el.appendChild(h("div", { class: "menu-sep", role: "separator" })); continue; }
      if (it && it.heading) { el.appendChild(h("div", { class: "menu-heading" }, it.heading)); continue; }
      const role = it.radio ? "menuitemradio" : typeof it.checked === "boolean" ? "menuitemcheckbox" : "menuitem";
      const b = h("button", { type: "button", class: ["menu-item", it.danger && "is-danger", it.checked && "is-checked"], role, tabindex: "-1", disabled: !!it.disabled,
        "aria-checked": role === "menuitem" ? null : String(!!it.checked), dataset: it.value != null ? { value: String(it.value) } : undefined },
        role !== "menuitem" ? h("span", { class: "menu-check", "aria-hidden": "true" }, it.checked ? icon("check") : null) : it.iconName ? icon(it.iconName) : null,
        h("span", { class: "menu-label" }, it.label),
        it.hint ? h("span", { class: "menu-hint" }, it.hint) : null);
      b.addEventListener("click", (e) => {
        if (b.disabled) return;
        if (role === "menuitemcheckbox") { it.checked = !it.checked; }
        try { if (it.onSelect) it.onSelect(it, e); } catch (err) { console.error(err); }
        if (it.keepOpen || role === "menuitemcheckbox") { const i = entries.indexOf(b); build(); (entries[i] || entries[0]).focus(); } else api.close(true);
      });
      entries.push(b);
      el.appendChild(b);
    }
  };
  build();
  const place = () => {
    const r = anchor.getBoundingClientRect(), mw = el.offsetWidth, mh = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    let left = align === "start" ? r.left : r.right - mw;
    left = Math.max(8, Math.min(left, vw - mw - 8));
    let top = r.bottom + 4;
    if (top + mh > vh - 8 && r.top - mh - 4 > 8) top = r.top - mh - 4;
    el.style.left = Math.round(left) + "px";
    el.style.top = Math.round(Math.max(8, top)) + "px";
  };
  const move = (d) => {
    const en = entries.filter((x) => !x.disabled);
    if (!en.length) return;
    const i = en.indexOf(document.activeElement);
    en[(i + d + en.length) % en.length].focus();
  };
  const keyHandler = (e) => {
    if (!isTop(layer)) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); api.close(true); }
    else if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Home") { e.preventDefault(); const en = entries.filter((x) => !x.disabled); if (en[0]) en[0].focus(); }
    else if (e.key === "End") { e.preventDefault(); const en = entries.filter((x) => !x.disabled); if (en.length) en[en.length - 1].focus(); }
    else if (e.key === "Tab") api.close(false);
  };
  const outside = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) api.close(false); };
  let closed = false;
  const api = {
    el,
    close(refocus = false) {
      if (closed) return;
      closed = true;
      popLayer(layer);
      document.removeEventListener("keydown", keyHandler, true);
      document.removeEventListener("mousedown", outside, true);
      window.removeEventListener("resize", onResize);
      el.remove();
      anchor.setAttribute("aria-expanded", "false");
      if (openMenu === api) openMenu = null;
      if (refocus) restoreFocus(anchor);
      if (onClose) onClose();
    },
  };
  const onResize = () => api.close(false);
  document.body.appendChild(el);
  place();
  pushLayer(layer);
  anchor.setAttribute("aria-expanded", "true");
  document.addEventListener("keydown", keyHandler, true);
  document.addEventListener("mousedown", outside, true);
  window.addEventListener("resize", onResize);
  openMenu = api;
  const firstOn = entries.find((x) => !x.disabled && (x.getAttribute("aria-checked") === "true")) || entries.find((x) => !x.disabled);
  if (firstOn) firstOn.focus();
  return api;
}
// Button that toggles a menu. items: array or () => array (rebuilt on every open).
export function menuButton({ label = "", iconName, title, kind = "ghost", size = "sm", id, cls, items, menuId, align = "end", menuLabel } = {}) {
  let cur = null;
  const b = btn(label, () => {
    if (cur) { cur.close(true); cur = null; return; }
    cur = menu(b, typeof items === "function" ? items() : items, { align, id: menuId, label: menuLabel || label || title, onClose: () => { cur = null; } });
  }, { kind, size, iconName, title, id, cls: ["menu-btn-toggle", cls].filter(Boolean).join(" ") });
  b.setAttribute("aria-haspopup", "menu");
  b.setAttribute("aria-expanded", "false");
  if (label && iconName !== "caret") b.appendChild(icon("caret", "caret"));
  return b;
}

// "Columns" menu saved in localStorage ("sx.cols.<key>"). columns: [{ key, label, locked }], defaults: keys shown first.
// Returns { button, visible() -> Set, isVisible(key), set(keys), reset() }; onChange(visibleSet) after each change.
export function columnsMenu({ key, columns = [], defaults = null, onChange, label = "Columns" } = {}) {
  const lsKey = "sx.cols." + key;
  const def = new Set(defaults || columns.map((c) => c.key));
  let cur;
  try { const raw = JSON.parse(window.localStorage.getItem(lsKey) || "null"); cur = Array.isArray(raw) ? new Set(raw) : new Set(def); } catch (_) { cur = new Set(def); }
  for (const c of columns) if (c.locked) cur.add(c.key);
  const save = () => { try { window.localStorage.setItem(lsKey, JSON.stringify([...cur])); } catch (_) { /* storage blocked */ } if (onChange) onChange(new Set(cur)); };
  const button = menuButton({
    label, iconName: "columns", kind: "ghost", size: "sm", menuLabel: "Visible columns",
    items: () => [
      ...columns.map((c) => ({ label: c.label, checked: cur.has(c.key), disabled: !!c.locked, onSelect: (it) => { if (it.checked) cur.add(c.key); else cur.delete(c.key); save(); } })),
      "-",
      { label: "Reset to defaults", onSelect: () => { cur = new Set(def); for (const c of columns) if (c.locked) cur.add(c.key); save(); } },
    ],
  });
  return { button, visible: () => new Set(cur), isVisible: (k) => cur.has(k), set: (keys) => { cur = new Set(keys); save(); }, reset: () => { cur = new Set(def); save(); } };
}

// ---------------------------------------------------------------- files

export function download(filename, text, mime = "text/plain") {
  const blob = new Blob([text], { type: mime + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: filename, style: "display:none" });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}
export function readFileText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(r.error || new Error("Could not read the file."));
    r.readAsText(file);
  });
}
export const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");

// Mask an API key for display: "sk-…abcd".
export function maskKey(key) {
  const k = String(key || "");
  if (!k) return "";
  const prefix = k.startsWith("sk-") ? "sk-" : k.slice(0, Math.min(3, Math.max(0, k.length - 4)));
  return `${prefix}…${k.slice(-4)}`;
}

// ---------------------------------------------------------------- settings field binder

export function getPath(obj, path) {
  let cur = obj;
  for (const k of String(path).split(".")) { if (cur == null) return undefined; cur = cur[k]; }
  return cur;
}
export function setPath(obj, path, value) {
  const keys = String(path).split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cur[k] == null || typeof cur[k] !== "object") cur[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return obj;
}

const listToText = (v, sep) => (Array.isArray(v) ? v.join(sep) : "");
const textToList = (t) => String(t || "").split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);

// Builds a labelled control bound to a settings path. ctx must provide:
//   ctx.settings, ctx.save(mutator, { from }), ctx.addRefresher(fn)
// spec: { path | get(s)/set(s, v), label, type, options, min, max, step, hint, placeholder, rows, suffix,
//         disabled, inline, cls, parse, format, onSaved, ariaLabel }
// type: number | text | time | select | checkbox | toggle | textarea | list (textarea lines) | csv (one line) | percent
export function boundField(ctx, spec) {
  const type = spec.type || "text";
  const id = spec.id || uidShort("f_");
  const read = (s) => (spec.get ? spec.get(s) : getPath(s, spec.path));
  const write = (s, v) => (spec.set ? spec.set(s, v) : setPath(s, spec.path, v));

  let control;
  if (type === "select") {
    control = h("select", { id, class: "input" });
    for (const o of spec.options || []) {
      const [value, label, disabled] = Array.isArray(o) ? o : [o.value, o.label, o.disabled];
      control.appendChild(h("option", { value: String(value), disabled: !!disabled }, label));
    }
  } else if (type === "checkbox" || type === "toggle") {
    control = h("input", { id, type: "checkbox", role: type === "toggle" ? "switch" : null });
  } else if (type === "textarea" || type === "list") {
    control = h("textarea", { id, class: "input", rows: spec.rows || 3, placeholder: spec.placeholder || null, spellcheck: type === "list" ? "false" : null });
  } else {
    control = h("input", {
      id, class: "input",
      type: type === "number" || type === "percent" ? "number" : type === "time" ? "time" : "text",
      min: spec.min != null ? String(spec.min) : null, max: spec.max != null ? String(spec.max) : null,
      step: spec.step != null ? String(spec.step) : null, placeholder: spec.placeholder || null,
      inputmode: type === "number" || type === "percent" ? "decimal" : null,
    });
  }
  if (spec.disabled) control.disabled = true;
  if (spec.ariaLabel) control.setAttribute("aria-label", spec.ariaLabel);

  const toControl = (v) => {
    if (spec.format) v = spec.format(v);
    if (type === "checkbox" || type === "toggle") control.checked = !!v;
    else if (type === "list") control.value = listToText(v, "\n");
    else if (type === "csv") control.value = listToText(v, ", ");
    else if (type === "percent") control.value = v == null ? "" : String(Math.round(num(v) * 1000) / 10);
    else control.value = v == null ? "" : String(v);
  };
  const fromControl = () => {
    let v;
    if (type === "checkbox" || type === "toggle") v = control.checked;
    else if (type === "number") { if (control.value.trim() === "") return undefined; v = Number(control.value); if (!Number.isFinite(v)) return undefined; }
    else if (type === "percent") { if (control.value.trim() === "") return undefined; v = Number(control.value) / 100; if (!Number.isFinite(v)) return undefined; }
    else if (type === "list" || type === "csv") v = textToList(control.value);
    else v = control.value;
    return spec.parse ? spec.parse(v) : v;
  };
  const commit = async (from) => {
    const v = fromControl();
    if (v === undefined) return;
    await ctx.save((s) => { write(s, v); }, { from: from ? control : null });
    if (spec.onSaved) spec.onSaved(v);
  };
  const debounced = debounce(() => commit(false), type === "textarea" || type === "list" ? 600 : 800);
  if (type === "checkbox" || type === "toggle" || type === "select") control.addEventListener("change", () => commit(true));
  else {
    control.addEventListener("input", () => debounced());
    control.addEventListener("change", () => { debounced.cancel(); commit(true); });
  }
  toControl(read(ctx.settings));
  ctx.addRefresher((s, from) => {
    if (!control.isConnected) return false; // drop me
    if (document.activeElement === control && from !== control) return true;
    if (debounced.pending()) return true;
    toControl(read(s));
    return true;
  });

  const hint = spec.hint ? h("div", { class: "field-hint", id: id + "_hint" }, spec.hint) : null;
  if (hint) control.setAttribute("aria-describedby", id + "_hint");
  let wrap;
  if (type === "checkbox" || type === "toggle") {
    wrap = h("div", { class: ["field", "field-check", spec.cls] },
      h("label", { class: type === "toggle" ? "switch" : "check", for: id }, control, type === "toggle" ? h("span", { class: "switch-track", "aria-hidden": "true" }) : null, h("span", { class: "check-label" }, spec.label)),
      hint);
  } else {
    wrap = h("div", { class: ["field", spec.cls] },
      spec.label ? h("label", { class: "field-label", for: id }, spec.label) : null,
      spec.suffix ? h("div", { class: "input-group" }, control, h("span", { class: "input-suffix" }, spec.suffix)) : control,
      hint);
  }
  wrap.control = control;
  return wrap;
}

// Small labelled wrapper for unbound controls.
export function labeled(label, control, hint) {
  const id = control.id || uidShort("c_");
  control.id = id;
  return h("div", { class: "field" }, h("label", { class: "field-label", for: id }, label), control, hint ? h("div", { class: "field-hint" }, hint) : null);
}
export function selectEl(options, value, attrs = {}) {
  const s = h("select", { class: "input", ...attrs });
  for (const o of options) {
    const [v, l, dis] = Array.isArray(o) ? o : [o.value, o.label, o.disabled];
    s.appendChild(h("option", { value: String(v), disabled: !!dis }, l));
  }
  if (value != null) s.value = String(value);
  return s;
}
export function toggleEl(label, checked, onChange, { id, title } = {}) {
  const cid = id || uidShort("t_");
  const input = h("input", { id: cid, type: "checkbox", role: "switch", checked: !!checked });
  if (onChange) input.addEventListener("change", () => onChange(input.checked, input));
  const l = h("label", { class: "switch", for: cid, title: title || null }, input, h("span", { class: "switch-track", "aria-hidden": "true" }), label ? h("span", { class: "check-label" }, label) : h("span", { class: "sr-only" }, title || "Toggle"));
  l.input = input;
  return l;
}

// Segmented control: options [[value, label, disabled, title]]
export function segmented(options, value, onChange, { label, cls } = {}) {
  const wrap = h("div", { class: ["seg", cls], role: "radiogroup", "aria-label": label || null });
  const btns = [];
  for (const o of options) {
    const [v, l, dis, title] = o;
    const b = h("button", { type: "button", class: "seg-btn", role: "radio", "aria-checked": String(v === value), disabled: !!dis, title: title || null, dataset: { value: String(v) } }, l);
    b.addEventListener("click", () => { if (b.disabled) return; set(v); onChange && onChange(v); });
    btns.push(b);
    wrap.appendChild(b);
  }
  const set = (v) => { for (const b of btns) { const on = b.dataset.value === String(v); b.setAttribute("aria-checked", String(on)); b.classList.toggle("active", on); } };
  set(value);
  wrap.set = set;
  return wrap;
}
// Segmented filter with counts: options [[value, label, count, title]]. Returns the element with set(v), value()
// and setCounts({ [value]: n }) (counts update without rebuilding, so focus stays put).
export function segFilter(options, value, onChange, { label, cls, id } = {}) {
  let cur = value;
  const wrap = h("div", { class: ["seg", "seg-filter", cls], role: "radiogroup", "aria-label": label || null, id: id || null });
  const btns = new Map();
  for (const [v, l, count, title] of options) {
    const ct = h("span", { class: "ct" }, count == null ? "" : String(count));
    const b = h("button", { type: "button", class: "seg-btn", role: "radio", title: title || null, dataset: { value: String(v) } }, h("span", { class: "seg-label" }, l), ct);
    b.ct = ct;
    b.addEventListener("click", () => { wrap.set(v); if (onChange) onChange(v); });
    btns.set(String(v), b);
    wrap.appendChild(b);
  }
  wrap.set = (v) => { cur = v; for (const [k, b] of btns) { const on = k === String(v); b.setAttribute("aria-checked", String(on)); b.classList.toggle("active", on); b.tabIndex = on ? 0 : -1; } };
  wrap.value = () => cur;
  wrap.setCounts = (counts) => { for (const [k, b] of btns) if (counts && Object.hasOwn(counts, k)) b.ct.textContent = counts[k] == null ? "" : String(counts[k]); };
  wrap.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const list = [...btns.values()], i = list.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = list[(i + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length];
    next.focus(); next.click();
  });
  wrap.set(value);
  return wrap;
}

// Small uppercase heading inside a section.
export function sectionTitle(text, extra) { return h("div", { class: "toolbar" }, h("h3", { class: "sub-title" }, text), extra || null); }
export function kv(rows) {
  return h("dl", { class: "kv" }, rows.filter(Boolean).map(([k, v]) => [h("dt", null, k), h("dd", null, v == null || v === "" ? "-" : v)]));
}

// ---------------------------------------------------------------- chips for the engine bar / popup

// Risk estimate chip from getStatus().risk = { level: low|medium|high, score, factors: [{ id, label, detail }], hoursToLimit }.
export function riskChip(risk, { href = "#safety", id } = {}) {
  if (!risk || !risk.level) return null;
  const lvl = ["low", "medium", "high"].includes(risk.level) ? risk.level : "medium";
  const top = Array.isArray(risk.factors) ? risk.factors[0] : null;
  const tip = `Risk estimate: ${lvl}${Number.isFinite(Number(risk.score)) ? ` (${Math.round(Number(risk.score))}/100)` : ""}${top ? `. Top factor: ${top.label}${top.detail ? " - " + top.detail : ""}` : ""}. An estimate, not a guarantee.`;
  return h(href ? "a" : "span", { class: ["risk", "risk-" + lvl], href: href || null, id: id || null, title: tip, "aria-label": tip },
    h("span", { class: "risk-sq", "aria-hidden": "true" }), h("span", { class: "risk-txt" }, "Risk " + lvl));
}
// Logged-in account chip: lime square + @handle when the last page check matched settings.account.handle; red when
// logged out / another account; grey when not checked yet. state.me = { handle, checkedAt } (when the worker has it).
export function accountChip(settings, state, { href = "#settings", id } = {}) {
  const want = String((settings && settings.account && settings.account.handle) || "").replace(/^@+/, "");
  const st = state || {};
  const stopped = st.status !== STATUS.RUNNING;
  const r = st.stopReason;
  let kind = "unknown", text = want ? "@" + want : "no handle", title = want ? `Your X account @${want}. ScoreX checks the logged-in account before it acts.` : "Set your X handle in Settings.";
  const me = st.me && st.me.handle ? String(st.me.handle).replace(/^@+/, "") : "";
  if (stopped && r === STOP.LOGGED_OUT) { kind = "bad"; text = "logged out"; title = "Logged out of X: log back in, then review the stop."; }
  else if (stopped && r === STOP.WRONG_ACCOUNT) { kind = "bad"; text = "other account"; title = st.stopDetail || `A different X account is logged in (ScoreX expects @${want}).`; }
  else if (stopped && r === STOP.ACCOUNT_UNKNOWN) { kind = "warn"; text = "account unknown"; title = "Could not verify which X account is logged in."; }
  else if (me && want) {
    const ok = me.toLowerCase() === want.toLowerCase();
    kind = ok ? "ok" : "bad";
    text = ok ? "@" + want : "other account";
    title = `Logged in on x.com as @${me}${st.me.checkedAt ? ` (checked ${fmtAgo(st.me.checkedAt)})` : ""}${ok ? "" : `; ScoreX expects @${want}`}`;
  }
  return h("a", { class: ["acct", "acct-" + kind], href, id: id || null, title }, h("span", { class: "sq", "aria-hidden": "true" }), h("span", { class: "acct-txt" }, text));
}
// Mode tag: REVIEW (outline) or AUTO (solid lime).
export function modeTag(mode) {
  const auto = mode === MODE.AUTO;
  return h("span", { class: ["tag", auto && "tag-solid", "mode-tag"], title: auto ? "Full auto: posts on its own within your safety limits" : "Review: you approve every reply" }, auto ? "Auto" : "Review");
}

// Red safety banner (full-width red fill): { title, detail, time, actions: [nodes] }.
export function safetyBanner({ title, detail, time, actions = [], id, cls } = {}) {
  return h("div", { class: ["alert-banner", cls], role: "alert", id: id || null },
    icon("alert", "alert-icon"),
    h("div", { class: "alert-text" },
      h("strong", null, title || "Safety stop"),
      detail ? h("div", { class: "alert-detail" }, detail) : null,
      time ? h("div", { class: "alert-time" }, time) : null),
    h("div", { class: "alert-actions" }, actions));
}

// ---------------------------------------------------------------- safety flows

// Plain-language guidance per stop reason: { title, what, steps: [], confirm, kind: "x" (check X) | "app", link: [href, text] | null, detailLabel }.
export function stopGuide(reason, settings) {
  const me = String((settings && settings.account && settings.account.handle) || "").replace(/^@+/, "");
  const at = me ? "@" + me : "your account";
  const X = "I opened X and my account looks fine";
  const G = {
    captcha: ["x", "X asked for a captcha or a human check.", ["Open x.com in a normal tab and solve the check.", "Browse for a minute by hand, then come back."], X + " (captcha solved)"],
    unusual_activity: ["x", "X warned about unusual or automated activity.", ["Open x.com and read the notice; complete any check it asks for.", "Consider waiting a few hours and lowering the daily limit (Safety) before you resume."], X + " (no warning)"],
    rate_limit: ["x", "X is limiting requests from your account.", ["Wait at least 30-60 minutes.", "Check that x.com loads normally in a normal tab."], X + " (pages load normally)"],
    account_locked: ["x", "X locked or restricted the account.", ["Open x.com and follow X's steps to unlock it.", "Do not resume until the account works normally."], "My account is unlocked and works normally"],
    logged_out: ["x", "This browser is logged out of X.", [`Log back into X as ${at} in a normal tab.`], `I logged back in as ${at}`],
    wrong_account: ["x", `A different X account is logged in (ScoreX expects ${at}).`, [`Switch to ${at} on x.com, or change the handle in Settings if that is intended.`], `${at} is logged in on x.com`],
    repeated_post_failures: ["x", "Several replies failed to post in a row.", ["Open x.com and post a reply by hand.", "If that fails too, X may be limiting you: wait before you resume."], "Replying by hand works on x.com"],
    dom_changed: ["x", "X changed its page and ScoreX could not find what it needs.", ["Run the live X test in Settings > Diagnostics.", "Selector overrides may be needed if X changed its layout."], "I checked X and want to try again"],
    unknown_prompt: ["x", "X showed a dialog or notice that ScoreX does not recognise. ScoreX never clicks unknown prompts.", ["Open x.com, read the prompt and handle it yourself (accept or dismiss it).", "If it asks about automation or labels, decide carefully before you resume."], X + " (I handled the prompt)"],
    account_unknown: ["x", "ScoreX could not read which account is logged in, several times in a row.", [`Open x.com and check that ${at} is logged in and pages load normally.`], `I opened X: ${at} is logged in`],
    reach_drop: ["x", "Views of your replies dropped sharply compared with last week. X may be hiding your replies.", ["Open a few of your recent replies in a logged-out window and check they show.", "Consider pausing for a day and lowering the daily limit (Safety).", "Views are a proxy: X does not tell you when it hides a reply."], "I checked my replies and want to resume"],
    budget_reached: ["app", "This month's OpenAI budget is used up.", ["Raise the budget in Models & costs, or wait for next month."], "I raised the budget or want to try again", ["#models", "Open Models & costs"]],
    openai_auth: ["app", "OpenAI rejected your API key.", ["Replace the key in Models & costs."], "I replaced the API key", ["#models", "Open Models & costs"]],
    openai_quota: ["app", "OpenAI says the quota is used up or billing failed.", ["Check billing on platform.openai.com, then come back."], "I fixed billing on OpenAI"],
    no_api_key: ["app", "No OpenAI API key is set.", ["Add your key in Models & costs."], "I added the API key", ["#models", "Open Models & costs"]],
    tab_unavailable: ["app", "ScoreX could not open its X tab.", ["Check that x.com opens in this browser and that new windows are not blocked."], "x.com opens normally in this browser"],
    internal_error: ["app", "Something went wrong inside ScoreX.", ["The activity log on Today has the details."], "I checked the activity log"],
  };
  const g = G[reason] || ["x", "ScoreX stopped for your safety.", ["Open x.com in a normal tab and check your account."], X];
  return { title: STOP_LABEL[reason] || (reason ? String(reason) : "Safety stop"), kind: g[0], what: g[1], steps: g[2], confirm: g[3], link: g[4] || null, detailLabel: reason === "unknown_prompt" ? "What X showed" : "Details" };
}

// "Review stop…" dialog: reason, details (plain text), time, guidance, "Open x.com in a normal tab", and one required
// checkbox before Resume (the checkbox gets the initial focus). Resolves true when the engine was resumed.
// ctx: { state, settings, send, refreshStatus? }.
export function reviewStopDialog(ctx) {
  return new Promise((resolve) => {
    const state = ctx.state || {};
    const al = state.alert || null;
    const reason = (al && al.reason) || state.stopReason || "";
    const g = stopGuide(reason, ctx.settings);
    const at = (al && al.at) || state.stoppedAt || null;
    const detail = String((al && al.detail) || state.stopDetail || "").trim();
    const cbId = uidShort("rs_");
    const cb = h("input", { type: "checkbox", id: cbId });
    let m = null;
    const body = h("div", { class: "rs-body" },
      at ? h("p", { class: "rs-when" }, `${fmtDateTime(at)} (${fmtAgo(at)}). ScoreX stopped and waits for you.`) : null,
      h("p", { class: "rs-what" }, g.what),
      detail ? h("div", { class: "rs-detail" }, h("span", { class: "cap" }, g.detailLabel), h("p", { class: "rs-detail-text" }, detail)) : null,
      g.steps.length ? h("ol", { class: "rs-steps" }, g.steps.map((x) => h("li", null, x))) : null,
      h("div", { class: "rs-tools" },
        g.kind === "x" ? btn("Open x.com in a normal tab", () => { try { chrome.tabs.create({ url: "https://x.com/home", active: true }); } catch (_) { window.open("https://x.com/home", "_blank", "noopener"); } }, { iconName: "external", size: "sm", id: "rsOpenX" }) : null,
        g.link ? h("a", { href: g.link[0], class: "btn btn-sm", onClick: () => m && m.close(false) }, g.link[1]) : null),
      h("label", { class: "check rs-check", for: cbId }, cb, h("span", null, g.confirm)));
    m = modal({
      title: g.title, body, cls: "modal-stop", initialFocus: cb,
      actions: [
        { label: "Cancel", value: false },
        { label: "Resume", kind: "primary", value: true, id: "rsResumeBtn", iconName: "play", disabled: true, onClick: async () => {
          const r = await ctx.send("resume", {}, { label: "Resume" });
          if (!r) return false;
          toast("Resumed", { type: "success" });
          if (ctx.refreshStatus) ctx.refreshStatus();
          return true;
        } },
      ],
      onClose: (v) => resolve(v === true),
    });
    const resumeBtn = m.buttons[1];
    cb.addEventListener("change", () => { resumeBtn.disabled = !cb.checked; });
  });
}

// Confirm before switching to Full auto, with today's actual limits. Resolves true/false (does not save).
export function confirmFullAuto(ctx) {
  const s = ctx.settings, state = ctx.state || {};
  const sf = s.safety || {};
  const lim = dailyLimit(s, state), per = Math.min(num(sf.perTargetDay, 2), HARD.perTargetDay), acc = accountsLimit(s);
  const g = sf.gapMin || { min: 2, max: 6 }, ah = sf.activeHours || {}, br = sf.breaks || {};
  const hours = ah.enabled ? `${ah.start}-${ah.end} (${s.timezone})` : "off (any time of day)";
  const rng = (a, b) => `${a}\u2011${b}`; // non-breaking hyphen keeps "8-15" on one line
  const rows = [
    ["Daily limit", `${lim} per 24 h`], ["Per account", `${per} per 24 h`], ["Accounts per day", String(acc)],
    ["Gap between comments", `${rng(g.min, g.max)} min`], ["Breaks", br.enabled ? `every ${rng(br.afterMin, br.afterMax)} comments, ${rng(br.minutesMin, br.minutesMax)} min` : "off"], ["Active hours", hours],
  ];
  return new Promise((resolve) => {
    let m = null;
    const body = h("div", { class: "fa-body" },
      h("p", { class: "modal-text" }, `ScoreX will post on its own: up to ${lim} per 24 h, ${per} per account, gaps ${g.min}-${g.max} min, active hours ${ah.enabled ? "on" : "off"}.`),
      h("dl", { class: "fa-limits" }, rows.map(([k, v]) => h("div", null, h("dt", null, k), h("dd", null, v)))),
      h("p", { class: "small muted" }, "Hard caps always apply on top. Switch back to Review at any time. ", h("a", { href: "#safety", onClick: () => m && m.close(false) }, "Change the limits in Safety")));
    m = modal({
      title: "Turn on Full auto?", body, cls: "modal-fullauto",
      actions: [{ label: "Cancel", value: false }, { label: "Turn on Full auto", kind: "primary", value: true, id: "faConfirmBtn" }],
      onClose: (v) => resolve(v === true),
    });
  });
}
// Switch the mode the safe way: Full auto asks confirmFullAuto first; Review switches at once. Resolves true when saved.
export async function switchMode(ctx, mode) {
  const next = mode === MODE.AUTO ? MODE.AUTO : MODE.REVIEW;
  if (ctx.settings.mode === next) return true;
  if (next === MODE.AUTO && !(await confirmFullAuto(ctx))) return false;
  const saved = await ctx.save((d) => { d.mode = next; });
  return !!saved;
}

// ---------------------------------------------------------------- health (rail footer, popup header)

// Is an OpenAI key saved? true / false, or null when it cannot be told. sx.secretsRev first (no IndexedDB read).
export async function hasOpenaiKey(secretsRev) {
  if (secretsRev && typeof secretsRev.hasOpenai === "boolean") return secretsRev.hasOpenai;
  try { return !!(await getSecrets()).openaiKey; } catch (_) { return null; }
}
// Quick health from state + permissions (no X tab): { level: ok|warn|fail, issues: [{ level, text, href }], at }.
export async function healthCheck({ settings, state, secretsRev } = {}) {
  const issues = [];
  const add = (level, text, href) => issues.push({ level, text, href });
  const st = state || {}, s = settings || {};
  const now = Date.now();
  if (isSafetyStop(st)) add("fail", `Stopped for safety: ${STOP_LABEL[(st.alert && st.alert.reason) || st.stopReason] || "check your account"}`, "#overview");
  try {
    if (chrome.permissions && !(await chrome.permissions.contains({ origins: ["https://x.com/*", "https://api.openai.com/*"] }))) add("fail", "Site access to x.com or api.openai.com is missing", "#diagnostics");
  } catch (_) { /* not available */ }
  // Same levels as Settings > Diagnostics, so the rail and the quick check agree. sx.secretsRev is only written once a
  // key is saved, so without it (a fresh install) the stored secrets are asked (presence only, the key is never read out).
  if (await hasOpenaiKey(secretsRev) === false) add("fail", "No OpenAI API key: ScoreX cannot write replies", "#models");
  if (s.account && !String(s.account.handle || "").trim()) add("warn", "Your X handle is not set", "#settings");
  if (st.status === STATUS.RUNNING && st.nextTickAt && now - st.nextTickAt > 10 * 60000) add("warn", `No engine check since ${fmtTime(st.nextTickAt)}: the scheduler may be stuck`, "#diagnostics");
  for (const [id, cfg] of Object.entries(s.providers || {})) {
    if (!cfg || !cfg.enabled) continue;
    const def = PROVIDER_DEFS[id];
    if (!def) continue;
    const modes = Object.entries(def.modes || {}).filter(([m]) => !cfg.mode || cfg.mode === "auto" || cfg.mode === m);
    let ok = !modes.length;
    for (const [, m] of modes) {
      const origins = m.hosts || [];
      const perms = ["score", "smartFollowers"].some((c) => m[c] && m[c].kind === "tab") ? ["scripting"] : [];
      try { if (!origins.length && !perms.length) { ok = true; break; } if (await chrome.permissions.contains({ origins, permissions: perms })) { ok = true; break; } } catch (_) { ok = true; }
    }
    if (!ok) add("warn", `${def.name}: site access not granted`, "#scores");
  }
  if (st.reachAlert) add("warn", "Your replies are reaching far fewer people than last week", "#safety");
  // The last live X test (state.lastSelfTest, saved by the worker) counts for a week.
  const lt = st.lastSelfTest;
  if (lt && Array.isArray(lt.checks) && now - (Number(lt.at) || 0) < 7 * 864e5) {
    const bad = lt.checks.filter((c) => c && !c.ok).length + (lt.stop ? 1 : 0);
    if (bad) add("fail", `Live X test: ${bad} check${bad === 1 ? "" : "s"} failed`, "#diagnostics");
  }
  if (st.followBadgeOkAt && now - st.followBadgeOkAt > 3 * 864e5) add("warn", "The \"Follows you\" badge was not seen for 3+ days", "#diagnostics");
  try {
    const used = await chrome.storage.local.getBytesInUse(null);
    if (used > 8 * 1024 * 1024) add("warn", `Storage ${(used / 1048576).toFixed(1)} MB of 10 MB used`, "#diagnostics");
  } catch (_) { /* not available */ }
  const level = issues.some((i) => i.level === "fail") ? "fail" : issues.length ? "warn" : "ok";
  return { level, issues, at: now };
}
// Short text for the rail footer: the most severe count only ("1 problem", "2 warnings", "OK").
export function healthShort(hc) {
  if (!hc) return "checking";
  const f = hc.issues.filter((i) => i.level === "fail").length, w = hc.issues.length - f;
  return f ? `${f} problem${f === 1 ? "" : "s"}` : w ? `${w} warning${w === 1 ? "" : "s"}` : "OK";
}
export function healthLabel(hc) {
  if (!hc) return "Health: checking";
  const f = hc.issues.filter((i) => i.level === "fail").length, w = hc.issues.length - f;
  if (!hc.issues.length) return "Health: OK";
  return "Health: " + [f ? `${f} problem${f === 1 ? "" : "s"}` : "", w ? `${w} warning${w === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
}
