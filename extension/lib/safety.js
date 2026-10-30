// ScoreX - safety rules for a main account. Pure functions over (settings, state, counts, ts) so the
// scheduler, the dashboard and the tests all agree on the same numbers.

import { HARD, MODE } from "./constants.js";
import { DAY, MIN, clamp, humanDelay, randInt, inWindow, nextWindowStart, currentWindowEnd, now } from "./util.js";

// ---------- mode ----------

// Review or Full auto, exactly as chosen in the dashboard (no forced warm-up period).
export function effectiveMode(settings) {
  return settings.mode === MODE.AUTO ? MODE.AUTO : MODE.REVIEW;
}

// ---------- daily limits ----------

export function daysSinceStart(state, ts = now()) {
  if (!state.firstStartedAt) return 0;
  return Math.max(0, Math.floor((ts - state.firstStartedAt) / DAY));
}
// Week 1 -> ramp[0], week 2 -> ramp[1], then ramp[2]; always <= HARD.dailyComments.
export function rampStage(state, ts = now()) { return Math.min(2, Math.floor(daysSinceStart(state, ts) / 7)); }
export function dailyLimit(settings, state, ts = now()) {
  return clamp(settings.safety.ramp[rampStage(state, ts)] || 0, 0, HARD.dailyComments);
}
export function groupLimit(settings, group, total) {
  const g = settings.groups[group];
  if (!g || !g.enabled) return 0;
  return Math.min(total, clamp(g.dailyLimit, 0, HARD.dailyComments));
}
export function generationLimit(settings, state, ts = now()) {
  return Math.ceil(dailyLimit(settings, state, ts) * settings.safety.generationFactor);
}
export function likeLimit(settings) { return settings.safety.like.enabled ? clamp(settings.safety.like.dailyLimit, 0, HARD.dailyLikes) : 0; }

// ---------- active hours ----------

export function activeHours(settings, ts = now()) {
  const ah = settings.safety.activeHours;
  if (!ah.enabled) return { inside: true, opensAt: ts, closesAt: null };
  const inside = inWindow(ts, ah.start, ah.end, settings.timezone);
  return {
    inside,
    opensAt: inside ? ts : nextWindowStart(ts, ah.start, ah.end, settings.timezone),
    closesAt: inside ? currentWindowEnd(ts, ah.start, ah.end, settings.timezone) : null,
  };
}

// ---------- pacing ----------

// Random gap before the next comment (minutes range from settings, never below HARD.minGapMin).
export function nextGapMs(settings) {
  const g = settings.safety.gapMin;
  const lo = Math.max(HARD.minGapMin, g.min) * MIN, hi = Math.max(lo, g.max * MIN);
  return humanDelay(lo, hi);
}
export function nextBreakAfter(settings) {
  const b = settings.safety.breaks;
  return randInt(b.afterMin, b.afterMax);
}
export function breakDurationMs(settings) {
  const b = settings.safety.breaks;
  return humanDelay(b.minutesMin * MIN, b.minutesMax * MIN);
}
// After a posted comment: next allowed time and whether a long break starts now.
export function afterPost(settings, state, ts = now()) {
  const gap = nextGapMs(settings);
  const since = (state.commentsSinceBreak || 0) + 1;
  const threshold = state.nextBreakAfter || nextBreakAfter(settings);
  const patch = { lastCommentAt: ts, nextCommentAt: ts + gap, commentsSinceBreak: since, nextBreakAfter: threshold };
  if (settings.safety.breaks.enabled && since >= threshold) {
    const dur = breakDurationMs(settings);
    patch.breakUntil = ts + Math.max(gap, dur);
    patch.nextCommentAt = patch.breakUntil;
    patch.commentsSinceBreak = 0;
    patch.nextBreakAfter = nextBreakAfter(settings);
  }
  return patch;
}

// Random delay until the next watch check.
export function nextCheckMs(settings) {
  const c = settings.watch.checkIntervalSec;
  const lo = Math.max(HARD.minCheckIntervalSec, c.min) * 1000;
  return humanDelay(lo, Math.max(lo, c.max * 1000)); // upper bound never below the HARD floor either
}

// ---------- gates ----------

// Can a comment be posted right now? counts: { postedToday, postedGroup: {A,B}, target: {day, week} }
export function postGate(settings, state, counts, target, ts = now()) {
  const ah = activeHours(settings, ts);
  if (!ah.inside) return { ok: false, reason: "outside_active_hours", until: ah.opensAt };
  if (state.breakUntil && ts < state.breakUntil) return { ok: false, reason: "break", until: state.breakUntil };
  if (state.nextCommentAt && ts < state.nextCommentAt) return { ok: false, reason: "gap", until: state.nextCommentAt };
  if (state.lastCommentAt && ts - state.lastCommentAt < HARD.minGapMin * MIN) return { ok: false, reason: "gap", until: state.lastCommentAt + HARD.minGapMin * MIN };
  const total = dailyLimit(settings, state, ts);
  if (counts.postedToday >= total) return { ok: false, reason: "daily_limit", limit: total };
  if (target) {
    const gl = groupLimit(settings, target.group, total);
    if ((counts.postedGroup && counts.postedGroup[target.group] || 0) >= gl) return { ok: false, reason: "group_limit", limit: gl };
    const tc = counts.target || { day: 0, week: 0 };
    if (tc.day >= Math.min(settings.safety.perTargetDay, HARD.perTargetDay)) return { ok: false, reason: "target_day" };
    if (tc.week >= Math.min(settings.safety.perTargetWeek, HARD.perTargetWeek)) return { ok: false, reason: "target_week" };
  }
  return { ok: true };
}

// Should we spend money generating a comment for this target now? (checked before any OpenAI call)
export function generateGate(settings, state, counts, target, ts = now()) {
  const total = dailyLimit(settings, state, ts);
  if (counts.postedToday + counts.openQueue >= total) return { ok: false, reason: "daily_limit" };
  if (counts.generatedToday >= generationLimit(settings, state, ts)) return { ok: false, reason: "generation_limit" };
  if (target) {
    const gl = groupLimit(settings, target.group, total);
    if ((counts.postedGroup[target.group] || 0) + (counts.openGroup[target.group] || 0) >= gl) return { ok: false, reason: "group_limit" };
    const tc = counts.target || { day: 0, week: 0, open: 0 };
    if (tc.open > 0) return { ok: false, reason: "target_has_open_item" };
    if (tc.day >= Math.min(settings.safety.perTargetDay, HARD.perTargetDay)) return { ok: false, reason: "target_day" };
    if (tc.week >= Math.min(settings.safety.perTargetWeek, HARD.perTargetWeek)) return { ok: false, reason: "target_week" };
    if (target.coldUntil && target.coldUntil > ts) return { ok: false, reason: "target_cold" };
  }
  return { ok: true };
}

export const GATE_LABEL = {
  outside_active_hours: "Outside active hours",
  break: "Taking a break",
  gap: "Waiting between comments",
  daily_limit: "Daily comment limit reached",
  group_limit: "Group daily limit reached",
  target_day: "Already commented on this account today",
  target_week: "3 comments on this account this week",
  target_has_open_item: "A comment for this account is already queued",
  target_cold: "Account is cooling down (no response)",
  generation_limit: "Daily generation limit reached",
};
