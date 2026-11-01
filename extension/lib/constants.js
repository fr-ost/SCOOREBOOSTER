// ScoreX - shared constants. Keep string values stable: they are persisted in storage and history.

export const APP = "ScoreX";
export const VERSION = "1.3.0";

// chrome.storage.local keys
export const K = Object.freeze({
  settings: "sx.settings",
  secrets: "sx.secrets", // legacy location only (migrated): keys now live in the extension IndexedDB "kv" store
  secretsRev: "sx.secretsRev", // { rev, hasOpenai, hasSorsa, has: { [keyName]: bool } } - no key material; lets open pages refresh
  state: "sx.state",
  targets: "sx.targets", // { [handle]: Target }
  candidates: "sx.candidates", // { [handle]: Candidate }
  seen: "sx.seen", // { [postId]: ts } recently seen posts (capped)
  logs: "sx.logs", // ActivityLog[] (capped)
  discovery: "sx.discovery", // current/last discovery job
  selectorOverrides: "sx.selectorOverrides", // partial selector config JSON, merged over content/selectors.js
  learning: "sx.learning", // A/B arms + suggestions cache
  spend: "sx.spend", // { days: {YYYY-MM-DD: usd}, months: {YYYY-MM: usd} } authoritative ledger for budgets
  blacklist: "sx.blacklist", // { [handle]: { handle, name, reason, at, days, comments, tier } } never re-added as targets
  scoreboard: "sx.scoreboard", // your scores per provider (+ history), score checks, smart followers, usage
  providerOverrides: "sx.providerOverrides", // partial provider definitions JSON, merged over lib/providerdefs.js
  conversations: "sx.conversations", // { items: [{ id, target, comment, replyUrl, authorReplyUrl, text, at, done }], checkedAt } author replies to answer
  schema: "sx.schemaVersion",
  followbacks: "sx.followbacks", // [{ handle, at, comments, days, lastComment, ... }] lib/followbacks.js, newest first
  license: "sx.license", // { key, deviceId, status, checkedAt, ... } lib/license.js; kept by Reset everything, never backed up
});

export const SCHEMA_VERSION = 1;

// Runtime status shown everywhere ("Running / Paused / Stopped (reason)").
export const STATUS = Object.freeze({ RUNNING: "running", PAUSED: "paused", STOPPED: "stopped" });

export const MODE = Object.freeze({ REVIEW: "review", AUTO: "auto" });

// Kept in sync with the follow status by follow tracking: A = follows me (never commented on), B = does not.
export const GROUP = Object.freeze({ A: "A", B: "B" });
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
  UNKNOWN_PROMPT: "unknown_prompt", // X showed a dialog/notice ScoreX does not know (e.g. an AI-label prompt): never clicked
  ACCOUNT_UNKNOWN: "account_unknown", // the logged-in account could not be verified several times in a row
  REACH_DROP: "reach_drop", // your replies' views fell sharply (possible hidden replies); only when safety.reach.action = "stop"
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
  unknown_prompt: "X showed a prompt ScoreX does not know",
  account_unknown: "Could not verify which X account is logged in",
  reach_drop: "Your replies are reaching far fewer people",
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
  unknown_prompt: STOP.UNKNOWN_PROMPT, // (reported by content actions today; a page report with it stops as well)
  wrong_account: STOP.WRONG_ACCOUNT,
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
  FOLLOW: "follow",
  REPLY_STATS: "replyStats",
  SELF_TEST: "selfTest", // counts which selectors match on the current page (Diagnostics)
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
  SCORES: "sx.scores", // refreshes your own scores on the enabled providers (about once a day)
});

// Absolute safety caps. Settings are clamped to these and cannot be raised from the UI.
export const HARD = Object.freeze({
  dailyComments: 300,
  dailyLikes: 300, // likes only happen right before a comment, so they never exceed the comments
  dailyUnfollows: 30,
  dailyFollows: 300, // follow-first: accounts followed per 24 h at most (= accountsPerDay; X itself allows 400)
  minGapMin: 2, // never two comments closer than this
  perTargetDay: 2,
  perTargetWeek: 14,
  accountsPerDay: 300, // different accounts commented on per 24 hours
  maxCommentChars: 280,
  maxPostFailures: 5,
  minCheckIntervalSec: 90,
});

export const BUILTIN_TONES = Object.freeze(["casual", "delta", "chill", "sharp", "question", "witty", "insightful", "bold", "friendly", "expert"]);

export const EFFORTS = Object.freeze(["low", "medium", "high"]);

export const PRESET_KEYS = Object.freeze(["human", "high", "balanced", "cheap"]);
