// ScoreX e2e harness: loads the unpacked extension in Playwright Chromium (new headless) with x.com,
// api.openai.com and api.sorsa.io mapped to a local HTTPS mock. Pattern from the X Unfollow Manager tests.
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";
import { createMock } from "./mockx.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const SRC = process.env.EXT || path.resolve(HERE, "../../extension");
export const OUT = path.join(HERE, "out");
fs.mkdirSync(OUT, { recursive: true });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function log(...a) { console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a); }
let passed = 0;
export function assert(cond, msg) { if (!cond) throw new Error("ASSERT FAILED: " + msg); passed++; log("  ok -", msg); }
export const passCount = () => passed;

// Copy the extension so a blank test page can be added without touching the real folder.
function stageExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sx-ext-"));
  fs.cpSync(SRC, dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "__test.html"), "<!doctype html><title>test</title><body>test page</body>");
  return dir;
}

// SX_PORT lets several e2e runs work in parallel (each mock X gets its own port).
export async function boot({ port = Number(process.env.SX_PORT) || 8443, viewport = { width: 1280, height: 900 } } = {}) {
  const M = createMock();
  await M.start(port);
  const ext = stageExtension();
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "sx-udd-"));
  const ctx = await chromium.launchPersistentContext(udd, {
    channel: "chromium",
    headless: true,
    ignoreHTTPSErrors: true,
    viewport,
    args: [
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      `--host-resolver-rules=MAP x.com:443 127.0.0.1:${port}, MAP api.openai.com:443 127.0.0.1:${port}, MAP api.sorsa.io:443 127.0.0.1:${port}`,
      "--ignore-certificate-errors",
      "--no-proxy-server",
    ],
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = sw.url().split("/")[2];
  const swLogs = [];
  const attachSw = (w) => w.on("console", (m) => swLogs.push(m.type() + ": " + m.text()));
  attachSw(sw);
  ctx.on("serviceworker", (w) => { H.sw = w; attachSw(w); });

  const H = { M, ctx, sw, extId, ext, udd, swLogs };
  let tp = null;
  H.page = async () => {
    if (!tp || tp.isClosed()) {
      tp = await ctx.newPage();
      tp.on("pageerror", (e) => log("TEST PAGE ERROR", e.message));
      await tp.goto(`chrome-extension://${extId}/__test.html`);
    }
    return tp;
  };
  H.msg = async (sx, payload = {}) => (await H.page()).evaluate(([sx, p]) => chrome.runtime.sendMessage({ sx, ...p }), [sx, payload]);
  H.store = async (key) => (await H.page()).evaluate((k) => chrome.storage.local.get(k).then((r) => r[k]), key);
  H.setStore = async (obj) => (await H.page()).evaluate((o) => chrome.storage.local.set(o), obj);
  H.patchState = async (patch) => (await H.page()).evaluate(async (p) => {
    const r = await chrome.storage.local.get("sx.state");
    await chrome.storage.local.set({ "sx.state": { ...(r["sx.state"] || {}), ...p } });
  }, patch);
  H.settings = async (patch) => (await H.page()).evaluate(async (p) => {
    const S = await import("/lib/store.js");
    const U = await import("/lib/util.js");
    const cur = await S.getSettings();
    return S.saveSettings(S.sanitizeSettings(U.deepMerge(cur, p)));
  }, patch);
  H.secrets = async (patch) => (await H.page()).evaluate(async (p) => { const S = await import("/lib/store.js"); await S.setSecrets(p); }, patch);
  H.history = async () => (await H.page()).evaluate(async () => { const X = await import("/lib/history.js"); return (await X.all()).sort((a, b) => a.createdAt - b.createdAt); });
  H.patchHistory = async (id, fields) => (await H.page()).evaluate(async ([id, f]) => { const X = await import("/lib/history.js"); return X.patch(id, f); }, [id, fields]);
  // "Run a check now" for tests: the engine never loads watch pages more often than every 90 s, so tests
  // clear the last-watch time first instead of waiting it out.
  H.runNow = async () => {
    await H.waitFor(async () => { const s = await H.store("sx.state"); return !s.job || s.job.leaseUntil < Date.now(); }, "idle engine", 180000, 400).catch(() => {});
    await H.patchState({ lastWatchAt: 0 });
    return H.msg("runNow");
  };
  // patches: { handle: { field: value, rel: {...partial}, stats: {...partial} } } written straight to storage
  // while the engine is idle (no eval: extension pages forbid it).
  H.patchTargets = async (patches) => {
    await H.waitFor(async () => { const s = await H.store("sx.state"); return !s.job || s.job.leaseUntil < Date.now(); }, "idle engine", 180000, 400).catch(() => {});
    return (await H.page()).evaluate(async (ps) => {
      const r = await chrome.storage.local.get("sx.targets");
      const all = r["sx.targets"] || {};
      for (const [h, p] of Object.entries(ps)) {
        if (!all[h]) continue;
        for (const [k, v] of Object.entries(p)) all[h][k] = k === "rel" || k === "stats" ? { ...(all[h][k] || {}), ...v } : v;
      }
      await chrome.storage.local.set({ "sx.targets": all });
    }, patches);
  };
  // Shortcut for tests that are not about follow tracking: mark targets as checked ("does not follow you")
  // and the "Follows you" badge as verified, so they can be commented on right away.
  H.markNotFollowing = async (handles) => {
    const now = Date.now();
    await H.patchTargets(Object.fromEntries(handles.map((h) => [h, { group: "B", rel: { followsYou: false, checkedAt: now } }])));
    await H.patchState({ followBadgeOkAt: now, followersScanAt: now });
  };
  // Run checks until the follow status of these targets is known (the real follow check).
  H.untilChecked = async (handles, timeoutMs = 150000) => H.waitFor(async () => {
    const t = await H.store("sx.targets");
    if (handles.every((h) => t[h] && t[h].rel.followsYou != null)) return t;
    await H.runNow();
    await sleep(2500);
    return null;
  }, "follow check of " + handles.join(", "), timeoutMs, 1000);
  H.badge = async () => H.sw.evaluate(() => chrome.action.getBadgeText({}));
  H.waitFor = async (fn, what, timeoutMs = 60000, every = 500) => {
    const until = Date.now() + timeoutMs;
    let last;
    while (Date.now() < until) {
      try { last = await fn(); } catch (e) { last = null; }
      if (last) return last;
      await sleep(every);
    }
    throw new Error("timeout waiting for " + what);
  };
  // Really terminate the extension service worker (DevTools protocol on an extension page).
  H.stopWorker = async () => {
    const pg = await H.page();
    const cdp = await ctx.newCDPSession(pg);
    await cdp.send("ServiceWorker.enable");
    await new Promise((r) => setTimeout(r, 300));
    await cdp.send("ServiceWorker.stopAllWorkers");
    await new Promise((r) => setTimeout(r, 800));
    await cdp.detach().catch(() => {});
  };
  H.xTabs = async () => ctx.pages().filter((p) => p.url().startsWith("https://x.com/"));
  H.close = async () => { try { await ctx.close(); } catch (_) {} await M.stop(); try { fs.rmSync(ext, { recursive: true, force: true }); fs.rmSync(udd, { recursive: true, force: true }); } catch (_) {} };

  // Fast, deterministic-ish defaults for tests.
  await H.page();
  await H.waitFor(() => H.store("sx.settings"), "default settings", 15000);
  return H;
}

// Common test setup: account, list watch, fast typing, no active-hours limit.
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
function merge(a, b) { const o = { ...a }; for (const k of Object.keys(b || {})) o[k] = isObj(a[k]) && isObj(b[k]) ? merge(a[k], b[k]) : b[k]; return o; }

export async function setup(H, extra = {}) {
  await H.settings(merge({
    account: { handle: "0x_nation", verifyAccount: true },
    watch: { strategy: "list", listUrls: ["https://x.com/i/lists/1234567890"], scrolls: 0, minPostAgeMin: 1, maxPostAgeMin: 20 },
    safety: { activeHours: { enabled: false }, readDelaySec: { min: 1, max: 1 }, typingCpm: { min: 550, max: 600 }, breaks: { enabled: false } },
    review: { notifyNew: false },
  }, extra));
  await H.secrets({ openaiKey: "sk-test-1234567890abcdefXYZ" });
}
