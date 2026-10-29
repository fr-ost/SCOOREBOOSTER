// ScoreX - comment sanitising and rule-based quality checks (no network).
// The optional model-based check lives in generator.js and runs after these rules pass.

import { words, ngrams, jaccard, countEmoji, normalizeText } from "./util.js";
import { HARD } from "./constants.js";

// Whole-comment or opener phrases that make a reply generic.
export const GENERIC_PHRASES = [
  "great post", "great thread", "great point", "great take", "great insight", "great insights", "great read", "nice post", "nice thread",
  "love this", "loved this", "love it", "so true", "very true", "well said", "well put", "couldn't agree more", "could not agree more",
  "this is huge", "huge if true", "big if true", "spot on", "nailed it", "100%", "facts", "this is gold", "pure gold", "thanks for sharing",
  "thank you for sharing", "interesting take", "interesting thread", "amazing", "awesome", "agreed", "absolutely", "needed this",
  "this!", "this 👆", "underrated take", "underrated", "so much this", "bullish", "lfg", "wagmi", "gm", "real", "fr", "based",
  "this is the way", "keep it up", "keep going", "love to see it", "let's go", "lets go", "can't wait", "cant wait", "game changer",
  "mind blown", "insane", "incredible", "wow", "true", "exactly", "this is it", "say it louder",
];
const GENERIC_OPENERS = [
  "great post", "great thread", "great point", "great take", "love this", "so true", "well said", "absolutely", "couldn't agree more",
  "spot on", "this is so true", "totally agree", "100%", "facts", "interesting take", "thanks for sharing", "nailed it", "agreed",
  "as someone who", "what a", "this is a great",
];

// Self-references that would reveal the reply was machine-written.
// Only first-person self-references: talking ABOUT AI/OpenAI/ChatGPT as a topic is fine.
const AI_SELF_RE = /\b(as an ai|i am an ai|i'm an ai|as an? (?:large )?language model|i am a (?:bot|language model)|i'm a (?:bot|language model)|ai[- ]generated (?:reply|comment|response)|(?:this|my) (?:reply|comment) (?:was|is) (?:ai[- ]generated|generated)|generated (?:by|with) (?:ai|chatgpt|gpt)|as an assistant|i cannot browse)\b/i;
const LINK_RE = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]{2,}\.(?:com|io|xyz|ai|org|net|co|app|gg|fi|me|so|dev|finance|exchange|link|ly|to)\b(?:\/\S*)?|\b(?:x\.com|t\.co|t\.me|bit\.ly|g\.co)\b/i;
const HASHTAG_RE = /(^|\s)#[\p{L}\p{N}_]+/u;
const MENTION_RE = /(^|\s)@[A-Za-z0-9_]{1,15}\b/;
const DASH_RE = /—|―/; // em dash, horizontal bar

// Clean model output: quotes, labels, leading @mentions, dashes, whitespace.
export function sanitizeComment(raw) {
  let t = String(raw == null ? "" : raw).replace(/\r/g, "").trim();
  t = t.replace(/^(?:reply|comment|response|answer)\s*[:\-]\s*/i, "");
  // surrounding quotes
  const q = t.match(/^["'“”‘’«»`](.*)["'“”‘’«»`]$/s);
  if (q && !/["“”«»]/.test(q[1])) t = q[1].trim(); // not when the text starts and ends with separate quoted words
  // leading @mentions the model may add ("@vitalik ...")
  t = t.replace(/^(?:@[A-Za-z0-9_]{1,15}[\s,:]*)+/, "");
  // em dash / horizontal bar -> comma or period
  t = t.replace(/\s*[—―]\s*(?=[A-Z])/g, ". ").replace(/\s*[—―]\s*/g, ", ");
  // spaced en dash used as a dash -> comma
  t = t.replace(/\s+–\s+/g, ", ");
  // trailing hashtags block
  t = t.replace(/(?:\s+#[\p{L}\p{N}_]+)+\s*$/u, "");
  t = t.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").replace(/ ,/g, ",").trim();
  return t;
}

// Dominant writing system of a text; "" when unknown (too little text).
export function scriptOf(text) {
  const counts = {};
  const tests = [
    ["latin", /\p{Script=Latin}/u], ["cyrillic", /\p{Script=Cyrillic}/u], ["arabic", /\p{Script=Arabic}/u], ["han", /\p{Script=Han}/u],
    ["hiragana", /\p{Script=Hiragana}|\p{Script=Katakana}/u], ["hangul", /\p{Script=Hangul}/u], ["devanagari", /\p{Script=Devanagari}/u],
    ["bengali", /\p{Script=Bengali}/u], ["thai", /\p{Script=Thai}/u], ["greek", /\p{Script=Greek}/u], ["hebrew", /\p{Script=Hebrew}/u],
  ];
  const s = String(text || "").replace(/https?:\/\/\S+|@\w+|#\w+/g, "");
  for (const ch of s) for (const [name, re] of tests) if (re.test(ch)) { counts[name] = (counts[name] || 0) + 1; break; }
  let best = "", n = 0, total = 0;
  for (const [k, v] of Object.entries(counts)) { total += v; if (v > n) { best = k; n = v; } }
  if (total < 8) return "";
  if (best === "han" && counts.hiragana) return "hiragana"; // Japanese mixes kanji + kana
  return best;
}

function isGeneric(text) {
  const t = normalizeText(text).replace(/[!.?]+$/, "");
  if (!t) return true;
  const plain = text.trim().toLowerCase().replace(/[!.?\s]+$/, "");
  if (GENERIC_PHRASES.includes(t) || GENERIC_PHRASES.includes(plain)) return true;
  const w = t.split(" ");
  if (w.length <= 3 && GENERIC_PHRASES.some((g) => { const n = normalizeText(g); return n && (t === n || t.startsWith(n + " ")); })) return true;
  return false;
}
function genericOpener(text) {
  const t = normalizeText(text);
  return GENERIC_OPENERS.find((g) => t.startsWith(normalizeText(g) + " ") || t === normalizeText(g)) || "";
}

const opener = (s, n = 3) => words(s).slice(0, n).join(" ");

// Similarity of a candidate against previous comments (your last 50).
export function similarity(text, previous) {
  const tw = words(text);
  const tri = ngrams(tw, 3);
  const five = ngrams(tw, 5);
  let max = 0, maxText = "", sharedPhrase = "", sameOpener = "";
  const op = opener(text);
  (previous || []).forEach((p, i) => {
    const pw = words(p);
    const sim = jaccard(tri, ngrams(pw, 3));
    if (sim > max) { max = sim; maxText = p; }
    if (!sharedPhrase) for (const g of ngrams(pw, 5)) if (five.has(g)) { sharedPhrase = g; break; }
    if (!sameOpener && i < 15 && op.split(" ").length >= 3 && opener(p) === op) sameOpener = op;
  });
  return { max, maxText, sharedPhrase, sameOpener };
}

// Rule check. ctx: { postText, postLang, previous: string[], settings }
// Returns { pass, reasons: [{code, text}], similarity }
export function ruleCheck(text, ctx = {}) {
  const reasons = [];
  const add = (code, t) => reasons.push({ code, text: t });
  const q = (ctx.settings && ctx.settings.quality) || {};
  const minChars = q.minChars || 12;
  const maxChars = Math.min(q.maxChars || 220, HARD.maxCommentChars);
  const t = String(text || "").trim();

  if (!t) { add("empty", "Empty comment"); return { pass: false, reasons, similarity: null }; }
  if (/^skip$/i.test(t)) { add("model_skip", "Model chose to skip this post"); return { pass: false, reasons, similarity: null }; }
  if (t.length < minChars) add("too_short", `Shorter than ${minChars} characters`);
  if (t.length > maxChars) add("too_long", `Longer than ${maxChars} characters`);
  if (LINK_RE.test(t)) add("link", "Contains a link");
  if (HASHTAG_RE.test(t)) add("hashtag", "Contains a hashtag");
  if (MENTION_RE.test(t)) add("mention", "Contains an @mention");
  if (countEmoji(t) > 1) add("emoji", "More than one emoji");
  if (DASH_RE.test(t)) add("em_dash", "Contains an em dash");
  if (AI_SELF_RE.test(t)) add("ai_mention", "Mentions AI / reveals it was generated");
  if (isGeneric(t)) add("generic", "Generic reply");
  else {
    const go = genericOpener(t);
    if (go) add("generic_opener", `Starts with a generic opener ("${go}")`);
  }
  if (ctx.postText) {
    const echo = jaccard(ngrams(words(t), 3), ngrams(words(ctx.postText), 3));
    if (echo > 0.5) add("echo", "Mostly repeats the post");
    const ps = scriptOf(ctx.postText), cs = scriptOf(t);
    if (ps && cs && ps !== cs) add("language", `Different language/script than the post (${cs} vs ${ps})`);
  }
  let sim = null;
  if (ctx.previous && ctx.previous.length) {
    sim = similarity(t, ctx.previous);
    const thr = q.similarityThreshold || 0.45;
    if (sim.max > thr) add("repeat", `Too similar to a previous comment (${Math.round(sim.max * 100)}%)`);
    else if (sim.sharedPhrase) add("repeat_phrase", `Reuses the phrase "${sim.sharedPhrase}"`);
    else if (sim.sameOpener) add("repeat_opener", `Same opening as a recent comment ("${sim.sameOpener}")`);
  }
  return { pass: reasons.length === 0, reasons, similarity: sim };
}

// Human-readable feedback for a regeneration attempt.
export function feedbackFor(reasons, sim) {
  const lines = (reasons || []).map((r) => "- " + r.text);
  if (sim && sim.sameOpener) lines.push(`- Do not start with "${sim.sameOpener}".`);
  if (sim && sim.sharedPhrase) lines.push(`- Do not use the phrase "${sim.sharedPhrase}".`);
  return lines.join("\n");
}
