// The follow-back record (lib/followbacks.js, History > Follow-backs): who followed back, when, after how many comments
// and days, the last comment before it, whether ScoreX followed them first, whether they unfollowed later. Written
// where follow-backs are credited, backfilled from targets and history, kept when a target is removed.
import { resetStorage, rawGet } from "./_chrome.mjs";
import { install } from "./_fake_xtab.mjs";
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useMemoryDb } from "../../extension/lib/db.js";
import * as H from "../../extension/lib/history.js";
import * as T from "../../extension/lib/targets.js";
import * as FB from "../../extension/lib/followbacks.js";
import { processFollowBacks } from "../../extension/lib/learning.js";
import { exportData, importData, resetAll } from "../../extension/lib/backup.js";
import { sanitizeSettings, save, getTargets, updateTargets } from "../../extension/lib/store.js";
import { toCsv } from "../../extension/lib/xlsx.js";
import { K } from "../../extension/lib/constants.js";
import { DAY, _setClock } from "../../extension/lib/util.js";

const NOW = Date.UTC(2026, 10, 1, 8, 0);
const settings = sanitizeSettings({});
const posted = (id, target, postedAt, comment = "c-" + id) => H.newRecord({ id, status: "posted", target, group: "B", tier: 2, postedAt, createdAt: postedAt - 60000, comment, replyUrl: "https://x.com/0x_nation/status/" + id, postUrl: `https://x.com/${target}/status/9${id}`, replyId: id });
const at = (ts, fn) => { _setClock(() => ts); return fn(); };

// A target that did not follow you, got comments, then followed back at `fbAt`.
async function followBack(handle, { comments = 2, fbAt = NOW - DAY, followedFirst = false, followers = 25000, tier = 2 } = {}) {
  const t = T.newTarget(handle, { tier });
  t.addedAt = NOW - 30 * DAY;
  t.profile = { name: handle.toUpperCase(), followers };
  t.score = { own: 61, combined: 64, providers: { twitterscore: { score: 420, at: NOW - 5 * DAY } } };
  T.applyFollow(t, false, NOW - 30 * DAY);
  if (followedFirst) t.rel.followedByScoreXAt = NOW - 25 * DAY;
  const first = NOW - 20 * DAY;
  t.stats = { comments, firstCommentAt: first, lastCommentAt: first + (comments - 1) * DAY };
  await updateTargets((all) => { all[handle] = t; return all; });
  for (let i = 0; i < comments; i++) await H.put(posted(`${handle}${i}`, handle, first + i * DAY, `comment ${i + 1} to ${handle}`));
  await at(fbAt, () => updateTargets((all) => { T.applyFollow(all[handle], true, fbAt); return all; }));
  await at(fbAt, () => processFollowBacks(settings));
}

describe("follow-back record", () => {
  let fx;
  before(() => { fx = install({}); });
  after(() => { fx.uninstall(); resetStorage(); useMemoryDb(); });
  beforeEach(() => { resetStorage(); useMemoryDb(); fx.notifications.length = 0; });
  afterEach(() => _setClock(null));

  test("a follow-back is recorded once with when, after how many comments and days, the last comment, followers and score", async () => {
    await followBack("alice", { comments: 3, fbAt: NOW - DAY, followedFirst: true });
    const log = rawGet(K.followbacks);
    assert.equal(log.length, 1);
    const e = log[0];
    assert.deepEqual([e.handle, e.name, e.at, e.tier, e.comments], ["alice", "ALICE", NOW - DAY, 2, 3]);
    assert.equal(e.days, 19, "first comment 20 days ago, follow-back 1 day ago");
    assert.equal(e.youFollowedFirst, true);
    assert.equal(e.followers, 25000);
    assert.equal(e.score, 64);
    assert.equal(e.twitterscore, 420);
    assert.equal(e.lastComment.text, "comment 3 to alice");
    assert.match(e.lastComment.url, /status\/alice2$/);
    assert.equal(e.unfollowedAt, null);
    await processFollowBacks(settings); // credited already: no second entry
    assert.equal(rawGet(K.followbacks).length, 1);
  });

  test("kept when the target is removed; 'unfollowed later' and a second follow-back ('again') are tracked", async () => {
    await followBack("bob", { comments: 1, fbAt: NOW - 10 * DAY });
    // Unfollows (two misses), then follows back again.
    await at(NOW - 6 * DAY, () => updateTargets((all) => { T.applyFollow(all.bob, false, NOW - 6 * DAY); T.applyFollow(all.bob, false, NOW - 5 * DAY); return all; }));
    await H.put(posted("b9", "bob", NOW - 3 * DAY, "the comment before the second follow-back"));
    await at(NOW, () => updateTargets((all) => { T.applyFollow(all.bob, true, NOW); return all; }));
    await at(NOW, () => processFollowBacks(settings));
    let list = FB.mergeEntries(rawGet(K.followbacks), await getTargets(), await H.all());
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((e) => [e.at, !!e.again, !!e.unfollowedAt]), [[NOW, true, false], [NOW - 10 * DAY, false, true]]);
    assert.equal(list[0].lastComment.text, "the comment before the second follow-back");
    assert.equal(rawGet(K.followbacks).find((e) => e.at === NOW - 10 * DAY).unfollowedAt, NOW - 5 * DAY, "stored too");
    // The target is removed: the record keeps both entries.
    await updateTargets((all) => { delete all.bob; return all; });
    list = FB.mergeEntries(rawGet(K.followbacks), await getTargets(), await H.all());
    assert.equal(list.length, 2);
    assert.equal(list[0].handle, "bob");
  });

  test("backfill: follow-backs from before the record (targets) and of removed targets (history) are added once", async () => {
    // Earlier follow-back on a target, credited before the record existed (no entry).
    const t = T.newTarget("carol");
    T.applyFollow(t, false, NOW - 30 * DAY);
    t.stats = { comments: 2, firstCommentAt: NOW - 20 * DAY };
    T.applyFollow(t, true, NOW - 15 * DAY);
    t.rel.followBackCredited = true;
    await save({ [K.targets]: { carol: t } });
    await H.put(posted("c1", "carol", NOW - 20 * DAY));
    // A removed target whose follow-back only its credited comment remembers.
    const r = posted("d1", "dave", NOW - 12 * DAY, "hi dave");
    r.results = { followedBack: true, followBackAt: NOW - 9 * DAY };
    await H.put(r);
    assert.deepEqual(FB.mergeEntries([], await getTargets(), await H.all()).map((e) => e.handle), ["dave", "carol"], "the page shows both before any backfill");
    assert.equal(await FB.syncFollowBacks({ fromHistory: true }), 2);
    assert.equal(await FB.syncFollowBacks({ fromHistory: true }), 0, "once");
    const log = rawGet(K.followbacks);
    assert.deepEqual(log.map((e) => e.handle), ["dave", "carol"], "newest first");
    assert.equal(log[0].lastComment.text, "hi dave");
    assert.equal(log[1].days, 5);
  });

  test("download columns; reset clears the record; backups carry it and an import merges without duplicates", async () => {
    await followBack("erin", { comments: 2, fbAt: NOW - 2 * DAY });
    const table = FB.toTable(rawGet(K.followbacks));
    assert.deepEqual(table[0], ["Followed back", "Username", "Name", "Tier", "Comments before", "Days from first comment", "You followed first", "Followers", "ScoreX rank", "TwitterScore", "Last comment", "Last comment link", "Unfollowed later", "Profile"]);
    assert.equal(table[1][1], "erin");
    assert.equal(table[1][13], "https://x.com/erin");
    assert.ok(toCsv(table).includes("comment 2 to erin"));
    const backup = (await exportData(["history"])).data;
    assert.equal(backup.followbacks.length, 1);
    await resetAll();
    assert.equal(rawGet(K.followbacks), undefined, "Reset everything clears it");
    let r = await importData(backup, ["history"]);
    assert.equal(r.imported.followbacks, 1);
    r = await importData(backup, ["history"]);
    assert.equal(r.imported.followbacks, 0, "no duplicates");
    assert.equal(rawGet(K.followbacks)[0].handle, "erin");
    r = await importData({ followbacks: [{ handle: "=evil", at: NOW }, { handle: "ok_one", at: "x" }, { handle: "fine", at: NOW, lastComment: { text: "t", url: "javascript:alert(1)" } }] }, ["history"]);
    const fine = rawGet(K.followbacks).find((e) => e.handle === "fine");
    assert.equal(r.imported.followbacks, 1, "bad handles and dates are dropped");
    assert.equal(fine.lastComment.url, "", "only x.com links are kept");
  });
});
