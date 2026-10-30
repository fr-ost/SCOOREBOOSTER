// Fake x.com worker tab for unit tests of steps that drive the X tab (follow tracking, mentions, engagement checks).
// install() patches chrome.tabs / notifications / action and makes every timer near-instant; uninstall() restores
// them. Call them in before()/after() of a describe block so no other test file is affected.
//   const fx = install({ content: async (url, msg) => ({ ok: true, ... }) });   // response without `page`
//   fx.commands -> [[cmd, url]], fx.navigations -> [url], fx.notifications -> [{ id, title, message }]
import "./_chrome.mjs";
import * as tabs from "../../extension/lib/tabs.js";

export const TAB_ID = 7;

export function install({ content, page = {} } = {}) {
  const realSetTimeout = globalThis.setTimeout;
  const c = globalThis.chrome;
  const saved = { setTimeout: globalThis.setTimeout, tabs: c.tabs, notifications: c.notifications, action: c.action, getURL: c.runtime.getURL };
  const tab = { id: TAB_ID, index: 0, windowId: 1, url: "https://x.com/home", status: "complete", pinned: true };
  const fx = { tab, commands: [], navigations: [], notifications: [], content: content || (async () => ({ ok: true })), page: { state: "ok", detail: "", me: "0x_nation", hidden: false, ...page } };
  // Flow pauses (humanDelay sleeps, navigation polling, send timeouts) become a few milliseconds at most.
  globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.min(4, Math.max(0, Number(ms) || 0) / 1000), ...a);
  c.runtime.getURL = (p) => "chrome-extension://test/" + (p || "");
  c.notifications = { async create(id, o) { fx.notifications.push({ id, title: o.title, message: o.message }); return id; }, async clear() {} };
  c.action = { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setBadgeTextColor() {}, async setTitle() {} };
  c.tabs = {
    async get(id) { if (id !== TAB_ID) throw new Error("No tab with id: " + id); return { ...tab }; },
    async update(id, props) {
      if (id !== TAB_ID) throw new Error("No tab with id: " + id);
      if (props.url) {
        // The new page loads and announces itself at once. (Announcing it from a timer could lose the race against
        // navigate()'s scaled ready timeout, and with a frozen test clock navigate() would then poll forever.)
        tab.url = props.url;
        tab.status = "complete";
        fx.navigations.push(props.url);
        tabs.onContentReady(TAB_ID, tab.url);
      }
      return { ...tab };
    },
    async query() { return [{ ...tab }]; },
    async sendMessage(id, msg) {
      if (id !== TAB_ID || tab.status !== "complete") throw new Error("Could not establish connection. Receiving end does not exist.");
      fx.commands.push([msg.sx, tab.url]);
      let base;
      if (msg.sx === "ping") base = { ok: true, me: fx.page.me };
      else if (msg.sx === "waitFor") base = await fx.content(tab.url, msg) || { ok: true, key: (msg.keys || [])[0] };
      else base = await fx.content(tab.url, msg);
      return { ...(base || { ok: true }), page: { ...fx.page, url: tab.url } };
    },
  };
  fx.uninstall = () => {
    globalThis.setTimeout = saved.setTimeout;
    c.tabs = saved.tabs; c.notifications = saved.notifications; c.action = saved.action; c.runtime.getURL = saved.getURL;
  };
  return fx;
}
