// ScoreX dashboard - Discover > Smart follower database. Simple on purpose:
//   1. paste usernames or links  2. Scan: every smart follower TwitterScore lists for them (its API, 25 per request,
//   all pages), duplicates merged  3. the database: username, score, date of scan  4. Download CSV / Excel.
// Extras stay out of the way: search, add selected rows as targets, remove, clear. The scan runs in the background
// (sx.scoreboard.job, kind "smartdb"); Stop keeps what was read.
import { K } from "../../lib/constants.js";
import { parseHandleList, num } from "../../lib/util.js";
import { providerDefs } from "../../lib/providers.js";
import { toTable, fmtScan, scannedAt } from "../../lib/smartdb.js";
import { toXlsx, toCsv } from "../../lib/xlsx.js";
import { h, clear, fill, add, section, btn, busy, toast, renderTable, confirmDialog, xLink, link, progressBar, fmtAgo, fmtCount, debounce, truncate } from "../components.js";
import { secretField } from "./models.js";
import { connectProvider } from "./scores.js";

const SHOW = 500; // rows drawn at once (downloads always include every matching row)
const PER_REQUEST = 25; // TwitterScore's API page size

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
  let ts = null; // TwitterScore's provider state (key, on/off, site access)
  const sel = new Set();
  const sortState = { key: "score", dir: "desc" };
  const board = () => ctx.data[K.scoreboard] || {};
  const job = () => { const j = board().job; return j && j.kind === "smartdb" ? j : null; };
  const tz = () => ctx.settings.timezone;

  // ---- 1. TwitterScore setup, shown only while something is missing ----
  const setupHost = h("div", { id: "sdbSetup" });
  async function loadState() {
    const r = await ctx.send("scoresState", {}, { quiet: true });
    ts = r && Array.isArray(r.providers) ? r.providers.find((p) => p.id === "twitterscore") || null : null;
    drawSetup();
  }
  const ready = () => !!(ts && ts.hasKey && ts.enabled && ts.granted !== false);
  function drawSetup() {
    clear(setupHost);
    if (!ts || ready()) return;
    if (!ts.hasKey) {
      add(setupHost, h("div", { class: "banner banner-info sdb-setup" },
        h("div", { class: "stack-sm" },
          h("strong", null, "Step 1: your TwitterScore API key"),
          secretField(ctx, { key: "twitterscoreKey", label: "TwitterScore API key", placeholder: "Paste your key", id: "sdbKeyField", hint: h("span", null, "Stored only in this browser. ", link("https://twitterscore.io/api/prices", "Get a key ↗")), onChange: () => loadState() }))));
      return;
    }
    const defs = providerDefs(null);
    add(setupHost, h("div", { class: "banner banner-info sdb-setup" },
      h("span", null, ts.enabled ? "Key saved. Allow ScoreX to reach twitterscore.io (Chrome asks once)." : "Key saved. Turn TwitterScore on (Chrome asks once for access to twitterscore.io)."),
      btn("Turn on TwitterScore", () => connectProvider(ctx, defs, ts, { after: () => loadState() }), { kind: "primary", size: "sm", id: "sdbConnectBtn" })));
  }

  // ---- 2. accounts to scan ----
  const handlesBox = h("textarea", { class: "input mono", rows: 3, id: "sdbHandles", spellcheck: "false", "aria-label": "Usernames or links to scan", placeholder: "cobie, @hsakatrades, https://x.com/punk6529, twitterscore.io/twitter/zachxbt" });
  const scanBtn = btn("Scan smart followers", (e) => busy(e.currentTarget, async () => {
    const handles = parseHandleList(handlesBox.value);
    if (!handles.length) { toast("Paste at least one username or link", { type: "warn" }); handlesBox.focus(); return; }
    if (ts && !ts.hasKey) { toast("Add your TwitterScore API key first (above)", { type: "warn" }); return; }
    if (ts && (!ts.enabled || ts.granted === false)) { toast("Turn TwitterScore on first (above)", { type: "warn" }); return; }
    const r = await ctx.send("smartDbBuild", { handles }, { label: "Scan" });
    if (r) toast(`Scanning ${handles.length} account${handles.length === 1 ? "" : "s"} in the background`, { type: "success" });
  }), { kind: "primary", iconName: "discover", id: "sdbScanBtn" });
  const tier1Btn = btn("Use my Tier 1 targets", () => {
    const hs = ctx.targetList().filter((t) => Number(t.tier) === 1).map((t) => t.handle);
    handlesBox.value = hs.join(", ");
    toast(hs.length ? `${hs.length} accounts filled in` : "No Tier 1 targets yet", { type: hs.length ? "success" : "warn" });
  }, { size: "sm", kind: "ghost", id: "sdbTier1Btn" });

  // ---- scan progress / last result ----
  const jobHost = h("div", { id: "sdbJob", "aria-live": "polite" });
  function drawJob() {
    const j = job();
    const running = !!(j && j.status === "running");
    scanBtn.disabled = running;
    if (!j) { clear(jobHost); return; }
    const res = j.result || {};
    const line = running
      ? `Scanning ${j.current || "..."} · ${fmtCount(num(j.found))} found · ${fmtCount(num(j.requests))} requests · account ${Math.min(num(j.done) + 1, num(j.total) || 1)} of ${num(j.total) || 1}`
      : j.status === "done"
        ? `Done ${fmtAgo(j.finishedAt)}: ${fmtCount(num(res.found))} smart followers from ${num(res.accounts)} account${num(res.accounts) === 1 ? "" : "s"}, ${fmtCount(num(res.added))} new (${fmtCount(num(res.requests))} TwitterScore requests).`
        : j.status === "cancelled" ? `Stopped ${fmtAgo(j.finishedAt)}. What was read is saved.` : `Stopped: ${j.error || "error"}`;
    const notes = [];
    if (!running && Array.isArray(res.empty) && res.empty.length) notes.push(`No smart followers on TwitterScore for ${res.empty.slice(0, 5).map((x) => "@" + x).join(", ")}${res.empty.length > 5 ? "..." : ""}.`);
    if (!running && Array.isArray(res.errors) && res.errors.length) notes.push(res.errors.slice(0, 3).join(" · "));
    fill(jobHost, h("div", { class: "stack-sm" },
      running ? progressBar(Math.max(3, ((num(j.done) + (num(j.pagesEst) ? Math.min(1, num(j.page) / num(j.pagesEst)) : 0)) / (num(j.total) || 1)) * 100), { kind: "accent" }) : null,
      h("div", { class: "toolbar" },
        h("span", { class: ["small", !running && j.status === "error" && "text-red"] }, line),
        running ? btn("Stop", (e) => busy(e.currentTarget, async () => { const r = await ctx.send("scoreJobCancel", {}, { label: "Stop" }); if (r) toast("Stopping after the current page"); }), { size: "xs", id: "sdbStopBtn" }) : null),
      notes.length ? h("p", { class: "small muted" }, notes.join(" ")) : null));
  }

  // ---- 3. the database ----
  const search = h("input", { class: "input", type: "search", placeholder: "Search username", id: "sdbSearch", "aria-label": "Search the database", style: "min-width:200px" });
  const minScore = h("input", { class: "input", type: "number", min: "0", max: "1000", placeholder: "Min score", id: "sdbMinScore", "aria-label": "Minimum TwitterScore", style: "width:110px" });
  const countLine = h("span", { class: "small muted", id: "sdbCount" });
  const tableHost = h("div", { id: "sdbTable" });
  const selBar = h("div", { class: "toolbar", id: "sdbSelBar" });
  const filtered = () => {
    const q = search.value.trim().toLowerCase().replace(/^@/, "");
    const min = num(minScore.value, 0);
    return rows.filter((r) => (!min || (Number(r.score) || 0) >= min) && (!q || String(r.handle).includes(q) || (r.sources || []).some((s) => s.includes(q))));
  };
  const cols = [
    { key: "handle", label: "Username", sort: (r) => r.handle, render: (r) => xLink(r.handle) },
    { key: "score", label: "TwitterScore", num: true, align: "right", sort: (r) => Number(r.score) || 0, render: (r) => (r.score == null ? "-" : fmtCount(r.score)) },
    { key: "scanned", label: "Date of scan", sort: (r) => scannedAt(r) || 0, render: (r) => h("span", { class: "mono small nowrap" }, fmtScan(scannedAt(r), tz()) || "-") },
    { key: "sources", label: "Smart follower of", sort: (r) => (r.sources || []).length, render: (r) => h("span", { class: "small", title: (r.sources || []).map((s) => "@" + s).join(" ") }, truncate((r.sources || []).map((s) => "@" + s).join(" "), 60) || "-") },
  ];
  function drawSel() {
    const n = sel.size;
    if (!n) { clear(selBar); return; }
    fill(selBar,
      h("span", { class: "small" }, `${n} selected`),
      btn("Add as Tier 1 targets", (e) => addTargets(e, 1), { size: "xs", kind: "primary", id: "sdbAddT1" }),
      btn("Add as Tier 2 targets", (e) => addTargets(e, 2), { size: "xs", id: "sdbAddT2" }),
      btn("Remove from database", (e) => busy(e.currentTarget, async () => {
        const r = await ctx.send("smartDbRemove", { handles: [...sel] }, { label: "Remove" });
        if (r) { toast(`Removed ${r.removed}`, { type: "success" }); sel.clear(); await reload(); }
      }), { size: "xs", kind: "danger-soft", id: "sdbRemove" }));
  }
  function addTargets(e, tier) {
    busy(e.currentTarget, async () => {
      const r = await ctx.send("targetsUpsert", { rows: [...sel], defaults: { tier, source: "twitterscore-db" } }, { label: "Add targets" });
      if (r) toast(`Added ${r.added || 0} as Tier ${tier}${r.blacklisted ? `, ${r.blacklisted} on your blacklist skipped` : ""}. Follow status is checked before any comment.`, { type: "success" });
    });
  }
  function drawTable() {
    const list = filtered();
    const filteredOn = list.length !== rows.length;
    countLine.textContent = rows.length ? `${fmtCount(list.length)}${filteredOn ? ` of ${fmtCount(rows.length)}` : ""} account${list.length === 1 ? "" : "s"}${list.length > SHOW ? ` (the first ${SHOW} shown; downloads include all)` : ""}` : "";
    fill(tableHost, renderTable({ columns: cols, rows: list, rowKey: (r) => r.handle, selection: sel, onSelectionChange: drawSel, sortState, maxRows: SHOW, caption: "Smart follower database", stateKey: "smartdb", empty: rows.length ? "No account matches." : "The database is empty. Paste usernames or links above and press Scan." }));
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

  // ---- 4. download ----
  const stamp = () => new Date().toISOString().slice(0, 10);
  const download = (kind) => {
    const list = filtered();
    if (!list.length) { toast("Nothing to download yet", { type: "warn" }); return; }
    const table = toTable(list, tz());
    if (kind === "csv") save(`scorex-smart-followers-${stamp()}.csv`, toCsv(table), "text/csv;charset=utf-8");
    else save(`scorex-smart-followers-${stamp()}.xlsx`, toXlsx(table, "Smart followers"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    toast(`Downloaded ${fmtCount(list.length)} accounts`, { type: "success" });
  };
  const csvBtn = btn("Download CSV", () => download("csv"), { size: "sm", iconName: "download", id: "sdbCsv", title: "Every account in the list (all of them unless a search is typed)" });
  const xlsxBtn = btn("Download Excel", () => download("xlsx"), { size: "sm", iconName: "download", id: "sdbXlsx", title: "Every account in the list, as an .xlsx file" });
  const clearBtn = btn("Clear", async (e) => {
    const b = e.currentTarget;
    if (!(await confirmDialog(`Delete all ${fmtCount(rows.length)} accounts from the smart follower database? Download it first if you need it.`, { title: "Clear database", okLabel: "Delete", danger: true }))) return;
    busy(b, async () => { const r = await ctx.send("smartDbClear", {}, { label: "Clear" }); if (r) { toast("Database cleared", { type: "success" }); sel.clear(); await reload(); } });
  }, { size: "sm", kind: "danger-soft", id: "sdbClear" });

  let lastStatus = (job() || {}).status;
  ctx.on(K.scoreboard, () => {
    drawJob();
    const st = (job() || {}).status;
    if (st !== lastStatus) { lastStatus = st; reload(); } // finished (or started): show the new rows
  });
  ctx.on("settings", () => loadState());
  ctx.on("secrets", () => loadState());
  ctx.interval(() => { if ((job() || {}).status === "running" && tableHost.offsetParent !== null) reload(); }, 10000);

  const el = section({ wide: true, title: "Smart follower database", id: "smartDb", hint: `Paste usernames or links and press Scan: ScoreX reads every smart follower TwitterScore lists for them (with your API key, ${PER_REQUEST} per request), merges duplicates and saves username, score and date of scan in this browser. Only usernames are sent to TwitterScore.` },
    h("div", { class: "stack" },
      setupHost,
      handlesBox,
      h("div", { class: "toolbar" }, scanBtn, tier1Btn),
      jobHost,
      h("div", { class: "filterbar sdb-bar" }, search, minScore, countLine, h("span", { class: "spacer" }), csvBtn, xlsxBtn, clearBtn),
      selBar, tableHost));
  drawJob();
  loadState();
  reload();
  return el;
}
