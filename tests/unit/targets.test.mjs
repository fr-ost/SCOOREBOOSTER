import { resetStorage, rawGet } from "./_chrome.mjs";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as tg from "../../extension/lib/targets.js";
import { sanitizeSettings, DEFAULT_TONE_PROMPT } from "../../extension/lib/store.js";
import { K } from "../../extension/lib/constants.js";
import { DAY, HOUR, _setClock } from "../../extension/lib/util.js";

const NOW = Date.UTC(2026, 9, 29, 8, 0);
const settings = sanitizeSettings({});
const handles = (rows) => rows.map((r) => r.handle);

describe("targets.js", () => {
  beforeEach(() => { resetStorage(); _setClock(() => NOW); });
  afterEach(() => _setClock(null));

  describe("parseImport", () => {
    test("plain list (newlines, @, dedupe, invalid dropped)", () => {
      assert.deepEqual(tg.parseImport("@alice\nbob\n\n  carol  \n@Alice\nhome\n!!!"), [{ handle: "alice" }, { handle: "bob" }, { handle: "carol" }]);
      assert.deepEqual(tg.parseImport(""), []);
      assert.deepEqual(tg.parseImport(null), []);
    });
    test("one-line comma / space separated lists are lists, not CSV", () => {
      assert.deepEqual(handles(tg.parseImport("alice, bob, carol")), ["alice", "bob", "carol"]);
      assert.deepEqual(handles(tg.parseImport("@alice, @bob")), ["alice", "bob"]);
      assert.deepEqual(handles(tg.parseImport("alice,bob\ncarol,dave")), ["alice", "bob", "carol", "dave"]);
      assert.deepEqual(handles(tg.parseImport("alice bob; carol")), ["alice", "bob", "carol"]);
    });
    test("profile and status URLs", () => {
      const rows = tg.parseImport("https://x.com/Foo/status/1849000000000000000\nhttps://twitter.com/bar\nx.com/baz?s=20\nhttps://x.com/home");
      assert.deepEqual(handles(rows), ["foo", "bar", "baz"]);
    });
    test("CSV with header (quoted cells, any column order)", () => {
      const csv = 'handle,group,tier,tone,notes\n@Foo,A,1,witty,"met at ETHDenver, nice"\nbar,b,2,,\n,A,1,,\n@Foo,B,2,,dup';
      const rows = tg.parseImport(csv);
      assert.deepEqual(rows, [
        { handle: "foo", group: "A", tier: "1", tone: "witty", notes: "met at ETHDenver, nice" },
        { handle: "bar", group: "b", tier: "2" },
      ]);
      assert.deepEqual(tg.parseImport("tier,handle\n1,foo\n2,bar"), [{ tier: "1", handle: "foo" }, { tier: "2", handle: "bar" }]);
      assert.deepEqual(tg.parseImport("username,group\nfoo,A"), [{ handle: "foo", group: "A" }]);
      assert.deepEqual(tg.parseImport('handle,notes\nfoo,"said ""hi"" once"'), [{ handle: "foo", notes: 'said "hi" once' }]);
    });
    test("CSV without header uses handle,group,tier,tone,notes", () => {
      assert.deepEqual(tg.parseImport("foo,A,1\nbar,B,2,bold,top account"), [
        { handle: "foo", group: "A", tier: "1" },
        { handle: "bar", group: "B", tier: "2", tone: "bold", notes: "top account" },
      ]);
      assert.deepEqual(tg.parseImport("https://x.com/foo,A,1"), [{ handle: "foo", group: "A", tier: "1" }]);
      assert.deepEqual(tg.parseImport("foo,,1"), [{ handle: "foo", tier: "1" }]);
      assert.deepEqual(tg.parseImport("foo,A"), [{ handle: "foo", group: "A" }]);
    });
    test("JSON array of strings / objects", () => {
      assert.deepEqual(tg.parseImport('["@a1", "https://x.com/b2", "home", "a1"]'), [{ handle: "a1" }, { handle: "b2" }]);
      const rows = tg.parseImport(JSON.stringify([
        { handle: "@Alice", group: "A", tier: 1, tone: "witty", notes: "n", name: "Alice" },
        { username: "bob" }, { screen_name: "carol" }, { nope: 1 }, null, 42,
      ]));
      assert.deepEqual(rows[0], { handle: "alice", group: "A", tier: 1, tone: "witty", notes: "n", name: "Alice" });
      assert.deepEqual(handles(rows), ["alice", "bob", "carol"]);
    });
    test('JSON {targets:{...}}, {targets:[...]} and plain maps', () => {
      const backup = { targets: { alice: { handle: "alice", group: "A", tier: 1 }, bob: { handle: "bob", group: "B", tier: 2 } } };
      assert.deepEqual(handles(tg.parseImport(JSON.stringify(backup))), ["alice", "bob"]);
      assert.equal(tg.parseImport(JSON.stringify(backup))[0].group, "A");
      assert.deepEqual(handles(tg.parseImport(JSON.stringify({ targets: ["x1", { handle: "y1" }] }))), ["x1", "y1"]);
      assert.deepEqual(handles(tg.parseImport(JSON.stringify({ carol: { handle: "carol" } }))), ["carol"]);
    });
    test("broken JSON falls back to text parsing", () => {
      assert.deepEqual(handles(tg.parseImport("[alice, bob")), ["bob"]);
    });
  });

  describe("sanitizePatch", () => {
    test("keeps only editable fields and normalises them", () => {
      const p = tg.sanitizePatch({
        group: "A", tier: "1", enabled: 0, priority: 150, tone: null, preset: "ultra",
        notes: "n".repeat(600), name: "x".repeat(100), handle: "evil", stats: { comments: 999 }, score: {},
      });
      // The group is never editable: it mirrors the detected follow status.
      assert.deepEqual(Object.keys(p).sort(), ["enabled", "name", "notes", "preset", "priority", "priorityManual", "tier", "tierManual", "tone"]);
      assert.equal(p.tier, 1);
      assert.equal(p.enabled, false);
      assert.equal(p.priority, 100);
      assert.equal(p.tone, "");
      assert.equal(p.preset, "");
      assert.equal(p.notes.length, 500);
      assert.equal(p.name.length, 80);
    });
    test("defaults for odd values", () => {
      assert.deepEqual(tg.sanitizePatch({ group: "x", tier: 7, priority: "abc", preset: "cheap" }), { tier: 2, tierManual: true, priority: 50, priorityManual: true, preset: "cheap" });
      assert.deepEqual(tg.sanitizePatch({ priority: -3 }), { priority: 0, priorityManual: true });
      assert.deepEqual(tg.sanitizePatch({}), {});
    });
  });

  describe("newTarget / applyProfile / mergePosts", () => {
    test("newTarget defaults: follow status unknown until checked, whatever group was given", () => {
      const a = tg.newTarget("foo", { group: "A", tier: 1 });
      assert.equal(a.group, "B");
      assert.equal(a.tier, 1);
      assert.equal(a.rel.followsYou, null);
      assert.equal(tg.followStatus(a), tg.FS.CHECKING);
      assert.equal(a.stats.firstCommentAt, null);
      assert.equal(a.priority, 70);
      assert.equal(a.addedAt, NOW);
      const b = tg.newTarget("bar");
      assert.equal(b.group, "B");
      assert.equal(b.tier, 2);
      assert.equal(b.rel.followsYou, null);
      assert.equal(b.enabled, true);
      assert.equal(b.source, "manual");
      assert.equal(b.stats.comments, 0);
    });

    test("followedBackAt is set when followsYou flips false -> true (only once)", () => {
      const t = tg.newTarget("foo", { group: "B" });
      tg.applyProfile(t, { followsYou: false });
      assert.equal(t.rel.followsYou, false);
      assert.equal(t.rel.followedBackAt, null);
      assert.equal(t.rel.checkedAt, NOW);
      _setClock(() => NOW + DAY);
      tg.applyProfile(t, { followsYou: true });
      assert.equal(t.rel.followsYou, true);
      assert.equal(t.rel.followedBackAt, NOW + DAY);
      _setClock(() => NOW + 2 * DAY);
      tg.applyProfile(t, { followsYou: false });
      tg.applyProfile(t, { followsYou: true });
      assert.equal(t.rel.followedBackAt, NOW + DAY);
    });

    test("unknown -> true is not a follow-back; the group mirrors the follow status", () => {
      const b = tg.newTarget("foo");
      tg.applyProfile(b, { followsYou: true });
      assert.equal(b.rel.followedBackAt, null);
      assert.equal(b.group, "A");
      assert.equal(tg.followStatus(b), tg.FS.FOLLOWS);
      const c = tg.newTarget("bar");
      tg.applyFollow(c, false);
      assert.equal(c.group, "B");
      assert.equal(tg.followStatus(c), tg.FS.ACTIVE);
      tg.applyFollow(c, true);
      assert.equal(c.group, "A");
      assert.equal(tg.followStatus(c), tg.FS.FOLLOWED_BACK);
    });

    test("followStatus / followDays / isActive", () => {
      const t = tg.newTarget("foo");
      assert.equal(tg.isActive(t, settings), false, "never commented on before the follow check");
      assert.equal(tg.followDays(t, NOW), null);
      tg.applyFollow(t, false);
      assert.equal(tg.isActive(t, settings), true);
      t.stats.firstCommentAt = NOW - 3 * DAY - HOUR;
      assert.equal(tg.followDays(t, NOW), 3);
      t.enabled = false;
      assert.equal(tg.isActive(t, settings), false);
      t.enabled = true;
      tg.applyFollow(t, true);
      assert.equal(tg.isActive(t, settings), false, "a follow-back stops comments");
      assert.equal(tg.isActive({ enabled: true, rel: { followsYou: true } }, settings), false, "followers are never commented on");
    });

    test("youFollowSince tracks when we started following", () => {
      const t = tg.newTarget("foo");
      tg.applyProfile(t, { youFollow: true });
      assert.equal(t.rel.youFollowSince, NOW);
      _setClock(() => NOW + DAY);
      tg.applyProfile(t, { youFollow: true });
      assert.equal(t.rel.youFollowSince, NOW);
      tg.applyProfile(t, { youFollow: false });
      assert.equal(t.rel.youFollowSince, null);
      assert.equal(t.rel.youFollow, false);
      tg.applyProfile(t, { name: "Only name" });
      assert.equal(t.rel.checkedAt, NOW + DAY); // unchanged without relationship data
    });

    test("profile merge keeps known values, updates name, computes score", () => {
      const t = tg.newTarget("foo");
      tg.applyProfile(t, { handle: "foo", name: "Foo", followers: 120000, following: 300, bio: "builder", verified: true });
      tg.applyProfile(t, { followers: 125000, bio: "", name: undefined, following: null });
      assert.equal(t.profile.followers, 125000);
      assert.equal(t.profile.following, 300);
      assert.equal(t.profile.bio, "builder");
      assert.equal(t.profile.updatedAt, NOW);
      assert.equal(t.name, "Foo");
      assert.equal(typeof t.score.own, "number");
      assert.equal(t.score.combined, t.score.own); // no Sorsa score
      assert.equal(t.suggestedTier, 1); // >= 50k followers
      assert.equal(t.lastCheckedAt, NOW);
      t.score.sorsa = null;
      tg.applyProfile(t, { followers: 125000 });
      assert.equal(t.score.combined, t.score.own);
      t.score.sorsa = 3000;
      tg.applyProfile(t, { followers: 125000 }, null, 0.5);
      assert.equal(t.score.combined, Math.round(t.score.own * 0.5 + 100 * 0.5));
      assert.equal(tg.applyProfile(null, {}), null);
    });

    test("mergePosts keeps the newest 5 originals", () => {
      const t = tg.newTarget("foo");
      t.recentPosts = [{ id: "1", text: "old", createdAt: NOW - 10 * HOUR }, { id: "2", text: "older", createdAt: NOW - 20 * HOUR }];
      tg.mergePosts(t, [
        { id: "3", text: "a", createdAt: NOW - 1 * HOUR },
        { id: "4", text: "repost", createdAt: NOW, isRepost: true },
        { id: "5", text: "reply", createdAt: NOW, isReply: true },
        { id: "6", text: "pinned", createdAt: NOW, isPinned: true },
        { id: "7", text: "b", createdAt: NOW - 2 * HOUR },
        { id: "8", text: "c", createdAt: NOW - 3 * HOUR },
        { id: "9", text: "x".repeat(1000), createdAt: NOW - 4 * HOUR, lang: "en", metrics: { likes: 3 } },
        { id: "1", text: "old (updated)", createdAt: NOW - 10 * HOUR },
        null, { text: "no id" },
      ]);
      assert.deepEqual(t.recentPosts.map((p) => p.id), ["3", "7", "8", "9", "1"]);
      assert.equal(t.recentPosts[3].text.length, 600);
      assert.deepEqual(t.recentPosts[3].metrics, { likes: 3 });
      assert.equal(t.recentPosts[4].text, "old (updated)");
      assert.equal(t.lastPostAt, NOW - HOUR);
      // older posts never move lastPostAt backwards
      tg.mergePosts(t, [{ id: "z", text: "ancient", createdAt: NOW - 100 * DAY }]);
      assert.equal(t.lastPostAt, NOW - HOUR);
    });

    test("applyProfile merges posts and scores them", () => {
      const t = tg.newTarget("foo");
      tg.applyProfile(t, { followers: 5000, following: 500 }, [{ id: "1", text: "hello world", createdAt: NOW - HOUR, metrics: { likes: 50, replies: 5, reposts: 2 } }]);
      assert.equal(t.recentPosts.length, 1);
      assert.equal(t.lastPostAt, NOW - HOUR);
      assert.ok(t.score.postsPerDay > 0);
    });
  });

  describe("tone / preset resolution", () => {
    const s = sanitizeSettings({
      customTones: [{ id: "dry", name: "Dry", text: "Deadpan and dry." }],
      prompt: { tone: "lowercase, blunt, crypto-native. one sharp point." },
    });

    test("effectiveTone: override > target tone > your Tone prompt", () => {
      assert.deepEqual(tg.effectiveTone({ group: "B", tone: "" }, s), { key: "main", text: "lowercase, blunt, crypto-native. one sharp point." });
      assert.deepEqual(tg.effectiveTone({ group: "B", tone: "bold" }, s), { key: "bold", text: s.tones.bold });
      assert.deepEqual(tg.effectiveTone({ group: "B", tone: "bold" }, s, "witty"), { key: "witty", text: s.tones.witty });
      assert.deepEqual(tg.effectiveTone({ group: "A", tone: "" }, settings), { key: "main", text: DEFAULT_TONE_PROMPT });
    });
    test("custom:<id> tones; missing ones fall back to the Tone prompt", () => {
      assert.deepEqual(tg.effectiveTone({ group: "B", tone: "custom:dry" }, s), { key: "custom:dry", text: "Deadpan and dry." });
      assert.deepEqual(tg.effectiveTone({ group: "B", tone: "custom:gone" }, s), { key: "custom:gone", text: s.prompt.tone });
    });
    test("unknown tone keys fall back to the Tone prompt", () => {
      assert.equal(tg.toneText("nonexistent", s), s.prompt.tone);
      assert.equal(tg.toneText("", s), s.prompt.tone);
      assert.equal(tg.toneText("main", s), s.prompt.tone);
      assert.equal(tg.effectiveTone({ group: "Z", tone: "" }, s).key, "main");
      assert.deepEqual(tg.allToneKeys(s), ["casual", "delta", "chill", "sharp", "question", "witty", "insightful", "bold", "friendly", "expert", "custom:dry"]);
    });
    test("effectivePreset: target override > tier preset (accounts you comment on never follow you)", () => {
      // Default tier presets: the Human preset (UniqueFarm style) for both tiers.
      assert.equal(tg.effectivePreset({ group: "A", tier: 1, preset: "" }, settings), "human");
      assert.equal(tg.effectivePreset({ group: "A", tier: 2, preset: "" }, settings), "human");
      assert.equal(tg.effectivePreset({ group: "B", tier: 1, preset: "" }, settings), "human");
      assert.equal(tg.effectivePreset({ group: "B", tier: 2, preset: "" }, settings), "human");
      assert.equal(tg.effectivePreset({ group: "B", tier: 1, preset: "cheap" }, settings), "cheap");
      assert.equal(tg.effectivePreset({ group: "B", tier: 1, preset: "bogus" }, settings), "human");
      assert.equal(tg.effectivePreset({ group: "C", tier: 9, preset: "" }, settings), "human");
      assert.equal(tg.effectivePreset({ tier: 1 }, sanitizeSettings({ presetMatrix: { B1: "high", B2: "balanced" }, genRev: 1 })), "high");
      assert.equal(tg.effectivePreset({ tier: 1 }, sanitizeSettings({ presetMatrix: { B1: "cheap" } })), "cheap");
    });
  });

  describe("storage-backed CRUD", () => {
    test("upsert adds new targets, skips invalid and own handle", async () => {
      const r = await tg.upsert(["@Alice", "bob", "home", "0x_nation", { handle: "https://x.com/Carol", group: "A", tier: "1", tone: "witty", notes: "n" }],
        { group: "A", tier: 1, source: "import", myHandle: "0x_nation" });
      assert.deepEqual(r, { added: 3, updated: 0, blacklisted: 0 });
      const all = rawGet(K.targets);
      assert.deepEqual(Object.keys(all).sort(), ["alice", "bob", "carol"]);
      assert.equal(all.alice.group, "B", "a group column is ignored: follow status is always checked on X");
      assert.equal(all.carol.rel.followsYou, null);
      assert.equal(all.alice.tier, 1);
      assert.equal(all.alice.source, "import");
      assert.equal(all.carol.tone, "witty");
      assert.equal(all.carol.notes, "n");
      assert.ok(!all["0x_nation"]);
    });

    test("upsert updates existing targets without losing stats", async () => {
      await tg.upsert(["alice"], { group: "A", tier: 1 });
      const all0 = rawGet(K.targets);
      all0.alice.stats.comments = 7;
      resetStorage({ [K.targets]: all0 });
      const r = await tg.upsert([{ handle: "alice", group: "b" }, { handle: "dave" }], { group: "B", tier: 2 });
      assert.deepEqual(r, { added: 1, updated: 1, blacklisted: 0 });
      const all = rawGet(K.targets);
      assert.equal(all.alice.tier, 1); // not given -> unchanged
      assert.equal(all.alice.stats.comments, 7);
      // overwrite applies defaults to existing rows
      await tg.upsert(["alice"], { tier: 2 }, true);
      assert.equal(rawGet(K.targets).alice.tier, 2);
      // without overwrite and without explicit values nothing changes
      await tg.upsert(["alice"], { tier: 1 });
      assert.equal(rawGet(K.targets).alice.tier, 2);
    });

    test("blacklisted handles are never added", async () => {
      resetStorage({ [K.blacklist]: { bob: { handle: "bob", reason: "no_followback", at: NOW } } });
      const r = await tg.upsert(["alice", "@Bob", "https://x.com/bob"]);
      assert.deepEqual(r, { added: 1, updated: 0, blacklisted: 2 });
      assert.deepEqual(Object.keys(rawGet(K.targets)), ["alice"]);
    });

    test("concurrent upserts are not lost", async () => {
      await Promise.all(Array.from({ length: 30 }, (_, i) => tg.upsert(["user" + i])));
      assert.equal(Object.keys(rawGet(K.targets)).length, 30);
    });

    test("patch / bulk / removeMany", async () => {
      await tg.upsert(["alice", "bob", "carol"], {});
      const t = await tg.patch("@Alice", { tier: "1", handle: "hack", stats: null, enabled: false });
      assert.equal(t.handle, "alice");
      assert.equal(t.tier, 1);
      assert.equal(t.enabled, false);
      assert.ok(t.stats);
      assert.equal(await tg.patch("ghost", { tier: 1 }), null);
      await tg.bulk(["bob", "@CAROL", "ghost"], { group: "A", priority: 90 });
      const all = rawGet(K.targets);
      assert.equal(all.bob.group, "B", "group is not editable");
      assert.equal(all.bob.priority, 90);
      assert.equal(all.carol.priority, 90);
      assert.ok(!all.ghost);
      assert.equal(await tg.removeMany(["alice", "@BOB", "ghost", "alice"]), 2);
      assert.deepEqual(Object.keys(rawGet(K.targets)), ["carol"]);
    });

    test("activeTargets / isActive / isCold", async () => {
      await tg.upsert(["alice", "bob", "carol", "dave"]);
      const all = rawGet(K.targets);
      tg.applyFollow(all.alice, false);
      tg.applyFollow(all.bob, false);
      tg.applyFollow(all.carol, true); // follows you: never commented on
      resetStorage({ [K.targets]: all }); // dave: not checked yet
      await tg.patch("bob", { enabled: false });
      assert.deepEqual((await tg.activeTargets(settings)).map((t) => t.handle).sort(), ["alice"]);
      assert.equal(tg.isActive(null, settings), false);
      assert.equal(tg.isCold({ coldUntil: NOW + 1 }, NOW), true);
      assert.equal(tg.isCold({ coldUntil: NOW - 1 }, NOW), false);
      assert.equal(tg.isCold({ coldUntil: null }, NOW), false);
    });
  });
});
