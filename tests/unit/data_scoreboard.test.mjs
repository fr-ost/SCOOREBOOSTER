// Task D regression + feature tests for lib/scoreboard.js (usage caps, failing providers, target-score cache and
// combined rank, smart-follower sweeps into the capped candidates).
import { resetStorage, rawGet } from "./_chrome.mjs";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as S from "../../extension/lib/store.js";
import * as SB from "../../extension/lib/scoreboard.js";
import { useMemoryDb } from "../../extension/lib/db.js";
import { K } from "../../extension/lib/constants.js";
import { combinedScore } from "../../extension/lib/scores.js";
import { _setClock, DAY } from "../../extension/lib/util.js";

const res = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) });
const FAST = { gapMs: 0 };

async function setup(providers, secrets = {}) {
  await S.saveSettings(S.sanitizeSettings({ providers }));
  if (Object.keys(secrets).length) await S.setSecrets(secrets);
}

describe("data: scoreboard", () => {
  beforeEach(() => { resetStorage(); useMemoryDb(); globalThis.chrome.permissions = { contains: async () => true }; });
  afterEach(() => { delete globalThis.chrome.permissions; _setClock(null); });

  test("a daily cap of 1 lets exactly one of two simultaneous requests through", async () => {
    await setup({ ethos: { enabled: true, dailyCap: 1 } });
    let calls = 0;
    const fetchImpl = async () => { calls++; return res(200, { score: 1500, profileId: 7 }); };
    const [a, b] = await Promise.all([SB.checkScores("alice", { fetchImpl, ...FAST }), SB.checkScores("bob", { fetchImpl, ...FAST })]);
    assert.equal(calls, 1);
    assert.equal(rawGet(K.scoreboard).usage.ethos.n, 1);
    const errors = [a.results.ethos.error, b.results.ethos.error].filter(Boolean);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /cap/);
  });

  test("a score check of an account that is one of your targets also stores the score on the target", async () => {
    await setup({ ethos: { enabled: true, dailyCap: 50 } });
    await S.save({ [K.targets]: { alice: { handle: "alice", score: { own: 40 } } } });
    const fetchImpl = async () => res(200, { score: 1500, profileId: 7 });
    const r = await SB.checkScores("alice", { fetchImpl, ...FAST });
    assert.equal(r.ok, true);
    const t = rawGet(K.targets).alice;
    assert.equal(t.score.providers.ethos.score, r.results.ethos.score);
    assert.ok(t.score.providers.ethos.at > 0);
    assert.equal(t.score.own, 40, "other score fields are kept");
    // Not a target: nothing is created.
    await SB.checkScores("bob", { fetchImpl, ...FAST });
    assert.equal(Object.hasOwn(rawGet(K.targets), "bob"), false);
    // A failed check leaves the stored score alone.
    await SB.checkScores("alice", { fetchImpl: async () => res(500, {}), ...FAST });
    assert.equal(rawGet(K.targets).alice.score.providers.ethos.score, r.results.ethos.score);
  });

  test("target scores: a provider that keeps failing is asked 3 times, not once per target, and the run reports an error", async () => {
    await setup({ ethos: { enabled: true, dailyCap: 5000 } });
    const tg = {}; for (let i = 0; i < 12; i++) tg["t" + i] = { handle: "t" + i, score: null };
    await S.save({ [K.targets]: tg });
    let calls = 0;
    const r = await SB.refreshTargetScores([], "ethos", { fetchImpl: async () => { calls++; return res(500, {}); }, ...FAST });
    assert.equal(calls, 3);
    assert.equal(r.ok, false);
    assert.match(r.error, /3 failures in a row/);
    calls = 0;
    const r2 = await SB.refreshTargetScores([], "ethos", { fetchImpl: async () => { calls++; return res(401, {}); }, ...FAST });
    assert.equal(calls, 1, "a rejected key stops at once");
    assert.equal(r2.ok, false);
  });

  test("target scores: combined rank recomputed, Sorsa column kept, cached for 7 days", async () => {
    let t = Date.UTC(2026, 9, 1, 12);
    _setClock(() => t);
    await setup({ sorsa: { enabled: true } }, { sorsaKey: "sorsa-key-1" });
    await S.save({ [K.targets]: { delta: { handle: "delta", score: { own: 40, sorsa: null, combined: 40 } }, eps: { handle: "eps", score: null } } });
    let calls = 0;
    const fetchImpl = async (url) => { calls++; return res(200, { score: url.includes("delta") ? 444 : 1200 }); };
    const r = await SB.refreshTargetScores(["delta", "eps"], "sorsa", { fetchImpl, ...FAST });
    assert.deepEqual({ ok: r.ok, updated: r.updated }, { ok: true, updated: 2 });
    let all = rawGet(K.targets);
    assert.equal(all.delta.score.providers.sorsa.score, 444);
    assert.equal(all.delta.score.sorsa, 444);
    assert.equal(all.delta.score.combined, combinedScore(40, 444, 0.5), "was left at the old 40 before");
    assert.equal(all.eps.score.combined, combinedScore(null, 1200, 0.5));
    t += 6 * DAY;
    await SB.refreshTargetScores(["delta", "eps"], "sorsa", { fetchImpl, ...FAST });
    assert.equal(calls, 2, "within 7 days nothing is asked again");
    t += 2 * DAY;
    await SB.refreshTargetScores(["delta"], "sorsa", { fetchImpl, ...FAST });
    assert.equal(calls, 3, "after 7 days it is");
    assert.equal(SB.TARGET_SCORE_MAX_AGE, 7 * DAY);
  });

  test("target scores: an account the provider does not know is remembered (not asked every run); a real score is never replaced by 'none'", async () => {
    await setup({ ethos: { enabled: true } });
    await S.save({ [K.targets]: { nobody: { handle: "nobody", score: null }, known: { handle: "known", score: { providers: { ethos: { score: 1300, max: 2800, at: 1 } } } } } });
    let calls = 0;
    const fetchImpl = async () => { calls++; return res(200, { score: 1200, profileId: null }); }; // Ethos default for unknown accounts
    const r = await SB.refreshTargetScores([], "ethos", { fetchImpl, ...FAST });
    assert.equal(r.ok, true);
    assert.equal(r.updated, 0);
    const all = rawGet(K.targets);
    assert.equal(all.nobody.score.providers.ethos.score, null);
    assert.ok(all.nobody.score.providers.ethos.at);
    assert.equal(all.known.score.providers.ethos.score, 1300);
    await SB.refreshTargetScores(["nobody"], "ethos", { fetchImpl, ...FAST });
    assert.equal(calls, 2, "the remembered miss is not asked again");
  });

  test("own scores: a cached result carries max and the page link too", async () => {
    await setup({ ethos: { enabled: true } });
    const fetchImpl = async () => res(200, { score: 1460, profileId: 77 });
    await SB.refreshOwn({ force: true, fetchImpl, ...FAST });
    const r = await SB.refreshOwn({ fetchImpl, ...FAST });
    assert.equal(r.results.ethos.cached, true);
    assert.equal(r.results.ethos.max, 2800);
    assert.match(r.results.ethos.url, /ethos/);
  });

  test("smart followers: asking one provider keeps the other providers' cached lists", async () => {
    await setup({ sorsa: { enabled: true }, moni: { enabled: true } }, { sorsaKey: "sorsa-key-1", moniKey: "moni-key-1" });
    const fetchImpl = async (url) => (url.includes("sorsa") ? res(200, { users: [{ username: "alpha", score: 10 }] }) : res(200, { items: [{ meta: { userUrl: "https://x.com/beta" } }], totalCount: 1 }));
    await SB.smartFollowersOf("bigvc", { fetchImpl, ...FAST });
    await SB.smartFollowersOf("bigvc", { providers: ["sorsa"], maxAgeMs: 0, fetchImpl, ...FAST });
    const cached = rawGet(K.scoreboard).smart.bigvc.results;
    assert.ok(cached.sorsa && cached.moni, JSON.stringify(Object.keys(cached)));
  });

  test("sweeps: candidates stay at the newest 2,000, repeat finds count as recent, targets added meanwhile are skipped", async () => {
    await setup({ sorsa: { enabled: true } }, { sorsaKey: "sorsa-key-1" });
    const old = {};
    for (let i = 0; i < 1999; i++) old["old" + i] = { handle: "old" + i, foundAt: 1000 + i, overlap: 1 };
    old.again = { handle: "again", foundAt: 1, overlap: 1 };
    await S.save({ [K.candidates]: old });
    const fetchImpl = async () => {
      // Someone adds "late" as a target while the search runs.
      const tg = rawGet(K.targets) || {};
      if (!tg.late) await S.save({ [K.targets]: { ...tg, late: { handle: "late" } } });
      return res(200, { users: [{ username: "new1", score: 900 }, { username: "new2", score: 800 }, { username: "again", score: 5 }, { username: "late", score: 1 }] });
    };
    const r = await SB.sweepSmartFollowers(["bigvc"], { fetchImpl, ...FAST });
    assert.equal(r.ok, true);
    const c = rawGet(K.candidates);
    assert.equal(Object.keys(c).length, 2000);
    assert.ok(c.new1 && c.new2 && c.again, "the new finds and the repeat find are kept");
    assert.ok(c.again.seenAt > 1000 && c.again.foundAt === 1);
    assert.equal(c.late, undefined, "added as a target during the search");
    assert.equal(c.old0, undefined);
    assert.equal(c.old1, undefined);
  });

  test("sweeps: nothing found and every request failed is an error, not 'done'", async () => {
    await setup({ sorsa: { enabled: true } }, { sorsaKey: "sorsa-key-1" });
    const r = await SB.sweepSmartFollowers(["bigvc"], { fetchImpl: async () => res(500, {}), ...FAST });
    assert.equal(r.ok, false);
    assert.match(r.error, /HTTP 500/);
  });
});
