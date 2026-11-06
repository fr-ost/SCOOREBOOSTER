// Accounts that follow very few people for their size (following below settings.targeting.minFollowingPct % of their
// followers, default 5%) rarely follow back: they are not watched, commented on or followed first. Accounts that follow
// many people for their size get their posts answered first.
import { resetStorage } from "./_chrome.mjs";
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { newTarget, applyFollow, isActive, tooSelective, followingPct, selectiveReason, SELECTIVE_MIN_FOLLOWERS } from "../../extension/lib/targets.js";
import { wantsFollow } from "../../extension/lib/follow.js";
import { followBackBoost } from "../../extension/lib/engine.js";
import { sanitizeSettings } from "../../extension/lib/store.js";
import { DAY } from "../../extension/lib/util.js";

const acct = (followers, following, extra = {}) => {
  const t = applyFollow(newTarget("acct"), false, Date.now() - DAY);
  t.profile = { followers, following };
  return Object.assign(t, extra);
};

describe("follower / following ratio", () => {
  beforeEach(() => resetStorage());

  test("100k followers following 2.5k (2.5%) is left out; 100k following 20k (20%) is not; the setting changes the line", () => {
    const s = sanitizeSettings({});
    assert.deepEqual([s.targeting.skipSelective, s.targeting.minFollowingPct], [true, 5], "on by default, 5%");
    const selective = acct(100000, 2500), open = acct(100000, 20000);
    assert.equal(followingPct(selective), 2.5);
    assert.equal(tooSelective(selective, s), true);
    assert.equal(isActive(selective, s), false, "not watched or commented on");
    assert.equal(tooSelective(open, s), false);
    assert.equal(isActive(open, s), true);
    assert.equal(selectiveReason(selective), "Follows only 2.5% of its followers (2,500 of 100,000) - rarely follows back");
    assert.equal(tooSelective(open, sanitizeSettings({ targeting: { minFollowingPct: 25 } })), true, "a higher line skips more");
    assert.equal(tooSelective(selective, sanitizeSettings({ targeting: { skipSelective: false } })), false, "switched off");
  });

  test("small accounts and unknown counts are never left out", () => {
    const s = sanitizeSettings({});
    assert.equal(tooSelective(acct(SELECTIVE_MIN_FOLLOWERS - 1, 10), s), false, "under 1,000 followers");
    assert.equal(tooSelective(acct(50000, null), s), false, "following not read yet");
    assert.equal(tooSelective(acct(undefined, undefined), s), false);
    assert.equal(followingPct(acct(0, 50)), null);
  });

  test("not followed first either; accounts that follow many people go first", () => {
    const s = sanitizeSettings({});
    assert.equal(wantsFollow(acct(100000, 2500), s), false);
    assert.equal(wantsFollow(acct(100000, 30000), s), true);
    assert.deepEqual([followBackBoost(acct(10000, 6000)), followBackBoost(acct(10000, 2500)), followBackBoost(acct(10000, 1200)), followBackBoost(acct(10000, 600)), followBackBoost(acct(10000, null))], [20, 12, 6, 0, 0]);
  });
});
