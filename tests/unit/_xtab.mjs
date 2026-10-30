// Fake X worker tab for poster / watcher unit tests: chrome.tabs with a scripted "content script".
// Import AFTER ./_chrome.mjs. handlers: { [cmd]: (msg, tab) => response } (a missing handler answers { ok:true }).
// Every response gets a page report ({ state:"ok", me }) unless the handler returns its own `page`.
// fast(t) makes util.sleep() and the send() timeouts immediate for the test `t` (restored automatically).
import { onContentReady } from "../../extension/lib/tabs.js";

export const NEVER = () => new Promise(() => {});

export function okPage(me = "0x_nation", extra = {}) {
  return { state: "ok", detail: "", me, hidden: false, ...extra };
}

export function fakeTab(handlers = {}, { me = "0x_nation", url = "https://x.com/home" } = {}) {
  const tab = { id: 7, url, status: "complete", index: 0, pinned: true, windowId: 1, active: false };
  const calls = [];
  const env = { tab, calls, me };
  globalThis.chrome.tabs = {
    async get(id) { if (id !== tab.id) throw new Error("No tab with id " + id); return { ...tab }; },
    async update(id, props) {
      if (props && props.url) { tab.url = props.url; calls.push({ cmd: "navigate", url: props.url }); onContentReady(id, props.url); }
      return { ...tab };
    },
    async query() { return [{ ...tab }]; },
    async sendMessage(id, msg) {
      calls.push({ cmd: msg.sx, msg });
      const h = handlers[msg.sx];
      const out = h ? await h(msg, tab, env) : { ok: true };
      if (!out || typeof out !== "object") return out;
      return { ...out, page: out.page === undefined ? okPage(env.me) : out.page };
    },
  };
  env.cmds = () => calls.map((c) => c.cmd);
  env.count = (cmd) => calls.filter((c) => c.cmd === cmd).length;
  env.after = (cmd) => { const i = calls.map((c) => c.cmd).lastIndexOf(cmd); return i < 0 ? [] : calls.slice(i + 1).map((c) => c.cmd); };
  env.msgs = (cmd) => calls.filter((c) => c.cmd === cmd).map((c) => c.msg);
  return env;
}

export function fast(t) {
  const real = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, _ms, ...args) => real(fn, 0, ...args));
}
