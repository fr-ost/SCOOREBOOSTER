// ScoreX - chrome.storage.local access, defaults and settings sanitising.
//
// Ownership rule (keeps writes race-free):
//   * settings, secrets, selectorOverrides  -> written by the dashboard, read by the service worker
//   * state, targets, candidates, blacklist, seen, logs, learning, discovery, history (IndexedDB)
//                                           -> written ONLY by the service worker; the UI asks via messages
// Every read-modify-write in the service worker goes through withLock(key) so interleaved
// async handlers never lose an update.

import { K, STATUS, MODE, HARD, SCHEMA_VERSION } from "./constants.js";
import { deepMerge, deepClone, clamp, num, isValidTimeZone, parseHHMM, now, redact, parseHandleList } from "./util.js";
import { DEFAULT_MODELS, DEFAULT_PRESETS, DEFAULT_FALLBACK } from "./models.js";
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

// ---------- defaults ----------

export const DEFAULT_TONES = {
  witty: "Witty and light. A clever angle or a playful twist, never a joke at their expense.",
  insightful: "Insightful and sharp. Add one concrete new point, data angle, implication or counterpoint they did not mention.",
  bold: "Bold and confident. Take a clear stance or a contrarian-but-reasonable angle in few words.",
  friendly: "Friendly and familiar, like a mutual who knows their work. Warm, specific, never sycophantic.",
  expert: "Expert and precise. Show domain knowledge with one specific detail, mechanism or example.",
};

// The default Tone prompt (Tone & Prompts tab). Sent with every comment unless a target has its own tone.
export const DEFAULT_TONE_PROMPT = "Insightful and sharp, like a smart builder who knows the space. Add one concrete point, data angle, implication or counterpoint the author did not mention. Casual and confident, never sycophantic, never salesy.";

export const DEFAULT_POLITICAL_KEYWORDS = [
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
  },

  // Legacy per-group settings (before follow tracking): only read to migrate an old tone into prompt.tone.
  groups: {
    A: { enabled: true, tone: "friendly", customTone: "", dailyLimit: 10 },
    B: { enabled: true, tone: "insightful", customTone: "", dailyLimit: 20 },
  },
  // Model preset per tier. Only accounts that don't follow you are commented on, so B1 / B2 are used
  // (A1 / A2 are kept for old exports).
  presetMatrix: { A1: "balanced", A2: "cheap", B1: "high", B2: "balanced" },

  models: DEFAULT_MODELS,
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
  },

  // Follow tracking: only accounts that don't follow you are commented on.
  follow: {
    giveUpDays: 14, // days of comments without a follow-back before a target is removed
    autoRemove: true,
    blacklist: true, // removed targets go to the blacklist (never re-added by import or discovery)
    scanEveryHours: 2, // how often your newest followers are scanned for follow-backs
    recheckHours: 72, // profile re-check of the accounts you comment on
    checksPerRun: 4, // profile visits per idle check
  },

  review: {
    pendingMaxAgeMin: 180, // pending items expire (post too old to be worth it)
    approvedMaxAgeMin: 240, // approved but not yet posted
    maxPending: 20, // stop generating while this many are waiting for you
    notifyNew: true,
  },

  budget: { monthlyUsd: 0, warnAtPct: 80 }, // 0 = no limit

  safety: {
    ramp: [10, 20, 30], // daily comment limit: week 1, week 2, week 3+ (each clamped to HARD.dailyComments)
    gapMin: { min: 3, max: 12 }, // random minutes between comments
    breaks: { enabled: true, afterMin: 3, afterMax: 6, minutesMin: 20, minutesMax: 60 },
    activeHours: { enabled: true, start: "10:00", end: "00:00" },
    perTargetDay: 1,
    perTargetWeek: 3,
    generationFactor: 2, // max generations per day = daily limit x this (protects your OpenAI spend)
    like: { enabled: false, dailyLimit: 20 },
    typingCpm: { min: 170, max: 320 }, // characters per minute
    readDelaySec: { min: 4, max: 12 }, // "reading" the post before replying
    maxConsecutiveFailures: 2,
    bringTabToFront: false,
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
  },

  cleanup: {
    enabled: false,
    afterDays: 7,
    dailyLimit: 10,
    whitelist: [],
    protectTier1: true,
  },

  scores: {
    sorsaEnabled: false, // optional, needs your Sorsa API key + permission
    blendSorsa: 0.5, // weight of Sorsa in the combined rank when available
  },

  discovery: {
    minFollowers: 1000,
    maxFollowers: 5000000,
    activeWithinDays: 14,
    languages: [],
    skipBots: true,
    maxUsers: 150, // user cells collected per source
    enrichMax: 25, // profiles visited for scoring per run
  },

  ui: { theme: "system" },
  advanced: { debug: false, tabMode: "pinned" }, // tabMode: "pinned" tab in your window or a separate "window"
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
};

export const DEFAULT_SECRETS = { openaiKey: "", sorsaKey: "" };

// ---------- sanitising ----------

function range(r, lo, hi, defMin, defMax) {
  let a = clamp(num(r && r.min, defMin), lo, hi);
  let b = clamp(num(r && r.max, defMax), lo, hi);
  if (b < a) [a, b] = [b, a];
  return { min: a, max: b };
}

// Merge stored settings over defaults and clamp everything safety-relevant to HARD caps.
export function sanitizeSettings(raw) {
  // Clone both sides: deepMerge shares untouched sub-objects with its inputs, and the clamping below mutates
  // in place (it would otherwise rewrite DEFAULT_SETTINGS / DEFAULT_PRESETS / DEFAULT_FALLBACK or the caller's object).
  const s = deepMerge(deepClone(DEFAULT_SETTINGS), deepClone(raw || {}));
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

  const sf = s.safety;
  sf.ramp = [0, 1, 2].map((i) => clamp(Math.round(num(sf.ramp && sf.ramp[i], DEFAULT_SETTINGS.safety.ramp[i])), 0, HARD.dailyComments));
  sf.gapMin = range(sf.gapMin, HARD.minGapMin, 240, 3, 12);
  sf.breaks.afterMin = clamp(Math.round(num(sf.breaks.afterMin, 3)), 1, 50);
  sf.breaks.afterMax = clamp(Math.round(num(sf.breaks.afterMax, 6)), sf.breaks.afterMin, 50);
  const bm = range({ min: sf.breaks.minutesMin, max: sf.breaks.minutesMax }, 5, 480, 20, 60);
  sf.breaks.minutesMin = bm.min; sf.breaks.minutesMax = bm.max;
  if (parseHHMM(sf.activeHours.start) == null) sf.activeHours.start = "10:00";
  if (parseHHMM(sf.activeHours.end) == null) sf.activeHours.end = "00:00";
  sf.perTargetDay = clamp(Math.round(num(sf.perTargetDay, 1)), 0, HARD.perTargetDay);
  sf.perTargetWeek = clamp(Math.round(num(sf.perTargetWeek, 3)), 0, HARD.perTargetWeek);
  sf.generationFactor = clamp(num(sf.generationFactor, 2), 1, 5);
  sf.like.dailyLimit = clamp(Math.round(num(sf.like.dailyLimit, 20)), 0, HARD.dailyLikes);
  sf.typingCpm = range(sf.typingCpm, 60, 600, 170, 320);
  sf.readDelaySec = range(sf.readDelaySec, 1, 120, 4, 12);
  sf.maxConsecutiveFailures = clamp(Math.round(num(sf.maxConsecutiveFailures, 2)), 1, HARD.maxPostFailures);
  sf.skip.minChars = clamp(Math.round(num(sf.skip.minChars, 20)), 0, 280);
  for (const k of ["languages", "politicalKeywords", "blockedWords"]) {
    sf.skip[k] = (Array.isArray(sf.skip[k]) ? sf.skip[k] : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  }

  const q = s.quality;
  q.similarityThreshold = clamp(num(q.similarityThreshold, 0.45), 0.1, 0.95);
  q.minChars = clamp(Math.round(num(q.minChars, 12)), 1, 200);
  q.maxChars = clamp(Math.round(num(q.maxChars, 220)), q.minChars + 10, HARD.maxCommentChars);

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
  s.prompt.tone = String(s.prompt.tone || "").trim().slice(0, 2000) || DEFAULT_TONE_PROMPT;
  delete s.prompt.styleExamples; // pasted comment samples are no longer used
  s.prompt.styleExampleCount = clamp(Math.round(num(s.prompt.styleExampleCount, 4)), 0, 10);
  s.prompt.extraRules = String(s.prompt.extraRules || "").slice(0, 2000);

  const fo = s.follow;
  fo.giveUpDays = clamp(Math.round(num(fo.giveUpDays, 14)), 3, 90);
  fo.autoRemove = fo.autoRemove !== false;
  fo.blacklist = fo.blacklist !== false;
  fo.scanEveryHours = clamp(num(fo.scanEveryHours, 2), 1, 24);
  fo.recheckHours = clamp(num(fo.recheckHours, 72), 12, 336);
  fo.checksPerRun = clamp(Math.round(num(fo.checksPerRun, 4)), 1, 8);

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
  l.abPresets = (Array.isArray(l.abPresets) ? l.abPresets : []).filter((p) => ["high", "balanced", "cheap"].includes(p));
  l.explore = clamp(num(l.explore, 0.2), 0, 0.6);
  l.minSamples = clamp(Math.round(num(l.minSamples, 8)), 2, 100);
  l.coldAfterComments = clamp(Math.round(num(l.coldAfterComments, 6)), 2, 50);
  l.coldCooldownDays = clamp(num(l.coldCooldownDays, 10), 1, 90);
  l.maxChecksPerRun = clamp(Math.round(num(l.maxChecksPerRun, 3)), 0, 10);

  const c = s.cleanup;
  c.afterDays = clamp(num(c.afterDays, 7), 7, 365);
  c.dailyLimit = clamp(Math.round(num(c.dailyLimit, 10)), 0, HARD.dailyUnfollows);
  // Accept profile URLs, @handles and several handles per line, like everywhere else.
  c.whitelist = parseHandleList((Array.isArray(c.whitelist) ? c.whitelist : c.whitelist ? [c.whitelist] : []).map(String).join("\n"));

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
  if (!Array.isArray(s.models) || !s.models.length) s.models = deepClone(DEFAULT_MODELS);
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
  for (const k of ["high", "balanced", "cheap"]) {
    const p = (s.presets[k] ||= { ...DEFAULT_PRESETS[k] });
    if (!ids.has(p.modelId)) p.modelId = s.models[Math.min(s.models.length - 1, k === "high" ? s.models.length - 1 : k === "balanced" ? 1 : 0)].id;
    if (!["low", "medium", "high"].includes(p.effort)) p.effort = DEFAULT_PRESETS[k].effort;
  }
  if (!ids.has(s.fallback.modelId)) s.fallback.modelId = s.models[0].id;
  if (s.fallback.secondModelId && !ids.has(s.fallback.secondModelId)) s.fallback.secondModelId = "";
  if (!["low", "medium", "high"].includes(s.fallback.effort)) s.fallback.effort = "low";
  for (const k of ["A1", "A2", "B1", "B2"]) if (!s.presets[s.presetMatrix[k]]) s.presetMatrix[k] = DEFAULT_SETTINGS.presetMatrix[k];
  if (!s.presets[s.quality.checkerPreset]) s.quality.checkerPreset = "cheap";
  return s;
}

// ---------- typed accessors ----------

export async function getSettings() { return sanitizeSettings(await load(K.settings, {})); }
export async function saveSettings(s) { await save({ [K.settings]: s }); return sanitizeSettings(s); }

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
export async function getSecrets() {
  const migrated = await migrateSecrets();
  if (migrated) return migrated;
  return { ...DEFAULT_SECRETS, ...stripId(await db().get(STORES.kv, SECRETS_ID)) };
}
export function setSecrets(patch) {
  return withLock("secrets", async () => {
    const cur = await getSecrets();
    const next = { ...DEFAULT_SECRETS, ...cur, ...patch };
    await db().put(STORES.kv, { id: SECRETS_ID, ...next });
    await save({ [K.secretsRev]: { rev: now(), hasOpenai: !!next.openaiKey, hasSorsa: !!next.sorsaKey } });
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
export function updateCandidates(fn) { return update(K.candidates, {}, fn); }

// ---------- activity log (capped, redacted) ----------
const LOG_CAP = 400;
export function log(level, msg, data) {
  const entry = { ts: now(), level, msg: redact(String(msg)).slice(0, 500) };
  if (data !== undefined) entry.data = redact(data).slice(0, 800);
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
