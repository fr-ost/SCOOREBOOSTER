// Task D (data / storage / security) regression tests for lib/store.js.
import { resetStorage, rawGet } from "./_chrome.mjs";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as store from "../../extension/lib/store.js";
import { useMemoryDb } from "../../extension/lib/db.js";
import { K } from "../../extension/lib/constants.js";
import { allToneKeys } from "../../extension/lib/targets.js";
import { _setClock } from "../../extension/lib/util.js";

const { sanitizeSettings, DEFAULT_SETTINGS } = store;

describe("data: sanitizeSettings keeps the shape of the defaults", () => {
  test("null / array / plain-value sections fall back to the default section instead of throwing", () => {
    for (const raw of [
      { safety: null }, { safety: [] }, { safety: "x" }, { quality: null }, { review: 5 }, { presetMatrix: null },
      { safety: { skip: null, breaks: [], activeHours: "on" } }, { watch: null }, { follow: [] }, { presets: null, fallback: null },
      { learning: null }, { cleanup: null }, { discovery: "x" }, { groups: null }, { account: null }, { prompt: null }, { budget: [] },
    ]) {
      const s = sanitizeSettings(raw);
      assert.equal(s.safety.perTargetDay <= 2, true, JSON.stringify(raw));
      assert.equal(typeof s.safety.skip.minChars, "number", JSON.stringify(raw));
      assert.equal(s.presets.high.modelId, "m_best", JSON.stringify(raw));
    }
    assert.deepEqual(sanitizeSettings({ safety: null }).safety.ramp, [200, 200, 200]);
    assert.equal(sanitizeSettings({ safety: { activeHours: null } }).safety.activeHours.start, "10:00");
  });

  test("model rows that are not objects are dropped (they crashed the model loop)", () => {
    const s = sanitizeSettings({ modelsRev: 99, models: [null, "x", 5, { id: "a", name: "model-a", prices: { input: 1, output: 2 } }] });
    assert.deepEqual(s.models.map((m) => m.id), ["a"]);
    assert.equal(sanitizeSettings({ models: [null] }).models.length > 1, true, "nothing usable left -> built-in list");
  });

  test("custom tones are a clean list (a non-array broke every tone lookup, so generation failed)", () => {
    const s = sanitizeSettings({ customTones: { a: 1 } });
    assert.deepEqual(s.customTones, []);
    assert.doesNotThrow(() => allToneKeys(s));
    const t = sanitizeSettings({ customTones: [null, { id: " c1 ", name: "Calm", text: "Calm and short." }, { name: "no id" }, "str"] });
    assert.deepEqual(t.customTones, [{ id: "c1", name: "Calm", text: "Calm and short." }]);
    assert.deepEqual(allToneKeys(t).slice(-1), ["custom:c1"]);
  });

  test("prototype keys in stored or imported settings are dropped everywhere", () => {
    const raw = JSON.parse('{"tones":{"__proto__":{"evil":"x"}},"providers":{"__proto__":{"sorsa":{"enabled":true}}},"__proto__":{"zzz":1},"customTones":[{"id":"a","__proto__":{"text":"p"}}]}');
    const s = sanitizeSettings(raw);
    assert.equal(Object.getPrototypeOf(s.tones), Object.prototype);
    assert.equal(s.tones.evil, undefined);
    assert.equal(s.providers.sorsa.enabled, false, "an inherited provider entry does not switch a provider on");
    assert.equal(s.zzz, undefined);
    assert.equal(Object.getPrototypeOf(s.customTones[0]), Object.prototype);
  });

  test("legacy shapes the sanitiser converts still work (A/B tone array, whitelist / languages strings)", () => {
    const s = sanitizeSettings({ prompt: { tone: "" }, learning: { abTones: ["witty", "bold"] }, cleanup: { whitelist: "@friend" }, discovery: { languages: "EN, BN" } });
    assert.deepEqual(s.learning.abTones, { A: ["witty", "bold"], B: ["witty", "bold"] });
    assert.deepEqual(s.cleanup.whitelist, ["friend"]);
    assert.deepEqual(s.discovery.languages, ["en", "bn"]);
  });

  test("TwitterScore: the old 300/day default moves to 100 once; a cap chosen after that sticks", () => {
    assert.equal(sanitizeSettings({}).providers.twitterscore.dailyCap, 100);
    assert.equal(sanitizeSettings({ providers: { twitterscore: { enabled: true, dailyCap: 300 } } }).providers.twitterscore.dailyCap, 100);
    assert.equal(sanitizeSettings({ providers: { twitterscore: { dailyCap: 250 } } }).providers.twitterscore.dailyCap, 250, "a hand-made value is kept");
    const after = sanitizeSettings({ providersRev: 1, providers: { twitterscore: { dailyCap: 300 } } });
    assert.equal(after.providers.twitterscore.dailyCap, 300);
    assert.equal(after.providersRev, 1);
    assert.deepEqual(sanitizeSettings(JSON.parse(JSON.stringify(after))), after, "idempotent");
  });

  test("saveSettings stores the sanitized form (what is read back is what was checked)", async () => {
    resetStorage();
    const saved = await store.saveSettings({ models: [{ name: "no-id-model", prices: { input: 1 } }], modelsRev: 99, safety: { ramp: [999, 1, 2] } });
    const stored = rawGet(K.settings);
    assert.deepEqual(stored.safety.ramp, [200, 1, 2]);
    assert.ok(stored.models[0].id, "the generated model id is stored");
    assert.equal((await store.getSettings()).models[0].id, saved.models[0].id, "the id stays the same on every read");
  });

  test("does not mutate DEFAULT_SETTINGS", () => {
    const before = JSON.stringify(DEFAULT_SETTINGS);
    const s = sanitizeSettings({ safety: null, providers: { sorsa: { enabled: true } } });
    s.safety.ramp.push(1); s.providers.sorsa.enabled = false; s.models.pop();
    assert.equal(JSON.stringify(DEFAULT_SETTINGS), before);
  });
});

describe("data: secrets", () => {
  beforeEach(() => { resetStorage(); useMemoryDb(); });

  test("two contexts saving different keys at the same time keep both (one IndexedDB transaction)", async () => {
    // A second module instance = another JS context (dashboard tab vs service worker): its own withLock map,
    // the same database.
    const other = await import("../../extension/lib/store.js?context=2");
    await Promise.all([store.setSecrets({ openaiKey: "sk-aaaaaaaaaaaaaaaa" }), other.setSecrets({ sorsaKey: "sorsa-bbbb" })]);
    const s = await store.getSecrets();
    assert.equal(s.openaiKey, "sk-aaaaaaaaaaaaaaaa");
    assert.equal(s.sorsaKey, "sorsa-bbbb");
  });

  test("keys are trimmed, unknown names are not stored, the rev marker carries names only", async () => {
    await store.setSecrets({ moniKey: "  moni-key-123\n", bogus: "x", twitterscoreKey: null });
    const s = await store.getSecrets();
    assert.equal(s.moniKey, "moni-key-123");
    assert.equal(s.twitterscoreKey, "");
    assert.equal("bogus" in s, false);
    const rev = rawGet(K.secretsRev);
    assert.equal(rev.has.moniKey, true);
    assert.equal(JSON.stringify(rev).includes("moni-key-123"), false);
  });

  test("log() blanks provider keys: key query strings, key fields and known key values", async () => {
    _setClock(() => 1000);
    try {
      await store.setSecrets({ sorsaKey: "a1b2c3d4-sorsa-raw-key" });
      await store.log("warn", "GET https://twitterscore.io/api/v1/get_twitter_score?username=a&api_key=ts-secret-key-123 failed");
      await store.log("info", "ctx", { moniKey: "moni-secret-456", twitterscoreKey: "tsk-secret-789", ApiKey: "hdr-secret" });
      await store.log("error", "provider said: bad key a1b2c3d4-sorsa-raw-key (and encoded " + encodeURIComponent("a1b2c3d4-sorsa-raw-key") + ")");
      const text = JSON.stringify(rawGet(K.logs));
      for (const secret of ["ts-secret-key-123", "moni-secret-456", "tsk-secret-789", "hdr-secret", "a1b2c3d4-sorsa-raw-key"]) assert.equal(text.includes(secret), false, secret);
      assert.ok(text.includes("api_key=***"));
      assert.ok(text.includes("provider said: bad key ***"), "the rest of the message survives");
    } finally { _setClock(null); }
  });
});

describe("data: candidates cap", () => {
  beforeEach(() => resetStorage());

  test("capCandidates keeps the newest / best and drops filtered-out ones first", () => {
    const all = {};
    for (let i = 0; i < 10; i++) all["c" + i] = { handle: "c" + i, foundAt: 1000 + i, overlap: 1 };
    all.bad = { handle: "bad", foundAt: 99999, pass: false };
    all.best = { handle: "best", foundAt: 1000, overlap: 5 };
    all.seen = { handle: "seen", foundAt: 1, seenAt: 5000 };
    const dropped = store.capCandidates(all, 5);
    assert.equal(dropped, 8);
    assert.deepEqual(Object.keys(all).sort(), ["c6", "c7", "c8", "c9", "seen"].sort());
    const tie = { a: { foundAt: 5, overlap: 1 }, b: { foundAt: 5, overlap: 3 }, c: { foundAt: 5, overlap: 2, providerScores: { sorsa: 1 } } };
    store.capCandidates(tie, 2);
    assert.deepEqual(Object.keys(tie).sort(), ["b", "c"]);
  });

  test("every updateCandidates write is capped at 2,000", async () => {
    await store.updateCandidates((all) => { for (let i = 0; i < 2100; i++) all["h" + i] = { handle: "h" + i, foundAt: i }; });
    const c = rawGet(K.candidates);
    assert.equal(Object.keys(c).length, store.CANDIDATES_CAP);
    assert.equal(c.h0, undefined, "the oldest went first");
    assert.ok(c.h2099);
    await store.updateCandidates(() => ({}));
    assert.deepEqual(rawGet(K.candidates), {});
  });
});
