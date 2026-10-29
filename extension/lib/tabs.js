// ScoreX - the X worker tab: find/create a pinned background x.com tab, navigate it, talk to its content script.
// Pattern from GrowX / X Unfollow Manager: sendTab never hangs, the tab is kept from being discarded,
// and a closed tab is simply reopened on the next use.

import { getState, patchState, log } from "./store.js";
import { CMD } from "./constants.js";
import { sleep, now } from "./util.js";

const X_MATCH = ["https://x.com/*"];
const isX = (u) => /^https:\/\/x\.com\//.test(u || "");
const readyWaiters = new Map(); // tabId -> [resolve]

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
  const closingWindow = !!(removeInfo && removeInfo.isWindowClosing);
  return getState().then((st) => (st.workerTabId === tabId ? patchState(closingWindow ? { workerTabId: null } : { workerTabId: null, workerTabPinned: false }) : null)).catch(() => {});
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
  try {
    const p = chrome.tabs.sendMessage(tabId, { sx: cmd, ...args }).then((r) => r || { ok: false, noAnswer: true, error: "empty" }, (e) => ({ ok: false, noAnswer: true, error: String((e && e.message) || e).slice(0, 120) }));
    return await Promise.race([p, timeout]);
  } finally { clearTimeout(timer); }
}

async function tabInfo(tabId) { try { return await chrome.tabs.get(tabId); } catch (_) { return null; } }

async function ping(tabId, guard) {
  const r = await send(tabId, CMD.PING, guard == null ? {} : { guard }, 4000);
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
  await send(tabId, CMD.PING, { guard: true }, 3000);
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
  await patchState({ workerTabId: tab.id, workerTabPinned: !!tab.pinned, workerTabIndex: tab.index });
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
    const t = await tabInfo(st.workerTabId);
    if (t && isX(t.url || t.pendingUrl)) {
      if (t.discarded) {
        try { await chrome.tabs.reload(t.id); } catch (_) {}
        if (await waitReady(t.id, 40000)) { await protect(t.id); return t.id; }
      } else if (await ping(t.id, true)) {
        return t.id;
      } else {
        // Tab exists but the content script is silent (extension reloaded, frozen): reload it.
        try { await chrome.tabs.reload(t.id); } catch (_) {}
        if (await waitReady(t.id, 40000)) { await protect(t.id); return t.id; }
      }
    }
    await patchState({ workerTabId: null });
  }
  // After a Chrome restart the pinned tab we created comes back with a new id: adopt it instead of
  // opening a second one (the restored pinned x.com tab at our old position, else the last pinned one).
  if (st.workerTabPinned) {
    let pinned = [];
    try { pinned = await chrome.tabs.query({ pinned: true, url: X_MATCH }); } catch (_) {}
    const cand = pinned.find((t) => t.index === st.workerTabIndex) || pinned[pinned.length - 1];
    if (cand && !cand.active) {
      if (cand.discarded) { try { await chrome.tabs.reload(cand.id); } catch (_) {} }
      if (await waitReady(cand.id, 40000)) {
        await patchState({ workerTabId: cand.id, workerTabIndex: cand.index });
        await protect(cand.id);
        log("info", "Reusing the restored ScoreX X tab");
        return cand.id;
      }
    }
  }
  if (!create) return null;
  return createTab(settings);
}

// Navigate the worker tab and wait until the new page's content script is ready.
export async function navigate(tabId, url, timeoutMs = 45000) {
  const msg = waitReadyMessage(tabId, timeoutMs);
  try { await chrome.tabs.update(tabId, { url }); } catch (e) { return { ok: false, error: "tab_gone" }; }
  const started = now();
  const until = started + timeoutMs;
  let ready = false;
  msg.then((v) => { if (v) ready = true; });
  // Wait for the new document's 'contentReady' announcement (or a completed load of the target URL
  // after a short grace period, so a ping is never answered by the previous page), then confirm.
  const wantPath = (() => { try { return new URL(url).pathname.toLowerCase(); } catch (_) { return ""; } })();
  while (now() < until) {
    await sleep(ready ? 150 : 700);
    const t = await tabInfo(tabId);
    if (!t) return { ok: false, error: "tab_gone" };
    if (t.status !== "complete" || !isX(t.url)) continue;
    let samePath = false;
    try { samePath = new URL(t.url).pathname.toLowerCase() === wantPath; } catch (_) {}
    if (!ready && !(samePath && now() - started > 2500)) continue;
    const p = await ping(tabId, true);
    if (p) return { ok: true, url: t.url, viaReady: ready };
  }
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
  await send(tabId, CMD.PING, { guard: false }, 3000);
}

export const _test = { isX, X_MATCH };
