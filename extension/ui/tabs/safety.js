// Safety tab. Top: the reach alert (if any), the risk estimate (status.risk: level, score, factors, hours to the daily
// limit) and the Safety profile switch (Careful / Standard / Max / Custom: writes ramp, accounts per day, per account,
// gaps and breaks in one save) with a summary line and a preview strip of a typical day. Then the existing fields:
// daily limits (ramp), gaps, active hours, like-before-reply, skip rules; X page loads in 24 h (status.footprint +
// safety.maxPageLoads24h); the reply reach monitor (safety.reach). Advanced: breaks, weekly cap, timing, failures,
// keyword lists, adaptive watch cadence (safety.adaptiveWatch); the auto-stop triggers.
// Every value is clamped by sanitizeSettings.

import { K, HARD, STOP_LABEL } from "../../lib/constants.js";
import { DEFAULT_POLITICAL_KEYWORDS } from "../../lib/store.js";
import { dailyLimit, generationLimit, rampStage, activeHours, activeHoursPerDay } from "../../lib/safety.js";
import { parseHHMM, num } from "../../lib/util.js";
import { h, section, advanced, btn, busy, toast, fmtTime, fmtIn, fmtAgo, fmtDateTime, fmtNum, fill, clear, segmented, safetyBanner, statusSquare, announce } from "../components.js";
import { responsive, miniBars, svgEl } from "../charts.js";

export function timeZones(current) {
  let list = [];
  try { if (typeof Intl.supportedValuesOf === "function") list = Intl.supportedValuesOf("timeZone"); } catch (_) { list = []; }
  if (!list.length) list = ["UTC", "Asia/Dhaka", "Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Tokyo", "Europe/London", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Los_Angeles", "Australia/Sydney"];
  const set = new Set(list);
  for (const z of ["UTC", "Asia/Dhaka", current]) if (z && !set.has(z)) { set.add(z); }
  return [...set].sort().map((z) => [z, z.replace(/_/g, " ")]);
}

const TRIGGERS = [
  ["captcha", "Captcha or human verification on X"],
  ["unusual_activity", "\"Unusual activity\" / automation warning from X"],
  ["rate_limit", "X rate limit reached"],
  ["account_locked", "Account locked or restricted"],
  ["logged_out", "Logged out of X, or logged into a different account"],
  ["account_unknown", "The logged-in account could not be verified several times in a row (only with \"Stop when errors repeat\" on)"],
  ["unknown_prompt", "X shows a prompt or notice ScoreX does not know (it never clicks it)"],
  ["repeated_post_failures", "Repeated posting failures (only with \"Stop when errors repeat\" on)"],
  ["dom_changed", "X page changed (selectors no longer match; only with \"Stop when errors repeat\" on)"],
  ["reach_drop", "Your replies' views fall sharply (only when the reach monitor is set to stop)"],
  ["openai_auth", "OpenAI key rejected or quota / billing problem"],
  ["budget_reached", "Monthly OpenAI budget reached"],
];

// Safety profiles: one click fills ramp, accounts per day, comments per account, gaps and breaks. Max = the defaults.
export const SAFETY_PROFILES = {
  careful: { label: "Careful", desc: "A slow start: 20, 40, then 60 a day, 1 per account, long gaps and breaks.", ramp: [20, 40, 60], accountsPerDay: 40, perTargetDay: 1, gapMin: { min: 6, max: 15 }, breaks: { enabled: true, afterMin: 4, afterMax: 8, minutesMin: 20, minutesMax: 45 } },
  standard: { label: "Standard", desc: "60, 90, then 120 a day, 2 per account, medium gaps.", ramp: [60, 90, 120], accountsPerDay: 70, perTargetDay: 2, gapMin: { min: 3, max: 8 }, breaks: { enabled: true, afterMin: 8, afterMax: 12, minutesMin: 10, minutesMax: 25 } },
  max: { label: "Max", desc: "The defaults: 200 a day from day one, 2 per account, 100 accounts, gaps of 2-6 min.", ramp: [200, 200, 200], accountsPerDay: 100, perTargetDay: 2, gapMin: { min: 2, max: 6 }, breaks: { enabled: true, afterMin: 10, afterMax: 15, minutesMin: 8, minutesMax: 15 } },
};
export function profileOf(sf) {
  for (const [k, p] of Object.entries(SAFETY_PROFILES)) {
    const b = sf.breaks || {};
    if (p.ramp.every((v, i) => num(sf.ramp && sf.ramp[i]) === v) && num(sf.accountsPerDay) === p.accountsPerDay && num(sf.perTargetDay) === p.perTargetDay
      && num(sf.gapMin && sf.gapMin.min) === p.gapMin.min && num(sf.gapMin && sf.gapMin.max) === p.gapMin.max
      && !!b.enabled === p.breaks.enabled && num(b.afterMin) === p.breaks.afterMin && num(b.afterMax) === p.breaks.afterMax
      && num(b.minutesMin) === p.breaks.minutesMin && num(b.minutesMax) === p.breaks.minutesMax) return k;
  }
  return "custom";
}
// Rough daily throughput: the current limit, the time the gaps and breaks allow inside active hours, accounts x per account.
export function throughput(s, state) {
  const sf = s.safety;
  const limit = dailyLimit(s, state);
  const gapAvg = (num(sf.gapMin.min) + num(sf.gapMin.max)) / 2;
  const b = sf.breaks || {};
  const every = b.enabled ? (num(b.afterMin) + num(b.afterMax)) / 2 : 0;
  const breakLen = b.enabled ? (num(b.minutesMin) + num(b.minutesMax)) / 2 : 0;
  const perComment = gapAvg + (every ? breakLen / every : 0) + 1; // + about a minute to read, like and type
  const hours = activeHoursPerDay(s);
  const capacity = Math.floor((hours * 60) / Math.max(1, perComment));
  const accountsCap = num(sf.accountsPerDay) * num(sf.perTargetDay);
  return { perDay: Math.max(0, Math.min(limit, capacity, accountsCap)), limit, capacity, accountsCap, hours, gapAvg, every, breakLen };
}

const PURPOSES = [
  ["watch", "Watching posts"], ["post", "Posting"], ["profile", "Profiles"], ["follow", "Follow checks"], ["check", "Reply checks"],
  ["mentions", "Mentions"], ["discovery", "Discovery"], ["scores", "Score pages"], ["diagnostics", "Diagnostics"], ["other", "Other"],
];
const REACH_ACTIONS = [
  ["notify", "Only tell me (banner and notification)"],
  ["review", "Switch to Review mode, so I approve every reply"],
  ["halve", "Halve the daily limit until I dismiss the alert"],
  ["stop", "Stop the engine (safety stop)"],
];

export default {
  id: "safety",
  title: "Safety",
  hint: "How fast and when ScoreX may act. Hard caps always apply on top.",
  async render(root, ctx) {
    const f = (spec) => ctx.field(spec);
    const range = (label, base, opts = {}) => {
      const { hint, unit, ...rest } = opts;
      return h("div", { class: "range-field" },
        h("div", { class: "field-label" }, label),
        h("div", { class: "range-inputs" },
          f({ path: base + ".min", type: "number", ariaLabel: label + " minimum", cls: "field-tight", ...rest }),
          h("span", { class: "muted" }, "to"),
          f({ path: base + ".max", type: "number", ariaLabel: label + " maximum", cls: "field-tight", ...rest }),
          unit ? h("span", { class: "muted small" }, unit) : null),
        hint ? h("div", { class: "field-hint" }, hint) : null);
    };
    const pair = (label, a, b, unit, extra = {}) => h("div", { class: "range-field" },
      h("div", { class: "field-label" }, label),
      h("div", { class: "range-inputs" },
        f({ path: a, type: "number", ariaLabel: `${label} (from)`, cls: "field-tight", ...extra }),
        h("span", { class: "muted" }, "to"),
        f({ path: b, type: "number", ariaLabel: `${label} (to)`, cls: "field-tight", ...extra }),
        h("span", { class: "muted small" }, unit)));

    // ------------------------------------------------ reach alert (state.reachAlert) + risk estimate (status.risk)
    const reachHost = h("div", { id: "safetyReachHost" });
    let reachSig = null;
    function drawReachAlert() {
      const a = ctx.state.reachAlert;
      const sig = JSON.stringify(a || null);
      if (sig === reachSig) return;
      reachSig = sig;
      clear(reachHost);
      if (!a) return;
      const nums = [];
      if (a.medianNow != null) nums.push(`median ${fmtNum(a.medianNow)} views per reply${a.medianBefore != null ? ` (was ${fmtNum(a.medianBefore)})` : ""}`);
      if (a.lowShare != null) nums.push(`${Math.round(num(a.lowShare) * 100)}% of ${a.checked != null ? fmtNum(a.checked) + " " : ""}checked replies got very few views`);
      const did = { review: "ScoreX switched to Review mode.", halve: "ScoreX halved its pace.", stop: "ScoreX stopped.", notify: "" }[a.action] || "";
      reachHost.appendChild(safetyBanner({
        id: "safetyReachBanner", cls: "reach-banner",
        title: "Your replies are reaching far fewer people than last week",
        detail: [a.message ? h("div", null, String(a.message)) : null, nums.length ? h("div", { class: "mono-nums" }, nums.join(" · ")) : null, did ? h("div", null, did) : null,
          h("div", { class: "reach-caveat" }, "Views are a proxy - X does not tell you when it hides a reply.")],
        time: a.at ? `${fmtDateTime(a.at)} (${fmtAgo(a.at)})` : "",
        actions: [
          btn("Reach settings", () => { const el = document.getElementById("reachMonitor"); if (el) { el.scrollIntoView({ block: "start" }); const c = el.querySelector("input, select"); if (c) c.focus({ preventScroll: true }); } }, { kind: "light", size: "sm" }),
          btn("Dismiss", (e) => busy(e.currentTarget, async () => { const r = await ctx.send("reachDismiss", {}, { label: "Dismiss" }); if (r) { toast("Reach alert dismissed"); ctx.refreshStatus(); } }),
            { kind: "ghost-light", size: "sm", id: "safetyReachDismissBtn", title: "Hide this alert (the monitor keeps watching)" }),
        ],
      }));
    }

    const riskHost = h("div", { class: "risk-report", id: "riskReport", "aria-live": "polite" });
    let riskSig = null;
    function drawRisk() {
      const r = ctx.status && ctx.status.risk;
      const sig = JSON.stringify(r || null);
      if (sig === riskSig) return;
      riskSig = sig;
      if (!r || !r.level) {
        fill(riskHost, h("div", { class: "risk-cell" }, h("div", { class: "cap" }, "Risk estimate"), h("div", { class: "risk-level" }, "-")),
          h("div", { class: "risk-cell risk-factors" }, h("p", { class: "muted small" }, "The estimate appears when the engine reports its status.")));
        return;
      }
      const lvl = ["low", "medium", "high"].includes(r.level) ? r.level : "medium";
      const sq = { low: "green", medium: "amber", high: "red" }[lvl];
      const factors = Array.isArray(r.factors) ? r.factors : [];
      const hrs = r.hoursToLimit;
      // The limit is per 24 h, so a pace that needs more than a day never reaches it: say so instead of "~199 h".
      const hoursText = hrs == null || !Number.isFinite(Number(hrs)) ? "-" : Number(hrs) <= 0 ? "reached" : Number(hrs) >= 24 ? "not today" : Number(hrs) < 1 ? `~${Math.max(1, Math.round(Number(hrs) * 60))} min` : `~${Number(hrs).toFixed(Number(hrs) < 10 ? 1 : 0)} h`;
      fill(riskHost,
        h("div", { class: "risk-cell" },
          h("div", { class: "cap" }, "Risk estimate"),
          h("div", { class: ["risk-level", "risk-" + lvl] }, statusSquare(sq, lvl.charAt(0).toUpperCase() + lvl.slice(1)), h("span", { class: "risk-score" }, Number.isFinite(Number(r.score)) ? `${Math.round(Number(r.score))} / 100` : "")),
          h("div", { class: "muted small" }, "An estimate, not a guarantee.")),
        h("div", { class: "risk-cell risk-factors" },
          h("div", { class: "cap" }, factors.length ? "What raises it" : "Nothing raises it right now"),
          factors.length ? h("ul", { class: "risk-list" }, factors.map((x) => h("li", null,
            h("span", { class: "rf-label" }, String(x.label || x.id || "")),
            x.detail ? h("span", { class: "rf-detail" }, String(x.detail)) : null,
            x.points != null ? h("span", { class: "rf-pts" }, `+${Math.round(num(x.points))}`) : null))) : h("p", { class: "muted small" }, "Your limits, pace and X's recent reactions look calm.")),
        h("div", { class: "risk-cell" },
          h("div", { class: "cap" }, "Daily limit reached in"),
          h("div", { class: "risk-level mono-nums" }, hoursText),
          h("div", { class: "muted small" }, hrs != null && Number(hrs) > 0 ? "at today's pace" : hrs != null ? "for the last 24 hours" : "no pace yet")));
    }

    // ------------------------------------------------ safety profile switch + summary + typical-day preview
    const profileSeg = segmented([["careful", "Careful"], ["standard", "Standard"], ["max", "Max"], ["custom", "Custom", false, "Your own numbers: edit any field below"]], profileOf(ctx.settings.safety), (v) => {
      if (v === "custom") {
        const el = document.getElementById("dailyLimits");
        if (el) { el.scrollIntoView({ block: "start" }); const inp = el.querySelector("input"); if (inp) inp.focus({ preventScroll: true }); }
        drawProfile();
        return;
      }
      const p = SAFETY_PROFILES[v];
      ctx.save((d) => {
        d.safety.ramp = [...p.ramp];
        d.safety.accountsPerDay = p.accountsPerDay;
        d.safety.perTargetDay = p.perTargetDay;
        d.safety.gapMin = { ...p.gapMin };
        d.safety.breaks = { ...d.safety.breaks, ...p.breaks };
      }).then((saved) => { if (saved) { toast(`Safety profile: ${p.label}`, { type: "success" }); announce(`Safety profile set to ${p.label}.`); } });
    }, { label: "Safety profile", cls: "seg-lg" });
    profileSeg.id = "safetyProfile";
    const profileDesc = h("p", { class: "muted small", id: "profileDesc" });
    const profileSummary = h("p", { class: "profile-summary", id: "profileSummary" });
    const preview = responsive((w) => previewStrip(w), { initialWidth: 720, cls: "profile-rhythm", label: "Typical day" });
    preview.id = "profileRhythm";
    const previewCaption = h("div", { class: "legend profile-legend" },
      h("span", null, h("i", { class: "key key-signal-wash", "aria-hidden": "true" }), "active hours"),
      h("span", null, h("i", { class: "key key-ink", "aria-hidden": "true" }), "expected replies"),
      h("span", null, h("i", { class: "key key-break", "aria-hidden": "true" }), "breaks"));

    function previewStrip(w) {
      const s = ctx.settings, est = throughput(s, ctx.state);
      const ah = s.safety.activeHours, b = s.safety.breaks || {};
      const H = 46, ty = 12, th = H - 30, X = (m) => (m / 1440) * w;
      const start = ah.enabled ? (parseHHMM(ah.start) ?? 0) : 0;
      const endM = ah.enabled ? (parseHHMM(ah.end) ?? 0) : 0;
      const dur = ah.enabled ? (((endM - start + 1440) % 1440) || 1440) : 1440;
      const spans = (a, len) => { const out = []; let x = a % 1440, left = len; while (left > 0) { const seg = Math.min(left, 1440 - x); out.push([x, x + seg]); left -= seg; x = 0; } return out; };
      const ticks = [], breaks = [];
      const every = b.enabled ? Math.max(1, Math.round(est.every)) : Infinity;
      for (let t = Math.min(15, dur / 4), n = 0; t < dur && n < est.perDay;) {
        ticks.push((start + t) % 1440); n++;
        if (n % every === 0) { breaks.push([start + t + 1, est.breakLen]); t += est.breakLen; }
        t += est.gapAvg + 1;
      }
      const label = `Typical day: up to about ${est.perDay} replies${ah.enabled ? ` between ${ah.start} and ${ah.end}` : " around the clock"}${b.enabled ? `, a ${Math.round(b.minutesMin)}-${Math.round(b.minutesMax)} min break every ${b.afterMin}-${b.afterMax} replies` : ""}.`;
      const svg = svgEl("svg", { class: "chart rhythm", viewBox: `0 0 ${w} ${H}`, width: w, height: H, role: "img", "aria-label": label });
      svg.appendChild(svgEl("rect", { x: 0.5, y: ty, width: w - 1, height: th, class: "track" }));
      for (const [a, z] of spans(start, dur)) svg.appendChild(svgEl("rect", { x: X(a).toFixed(1), y: ty, width: Math.max(1, X(z) - X(a)).toFixed(1), height: th, class: "band-active" }));
      for (const [a, len] of breaks) for (const [x1, x2] of spans(a, len)) svg.appendChild(svgEl("rect", { x: X(x1).toFixed(1), y: ty + 2, width: Math.max(2, X(x2) - X(x1)).toFixed(1), height: th - 4, class: "break" }));
      for (const m of ticks) svg.appendChild(svgEl("rect", { x: (X(m) - 0.5).toFixed(1), y: ty - 3, width: 1, height: th + 6, class: "mark-ink" }));
      [[0, "00:00"], [360, "06:00"], [720, "12:00"], [1080, "18:00"], [1440, "24:00"]].forEach(([m, t]) =>
        svg.appendChild(svgEl("text", { x: X(m).toFixed(1), y: H - 2, class: "axis", "text-anchor": m === 0 ? "start" : m === 1440 ? "end" : "middle" }, t)));
      return svg;
    }
    function drawProfile() {
      const s = ctx.settings, sf = s.safety;
      const p = profileOf(sf);
      profileSeg.set(p);
      profileDesc.textContent = p === "custom" ? "Your own numbers. Pick a profile to fill them in again (any field you change below switches back to Custom)." : SAFETY_PROFILES[p].desc;
      const est = throughput(s, ctx.state);
      const b = sf.breaks || {};
      fill(profileSummary,
        "≈ ", h("strong", null, `${est.perDay} comments/day`),
        ` · gaps ${sf.gapMin.min}-${sf.gapMin.max} min`,
        b.enabled ? ` · breaks of ${b.minutesMin}-${b.minutesMax} min every ${b.afterMin}-${b.afterMax} comments` : " · no long breaks",
        ` · ${sf.perTargetDay} per account, up to ${sf.accountsPerDay} accounts`,
        ` · ${est.hours >= 24 ? "around the clock" : `${est.hours} h of active hours`}`);
      profileSummary.title = `Daily limit this week ${est.limit}; the gaps and breaks allow about ${est.capacity}; accounts x per account allow ${est.accountsCap}. Real numbers depend on how often your targets post.`;
      preview.redraw();
    }

    // ------------------------------------------------ live limits line
    const statusHost = h("div", { class: "limits-line", id: "safetyStatus" });
    const rampTag = h("span", { class: "tag", id: "rampTag" });
    function drawStatus() {
      const s = ctx.settings, state = ctx.state;
      const stage = rampStage(state);
      const ah = (() => { try { return activeHours(s); } catch (_) { return null; } })();
      fill(statusHost,
        h("span", null, "Today: ", h("strong", null, `${dailyLimit(s, state)} comments`), ` (week ${stage + 1}${stage >= 2 ? "+" : ""})`, ` · ${s.safety.accountsPerDay} accounts · ${s.safety.perTargetDay} per account`),
        h("span", null, "Up to ", h("strong", null, String(generationLimit(s, state))), " generations"),
        h("span", null, "Hard cap ", h("strong", null, `${HARD.dailyComments}/day`)),
        h("span", null, "Active hours: ", h("strong", null, s.safety.activeHours.enabled ? `${s.safety.activeHours.start}-${s.safety.activeHours.end}` : "all day"),
          ah ? (ah.inside ? (ah.closesAt ? ` · open, closes ${fmtTime(ah.closesAt)}` : " · open now") : ` · closed, opens ${fmtTime(ah.opensAt)} (${fmtIn(ah.opensAt)})`) : ""));
      const r = s.safety.ramp;
      const off = r[0] === r[1] && r[1] === r[2];
      rampTag.textContent = off ? "Ramp off" : `Ramp ${r[0]} → ${r[1]} → ${r[2]}`;
      rampTag.title = off ? "All weeks use the same limit" : "The limit grows each week from the first start";
    }

    // ------------------------------------------------ X page loads (status.footprint)
    const fpHost = h("div", { class: "fp", id: "footprint" });
    let fpSig = null;
    function drawFootprint() {
      const fp = ctx.status && ctx.status.footprint;
      const cap = num(ctx.settings.safety.maxPageLoads24h);
      const sig = JSON.stringify([fp || null, cap, Math.floor(Date.now() / 600000)]);
      if (sig === fpSig) return;
      fpSig = sig;
      if (!fp || !Array.isArray(fp.hourly)) { fill(fpHost, h("p", { class: "muted small" }, "Page loads: -. The counts appear once the engine has loaded X pages.")); return; }
      const total = num(fp.total), c = num(fp.cap) || cap;
      const pct = c ? Math.min(100, (total / c) * 100) : 0;
      const by = fp.byPurpose || {};
      const now = Date.now();
      fill(fpHost,
        h("div", { class: "fp-total" },
          h("span", { class: "fp-num" }, fmtNum(total)),
          h("span", { class: "muted" }, c ? `of ${fmtNum(c)} page loads allowed in the last 24 h` : "page loads in the last 24 h (no cap)"),
          c ? h("span", { class: ["fp-meter", pct >= 80 && "is-warn"], role: "meter", "aria-valuemin": "0", "aria-valuemax": String(c), "aria-valuenow": String(total), "aria-label": `${total} of ${c} page loads` }, h("i", { style: `width:${pct.toFixed(1)}%` })) : null),
        h("div", { class: "kv-ledger fp-ledger" }, PURPOSES.map(([k, l]) => h("div", { class: num(by[k]) ? "" : "is-zero" }, h("span", { class: "cap" }, l), h("span", { class: "v" }, num(by[k]) ? fmtNum(by[k]) : "0")))),
        h("div", { class: "fp-bars" },
          responsive((w) => miniBars(fp.hourly, { w, h: 36, label: `X page loads per hour over the last 24 hours: ${fp.hourly.join(", ")}`, titles: fp.hourly.map((n, i) => `${fmtTime(now - (23 - i) * 3600000)}: ${n} page loads`) }), { initialWidth: 600 }),
          h("div", { class: "fp-axis" }, h("span", null, "24 h ago"), h("span", null, "now"))));
    }

    // ------------------------------------------------ reach monitor status (status.reach)
    const reachStatus = h("p", { class: "muted small mono-nums", id: "reachStatus" });
    function drawReachStatus() {
      const r = ctx.status && ctx.status.reach;
      const s = ctx.settings;
      if (!r || r.checked == null) { reachStatus.textContent = "No reach data yet: it appears after ScoreX has checked how your recent replies did."; return; }
      const parts = [`${fmtNum(r.checked)} replies checked`];
      if (r.medianViews != null) parts.push(`median ${fmtNum(r.medianViews)} views${r.prevMedianViews != null ? ` (week before: ${fmtNum(r.prevMedianViews)})` : ""}`);
      if (r.lowShare != null) parts.push(`${Math.round(num(r.lowShare) * 100)}% under ${s.safety.reach.lowViews} views`);
      if (r.at) parts.push(`updated ${fmtAgo(r.at)}`);
      reachStatus.textContent = "Now: " + parts.join(" · ");
    }

    // ------------------------------------------------ adaptive watch status (status.watch)
    const watchStatus = h("p", { class: "muted small", id: "watchStatus" });
    function drawWatch() {
      const w = ctx.status && ctx.status.watch;
      if (!w) { watchStatus.textContent = "Now: -"; return; }
      watchStatus.textContent = w.slow
        ? `Now: watching slowly, a check about every ${Math.max(1, Math.round(num(w.intervalSec) / 60))} min (${num(w.emptyStreak)} checks in a row found nothing new).`
        : `Now: normal pace${num(w.emptyStreak) ? ` (${num(w.emptyStreak)} empty checks in a row)` : ""}.`;
    }

    const tzOptions = timeZones(ctx.settings.timezone);
    const errorsNote = h("p", { class: "field-hint", id: "errorsNote" });
    const drawErrorsNote = () => {
      errorsNote.textContent = ctx.settings.safety.stopOnErrors
        ? `On: after ${ctx.settings.safety.maxConsecutiveFailures} failed posts in a row, or when pages keep failing, ScoreX stops and notifies you. Press Resume to continue.`
        : "Off (the default): errors go to the activity log and ScoreX moves on to the next task by itself - no stop, no pop-up. After failed posts in a row it waits a little longer before the next one (5, 10, 20, then 30 minutes).";
    };

    root.append(reachHost,
      riskHost,
      section({ title: "Safety profile", hint: "One click sets the daily limits, accounts per day, comments per account, gaps and breaks. Any change below shows Custom.", id: "profileSec" },
        profileSeg, profileDesc, profileSummary, preview, previewCaption),
      statusHost);
    root.append(
      section({ title: h("span", null, "Daily limits ", rampTag), hint: `Comments per 24 hours (hard cap ${HARD.dailyComments}). Set lower numbers for week 1 and 2 if you want a ramp.`, id: "dailyLimits" },
        h("div", { class: "form-row" },
          f({ path: "safety.ramp.0", type: "number", label: "Week 1", min: 0, max: HARD.dailyComments, suffix: "/day" }),
          f({ path: "safety.ramp.1", type: "number", label: "Week 2", min: 0, max: HARD.dailyComments, suffix: "/day" }),
          f({ path: "safety.ramp.2", type: "number", label: "Week 3+", min: 0, max: HARD.dailyComments, suffix: "/day" })),
        h("div", { class: "form-row" },
          f({ path: "safety.accountsPerDay", type: "number", label: "Different accounts / day", min: 1, max: HARD.accountsPerDay, hint: `Cap ${HARD.accountsPerDay}` }),
          f({ path: "safety.perTargetDay", type: "number", label: "Comments per account / day", min: 0, max: HARD.perTargetDay, hint: `Cap ${HARD.perTargetDay}` }))),
      section({ title: "Gap between comments", hint: `A random gap each time, never below ${HARD.minGapMin} minutes.` },
        range("Gap between comments", "safety.gapMin", { min: HARD.minGapMin, max: 240, unit: "minutes" })),
      section({ title: "Active hours", hint: "Off by default: ScoreX works around the clock. Turn it on to sleep outside this window." },
        f({ path: "safety.activeHours.enabled", type: "toggle", label: "Only work inside active hours" }),
        h("div", { class: "form-row" },
          f({ path: "safety.activeHours.start", type: "time", label: "Start" }),
          f({ path: "safety.activeHours.end", type: "time", label: "End", hint: "00:00 = midnight" }),
          f({ path: "timezone", type: "select", label: "Time zone", options: tzOptions }))),
      section({ title: "Like before replying", hint: "Likes every post right before replying to it. No separate like limit: at most one like per comment." },
        f({ path: "safety.like.enabled", type: "toggle", label: "Like the post, then reply" })),
      section({ title: "Errors", id: "errorsSec", hint: "When something of ScoreX's own fails: a reply that does not go through, a page that does not load, X's page looking different." },
        f({ path: "safety.stopOnErrors", type: "toggle", label: "Stop and notify me when errors repeat", id: "stopOnErrors" }),
        errorsNote,
        h("div", { class: "form-row" },
          f({ path: "safety.maxConsecutiveFailures", type: "number", label: "Stop after N failed posts in a row", min: 1, max: HARD.maxPostFailures, hint: `Used only while the switch above is on. Cap ${HARD.maxPostFailures}` })),
        h("p", { class: "field-hint", id: "errorsAlways" }, "Always stops, whatever this is set to: X's own warnings - a captcha, \"unusual activity\", a rate limit, a locked account, being logged out or into another account, or a prompt ScoreX does not know. Carrying on after those is how accounts get restricted.")),
      section({ title: "Skip rules", hint: "Posts ScoreX never replies to." },
        h("div", { class: "toggle-grid" },
          f({ path: "safety.skip.ads", type: "toggle", label: "Ads / promoted posts" }),
          f({ path: "safety.skip.linkOnly", type: "toggle", label: "Link-only posts" }),
          f({ path: "safety.skip.political", type: "toggle", label: "Political / controversial" }),
          f({ path: "safety.skip.giveaways", type: "toggle", label: "Giveaways / engagement bait" }),
          f({ path: "safety.skip.gm", type: "toggle", label: "\"gm\" / \"gn\" posts" }))),
      section({ title: "X page loads (24 h)", hint: "Every page the X tab opens, by purpose, over the last 24 hours. A cap makes the engine wait; it never stops.", id: "footprintSec" },
        fpHost,
        h("div", { class: "form-row" },
          f({ path: "safety.maxPageLoads24h", type: "number", label: "Max X page loads per 24 h", min: 0, max: 5000, id: "maxPageLoads", hint: "0 = no cap. At the cap the engine waits; it never stops." }))),
      section({ title: "Reply reach monitor", hint: "Watches the views of your checked replies. A sharp drop can mean X shows your replies to fewer people.", id: "reachMonitor" },
        reachStatus,
        f({ path: "safety.reach.enabled", type: "toggle", label: "Watch how many people see my replies", id: "reachEnabled" }),
        h("div", { class: "form-row" },
          h("div", { class: "field field-wide" }, f({ path: "safety.reach.action", type: "select", label: "When reach drops", id: "reachAction", options: REACH_ACTIONS }))),
        h("div", { class: "form-row" },
          f({ path: "safety.reach.minChecked", type: "number", label: "Judge after (checked replies)", min: 5, max: 200, id: "reachMinChecked" }),
          f({ path: "safety.reach.dropPct", type: "number", label: "Alert when median views fall by", min: 20, max: 95, suffix: "%", id: "reachDropPct" }),
          f({ path: "safety.reach.lowViews", type: "number", label: "A reply is low under (views)", min: 1, max: 1000, id: "reachLowViews" }),
          f({ path: "safety.reach.lowShare", type: "percent", label: "…or when ≥ this share is low", min: 10, max: 100, step: 5, suffix: "%", id: "reachLowShare", hint: "Share of checked replies under the views above (50% = half)" })),
        h("p", { class: "field-hint reach-caveat" }, "Views are a proxy - X does not tell you when it hides a reply.")),

      advanced({ key: "safety.advanced", desc: "Breaks, per-account caps, typing and reading speed, keyword lists, tab focus, watch cadence" },
        section({ title: "Long breaks", hint: "Pauses after a few comments, like a person stepping away." },
          f({ path: "safety.breaks.enabled", type: "toggle", label: "Take long breaks" }),
          h("div", { class: "form-row" },
            pair("After every", "safety.breaks.afterMin", "safety.breaks.afterMax", "comments", { min: 1, max: 100 }),
            pair("Break length", "safety.breaks.minutesMin", "safety.breaks.minutesMax", "minutes", { min: 5, max: 480 }))),
        section({ title: "Weekly cap and generation budget", hint: "Spread replies so no one sees too many." },
          h("div", { class: "form-row" },
            f({ path: "safety.perTargetWeek", type: "number", label: "Per account / week", min: 0, max: HARD.perTargetWeek, hint: `Cap ${HARD.perTargetWeek}` }),
            f({ path: "safety.generationFactor", type: "number", label: "Generation factor", min: 1, max: 5, step: 0.5, hint: "Generations/day = limit x this" }))),
        section({ title: "Human-like timing", hint: "How the X tab reads and types." },
          h("div", { class: "form-row" },
            range("Typing speed", "safety.typingCpm", { min: 60, max: 600, step: 10, unit: "chars/min" }),
            range("Read the post first", "safety.readDelaySec", { min: 1, max: 120, unit: "seconds" }))),
        section({ title: "Watch cadence", hint: "Checks for new posts less often while your targets post nothing new, and speeds up again as soon as something new appears.", id: "adaptiveWatch" },
          watchStatus,
          f({ path: "safety.adaptiveWatch.enabled", type: "toggle", label: "Check less often while nothing new appears", id: "adaptiveEnabled" }),
          h("div", { class: "form-row" },
            f({ path: "safety.adaptiveWatch.afterEmpty", type: "number", label: "Slow down after (empty checks)", min: 2, max: 50, id: "adaptiveAfter" }),
            f({ path: "safety.adaptiveWatch.maxIntervalMin", type: "number", label: "Longest wait between checks", min: 5, max: 60, suffix: "min", id: "adaptiveMax" }))),
        section({ title: "Tab focus" },
          f({ path: "safety.bringTabToFront", type: "toggle", label: "Bring the X tab to the front while posting", hint: "More reliable typing in background windows, but it takes focus." })),
        section({ title: "Keyword lists", hint: "Fine-tune the skip rules." },
          h("div", { class: "form-row" },
            f({ path: "safety.skip.minChars", type: "number", label: "Min post length (chars)", min: 0, max: 280 }),
            f({ path: "safety.skip.languages", type: "csv", label: "Only these languages", placeholder: "en, bn (empty = any)" })),
          f({ path: "safety.skip.politicalKeywords", type: "list", label: "Political / controversial keywords", rows: 4, hint: h("span", null, "One per line or comma separated. ", h("button", { type: "button", class: "linkish", onClick: () => ctx.save((d) => { d.safety.skip.politicalKeywords = [...DEFAULT_POLITICAL_KEYWORDS]; }) }, "Restore defaults")) }),
          f({ path: "safety.skip.blockedWords", type: "list", label: "Blocked words", rows: 3, placeholder: "Posts containing any of these are skipped" }))),

      advanced({ key: "safety.triggers", title: "Auto-stop triggers", tag: String(TRIGGERS.length), desc: "What makes ScoreX stop at once. Resume is always manual." },
        section({ title: "Stops immediately on", hint: "Each one stops the engine, sends a desktop notification and shows a red alert." },
          h("ul", { class: "trigger-list" }, TRIGGERS.map(([k, label]) => h("li", null,
            h("span", { class: "trigger-dot", "aria-hidden": "true" }),
            h("div", null, h("span", null, label), STOP_LABEL[k] ? h("span", { class: "muted small" }, `Shown as: ${STOP_LABEL[k]}`) : null)))),
          h("p", { class: "muted small" }, "After a stop: open X in a normal tab, check the account, wait a while, then press \"Review stop…\" at the top and resume."))));

    const drawAll = () => { drawStatus(); drawProfile(); drawFootprint(); drawReachStatus(); drawErrorsNote(); };
    drawAll(); drawRisk(); drawReachAlert(); drawWatch();
    ctx.on("settings", drawAll);
    ctx.on(K.state, () => { drawStatus(); drawReachAlert(); });
    ctx.on("status", () => { drawRisk(); drawFootprint(); drawReachStatus(); drawWatch(); drawReachAlert(); });
    ctx.on("tick", () => { drawStatus(); drawFootprint(); });
    if (!ctx.status) ctx.refreshStatus();
  },
};
