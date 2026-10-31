// ScoreX - chrome.storage.local access, defaults and settings sanitising.
//
// Ownership rule (keeps writes race-free):
//   * settings, secrets, selectorOverrides, providerOverrides -> written by the dashboard, read by the service worker
//   * state, targets, candidates, blacklist, seen, logs, learning, discovery, history (IndexedDB)
//                                           -> written ONLY by the service worker; the UI asks via messages
// Every read-modify-write in the service worker goes through withLock(key) so interleaved
// async handlers never lose an update.

import { K, STATUS, MODE, HARD, SCHEMA_VERSION } from "./constants.js";
import { deepClone, clamp, num, isValidTimeZone, parseHHMM, now, redact, parseHandleList } from "./util.js";
import { DEFAULT_MODELS, DEFAULT_PRESETS, DEFAULT_FALLBACK, MODELS_REV } from "./models.js";
import { PROVIDER_DEFS } from "./providerdefs.js";
import { DEFAULT_VOICE, VOICE_PRESETS } from "./voices.js";
import { db, STORES } from "./db.js";

const area = () => globalThis.chrome.storage.local;

export async function load(key, def) {
  const r = await area().get(key);
  return r[key] === undefined ? deepClone(def) : r[key];
}
export async function save(obj) { await area().set(obj); }
export async function remove(keys) { await area().remove(keys); }

// ---------- per-key async mutex ----------
const locks = new Map();
export function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((r) => (release = r));
  const tail = prev.then(() => next);
  locks.set(key, tail);
  return prev.then(async () => {
    try { return await fn(); } finally { release(); if (locks.get(key) === tail) locks.delete(key); }
  });
}
// Read-modify-write a storage key under its lock. `fn` may mutate and/or return the new value.
export function update(key, def, fn) {
  return withLock(key, async () => {
    const cur = await load(key, def);
    const out = await fn(cur);
    const val = out === undefined ? cur : out;
    await save({ [key]: val });
    return val;
  });
}

// ---------- reset counter ----------
// "Reset everything" (lib/backup.js resetAll) counts up here, in the same worker as the score jobs: a job or a provider
// call that started before a reset sees a different number and stops (no more requests, no write of its results).
let resets = 0;
export function noteReset() { resets++; }
export function resetCount() { return resets; }

// ---------- defaults ----------

export const DEFAULT_TONES = {
  // Voice presets from UniqueFarm (lib/voices.js), then the original ScoreX tones.
  ...Object.fromEntries(Object.entries(VOICE_PRESETS).map(([k, v]) => [k, v.text])),
  witty: "Witty and light. A clever angle or a playful twist, never a joke at their expense.",
  insightful: "Insightful and sharp. Add one concrete new point, data angle, implication or counterpoint they did not mention.",
  bold: "Bold and confident. Take a clear stance or a contrarian-but-reasonable angle in few words.",
  friendly: "Friendly and familiar, like a mutual who knows their work. Warm, specific, never sycophantic.",
  expert: "Expert and precise. Show domain knowledge with one specific detail, mechanism or example.",
};

// The default Tone prompt (Tone screen): the UniqueFarm default voice. Sent with every comment unless a target has
// its own tone. Settings that still hold the old default are moved to it once (genRev 1).
export const DEFAULT_TONE_PROMPT = DEFAULT_VOICE;
export const LEGACY_DEFAULT_TONE_PROMPT = "Insightful and sharp, like a smart builder who knows the space. Add one concrete point, data angle, implication or counterpoint the author did not mention. Casual and confident, never sycophantic, never salesy.";
export const TONE_MAX = 6000; // characters of a Tone prompt / tone text

// Whole words / phrases (see filters.js). No ambiguous single words for a crypto account: "woke up", "DAO voting",
// "vote for proposal 12", "leader election", "Christian" (a name), "Bitcoin is a religion", "Riot Platforms".
export const DEFAULT_POLITICAL_KEYWORDS = [
  "election", "elections", "midterms", "go vote", "early voting", "voting rights", "voter fraud", "voter id", "ballot", "ballots",
  "democrat", "democrats", "republican", "republicans", "gop", "maga",
  "trump", "biden", "kamala", "harris", "obama", "putin", "zelensky", "netanyahu", "modi", "parliament", "congressman", "congresswoman", "senator",
  "left wing", "right wing", "leftist", "liberals", "conservatives", "woke mob", "woke left", "woke agenda", "anti woke", "wokeness",
  "abortion", "gun control", "immigration", "deport", "deportation", "deportations",
  "israel", "palestine", "gaza", "hamas", "ukraine war", "russia", "genocide", "war crimes", "terrorist", "islam",
  "christians", "christianity", "jewish", "hindu", "muslim", "racist", "racism", "feminism", "transgender",
  "protesters", "protestors", "riots", "rioters", "awami", "bnp", "jamaat", "আওয়ামী", "বিএনপি", "জামায়াত",
];
// The list before 2026-10: settings that still hold exactly this list move to the new default.
const OLD_POLITICAL_KEYWORDS_V1 = [
  "election", "elections", "vote for", "voting", "ballot", "democrat", "democrats", "republican", "republicans", "gop", "maga",
  "trump", "biden", "kamala", "harris", "obama", "putin", "zelensky", "netanyahu", "modi", "parliament", "congressman", "senator",
  "left wing", "right wing", "leftist", "liberals", "conservatives", "woke", "abortion", "gun control", "immigration", "deport",
  "israel", "palestine", "gaza", "hamas", "ukraine war", "russia", "genocide", "war crimes", "terrorist", "religion", "islam",
  "christian", "jewish", "hindu", "muslim", "racist", "racism", "feminism", "transgender", "protest", "riot", "awami", "bnp",
];

export const DEFAULT_SETTINGS = {
  account: {
    handle: "0x_nation", // your own X handle (without @). Used to verify the logged-in account before acting.
    verifyAccount: true,
  },
  mode: MODE.REVIEW, // review | auto
  timezone: "Asia/Dhaka",

  watch: {
    strategy: "search", // list | search | rotation
    listUrls: [], // X List URLs (recommended for many targets: one page shows every target's new posts)
    searchBatchSize: 12, // handles per "from:a OR from:b" Latest search
    rotationPerTick: 3, // profiles visited per check in rotation mode
    checkIntervalSec: { min: 150, max: 360 },
    minPostAgeMin: 2, // never reply instantly
    maxPostAgeMin: 20, // aim to comment within the first 10-20 minutes
    includeQuotes: true,
    scrolls: 1, // light scroll on watch pages to load a few more posts
    // Also comment on each account's latest posts from before ScoreX ran (or that it missed).
    catchUp: { enabled: true, perTarget: 2, maxAgeHours: 48 },
  },

  // Legacy per-group settings (before follow tracking): only read to migrate an old tone into prompt.tone.
  groups: {
    A: { enabled: true, tone: "friendly", customTone: "", dailyLimit: 10 },
    B: { enabled: true, tone: "insightful", customTone: "", dailyLimit: 20 },
  },
  // Model preset per tier. Only accounts that don't follow you are commented on, so B1 / B2 are used
  // (A1 / A2 are kept for old exports).
  presetMatrix: { A1: "balanced", A2: "cheap", B1: "human", B2: "human" },

  models: DEFAULT_MODELS,
  modelsRev: MODELS_REV, // revision of the built-in model list these settings have seen (lib/models.js)
  presets: DEFAULT_PRESETS,
  fallback: DEFAULT_FALLBACK,

  quality: {
    modelCheck: true, // second quick model call grades the comment
    checkerPreset: "cheap",
    similarityThreshold: 0.45, // max trigram similarity vs your last 50 comments
    minChars: 12,
    maxChars: 220,
  },

  tones: DEFAULT_TONES,
  customTones: [], // [{ id, name, text }]

  prompt: {
    tone: "", // your Tone prompt (empty = DEFAULT_TONE_PROMPT)
    styleExampleCount: 4, // best-performing posted comments shown to the model as style references
    autoStyleFromHistory: true,
    extraRules: "",
    learnFromEdits: true, // your recent review edits (draft -> what you posted) are shown to the model as voice examples
    useImages: true, // the post's images go to the model (low detail) so it reacts to what it sees
    temperature: 1.0, // creativity for non-reasoning models (Human preset); reasoning models ignore it
  },

  // Follow tracking: only accounts that don't follow you are commented on.
  follow: {
    giveUpDays: 14, // days of comments without a follow-back before a target is removed
    autoRemove: true,
    blacklist: true, // removed targets go to the blacklist (never re-added by import or discovery)
    scanEveryHours: 2, // how often your newest followers are scanned for follow-backs
    recheckHours: 72, // profile re-check of the accounts you comment on
    checksPerRun: 4, // profile visits per idle check
    followFirst: true, // follow a target you do not follow before (or while) commenting on it
    followsPerDay: 40, // follow-first: accounts followed per 24 h (HARD.dailyFollows at most)
  },

  review: {
    pendingMaxAgeMin: 180, // pending items expire (post too old to be worth it)
    approvedMaxAgeMin: 240, // approved but not yet posted
    maxPending: 20, // stop generating while this many are waiting for you
    notifyNew: true,
  },

  budget: { monthlyUsd: 0, warnAtPct: 80 }, // 0 = no limit

  safetyRev: 2, // revision of the safety defaults these settings have seen
  genRev: 1, // revision of the reply-generation defaults these settings have seen (1 = UniqueFarm voice + Human preset)
  safety: {
    ramp: [200, 200, 200], // daily comment limit: week 1, week 2, week 3+ (each clamped to HARD.dailyComments)
    gapMin: { min: 2, max: 6 }, // random minutes between comments
    breaks: { enabled: true, afterMin: 10, afterMax: 15, minutesMin: 8, minutesMax: 15 },
    activeHours: { enabled: false, start: "10:00", end: "00:00" }, // off = ScoreX may work around the clock
    perTargetDay: 2, // comments per account per 24 hours
    perTargetWeek: 14,
    accountsPerDay: 100, // different accounts commented on per 24 hours
    generationFactor: 2, // max generations per day = daily limit x this (protects your OpenAI spend)
    like: { enabled: true }, // like every post right before replying to it (no separate like limit)
    typingCpm: { min: 170, max: 320 }, // characters per minute
    readDelaySec: { min: 3, max: 8 }, // "reading" the post before replying
    maxConsecutiveFailures: 2,
    bringTabToFront: false,
    // Reply reach monitor: views of your checked replies as a proxy for replies X hides. Heuristics, not guarantees.
    // action when reach drops: "notify" | "review" (switch to Review mode) | "halve" (halve the daily limit) | "stop"
    reach: { enabled: true, action: "review", minChecked: 15, dropPct: 60, lowViews: 10, lowShare: 0.5 },
    maxPageLoads24h: 0, // optional cap on X page loads per rolling 24 hours (0 = no cap); the engine waits, never stops
    adaptiveWatch: { enabled: true, afterEmpty: 6, maxIntervalMin: 15 }, // stretch watch checks while targets post nothing new
    skip: {
      ads: true,
      linkOnly: true,
      political: true,
      giveaways: true,
      gm: true,
      minChars: 20,
      languages: [], // e.g. ["en"]; empty = any language
      politicalKeywords: DEFAULT_POLITICAL_KEYWORDS,
      blockedWords: [],
    },
  },

  learning: {
    enabled: true,
    abTesting: true,
    explore: 0.2, // share of comments used to test other tones/models
    abTones: { A: [], B: [] }, // extra tones tested against your Tone prompt ("main"); B = the accounts you comment on
    abPresets: [], // empty = only the matrix preset; add e.g. ["balanced","cheap"] to test models
    minSamples: 8,
    coldAfterComments: 6, // no response after N comments -> lower frequency
    coldCooldownDays: 10,
    autoTierUp: true,
    engagementCheckAfterHours: 24,
    maxChecksPerRun: 3,
    conversations: { enabled: true, everyMin: 40 }, // read your mentions for replies from the accounts you comment on
  },

  cleanup: {
    enabled: false,
    afterDays: 7,
    dailyLimit: 10,
    whitelist: [],
    protectTier1: true,
  },

  scores: {
    sorsaEnabled: false, // legacy switch, kept in sync with providers.sorsa.enabled
    blendSorsa: 0.5, // weight of Sorsa in the combined rank when available
    autoRefreshOwn: true, // refresh your own scores about once a day while any provider is on
  },
  // Score providers (lib/providerdefs.js): all OFF until you turn them on in the Scores tab.
  // { [id]: { enabled, mode: "auto" | "api" | "public" | "page", dailyCap } }
  providers: {},
  providersRev: 1, // revision of the provider defaults these settings have seen (1: TwitterScore 100 requests/day)

  discovery: {
    minFollowers: 1000,
    maxFollowers: 5000000,
    activeWithinDays: 14,
    languages: [],
    skipBots: true,
    maxUsers: 150, // user cells collected per source
    enrichMax: 25, // profiles visited for scoring per run
  },

  // Score-aware targeting: priorities use provider scores x how likely the account is to follow back.
  targeting: { useValue: true },
  // History retention: skipped/failed records are compacted after N days and deleted after M days; posted ones are kept.
  history: { compactAfterDays: 30, keepUnpostedDays: 90 },

  ui: { theme: "system" },
  // tabMode: "pinned" tab in your window or a separate "window". freshTab: replace the X tab with a fresh one when a
  // check starts and it has been in the background for 4+ minutes (Chrome throttles long-hidden tabs; lib/tabs.js).
  advanced: { debug: false, tabMode: "pinned", freshTab: true },
};

export const DEFAULT_STATE = {
  status: STATUS.STOPPED,
  stopReason: null,
  stopDetail: "",
  stoppedAt: null,
  firstStartedAt: null,
  startedAt: null,
  lastTickAt: null,
  nextTickAt: null,
  tickCount: 0,
  lastCommentAt: null,
  nextCommentAt: null,
  lastLikeAt: null,
  commentsSinceBreak: 0,
  nextBreakAfter: null,
  breakUntil: null,
  sleepingUntil: null,
  workerTabId: null,
  followTimes: [], // follow-first: when ScoreX followed someone (rolling 24 h cap)
  lastFollowAt: null,
  workerTabFreshAt: null, // when the current X tab was opened fresh (lib/tabs.js replaces it after FRESH_TAB_MS in the background)
  job: null, // { kind, id, startedAt, leaseUntil, step }
  consecutiveFailures: 0,
  softErrors: 0,
  lastError: null,
  watchCursor: 0,
  me: null, // { handle, checkedAt }
  budgetWarnedMonth: null,
  lastLearningAt: null,
  lastCleanupAt: null,
  alert: null, // { reason, detail, at } - drives the red badge until cleared
  modelCompat: {}, // { [modelName]: { noVerbosity, noFormat, noReasoning, noStore } } learned from 400s
  hiddenEmptyStreak: 0, // watch pages that rendered nothing while the tab was hidden
  pendingRefresh: [], // handles whose profile should be refreshed on the next idle tick
  footprint: null, // X page loads per hour bucket for the rolling 24 h window (counted in lib/tabs.js navigate)
  reachAlert: null, // { at, message, medianNow, medianBefore, lowShare, checked, action } set by the reach monitor until dismissed
  emptyWatchStreak: 0, // watch checks in a row that found no fresh target post (adaptive watch cadence)
  accountUnknownStreak: 0, // page loads in a row where the logged-in account could not be read
  lastMentionsAt: null, // last read of your mentions (conversation alerts)
  lastHistoryMaintAt: null, // last history retention run
  lastSelfTest: null, // { at, ok, checks: [{ id, label, ok, detail }], stop } - the last live X self-test (diagnostics.js)
};

export const DEFAULT_SECRETS = { openaiKey: "", sorsaKey: "", twitterscoreKey: "", moniKey: "" };

// ---------- sanitising ----------

function range(r, lo, hi, defMin, defMax) {
  let a = clamp(num(r && r.min, defMin), lo, hi);
  let b = clamp(num(r && r.max, defMax), lo, hi);
  if (b < a) [a, b] = [b, a];
  return { min: a, max: b };
}

const PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);
// Drops prototype keys everywhere (JSON.parse turns "__proto__" into an own key that would otherwise
// re-parent merged objects). Mutates and returns its argument, which must be a private clone.
function stripProto(v) {
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = stripProto(v[i]); return v; }
  if (isPlainObject(v)) {
    for (const k of PROTO_KEYS) if (Object.hasOwn(v, k)) delete v[k];
    for (const k of Object.keys(v)) v[k] = stripProto(v[k]);
  }
  return v;
}
// Sections that are objects in the defaults stay objects: null, an array or a plain value there (corrupt storage, a
// hand-edited or crafted backup) falls back to the default section instead of crashing every getSettings() call.
// Arrays and plain values are taken over as they are; the sanitising below checks them. Legacy array forms that the
// sanitising converts are listed here.
const ARRAY_OK = new Set(["learning.abTones"]);
function mergeShape(def, raw, path = "") {
  if (!isPlainObject(def)) return raw === undefined ? deepClone(def) : raw;
  if (!isPlainObject(raw)) return Array.isArray(raw) && ARRAY_OK.has(path) ? raw : deepClone(def);
  const out = {};
  for (const k of Object.keys(def)) out[k] = Object.hasOwn(raw, k) ? mergeShape(def[k], raw[k], path ? path + "." + k : k) : deepClone(def[k]);
  for (const k of Object.keys(raw)) if (!Object.hasOwn(def, k)) out[k] = raw[k];
  return out;
}

// Merge stored settings over defaults and clamp everything safety-relevant to HARD caps.
export function sanitizeSettings(raw) {
  // Works on clones only: the clamping below mutates in place (it would otherwise rewrite DEFAULT_SETTINGS /
  // DEFAULT_PRESETS / DEFAULT_FALLBACK or the caller's object).
  const s = mergeShape(DEFAULT_SETTINGS, stripProto(deepClone(raw == null ? {} : raw)));
  s.account.handle = String(s.account.handle || "").trim().replace(/^@+/, "").trim();
  if (!isValidTimeZone(s.timezone)) s.timezone = DEFAULT_SETTINGS.timezone;
  if (![MODE.REVIEW, MODE.AUTO].includes(s.mode)) s.mode = MODE.REVIEW;

  const w = s.watch;
  if (!["list", "search", "rotation"].includes(w.strategy)) w.strategy = "search";
  w.listUrls = (Array.isArray(w.listUrls) ? w.listUrls : []).map((u) => String(u).trim()).filter(Boolean);
  w.searchBatchSize = clamp(Math.round(num(w.searchBatchSize, 12)), 1, 20);
  w.rotationPerTick = clamp(Math.round(num(w.rotationPerTick, 3)), 1, 6);
  w.checkIntervalSec = range(w.checkIntervalSec, HARD.minCheckIntervalSec, 3600, 150, 360);
  w.minPostAgeMin = clamp(num(w.minPostAgeMin, 2), 0, 30);
  w.maxPostAgeMin = clamp(num(w.maxPostAgeMin, 20), Math.max(5, w.minPostAgeMin + 1), 180);
  w.scrolls = clamp(Math.round(num(w.scrolls, 1)), 0, 4);
  w.catchUp = { enabled: !(w.catchUp && w.catchUp.enabled === false), perTarget: clamp(Math.round(num(w.catchUp && w.catchUp.perTarget, 2)), 1, 3), maxAgeHours: clamp(num(w.catchUp && w.catchUp.maxAgeHours, 48), 1, 168) };

  const sf = s.safety;
  // Settings saved with the first safety defaults (10/20/30 ramp, 1 per account, likes off, active hours on)
  // move to the owner's current defaults; values that were changed by hand are kept.
  if (!(Number(raw && raw.safetyRev) >= 2) && raw && raw.safety) {
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    if (same(sf.ramp, [10, 20, 30])) sf.ramp = [200, 200, 200];
    if (num(sf.perTargetDay) === 1) sf.perTargetDay = 2;
    if (num(sf.perTargetWeek) === 3) sf.perTargetWeek = 14;
    if (sf.like && sf.like.enabled === false && num(sf.like.dailyLimit) === 20) sf.like.enabled = true;
    if (same(sf.gapMin, { min: 3, max: 12 })) sf.gapMin = { min: 2, max: 6 };
    if (sf.breaks && sf.breaks.afterMin === 3 && sf.breaks.afterMax === 6 && sf.breaks.minutesMin === 20 && sf.breaks.minutesMax === 60) Object.assign(sf.breaks, { afterMin: 10, afterMax: 15, minutesMin: 8, minutesMax: 15 });
    if (sf.activeHours && sf.activeHours.enabled === true && sf.activeHours.start === "10:00" && sf.activeHours.end === "00:00") sf.activeHours.enabled = false;
    if (same(sf.readDelaySec, { min: 4, max: 12 })) sf.readDelaySec = { min: 3, max: 8 };
  }
  s.safetyRev = 2;
  sf.ramp = [0, 1, 2].map((i) => clamp(Math.round(num(sf.ramp && sf.ramp[i], DEFAULT_SETTINGS.safety.ramp[i])), 0, HARD.dailyComments));
  sf.gapMin = range(sf.gapMin, HARD.minGapMin, 240, 2, 6);
  sf.breaks.afterMin = clamp(Math.round(num(sf.breaks.afterMin, 10)), 1, 100);
  sf.breaks.afterMax = clamp(Math.round(num(sf.breaks.afterMax, 15)), sf.breaks.afterMin, 100);
  const bm = range({ min: sf.breaks.minutesMin, max: sf.breaks.minutesMax }, 5, 480, 8, 15);
  sf.breaks.minutesMin = bm.min; sf.breaks.minutesMax = bm.max;
  if (parseHHMM(sf.activeHours.start) == null) sf.activeHours.start = "10:00";
  if (parseHHMM(sf.activeHours.end) == null) sf.activeHours.end = "00:00";
  sf.perTargetDay = clamp(Math.round(num(sf.perTargetDay, 2)), 0, HARD.perTargetDay);
  sf.perTargetWeek = clamp(Math.round(num(sf.perTargetWeek, 14)), sf.perTargetDay, HARD.perTargetWeek);
  sf.accountsPerDay = clamp(Math.round(num(sf.accountsPerDay, 100)), 1, HARD.accountsPerDay);
  sf.generationFactor = clamp(num(sf.generationFactor, 2), 1, 5);
  sf.like = { enabled: !!(sf.like && sf.like.enabled) }; // no separate like limit: one like per comment at most
  sf.typingCpm = range(sf.typingCpm, 60, 600, 170, 320);
  sf.readDelaySec = range(sf.readDelaySec, 1, 120, 3, 8);
  sf.maxConsecutiveFailures = clamp(Math.round(num(sf.maxConsecutiveFailures, 2)), 1, HARD.maxPostFailures);
  const re = sf.reach && typeof sf.reach === "object" ? sf.reach : {};
  sf.reach = {
    enabled: re.enabled !== false,
    action: ["notify", "review", "halve", "stop"].includes(re.action) ? re.action : "review",
    minChecked: clamp(Math.round(num(re.minChecked, 15)), 5, 200),
    dropPct: clamp(num(re.dropPct, 60), 20, 95),
    lowViews: clamp(Math.round(num(re.lowViews, 10)), 1, 1000),
    lowShare: clamp(num(re.lowShare, 0.5), 0.1, 1),
  };
  sf.maxPageLoads24h = clamp(Math.round(num(sf.maxPageLoads24h, 0)), 0, 5000);
  const aw = sf.adaptiveWatch && typeof sf.adaptiveWatch === "object" ? sf.adaptiveWatch : {};
  sf.adaptiveWatch = { enabled: aw.enabled !== false, afterEmpty: clamp(Math.round(num(aw.afterEmpty, 6)), 2, 50), maxIntervalMin: clamp(num(aw.maxIntervalMin, 15), 5, 60) };
  sf.skip.minChars = clamp(Math.round(num(sf.skip.minChars, 20)), 0, 280);
  for (const k of ["languages", "politicalKeywords", "blockedWords"]) {
    sf.skip[k] = (Array.isArray(sf.skip[k]) ? sf.skip[k] : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  }
  const pk = sf.skip.politicalKeywords;
  if (pk.length === OLD_POLITICAL_KEYWORDS_V1.length && pk.every((x, i) => x === OLD_POLITICAL_KEYWORDS_V1[i])) sf.skip.politicalKeywords = [...DEFAULT_POLITICAL_KEYWORDS];

  const q = s.quality;
  q.similarityThreshold = clamp(num(q.similarityThreshold, 0.45), 0.1, 0.95);
  q.minChars = clamp(Math.round(num(q.minChars, 12)), 1, 200);
  q.maxChars = clamp(Math.round(num(q.maxChars, 220)), q.minChars + 10, HARD.maxCommentChars);

  // Custom tones: a list of { id, name, text }; anything else would break tone lookups (and with them generation).
  s.customTones = (Array.isArray(s.customTones) ? s.customTones : [])
    .filter((c) => isPlainObject(c) && c.id != null && String(c.id).trim())
    .map((c) => ({ ...c, id: String(c.id).trim().slice(0, 60), name: String(c.name || "").slice(0, 80), text: String(c.text || "").slice(0, TONE_MAX) }));

  // Settings from before the Tone prompt existed: take over the tone the user had chosen, and drop the old
  // default A/B tone lists (they would test other tones against the user's own prompt).
  const legacy = !(raw && raw.prompt && typeof raw.prompt.tone === "string");
  if (legacy) {
    const b = s.groups.B || {};
    const custom = b.tone === "custom" ? String(b.customTone || "").trim() : b.tone && String(b.tone).startsWith("custom:") ? ((s.customTones || []).find((c) => "custom:" + c.id === b.tone) || {}).text : "";
    const builtin = DEFAULT_TONES[b.tone] && s.tones[b.tone] && s.tones[b.tone] !== DEFAULT_TONES[b.tone] ? s.tones[b.tone] : "";
    s.prompt.tone = custom || builtin || "";
    const oldAb = { A: ["friendly", "witty", "insightful"], B: ["insightful", "bold", "expert"] };
    const ab = s.learning.abTones;
    if (ab && !Array.isArray(ab)) for (const g of ["A", "B"]) if (JSON.stringify(ab[g]) === JSON.stringify(oldAb[g])) ab[g] = [];
  }
  s.prompt.tone = String(s.prompt.tone || "").trim().slice(0, TONE_MAX) || DEFAULT_TONE_PROMPT;
  s.prompt.useImages = s.prompt.useImages !== false;
  s.prompt.temperature = clamp(num(s.prompt.temperature, 1.0), 0, 1.5);
  for (const k of Object.keys(s.tones || {})) s.tones[k] = String(s.tones[k] == null ? "" : s.tones[k]).slice(0, TONE_MAX);
  delete s.prompt.styleExamples; // pasted comment samples are no longer used
  s.prompt.styleExampleCount = clamp(Math.round(num(s.prompt.styleExampleCount, 4)), 0, 10);
  s.prompt.extraRules = String(s.prompt.extraRules || "").slice(0, 2000);
  s.prompt.learnFromEdits = s.prompt.learnFromEdits !== false;

  const fo = s.follow;
  fo.giveUpDays = clamp(Math.round(num(fo.giveUpDays, 14)), 3, 90);
  fo.autoRemove = fo.autoRemove !== false;
  fo.blacklist = fo.blacklist !== false;
  fo.scanEveryHours = clamp(num(fo.scanEveryHours, 2), 1, 24);
  fo.recheckHours = clamp(num(fo.recheckHours, 72), 12, 336);
  fo.checksPerRun = clamp(Math.round(num(fo.checksPerRun, 4)), 1, 8);
  fo.followFirst = fo.followFirst !== false;
  fo.followsPerDay = clamp(Math.round(num(fo.followsPerDay, 40)), 0, HARD.dailyFollows);

  s.review.pendingMaxAgeMin = clamp(num(s.review.pendingMaxAgeMin, 180), 10, 24 * 60);
  s.review.approvedMaxAgeMin = clamp(num(s.review.approvedMaxAgeMin, 240), 10, 24 * 60);
  s.review.maxPending = clamp(Math.round(num(s.review.maxPending, 20)), 1, 200);

  s.budget.monthlyUsd = Math.max(0, num(s.budget.monthlyUsd, 0));
  s.budget.warnAtPct = clamp(num(s.budget.warnAtPct, 80), 10, 100);

  const l = s.learning;
  if (Array.isArray(l.abTones)) l.abTones = { A: l.abTones.slice(), B: l.abTones.slice() };
  delete l.autoMoveToA; delete l.followCheckEveryHours; // replaced by follow tracking (settings.follow)
  if (!l.abTones || typeof l.abTones !== "object") l.abTones = deepClone(DEFAULT_SETTINGS.learning.abTones);
  for (const g of ["A", "B"]) l.abTones[g] = (Array.isArray(l.abTones[g]) ? l.abTones[g] : []).map(String).filter(Boolean).slice(0, 12);
  l.abPresets = (Array.isArray(l.abPresets) ? l.abPresets : []).filter((p) => ["human", "high", "balanced", "cheap"].includes(p));
  l.explore = clamp(num(l.explore, 0.2), 0, 0.6);
  l.minSamples = clamp(Math.round(num(l.minSamples, 8)), 2, 100);
  l.coldAfterComments = clamp(Math.round(num(l.coldAfterComments, 6)), 2, 50);
  l.coldCooldownDays = clamp(num(l.coldCooldownDays, 10), 1, 90);
  l.maxChecksPerRun = clamp(Math.round(num(l.maxChecksPerRun, 3)), 0, 10);
  const cv = l.conversations && typeof l.conversations === "object" ? l.conversations : {};
  l.conversations = { enabled: cv.enabled !== false, everyMin: clamp(num(cv.everyMin, 40), 15, 240) };

  s.targeting = { useValue: !(s.targeting && s.targeting.useValue === false) };
  const hi = s.history && typeof s.history === "object" ? s.history : {};
  const compactAfterDays = clamp(Math.round(num(hi.compactAfterDays, 30)), 7, 365);
  s.history = { compactAfterDays, keepUnpostedDays: clamp(Math.round(num(hi.keepUnpostedDays, 90)), Math.max(14, compactAfterDays), 3650) };

  const c = s.cleanup;
  c.afterDays = clamp(num(c.afterDays, 7), 7, 365);
  c.dailyLimit = clamp(Math.round(num(c.dailyLimit, 10)), 0, HARD.dailyUnfollows);
  // Accept profile URLs, @handles and several handles per line, like everywhere else.
  c.whitelist = parseHandleList((Array.isArray(c.whitelist) ? c.whitelist : c.whitelist ? [c.whitelist] : []).map(String).join("\n"));

  // Providers: one entry per known provider; the legacy Sorsa switch maps onto providers.sorsa.
  const prov = s.providers && typeof s.providers === "object" ? s.providers : {};
  const legacySorsa = !!(s.scores && s.scores.sorsaEnabled);
  // Settings saved before providersRev 1 carry TwitterScore's old default cap (300/day) as a stored value: it moves
  // to the new, politer default. A cap chosen after the upgrade sticks.
  const provRev = Number(raw && raw.providersRev) || 0;
  s.providers = {};
  for (const [id, def] of Object.entries(PROVIDER_DEFS)) {
    const cur = Object.hasOwn(prov, id) && isPlainObject(prov[id]) ? prov[id] : {};
    const modes = Object.keys(def.modes || {});
    const oldDefault = provRev < 1 && id === "twitterscore" && num(cur.dailyCap) === 300;
    s.providers[id] = {
      enabled: cur.enabled != null ? !!cur.enabled : id === "sorsa" ? legacySorsa : false,
      mode: cur.mode === "auto" || modes.includes(cur.mode) ? cur.mode : "auto",
      dailyCap: clamp(Math.round(num(oldDefault ? undefined : cur.dailyCap, def.dailyCap || 100)), 1, 5000),
    };
  }
  s.providersRev = 1;
  s.scores.sorsaEnabled = !!(s.providers.sorsa && s.providers.sorsa.enabled);
  s.scores.blendSorsa = clamp(num(s.scores.blendSorsa, 0.5), 0, 1);
  s.scores.autoRefreshOwn = s.scores.autoRefreshOwn !== false;

  const dv = s.discovery;
  dv.languages = (Array.isArray(dv.languages) ? dv.languages : String(dv.languages || "").split(/[\s,;]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  dv.minFollowers = Math.max(0, Math.round(num(dv.minFollowers, 1000)));
  dv.maxFollowers = Math.max(dv.minFollowers, Math.round(num(dv.maxFollowers, 5000000)));
  dv.activeWithinDays = clamp(num(dv.activeWithinDays, 14), 0, 365);
  dv.maxUsers = clamp(Math.round(num(dv.maxUsers, 150)), 10, 1000);
  dv.enrichMax = clamp(Math.round(num(dv.enrichMax, 25)), 0, 100);
  dv.skipBots = dv.skipBots !== false;

  for (const g of ["A", "B"]) {
    s.groups[g].dailyLimit = clamp(Math.round(num(s.groups[g].dailyLimit, g === "A" ? 10 : 20)), 0, HARD.dailyComments);
    s.groups[g].enabled = s.groups[g].enabled !== false;
  }
  if (Array.isArray(s.models)) s.models = s.models.filter(isPlainObject); // a null or string entry would crash below
  if (!Array.isArray(s.models) || !s.models.length) s.models = deepClone(DEFAULT_MODELS);
  // Built-in models added in a newer model-list revision are offered once (models you deleted stay deleted),
  // and the old default last-resort fallback moves to GPT-5 mini.
  const seenRev = Number(raw && raw.modelsRev) || (raw && Array.isArray(raw.models) && raw.models.length ? 1 : MODELS_REV);
  if (seenRev < MODELS_REV) {
    for (const dm of DEFAULT_MODELS) {
      if ((dm.addedIn || 1) <= seenRev || s.models.some((x) => x && (x.id === dm.id || x.name === dm.name))) continue;
      s.models.push(deepClone(dm));
    }
    if (s.fallback && s.fallback.secondModelId === "m_cheap" && s.models.some((x) => x && x.id === "m_g5_mini")) s.fallback.secondModelId = "m_g5_mini";
  }
  s.modelsRev = MODELS_REV;
  for (const m of s.models) {
    m.name = String(m.name || "").trim();
    m.maxOutputTokens = clamp(Math.round(num(m.maxOutputTokens, 1200)), 64, 32000);
    const pr = m.prices || {};
    m.prices = { input: Math.max(0, num(pr.input)), cachedInput: Math.max(0, num(pr.cachedInput, num(pr.input) / 10)), output: Math.max(0, num(pr.output)), cacheWrite: Math.max(0, num(pr.cacheWrite, num(pr.input) * 1.25)) };
    m.reasoning = m.reasoning !== false;
    m.id = String(m.id || ("m_" + Math.random().toString(36).slice(2, 8)));
    m.label = String(m.label || m.name || m.id);
  }
  const ids = new Set(s.models.map((m) => m.id));
  for (const k of ["human", "high", "balanced", "cheap"]) {
    const p = (s.presets[k] ||= { ...DEFAULT_PRESETS[k] });
    if (!ids.has(p.modelId)) p.modelId = k === "human" && ids.has("m_4o_mini") ? "m_4o_mini" : s.models[Math.min(s.models.length - 1, k === "high" ? s.models.length - 1 : k === "balanced" ? 1 : 0)].id;
    if (!["low", "medium", "high"].includes(p.effort)) p.effort = DEFAULT_PRESETS[k].effort;
  }
  if (!ids.has(s.fallback.modelId)) s.fallback.modelId = s.models[0].id;
  if (s.fallback.secondModelId && !ids.has(s.fallback.secondModelId)) s.fallback.secondModelId = "";
  if (!["low", "medium", "high"].includes(s.fallback.effort)) s.fallback.effort = "low";
  // Reply generation moved to the UniqueFarm voice and the Human preset (genRev 1): settings still on the old
  // defaults (Tone prompt, tier presets) follow; anything you changed by hand is kept.
  if (raw && !(Number(raw.genRev) >= 1)) {
    if (String(s.prompt.tone).trim() === LEGACY_DEFAULT_TONE_PROMPT) s.prompt.tone = DEFAULT_TONE_PROMPT;
    const pm = raw.presetMatrix || {};
    if (pm.B1 === "high" && pm.B2 === "balanced" && s.presets.human) { s.presetMatrix.B1 = "human"; s.presetMatrix.B2 = "human"; }
  }
  s.genRev = 1;
  for (const k of ["A1", "A2", "B1", "B2"]) if (!s.presets[s.presetMatrix[k]]) s.presetMatrix[k] = DEFAULT_SETTINGS.presetMatrix[k];
  if (!s.presets[s.quality.checkerPreset]) s.quality.checkerPreset = "cheap";
  return s;
}

// ---------- typed accessors ----------

export async function getSettings() { return sanitizeSettings(await load(K.settings, {})); }
// Stores the sanitized form, so what every context reads back is exactly what was checked (ids of models without
// one are fixed once instead of being re-generated on every read).
export async function saveSettings(s) { const clean = sanitizeSettings(s); await save({ [K.settings]: clean }); return clean; }

// API keys live in the extension's own IndexedDB, NOT in chrome.storage: content scripts running on x.com
// can read chrome.storage.local (and receive its change events), but cannot open the extension's IndexedDB.
const SECRETS_ID = "secrets";
async function migrateSecrets() {
  const legacy = await load(K.secrets, null);
  if (!legacy) return null;
  const cur = (await db().get(STORES.kv, SECRETS_ID)) || {};
  const merged = { ...DEFAULT_SECRETS, ...legacy, ...stripId(cur) };
  await db().put(STORES.kv, { id: SECRETS_ID, ...merged });
  await remove([K.secrets]);
  return merged;
}
const stripId = (o) => { const { id, ...rest } = o || {}; return rest; };
// Key values this context has seen, so log() can blank them even where no pattern recognises them (provider keys
// have no fixed prefix). Never persisted.
const knownSecrets = new Set();
function remember(secrets) {
  for (const v of Object.values(secrets || {})) if (typeof v === "string" && v.length >= 6) knownSecrets.add(v);
  return secrets;
}
export async function getSecrets() {
  const migrated = await migrateSecrets();
  if (migrated) return remember(migrated);
  return remember({ ...DEFAULT_SECRETS, ...stripId(await db().get(STORES.kv, SECRETS_ID)) });
}
const SECRET_NAMES = new Set([...Object.keys(DEFAULT_SECRETS), ...Object.values(PROVIDER_DEFS).map((d) => d.keyName).filter(Boolean)]);
export function setSecrets(patch) {
  return withLock("secrets", async () => {
    await migrateSecrets();
    // Known key names only; pasted keys are trimmed (a trailing newline makes every request fail).
    const clean = {};
    for (const [k, v] of Object.entries(patch || {})) if (SECRET_NAMES.has(k)) clean[k] = String(v == null ? "" : v).trim();
    // One IndexedDB transaction: a dashboard tab and the service worker (or two dashboard tabs) saving different
    // keys at the same time cannot overwrite each other's key (withLock only covers this JS context).
    const stored = await db().update(STORES.kv, SECRETS_ID, (cur) => ({ ...DEFAULT_SECRETS, ...stripId(cur), ...clean, id: SECRETS_ID }));
    const next = remember(stripId(stored));
    // Which keys are set (names only, never key material), so open pages can show "key saved" states.
    const has = Object.fromEntries(Object.entries(next).map(([k, v]) => [k, !!v]));
    await save({ [K.secretsRev]: { rev: now(), hasOpenai: !!next.openaiKey, hasSorsa: !!next.sorsaKey, has } });
    return next;
  });
}

export async function getState() { return { ...DEFAULT_STATE, ...(await load(K.state, {})) }; }
export function patchState(patch) {
  return update(K.state, {}, (cur) => {
    const base = { ...DEFAULT_STATE, ...cur };
    const p = typeof patch === "function" ? patch(base) : patch;
    return { ...base, ...(p || {}) };
  });
}

export async function getTargets() { return load(K.targets, {}); }
export function updateTargets(fn) { return update(K.targets, {}, fn); }

export async function getBlacklist() { return load(K.blacklist, {}); }
export function updateBlacklist(fn) { return update(K.blacklist, {}, fn); }

export async function getCandidates() { return load(K.candidates, {}); }
// Every write keeps sx.candidates at the CANDIDATES_CAP newest / best entries (repeated sweeps and discovery runs
// would otherwise grow it without bound inside chrome.storage's quota, which the engine's own state shares).
export function updateCandidates(fn) {
  return update(K.candidates, {}, async (all) => {
    const out = await fn(all);
    const val = out === undefined ? all : out;
    if (isPlainObject(val)) capCandidates(val);
    return val;
  });
}

export const CANDIDATES_CAP = 2000;
// Keeps the `cap` best candidates of a { handle: candidate } map in place; returns how many were dropped.
// Order: candidates that passed the filters first, then the most recently found (seenAt from a repeat find, else
// foundAt), then the best: listed by more of your big accounts (overlap), by more score providers, higher rank.
export function capCandidates(all, cap = CANDIDATES_CAP) {
  const keys = Object.keys(all || {});
  if (keys.length <= cap) return 0;
  const rank = (h) => {
    const c = isPlainObject(all[h]) ? all[h] : {};
    const sc = isPlainObject(c.score) ? num(c.score.combined != null ? c.score.combined : c.score.own, 0) : 0;
    const best = num(c.overlap, 0) * 1e4 + (isPlainObject(c.providerScores) ? Object.keys(c.providerScores).length : 0) * 1e3 + sc;
    return [c.pass === false ? 0 : 1, num(c.seenAt || c.foundAt, 0), best];
  };
  const r = new Map(keys.map((h) => [h, rank(h)]));
  keys.sort((a, b) => { const x = r.get(a), y = r.get(b); return y[0] - x[0] || y[1] - x[1] || y[2] - x[2] || (a < b ? -1 : 1); });
  for (const h of keys.slice(cap)) delete all[h];
  return keys.length - cap;
}

// ---------- activity log (capped, redacted) ----------
const LOG_CAP = 400;
// util.redact() plus what it does not cover: provider key names, key-bearing query strings (TwitterScore's API takes
// api_key=...), key headers, and the key values this context knows.
export function redactSecrets(v) {
  let s = redact(v)
    .replace(/([?&](?:api[_-]?key|apikey|key|token|access_token)=)[^&#\s"']+/gi, "$1***")
    .replace(/("?(?:twitterscoreKey|moniKey|sorsaKey|openaiKey|x-api-key|api-key|apikey|secret|token)"?\s*[:=]\s*"?)[^"\s,}&]+/gi, "$1***");
  for (const k of knownSecrets) {
    if (s.includes(k)) s = s.split(k).join("***");
    const enc = encodeURIComponent(k);
    if (enc !== k && s.includes(enc)) s = s.split(enc).join("***");
  }
  return s;
}
export function log(level, msg, data) {
  const entry = { ts: now(), level, msg: redactSecrets(String(msg)).slice(0, 500) };
  if (data !== undefined) entry.data = redactSecrets(data).slice(0, 800);
  if (level === "error" || level === "warn") { try { console[level]("[ScoreX]", entry.msg, entry.data || ""); } catch (_) {} }
  return update(K.logs, [], (arr) => {
    arr.push(entry);
    if (arr.length > LOG_CAP) arr.splice(0, arr.length - LOG_CAP);
    return arr;
  }).catch(() => {});
}

// ---------- seen posts (dedupe across checks) ----------
const SEEN_CAP = 3000;
export async function getSeen() { return load(K.seen, {}); }
export function markSeen(ids) {
  const t = now();
  return update(K.seen, {}, (m) => {
    for (const id of ids) if (id) m[id] = m[id] || t;
    const keys = Object.keys(m);
    if (keys.length > SEEN_CAP) {
      keys.sort((a, b) => m[a] - m[b]);
      for (const k of keys.slice(0, keys.length - SEEN_CAP)) delete m[k];
    }
    return m;
  });
}

// ---------- install / migration ----------
export async function ensureDefaults() {
  const v = await load(K.schema, 0);
  const cur = await load(K.settings, null);
  if (!cur) await save({ [K.settings]: deepClone(DEFAULT_SETTINGS) });
  const st = await load(K.state, null);
  if (!st) await save({ [K.state]: deepClone(DEFAULT_STATE) });
  if (v !== SCHEMA_VERSION) await save({ [K.schema]: SCHEMA_VERSION });
  await migrateSecrets().catch(() => {});
}
