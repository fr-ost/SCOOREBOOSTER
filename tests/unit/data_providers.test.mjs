// Task D regression tests: score providers (lib/providers.js, lib/providerdefs.js) and the page reader
// (lib/pagereader.js).
import "./_chrome.mjs";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as PR from "../../extension/lib/pagereader.js";
import * as P from "../../extension/lib/providers.js";
import { PROVIDER_DEFS } from "../../extension/lib/providerdefs.js";

const res = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });

describe("data: provider overrides cannot redirect keys", () => {
  test("identity fields (keyName, profileUrl, site, hosts, dailyCap, id) are never taken from an override", () => {
    const defs = P.providerDefs({ sorsa: { keyName: "openaiKey", id: "x", site: "https://evil.example", profileUrl: "https://evil.example/{key}", keyHelp: "https://evil.example", dailyCap: 99999, modes: { api: { hosts: ["https://evil.example/*"] } } } });
    assert.equal(defs.sorsa.keyName, "sorsaKey", "a keyName override would send your OpenAI key to Sorsa");
    assert.equal(defs.sorsa.id, "sorsa");
    assert.equal(defs.sorsa.site, "https://sorsa.io");
    assert.equal(defs.sorsa.profileUrl, PROVIDER_DEFS.sorsa.profileUrl);
    assert.equal(defs.sorsa.dailyCap, PROVIDER_DEFS.sorsa.dailyCap);
    assert.deepEqual(defs.sorsa.modes.api.hosts, ["https://api.sorsa.io/*"]);
  });

  test("allowed fields still patch: paths, own-host URLs, regexes, deep list fields; no new modes", () => {
    const defs = P.providerDefs({
      twitterscore: {
        notFound: "gone", listLimit: 30,
        modes: {
          public: { score: { url: "https://twitterscore.io/v2/{handle}", value: { regex: "Score (\\d+)" } }, smartFollowers: { list: { fields: { handle: { attr: "data-h", regex: "(\\w+)" } }, limit: 40 } } },
          evil: { score: { kind: "json", url: "https://twitterscore.io/x" } },
        },
      },
    });
    const ts = defs.twitterscore;
    assert.equal(ts.notFound, "gone");
    assert.equal(ts.listLimit, 30);
    assert.equal(ts.modes.public.score.url, "https://twitterscore.io/v2/{handle}");
    assert.equal(ts.modes.public.score.value.regex, "Score (\\d+)");
    assert.deepEqual(ts.modes.public.smartFollowers.list.fields.handle, { attr: "data-h", regex: "(\\w+)" }, "deep fields are no longer dropped");
    assert.equal(ts.modes.public.smartFollowers.list.limit, 40);
    assert.equal(ts.modes.evil, undefined);
  });

  test("pageUrl must be https on the provider's hosts; kind must be known", () => {
    const defs = P.providerDefs({ ethos: { modes: { public: { score: { pageUrl: "https://evil.example/{handle}", kind: "script" } } } } });
    assert.equal(defs.ethos.modes.public.score.pageUrl, undefined);
    assert.equal(defs.ethos.modes.public.score.kind, "json");
  });

  test("header names must be tokens, values lose line breaks, forbidden names are dropped", () => {
    const defs = P.providerDefs({ sorsa: { modes: { api: { score: { headers: { "X-Evil\r\nInjected": "1", Cookie: "a=1", "X-Ok": "a\r\nb", "Sec-Fetch-Site": "none" } } } } } });
    assert.deepEqual(defs.sorsa.modes.api.score.headers, { ApiKey: "{key}", "X-Ok": "ab" });
  });

  test("the key never lands in a page link or a browser-tab URL", async () => {
    const withLink = P.providerDefs({ sorsa: { profileUrl: "https://evil.example/u/{handle}?k={key}" } }).sorsa;
    let r = await P.runCapability(withLink, "api", "score", "bob", { key: "SORSA-SECRET", fetchImpl: async () => res(200, { score: 5 }) });
    assert.equal(r.url.includes("SORSA-SECRET"), false);
    const tabbed = P.providerDefs({ twitterscore: { modes: { api: { score: { kind: "tab" } } } } }).twitterscore;
    let opened = "";
    await P.runCapability(tabbed, "api", "score", "bob", { key: "TS-SECRET", readPage: async (url) => { opened = url; return { ok: true, score: 1 }; } });
    assert.ok(opened.startsWith("https://twitterscore.io/"));
    assert.equal(opened.includes("TS-SECRET"), false, "a tab URL ends up in the browser history");
    const noLink = { id: "z", name: "Z", modes: { api: { hosts: ["https://api.z.io/*"], score: { kind: "json", url: "https://api.z.io/s?u={handle}&key={key}", value: { path: "s" } } } } };
    r = await P.runCapability(noLink, "api", "score", "bob", { key: "Z-SECRET", fetchImpl: async (url) => { assert.ok(url.includes("Z-SECRET"), "the API request itself carries the key"); return res(200, { s: 3 }); } });
    assert.equal(r.ok, true);
    assert.equal(r.url, "", "no page link rather than the key-bearing API URL");
  });

  test("a key with a trailing newline is trimmed before it goes into a header", async () => {
    let seen = null;
    await P.runCapability(PROVIDER_DEFS.sorsa, "api", "score", "bob", { key: " k-123\n", fetchImpl: async (url, opts) => { seen = opts.headers; return res(200, { score: 1 }); } });
    assert.equal(seen.ApiKey, "k-123");
  });
});

describe("data: provider definitions", () => {
  test("TwitterScore: 100 requests a day by default; tab reads take up to ~50 smart followers", () => {
    const ts = PROVIDER_DEFS.twitterscore;
    assert.equal(ts.dailyCap, 100);
    assert.equal(ts.modes.page.smartFollowers.list.limit, 50);
    assert.equal(ts.modes.public.smartFollowers.list.limit, 50);
  });

  test("a PRO page with 40 rows is read in full (not cut at the free 3 / old 6)", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ handle: "u" + i, name: "", score: 500 - i, followers: null }));
    const r = await P.runCapability(PROVIDER_DEFS.twitterscore, "page", "smartFollowers", "bigvc", { readPage: async () => ({ ok: true, list: rows }) });
    assert.equal(r.list.length, 40);
  });
});

describe("data: page reader", () => {
  afterEach(() => { delete globalThis.chrome.tabs; delete globalThis.chrome.scripting; delete globalThis.chrome.storage.session; });

  test("fetchData: the timeout covers a body that never finishes", async () => {
    const stalled = (url, opts) => Promise.resolve({ status: 200, ok: true, text: () => new Promise((resolve, reject) => opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))) });
    const t0 = Date.now();
    const r = await PR.fetchData("https://a", { fetchImpl: stalled, timeoutMs: 60 });
    assert.equal(r.error, "timeout");
    assert.ok(Date.now() - t0 < 1000);
    const deaf = () => Promise.resolve({ status: 200, ok: true, text: () => new Promise(() => {}) }); // ignores the signal
    assert.equal((await PR.fetchData("https://a", { fetchImpl: deaf, timeoutMs: 60 })).error, "timeout");
  });

  test("fetchData: a Cloudflare challenge is 'blocked' whatever the status (503 was a plain HTTP error)", async () => {
    const page = "<title>Just a moment...</title><div>challenge-platform</div>";
    for (const st of [503, 403, 200]) assert.equal((await PR.fetchData("https://a", { as: "text", fetchImpl: async () => res(st, page) })).error, "blocked", String(st));
    assert.equal((await PR.fetchData("https://a", { fetchImpl: async () => res(503, "down") })).error, "http");
  });

  test("cleanHandle: X's reserved paths and prototype names from third-party lists are not handles", () => {
    for (const h of ["__proto__", "constructor", "prototype", "home", "search", "explore", "i", "settings"]) assert.equal(PR.cleanHandle(h), "", h);
    assert.equal(PR.cleanHandle("https://x.com/Alice"), "alice");
    const list = PR.pickList({ path: "a" }, { a: [{ username: "__proto__" }, { username: "bob" }] });
    assert.deepEqual(list.map((x) => x.handle), ["bob"]);
  });

  test("readPageInTab: a page that never answers executeScript times out and its tab is closed", async () => {
    const removed = [];
    globalThis.chrome.tabs = {
      create: async () => ({ id: 7, status: "complete" }), update: async () => ({}), get: async (id) => ({ id, status: "complete", active: false }),
      remove: async (id) => { removed.push(id); }, onUpdated: { addListener() {}, removeListener() {} },
    };
    globalThis.chrome.scripting = { executeScript: () => new Promise(() => {}) };
    const t0 = Date.now();
    const r = await PR.readPageInTab("https://twitterscore.io/twitter/x/", { score: { regex: "(\\d+)" } }, { timeoutMs: 300, settleMs: 10 });
    assert.equal(r.ok, false);
    assert.equal(r.error, "timeout");
    assert.ok(Date.now() - t0 < 2500);
    assert.deepEqual(removed, [7]);
  });

  test("readPageInTab: a reader tab left by a killed worker is closed by the next read", async () => {
    const removed = [];
    const session = new Map([["sx.readerTab", { id: 41, at: 1 }]]);
    globalThis.chrome.storage.session = {
      get: async (k) => (session.has(k) ? { [k]: session.get(k) } : {}), set: async (o) => { for (const [k, v] of Object.entries(o)) session.set(k, v); }, remove: async (k) => { session.delete(k); },
    };
    let next = 50;
    globalThis.chrome.tabs = {
      create: async () => ({ id: next++, status: "complete" }), update: async () => ({}), get: async (id) => ({ id, status: "complete", active: false }),
      remove: async (id) => { removed.push(id); }, onUpdated: { addListener() {}, removeListener() {} },
    };
    globalThis.chrome.scripting = { executeScript: async () => [{ result: { url: "https://twitterscore.io/twitter/x/", score: "512" } }] };
    const r = await PR.readPageInTab("https://twitterscore.io/twitter/x/", { score: { regex: "(\\d+)" } }, { timeoutMs: 2000, settleMs: 0 });
    assert.equal(r.ok, true);
    assert.equal(r.score, 512);
    assert.deepEqual(removed, [41, 50], "the stale tab first, then its own");
    assert.equal(session.has("sx.readerTab"), false, "nothing left recorded after a clean read");
    session.set("sx.readerTab", { id: 77, at: 1 });
    globalThis.chrome.tabs.get = async (id) => ({ id, active: true });
    assert.equal(await PR.closeStaleReaderTab(), false, "a tab you are looking at is left alone");
  });
});
