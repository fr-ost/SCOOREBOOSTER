// ScoreX - the follow-back record (History > Follow-backs). One entry per follow-back: who, when, after how many
// comments and days, whether ScoreX followed them first, the last comment before it, their followers and score at
// that moment, and whether they unfollowed later. An account that unfollows and follows back again gets a second
// entry ("again").
//
// Written where follow-backs are credited (learning.js processFollowBacks), and backfilled once from your targets and
// your history so follow-backs from before this record show too. It is a record: removing a target keeps its entries.
// Reset everything clears it; backups carry it with the history. chrome.storage.local "sx.followbacks", newest first.
//
// Entry { id: "handle:at", handle, name, at, tier, comments, firstCommentAt, days, youFollowedFirst, followers, score,
//         twitterscore, twitterscoreAt?, twitterscoreNone? (TwitterScore had no data), lastComment: { text, url,
//         postUrl, at } | null, unfollowedAt | null }. TwitterScore is filled in through your TwitterScore API key
//         (lib/scoreboard.js followBackScores).
import { K, HS } from "./constants.js";
import { load, update, getTargets } from "./store.js";
import * as H from "./history.js";
import { DAY, num, normalizeHandle, now } from "./util.js";

export const MAX_ENTRIES = 3000;
export const entryId = (handle, at) => `${handle}:${at}`;
const numOrNull = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// From history records: the comments posted to `handle` up to `at` (count, first one, the last one).
export function infoFromRecords(records, handle, at) {
  const posted = (records || []).filter((r) => r && r.target === handle && r.status === HS.POSTED && r.postedAt && r.postedAt <= at).sort((a, b) => a.postedAt - b.postedAt);
  const last = posted[posted.length - 1];
  return {
    count: posted.length,
    first: posted.length ? posted[0].postedAt : null,
    last: last ? { text: String(last.comment || "").slice(0, 280), url: last.replyUrl || "", postUrl: last.postUrl || "", at: last.postedAt } : null,
  };
}

// The entry for target `t`'s follow-back at `at` (pure: the worker stores it, the History page shows it).
export function makeEntry(t, at, info = null) {
  const rel = (t && t.rel) || {}, stats = (t && t.stats) || {}, profile = (t && t.profile) || {}, score = (t && t.score) || {};
  const handle = normalizeHandle(t && t.handle);
  const firstCommentAt = stats.firstCommentAt && stats.firstCommentAt <= at ? stats.firstCommentAt : (info && info.first) || null;
  // Comments before it: the posted records in your history, or - for the current follow-back, where comments stopped -
  // the target's own counter when that is higher (Clear history may have removed older records).
  const comments = Math.max((info && info.count) || 0, rel.followedBackAt === at ? num(stats.comments, 0) : 0);
  const ts = score.providers && score.providers.twitterscore;
  return {
    id: entryId(handle, at),
    handle,
    name: String((t && t.name) || profile.name || "").slice(0, 80),
    at,
    tier: Number(t && t.tier) === 1 ? 1 : Number(t && t.tier) === 2 ? 2 : null,
    comments,
    firstCommentAt,
    days: firstCommentAt && at >= firstCommentAt ? Math.round(((at - firstCommentAt) / DAY) * 10) / 10 : null,
    youFollowedFirst: !!(rel.followedByScoreXAt && rel.followedByScoreXAt <= at),
    followers: numOrNull(profile.followers),
    score: numOrNull(score.combined != null ? score.combined : score.own),
    twitterscore: numOrNull(ts && ts.score),
    lastComment: (info && info.last) || null,
    unfollowedAt: rel.unfollowedYouAt && rel.unfollowedYouAt > at ? rel.unfollowedYouAt : null,
  };
}

// Every follow-back event a target carries: the current one, and an earlier one if it unfollowed since.
const eventsOf = (t) => [t && t.rel && t.rel.followedBackAt, t && t.rel && t.rel.prevFollowedBackAt].filter((x) => Number.isFinite(Number(x)) && x > 0);

// The complete list for the History page: the stored record, plus follow-backs your targets or history know of that
// the record does not have yet, with "unfollowed later" and "again" brought up to date. Newest first.
export function mergeEntries(log, targets, records) {
  const by = new Map();
  for (const e of Array.isArray(log) ? log : []) if (e && e.id && e.handle) by.set(e.id, { ...e });
  for (const t of Object.values(targets || {})) {
    if (!t || !t.handle) continue;
    for (const at of eventsOf(t)) {
      const id = entryId(t.handle, at);
      if (!by.has(id)) by.set(id, makeEntry(t, at, infoFromRecords(records, t.handle, at)));
    }
  }
  // Accounts no longer in your targets: the comments credited with their follow-back remember them.
  for (const r of records || []) {
    const res = r && r.results;
    if (!res || !res.followedBack || !res.followBackAt || !r.target || Object.hasOwn(targets || {}, r.target)) continue;
    const id = entryId(r.target, res.followBackAt);
    if (!by.has(id)) by.set(id, makeEntry({ handle: r.target, tier: r.tier }, res.followBackAt, infoFromRecords(records, r.target, res.followBackAt)));
  }
  const list = [...by.values()];
  for (const e of list) { // unfollowed after this follow-back (the target knows); a TwitterScore the target has now
    const t = targets && Object.hasOwn(targets, e.handle) ? targets[e.handle] : null;
    const u = t && t.rel && t.rel.unfollowedYouAt;
    if (u && u > e.at && !e.unfollowedAt) e.unfollowedAt = u;
    const ts = t && t.score && t.score.providers && t.score.providers.twitterscore;
    if (e.twitterscore == null && ts && ts.score != null && Number.isFinite(Number(ts.score))) { e.twitterscore = Number(ts.score); delete e.twitterscoreNone; }
  }
  list.sort((a, b) => a.at - b.at);
  const seen = new Set();
  for (const e of list) { e.again = seen.has(e.handle); seen.add(e.handle); }
  return list.reverse();
}

// TwitterScore of follow-back accounts (lib/scoreboard.js followBackScores): an account TwitterScore had no data for
// is asked again after this long.
export const FB_TS_RETRY = 7 * DAY;
// Follow-back accounts that still need a TwitterScore (one per account, newest follow-back first).
export function followBackScoreNeeds(entries, ts = now()) {
  const out = [], seen = new Set();
  for (const e of (Array.isArray(entries) ? entries : []).slice().sort((a, b) => num(b && b.at, 0) - num(a && a.at, 0))) {
    if (!e || !e.handle || seen.has(e.handle) || e.twitterscore != null) continue;
    if (e.twitterscoreAt && ts - e.twitterscoreAt < FB_TS_RETRY) continue; // TwitterScore had no data lately
    seen.add(e.handle);
    out.push(e.handle);
  }
  return out;
}

// ---------- the stored record (service worker) ----------

// Store target t's follow-back at `at` (nothing when it is already there). Returns true when added.
export async function recordFollowBack(t, at = t && t.rel && t.rel.followedBackAt) {
  if (!t || !t.handle || !at) return false;
  let records = [];
  try { records = await H.byTarget(t.handle); } catch (_) { records = []; }
  const entry = makeEntry(t, at, infoFromRecords(records, t.handle, at));
  let added = false;
  await update(K.followbacks, [], (list) => {
    const arr = Array.isArray(list) ? list : [];
    if (arr.some((e) => e && e.id === entry.id)) return arr;
    added = true;
    return [entry, ...arr].sort((a, b) => b.at - a.at).slice(0, MAX_ENTRIES);
  });
  return added;
}

// Bring the record up to date: follow-backs your targets know of (and, with fromHistory, the ones only your history
// remembers), and "unfollowed later". Writes only when something changed. Returns the number of entries added.
export async function syncFollowBacks({ fromHistory = false } = {}) {
  const [targets, log] = await Promise.all([getTargets(), load(K.followbacks, [])]);
  let records = [];
  if (fromHistory) { try { records = await H.all(); } catch (_) { records = []; } }
  const have = new Set((Array.isArray(log) ? log : []).map((e) => e && e.id));
  const fresh = [];
  for (const t of Object.values(targets)) {
    if (!t || !t.handle) continue;
    for (const at of eventsOf(t)) if (!have.has(entryId(t.handle, at))) fresh.push({ t, at });
  }
  if (fromHistory) {
    const done = new Set();
    for (const r of records) {
      const res = r && r.results;
      if (!res || !res.followedBack || !res.followBackAt || !r.target || Object.hasOwn(targets, r.target)) continue;
      const id = entryId(r.target, res.followBackAt);
      if (have.has(id) || done.has(id)) continue;
      done.add(id);
      fresh.push({ t: { handle: r.target, tier: r.tier }, at: res.followBackAt });
    }
  }
  let added = 0;
  for (const { t, at } of fresh) if (await recordFollowBack(t, at)) added++;
  // Unfollowed later: only written when an entry changes.
  const cur = await load(K.followbacks, []);
  const needs = (Array.isArray(cur) ? cur : []).some((e) => {
    const t = e && Object.hasOwn(targets, e.handle) ? targets[e.handle] : null;
    const u = t && t.rel && t.rel.unfollowedYouAt;
    return u && u > e.at && !e.unfollowedAt;
  });
  if (needs) {
    await update(K.followbacks, [], (list) => (Array.isArray(list) ? list : []).map((e) => {
      const t = e && Object.hasOwn(targets, e.handle) ? targets[e.handle] : null;
      const u = t && t.rel && t.rel.unfollowedYouAt;
      return u && u > e.at && !e.unfollowedAt ? { ...e, unfollowedAt: u } : e;
    }));
  }
  return added;
}

// A backup's entries (untrusted) merged into the record: cleaned, de-duplicated, capped.
export async function importEntries(list) {
  const clean = [];
  for (const e of (Array.isArray(list) ? list : []).slice(0, MAX_ENTRIES)) {
    const handle = normalizeHandle(e && e.handle);
    const at = numOrNull(e && e.at);
    if (!handle || !at) continue;
    const lc = e.lastComment && typeof e.lastComment === "object" ? e.lastComment : null;
    clean.push({
      id: entryId(handle, at), handle, name: String(e.name || "").slice(0, 80), at,
      tier: Number(e.tier) === 1 ? 1 : Number(e.tier) === 2 ? 2 : null,
      comments: Math.max(0, num(e.comments, 0)), firstCommentAt: numOrNull(e.firstCommentAt), days: numOrNull(e.days),
      youFollowedFirst: !!e.youFollowedFirst, followers: numOrNull(e.followers), score: numOrNull(e.score), twitterscore: numOrNull(e.twitterscore),
      lastComment: lc ? { text: String(lc.text || "").slice(0, 280), url: /^https:\/\/(x|twitter)\.com\//.test(String(lc.url || "")) ? String(lc.url) : "", postUrl: /^https:\/\/(x|twitter)\.com\//.test(String(lc.postUrl || "")) ? String(lc.postUrl) : "", at: numOrNull(lc.at) } : null,
      unfollowedAt: numOrNull(e.unfollowedAt),
      ...(numOrNull(e.twitterscoreAt) ? { twitterscoreAt: numOrNull(e.twitterscoreAt) } : {}),
      ...(e.twitterscoreNone === true && numOrNull(e.twitterscore) == null ? { twitterscoreNone: true } : {}),
    });
  }
  let added = 0;
  await update(K.followbacks, [], (cur) => {
    const by = new Map((Array.isArray(cur) ? cur : []).map((e) => [e.id, e]));
    for (const e of clean) if (!by.has(e.id)) { by.set(e.id, e); added++; }
    return [...by.values()].sort((a, b) => b.at - a.at).slice(0, MAX_ENTRIES);
  });
  return added;
}

// ---------- download (CSV / Excel) ----------
const iso = (ts) => (ts ? new Date(ts).toISOString() : "");
export const COLUMNS = [
  ["Followed back", (e) => iso(e.at)],
  ["Username", (e) => e.handle],
  ["Name", (e) => e.name || ""],
  ["Tier", (e) => (e.tier ? "T" + e.tier : "")],
  ["Comments before", (e) => e.comments || 0],
  ["Days from first comment", (e) => (e.days == null ? "" : e.days)],
  ["You followed first", (e) => (e.youFollowedFirst ? "yes" : "")],
  ["Followers", (e) => (e.followers == null ? "" : e.followers)],
  ["ScoreX rank", (e) => (e.score == null ? "" : e.score)],
  ["TwitterScore", (e) => (e.twitterscore == null ? "" : e.twitterscore)],
  ["Last comment", (e) => (e.lastComment ? e.lastComment.text : "")],
  ["Last comment link", (e) => (e.lastComment ? e.lastComment.url : "")],
  ["Unfollowed later", (e) => iso(e.unfollowedAt)],
  ["Profile", (e) => "https://x.com/" + e.handle],
];
export function toTable(entries) {
  return [COLUMNS.map(([h]) => h), ...(entries || []).map((e) => COLUMNS.map(([, f]) => f(e)))];
}
