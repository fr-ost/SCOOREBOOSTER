// ScoreX - shared constants. Keep string values stable: they are persisted in storage and history.

export const APP = "ScoreX";
export const VERSION = "1.0.0";

// chrome.storage.local keys
export const K = Object.freeze({
  settings: "sx.settings",
  secrets: "sx.secrets", // { openaiKey, sorsaKey } - never exported, never logged
  state: "sx.state",
  targets: "sx.targets", // { [handle]: Target }
  candidates: "sx.candidates", // { [handle]: Candidate }
  seen: "sx.seen", // { [postId]: ts } recently seen posts (capped)
  logs: "sx.logs", // ActivityLog[] (capped)
  discovery: "sx.discovery", // current/last discovery job
  selectorOverrides: "sx.selectorOverrides", // partial selector config JSON, merged over content/selectors.js
  learning: "sx.learning", // A/B arms + suggestions cache
  spend: "sx.spend", // { days: {YYYY-MM-DD: usd}, months: {YYYY-MM: usd} } authoritative ledger for budgets
  schema: "sx.schemaVersion",
});

export const SCHEMA_VERSION = 1;

// Runtime status shown everywhere ("Running / Paused / Stopped (reason)").
export const STATUS = Object.freeze({ RUNNING: "running", PAUSED: "paused", STOPPED: "stopped" });

export const MODE = Object.freeze({ REVIEW: "review", AUTO: "auto" });

export const GROUP = Object.freeze({ A: "A", B: "B" }); // A = follows me (keep warm), B = does not follow me (get noticed)
export const TIER = Object.freeze({ T1: 1, T2: 2 }); // 1 = big influencer, 2 = smart account

// History record statuses (one record per generated comment / attempt).
export const HS = Object.freeze({
  PENDING_REVIEW: "pending_review", // waiting in the review queue
  APPROVED: "approved", // approved in review, waiting for its posting slot
  QUEUED: "queued", // full auto: generated and waiting for its posting slot
  POSTING: "posting", // a posting attempt is in flight
  POSTED: "posted",
  SKIPPED: "skipped", // rejected by a rule, quality check, the user or expiry
  FAILED: "failed",
});
export const OPEN_STATUSES = [HS.PENDING_REVIEW, HS.APPROVED, HS.QUEUED, HS.POSTING];

// Why the engine stopped. Safety stops (everything except USER) need a manual resume.
export const STOP = Object.freeze({
  USER: "user",
  CAPTCHA: "captcha",
  WARNING: "unusual_activity",
  RATE_LIMIT: "rate_limit",
  LOCKED: "account_locked",
  LOGGED_OUT: "logged_out",
  WRONG_ACCOUNT: "wrong_account",
  POST_FAILURES: "repeated_post_failures",
  DOM_CHANGED: "dom_changed",
  BUDGET: "budget_reached",
  OPENAI_AUTH: "openai_auth",
  OPENAI_QUOTA: "openai_quota",
  NO_API_KEY: "no_api_key",
  TAB_UNAVAILABLE: "tab_unavailable",
  INTERNAL: "internal_error",
});

export const STOP_LABEL = Object.freeze({
  user: "Stopped by you",
  captcha: "Captcha / human verification shown",
  unusual_activity: "X warning: unusual or automated activity",
  rate_limit: "X rate limit reached",
  account_locked: "Account locked or restricted",
  logged_out: "Logged out of X",
  wrong_account: "Logged into a different X account",
  repeated_post_failures: "Repeated posting failures",
  dom_changed: "X page changed - selectors need an update",
  budget_reached: "Monthly OpenAI budget reached",
  openai_auth: "OpenAI API key rejected",
  openai_quota: "OpenAI quota exhausted / billing issue",
  no_api_key: "No OpenAI API key set",
  tab_unavailable: "Could not open the X tab",
  internal_error: "Internal error",
});

// Page states reported by the content script (content/detect.js uses the same strings).
export const PAGE = Object.freeze({
  OK: "ok",
  LOADING: "loading",
  LOGGED_OUT: "logged_out",
  CAPTCHA: "captcha",
  LOCKED: "locked",
  RATE_LIMIT: "rate_limit",
  WARNING: "warning",
  ERROR_PAGE: "error_page", // "Something went wrong. Try reloading." - soft, retry once
  NOT_FOUND: "not_found", // deleted post / suspended account - skip, not a stop
  DOM_CHANGED: "dom_changed",
});

export const PAGE_TO_STOP = Object.freeze({
  logged_out: STOP.LOGGED_OUT,
  captcha: STOP.CAPTCHA,
  locked: STOP.LOCKED,
  rate_limit: STOP.RATE_LIMIT,
  warning: STOP.WARNING,
  dom_changed: STOP.DOM_CHANGED,
});

// Content-script command names (SW -> content via chrome.tabs.sendMessage({ sx: CMD, ...args })).
export const CMD = Object.freeze({
  PING: "ping",
  PAGE_STATE: "pageState",
  WAIT_FOR: "waitFor",
  SCRAPE_TWEETS: "scrapeTweets",
  SCRAPE_PROFILE: "scrapeProfile",
  SCRAPE_USERS: "scrapeUsers",
  SCRAPE_STATUS: "scrapeStatus",
  SCROLL: "scroll",
  LIKE: "like",
  OPEN_COMPOSER: "openComposer",
  TYPE: "type",
  COMPOSER_TEXT: "composerText",
  CLEAR_COMPOSER: "clearComposer",
  CLOSE_COMPOSER: "closeComposer",
  SUBMIT_REPLY: "submitReply",
  REPLY_RESULT: "replyResult",
  FOLLOW_STATE: "followState",
  UNFOLLOW: "unfollow",
  REPLY_STATS: "replyStats",
});

// Runtime messages (content/UI -> SW via chrome.runtime.sendMessage({ sx: MSG, ... })).
export const MSG = Object.freeze({
  CONTENT_READY: "contentReady",
  HEARTBEAT: "heartbeat",
  PAGE_PROBLEM: "pageProblem",
  // UI -> SW
  START: "start",
  PAUSE: "pause",
  STOP: "stop",
  RESUME: "resume",
  RUN_NOW: "runNow",
  SET_MODE: "setMode",
  REVIEW_ACTION: "reviewAction", // { id, action: approve|skip|regenerate|edit, text }
  TEST_OPENAI: "testOpenAI",
  ESTIMATE: "estimate",
  DISCOVERY_START: "discoveryStart",
  DISCOVERY_CANCEL: "discoveryCancel",
  REFRESH_TARGET: "refreshTarget",
  SORSA_REFRESH: "sorsaRefresh",
  CLEAR_BADGE: "clearBadge",
  GET_STATUS: "getStatus",
  LEARNING_RUN: "learningRun",
  CLEANUP_PREVIEW: "cleanupPreview",
});

export const ALARM = Object.freeze({
  TICK: "sx.tick", // main randomized scheduler tick (one-shot, re-armed each time)
  WATCHDOG: "sx.watchdog", // periodic safety net: re-arms TICK if it went missing
});

// Absolute safety caps. Settings are clamped to these and cannot be raised from the UI.
export const HARD = Object.freeze({
  dailyComments: 30,
  dailyLikes: 50,
  dailyUnfollows: 30,
  minGapMin: 2, // never two comments closer than this
  perTargetDay: 1,
  perTargetWeek: 3,
  warmupDays: 3,
  maxCommentChars: 280,
  maxPostFailures: 5,
  minCheckIntervalSec: 90,
});

export const BUILTIN_TONES = Object.freeze(["witty", "insightful", "bold", "friendly", "expert"]);

export const EFFORTS = Object.freeze(["low", "medium", "high"]);

export const PRESET_KEYS = Object.freeze(["high", "balanced", "cheap"]);
