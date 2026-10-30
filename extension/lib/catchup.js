// ScoreX - catch-up: besides brand-new posts, comment on each account's latest posts that were published
// before ScoreX ran (or while it could not comment), so no follow-back chance is missed.
// Uses the posts already read from the account's profile (target.recentPosts, refreshed by the follow
// check, profile refreshes and the watch pages), so it costs no extra page loads. Every post is handled
// once (it gets a history record), and all normal limits apply (per account per day, accounts per day,
// daily limit, cooldowns, skip rules). Settings: watch.catchUp = { enabled, perTarget, maxAgeHours }.

import { isActive, isCold } from "./targets.js";
import { HOUR, MIN, now } from "./util.js";

// Posts worth a catch-up comment, best first: up to `perTarget` of each account's newest original posts
// that are older than the live comment window and younger than maxAgeHours.
export function catchUpCandidates(targets, settings, ts = now()) {
  const c = settings.watch.catchUp || {};
  if (!c.enabled) return [];
  const maxAge = (c.maxAgeHours || 48) * HOUR;
  const liveWindow = (settings.watch.maxPostAgeMin || 20) * MIN;
  const out = [];
  for (const t of Object.values(targets || {})) {
    if (!t || !isActive(t, settings, ts) || isCold(t, ts)) continue;
    const posts = (t.recentPosts || [])
      .filter((p) => p && p.id && p.createdAt && ts - p.createdAt <= maxAge && ts - p.createdAt > liveWindow)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, c.perTarget || 2);
    for (const p of posts) {
      out.push({
        id: String(p.id), author: t.handle, authorName: t.name || "", text: p.text || "", lang: p.lang || "",
        createdAt: p.createdAt, url: `https://x.com/${t.handle}/status/${p.id}`, metrics: p.metrics || null,
        // The stored flags keep the quote / link-only / short-text rules working like on a live post.
        isReply: false, isRepost: false, isQuote: !!p.isQuote, hasMedia: !!p.hasMedia, hasCard: !!p.hasCard,
        links: Array.isArray(p.links) ? p.links.filter((l) => typeof l === "string").slice(0, 5) : [], catchUp: true,
        _rank: (t.tier === 1 ? 20 : 0) + (t.priority || 50) - (ts - p.createdAt) / HOUR,
      });
    }
  }
  return out.sort((a, b) => b._rank - a._rank).map(({ _rank, ...p }) => p);
}

// How long a catch-up comment may wait in the queue before it is dropped (the post's max age + 2 hours).
export function catchUpMaxAgeMin(settings) {
  const c = settings.watch.catchUp || {};
  return (c.maxAgeHours || 48) * 60 + 120;
}
