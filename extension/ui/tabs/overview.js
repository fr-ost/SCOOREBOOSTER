// Dashboard tab ("control room"): status strip (status, mode switch, 24h quota), setup checklist,
// key numbers, a preview of the review queue with quick Approve/Skip, and the recent activity timeline.

import { K, MODE, STATUS, HS, HARD } from "../../lib/constants.js";
import { getSecrets, setSecrets } from "../../lib/store.js";
import { budgetStatus } from "../../lib/costs.js";
import { dailyLimit, generationLimit, groupLimit, likeLimit, rampStage, activeHours } from "../../lib/safety.js";
import { weightedLength } from "../../lib/quality.js";
import * as history from "../../lib/history.js";
import { dayKey, num } from "../../lib/util.js";
import { h, clear, btn, busy, toast, icon, statusInfo, segmented, quotaBar, panel, fig, section, maskKey, groupBadge, tierBadge, xLink, fmtUsd, fmtTime, fmtDateTime, fmtAgo, fmtIn, truncate, add, fill } from "../components.js";

const LS_DISMISSED = "sx.setup.dismissed";
const LS_HANDLE = "sx.setup.handle"; // the handle the user confirmed in the checklist
const lsGet = (k) => { try { return window.localStorage.getItem(k); } catch (_) { return null; } };
const lsSet = (k, v) => { try { if (v == null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, v); } catch (_) { /* storage blocked */ } };

export default {
  id: "overview",
  title: "Dashboard",
  async render(root, ctx) {
    let hasKey = true, maskedKey = "";
    const loadKey = async () => {
      try { const sec = await getSecrets(); hasKey = !!sec.openaiKey; maskedKey = maskKey(sec.openaiKey); } catch (_) { hasKey = true; }
    };
    await loadKey();

    // ------------------------------------------------ status strip
    const statusCell = h("div", { class: "cell strip-status" });
    const modeCell = h("div", { class: "cell strip-mode" });
    const quotaCell = h("div", { class: "cell strip-quota" });
    const notices = h("div", { class: "notices" });
    const setupHost = h("div", { id: "setupHost" });
    const figsHost = h("div", { class: "figs" });
    const pendingCount = h("span", { class: "count-chip", id: "pendingCount" }, "0");
    const pvHost = h("div", { class: "pv-list", id: "reviewPreview" });
    const pvFoot = h("p", { class: "small muted" });
    const logBody = h("div", { class: "log-list", id: "activityLog" });
    let showAllLogs = false;
    const moreBtn = btn("Show all", () => { showAllLogs = !showAllLogs; moreBtn.querySelector("span").textContent = showAllLogs ? "Show less" : "Show all"; drawLogs(); }, { size: "xs", kind: "ghost" });

    add(root,
      panel("strip", statusCell, modeCell, quotaCell),
      notices,
      setupHost,
      figsHost,
      h("div", { class: "duo" },
        section({ wide: true, title: h("span", null, "Waiting for review ", pendingCount), actions: h("a", { href: "#review", class: "go" }, "Open Review Queue →") }, pvHost, pvFoot),
        section({ wide: true, title: "Recent activity", actions: moreBtn }, logBody)));

    function whyLines() {
      const state = ctx.state, st = ctx.status || {}, s = ctx.settings;
      const info = statusInfo(state);
      const now = Date.now();
      const ah = st.activeHours || safeActiveHours(s, now);
      const hours = s.safety.activeHours.enabled ? `${s.safety.activeHours.start}-${s.safety.activeHours.end}` : "all day";
      const t = (ts) => h("span", { class: "tnum" }, fmtTime(ts));
      const lines = [];
      if (state.status === STATUS.RUNNING) {
        if (ah && ah.inside === false) lines.push(["Sleeping outside active hours (", hours, "). Wakes at ", t(ah.opensAt), ` (${fmtIn(ah.opensAt)}).`]);
        else if (state.breakUntil && state.breakUntil > now) lines.push(["On a break until ", t(state.breakUntil), ` (${fmtIn(state.breakUntil)}).`]);
        else if (state.nextCommentAt && state.nextCommentAt > now) lines.push(["Waiting between comments. Next comment allowed at ", t(state.nextCommentAt), ` (${fmtIn(state.nextCommentAt)}).`]);
        if (state.job && state.job.kind) lines.push([`Working: ${state.job.kind}${state.job.step ? " - " + state.job.step : ""}`]);
        if (state.nextTickAt) lines.push(["Next check at ", t(state.nextTickAt), ` (${fmtIn(state.nextTickAt)})`, state.lastTickAt ? ` · last check ${fmtAgo(state.lastTickAt)}` : "", "."]);
      } else if (state.status === STATUS.PAUSED) {
        lines.push(["Nothing is generated or posted until you press Resume."]);
      } else if (info.kind === "danger") {
        lines.push(["Stopped for safety. Open X, check your account, then resume."]);
        if (state.stopDetail) lines.push([state.stopDetail]);
      } else {
        lines.push([`Press Start to begin. ScoreX works inside active hours (${hours}, ${s.timezone}).`]);
      }
      if (state.status !== STATUS.RUNNING && state.lastTickAt) lines.push([`Last check ${fmtAgo(state.lastTickAt)}`, state.stoppedAt && state.status === STATUS.STOPPED ? ` · stopped ${fmtDateTime(state.stoppedAt)}` : "", "."]);
      return lines;
    }

    function drawStatus() {
      const state = ctx.state;
      const info = statusInfo(state);
      const running = state.status === STATUS.RUNNING;
      fill(statusCell,
        h("div", { class: ["big-status", "is-" + info.kind], id: "heroStatus" },
          h("span", { class: "dot", "aria-hidden": "true" }),
          h("span", null, info.label),
          info.reason && state.status === STATUS.STOPPED ? h("span", { class: "reason" }, `(${info.reason})`) : null),
        h("div", { class: "why" }, whyLines().map((parts) => h("div", null, parts))),
        h("div", { class: "strip-actions" },
          btn("Run a check now", (e) => {
            const b = e.currentTarget;
            busy(b, async () => { const r = await ctx.send("runNow", {}, { label: "Run a check now" }); if (r) { toast("Check started", { type: "success" }); ctx.refreshStatus(); } });
          }, { iconName: "refresh", size: "sm", id: "runNowBtn", disabled: !running, title: running ? "Look for fresh posts right away (all safety limits still apply)" : "Start or resume the engine first" })));
    }

    const modeNote = h("p", { class: "cell-note" });
    const modeSeg = segmented([[MODE.REVIEW, "Review"], [MODE.AUTO, "Full auto"]], ctx.settings.mode,
      (v) => ctx.save((d) => { d.mode = v; }), { label: "Mode", cls: "seg-lg seg-accent" });
    modeSeg.id = "modeSwitch";
    modeSeg.setAttribute("aria-labelledby", "modeLabel");
    add(modeCell, h("span", { class: "cell-label", id: "modeLabel" }, "Mode"), modeSeg, modeNote);
    function drawMode() {
      const s = ctx.settings;
      modeSeg.set(s.mode);
      fill(modeNote, s.mode === MODE.AUTO
        ? "Posts on its own, always inside your safety limits."
        : ["You approve every comment in the ", h("a", { href: "#review" }, "Review Queue"), " first."]);
    }

    function today() {
      const s = ctx.settings, state = ctx.state, st = ctx.status || {};
      const t = st.today || {};
      const limit = t.limit != null ? t.limit : dailyLimit(s, state);
      return { s, state, st, t, limit };
    }

    function drawQuota() {
      const { state, st, t, limit } = today();
      const stage = st.rampStage != null ? st.rampStage : rampStage(state);
      const posted = t.posted != null ? num(t.posted) : null;
      fill(quotaCell,
        h("div", { class: "quota-head" }, h("span", { class: "cell-label" }, "Posted · last 24h"), h("a", { href: "#safety", class: "small" }, "Limits")),
        h("div", { class: "quota-num" }, h("span", { id: "postedToday" }, posted == null ? "-" : String(posted)), h("span", { class: "fig-of" }, ` / ${limit}`)),
        quotaBar(posted || 0, limit, { label: "Comments posted in the last 24 hours" }),
        h("p", { class: "cell-note" }, `Ramp week ${stage + 1}${stage >= 2 ? "+" : ""} · hard cap ${HARD.dailyComments} a day`));
    }

    // ------------------------------------------------ notices (budget, disabled targets)
    function drawNotices() {
      const items = [];
      const list = ctx.targetList();
      const setupShown = !!setupHost.firstChild;
      if (!setupShown && !hasKey) items.push(["No OpenAI API key. ScoreX cannot write comments without it.", "#models", "Add key"]);
      if (!setupShown && !list.length) items.push(["No target accounts yet.", "#targets", "Add targets"]);
      if (list.length && !list.some((x) => x.enabled !== false)) items.push(["All targets are disabled.", "#targets", "Open Targets"]);
      const b = budgetStatus(ctx.settings, ctx.data[K.spend]);
      if (b.reached) items.push([`Monthly budget reached (${fmtUsd(b.spent)} of ${fmtUsd(b.limit)}). Generation waits for next month or a higher budget.`, "#models", "Budget"]);
      else if (b.warn) items.push([`Monthly spend is at ${Math.round(b.pct)}% of your budget.`, "#models", "Budget"]);
      const st = ctx.status;
      if (st && st.activeTargetCount === 0 && list.some((x) => x.enabled !== false)) items.push(["No active targets: check that groups A and B are on (Safety, Advanced).", "#safety", "Open Safety"]);
      fill(notices, items.map(([text, href, label]) =>
        h("div", { class: "banner banner-warn" }, icon("alert"), h("span", { class: "banner-text" }, text), h("a", { href, class: "btn btn-sm" }, label))));
      notices.hidden = !items.length;
    }

    // ------------------------------------------------ setup checklist
    function steps() {
      const s = ctx.settings, state = ctx.state;
      const handle = String(s.account.handle || "").trim();
      const list = ctx.targetList();
      const ex = (s.prompt.styleExamples || []).filter((x) => String(x || "").trim()).length;
      return [
        { key: "key", title: "Add your OpenAI API key", hint: "Stored only in this browser. Never exported or logged.", done: hasKey, info: maskedKey },
        { key: "handle", title: "Confirm your X handle", hint: "ScoreX stops if a different account is logged in.", done: !!handle && lsGet(LS_HANDLE) === handle, info: handle },
        { key: "targets", title: "Add target accounts", hint: "The accounts ScoreX writes replies for.", done: list.length > 0, info: `${list.length} targets · ${list.filter((x) => x.enabled !== false).length} on` },
        { key: "examples", title: "Paste 5 or more of your best comments", hint: "The model copies their length, casing and punctuation.", done: ex >= 5, info: `${ex} of 5` },
        { key: "start", title: "Press Start", hint: s.mode === MODE.AUTO ? "Full auto posts on its own within your limits." : "In Review mode nothing posts until you approve it.", done: !!state.firstStartedAt || state.status !== STATUS.STOPPED, info: state.firstStartedAt ? `first start ${fmtDateTime(state.firstStartedAt)}` : "running" },
      ];
    }

    function stepControl(step) {
      if (step.key === "key") {
        if (step.done) return [h("code", { class: "masked-key", "data-masked": "1" }, step.info), h("a", { href: "#models", class: "small" }, "Change")];
        const input = h("input", { type: "password", class: "input", id: "setupKey", placeholder: "sk-...", autocomplete: "off", spellcheck: "false", "aria-label": "OpenAI API key" });
        const save = async (button) => {
          const v = input.value.trim();
          if (!v) { toast("Paste a key first.", { type: "warn" }); input.focus(); return; }
          if (/\s/.test(v)) { toast("The key contains spaces - check that you pasted only the key.", { type: "warn" }); return; }
          await busy(button, async () => {
            try { await setSecrets({ openaiKey: v }); } catch (e) { toast("Could not save the key: " + ((e && e.message) || e), { type: "error" }); return; }
            input.value = "";
            toast("API key saved", { type: "success" });
            await loadKey(); drawSetup(true); drawNotices();
          });
        };
        const saveBtn = btn("Save", (e) => save(e.currentTarget), { size: "sm" });
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(saveBtn); } });
        return [input, saveBtn];
      }
      if (step.key === "handle") {
        if (step.done) return [h("span", { class: "step-done" }, "@" + step.info), h("button", { type: "button", class: "linkish small", onClick: () => { lsSet(LS_HANDLE, null); drawSetup(true); } }, "Change")];
        const f = ctx.field({ path: "account.handle", type: "text", ariaLabel: "Your X handle (without @)", placeholder: "your_handle", cls: "field-tight", id: "setupHandle" });
        const confirm = btn("Confirm", async (e) => {
          const v = f.control.value.trim().replace(/^@+/, "").trim();
          if (!v) { toast("Enter your X handle first.", { type: "warn" }); f.control.focus(); return; }
          await busy(e.currentTarget, async () => {
            const saved = await ctx.save((d) => { d.account.handle = v; });
            if (saved) { lsSet(LS_HANDLE, saved.account.handle); drawSetup(true); }
          });
        }, { size: "sm" });
        return [h("span", { class: "muted small", "aria-hidden": "true" }, "@"), f, confirm];
      }
      if (step.key === "targets") return step.done ? [h("span", { class: "step-done" }, step.info)] : [h("a", { href: "#targets", class: "btn btn-sm" }, "Add targets")];
      if (step.key === "examples") return [h("span", { class: "step-done" }, step.info), step.done ? null : h("a", { href: "#tones", class: "btn btn-sm" }, "Paste examples")];
      if (step.key === "start") {
        if (step.done) return [h("span", { class: "step-done" }, step.info)];
        return [btn("Start", (e) => {
          const b = e.currentTarget;
          busy(b, async () => { const r = await ctx.send("start", {}, { label: "Start" }); if (r) { toast("Started", { type: "success" }); ctx.refreshStatus(); } });
        }, { kind: "primary", size: "sm", iconName: "play" })];
      }
      return [];
    }

    let setupSig = null, setupDeferred = false;
    function drawSetup(force) {
      const list = steps();
      const done = list.filter((x) => x.done).length;
      const dismissed = lsGet(LS_DISMISSED) === "1" && done === list.length;
      const sig = JSON.stringify([dismissed, list.map((x) => [x.done, x.info])]);
      if (!force && sig === setupSig) return;
      if (!force && setupHost.contains(document.activeElement)) {
        if (!setupDeferred) { setupDeferred = true; setupHost.addEventListener("focusout", () => { setupDeferred = false; setTimeout(() => drawSetup(), 60); }, { once: true }); }
        return;
      }
      setupSig = sig;
      clear(setupHost);
      if (dismissed) { drawNotices(); return; }
      const all = done === list.length;
      setupHost.appendChild(h("section", { class: "checklist", id: "setupChecklist", "aria-labelledby": "setupTitle" },
        h("header", { class: "checklist-head" },
          h("h2", { class: "checklist-title", id: "setupTitle" }, all ? "Setup complete" : "Set up ScoreX"),
          quotaBar(done, list.length, { label: "Setup steps done" }),
          h("span", { class: "checklist-count" }, `${done} / ${list.length}`),
          h("span", { class: "spacer" }),
          all ? btn("Dismiss", () => { lsSet(LS_DISMISSED, "1"); drawSetup(true); }, { size: "sm", id: "setupDismiss" }) : null),
        all
          ? h("p", { class: "checklist-done muted" }, "Everything is in place. Dismiss this checklist to keep the dashboard compact.")
          : h("ol", { class: "steps" }, list.map((step, i) => h("li", { class: ["step", step.done && "is-done"], dataset: { step: step.key } },
            h("span", { class: "step-num", "aria-hidden": "true" }, step.done ? icon("check") : String(i + 1)),
            h("div", null,
              h("div", { class: "step-title" }, step.title, h("span", { class: "sr-only" }, step.done ? " (done)" : " (to do)")),
              step.done ? null : h("div", { class: "step-hint" }, step.hint)),
            h("div", { class: "step-ctl" }, stepControl(step)))))));
      drawNotices();
    }

    // ------------------------------------------------ key numbers
    function drawFigs() {
      const { s, state, t, limit } = today();
      const gl = t.groupLimits || { A: groupLimit(s, "A", limit), B: groupLimit(s, "B", limit) };
      const pg = t.postedGroup || {};
      const genLimit = t.generationLimit != null ? t.generationLimit : generationLimit(s, state);
      const likeLim = t.likeLimit != null ? t.likeLimit : likeLimit(s);
      const spend = ctx.data[K.spend];
      const b = budgetStatus(s, spend);
      const todayCost = Math.max(num(t.cost), num(spend && spend.days && spend.days[dayKey(Date.now(), s.timezone)]));
      const monthCost = Math.max(num(b.spent), num(ctx.status && ctx.status.month && ctx.status.month.cost));
      const v = (x) => (x == null ? "-" : String(x));
      fill(figsHost, panel("figs-row",
        fig({ label: "Group A", value: v(pg.A), of: v(gl.A), sub: "follow you" }),
        fig({ label: "Group B", value: v(pg.B), of: v(gl.B), sub: "to win over" }),
        fig({ label: "Generated", value: v(t.generated), of: genLimit, sub: "24h, spend guard" }),
        fig({ label: "Likes", value: likeLim ? v(t.liked) : "Off", of: likeLim ? likeLim : null, sub: likeLim ? "like before reply" : "like combo off" }),
        fig({ label: "Skipped · failed", value: [v(t.skipped), h("span", { class: "fig-of" }, " · "), h("span", { class: num(t.failed) ? "text-red" : null }, v(t.failed))], sub: "since midnight" }),
        fig({ label: "Cost today", value: fmtUsd(todayCost), sub: "real OpenAI usage" }),
        fig({ label: "This month", value: fmtUsd(monthCost), of: b.limit ? fmtUsd(b.limit, 0) : null, sub: b.limit ? `${Math.round(b.pct)}% of budget${b.reached ? ", reached" : b.warn ? ", warning" : ""}` : "no budget set", href: "#models", cls: b.reached ? "is-red" : b.warn ? "is-amber" : null })));
    }

    // ------------------------------------------------ review preview
    let pending = [];
    async function loadPending() {
      try { pending = (await history.byStatus(HS.PENDING_REVIEW)).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); }
      catch (_) { pending = []; }
      drawPreview();
    }
    function quick(rec, action, button) {
      return busy(button, async () => {
        const text = action === "approve" ? String(rec.comment || "").trim() : "";
        if (action === "approve" && !text) { toast("This comment is empty. Edit it in the Review Queue.", { type: "warn" }); return; }
        if (action === "approve" && weightedLength(text) > HARD.maxCommentChars) { toast(`Too long for X (${HARD.maxCommentChars} max). Edit it in the Review Queue.`, { type: "warn" }); return; }
        const r = await ctx.send("reviewAction", { id: rec.id, action, text }, { label: action === "approve" ? "Approve" : "Skip" });
        if (r) { toast(action === "approve" ? "Approved - it posts in its own slot" : "Skipped", { type: "success" }); await loadPending(); ctx.refreshCounts(); }
      });
    }
    function drawPreview() {
      pendingCount.textContent = String(pending.length);
      clear(pvHost);
      if (!pending.length) {
        pvHost.appendChild(h("p", { class: "muted small", style: "padding:14px 0" }, ctx.state.status === STATUS.RUNNING
          ? "Nothing waiting. New comments appear here a few minutes after a target posts."
          : "Nothing waiting. Comments appear here once ScoreX is running."));
      }
      for (const rec of pending.slice(0, 3)) {
        const t = ctx.targets[rec.target] || {};
        pvHost.appendChild(h("article", { class: "pv", dataset: { id: rec.id } },
          h("div", { class: "pv-head" }, xLink(rec.target), groupBadge(rec.group || t.group), tierBadge(rec.tier || t.tier), h("span", { title: fmtDateTime(rec.createdAt) }, "· " + fmtAgo(rec.createdAt))),
          rec.postText ? h("div", { class: "pv-post", title: rec.postText }, truncate(rec.postText, 140)) : null,
          h("div", { class: "pv-comment" }, rec.comment || h("span", { class: "muted" }, "(empty)")),
          h("div", { class: "pv-actions" },
            btn("Approve", (e) => quick(rec, "approve", e.currentTarget), { kind: "primary", size: "xs", iconName: "check", title: "Approve this text as is" }),
            btn("Skip", (e) => quick(rec, "skip", e.currentTarget), { size: "xs", kind: "ghost", title: "Do not post anything for this post" }),
            h("span", { class: "spacer" }),
            h("a", { href: "#review", class: "small" }, "Edit"))));
      }
      const more = pending.length - 3;
      const queued = ctx.counts.queued || 0;
      pvFoot.textContent = [more > 0 ? `${more} more in the queue.` : "", queued ? `${queued} approved, waiting for their posting slot.` : ""].filter(Boolean).join(" ");
      pvFoot.hidden = !pvFoot.textContent;
    }

    // ------------------------------------------------ activity timeline
    function drawLogs() {
      const logs = Array.isArray(ctx.data[K.logs]) ? ctx.data[K.logs] : [];
      clear(logBody);
      moreBtn.hidden = logs.length <= 12;
      if (!logs.length) { logBody.appendChild(h("p", { class: "muted small", style: "padding:14px 0" }, "No activity yet. The engine's steps show up here once it runs.")); return; }
      for (const e of logs.slice().reverse().slice(0, showAllLogs ? 400 : 12)) {
        const lvl = ["error", "warn", "info", "debug"].includes(e.level) ? e.level : "info";
        logBody.appendChild(h("div", { class: ["log", "log-" + lvl] },
          h("span", { class: "log-time", title: fmtDateTime(e.ts) }, fmtTime(e.ts)),
          h("span", { class: "log-node", "aria-hidden": "true" }),
          h("span", { class: "log-msg" },
            h("span", { class: lvl === "warn" || lvl === "error" ? "log-lvl" : "sr-only" }, lvl),
            String(e.msg || ""),
            e.data ? h("span", { class: "log-data" }, " " + truncate(typeof e.data === "string" ? e.data : JSON.stringify(e.data), 240)) : null)));
      }
    }

    const drawLive = () => { drawStatus(); drawQuota(); drawFigs(); drawSetup(); drawNotices(); };
    drawStatus(); drawMode(); drawQuota(); drawSetup(true); drawFigs(); drawLogs();
    await loadPending();
    ctx.on("status", drawLive);
    ctx.on(K.state, drawLive);
    ctx.on("settings", () => { drawMode(); drawLive(); });
    ctx.on("counts", () => { loadPending(); drawFigs(); });
    ctx.on(K.spend, () => { drawFigs(); drawNotices(); });
    ctx.on(K.targets, () => { drawSetup(); drawNotices(); drawPreview(); });
    ctx.on(K.logs, drawLogs);
    ctx.on("tick", () => { drawStatus(); drawPreview(); });
    ctx.on("secrets", async () => { await loadKey(); drawSetup(); drawNotices(); });
  },
};

function safeActiveHours(s, ts) {
  try { return activeHours(s, ts); } catch (_) { return null; }
}
