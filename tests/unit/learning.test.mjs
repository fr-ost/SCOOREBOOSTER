import "./_chrome.mjs";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as L from "../../extension/lib/learning.js";
import { eligible } from "../../extension/lib/cleanup.js";
import { sanitizeSettings } from "../../extension/lib/store.js";
import { newTarget } from "../../extension/lib/targets.js";
import { DAY, _setRandom } from "../../extension/lib/util.js";

// The tier presets these tests were written for (tier 1 High quality, tier 2 Balanced; the default is now Human).
const base = (over = {}) => sanitizeSettings({ presetMatrix: { A1: "balanced", A2: "cheap", B1: "high", B2: "balanced" }, genRev: 1, learning: { enabled: true, abTesting: true, explore: 0, abTones: ["insightful", "witty"], abPresets: [] }, ...over });
const posted = (arm, group, results, extra = {}) => ({ status: "posted", postedAt: 1000, group, abArm: arm, tone: arm.split("|")[0], preset: arm.split("|")[1], cost: 0.01, results, ...extra });

describe("learning.js", () => {
  afterEach(() => _setRandom(null));

  test("engaged / rewardScore", () => {
    assert.equal(L.engaged(null), false);
    assert.equal(L.engaged({ likes: 0, replies: 0 }), false);
    assert.equal(L.engaged({ likes: 1 }), true);
    assert.equal(L.engaged({ authorReplied: true }), true);
    assert.equal(L.engaged({ followedBack: true }), true);
    assert.equal(L.rewardScore({ likes: 2, replies: 1, authorReplied: true, followedBack: true }), 2 + 2 + 5 + 10);
  });

  test("betaSample stays in (0,1) and tracks the mean", () => {
    let sum = 0;
    for (let i = 0; i < 2000; i++) { const v = L.betaSample(9, 1); assert.ok(v > 0 && v < 1); sum += v; }
    assert.ok(Math.abs(sum / 2000 - 0.9) < 0.03);
    let low = 0;
    for (let i = 0; i < 500; i++) low += L.betaSample(0.5, 0.5);
    assert.ok(low / 500 > 0.35 && low / 500 < 0.65);
  });

  test("armsFor: tones x presets, overrides respected, invalid tones dropped", () => {
    const s = base({ learning: { enabled: true, abTesting: true, abTones: ["insightful", "witty", "nope"], abPresets: ["cheap"] } });
    const t = newTarget("bob", { group: "B", tier: 1 });
    const arms = L.armsFor(t, s);
    const keys = arms.map((a) => a.key).sort();
    // The Tone prompt ("main") is always the default arm; the tested tones are added to it.
    assert.deepEqual(keys, ["insightful|cheap", "insightful|high", "main|cheap", "main|high", "witty|cheap", "witty|high"]);
    assert.ok(arms.find((a) => a.key === "main|high").isDefault);
    // No tested tones or presets: a single arm, so A/B testing changes nothing.
    assert.equal(L.armsFor(t, sanitizeSettings({})).length, 1);
    const t2 = { ...t, tone: "bold", preset: "balanced" };
    assert.deepEqual(L.armsFor(t2, s).map((a) => a.key), ["bold|balanced"]);
  });

  test("armStats counts only checked results after the reset time", () => {
    const h = [
      posted("witty|balanced", "B", { likes: 2, checkedAt: 5 }),
      posted("witty|balanced", "B", { likes: 0, checkedAt: 5 }),
      posted("witty|balanced", "B", {}), // not checked yet
      posted("insightful|balanced", "B", { followedBack: true }),
      posted("insightful|balanced", "B", { likes: 3, checkedAt: 5 }, { postedAt: 1 }), // before reset
      { status: "skipped", group: "B", abArm: "witty|balanced" },
    ];
    const st = L.armStats(h, 10 > 1 ? 2 : 0);
    const w = st["B::witty|balanced"];
    assert.equal(w.n, 3); assert.equal(w.checked, 2); assert.equal(w.successes, 1);
    const i = st["B::insightful|balanced"];
    assert.equal(i.n, 1); assert.equal(i.followBacks, 1); assert.equal(i.successes, 1);
  });

  test("chooseArm: off -> {}, explore -> random arm, otherwise Thompson favours the winner", () => {
    const t = newTarget("bob", { group: "B", tier: 2 });
    assert.deepEqual(L.chooseArm(t, sanitizeSettings({ learning: { abTesting: false } }), []), {});
    const s1 = base({ learning: { enabled: true, abTesting: true, explore: 0.6, abTones: ["insightful", "witty"] } });
    _setRandom(() => 0.01); // < explore
    const e = L.chooseArm(t, s1, []);
    assert.equal(e.explore, true);
    _setRandom(null);
    const s = base();
    const hist = [
      ...Array.from({ length: 20 }, () => posted("witty|balanced", "B", { likes: 3, checkedAt: 5 })),
      ...Array.from({ length: 20 }, () => posted("insightful|balanced", "B", { likes: 0, checkedAt: 5 })),
      ...Array.from({ length: 20 }, () => posted("main|balanced", "B", { likes: 0, checkedAt: 5 })), // the Tone prompt arm
    ];
    let witty = 0;
    for (let i = 0; i < 200; i++) if (L.chooseArm(t, s, hist).tone === "witty") witty++;
    assert.ok(witty > 180, "winner chosen most of the time: " + witty);
  });
});

describe("cleanup.eligible", () => {
  const s = sanitizeSettings({ cleanup: { enabled: true, afterDays: 7, whitelist: ["keep"], protectTier1: true } });
  const now = 100 * DAY;
  const mk = (h, tier, rel) => ({ ...newTarget(h, { group: "B", tier }), rel });
  test("eligible only after N days without a follow-back", () => {
    assert.equal(eligible(mk("a", 2, { youFollow: true, followsYou: false, youFollowSince: now - 8 * DAY }), s, now).ok, true);
    assert.equal(eligible(mk("a", 2, { youFollow: true, followsYou: false, youFollowSince: now - 6 * DAY }), s, now).ok, false);
    assert.equal(eligible(mk("a", 2, { youFollow: true, followsYou: true, youFollowSince: now - 30 * DAY }), s, now).ok, false);
    assert.equal(eligible(mk("a", 2, { youFollow: true, followsYou: null, youFollowSince: now - 30 * DAY }), s, now).ok, false, "unknown follow-back is never acted on");
    assert.equal(eligible(mk("a", 2, { youFollow: false, followsYou: false, youFollowSince: now - 30 * DAY }), s, now).ok, false);
  });
  test("whitelist and tier 1 protection", () => {
    assert.equal(eligible(mk("keep", 2, { youFollow: true, followsYou: false, youFollowSince: now - 30 * DAY }), s, now).ok, false);
    assert.equal(eligible(mk("big", 1, { youFollow: true, followsYou: false, youFollowSince: now - 30 * DAY }), s, now).ok, false);
  });
});
