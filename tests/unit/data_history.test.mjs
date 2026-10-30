// Task D: history retention (history.maintain) and the db adapter helpers it needs; dailySeries day keys.
import "./_chrome.mjs";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as H from "../../extension/lib/history.js";
import { useMemoryDb, memoryAdapter, db, STORES } from "../../extension/lib/db.js";
import { HS } from "../../extension/lib/constants.js";
import { sanitizeSettings } from "../../extension/lib/store.js";
import { dailySeries } from "../../extension/lib/analytics.js";
import { DAY, zonedTime, _setClock } from "../../extension/lib/util.js";

const T0 = Date.UTC(2026, 9, 30, 12);
let n = 0;
async function rec(fields) {
  const r = H.newRecord({ target: "bob", postText: "a long post text", comment: "a comment", calls: [{ kind: "generate", usage: { input: 100, output: 20 }, cost: 0.001 }], modelId: "m_best", tier: 2, mode: "review", postId: String(1900000000000000000n + BigInt(++n)), ...fields });
  r.id = "h" + n;
  r.postUrl = `https://x.com/bob/status/${r.postId}`;
  await H.put(r);
  return r;
}

describe("data: history retention", () => {
  beforeEach(() => { useMemoryDb(); _setClock(() => T0); });
  afterEach(() => _setClock(null));

  test("skipped / failed records are compacted after N days and deleted after M days; posted, open and probably-posted ones stay", async () => {
    const settings = sanitizeSettings({ history: { compactAfterDays: 30, keepUnpostedDays: 90 } });
    const fresh = await rec({ status: HS.SKIPPED, reason: "Too old", createdAt: T0 - 5 * DAY });
    const midSkip = await rec({ status: HS.SKIPPED, reason: "Giveaway", createdAt: T0 - 40 * DAY });
    const midFail = await rec({ status: HS.FAILED, reason: "post failed", createdAt: T0 - 60 * DAY });
    const oldSkip = await rec({ status: HS.SKIPPED, reason: "Political", createdAt: T0 - 120 * DAY });
    const oldPosted = await rec({ status: HS.POSTED, postedAt: T0 - 200 * DAY, createdAt: T0 - 200 * DAY, results: { likes: 3, followedBack: true } });
    const maybe = await rec({ status: HS.FAILED, maybePosted: true, reason: "unclear", createdAt: T0 - 150 * DAY });
    const oldOpen = await rec({ status: HS.PENDING_REVIEW, createdAt: T0 - 100 * DAY });
    const r = await H.maintain(settings, T0);
    assert.deepEqual(r, { compacted: 2, deleted: 1 });
    assert.equal((await H.get(fresh.id)).comment, "a comment", "younger than 30 days: untouched");
    const c = await H.get(midSkip.id);
    assert.deepEqual(c, { id: midSkip.id, createdAt: midSkip.createdAt, status: HS.SKIPPED, reason: "Giveaway", target: "bob", postId: midSkip.postId, postUrl: midSkip.postUrl, tier: 2, mode: "review" });
    assert.deepEqual(Object.keys(await H.get(midFail.id)).sort(), [...H.COMPACT_FIELDS].sort());
    assert.equal(await H.get(oldSkip.id), undefined, "older than 90 days: deleted");
    const p = await H.get(oldPosted.id);
    assert.equal(p.comment, "a comment", "posted records are never shortened");
    assert.equal(p.results.followedBack, true);
    assert.equal((await H.get(maybe.id)).comment, "a comment", "probably posted: may be a live reply");
    assert.equal((await H.get(oldOpen.id)).status, HS.PENDING_REVIEW);
    assert.equal((await H.byPostId(midSkip.postId)).length, 1, "dedupe by post id still finds the compacted record");
    assert.deepEqual(await H.maintain(settings, T0), { compacted: 0, deleted: 0 }, "a second run has nothing to do");
  });

  test("the configured days are used, with safe floors for unsanitized input", async () => {
    const a = await rec({ status: HS.SKIPPED, createdAt: T0 - 10 * DAY });
    const b = await rec({ status: HS.SKIPPED, createdAt: T0 - 20 * DAY });
    assert.deepEqual(await H.maintain({ history: { compactAfterDays: 7, keepUnpostedDays: 14 } }, T0), { compacted: 1, deleted: 1 });
    assert.ok(await H.get(a.id));
    assert.equal(await H.get(b.id), undefined);
    const c = await rec({ status: HS.SKIPPED, createdAt: T0 - 3 * DAY });
    assert.deepEqual(await H.maintain({ history: { compactAfterDays: 0, keepUnpostedDays: 0 } }, T0), { compacted: 0, deleted: 0 }, "never below 7 / 14 days");
    assert.equal((await H.get(c.id)).comment, "a comment");
    assert.deepEqual(await H.maintain(undefined, T0), { compacted: 0, deleted: 0 });
  });

  test("compacted records still work in the History list and CSV", async () => {
    await rec({ status: HS.SKIPPED, createdAt: T0 - 40 * DAY });
    await H.maintain(sanitizeSettings({}), T0);
    const rows = await H.query({});
    assert.equal(rows.length, 1);
    assert.doesNotThrow(() => H.toCsvText(rows));
  });
});

describe("data: db adapter helpers", () => {
  test("rewrite: one pass below the bound, delete / replace / keep", async () => {
    const m = memoryAdapter();
    for (const [id, createdAt] of [["a", 1], ["b", 2], ["c", 3], ["d", 10]]) await m.put(STORES.history, { id, createdAt, v: id });
    const out = await m.rewrite(STORES.history, "createdAt", 5, (r) => (r.id === "a" ? "delete" : r.id === "b" ? { id: "b", createdAt: 2, v: "B" } : null));
    assert.deepEqual(out, { scanned: 3, updated: 1, deleted: 1 });
    assert.deepEqual((await m.all(STORES.history)).map((r) => r.v).sort(), ["B", "c", "d"]);
    await assert.rejects(m.rewrite(STORES.history, "createdAt", 5, (r) => { if (r.id === "c") throw new Error("boom"); return "delete"; }), /boom/);
    assert.equal((await m.all(STORES.history)).length, 3, "all or nothing, like an aborted transaction");
  });

  test("memory adapter: records without a valid index key are invisible to index queries (as in IndexedDB)", async () => {
    const m = memoryAdapter();
    await m.put(STORES.history, { id: "x", createdAt: null, status: "skipped" });
    await m.put(STORES.history, { id: "y", createdAt: 5, status: "skipped" });
    assert.deepEqual((await m.range(STORES.history, "createdAt")).map((r) => r.id), ["y"]);
    assert.deepEqual((await m.latest(STORES.history, "createdAt", 10)).map((r) => r.id), ["y"]);
    assert.equal(await m.deleteBelow(STORES.history, "createdAt", 100), 1);
    assert.deepEqual((await m.all(STORES.history)).map((r) => r.id), ["x"], "IndexedDB would not delete the null-keyed record either");
  });

  test("the default adapter in Node is the memory one and has rewrite()", () => {
    assert.equal(typeof db().rewrite, "function");
  });
});

describe("data: analytics day keys", () => {
  test("dailySeries has one row per calendar day around DST changes", () => {
    const tz = "America/New_York";
    assert.deepEqual(dailySeries([], {}, { days: 4, tz, ts: zonedTime(2026, 11, 2, 23, 30, tz) }).map((r) => r.d), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    assert.deepEqual(dailySeries([], {}, { days: 4, tz, ts: zonedTime(2026, 3, 9, 0, 30, tz) }).map((r) => r.d), ["2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09"]);
    const rows = dailySeries([{ status: "posted", createdAt: zonedTime(2026, 11, 1, 23, 0, tz), postedAt: zonedTime(2026, 11, 1, 23, 0, tz), attempts: 1, cost: 0.5 }], {}, { days: 3, tz, ts: zonedTime(2026, 11, 2, 23, 30, tz) });
    assert.deepEqual(rows.map((r) => r.posted), [0, 1, 0]);
  });
});
