// Scores (#scores): your scores per score site ("My scores" ledger), the score history chart with the follow-back
// event track, "Follow-backs that count", "Check any account", target score coverage (+ refresh job), and the
// provider setup (enable with Chrome's permission prompt, mode, API key, daily request cap, test, Sorsa blend,
// automatic refresh, provider overrides JSON).
// Data: scoresState -> { providers: [P], board } (lib/scoreboard.js), sx.scoreboard (watched), sx.targets.
// Provider keys are secrets (secretField); the overrides JSON is written to sx.providerOverrides (validated object).
// Route params: #scores?view=providers opens the setup section, #scores?h=<handle> runs a score check.

import { K, ALARM } from "../../lib/constants.js";
import { providerDefs, pickMode, modeNeeds } from "../../lib/providers.js";
import { normalizeHandle, num, dayKey } from "../../lib/util.js";
import {
  h, clear, fill, add, section, advanced, btn, busy, toast, tag, statusSquare, providerKey, providerName, primaryProvider,
  historyDelta, delta, segmented, toggleEl, selectEl, renderTable, progressBar, confirmDialog, link, xLink, fmtAgo,
  fmtDay, fmtTime, fmtNum, fmtCount, debounce,
} from "../components.js";
import { responsive, spark, scoreHistory, coverageBar, vizIndex, vizClass, fmtShort } from "../charts.js";
import { secretField } from "./models.js";

const DAY = 864e5;
const STALE_MS = 7 * DAY; // lib/scoreboard.js TARGET_SCORE_MAX_AGE
const OWN_FRESH_MS = 20 * 36e5; // refreshOwn skips a score younger than this unless forced
export const MODE_TAG = { api: "API key", public: "Public page", page: "Page mode" };
export const MODE_NAME = { auto: "Auto (best available)", api: "API with your key", public: "Public page (no key)", page: "Browser tab (your Chrome reads the site)" };
const RANGES = [["30", "30 d"], ["90", "90 d"], ["365", "1 y"]];

const lsGet = (k, d) => { try { const v = window.localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } };
const lsSet = (k, v) => { try { window.localStorage.setItem(k, v); } catch (_) { /* storage blocked */ } };
const errText = (e) => String((e && e.message) || e || "error").replace(/^Error:\s*/, "");
const hostsOf = (need) => (need.origins || []).map((o) => String(o).replace(/^https:\/\/(\*\.)?/, "").replace(/\/\*$/, "")).join(", ") || "the site";
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const btnLabel = (b) => b.querySelector(":scope > span:not(.icon)") || b.appendChild(document.createElement("span"));

// ---------------------------------------------------------------- shared provider helpers (also used by Discover)

// Ready state of one provider P (scoresState): { kind: off | key | access | error | cap | ready, label }.
export function readiness(p) {
  if (!p || !p.enabled) return { kind: "off", label: "Off" };
  if (!p.mode) return { kind: "key", label: p.keyName ? "Needs your API key" : "No usable mode" };
  if (!p.granted) return { kind: "access", label: "Chrome access not granted" };
  if (p.own && p.own.error) return { kind: "error", label: p.own.error };
  const u = p.usage || {};
  if (u.cap && num(u.today) >= num(u.cap)) return { kind: "cap", label: "Daily request cap reached" };
  return { kind: "ready", label: "Ready" };
}
export const READY_SQUARE = { off: "grey", key: "amber", access: "amber", error: "red", cap: "amber", ready: "green" };
export const usageLeft = (p) => Math.max(0, num(p && p.usage && p.usage.cap) - num(p && p.usage && p.usage.today));
export function profileUrl(p, handle) {
  if (!p || !p.profileUrl || !handle) return "";
  return p.profileUrl.replace(/\{handle\}/g, encodeURIComponent(handle));
}
export function tierLabel(p, score) {
  if (!p || !Array.isArray(p.tiers) || score == null) return "";
  const t = p.tiers.slice().sort((a, b) => b[0] - a[0]).find((x) => Number(score) >= Number(x[0]));
  return t ? String(t[1]) : "";
}
// Permissions a provider needs for a mode preference (the mode it would use; the API mode once a key is added).
export function needsFor(defs, p, pref) {
  const def = defs && defs[p.id];
  if (!def) return p.needs || { origins: [], permissions: [] };
  const modes = def.modes || {};
  const mode = pickMode(def, pref || p.modePref || "auto", !!p.hasKey) || (modes.api ? "api" : Object.keys(modes)[0]);
  return mode ? modeNeeds(def, mode) : { origins: [], permissions: [] };
}
// Chrome's permission prompt. MUST be called synchronously inside a click / change handler (user gesture).
export function requestAccess(need) {
  const origins = (need && need.origins) || [], permissions = (need && need.permissions) || [];
  if (!origins.length && !permissions.length) return Promise.resolve(true);
  try { return Promise.resolve(chrome.permissions.request({ origins, permissions })); } catch (e) { return Promise.reject(e); }
}
// Turn a provider on: permission prompt first (sync, inside the gesture), then save. Resolves true when on.
export function connectProvider(ctx, defs, p, { input = null, after } = {}) {
  const need = needsFor(defs, p);
  return requestAccess(need).then(async (ok) => {
    if (!ok) {
      if (input) input.checked = false;
      toast(`${p.name} stays off: Chrome access to ${hostsOf(need)} was not granted.`, { type: "warn" });
      return false;
    }
    const saved = await ctx.save((d) => { d.providers = d.providers || {}; d.providers[p.id] = { ...(d.providers[p.id] || {}), enabled: true }; });
    if (!saved) { if (input) input.checked = false; return false; }
    const def = defs && defs[p.id];
    const needsKey = p.keyName && !p.hasKey && def && !def.modes.public && !def.modes.page;
    toast(needsKey ? `${p.name} is on. Add your ${p.name} API key to use it.` : `${p.name} is on`, { type: "success" });
    if (after) after();
    return true;
  }, (e) => {
    if (input) input.checked = false;
    toast("Permission request failed: " + errText(e), { type: "error" });
    return false;
  });
}

// Daily step values over date keys from a history [{ d, s }]: the last value on or before each day, null before the first.
function stepValues(hist, keys) {
  const list = (Array.isArray(hist) ? hist : []).filter((x) => x && x.d && Number.isFinite(Number(x.s))).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  const out = [];
  let j = 0, cur = null;
  for (const k of keys) {
    while (j < list.length && list[j].d <= k) { cur = Number(list[j].s); j++; }
    out.push(cur);
  }
  return out;
}
function dayKeys(days, tz) {
  const now = Date.now(), seen = new Set(), keys = [];
  for (let i = days - 1; i >= 0; i--) { const k = dayKey(now - i * DAY, tz); if (!seen.has(k)) { seen.add(k); keys.push(k); } }
  return keys;
}
const keyTs = (k) => Date.parse(k + "T12:00:00Z");
// The chart labels the 3 highest-score follow-backs; drop a label that would overlap a higher-score one nearby.
function declutter(svg, events) {
  const weight = new Map(events.map((e) => [e.short, Number(e.weight) || 0]));
  const labels = [...svg.querySelectorAll("text.ev-label")].sort((a, b) => (weight.get(b.textContent) || 0) - (weight.get(a.textContent) || 0));
  const kept = [];
  for (const t of labels) {
    const x = Number(t.getAttribute("x")), y = Number(t.getAttribute("y")), wd = t.textContent.length * 6.4 + 6;
    const box = t.getAttribute("text-anchor") === "end" ? [x - wd, x] : [x, x + wd];
    if (kept.some((k) => box[0] < k.box[1] && k.box[0] < box[1] && Math.abs(k.y - y) < 12)) t.remove();
    else kept.push({ box, y });
  }
  return svg;
}
const tScore = (t, pid) => { const v = t && t.score && t.score.providers && t.score.providers[pid]; return v && v.score != null && Number.isFinite(Number(v.score)) ? Number(v.score) : null; };

export default {
  id: "scores",
  title: "Scores",
  hint: "Your scores on Sorsa, TwitterScore, Ethos and Moni, and the follow-backs that move them.",
  async render(root, ctx) {
    let st = { providers: [], board: {} };
    let defs = providerDefs(null);
    let lastCheck = null; // { handle, results, at, used }
    let jobProvider = "";
    let range = ["30", "90", "365"].includes(lsGet("sx.scores.range", "90")) ? lsGet("sx.scores.range", "90") : "90";
    let indexed = lsGet("sx.scores.indexed", "1") !== "0";
    let hidden = new Set();
    try { hidden = new Set(JSON.parse(lsGet("sx.scores.hidden", "[]")) || []); } catch (_) { hidden = new Set(); }

    const board = () => ctx.data[K.scoreboard] || st.board || {};
    const me = () => normalizeHandle(ctx.settings.account && ctx.settings.account.handle);
    const on = () => st.providers.filter((p) => p.enabled);
    const scoreProviders = () => on().filter((p) => !p.caps || p.caps.score !== false);

    async function loadOverrides() {
      try {
        const r = await chrome.storage.local.get(K.providerOverrides);
        const v = r[K.providerOverrides];
        defs = providerDefs(v && typeof v === "object" ? v : null);
        return v && typeof v === "object" ? v : null;
      } catch (_) { return null; }
    }
    async function reload() {
      const r = await ctx.send("scoresState", {}, { quiet: true });
      if (r && Array.isArray(r.providers)) st = { providers: r.providers, board: r.board || {} };
      drawAll();
    }
    const reloadSoon = debounce(() => { if (root.isConnected) reload(); }, 250);

    // ------------------------------------------------ header: refresh info + Refresh now
    const infoEl = h("span", { class: "small muted", id: "scoresRefreshInfo" });
    const refreshBtn = btn("Refresh now", null, { iconName: "refresh", id: "refreshOwnBtn" });
    const refreshWhy = h("span", { class: "small muted", id: "refreshOwnWhy" });
    refreshBtn.addEventListener("click", () => busy(refreshBtn, async () => {
      const r = await ctx.send("scoresRefreshOwn", { force: true }, { label: "Refresh scores" });
      if (!r) return;
      const res = Object.entries(r.results || {});
      const ok = res.filter(([, x]) => x && x.ok).length;
      const bad = res.filter(([, x]) => x && !x.ok);
      if (bad.length) toast(bad.map(([id, x]) => `${providerName(id)}: ${x.message || x.error || "error"}`).join(" · "), { type: "warn" });
      else toast(ok ? `Updated ${plural(ok, "score")}` : "Nothing to refresh", { type: ok ? "success" : "info" });
      reload();
    }));
    const head = h("div", { class: "filterbar scores-head" }, infoEl, h("span", { class: "spacer" }), refreshWhy, refreshBtn);

    async function nextRefreshAt() {
      const list = scoreProviders().filter((p) => readiness(p).kind === "ready" || readiness(p).kind === "error");
      if (!list.length || !ctx.settings.scores.autoRefreshOwn) return null;
      let due = Math.min(...list.map((p) => (p.own && p.own.at ? p.own.at + OWN_FRESH_MS : Date.now())));
      try {
        const a = await chrome.alarms.get(ALARM.SCORES);
        if (a && a.scheduledTime) {
          let t = a.scheduledTime;
          const period = (a.periodInMinutes || 240) * 60000;
          while (t < due && period > 0) t += period;
          due = t;
        }
      } catch (_) { /* alarms unavailable */ }
      return due;
    }
    async function drawHead() {
      const list = scoreProviders();
      const ready = list.filter((p) => readiness(p).kind === "ready" || readiness(p).kind === "error");
      const n = ready.length;
      let why = "";
      if (!me()) why = "Set your X handle first (Settings).";
      else if (!on().length) why = "Turn on a score site below first.";
      else if (!list.some((p) => p.mode && p.granted)) why = "No connected site is ready yet (API key or Chrome access missing).";
      else if (!n) why = "Every daily request cap is used. Caps reset at midnight.";
      btnLabel(refreshBtn).textContent = n ? `Refresh now · ${plural(n, "request")}` : "Refresh now";
      refreshBtn.disabled = !!why;
      refreshBtn.title = why || `Ask ${ready.map((p) => p.name).join(", ")} for your score now (1 request each)`;
      refreshWhy.textContent = why;
      const auto = ctx.settings.scores.autoRefreshOwn;
      const next = auto ? await nextRefreshAt() : null;
      infoEl.textContent = !on().length
        ? "Connect a score site to follow your scores here. Each site gets only X handles, never your posts or keys of other sites."
        : auto
          ? `Your scores refresh about once a day${next ? ` (next ${next - Date.now() < 20 * 36e5 ? fmtTime(next) : fmtDay(next) + " " + fmtTime(next)})` : ""}. A refresh costs 1 request per connected site.`
          : "Automatic refresh is off (Providers below). A refresh costs 1 request per connected site.";
    }

    // ------------------------------------------------ My scores
    const cellsHost = h("div", { class: "panel pcells", id: "myScores", role: "group", "aria-label": "My scores" });
    function openRow(id, focusSel) {
      provAdv.open = true;
      const row = provHost.querySelector(`[data-provider="${id}"]`);
      if (!row) return;
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      const el = (focusSel && row.querySelector(focusSel)) || row.querySelector("input, select, button");
      if (el) setTimeout(() => el.focus({ preventScroll: true }), 250);
    }
    function refreshOne(p, b) {
      busy(b, async () => {
        const r = await ctx.send("scoresRefreshOwn", { force: true, only: [p.id] }, { label: `${p.name} refresh` });
        const x = r && r.results && r.results[p.id];
        if (x && !x.ok) toast(`${p.name}: ${x.message || x.error || "error"}`, { type: "warn" });
        reload();
      });
    }
    function allowAccess(p) {
      const need = needsFor(defs, p);
      requestAccess(need).then((ok) => {
        if (!ok) { toast(`${p.name}: Chrome access to ${hostsOf(need)} was not granted.`, { type: "warn" }); return; }
        toast(`${p.name} can now be reached`, { type: "success" });
        reload();
      }, (e) => toast("Permission request failed: " + errText(e), { type: "error" }));
    }
    function scoreCell(p) {
      const own = p.own || {};
      const r = readiness(p);
      if (!p.enabled) {
        return h("div", { class: "cell pcell off", dataset: { provider: p.id } },
          h("span", { class: "cap" }, providerKey(p.id), p.name),
          h("span", { class: "pcell-state" }, "Not connected"),
          h("div", { class: "fig-sub" }, "Off. Chrome asks for access to the site when you connect it."),
          h("div", null, btn("Connect", (e) => connectProvider(ctx, defs, p, { after: () => { reload(); openRow(p.id); } }), { size: "xs", title: `Turn on ${p.name}` + (p.about ? `: ${p.about}` : "") })));
      }
      const hasScore = own.score != null && Number.isFinite(Number(own.score));
      const hist = own.history || [];
      const keys = dayKeys(90, ctx.settings.timezone);
      const vals = stepValues(hist, keys);
      const max = own.max != null ? own.max : p.max;
      const d7 = historyDelta(hist, 7), d30 = historyDelta(hist, 30);
      const tl = tierLabel(p, own.score);
      const url = own.url || profileUrl(p, me());
      const left = usageLeft(p);
      const firstV = vals.find((v) => v != null), lastV = [...vals].reverse().find((v) => v != null);
      const chart = vals.some((v) => v != null)
        ? spark(vals, { w: 120, h: 34, step: true, cls: vizClass(p.id), label: `${p.name}, last 90 days: ${fmtNum(firstV)} to ${fmtNum(lastV)}` })
        : null;
      const kids = [
        h("span", { class: "cap pcell-cap" }, providerKey(p.id), p.name, p.mode ? tag(MODE_TAG[p.mode] || p.mode) : null),
        h("div", { class: "fig-row" }, h("span", { class: "fig-value" }, hasScore ? fmtNum(own.score) : "-"), chart ? h("span", { class: "fig-chart" }, chart) : null),
      ];
      if (hasScore && max) {
        const pct = Math.max(0, Math.min(100, (Number(own.score) / Number(max)) * 100));
        kids.push(h("div", { class: "pmeter", role: "meter", "aria-valuemin": "0", "aria-valuemax": String(max), "aria-valuenow": String(own.score), "aria-label": `${p.name} ${own.score} of ${max}`, title: `${fmtNum(own.score)} of ${fmtNum(max)}` }, h("i", { style: `width:${pct.toFixed(1)}%` })));
      }
      if (hasScore) {
        kids.push(h("div", { class: "fig-sub" },
          tl ? h("span", { class: "ptier", title: `${p.name} level` }, tl) : null,
          delta(d7, { suffix: "7d", title: "Change over 7 days" }), delta(d30, { suffix: "30d", title: "Change over 30 days" }),
          h("span", null, "updated " + fmtAgo(own.at))));
      }
      if (r.kind === "error") {
        kids.push(h("div", { class: "pcell-err" }, h("span", { class: "small text-red" }, String(own.error)), btn("Fix", () => openRow(p.id), { size: "xs", title: `Open the ${p.name} setup` })));
      } else if (r.kind === "key") {
        kids.push(h("div", { class: "pcell-msg" }, h("span", { class: "small" }, p.keyName ? `Add your ${p.name} API key to read your score.` : `${p.name} has no usable mode.`), btn("Add key", () => openRow(p.id, ".secret-field input, .secret-field button"), { size: "xs" })));
      } else if (r.kind === "access") {
        kids.push(h("div", { class: "pcell-msg" }, h("span", { class: "small" }, `Chrome access to ${hostsOf(needsFor(defs, p))} is not granted.`), btn("Allow access", () => allowAccess(p), { size: "xs" })));
      } else if (!hasScore) {
        kids.push(h("div", { class: "pcell-msg" }, h("span", { class: "small muted" }, me() ? "Not checked yet." : "Set your X handle in Settings first."),
          me() ? btn("Check now", (e) => refreshOne(p, e.currentTarget), { size: "xs", disabled: r.kind === "cap", title: "1 request" }) : link("#settings", "Settings", { external: false })));
      }
      kids.push(h("div", { class: "fig-sub" },
        h("span", null, p.mode === "api" || !p.mode ? `${left} of ${num(p.usage && p.usage.cap)} left today` : `no key needed · ${left} left today`),
        url ? link(url, "Open on site ↗", { cls: "ext-link" }) : null));
      return h("div", { class: ["cell", "pcell", r.kind === "error" && "is-error"], dataset: { provider: p.id } }, kids);
    }
    function drawCells() {
      const list = [...st.providers.filter((p) => p.enabled), ...st.providers.filter((p) => !p.enabled)];
      fill(cellsHost, h("div", { class: "panel-in" }, list.length ? list.map(scoreCell) : h("div", { class: "cell pcell off" }, h("span", { class: "pcell-state" }, "Loading score sites…"))));
    }

    // ------------------------------------------------ Score history
    const legendHost = h("div", { class: "legend score-legend", role: "group", "aria-label": "Providers shown in the chart" });
    const rangeSeg = segmented(RANGES, range, (v) => { range = v; lsSet("sx.scores.range", v); drawHistory(); }, { label: "Time range" });
    const modeSeg = segmented([["idx", "Indexed"], ["raw", "Raw"]], indexed ? "idx" : "raw", (v) => { indexed = v === "idx"; lsSet("sx.scores.indexed", indexed ? "1" : "0"); drawHistory(); }, { label: "Scale" });
    const chartHost = h("div", { class: "chart-host score-chart" });
    const chartNote = h("p", { class: "small muted", id: "scoreHistoryNote" });
    let chart = null;
    const histSec = section({ wide: true, id: "scoreHistory", title: "Score history", hint: "indexed: 100 = first day shown, so different scales compare", actions: h("div", { class: "filterbar" }, rangeSeg, modeSeg) },
      legendHost, chartHost, chartNote);
    const histHint = histSec.querySelector(".sec-hint");
    function drawHistory() {
      const days = Number(range) || 90;
      const tz = ctx.settings.timezone;
      const keys = dayKeys(days, tz);
      const own = board().own || {};
      const withHist = scoreProviders().filter((p) => (own[p.id] && Array.isArray(own[p.id].history) && own[p.id].history.length) || false);
      const visible = withHist.filter((p) => !hidden.has(p.id));
      const shown = visible.length ? visible : withHist;
      const rawOk = shown.length === 1;
      const useIndexed = indexed || !rawOk;
      const rawBtn = modeSeg.querySelector('[data-value="raw"]');
      if (rawBtn) { rawBtn.disabled = !rawOk; rawBtn.title = rawOk ? "Show the real score values" : "Raw values need one provider: pick one in the legend"; }
      modeSeg.set(useIndexed ? "idx" : "raw");
      if (histHint) histHint.textContent = useIndexed ? "indexed: 100 = first day shown, so different scales compare" : `raw ${shown[0] ? shown[0].name : ""} score`;
      // legend: one toggle per provider (latest value), then the follow-back key
      clear(legendHost);
      for (const p of withHist) {
        const o = own[p.id] || {};
        const isOn = !hidden.has(p.id) || !visible.length;
        add(legendHost, h("button", {
          type: "button", class: ["legend-btn", !isOn && "is-off"], "aria-pressed": String(isOn), title: isOn ? `Hide ${p.name}` : `Show ${p.name}`,
          onClick: () => {
            if (isOn && visible.length <= 1) { toast("At least one provider stays in the chart.", { type: "info" }); return; }
            if (isOn) hidden.add(p.id); else hidden.delete(p.id);
            lsSet("sx.scores.hidden", JSON.stringify([...hidden]));
            drawHistory();
          },
        }, providerKey(p.id), " " + p.name + " ", h("b", null, o.score != null ? fmtNum(o.score) : "-")));
      }
      const series = shown.map((p) => ({ name: p.name, color: vizIndex(p.id), values: stepValues(own[p.id].history, keys) }));
      // follow-back event track: targets that followed back inside the window, tick height = their provider score
      const pp = (shown.find((p) => p.id === primaryProvider(ctx.settings, board())) || shown[0] || scoreProviders()[0] || {}).id;
      const idx = new Map(keys.map((k, i) => [k, i]));
      const events = [];
      for (const t of ctx.targetList()) {
        const at = t.rel && t.rel.followedBackAt;
        if (!at) continue;
        const i = idx.get(dayKey(at, tz));
        if (i == null) continue;
        let sc = pp ? tScore(t, pp) : null, sp = pp;
        if (sc == null) for (const p of scoreProviders()) { const v = tScore(t, p.id); if (v != null) { sc = v; sp = p.id; break; } }
        events.push({ i, weight: sc || 0, label: `@${t.handle} followed back ${fmtDay(at)}${sc != null ? ` (${providerName(sp)} ${fmtNum(sc)})` : ""}`, short: "@" + t.handle });
      }
      if (events.length) add(legendHost, h("span", null, h("span", { class: "key key-signal" }), ` follow-backs (${events.length}, taller = higher-score account)`));
      const labels = keys.map((k) => fmtDay(keyTs(k)));
      const build = (w) => declutter(scoreHistory(series, events, { w, h: w < 520 ? 200 : 250, labels, indexed: useIndexed }), events);
      if (!chart) { chart = responsive(build, { initialWidth: 900, label: "Score history" }); chartHost.appendChild(chart); } else chart.update(build);
      chartNote.textContent = !scoreProviders().length
        ? "Connect a score site (Providers below) to start your score history."
        : !withHist.length ? "Your score history starts with the first refresh. ScoreX keeps one value per day." : "";
      chartNote.hidden = !chartNote.textContent;
    }

    // ------------------------------------------------ Follow-backs that count
    const fbHost = h("div", { id: "followBacksTable" });
    const fbSort = { key: "score", dir: "desc" };
    const fbSec = section({ wide: true, id: "followBacks", title: "Follow-backs that count", hint: "last 30 days, by their score" }, fbHost);
    function drawFollowBacks() {
      const since = Date.now() - 30 * DAY;
      const rows = ctx.targetList().filter((t) => t.rel && t.rel.followedBackAt && t.rel.followedBackAt >= since);
      // provider columns that score at least one of these accounts (else the first connected one)
      const all = scoreProviders();
      const scored = all.filter((p) => rows.some((t) => tScore(t, p.id) != null));
      const provs = scored.length ? scored : all.slice(0, 1);
      const pp = provs.some((p) => p.id === primaryProvider(ctx.settings, board())) ? primaryProvider(ctx.settings, board()) : provs[0] && provs[0].id;
      const cols = [
        { key: "handle", label: "Account", render: (t) => h("div", { class: "who" }, xLink(t.handle), t.profile && t.profile.name ? h("span", { class: "who-name" }, t.profile.name) : null), sort: (t) => t.handle, defaultDir: "asc" },
        { key: "at", label: "Followed back", render: (t) => h("span", { class: "mono small" }, fmtDay(t.rel.followedBackAt)), sort: (t) => t.rel.followedBackAt },
        ...provs.map((p) => ({ key: "p_" + p.id, label: h("span", { class: "th-prov" }, providerKey(p.id), p.name), align: "right", render: (t) => { const v = tScore(t, p.id); return v == null ? "-" : fmtNum(v); }, sort: (t) => tScore(t, p.id) })),
      ];
      if (!provs.length) cols.push({ key: "followers", label: "Followers", align: "right", render: (t) => fmtCount(t.profile && t.profile.followers), sort: (t) => t.profile && t.profile.followers });
      if (fbSort.key === "score") { fbSort.key = pp ? "p_" + pp : "at"; }
      clear(fbHost).appendChild(renderTable({
        columns: cols, rows, rowKey: (t) => t.handle, sortState: fbSort, maxRows: 8, caption: "Follow-backs that count",
        empty: "No follow-backs in the last 30 days yet. They show here with the account's score.",
      }));
    }

    // ------------------------------------------------ Check any account
    const checkInput = h("input", { class: "input", id: "scoreCheckInput", type: "text", placeholder: "@handle", autocomplete: "off", spellcheck: "false", "aria-label": "Account to check" });
    const checkBtn = btn("Check", null, { kind: "primary", id: "scoreCheckBtn" });
    const checkOut = h("div", { id: "scoreCheckResult", "aria-live": "polite" });
    const recentHost = h("div", { class: "recent-checks", id: "recentChecks" });
    async function runCheck(raw) {
      const hd = normalizeHandle(raw != null ? raw : checkInput.value);
      if (!hd) { toast("Enter an @handle to check.", { type: "warn" }); checkInput.focus(); return; }
      checkInput.value = "@" + hd;
      await busy(checkBtn, async () => {
        const r = await ctx.send("scoreCheck", { handle: hd }, { label: "Score check" });
        if (!r) return;
        lastCheck = { handle: r.handle || hd, results: r.results || {}, at: Date.now(), used: Object.keys(r.results || {}).length };
        drawCheck();
        reloadSoon();
      });
    }
    checkBtn.addEventListener("click", () => runCheck());
    checkInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runCheck(); } });
    function showCached(hd) {
      const c = (board().checks || {})[hd];
      if (!c) return;
      lastCheck = { handle: hd, results: c.results || {}, at: c.at, used: 0, cached: true };
      checkInput.value = "@" + hd;
      drawCheck();
    }
    function drawCheck() {
      clear(checkOut);
      if (lastCheck) {
        const { handle: hd, results } = lastCheck;
        const ids = Object.keys(results);
        const isTarget = Object.hasOwn(ctx.targets, hd);
        add(checkOut,
          h("div", { class: "panel check-cells" }, h("div", { class: "panel-in" },
            ids.length ? ids.map((id) => {
              const x = results[id] || {};
              const p = st.providers.find((q) => q.id === id) || { id, name: providerName(id) };
              return h("div", { class: "cell check-cell" },
                h("span", { class: "cap" }, providerKey(id), p.name),
                x.error ? h("span", { class: "small text-red" }, String(x.error)) : h("span", { class: "fig-value" }, x.score != null ? fmtNum(x.score) : "-", x.max ? h("span", { class: "fig-of" }, " / " + fmtNum(x.max)) : null),
                x.score != null && tierLabel(p, x.score) ? h("span", { class: "small muted" }, tierLabel(p, x.score)) : null,
                x.url ? link(x.url, "Open ↗", { cls: "small ext-link" }) : null);
            }) : h("div", { class: "cell" }, h("span", { class: "small muted" }, "No score site answered.")))),
          h("div", { class: "filterbar" },
            btn(isTarget ? "Already a target" : "Add as target", (e) => {
              const b = e.currentTarget;
              busy(b, async () => {
                const r = await ctx.send("targetsUpsert", { rows: [hd], defaults: { tier: 2, source: "score check" } }, { label: "Add target" });
                if (!r) return;
                if (num(r.blacklisted)) toast(`@${hd} is on your blacklist - not added.`, { type: "warn" });
                else toast(num(r.added) ? `@${hd} added as Tier 2. Follow status is checked before any comment.` : `@${hd} is already a target.`, { type: num(r.added) ? "success" : "info" });
                drawCheck();
              });
            }, { iconName: "plus", id: "checkAddBtn", disabled: isTarget, title: "Add as a Tier 2 target (change the tier on Targets)" }),
            btn("Show smart followers", () => ctx.navigate("discover?h=" + encodeURIComponent(hd)), { iconName: "discover", id: "checkSmartBtn" }),
            h("span", { class: "small muted" }, lastCheck.cached ? `checked ${fmtAgo(lastCheck.at)}` : `${plural(lastCheck.used, "request")} used`)));
      }
      if (!lastCheck && !scoreProviders().length) checkOut.appendChild(h("p", { class: "small muted" }, "Connect a score site first (Providers below)."));
      const checks = Object.entries(board().checks || {}).filter(([hd, c]) => c && hd !== (lastCheck && lastCheck.handle)).sort((a, b) => num(b[1].at) - num(a[1].at)).slice(0, 5);
      fill(recentHost, checks.length ? [
        h("div", { class: "cap recent-cap" }, "Recent checks"),
        h("div", { class: "list" }, checks.map(([hd, c]) => h("div", { class: "li recent-li" },
          h("button", { type: "button", class: "linkish handle", onClick: () => showCached(hd), title: "Show this check again" }, "@" + hd),
          h("span", { class: "small mono recent-scores" }, Object.entries(c.results || {}).map(([id, x]) => `${providerName(id)} ${x && x.score != null ? fmtShort(x.score) : "-"}`).join(" · ")),
          h("span", { class: "spacer" }),
          h("span", { class: "small muted" }, fmtAgo(c.at))))),
      ] : []);
    }
    const checkSec = section({ wide: true, id: "scoreCheck", title: "Check any account", hint: "1 request per connected site" },
      h("div", { class: "filterbar check-row" }, checkInput, checkBtn), checkOut, recentHost);

    // ------------------------------------------------ Target scores (coverage + refresh job)
    const coverHost = h("div", { class: "cover", id: "targetScores" });
    const jobHost = h("div", { class: "job-strip-host", id: "targetScoresJob", "aria-live": "polite" });
    function drawCoverage() {
      const b = board();
      const job = b.job && typeof b.job === "object" ? b.job : null;
      const running = job && job.status === "running";
      const provs = scoreProviders();
      const targets = ctx.targetList();
      const nowTs = Date.now();
      clear(coverHost);
      if (!provs.length) { coverHost.appendChild(h("p", { class: "small muted cover-empty" }, "Connect a score site to score your targets.")); }
      for (const p of provs) {
        let fresh = 0, stale = 0;
        const need = [];
        for (const t of targets) {
          const v = t.score && t.score.providers && t.score.providers[p.id];
          if (v && v.at && nowTs - v.at < STALE_MS) fresh++;
          else { if (v && v.at) stale++; need.push(t); }
        }
        // highest priority first, so a cap-limited refresh asks for the targets that matter most
        need.sort((a, c) => num(c.priority) - num(a.priority));
        const left = usageLeft(p), r = readiness(p);
        const n = Math.min(need.length, left);
        let why = "";
        if (running) why = "Another score job is running.";
        else if (!["ready", "error"].includes(r.kind)) why = r.kind === "cap" ? "Daily request cap reached." : r.label + ".";
        else if (!need.length) why = "Every target has a recent score.";
        const label = !need.length ? "Up to date" : n < need.length ? `Refresh ${n} of ${need.length} · cap` : `Refresh ${need.length} stale · ${plural(need.length, "request")}`;
        const b2 = btn(label, async (e) => {
          const handles = need.slice(0, n).map((t) => t.handle);
          if (!handles.length) return;
          if (handles.length > 20 && !(await confirmDialog(`Ask ${p.name} for ${handles.length} target scores? This uses ${handles.length} of the ${left} requests left today.`, { title: "Refresh target scores", okLabel: "Refresh" }))) return;
          await busy(e.currentTarget, async () => {
            const res = await ctx.send("targetScores", { handles, provider: p.id }, { label: "Target scores" });
            if (res) { jobProvider = p.id; toast(`${p.name}: scoring ${plural(handles.length, "target")} in the background`, { type: "success" }); }
          });
        }, { size: "xs", iconName: "refresh", disabled: !!why || !n, title: why || `${plural(n, "request")} · ${left} left today${n < need.length ? ` (the daily cap leaves ${need.length - n} for later)` : ""}` });
        add(coverHost,
          h("span", { class: "cover-name" }, providerKey(p.id), " " + p.name),
          coverageBar(fresh, stale, targets.length, { label: `${p.name}: ${fresh} fresh, ${stale} older than 7 days, ${Math.max(0, targets.length - fresh - stale)} never scored` }),
          h("span", { class: "mono small muted cover-n", title: "scored / all targets" }, `${fresh + stale}/${targets.length}`),
          b2);
      }
      // job strip (kind "targets"), with Cancel while it runs
      clear(jobHost);
      if (job && job.kind === "targets" && (running || (job.finishedAt && nowTs - job.finishedAt < 6 * 36e5))) {
        const total = num(job.total), done = num(job.done);
        const pct = total ? Math.max(3, (done / total) * 100) : running ? 6 : 100;
        const kind = job.status === "error" ? "red" : job.status === "cancelled" ? "grey" : running ? "" : "green";
        const pname = jobProvider ? providerName(jobProvider) + " · " : "";
        const res = job.result || {};
        add(jobHost, h("div", { class: "job-strip" },
          h("div", { class: "job-head" },
            running ? statusSquare("ink", "Running") : job.status === "done" ? statusSquare("green", "Done") : job.status === "cancelled" ? statusSquare("grey", "Cancelled") : statusSquare("red", "Error"),
            h("span", { class: "small" }, `${pname}${job.label || "Target scores"}`),
            h("span", { class: "mono small muted" }, running ? `${done} of ${total || "?"}${job.current ? " · @" + job.current : ""}${job.updated != null ? ` · ${job.updated} updated` : ""}` : `${num(res.updated != null ? res.updated : job.updated)} updated${res.failed ? ` · ${res.failed} failed` : ""} · ${fmtAgo(job.finishedAt)}`),
            h("span", { class: "spacer" }),
            running ? btn("Cancel", (e) => busy(e.currentTarget, async () => { const r = await ctx.send("scoreJobCancel", {}, { label: "Cancel" }); if (r) toast("Stopping after the current request"); }), { size: "xs", id: "scoreJobCancelBtn" }) : null),
          running ? progressBar(pct) : null,
          job.status === "error" && job.error ? h("div", { class: "small text-red" }, String(job.error)) : null));
      }
    }
    const coverWrap = h("div", { class: "target-scores" },
      h("div", { class: "sub-head" }, h("h3", { class: "sub-title" }, "Target scores"), h("span", { class: "small muted" }, "ink = fresh · amber = older than 7 days · rest = never")),
      coverHost, jobHost);

    // ------------------------------------------------ Providers (setup)
    const provHost = h("div", { class: "prov-setup" });
    const rowUpdaters = new Map();
    function providerRow(p0) {
      const id = p0.id;
      let p = p0;
      const statusEl = h("span", { class: "prow-status" });
      const enabled = toggleEl("On", p.enabled, null, { id: id + "Enabled", title: `Use ${p.name}` });
      const modeSel = selectEl([["auto", MODE_NAME.auto], ...p.modes.map((m) => [m, MODE_NAME[m] || m])], p.modePref || "auto", { id: id + "Mode", class: "input input-sm" });
      const usageEl = h("div", { class: "prow-usage" });
      const msgEl = h("div", { class: "prow-msg small", id: id + "Out", "aria-live": "polite" });
      const errEl = h("div", { class: "prow-err small text-red" });
      enabled.input.addEventListener("change", () => {
        const input = enabled.input;
        if (input.checked) { connectProvider(ctx, defs, p, { input, after: reloadSoon }); return; }
        ctx.save((d) => { d.providers = d.providers || {}; d.providers[id] = { ...(d.providers[id] || {}), enabled: false }; }).then(() => { toast(`${p.name} is off`); reloadSoon(); });
        // Give the site access back unless another enabled provider uses the same host.
        const def = defs[id];
        const mine = new Set(Object.values((def && def.modes) || {}).flatMap((m) => m.hosts || []));
        for (const q of st.providers) if (q.id !== id && q.enabled && defs[q.id]) for (const m of Object.values(defs[q.id].modes || {})) for (const hh of m.hosts || []) mine.delete(hh);
        if (mine.size) { try { Promise.resolve(chrome.permissions.remove({ origins: [...mine] })).catch(() => {}); } catch (_) { /* not granted */ } }
      });
      modeSel.addEventListener("change", () => {
        const pref = modeSel.value;
        const done = () => ctx.save((d) => { d.providers = d.providers || {}; d.providers[id] = { ...(d.providers[id] || {}), mode: pref }; }).then(reloadSoon);
        if (!p.enabled) { done(); return; }
        const need = needsFor(defs, p, pref);
        requestAccess(need).then((ok) => {
          if (!ok) { modeSel.value = p.modePref || "auto"; toast(`${MODE_NAME[pref] || pref} needs Chrome access to ${hostsOf(need)}${(need.permissions || []).includes("scripting") ? " and to read pages in a tab" : ""}. Not changed.`, { type: "warn" }); return; }
          done();
        }, (e) => { modeSel.value = p.modePref || "auto"; toast("Permission request failed: " + errText(e), { type: "error" }); });
      });
      const testBtn = btn("Test", (e) => busy(e.currentTarget, async () => {
        const r = await ctx.send("providerTest", { id }, { quiet: true, raw: true, label: `${p.name} test` });
        clear(msgEl);
        if (r && r.ok) {
          add(msgEl, h("span", { class: "text-green" }, `Works: score ${r.score != null ? fmtNum(r.score) : "-"}${r.max ? " / " + fmtNum(r.max) : ""}`), h("span", { class: "muted" }, ` for @${me() || "you"} · ${MODE_NAME[r.mode] || r.mode || ""}`), r.url ? [" · ", link(r.url, "Open ↗")] : null);
        } else add(msgEl, h("span", { class: "text-red" }, `Test failed: ${(r && r.error) || "no answer"}`));
        reloadSoon();
      }), { size: "sm", iconName: "bolt", id: id + "TestBtn", title: `Ask ${p.name} for your score (1 request)` });
      const cap = ctx.field({ path: `providers.${id}.dailyCap`, type: "number", label: "Daily request cap", min: 1, max: 5000, step: 10, hint: "ScoreX stops asking this site for the day at the cap." });
      const keyBox = p.keyName ? secretField(ctx, {
        key: p.keyName, label: `${p.name} API key`, placeholder: `Your ${p.name} key`, id: id + "KeyField",
        hint: h("span", null, p.keyNote ? p.keyNote + " " : "", p.keyHelp ? link(p.keyHelp, "Get a key ↗") : null),
        onChange: reloadSoon,
      }) : h("div", { class: "field-hint" }, "No key needed.");
      const row = h("div", { class: "prow", dataset: { provider: id }, id: "prov-" + id },
        h("div", { class: "prow-head" },
          h("span", { class: "prow-name" }, providerKey(id), h("strong", null, p.name), p.alias ? h("span", { class: "small muted" }, p.alias) : null),
          statusEl, h("span", { class: "spacer" }), testBtn),
        p.about ? h("p", { class: "small muted prow-about" }, p.about, p.site ? [" ", link(p.site, "Site ↗")] : null) : null,
        h("div", { class: "prow-grid" },
          h("div", { class: "field field-check" }, enabled),
          h("div", { class: "field" }, h("label", { class: "field-label", for: id + "Mode" }, "Mode"), modeSel),
          cap,
          h("div", { class: "field" }, h("span", { class: "field-label" }, "Used today"), usageEl)),
        keyBox, errEl, msgEl);
      const update = (np) => {
        p = np;
        const r = readiness(p);
        fill(statusEl, statusSquare(READY_SQUARE[r.kind] || "grey", r.kind === "error" ? "Last request failed" : r.kind === "ready" && p.mode ? `Ready · ${MODE_TAG[p.mode] || p.mode}` : r.label));
        if (document.activeElement !== enabled.input) enabled.input.checked = !!p.enabled;
        if (document.activeElement !== modeSel) modeSel.value = p.modePref || "auto";
        const u = p.usage || {}, pct = u.cap ? (num(u.today) / num(u.cap)) * 100 : 0;
        fill(usageEl, progressBar(pct), h("span", { class: "small mono muted" }, `${num(u.today)} of ${num(u.cap)} requests`));
        const own = p.own || {};
        errEl.textContent = own.error ? `Last error${own.errorAt ? " (" + fmtAgo(own.errorAt) + ")" : ""}: ${own.error}` : "";
        errEl.hidden = !own.error;
        testBtn.disabled = !p.enabled;
        testBtn.title = p.enabled ? `Ask ${p.name} for your score (1 request)` : `Turn ${p.name} on first`;
        row.classList.toggle("is-off", !p.enabled);
      };
      update(p);
      rowUpdaters.set(id, update);
      return row;
    }
    function drawProviders() {
      for (const p of st.providers) {
        if (rowUpdaters.has(p.id)) rowUpdaters.get(p.id)(p);
        else provHost.appendChild(providerRow(p));
      }
      provAdv.setTag(`${on().length} on`);
    }

    // provider overrides (advanced)
    const ovText = h("textarea", { class: "input mono", rows: 8, id: "providerOverrides", spellcheck: "false", placeholder: '{\n  "twitterscore": { "modes": { "public": { "score": { "value": { "regex": "..." } } } } }\n}', "aria-label": "Provider overrides JSON" });
    const ovStatus = h("div", { class: "small", id: "providerOverrideStatus", "aria-live": "polite" });
    const showOv = (v) => {
      ovText.value = v && Object.keys(v).length ? JSON.stringify(v, null, 2) : "";
      ovStatus.className = "small muted";
      ovStatus.textContent = v && Object.keys(v).length ? "Overrides active." : "No overrides - the built-in definitions are used.";
    };
    const validateOv = () => {
      const raw = ovText.value.trim();
      if (!raw) return { ok: true, value: null };
      let v;
      try { v = JSON.parse(raw); } catch (e) { return { ok: false, error: "Not valid JSON: " + errText(e) }; }
      if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "The overrides must be a JSON object, e.g. {\"twitterscore\": {...}}." };
      const known = new Set(Object.keys(defs));
      const bad = Object.keys(v).filter((k) => !known.has(k));
      if (bad.length) return { ok: false, error: `Unknown provider(s): ${bad.join(", ")}. Use ${[...known].join(", ")}.` };
      const notObj = Object.keys(v).filter((k) => !v[k] || typeof v[k] !== "object" || Array.isArray(v[k]));
      if (notObj.length) return { ok: false, error: `Each provider's override must be an object (${notObj.join(", ")}).` };
      return { ok: true, value: v };
    };
    ovText.addEventListener("input", debounce(() => {
      const r = validateOv();
      ovStatus.className = r.ok ? "small muted" : "small text-red";
      ovStatus.textContent = r.ok ? (r.value ? "Valid JSON. Save to apply." : "Empty: saving removes every override.") : r.error;
    }, 300));
    const ovSave = btn("Save overrides", async (e) => {
      const r = validateOv();
      if (!r.ok) { ovStatus.className = "small text-red"; ovStatus.textContent = r.error; return; }
      await busy(e.currentTarget, async () => {
        try {
          if (r.value) await chrome.storage.local.set({ [K.providerOverrides]: r.value });
          else await chrome.storage.local.remove(K.providerOverrides);
          toast(r.value ? "Provider overrides saved" : "Provider overrides removed", { type: "success" });
          showOv(await loadOverrides());
          reload();
        } catch (err) { toast("Could not save overrides: " + errText(err), { type: "error" }); }
      });
    }, { kind: "primary", size: "sm", id: "providerOverrideSave" });
    const ovReset = btn("Remove all", async () => {
      if (!(await confirmDialog("Remove all provider overrides and use the built-in definitions?", { title: "Remove overrides", okLabel: "Remove", danger: true }))) return;
      try { await chrome.storage.local.remove(K.providerOverrides); showOv(await loadOverrides()); toast("Provider overrides removed"); reload(); } catch (err) { toast("Could not remove overrides: " + errText(err), { type: "error" }); }
    }, { size: "sm", kind: "ghost-danger" });
    const ovAdv = advanced({ key: "scores.overrides", title: "Provider overrides", desc: "Patch a site's URLs, fields or page selectors when it changes (JSON)" },
      h("p", { class: "small muted" }, "Only URLs on the provider's own site, headers, field paths, selectors and regexes are taken; the site, the hosts and the key name never change."),
      ovText, h("div", { class: "toolbar" }, ovSave, ovReset), ovStatus);

    const provAdv = advanced({ key: "scores.providers", id: "providersSetup", title: "Providers", desc: "Turn score sites on, API keys, modes, daily request caps, tests", open: !Object.values(ctx.settings.providers || {}).some((x) => x && x.enabled) },
      h("p", { class: "small muted" }, "Every site is off until you turn it on; Chrome then asks for access to that site. Only X handles are sent."),
      provHost,
      h("div", { class: "form-grid prov-global" },
        ctx.field({ path: "scores.autoRefreshOwn", type: "toggle", label: "Refresh my scores automatically (about once a day)" }),
        ctx.field({ path: "scores.blendSorsa", type: "percent", label: "Weight of Sorsa in the combined rank", min: 0, max: 100, step: 5, suffix: "%", hint: "A target's rank mixes ScoreX's own rank with its Sorsa score when Sorsa has one." })),
      ovAdv);

    // ------------------------------------------------ layout
    add(root,
      head,
      cellsHost,
      histSec,
      h("div", { class: "cols-even scores-cols" }, fbSec, h("div", { class: "stack-lg" }, checkSec, coverWrap)),
      provAdv);

    function drawAll() {
      drawHead();
      drawCells();
      drawHistory();
      drawFollowBacks();
      drawCheck();
      drawCoverage();
      drawProviders();
    }

    showOv(await loadOverrides());
    await reload();
    ctx.on(K.scoreboard, () => { drawCoverage(); drawCheck(); reloadSoon(); });
    ctx.on(K.targets, () => { drawHistory(); drawFollowBacks(); drawCoverage(); });
    ctx.on("settings", reloadSoon);
    ctx.on("secrets", reloadSoon);
    ctx.interval(() => { if (!document.hidden) drawHead(); }, 60000);
    const applyParams = (prm) => {
      if (prm && prm.view === "providers") { provAdv.open = true; setTimeout(() => provAdv.scrollIntoView({ block: "start" }), 50); }
      if (prm && prm.h && normalizeHandle(prm.h) && (!lastCheck || lastCheck.handle !== normalizeHandle(prm.h))) {
        const hd = normalizeHandle(prm.h);
        if ((board().checks || {})[hd]) showCached(hd); else { checkInput.value = "@" + hd; runCheck(hd); }
      }
    };
    ctx.on("params", applyParams);
    applyParams(ctx.params);
  },
};
