// ScoreX license server: one key, one browser. Run: npm test (in license-server/)
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { memoryDb, upstash } from "../lib/redis.js";
import { activate, verify, admin, newKey, normalizeKey, hashKey, KEY_RE } from "../lib/core.js";
import activateApi from "../api/activate.js";
import verifyApi from "../api/verify.js";
import adminApi from "../api/admin.js";

const SECRET = "correct horse battery staple";
const AUTH = "Bearer " + SECRET;
const DEV_A = "a1b2c3d4-0000-4000-8000-000000000001";
const DEV_B = "b1b2c3d4-0000-4000-8000-000000000002";

async function makeKeys(store, n = 1, note = "Rafi") {
  const r = await admin(store, { action: "create", count: n, note }, AUTH, "1.1.1.1", SECRET);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.keys;
}

describe("license keys", () => {
  let store;
  beforeEach(() => { store = memoryDb(); });

  test("keys look like SCX-XXXX-XXXX-XXXX-XXXX, are random, and only their hash is stored", async () => {
    const seen = new Set();
    for (let i = 0; i < 500; i++) { const k = newKey(); assert.match(k, KEY_RE); seen.add(k); }
    assert.equal(seen.size, 500);
    const [k] = await makeKeys(store);
    assert.equal(k.hint, k.key.slice(-4));
    const raw = JSON.stringify(await store.get("lic:" + hashKey(k.key)));
    assert.ok(!raw.includes(k.key), "the key itself is never stored");
    assert.equal(normalizeKey(" " + k.key.toLowerCase().replace(/-/g, "") + " "), k.key, "pasted lower case without dashes still works");
    assert.equal(normalizeKey("SCX-1234-5678-ABCD-EFGH"), "", "0/1/O/I are not in the alphabet");
  });

  test("a key works on the first browser only; the same browser can activate again", async () => {
    const [{ key }] = await makeKeys(store);
    let r = await activate(store, { key, deviceId: DEV_A, version: "1.3.0" }, "2.2.2.2");
    assert.equal(r.status, 200);
    assert.equal(r.body.note, "Rafi");
    r = await activate(store, { key, deviceId: DEV_B }, "3.3.3.3");
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "used");
    assert.match(r.body.message, /already used on another browser/);
    r = await activate(store, { key, deviceId: DEV_A }, "2.2.2.2");
    assert.equal(r.status, 200, "re-activating on the same browser is fine");
    assert.equal((await verify(store, { key, deviceId: DEV_A }, "2.2.2.2")).status, 200);
    assert.equal((await verify(store, { key, deviceId: DEV_B }, "3.3.3.3")).body.error, "used", "a copy on another browser fails its check");
  });

  test("two browsers activating at the same moment: exactly one wins", async () => {
    const [{ key }] = await makeKeys(store);
    const devs = Array.from({ length: 8 }, (_, i) => `dev-${i}-xxxxxxxx`);
    const rs = await Promise.all(devs.map((d) => activate(store, { key, deviceId: d }, "4.4.4.4")));
    assert.equal(rs.filter((r) => r.status === 200).length, 1);
    assert.equal(rs.filter((r) => r.status === 409).length, 7);
  });

  test("unknown and malformed keys are refused without telling which part was wrong", async () => {
    assert.equal((await activate(store, { key: newKey(), deviceId: DEV_A }, "5.5.5.5")).status, 404);
    assert.equal((await activate(store, { key: "hello", deviceId: DEV_A }, "5.5.5.5")).status, 400);
    assert.equal((await activate(store, { key: newKey(), deviceId: "x" }, "5.5.5.5")).status, 400, "an install id is required");
    assert.equal((await verify(store, { key: newKey(), deviceId: DEV_A }, "5.5.5.5")).status, 404);
  });

  test("revoke turns a key off (activation and checks fail); reset frees it for a new browser", async () => {
    const [k] = await makeKeys(store);
    await activate(store, { key: k.key, deviceId: DEV_A }, "6.6.6.6");
    let r = await admin(store, { action: "revoke", id: k.id }, AUTH, "1.1.1.1", SECRET);
    assert.equal(r.status, 200);
    assert.equal((await verify(store, { key: k.key, deviceId: DEV_A }, "6.6.6.6")).body.error, "revoked");
    assert.equal((await activate(store, { key: k.key, deviceId: DEV_B }, "6.6.6.6")).body.error, "revoked");
    r = await admin(store, { action: "reset", id: k.id }, AUTH, "1.1.1.1", SECRET);
    assert.equal(r.status, 200);
    assert.equal((await verify(store, { key: k.key, deviceId: DEV_A }, "6.6.6.6")).body.error, "inactive", "the old browser stops after a reset");
    assert.equal((await activate(store, { key: k.key, deviceId: DEV_B }, "7.7.7.7")).status, 200, "the new browser can activate");
    assert.equal((await activate(store, { key: k.key, deviceId: DEV_A }, "6.6.6.6")).status, 409);
  });

  test("list shows status, note, dates and version - never the key; delete removes it", async () => {
    const keys = await makeKeys(store, 3, "Team");
    await activate(store, { key: keys[0].key, deviceId: DEV_A, version: "1.3.0" }, "8.8.8.8");
    let r = await admin(store, { action: "list" }, AUTH, "1.1.1.1", SECRET);
    assert.equal(r.body.keys.length, 3);
    const a = r.body.keys.find((x) => x.id === keys[0].id);
    assert.equal(a.status, "active");
    assert.equal(a.version, "1.3.0");
    assert.equal(a.note, "Team");
    assert.ok(a.activatedAt && a.lastSeenAt);
    assert.ok(!JSON.stringify(r.body).includes(keys[0].key));
    await admin(store, { action: "delete", id: keys[1].id }, AUTH, "1.1.1.1", SECRET);
    r = await admin(store, { action: "list" }, AUTH, "1.1.1.1", SECRET);
    assert.equal(r.body.keys.length, 2);
    assert.equal((await activate(store, { key: keys[1].key, deviceId: DEV_B }, "8.8.8.8")).status, 404, "a deleted key no longer works");
  });

  test("admin: wrong password refused, rate limited after 10 tries; a missing ADMIN_SECRET is explained", async () => {
    assert.equal((await admin(store, { action: "list" }, "Bearer nope", "9.9.9.9", SECRET)).status, 401);
    for (let i = 0; i < 12; i++) await admin(store, { action: "list" }, "Bearer nope", "9.9.9.9", SECRET);
    assert.equal((await admin(store, { action: "list" }, "Bearer nope", "9.9.9.9", SECRET)).status, 429);
    assert.equal((await admin(store, { action: "list" }, AUTH, "1.1.1.1", "")).body.error, "setup");
    assert.equal((await admin(store, { action: "create", count: 500 }, AUTH, "1.1.1.1", SECRET)).body.keys.length, 100, "at most 100 at once");
  });

  test("activation tries are rate limited per IP (guessing keys is pointless anyway: 80 random bits)", async () => {
    for (let i = 0; i < 20; i++) await activate(store, { key: newKey(), deviceId: DEV_A }, "10.0.0.1");
    assert.equal((await activate(store, { key: newKey(), deviceId: DEV_A }, "10.0.0.1")).status, 429);
    assert.equal((await activate(store, { key: newKey(), deviceId: DEV_A }, "10.0.0.2")).status, 404, "another IP is not affected");
  });
});

// ---------- the Vercel functions (req/res) ----------
function call(fn, { method = "POST", body = {}, headers = {} } = {}) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(data) { resolve({ status: this.statusCode, headers: this.headers, body: data ? JSON.parse(data) : null }); } };
    fn({ method, body, headers: { "x-forwarded-for": "11.0.0.1", ...headers } }, res);
  });
}

describe("vercel functions", () => {
  beforeEach(() => { globalThis.__scxTestDb = memoryDb(); process.env.ADMIN_SECRET = SECRET; });

  test("CORS for the extension: preflight answered, POST allowed from any origin; admin has no CORS", async () => {
    const pre = await call(activateApi, { method: "OPTIONS" });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers["access-control-allow-origin"], "*");
    const a = await call(adminApi, { body: { action: "list" }, headers: { authorization: AUTH } });
    assert.equal(a.status, 200);
    assert.equal(a.headers["access-control-allow-origin"], undefined);
    assert.equal((await call(verifyApi, { method: "GET" })).status, 405);
  });

  test("end to end through the functions: create, activate, verify, second browser refused", async () => {
    const c = await call(adminApi, { body: { action: "create", count: 1, note: "Mim" }, headers: { authorization: AUTH } });
    const key = c.body.keys[0].key;
    assert.equal((await call(activateApi, { body: { key, deviceId: DEV_A, version: "1.3.0" } })).status, 200);
    assert.equal((await call(verifyApi, { body: { key, deviceId: DEV_A } })).body.ok, true);
    const b = await call(activateApi, { body: { key, deviceId: DEV_B } });
    assert.equal(b.status, 409);
    assert.equal(b.body.error, "used");
    assert.equal((await call(activateApi, { body: JSON.stringify({ key, deviceId: DEV_A }) })).status, 200, "a string body is parsed too");
  });

  test("storage not set up: a clear message, no stack trace", async () => {
    delete globalThis.__scxTestDb;
    const save = { a: process.env.KV_REST_API_URL, b: process.env.UPSTASH_REDIS_REST_URL };
    delete process.env.KV_REST_API_URL; delete process.env.UPSTASH_REDIS_REST_URL;
    const r = await call(activateApi, { body: { key: newKey(), deviceId: DEV_A } });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "setup");
    assert.match(r.body.message, /Upstash Redis/);
    if (save.a) process.env.KV_REST_API_URL = save.a;
    if (save.b) process.env.UPSTASH_REDIS_REST_URL = save.b;
  });

  test("the Upstash REST client sends Redis commands as JSON arrays with the token", async () => {
    const sent = [];
    const fake = async (url, init) => { sent.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) }); const cmd = JSON.parse(init.body); return { ok: true, json: async () => ({ result: cmd[0] === "SET" ? "OK" : cmd[0] === "GET" ? JSON.stringify({ a: 1 }) : 1 }) }; };
    const r = upstash("https://x.upstash.io", "tok", fake);
    assert.equal(await r.setNX("k", { a: 1 }), true);
    assert.deepEqual(await r.get("k"), { a: 1 });
    assert.deepEqual(sent[0], { url: "https://x.upstash.io", auth: "Bearer tok", body: ["SET", "k", "{\"a\":1}", "NX"] });
  });
});
