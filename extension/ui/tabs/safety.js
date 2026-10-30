// Safety tab. Essentials: daily ramp, gap between comments, active hours + time zone, like-before-reply,
// skip-rule toggles. Advanced: breaks, per-group / per-target caps, typing and reading speed, failure limit,
// keyword lists, bringing the X tab to the front. Plus the read-only list of auto-stop triggers.
// Every value is clamped by sanitizeSettings.

import { K, HARD, STOP_LABEL } from "../../lib/constants.js";
import { DEFAULT_POLITICAL_KEYWORDS } from "../../lib/store.js";
import { dailyLimit, generationLimit, rampStage, activeHours } from "../../lib/safety.js";
import { h, section, sub, advanced, fmtTime, fmtIn, fill } from "../components.js";

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
  hint: "How fast and when ScoreX may act. Hard caps always apply on top.",
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
    const pair = (label, a, b, unit, extra = {}) => h("div", { class: "range-field" },
      h("div", { class: "field-label" }, label),
      h("div", { class: "range-inputs" },
        f({ path: a, type: "number", ariaLabel: `${label} (from)`, cls: "field-tight", ...extra }),
        h("span", { class: "muted" }, "to"),
        f({ path: b, type: "number", ariaLabel: `${label} (to)`, cls: "field-tight", ...extra }),
        h("span", { class: "muted small" }, unit)));

    // ------------------------------------------------ live limits line
    const statusHost = h("div", { class: "limits-line", id: "safetyStatus" });
    function drawStatus() {
      const s = ctx.settings, state = ctx.state;
      const stage = rampStage(state);
      const ah = (() => { try { return activeHours(s); } catch (_) { return null; } })();
      fill(statusHost,
        h("span", null, "Today: ", h("strong", null, `${dailyLimit(s, state)} comments`), ` (ramp week ${stage + 1}${stage >= 2 ? "+" : ""})`),
        h("span", null, "Up to ", h("strong", null, String(generationLimit(s, state))), " generations"),
        h("span", null, "Hard cap ", h("strong", null, `${HARD.dailyComments}/day`)),
        h("span", null, "Active hours: ", h("strong", null, s.safety.activeHours.enabled ? `${s.safety.activeHours.start}-${s.safety.activeHours.end}` : "all day"),
          ah ? (ah.inside ? (ah.closesAt ? ` · open, closes ${fmtTime(ah.closesAt)}` : " · open now") : ` · closed, opens ${fmtTime(ah.opensAt)} (${fmtIn(ah.opensAt)})`) : ""));
    }

    const tzOptions = timeZones(ctx.settings.timezone);

    root.append(statusHost);
    root.append(
      section({ title: "Daily ramp", hint: `Start slow on a main account. Values above ${HARD.dailyComments} are lowered to ${HARD.dailyComments}.` },
        h("div", { class: "form-row" },
          f({ path: "safety.ramp.0", type: "number", label: "Week 1", min: 0, max: HARD.dailyComments, suffix: "/day" }),
          f({ path: "safety.ramp.1", type: "number", label: "Week 2", min: 0, max: HARD.dailyComments, suffix: "/day" }),
          f({ path: "safety.ramp.2", type: "number", label: "Week 3+", min: 0, max: HARD.dailyComments, suffix: "/day" }))),
      section({ title: "Gap between comments", hint: `A random gap each time, never below ${HARD.minGapMin} minutes.` },
        range("Gap between comments", "safety.gapMin", { min: HARD.minGapMin, max: 240, unit: "minutes" })),
      section({ title: "Active hours", hint: "ScoreX sleeps outside this window." },
        f({ path: "safety.activeHours.enabled", type: "toggle", label: "Only work inside active hours" }),
        h("div", { class: "form-row" },
          f({ path: "safety.activeHours.start", type: "time", label: "Start" }),
          f({ path: "safety.activeHours.end", type: "time", label: "End", hint: "00:00 = midnight" }),
          f({ path: "timezone", type: "select", label: "Time zone", options: tzOptions }))),
      section({ title: "Like before replying", hint: "Likes the post first, like a person would." },
        h("div", { class: "form-row" },
          f({ path: "safety.like.enabled", type: "toggle", label: "Like the post, then reply" }),
          f({ path: "safety.like.dailyLimit", type: "number", label: "Likes per day", min: 0, max: HARD.dailyLikes, hint: `Cap ${HARD.dailyLikes}` }))),
      section({ title: "Skip rules", hint: "Posts ScoreX never replies to." },
        h("div", { class: "toggle-grid" },
          f({ path: "safety.skip.ads", type: "toggle", label: "Ads / promoted posts" }),
          f({ path: "safety.skip.linkOnly", type: "toggle", label: "Link-only posts" }),
          f({ path: "safety.skip.political", type: "toggle", label: "Political / controversial" }),
          f({ path: "safety.skip.giveaways", type: "toggle", label: "Giveaways / engagement bait" }),
          f({ path: "safety.skip.gm", type: "toggle", label: "\"gm\" / \"gn\" posts" }))),

      advanced({ key: "safety.advanced", desc: "Breaks, group and per-account caps, typing and reading speed, failure limit, keyword lists, tab focus" },
        section({ title: "Long breaks", hint: "Pauses after a few comments, like a person stepping away." },
          f({ path: "safety.breaks.enabled", type: "toggle", label: "Take long breaks" }),
          h("div", { class: "form-row" },
            pair("After every", "safety.breaks.afterMin", "safety.breaks.afterMax", "comments", { min: 1, max: 50 }),
            pair("Break length", "safety.breaks.minutesMin", "safety.breaks.minutesMax", "minutes", { min: 5, max: 480 }))),
        section({ title: "Caps per group and account", hint: "Spread replies so no one sees too many." },
          sub("Per group",
            h("div", { class: "form-row" },
              f({ path: "groups.A.enabled", type: "toggle", label: "Group A on" }),
              f({ path: "groups.A.dailyLimit", type: "number", label: "Group A max/day", min: 0, max: HARD.dailyComments }),
              f({ path: "groups.B.enabled", type: "toggle", label: "Group B on" }),
              f({ path: "groups.B.dailyLimit", type: "number", label: "Group B max/day", min: 0, max: HARD.dailyComments }))),
          sub("Per account",
            h("div", { class: "form-row" },
              f({ path: "safety.perTargetDay", type: "number", label: "Per account / day", min: 0, max: HARD.perTargetDay, hint: `Cap ${HARD.perTargetDay}` }),
              f({ path: "safety.perTargetWeek", type: "number", label: "Per account / week", min: 0, max: HARD.perTargetWeek, hint: `Cap ${HARD.perTargetWeek}` }),
              f({ path: "safety.generationFactor", type: "number", label: "Generation factor", min: 1, max: 5, step: 0.5, hint: "Generations/day = limit x this" })))),
        section({ title: "Human-like timing", hint: "How the X tab reads and types." },
          h("div", { class: "form-row" },
            range("Typing speed", "safety.typingCpm", { min: 60, max: 600, step: 10, unit: "chars/min" }),
            range("Read the post first", "safety.readDelaySec", { min: 1, max: 120, unit: "seconds" }))),
        section({ title: "Failures and tab focus" },
          h("div", { class: "form-row" },
            f({ path: "safety.maxConsecutiveFailures", type: "number", label: "Stop after N failed posts in a row", min: 1, max: HARD.maxPostFailures, hint: `Cap ${HARD.maxPostFailures}` })),
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
          h("p", { class: "muted small" }, "After a stop: open X in a normal tab, check the account, wait a while, then press \"I checked my account - resume\" on the Dashboard."))));

    drawStatus();
    ctx.on("settings", drawStatus);
    ctx.on(K.state, drawStatus);
    ctx.on("tick", drawStatus);
  },
};
