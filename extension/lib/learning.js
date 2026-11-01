// ScoreX - self-learning (Phase 3).
//   * Engagement checks: ~24h after a reply is posted, visit it and read likes / replies / whether the
//     target answered it. A second look happens after ~72h.
//   * Follow-backs (found by follow tracking, lib/follow.js) are credited to the comments before them.
//   * Priorities: targets that respond get a higher priority (and optionally tier 1); targets that never
//     respond after N comments cool down (fewer comments for a while).
//   * A/B testing: your Tone prompt and the tones / presets you add, chosen with Thompson sampling on "got
//     any response" plus a user-set exploration share. Results and suggestions are shown in the dashboard.

import { K, HS, CMD, BUILTIN_TONES } from "./constants.js";
import { MAIN_TONE, effectivePreset } from "./targets.js";
import { load, save, getSettings, getState, patchState, getTargets, updateTargets, getBlacklist, log } from "./store.js";
import { navigate, send, waitForPage } from "./tabs.js";
import { pageVerdict } from "./guard.js";
import { notify } from "./notify.js";
import { valueDetails, learnedRates } from "./scores.js";
import { checkReach, checkDelayMs } from "./reach.js";
import * as H from "./history.js";
import { recordFollowBack, syncFollowBacks } from "./followbacks.js";
import { followBackScores } from "./scoreboard.js";
import { now, DAY, HOUR, MIN, random, clamp, sleep, humanDelay, num } from "./util.js";

const ATTRIBUTION_DAYS = 14; // a follow-back is credited to comments from the previous 14 days
const TIER1_BONUS = 20; // heuristic: with score-aware targeting, tier 1 keeps the 20-point lead of the old 70/50 bases
// navigate()'s 3rd argument: the page-load purpose for the X footprint ledger (lib/tabs.js). valueOf keeps it a valid
// timeout (45 s) for the older navigate(tabId, url, timeoutMs) signature.
const NAV = (purpose) => ({ purpose, timeoutMs: 45000, valueOf: () => 45000 });

export function engaged(res) {
  return !!(res && (num(res.likes) > 0 || num(res.replies) > 0 || res.authorReplied || res.followedBack));
}
export function rewardScore(res) {
  if (!res) return 0;
  return num(res.likes) + 2 * num(res.replies) + (res.authorReplied ? 5 : 0) + (res.followedBack ? 10 : 0);
}

// ---------- Thompson sampling ----------

function gamma(k) {
  // Marsaglia-Tsang for k >= 1; boost for k < 1.
  if (k < 1) return gamma(k + 1) * Math.pow(random() || 1e-9, 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do {
      const u1 = random() || 1e-9, u2 = random();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = random() || 1e-9;
    if (u < 1 - 0.0331 * x * x * x * x || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
export function betaSample(a, b) { const x = gamma(a), y = gamma(b); return x / (x + y); }

function toneKeys(settings) {
  return new Set([...BUILTIN_TONES, ...(settings.customTones || []).map((c) => "custom:" + c.id), "custom", MAIN_TONE]);
}
// Only accounts that don't follow you are commented on, so the "B" tone list is the one being tested.
function testedTones(settings) {
  const L = settings.learning;
  return (L.abTones && !Array.isArray(L.abTones) ? L.abTones.B : L.abTones) || [];
}

// The arms available for a target (respecting per-target overrides). The Tone prompt is the default tone.
export function armsFor(target, settings) {
  const L = settings.learning;
  const valid = toneKeys(settings);
  const defaultTone = target.tone || MAIN_TONE;
  const tones = target.tone ? [target.tone] : [...new Set([defaultTone, ...testedTones(settings).filter((t) => valid.has(t))])];
  const matrixPreset = effectivePreset({ ...target, preset: "" }, settings);
  const presets = target.preset ? [target.preset] : [...new Set([matrixPreset, ...(L.abPresets || []).filter((p) => settings.presets[p])])];
  const arms = [];
  for (const tone of tones) for (const preset of presets) arms.push({ key: `${tone}|${preset}`, tone, preset, isDefault: tone === defaultTone && preset === (target.preset || matrixPreset) });
  return arms;
}

// Per-group arm statistics from posted, checked history records that were assigned an A/B arm
// (after the last A/B reset). Records without an arm (A/B off, per-target overrides) are not experiments.
export function armStats(history, sinceTs = 0) {
  const stats = {};
  for (const r of history || []) {
    if (r.status !== HS.POSTED || !r.postedAt || r.postedAt < sinceTs || !r.abArm) continue;
    const key = r.abArm;
    const k = `${r.group}::${key}`;
    const a = (stats[k] ||= { group: r.group, key, tone: key.split("|")[0], preset: key.split("|")[1], n: 0, checked: 0, successes: 0, likes: 0, replies: 0, authorReplies: 0, followBacks: 0, cost: 0, reward: 0 });
    a.n++;
    a.cost += num(r.cost);
    const res = r.results || {};
    if (res.checkedAt || res.followedBack) {
      a.checked++;
      if (engaged(res)) a.successes++;
      a.likes += num(res.likes); a.replies += num(res.replies);
      if (res.authorReplied) a.authorReplies++;
      if (res.followedBack) a.followBacks++;
      a.reward += rewardScore(res);
    }
  }
  return stats;
}

// Pick tone + preset for the next comment. Returns {} when A/B testing is off (use defaults).
export function chooseArm(target, settings, history, sinceTs) {
  const L = settings.learning;
  if (!L.enabled || !L.abTesting || !target) return {};
  const arms = armsFor(target, settings);
  if (arms.length <= 1) return {};
  const stats = armStats(history, sinceTs || 0);
  if (random() < L.explore) {
    const a = arms[Math.floor(random() * arms.length)];
    return { key: a.key, tone: a.tone, preset: a.preset, explore: true };
  }
  let best = null, bestV = -1;
  for (const a of arms) {
    const s = stats[`${target.group}::${a.key}`] || { checked: 0, successes: 0 };
    // Slight prior towards the default arm so a fresh setup behaves like the user's choice.
    const prior = a.isDefault ? 3 : 1;
    const v = betaSample(prior + s.successes, 1 + (s.checked - s.successes));
    if (v > bestV) { bestV = v; best = a; }
  }
  return { key: best.key, tone: best.tone, preset: best.preset, explore: false };
}

// The tones currently tested (the Tone prompt + the A/B tones).
function groupTones(settings) {
  const valid = toneKeys(settings);
  return new Set([MAIN_TONE, ...testedTones(settings).filter((t) => valid.has(t))]);
}

// Dashboard summary: arm table + suggested tone (and preset, only when presets are being tested) per group.
// A suggestion needs at least two tested variants with enough checked comments each.
export async function summary() {
  const settings = await getSettings();
  const meta = await load(K.learning, {});
  const history = await H.since(Math.max(meta.abResetAt || 0, now() - 120 * DAY));
  const stats = armStats(history, meta.abResetAt || 0);
  const testingPresets = (settings.learning.abPresets || []).length > 0;
  const arms = Object.values(stats).map((a) => ({
    ...a,
    rate: a.checked ? a.successes / a.checked : null,
    costPerComment: a.n ? a.cost / a.n : 0,
    avgLikes: a.checked ? a.likes / a.checked : 0,
    avgReplies: a.checked ? a.replies / a.checked : 0,
  })).sort((x, y) => (x.group < y.group ? -1 : x.group > y.group ? 1 : (y.rate || 0) - (x.rate || 0)));
  const suggestions = {};
  const min = settings.learning.minSamples;
  for (const g of ["B"]) {
    const tested = groupTones(settings);
    const ga = arms.filter((a) => a.group === g && tested.has(a.tone) && a.checked >= min);
    if (ga.length < 2) {
      const have = arms.filter((a) => a.group === g).reduce((s, a) => s + a.checked, 0);
      suggestions[g] = { tone: null, preset: null, why: `Not enough data yet (${have} checked comments; at least two variants need ${min} checked comments each).` };
      continue;
    }
    // Posterior mean with a uniform prior, tie-break on reward per dollar.
    const score = (a) => (a.successes + 1) / (a.checked + 2);
    ga.sort((x, y) => score(y) - score(x) || (y.reward / Math.max(y.cost, 1e-6)) - (x.reward / Math.max(x.cost, 1e-6)));
    const b = ga[0];
    suggestions[g] = { tone: b.tone, preset: testingPresets ? b.preset : null, rate: b.rate, why: `${Math.round(b.rate * 100)}% of ${b.checked} checked comments got a response (likes, replies or a follow-back) at $${b.costPerComment.toFixed(4)} per comment.` };
  }
  return { ok: true, arms, suggestions, minSamples: min, since: meta.abResetAt || null };
}

export async function resetAb() {
  const meta = await load(K.learning, {});
  await save({ [K.learning]: { ...meta, abResetAt: now() } });
  return { ok: true };
}

// ---------- outcomes ----------

// Credit a follow-back to the target's comments from the last ATTRIBUTION_DAYS.
export async function recordOutcomeForTarget(handle, followBackAt = now()) {
  const recs = await H.byTarget(handle);
  for (const r of recs) {
    if (r.status !== HS.POSTED || !r.postedAt) continue;
    if (followBackAt - r.postedAt > ATTRIBUTION_DAYS * DAY || r.postedAt > followBackAt) continue;
    if (r.results && r.results.followedBack) continue;
    await H.patch(r.id, { results: { ...(r.results || {}), followedBack: true, followBackAt } });
  }
}

// One place for follow-backs, whoever noticed them (follow tracking, rotation watch, refresh, cleanup):
// applyFollow sets rel.followedBackAt only on a real false -> true change; here it is credited once.
// The target is no longer commented on from then on (isActive), and its open queue items are dropped.
export async function processFollowBacks(settings) {
  const targets = await getTargets();
  const fresh = Object.values(targets).filter((t) => t.rel && t.rel.followedBackAt && !t.rel.followBackCredited);
  for (const t of fresh) {
    await recordOutcomeForTarget(t.handle, t.rel.followedBackAt);
    await updateTargets((all) => {
      const x = Object.hasOwn(all, t.handle) ? all[t.handle] : null;
      if (x) x.rel = { ...(x.rel || {}), followBackCredited: true };
      return all;
    });
    await recordFollowBack(t, t.rel.followedBackAt).catch(() => {}); // History > Follow-backs
    log("info", `@${t.handle} followed you back - no more comments to this account`);
    await notify("sx-fb-" + t.handle, "New follow-back", `@${t.handle} followed you back after your comments.`);
  }
  await syncFollowBacks().catch(() => {}); // "unfollowed later" and anything the record is still missing
  // Their TwitterScore (History > Follow-backs), through your TwitterScore API key; runs on its own, never waited for.
  if (fresh.length) followBackScores().catch(() => {});
  return fresh.length;
}

const strongResponse = (res) => !!(res && (res.authorReplied || res.followedBack || num(res.replies) > 0 || num(res.likes) > 1));

// Recompute priority / tier / cooldown for every target from history (no page visits). With score-aware targeting
// (settings.targeting.useValue) the priority starts from the target's value (provider scores or ScoreX rank x chance
// of a follow-back, lib/scores.js) instead of the flat 70 / 50 tier bases; the other adjustments stay the same.
// target.score.value / propensity / why are stored either way (Targets tab).
export async function updatePriorities(settings, ts = now()) {
  const L = settings.learning;
  const useValue = !!(settings.targeting && settings.targeting.useValue);
  const history = await H.since(ts - 120 * DAY);
  const blacklist = await getBlacklist();
  const byT = Object.create(null);
  for (const r of history) if (r.status === HS.POSTED) (byT[r.target] ||= []).push(r);
  await updateTargets((all) => {
    const learned = learnedRates(all, blacklist, ts);
    for (const t of Object.values(all)) {
      const recs = (byT[t.handle] || []).sort((a, b) => b.postedAt - a.postedAt);
      const checked = recs.filter((r) => r.results && (r.results.checkedAt || r.results.followedBack));
      const eng = checked.filter((r) => engaged(r.results));
      const authorReplies = checked.filter((r) => r.results.authorReplied).length;
      // The no-response streak only counts comments made after the last cooldown started, so a target is
      // not cooled down again the moment its cooldown ends.
      let streak = 0;
      for (const r of checked) {
        if (t.coldSince && r.postedAt < t.coldSince) break;
        if (strongResponse(r.results)) break;
        streak++;
      }
      const followedBack = !!(t.rel && t.rel.followedBackAt);
      // The 14-day give-up window only starts from comments in the target's current life: comments from before it
      // was removed and added again (e.g. taken off the blacklist), or from before it unfollowed you, never count.
      const lifeStart = Math.max(t.addedAt || 0, (t.rel && t.rel.unfollowedYouAt) || 0);
      const life = recs.filter((r) => r.postedAt >= lifeStart);
      const firstAt = life.length ? life[life.length - 1].postedAt : null;
      t.stats = { ...(t.stats || {}), firstCommentAt: (t.stats && t.stats.firstCommentAt) || firstAt, comments: recs.length, engaged: eng.length, authorReplies, noResponseStreak: streak, lastEngagedAt: eng[0] ? eng[0].postedAt : (t.stats && t.stats.lastEngagedAt) || null };
      const vd = valueDetails(t, learned);
      if (t.score || vd.value != null || vd.propensity != null) t.score = { ...(t.score || {}), value: vd.value, propensity: vd.propensity, why: vd.why };
      const base = useValue && vd.value != null ? vd.value + (t.tier === 1 ? TIER1_BONUS : 0) : t.tier === 1 ? 70 : 50;
      const rate = checked.length ? eng.length / checked.length : 0;
      let p = base + Math.round(20 * rate) + (authorReplies ? 8 : 0) + (followedBack ? 10 : 0) - Math.min(30, streak * 4);
      // Never 0: the engine reads a missing priority as 50.
      if (!t.priorityManual) t.priority = clamp(Math.round(p), 1, 100);
      const cold = t.coldUntil && t.coldUntil > ts;
      if (streak >= L.coldAfterComments && !cold) {
        t.coldUntil = ts + L.coldCooldownDays * DAY;
        t.coldSince = ts;
        log("info", `@${t.handle} cools down for ${L.coldCooldownDays} days (no response after ${streak} comments)`);
      }
      // Lift a cooldown early only for a response to a comment made after it started.
      if (cold && t.coldSince && checked.some((r) => r.postedAt >= t.coldSince && strongResponse(r.results))) t.coldUntil = null;
      if (L.autoTierUp && t.tier === 2 && !t.tierManual && (followedBack || authorReplies >= 2)) {
        t.tier = 1;
        log("info", `@${t.handle} moved to tier 1 (responds to your comments)`);
      }
    }
    return all;
  });
}

// ---------- background step (called by the engine when idle) ----------

// Engagement checks on your posted replies (all timings are heuristics):
//   * first look ~engagementCheckAfterHours (24 h) after posting: likes, replies, views, author reply;
//   * second look ~72 h after posting, only while conversation alerts are off (with them on, author replies come from
//     your mentions page, lib/conversations.js, and one page load of each run's budget goes there instead, so the
//     number of X page loads does not grow);
//   * with the reply reach monitor on, 1-2 replies per run also get an early look ~3 h after posting, so a drop in
//     views shows up the same day (lib/reach.js compares early looks only with early looks).
// The newest due replies come first (the freshest views for the reach monitor); a first look is skipped for replies
// older than a week (or 2 days past a check delay longer than 5 days). Failed checks back off (6 h, 12 h, 24 h) and
// are given up after 3 failures.
const EARLY_FROM_MS = 3 * HOUR;
const EARLY_UNTIL_MS = 8 * HOUR;
const FIRST_LOOK_MAX_AGE_MS = 7 * DAY;
const firstLookMaxAge = (settings) => Math.max(FIRST_LOOK_MAX_AGE_MS, checkDelayMs(settings) + 2 * DAY);

// Which replies to check in this run (pure). Returns { early: [records], regular: [records], max }.
export function checkPlan(records, settings, ts = now()) {
  const L = settings.learning;
  const conv = !!(L.conversations && L.conversations.enabled);
  const reachOn = !!(settings.safety && settings.safety.reach && settings.safety.reach.enabled);
  // Conversation alerts take one page load of the budget, never the last one: with "Max checks per run" at 1 the
  // engagement checks (self-learning, reach monitor) would otherwise never run. 0 means no checks.
  const cap = Math.max(0, Math.round(num(L.maxChecksPerRun, 3)));
  const max = cap ? Math.max(1, cap - (conv ? 1 : 0)) : 0;
  const delay = checkDelayMs(settings), maxAge = firstLookMaxAge(settings);
  const usable = (r) => {
    const res = r.results || {};
    return r.status === HS.POSTED && r.postedAt && r.replyUrl && r.replyId && !res.gone && (res.failures || 0) < 3 && !(res.nextCheckAt && ts < res.nextCheckAt);
  };
  const pool = (records || []).filter(usable);
  const earlySlots = reachOn ? (max >= 4 ? 2 : max >= 2 ? 1 : 0) : 0;
  const early = pool
    .filter((r) => { const res = r.results || {}; const age = ts - r.postedAt; return !res.checkedAt && !res.earlyAt && age >= EARLY_FROM_MS && age < EARLY_UNTIL_MS; })
    .sort((a, b) => b.postedAt - a.postedAt)
    .slice(0, earlySlots);
  const earlyIds = new Set(early.map((r) => r.id)); // never two page loads for one reply in the same run
  const regular = pool
    .filter((r) => {
      if (earlyIds.has(r.id)) return false;
      const res = r.results || {};
      const age = ts - r.postedAt;
      if (!res.checkedAt) return age >= delay && age <= maxAge;
      if (conv || L.enabled === false) return false; // the late look only served author replies / learning
      return (res.checks || 1) < 2 && age >= 72 * HOUR && ts - res.checkedAt > 24 * HOUR;
    })
    .sort((a, b) => b.postedAt - a.postedAt)
    .slice(0, Math.max(0, max - early.length));
  return { early, regular, max };
}

async function checkReply(tabId, rec, settings) {
  const nav = await navigate(tabId, rec.replyUrl, NAV("check"));
  if (!nav.ok) return nav.budget ? { ok: false, budget: true } : { ok: false };
  const w = await waitForPage(tabId, ["tweet", "emptyState"], 20000);
  const v = pageVerdict(w.page, settings);
  if (v && v.stop) return { stop: v.stop, detail: v.detail };
  if (v && v.notFound) return { ok: true, gone: true };
  await sleep(humanDelay(1500, 3500));
  const r = await send(tabId, CMD.REPLY_STATS, { replyId: rec.replyId, targetHandle: rec.target }, 20000);
  const v2 = pageVerdict(r.page, settings);
  if (v2 && v2.stop) return { stop: v2.stop, detail: v2.detail };
  return r.ok ? { ok: true, stats: r } : { ok: false };
}

// Store one check. results.views always holds the latest reading (viewsAt = when it was read); an early look also
// keeps earlyViews / earlyAt and never counts as the engagement check (no checkedAt), so the 24 h look still happens.
// The first regular look also keeps dayViews / dayViewsAt (the reach monitor's day-after reading, lib/reach.js).
async function recordCheck(rec, c, kind) {
  const t = now();
  if (c.ok && c.gone) return H.patch(rec.id, (cur) => ({ results: { ...(cur.results || {}), checkedAt: t, checks: 2, gone: true } }));
  if (c.ok) {
    const s = c.stats || {};
    const views = s.views != null && s.views !== "" && Number.isFinite(Number(s.views)) ? Number(s.views) : null;
    await H.patch(rec.id, (cur) => {
      const res = cur.results || {};
      const out = { ...res, likes: s.likes, replies: s.replies, authorReplied: !!s.authorReplied || !!res.authorReplied };
      if (views != null) { out.views = views; out.viewsAt = t; }
      if (kind === "early") { out.earlyAt = t; if (views != null) out.earlyViews = views; }
      else {
        if (views != null && !res.checkedAt && res.dayViews == null) { out.dayViews = views; out.dayViewsAt = t; }
        Object.assign(out, { checkedAt: t, checks: (res.checks || 0) + 1, failures: 0, nextCheckAt: null });
      }
      return { results: out };
    });
    if (s.authorReplied && !(rec.results && rec.results.authorReplied)) log("info", `@${rec.target} replied to your comment`);
    return null;
  }
  // An early look is only a sample: a failed one is not retried.
  if (kind === "early") return H.patch(rec.id, (cur) => ({ results: { ...(cur.results || {}), earlyAt: t } }));
  return H.patch(rec.id, (cur) => {
    const f = ((cur.results && cur.results.failures) || 0) + 1;
    return { results: { ...(cur.results || {}), failures: f, nextCheckAt: t + 6 * HOUR * Math.pow(2, f - 1) } };
  });
}

// shouldStop(): true once the user pressed Pause/Stop - checked before every page visit. Returns null, { did },
// or { stop, detail } (an X safety page, or the reply reach monitor with its action set to "stop").
// With self-learning off it only does what the reply reach monitor needs (view checks + the reach check), and
// nothing at all when the monitor is off too.
export async function learningStep({ tabId, settings, me, shouldStop }) {
  const learningOn = settings.learning.enabled !== false;
  const reachOn = !!(settings.safety && settings.safety.reach && settings.safety.reach.enabled);
  if (!learningOn && !reachOn) return null;
  const stopped = shouldStop || (async () => false);
  const st = await getState();
  const ts = now();
  if (!st.learningForce && st.lastLearningAt && ts - st.lastLearningAt < 30 * MIN) return null;
  await patchState({ lastLearningAt: ts, learningForce: false });
  await processFollowBacks(settings);
  let visits = 0;

  const plan = checkPlan(await H.since(ts - firstLookMaxAge(settings) - 2 * DAY), settings, ts);
  const todo = [...plan.early.map((r) => ["early", r]), ...plan.regular.map((r) => ["regular", r])];
  for (const [kind, r] of todo) {
    if (await stopped()) return { did: "aborted" };
    visits++;
    const c = await checkReply(tabId, r, settings);
    if (c.stop) return c;
    if (c.budget) { visits--; break; } // X page-load budget reached: not a failed check, it stays due
    await recordCheck(r, c, kind);
    await sleep(humanDelay(3000, 8000));
  }

  await processFollowBacks(settings);
  if (learningOn) await updatePriorities(settings, now());
  // Reply reach monitor (settings.safety.reach): never resumes or switches anything back on its own.
  const reach = await checkReach(settings, now());
  if (reach && reach.stop) return { stop: reach.stop, detail: reach.detail };
  return visits ? { did: "learning", visits } : null;
}
