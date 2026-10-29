// ScoreX - which posts are worth a comment. Pure functions over a scraped post (see content/scrape.js):
// { id, url, author, authorName, text, lang, createdAt, isReply, isRepost, isQuote, isPromoted, isPinned,
//   hasMedia, hasCard, links: [], metrics: { replies, reposts, likes, views } }

import { MIN, now } from "./util.js";

const GIVEAWAY_RE = /\b(giveaway|give away|giving away|airdrop|whitelist|wl spots?|wl giveaway|free mint|raffle|winners? (?:will be|announced)|enter to win|retweet to win|rt to win|rt\s*(?:&|\+|and)\s*follow|like\s*(?:&|\+|,|and)\s*(?:rt|retweet)|tag \d+ friends?|tag your friends|drop your (?:wallet|address|sol|eth|evm|addy)|comment your (?:wallet|address)|first \d+ (?:people|to))\b|(\$\d+\s*(?:usdt|usdc)?\s*(?:to|for) \d+ (?:people|winners))\b/i; // "$" is not a word char, so it cannot sit behind the leading \b
const GM_RE = /^(?:gm|gn|gmgm|gm gm|good ?morning|good ?night|gm fam|gm frens|gm everyone|gm all|gm ct|gm x|happy (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend))\b[\s\W\p{Extended_Pictographic}]*(?:fam|frens|everyone|all|ct|x|friends|legends|degens|☕)?[\s\W\p{Extended_Pictographic}]*$/iu;
const SENSITIVE_RE = /\b(rip|rest in peace|passed away|passing of|condolences|funeral|tragedy|murdered|suicide|mourning|prayers for|earthquake|mass shooting|terror attack|killed in|died in)\b/i;
const UNTRANSLATABLE_LANGS = new Set(["", "und", "zxx", "qme", "qht", "qam", "qst", "art"]);

export function textWithoutLinks(text) {
  return String(text || "").replace(/https?:\/\/\S+/g, " ").replace(/\b\S+\.(?:com|io|xyz|ai|org|net|co|app|gg|fi|me|ly)\/\S*/gi, " ").replace(/(^|\s)@\w+/g, " ").replace(/\s+/g, " ").trim();
}

function hasKeyword(text, list) {
  const t = " " + String(text || "").toLowerCase().replace(/[^\p{L}\p{N}\s$#@']/gu, " ").replace(/\s+/g, " ") + " ";
  for (const k of list || []) {
    const kw = String(k).toLowerCase().trim();
    if (!kw) continue;
    if (t.includes(" " + kw + " ") || t.includes(" #" + kw + " ") || t.includes(" $" + kw + " ")) return kw;
  }
  return "";
}

// Returns null when the post is fine, else { code, text }. ctx.ts overrides "now".
export function skipReason(post, settings, ctx = {}) {
  const sk = settings.safety.skip;
  const w = settings.watch;
  const t = ctx.ts || now();
  if (!post || !post.id) return { code: "invalid", text: "Unreadable post" };
  if (post.isPromoted && sk.ads) return { code: "ad", text: "Ad / promoted post" };
  if (post.isRepost) return { code: "repost", text: "Repost, not their own post" };
  if (post.isReply) return { code: "reply", text: "Reply in a thread, not an original post" };
  if (post.isQuote && !w.includeQuotes) return { code: "quote", text: "Quote post (quotes disabled)" };
  const text = String(post.text || "");
  const bare = textWithoutLinks(text);
  const linkish = (post.links && post.links.length) || post.hasCard || /https?:\/\//.test(text);
  if (sk.linkOnly && linkish && bare.length < Math.max(25, sk.minChars)) return { code: "link_only", text: "Link-only post" };
  if (bare.length < sk.minChars && !post.hasMedia) return { code: "too_short", text: `Text shorter than ${sk.minChars} characters` };
  if (bare.length < 4) return { code: "too_short", text: "No text to respond to" };
  if (sk.gm && GM_RE.test(bare)) return { code: "gm", text: '"gm" / greeting post' };
  if (sk.giveaways && GIVEAWAY_RE.test(text)) return { code: "giveaway", text: "Giveaway / airdrop / engagement bait" };
  if (sk.political) {
    const kw = hasKeyword(text, sk.politicalKeywords);
    if (kw) return { code: "political", text: `Political / controversial ("${kw}")` };
    if (SENSITIVE_RE.test(text)) return { code: "sensitive", text: "Sensitive / tragic topic" };
  }
  const bw = hasKeyword(text, sk.blockedWords);
  if (bw) return { code: "blocked_word", text: `Contains blocked word "${bw}"` };
  if (sk.languages && sk.languages.length) {
    const lang = String(post.lang || "").toLowerCase();
    if (!UNTRANSLATABLE_LANGS.has(lang) && !sk.languages.includes(lang)) return { code: "language", text: `Language "${lang}" not in your list` };
  }
  if (post.createdAt) {
    const ageMin = (t - post.createdAt) / MIN;
    if (ageMin > w.maxPostAgeMin) return { code: "stale", text: `Post is ${Math.round(ageMin)} min old (max ${w.maxPostAgeMin})` };
  }
  return null;
}

// Post too fresh to reply yet (we wait at least minPostAgeMin so replies never look instant).
export function tooFresh(post, settings, ts = now()) {
  if (!post.createdAt) return false;
  return (ts - post.createdAt) / MIN < settings.watch.minPostAgeMin;
}

export function postAgeMin(post, ts = now()) { return post && post.createdAt ? (ts - post.createdAt) / MIN : null; }
