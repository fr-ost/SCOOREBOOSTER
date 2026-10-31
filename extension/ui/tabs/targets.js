// Targets (#targets): the accounts ScoreX replies to.
// Header: a status switch with counts (All / Commenting / Checking / Followed back / Follow you / Off / Not found),
// "Find new targets" (Discover), "Blacklist N" (the sub-view #targets?view=blacklist) and "Add targets" (a sheet with
// the paste box, tier, import file and export; shown inline while there are no targets). Toolbar: search ("/" focuses
// it), tier switch, "High value" filter, Columns menu. Table: plain 44px rows; a click or Enter opens the target drawer
// (#targets?h=<handle>; J/K move between targets; Esc closes): profile, scores, follow timeline with every comment and
// its results, per-account settings and actions. Selected rows get a sticky bulk bar. Follow rules and follow-check
// frequency live in the "Edit rules" sheet. Only accounts that don't follow you get comments; every change to a target
// goes through a worker message.

import { K, HS, PRESET_KEYS } from "../../lib/constants.js";
import { parseHandleList, normalizeHandle, toCsv, num, DAY } from "../../lib/util.js";
import { parseImport, allToneKeys, followStatus, followDays, FS, FS_LABEL, MAIN_TONE } from "../../lib/targets.js";
import * as history from "../../lib/history.js";
import {
  h, clear, fill, btn, busy, toast, icon, announce, stableTable, tierBadge, followBadge, followDay, dayMeter, FS_COLOR, tag, statusSquare,
  selectEl, toggleEl, labeled, segmented, segFilter, columnsMenu, drawer, sheet, confirmDialog, download, readFileText, stamp,
  isTyping, hasOverlay, kbd, providerKey, providerName, enabledProviders, primaryProvider,
  fmtCount, fmtNum, fmtAgo, fmtDate, fmtDay, fmtDateTime, debounce, truncate,
} from "../components.js";
import { partsBar, barInCell, fmtShort } from "../charts.js";

export function toneLabel(key, settings) {
  if (!key || key === MAIN_TONE) return "Your Tone prompt";
  if (key === "custom") return "Custom text (old)";
  if (key.startsWith("custom:")) {
    const c = ((settings && settings.customTones) || []).find((x) => "custom:" + x.id === key);
    return c ? c.name || "Custom tone" : "Custom (missing)";
  }
  return key.charAt(0).toUpperCase() + key.slice(1);
}

// lib/scores.js ownScore weights (out of 100). The drawer labels them as weights; the parts bar shows this account's parts.
const RANK_W = [["reach", 40], ["engagement", 25], ["activity", 20], ["quality", 15]];
const PRESET_LABEL = { high: "High quality", balanced: "Balanced", cheap: "Cheap" };
const WATCH_LABEL = { list: "X List (recommended)", search: "Batched Latest search", rotation: "Profile rotation" };
// target.source -> [column label, timeline text]
const SOURCE_LABEL = { manual: ["By you", "Added by you"], import: ["Import", "Imported from a file"], discovery: ["Discovery", "Added from Discovery"], candidate: ["Discovery", "Added from Discovery"], candidates: ["Discovery", "Added from Discovery"], popup: ["Popup", "Added from the popup"], smart: ["Smart followers", "Added from smart followers"] };
const GONE = "gone";
const HIGH_VALUE = 70;
const isOn = (t) => t.enabled !== false;
const fsOf = (t) => (t.rel && t.rel.gone ? GONE : followStatus(t));
const xUrl = (hd) => `https://x.com/${encodeURIComponent(hd)}`;
const safeUrl = (u) => (typeof u === "string" && /^https:\/\//i.test(u) ? u : null);
const plural = (n, one, many = one + "s") => `${fmtNum(n)} ${n === 1 ? one : many}`;
const numOrNull = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const fmtFollowers = (v) => (v == null ? "-" : v >= 10000 ? fmtCount(v) : fmtNum(v));
const sourceLabel = (t) => { const s = String(t.source || "").trim(); return SOURCE_LABEL[s] ? SOURCE_LABEL[s][0] : s || "-"; };
const addedText = (t) => { const s = String(t.source || "").trim(); return SOURCE_LABEL[s] ? SOURCE_LABEL[s][1] : s ? `Added (${s})` : "Added"; };

// Status switch: [value (also the data-sum hook), label, title, test]. Commenting and Checking only count targets that
// are on; Off counts every target that is turned off (a profile that was not found is also turned off).
const STATUS = [
  ["total", "All", "Every target", () => true],
  [FS.ACTIVE, "Commenting", "Don't follow you: ScoreX comments on them until they follow back", (t) => isOn(t) && fsOf(t) === FS.ACTIVE],
  [FS.CHECKING, "Checking", "Not checked yet: no comments until ScoreX knows whether they follow you", (t) => isOn(t) && fsOf(t) === FS.CHECKING],
  [FS.FOLLOWED_BACK, "Followed back", "Followed you back after ScoreX's comments: comments stopped", (t) => fsOf(t) === FS.FOLLOWED_BACK],
  [FS.FOLLOWS, "Follow you", "Already followed you: never commented on", (t) => fsOf(t) === FS.FOLLOWS],
  ["off", "Off", "Turned off: never checked or commented on", (t) => !isOn(t)],
  [GONE, "Not found", "Profile not found on X (renamed, suspended or deleted): turned off", (t) => fsOf(t) === GONE],
];
const STATUS_TEST = Object.fromEntries(STATUS.map((s) => [s[0], s[3]]));
const DEFAULT_COLS = ["handle", "tier", "follow", "followers", "own", "value", "propensity", "comments", "lastComment"];

// Score fields (the worker owns the shape; read defensively, "-" when missing).
const S = {
  followers: (t) => numOrNull(t.profile && t.profile.followers),
  own: (t) => numOrNull(t.score && t.score.own),
  value: (t) => numOrNull(t.score && t.score.value),
  prop: (t) => numOrNull(t.score && t.score.propensity),
  why: (t) => (t.score && typeof t.score.why === "string" ? t.score.why : ""),
};
// Newest score of one provider for a target: target.score.providers[id], the older Sorsa field, or a fresh "Check
// scores" result (board.checks[handle]). { score, max, at, url } | { error, at, url } | null.
function provScore(t, id, board) {
  const sc = (t && t.score) || {};
  let best = null;
  const p = sc.providers && sc.providers[id];
  if (p && numOrNull(p.score) != null) best = { score: Number(p.score), max: numOrNull(p.max), at: Number(p.at) || 0 };
  if (id === "sorsa" && numOrNull(sc.sorsa) != null && (!best || (Number(sc.sorsaUpdatedAt) || 0) > best.at)) best = { score: Number(sc.sorsa), max: null, at: Number(sc.sorsaUpdatedAt) || 0 };
  const ck = board && board.checks && board.checks[t.handle];
  const r = ck && ck.results && ck.results[id];
  if (r && numOrNull(r.score) != null && (!best || (Number(ck.at) || 0) > best.at)) best = { score: Number(r.score), max: numOrNull(r.max), at: Number(ck.at) || 0, url: r.url };
  if (!best && r && r.error) return { error: String(r.error), at: Number(ck.at) || 0, url: r.url };
  return best;
}
// "Follows back?" chip from target.score.propensity (0-1).
function propChip(p) {
  if (p == null) return tag("?", "", "Not estimated yet");
  const title = `About ${Math.round(p * 100)}% chance of a follow-back (an estimate)`;
  return p >= 0.5 ? tag("Often", "green", title) : p >= 0.2 ? tag("Sometimes", "", title) : tag("Rarely", "", title);
}

export default {
  id: "targets",
  title: "Targets",
  hint: "The accounts ScoreX replies to. Only accounts that don't follow you get comments, and comments stop once they follow back.",
  async render(root, ctx) {
    const selected = new Set();
    const removing = new Set();
    const sortState = { key: "follow", dir: "asc" };
    const f = { status: "total", tier: "", q: "", high: false };
    let view = "targets";
    let tableWrap = null;
    let dataRev = 0;
    let lastTickDraw = Date.now();
    let dr = null, openHandle = null, dw = null, tlSeq = 0, disposed = false;
    let addSheet = null, rulesSheet = null;
    let lastTier = "2";
    const tlCache = new Map();
    const board = () => ctx.data[K.scoreboard] || {};
    const list = () => ctx.targetList();

    const patchTarget = async (handle, patch, label = "Save target") => {
      const r = await ctx.send("targetPatch", { handle, patch }, { label });
      if (!r) refreshDrawer(); // put the stored values back
      return r;
    };
    function toneOptions(t) {
      const s = ctx.settings;
      const opts = [["", "Your Tone prompt"]];
      for (const k of allToneKeys(s)) opts.push([k, toneLabel(k, s)]);
      if (t && t.tone && !opts.some((o) => o[0] === t.tone)) opts.push([t.tone, toneLabel(t.tone, s)]);
      return opts;
    }

    // ------------------------------------------------ header: status switch, Find, Blacklist, Add
    const statusSeg = segFilter(STATUS.map(([v, l, title]) => [v, l, 0, title]), f.status, (v) => { f.status = v; drawTable(true); drawFoot(); }, { label: "Filter by follow status", id: "targetStatus", cls: "tg-status" });
    for (const b of statusSeg.querySelectorAll(".seg-btn")) { b.dataset.sum = b.dataset.value; const ct = b.querySelector(".ct"); if (ct) ct.classList.add("summary-num"); }
    const blCount = h("span", { class: "ct summary-num" }, "0");
    const blViewBtn = h("button", { type: "button", class: "btn btn-ghost tg-bl-btn", id: "blacklistViewBtn", dataset: { sum: "blacklisted" }, title: "Accounts ScoreX never adds again", onClick: () => showView("blacklist", true) },
      icon("ban"), h("span", null, "Blacklist"), blCount);
    const addBtn = btn("Add targets", () => openAdd(), { kind: "primary", iconName: "plus", id: "addTargetsBtn" });
    const findLink = h("a", { href: "#discover", class: "btn btn-ghost", id: "findTargetsLink", title: "Smart followers, followers of an account, search (Discover)" }, icon("discover"), h("span", null, "Find new targets"));
    const head = h("div", { class: "filterbar tg-head", id: "targetsSummary" }, statusSeg, h("span", { class: "spacer" }), findLink, blViewBtn, addBtn);

    // ------------------------------------------------ toolbar: search, tier, high value, columns
    const search = h("input", { class: "input", type: "search", placeholder: "Search handle, name, bio or notes", id: "targetSearch", "aria-label": "Search targets", "aria-keyshortcuts": "/" });
    const applySearch = () => { f.q = search.value.trim().toLowerCase(); drawTable(true); drawFoot(); };
    search.addEventListener("input", debounce(applySearch, 200));
    search.addEventListener("keydown", (e) => { if (e.key === "Escape" && search.value) { e.preventDefault(); e.stopPropagation(); search.value = ""; applySearch(); } });
    const tierSeg = segmented([["", "All tiers"], ["1", "T1"], ["2", "T2"]], "", (v) => { f.tier = v; drawTable(true); drawFoot(); }, { label: "Filter by tier", cls: "tg-tier" });
    const highCt = h("span", { class: "ct" }, "");
    const highBtn = h("button", { type: "button", class: "btn btn-sm tg-chip", id: "highValueBtn", "aria-pressed": "false", onClick: () => { f.high = !f.high; highBtn.setAttribute("aria-pressed", String(f.high)); drawCounts(); drawTable(true); drawFoot(); } },
      h("span", null, "High value"), highCt);
    let cols = null;
    let provIds = [];
    const colsSlot = h("span", { class: "tg-cols" });
    const tools = h("div", { class: "filterbar tg-tools" },
      h("div", { class: "search" }, icon("search"), search), tierSeg, highBtn, colsSlot, h("span", { class: "spacer" }),
      h("span", { class: "small muted tg-tip" }, "Click a row for details. ", kbd("/"), " search"));

    // ------------------------------------------------ table
    function accountCell(t) {
      const name = t.name || (t.profile && t.profile.name) || "";
      return h("div", { class: "cell-account" },
        h("div", { class: "cell-handle" }, h("span", { class: "handle" }, "@" + t.handle),
          t.profile && t.profile.verified ? h("span", { class: "verified", title: "Verified" }, icon("check")) : null,
          isOn(t) ? null : tag("Off", "", "Turned off: ScoreX does not reply to this account"),
          h("a", { class: "tg-x", href: xUrl(t.handle), target: "_blank", rel: "noopener noreferrer", tabindex: "-1", title: `Open @${t.handle} on X`, "aria-label": `Open @${t.handle} on X` }, icon("external"))),
        h("div", { class: "cell-sub", title: (t.profile && t.profile.bio) || null }, name));
    }
    function colDefs() {
      const s = ctx.settings, b = board(), now = Date.now();
      const giveUp = (s.follow && s.follow.giveUpDays) || 14;
      return [
        { key: "handle", label: "Account", locked: true, sort: (t) => t.handle, defaultDir: "asc", render: accountCell },
        { key: "tier", label: "Tier", sort: (t) => Number(t.tier) || 9, defaultDir: "asc", render: (t) => tierBadge(t.tier) },
        { key: "follow", label: "Follow status", className: "col-follow", title: `Checking: not checked yet (no comments). Not following: ScoreX comments on them, day N of ${giveUp}. Follows you: never commented on. Followed back: comments stopped.`, sort: followSortKey, defaultDir: "asc", render: (t) => followBadge(t, s) },
        { key: "followers", label: "Followers", align: "right", sort: S.followers, render: (t) => fmtFollowers(S.followers(t)) },
        { key: "own", label: "Rank", menuLabel: "ScoreX rank", align: "right", title: "ScoreX rank 0-100 from followers, engagement, activity and quality", sort: S.own, render: (t) => (S.own(t) == null ? "-" : String(Math.round(S.own(t)))) },
        ...provIds.map((id) => ({
          key: "p_" + id, label: h("span", { class: "tg-th-prov" }, providerKey(id), providerName(id)), menuLabel: providerName(id) + " score", align: "right", title: `${providerName(id)} score`,
          sort: (t) => { const p = provScore(t, id, b); return p && p.score != null ? p.score : null; },
          render: (t) => { const p = provScore(t, id, b); return p && p.score != null ? h("span", { title: p.at ? `Checked ${fmtAgo(p.at)}` : null }, fmtNum(p.score)) : "-"; },
        })),
        { key: "value", label: "Value", align: "right", title: "Score × chance of a follow-back (0-100). Point at a number to see why.", sort: S.value,
          render: (t) => { const v = S.value(t); return v == null ? "-" : h("span", { class: ["tg-value", v >= HIGH_VALUE && "is-high"], title: S.why(t) || null }, String(Math.round(v))); } },
        { key: "propensity", label: "Follows back?", title: "How often accounts like this follow back (an estimate)", sort: S.prop, render: (t) => propChip(S.prop(t)) },
        { key: "comments", label: "Comments", align: "right", sort: (t) => num(t.stats && t.stats.comments), render: (t) => String(num(t.stats && t.stats.comments)) },
        { key: "lastComment", label: "Last comment", sort: (t) => (t.stats && t.stats.lastCommentAt) || 0, render: (t) => (t.stats && t.stats.lastCommentAt ? h("span", { class: "nowrap", title: fmtDateTime(t.stats.lastCommentAt) }, fmtAgo(t.stats.lastCommentAt)) : "-") },
        { key: "priority", label: "Priority", align: "right", title: "Who goes first when several targets post at once (0-100)", sort: (t) => num(t.priority, 50), render: (t) => String(num(t.priority, 50)) },
        { key: "coldUntil", label: "Cold until", sort: (t) => (t.coldUntil && t.coldUntil > now ? t.coldUntil : 0), render: (t) => (t.coldUntil && t.coldUntil > now ? tag(fmtDay(t.coldUntil), "amber", "Cooling down after no response") : "-") },
        { key: "tone", label: "Tone", defaultDir: "asc", sort: (t) => (t.tone ? toneLabel(t.tone, s) : ""), render: (t) => (t.tone ? toneLabel(t.tone, s) : h("span", { class: "muted" }, "default")) },
        { key: "preset", label: "Preset", defaultDir: "asc", sort: (t) => t.preset || "", render: (t) => (t.preset ? PRESET_LABEL[t.preset] || t.preset : h("span", { class: "muted" }, "tier")) },
        { key: "addedAt", label: "Added", sort: (t) => t.addedAt || 0, render: (t) => (t.addedAt ? h("span", { class: "nowrap", title: fmtDateTime(t.addedAt) }, fmtDate(t.addedAt)) : "-") },
        { key: "source", label: "Source", defaultDir: "asc", sort: sourceLabel, render: (t) => h("span", { class: "cell-name", title: sourceLabel(t) }, sourceLabel(t)) },
        { key: "checkedAt", label: "Last checked", title: "Last follow check", sort: (t) => (t.rel && t.rel.checkedAt) || 0, render: (t) => (t.rel && t.rel.checkedAt ? h("span", { class: "nowrap", title: fmtDateTime(t.rel.checkedAt) }, fmtAgo(t.rel.checkedAt)) : "-") },
      ];
    }
    function buildColsMenu() {
      provIds = enabledProviders(ctx.settings);
      const prim = primaryProvider(ctx.settings, board());
      cols = columnsMenu({
        key: "targets",
        columns: colDefs().map((c) => ({ key: c.key, label: c.menuLabel || c.label, locked: !!c.locked })),
        defaults: DEFAULT_COLS.concat(prim ? ["p_" + prim] : []),
        onChange: () => drawTable(true),
      });
      cols.button.id = "targetColumnsBtn";
      fill(colsSlot, cols.button);
    }

    function filtered() {
      const test = STATUS_TEST[f.status] || STATUS_TEST.total;
      return list().filter((t) => {
        if (!test(t)) return false;
        if (f.tier && String(t.tier) !== f.tier) return false;
        if (f.high && !(S.value(t) >= HIGH_VALUE)) return false;
        if (f.q) {
          const p = t.profile || {};
          const hay = `${t.handle} ${t.name || ""} ${p.name || ""} ${p.bio || ""} ${t.notes || ""}`.toLowerCase();
          if (!hay.includes(f.q)) return false;
        }
        return true;
      });
    }
    function clearFilters() {
      f.status = "total"; f.tier = ""; f.q = ""; f.high = false;
      statusSeg.set("total"); tierSeg.set(""); search.value = ""; highBtn.setAttribute("aria-pressed", "false");
      drawCounts(); drawTable(true); drawFoot();
    }
    function statusText(t) {
      const st = fsOf(t);
      if (st === GONE) return "not found on X";
      const d = followDay(t, ctx.settings);
      return (FS_LABEL[st] || st).toLowerCase() + (d ? `, day ${d.day} of ${d.of}` : "") + (isOn(t) ? "" : ", turned off");
    }

    const tableHost = h("div", { id: "targetsTable" });
    function drawTable(force) {
      if (view !== "targets" || !cols) return;
      const sig = force ? null : String(dataRev);
      tableWrap = stableTable(tableHost, {
        signature: sig,
        caption: "Targets",
        columns: colDefs(),
        rows: filtered(),
        rowKey: (t) => t.handle,
        selection: selected,
        onSelectionChange: () => drawBulk(),
        sortState,
        maxRows: 150,
        tall: true,
        chevron: true,
        visibleColumns: cols.visible(),
        activeKey: openHandle,
        rowClass: (t) => (isOn(t) ? "" : "is-disabled"),
        rowLabel: (t) => `@${t.handle}, ${statusText(t)}. Enter opens the details.`,
        onRowOpen: (t) => openDrawer(t.handle),
        empty: list().length ? h("span", null, "No targets match these filters. ", h("button", { type: "button", class: "linkish", onClick: clearFilters }, "Clear filters")) : "No targets yet.",
      });
      drawBulk();
    }

    // ------------------------------------------------ status counts, footer, empty state
    function drawCounts() {
      const all = list();
      const counts = {};
      for (const [v, , , test] of STATUS) counts[v] = all.filter(test).length;
      statusSeg.setCounts(counts);
      blCount.textContent = String(Object.keys(ctx.data[K.blacklist] || {}).length);
      const withValue = all.filter((t) => S.value(t) != null);
      highCt.textContent = withValue.length ? String(withValue.filter((t) => S.value(t) >= HIGH_VALUE).length) : "";
      highBtn.disabled = !withValue.length && !f.high;
      highBtn.title = withValue.length ? `Value ${HIGH_VALUE} or more: score × chance of a follow-back` : "No values yet: ScoreX computes them from scores and follow-backs";
    }
    const footCount = h("span", null);
    const footRules = h("span", null);
    const editRulesBtn = h("button", { type: "button", class: "linkish", id: "editRulesBtn", onClick: () => openRules() }, "Edit rules");
    const foot = h("div", { class: "tg-foot", id: "targetsFoot" }, footCount, h("span", { class: "sep", "aria-hidden": "true" }, "·"), footRules, h("span", { class: "sep", "aria-hidden": "true" }, "·"), editRulesBtn);
    function rulesText() {
      const fl = ctx.settings.follow || {};
      if (fl.autoRemove === false) return "accounts that don't follow back are kept (automatic removal is off)";
      return `remove after ${fl.giveUpDays || 14} days without a follow-back${fl.blacklist === false ? "" : ", then blacklist"}`;
    }
    function drawFoot() {
      const all = list().length, n = filtered().length;
      footCount.textContent = n === all ? plural(all, "target") : `${fmtNum(n)} of ${plural(all, "target")}`;
      footRules.textContent = "rules: " + rulesText();
    }
    const emptyHost = h("div", { class: "tg-empty", id: "targetsEmpty", hidden: true });
    function drawEmpty() {
      const none = !list().length;
      for (const el of [tools, tableHost, foot, statusSeg]) el.hidden = none;
      if (none && !(addSheet && addSheet.isOpen())) {
        if (emptyHost.hidden || !emptyHost.firstChild) {
          fill(emptyHost,
            h("div", { class: "tg-empty-head" },
              h("h2", { class: "sec-title" }, "Add your first targets"),
              h("p", { class: "small muted" }, "Paste the accounts you want replies on, or find smart accounts on ", h("a", { href: "#discover" }, "Discover"), ".")),
            addForm({ inline: true }));
        }
        emptyHost.hidden = false;
      } else if (!emptyHost.hidden) { emptyHost.hidden = true; clear(emptyHost); }
    }

    // ------------------------------------------------ bulk bar (sticky)
    const bulkBar = h("div", { class: "bulk-bar tg-bulk", hidden: true, id: "bulkBar", role: "region", "aria-label": "Bulk actions for the selected targets" });
    let bulkN = 0;
    function drawBulk(force) {
      const live = new Set(list().map((t) => t.handle));
      for (const hd of [...selected]) if (!live.has(hd)) selected.delete(hd);
      const n = selected.size;
      bulkBar.hidden = !n;
      if (!n) { bulkN = 0; clear(bulkBar); return; }
      if (!force && n === bulkN && bulkBar.contains(document.activeElement)) return;
      bulkN = n;
      const handles = () => [...selected];
      const bulk = async (patch, label) => {
        const r = await ctx.send("targetsBulk", { handles: handles(), patch }, { label });
        if (r) toast(`${label}: ${plural(n, "target")}`, { type: "success" });
      };
      const tierSel = selectEl([["", "Set tier…"], ["1", "Tier 1"], ["2", "Tier 2"]], "", { class: "input input-sm", "aria-label": "Set tier for the selected targets", id: "bulkTier" });
      tierSel.addEventListener("change", () => { if (tierSel.value) bulk({ tier: Number(tierSel.value) }, "Set tier " + tierSel.value); tierSel.value = ""; });
      const toneSel = selectEl([["-", "Set tone…"], ...toneOptions(null)], "-", { class: "input input-sm", "aria-label": "Set tone for the selected targets", id: "bulkTone" });
      toneSel.addEventListener("change", () => { if (toneSel.value !== "-") bulk({ tone: toneSel.value }, "Tone " + toneLabel(toneSel.value, ctx.settings)); toneSel.value = "-"; });
      const presetSel = selectEl([["-", "Set preset…"], ["", "Tier preset"], ...PRESET_KEYS.map((k) => [k, PRESET_LABEL[k] || k])], "-", { class: "input input-sm", "aria-label": "Set model preset for the selected targets", id: "bulkPreset" });
      presetSel.addEventListener("change", () => { if (presetSel.value !== "-") bulk({ preset: presetSel.value }, "Preset " + (PRESET_LABEL[presetSel.value] || "from tier")); presetSel.value = "-"; });
      const provs = enabledProviders(ctx.settings);
      const provSel = provs.length > 1 ? selectEl(provs.map((id) => [id, providerName(id)]), primaryProvider(ctx.settings, board()) || provs[0], { class: "input input-sm", "aria-label": "Score site", id: "bulkProvider" }) : null;
      const fetchBtn = btn(provs.length === 1 ? `Fetch ${providerName(provs[0])} scores` : "Fetch scores", (e) => {
        const provider = provSel ? provSel.value : provs[0];
        busy(e.currentTarget, async () => {
          const r = await ctx.send("targetScores", { handles: handles(), provider }, { label: "Fetch scores" });
          if (r) toast(`Fetching ${providerName(provider)} scores for ${plural(n, "account")}. Progress shows on Scores.`, { type: "success", action: { label: "Open Scores", onClick: () => ctx.navigate("scores") } });
        });
      }, { size: "sm", iconName: "scores", id: "bulkScoresBtn", disabled: !provs.length, title: provs.length ? "Uses one request per account on the chosen score site" : "Turn on a score site on Scores first" });
      fill(bulkBar,
        h("strong", { class: "tg-bulk-n" }, `${fmtNum(n)} selected`),
        tierSel, toneSel, presetSel,
        btn("Enable", () => bulk({ enabled: true }, "Enable"), { size: "sm", id: "bulkEnableBtn" }),
        btn("Disable", () => bulk({ enabled: false }, "Disable"), { size: "sm", id: "bulkDisableBtn" }),
        btn("Re-check", (e) => busy(e.currentTarget, async () => {
          const r = await ctx.send("targetRefresh", { handles: handles() }, { label: "Re-check" });
          if (r) { const q = num(r.queued, n); toast(`Queued ${q} re-check${q === 1 ? "" : "s"} (follow status and profile)`, { type: "success" }); }
        }), { size: "sm", iconName: "refresh", id: "bulkRecheckBtn", title: "Re-check follow status and profile" }),
        provSel, fetchBtn,
        btn("Blacklist", async () => {
          if (!(await confirmDialog(`Blacklist ${plural(n, "account")}? ${n === 1 ? "It is" : "They are"} removed from your targets and never added again by paste, import or discovery. History stays, and you can undo this in the Blacklist.`, { title: "Blacklist targets", okLabel: "Blacklist", danger: true }))) return;
          const r = await ctx.send("blacklistAdd", { handles: handles() }, { label: "Blacklist" });
          if (r) { toast(`Blacklisted ${fmtNum(n)} (${num(r.removedTargets)} removed from targets)`, { type: "success" }); selected.clear(); drawTable(true); }
        }, { size: "sm", kind: "danger-soft", iconName: "ban", id: "bulkBlacklistBtn" }),
        btn("Remove", async () => {
          if (!(await confirmDialog(`Remove ${plural(n, "target")}? Their history stays.`, { title: "Remove targets", okLabel: "Remove", danger: true }))) return;
          const r = await ctx.send("targetsRemove", { handles: handles() }, { label: "Remove" });
          if (r) { toast(`Removed ${num(r.removed, n)}`, { type: "success" }); selected.clear(); drawTable(true); }
        }, { size: "sm", kind: "danger-soft", iconName: "trash", id: "bulkRemoveBtn" }),
        h("span", { class: "spacer" }),
        btn("Clear selection", () => { selected.clear(); drawTable(true); }, { size: "sm", kind: "ghost", id: "bulkClearBtn" }));
    }

    // ------------------------------------------------ Add targets (sheet, or inline while there are none)
    function addedToast(r, verb = "Added", suffix = "") {
      const added = num(r.added), updated = num(r.updated), black = num(r.blacklisted);
      const parts = [`${verb} ${added}${suffix}`];
      if (updated) parts.push(`${updated} updated`);
      if (black) parts.push(`${black} skipped (blacklisted)`);
      toast(parts.join(", ") + (added ? ". Follow status is checked before any comment." : "."), { type: added || updated ? "success" : "warn" });
    }
    function exportCsv() {
      const all = list();
      if (!all.length) { toast("No targets to export.", { type: "warn" }); return; }
      const b = board();
      const iso = (ts) => (ts ? new Date(ts).toISOString() : "");
      const csvCols = [
        { key: "handle", label: "handle" }, { key: "name", label: "name" }, { key: "tier", label: "tier" },
        { key: "enabled", label: "enabled", get: (t) => (isOn(t) ? "yes" : "no") },
        { key: "follow", label: "follow_status", get: (t) => (t.rel && t.rel.gone ? "Not found" : FS_LABEL[followStatus(t)]) },
        { key: "first", label: "first_comment", get: (t) => iso(t.stats && t.stats.firstCommentAt) },
        { key: "followedBack", label: "followed_back", get: (t) => iso(t.rel && t.rel.followedBackAt) },
        { key: "tone", label: "tone" }, { key: "preset", label: "preset" },
        { key: "priority", label: "priority" }, { key: "followers", label: "followers", get: (t) => (S.followers(t) != null ? S.followers(t) : "") },
        { key: "own", label: "scorex_rank", get: (t) => (S.own(t) != null ? S.own(t) : "") },
        { key: "sorsa", label: "sorsa_score", get: (t) => { const p = provScore(t, "sorsa", b); return p && p.score != null ? p.score : ""; } },
        ...enabledProviders(ctx.settings).filter((id) => id !== "sorsa").map((id) => ({ key: "p_" + id, label: id + "_score", get: (t) => { const p = provScore(t, id, b); return p && p.score != null ? p.score : ""; } })),
        { key: "value", label: "value", get: (t) => (S.value(t) != null ? S.value(t) : "") },
        { key: "propensity", label: "followback_chance", get: (t) => (S.prop(t) != null ? S.prop(t) : "") },
        { key: "comments", label: "comments", get: (t) => num(t.stats && t.stats.comments) },
        { key: "last", label: "last_comment", get: (t) => iso(t.stats && t.stats.lastCommentAt) },
        { key: "notes", label: "notes" },
      ];
      download(`scorex-targets-${stamp()}.csv`, toCsv(all.sort((a, c) => a.handle.localeCompare(c.handle)), csvCols), "text/csv");
    }
    function addForm({ inline = false } = {}) {
      const text = h("textarea", { class: "input", id: "addHandles", rows: inline ? 4 : 9, spellcheck: "false", placeholder: "@naval\nhttps://x.com/balajis\nvitalikbuterin, paulg", "aria-describedby": "addHandlesHint" });
      const tier = selectEl([["2", "Tier 2 · smart account"], ["1", "Tier 1 · big influencer"]], lastTier, { id: "addTier" });
      tier.addEventListener("change", () => { lastTier = tier.value; });
      const count = h("span", { class: "small muted", "aria-live": "polite" });
      const submitLabel = h("span", null, "Add");
      const submit = h("button", { type: "button", class: "btn btn-primary", id: "addTargetsSubmit" }, icon("plus"), submitLabel);
      submit.addEventListener("click", () => {
        const rows = parseHandleList(text.value);
        if (!rows.length) { toast("Paste at least one @handle or x.com profile link.", { type: "warn" }); text.focus(); return; }
        busy(submit, async () => {
          const r = await ctx.send("targetsUpsert", { rows, defaults: { tier: Number(tier.value), source: "manual" }, overwrite: false }, { label: "Add targets" });
          if (!r) return;
          addedToast(r);
          text.value = ""; syncCount();
          if ((num(r.added) || num(r.updated)) && addSheet && addSheet.isOpen()) addSheet.close("added");
        });
      });
      const syncCount = () => { const n = parseHandleList(text.value).length; count.textContent = n ? `${plural(n, "account")} recognised` : ""; submitLabel.textContent = n ? `Add ${plural(n, "account")}` : "Add"; };
      text.addEventListener("input", syncCount);
      text.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit.click(); } });
      const file = h("input", { type: "file", accept: ".csv,.json,.txt,text/csv,application/json,text/plain", class: "sr-only", id: "importFile" });
      file.addEventListener("change", async () => {
        const fl = file.files && file.files[0];
        file.value = "";
        if (!fl) return;
        try {
          const raw = await readFileText(fl);
          const parsed = parseImport(raw);
          if (!parsed.length) { toast("No handles found in that file.", { type: "warn" }); return; }
          const ok = await confirmDialog(`Found ${plural(parsed.length, "account")} in ${fl.name}. Rows without a tier use tier ${tier.value}. ScoreX first checks who already follows you and only comments on accounts that don't. Import them?`, { title: "Import targets", okLabel: "Import" });
          if (!ok) return;
          const r = await ctx.send("targetsImport", { text: raw, defaults: { tier: Number(tier.value), source: "import" } }, { label: "Import" });
          if (r) { addedToast(r, `Imported ${num(r.parsed != null ? r.parsed : parsed.length)} rows: added`); if ((num(r.added) || num(r.updated)) && addSheet && addSheet.isOpen()) addSheet.close("added"); }
        } catch (err) { toast("Could not read the file: " + ((err && err.message) || err), { type: "error" }); }
      });
      const importLabel = h("label", { class: "btn btn-sm", for: "importFile", tabindex: "0", onKeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); file.click(); } } }, icon("upload"), h("span", null, "Import file…"));
      return h("div", { class: ["tg-add", inline && "tg-add-inline"] },
        h("div", { class: "stack-sm tg-add-paste" },
          h("label", { class: "field-label", for: "addHandles" }, "Handles or profile links"),
          text,
          h("div", { class: "field-hint", id: "addHandlesHint" }, "One per line or separated by commas. ", kbd("Ctrl"), " + ", kbd("Enter"), " adds them."),
          h("div", { class: "toolbar toolbar-end" }, labeled("Tier", tier), submit, count)),
        h("div", { class: "stack-sm tg-add-file" },
          h("span", { class: "cap" }, "From a file"),
          h("p", { class: "small muted" }, "CSV (handle, tier, tone, notes), JSON or a plain list. Rows without a tier use the Tier above."),
          h("div", { class: "toolbar" }, importLabel, file, btn("Export CSV", exportCsv, { iconName: "download", size: "sm", id: "exportTargetsBtn", title: "All targets with scores and stats", disabled: !list().length }))),
        h("p", { class: "small muted tg-add-note" }, "ScoreX first checks who already follows you and only comments on accounts that don't. ", h("a", { href: "#discover" }, "Find new targets on Discover"), "."));
    }
    function openAdd() {
      if (!list().length && !emptyHost.hidden) { const ta = emptyHost.querySelector("#addHandles"); if (ta) { ta.focus(); return; } }
      addSheet = sheet({ title: "Add targets", id: "addTargetsSheet", body: addForm(), initialFocus: "#addHandles", onClose: () => { addSheet = null; if (!disposed) drawEmpty(); } });
    }

    // ------------------------------------------------ Edit rules (sheet)
    function watchSummary() {
      const w = ctx.settings.watch || {};
      const iv = w.checkIntervalSec || {};
      return h("dl", { class: "kv" },
        h("dt", null, "Strategy"), h("dd", null, WATCH_LABEL[w.strategy] || w.strategy || "-"),
        w.strategy === "list" ? [h("dt", null, "List URLs"), h("dd", null, (w.listUrls || []).length ? plural(w.listUrls.length, "list") : h("span", { class: "text-amber" }, "None set"))] : null,
        w.strategy === "search" ? [h("dt", null, "Batch size"), h("dd", null, `${num(w.searchBatchSize)} accounts per search`)] : null,
        w.strategy === "rotation" ? [h("dt", null, "Per check"), h("dd", null, `${num(w.rotationPerTick)} profiles`)] : null,
        h("dt", null, "Check every"), h("dd", null, `${Math.round(num(iv.min) / 6) / 10}-${Math.round(num(iv.max) / 6) / 10} min`),
        h("dt", null, "Comment window"), h("dd", null, `${num(w.minPostAgeMin)}-${num(w.maxPostAgeMin)} min after a post`),
        h("dt", null, "Quote posts"), h("dd", null, w.includeQuotes ? "Included" : "Ignored"));
    }
    function openRules() {
      const giveUp = ctx.field({ path: "follow.giveUpDays", type: "number", label: "Remove after", suffix: "days", min: 3, max: 90, id: "giveUpDays", hint: "of comments without a follow-back (3-90)" });
      const autoRemove = ctx.field({ path: "follow.autoRemove", type: "toggle", label: "Remove accounts that don't follow back", id: "followAutoRemove" });
      const blacklist = ctx.field({ path: "follow.blacklist", type: "toggle", label: "Add removed accounts to the blacklist", id: "followBlacklist" });
      const sync = () => { const off = !(ctx.settings.follow && ctx.settings.follow.autoRemove); giveUp.control.disabled = off; blacklist.control.disabled = off; };
      sync();
      ctx.addRefresher(() => { if (!giveUp.isConnected) return false; sync(); return true; });
      const sec = (title, hint, ...kids) => h("div", { class: "tg-rules-sec" }, h("h3", { class: "sub-title" }, title), hint ? h("p", { class: "small muted" }, hint) : null, ...kids);
      rulesSheet = sheet({
        title: "Follow rules", id: "rulesSheet", initialFocus: "#giveUpDays",
        onClose: () => { rulesSheet = null; },
        body: [
          sec("When nobody follows back", "Accounts that follow you are never commented on, and comments stop as soon as someone follows back. The day counter starts with the first comment.",
            h("div", { class: "form-row" }, giveUp), autoRemove, blacklist),
          sec("Who goes first", null,
            ctx.field({ path: "targeting.useValue", type: "toggle", label: "Rank accounts by score × chance of a follow-back", id: "useValue", hint: "On: high-score accounts that often follow back get replies first. Off: the priority numbers decide. A priority you set by hand always stays." })),
          sec("Follow checks", "Checks run while the engine is idle, between comments, and use the same X tab.",
            h("div", { class: "form-row" },
              ctx.field({ path: "follow.scanEveryHours", type: "number", label: "Scan my followers every", suffix: "h", min: 1, max: 24, id: "followScanHours", hint: "Your newest followers, where follow-backs show up (1-24)" }),
              ctx.field({ path: "follow.recheckHours", type: "number", label: "Re-check commented accounts every", suffix: "h", min: 12, max: 336, id: "followRecheckHours", hint: "Profile visit for the \"Follows you\" badge (12-336)" }),
              ctx.field({ path: "follow.checksPerRun", type: "number", label: "Profile checks per run", min: 1, max: 8, id: "followChecksPerRun", hint: "Profile visits per idle check (1-8)" }))),
          sec("How follow detection works", null,
            h("ul", { class: "plain-list small", id: "followHow" },
              h("li", null, h("strong", null, "Checking"), ": new targets get no comments until ScoreX knows whether they follow you."),
              h("li", null, "ScoreX reads your followers list on X (one page shows many accounts with X's \"Follows you\" badge) and visits the profiles it could not place."),
              h("li", null, h("strong", null, "Follows you"), ": never commented on. ", h("strong", null, "Not following"), ": ScoreX comments on their posts."),
              h("li", null, h("strong", null, "Followed back"), ": comments stop at once, open queue items for that account are dropped."),
              h("li", null, "After the give-up days without a follow-back: one last profile check, then the account is removed (and blacklisted when that is on)."),
              h("li", null, "If X stops showing the \"Follows you\" badge, ScoreX stops for safety instead of guessing."))),
          sec("How accounts are ranked", null,
            h("ul", { class: "plain-list small" },
              h("li", null, h("strong", null, "ScoreX rank"), ": own 0-100 score from followers (40), engagement rate (25), activity (20) and quality (15). Bots and spam are penalised."),
              h("li", null, h("strong", null, "Score sites"), " (Sorsa, TwitterScore, Ethos, Moni): shown when turned on in ", h("a", { href: "#scores?view=providers" }, "Scores"), "."),
              h("li", null, h("strong", null, "Value"), ": the score times the chance of a follow-back, 0-100. ", h("strong", null, "Follows back?"), " is that chance: Often (50%+), Sometimes (20%+), Rarely.")),
            h("p", { class: "muted small" }, "Tier 1 = big influencer, tier 2 = smart account. Priority (0-100) decides who goes first when several targets post at once.")),
          sec("Watching for new posts", null, watchSummary(), h("a", { href: "#settings", class: "btn btn-sm tg-rules-link" }, "Edit in Settings")),
        ],
      });
    }

    // ------------------------------------------------ target drawer
    const drawerKey = (e) => {
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return false;
      const k = (e.key || "").toLowerCase();
      if (k !== "j" && k !== "k") return false;
      step(k === "j" ? 1 : -1);
      return true;
    };
    function step(dir) {
      const rows = tableWrap && tableWrap.isConnected ? tableWrap.visibleRows() : filtered();
      if (!rows.length) return;
      let i = rows.findIndex((t) => t.handle === openHandle);
      i = i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + dir));
      if (rows[i].handle === openHandle) { announce(dir > 0 ? "Last target" : "First target"); return; }
      openDrawer(rows[i].handle);
      announce(`@${rows[i].handle}`);
    }
    function markOpenRow() {
      if (!tableWrap) return;
      for (const tr of tableWrap.querySelectorAll("tbody tr")) {
        const on = !!openHandle && tr.dataset.key === openHandle;
        tr.classList.toggle("is-open", on);
        if (on) { tr.setAttribute("aria-current", "true"); tr.scrollIntoView({ block: "nearest" }); } else tr.removeAttribute("aria-current");
      }
    }
    function drawerTitle(t) {
      const name = t.name || (t.profile && t.profile.name) || "";
      const bio = (t.profile && t.profile.bio) || "";
      return h("span", { class: "tg-dw-title" },
        h("span", { class: "avatar tg-avatar", "aria-hidden": "true" }, (t.handle[0] || "?").toUpperCase()),
        h("span", { class: "tg-dw-id" },
          h("span", { class: "tg-dw-line" },
            h("a", { class: "handle", href: xUrl(t.handle), target: "_blank", rel: "noopener noreferrer", title: `Open @${t.handle} on X` }, "@" + t.handle, " ↗"),
            tierBadge(t.tier),
            t.profile && t.profile.verified ? h("span", { class: "verified", title: "Verified" }, icon("check")) : null),
          name || bio ? h("span", { class: "tg-dw-bio" }, [name, bio].filter(Boolean).join(" · ")) : null));
    }
    function drawerStatus(t) {
      const s = ctx.settings, st = fsOf(t), rel = t.rel || {};
      const d = followDay(t, s), days = followDays(t);
      const kids = [statusSquare(st === GONE ? "red" : FS_COLOR[st] || "grey", st === GONE ? "Not found" : FS_LABEL[st] || st, { cls: "tg-dw-fs" })];
      if (d) {
        kids.push(h("span", { class: ["mono", "small", "tg-day", d.near && "is-near"] }, `day ${d.day} of ${d.of}`), dayMeter(t, s));
        if (days === 0) kids.push(h("span", { class: "small muted" }, "first comment today"));
      } else if (st === FS.ACTIVE) kids.push(h("span", { class: "small muted" }, `no comments yet; the ${(s.follow && s.follow.giveUpDays) || 14} days start with the first one`));
      else if (st === FS.FOLLOWED_BACK && rel.followedBackAt) kids.push(h("span", { class: "small muted mono" }, "on " + fmtDay(rel.followedBackAt)));
      kids.push(toggleEl("Enabled", isOn(t), (v) => patchTarget(t.handle, { enabled: v }, v ? "Turn on" : "Turn off"), { id: "dwEnabled", title: "Off: never checked or commented on" }));
      return h("div", { class: "tg-dw-status" }, kids);
    }
    function fillProfile(t) {
      const p = t.profile || {}, sc = t.score || {};
      const cell = (k, v, title) => h("div", { title: title || null }, h("span", { class: "cap" }, k), h("span", { class: "v" }, v == null || v === "" ? "-" : v));
      const flags = Array.isArray(sc.flags) ? sc.flags : [];
      fill(dw.profile,
        h("span", { class: "cap" }, "Profile"),
        h("div", { class: "kv-ledger" },
          cell("Followers", fmtFollowers(numOrNull(p.followers)), p.followers != null ? fmtNum(p.followers) : null),
          cell("Following", p.following != null ? fmtNum(p.following) : "-"),
          cell("Posts / day", numOrNull(sc.postsPerDay) != null ? String(sc.postsPerDay) : "-"),
          cell("Last post", t.lastPostAt ? fmtAgo(t.lastPostAt).replace(/ ago$/, "") : "-", t.lastPostAt ? fmtDateTime(t.lastPostAt) : null)),
        flags.length || sc.bot ? h("div", { class: "tg-flags" }, sc.bot ? tag("looks like a bot", "red") : null, flags.map((x) => tag(String(x).replace(/_/g, " "), "amber", "Spam / bot signal"))) : null,
        p.updatedAt ? h("p", { class: "small muted" }, `Profile read ${fmtAgo(p.updatedAt)}`) : null);
    }
    function drawScores(t) {
      if (!dw) return;
      const b = board(), ids = enabledProviders(ctx.settings);
      const checkBtn = ids.length ? btn("Check now", (e) => busy(e.currentTarget, async () => {
        const r = await ctx.send("scoreCheck", { handle: t.handle }, { label: "Check scores" });
        if (!r) return;
        const res = Object.entries(r.results || {});
        const errs = res.filter(([, x]) => x && x.error), ok = res.filter(([, x]) => x && x.score != null);
        if (errs.length && !ok.length) toast("Could not check: " + errs.map(([id, x]) => `${providerName(id)}: ${x.error}`).join("; "), { type: "error" });
        else toast(`Checked @${t.handle}${errs.length ? ` (${plural(errs.length, "site")} failed)` : ""}`, { type: errs.length ? "warn" : "success" });
        if (dw && openHandle === t.handle) drawScores(ctx.targets[t.handle] || t);
      }), { size: "xs", iconName: "refresh", id: "dwCheckBtn", title: `Asks each score site once: ${plural(ids.length, "request")}` }) : null;
      const rows = ids.map((id) => {
        const p = provScore(t, id, b);
        const has = p && p.score != null;
        return h("div", { class: "prov-row" }, providerKey(id), h("span", null, providerName(id)),
          has ? h("span", { class: "v" }, fmtNum(p.score), p.max ? h("span", { class: "tg-of" }, "/" + fmtNum(p.max)) : null)
            : p && p.error ? h("span", { class: "small text-red", title: p.error }, "error") : h("span", { class: "v muted" }, "-"),
          has && p.max ? barInCell(p.score, p.max, { w: 70, label: `${providerName(id)} ${p.score} of ${p.max}` }) : h("span"),
          h("span", { class: "small muted tg-age" }, p && p.at ? fmtAgo(p.at) : p ? "" : "not checked"));
      });
      const own = S.own(t), parts = t.score && t.score.parts;
      const pct = (v) => Math.round((Number(v) || 0) * 100) + "%";
      const v = S.value(t), pr = S.prop(t), why = S.why(t);
      fill(dw.scores,
        h("div", { class: "tg-sec-head" }, h("span", { class: "cap" }, "Scores"), h("span", { class: "spacer" }), ids.length ? h("span", { class: "small muted" }, plural(ids.length, "request")) : null, checkBtn),
        ids.length ? rows : h("p", { class: "small muted" }, "No score sites are on. ", h("a", { href: "#scores?view=providers" }, "Connect one on Scores"), "."),
        h("div", { class: "tg-rank" },
          h("div", { class: "small" }, "ScoreX rank ", h("b", { class: "mono" }, own == null ? "-" : String(Math.round(own))),
            h("span", { class: "muted" }, " · weights: " + RANK_W.map(([k, w]) => `${k} ${w}`).join(" · "))),
          parts ? partsBar([
            { label: "Reach", value: parts.reach, weight: 40 }, { label: "Engagement", value: parts.engagement, weight: 25 },
            { label: "Activity", value: parts.activity, weight: 20 }, { label: "Quality", value: parts.quality, weight: 15 }],
          { label: `ScoreX rank parts: reach ${pct(parts.reach)}, engagement ${pct(parts.engagement)}, activity ${pct(parts.activity)}, quality ${pct(parts.quality)}` }) : null),
        h("div", { class: "tg-val small" },
          h("span", null, "Value ", h("b", { class: "mono" }, v == null ? "-" : String(Math.round(v))), v == null ? null : h("span", { class: "muted" }, " of 100")),
          h("span", { class: "muted" }, " · follows back "), propChip(pr), pr != null ? h("span", { class: "muted mono" }, ` ${Math.round(pr * 100)}%`) : null,
          why ? h("div", { class: "muted tg-why" }, why) : null));
    }
    function timelineItems(t, recs) {
      const s = ctx.settings, fl = s.follow || {}, now = Date.now(), rel = t.rel || {}, st = fsOf(t);
      const giveUp = Math.max(1, Number(fl.giveUpDays) || 14);
      const items = [];
      const first = t.stats && t.stats.firstCommentAt;
      if (st === FS.ACTIVE && first) {
        const at = first + giveUp * DAY;
        items.push({ at, cls: "next", when: fmtDay(at), what: fl.autoRemove === false ? `Day ${giveUp}: automatic removal is off, so ScoreX keeps commenting` : `Give-up day: last profile check, then removed${fl.blacklist === false ? "" : " and blacklisted"} if they still don't follow you` });
      }
      if (t.coldUntil && t.coldUntil > now) items.push({ at: t.coldUntil, cls: "next", when: fmtDay(t.coldUntil), what: "Cooling down until then: no response to recent comments" });
      if (rel.followedBackAt) items.push({ at: rel.followedBackAt, cls: "fb", when: fmtDateTime(rel.followedBackAt), what: "Followed you back. Comments stopped." });
      if (rel.gone) items.push({ at: rel.checkedAt || t.lastCheckedAt || now, cls: "bad", when: fmtDateTime(rel.checkedAt || t.lastCheckedAt || now), what: "Profile not found on X (renamed, suspended or deleted). Turned off." });
      else if (rel.checkedAt) items.push({ at: rel.checkedAt, cls: "", when: fmtDateTime(rel.checkedAt), what: `Follow check: ${rel.followsYou === true ? "follows you" : rel.followsYou === false ? "does not follow you" : "not known yet"}` });
      if (Array.isArray(t.events)) {
        for (const ev of t.events.slice(-40)) {
          const at = Number(ev && (ev.at || ev.ts)), text = ev && (ev.text || ev.label || ev.message || ev.type);
          if (at && text && typeof text === "string") items.push({ at, cls: /followed_back/.test(String(ev.type)) ? "fb" : "", when: fmtDateTime(at), what: text });
        }
      }
      const sorted = (recs || []).filter((r) => r && (r.postedAt || r.createdAt)).sort((a, c) => (a.postedAt || a.createdAt) - (c.postedAt || c.createdAt));
      let n = 0;
      for (const r of sorted) {
        const at = r.postedAt || r.createdAt;
        const post = r.postText ? `“${truncate(String(r.postText).replace(/\s+/g, " "), 90)}”` : "a post";
        const links = [[safeUrl(r.replyUrl), "Your reply"], [safeUrl(r.postUrl), "Post"]];
        if (r.status === HS.POSTED) {
          n++;
          const res = r.results || {};
          const tags = [];
          if (res.likes != null) tags.push(tag(`${fmtNum(res.likes)} ♥`, "", `${fmtNum(res.likes)} like${res.likes === 1 ? "" : "s"} on your reply`));
          if (res.replies != null) tags.push(tag(res.replies === 1 ? "1 reply" : `${fmtNum(res.replies)} replies`));
          if (numOrNull(res.views) != null) tags.push(tag(`${fmtShort(res.views)} views`));
          if (res.authorReplied) tags.push(tag("author replied", "green"));
          if (res.followedBack) tags.push(tag("followed back", "green"));
          items.push({ at, cls: "c", when: fmtDateTime(at), what: `Comment ${n} on ${post}`, text: r.comment, links, res: tags });
        } else if ([HS.PENDING_REVIEW, HS.APPROVED, HS.QUEUED, HS.POSTING].includes(r.status)) {
          const word = r.status === HS.PENDING_REVIEW ? "Reply waiting for review" : r.status === HS.POSTING ? "Posting a reply" : "Reply queued";
          items.push({ at, cls: "", when: fmtDateTime(at), what: `${word} on ${post}`, text: r.comment, links: [[safeUrl(r.postUrl), "Post"]], res: r.status === HS.PENDING_REVIEW ? [h("a", { href: "#review", class: "small" }, "Open Review")] : [] });
        } else if (r.status === HS.FAILED) items.push({ at, cls: "bad", when: fmtDateTime(at), what: `Could not post on ${post}${r.reason ? ": " + r.reason : ""}`, links: [[safeUrl(r.postUrl), "Post"]] });
        else if (r.status === HS.SKIPPED) items.push({ at, cls: "", when: fmtDateTime(at), what: `Skipped ${post}${r.reason ? ": " + r.reason : ""}` });
      }
      if (t.addedAt) items.push({ at: t.addedAt, cls: "", when: fmtDateTime(t.addedAt), what: addedText(t) });
      items.sort((a, c) => c.at - a.at);
      const MAX = 80;
      const out = items.slice(0, MAX).map((it) => h("li", { class: it.cls || null },
        h("span", { class: "when" }, it.when),
        h("span", { class: "what" }, it.what),
        it.text ? h("span", { class: "tg-tl-text" }, String(it.text)) : null,
        (it.res && it.res.length) || (it.links && it.links.some((l) => l[0])) ? h("span", { class: "res" }, it.res || [],
          (it.links || []).filter((l) => l[0]).map(([href, label]) => h("a", { href, target: "_blank", rel: "noopener noreferrer", class: "small tg-tl-link" }, label + " ↗"))) : null));
      if (items.length > MAX) out.push(h("li", { class: "tg-tl-more" }, h("span", { class: "what muted" }, `${fmtNum(items.length - MAX)} older entries: see `, h("a", { href: "#results" }, "Results"), ".")));
      return out;
    }
    async function loadTimeline(handle) {
      const seq = ++tlSeq;
      let recs = null;
      try { recs = await history.byTarget(handle); } catch (e) { console.warn("[ScoreX] history.byTarget failed", e); }
      if (seq !== tlSeq || openHandle !== handle || !dw) return;
      if (recs) tlCache.set(handle, recs);
      const t = ctx.targets[handle];
      if (t) fill(dw.timeline, timelineItems(t, tlCache.get(handle) || []));
    }
    function editorsSec(t) {
      const s = ctx.settings, hd = t.handle;
      const tier = selectEl([["1", "Tier 1 · big influencer"], ["2", "Tier 2 · smart account"]], String(Number(t.tier) === 1 ? 1 : 2), { id: "dwTier" });
      tier.addEventListener("change", () => patchTarget(hd, { tier: Number(tier.value) }, "Save tier"));
      const tone = selectEl(toneOptions(t), t.tone || "", { id: "dwTone" });
      tone.addEventListener("change", () => patchTarget(hd, { tone: tone.value }, "Save tone"));
      const m = s.presetMatrix && s.presetMatrix[`B${Number(t.tier) === 1 ? 1 : 2}`];
      const preset = selectEl([["", `Tier preset (${PRESET_LABEL[m] || m || "Balanced"})`], ...PRESET_KEYS.map((k) => [k, PRESET_LABEL[k] || k])], t.preset || "", { id: "dwPreset" });
      preset.addEventListener("change", () => patchTarget(hd, { preset: preset.value }, "Save preset"));
      const prioOut = h("output", { class: "mono", for: "dwPriority" }, String(num(t.priority, 50)));
      const prio = h("input", { type: "range", id: "dwPriority", min: "0", max: "100", step: "1", value: String(num(t.priority, 50)), "aria-describedby": "dwPriorityHint" });
      prio.addEventListener("input", () => { prioOut.textContent = prio.value; });
      prio.addEventListener("change", () => patchTarget(hd, { priority: Number(prio.value) }, "Save priority"));
      const notes = h("textarea", { class: "input", id: "dwNotes", rows: 3, maxlength: "500", placeholder: "Only for you; never sent to the model" });
      notes.value = t.notes || "";
      let savedNotes = notes.value;
      const saveNotes = () => { if (notes.value === savedNotes) return; savedNotes = notes.value; patchTarget(hd, { notes: notes.value }, "Save notes"); };
      const saveNotesSoon = debounce(saveNotes, 900);
      notes.addEventListener("input", () => saveNotesSoon());
      notes.addEventListener("change", () => { saveNotesSoon.cancel(); saveNotes(); });
      const el = h("div", { class: "drawer-sec tg-edit" },
        h("span", { class: "cap" }, "For this account"),
        h("div", { class: "tg-edit-grid" }, labeled("Tier", tier), labeled("Tone", tone), labeled("Model preset", preset),
          h("div", { class: "field" }, h("label", { class: "field-label", for: "dwPriority" }, "Priority ", prioOut), prio,
            h("div", { class: "field-hint", id: "dwPriorityHint" }, "Who goes first when several targets post at once. A priority you set stays."))),
        labeled("Notes", notes),
        h("p", { class: "small muted" }, "Each change saves at once."));
      // Live update: put stored values back into controls that are not being edited.
      el.update = (nt) => {
        const ae = document.activeElement;
        if (ae !== tier) tier.value = String(Number(nt.tier) === 1 ? 1 : 2);
        if (ae !== tone) { if (nt.tone && ![...tone.options].some((o) => o.value === nt.tone)) tone.appendChild(h("option", { value: nt.tone }, toneLabel(nt.tone, ctx.settings))); tone.value = nt.tone || ""; }
        if (ae !== preset) preset.value = nt.preset || "";
        if (ae !== prio) { prio.value = String(num(nt.priority, 50)); prioOut.textContent = prio.value; }
        if (ae !== notes && !saveNotesSoon.pending()) { notes.value = nt.notes || ""; savedNotes = notes.value; }
      };
      return el;
    }
    function actionsSec(t) {
      const hd = t.handle;
      const gone = (verb) => { removing.add(hd); toast(`${verb} @${hd}`, { type: "success" }); if (dr && openHandle === hd) dr.close("removed"); };
      return h("div", { class: "drawer-sec tg-actions" },
        h("span", { class: "cap" }, "Actions"),
        h("div", { class: "toolbar" },
          h("a", { class: "btn btn-sm", href: `#discover?h=${encodeURIComponent(hd)}`, id: "dwSmartBtn" }, icon("discover"), h("span", null, "Find their smart followers")),
          btn("Re-check follow status", (e) => busy(e.currentTarget, async () => {
            const r = await ctx.send("targetRefresh", { handles: [hd] }, { label: "Re-check" });
            if (r) toast(`Re-check queued for @${hd} (follow status and profile)`, { type: "success" });
          }), { size: "sm", iconName: "refresh", id: "dwRecheckBtn" }),
          h("a", { class: "btn btn-sm", href: xUrl(hd), target: "_blank", rel: "noopener noreferrer", id: "dwOpenX" }, icon("external"), h("span", null, "Open on X"))),
        h("div", { class: "toolbar" },
          btn("Blacklist", async () => {
            if (!(await confirmDialog(`Blacklist @${hd}? It is removed from your targets and never added again by paste, import or discovery. Its history stays, and you can undo this in the Blacklist.`, { title: "Blacklist target", okLabel: "Blacklist", danger: true }))) return;
            const r = await ctx.send("blacklistAdd", { handles: [hd] }, { label: "Blacklist" });
            if (r) gone("Blacklisted");
          }, { size: "sm", kind: "danger-soft", iconName: "ban", id: "dwBlacklistBtn" }),
          btn("Remove", async () => {
            if (!(await confirmDialog(`Remove @${hd} from your targets? Its history stays.`, { title: "Remove target", okLabel: "Remove", danger: true }))) return;
            const r = await ctx.send("targetsRemove", { handles: [hd] }, { label: "Remove" });
            if (r) { selected.delete(hd); gone("Removed"); }
          }, { size: "sm", kind: "ghost-danger", iconName: "trash", id: "dwRemoveBtn" })));
    }
    function openDrawer(handle) {
      const hd = normalizeHandle(handle) || String(handle || "");
      const t = ctx.targets[hd];
      if (!t) { toast(`@${hd} is not one of your targets.`, { type: "warn" }); if (ctx.params.h) ctx.setParams({ h: null }); return; }
      if (view !== "targets") showView("targets", false);
      const tlSec = h("div", { class: "drawer-sec" }, h("span", { class: "cap" }, "Follow timeline and comments"),
        h("ul", { class: "tl tg-tl", id: "dwTimeline", "aria-label": "Follow timeline and comments, newest first" }));
      dw = { profile: h("div", { class: "drawer-sec", id: "dwProfile" }), scores: h("div", { class: "drawer-sec", id: "dwScores" }), timeline: tlSec.querySelector("ul"), edit: editorsSec(t), actions: actionsSec(t) };
      openHandle = hd;
      fillProfile(t);
      drawScores(t);
      fill(dw.timeline, timelineItems(t, tlCache.get(hd) || []));
      const body = [dw.profile, dw.scores, tlSec, dw.edit, dw.actions];
      const keepFocus = dr && dr.isOpen() && dr.el.contains(document.activeElement);
      if (dr && dr.isOpen()) {
        dr.setTitle(drawerTitle(t)); dr.setHead(drawerStatus(t)); dr.setBody(...body);
        dr.el.setAttribute("aria-label", `@${hd} details`);
        if (keepFocus && !dr.el.contains(document.activeElement)) dr.el.querySelector(".drawer-close").focus({ preventScroll: true });
      } else {
        dr = drawer({ title: drawerTitle(t), head: drawerStatus(t), body, id: "targetDrawer", cls: "tg-drawer", label: `@${hd} details`, onKey: drawerKey, onClose: onDrawerClose });
      }
      if (ctx.params.h !== hd) ctx.setParams({ h: hd });
      markOpenRow();
      loadTimeline(hd);
    }
    function onDrawerClose(reason) {
      const hd = openHandle;
      dr = null; openHandle = null; dw = null; tlSeq++;
      if (disposed) return;
      markOpenRow();
      if (ctx.params.h) ctx.setParams({ h: null });
      if (reason !== "replaced" && hd && tableWrap && tableWrap.isConnected && tableWrap.rowEl(hd)) tableWrap.focusRow(hd);
    }
    function refreshDrawer() {
      if (!dr || !dr.isOpen() || !openHandle || !dw) return;
      const t = ctx.targets[openHandle];
      if (!t) {
        const hd = openHandle;
        dr.close("removed");
        if (!removing.has(hd)) toast(`@${hd} is no longer one of your targets.`, { type: "warn" });
        removing.delete(hd);
        return;
      }
      const ae = document.activeElement;
      const titleEl = dr.el.querySelector(".drawer-title");
      if (!(titleEl && titleEl.contains(ae))) dr.setTitle(drawerTitle(t));
      if (!dr.head.contains(ae)) dr.setHead(drawerStatus(t));
      fillProfile(t);
      if (!dw.scores.contains(ae)) drawScores(t);
      dw.edit.update(t);
      loadTimeline(openHandle);
    }

    // ------------------------------------------------ blacklist sub-view
    const blSelected = new Set();
    const blSort = { key: "at", dir: "desc" };
    let blRev = 0;
    const blBar = h("div", { class: "toolbar tg-bl-bar" });
    const blHost = h("div", { id: "blacklistTable" });
    const blText = h("textarea", { class: "input", id: "blacklistText", rows: 2, spellcheck: "false", placeholder: "@spam_account, https://x.com/someone" });
    const blCountLine = h("span", { class: "muted small", id: "blacklistCount" });
    const blList = () => Object.values(ctx.data[K.blacklist] || {}).filter((e) => e && e.handle);
    const blReason = (e) => (e.reason === "no_followback" ? (e.days != null ? `No follow-back after ${e.days} day${e.days === 1 ? "" : "s"}` : "No follow-back") : e.reason === "manual" ? "Added by you" : e.reason || "-");
    function drawBlBar() {
      const n = blSelected.size;
      fill(blBar,
        h("span", { class: "muted small" }, n ? `${fmtNum(n)} selected` : "Select accounts to allow them again"),
        btn("Remove from blacklist", (e) => busy(e.currentTarget, async () => {
          const r = await ctx.send("blacklistRemove", { handles: [...blSelected] }, { label: "Remove from blacklist" });
          if (r) { toast(`Removed ${num(r.removed, n)} from the blacklist`, { type: "success" }); blSelected.clear(); drawBlacklist(true); }
        }), { size: "sm", disabled: !n, id: "blacklistRemoveBtn" }));
    }
    function drawBlacklist(force) {
      const all = blList();
      for (const hd of [...blSelected]) if (!all.some((e) => e.handle === hd)) blSelected.delete(hd);
      blCountLine.textContent = all.length ? `${plural(all.length, "account")} ScoreX never adds again` : "Nobody is blacklisted.";
      drawBlBar();
      stableTable(blHost, {
        signature: force ? null : String(blRev),
        caption: "Blacklist",
        columns: [
          { key: "handle", label: "Account", render: (e) => h("a", { class: "handle-link", href: xUrl(e.handle), target: "_blank", rel: "noopener noreferrer" }, "@" + e.handle), sort: (e) => e.handle, defaultDir: "asc" },
          { key: "name", label: "Name", render: (e) => h("span", { class: "cell-name" }, e.name || "-"), sort: (e) => String(e.name || "").toLowerCase(), defaultDir: "asc" },
          { key: "reason", label: "Reason", render: blReason, sort: blReason, defaultDir: "asc" },
          { key: "at", label: "Added", render: (e) => (e.at ? h("span", { class: "nowrap", title: fmtDateTime(e.at) }, fmtDate(e.at)) : "-"), sort: (e) => e.at || 0 },
          { key: "comments", label: "Comments", align: "right", render: (e) => String(num(e.comments)), sort: (e) => num(e.comments) },
        ],
        rows: all,
        rowKey: (e) => e.handle,
        selection: blSelected,
        onSelectionChange: drawBlBar,
        sortState: blSort,
        maxRows: 100,
        empty: "No blacklisted accounts. Accounts removed for not following back are added here automatically (see the follow rules).",
      });
    }
    const blAddBtn = btn("Add to blacklist", (e) => {
      const handles = parseHandleList(blText.value);
      if (!handles.length) { toast("Paste at least one @handle or x.com profile link.", { type: "warn" }); blText.focus(); return; }
      busy(e.currentTarget, async () => {
        const inTargets = handles.filter((hd) => Object.hasOwn(ctx.targets, hd)).length;
        if (inTargets && !(await confirmDialog(`${inTargets} of these ${inTargets === 1 ? "is a target and is" : "are targets and are"} removed from your targets. Continue?`, { title: "Add to blacklist", okLabel: "Blacklist", danger: true }))) return;
        const r = await ctx.send("blacklistAdd", { handles }, { label: "Add to blacklist" });
        if (r) { toast(`Blacklisted ${handles.length}${num(r.removedTargets) ? ` (${num(r.removedTargets)} removed from targets)` : ""}`, { type: "success" }); blText.value = ""; }
      });
    }, { size: "sm", iconName: "plus", id: "blacklistAddBtn" });
    function blExport() {
      const all = blList();
      if (!all.length) { toast("The blacklist is empty.", { type: "warn" }); return; }
      download(`scorex-blacklist-${stamp()}.csv`, toCsv(all.sort((a, b) => a.handle.localeCompare(b.handle)), [
        { key: "handle", label: "handle" }, { key: "name", label: "name" },
        { key: "reason", label: "reason", get: blReason },
        { key: "at", label: "added", get: (e) => (e.at ? new Date(e.at).toISOString() : "") },
        { key: "days", label: "days", get: (e) => (e.days != null ? e.days : "") },
        { key: "comments", label: "comments", get: (e) => num(e.comments) },
        { key: "tier", label: "tier", get: (e) => e.tier || "" },
        { key: "followers", label: "followers", get: (e) => (e.followers != null ? e.followers : "") },
      ]), "text/csv");
    }
    const blBack = h("button", { type: "button", class: "btn btn-sm btn-ghost tg-back", id: "blacklistBackBtn", onClick: () => showView("targets", true) }, h("span", { "aria-hidden": "true" }, "‹"), h("span", null, "All targets"));
    const blPane = h("div", { class: "tg-bl", id: "blacklistView", hidden: true },
      h("div", { class: "tg-bl-top" }, blBack),
      h("div", { class: "filterbar tg-bl-head" },
        h("h2", { class: "sec-title", tabindex: "-1", id: "blacklistTitle" }, "Blacklist"), blCountLine, h("span", { class: "spacer" }),
        btn("Export CSV", blExport, { size: "sm", iconName: "download", id: "blacklistExportBtn" })),
      h("p", { class: "small muted" }, "Never added again by paste, import or discovery. With the follow rule on, accounts removed for not following back land here too."),
      h("div", { class: "tg-bl-add" },
        h("label", { class: "field-label", for: "blacklistText" }, "Add accounts"),
        h("div", { class: "tg-bl-add-row" }, blText, blAddBtn),
        h("div", { class: "field-hint" }, "One per line or comma separated. They are also removed from your targets.")),
      blBar, blHost);

    // ------------------------------------------------ views + routing (#targets?view=blacklist, #targets?h=handle)
    const targetsPane = h("div", { class: "tg-main", id: "targetsView" }, head, emptyHost, tools, tableHost, bulkBar, foot);
    function showView(v, user) {
      const next = v === "blacklist" ? "blacklist" : "targets";
      if (next !== view && dr && dr.isOpen()) dr.close("view");
      view = next;
      targetsPane.hidden = view !== "targets";
      blPane.hidden = view !== "blacklist";
      if (user) ctx.setParams({ view: view === "blacklist" ? "blacklist" : null, h: null }, { push: true });
      if (view === "targets") { drawTable(true); drawFoot(); if (user) blViewBtn.focus(); }
      else { drawBlacklist(true); if (user) document.getElementById("blacklistTitle").focus(); }
    }
    function applyParams(q) {
      const p = q || {};
      const v = p.view === "blacklist" ? "blacklist" : "targets";
      if (v !== view) showView(v, false);
      if (v === "targets" && p.h) { const hd = normalizeHandle(p.h) || p.h; if (hd !== openHandle) openDrawer(hd); }
      else if (dr && dr.isOpen()) dr.close("params");
    }

    root.append(targetsPane, blPane);
    buildColsMenu();
    drawCounts();
    drawEmpty();
    drawTable(true);
    drawFoot();
    drawBlacklist(true);

    const onDocKey = (e) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || isTyping(e) || hasOverlay() || view !== "targets" || tools.hidden || !search.isConnected) return;
      e.preventDefault();
      search.focus();
      search.select();
    };
    document.addEventListener("keydown", onDocKey);
    ctx.onDispose(() => {
      disposed = true;
      document.removeEventListener("keydown", onDocKey);
      for (const o of [dr, addSheet, rulesSheet]) if (o && o.isOpen()) o.close("dispose");
    });

    let checksSig = "";
    const boardSig = () => { const c = board().checks || {}; let at = 0; for (const k in c) at = Math.max(at, Number(c[k] && c[k].at) || 0); return Object.keys(c).length + ":" + at; };
    checksSig = boardSig();
    ctx.on(K.targets, () => { dataRev++; drawCounts(); drawEmpty(); drawTable(); drawFoot(); refreshDrawer(); });
    ctx.on(K.blacklist, () => { blRev++; drawCounts(); drawBlacklist(); });
    ctx.on(K.scoreboard, () => {
      const sig = boardSig();
      if (sig === checksSig) return;
      checksSig = sig; dataRev++; drawTable();
      if (dw && openHandle && ctx.targets[openHandle] && !dw.scores.contains(document.activeElement)) drawScores(ctx.targets[openHandle]);
    });
    ctx.on("settings", () => {
      if (enabledProviders(ctx.settings).join(",") !== provIds.join(",")) buildColsMenu();
      dataRev++; drawCounts(); drawTable(); drawFoot(); refreshDrawer();
      if (selected.size) drawBulk(true);
    });
    ctx.on("tick", () => { if (Date.now() - lastTickDraw < 10 * 60e3) return; lastTickDraw = Date.now(); dataRev++; drawTable(); });
    ctx.on("params", applyParams);
    applyParams(ctx.params);
  },
};

// Follow status order for sorting: not following (closest to the give-up day first), checking, followed back,
// follows you; profiles not found last.
const FS_ORDER = { [FS.ACTIVE]: 1, [FS.CHECKING]: 2, [FS.FOLLOWED_BACK]: 3, [FS.FOLLOWS]: 4 };
function followSortKey(t) {
  if (t.rel && t.rel.gone) return 9;
  const st = followStatus(t);
  const days = st === FS.ACTIVE ? followDays(t) : null;
  return (FS_ORDER[st] || 5) - (days != null ? Math.min(days, 999) / 1000 : 0);
}

// Kept for other screens that show a 0-100 score with the old chip style.
export function scoreChip(v) {
  if (v == null || !Number.isFinite(Number(v))) return h("span", { class: "muted" }, "-");
  const n = Math.round(Number(v));
  return h("span", { class: ["score", n >= 75 ? "score-hi" : n >= 50 ? "score-mid" : "score-lo"] }, String(n));
}
