// ScoreX - targets: the accounts we comment on. Stored as { [handle]: Target } in chrome.storage (SW-owned).
//
// Target {
//   handle, name, group: "A"|"B" (follows you / not; synced from rel.followsYou), tier: 1|2, enabled,
//   tone (override key or ""), preset (override key or ""),
//   notes, source, addedAt,
//   profile: { handle, name, bio, followers, following, verified, protected, defaultAvatar, joinedAt, avatar, updatedAt },
//   recentPosts: [{ id, text, createdAt, metrics, lang, isQuote, hasMedia, hasCard, links }]  (newest first, max 5)
//   lastPostAt, lastCheckedAt,
//   rel: { followsYou (null = not checked yet), youFollow, checkedAt, youFollowSince, followedBackAt,
//          notFollowingSeen, unfollowedYouAt (it followed you, then unfollowed; followedBackAt then moves to
//          prevFollowedBackAt), gone (profile not found; cleared
//          when the profile reads fine again or the target is turned on again), verifiedAt (last "does it still
//          follow you?" visit, follow.js) },
//   score: { own, sorsa, combined, flags, bot, updatedAt, sorsaUpdatedAt, providers: { [id]: { score, max, at } },
//            value (0-100 | null), propensity (0-1 | null), why }  (value/propensity/why: learning.updatePriorities),
//   priority (0-100), coldUntil,
//   stats: { comments, firstCommentAt, lastCommentAt, engaged, noResponseStreak, likes, replies, authorReplies, lastEngagedAt }
// }
//
// Follow status (follow tracking, lib/follow.js): only targets that do NOT follow you are commented on.

import { GROUP, TIER, BUILTIN_TONES, PRESET_KEYS } from "./constants.js";
import { normalizeHandle, parseHandleList, now, clamp, num, DAY } from "./util.js";
import { getTargets, updateTargets, getBlacklist, DEFAULT_TONE_PROMPT } from "./store.js";

export const FS = Object.freeze({
  CHECKING: "checking", // not checked yet: never commented on until it is
  ACTIVE: "active", // does not follow you: comments allowed
  FOLLOWS: "follows", // already followed you when checked: never commented on
  FOLLOWED_BACK: "followed_back", // followed you back after ScoreX started: comments stopped
});
export const FS_LABEL = Object.freeze({
  checking: "Checking",
  active: "Not following",
  follows: "Follows you",
  followed_back: "Followed back",
});
export function followStatus(t) {
  const rel = (t && t.rel) || {};
  if (rel.followsYou === true) return rel.followedBackAt ? FS.FOLLOWED_BACK : FS.FOLLOWS;
  if (rel.followsYou === false) return FS.ACTIVE;
  return FS.CHECKING;
}
// Whole days since the first comment to this target (null before the first comment).
export function followDays(t, ts = now()) {
  const first = t && t.stats && t.stats.firstCommentAt;
  return first ? Math.max(0, Math.floor((ts - first) / DAY)) : null;
}
import { ownScore, combinedScore, suggestTier } from "./scores.js";

export function newTarget(handle, opts = {}) {
  return {
    handle,
    name: opts.name || "",
    group: GROUP.B, // provisional until the follow check

    tier: Number(opts.tier) === 1 ? TIER.T1 : TIER.T2,
    enabled: opts.enabled !== false,
    tone: opts.tone || "",
    preset: opts.preset || "",
    notes: opts.notes || "",
    source: opts.source || "manual",
    addedAt: now(),
    profile: null,
    recentPosts: [],
    lastPostAt: null,
    lastCheckedAt: null,
    rel: { followsYou: null, youFollow: null, checkedAt: null, youFollowSince: null, followedBackAt: null },
    score: null,
    priority: Number(opts.tier) === 1 ? 70 : 50,
    coldUntil: null,
    stats: { comments: 0, firstCommentAt: null, lastCommentAt: null, engaged: 0, noResponseStreak: 0, likes: 0, replies: 0, authorReplies: 0, lastEngagedAt: null },
  };
}

// The group is not editable: it always follows the detected follow status.
const EDITABLE = ["name", "tier", "enabled", "tone", "preset", "notes", "priority"];

export function sanitizePatch(patch) {
  const out = {};
  for (const k of EDITABLE) if (Object.hasOwn(patch, k)) out[k] = patch[k];
  // A tier chosen by the user is not changed by self-learning afterwards.
  if ("tier" in out) { out.tier = Number(out.tier) === 1 ? 1 : 2; out.tierManual = true; }
  if ("enabled" in out) out.enabled = !!out.enabled;
  if ("priority" in out) { out.priority = clamp(Math.round(num(out.priority, 50)), 0, 100); out.priorityManual = true; }
  if ("tone" in out) out.tone = String(out.tone || "");
  if ("preset" in out) out.preset = PRESET_KEYS.includes(out.preset) ? out.preset : "";
  if ("notes" in out) out.notes = String(out.notes || "").slice(0, 500);
  if ("name" in out) out.name = String(out.name || "").slice(0, 80);
  return out;
}

// Parse a pasted list / CSV / JSON into rows { handle, group?, tier?, tone?, notes? }.
// CSV columns (header optional): handle,group,tier,tone,notes
export function parseImport(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  if (/^[[{]/.test(raw)) {
    try {
      let data = JSON.parse(raw);
      if (data && !Array.isArray(data)) data = data.targets ? (Array.isArray(data.targets) ? data.targets : Object.values(data.targets)) : Object.values(data);
      const rows = [];
      for (const item of data) {
        if (typeof item === "string") { const h = normalizeHandle(item); if (h) rows.push({ handle: h }); continue; }
        const h = normalizeHandle(item && (item.handle || item.username || item.screen_name));
        if (h) rows.push({ handle: h, group: item.group, tier: item.tier, tone: item.tone, notes: item.notes, name: item.name });
      }
      return dedupeRows(rows);
    } catch (_) { /* fall through to text */ }
  }
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // CSV = a header row, or rows whose 2nd cell is empty or a group/tier value ("foo,A,1"). A plain
  // "alice, bob, carol" list is NOT CSV (it would otherwise import only "alice").
  const isHeader = (l) => splitCsv(l).some((c) => /^(handle|username|group|tier)$/i.test(c.trim()));
  const looksCsv = isHeader(lines[0]) || lines.some((l) => /^(?:@?\w{1,15}|https?:\S+)\s*,\s*(?:a|b|1|2)?\s*(?:,|$)/i.test(l));
  if (!looksCsv) return parseHandleList(raw).map((handle) => ({ handle }));
  const rows = [];
  let cols = ["handle", "group", "tier", "tone", "notes"];
  lines.forEach((line, i) => {
    const cells = splitCsv(line);
    if (i === 0 && cells.some((c) => /^(handle|username|group|tier)$/i.test(c.trim()))) { cols = cells.map((c) => c.trim().toLowerCase()); return; }
    const row = {};
    cols.forEach((c, j) => { if (cells[j] != null && cells[j] !== "") row[c === "username" ? "handle" : c] = cells[j].trim(); });
    row.handle = normalizeHandle(row.handle);
    if (row.handle) rows.push(row);
  });
  return dedupeRows(rows);
}
function splitCsv(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}
function dedupeRows(rows) {
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.handle) ? false : (seen.add(r.handle), true)));
}
function rowTier(v, def) { const n = Number(String(v || "").replace(/\D/g, "")); return n === 1 || n === 2 ? n : def; }

// Add or update targets. rows: [{handle, tier?, tone?, notes?}] or handles. defaults: {tier, source}.
// Existing targets keep their stats; tier/tone are overwritten only if given explicitly in a row or
// `overwrite` is true. A "group" column is ignored: who follows you is always checked on X.
// Blacklisted handles are never added (counted in `blacklisted`).
export async function upsert(rows, defaults = {}, overwrite = false) {
  const list = (rows || []).map((r) => (typeof r === "string" ? { handle: normalizeHandle(r) } : { ...r, handle: normalizeHandle(r.handle) })).filter((r) => r.handle);
  let added = 0, updated = 0, blacklisted = 0;
  const me = String(defaults.myHandle || "").trim().replace(/^@/, "").toLowerCase();
  const black = await getBlacklist();
  await updateTargets((all) => {
    for (const r of list) {
      if (me && r.handle === me) continue;
      const tier = rowTier(r.tier, defaults.tier || 2);
      const cur = Object.hasOwn(all, r.handle) ? all[r.handle] : null;
      if (!cur && Object.hasOwn(black, r.handle)) { blacklisted++; continue; }
      if (!cur) {
        all[r.handle] = newTarget(r.handle, { tier, tone: r.tone || defaults.tone || "", notes: r.notes || "", name: r.name || "", source: defaults.source || "manual" });
        added++;
      } else {
        if (overwrite || r.tier) cur.tier = tier;
        if (r.tone) cur.tone = r.tone;
        if (r.notes) cur.notes = r.notes;
        updated++;
      }
    }
    return all;
  });
  return { added, updated, blacklisted };
}

// Turning a target on again means the user checked the account is back: clear "not found" (rel.gone), so follow
// tracking includes it again (follow-back re-checks, give-up) instead of only watching it.
function applyPatch(t, clean) {
  Object.assign(t, clean);
  if (clean.enabled === true && t.rel && t.rel.gone) t.rel = { ...t.rel, gone: false };
  return t;
}

export async function patch(handle, p) {
  const h = normalizeHandle(handle);
  const clean = sanitizePatch(p || {});
  let out = null;
  await updateTargets((all) => {
    if (Object.hasOwn(all, h)) out = applyPatch(all[h], clean);
    return all;
  });
  return out;
}

export async function removeMany(handles) {
  const set = new Set((handles || []).map(normalizeHandle));
  let n = 0;
  await updateTargets((all) => { for (const h of set) if (Object.hasOwn(all, h)) { delete all[h]; n++; } return all; });
  return n;
}

export async function bulk(handles, p) {
  const set = new Set((handles || []).map(normalizeHandle));
  const clean = sanitizePatch(p || {});
  await updateTargets((all) => { for (const h of set) if (Object.hasOwn(all, h)) applyPatch(all[h], clean); return all; });
}

// Record one observation of whether the target follows you (profile badge or your followers list).
// The group always mirrors the result: A = follows you, B = does not.
export function applyFollow(t, followsYou, ts = now()) {
  t.rel = t.rel || {};
  if (followsYou) {
    // A follow-back is only a real false -> true change (an unknown state that turns out true is not).
    if (t.rel.followsYou === false && !t.rel.followedBackAt) t.rel.followedBackAt = ts;
    t.rel.followsYou = true;
    t.rel.notFollowingSeen = 0;
  } else if (t.rel.followsYou === true) {
    // A missing "Follows you" badge could be a rendering/markup problem: downgrade only after two
    // consecutive observations.
    t.rel.notFollowingSeen = (t.rel.notFollowingSeen || 0) + 1;
    if (t.rel.notFollowingSeen >= 2) {
      // The account unfollowed you: it is treated as not following again (comments resume), and the give-up window
      // starts again with the next comment instead of counting from comments before it followed you. An earlier
      // follow-back no longer counts (kept in prevFollowedBackAt), so a new one is credited and notified again.
      t.rel.followsYou = false;
      t.rel.unfollowedYouAt = ts;
      if (t.rel.followedBackAt) { t.rel.prevFollowedBackAt = t.rel.followedBackAt; t.rel.followedBackAt = null; }
      t.rel.followBackCredited = false;
      if (t.stats) t.stats.firstCommentAt = null;
    }
  } else {
    t.rel.followsYou = false;
  }
  t.rel.checkedAt = ts;
  if (t.rel.followsYou != null) t.group = t.rel.followsYou ? GROUP.A : GROUP.B;
  return t;
}

// Merge a scraped profile (+ its recent posts) into a target and recompute its own score.
export function applyProfile(t, profile, posts, blend = 0.5) {
  if (!t) return t;
  if (profile) {
    t.profile = { ...(t.profile || {}), ...stripUndefined(profile), updatedAt: now() };
    if (profile.name) t.name = profile.name;
    t.rel = t.rel || {};
    if (t.rel.gone) t.rel.gone = false; // the profile rendered: the account exists (again)
    if (profile.followsYou != null) applyFollow(t, !!profile.followsYou);
    if (profile.youFollow != null) {
      if (profile.youFollow && !t.rel.youFollowSince) t.rel.youFollowSince = now();
      if (!profile.youFollow) t.rel.youFollowSince = null;
      t.rel.youFollow = profile.youFollow;
    }
    if (profile.followsYou != null || profile.youFollow != null) t.rel.checkedAt = now();
  }
  if (posts && posts.length) mergePosts(t, posts);
  if (t.profile) {
    const s = ownScore(t.profile, t.recentPosts);
    t.score = { ...(t.score || {}), own: s.score, parts: s.parts, flags: s.flags, bot: s.bot, postsPerDay: s.postsPerDay, updatedAt: now() };
    t.score.combined = combinedScore(t.score.own, t.score.sorsa, blend);
    t.suggestedTier = suggestTier(t.profile, s);
  }
  t.lastCheckedAt = now();
  return t;
}

// Keep the newest 5 original posts we have seen from this account.
export function mergePosts(t, posts) {
  const map = new Map((t.recentPosts || []).map((p) => [p.id, p]));
  for (const p of posts) {
    if (!p || !p.id || p.isRepost || p.isReply || p.isPinned) continue;
    map.set(p.id, { id: p.id, text: String(p.text || "").slice(0, 600), createdAt: p.createdAt || null, metrics: p.metrics || null, lang: p.lang || "", isQuote: !!p.isQuote, hasMedia: !!p.hasMedia, hasCard: !!p.hasCard, links: Array.isArray(p.links) ? p.links.slice(0, 3).map((l) => String(l).slice(0, 300)) : [] });
  }
  t.recentPosts = [...map.values()].sort((a, b) => num(b.createdAt) - num(a.createdAt)).slice(0, 5);
  const newest = t.recentPosts[0];
  if (newest && newest.createdAt && (!t.lastPostAt || newest.createdAt > t.lastPostAt)) t.lastPostAt = newest.createdAt;
  return t;
}

function stripUndefined(o) { const r = {}; for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") r[k] = v; return r; }

// Can this target be watched and commented on? Only enabled targets that are known NOT to follow you.
export function isActive(t, settings, ts = now()) {
  if (!t || !t.enabled) return false;
  return followStatus(t) === FS.ACTIVE;
}
export function isCold(t, ts = now()) { return !!(t && t.coldUntil && t.coldUntil > ts); }

export async function activeTargets(settings) {
  const all = await getTargets();
  return Object.values(all).filter((t) => isActive(t, settings));
}

// Tone for a target: per-target override > your Tone prompt ("main"). Returns { key, text }.
export const MAIN_TONE = "main";
export function effectiveTone(t, settings, overrideKey) {
  const key = overrideKey || t.tone || MAIN_TONE;
  return { key, text: toneText(key, settings) };
}
export function toneText(key, settings) {
  const main = String((settings.prompt && settings.prompt.tone) || "").trim() || DEFAULT_TONE_PROMPT;
  if (!key || key === MAIN_TONE) return main;
  if (key === "custom") return String((settings.groups && settings.groups.B && settings.groups.B.customTone) || "").trim() || main; // legacy
  if (key.startsWith("custom:")) {
    const c = (settings.customTones || []).find((x) => "custom:" + x.id === key);
    return c && c.text ? c.text : main;
  }
  return settings.tones[key] || main;
}
// Tones that can be picked as a per-target override or tested against the Tone prompt.
export function allToneKeys(settings) {
  return [...BUILTIN_TONES, ...(settings.customTones || []).map((c) => "custom:" + c.id)];
}

// Preset for a target: per-target override > tier preset (Models & Costs). Commented targets never follow
// you, so the "B" row of the matrix is used.
export function effectivePreset(t, settings) {
  if (t.preset && settings.presets[t.preset]) return t.preset;
  const k = settings.presetMatrix[`B${Number(t.tier) === 1 ? 1 : 2}`];
  return settings.presets[k] ? k : "balanced";
}
