// Engine & scheduling fixes (review round 1: ENG-1/FOL-2 scheduling, ENG-2..ENG-10, XP-8, GEN-5).
import { resetStorage } from "./_chrome.mjs";
import { install, mockOpenAI } from "./_engine_env.mjs";
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useMemoryDb } from "../../extension/lib/db.js";
import * as H from "../../extension/lib/history.js";
import * as engine from "../../extension/lib/engine.js";
import * as tabs from "../../extension/lib/tabs.js";
import { pageVerdict, accountVerified } from "../../extension/lib/guard.js";
import { getState, patchState, save, setSecrets, sanitizeSettings, getTargets } from "../../extension/lib/store.js";
import { K, HS, STOP, STATUS } from "../../extension/lib/constants.js";
import { newTarget, applyFollow, followStatus, FS } from "../../extension/lib/targets.js";
import { _setClock, MIN, HOUR, DAY } from "../../extension/lib/util.js";

const ME = "0x_nation";
const POST_ID = "1983000000000000001";
const baseSettings = {
  mode: "auto",
  account: { handle: ME, verifyAccount: true },
  watch: { strategy: "list", listUrls: ["https://x.com/i/lists/1234567890"], scrolls: 0, catchUp: { enabled: false } },
  safety: { activeHours: { enabled: false }, breaks: { enabled: false }, readDelaySec: { min: 1, max: 1 }, typingCpm: { min: 550, max: 600 } },
  learning: { enabled: false, conversations: { enabled: false } },
  review: { notifyNew: false },
};
const notFollowing = (h, o) => applyFollow(newTarget(h, o), false, Date.now() - DAY);
const navPaths = (env) => env.navigations.map(([, u]) => new URL(u).pathname);
async function until(fn, what, env, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await env.wait(2); }
  throw new Error("timeout waiting for " + what);
}

async function setup(env, { settings = {}, targets = {}, state = {} } = {}) {
  resetStorage();
  useMemoryDb();
  await save({ [K.settings]: { ...baseSettings, ...settings, safety: { ...baseSettings.safety, ...(settings.safety || {}) }, watch: { ...baseSettings.watch, ...(settings.watch || {}) } } });
  await setSecrets({ openaiKey: "sk-test-1234567890abcdef" });
  await save({ [K.targets]: targets });
  env.addTab({ id: 3, url: "https://x.com/home", pinned: true, index: 0 });
  await patchState({ status: STATUS.RUNNING, firstStartedAt: Date.now() - 20 * DAY, workerTabId: 3, workerTabPinned: true, workerTabIndex: 0, followBadgeOkAt: Date.now(), followersScanAt: Date.now(), ...state });
}

describe("engine fixes (review round 1)", () => {
  let env;
  before(() => { env = install(); });
  after(() => env.uninstall());
  beforeEach(() => {
    env.tabs.clear(); env.navigations.length = 0; env.commands.length = 0; env.reloads.length = 0; env.notifications.length = 0;
    env.content = null; env.loads = true; env.page = { state: "ok", detail: "", me: ME, hidden: false };
  });
  afterEach(async () => { _setClock(null); await engine.pause().catch(() => {}); });

  // ---------------- ENG-2 ----------------

  test("ENG-2: pageVerdict fails closed when the logged-in handle cannot be read", () => {
    const s = sanitizeSettings({ account: { handle: "0x_Nation", verifyAccount: true } });
    assert.deepEqual(pageVerdict({ state: "ok", me: null }, s).soft, "account_unknown");
    assert.equal(pageVerdict({ state: "unknown" }, s).soft, "unknown_page", "an unrecognised page state is never 'page OK'");
    assert.equal(pageVerdict({ state: "something_new", me: "0x_nation" }, s).soft, "unknown_page");
    assert.equal(pageVerdict({ state: "ok", me: "0x_nation" }, s), null, "readable right account: page OK");
    assert.equal(pageVerdict({ state: "ok", me: "0X_NATION" }, s), null, "handles compare case-insensitively");
    assert.equal(pageVerdict({ state: "ok", me: "other_acct" }, s).stop, STOP.WRONG_ACCOUNT);
    assert.equal(pageVerdict({ state: "loading", me: null }, s).soft, "loading");
    assert.equal(pageVerdict({ state: "not_found", me: null }, s).notFound, true);
    assert.equal(pageVerdict({ state: "captcha", me: null }, s).stop, STOP.CAPTCHA);
    assert.equal(pageVerdict({ state: "ok", me: null }, sanitizeSettings({ account: { handle: ME, verifyAccount: false } })), null, "verification off");
    assert.equal(pageVerdict({ state: "ok", me: null }, sanitizeSettings({ account: { handle: "", verifyAccount: true } })), null, "no handle set");
    assert.equal(accountVerified({ me: "0x_nation" }, s), true);
    assert.equal(accountVerified({ me: null }, s), false);
    assert.equal(accountVerified({ me: "other" }, s), false);
  });

  test("ENG-2: page loads without a readable account are counted once per load; a readable one resets the count", async () => {
    await setup(env);
    env.page.me = null;
    for (let i = 1; i <= 3; i++) {
      const nav = await tabs.navigate(3, `https://x.com/i/lists/${1000 + i}`);
      assert.ok(nav.ok);
      await tabs.waitForPage(3, ["tweet"]);
      await tabs.send(3, "scrapeTweets", {}); // a second report of the same page does not count again
      assert.equal((await getState()).accountUnknownStreak, i);
    }
    env.page.me = ME;
    await tabs.navigate(3, "https://x.com/i/lists/2000");
    await tabs.waitForPage(3, ["tweet"]);
    assert.equal((await getState()).accountUnknownStreak, 0);
  });

  test("ENG-2: the engine stops (needs a manual resume) after 3 page loads in a row without a readable account", async () => {
    await setup(env, { targets: { alice: notFollowing("alice") }, state: { accountUnknownStreak: 2, lastWatchAt: 0 } });
    env.page.me = null; // e.g. X's narrow layout keeps the profile link in a closed drawer
    env.content = async (msg) => (msg.sx === "waitFor" ? { ok: true, key: "tweet" } : msg.sx === "scrapeTweets" ? { ok: true, tweets: [], articleCount: 0 } : { ok: true });
    await engine.tick("alarm");
    const st = await getState();
    assert.equal(st.status, STATUS.STOPPED);
    assert.equal(st.stopReason, STOP.ACCOUNT_UNKNOWN);
    assert.ok(st.alert, "safety alert (red badge) is raised");
  });

  test("ENG-2: a readable handle keeps normal flows working (no stop, streak stays 0)", async () => {
    await setup(env, { targets: { alice: notFollowing("alice") }, state: { lastWatchAt: 0 } });
    env.content = async (msg) => (msg.sx === "waitFor" ? { ok: true, key: "tweet" } : msg.sx === "scrapeTweets" ? { ok: true, tweets: [], articleCount: 0 } : { ok: true });
    await engine.tick("alarm");
    const st = await getState();
    assert.equal(st.status, STATUS.RUNNING);
    assert.equal(st.accountUnknownStreak || 0, 0);
    assert.ok(st.lastWatchAt > 0, "the watch page was read");
  });

  // ---------------- ENG-3 / XP-8 ----------------

  describe("ENG-3 / XP-8: worker tab ids from an earlier browser session", () => {
    let senv;
    const lastUrl = "https://x.com/search?q=(from%3Aalice)%20-filter%3Areplies&f=live&src=typed_query";
    before(() => { env.uninstall(); senv = install({ session: true }); });
    after(() => { senv.uninstall(); env = install(); });
    beforeEach(() => { senv.tabs.clear(); senv.navigations.length = 0; senv.commands.length = 0; });

    test("a stored id that now belongs to the user's own tab is not reused; the restored ScoreX tab is adopted", async () => {
      resetStorage();
      await patchState({ status: STATUS.RUNNING, workerTabId: 7, workerTabPinned: true, workerTabIndex: 0, workerLastUrl: lastUrl });
      senv.addTab({ id: 3, url: lastUrl, pinned: true, index: 0 }); // restored ScoreX tab (new id after the restart)
      senv.addTab({ id: 7, url: "https://x.com/messages/123-456", pinned: false, index: 5, active: true }); // the user's own tab
      const id = await tabs.workerTab(sanitizeSettings({}));
      assert.equal(id, 3);
      assert.equal((await getState()).workerTabId, 3);
      assert.ok(!senv.commands.some((c) => c[2] === 7), "the user's tab was never messaged");
      assert.ok(!senv.navigations.some(([tid]) => tid === 7), "nor navigated");
      assert.equal(senv.sessionData.get(tabs._test.SESSION_KEY), 3, "the id is marked as this session's");
    });

    test("same session: the stored tab is reused even after it moved", async () => {
      resetStorage();
      await patchState({ workerTabId: 4, workerTabPinned: true, workerTabIndex: 0, workerLastUrl: lastUrl });
      senv.sessionData.set(tabs._test.SESSION_KEY, 4);
      senv.addTab({ id: 4, url: "https://x.com/alice", pinned: true, index: 2 });
      assert.equal(await tabs.workerTab(sanitizeSettings({})), 4);
    });

    test("after an extension reload (no session marker) our own tab is recognised by its last page and kept", async () => {
      resetStorage();
      senv.sessionData.clear();
      await patchState({ workerTabId: 5, workerTabPinned: true, workerTabIndex: 0, workerLastUrl: lastUrl });
      senv.addTab({ id: 5, url: lastUrl, pinned: true, index: 0 });
      assert.equal(await tabs.workerTab(sanitizeSettings({})), 5);
      assert.equal(senv.tabs.size, 1, "no second tab opened");
      assert.equal(senv.sessionData.get(tabs._test.SESSION_KEY), 5);
    });
  });

  // ---------------- ENG-4 ----------------

  test("ENG-4: a lease held by a running job survives its wall-clock expiry (system sleep): no watchdog clear, no second job", async () => {
    resetStorage();
    let t = Date.now();
    _setClock(() => t);
    await patchState({ status: STATUS.RUNNING, nextTickAt: t + 10 * MIN });
    const out = await engine.withLease("tick", async () => {
      const mine = (await getState()).job;
      t += 20 * MIN; // the computer slept 20 minutes in the middle of the job
      await engine.watchdog();
      const after = (await getState()).job;
      const second = await engine.withLease("discovery", async () => "ran");
      return { mine, after, second };
    });
    assert.equal(out.after && out.after.id, out.mine.id, "the watchdog left the live lease alone");
    assert.deepEqual(out.second, { ok: false, busy: true }, "discovery could not take the X tab mid-job");
    assert.equal((await getState()).job, null, "released at the end");
  });

  test("ENG-4: startup with overdue alarms: onWorkerStart + watchdog only clear the stale lease, never the new tick's", async () => {
    await setup(env, { targets: { alice: notFollowing("alice") } });
    const stale = { id: "jOLD", kind: "tick", startedAt: Date.now() - HOUR, leaseUntil: Date.now() - 50 * MIN };
    await patchState({ job: stale, nextTickAt: Date.now() - 50 * MIN });
    const samples = [];
    const p1 = engine.onWorkerStart();
    const p2 = engine.withLease("tick", async () => { for (let i = 0; i < 6; i++) { await env.wait(3); samples.push((await getState()).job); } return "done"; });
    const p3 = engine.watchdog();
    await Promise.all([p1, p3]);
    assert.equal(await p2, "done");
    assert.ok(samples.every((j) => j && j.id !== "jOLD" && j.kind === "tick"), "the tick kept its own lease the whole time: " + JSON.stringify(samples.map((j) => j && j.id)));
  });

  test("ENG-4: a dead worker's expired lease is still cleared / taken over", async () => {
    resetStorage();
    await patchState({ status: STATUS.RUNNING, job: { id: "jDEAD", kind: "tick", startedAt: Date.now() - HOUR, leaseUntil: Date.now() - 1000 }, nextTickAt: Date.now() + MIN });
    await engine.watchdog();
    assert.equal((await getState()).job, null);
    await patchState({ job: { id: "jDEAD2", kind: "tick", startedAt: Date.now() - HOUR, leaseUntil: Date.now() - 1000 } });
    assert.equal(await engine.withLease("discovery", async () => "ran"), "ran");
  });

  // ---------------- ENG-5 ----------------

  test("ENG-5: post-page retries do not feed the watch-error counter; one later error page is a soft error, not a rate-limit stop", async () => {
    await setup(env, { targets: { alice: notFollowing("alice") } });
    let errorPage = false;
    env.content = async (msg, tab) => {
      const status = /\/status\//.test(tab.url);
      const page = { ...env.page, state: errorPage && !status ? "error_page" : "ok", url: tab.url };
      if (msg.sx === "waitFor") return status ? { ok: false, settled: "loading", page } : { ok: true, key: msg.keys[0], page };
      if (msg.sx === "scrapeTweets") return { ok: true, tweets: [], articleCount: 0, page };
      return { ok: true, page };
    };
    const rec = await H.put(H.newRecord({ status: HS.QUEUED, target: "alice", group: "B", postId: POST_ID, postUrl: `https://x.com/alice/status/${POST_ID}`, comment: "Deferring company size is underrated for early funnels", attempts: 1, postCreatedAt: Date.now() - 5 * MIN, scheduledFor: 0 }));
    for (let i = 1; i <= 2; i++) {
      await patchState({ nextCommentAt: 0, lastCommentAt: 0, lastWatchAt: Date.now() });
      await H.patch(rec.id, { scheduledFor: 0 });
      await engine.tick("alarm");
      const r = await H.get(rec.id);
      assert.equal(r.status, HS.QUEUED, "item stays queued for a retry");
      assert.equal(r.retries, i);
      assert.equal((await getState()).softErrors || 0, 0, "retries are counted on the item only");
    }
    await H.patch(rec.id, { status: HS.SKIPPED });
    errorPage = true;
    await patchState({ lastWatchAt: 0 });
    await engine.tick("alarm");
    const st = await getState();
    assert.equal(st.status, STATUS.RUNNING, "a single 'Something went wrong' is not a safety stop");
    assert.equal(st.softErrors, 1);
  });

  test("ENG-5: tab failures have their own counter (3 in a row -> tab stop), reset when the tab works", async () => {
    await setup(env, { targets: { alice: notFollowing("alice") }, state: { softErrors: 2, workerTabId: null, workerTabPinned: false } });
    env.tabs.clear();
    let tick = 0;
    _setClock(() => Date.now() + (tick += 3000)); // waitReady gives up quickly on a tab that never loads
    env.loads = false;
    await engine.tick("alarm");
    let st = await getState();
    assert.equal(st.status, STATUS.RUNNING, "a tab failure does not add to the 2 earlier watch errors");
    assert.equal(st.tabErrors, 1);
    assert.equal(st.softErrors, 2);
    env.loads = true;
    for (const t of env.tabs.values()) { t.status = "complete"; }
    _setClock(null);
    await patchState({ lastWatchAt: Date.now() }); // no watch in this tick
    await engine.tick("alarm");
    st = await getState();
    assert.equal(st.tabErrors, 0, "reset once the tab answers");
  });

  // ---------------- ENG-6 ----------------

  test("ENG-6: Stop ends a running re-check for good; a later re-check runs (only) its own handles", async () => {
    const handles = Array.from({ length: 10 }, (_, i) => "acct" + i);
    await setup(env, { targets: Object.fromEntries([...handles, "zed"].map((h) => [h, newTarget(h)])), state: { status: STATUS.PAUSED } });
    env.content = async (msg, tab) => {
      await env.wait(2);
      const h = new URL(tab.url).pathname.split("/")[1];
      if (msg.sx === "waitFor") return { ok: true, key: msg.keys[0] };
      if (msg.sx === "scrapeProfile") return { ok: true, profile: { handle: h, name: h, followers: 5000, following: 300, followsYou: false, youFollow: false }, tweets: [] };
      return { ok: true };
    };
    const r1 = await engine.refreshTargetsNow(handles);
    assert.deepEqual([r1.ok, r1.queued, r1.when], [true, 10, "now"]);
    await until(() => navPaths(env).filter((p) => /acct/.test(p)).length >= 2, "2 visits", env);
    await engine.stop();
    const r2 = await engine.refreshTargetsNow(["zed"]);
    assert.ok(r2.ok);
    await until(async () => !engine._test.refreshJob && navPaths(env).includes("/zed"), "re-check of zed", env, 5000);
    await env.wait(30);
    const visited = navPaths(env);
    assert.ok(visited.filter((p) => /acct/.test(p)).length < 6, "the stopped job did not go on: " + visited.join(","));
    assert.ok(visited.includes("/zed"), "the new request ran");
    assert.equal((await getState()).status, STATUS.STOPPED);
  });

  test("ENG-6: a re-check requested while one runs is added to it (not silently dropped); more than 25 wait for the engine", async () => {
    await setup(env, { targets: Object.fromEntries(["a", "b", "c"].map((h) => [h, newTarget(h)])), state: { status: STATUS.STOPPED } });
    env.content = async (msg, tab) => {
      await env.wait(2);
      const h = new URL(tab.url).pathname.split("/")[1];
      if (msg.sx === "scrapeProfile") return { ok: true, profile: { handle: h, name: h, followsYou: false }, tweets: [] };
      return msg.sx === "waitFor" ? { ok: true, key: msg.keys[0] } : { ok: true };
    };
    await engine.refreshTargetsNow(["a", "b"]);
    await engine.refreshTargetsNow(["c"]);
    await until(async () => !engine._test.refreshJob, "job end", env, 5000);
    assert.deepEqual(navPaths(env).sort(), ["/a", "/b", "/c"]);
    const many = Array.from({ length: 30 }, (_, i) => "m" + i);
    const r = await engine.refreshTargetsNow(many);
    assert.equal(r.when, "25 now, the rest while running");
    assert.deepEqual((await getState()).pendingRefresh, many.slice(25));
    await engine.pause();
    await until(async () => !engine._test.refreshJob, "job end", env, 5000);
  });

  test("ENG-6: after a safety stop a re-check only queues (nothing drives the X tab until you resume)", async () => {
    await setup(env, { targets: { a: newTarget("a") }, state: { status: STATUS.STOPPED, stopReason: STOP.CAPTCHA, alert: { reason: STOP.CAPTCHA } } });
    const r = await engine.refreshTargetsNow(["a"]);
    assert.equal(r.ok, true);
    assert.match(r.when, /after you resume/);
    await env.wait(20);
    assert.equal(env.navigations.length, 0);
    assert.equal(engine._test.refreshJob, null);
    assert.deepEqual((await getState()).pendingRefresh, ["a"]);
  });

  // ---------------- ENG-8 ----------------

  test("ENG-8: an X tab that does not load is reused (reloaded) on the next check instead of opening another pinned tab", async () => {
    resetStorage();
    await patchState({ status: STATUS.RUNNING });
    env.loads = false; // offline / X down: nothing ever answers
    let t = Date.now();
    _setClock(() => (t += 2000));
    for (let i = 0; i < 3; i++) assert.equal(await tabs.workerTab(sanitizeSettings({})), null);
    assert.equal(env.tabs.size, 1, "one tab, not one per check");
    const [only] = [...env.tabs.keys()];
    assert.equal((await getState()).workerTabId, only, "still remembered");
    assert.ok(env.reloads.filter((id) => id === only).length >= 2, "reloaded on the later checks");
  });

  // ---------------- ENG-9 ----------------

  test("ENG-9: approving while a tick runs gets a quick re-run instead of being overwritten by the tick's schedule", async () => {
    await setup(env, { settings: { mode: "review" }, targets: { alice: notFollowing("alice") }, state: { lastWatchAt: 0 } });
    let release, entered;
    const gate = new Promise((r) => (release = r));
    const inWatch = new Promise((r) => (entered = r));
    env.content = async (msg) => {
      if (msg.sx === "waitFor") { entered(); await gate; return { ok: true, key: "tweet" }; }
      if (msg.sx === "scrapeTweets") return { ok: true, tweets: [], articleCount: 0 };
      return { ok: true };
    };
    const rec = await H.put(H.newRecord({ status: HS.PENDING_REVIEW, target: "alice", group: "B", postId: POST_ID, postUrl: `https://x.com/alice/status/${POST_ID}`, comment: "Asking for company size later is the right call", attempts: 1, postCreatedAt: Date.now() - 5 * MIN }));
    const running = engine.tick("alarm");
    await inWatch;
    const r = await engine.reviewAction({ id: rec.id, action: "approve" });
    assert.ok(r.ok);
    release();
    await running;
    const st = await getState();
    assert.equal(st.nextTickWhy, "manual", "the approval's re-run was kept");
    assert.ok(st.nextTickAt - Date.now() < 10000, "and it comes within seconds");
  });

  // ---------------- ENG-10 ----------------

  test("ENG-10: a queued reply for a post without a time expires like every other queued reply", async () => {
    await setup(env);
    const settings = sanitizeSettings(baseSettings);
    const old = await H.put(H.newRecord({ status: HS.QUEUED, target: "alice", postId: "1", postCreatedAt: null, comment: "x", createdAt: Date.now() - (settings.watch.maxPostAgeMin + 30) * MIN }));
    const fresh = await H.put(H.newRecord({ status: HS.QUEUED, target: "alice", postId: "2", postCreatedAt: null, comment: "y" }));
    await save({ [K.targets]: { alice: notFollowing("alice") } });
    await engine._test.expireQueue(settings, Date.now());
    assert.equal((await H.get(old.id)).status, HS.SKIPPED);
    assert.match((await H.get(old.id)).reason, /Too late/);
    assert.equal((await H.get(fresh.id)).status, HS.QUEUED);
  });

  test("ENG-10: posts without a time are skipped and never generated for", async () => {
    await setup(env, { targets: { alice: notFollowing("alice") } });
    const calls = mockOpenAI();
    const settings = sanitizeSettings(baseSettings);
    const post = { id: POST_ID, url: `https://x.com/alice/status/${POST_ID}`, author: "alice", text: "We cut our signup form from 9 fields to 3 and conversion jumped a lot.", lang: "en", createdAt: null };
    const counts = await engine.computeCounts(settings);
    await engine._test.handleFresh([post], { settings, secrets: { openaiKey: "sk-test" }, mode: "auto", counts, tabId: null, me: ME });
    const recs = await H.byPostId(POST_ID);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].status, HS.SKIPPED);
    assert.match(recs[0].reason, /time unknown/i);
    assert.equal(calls.length, 0, "no OpenAI call");
  });

  // ---------------- GEN-5 ----------------

  test("GEN-5: recent comments are newest first across the queue and posted replies", async () => {
    await setup(env);
    const t0 = Date.now();
    await H.put(H.newRecord({ status: HS.POSTED, target: "a", comment: "posted 1h ago", createdAt: t0 - 2 * HOUR, postedAt: t0 - HOUR }));
    await H.put(H.newRecord({ status: HS.POSTED, target: "b", comment: "posted 5m ago", createdAt: t0 - HOUR, postedAt: t0 - 5 * MIN }));
    const o1 = await H.put(H.newRecord({ status: HS.PENDING_REVIEW, target: "c", comment: "queued 3h ago", createdAt: t0 - 3 * HOUR }));
    await H.put(H.newRecord({ status: HS.QUEUED, target: "d", comment: "queued 2m ago", createdAt: t0 - 2 * MIN }));
    assert.deepEqual(await engine.recentComments(), ["queued 2m ago", "posted 5m ago", "posted 1h ago", "queued 3h ago"]);
    assert.deepEqual(await engine.recentComments(o1.id), ["queued 2m ago", "posted 5m ago", "posted 1h ago"]);
  });

  test("GEN-5: with a long review backlog the model still sees your newest posted reply first", async () => {
    await setup(env, { settings: { mode: "review" }, targets: { alice: notFollowing("alice") } });
    const t0 = Date.now();
    for (let i = 0; i < 16; i++) await H.put(H.newRecord({ status: HS.PENDING_REVIEW, target: "q" + i, comment: `old pending reply number ${i}`, createdAt: t0 - (5 * HOUR - i * MIN) }));
    await H.put(H.newRecord({ status: HS.POSTED, target: "z", comment: "Most people miss that blobs only help rollups that post data often", createdAt: t0 - HOUR, postedAt: t0 - 10 * MIN }));
    const calls = mockOpenAI("Wallet UX decides whether cheap fees matter at all for new users");
    const settings = sanitizeSettings({ ...baseSettings, mode: "review" });
    const post = { id: POST_ID, url: `https://x.com/alice/status/${POST_ID}`, author: "alice", text: "Fees dropped 90% after the upgrade but usage barely moved. Thoughts?", lang: "en", createdAt: t0 - 5 * MIN };
    const r = await engine.generateFor(post, (await getTargets()).alice, { settings, secrets: { openaiKey: "sk-test" }, mode: "review", tabId: null, me: ME });
    assert.equal(r, "ok");
    const text = (b) => (b.input && b.input[0] && b.input[0].content && b.input[0].content[0].text) || "";
    const gen = calls.find((b) => /owner_recent_replies_to_avoid/.test(text(b)));
    const data = JSON.parse(text(gen).match(/<<<DATA\n([\s\S]*?)\nDATA>>>/)[1]);
    assert.equal(data.owner_recent_replies_to_avoid[0], "Most people miss that blobs only help rollups that post data often");
  });

  // ---------------- ENG-1 / FOL-2 (scheduling half) ----------------

  function followEnv(users) {
    env.content = async (msg, tab) => {
      const h = new URL(tab.url).pathname.split("/")[1];
      if (msg.sx === "waitFor") return { ok: true, key: (msg.keys || [])[0] };
      if (msg.sx === "scrapeUsers") return { ok: true, users };
      if (msg.sx === "scrapeProfile") return { ok: true, profile: { handle: h, name: h, followers: 5000, following: 300, followsYou: false, youFollow: false }, tweets: [] };
      return { ok: true };
    };
  }

  test("ENG-1/FOL-2: queued re-checks never go before the followers-list check while the 'Follows you' badge is unverified", async () => {
    await setup(env, {
      targets: { alice: newTarget("alice"), bob: newTarget("bob"), carol: notFollowing("carol") },
      state: { pendingRefresh: ["alice", "bob"], followBadgeOkAt: null, followersScanAt: null },
    });
    followEnv([{ handle: "u1", followsYou: true }, { handle: "u2", followsYou: true }, { handle: "u3", followsYou: false }]);
    const settings = sanitizeSettings(baseSettings);
    const r = await engine._test.backgroundStep({ tabId: 3, settings, me: ME });
    assert.equal(navPaths(env)[0], `/${ME}/followers`, "the badge canary ran first: " + navPaths(env).join(","));
    assert.equal(r.did, "follow");
    assert.ok((await getState()).followBadgeOkAt, "badge verified");
  });

  test("ENG-1/FOL-2: with a verified badge, queued re-checks and follow tracking take turns", async () => {
    const t0 = Date.now();
    const n1 = newTarget("newbie"); n1.addedAt = t0 - 2 * HOUR; // checking, needs its profile check
    const pend = ["r1", "r2", "r3", "r4", "r5", "r6"];
    await setup(env, {
      targets: { newbie: n1, ...Object.fromEntries(pend.map((h) => [h, notFollowing(h)])) },
      state: { pendingRefresh: pend, followBadgeOkAt: t0 - MIN, followersScanAt: t0 - MIN },
    });
    followEnv([{ handle: "u1", followsYou: true }]);
    const settings = sanitizeSettings(baseSettings);
    const kinds = [];
    for (let i = 0; i < 3; i++) kinds.push((await engine._test.backgroundStep({ tabId: 3, settings, me: ME })).did);
    assert.deepEqual(kinds, ["refresh", "follow", "refresh"]);
    assert.deepEqual(navPaths(env), ["/r1", "/r2", "/r3", "/r4", "/newbie", "/r5", "/r6"]);
    assert.equal(followStatus((await getTargets()).newbie), FS.ACTIVE);
    assert.deepEqual((await getState()).pendingRefresh, []);
  });
});
