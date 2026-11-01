// ScoreX - small pure helpers shared by the service worker, the dashboard and the tests.
// Nothing in this file touches chrome.* so it can be imported by Node unit tests.

export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// Injectable clock + RNG so scheduler/safety logic is deterministic in tests.
let clock = () => Date.now();
let rng = Math.random;
export function now() { return clock(); }
export function random() { return rng(); }
export function _setClock(fn) { clock = fn || (() => Date.now()); }
export function _setRandom(fn) { rng = fn || Math.random; }

export function randInt(min, max) {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return lo + Math.floor(random() * (hi - lo + 1));
}
export function randFloat(min, max) { return min + random() * (max - min); }
export function chance(p) { return random() < p; }
export function pick(arr) { return arr.length ? arr[Math.floor(random() * arr.length)] : undefined; }
export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// Sample n items without replacement.
export function sample(arr, n) { return shuffle(arr).slice(0, Math.max(0, n)); }

// Human-ish delay: mostly in [min,max], skewed towards the lower half, with a rare long tail.
export function humanDelay(minMs, maxMs) {
  const u = (random() + random()) / 2; // triangular, centred
  let ms = minMs + u * (maxMs - minMs);
  if (chance(0.06)) ms += randFloat(0.3, 1.2) * (maxMs - minMs);
  return Math.round(ms);
}

export function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
export function num(v, def = 0) { const n = Number(v); return Number.isFinite(n) ? n : def; }

export function uid(prefix = "") {
  const r = Math.floor(random() * 0xffffffff).toString(36);
  return prefix + now().toString(36) + r;
}

// ---------- handles ----------

// Accepts "@name", "name", "https://x.com/name", "x.com/name/status/1", "twitter.com/name", "twitterscore.io/twitter/name".
// Returns the lowercase handle or "" when invalid.
// Also never accept names that collide with Object prototype keys (handle-keyed maps are plain objects).
const RESERVED = new Set(["home", "explore", "notifications", "messages", "i", "search", "settings", "compose", "login", "logout", "signup", "tos", "privacy", "hashtag", "intent", "share", "__proto__", "constructor", "prototype", "hasownproperty", "tostring", "valueof"]);
export function normalizeHandle(raw) {
  if (raw == null) return "";
  let s = String(raw).trim();
  if (!s) return "";
  const m = s.match(/(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i)
    || s.match(/(?:https?:\/\/)?(?:www\.)?twitterscore\.io\/twitter\/@?([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i); // a TwitterScore profile
  if (m) s = m[1];
  else if (/^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i.test(s) || /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\//i.test(s)) return ""; // a link to some other site
  s = s.replace(/^@+/, "").replace(/[^A-Za-z0-9_].*$/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(s)) return "";
  const h = s.toLowerCase();
  return RESERVED.has(h) ? "" : h;
}

// Split pasted text (newlines, commas, spaces, tabs, semicolons) into unique handles.
export function parseHandleList(text) {
  const out = [];
  const seen = new Set();
  for (const part of String(text || "").split(/[\s,;]+/)) {
    const h = normalizeHandle(part);
    if (h && !seen.has(h)) { seen.add(h); out.push(h); }
  }
  return out;
}

export function tweetIdFromUrl(url) {
  const m = String(url || "").match(/\/status(?:es)?\/(\d{5,25})/);
  return m ? m[1] : "";
}
export function tweetUrl(handle, id) { return `https://x.com/${handle}/status/${id}`; }

// "12.3K" / "1,234" / "1.2M" / "3B" -> number. Returns null when unparseable.
export function parseCount(text) {
  if (text == null) return null;
  const s = String(text).replace(/\s/g, "").replace(/,/g, "");
  const m = s.match(/^([\d.]+)([KMB])?/i);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || "").toLowerCase()] || 1;
  return Math.round(n * mult);
}

export function fmtCount(n) {
  if (n == null || !Number.isFinite(n)) return "-";
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.round(n));
}

export function fmtUsd(v, digits) {
  const n = num(v);
  const d = digits != null ? digits : n !== 0 && Math.abs(n) < 0.01 ? 4 : 2;
  return "$" + n.toFixed(d);
}

// ---------- time zones ----------

const dtfCache = new Map();
function dtf(timeZone) {
  const key = timeZone || "UTC";
  if (!dtfCache.has(key)) {
    let f;
    try {
      f = new Intl.DateTimeFormat("en-CA", { timeZone: key, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "short" });
    } catch (_) {
      f = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "short" });
    }
    dtfCache.set(key, f);
  }
  return dtfCache.get(key);
}

export function isValidTimeZone(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch (_) { return false; }
}

// Wall-clock parts of `ts` in `timeZone`.
export function zonedParts(ts, timeZone) {
  const parts = {};
  for (const p of dtf(timeZone).formatToParts(new Date(ts))) parts[p.type] = p.value;
  const hour = Number(parts.hour) % 24;
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour, minute: Number(parts.minute), second: Number(parts.second),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday),
  };
}

// "YYYY-MM-DD" for ts in timeZone.
export function dayKey(ts, timeZone) {
  const p = zonedParts(ts, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
export function monthKey(ts, timeZone) { return dayKey(ts, timeZone).slice(0, 7); }

// ISO week key "YYYY-Www" in timeZone.
export function weekKey(ts, timeZone) {
  const p = zonedParts(ts, timeZone);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - dow + 3); // Thursday of this week
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThu) / DAY - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Offset (ms) of timeZone from UTC at instant ts: local = utc + offset.
export function tzOffset(ts, timeZone) {
  const p = zonedParts(ts, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

// UTC timestamp of local wall time (y-m-d h:m) in timeZone. Handles DST by re-checking the offset.
export function zonedTime(y, m, d, h, min, timeZone) {
  const guess = Date.UTC(y, m - 1, d, h, min);
  let ts = guess - tzOffset(guess, timeZone);
  const off2 = tzOffset(ts, timeZone);
  ts = guess - off2;
  return ts;
}

// Calendar date n days after the local date p ({year, month, day}), independent of DST day lengths.
function addDays(p, n) {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// Start of the local day containing ts.
export function startOfDay(ts, timeZone) {
  const p = zonedParts(ts, timeZone);
  return zonedTime(p.year, p.month, p.day, 0, 0, timeZone);
}

// "HH:MM" -> minutes since midnight (24:00 allowed = 1440). Returns null on bad input.
export function parseHHMM(s) {
  const m = String(s || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 24 || mi > 59 || (h === 24 && mi > 0)) return null;
  return h * 60 + mi;
}

// Is ts inside the daily window [start,end) in timeZone? Windows may cross midnight
// ("10:00"-"00:00" means 10:00 until midnight; "22:00"-"02:00" crosses it). start===end means 24h.
export function inWindow(ts, startHHMM, endHHMM, timeZone) {
  const s = parseHHMM(startHHMM), e = parseHHMM(endHHMM);
  if (s == null || e == null) return true;
  const p = zonedParts(ts, timeZone);
  const cur = p.hour * 60 + p.minute;
  const end = e === 0 ? 1440 : e;
  if (s === end || (s === 0 && end === 1440)) return true; // 24h window
  if (s < end) return cur >= s && cur < end;
  return cur >= s || cur < end; // crosses midnight
}

// Instants at which the local wall clock of day q shows `minutes` after midnight, earliest first: one on most days,
// two when a DST fall-back repeats that time (01:30 in New York on the fall-back day: 01:30 EDT, then 01:30 EST).
// A wall time inside a spring-forward gap (02:30 in New York on the DST day) does not exist: zonedTime maps it an
// hour early or late, so the answer is then the transition instant itself (03:00 EDT), found by bisection.
function wallClockTimes(q, minutes, timeZone) {
  const h = Math.floor(minutes / 60), mi = minutes % 60;
  const target = Date.UTC(q.year, q.month - 1, q.day, h, mi);
  const t = zonedTime(q.year, q.month, q.day, h, mi, timeZone);
  const wall = (x) => x + tzOffset(x, timeZone);
  // zonedTime finds one of them; the offsets in force 3 hours before and after it give the other one, if any.
  const out = [...new Set([target - tzOffset(t - 3 * HOUR, timeZone), t, target - tzOffset(t + 3 * HOUR, timeZone)])]
    .filter((x) => wall(x) === target).sort((a, b) => a - b);
  if (out.length) return out;
  let lo = t - 3 * HOUR, hi = t + 3 * HOUR;
  if (wall(lo) >= target || wall(hi) < target) return [t];
  while (hi - lo > MIN) {
    const mid = lo + Math.floor((hi - lo) / (2 * MIN)) * MIN;
    if (wall(mid) >= target) hi = mid; else lo = mid;
  }
  return [hi];
}

// Next instant >= ts at which the window opens (ts itself if already inside): the first time after ts that the wall
// clock shows the start time inside the window. On a DST fall-back day that can be the start's second occurrence (a
// tick in the repeated hour still gets that day's window); a window that falls in a spring-forward gap is skipped.
export function nextWindowStart(ts, startHHMM, endHHMM, timeZone) {
  if (inWindow(ts, startHHMM, endHHMM, timeZone)) return ts;
  const s = parseHHMM(startHHMM);
  const p = zonedParts(ts, timeZone);
  for (let i = 0; i < 3; i++) {
    for (const c of wallClockTimes(addDays(p, i), s, timeZone)) if (c > ts && inWindow(c, startHHMM, endHHMM, timeZone)) return c;
  }
  return wallClockTimes(addDays(p, 1), s, timeZone)[0];
}

// Instant at which the current window closes (only meaningful when inside).
export function currentWindowEnd(ts, startHHMM, endHHMM, timeZone) {
  const e = parseHHMM(endHHMM);
  if (e == null) return ts + DAY;
  // Step by calendar days (not ts + 24h): DST days are 23h/25h long and "+24h" can skip or repeat a day. "24:00" maps
  // to 00:00 of today here, which has passed, so tomorrow's is taken.
  let d = zonedParts(ts, timeZone);
  for (let i = 0; i < 5; i++, d = addDays(d, 1)) {
    const c = wallClockTimes(d, e % 1440, timeZone).find((x) => x > ts);
    if (c != null) return c;
  }
  return ts + DAY;
}

export function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return "-";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + "s";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 48) return rm ? `${h}h ${rm}m` : `${h}h`;
  return Math.round(h / 24) + "d";
}

// ---------- text ----------

export function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/https?:\/\/\S+/g, " ")
    // Combining marks stay (Bengali / Hindi vowel signs and viramas are part of the word); marks that no
    // longer follow a letter (emoji variation selectors, keycaps) are dropped.
    .replace(/[^\p{L}\p{M}\p{N}\s']/gu, " ")
    .replace(/(^|[^\p{L}\p{M}])\p{M}+/gu, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
export function words(s) { const t = normalizeText(s); return t ? t.split(" ") : []; }

export function ngrams(tokens, n) {
  const out = new Set();
  for (let i = 0; i + n <= tokens.length; i++) out.add(tokens.slice(i, i + n).join(" "));
  return out;
}
export function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const EMOJI_RE = /\p{Extended_Pictographic}/gu;
export function countEmoji(s) {
  // Count pictographs, collapsing ZWJ sequences / modifiers into one.
  const t = String(s || "").replace(/‍\p{Extended_Pictographic}/gu, "").replace(/[\u{1F3FB}-\u{1F3FF}️]/gu, "");
  const m = t.match(EMOJI_RE);
  const flags = t.match(/[\u{1F1E6}-\u{1F1FF}]{2}/gu);
  const keycaps = t.match(/[0-9#*]\uFE0F?\u20E3/gu);
  return (m ? m.length : 0) + (flags ? flags.length : 0) + (keycaps ? keycaps.length : 0);
}

export function truncate(s, n) {
  const t = String(s || "");
  return t.length > n ? t.slice(0, Math.max(0, n - 1)) + "…" : t;
}

// Never let an API key reach a log line, an error message or an export.
export function redact(v) {
  const s = typeof v === "string" ? v : (() => { try { return JSON.stringify(v); } catch (_) { return String(v); } })();
  return String(s)
    .replace(/sk-[A-Za-z0-9_\-]{8,}/g, "sk-***")
    .replace(/(Bearer\s+)[A-Za-z0-9_\-.]{8,}/gi, "$1***")
    .replace(/("?(?:api[_-]?key|authorization|openaiKey|sorsaKey|twitterscoreKey|moniKey)"?\s*[:=]\s*")[^"]+/gi, "$1***")
    .replace(/([?&](?:api[_-]?key|key|token|access[_-]?token)=)[^&#\s"']+/gi, "$1***");
}

export function csvEscape(v) {
  if (v == null) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  // Neutralise spreadsheet formula injection from tweet text.
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}
export function toCsv(rows, columns) {
  const head = columns.map((c) => csvEscape(c.label || c.key)).join(",");
  const body = rows.map((r) => columns.map((c) => csvEscape(typeof c.get === "function" ? c.get(r) : r[c.key])).join(","));
  return [head, ...body].join("\r\n");
}

export function deepMerge(base, over) {
  if (Array.isArray(base) || Array.isArray(over)) return over !== undefined ? over : base;
  if (base && typeof base === "object" && over && typeof over === "object") {
    const out = { ...base };
    for (const k of Object.keys(over)) out[k] = k in base ? deepMerge(base[k], over[k]) : over[k];
    return out;
  }
  return over !== undefined ? over : base;
}

export function deepClone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
