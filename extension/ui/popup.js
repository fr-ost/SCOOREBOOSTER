// ScoreX popup: status, mode, today's numbers, pending review, costs, alert, engine controls.

import { K, MODE, STATUS, STOP_LABEL } from "../lib/constants.js";
import { getSettings, DEFAULT_STATE } from "../lib/store.js";
import { budgetStatus } from "../lib/costs.js";
import { warmup, dailyLimit } from "../lib/safety.js";
import { dayKey, num } from "../lib/util.js";
import * as history from "../lib/history.js";
import { h, btn, busy, send, toast, statusPill, statusInfo, fmtUsd, fmtAgo, fmtTime, fmtIn, setTz, fill } from "./components.js";

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
  const wu = (status && status.warmup) || warmup(state);
  const eff = (status && status.effectiveMode) || (settings.mode === MODE.AUTO && !wu.active ? MODE.AUTO : MODE.REVIEW);
  const modeEl = $("pMode");
  modeEl.textContent = eff === MODE.AUTO ? "Full auto" : settings.mode === MODE.AUTO ? "Review (warm-up)" : "Review mode";
  modeEl.classList.toggle("mode-auto", eff === MODE.AUTO);

  // status
  const box = $("pStatusBox");
  const lines = [];
  if (info.reason && state.status === STATUS.STOPPED) lines.push(h("div", { class: ["p-reason", info.kind === "danger" && "is-danger"] }, info.reason));
  if (state.status === STATUS.RUNNING) {
    const ah = status && status.activeHours;
    const now = Date.now();
    if (ah && ah.inside === false) lines.push(h("div", { class: "p-sub" }, `Sleeping until ${fmtTime(ah.opensAt)} (outside active hours)`));
    else if (state.breakUntil && state.breakUntil > now) lines.push(h("div", { class: "p-sub" }, `On a break until ${fmtTime(state.breakUntil)}`));
    else if (state.nextCommentAt && state.nextCommentAt > now) lines.push(h("div", { class: "p-sub" }, `Next comment allowed ${fmtIn(state.nextCommentAt)}`));
    if (state.nextTickAt) lines.push(h("div", { class: "p-sub" }, `Next check ${fmtIn(state.nextTickAt)}`));
  } else if (state.status === STATUS.PAUSED) lines.push(h("div", { class: "p-sub" }, "Paused - nothing is posted."));
  if (state.lastTickAt) lines.push(h("div", { class: "p-sub" }, `Last check ${fmtAgo(state.lastTickAt)}`));
  fill(box, statusPill(state, { large: true }), ...lines);
  box.id = "pStatusBox";
  box.dataset.kind = info.kind;

  // alert
  const al = state.alert;
  const alertEl = $("pAlert");
  alertEl.hidden = !al;
  if (al) fill(alertEl, h("strong", null, STOP_LABEL[al.reason] || al.reason || "Safety stop"), al.detail ? h("div", null, al.detail) : null, h("div", null, `${fmtAgo(al.at)} · check your X account, then resume from the dashboard.`));

  // numbers
  const t = (status && status.today) || {};
  const limit = t.limit != null ? t.limit : dailyLimit(settings, state);
  const b = budgetStatus(settings, spend);
  const todayCost = Math.max(num(t.cost), num(spend && spend.days && spend.days[dayKey(Date.now(), settings.timezone)]));
  const cell = (label, value, sub, opts = {}) => {
    const kids = [h("span", { class: "p-cell-label" }, label), h("span", { class: "p-cell-value", id: opts.valueId || null }, value), sub ? h("span", { class: "p-cell-sub" }, sub) : null];
    return opts.onClick
      ? h("button", { type: "button", class: ["p-cell", opts.cls], onClick: opts.onClick, title: opts.title || null, id: opts.id || null }, kids)
      : h("div", { class: ["p-cell", opts.cls], id: opts.id || null }, kids);
  };
  fill($("pGrid"), 
    cell("Posted (24h)", [String(t.posted != null ? t.posted : "-"), h("span", { class: "stat-of" }, ` / ${limit}`)], `A ${num(t.postedGroup && t.postedGroup.A)} · B ${num(t.postedGroup && t.postedGroup.B)}`, { valueId: "pPosted" }),
    cell("Pending review", String(pending), queued ? `${queued} waiting to post` : "Open the queue", { onClick: () => openDashboard("review"), cls: pending ? "is-amber" : "", title: "Open the Review queue", id: "pPending" }),
    cell("Cost today", fmtUsd(todayCost), `${num(t.generated)} generated`),
    cell("This month", b.limit ? [fmtUsd(b.spent), h("span", { class: "stat-of" }, ` / ${fmtUsd(b.limit, 0)}`)] : fmtUsd(b.spent), b.limit ? `${Math.round(b.pct)}% of budget` : "No limit set", { cls: b.reached ? "is-red" : b.warn ? "is-amber" : "" }));

  // controls
  const controls = $("pControls");
  const act = (label, msg, iconName, kind) => btn(label, (e) => {
    const bt = e.currentTarget;
    busy(bt, async () => { const r = await send(msg, {}, { label }); if (r) { toast(`${label}: done`, { type: "success" }); refresh(); } });
  }, { kind, iconName, id: "p-" + msg });
  const kids = [];
  if (state.status === STATUS.RUNNING) kids.push(act("Pause", "pause", "pause"), act("Stop", "stop", "stop"));
  else if (state.status === STATUS.PAUSED) kids.push(act("Resume", "resume", "play", "primary"), act("Stop", "stop", "stop"));
  else kids.push(act(al ? "Resume" : "Start", al ? "resume" : "start", "play", "primary"));
  fill(controls, ...kids);
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
