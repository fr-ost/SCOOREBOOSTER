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

import { fetchData, pickValue, pickList, jsonFromHtml, textFromHtml, readPageInTab, toNumber } from "./pagereader.js";
import { deepMerge, deepClone } from "./util.js";
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

// Overrides may only change URLs on the provider's own hosts (https), headers, paths, selectors and regexes.
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
        if (k === "url" && !hostsOk(x)) continue;
        const c = clean(x, depth + 1);
        if (c !== undefined) out[k] = c;
      }
      return out;
    }
    if (typeof v === "string") return v.slice(0, 500);
    if (typeof v === "number" || typeof v === "boolean") return v;
    return undefined;
  };
  return clean(o) || {};
}

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
export async function runCapability(def, mode, cap, handle, { key = "", fetchImpl, readPage = readPageInTab } = {}) {
  const m = def && def.modes && def.modes[mode];
  const spec = m && m[cap];
  if (!spec) return { ok: false, error: "unsupported", message: `${def ? def.name : "Provider"} cannot do that in this mode` };
  const vars = { handle: String(handle || "").replace(/^@/, "").toLowerCase(), key };
  const url = fill(spec.url, vars);
  const pageUrl = spec.pageUrl ? fill(spec.pageUrl, vars) : (def.profileUrl ? fill(def.profileUrl, vars) : url);
  if (spec.kind === "tab") {
    const r = await readPage(url, { json: spec.json, score: cap === "score" ? spec.value : undefined, max: spec.max, list: cap === "smartFollowers" ? spec.list : undefined, notFound: spec.notFound || def.notFound, loginWall: spec.loginWall || def.loginWall }, { timeoutMs: spec.timeoutMs || 30000 });
    return finish(def, cap, r, pageUrl, vars.handle);
  }
  const headers = {};
  for (const [k, v] of Object.entries(spec.headers || {})) headers[k] = String(v).replace(/\{key\}/g, key);
  const as = spec.kind === "html" ? "text" : "json";
  const r = await fetchData(url, { headers, as, fetchImpl, timeoutMs: spec.timeoutMs || 20000 });
  if (!r.ok && r.error === "not_found") return { ...r, message: `${def.name} has no data for @${vars.handle}`, url: pageUrl };
  if (!r.ok) return { ...r, url: pageUrl };
  const json = as === "json" ? r.json : (spec.json ? jsonFromHtml(r.text, spec.json) : undefined);
  const text = as === "text" ? textFromHtml(r.text) : undefined;
  if (spec.notFoundPath && json !== undefined && pickValue({ path: spec.notFoundPath }, { json }) != null) return { ok: false, error: "not_found", message: "The site has no data for this account", url: pageUrl };
  const out = { ok: true, url: pageUrl };
  if (cap === "score") {
    out.score = toNumber(pickValue(spec.value, { json, text }));
    if (spec.max) out.max = toNumber(pickValue(spec.max, { json, text }));
    if (out.score == null) return { ok: false, error: "parse", message: `No score in ${def.name}'s answer (site changed? check Settings > Scores)`, url: pageUrl };
  } else {
    out.list = pickList(spec.list, json);
    if (spec.total) out.total = toNumber(pickValue(spec.total, { json, text }));
  }
  return finish(def, cap, out, pageUrl, vars.handle);
}

function finish(def, cap, r, pageUrl, self = "") {
  if (!r || !r.ok) return { ...(r || { ok: false, error: "unknown" }), url: (r && r.url) || pageUrl };
  const out = { ...r, url: r.url || pageUrl };
  if (cap === "score" && out.max == null && def.max) out.max = def.max;
  if (cap === "smartFollowers" && Array.isArray(out.list)) out.list = out.list.filter((x) => x.handle !== self).slice(0, def.listLimit || 50);
  return out;
}
