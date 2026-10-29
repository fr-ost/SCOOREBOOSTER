import { resetStorage, rawGet } from "./_chrome.mjs";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as costs from "../../extension/lib/costs.js";
import { sanitizeSettings } from "../../extension/lib/store.js";
import { K, HS } from "../../extension/lib/constants.js";
import { _setClock, zonedTime, DAY } from "../../extension/lib/util.js";

const PRICES = { input: 1.0, cachedInput: 0.1, output: 5.0, cacheWrite: 1.25 };
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const DHAKA = "Asia/Dhaka";

describe("costs.js", () => {
  beforeEach(() => resetStorage());
  afterEach(() => _setClock(null));

  describe("costOf / addUsage / sumCalls", () => {
    test("plain input + output", () => {
      close(costs.costOf({ input: 1e6, output: 1e6 }, PRICES), 6);
      close(costs.costOf({ input: 1000, output: 200 }, PRICES), (1000 * 1 + 200 * 5) / 1e6);
    });
    test("cached + cacheWrite are subsets of input, reasoning is not double counted", () => {
      const usage = { input: 1000, cached: 200, cacheWrite: 100, output: 500, reasoning: 300 };
      // 700 fresh @1 + 200 cached @0.1 + 100 written @1.25 + 500 output @5 (reasoning included in output)
      close(costs.costOf(usage, PRICES), (700 + 20 + 125 + 2500) / 1e6);
      close(costs.costOf(usage, PRICES), costs.costOf({ ...usage, reasoning: 0 }, PRICES));
    });
    test("cached larger than input is capped; missing price fields default", () => {
      close(costs.costOf({ input: 100, cached: 500, output: 0 }, PRICES), (100 * 0.1) / 1e6);
      close(costs.costOf({ input: 100, cached: 50, cacheWrite: 500 }, PRICES), (50 * 0.1 + 50 * 1.25) / 1e6);
      // no cachedInput price -> cached billed at input rate; no cacheWrite price -> input * 1.25
      close(costs.costOf({ input: 1000, cached: 400, cacheWrite: 100 }, { input: 2, output: 8 }), (500 * 2 + 400 * 2 + 100 * 2.5) / 1e6);
      assert.equal(costs.costOf(null, PRICES), 0);
      assert.equal(costs.costOf({ input: 5 }, null), 0);
      assert.equal(costs.costOf({}, PRICES), 0);
    });
    test("addUsage / sumCalls", () => {
      assert.deepEqual(costs.addUsage({ input: 1, cached: 2, cacheWrite: 3, output: 4, reasoning: 5 }, { input: 10, output: 1 }), { input: 11, cached: 2, cacheWrite: 3, output: 5, reasoning: 5 });
      assert.deepEqual(costs.addUsage(null, undefined), { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 });
      const s = costs.sumCalls([{ usage: { input: 10, output: 2 }, cost: 0.1 }, { usage: { input: 5, reasoning: 1 }, cost: 0.2 }, { cost: "x" }]);
      assert.deepEqual(s.usage, { input: 15, cached: 0, cacheWrite: 0, output: 2, reasoning: 1 });
      close(s.cost, 0.3);
      assert.deepEqual(costs.sumCalls(undefined), { usage: { ...costs.EMPTY_USAGE }, cost: 0 });
    });
    test("modelById", () => {
      const s = sanitizeSettings({});
      assert.equal(costs.modelById(s, "m_cheap").name, "gpt-6-luna");
      assert.equal(costs.modelById(s, "nope"), null);
      assert.equal(costs.modelById({}, "x"), null);
    });
  });

  describe("spend ledger + budget", () => {
    test("recordSpend buckets by local day/month in the settings time zone", async () => {
      // 2026-10-31 19:00 UTC = 2026-11-01 01:00 in Dhaka
      const ts = Date.UTC(2026, 9, 31, 19, 0);
      await costs.recordSpend(0.5, "m_cheap", DHAKA, ts);
      await costs.recordSpend(0.25, "m_best", DHAKA, ts + 1000);
      await costs.recordSpend(0, "m_best", DHAKA, ts); // no-op
      const spend = rawGet(K.spend);
      assert.deepEqual(spend.days, { "2026-11-01": 0.75 });
      assert.deepEqual(spend.months, { "2026-11": 0.75 });
      assert.deepEqual(spend.byModelMonth, { "2026-11|m_cheap": 0.5, "2026-11|m_best": 0.25 });
      // same instant in UTC would be October
      await costs.recordSpend(1, null, "UTC", ts);
      const s2 = await costs.getSpend();
      assert.equal(s2.months["2026-10"], 1);
      assert.equal(s2.byModelMonth["2026-10|?"], 1);
    });

    test("concurrent recordSpend calls are not lost", async () => {
      const ts = Date.UTC(2026, 9, 29, 6, 0);
      await Promise.all(Array.from({ length: 50 }, () => costs.recordSpend(0.01, "m", DHAKA, ts)));
      close(rawGet(K.spend).days["2026-10-29"], 0.5);
    });

    test("daily buckets are pruned to ~120 days", async () => {
      const start = Date.UTC(2026, 0, 1, 6, 0);
      for (let i = 0; i < 130; i++) await costs.recordSpend(0.01, "m", "UTC", start + i * DAY);
      const spend = rawGet(K.spend);
      assert.equal(Object.keys(spend.days).length, 120);
      assert.ok(!spend.days["2026-01-01"]);
      assert.ok(spend.days["2026-05-10"]);
    });

    test("getSpend default", async () => {
      assert.deepEqual(await costs.getSpend(), { days: {}, months: {}, byModelMonth: {} });
    });

    test("budgetStatus + wouldExceed", async () => {
      const ts = zonedTime(2026, 11, 1, 1, 0, DHAKA);
      await costs.recordSpend(8.5, "m", DHAKA, ts);
      const spend = await costs.getSpend();
      const settings = { timezone: DHAKA, budget: { monthlyUsd: 10, warnAtPct: 80 } };
      const b = costs.budgetStatus(settings, spend, ts);
      assert.equal(b.limit, 10);
      close(b.spent, 8.5);
      close(b.today, 8.5);
      close(b.pct, 85);
      assert.equal(b.warn, true);
      assert.equal(b.reached, false);
      assert.equal(costs.wouldExceed(settings, spend, 1.4, ts), false);
      assert.equal(costs.wouldExceed(settings, spend, 1.6, ts), true);
      // a different month in Dhaka has no spend
      const nextMonth = zonedTime(2026, 12, 1, 1, 0, DHAKA);
      assert.equal(costs.budgetStatus(settings, spend, nextMonth).spent, 0);
      // reached
      assert.equal(costs.budgetStatus({ ...settings, budget: { monthlyUsd: 8 } }, spend, ts).reached, true);
      // no limit -> never exceeds
      const none = costs.budgetStatus({ timezone: DHAKA, budget: { monthlyUsd: 0 } }, spend, ts);
      assert.deepEqual({ ...none, spent: Math.round(none.spent * 10) / 10 }, { limit: 0, spent: 8.5, today: 8.5, pct: 0, reached: false, warn: false });
      assert.equal(costs.wouldExceed({ timezone: DHAKA, budget: { monthlyUsd: 0 } }, spend, 1e6, ts), false);
      assert.equal(costs.budgetStatus(settings, null, ts).spent, 0);
    });

    test("budget day boundary follows the local time zone", async () => {
      const lateLocal = zonedTime(2026, 10, 29, 23, 50, DHAKA);
      const nextLocal = zonedTime(2026, 10, 30, 0, 10, DHAKA);
      await costs.recordSpend(1, "m", DHAKA, lateLocal);
      await costs.recordSpend(2, "m", DHAKA, nextLocal);
      const spend = await costs.getSpend();
      const settings = { timezone: DHAKA, budget: { monthlyUsd: 100 } };
      assert.equal(costs.budgetStatus(settings, spend, lateLocal).today, 1);
      assert.equal(costs.budgetStatus(settings, spend, nextLocal).today, 2);
      assert.equal(costs.budgetStatus(settings, spend, nextLocal).spent, 3);
    });
  });

  describe("estimate", () => {
    const settings = sanitizeSettings({});

    test("without history uses token assumptions (with model check)", () => {
      const e = costs.estimate(settings, { modelId: "m_balanced", effort: "medium", perDay: 10, checkModelId: "m_cheap", checkEffort: "low" });
      const gen = (1300 * 1 + (70 + 1000) * 5) / 1e6;
      const check = (650 * 0.1 + (40 + 300) * 0.5) / 1e6;
      const per = gen * 1.15 + check * 1.15;
      close(e.perComment, per);
      close(e.perDay, per * 10);
      close(e.perMonth, per * 300);
      assert.equal(e.model, "gpt-6.1-terra");
      assert.equal(e.effort, "medium");
      assert.equal(e.tokensPerComment, 1300 + 1070 + 650 + 340);
      assert.equal(e.fromHistory, false);
    });

    test("without model check only the generation call counts", () => {
      const s = sanitizeSettings({ quality: { modelCheck: false } });
      const e = costs.estimate(s, { modelId: "m_cheap", effort: "high", perDay: 1 });
      close(e.perComment, ((1300 * 0.1 + (70 + 2800) * 0.5) / 1e6) * 1.15);
      assert.equal(e.tokensPerComment, 1300 + 2870);
    });

    test("non-reasoning model ignores effort", () => {
      const s = sanitizeSettings({ quality: { modelCheck: false }, models: [{ id: "nr", name: "gpt-4.1-mini", reasoning: false, prices: { input: 0.4, output: 1.6 } }] });
      const e = costs.estimate(s, { modelId: "nr", effort: "high", perDay: 2 });
      close(e.perComment, ((1300 * 0.4 + 70 * 1.6) / 1e6) * 1.15);
      assert.equal(e.effort, "none");
    });

    test("check model defaults to the generation model when unknown", () => {
      const e = costs.estimate(settings, { modelId: "m_cheap", effort: "low", perDay: 1, checkModelId: "ghost" });
      const gen = (1300 * 0.1 + 370 * 0.5) / 1e6;
      const check = (650 * 0.1 + 340 * 0.5) / 1e6;
      close(e.perComment, (gen + check) * 1.15);
    });

    test("with history stats (>= 3 samples) uses real averages", () => {
      const call = (kind, input, output, reasoning, modelId = "m_balanced", effort = "medium") => ({ kind, modelId, effort, ok: true, usage: { input, cached: 0, output, reasoning } });
      const records = [
        { calls: [call("generate", 1000, 300, 200), call("check", 500, 50, 10, "m_cheap", "low")] },
        { calls: [call("generate", 2000, 500, 400), call("check", 700, 70, 30, "m_cheap", "low")] },
        { calls: [call("regenerate", 3000, 700, 600), call("check", 600, 60, 20, "m_cheap", "low"), { kind: "generate", modelId: "m_balanced", effort: "medium", ok: false, usage: { input: 99999 } }] },
      ];
      const stats = costs.usageStats(records);
      assert.equal(stats["m_balanced|medium|gen"].n, 3);
      assert.equal(stats["m_balanced|medium|gen"].input, 2000);
      assert.equal(stats["m_balanced|medium|gen"].output, 500);
      assert.equal(stats["m_cheap|low|check"].input, 600);
      const e = costs.estimate(settings, { modelId: "m_balanced", effort: "medium", perDay: 1, checkModelId: "m_cheap", checkEffort: "low", stats });
      const gen = (2000 * 1 + 500 * 5) / 1e6;
      const check = (600 * 0.1 + 60 * 0.5) / 1e6;
      close(e.perComment, (gen + check) * 1.15);
      assert.equal(e.fromHistory, true);
      assert.equal(e.tokensPerComment, 2000 + 500 + 600 + 60);
      // fewer than 3 samples for another effort -> assumptions
      const e2 = costs.estimate(settings, { modelId: "m_balanced", effort: "high", perDay: 1, stats });
      assert.equal(e2.fromHistory, false);
    });

    test("unknown model -> null", () => {
      assert.equal(costs.estimate(settings, { modelId: "ghost", perDay: 5 }), null);
      assert.equal(costs.estimate(settings), null);
    });
  });

  describe("aggregate / performance", () => {
    const tz = DHAKA;
    const at = (d, h) => zonedTime(2026, 10, d, h, 0, tz);
    const rec = (over) => ({ status: HS.POSTED, cost: 0, tokens: { input: 0, output: 0 }, calls: [], ...over });
    const records = [
      rec({ createdAt: at(26, 12), cost: 0.03, tokens: { input: 1000, output: 100 }, calls: [
        { modelId: "m_best", modelName: "gpt-6.1-sol", cost: 0.02, usage: { input: 600, output: 60, reasoning: 30 } },
        { modelId: "m_cheap", modelName: "gpt-6-luna", cost: 0.01, usage: { input: 400, output: 40, reasoning: 0 } },
      ], modelName: "gpt-6.1-sol", tone: "witty", preset: "high", results: { checkedAt: 1, likes: 4, replies: 1, authorReplied: true, followedBack: true } }),
      rec({ createdAt: at(26, 23), status: HS.SKIPPED, cost: 0.01, tokens: { input: 500, output: 50 }, calls: [
        { modelId: "m_cheap", modelName: "gpt-6-luna", cost: 0.01, usage: { input: 500, output: 50 } },
      ] }),
      rec({ createdAt: at(27, 0) + 30 * 60 * 1000, status: HS.FAILED, cost: 0.02, tokens: { input: 10, output: 5 }, calls: [
        { modelId: "m_best", cost: 0.02, usage: { input: 10, output: 5 } },
      ] }),
      rec({ createdAt: at(28, 9), status: HS.SKIPPED, cost: 0 }), // free skip -> not counted
      rec({ createdAt: at(29, 9), cost: 0.04, calls: [{ modelId: "m_best", modelName: "gpt-6.1-sol", cost: 0.04, usage: { input: 100, output: 10 } }], modelName: "gpt-6.1-sol", tone: "bold", preset: "high", results: {} }),
    ];

    test("aggregate totals and per-model by call", () => {
      const a = costs.aggregate(records, tz);
      close(a.total.cost, 0.1);
      assert.equal(a.total.comments, 4);
      assert.equal(a.total.posted, 2);
      assert.equal(a.total.tokens, 1100 + 550 + 15);
      const byKey = Object.fromEntries(a.byModel.map((m) => [m.key, m]));
      close(byKey["gpt-6.1-sol"].cost, 0.06);
      assert.equal(byKey["gpt-6.1-sol"].calls, 2);
      close(byKey["gpt-6-luna"].cost, 0.02);
      assert.equal(byKey["gpt-6-luna"].calls, 2);
      assert.equal(byKey["gpt-6-luna"].tokens, 440 + 550);
      close(byKey.m_best.cost, 0.02); // falls back to modelId when the call has no name
      assert.equal(byKey["gpt-6.1-sol"].reasoning, 30);
      assert.equal(a.byModel[0].key, "gpt-6.1-sol"); // sorted by cost desc
    });

    test("aggregate byDay/byWeek/byMonth use the local time zone and sort newest first", () => {
      const a = costs.aggregate(records, tz);
      assert.deepEqual(a.byDay.map((d) => d.key), ["2026-10-29", "2026-10-27", "2026-10-26"]);
      const d26 = a.byDay.find((d) => d.key === "2026-10-26");
      assert.equal(d26.comments, 2);
      assert.equal(d26.posted, 1);
      assert.equal(d26.skipped, 1);
      close(d26.cost, 0.04);
      const d27 = a.byDay.find((d) => d.key === "2026-10-27");
      assert.equal(d27.failed, 1);
      assert.deepEqual(a.byWeek.map((w) => w.key), ["2026-W44"]);
      assert.equal(a.byWeek[0].comments, 4);
      assert.deepEqual(a.byMonth.map((m) => m.key), ["2026-10"]);
      // in UTC the 00:30 Dhaka record falls on the 26th
      const utc = costs.aggregate(records, "UTC");
      assert.equal(utc.byDay.find((d) => d.key === "2026-10-26").comments, 3);
      assert.deepEqual(costs.aggregate([], tz).total, { cost: 0, comments: 0, posted: 0, tokens: 0 });
    });

    test("performance per model / tone / arm", () => {
      const p = costs.performance(records);
      const sol = p.byModel.find((m) => m.key === "gpt-6.1-sol");
      assert.equal(sol.posted, 2);
      close(sol.cost, 0.07);
      close(sol.costPerComment, 0.035);
      assert.equal(sol.checked, 1);
      assert.equal(sol.avgLikes, 4);
      assert.equal(sol.avgReplies, 1);
      assert.equal(sol.authorReplies, 1);
      assert.equal(sol.followBacks, 1);
      assert.equal(sol.followBackRate, 0.5);
      close(sol.costPerFollowBack, 0.07);
      const bold = p.byTone.find((t) => t.key === "bold");
      assert.equal(bold.avgLikes, 0);
      assert.equal(bold.costPerFollowBack, null);
      assert.deepEqual(p.byArm.map((a) => a.key).sort(), ["bold · high", "witty · high"]);
      assert.equal(p.byTone.length, 2); // skipped/failed are excluded
    });
  });
});
