// ScoreX - safety rules for a main account. Pure functions over (settings, state, counts, ts) so the
// scheduler, the dashboard and the tests all agree on the same numbers.

import { HARD, MODE } from "./constants.js";
import { DAY, HOUR, MIN, clamp, humanDelay, randInt, inWindow, nextWindowStart, currentWindowEnd, now, parseHHMM } from "./util.js";

// ---------- reach monitor hooks ----------
// The reach monitor (lib/reach.js) sets state.reachAlert = { ..., action } when your replies' views drop sharply.
// Action "halve" halves the daily limit until the alert is dismissed (dailyLimit below). Action "review" is applied
// once by reach.js (it saves settings.mode = "review", which you may switch back), "stop" is a safety stop.
export const reachAction = (state) => (state && state.reachAlert && state.reachAlert.action) || null;
export const reachHalved = (state) => reachAction(state) === "halve";

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
// Week 1 -> ramp[0], week 2 -> ramp[1], then ramp[2]; always <= HARD.dailyComments. Halved (at least 1) while a
// reach alert with action "halve" is open.
export function rampStage(state, ts = now()) { return Math.min(2, Math.floor(daysSinceStart(state, ts) / 7)); }
export function dailyLimit(settings, state, ts = now()) {
  const base = clamp(settings.safety.ramp[rampStage(state, ts)] || 0, 0, HARD.dailyComments);
  return reachHalved(state) && base > 0 ? Math.max(1, Math.floor(base / 2)) : base;
}
export function generationLimit(settings, state, ts = now()) {
  return Math.ceil(dailyLimit(settings, state, ts) * settings.safety.generationFactor);
}
// Likes happen only right before a comment, so their limit is the comment cap (no separate like limit).
export function likeLimit(settings) { return settings.safety.like && settings.safety.like.enabled ? HARD.dailyLikes : 0; }
export function accountsLimit(settings) { return clamp(Math.round(Number(settings.safety.accountsPerDay) || 100), 1, HARD.accountsPerDay); }

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

// Adaptive watch cadence (settings.safety.adaptiveWatch): after `afterEmpty` watch checks in a row found no fresh
// target post (state.emptyWatchStreak), each further empty check stretches the interval 1.5x, up to maxIntervalMin
// (never below HARD.minCheckIntervalSec, never shorter than the configured interval). A fresh post resets it.
// Returns { slow, factor, loMs, hiMs, intervalSec, emptyStreak }.
export function watchCadence(settings, state) {
  const c = settings.watch.checkIntervalSec;
  const lo = Math.max(HARD.minCheckIntervalSec, c.min) * 1000;
  const hi = Math.max(lo, c.max * 1000); // upper bound never below the HARD floor either
  const aw = settings.safety && settings.safety.adaptiveWatch;
  const streak = Math.max(0, Number(state && state.emptyWatchStreak) || 0);
  let factor = 1;
  if (aw && aw.enabled && state && streak >= aw.afterEmpty) factor = Math.pow(1.5, Math.min(30, streak - aw.afterEmpty + 1));
  let loMs = lo, hiMs = hi;
  if (factor > 1) {
    const cap = Math.max(hi, (Number(aw.maxIntervalMin) || 15) * MIN);
    loMs = Math.min(cap, lo * factor);
    hiMs = Math.min(cap, hi * factor);
  }
  const slow = hiMs > hi;
  return { slow, factor: slow ? factor : 1, loMs, hiMs, intervalSec: Math.round((loMs + hiMs) / 2000), emptyStreak: streak };
}

// Random delay until the next watch check (stretched by the adaptive cadence when `state` is given).
export function nextCheckMs(settings, state) {
  const w = watchCadence(settings, state);
  return humanDelay(w.loMs, w.hiMs);
}

// ---------- gates ----------

// Can a comment be posted right now? counts: { postedToday, accountsToday, target: {day, week} }
export function postGate(settings, state, counts, target, ts = now()) {
  const ah = activeHours(settings, ts);
  if (!ah.inside) return { ok: false, reason: "outside_active_hours", until: ah.opensAt };
  if (state.breakUntil && ts < state.breakUntil) return { ok: false, reason: "break", until: state.breakUntil };
  if (state.nextCommentAt && ts < state.nextCommentAt) return { ok: false, reason: "gap", until: state.nextCommentAt };
  if (state.lastCommentAt && ts - state.lastCommentAt < HARD.minGapMin * MIN) return { ok: false, reason: "gap", until: state.lastCommentAt + HARD.minGapMin * MIN };
  const total = dailyLimit(settings, state, ts);
  if (counts.postedToday >= total) return { ok: false, reason: "daily_limit", limit: total };
  if (target) {
    const tc = counts.target || { day: 0, week: 0 };
    // A new account for today needs room under the daily account limit (100 different accounts by default).
    if (!tc.day && (counts.accountsToday || 0) >= accountsLimit(settings)) return { ok: false, reason: "accounts_limit" };
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
    const tc = counts.target || { day: 0, week: 0, open: 0 };
    if (tc.open > 0) return { ok: false, reason: "target_has_open_item" };
    if (!tc.day && (counts.accountsOpen || 0) >= accountsLimit(settings)) return { ok: false, reason: "accounts_limit" };
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
  target_day: "Per-account daily limit reached for this account",
  target_week: "Per-account weekly limit reached for this account",
  accounts_limit: "Daily limit of different accounts reached",
  target_has_open_item: "A comment for this account is already queued",
  target_cold: "Account is cooling down (no response)",
  generation_limit: "Daily generation limit reached",
  footprint: "X page-load budget reached - waiting",
};

// ---------- risk meter ----------
// A rough estimate of how much the current setup stands out to X, from settings and the last 24 hours. Every
// threshold and weight below is a HEURISTIC chosen by hand (X publishes no numbers): it orders setups from calmer
// to busier, it is not a probability and not a guarantee. Pure: riskReport(settings, state, counts, footprint,
// reach) with counts = computeCounts() (postedToday), footprint = footprintSummary() (total) and
// reach = { ...state.reach, alert: state.reachAlert }.
// Returns { level: "low"|"medium"|"high", score: 0-100, factors: [{ id, label, detail, points }], hoursToLimit }.
export const RISK_LEVELS = Object.freeze({ medium: 30, high: 60 }); // heuristic score cut-offs

export function activeHoursPerDay(settings) {
  const ah = settings.safety && settings.safety.activeHours;
  if (!ah || !ah.enabled) return 24;
  const a = parseHHMM(ah.start), b = parseHHMM(ah.end);
  if (a == null || b == null) return 24;
  const mins = (b - a + 24 * 60) % (24 * 60);
  return mins === 0 ? 24 : Math.round((mins / 60) * 10) / 10;
}

export function riskReport(settings, state, counts, footprint, reach, ts = now()) {
  const st = state || {};
  const factors = [];
  const add = (id, label, detail, points) => { if (points > 0) factors.push({ id, label, detail, points: Math.round(points) }); };
  const limit = dailyLimit(settings, st, ts);
  const posted = Math.max(0, Number(counts && counts.postedToday) || 0);

  // 1) Replies per 24 h (actual, up to 25) plus the daily limit you allow (up to 5). Heuristic: ~100 replies a
  //    day is a lot for one person; limits above 100 a day leave room for that.
  const volPts = clamp(posted / 100, 0, 1) * 25 + (limit > 100 ? 5 : limit > 50 ? 3 : 0);
  add("volume", "Replies per day", `${posted} replies in the last 24 h (daily limit ${limit})`, volPts);

  // 2) Hours active per day (active hours off = 24 h). People sleep; heuristic: 20 h+ is the busiest pattern.
  const hrs = activeHoursPerDay(settings);
  add("hours", "Hours active per day", hrs >= 24 ? "Works around the clock (active hours are off)" : `Active ${hrs} h a day`, hrs >= 20 ? 15 : hrs >= 16 ? 9 : hrs >= 12 ? 4 : 0);

  // 3) Full auto: no person looks at each reply before it goes out.
  if (effectiveMode(settings, st) === MODE.AUTO) add("auto", "Full auto", "Replies are posted without you checking each one", 15);

  // 4) A like on every reply doubles the actions per reply.
  if (settings.safety.like && settings.safety.like.enabled) add("likes", "Like on every reply", "Every reply comes with a like on the post", 5);

  // 5) Reply speed after a post (the earliest a reply may go out). Heuristic: within ~2 min is fast for a person.
  const minAge = Number(settings.watch && settings.watch.minPostAgeMin) || 0;
  add("speed", "Reply speed", `Replies can go out ${minAge < 1 ? "less than a minute" : minAge === 1 ? "1 minute" : `${minAge} minutes`} after a post`, minAge <= 1 ? 10 : minAge <= 3 ? 5 : minAge <= 5 ? 2 : 0);

  // 6) X page loads in the last 24 h (watch pages, posts, profiles...). Heuristic tiers at 250 / 500 / 1000.
  const loads = Math.max(0, Number(footprint && footprint.total) || 0);
  add("footprint", "X page loads", `${loads} X page loads in the last 24 h${footprint && footprint.cap ? ` (budget ${footprint.cap})` : ""}`, loads >= 1000 ? 10 : loads >= 500 ? 6 : loads >= 250 ? 3 : 0);

  // 7) Reach trend: a sharp drop in your replies' views can mean X is already limiting them (views are a proxy).
  const r = reach || {};
  const alert = r.alert || st.reachAlert || null;
  const nowMed = Number(r.medianViews), before = Number(r.prevMedianViews);
  if (alert) add("reach", "Reach dropped", String(alert.message || "Your replies are reaching far fewer people than before").slice(0, 200), 20);
  else if (before > 0 && Number.isFinite(nowMed) && nowMed < before * 0.7) add("reach", "Reach trend", `Median views per reply ${Math.round(nowMed)} (before ${Math.round(before)})`, 8);

  factors.sort((a, b) => b.points - a.points);
  const score = clamp(Math.round(factors.reduce((s, f) => s + f.points, 0)), 0, 100);
  const level = score >= RISK_LEVELS.high ? "high" : score >= RISK_LEVELS.medium ? "medium" : "low";

  // Hours until the daily limit at the pace of the last 24 h (null when nothing was posted yet).
  let hoursToLimit = null;
  if (posted >= limit) hoursToLimit = 0;
  else if (posted > 0) {
    const ran = st.startedAt ? (ts - st.startedAt) / HOUR : 24;
    const pace = posted / clamp(ran, 1, 24);
    hoursToLimit = Math.round(((limit - posted) / pace) * 10) / 10;
  }
  return { level, score, factors, hoursToLimit };
}
