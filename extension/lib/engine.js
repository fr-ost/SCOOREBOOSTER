// ScoreX - the engine: start / pause / resume / stop, the randomized tick, auto-stop, review actions.
// All state lives in chrome.storage + IndexedDB, so a sleeping/restarted service worker continues
// exactly where it left off. A job lease in state.job prevents overlapping work.

import { STATUS, MODE, HS, STOP, STOP_LABEL, ALARM, K, HARD, OPEN_STATUSES } from "./constants.js";
import { getSettings, getSecrets, getState, patchState, getTargets, updateTargets, log, load } from "./store.js";
import { now, DAY, MIN, dayKey, humanDelay, randInt, uid, truncate, fmtDuration } from "./util.js";
import * as H from "./history.js";
import { recordSpend, getSpend, budgetStatus, wouldExceed, estimate, usageStats, modelById } from "./costs.js";
import { warmup, effectiveMode, dailyLimit, groupLimit, generationLimit, likeLimit, activeHours, afterPost, nextCheckMs, postGate, generateGate, GATE_LABEL, rampStage, daysSinceStart } from "./safety.js";
import { skipReason } from "./filters.js";
import { effectiveTone, effectivePreset, isActive } from "./targets.js";
import { generate } from "./generator.js";
import { workerTab, releaseGuard } from "./tabs.js";
import { watchOnce, refreshProfile } from "./watcher.js";
import { postReply } from "./poster.js";
import { notify, setBadge } from "./notify.js";
import { chooseArm, learningStep, recordOutcomeForTarget } from "./learning.js";
import { cleanupStep } from "./cleanup.js";

const SAFETY_STOPS = new Set(Object.values(STOP).filter((s) => s !== STOP.USER));
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

// Called once when a (new) service worker instance starts: nothing can be running in this instance
// yet, so a job lease in storage belongs to a worker that was killed mid-job.
export async function onWorkerStart() {
  const st = await getState();
  if (st.job) await patchState({ job: null });
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
  // A job lease far past its expiry means a worker died mid-job.
  if (st.job && st.job.leaseUntil < now()) await patchState({ job: null });
  const a = await chrome.alarms.get(ALARM.TICK).catch(() => null);
  if (!a && (!st.nextTickAt || st.nextTickAt < now() - MIN)) await scheduleTick(randInt(5000, 15000), "watchdog");
}

// ---------- lease ----------

async function acquireLease(kind, ms = 12 * MIN) {
  let got = false;
  const id = uid("j");
  await patchState((s) => {
    if (s.job && s.job.leaseUntil > now()) return {};
    got = true;
    return { job: { id, kind, startedAt: now(), leaseUntil: now() + ms } };
  });
  return got ? id : null;
}
async function releaseLease(id) {
  await patchState((s) => (s.job && s.job.id === id ? { job: null } : {}));
}
export async function withLease(kind, fn, ms) {
  const id = await acquireLease(kind, ms);
  if (!id) return { ok: false, busy: true };
  keepAlive(true);
  try { return await fn(); } finally { await releaseLease(id); keepAlive(false); }
}

// ---------- status ----------

export async function computeCounts(settings, ts = now()) {
  const tz = settings.timezone;
  const today = dayKey(ts, tz);
  const recent = await H.since(ts - 8 * DAY);
  const open = await H.openQueue();
  const c = { postedToday: 0, postedGroup: { A: 0, B: 0 }, generatedToday: 0, likedToday: 0, skippedToday: 0, failedToday: 0, costToday: 0,
    openQueue: 0, openGroup: { A: 0, B: 0 }, pendingReview: 0, queued: 0, targets: {} };
  const tgt = (h) => (c.targets[h] ||= { day: 0, week: 0, open: 0 });
  for (const r of recent) {
    if (dayKey(r.createdAt, tz) === today) {
      if (r.attempts > 0) c.generatedToday++;
      c.costToday += r.cost || 0;
      if (r.status === HS.SKIPPED && r.attempts > 0) c.skippedToday++;
      if (r.status === HS.FAILED) c.failedToday++;
    }
    if (r.liked && r.likedAt && dayKey(r.likedAt, tz) === today) c.likedToday++;
    if (r.status === HS.POSTED && r.postedAt) {
      if (dayKey(r.postedAt, tz) === today) { c.postedToday++; c.postedGroup[r.group] = (c.postedGroup[r.group] || 0) + 1; tgt(r.target).day++; }
      if (ts - r.postedAt < 7 * DAY) tgt(r.target).week++;
    }
  }
  for (const r of open) {
    c.openQueue++;
    c.openGroup[r.group] = (c.openGroup[r.group] || 0) + 1;
    tgt(r.target).open++;
    if (r.status === HS.PENDING_REVIEW) c.pendingReview++;
    if (r.status === HS.QUEUED || r.status === HS.APPROVED) c.queued++;
  }
  return c;
}

export async function getStatus() {
  const ts = now();
  const [settings, state, secrets, targets, spend] = await Promise.all([getSettings(), getState(), getSecrets(), getTargets(), getSpend()]);
  const c = await computeCounts(settings, ts);
  const total = dailyLimit(settings, state, ts);
  const b = budgetStatus(settings, spend, ts);
  const all = Object.values(targets);
  const ah = activeHours(settings, ts);
  let label = state.status === STATUS.RUNNING ? "Running" : state.status === STATUS.PAUSED ? "Paused" : "Stopped";
  if (state.status === STATUS.STOPPED && state.stopReason && state.stopReason !== STOP.USER) label += ` (${STOP_LABEL[state.stopReason] || state.stopReason})`;
  let sub = "";
  if (state.status === STATUS.RUNNING) {
    if (!ah.inside) sub = `Sleeping until ${new Date(ah.opensAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} (outside active hours)`;
    else if (state.breakUntil && state.breakUntil > ts) sub = `On a break for ${fmtDuration(state.breakUntil - ts)}`;
    else if (state.nextTickAt) sub = `Next check in ${fmtDuration(Math.max(0, state.nextTickAt - ts))}`;
  }
  return {
    state: { ...state },
    label,
    sub,
    effectiveMode: effectiveMode(settings, state, ts),
    warmup: warmup(state, ts),
    today: {
      posted: c.postedToday, limit: total, postedGroup: c.postedGroup,
      groupLimits: { A: groupLimit(settings, "A", total), B: groupLimit(settings, "B", total) },
      generated: c.generatedToday, generationLimit: generationLimit(settings, state, ts),
      liked: c.likedToday, likeLimit: likeLimit(settings), skipped: c.skippedToday, failed: c.failedToday,
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
  };
}

export async function refreshBadge() {
  const st = await getState();
  const open = await H.byStatus(HS.PENDING_REVIEW).catch(() => []);
  await setBadge(st, open.length);
}

// ---------- control ----------

export async function start() {
  const [settings, secrets, targets, st] = await Promise.all([getSettings(), getSecrets(), getTargets(), getState()]);
  if (!secrets.openaiKey) return { ok: false, error: "Add your OpenAI API key first (Models & Costs)." };
  if (!settings.account.handle) return { ok: false, error: "Set your X handle first (Settings)." };
  const active = Object.values(targets).filter((t) => isActive(t, settings));
  if (!active.length) return { ok: false, error: "Add at least one enabled target first (Targets)." };
  if (settings.watch.strategy === "list" && !settings.watch.listUrls.length) log("warn", "Watch strategy is 'X List' but no list URL is set - using batched search instead.");
  const ts = now();
  await patchState({
    status: STATUS.RUNNING, stopReason: null, stopDetail: "", alert: null, startedAt: ts,
    firstStartedAt: st.firstStartedAt || ts, consecutiveFailures: 0, softErrors: 0, job: null,
  });
  if (!st.firstStartedAt) log("info", `First start. Warm-up: review mode is forced for ${HARD.warmupDays} days.`);
  log("info", "Started");
  await scheduleTick(randInt(4000, 12000), "start");
  await ensureAlarms();
  await refreshBadge();
  return { ok: true };
}

export async function pause() {
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
  if (st.status === STATUS.STOPPED) return start();
  await patchState({ status: STATUS.RUNNING, alert: null, consecutiveFailures: 0, softErrors: 0 });
  log("info", "Resumed");
  await scheduleTick(randInt(3000, 10000), "resume");
  await refreshBadge();
  return { ok: true };
}

// Stop the engine. Safety reasons raise a notification + red badge and need a manual resume.
export async function stop(reason = STOP.USER, detail = "") {
  const label = STOP_LABEL[reason] || reason;
  const safety = SAFETY_STOPS.has(reason);
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
  await scheduleTick(1500, "manual");
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

async function bestComments(n = 20) {
  const posted = await H.recentPosted(200);
  return posted.filter((r) => r.results && r.results.likes > 0).sort((a, b) => (b.results.likes || 0) - (a.results.likes || 0)).slice(0, n).map((r) => r.comment);
}

// Expire open items that are too old to be worth posting.
async function expireQueue(settings, ts = now()) {
  const open = await H.openQueue();
  for (const r of open) {
    let why = "";
    if (r.status === HS.PENDING_REVIEW && ts - r.createdAt > settings.review.pendingMaxAgeMin * MIN) why = "Expired while waiting for review";
    if (r.status === HS.APPROVED && ts - (r.approvedAt || r.createdAt) > settings.review.approvedMaxAgeMin * MIN) why = "Approved but expired before a posting slot";
    if (r.status === HS.QUEUED && r.postCreatedAt && ts - r.postCreatedAt > (settings.watch.maxPostAgeMin + 25) * MIN) why = "Too late to post (post is no longer fresh)";
    if (r.status === HS.POSTING && ts - (r.attemptAt || r.updatedAt) > 10 * MIN) why = "Interrupted while posting - check the post manually";
    if (why) await H.patch(r.id, { status: r.status === HS.POSTING ? HS.FAILED : HS.SKIPPED, reason: why });
  }
}

// Main loop body. Returns the delay until the next tick.
async function tickBody(settings, secrets) {
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

  // Worker tab
  const tabId = await workerTab(settings);
  if (tabId == null) {
    const n = (state.softErrors || 0) + 1;
    await patchState({ softErrors: n });
    if (n >= 3) { await stop(STOP.TAB_UNAVAILABLE, "Could not open or reach the x.com tab 3 times in a row"); return null; }
    return { delay: randInt(2, 4) * MIN, why: "retry tab" };
  }
  const me = String(settings.account.handle || "").toLowerCase();
  const mode = effectiveMode(settings, state, ts);
  let counts = await computeCounts(settings, ts);

  // 1) Post one due item (approved in review mode, or queued in auto mode).
  const open = await H.openQueue();
  const due = open
    .filter((r) => (r.status === HS.APPROVED || (r.status === HS.QUEUED && mode === MODE.AUTO)) && (!r.scheduledFor || r.scheduledFor <= ts))
    .sort((a, b) => (a.scheduledFor || a.createdAt) - (b.scheduledFor || b.createdAt))[0];
  if (due) {
    const targets = await getTargets();
    const target = targets[due.target] || { group: due.group, tier: due.tier };
    const gate = postGate(settings, state, { postedToday: counts.postedToday, postedGroup: counts.postedGroup, target: counts.targets[due.target] }, target, ts);
    if (gate.ok) {
      const res = await postOne(due, { tabId, settings, me, counts });
      if (res === "stopped") return null;
      return { delay: humanDelay(40 * 1000, 120 * 1000), why: "after post" };
    }
    if (gate.reason === "target_day" || gate.reason === "target_week") {
      await H.patch(due.id, { status: HS.SKIPPED, reason: GATE_LABEL[gate.reason] });
    } else if (gate.until && gate.until - ts < 8 * MIN && gate.reason !== "outside_active_hours") {
      // Nearly time: wait for the slot instead of browsing more.
      return { delay: gate.until - ts + randInt(5, 40) * 1000, why: GATE_LABEL[gate.reason] };
    }
  }
  if (!(await stillRunning())) return null;

  // 2) Watch for new posts and generate (unless the review queue is full).
  if (counts.pendingReview < settings.review.maxPending) {
    const targets = await getTargets();
    const w = await watchOnce(tabId, settings, targets, ts);
    if (w.stop) { await stop(w.stop, `${w.detail || ""} (while checking ${w.source || "posts"})`); return null; }
    if (!w.ok) {
      const n = (state.softErrors || 0) + 1;
      await patchState({ softErrors: n });
      log("warn", `Watch check failed (${w.soft || "unknown"})`, w.detail || "");
      if (w.soft === "error_page" && n >= 3) { await stop(STOP.RATE_LIMIT, "X kept showing 'Something went wrong' (often a temporary rate limit)"); return null; }
      if (n >= 5) { await stop(STOP.DOM_CHANGED, "Watch pages failed 5 times in a row"); return null; }
      return { delay: humanDelay(2 * MIN, 5 * MIN), why: "retry after soft error" };
    }
    const emptyStreak = w.visibleEmpty ? (state.emptyStreak || 0) + 1 : 0;
    const hiddenStreak = w.hiddenEmpty ? (state.hiddenEmptyStreak || 0) + 1 : 0;
    await patchState({ softErrors: 0, emptyStreak, hiddenEmptyStreak: hiddenStreak, lastWatchAt: now(), lastWatchSource: w.source, lastWatchScanned: w.scanned });
    if (emptyStreak >= 4) { await stop(STOP.DOM_CHANGED, "No posts rendered on watch pages 4 times in a row - X may have changed its page"); return null; }
    if (hiddenStreak === 3) await notify("sx-hidden", "ScoreX: X tab not rendering", "X showed no posts while its tab was hidden. Open Settings > Advanced and switch to 'separate window', or enable 'bring X tab to front'.");
    if (w.posts.length) {
      counts = await computeCounts(settings, now());
      await handleFresh(w.posts, { settings, secrets, mode, counts, tabId, me });
      if (!(await stillRunning())) return null;
    }
    // Revisit soon if a post is about to enter the comment window.
    if (w.waiting && w.waiting.length) {
      const soonest = Math.min(...w.waiting.map((p) => p.createdAt + settings.watch.minPostAgeMin * MIN));
      const d = soonest - now();
      if (d > 0 && d < nextCheckMs(settings)) return { delay: d + randInt(10, 60) * 1000, why: "fresh post entering window" };
    }
  }

  // 3) Background work when idle: queued profile refreshes, learning checks, optional cleanup.
  if (await stillRunning()) {
    const bg = await backgroundStep({ tabId, settings, me });
    if (bg && bg.stop) { await stop(bg.stop, bg.detail); return null; }
  }

  // Next tick: random check interval, earlier if a queued comment becomes due.
  let delay = nextCheckMs(settings);
  const st2 = await getState();
  const open2 = await H.openQueue();
  const nextDue = open2.filter((r) => r.status === HS.APPROVED || (r.status === HS.QUEUED && mode === MODE.AUTO)).map((r) => Math.max(r.scheduledFor || 0, st2.nextCommentAt || 0)).sort((a, b) => a - b)[0];
  if (nextDue) delay = Math.min(delay, Math.max(20000, nextDue - now() + randInt(5, 30) * 1000));
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
      return tickBody(settings, secrets);
    });
    if (res && res.busy) { await scheduleTick(reason === "manual" ? randInt(10, 20) * 1000 : randInt(45, 90) * 1000, reason === "manual" ? "manual" : "busy"); return; }
    if (await stillRunning()) {
      const settings = await getSettings();
      const d = res && res.delay ? res.delay : nextCheckMs(settings);
      if (rerunRequested) await scheduleTick(randInt(1500, 4000), "manual");
      else await scheduleTick(d, res && res.why ? res.why : "next check");
    }
  } catch (e) {
    log("error", "Tick failed: " + String((e && e.message) || e));
    const st = await patchState((s) => ({ internalErrors: (s.internalErrors || 0) + 1 }));
    if (st.internalErrors >= 5) await stop(STOP.INTERNAL, String((e && e.message) || e));
    else if (await stillRunning()) await scheduleTick(randInt(2, 4) * MIN, "retry after error");
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
  return (t.priority || 50) + (t.tier === 1 ? 15 : 0) + (t.group === "B" ? 5 : 0) - ageMin * 0.8 + Math.min(20, Math.log10(1 + velocity) * 10);
}

async function handleFresh(posts, ctx) {
  const { settings, secrets, mode, tabId, me } = ctx;
  let counts = ctx.counts;
  const ts = now();
  const targets = await getTargets();
  const state = await getState();
  const ranked = posts.map((p) => ({ p, t: targets[p.author] })).filter((x) => x.t).sort((a, b) => scorePost(b.p, b.t, ts) - scorePost(a.p, a.t, ts));
  let generatedThisTick = 0;
  for (const { p, t } of ranked) {
    if (generatedThisTick >= 2) break;
    if (!(await stillRunning())) return;
    const already = await H.byPostId(p.id);
    if (already.length) continue;
    const skip = skipReason(p, settings, { ts: now() });
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
    if (mode === MODE.AUTO) {
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
    target: p.author, targetName: p.authorName || t.name || "", group: t.group, tier: t.tier,
    postId: p.id, postUrl: p.url, postText: truncate(p.text, 1200), postLang: p.lang || "", postCreatedAt: p.createdAt || null,
    postMetrics: p.metrics || null, postHasMedia: !!p.hasMedia, postIsQuote: !!p.isQuote,
  };
}

async function ensureContext(t, tabId, settings, post) {
  const stale = !t.profile || !t.profile.updatedAt || now() - t.profile.updatedAt > 7 * DAY;
  const room = !post.createdAt || now() - post.createdAt < (settings.watch.maxPostAgeMin - 5) * MIN;
  if (!stale || !room || tabId == null) return t;
  const r = await refreshProfile(tabId, t.handle, settings);
  if (r && r.stop) return { stop: r.stop, detail: r.detail };
  const all = await getTargets();
  return all[t.handle] || t;
}

// Generate one comment for a post and store it (pending review or queued). Returns "stopped" on a stop.
export async function generateFor(post, target, { settings, secrets, mode, tabId, me, feedback }) {
  const spend = await getSpend();
  const preset0 = effectivePreset(target, settings);
  const p0 = settings.presets[preset0];
  const est = estimate(settings, { modelId: p0.modelId, effort: p0.effort, perDay: 1, checkModelId: settings.presets[settings.quality.checkerPreset].modelId, checkEffort: settings.presets[settings.quality.checkerPreset].effort });
  if (est && wouldExceed(settings, spend, est.perComment * 2)) { await stop(STOP.BUDGET, "The next comment would exceed your monthly budget"); return "stopped"; }

  let t = target;
  if (tabId != null) {
    const c = await ensureContext(target, tabId, settings, post);
    if (c && c.stop) { await stop(c.stop, c.detail); return "stopped"; }
    t = c;
  }
  const arm = chooseArm(t, settings, await H.all().catch(() => []));
  const tone = arm.tone ? effectiveTone(t, settings, arm.tone) : effectiveTone(t, settings);
  const presetKey = arm.preset || preset0;
  const previous = (await H.recentPosted(50)).map((r) => r.comment).filter(Boolean);
  const g = await generate({
    settings, apiKey: secrets.openaiKey, target: t, post, tone, presetKey, previous,
    bestComments: await bestComments(), myHandle: me, compatFor: await compatLoader(), onCall: await onCallFactory(settings), feedback,
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
  if (mode === MODE.AUTO && liveMode === MODE.AUTO) {
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
  await H.patch(rec.id, { status: HS.POSTING, attemptAt: now() });
  const r = await postReply(rec, { tabId, settings, me, allowLike });
  const ts = now();
  if (r.ok) {
    await H.patch(rec.id, { status: HS.POSTED, postedAt: ts, replyUrl: r.replyUrl || "", replyId: r.replyId || "", liked: !!r.liked, likedAt: r.liked ? ts : null, reason: r.already ? "Reply was already in the thread" : "" });
    await patchState({ ...afterPost(settings, state, ts), consecutiveFailures: 0, lastLikeAt: r.liked ? ts : state.lastLikeAt, internalErrors: 0 });
    await updateTargets((all) => {
      const t = all[rec.target];
      if (t) { t.stats = t.stats || {}; t.stats.comments = (t.stats.comments || 0) + 1; t.stats.lastCommentAt = ts; }
      return all;
    });
    log("info", `Posted a reply to @${rec.target}${r.liked ? " (and liked the post)" : ""}`);
    return "posted";
  }
  if (r.stop) {
    await H.patch(rec.id, { status: HS.FAILED, reason: STOP_LABEL[r.stop] || r.stop, liked: !!r.liked, likedAt: r.liked ? ts : null });
    await stop(r.stop, r.detail);
    return "stopped";
  }
  if (r.skip) {
    await H.patch(rec.id, { status: HS.SKIPPED, reason: r.reason, liked: !!r.liked, likedAt: r.liked ? ts : null });
    log("info", `Skipped posting to @${rec.target}: ${r.reason}`);
    return "skipped";
  }
  const n = (state.consecutiveFailures || 0) + 1;
  await H.patch(rec.id, { status: HS.FAILED, reason: r.reason || "post failed", liked: !!r.liked, likedAt: r.liked ? ts : null });
  await patchState({ consecutiveFailures: n, nextCommentAt: ts + humanDelay(3 * MIN, 6 * MIN) });
  log("warn", `Posting to @${rec.target} failed: ${r.reason}`);
  if (n >= settings.safety.maxConsecutiveFailures) { await stop(STOP.POST_FAILURES, `${n} posting failures in a row (last: ${r.reason})`); return "stopped"; }
  return "failed";
}

// ---------- background work ----------

async function backgroundStep({ tabId, settings, me }) {
  const st = await getState();
  if (st.pendingRefresh && st.pendingRefresh.length) {
    const [h, ...rest] = st.pendingRefresh;
    await patchState({ pendingRefresh: rest });
    const r = await refreshProfile(tabId, h, settings);
    if (r && r.stop) return r;
    return { did: "refresh" };
  }
  if (settings.learning.enabled) {
    const r = await learningStep({ tabId, settings, me });
    if (r && r.stop) return r;
    if (r && r.did) return r;
  }
  if (settings.cleanup.enabled) {
    const r = await cleanupStep({ tabId, settings, me });
    if (r && r.stop) return r;
    if (r && r.did) return r;
  }
  return null;
}

// ---------- review actions (from the dashboard) ----------

export async function reviewAction({ id, action, text }) {
  const rec = await H.get(id);
  if (!rec) return { ok: false, error: "Item not found" };
  const editable = [HS.PENDING_REVIEW, HS.APPROVED, HS.QUEUED].includes(rec.status);
  if (!editable && action !== "skip") return { ok: false, error: `Item is already ${rec.status}` };
  const clean = typeof text === "string" ? text.trim() : null;
  if (clean != null && clean.length > HARD.maxCommentChars) return { ok: false, error: `Comment is longer than ${HARD.maxCommentChars} characters` };
  const edits = clean != null && clean !== rec.comment ? { comment: clean, edited: true, originalComment: rec.originalComment || rec.comment } : {};
  if (action === "save") return { ok: true, record: await H.patch(id, edits) };
  if (action === "skip") {
    if (!editable) return { ok: false, error: `Item is already ${rec.status}` };
    return { ok: true, record: await H.patch(id, { status: HS.SKIPPED, reason: "Skipped by you" }) };
  }
  if (action === "approve") {
    if (!(clean != null ? clean : rec.comment)) return { ok: false, error: "Comment is empty" };
    const r = await H.patch(id, { ...edits, status: HS.APPROVED, approvedAt: now(), scheduledFor: now() });
    const st = await getState();
    if (st.status === STATUS.RUNNING) await scheduleTick(randInt(15, 45) * 1000, "approved item");
    await refreshBadge();
    return { ok: true, record: r };
  }
  if (action === "regenerate") {
    const [settings, secrets, targets] = await Promise.all([getSettings(), getSecrets(), getTargets()]);
    if (!secrets.openaiKey) return { ok: false, error: "Add your OpenAI API key first" };
    const t = targets[rec.target] || { handle: rec.target, group: rec.group, tier: rec.tier, name: rec.targetName, recentPosts: [], profile: null, tone: "", preset: "" };
    const post = { id: rec.postId, url: rec.postUrl, author: rec.target, authorName: rec.targetName, text: rec.postText, lang: rec.postLang, createdAt: rec.postCreatedAt, metrics: rec.postMetrics, hasMedia: rec.postHasMedia, isQuote: rec.postIsQuote };
    const tone = rec.tone ? effectiveTone(t, settings, rec.tone) : effectiveTone(t, settings);
    const previous = [rec.comment, ...(await H.recentPosted(50)).map((r) => r.comment)].filter(Boolean);
    const g = await generate({
      settings, apiKey: secrets.openaiKey, target: t, post, tone, presetKey: rec.preset || effectivePreset(t, settings), previous,
      bestComments: await bestComments(), myHandle: settings.account.handle, compatFor: await compatLoader(), onCall: await onCallFactory(settings),
      feedback: "The owner asked for a different reply. Use a different angle and opening than: " + truncate(rec.comment, 200),
    });
    const calls = [...(rec.calls || []), ...g.calls];
    if (g.stop) { await H.patch(id, { calls }); await stop(g.stop, g.error && g.error.message); return { ok: false, error: "OpenAI: " + ((g.error && g.error.message) || g.stop) }; }
    if (!g.ok) {
      await H.patch(id, { calls, attempts: (rec.attempts || 0) + g.attempts });
      return { ok: false, error: g.skipped ? g.skipped.text : "OpenAI: " + ((g.error && g.error.message) || "error") };
    }
    const r = await H.patch(id, { calls, comment: g.comment, originalComment: g.comment, edited: false, attempts: (rec.attempts || 0) + g.attempts, quality: g.quality, modelId: g.model.id, modelName: g.model.name, effort: g.model.reasoning ? g.effort : "none", fallbackUsed: g.fallbackUsed, status: HS.PENDING_REVIEW });
    return { ok: true, record: r };
  }
  return { ok: false, error: "Unknown action" };
}

export async function reviewBulk(action) {
  const items = await H.byStatus(HS.PENDING_REVIEW);
  let n = 0;
  for (const r of items) {
    const res = await reviewAction({ id: r.id, action });
    if (res.ok) n++;
  }
  return { ok: true, count: n };
}

export { recordOutcomeForTarget };
