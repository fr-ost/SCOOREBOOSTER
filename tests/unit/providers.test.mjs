import "./_chrome.mjs";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as PR from "../../extension/lib/pagereader.js";
import * as P from "../../extension/lib/providers.js";

const res = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });

describe("pagereader helpers", () => {
  test("pluck: dot paths, indexes, alternatives, no prototype access", () => {
    const o = { a: { b: [{ c: 5 }] }, s: "x" };
    assert.equal(PR.pluck(o, "a.b[0].c"), 5);
    assert.equal(PR.pluck(o, ["nope", "a.b.0.c"]), 5);
    assert.equal(PR.pluck(o, "a.zzz.c"), undefined);
    assert.equal(PR.pluck(o, "__proto__.polluted"), undefined);
    assert.equal(PR.pluck(o, "constructor"), undefined);
    assert.equal(PR.pluck(o, ""), o);
  });
  test("toNumber understands scores and counts", () => {
    assert.equal(PR.toNumber("523"), 523);
    assert.equal(PR.toNumber("523.4/1000"), 523.4);
    assert.equal(PR.toNumber("1,234"), 1234);
    assert.equal(PR.toNumber("12.3K"), 12300);
    assert.equal(PR.toNumber("Score: 77"), 77);
    assert.equal(PR.toNumber(88), 88);
    assert.equal(PR.toNumber(NaN), null);
    assert.equal(PR.toNumber("n/a"), null);
    assert.equal(PR.toNumber(null), null);
  });
  test("cleanHandle accepts @handles and profile links only", () => {
    assert.equal(PR.cleanHandle("@VitalikButerin"), "vitalikbuterin");
    assert.equal(PR.cleanHandle("https://x.com/Foo/status/1"), "foo");
    assert.equal(PR.cleanHandle("https://twitter.com/bar"), "bar");
    assert.equal(PR.cleanHandle("not a handle!"), "");
    assert.equal(PR.cleanHandle("waytoolonghandle_123"), "");
  });
  test("pickList maps fields, dedupes, drops bad handles, honours the limit", () => {
    const json = { data: { items: [
      { username: "Alice", name: "A", score: "812", followers_count: 1200 },
      { username: "alice", name: "dup" },
      { screen_name: "bob", score: 300 },
      { username: "bad handle" },
      "carol",
      null,
    ] } };
    const list = PR.pickList({ path: "data.items", limit: 10 }, json);
    assert.deepEqual(list.map((x) => x.handle), ["alice", "bob", "carol"]);
    assert.equal(list[0].score, 812);
    assert.equal(list[0].followers, 1200);
    assert.equal(PR.pickList({ path: "data.items", limit: 1 }, json).length, 1);
    assert.deepEqual(PR.pickList({ path: "nope" }, json), []);
  });
  test("jsonFromHtml / textFromHtml", () => {
    const html = `<html><head><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"score":642}}}</script>
      <script type="application/ld+json">{"name":"x"}</script><style>.a{}</style></head><body><h1>Score&nbsp;642</h1><script>evil()</script></body></html>`;
    assert.equal(PR.jsonFromHtml(html).props.pageProps.score, 642);
    assert.equal(PR.jsonFromHtml(html, "ldjson").name, "x");
    assert.equal(PR.jsonFromHtml("<html></html>"), undefined);
    assert.equal(PR.textFromHtml(html).includes("Score 642"), true);
    assert.equal(PR.textFromHtml(html).includes("evil"), false);
  });
  test("normalizeExtract never trusts page data", () => {
    assert.equal(PR.normalizeExtract(null, {}).ok, false);
    assert.equal(PR.normalizeExtract({ notFound: true }, { score: {} }).error, "not_found");
    assert.equal(PR.normalizeExtract({ score: "abc", loginWall: true }, { score: {} }).error, "login");
    assert.equal(PR.normalizeExtract({ score: "abc" }, { score: {} }).error, "parse");
    const r = PR.normalizeExtract({ url: "https://site/x", score: "712/1000", list: [{ handle: "@Ann", score: "90" }, { handle: "x y" }, { handle: "ann" }] }, { score: {}, list: { limit: 5 } });
    assert.equal(r.ok, true);
    assert.equal(r.score, 712);
    assert.deepEqual(r.list, [{ handle: "ann", name: "", score: 90, followers: null }]);
  });
});

describe("fetchData classification", () => {
  test("auth, bot check, rate limit, not found, non-JSON, network, timeout", async () => {
    assert.equal((await PR.fetchData("https://a", { fetchImpl: async () => res(401, {}) })).error, "auth");
    assert.equal((await PR.fetchData("https://a", { fetchImpl: async () => res(403, "<title>Just a moment...</title>") })).error, "blocked");
    assert.equal((await PR.fetchData("https://a", { fetchImpl: async () => res(403, "{}") })).error, "auth");
    assert.equal((await PR.fetchData("https://a", { fetchImpl: async () => res(429, {}) })).error, "rate");
    assert.equal((await PR.fetchData("https://a", { fetchImpl: async () => res(404, {}) })).error, "not_found");
    assert.equal((await PR.fetchData("https://a", { fetchImpl: async () => res(200, "<html>") })).error, "parse");
    assert.equal((await PR.fetchData("https://a", { fetchImpl: async () => { throw new Error("offline"); } })).error, "network");
    const slow = (url, opts) => new Promise((_, rej) => opts.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    assert.equal((await PR.fetchData("https://a", { fetchImpl: slow, timeoutMs: 30 })).error, "timeout");
    const ok = await PR.fetchData("https://a", { fetchImpl: async () => res(200, { score: 1 }) });
    assert.deepEqual(ok.json, { score: 1 });
    const html = await PR.fetchData("https://a", { as: "text", fetchImpl: async () => res(200, "<b>hi</b>") });
    assert.equal(html.text, "<b>hi</b>");
  });
});

describe("providers", () => {
  const def = {
    id: "demo", name: "Demo", max: 1000, profileUrl: "https://demo.io/u/{handle}",
    modes: {
      api: { hosts: ["https://api.demo.io/*"], score: { kind: "json", url: "https://api.demo.io/score?u={handle}", headers: { "X-Key": "{key}" }, value: { path: ["data.score", "score"] } },
        smartFollowers: { kind: "json", url: "https://api.demo.io/top?u={handle}", headers: { "X-Key": "{key}" }, list: { path: "data.top", limit: 6 }, total: { path: "data.total" } } },
      public: { hosts: ["https://demo.io/*"], score: { kind: "html", url: "https://demo.io/u/{handle}", json: "nextData", value: { path: "props.score", regex: "([\\d.]+)" } } },
      page: { hosts: ["https://demo.io/*"], smartFollowers: { kind: "tab", url: "https://demo.io/u/{handle}/followers", list: { selector: ".row", limit: 6 } } },
    },
  };

  test("fill encodes template variables", () => {
    assert.equal(P.fill("https://x/{handle}?k={key}", { handle: "a b", key: "k&1" }), "https://x/a%20b?k=k%261");
  });

  test("json score: key header, field alternatives, default max", async () => {
    let seen = null;
    const r = await P.runCapability(def, "api", "score", "@Alice", { key: "K1", fetchImpl: async (url, opts) => { seen = { url, opts }; return res(200, { score: 640 }); } });
    assert.equal(seen.url, "https://api.demo.io/score?u=alice");
    assert.equal(seen.opts.headers["X-Key"], "K1");
    assert.deepEqual({ ok: r.ok, score: r.score, max: r.max, url: r.url }, { ok: true, score: 640, max: 1000, url: "https://demo.io/u/alice" });
  });

  test("json list: smart followers with total", async () => {
    const r = await P.runCapability(def, "api", "smartFollowers", "alice", { key: "K", fetchImpl: async () => res(200, { data: { total: 42, top: [{ username: "Big1", score: 900 }, { username: "big2" }] } }) });
    assert.equal(r.ok, true);
    assert.equal(r.total, 42);
    assert.deepEqual(r.list.map((x) => x.handle), ["big1", "big2"]);
  });

  test("html score from embedded JSON; missing data is a parse error, not a crash", async () => {
    const page = `<script id="__NEXT_DATA__" type="application/json">{"props":{"score":"712 / 1000"}}</script>`;
    assert.equal((await P.runCapability(def, "public", "score", "bob", { fetchImpl: async () => res(200, page) })).score, 712);
    const bad = await P.runCapability(def, "public", "score", "bob", { fetchImpl: async () => res(200, "<html>nothing</html>") });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, "parse");
  });

  test("tab mode passes the spec to the page reader", async () => {
    let got = null;
    const readPage = async (url, spec) => { got = { url, spec }; return { ok: true, list: [{ handle: "z1", name: "", score: 1, followers: null }] }; };
    const r = await P.runCapability(def, "page", "smartFollowers", "carol", { readPage });
    assert.equal(got.url, "https://demo.io/u/carol/followers");
    assert.equal(got.spec.list.selector, ".row");
    assert.equal(r.ok, true);
    assert.equal(r.list[0].handle, "z1");
  });

  test("unsupported capability and HTTP errors come back as results", async () => {
    assert.equal((await P.runCapability(def, "public", "smartFollowers", "x")).error, "unsupported");
    assert.equal((await P.runCapability(def, "api", "score", "x", { key: "bad", fetchImpl: async () => res(401, {}) })).error, "auth");
  });

  test("pickMode and modeNeeds", () => {
    assert.equal(P.pickMode(def, "auto", false), "public");
    assert.equal(P.pickMode(def, "api", false), "public", "api without a key falls back");
    assert.equal(P.pickMode(def, "api", true), "api");
    assert.equal(P.pickMode(def, "page", false), "page");
    assert.equal(P.pickMode({ modes: { api: {} } }, "auto", false), null);
    assert.deepEqual(P.modeNeeds(def, "page"), { origins: ["https://demo.io/*"], permissions: ["scripting"] });
    assert.deepEqual(P.modeNeeds(def, "api"), { origins: ["https://api.demo.io/*"], permissions: [] });
  });

  test("overrides: only own hosts over https, no prototype keys, paths patched", () => {
    const defs = P.providerDefs({
      sorsa: { modes: { api: { score: { url: "https://evil.example/steal?u={handle}", value: { path: "data.new_score" } } } }, __proto__: { polluted: 1 } },
      unknown: { name: "x" },
    });
    assert.equal(defs.sorsa.modes.api.score.url.startsWith("https://api.sorsa.io/"), true, "foreign host ignored");
    assert.equal(defs.sorsa.modes.api.score.value.path, "data.new_score");
    assert.equal(defs.unknown, undefined);
    assert.equal({}.polluted, undefined);
    const http = P.providerDefs({ sorsa: { modes: { api: { score: { url: "http://api.sorsa.io/v3/score?username={handle}" } } } } });
    assert.equal(http.sorsa.modes.api.score.url.startsWith("https://"), true, "plain http ignored");
    const own = P.providerDefs({ sorsa: { modes: { api: { score: { url: "https://api.sorsa.io/v4/score?u={handle}" } } } } });
    assert.equal(own.sorsa.modes.api.score.url, "https://api.sorsa.io/v4/score?u={handle}");
  });
});
