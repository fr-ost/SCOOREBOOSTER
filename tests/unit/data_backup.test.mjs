// Task D regression tests for lib/backup.js (FOL-4 and the import / reset audit findings).
import { resetStorage, rawGet } from "./_chrome.mjs";
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as B from "../../extension/lib/backup.js";
import * as S from "../../extension/lib/store.js";
import * as H from "../../extension/lib/history.js";
import { newTarget } from "../../extension/lib/targets.js";
import { useMemoryDb } from "../../extension/lib/db.js";
import { K, HS } from "../../extension/lib/constants.js";

describe("data: backup import / reset", () => {
  beforeEach(() => { resetStorage(); useMemoryDb(); });

  test("FOL-4: restoring a backup does not add back targets that are on the current blacklist", async () => {
    await S.save({ [K.blacklist]: { bob: { handle: "bob", reason: "no_followback", at: Date.now(), days: 14, comments: 6 } } });
    const r = await B.importData({ targets: { bob: newTarget("bob", { tier: 2 }), amy: newTarget("amy", { tier: 2 }) }, blacklist: {} }, ["targets"]);
    assert.deepEqual(Object.keys(rawGet(K.targets)), ["amy"]);
    assert.equal(r.imported.targets, 1);
    assert.equal(r.imported.blacklisted, 1);
    assert.equal(rawGet(K.blacklist).bob.reason, "no_followback", "your blacklist entry stays as it was");
  });

  test("FOL-4: the backup's own blacklist is merged first and applies to both lists", async () => {
    await S.save({ [K.targets]: { cat: newTarget("cat"), keep: newTarget("keep") }, [K.blacklist]: { dan: { handle: "dan", reason: "manual", at: 5, comments: 0 } } });
    const r = await B.importData({
      targets: { eve: newTarget("eve"), fay: newTarget("fay") },
      blacklist: { eve: { handle: "eve", reason: "manual", at: 1 }, cat: { handle: "cat", reason: "no_followback", at: 2 }, dan: { handle: "dan", reason: "no_followback", at: 3 } },
    }, ["targets"]);
    const t = rawGet(K.targets);
    assert.deepEqual(Object.keys(t).sort(), ["fay", "keep"]);
    assert.equal(r.imported.targets, 1, "eve is on the imported blacklist, so it is not counted as an imported target");
    const bl = rawGet(K.blacklist);
    assert.deepEqual(Object.keys(bl).sort(), ["cat", "dan", "eve"]);
    assert.equal(bl.dan.reason, "manual", "an entry you already had wins over the backup's");
  });

  test("your own handle is never imported as a target", async () => {
    await S.saveSettings(S.sanitizeSettings({ account: { handle: "0x_nation" } }));
    await B.importData({ targets: { "0x_nation": newTarget("0x_nation"), zed: newTarget("zed") } }, ["targets"]);
    assert.deepEqual(Object.keys(rawGet(K.targets)), ["zed"]);
  });

  test("imported targets keep auto tier-up unless their tier was set by hand", async () => {
    const auto = newTarget("auto", { tier: 2 });
    const manual = { ...newTarget("manual", { tier: 1 }), tierManual: true };
    await S.save({ [K.targets]: { mine: { ...newTarget("mine", { tier: 1 }), tierManual: true } } });
    await B.importData({ targets: { auto, manual, mine: newTarget("mine", { tier: 2 }) } }, ["targets"]);
    const t = rawGet(K.targets);
    assert.equal(t.auto.tierManual, undefined, "sanitizePatch used to mark every imported tier as manual");
    assert.equal(t.manual.tierManual, true);
    assert.equal(t.mine.tierManual, true, "a tier you set here stays manual");
  });

  test("size limits: at most 5,000 targets and 2,000 candidates per import; candidates skip targets / blacklist", async () => {
    const targets = {}; for (let i = 0; i < 5200; i++) targets["t" + i] = { handle: "t" + i, tier: 2 };
    let r = await B.importData({ targets }, ["targets"]);
    assert.equal(r.imported.targets, 5000);
    resetStorage();
    await S.save({ [K.targets]: { tgt: newTarget("tgt") }, [K.blacklist]: { blk: { handle: "blk", reason: "manual", at: 1 } } });
    const cands = { tgt: { handle: "tgt" }, blk: { handle: "blk" } };
    for (let i = 0; i < 30000; i++) cands["c" + i] = { handle: "c" + i, foundAt: i };
    r = await B.importData({ candidates: cands }, ["candidates"]);
    const c = rawGet(K.candidates);
    assert.equal(Object.keys(c).length, S.CANDIDATES_CAP);
    assert.equal(r.imported.candidates, S.CANDIDATES_CAP);
    assert.equal(c.tgt, undefined);
    assert.equal(c.blk, undefined);
  });

  test("history import keeps views (reach monitor) and the gone flag", () => {
    const rec = B.cleanHistoryRecord({ id: "h1", createdAt: Date.now() - 1000, status: "posted", postedAt: Date.now() - 900, target: "bob", postId: "123456", results: { views: 345, likes: 2, gone: true } });
    assert.equal(rec.results.views, 345);
    assert.equal(rec.results.gone, true);
    assert.equal(B.cleanHistoryRecord({ id: "h2", createdAt: Date.now(), target: "bob", results: { views: "lots" } }).results.views, null);
  });

  test("resetAll removes provider overrides, conversation alerts and score data but keeps today's provider request counts", async () => {
    await S.save({ [K.providerOverrides]: { sorsa: {} }, [K.conversations]: { items: [{ id: "x" }] }, [K.scoreboard]: { own: { sorsa: { score: 1 } }, checks: { a: {} }, usage: { sorsa: { d: "2026-10-30", n: 5 } } }, [K.spend]: { days: { x: 1 } } });
    await B.resetAll();
    assert.equal(rawGet(K.providerOverrides), undefined);
    assert.equal(rawGet(K.conversations), undefined);
    assert.deepEqual(rawGet(K.scoreboard), { usage: { sorsa: { d: "2026-10-30", n: 5 } } });
    assert.deepEqual(rawGet(K.spend), { days: { x: 1 } });
  });

  test("resetAll keeps a post that was in flight (it may be live on X) and counts it as probably posted", async () => {
    const posting = H.newRecord({ target: "bob", status: HS.POSTING, postId: "1900000000000000001", attemptAt: Date.now() });
    const pending = H.newRecord({ target: "amy", status: HS.PENDING_REVIEW });
    const posted = H.newRecord({ target: "cy", status: HS.POSTED, postedAt: Date.now() });
    for (const r of [posting, pending, posted]) await H.put(r);
    await B.resetAll();
    const p = await H.get(posting.id);
    assert.ok(p, "was deleted before: the 24 h limit then missed a comment that may be live");
    assert.equal(p.status, HS.FAILED);
    assert.equal(p.maybePosted, true);
    assert.equal(await H.get(pending.id), undefined);
    assert.equal((await H.get(posted.id)).status, HS.POSTED);
  });
});
