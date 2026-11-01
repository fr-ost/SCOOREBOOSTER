// Today (#overview): the engine cell (status, why line, Run a check now, Review | Full auto) next to the day-rhythm
// strip, the setup stepper, "This week" outcome figures, Waiting for review (expiring first), Needs you (reach alert,
// replies waiting for you, X page-load budget, targets near their give-up day, new candidates, budget, health, setup
// gaps) and a plain-language activity log. History is read on render and again only when it changes (counts or new
// log lines), never on the 30 s tick.

import { K, MODE, STATUS, HS, HARD } from "../../lib/constants.js";
import { getSecrets, setSecrets, DEFAULT_TONE_PROMPT } from "../../lib/store.js";
import { budgetStatus } from "../../lib/costs.js";
import { dailyLimit, generationLimit, likeLimit, rampStage } from "../../lib/safety.js";
import { weightedLength } from "../../lib/quality.js";
import { funnel, dailySeries, authorReplies } from "../../lib/analytics.js";
import { followStatus, FS } from "../../lib/targets.js";
import * as history from "../../lib/history.js";
import { dayKey, num, DAY, HOUR, MIN } from "../../lib/util.js";
import {
  h, clear, btn, busy, toast, icon, statusInfo, isSafetyStop, segmented, switchMode, figure, ledger, delta, tierBadge, xLink, expiryChip,
  followDay, primaryProvider, setPrimaryProvider, enabledProviders, providerName, historyDelta, menuButton, safetyBanner, maskKey,
  fmtUsd, fmtTime, fmtDay, fmtDateTime, fmtAgo, fmtIn, fmtPct, fmtNum, truncate, debounce, add, fill, approvedSummary,
} from "../components.js";
import { responsive, rhythm, rhythmFrom, spark, stepLine, miniBars, vizClass } from "../charts.js";

const LS_DISMISSED = "sx.setup.dismissed"; // "1" = the setup stepper is hidden
const LS_HANDLE = "sx.setup.handle"; // the handle the user confirmed in the stepper
const LS_NEEDS = "sx.needs.hidden"; // { [row key]: hidden until (ms) } - "Needs you" rows hidden for a day
const LS_CAND_SEEN = "sx.needs.candSeen"; // last time the user opened the new-candidates row
const lsGet = (k) => { try { return window.localStorage.getItem(k); } catch (_) { return null; } };
const lsSet = (k, v) => { try { if (v == null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, v); } catch (_) { /* storage blocked */ } };
const lsJson = (k) => { try { return JSON.parse(lsGet(k) || "null") || {}; } catch (_) { return {}; } };

// Only links to X open from "Needs you" (conversation items hold page-provided URLs).
const safeX = (u) => { try { const x = new URL(String(u || "")); return x.protocol === "https:" && /(^|\.)(x|twitter)\.com$/.test(x.hostname) ? x.href : null; } catch (_) { return null; } };

// Engine log lines in plain language. Lines not listed here are shown as written (they already are plain text).
const LOG_MAP = [
  [/^Tick failed: (.+)$/i, (m) => `A check failed (${m[1]}). ScoreX tries again at the next check.`],
  [/^AUTO-STOP: (.+)$/, (m) => `Stopped for safety: ${m[1]}`],
  [/^Watch check failed \((.+?)\)(.*)$/, (m) => `Could not read new posts (${m[1]}). ScoreX tries again at the next check.`],
  [/^Not reusing the stored X tab id.*/, () => "Opened a new X tab (the stored one was from an earlier browser session)"],
  [/^Reusing the restored ScoreX X tab.*/, () => "Reconnected to the ScoreX X tab"],
  [/^Refresh failed: (.+)$/, (m) => `Profile refresh failed: ${m[1]}`],
  [/^Discovery failed: (.+)$/, (m) => `Finding new accounts failed: ${m[1]}`],
  [/^Re-check paused: (.+)$/, (m) => `Follow re-check paused: ${m[1]}`],
  [/^Started$/, () => "Started the engine"],
  [/^Paused$/, () => "Paused: nothing is generated or posted until you resume"],
  [/^Resumed$/, () => "Resumed the engine"],
  [/^Stopped by you$/, () => "Stopped by you"],
];
export function humanLog(msg) {
  const s = String(msg || "");
  for (const [re, fn] of LOG_MAP) { const m = s.match(re); if (m) return fn(m); }
  return s;
}

export default {
  id: "overview",
  title: "Today",
  async render(root, ctx) {
    let hasKey = true, maskedKey = "";
    const loadKey = async () => {
      try { const sec = await getSecrets(); hasKey = !!sec.openaiKey; maskedKey = maskKey(sec.openaiKey); } catch (_) { hasKey = true; }
    };
    await loadKey();

    let records = []; // history of the last 31 days (rhythm, weekly cost, author replies)
    let pending = []; // pending review, expiring first
    let approved = []; // approved + queued (waiting for a posting slot)
    const now = () => Date.now();
    const sigs = new Map();
    // Redraw a region only when its content signature changed (keeps focus and avoids flicker on 5 s status polls).
    const region = (host, sig, build) => { if (sigs.get(host) === sig) return; sigs.set(host, sig); fill(host, build()); };

    // ------------------------------------------------ layout
    const reachHost = h("div", { id: "reachAlertHost" });
    const engineCell = h("div", { class: "cell engine-cell" });
    const rhythmCell = h("div", { class: "cell rhythm-cell" });
    const setupHost = h("div", { id: "setupHost" });
    const weekHint = h("span", { class: "sec-hint" });
    const weekHost = h("div", { id: "weekFigures" });
    const followLine = h("p", { class: "follow-line", id: "followLine" });
    const pendingCount = h("span", { class: "count", id: "pendingCount" }, "0");
    const pvHost = h("div", { class: "list pv-list", id: "reviewPreview" });
    const pvFoot = h("p", { class: "small muted pv-foot" });
    const needsCount = h("span", { class: "count", id: "needsCount" }, "0");
    const needsHost = h("div", { class: "list", id: "needsList" });
    const logBody = h("div", { class: "log-list", id: "activityLog", "aria-live": "off" });
    let showAllLogs = false;
    const logBtn = h("button", { type: "button", class: "linkish small", id: "fullLogBtn", "aria-controls": "activityLog", "aria-expanded": "false",
      onClick: () => { showAllLogs = !showAllLogs; logBtn.textContent = showAllLogs ? "Show less" : "Full log"; logBtn.setAttribute("aria-expanded", String(showAllLogs)); drawLogs(true); } }, "Full log");

    add(root,
      reachHost,
      h("div", { class: "panel today-engine" }, h("div", { class: "panel-in" }, engineCell, rhythmCell)),
      setupHost,
      h("section", { class: "today-week", "aria-labelledby": "weekTitle" },
        h("div", { class: "week-head" }, h("h2", { class: "sec-title", id: "weekTitle" }, "This week"), weekHint),
        weekHost, followLine),
      h("div", { class: "cols today-cols" },
        h("section", { class: "sec sec-wide today-review", "aria-labelledby": "pvTitle" },
          h("header", { class: "sec-head" },
            h("div", { class: "sec-titles" }, h("h2", { class: "sec-title", id: "pvTitle" }, "Waiting for review ", pendingCount), h("span", { class: "sec-hint" }, "expiring first")),
            h("a", { href: "#review", class: "small" }, "Open queue")),
          h("div", { class: "sec-body" }, pvHost, pvFoot)),
        h("section", { class: "sec sec-wide today-needs", "aria-labelledby": "needsTitle" },
          h("header", { class: "sec-head" }, h("div", { class: "sec-titles" }, h("h2", { class: "sec-title", id: "needsTitle" }, "Needs you ", needsCount))),
          h("div", { class: "sec-body" }, needsHost,
            h("div", { class: "act-head" }, h("h3", { class: "cap" }, "Activity"), logBtn),
            logBody))));

    // ------------------------------------------------ reach alert (red banner with the views caveat)
    function drawReach() {
      const a = ctx.state.reachAlert;
      region(reachHost, JSON.stringify(a || null), () => {
        if (!a) return [];
        const nums = [];
        if (a.medianNow != null) nums.push(`median ${fmtNum(a.medianNow)} views per reply${a.medianBefore != null ? ` (was ${fmtNum(a.medianBefore)})` : ""}`);
        if (a.lowShare != null) nums.push(`${Math.round(num(a.lowShare) * 100)}% of ${a.checked != null ? fmtNum(a.checked) + " " : ""}checked replies got very few views`);
        const did = { review: "ScoreX switched to Review mode.", halve: "ScoreX halved its pace.", stop: "ScoreX stopped.", notify: "" }[a.action] || "";
        return safetyBanner({
          id: "reachBanner", cls: "reach-banner",
          title: "Your replies are reaching far fewer people than last week",
          detail: [a.message ? h("div", null, String(a.message)) : null, nums.length ? h("div", { class: "mono-nums" }, nums.join(" · ")) : null, did ? h("div", null, did) : null,
            h("div", { class: "reach-caveat" }, "Views are a proxy - X does not tell you when it hides a reply.")],
          time: a.at ? `${fmtDateTime(a.at)} (${fmtAgo(a.at)})` : "",
          actions: [
            h("a", { href: "#safety", class: "btn btn-sm btn-light" }, "Reach settings"),
            btn("Dismiss", (e) => busy(e.currentTarget, async () => { const r = await ctx.send("reachDismiss", {}, { label: "Dismiss" }); if (r) { toast("Reach alert dismissed"); ctx.refreshStatus(); } }),
              { kind: "ghost-light", size: "sm", id: "reachDismissBtn", title: "Hide this alert (the monitor keeps watching)" }),
          ],
        });
      });
    }

    // ------------------------------------------------ engine cell
    const modeSeg = segmented([[MODE.REVIEW, "Review"], [MODE.AUTO, "Full auto"]], ctx.settings.mode, async (v) => {
      const ok = await switchMode(ctx, v);
      modeSeg.set(ctx.settings.mode);
      if (ok && v === MODE.AUTO) toast("Full auto is on", { type: "success" });
    }, { label: "Mode", cls: "seg-accent" });
    modeSeg.id = "modeSwitch";
    const runBtn = btn("Run a check now", (e) => {
      const b = e.currentTarget;
      busy(b, async () => { const r = await ctx.send("runNow", {}, { label: "Run a check now" }); if (r) { toast("Check started", { type: "success" }); ctx.refreshStatus(); } }).then(() => drawEngine(true));
    }, { iconName: "refresh", size: "sm", id: "runNowBtn" });
    const statusHost = h("div", { class: "engine-status" });
    const whyHost = h("div", { class: "why", id: "engineWhy" });
    const modeNote = h("p", { class: "cell-note", id: "modeNote" });
    const stopBtnHost = h("span");
    add(engineCell,
      h("span", { class: "cap" }, "Engine"),
      statusHost, whyHost,
      h("div", { class: "engine-actions" }, runBtn, stopBtnHost, modeSeg),
      modeNote);

    const tnum = (ts) => h("b", { class: "mono" }, fmtTime(ts));
    function whyParts() {
      const state = ctx.state, st = ctx.status || {}, s = ctx.settings, t = now();
      const info = statusInfo(state);
      const ah = st.activeHours || null;
      const hours = s.safety.activeHours.enabled ? `${s.safety.activeHours.start}-${s.safety.activeHours.end}` : "all day";
      const out = [];
      if (state.status === STATUS.RUNNING) {
        if (ah && ah.inside === false) out.push(["Sleeping outside active hours (", hours, ") · wakes at ", tnum(ah.opensAt)]);
        else if (state.breakUntil && state.breakUntil > t) out.push(["On a break until ", tnum(state.breakUntil), ` (${fmtIn(state.breakUntil)})`]);
        else if (state.nextCommentAt && state.nextCommentAt > t) out.push(["Waiting between comments · next at ", tnum(state.nextCommentAt), ` (${fmtIn(state.nextCommentAt)})`]);
        else out.push(["Looking for fresh posts from your targets"]);
        if (state.nextTickWhy && /page-load/i.test(state.nextTickWhy)) out.push([String(state.nextTickWhy)]);
        else if (st.watch && st.watch.slow) {
          const since = Math.max(state.lastFreshAt || 0, state.startedAt || 0);
          out.push([`watching slowly${since ? `: nothing new for ${Math.max(1, Math.round((t - since) / MIN))} min` : ""}`]);
        }
        if (state.job && state.job.kind) out.push([`working: ${state.job.kind}${state.job.step ? " - " + state.job.step : ""}`]);
        if (state.nextTickAt) out.push(["next check ", tnum(state.nextTickAt)]);
        if (state.lastTickAt) out.push([`last check ${fmtAgo(state.lastTickAt)}`]);
      } else if (info.kind === "danger") {
        out.push([info.reason ? `Stopped for safety: ${info.reason}.` : "Stopped for safety.", " Check your X account, then review the stop to resume."]);
      } else if (state.status === STATUS.PAUSED) {
        out.push(["Nothing is generated or posted until you press Resume."]);
      } else {
        out.push([`Press Start to begin. ScoreX works inside active hours (${hours}, ${s.timezone}).`]);
      }
      if (state.status !== STATUS.RUNNING && state.lastTickAt) out.push([`last check ${fmtAgo(state.lastTickAt)}`]);
      return out;
    }
    function drawEngine(force) {
      const state = ctx.state, s = ctx.settings;
      const info = statusInfo(state);
      const running = state.status === STATUS.RUNNING;
      const parts = whyParts();
      const sig = JSON.stringify([info, state.nextCommentAt, state.breakUntil, state.nextTickAt, state.lastTickAt, state.job, state.nextTickWhy, state.stopDetail, (ctx.status || {}).watch, (ctx.status || {}).activeHours, Math.floor(now() / 30000)]);
      if (!force && sigs.get(engineCell) === sig) return;
      sigs.set(engineCell, sig);
      fill(statusHost,
        h("div", { class: ["status", "status-" + info.kind, "status-hero"], id: "heroStatus" },
          h("span", { class: "dot", "aria-hidden": "true" }),
          h("span", { class: "status-label" }, info.label),
          info.kind !== "running" && (info.short || info.reason) ? h("span", { class: "status-reason" }, info.short || info.reason) : null));
      fill(whyHost, parts.map((p, i) => [i ? " · " : null, ...p]));
      if (info.kind === "danger" && state.stopDetail) whyHost.appendChild(h("div", { class: "stop-detail" }, "X showed: ", h("q", null, String(state.stopDetail))));
      if (!runBtn.classList.contains("is-busy")) {
        runBtn.disabled = !running;
        runBtn.title = running ? "Look for fresh posts right away (all safety limits still apply)" : "Start or resume the engine first";
      }
      fill(stopBtnHost, info.kind === "danger" ? btn("Review stop…", () => ctx.openReviewStop(), { size: "sm", iconName: "alert", cls: "btn-danger-soft" }) : null);
      modeSeg.set(s.mode);
      fill(modeNote, s.mode === MODE.AUTO ? "Posts on its own, always inside your safety limits." : ["You approve every reply in ", h("a", { href: "#review" }, "Review"), " first."]);
    }

    // ------------------------------------------------ day rhythm strip + effort counters
    const rhythmChart = responsive((w) => rhythm(rhythmData(), { w, h: 46 }), { initialWidth: 640 });
    const rhythmFoot = h("div", { class: "fig-sub rhythm-foot", id: "rhythmFoot" });
    add(rhythmCell,
      h("div", { class: "cell-head" }, h("span", { class: "cap" }, "Day rhythm · last 18 h + next 6 h"), h("a", { href: "#safety", class: "small" }, "Limits")),
      rhythmChart, rhythmFoot);
    function rhythmData() {
      const state = ctx.state, s = ctx.settings, t = now(), from = t - 18 * HOUR;
      const posts = [], fails = [];
      for (const r of records) {
        if (r.status === HS.POSTED && r.postedAt >= from) posts.push(r.postedAt);
        else if (r.status === HS.FAILED) { const at = r.attemptAt || r.updatedAt || r.createdAt; if (at >= from) fails.push(at); }
      }
      const breaks = state.breakUntil && state.lastCommentAt && state.breakUntil > state.lastCommentAt ? [[state.lastCommentAt, state.breakUntil]] : [];
      return rhythmFrom({ now: t, posts, fails, breaks, next: state.status === STATUS.RUNNING ? state.nextCommentAt : null, activeHours: s.safety.activeHours, tz: s.timezone });
    }
    function drawRhythm() {
      const s = ctx.settings, state = ctx.state, st = ctx.status || {}, t = st.today || {};
      const limit = t.limit != null ? t.limit : dailyLimit(s, state);
      const genLimit = t.generationLimit != null ? t.generationLimit : generationLimit(s, state);
      const likeLim = t.likeLimit != null ? t.likeLimit : likeLimit(s);
      const spend = ctx.data[K.spend];
      const b = budgetStatus(s, spend);
      const todayCost = Math.max(num(t.cost), num(b.today));
      const monthCost = Math.max(num(b.spent), num(st.month && st.month.cost));
      const stage = st.rampStage != null ? st.rampStage : rampStage(state);
      const v = (x) => (x == null ? "-" : fmtNum(x));
      const item = (value, label, attrs = {}) => h("span", attrs, h("b", { class: "mono" }, value), " ", label);
      const sig = JSON.stringify([t, limit, genLimit, likeLim, todayCost, monthCost, b.limit, stage]);
      region(rhythmFoot, sig, () => [
        item([h("span", { id: "postedToday" }, v(t.posted)), ` / ${limit}`], "posted (24 h)", { title: `Ramp week ${stage + 1}${stage >= 2 ? "+" : ""} · hard cap ${HARD.dailyComments} a day` }),
        item(`${v(t.generated)} / ${genLimit}`, "generated"),
        t.skipped ? item(v(t.skipped), "skipped") : null,
        item(v(t.failed), "failed", { class: num(t.failed) ? "text-red" : null }),
        likeLim ? item(`${v(t.liked)} / ${likeLim}`, "liked") : null,
        item(fmtUsd(todayCost), "today"),
        item(`${fmtUsd(monthCost)}${b.limit ? " / " + fmtUsd(b.limit, 0) : ""}`, "month", { class: b.reached ? "text-red" : b.warn ? "text-amber" : null }),
      ]);
    }

    // ------------------------------------------------ setup stepper
    let openStep = null; // the step whose inline control is expanded
    function steps() {
      const s = ctx.settings, state = ctx.state;
      const handle = String(s.account.handle || "").trim();
      const list = ctx.targetList();
      const customTone = String(s.prompt.tone || "").trim() !== DEFAULT_TONE_PROMPT;
      const providers = enabledProviders(s);
      return [
        { key: "key", label: "API key", title: "Add your OpenAI API key", hint: "Stored only in this browser. Never exported or logged.", done: hasKey, info: maskedKey },
        { key: "handle", label: "Handle", title: "Confirm your X handle", hint: "ScoreX stops if a different account is logged in.", done: !!handle && lsGet(LS_HANDLE) === handle, info: handle },
        { key: "targets", label: "Targets", title: "Add target accounts", hint: "The accounts ScoreX writes replies for.", done: list.length > 0, info: `${list.length} targets · ${list.filter((x) => x.enabled !== false).length} on` },
        { key: "start", label: "Start", title: "Press Start", hint: isSafetyStop(state) ? "ScoreX stopped for safety. Check your X account, then review the stop to start." : s.mode === MODE.AUTO ? "Full auto posts on its own within your limits." : "In Review mode nothing posts until you approve it.", done: !!state.firstStartedAt || state.status !== STATUS.STOPPED, info: state.firstStartedAt ? `first start ${fmtDateTime(state.firstStartedAt)}` : "running" },
        { key: "tone", label: "Tone", optional: true, title: "Write your Tone prompt", hint: "Describe how your replies should sound. The default works; your own voice works better.", done: customTone, info: customTone ? "Custom" : "Default" },
        { key: "budget", label: "Budget", optional: true, title: "Set a monthly budget", hint: "ScoreX stops generating when the month's real OpenAI spend reaches it.", done: num(s.budget && s.budget.monthlyUsd) > 0, info: num(s.budget && s.budget.monthlyUsd) > 0 ? fmtUsd(s.budget.monthlyUsd, 0) + " a month" : "no limit" },
        { key: "score", label: "Score site", optional: true, title: "Connect a score site", hint: "Track your Sorsa, TwitterScore, Ethos or Moni score next to your follow-backs.", done: providers.length > 0, info: providers.map(providerName).join(", ") },
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
            await loadKey(); openStep = null; drawSetup(true); drawNeeds();
          });
        };
        const saveBtn = btn("Save", (e) => save(e.currentTarget), { size: "sm", kind: "primary" });
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(saveBtn); } });
        return [input, saveBtn];
      }
      if (step.key === "handle") {
        if (step.done) return [h("span", { class: "step-done" }, "@" + step.info), h("button", { type: "button", class: "linkish small", onClick: () => { lsSet(LS_HANDLE, null); openStep = "handle"; drawSetup(true); } }, "Change")];
        const f = ctx.field({ path: "account.handle", type: "text", ariaLabel: "Your X handle (without @)", placeholder: "your_handle", cls: "field-tight", id: "setupHandle" });
        const confirm = btn("Confirm", async (e) => {
          const v = f.control.value.trim().replace(/^@+/, "").trim();
          if (!v) { toast("Enter your X handle first.", { type: "warn" }); f.control.focus(); return; }
          await busy(e.currentTarget, async () => {
            const saved = await ctx.save((d) => { d.account.handle = v; });
            if (saved) { lsSet(LS_HANDLE, saved.account.handle); openStep = null; drawSetup(true); }
          });
        }, { size: "sm", kind: "primary" });
        return [h("span", { class: "muted small", "aria-hidden": "true" }, "@"), f, confirm];
      }
      if (step.key === "targets") return [step.done ? h("span", { class: "step-done" }, step.info) : null, h("a", { href: "#targets", class: "btn btn-sm" }, step.done ? "Open Targets" : "Add targets")];
      if (step.key === "tone") return [h("span", { class: "step-done" }, step.info), h("a", { href: "#tones", class: "btn btn-sm" }, step.done ? "Edit tone" : "Write my tone")];
      if (step.key === "budget") return [h("span", { class: "step-done" }, step.info), h("a", { href: "#models", class: "btn btn-sm" }, step.done ? "Change budget" : "Set a budget")];
      if (step.key === "score") return [step.done ? h("span", { class: "step-done" }, step.info) : null, h("a", { href: "#scores", class: "btn btn-sm" }, step.done ? "Open Scores" : "Connect a score site")];
      if (step.key === "start") {
        if (step.done) return [h("span", { class: "step-done" }, step.info)];
        return [startButton()];
      }
      return [];
    }
    // During a safety stop (e.g. a captcha in the live X test before the first start) the step never offers a one-click
    // Start: like the engine bar, it opens the "Review stop…" dialog (checkbox, then Resume).
    const startButton = () => (isSafetyStop(ctx.state)
      ? btn("Review stop…", () => ctx.openReviewStop(), { kind: "primary", size: "sm", iconName: "alert", title: "See why ScoreX stopped, check your account, then resume" })
      : btn("Start", (e) => {
        const b = e.currentTarget;
        busy(b, async () => { const r = await ctx.send("start", {}, { label: "Start" }); if (r) { toast("Started", { type: "success" }); ctx.refreshStatus(); } });
      }, { kind: "primary", size: "sm", iconName: "play" }));
    // The one action button: the next open step (required first).
    function nextAction(list) {
      const next = list.find((x) => !x.done && !x.optional) || list.find((x) => !x.done);
      if (!next) return null;
      if (next.key === "key" || next.key === "handle") return btn(next.key === "key" ? "Add API key" : "Confirm handle", () => { openStep = next.key; drawSetup(true); focusStep(); }, { size: "xs" });
      if (next.key === "start") return startButton();
      const [href, label] = { targets: ["#targets", "Add targets"], tone: ["#tones", "Write my tone"], budget: ["#models", "Set a budget"], score: ["#scores", "Connect a score site"] }[next.key];
      return h("a", { href, class: "btn btn-xs" }, label);
    }
    const focusStep = () => setTimeout(() => { const el = setupHost.querySelector(".stepper-panel input, .stepper-panel button, .stepper-panel a"); if (el) el.focus(); }, 0);
    const isHidden = () => lsGet(LS_DISMISSED) === "1";
    let setupDeferred = false;
    function drawSetup(force) {
      const list = steps();
      const done = list.filter((x) => x.done).length;
      const reqLeft = list.filter((x) => !x.done && !x.optional);
      if (openStep == null && reqLeft.length && (reqLeft[0].key === "key" || reqLeft[0].key === "handle")) openStep = reqLeft[0].key;
      const show = !isHidden() && done < list.length;
      const sig = JSON.stringify([show, openStep, list.map((x) => [x.done, x.info]), isSafetyStop(ctx.state)]);
      if (!force && sig === sigs.get(setupHost)) return;
      if (!force && setupHost.contains(document.activeElement)) {
        if (!setupDeferred) { setupDeferred = true; setupHost.addEventListener("focusout", () => { setupDeferred = false; setTimeout(() => drawSetup(), 60); }, { once: true }); }
        return;
      }
      sigs.set(setupHost, sig);
      clear(setupHost);
      if (!show) return;
      const cur = list.find((x) => x.key === openStep) || null;
      const panelId = "setupPanel";
      setupHost.appendChild(h("section", { class: "setup-box", id: "setupChecklist", "aria-label": "Setup" },
        h("div", { class: "stepper" },
          h("b", { class: "checklist-count" }, `Setup ${done} of ${list.length}`),
          h("ul", { class: "steps-row" }, list.map((step) => h("li", { class: ["step-chip", step.done && "is-done", step.optional && "is-optional", openStep === step.key && "is-open"], dataset: { step: step.key } },
            h("button", { type: "button", class: "st-btn", "aria-expanded": String(openStep === step.key), "aria-controls": panelId,
              title: step.title + (step.done ? " (done)" : step.optional ? " (optional)" : ""),
              onClick: () => { openStep = openStep === step.key ? null : step.key; drawSetup(true); if (openStep) focusStep(); } },
              h("b", { "aria-hidden": "true" }, step.done ? "✓" : ""), step.label,
              step.optional ? h("span", { class: "opt" }, "optional") : null,
              h("span", { class: "sr-only" }, ` - ${step.title}${step.info ? ` (${step.info})` : ""}${step.done ? ", done" : ", to do"}`))))),
          h("span", { class: "spacer" }),
          nextAction(list),
          btn("Hide", () => { lsSet(LS_DISMISSED, "1"); drawSetup(true); drawNeeds(); toast("Setup hidden. Open steps still show under Needs you.", { action: { label: "Undo", onClick: () => { lsSet(LS_DISMISSED, null); drawSetup(true); drawNeeds(); } } }); },
            { kind: "ghost", size: "xs", id: "setupDismiss", title: "Hide the setup steps (open required steps still show under Needs you)" })),
        cur ? h("div", { class: "stepper-panel", id: panelId, dataset: { stepPanel: cur.key } },
          h("div", { class: "sp-text" }, h("div", { class: "sp-title" }, cur.title, cur.optional ? h("span", { class: "opt" }, " optional") : null), h("div", { class: "small muted" }, cur.hint)),
          h("div", { class: "step-ctl" }, stepControl(cur))) : null));
    }

    // ------------------------------------------------ This week
    function weekData() {
      const s = ctx.settings, targets = ctx.targets, t = now();
      const fbAt = Object.values(targets).map((x) => x && x.rel && x.rel.followedBackAt).filter(Boolean);
      const between = (lo, hi) => fbAt.filter((a) => a >= lo && a < hi).length;
      const fb7 = between(t - 7 * DAY, t + 1), fbPrev = between(t - 14 * DAY, t - 7 * DAY);
      const daily = dailySeries([], targets, { days: 30, tz: s.timezone, ts: t });
      // Follow-back rate among accounts whose window ended (followed back or removed), weekly for the sparkline.
      const f = funnel(targets, [], ctx.data[K.blacklist] || {});
      const gaveUpAt = Object.values(ctx.data[K.blacklist] || {}).filter((b) => b && b.reason === "no_followback").map((b) => b.at || 0);
      const weekRate = (lo, hi) => { const a = between(lo, hi), g = gaveUpAt.filter((x) => x >= lo && x < hi).length; return a + g ? (a / (a + g)) * 100 : null; };
      const rates = []; for (let i = 7; i >= 0; i--) rates.push(weekRate(t - (i + 1) * 7 * DAY, t - i * 7 * DAY + 1));
      const rNow = weekRate(t - 7 * DAY, t + 1), rPrev = weekRate(t - 14 * DAY, t - 7 * DAY);
      // Cost per follow-back over 30 days from the spend ledger (real OpenAI usage).
      const days = (ctx.data[K.spend] && ctx.data[K.spend].days) || {};
      const costBetween = (lo, hi) => { let c = 0; for (let x = lo; x < hi; x += DAY) c += num(days[dayKey(x, s.timezone)]); return c; };
      const cost30 = costBetween(t - 29 * DAY, t + 1), costPrev = costBetween(t - 59 * DAY, t - 29 * DAY);
      const fb30 = between(t - 30 * DAY, t + 1), fbPrev30 = between(t - 60 * DAY, t - 30 * DAY);
      const cpf = fb30 ? cost30 / fb30 : null, cpfPrev = fbPrev30 ? costPrev / fbPrev30 : null;
      const cpfWeeks = []; for (let i = 7; i >= 0; i--) { const lo = t - (i + 1) * 7 * DAY, hi = t - i * 7 * DAY + 1; const n = between(lo, hi); cpfWeeks.push(n ? costBetween(lo, hi) / n : null); }
      return { fb7, fbPrev, any: fbAt.length, daily, rate: f.decidedRate, rates, rNow, rPrev, cpf, cpfPrev, cpfWeeks, fb30 };
    }
    function drawWeek() {
      const s = ctx.settings, t = now();
      weekHint.textContent = `${fmtDay(t - 6 * DAY)} - ${fmtDay(t)} vs the 7 days before`;
      const w = weekData();
      const board = ctx.data[K.scoreboard] || {};
      const pid = primaryProvider(s, board);
      const own = pid && board.own ? board.own[pid] : null;
      const en = enabledProviders(s);
      const sig = JSON.stringify([w, pid, own && [own.score, own.max, own.at, own.error, (own.history || []).length], en, Math.floor(t / 600000)]);
      region(weekHost, sig, () => {
        const hist = own && Array.isArray(own.history) ? own.history.slice(-90) : [];
        const scoreLabel = pid ? `${providerName(pid)} score` : "Score";
        const pick = en.length > 1 ? menuButton({ iconName: "caret", title: "Choose the score shown here", size: "xs", cls: "fig-pick", menuLabel: "Score shown on Today",
          items: () => en.map((id) => ({ label: providerName(id), radio: true, checked: id === pid, onSelect: () => { setPrimaryProvider(id); sigs.delete(weekHost); drawWeek(); } })) }) : null;
        const scoreFig = figure({
          key: pid || undefined, label: scoreLabel, id: "figScore", href: pid && !pick ? "#scores" : undefined,
          value: own && own.score != null ? fmtNum(own.score) : "-", of: own && own.max ? fmtNum(own.max) : null,
          chart: hist.length > 1 ? stepLine(hist.map((x) => Number(x.s)), { w: 110, h: 28, cls: vizClass(pid), label: `${scoreLabel}, last ${hist.length} days` }) : null,
          delta: own && own.score != null ? delta(historyDelta(own.history, 7), { suffix: "7d", title: "Change over 7 days" }) : null,
          sub: !pid ? h("a", { href: "#scores" }, "Connect a score site") : own && own.score != null ? `${hist.length} days · updated ${fmtAgo(own.at)}` : own && own.error ? "last check failed" : "not checked yet",
        });
        if (pick) scoreFig.querySelector(".fig-label").appendChild(pick);
        return ledger(
          figure({
            label: "Follow-backs", value: String(w.fb7), id: "figFollowBacks", href: "#history?view=ov",
            chart: miniBars(w.daily.map((d) => d.followBacks), { w: 110, h: 28, label: "Follow-backs per day, last 30 days", titles: w.daily.map((d) => `${d.d}: ${d.followBacks}`) }),
            delta: w.any ? delta(w.fb7 - w.fbPrev, { suffix: "vs prev", title: `${w.fbPrev} in the 7 days before` }) : null,
            sub: w.any ? "7 days · bars: 30 days" : "No follow-backs yet: they arrive 1-14 days after the first comments",
          }),
          figure({
            label: "Follow-back rate", value: w.rate == null ? "-" : fmtPct(w.rate * 100, 1), id: "figRate", href: "#history?view=ov",
            chart: w.rates.some((x) => x != null) ? spark(w.rates, { w: 110, h: 28, label: "Follow-back rate per week, last 8 weeks" }) : null,
            delta: w.rNow != null && w.rPrev != null ? delta(w.rNow - w.rPrev, { unit: " pt", digits: 1, title: "This week vs the week before" }) : null,
            sub: w.rate == null ? `known once accounts reach day ${s.follow.giveUpDays || 14}` : `of accounts whose ${s.follow.giveUpDays || 14}-day window ended`,
          }),
          scoreFig,
          figure({
            label: "Cost per follow-back", value: w.cpf == null ? "-" : fmtUsd(w.cpf), id: "figCpf", href: "#history?view=spend",
            chart: w.cpfWeeks.some((x) => x != null) ? spark(w.cpfWeeks, { w: 110, h: 28, label: "Cost per follow-back per week, last 8 weeks" }) : null,
            delta: w.cpf != null && w.cpfPrev != null ? delta(w.cpf - w.cpfPrev, { digits: 2, invert: true, title: "vs the 30 days before" }) : null,
            sub: "30 days · real OpenAI cost",
          }));
      });
      drawFollowLine();
    }
    function drawFollowLine() {
      const fo = (ctx.status && ctx.status.follow) || {};
      const v = (x) => (x == null ? "-" : String(x));
      region(followLine, JSON.stringify(fo), () => [
        h("span", { class: "cap" }, "Targets"),
        h("span", null, "commenting on ", h("b", { class: "mono", id: "figActive" }, v(fo.active))),
        h("span", null, "checking ", h("b", { class: "mono", id: "figChecking" }, v(fo.checking))),
        h("span", null, "followed back ", h("b", { class: "mono", id: "figFollowedBack" }, v(fo.followedBack))),
        h("span", null, "follow you ", h("b", { class: "mono", id: "figFollows" }, v(fo.follows))),
        h("a", { href: "#targets", class: "small" }, "Open Targets"),
      ]);
    }

    // ------------------------------------------------ waiting for review
    function quick(rec, action, button) {
      return busy(button, async () => {
        const text = action === "approve" ? String(rec.comment || "").trim() : "";
        if (action === "approve" && !text) { toast("This comment is empty. Edit it in Review.", { type: "warn" }); return; }
        if (action === "approve" && weightedLength(text) > HARD.maxCommentChars) { toast(`Too long for X (${HARD.maxCommentChars} max). Edit it in Review.`, { type: "warn" }); return; }
        const r = await ctx.send("reviewAction", { id: rec.id, action, text }, { label: action === "approve" ? "Approve" : "Skip" });
        if (r) { toast(action === "approve" ? "Approved - it posts in its own slot" : "Skipped", { type: "success" }); await loadPending(); ctx.refreshCounts(); }
      });
    }
    // Approved replies the engine drops instead of posting (target removed, turned off, follows you, status unknown)
    // are not counted as waiting for a slot.
    const waitingText = () => approvedSummary(approved, ctx.targets, ctx.settings, ctx.state);
    function drawPreview() {
      const maxAge = ctx.settings.review.pendingMaxAgeMin;
      pendingCount.textContent = String(pending.length);
      const waitTxt = waitingText();
      const sig = JSON.stringify([pending.map((r) => [r.id, r.updatedAt, r.comment]), maxAge, waitTxt, ctx.state.status, Math.floor(now() / 30000),
        pending.slice(0, 3).map((r) => followStatus(ctx.targets[r.target] || {}))]);
      if (sigs.get(pvHost) === sig) return;
      if (pvHost.contains(document.activeElement) && document.activeElement.classList.contains("is-busy")) return;
      sigs.set(pvHost, sig);
      clear(pvHost);
      if (!pending.length) {
        pvHost.appendChild(h("p", { class: "muted small empty-line" }, ctx.state.status === STATUS.RUNNING
          ? "Nothing waiting. New replies appear here a few minutes after a target posts."
          : "Nothing waiting. Replies appear here once ScoreX is running."));
      }
      for (const rec of pending.slice(0, 3)) {
        const t = ctx.targets[rec.target] || null;
        const fs = t ? followStatus(t) : null;
        const followsNow = fs === FS.FOLLOWS || fs === FS.FOLLOWED_BACK;
        const postedAt = rec.postCreatedAt || rec.createdAt;
        pvHost.appendChild(h("article", { class: "li pv", dataset: { id: rec.id } },
          h("span", { class: "avatar", "aria-hidden": "true" }, String(rec.target || "?").charAt(0).toUpperCase()),
          h("div", { class: "li-main" },
            h("div", { class: "li-head" }, xLink(rec.target), tierBadge(rec.tier || (t && t.tier)), h("span", { title: fmtDateTime(postedAt) }, "posted " + fmtAgo(postedAt)), expiryChip(rec.createdAt, maxAge)),
            rec.postText ? h("div", { class: "post", title: rec.postText }, "“" + truncate(rec.postText, 160) + "”") : null,
            h("div", { class: "reply" }, rec.comment || h("span", { class: "muted" }, "(empty)")),
            followsNow ? h("div", { class: "pv-note small text-amber" }, `@${rec.target} follows you now: ScoreX only replies to accounts that don't. Skip this one.`) : null,
            h("div", { class: "li-actions" },
              btn("Approve", (e) => quick(rec, "approve", e.currentTarget), { kind: "primary", size: "xs", iconName: "check", disabled: followsNow, title: followsNow ? "This account follows you now" : "Approve this text as is" }),
              btn("Skip", (e) => quick(rec, "skip", e.currentTarget), { size: "xs", kind: "ghost", title: "Do not post anything for this post" }),
              h("span", { class: "spacer" }),
              h("a", { href: "#review", class: "small" }, "Edit")))));
      }
      const more = pending.length - 3;
      pvFoot.textContent = [more > 0 ? `${more} more in the queue.` : "", waitTxt].filter(Boolean).join(" ");
      pvFoot.hidden = !pvFoot.textContent;
    }

    // ------------------------------------------------ needs you
    const hiddenNeeds = () => { const m = lsJson(LS_NEEDS), t = now(); return new Set(Object.keys(m).filter((k) => m[k] > t)); };
    const hideNeed = (key) => { const m = lsJson(LS_NEEDS), t = now(); for (const k of Object.keys(m)) if (m[k] <= t) delete m[k]; m[key] = t + DAY; lsSet(LS_NEEDS, JSON.stringify(m)); drawNeeds(); };
    function needRow({ key, ico, kind = "", title, text, actions = [], dismiss = true }) {
      return h("div", { class: "li need", dataset: { need: key } },
        h("span", { class: ["need-ico", kind], "aria-hidden": "true" }, icon(ico)),
        h("div", { class: "li-main" }, h("div", { class: "li-title" }, title), text ? h("div", { class: "small muted need-text" }, text) : null),
        h("div", { class: "need-act" }, actions,
          dismiss ? h("button", { type: "button", class: "btn btn-xs btn-ghost btn-icon need-x", title: "Hide for a day", "aria-label": "Hide for a day", onClick: () => hideNeed(key) }, icon("x")) : null));
    }
    const go = (href, label) => h("a", { href, class: "btn btn-xs" }, label);
    function needs() {
      const s = ctx.settings, st = ctx.status || {}, t = now();
      const rows = [];
      // Replies waiting for you (conversation alerts), else author replies from history.
      const conv = ctx.data[K.conversations];
      const items = (conv && Array.isArray(conv.items) ? conv.items : []).filter((x) => x && !x.done).sort((a, b) => (b.at || 0) - (a.at || 0));
      if (items.length) {
        for (const it of items.slice(0, 3)) {
          const url = safeX(it.authorReplyUrl) || safeX(it.replyUrl);
          rows.push({ key: "conv:" + it.id, ico: "reply", kind: "good", dismiss: false,
            title: [`@${it.target} replied`, it.text ? ": " : "", it.text ? h("span", { class: "need-quote" }, truncate(String(it.text), 140)) : null],
            text: ["Answer it yourself: replies from you count more than any automation.", it.at ? ` · ${fmtAgo(it.at)}` : ""],
            actions: [url ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer", class: "btn btn-xs" }, "Open on X") : null,
              btn("Mark done", (e) => busy(e.currentTarget, async () => {
                const r = await ctx.send("conversationDone", { id: it.id }, { label: "Mark done" });
                if (r) toast(`Reply from @${it.target} marked done`, { action: { label: "Undo", onClick: () => ctx.send("conversationDone", { id: it.id, done: false }, { label: "Undo" }) } });
              }), { size: "xs", kind: "ghost" })] });
        }
        if (items.length > 3) rows.push({ key: "conv:more", ico: "reply", title: `${items.length - 3} more replies waiting for you`, text: "Open them from your X notifications.", dismiss: true, actions: [] });
      } else {
        for (const r of authorReplies(records.filter((x) => (x.postedAt || 0) >= t - 7 * DAY), 2)) {
          const url = safeX(r.replyUrl);
          rows.push({ key: "ar:" + r.id, ico: "reply", kind: "good", title: `@${r.target} replied to your comment`, text: "Answer it yourself: replies from you count more than any automation.",
            actions: url ? [h("a", { href: url, target: "_blank", rel: "noopener noreferrer", class: "btn btn-xs" }, "Open reply")] : [] });
        }
      }
      // X page loads close to the 24 h cap.
      const fp = st.footprint;
      const cap = fp ? num(fp.cap) || num(s.safety.maxPageLoads24h) : 0;
      if (fp && cap > 0 && num(fp.total) >= 0.8 * cap) {
        const full = num(fp.total) >= cap;
        rows.push({ key: "footprint", ico: "eye", kind: full ? "bad" : "warn", title: `X page loads: ${fmtNum(fp.total)} of ${fmtNum(cap)} in 24 h`,
          text: full ? "Page-load budget reached: the engine waits until older loads leave the 24 h window (it never stops)." : "Close to your page-load budget. The engine waits when it reaches it; it never stops.",
          actions: [go("#safety", "Safety")] });
      }
      // Targets close to their give-up day.
      const near = ctx.targetList().map((x) => ({ x, d: followDay(x, s) })).filter((o) => o.d && o.d.left <= 2 && o.x.enabled !== false).sort((a, b) => a.d.left - b.d.left);
      for (const { x, d } of near.slice(0, 2)) {
        const first = x.stats && x.stats.firstCommentAt;
        const removeAt = first ? first + d.of * DAY : null;
        rows.push({ key: "near:" + x.handle, ico: "clock", kind: "warn", title: `@${x.handle} is on day ${d.day} of ${d.of}`,
          text: `${num(x.stats && x.stats.comments)} comment${num(x.stats && x.stats.comments) === 1 ? "" : "s"}, no follow-back yet.${s.follow.autoRemove === false ? " Automatic removal is off." : removeAt ? ` Removed${s.follow.blacklist === false ? "" : " and blacklisted"} on ${fmtDay(removeAt)}.` : ""}`,
          actions: [go(`#targets?h=${encodeURIComponent(x.handle)}`, "Open target")] });
      }
      if (near.length > 2) rows.push({ key: "near:more", ico: "clock", kind: "warn", title: `${near.length - 2} more targets near their give-up day`, text: "", actions: [go("#targets", "Targets")] });
      // New smart-follower candidates.
      const seen = num(lsGet(LS_CAND_SEEN));
      const cands = Object.values(ctx.data[K.candidates] || {}).filter((c) => c && c.smart && (c.foundAt || 0) > Math.max(seen, t - 7 * DAY));
      if (cands.length) {
        const from = [...new Set(cands.flatMap((c) => (c.sources || []).map((x) => (String(x).match(/@([A-Za-z0-9_]{1,15})/) || [])[1]).filter(Boolean)))];
        rows.push({ key: "cand", ico: "discover", title: `${cands.length} new candidate${cands.length === 1 ? "" : "s"}`,
          text: from.length ? `From the smart followers of ${from.slice(0, 2).map((x) => "@" + x).join(" and ")}${from.length > 2 ? ` and ${from.length - 2} more` : ""}.` : "Found by the smart-follower search.",
          actions: [h("a", { href: "#discover?view=find", class: "btn btn-xs", onClick: () => lsSet(LS_CAND_SEEN, String(now())) }, "Review")] });
      }
      // Budget.
      const b = budgetStatus(s, ctx.data[K.spend]);
      if (b.reached) rows.push({ key: "budget", ico: "alert", kind: "bad", dismiss: false, title: `Monthly budget reached (${fmtUsd(b.spent)} of ${fmtUsd(b.limit)})`, text: "Generation waits for next month or a higher budget.", actions: [go("#models", "Budget")] });
      else if (b.warn) rows.push({ key: "budget", ico: "alert", kind: "warn", title: `Monthly spend is at ${Math.round(b.pct)}% of your budget`, text: `${fmtUsd(b.spent)} of ${fmtUsd(b.limit)} this month.`, actions: [go("#models", "Budget")] });
      // Setup gaps (the stepper is hidden) and target state.
      const list = ctx.targetList();
      const setupShown = !!setupHost.firstChild;
      if (!setupShown) {
        const open = steps().filter((x) => !x.done && !x.optional);
        if (open.length) rows.push({ key: "setup", ico: "settings", kind: "warn", dismiss: false, title: `Setup: ${open.map((x) => x.label).join(", ")} still open`, text: open[0].hint,
          actions: [btn("Show setup", () => { lsSet(LS_DISMISSED, null); drawSetup(true); drawNeeds(); }, { size: "xs" })] });
      }
      if (list.length && !list.some((x) => x.enabled !== false)) rows.push({ key: "alloff", ico: "targets", kind: "warn", dismiss: false, title: "All targets are turned off", text: "ScoreX has nobody to reply to.", actions: [go("#targets", "Targets")] });
      const fo = st.follow;
      if (fo && st.activeTargetCount === 0 && list.some((x) => x.enabled !== false)) {
        if (fo.checking > 0) rows.push({ key: "checking", ico: "info", title: "Checking who follows you", text: "Replies start once accounts that don't follow you are found.", actions: [go("#targets", "Targets")] });
        else if (fo.follows + fo.followedBack > 0) rows.push({ key: "allfollow", ico: "targets", kind: "warn", title: "Every target already follows you", text: "ScoreX only replies to accounts that don't. Add new targets.", actions: [go("#targets", "Add targets")] });
      }
      // Health warnings (rail footer square).
      const issues = ((ctx.health && ctx.health.issues) || []).filter((x) => x && (x.level === "warn" || x.level === "fail")
        && !(/api key/i.test(x.text) && (setupShown || rows.some((r) => r.key === "setup"))) && !(ctx.state.reachAlert && /reaching/i.test(x.text)));
      for (const is of issues.slice(0, issues.length > 3 ? 2 : 3)) {
        rows.push({ key: "health:" + is.text, ico: "health", kind: is.level === "fail" ? "bad" : "warn", title: is.text, text: "", actions: is.href ? [go(is.href, "Open")] : [] });
      }
      if (issues.length > 3) rows.push({ key: "health:more", ico: "health", kind: "warn", title: `${issues.length - 2} more health warnings`, text: "", actions: [go("#diagnostics", "Diagnostics")] });
      const hidden = hiddenNeeds();
      return rows.filter((r) => !(r.dismiss !== false && hidden.has(r.key)));
    }
    function drawNeeds() {
      const rows = needs();
      needsCount.textContent = String(rows.length);
      const sig = JSON.stringify(rows.map((r) => [r.key, r.kind, typeof r.title === "string" ? r.title : r.key, typeof r.text === "string" ? r.text : ""]));
      if (sigs.get(needsHost) === sig) return;
      if (needsHost.contains(document.activeElement) && document.activeElement.classList.contains("is-busy")) return;
      sigs.set(needsHost, sig);
      fill(needsHost, rows.length ? rows.map(needRow) : h("p", { class: "muted small empty-line" }, "Nothing needs you right now."));
    }

    // ------------------------------------------------ activity log
    function drawLogs(force) {
      const debug = !!(ctx.settings.advanced && ctx.settings.advanced.debug);
      const all = (Array.isArray(ctx.data[K.logs]) ? ctx.data[K.logs] : []).filter((e) => e && (debug || e.level !== "debug"));
      const list = all.slice().reverse().slice(0, showAllLogs ? 400 : 6);
      logBtn.hidden = all.length <= 6;
      const sig = JSON.stringify([debug, showAllLogs, list.length, list[0] && list[0].ts, all.length]);
      if (!force && sigs.get(logBody) === sig) return;
      sigs.set(logBody, sig);
      logBody.classList.toggle("is-all", showAllLogs);
      if (!list.length) { fill(logBody, h("p", { class: "muted small empty-line" }, "No activity yet. The engine's steps show up here once it runs.")); return; }
      fill(logBody, list.map((e) => {
        const lvl = ["error", "warn", "info", "debug"].includes(e.level) ? e.level : "info";
        return h("div", { class: ["log", "log-" + lvl] },
          h("time", { class: "log-time", title: fmtDateTime(e.ts) }, fmtTime(e.ts)),
          h("span", { class: "log-node", "aria-hidden": "true" }),
          h("span", { class: "log-msg" },
            lvl === "warn" || lvl === "error" ? h("span", { class: "sr-only" }, lvl + ": ") : null,
            debug ? String(e.msg || "") : humanLog(e.msg),
            debug && e.data ? h("span", { class: "log-data" }, " " + truncate(typeof e.data === "string" ? e.data : JSON.stringify(e.data), 240)) : null));
      }));
    }

    // ------------------------------------------------ data
    async function loadHistory() {
      try { records = await history.since(now() - 31 * DAY); } catch (_) { records = []; }
      rhythmChart.redraw();
      drawNeeds();
    }
    async function loadPending() {
      try {
        const [p, a, q] = await Promise.all([HS.PENDING_REVIEW, HS.APPROVED, HS.QUEUED].map((x) => history.byStatus(x)));
        pending = p.sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
        approved = [...a, ...q];
      } catch (_) { pending = []; approved = []; }
      drawPreview();
    }
    const reloadSoon = debounce(() => { loadHistory(); loadPending(); }, 1500);

    const drawLive = () => { drawReach(); drawEngine(); drawRhythm(); drawFollowLine(); drawSetup(); drawPreview(); drawNeeds(); };
    drawReach(); drawEngine(true); drawRhythm(); drawSetup(true); drawWeek(); drawLogs(true);
    await Promise.all([loadHistory(), loadPending()]);

    ctx.on("status", drawLive);
    ctx.on(K.state, () => { drawLive(); rhythmChart.redraw(); });
    ctx.on("settings", () => { drawEngine(true); drawRhythm(); drawSetup(); drawWeek(); drawPreview(); drawNeeds(); drawLogs(true); rhythmChart.redraw(); });
    ctx.on("counts", () => { loadPending(); reloadSoon(); });
    ctx.on(K.spend, () => { drawRhythm(); drawWeek(); drawNeeds(); });
    ctx.on(K.targets, () => { drawSetup(); drawWeek(); drawPreview(); drawNeeds(); });
    ctx.on(K.blacklist, drawWeek);
    ctx.on(K.scoreboard, drawWeek);
    ctx.on(K.candidates, drawNeeds);
    ctx.on(K.conversations, drawNeeds);
    ctx.on("health", drawNeeds);
    ctx.on(K.logs, () => { drawLogs(); reloadSoon(); });
    ctx.on("tick", () => { drawEngine(); drawPreview(); rhythmChart.redraw(); });
    ctx.on("secrets", async () => { await loadKey(); drawSetup(); drawNeeds(); });
  },
};
