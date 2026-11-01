// ScoreX UI smoke test: loads the unpacked extension in headless Chromium against the real background worker,
// seeds realistic data (targets, history, candidates, blacklist, spend, logs, score sites, smart followers,
// conversations, reach alert, X page loads, a saved live test), then:
// - opens all 10 screens (+ Diagnostics) in light and dark at 1360, 800 and 560 px: no render failure, no
//   horizontal page scroll, no "Group A/B" text, no console errors; screenshots in tests/e2e/out/
// - the shell: grouped rail (WORK / GROWTH / SETUP) navigation to every screen, aliases (#results, #diagnostics),
//   engine bar (status, one primary button, Stop, account chip, risk chip), the Menu sheet at 560 px
// - Today: Full-auto confirm, setup stepper, review preview, Needs you (reach banner + Dismiss, replies waiting +
//   Mark done / Undo, page-load warning), activity log, follow figures, This week figures and charts
// - Targets: status chips, columns (Follow status, Value, Follows back?, score site), High value, search, bulk
//   bar, Add targets sheet, blacklist through the real worker, follow rules sheet (+ clamping), target drawer
//   (row click, #targets?h=, J/K, Esc)
// - Discover (sources, smart-follower blocks from sx.scoreboard.smart, candidates with score-site columns) and
//   Scores (score cells, deltas, history chart, coverage; enabling a site asks Chrome first: the prompt cannot be
//   clicked in a test, so chrome.permissions.request is stubbed and both answers are checked; the next own-score
//   refresh after a site refused is promised 20 h later)
// - Review keyboard (J/K/A/S/Z, ?), the held approve with Undo and the Approve-all-with-edits dialog; Regenerate stays
//   busy across redraws and visits, an edit is dropped once its reply is approved elsewhere, an approved reply to a
//   turned-off target says it will not post
// - Results (funnel, daily bars, heatmap, views, Comments table + filters + drawer), Tone (prompt, Try it, learn
//   from edits), Safety (clamping, risk report, page loads, reach monitor), Settings (Diagnostics quick check +
//   the saved live test, a live test stopped by Pause/Stop is not kept, mode select confirm), Models (masked key,
//   estimator, preset per tier), theme menu
// - the safety stop: "Review stop…" (no one-click resume, also in the setup stepper), a confirm that needs its
//   checkbox, Discover's X-tab sources wait for the reviewed stop
// - a screen left mid-render registers nothing in the next one and never acts on its ?h=; narrow tables keep their
//   key columns in view
// - collapsed Advanced sections (remembered), and the popup (status, one primary, review next, quota strip,
//   replies line, risk, the This-profile card hidden when the active tab is not x.com)
//
// Run: node tests/e2e/ui_smoke.mjs     Screenshots: tests/e2e/out/
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const EXT = "/home/user/SCOOREBOOSTER/extension";
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");
// [route, rail label / screen title]
const SCREENS = [["overview", "Today"], ["review", "Review"], ["targets", "Targets"], ["discover", "Discover"], ["history", "History"], ["scores", "Scores"], ["settings", "Settings"]];
// Settings tabs (their own routes under the Settings rail item) and the other routes every theme/width pass renders.
const SETUP = [["settings", "General"], ["tones", "Tone"], ["models", "Models & costs"], ["safety", "Safety"]];
const READY = { results: "history", diagnostics: "settings", comments: "history" }; // route aliases -> the screen that renders them
const FAKE_KEY = "sk-test-UIsmoke1234567890abcdWXYZ";

fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (/^(light|dark|narrow)-.*\.png$/.test(f)) fs.rmSync(path.join(OUT, f), { force: true });

const errors = [];
let passed = 0, failed = 0;
let curRoute = "-";
function check(cond, msg) {
  if (cond) { passed++; console.log("  ok   " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}
function watch(page, label) {
  const where = () => (typeof label === "function" ? label() : label);
  page.on("pageerror", (e) => errors.push(`[${where()}] pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`[${where()}] console.error: ${m.text()}`); });
}
async function section(name, fn) {
  console.log(name);
  try { await fn(); } catch (e) { failed++; console.log(`  FAIL ${name}: exception ${String((e && e.stack) || e).slice(0, 1200)}`); }
}

// ------------------------------------------------------------------ stubs (run before every extension page)
// Chrome's permission prompt cannot be clicked in a test: chrome.permissions.request answers from localStorage
// "sx.test.perm" ("grant" or anything else = deny) and logs each request to localStorage "sx.test.permLog".
function permStub() {
  try {
    if (!globalThis.chrome || !chrome.permissions || !chrome.permissions.request) return;
    chrome.permissions.request = (p) => {
      try { const log = JSON.parse(localStorage.getItem("sx.test.permLog") || "[]"); log.push(p); localStorage.setItem("sx.test.permLog", JSON.stringify(log)); } catch (_) { /* ignore */ }
      return Promise.resolve(localStorage.getItem("sx.test.perm") === "grant");
    };
  } catch (_) { /* not an extension page */ }
}

// ------------------------------------------------------------------ seed (runs inside an extension page)
async function seed() {
  const hist = await import(chrome.runtime.getURL("lib/history.js"));
  const util = await import(chrome.runtime.getURL("lib/util.js"));
  const now = Date.now(), MIN = 60e3, HR = 36e5, DAY = 864e5;
  const tz = "Asia/Dhaka";
  // Follow status (lib/targets.js followStatus): followsYou null = checking, false = not following (commented
  // on; "day N/14" from stats.firstCommentAt), true = follows you, true + rel.followedBackAt = followed back.
  const T = (handle, o) => ({
    handle, name: o.name, group: o.followsYou ? "A" : "B", tier: o.tier, enabled: o.enabled !== false, tone: o.tone || "", preset: o.preset || "", notes: "", source: "manual",
    addedAt: now - 20 * DAY,
    profile: { handle, name: o.name, bio: o.bio, followers: o.followers, following: o.following || 800, verified: !!o.verified, updatedAt: now - DAY },
    recentPosts: [], lastPostAt: now - 2 * HR, lastCheckedAt: now - HR,
    rel: { followsYou: o.followsYou, youFollow: true, checkedAt: o.followsYou == null ? null : now - DAY, followedBackAt: o.followedBackAt || null, ...(o.gone ? { gone: true } : {}) },
    score: { own: o.own, sorsa: o.sorsa == null ? null : o.sorsa, combined: o.own, flags: [], bot: false, updatedAt: now - DAY },
    priority: o.priority || 50, coldUntil: o.coldUntil || null,
    stats: { comments: o.comments || 0, firstCommentAt: o.firstAgo ? now - o.firstAgo : null, lastCommentAt: o.comments ? now - o.lastAgo : null, engaged: 1, noResponseStreak: 0, likes: 3, replies: 1, authorReplies: 0, lastEngagedAt: null },
  });
  const targets = {};
  for (const t of [
    T("naval", { name: "Naval", tier: 1, followers: 2900000, own: 91, sorsa: 2410, followsYou: false, verified: true, bio: "Angel investor. Wealth, happiness and the future of technology.", priority: 85, comments: 4, lastAgo: 2 * DAY, firstAgo: 5 * DAY + 3 * HR }),
    T("balajis", { name: "Balaji", tier: 1, followers: 1100000, own: 88, sorsa: 1980, followsYou: false, verified: true, bio: "Network state. Formerly CTO Coinbase, GP a16z.", priority: 80, comments: 2, lastAgo: 5 * DAY, firstAgo: 12 * DAY + 5 * HR, tone: "expert" }),
    T("dwarkesh_sp", { name: "Dwarkesh Patel", tier: 2, followers: 210000, own: 79, followsYou: null, bio: "Host of the Dwarkesh Podcast.", priority: 60 }),
    T("karpathy", { name: "Andrej Karpathy", tier: 1, followers: 1300000, own: 93, sorsa: 2650, followsYou: false, verified: true, bio: "Building @EurekaLabsAI. Previously Director of AI @ Tesla.", priority: 90, comments: 1, lastAgo: 9 * HR, firstAgo: 9 * HR, preset: "high" }),
    T("onchain_anna", { name: "Anna | onchain", tier: 2, followers: 18400, own: 64, followsYou: true, bio: "Onchain analyst. Charts, flows, no shilling.", priority: 55 }),
    T("devrel_sam", { name: "Sam builds", tier: 2, followers: 9200, own: 58, followsYou: true, followedBackAt: now - 2 * DAY, bio: "DevRel. Shipping small tools every week.", priority: 45, comments: 3, lastAgo: 3 * DAY, firstAgo: 8 * DAY, coldUntil: now + 6 * DAY }),
    T("macro_mira", { name: "Mira Macro", tier: 1, followers: 86000, own: 76, sorsa: 640, followsYou: true, bio: "Macro, rates and liquidity. Ex-sell side.", priority: 70 }),
    T("quiet_quant", { name: "Quiet Quant", tier: 2, followers: 4300, own: 41, followsYou: false, gone: true, bio: "Systematic trading notes.", enabled: false }),
  ]) targets[t.handle] = t;

  const call = (modelId, modelName, effort, input, output, reasoning, cost, kind = "gen") => ({ kind, modelId, modelName, effort, usage: { input, cached: Math.round(input * 0.3), cacheWrite: 0, output, reasoning }, cost, ms: 2300, ok: true });
  const base = (o) => ({
    created: o.created,
    target: o.target, targetName: targets[o.target].name, group: targets[o.target].group, tier: targets[o.target].tier,
    postId: String(1850000000000000000 + Math.floor(Math.random() * 1e9)), postUrl: `https://x.com/${o.target}/status/18500000000${Math.floor(Math.random() * 1e6)}`,
    postText: o.postText, postLang: "en", postCreatedAt: o.created - 4 * MIN, postMetrics: { likes: 420, replies: 37, reposts: 51, views: 61000 },
    tone: o.tone || "insightful", preset: o.preset || "balanced", modelId: o.modelId || "m_balanced", modelName: o.modelName || "gpt-6.1-terra", effort: o.effort || "medium",
    comment: o.comment, originalComment: o.comment, attempts: 1, quality: { pass: true, reasons: o.reasons || [], modelVerdict: o.verdict || null },
    calls: o.calls || [call("m_balanced", "gpt-6.1-terra", "medium", 1420, 380, 290, 0.00327), call("m_cheap", "gpt-6-luna", "low", 680, 140, 90, 0.00014, "check")],
    status: o.status, reason: o.reason || "", mode: "review", scheduledFor: o.scheduledFor || null,
    postedAt: o.status === "posted" ? o.created + 20 * MIN : null, liked: !!o.liked, results: o.results || {},
  });
  const recs = [
    base({ target: "naval", created: now - 3 * MIN, status: "pending_review", postText: "The best founders I know read history, not business books. Patterns repeat; tactics don't.", comment: "History gives you the base rates. Most business books are survivorship stories written after the fact, which is why the patterns transfer and the tactics never do." }),
    base({ target: "karpathy", created: now - 8 * MIN, status: "pending_review", tone: "expert", preset: "high", modelId: "m_best", modelName: "gpt-6.1-sol", effort: "high", calls: [call("m_best", "gpt-6.1-sol", "high", 1600, 2900, 2780, 0.0322)], postText: "Tokenization is still the source of a surprising number of LLM weirdness bugs. Spelling, arithmetic, trailing spaces...", comment: "The trailing-space one bit us in eval harnesses: same prompt, one extra space, 4 point accuracy swing. Byte-level fallbacks help, but the vocab still leaks into behaviour.", reasons: ["Opening is similar to a recent comment (0.38)"] }),
    base({ target: "onchain_anna", created: now - 15 * MIN, status: "pending_review", tone: "friendly", preset: "cheap", modelId: "m_cheap", modelName: "gpt-6-luna", effort: "low", postText: "Stablecoin supply on L2s just crossed $20B. Flows are rotating out of mainnet faster than I expected.", comment: "Wild that the rotation sped up right after fees dropped. Curious if you're seeing it in active addresses too or mostly whales moving size?", verdict: { pass: true, issue: "" } }),
    base({ target: "macro_mira", created: now - 40 * MIN, status: "approved", scheduledFor: now + 12 * MIN, postText: "Term premium is back near decade highs and nobody on the timeline is talking about it.", comment: "And it's happening with cuts priced in, which is the part that should worry people. The long end is pricing supply, not the Fed." }),
    base({ target: "balajis", created: now - 55 * MIN, status: "queued", scheduledFor: now + 31 * MIN, tone: "expert", postText: "Every country will eventually have a digital-first citizenship option.", comment: "Estonia's e-residency is the closest live test: 100k+ signups, but the real unlock was company formation, not identity." }),
    base({ target: "naval", created: now - 1 * DAY, status: "posted", liked: true, postText: "Earn with your mind, not your time.", comment: "The hard part is that the first years of mind-leverage look exactly like working for free.", results: { likes: 18, replies: 3, authorReplied: true, followedBack: false, checkedAt: now - 2 * HR } }),
    base({ target: "onchain_anna", created: now - 1 * DAY - 3 * HR, status: "posted", tone: "friendly", postText: "New dashboard for L2 bridge flows is live.", comment: "The per-bridge latency column is a great touch, first time I've seen it broken out like that.", results: { likes: 4, replies: 1, authorReplied: true, checkedAt: now - 5 * HR } }),
    base({ target: "karpathy", created: now - 2 * DAY, status: "posted", tone: "witty", preset: "high", modelId: "m_best", modelName: "gpt-6.1-sol", effort: "high", calls: [call("m_best", "gpt-6.1-sol", "high", 1580, 2600, 2500, 0.0291)], postText: "Vibe coding is great until the vibes run out.", comment: "Then you discover the codebase was the vibes all along.", results: { likes: 96, replies: 11, authorReplied: false, followedBack: true, checkedAt: now - DAY } }),
    base({ target: "macro_mira", created: now - 3 * DAY, status: "posted", postText: "Liquidity is the only chart that matters this year.", comment: "Except the one that shows where that liquidity is parked: RRP drained, so the next leg has to come from reserves.", results: { likes: 7, replies: 0, checkedAt: now - 2 * DAY } }),
    base({ target: "devrel_sam", created: now - 4 * DAY, status: "posted", tone: "friendly", preset: "cheap", modelId: "m_cheap", modelName: "gpt-6-luna", effort: "low", postText: "Shipped a tiny CLI for diffing JSON schemas.", comment: "Does it handle $ref across files? That's where every schema diff tool I've tried falls apart.", results: { likes: 2, replies: 1, authorReplied: true, followedBack: false, checkedAt: now - 3 * DAY } }),
    base({ target: "balajis", created: now - 9 * DAY, status: "posted", tone: "bold", postText: "Media is just code that runs on human brains.", comment: "Which makes the feed algorithm the compiler, and nobody reviews its diffs.", results: { likes: 31, replies: 4, followedBack: false, checkedAt: now - 8 * DAY } }),
    base({ target: "dwarkesh_sp", created: now - 5 * HR, status: "skipped", reason: "Post is political/controversial (keyword: election)", postText: "Interview about the election forecasting models.", comment: "" }),
    base({ target: "naval", created: now - 2 * DAY - 4 * HR, status: "skipped", reason: "Expired: not reviewed within 180 min", postText: "Desire is a contract you make with yourself to be unhappy until you get what you want.", comment: "The fix isn't fewer desires, it's picking one at a time." }),
    base({ target: "karpathy", created: now - 6 * HR, status: "failed", reason: "Reply box did not open (selector replyButton)", postText: "New lecture: building a tokenizer from scratch.", comment: "The section on merges finally made BPE click for me." }),
  ];
  for (const r of recs) {
    const rec = hist.newRecord(r);
    rec.createdAt = r.created || rec.createdAt;
    delete rec.created;
    await hist.put(rec);
  }
  const today = util.dayKey(now, tz), month = util.monthKey(now, tz);
  const days = {};
  for (let i = 0; i < 10; i++) days[util.dayKey(now - i * DAY, tz)] = Math.round((0.02 + 0.03 * Math.sin(i)) * 1e4) / 1e4 + 0.03;
  days[today] = 0.0412;
  const logs = [
    { ts: now - 40 * MIN, level: "info", msg: "Engine started (review mode)" },
    { ts: now - 35 * MIN, level: "info", msg: "Checked X List: 42 posts, 3 fresh from targets" },
    { ts: now - 34 * MIN, level: "debug", msg: "Gate: waiting between comments", data: "{\"until\":\"14:05\"}" },
    { ts: now - 28 * MIN, level: "warn", msg: "Quality check rejected a comment (generic opener) - regenerating" },
    { ts: now - 15 * MIN, level: "info", msg: "Generated comment for @onchain_anna ($0.0006)" },
    { ts: now - 8 * MIN, level: "info", msg: "Generated comment for @karpathy ($0.0322)" },
    { ts: now - 6 * MIN, level: "error", msg: "Reply box did not open on x.com/karpathy/status/1850... (retry later)" },
    { ts: now - 3 * MIN, level: "info", msg: "Generated comment for @naval ($0.0034)" },
  ];
  const cands = {
    vitalikbuterin: { handle: "vitalikbuterin", name: "vitalik.eth", followers: 5800000, score: { own: 95, flags: [] }, overlap: 3, sources: ["common:naval", "common:balajis", "common:karpathy"], suggestedTier: 1, suggestedGroup: "B", pass: false, why: ["followers above range"] },
    sarah_ml: { handle: "sarah_ml", name: "Sarah | ML eng", followers: 23100, score: { own: 72, flags: [] }, overlap: 2, sources: ["followers:karpathy"], suggestedTier: 2, suggestedGroup: "B", pass: true, why: [] },
    gm_bot_99: { handle: "gm_bot_99", name: "GM GM", followers: 310, score: { own: 9, flags: ["gm_spam", "default_avatar"], bot: true }, overlap: 1, sources: ["followers:naval"], suggestedTier: 2, suggestedGroup: "B", pass: false, why: ["followers below range", "looks like a bot/spam"] },
    rates_rick: { handle: "rates_rick", name: "Rick on Rates", followers: 64200, score: { own: 77, flags: [] }, overlap: 2, sources: ["following:macro_mira"], suggestedTier: 1, suggestedGroup: "A", followsYou: true, pass: false, why: ["already follows you"] },
  };
  const blacklist = {
    old_spammer: { handle: "old_spammer", name: "Old Spammer", reason: "no_followback", at: now - 3 * DAY, days: 14, comments: 6, tier: 2, followers: 5400 },
  };
  await chrome.storage.local.set({
    "sx.targets": targets,
    "sx.logs": logs,
    "sx.candidates": cands,
    "sx.blacklist": blacklist,
    "sx.discovery": { status: "running", source: "followersOf", step: "Reading followers of @karpathy", progress: { done: 0, total: 1 }, found: 0, message: "followers of @karpathy: 64 accounts", startedAt: now - 4 * MIN, finishedAt: null, updatedAt: now },
    "sx.spend": { days, months: { [month]: 0.6342 }, byModelMonth: {} },
    "sx.state": {
      // "paused" keeps the real engine idle during the test (a running state would let its watchdog tick).
      status: "paused", stopReason: null, stopDetail: "", firstStartedAt: now - DAY - 2 * HR, startedAt: now - 40 * MIN,
      lastTickAt: now - 50 * 1000, nextTickAt: now + 3 * MIN, nextCommentAt: now + 6 * MIN, lastCommentAt: now - 20 * MIN, alert: null,
    },
  });
  return { records: recs.length, targets: Object.keys(targets).length };
}

// The newer features (contract "New features"): score sites + their history, smart followers, conversations,
// value / follow-back chance, reply views, a reach alert, X page loads near the cap, the saved live test.
async function seedNew() {
  const hist = await import(chrome.runtime.getURL("lib/history.js"));
  const store = await import(chrome.runtime.getURL("lib/store.js"));
  const now = Date.now(), MIN = 60e3, HR = 36e5, DAY = 864e5;
  const dk = (ts) => new Date(ts).toISOString().slice(0, 10);
  const series = (start, drift, noise) => { const a = []; let v = start; for (let i = 89; i >= 0; i--) { v += drift + Math.sin(i * 1.7) * noise; a.push({ d: dk(now - i * DAY), s: Math.round(v) }); } return a; };
  const sorsaH = series(1050, 2.6, 6), tsH = series(160, 0.6, 2);
  const L = (pairs) => pairs.map(([handle, score]) => ({ handle, name: handle, score, followers: score * 250 }));
  await store.setSecrets({ sorsaKey: "sorsa-test-key-123" }); // Sorsa scores need a key (TwitterScore reads its public page)
  const settings = await store.getSettings();
  settings.providers = { ...(settings.providers || {}), sorsa: { ...((settings.providers || {}).sorsa || {}), enabled: true, mode: "auto", dailyCap: 100 }, twitterscore: { ...((settings.providers || {}).twitterscore || {}), enabled: true, mode: "auto", dailyCap: 300 } };
  settings.safety.maxPageLoads24h = 500;
  await store.saveSettings(settings);
  const fp = {};
  const hour = Math.floor(now / HR);
  for (let i = 0; i < 24; i++) fp[hour - i] = { watch: 12, post: 3, profile: 2, check: 2 }; // 19 an hour = 456 in 24 h (91% of 500; 437 after the next full hour)
  const st = (await chrome.storage.local.get("sx.state"))["sx.state"];
  await chrome.storage.local.set({
    "sx.state": {
      ...st,
      me: { handle: "0x_nation", checkedAt: now - 5 * MIN },
      footprint: fp,
      reach: { checked: 22, medianViews: 12, prevMedianViews: 85, lowShare: 0.64, at: now - 20 * MIN },
      reachAlert: { at: now - 20 * MIN, message: "Median views fell from 85 to 12 compared with the week before.", medianNow: 12, medianBefore: 85, lowShare: 0.64, checked: 22, action: "notify" },
      lastSelfTest: { at: now - 2 * HR, ok: false, stop: null, checks: [
        { id: "account", label: "Logged-in account", ok: true, detail: "@0x_nation" },
        { id: "home", label: "Home timeline", ok: true, detail: "tweet 18 · tweetText 18" },
        { id: "profile", label: "Your profile", ok: true, detail: "profileUserName 1 · tweet 9" },
        { id: "followers", label: "Your followers", ok: false, detail: "40 followers shown but no \"Follows you\" badge" },
      ] },
    },
    "sx.scoreboard": {
      own: {
        sorsa: { score: sorsaH[sorsaH.length - 1].s, max: null, at: now - 3 * HR, url: "https://app.sorsa.io/profile/0x_nation", history: sorsaH },
        twitterscore: { score: tsH[tsH.length - 1].s, max: 1000, at: now - 3 * HR, url: "https://twitterscore.io/twitter/0x_nation/", history: tsH },
      },
      checks: { naval: { at: now - 2 * HR, results: { sorsa: { score: 2410, url: "https://app.sorsa.io/profile/naval" }, twitterscore: { score: 905, max: 1000 } } } },
      smart: {
        cobie: { at: now - 2 * DAY, results: { sorsa: { list: L([["hsaka", 2400], ["blknoiz06", 2140], ["inversebrah", 1880], ["pentosh1", 1620], ["lightcrypto", 1360], ["cryptokaleo", 1100], ["devrel_sam", 900]]), total: 1284, at: now - 2 * DAY }, twitterscore: { list: L([["hsaka", 960], ["pentosh1", 930], ["zz_new", 600]]), total: null, at: now - 2 * DAY } } },
        hsaka: { at: now - 2 * DAY, results: { sorsa: { list: L([["blknoiz06", 2210], ["inversebrah", 1640], ["naval", 2410], ["lightcrypto", 1380], ["cryptokaleo", 1000], ["gm_bot_99", 9]]), total: 903, at: now - 2 * DAY } } },
        zachxbt: { at: now - 4 * DAY, results: { sorsa: { list: L([["hsaka", 2400], ["blknoiz06", 2140], ["inversebrah", 1880], ["pentosh1", 1620], ["lightcrypto", 1360]]), total: 2210, at: now - 4 * DAY }, twitterscore: { list: [], error: "TwitterScore showed a bot check", at: now - 4 * DAY } } },
      },
      usage: { sorsa: { d: dk(now), n: 13 }, twitterscore: { d: dk(now), n: 40 } },
    },
    "sx.conversations": { items: [
      { id: "c1", target: "naval", comment: "History gives you the base rates.", replyUrl: "https://x.com/0x_nation/status/1851000000000000001", authorReplyUrl: "https://x.com/naval/status/1851000000000000002", text: "Good point, the base rates matter more than the stories.", at: now - 40 * MIN, done: false },
      { id: "c2", target: "onchain_anna", comment: "The per-bridge latency column is great.", replyUrl: "https://x.com/0x_nation/status/1851000000000000003", authorReplyUrl: "", text: "Thanks! <b>More columns</b> coming next week.", at: now - 5 * HR, done: false },
      { id: "c3", target: "devrel_sam", comment: "Does it handle $ref across files?", replyUrl: "https://x.com/0x_nation/status/1851000000000000004", authorReplyUrl: "", text: "Yes since v0.3.", at: now - 2 * DAY, done: true },
    ], checkedAt: now - 10 * MIN },
  });
  const t = (await chrome.storage.local.get("sx.targets"))["sx.targets"];
  const sc = (hd, o) => { t[hd].score = { ...t[hd].score, ...o }; };
  sc("naval", { value: 82, propensity: 0.31, why: "Sorsa 2,410 (top 5%) x 31% follow-back chance", parts: { reach: 0.98, engagement: 0.71, activity: 0.86, quality: 0.92 }, providers: { sorsa: { score: 2410, max: null, at: now - DAY }, twitterscore: { score: 905, max: 1000, at: now - DAY } } });
  sc("balajis", { value: 74, propensity: 0.55, why: "TwitterScore 870 x 55% follow-back chance", providers: { sorsa: { score: 1980, max: null, at: now - 9 * DAY }, twitterscore: { score: 870, max: 1000, at: now - DAY } } });
  sc("dwarkesh_sp", { value: 35, propensity: 0.12, why: "ScoreX rank 79 x 12% follow-back chance" });
  sc("onchain_anna", { value: 51, propensity: 0.22, providers: { sorsa: { score: 220, max: null, at: now - DAY } } });
  sc("devrel_sam", { providers: { sorsa: { score: 410, max: null, at: now - DAY }, twitterscore: { score: 300, max: 1000, at: now - DAY } } });
  sc("macro_mira", { providers: { sorsa: { score: 640, max: null, at: now - DAY }, twitterscore: { score: 610, max: 1000, at: now - DAY } } });
  sc("karpathy", { providers: { sorsa: { score: 2650, max: null, at: now - DAY }, twitterscore: { score: 940, max: 1000, at: now - DAY } } });
  await chrome.storage.local.set({ "sx.targets": t });
  const c = (await chrome.storage.local.get("sx.candidates"))["sx.candidates"];
  const sm = (handle, name, followers, s1, s2, k, tier, extra = {}) => ({ handle, name, followers, smart: true, foundAt: now - HR, sources: ["smart follower of @cobie", "smart follower of @hsaka", "smart follower of @zachxbt"].slice(0, k), overlap: k, providerScores: { sorsa: s1, ...(s2 != null ? { twitterscore: s2 } : {}) }, suggestedTier: tier, pass: null, why: [], ...extra });
  Object.assign(c, { blknoiz06: sm("blknoiz06", "Ansem", 720000, 2210, 960, 3, 1), inversebrah: sm("inversebrah", "inversebrah", 310000, 1640, 880, 3, 1), pentosh1: sm("pentosh1", "Pentoshi", 880000, 1910, 930, 2, 1, { followsYou: true }) });
  await chrome.storage.local.set({ "sx.candidates": c });
  let i = 0;
  for (const r of await hist.all()) if (r.status === "posted") { r.results = { ...(r.results || {}), views: [140, 85, 60, 22, 9, 300][i++ % 6] }; await hist.put(r); }
  return true;
}

// ------------------------------------------------------------------ helpers
async function openTab(page, base, route, ready) {
  curRoute = route;
  await page.goto(`${base}dashboard.html#${route}`);
  await page.waitForSelector(`#view[data-ready="${ready || READY[route.split("?")[0]] || route.split("?")[0]}"]`, { timeout: 15000 });
  await page.waitForTimeout(350);
}
async function shot(page, file, fullPage = true) {
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); window.scrollTo(0, 0); });
  await page.waitForTimeout(80);
  await page.screenshot({ path: path.join(OUT, file), fullPage });
}
async function setTheme(page, t) {
  await page.evaluate((v) => window.sxTheme.set(v), t);
  await page.waitForTimeout(120);
}
async function savedSettings(page) {
  return page.evaluate(async () => (await chrome.storage.local.get("sx.settings"))["sx.settings"]);
}
async function waitSaved(page) {
  await page.waitForFunction(() => { const el = document.getElementById("saveInd"); return el && /Saved/.test(el.textContent); }, null, { timeout: 5000 });
}
// Polls chrome.storage until the saved settings satisfy pred (more reliable than the "Saved" indicator,
// which can still show a previous save).
async function waitSetting(page, pred, timeout = 5000) {
  const end = Date.now() + timeout;
  let s = null;
  while (Date.now() < end) {
    s = await savedSettings(page);
    try { if (s && pred(s)) return s; } catch (_) { /* not there yet */ }
    await page.waitForTimeout(100);
  }
  return s;
}
async function storageKey(page, key) {
  return page.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);
}
async function waitStorage(page, key, pred, timeout = 8000) {
  const end = Date.now() + timeout;
  let v = null;
  while (Date.now() < end) {
    v = await storageKey(page, key);
    try { if (pred(v || {})) return v; } catch (_) { /* not there yet */ }
    await page.waitForTimeout(100);
  }
  return v;
}
async function setState(page, patch) {
  await page.evaluate(async (p) => { const st = (await chrome.storage.local.get("sx.state"))["sx.state"]; await chrome.storage.local.set({ "sx.state": { ...st, ...p } }); }, patch);
}
const waitFor = (page, fn, arg, timeout = 5000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
// Leftovers of the removed group A/B model anywhere in the page (including collapsed sections and options).
async function groupLeftovers(page) {
  return page.evaluate(() => (document.body.textContent.match(/\bgroups? [AB]\b/gi) || []).join(", "));
}
async function rowCount(page, sel) { return page.locator(sel).count(); }
async function overflowX(page) { return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); }
async function wideElements(page) {
  return page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && getComputedStyle(e).position !== "fixed").slice(0, 4).map((e) => `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}.${String(e.className && e.className.baseVal != null ? e.className.baseVal : e.className).split(" ").slice(0, 2).join(".")} right=${Math.round(e.getBoundingClientRect().right)}`).join(" | "));
}

// ------------------------------------------------------------------ main
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "scorex-ui-"));
const ctx = await chromium.launchPersistentContext(userDir, {
  channel: "chromium",
  headless: true,
  viewport: { width: 1360, height: 900 },
  args: ["--disable-extensions-except=" + EXT, "--load-extension=" + EXT],
});
await ctx.addInitScript(permStub);

try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 20000 }));
  const extId = new URL(sw.url()).host;
  const base = `chrome-extension://${extId}/ui/`;
  console.log("extension id:", extId);

  const page = await ctx.newPage();
  watch(page, () => "dashboard #" + curRoute);
  await openTab(page, base, "overview");

  console.log("seed");
  const seeded = await page.evaluate(seed);
  check(seeded.records === 14 && seeded.targets === 8, `seeded ${seeded.records} history records and ${seeded.targets} targets`);
  check(await page.evaluate(seedNew), "seeded score sites, smart followers, conversations, reach alert, page loads and the last live test");
  await page.reload();
  await page.waitForSelector('#view[data-ready="overview"]');

  // ---------------------------------------------------------------- every screen, both themes, 3 widths
  await section("screens (light + dark at 1360 / 800 / 560)", async () => {
    const routes = [...SCREENS.map(([r]) => r), "tones", "models", "safety", "diagnostics", "discover?view=find"];
    for (const theme of ["light", "dark"]) {
      await setTheme(page, theme);
      for (const w of [1360, 800, 560]) {
        await page.setViewportSize({ width: w, height: 900 });
        for (const r of routes) {
          await openTab(page, base, r);
          if (w === 1360) {
            const dt = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
            const failedRender = await page.locator("#view >> text=This tab failed to render").count();
            check(dt === theme && failedRender === 0, `${r} renders in ${theme}`);
            if (theme === "light") { const g = await groupLeftovers(page); check(!g, `${r}: no "Group A" / "Group B" text left` + (g ? ` (found: ${g})` : "")); }
          }
          const ov = await overflowX(page);
          check(ov <= 0, `${theme} ${w}px ${r}: no horizontal page scroll` + (ov > 0 ? ` (overflow ${ov}px: ${await wideElements(page)})` : ""));
          await shot(page, `${theme}-${r.replace(/[?=&]/g, "-")}${w === 1360 ? "" : "-" + w}.png`, w !== 560);
        }
      }
    }
    await page.setViewportSize({ width: 1360, height: 900 });
    await setTheme(page, "light");
  });

  // ---------------------------------------------------------------- narrow tables
  await section("narrow tables: key columns stay in view, an ink edge marks hidden columns", async () => {
    const headIn = (sel, col) => page.evaluate(([sel, col]) => {
      const wr = document.querySelector(sel + " .table-wrap"), th = wr && wr.querySelector(`thead th[data-col="${col}"]`);
      return !!th && th.getBoundingClientRect().right <= wr.getBoundingClientRect().right + 1;
    }, [sel, col]);
    await page.setViewportSize({ width: 800, height: 900 });
    await openTab(page, base, "targets");
    check(await headIn("#targetsTable", "follow") && await headIn("#targetsTable", "propensity"), "800px Targets: Follow status and Follows back? are fully in view");
    const edges = await page.evaluate(() => { const cs = getComputedStyle(document.querySelector("#targetsTable .table-wrap")); return [cs.borderLeftColor, cs.borderRightColor]; });
    check(edges[0] !== edges[1], "800px Targets: an ink edge marks the side with more columns (" + edges.join(" / ") + ")");
    check(await page.evaluate(() => { const tr = document.querySelector("#targetsTable tr.is-disabled"); return !!tr && [...tr.cells].every((td) => getComputedStyle(td).opacity === "1") && [...tr.querySelectorAll(".tag")].some((x) => x.textContent === "Off"); }), "a turned-off target row is not dimmed below AA and is tagged Off");
    check(await page.evaluate(() => [...document.querySelectorAll("#targetStatus .ct")].every((el) => getComputedStyle(el).opacity === "1")), "filter counts are drawn at full text colour");
    await page.setViewportSize({ width: 560, height: 900 });
    await openTab(page, base, "history?view=comments");
    check(await headIn("#historyTable", "status"), "560px History › Comments: the Status column is fully in view");
    await page.setViewportSize({ width: 1360, height: 900 });
  });

  // ---------------------------------------------------------------- scopes
  await section("navigation: a screen left mid-render registers nothing in the next one", async () => {
    await openTab(page, base, "overview");
    await page.evaluate(() => {
      const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
      window.__sent = [];
      chrome.runtime.sendMessage = (m, ...r) => { if (m && m.sx && m.sx !== "getStatus") window.__sent.push(m.sx); return orig(m, ...r); };
    });
    // Navigate on the moment the first screen starts rendering (its awaits finish while the next screen is shown).
    const hop = (first, second) => page.evaluate(([first, second]) => new Promise((res) => {
      const v = document.getElementById("view");
      const mo = new MutationObserver(() => { if (v.dataset.tab === first) { mo.disconnect(); location.hash = "#" + second; res(); } });
      mo.observe(v, { attributes: true, attributeFilter: ["data-tab"] });
      location.hash = "#" + first;
    }), [first, second]);
    await hop("scores", "targets");
    await page.waitForSelector('#view[data-ready="targets"]');
    await page.waitForTimeout(1200);
    await page.evaluate(() => { window.__sent.length = 0; location.hash = "#targets?h=dwarkesh_sp"; });
    await waitFor(page, () => !!document.querySelector("#targetDrawer"), null, 5000);
    await page.waitForTimeout(800);
    const sent = await page.evaluate(() => window.__sent.slice());
    check(!sent.includes("scoreCheck") && !sent.includes("smartFollowers"), "Scores left mid-render: opening a target drawer sends no score-site request (sent: " + (sent.join(", ") || "nothing") + ")");
    await page.keyboard.press("Escape");
    await hop("history", "settings");
    await page.waitForSelector('#view[data-ready="settings"]');
    await page.waitForTimeout(1200);
    await page.click("#healthLink");
    check(await waitFor(page, () => !!document.querySelector("#allSettingsLink"), null, 5000), "Results left mid-render: the rail's Health link still opens Settings › Diagnostics");
    // A screen left mid-render never acts on the next screen's params: Scores still loading (a waking worker, held
    // 700 ms here), then #targets?h=... opens the drawer and sends no score check (scoreCheck answered by a stub).
    await openTab(page, base, "overview");
    await page.evaluate(() => {
      const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
      window.__sent = [];
      chrome.runtime.sendMessage = (m, ...r) => {
        if (m && m.sx && m.sx !== "getStatus") window.__sent.push(m.sx + (m.handle ? ":" + m.handle : ""));
        if (m && m.sx === "scoreCheck") return Promise.resolve({ ok: true, handle: m.handle, results: {} });
        if (m && m.sx === "scoresState") return new Promise((res) => setTimeout(() => res(orig(m, ...r)), 700));
        return orig(m, ...r);
      };
    });
    await hop("scores", "targets?h=dwarkesh_sp");
    await page.waitForSelector('#view[data-ready="targets"]');
    await page.waitForTimeout(1500);
    const sent2 = await page.evaluate(() => window.__sent.slice());
    check(!sent2.some((x) => /^(scoreCheck|smartFollowers)/.test(x)), "Scores left mid-render does not act on the next screen's ?h= (sent: " + (sent2.join(", ") || "nothing") + ")");
    await page.keyboard.press("Escape");
  });

  // ---------------------------------------------------------------- shell + rail
  await section("shell: rail, engine bar, aliases, menu sheet", async () => {
    await openTab(page, base, "overview");
    const labels = await page.locator("#nav .tab .tab-label").allInnerTexts();
    check(JSON.stringify(labels) === JSON.stringify(SCREENS.map((x) => x[1])), "rail lists the 7 screens in order: " + labels.join(", "));
    check((await page.locator("#nav .rail-group").allInnerTexts()).join("|").toUpperCase() === "WORK|TRACK|SETUP", "rail groups WORK / TRACK / SETUP");
    check((await page.locator('#nav .tab.active[aria-current="page"] .tab-label').innerText()).trim() === "Today", "active screen is marked with aria-current (Today)");
    check(await waitFor(page, () => document.querySelector('#nav [data-tab="review"] .tab-count')?.textContent === "3", null, 8000), "Review rail item shows a count of 3");
    for (const [r, label] of SCREENS) {
      await page.click(`#nav .tab[data-tab="${r}"]`);
      const ok = await waitFor(page, (x) => !!document.querySelector(`#view[data-ready="${x}"]`), READY[r] || r, 15000);
      curRoute = r;
      check(ok && (await page.locator("#screenTitle").innerText()).trim() === label && (await page.locator(`#nav .tab[data-tab="${r}"]`).getAttribute("aria-current")) === "page", `rail click opens ${label} (#view[data-ready="${r}"], title, aria-current)`);
    }
    await openTab(page, base, "results");
    check((await page.locator("#screenTitle").innerText()).trim() === "History" && (await page.locator("#nav .tab.active").getAttribute("data-tab")) === "history" && (await page.locator('#resultsView [aria-checked="true"]').getAttribute("data-value")) === "ov", "#results (old link) opens History › Stats");
    await openTab(page, base, "comments");
    check((await page.locator("#nav .tab.active").getAttribute("data-tab")) === "history" && (await page.locator("#resultsComments").isVisible()) && (await page.locator("#historyTable").count()) === 1, "#comments (old link) opens History › Comments");
    await openTab(page, base, "history");
    check((await page.locator('#resultsRange [aria-checked="true"]').getAttribute("data-value")) === "all" && (await page.locator('#resultsView [aria-checked="true"]').getAttribute("data-value")) === "comments" && JSON.stringify(await page.locator("#resultsView [data-value]").allInnerTexts()) === JSON.stringify(["Comments", "Stats", "Spend"]), "History opens on Comments, all time (views Comments | Stats | Spend)");
    // Settings: one rail item, four tabs (each its own route).
    for (const [r, label] of SETUP) {
      await openTab(page, base, r);
      const tabs = await page.locator("#setupTabs a").allInnerTexts();
      check(JSON.stringify(tabs) === JSON.stringify(SETUP.map((x) => x[1])) && (await page.locator("#setupTabs a.active").innerText()).trim() === label && (await page.locator("#nav .tab.active").getAttribute("data-tab")) === "settings" && (await page.locator("#screenTitle").innerText()).trim() === "Settings", `#${r}: Settings › ${label} (tabs General | Tone | Models & costs | Safety, rail item Settings)`);
    }
    await page.click('#setupTabs a[data-value="safety"]');
    check(await waitFor(page, () => !!document.querySelector('#view[data-ready="safety"]'), null, 8000) && (await page.locator("#setupTabs a.active").innerText()).trim() === "Safety", "clicking a Settings tab opens it");
    await openTab(page, base, "diagnostics");
    check((await page.locator("#diagnostics").count()) === 1, "#diagnostics opens Settings › Diagnostics");
    await openTab(page, base, "overview");
    check(/Paused/.test(await page.locator("#heroStatus").innerText()) && (await page.locator("#engineBox .status-paused").count()) === 1, "Today + engine bar show Paused (amber)");
    check((await page.locator("#engineBox .btn-primary").count()) === 1 && (await page.locator("#btn-resume.btn-primary").count()) === 1, "one primary engine button: Resume while paused");
    check((await page.locator("#btn-stop").count()) === 1 && !(await page.locator("#btn-stop").isDisabled()), "small Stop button is enabled while paused");
    check((await page.locator("#acctChip").innerText()).includes("@0x_nation"), "account chip shows @0x_nation");
    check(/REVIEW/i.test(await page.locator("#modeTag").innerText()), "mode tag shows REVIEW");
    check(await waitFor(page, () => !!document.querySelector("#riskChip"), null, 6000), "risk chip in the engine bar (status.risk from the worker)");
    const rk = await page.locator("#riskChip").evaluate((el) => ({ cls: el.className, title: el.title, text: el.textContent })).catch(() => ({}));
    check(/risk-(low|medium|high)/.test(rk.cls || "") && /an estimate, not a guarantee/i.test(rk.title || "") && /Risk (low|medium|high)/.test(rk.text || ""), "risk chip: level + 'an estimate, not a guarantee' tooltip (" + (rk.text || "") + ")");
    check(!/warm-?up|unlocks in|first 3 days/i.test(await page.locator("body").innerText()), "no warm-up text on Today");
    // narrow: the rail becomes a sheet behind the Menu button
    await page.setViewportSize({ width: 560, height: 900 });
    await openTab(page, base, "overview");
    check(await page.locator("#menuBtn").isVisible() && !(await page.locator("#rail").isVisible()), "560px: Menu button shown, rail hidden");
    await page.click("#menuBtn");
    await page.waitForTimeout(250);
    check(await page.locator("#rail").isVisible() && (await page.evaluate(() => document.activeElement && document.activeElement.closest("#rail") != null)), "Menu opens the rail as a sheet with focus inside");
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(OUT, "light-menu-560.png") });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    check((await page.locator("#app.menu-open").count()) === 0 && (await page.evaluate(() => document.activeElement && document.activeElement.id)) === "menuBtn", "Esc closes the sheet and focus returns to Menu");
    await page.click("#menuBtn");
    await page.waitForTimeout(200);
    await page.click('#nav [data-tab="targets"]');
    check(await waitFor(page, () => !!document.querySelector('#view[data-ready="targets"]'), null, 8000) && (await page.locator("#app.menu-open").count()) === 0, "choosing a screen in the sheet opens it and closes the sheet");
    await page.setViewportSize({ width: 1360, height: 900 });
  });

  // ---------------------------------------------------------------- Today
  const stepDone = async (k) => ((await page.locator(`#setupChecklist [data-step="${k}"]`).getAttribute("class")) || "").includes("is-done");
  await section("today", async () => {
    await openTab(page, base, "overview");
    check(await waitFor(page, () => /No OpenAI API key/.test(document.getElementById("healthLink")?.title || ""), null, 6000) && /problem/.test(await page.locator("#healthLink").innerText()), "rail health reports the missing OpenAI key (no \"Health: OK\" before a key is saved)");
    check(!(await page.locator('#modeSwitch [data-value="auto"]').isDisabled()), "Full auto is selectable right away");
    await page.click('#modeSwitch [data-value="auto"]');
    check(await waitFor(page, () => !!document.querySelector(".modal-fullauto #faConfirmBtn")), "Full auto opens the confirm dialog");
    const fa = await page.locator(".modal-fullauto").innerText();
    check(/per 24 h/.test(fa) && /per account/.test(fa), "the confirm lists the Full-auto limits");
    check((await savedSettings(page)).mode === "review", "nothing is saved before confirming");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    check((await savedSettings(page)).mode === "review" && (await page.locator('#modeSwitch [data-value="review"]').getAttribute("aria-checked")) === "true", "cancelling the confirm keeps Review");
    await page.click('#modeSwitch [data-value="auto"]');
    await page.click("#faConfirmBtn");
    const sa = await waitSetting(page, (x) => x.mode === "auto");
    check(sa && sa.mode === "auto" && await waitFor(page, () => document.querySelector('#modeSwitch [data-value="auto"]')?.getAttribute("aria-checked") === "true"), "confirming saves settings.mode = auto");
    check(await waitFor(page, () => /auto/i.test(document.querySelector("#modeTag .mode-tag")?.textContent || ""), null, 1000), "the engine bar shows AUTO at once (it does not wait for the 5 s status poll)");
    await page.click('#modeSwitch [data-value="review"]');
    check((await waitSetting(page, (x) => x.mode === "review")).mode === "review", "switching back to Review saves settings.mode = review (no confirm)");
    check(await waitFor(page, () => /review/i.test(document.querySelector("#modeTag .mode-tag")?.textContent || ""), null, 1000), "the engine bar shows REVIEW at once");

    check(await page.locator("#setupChecklist").isVisible(), "setup stepper is shown while setup is incomplete");
    const steps = await page.locator("#setupChecklist [data-step]").evaluateAll((els) => els.map((e) => e.dataset.step + (e.classList.contains("is-done") ? "+" : "-")));
    check(JSON.stringify(steps) === JSON.stringify(["key-", "handle-", "targets+", "start+", "tone-", "budget-", "score+"]), "stepper: key, handle open; targets, start done; tone, budget optional; score site done: " + steps.join(" "));
    check(/Setup 3 of 7/.test(await page.locator("#setupChecklist .checklist-count").innerText()), "stepper counts Setup 3 of 7");
    check((await page.locator('#setupChecklist [data-step="examples"]').count()) === 0 && /Tone/.test(await page.locator('#setupChecklist [data-step="tone"]').textContent()), "a Tone prompt step and no comment-samples step");
    check((await page.locator('#setupChecklist [data-step-panel="key"] #setupKey').count()) === 1, "the first open step (API key) starts expanded");
    await page.click('#setupChecklist [data-step="handle"] .st-btn');
    await page.click('#setupChecklist [data-step-panel="handle"] button:has-text("Confirm")');
    check(await waitFor(page, () => document.querySelector('#setupChecklist [data-step="handle"]')?.classList.contains("is-done")), "confirming the X handle ticks its step");

    check((await page.locator("#pendingCount").innerText()).trim() === "3", "waiting-for-review count is 3");
    check((await page.locator("#reviewPreview .pv").count()) === 3 && (await page.locator("#reviewPreview .pv .expiry").count()) === 3, "review preview lists 3 pending comments with expiry chips");
    const dis = await page.locator("#reviewPreview .pv").evaluateAll((els) => els.map((e) => [e.querySelector("button")?.disabled, !!e.querySelector(".pv-note")]));
    check(dis.some((d) => d[0] && d[1]) && dis.some((d) => !d[0] && !d[1]), "Approve is disabled with a note for the account that follows you now");
    const pvFoot = await page.locator(".pv-foot").innerText();
    check(/1 approved, posting after you resume/.test(pvFoot) && /1 approved will not post/.test(pvFoot), "while paused: approved replies post after you resume; the one to an account that follows you is counted apart: " + pvFoot);
    check((await page.locator("#activityLog .log").count()) === 6, "recent activity shows the last 6 lines");
    await page.click("#fullLogBtn");
    check((await page.locator("#activityLog .log").count()) > 6, "Full log shows the rest");
    check(await page.locator("#runNowBtn").isDisabled(), "Run a check now is disabled while the engine is not running");
    await waitFor(page, () => document.getElementById("figActive")?.textContent === "3", null, 8000);
    const figs = await page.evaluate(() => ["figActive", "figChecking", "figFollowedBack", "figFollows"].map((id) => document.getElementById(id)?.textContent));
    check(JSON.stringify(figs) === JSON.stringify(["3", "1", "1", "2"]), "follow figures from getStatus: commenting on 3, checking 1, followed back 1, follow you 2 (" + figs.join(", ") + ")");
    check((await page.locator("#weekFigures .figure").count()) === 4 && /Sorsa score/i.test(await page.locator("#weekFigures").innerText()), "This week: 4 figures including the main score site (Sorsa)");
    check((await page.locator("#weekFigures svg[aria-label]").count()) >= 3, "This week sparklines are drawn with text alternatives");
    check(!/Group [AB]/.test(await page.locator("#weekFigures").innerText()) && (await page.locator("#reviewPreview .badge-group-a, #reviewPreview .badge-group-b").count()) === 0, "no group figures or group badges on Today");

    // Needs you: reach alert, replies waiting, page loads
    check((await page.locator("#reachBanner").count()) === 1 && /proxy/.test(await page.locator("#reachBanner").innerText()) && /85/.test(await page.locator("#reachBanner").innerText()), "reach banner (state.reachAlert) with the numbers and the views caveat");
    await openTab(page, base, "safety");
    check((await page.locator("#safetyReachBanner").count()) === 1 && /proxy/.test(await page.locator("#safetyReachBanner").innerText()), "the same reach banner is at the top of Safety");
    await openTab(page, base, "overview");
    await page.click("#reachDismissBtn");
    check(!!(await waitStorage(page, "sx.state", (v) => !v.reachAlert)) && await waitFor(page, () => !document.querySelector("#reachBanner")), "Dismiss sends reachDismiss: state.reachAlert cleared, banner gone");
    check((await page.locator('#needsList [data-need="conv:c1"]').count()) === 1 && (await page.locator('#needsList [data-need="conv:c2"]').count()) === 1 && (await page.locator('#needsList [data-need="conv:c3"]').count()) === 0, "replies waiting for you: the 2 open conversations (not the done one)");
    check(/@naval replied/.test(await page.locator('#needsList [data-need="conv:c1"]').innerText()) && (await page.locator('#needsList [data-need="conv:c2"] b').count()) === 0 && /<b>More columns<\/b>/.test(await page.locator('#needsList [data-need="conv:c2"]').innerText()), "the author's reply is shown as plain text");
    const hrefs = await page.locator('#needsList a[target="_blank"]').evaluateAll((els) => els.map((a) => a.href));
    check(hrefs.length > 0 && hrefs.every((u) => /^https:\/\/(x|twitter)\.com\//.test(u)) && hrefs.includes("https://x.com/naval/status/1851000000000000002"), "Open on X opens the author's reply on x.com");
    await page.click('#needsList [data-need="conv:c1"] button:has-text("Mark done")');
    const done1 = await waitStorage(page, "sx.conversations", (v) => (v.items.find((x) => x.id === "c1") || {}).done === true);
    check(done1 && (done1.items.find((x) => x.id === "c1") || {}).done === true && await waitFor(page, () => !document.querySelector('#needsList [data-need="conv:c1"]')), "Mark done sends conversationDone and the item leaves the list");
    await page.click(".toast .toast-act");
    const undone = await waitStorage(page, "sx.conversations", (v) => (v.items.find((x) => x.id === "c1") || {}).done === false);
    check(undone && (undone.items.find((x) => x.id === "c1") || {}).done === false, "Undo sends conversationDone { done: false }");
    check(await waitFor(page, () => !!document.querySelector('#needsList [data-need="footprint"]'), null, 6000) && /(456|437) of 500/.test(await page.locator('#needsList [data-need="footprint"]').innerText()), "Needs you warns above 80% of the X page-load cap (456 of 500)");
    check((await page.locator('#needsList [data-need^="near:"]').count()) >= 1, "a target near its give-up day is listed");
    await shot(page, "light-overview-needs.png");
  });

  // ---------------------------------------------------------------- Targets
  await section("targets", async () => {
    await openTab(page, base, "targets");
    check((await rowCount(page, "#targetsTable tbody tr[data-key]")) === 8, "targets table has 8 rows");
    await page.fill("#targetSearch", "naval");
    check(await waitFor(page, () => document.querySelectorAll("#targetsTable tbody tr[data-key]").length === 1, null, 3000), "target search filters the table");
    await page.fill("#targetSearch", "");
    await waitFor(page, () => document.querySelectorAll("#targetsTable tbody tr[data-key]").length === 8, null, 3000);
    const heads = (await page.locator("#targetsTable thead th").allTextContents()).map((x) => x.replace(/[▲▼]/g, "").trim()).filter(Boolean);
    check(heads.includes("Follow status") && !heads.some((x) => /^(Group|Follows you)$/.test(x)), "one Follow status column (no Group or Follows you columns): " + heads.join(" | "));
    check(["Value", "Follows back?", "Sorsa"].every((x) => heads.includes(x)) && !heads.includes("TwitterScore"), "Value, Follows back? and the main score site's column (other sites in the Columns menu)");
    const fsCounts = await page.evaluate(() => { const c = {}; for (const el of document.querySelectorAll("#targetsTable tbody [data-fs]")) c[el.dataset.fs] = (c[el.dataset.fs] || 0) + 1; return c; });
    check(fsCounts.checking === 1 && fsCounts.active === 3 && fsCounts.follows === 2 && fsCounts.followed_back === 1 && fsCounts.gone === 1, "follow status column: 1 Checking, 3 Not following, 2 Follows you, 1 Followed back, 1 Not found: " + JSON.stringify(fsCounts));
    const rowFs = async (hd) => page.locator(`#targetsTable tr[data-key="${hd}"] .fs`).first().textContent();
    check((await page.locator('#targetsTable tr[data-key="naval"] .fs-days').textContent()) === "day 6/14", "Not following shows day 6/14 (counting from day 1 / give-up days)");
    check((await page.locator('#targetsTable tr[data-key="balajis"] .fs-days.is-near').textContent()) === "day 13/14", "close to the give-up day the counter is highlighted (day 13/14)");
    check((await page.locator('#targetsTable tr[data-key="karpathy"] .fs-days').textContent()) === "day 1/14", "first comment today shows day 1/14");
    check((await page.locator('#targetsTable tr[data-key="dwarkesh_sp"] .fs-days').count()) === 0 && /^Checking/.test(await rowFs("dwarkesh_sp")), "an unchecked target shows Checking without a day counter");
    check(/^Followed back/.test(await rowFs("devrel_sam")) && (await page.locator('#targetsTable tr[data-key="devrel_sam"] .fs .fs-extra').count()) === 1, "a follow-back shows Followed back with its date");
    check(/^Follows you/.test(await rowFs("macro_mira")) && /never commented/.test(await page.locator('#targetsTable tr[data-key="macro_mira"] .fs').getAttribute("title")), "an account that already follows you shows Follows you (never commented on)");
    check(/^Not found/.test(await rowFs("quiet_quant")), "a profile that was not found shows Not found");
    check((await page.locator('#targetsTable tr[data-key="naval"] .tg-value').getAttribute("title")) === "Sorsa 2,410 (top 5%) x 31% follow-back chance" && /82/.test(await page.locator('#targetsTable tr[data-key="naval"] .tg-value').textContent()), "Value column: 82 with the why as tooltip (target.score.value / why)");
    const props = await page.evaluate(() => Object.fromEntries(["naval", "balajis", "dwarkesh_sp", "macro_mira"].map((hd) => [hd, document.querySelector(`#targetsTable tr[data-key="${hd}"] td[data-col="propensity"]`)?.textContent])));
    check(props.naval === "Sometimes" && props.balajis === "Often" && props.dwarkesh_sp === "Rarely" && props.macro_mira === "?", "Follows back? chips from target.score.propensity: " + JSON.stringify(props));
    check((await page.locator("#highValueBtn .ct").textContent()) === "2", "High value chip counts value >= 70 (2)");
    await page.click("#highValueBtn");
    check((await rowCount(page, "#targetsTable tbody tr[data-key]")) === 2 && (await page.getAttribute("#highValueBtn", "aria-pressed")) === "true", "High value filter shows 2 rows");
    await page.click("#highValueBtn");
    const sum = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#targetsSummary [data-sum], #blacklistViewBtn[data-sum]")].map((el) => [el.dataset.sum, el.querySelector(".summary-num")?.textContent])));
    check(sum.total === "8" && sum.checking === "1" && sum.active === "3" && sum.follows === "2" && sum.followed_back === "1" && sum.gone === "1" && sum.off === "1" && sum.blacklisted === "1", "status counts: 8 targets, 1 checking, 3 not following, 2 follow you, 1 followed back, 1 not found, 1 off, 1 blacklisted: " + JSON.stringify(sum));
    for (const [v, n] of [["follows", 2], ["active", 3], ["followed_back", 1], ["checking", 1], ["total", 8]]) {
      await page.click(`#targetStatus [data-value="${v}"]`);
      await waitFor(page, (x) => document.querySelectorAll("#targetsTable tbody tr[data-key]").length === x, n, 3000);
      check((await rowCount(page, "#targetsTable tbody tr[data-key]")) === n, `status chip "${v}" shows ${n} rows`);
    }
    check((await page.locator("#targetStatus [data-value]").allTextContents()).every((x) => !/group/i.test(x)), "status chips replace the group filter");

    // drawer: row click, J/K, Esc, deep link
    await page.click('#targetsTable tr[data-key="naval"] td[data-col="followers"]');
    check(await waitFor(page, () => !!document.querySelector("#targetDrawer"), null, 3000) && /[?&]h=naval/.test(await page.evaluate(() => location.hash)), "a row click opens the target drawer and sets #targets?h=naval");
    await page.waitForTimeout(300);
    const dtext = await page.locator("#targetDrawer").innerText();
    check(/PROFILE/i.test(dtext) && /SCORES/i.test(dtext) && /FOLLOW TIMELINE/i.test(dtext) && /day 6 of 14/.test(dtext) && /2,410/.test(dtext) && /Value\s*82/.test(dtext), "drawer: profile, scores (Sorsa 2,410, value 82), follow timeline, day 6 of 14");
    check(/weights: reach 40 · engagement 25 · activity 20 · quality 15/.test(dtext), "drawer: the fixed rank numbers are labelled as weights");
    await shot(page, "light-targets-drawer.png", false);
    const order = await page.evaluate(() => [...document.querySelectorAll("#targetsTable tbody tr[data-key]")].map((tr) => tr.dataset.key));
    await page.locator("#targetDrawer .drawer-close").focus();
    await page.keyboard.press("j");
    await page.waitForTimeout(200);
    const nextH = order[order.indexOf("naval") + 1];
    check((await page.evaluate(() => location.hash)).includes("h=" + nextH) && (await page.locator(".tg-dw-line .handle").textContent()).includes(nextH), `J moves to the next target (@${nextH})`);
    await page.keyboard.press("k");
    await page.waitForTimeout(200);
    check((await page.locator(".tg-dw-line .handle").textContent()).includes("naval"), "K moves back (@naval)");
    await page.keyboard.press("Escape");
    check(await waitFor(page, () => !document.querySelector("#targetDrawer"), null, 3000) && !(await page.evaluate(() => location.hash)).includes("h="), "Esc closes the drawer and clears h");
    check(await page.evaluate(() => document.activeElement && document.activeElement.closest("tr") && document.activeElement.closest("tr").dataset.key === "naval"), "focus returns to the row");
    await openTab(page, base, "targets?h=balajis", "targets");
    check(await waitFor(page, () => !!document.querySelector("#targetDrawer"), null, 3000) && (await page.locator(".tg-dw-line .handle").textContent()).includes("balajis"), "#targets?h=balajis opens the drawer");
    await setTheme(page, "dark");
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(OUT, "dark-targets-drawer.png") });
    await setTheme(page, "light");
    await page.keyboard.press("Escape");
    await waitFor(page, () => !document.querySelector("#targetDrawer"), null, 3000);

    // bulk bar
    await page.locator('#targetsTable tr[data-key="naval"] td.col-check input').check();
    check(await page.locator("#bulkBar").isVisible() && (await page.locator('#bulkBar select[aria-label="Set group for selected"]').count()) === 0 && (await page.locator("#bulkRecheckBtn").count()) === 1 && (await page.locator("#bulkBlacklistBtn").count()) === 1, "bulk bar: no Set group; Re-check follow status and Blacklist present");
    await page.click("#bulkClearBtn");
    check(await page.locator("#bulkBar").isHidden(), "Clear selection hides the bulk bar");

    // Add targets sheet
    await page.click("#addTargetsBtn");
    await page.waitForSelector("#addTargetsSheet #addHandles");
    check((await page.locator("#addGroup").count()) === 0 && (await page.locator("#addTier").count()) === 1, "Add targets sheet has a Tier select and no Group select");
    await page.click("#addTargetsSubmit");
    check(await waitFor(page, () => !!document.querySelector(".toast-warn"), null, 3000), "empty Add shows a warning toast");
    await page.fill("#addHandles", "@new_target_x\nhttps://x.com/another_one");
    check(/Add 2 accounts/.test(await page.locator("#addTargetsSubmit").textContent()), "the Add button counts the recognised handles");
    await page.click("#addTargetsSubmit");
    check(await waitFor(page, () => document.querySelectorAll("#targetsTable tbody tr[data-key]").length === 10, null, 8000), "targetsUpsert through the worker adds 2 targets and the table live-updates (10 rows)");
    check((await page.locator("#addTargetsSheet").count()) === 0, "the sheet closes after adding");
    check((await page.locator('#targetsTable tr[data-key="new_target_x"] [data-fs="checking"]').count()) === 1 && (await page.locator('#targetsTable tr[data-key="another_one"] [data-fs="checking"]').count()) === 1, "new targets start as Checking");
    await page.click("#addTargetsBtn");
    await page.waitForSelector("#addTargetsSheet #addHandles");
    await page.fill("#addHandles", "@old_spammer");
    await page.click("#addTargetsSubmit");
    check(await waitFor(page, () => [...document.querySelectorAll(".toast")].some((t) => /1 skipped \(blacklisted\)/.test(t.textContent)), null, 8000), "adding a blacklisted handle is skipped and the toast says so");
    check((await rowCount(page, "#targetsTable tbody tr[data-key]")) === 10, "the blacklisted handle was not added (still 10 rows)");
    await page.keyboard.press("Escape");
    await waitFor(page, () => !document.querySelector("#addTargetsSheet"), null, 3000);

    // blacklist through the real worker
    await page.locator('#targetsTable tr[data-key="another_one"] td.col-check input').check();
    await page.click("#bulkBlacklistBtn");
    await page.click(".modal-footer .btn-danger");
    check(await waitFor(page, () => document.querySelectorAll("#targetsTable tbody tr[data-key]").length === 9, null, 8000), "bulk Blacklist removes the row");
    let bl = await waitStorage(page, "sx.blacklist", (v) => v.another_one);
    check(bl && bl.another_one && bl.another_one.reason === "manual" && !(await storageKey(page, "sx.targets")).another_one, "blacklistAdd through the worker moves @another_one from the targets to the blacklist");
    await page.click("#blacklistViewBtn");
    await waitFor(page, () => document.querySelectorAll("#blacklistTable tbody tr[data-key]").length === 2, null, 5000);
    check((await page.evaluate(() => location.hash)).includes("view=blacklist") && await page.locator("#blacklistTable").isVisible() && await page.locator("#targetsTable").isHidden(), "Blacklist opens #targets?view=blacklist");
    const blText = await page.locator("#blacklistTable").innerText();
    check((await rowCount(page, "#blacklistTable tbody tr[data-key]")) === 2 && /old_spammer/.test(blText) && /No follow-back after 14 days/.test(blText) && /Added by you/.test(blText), "Blacklist lists the seeded entry (no follow-back after 14 days) and the new one (added by you)");
    check(/2 accounts ScoreX never adds again/.test(await page.locator("#blacklistCount").innerText()) && (await page.locator('#blacklistViewBtn[data-sum="blacklisted"] .summary-num').textContent()) === "2", "Blacklist count line and the Blacklist button count 2");
    check(await page.locator("#blacklistRemoveBtn").isDisabled(), "Remove from blacklist is disabled until a row is selected");
    await page.locator('#blacklistTable tr[data-key="old_spammer"] td.col-check input').check();
    await page.click("#blacklistRemoveBtn");
    await waitFor(page, () => document.querySelectorAll("#blacklistTable tbody tr[data-key]").length === 1, null, 8000);
    bl = await waitStorage(page, "sx.blacklist", (v) => !v.old_spammer);
    check(bl && !bl.old_spammer && bl.another_one && (await rowCount(page, "#blacklistTable tbody tr[data-key]")) === 1, "Remove from blacklist (blacklistRemove through the worker) removes @old_spammer");
    await page.fill("#blacklistText", "@spam_bot_1, https://x.com/spam_bot_2");
    await page.click("#blacklistAddBtn");
    bl = await waitStorage(page, "sx.blacklist", (v) => v.spam_bot_1 && v.spam_bot_2);
    await waitFor(page, () => document.querySelectorAll("#blacklistTable tbody tr[data-key]").length === 3, null, 5000);
    check(bl && bl.spam_bot_1 && bl.spam_bot_2 && (await rowCount(page, "#blacklistTable tbody tr[data-key]")) === 3, "Add to blacklist from the text box adds 2 handles");
    await shot(page, "light-targets-blacklist.png");
    await page.click("#blacklistBackBtn");
    check(!(await page.evaluate(() => location.hash)).includes("view=") && await page.locator("#targetsTable").isVisible(), "Back returns to all targets");

    // follow rules sheet
    await page.click("#editRulesBtn");
    await page.waitForSelector("#rulesSheet #giveUpDays");
    const giveUp = page.locator("#giveUpDays");
    await giveUp.fill("21");
    await giveUp.press("Tab");
    let fs1 = await waitSetting(page, (x) => x.follow.giveUpDays === 21);
    check(fs1 && fs1.follow.giveUpDays === 21, "Remove after N days saves settings.follow.giveUpDays = 21");
    check(await waitFor(page, () => document.querySelector('#targetsTable tr[data-key="naval"] .fs-days')?.textContent === "day 6/21", null, 3000), "the day counter follows the setting (day 6/21)");
    await giveUp.fill("200");
    await giveUp.press("Tab");
    fs1 = await waitSetting(page, (x) => x.follow.giveUpDays === 90);
    check(fs1 && fs1.follow.giveUpDays === 90 && (await giveUp.inputValue()) === "90", "give-up days 200 is clamped to 90");
    await giveUp.fill("14");
    await giveUp.press("Tab");
    await waitSetting(page, (x) => x.follow.giveUpDays === 14);
    await page.click('label[for="followBlacklist"]');
    fs1 = await waitSetting(page, (x) => x.follow.blacklist === false);
    check(fs1 && fs1.follow.blacklist === false, "\"Add removed accounts to the blacklist\" toggle saves settings.follow.blacklist = false");
    await page.click('label[for="followBlacklist"]');
    await waitSetting(page, (x) => x.follow.blacklist === true);
    await page.click('label[for="followAutoRemove"]');
    fs1 = await waitSetting(page, (x) => x.follow.autoRemove === false);
    await page.waitForTimeout(200);
    check(fs1 && fs1.follow.autoRemove === false && (await page.locator("#giveUpDays").isDisabled()) && (await page.locator("#followBlacklist").isDisabled()), "turning auto-remove off saves follow.autoRemove = false and disables the dependent fields");
    await page.click('label[for="followAutoRemove"]');
    fs1 = await waitSetting(page, (x) => x.follow.autoRemove === true);
    await page.waitForTimeout(200);
    check(fs1 && fs1.follow.autoRemove === true && !(await page.locator("#giveUpDays").isDisabled()), "turning auto-remove back on re-enables them");
    await page.locator("#followRecheckHours").fill("5");
    await page.locator("#followRecheckHours").press("Tab");
    fs1 = await waitSetting(page, (x) => x.follow.recheckHours === 12);
    check(fs1 && fs1.follow.recheckHours === 12 && fs1.follow.scanEveryHours === 2 && fs1.follow.checksPerRun === 10, "Follow checks: re-check hours 5 is clamped to 12 (scan every 2 h, 10 checks per run unchanged)");
    check(/Follows you/.test(await page.locator("#followHow").innerText()), "the rules explain how follow detection works");
    check((await page.locator("#rulesSheet #useValue").count()) === 1, "the rules hold the score-aware ranking switch (targeting.useValue)");
    await page.keyboard.press("Escape");
    await waitFor(page, () => !document.querySelector("#rulesSheet"), null, 3000);
  });

  // ---------------------------------------------------------------- Discover
  await section("discover", async () => {
    // The database tab: paste, Scan, download - and nothing else in the way.
    await openTab(page, base, "discover?view=db");
    await page.waitForTimeout(300);
    check(JSON.stringify(await page.locator("#discView [data-value]").allInnerTexts()) === JSON.stringify(["Smart follower database", "Find targets"]) && (await page.locator("#discDbPane").isVisible()) && !(await page.locator("#discFindPane").isVisible()), "Discover has two tabs; the database tab shows only the database tool");
    check((await page.locator("#smartDb #sdbHandles").isVisible()) && (await page.locator("#sdbScanBtn").isVisible()) && (await page.locator("#sdbCsv").isVisible()) && (await page.locator("#sdbXlsx").isVisible()), "database tool: the box for usernames or links, Scan, Download CSV / Excel");
    check(/empty/i.test(await page.locator("#sdbTable").textContent()) && (await page.locator("#sdbSelBar button").count()) === 0, "an empty database says how to start; no selection buttons until rows are selected");
    await page.click("#sdbCsv");
    check(await waitFor(page, () => [...document.querySelectorAll(".toast")].some((t) => /Nothing to download/.test(t.textContent)), null, 4000), "Download with an empty database explains there is nothing yet");
    await page.click("#sdbScanBtn");
    check(await waitFor(page, () => [...document.querySelectorAll(".toast")].some((t) => /Paste at least one username/.test(t.textContent)), null, 4000), "Scan with an empty box asks for a username or link");
    await page.click('#discView [data-value="find"]');
    check(await waitFor(page, () => !document.getElementById("discFindPane").hidden && document.getElementById("discDbPane").hidden, null, 4000) && /view=find/.test(page.url()), "Find targets tab (kept in the URL)");
    await openTab(page, base, "discover");
    check(await page.locator("#discFindPane").isVisible(), "Discover reopens on the tab used last");
    await openTab(page, base, "discover?view=find");
    await page.waitForTimeout(300);
    check((await page.locator("#discSource [data-value]").count()) === 5 && (await page.locator('#discSource [data-value="myFollowers"]').count()) === 0, "5 discovery sources, no \"My followers\"");
    check((await page.locator("#swept .swept-block").count()) === 3 && /of 1,284 shown/.test(await page.locator('#swept .swept-block[data-handle="cobie"]').textContent()), "Big accounts swept: a block per seeded sx.scoreboard.smart account (cobie: N of 1,284 shown)");
    check((await page.locator("#swept .barcell").count()) >= 10, "smart-follower scores drawn as bars in the cells");
    const avail = (await page.locator("#discAvail").textContent()).trim();
    check(/Sorsa/.test(avail) && /TwitterScore/.test(avail) && /left|allow access/i.test(avail), "availability line names each enabled site and what it needs: " + avail);
    check((await rowCount(page, "#candidatesTable tbody tr[data-key]")) >= 7, "candidates table lists the seeded candidates (" + (await rowCount(page, "#candidatesTable tbody tr[data-key]")) + ")");
    const ch = (await page.locator("#candidatesTable thead th").allTextContents()).map((x) => x.replace(/[▲▼]/g, "").trim());
    check(ch.some((x) => /Sorsa/.test(x)) && /2,210/.test(await page.locator('#candidatesTable tr[data-key="blknoiz06"]').textContent()), "candidates show the score-site columns (Sorsa 2,210)");
    check((await page.locator('#candidatesTable tr[data-key="blknoiz06"] .dots').count()) === 1, "overlap dots for an account listed by several big accounts");
    check(/follows you/.test(await page.locator('#candidatesTable tr[data-key="rates_rick"]').textContent()), "a candidate that follows you is marked \"follows you\"");
    check((await page.locator("#candAddBtn").count()) === 1 && (await page.locator('#view button:has-text("Add to group")').count()) === 0, "one Add to targets button (no Add to group A/B)");
    await page.click('#discSource [data-value="followersOf"]');
    check(/followers of @karpathy: 64 accounts/.test(await page.locator("#discProgress").textContent()) && await page.locator("#discMax").isVisible(), "X sources: discovery progress from sx.discovery and the max-accounts field");
    // Smart followers of one account: the tier picked for "Add N as Tier X" survives sx.scoreboard writes.
    await openTab(page, base, "discover?h=cobie");
    check(await page.locator("#discFindPane").isVisible(), "#discover?h= opens Find targets");
    if (await waitFor(page, () => !!document.querySelector("#smartLookup .look-merged select"), null, 8000)) {
      await page.locator("#smartLookup .look-merged select").selectOption("1");
      await page.evaluate(async () => { const b = (await chrome.storage.local.get("sx.scoreboard"))["sx.scoreboard"]; await chrome.storage.local.set({ "sx.scoreboard": { ...b, touchedAt: Date.now() } }); });
      await page.waitForTimeout(600);
      check((await page.locator("#smartLookup .look-merged select").inputValue()) === "1", "Smart followers: the chosen tier survives a background sx.scoreboard write");
    } else check(false, "Smart followers of @cobie: the merged list is shown");
  });

  // ---------------------------------------------------------------- Scores
  await section("scores", async () => {
    await openTab(page, base, "scores");
    await page.waitForTimeout(400);
    check((await page.locator("#myScores .pcell").count()) === 4 && (await page.locator("#myScores .pcell.off").count()) === 2, "My scores: a cell per score site, 2 not connected");
    const sorsa = page.locator('#myScores .pcell[data-provider="sorsa"]');
    const own = await page.evaluate(async () => (await chrome.storage.local.get("sx.scoreboard"))["sx.scoreboard"].own);
    check(/Sorsa/.test(await page.locator("#myScores .pcell").first().textContent()) && (await sorsa.textContent()).includes(own.sorsa.score.toLocaleString("en-US")), "Sorsa cell first, with the seeded score " + own.sorsa.score.toLocaleString("en-US"));
    check((await sorsa.locator("svg").count()) >= 1 && /7d/.test(await sorsa.textContent()) && /Significant|Credible|Supreme|Noted|Influential|Notable|Rising/.test(await sorsa.textContent()), "Sorsa cell: tier label, 7d change and a sparkline");
    check((await page.locator('#myScores .pcell[data-provider="twitterscore"] .pmeter').count()) === 1 && (await sorsa.locator(".pmeter").count()) === 0, "a meter only for the site with a maximum (TwitterScore 1000)");
    check((await page.locator("#scoreHistory svg").count()) >= 1 && (await page.locator("#scoreHistory .legend-btn").count()) === 2, "score history chart with a legend toggle per site");
    await page.locator('#scoreHistory [data-value="30"]').click();
    await page.waitForTimeout(200);
    check((await page.locator("#scoreHistory rect.mark-signal").count()) >= 1, "follow-back ticks on the score history (30 d)");
    check((await page.locator("#scoreHistory svg[aria-label], #scoreHistory svg title").count()) >= 1, "the score history has a text alternative");
    check((await rowCount(page, "#followBacksTable tbody tr")) >= 1, "Follow-backs that count lists the seeded follow-back");
    check((await page.locator("#targetScores .cover-bar").count()) === 2, "target score coverage bar per enabled site");
    // enabling a site asks Chrome for access first (stubbed prompt)
    await page.evaluate(() => { document.getElementById("providersSetup").open = true; localStorage.removeItem("sx.test.permLog"); localStorage.setItem("sx.test.perm", "deny"); });
    check((await page.locator("#providersSetup .prow").count()) === 4 && (await page.locator("#sorsaEnabled").count()) === 1 && (await page.locator("#sorsaKeyField").count()) === 1 && (await page.locator("#sorsaTestBtn").count()) === 1, "a setup row per site; Sorsa keeps #sorsaEnabled, #sorsaKeyField, #sorsaTestBtn");
    await page.locator('label[for="ethosEnabled"]').click();
    check(await waitFor(page, () => [...document.querySelectorAll(".toast")].some((t) => /Ethos stays off/.test(t.textContent)), null, 5000), "denied permission: the toast explains Ethos stays off");
    const log = await page.evaluate(() => JSON.parse(localStorage.getItem("sx.test.permLog") || "[]"));
    check(log.length === 1 && JSON.stringify(log[0]).includes("ethos"), "enabling Ethos calls chrome.permissions.request with its origins: " + JSON.stringify(log[0] || null));
    check(!(((await savedSettings(page)).providers || {}).ethos || {}).enabled && !(await page.locator("#ethosEnabled").isChecked()), "denied: providers.ethos stays off and the switch goes back off");
    await page.evaluate(() => localStorage.setItem("sx.test.perm", "grant"));
    await page.locator('label[for="ethosEnabled"]').click();
    const on = await waitSetting(page, (x) => x.providers.ethos && x.providers.ethos.enabled === true);
    check(on && on.providers.ethos && on.providers.ethos.enabled === true, "granted: enabling Ethos saves providers.ethos.enabled = true after the request");
    await page.waitForTimeout(600);
    await page.evaluate(() => { const d = document.getElementById("providersSetup"); if (d) d.open = true; });
    await page.locator('label[for="ethosEnabled"]').click();
    const off = await waitSetting(page, (x) => x.providers.ethos && x.providers.ethos.enabled === false);
    check(off && off.providers.ethos.enabled === false, "turning Ethos off saves providers.ethos.enabled = false");
    await page.evaluate(() => { localStorage.removeItem("sx.test.perm"); const d = document.getElementById("providersSetup"); if (d) d.open = false; });
    // After a site refused (bot check) your score is asked again 20 h later: the header does not promise the next
    // 4-hourly alarm, which the worker skips. Chrome's host grant is stubbed on the scoresState answer; the board is
    // put back afterwards.
    const board0 = await storageKey(page, "sx.scoreboard");
    const errorAt = Date.now() - 36e5;
    await page.evaluate(async (errorAt) => {
      const b = (await chrome.storage.local.get("sx.scoreboard"))["sx.scoreboard"];
      for (const id of Object.keys(b.own || {})) b.own[id] = { ...b.own[id], at: Date.now() - 3 * 864e5, error: "Blocked by the site's bot check", errorCode: "blocked", errorAt };
      await chrome.storage.local.set({ "sx.scoreboard": b });
    }, errorAt);
    await openTab(page, base, "overview");
    await page.evaluate(() => {
      const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = async (m, ...r) => {
        const res = await orig(m, ...r);
        if (m && m.sx === "scoresState" && res && Array.isArray(res.providers)) for (const p of res.providers) if (p.enabled) p.granted = true;
        return res;
      };
      location.hash = "#scores";
    });
    await page.waitForSelector('#view[data-ready="scores"]');
    await waitFor(page, () => /next /.test(document.getElementById("scoresRefreshInfo")?.textContent || ""), null, 8000);
    const nx = await page.evaluate(async (errorAt) => {
      const C = await import(chrome.runtime.getURL("ui/components.js"));
      const info = document.getElementById("scoresRefreshInfo")?.textContent || "";
      const a = await chrome.alarms.get("sx.scores");
      let t = errorAt + 20 * 36e5;
      if (a && a.scheduledTime) { let x = a.scheduledTime; const period = (a.periodInMinutes || 240) * 60000; while (x < t && period > 0) x += period; t = x; }
      const fmt = (x) => (x - Date.now() < 20 * 36e5 ? C.fmtTime(x) : C.fmtDay(x) + " " + C.fmtTime(x));
      return { info, want: fmt(t), skipped: a && a.scheduledTime ? fmt(a.scheduledTime) : null };
    }, errorAt);
    check(nx.info.includes(`(next ${nx.want})`) && (!nx.skipped || nx.skipped === nx.want || !nx.info.includes(`(next ${nx.skipped})`)), `after a site refused, the next own-score refresh is promised 20 h later (want ${nx.want}): ${nx.info.trim()}`);
    await page.evaluate(async (b) => { await chrome.storage.local.set({ "sx.scoreboard": b }); }, board0);
  });

  // ---------------------------------------------------------------- Review
  await section("review", async () => {
    await openTab(page, base, "review");
    await page.waitForSelector("#pendingList .review-card");
    check((await page.locator("#pendingList .review-card").count()) === 3, "review queue shows 3 pending cards");
    check((await page.locator("#waitingList .review-card").count()) === 2, "approved/queued section shows 2 cards");
    const wl = await page.locator("#waitingList").innerText();
    check(/Posts after you resume/.test(wl) && !/Posts around/.test(wl), "while paused, approved replies say they post after you resume (no posting time is promised)");
    check(/follows you now, so this reply will be dropped/.test(wl) && /Will not post/.test(wl), "an approved reply to an account that follows you now says it will be dropped");
    // ...and so does one to a target you turn off in Targets (the engine skips it too); its card is redrawn at once.
    const setEnabled = (hd, on) => page.evaluate(async ([hd, on]) => { const t = (await chrome.storage.local.get("sx.targets"))["sx.targets"]; t[hd].enabled = on; await chrome.storage.local.set({ "sx.targets": t }); }, [hd, on]);
    const cardSays = (re) => waitFor(page, (src) => { const c = [...document.querySelectorAll("#waitingList .review-card")].find((e) => /@balajis/.test(e.textContent)); return !!c && new RegExp(src).test(c.textContent); }, re.source, 6000);
    await setEnabled("balajis", false);
    check(await cardSays(/Will not post[\s\S]*turned off in Targets, so this reply will be dropped|turned off in Targets, so this reply will be dropped[\s\S]*Will not post/), "an approved reply to a target you turned off says it will not post");
    await setEnabled("balajis", true);
    check(await cardSays(/^(?![\s\S]*Will not post)/), "turned on again, the reply waits for its slot again");
    await page.waitForTimeout(500); // let the redraws of these target changes settle before the keyboard checks
    const metas = await page.locator("#pendingList .rc-foot-meta").allInnerTexts();
    check(metas.some((m) => /effort \w+/.test(m) && /(Human \(fast\)|High quality|Balanced|Cheap) preset/.test(m)), "card meta names the reasoning effort and the preset: " + (metas[0] || "").replace(/\s+/g, " "));
    check((await page.locator("#pendingList .review-card.is-focus").count()) === 1 && (await page.locator("#pendingList .expiry").count()) === 3, "one focused card; every card shows when it expires");
    const fol = page.locator("#pendingList .review-card.is-follows");
    check((await fol.count()) === 1 && (await fol.first().locator('[data-ctl="approve"]').isDisabled()) && /follows you now/.test(await fol.first().innerText()), "the reply to an account that follows you now has Approve disabled with a note");
    const focused = () => page.locator("#pendingList .review-card.is-focus").getAttribute("data-id");
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    const f0 = await focused();
    await page.keyboard.press("j");
    const f1 = await focused();
    check(f0 && f1 && f0 !== f1, "J moves to the next card");
    await page.keyboard.press("k");
    check((await focused()) === f0, "K moves back");
    await page.keyboard.press("?");
    check((await page.locator(".sheet-help").count()) === 1, "? opens the keyboard help");
    await page.keyboard.press("Escape");
    check(await waitFor(page, () => !document.querySelector(".sheet-help"), null, 2000), "Esc closes the help");
    const ids = await page.locator("#pendingList .review-card:not(.is-follows)").evaluateAll((els) => els.map((e) => e.dataset.id));
    const card = page.locator(`#pendingList .review-card[data-id="${ids[0]}"]`);
    await card.locator("textarea").fill("Short edit.");
    check(/^11 \/ 280$/.test((await card.locator(".char-count").innerText()).trim()), "live character count updates");
    await card.locator("textarea").press("Escape");
    check(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains("review-card")), "Esc leaves the text box to the card");
    await page.keyboard.press("a");
    const held = await waitFor(page, () => !!document.querySelector("#pendingList .review-undo"), null, 3000);
    check(held && /Undo \(Z\)/.test(await page.locator("#pendingList .review-undo").innerText()) && (await page.locator("#pendingList .review-card").count()) === 2, "A approves the focused card and holds it 5 s with Undo (Z)");
    await page.keyboard.press("z");
    check(await waitFor(page, () => document.querySelectorAll("#pendingList .review-card").length === 3 && !document.querySelector("#pendingList .review-undo"), null, 3000), "Z undoes the approve");
    check((await page.locator(`#pendingList .review-card[data-id="${ids[0]}"] textarea`).inputValue()) === "Short edit.", "the edit survives the undo");
    await page.click('#nav .tab[data-tab="targets"]');
    await page.waitForSelector('#view[data-ready="targets"]');
    await page.click('#nav .tab[data-tab="review"]');
    await page.waitForSelector(`#view[data-ready="review"] #pendingList .review-card[data-id="${ids[0]}"]`);
    check((await page.locator(`#pendingList .review-card[data-id="${ids[0]}"] textarea`).inputValue()) === "Short edit." && (await page.locator(`#pendingList .review-card.is-dirty[data-id="${ids[0]}"]`).count()) === 1, "an unsaved edit survives leaving Review and coming back");
    await page.locator(`#pendingList .review-card[data-id="${ids[1]}"] .post-text`).click();
    await page.keyboard.press("s");
    check(await waitFor(page, () => !!document.querySelector("#pendingList .review-undo.is-skip"), null, 3000), "S skips the focused card (held with Undo)");
    await page.keyboard.press("z");
    check(await waitFor(page, () => document.querySelectorAll("#pendingList .review-card").length === 3, null, 3000), "Z undoes the skip");
    // Regenerate (a paid call) stays busy when a live update rebuilds its card, and when you leave Review and come
    // back: a second press sends nothing. The worker's answer is held 6 s by a stub (the sandbox has no OpenAI access).
    await page.evaluate(() => {
      const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
      window.__regenN = 0;
      window.__restoreSend = () => { chrome.runtime.sendMessage = orig; };
      chrome.runtime.sendMessage = (m, ...r) => (m && m.sx === "reviewAction" && m.action === "regenerate"
        ? (window.__regenN++, new Promise((res) => setTimeout(() => res({ ok: false, error: "held by the test" }), 6000)))
        : orig(m, ...r));
    });
    const rsel = `#pendingList .review-card[data-id="${ids[1]}"]`;
    const rtarget = await page.evaluate(async (id) => (await (await import("/lib/history.js")).get(id)).target, ids[1]);
    const comments0 = await page.evaluate(async (hd) => ((((await chrome.storage.local.get("sx.targets"))["sx.targets"] || {})[hd] || {}).stats || {}).comments || 0, rtarget);
    const setComments = (n) => page.evaluate(async ([hd, n]) => { const t = (await chrome.storage.local.get("sx.targets"))["sx.targets"]; t[hd].stats = { ...(t[hd].stats || {}), comments: n }; await chrome.storage.local.set({ "sx.targets": t }); }, [rtarget, n]);
    await page.click(`${rsel} [data-ctl="regen"]`);
    await setComments(comments0 + 1); // the engine updates the target meanwhile: the card is rebuilt
    await page.waitForTimeout(900);
    const stillBusy = (await page.locator(`${rsel} [data-ctl="regen"]`).isDisabled()) && (await page.locator(`${rsel}.is-regenerating`).count()) === 1;
    await page.locator(rsel).focus();
    await page.keyboard.press("r");
    check(stillBusy && (await page.evaluate(() => window.__regenN)) === 1, "Regenerate stays busy across a live redraw of its card; pressing R again sends nothing");
    await page.click('#nav .tab[data-tab="targets"]');
    await page.waitForSelector('#view[data-ready="targets"]');
    await page.click('#nav .tab[data-tab="review"]');
    await page.waitForSelector(`#view[data-ready="review"] ${rsel}`);
    const busyBack = (await page.locator(`${rsel} [data-ctl="regen"]`).isDisabled()) && (await page.locator(`${rsel}.is-regenerating`).count()) === 1;
    await page.locator(rsel).focus();
    await page.keyboard.press("r");
    check(busyBack && (await page.evaluate(() => window.__regenN)) === 1, "Regenerate stays busy after leaving Review and coming back; pressing R again sends nothing");
    check(await waitFor(page, (sel) => !document.querySelector(sel + ".is-regenerating") && !document.querySelector(sel + ' [data-ctl="regen"]').disabled, rsel, 9000), "Regenerate is available again once the answer is in");
    await page.evaluate(() => window.__restoreSend());
    await setComments(comments0);
    await page.waitForTimeout(500);
    await page.click("#approveAllBtn");
    await page.waitForSelector("#approveEditsBtn");
    const btns = await page.locator(".modal-footer button").allInnerTexts();
    check(btns.map((x) => x.trim()).join("|") === "Cancel|Approve originals|Approve with my edits", "Approve all with an unsaved edit asks: " + btns.join(" | "));
    await page.waitForTimeout(350);
    await shot(page, "light-review-approveall.png", false);
    await page.click("#approveEditsBtn");
    check(await waitFor(page, () => document.querySelectorAll("#pendingList .review-card").length === 1 && document.querySelectorAll("#pendingList .review-card.is-follows").length === 1, null, 8000), "Approve with my edits approves everything except the follows-you reply");
    const stored = await page.evaluate(async (id) => { const h = await import(chrome.runtime.getURL("lib/history.js")); const r = await h.get(id); return [r.status, r.comment]; }, ids[0]);
    check(stored[0] === "approved" && stored[1] === "Short edit.", "the edited card is approved with the edited text (" + stored.join(" / ") + ")");
    check(await waitFor(page, () => document.querySelectorAll("#waitingList .review-card").length === 4, null, 8000), "approved cards move to Approved, waiting to post (4)");
    check((await page.locator("#waitingList .comment-input").evaluateAll((els) => els.map((e) => e.value))).includes("Short edit.") && /Posts (around \d\d:\d\d|in the next free slot|after you resume|after you press Start)/.test(await page.locator("#waitingList").innerText()), "waiting cards keep the edited text and say when they post");
    // An unsaved edit of a reply that is then approved elsewhere as written (Today's preview) is not shown on its
    // approved card: the card shows the text that will be posted. The extra record is removed afterwards.
    await page.evaluate(async () => {
      const hist = await import(chrome.runtime.getURL("lib/history.js"));
      const now = Date.now();
      const rec = hist.newRecord({ target: "naval", targetName: "Naval", tier: 1, postId: "1850000000000000777", postUrl: "https://x.com/naval/status/1850000000000000777", postText: "Read history, not business books.", postCreatedAt: now - 5 * 60e3, comment: "History gives you the base rates.", originalComment: "History gives you the base rates.", status: "pending_review", mode: "review", preset: "balanced", calls: [] });
      rec.id = "rec_smoke_draft";
      await hist.put(rec);
    });
    const dsel = '.review-card[data-id="rec_smoke_draft"]';
    await page.click('#nav .tab[data-tab="overview"]');
    await page.waitForSelector('#view[data-ready="overview"]');
    await page.click('#nav .tab[data-tab="review"]');
    await page.waitForSelector(`#view[data-ready="review"] #pendingList ${dsel}`);
    await page.locator(`#pendingList ${dsel} textarea`).fill("History gives you the base rates. Especially for crypto.");
    await page.click('#nav .tab[data-tab="overview"]');
    await page.waitForSelector('#view[data-ready="overview"] #reviewPreview .pv[data-id="rec_smoke_draft"]');
    await page.click('#reviewPreview .pv[data-id="rec_smoke_draft"] .li-actions button');
    const apr = await waitFor(page, async () => (await (await import(chrome.runtime.getURL("lib/history.js"))).get("rec_smoke_draft")).status === "approved", null, 8000);
    await page.click('#nav .tab[data-tab="review"]');
    await page.waitForSelector(`#view[data-ready="review"] #waitingList ${dsel}`);
    const shownDraft = await page.locator(`#waitingList ${dsel} textarea`).inputValue();
    check(apr && shownDraft === "History gives you the base rates.", `a reply approved in Today as written shows that text on its approved card, not the unsaved Review edit (card: "${shownDraft}")`);
    await page.evaluate(async () => (await import(chrome.runtime.getURL("lib/history.js"))).remove("rec_smoke_draft"));
  });

  // ---------------------------------------------------------------- History › Stats / Comments
  await section("history", async () => {
    await openTab(page, base, "history?view=ov&r=30");
    check((await page.locator("#screenTitle").innerText()).trim() === "History", "History › Stats");
    check((await page.locator("#resultsOverview:not([hidden]) #resFunnel svg.funnel").count()) === 1, "Overview draws the follow-back funnel");
    check((await page.locator("#resDaily svg").count()) >= 2 && (await page.locator("#resDaily svg.heatmap").count()) === 1, "Every day: daily bars and the 12-week follow-back heatmap");
    check((await page.locator("#resViews").count()) === 1 && /proxy/.test(await page.locator("#resViews").innerText()) && (await page.locator("#resViews svg").count()) >= 1, "Views per reply chart (results.views) with the caveat");
    const noAlt = await page.evaluate(() => [...document.querySelectorAll('#resultsOverview svg[role="img"]')].filter((s) => !s.getAttribute("aria-label")).length);
    check(noAlt === 0, "every chart on the Overview has a text alternative");
    const fl = (await page.locator("#resFunnel svg.funnel").getAttribute("aria-label")) || "";
    const fv = (fl.match(/: \d+/g) || []).map((x) => Number(x.slice(2)));
    check(fv.length === 5 && fv.every((v, i) => !i || v <= fv[i - 1]), "the follow-back funnel narrows at every stage: " + fl);
    const ax = (await page.locator("#resDaily svg.chart:not(.heatmap) text.axis").allTextContents()).filter((x) => /^\d+$/.test(x));
    check(ax.length >= 1 && new Set(ax).size === ax.length, "Every day: the y-axis labels are distinct whole numbers (" + ax.join(", ") + ")");
    await page.click('#resultsRange [data-value="all"]');
    await page.click('#resultsView [data-value="comments"]');
    check(/view=comments/.test(page.url()) && await waitFor(page, () => document.getElementById("historyCount")?.textContent === "14"), "Comments lists the 14 records (view kept in the URL)");
    await page.selectOption("#hStatus", "posted");
    check(await waitFor(page, () => document.getElementById("historyCount")?.textContent === "6"), "status filter (posted = 6)");
    await page.selectOption("#hStatus", "");
    await waitFor(page, () => document.getElementById("historyCount")?.textContent === "14");
    check((await page.locator("#hGroup").count()) === 0 && !(await page.locator("#historyTable thead th").allInnerTexts()).some((x) => /^\s*Group\s*$/.test(x)), "no Group filter or column");
    const heads = await page.locator("#historyTable thead th").allInnerTexts();
    check(["Date", "Target", "Post", "Comment", "Status", "Outcome"].every((x) => heads.some((y) => new RegExp(x, "i").test(y))), "Comments columns: Date, Target, Post, Comment, Status, Outcome");
    await page.locator("#historyTable tbody tr").first().click();
    check(await waitFor(page, () => !!document.querySelector("#historyDrawer")), "a Comments row opens the details drawer");
    await page.keyboard.press("Escape");
    check(await waitFor(page, () => !document.querySelector("#historyDrawer")), "Esc closes the details drawer");
    check(/posted comments are always kept/i.test(await page.locator("#retentionText").textContent()), "history retention sentence under Comments");
    const clr = await page.locator('details[data-adv="history.clear"]').textContent();
    check(!/empties the review queue/i.test(clr) && /open review queue/i.test(clr), "Clear history says the open review queue is kept (as the worker does)");
    await shot(page, "light-results-comments.png", false);
  });

  // ---------------------------------------------------------------- Tone
  await section("tone prompt", async () => {
    await openTab(page, base, "tones");
    const DEF_TONE = await page.evaluate(async () => (await import("/lib/store.js")).DEFAULT_TONE_PROMPT);
    check((await page.locator("#tonePrompt").inputValue()) === DEF_TONE, "Tone prompt textarea shows the default Tone prompt");
    check(await page.locator("#toneResetBtn").isDisabled(), "Reset to default is disabled while the default is in use");
    check((await page.locator("#styleExamples, #newExample, #exProgress, #groupTones, #addExampleBtn").count()) === 0 && !/style examples|paste 5|new example|custom text for this group/i.test(await page.locator("#view").textContent()), "no comment samples UI and no group tones on Tone");
    check((await page.locator("#tryIt #tryText").count()) === 1 && (await page.locator("#tryBtn").count()) === 1, "Try it block (sample reply, never posted)");
    await page.fill("#tryText", "https://x.com/naval/status/123");
    await page.click("#tryBtn");
    check(/not its link/.test(await page.locator("#tryResult").innerText()), "Try it asks for the post text, not its link");
    check((await page.locator("#learnEditsToggle").count()) === 1 && /Edit rate this week: (\d+ of \d+|no posted replies yet)/.test(await page.locator("#editRate").innerText()), "Learn from my edits switch + edit rate: " + (await page.locator("#editRate").innerText()).trim());
    const myTone = "Dry, precise and a little contrarian. Lowercase. One concrete number when the post has data.";
    await page.fill("#tonePrompt", myTone);
    await page.locator("#tonePrompt").press("Tab");
    let ts1 = await waitSetting(page, (x) => x.prompt.tone === myTone);
    check(ts1 && ts1.prompt.tone === myTone && !("styleExamples" in ts1.prompt), "editing the Tone prompt saves settings.prompt.tone (no styleExamples key)");
    check(!(await page.locator("#toneResetBtn").isDisabled()) && (await page.locator("#toneCount").innerText()).trim() === `${myTone.length} / 6000`, "Reset is enabled for a custom Tone prompt and the counter shows its length");
    check((await page.locator("#abTones .chip").count()) === 10 && /Tones to test against your Tone prompt/.test(await page.locator('details[data-adv="tones.ab"]').textContent()), "A/B testing: one tone list (10 built-in tones: the 5 UniqueFarm voices and 5 ScoreX tones) tested against the Tone prompt");
    check(/Best comments per prompt/.test(await page.locator('details[data-adv="tones.advanced"]').textContent()) && (await page.locator("#autoStyleToggle").count()) === 1, "Advanced: learn from my best comments (automatic style references)");
    await page.reload();
    await page.waitForSelector('#view[data-ready="tones"]');
    check((await page.locator("#tonePrompt").inputValue()) === myTone, "the Tone prompt persists after reload");
    await shot(page, "light-tones-custom.png");
    await openTab(page, base, "overview");
    check(await stepDone("tone"), "stepper: the Tone prompt step is done once it differs from the default");
    await openTab(page, base, "tones");
    await page.click("#toneResetBtn");
    await page.click(".modal-footer .btn-primary");
    ts1 = await waitSetting(page, (x) => x.prompt.tone === DEF_TONE);
    await waitFor(page, (d) => document.getElementById("tonePrompt")?.value === d, DEF_TONE, 3000);
    check(ts1 && ts1.prompt.tone === DEF_TONE && (await page.locator("#tonePrompt").inputValue()) === DEF_TONE, "Reset to default restores the default Tone prompt");
    await page.fill("#tonePrompt", "");
    await page.locator("#tonePrompt").press("Tab");
    ts1 = await waitSetting(page, (x) => x.prompt.tone === DEF_TONE);
    check(ts1 && ts1.prompt.tone === DEF_TONE && (await page.locator("#tonePrompt").inputValue()) === DEF_TONE, "an empty Tone prompt falls back to the default");
  });

  // ---------------------------------------------------------------- Safety
  await section("safety: persist + clamp, risk, page loads, reach monitor", async () => {
    await openTab(page, base, "safety");
    await page.getByLabel("Gap between comments maximum").fill("45");
    await page.getByLabel("Gap between comments maximum").press("Tab");
    await waitSaved(page);
    await page.getByLabel("Week 1", { exact: true }).fill("999");
    await page.getByLabel("Week 1", { exact: true }).press("Tab");
    await waitSaved(page);
    check((await page.getByLabel("Week 1", { exact: true }).inputValue()) === "300", "ramp 999 is clamped to the hard cap 300 right away");
    await page.reload();
    await page.waitForSelector('#view[data-ready="safety"]');
    check((await page.getByLabel("Gap between comments maximum").inputValue()) === "45", "gap max 45 persisted after reload");
    check((await page.getByLabel("Week 1", { exact: true }).inputValue()) === "300", "ramp week 1 persisted as 300 after reload");
    const st = await savedSettings(page);
    check(st && st.safety.ramp[0] === 300 && st.safety.gapMin.max === 45, "chrome.storage has ramp[0]=300 and gapMin.max=45");
    await page.getByLabel("Gap between comments minimum").fill("1");
    await page.getByLabel("Gap between comments minimum").press("Tab");
    await waitSaved(page);
    check((await page.getByLabel("Gap between comments minimum").inputValue()) === "2", "gap min 1 is clamped to the hard minimum 2");
    check(await waitFor(page, () => /\d/.test(document.getElementById("riskReport")?.textContent || ""), null, 6000) && /estimate, not a guarantee/i.test(await page.locator("#riskReport").innerText()), "risk report (status.risk) labelled as an estimate");
    // 437 once the clock passes a full hour after seeding: the oldest seeded hour leaves the 24 h window.
    check(await waitFor(page, () => /456|437/.test(document.getElementById("footprint")?.textContent || ""), null, 6000) && (await page.locator("#footprint svg.minibars rect").count()) === 24, "X page loads (24 h): 456 from status.footprint with 24 hourly bars");
    check((await page.locator("#maxPageLoads").inputValue()) === "500", "page-load cap field shows settings.safety.maxPageLoads24h (500)");
    check(/median 12 views \(week before: 85\)/.test(await page.locator("#reachStatus").innerText()), "reach monitor status from status.reach: " + (await page.locator("#reachStatus").innerText()).trim());
    await page.selectOption("#reachAction", "halve");
    check((await waitSetting(page, (x) => x.safety.reach.action === "halve")).safety.reach.action === "halve", "reach monitor action select saves safety.reach.action");
    check((await page.locator("#adaptiveAfter").count()) === 1 && (await page.locator("#adaptiveMax").count()) === 1, "adaptive watch fields (Advanced)");
    check(!/warm-?up/i.test(await page.locator("#view").textContent()), "no warm-up on Safety");
  });

  // ---------------------------------------------------------------- Settings + Diagnostics
  await section("settings + diagnostics", async () => {
    await openTab(page, base, "settings");
    await waitFor(page, () => !/Checking/.test(document.getElementById("diagSummary")?.textContent || "Checking"), null, 6000);
    check((await page.locator("#view .sec").first().getAttribute("id")) === "diagnostics", "Diagnostics is the first section of Settings");
    check(/\d+ warnings?, \d+ failures?/.test(await page.locator("#diagSummary").innerText()), "quick check summary: " + (await page.locator("#diagSummary").innerText()).trim());
    check((await page.locator("#convEnabled").count()) === 1 && (await page.locator("#convEvery").count()) === 1, "conversation alert fields (learning.conversations)");
    check(!/warm-?up/i.test(await page.locator("#view").textContent()), "no warm-up on Settings");
    await page.evaluate(() => { const d = document.querySelector('details[data-adv="settings.general"]'); if (d) d.open = true; });
    await page.selectOption("#settingsMode", "auto");
    await page.waitForSelector("#faConfirmBtn");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    check((await page.locator("#settingsMode").inputValue()) === "review" && (await savedSettings(page)).mode === "review", "Settings mode select: cancelling the Full-auto confirm keeps Review");
    await page.evaluate(() => { const d = document.querySelector('details[data-adv="settings.general"]'); if (d) d.open = false; });
    // Import JSON: a backup made in Full auto names the switch and runs the Full-auto confirm; Cancel keeps Review.
    const bk = path.join(os.tmpdir(), `scorex-import-${process.pid}.json`);
    fs.writeFileSync(bk, JSON.stringify({ app: "ScoreX", kind: "settings", settings: { ...(await savedSettings(page)), mode: "auto" } }));
    await page.setInputFiles("#importDataFile", bk);
    await page.waitForSelector(".modal-overlay .modal");
    check(/Full auto/.test(await page.locator(".modal-overlay .modal").innerText()), "Import JSON: the confirm says the backup would switch to Full auto");
    await page.locator(".modal-overlay .modal .btn-primary").click();
    check(await waitFor(page, () => !!document.querySelector(".modal-fullauto #faConfirmBtn"), null, 4000), "Import JSON: the Full-auto confirm runs before the import");
    await page.keyboard.press("Escape");
    check(await waitFor(page, () => [...document.querySelectorAll(".toast")].some((t) => /Imported/.test(t.textContent)), null, 6000) && (await savedSettings(page)).mode === "review" && /review/i.test(await page.locator("#modeTag").innerText()), "Import JSON: Cancel imports the rest and keeps Review");
    fs.rmSync(bk, { force: true });
    await openTab(page, base, "diagnostics");
    await waitFor(page, () => !/Checking/.test(document.getElementById("diagSummary")?.textContent || "Checking"), null, 6000);
    const ids = await page.locator("#diagList .dg").evaluateAll((els) => els.map((e) => e.dataset.check));
    check(["handle", "me", "badge", "hosts", "notifications", "openai", "budget", "tick", "lease", "storage", "version"].every((x) => ids.includes(x)), "#diagnostics lists every quick check: " + ids.join(","));
    check(/of 10 MB/.test(await page.locator('#diagList [data-check="storage"]').innerText()), "storage used vs 10 MB");
    check((await page.locator("#diagLive .dg").count()) === 4 && (await page.locator("#diagLive .dg .st-fail").count()) === 1 && (await page.locator("#diagLive .dg .st-pass").count()) === 3, "the last live X test (state.lastSelfTest) is listed with status squares");
    await shot(page, "light-diagnostics.png");
    // A live test stopped by Pause/Stop is not kept as the last live test: the last complete one stays shown, also
    // after a reload. The worker's answer is stubbed with the shape runSelfTest returns on a stop; the X handle the
    // test needs is set for this check and put back afterwards.
    const handle0 = ((await savedSettings(page)).account || {}).handle || "";
    const setHandle = (hd) => page.evaluate(async (hd) => { const store = await import(chrome.runtime.getURL("lib/store.js")); const s = await store.getSettings(); await store.saveSettings({ ...s, account: { ...s.account, handle: hd } }); }, hd);
    await setHandle("0x_nation");
    await openTab(page, base, "diagnostics");
    await page.evaluate(() => {
      const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (m, ...r) => (m && m.sx === "selfTest" ? Promise.resolve({ ok: false, aborted: true, error: "Stopped by Pause/Stop before the test finished", checks: [], at: Date.now() }) : orig(m, ...r));
    });
    await page.click("#diagLiveBtn");
    check(await waitFor(page, () => [...document.querySelectorAll(".toast")].some((t) => /stopped by Pause\/Stop/i.test(t.textContent)), null, 5000), "a live X test stopped by Pause/Stop says so");
    await openTab(page, base, "diagnostics");
    const liveRows = await page.locator("#diagLive .dg").allInnerTexts();
    check(liveRows.length === 4 && !liveRows.some((x) => /Stopped by Pause/.test(x)), `after a reload the last complete live test is still shown, not the stopped run (${liveRows.length} rows)`);
    // After a captcha stop the live test asks first (it would load X pages before you looked at your account);
    // Cancel sends nothing. An "X page changed" stop runs it without asking (the stop itself recommends the test).
    await setState(page, { status: "stopped", stopReason: "captcha", stopDetail: "Arkose challenge", alert: { reason: "captcha", detail: "Arkose challenge", at: Date.now() - 60000 } });
    await openTab(page, base, "diagnostics");
    await page.evaluate(() => {
      window.__selfTests = 0;
      const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (m, ...r) => (m && m.sx === "selfTest" ? (window.__selfTests++, Promise.resolve({ ok: false, aborted: true, error: "Stopped by Pause/Stop before the test finished", checks: [], at: Date.now() })) : orig(m, ...r));
    });
    await page.click("#diagLiveBtn");
    const asked = await waitFor(page, () => !!document.querySelector(".modal-overlay .modal"), null, 4000);
    const askText = asked ? await page.locator(".modal-overlay .modal").innerText() : "";
    check(/stopped for safety/i.test(askText) && /Check your account on x\.com first/.test(askText), "after a captcha stop the live X test asks before loading X pages");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    check((await page.evaluate(() => window.__selfTests)) === 0, "cancelling that question runs no live test");
    await setState(page, { status: "stopped", stopReason: "dom_changed", stopDetail: "No posts rendered", alert: { reason: "dom_changed", detail: "No posts rendered", at: Date.now() - 60000 } });
    await page.waitForTimeout(300);
    await page.click("#diagLiveBtn");
    check(await waitFor(page, () => window.__selfTests === 1, null, 4000), "after an 'X page changed' stop the live X test runs without asking (the stop recommends it)");
    await setState(page, { status: "paused", stopReason: null, stopDetail: "", alert: null });
    await setHandle(handle0);
  });

  // ---------------------------------------------------------------- Models
  await section("models: API key masking, cost estimator, preset per tier", async () => {
    await openTab(page, base, "models");
    await page.fill("#openaiKeyField input[type=password]", FAKE_KEY);
    await page.click("#openaiKeyField button:has-text('Save')");
    await page.waitForSelector("#openaiKeyField .masked-key", { timeout: 5000 });
    check((await page.locator("#openaiKeyField .masked-key").innerText()).trim() === "sk-…WXYZ", "key shown masked as sk-…WXYZ");
    check(!(await page.content()).includes(FAKE_KEY), "full key is not in the page DOM");
    check((await page.locator("#openaiKeyField button:has-text('Replace')").count()) === 1 && (await page.locator("#openaiKeyField button:has-text('Remove')").count()) === 1, "Replace and Remove buttons shown");
    const sec = await page.evaluate(async () => (await import("/lib/store.js")).getSecrets());
    check(sec && sec.openaiKey === FAKE_KEY, "key stored (extension IndexedDB)");
    const leaked = await page.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
    check(!leaked.includes(FAKE_KEY), "key is not in chrome.storage (content scripts on x.com cannot read it)");
    check(await waitFor(page, () => !/No OpenAI API key/.test(document.getElementById("healthLink")?.title || "x"), null, 6000), "once a key is saved, the rail health no longer reports it missing");
    await page.reload();
    await page.waitForSelector('#view[data-ready="models"]');
    await page.waitForSelector("#openaiKeyField .masked-key", { timeout: 5000 });
    check(!(await page.content()).includes(FAKE_KEY), "still masked after reload");
    const before = await page.locator("#estimateText").innerText();
    await page.fill("#estPerDay", "25");
    await page.waitForFunction(() => /^25 comments per day/.test(document.getElementById("estimateText")?.textContent || ""), null, { timeout: 3000 });
    const after = await page.locator("#estimateText").innerText();
    check(after !== before && /25 comments per day on .+ \(.+\) will cost about \$[\d.]+ per day and \$[\d.]+ per month/.test(after), "estimator sentence updates: " + after);
    await page.getByLabel("Monthly budget (USD)").fill("5");
    await page.getByLabel("Monthly budget (USD)").press("Tab");
    await waitSaved(page);
    check(/of \$5\.00/.test(await page.locator("#budgetStatus").innerText()), "budget status shows spend of $5.00");
    await shot(page, "light-models-after.png");
    const mrows = await page.locator("#presetMatrix tbody tr").allInnerTexts();
    check(mrows.length === 2 && /Tier 1 · big influencer/.test(mrows[0]) && /Tier 2 · smart account/.test(mrows[1]), "Models: preset per tier has 2 rows (tier 1, tier 2)");
    await page.getByLabel("Preset for tier 1").selectOption("cheap");
    const ms = await waitSetting(page, (x) => x.presetMatrix.B1 === "cheap");
    check(ms && ms.presetMatrix.B1 === "cheap" && ms.presetMatrix.B2 === "human", "tier 1 preset saves presetMatrix.B1 (tier 2 stays on the default Human preset)");
    await page.getByLabel("Preset for tier 1").selectOption("high");
    await waitSetting(page, (x) => x.presetMatrix.B1 === "high");
    check((await page.locator('#spendReportsLink[href="#history?view=spend"]').count()) === 1, "Models links to History › Spend for the reports");
  });

  // ---------------------------------------------------------------- theme
  await section("theme menu", async () => {
    await page.click("#themeBtn");
    await page.click('#themeSwitch [data-value="dark"]');
    check((await page.evaluate(() => document.documentElement.dataset.theme)) === "dark", "theme menu Dark sets data-theme=dark");
    await page.click("#themeBtn");
    await page.click('#themeSwitch [data-value="light"]');
    check((await page.evaluate(() => document.documentElement.dataset.theme)) === "light", "theme menu Light sets data-theme=light");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.click("#themeBtn");
    await page.click('#themeSwitch [data-value="system"]');
    check((await page.evaluate(() => document.documentElement.dataset.theme)) === "dark", "System follows prefers-color-scheme (dark)");
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForTimeout(100);
    check((await page.evaluate(() => document.documentElement.dataset.theme)) === "light", "System follows prefers-color-scheme (light)");
    check((await page.evaluate(() => localStorage.getItem("sx.theme"))) === "system", "theme preference stored in localStorage sx.theme");
    await page.click("#themeBtn");
    await page.keyboard.press("Escape");
    check((await page.locator("#themeSwitch").count()) === 0 && (await page.evaluate(() => document.activeElement && document.activeElement.id)) === "themeBtn", "Esc closes the theme menu and focus returns to its button");
  });

  // ---------------------------------------------------------------- safety stop
  await section("safety stop: Review stop… and the checkbox confirm", async () => {
    await setState(page, { status: "stopped", stopReason: "captcha", stopDetail: "Arkose challenge iframe detected on x.com/home", stoppedAt: Date.now(), alert: { reason: "captcha", detail: "Arkose challenge iframe detected on x.com/home", at: Date.now() - 120000 } });
    await openTab(page, base, "overview");
    await page.waitForSelector("#safetyBanner", { timeout: 5000 });
    check(/Captcha/.test(await page.locator("#safetyBanner").innerText()), "red alert banner with the reason");
    check(/Stopped/.test(await page.locator("#heroStatus").innerText()) && (await page.locator("#engineBox .status-danger").count()) === 1 && /captcha/i.test(await page.locator("#engineBox .status").innerText()), "status red: Stopped (captcha)");
    check((await page.locator("#btn-reviewStop.btn-primary").count()) === 1 && /Review stop/.test(await page.locator("#btn-reviewStop").innerText()) && (await page.locator("#btn-resume").count()) === 0, "the primary button is Review stop… (no one-click Resume)");
    check((await page.locator("#alertReviewBtn").count()) === 1 && /Review and resume/.test(await page.locator("#alertReviewBtn").innerText()) && (await page.locator("#alertDismissBtn").count()) === 1, "the banner offers Review and resume… and Dismiss");
    check((await page.locator('#nav [data-tab="overview"] .tab-alert:not([hidden])').count()) === 1, "the rail marks Today with an alert");
    check(await page.evaluate(() => [...document.querySelectorAll("#safetyBanner .alert-time, #safetyBanner .alert-detail")].every((el) => getComputedStyle(el).opacity === "1")), "banner text over the red fill is full white (no opacity)");
    // Never started yet (e.g. the live X test hit a captcha): the setup stepper offers Review stop…, not a one-click Start.
    const firstStartedAt = (await storageKey(page, "sx.state")).firstStartedAt || null;
    await setState(page, { firstStartedAt: null });
    check(await waitFor(page, () => !!document.querySelector('#setupChecklist [data-step="start"]:not(.is-done)'), null, 5000), "setup stepper: the Start step is open again (never started)");
    const stepBtns = (await page.locator("#setupChecklist button").allInnerTexts()).map((x) => x.trim());
    check(!stepBtns.includes("Start") && stepBtns.some((x) => /Review stop/.test(x)), "setup stepper: Review stop…, no one-click Start, during a safety stop (" + stepBtns.filter((x) => !/\n/.test(x)).join(" | ") + ")");
    await page.locator('#setupChecklist button:has-text("Review stop")').first().click();
    check(await waitFor(page, () => !!document.querySelector(".modal-stop #rsResumeBtn[disabled]"), null, 3000), "the stepper's Review stop… opens the stop dialog (Resume needs the checkbox)");
    await page.keyboard.press("Escape");
    await setState(page, { firstStartedAt });
    await openTab(page, base, "discover?s=followersOf");
    check(await page.locator("#discStartBtn").isDisabled() && /safety/i.test((await page.locator("#discStartBtn").getAttribute("title")) || "") && (await page.locator("#discReviewStop").count()) === 1, "Discover: the X-tab sources wait for the reviewed stop (start disabled, Review stop… offered)");
    await openTab(page, base, "overview");
    await page.waitForSelector("#safetyBanner", { timeout: 5000 });
    await page.screenshot({ path: path.join(OUT, "light-overview-alert.png"), fullPage: false });
    await page.click("#btn-reviewStop");
    await page.waitForSelector(".modal-stop");
    check(await page.locator("#rsResumeBtn").isDisabled(), "the stop dialog's Resume is disabled until the checkbox is ticked");
    check((await page.evaluate(() => document.activeElement && document.activeElement.type)) === "checkbox", "the checkbox gets the focus");
    await page.waitForTimeout(350); // let the dialog finish fading in
    await page.screenshot({ path: path.join(OUT, "light-stop-dialog.png"), fullPage: false });
    await page.locator(".modal-stop input[type=checkbox]").check();
    check(!(await page.locator("#rsResumeBtn").isDisabled()), "ticking the checkbox enables Resume");
    await page.keyboard.press("Escape");
    check(await waitFor(page, () => !document.querySelector(".modal-stop"), null, 2000), "Esc closes the dialog (nothing resumed)");
    await page.click("#alertReviewBtn");
    check(await waitFor(page, () => !!document.querySelector(".modal-stop #rsResumeBtn[disabled]"), null, 3000), "the banner button opens the same dialog, Resume disabled again");
    await page.keyboard.press("Escape");
    check((await storageKey(page, "sx.state")).status === "stopped", "the engine is still stopped");
    await setTheme(page, "dark");
    await page.screenshot({ path: path.join(OUT, "dark-overview-alert.png"), fullPage: false });
    await page.click("#btn-reviewStop");
    await page.waitForSelector(".modal-stop");
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(OUT, "dark-stop-dialog.png"), fullPage: false });
    await page.keyboard.press("Escape");
    await setTheme(page, "light");
    // unknown prompt: X's text is shown as plain text
    await setState(page, { status: "stopped", stopReason: "unknown_prompt", stopDetail: "<img src=x onerror=alert(1)><b>Label your AI content</b>", alert: { reason: "unknown_prompt", detail: "<img src=x onerror=alert(1)>", at: Date.now() - 60000 } });
    await waitFor(page, () => /prompt/i.test(document.getElementById("safetyBanner")?.textContent || ""), null, 5000);
    await page.click("#btn-reviewStop");
    await page.waitForSelector(".modal-stop");
    check((await page.locator(".modal-stop").innerText()).includes("<img src=x") && (await page.locator(".modal-stop img, .modal-stop b").count()) === 0, "unknown_prompt: X's prompt text (stopDetail) is shown as plain text");
    await page.keyboard.press("Escape");
    // running clears the alert
    await setState(page, { status: "running", stopReason: null, stopDetail: "", alert: null, nextTickAt: Date.now() + 150000, nextCommentAt: Date.now() + 360000 });
    check(await waitFor(page, () => /Running/.test(document.getElementById("heroStatus")?.textContent || ""), null, 5000), "Today shows Running");
    check((await page.locator("#engineBox .status-running").count()) === 1 && (await page.locator("#safetyBanner").count()) === 0, "Running shows the lime status and the alert clears");
    check((await page.locator("#btn-pause.btn-primary").count()) === 1 && !(await page.locator("#runNowBtn").isDisabled()), "while running the primary button is Pause and Run a check now is enabled");
    const why = await page.evaluate(() => { const el = document.getElementById("engineWhy"); return { display: getComputedStyle(el).display, h: Math.round(el.getBoundingClientRect().height) }; });
    check(why.display === "block" && why.h < 60, `the running engine sentence reads as one paragraph (display ${why.display}, ${why.h}px tall)`);
    await page.screenshot({ path: path.join(OUT, "light-overview-running.png"), fullPage: false });
    await setState(page, { status: "stopped", stopReason: "captcha", stopDetail: "Arkose challenge iframe detected on x.com/home", alert: { reason: "captcha", detail: "Arkose challenge iframe detected on x.com/home", at: Date.now() - 120000 } });
  });

  // ---------------------------------------------------------------- Advanced sections
  await section("advanced sections", async () => {
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("sx.adv.")) localStorage.removeItem(k); });
    await openTab(page, base, "models");
    const adv = page.locator('details[data-adv="models.advanced"]');
    check(!(await adv.evaluate((d) => d.open)), "Models: Advanced is collapsed by default");
    await adv.locator("summary").click();
    await page.waitForFunction(() => localStorage.getItem("sx.adv.models.advanced") === "1", null, { timeout: 3000 });
    await page.reload();
    await page.waitForSelector('#view[data-ready="models"]');
    check(await page.locator('details[data-adv="models.advanced"]').evaluate((d) => d.open), "Models: Advanced stays open after reload (localStorage)");
    check((await page.locator('details[data-adv="models.advanced"] #modelsTable tbody tr').count()) >= 3, "Models: the model/price table lives in Advanced");
    await page.locator('details[data-adv="models.advanced"] summary').click();
    for (const [route, keys] of [["safety", ["safety.advanced"]], ["settings", ["settings.review", "settings.cleanup", "settings.data"]], ["tones", ["tones.advanced", "tones.ab"]], ["history?view=comments", ["history.totals", "history.retention"]], ["scores", ["scores.others", "scores.providers", "scores.overrides"]], ["discover?view=find", ["discover.filters"]]]) {
      await openTab(page, base, route);
      for (const k of keys) check((await page.locator(`details[data-adv="${k}"]`).count()) === 1 && !(await page.locator(`details[data-adv="${k}"]`).evaluate((d) => d.open)), `${route.split("?")[0]}: "${k}" is a collapsed section`);
    }
    await openTab(page, base, "settings");
    check((await page.locator("#cleanupEnabled").isChecked()) === false, "cleanup stays OFF by default");
    // Screenshots with every collapsed section open (to review the hidden parts), then close them again.
    for (const route of ["models", "safety", "settings", "tones", "scores", "discover?view=find"]) {
      await openTab(page, base, route);
      await page.evaluate(() => { for (const d of document.querySelectorAll("#view details.adv")) d.open = true; });
      await page.waitForTimeout(150);
      await shot(page, `light-${route.replace(/[?=&]/g, "-")}-open.png`);
      await page.evaluate(() => { for (const d of document.querySelectorAll("#view details.adv")) d.open = false; });
    }
    await setTheme(page, "dark");
    await openTab(page, base, "settings");
    await page.evaluate(() => { for (const d of document.querySelectorAll("#view details.adv")) d.open = true; });
    await shot(page, "dark-settings-open.png");
    await page.evaluate(() => { for (const d of document.querySelectorAll("#view details.adv")) d.open = false; });
    await setTheme(page, "light");
  });

  // ---------------------------------------------------------------- popup
  await section("popup", async () => {
    const popup = await ctx.newPage();
    watch(popup, "popup");
    await popup.setViewportSize({ width: 360, height: 640 });
    for (const theme of ["light", "dark"]) {
      await popup.goto(base + "popup.html");
      await popup.evaluate((v) => window.sxTheme.set(v), theme);
      check(await waitFor(popup, () => document.querySelector("#pPending .p-cell-value")?.textContent === "1", null, 8000), `popup renders in ${theme} with 1 reply to review`);
      await popup.waitForTimeout(400); // let colour transitions finish after the theme flip
      await popup.screenshot({ path: path.join(OUT, `${theme}-popup-alert.png`), fullPage: true });
    }
    check(/Stopped/.test(await popup.locator("#pStatus").innerText()) && /Captcha/.test(await popup.locator("#pAlert").innerText()), "popup status Stopped with the alert message");
    check((await popup.locator("#p-reviewStop").count()) === 1 && (await popup.locator("#p-resume").count()) === 0 && (await popup.locator("#pControls .btn-primary").count()) === 1, "popup: one primary button, Review stop… (no one-click resume)");
    check(/Review next/i.test(await popup.locator("#pPending").innerText()) && (await popup.locator("#pApprove").isDisabled()) && (await popup.locator("#pSkip").count()) === 1 && (await popup.locator("#pEditQueue").count()) === 1, "popup review next: the follows-you reply has Approve disabled; Skip and Edit in queue shown");
    check(/\d+ \/ \d+/.test(await popup.locator("#pQuota").innerText()) && (await popup.locator("#pQuota svg").count()) >= 1, "popup shows posted / limit in 24 h with the rhythm strip");
    const qs = await popup.locator("#pQuotaSub").innerText();
    check(/\d+\sgenerated/.test(qs) && /\d+\scommenting/.test(qs) && !/\bA\s\d+\s·\sB\s\d+/.test(qs), "popup quota line shows generated + follow counts, no A/B split: " + qs);
    check(/2 replies waiting for you/.test(await popup.locator("#pConvos").innerText()), "popup replies line counts the 2 open conversations");
    check((await popup.locator("#pRisk .risk").count()) === 1, "popup risk chip");
    check(/Sorsa/.test(await popup.locator("#pGrowth").textContent()), "popup growth cells include the main score site (Sorsa)");
    check(await popup.locator("#pProfile").isHidden(), "This profile card is hidden when the active tab is not an x.com profile");
    check(!/warm-?up/i.test(await popup.locator("body").innerText()), "no warm-up text in the popup");
    await setState(page, { status: "paused", stopReason: null, stopDetail: "", alert: null });
    check(await waitFor(popup, () => !!document.querySelector("#p-resume.btn-primary"), null, 6000) && (await popup.locator("#pControls .btn-primary").count()) === 1, "popup: Resume is the primary button while paused");
    for (const theme of ["light", "dark"]) {
      await popup.evaluate((v) => window.sxTheme.set(v), theme);
      await popup.waitForTimeout(400);
      await popup.screenshot({ path: path.join(OUT, `${theme}-popup.png`), fullPage: true });
    }
    check((await popup.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, "popup: no horizontal scroll at 360px");
    await popup.close();
  });
} catch (e) {
  failed++;
  console.log("  FAIL exception: " + (e && e.stack ? e.stack : e));
} finally {
  await ctx.close();
  fs.rmSync(userDir, { recursive: true, force: true });
}

if (errors.length) {
  const uniq = [...new Set(errors)];
  failed += uniq.length;
  console.log("\npage errors / console errors:");
  for (const e of uniq) console.log("  " + e);
}
console.log(`\n${passed} passed, ${failed} failed. Screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
