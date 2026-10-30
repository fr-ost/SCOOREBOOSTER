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
import { load, update, getSettings, getSecrets, getTargets, updateTargets, updateCandidates, getBlacklist, log } from "./store.js";
import { providerDefs, pickMode, modeNeeds, runCapability, CAPS } from "./providers.js";
import { now, DAY, HOUR, sleep, dayKey, normalizeHandle } from "./util.js";

const CAP_CHECKS = 150;
const CAP_SMART = 150;
const HISTORY_POINTS = 400;
const lastCall = new Map(); // providerId -> ts (pacing inside one worker instance)

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
      id: def.id, name: def.name, site: def.site, about: def.about || "", keyName: def.keyName || null, keyHelp: def.keyHelp || "",
      enabled: !!cfg.enabled, modePref: cfg.mode || "auto", mode, modes: Object.keys(def.modes || {}),
      needs: mode ? modeNeeds(def, mode) : { origins: [], permissions: [] },
      granted: mode ? await granted(def, mode) : false,
      hasKey, caps: Object.fromEntries(CAPS.map((c) => [c, !!(mode && def.modes[mode] && def.modes[mode][c])])),
      usage: { today: u && u.d === today ? u.n : 0, cap: cfg.dailyCap || 100 },
      own: (board.own || {})[def.id] || null,
      notes: def.notes || "",
    });
  }
  return out;
}

async function ready(id, cap, { settings, secrets, defs }) {
  const def = defs[id];
  if (!def) return { ok: false, error: "unknown", message: "Unknown provider" };
  const cfg = (settings.providers && settings.providers[id]) || {};
  if (!cfg.enabled) return { ok: false, error: "disabled", message: `${def.name} is off (Scores tab)` };
  const key = def.keyName ? secrets[def.keyName] || "" : "";
  const mode = pickMode(def, cfg.mode, !!key);
  if (!mode) return { ok: false, error: "no_mode", message: def.keyName ? `Add your ${def.name} API key (Scores tab)` : `${def.name} has no usable mode` };
  if (!def.modes[mode][cap]) return { ok: false, error: "unsupported", message: `${def.name} cannot do that${mode === "api" ? " with an API key" : ""}` };
  if (!(await granted(def, mode))) return { ok: false, error: "permission", message: `Allow ScoreX to reach ${def.name}: turn it off and on in the Scores tab` };
  return { ok: true, def, mode, key, cap: cfg.dailyCap || 100 };
}

// One provider call with pacing and the daily request cap.
async function call(id, cap, handle, ctx) {
  const r = await ready(id, cap, ctx);
  if (!r.ok) return r;
  const today = dayKey(now(), ctx.settings.timezone);
  const board = await getBoard();
  const u = (board.usage || {})[id];
  if (u && u.d === today && u.n >= r.cap) return { ok: false, error: "cap", message: `${r.def.name}: daily request cap reached (${r.cap})` };
  const spec = r.def.modes[r.mode][cap];
  const gap = r.def.minIntervalMs || (spec.kind === "tab" ? 4000 : 1200);
  const wait = (lastCall.get(id) || 0) + gap - now();
  if (wait > 0) await sleep(wait);
  lastCall.set(id, now());
  await updateBoard((b) => {
    b.usage = b.usage || {};
    const cur = b.usage[id];
    b.usage[id] = cur && cur.d === today ? { d: today, n: cur.n + 1 } : { d: today, n: 1 };
    return b;
  });
  const res = await runCapability(r.def, r.mode, cap, handle, { key: r.key, fetchImpl: ctx.fetchImpl, readPage: ctx.readPage });
  return { ...res, provider: id, mode: r.mode };
}

async function context(extra = {}) {
  const [settings, secrets, defs] = await Promise.all([getSettings(), getSecrets(), getDefs()]);
  return { settings, secrets, defs, ...extra };
}
function enabledWith(ctx, cap) {
  return Object.values(ctx.defs).filter((d) => ctx.settings.providers && ctx.settings.providers[d.id] && ctx.settings.providers[d.id].enabled && Object.values(d.modes || {}).some((m) => m[cap]));
}

// Your own scores. Skips providers refreshed in the last 20 hours unless forced.
export async function refreshOwn({ force = false, only = null, ...extra } = {}) {
  const ctx = await context(extra);
  const me = normalizeHandle(ctx.settings.account.handle);
  if (!me) return { ok: false, error: "Set your X handle first (Settings)" };
  const board = await getBoard();
  const results = {};
  for (const def of enabledWith(ctx, "score")) {
    if (only && !only.includes(def.id)) continue;
    const cur = (board.own || {})[def.id];
    if (!force && cur && cur.at && now() - cur.at < 20 * HOUR) { results[def.id] = { ok: true, cached: true, score: cur.score }; continue; }
    const r = await call(def.id, "score", me, ctx);
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
        b.own[def.id] = { ...prev, error: r.message || r.error || "error", errorAt: now() };
      }
      return b;
    });
  }
  const okN = Object.values(results).filter((r) => r.ok && !r.cached).length;
  if (okN) log("info", `Scores: refreshed ${okN} of your scores`);
  return { ok: true, results };
}

// Score of any account on every enabled provider.
export async function checkScores(handle, extra = {}) {
  const h = normalizeHandle(handle);
  if (!h) return { ok: false, error: "Enter a valid @handle" };
  const ctx = await context(extra);
  const list = enabledWith(ctx, "score");
  if (!list.length) return { ok: false, error: "Turn on at least one score provider first" };
  const results = {};
  for (const def of list) {
    const r = await call(def.id, "score", h, ctx);
    results[def.id] = r.ok ? { score: r.score, max: r.max != null ? r.max : null, url: r.url || "" } : { error: r.message || r.error, url: r.url || "" };
  }
  await updateBoard((b) => {
    b.checks = b.checks || {};
    b.checks[h] = { at: now(), results };
    capMap(b.checks, CAP_CHECKS);
    return b;
  });
  return { ok: true, handle: h, results };
}

// Top / smart followers of one account, from every enabled provider that can read them. Cached 3 days.
export async function smartFollowersOf(handle, { providers = null, maxAgeMs = 3 * DAY, ...extra } = {}) {
  const h = normalizeHandle(handle);
  if (!h) return { ok: false, error: "Enter a valid @handle" };
  const ctx = await context(extra);
  const list = enabledWith(ctx, "smartFollowers").filter((d) => !providers || providers.includes(d.id));
  if (!list.length) return { ok: false, error: "Turn on a provider that shows smart followers first (Scores tab)" };
  const cached = ((await getBoard()).smart || {})[h];
  const results = {};
  for (const def of list) {
    const c = cached && cached.results && cached.results[def.id];
    if (c && c.at && !c.error && now() - c.at < maxAgeMs) { results[def.id] = c; continue; }
    const r = await call(def.id, "smartFollowers", h, ctx);
    results[def.id] = r.ok ? { list: r.list || [], total: r.total != null ? r.total : null, url: r.url || "", at: now() } : { list: [], error: r.message || r.error, url: r.url || "", at: now() };
  }
  await updateBoard((b) => {
    b.smart = b.smart || {};
    b.smart[h] = { at: now(), results };
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
    if (extra.shouldStop && (await extra.shouldStop())) break;
    if (extra.onProgress) await extra.onProgress({ done, total: list.length, current: src, found: found.size });
    done++;
    const r = await smartFollowersOf(src, extra);
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
  await updateCandidates((all) => {
    for (const c of found.values()) {
      const prev = all[c.handle] || {};
      all[c.handle] = {
        ...prev,
        handle: c.handle,
        name: prev.name || c.name || "",
        followers: prev.followers != null ? prev.followers : c.followers,
        sources: [...new Set([...(prev.sources || []), ...c.sources])],
        overlap: Math.max(prev.overlap || 0, c.overlap),
        providerScores: { ...(prev.providerScores || {}), ...c.scores },
        foundAt: prev.foundAt || ts,
        suggestedTier: prev.suggestedTier || (c.followers != null && c.followers >= 50000 ? 1 : 2),
        smart: true,
        pass: prev.pass != null ? prev.pass : null,
        why: prev.why || [],
      };
    }
    return all;
  });
  log("info", `Smart followers: ${found.size} candidates from ${list.length} account${list.length === 1 ? "" : "s"}`);
  return { ok: true, found: found.size, errors };
}

// Provider scores of targets (stored in target.score.providers[id]); Sorsa also keeps target.score.sorsa.
export async function refreshTargetScores(handles, providerId, { maxAgeMs = DAY, ...extra } = {}) {
  const ctx = await context(extra);
  const def = ctx.defs[providerId];
  if (!def) return { ok: false, error: "Unknown provider" };
  const targets = await getTargets();
  const list = (handles && handles.length ? handles.map(normalizeHandle) : Object.keys(targets)).filter((h) => h && targets[h]);
  let updated = 0, done = 0;
  for (const h of list) {
    if (extra.shouldStop && (await extra.shouldStop())) break;
    if (extra.onProgress) await extra.onProgress({ done: done++, total: list.length, current: h, updated });
    const prev = targets[h].score && targets[h].score.providers && targets[h].score.providers[providerId];
    if (prev && prev.at && now() - prev.at < maxAgeMs) continue;
    const r = await call(providerId, "score", h, ctx);
    if (!r.ok) {
      if (["auth", "rate", "cap", "disabled", "permission", "no_mode", "blocked"].includes(r.error)) return { ok: false, error: r.message || r.error, updated };
      continue;
    }
    await updateTargets((all) => {
      const t = Object.hasOwn(all, h) ? all[h] : null;
      if (!t) return all;
      t.score = t.score || {};
      t.score.providers = { ...(t.score.providers || {}), [providerId]: { score: r.score, max: r.max != null ? r.max : null, at: now() } };
      if (providerId === "sorsa") { t.score.sorsa = r.score; t.score.sorsaUpdatedAt = now(); }
      return all;
    });
    updated++;
  }
  if (updated) log("info", `${def.name}: updated ${updated} target score${updated === 1 ? "" : "s"}`);
  return { ok: true, updated };
}

function capMap(map, cap) {
  const keys = Object.keys(map);
  if (keys.length <= cap) return;
  keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0));
  for (const k of keys.slice(0, keys.length - cap)) delete map[k];
}
