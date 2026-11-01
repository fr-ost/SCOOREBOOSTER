// ScoreX - the engine: start / pause / resume / stop, the randomized tick, auto-stop, review actions.
// All state lives in chrome.storage + IndexedDB, so a sleeping/restarted service worker continues
// exactly where it left off. A job lease in state.job prevents overlapping work.

import { STATUS, MODE, HS, STOP, STOP_LABEL, ALARM, K, HARD, OPEN_STATUSES } from "./constants.js";
import { getSettings, getSecrets, getState, patchState, getTargets, updateTargets, getBlacklist, log, load, save } from "./store.js";
import { now, DAY, MIN, dayKey, humanDelay, randInt, uid, truncate, fmtDuration, normalizeHandle, sleep } from "./util.js";
import * as H from "./history.js";
import { recordSpend, getSpend, budgetStatus, wouldExceed, estimate, usageStats, modelById } from "./costs.js";
import { effectiveMode, dailyLimit, generationLimit, likeLimit, accountsLimit, activeHours, afterPost, nextCheckMs, nextGapMs, postGate, generateGate, GATE_LABEL, rampStage, daysSinceStart, watchCadence, riskReport } from "./safety.js";
import { skipReason } from "./filters.js";
import { effectiveTone, effectivePreset, isActive, followStatus, FS } from "./targets.js";
import { generate, pickOwnerEdits } from "./generator.js";
import { weightedLength } from "./quality.js";
import { workerTab, releaseGuard, withPurpose, withAbort, pageBudget, footprintSummary } from "./tabs.js";
import { watchOnce, refreshProfile } from "./watcher.js";
import { postReply } from "./poster.js";
import { notify, setBadge } from "./notify.js";
import { chooseArm, learningStep, recordOutcomeForTarget } from "./learning.js";
import { cleanupStep } from "./cleanup.js";
import { followStep, badgeTrusted, followRoom, wantsFollow, recordFollow, followFirstStep, pruneFollowers } from "./follow.js";
import { conversationsStep } from "./conversations.js";
import { catchUpCandidates, catchUpMaxAgeMin } from "./catchup.js";
import { cancelDiscovery } from "./discovery.js";

// Background X jobs started outside the tick (profile refreshes) get their own abort token from backgroundJob();
// Pause/Stop abort every running one. A new request never clears the abort of a job that is already running.
const backgroundJobs = new Set();
export function backgroundJob(kind = "background") { const j = { kind, abort: false }; backgroundJobs.add(j); return j; }
export function endBackgroundJob(j) { backgroundJobs.delete(j); }
function abortBackground() { for (const j of backgroundJobs) j.abort = true; backgroundAbort.requested = true; }
// Deprecated (kept for older callers): set by Pause/Stop, never read by ScoreX itself. Use backgroundJob().
export const backgroundAbort = { requested: false };

const SAFETY_STOPS = new Set(Object.values(STOP).filter((s) => s !== STOP.USER));
// A safety stop (captcha, X warning, rate limit...) not reviewed yet (same rule as the dashboard's isSafetyStop): only
// resume() - the dashboard's "Review stop..." - ends it, and until then nothing drives the X tab (no discovery; re-checks
// wait for the resume).
export function safetyStopped(st) {
  return !!st && st.status !== STATUS.RUNNING && ((st.status === STATUS.STOPPED && SAFETY_STOPS.has(st.stopReason)) || !!st.alert);
}
export const SAFETY_STOP_ERROR = "ScoreX was stopped by a safety check: open Review stop... and confirm you checked your account first";
const ACCOUNT_UNKNOWN_MAX = 3; // page loads in a row without a readable logged-in account -> safety stop
let ticking = false;
let rerunRequested = false;
let tickTimer = null;
let keepTimer = null;

// ---------- keep-alive & scheduling ----------

function keepAlive(on) {
  if (on && !keepTimer) keepTimer = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 20000);
  if (!on && keepTimer) { clearInterval(keepTimer); keepTimer = null; }
}

export async function scheduleTick(ms, why = "") {
  const delay = Math.max(1000, Math.round(ms));
  const when = now() + delay;
  clearTimeout(tickTimer);
  if (delay < 5 * MIN) tickTimer = setTimeout(() => tick(why === "manual" ? "manual" : "timer"), delay);
  try { await chrome.alarms.create(ALARM.TICK, { when: now() + Math.max(delay + 2000, 30000) }); } catch (_) {}
  await patchState({ nextTickAt: when, nextTickWhy: why });
}

// "Check now" requests (Run a check now, learning checks). While a tick is running its own final
// scheduleTick would replace a new timer, so the request is remembered and runs right after that tick.
export async function requestTick(ms, why = "manual") {
  if (ticking) { rerunRequested = true; return; }
  await scheduleTick(ms, why);
}

// Called once when a (new) service worker instance starts: nothing can be running in this instance
// yet, so a job lease in storage belongs to a worker that was killed mid-job.
export async function onWorkerStart() {
  const st = await getState();
  // Compare-and-set: only the lease read above, and never one a job in this worker took meanwhile (an overdue
  // alarm can start a tick while this runs).
  if (st.job) { const staleId = st.job.id; await patchState((s) => (s.job && s.job.id === staleId && !heldLeases.has(staleId) ? { job: null } : {})); }
  // Nothing can be posting in a fresh worker: a POSTING record was interrupted (maybe already sent).
  // It counts toward the limits and the gap starts from its attempt, so the next post waits properly.
  let lastAttempt = 0;
  for (const r of await H.byStatus(HS.POSTING).catch(() => [])) {
    const done = await H.patch(r.id, (cur) => (cur.status === HS.POSTING ? { status: HS.FAILED, maybePosted: true, reason: "Interrupted while posting - check the post manually" } : null));
    if (done) lastAttempt = Math.max(lastAttempt, r.attemptAt || r.updatedAt || 0);
  }
  if (lastAttempt) {
    const settings = await getSettings();
    await patchState((s) => ({ lastCommentAt: Math.max(s.lastCommentAt || 0, lastAttempt), nextCommentAt: Math.max(s.nextCommentAt || 0, lastAttempt + nextGapMs(settings)) }));
  }
  const d = await load(K.discovery, null);
  if (d && ["running", "cancelling", "waiting", "queued"].includes(d.status)) {
    await save({ [K.discovery]: { ...d, status: "error", message: "Interrupted (browser or extension restarted)", finishedAt: now() } });
  }
  await ensureAlarms();
}

export async function ensureAlarms() {
  const st = await getState();
  try { await chrome.alarms.create(ALARM.WATCHDOG, { periodInMinutes: 1 }); } catch (_) {}
  if (st.status !== STATUS.RUNNING) return;
  const a = await chrome.alarms.get(ALARM.TICK).catch(() => null);
  if (!a || (st.nextTickAt && st.nextTickAt < now() - 2 * MIN)) await scheduleTick(randInt(5000, 20000), "resume");
}

export async function watchdog() {
  const st = await getState();
  if (st.status !== STATUS.RUNNING) return;
  // A job lease far past its expiry means a worker died mid-job - unless a job of this worker still holds it (its
  // wall-clock expiry can pass while the computer sleeps). Compare-and-set, so a newer lease is never wiped.
  if (st.job && st.job.leaseUntil < now() && !heldLeases.has(st.job.id)) {
    const staleId = st.job.id;
    await patchState((s) => (s.job && s.job.id === staleId && s.job.leaseUntil < now() && !heldLeases.has(staleId) ? { job: null } : {}));
  }
  const a = await chrome.alarms.get(ALARM.TICK).catch(() => null);
  if (!a && (!st.nextTickAt || st.nextTickAt < now() - MIN)) await scheduleTick(randInt(5000, 15000), "watchdog");
}

// ---------- lease ----------

// A lease lives LEASE_MS and is renewed every minute while its holder runs, so a killed holder's lease
// expires within minutes while a long discovery keeps its lease for as long as it is alive.
// heldLeases: leases held by jobs running in THIS worker instance. Only one service worker instance runs at a time,
// so a lease in this set is alive even when its wall-clock expiry passed (system sleep, a stalled timer): it is
// never taken over or cleared. A killed worker takes its set with it, so its leases simply expire.
const LEASE_MS = 3 * MIN;
const heldLeases = new Set();
const LEASE_PURPOSE = { discovery: "discovery", selftest: "diagnostics", refresh: "profile" }; // page-load purpose per job kind
const leaseLive = (job) => !!job && (job.leaseUntil > now() || heldLeases.has(job.id));
async function acquireLease(kind) {
  let got = false;
  const id = uid("j");
  await patchState((s) => {
    if (leaseLive(s.job)) return {};
    got = true;
    heldLeases.add(id);
    return { job: { id, kind, startedAt: now(), leaseUntil: now() + LEASE_MS } };
  });
  return got ? id : null;
}
async function releaseLease(id) {
  heldLeases.delete(id);
  await patchState((s) => (s.job && s.job.id === id ? { job: null } : {}));
}
export async function withLease(kind, fn) {
  const id = await acquireLease(kind);
  if (!id) return { ok: false, busy: true };
  // Jobs outside the tick (discovery, the live self-test, re-checks) get an abort token: Pause/Stop set it and the X tab
  // then loads no further page for them (tabs.navigate refuses). The tick stops on the engine status instead.
  const job = kind === "tick" ? null : backgroundJob(kind);
  keepAlive(true);
  const beat = setInterval(() => {
    patchState((s) => (s.job && s.job.id === id ? { job: { ...s.job, leaseUntil: now() + LEASE_MS } } : {})).catch(() => {});
  }, 60 * 1000);
  try { return await withPurpose(LEASE_PURPOSE[kind] || null, () => (job ? withAbort(() => job.abort, fn) : fn())); } finally { clearInterval(beat); if (job) endBackgroundJob(job); await releaseLease(id); keepAlive(false); }
}

// ---------- status ----------

// Limits use ROLLING windows (last 24h / last 7 days), so an active-hours window that crosses midnight
// can never get two daily limits in one session, and one target never gets 2 replies within 24h.
// A reply that was probably sent (unclear confirmation, interrupted worker) counts as posted.
export const countsAsPosted = (r) => r.status === HS.POSTED || r.status === HS.POSTING || !!r.maybePosted;
const postedTime = (r) => r.postedAt || r.attemptAt || r.updatedAt || r.createdAt;

// opts.days: how far back to read history (9 days by default for the 7-day per-account caps; the status uses 2).
export async function computeCounts(settings, ts = now(), opts = {}) {
  const tz = settings.timezone;
  const today = dayKey(ts, tz);
  const recent = await H.since(ts - (Number(opts.days) > 0 ? Number(opts.days) : 9) * DAY);
  const open = await H.openQueue();
  const c = { postedToday: 0, postedCalendarDay: 0, postedGroup: { A: 0, B: 0 }, generatedToday: 0, likedToday: 0, skippedToday: 0, failedToday: 0, costToday: 0,
    openQueue: 0, openGroup: { A: 0, B: 0 }, pendingReview: 0, queued: 0, targets: Object.create(null), firstPostedAt: null };
  const tgt = (h) => (c.targets[h] ||= { day: 0, week: 0, open: 0 });
  for (const r of recent) {
    if (dayKey(r.createdAt, tz) === today) {
      c.costToday += r.cost || 0;
      if (r.status === HS.SKIPPED) c.skippedToday++;
      if (r.status === HS.FAILED) c.failedToday++;
    }
    if (r.attempts > 0 && ts - r.createdAt < DAY) c.generatedToday++;
    if (r.liked && r.likedAt && ts - r.likedAt < DAY) c.likedToday++;
    if (countsAsPosted(r)) {
      const pt = postedTime(r);
      if (ts - pt < DAY) {
        c.postedToday++; c.postedGroup[r.group] = (c.postedGroup[r.group] || 0) + 1; tgt(r.target).day++;
        if (!c.firstPostedAt || pt < c.firstPostedAt) c.firstPostedAt = pt; // the time postedToday covers (risk pace)
      }
      if (dayKey(pt, tz) === today) c.postedCalendarDay++;
      if (ts - pt < 7 * DAY) tgt(r.target).week++;
    }
  }
  for (const r of open) {
    c.openQueue++;
    c.openGroup[r.group] = (c.openGroup[r.group] || 0) + 1;
    tgt(r.target).open++;
    if (r.status === HS.PENDING_REVIEW) c.pendingReview++;
    if (r.status === HS.QUEUED || r.status === HS.APPROVED) c.queued++;
  }
  // Different accounts commented on in the last 24 hours (and including accounts with a waiting comment).
  const ts2 = Object.values(c.targets);
  c.accountsToday = ts2.filter((x) => x.day > 0).length;
  c.accountsOpen = ts2.filter((x) => x.day > 0 || x.open > 0).length;
  return c;
}

// getStatus() is polled by the popup and the dashboard (every few seconds and on state changes), so its history
// read is small: 2 days, enough for every 24 h / calendar-day number it shows. (No time-based cache: right after a
// post or a review action the numbers must already be current.) Everything else it adds is pure arithmetic on
// state it already read (footprint, risk, watch cadence, reach).
export async function getStatus() {
  const ts = now();
  const [settings, state, secrets, targets, spend, blacklist] = await Promise.all([getSettings(), getState(), getSecrets(), getTargets(), getSpend(), getBlacklist()]);
  const c = await computeCounts(settings, ts, { days: 2 });
  const total = dailyLimit(settings, state, ts);
  const b = budgetStatus(settings, spend, ts);
  const all = Object.values(targets);
  const ah = activeHours(settings, ts);
  const footprint = footprintSummary(state.footprint, settings.safety.maxPageLoads24h || 0, ts);
  const reach = { ...(state.reach && typeof state.reach === "object" ? state.reach : {}), alert: state.reachAlert || null };
  const wc = watchCadence(settings, state);
  const watch = { slow: wc.slow, intervalSec: wc.intervalSec, emptyStreak: wc.emptyStreak };
  let label = state.status === STATUS.RUNNING ? "Running" : state.status === STATUS.PAUSED ? "Paused" : "Stopped";
  if (state.status === STATUS.STOPPED && state.stopReason && state.stopReason !== STOP.USER) label += ` (${STOP_LABEL[state.stopReason] || state.stopReason})`;
  let sub = "";
  if (state.status === STATUS.RUNNING) {
    const next = state.nextTickAt ? fmtDuration(Math.max(0, state.nextTickAt - ts)) : "";
    if (!ah.inside) sub = `Sleeping until ${new Date(ah.opensAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} (outside active hours)`;
    else if (state.breakUntil && state.breakUntil > ts) sub = `On a break for ${fmtDuration(state.breakUntil - ts)}`;
    else if (state.nextTickAt && state.nextTickWhy === GATE_LABEL.footprint) sub = `${GATE_LABEL.footprint} (next check in ${next})`;
    else if (state.nextTickAt && wc.slow) {
      const since = Math.max(state.lastFreshAt || 0, state.startedAt || 0) || ts;
      sub = `Watching slowly: nothing new for ${Math.max(1, Math.round((ts - since) / MIN))} min · next check in ${next}`;
    } else if (state.nextTickAt) sub = `Next check in ${next}`;
  }
  return {
    state: { ...state },
    label,
    sub,
    effectiveMode: effectiveMode(settings, state, ts),
    today: {
      posted: c.postedToday, limit: total,
      generated: c.generatedToday, generationLimit: generationLimit(settings, state, ts),
      liked: c.likedToday, likeLimit: likeLimit(settings), skipped: c.skippedToday, failed: c.failedToday,
      accounts: c.accountsToday, accountsLimit: accountsLimit(settings),
      cost: b.today || c.costToday,
    },
    month: { cost: b.spent, budget: b.limit, pct: b.pct, reached: b.reached, warn: b.warn },
    pendingReview: c.pendingReview,
    queued: c.queued,
    activeHours: ah,
    rampStage: rampStage(state, ts),
    daysSinceStart: daysSinceStart(state, ts),
    hasApiKey: !!secrets.openaiKey,
    targetCount: all.length,
    activeTargetCount: all.filter((t) => isActive(t, settings)).length,
    follow: followCounts(all, blacklist),
    footprint, // { total, cap, byPurpose, hourly[24] } X page loads in the last 24 h
    risk: riskReport(settings, state, c, footprint, reach, ts), // { level, score, factors, hoursToLimit } (an estimate)
    watch, // { slow, intervalSec, emptyStreak } adaptive watch cadence
    reach, // { checked, medianViews, prevMedianViews, lowShare, at, alert } from the reach monitor
  };
}

// Targets by follow status (enabled ones; disabled targets are never checked or commented on).
export function followCounts(all, blacklist = {}) {
  const c = { checking: 0, active: 0, follows: 0, followedBack: 0, off: 0, blacklisted: Object.keys(blacklist || {}).length };
  for (const t of all) {
    if (t.enabled === false) { c.off++; continue; }
    const f = followStatus(t);
    if (f === FS.CHECKING) c.checking++;
    else if (f === FS.ACTIVE) c.active++;
    else if (f === FS.FOLLOWS) c.follows++;
    else c.followedBack++;
  }
  return c;
}

export async function refreshBadge() {
  const st = await getState();
  const open = await H.byStatus(HS.PENDING_REVIEW).catch(() => []);
  // Replies posted in the last 24 h (the window the daily limit uses), shown on the icon while running.
  const posted = (await H.since(now() - DAY).catch(() => [])).filter((r) => r.status === HS.POSTED).length;
  await setBadge(st, open.length, posted);
}

// ---------- control ----------

// opts.reviewed: only resume() (the dashboard's "Review stop..." after you checked your account) may end a safety stop.
export async function start(opts = {}) {
  const [settings, secrets, targets, st] = await Promise.all([getSettings(), getSecrets(), getTargets(), getState()]);
  if (safetyStopped(st) && !(opts && opts.reviewed === true)) return { ok: false, error: SAFETY_STOP_ERROR };
  if (!secrets.openaiKey) return { ok: false, error: "Add your OpenAI API key first (Models & Costs)." };
  if (!settings.account.handle) return { ok: false, error: "Set your X handle first (Settings)." };
  // Targets that are not checked yet count: the engine checks who follows you before commenting.
  const usable = Object.values(targets).filter((t) => t.enabled !== false && [FS.CHECKING, FS.ACTIVE].includes(followStatus(t)));
  if (!usable.length) {
    const any = Object.values(targets).some((t) => t.enabled !== false);
    return { ok: false, error: any ? "Every target already follows you - add accounts that don't follow you yet (Targets)." : "Add at least one enabled target first (Targets)." };
  }
  if (settings.watch.strategy === "list" && !settings.watch.listUrls.length) log("warn", "Watch strategy is 'X List' but no list URL is set - using batched search instead.");
  handoverRefresh();
  const ts = now();
  await patchState((s) => ({
    status: STATUS.RUNNING, stopReason: null, stopDetail: "", alert: null, startedAt: ts,
    firstStartedAt: st.firstStartedAt || ts, consecutiveFailures: 0, softErrors: 0, errorPageStreak: 0, watchRetryAt: null, tabErrors: 0, internalErrors: 0, emptyStreak: 0,
    accountUnknownStreak: 0, emptyWatchStreak: 0,
    job: leaseLive(s.job) ? s.job : null, // never drop a live lease (e.g. a running discovery)
  }));
  log("info", "Started");
  await scheduleTick(randInt(4000, 12000), "start");
  await ensureAlarms();
  await refreshBadge();
  return { ok: true };
}

export async function pause() {
  abortBackground();
  await cancelDiscovery().catch(() => {});
  await patchState({ status: STATUS.PAUSED, nextTickAt: null });
  clearTimeout(tickTimer);
  await chrome.alarms.clear(ALARM.TICK).catch(() => {});
  log("info", "Paused");
  await refreshBadge();
  return { ok: true };
}

export async function resume() {
  const st = await getState();
  if (st.status === STATUS.RUNNING) return { ok: true };
  if (st.status === STATUS.STOPPED) return start({ reviewed: true });
  handoverRefresh();
  await patchState({ status: STATUS.RUNNING, alert: null, consecutiveFailures: 0, softErrors: 0, errorPageStreak: 0, watchRetryAt: null, tabErrors: 0, internalErrors: 0, accountUnknownStreak: 0 });
  log("info", "Resumed");
  await scheduleTick(randInt(3000, 10000), "resume");
  await refreshBadge();
  return { ok: true };
}

// Stop the engine. Safety reasons raise a notification + red badge and need a manual resume.
export async function stop(reason = STOP.USER, detail = "") {
  const label = STOP_LABEL[reason] || reason;
  const safety = SAFETY_STOPS.has(reason);
  abortBackground(); // Stop means stop everything that drives the X tab
  await cancelDiscovery().catch(() => {});
  await patchState({
    status: STATUS.STOPPED, stopReason: reason, stopDetail: truncate(detail, 300), stoppedAt: now(), nextTickAt: null,
    alert: safety ? { reason, label, detail: truncate(detail, 300), at: now() } : null,
  });
  clearTimeout(tickTimer);
  await chrome.alarms.clear(ALARM.TICK).catch(() => {});
  if (safety) {
    log("error", `AUTO-STOP: ${label}`, detail);
    await notify("sx-stop", `ScoreX stopped: ${label}`, (detail ? truncate(detail, 160) + "\n" : "") + "Check your X account, then press Resume in the dashboard.", { requireInteraction: true });
  } else log("info", "Stopped by you");
  await refreshBadge();
  return { ok: true };
}

export async function clearAlert() {
  await patchState({ alert: null });
  await refreshBadge();
  return { ok: true };
}

export async function runNow() {
  const st = await getState();
  if (st.status !== STATUS.RUNNING) return { ok: false, error: "Start the engine first." };
  await requestTick(1500, "manual");
  return { ok: true };
}

// ---------- tick ----------

async function stillRunning() { return (await getState()).status === STATUS.RUNNING; }

async function onCallFactory(settings) {
  return async (call, compat) => {
    await recordSpend(call.cost, call.modelId, settings.timezone);
    if (compat && Object.keys(compat).length) {
      await patchState((s) => ({ modelCompat: { ...(s.modelCompat || {}), [call.modelName]: { ...((s.modelCompat || {})[call.modelName] || {}), ...compat } } }));
    }
  };
}

async function compatLoader() {
  const st = await getState();
  const map = st.modelCompat || {};
  return (name) => ({ ...(map[name] || {}) });
}

// Your recent comments, NEWEST FIRST: waiting queue items (by when they were written) and posted replies (by when
// they were posted) merged by time. The generator shows the head to the model and the quality check compares
// openers with the most recent ones, so the order matters. excludeId leaves one record out (regenerate).
export async function recentComments(excludeId = null) {
  const open = (await H.openQueue()).filter((r) => r.id !== excludeId);
  const posted = (await H.recentPosted(50)).filter((r) => r.id !== excludeId);
  const at = (r) => r.postedAt || r.createdAt || 0;
  return [...open, ...posted].sort((a, b) => at(b) - at(a)).map((r) => r.comment).filter(Boolean);
}

async function bestComments(n = 20) {
  const posted = await H.recentPosted(200);
  return posted.filter((r) => r.results && r.results.likes > 0).sort((a, b) => (b.results.likes || 0) - (a.results.likes || 0)).slice(0, n).map((r) => r.comment);
}

// Drafts the owner rewrote before posting (prompt.learnFromEdits): shown to the model as style examples, data only.
async function ownerEdits(settings) {
  return settings.prompt.learnFromEdits ? pickOwnerEdits(await H.recentPosted(100), settings) : [];
}

// Expire open items that are too old to be worth posting, and drop items for accounts that follow you
// (followed back since the comment was written) or were removed from the targets.
async function expireQueue(settings, ts = now()) {
  const open = await H.openQueue();
  const targets = await getTargets();
  for (const r of open) {
    let why = "";
    if (r.status !== HS.POSTING) {
      const t = Object.hasOwn(targets, r.target) ? targets[r.target] : null;
      if (!t) why = "Removed from your targets";
      else if ([FS.FOLLOWS, FS.FOLLOWED_BACK].includes(followStatus(t))) why = "Follows you now - no more comments to this account";
    }
    if (r.status === HS.PENDING_REVIEW && ts - r.createdAt > settings.review.pendingMaxAgeMin * MIN) why = "Expired while waiting for review";
    if (r.status === HS.APPROVED && ts - (r.approvedAt || r.createdAt) > settings.review.approvedMaxAgeMin * MIN) why = "Approved but expired before a posting slot";
    const maxQueuedAge = r.catchUp ? catchUpMaxAgeMin(settings) : settings.watch.maxPostAgeMin + 25;
    // A post without a known time is aged from when its comment was written, so it never waits for days either.
    const postTime = r.postCreatedAt || r.createdAt;
    if (r.status === HS.QUEUED && postTime && ts - postTime > maxQueuedAge * MIN) why = r.catchUp ? "Too late to post (older than the catch-up window)" : "Too late to post (post is no longer fresh)";
    if (r.status === HS.POSTING && ts - (r.attemptAt || r.updatedAt) > 10 * MIN) why = "Interrupted while posting - check the post manually";
    if (why) await H.patch(r.id, (cur) => (cur.status === r.status ? { status: r.status === HS.POSTING ? HS.FAILED : HS.SKIPPED, reason: why, maybePosted: r.status === HS.POSTING } : null));
  }
}

// The logged-in account could not be read on ACCOUNT_UNKNOWN_MAX page loads in a row (counted per page load in
// tabs.js) -> safety stop. Only with account verification on and a handle set.
async function stopIfAccountUnknown(settings) {
  if (!settings.account.verifyAccount || !settings.account.handle) return false;
  if (((await getState()).accountUnknownStreak || 0) < ACCOUNT_UNKNOWN_MAX) return false;
  await stop(STOP.ACCOUNT_UNKNOWN, `Could not read which X account is logged in on ${ACCOUNT_UNKNOWN_MAX} pages in a row (expected @${settings.account.handle})`);
  return true;
}

// Room for `need` more X page loads under settings.safety.maxPageLoads24h (left = Infinity without a cap).
async function pageRoom(settings, need = 1) { return pageBudget(settings, await getState(), now(), need); }
// Page loads a background step may use (followers list + profile checks, engagement checks, cleanup).
const backgroundNeed = (settings) => Math.max(settings.follow.checksPerRun + 1, settings.learning.maxChecksPerRun, 2);
// Budget reached: wait (never a stop) until loads leave the rolling 24 h window, re-checking at least every 30 min
// (the budget may be raised meanwhile).
async function budgetWait(pb, ts = now()) {
  const st = await getState();
  if (!st.footprintWaitLoggedAt || ts - st.footprintWaitLoggedAt > 60 * MIN) {
    await patchState({ footprintWaitLoggedAt: ts });
    log("info", `${GATE_LABEL.footprint} (${pb.used} of ${pb.cap} X page loads in 24 h)${pb.until ? " - room again at " + new Date(pb.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}`);
  }
  const wait = pb.until ? Math.max(MIN, pb.until - ts) : 30 * MIN;
  return { delay: Math.min(30 * MIN, wait) + randInt(5, 60) * 1000, why: GATE_LABEL.footprint };
}

// Main loop body. Returns the delay until the next tick.
async function tickBody(settings, secrets, reason = "timer") {
  const ts = now();
  let state = await getState();

  // Budget
  const spend = await getSpend();
  const b = budgetStatus(settings, spend, ts);
  if (b.reached) { await stop(STOP.BUDGET, `Spent $${b.spent.toFixed(2)} of $${b.limit.toFixed(2)} this month`); return null; }
  const mKey = dayKey(ts, settings.timezone).slice(0, 7);
  if (b.warn && state.budgetWarnedMonth !== mKey) {
    await patchState({ budgetWarnedMonth: mKey });
    await notify("sx-budget", "ScoreX budget warning", `You have used ${Math.round(b.pct)}% of your monthly OpenAI budget.`);
  }

  // Active hours
  const ah = activeHours(settings, ts);
  if (!ah.inside) {
    const wait = ah.opensAt - ts + randInt(1, 12) * MIN;
    await patchState({ sleepingUntil: ah.opensAt });
    return { delay: wait, why: "sleeping (outside active hours)" };
  }
  if (state.sleepingUntil) await patchState({ sleepingUntil: null });
  if (state.breakUntil && ts < state.breakUntil) return { delay: state.breakUntil - ts + randInt(5, 60) * 1000, why: "break" };

  await expireQueue(settings, ts);
  if (effectiveMode(settings, state, ts) === MODE.REVIEW) {
    for (const r of await H.byStatus(HS.QUEUED)) await H.patch(r.id, { status: HS.PENDING_REVIEW, scheduledFor: null, reason: "Moved to review (Review mode is on)" });
  }

  // X page-load budget: with no room left nothing loads an X page (the tab is not even reloaded) until loads leave
  // the rolling 24 h window.
  const pb0 = pageBudget(settings, state, ts);
  if (pb0.left < 1) return budgetWait(pb0, ts);

  // Worker tab. Its failures have their own counter (watch-page errors use softErrors, post-page retries the item's
  // own retries), so each stop counts only failures of its own kind in a row.
  const tabId = await workerTab(settings);
  if (tabId == null) {
    const n = (state.tabErrors || 0) + 1;
    await patchState({ tabErrors: n });
    if (n >= 3) { await stop(STOP.TAB_UNAVAILABLE, "Could not open or reach the x.com tab 3 times in a row"); return null; }
    return { delay: randInt(2, 4) * MIN, why: "retry tab" };
  }
  if (state.tabErrors) await patchState({ tabErrors: 0 });
  if (await stopIfAccountUnknown(settings)) return null;
  const me = String(settings.account.handle || "").toLowerCase();
  const mode = effectiveMode(settings, state, ts);
  let counts = await computeCounts(settings, ts);

  // 1) Post one due item (approved in review mode, or queued in auto mode). Every due item is tried in
  //    order, so one item blocked by its group/target limit never blocks the others.
  const targetsNow = await getTargets();
  const open = await H.openQueue();
  const due = open
    .filter((r) => (r.status === HS.APPROVED || (r.status === HS.QUEUED && mode === MODE.AUTO)) && (!r.scheduledFor || r.scheduledFor <= ts))
    .sort((a, b) => (a.scheduledFor || a.createdAt) - (b.scheduledFor || b.createdAt));
  let waitFor = null;
  for (const item of due) {
    const target = Object.hasOwn(targetsNow, item.target) ? targetsNow[item.target] : null;
    if (!target || !isActive(target, settings)) {
      const why = !target ? "Target removed" : target.enabled === false ? "Target turned off" : followStatus(target) === FS.CHECKING ? "Follow status unknown - not posted" : "Follows you now - no more comments to this account";
      await H.patch(item.id, (r) => (r.status === item.status ? { status: HS.SKIPPED, reason: why } : null));
      continue;
    }
    const gate = postGate(settings, state, { postedToday: counts.postedToday, accountsToday: counts.accountsToday, target: counts.targets[item.target] }, target, ts);
    if (gate.ok) {
      // A post needs up to 2 page loads (the post, and a look at the thread when X's confirmation is unclear).
      const room = await pageRoom(settings, 2);
      if (room.left < 2) return budgetWait(room, ts);
      const res = await postOne(item, { tabId, settings, me, counts });
      if (res === "stopped") return null;
      if (await stopIfAccountUnknown(settings)) return null;
      if (res === "budget") return budgetWait(await pageRoom(settings, 2), now());
      if (res === "aborted" || res === "moved" || res === "gone") continue;
      return { delay: humanDelay(40 * 1000, 120 * 1000), why: "after post" };
    }
    if (gate.reason === "target_day" || gate.reason === "target_week" || gate.reason === "accounts_limit") {
      await H.patch(item.id, (r) => (r.status === item.status ? { status: HS.SKIPPED, reason: GATE_LABEL[gate.reason] } : null));
      continue;
    }
    // Shared waits (gap, break) apply to every item: wait for the slot if it is close.
    if (gate.until && gate.reason !== "outside_active_hours") { waitFor = gate; break; }
  }
  if (waitFor && waitFor.until - ts < 8 * MIN) return { delay: waitFor.until - ts + randInt(5, 40) * 1000, why: GATE_LABEL[waitFor.reason] };
  if (!(await stillRunning())) return null;

  // 2) Watch for new posts and generate (unless the review queue is full). Watch pages are never loaded
  //    more often than the hard minimum interval, nor during the back-off after a failed watch load (watchRetryAt),
  //    whatever schedules the tick (a "check now", an approval, a learning check).
  // A manual "Run a check now" waits for both instead of being dropped.
  const sinceWatch = state.lastWatchAt ? ts - state.lastWatchAt : Infinity;
  const minWatchGap = HARD.minCheckIntervalSec * 1000;
  const watchWait = Math.max(minWatchGap - sinceWatch, (state.watchRetryAt || 0) - ts, 0);
  if (counts.pendingReview < settings.review.maxPending && watchWait > 0 && reason === "manual") {
    return { delay: watchWait + 1000, why: "manual" };
  }
  let revisitAt = 0; // a post about to enter the comment window: come back for it (after the idle work below)
  if (counts.pendingReview < settings.review.maxPending && watchWait <= 0) {
    const room = await pageRoom(settings, 1);
    if (room.left < 1) return budgetWait(room, ts);
    const targets = await getTargets();
    const w = await withPurpose("watch", () => watchOnce(tabId, settings, targets, ts));
    if (w.stop) { await stop(w.stop, `${w.detail || ""} (while checking ${w.source || "posts"})`); return null; }
    // Pause/Stop pressed during the check. A watch page X already loaded still counts toward the hard minimum interval.
    if (w.aborted) { if (w.loaded) await patchState({ lastWatchAt: now() }); return null; }
    if (await stopIfAccountUnknown(settings)) return null;
    if (!w.ok && w.soft === "page_budget") return budgetWait(await pageRoom(settings, 1), now()); // not an X error
    if (!w.ok) {
      // Every failed watch (any kind) counts toward the 5-in-a-row stop; "Something went wrong" pages also have their
      // own count, and only three of them in a row are the rate-limit stop. A failed load is still a watch page load:
      // lastWatchAt keeps the next one (a "check now" too) at least the hard minimum interval away, and watchRetryAt
      // keeps every earlier tick (a "check now", an approval) from reloading it before the 2-5 min back-off ends.
      const n = (state.softErrors || 0) + 1;
      const errorPages = w.soft === "error_page" ? (state.errorPageStreak || 0) + 1 : 0;
      const backoff = humanDelay(2 * MIN, 5 * MIN);
      await patchState({ softErrors: n, errorPageStreak: errorPages, lastWatchAt: now(), watchRetryAt: now() + backoff });
      log("warn", `Watch check failed (${w.soft || "unknown"})`, w.detail || "");
      if (errorPages >= 3) { await stop(STOP.RATE_LIMIT, "X kept showing 'Something went wrong' (often a temporary rate limit)"); return null; }
      if (n >= 5) { await stop(STOP.DOM_CHANGED, "Watch pages failed 5 times in a row"); return null; }
      return { delay: backoff, why: "retry after soft error" };
    }
    const emptyStreak = w.visibleEmpty ? (state.emptyStreak || 0) + 1 : 0;
    const hiddenStreak = w.hiddenEmpty ? (state.hiddenEmptyStreak || 0) + 1 : 0;
    // Adaptive cadence: watch checks in a row without a fresh target post (one about to enter the comment window
    // counts as fresh). A check that read no page (no active targets) leaves the streak as it is.
    const fresh = !!((w.posts && w.posts.length) || (w.waiting && w.waiting.length));
    const emptyWatchStreak = !w.source ? state.emptyWatchStreak || 0 : fresh ? 0 : (state.emptyWatchStreak || 0) + 1;
    await patchState({ softErrors: 0, errorPageStreak: 0, watchRetryAt: null, emptyStreak, hiddenEmptyStreak: hiddenStreak, emptyWatchStreak, ...(fresh ? { lastFreshAt: now() } : {}), lastWatchAt: now(), lastWatchSource: w.source, lastWatchScanned: w.scanned });
    if (emptyStreak >= 4) { await stop(STOP.DOM_CHANGED, "No posts rendered on watch pages 4 times in a row - X may have changed its page"); return null; }
    // X rendered nothing in the background tab: Chrome throttles long-hidden tabs, so the next check starts in a fresh
    // tab (lib/tabs.js FRESH_TAB_MS). Only when that keeps happening is the owner told.
    if (hiddenStreak) await patchState({ workerTabFreshAt: 0 });
    if (hiddenStreak === 3) await notify("sx-hidden", "ScoreX: X tab not rendering", "X showed no posts in its background tab 3 times, even in a fresh tab. Switch Settings > Worker tab and selectors > Worker tab to 'Separate window' and keep that window visible (not minimized).");
    if (w.posts.length) {
      counts = await computeCounts(settings, now());
      await handleFresh(w.posts, { settings, secrets, mode, counts, tabId, me });
      if (!(await stillRunning())) return null;
      if (await stopIfAccountUnknown(settings)) return null;
    }
    // Revisit soon if a post is about to enter the comment window (never sooner than the hard minimum interval). The
    // tick still does its idle work first: returning here starved follow-back tracking on busy watch pages.
    if (w.waiting && w.waiting.length) {
      const soonest = Math.min(...w.waiting.map((p) => p.createdAt + settings.watch.minPostAgeMin * MIN));
      const st3 = await getState();
      const at = Math.max(soonest, (st3.lastWatchAt || now()) + minWatchGap);
      if (at - now() < nextCheckMs(settings, st3)) revisitAt = at;
    }
  }

  // 2b) Catch-up: comment on accounts' latest earlier posts (from before ScoreX ran, or missed) when the
  //     queue is nearly empty, so generation happens just in time and fresh posts always go first (none while a
  //     fresh post is about to enter the window).
  if (!revisitAt && settings.watch.catchUp.enabled && (await stillRunning())) {
    const c2 = await computeCounts(settings, now());
    if (c2.openQueue < 3 && c2.pendingReview < settings.review.maxPending) {
      const cands = [];
      for (const p of catchUpCandidates(await getTargets(), settings, now(), c2)) {
        if (cands.length >= 12) break;
        if (!(await H.byPostId(p.id)).length) cands.push(p);
      }
      if (cands.length) {
        await handleFresh(cands, { settings, secrets, mode, counts: c2, tabId, me, limit: 1 });
        if (!(await stillRunning())) return null;
        if (await stopIfAccountUnknown(settings)) return null;
      }
    }
  }

  // 3) Background work when idle: queued profile refreshes, follow checks, learning checks, optional cleanup
  //    (only with room for a whole step under the page-load budget).
  let bg = null;
  if ((await stillRunning()) && (await pageRoom(settings, backgroundNeed(settings))).left >= backgroundNeed(settings)) {
    bg = await backgroundStep({ tabId, settings, me });
    if (bg && bg.stop) { await stop(bg.stop, bg.detail); return null; }
    if (await stopIfAccountUnknown(settings)) return null;
  }

  // Next tick: random check interval (stretched while targets post nothing new), earlier if a queued comment
  // becomes due. While newly added targets still wait for their follow check, or manual re-checks are queued,
  // come back a bit sooner (still a few profiles per 1.5-3 minutes).
  const st2 = await getState();
  let delay = nextCheckMs(settings, st2);
  if (bg && bg.did === "follow" && bg.checkingLeft > 0) delay = Math.min(delay, humanDelay(40 * 1000, 90 * 1000));
  if (bg && bg.did === "refresh" && (st2.pendingRefresh || []).length) delay = Math.min(delay, humanDelay(90 * 1000, 180 * 1000));
  const open2 = await H.openQueue();
  const counts2 = await computeCounts(settings, now());
  const tg2 = await getTargets();
  const postable = open2.filter((r) => (r.status === HS.APPROVED || (r.status === HS.QUEUED && mode === MODE.AUTO)) && tg2[r.target]).filter((r) => {
    const g = postGate(settings, { ...st2, nextCommentAt: 0, breakUntil: 0, lastCommentAt: 0 }, { postedToday: counts2.postedToday, accountsToday: counts2.accountsToday, target: counts2.targets[r.target] }, tg2[r.target], now());
    return g.ok || g.reason === "outside_active_hours";
  });
  const nextDue = postable.map((r) => Math.max(r.scheduledFor || 0, st2.nextCommentAt || 0, st2.breakUntil || 0)).sort((a, b) => a - b)[0];
  if (nextDue) delay = Math.min(delay, Math.max(HARD.minCheckIntervalSec * 1000, nextDue - now() + randInt(5, 30) * 1000));
  if (revisitAt) {
    const d = Math.max(0, revisitAt - now()) + randInt(10, 60) * 1000;
    if (d < delay) return { delay: d, why: "fresh post entering window" };
  }
  return { delay, why: "next check" };
}

export async function tick(reason = "alarm") {
  if (ticking) { if (reason === "manual") rerunRequested = true; return; }
  ticking = true;
  rerunRequested = false;
  try {
    const st = await getState();
    if (st.status !== STATUS.RUNNING) return;
    const res = await withLease("tick", async () => {
      await patchState({ lastTickAt: now(), tickCount: (st.tickCount || 0) + 1 });
      const [settings, secrets] = await Promise.all([getSettings(), getSecrets()]);
      if (!secrets.openaiKey) { await stop(STOP.NO_API_KEY, "Add your OpenAI API key"); return null; }
      const out = await tickBody(settings, secrets, reason);
      await patchState((s) => (s.internalErrors ? { internalErrors: 0 } : {}));
      return out;
    });
    // A "check now" / approval that arrived while this tick ran (rerunRequested) is honoured on every path.
    const manual = reason === "manual" || rerunRequested;
    if (res && res.busy) { await scheduleTick(manual ? randInt(10, 20) * 1000 : randInt(45, 90) * 1000, manual ? "manual" : "busy"); return; }
    if (await stillRunning()) {
      const settings = await getSettings();
      const d = res && res.delay ? res.delay : nextCheckMs(settings, await getState());
      if (rerunRequested) await scheduleTick(randInt(1500, 4000), "manual");
      else await scheduleTick(d, res && res.why ? res.why : "next check");
    }
  } catch (e) {
    log("error", "Tick failed: " + String((e && e.message) || e));
    const st = await patchState((s) => ({ internalErrors: (s.internalErrors || 0) + 1 }));
    if (st.internalErrors >= 5) await stop(STOP.INTERNAL, String((e && e.message) || e));
    else if (await stillRunning()) await scheduleTick(rerunRequested ? randInt(15, 30) * 1000 : randInt(2, 4) * MIN, rerunRequested ? "manual" : "retry after error");
  } finally {
    ticking = false;
    await refreshBadge().catch(() => {});
  }
}

// ---------- generation ----------

function scorePost(p, t, ts) {
  const ageMin = p.createdAt ? (ts - p.createdAt) / MIN : 10;
  const m = p.metrics || {};
  const velocity = ((m.likes || 0) + 2 * (m.replies || 0)) / Math.max(1, ageMin);
  return (Number.isFinite(t.priority) ? t.priority : 50) + (t.tier === 1 ? 15 : 0) - ageMin * 0.8 + Math.min(20, Math.log10(1 + velocity) * 10);
}

async function handleFresh(posts, ctx) {
  const { settings, secrets, mode, tabId, me } = ctx;
  const maxGen = ctx.limit || 2;
  let counts = ctx.counts;
  const ts = now();
  const targets = await getTargets();
  const state = await getState();
  const ranked = posts.map((p) => ({ p, t: Object.hasOwn(targets, p.author) ? targets[p.author] : null })).filter((x) => x.t).sort((a, b) => scorePost(b.p, b.t, ts) - scorePost(a.p, a.t, ts));
  let generatedThisTick = 0;
  for (const { p, t } of ranked) {
    if (generatedThisTick >= maxGen) break;
    if (!(await stillRunning())) return;
    const already = await H.byPostId(p.id);
    if (already.length) continue;
    // Without a post time nobody can tell whether the post is still fresh (X shows a time on every organic post;
    // a missing one is usually an ad or a page that did not render): never comment on it.
    const skip = !p.createdAt ? { text: "Post time unknown - cannot check that the post is fresh" } : skipReason(p, settings, { ts: now(), maxAgeMin: p.catchUp ? (settings.watch.catchUp.maxAgeHours || 48) * 60 : undefined });
    if (skip) {
      await H.put(H.newRecord({ status: HS.SKIPPED, reason: skip.text, mode, ...postFields(p, t), attempts: 0 }));
      continue;
    }
    const gate = generateGate(settings, state, { ...counts, target: counts.targets[t.handle] }, t, now());
    if (!gate.ok) {
      if (["daily_limit", "generation_limit"].includes(gate.reason)) { log("info", GATE_LABEL[gate.reason] + " - not generating more today"); return; }
      continue;
    }
    // In auto mode, do not pay for a comment that could only be posted after the freshness window.
    if (mode === MODE.AUTO && !p.catchUp) {
      const earliest = Math.max(now() + MIN, state.nextCommentAt || 0, state.breakUntil || 0);
      if (p.createdAt && earliest - p.createdAt > (settings.watch.maxPostAgeMin + 10) * MIN) continue;
    }
    const ok = await generateFor(p, t, { settings, secrets, mode, tabId, me });
    if (ok === "stopped") return;
    generatedThisTick++;
    counts = await computeCounts(settings, now());
  }
}

function postFields(p, t) {
  return {
    target: p.author, targetName: p.authorName || t.name || "", group: t.group, tier: t.tier, catchUp: !!p.catchUp,
    postId: p.id, postUrl: p.url, postText: truncate(p.text, 1200), postLang: p.lang || "", postCreatedAt: p.createdAt || null,
    postMetrics: p.metrics || null, postHasMedia: !!p.hasMedia, postIsQuote: !!p.isQuote,
    // Context the reply was written from (kept for Regenerate): the quoted post and the post's images.
    postQuote: p.quoted && p.quoted.text ? { author: truncate(String(p.quoted.author || ""), 40), text: truncate(p.quoted.text, 600) } : null,
    postImages: Array.isArray(p.images) ? p.images.filter((i) => i && typeof i.url === "string").slice(0, 4).map((i) => ({ url: i.url, alt: truncate(String(i.alt || ""), 300) })) : [],
  };
}

async function ensureContext(t, tabId, settings, post) {
  const stale = !t.profile || !t.profile.updatedAt || now() - t.profile.updatedAt > 7 * DAY;
  const room = !post.createdAt || now() - post.createdAt < (settings.watch.maxPostAgeMin - 5) * MIN;
  if (!stale || !room || tabId == null) return t;
  const r = await refreshProfile(tabId, t.handle, settings, { shouldStop: async () => !(await stillRunning()) });
  if (r && r.stop) return { stop: r.stop, detail: r.detail };
  if (r && r.aborted) return { aborted: true }; // Pause/Stop pressed: no visit, no comment
  const all = await getTargets();
  return all[t.handle] || t;
}

// Would one more comment on this preset (x2 for a possible regeneration) cross the monthly budget?
function budgetBlocks(settings, spend, presetKey) {
  const p = settings.presets[presetKey] || settings.presets.balanced;
  const ck = settings.presets[settings.quality.checkerPreset] || p;
  const est = estimate(settings, { modelId: p.modelId, effort: p.effort, perDay: 1, checkModelId: ck.modelId, checkEffort: ck.effort });
  return budgetStatus(settings, spend).reached || !!(est && wouldExceed(settings, spend, est.perComment * 2));
}

// Generate one comment for a post and store it (pending review or queued). Returns "stopped" on a stop.
export async function generateFor(post, target, { settings, secrets, mode, tabId, me, feedback }) {
  const preset0 = effectivePreset(target, settings);

  let t = target;
  if (tabId != null) {
    const c = await ensureContext(target, tabId, settings, post);
    if (c && c.stop) { await stop(c.stop, c.detail); return "stopped"; }
    if ((c && c.aborted) || !(await stillRunning())) return "stopped"; // Pause/Stop during the profile visit
    t = c;
    if (!isActive(t, settings)) { log("info", `Not commenting on @${t.handle}: follows you now`); return "skipped"; }
  }
  let arm = {};
  if (settings.learning.enabled && settings.learning.abTesting) {
    const learnMeta = await load(K.learning, {});
    const since = Math.max(learnMeta.abResetAt || 0, now() - 120 * DAY);
    arm = chooseArm(t, settings, await H.since(since).catch(() => []), learnMeta.abResetAt || 0);
  }
  const tone = arm.tone ? effectiveTone(t, settings, arm.tone) : effectiveTone(t, settings);
  const presetKey = arm.preset || preset0;
  if (!(await stillRunning())) return "stopped"; // paused or stopped meanwhile: no OpenAI call
  if (budgetBlocks(settings, await getSpend(), presetKey)) { await stop(STOP.BUDGET, "The next comment would exceed your monthly budget"); return "stopped"; }
  // Repetition is checked against comments still waiting in the queue too, not only posted ones (newest first).
  const previous = await recentComments();
  const g = await generate({
    settings, apiKey: secrets.openaiKey, target: t, post, tone, presetKey, previous,
    bestComments: await bestComments(), myHandle: me, compatFor: await compatLoader(), onCall: await onCallFactory(settings), feedback,
    ownerEdits: await ownerEdits(settings),
  });
  const base = H.newRecord({
    mode, ...postFields(post, t), tone: tone.key, toneText: truncate(tone.text, 300), preset: presetKey,
    modelId: g.model && g.model.id, modelName: g.model && g.model.name, effort: g.model && g.model.reasoning ? g.effort : "none",
    fallbackUsed: g.fallbackUsed, abArm: arm.key || null, abExplore: !!arm.explore,
    calls: g.calls, attempts: g.attempts, quality: g.quality,
  });
  if (g.stop) {
    await H.put({ ...base, status: HS.FAILED, reason: (g.error && g.error.message) || g.stop });
    await stop(g.stop, (g.error && g.error.message) || "");
    return "stopped";
  }
  if (g.skipped) { await H.put({ ...base, status: HS.SKIPPED, reason: g.skipped.text }); log("info", `Skipped @${post.author}: ${g.skipped.text}`); return "skipped"; }
  if (!g.ok) { await H.put({ ...base, status: HS.FAILED, reason: "OpenAI: " + ((g.error && g.error.message) || "error") }); log("warn", `Generation failed for @${post.author}`, g.error && g.error.message); return "failed"; }

  const st = await getState();
  const liveMode = effectiveMode(await getSettings(), st);
  // Only a post with a known time is queued for auto posting (its freshness window can expire the item).
  if (mode === MODE.AUTO && liveMode === MODE.AUTO && post.createdAt && !(g.quality && g.quality.needsReview)) {
    const when = Math.max(now() + humanDelay(45 * 1000, 150 * 1000), st.nextCommentAt || 0, st.breakUntil || 0);
    await H.put({ ...base, comment: g.comment, originalComment: g.comment, status: HS.QUEUED, scheduledFor: when });
    log("info", `Queued a comment for @${post.author} (posts in ~${fmtDuration(when - now())})`);
  } else {
    await H.put({ ...base, comment: g.comment, originalComment: g.comment, status: HS.PENDING_REVIEW });
    log("info", `New comment for @${post.author} is waiting for your review`);
    if (settings.review.notifyNew) await notify("sx-review", "ScoreX: comment ready for review", `@${post.author}: ${truncate(post.text, 90)}\n\nReply: ${truncate(g.comment, 120)}`);
  }
  await refreshBadge();
  return "ok";
}

// ---------- posting ----------

async function postOne(rec, { tabId, settings, me, counts }) {
  const state = await getState();
  if (rec.status === HS.QUEUED && effectiveMode(await getSettings(), state) !== MODE.AUTO) {
    await H.patch(rec.id, { status: HS.PENDING_REVIEW, scheduledFor: null, reason: "Moved to review (Review mode is on)" });
    return "moved";
  }
  const allowLike = likeLimit(settings) > counts.likedToday;
  if (!(await stillRunning())) return "aborted";
  // Compare-and-set: only claim the item if it is still in the state we picked it in (the user may have
  // skipped or edited it a moment ago), and post the freshly read text.
  const prevStatus = rec.status;
  let claimed = null;
  await H.patch(rec.id, (r) => {
    if (r.status !== prevStatus) return null;
    claimed = r;
    return { status: HS.POSTING, attemptAt: now() };
  });
  if (!claimed) return "gone";
  const shouldStop = async () => !(await stillRunning());
  // Follow first: a target you do not follow is followed on its post page right before the reply (within the cap).
  const tgt = (await getTargets())[rec.target];
  const pctx = { tabId, settings, me, allowLike, shouldStop, followFirst: !!(tgt && wantsFollow(tgt, settings) && followRoom(settings, state) > 0) };
  const r = await postReply(claimed, pctx);
  if (pctx.followResult) await recordFollow(rec.target, pctx.followResult);
  const ts = now();
  if (r.aborted) {
    await H.patch(rec.id, { status: prevStatus, reason: "Posting interrupted by Pause/Stop - not posted", ...(r.liked ? { liked: true, likedAt: ts } : {}) });
    log("info", `Posting to @${rec.target} interrupted by you before submitting`);
    return "aborted";
  }
  // The X page-load budget refused the post page (nothing was loaded): the item waits, nothing failed.
  if (r.budget || (r.fail && /page_budget/.test(String(r.reason || "")))) {
    await H.patch(rec.id, { status: prevStatus, reason: GATE_LABEL.footprint, ...(r.liked ? { liked: true, likedAt: ts } : {}) });
    return "budget";
  }
  // The logged-in account could not be read: nothing was typed or sent. The item waits (not a post failure);
  // ACCOUNT_UNKNOWN_MAX unreadable page loads in a row stop the engine.
  if (r.soft === "account_unknown") {
    await H.patch(rec.id, { status: prevStatus, reason: STOP_LABEL[STOP.ACCOUNT_UNKNOWN], ...(r.liked ? { liked: true, likedAt: ts } : {}) });
    await patchState({ nextCommentAt: ts + humanDelay(2 * MIN, 4 * MIN) });
    if (await stopIfAccountUnknown(settings)) return "stopped";
    return "retry";
  }
  if (r.retry) {
    // Counted on the item only (3 tries): a page that did not render is not an X error, so it never feeds the
    // watch-error counter behind the rate-limit / changed-page stops.
    const retries = (claimed.retries || 0) + 1;
    if (retries >= 3) await H.patch(rec.id, { status: HS.FAILED, retries, reason: "The post page did not load 3 times (" + r.reason + ")" });
    else await H.patch(rec.id, { status: prevStatus, retries, scheduledFor: ts + humanDelay(3 * MIN, 6 * MIN), reason: "Will retry: " + r.reason });
    await patchState({ nextCommentAt: ts + humanDelay(2 * MIN, 4 * MIN) });
    log("warn", `The post page for @${rec.target} did not load (${r.reason})`);
    return "retry";
  }
  if (r.ok) {
    await H.patch(rec.id, { status: HS.POSTED, postedAt: ts, replyUrl: r.replyUrl || "", replyId: r.replyId || "", liked: !!r.liked, likedAt: r.liked ? ts : null, reason: r.already ? "Reply was already in the thread" : "" });
    await patchState({ ...afterPost(settings, state, ts), consecutiveFailures: 0, lastLikeAt: r.liked ? ts : state.lastLikeAt, internalErrors: 0 });
    await updateTargets((all) => {
      const t = all[rec.target];
      if (t) {
        t.stats = t.stats || {};
        t.stats.comments = (t.stats.comments || 0) + 1;
        t.stats.lastCommentAt = ts;
        if (!t.stats.firstCommentAt) t.stats.firstCommentAt = ts; // starts the follow-back window
      }
      return all;
    });
    log("info", `Posted a reply to @${rec.target}${r.liked ? " (and liked the post)" : ""}`);
    await refreshBadge(); // the icon counts posted replies
    return "posted";
  }
  if (r.stop) {
    // unsure: the stop came after the Reply click without a clear rejection, so the reply may be on X (counts
    // toward every limit, like an unconfirmed post).
    await H.patch(rec.id, { status: HS.FAILED, reason: STOP_LABEL[r.stop] || r.stop, liked: !!r.liked, likedAt: r.liked ? ts : null, ...(r.unsure ? { maybePosted: true, replyUrl: r.replyUrl || "" } : {}) });
    await stop(r.stop, r.detail);
    return "stopped";
  }
  if (r.skip) {
    await H.patch(rec.id, { status: HS.SKIPPED, reason: r.reason, liked: !!r.liked, likedAt: r.liked ? ts : null });
    log("info", `Skipped posting to @${rec.target}: ${r.reason}`);
    return "skipped";
  }
  const n = (state.consecutiveFailures || 0) + 1;
  // maybePosted: X may have accepted it (composer cleared, no confirmation) -> counts toward limits.
  await H.patch(rec.id, { status: HS.FAILED, reason: r.reason || "post failed", liked: !!r.liked, likedAt: r.liked ? ts : null, maybePosted: !!r.unsure });
  await patchState({ consecutiveFailures: n, nextCommentAt: ts + humanDelay(3 * MIN, 6 * MIN) });
  log("warn", `Posting to @${rec.target} failed: ${r.reason}`);
  if (n >= settings.safety.maxConsecutiveFailures) { await stop(STOP.POST_FAILURES, `${n} posting failures in a row (last: ${r.reason})`); return "stopped"; }
  return "failed";
}

// ---------- background work ----------

// Manual re-checks (Targets > Re-check, state.pendingRefresh) never starve follow tracking: while X's "Follows you"
// badge is not verified, the follow step (its followers-list scan is the badge canary) always runs first; otherwise
// re-checks and the rest of the background work take turns (state.lastBackground). Re-checks also run whenever the
// rest has nothing to do.
async function backgroundStep({ tabId, settings, me }) {
  const shouldStop = async () => !(await stillRunning());
  const st = await getState();
  const pending = Array.isArray(st.pendingRefresh) && st.pendingRefresh.length > 0;
  if (pending && st.lastBackground !== "refresh" && badgeTrusted(st, now())) { const rr = await refreshStep({ tabId, settings, shouldStop }); await pruneFollowers(settings); return rr; }
  const r = await routineBackground({ tabId, settings, me, shouldStop });
  if (r && r.stop) return r;
  if (r && r.did) { if (st.lastBackground !== "routine") await patchState({ lastBackground: "routine" }); return r; }
  if (pending && !(await shouldStop())) { const rr = await refreshStep({ tabId, settings, shouldStop }); await pruneFollowers(settings); return rr; }
  return null;
}

// Follow tracking, conversation alerts, engagement checks and cleanup, first one with something to do.
async function routineBackground({ tabId, settings, me, shouldStop }) {
  {
    const r = await withPurpose("follow", () => followStep({ tabId, settings, me, shouldStop }));
    await pruneFollowers(settings);
    if (r && r.stop) return r;
    if (r && r.did) return r;
  }
  if (await shouldStop()) return null;
  if (settings.learning.conversations && settings.learning.conversations.enabled) {
    const r = await withPurpose("mentions", () => conversationsStep({ tabId, settings, me, shouldStop }));
    if (r && r.stop) return r;
    if (r && r.did) return r;
  }
  if (await shouldStop()) return null;
  if (settings.learning.enabled || (settings.safety.reach && settings.safety.reach.enabled)) {
    const r = await withPurpose("check", () => learningStep({ tabId, settings, me, shouldStop }));
    if (r && r.stop) return r;
    if (r && r.did) return r;
  }
  // Follow first from a profile: only when follow tracking, alerts and engagement checks had nothing to do.
  if (settings.follow.followFirst && !(await shouldStop())) {
    const r = await withPurpose("follow", () => followFirstStep({ tabId, settings, me, shouldStop }));
    if (r && r.stop) return r;
    if (r && r.did) return r;
  }
  if (settings.cleanup.enabled) {
    if (await shouldStop()) return null;
    const r = await withPurpose("follow", () => cleanupStep({ tabId, settings, me, shouldStop }));
    if (r && r.stop) return r;
    if (r && r.did) return r;
  }
  return null;
}

// Up to follow.checksPerRun queued re-checks, a few seconds apart (taken from the queue atomically, so re-checks
// queued meanwhile are kept).
async function refreshStep({ tabId, settings, shouldStop }) {
  let visits = 0;
  for (let i = 0; i < settings.follow.checksPerRun; i++) {
    if (i && (await shouldStop())) break;
    let h = null;
    await patchState((s) => {
      const list = Array.isArray(s.pendingRefresh) ? s.pendingRefresh : [];
      h = list[0] || null;
      return { pendingRefresh: list.slice(1), lastBackground: "refresh" };
    });
    if (!h) break;
    if (i) await sleep(humanDelay(3000, 8000));
    const r = await withPurpose("profile", () => refreshProfile(tabId, h, settings, { shouldStop }));
    if (r && r.stop) return r;
    if (r && (r.aborted || r.budget || r.soft === "page_budget")) {
      // Not visited (Pause/Stop, or the page-load budget): it stays first in the queue.
      await patchState((s) => ({ pendingRefresh: [h, ...(s.pendingRefresh || []).filter((x) => x !== h)] }));
      break;
    }
    visits++;
  }
  return { did: "refresh", visits };
}

// ---------- review actions (from the dashboard) ----------

export async function reviewAction(msg) {
  const res = await reviewActionInner(msg);
  await refreshBadge().catch(() => {});
  return res;
}

// Records with a Regenerate running in this worker: a second request (another dashboard visit or window) is refused
// instead of paying for a second generation of the same reply.
const regenerating = new Set();

async function reviewActionInner({ id, action, text }) {
  if (action === "regenerate") {
    if (regenerating.has(id)) return { ok: false, error: "A new reply is already being written for this post" };
    regenerating.add(id);
    try { return await reviewActionCore({ id, action, text }); } finally { regenerating.delete(id); }
  }
  return reviewActionCore({ id, action, text });
}

async function reviewActionCore({ id, action, text }) {
  const rec = await H.get(id);
  if (!rec) return { ok: false, error: "Item not found" };
  const editable = [HS.PENDING_REVIEW, HS.APPROVED, HS.QUEUED].includes(rec.status);
  if (!editable && action !== "skip") return { ok: false, error: `Item is already ${rec.status}` };
  const clean = typeof text === "string" ? text.trim() : null;
  if (clean != null && weightedLength(clean) > HARD.maxCommentChars) return { ok: false, error: `Comment is longer than X allows (${HARD.maxCommentChars}; CJK characters and emoji count double)` };
  const edits = clean != null && clean !== rec.comment ? { comment: clean, edited: true, originalComment: rec.originalComment || rec.comment } : {};
  // Compare-and-set against the status we saw, so a click never overwrites an item that started posting.
  const cas = async (fields) => {
    const r = await H.patch(id, (cur) => ([HS.PENDING_REVIEW, HS.APPROVED, HS.QUEUED].includes(cur.status) ? fields : null));
    return r ? { ok: true, record: r } : { ok: false, error: "The item is being posted or was already handled" };
  };
  if (action === "save") return cas(edits);
  if (action === "skip") {
    if (!editable) return { ok: false, error: `Item is already ${rec.status}` };
    return cas({ status: HS.SKIPPED, reason: "Skipped by you" });
  }
  if (action === "approve") {
    if (!(clean != null ? clean : rec.comment)) return { ok: false, error: "Comment is empty" };
    const res = await cas({ ...edits, status: HS.APPROVED, approvedAt: now(), scheduledFor: now() });
    if (!res.ok) return res;
    const r = res.record;
    const st = await getState();
    // requestTick: a tick running right now would replace a plain timer with its own schedule.
    if (st.status === STATUS.RUNNING) await requestTick(randInt(15, 45) * 1000, "approved item");
    await refreshBadge();
    return { ok: true, record: r };
  }
  if (action === "regenerate") {
    const [settings, secrets, targets] = await Promise.all([getSettings(), getSecrets(), getTargets()]);
    if (!secrets.openaiKey) return { ok: false, error: "Add your OpenAI API key first" };
    if (budgetBlocks(settings, await getSpend(), rec.preset || "balanced")) return { ok: false, error: "Monthly OpenAI budget reached - raise it in Models & Costs to regenerate" };
    const t = targets[rec.target] || { handle: rec.target, group: rec.group, tier: rec.tier, name: rec.targetName, recentPosts: [], profile: null, tone: "", preset: "" };
    const post = { id: rec.postId, url: rec.postUrl, author: rec.target, authorName: rec.targetName, text: rec.postText, lang: rec.postLang, createdAt: rec.postCreatedAt, metrics: rec.postMetrics, hasMedia: rec.postHasMedia, isQuote: rec.postIsQuote, quoted: rec.postQuote || null, images: rec.postImages || [] };
    const tone = rec.tone ? effectiveTone(t, settings, rec.tone) : effectiveTone(t, settings);
    const previous = [rec.comment, ...(await recentComments(rec.id))].filter(Boolean);
    const g = await generate({
      settings, apiKey: secrets.openaiKey, target: t, post, tone, presetKey: rec.preset || effectivePreset(t, settings), previous,
      bestComments: await bestComments(), myHandle: settings.account.handle, compatFor: await compatLoader(), onCall: await onCallFactory(settings),
      feedback: "The owner asked for a different reply. Use a different angle and opening than: " + truncate(rec.comment, 200),
      ownerEdits: await ownerEdits(settings),
    });
    // The record may have changed while the model was thinking (approved, posted, skipped): always keep the
    // cost of the new calls, but only replace the comment if it is still waiting in the same state.
    const addCalls = (cur) => ({ calls: [...(cur.calls || []), ...g.calls], attempts: (cur.attempts || 0) + g.attempts });
    if (g.stop) { await H.patch(id, addCalls); await stop(g.stop, g.error && g.error.message); return { ok: false, error: "OpenAI: " + ((g.error && g.error.message) || g.stop) }; }
    if (!g.ok) {
      await H.patch(id, addCalls);
      return { ok: false, error: g.skipped ? g.skipped.text : "OpenAI: " + ((g.error && g.error.message) || "error") };
    }
    let changed = false;
    const r = await H.patch(id, (cur) => {
      if (cur.status !== rec.status) { changed = true; return addCalls(cur); }
      return { ...addCalls(cur), comment: g.comment, originalComment: g.comment, edited: false, quality: g.quality, modelId: g.model.id, modelName: g.model.name, effort: g.model.reasoning ? g.effort : "none", fallbackUsed: g.fallbackUsed, status: HS.PENDING_REVIEW, approvedAt: null, scheduledFor: null };
    });
    if (changed) return { ok: false, error: `The item changed while regenerating (now ${r && r.status}); the new text was not applied`, record: r };
    return { ok: true, record: r };
  }
  return { ok: false, error: "Unknown action" };
}

// Acts only on the ids the user was shown (never on items generated while a confirm dialog was open).
export async function reviewBulk(action, ids) {
  if (!Array.isArray(ids)) return { ok: false, error: "No items given" };
  const want = new Set(ids);
  const items = (await H.byStatus(HS.PENDING_REVIEW)).filter((r) => want.has(r.id));
  let n = 0;
  for (const r of items) {
    const res = await reviewActionInner({ id: r.id, action });
    if (res.ok) n++;
  }
  await refreshBadge();
  return { ok: true, count: n };
}

// ---------- manual re-checks (Targets > Re-check follow status) ----------

const REFRESH_NOW_MAX = 25; // profiles visited right away while the engine is not running (the rest wait for it)
const PENDING_REFRESH_MAX = 500;
let refreshJob = null; // { kind, abort, handover, queue } - the re-check running now while the engine is not running

async function queueRefresh(list) {
  if (!list.length) return;
  await patchState((s) => ({ pendingRefresh: [...new Set([...(s.pendingRefresh || []), ...list])].slice(0, PENDING_REFRESH_MAX) }));
}

// Running engine: re-checks are queued for its idle steps (backgroundStep). Otherwise they run now in the
// background under the job lease, 5-12 s apart. Pause/Stop abort that job (its own abort token, so a later click
// can never undo a Stop); a later request while it runs adds its handles to it; Start hands its rest to the engine.
export async function refreshTargetsNow(handles) {
  const list = [...new Set((Array.isArray(handles) ? handles : []).map(normalizeHandle).filter(Boolean))];
  if (!list.length) return { ok: true, queued: 0, when: "now" };
  const st = await getState();
  if (st.status === STATUS.RUNNING) {
    await queueRefresh(list);
    return { ok: true, queued: list.length, when: "next idle check" };
  }
  // After a safety stop (captcha, warning, rate limit...) nothing drives the X tab until you resume.
  if (safetyStopped(st)) {
    await queueRefresh(list);
    return { ok: true, queued: list.length, when: "after you resume (ScoreX was stopped by a safety check)" };
  }
  let job = refreshJob && !refreshJob.abort ? refreshJob : null;
  const fresh = !job;
  if (fresh) { job = backgroundJob("refresh"); job.queue = []; job.handover = false; }
  const room = Math.max(0, REFRESH_NOW_MAX - job.queue.length);
  const nowList = list.filter((h) => !job.queue.includes(h)).slice(0, room);
  job.queue.push(...nowList);
  const later = list.filter((h) => !job.queue.includes(h));
  await queueRefresh(later);
  if (fresh) {
    refreshJob = job;
    runRefreshJob(job)
      .catch((e) => log("error", "Refresh failed: " + String((e && e.message) || e)))
      .finally(() => { endBackgroundJob(job); if (refreshJob === job) refreshJob = null; });
  }
  return { ok: true, queued: list.length, when: later.length ? `${nowList.length} now, the rest while running` : "now" };
}

async function runRefreshJob(job) {
  const until = now() + 3 * MIN; // the X tab may be busy (a discovery, a self-test): wait up to 3 minutes for it
  for (;;) {
    if (job.abort) break;
    const r = await withLease("refresh", async () => {
      const settings = await getSettings();
      const tabId = await workerTab(settings);
      if (tabId == null) { log("warn", "Re-check: could not open the X tab - the re-checks wait for the next check while running"); return { keep: true }; }
      let first = true;
      while (job.queue.length && !job.abort) {
        if (!first) await sleep(humanDelay(5000, 12000));
        first = false;
        if (job.abort) break;
        const h = job.queue.shift();
        const p = await refreshProfile(tabId, h, settings, { shouldStop: async () => job.abort });
        if (p && p.stop) { job.queue.length = 0; await stop(p.stop, p.detail); return {}; }
        if (p && p.aborted) { job.queue.unshift(h); break; }
        if (p && (p.budget || p.soft === "page_budget")) { job.queue.unshift(h); log("info", "Re-check paused: " + GATE_LABEL.footprint); return { keep: true }; }
        if (await stopIfAccountUnknown(settings)) { job.queue.length = 0; return {}; }
      }
      return {};
    });
    if (r && r.busy && !job.abort) {
      if (now() < until) { await sleep(5000); continue; }
      log("warn", "Re-check: ScoreX was busy in the X tab for 3 minutes - the re-checks wait for the next idle check");
      await queueRefresh(job.queue.splice(0));
      return;
    }
    if (r && r.keep) await queueRefresh(job.queue.splice(0));
    break;
  }
  if (job.abort) {
    if (job.handover) await queueRefresh(job.queue.splice(0)); // Start/Resume: the engine continues them
    else if (job.queue.length) log("info", "Profile refresh stopped by you");
    job.queue.length = 0;
  }
}

// Start/Resume: a running re-check job hands its remaining handles to the engine's queue.
function handoverRefresh() {
  for (const j of backgroundJobs) if (j.kind === "refresh") { j.handover = true; j.abort = true; }
}

export const _test = { backgroundStep, expireQueue, handleFresh, postOne, heldLeases, get refreshJob() { return refreshJob; } };

export { recordOutcomeForTarget };
