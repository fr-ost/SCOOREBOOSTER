// ScoreX - self-learning (Phase 3).
//   * Engagement checks: ~24h after a reply is posted, visit it and read likes / replies / whether the
//     target answered it. A second look happens after ~72h.
//   * Follow-back checks: revisit commented targets that do not follow you and record follow-backs.
//   * Priorities: targets that respond get a higher priority (and optionally tier 1 / group A); targets that
//     never respond after N comments cool down (fewer comments for a while).
//   * A/B testing: tones x presets per group, chosen with Thompson sampling on "got any response"
//     plus a user-set exploration share. Results and suggestions are shown in the dashboard.

import { K, HS, CMD, BUILTIN_TONES } from "./constants.js";
import { load, save, getSettings, getState, patchState, getTargets, updateTargets, log } from "./store.js";
import { navigate, send, waitForPage } from "./tabs.js";
import { pageVerdict } from "./guard.js";
import { refreshProfile } from "./watcher.js";
import { notify } from "./notify.js";
import * as H from "./history.js";
import { now, DAY, HOUR, MIN, random, clamp, sleep, humanDelay, num } from "./util.js";

const ATTRIBUTION_DAYS = 14; // a follow-back is credited to comments from the previous 14 days

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
  return new Set([...BUILTIN_TONES, ...(settings.customTones || []).map((c) => "custom:" + c.id), "custom"]);
}

// The arms available for a target in its group (respecting per-target overrides).
export function armsFor(target, settings) {
  const L = settings.learning;
  const g = settings.groups[target.group] || {};
  const valid = toneKeys(settings);
  const defaultTone = target.tone || g.tone || "insightful";
  const groupTones = (L.abTones && !Array.isArray(L.abTones) ? L.abTones[target.group] : L.abTones) || [];
  const tones = target.tone ? [target.tone] : [...new Set([defaultTone, ...groupTones.filter((t) => valid.has(t))])];
  const matrixPreset = settings.presetMatrix[`${target.group}${target.tier}`] || "balanced";
  const presets = target.preset ? [target.preset] : [...new Set([matrixPreset, ...(L.abPresets || []).filter((p) => settings.presets[p])])];
  const arms = [];
  for (const tone of tones) for (const preset of presets) arms.push({ key: `${tone}|${preset}`, tone, preset, isDefault: tone === defaultTone && preset === (target.preset || matrixPreset) });
  return arms;
}

// Per-group arm statistics from posted, checked history records (after the last A/B reset).
export function armStats(history, sinceTs = 0) {
  const stats = {};
  for (const r of history || []) {
    if (r.status !== HS.POSTED || !r.postedAt || r.postedAt < sinceTs) continue;
    const key = r.abArm || `${r.tone || "?"}|${r.preset || "?"}`;
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

// Dashboard summary: arm table + suggested tone/preset per group.
export async function summary() {
  const settings = await getSettings();
  const meta = await load(K.learning, {});
  const history = await H.since(Math.max(meta.abResetAt || 0, now() - 120 * DAY));
  const stats = armStats(history, meta.abResetAt || 0);
  const arms = Object.values(stats).map((a) => ({
    ...a,
    rate: a.checked ? a.successes / a.checked : null,
    costPerComment: a.n ? a.cost / a.n : 0,
    avgLikes: a.checked ? a.likes / a.checked : 0,
    avgReplies: a.checked ? a.replies / a.checked : 0,
  })).sort((x, y) => (x.group < y.group ? -1 : x.group > y.group ? 1 : (y.rate || 0) - (x.rate || 0)));
  const suggestions = {};
  for (const g of ["A", "B"]) {
    const ga = arms.filter((a) => a.group === g && a.checked >= settings.learning.minSamples);
    if (!ga.length) {
      const have = arms.filter((a) => a.group === g).reduce((s, a) => s + a.checked, 0);
      suggestions[g] = { tone: null, preset: null, why: `Not enough data yet (${have} checked comments; need ${settings.learning.minSamples} per tone/model combination).` };
      continue;
    }
    // Posterior mean with a uniform prior, tie-break on reward per dollar.
    const score = (a) => (a.successes + 1) / (a.checked + 2);
    ga.sort((x, y) => score(y) - score(x) || (y.reward / Math.max(y.cost, 1e-6)) - (x.reward / Math.max(x.cost, 1e-6)));
    const b = ga[0];
    suggestions[g] = { tone: b.tone, preset: b.preset, rate: b.rate, why: `${Math.round(b.rate * 100)}% of ${b.checked} checked comments got a response (likes, replies or a follow-back) at $${b.costPerComment.toFixed(4)} per comment.` };
  }
  return { ok: true, arms, suggestions, minSamples: settings.learning.minSamples, since: meta.abResetAt || null };
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

// Recompute priority / tier / cooldown for every target from history (no page visits).
export async function updatePriorities(settings, ts = now()) {
  const L = settings.learning;
  const history = await H.since(ts - 120 * DAY);
  const byT = {};
  for (const r of history) if (r.status === HS.POSTED) (byT[r.target] ||= []).push(r);
  await updateTargets((all) => {
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
        if (engaged(r.results) && (r.results.authorReplied || r.results.followedBack || num(r.results.replies) > 0 || num(r.results.likes) > 1)) break;
        streak++;
      }
      const followedBack = !!(t.rel && t.rel.followedBackAt);
      t.stats = { ...(t.stats || {}), comments: recs.length, engaged: eng.length, authorReplies, noResponseStreak: streak, lastEngagedAt: eng[0] ? eng[0].postedAt : (t.stats && t.stats.lastEngagedAt) || null };
      const base = t.tier === 1 ? 70 : 50;
      const rate = checked.length ? eng.length / checked.length : 0;
      let p = base + Math.round(20 * rate) + (authorReplies ? 8 : 0) + (followedBack ? 10 : 0) - Math.min(30, streak * 4);
      if (!t.priorityManual) t.priority = clamp(p, 0, 100);
      if (streak >= L.coldAfterComments && !(t.coldUntil && t.coldUntil > ts)) {
        t.coldUntil = ts + L.coldCooldownDays * DAY;
        t.coldSince = ts;
        log("info", `@${t.handle} cools down for ${L.coldCooldownDays} days (no response after ${streak} comments)`);
      }
      if (streak === 0 && t.coldUntil && t.coldUntil > ts && (authorReplies || followedBack)) t.coldUntil = null;
      if (L.autoTierUp && t.tier === 2 && (followedBack || authorReplies >= 2)) {
        t.tier = 1;
        log("info", `@${t.handle} moved to tier 1 (responds to your comments)`);
      }
    }
    return all;
  });
}

// ---------- background step (called by the engine when idle) ----------

async function checkReply(tabId, rec, settings) {
  const nav = await navigate(tabId, rec.replyUrl);
  if (!nav.ok) return { ok: false };
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

export async function learningStep({ tabId, settings, me }) {
  const L = settings.learning;
  const st = await getState();
  const ts = now();
  if (!st.learningForce && st.lastLearningAt && ts - st.lastLearningAt < 30 * MIN) return null;
  await patchState({ lastLearningAt: ts, learningForce: false });
  let visits = 0;
  const max = L.maxChecksPerRun;

  // 1) Engagement on our replies (first look after N hours, second look after 72h).
  const posted = (await H.byStatus(HS.POSTED)).filter((r) => r.replyUrl && r.replyId);
  const due = posted.filter((r) => {
    const res = r.results || {};
    const age = ts - r.postedAt;
    if (!res.checkedAt) return age >= L.engagementCheckAfterHours * HOUR;
    return (res.checks || 1) < 2 && age >= 72 * HOUR && ts - res.checkedAt > 24 * HOUR;
  }).sort((a, b) => a.postedAt - b.postedAt);
  for (const r of due) {
    if (visits >= max) break;
    visits++;
    const c = await checkReply(tabId, r, settings);
    if (c.stop) return c;
    if (c.ok && c.gone) await H.patch(r.id, { results: { ...(r.results || {}), checkedAt: now(), checks: 2, gone: true } });
    else if (c.ok) {
      const s = c.stats;
      await H.patch(r.id, { results: { ...(r.results || {}), likes: s.likes, replies: s.replies, authorReplied: s.authorReplied || !!(r.results && r.results.authorReplied), checkedAt: now(), checks: ((r.results && r.results.checks) || 0) + 1 } });
      if (s.authorReplied && !(r.results && r.results.authorReplied)) log("info", `@${r.target} replied to your comment`);
    }
    await sleep(humanDelay(3000, 8000));
  }

  // 2) Follow-backs from commented targets that did not follow you.
  const targets = await getTargets();
  const candidates = Object.values(targets).filter((t) => t.enabled && (t.stats && t.stats.comments > 0) && !(t.rel && t.rel.followsYou) &&
    (!t.rel || !t.rel.checkedAt || ts - t.rel.checkedAt > L.followCheckEveryHours * HOUR))
    .sort((a, b) => ((a.rel && a.rel.checkedAt) || 0) - ((b.rel && b.rel.checkedAt) || 0));
  for (const t of candidates) {
    if (visits >= max) break;
    visits++;
    const r = await refreshProfile(tabId, t.handle, settings);
    if (r && r.stop) return r;
    if (r && r.ok && r.profile && r.profile.followsYou) {
      const at = now();
      await recordOutcomeForTarget(t.handle, at);
      await updateTargets((all) => {
        const x = all[t.handle];
        if (x) {
          x.rel = { ...(x.rel || {}), followsYou: true, followedBackAt: x.rel && x.rel.followedBackAt ? x.rel.followedBackAt : at };
          if (L.autoMoveToA && x.group === "B") { x.group = "A"; log("info", `@${t.handle} followed you back - moved to group A`); }
        }
        return all;
      });
      await notify("sx-fb-" + t.handle, "New follow-back", `@${t.handle} followed you back after your comments.`);
    }
    await sleep(humanDelay(3000, 8000));
  }

  await updatePriorities(settings, now());
  return visits ? { did: "learning", visits } : null;
}
