// ScoreX - the X worker tab: find/create a pinned background x.com tab, navigate it, talk to its content script.
// Pattern from GrowX / X Unfollow Manager: sendTab never hangs, the tab is kept from being discarded,
// and a closed tab is simply reopened on the next use.

import { getState, patchState, getSettings, log } from "./store.js";
import { CMD } from "./constants.js";
import { sleep, now, HOUR } from "./util.js";

const X_MATCH = ["https://x.com/*"];
const isX = (u) => /^https:\/\/x\.com\//.test(u || "");
const readyWaiters = new Map(); // tabId -> [resolve]

// ---------- X footprint: every x.com page load, per hour, for a rolling 24 h window ----------
// state.footprint = { "<hour index>": { <purpose>: count } } (at most 24 buckets). Read by getStatus() and the
// optional page-load budget (settings.safety.maxPageLoads24h): at the cap navigate() refuses with a soft
// { ok:false, budget:true } result, which callers treat like a wait (never a stop).
export const PURPOSES = Object.freeze(["watch", "post", "profile", "follow", "check", "mentions", "discovery", "scores", "diagnostics", "other"]);

// Purpose of an x.com URL when the caller does not say: /search -> watch (people search -> discovery), /i/lists
// -> watch, /status/<id> -> post, /notifications -> mentions, follower lists -> follow, /home -> other, /<handle> -> profile.
export function inferPurpose(url) {
  let u;
  try { u = new URL(url); } catch (_) { return "other"; }
  const p = u.pathname.replace(/\/+$/, "").toLowerCase();
  if (p === "/search") return u.searchParams.get("f") === "user" ? "discovery" : "watch";
  if (p.startsWith("/i/lists/")) return "watch";
  if (/^\/[a-z0-9_]{1,15}\/status\/\d+/.test(p)) return "post";
  if (p === "/notifications" || p.startsWith("/notifications/")) return "mentions";
  if (/^\/[a-z0-9_]{1,15}\/(followers|following|verified_followers)$/.test(p)) return "follow";
  if (/^\/[a-z0-9_]{1,15}$/.test(p) && !RESERVED_PATHS.has(p.slice(1))) return "profile";
  return "other";
}
const RESERVED_PATHS = new Set(["home", "explore", "messages", "settings", "compose", "i", "login", "logout", "signup", "tos", "privacy", "bookmarks", "lists", "communities", "premium", "jobs", "grok", "account", "hashtag"]);

// The engine names the job it runs (follow checks, engagement checks, discovery...) so its page loads are counted
// under that purpose. Only set while holding the job lease, so jobs never interleave their hints.
let purposeHint = null;
export async function withPurpose(purpose, fn) {
  const prev = purposeHint;
  purposeHint = PURPOSES.includes(purpose) ? purpose : null;
  try { return await fn(); } finally { purposeHint = prev; }
}

const bucketOf = (ts) => Math.floor(ts / HOUR);
const inWindow = (i, h) => i > h - 24 && i <= h;
function bucketTotal(b) { let n = 0; for (const v of Object.values(b || {})) n += Number(v) || 0; return n; }

export function footprintAdd(fp, purpose, ts = now()) {
  const h = bucketOf(ts);
  const out = {};
  for (const [k, b] of Object.entries(fp && typeof fp === "object" ? fp : {})) if (inWindow(Number(k), h)) out[k] = b;
  const p = PURPOSES.includes(purpose) ? purpose : "other";
  out[h] = { ...(out[h] || {}), [p]: ((out[h] && out[h][p]) || 0) + 1 };
  return out;
}

// { total, cap (0 = none), byPurpose: { <purpose>: n }, hourly: [24 numbers, oldest hour first] }
export function footprintSummary(fp, cap = 0, ts = now()) {
  const h = bucketOf(ts);
  const byPurpose = Object.fromEntries(PURPOSES.map((p) => [p, 0]));
  const hourly = new Array(24).fill(0);
  let total = 0;
  for (const [k, b] of Object.entries(fp && typeof fp === "object" ? fp : {})) {
    const i = Number(k);
    if (!inWindow(i, h)) continue;
    for (const [p, v] of Object.entries(b || {})) {
      const n = Number(v) || 0;
      total += n;
      byPurpose[PURPOSES.includes(p) ? p : "other"] += n;
      hourly[23 - (h - i)] += n;
    }
  }
  return { total, cap: Math.max(0, Number(cap) || 0), byPurpose, hourly };
}

// Room under settings.safety.maxPageLoads24h: { cap, used, left, until } where `until` is when at least `need`
// loads are free again (null when there is room now or no cap). Hour buckets leave the window 24 h after their hour.
export function pageBudget(settings, state, ts = now(), need = 1) {
  const cap = Math.max(0, Math.round(Number(settings && settings.safety && settings.safety.maxPageLoads24h) || 0));
  const fp = (state && state.footprint) || {};
  const used = footprintSummary(fp, cap, ts).total;
  if (!cap) return { cap: 0, used, left: Infinity, until: null };
  const left = Math.max(0, cap - used);
  if (left >= need) return { cap, used, left, until: null };
  const h = bucketOf(ts);
  const keys = Object.keys(fp).map(Number).filter((i) => inWindow(i, h)).sort((a, b) => a - b);
  let total = used;
  for (const i of keys) {
    total -= bucketTotal(fp[i]);
    if (cap - total >= need) return { cap, used, left, until: (i + 24) * HOUR };
  }
  return { cap, used, left, until: (h + 24) * HOUR };
}

async function countLoad(purpose) {
  try { await patchState((s) => ({ footprint: footprintAdd(s.footprint, purpose, now()) })); } catch (_) {}
}

// ---------- which X account is logged in, once per page load ----------
// The first settled page report after a navigation tells whether the logged-in account could be read. Page loads
// in a row without a readable account (or with a page state the content script could not determine) are counted
// in state.accountUnknownStreak; the engine stops with STOP.ACCOUNT_UNKNOWN at 3. A readable handle resets it (a
// different handle is a WRONG_ACCOUNT stop in guard.pageVerdict). Pings right after a load are ignored, because
// the side navigation may render a moment after the page frame.
const accountPending = new Set(); // tab ids with a page load whose account was not checked yet
async function noteAccount(tabId, page) {
  if (!page || !accountPending.has(tabId)) return;
  const known = !!page.me;
  if (!known && page.state !== "ok" && page.state !== "unknown") return; // still loading / error page: wait
  accountPending.delete(tabId);
  const cur = (await getState()).accountUnknownStreak || 0;
  if (known && !cur) return;
  await patchState((s) => ({ accountUnknownStreak: known ? 0 : (s.accountUnknownStreak || 0) + 1 }));
}

// ---------- the worker tab id belongs to this browser session ----------
// Tab ids start again after a browser restart, so an id stored in sx.state may belong to one of the user's own tabs
// in a new session. The id is also kept in chrome.storage.session (cleared on restart): a stored id without that
// marker is only reused if the tab still looks exactly like the ScoreX tab (pinned state, position, last page).
const SESSION_KEY = "sx.workerTabId";
const sessionArea = () => (globalThis.chrome && chrome.storage && chrome.storage.session) || null;
async function sessionTab() {
  const ss = sessionArea();
  if (!ss) return { supported: false, id: null };
  try { const r = await ss.get(SESSION_KEY); return { supported: true, id: r[SESSION_KEY] ?? null }; } catch (_) { return { supported: false, id: null }; }
}
async function markSession(id) {
  const ss = sessionArea();
  if (!ss) return;
  try { if (id == null) await ss.remove(SESSION_KEY); else await ss.set({ [SESSION_KEY]: id }); } catch (_) {}
}
async function setWorker(id, extra = {}) {
  await patchState({ workerTabId: id, ...extra });
  await markSession(id);
}
function looksLikeOurTab(t, st) {
  const url = (t.url || t.pendingUrl || "").split("#")[0];
  if (!isX(url) || !st.workerLastUrl || url !== String(st.workerLastUrl).split("#")[0]) return false;
  if (!!t.pinned !== !!st.workerTabPinned) return false;
  return st.workerTabIndex == null || t.index === st.workerTabIndex;
}

export function onContentReady(tabId, url) {
  const list = readyWaiters.get(tabId);
  if (!list) return;
  readyWaiters.delete(tabId);
  for (const r of list) r(url || true);
}
// A tab closed by the user is not adopted again later; one closed because the window/browser closed may be
// restored by Chrome, so it stays adoptable.
export function onTabRemoved(tabId, removeInfo) {
  readyWaiters.delete(tabId);
  accountPending.delete(tabId);
  const closingWindow = !!(removeInfo && removeInfo.isWindowClosing);
  return getState().then(async (st) => {
    if (st.workerTabId !== tabId) return null;
    await markSession(null);
    return patchState(closingWindow ? { workerTabId: null } : { workerTabId: null, workerTabPinned: false });
  }).catch(() => {});
}

function waitReadyMessage(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const arr = readyWaiters.get(tabId) || [];
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    arr.push(fin);
    readyWaiters.set(tabId, arr);
    setTimeout(() => fin(false), timeoutMs);
  });
}

// Send a command to the content script; resolves { ok:false, noAnswer:true } instead of throwing/hanging.
export async function send(tabId, cmd, args = {}, timeoutMs = 30000) {
  if (tabId == null) return { ok: false, noAnswer: true, error: "no_tab" };
  let timer;
  const timeout = new Promise((r) => { timer = setTimeout(() => r({ ok: false, noAnswer: true, error: "timeout" }), timeoutMs); });
  let r;
  try {
    const p = chrome.tabs.sendMessage(tabId, { sx: cmd, ...args }).then((x) => x || { ok: false, noAnswer: true, error: "empty" }, (e) => ({ ok: false, noAnswer: true, error: String((e && e.message) || e).slice(0, 120) }));
    r = await Promise.race([p, timeout]);
  } finally { clearTimeout(timer); }
  if (cmd !== CMD.PING && r && r.page && accountPending.has(tabId)) await noteAccount(tabId, r.page).catch(() => {});
  return r;
}

async function tabInfo(tabId) { try { return await chrome.tabs.get(tabId); } catch (_) { return null; } }

async function ping(tabId) {
  const r = await send(tabId, CMD.PING, {}, 4000);
  return r && r.ok ? r : null;
}

// Wait for the tab to finish loading and the content script to answer.
export async function waitReady(tabId, timeoutMs = 40000) {
  const until = now() + timeoutMs;
  const msg = waitReadyMessage(tabId, timeoutMs);
  while (now() < until) {
    const t = await tabInfo(tabId);
    if (!t) return false;
    if (t.status === "complete" && isX(t.url)) {
      const p = await ping(tabId);
      if (p) return true;
    }
    const got = await Promise.race([msg, sleep(1200).then(() => null)]);
    if (got) { await sleep(300); if (await ping(tabId)) return true; }
  }
  return false;
}

async function protect(tabId) {
  try { await chrome.tabs.update(tabId, { autoDiscardable: false }); } catch (_) {}
}

async function createTab(settings) {
  const url = "https://x.com/home";
  let tab;
  if (settings && settings.advanced && settings.advanced.tabMode === "window") {
    // Wide enough for X's desktop layout (narrow windows switch to the mobile layout).
    const win = await chrome.windows.create({ url, focused: false, type: "normal", width: 1100, height: 900 });
    tab = win.tabs && win.tabs[0];
  } else {
    tab = await chrome.tabs.create({ url, active: false, pinned: true });
  }
  if (!tab) return null;
  // Remembered right away (with the page it opens): if X does not load now, the next check reloads this tab
  // instead of opening yet another pinned tab.
  await setWorker(tab.id, { workerTabPinned: !!tab.pinned, workerTabIndex: tab.index, workerLastUrl: url });
  await countLoad("other");
  const ok = await waitReady(tab.id, 45000);
  if (!ok) return null;
  await protect(tab.id);
  log("info", "Opened the ScoreX X tab");
  return tab.id;
}

// The tab ScoreX works in. Reuses the stored tab, reloads it if Chrome discarded it, else opens a new pinned one.
export async function workerTab(settings, { create = true } = {}) {
  const st = await getState();
  if (st.workerTabId != null) {
    let t = await tabInfo(st.workerTabId);
    if (t) {
      const sess = await sessionTab();
      // (chrome.storage.session exists in every supported Chrome, minimum_chrome_version 116.)
      if (sess.supported && sess.id !== st.workerTabId) {
        if (looksLikeOurTab(t, st)) await markSession(t.id);
        else { log("info", "Not reusing the stored X tab id: it is from an earlier browser session"); t = null; }
      }
    }
    if (t && isX(t.url || t.pendingUrl)) {
      if (t.discarded) {
        try { await chrome.tabs.reload(t.id); await countLoad("other"); } catch (_) {}
        if (await waitReady(t.id, 40000)) { await protect(t.id); return t.id; }
      } else if (await ping(t.id)) {
        return t.id;
      } else {
        // Tab exists but the content script is silent (extension reloaded, frozen): reload it.
        try { await chrome.tabs.reload(t.id); await countLoad("other"); } catch (_) {}
        if (await waitReady(t.id, 40000)) { await protect(t.id); return t.id; }
      }
      // Our tab is still there but X does not load in it (offline, X down): keep it and report "not available"
      // (the engine stops after 3 tries) instead of opening another pinned tab on every check.
      return null;
    }
    await setWorker(null);
  }
  // After a Chrome restart the pinned tab we created comes back with a new id: adopt it instead of
  // opening a second one (the restored pinned x.com tab at our old position, else the last pinned one).
  if (st.workerTabPinned) {
    let pinned = [];
    try { pinned = await chrome.tabs.query({ pinned: true, url: X_MATCH }); } catch (_) {}
    // Only the tab at our old position that still shows the last page ScoreX opened - nothing else, so the
    // user's own pinned X tab is never taken over.
    const sameUrl = (t) => st.workerLastUrl && (t.url || t.pendingUrl || "").split("#")[0] === st.workerLastUrl.split("#")[0];
    const matches = pinned.filter((t) => t.index === st.workerTabIndex && sameUrl(t));
    const cand = matches.length === 1 ? matches[0] : null;
    if (!cand) await patchState({ workerTabPinned: false });
    if (cand && !cand.active) {
      if (cand.discarded) { try { await chrome.tabs.reload(cand.id); await countLoad("other"); } catch (_) {} }
      // Remembered even if X does not answer yet, so the next check retries this tab instead of opening another.
      await setWorker(cand.id, { workerTabIndex: cand.index });
      if (await waitReady(cand.id, 40000)) {
        await protect(cand.id);
        log("info", "Reusing the restored ScoreX X tab");
        return cand.id;
      }
      return null;
    }
  }
  if (!create) return null;
  return createTab(settings);
}

// Navigate the worker tab and wait until the new page's content script is ready.
// opts: { purpose } (one of PURPOSES; otherwise the engine's current job, else inferred from the URL) or, as
// before, a timeout in ms. With settings.safety.maxPageLoads24h reached it returns { ok:false, budget:true,
// error:"page_budget", until } without loading anything: callers wait (it is never a failure or a stop).
export async function navigate(tabId, url, opts) {
  const o = typeof opts === "number" ? { timeoutMs: opts } : opts && typeof opts === "object" ? opts : {};
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 45000;
  const purpose = PURPOSES.includes(o.purpose) ? o.purpose : purposeHint || inferPurpose(url);
  const settings = await getSettings().catch(() => null);
  if (settings && settings.safety && settings.safety.maxPageLoads24h > 0) {
    const pb = pageBudget(settings, await getState(), now());
    if (pb.left < 1) return { ok: false, budget: true, error: "page_budget", until: pb.until };
  }
  const msg = waitReadyMessage(tabId, timeoutMs);
  try { await chrome.tabs.update(tabId, { url }); } catch (e) { return { ok: false, error: "tab_gone" }; }
  accountPending.add(tabId);
  const started = now();
  const until = started + timeoutMs;
  let ready = false;
  msg.then((v) => { if (v) ready = true; });
  // Wait for the new document's 'contentReady' announcement (or a completed load of the target URL
  // after a short grace period, so a ping is never answered by the previous page), then confirm.
  // The load is counted in the footprint once it was requested, whatever the outcome (one state write).
  const wantPath = (() => { try { return new URL(url).pathname.toLowerCase(); } catch (_) { return ""; } })();
  while (now() < until) {
    await sleep(ready ? 150 : 700);
    const t = await tabInfo(tabId);
    if (!t) { await countLoad(purpose); return { ok: false, error: "tab_gone" }; }
    if (t.status !== "complete" || !isX(t.url)) continue;
    let samePath = false;
    try { samePath = new URL(t.url).pathname.toLowerCase() === wantPath; } catch (_) {}
    if (!ready && !(samePath && now() - started > 2500)) continue;
    const p = await ping(tabId);
    if (p) {
      await patchState((s) => ({ workerLastUrl: t.url, workerTabIndex: t.index, footprint: footprintAdd(s.footprint, purpose, started) })).catch(() => {});
      return { ok: true, url: t.url, viaReady: ready };
    }
  }
  await countLoad(purpose);
  return { ok: false, error: "load_timeout" };
}

// Ask the page to settle and optionally wait for one of the selector keys to appear.
export function waitForPage(tabId, keys, timeoutMs = 20000) {
  return send(tabId, CMD.WAIT_FOR, { keys, timeoutMs }, timeoutMs + 25000);
}

// Briefly show the worker tab (only when the user enabled it), returning a restore function.
export async function bringToFront(tabId) {
  const t = await tabInfo(tabId);
  if (!t) return async () => {};
  let prev = null;
  try { const [a] = await chrome.tabs.query({ active: true, windowId: t.windowId }); prev = a && a.id !== tabId ? a.id : null; } catch (_) {}
  try { await chrome.tabs.update(tabId, { active: true }); } catch (_) {}
  return async () => { if (prev != null) { try { await chrome.tabs.update(prev, { active: true }); } catch (_) {} } };
}

export async function releaseGuard(tabId) {
  if (tabId == null) return;
  try { await chrome.tabs.update(tabId, { autoDiscardable: true }); } catch (_) {}
}

export const _test = { isX, X_MATCH, looksLikeOurTab, SESSION_KEY, accountPending };
