// ScoreX UI - tiny DOM helpers shared by the dashboard tabs and the popup.
// No framework: h() builds elements, small widgets (toast, modal, table, badges) and the settings
// field binder that saves on change. Never put secrets into anything that is logged.

import { STATUS, STOP_LABEL, HS } from "../lib/constants.js";
import { fmtUsd, fmtCount, fmtDuration, truncate, num } from "../lib/util.js";
import { FS, FS_LABEL, followStatus, followDays } from "../lib/targets.js";

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

// ---------------------------------------------------------------- icons (static SVG strings)

const P = {
  overview: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
  targets: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
  review: '<path d="M4 5h16v11H8l-4 4z"/><path d="M8 9h8M8 12h5"/>',
  models: '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9h6v6H9zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  tones: '<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 6l3 3"/>',
  safety: '<path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
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
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
};
export function icon(name, cls = "") {
  const path = P[name] || P.info;
  return h("span", { class: ["icon", cls], "aria-hidden": "true", html: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>` });
}

// ---------------------------------------------------------------- time & number formatting

let TZ;
export function setTz(tz) { TZ = tz || undefined; }
function fmt(ts, opts) {
  if (!ts || !Number.isFinite(Number(ts))) return "-";
  try { return new Intl.DateTimeFormat(undefined, { timeZone: TZ, ...opts }).format(new Date(Number(ts))); }
  catch (_) { return new Date(Number(ts)).toLocaleString(); }
}
export const fmtTime = (ts) => fmt(ts, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export const fmtDate = (ts) => fmt(ts, { year: "numeric", month: "short", day: "numeric" });
export const fmtDay = (ts) => fmt(ts, { month: "short", day: "numeric" });
export const fmtDateTime = (ts) => fmt(ts, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
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

// ---------------------------------------------------------------- toast

export function toast(message, opts = {}) {
  const { type = "info", timeout } = typeof opts === "string" ? { type: opts } : opts;
  let box = document.getElementById("toasts");
  if (!box) { box = h("div", { id: "toasts", class: "toasts", "aria-live": "polite" }); document.body.appendChild(box); }
  const el = h("div", { class: ["toast", "toast-" + type], role: type === "error" ? "alert" : "status" },
    icon(type === "error" ? "alert" : type === "success" ? "check" : type === "warn" ? "alert" : "info"),
    h("div", { class: "toast-msg" }, message),
    h("button", { class: "toast-x", type: "button", "aria-label": "Dismiss", onClick: () => close() }, icon("x")));
  const close = () => { el.classList.add("out"); setTimeout(() => el.remove(), 180); };
  box.appendChild(el);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(close, timeout || (type === "error" ? 7000 : 3500));
  return close;
}

// ---------------------------------------------------------------- modal / confirm

export function modal({ title, body, actions = [], wide = false, onClose } = {}) {
  const prev = document.activeElement;
  const overlay = h("div", { class: "modal-overlay" });
  const titleId = uidShort("mt_");
  const footer = h("div", { class: "modal-footer" });
  const box = h("div", { class: ["modal", wide && "modal-wide"], role: "dialog", "aria-modal": "true", "aria-labelledby": titleId },
    h("div", { class: "modal-header" },
      h("h2", { id: titleId }, title || ""),
      h("button", { type: "button", class: "btn btn-ghost btn-icon", "aria-label": "Close", onClick: () => close() }, icon("x"))),
    h("div", { class: "modal-body" }, body),
    footer);
  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    if (prev && prev.focus) try { prev.focus(); } catch (_) {}
    if (onClose) onClose(result);
  };
  for (const a of actions) {
    footer.appendChild(h("button", {
      type: "button",
      class: ["btn", a.kind ? "btn-" + a.kind : ""],
      onClick: async () => { const r = a.onClick ? await a.onClick() : undefined; if (r !== false) close(a.value); },
    }, a.label));
  }
  if (!actions.length) footer.appendChild(h("button", { type: "button", class: "btn", onClick: () => close() }, "Close"));
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Tab") {
      const f = $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', box).filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey, true);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  const firstBtn = footer.querySelector(".btn-primary, .btn-danger") || footer.querySelector("button");
  setTimeout(() => { (box.querySelector("[autofocus]") || firstBtn || box).focus(); }, 0);
  return { el: box, close };
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

// ---------------------------------------------------------------- badges & pills

export const TIER_INFO = {
  1: { label: "Tier 1", short: "T1", desc: "Big influencer" },
  2: { label: "Tier 2", short: "T2", desc: "Smart account" },
};
// Follow status of a target (lib/targets.js followStatus): a small coloured square + the word, like the
// history status. Not following shows "day N/14" once ScoreX has commented (the give-up countdown).
export const FS_COLOR = { [FS.CHECKING]: "grey", [FS.ACTIVE]: "ink", [FS.FOLLOWS]: "green-o", [FS.FOLLOWED_BACK]: "green" };
export function followBadge(t, settings, { compact = false } = {}) {
  if (!t) return h("span", { class: "muted" }, "-");
  const rel = t.rel || {};
  if (rel.gone) return h("span", { class: ["hs", "hs-red", "fs"], title: "Profile not found on X (renamed, suspended or deleted). The target was turned off." }, "Not found");
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
    const days = followDays(t);
    title = "Does not follow you - ScoreX comments on this account." + (f.autoRemove === false
      ? " Automatic removal is off."
      : ` Removed after ${giveUp} days of comments without a follow-back${f.blacklist === false ? "" : " (and blacklisted)"}.`);
    if (days != null) kids.push(h("span", { class: ["fs-extra", "fs-days", f.autoRemove !== false && giveUp - days <= 2 && "is-near"] }, `day ${Math.min(days, giveUp)}/${giveUp}`));
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

// Engine status -> display info. Safety stops (anything but "user") are red.
export function statusInfo(state) {
  const st = (state && state.status) || STATUS.STOPPED;
  if (st === STATUS.RUNNING) return { kind: "running", label: "Running", reason: "" };
  if (st === STATUS.PAUSED) return { kind: "paused", label: "Paused", reason: state.stopDetail || "" };
  const r = state && state.stopReason;
  const reason = r ? STOP_LABEL[r] || String(r) : "";
  return { kind: r && r !== "user" ? "danger" : "stopped", label: "Stopped", reason: r === "user" ? "" : reason, detail: (state && state.stopDetail) || "" };
}
// The one primary engine action for the current state: [label, message, icon].
export function primaryAction(state) {
  const st = (state && state.status) || STATUS.STOPPED;
  if (st === STATUS.RUNNING) return ["Pause", "pause", "pause"];
  if (st === STATUS.PAUSED) return ["Resume", "resume", "play"];
  if (state && state.stopReason && state.stopReason !== "user") return ["Resume", "resume", "play"];
  return ["Start", "start", "play"];
}
// Status dot + label ("Running", "Paused", "Stopped (reason)").
export function statusPill(state, { large = false } = {}) {
  const i = statusInfo(state);
  return h("span", { class: ["status", "status-" + i.kind, large && "status-lg"], title: [i.label, i.reason, i.detail].filter(Boolean).join(" - ") },
    h("span", { class: "dot", "aria-hidden": "true" }),
    h("span", { class: "status-label" }, i.label),
    i.reason && i.kind !== "running" ? h("span", { class: "status-reason" }, `(${i.reason})`) : null);
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

// Flat section separated by a hairline. Default layout: title + hint column on the left, content on the right.
// wide: header above the content (tables, lists).
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
export function advanced({ key, title = "Advanced", desc, tag, id, open = false } = {}, ...children) {
  const stored = key ? readAdv(key) : null;
  const descEl = h("span", { class: "adv-desc" }, desc || "");
  const tagEl = h("span", { class: "adv-tag", hidden: !tag }, tag || "");
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

// Instrument strip: cells separated by hairlines that wrap cleanly.
export function panel(cls, ...cells) {
  return h("div", { class: ["panel", cls] }, h("div", { class: "panel-in" }, cells));
}
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

export function btn(label, onClick, { kind = "", size = "", iconName, title, disabled, type = "button", id } = {}) {
  return h("button", { type, id: id || null, class: ["btn", kind && "btn-" + kind, size && "btn-" + size], title: title || null, disabled: !!disabled, onClick },
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

// renderTable({ columns, rows, rowKey, selection: Set, onSelectionChange, empty, sortState, maxRows, rowClass })
// column: { key, label, render(row) -> node|string, sort(row) -> value | false, className, title, align, sticky }
export function renderTable(opts) {
  const { columns, rows = [], rowKey = (r) => r.id, selection = null, onSelectionChange, empty = "Nothing here yet.", sortState = {}, maxRows = 0, rowClass, className, caption } = opts;
  const wrap = h("div", { class: ["table-wrap", className] });
  let limit = maxRows || Infinity;

  const sortedRows = () => {
    const col = columns.find((c) => (c.key || c.label) === sortState.key);
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

  const draw = () => {
    clear(wrap);
    if (!rows.length) { wrap.appendChild(h("div", { class: "table-empty" }, empty)); return; }
    const list = sortedRows();
    const visible = list.slice(0, limit);
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
      headCells.push(h("th", { class: "col-check" }, all));
    }
    for (const c of columns) {
      const key = c.key || c.label;
      const sortable = c.sort !== false && (c.sort || c.key);
      const active = sortState.key === key;
      const th = h("th", { class: [c.className, c.align && "align-" + c.align, sortable && "sortable", active && "sorted"], title: c.title || null, scope: "col", "aria-sort": active ? (sortState.dir === "asc" ? "ascending" : "descending") : null },
        sortable ? h("button", { type: "button", class: "th-btn", onClick: () => {
          if (sortState.key === key) sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
          else { sortState.key = key; sortState.dir = c.defaultDir || "desc"; }
          draw();
        } }, c.label, active ? h("span", { class: "sort-ind", "aria-hidden": "true" }, sortState.dir === "asc" ? "▲" : "▼") : null) : c.label);
      headCells.push(th);
    }
    const tbody = h("tbody");
    for (const r of visible) {
      const k = rowKey(r);
      const tr = h("tr", { class: [rowClass && rowClass(r), selection && selection.has(k) && "is-selected"], dataset: { key: String(k) } });
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
        tr.appendChild(h("td", { class: [c.className, c.align && "align-" + c.align] }, v == null || v === "" ? "-" : v));
      }
      tbody.appendChild(tr);
    }
    const table = h("table", { class: "table" }, caption ? h("caption", { class: "sr-only" }, caption) : null, h("thead", null, h("tr", null, headCells)), tbody);
    wrap.appendChild(table);
    if (list.length > visible.length) {
      wrap.appendChild(h("div", { class: "table-more" },
        h("span", { class: "muted" }, `Showing ${visible.length} of ${list.length}`),
        btn("Show more", () => { limit += maxRows || 100; draw(); }, { size: "sm" })));
    }
  };
  draw();
  wrap.redraw = draw;
  return wrap;
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

// Segmented control: options [[value,label,disabled,title]]
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

// Small uppercase heading inside a section.
export function sectionTitle(text, extra) { return h("div", { class: "toolbar" }, h("h3", { class: "sub-title" }, text), extra || null); }
export function kv(rows) {
  return h("dl", { class: "kv" }, rows.filter(Boolean).map(([k, v]) => [h("dt", null, k), h("dd", null, v == null || v === "" ? "-" : v)]));
}
