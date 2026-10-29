// ScoreX - find candidate targets through the x.com page:
//   myFollowers   your followers (group A candidates: they already follow you)
//   followersOf   followers of a big account
//   followingOf   who a smart account follows
//   search        people search for a keyword
//   common        accounts followed by several of the smart accounts you list (overlap count)
// Optionally visits the best candidates' profiles to score them (ScoreX rank + bot filter).

import { K, CMD } from "./constants.js";
import { load, save, getSettings, getTargets, updateTargets, updateCandidates, getCandidates, log } from "./store.js";
import { applyProfile } from "./targets.js";
import { navigate, send, waitForPage, workerTab } from "./tabs.js";
import { pageVerdict } from "./guard.js";
import { ownScore, suggestTier, passesDiscoveryFilters, combinedScore } from "./scores.js";
import { normalizeHandle, now, sleep, humanDelay, clamp } from "./util.js";

let cancelRequested = false;

async function setJob(patch) {
  const cur = await load(K.discovery, {});
  const next = { ...cur, ...patch, updatedAt: now() };
  await save({ [K.discovery]: next });
  return next;
}

export function sourceUrls(source, { me, handles, query }) {
  const hs = (handles || []).map(normalizeHandle).filter(Boolean);
  switch (source) {
    case "myFollowers": return me ? [{ url: `https://x.com/${me}/followers`, tag: "your followers" }] : [];
    case "followersOf": return hs.map((h) => ({ url: `https://x.com/${h}/followers`, tag: `followers of @${h}` }));
    case "followingOf": return hs.map((h) => ({ url: `https://x.com/${h}/following`, tag: `followed by @${h}` }));
    case "common": return hs.map((h) => ({ url: `https://x.com/${h}/following`, tag: `followed by @${h}`, seed: h }));
    case "search": return query ? [{ url: `https://x.com/search?q=${encodeURIComponent(query)}&f=user&src=typed_query`, tag: `search "${query}"` }] : [];
    default: return [];
  }
}

// Scroll a user list and collect cells until maxUsers or the list stops growing.
async function collectUsers(tabId, url, maxUsers, settings, onProgress) {
  const nav = await navigate(tabId, url);
  if (!nav.ok) return { ok: false, soft: nav.error };
  const w = await waitForPage(tabId, ["userCell", "emptyState"], 20000);
  const v = pageVerdict(w.page, settings);
  if (v && v.stop) return { ok: false, stop: v.stop, detail: v.detail };
  if (v && v.notFound) return { ok: true, users: [] };
  const users = new Map();
  let stale = 0;
  for (let i = 0; i < 60 && users.size < maxUsers && !cancelRequested; i++) {
    const r = await send(tabId, CMD.SCRAPE_USERS, { limit: 400 }, 15000);
    const vv = pageVerdict(r.page, settings);
    if (vv && vv.stop) return { ok: false, stop: vv.stop, detail: vv.detail };
    const before = users.size;
    for (const u of r.users || []) if (!users.has(u.handle)) users.set(u.handle, u);
    stale = users.size === before ? stale + 1 : 0;
    if (onProgress) await onProgress(users.size);
    if (stale >= 3) break;
    const s = await send(tabId, CMD.SCROLL, {}, 8000);
    await sleep(humanDelay(1400, 3600));
    if (s && s.atBottom && stale >= 1) break;
  }
  return { ok: true, users: [...users.values()].slice(0, maxUsers) };
}

async function profileOf(tabId, handle, settings) {
  const nav = await navigate(tabId, `https://x.com/${handle}`);
  if (!nav.ok) return { ok: false };
  const w = await waitForPage(tabId, ["profileUserName", "emptyState"], 20000);
  const v = pageVerdict(w.page, settings);
  if (v && v.stop) return { ok: false, stop: v.stop, detail: v.detail };
  if (v && v.notFound) return { ok: false, gone: true };
  await sleep(humanDelay(1200, 2600));
  const r = await send(tabId, CMD.SCRAPE_PROFILE, {}, 20000);
  const vv = pageVerdict(r.page, settings);
  if (vv && vv.stop) return { ok: false, stop: vv.stop, detail: vv.detail };
  return r.ok && r.profile ? { ok: true, profile: r.profile, posts: r.tweets || [] } : { ok: false };
}

function majorityLang(posts) {
  const c = {};
  for (const p of posts || []) if (p.lang && !["und", "zxx", "qme"].includes(p.lang)) c[p.lang] = (c[p.lang] || 0) + 1;
  let best = "", n = 0;
  for (const [k, v] of Object.entries(c)) if (v > n) { best = k; n = v; }
  return best;
}

// Rough pre-rank before profile visits (we only know cell data): verified + follows-you + overlap.
function preRank(c) {
  return (c.overlap || 1) * 10 + (c.verified ? 8 : 0) + (c.followsYou ? 3 : 0) - (c.defaultAvatar ? 10 : 0) - (/\d{6,}$/.test(c.handle) ? 6 : 0);
}

/**
 * Run a discovery job. Holds the engine lease (caller wraps with withLease).
 * opts: { source, handles, query, maxUsers, enrich }  stopFn(reason, detail) is engine.stop.
 */
export async function runDiscovery(opts, stopFn) {
  try {
    return await runDiscoveryInner(opts, stopFn);
  } catch (e) {
    await setJob({ status: "error", message: "Failed: " + String((e && e.message) || e).slice(0, 200), finishedAt: now() });
    log("error", "Discovery failed: " + String((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function runDiscoveryInner(opts, stopFn) {
  cancelRequested = false;
  const settings = await getSettings();
  const me = String(settings.account.handle || "").toLowerCase();
  const maxUsers = clamp(Math.round(Number(opts.maxUsers) || settings.discovery.maxUsers), 10, 1000);
  const sources = sourceUrls(opts.source, { me, handles: opts.handles, query: opts.query });
  if (!sources.length) {
    await setJob({ status: "error", message: "Nothing to search: add handles or a keyword (or set your X handle for 'My followers').", finishedAt: now() });
    return { ok: false, error: "Nothing to search: add handles or a keyword." };
  }
  await setJob({ status: "running", source: opts.source, step: "Opening X", progress: { done: 0, total: sources.length }, found: 0, message: "", startedAt: now(), finishedAt: null });
  const tabId = await workerTab(settings);
  if (tabId == null) { await setJob({ status: "error", message: "Could not open the X tab" }); return { ok: false, error: "Could not open the X tab" }; }

  const targets = await getTargets();
  const found = new Map();
  let i = 0;
  for (const s of sources) {
    if (cancelRequested) break;
    i++;
    await setJob({ step: `Reading ${s.tag}`, progress: { done: i - 1, total: sources.length } });
    const r = await collectUsers(tabId, s.url, maxUsers, settings, (n) => setJob({ message: `${s.tag}: ${n} accounts` }));
    if (r.stop) { await setJob({ status: "error", message: "Stopped: " + r.detail, finishedAt: now() }); await stopFn(r.stop, r.detail); return { ok: false, error: r.detail }; }
    if (!r.ok) { log("warn", `Discovery: could not read ${s.tag}`); continue; }
    for (const u of r.users) {
      if (u.handle === me) continue;
      const c = found.get(u.handle) || { ...u, sources: [], overlap: 0 };
      if (!c.sources.includes(s.tag)) { c.sources.push(s.tag); c.overlap++; }
      if (u.followsYou && opts.source !== "myFollowers") c.followsYou = true;
      if (opts.source === "myFollowers") c.followsYou = true;
      found.set(u.handle, c);
    }
    await sleep(humanDelay(2500, 6000));
  }

  let list = [...found.values()];
  if (opts.source === "common") list = list.filter((c) => c.overlap >= 2 || (opts.handles || []).length < 2);
  list.sort((a, b) => preRank(b) - preRank(a));

  // Enrich the best candidates with a profile visit.
  const enrichMax = opts.enrich ? clamp(settings.discovery.enrichMax, 0, 100) : 0;
  let enriched = 0;
  for (const c of list) {
    if (cancelRequested || enriched >= enrichMax) break;
    if (targets[c.handle]) continue;
    enriched++;
    await setJob({ step: `Scoring profiles ${enriched}/${Math.min(enrichMax, list.length)}`, message: "@" + c.handle });
    const p = await profileOf(tabId, c.handle, settings);
    if (p.stop) { await setJob({ status: "error", message: "Stopped: " + p.detail, finishedAt: now() }); await stopFn(p.stop, p.detail); return { ok: false, error: p.detail }; }
    if (p.ok) {
      const s = ownScore(p.profile, p.posts);
      c.profile = p.profile;
      c.name = p.profile.name || c.name;
      c.bio = p.profile.bio || c.bio;
      c.followers = p.profile.followers;
      c.following = p.profile.following;
      c.followsYou = p.profile.followsYou || c.followsYou;
      c.youFollow = p.profile.youFollow;
      c.lastPostAt = s.lastPostAt;
      c.lang = majorityLang(p.posts);
      c.score = { own: s.score, flags: s.flags, bot: s.bot, combined: combinedScore(s.score, null), parts: s.parts };
      c.recentPosts = (p.posts || []).filter((x) => !x.isRepost && !x.isReply).slice(0, 5).map((x) => ({ id: x.id, text: String(x.text || "").slice(0, 600), createdAt: x.createdAt, metrics: x.metrics, lang: x.lang }));
      c.suggestedTier = suggestTier(p.profile, s);
    }
    await sleep(humanDelay(4000, 9000));
  }

  const f = settings.discovery;
  const ts = now();
  await updateCandidates((all) => {
    for (const c of list) {
      if (targets[c.handle]) continue;
      const prev = all[c.handle] || {};
      const merged = { ...prev, ...c, sources: [...new Set([...(prev.sources || []), ...c.sources])], foundAt: prev.foundAt || ts };
      merged.overlap = Math.max(prev.overlap || 0, c.overlap || 0);
      merged.suggestedGroup = merged.followsYou ? "A" : "B";
      if (!merged.suggestedTier) merged.suggestedTier = merged.verified ? 1 : 2;
      const verdict = passesDiscoveryFilters(merged, f, ts);
      merged.pass = verdict.pass;
      merged.why = verdict.why;
      all[c.handle] = merged;
    }
    return all;
  });
  const status = cancelRequested ? "cancelled" : "done";
  await setJob({ status, step: status === "done" ? "Finished" : "Cancelled", progress: { done: sources.length, total: sources.length }, found: list.length, message: `${list.length} accounts found${enrichMax ? `, ${enriched} scored` : ""}`, finishedAt: now() });
  log("info", `Discovery ${status}: ${list.length} candidates from ${opts.source}`);
  return { ok: true, found: list.length };
}

export async function cancelDiscovery() {
  const cur = await load(K.discovery, {});
  if (cur.status !== "running" && cur.status !== "waiting") return cur;
  cancelRequested = true;
  return setJob({ status: "cancelling" });
}

// Move candidates into targets.
export async function candidatesToTargets(handles, group, tier, upsert) {
  const cands = await getCandidates();
  const rows = handles.map(normalizeHandle).filter((h) => cands[h]).map((h) => ({ handle: h, group, tier, name: cands[h].name || "" }));
  const res = await upsert(rows, { group, tier, source: "discovery" });
  // carry over the profile/score we already collected
  await updateTargets((all) => {
    for (const r of rows) {
      const c = cands[r.handle];
      if (all[r.handle] && c && c.profile) applyProfile(all[r.handle], c.profile, c.recentPosts || []);
      if (all[r.handle] && c && c.followsYou) all[r.handle].rel.followsYou = true;
    }
    return all;
  });
  await updateCandidates((all) => { for (const r of rows) delete all[r.handle]; return all; });
  return res;
}
