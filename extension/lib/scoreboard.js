// ScoreX - scoreboard: your own scores on the enabled providers (with daily history), one-off score checks
// of any account, smart / top followers of big accounts (a discovery source), and provider scores of your
// targets. Storage: sx.scoreboard (service-worker owned). Provider calls never touch the X worker tab.
//
// sx.scoreboard = {
//   own:    { [providerId]: { score, max, at, url, error, errorAt, history: [{ d: "YYYY-MM-DD", s }] } },
//   checks: { [handle]: { at, results: { [providerId]: { score, max, url, error } } } },        (capped)
//   smart:  { [handle]: { at, results: { [providerId]: { list, total, url, error, at } } } },  (capped)
//   usage:  { [providerId]: { d: "YYYY-MM-DD", n } },
// }

import { K } from "./constants.js";
import { load, update, withLock, getSettings, getSecrets, getTargets, updateTargets, updateCandidates, getBlacklist, log, resetCount } from "./store.js";
import { providerDefs, pickMode, modeNeeds, runCapability, CAPS, fill } from "./providers.js";
import { combinedScore } from "./scores.js";
import { upsertRows, countRows } from "./smartdb.js";
import { syncFollowBacks, followBackScoreNeeds } from "./followbacks.js";
import { now, DAY, HOUR, sleep, dayKey, normalizeHandle, clamp, num } from "./util.js";

const CAP_CHECKS = 150;
const CAP_SMART = 150;
const HISTORY_POINTS = 400;
export const TARGET_SCORE_MAX_AGE = 7 * DAY; // provider scores of targets are re-asked at most once a week
const FAIL_STREAK = 3; // a target-score run stops after this many failures in a row (outage, changed site)
// Errors that every following request would hit too: the run stops at the first one.
const FATAL = ["auth", "rate", "cap", "disabled", "permission", "no_mode", "blocked", "unsupported", "unknown", "login"];
// Your own score after one of these answers is asked again the next day, as after a success (a bot check, a refused
// key or quota, a login wall, no data, a changed page); network errors and setup problems retry at the next refresh.
export const OWN_NEXT_DAY = ["blocked", "auth", "rate", "login", "parse", "not_found"];
const lastCall = new Map(); // providerId -> ts (pacing inside one worker instance)
// Reset everything (lib/backup.js) since this operation started: it sends nothing more and writes nothing back.
const RESET = { ok: false, error: "reset", message: "Stopped: ScoreX was reset" };
const stale = (ctx) => resetCount() !== ctx.epoch;

export async function getBoard() { return load(K.scoreboard, {}); }
export function updateBoard(fn) { return update(K.scoreboard, {}, fn); }
export async function getDefs() { return providerDefs(await load(K.providerOverrides, {})); }

async function granted(def, mode) {
  const need = modeNeeds(def, mode);
  if (!need.origins.length && !need.permissions.length) return true;
  try { return await chrome.permissions.contains({ origins: need.origins, permissions: need.permissions }); } catch (_) { return false; }
}

// Everything the Scores tab needs to show a provider's setup state.
export async function providerStates() {
  const [settings, secrets, defs, board] = await Promise.all([getSettings(), getSecrets(), getDefs(), getBoard()]);
  const today = dayKey(now(), settings.timezone);
  const out = [];
  for (const def of Object.values(defs)) {
    const cfg = (settings.providers && settings.providers[def.id]) || {};
    const hasKey = !!(def.keyName && secrets[def.keyName]);
    const mode = pickMode(def, cfg.mode, hasKey);
    const u = (board.usage || {})[def.id];
    out.push({
      id: def.id, name: def.name, alias: def.alias || "", site: def.site, about: def.about || "", profileUrl: def.profileUrl || "",
      keyName: def.keyName || null, keyHelp: def.keyHelp || "", keyNote: def.keyNote || "", max: def.max || null, tiers: def.tiers || null,
      enabled: !!cfg.enabled, modePref: cfg.mode || "auto", mode, modes: Object.keys(def.modes || {}),
      needs: mode ? modeNeeds(def, mode) : { origins: [], permissions: [] },
      granted: mode ? await granted(def, mode) : false,
      hasKey, caps: Object.fromEntries(CAPS.map((c) => [c, !!(mode && def.modes[mode] && def.modes[mode][c])])),
      // TwitterScore with a key: your score from the free page, smart followers from the API.
      split: !!(Array.isArray(def.ownModes) && def.smartMode && hasKey && (cfg.mode || "auto") === "auto"),
      usage: { today: u && u.d === today ? u.n : 0, cap: cfg.dailyCap || 100 },
      own: (board.own || {})[def.id] || null,
      notes: def.notes || "",
    });
  }
  return out;
}

// want: a mode for this purpose (TwitterScore: the public page / tab for your own score, the API for smart followers).
async function ready(id, cap, { settings, secrets, defs }, want = null) {
  const def = defs[id];
  if (!def) return { ok: false, error: "unknown", message: "Unknown provider" };
  const cfg = (settings.providers && settings.providers[id]) || {};
  if (!cfg.enabled) return { ok: false, error: "disabled", message: `${def.name} is off (Scores tab)` };
  const key = def.keyName ? secrets[def.keyName] || "" : "";
  const mode = want && def.modes[want] && (want !== "api" || key) ? want : pickMode(def, cfg.mode, !!key);
  if (!mode) return { ok: false, error: "no_mode", message: def.keyName ? `Add your ${def.name} API key (Scores tab)` : `${def.name} has no usable mode` };
  if (!def.modes[mode][cap]) return { ok: false, error: "unsupported", message: `${def.name} cannot do that${mode === "api" ? " with an API key" : ""}` };
  if (!(await granted(def, mode))) return { ok: false, error: "permission", message: `Allow ScoreX to reach ${def.name}: turn it off and on in the Scores tab` };
  return { ok: true, def, mode, key, cap: cfg.dailyCap || 100 };
}

// One provider call with pacing and the daily request cap. Calls to one provider run one at a time (a background
// job and a one-off check from the popup no longer fire together), and the request is reserved against today's cap
// inside the scoreboard lock, so two calls at once can never both pass a cap that only one of them fits under.
// The settings are read again for every call: a provider turned off while a job runs is not asked again.
async function call(id, cap, handle, ctx, vars, want = null) {
  return withLock("sx.provider." + id, async () => {
    const settings = await getSettings();
    if (!want && cap === "smartFollowers" && ctx.defs[id] && ctx.defs[id].smartMode) want = ctx.defs[id].smartMode;
    const r = await ready(id, cap, { ...ctx, settings }, want);
    if (!r.ok) return r;
    const today = dayKey(now(), settings.timezone);
    // Paid API requests (apiUncapped) and the explicit database scan (ctx.noCap) are counted but not held back.
    const capped = !(ctx.noCap || (r.mode === "api" && r.def.apiUncapped));
    let allowed = false;
    await updateBoard((b) => {
      b.usage = b.usage || {};
      const cur = b.usage[id];
      const n = cur && cur.d === today ? num(cur.n, 0) : 0;
      if (capped && n >= r.cap) return b;
      allowed = true;
      b.usage[id] = { d: today, n: n + 1 };
      return b;
    });
    if (!allowed) return { ok: false, error: "cap", message: `${r.def.name}: daily request cap reached (${r.cap})` };
    const spec = r.def.modes[r.mode][cap];
    const gap = ctx.gapMs != null ? ctx.gapMs : clamp(num(r.def.minIntervalMs, spec.kind === "tab" ? 4000 : 1200), 250, 60000);
    const wait = Math.min(gap, (lastCall.get(id) || 0) + gap - now()); // never more than the gap (a clock set back)
    if (wait > 0) await sleep(wait);
    if (stale(ctx)) return { ...RESET, provider: id }; // nothing is awaited between this check and the request
    lastCall.set(id, now());
    const res = await runCapability(r.def, r.mode, cap, handle, { key: r.key, fetchImpl: ctx.fetchImpl, readPage: ctx.readPage, vars });
    return { ...res, provider: id, mode: r.mode };
  });
}

// extra.epoch: the reset count when the outer operation started (a smart-follower search passes its own down).
async function context(extra = {}) {
  const epoch = resetCount();
  const [settings, secrets, defs] = await Promise.all([getSettings(), getSecrets(), getDefs()]);
  return { settings, secrets, defs, epoch, ...extra };
}
function enabledWith(ctx, cap) {
  return Object.values(ctx.defs).filter((d) => ctx.settings.providers && ctx.settings.providers[d.id] && ctx.settings.providers[d.id].enabled && Object.values(d.modes || {}).some((m) => m[cap]));
}

// Your own scores. Skips providers refreshed in the last 20 hours unless forced, and providers whose site refused or
// had no score in the last 20 hours (OWN_NEXT_DAY: README "tries again another day").
export async function refreshOwn({ force = false, only = null, ...extra } = {}) {
  const ctx = await context(extra);
  const me = normalizeHandle(ctx.settings.account.handle);
  if (!me) return { ok: false, error: "Set your X handle first (Settings)" };
  const board = await getBoard();
  const results = {};
  for (const def of enabledWith(ctx, "score")) {
    if (only && !only.includes(def.id)) continue;
    const cur = (board.own || {})[def.id];
    if (!force && cur && cur.at && now() - cur.at < 20 * HOUR) { results[def.id] = { ok: true, cached: true, score: cur.score, max: cur.max != null ? cur.max : null, url: cur.url || "" }; continue; }
    if (!force && cur && cur.errorAt && OWN_NEXT_DAY.includes(cur.errorCode) && now() - cur.errorAt < 20 * HOUR) { results[def.id] = { ok: false, cached: true, error: cur.errorCode, message: cur.error || "", url: cur.url || "" }; continue; }
    const r = await ownScore(def, me, ctx);
    if (stale(ctx)) return { ok: false, error: RESET.message, results };
    results[def.id] = r;
    const d = dayKey(now(), ctx.settings.timezone);
    await updateBoard((b) => {
      b.own = b.own || {};
      const prev = b.own[def.id] || { history: [] };
      if (r.ok) {
        const history = (prev.history || []).filter((p) => p.d !== d);
        history.push({ d, s: r.score });
        history.sort((a, b2) => (a.d < b2.d ? -1 : 1));
        b.own[def.id] = { score: r.score, max: r.max != null ? r.max : prev.max || null, at: now(), url: r.url || prev.url || "", error: "", errorAt: null, history: history.slice(-HISTORY_POINTS) };
      } else {
        b.own[def.id] = { ...prev, error: r.message || r.error || "error", errorCode: r.error || "error", errorAt: now() };
      }
      return b;
    });
  }
  const okN = Object.values(results).filter((r) => r.ok && !r.cached).length;
  if (okN) log("info", `Scores: refreshed ${okN} of your scores`);
  return { ok: true, results };
}

// Your own score on one provider. A provider with ownModes (TwitterScore) never spends its API on it: the public page
// first, and when the site's bot check blocks that, the same page in a browser tab (a real browser passes the check).
async function ownScore(def, me, ctx) {
  const modes = Array.isArray(def.ownModes) && def.ownModes.length ? def.ownModes.filter((m) => def.modes[m]) : [null];
  let r = null;
  for (const m of modes) {
    r = await call(def.id, "score", me, ctx, undefined, m);
    if (r.ok || stale(ctx) || !["blocked", "permission", "unsupported", "no_mode"].includes(r.error)) return r;
  }
  if (modes.includes("page") && r && r.error === "permission")
    return { ...r, error: "blocked", message: `${def.name}'s site blocks direct reads (bot check). Allow the browser-tab mode: Scores > Providers > ${def.name}, turn it off and on (Chrome asks for access once)` };
  return r;
}

export const OTHERS_OFF = "Score checks of other accounts are off: Moni, Ethos and TwitterScore only check your own score (once a day), and TwitterScore's API only reads smart followers and the score of accounts that followed you back. Turn on 'Check other accounts' in Scores if you want to spend requests on this.";

// Score of any account on every enabled provider.
export async function checkScores(handle, extra = {}) {
  const h = normalizeHandle(handle);
  if (!h) return { ok: false, error: "Enter a valid @handle" };
  const ctx = await context(extra);
  if (!ctx.settings.scores.checkOthers && h !== normalizeHandle(ctx.settings.account.handle)) return { ok: false, error: OTHERS_OFF };
  const list = enabledWith(ctx, "score");
  if (!list.length) return { ok: false, error: "Turn on at least one score provider first" };
  const results = {};
  for (const def of list) {
    const r = await call(def.id, "score", h, ctx);
    results[def.id] = r.ok ? { score: r.score, max: r.max != null ? r.max : null, url: r.url || "" } : { error: r.message || r.error, url: r.url || "" };
  }
  if (stale(ctx)) return { ok: false, error: RESET.message };
  await updateBoard((b) => {
    b.checks = b.checks || {};
    b.checks[h] = { at: now(), results };
    capMap(b.checks, CAP_CHECKS);
    return b;
  });
  // A checked account that is one of your targets keeps the fresh scores too (Targets table and drawer).
  const fresh = Object.entries(results).filter(([, r]) => !r.error && r.score != null);
  if (fresh.length) {
    const blend = ctx.settings.scores.blendSorsa;
    await updateTargets((all) => {
      const t = Object.hasOwn(all, h) ? all[h] : null;
      if (!t) return all;
      t.score = t.score && typeof t.score === "object" ? t.score : {};
      t.score.providers = { ...(t.score.providers || {}) };
      for (const [pid, r] of fresh) {
        t.score.providers[pid] = { score: r.score, max: r.max, at: now() };
        if (pid === "sorsa") { t.score.sorsa = r.score; t.score.sorsaUpdatedAt = now(); }
      }
      t.score.combined = combinedScore(t.score.own, t.score.sorsa, blend);
      return all;
    });
  }
  return { ok: true, handle: h, results };
}

// Top / smart followers of one account, from every enabled provider that can read them. Cached 3 days.
export async function smartFollowersOf(handle, { providers = null, maxAgeMs = 3 * DAY, ...extra } = {}) {
  const h = normalizeHandle(handle);
  if (!h) return { ok: false, error: "Enter a valid @handle" };
  const ctx = await context(extra);
  // Moni and Ethos are kept for your own score; smart followers come from TwitterScore's API (and Sorsa if you use it).
  const list = enabledWith(ctx, "smartFollowers").filter((d) => !d.ownOnly && (!providers || providers.includes(d.id)));
  if (!list.length) return { ok: false, error: "Turn on TwitterScore with your API key first (Scores > Providers): smart followers come from its API" };
  const cached = ((await getBoard()).smart || {})[h];
  const results = {};
  for (const def of list) {
    const c = cached && cached.results && cached.results[def.id];
    if (c && c.at && !c.error && now() - c.at < maxAgeMs) { results[def.id] = c; continue; }
    const r = await lookupSmart(def, h, ctx);
    results[def.id] = r.ok ? { list: r.list || [], total: r.total != null ? r.total : null, url: r.url || "", at: now() } : { list: [], error: r.message || r.error, url: r.url || "", at: now() };
  }
  if (stale(ctx)) return { ok: false, error: RESET.message };
  await updateBoard((b) => {
    b.smart = b.smart || {};
    // Results of providers not asked this time (a `providers` filter) stay in the cache.
    const kept = b.smart[h] && b.smart[h].results && typeof b.smart[h].results === "object" ? b.smart[h].results : {};
    b.smart[h] = { at: now(), results: { ...kept, ...results } };
    capMap(b.smart, CAP_SMART);
    return b;
  });
  return { ok: true, handle: h, results, merged: mergeLists(results) };
}

// One list across providers: each account once, with the providers that listed it and their scores.
export function mergeLists(results) {
  const by = new Map();
  for (const [pid, r] of Object.entries(results || {})) {
    for (const it of (r && r.list) || []) {
      const cur = by.get(it.handle) || { handle: it.handle, name: "", followers: null, scores: {}, providers: [] };
      if (!cur.name && it.name) cur.name = it.name;
      if (cur.followers == null && it.followers != null) cur.followers = it.followers;
      if (it.score != null) cur.scores[pid] = it.score;
      if (!cur.providers.includes(pid)) cur.providers.push(pid);
      by.set(it.handle, cur);
    }
  }
  return [...by.values()];
}

// Smart followers of several big accounts -> candidates (the overlap = how many of them list the account).
// Existing targets, blacklisted accounts and your own handle are skipped.
export async function sweepSmartFollowers(handles, extra = {}) {
  const list = [...new Set((handles || []).map(normalizeHandle).filter(Boolean))].slice(0, 25);
  if (!list.length) return { ok: false, error: "Enter at least one @handle" };
  const ctx = await context(extra);
  const me = normalizeHandle(ctx.settings.account.handle);
  const [targets, black] = await Promise.all([getTargets(), getBlacklist()]);
  const found = new Map();
  const errors = [];
  let done = 0;
  for (const src of list) {
    if (stale(ctx) || (extra.shouldStop && (await extra.shouldStop()))) break;
    if (extra.onProgress) await extra.onProgress({ done, total: list.length, current: src, found: found.size });
    done++;
    const r = await smartFollowersOf(src, { ...extra, epoch: ctx.epoch });
    if (!r.ok) { errors.push(`@${src}: ${r.error}`); if (/Turn on/.test(r.error || "")) break; continue; }
    for (const [pid, res] of Object.entries(r.results)) if (res.error) errors.push(`@${src} (${ctx.defs[pid] ? ctx.defs[pid].name : pid}): ${res.error}`);
    for (const it of r.merged) {
      if (it.handle === me || it.handle === src || Object.hasOwn(targets, it.handle) || Object.hasOwn(black, it.handle)) continue;
      const cur = found.get(it.handle) || { ...it, sources: [], overlap: 0 };
      const tag = `smart follower of @${src}`;
      if (!cur.sources.includes(tag)) { cur.sources.push(tag); cur.overlap++; }
      cur.scores = { ...cur.scores, ...it.scores };
      found.set(it.handle, cur);
    }
  }
  const ts = now();
  // The search can take minutes: accounts added as targets or blacklisted meanwhile are left out too.
  const [targetsNow, blackNow] = await Promise.all([getTargets(), getBlacklist()]);
  // sx.candidates stays at the newest / best CANDIDATES_CAP entries (updateCandidates, lib/store.js); seenAt marks a
  // repeat find as recent. After Reset everything (it cleared the candidates) nothing found before it is written.
  let reset = false;
  await updateCandidates((all) => {
    if (stale(ctx)) { reset = true; return all; }
    for (const c of found.values()) {
      if (Object.hasOwn(targetsNow, c.handle) || Object.hasOwn(blackNow, c.handle)) continue;
      const prev = Object.hasOwn(all, c.handle) && all[c.handle] && typeof all[c.handle] === "object" ? all[c.handle] : {};
      all[c.handle] = {
        ...prev,
        handle: c.handle,
        name: prev.name || c.name || "",
        followers: prev.followers != null ? prev.followers : c.followers,
        sources: [...new Set([...(prev.sources || []), ...c.sources])],
        overlap: Math.max(prev.overlap || 0, c.overlap),
        providerScores: { ...(prev.providerScores || {}), ...c.scores },
        foundAt: prev.foundAt || ts,
        seenAt: ts,
        suggestedTier: prev.suggestedTier || (c.followers != null && c.followers >= 50000 ? 1 : 2),
        smart: true,
        pass: prev.pass != null ? prev.pass : null,
        why: prev.why || [],
      };
    }
    return all;
  });
  if (reset) return { ok: false, error: RESET.message, found: 0, errors };
  log("info", `Smart followers: ${found.size} candidates from ${list.length} account${list.length === 1 ? "" : "s"}`);
  // Nothing found and every request failed: an error, not "done".
  if (!found.size && errors.length) return { ok: false, error: errors[0] + (errors.length > 1 ? ` (and ${errors.length - 1} more)` : ""), found: 0, errors };
  return { ok: true, found: found.size, errors };
}

// Provider scores of targets (stored in target.score.providers[id] = { score, max, at }); Sorsa also keeps
// target.score.sorsa, and target.score.combined is recomputed (lib/scores.js combinedScore). Scores are cached for
// TARGET_SCORE_MAX_AGE; an account the provider has no data for is remembered as { score: null } for as long, so it
// is not asked again every run. The run stops at an error every request would hit (key, cap, bot check...) and after
// FAIL_STREAK failures in a row; it reports ok:false when nothing could be updated.
// want: a mode to use ("api": TwitterScore's paid API); explicit: you pressed a button for exactly this (Targets > Load
// TwitterScore), so the "Check other accounts" switch does not hold it back.
export async function refreshTargetScores(handles, providerId, { maxAgeMs = TARGET_SCORE_MAX_AGE, want = null, explicit = false, ...extra } = {}) {
  const ctx = await context(extra);
  const def = ctx.defs[providerId];
  if (!def) return { ok: false, error: "Unknown provider" };
  if (!explicit && !ctx.settings.scores.checkOthers) return { ok: false, error: OTHERS_OFF, updated: 0, failed: 0 };
  const blend = ctx.settings.scores.blendSorsa;
  const targets = await getTargets();
  const list = (handles && handles.length ? handles.map(normalizeHandle) : Object.keys(targets)).filter((h) => h && Object.hasOwn(targets, h) && targets[h]);
  let updated = 0, done = 0, failed = 0, streak = 0, fresh = 0, missingN = 0, lastError = "";
  for (const h of list) {
    if (extra.shouldStop && (await extra.shouldStop())) break;
    if (extra.onProgress) await extra.onProgress({ done: done++, total: list.length, current: h, updated });
    const prev = targets[h].score && targets[h].score.providers && targets[h].score.providers[providerId];
    if (prev && prev.at && now() - prev.at < maxAgeMs) { fresh++; continue; }
    const r = await call(providerId, "score", h, ctx, {}, want);
    if (stale(ctx)) return { ok: false, error: RESET.message, updated, failed }; // the targets are gone
    const missing = !r.ok && r.error === "not_found";
    if (!r.ok && !missing) {
      failed++; streak++; lastError = r.message || r.error || "error";
      if (FATAL.includes(r.error)) return { ok: false, error: lastError, updated, failed };
      if (streak >= FAIL_STREAK) return { ok: false, error: `${def.name}: ${streak} failures in a row, stopped (${lastError})`, updated, failed };
      continue;
    }
    streak = 0;
    await updateTargets((all) => {
      const t = Object.hasOwn(all, h) ? all[h] : null;
      if (!t) return all;
      t.score = t.score && typeof t.score === "object" ? t.score : {};
      const before = t.score.providers && t.score.providers[providerId];
      if (missing && before && before.score != null) return all; // keep a score it had before
      t.score.providers = { ...(t.score.providers || {}), [providerId]: missing ? { score: null, max: null, at: now() } : { score: r.score, max: r.max != null ? r.max : null, at: now() } };
      if (!missing && providerId === "sorsa") { t.score.sorsa = r.score; t.score.sorsaUpdatedAt = now(); }
      t.score.combined = combinedScore(t.score.own, t.score.sorsa, blend);
      return all;
    });
    if (!missing) updated++; else missingN++;
  }
  if (extra.onProgress) await extra.onProgress({ done: list.length, total: list.length, current: "", updated });
  if (updated) log("info", `${def.name}: updated ${updated} target score${updated === 1 ? "" : "s"}`);
  if (!updated && failed) return { ok: false, error: `${def.name}: no target score could be updated (${lastError})`, updated, failed, fresh, missing: missingN };
  return { ok: true, updated, failed, fresh, missing: missingN };
}

// Targets > Load TwitterScore: is TwitterScore's paid API usable (turned on, your key saved)? { ok } | { ok:false, error }.
export async function twitterScoreApiReady() {
  const [settings, secrets, defs] = await Promise.all([getSettings(), getSecrets(), getDefs()]);
  const def = defs.twitterscore;
  if (!def || !def.modes || !def.modes.api) return { ok: false, error: "TwitterScore's API is not available" };
  if (!(settings.providers && settings.providers.twitterscore && settings.providers.twitterscore.enabled)) return { ok: false, error: "Turn TwitterScore on in Scores first" };
  if (!secrets[def.keyName]) return { ok: false, error: "Add your TwitterScore API key in Scores first" };
  return { ok: true };
}
// Targets > Load TwitterScore: the TwitterScore of every target through TwitterScore's paid API (your key), only when you
// press the button. Every press loads them all again - a score that is already there (loaded or imported) is refreshed,
// with no waiting period. Tiers are not changed.
export async function loadTargetTwitterScores(extra = {}) {
  const ready = await twitterScoreApiReady();
  if (!ready.ok) return ready;
  return refreshTargetScores([], "twitterscore", { ...extra, want: "api", explicit: true, maxAgeMs: 0 });
}

// ---------- TwitterScore of the accounts that followed you back (History > Follow-backs) ----------
// Asked through TwitterScore's paid API only (your key - never the public page), and only for accounts that followed
// you back and have no TwitterScore yet: the score a target already carries is copied without a request. This is the
// one place other accounts' scores are fetched while "Check other accounts" is off - you asked for it for the accounts
// that followed you back. An account TwitterScore has no data for is asked again after a week (followbacks.js
// FB_TS_RETRY). The score goes on the follow-back entries (twitterscore, twitterscoreAt; twitterscoreNone: no data) and
// on the target, if it still is one. Runs one at a time; started when a follow-back is recorded and when the
// Follow-backs page opens.
export const FB_TS_MAX = 50; // accounts asked per run (follow-backs are few; a later run takes the rest)
let fbScoresRun = null;
export function followBackScores(extra = {}) {
  if (!fbScoresRun) fbScoresRun = runFollowBackScores(extra).finally(() => { fbScoresRun = null; });
  return fbScoresRun;
}
async function runFollowBackScores({ max = FB_TS_MAX, ...extra } = {}) {
  const ctx = await context(extra);
  const id = "twitterscore";
  const def = ctx.defs[id];
  if (!def || !def.modes || !def.modes.api) return { ok: false, error: "unsupported", message: "TwitterScore's API is not available" };
  const cfg = (ctx.settings.providers && ctx.settings.providers[id]) || {};
  if (!cfg.enabled) return { ok: false, error: "disabled", message: "Turn TwitterScore on in Scores to fill the TwitterScore column" };
  if (!(def.keyName && ctx.secrets[def.keyName])) return { ok: false, error: "no_key", message: "Add your TwitterScore API key in Scores to fill the TwitterScore column" };
  await syncFollowBacks({ fromHistory: true }).catch(() => 0);
  const [entries, targets] = await Promise.all([load(K.followbacks, []), getTargets()]);
  const need = followBackScoreNeeds(entries, now());
  let fetched = 0, copied = 0, none = 0, failed = 0, lastError = "";
  for (const h of need.slice(0, max)) {
    if (extra.shouldStop && (await extra.shouldStop())) break;
    const t = Object.hasOwn(targets, h) ? targets[h] : null;
    const known = t && t.score && t.score.providers && t.score.providers[id];
    let score = known && known.score != null ? Number(known.score) : null, missing = false;
    if (score != null) copied++;
    else {
      const r = await call(id, "score", h, ctx, {}, "api");
      if (stale(ctx)) return { ...RESET, fetched, copied, none, failed };
      if (r.ok && r.score != null) { score = Number(r.score); fetched++; }
      else if (!r.ok && r.error === "not_found") { missing = true; none++; }
      else {
        failed++; lastError = r.message || r.error || "error";
        if (FATAL.includes(r.error) || failed >= FAIL_STREAK) break;
        continue;
      }
      await updateTargets((all) => {
        const x = Object.hasOwn(all, h) ? all[h] : null;
        if (!x) return all;
        const before = x.score && x.score.providers && x.score.providers[id];
        if (missing && before && before.score != null) return all;
        x.score = x.score && typeof x.score === "object" ? x.score : {};
        x.score.providers = { ...(x.score.providers || {}), [id]: { score: missing ? null : score, max: missing ? null : def.max || 1000, at: now() } };
        return all;
      });
    }
    const at = now();
    await update(K.followbacks, [], (list) => (Array.isArray(list) ? list : []).map((e) => {
      if (!e || e.handle !== h || e.twitterscore != null) return e;
      const next = { ...e, twitterscore: score, twitterscoreAt: at };
      if (missing) next.twitterscoreNone = true; else delete next.twitterscoreNone;
      return next;
    }));
  }
  if (fetched) log("info", `TwitterScore: fetched the score of ${fetched} account${fetched === 1 ? "" : "s"} that followed you back`);
  if (failed && !fetched && !copied && !none) return { ok: false, error: lastError, fetched, copied, none, failed, left: need.length };
  return { ok: true, fetched, copied, none, failed, left: Math.max(0, need.length - fetched - copied - none), ...(lastError ? { lastError } : {}) };
}

function capMap(map, cap) {
  const keys = Object.keys(map);
  if (keys.length <= cap) return;
  keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0));
  for (const k of keys.slice(0, keys.length - cap)) delete map[k];
}

// ---------- smart followers, page by page (TwitterScore's API) ----------

export const LOOKUP_PAGES = 4; // Find targets / popup: the best 100 smart followers of an account (4 requests)
export const SCAN_PAGES = 2000; // the database scan: every page (a safety stop at 50,000 per account)
const RATE_WAIT_MS = 60 * 1000;
const RATE_TRIES = 3;
const ALT_ON = ["not_found", "http", "parse"];

async function waitOrStop(ms, shouldStop) {
  const until = now() + ms;
  while (now() < until) {
    if (shouldStop && (await shouldStop())) return true;
    await sleep(Math.min(1000, Math.max(0, until - now())));
  }
  return false;
}

// Every page of one account's smart followers, best first. TwitterScore serves at most 25 per request (page 1, 2, ...;
// an empty page after the last). An account ends at an empty page, a short page, a page with nothing new (the API
// ignored the page number), the reported total, or maxPages. A rate limit (429) waits a minute and asks again (3
// times). TwitterScore marks top_followers_paginate deprecated: when it answers 404 / an error / something unreadable
// on a first page, get_followers (its replacement) is asked, and used for the rest of the run once it answers.
// onPage(rows, { page, total }) gets each page's new rows as they arrive. Never throws.
export async function pagedSmartFollowers(id, handle, ctx, { maxPages = SCAN_PAGES, onPage, shouldStop } = {}) {
  const h = normalizeHandle(handle);
  const def = ctx.defs[id];
  const api = def && def.modes && def.modes.api;
  const spec = api && api.smartFollowers;
  if (!spec) return { ok: false, error: "unsupported", message: `${def ? def.name : "Provider"} has no paged smart followers` };
  const size = clamp(Math.round(num(spec.pageSize, 25)), 1, 100);
  const seen = new Set();
  const list = [];
  let pages = 0, requests = 0, total = null, firstLen = 0;
  for (let page = 1; page <= maxPages; page++) {
    if (shouldStop && (await shouldStop())) return { ok: true, list, pages, requests, total, stopped: true };
    let r = null;
    for (let tries = 0; ; tries++) {
      r = await call(id, ctx.altEndpoint ? "smartFollowersAlt" : "smartFollowers", h, ctx, { page, size }, "api");
      requests++;
      if (stale(ctx)) return { ...RESET, list, pages, requests };
      if (!r.ok && page === 1 && !ctx.altEndpoint && api.smartFollowersAlt && ALT_ON.includes(r.error)) {
        const alt = await call(id, "smartFollowersAlt", h, ctx, { page, size }, "api");
        requests++;
        if (alt.ok && (alt.list || []).length) { ctx.altEndpoint = true; r = alt; }
        else if (alt.ok || alt.error === "not_found") r = r.error === "not_found" ? r : alt; // nothing on either: no data
      }
      if (r.ok || r.error !== "rate" || tries >= RATE_TRIES) break;
      if (await waitOrStop(RATE_WAIT_MS, shouldStop)) return { ok: true, list, pages, requests, total, stopped: true };
    }
    if (!r.ok) {
      if (r.error === "not_found") return { ok: true, list, pages, requests, total: total != null ? total : list.length, url: r.url || "" };
      return { ...r, list, pages, requests, total };
    }
    if (r.mode !== "api") return { ok: false, error: "no_mode", message: `Add your ${def.name} API key first (Scores > Providers): the free page only shows 3`, list, pages, requests };
    pages++;
    const rows = r.list || [];
    // The reported total is trusted as "all smart followers" only when it is plausible: larger than one page, or this
    // page was short. A full page with a total of 25 or less (a page count, or this page's count) is ignored, so a
    // misread total can never end a scan after the first page; an empty page ends it instead.
    if (Number.isFinite(r.total) && r.total > 0 && (r.total > size || rows.length < size)) total = r.total;
    const fresh = rows.filter((x) => x && x.handle && !seen.has(x.handle));
    for (const x of fresh) { seen.add(x.handle); list.push(x); }
    if (fresh.length && onPage) await onPage(fresh, { page, total });
    if (page === 1) firstLen = rows.length;
    const last = !rows.length || !fresh.length || (total > 0 && list.length >= total) || (page > 1 && rows.length < firstLen) || (page === 1 && total == null && rows.length < Math.min(size, 5));
    if (last) break;
  }
  return { ok: true, list, pages, requests, total: total != null ? total : list.length };
}

// One account's smart followers from one provider for Find targets / the popup: TwitterScore's API reads its first
// LOOKUP_PAGES pages; every other provider (and TwitterScore's free page) answers with one request.
async function lookupSmart(def, h, ctx) {
  const settings = await getSettings();
  const r = await ready(def.id, "smartFollowers", { ...ctx, settings }, def.smartMode || null);
  if (r.ok && r.mode === "api" && r.def.modes.api.smartFollowers && r.def.modes.api.smartFollowers.pageSize) {
    const p = await pagedSmartFollowers(def.id, h, ctx, { maxPages: LOOKUP_PAGES });
    if (!p.ok && !(p.list && p.list.length)) return p;
    const list = (p.list || []).slice(0, clamp(Math.round(num(def.listLimit, 100)), 1, 200));
    return { ok: true, list, total: p.total != null ? p.total : list.length, url: def.profileUrl ? fill(def.profileUrl, { handle: h }) : "", mode: "api", provider: def.id };
  }
  return call(def.id, "smartFollowers", h, ctx);
}

// Smart follower database (Discover): every smart follower TwitterScore's API lists for each account, merged into
// lib/smartdb.js as the pages arrive (Stop keeps what was read). Needs TwitterScore on with your API key. Each page
// (25 accounts) is one API request; ScoreX's daily cap does not stop this scan (you started it, Stop ends it).
export async function buildSmartDb(handles, extra = {}) {
  const list = [...new Set((handles || []).map(normalizeHandle).filter(Boolean))].slice(0, 500);
  if (!list.length) return { ok: false, error: "Enter at least one username or link" };
  const ctx = await context({ ...extra, noCap: true });
  const cfg = (ctx.settings.providers && ctx.settings.providers.twitterscore) || {};
  if (!ctx.secrets.twitterscoreKey) return { ok: false, error: "Add your TwitterScore API key first" };
  if (!cfg.enabled) return { ok: false, error: "Turn TwitterScore on first (Scores > Providers)" };
  let pages = 0, requests = 0, added = 0, updated = 0, done = 0, found = 0;
  const errors = [], empty = [];
  for (const h of list) {
    if (extra.shouldStop && (await extra.shouldStop())) break;
    const ts = now();
    let page = 0, total = null;
    const progress = () => {
      const est = total && total <= SCAN_PAGES * 25 ? Math.max(page, Math.ceil(total / 25)) : null; // pages this account will take
      return extra.onProgress && extra.onProgress({ done, total: list.length, current: `@${h} · page ${page}${est ? ` of ${est}` : ""}`, page, pagesEst: est, updated: added, found, requests });
    };
    await progress();
    const r = await pagedSmartFollowers("twitterscore", h, ctx, {
      shouldStop: extra.shouldStop,
      onPage: async (rows, info) => {
        page = info.page; total = info.total;
        const u = await upsertRows(h, rows, ts);
        added += u.added; updated += u.updated; found += rows.length;
        await progress();
      },
    });
    pages += r.pages || 0; requests += r.requests || 0;
    if (stale(ctx)) return { ok: false, error: "Reset", pages, requests, added, updated };
    if (!r.ok) {
      const msg = r.message || r.error || "error";
      if (FATAL.includes(r.error) || r.error === "no_mode") return { ok: false, error: msg, accounts: done, pages, requests, added, updated, total: await countRows() };
      errors.push(`@${h}: ${msg}`);
    } else if (!(r.list || []).length && !r.stopped) empty.push(h);
    done++;
    if (r.stopped) break;
  }
  if (extra.onProgress) await extra.onProgress({ done, total: list.length, current: "", updated: added, found, requests });
  log("info", `Smart follower database: ${found} smart followers from ${done} account${done === 1 ? "" : "s"} (${requests} TwitterScore requests), ${added} new`);
  const total = await countRows();
  if (!found && errors.length === done && done > 0) return { ok: false, error: errors.slice(0, 3).join("; "), accounts: done, pages, requests, added, updated, total };
  return { ok: true, accounts: done, pages, requests, found, added, updated, total, errors, empty };
}
