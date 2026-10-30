// ScoreX - reply reach monitor (settings.safety.reach). X does not tell you when it hides or down-ranks your replies;
// the view counts of your own replies (read by the engagement checks in lib/learning.js) are the best proxy the page
// shows. This compares them over time and raises an alert when they fall sharply. Every threshold is a HEURISTIC (the
// numbers in settings.safety.reach plus the constants below): an alert is a reason to look at your account on x.com,
// not proof of anything. The monitor never resumes the engine, re-enables anything or switches back on its own.
//
// state.reach      = { checked, medianViews, prevMedianViews, lowShare, at, prevChecked, dropPct,
//                      early: { checked, prevChecked, medianViews, prevMedianViews, dropPct } }   (always refreshed)
// state.reachAlert = { at, message, medianNow, medianBefore, lowShare, checked, action, trigger, basis } | null
//                    (until you dismiss it: sw.js reachDismiss sets it to null and state.reachDismissedAt)

import { HS, STOP, MODE, K } from "./constants.js";
import { getSettings, getState, patchState, update, log } from "./store.js";
import { notify } from "./notify.js";
import * as H from "./history.js";
import { now, DAY, HOUR, num } from "./util.js";

export const WINDOW = 30; // heuristic: the last 30 checked replies are compared with the 30 before them
// A "day-after" reading: taken 20 h - 4 days after posting (heuristic; the 24 h check may run a little early or late).
export const MATURE_FROM_MS = 20 * HOUR;
export const MATURE_UNTIL_MS = 4 * DAY;
const HISTORY_DAYS = 30; // how far back readings are looked for
export const CAVEAT = "Views are a proxy - X does not tell you when it hides a reply.";

const isNum = (v) => v != null && v !== "" && Number.isFinite(Number(v));

export function median(values) {
  const a = (values || []).filter(isNum).map(Number).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
const dropOf = (cur, before) => (cur == null || before == null || before <= 0 ? null : Math.round(((before - cur) / before) * 1000) / 10);

// Pure. records: history records (any status). Day-after readings (results.views read >= ~24 h after posting) give the
// median of the last WINDOW checked replies vs the WINDOW before, and the share of them under lowViews. Early readings
// (results.earlyViews, ~3 h after posting) are compared only with each other, because a young reply has fewer views.
// The first day-after reading is kept in results.dayViews / dayViewsAt (lib/learning.js), so a later look (the 72 h
// one, which overwrites results.views) never moves a reply out of the comparison; older records only have views.
const dayReading = (res) => (isNum(res.dayViews) && res.dayViewsAt ? { v: Number(res.dayViews), at: num(res.dayViewsAt) } : isNum(res.views) && res.viewsAt ? { v: Number(res.views), at: num(res.viewsAt) } : null);
export function reachStats(records, settings, ts = now()) {
  const R = (settings && settings.safety && settings.safety.reach) || {};
  const lowViews = num(R.lowViews, 10);
  const posted = (records || []).filter((r) => r && r.status === HS.POSTED && r.postedAt && r.results && !r.results.gone && r.postedAt <= ts);
  const mature = posted
    .map((r) => ({ r, d: dayReading(r.results) }))
    .filter(({ r, d }) => d && d.at - r.postedAt >= MATURE_FROM_MS && d.at - r.postedAt <= MATURE_UNTIL_MS)
    .sort((a, b) => b.r.postedAt - a.r.postedAt);
  const recent = mature.slice(0, WINDOW), prev = mature.slice(WINDOW, 2 * WINDOW);
  const early = posted.filter((r) => isNum(r.results.earlyViews)).sort((a, b) => b.postedAt - a.postedAt);
  const eRecent = early.slice(0, WINDOW), ePrev = early.slice(WINDOW, 2 * WINDOW);
  const vals = (list, key) => list.map((r) => Number(r.results[key]));
  const medianViews = median(recent.map((x) => x.d.v)), prevMedianViews = median(prev.map((x) => x.d.v));
  const lowCount = recent.filter((x) => x.d.v < lowViews).length;
  const eNow = median(vals(eRecent, "earlyViews")), eBefore = median(vals(ePrev, "earlyViews"));
  return {
    checked: recent.length, prevChecked: prev.length, totalChecked: mature.length,
    medianViews, prevMedianViews, dropPct: dropOf(medianViews, prevMedianViews),
    lowShare: recent.length ? Math.round((lowCount / recent.length) * 100) / 100 : null, lowCount,
    early: { checked: eRecent.length, prevChecked: ePrev.length, medianViews: eNow, prevMedianViews: eBefore, dropPct: dropOf(eNow, eBefore) },
  };
}

const fmt = (v) => (v == null ? "-" : String(Math.round(v)));

// Pure: which condition (if any) raises an alert. Returns { trigger, basis, message, medianNow, medianBefore, checked } | null.
export function reachVerdict(stats, settings) {
  const R = settings.safety.reach;
  const min = R.minChecked;
  if (stats.checked >= min && stats.prevChecked >= min && stats.dropPct != null && stats.dropPct >= R.dropPct) {
    return { trigger: "drop", basis: "24h", medianNow: stats.medianViews, medianBefore: stats.prevMedianViews, checked: stats.checked,
      message: `Median views of your last ${stats.checked} checked replies fell from ${fmt(stats.prevMedianViews)} to ${fmt(stats.medianViews)} (-${Math.round(stats.dropPct)}%).` };
  }
  const e = stats.early || {};
  if (e.checked >= min && e.prevChecked >= min && e.dropPct != null && e.dropPct >= R.dropPct) {
    return { trigger: "early_drop", basis: "3h", medianNow: e.medianViews, medianBefore: e.prevMedianViews, checked: e.checked,
      message: `Median views about 3 hours after posting fell from ${fmt(e.prevMedianViews)} to ${fmt(e.medianViews)} (-${Math.round(e.dropPct)}%) over your last ${e.checked} early checks.` };
  }
  if (stats.checked >= min && stats.lowShare != null && stats.lowShare >= R.lowShare) {
    return { trigger: "low_share", basis: "24h", medianNow: stats.medianViews, medianBefore: stats.prevMedianViews, checked: stats.checked,
      message: `${Math.round(stats.lowShare * 100)}% of your last ${stats.checked} checked replies have fewer than ${R.lowViews} views a day after posting.` };
  }
  return null;
}

const ACTION_TEXT = {
  notify: "Nothing was changed.",
  review: "ScoreX switched to Review mode: nothing is posted without your approval.",
  halve: "Today's comment limit is halved until you dismiss this alert.",
  stop: "ScoreX stopped.",
};

async function switchToReview() {
  let changed = false;
  await update(K.settings, {}, (cur) => {
    if (cur && cur.mode === MODE.REVIEW) return cur;
    changed = true;
    return { ...(cur || {}), mode: MODE.REVIEW };
  });
  return changed;
}

// Recompute state.reach and raise an alert when the monitor is on, a condition holds, no alert is active and none was
// dismissed in the last 24 h. Applies the action once: "review" saves settings.mode = "review", "halve" is applied
// by the daily limit while the alert is active, "stop" returns { stop: STOP.REACH_DROP, detail } for the engine,
// "notify" only notifies. Returns { stats, alert } or { stats, alert, stop, detail }.
export async function checkReach(settings, ts = now()) {
  if (!settings) settings = await getSettings();
  const R = (settings.safety && settings.safety.reach) || {};
  const stats = reachStats(await H.since(ts - HISTORY_DAYS * DAY), settings, ts);
  const reach = { checked: stats.checked, medianViews: stats.medianViews, prevMedianViews: stats.prevMedianViews, lowShare: stats.lowShare, at: ts, prevChecked: stats.prevChecked, dropPct: stats.dropPct, early: stats.early };
  const st = await getState();
  const verdict = R.enabled ? reachVerdict(stats, settings) : null;
  const dismissed = !!(st.reachDismissedAt && ts - st.reachDismissedAt < DAY);
  if (!verdict || st.reachAlert || dismissed) {
    await patchState({ reach });
    return { stats, alert: null };
  }
  const alert = { at: ts, message: verdict.message, medianNow: verdict.medianNow, medianBefore: verdict.medianBefore, lowShare: stats.lowShare, checked: verdict.checked, action: R.action, trigger: verdict.trigger, basis: verdict.basis };
  let raised = false;
  await patchState((s) => (s.reachAlert ? { reach } : ((raised = true), { reach, reachAlert: alert })));
  if (!raised) return { stats, alert: null };
  log("warn", `Reply reach monitor: ${verdict.message} ${ACTION_TEXT[R.action] || ""}`.trim());
  if (R.action === "review" && (await switchToReview())) log("info", "Switched to Review mode (reply reach monitor)");
  // For "stop" the notification uses the engine's safety-stop id, so its stop notification replaces this one.
  await notify(R.action === "stop" ? "sx-stop" : "sx-reach", "ScoreX: your replies reach fewer people", `${verdict.message} ${ACTION_TEXT[R.action] || ""} ${CAVEAT}`, { requireInteraction: true });
  if (R.action === "stop") return { stats, alert, stop: STOP.REACH_DROP, detail: verdict.message };
  return { stats, alert };
}
