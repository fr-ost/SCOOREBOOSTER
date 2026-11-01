// ScoreX - score providers: third-party sites that rate X accounts. Every provider is OFF until you enable
// it in the Scores tab; Chrome then asks for access to that site. Only X handles are sent to it.
//
// A provider definition is pure data (endpoints, headers, field paths, page selectors), so when a site
// changes, Settings > Scores > Provider overrides can patch it without new code. Modes:
//   api    the site's API with YOUR key (stored only in the extension, like the OpenAI key)
//   public a public JSON endpoint or public page fetched without a key
//   page   the site's page opened in a background tab of your own Chrome and read there (your login and the
//          site's bot checks work as when you browse it); needs the optional "scripting" permission
// Capabilities: score (an account's score) and smartFollowers (an account's top / smart followers).

import { fetchData, pickValue, pickList, jsonFromHtml, textFromHtml, readPageInTab, toNumber, pluck } from "./pagereader.js";
import { deepMerge, deepClone, clamp, num } from "./util.js";
import { PROVIDER_DEFS } from "./providerdefs.js";

export const CAPS = ["score", "smartFollowers"];

// Built-in definitions merged with the user's overrides (only known providers / modes / fields).
export function providerDefs(overrides) {
  const base = deepClone(PROVIDER_DEFS);
  if (!overrides || typeof overrides !== "object") return base;
  for (const [id, o] of Object.entries(overrides)) {
    if (!Object.hasOwn(base, id) || !o || typeof o !== "object") continue;
    base[id] = deepMerge(base[id], sanitizeOverride(o, base[id]));
  }
  return base;
}

// Overrides may only change URLs on the provider's own hosts (https), headers, paths, selectors and regexes of the
// modes the provider already has. Identity fields (id, keyName, hosts, profileUrl, site, caps...) are never taken:
// e.g. a keyName override would send another secret (your OpenAI key) to this provider's site.
const TOP_KEYS = new Set(["notFound", "loginWall", "max", "listLimit", "minIntervalMs", "modes"]);
const SPEC_KINDS = ["json", "html", "tab"];
function sanitizeOverride(o, def) {
  const hostsOk = (url) => {
    try {
      const u = new URL(String(url).replace(/\{[a-z]+\}/gi, "x"));
      if (u.protocol !== "https:") return false;
      return allHosts(def).some((pat) => hostMatches(pat, u.hostname));
    } catch (_) { return false; }
  };
  const clean = (v, depth = 0) => {
    if (depth > 6) return undefined;
    if (Array.isArray(v)) return v.slice(0, 20).map((x) => clean(x, depth + 1)).filter((x) => x !== undefined);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (k === "__proto__" || k === "constructor" || k === "prototype" || k === "hosts") continue;
        if ((k === "url" || k === "pageUrl") && !hostsOk(x)) continue;
        if (k === "headers") { const h = cleanHeaders(x); if (h) out[k] = h; continue; }
        if (k === "kind" && !SPEC_KINDS.includes(x)) continue;
        const c = clean(x, depth + 1);
        if (c !== undefined) out[k] = c;
      }
      return out;
    }
    if (typeof v === "string") return v.slice(0, 500);
    if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
    if (typeof v === "boolean") return v;
    return undefined;
  };
  const out = {};
  if (!o || typeof o !== "object" || Array.isArray(o)) return out;
  for (const k of Object.keys(o)) {
    if (!TOP_KEYS.has(k)) continue;
    if (k === "modes") {
      if (!o.modes || typeof o.modes !== "object") continue;
      const modes = {};
      for (const [mode, m] of Object.entries(o.modes)) {
        if (!Object.hasOwn(def.modes || {}, mode) || !m || typeof m !== "object") continue; // no new modes
        const mm = {};
        for (const cap of CAPS) if (m[cap] && typeof m[cap] === "object" && !Array.isArray(m[cap])) mm[cap] = clean(m[cap]);
        modes[mode] = mm;
      }
      out.modes = modes;
    } else if (k === "notFound" || k === "loginWall") {
      if (typeof o[k] === "string") out[k] = o[k].slice(0, 500);
    } else if (typeof o[k] === "number" && Number.isFinite(o[k])) out[k] = o[k];
  }
  return out;
}

// Header names are HTTP tokens; values never carry line breaks or control characters (no header injection).
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const FORBIDDEN_HEADERS = new Set(["cookie", "cookie2", "host", "origin", "referer", "connection", "content-length", "proxy-authorization"]);
function cleanHeaders(h) {
  if (!h || typeof h !== "object" || Array.isArray(h)) return null;
  const out = {};
  for (const [k, v] of Object.entries(h).slice(0, 10)) {
    if (!HEADER_NAME.test(k) || FORBIDDEN_HEADERS.has(k.toLowerCase()) || k.toLowerCase().startsWith("sec-") || k.toLowerCase().startsWith("proxy-")) continue;
    if (typeof v !== "string" && typeof v !== "number") continue;
    out[k] = headerValue(String(v)).slice(0, 500);
  }
  return out;
}
const headerValue = (v) => String(v).replace(/[\u0000-\u001f\u007f]/g, "").trim();

export function allHosts(def) {
  return [...new Set(Object.values(def.modes || {}).flatMap((m) => m.hosts || []))];
}
function hostMatches(pattern, hostname) {
  const m = String(pattern).match(/^https:\/\/(\*\.)?([^/]+)\/\*$/);
  if (!m) return false;
  return m[1] ? hostname === m[2] || hostname.endsWith("." + m[2]) : hostname === m[2];
}

// Which mode a provider would use: the user's choice, else the first usable one (public, api with a key, page).
export function pickMode(def, pref, hasKey) {
  const modes = def.modes || {};
  if (pref && pref !== "auto" && modes[pref] && (pref !== "api" || hasKey)) return pref;
  if (modes.public) return "public";
  if (modes.api && hasKey) return "api";
  if (modes.page) return "page";
  return null;
}
export function modeNeeds(def, mode) {
  const m = (def.modes || {})[mode] || {};
  const usesTab = CAPS.some((c) => m[c] && m[c].kind === "tab");
  return { origins: m.hosts || [], permissions: usesTab ? ["scripting"] : [] };
}

export function fill(template, vars) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? "" : encodeURIComponent(String(vars[k]))));
}

// Run one capability. Returns { ok, score?, max?, list?, url, error?, message? } and never throws.
// vars: extra URL placeholders for paged APIs ({page}, {size}; defaults 1 and 20).
export async function runCapability(def, mode, cap, handle, { key = "", fetchImpl, readPage = readPageInTab, vars: more = {} } = {}) {
  const m = def && def.modes && def.modes[mode];
  const spec = m && m[cap];
  if (!spec) return { ok: false, error: "unsupported", message: `${def ? def.name : "Provider"} cannot do that in this mode` };
  const k = headerValue(key || "");
  const plain = { handle: String(handle || "").replace(/^@/, "").toLowerCase() };
  const page = clamp(Math.round(num(more.page, 1)), 1, 100000), size = clamp(Math.round(num(more.size, 20)), 1, 100);
  const vars = { page, size, ...plain, key: k };
  // The key only ever goes into a request to the provider's own API host. A browser tab URL (it lands in your
  // history) and the page link (stored in chrome.storage and shown as a link) never carry it.
  const tab = spec.kind === "tab";
  const url = fill(spec.url, tab ? plain : vars);
  const pageUrl = spec.pageUrl ? fill(spec.pageUrl, plain) : (def.profileUrl ? fill(def.profileUrl, plain) : (tab || !/\{key\}/.test(String(spec.url)) ? url : ""));
  const timeoutMs = clamp(num(spec.timeoutMs, tab ? 30000 : 20000), 2000, 60000);
  if (tab) {
    const r = await readPage(url, { json: spec.json, score: cap === "score" ? spec.value : undefined, max: spec.max, list: cap === "smartFollowers" ? spec.list : undefined, notFound: spec.notFound || def.notFound, loginWall: spec.loginWall || def.loginWall }, { timeoutMs });
    return finish(def, cap, r, pageUrl, vars.handle);
  }
  const headers = {};
  for (const [hk, v] of Object.entries(cleanHeaders(spec.headers) || {})) headers[hk] = headerValue(String(v).replace(/\{key\}/g, k));
  const as = spec.kind === "html" ? "text" : "json";
  const r = await fetchData(url, { headers, as, fetchImpl, timeoutMs });
  // A rejected key gets one plain message: it doesn't work, get a new one (never the key itself).
  const keyBad = { ok: false, error: "auth", status: r.status, message: `Your ${def.name} API key doesn't work - get a new key${def.keyHelp ? ` (${def.keyHelp})` : ""} and paste it in Scores > Providers`, url: pageUrl };
  if (k && !r.ok && r.error === "auth") return keyBad;
  if (k && !r.ok && r.error === "rate") return { ...r, message: `${def.name}: too many requests or no requests left on your plan (429) - try again later, or check your plan's usage`, url: pageUrl };
  if (!r.ok && r.error === "not_found") return { ...r, message: `${def.name} has no data for @${vars.handle}`, url: pageUrl };
  if (!r.ok) return { ...r, url: pageUrl };
  if (k && as === "json" && keyRejectedBody(r.json)) return keyBad;
  const json = as === "json" ? r.json : (spec.json ? jsonFromHtml(r.text, spec.json) : undefined);
  const text = as === "text" ? textFromHtml(r.text) : undefined;
  if (spec.notFoundPath && json !== undefined && pickValue({ path: spec.notFoundPath }, { json }) != null) return { ok: false, error: "not_found", message: `${def.name} has no data for @${vars.handle}`, url: pageUrl };
  // requirePath: the answer only counts when this field is set (e.g. Ethos returns a default for unknown accounts).
  if (spec.requirePath && json !== undefined && pickValue({ path: spec.requirePath }, { json }) == null) return { ok: false, error: "not_found", message: `@${vars.handle} has no ${def.name} profile`, url: pageUrl };
  const out = { ok: true, url: pageUrl };
  if (cap === "score") {
    out.score = toNumber(pickValue(spec.value, { json, text }));
    if (spec.max) out.max = toNumber(pickValue(spec.max, { json, text }));
    if (out.score == null) {
      // "No data for this account" is an answer, not a failure: a page saying so (the provider's notFound text, as in
      // the tab mode) or JSON whose score field is there but null (Sorsa: { score: null }). A score on the page wins.
      const nf = spec.notFound || def.notFound;
      if ((text !== undefined && nf && pickValue({ regex: nf }, { text }) !== undefined) || (json !== undefined && nullAtPath(json, spec.value && spec.value.path)))
        return { ok: false, error: "not_found", message: `${def.name} has no data for @${vars.handle}`, url: pageUrl };
      return { ok: false, error: "parse", message: `No score in ${def.name}'s answer (site changed? check Settings > Scores)`, url: pageUrl };
    }
  } else {
    out.list = pickList(spec.list, json);
    if (spec.total) out.total = toNumber(pickValue(spec.total, { json, text }));
  }
  return finish(def, cap, out, pageUrl, vars.handle);
}

// An API that answers 200 with an error body about the key ({ success: false, error: "Invalid API key" }).
function keyRejectedBody(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return false;
  const failed = json.success === false || json.ok === false || /^(?:error|fail(?:ed|ure)?)$/i.test(String(json.status || "")) || json.error != null;
  if (!failed) return false;
  const msg = [json.error, json.detail, json.message, json.msg, json.error && json.error.message].filter((x) => typeof x === "string").join(" ");
  return /api[\s_-]?key|\btoken\b|unauthori[sz]ed|forbidden|invalid key|key (?:is )?(?:invalid|expired|not valid|revoked)|subscription (?:expired|inactive)|trial (?:has )?(?:ended|expired)/i.test(msg);
}

// True when one of the value paths is present in the JSON with the value null (a missing field is a changed API).
function nullAtPath(json, path) {
  for (const p of Array.isArray(path) ? path : [path]) {
    if (typeof p !== "string" || !p) continue;
    const parts = p.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
    const key = parts.pop();
    const parent = parts.length ? pluck(json, parts.join(".")) : json;
    if (parent && typeof parent === "object" && Object.prototype.hasOwnProperty.call(parent, key) && parent[key] === null) return true;
  }
  return false;
}

function finish(def, cap, r, pageUrl, self = "") {
  if (!r || !r.ok) return { ...(r || { ok: false, error: "unknown" }), url: (r && r.url) || pageUrl };
  const out = { ...r, url: r.url || pageUrl };
  if (cap === "score" && out.max == null && def.max) out.max = def.max;
  if (/^smartFollowers/.test(cap) && Array.isArray(out.list)) out.list = out.list.filter((x) => x.handle !== self).slice(0, clamp(Math.round(num(def.listLimit, 50)), 1, 200));
  return out;
}
