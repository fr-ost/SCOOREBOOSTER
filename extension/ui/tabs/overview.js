// Dashboard tab: engine status, safety alert, mode switch, today's numbers, recent activity.

import { K, MODE, STATUS, HARD } from "../../lib/constants.js";
import { getSecrets } from "../../lib/store.js";
import { budgetStatus } from "../../lib/costs.js";
import { warmup, dailyLimit, generationLimit, groupLimit, likeLimit, rampStage, activeHours } from "../../lib/safety.js";
import { dayKey, num } from "../../lib/util.js";
import { h, clear, card, btn, busy, toast, icon, statusInfo, segmented, progressBar, fmtUsd, fmtTime, fmtDateTime, fmtAgo, fmtIn, fmtCountdown, badge, truncate, add, fill } from "../components.js";

export default {
  id: "overview",
  title: "Dashboard",
  icon: "overview",
  async render(root, ctx) {
    let hasKey = true;
    const loadKey = async () => { try { hasKey = !!(await getSecrets()).openaiKey; } catch (_) { hasKey = true; } };
    await loadKey();

    const hero = h("section", { class: "card hero" });
    const warnings = h("div", { class: "stack-sm" });
    const modeBody = h("div");
    const stats = h("div", { class: "stats-grid", id: "todayStats" });
    const logBody = h("div", { class: "log-list", id: "activityLog" });
    let showAllLogs = false;

    add(root, 
      hero,
      warnings,
      h("div", { class: "grid-2-1" },
        card({ title: "Today", subtitle: "Posted, generated and likes: last 24 hours (rolling). Cost, skipped, failed: since midnight.", actions: h("a", { href: "#history", class: "btn btn-sm btn-ghost" }, "History") }, stats),
        card({ title: "Mode", subtitle: "How generated comments get posted" }, modeBody)),
      card({
        title: "Recent activity",
        subtitle: "What the engine did, newest first",
        actions: btn("Show more", (e) => { showAllLogs = !showAllLogs; e.currentTarget.querySelector("span").textContent = showAllLogs ? "Show less" : "Show more"; drawLogs(); }, { size: "sm", kind: "ghost" }),
      }, logBody));

    // ---------- status hero ----------
    function drawHero() {
      const state = ctx.state;
      const st = ctx.status || {};
      const s = ctx.settings;
      const info = statusInfo(state);
      const now = Date.now();
      const lines = [];
      const ah = st.activeHours || safeActiveHours(s, now);
      if (state.status === STATUS.RUNNING) {
        if (ah && ah.inside === false) lines.push(["moon", `Sleeping - outside active hours (${s.safety.activeHours.start}-${s.safety.activeHours.end}). Wakes at ${fmtTime(ah.opensAt)} (${fmtIn(ah.opensAt)}).`]);
        else if (state.breakUntil && state.breakUntil > now) lines.push(["pause", `On a break until ${fmtTime(state.breakUntil)} (${fmtIn(state.breakUntil)}).`]);
        else if (state.nextCommentAt && state.nextCommentAt > now) lines.push(["history", `Waiting between comments - next comment allowed at ${fmtTime(state.nextCommentAt)} (${fmtIn(state.nextCommentAt)}).`]);
        if (state.job && state.job.kind) lines.push(["bolt", `Working: ${state.job.kind}${state.job.step ? " - " + state.job.step : ""}`]);
        if (state.nextTickAt) lines.push(["refresh", `Next check at ${fmtTime(state.nextTickAt)} (${fmtIn(state.nextTickAt)}).`]);
      } else if (state.status === STATUS.PAUSED) {
        lines.push(["pause", "Paused. Nothing is generated or posted until you press Resume."]);
      } else if (info.kind === "danger") {
        lines.push(["alert", "Stopped for safety. Open X, check your account, then resume manually."]);
        if (state.stopDetail) lines.push(["info", state.stopDetail]);
      } else {
        lines.push(["play", `Press Start to begin. ScoreX only works inside active hours (${s.safety.activeHours.enabled ? `${s.safety.activeHours.start}-${s.safety.activeHours.end}` : "all day"}, ${s.timezone}).`]);
      }
      if (state.lastTickAt) lines.push(["history", `Last check ${fmtAgo(state.lastTickAt)}.`]);
      if (state.stoppedAt && state.status === STATUS.STOPPED) lines.push(["stop", `Stopped ${fmtDateTime(state.stoppedAt)}.`]);

      fill(hero, 
        h("div", { class: "hero-main" },
          h("div", { class: ["hero-status", "hero-" + info.kind] },
            h("span", { class: "hero-dot", "aria-hidden": "true" }),
            h("div", null,
              h("div", { class: "hero-label", id: "heroStatus" }, info.label, info.reason && state.status === STATUS.STOPPED ? h("span", { class: "hero-reason" }, ` (${info.reason})`) : null),
              h("ul", { class: "hero-lines" }, lines.map(([ic, t]) => h("li", null, icon(ic), h("span", null, t)))))),
          h("div", { class: "hero-actions" },
            btn("Run a check now", (e) => {
              const b = e.currentTarget;
              busy(b, async () => { const r = await ctx.send("runNow", {}, { label: "Run a check now" }); if (r) { toast("Check started", { type: "success" }); ctx.refreshStatus(); } });
            }, { iconName: "refresh", id: "runNowBtn", disabled: state.status !== STATUS.RUNNING, title: state.status === STATUS.RUNNING ? "Look for fresh posts from your targets right away (still respects all safety limits)" : "Start or resume the engine first" }))));
    }

    // ---------- warnings ----------
    function drawWarnings() {
      clear(warnings);
      const items = [];
      const targetCount = ctx.targetList().length;
      if (!hasKey) items.push(["No OpenAI API key yet. ScoreX cannot write comments without it.", "#models", "Add API key"]);
      if (!targetCount) items.push(["No target accounts yet. Add the accounts you want to comment on.", "#targets", "Add targets"]);
      else if (!ctx.targetList().some((t) => t.enabled !== false)) items.push(["All targets are disabled.", "#targets", "Open Targets"]);
      const st = ctx.status;
      const b = budgetStatus(ctx.settings, ctx.data[K.spend]);
      if (b.reached) items.push([`Monthly budget reached (${fmtUsd(b.spent)} of ${fmtUsd(b.limit)}). Generation is paused until next month or a higher budget.`, "#models", "Budget"]);
      else if (b.warn) items.push([`Monthly spend is at ${Math.round(b.pct)}% of your budget.`, "#models", "Budget"]);
      if (st && st.activeTargetCount === 0 && targetCount) items.push(["No active targets: check that groups A/B are enabled in Safety.", "#safety", "Open Safety"]);
      for (const [text, href, label] of items) {
        warnings.appendChild(h("div", { class: "banner banner-warn" }, icon("alert"), h("span", { class: "banner-text" }, text), h("a", { href, class: "btn btn-sm" }, label)));
      }
    }

    // ---------- mode ----------
    function drawMode() {
      const s = ctx.settings;
      const wu = (ctx.status && ctx.status.warmup) || warmup(ctx.state);
      const locked = !!wu.active;
      const seg = segmented(
        [[MODE.REVIEW, "Review"], [MODE.AUTO, "Full auto", locked, locked ? "Locked during the 3-day warm-up" : ""]],
        s.mode,
        (v) => { if (v === MODE.AUTO && locked) return; ctx.save((d) => { d.mode = v; }); },
        { label: "Mode", cls: "seg-lg" });
      seg.id = "modeSwitch";
      let note;
      if (locked) {
        note = wu.notStarted || !wu.endsAt
          ? `Full auto unlocks ${HARD.warmupDays} days after your first start - first ${HARD.warmupDays} days are review only.`
          : `Full auto unlocks in ${fmtCountdown(wu.msLeft != null ? wu.msLeft : wu.endsAt - Date.now())} - first ${HARD.warmupDays} days are review only.`;
      }
      fill(modeBody, 
        seg,
        locked ? h("p", { class: "note note-warn", id: "warmupNote" }, icon("safety"), h("span", null, note)) : null,
        locked && s.mode === MODE.AUTO ? h("p", { class: "muted small" }, "You picked Full auto. It switches on by itself when the warm-up ends.") : null,
        h("ul", { class: "plain-list muted small" },
          h("li", null, h("strong", null, "Review: "), "every comment waits in the ", h("a", { href: "#review" }, "Review queue"), " until you approve, edit or skip it."),
          h("li", null, h("strong", null, "Full auto: "), "comments are posted automatically, always inside your safety limits.")));
    }

    // ---------- today ----------
    function stat({ label, value, sub, pct, kind, href, id, tone }) {
      const inner = [
        h("div", { class: "stat-label" }, label),
        h("div", { class: "stat-value" }, value),
        sub ? h("div", { class: "stat-sub" }, sub) : null,
        pct != null ? progressBar(pct, { kind }) : null,
      ];
      return href
        ? h("a", { class: ["stat", "stat-link", tone && "stat-" + tone], href, id: id || null }, inner)
        : h("div", { class: ["stat", tone && "stat-" + tone], id: id || null }, inner);
    }
    function drawToday() {
      const s = ctx.settings;
      const state = ctx.state;
      const st = ctx.status || {};
      const t = st.today || {};
      const stage = st.rampStage != null ? st.rampStage : rampStage(state);
      const limit = t.limit != null ? t.limit : dailyLimit(s, state);
      const gl = t.groupLimits || { A: groupLimit(s, "A", limit), B: groupLimit(s, "B", limit) };
      const pg = t.postedGroup || {};
      const genLimit = t.generationLimit != null ? t.generationLimit : generationLimit(s, state);
      const likeLim = t.likeLimit != null ? t.likeLimit : likeLimit(s);
      const spend = ctx.data[K.spend];
      const b = budgetStatus(s, spend);
      const todayCost = Math.max(num(t.cost), num(spend && spend.days && spend.days[dayKey(Date.now(), s.timezone)]));
      const monthCost = Math.max(num(b.spent), num(st.month && st.month.cost));
      const pctOf = (a, z) => (z ? (num(a) / z) * 100 : 0);
      const v = (x) => (x == null ? "-" : x);
      fill(stats, 
        stat({ label: "Posted (last 24h)", value: [h("span", { id: "postedToday" }, v(t.posted)), h("span", { class: "stat-of" }, ` / ${limit}`)], sub: `Ramp week ${stage + 1}${stage >= 2 ? "+" : ""}: ${limit} per 24h (hard cap ${HARD.dailyComments})`, pct: pctOf(t.posted, limit), kind: "green" }),
        stat({ label: "Group A", value: [v(pg.A), h("span", { class: "stat-of" }, ` / ${v(gl.A)}`)], sub: "Follow you - keep warm", pct: pctOf(pg.A, gl.A), kind: "teal" }),
        stat({ label: "Group B", value: [v(pg.B), h("span", { class: "stat-of" }, ` / ${v(gl.B)}`)], sub: "Don't follow you - get noticed", pct: pctOf(pg.B, gl.B), kind: "violet" }),
        stat({ label: "Generated", value: [v(t.generated), h("span", { class: "stat-of" }, ` / ${genLimit}`)], sub: "OpenAI generations (limit protects spend)", pct: pctOf(t.generated, genLimit) }),
        stat({ label: "Skipped", value: v(t.skipped), sub: "By rules, quality check or you" }),
        stat({ label: "Failed", value: v(t.failed), sub: "Posting attempts that failed", tone: num(t.failed) ? "red" : null }),
        stat({ label: "Likes", value: likeLim ? [v(t.liked), h("span", { class: "stat-of" }, ` / ${likeLim}`)] : "Off", sub: likeLim ? "Like before comment" : "Like-before-comment is off", pct: likeLim ? pctOf(t.liked, likeLim) : null }),
        stat({ label: "Cost today", value: fmtUsd(todayCost), sub: "Real OpenAI usage" }),
        stat({ label: "This month", value: b.limit ? [fmtUsd(monthCost), h("span", { class: "stat-of" }, ` / ${fmtUsd(b.limit, 2)}`)] : fmtUsd(monthCost), sub: b.limit ? `${Math.round(b.pct)}% of budget${b.reached ? " - reached" : b.warn ? " - warning" : ""}` : "No monthly limit set", pct: b.limit ? b.pct : null, kind: b.reached ? "red" : b.warn ? "amber" : "accent", tone: b.reached ? "red" : b.warn ? "amber" : null, href: "#models" }),
        stat({ label: "Pending review", value: h("span", { id: "pendingCount" }, String(ctx.counts.pending)), sub: ctx.counts.pending ? "Open the Review queue →" : "Nothing waiting", href: "#review", tone: ctx.counts.pending ? "amber" : null }),
        stat({ label: "Open queue", value: String(ctx.counts.queued), sub: "Approved / queued, waiting to post", href: "#review" }));
    }

    // ---------- activity ----------
    function drawLogs() {
      const logs = Array.isArray(ctx.data[K.logs]) ? ctx.data[K.logs] : [];
      clear(logBody);
      if (!logs.length) { logBody.appendChild(h("div", { class: "table-empty" }, "No activity yet. Press Start and the engine's steps will show up here.")); return; }
      const list = logs.slice().reverse().slice(0, showAllLogs ? 400 : 25);
      for (const e of list) {
        const lvl = ["error", "warn", "info", "debug"].includes(e.level) ? e.level : "info";
        logBody.appendChild(h("div", { class: ["log", "log-" + lvl] },
          h("span", { class: "log-time", title: fmtDateTime(e.ts) }, fmtTime(e.ts)),
          badge(lvl, lvl === "error" ? "red" : lvl === "warn" ? "amber" : lvl === "debug" ? "grey" : "blue"),
          h("span", { class: "log-msg" }, String(e.msg || ""), e.data ? h("span", { class: "log-data" }, " " + truncate(typeof e.data === "string" ? e.data : JSON.stringify(e.data), 240)) : null)));
      }
    }

    const drawAll = () => { drawHero(); drawWarnings(); drawMode(); drawToday(); };
    drawAll();
    drawLogs();
    ctx.on("status", drawAll);
    ctx.on(K.state, drawAll);
    ctx.on("settings", drawAll);
    ctx.on("counts", drawToday);
    ctx.on(K.spend, drawToday);
    ctx.on(K.targets, drawWarnings);
    ctx.on(K.logs, drawLogs);
    ctx.on("tick", drawAll);
    ctx.on("secrets", async () => { await loadKey(); drawWarnings(); });
  },
};

function safeActiveHours(s, ts) {
  try { return activeHours(s, ts); } catch (_) { return null; }
}
