// ScoreX - history records (IndexedDB). One record per generated comment, and it IS the review queue:
// records with status pending_review / approved / queued are the open queue.
//
// HistoryRecord {
//   id, createdAt, updatedAt, postedAt, scheduledFor, status, reason, mode,
//   target, targetName, group, tier,
//   postId, postUrl, postText, postLang, postCreatedAt, postMetrics, postHasMedia, postIsQuote,
//   tone, toneText, preset, modelId, modelName, effort, fallbackUsed, abArm, abExplore,
//   comment, originalComment, edited, attempts, quality: { pass, reasons, modelVerdict },
//   calls: [{ kind, modelId, modelName, effort, usage, cost, ms, ok, error }], tokens, cost,
//   liked, replyUrl, replyId,
//   results: { likes, replies, authorReplied, followedBack, followBackAt, checkedAt }
// }

import { db, STORES } from "./db.js";
import { HS, OPEN_STATUSES } from "./constants.js";
import { now, uid, DAY, dayKey, toCsv, num } from "./util.js";
import { sumCalls } from "./costs.js";

const S = STORES.history;

export function newRecord(fields) {
  const t = now();
  return {
    id: uid("h"),
    createdAt: t,
    updatedAt: t,
    postedAt: null,
    scheduledFor: null,
    status: HS.PENDING_REVIEW,
    reason: "",
    calls: [],
    tokens: { input: 0, cached: 0, output: 0, reasoning: 0 },
    cost: 0,
    attempts: 0,
    edited: false,
    liked: false,
    results: {},
    ...fields,
  };
}

function finalize(rec) {
  const { usage, cost } = sumCalls(rec.calls);
  rec.tokens = usage;
  rec.cost = cost;
  rec.updatedAt = now();
  return rec;
}
export async function put(rec) {
  finalize(rec);
  await db().put(S, rec);
  return rec;
}
export const get = (id) => db().get(S, id);
export const remove = (id) => db().del(S, id);
// Atomic read-modify-write (one IndexedDB transaction). `fields` may be a function of the current record;
// returning null/undefined from it aborts the write (compare-and-set) and patch() resolves to null.
export async function patch(id, fields) {
  return db().update(S, id, (r) => {
    if (!r) return null;
    const upd = typeof fields === "function" ? fields(r) : fields;
    if (upd == null) return null;
    return finalize(Object.assign(r, upd));
  });
}

export const byStatus = (status) => db().byIndex(S, "status", status);
export async function openQueue() {
  const lists = await Promise.all(OPEN_STATUSES.map((s) => byStatus(s)));
  return lists.flat().sort((a, b) => a.createdAt - b.createdAt);
}
export const byTarget = (handle) => db().byIndex(S, "target", handle);
export async function byPostId(postId) { return db().byIndex(S, "postId", postId); }
export const since = (ts) => db().range(S, "createdAt", ts, null);
export const between = (lo, hi) => db().range(S, "createdAt", lo, hi);
export const latest = (n) => db().latest(S, "createdAt", n);
export const all = () => db().all(S);
export const count = () => db().count(S);
export const clearAll = () => db().clear(S);

// Last n posted comments (newest first), for style/similarity.
export async function recentPosted(n = 50) {
  const posted = await byStatus(HS.POSTED);
  return posted.sort((a, b) => (b.postedAt || 0) - (a.postedAt || 0)).slice(0, n);
}

// Count posted comments in the local day containing ts, optionally for one target.
export async function postedToday(tz, ts = now(), target) {
  const today = dayKey(ts, tz);
  const recs = await since(ts - 2 * DAY);
  return recs.filter((r) => r.status === HS.POSTED && r.postedAt && dayKey(r.postedAt, tz) === today && (!target || r.target === target)).length;
}

// Generations started today (any status) - caps OpenAI spend on days with many skips.
export async function generatedToday(tz, ts = now()) {
  const today = dayKey(ts, tz);
  const recs = await since(ts - 2 * DAY);
  return recs.filter((r) => r.attempts > 0 && dayKey(r.createdAt, tz) === today).length;
}

export async function likedToday(tz, ts = now()) {
  const today = dayKey(ts, tz);
  const recs = await since(ts - 2 * DAY);
  return recs.filter((r) => r.liked && r.likedAt && dayKey(r.likedAt, tz) === today).length;
}

// Per-target usage: posted (or in flight) today and in the rolling last 7 days.
export async function targetCounts(handle, tz, ts = now()) {
  const recs = await byTarget(handle);
  const today = dayKey(ts, tz);
  let day = 0, week = 0, open = 0;
  for (const r of recs) {
    if (OPEN_STATUSES.includes(r.status)) open++;
    if (r.status !== HS.POSTED || !r.postedAt) continue;
    if (dayKey(r.postedAt, tz) === today) day++;
    if (ts - r.postedAt < 7 * DAY) week++;
  }
  return { day, week, open, total: recs.filter((r) => r.status === HS.POSTED).length };
}

// Bulk version for many targets at once (one scan).
export async function targetCountsAll(tz, ts = now()) {
  const recs = await since(ts - 8 * DAY);
  const open = [];
  for (const s of OPEN_STATUSES) open.push(...(await byStatus(s)));
  const today = dayKey(ts, tz);
  const out = {};
  const get = (h) => (out[h] ||= { day: 0, week: 0, open: 0 });
  for (const r of recs) {
    if (r.status !== HS.POSTED || !r.postedAt) continue;
    if (dayKey(r.postedAt, tz) === today) get(r.target).day++;
    if (ts - r.postedAt < 7 * DAY) get(r.target).week++;
  }
  for (const r of open) get(r.target).open++;
  return out;
}

// Filtered page for the History tab.
export async function query({ from, to, status, target, group, model, text, limit = 500 } = {}) {
  let recs = from || to ? await between(from || 0, to || now() + DAY) : await all();
  const tl = target ? target.toLowerCase().replace(/^@/, "") : "";
  const q = text ? text.toLowerCase() : "";
  recs = recs.filter((r) =>
    (!status || r.status === status) &&
    (!tl || r.target === tl) &&
    (!group || r.group === group) &&
    (!model || r.modelId === model || r.modelName === model) &&
    (!q || (r.comment || "").toLowerCase().includes(q) || (r.postText || "").toLowerCase().includes(q)));
  recs.sort((a, b) => b.createdAt - a.createdAt);
  return recs.slice(0, limit);
}

export const CSV_COLUMNS = [
  { key: "createdAt", label: "created", get: (r) => new Date(r.createdAt).toISOString() },
  { key: "postedAt", label: "posted", get: (r) => (r.postedAt ? new Date(r.postedAt).toISOString() : "") },
  { key: "target", label: "target" },
  { key: "group", label: "group" },
  { key: "tier", label: "tier" },
  { key: "postUrl", label: "post_link" },
  { key: "modelName", label: "model" },
  { key: "effort", label: "reasoning" },
  { key: "preset", label: "preset" },
  { key: "tone", label: "tone" },
  { key: "tokens_in", label: "input_tokens", get: (r) => num(r.tokens && r.tokens.input) },
  { key: "tokens_cached", label: "cached_tokens", get: (r) => num(r.tokens && r.tokens.cached) },
  { key: "tokens_out", label: "output_tokens", get: (r) => num(r.tokens && r.tokens.output) },
  { key: "tokens_reason", label: "reasoning_tokens", get: (r) => num(r.tokens && r.tokens.reasoning) },
  { key: "cost", label: "cost_usd", get: (r) => num(r.cost).toFixed(6) },
  { key: "comment", label: "comment" },
  { key: "status", label: "status" },
  { key: "reason", label: "reason" },
  { key: "replyUrl", label: "reply_link" },
  { key: "liked", label: "liked_post", get: (r) => (r.liked ? "yes" : "") },
  { key: "likes", label: "reply_likes", get: (r) => (r.results && r.results.likes != null ? r.results.likes : "") },
  { key: "replies", label: "reply_replies", get: (r) => (r.results && r.results.replies != null ? r.results.replies : "") },
  { key: "authorReplied", label: "author_replied", get: (r) => (r.results && r.results.authorReplied ? "yes" : "") },
  { key: "followedBack", label: "followed_back", get: (r) => (r.results && r.results.followedBack ? "yes" : "") },
];
export function toCsvText(records) { return toCsv(records, CSV_COLUMNS); }
