// History tab: every generated comment with filters, summary, CSV export; totals by period and
// "Clear history" are collapsed. Reads IndexedDB through lib/history.js; never writes it (clearing goes
// through historyClear).

import { HS } from "../../lib/constants.js";
import * as history from "../../lib/history.js";
import { aggregate } from "../../lib/costs.js";
import { num, zonedTime } from "../../lib/util.js";
import { h, clear, section, advanced, btn, toast, icon, renderTable, selectEl, labeled, confirmDialog, download, stamp, groupBadge, tierBadge, statusBadge, badge, xLink, link, fmtUsd, fmtDateTime, fmtTokens, truncate, debounce, segmented, add, fill } from "../components.js";

const STATUS_OPTS = [["", "All statuses"], [HS.POSTED, "Posted"], [HS.PENDING_REVIEW, "Pending review"], [HS.APPROVED, "Approved"], [HS.QUEUED, "Queued"], [HS.POSTING, "Posting"], [HS.SKIPPED, "Skipped"], [HS.FAILED, "Failed"]];

export default {
  id: "history",
  title: "History",
  hint: "Every generated comment with its model, cost, status and results.",
  async render(root, ctx) {
    const f = { from: "", to: "", status: "", group: "", model: "", text: "" };
    const sortState = { key: "createdAt", dir: "desc" };
    let rows = [];
    let all = [];

    const fFrom = h("input", { type: "date", class: "input", id: "hFrom" });
    const fTo = h("input", { type: "date", class: "input", id: "hTo" });
    const fStatus = selectEl(STATUS_OPTS, "", { id: "hStatus" });
    const fGroup = selectEl([["", "All groups"], ["A", "Group A"], ["B", "Group B"]], "", { id: "hGroup" });
    const fModel = selectEl([["", "All models"]], "", { id: "hModel" });
    const fText = h("input", { type: "search", class: "input", id: "hText", placeholder: "Search comment or post text" });

    const summary = h("div", { class: "summary-row", id: "historySummary", "aria-live": "polite" });
    const tableHost = h("div", { id: "historyTable" });
    const quickHost = h("div", { id: "historyQuick" });
    let quickView = "day";

    // Local date (yyyy-mm-dd) -> timestamp at local midnight in the settings time zone.
    const dayStart = (v) => { const [y, m, d] = v.split("-").map(Number); return zonedTime(y, m, d, 0, 0, ctx.settings.timezone); };

    async function load() {
      const tz = ctx.settings.timezone;
      let from = f.from ? dayStart(f.from) : undefined;
      let to = f.to ? dayStart(f.to) + 864e5 - 1 : undefined;
      if (from && to && from > to) [from, to] = [to - 864e5 + 1, from + 864e5 - 1];
      try {
        [rows, all] = await Promise.all([
          history.query({ from, to, status: f.status || undefined, group: f.group || undefined, model: f.model || undefined, text: f.text || undefined, limit: 5000 }),
          history.all(),
        ]);
      } catch (e) {
        clear(tableHost).appendChild(h("div", { class: "table-empty" }, "Could not read history: " + e.message));
        return;
      }
      fillModels();
      draw(tz);
    }

    function fillModels() {
      const names = new Set(ctx.settings.models.map((m) => m.name).filter(Boolean));
      for (const r of all) if (r.modelName) names.add(r.modelName);
      const cur = fModel.value;
      clear(fModel).appendChild(h("option", { value: "" }, "All models"));
      for (const n of [...names].sort()) fModel.appendChild(h("option", { value: n }, n));
      fModel.value = names.has(cur) ? cur : "";
    }

    function results(r) {
      const res = r.results || {};
      const parts = [];
      if (r.liked) parts.push(badge("liked", "grey", "ScoreX liked the post before replying"));
      if (res.likes != null) parts.push(h("span", { class: "small tnum", title: "Likes on your reply" }, `${res.likes}\u2665`));
      if (res.replies != null) parts.push(h("span", { class: "small tnum", title: "Replies to your reply" }, `${res.replies} repl${res.replies === 1 ? "y" : "ies"}`));
      if (res.authorReplied) parts.push(badge("author replied", "green"));
      if (res.followedBack) parts.push(badge("followed back", "green"));
      if (!parts.length) return r.status === HS.POSTED ? h("span", { class: "muted small" }, res.checkedAt ? "no response" : "not checked yet") : "-";
      return h("div", { class: "chips-inline" }, parts);
    }

    function draw(tz) {
      const cost = rows.reduce((a, r) => a + num(r.cost), 0);
      const posted = rows.filter((r) => r.status === HS.POSTED).length;
      const tokens = rows.reduce((a, r) => a + num(r.tokens && r.tokens.input) + num(r.tokens && r.tokens.output), 0);
      fill(summary, 
        h("span", { class: "summary-item" }, h("span", { class: "summary-num", id: "historyCount" }, String(rows.length)), "records"),
        h("span", { class: "summary-item" }, h("span", { class: "summary-num" }, String(posted)), "posted"),
        h("span", { class: "summary-item" }, h("span", { class: "summary-num" }, fmtUsd(cost)), "cost"),
        h("span", { class: "summary-item" }, h("span", { class: "summary-num" }, fmtTokens(tokens)), "tokens"),
        h("span", { class: "summary-item" }, h("span", { class: "summary-num" }, posted ? fmtUsd(cost / posted) : "-"), "per posted"));

      clear(tableHost).appendChild(renderTable({
        columns: [
          { key: "createdAt", label: "Date / time", render: (r) => h("span", { class: "nowrap", title: r.postedAt ? "Posted " + fmtDateTime(r.postedAt) : "" }, fmtDateTime(r.createdAt)) },
          { key: "target", label: "Target", render: (r) => xLink(r.target) },
          { key: "group", label: "Group", render: (r) => groupBadge(r.group) },
          { key: "tier", label: "Tier", render: (r) => tierBadge(r.tier) },
          { key: "postUrl", label: "Post", sort: false, render: (r) => (r.postUrl ? link(r.postUrl, h("span", { class: "nowrap" }, "open ", icon("external")), { cls: "small" }) : "-") },
          { key: "modelName", label: "Model", render: (r) => h("span", { class: "mono small nowrap" }, r.modelName || r.modelId || "-") },
          { key: "effort", label: "Reasoning", render: (r) => r.effort || "-" },
          { key: "tokens", label: "Tokens in/out/reas.", align: "right", sort: (r) => num(r.tokens && r.tokens.input) + num(r.tokens && r.tokens.output), render: (r) => h("span", { class: "nowrap small mono" }, `${fmtTokens(num(r.tokens && r.tokens.input))} / ${fmtTokens(num(r.tokens && r.tokens.output))} / ${fmtTokens(num(r.tokens && r.tokens.reasoning))}`) },
          { key: "cost", label: "Cost", align: "right", render: (r) => fmtUsd(r.cost), sort: (r) => num(r.cost) },
          { key: "comment", label: "Comment", sort: false, className: "col-text", render: (r) => h("div", { class: "cell-text", title: r.comment || "" }, r.replyUrl ? link(r.replyUrl, truncate(r.comment || "", 140)) : truncate(r.comment || "-", 140)) },
          { key: "status", label: "Status", render: (r) => h("span", { class: "nowrap" }, statusBadge(r.status, r.reason), r.reason ? h("span", { class: "reason-dot", title: r.reason, "aria-label": "Reason: " + r.reason }, icon("info")) : null) },
          { key: "results", label: "Results", sort: (r) => num(r.results && r.results.likes) + 5 * num(r.results && r.results.replies) + (r.results && r.results.followedBack ? 100 : 0), render: results },
        ],
        rows,
        rowKey: (r) => r.id,
        sortState,
        maxRows: 100,
        empty: all.length ? "No records match these filters." : "No history yet. Every generated comment is recorded here with its cost and outcome.",
        caption: "History",
      }));
      drawQuick(tz);
    }

    function drawQuick(tz) {
      const agg = aggregate(all, tz);
      const list = quickView === "day" ? agg.byDay.slice(0, 14) : quickView === "week" ? agg.byWeek.slice(0, 12) : agg.byMonth.slice(0, 12);
      clear(quickHost).appendChild(renderTable({
        columns: [
          { key: "key", label: quickView === "day" ? "Day" : quickView === "week" ? "Week" : "Month" },
          { key: "comments", label: "Generated", align: "right" },
          { key: "posted", label: "Posted", align: "right" },
          { key: "skipped", label: "Skipped", align: "right" },
          { key: "failed", label: "Failed", align: "right" },
          { key: "cost", label: "Cost", align: "right", render: (r) => fmtUsd(r.cost) },
        ],
        rows: list, rowKey: (r) => r.key, sortState: { key: "key", dir: "desc" }, empty: "No data yet.",
      }));
    }

    const reload = debounce(load, 250);
    fFrom.addEventListener("change", () => { f.from = fFrom.value; reload(); });
    fTo.addEventListener("change", () => { f.to = fTo.value; reload(); });
    fStatus.addEventListener("change", () => { f.status = fStatus.value; reload(); });
    fGroup.addEventListener("change", () => { f.group = fGroup.value; reload(); });
    fModel.addEventListener("change", () => { f.model = fModel.value; reload(); });
    fText.addEventListener("input", () => { f.text = fText.value.trim(); reload(); });

    const exportBtn = btn("Export CSV", () => {
      if (!rows.length) { toast("Nothing to export with these filters.", { type: "warn" }); return; }
      download(`scorex-history-${stamp()}.csv`, history.toCsvText(rows), "text/csv");
      toast(`Exported ${rows.length} rows`, { type: "success" });
    }, { iconName: "download", size: "sm", id: "historyExportBtn" });
    const resetBtn = btn("Reset filters", () => {
      Object.assign(f, { from: "", to: "", status: "", group: "", model: "", text: "" });
      fFrom.value = fTo.value = fText.value = ""; fStatus.value = fGroup.value = fModel.value = "";
      load();
    }, { kind: "ghost", size: "sm" });
    const clearBtn = btn("Clear history", async () => {
      if (!(await confirmDialog("Delete the comment history (costs, results)? Comments posted in the last 8 days and items still in the queue are kept, because the daily and per-account safety limits depend on them. Targets and settings stay. This cannot be undone - export a CSV first if you need it.", { title: "Clear history", okLabel: "Delete history", danger: true }))) return;
      const r = await ctx.send("historyClear", {}, { label: "Clear history" });
      if (r) { toast(`History cleared (${num(r.removed)} removed, ${num(r.kept)} kept for safety limits)`); load(); ctx.refreshCounts(); }
    }, { kind: "danger-soft", iconName: "trash", id: "historyClearBtn" });

    const quickSeg = segmented([["day", "Per day"], ["week", "Per week"], ["month", "Per month"]], quickView, (v) => { quickView = v; drawQuick(ctx.settings.timezone); }, { label: "Totals period" });

    add(root,
      h("div", { class: "stack-sm", style: "padding-bottom:18px" },
        h("div", { class: "filters-grid" },
          labeled("From", fFrom), labeled("To", fTo), labeled("Status", fStatus), labeled("Group", fGroup), labeled("Model", fModel), labeled("Search", fText)),
        h("div", { class: "toolbar" }, summary, h("span", { class: "spacer" }), resetBtn, exportBtn)),
      section({ wide: true, title: "Comments", hint: "Newest first. Hover a status for its reason." }, tableHost),
      advanced({ key: "history.totals", title: "Totals by period", desc: "Generated, posted, skipped, failed and cost per day, week or month" },
        section({ wide: true, title: "All history", actions: quickSeg }, quickHost)),
      advanced({ key: "history.clear", title: "Clear history", desc: "Delete old records (recent posts and the open queue are kept for the safety limits)" },
        section({ title: "Danger zone", hint: "Also empties the review queue and resets the cost totals shown here. The monthly budget ledger is kept." }, clearBtn)));

    await load();
    ctx.on("counts", reload);
    ctx.on("tick", reload);
    ctx.on("settings", (s, from) => { if (!from) reload(); });
  },
};
