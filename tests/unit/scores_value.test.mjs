// Score-aware targeting (settings.targeting.useValue): provider score mapping, follow-back propensity, learned rates,
// value + why, and the priority base in learning.updatePriorities.
import { resetStorage, rawGet } from "./_chrome.mjs";
import { test, describe, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { useMemoryDb } from "../../extension/lib/db.js";
import * as S from "../../extension/lib/scores.js";
import { newTarget, applyFollow } from "../../extension/lib/targets.js";
import { updatePriorities } from "../../extension/lib/learning.js";
import { sanitizeSettings, save } from "../../extension/lib/store.js";
import { K } from "../../extension/lib/constants.js";
import { DAY, _setClock } from "../../extension/lib/util.js";

const NOW = Date.UTC(2026, 9, 30, 8, 0);

function tg(handle, { following, followers, follows, own, providers, sorsa, tier = 2, firstDaysAgo } = {}) {
  const t = newTarget(handle, { tier });
  if (following !== undefined || followers !== undefined) t.profile = { handle, following, followers };
  if (follows === true) applyFollow(t, true, NOW - DAY);
  if (follows === false) applyFollow(t, false, NOW - 20 * DAY);
  if (own != null || providers || sorsa != null) t.score = { own: own ?? null, combined: own ?? null, providers, sorsa };
  if (firstDaysAgo != null) t.stats.firstCommentAt = NOW - firstDaysAgo * DAY;
  return t;
}

describe("providerScore100", () => {
  test("maps every provider to 0-100 and averages them", () => {
    assert.equal(S.providerScore100(tg("a", { providers: { twitterscore: { score: 420, max: 1000 } } })), 42);
    assert.equal(S.providerScore100(tg("a", { providers: { ethos: { score: 1400, max: 2800 } } })), 50);
    assert.equal(S.providerScore100(tg("a", { providers: { moni: { score: 37 } } })), 37);
    assert.equal(S.providerScore100(tg("a", { providers: { sorsa: { score: 1000 } } })), S.sorsaTo100(1000));
    const all = tg("a", { providers: { sorsa: { score: 1000 }, twitterscore: { score: 420 }, ethos: { score: 1400 }, moni: { score: 30 } } });
    assert.equal(S.providerScore100(all), Math.round((S.sorsaTo100(1000) + 42 + 50 + 30) / 4));
  });
  test("legacy score.sorsa, unknown providers with a max, junk values, none", () => {
    assert.equal(S.providerScore100(tg("a", { sorsa: 500 })), S.sorsaTo100(500));
    assert.equal(S.providerScore100(tg("a", { providers: { other: { score: 5, max: 10 } } })), 50);
    assert.equal(S.providerScore100(tg("a", { providers: { other: { score: 5 } } })), null, "unknown scale without a max is ignored");
    assert.equal(S.providerScore100(tg("a", { providers: { moni: { score: "n/a" }, ethos: { score: null } } })), null);
    assert.equal(S.providerScore100(tg("a", { providers: { moni: { score: 250 } } })), 100, "clamped to 100");
    assert.equal(S.providerScore100(tg("a")), null);
    assert.equal(S.providerScore100(null), null);
  });
});

describe("propensity / learnedRates", () => {
  test("accounts that follow you: 1; unknown following count: null", () => {
    assert.equal(S.propensity(tg("a", { follows: true, following: 10 })), 1);
    assert.equal(S.propensity(tg("a")), null);
    assert.equal(S.propensity(tg("a", { following: null, followers: 500 })), null);
    assert.equal(S.propensity(null), null);
  });
  test("following count and followers/following ratio (heuristics)", () => {
    const few = S.propensity(tg("a", { following: 30, followers: 50000 }));
    const many = S.propensity(tg("a", { following: 6000, followers: 5000 }));
    const mid = S.propensity(tg("a", { following: 1500, followers: 30000 }));
    assert.ok(few < 0.05, "following < 50: very low (" + few + ")");
    assert.equal(many, 0.72);
    assert.equal(mid, 0.24);
    assert.ok(S.propensity(tg("a", { following: 1500 })) > mid, "unknown followers: no ratio penalty");
    for (const p of [few, many, mid]) assert.ok(p > 0 && p < 1);
  });
  test("your own follow-back rate per following bucket pulls the estimate", () => {
    const learned = { buckets: { "1k-5k": { n: 20, fb: 10 } } };
    const p = S.propensity(tg("a", { following: 1500, followers: 30000 }), learned);
    assert.equal(p, Math.round(((10 + 6 * 0.24) / 26) * 100) / 100);
    assert.equal(S.propensity(tg("a", { following: 300, followers: 3000 }), learned), S.propensity(tg("a", { following: 300, followers: 3000 })), "other buckets unchanged");
  });
  test("learnedRates counts follow-backs, week-old comments without one, and given-up accounts", () => {
    const fb = tg("fb", { following: 1500, followers: 9000, follows: false, firstDaysAgo: 3 });
    applyFollow(fb, true, NOW - DAY); // followed back
    const targets = {
      fb,
      slow: tg("slow", { following: 1200, followers: 9000, follows: false, firstDaysAgo: 8 }),
      young: tg("young", { following: 1300, followers: 9000, follows: false, firstDaysAgo: 2 }),
      checking: tg("checking", { following: 1400, followers: 9000 }),
      fan: tg("fan", { following: 1400, followers: 9000, follows: true }),
      noprofile: tg("noprofile", { follows: false, firstDaysAgo: 30 }),
    };
    const blacklist = {
      gone1: { handle: "gone1", reason: "no_followback", following: 3000 },
      gone2: { handle: "gone2", reason: "no_followback", following: 40 },
      manual: { handle: "manual", reason: "manual", following: 2000 },
      old: { handle: "old", reason: "no_followback" },
    };
    const r = S.learnedRates(targets, blacklist, NOW);
    assert.deepEqual(r.buckets, { "1k-5k": { n: 3, fb: 1 }, lt50: { n: 1, fb: 0 } });
    assert.equal(S.followingBucket(49), "lt50");
    assert.equal(S.followingBucket(5000), "5k+");
    assert.equal(S.followingBucket(null), null);
  });
});

describe("value / valueDetails", () => {
  test("score x chance: a 50% chance or more counts in full; the ScoreX rank is the fallback score", () => {
    const friendly = tg("a", { following: 6000, followers: 5000, providers: { twitterscore: { score: 520 } } });
    assert.equal(S.value(friendly), 52);
    const d = S.valueDetails(tg("b", { following: 1500, followers: 30000, own: 60 }));
    assert.equal(d.value, Math.round(60 * (0.24 / 0.5)));
    assert.equal(d.propensity, 0.24);
    assert.equal(d.source, "rank");
    assert.match(d.why, /ScoreX rank 60 x follow-back chance 24% \(follows 1\.5k, 20 followers per follow\) = 29/);
    const p = S.valueDetails(tg("c", { following: 6000, followers: 5000, providers: { twitterscore: { score: 520 }, moni: { score: 40 } } }));
    assert.equal(p.source, "providers");
    assert.match(p.why, /^TwitterScore\+Moni 46 x follow-back chance 72%/);
  });
  test("followers keep their full score; unknown following uses a cautious stand-in; no score -> null", () => {
    const fan = S.valueDetails(tg("fan", { follows: true, following: 100, followers: 200, own: 64 }));
    assert.equal(fan.value, 64);
    assert.equal(fan.propensity, 1);
    assert.match(fan.why, /follows you already/);
    const unk = S.valueDetails(tg("u", { own: 50 }));
    assert.equal(unk.propensity, null);
    assert.equal(unk.value, 15);
    assert.match(unk.why, /unknown/);
    const none = S.valueDetails(tg("n", { following: 500, followers: 900 }));
    assert.equal(none.value, null);
    assert.ok(none.propensity > 0);
    assert.equal(S.value(tg("n")), null);
    assert.ok(fan.why.length <= 200 && unk.why.length <= 200);
  });
});

describe("updatePriorities with score-aware targeting", () => {
  beforeEach(() => { resetStorage(); useMemoryDb(); _setClock(() => NOW); });
  afterEach(() => _setClock(null));
  after(() => { resetStorage(); useMemoryDb(); }); // later test files start from clean storage / DB

  const seed = () => ({
    friendly: tg("friendly", { tier: 2, following: 6000, followers: 5000, own: 70, follows: false }),
    picky: tg("picky", { tier: 1, following: 30, followers: 200000, own: 80, follows: false }),
    bare: tg("bare", { tier: 2, follows: false }),
    manual: Object.assign(tg("manual", { tier: 2, following: 6000, followers: 5000, own: 90, follows: false }), { priority: 33, priorityManual: true }),
    zero: tg("zero", { tier: 2, following: 30, followers: 90000, own: 0, follows: false }),
  });

  test("on (default): value is the base, tier 1 keeps a 20-point lead; value/propensity/why are stored", async () => {
    await save({ [K.targets]: seed() });
    await updatePriorities(sanitizeSettings({}), NOW);
    const t = rawGet(K.targets);
    assert.equal(t.friendly.score.value, 70);
    assert.equal(t.friendly.score.propensity, 0.72);
    assert.match(t.friendly.score.why, /ScoreX rank 70/);
    assert.equal(t.friendly.priority, 70);
    assert.equal(t.picky.priority, t.picky.score.value + 20);
    assert.ok(t.picky.priority < t.friendly.priority, "a picky big account ranks below a likely follow-back");
    assert.equal(t.bare.score, null, "no profile, no score: nothing stored");
    assert.equal(t.bare.priority, 50, "no value: the flat tier base is used");
    assert.equal(t.manual.priority, 33, "a priority set by hand is kept");
    assert.equal(t.manual.score.value, 90);
    assert.equal(t.zero.priority, 1, "never 0 (the engine would read 0 as 50)");
  });

  test("off: the flat 70 / 50 bases as before (value is still stored for the Targets tab)", async () => {
    await save({ [K.targets]: seed() });
    await updatePriorities(sanitizeSettings({ targeting: { useValue: false } }), NOW);
    const t = rawGet(K.targets);
    assert.equal(t.friendly.priority, 50);
    assert.equal(t.picky.priority, 70);
    assert.equal(t.friendly.score.value, 70);
  });

  test("blacklisted accounts given up on lower the learned chance in their bucket", async () => {
    await save({ [K.targets]: { friendly: seed().friendly } });
    const bl = {};
    for (let i = 0; i < 12; i++) bl["g" + i] = { handle: "g" + i, reason: "no_followback", following: 7000 };
    await save({ [K.blacklist]: bl });
    await updatePriorities(sanitizeSettings({}), NOW);
    const t = rawGet(K.targets).friendly;
    assert.equal(t.score.propensity, Math.round(((0 + 6 * 0.72) / 18) * 100) / 100);
    assert.match(t.score.why, /0\/12 similar accounts followed you back/);
  });
});
