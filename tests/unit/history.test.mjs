import "./_chrome.mjs";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as h from "../../extension/lib/history.js";
import { useMemoryDb, db, memoryAdapter, STORES } from "../../extension/lib/db.js";
import { HS } from "../../extension/lib/constants.js";
import { DAY, HOUR, MIN, zonedTime, _setClock, _setRandom } from "../../extension/lib/util.js";

const TZ = "Asia/Dhaka";
const at = (d, hh, mm = 0, mo = 10) => zonedTime(2026, mo, d, hh, mm, TZ);
let clock = at(29, 12);
let seq = 0;

async function add(fields) {
  _setClock(() => fields.createdAt ?? clock);
  _setRandom(() => ((seq++ % 1000) + 1) / 1001);
  const r = h.newRecord(fields);
  await h.put(r);
  _setClock(() => clock);
  return r;
}

describe("history.js", () => {
  beforeEach(() => { useMemoryDb(); clock = at(29, 12); seq = 0; _setClock(() => clock); });
  afterEach(() => { _setClock(null); _setRandom(null); });

  test("db() falls back to the in-memory adapter in Node", () => {
    assert.equal(db().kind, "memory");
    assert.equal(useMemoryDb().kind, "memory");
  });

  test("newRecord defaults and overrides", () => {
    const r = h.newRecord({ target: "foo", status: HS.QUEUED, group: "B" });
    assert.ok(r.id.startsWith("h"));
    assert.equal(r.createdAt, clock);
    assert.equal(r.updatedAt, clock);
    assert.equal(r.status, HS.QUEUED);
    assert.equal(r.target, "foo");
    assert.deepEqual(r.calls, []);
    assert.equal(r.cost, 0);
    assert.equal(r.attempts, 0);
    assert.deepEqual(r.results, {});
    assert.equal(h.newRecord({}).status, HS.PENDING_REVIEW);
  });

  test("put sums calls into tokens and cost, stamps updatedAt", async () => {
    const r = h.newRecord({ target: "foo", calls: [
      { kind: "generate", usage: { input: 1000, cached: 100, cacheWrite: 10, output: 200, reasoning: 50 }, cost: 0.001 },
      { kind: "check", usage: { input: 500, output: 50 }, cost: 0.0002 },
      { kind: "generate", ok: false, usage: { input: 0, output: 0 }, cost: 0 },
    ], cost: 999, tokens: { input: 1 } });
    clock += MIN;
    const saved = await h.put(r);
    assert.deepEqual(saved.tokens, { input: 1500, cached: 100, cacheWrite: 10, output: 250, reasoning: 50 });
    assert.equal(saved.cost, 0.0012);
    assert.equal(saved.updatedAt, clock);
    const got = await h.get(r.id);
    assert.deepEqual(got, saved);
    got.comment = "mutated";
    assert.equal((await h.get(r.id)).comment, undefined); // stored copy is isolated
  });

  test("patch with object or function, missing id -> null", async () => {
    const r = await add({ target: "foo", comment: "a" });
    const p1 = await h.patch(r.id, { comment: "b", calls: [{ usage: { input: 10, output: 1 }, cost: 0.5 }] });
    assert.equal(p1.comment, "b");
    assert.equal(p1.cost, 0.5);
    const p2 = await h.patch(r.id, (cur) => ({ comment: cur.comment + "c", edited: true }));
    assert.equal(p2.comment, "bc");
    assert.equal(p2.edited, true);
    assert.equal(await h.patch("nope", { a: 1 }), null);
    await h.remove(r.id);
    assert.equal(await h.get(r.id), undefined);
  });

  test("openQueue returns open statuses oldest first", async () => {
    await add({ target: "a", status: HS.POSTED, createdAt: at(29, 8) });
    const q2 = await add({ target: "b", status: HS.QUEUED, createdAt: at(29, 10) });
    const q1 = await add({ target: "c", status: HS.PENDING_REVIEW, createdAt: at(29, 9) });
    const q3 = await add({ target: "d", status: HS.APPROVED, createdAt: at(29, 11) });
    const q4 = await add({ target: "e", status: HS.POSTING, createdAt: at(29, 11, 30) });
    await add({ target: "f", status: HS.SKIPPED, createdAt: at(29, 7) });
    await add({ target: "g", status: HS.FAILED, createdAt: at(29, 7) });
    assert.deepEqual((await h.openQueue()).map((r) => r.id), [q1.id, q2.id, q3.id, q4.id]);
    assert.equal((await h.byStatus(HS.POSTED)).length, 1);
    assert.equal(await h.count(), 7);
  });

  test("postedToday uses the local day in Asia/Dhaka", async () => {
    await add({ target: "foo", status: HS.POSTED, createdAt: at(29, 23, 40), postedAt: at(29, 23, 50) });
    await add({ target: "bar", status: HS.POSTED, createdAt: at(29, 23, 55), postedAt: at(30, 0, 10) });
    await add({ target: "baz", status: HS.QUEUED, createdAt: at(29, 20) });
    await add({ target: "old", status: HS.POSTED, createdAt: at(28, 12), postedAt: at(28, 12, 5) });
    assert.equal(await h.postedToday(TZ, at(29, 23, 59)), 1);
    assert.equal(await h.postedToday(TZ, at(30, 0, 30)), 1);
    assert.equal(await h.postedToday(TZ, at(30, 9)), 1);
    assert.equal(await h.postedToday(TZ, at(30, 9), "foo"), 0);
    assert.equal(await h.postedToday(TZ, at(30, 9), "bar"), 1);
    assert.equal(await h.postedToday(TZ, at(28, 20)), 1);
    // in UTC both late posts fall on the 29th (17:50Z and 18:10Z)
    assert.equal(await h.postedToday("UTC", Date.UTC(2026, 9, 29, 20, 0)), 2);
    // default ts = injected clock
    clock = at(30, 1);
    assert.equal(await h.postedToday(TZ), 1);
  });

  test("generatedToday counts records with attempts on the local day", async () => {
    await add({ target: "a", attempts: 1, status: HS.SKIPPED, createdAt: at(29, 0, 5) });
    await add({ target: "b", attempts: 2, status: HS.PENDING_REVIEW, createdAt: at(29, 23, 50) });
    await add({ target: "c", attempts: 0, status: HS.SKIPPED, createdAt: at(29, 10) }); // filtered before generation
    await add({ target: "d", attempts: 1, status: HS.POSTED, createdAt: at(28, 23, 59) });
    assert.equal(await h.generatedToday(TZ, at(29, 23, 59)), 2);
    assert.equal(await h.generatedToday(TZ, at(28, 23, 59)), 1);
  });

  test("likedToday", async () => {
    await add({ target: "a", liked: true, likedAt: at(29, 11), createdAt: at(29, 10) });
    await add({ target: "b", liked: true, likedAt: at(28, 11), createdAt: at(28, 10) });
    await add({ target: "c", liked: false, createdAt: at(29, 10) });
    assert.equal(await h.likedToday(TZ, at(29, 20)), 1);
  });

  test("targetCounts: local day, rolling 7 days, open items", async () => {
    const now = at(29, 12);
    await add({ target: "foo", status: HS.POSTED, createdAt: at(29, 9), postedAt: at(29, 9, 30) });
    await add({ target: "foo", status: HS.POSTED, createdAt: at(26, 9), postedAt: at(26, 9, 30) });
    await add({ target: "foo", status: HS.POSTED, createdAt: now - 7 * DAY - HOUR, postedAt: now - 7 * DAY - MIN }); // just outside 7 days
    await add({ target: "foo", status: HS.PENDING_REVIEW, createdAt: at(29, 11) });
    await add({ target: "foo", status: HS.SKIPPED, createdAt: at(29, 10) });
    await add({ target: "bar", status: HS.POSTED, createdAt: at(29, 9), postedAt: at(29, 10) });
    assert.deepEqual(await h.targetCounts("foo", TZ, now), { day: 1, week: 2, open: 1, total: 3 });
    assert.deepEqual(await h.targetCounts("bar", TZ, now), { day: 1, week: 1, open: 0, total: 1 });
    assert.deepEqual(await h.targetCounts("ghost", TZ, now), { day: 0, week: 0, open: 0, total: 0 });
    // a post at 23:50 yesterday is not "today" at 00:10
    await add({ target: "late", status: HS.POSTED, createdAt: at(29, 23, 40), postedAt: at(29, 23, 50) });
    assert.equal((await h.targetCounts("late", TZ, at(30, 0, 10))).day, 0);
    assert.equal((await h.targetCounts("late", TZ, at(30, 0, 10))).week, 1);
  });

  test("targetCountsAll matches targetCounts", async () => {
    const now = at(29, 12);
    await add({ target: "foo", status: HS.POSTED, createdAt: at(29, 9), postedAt: at(29, 9, 30) });
    await add({ target: "foo", status: HS.POSTED, createdAt: at(26, 9), postedAt: at(26, 9, 30) });
    await add({ target: "foo", status: HS.QUEUED, createdAt: at(29, 11) });
    await add({ target: "bar", status: HS.APPROVED, createdAt: at(20, 11) });
    const all = await h.targetCountsAll(TZ, now);
    assert.deepEqual(all.foo, { day: 1, week: 2, open: 1 });
    assert.deepEqual(all.bar, { day: 0, week: 0, open: 1 });
  });

  test("recentPosted newest first, limited", async () => {
    for (let i = 0; i < 5; i++) await add({ target: "t" + i, status: HS.POSTED, comment: "c" + i, createdAt: at(29, 8 + i), postedAt: at(29, 8 + i, 1) });
    await add({ target: "x", status: HS.SKIPPED, comment: "skipped" });
    assert.deepEqual((await h.recentPosted(3)).map((r) => r.comment), ["c4", "c3", "c2"]);
  });

  test("query filters, ordering and limit", async () => {
    await add({ target: "foo", group: "A", status: HS.POSTED, modelId: "m_best", modelName: "gpt-6.1-sol", comment: "Fees matter less than UX", postText: "L2 fees dropped", createdAt: at(27, 10) });
    await add({ target: "bar", group: "B", status: HS.SKIPPED, modelId: "m_cheap", modelName: "gpt-6-luna", comment: "Restaking risk is underpriced", postText: "EigenLayer TVL", createdAt: at(28, 10) });
    await add({ target: "foo", group: "A", status: HS.PENDING_REVIEW, modelId: "m_cheap", modelName: "gpt-6-luna", comment: "Blob space will get expensive", postText: "Blobs are cheap now", createdAt: at(29, 10) });
    const ids = async (q) => (await h.query(q)).map((r) => r.comment.split(" ")[0]);
    assert.deepEqual(await ids({}), ["Blob", "Restaking", "Fees"]);
    assert.deepEqual(await ids({ status: HS.POSTED }), ["Fees"]);
    assert.deepEqual(await ids({ target: "@FOO" }), ["Blob", "Fees"]);
    assert.deepEqual(await ids({ group: "B" }), ["Restaking"]);
    assert.deepEqual(await ids({ model: "m_cheap" }), ["Blob", "Restaking"]);
    assert.deepEqual(await ids({ model: "gpt-6.1-sol" }), ["Fees"]);
    assert.deepEqual(await ids({ text: "BLOB" }), ["Blob"]);
    assert.deepEqual(await ids({ text: "eigenlayer" }), ["Restaking"]); // matches post text too
    assert.deepEqual(await ids({ from: at(28, 0) }), ["Blob", "Restaking"]);
    assert.deepEqual(await ids({ from: at(27, 0), to: at(28, 23) }), ["Restaking", "Fees"]);
    assert.deepEqual(await ids({ limit: 1 }), ["Blob"]);
    assert.deepEqual(await ids({ target: "foo", status: HS.SKIPPED }), []);
  });

  test("byPostId / byTarget / latest / between / since / clearAll", async () => {
    await add({ target: "foo", postId: "111", createdAt: at(27, 10) });
    await add({ target: "bar", postId: "222", createdAt: at(28, 10) });
    await add({ target: "foo", postId: "333", createdAt: at(29, 10) });
    assert.equal((await h.byPostId("222"))[0].target, "bar");
    assert.equal((await h.byTarget("foo")).length, 2);
    assert.deepEqual((await h.latest(2)).map((r) => r.postId), ["333", "222"]);
    assert.deepEqual((await h.between(at(27, 0), at(28, 23))).map((r) => r.postId), ["111", "222"]);
    assert.deepEqual((await h.since(at(28, 0))).map((r) => r.postId), ["222", "333"]);
    assert.equal((await h.all()).length, 3);
    await h.clearAll();
    assert.equal(await h.count(), 0);
  });

  test("toCsvText columns and escaping", async () => {
    const r = await add({
      target: "foo", group: "B", tier: 1, postUrl: "https://x.com/foo/status/1", modelName: "gpt-6.1-sol", effort: "high", preset: "high", tone: "witty",
      status: HS.POSTED, postedAt: Date.UTC(2026, 9, 29, 7, 0), createdAt: Date.UTC(2026, 9, 29, 6, 0),
      comment: '=HYPERLINK("evil") says "hi", then\nnew line', reason: "-bad", replyUrl: "", liked: true,
      results: { likes: 3, replies: 0, authorReplied: true, followedBack: false },
      calls: [{ usage: { input: 1000, cached: 200, output: 100, reasoning: 40 }, cost: 0.0123456789 }],
    });
    const csv = h.toCsvText([r, { createdAt: Date.UTC(2026, 9, 28), status: HS.SKIPPED, target: "@bar", results: {} }]);
    const lines = csv.split("\r\n");
    assert.equal(lines[0], "created,posted,target,group,tier,post_link,model,reasoning,preset,tone,input_tokens,cached_tokens,output_tokens,reasoning_tokens,cost_usd,comment,status,reason,reply_link,liked_post,reply_likes,reply_replies,author_replied,followed_back");
    assert.equal(h.CSV_COLUMNS.length, 24);
    assert.ok(lines[1].startsWith("2026-10-29T06:00:00.000Z,2026-10-29T07:00:00.000Z,foo,B,1,https://x.com/foo/status/1,gpt-6.1-sol,high,high,witty,1000,200,100,40,0.012346,"), lines[1]);
    assert.ok(csv.includes('"\'=HYPERLINK(""evil"") says ""hi"", then\nnew line"'), csv);
    assert.equal(lines.length, 3); // the comment's \n stays inside its quoted cell
    assert.ok(lines[1].endsWith(",posted,'-bad,,yes,3,0,yes,"), lines[1]);
    const last = lines[lines.length - 1];
    assert.equal(last, "2026-10-28T00:00:00.000Z,,'@bar,,,,,,,,0,0,0,0,0.000000,,skipped,,,,,,,");
  });
});

describe("db.js memory adapter", () => {
  test("events store gets auto ids; range / latest / deleteBelow", async () => {
    const m = memoryAdapter();
    const k1 = await m.put(STORES.events, { ts: 5, msg: "a" });
    const k2 = await m.put(STORES.events, { ts: 1, msg: "b" });
    await m.putMany(STORES.events, [{ ts: 9, msg: "c" }]);
    assert.equal(k1, 1);
    assert.equal(k2, 2);
    assert.equal(await m.count(STORES.events), 3);
    assert.deepEqual((await m.range(STORES.events, "ts", 2, null)).map((e) => e.msg), ["a", "c"]);
    assert.deepEqual((await m.range(STORES.events, "ts", null, 5)).map((e) => e.msg), ["b", "a"]);
    assert.deepEqual((await m.latest(STORES.events, "ts", 2)).map((e) => e.msg), ["c", "a"]);
    assert.equal(await m.deleteBelow(STORES.events, "ts", 6), 2);
    assert.deepEqual((await m.all(STORES.events)).map((e) => e.msg), ["c"]);
    await m.del(STORES.events, 3);
    assert.equal(await m.count(STORES.events), 0);
    await m.put(STORES.history, { id: "x", status: "posted" });
    await m.clear(STORES.history);
    assert.equal(await m.get(STORES.history, "x"), undefined);
  });
});
