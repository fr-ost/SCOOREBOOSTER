// ScoreX popup: status line, the one primary Start/Pause/Resume button (+ Stop), 24h quota bar,
// pending review count (opens the Review Queue), cost today / month, alert line, Open dashboard.

import { K, MODE, STATUS, STOP_LABEL } from "../lib/constants.js";
import { getSettings, DEFAULT_STATE } from "../lib/store.js";
import { budgetStatus } from "../lib/costs.js";
import { dailyLimit } from "../lib/safety.js";
import { dayKey, num } from "../lib/util.js";
import * as history from "../lib/history.js";
import { h, btn, busy, send, toast, icon, statusInfo, primaryAction, quotaBar, fig, fmtUsd, fmtAgo, fmtTime, fmtIn, setTz, fill } from "./components.js";

let settings = null;
let state = { ...DEFAULT_STATE };
let spend = null;
let status = null;
let pending = 0;
let queued = 0;

const $ = (id) => document.getElementById(id);

function openDashboard(hash) {
  const url = chrome.runtime.getURL("ui/dashboard.html" + (hash ? "#" + hash : ""));
  const done = () => { try { window.close(); } catch (_) {} };
  if (!hash && chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage().then(done, () => chrome.tabs.create({ url }).then(done));
  } else {
    chrome.tabs.create({ url }).then(done, () => { location.href = url; });
  }
}

function render() {
  if (!settings) return;
  const info = statusInfo(state);
  const eff = (status && status.effectiveMode) || (settings.mode === MODE.AUTO ? MODE.AUTO : MODE.REVIEW);
  const modeEl = $("pMode");
  modeEl.textContent = eff === MODE.AUTO ? "Full auto" : "Review";
  modeEl.classList.toggle("is-auto", eff === MODE.AUTO);
  modeEl.title = eff === MODE.AUTO ? "Full auto: posts on its own within your safety limits" : "Review: you approve every comment";

  // status line
  const lines = [];
  const now = Date.now();
  const t = (ts) => h("span", { class: "tnum" }, fmtTime(ts));
  if (info.reason && state.status === STATUS.STOPPED && !state.alert) lines.push(h("div", { class: ["p-reason", info.kind === "danger" && "is-danger"] }, info.reason));
  if (state.status === STATUS.RUNNING) {
    const ah = status && status.activeHours;
    if (ah && ah.inside === false) lines.push(h("div", { class: "p-sub" }, "Sleeping until ", t(ah.opensAt), " (outside active hours)"));
    else if (state.breakUntil && state.breakUntil > now) lines.push(h("div", { class: "p-sub" }, "On a break until ", t(state.breakUntil)));
    else if (state.nextCommentAt && state.nextCommentAt > now) lines.push(h("div", { class: "p-sub" }, `Next comment allowed ${fmtIn(state.nextCommentAt)}`));
    if (state.nextTickAt) lines.push(h("div", { class: "p-sub" }, `Next check ${fmtIn(state.nextTickAt)}`, state.lastTickAt ? ` · last ${fmtAgo(state.lastTickAt)}` : ""));
  } else {
    if (state.status === STATUS.PAUSED) lines.push(h("div", { class: "p-sub" }, "Nothing is generated or posted."));
    if (state.lastTickAt) lines.push(h("div", { class: "p-sub" }, `Last check ${fmtAgo(state.lastTickAt)}`));
  }
  const box = $("pStatusBox");
  fill(box,
    h("div", { class: ["big-status", "is-" + info.kind], id: "pStatus" }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", null, info.label)),
    ...lines);
  box.dataset.kind = info.kind;

  // alert line
  const al = state.alert;
  const alertEl = $("pAlert");
  alertEl.hidden = !al;
  if (al) fill(alertEl, h("strong", null, STOP_LABEL[al.reason] || al.reason || "Safety stop"), al.detail ? h("div", null, al.detail) : null, h("div", null, `${fmtAgo(al.at)} · check your X account, then resume.`));

  // controls: one primary action + Stop
  const act = (label, msg, iconName, kind, extra = {}) => btn(label, (e) => {
    const bt = e.currentTarget;
    busy(bt, async () => { const r = await send(msg, {}, { label }); if (r) { toast(`${label}: done`, { type: "success" }); refresh(); } });
  }, { kind, iconName, id: "p-" + msg, ...extra });
  const [label, msg, ic] = primaryAction(state);
  const canStop = state.status === STATUS.RUNNING || state.status === STATUS.PAUSED;
  fill($("pControls"), act(label, msg, ic, "primary"), act("Stop", "stop", "stop", "quiet", { disabled: !canStop, title: canStop ? "Stop the engine" : "Already stopped" }));

  // quota
  const td = (status && status.today) || {};
  const limit = td.limit != null ? td.limit : dailyLimit(settings, state);
  const posted = td.posted != null ? num(td.posted) : null;
  fill($("pQuota"),
    h("div", { class: "p-quota-head" },
      h("span", { class: "cell-label" }, "Posted · 24h"),
      h("span", { class: "p-quota-num" }, h("span", { id: "pPosted" }, posted == null ? "-" : String(posted)), h("span", { class: "fig-of" }, ` / ${limit}`))),
    quotaBar(posted || 0, limit, { label: "Comments posted in the last 24 hours" }),
    h("span", { class: "p-quota-sub", id: "pQuotaSub" }, quotaSub(td, status && status.follow)));

  // pending review
  fill($("pPendingSlot"),
    h("button", { type: "button", class: ["p-row", pending && "has-items"], id: "pPending", title: "Open the Review Queue", onClick: () => openDashboard("review") },
      h("span", { class: "p-cell-label" }, "Pending review", h("span", { class: "p-cell-sub" }, queued ? ` · ${queued} approved` : "")),
      h("span", { class: "p-cell-value" }, String(pending)),
      icon("chevron")));

  // costs
  const b = budgetStatus(settings, spend);
  const todayCost = Math.max(num(td.cost), num(spend && spend.days && spend.days[dayKey(Date.now(), settings.timezone)]));
  fill($("pCosts"),
    fig({ label: "Cost today", value: fmtUsd(todayCost) }),
    fig({ label: "This month", value: fmtUsd(b.spent), of: b.limit ? fmtUsd(b.limit, 0) : null, cls: b.reached ? "is-red" : b.warn ? "is-amber" : null, title: b.limit ? `${Math.round(b.pct)}% of budget` : "No monthly budget set" }));
}

// "12 generated · 30 commenting · 2 checking · 4 followed back" (follow counts from getStatus).
function quotaSub(td, fo) {
  const parts = [`${num(td.generated)} generated`];
  if (fo) {
    parts.push(`${num(fo.active)} commenting`);
    if (num(fo.checking)) parts.push(`${num(fo.checking)} checking`);
    if (num(fo.followedBack)) parts.push(`${num(fo.followedBack)} followed back`);
  }
  return parts.map((x) => x.replace(/ /g, "\u00a0")).join(" · "); // wrap only between items
}

async function refresh() {
  const r = await send("getStatus", {}, { quiet: true });
  status = r && r.status ? r.status : null;
  try {
    const [p, a, q] = await Promise.all([history.byStatus("pending_review"), history.byStatus("approved"), history.byStatus("queued")]);
    pending = p.length; queued = a.length + q.length;
  } catch (_) { /* keep last */ }
  render();
}

async function init() {
  const [s, data] = await Promise.all([getSettings(), chrome.storage.local.get([K.state, K.spend])]);
  settings = s;
  state = { ...DEFAULT_STATE, ...(data[K.state] || {}) };
  spend = data[K.spend] || null;
  setTz(settings.timezone);
  $("pOpen").addEventListener("click", () => openDashboard(""));
  render();
  refresh();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[K.state]) state = { ...DEFAULT_STATE, ...(changes[K.state].newValue || {}) };
    if (changes[K.spend]) spend = changes[K.spend].newValue || null;
    if (changes[K.settings]) getSettings().then((x) => { settings = x; setTz(x.timezone); render(); });
    if (changes[K.state] || changes[K.spend]) render();
  });
  setInterval(refresh, 5000);
}

init().catch((e) => {
  console.error("[ScoreX popup] init failed", e);
  document.body.appendChild(h("p", { class: "muted small", style: "padding:12px" }, "ScoreX could not load: " + ((e && e.message) || e)));
});
