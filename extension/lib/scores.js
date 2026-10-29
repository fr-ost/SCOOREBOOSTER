// ScoreX - account ranking. Two sources:
//   1. "ScoreX rank" (always available): our own 0-100 score from public profile data we already scrape
//      (followers, follower/following ratio, engagement on recent posts, posting activity, verification).
//   2. Sorsa Score (optional): fetched from api.sorsa.io with YOUR Sorsa API key, only after you enable it
//      and grant the optional host permission. Kaito Yaps scores are not available (see README).

import { clamp, num, now, DAY } from "./util.js";

const log10 = (x) => Math.log10(Math.max(1, x));

// Heuristic spam/bot flags from what a profile page shows.
export function botFlags(profile, posts = []) {
  const f = [];
  const p = profile || {};
  const followers = num(p.followers, -1), following = num(p.following, -1);
  const handle = String(p.handle || "");
  const bio = String(p.bio || "").toLowerCase();
  if (p.defaultAvatar) f.push("default_avatar");
  if (/\d{6,}$/.test(handle)) f.push("numeric_handle");
  if (following > 2000 && followers >= 0 && following > followers * 4) f.push("follows_many");
  if (followers >= 0 && followers < 30) f.push("tiny_audience");
  if (/(follow ?back|f4f|follow for follow|100% follow back|dm for promo|promo(tion)? (dm|available)|signals? group|pump group|100x gem|send dm|paid promo)/i.test(bio)) f.push("spam_bio");
  if (p.joinedAt && now() - p.joinedAt < 60 * DAY) f.push("new_account");
  if (posts.length >= 3) {
    const texts = posts.map((t) => String(t.text || "").trim().toLowerCase());
    const uniq = new Set(texts);
    if (uniq.size <= Math.ceil(texts.length / 2)) f.push("repetitive_posts");
    const gm = texts.filter((t) => /^(gm|gn)\b/.test(t)).length;
    if (gm >= Math.ceil(texts.length * 0.6)) f.push("gm_spam");
  }
  return f;
}
const HARD_BOT = new Set(["spam_bio", "repetitive_posts", "follows_many"]);
export function looksLikeBot(flags) {
  const s = new Set(flags || []);
  let n = 0;
  for (const x of s) n += HARD_BOT.has(x) ? 2 : 1;
  return n >= 2;
}

// Posts per day over the span covered by the recent posts we saw (pinned/old excluded by caller).
export function activityRate(posts, ts = now()) {
  const times = (posts || []).map((p) => num(p.createdAt)).filter(Boolean).sort((a, b) => b - a);
  if (!times.length) return { perDay: 0, lastPostAt: null, daysSinceLast: null };
  const span = Math.max(1, (ts - times[times.length - 1]) / DAY);
  return { perDay: times.length / span, lastPostAt: times[0], daysSinceLast: (ts - times[0]) / DAY };
}

// Engagement rate of recent posts: (likes + 2*replies + 1.5*reposts) per post / followers.
export function engagementRate(profile, posts) {
  const followers = num(profile && profile.followers);
  const ps = (posts || []).filter((p) => p.metrics);
  if (!followers || !ps.length) return null;
  let sum = 0;
  for (const p of ps) sum += num(p.metrics.likes) + 2 * num(p.metrics.replies) + 1.5 * num(p.metrics.reposts);
  return sum / ps.length / followers;
}

// ScoreX rank 0-100. Weights: reach 40, engagement 25, activity 20, quality 15. Bots are heavily penalised.
export function ownScore(profile, posts = [], ts = now()) {
  const p = profile || {};
  const followers = num(p.followers), following = num(p.following);
  const reach = clamp(log10(followers + 1) / 6.3, 0, 1); // ~2M followers -> 1.0
  const er = engagementRate(p, posts);
  // 0.2% -> ~0.3, 1% -> ~0.7, 3%+ -> 1.0 (log curve); unknown -> neutral 0.4
  const engagement = er == null ? 0.4 : clamp((Math.log10(er * 100 + 0.05) + 1.3) / 1.8, 0, 1);
  const act = activityRate(posts, ts);
  let activity = 0.3;
  if (act.lastPostAt) {
    const recency = act.daysSinceLast <= 2 ? 1 : act.daysSinceLast <= 7 ? 0.7 : act.daysSinceLast <= 30 ? 0.3 : 0;
    activity = 0.6 * recency + 0.4 * clamp(act.perDay / 3, 0, 1);
  }
  const ratio = following > 0 ? followers / following : followers > 0 ? 10 : 0;
  let quality = clamp(log10(ratio * 10 + 1) / 3, 0, 1);
  if (p.verified) quality = clamp(quality + 0.15, 0, 1);
  const flags = botFlags(p, posts);
  let score = 100 * (0.4 * reach + 0.25 * engagement + 0.2 * activity + 0.15 * quality);
  if (looksLikeBot(flags)) score *= 0.3;
  else score *= 1 - 0.07 * flags.length;
  return {
    score: Math.round(clamp(score, 0, 100)),
    parts: { reach: round2(reach), engagement: round2(engagement), activity: round2(activity), quality: round2(quality) },
    engagementRate: er,
    postsPerDay: round2(act.perDay),
    lastPostAt: act.lastPostAt,
    flags,
    bot: looksLikeBot(flags),
  };
}
const round2 = (v) => Math.round(v * 100) / 100;

// Tier suggestion: Tier 1 = big influencer, Tier 2 = smart account.
export function suggestTier(profile, score) {
  const followers = num(profile && profile.followers);
  const s = num(score && score.score != null ? score.score : score);
  return followers >= 50000 || s >= 78 ? 1 : 2;
}

// Combined rank used for sorting/priorities. Sorsa scores are open-ended (100 = "on the radar",
// 1000+ = significant, 2000+ = supreme), so they are mapped to 0-100 on a log curve first.
export function sorsaTo100(sorsa) {
  if (sorsa == null || sorsa === "") return null; // no score (Number(null) would be 0)
  const v = num(sorsa, -1);
  if (v < 0) return null;
  return Math.round(clamp((log10(v + 1) / log10(3001)) * 100, 0, 100));
}
export function combinedScore(own, sorsa, blend = 0.5) {
  const o = own == null ? null : num(own);
  const s = sorsaTo100(sorsa);
  if (o == null && s == null) return null;
  if (s == null) return o;
  if (o == null) return s;
  return Math.round(o * (1 - blend) + s * blend);
}

// Discovery filters (follower range, recent activity, language, bots).
export function passesDiscoveryFilters(cand, f, ts = now()) {
  const why = [];
  const followers = cand.profile ? cand.profile.followers : cand.followers;
  if (followers != null) {
    if (f.minFollowers && followers < f.minFollowers) why.push("followers below range");
    if (f.maxFollowers && followers > f.maxFollowers) why.push("followers above range");
  }
  if (f.activeWithinDays && cand.lastPostAt && ts - cand.lastPostAt > f.activeWithinDays * DAY) why.push("inactive");
  if (f.languages && f.languages.length && cand.lang && !f.languages.map((x) => String(x).toLowerCase()).includes(String(cand.lang).toLowerCase())) why.push("language");
  if (f.skipBots && cand.score && cand.score.bot) why.push("looks like a bot/spam");
  if (cand.profile && cand.profile.protected) why.push("protected account");
  return { pass: why.length === 0, why };
}

// ---------- optional Sorsa provider ----------
// Docs: https://docs.sorsa.io  (key from https://api.sorsa.io). Configured in sorsa.js constants below.
export const SORSA = Object.freeze({
  origin: "https://api.sorsa.io",
  permission: "https://api.sorsa.io/*",
});
