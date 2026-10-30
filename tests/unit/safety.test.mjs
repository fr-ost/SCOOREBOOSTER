import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as safety from "../../extension/lib/safety.js";
import { sanitizeSettings } from "../../extension/lib/store.js";
import { HARD, MODE } from "../../extension/lib/constants.js";
import { DAY, HOUR, MIN, zonedTime, deepMerge, _setRandom, _setClock } from "../../extension/lib/util.js";

const DHAKA = "Asia/Dhaka";
// A "classic" careful setup (the first defaults): Asia/Dhaka, active 10:00-00:00, ramp [10,20,30], 1 per account.
// The owner's current defaults (200/day, 2 per account, 100 accounts, likes on, no active hours) are tested below.
const CLASSIC = { safetyRev: 2, safety: { ramp: [10, 20, 30], gapMin: { min: 3, max: 12 }, breaks: { enabled: true, afterMin: 3, afterMax: 6, minutesMin: 20, minutesMax: 60 }, activeHours: { enabled: true, start: "10:00", end: "00:00" }, perTargetDay: 1, perTargetWeek: 3, accountsPerDay: 100, like: { enabled: false }, readDelaySec: { min: 4, max: 12 } } };
const cfg = (over = {}) => sanitizeSettings(deepMerge(CLASSIC, over));
const settings = cfg();
const dhaka = (h, m, d = 29) => zonedTime(2026, 10, d, h, m, DHAKA);
const T0 = dhaka(11, 0, 1); // first start: 2026-10-01 11:00 Dhaka

describe("safety.js", () => {
  afterEach(() => { _setRandom(null); _setClock(null); });

  describe("mode", () => {
    test("Full auto is available immediately (no warm-up)", () => {
      assert.equal(safety.effectiveMode({ ...settings, mode: MODE.AUTO }, { firstStartedAt: null }, T0), MODE.AUTO);
      assert.equal(safety.effectiveMode({ ...settings, mode: MODE.AUTO }, { firstStartedAt: T0 }, T0 + 60000), MODE.AUTO);
      assert.equal(safety.effectiveMode(settings, { firstStartedAt: T0 }, T0 + 30 * DAY), MODE.REVIEW);
      assert.equal(safety.warmup, undefined);
    });
    test("uses the injected clock by default", () => {
      _setClock(() => T0 + 4 * DAY);
      assert.equal(safety.daysSinceStart({ firstStartedAt: T0 }), 4);
    });
  });

  describe("ramp and limits", () => {
    test("rampStage / dailyLimit by days since start", () => {
      const st = { firstStartedAt: T0 };
      for (let d = 0; d <= 25; d++) {
        const ts = T0 + d * DAY + 5 * HOUR;
        const exp = d <= 6 ? 0 : d <= 13 ? 1 : 2;
        assert.equal(safety.daysSinceStart(st, ts), d, `day ${d}`);
        assert.equal(safety.rampStage(st, ts), exp, `day ${d}`);
        assert.equal(safety.dailyLimit(settings, st, ts), [10, 20, 30][exp], `day ${d}`);
      }
      assert.equal(safety.rampStage(st, T0 + 7 * DAY - 1), 0);
      assert.equal(safety.rampStage(st, T0 + 7 * DAY), 1);
      assert.equal(safety.rampStage(st, T0 + 14 * DAY), 2);
    });
    test("not started / clock before start -> day 0", () => {
      assert.equal(safety.daysSinceStart({ firstStartedAt: null }, T0), 0);
      assert.equal(safety.daysSinceStart({ firstStartedAt: T0 }, T0 - DAY), 0);
      assert.equal(safety.dailyLimit(settings, { firstStartedAt: null }, T0), 10);
    });
    test("custom ramp, clamped to HARD even if settings were not sanitised", () => {
      const s = cfg({ safety: { ramp: [5, 15, 25] } });
      assert.equal(safety.dailyLimit(s, { firstStartedAt: T0 }, T0 + 8 * DAY), 15);
      const raw = { safety: { ramp: [999, 999, 999] } };
      assert.equal(safety.dailyLimit(raw, { firstStartedAt: T0 }, T0), HARD.dailyComments);
      assert.equal(HARD.dailyComments, 200);
      assert.equal(safety.dailyLimit({ safety: { ramp: [] } }, { firstStartedAt: T0 }, T0), 0);
    });
    test("generationLimit / likeLimit", () => {
      assert.equal(safety.generationLimit(settings, { firstStartedAt: T0 }, T0), 20);
      const s = cfg({ safety: { ramp: [15, 20, 30], generationFactor: 1.5 } });
      assert.equal(safety.generationLimit(s, { firstStartedAt: T0 }, T0), 23);
      assert.equal(safety.likeLimit(settings), 0); // likes off in this classic setup
      // No separate like limit: one like right before each comment, so the comment cap bounds it.
      assert.equal(safety.likeLimit(cfg({ safety: { like: { enabled: true, dailyLimit: 20 } } })), HARD.dailyLikes);
      assert.equal(HARD.dailyLikes, HARD.dailyComments);
    });
  });

  describe("active hours (Asia/Dhaka 10:00-00:00)", () => {
    test("23:30 local is inside, closes at midnight", () => {
      const ts = dhaka(23, 30);
      const a = safety.activeHours(settings, ts);
      assert.equal(a.inside, true);
      assert.equal(a.opensAt, ts);
      assert.equal(a.closesAt, dhaka(0, 0, 30));
    });
    test("00:30 local is outside, opens at 10:00 the same day", () => {
      const ts = dhaka(0, 30);
      const a = safety.activeHours(settings, ts);
      assert.equal(a.inside, false);
      assert.equal(a.opensAt, dhaka(10, 0));
      assert.equal(a.closesAt, null);
    });
    test("09:59 outside, 10:00 inside", () => {
      assert.equal(safety.activeHours(settings, dhaka(9, 59)).inside, false);
      assert.equal(safety.activeHours(settings, dhaka(10, 0)).inside, true);
    });
    test("disabled = always inside", () => {
      const s = cfg({ safety: { activeHours: { enabled: false } } });
      const a = safety.activeHours(s, dhaka(3, 0));
      assert.deepEqual(a, { inside: true, opensAt: dhaka(3, 0), closesAt: null });
    });
    test("respects another time zone", () => {
      const s = cfg({ timezone: "America/New_York", safety: { activeHours: { start: "09:00", end: "17:00" } } });
      const ts = Date.UTC(2026, 9, 29, 14, 0); // 10:00 EDT
      assert.equal(safety.activeHours(s, ts).inside, true);
      assert.equal(safety.activeHours(s, ts).closesAt, Date.UTC(2026, 9, 29, 21, 0));
      assert.equal(safety.activeHours(s, Date.UTC(2026, 9, 29, 22, 0)).opensAt, Date.UTC(2026, 9, 30, 13, 0));
    });
  });

  describe("pacing", () => {
    test("nextGapMs never below 2 minutes", () => {
      const raw = { safety: { gapMin: { min: 0, max: 0 } } };
      for (const r of [0, 0.01, 0.3, 0.5, 0.99]) {
        _setRandom(() => r);
        assert.ok(safety.nextGapMs(raw) >= HARD.minGapMin * MIN, String(r));
        assert.ok(safety.nextGapMs(settings) >= HARD.minGapMin * MIN, String(r));
      }
      _setRandom(() => 0.5);
      assert.equal(safety.nextGapMs(settings), 7.5 * MIN); // 3..12 min, centred
    });
    test("nextCheckMs never below the HARD check interval", () => {
      _setRandom(() => 0.5);
      const v = safety.nextCheckMs({ watch: { checkIntervalSec: { min: 10, max: 20 } } });
      assert.ok(v >= HARD.minCheckIntervalSec * 1000, String(v));
      assert.equal(safety.nextCheckMs(settings), Math.round((150 + 0.5 * 210) * 1000));
    });
    test("nextBreakAfter / breakDurationMs ranges", () => {
      _setRandom(() => 0);
      assert.equal(safety.nextBreakAfter(settings), 3);
      _setRandom(() => 0.9999);
      assert.equal(safety.nextBreakAfter(settings), 6);
      _setRandom(() => 0.5);
      assert.equal(safety.breakDurationMs(settings), 40 * MIN);
    });
    test("afterPost without a break", () => {
      _setRandom(() => 0.5);
      const ts = dhaka(12, 0);
      const p = safety.afterPost(settings, { commentsSinceBreak: 0, nextBreakAfter: null }, ts);
      assert.deepEqual(p, { lastCommentAt: ts, nextCommentAt: ts + 7.5 * MIN, commentsSinceBreak: 1, nextBreakAfter: 5 });
      assert.equal(p.breakUntil, undefined);
    });
    test("afterPost starts a break when commentsSinceBreak reaches the threshold and resets the counter", () => {
      _setRandom(() => 0.5);
      const ts = dhaka(12, 0);
      const p = safety.afterPost(settings, { commentsSinceBreak: 2, nextBreakAfter: 3 }, ts);
      assert.equal(p.breakUntil, ts + 40 * MIN);
      assert.equal(p.nextCommentAt, p.breakUntil);
      assert.equal(p.commentsSinceBreak, 0);
      assert.equal(p.nextBreakAfter, 5);
      assert.equal(p.lastCommentAt, ts);
      // one below the threshold: no break yet
      const q = safety.afterPost(settings, { commentsSinceBreak: 1, nextBreakAfter: 3 }, ts);
      assert.equal(q.breakUntil, undefined);
      assert.equal(q.commentsSinceBreak, 2);
      assert.equal(q.nextBreakAfter, 3);
    });
    test("break never shorter than the normal gap", () => {
      const s = cfg({ safety: { gapMin: { min: 100, max: 200 }, breaks: { minutesMin: 5, minutesMax: 5 } } });
      _setRandom(() => 0.5);
      const ts = dhaka(12, 0);
      const p = safety.afterPost(s, { commentsSinceBreak: 9, nextBreakAfter: 3 }, ts);
      assert.equal(p.breakUntil, ts + 150 * MIN);
    });
    test("breaks disabled: counter keeps growing, no break", () => {
      const s = cfg({ safety: { breaks: { enabled: false } } });
      _setRandom(() => 0.5);
      const p = safety.afterPost(s, { commentsSinceBreak: 10, nextBreakAfter: 3 }, dhaka(12, 0));
      assert.equal(p.breakUntil, undefined);
      assert.equal(p.commentsSinceBreak, 11);
    });
  });

  describe("postGate", () => {
    const ts = dhaka(12, 0);
    const state = (over = {}) => ({ firstStartedAt: ts - 10 * DAY, breakUntil: null, nextCommentAt: null, lastCommentAt: null, ...over }); // ramp stage 1 -> 20/day
    const counts = (over = {}) => ({ postedToday: 0, postedGroup: { A: 0, B: 0 }, target: { day: 0, week: 0 }, ...over });
    const B = { handle: "foo", group: "B" };
    const A = { handle: "bar", group: "A" };

    test("ok", () => {
      assert.deepEqual(safety.postGate(settings, state(), counts(), B, ts), { ok: true });
      assert.deepEqual(safety.postGate(settings, state(), counts(), null, ts), { ok: true });
    });
    test("outside_active_hours with opening time", () => {
      const r = safety.postGate(settings, state(), counts(), B, dhaka(0, 30));
      assert.deepEqual(r, { ok: false, reason: "outside_active_hours", until: dhaka(10, 0) });
    });
    test("break", () => {
      const r = safety.postGate(settings, state({ breakUntil: ts + 10 * MIN, nextCommentAt: ts + 10 * MIN }), counts(), B, ts);
      assert.deepEqual(r, { ok: false, reason: "break", until: ts + 10 * MIN });
      assert.equal(safety.postGate(settings, state({ breakUntil: ts - 1 }), counts(), B, ts).ok, true);
    });
    test("gap (nextCommentAt and the HARD 2-minute floor)", () => {
      assert.deepEqual(safety.postGate(settings, state({ nextCommentAt: ts + MIN }), counts(), B, ts), { ok: false, reason: "gap", until: ts + MIN });
      assert.deepEqual(safety.postGate(settings, state({ lastCommentAt: ts - MIN }), counts(), B, ts), { ok: false, reason: "gap", until: ts + MIN });
      assert.equal(safety.postGate(settings, state({ lastCommentAt: ts - 2 * MIN }), counts(), B, ts).ok, true);
    });
    test("daily_limit follows the ramp stage", () => {
      assert.deepEqual(safety.postGate(settings, state(), counts({ postedToday: 20 }), B, ts), { ok: false, reason: "daily_limit", limit: 20 });
      assert.equal(safety.postGate(settings, state(), counts({ postedToday: 19 }), B, ts).ok, true);
      assert.equal(safety.postGate(settings, state({ firstStartedAt: ts - DAY }), counts({ postedToday: 10 }), B, ts).reason, "daily_limit");
    });
    test("no per-group limit any more: the whole daily limit is available (legacy group caps are ignored)", () => {
      assert.equal(safety.postGate(settings, state(), counts({ postedToday: 19, postedGroup: { A: 0, B: 19 } }), B, ts).ok, true);
      const off = cfg({ groups: { B: { enabled: false, dailyLimit: 0 } } });
      assert.equal(safety.postGate(off, state(), counts(), B, ts).ok, true);
    });
    test("target_day / target_week", () => {
      assert.deepEqual(safety.postGate(settings, state(), counts({ target: { day: 1, week: 1 } }), B, ts), { ok: false, reason: "target_day" });
      assert.deepEqual(safety.postGate(settings, state(), counts({ target: { day: 0, week: 3 } }), B, ts), { ok: false, reason: "target_week" });
      assert.equal(safety.postGate(settings, state(), counts({ target: { day: 0, week: 2 } }), B, ts).ok, true);
      assert.equal(safety.postGate(settings, state(), counts({ target: undefined }), B, ts).ok, true);
      // HARD caps apply even when raw settings allow more
      const raw = { ...settings, safety: { ...settings.safety, perTargetDay: 5, perTargetWeek: 99 } };
      assert.equal(safety.postGate(raw, state(), counts({ target: { day: 2, week: 2 } }), B, ts).reason, "target_day");
      assert.equal(safety.postGate(raw, state(), counts({ target: { day: 0, week: 14 } }), B, ts).reason, "target_week");
    });
    test("gate order: active hours before break before gap before limits", () => {
      const all = state({ breakUntil: ts + HOUR, nextCommentAt: ts + HOUR, lastCommentAt: ts - MIN });
      const c = counts({ postedToday: 99, target: { day: 9, week: 9 } });
      assert.equal(safety.postGate(settings, all, c, B, dhaka(1, 0)).reason, "outside_active_hours");
      assert.equal(safety.postGate(settings, all, c, B, ts).reason, "break");
      assert.equal(safety.postGate(settings, { ...all, breakUntil: null }, c, B, ts).reason, "gap");
      assert.equal(safety.postGate(settings, state(), c, B, ts).reason, "daily_limit");
    });
  });

  describe("owner defaults: 200/day, 2 per account, 100 accounts, likes on, no active hours", () => {
    const d = sanitizeSettings({});
    const ts = dhaka(3, 30); // middle of the night: allowed, active hours are off
    const st = { firstStartedAt: ts - DAY };
    const counts = (over = {}) => ({ postedToday: 0, accountsToday: 0, target: { day: 0, week: 0 }, ...over });
    test("defaults", () => {
      assert.equal(safety.dailyLimit(d, st, ts), 200);
      assert.equal(d.safety.perTargetDay, 2);
      assert.equal(d.safety.accountsPerDay, 100);
      assert.equal(d.safety.activeHours.enabled, false);
      assert.equal(safety.likeLimit(d), 200);
      assert.equal(safety.activeHours(d, ts).inside, true);
    });
    test("2 per account, then the per-account cap", () => {
      assert.equal(safety.postGate(d, {}, counts({ accountsToday: 5, target: { day: 1, week: 1 } }), { group: "B" }, ts).ok, true);
      assert.equal(safety.postGate(d, {}, counts({ accountsToday: 5, target: { day: 2, week: 2 } }), { group: "B" }, ts).reason, "target_day");
    });
    test("100 different accounts per day: a new account waits, a second comment to a known one does not", () => {
      assert.equal(safety.postGate(d, {}, counts({ accountsToday: 100, target: { day: 0, week: 0 } }), { group: "B" }, ts).reason, "accounts_limit");
      assert.equal(safety.postGate(d, {}, counts({ accountsToday: 100, target: { day: 1, week: 1 } }), { group: "B" }, ts).ok, true);
      assert.equal(safety.postGate(d, {}, counts({ accountsToday: 99, target: { day: 0, week: 0 } }), { group: "B" }, ts).ok, true);
      const g = (over) => safety.generateGate(d, st, { postedToday: 0, openQueue: 0, generatedToday: 0, accountsOpen: 0, target: { day: 0, week: 0, open: 0 }, ...over }, { group: "B" }, ts);
      assert.equal(g({ accountsOpen: 100 }).reason, "accounts_limit");
      assert.equal(g({ accountsOpen: 100, target: { day: 1, week: 1, open: 0 } }).ok, true);
      assert.equal(typeof safety.GATE_LABEL.accounts_limit, "string");
    });
    test("200 per 24 hours", () => {
      assert.equal(safety.postGate(d, {}, counts({ postedToday: 200 }), { group: "B" }, ts).reason, "daily_limit");
      assert.equal(safety.postGate(d, {}, counts({ postedToday: 199 }), { group: "B" }, ts).ok, true);
    });
  });

  describe("generateGate", () => {
    const ts = dhaka(12, 0);
    const st = { firstStartedAt: ts - 10 * DAY }; // limit 20, generation limit 40
    const counts = (over = {}) => ({ postedToday: 0, openQueue: 0, generatedToday: 0, postedGroup: { A: 0, B: 0 }, openGroup: { A: 0, B: 0 }, target: { day: 0, week: 0, open: 0 }, ...over });
    const B = { handle: "foo", group: "B", coldUntil: null };

    test("ok", () => {
      assert.deepEqual(safety.generateGate(settings, st, counts(), B, ts), { ok: true });
      assert.deepEqual(safety.generateGate(settings, st, counts(), null, ts), { ok: true });
    });
    test("daily_limit counts the open queue", () => {
      assert.equal(safety.generateGate(settings, st, counts({ postedToday: 15, openQueue: 5 }), B, ts).reason, "daily_limit");
      assert.equal(safety.generateGate(settings, st, counts({ postedToday: 15, openQueue: 4 }), B, ts).ok, true);
    });
    test("generation_limit", () => {
      assert.deepEqual(safety.generateGate(settings, st, counts({ generatedToday: 40 }), B, ts), { ok: false, reason: "generation_limit" });
      assert.equal(safety.generateGate(settings, st, counts({ generatedToday: 39 }), B, ts).ok, true);
    });
    test("legacy group caps never block generation", () => {
      assert.equal(safety.generateGate(settings, st, counts({ postedGroup: { A: 0, B: 15 }, openGroup: { A: 0, B: 5 }, postedToday: 15, openQueue: 4 }), B, ts).ok, true);
    });
    test("target_has_open_item", () => {
      assert.deepEqual(safety.generateGate(settings, st, counts({ target: { day: 0, week: 0, open: 1 } }), B, ts), { ok: false, reason: "target_has_open_item" });
    });
    test("target_day / target_week", () => {
      assert.equal(safety.generateGate(settings, st, counts({ target: { day: 1, week: 1, open: 0 } }), B, ts).reason, "target_day");
      assert.equal(safety.generateGate(settings, st, counts({ target: { day: 0, week: 3, open: 0 } }), B, ts).reason, "target_week");
    });
    test("target_cold", () => {
      assert.deepEqual(safety.generateGate(settings, st, counts(), { ...B, coldUntil: ts + DAY }, ts), { ok: false, reason: "target_cold" });
      assert.equal(safety.generateGate(settings, st, counts(), { ...B, coldUntil: ts - 1 }, ts).ok, true);
    });
    test("every gate reason has a label", () => {
      for (const r of ["outside_active_hours", "break", "gap", "daily_limit", "target_day", "target_week", "target_has_open_item", "target_cold", "generation_limit"]) {
        assert.equal(typeof safety.GATE_LABEL[r], "string", r);
      }
    });
  });
});
