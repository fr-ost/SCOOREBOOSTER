// ScoreX - growth analytics (pure functions, no storage access): the follow-back funnel, conversion by
// tier / tone / preset, days to a follow-back, daily series and the accounts that respond most.
// Inputs: targets map (sx.targets), history records (IndexedDB), blacklist map (sx.blacklist).

import { HS } from "./constants.js";
import { followStatus, FS } from "./targets.js";
import { DAY, dayKey, num } from "./util.js";

const posted = (r) => r && r.status === HS.POSTED && r.postedAt;

// Funnel: added -> checked -> don't follow you (commenting) -> commented -> followed back; plus the ones
// that already followed you and the ones given up (blacklisted after N days without a follow-back).
export function funnel(targets, history, blacklist = {}) {
  const list = Object.values(targets || {}).filter((t) => t && t.handle);
  const gaveUp = Object.values(blacklist || {}).filter((b) => b && b.reason === "no_followback");
  const commentedHandles = new Set((history || []).filter(posted).map((r) => r.target));
  const s = { added: list.length + gaveUp.length, checking: 0, follows: 0, notFollowing: 0, commented: 0, followedBack: 0, gaveUp: gaveUp.length };
  for (const t of list) {
    const f = followStatus(t);
    if (f === FS.CHECKING) s.checking++;
    else if (f === FS.FOLLOWS) s.follows++;
    else if (f === FS.FOLLOWED_BACK) s.followedBack++;
    else s.notFollowing++;
    if (f === FS.FOLLOWED_BACK || (t.stats && t.stats.comments > 0) || commentedHandles.has(t.handle)) s.commented++;
  }
  s.commented += gaveUp.length; // given-up accounts were commented on before they were removed
  const decided = s.followedBack + s.gaveUp;
  s.rate = s.commented ? s.followedBack / s.commented : null; // follow-backs per commented account so far
  s.decidedRate = decided ? s.followedBack / decided : null; // among accounts whose window has ended
  return s;
}

// Median / average days from the first comment to the follow-back.
export function daysToFollowBack(targets) {
  const d = Object.values(targets || {})
    .filter((t) => t && t.rel && t.rel.followedBackAt && t.stats && t.stats.firstCommentAt && t.rel.followedBackAt >= t.stats.firstCommentAt)
    .map((t) => (t.rel.followedBackAt - t.stats.firstCommentAt) / DAY)
    .sort((a, b) => a - b);
  if (!d.length) return { n: 0, median: null, avg: null };
  const mid = Math.floor(d.length / 2);
  return { n: d.length, median: d.length % 2 ? d[mid] : (d[mid - 1] + d[mid]) / 2, avg: d.reduce((a, b) => a + b, 0) / d.length };
}

// Conversion per key ("tier" | "tone" | "preset"): commented accounts and how many followed back.
export function conversionBy(key, targets, history) {
  const byTarget = new Map();
  for (const r of history || []) {
    if (!posted(r)) continue;
    const k = key === "tier" ? (r.tier ? "Tier " + r.tier : "?") : key === "tone" ? r.tone || "main" : r.preset || "?";
    if (!byTarget.has(r.target)) byTarget.set(r.target, new Map());
    const m = byTarget.get(r.target);
    m.set(k, (m.get(k) || 0) + 1);
  }
  const rows = new Map();
  for (const [h, m] of byTarget) {
    const t = targets && Object.hasOwn(targets, h) ? targets[h] : null;
    const fb = !!(t && t.rel && t.rel.followedBackAt);
    // Credit the key the account got most comments with.
    const k = [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const row = rows.get(k) || { key: k, accounts: 0, comments: 0, followBacks: 0 };
    row.accounts++;
    row.comments += [...m.values()].reduce((a, b) => a + b, 0);
    if (fb) row.followBacks++;
    rows.set(k, row);
  }
  return [...rows.values()].map((r) => ({ ...r, rate: r.accounts ? r.followBacks / r.accounts : 0 })).sort((a, b) => b.rate - a.rate || b.accounts - a.accounts);
}

// Daily series for the last `days` days (oldest first): posted, generated, follow-backs, cost, likes.
export function dailySeries(history, targets, { days = 30, tz = "UTC", ts = Date.now() } = {}) {
  const keys = [];
  for (let i = days - 1; i >= 0; i--) keys.push(dayKey(ts - i * DAY, tz));
  const idx = new Map(keys.map((k, i) => [k, i]));
  const rows = keys.map((d) => ({ d, posted: 0, generated: 0, followBacks: 0, cost: 0, replyLikes: 0 }));
  for (const r of history || []) {
    const ci = idx.get(dayKey(r.createdAt, tz));
    if (ci != null) { rows[ci].cost += num(r.cost); if (r.attempts > 0) rows[ci].generated++; }
    if (posted(r)) {
      const pi = idx.get(dayKey(r.postedAt, tz));
      if (pi != null) { rows[pi].posted++; rows[pi].replyLikes += num(r.results && r.results.likes); }
    }
  }
  for (const t of Object.values(targets || {})) {
    const at = t && t.rel && t.rel.followedBackAt;
    const i = at ? idx.get(dayKey(at, tz)) : null;
    if (i != null) rows[i].followBacks++;
  }
  for (const r of rows) r.cost = Math.round(r.cost * 10000) / 10000;
  return rows;
}

// Accounts that respond to your comments the most (likes, replies, author replies, follow-back).
export function topResponders(targets, history, n = 8) {
  const by = new Map();
  for (const r of history || []) {
    if (!posted(r)) continue;
    const res = r.results || {};
    const cur = by.get(r.target) || { handle: r.target, comments: 0, likes: 0, replies: 0, authorReplies: 0 };
    cur.comments++;
    cur.likes += num(res.likes);
    cur.replies += num(res.replies);
    if (res.authorReplied) cur.authorReplies++;
    by.set(r.target, cur);
  }
  return [...by.values()]
    .map((x) => {
      const t = targets && Object.hasOwn(targets, x.handle) ? targets[x.handle] : null;
      const followedBack = !!(t && t.rel && t.rel.followedBackAt);
      return { ...x, followedBack, points: x.likes + 2 * x.replies + 5 * x.authorReplies + (followedBack ? 10 : 0) };
    })
    .filter((x) => x.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, n);
}

// Replies by the author to your comments that you may want to answer yourself (newest first).
export function authorReplies(history, n = 20) {
  return (history || [])
    .filter((r) => posted(r) && r.results && r.results.authorReplied && r.replyUrl)
    .sort((a, b) => (b.results.checkedAt || b.postedAt) - (a.results.checkedAt || a.postedAt))
    .slice(0, n)
    .map((r) => ({ id: r.id, target: r.target, comment: r.comment, replyUrl: r.replyUrl, postUrl: r.postUrl, at: r.results.checkedAt || r.postedAt }));
}
