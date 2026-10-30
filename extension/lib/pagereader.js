// ScoreX - read data from third-party score sites (Sorsa, TwitterScore, ...).
// Three ways, chosen per provider in lib/providers.js:
//   json  fetch() an API endpoint from the service worker (needs that site's optional host permission)
//   html  fetch() a public page and read embedded JSON (Next.js __NEXT_DATA__, ld+json) or text
//   tab   open the page in a background tab of the user's own Chrome (their cookies, Cloudflare checks
//         pass), read the rendered page with chrome.scripting, close the tab (needs "scripting" too)
// All field paths / selectors are data ("pick specs"), so a changed site is fixed by an override in
// Settings > Scores without new code. Nothing here ever runs code that came from a website.
//
// Pick spec for one value:  { path: "data.score" | ["a.b", "c"] } (JSON)  |  { regex: "Score\\D{0,9}([\\d.,]+[KMB]?)" }
//                           | { selector: ".score", attr?: "content", regex?: "..." } (tab only)
// Pick spec for a list:     { path: "data.items", fields: { handle: [...], name: [...], score: [...], followers: [...] }, limit }
//                           | { selector: "a.row", fields: { handle: { attr: "href", regex: "..." }, score: { selector: ".s" } }, limit } (tab only)
// A spec can also say where JSON lives in a page: { json: "nextData" | "ldjson" | "<css selector of a script tag>" }.

import { now, sleep, redact } from "./util.js";

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

// ---------- pure helpers (shared by the service worker side; the in-page copy is inside pageExtract) ----------

// "a.b[0].c" -> value; alternatives (array) -> first non-empty.
export function pluck(obj, path) {
  if (Array.isArray(path)) {
    for (const p of path) { const v = pluck(obj, p); if (v !== undefined && v !== null && v !== "") return v; }
    return undefined;
  }
  if (path == null || path === "" || path === ".") return obj;
  let cur = obj;
  for (const part of String(path).replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
    if (cur == null || typeof cur !== "object") return undefined;
    if (part === "__proto__" || part === "constructor" || part === "prototype") return undefined;
    cur = Object.prototype.hasOwnProperty.call(cur, part) ? cur[part] : undefined;
  }
  return cur;
}

// "523", "523.4/1000", "1,234", "12.3K" -> number; anything else -> null.
export function toNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v == null) return null;
  const s = String(v).replace(/\s|,/g, "");
  const m = s.match(/-?\d+(?:\.\d+)?([KMB])?/i);
  if (!m) return null;
  const n = parseFloat(m[0]);
  if (!Number.isFinite(n)) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[1] || "").toLowerCase()] || 1;
  return Math.round(n * mult * 100) / 100;
}

export function cleanHandle(v) {
  const s = String(v == null ? "" : v).trim().replace(/^@+/, "").replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "").split(/[/?#]/)[0];
  return HANDLE_RE.test(s) ? s.toLowerCase() : "";
}

// Apply a value spec to JSON and/or text. Returns the raw value (string/number) or undefined.
export function pickValue(spec, { json, text } = {}) {
  if (!spec) return undefined;
  if (spec.path != null && json !== undefined) {
    const v = pluck(json, spec.path);
    if (v !== undefined && v !== null && v !== "") return spec.regex ? matchRegex(String(v), spec.regex) : v;
  }
  if (spec.regex && text != null) return matchRegex(String(text), spec.regex);
  return undefined;
}
function matchRegex(text, re) {
  try {
    const m = text.match(new RegExp(re, "i"));
    return m ? (m[1] !== undefined ? m[1] : m[0]) : undefined;
  } catch (_) { return undefined; }
}

// Map a JSON list spec to [{ handle, name, score, followers }] (invalid handles dropped, deduped).
export function pickList(spec, json) {
  if (!spec || spec.path == null) return [];
  const arr = pluck(json, spec.path);
  if (!Array.isArray(arr)) return [];
  const f = spec.fields || {};
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    if (item == null) continue;
    const handle = cleanHandle(typeof item === "string" ? item : pluck(item, f.handle || ["username", "screen_name", "handle", "twitter_username"]));
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    out.push({
      handle,
      name: typeof item === "object" ? String(pluck(item, f.name || ["name", "display_name"]) || "").slice(0, 80) : "",
      score: typeof item === "object" ? toNumber(pluck(item, f.score || ["score"])) : null,
      followers: typeof item === "object" ? toNumber(pluck(item, f.followers || ["followers_count", "followers"])) : null,
    });
    if (out.length >= (spec.limit || 50)) break;
  }
  return out;
}

// JSON embedded in an HTML page (service-worker side, no DOM): Next.js data, ld+json, or a script by id.
export function jsonFromHtml(html, where = "nextData") {
  const s = String(html || "");
  let m = null;
  if (where === "nextData") m = s.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  else if (where === "ldjson") m = s.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  else if (/^#[\w-]+$/.test(where)) m = s.match(new RegExp(`<script[^>]*id=["']${where.slice(1)}["'][^>]*>([\\s\\S]*?)<\\/script>`, "i"));
  if (!m) return undefined;
  try { return JSON.parse(m[1]); } catch (_) { return undefined; }
}
export function textFromHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim();
}

// ---------- fetch (json / html) ----------

// Classified fetch with a timeout. Never throws. Returns { ok, status, json?, text?, error?, message? }.
export async function fetchData(url, { headers = {}, as = "json", timeoutMs = 20000, fetchImpl } = {}) {
  const f = fetchImpl || globalThis.fetch;
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  let res;
  try {
    res = await f(url, { headers: { Accept: as === "json" ? "application/json" : "text/html,application/xhtml+xml", ...headers }, credentials: "include", signal: ctl ? ctl.signal : undefined });
  } catch (e) {
    return { ok: false, status: 0, error: e && e.name === "AbortError" ? "timeout" : "network", message: redact(String((e && e.message) || e)) };
  } finally { if (timer) clearTimeout(timer); }
  let text = "";
  try { text = await res.text(); } catch (_) {}
  const challenge = /cf-chl|challenge-platform|Just a moment\.\.\.|Attention Required! \| Cloudflare/i.test(text.slice(0, 5000));
  if (res.status === 401) return { ok: false, status: 401, error: "auth", message: "The site rejected the API key (401)" };
  if (res.status === 403) return { ok: false, status: 403, error: challenge ? "blocked" : "auth", message: challenge ? "Blocked by the site's bot check - try the browser-tab mode" : "Access denied (403) - check the key or plan" };
  if (res.status === 429) return { ok: false, status: 429, error: "rate", message: "Rate limit or quota reached (429)" };
  if (res.status === 404) return { ok: false, status: 404, error: "not_found", message: "Not found (404)" };
  if (!res.ok) return { ok: false, status: res.status, error: "http", message: `HTTP ${res.status}` };
  if (challenge) return { ok: false, status: res.status, error: "blocked", message: "Blocked by the site's bot check - try the browser-tab mode" };
  if (as === "json") {
    try { return { ok: true, status: res.status, json: JSON.parse(text) }; } catch (_) { return { ok: false, status: res.status, error: "parse", message: "The answer was not JSON (site changed?)" }; }
  }
  return { ok: true, status: res.status, text };
}

// ---------- tab (rendered page) ----------

// Runs INSIDE the third-party page (chrome.scripting). Must be self-contained: no outer variables.
// spec: { json?, score?, max?, list?, notFound?: regex, loginWall?: regex }. Returns plain data only.
export function pageExtract(spec) {
  function pluckP(obj, path) {
    if (Array.isArray(path)) { for (const p of path) { const v = pluckP(obj, p); if (v !== undefined && v !== null && v !== "") return v; } return undefined; }
    if (path == null || path === "") return obj;
    let cur = obj;
    for (const part of String(path).replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
      if (cur == null || typeof cur !== "object" || part === "__proto__" || part === "constructor") return undefined;
      cur = Object.prototype.hasOwnProperty.call(cur, part) ? cur[part] : undefined;
    }
    return cur;
  }
  function rx(text, re) { try { const m = String(text).match(new RegExp(re, "i")); return m ? (m[1] !== undefined ? m[1] : m[0]) : undefined; } catch (e) { return undefined; } }
  function txt(el) { return el ? (el.innerText || el.textContent || "").trim() : ""; }
  function readJson(where) {
    let el = null;
    if (where === "nextData") el = document.getElementById("__NEXT_DATA__");
    else if (where === "ldjson") el = document.querySelector('script[type="application/ld+json"]');
    else if (where) { try { el = document.querySelector(where); } catch (e) { el = null; } }
    if (!el) return undefined;
    try { return JSON.parse(el.textContent || ""); } catch (e) { return undefined; }
  }
  function field(root, f, json) {
    if (!f) return undefined;
    if (f.path != null && json !== undefined) { const v = pluckP(json, f.path); if (v !== undefined && v !== null && v !== "") return f.regex ? rx(String(v), f.regex) : v; }
    let el = root;
    if (f.selector) { try { el = root.querySelector(f.selector); } catch (e) { el = null; } }
    if (!el) return undefined;
    const raw = f.attr ? el.getAttribute(f.attr) : txt(el);
    if (raw == null) return undefined;
    return f.regex ? rx(raw, f.regex) : raw;
  }
  const bodyText = txt(document.body).slice(0, 20000);
  const out = { url: location.href, title: document.title };
  if (spec.notFound && rx(bodyText, spec.notFound) !== undefined) { out.notFound = true; return out; }
  if (spec.loginWall && rx(bodyText, spec.loginWall) !== undefined) out.loginWall = true;
  const json = spec.json ? readJson(spec.json) : undefined;
  if (spec.score) { const v = field(document, spec.score, json); out.score = v === undefined ? (spec.score.regex ? rx(bodyText, spec.score.regex) : undefined) : v; }
  if (spec.max) out.max = field(document, spec.max, json);
  if (spec.list) {
    const L = spec.list, items = [];
    if (L.path != null && json !== undefined) {
      const arr = pluckP(json, L.path);
      if (Array.isArray(arr)) for (const it of arr) items.push({ json: it });
    } else if (L.selector) {
      let nodes = [];
      try { nodes = Array.prototype.slice.call(document.querySelectorAll(L.selector)); } catch (e) { nodes = []; }
      for (const n of nodes) items.push({ el: n });
    }
    out.list = items.slice(0, (L.limit || 50) * 2).map(function (it) {
      const f = L.fields || {};
      if (it.json !== undefined) {
        const j = it.json;
        if (typeof j === "string") return { handle: j };
        return { handle: pluckP(j, (f.handle && f.handle.path) || ["username", "screen_name", "handle"]), name: pluckP(j, (f.name && f.name.path) || ["name"]), score: pluckP(j, (f.score && f.score.path) || ["score"]), followers: pluckP(j, (f.followers && f.followers.path) || ["followers_count", "followers"]) };
      }
      return { handle: field(it.el, f.handle || { attr: "href", regex: "(?:x|twitter)\\.com/([A-Za-z0-9_]{1,15})" }), name: field(it.el, f.name), score: field(it.el, f.score), followers: field(it.el, f.followers) };
    });
  }
  out.textSample = bodyText.slice(0, 600);
  return out;
}

// Normalise what pageExtract returned (in the service worker, never trusting page data).
export function normalizeExtract(raw, spec = {}) {
  if (!raw || typeof raw !== "object") return { ok: false, error: "parse", message: "Nothing could be read from the page" };
  if (raw.notFound) return { ok: false, error: "not_found", message: "The site has no data for this account" };
  const out = { ok: true, url: typeof raw.url === "string" ? raw.url.slice(0, 300) : "" };
  if (spec.score) {
    out.score = toNumber(raw.score);
    if (out.score == null) return { ok: false, error: raw.loginWall ? "login" : "parse", message: raw.loginWall ? "The site wants you to log in - open it once in Chrome and log in" : "Score not found on the page (site changed? update the provider in Settings > Scores)" };
  }
  if (spec.max) out.max = toNumber(raw.max);
  if (spec.list) {
    const seen = new Set();
    out.list = [];
    for (const it of Array.isArray(raw.list) ? raw.list : []) {
      const handle = cleanHandle(it && it.handle);
      if (!handle || seen.has(handle)) continue;
      seen.add(handle);
      out.list.push({ handle, name: String((it && it.name) || "").trim().slice(0, 80), score: toNumber(it && it.score), followers: toNumber(it && it.followers) });
      if (out.list.length >= (spec.list.limit || 50)) break;
    }
    if (!out.list.length && raw.loginWall) return { ok: false, error: "login", message: "The site wants you to log in to show followers" };
  }
  return out;
}

let readerLock = Promise.resolve();
// Open `url` in a background tab, poll pageExtract(spec) until it finds data (pages that render with
// JavaScript need a moment), close the tab. One page at a time. Never throws.
export function readPageInTab(url, spec, { timeoutMs = 30000, settleMs = 1500, windowId } = {}) {
  const run = async () => {
    let tab = null;
    const until = now() + timeoutMs;
    try {
      tab = await chrome.tabs.create({ url, active: false, ...(windowId != null ? { windowId } : {}) });
      try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch (_) {}
      await waitComplete(tab.id, Math.min(timeoutMs, 25000));
      await sleep(settleMs);
      let last = null;
      while (now() < until) {
        let res = null;
        try {
          const r = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageExtract, args: [spec] });
          res = r && r[0] ? r[0].result : null;
        } catch (e) {
          return { ok: false, error: "permission", message: "Chrome did not allow reading this site - enable the provider again to grant access" };
        }
        last = normalizeExtract(res, spec);
        if (last.ok || last.error === "not_found") return last;
        await sleep(1500);
      }
      return last || { ok: false, error: "timeout", message: "The page did not finish loading" };
    } catch (e) {
      return { ok: false, error: "tab", message: redact(String((e && e.message) || e)) };
    } finally {
      if (tab) { try { await chrome.tabs.remove(tab.id); } catch (_) {} }
    }
  };
  const p = readerLock.then(run, run);
  readerLock = p.catch(() => {});
  return p;
}

function waitComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); try { chrome.tabs.onUpdated.removeListener(onUpd); } catch (_) {} resolve(v); };
    const onUpd = (id, info) => { if (id === tabId && info.status === "complete") finish(true); };
    const t = setTimeout(() => finish(false), timeoutMs);
    try { chrome.tabs.onUpdated.addListener(onUpd); } catch (_) { finish(false); return; }
    chrome.tabs.get(tabId).then((tb) => { if (tb && tb.status === "complete") finish(true); }).catch(() => finish(false));
  });
}
