// ScoreX - conversation alerts: while running, reads your X mentions every few minutes and flags replies from the
// accounts you comment on (an author reply is the best moment for a follow-back - answer it yourself).
// The engine calls conversationsStep from its idle step (under the job lease, in the worker tab); the dashboard
// lists sx.conversations and marks items done with the conversationDone message. Nothing is ever posted from here.

//
// sx.conversations = { items: [{ id (history record id of your reply), target, comment (your reply), replyUrl,
//   authorReplyUrl, authorReplyId, text (the author's answer: untrusted page text, plain, max 280 chars), at, done }],
//   seen: [author reply ids already handled], checkedAt }. One item per reply of yours (newest 200 kept); a newer
//   answer on the same reply updates the item and opens it again.

import { K, HS, CMD } from "./constants.js";
import { load, update, getState, patchState, log } from "./store.js";
import { navigate, send, waitForPage } from "./tabs.js";
import { pageVerdict } from "./guard.js";
import { notify } from "./notify.js";
import * as H from "./history.js";
import { now, MIN, HOUR, DAY, sleep, humanDelay, truncate } from "./util.js";

const EMPTY = { items: [], checkedAt: null };
export const MENTIONS_URL = "https://x.com/notifications/mentions";
const WINDOW_MS = 72 * HOUR; // answers are matched to your replies of the last 72 h
const KEEP = 200; // newest items kept
const SEEN_CAP = 500; // author reply ids remembered, so one answer is never reported twice
const TEXT_MAX = 280;
const SKEW_MS = 2 * MIN; // heuristic tolerance between your reply's time and the answer's time
// navigate()'s 3rd argument: the page-load purpose for the X footprint ledger (lib/tabs.js). valueOf keeps it a valid
// timeout (45 s) for the older navigate(tabId, url, timeoutMs) signature.
const NAV = (purpose) => ({ purpose, timeoutMs: 45000, valueOf: () => 45000 });

export async function getConversations() { return load(K.conversations, EMPTY); }

// Untrusted page text -> plain text for display (the dashboard sets it with textContent): control and bidi-override
// characters removed, whitespace collapsed, at most 280 characters.
export function cleanText(s) {
  return truncate(String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim(), TEXT_MAX);
}

// Pure: which mentions are answers from accounts you replied to in the last 72 h. Each is matched to your newest reply
// to that account posted before the answer. Returns [{ tweet, rec }] (oldest answer first).
export function matchMentions(tweets, records, { me = "", ts = now(), seen = new Set() } = {}) {
  const mine = String(me || "").toLowerCase();
  const byTarget = new Map();
  for (const r of records || []) {
    if (!r || r.status !== HS.POSTED || !r.postedAt || !r.target || ts - r.postedAt > WINDOW_MS) continue;
    if (!byTarget.has(r.target)) byTarget.set(r.target, []);
    byTarget.get(r.target).push(r);
  }
  const out = [];
  const used = new Set();
  for (const tw of tweets || []) {
    if (!tw || !tw.id || !tw.author || tw.isRepost || seen.has(tw.id) || used.has(tw.id)) continue;
    const author = String(tw.author).toLowerCase();
    if (author === mine) continue;
    const recs = byTarget.get(author);
    if (!recs) continue;
    const at = Number(tw.createdAt) || null;
    const rec = recs.filter((r) => !at || r.postedAt <= at + SKEW_MS).sort((a, b) => b.postedAt - a.postedAt)[0];
    if (!rec) continue; // older than your reply: not an answer to it
    used.add(tw.id);
    out.push({ tweet: tw, rec });
  }
  return out.sort((a, b) => (Number(a.tweet.createdAt) || 0) - (Number(b.tweet.createdAt) || 0));
}

async function recordMatches(tweets, records, me, ts) {
  const cur = await load(K.conversations, EMPTY);
  const seen = new Set([...(cur.seen || []), ...(cur.items || []).map((x) => x && x.authorReplyId).filter(Boolean)]);
  const matches = matchMentions(tweets, records, { me, ts, seen });
  for (const { tweet, rec } of matches) {
    await H.patch(rec.id, (r) => ({ results: { ...(r.results || {}), authorReplied: true, authorReplyUrl: tweet.url, authorReplyAt: Number(tweet.createdAt) || ts } }));
  }
  await update(K.conversations, EMPTY, (c) => {
    const items = (c.items || []).filter(Boolean);
    const seenIds = new Set(c.seen || []);
    for (const { tweet, rec } of matches) {
      seenIds.add(tweet.id);
      const item = {
        id: rec.id, target: rec.target, comment: cleanText(rec.comment), replyUrl: rec.replyUrl || "",
        authorReplyUrl: tweet.url || "", authorReplyId: tweet.id, text: cleanText(tweet.text), at: Number(tweet.createdAt) || ts, done: false,
      };
      const i = items.findIndex((x) => x.id === rec.id);
      if (i >= 0) items[i] = { ...items[i], ...item };
      else items.push(item);
    }
    items.sort((a, b) => (b.at || 0) - (a.at || 0));
    return { ...c, items: items.slice(0, KEEP), seen: [...seenIds].slice(-SEEN_CAP), checkedAt: ts };
  });
  for (const { rec } of matches) log("info", `@${rec.target} replied to your comment`);
  if (matches.length === 1) {
    const { tweet, rec } = matches[0];
    await notify("sx-conv", `@${rec.target} replied to your comment`, truncate(cleanText(tweet.text), 200) || "Open ScoreX to answer it.");
  } else if (matches.length > 1) {
    const names = [...new Set(matches.map((m) => "@" + m.rec.target))];
    await notify("sx-conv", `${matches.length} replies to your comments`, `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""} replied - answer them yourself on X.`);
  }
  return matches.length;
}

// One read of your mentions page (called by the engine when idle, in the worker tab, at most every everyMin minutes
// and only while you have replies from the last 72 h). Reads only - nothing is ever posted or clicked.
// Returns null (nothing due), { did: "mentions", found } after a page load, or { stop, detail } on an X safety page.
export async function conversationsStep({ tabId, settings, me, shouldStop }) {
  const cv = settings.learning && settings.learning.conversations;
  if (!cv || !cv.enabled) return null;
  const stopped = shouldStop || (async () => false);
  const ts = now();
  const st = await getState();
  if (st.learningForce) return null; // engagement checks you asked for ("check now") go first
  if (st.lastMentionsAt && ts - st.lastMentionsAt < cv.everyMin * MIN) return null;
  const records = (await H.since(ts - WINDOW_MS - DAY)).filter((r) => r.status === HS.POSTED && r.postedAt && ts - r.postedAt <= WINDOW_MS);
  if (!records.length) return null; // nobody to hear back from: no page load
  if (await stopped()) return null;
  await patchState({ lastMentionsAt: ts });
  const handle = String(me || (settings.account && settings.account.handle) || "").toLowerCase().replace(/^@/, "");
  const nav = await navigate(tabId, MENTIONS_URL, NAV("mentions"));
  if (!nav.ok && nav.budget) return null; // X page-load budget reached: nothing was loaded (read again when due)
  if (!nav.ok) { log("warn", `Conversation alerts: your mentions page did not load (${nav.error || "unknown"})`); return { did: "mentions", ok: false, found: 0 }; }
  const w = await waitForPage(tabId, ["tweet", "emptyState"], 20000);
  const v = pageVerdict(w.page, settings);
  if (v && v.stop) return { stop: v.stop, detail: v.detail };
  let tweets = [];
  if (!(w.ok && w.key === "emptyState") && !(v && v.notFound)) {
    await sleep(humanDelay(1200, 2600));
    const r = await send(tabId, CMD.SCRAPE_TWEETS, { limit: 40 }, 20000);
    const v2 = pageVerdict(r.page, settings);
    if (v2 && v2.stop) return { stop: v2.stop, detail: v2.detail };
    if (!r.ok) { log("warn", `Conversation alerts: could not read your mentions (${r.error || "unknown"})`); return { did: "mentions", ok: false, found: 0 }; }
    tweets = r.tweets || [];
  }
  const found = await recordMatches(tweets, records, handle, ts); // also stamps checkedAt
  return { did: "mentions", ok: true, found };
}

export async function markDone(id, done = true) {
  let found = false;
  await update(K.conversations, EMPTY, (cur) => ({
    ...cur,
    items: (cur.items || []).map((x) => {
      if (!x || x.id !== id) return x;
      found = true;
      return { ...x, done: !!done };
    }),
  }));
  return found ? { ok: true } : { ok: false, error: "Not found" };
}
