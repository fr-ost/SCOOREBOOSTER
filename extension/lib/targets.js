// ScoreX - targets: the accounts we comment on. Stored as { [handle]: Target } in chrome.storage (SW-owned).
//
// Target {
//   handle, name, group: "A"|"B", tier: 1|2, enabled, tone (override key or ""), preset (override key or ""),
//   notes, source, addedAt,
//   profile: { handle, name, bio, followers, following, verified, protected, defaultAvatar, joinedAt, avatar, updatedAt },
//   recentPosts: [{ id, text, createdAt, metrics }]  (newest first, max 5)
//   lastPostAt, lastCheckedAt,
//   rel: { followsYou, youFollow, checkedAt, youFollowSince, followedBackAt },
//   score: { own, sorsa, combined, flags, bot, updatedAt, sorsaUpdatedAt },
//   priority (0-100), coldUntil,
//   stats: { comments, lastCommentAt, engaged, noResponseStreak, likes, replies, authorReplies, lastEngagedAt }
// }

import { GROUP, TIER, BUILTIN_TONES, PRESET_KEYS } from "./constants.js";
import { normalizeHandle, parseHandleList, now, clamp, num } from "./util.js";
import { getTargets, updateTargets } from "./store.js";
import { ownScore, combinedScore, suggestTier } from "./scores.js";

export function newTarget(handle, opts = {}) {
  return {
    handle,
    name: opts.name || "",
    group: opts.group === GROUP.A ? GROUP.A : GROUP.B,
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
    rel: { followsYou: opts.group === GROUP.A ? true : null, youFollow: null, checkedAt: null, youFollowSince: null, followedBackAt: null },
    score: null,
    priority: Number(opts.tier) === 1 ? 70 : 50,
    coldUntil: null,
    stats: { comments: 0, lastCommentAt: null, engaged: 0, noResponseStreak: 0, likes: 0, replies: 0, authorReplies: 0, lastEngagedAt: null },
  };
}

const EDITABLE = ["name", "group", "tier", "enabled", "tone", "preset", "notes", "priority"];

export function sanitizePatch(patch) {
  const out = {};
  for (const k of EDITABLE) if (Object.hasOwn(patch, k)) out[k] = patch[k];
  if ("group" in out) out.group = String(out.group).toUpperCase() === GROUP.A ? GROUP.A : GROUP.B;
  if ("tier" in out) out.tier = Number(out.tier) === 1 ? 1 : 2;
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
function rowGroup(v, def) { const s = String(v || "").trim().toUpperCase(); return s === "A" || s === "B" ? s : def; }
function rowTier(v, def) { const n = Number(String(v || "").replace(/\D/g, "")); return n === 1 || n === 2 ? n : def; }

// Add or update targets. rows: [{handle, group?, tier?, tone?, notes?}] or handles. defaults: {group, tier, source}.
// Existing targets keep their stats; group/tier/tone are overwritten only if given explicitly in a row
// or `overwrite` is true.
export async function upsert(rows, defaults = {}, overwrite = false) {
  const list = (rows || []).map((r) => (typeof r === "string" ? { handle: normalizeHandle(r) } : { ...r, handle: normalizeHandle(r.handle) })).filter((r) => r.handle);
  let added = 0, updated = 0;
  const me = String(defaults.myHandle || "").trim().replace(/^@/, "").toLowerCase();
  await updateTargets((all) => {
    for (const r of list) {
      if (me && r.handle === me) continue;
      const group = rowGroup(r.group, defaults.group || GROUP.B);
      const tier = rowTier(r.tier, defaults.tier || 2);
      const cur = Object.hasOwn(all, r.handle) ? all[r.handle] : null;
      if (!cur) {
        all[r.handle] = newTarget(r.handle, { group, tier, tone: r.tone || defaults.tone || "", notes: r.notes || "", name: r.name || "", source: defaults.source || "manual" });
        added++;
      } else {
        if (overwrite || r.group) cur.group = group;
        if (overwrite || r.tier) cur.tier = tier;
        if (r.tone) cur.tone = r.tone;
        if (r.notes) cur.notes = r.notes;
        updated++;
      }
    }
    return all;
  });
  return { added, updated };
}

export async function patch(handle, p) {
  const h = normalizeHandle(handle);
  const clean = sanitizePatch(p || {});
  let out = null;
  await updateTargets((all) => {
    if (Object.hasOwn(all, h)) { Object.assign(all[h], clean); out = all[h]; }
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
  await updateTargets((all) => { for (const h of set) if (Object.hasOwn(all, h)) Object.assign(all[h], clean); return all; });
}

// Merge a scraped profile (+ its recent posts) into a target and recompute its own score.
export function applyProfile(t, profile, posts, blend = 0.5) {
  if (!t) return t;
  if (profile) {
    t.profile = { ...(t.profile || {}), ...stripUndefined(profile), updatedAt: now() };
    if (profile.name) t.name = profile.name;
    t.rel = t.rel || {};
    if (profile.followsYou != null) {
      if (profile.followsYou && t.rel.followsYou === false && !t.rel.followedBackAt) t.rel.followedBackAt = now();
      t.rel.followsYou = profile.followsYou;
    }
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
    map.set(p.id, { id: p.id, text: String(p.text || "").slice(0, 600), createdAt: p.createdAt || null, metrics: p.metrics || null, lang: p.lang || "" });
  }
  t.recentPosts = [...map.values()].sort((a, b) => num(b.createdAt) - num(a.createdAt)).slice(0, 5);
  const newest = t.recentPosts[0];
  if (newest && newest.createdAt && (!t.lastPostAt || newest.createdAt > t.lastPostAt)) t.lastPostAt = newest.createdAt;
  return t;
}

function stripUndefined(o) { const r = {}; for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") r[k] = v; return r; }

export function isActive(t, settings, ts = now()) {
  if (!t || !t.enabled) return false;
  if (!settings.groups[t.group] || !settings.groups[t.group].enabled) return false;
  return true;
}
export function isCold(t, ts = now()) { return !!(t && t.coldUntil && t.coldUntil > ts); }

export async function activeTargets(settings) {
  const all = await getTargets();
  return Object.values(all).filter((t) => isActive(t, settings));
}

// Tone for a target: per-target override > group default. Returns { key, text }.
export function effectiveTone(t, settings, overrideKey) {
  const g = settings.groups[t.group] || {};
  const key = overrideKey || t.tone || g.tone || "insightful";
  return { key, text: toneText(key, settings, g.customTone) };
}
export function toneText(key, settings, groupCustom) {
  if (key === "custom") return String(groupCustom || "").trim() || settings.tones.insightful;
  if (key && key.startsWith("custom:")) {
    const c = (settings.customTones || []).find((x) => "custom:" + x.id === key);
    if (c) return c.text;
  }
  if (settings.tones[key]) return settings.tones[key];
  return settings.tones.insightful;
}
export function allToneKeys(settings) {
  return [...BUILTIN_TONES, ...(settings.customTones || []).map((c) => "custom:" + c.id)];
}

// Preset for a target: per-target override > group/tier matrix.
export function effectivePreset(t, settings) {
  if (t.preset && settings.presets[t.preset]) return t.preset;
  const k = settings.presetMatrix[`${t.group}${t.tier}`];
  return settings.presets[k] ? k : "balanced";
}
