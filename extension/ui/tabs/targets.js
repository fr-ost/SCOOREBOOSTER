// Targets tab: "Add targets" (paste box, tier, import file, export) on top, the targets table with its
// follow status (checking / not following / follows you / followed back), inline edits and bulk actions,
// the follow rules (give-up days, auto-remove, blacklist) below it. Collapsed: follow check details, the
// blacklist, Discovery + the candidates list, and how ranking and watching work.
// Only accounts that don't follow you get comments. All target changes go through messages.

import { K, PRESET_KEYS } from "../../lib/constants.js";
import { parseHandleList, toCsv, num } from "../../lib/util.js";
import { parseImport, allToneKeys, followStatus, followDays, FS, FS_LABEL, MAIN_TONE } from "../../lib/targets.js";
import { h, clear, section, sub, advanced, btn, busy, toast, icon, renderTable, tierBadge, followBadge, badge, xLink, selectEl, toggleEl, labeled, confirmDialog, download, readFileText, stamp, progressBar, fmtCount, fmtAgo, fmtDate, fmtDateTime, debounce, truncate, add, fill } from "../components.js";

// Values match lib/discovery.js sourceUrls(). "My followers" is not offered: followers are never commented on.
const SOURCES = [
  ["followersOf", "Followers of @account"],
  ["followingOf", "Following of @account"],
  ["search", "Keyword search (people)"],
  ["common", "Common follows of several smart accounts"],
];
const WATCH_LABEL = { list: "X List (recommended)", search: "Batched Latest search", rotation: "Profile rotation" };

export function toneLabel(key, settings) {
  if (!key || key === MAIN_TONE) return "Your Tone prompt";
  if (key === "custom") return "Custom text (old)";
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
  followsYou: (c) => !!(c.followsYou || (c.rel && c.rel.followsYou) || (c.profile && c.profile.followsYou)),
  pass: (c) => (c.pass != null ? c.pass : c.filter ? c.filter.pass : null),
  why: (c) => c.why || (c.filter && c.filter.why) || [],
};

export default {
  id: "targets",
  title: "Targets",
  hint: "The accounts ScoreX replies to. Only accounts that don't follow you get comments, and comments stop once they follow back.",
  async render(root, ctx) {
    const selected = new Set();
    const candSelected = new Set();
    const sortState = { key: "priority", dir: "desc" };
    const candSort = { key: "score", dir: "desc" };
    const f = { q: "", status: "", tier: "", enabled: "" };
    const cf = { q: "", passOnly: false };

    // ------------------------------------------------ summary
    const summary = h("div", { class: "summary-row", id: "targetsSummary" });

    // ------------------------------------------------ add / import / export
    const addText = h("textarea", { class: "input", id: "addHandles", rows: 3, placeholder: "@naval\nhttps://x.com/balajis\nvitalikbuterin, paulg" });
    const addTier = selectEl([["2", "Tier 2 · smart account"], ["1", "Tier 1 · big influencer"]], "2", { id: "addTier" });
    const addCount = h("span", { class: "muted small" });
    addText.addEventListener("input", () => { const n = parseHandleList(addText.value).length; addCount.textContent = n ? `${n} account${n === 1 ? "" : "s"} recognised` : ""; });
    const addBtn = btn("Add", async (e) => {
      const rows = parseHandleList(addText.value);
      if (!rows.length) { toast("Paste at least one @handle or x.com profile link.", { type: "warn" }); return; }
      const b = e.currentTarget;
      await busy(b, async () => {
        const r = await ctx.send("targetsUpsert", { rows, defaults: { tier: Number(addTier.value), source: "manual" }, overwrite: false }, { label: "Add targets" });
        if (r) { addedToast(r); addText.value = ""; addCount.textContent = ""; }
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
        const ok = await confirmDialog(`Found ${parsed.length} account${parsed.length === 1 ? "" : "s"} in ${file.name}. Rows without a tier use tier ${addTier.value}. ScoreX first checks who already follows you and only comments on accounts that don't. Import them?`, { title: "Import targets", okLabel: "Import" });
        if (!ok) return;
        const r = await ctx.send("targetsImport", { text, defaults: { tier: Number(addTier.value), source: "import" } }, { label: "Import" });
        if (r) addedToast(r, `Imported ${num(r.parsed != null ? r.parsed : parsed.length)} rows: added`);
      } catch (err) { toast("Could not read the file: " + err.message, { type: "error" }); }
    });

    const exportCsv = () => {
      const list = ctx.targetList();
      if (!list.length) { toast("No targets to export.", { type: "warn" }); return; }
      const cols = [
        { key: "handle", label: "handle" }, { key: "name", label: "name" }, { key: "tier", label: "tier" },
        { key: "enabled", label: "enabled", get: (t) => (t.enabled !== false ? "yes" : "no") },
        { key: "follow", label: "follow_status", get: (t) => (t.rel && t.rel.gone ? "Not found" : FS_LABEL[followStatus(t)]) },
        { key: "first", label: "first_comment", get: (t) => (t.stats && t.stats.firstCommentAt ? new Date(t.stats.firstCommentAt).toISOString() : "") },
        { key: "followedBack", label: "followed_back", get: (t) => (t.rel && t.rel.followedBackAt ? new Date(t.rel.followedBackAt).toISOString() : "") },
        { key: "tone", label: "tone" }, { key: "preset", label: "preset" },
        { key: "priority", label: "priority" }, { key: "followers", label: "followers", get: (t) => (t.profile && t.profile.followers) || "" },
        { key: "own", label: "scorex_rank", get: (t) => (t.score && t.score.own != null ? t.score.own : "") },
        { key: "sorsa", label: "sorsa_score", get: (t) => (t.score && t.score.sorsa != null ? t.score.sorsa : "") },
        { key: "comments", label: "comments", get: (t) => (t.stats && t.stats.comments) || 0 },
        { key: "last", label: "last_comment", get: (t) => (t.stats && t.stats.lastCommentAt ? new Date(t.stats.lastCommentAt).toISOString() : "") },
        { key: "notes", label: "notes" },
      ];
      download(`scorex-targets-${stamp()}.csv`, toCsv(list.sort((a, b) => a.handle.localeCompare(b.handle)), cols), "text/csv");
    };

    const importLabel = h("label", { class: "btn btn-sm", for: "importFile", tabindex: "0", onKeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } } }, icon("upload"), h("span", null, "Import file…"));
    const addSec = section({ title: "Add targets", hint: "Paste @handles or x.com profile links, one per line or separated by commas. ScoreX first checks who already follows you and only comments on accounts that don't." },
      h("div", { class: "add-box" },
        h("div", { class: "stack-sm" },
          h("label", { class: "sr-only", for: "addHandles" }, "Handles or profile links"),
          addText,
          h("div", { class: "toolbar toolbar-end" }, labeled("Tier", addTier), addBtn, addCount)),
        h("div", { class: "stack-sm" },
          sub("From a file",
            h("p", { class: "small muted" }, "CSV (handle, tier, tone, notes), JSON or a plain list. Missing tiers use the Tier select."),
            h("div", { class: "toolbar" }, importLabel, fileInput, btn("Export CSV", exportCsv, { iconName: "download", size: "sm", id: "exportTargetsBtn", title: "All targets with scores and stats" }))))));

    // ------------------------------------------------ targets table
    const search = h("input", { class: "input", type: "search", placeholder: "Search handle, name or bio", id: "targetSearch", "aria-label": "Search targets" });
    const fStatus = selectEl([["", "All statuses"], ...[FS.CHECKING, FS.ACTIVE, FS.FOLLOWS, FS.FOLLOWED_BACK].map((k) => [k, FS_LABEL[k]]), [GONE, "Not found"]], "", { id: "targetStatusFilter", "aria-label": "Filter by follow status" });
    const fTier = selectEl([["", "All tiers"], ["1", "Tier 1"], ["2", "Tier 2"]], "", { "aria-label": "Filter by tier" });
    const fEnabled = selectEl([["", "Enabled + disabled"], ["on", "Enabled only"], ["off", "Disabled only"]], "", { "aria-label": "Filter by enabled" });
    search.addEventListener("input", debounce(() => { f.q = search.value.trim().toLowerCase(); drawTable(true); }, 200));
    fStatus.addEventListener("change", () => { f.status = fStatus.value; drawTable(true); });
    fTier.addEventListener("change", () => { f.tier = fTier.value; drawTable(true); });
    fEnabled.addEventListener("change", () => { f.enabled = fEnabled.value; drawTable(true); });

    const bulkBar = h("div", { class: "bulk-bar", hidden: true, id: "bulkBar" });
    const tableHost = h("div", { id: "targetsTable" });

    const tableSec = section({ wide: true, title: "Your targets", actions: summary },
      h("div", { class: "toolbar filters" }, h("div", { class: "search-wrap" }, icon("search"), search), fStatus, fTier, fEnabled, h("span", { class: "spacer" }), h("span", { class: "small muted" }, "Edits save at once. Click a column to sort.")),
      bulkBar,
      tableHost);

    const patchTarget = async (handle, patch) => {
      const r = await ctx.send("targetPatch", { handle, patch }, { label: "Save target" });
      if (!r) drawTable(true); // revert the control to the stored value
      return r;
    };

    function filtered() {
      return ctx.targetList().filter((t) => {
        if (f.status && fsOf(t) !== f.status) return false;
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
      const opts = [["", "Your Tone prompt"]];
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
        { key: "tier", label: "Tier", render: (t) => {
          const sel = selectEl([["1", "T1"], ["2", "T2"]], String(t.tier), { class: "badge-select badge-tier-" + (Number(t.tier) === 1 ? 1 : 2), "aria-label": `Tier for @${t.handle}`, title: Number(t.tier) === 1 ? "Tier 1 - big influencer" : "Tier 2 - smart account" });
          sel.addEventListener("change", () => patchTarget(t.handle, { tier: Number(sel.value) }));
          return sel;
        } },
        { key: "follow", label: "Follow status", className: "col-follow", title: "Checking: not checked yet (no comments). Not following: ScoreX comments on them. Follows you: never commented on. Followed back: comments stopped.", render: (t) => followBadge(t, s), sort: followSortKey, defaultDir: "asc" },
        { key: "followers", label: "Followers", align: "right", render: (t) => fmtCount(t.profile && t.profile.followers != null ? t.profile.followers : null), sort: (t) => (t.profile ? t.profile.followers : null) },
        { key: "own", label: "ScoreX rank", align: "right", title: "Own 0-100 rank from followers, engagement rate, activity and quality", render: (t) => scoreChip(t.score && t.score.own), sort: (t) => (t.score ? t.score.own : null) },
        { key: "sorsa", label: "Sorsa Score", align: "right", title: "Shown when the Sorsa integration is enabled in Settings", render: (t) => (t.score && t.score.sorsa != null ? fmtCount(t.score.sorsa) : "-"), sort: (t) => (t.score ? t.score.sorsa : null) },
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
          const m = s.presetMatrix[`B${Number(t.tier) === 1 ? 1 : 2}`];
          const sel = selectEl([["", `Tier preset (${m || "balanced"})`], ...PRESET_KEYS.map((k) => [k, k === "high" ? "High quality" : k === "balanced" ? "Balanced" : "Cheap"])], t.preset || "", { class: "input input-sm", "aria-label": `Model preset override for @${t.handle}` });
          sel.addEventListener("change", () => patchTarget(t.handle, { preset: sel.value }));
          return sel;
        } },
        { key: "enabled", label: "On · actions", className: "col-actions col-sticky-right", title: "Enabled toggle, re-check follow status, remove", sort: (t) => (t.enabled !== false ? 1 : 0), render: (t) => h("div", { class: "row-actions" },
          toggleEl("", t.enabled !== false, (v) => patchTarget(t.handle, { enabled: v }), { title: `Enable @${t.handle}` }),
          btn("", (e) => { const b = e.currentTarget; busy(b, async () => { const r = await ctx.send("targetRefresh", { handles: [t.handle] }, { label: "Re-check" }); if (r) toast(`Re-check queued for @${t.handle} (follow status and profile)`, { type: "success" }); }); }, { iconName: "refresh", size: "sm", kind: "ghost", title: `Re-check follow status and profile of @${t.handle}` }),
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
      const tSel = selectEl([["", "Set tier…"], ["1", "Tier 1"], ["2", "Tier 2"]], "", { class: "input input-sm", "aria-label": "Set tier for selected" });
      tSel.addEventListener("change", () => { if (tSel.value) bulk({ tier: Number(tSel.value) }, "Set tier " + tSel.value); tSel.value = ""; });
      fill(bulkBar, 
        h("strong", null, `${n} selected`),
        tSel,
        btn("Enable", () => bulk({ enabled: true }, "Enable"), { size: "sm" }),
        btn("Disable", () => bulk({ enabled: false }, "Disable"), { size: "sm" }),
        btn("Re-check follow status", async () => { const r = await ctx.send("targetRefresh", { handles: handles() }, { label: "Re-check" }); if (r) toast(`Queued ${num(r.queued, n)} re-check${num(r.queued, n) === 1 ? "" : "s"} (follow status and profile)`, { type: "success" }); }, { size: "sm", iconName: "refresh", id: "bulkRecheckBtn" }),
        btn("Blacklist", async () => {
          if (!(await confirmDialog(`Blacklist ${n} account${n === 1 ? "" : "s"}? ${n === 1 ? "It is" : "They are"} removed from your targets and never added again by paste, import or discovery. History stays, and you can undo this in the Blacklist section.`, { title: "Blacklist targets", okLabel: "Blacklist", danger: true }))) return;
          const r = await ctx.send("blacklistAdd", { handles: handles() }, { label: "Blacklist" });
          if (r) { toast(`Blacklisted ${n} (${num(r.removedTargets)} removed from targets)`, { type: "success" }); selected.clear(); drawBulk(); }
        }, { size: "sm", kind: "danger-soft", id: "bulkBlacklistBtn" }),
        btn("Remove", async () => {
          if (!(await confirmDialog(`Remove ${n} target${n === 1 ? "" : "s"}? Their history stays.`, { title: "Remove targets", okLabel: "Remove", danger: true }))) return;
          const r = await ctx.send("targetsRemove", { handles: handles() }, { label: "Remove" });
          if (r) { toast(`Removed ${num(r.removed, n)}`, { type: "success" }); selected.clear(); drawBulk(); }
        }, { size: "sm", kind: "danger-soft", iconName: "trash" }),
        btn("Clear selection", () => { selected.clear(); drawTable(true); }, { size: "sm", kind: "ghost" }));
    }

    function drawSummary() {
      const list = ctx.targetList();
      const by = (st) => list.filter((t) => fsOf(t) === st).length;
      const off = list.filter((t) => t.enabled === false).length;
      const black = Object.keys(ctx.data[K.blacklist] || {}).length;
      const item = (key, n, label, color, title) => h("span", { class: "summary-item", title: title || null, dataset: { sum: key } },
        color ? h("span", { class: ["hs", "hs-" + color], "aria-hidden": "true" }) : null, h("span", { class: "summary-num" }, String(n)), label);
      fill(summary,
        item("total", list.length, "targets"),
        item(FS.CHECKING, by(FS.CHECKING), "checking", "grey", "Not checked yet: no comments until ScoreX knows whether they follow you"),
        item(FS.ACTIVE, by(FS.ACTIVE), "not following", "ink", "Don't follow you: ScoreX comments on them"),
        item(FS.FOLLOWS, by(FS.FOLLOWS), "follow you", "green-o", "Already followed you: never commented on"),
        item(FS.FOLLOWED_BACK, by(FS.FOLLOWED_BACK), "followed back", "green", "Followed you back after ScoreX's comments: comments stopped"),
        by(GONE) ? item(GONE, by(GONE), "not found", "red", "Profile not found on X (renamed, suspended or deleted): turned off") : null,
        off ? item("off", off, "off", null, "Turned off: never checked or commented on") : null,
        item("blacklisted", black, "blacklisted", "red", "Never added again (Blacklist section below)"));
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
        empty: ctx.targetList().length ? "No targets match these filters." : "No targets yet. Paste handles above, import a file, or use Discovery below.",
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
    const dEnrich = toggleEl("Visit profiles to score them (slower, better)", true, null, { id: "discEnrich" });
    const handlesField = labeled("Accounts", dHandles, "One or more @handles, comma separated.");
    const queryField = labeled("Search words", dQuery, "Matches names and bios.");
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
    }, { iconName: "search", id: "discStartBtn" });
    const discCancel = btn("Cancel", async () => { const r = await ctx.send("discoveryCancel", {}, { label: "Cancel discovery" }); if (r) toast("Discovery cancelled"); }, { id: "discCancelBtn" });

    // sx.discovery (lib/discovery.js): { status, source, step, message, found, progress: {done,total}, startedAt, finishedAt }
    function drawDiscovery() {
      const d = ctx.data[K.discovery];
      clear(progressHost);
      if (!d || typeof d !== "object" || (!d.status && !d.startedAt)) { progressHost.appendChild(h("p", { class: "muted small" }, "No discovery run yet.")); discCancel.disabled = true; discStart.disabled = false; drawDiscDesc(); return; }
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
      drawDiscDesc();
    }

    const discFilters = h("div", { class: "form-grid" },
      ctx.field({ path: "discovery.minFollowers", type: "number", label: "Min followers", min: 0, step: 100 }),
      ctx.field({ path: "discovery.maxFollowers", type: "number", label: "Max followers", min: 0, step: 1000 }),
      ctx.field({ path: "discovery.activeWithinDays", type: "number", label: "Posted within (days)", min: 0, max: 365 }),
      ctx.field({ path: "discovery.languages", type: "csv", label: "Languages", placeholder: "en, bn (empty = any)", hint: "Language codes, comma separated" }),
      ctx.field({ path: "discovery.maxUsers", type: "number", label: "Default max users", min: 10, max: 1000, step: 10 }),
      ctx.field({ path: "discovery.enrichMax", type: "number", label: "Profiles scored per run", min: 0, max: 200 }),
      ctx.field({ path: "discovery.skipBots", type: "toggle", label: "Skip bots and spam accounts" }));

    const discSec = section({ title: "Find new targets", hint: "Reads lists on X in the worker tab and collects candidates. Nothing is followed or posted." },
      h("div", { class: "form-row" }, labeled("Source", dSource), handlesField, queryField, labeled("Max users", dMax)),
      dEnrich,
      h("div", { class: "toolbar" }, discStart, discCancel),
      progressHost);
    const discFiltersSec = section({ title: "Discovery filters", hint: "Candidates outside these are marked as not passing; you can still add them." }, discFilters);

    // ------------------------------------------------ candidates
    const candSearch = h("input", { class: "input", type: "search", placeholder: "Search candidates", "aria-label": "Search candidates" });
    candSearch.addEventListener("input", debounce(() => { cf.q = candSearch.value.trim().toLowerCase(); drawCandidates(true); }, 200));
    const passToggle = toggleEl("Only passing filters", false, (v) => { cf.passOnly = v; drawCandidates(true); });
    const candTier = selectEl([["suggested", "Tier: suggested"], ["1", "Tier 1"], ["2", "Tier 2"]], "suggested", { class: "input input-sm", "aria-label": "Tier for added candidates" });
    const candBar = h("div", { class: "toolbar" });
    const candHost = h("div", { id: "candidatesTable" });

    const addCandidates = async () => {
      const handles = [...candSelected];
      if (!handles.length) return;
      const cands = ctx.data[K.candidates] || {};
      const byTier = new Map();
      for (const hd of handles) {
        const tier = candTier.value === "suggested" ? C.tier(cands[hd] || {}) || 2 : Number(candTier.value);
        if (!byTier.has(tier)) byTier.set(tier, []);
        byTier.get(tier).push(hd);
      }
      const sum = { added: 0, updated: 0, blacklisted: 0 };
      let okAll = true;
      for (const [tier, list] of byTier) {
        const r = await ctx.send("candidatesAdd", { handles: list, tier }, { label: "Add candidates" });
        if (r) { sum.added += num(r.added); sum.updated += num(r.updated); sum.blacklisted += num(r.blacklisted); } else okAll = false;
      }
      if (sum.added || sum.updated || sum.blacklisted) addedToast(sum, "Added", " to your targets");
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
        btn("Add to targets", () => addCandidates(), { size: "sm", kind: n ? "primary" : "", disabled: !n, id: "candAddBtn", title: "Add the selected accounts to your targets (who already follows you is checked first)" }),
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
      const black = ctx.data[K.blacklist] || {};
      for (const hd of [...candSelected]) if (!all.some((c) => c.handle === hd)) candSelected.delete(hd);
      const list = all.filter((c) => {
        if (cf.passOnly && C.pass(c) === false) return false;
        if (cf.q && !`${c.handle} ${C.name(c)} ${(c.profile && c.profile.bio) || c.bio || ""}`.toLowerCase().includes(cf.q)) return false;
        return true;
      });
      drawCandBar();
      clear(candHost).appendChild(renderTable({
        columns: [
          { key: "handle", label: "Handle", render: (c) => h("div", { class: "cell-handle" }, xLink(c.handle), targetSet.has(c.handle) ? badge("target", "blue", "Already a target") : null, Object.hasOwn(black, c.handle) ? badge("blacklisted", "red", "On your blacklist - it is skipped when added") : null), sort: (c) => c.handle, defaultDir: "asc" },
          { key: "name", label: "Name", render: (c) => h("span", { class: "cell-name", title: (c.profile && c.profile.bio) || c.bio || "" }, C.name(c) || "-"), sort: (c) => C.name(c).toLowerCase() },
          { key: "followers", label: "Followers", align: "right", render: (c) => fmtCount(C.followers(c)), sort: C.followers },
          { key: "score", label: "Score", align: "right", render: (c) => scoreChip(C.score(c)), sort: C.score },
          { key: "flags", label: "Flags", sort: false, render: (c) => { const fl = C.flags(c); return fl.length ? h("div", { class: "chips-inline" }, fl.map((x) => badge(String(x).replace(/_/g, " "), "amber"))) : "-"; } },
          { key: "overlap", label: "Overlap", align: "right", title: "How many source accounts follow this account (common follows)", render: (c) => (C.overlap(c) != null ? String(C.overlap(c)) : "-"), sort: C.overlap },
          { key: "sources", label: "Sources", sort: false, render: (c) => { const s = C.sources(c); return s.length ? h("span", { class: "small", title: s.join(", ") }, truncate(s.join(", "), 40)) : "-"; } },
          { key: "suggested", label: "Suggested", sort: (c) => C.tier(c), render: (c) => h("div", { class: "chips-inline" }, C.tier(c) ? tierBadge(C.tier(c)) : null, C.followsYou(c) ? badge("follows you", "green", "Already follows you - ScoreX never comments on it") : null) },
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

    const candSec = section({ wide: true, title: "Candidates", hint: "Accounts found by discovery. Pick the good ones and add them to your targets. Accounts that already follow you are never commented on." }, candBar, candHost);

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
        h("a", { href: "#settings", class: "btn btn-sm", style: "align-self:flex-start" }, "Edit in Settings"));
    }
    const aboutSec = section({ title: "How accounts are ranked" },
      h("ul", { class: "plain-list small" },
        h("li", null, h("strong", null, "ScoreX rank"), ": own 0-100 score from followers, engagement rate, activity and quality. Bots and spam are penalised."),
        h("li", null, h("strong", null, "Sorsa Score"), ": shown when enabled in ", h("a", { href: "#settings" }, "Settings"), " with your own Sorsa key."),
        h("li", null, h("strong", null, "Kaito Yaps"), ": not available (Kaito shut Yaps down in Jan 2026).")),
      h("p", { class: "muted small" }, "Tier 1 = big influencer, tier 2 = smart account. Priority (0-100) decides who goes first when several targets post at once."));
    const watchSec = section({ title: "Watching for new posts" }, watchHost);

    // ------------------------------------------------ follow rules + follow checks
    const giveUpField = ctx.field({ path: "follow.giveUpDays", type: "number", label: "Remove after", suffix: "days", min: 3, max: 90, id: "giveUpDays", hint: "of comments without a follow-back (3-90)" });
    const autoRemoveField = ctx.field({ path: "follow.autoRemove", type: "toggle", label: "Remove accounts that don't follow back", id: "followAutoRemove" });
    const blacklistField = ctx.field({ path: "follow.blacklist", type: "toggle", label: "Add removed accounts to the blacklist", id: "followBlacklist" });
    const syncFollowRules = () => {
      const off = !ctx.settings.follow.autoRemove;
      giveUpField.control.disabled = off;
      blacklistField.control.disabled = off;
    };
    syncFollowRules();
    ctx.addRefresher(() => { if (!giveUpField.isConnected) return false; syncFollowRules(); return true; });
    const rulesSec = section({ title: "Follow rules", id: "followRules", hint: "Accounts that follow you are never commented on, and comments stop as soon as someone follows back. The day counter in the table starts with the first comment." },
      h("div", { class: "form-row" }, giveUpField, autoRemoveField, blacklistField));

    const followAdv = advanced({ key: "targets.follow", title: "Follow checks", id: "followChecksAdv", desc: "How ScoreX detects who follows you, and how often it checks" },
      section({ title: "Check frequency", hint: "Checks run while the engine is idle, between comments, and use the same X tab." },
        h("div", { class: "form-row" },
          ctx.field({ path: "follow.scanEveryHours", type: "number", label: "Scan my followers every", suffix: "h", min: 1, max: 24, id: "followScanHours", hint: "Your newest followers, where follow-backs show up (1-24)" }),
          ctx.field({ path: "follow.recheckHours", type: "number", label: "Re-check commented accounts every", suffix: "h", min: 12, max: 336, id: "followRecheckHours", hint: "Profile visit for the \"Follows you\" badge (12-336)" }),
          ctx.field({ path: "follow.checksPerRun", type: "number", label: "Profile checks per run", min: 1, max: 8, id: "followChecksPerRun", hint: "Profile visits per idle check (1-8)" }))),
      section({ title: "How follow detection works" },
        h("ul", { class: "plain-list small", id: "followHow" },
          h("li", null, h("strong", null, "Checking"), ": new targets get no comments until ScoreX knows whether they follow you."),
          h("li", null, "ScoreX reads your followers list on X (one page shows many accounts with X's \"Follows you\" badge) and visits the profiles it could not place."),
          h("li", null, h("strong", null, "Follows you"), ": never commented on. ", h("strong", null, "Not following"), ": ScoreX comments on their posts."),
          h("li", null, h("strong", null, "Followed back"), ": comments stop at once, open queue items for that account are dropped."),
          h("li", null, "After the give-up days without a follow-back: one last profile check, then the account is removed (and blacklisted when that is on)."),
          h("li", null, "If X stops showing the \"Follows you\" badge, ScoreX stops for safety instead of guessing."))));

    // ------------------------------------------------ blacklist
    const blSelected = new Set();
    const blSort = { key: "at", dir: "desc" };
    const blBar = h("div", { class: "toolbar" });
    const blHost = h("div", { id: "blacklistTable" });
    const blText = h("textarea", { class: "input", id: "blacklistText", rows: 2, placeholder: "@spam_account, https://x.com/someone" });
    const blList = () => Object.values(ctx.data[K.blacklist] || {}).filter((e) => e && e.handle);
    const blReason = (e) => (e.reason === "no_followback" ? (e.days != null ? `No follow-back after ${e.days} day${e.days === 1 ? "" : "s"}` : "No follow-back") : e.reason === "manual" ? "Added by you" : e.reason || "-");
    function drawBlBar() {
      const n = blSelected.size;
      fill(blBar,
        h("span", { class: "muted small" }, n ? `${n} selected` : "Select accounts to allow them again"),
        btn("Remove from blacklist", (e) => {
          const b = e.currentTarget;
          busy(b, async () => {
            const r = await ctx.send("blacklistRemove", { handles: [...blSelected] }, { label: "Remove from blacklist" });
            if (r) { toast(`Removed ${num(r.removed, n)} from the blacklist`, { type: "success" }); blSelected.clear(); drawBlacklist(); }
          });
        }, { size: "sm", disabled: !n, id: "blacklistRemoveBtn" }));
    }
    function drawBlacklist() {
      const list = blList();
      for (const hd of [...blSelected]) if (!list.some((e) => e.handle === hd)) blSelected.delete(hd);
      drawBlBar();
      clear(blHost).appendChild(renderTable({
        columns: [
          { key: "handle", label: "Account", render: (e) => xLink(e.handle), sort: (e) => e.handle, defaultDir: "asc" },
          { key: "name", label: "Name", render: (e) => h("span", { class: "cell-name" }, e.name || "-"), sort: (e) => String(e.name || "").toLowerCase(), defaultDir: "asc" },
          { key: "reason", label: "Reason", render: blReason, sort: blReason, defaultDir: "asc" },
          { key: "at", label: "Added", render: (e) => h("span", { class: "nowrap", title: fmtDateTime(e.at) }, fmtDate(e.at)) },
          { key: "comments", label: "Comments", align: "right", render: (e) => String(num(e.comments)) },
        ],
        rows: list,
        rowKey: (e) => e.handle,
        selection: blSelected,
        onSelectionChange: drawBlBar,
        sortState: blSort,
        maxRows: 100,
        empty: "No blacklisted accounts. Accounts removed for not following back are added here automatically (Follow rules).",
        caption: "Blacklist",
      }));
      const n = list.length;
      blAdv.setDesc(n ? `${n} account${n === 1 ? "" : "s"} ScoreX never adds again` : "Accounts ScoreX never adds again (none yet)");
      blAdv.setTag(n ? String(n) : "");
    }
    const blAddBtn = btn("Add to blacklist", (e) => {
      const handles = parseHandleList(blText.value);
      if (!handles.length) { toast("Paste at least one @handle or x.com profile link.", { type: "warn" }); blText.focus(); return; }
      const b = e.currentTarget;
      busy(b, async () => {
        const inTargets = handles.filter((hd) => Object.hasOwn(ctx.targets, hd)).length;
        if (inTargets && !(await confirmDialog(`${inTargets} of these ${inTargets === 1 ? "is a target and is" : "are targets and are"} removed from your targets. Continue?`, { title: "Add to blacklist", okLabel: "Blacklist", danger: true }))) return;
        const r = await ctx.send("blacklistAdd", { handles }, { label: "Add to blacklist" });
        if (r) { toast(`Blacklisted ${handles.length}${num(r.removedTargets) ? ` (${num(r.removedTargets)} removed from targets)` : ""}`, { type: "success" }); blText.value = ""; }
      });
    }, { size: "sm", iconName: "plus", id: "blacklistAddBtn" });
    const blExport = () => {
      const list = blList();
      if (!list.length) { toast("The blacklist is empty.", { type: "warn" }); return; }
      download(`scorex-blacklist-${stamp()}.csv`, toCsv(list.sort((a, b) => a.handle.localeCompare(b.handle)), [
        { key: "handle", label: "handle" }, { key: "name", label: "name" },
        { key: "reason", label: "reason", get: blReason },
        { key: "at", label: "added", get: (e) => (e.at ? new Date(e.at).toISOString() : "") },
        { key: "days", label: "days", get: (e) => (e.days != null ? e.days : "") },
        { key: "comments", label: "comments", get: (e) => num(e.comments) },
        { key: "tier", label: "tier", get: (e) => e.tier || "" },
        { key: "followers", label: "followers", get: (e) => (e.followers != null ? e.followers : "") },
      ]), "text/csv");
    };
    const blAdv = advanced({ key: "targets.blacklist", title: "Blacklist", id: "blacklistAdv", desc: "" },
      section({ wide: true, title: "Blacklisted accounts", hint: "Never added again by paste, import or discovery.", actions: btn("Export CSV", blExport, { size: "sm", iconName: "download", id: "blacklistExportBtn" }) }, blBar, blHost),
      section({ title: "Add accounts", hint: "One per line or comma separated. They are also removed from your targets." },
        h("label", { class: "sr-only", for: "blacklistText" }, "Handles to blacklist"), blText, h("div", { class: "toolbar" }, blAddBtn)));

    const discAdv = advanced({ key: "targets.discovery", title: "Discovery", desc: "" }, discSec, discFiltersSec, candSec);
    function drawDiscDesc() {
      const d = ctx.data[K.discovery];
      const n = Object.values(ctx.data[K.candidates] || {}).filter((c) => c && c.handle).length;
      const running = d && ["running", "queued", "waiting", "cancelling"].includes(d.status);
      const label = d && SOURCES.find((x) => x[0] === d.source);
      const parts = [running ? `Running: ${d.step || (label ? label[1] : "discovery")}` : "Find new accounts from followers, follows or search"];
      if (n) parts.push(`${n} candidate${n === 1 ? "" : "s"} waiting`);
      discAdv.setDesc(parts.join(" · "));
    }

    add(root, addSec, tableSec, rulesSec, followAdv, blAdv, discAdv,
      advanced({ key: "targets.about", title: "About ranking and watching", desc: "How the scores work and how new posts are found" }, aboutSec, watchSec));
    drawSummary();
    drawTable(true);
    drawBlacklist();
    drawDiscovery();
    drawCandidates(true);
    drawWatch();
    ctx.on(K.targets, () => { drawSummary(); drawTable(); drawCandidates(); });
    ctx.on(K.blacklist, () => { drawSummary(); drawBlacklist(); drawCandidates(); });
    ctx.on(K.candidates, () => { drawCandidates(); drawDiscDesc(); });
    ctx.on(K.discovery, drawDiscovery);
    ctx.on("settings", () => { drawWatch(); drawTable(); });
  },
};

// Toast for targetsUpsert / targetsImport / candidatesAdd results ({ added, updated, blacklisted }).
function addedToast(r, verb = "Added", suffix = "") {
  const added = num(r.added), updated = num(r.updated), black = num(r.blacklisted);
  const parts = [`${verb} ${added}${suffix}`];
  if (updated) parts.push(`${updated} updated`);
  if (black) parts.push(`${black} skipped (blacklisted)`);
  const text = parts.join(", ") + (added ? ". Follow status is checked before any comment." : ".");
  toast(text, { type: added || updated ? "success" : "warn" });
}

// Follow status for the filter and the summary: a profile that was not found on X counts on its own.
const GONE = "gone";
const fsOf = (t) => (t.rel && t.rel.gone ? GONE : followStatus(t));

// Follow status order for sorting: not following (with the oldest first comment first), checking,
// followed back, follows you; profiles not found last.
const FS_ORDER = { [FS.ACTIVE]: 1, [FS.CHECKING]: 2, [FS.FOLLOWED_BACK]: 3, [FS.FOLLOWS]: 4 };
function followSortKey(t) {
  if (t.rel && t.rel.gone) return 9;
  const st = followStatus(t);
  const days = st === FS.ACTIVE ? followDays(t) : null;
  return (FS_ORDER[st] || 5) - (days != null ? Math.min(days, 999) / 1000 : 0);
}

function scoreChip(v) {
  if (v == null || !Number.isFinite(Number(v))) return h("span", { class: "muted" }, "-");
  const n = Math.round(Number(v));
  const cls = n >= 75 ? "score-hi" : n >= 50 ? "score-mid" : "score-lo";
  return h("span", { class: ["score", cls] }, String(n));
}
export { scoreChip };
