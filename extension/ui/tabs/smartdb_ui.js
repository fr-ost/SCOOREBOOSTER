// ScoreX dashboard - Discover > Smart follower database: build it from TwitterScore's paid API (every page of the
// smart followers of the accounts you enter), browse and filter it, add accounts as targets, export CSV / XLSX.
import { K } from "../../lib/constants.js";
import { parseHandleList, num } from "../../lib/util.js";
import { toTable } from "../../lib/smartdb.js";
import { toXlsx, toCsv } from "../../lib/xlsx.js";
import { h, clear, fill, section, btn, busy, toast, labeled, renderTable, confirmDialog, xLink, progressBar, fmtAgo, fmtCount, debounce, truncate } from "../components.js";

const SHOW = 500; // rows drawn at once (exports always include every matching row)

function save(name, data, mime) {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name, style: "display:none" });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
}

export function smartDbSection(ctx) {
  let rows = [];
  const sel = new Set();
  const sortState = {};
  const board = () => ctx.data[K.scoreboard] || {};
  const job = () => { const j = board().job; return j && j.kind === "smartdb" ? j : null; };

  // ---- build form ----
  const handlesBox = h("textarea", { class: "input mono", rows: 3, id: "sdbHandles", spellcheck: "false", placeholder: "@cobie @hsaka @punk6529 ... (big accounts whose smart followers you want)" });
  const fillFrom = (label, pick) => btn(label, () => {
    const hs = pick(ctx.targetList()).map((t) => "@" + t.handle);
    handlesBox.value = hs.join(" ");
    toast(hs.length ? `${hs.length} accounts filled in` : "No accounts match", { type: hs.length ? "success" : "warn" });
  }, { size: "xs", kind: "ghost" });
  const pagesIn = h("input", { class: "input input-sm", type: "number", min: "1", max: "1000", value: "50", id: "sdbPages", style: "width:110px" });
  const sizeIn = h("input", { class: "input input-sm", type: "number", min: "10", max: "100", value: "100", id: "sdbSize", style: "width:110px" });
  const costLine = h("p", { class: "small muted", id: "sdbCost" });
  const syncCost = () => {
    const n = parseHandleList(handlesBox.value).length;
    const pages = Math.max(1, num(pagesIn.value, 50));
    const cfg = (ctx.settings.providers || {}).twitterscore || {};
    costLine.textContent = n ? `Up to ${fmtCount(n * pages)} TwitterScore API requests (${n} account${n === 1 ? "" : "s"} × ${pages} pages; an account stops at its last page). Each page is one request from your TwitterScore plan (check its usage on twitterscore.io; a free trial has 2,000 in total). ScoreX sends at most 50 a minute and stops at its TwitterScore daily cap: ${cfg.dailyCap || 100} (raise it in Scores > Providers for big sweeps).` : "";
  };
  handlesBox.addEventListener("input", debounce(syncCost, 200));
  pagesIn.addEventListener("input", syncCost);
  const buildBtn = btn("Build / update database", (e) => busy(e.currentTarget, async () => {
    const handles = parseHandleList(handlesBox.value);
    if (!handles.length) { toast("Enter at least one @handle", { type: "warn" }); return; }
    const r = await ctx.send("smartDbBuild", { handles, maxPages: num(pagesIn.value, 50), size: num(sizeIn.value, 100) }, { label: "Smart follower database" });
    if (r) toast("Started: TwitterScore pages are read in the background", { type: "success" });
  }), { kind: "primary", iconName: "discover", id: "sdbBuildBtn" });
  const jobHost = h("div", { id: "sdbJob", "aria-live": "polite" });
  function drawJob() {
    const j = job();
    if (!j) { clear(jobHost); return; }
    const running = j.status === "running";
    const res = j.result || {};
    fill(jobHost, h("div", { class: "toolbar" },
      running ? progressBar(j.done || 0, j.total || 1) : null,
      h("span", { class: "small" }, running
        ? `Reading ${j.current || "..."} · ${j.done || 0}/${j.total || 0} accounts · ${fmtCount(j.updated || 0)} new`
        : j.status === "done" ? `Done ${fmtAgo(j.finishedAt)}: ${fmtCount(res.pages || 0)} pages, ${fmtCount(res.added || 0)} new, ${fmtCount(res.updated || 0)} updated (${fmtCount(res.total || 0)} in the database)`
          : j.status === "cancelled" ? `Cancelled ${fmtAgo(j.finishedAt)}` : `Stopped: ${j.error || "error"}`),
      running ? btn("Cancel", (e) => busy(e.currentTarget, async () => { const r = await ctx.send("scoreJobCancel", {}, { label: "Cancel" }); if (r) toast("Stopping after the current page"); }), { size: "xs", id: "sdbCancelBtn" }) : null));
    buildBtn.disabled = running;
  }

  // ---- table ----
  const search = h("input", { class: "input input-sm", type: "search", placeholder: "Search handle, name, bio, tags", id: "sdbSearch", "aria-label": "Search the database", style: "min-width:220px" });
  const minScore = h("input", { class: "input input-sm", type: "number", min: "0", max: "1000", placeholder: "Min score", id: "sdbMinScore", "aria-label": "Minimum TwitterScore", style: "width:110px" });
  const countLine = h("span", { class: "small muted", id: "sdbCount" });
  const tableHost = h("div", { id: "sdbTable" });
  const filtered = () => {
    const q = search.value.trim().toLowerCase();
    const min = num(minScore.value, 0);
    return rows.filter((r) => (!min || (Number(r.score) || 0) >= min)
      && (!q || [r.handle, r.name, r.bio, (r.tags || []).join(" ")].some((x) => String(x || "").toLowerCase().includes(q))));
  };
  const cols = [
    { key: "handle", label: "Account", sort: (r) => r.handle, render: (r) => h("span", null, xLink(r.handle), r.name ? h("span", { class: "muted small" }, " " + truncate(r.name, 30)) : null) },
    { key: "score", label: "TwitterScore", num: true, sort: (r) => Number(r.score) || 0, render: (r) => (r.score == null ? "-" : fmtCount(r.score)) },
    { key: "followers", label: "Followers", num: true, sort: (r) => Number(r.followers) || 0, render: (r) => (r.followers == null ? "-" : fmtCount(r.followers)) },
    { key: "sources", label: "Smart follower of", num: true, sort: (r) => r.sourceCount || 0, render: (r) => h("span", { title: (r.sources || []).map((s) => "@" + s).join(" ") }, String(r.sourceCount || 0)) },
    { key: "tags", label: "Tags", render: (r) => truncate((r.tags || []).join(", "), 40) || "-" },
    { key: "bio", label: "Bio", render: (r) => h("span", { class: "small", title: r.bio || "" }, truncate(r.bio || "", 60) || "-") },
    { key: "lastSeen", label: "Seen", sort: (r) => r.lastSeen || 0, render: (r) => (r.lastSeen ? fmtAgo(r.lastSeen) : "-") },
  ];
  const selBar = h("div", { class: "toolbar", id: "sdbSelBar" });
  function drawSel() {
    const n = sel.size;
    fill(selBar, 
      h("span", { class: "small" }, n ? `${n} selected` : "Select rows to add or remove them"),
      btn("Add as Tier 1", (e) => addTargets(e, 1), { size: "xs", kind: "primary", disabled: !n, id: "sdbAddT1" }),
      btn("Add as Tier 2", (e) => addTargets(e, 2), { size: "xs", disabled: !n, id: "sdbAddT2" }),
      btn("Remove from database", (e) => busy(e.currentTarget, async () => {
        const r = await ctx.send("smartDbRemove", { handles: [...sel] }, { label: "Remove" });
        if (r) { toast(`Removed ${r.removed}`, { type: "success" }); sel.clear(); await reload(); }
      }), { size: "xs", kind: "danger-soft", disabled: !n, id: "sdbRemove" }));
  }
  function addTargets(e, tier) {
    busy(e.currentTarget, async () => {
      const r = await ctx.send("targetsUpsert", { rows: [...sel], defaults: { tier, source: "twitterscore-db" } }, { label: "Add targets" });
      if (r) toast(`Added ${r.added || 0} as Tier ${tier}${r.blacklisted ? `, ${r.blacklisted} on your blacklist skipped` : ""}`, { type: "success" });
    });
  }
  function drawTable() {
    const list = filtered();
    countLine.textContent = `${fmtCount(list.length)} of ${fmtCount(rows.length)} accounts${list.length > SHOW ? ` (showing the top ${SHOW}; exports include all ${fmtCount(list.length)})` : ""}`;
    fill(tableHost, renderTable({ columns: cols, rows: list, rowKey: (r) => r.handle, selection: sel, onSelectionChange: drawSel, sortState, maxRows: SHOW, caption: "Smart follower database", stateKey: "smartdb", empty: "The database is empty: enter big accounts above and build it." }));
    drawSel();
  }
  async function reload() {
    const r = await ctx.send("smartDbList", {}, { quiet: true, label: "Database" });
    rows = (r && r.rows) || [];
    for (const k of [...sel]) if (!rows.some((x) => x.handle === k)) sel.delete(k);
    drawTable();
  }
  search.addEventListener("input", debounce(drawTable, 200));
  minScore.addEventListener("input", debounce(drawTable, 200));
  const stamp = () => new Date().toISOString().slice(0, 10);
  const exportCsv = btn("Export CSV", () => { const list = filtered(); if (!list.length) return toast("Nothing to export", { type: "warn" }); save(`scorex-smart-followers-${stamp()}.csv`, toCsv(toTable(list)), "text/csv;charset=utf-8"); }, { size: "sm", iconName: "download", id: "sdbCsv" });
  const exportXlsx = btn("Export XLSX", () => { const list = filtered(); if (!list.length) return toast("Nothing to export", { type: "warn" }); save(`scorex-smart-followers-${stamp()}.xlsx`, toXlsx(toTable(list), "Smart followers"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); }, { size: "sm", iconName: "download", id: "sdbXlsx" });
  const clearBtn = btn("Clear database", async (e) => {
    const b = e.currentTarget;
    if (!(await confirmDialog(`Delete all ${fmtCount(rows.length)} accounts from the smart follower database? Export it first if you need it.`, { title: "Clear database", okLabel: "Delete", danger: true }))) return;
    busy(b, async () => { const r = await ctx.send("smartDbClear", {}, { label: "Clear" }); if (r) { toast("Database cleared", { type: "success" }); await reload(); } });
  }, { size: "sm", kind: "danger-soft", id: "sdbClear" });

  let lastStatus = (job() || {}).status;
  ctx.on(K.scoreboard, () => {
    drawJob();
    const st = (job() || {}).status;
    if (st !== lastStatus) { lastStatus = st; reload(); } // finished (or started): show the new rows
  });
  ctx.on("settings", syncCost);
  ctx.interval(() => { if ((job() || {}).status === "running") reload(); }, 15000);

  const el = section({ wide: true, title: "Smart follower database", id: "smartDb", hint: "Every smart follower TwitterScore's paid API lists for the accounts you enter (all pages), saved in this browser and merged across runs. Needs TwitterScore on with your API key (Scores > Providers); its API is used only here and for smart followers. Only X handles are sent to TwitterScore." },
    h("div", { class: "stack" },
      h("div", { class: "toolbar" }, h("span", { class: "small muted" }, "Fill in:"), fillFrom("My Tier 1 targets", (ts) => ts.filter((t) => Number(t.tier) === 1)), fillFrom("All targets", (ts) => ts)),
      handlesBox,
      h("div", { class: "toolbar toolbar-end" }, labeled("Pages per account", pagesIn), labeled("Accounts per page", sizeIn), buildBtn),
      costLine, jobHost,
      h("div", { class: "filterbar" }, search, minScore, countLine, h("span", { class: "spacer" }), exportCsv, exportXlsx, clearBtn),
      selBar, tableHost));
  drawJob();
  syncCost();
  reload();
  return el;
}
