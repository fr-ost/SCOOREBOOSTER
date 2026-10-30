// ScoreX - which posts are worth a comment. Pure functions over a scraped post (see content/scrape.js):
// { id, url, author, authorName, text, lang, createdAt, isReply, isRepost, isQuote, isPromoted, isPinned,
//   hasMedia, hasCard, links: [], metrics: { replies, reposts, likes, views } }

import { MIN, now } from "./util.js";

// "airdrop" / "whitelist" alone is everyday crypto talk ("the airdrop meta is dead"): only engagement bait
// with an action cue counts. "give away" needs a prize ("giving away $500"), not "never give away your seed".
const GIVEAWAY_RE = /\b(giveaway|wl spots?|wl giveaway|free mint|raffle|winners? (?:will be|announced)|enter to win|retweet to win|rt to win|rt\s*(?:&|\+|and)\s*follow|like\s*(?:&|\+|,|and)\s*(?:rt|retweet)|tag \d+ friends?|tag your friends|drop your (?:wallet|address|sol|eth|evm|addy)|comment your (?:wallet|address)|first \d+ (?:people|to)|giv(?:e|ing) away (?:\$?\d+|free|an? \w+|some|nfts?|wl|whitelist spots?|tokens?|usdt|usdc|merch))\b|(\$\d+\s*(?:usdt|usdc)?\s*(?:to|for) \d+ (?:people|winners))\b/i; // "$" is not a word char, so it cannot sit behind the leading \b
const DROP_RE = /\b(?:airdrops?|whitelists?|allowlists?)\b/i;
const DROP_CUE_RE = /\b(?:rt|retweet|repost|like\s*(?:&|\+|,|and)|follow\s*(?:&|\+|,|and|me|us)|follow @\w+|tag (?:\d+|your|a friend|friends|someone)|comment (?:your|below|with)|reply (?:with|below)|drop your|turn on (?:post )?notifications|to be eligible|to qualify|to enter|must follow)\b/i;
// Only punctuation, symbols and emoji may follow the greeting (\W would also swallow a whole Bengali post).
const GM_RE = /^(?:gm|gn|gmgm|gm gm|good ?morning|good ?night|gm fam|gm frens|gm everyone|gm all|gm ct|gm x|happy (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend))\b[\s\p{P}\p{S}\p{M}\p{Extended_Pictographic}\u200d]*(?:fam|frens|everyone|all|ct|x|friends|legends|degens|☕)?[\s\p{P}\p{S}\p{M}\p{Extended_Pictographic}\u200d]*$/iu;
// Trading slang that sounds tragic: "RIP shorts", "longs got killed in an hour", "thoughts and prayers for the bears".
const LOSERS = String.raw`shorts?|longs?|bears?|bulls?|shorters|longers|bags?|portfolios?|alts?|altcoins?|memecoins?|leverage|degens?|jeets?|fudders|paper hands|traders?|positions?|liquidity`;
const SENSITIVE_RE = new RegExp(String.raw`\b(?:rest in peace|passed away|passing of (?!(?:the |this |a |an )?(?:[\w-]+ )?(?:bill|act|law|laws|proposal|amendment|resolution|torch|baton)\b)|condolences|funeral|suicide|mourning|earthquake|mass shooting|terror attack|prayers for (?!(?:the |all |all the |my |our |your )?(?:${LOSERS})\b)|(?<!\b(?:${LOSERS})\s+(?:(?:got|get|getting|were|was|are|been|just|all)\s+)*)(?:killed in|died in|murdered))\b`, "i");
const SENSITIVE_WORDS = ["নিহত", "ইন্নালিল্লাহ", "ইন্না লিল্লাহ", "innalillahi", "inna lillahi", "निधन", "श्रद्धांजलि"];
// "RIP <someone>" is tragic; "RIP shorts", "about to rip", "rip-off" are not.
const RIP_RE = /\b(?:rip|r\.i\.p)\b\.?/gi;
const RIP_VERB_BEFORE = /\b(?:to|will|would|could|can|gonna|should|might|may|it'll|let it|let her|let em)\s+$/i;
const RIP_NOT_SAD_AFTER = new RegExp(String.raw`^\s*(?:to\s+)?(?:(?:the|all|all the|all my|my|your|our|those|these)\s+)?(?:(?:${LOSERS}|alt ?season|fud|gas|fees|higher|up|through|past|off|it|the band ?aid|band ?aid)\b|\$|\d|-off)`, "i");
function ripPerson(text) {
  for (const m of String(text || "").matchAll(RIP_RE)) {
    const before = text.slice(Math.max(0, m.index - 20), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
    if (!RIP_VERB_BEFORE.test(before) && !RIP_NOT_SAD_AFTER.test(after)) return true;
  }
  return false;
}
// Phrases that contain a default political keyword but are not politics in crypto ("leader election" in a
// consensus protocol, a DAO's council election, BNP Paribas the bank).
const NOT_POLITICAL = [];
for (const q of ["leader", "validator", "council", "committee", "delegate", "board", "dao", "governance", "sequencer", "onchain", "on chain", "steward", "multisig", "signer"]) NOT_POLITICAL.push(q + " elections", q + " election");
NOT_POLITICAL.push("bnp paribas");
const NOT_POLITICAL_RE = new RegExp(`(?<= )(?:${NOT_POLITICAL.join("|")})(?= )`, "g");
const UNTRANSLATABLE_LANGS = new Set(["", "und", "zxx", "qme", "qht", "qam", "qst", "art"]);

export function textWithoutLinks(text) {
  return String(text || "").replace(/https?:\/\/\S+/g, " ").replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,24}\/\S*/gi, " ").replace(/(^|\s)@\w+/g, " ").replace(/\s+/g, " ").trim();
}

// Text and keywords go through the same normalisation (NFKC, lowercase, possessives, punctuation -> space),
// keeping combining marks so Bengali / Hindi words stay whole ("নির্বাচন", "चुनाव"), and "pre-sale" = "pre sale".
function normKw(s) {
  return String(s || "").normalize("NFKC").toLowerCase()
    .replace(/['’]s\b/g, "").replace(/s['’](?=\s|$)/g, "s") // "Trump's", "Israel’s", "Republicans'"
    .replace(/[^\p{L}\p{M}\p{N}\s$#@]/gu, " ")
    .replace(/(^|[^\p{L}\p{M}])\p{M}+/gu, "$1")
    .replace(/\s+/g, " ").trim();
}

// Whole-word / whole-phrase match. political=true ignores the NOT_POLITICAL phrases (unless a keyword is one).
function hasKeyword(text, list, political = false) {
  const t = " " + normKw(text) + " ";
  const tn = political ? t.replace(NOT_POLITICAL_RE, "~") : t;
  for (const k of list || []) {
    const kw = normKw(k);
    if (!kw) continue;
    const hay = political && !NOT_POLITICAL.some((p) => (" " + kw + " ").includes(" " + p + " ")) ? tn : t;
    if (hay.includes(" " + kw + " ") || hay.includes(" #" + kw + " ") || hay.includes(" $" + kw + " ")) return String(k).toLowerCase().trim();
  }
  return "";
}

// Returns null when the post is fine, else { code, text }. ctx.ts overrides "now"; ctx.maxAgeMin overrides
// the live comment window (catch-up comments on older posts).
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
  if (sk.giveaways && (GIVEAWAY_RE.test(text) || (DROP_RE.test(text) && DROP_CUE_RE.test(text)))) return { code: "giveaway", text: "Giveaway / airdrop / engagement bait" };
  if (sk.political) {
    const kw = hasKeyword(text, sk.politicalKeywords, true);
    if (kw) return { code: "political", text: `Political / controversial ("${kw}")` };
    if (SENSITIVE_RE.test(text) || ripPerson(text) || hasKeyword(text, SENSITIVE_WORDS)) return { code: "sensitive", text: "Sensitive / tragic topic" };
  }
  const bw = hasKeyword(text, sk.blockedWords);
  if (bw) return { code: "blocked_word", text: `Contains blocked word "${bw}"` };
  if (sk.languages && sk.languages.length) {
    const lang = String(post.lang || "").toLowerCase();
    if (!UNTRANSLATABLE_LANGS.has(lang) && !sk.languages.includes(lang)) return { code: "language", text: `Language "${lang}" not in your list` };
  }
  if (post.createdAt) {
    const ageMin = (t - post.createdAt) / MIN;
    const max = ctx.maxAgeMin || w.maxPostAgeMin;
    if (ageMin > max) return { code: "stale", text: `Post is ${Math.round(ageMin)} min old (max ${Math.round(max)})` };
  }
  return null;
}

// Post too fresh to reply yet (we wait at least minPostAgeMin so replies never look instant).
export function tooFresh(post, settings, ts = now()) {
  if (!post.createdAt) return false;
  return (ts - post.createdAt) / MIN < settings.watch.minPostAgeMin;
}

export function postAgeMin(post, ts = now()) { return post && post.createdAt ? (ts - post.createdAt) / MIN : null; }
