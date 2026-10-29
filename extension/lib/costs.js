// ScoreX - OpenAI cost maths: real cost from returned usage, spend ledger, budget, estimates and totals.
// Prices are per 1M tokens and come from the editable price table in settings.models[].prices.

import { K, HS } from "./constants.js";
import { dayKey, monthKey, weekKey, num, now } from "./util.js";
import { load, update } from "./store.js";

export const EMPTY_USAGE = Object.freeze({ input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 });

// usage: { input, cached, cacheWrite, output, reasoning } as returned by OpenAI.
// cached (cache reads) and cacheWrite are subsets of input; reasoning is a subset of output and is
// billed at the output rate, so it is never added twice.
export function costOf(usage, prices) {
  if (!usage || !prices) return 0;
  const input = num(usage.input);
  const cached = Math.min(num(usage.cached), input);
  const write = Math.min(num(usage.cacheWrite), input - cached);
  const output = num(usage.output);
  const has = (v) => v != null && v !== "";
  const inP = num(prices.input);
  const cachedP = has(prices.cachedInput) ? num(prices.cachedInput) : inP;
  const writeP = has(prices.cacheWrite) ? num(prices.cacheWrite) : inP * 1.25;
  const usd = ((input - cached - write) * inP + cached * cachedP + write * writeP + output * num(prices.output)) / 1e6;
  return Math.round(usd * 1e8) / 1e8;
}

export function addUsage(a, b) {
  return {
    input: num(a && a.input) + num(b && b.input),
    cached: num(a && a.cached) + num(b && b.cached),
    cacheWrite: num(a && a.cacheWrite) + num(b && b.cacheWrite),
    output: num(a && a.output) + num(b && b.output),
    reasoning: num(a && a.reasoning) + num(b && b.reasoning),
  };
}
export function sumCalls(calls) {
  let usage = { ...EMPTY_USAGE }, cost = 0;
  for (const c of calls || []) { usage = addUsage(usage, c.usage); cost += num(c.cost); }
  return { usage, cost: Math.round(cost * 1e8) / 1e8 };
}

export function modelById(settings, id) { return (settings.models || []).find((m) => m.id === id) || null; }

// ---------- spend ledger (service worker only) ----------

export async function getSpend() { return load(K.spend, { days: {}, months: {}, byModelMonth: {} }); }

export function recordSpend(usd, modelId, tz, ts = now()) {
  if (!usd) return Promise.resolve();
  const d = dayKey(ts, tz), m = monthKey(ts, tz);
  return update(K.spend, { days: {}, months: {}, byModelMonth: {} }, (s) => {
    s.days ||= {}; s.months ||= {}; s.byModelMonth ||= {};
    s.days[d] = round(num(s.days[d]) + usd);
    s.months[m] = round(num(s.months[m]) + usd);
    const mk = m + "|" + (modelId || "?");
    s.byModelMonth[mk] = round(num(s.byModelMonth[mk]) + usd);
    // keep ~120 days of daily buckets
    const keys = Object.keys(s.days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 120))) delete s.days[k];
    return s;
  });
}
const round = (v) => Math.round(v * 1e8) / 1e8;

export function budgetStatus(settings, spend, ts = now()) {
  const limit = num(settings.budget && settings.budget.monthlyUsd);
  const spent = num(spend && spend.months && spend.months[monthKey(ts, settings.timezone)]);
  const today = num(spend && spend.days && spend.days[dayKey(ts, settings.timezone)]);
  if (!limit) return { limit: 0, spent, today, pct: 0, reached: false, warn: false };
  const pct = (spent / limit) * 100;
  return { limit, spent, today, pct, reached: spent >= limit, warn: pct >= num(settings.budget.warnAtPct, 80) };
}

// Would spending `nextUsd` more cross the monthly limit?
export function wouldExceed(settings, spend, nextUsd, ts = now()) {
  const b = budgetStatus(settings, spend, ts);
  return b.limit > 0 && b.spent + nextUsd > b.limit;
}

// ---------- estimates ----------

// Token assumptions when there is no history yet for a model (one short reply with ~6 style examples).
export const ASSUME = Object.freeze({
  genInput: 1300,
  genOutputVisible: 70,
  reasoning: { none: 0, low: 300, medium: 1000, high: 2800 },
  checkInput: 650,
  checkOutputVisible: 40,
  regenRate: 0.15,
});

// Average real usage per call kind and model from history, used to make estimates realistic.
export function usageStats(records) {
  const acc = {};
  for (const r of records || []) {
    for (const c of r.calls || []) {
      if (!c.ok || !c.usage) continue;
      const k = `${c.modelId}|${c.effort || "none"}|${c.kind === "check" ? "check" : "gen"}`;
      const a = (acc[k] ||= { n: 0, input: 0, cached: 0, output: 0, reasoning: 0 });
      a.n++; a.input += num(c.usage.input); a.cached += num(c.usage.cached); a.output += num(c.usage.output); a.reasoning += num(c.usage.reasoning);
    }
  }
  const out = {};
  for (const [k, a] of Object.entries(acc)) out[k] = { n: a.n, input: a.input / a.n, cached: a.cached / a.n, output: a.output / a.n, reasoning: a.reasoning / a.n };
  return out;
}

function expectedCall(stats, model, effort, kind) {
  const key = `${model.id}|${effort || "none"}|${kind}`;
  const s = stats && stats[key];
  if (s && s.n >= 3) return { usage: { input: s.input, cached: s.cached, output: s.output, reasoning: s.reasoning }, fromHistory: true };
  const eff = model.reasoning ? effort || "low" : "none";
  const reasoning = ASSUME.reasoning[eff] != null ? ASSUME.reasoning[eff] : 0;
  const visible = kind === "check" ? ASSUME.checkOutputVisible : ASSUME.genOutputVisible;
  return { usage: { input: kind === "check" ? ASSUME.checkInput : ASSUME.genInput, cached: 0, output: visible + reasoning, reasoning }, fromHistory: false };
}

// Estimated cost per posted comment and per day/month for N comments/day on a model + effort.
// Includes the optional quality-check call and the expected regeneration rate.
export function estimate(settings, { modelId, effort, perDay, checkModelId, checkEffort, stats } = {}) {
  const model = modelById(settings, modelId);
  if (!model) return null;
  const gen = expectedCall(stats, model, effort, "gen");
  let perComment = costOf(gen.usage, model.prices) * (1 + ASSUME.regenRate);
  let check = null;
  if (settings.quality && settings.quality.modelCheck) {
    const cm = modelById(settings, checkModelId) || model;
    check = expectedCall(stats, cm, checkEffort || "low", "check");
    perComment += costOf(check.usage, cm.prices) * (1 + ASSUME.regenRate);
  }
  const n = Math.max(0, num(perDay));
  return {
    model: model.name,
    effort: model.reasoning ? effort : "none",
    perComment,
    perDay: perComment * n,
    perMonth: perComment * n * 30,
    tokensPerComment: Math.round(gen.usage.input + gen.usage.output + (check ? check.usage.input + check.usage.output : 0)),
    fromHistory: gen.fromHistory,
  };
}

// ---------- totals & performance ----------

const isCounted = (r) => num(r.cost) > 0 || r.status === HS.POSTED;

export function aggregate(records, tz) {
  const byModel = {}, byDay = {}, byWeek = {}, byMonth = {};
  let total = { cost: 0, comments: 0, posted: 0, tokens: 0 };
  const bump = (map, key, r) => {
    const a = (map[key] ||= { key, cost: 0, comments: 0, posted: 0, skipped: 0, failed: 0, tokens: 0 });
    a.cost = round(a.cost + num(r.cost));
    a.comments++;
    if (r.status === HS.POSTED) a.posted++;
    if (r.status === HS.SKIPPED) a.skipped++;
    if (r.status === HS.FAILED) a.failed++;
    a.tokens += num(r.tokens && r.tokens.input) + num(r.tokens && r.tokens.output);
  };
  for (const r of records || []) {
    if (!isCounted(r)) continue;
    // Per-model totals use each call's model (fallbacks and checks count against the model that ran).
    if (r.calls && r.calls.length) {
      for (const c of r.calls) {
        const a = (byModel[c.modelName || c.modelId] ||= { key: c.modelName || c.modelId, cost: 0, calls: 0, tokens: 0, input: 0, output: 0, reasoning: 0 });
        a.cost = round(a.cost + num(c.cost)); a.calls++;
        a.input += num(c.usage && c.usage.input); a.output += num(c.usage && c.usage.output); a.reasoning += num(c.usage && c.usage.reasoning);
        a.tokens = a.input + a.output;
      }
    }
    const ts = r.createdAt || 0;
    bump(byDay, dayKey(ts, tz), r);
    bump(byWeek, weekKey(ts, tz), r);
    bump(byMonth, monthKey(ts, tz), r);
    total.cost = round(total.cost + num(r.cost));
    total.comments++;
    if (r.status === HS.POSTED) total.posted++;
    total.tokens += num(r.tokens && r.tokens.input) + num(r.tokens && r.tokens.output);
  }
  const sortDesc = (m) => Object.values(m).sort((a, b) => (a.key < b.key ? 1 : -1));
  return { total, byModel: Object.values(byModel).sort((a, b) => b.cost - a.cost), byDay: sortDesc(byDay), byWeek: sortDesc(byWeek), byMonth: sortDesc(byMonth) };
}

// Cost per posted comment next to likes, replies and follow-backs - per model and per tone.
export function performance(records) {
  const make = () => ({ posted: 0, cost: 0, likes: 0, replies: 0, authorReplies: 0, followBacks: 0, checked: 0 });
  const byModel = {}, byTone = {}, byArm = {};
  for (const r of records || []) {
    if (r.status !== HS.POSTED) continue;
    const res = r.results || {};
    for (const [map, key] of [[byModel, r.modelName || r.modelId || "?"], [byTone, r.tone || "?"], [byArm, `${r.tone || "?"} · ${r.preset || "?"}`]]) {
      const a = (map[key] ||= { key, ...make() });
      a.posted++;
      a.cost = round(a.cost + num(r.cost));
      if (res.checkedAt) a.checked++;
      a.likes += num(res.likes);
      a.replies += num(res.replies);
      if (res.authorReplied) a.authorReplies++;
      if (res.followedBack) a.followBacks++;
    }
  }
  const fin = (m) => Object.values(m).map((a) => ({
    ...a,
    costPerComment: a.posted ? a.cost / a.posted : 0,
    avgLikes: a.checked ? a.likes / a.checked : 0,
    avgReplies: a.checked ? a.replies / a.checked : 0,
    followBackRate: a.posted ? a.followBacks / a.posted : 0,
    costPerFollowBack: a.followBacks ? a.cost / a.followBacks : null,
  })).sort((x, y) => y.posted - x.posted);
  return { byModel: fin(byModel), byTone: fin(byTone), byArm: fin(byArm) };
}
