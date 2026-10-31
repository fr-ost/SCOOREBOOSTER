// ScoreX popup (360 px): status + why line, ONE primary engine button (+ Stop), a red safety-stop block whose primary
// button opens the dashboard's "Review stop…" dialog (#overview?resume=1, never a one-click resume), 24 h posted with
// a mini rhythm strip (#pQuota), follow-backs 7 d + your primary score, review next with Approve / Skip (#pPending),
// "This profile" for the active x.com tab, costs, health square, risk chip, replies waiting for you, and
// Open dashboard (focuses an existing dashboard tab through chrome.runtime.getContexts before opening a new one).

import { K, MODE, STATUS, STOP_LABEL, HS, HARD } from "../lib/constants.js";
import { getSettings, DEFAULT_STATE } from "../lib/store.js";
import { budgetStatus } from "../lib/costs.js";
import { dailyLimit } from "../lib/safety.js";
import { dayKey, num, DAY, HOUR } from "../lib/util.js";
import { weightedLength } from "../lib/quality.js";
import { followStatus, FS } from "../lib/targets.js";
import * as history from "../lib/history.js";
import {
  h, btn, busy, send, toast, icon, statusInfo, primaryAction, isSafetyStop, fig, fmtUsd, fmtAgo, fmtTime, fmtIn, fmtNum,
  setTz, fill, clear, delta, expiryChip, followBadge, tierBadge, riskChip, healthCheck, healthLabel, diagSquare,
  providerKey, providerName, enabledProviders, primaryProvider, historyDelta, confirmDialog, truncate,
} from "./components.js";
import { responsive, rhythm, rhythmFrom, miniBars, stepLine, vizClass } from "./charts.js";

let settings = null;
let state = { ...DEFAULT_STATE };
let status = null;
const data = { spend: null, targets: {}, board: {}, convos: null, blacklist: {}, secretsRev: null };
let pending = [];
let queued = 0;
let recent = [];
let profile = null; // { handle } from the active x.com tab
let profileCheck = null; // last scoreCheck answer for that handle
let health = null;

const $ = (id) => document.getElementById(id);

// Requests still running, by key. render() rebuilds every button on each storage change and every 5 s, so the busy
// state lives here, not on the button: a rebuilt button stays disabled until its request has answered.
const inflight = new Set();
function track(key, button, fn) {
  if (inflight.has(key)) return Promise.resolve();
  inflight.add(key);
  return busy(button, fn).finally(() => { inflight.delete(key); render(); });
}
const held = (key, button) => { if (inflight.has(key)) { button.disabled = true; button.classList.add("is-busy"); } return button; };

// ---------------------------------------------------------------- dashboard tab

async function openDashboard(hash) {
  const base = chrome.runtime.getURL("ui/dashboard.html");
  const url = base + (hash ? "#" + hash : "");
  const done = () => { try { window.close(); } catch (_) { /* not a popup */ } };
  try {
    if (chrome.runtime.getContexts) {
      const ctxs = await chrome.runtime.getContexts({ contextTypes: ["TAB"] });
      const hit = (ctxs || []).find((c) => typeof c.documentUrl === "string" && c.documentUrl.startsWith(base) && c.tabId >= 0);
      if (hit) {
        await chrome.tabs.update(hit.tabId, hash ? { active: true, url } : { active: true });
        if (hit.windowId >= 0 && chrome.windows) await chrome.windows.update(hit.windowId, { focused: true }).catch(() => {});
        done();
        return;
      }
    }
  } catch (_) { /* fall back to a new tab */ }
  try { await chrome.tabs.create({ url }); done(); } catch (_) { location.href = url; }
}

// ---------------------------------------------------------------- "This profile"

// x.com paths that are not profiles.
const RESERVED = new Set(["home", "explore", "notifications", "messages", "search", "settings", "i", "compose", "login", "logout", "signup",
  "tos", "privacy", "hashtag", "lists", "bookmarks", "communities", "premium", "premium_sign_up", "jobs", "account", "intent", "share",
  "who_to_follow", "topics", "download", "about", "help", "verified-choose", "x", "twitter", "search-advanced", "flow", "oauth", "display",
  "keyboard_shortcuts", "grok", "spaces", "follower_requests", "connect_people", "your_twitter_data", "rules", "safety", "en", "ja"]);
const PROFILE_SUBPATHS = new Set(["status", "with_replies", "media", "likes", "highlights", "articles", "followers", "following", "verified_followers", "photo", "header_photo", "superfollows"]);
export function profileFromUrl(url) {
  let u;
  try { u = new URL(url); } catch (_) { return null; }
  if (u.protocol !== "https:" || !/^(www\.|mobile\.)?x\.com$/.test(u.hostname)) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (!parts.length) return null;
  const hd = parts[0];
  if (!/^[A-Za-z0-9_]{1,15}$/.test(hd) || RESERVED.has(hd.toLowerCase())) return null;
  if (parts.length > 1 && !PROFILE_SUBPATHS.has(parts[1])) return null;
  return hd.toLowerCase();
}
async function detectProfile() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const hd = tab && tab.url ? profileFromUrl(tab.url) : null;
    profile = hd ? { handle: hd } : null;
  } catch (_) { profile = null; }
}

// ---------------------------------------------------------------- render

const me = () => String((settings && settings.account && settings.account.handle) || "").replace(/^@+/, "").toLowerCase();

function render() {
  if (!settings) return;
  const focusId = document.activeElement && document.activeElement.id;
  renderHead();
  renderStatus();
  renderControls();
  renderConvos();
  renderQuota();
  renderGrowth();
  renderReview();
  renderProfile();
  renderCosts();
  if (focusId && document.activeElement === document.body) { const el = $(focusId); if (el && !el.disabled) el.focus({ preventScroll: true }); }
}

function renderHead() {
  const eff = settings.mode === MODE.AUTO ? MODE.AUTO : MODE.REVIEW; // the saved settings (getStatus can lag a change)
  const modeEl = $("pMode");
  modeEl.textContent = eff === MODE.AUTO ? "Auto" : "Review";
  modeEl.classList.toggle("tag-solid", eff === MODE.AUTO);
  modeEl.classList.toggle("is-auto", eff === MODE.AUTO);
  modeEl.title = eff === MODE.AUTO ? "Full auto: posts on its own within your safety limits" : "Review: you approve every comment";
  const lvl = health ? health.level : null;
  const label = healthLabel(health);
  fill($("pHealthSlot"), h("button", { type: "button", class: "p-icon-btn", id: "pHealth", title: [label, ...(health ? health.issues.map((i) => "- " + i.text) : []), "Open Diagnostics"].join("\n"), "aria-label": label + ". Open Diagnostics.", onClick: () => openDashboard("diagnostics") },
    diagSquare(lvl === "fail" ? "fail" : lvl === "warn" ? "warn" : lvl === "ok" ? "pass" : "skip", label)));
  const risk = status && status.risk && status.risk.level ? status.risk : null;
  fill($("pRiskSlot"), risk ? h("button", { type: "button", class: "p-icon-btn", id: "pRisk", onClick: () => openDashboard("safety") }, riskChip(risk, { href: null })) : null);
}

function whyLines() {
  const lines = [];
  const now = Date.now();
  const t = (ts) => h("span", { class: "tnum" }, fmtTime(ts));
  const last = state.lastTickAt ? ` · last check ${fmtAgo(state.lastTickAt)}` : "";
  if (state.status === STATUS.RUNNING) {
    const ah = status && status.activeHours;
    const w = status && status.watch;
    if (ah && ah.inside === false) lines.push(["Sleeping until ", t(ah.opensAt), " (outside active hours)"]);
    else if (state.breakUntil && state.breakUntil > now) lines.push(["On a break until ", t(state.breakUntil), last]);
    else if (state.nextCommentAt && state.nextCommentAt > now) lines.push(["Next comment ", t(state.nextCommentAt), ` (${fmtIn(state.nextCommentAt).replace(/^in /, "")})`, last]);
    else if (state.nextTickAt) lines.push([`Next check ${fmtIn(state.nextTickAt)}`, last]);
    const sub = (status && status.sub) || "";
    if (state.nextTickWhy === "X page-load budget reached - waiting") lines.push(["X page-load budget reached: waiting, never stopping"]);
    else if (w && w.slow) lines.push([/^Watching slowly/.test(sub) ? sub : `Watching slowly: nothing new in ${w.emptyStreak || "several"} checks${w.intervalSec ? `, every ${Math.round(w.intervalSec / 60)} min now` : ""}`]);
  } else if (!isSafetyStop(state)) {
    if (state.status === STATUS.PAUSED) lines.push(["Nothing is generated or posted", last]);
    else lines.push([state.lastTickAt ? `Stopped. Last check ${fmtAgo(state.lastTickAt)}.` : "Press Start to begin."]);
  }
  return lines.map((parts) => h("div", { class: "p-sub" }, parts));
}

function renderStatus() {
  const info = statusInfo(state);
  const box = $("pStatusBox");
  fill(box, h("div", { class: ["big-status", "is-" + info.kind], id: "pStatus" }, h("span", { class: "dot", "aria-hidden": "true" }), h("span", null, info.label)), ...whyLines());
  box.dataset.kind = info.kind;
  const alertEl = $("pAlert");
  const safety = isSafetyStop(state);
  alertEl.hidden = !safety;
  if (safety) {
    const al = state.alert || {};
    const reason = al.reason || state.stopReason;
    const at = al.at || state.stoppedAt;
    const detail = String(al.detail || state.stopDetail || "").trim();
    fill(alertEl,
      h("strong", null, STOP_LABEL[reason] || reason || "Safety stop"),
      detail ? h("div", { class: "p-alert-detail" }, truncate(detail, 220)) : null,
      h("div", { class: "p-alert-time" }, `${at ? fmtAgo(at) + ". " : ""}Check your X account, then review the stop in the dashboard.`));
  }
}

function renderControls() {
  const act = (label, msg, iconName, kind, extra = {}) => held("engine", btn(label, (e) => {
    track("engine", e.currentTarget, async () => { const r = await send(msg, {}, { label }); if (r) { toast(`${label}: done`, { type: "success" }); refresh(); } });
  }, { kind, iconName, id: "p-" + msg, ...extra }));
  const [label, msg, ic] = primaryAction(state);
  const primary = msg === "reviewStop"
    ? btn(label, () => openDashboard("overview?resume=1"), { kind: "primary", iconName: ic, id: "p-reviewStop", title: "Opens the dashboard: see why ScoreX stopped, check your account, then resume" })
    : act(label, msg, ic, "primary");
  const canStop = state.status === STATUS.RUNNING || state.status === STATUS.PAUSED;
  fill($("pControls"), primary, act("Stop", "stop", "stop", "quiet", { disabled: !canStop, title: canStop ? "Stop the engine" : "Already stopped" }));
}

function renderConvos() {
  const items = (data.convos && Array.isArray(data.convos.items) ? data.convos.items : []).filter((x) => x && !x.done);
  const slot = $("pConvosSlot");
  if (!items.length) { clear(slot); return; }
  const newest = items.slice().sort((a, b) => (b.at || 0) - (a.at || 0))[0];
  fill(slot, h("button", { type: "button", class: "p-row p-convos", id: "pConvos", title: "Answer them yourself: open Today", onClick: () => openDashboard("overview") },
    icon("reply"),
    h("span", { class: "p-row-label" }, `${items.length} ${items.length === 1 ? "reply" : "replies"} waiting for you`),
    newest && newest.target ? h("span", { class: "p-row-sub" }, "@" + newest.target) : null,
    icon("chevron")));
}

function quotaSub(td, fo) {
  const parts = [`${num(td.generated)} generated`];
  if (num(td.failed)) parts.push(`${num(td.failed)} failed`);
  if (fo) {
    parts.push(`${num(fo.active)} commenting`);
    if (num(fo.checking)) parts.push(`${num(fo.checking)} checking`);
  }
  return parts.map((x) => x.replace(/ /g, " ")).join(" · "); // wrap only between items
}
function renderQuota() {
  const td = (status && status.today) || {};
  const limit = td.limit != null ? td.limit : dailyLimit(settings, state);
  const now = Date.now();
  const postedTs = recent.filter((r) => r.status === HS.POSTED && r.postedAt).map((r) => r.postedAt);
  const failedTs = recent.filter((r) => r.status === HS.FAILED).map((r) => r.updatedAt || r.createdAt);
  const posted = td.posted != null ? num(td.posted) : postedTs.filter((x) => x > now - 24 * HOUR).length;
  const breaks = state.breakUntil && state.breakUntil > now - 18 * HOUR ? [[state.lastCommentAt || state.breakUntil - 10 * 60000, state.breakUntil]] : [];
  const data24 = rhythmFrom({ now, posts: postedTs, fails: failedTs, breaks, next: state.status === STATUS.RUNNING ? state.nextCommentAt : null, activeHours: settings.safety.activeHours, tz: settings.timezone, labels: 2, endLabel: "+6 h" });
  fill($("pQuota"),
    h("div", { class: "p-quota-head" },
      h("span", { class: "cap" }, "Posted · 24 h"),
      h("span", { class: "p-quota-num" }, h("span", { id: "pPosted" }, String(posted)), h("span", { class: "fig-of" }, ` / ${limit}`))),
    responsive((w) => rhythm(data24, { w, h: 40 }), { initialWidth: 328 }),
    h("span", { class: "p-quota-sub", id: "pQuotaSub" }, quotaSub(td, status && status.follow)));
}

function renderGrowth() {
  const now = Date.now(), tz = settings.timezone;
  const fbAt = Object.values(data.targets || {}).map((t) => t && t.rel && t.rel.followedBackAt).filter(Boolean);
  const fb7 = fbAt.filter((x) => x > now - 7 * DAY).length;
  const fbPrev = fbAt.filter((x) => x <= now - 7 * DAY && x > now - 14 * DAY).length;
  const keys = [];
  for (let i = 13; i >= 0; i--) keys.push(dayKey(now - i * DAY, tz));
  const per = keys.map((k) => fbAt.filter((x) => dayKey(x, tz) === k).length);
  const fbCell = h("div", { class: "p-cell" },
    h("span", { class: "cap" }, "Follow-backs 7d"),
    h("div", { class: "fig-row" }, h("span", { class: "fig-value", id: "pFb7" }, String(fb7)), miniBars(per, { w: 70, h: 20, label: `Follow-backs per day, last 14 days: ${per.join(", ")}` })),
    h("div", { class: "fig-sub" }, delta(fb7 - fbPrev, { title: "Change vs the 7 days before" })));
  const pid = primaryProvider(settings, data.board);
  let scoreCell;
  if (!pid) {
    scoreCell = h("div", { class: "p-cell" }, h("span", { class: "cap" }, "Your score"),
      h("span", { class: "fig-value muted" }, "-"),
      h("button", { type: "button", class: "linkish small", id: "pConnectScores", onClick: () => openDashboard("scores") }, "Connect a score site"));
  } else {
    const own = (data.board.own || {})[pid] || null;
    const hist = (own && own.history) || [];
    const d7 = historyDelta(hist, 7);
    scoreCell = h("div", { class: "p-cell", title: own && own.at ? `${providerName(pid)} · updated ${fmtAgo(own.at)}` : providerName(pid) },
      h("span", { class: "cap" }, providerKey(pid), providerName(pid)),
      h("div", { class: "fig-row" }, h("span", { class: "fig-value", id: "pScore" }, own && own.score != null ? fmtNum(own.score) : "-"),
        hist.length > 1 ? stepLine(hist.slice(-30).map((x) => x.s), { w: 70, h: 20, cls: vizClass(pid), label: `${providerName(pid)}, last ${Math.min(30, hist.length)} days` }) : null),
      h("div", { class: "fig-sub" }, own && own.error && !own.score ? h("span", { class: "text-red" }, "check failed") : delta(d7, { suffix: "7d" })));
  }
  fill($("pGrowth"), fbCell, scoreCell);
}

function renderReview() {
  const max = (settings.review && settings.review.pendingMaxAgeMin) || 180;
  const sorted = pending.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); // expiring first
  const next = sorted[0];
  const head = h("button", { type: "button", class: ["p-review-head", pending.length && "has-items"], id: "pPending", title: "Open the Review queue", onClick: () => openDashboard("review") },
    h("span", { class: "cap" }, "Review next"),
    h("span", { class: "count p-cell-value" }, String(pending.length)),
    h("span", { class: "p-spacer" }),
    next ? expiryChip(next.createdAt, max) : null,
    icon("chevron"));
  let body;
  if (!next) {
    body = h("p", { class: "small muted" }, queued ? `Nothing to review. ${queued} approved, waiting for their slot.` : "Nothing waiting for review.");
  } else {
    const t = data.targets[next.target];
    const fs = t ? followStatus(t) : null;
    const followsNow = fs === FS.FOLLOWS || fs === FS.FOLLOWED_BACK;
    const quick = (action, button) => track("rv:" + next.id, button, async () => {
      const text = action === "approve" ? String(next.comment || "").trim() : "";
      if (action === "approve" && !text) { toast("This reply is empty. Edit it in the queue.", { type: "warn" }); return; }
      if (action === "approve" && weightedLength(text) > HARD.maxCommentChars) { toast(`Too long for X (${HARD.maxCommentChars} max). Edit it in the queue.`, { type: "warn" }); return; }
      const r = await send("reviewAction", { id: next.id, action, text }, { label: action === "approve" ? "Approve" : "Skip" });
      if (r) { toast(action === "approve" ? `Approved @${next.target}: it posts in its own slot` : `Skipped @${next.target}`, { type: "success" }); await refresh(); }
    });
    body = h("div", { class: "p-rv" },
      h("div", { class: "p-rv-who" }, h("b", null, "@" + next.target), t ? tierBadge(t.tier) : null, next.postText ? h("span", { class: "muted p-rv-post" }, "“" + truncate(next.postText, 70) + "”") : null),
      h("div", { class: "p-rv-reply" }, next.comment || h("span", { class: "muted" }, "(empty)")),
      followsNow ? h("div", { class: "p-note" }, `@${next.target} follows you now, so this reply will be dropped.`) : null,
      h("div", { class: "p-rv-actions" },
        held("rv:" + next.id, btn("Approve", (e) => quick("approve", e.currentTarget), { kind: "primary", size: "xs", iconName: "check", id: "pApprove", disabled: followsNow, title: followsNow ? "Follows you now: replies are only for accounts that don't" : "Approve this text as is" })),
        held("rv:" + next.id, btn("Skip", (e) => quick("skip", e.currentTarget), { kind: "ghost", size: "xs", id: "pSkip", title: "Post nothing for this post" })),
        h("span", { class: "p-spacer" }),
        h("button", { type: "button", class: "linkish small", id: "pEditQueue", onClick: () => openDashboard("review") }, "Edit in queue")));
  }
  fill($("pPendingSlot"), head, body);
}

function renderProfile() {
  const el = $("pProfile");
  if (!profile) { el.hidden = true; clear(el); return; }
  el.hidden = false;
  const hd = profile.handle;
  const isMe = hd === me();
  const t = data.targets[hd] || null;
  const bl = data.blacklist && Object.hasOwn(data.blacklist, hd) ? data.blacklist[hd] : null;
  const checks = (data.board && data.board.checks) || {};
  const cached = Object.hasOwn(checks, hd) ? checks[hd] : null;
  const fresh = cached && cached.at && Date.now() - cached.at < DAY ? cached : null;
  const results = isMe
    ? Object.fromEntries(Object.entries((data.board && data.board.own) || {}).map(([id, o]) => [id, { score: o.score, max: o.max, error: o.score == null ? o.error : null }]))
    : profileCheck && profileCheck.handle === hd ? profileCheck.results : fresh ? fresh.results : null;
  const when = isMe ? null : profileCheck && profileCheck.handle === hd ? Date.now() : fresh ? fresh.at : null;
  const enabled = enabledProviders(settings);
  const scoreCells = results && Object.keys(results).length
    ? h("div", { class: "p-scores" }, Object.entries(results).map(([id, r]) => h("div", { class: "p-score" },
      h("span", { class: "cap" }, providerKey(id), providerName(id)),
      r && r.score != null ? h("span", { class: "p-score-v" }, fmtNum(r.score), r.max ? h("span", { class: "fig-of" }, ` / ${r.max}`) : null) : h("span", { class: "small muted", title: (r && r.error) || "" }, r && r.error ? "n/a" : "-"))))
    : h("p", { class: "small muted" }, enabled.length ? "No score check in the last 24 h." : "Connect a score site to see scores here.");
  const status = isMe ? h("span", { class: "small muted" }, "This is your profile")
    : bl ? h("span", { class: "hs hs-red" }, "On your blacklist")
    : t ? h("span", { class: "p-profile-status" }, tierBadge(t.tier), followBadge(t, settings))
    : h("span", { class: "small muted" }, "Not a target");
  const actions = [];
  if (!isMe) {
    actions.push(held("check:" + hd, btn("Check scores", (e) => track("check:" + hd, e.currentTarget, async () => {
      const r = await send("scoreCheck", { handle: hd }, { label: "Check scores" });
      if (r) profileCheck = { handle: hd, results: r.results || {} };
    }), { size: "xs", iconName: "refresh", id: "pCheck", disabled: !enabled.length, title: enabled.length ? `Uses 1 request per connected site (${enabled.map(providerName).join(", ")})` : "Turn on a score site in Scores first" })));
    if (!t && !bl) {
      for (const tier of [1, 2]) {
        actions.push(held("add:" + hd, btn(`Add as Tier ${tier}`, (e) => track("add:" + hd, e.currentTarget, async () => {
          const r = await send("targetsUpsert", { rows: [hd], defaults: { tier, source: "manual" } }, { label: "Add target" });
          if (r) toast(r.blacklisted ? `@${hd} is on your blacklist: skipped` : `Added @${hd} as Tier ${tier}`, { type: r.blacklisted ? "warn" : "success" });
        }), { size: "xs", iconName: tier === 1 ? "plus" : null, id: "pAddT" + tier, kind: tier === 1 ? "primary" : "" })));
      }
    }
    actions.push(btn("Smart followers", () => openDashboard("discover?h=" + encodeURIComponent(hd)), { size: "xs", iconName: "discover", id: "pSmart", title: "Open Discover with this account's smart followers" }));
    if (!bl) {
      actions.push(btn("Blacklist", async (e) => {
        const b = e.currentTarget;
        if (!(await confirmDialog(`ScoreX will never comment on @${hd} and never add it again${t ? " (it is removed from your targets)" : ""}.`, { title: `Blacklist @${hd}?`, okLabel: "Blacklist", danger: true }))) return;
        track("bl:" + hd, b, async () => { const r = await send("blacklistAdd", { handles: [hd] }, { label: "Blacklist" }); if (r) toast(`@${hd} is on your blacklist`, { type: "success" }); });
      }, { size: "xs", kind: "danger-soft", id: "pBlacklist" }));
      held("bl:" + hd, actions[actions.length - 1]);
    }
  }
  fill(el,
    h("div", { class: "p-profile-head" },
      h("span", { class: "cap" }, "This profile"),
      h("a", { href: "https://x.com/" + encodeURIComponent(hd), target: "_blank", rel: "noopener noreferrer", class: "handle" }, "@" + hd),
      h("span", { class: "p-spacer" }),
      when ? h("span", { class: "small muted" }, fmtAgo(when)) : null),
    status,
    scoreCells,
    actions.length ? h("div", { class: "p-profile-actions" }, actions) : null);
}

function renderCosts() {
  const td = (status && status.today) || {};
  const b = budgetStatus(settings, data.spend);
  const todayCost = Math.max(num(td.cost), num(data.spend && data.spend.days && data.spend.days[dayKey(Date.now(), settings.timezone)]));
  fill($("pCosts"),
    fig({ label: "Cost today", value: fmtUsd(todayCost) }),
    fig({ label: "This month", value: fmtUsd(b.spent), of: b.limit ? fmtUsd(b.limit, 0) : null, cls: b.reached ? "is-red" : b.warn ? "is-amber" : null, title: b.limit ? `${Math.round(b.pct)}% of budget` : "No monthly budget set" }));
}

// ---------------------------------------------------------------- data

async function loadHistory() {
  try {
    const now = Date.now();
    const [p, a, q, rec] = await Promise.all([history.byStatus(HS.PENDING_REVIEW), history.byStatus(HS.APPROVED), history.byStatus(HS.QUEUED), history.since(now - 26 * HOUR)]);
    pending = p; queued = a.length + q.length; recent = rec;
  } catch (_) { /* keep last */ }
}
async function refresh() {
  const r = await send("getStatus", {}, { quiet: true });
  status = r && r.status ? r.status : null;
  await loadHistory();
  render();
}
async function refreshHealth() {
  try { health = await healthCheck({ settings, state, secretsRev: data.secretsRev }); } catch (_) { health = null; }
  renderHead();
}

const KEYS = { [K.spend]: "spend", [K.targets]: "targets", [K.scoreboard]: "board", [K.conversations]: "convos", [K.blacklist]: "blacklist", [K.secretsRev]: "secretsRev" };

async function init() {
  const [s, stored] = await Promise.all([getSettings(), chrome.storage.local.get([K.state, ...Object.keys(KEYS)])]);
  settings = s;
  state = { ...DEFAULT_STATE, ...(stored[K.state] || {}) };
  for (const [k, name] of Object.entries(KEYS)) data[name] = stored[k] || (name === "targets" || name === "board" || name === "blacklist" ? {} : null);
  setTz(settings.timezone);
  $("pOpen").addEventListener("click", () => openDashboard(""));
  await Promise.all([loadHistory(), detectProfile()]);
  render();
  refresh();
  refreshHealth();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let dirty = false;
    if (changes[K.state]) { state = { ...DEFAULT_STATE, ...(changes[K.state].newValue || {}) }; dirty = true; refreshHealth(); }
    for (const [k, name] of Object.entries(KEYS)) if (changes[k]) { data[name] = changes[k].newValue || (name === "targets" || name === "board" || name === "blacklist" ? {} : null); dirty = true; }
    if (changes[K.secretsRev]) refreshHealth();
    if (changes[K.settings]) getSettings().then((x) => { settings = x; setTz(x.timezone); render(); refreshHealth(); });
    if (dirty) render();
  });
  setInterval(refresh, 5000);
}

init().catch((e) => {
  console.error("[ScoreX popup] init failed", e);
  document.body.appendChild(h("p", { class: "muted small", style: "padding:12px" }, "ScoreX could not load: " + ((e && e.message) || e)));
});
