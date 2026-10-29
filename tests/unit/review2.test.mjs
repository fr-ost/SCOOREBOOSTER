// Tests for behaviour added while fixing the first review round.
import "./_chrome.mjs";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useMemoryDb } from "../../extension/lib/db.js";
import * as H from "../../extension/lib/history.js";
import { weightedLength, ruleCheck } from "../../extension/lib/quality.js";
import { typingPlan } from "../../extension/lib/poster.js";
import { computeCounts, countsAsPosted } from "../../extension/lib/engine.js";
import { sanitizeSettings } from "../../extension/lib/store.js";
import { HS } from "../../extension/lib/constants.js";
import { _setClock, DAY, HOUR } from "../../extension/lib/util.js";

const settings = sanitizeSettings({});

describe("review round 1 fixes", () => {
  beforeEach(() => useMemoryDb());
  afterEach(() => _setClock(null));

  test("weightedLength follows X's counting", () => {
    assert.equal(weightedLength("hello"), 5);
    assert.equal(weightedLength("日本語"), 6);
    assert.equal(weightedLength("ok 👨‍💻"), 5);
    assert.equal(weightedLength("see https://example.com/a/very/long/path/indeed"), 4 + 23);
    const cjk = "这".repeat(150); // 150 chars by length, 300 by weight
    assert.ok(ruleCheck(cjk, { settings: sanitizeSettings({ quality: { maxChars: 280 } }) }).reasons.some((r) => r.code === "too_long"));
  });

  test("typingPlan never emits whitespace-only chunks and reproduces the text", () => {
    const text = "Distribution compounds, but only after activation works. What did your first 100 users share?";
    for (let i = 0; i < 50; i++) {
      const plan = typingPlan(text, 170, 320);
      assert.equal(plan.map((c) => c.text).join(""), text);
      assert.ok(plan.every((c) => !/^\s+$/.test(c.text)));
      assert.ok(plan.every((c) => c.delay > 0));
    }
  });

  test("history.patch is compare-and-set: returning null aborts the write", async () => {
    const r = await H.put(H.newRecord({ status: HS.APPROVED, target: "a", comment: "x" }));
    const out = await H.patch(r.id, (cur) => (cur.status === HS.QUEUED ? { status: HS.POSTING } : null));
    assert.equal(out, null);
    assert.equal((await H.get(r.id)).status, HS.APPROVED);
    const ok = await H.patch(r.id, (cur) => (cur.status === HS.APPROVED ? { status: HS.POSTING } : null));
    assert.equal(ok.status, HS.POSTING);
    assert.equal(await H.patch("missing", { status: HS.POSTED }), null);
  });

  test("computeCounts uses rolling 24h / 7d windows and counts probably-sent replies", async () => {
    const now = 1_800_000_000_000;
    _setClock(() => now);
    const mk = (f) => H.put(H.newRecord({ createdAt: f.postedAt || f.attemptAt || now, ...f }));
    await mk({ status: HS.POSTED, target: "a", group: "A", postedAt: now - 2 * HOUR });
    await mk({ status: HS.POSTED, target: "a", group: "A", postedAt: now - 23 * HOUR }); // inside 24h even if yesterday
    await mk({ status: HS.POSTED, target: "b", group: "B", postedAt: now - 25 * HOUR }); // outside 24h, inside 7d
    await mk({ status: HS.FAILED, maybePosted: true, target: "c", group: "B", attemptAt: now - HOUR, postedAt: null });
    await mk({ status: HS.FAILED, target: "d", group: "B", attemptAt: now - HOUR, postedAt: null });
    await mk({ status: HS.PENDING_REVIEW, target: "e", group: "B", attempts: 1 });
    const c = await computeCounts(settings, now);
    assert.equal(c.postedToday, 3);
    assert.deepEqual(c.postedGroup, { A: 2, B: 1 });
    assert.equal(c.targets.a.day, 2);
    assert.equal(c.targets.b.day, 0);
    assert.equal(c.targets.b.week, 1);
    assert.equal(c.targets.c.day, 1, "probably-sent reply counts for its target");
    assert.equal(c.targets.d, undefined);
    assert.equal(c.pendingReview, 1);
    assert.equal(c.targets.e.open, 1);
    assert.equal(countsAsPosted({ status: HS.FAILED, maybePosted: true }), true);
  });
});
