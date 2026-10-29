// Targets tab: add / import / export targets, the targets table with inline edits and bulk actions,
// discovery of new accounts and the candidates list. All target changes go through messages.

import { K, PRESET_KEYS } from "../../lib/constants.js";
import { parseHandleList, toCsv, num } from "../../lib/util.js";
import { parseImport, allToneKeys } from "../../lib/targets.js";
import { h, clear, card, btn, busy, toast, icon, renderTable, groupBadge, tierBadge, badge, xLink, selectEl, toggleEl, labeled, confirmDialog, download, readFileText, stamp, progressBar, fmtCount, fmtAgo, fmtDate, fmtDateTime, debounce, truncate, add, fill } from "../components.js";

// Values match lib/discovery.js sourceUrls().
const SOURCES = [
  ["myFollowers", "My followers (group A candidates)"],
  ["followersOf", "Followers of @account"],
  ["followingOf", "Following of @account"],
  ["search", "Keyword search (people)"],
  ["common", "Common follows of several smart accounts"],
];
const WATCH_LABEL = { list: "X List (recommended)", search: "Batched Latest search", rotation: "Profile rotation" };

export function toneLabel(key, settings) {
  if (!key) return "Group default";
  if (key === "custom") return "Custom text";
  if (key.startsWith("custom:")) {
    const c = (settings.customTones || []).find((x) => "custom:" + x.id === key);
    return c ? c.name || "Custom tone" : "Custom (missing)";
  }
  return key.charAt(0).toUpperCase() + key.slice(1);
}

// Candidate field accessors (the worker owns the shape; read defensively).
const C = {
  followers: (c) => (c.followers != null ? c.followers : c.profile && c.profile.followers),
  name: (c) => c.name || (c.profile && c.profile.name) || "",
  score: (c) => (typeof c.score === "number" ? c.score : c.score ? (c.score.combined != null ? c.score.combined : c.score.own) : null),
  flags: (c) => c.flags || (c.score && c.score.flags) || [],
  overlap: (c) => (c.overlap != null ? c.overlap : c.overlapCount != null ? c.overlapCount : null),
  sources: (c) => (Array.isArray(c.sources) ? c.sources : c.source ? [c.source] : []),
  tier: (c) => Number(c.suggestedTier || c.tier) || null,
  group: (c) => c.suggestedGroup || c.group || (c.followsYou || (c.rel && c.rel.followsYou) ? "A" : null),
  pass: (c) => (c.pass != null ? c.pass : c.filter ? c.filter.pass : null),
  why: (c) => c.why || (c.filter && c.filter.why) || [],
};

export default {
  id: "targets",
  title: "Targets",
  icon: "targets",
  async render(root, ctx) {
    const selected = new Set();
    const candSelected = new Set();
    const sortState = { key: "priority", dir: "desc" };
    const candSort = { key: "score", dir: "desc" };
    const f = { q: "", group: "", tier: "", enabled: "" };
    const cf = { q: "", passOnly: false };

    // ------------------------------------------------ summary
    const summary = h("div", { class: "summary-row", id: "targetsSummary" });

    // ------------------------------------------------ add / import / export
    const addText = h("textarea", { class: "input", id: "addHandles", rows: 4, placeholder: "@naval\nhttps://x.com/balajis\nvitalikbuterin, paulg" });
    const addGroup = selectEl([["B", "Group B - does not follow me (get noticed)"], ["A", "Group A - follows me (keep warm)"]], "B", { id: "addGroup" });
    const addTier = selectEl([["2", "Tier 2 - smart account"], ["1", "Tier 1 - big influencer"]], "2", { id: "addTier" });
    const addCount = h("span", { class: "muted small" });
    addText.addEventListener("input", () => { const n = parseHandleList(addText.value).length; addCount.textContent = n ? `${n} account${n === 1 ? "" : "s"} recognised` : ""; });
    const addBtn = btn("Add", async (e) => {
      const rows = parseHandleList(addText.value);
      if (!rows.length) { toast("Paste at least one @handle or x.com profile link.", { type: "warn" }); return; }
      const b = e.currentTarget;
      await busy(b, async () => {
        const r = await ctx.send("targetsUpsert", { rows, defaults: { group: addGroup.value, tier: Number(addTier.value), source: "manual" }, overwrite: false }, { label: "Add targets" });
        if (r) { toast(`Added ${num(r.added)}, updated ${num(r.updated)}`, { type: "success" }); addText.value = ""; addCount.textContent = ""; }
      });
    }, { kind: "primary", iconName: "plus", id: "addTargetsBtn" });

    const fileInput = h("input", { type: "file", accept: ".csv,.json,.txt,text/csv,application/json,text/plain", class: "sr-only", id: "importFile" });
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (!file) return;
      try {
        const text = await readFileText(file);
        const parsed = parseImport(text);
        if (!parsed.length) { toast("No handles found in that file.", { type: "warn" }); return; }
        const ok = await confirmDialog(`Found ${parsed.length} account${parsed.length === 1 ? "" : "s"} in ${file.name}. Rows without a group/tier use ${addGroup.value === "A" ? "group A" : "group B"} / tier ${addTier.value}. Import them?`, { title: "Import targets", okLabel: "Import" });
        if (!ok) return;
        const r = await ctx.send("targetsImport", { text, defaults: { group: addGroup.value, tier: Number(addTier.value), source: "import" } }, { label: "Import" });
        if (r) toast(`Imported: ${num(r.added)} added, ${num(r.updated)} updated (${num(r.parsed != null ? r.parsed : parsed.length)} rows)`, { type: "success" });
      } catch (err) { toast("Could not read the file: " + err.message, { type: "error" }); }
    });

    const exportCsv = () => {
      const list = ctx.targetList();
      if (!list.length) { toast("No targets to export.", { type: "warn" }); return; }
      const cols = [
        { key: "handle", label: "handle" }, { key: "name", label: "name" }, { key: "group", label: "group" }, { key: "tier", label: "tier" },
        { key: "enabled", label: "enabled", get: (t) => (t.enabled !== false ? "yes" : "no") }, { key: "tone", label: "tone" }, { key: "preset", label: "preset" },
        { key: "priority", label: "priority" }, { key: "followers", label: "followers", get: (t) => (t.profile && t.profile.followers) || "" },
        { key: "own", label: "scorex_rank", get: (t) => (t.score && t.score.own != null ? t.score.own : "") },
        { key: "sorsa", label: "sorsa_score", get: (t) => (t.score && t.score.sorsa != null ? t.score.sorsa : "") },
        { key: "followsYou", label: "follows_you", get: (t) => (t.rel && t.rel.followsYou != null ? (t.rel.followsYou ? "yes" : "no") : "") },
        { key: "comments", label: "comments", get: (t) => (t.stats && t.stats.comments) || 0 },
        { key: "last", label: "last_comment", get: (t) => (t.stats && t.stats.lastCommentAt ? new Date(t.stats.lastCommentAt).toISOString() : "") },
        { key: "notes", label: "notes" },
      ];
      download(`scorex-targets-${stamp()}.csv`, toCsv(list.sort((a, b) => a.handle.localeCompare(b.handle)), cols), "text/csv");
    };

    const addCard = card({ title: "Add targets", subtitle: "Accounts ScoreX comments on. Group A follows you (keep warm), group B does not (get noticed)." },
      h("div", { class: "grid-2" },
        h("div", { class: "stack" },
          labeled("Handles or profile links (one per line, or separated by commas)", addText),
          h("div", { class: "form-row" }, labeled("Group", addGroup), labeled("Tier", addTier)),
          h("div", { class: "toolbar" }, addBtn, addCount)),
        h("div", { class: "stack" },
          h("div", { class: "subpanel" },
            h("h3", { class: "subpanel-title" }, "Import a file"),
            h("p", { class: "muted small" }, "CSV (columns: handle, group, tier, tone, notes - header optional), JSON (array of handles or objects) or a plain text list. Missing group/tier use the selects on the left."),
            h("div", { class: "toolbar" },
              h("label", { class: "btn", for: "importFile", tabindex: "0", onKeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } } }, icon("upload"), h("span", null, "Choose file…")),
              fileInput)),
          h("div", { class: "subpanel" },
            h("h3", { class: "subpanel-title" }, "Export"),
            h("p", { class: "muted small" }, "Download all targets with their scores and stats as CSV."),
            btn("Export targets CSV", exportCsv, { iconName: "download", id: "exportTargetsBtn" })))));

    // ------------------------------------------------ targets table
    const search = h("input", { class: "input", type: "search", placeholder: "Search handle, name or bio", id: "targetSearch", "aria-label": "Search targets" });
    const fGroup = selectEl([["", "All groups"], ["A", "Group A"], ["B", "Group B"]], "", { "aria-label": "Filter by group" });
    const fTier = selectEl([["", "All tiers"], ["1", "Tier 1"], ["2", "Tier 2"]], "", { "aria-label": "Filter by tier" });
    const fEnabled = selectEl([["", "Enabled + disabled"], ["on", "Enabled only"], ["off", "Disabled only"]], "", { "aria-label": "Filter by enabled" });
    search.addEventListener("input", debounce(() => { f.q = search.value.trim().toLowerCase(); drawTable(true); }, 200));
    fGroup.addEventListener("change", () => { f.group = fGroup.value; drawTable(true); });
    fTier.addEventListener("change", () => { f.tier = fTier.value; drawTable(true); });
    fEnabled.addEventListener("change", () => { f.enabled = fEnabled.value; drawTable(true); });

    const bulkBar = h("div", { class: "bulk-bar", hidden: true, id: "bulkBar" });
    const tableHost = h("div", { id: "targetsTable" });

    const tableCard = card({ title: "Your targets", subtitle: "Edits save immediately. Click a column title to sort." },
      h("div", { class: "toolbar filters" }, h("div", { class: "search-wrap" }, icon("search"), search), fGroup, fTier, fEnabled),
      bulkBar,
      tableHost);

    const patchTarget = async (handle, patch) => {
      const r = await ctx.send("targetPatch", { handle, patch }, { label: "Save target" });
      if (!r) drawTable(true); // revert the control to the stored value
      return r;
    };

    function filtered() {
      return ctx.targetList().filter((t) => {
        if (f.group && t.group !== f.group) return false;
        if (f.tier && String(t.tier) !== f.tier) return false;
        if (f.enabled === "on" && t.enabled === false) return false;
        if (f.enabled === "off" && t.enabled !== false) return false;
        if (f.q) {
          const hay = `${t.handle} ${t.name || ""} ${(t.profile && t.profile.name) || ""} ${(t.profile && t.profile.bio) || ""} ${t.notes || ""}`.toLowerCase();
          if (!hay.includes(f.q)) return false;
        }
        return true;
      });
    }

    function toneOptions(t) {
      const s = ctx.settings;
      const g = s.groups[t.group] || {};
      const opts = [["", `Group default (${toneLabel(g.tone, s)})`]];
      for (const k of allToneKeys(s)) opts.push([k, toneLabel(k, s)]);
      if (t.tone && !opts.some((o) => o[0] === t.tone)) opts.push([t.tone, toneLabel(t.tone, s)]);
      return opts;
    }

    function columns() {
      const s = ctx.settings;
      const now = Date.now();
      return [
        { key: "handle", label: "Account", title: "Handle (opens x.com) and display name", render: (t) => h("div", { class: "cell-account" },
          h("div", { class: "cell-handle" }, xLink(t.handle), t.profile && t.profile.verified ? h("span", { class: "verified", title: "Verified" }, icon("check")) : null),
          h("div", { class: "cell-sub", title: (t.profile && t.profile.bio) || "" }, t.name || (t.profile && t.profile.name) || "")), sort: (t) => t.handle, defaultDir: "asc" },
        { key: "group", label: "Group", render: (t) => {
          const sel = selectEl([["A", "A"], ["B", "B"]], t.group, { class: "badge-select badge-group-" + String(t.group || "b").toLowerCase(), "aria-label": `Group for @${t.handle}`, title: t.group === "A" ? "Group A - follows you (keep warm)" : "Group B - does not follow you (get noticed)" });
          sel.addEventListener("change", () => patchTarget(t.handle, { group: sel.value }));
          return sel;
        } },
        { key: "tier", label: "Tier", render: (t) => {
          const sel = selectEl([["1", "T1"], ["2", "T2"]], String(t.tier), { class: "badge-select badge-tier-" + (Number(t.tier) === 1 ? 1 : 2), "aria-label": `Tier for @${t.handle}`, title: Number(t.tier) === 1 ? "Tier 1 - big influencer" : "Tier 2 - smart account" });
          sel.addEventListener("change", () => patchTarget(t.handle, { tier: Number(sel.value) }));
          return sel;
        } },
        { key: "followers", label: "Followers", align: "right", render: (t) => fmtCount(t.profile && t.profile.followers != null ? t.profile.followers : null), sort: (t) => (t.profile ? t.profile.followers : null) },
        { key: "own", label: "ScoreX rank", align: "right", title: "Own 0-100 rank from followers, engagement rate, activity and quality", render: (t) => scoreChip(t.score && t.score.own), sort: (t) => (t.score ? t.score.own : null) },
        { key: "sorsa", label: "Sorsa Score", align: "right", title: "Shown when the Sorsa integration is enabled in Settings", render: (t) => (t.score && t.score.sorsa != null ? fmtCount(t.score.sorsa) : "-"), sort: (t) => (t.score ? t.score.sorsa : null) },
        { key: "followsYou", label: "Follows you", render: (t) => { const v = t.rel && t.rel.followsYou; return v === true ? badge("Yes", "green") : v === false ? badge("No", "grey") : h("span", { class: "muted", title: "Not checked yet" }, "?"); }, sort: (t) => (t.rel && t.rel.followsYou ? 1 : t.rel && t.rel.followsYou === false ? 0 : -1) },
        { key: "priority", label: "Priority", align: "right", render: (t) => {
          const inp = h("input", { type: "number", class: "input input-xs", min: "0", max: "100", step: "1", value: String(t.priority != null ? t.priority : 50), "aria-label": `Priority for @${t.handle}` });
          inp.addEventListener("change", () => { const v = Math.max(0, Math.min(100, Math.round(Number(inp.value) || 0))); inp.value = String(v); patchTarget(t.handle, { priority: v }); });
          return inp;
        }, sort: (t) => num(t.priority, 50) },
        { key: "comments", label: "Comments", align: "right", render: (t) => String((t.stats && t.stats.comments) || 0), sort: (t) => (t.stats && t.stats.comments) || 0 },
        { key: "lastComment", label: "Last comment", render: (t) => (t.stats && t.stats.lastCommentAt ? h("span", { title: fmtDateTime(t.stats.lastCommentAt) }, fmtAgo(t.stats.lastCommentAt)) : "-"), sort: (t) => (t.stats && t.stats.lastCommentAt) || 0 },
        { key: "coldUntil", label: "Cold until", render: (t) => (t.coldUntil && t.coldUntil > now ? badge(fmtDate(t.coldUntil), "amber", "Cooling down after no response") : "-"), sort: (t) => (t.coldUntil && t.coldUntil > now ? t.coldUntil : 0) },
        { key: "tone", label: "Tone", sort: false, render: (t) => {
          const sel = selectEl(toneOptions(t), t.tone || "", { class: "input input-sm", "aria-label": `Tone override for @${t.handle}` });
          sel.addEventListener("change", () => patchTarget(t.handle, { tone: sel.value }));
          return sel;
        } },
        { key: "preset", label: "Preset", sort: false, render: (t) => {
          const m = s.presetMatrix[`${t.group}${t.tier}`];
          const sel = selectEl([["", `Matrix (${m || "balanced"})`], ...PRESET_KEYS.map((k) => [k, k === "high" ? "High quality" : k === "balanced" ? "Balanced" : "Cheap"])], t.preset || "", { class: "input input-sm", "aria-label": `Model preset override for @${t.handle}` });
          sel.addEventListener("change", () => patchTarget(t.handle, { preset: sel.value }));
          return sel;
        } },
        { key: "enabled", label: "On · actions", className: "col-actions col-sticky-right", title: "Enabled toggle, refresh profile, remove", sort: (t) => (t.enabled !== false ? 1 : 0), render: (t) => h("div", { class: "row-actions" },
          toggleEl("", t.enabled !== false, (v) => patchTarget(t.handle, { enabled: v }), { title: `Enable @${t.handle}` }),
          btn("", (e) => { const b = e.currentTarget; busy(b, async () => { const r = await ctx.send("targetRefresh", { handles: [t.handle] }, { label: "Refresh profile" }); if (r) toast(`Profile refresh queued for @${t.handle}`, { type: "success" }); }); }, { iconName: "refresh", size: "sm", kind: "ghost", title: `Refresh @${t.handle}'s profile and score` }),
          btn("", async () => {
            if (!(await confirmDialog(`Remove @${t.handle} from your targets? Its history stays.`, { title: "Remove target", okLabel: "Remove", danger: true }))) return;
            const r = await ctx.send("targetsRemove", { handles: [t.handle] }, { label: "Remove" });
            if (r) { selected.delete(t.handle); toast(`Removed @${t.handle}`, { type: "success" }); }
          }, { iconName: "trash", size: "sm", kind: "ghost-danger", title: `Remove @${t.handle}` })) },
      ];
    }

    function drawBulk() {
      const live = new Set(ctx.targetList().map((t) => t.handle));
      for (const hdl of [...selected]) if (!live.has(hdl)) selected.delete(hdl);
      const n = selected.size;
      bulkBar.hidden = !n;
      if (!n) return;
      const handles = () => [...selected];
      const bulk = async (patch, label) => {
        const r = await ctx.send("targetsBulk", { handles: handles(), patch }, { label });
        if (r) toast(`${label}: ${n} target${n === 1 ? "" : "s"}`, { type: "success" });
      };
      const gSel = selectEl([["", "Set group…"], ["A", "Group A"], ["B", "Group B"]], "", { class: "input input-sm", "aria-label": "Set group for selected" });
      gSel.addEventListener("change", () => { if (gSel.value) bulk({ group: gSel.value }, "Set group " + gSel.value); gSel.value = ""; });
      const tSel = selectEl([["", "Set tier…"], ["1", "Tier 1"], ["2", "Tier 2"]], "", { class: "input input-sm", "aria-label": "Set tier for selected" });
      tSel.addEventListener("change", () => { if (tSel.value) bulk({ tier: Number(tSel.value) }, "Set tier " + tSel.value); tSel.value = ""; });
      fill(bulkBar, 
        h("strong", null, `${n} selected`),
        gSel, tSel,
        btn("Enable", () => bulk({ enabled: true }, "Enable"), { size: "sm" }),
        btn("Disable", () => bulk({ enabled: false }, "Disable"), { size: "sm" }),
        btn("Refresh profiles", async () => { const r = await ctx.send("targetRefresh", { handles: handles() }, { label: "Refresh" }); if (r) toast(`Queued ${num(r.queued, n)} profile refreshes`, { type: "success" }); }, { size: "sm", iconName: "refresh" }),
        btn("Remove", async () => {
          if (!(await confirmDialog(`Remove ${n} target${n === 1 ? "" : "s"}? Their history stays.`, { title: "Remove targets", okLabel: "Remove", danger: true }))) return;
          const r = await ctx.send("targetsRemove", { handles: handles() }, { label: "Remove" });
          if (r) { toast(`Removed ${num(r.removed, n)}`, { type: "success" }); selected.clear(); drawBulk(); }
        }, { size: "sm", kind: "danger-soft", iconName: "trash" }),
        btn("Clear selection", () => { selected.clear(); drawTable(true); }, { size: "sm", kind: "ghost" }));
    }

    function drawSummary() {
      const list = ctx.targetList();
      const by = (fn) => list.filter(fn).length;
      fill(summary, 
        h("div", { class: "summary-item" }, h("span", { class: "summary-num" }, String(list.length)), h("span", { class: "muted" }, "targets")),
        h("div", { class: "summary-item" }, groupBadge("A"), h("span", { class: "summary-num" }, String(by((t) => t.group === "A"))), h("span", { class: "muted" }, "follow you")),
        h("div", { class: "summary-item" }, groupBadge("B"), h("span", { class: "summary-num" }, String(by((t) => t.group === "B"))), h("span", { class: "muted" }, "to win")),
        h("div", { class: "summary-item" }, tierBadge(1), h("span", { class: "summary-num" }, String(by((t) => Number(t.tier) === 1))), h("span", { class: "muted" }, "influencers")),
        h("div", { class: "summary-item" }, tierBadge(2), h("span", { class: "summary-num" }, String(by((t) => Number(t.tier) !== 1))), h("span", { class: "muted" }, "smart accounts")),
        h("div", { class: "summary-item" }, h("span", { class: "summary-num" }, String(by((t) => t.enabled !== false))), h("span", { class: "muted" }, "enabled")));
    }

    let pendingDraw = false;
    function drawTable(force) {
      if (!force && tableHost.contains(document.activeElement) && document.activeElement !== document.body) {
        if (!pendingDraw) { pendingDraw = true; tableHost.addEventListener("focusout", () => { pendingDraw = false; setTimeout(() => drawTable(), 50); }, { once: true }); }
        return;
      }
      const list = filtered();
      clear(tableHost).appendChild(renderTable({
        columns: columns(),
        rows: list,
        rowKey: (t) => t.handle,
        selection: selected,
        onSelectionChange: drawBulk,
        sortState,
        maxRows: 150,
        rowClass: (t) => (t.enabled === false ? "is-disabled" : ""),
        empty: ctx.targetList().length ? "No targets match these filters." : "No targets yet. Add handles above, import a file, or use Discovery below.",
        caption: "Targets",
      }));
      drawBulk();
    }

    // ------------------------------------------------ discovery
    const disc = ctx.settings.discovery;
    const dSource = selectEl(SOURCES, "followersOf", { id: "discSource" });
    const dHandles = h("input", { class: "input", id: "discHandles", placeholder: "@naval, @balajis" });
    const dQuery = h("input", { class: "input", id: "discQuery", placeholder: "e.g. onchain analyst, AI researcher" });
    const dMax = h("input", { class: "input", type: "number", min: "10", max: "1000", step: "10", id: "discMax", value: String(disc.maxUsers || 150) });
    const dEnrich = toggleEl("Visit profiles to score them (slower, more accurate)", true, null, { id: "discEnrich" });
    const handlesField = labeled("Accounts", dHandles, "One or more @handles, separated by commas.");
    const queryField = labeled("Search words", dQuery, "Finds people whose name or bio matches.");
    const syncSourceFields = () => {
      const v = dSource.value;
      handlesField.hidden = !["followersOf", "followingOf", "common"].includes(v);
      queryField.hidden = v !== "search";
      dHandles.placeholder = v === "common" ? "@smart1, @smart2, @smart3 (2-5 accounts)" : "@account";
    };
    dSource.addEventListener("change", syncSourceFields);
    syncSourceFields();
    const progressHost = h("div", { class: "disc-progress", id: "discProgress" });

    const discStart = btn("Start discovery", async (e) => {
      const source = dSource.value;
      const handles = parseHandleList(dHandles.value);
      const query = dQuery.value.trim();
      if (["followersOf", "followingOf"].includes(source) && !handles.length) { toast("Enter an @account first.", { type: "warn" }); return; }
      if (source === "common" && handles.length < 2) { toast("Enter at least two smart accounts.", { type: "warn" }); return; }
      if (source === "search" && !query) { toast("Enter search words first.", { type: "warn" }); return; }
      const b = e.currentTarget;
      await busy(b, async () => {
        const r = await ctx.send("discoveryStart", { source, handles, query, maxUsers: Math.max(10, Math.min(1000, Number(dMax.value) || 150)), enrich: dEnrich.input.checked }, { label: "Discovery" });
        if (r) toast("Discovery started - it runs in the X tab, progress shows below.", { type: "success" });
      });
    }, { kind: "primary", iconName: "search", id: "discStartBtn" });
    const discCancel = btn("Cancel", async () => { const r = await ctx.send("discoveryCancel", {}, { label: "Cancel discovery" }); if (r) toast("Discovery cancelled"); }, { id: "discCancelBtn" });

    // sx.discovery (lib/discovery.js): { status, source, step, message, found, progress: {done,total}, startedAt, finishedAt }
    function drawDiscovery() {
      const d = ctx.data[K.discovery];
      clear(progressHost);
      if (!d || typeof d !== "object" || (!d.status && !d.startedAt)) { progressHost.appendChild(h("p", { class: "muted small" }, "No discovery run yet.")); discCancel.disabled = true; discStart.disabled = false; return; }
      const running = ["running", "queued", "waiting", "cancelling"].includes(d.status);
      discCancel.disabled = !running || d.status === "cancelling";
      discStart.disabled = running; // one discovery at a time
      const p = d.progress || {};
      const done = num(p.done), total = num(p.total);
      const pct = total ? (running ? Math.max(4, ((done + 0.5) / total) * 100) : 100) : running ? 10 : 100;
      const label = SOURCES.find((x) => x[0] === d.source);
      const color = d.status === "error" ? "red" : running ? "blue" : d.status === "done" ? "green" : "grey";
      const facts = [];
      if (d.found != null) facts.push(`${num(d.found)} accounts found`);
      if (total) facts.push(`${done} of ${total} source${total === 1 ? "" : "s"} read`);
      if (d.startedAt) facts.push(`started ${fmtAgo(d.startedAt)}`);
      if (d.finishedAt) facts.push(`finished ${fmtAgo(d.finishedAt)}`);
      add(progressHost, 
        h("div", { class: "disc-head" },
          badge(d.status || "idle", color),
          h("strong", null, label ? label[1] : d.source || "Discovery"),
          d.step ? h("span", { class: "muted" }, "· " + d.step) : null),
        progressBar(pct, { kind: d.status === "error" ? "red" : running ? "accent" : "green" }),
        d.message ? h("div", { class: ["small", d.status === "error" && "text-red"] }, d.message) : null,
        facts.length ? h("div", { class: "muted small" }, facts.join(" · ")) : null,
        d.error ? h("div", { class: "small text-red" }, String(d.error)) : null);
    }

    const discFilters = h("div", { class: "form-grid" },
      ctx.field({ path: "discovery.minFollowers", type: "number", label: "Min followers", min: 0, step: 100 }),
      ctx.field({ path: "discovery.maxFollowers", type: "number", label: "Max followers", min: 0, step: 1000 }),
      ctx.field({ path: "discovery.activeWithinDays", type: "number", label: "Posted within (days)", min: 0, max: 365 }),
      ctx.field({ path: "discovery.languages", type: "csv", label: "Languages", placeholder: "en, bn (empty = any)", hint: "Language codes, comma separated" }),
      ctx.field({ path: "discovery.maxUsers", type: "number", label: "Default max users", min: 10, max: 1000, step: 10 }),
      ctx.field({ path: "discovery.enrichMax", type: "number", label: "Profiles scored per run", min: 0, max: 200 }),
      ctx.field({ path: "discovery.skipBots", type: "toggle", label: "Skip bots and spam accounts" }));

    const discCard = card({ title: "Find new targets", subtitle: "Discovery reads lists on X in your worker tab and collects candidates. Nothing is followed or posted." },
      h("div", { class: "grid-2" },
        h("div", { class: "stack" },
          labeled("Source", dSource),
          handlesField, queryField,
          h("div", { class: "form-row" }, labeled("Max users", dMax)),
          dEnrich,
          h("div", { class: "toolbar" }, discStart, discCancel),
          progressHost),
        h("div", { class: "subpanel" }, h("h3", { class: "subpanel-title" }, "Discovery filters"), h("p", { class: "muted small" }, "Candidates outside these filters are marked as not passing (you can still add them)."), discFilters)));

    // ------------------------------------------------ candidates
    const candSearch = h("input", { class: "input", type: "search", placeholder: "Search candidates", "aria-label": "Search candidates" });
    candSearch.addEventListener("input", debounce(() => { cf.q = candSearch.value.trim().toLowerCase(); drawCandidates(true); }, 200));
    const passToggle = toggleEl("Only passing filters", false, (v) => { cf.passOnly = v; drawCandidates(true); });
    const candTier = selectEl([["suggested", "Tier: suggested"], ["1", "Tier 1"], ["2", "Tier 2"]], "suggested", { class: "input input-sm", "aria-label": "Tier for added candidates" });
    const candBar = h("div", { class: "toolbar" });
    const candHost = h("div", { id: "candidatesTable" });

    const addCandidates = async (group) => {
      const handles = [...candSelected];
      if (!handles.length) return;
      const cands = ctx.data[K.candidates] || {};
      const byTier = new Map();
      for (const hd of handles) {
        const tier = candTier.value === "suggested" ? C.tier(cands[hd] || {}) || 2 : Number(candTier.value);
        if (!byTier.has(tier)) byTier.set(tier, []);
        byTier.get(tier).push(hd);
      }
      let added = 0, okAll = true;
      for (const [tier, list] of byTier) {
        const r = await ctx.send("candidatesAdd", { handles: list, group, tier }, { label: "Add candidates" });
        if (r) added += num(r.added, list.length); else okAll = false;
      }
      if (added) toast(`Added ${added} to group ${group}`, { type: "success" });
      if (okAll) candSelected.clear();
      drawCandidates(true);
    };

    function drawCandBar() {
      const n = candSelected.size;
      fill(candBar, 
        h("div", { class: "search-wrap" }, icon("search"), candSearch),
        passToggle,
        h("span", { class: "spacer" }),
        h("span", { class: "muted small" }, n ? `${n} selected` : "Select candidates to add them"),
        candTier,
        btn("Add to group A", () => addCandidates("A"), { size: "sm", disabled: !n, title: "Accounts that follow you - keep warm" }),
        btn("Add to group B", () => addCandidates("B"), { size: "sm", disabled: !n, kind: "primary", title: "Accounts that don't follow you - get noticed" }),
        btn("Remove", async () => { const r = await ctx.send("candidatesRemove", { handles: [...candSelected] }, { label: "Remove candidates" }); if (r) { candSelected.clear(); drawCandidates(true); } }, { size: "sm", disabled: !n, kind: "ghost" }),
        btn("Clear all", async () => {
          if (!(await confirmDialog("Remove every candidate from the list?", { title: "Clear candidates", okLabel: "Clear", danger: true }))) return;
          const r = await ctx.send("candidatesClear", {}, { label: "Clear candidates" });
          if (r) { candSelected.clear(); toast("Candidates cleared"); }
        }, { size: "sm", kind: "ghost-danger" }));
    }

    function drawCandidates(force) {
      if (!force && candHost.contains(document.activeElement) && document.activeElement !== document.body) return;
      const all = Object.values(ctx.data[K.candidates] || {}).filter((c) => c && c.handle);
      const targetSet = new Set(ctx.targetList().map((t) => t.handle));
      for (const hd of [...candSelected]) if (!all.some((c) => c.handle === hd)) candSelected.delete(hd);
      const list = all.filter((c) => {
        if (cf.passOnly && C.pass(c) === false) return false;
        if (cf.q && !`${c.handle} ${C.name(c)} ${(c.profile && c.profile.bio) || c.bio || ""}`.toLowerCase().includes(cf.q)) return false;
        return true;
      });
      drawCandBar();
      clear(candHost).appendChild(renderTable({
        columns: [
          { key: "handle", label: "Handle", render: (c) => h("div", { class: "cell-handle" }, xLink(c.handle), targetSet.has(c.handle) ? badge("target", "blue", "Already a target") : null), sort: (c) => c.handle, defaultDir: "asc" },
          { key: "name", label: "Name", render: (c) => h("span", { class: "cell-name", title: (c.profile && c.profile.bio) || c.bio || "" }, C.name(c) || "-"), sort: (c) => C.name(c).toLowerCase() },
          { key: "followers", label: "Followers", align: "right", render: (c) => fmtCount(C.followers(c)), sort: C.followers },
          { key: "score", label: "Score", align: "right", render: (c) => scoreChip(C.score(c)), sort: C.score },
          { key: "flags", label: "Flags", sort: false, render: (c) => { const fl = C.flags(c); return fl.length ? h("div", { class: "chips-inline" }, fl.map((x) => badge(String(x).replace(/_/g, " "), "amber"))) : "-"; } },
          { key: "overlap", label: "Overlap", align: "right", title: "How many source accounts follow this account (common follows)", render: (c) => (C.overlap(c) != null ? String(C.overlap(c)) : "-"), sort: C.overlap },
          { key: "sources", label: "Sources", sort: false, render: (c) => { const s = C.sources(c); return s.length ? h("span", { class: "small", title: s.join(", ") }, truncate(s.join(", "), 40)) : "-"; } },
          { key: "suggested", label: "Suggested", sort: (c) => C.tier(c), render: (c) => h("div", { class: "chips-inline" }, C.group(c) ? groupBadge(C.group(c)) : null, C.tier(c) ? tierBadge(C.tier(c)) : null) },
          { key: "pass", label: "Filters", sort: (c) => (C.pass(c) === false ? 0 : 1), render: (c) => { const p = C.pass(c); const why = C.why(c); return p === false ? h("span", { title: why.join(", ") }, badge("No", "red"), h("span", { class: "small muted" }, " " + truncate(why.join(", "), 40))) : p === true ? badge("Pass", "green") : "-"; } },
        ],
        rows: list,
        rowKey: (c) => c.handle,
        selection: candSelected,
        onSelectionChange: drawCandBar,
        sortState: candSort,
        maxRows: 100,
        empty: all.length ? "No candidates match." : "No candidates yet. Run a discovery above.",
        caption: "Candidates",
      }));
    }

    const candCard = card({ title: "Candidates", subtitle: "Accounts found by discovery. Pick the good ones and add them to a group." }, candBar, candHost);

    // ------------------------------------------------ explanation + watch summary
    const watchHost = h("div");
    function drawWatch() {
      const w = ctx.settings.watch;
      fill(watchHost, 
        h("dl", { class: "kv" },
          h("dt", null, "Strategy"), h("dd", null, WATCH_LABEL[w.strategy] || w.strategy),
          w.strategy === "list" ? [h("dt", null, "List URLs"), h("dd", null, w.listUrls.length ? `${w.listUrls.length} list${w.listUrls.length === 1 ? "" : "s"}` : h("span", { class: "text-amber" }, "None set"))] : null,
          w.strategy === "search" ? [h("dt", null, "Batch size"), h("dd", null, `${w.searchBatchSize} accounts per search`)] : null,
          w.strategy === "rotation" ? [h("dt", null, "Per check"), h("dd", null, `${w.rotationPerTick} profiles`)] : null,
          h("dt", null, "Check every"), h("dd", null, `${Math.round(w.checkIntervalSec.min / 6) / 10}-${Math.round(w.checkIntervalSec.max / 6) / 10} min`),
          h("dt", null, "Comment window"), h("dd", null, `${w.minPostAgeMin}-${w.maxPostAgeMin} min after a post`),
          h("dt", null, "Quote posts"), h("dd", null, w.includeQuotes ? "Included" : "Ignored")),
        h("a", { href: "#settings", class: "btn btn-sm" }, "Edit in Settings"));
    }
    const infoCards = h("div", { class: "grid-2" },
      card({ title: "How accounts are ranked" },
        h("ul", { class: "plain-list" },
          h("li", null, h("strong", null, "ScoreX rank"), " - own formula from followers, engagement rate, activity and quality (0-100). Always available; bots and spam accounts are heavily penalised."),
          h("li", null, h("strong", null, "Sorsa Score"), " - shown when you enable it in ", h("a", { href: "#settings" }, "Settings"), " (your own Sorsa API key)."),
          h("li", null, h("strong", null, "Kaito Yaps"), " - not available: Kaito shut down Yaps in Jan 2026.")),
        h("p", { class: "muted small" }, "Tier 1 = big influencer, Tier 2 = smart account. Priority (0-100) decides who gets a comment first when several targets post at once.")),
      card({ title: "Watching for new posts" }, watchHost));

    add(root, summary, addCard, tableCard, discCard, candCard, infoCards);
    drawSummary();
    drawTable(true);
    drawDiscovery();
    drawCandidates(true);
    drawWatch();
    ctx.on(K.targets, () => { drawSummary(); drawTable(); drawCandidates(); });
    ctx.on(K.candidates, () => drawCandidates());
    ctx.on(K.discovery, drawDiscovery);
    ctx.on("settings", () => { drawWatch(); drawTable(); });
  },
};

function scoreChip(v) {
  if (v == null || !Number.isFinite(Number(v))) return h("span", { class: "muted" }, "-");
  const n = Math.round(Number(v));
  const cls = n >= 75 ? "score-hi" : n >= 50 ? "score-mid" : "score-lo";
  return h("span", { class: ["score", cls] }, String(n));
}
export { scoreChip };
