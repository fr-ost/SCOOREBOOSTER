// History (#history; #results and #comments open it too): three views under one 7 d / 30 d / All + tier filter.
//   Comments (the default, all time): every comment ScoreX wrote. Stats: follow-back funnel, every day (posted bars + follow-back squares, 12-week heatmap), views per reply,
//     conversion by tier and tone / preset, days to a follow-back, top responders, author replies, A/B summary.
//   Comments: the history table (Date, Target, Comment, Status with its reason, Results; a row opens the details
//     drawer), filters, CSV export, totals by period, history retention and Clear history.
//   Spend: budget, daily cost, totals per model / day / week / month and performance per model and tone.
// Records are read once and again only when history changed (counts or new log lines; skipped when the signature is
// unchanged), never on the 30 s tick. Hidden views and closed sections are not drawn. Clearing goes through historyClear.

import { K, HS } from "../../lib/constants.js";
import * as history from "../../lib/history.js";
import { toXlsx, toCsv as tableToCsv } from "../../lib/xlsx.js";
import * as FB from "../../lib/followbacks.js";
import { aggregate, performance, budgetStatus } from "../../lib/costs.js";
import { funnel as funnelOf, daysToFollowBack, conversionBy, dailySeries, topResponders, authorReplies } from "../../lib/analytics.js";
import { MAIN_TONE, followStatus, FS } from "../../lib/targets.js";
import { num, zonedTime, dayKey, DAY } from "../../lib/util.js";
import {
  h, clear, section, advanced, btn, toast, icon, renderTable, selectEl, labeled, confirmDialog, download, stamp, tierBadge, statusBadge,
  badge, xLink, link, drawer, progressBar, figure, ledger, statusSquare, fmtUsd, fmtDateTime, fmtDay, fmtTokens, fmtNum, fmtPct, fmtAgo,
  truncate, debounce, segmented, add, fill,
} from "../components.js";
import { responsive, funnel, dailyBars, heatmap, histogram, barInCell, bars } from "../charts.js";
import { PRESET_LABEL } from "./models.js";

const STATUS_OPTS = [["", "All statuses"], [HS.POSTED, "Posted"], [HS.PENDING_REVIEW, "Pending review"], [HS.APPROVED, "Approved"], [HS.QUEUED, "Queued"], [HS.POSTING, "Posting"], [HS.SKIPPED, "Skipped"], [HS.FAILED, "Failed"]];
const OUTCOME_OPTS = [["", "Any outcome"], ["liked", "Reply got likes"], ["replied", "Reply got replies"], ["author", "Author replied"], ["followed", "Followed back"], ["none", "No response"], ["unchecked", "Not checked yet"]];
const VIEWS = [["comments", "Comments"], ["followbacks", "Follow-backs"], ["ov", "Stats"], ["spend", "Spend"]];
const RANGES = [["7", "7 d"], ["30", "30 d"], ["all", "All"]];
const TIERS = [["", "All tiers"], ["1", "T1"], ["2", "T2"]];

const toneName = (key, settings) => {
  if (!key || key === MAIN_TONE || key === "main") return "Your Tone prompt";
  if (key === "custom") return "Custom text (old)";
  if (String(key).startsWith("custom:")) { const c = (settings.customTones || []).find((x) => "custom:" + x.id === key); return c ? c.name || "Custom tone" : "Custom (missing)"; }
  return String(key).charAt(0).toUpperCase() + String(key).slice(1);
};
const safeUrl = (u) => { try { const x = new URL(String(u || "")); return x.protocol === "https:" ? x.href : null; } catch (_) { return null; } };
const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const views = (r) => { const v = r && r.results ? r.results.views : null; return v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v); };
const dayLabel = (d) => fmtDay(Date.parse(d + "T12:00:00Z"));
const outcomeOk = (r, o) => {
  if (!o) return true;
  const res = r.results || {};
  if (o === "liked") return num(res.likes) > 0;
  if (o === "replied") return num(res.replies) > 0;
  if (o === "author") return !!res.authorReplied;
  if (o === "followed") return !!res.followedBack;
  if (o === "unchecked") return r.status === HS.POSTED && !res.checkedAt;
  if (o === "none") return r.status === HS.POSTED && !!res.checkedAt && !num(res.likes) && !num(res.replies) && !res.authorReplied && !res.followedBack;
  return true;
};

export default {
  id: "history",
  title: "History",
  async render(root, ctx) {
    const readP = (q = ctx.params || {}) => ({
      view: VIEWS.some(([v]) => v === q.view) ? q.view : "comments",
      range: RANGES.some(([v]) => v === q.r) ? q.r : "all",
      tier: q.t === "1" || q.t === "2" ? q.t : "",
    });
    const p = readP();
    let all = [];
    let loadErr = "";
    let sig = null;
    const dirty = { ov: true, comments: true, followbacks: true, spend: true };
    const markAll = () => { dirty.ov = dirty.comments = dirty.followbacks = dirty.spend = true; };
    const tz = () => ctx.settings.timezone;
    const sinceTs = () => (p.range === "all" ? 0 : Date.now() - Number(p.range) * DAY);
    const rangeDays = () => (p.range === "7" ? 7 : p.range === "30" ? 30 : 90);
    const rangeText = () => (p.range === "all" ? "all time" : `the last ${p.range} days`);
    const tierOk = (t) => !p.tier || String(t) === p.tier;
    const tierText = () => (p.tier ? ` · tier ${p.tier}` : "");
    const targetsF = () => (p.tier ? Object.fromEntries(Object.entries(ctx.targets).filter(([, t]) => t && String(t.tier) === p.tier)) : ctx.targets);
    const recsT = () => all.filter((r) => tierOk(r.tier));
    const postedIn = () => { const since = sinceTs(); return recsT().filter((r) => r.status === HS.POSTED && r.postedAt && (!since || r.postedAt >= since)); };
    const createdIn = () => { const since = sinceTs(); return recsT().filter((r) => !since || (r.createdAt || 0) >= since); };

    // ------------------------------------------------ filter bar + panes
    const viewSeg = segmented(VIEWS, p.view, (v) => setP({ view: v }), { label: "History view" });
    viewSeg.id = "resultsView";
    const rangeSeg = segmented(RANGES, p.range, (v) => setP({ range: v }), { label: "Time range" });
    rangeSeg.id = "resultsRange";
    const tierSeg = segmented(TIERS, p.tier, (v) => setP({ tier: v }), { label: "Tier" });
    tierSeg.id = "resultsTier";
    const panes = { ov: h("div", { class: "res-pane stack-lg", id: "resultsOverview" }), comments: h("div", { class: "res-pane", id: "resultsComments" }), followbacks: h("div", { class: "res-pane", id: "resultsFollowBacks" }), spend: h("div", { class: "res-pane", id: "resultsSpend" }) };
    add(root,
      h("div", { class: "filterbar res-bar" }, viewSeg, h("span", { class: "spacer" }), rangeSeg, tierSeg),
      panes.ov, panes.comments, panes.followbacks, panes.spend);

    function setP(patch) {
      Object.assign(p, patch);
      // Explicit values in the URL (a cleared value would fall back to the defaults: Comments, all time).
      ctx.setParams({ view: p.view, r: p.range, t: p.tier || null });
      markAll();
      show();
    }
    function show() {
      viewSeg.set(p.view); rangeSeg.set(p.range); tierSeg.set(p.tier);
      for (const [v, el] of Object.entries(panes)) el.hidden = v !== p.view;
      if (dirty[p.view]) { dirty[p.view] = false; DRAW[p.view](); }
    }

    // ================================================ Overview
    const convKey = { v: "tone" };
    function drawOverview() {
      const pane = panes.ov;
      if (loadErr) { fill(pane, h("div", { class: "banner banner-danger" }, "Could not read history: " + loadErr)); return; }
      const s = ctx.settings, since = sinceTs(), T = targetsF(), recs = recsT(), posted = postedIn();
      const bl = p.tier ? {} : ctx.data[K.blacklist] || {};
      const f = funnelOf(T, recs, bl, { since });
      const giveUp = s.follow.giveUpDays || 14;
      // lib/analytics.js counts every target with a comment as commented, also one that follows you without a recorded
      // follow-back or is not checked yet. Those are outside "Don't follow you", so they are left out of "Commented"
      // here: each stage is then part of the one before it.
      const postedTo = new Set(recs.filter((r) => r.status === HS.POSTED && r.postedAt && (!since || r.postedAt >= since)).map((r) => r.target));
      const outside = { follows: 0, checking: 0 };
      for (const t of Object.values(T || {})) {
        if (!t || !t.handle || (since && (t.addedAt || 0) < since && ((t.stats && t.stats.firstCommentAt) || 0) < since)) continue;
        if (!((t.stats && t.stats.comments > 0) || postedTo.has(t.handle))) continue;
        const fs = followStatus(t);
        if (fs === FS.FOLLOWS) outside.follows++; else if (fs === FS.CHECKING) outside.checking++;
      }
      const stages = [
        { label: "Added", value: f.added },
        { label: "Checked", value: Math.max(0, f.added - f.checking) },
        { label: "Don't follow you", value: Math.max(0, f.added - f.checking - f.follows) },
        { label: "Commented", value: Math.max(0, f.commented - outside.follows - outside.checking) },
        { label: "Followed back", value: f.followedBack },
      ];
      const B = (v) => h("b", { class: "mono" }, fmtNum(v));
      const funnelSec = section({ wide: true, title: "Follow-back funnel", hint: (p.range === "all" ? "all accounts" : `accounts added in the last ${p.range} days`) + tierText(), id: "resFunnel" },
        f.added ? responsive((w) => funnel(stages, { w }), { initialWidth: 900 }) : h("p", { class: "muted small" }, "No accounts in this range yet. Add targets to start the funnel."),
        h("div", { class: "fig-sub res-branches" }, "Side branches: ", B(f.follows), outside.follows ? ` already followed you (${outside.follows} of them also got a comment) · ` : " already followed you (never commented) · ", B(f.gaveUp), ` removed after ${giveUp} days without a follow-back · `, B(f.checking), " still checking",
          f.decidedRate != null ? [" · follow-back rate ", h("b", { class: "mono" }, fmtPct(f.decidedRate * 100, 1)), " of decided accounts"] : null));

      // Every day + 12-week heatmap
      const days = rangeDays();
      const ds = dailySeries(recs, T, { days, tz: tz() });
      const rows = ds.map((d) => ({ label: dayLabel(d.d), posted: d.posted, fb: d.followBacks }));
      const totalPosted = ds.reduce((a, d) => a + d.posted, 0), totalFb = ds.reduce((a, d) => a + d.followBacks, 0);
      const hm = heatWeeks(T);
      const dailySec = section({ wide: true, title: "Every day", id: "resDaily",
        hint: h("span", { class: "legend" }, h("span", null, h("span", { class: "key key-bar", "aria-hidden": "true" }), " comments posted ", B(totalPosted)), h("span", null, h("span", { class: "key key-fb", "aria-hidden": "true" }), " follow-backs ", B(totalFb)), p.range === "all" ? h("span", null, "last 90 days") : null) },
        h("div", { class: "daily-grid" },
          responsive((w) => dailyBars(rows, { w, h: 160, label: `Comments posted and follow-backs per day, last ${days} days: ${totalPosted} posted, ${totalFb} follow-backs` }), { initialWidth: 860 }),
          h("div", { class: "heat-col" }, h("span", { class: "cap" }, "Follow-backs · 12 weeks"), heatmap(hm.weeks, { titles: hm.titles, label: `Follow-backs per day over 12 weeks: ${hm.total} in total` }), h("span", { class: "small muted" }, "Mon at the top"))));

      // Views per reply (median results.views per day)
      const byDay = new Map();
      for (const r of posted) { const v = views(r); if (v == null) continue; const k = dayKey(r.postedAt, tz()); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(v); }
      const allViews = [...byDay.values()].flat();
      const reach = (ctx.status && ctx.status.reach) || {};
      const viewsSec = section({ wide: true, title: "Views per reply", id: "resViews", hint: `median views per day · ${rangeText()}${tierText()}` },
        allViews.length
          ? [responsive((w) => bars(ds.map((d) => ({ label: dayLabel(d.d), value: byDay.has(d.d) ? median(byDay.get(d.d)) : 0 })), { width: w, height: 90, unit: " views", label: `Median views per reply per day: overall ${fmtNum(median(allViews))} from ${allViews.length} replies` }), { initialWidth: 860 }),
            h("div", { class: "fig-sub" }, h("span", null, "median ", B(median(allViews)), ` views from ${allViews.length} checked repl${allViews.length === 1 ? "y" : "ies"}`),
              reach.medianViews != null ? h("span", null, " · reach monitor: ", B(reach.medianViews), " now", reach.prevMedianViews != null ? [" vs ", B(reach.prevMedianViews), " the week before"] : null) : null)]
          : h("p", { class: "muted small" }, "No view counts yet. They are read during the engagement checks of your replies."),
        h("p", { class: "small muted res-caveat" }, "Views are a proxy - X does not tell you when it hides a reply."));

      // Conversion by tier / tone / preset + days to a follow-back
      const convHost = h("div");
      const convSeg = segmented([["tone", "Tone"], ["preset", "Preset"]], convKey.v, (v) => { convKey.v = v; drawConv(); }, { label: "Conversion by", cls: "seg-sm" });
      const label = (k, key) => (k === "tone" ? toneName(key, s) : k === "preset" ? PRESET_LABEL[key] || key : key);
      const drawConv = () => fill(convHost, convTable(conversionBy(convKey.v, T, posted).map((r) => ({ ...r, label: label(convKey.v, r.key) })), "Conversion by " + convKey.v));
      drawConv();
      const dtf = daysToFollowBack(T);
      const bins = Array(giveUp).fill(0);
      for (const t of Object.values(T)) {
        const fb = t && t.rel && t.rel.followedBackAt, first = t && t.stats && t.stats.firstCommentAt;
        if (fb && first && fb >= first) bins[Math.min(giveUp, Math.max(1, Math.floor((fb - first) / DAY) + 1)) - 1]++;
      }
      const conv = h("div", { class: "cols-3 res-conv" },
        h("div", { class: "stack-sm" }, h("span", { class: "cap" }, "By tier"), convTable(conversionBy("tier", T, posted).map((r) => ({ ...r, label: r.key })), "Conversion by tier")),
        h("div", { class: "stack-sm" }, h("div", { class: "cap-row" }, h("span", { class: "cap" }, "By ", convKey.v === "tone" ? "tone" : "preset"), convSeg), convHost),
        h("div", { class: "stack-sm" }, h("span", { class: "cap" }, "Days to a follow-back"),
          dtf.n ? responsive((w) => histogram(bins, { w, h: 96, label: `Days from the first comment to the follow-back: median ${dtf.median.toFixed(1)}, average ${dtf.avg.toFixed(1)} (${dtf.n} accounts)` }), { initialWidth: 340 }) : null,
          h("span", { class: "small muted" }, dtf.n ? ["median ", B(dtf.median.toFixed(1)), " days · average ", B(dtf.avg.toFixed(1)), ` · ${dtf.n} account${dtf.n === 1 ? "" : "s"}`] : "No follow-backs yet: they usually arrive 1-14 days after the first comments.")));
      const convSec = section({ wide: true, title: "What converts", hint: `accounts commented on in ${rangeText()}${tierText()}; each account counts once`, id: "resConv" }, conv);

      // Top responders | author replies
      const top = topResponders(T, posted, 8);
      const replies = authorReplies(posted, 8);
      const people = h("div", { class: "cols-even" },
        h("div", { class: "stack-sm" }, h("span", { class: "cap" }, "Top responders"),
          top.length ? renderTable({
            caption: "Top responders", stateKey: false,
            columns: [
              { key: "handle", label: "Account", render: (r) => h("span", { class: "cell-handle" }, xLink(r.handle), r.followedBack ? statusSquare("green", "", { title: "Followed back" }) : null) },
              { key: "comments", label: "Comments", align: "right" },
              { key: "likes", label: "Likes", align: "right" },
              { key: "replies", label: "Replies", align: "right" },
              { key: "authorReplies", label: "Author", align: "right", title: "Replies from the account itself" },
              { key: "points", label: "Points", align: "right", render: (r) => barInCell(r.points, top[0].points, { w: 50, text: String(r.points), label: `${r.points} points` }) },
            ],
            rows: top, rowKey: (r) => r.handle, sortState: topSort,
          }) : h("p", { class: "muted small" }, "Nobody has responded in this range yet.")),
        h("div", { class: "stack-sm" }, h("span", { class: "cap" }, "Author replied: answer yourself"),
          replies.length ? h("div", { class: "list" }, replies.map((r) => {
            const url = safeUrl(r.replyUrl);
            return h("div", { class: "li" }, h("span", { class: "need-ico good", "aria-hidden": "true" }, icon("reply")),
              h("div", { class: "li-main" }, h("div", { class: "li-title" }, `@${r.target} replied to your comment`), h("div", { class: "small muted res-quote" }, truncate(r.comment || "", 140), " · ", fmtAgo(r.at))),
              url ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer", class: "btn btn-xs" }, "Open reply") : null);
          })) : h("p", { class: "muted small" }, "No author replies in this range.")));
      const peopleSec = section({ wide: true, title: "Who responds", id: "resPeople" }, people);

      // A/B summary (tone x preset arms), details in Tone
      const arms = performance(posted).byArm.slice(0, 5);
      const abSec = section({ wide: true, title: "A/B summary", hint: "follow-back rate per tone and preset", id: "resAb", actions: h("a", { href: "#tones", class: "small" }, "A/B tests in Tone") },
        arms.length ? renderTable({
          caption: "A/B summary", stateKey: false,
          columns: [
            { key: "key", label: "Tone · preset", render: (r) => { const [tone, preset] = String(r.key).split(" · "); return `${toneName(tone === "?" ? "" : tone, s)} · ${PRESET_LABEL[preset] || preset}`; } },
            { key: "posted", label: "Posted", align: "right" },
            { key: "followBackRate", label: "Follow-back rate", align: "right", render: (r) => fmtPct(r.followBackRate * 100, 1) },
            { key: "avgLikes", label: "Avg likes", align: "right", render: (r) => r.avgLikes.toFixed(1) },
            { key: "costPerFollowBack", label: "Cost / follow-back", align: "right", render: (r) => (r.costPerFollowBack == null ? "-" : fmtUsd(r.costPerFollowBack)) },
          ],
          rows: arms, rowKey: (r) => r.key, sortState: abSort,
        }) : h("p", { class: "muted small" }, "No posted comments in this range yet."));

      fill(pane, funnelSec, dailySec, viewsSec, convSec, peopleSec, abSec);
    }
    const topSort = { key: "points", dir: "desc" };
    const abSort = { key: "posted", dir: "desc" };
    function convTable(rows, caption) {
      if (!rows.length) return h("p", { class: "muted small" }, "No commented accounts in this range yet.");
      const max = Math.max(0.0001, ...rows.map((r) => r.rate));
      return h("table", { class: "mini-table" }, h("caption", { class: "sr-only" }, caption),
        h("tbody", null, rows.map((r) => h("tr", null,
          h("td", null, r.label),
          h("td", { class: "r muted" }, `${fmtNum(r.accounts)} acc.`),
          h("td", { class: "r" }, barInCell(r.rate, max, { w: 70, text: fmtPct(r.rate * 100, 1), label: `${r.label}: ${fmtPct(r.rate * 100, 1)} followed back (${r.followBacks} of ${r.accounts} accounts)` }))))));
    }
    // Follow-backs per day over 12 Monday-first weeks (oldest first), ending with the current week.
    function heatWeeks(T) {
      const [y, m, d] = dayKey(Date.now(), tz()).split("-").map(Number);
      const today = Date.UTC(y, m - 1, d), dow = (new Date(today).getUTCDay() + 6) % 7, start = today - (dow + 77) * DAY;
      const weeks = Array.from({ length: 12 }, () => Array(7).fill(0));
      let total = 0;
      for (const t of Object.values(T)) {
        const at = t && t.rel && t.rel.followedBackAt;
        if (!at) continue;
        const [yy, mm, dd] = dayKey(at, tz()).split("-").map(Number);
        const i = Math.round((Date.UTC(yy, mm - 1, dd) - start) / DAY);
        if (i >= 0 && i < 84) { weeks[Math.floor(i / 7)][i % 7]++; total++; }
      }
      const titles = weeks.map((wk, i) => wk.map((n, j) => { const ts = start + (i * 7 + j) * DAY; return ts > today ? "" : `${new Date(ts).toISOString().slice(0, 10)}: ${n} follow-back${n === 1 ? "" : "s"}`; }));
      return { weeks, titles, total };
    }

    // ================================================ Comments
    const f = { from: "", to: "", status: "", model: "", target: "", outcome: "", text: "" };
    const sortState = { key: "createdAt", dir: "desc" };
    const fFrom = h("input", { type: "date", class: "input", id: "hFrom" });
    const fTo = h("input", { type: "date", class: "input", id: "hTo" });
    const fStatus = selectEl(STATUS_OPTS, "", { id: "hStatus" });
    const fModel = selectEl([["", "All models"]], "", { id: "hModel" });
    const targetList = h("datalist", { id: "hTargetList" });
    const fTarget = h("input", { type: "search", class: "input", id: "hTarget", placeholder: "@handle", list: "hTargetList", autocomplete: "off", spellcheck: "false" });
    const fOutcome = selectEl(OUTCOME_OPTS, "", { id: "hOutcome" });
    const fText = h("input", { type: "search", class: "input", id: "hText", placeholder: "Search comment or post text" });
    const summary = h("div", { class: "summary-row", id: "historySummary", "aria-live": "polite" });
    const tableHost = h("div", { id: "historyTable" });
    const quickHost = h("div", { id: "historyQuick" });
    let quickView = "day", rows = [], openId = null, dr = null;
    const quickSort = { key: "key", dir: "desc" };
    const dayStart = (v) => { const [y, m, d] = v.split("-").map(Number); return zonedTime(y, m, d, 0, 0, tz()); };

    function filtered() {
      let from = f.from ? dayStart(f.from) : 0, to = f.to ? dayStart(f.to) + DAY - 1 : 0;
      if (from && to && from > to) [from, to] = [to - DAY + 1, from + DAY - 1];
      if (!f.from && !f.to) from = sinceTs();
      const tl = f.target.toLowerCase().replace(/^@+/, "").trim(), q = f.text.toLowerCase();
      return recsT().filter((r) =>
        (!from || (r.createdAt || 0) >= from) && (!to || (r.createdAt || 0) <= to) &&
        (!f.status || r.status === f.status) && (!f.model || r.modelId === f.model || r.modelName === f.model) &&
        (!tl || r.target === tl) && outcomeOk(r, f.outcome) &&
        (!q || String(r.comment || "").toLowerCase().includes(q) || String(r.postText || "").toLowerCase().includes(q)))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 5000);
    }
    function fillLists() {
      const names = new Set(ctx.settings.models.map((m) => m.name).filter(Boolean));
      for (const r of all) if (r.modelName) names.add(r.modelName);
      const cur = fModel.value;
      clear(fModel).appendChild(h("option", { value: "" }, "All models"));
      for (const n of [...names].sort()) fModel.appendChild(h("option", { value: n }, n));
      fModel.value = names.has(cur) ? cur : "";
      const handles = new Set([...Object.keys(ctx.targets), ...all.map((r) => r.target).filter(Boolean)]);
      fill(targetList, [...handles].sort().slice(0, 500).map((x) => h("option", { value: "@" + x })));
    }
    function resultsChips(r) {
      const res = r.results || {};
      const parts = [];
      if (r.follow === "followed") parts.push(badge("followed first", "green", "ScoreX followed this account right before liking and replying (its profile, reloaded, showed Following)"));
      else if (r.follow === "already") parts.push(badge("following", "grey", "Right before replying, the account's profile showed you already follow it"));
      if (r.liked) parts.push(badge("liked post", "grey", "ScoreX liked the post before replying"));
      if (res.likes != null) parts.push(h("span", { class: "small tnum", title: "Likes on your reply" }, `${res.likes}♥`));
      if (res.replies != null) parts.push(h("span", { class: "small tnum", title: "Replies to your reply" }, `${res.replies} repl${res.replies === 1 ? "y" : "ies"}`));
      if (views(r) != null) parts.push(h("span", { class: "small tnum", title: "Views of your reply (a proxy for reach)" }, `${fmtNum(views(r))} views`));
      if (res.authorReplied) parts.push(badge("author replied", "green"));
      if (res.followedBack) parts.push(badge("followed back", "green"));
      if (!parts.length) return r.status === HS.POSTED ? h("span", { class: "muted small" }, res.checkedAt ? "no response" : "not checked yet") : h("span", { class: "muted" }, "-");
      return h("div", { class: "chips-inline" }, parts);
    }
    const COLUMNS = [
      { key: "createdAt", label: "Date", render: (r) => h("span", { class: "nowrap mono small", title: r.postedAt ? "Posted " + fmtDateTime(r.postedAt) : "Created " + fmtDateTime(r.createdAt) }, fmtDateTime(r.createdAt)) },
      { key: "target", label: "Target", render: (r) => h("span", { class: "cell-handle" }, xLink(r.target), tierBadge(r.tier)) },
      // Where the comment went: the post (its first words), linked to the post on X.
      { key: "post", label: "Post", sort: false, className: "col-text col-wide-only", render: (r) => { const u = safeUrl(r.postUrl); const txt = truncate(String(r.postText || ""), 90) || "(post)"; return h("div", { class: "cell-text small", title: r.postText || "" }, u ? link(u, txt) : h("span", { class: "muted" }, txt)); } },
      { key: "comment", label: "Comment", sort: false, className: "col-text", render: (r) => { const u = safeUrl(r.replyUrl); return h("div", { class: "cell-text", title: r.comment || "" }, r.comment || h("span", { class: "muted" }, "-"), u ? h("div", null, link(u, h("span", { class: "nowrap small" }, "Open your reply ", icon("external")))) : null); } },
      { key: "status", label: "Status", render: (r) => h("div", { class: "status-cell" }, statusBadge(r.status, r.reason), r.reason ? h("span", { class: "reason-text" }, truncate(String(r.reason), 90)) : null) },
      { key: "results", label: "Outcome", sort: (r) => num(r.results && r.results.likes) + 5 * num(r.results && r.results.replies) + (r.results && r.results.followedBack ? 100 : 0), render: resultsChips },
    ];
    function drawComments() {
      const pane = panes.comments;
      if (!pane.firstChild) buildComments();
      fillLists();
      if (loadErr) { fill(tableHost, h("div", { class: "table-empty" }, "Could not read history: " + loadErr)); return; }
      rows = filtered();
      const cost = rows.reduce((a, r) => a + num(r.cost), 0);
      const posted = rows.filter((r) => r.status === HS.POSTED).length;
      const tokens = rows.reduce((a, r) => a + num(r.tokens && r.tokens.input) + num(r.tokens && r.tokens.output), 0);
      const item = (v, l, id) => h("span", { class: "summary-item" }, h("span", { class: "summary-num", id: id || null }, v), l);
      fill(summary, item(String(rows.length), "records", "historyCount"), item(String(posted), "posted"), item(fmtUsd(cost), "cost"), item(fmtTokens(tokens), "tokens"), item(posted ? fmtUsd(cost / posted) : "-", "per posted"),
        h("span", { class: "summary-item muted" }, f.from || f.to ? "custom dates" : rangeText(), tierText()));
      clear(tableHost).appendChild(renderTable({
        columns: COLUMNS, rows, rowKey: (r) => r.id, sortState, maxRows: 100, caption: "History", tall: true, chevron: true, activeKey: openId,
        rowLabel: (r) => `Comment for @${r.target}, ${r.status}`,
        onRowOpen: (r) => openDetail(r),
        empty: all.length ? "No records match these filters." : "No history yet. Every generated comment is recorded here with its cost and outcome.",
      }));
      const adv = pane.querySelector('details[data-adv="history.totals"]');
      if (adv && adv.open) drawQuick();
      if (openId && dr && dr.isOpen()) { const r = all.find((x) => x.id === openId); if (r) dr.setBody(detailBody(r)); }
    }
    function detailBody(r) {
      const s = ctx.settings, res = r.results || {}, tk = r.tokens || {}, q = r.quality || null;
      const kv = (rowsKv) => h("dl", { class: "kv" }, rowsKv.filter(Boolean).map(([k, v]) => [h("dt", null, k), h("dd", null, v == null || v === "" ? "-" : v)]));
      const post = safeUrl(r.postUrl), reply = safeUrl(r.replyUrl);
      return [
        h("div", { class: "drawer-sec" }, h("span", { class: "cap" }, "Post"), r.postText ? h("p", { class: "res-text" }, r.postText) : h("p", { class: "muted small" }, "(no text)"), post ? link(post, h("span", { class: "nowrap" }, "Open the post ", icon("external")), { cls: "small" }) : null),
        h("div", { class: "drawer-sec" }, h("span", { class: "cap" }, "Comment"), h("p", { class: "res-text" }, r.comment || "-"),
          r.edited && r.originalComment && r.originalComment !== r.comment ? h("p", { class: "small muted" }, "Before your edit: ", h("span", { class: "res-text" }, r.originalComment)) : null,
          reply ? link(reply, h("span", { class: "nowrap" }, "Open your reply ", icon("external")), { cls: "small" }) : null),
        h("div", { class: "drawer-sec" }, h("span", { class: "cap" }, "Status"), kv([
          ["Status", statusBadge(r.status, r.reason)], r.reason ? ["Reason", String(r.reason)] : null,
          ["Created", fmtDateTime(r.createdAt)], r.scheduledFor ? ["Scheduled", fmtDateTime(r.scheduledFor)] : null, r.postedAt ? ["Posted", fmtDateTime(r.postedAt)] : null, ["Mode", r.mode === "auto" ? "Full auto" : r.mode ? "Review" : ""]])),
        h("div", { class: "drawer-sec" }, h("span", { class: "cap" }, "Results"), r.status === HS.POSTED ? kv([
          ["Likes", res.likes != null ? fmtNum(res.likes) : null], ["Replies", res.replies != null ? fmtNum(res.replies) : null], ["Views", views(r) != null ? fmtNum(views(r)) : null],
          ["Author replied", res.authorReplied ? "yes" : "no"], ["Followed back", res.followedBack ? "yes" : "no"], ["Liked the post", r.liked ? "yes" : "no"],
          r.follow ? ["Follow first", r.follow === "followed" ? "followed right before replying" : "already following (checked on the profile)"] : null,
          ["Checked", res.checkedAt ? fmtDateTime(res.checkedAt) : "not yet"]]) : h("p", { class: "muted small" }, "Results are read after a comment is posted.")),
        h("div", { class: "drawer-sec" }, h("span", { class: "cap" }, "Generation"), kv([
          ["Model", h("span", { class: "mono" }, r.modelName || r.modelId || "-")], ["Reasoning effort", r.effort], ["Preset", PRESET_LABEL[r.preset] || r.preset], ["Tone", toneName(r.tone, s)],
          ["Tokens in / cached / out / reasoning", h("span", { class: "mono" }, `${fmtTokens(num(tk.input))} / ${fmtTokens(num(tk.cached))} / ${fmtTokens(num(tk.output))} / ${fmtTokens(num(tk.reasoning))}`)],
          ["Cost", h("span", { class: "mono" }, fmtUsd(r.cost))], ["Attempts", r.attempts != null ? String(r.attempts) : null], ["API calls", Array.isArray(r.calls) ? String(r.calls.length) : null],
          q ? ["Quality check", `${q.pass ? "passed" : "failed"}${q.stage ? ` (${q.stage})` : ""}${q.needsReview ? ", sent to review" : ""}`] : null,
          q && Array.isArray(q.reasons) && q.reasons.length ? ["Quality notes", q.reasons.map((x) => (x && x.text) || String(x)).join("; ")] : null])),
      ];
    }
    function openDetail(r) {
      openId = r.id;
      const title = h("span", null, `@${r.target}`, " ", tierBadge(r.tier));
      if (dr && dr.isOpen()) { dr.setTitle(title); dr.setBody(detailBody(r)); }
      else dr = drawer({ title, body: detailBody(r), id: "historyDrawer", label: "Comment details", onClose: () => { openId = null; dr = null; const act = tableHost.querySelector("tr.is-open"); if (act) act.classList.remove("is-open"); } });
      for (const tr of tableHost.querySelectorAll("tbody tr")) tr.classList.toggle("is-open", tr.dataset.key === String(r.id));
    }
    function drawQuick() {
      const agg = aggregate(recsT(), tz());
      const list = quickView === "day" ? agg.byDay.slice(0, 31) : quickView === "week" ? agg.byWeek.slice(0, 26) : agg.byMonth.slice(0, 24);
      clear(quickHost).appendChild(renderTable({
        caption: "Totals by period",
        columns: [
          { key: "key", label: quickView === "day" ? "Day" : quickView === "week" ? "Week" : "Month" },
          { key: "comments", label: "Generated", align: "right" },
          { key: "posted", label: "Posted", align: "right" },
          { key: "skipped", label: "Skipped", align: "right" },
          { key: "failed", label: "Failed", align: "right" },
          { key: "cost", label: "Cost", align: "right", render: (r) => fmtUsd(r.cost) },
        ],
        rows: list, rowKey: (r) => r.key, sortState: quickSort, empty: "No data yet.",
      }));
    }
    function buildComments() {
      const pane = panes.comments;
      const reload = debounce(() => { dirty.comments = true; show(); }, 200);
      fFrom.addEventListener("change", () => { f.from = fFrom.value; reload(); });
      fTo.addEventListener("change", () => { f.to = fTo.value; reload(); });
      fStatus.addEventListener("change", () => { f.status = fStatus.value; reload(); });
      fModel.addEventListener("change", () => { f.model = fModel.value; reload(); });
      fOutcome.addEventListener("change", () => { f.outcome = fOutcome.value; reload(); });
      fTarget.addEventListener("input", () => { f.target = fTarget.value.trim(); reload(); });
      fText.addEventListener("input", () => { f.text = fText.value.trim(); reload(); });
      const exportBtn = btn("Export CSV", () => {
        if (!rows.length) { toast("Nothing to export with these filters.", { type: "warn" }); return; }
        download(`scorex-history-${stamp()}.csv`, history.toCsvText(rows), "text/csv");
        toast(`Exported ${rows.length} rows`, { type: "success" });
      }, { iconName: "download", size: "sm", id: "historyExportBtn" });
      const exportXlsxBtn = btn("Export XLSX", () => {
        if (!rows.length) { toast("Nothing to export with these filters.", { type: "warn" }); return; }
        const table = [history.CSV_COLUMNS.map((c) => c.label), ...rows.map((r) => history.CSV_COLUMNS.map((c) => (c.get ? c.get(r) : r[c.key] == null ? "" : r[c.key])))];
        download(`scorex-history-${stamp()}.xlsx`, toXlsx(table, "History"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        toast(`Exported ${rows.length} rows`, { type: "success" });
      }, { iconName: "download", size: "sm", id: "historyExportXlsxBtn" });
      const resetBtn = btn("Reset filters", () => {
        Object.assign(f, { from: "", to: "", status: "", model: "", target: "", outcome: "", text: "" });
        fFrom.value = fTo.value = fText.value = fTarget.value = ""; fStatus.value = fModel.value = fOutcome.value = "";
        dirty.comments = true; show();
      }, { kind: "ghost", size: "sm" });
      const clearBtn = btn("Clear history", async () => {
        if (!(await confirmDialog("Delete the comment history (costs, results)? Comments posted in the last 8 days and items still in the queue are kept, because the daily and per-account safety limits depend on them. Skipped and failed attempts from the last 8 days stay as short records (date, status, post link), so ScoreX never answers those posts again. Targets and settings stay. This cannot be undone - export a CSV first if you need it.", { title: "Clear history", okLabel: "Delete history", danger: true }))) return;
        const r = await ctx.send("historyClear", {}, { label: "Clear history" });
        if (r) { toast(`History cleared (${num(r.removed)} removed, ${num(r.kept)} kept for safety limits)`); sig = null; load(); ctx.refreshCounts(); }
      }, { kind: "danger-soft", iconName: "trash", id: "historyClearBtn" });
      const quickSeg = segmented([["day", "Per day"], ["week", "Per week"], ["month", "Per month"]], quickView, (v) => { quickView = v; drawQuick(); }, { label: "Totals period" });
      const totals = advanced({ key: "history.totals", title: "Totals by period", desc: "Generated, posted, skipped, failed and cost per day, week or month (all history)" },
        section({ wide: true, title: "All history", actions: quickSeg }, quickHost));
      totals.addEventListener("toggle", () => { if (totals.open) drawQuick(); else clear(quickHost); });
      const retText = h("p", { class: "small", id: "retentionText" });
      const drawRet = () => {
        const hi = ctx.settings.history || {};
        retText.textContent = `Skipped and failed records are shortened after ${hi.compactAfterDays != null ? hi.compactAfterDays : "-"} days and removed after ${hi.keepUnpostedDays != null ? hi.keepUnpostedDays : "-"} days; posted comments are always kept.`;
        retention.setDesc(retText.textContent);
      };
      const retention = advanced({ key: "history.retention", title: "History retention", desc: "" },
        section({ title: "Keep history", hint: "Shortened records keep only the date, status, reason, target and post link." },
          h("div", { class: "form-row" },
            ctx.field({ path: "history.compactAfterDays", type: "number", label: "Shorten skipped and failed records after (days)", min: 7, max: 365, step: 1, id: "histCompactDays" }),
            ctx.field({ path: "history.keepUnpostedDays", type: "number", label: "Remove them after (days)", min: 14, max: 3650, step: 1, id: "histKeepDays" })),
          retText));
      drawRet();
      ctx.on("settings", drawRet);
      add(pane,
        h("div", { class: "res-filters" },
          h("div", { class: "filters-grid" },
            labeled("From", fFrom), labeled("To", fTo), labeled("Status", fStatus), labeled("Model", fModel), labeled("Target", fTarget), labeled("Outcome", fOutcome), labeled("Search", fText), targetList),
          h("div", { class: "toolbar" }, summary, h("span", { class: "spacer" }), resetBtn, exportBtn, exportXlsxBtn)),
        section({ wide: true, title: "Comments", hint: "Every comment ScoreX wrote, newest first: the post it answered, your reply, what happened and how it did. Click a row for the full post, model, tokens, cost and quality notes. Export CSV or XLSX saves all of it (links included)." }, tableHost),
        totals, retention,
        advanced({ key: "history.clear", title: "Clear history", desc: "Delete old records (recent posts and the open queue are kept for the safety limits)" },
          section({ title: "Danger zone", hint: "The open review queue and comments posted in the last 8 days are kept; the cost totals shown here reset. The monthly budget ledger is kept." }, clearBtn)));
    }

    // ================================================ Spend
    let totalsView = "model";
    const totalsSorts = { model: { key: "cost", dir: "desc" }, day: { key: "key", dir: "desc" }, week: { key: "key", dir: "desc" }, month: { key: "key", dir: "desc" } };
    const perfSorts = { model: { key: "posted", dir: "desc" }, tone: { key: "posted", dir: "desc" } };
    const totalsHost = h("div", { id: "totalsTable" });
    const totalsSummary = h("div", { class: "summary-row" });
    const perfHost = h("div", { class: "stack", id: "perfTables" });
    function drawTotals(recs) {
      const agg = aggregate(recs, tz());
      const item = (v, l) => h("div", { class: "summary-item" }, h("span", { class: "summary-num" }, v), h("span", { class: "muted" }, l));
      fill(totalsSummary, item(fmtUsd(agg.total.cost), "total spend"), item(String(agg.total.comments), "generated"), item(String(agg.total.posted), "posted"), item(fmtTokens(agg.total.tokens), "tokens"),
        item(agg.total.posted ? fmtUsd(agg.total.cost / agg.total.posted) : "-", "per posted comment"));
      let table;
      if (totalsView === "model") {
        table = renderTable({
          caption: "Totals per model",
          columns: [
            { key: "key", label: "Model", render: (r) => h("span", { class: "mono" }, r.key) },
            { key: "calls", label: "Calls", align: "right" },
            { key: "input", label: "Input tokens", align: "right", render: (r) => fmtTokens(r.input) },
            { key: "output", label: "Output tokens", align: "right", render: (r) => fmtTokens(r.output) },
            { key: "reasoning", label: "Reasoning tokens", align: "right", render: (r) => fmtTokens(r.reasoning) },
            { key: "cost", label: "Cost", align: "right", render: (r) => fmtUsd(r.cost) },
          ],
          rows: agg.byModel, rowKey: (r) => r.key, sortState: totalsSorts.model, empty: "No API calls recorded in this range.",
        });
      } else {
        const list = totalsView === "day" ? agg.byDay : totalsView === "week" ? agg.byWeek : agg.byMonth;
        table = renderTable({
          caption: "Totals per " + totalsView,
          columns: [
            { key: "key", label: totalsView === "day" ? "Day" : totalsView === "week" ? "Week" : "Month" },
            { key: "comments", label: "Generated", align: "right" },
            { key: "posted", label: "Posted", align: "right" },
            { key: "skipped", label: "Skipped", align: "right" },
            { key: "failed", label: "Failed", align: "right" },
            { key: "tokens", label: "Tokens", align: "right", render: (r) => fmtTokens(r.tokens) },
            { key: "cost", label: "Cost", align: "right", render: (r) => fmtUsd(r.cost) },
            { key: "cpp", label: "Per posted", align: "right", render: (r) => (r.posted ? fmtUsd(r.cost / r.posted) : "-"), sort: (r) => (r.posted ? r.cost / r.posted : null) },
          ],
          rows: list, rowKey: (r) => r.key, sortState: totalsSorts[totalsView], maxRows: 60, empty: "No history in this range.",
        });
      }
      clear(totalsHost).appendChild(table);
    }
    function drawPerf(recs) {
      const pf = performance(recs);
      const cols = (first) => [
        { key: "key", label: first, render: (r) => (first === "Tone" ? toneName(r.key === "?" ? "" : r.key, ctx.settings) : h("span", { class: "mono" }, r.key)) },
        { key: "posted", label: "Posted", align: "right" },
        { key: "costPerComment", label: "Cost / comment", align: "right", render: (r) => fmtUsd(r.costPerComment) },
        { key: "avgLikes", label: "Avg likes", align: "right", render: (r) => r.avgLikes.toFixed(1) },
        { key: "avgReplies", label: "Avg replies", align: "right", render: (r) => r.avgReplies.toFixed(1) },
        { key: "authorReplies", label: "Author replies", align: "right" },
        { key: "followBacks", label: "Follow-backs", align: "right" },
        { key: "followBackRate", label: "Follow-back rate", align: "right", render: (r) => fmtPct(r.followBackRate * 100, 1) },
        { key: "costPerFollowBack", label: "Cost / follow-back", align: "right", render: (r) => (r.costPerFollowBack == null ? "-" : fmtUsd(r.costPerFollowBack)) },
      ];
      fill(perfHost,
        h("div", { class: "sub" }, h("h3", { class: "sub-title" }, "Per model"), renderTable({ caption: "Performance per model", columns: cols("Model"), rows: pf.byModel, rowKey: (r) => r.key, sortState: perfSorts.model, empty: "No posted comments in this range." })),
        h("div", { class: "sub" }, h("h3", { class: "sub-title" }, "Per tone"), renderTable({ caption: "Performance per tone", columns: cols("Tone"), rows: pf.byTone, rowKey: (r) => r.key, sortState: perfSorts.tone, empty: "No posted comments in this range." })));
    }
    function drawSpend() {
      const pane = panes.spend, s = ctx.settings;
      if (loadErr) { fill(pane, h("div", { class: "banner banner-danger" }, "Could not read history: " + loadErr)); return; }
      const recs = createdIn();
      const b = budgetStatus(s, ctx.data[K.spend]);
      // Cost in range: the spend ledger (every API call, tests included) unless a tier filter needs the records.
      const ledgerAll = (ctx.data[K.spend] && ctx.data[K.spend].days) || {};
      const sinceKey = sinceTs() ? dayKey(sinceTs(), tz()) : "";
      const ledgerSum = Object.entries(ledgerAll).reduce((a, [k, v]) => (k >= sinceKey ? a + num(v) : a), 0);
      const cost = p.tier ? recs.reduce((a, r) => a + num(r.cost), 0) : Math.max(ledgerSum, recs.reduce((a, r) => a + num(r.cost), 0));
      const posted = recs.filter((r) => r.status === HS.POSTED).length;
      const since = sinceTs();
      const fbs = Object.values(targetsF()).filter((t) => t && t.rel && t.rel.followedBackAt && (!since || t.rel.followedBackAt >= since)).length;
      const budgetSec = section({ wide: true, title: "Budget", id: "spendBudget", actions: h("a", { href: "#models", class: "small" }, "Change the budget") },
        ledger(
          figure({ label: "This month", value: fmtUsd(b.spent), of: b.limit ? fmtUsd(b.limit, 0) : null, sub: b.limit ? `${Math.round(b.pct)}% of your budget${b.reached ? " · reached" : b.warn ? " · warning" : ""}` : "no monthly budget set", cls: b.reached ? "is-red" : b.warn ? "is-amber" : null }),
          figure({ label: "Today", value: fmtUsd(b.today), sub: "real OpenAI usage" }),
          figure({ label: "In range", value: fmtUsd(cost), sub: `${rangeText()}${p.tier ? tierText() : " · all API calls"}` }),
          figure({ label: "Per posted comment", value: posted ? fmtUsd(cost / posted) : "-", sub: `${posted} posted` }),
          figure({ label: "Per follow-back", value: fbs ? fmtUsd(cost / fbs) : "-", sub: `${fbs} follow-back${fbs === 1 ? "" : "s"}` })),
        b.limit ? progressBar(b.pct, { kind: b.reached ? "red" : b.warn ? "amber" : "accent" }) : null,
        b.reached ? h("p", { class: "small text-red" }, "Budget reached: ScoreX stops generating until next month or until you raise the budget.") : null);
      // Daily cost: the spend ledger (every call, tests included) or, with a tier filter, the history records.
      const days = rangeDays();
      const ds = dailySeries(recs, targetsF(), { days, tz: tz() });
      const ledgerDays = (ctx.data[K.spend] && ctx.data[K.spend].days) || {};
      const daily = ds.map((d) => ({ label: dayLabel(d.d), cost: p.tier ? d.cost : Math.max(num(ledgerDays[d.d]), d.cost) }));
      const sum = daily.reduce((a, d) => a + d.cost, 0);
      const dailySec = section({ wide: true, title: "Daily cost", id: "spendDaily", hint: `last ${days} days${p.tier ? tierText() + " · generation cost" : " · every API call, tests included"}` },
        responsive((w) => bars(daily.map((d) => ({ label: d.label, value: Math.round(d.cost * 10000) / 100 })), { width: w, height: 110, unit: "¢", label: `OpenAI cost per day, last ${days} days: ${fmtUsd(sum)} in total` }), { initialWidth: 900 }),
        h("div", { class: "fig-sub" }, h("span", null, h("b", { class: "mono" }, fmtUsd(sum)), " in total"), h("span", null, h("b", { class: "mono" }, fmtUsd(sum / days)), " a day on average"), h("span", null, "bars in cents (¢)")));
      const totalsSeg = segmented([["model", "Per model"], ["day", "Per day"], ["week", "Per week"], ["month", "Per month"]], totalsView, (v) => { totalsView = v; drawTotals(createdIn()); }, { label: "Totals view" });
      const totalsSec = section({ wide: true, title: "Totals", hint: `Real cost from the token usage of every call, fallbacks and checks included · ${rangeText()}${tierText()}`, actions: totalsSeg, id: "spendTotals" }, totalsSummary, totalsHost);
      const perfSec = section({ wide: true, title: "Performance", hint: "Likes, replies, author replies and follow-backs per model and tone", id: "spendPerf" }, perfHost);
      drawTotals(recs); drawPerf(recs.filter((r) => r.status === HS.POSTED));
      fill(pane, budgetSec, dailySec, totalsSec, perfSec);
    }

    // ================================================ Follow-backs
    // Who followed back (lib/followbacks.js): the stored record merged with what your targets and history know now.
    const fbSort = { key: "at", dir: "desc" };
    let fbRows = [];
    const fmtDays = (d) => { const n = Math.round(d); return d < 1 ? "same day" : `${n} day${n === 1 ? "" : "s"}`; };
    function drawFollowBacks() {
      const pane = panes.followbacks;
      if (loadErr) { fill(pane, h("div", { class: "banner banner-danger" }, "Could not read history: " + loadErr)); return; }
      const since = sinceTs();
      fbRows = FB.mergeEntries(ctx.data[K.followbacks], ctx.targets, all).filter((e) => (!since || e.at >= since) && tierOk(e.tier));
      const days = fbRows.map((e) => e.days).filter((d) => d != null);
      const med = median(days);
      const avgC = fbRows.length ? fbRows.reduce((a, e) => a + num(e.comments), 0) / fbRows.length : 0;
      const item = (v, l, id) => h("span", { class: "summary-item" }, h("span", { class: "summary-num", id: id || null }, v), l);
      const summary = h("div", { class: "summary-row", id: "fbSummary", "aria-live": "polite" },
        item(String(fbRows.length), fbRows.length === 1 ? "follow-back" : "follow-backs", "fbCount"),
        item(med == null ? "-" : fmtDays(med), "median from first comment"),
        item(fbRows.length ? (Number.isInteger(avgC) ? String(avgC) : avgC.toFixed(1)) : "-", "comments before, on average"),
        item(String(fbRows.filter((e) => e.youFollowedFirst).length), "after you followed first"),
        item(String(fbRows.filter((e) => e.unfollowedAt).length), "unfollowed later"),
        h("span", { class: "summary-item muted" }, rangeText(), tierText()));
      const cols = [
        { key: "at", label: "Followed back", sort: (e) => e.at, render: (e) => h("span", { class: "nowrap mono small" }, fmtDateTime(e.at), e.again ? [" ", badge("again", "grey", "Followed you back before, unfollowed, and followed back again")] : null) },
        { key: "handle", label: "Account", sort: (e) => e.handle, render: (e) => h("span", { class: "cell-handle" }, xLink(e.handle), tierBadge(e.tier), e.name ? h("span", { class: "muted small" }, " " + truncate(e.name, 28)) : null) },
        { key: "after", label: "After", sort: (e) => num(e.comments) * 1e4 + num(e.days), render: (e) => h("div", { class: "small" }, `${e.comments || 0} comment${e.comments === 1 ? "" : "s"}${e.days != null ? " · " + fmtDays(e.days) : ""}`, e.youFollowedFirst ? h("div", null, badge("you followed first", "green", "ScoreX followed this account before it followed you back")) : null) },
        { key: "last", label: "Last comment before", sort: false, className: "col-text", render: (e) => { const lc = e.lastComment; if (!lc || !lc.text) return h("span", { class: "muted small" }, "-"); const u = safeUrl(lc.url); return h("div", { class: "cell-text small", title: lc.text }, u ? link(u, truncate(lc.text, 110)) : truncate(lc.text, 110)); } },
        { key: "followers", label: "Followers", align: "right", sort: (e) => num(e.followers), render: (e) => (e.followers == null ? "-" : fmtNum(e.followers)) },
        { key: "score", label: "Score", align: "right", sort: (e) => num(e.twitterscore != null ? e.twitterscore : e.score), render: (e) => (e.twitterscore != null ? h("span", { title: "TwitterScore" }, fmtNum(e.twitterscore)) : e.score != null ? h("span", { title: "ScoreX rank" }, fmtNum(e.score)) : "-") },
        { key: "now", label: "Now", sort: (e) => (e.unfollowedAt ? 0 : 1), render: (e) => (e.unfollowedAt ? h("span", { class: "small text-red", title: fmtDateTime(e.unfollowedAt) }, "Unfollowed " + fmtDay(e.unfollowedAt)) : h("span", { class: "small text-green" }, "Follows you")) },
      ];
      const exportCsv = btn("Export CSV", () => {
        if (!fbRows.length) { toast("Nothing to export yet.", { type: "warn" }); return; }
        download(`scorex-follow-backs-${stamp()}.csv`, tableToCsv(FB.toTable(fbRows)), "text/csv");
        toast(`Exported ${fbRows.length} follow-back${fbRows.length === 1 ? "" : "s"}`, { type: "success" });
      }, { iconName: "download", size: "sm", id: "fbExportCsv" });
      const exportXlsx = btn("Export XLSX", () => {
        if (!fbRows.length) { toast("Nothing to export yet.", { type: "warn" }); return; }
        download(`scorex-follow-backs-${stamp()}.xlsx`, toXlsx(FB.toTable(fbRows), "Follow-backs"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        toast(`Exported ${fbRows.length} follow-back${fbRows.length === 1 ? "" : "s"}`, { type: "success" });
      }, { iconName: "download", size: "sm", id: "fbExportXlsx" });
      const tableHost = h("div", { id: "followBacksTable" }, renderTable({
        columns: cols, rows: fbRows, rowKey: (e) => e.id, sortState: fbSort, maxRows: 200, caption: "Follow-backs", tall: true,
        rowLabel: (e) => `@${e.handle} followed you back`,
        // A row opens the target's timeline (every comment and check); an account no longer in your targets opens on X.
        onRowOpen: (e) => { if (Object.hasOwn(ctx.targets, e.handle)) ctx.navigate("targets?h=" + encodeURIComponent(e.handle)); else window.open("https://x.com/" + e.handle, "_blank", "noopener"); },
        empty: "No follow-backs yet. When an account you commented on follows you, it is recorded here: when, after how many comments, and the last comment before it.",
      }));
      fill(pane,
        h("div", { class: "toolbar" }, summary),
        section({ wide: true, title: "Who followed back", hint: "Newest first. Kept even after a target is removed. Click a row for the account's timeline.", actions: h("div", { class: "toolbar" }, exportCsv, exportXlsx) }, tableHost));
    }

    const DRAW = { ov: drawOverview, comments: drawComments, followbacks: drawFollowBacks, spend: drawSpend };

    // ------------------------------------------------ data
    async function load() {
      let next;
      try { next = await history.all(); loadErr = ""; } catch (e) { loadErr = (e && e.message) || String(e); next = []; }
      const s = loadErr ? "err" : next.length + ":" + next.reduce((m, r) => Math.max(m, num(r.updatedAt) || num(r.createdAt)), 0);
      if (s === sig) return;
      sig = s; all = next;
      markAll(); show();
    }
    const reload = debounce(load, 1500);
    const redrawSoon = debounce(() => { markAll(); show(); }, 800);
    let reachSig = "";

    await load();
    show();
    ctx.on("params", (q) => { Object.assign(p, readP(q)); markAll(); show(); });
    ctx.on("counts", reload);
    ctx.on(K.logs, reload);
    ctx.on(K.targets, redrawSoon);
    ctx.on(K.blacklist, redrawSoon);
    ctx.on(K.spend, () => { dirty.spend = true; if (p.view === "spend") show(); });
    ctx.on(K.followbacks, () => { dirty.followbacks = true; if (p.view === "followbacks") show(); });
    ctx.on("status", () => { const r = ctx.status && ctx.status.reach; const k = r ? `${r.medianViews}|${r.prevMedianViews}` : ""; if (k !== reachSig) { reachSig = k; dirty.ov = true; if (p.view === "ov") show(); } });
    ctx.on("settings", (s, from) => { if (!from) { markAll(); show(); } });
    const onVis = () => { if (document.visibilityState === "visible") reload(); };
    document.addEventListener("visibilitychange", onVis);
    ctx.onDispose(() => { document.removeEventListener("visibilitychange", onVis); if (dr && dr.isOpen()) dr.close(); });
  },
};
