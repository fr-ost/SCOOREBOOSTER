// ScoreX - account ranking. Two sources:
//   1. "ScoreX rank" (always available): our own 0-100 score from public profile data we already scrape
//      (followers, follower/following ratio, engagement on recent posts, posting activity, verification).
//   2. Sorsa Score (optional): fetched from api.sorsa.io with YOUR Sorsa API key, only after you enable it
//      and grant the optional host permission. Kaito Yaps scores are not available (see README).

import { clamp, num, now, DAY } from "./util.js";

const log10 = (x) => Math.log10(Math.max(1, x));
// A count the page could not read (null / "" / undefined) is unknown (-1), not 0 (Number(null) === 0).
const count = (v) => (v == null || v === "" ? -1 : num(v, -1));

// Heuristic spam/bot flags from what a profile page shows.
export function botFlags(profile, posts = []) {
  const f = [];
  const p = profile || {};
  const followers = count(p.followers), following = count(p.following);
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

// ---------- score-aware targeting (settings.targeting.useValue) ----------
// value = (provider scores, else the ScoreX rank) x chance of a follow-back. Every threshold and weight below is a
// HEURISTIC (a reasonable guess, not measured on X data) and only orders targets; nothing here is a guarantee.

// Provider scores mapped to 0-100 (heuristic scales): Sorsa on the log curve above, TwitterScore 0-1000 / 10,
// Ethos 0-2800 / 28, Moni as given. An unknown provider counts only when it reports its own max.
const PROVIDER_TO_100 = { sorsa: (v) => sorsaTo100(v), twitterscore: (v) => v / 10, ethos: (v) => v / 28, moni: (v) => v };
const PROVIDER_NAME = { sorsa: "Sorsa", twitterscore: "TwitterScore", ethos: "Ethos", moni: "Moni" };
export function providerParts(t) {
  const sc = (t && t.score) || {};
  const provs = sc.providers && typeof sc.providers === "object" ? sc.providers : {};
  const out = [];
  for (const [id, x] of Object.entries(provs)) {
    if (!x || x.score == null || x.score === "") continue;
    const v = num(x.score, NaN);
    if (!Number.isFinite(v) || v < 0) continue;
    const f = PROVIDER_TO_100[id];
    const s = f ? f(v) : num(x.max) > 0 ? (v / num(x.max)) * 100 : null;
    if (s == null || !Number.isFinite(s)) continue;
    out.push({ id, name: PROVIDER_NAME[id] || id, score100: clamp(s, 0, 100) });
  }
  // Sorsa scores fetched by the older Sorsa refresh live only in score.sorsa.
  if (!out.some((p) => p.id === "sorsa") && sorsaTo100(sc.sorsa) != null) out.push({ id: "sorsa", name: "Sorsa", score100: sorsaTo100(sc.sorsa) });
  return out;
}
// All provider scores of a target combined (plain average) on 0-100, or null when it has none.
export function providerScore100(t) {
  const parts = providerParts(t);
  return parts.length ? Math.round(parts.reduce((a, p) => a + p.score100, 0) / parts.length) : null;
}

// Following-count buckets (heuristic boundaries) with a heuristic base chance of a follow-back: accounts that follow
// very few others (< 50) almost never follow back; accounts that follow thousands often do.
const FOLLOWING_BUCKETS = [
  { key: "lt50", max: 50, base: 0.03 },
  { key: "50-199", max: 200, base: 0.08 },
  { key: "200-999", max: 1000, base: 0.18 },
  { key: "1k-5k", max: 5000, base: 0.32 },
  { key: "5k+", max: Infinity, base: 0.45 },
];
export function followingBucket(following) {
  const f = count(following);
  if (f < 0) return null;
  return FOLLOWING_BUCKETS.find((b) => f < b.max).key;
}
const DECIDED_DAYS = 7; // heuristic: after a week of comments without a follow-back an account counts as "did not follow back"
const PRIOR_WEIGHT = 6; // heuristic: the base chance counts like 6 observed accounts before your own data takes over

// Your own follow-back rate per following-count bucket: targets that followed back vs targets you commented on for
// a week or longer without one (plus accounts given up on, from the blacklist). Pure.
export function learnedRates(targets, blacklist = {}, ts = now()) {
  const buckets = {};
  const add = (following, fb) => {
    const k = followingBucket(following);
    if (!k) return;
    const b = (buckets[k] ||= { n: 0, fb: 0 });
    b.n++;
    if (fb) b.fb++;
  };
  for (const t of Object.values(targets || {})) {
    if (!t || !t.profile) continue;
    const rel = t.rel || {};
    if (rel.followedBackAt && rel.followsYou === true) add(t.profile.following, true);
    else if (rel.followsYou === false && t.stats && t.stats.firstCommentAt && ts - t.stats.firstCommentAt >= DECIDED_DAYS * DAY) add(t.profile.following, false);
  }
  for (const b of Object.values(blacklist || {})) if (b && b.reason === "no_followback" && b.following != null) add(b.following, false);
  return { buckets, at: ts };
}

// Chance (0-1) that the account follows you back after your comments, or null when its following count is unknown.
// 1 for accounts that already follow you. Base chance by following count, x a heuristic factor for the
// followers/following ratio (very selective accounts follow back less), then pulled towards your own follow-back
// rate in the same following bucket as your data grows.
export function propensity(t, learned) {
  if (!t) return null;
  const rel = t.rel || {};
  if (rel.followsYou === true) return 1;
  const p = t.profile || {};
  const following = count(p.following), followers = count(p.followers);
  if (following < 0) return null;
  const bucket = FOLLOWING_BUCKETS.find((b) => following < b.max);
  let x = bucket.base;
  if (followers >= 0) {
    const ratio = following > 0 ? followers / following : Infinity;
    // heuristic ratio factors
    x *= ratio >= 100 ? 0.5 : ratio >= 20 ? 0.75 : ratio >= 3 ? 1 : ratio >= 1 ? 1.3 : 1.6;
  }
  x = clamp(x, 0.01, 0.9);
  const b = learned && learned.buckets && learned.buckets[bucket.key];
  if (b && b.n > 0) x = (b.fb + PRIOR_WEIGHT * x) / (b.n + PRIOR_WEIGHT);
  return round2(clamp(x, 0.01, 0.95));
}

// A 50% chance of a follow-back or more counts in full, so value uses the whole 0-100 range (heuristic); below that
// the score is scaled down in proportion.
const FULL_CHANCE = 0.5;
const UNKNOWN_CHANCE = 0.15; // heuristic stand-in while an account's following count is unknown

// { value (0-100 | null), propensity (0-1 | null), score (0-100 | null), source: "providers"|"rank"|null, why }.
export function valueDetails(t, learned) {
  const parts = providerParts(t);
  const prov = parts.length ? Math.round(parts.reduce((a, p) => a + p.score100, 0) / parts.length) : null;
  const sc = (t && t.score) || {};
  const rank = sc.combined != null && Number.isFinite(Number(sc.combined)) ? Number(sc.combined) : sc.own != null && Number.isFinite(Number(sc.own)) ? Number(sc.own) : null;
  const score = prov != null ? prov : rank;
  const prop = propensity(t, learned);
  if (score == null) return { value: null, propensity: prop, score: null, source: null, why: prop == null ? "" : `No score yet; follow-back chance ${Math.round(prop * 100)}%` };
  const chance = prop == null ? UNKNOWN_CHANCE : prop;
  const value = Math.round(clamp(score * Math.min(1, chance / FULL_CHANCE), 0, 100));
  const label = prov != null ? `${parts.map((p) => p.name).join("+")} ${prov}` : `ScoreX rank ${Math.round(rank)}`;
  let why;
  if (t && t.rel && t.rel.followsYou === true) why = `${label}; follows you already`;
  else if (prop == null) why = `${label} x follow-back chance unknown (following count not read yet) = ${value}`;
  else {
    const p = (t && t.profile) || {};
    const fol = count(p.following), fwr = count(p.followers);
    const b = learned && learned.buckets && learned.buckets[followingBucket(fol)];
    const bits = [`follows ${fmtK(fol)}`];
    if (fwr >= 0 && fol > 0) bits.push(`${fmtK(Math.round(fwr / fol))} followers per follow`);
    if (b && b.n) bits.push(`${b.fb}/${b.n} similar accounts followed you back`);
    why = `${label} x follow-back chance ${Math.round(prop * 100)}% (${bits.join(", ")}) = ${value}`;
  }
  return { value, propensity: prop, score, source: prov != null ? "providers" : "rank", why: why.slice(0, 200) };
}
// value(t) = score x chance (see valueDetails); null without any score.
export function value(t, learned) { return valueDetails(t, learned).value; }
function fmtK(n) { return n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k" : String(n); }

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
