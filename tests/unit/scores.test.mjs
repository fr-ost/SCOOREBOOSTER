import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as sc from "../../extension/lib/scores.js";
import { DAY, HOUR, _setClock } from "../../extension/lib/util.js";

const NOW = Date.UTC(2026, 9, 29, 8, 0);
const posts = (n, { gapH = 10, likes = 200, replies = 20, reposts = 10, text = (i) => `Distinct post number ${i} about rollup economics` } = {}) =>
  Array.from({ length: n }, (_, i) => ({ id: String(i), text: text(i), createdAt: NOW - (i + 1) * gapH * HOUR, metrics: { likes, replies, reposts } }));

describe("scores.js", () => {
  afterEach(() => _setClock(null));

  describe("botFlags / looksLikeBot", () => {
    test("spammy profile gets every flag", () => {
      _setClock(() => NOW);
      const f = sc.botFlags({ handle: "user1234567890", followers: 10, following: 3000, defaultAvatar: true, bio: "100% follow back, DM for promo", joinedAt: NOW - 10 * DAY },
        [{ text: "gm" }, { text: "GM" }, { text: "gm " }, { text: "gm frens" }]);
      for (const k of ["default_avatar", "numeric_handle", "follows_many", "tiny_audience", "spam_bio", "new_account", "repetitive_posts", "gm_spam"]) assert.ok(f.includes(k), k);
      assert.equal(sc.looksLikeBot(f), true);
    });
    test("clean profile has no flags", () => {
      _setClock(() => NOW);
      const f = sc.botFlags({ handle: "vitalik", followers: 5000000, following: 500, bio: "Ethereum", joinedAt: NOW - 3000 * DAY }, posts(5));
      assert.deepEqual(f, []);
      assert.equal(sc.looksLikeBot(f), false);
    });
    test("unknown counts do not create flags", () => {
      assert.deepEqual(sc.botFlags({ handle: "someone" }), []);
      assert.deepEqual(sc.botFlags(null), []);
      assert.deepEqual(sc.botFlags({ handle: "x", followers: 100, following: 2500 }), ["follows_many"]);
      assert.deepEqual(sc.botFlags({ handle: "x", followers: 1000, following: 2500 }), []); // not > 4x followers
      assert.deepEqual(sc.botFlags({ handle: "abc12345" }), []); // only 5 trailing digits
    });
    test("looksLikeBot weights: hard flags count double, soft flags need two", () => {
      assert.equal(sc.looksLikeBot(["spam_bio"]), true);
      assert.equal(sc.looksLikeBot(["repetitive_posts"]), true);
      assert.equal(sc.looksLikeBot(["follows_many"]), true);
      assert.equal(sc.looksLikeBot(["default_avatar"]), false);
      assert.equal(sc.looksLikeBot(["default_avatar", "default_avatar"]), false);
      assert.equal(sc.looksLikeBot(["default_avatar", "tiny_audience"]), true);
      assert.equal(sc.looksLikeBot([]), false);
      assert.equal(sc.looksLikeBot(undefined), false);
    });
  });

  describe("activity / engagement", () => {
    test("activityRate", () => {
      const a = sc.activityRate([{ createdAt: NOW - DAY }, { createdAt: NOW - 2 * DAY }, { createdAt: NOW - 3 * DAY }, { createdAt: null }], NOW);
      assert.equal(a.perDay, 1);
      assert.equal(a.lastPostAt, NOW - DAY);
      assert.equal(a.daysSinceLast, 1);
      assert.deepEqual(sc.activityRate([], NOW), { perDay: 0, lastPostAt: null, daysSinceLast: null });
      // span is at least one day
      assert.equal(sc.activityRate([{ createdAt: NOW - HOUR }, { createdAt: NOW - 2 * HOUR }], NOW).perDay, 2);
    });
    test("engagementRate", () => {
      assert.equal(sc.engagementRate({ followers: 1000 }, [{ metrics: { likes: 10, replies: 2, reposts: 2 } }]), 17 / 1000);
      assert.equal(sc.engagementRate({ followers: 0 }, [{ metrics: { likes: 10 } }]), null);
      assert.equal(sc.engagementRate({ followers: 1000 }, [{ text: "no metrics" }]), null);
      assert.equal(sc.engagementRate(null, []), null);
    });
  });

  describe("ownScore", () => {
    test("empty profile has an exact, low score", () => {
      const s = sc.ownScore({ followers: 0, following: 0 }, [], NOW);
      // reach 0, engagement 0.4 (unknown), activity 0.3, quality 0; tiny_audience -> x0.93
      assert.equal(s.score, 15);
      assert.deepEqual(s.parts, { reach: 0, engagement: 0.4, activity: 0.3, quality: 0 });
      assert.deepEqual(s.flags, ["tiny_audience"]);
      assert.equal(s.bot, false);
      assert.equal(s.engagementRate, null);
      assert.equal(s.lastPostAt, null);
    });
    test("big active influencer scores high; small inactive account scores low", () => {
      _setClock(() => NOW);
      const big = sc.ownScore({ handle: "big", followers: 2000000, following: 800, verified: true, joinedAt: NOW - 3000 * DAY }, posts(5, { gapH: 6, likes: 20000, replies: 2000, reposts: 3000 }), NOW);
      const small = sc.ownScore({ handle: "small", followers: 300, following: 900 }, posts(3, { gapH: 24 * 20, likes: 1, replies: 0, reposts: 0 }), NOW);
      assert.ok(big.score >= 80, String(big.score));
      assert.ok(small.score < 40, String(small.score));
      assert.ok(big.score <= 100 && small.score >= 0);
      assert.equal(big.parts.reach, 1);
      assert.ok(big.postsPerDay > 1);
      assert.equal(big.lastPostAt, NOW - 6 * HOUR);
    });
    test("bot penalty multiplies the score by 0.3", () => {
      _setClock(() => NOW);
      const profile = { handle: "dev", followers: 50000, following: 1000, joinedAt: NOW - 1000 * DAY };
      const clean = sc.ownScore(profile, posts(5), NOW);
      const spam = sc.ownScore({ ...profile, bio: "DM for promo, 100x gem calls" }, posts(5), NOW);
      assert.equal(spam.bot, true);
      assert.ok(spam.flags.includes("spam_bio"));
      assert.ok(Math.abs(spam.score - clean.score * 0.3) <= 1, `${spam.score} vs ${clean.score}`);
      // a single soft flag only costs 7%
      const soft = sc.ownScore({ ...profile, defaultAvatar: true }, posts(5), NOW);
      assert.equal(soft.bot, false);
      assert.ok(Math.abs(soft.score - clean.score * 0.93) <= 1);
    });
    test("score is always an integer in 0..100", () => {
      _setClock(() => NOW);
      const cases = [
        [{}, []], [null, null], [{ followers: 1e12, following: 1, verified: true }, posts(5, { likes: 1e9 })],
        [{ followers: 10, following: 1e6 }, posts(5, { text: () => "same" })], [{ followers: "12K" }, []],
      ];
      for (const [p, ps] of cases) {
        const s = sc.ownScore(p, ps || [], NOW);
        assert.ok(Number.isInteger(s.score) && s.score >= 0 && s.score <= 100, JSON.stringify(s));
      }
    });
  });

  describe("tiers and Sorsa mapping", () => {
    test("suggestTier", () => {
      assert.equal(sc.suggestTier({ followers: 60000 }, 10), 1);
      assert.equal(sc.suggestTier({ followers: 1000 }, 80), 1);
      assert.equal(sc.suggestTier({ followers: 1000 }, { score: 78 }), 1);
      assert.equal(sc.suggestTier({ followers: 1000 }, { score: 77 }), 2);
      assert.equal(sc.suggestTier(null, null), 2);
    });
    test("sorsaTo100", () => {
      assert.equal(sc.sorsaTo100(0), 0);
      assert.equal(sc.sorsaTo100(3000), 100);
      assert.equal(sc.sorsaTo100(100000), 100);
      assert.equal(sc.sorsaTo100(100), Math.round((Math.log10(101) / Math.log10(3001)) * 100));
      assert.equal(sc.sorsaTo100("1000"), Math.round((Math.log10(1001) / Math.log10(3001)) * 100));
      assert.equal(sc.sorsaTo100(-5), null);
      assert.equal(sc.sorsaTo100(undefined), null);
      assert.equal(sc.sorsaTo100("abc"), null);
      assert.equal(sc.sorsaTo100(null), null); // "no Sorsa score" must not become 0
      assert.equal(sc.sorsaTo100(""), null);
    });
    test("combinedScore", () => {
      assert.equal(sc.combinedScore(80, undefined), 80);
      assert.equal(sc.combinedScore(80, null), 80);
      assert.equal(sc.combinedScore(null, 3000), 100);
      assert.equal(sc.combinedScore(null, null), null);
      assert.equal(sc.combinedScore(undefined, undefined), null);
      assert.equal(sc.combinedScore(80, 3000, 0.5), 90);
      assert.equal(sc.combinedScore(80, 3000, 0), 80);
      assert.equal(sc.combinedScore(80, 3000, 1), 100);
      assert.equal(sc.combinedScore(80, 0, 0.5), 40); // a real score of 0 still counts
    });
  });

  describe("passesDiscoveryFilters", () => {
    const f = { minFollowers: 1000, maxFollowers: 5000000, activeWithinDays: 14, languages: ["en"], skipBots: true };
    test("pass", () => {
      assert.deepEqual(sc.passesDiscoveryFilters({ followers: 5000, lastPostAt: NOW - DAY, lang: "en", score: { bot: false } }, f, NOW), { pass: true, why: [] });
      assert.equal(sc.passesDiscoveryFilters({}, f, NOW).pass, true); // unknown data is not a reason to drop
    });
    test("each reason", () => {
      const why = (c) => sc.passesDiscoveryFilters(c, f, NOW).why;
      assert.deepEqual(why({ followers: 500 }), ["followers below range"]);
      assert.deepEqual(why({ followers: 6000000 }), ["followers above range"]);
      assert.deepEqual(why({ followers: 500, profile: { followers: 5000 } }), []); // profile wins
      assert.deepEqual(why({ lastPostAt: NOW - 20 * DAY }), ["inactive"]);
      assert.deepEqual(why({ lang: "bn" }), ["language"]);
      assert.deepEqual(why({ score: { bot: true } }), ["looks like a bot/spam"]);
      assert.deepEqual(why({ profile: { protected: true } }), ["protected account"]);
      assert.equal(why({ followers: 10, lang: "bn", score: { bot: true } }).length, 3);
      assert.deepEqual(sc.passesDiscoveryFilters({ score: { bot: true }, lang: "bn" }, { skipBots: false, languages: [] }, NOW).why, []);
    });
  });
});
