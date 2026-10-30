import { resetStorage, rawGet } from "./_chrome.mjs";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as store from "../../extension/lib/store.js";
import { DEFAULT_MODELS, DEFAULT_PRESETS, DEFAULT_FALLBACK } from "../../extension/lib/models.js";
import { HARD, K, MODE, STATUS } from "../../extension/lib/constants.js";
import { _setClock, sleep } from "../../extension/lib/util.js";

const { sanitizeSettings, DEFAULT_SETTINGS } = store;
const snapshot = (v) => JSON.parse(JSON.stringify(v));

describe("store.js", () => {
  beforeEach(() => resetStorage());
  afterEach(() => _setClock(null));

  describe("sanitizeSettings", () => {
    test("defaults come back unchanged and valid", () => {
      const s = sanitizeSettings({});
      assert.equal(s.timezone, "Asia/Dhaka");
      assert.equal(s.mode, MODE.REVIEW);
      assert.deepEqual(s.safety.ramp, [10, 20, 30]);
      assert.deepEqual(s.safety.gapMin, { min: 3, max: 12 });
      assert.equal(s.models.length, 3);
      assert.equal(s.presets.high.modelId, "m_best");
      assert.equal(sanitizeSettings(null).timezone, "Asia/Dhaka");
      assert.equal(sanitizeSettings(undefined).account.handle, "0x_nation");
    });

    test("HARD caps cannot be exceeded", () => {
      const s = sanitizeSettings({
        safety: {
          ramp: [50, 50, 50], perTargetDay: 5, perTargetWeek: 9, like: { enabled: true, dailyLimit: 500 },
          gapMin: { min: 0, max: 1 }, maxConsecutiveFailures: 99,
        },
        cleanup: { afterDays: 1, dailyLimit: 999 },
        groups: { A: { dailyLimit: 100 }, B: { dailyLimit: -5 } },
        quality: { maxChars: 1000 },
        watch: { checkIntervalSec: { min: 5, max: 10 } },
      });
      assert.deepEqual(s.safety.ramp, [HARD.dailyComments, HARD.dailyComments, HARD.dailyComments]);
      assert.deepEqual(s.safety.ramp, [30, 30, 30]);
      assert.equal(s.safety.perTargetDay, 1);
      assert.equal(s.safety.perTargetWeek, 3);
      assert.equal(s.safety.like.dailyLimit, 50);
      assert.equal(s.safety.gapMin.min, 2);
      assert.equal(s.safety.gapMin.max, 2);
      assert.equal(s.safety.maxConsecutiveFailures, HARD.maxPostFailures);
      assert.equal(s.cleanup.afterDays, 7);
      assert.equal(s.cleanup.dailyLimit, 30);
      assert.equal(s.groups.A.dailyLimit, 30);
      assert.equal(s.groups.B.dailyLimit, 0);
      assert.equal(s.quality.maxChars, HARD.maxCommentChars);
      assert.equal(s.watch.checkIntervalSec.min, HARD.minCheckIntervalSec);
      assert.equal(s.watch.checkIntervalSec.max, HARD.minCheckIntervalSec);
    });

    test("gap min 0 is raised to the 2 minute floor, garbage numbers fall back", () => {
      const s = sanitizeSettings({ safety: { gapMin: { min: 0, max: 12 }, ramp: ["x", null, 15.6] } });
      assert.equal(s.safety.gapMin.min, 2);
      assert.equal(s.safety.gapMin.max, 12);
      assert.deepEqual(s.safety.ramp, [10, 0, 16]); // "x" -> default, null -> 0 (Number(null)), 15.6 rounds
    });

    test("invalid timezone / mode / strategy fall back to defaults", () => {
      assert.equal(sanitizeSettings({ timezone: "Mars/Olympus" }).timezone, "Asia/Dhaka");
      assert.equal(sanitizeSettings({ timezone: "" }).timezone, "Asia/Dhaka");
      assert.equal(sanitizeSettings({ timezone: null }).timezone, "Asia/Dhaka");
      assert.equal(sanitizeSettings({ timezone: "America/New_York" }).timezone, "America/New_York");
      assert.equal(sanitizeSettings({ mode: "yolo" }).mode, MODE.REVIEW);
      assert.equal(sanitizeSettings({ mode: "auto" }).mode, MODE.AUTO);
      assert.equal(sanitizeSettings({ watch: { strategy: "magic" } }).watch.strategy, "search");
    });

    test("invalid HH:MM active hours -> defaults", () => {
      const s = sanitizeSettings({ safety: { activeHours: { enabled: true, start: "25:00", end: "noon" } } });
      assert.equal(s.safety.activeHours.start, "10:00");
      assert.equal(s.safety.activeHours.end, "00:00");
      const ok = sanitizeSettings({ safety: { activeHours: { start: "08:30", end: "22:15" } } });
      assert.equal(ok.safety.activeHours.start, "08:30");
      assert.equal(ok.safety.activeHours.end, "22:15");
    });

    test("swapped ranges are fixed", () => {
      const s = sanitizeSettings({
        safety: { gapMin: { min: 10, max: 5 }, typingCpm: { min: 400, max: 200 }, readDelaySec: { min: 20, max: 3 }, breaks: { minutesMin: 90, minutesMax: 30, afterMin: 6, afterMax: 2 } },
        watch: { checkIntervalSec: { min: 600, max: 200 } },
      });
      assert.deepEqual(s.safety.gapMin, { min: 5, max: 10 });
      assert.deepEqual(s.safety.typingCpm, { min: 200, max: 400 });
      assert.deepEqual(s.safety.readDelaySec, { min: 3, max: 20 });
      assert.equal(s.safety.breaks.minutesMin, 30);
      assert.equal(s.safety.breaks.minutesMax, 90);
      assert.ok(s.safety.breaks.afterMax >= s.safety.breaks.afterMin);
      assert.deepEqual(s.watch.checkIntervalSec, { min: 200, max: 600 });
    });

    test("lists are normalised (lowercase, trimmed, @ stripped)", () => {
      const s = sanitizeSettings({
        account: { handle: " @Me_Handle " },
        safety: { skip: { languages: [" EN ", "", "bn"], blockedWords: ["Scam", "  "], politicalKeywords: "not-an-array" } },
        cleanup: { whitelist: ["@Friend", " other "] },
        watch: { listUrls: [" https://x.com/i/lists/1 ", ""] },
      });
      assert.equal(s.account.handle, "Me_Handle");
      assert.deepEqual(s.safety.skip.languages, ["en", "bn"]);
      assert.deepEqual(s.safety.skip.blockedWords, ["scam"]);
      assert.deepEqual(s.safety.skip.politicalKeywords, []);
      assert.deepEqual(s.cleanup.whitelist, ["friend", "other"]);
      assert.deepEqual(s.watch.listUrls, ["https://x.com/i/lists/1"]);
    });

    test("presets / fallback referencing removed models are repaired", () => {
      const s = sanitizeSettings({
        models: [
          { id: "a", name: "model-a", prices: { input: 1, output: 2 } },
          { id: "b", name: "model-b", prices: { input: 3, output: 4 } },
        ],
      });
      const ids = s.models.map((m) => m.id);
      for (const k of ["high", "balanced", "cheap"]) assert.ok(ids.includes(s.presets[k].modelId), k);
      assert.equal(s.presets.high.modelId, "b");
      assert.equal(s.presets.balanced.modelId, "b");
      assert.equal(s.presets.cheap.modelId, "a");
      assert.equal(s.fallback.modelId, "a");
      assert.equal(s.fallback.secondModelId, "");
    });

    test("bad preset efforts / matrix / checker preset repaired", () => {
      const s = sanitizeSettings({
        presets: { high: { modelId: "m_best", effort: "ultra" } },
        fallback: { effort: "max" },
        presetMatrix: { A1: "nope", B2: "cheap" },
        quality: { checkerPreset: "ghost" },
      });
      assert.equal(s.presets.high.effort, "high");
      assert.equal(s.fallback.effort, "low");
      assert.equal(s.presetMatrix.A1, "balanced");
      assert.equal(s.presetMatrix.B2, "cheap");
      assert.equal(s.quality.checkerPreset, "cheap");
    });

    test("model price defaults (cachedInput = input/10, cacheWrite = input*1.25) and field defaults", () => {
      const s = sanitizeSettings({ models: [{ id: "x", name: " gpt-x ", prices: { input: 2 }, maxOutputTokens: 5, reasoning: false }] });
      const m = s.models[0];
      assert.equal(m.name, "gpt-x");
      assert.deepEqual(m.prices, { input: 2, cachedInput: 0.2, output: 0, cacheWrite: 2.5 });
      assert.equal(m.maxOutputTokens, 64);
      assert.equal(m.reasoning, false);
      assert.equal(m.label, "gpt-x");
      const neg = sanitizeSettings({ models: [{ id: "y", name: "y", prices: { input: -1, output: "abc" } }] }).models[0];
      assert.equal(neg.prices.input, 0);
      assert.equal(neg.prices.output, 0);
      assert.equal(neg.reasoning, true);
      assert.equal(sanitizeSettings({ models: [] }).models.length, DEFAULT_MODELS.length);
    });

    test("does not mutate the shared defaults or the caller's object", () => {
      const before = snapshot({ DEFAULT_SETTINGS, DEFAULT_MODELS, DEFAULT_PRESETS, DEFAULT_FALLBACK });
      const raw = { models: [{ id: "x", name: "only-model", prices: { input: 1 } }], safety: { ramp: [99, 99, 99] } };
      const rawBefore = snapshot(raw);
      const s = sanitizeSettings(raw);
      s.safety.skip.blockedWords.push("mutated");
      s.watch.strategy = "list";
      s.groups.A.tone = "bold";
      assert.deepEqual(snapshot({ DEFAULT_SETTINGS, DEFAULT_MODELS, DEFAULT_PRESETS, DEFAULT_FALLBACK }), before);
      assert.deepEqual(raw, rawBefore);
      // a later call with defaults still sees the original presets
      assert.equal(sanitizeSettings({}).presets.high.modelId, "m_best");
      assert.equal(sanitizeSettings({}).fallback.modelId, "m_balanced");
    });

    test("is idempotent", () => {
      const once = sanitizeSettings({ safety: { ramp: [50, 1, 2] }, timezone: "bad" });
      const twice = sanitizeSettings(snapshot(once));
      assert.deepEqual(twice, once);
    });
  });

  describe("storage helpers", () => {
    test("load returns a clone of the default when missing", async () => {
      const def = { a: [1] };
      const v = await store.load("missing", def);
      v.a.push(2);
      assert.deepEqual(def, { a: [1] });
      await store.save({ k: 5 });
      assert.equal(await store.load("k", 0), 5);
      await store.remove("k");
      assert.equal(await store.load("k", 0), 0);
    });

    test("withLock serialises 100 concurrent read-modify-writes", async () => {
      await Promise.all(Array.from({ length: 100 }, () => store.update("counter", 0, (v) => v + 1)));
      assert.equal(rawGet("counter"), 100);
    });

    test("withLock with an await between read and write still ends at 100", async () => {
      await store.save({ c2: 0 });
      await Promise.all(Array.from({ length: 100 }, () => store.withLock("c2", async () => {
        const v = await store.load("c2", 0);
        await sleep(0);
        await store.save({ c2: v + 1 });
      })));
      assert.equal(rawGet("c2"), 100);
    });

    test("without the lock the same pattern loses updates (proves the test is meaningful)", async () => {
      await store.save({ c3: 0 });
      await Promise.all(Array.from({ length: 20 }, async () => {
        const v = await store.load("c3", 0);
        await sleep(0);
        await store.save({ c3: v + 1 });
      }));
      assert.ok(rawGet("c3") < 20);
    });

    test("withLock keeps working after fn throws and returns fn's value", async () => {
      await assert.rejects(store.withLock("x", async () => { throw new Error("boom"); }), /boom/);
      assert.equal(await store.withLock("x", async () => 42), 42);
      const order = [];
      await Promise.all([
        store.withLock("y", async () => { await sleep(5); order.push(1); }),
        store.withLock("y", async () => { order.push(2); }),
        store.withLock("z", async () => { order.push(3); }), // other key not blocked
      ]);
      assert.deepEqual(order, [3, 1, 2]);
    });

    test("update: fn may mutate in place or return a new value", async () => {
      assert.deepEqual(await store.update("o", { n: 0 }, (o) => { o.n++; }), { n: 1 });
      assert.deepEqual(await store.update("o", {}, () => ({ n: 9 })), { n: 9 });
      assert.deepEqual(rawGet("o"), { n: 9 });
    });

    test("getSettings / saveSettings sanitise", async () => {
      const s = await store.getSettings();
      assert.equal(s.timezone, "Asia/Dhaka");
      const saved = await store.saveSettings({ safety: { ramp: [40, 40, 40] } });
      assert.deepEqual(saved.safety.ramp, [30, 30, 30]);
      assert.deepEqual((await store.getSettings()).safety.ramp, [30, 30, 30]);
    });

    test("state / secrets / targets accessors", async () => {
      const st = await store.getState();
      assert.equal(st.status, STATUS.STOPPED);
      await store.patchState({ status: STATUS.RUNNING, tickCount: 2 });
      await store.patchState((cur) => ({ tickCount: cur.tickCount + 1 }));
      const st2 = await store.getState();
      assert.equal(st2.status, STATUS.RUNNING);
      assert.equal(st2.tickCount, 3);
      assert.equal(st2.commentsSinceBreak, 0);

      assert.deepEqual(await store.getSecrets(), { openaiKey: "", sorsaKey: "" });
      await store.setSecrets({ openaiKey: "sk-test" });
      await store.setSecrets({ sorsaKey: "s" });
      assert.deepEqual(await store.getSecrets(), { openaiKey: "sk-test", sorsaKey: "s" });

      await store.updateTargets((all) => { all.foo = { handle: "foo" }; return all; });
      assert.deepEqual(await store.getTargets(), { foo: { handle: "foo" } });
      await store.updateCandidates((all) => { all.bar = 1; });
      assert.deepEqual(await store.getCandidates(), { bar: 1 });
    });

    test("log redacts secrets and is capped", async () => {
      _setClock(() => 1000);
      await store.log("info", "using key sk-abcdefghijklmnop", { auth: "Bearer abcdefghijkl" });
      const logs = rawGet(K.logs);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].ts, 1000);
      assert.ok(!logs[0].msg.includes("abcdefghijklmnop"));
      assert.ok(!logs[0].data.includes("abcdefghijkl"));
      await Promise.all(Array.from({ length: 410 }, (_, i) => store.log("debug", "m" + i)));
      const capped = rawGet(K.logs);
      assert.equal(capped.length, 400);
      assert.equal(capped[capped.length - 1].msg, "m409");
    });

    test("markSeen keeps the first-seen time", async () => {
      _setClock(() => 100);
      await store.markSeen(["1", "2", ""]);
      _setClock(() => 200);
      await store.markSeen(["2", "3"]);
      assert.deepEqual(await store.getSeen(), { 1: 100, 2: 100, 3: 200 });
    });

    test("ensureDefaults writes settings/state/schema once", async () => {
      await store.ensureDefaults();
      assert.ok(rawGet(K.settings));
      assert.equal(rawGet(K.state).status, STATUS.STOPPED);
      assert.equal(rawGet(K.schema), 1);
      await store.save({ [K.settings]: { mode: "auto" } });
      await store.ensureDefaults();
      assert.deepEqual(rawGet(K.settings), { mode: "auto" });
    });
  });
});
