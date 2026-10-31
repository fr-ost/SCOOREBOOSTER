// Fake Chrome for engine / tabs unit tests: worker tabs with a scripted content script, alarms, notifications, the
// badge and (optionally) chrome.storage.session. install() patches globalThis.chrome.* and makes short timers
// (flow pauses, typing, polling; < 30 s) near-instant; longer timers (tick schedules, lease heartbeats) keep their
// real delay but never keep the process alive. uninstall() restores everything, so use them in before()/after().
//   const env = install();  env.addTab({ id: 3, url: "https://x.com/home", pinned: true });
//   env.content = async (msg, tab, env) => ({ ok: true, ... })   // response without `page` (env.page is added)
import "./_chrome.mjs";
import * as tabsMod from "../../extension/lib/tabs.js";

export function install({ session = false } = {}) {
  const c = globalThis.chrome;
  const saved = {
    setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval, fetch: globalThis.fetch,
    tabs: c.tabs, windows: c.windows, alarms: c.alarms, notifications: c.notifications, action: c.action,
    getURL: c.runtime.getURL, getPlatformInfo: c.runtime.getPlatformInfo, session: c.storage.session,
  };
  const realSetTimeout = saved.setTimeout, realSetInterval = saved.setInterval;
  // The engine's own tick timer (scheduleTick: "() => tick(...)") keeps its real delay, so a scheduled tick never
  // fires in the middle of a test; engine.pause() in afterEach clears it.
  globalThis.setTimeout = (fn, ms, ...a) => {
    const d = Math.max(0, Number(ms) || 0);
    if (d < 30000 && !/\btick\(/.test(String(fn))) return realSetTimeout(fn, d / 1000, ...a);
    const t = realSetTimeout(fn, d, ...a);
    if (t && t.unref) t.unref();
    return t;
  };
  globalThis.setInterval = (fn, ms, ...a) => { const t = realSetInterval(fn, ms, ...a); if (t && t.unref) t.unref(); return t; };
  // No real network from unit tests (mockOpenAI() replaces this).
  globalThis.fetch = async (url) => { throw new Error("network disabled in unit tests: " + String(url).slice(0, 80)); };

  const env = {
    tabs: new Map(), nextId: 100, navigations: [], reloads: [], commands: [], notifications: [], badges: [], alarms: new Map(),
    page: { state: "ok", detail: "", me: "0x_nation", hidden: false },
    content: null, // async (msg, tab, env) => response (without page) | undefined (no content script answers)
    loads: true, // false: pages never finish loading / the content script never answers
  };
  env.addTab = (t) => { const tab = { status: "complete", active: false, pinned: false, index: 0, windowId: 1, discarded: false, ...t }; env.tabs.set(tab.id, tab); return tab; };
  env.wait = (ms) => new Promise((r) => realSetTimeout(r, ms));
  env.cmds = (sx) => env.commands.filter((x) => !sx || x[0] === sx);
  const finishLoad = (tab) => realSetTimeout(() => { if (!env.loads) return; tab.status = "complete"; tabsMod.onContentReady(tab.id, tab.url); }, 1);

  c.runtime.getURL = (p) => "chrome-extension://test-extension/" + (p || "");
  c.runtime.getPlatformInfo = async () => ({ os: "linux" });
  c.notifications = { async create(id, o) { env.notifications.push({ id, title: o.title, message: o.message }); return id; }, async clear() {} };
  c.action = { async setBadgeText(o) { env.badges.push(o.text); }, async setBadgeBackgroundColor() {}, async setBadgeTextColor() {}, async setTitle() {} };
  c.alarms = {
    async create(name, info) { env.alarms.set(name, { name, scheduledTime: info.when || Date.now() + (info.delayInMinutes || info.periodInMinutes || 0) * 60000, periodInMinutes: info.periodInMinutes }); },
    async get(name) { return env.alarms.get(name); },
    async clear(name) { return env.alarms.delete(name); },
    async getAll() { return [...env.alarms.values()]; },
  };
  c.windows = { async create(o) { const id = env.nextId++; const t = env.addTab({ id, url: o.url, status: "loading" }); finishLoad(t); return { id: 9, tabs: [{ ...t }] }; } };
  c.tabs = {
    async get(id) { const t = env.tabs.get(id); if (!t) throw new Error("No tab with id: " + id); return { ...t }; },
    async create(o) {
      const id = env.nextId++;
      const t = env.addTab({ id, url: o.url, pinned: !!o.pinned, active: !!o.active, index: env.tabs.size, status: "loading" });
      finishLoad(t);
      return { ...t };
    },
    async update(id, p) {
      const t = env.tabs.get(id);
      if (!t) throw new Error("No tab with id: " + id);
      if (p.url) { t.url = p.url; t.status = "loading"; env.navigations.push([id, p.url]); finishLoad(t); }
      for (const k of ["autoDiscardable", "active", "pinned"]) if (k in p) t[k] = p[k];
      return { ...t };
    },
    async reload(id) { const t = env.tabs.get(id); if (!t) throw new Error("No tab with id: " + id); t.status = "loading"; t.discarded = false; env.reloads.push(id); finishLoad(t); },
    async remove(id) { env.tabs.delete(id); },
    async query(q = {}) {
      return [...env.tabs.values()].filter((t) => (q.pinned == null || t.pinned === q.pinned) && (!q.url || /^https:\/\/x\.com\//.test(t.url)) && (q.active == null || t.active === q.active)).map((t) => ({ ...t }));
    },
    async sendMessage(id, msg) {
      const t = env.tabs.get(id);
      if (!t || t.status !== "complete" || !env.loads) throw new Error("Could not establish connection. Receiving end does not exist.");
      env.commands.push([msg.sx, t.url, id]);
      let base;
      if (msg.sx === "ping") base = { ok: true, ready: "complete", me: env.page.me };
      else if (env.content) base = await env.content(msg, t, env);
      else base = msg.sx === "waitFor" ? { ok: true, key: (msg.keys || [])[0] } : { ok: true };
      if (base === undefined) throw new Error("Receiving end does not exist.");
      if (base && base.page !== undefined) return base;
      return { ...(base || { ok: true }), page: { ...env.page, url: t.url } };
    },
  };
  if (session) {
    const data = new Map();
    env.sessionData = data;
    c.storage.session = {
      async get(k) { const out = {}; for (const key of [].concat(k)) if (data.has(key)) out[key] = data.get(key); return out; },
      async set(o) { for (const [k, v] of Object.entries(o)) data.set(k, v); },
      async remove(k) { for (const key of [].concat(k)) data.delete(key); },
    };
  }
  env.uninstall = () => {
    globalThis.setTimeout = saved.setTimeout;
    globalThis.setInterval = saved.setInterval;
    globalThis.fetch = saved.fetch;
    c.tabs = saved.tabs; c.windows = saved.windows; c.alarms = saved.alarms; c.notifications = saved.notifications; c.action = saved.action;
    c.runtime.getURL = saved.getURL; c.runtime.getPlatformInfo = saved.getPlatformInfo;
    if (saved.session === undefined) delete c.storage.session; else c.storage.session = saved.session;
  };
  return env;
}

// OpenAI Responses API mock: a comment for generation calls, a passing verdict for quality checks.
// calls -> parsed request bodies. comment can be a string or a function(body) -> string.
export function mockOpenAI(comment = "Deferring company size is underrated, most teams only need it once sales gets involved") {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    // The editor check answers JSON (scorex_check); a reply is plain text.
    const isCheck = !!(body.text && body.text.format && body.text.format.name === "scorex_check");
    const text = isCheck ? JSON.stringify({ pass: true, generic: false, off_topic: false, same_language: true, bot_like: false, issue: "" })
      : typeof comment === "function" ? comment(body) : comment;
    const json = { output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 900, output_tokens: 60 } };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(json), json: async () => json };
  };
  return calls;
}
