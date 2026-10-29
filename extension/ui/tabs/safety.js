// Safety tab: ramp, pacing, breaks, active hours, per-target caps, likes, human-like timing, skip rules,
// warm-up status and the read-only list of auto-stop triggers. All values are clamped by sanitizeSettings.

import { K, HARD, STOP_LABEL } from "../../lib/constants.js";
import { DEFAULT_POLITICAL_KEYWORDS } from "../../lib/store.js";
import { warmup, dailyLimit, generationLimit, rampStage, activeHours } from "../../lib/safety.js";
import { h, card, progressBar, fmtCountdown, fmtDateTime, fmtTime, fmtIn, sectionTitle, add, fill } from "../components.js";

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
  ["repeated_post_failures", "Repeated posting failures"],
  ["dom_changed", "X page changed (selectors no longer match)"],
  ["openai_auth", "OpenAI key rejected or quota / billing problem"],
  ["budget_reached", "Monthly OpenAI budget reached"],
];

export default {
  id: "safety",
  title: "Safety",
  icon: "safety",
  async render(root, ctx) {
    const f = (spec) => ctx.field(spec);
    const range = (label, base, opts = {}) => {
      const { hint, unit, ...num } = opts;
      return h("div", { class: "range-field" },
        h("div", { class: "field-label" }, label),
        h("div", { class: "range-inputs" },
          f({ path: base + ".min", type: "number", ariaLabel: label + " minimum", cls: "field-tight", ...num }),
          h("span", { class: "muted" }, "to"),
          f({ path: base + ".max", type: "number", ariaLabel: label + " maximum", cls: "field-tight", ...num }),
          unit ? h("span", { class: "muted small" }, unit) : null),
        hint ? h("div", { class: "field-hint" }, hint) : null);
    };

    // ------------------------------------------------ warm-up + limits status
    const statusHost = h("div", { class: "grid-3", id: "safetyStatus" });
    function drawStatus() {
      const s = ctx.settings, state = ctx.state;
      const wu = warmup(state);
      const stage = rampStage(state);
      const limit = dailyLimit(s, state);
      const ah = (() => { try { return activeHours(s); } catch (_) { return null; } })();
      const daysIn = wu.notStarted ? 0 : Math.min(HARD.warmupDays, Math.floor((Date.now() - state.firstStartedAt) / 864e5));
      fill(statusHost, 
        h("div", { class: "stat" },
          h("div", { class: "stat-label" }, "Warm-up"),
          h("div", { class: "stat-value" }, wu.active ? (wu.notStarted ? "Not started" : `Day ${daysIn + 1} of ${HARD.warmupDays}`) : "Complete"),
          h("div", { class: "stat-sub" }, wu.active ? (wu.notStarted ? `Starts with your first Start. Review mode only for ${HARD.warmupDays} days.` : `Full auto unlocks in ${fmtCountdown(wu.msLeft)} (${fmtDateTime(wu.endsAt)}).`) : "Full auto is available."),
          wu.active && !wu.notStarted ? progressBar(100 - (wu.msLeft / (HARD.warmupDays * 864e5)) * 100, { kind: "accent" }) : null),
        h("div", { class: "stat" },
          h("div", { class: "stat-label" }, "Today's limits"),
          h("div", { class: "stat-value" }, `${limit} comments`),
          h("div", { class: "stat-sub" }, `Ramp week ${stage + 1}${stage >= 2 ? "+" : ""} · up to ${generationLimit(s, state)} generations · hard cap ${HARD.dailyComments}/day`)),
        h("div", { class: "stat" },
          h("div", { class: "stat-label" }, "Active hours"),
          h("div", { class: "stat-value" }, s.safety.activeHours.enabled ? `${s.safety.activeHours.start} - ${s.safety.activeHours.end}` : "All day"),
          h("div", { class: "stat-sub" }, ah ? (ah.inside ? (ah.closesAt ? `Open now · closes ${fmtTime(ah.closesAt)} (${fmtIn(ah.closesAt)})` : "Open now") : `Closed now · opens ${fmtTime(ah.opensAt)} (${fmtIn(ah.opensAt)})`) : "", ` · ${s.timezone}`)));
    }

    const tzOptions = timeZones(ctx.settings.timezone);

    add(root, 
      statusHost,
      h("div", { class: "grid-2" },
        card({ title: "Daily comment ramp", subtitle: `Start slow on a main account. Hard cap: ${HARD.dailyComments} comments per day - higher values are lowered to ${HARD.dailyComments}.` },
          h("div", { class: "form-row" },
            f({ path: "safety.ramp.0", type: "number", label: "Week 1", min: 0, max: HARD.dailyComments, suffix: "/day" }),
            f({ path: "safety.ramp.1", type: "number", label: "Week 2", min: 0, max: HARD.dailyComments, suffix: "/day" }),
            f({ path: "safety.ramp.2", type: "number", label: "Week 3+", min: 0, max: HARD.dailyComments, suffix: "/day" })),
          sectionTitle("Per group"),
          h("div", { class: "form-row" },
            f({ path: "groups.A.enabled", type: "toggle", label: "Group A on" }),
            f({ path: "groups.A.dailyLimit", type: "number", label: "Group A max/day", min: 0, max: HARD.dailyComments })),
          h("div", { class: "form-row" },
            f({ path: "groups.B.enabled", type: "toggle", label: "Group B on" }),
            f({ path: "groups.B.dailyLimit", type: "number", label: "Group B max/day", min: 0, max: HARD.dailyComments })),
          sectionTitle("Per target"),
          h("div", { class: "form-row" },
            f({ path: "safety.perTargetDay", type: "number", label: "Per account / day", min: 0, max: HARD.perTargetDay, hint: `Cap ${HARD.perTargetDay}` }),
            f({ path: "safety.perTargetWeek", type: "number", label: "Per account / week", min: 0, max: HARD.perTargetWeek, hint: `Cap ${HARD.perTargetWeek}` }),
            f({ path: "safety.generationFactor", type: "number", label: "Generation factor", min: 1, max: 5, step: 0.5, hint: "Max generations/day = limit x this" }))),
        card({ title: "Pacing", subtitle: "Random, human-looking timing between actions." },
          range("Gap between comments", "safety.gapMin", { min: HARD.minGapMin, max: 240, unit: "minutes", hint: `Random gap each time. Never below ${HARD.minGapMin} minutes.` }),
          sectionTitle("Long breaks"),
          f({ path: "safety.breaks.enabled", type: "toggle", label: "Take long breaks" }),
          h("div", { class: "range-field" },
            h("div", { class: "field-label" }, "After every"),
            h("div", { class: "range-inputs" },
              f({ path: "safety.breaks.afterMin", type: "number", ariaLabel: "Break after at least N comments", min: 1, max: 50, cls: "field-tight" }),
              h("span", { class: "muted" }, "to"),
              f({ path: "safety.breaks.afterMax", type: "number", ariaLabel: "Break after at most M comments", min: 1, max: 50, cls: "field-tight" }),
              h("span", { class: "muted small" }, "comments"))),
          h("div", { class: "range-field" },
            h("div", { class: "field-label" }, "Break length"),
            h("div", { class: "range-inputs" },
              f({ path: "safety.breaks.minutesMin", type: "number", ariaLabel: "Break minimum minutes", min: 5, max: 480, cls: "field-tight" }),
              h("span", { class: "muted" }, "to"),
              f({ path: "safety.breaks.minutesMax", type: "number", ariaLabel: "Break maximum minutes", min: 5, max: 480, cls: "field-tight" }),
              h("span", { class: "muted small" }, "minutes"))),
          sectionTitle("Active hours"),
          f({ path: "safety.activeHours.enabled", type: "toggle", label: "Only work inside active hours" }),
          h("div", { class: "form-row" },
            f({ path: "safety.activeHours.start", type: "time", label: "Start" }),
            f({ path: "safety.activeHours.end", type: "time", label: "End", hint: "00:00 = midnight" }),
            f({ path: "timezone", type: "select", label: "Time zone", options: tzOptions })))),
      h("div", { class: "grid-2" },
        card({ title: "Human-like behaviour", subtitle: "How the worker tab reads, likes and types." },
          f({ path: "safety.like.enabled", type: "toggle", label: "Like the post before commenting" }),
          f({ path: "safety.like.dailyLimit", type: "number", label: "Daily like limit", min: 0, max: HARD.dailyLikes, hint: `Cap ${HARD.dailyLikes}` }),
          range("Typing speed", "safety.typingCpm", { min: 60, max: 600, step: 10, unit: "chars/min" }),
          range("Read the post first", "safety.readDelaySec", { min: 1, max: 120, unit: "seconds" }),
          h("div", { class: "form-row" },
            f({ path: "safety.maxConsecutiveFailures", type: "number", label: "Stop after N failed posts in a row", min: 1, max: HARD.maxPostFailures, hint: `Cap ${HARD.maxPostFailures}` })),
          f({ path: "safety.bringTabToFront", type: "toggle", label: "Bring the X tab to the front while posting", hint: "More reliable typing in background windows, but it takes focus." })),
        card({ title: "Skip rules", subtitle: "Posts that are never commented on." },
          h("div", { class: "toggle-grid" },
            f({ path: "safety.skip.ads", type: "toggle", label: "Ads / promoted posts" }),
            f({ path: "safety.skip.linkOnly", type: "toggle", label: "Link-only posts" }),
            f({ path: "safety.skip.political", type: "toggle", label: "Political / controversial" }),
            f({ path: "safety.skip.giveaways", type: "toggle", label: "Giveaways / engagement bait" }),
            f({ path: "safety.skip.gm", type: "toggle", label: "\"gm\" / \"gn\" spam" })),
          h("div", { class: "form-row" },
            f({ path: "safety.skip.minChars", type: "number", label: "Min post length (chars)", min: 0, max: 280 }),
            f({ path: "safety.skip.languages", type: "csv", label: "Only these languages", placeholder: "en, bn (empty = any)" })),
          f({ path: "safety.skip.politicalKeywords", type: "list", label: "Political / controversial keywords", rows: 4, hint: h("span", null, "One per line or comma separated. ", h("button", { type: "button", class: "linkish", onClick: () => ctx.save((d) => { d.safety.skip.politicalKeywords = [...DEFAULT_POLITICAL_KEYWORDS]; }) }, "Restore defaults")) }),
          f({ path: "safety.skip.blockedWords", type: "list", label: "Blocked words", rows: 3, placeholder: "Posts containing any of these are skipped" }))),
      card({ title: "Auto-stop triggers", subtitle: "Each one stops the engine immediately, sends a desktop notification and shows a red badge. Resume is always manual." },
        h("ul", { class: "trigger-list" }, TRIGGERS.map(([k, label]) => h("li", null,
          h("span", { class: "trigger-dot", "aria-hidden": "true" }),
          h("div", null, h("span", null, label), STOP_LABEL[k] ? h("span", { class: "muted small" }, `Shown as: ${STOP_LABEL[k]}`) : null)))),
        h("p", { class: "muted small" }, "After a stop: open X in a normal tab, check the account (notifications, any warning), wait a while, then press \"I checked my account - resume\" on the Dashboard.")));

    drawStatus();
    ctx.on("settings", drawStatus);
    ctx.on(K.state, drawStatus);
    ctx.on("tick", drawStatus);
  },
};
