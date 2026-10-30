import { resetStorage, rawGet } from "./_chrome.mjs";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as F from "../../extension/lib/follow.js";
import { newTarget, applyFollow, followStatus, FS } from "../../extension/lib/targets.js";
import { sanitizeSettings, DEFAULT_TONE_PROMPT } from "../../extension/lib/store.js";
import { K } from "../../extension/lib/constants.js";
import { DAY, HOUR, MIN, _setClock } from "../../extension/lib/util.js";

const NOW = Date.UTC(2026, 9, 29, 8, 0);
const settings = sanitizeSettings({});

// t(handle, { follows: null|true|false, followedBack, firstDaysAgo, comments, checkedHoursAgo, addedMinAgo, enabled })
function t(handle, o = {}) {
  const x = newTarget(handle);
  x.addedAt = NOW - (o.addedMinAgo ?? 60) * MIN;
  if (o.follows === false || o.followedBack) applyFollow(x, false, NOW - 20 * DAY);
  if (o.follows === true) applyFollow(x, true, NOW - 20 * DAY);
  if (o.followedBack) applyFollow(x, true, NOW - DAY);
  if (o.checkedHoursAgo != null) x.rel.checkedAt = NOW - o.checkedHoursAgo * HOUR;
  if (o.firstDaysAgo != null) x.stats.firstCommentAt = NOW - o.firstDaysAgo * DAY;
  x.stats.comments = o.comments ?? (o.firstDaysAgo != null ? 3 : 0);
  if (o.enabled === false) x.enabled = false;
  return x;
}
const map = (...ts) => Object.fromEntries(ts.map((x) => [x.handle, x]));
const trusted = { followBadgeOkAt: NOW - HOUR, followersScanAt: NOW - 30 * MIN };

describe("follow tracking", () => {
  beforeEach(() => { resetStorage(); _setClock(() => NOW); });
  afterEach(() => _setClock(null));

  test("statuses: checking -> not following -> followed back; already following is never active", () => {
    assert.equal(followStatus(t("a")), FS.CHECKING);
    assert.equal(followStatus(t("b", { follows: false })), FS.ACTIVE);
    assert.equal(followStatus(t("c", { follows: true })), FS.FOLLOWS);
    assert.equal(followStatus(t("d", { followedBack: true })), FS.FOLLOWED_BACK);
  });

  test("giveUpDue: only active targets whose first comment is N days old, and only when auto-remove is on", () => {
    assert.equal(F.giveUpDue(t("a", { follows: false, firstDaysAgo: 14 }), settings, NOW), true);
    assert.equal(F.giveUpDue(t("a", { follows: false, firstDaysAgo: 13.9 }), settings, NOW), false);
    assert.equal(F.giveUpDue(t("a", { follows: false }), settings, NOW), false, "never commented: never removed");
    assert.equal(F.giveUpDue(t("a", { followedBack: true, firstDaysAgo: 30 }), settings, NOW), false);
    assert.equal(F.giveUpDue(t("a", { follows: false, firstDaysAgo: 30, enabled: false }), settings, NOW), false);
    assert.equal(F.giveUpDue(t("a", { follows: false, firstDaysAgo: 30 }), sanitizeSettings({ follow: { autoRemove: false } }), NOW), false);
    assert.equal(F.giveUpDue(t("a", { follows: false, firstDaysAgo: 8 }), sanitizeSettings({ follow: { giveUpDays: 7 } }), NOW), true);
  });

  test("followPlan: new targets trigger a deep followers scan", () => {
    const p = F.followPlan(map(t("a", { addedMinAgo: 1 }), t("b", { follows: false })), settings, trusted, NOW);
    assert.equal(p.scan, true, "a target was added after the last scan");
    assert.equal(p.deep, true);
    assert.deepEqual(p.counts, { checking: 1, active: 1, giveUp: 0 });
  });

  test("followPlan: routine scan only every scanEveryHours, and always when the badge is not trusted", () => {
    const targets = map(t("b", { follows: false, checkedHoursAgo: 1 }));
    assert.equal(F.followPlan(targets, settings, trusted, NOW).scan, false);
    assert.equal(F.followPlan(targets, settings, { ...trusted, followersScanAt: NOW - 2 * HOUR }, NOW).scan, true);
    assert.equal(F.followPlan(targets, settings, { followersScanAt: NOW - MIN }, NOW).scan, true, "badge never seen");
    assert.equal(F.followPlan(targets, settings, { followersScanAt: NOW - MIN, followersScanRetryAt: NOW + MIN }, NOW).scan, false, "failed scans wait");
    assert.equal(F.followPlan(map(t("c", { follows: true })), settings, {}, NOW).scan, false, "nothing to look for");
    assert.equal(F.followPlan(targets, settings, trusted, NOW).deep, false);
  });

  test("followPlan: profile order is give-up checks, then unknown targets (oldest first), then re-checks", () => {
    const targets = map(
      t("recheck_old", { follows: false, firstDaysAgo: 2, checkedHoursAgo: 100 }),
      t("recheck_fresh", { follows: false, firstDaysAgo: 2, checkedHoursAgo: 10 }),
      t("new2", { addedMinAgo: 5 }),
      t("new1", { addedMinAgo: 50 }),
      t("giveup", { follows: false, firstDaysAgo: 15, checkedHoursAgo: 1 }),
      t("follower", { follows: true }),
      t("waiting", { addedMinAgo: 70 }),
      t("off", { enabled: false }),
    );
    targets.waiting.rel.followCheckAfter = NOW + HOUR;
    const p = F.followPlan(targets, settings, trusted, NOW);
    assert.deepEqual(p.profiles.map((x) => `${x.handle}:${x.why}`), ["giveup:give_up", "new1:check", "new2:check", "recheck_old:recheck"]);
  });

  test("badgeTrusted expires after 3 days", () => {
    assert.equal(F.badgeTrusted({ followBadgeOkAt: NOW - 2 * DAY }, NOW), true);
    assert.equal(F.badgeTrusted({ followBadgeOkAt: NOW - 4 * DAY }, NOW), false);
    assert.equal(F.badgeTrusted({}, NOW), false);
  });

  test("giveUp removes the target and blacklists it (not when it followed back meanwhile)", async () => {
    resetStorage({ [K.targets]: map(t("bob", { follows: false, firstDaysAgo: 15, comments: 5 }), t("amy", { followedBack: true, firstDaysAgo: 15 })) });
    assert.equal(await F.giveUp("bob", settings, NOW), true);
    assert.equal(await F.giveUp("amy", settings, NOW), false);
    assert.deepEqual(Object.keys(rawGet(K.targets)), ["amy"]);
    const bl = rawGet(K.blacklist);
    assert.deepEqual(Object.keys(bl), ["bob"]);
    assert.equal(bl.bob.reason, "no_followback");
    assert.equal(bl.bob.days, 15);
    assert.equal(bl.bob.comments, 5);
    assert.equal(bl.bob.at, NOW);
  });

  test("giveUp without the blacklist option only removes", async () => {
    resetStorage({ [K.targets]: map(t("bob", { follows: false, firstDaysAgo: 15 })) });
    await F.giveUp("bob", sanitizeSettings({ follow: { blacklist: false } }), NOW);
    assert.deepEqual(rawGet(K.targets), {});
    assert.equal(rawGet(K.blacklist), undefined);
  });

  test("blacklistAdd removes targets; blacklistRemove lets them be added again", async () => {
    resetStorage({ [K.targets]: map(t("bob"), t("amy")) });
    const r = await F.blacklistAdd(["@Bob", "https://x.com/zed", "bob", "", "home"]);
    assert.deepEqual(r, { added: 2, removedTargets: 1 });
    assert.deepEqual(Object.keys(rawGet(K.targets)), ["amy"]);
    assert.deepEqual(Object.keys(rawGet(K.blacklist)).sort(), ["bob", "zed"]);
    assert.equal(rawGet(K.blacklist).bob.reason, "manual");
    assert.deepEqual(await F.blacklistRemove(["zed", "nobody"]), { removed: 1 });
    assert.deepEqual(Object.keys(rawGet(K.blacklist)), ["bob"]);
  });
});

describe("Tone prompt and follow settings", () => {
  test("defaults: Tone prompt, no pasted samples, follow rules, no extra A/B tones", () => {
    const s = sanitizeSettings({});
    assert.equal(s.prompt.tone, DEFAULT_TONE_PROMPT);
    assert.equal("styleExamples" in s.prompt, false);
    assert.deepEqual(s.follow, { giveUpDays: 14, autoRemove: true, blacklist: true, scanEveryHours: 2, recheckHours: 72, checksPerRun: 4 });
    assert.deepEqual(s.learning.abTones, { A: [], B: [] });
    assert.equal("autoMoveToA" in s.learning, false);
  });

  test("the Tone prompt is kept, trimmed, capped; empty means the default", () => {
    assert.equal(sanitizeSettings({ prompt: { tone: "  lowercase. blunt.  " } }).prompt.tone, "lowercase. blunt.");
    assert.equal(sanitizeSettings({ prompt: { tone: "" } }).prompt.tone, DEFAULT_TONE_PROMPT);
    assert.equal(sanitizeSettings({ prompt: { tone: "x".repeat(5000) } }).prompt.tone.length, 2000);
  });

  test("follow settings are clamped", () => {
    const f = sanitizeSettings({ follow: { giveUpDays: 1, scanEveryHours: 0, recheckHours: 1, checksPerRun: 99, autoRemove: 0, blacklist: false } }).follow;
    assert.deepEqual(f, { giveUpDays: 3, autoRemove: true, blacklist: false, scanEveryHours: 1, recheckHours: 12, checksPerRun: 8 });
    assert.equal(sanitizeSettings({ follow: { autoRemove: false } }).follow.autoRemove, false);
    assert.equal(sanitizeSettings({ follow: { giveUpDays: 500 } }).follow.giveUpDays, 90);
  });

  test("old settings: the chosen group B tone becomes the Tone prompt, old default A/B lists are dropped", () => {
    const custom = sanitizeSettings({ groups: { B: { tone: "custom", customTone: "Dry and short." } }, prompt: { styleExamples: ["x"] } });
    assert.equal(custom.prompt.tone, "Dry and short.");
    const mine = sanitizeSettings({ customTones: [{ id: "t1", name: "Mine", text: "My own voice." }], groups: { B: { tone: "custom:t1" } } });
    assert.equal(mine.prompt.tone, "My own voice.");
    const edited = sanitizeSettings({ groups: { B: { tone: "bold" } }, tones: { bold: "Very bold, edited." } });
    assert.equal(edited.prompt.tone, "Very bold, edited.");
    const untouched = sanitizeSettings({ groups: { B: { tone: "insightful" } }, learning: { abTones: { A: ["friendly", "witty", "insightful"], B: ["insightful", "bold", "expert"] } } });
    assert.equal(untouched.prompt.tone, DEFAULT_TONE_PROMPT);
    assert.deepEqual(untouched.learning.abTones.B, []);
    const chosen = sanitizeSettings({ learning: { abTones: { A: [], B: ["witty"] } } });
    assert.deepEqual(chosen.learning.abTones.B, ["witty"], "A/B tones the user picked are kept");
    // New-style settings are never migrated again.
    const saved = sanitizeSettings({ prompt: { tone: "Kept." }, groups: { B: { tone: "custom", customTone: "Old." } } });
    assert.equal(saved.prompt.tone, "Kept.");
  });
});
