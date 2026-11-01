// License (lib/license.js): locked until a key is activated; one browser per key (the server decides); checked every
// 6 hours; 3 days of grace when the server cannot be reached; revoked / reset / used elsewhere locks at the next check.
import { resetStorage, rawGet } from "./_chrome.mjs";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as L from "../../extension/lib/license.js";
import { K } from "../../extension/lib/constants.js";
import { _setClock, HOUR, DAY } from "../../extension/lib/util.js";

const KEY = "SCX-ABCD-EFGH-JKLM-NPQR";
const json = (status, body) => ({ status, ok: status < 300, json: async () => body });

// A fake license server: one key, bound to the first install ID; `mode` changes what verify answers.
function fakeServer() {
  const s = { calls: [], boundTo: null, mode: "ok" };
  s.fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    s.calls.push({ path: new URL(url).pathname, body, origin: new URL(url).origin });
    if (s.mode === "down") throw new TypeError("Failed to fetch");
    if (s.mode === "html") return { status: 502, ok: false, json: async () => { throw new SyntaxError("not json"); } };
    if (body.key !== KEY) return json(404, { ok: false, error: "invalid", message: "This license key doesn't exist." });
    if (s.mode === "revoked") return json(403, { ok: false, error: "revoked", message: "This license key was turned off by your admin." });
    if (s.mode === "rate") return json(429, { ok: false, error: "rate", message: "Too many tries." });
    if (new URL(url).pathname === "/api/activate") {
      if (s.boundTo && s.boundTo !== body.deviceId) return json(409, { ok: false, error: "used", message: "This license key is already used on another browser." });
      s.boundTo = body.deviceId;
      return json(200, { ok: true, status: "active", note: "Rafi" });
    }
    if (!s.boundTo) return json(409, { ok: false, error: "inactive", message: "No longer active on this browser." });
    if (s.boundTo !== body.deviceId) return json(409, { ok: false, error: "used", message: "Used on another browser." });
    return json(200, { ok: true, status: "active" });
  };
  return s;
}

describe("license", () => {
  let clock;
  beforeEach(() => { resetStorage(); clock = Date.UTC(2026, 10, 1, 8, 0); _setClock(() => clock); });
  afterEach(() => _setClock(null));

  test("locked until activated; a key works after activation; only key, install ID and version are sent", async () => {
    assert.equal(L.licenseState(await L.getLicense()).ok, false);
    assert.equal(L.licenseState(await L.getLicense()).reason, "none");
    const srv = fakeServer();
    const r = await L.activate("  scx-abcd-efgh-jklm-npqr ", { fetchImpl: srv.fetchImpl });
    assert.equal(r.ok, true, r.error);
    const lic = rawGet(K.license);
    assert.equal(lic.key, KEY);
    assert.equal(lic.status, "active");
    assert.equal(lic.note, "Rafi");
    assert.ok(lic.deviceId && lic.deviceId.length >= 16);
    assert.equal(L.licenseState(lic).ok, true);
    assert.deepEqual(Object.keys(srv.calls[0].body).sort(), ["deviceId", "key", "version"]);
    assert.equal(srv.calls[0].origin, new URL(L.LICENSE_SERVER).origin);
  });

  test("bad format never reaches the server; a refused key explains why; the install ID stays the same across tries", async () => {
    const srv = fakeServer();
    assert.match((await L.activate("hello", { fetchImpl: srv.fetchImpl })).error, /doesn't look like a ScoreX key/);
    assert.equal(srv.calls.length, 0);
    const r1 = await L.activate("SCX-ZZZZ-ZZZZ-ZZZZ-ZZZZ", { fetchImpl: srv.fetchImpl });
    assert.match(r1.error, /doesn't exist/);
    const dev1 = rawGet(K.license).deviceId;
    await L.activate(KEY, { fetchImpl: srv.fetchImpl });
    assert.equal(rawGet(K.license).deviceId, dev1, "the same install ID");
    srv.mode = "down";
    resetStorage();
    assert.match((await L.activate(KEY, { fetchImpl: srv.fetchImpl })).error, /Can't reach the license server/);
    assert.equal(L.licenseState(await L.getLicense()).ok, false);
  });

  test("the same key on a second browser is refused (the server binds it to the first install)", async () => {
    const srv = fakeServer();
    assert.equal((await L.activate(KEY, { fetchImpl: srv.fetchImpl })).ok, true);
    resetStorage(); // another browser: a new install ID
    const r = await L.activate(KEY, { fetchImpl: srv.fetchImpl });
    assert.equal(r.ok, false);
    assert.match(r.error, /already used on another browser/);
  });

  test("checks: at most every 6 hours; a revoked key locks at the next check", async () => {
    const srv = fakeServer();
    await L.activate(KEY, { fetchImpl: srv.fetchImpl });
    const n = srv.calls.length;
    clock += 2 * HOUR;
    assert.equal((await L.verify({ fetchImpl: srv.fetchImpl })).ok, true);
    assert.equal(srv.calls.length, n, "no request before 6 hours");
    clock += 5 * HOUR;
    srv.mode = "revoked";
    const st = await L.verify({ fetchImpl: srv.fetchImpl });
    assert.equal(srv.calls.length, n + 1);
    assert.equal(st.ok, false);
    assert.equal(st.reason, "revoked");
    assert.match(st.message, /turned off by your admin/);
    srv.mode = "ok";
    assert.equal((await L.verify({ fetchImpl: srv.fetchImpl })).ok, true, "the admin turned it back on: the next check unlocks");
  });

  test("server unreachable: keeps working for 3 days after the last good check, then locks; a good check unlocks", async () => {
    const srv = fakeServer();
    await L.activate(KEY, { fetchImpl: srv.fetchImpl });
    srv.mode = "down";
    clock += 2 * DAY;
    assert.equal((await L.verify({ fetchImpl: srv.fetchImpl })).ok, true, "2 days offline: still working");
    srv.mode = "html"; // a proxy error page instead of JSON counts as unreachable, never as a refusal
    clock += 2 * DAY;
    const st = await L.verify({ fetchImpl: srv.fetchImpl });
    assert.equal(st.ok, false);
    assert.equal(st.reason, "offline");
    assert.equal(rawGet(K.license).status, "active", "nothing was refused: it only waits for a check");
    srv.mode = "ok";
    assert.equal((await L.verify({ fetchImpl: srv.fetchImpl })).ok, true);
  });

  test("a rate limit or server error is not a refusal; reset / used elsewhere lock", async () => {
    const srv = fakeServer();
    await L.activate(KEY, { fetchImpl: srv.fetchImpl });
    srv.mode = "rate";
    clock += 7 * HOUR;
    assert.equal((await L.verify({ fetchImpl: srv.fetchImpl })).ok, true);
    srv.mode = "ok";
    srv.boundTo = null; // the admin pressed Reset
    clock += 7 * HOUR;
    let st = await L.verify({ fetchImpl: srv.fetchImpl });
    assert.equal(st.reason, "inactive");
    srv.boundTo = "someone-else-0000";
    st = await L.verify({ force: true, fetchImpl: srv.fetchImpl });
    assert.equal(st.reason, "used");
  });

  test("remove: locks this browser, keeps the install ID (the same key works here again)", async () => {
    const srv = fakeServer();
    await L.activate(KEY, { fetchImpl: srv.fetchImpl });
    const dev = rawGet(K.license).deviceId;
    await L.removeLicense();
    assert.equal(L.licenseState(await L.getLicense()).ok, false);
    assert.equal(rawGet(K.license).deviceId, dev);
    assert.equal((await L.activate(KEY, { fetchImpl: srv.fetchImpl })).ok, true, "the server still knows this install");
  });

  test("normalizeKey and the view never show the full key", () => {
    assert.equal(L.normalizeKey("scxabcdefghjklmnpqr"), KEY);
    assert.equal(L.normalizeKey("SCX-ABCD-EFGH-JKLM-NPQ0"), "", "0 is not in the alphabet");
    const v = L.licenseView({ key: KEY, status: "active", checkedAt: clock, activatedAt: clock, note: "Rafi" });
    assert.equal(v.ok, true);
    assert.equal(v.hint, "…NPQR");
    assert.ok(!JSON.stringify(v).includes(KEY));
  });
});
