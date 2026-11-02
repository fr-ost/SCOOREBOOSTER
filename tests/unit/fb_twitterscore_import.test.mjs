// Two features: (1) History > Follow-backs shows each account's TwitterScore, fetched through your TwitterScore API key
// (lib/scoreboard.js followBackScores) - only for accounts that followed you back and have none yet; (2) a CSV / JSON
// import with TwitterScores sets the tiers itself: 500 or more -> Tier 1, below 500 -> Tier 2 (no score -> Tier 2);
// a list of usernames keeps the tier you pick.
import { resetStorage, rawGet } from "./_chrome.mjs";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as S from "../../extension/lib/store.js";
import * as SB from "../../extension/lib/scoreboard.js";
import * as T from "../../extension/lib/targets.js";
import * as FB from "../../extension/lib/followbacks.js";
import { useMemoryDb } from "../../extension/lib/db.js";
import { K } from "../../extension/lib/constants.js";
import { _setClock, DAY } from "../../extension/lib/util.js";

const res = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) });
const FAST = { gapMs: 0 };
const NOW = Date.now(); // the real clock: provider pacing is shared by every test in one process

async function setup({ enabled = true, key = "ts-paid-key", checkOthers = false } = {}) {
  await S.saveSettings(S.sanitizeSettings({ scores: { checkOthers }, providers: { twitterscore: { enabled, mode: "auto" } } }));
  if (key) await S.setSecrets({ twitterscoreKey: key });
}
const entry = (handle, at, extra = {}) => ({ id: `${handle}:${at}`, handle, name: "", at, tier: 2, comments: 1, firstCommentAt: at - DAY, days: 1, youFollowedFirst: true, followers: 1000, score: 60, twitterscore: null, lastComment: null, unfollowedAt: null, ...extra });

describe("follow-backs: TwitterScore through your API key", () => {
  beforeEach(() => { resetStorage(); useMemoryDb(); globalThis.chrome.permissions = { contains: async () => true }; });
  afterEach(() => { delete globalThis.chrome.permissions; _setClock(null); });

  test("only follow-back accounts without a TwitterScore are asked, through the API; a target's known score is copied free", async () => {
    await setup();
    await S.save({
      [K.followbacks]: [entry("bandit", NOW - 1000), entry("meta", NOW - 2000), entry("known", NOW - 3000), entry("done", NOW - 4000, { twitterscore: 333 })],
      [K.targets]: { known: { handle: "known", score: { providers: { twitterscore: { score: 512.5, at: NOW - DAY } } } }, other: { handle: "other" } },
    });
    const asked = [];
    const fetchImpl = async (url) => { asked.push(url); return res(200, { twitter_score: url.includes("username=bandit") ? 741.3 : 220 }); };
    const r = await SB.followBackScores({ fetchImpl, ...FAST });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.fetched, r.copied, r.none], [2, 1, 0]);
    assert.equal(asked.length, 2, "2 API requests: bandit and meta (known was copied, done already had one, 'other' never followed back)");
    assert.ok(asked.every((u) => /\/api\/v1\/get_twitter_score\?username=(bandit|meta)&api_key=ts-paid-key/.test(u)), "the paid API, never the public page: " + asked.join(" "));
    const by = Object.fromEntries(rawGet(K.followbacks).map((e) => [e.handle, e]));
    assert.equal(by.bandit.twitterscore, 741.3);
    assert.equal(by.meta.twitterscore, 220);
    assert.equal(by.known.twitterscore, 512.5);
    assert.equal(by.done.twitterscore, 333);
    assert.equal((await SB.followBackScores({ fetchImpl, ...FAST })).fetched, 0, "nothing left to ask");
    assert.equal(asked.length, 2);
  });

  test("works with 'Check other accounts' off; an account TwitterScore has no data for is marked and asked again a week later", async () => {
    await setup({ checkOthers: false });
    await S.save({ [K.followbacks]: [entry("ghost", NOW - 1000)], [K.targets]: { ghost: { handle: "ghost" } } });
    let calls = 0;
    const fetchImpl = async () => { calls++; return res(404, { detail: "no data for this account" }); };
    const r = await SB.followBackScores({ fetchImpl, ...FAST });
    assert.equal(r.none, 1);
    const e = rawGet(K.followbacks)[0];
    assert.equal(e.twitterscore, null);
    assert.equal(e.twitterscoreNone, true);
    assert.equal((await S.getTargets()).ghost.score.providers.twitterscore.score, null, "remembered on the target too");
    await SB.followBackScores({ fetchImpl, ...FAST });
    assert.equal(calls, 1, "not asked again within the week");
    // A week later (the stored "asked at" moved back: the provider pacing keeps real time).
    await S.save({ [K.followbacks]: rawGet(K.followbacks).map((x) => ({ ...x, twitterscoreAt: NOW - 8 * DAY })) });
    await SB.followBackScores({ fetchImpl: async () => { calls++; return res(200, { twitter_score: 404 }); }, ...FAST });
    assert.equal(calls, 2);
    assert.equal(rawGet(K.followbacks)[0].twitterscore, 404);
    assert.equal(rawGet(K.followbacks)[0].twitterscoreNone, undefined);
  });

  test("no API key or TwitterScore off: nothing is asked and the page is told why; a bad key stops the run", async () => {
    await setup({ key: "" });
    await S.save({ [K.followbacks]: [entry("a", NOW - 1000), entry("b", NOW - 2000)] });
    let calls = 0;
    const fetchImpl = async () => { calls++; return res(401, {}); };
    let r = await SB.followBackScores({ fetchImpl, ...FAST });
    assert.equal(r.error, "no_key");
    assert.match(r.message, /API key/);
    await setup({ enabled: false });
    r = await SB.followBackScores({ fetchImpl, ...FAST });
    assert.equal(r.error, "disabled");
    assert.equal(calls, 0);
    await setup();
    r = await SB.followBackScores({ fetchImpl, ...FAST });
    assert.equal(calls, 1, "a refused key: the run stops at the first request");
    assert.equal(r.ok, false);
  });

  test("the page: rows pick up a target's TwitterScore; the needs list is one per account; backups keep the fields", async () => {
    const targets = { bob: { handle: "bob", rel: {}, score: { providers: { twitterscore: { score: 610 } } } } };
    const merged = FB.mergeEntries([entry("bob", NOW - 1000), entry("cara", NOW - 2000), entry("cara", NOW - 9 * DAY)], targets, []);
    assert.equal(merged.find((e) => e.handle === "bob").twitterscore, 610);
    assert.deepEqual(FB.followBackScoreNeeds(merged, NOW), ["cara"], "cara once, bob has one");
    assert.deepEqual(FB.followBackScoreNeeds([entry("x", NOW, { twitterscoreAt: NOW - DAY, twitterscoreNone: true })], NOW), [], "no data a day ago: not yet");
    await S.save({ [K.followbacks]: [] });
    await FB.importEntries([entry("ghost", NOW - 1000, { twitterscoreAt: NOW - 500, twitterscoreNone: true }), entry("seen", NOW - 2000, { twitterscore: 450, twitterscoreAt: NOW - 600 })]);
    const by = Object.fromEntries(rawGet(K.followbacks).map((e) => [e.handle, e]));
    assert.equal(by.ghost.twitterscoreNone, true);
    assert.equal(by.seen.twitterscore, 450);
    assert.equal(by.seen.twitterscoreNone, undefined);
  });
});

describe("import: tiers from TwitterScore (CSV / JSON)", () => {
  beforeEach(() => { resetStorage(); useMemoryDb(); });

  test("CSV with a TwitterScore column: 500 or more -> Tier 1, below -> Tier 2, no score -> Tier 2 (the picked tier is ignored)", async () => {
    const csv = "Username,TwitterScore,Date of scan,Smart follower of\nnaval,742.5,2026-10-30,\"bigvc, jsguy\"\n@smallfry,120,2026-10-30,bigvc\nexactly,500,,\nnoscore,,,";
    const rows = T.parseImport(csv);
    assert.equal(T.hasScores(rows), true);
    const tiered = T.autoTiers(rows);
    assert.deepEqual(tiered.map((r) => [r.handle, r.twitterscore ?? null, r.tier]), [["naval", 742.5, 1], ["smallfry", 120, 2], ["exactly", 500, 1], ["noscore", null, 2]]);
    const r = await T.upsert(tiered, { tier: 1, source: "import" });
    assert.deepEqual([r.added, r.updated], [4, 0]);
    const all = await S.getTargets();
    assert.deepEqual(["naval", "smallfry", "exactly", "noscore"].map((h) => all[h].tier), [1, 2, 1, 2], "picked Tier 1 did not apply");
    assert.equal(all.naval.score.providers.twitterscore.score, 742.5, "the score is kept on the target");
    assert.equal(all.noscore.score, null);
  });

  test("an existing target moves to the tier its new score gives; header-less 'handle,score' lines and JSON work too", async () => {
    await T.upsert([{ handle: "naval", tier: 2 }, { handle: "smallfry", tier: 1 }], { source: "manual" });
    const rows = T.autoTiers(T.parseImport("naval,812\nsmallfry,99.5"));
    const r = await T.upsert(rows, { tier: 2, source: "import" });
    assert.equal(r.updated, 2);
    let all = await S.getTargets();
    assert.deepEqual([all.naval.tier, all.smallfry.tier], [1, 2]);
    assert.equal(all.smallfry.score.providers.twitterscore.score, 99.5);
    const json = T.autoTiers(T.parseImport(JSON.stringify([{ username: "jsonbig", twitter_score: "1,000" }, { handle: "jsonsmall", score: 312 }, { handle: "jsonnone" }])));
    assert.deepEqual(json.map((x) => [x.handle, x.twitterscore ?? null, x.tier]), [["jsonbig", 1000, 1], ["jsonsmall", 312, 2], ["jsonnone", null, 2]]);
  });

  test("usernames only (pasted, a plain file, an old handle/tier CSV): no automatic tiers - the picked tier or the file's tier", async () => {
    for (const text of ["naval\nbalajis, paulg", "handle,tier\nfoo,1\nbar,2", "foo,1\nbar,2"]) {
      const rows = T.parseImport(text);
      assert.equal(T.hasScores(rows), false, text);
      assert.equal(T.autoTiers(rows), rows, "returned as they are");
    }
    await T.upsert(T.autoTiers(T.parseImport("naval\nbalajis")), { tier: 1, source: "import" });
    const all = await S.getTargets();
    assert.deepEqual([all.naval.tier, all.balajis.tier], [1, 1], "the picked tier applies to a list of usernames");
    assert.equal(T.tierForScore(499.99), 2);
    assert.equal(T.tierForScore(500), 1);
    assert.equal(T.importScore("abc"), null);
    assert.equal(T.importScore({ own: 3 }), null, "a ScoreX score object is not a TwitterScore");
  });
});

describe("targets: Clear all (one click, Undo) and Load TwitterScore (only on the button)", () => {
  beforeEach(() => { resetStorage(); useMemoryDb(); globalThis.chrome.permissions = { contains: async () => true }; });
  afterEach(() => { delete globalThis.chrome.permissions; });

  test("Clear all removes every target and keeps the follow-back record; Undo brings them back, a re-added one keeps its new entry", async () => {
    await T.upsert([{ handle: "a", tier: 1 }, { handle: "b" }, { handle: "c" }], { source: "manual" });
    await S.save({ [K.followbacks]: [entry("a", NOW - 1000)] });
    const r = await T.clearAll();
    assert.equal(r.removed, 3);
    assert.deepEqual(await S.getTargets(), {});
    assert.equal(rawGet(K.followbacks).length, 1, "follow-backs are kept");
    await T.upsert([{ handle: "b", tier: 1, notes: "added again" }], { source: "manual" });
    assert.equal(await T.restoreTargets(r.snapshot), 2);
    const all = await S.getTargets();
    assert.deepEqual(Object.keys(all).sort(), ["a", "b", "c"]);
    assert.equal(all.a.tier, 1, "restored as it was");
    assert.equal(all.b.notes, "added again", "the one added meanwhile keeps its new entry");
    assert.deepEqual(await T.clearAll().then((x) => x.removed), 3);
    assert.equal((await T.clearAll()).removed, 0, "nothing left");
  });

  test("Load TwitterScore: every target through the API, also with 'Check other accounts' off; a recent score is skipped; tiers unchanged", async () => {
    await setup({ checkOthers: false });
    await S.save({ [K.targets]: {
      big: { handle: "big", tier: 2 },
      small: { handle: "small", tier: 1 },
      recent: { handle: "recent", tier: 2, score: { providers: { twitterscore: { score: 300, max: 1000, at: NOW - DAY, from: "import" } } } },
      old: { handle: "old", tier: 2, score: { providers: { twitterscore: { score: 10, max: 1000, at: NOW - 9 * DAY } } } },
      ghost: { handle: "ghost", tier: 2 },
    } });
    const asked = [];
    const fetchImpl = async (url) => {
      asked.push(url);
      if (url.includes("username=ghost")) return res(404, { detail: "no data for this account" });
      return res(200, { twitter_score: url.includes("username=big") ? 812 : url.includes("username=old") ? 44 : 120 });
    };
    const r = await SB.loadTargetTwitterScores({ fetchImpl, ...FAST });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.updated, r.fresh, r.missing], [3, 1, 1]);
    assert.equal(asked.length, 4, "big, small, old and ghost (recent was skipped)");
    assert.ok(asked.every((u) => /\/api\/v1\/get_twitter_score\?username=\w+&api_key=ts-paid-key/.test(u)), "the paid API only");
    const all = await S.getTargets();
    assert.deepEqual([all.big.score.providers.twitterscore.score, all.small.score.providers.twitterscore.score, all.old.score.providers.twitterscore.score], [812, 120, 44]);
    assert.equal(all.recent.score.providers.twitterscore.score, 300, "kept");
    assert.equal(all.ghost.score.providers.twitterscore.score, null);
    assert.deepEqual([all.big.tier, all.small.tier], [2, 1], "tiers are not changed by loading scores");
    // The selection's "Fetch scores" (not this button) still follows the 'Check other accounts' switch.
    assert.equal((await SB.refreshTargetScores(["big"], "twitterscore", { fetchImpl, ...FAST })).error, SB.OTHERS_OFF);
  });

  test("Load TwitterScore needs TwitterScore on and your API key: otherwise nothing is asked", async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return res(200, { twitter_score: 1 }); };
    await S.save({ [K.targets]: { a: { handle: "a" } } });
    await setup({ key: "" });
    assert.match((await SB.loadTargetTwitterScores({ fetchImpl, ...FAST })).error, /API key/);
    await setup({ enabled: false });
    assert.match((await SB.loadTargetTwitterScores({ fetchImpl, ...FAST })).error, /Turn TwitterScore on/);
    assert.equal((await SB.twitterScoreApiReady()).ok, false);
    assert.equal(calls, 0);
  });
});
