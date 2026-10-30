import "./_chrome.mjs";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as A from "../../extension/lib/analytics.js";
import { DAY } from "../../extension/lib/util.js";

const NOW = Date.UTC(2026, 9, 29, 12, 0);
const T = (handle, o = {}) => ({
  handle, tier: o.tier || 2,
  rel: { followsYou: o.follows === undefined ? false : o.follows, followedBackAt: o.fbAt || null },
  stats: { comments: o.comments || 0, firstCommentAt: o.first || null },
});
const R = (target, o = {}) => ({ status: o.status || "posted", target, tier: o.tier || 2, tone: o.tone || "main", preset: o.preset || "balanced", postedAt: o.at || NOW - DAY, createdAt: o.at || NOW - DAY, attempts: 1, cost: 0.01, results: o.results || {}, replyUrl: o.replyUrl || "", comment: "c" });

describe("analytics", () => {
  const targets = {
    a: T("a", { follows: true, fbAt: NOW - 2 * DAY, comments: 3, first: NOW - 6 * DAY, tier: 1 }),
    b: T("b", { follows: true, fbAt: NOW - DAY, comments: 2, first: NOW - 3 * DAY }),
    c: T("c", { comments: 4, first: NOW - 10 * DAY }),
    d: T("d", { follows: null }),
    e: T("e", { follows: true }),
    f: T("f"),
  };
  const history = [
    R("a", { tier: 1, tone: "main", results: { likes: 3, authorReplied: true, checkedAt: NOW - DAY }, replyUrl: "https://x.com/me/status/1" }),
    R("a", { tier: 1, tone: "witty" }), R("a", { tier: 1, tone: "main" }),
    R("b", { tone: "witty", results: { likes: 1 } }), R("b", { tone: "witty" }),
    R("c", { tone: "main" }), R("c", { tone: "main", status: "skipped" }),
  ];
  const blacklist = { z: { handle: "z", reason: "no_followback" }, y: { handle: "y", reason: "manual" } };

  test("funnel counts every stage and the rates", () => {
    const f = A.funnel(targets, history, blacklist);
    assert.deepEqual({ ...f, rate: Math.round(f.rate * 100), decidedRate: Math.round(f.decidedRate * 100) }, {
      added: 7, checking: 1, follows: 1, notFollowing: 2, commented: 4, followedBack: 2, gaveUp: 1, rate: 50, decidedRate: 67,
    });
    assert.equal(A.funnel({}, [], {}).rate, null);
  });

  test("days to follow-back (median and average)", () => {
    assert.deepEqual(A.daysToFollowBack(targets), { n: 2, median: 3, avg: 3 });
    assert.deepEqual(A.daysToFollowBack({}), { n: 0, median: null, avg: null });
  });

  test("conversion by tier and by tone credits the dominant key per account", () => {
    const byTier = A.conversionBy("tier", targets, history);
    assert.deepEqual(byTier.map((r) => [r.key, r.accounts, r.followBacks]), [["Tier 1", 1, 1], ["Tier 2", 2, 1]]);
    const byTone = A.conversionBy("tone", targets, history);
    assert.deepEqual(byTone.map((r) => [r.key, r.accounts, r.followBacks, r.comments]), [["witty", 1, 1, 2], ["main", 2, 1, 4]]);
  });

  test("daily series covers the window oldest-first", () => {
    const s = A.dailySeries(history, targets, { days: 7, tz: "UTC", ts: NOW });
    assert.equal(s.length, 7);
    assert.equal(s[6].d, "2026-10-29");
    assert.equal(s[5].posted, 6);
    assert.equal(s[5].followBacks, 1);
    assert.equal(s[4].followBacks, 1);
    assert.equal(s[5].generated, 7);
  });

  test("top responders and author replies", () => {
    const top = A.topResponders(targets, history);
    assert.equal(top[0].handle, "a");
    assert.equal(top[0].followedBack, true);
    assert.ok(!top.some((x) => x.handle === "c"), "no response, not listed");
    const ar = A.authorReplies(history);
    assert.equal(ar.length, 1);
    assert.equal(ar[0].target, "a");
  });
});
