// Engine fixes from review round 2: ENG2-1 .. ENG2-7, the backend side of UIF-1 / UIF-4 (safety stops) and UIV-8.
import { resetStorage } from "./_chrome.mjs";
import { install, mockOpenAI } from "./_engine_env.mjs";
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useMemoryDb } from "../../extension/lib/db.js";
import * as H from "../../extension/lib/history.js";
import * as engine from "../../extension/lib/engine.js";
import * as safety from "../../extension/lib/safety.js";
import { runSelfTest } from "../../extension/lib/diagnostics.js";
import { getState, patchState, save, load, setSecrets, sanitizeSettings, getTargets } from "../../extension/lib/store.js";
import { K, HS, STOP, STATUS, HARD } from "../../extension/lib/constants.js";
import { newTarget, applyFollow, followStatus, FS } from "../../extension/lib/targets.js";
import { MIN, HOUR, DAY } from "../../extension/lib/util.js";

const ME = "0x_nation";
const LIST = "https://x.com/i/lists/1234567890";
const baseSettings = {
  mode: "auto",
  account: { handle: ME, verifyAccount: true },
  watch: { strategy: "list", listUrls: [LIST], scrolls: 0, catchUp: { enabled: false } },
  safety: { activeHours: { enabled: false }, breaks: { enabled: false } },
  learning: { enabled: false, conversations: { enabled: false } },
  review: { notifyNew: false },
};
const notFollowing = (h, o) => applyFollow(newTarget(h, o), false, Date.now() - DAY);

async function setup(env, { settings = {}, targets = {}, state = {} } = {}) {
  resetStorage();
  useMemoryDb();
  await save({ [K.settings]: { ...baseSettings, ...settings, watch: { ...baseSettings.watch, ...(settings.watch || {}) } }, [K.targets]: targets });
  await setSecrets({ openaiKey: "sk-test-1234567890abcdef" });
  env.addTab({ id: 3, url: "https://x.com/home", pinned: true, index: 0 });
  await patchState({ status: STATUS.RUNNING, firstStartedAt: Date.now() - 20 * DAY, startedAt: Date.now() - HOUR, workerTabId: 3, workerTabPinned: true, workerTabIndex: 0, followBadgeOkAt: Date.now(), followersScanAt: Date.now(), ...state });
}

describe("engine fixes (review round 2)", () => {
  let env;
  // The service worker (sw.js) registers its Chrome listeners on import: stub the events once and talk to its message
  // listener the way a dashboard page does.
  const sw = { listeners: null, saved: null };
  async function swAsk(msg) {
    if (!sw.listeners) {
      sw.listeners = {};
      const ev = (name) => ({ addListener: (fn) => { sw.listeners[name] = fn; }, removeListener() {}, hasListener: () => true });
      const r = chrome.runtime;
      sw.saved = { onInstalled: r.onInstalled, onStartup: r.onStartup, onMessage: r.onMessage, openOptionsPage: r.openOptionsPage };
      Object.assign(r, { onInstalled: ev("installed"), onStartup: ev("startup"), onMessage: ev("message"), openOptionsPage: async () => {} });
      chrome.alarms.onAlarm = ev("alarm"); chrome.tabs.onRemoved = ev("removed"); chrome.notifications.onClicked = ev("clicked");
      await import("../../extension/background/sw.js");
      await env.wait(50); // its start-up work (worker start, alarms) settles
    }
    return new Promise((resolve) => {
      const keep = sw.listeners.message(msg, { id: chrome.runtime.id, url: "chrome-extension://test-extension/ui/dashboard.html" }, resolve);
      if (keep !== true) resolve(undefined);
    });
  }
  const discoveryIdle = async () => { for (let i = 0; i < 400 && ["running", "waiting", "cancelling", "queued"].includes((await load(K.discovery, {})).status); i++) await env.wait(10); };

  before(() => { env = install(); });
  after(() => {
    env.uninstall();
    if (sw.saved) Object.assign(chrome.runtime, sw.saved);
  });
  beforeEach(() => {
    env.tabs.clear(); env.navigations.length = 0; env.commands.length = 0; env.notifications.length = 0;
    env.content = null; env.loads = true; env.page = { state: "ok", detail: "", me: ME, hidden: false };
  });
  afterEach(async () => { await engine.pause().catch(() => {}); await discoveryIdle(); });

  // ---------------- ENG2-1 ----------------

  test("ENG2-1: follow-back tracking still runs when the watch check sees a post about to enter the comment window", async () => {
    const handles = ["alice", "bob", "carol", "dave", "erin", "frank"];
    const targets = Object.fromEntries(handles.map((h) => [h, notFollowing(h, { tier: 2 })]));
    for (const t of Object.values(targets)) { t.stats.comments = 2; t.stats.firstCommentAt = Date.now() - 3 * DAY; t.rel.checkedAt = Date.now() - HOUR; }
    // The 2-hourly scan of your newest followers is 3 h overdue.
    await setup(env, { targets, state: { followBadgeOkAt: Date.now() - HOUR, followersScanAt: Date.now() - 3 * HOUR, lastWatchAt: 0 } });
    env.content = async (msg, tab) => {
      if (msg.sx === "waitFor") return { ok: true, key: /followers/.test(tab.url) ? "userCell" : "tweet" };
      // A busy list: a post 40 s old (it enters the 2-minute window soon).
      if (msg.sx === "scrapeTweets") return { ok: true, articleCount: 1, tweets: [{ id: "1983000000000000777", url: "https://x.com/bob/status/1983000000000000777", author: "bob", authorName: "Bob", text: "A new post that is a few seconds old", lang: "en", createdAt: Date.now() - 40 * 1000, metrics: {} }] };
      if (msg.sx === "scrapeUsers") return { ok: true, users: [{ handle: "alice", followsYou: true, badge: true }, { handle: "zed", followsYou: true, badge: true }] };
      return { ok: true };
    };
    await engine.tick("alarm");
    const st = await getState();
    assert.equal(st.status, STATUS.RUNNING);
    assert.ok(env.navigations.some(([, u]) => u === `https://x.com/${ME}/followers`), `the overdue followers list was not read (next tick: ${st.nextTickWhy})`);
    assert.equal(followStatus((await getTargets()).alice), FS.FOLLOWED_BACK, "alice's follow-back is found: no more comments to her");
    assert.ok(st.nextTickAt - Date.now() <= 151 * 1000, "the post entering the window is still revisited soon (90 s minimum + jitter)");
  });

  // ---------------- ENG2-2 / UIF-4 and UIF-1 (safety stops) ----------------

  test("ENG2-2 / UIF-4: no discovery drives the X tab during a safety stop; after a stop by you it runs", async () => {
    await setup(env, { targets: { alice: notFollowing("alice") }, state: { status: STATUS.STOPPED } });
    await engine.stop(STOP.WARNING, "X warning: unusual or automated activity");
    env.content = async (msg) => (msg.sx === "waitFor" ? { ok: true, key: "userCell" } : msg.sx === "scrapeUsers" ? { ok: true, users: [] } : { ok: true });
    env.navigations.length = 0;
    const r = await swAsk({ sx: "discoveryStart", source: "search", query: "defi builders", maxUsers: 20 });
    assert.equal(r && r.ok, false, "refused");
    assert.match(r.error, /safety check/);
    await env.wait(100);
    assert.deepEqual(env.navigations.map(([, u]) => u), [], "no X page loaded during the safety stop");
    assert.notEqual((await load(K.discovery, {})).status, "waiting", "no discovery job was queued");
    // Control: stopped by you (no safety check) -> the discovery runs.
    await engine.stop(STOP.USER);
    const ok = await swAsk({ sx: "discoveryStart", source: "search", query: "defi builders", maxUsers: 20 });
    assert.equal(ok && ok.ok, true);
    await discoveryIdle();
    assert.ok(env.navigations.some(([, u]) => /\/search\?q=defi%20builders&f=user/.test(u)), "the people search was read");
  });

  test("UIF-1: Start does not end a safety stop (only the reviewed resume does); a Start after a stop by you works", async () => {
    await setup(env, { targets: { alice: notFollowing("alice") }, state: { status: STATUS.STOPPED } });
    await engine.stop(STOP.CAPTCHA, "Captcha shown");
    let r = await engine.start();
    assert.equal(r.ok, false);
    assert.equal(r.error, "ScoreX was stopped by a safety check: open Review stop... and confirm you checked your account first");
    r = await swAsk({ sx: "start", reviewed: true }); // a message cannot claim the review
    assert.equal(r && r.ok, false);
    let st = await getState();
    assert.equal(st.status, STATUS.STOPPED);
    assert.equal(st.stopReason, STOP.CAPTCHA);
    assert.ok(st.alert, "the alert (red badge) stays");
    r = await swAsk({ sx: "resume" }); // the dashboard's Review stop dialog
    assert.equal(r && r.ok, true);
    st = await getState();
    assert.equal(st.status, STATUS.RUNNING);
    assert.equal(st.alert, null);
    assert.equal(st.stopReason, null);
    await engine.stop(STOP.USER);
    assert.equal((await engine.start()).ok, true, "a fresh Start (not stopped by a safety check) works");
    assert.equal((await getState()).status, STATUS.RUNNING);
  });

  // ---------------- ENG2-3 ----------------

  test("ENG2-3: a failed watch load counts as a watch page load: a check right after it waits out the 90 s minimum", async () => {
    await setup(env, { targets: { alice: notFollowing("alice") }, state: { lastWatchAt: Date.now() - 10 * MIN } });
    env.page = { state: "error_page", detail: "Something went wrong. Try reloading.", me: ME, hidden: false };
    env.content = async (msg) => (msg.sx === "waitFor" ? { ok: true, key: "tweet" } : msg.sx === "scrapeTweets" ? { ok: true, tweets: [], articleCount: 0 } : { ok: true });
    const watchLoads = () => env.navigations.filter(([, u]) => u === LIST).length;
    await engine.tick("alarm");
    assert.equal(watchLoads(), 1);
    assert.equal((await getState()).softErrors, 1);
    await engine.tick("manual"); // "Run a check now" a moment later
    assert.equal(watchLoads(), 1, "the watch page is not loaded again within seconds of the failed load");
    const st = await getState();
    assert.equal(st.nextTickWhy, "manual", "the manual check waits instead of being dropped");
    assert.ok(st.nextTickAt - Date.now() > (HARD.minCheckIntervalSec - 30) * 1000, "it runs once the hard minimum interval has passed");
  });

  // ---------------- ENG2-4 ----------------

  test("ENG2-4: only 'Something went wrong' three times in a row is a rate-limit stop; other watch failures do not count toward it", async () => {
    await setup(env, { settings: { watch: { strategy: "search" } }, targets: { alice: notFollowing("alice") } });
    let errorPage = false;
    env.content = async (msg, tab) => {
      const page = { ...env.page, state: errorPage ? "error_page" : "ok", detail: errorPage ? "Something went wrong. Try reloading." : "", url: tab.url };
      if (msg.sx === "waitFor") return { ok: true, key: "tweet", page };
      // The search page does not answer the scrape in time (send() -> { ok:false, noAnswer:true, error:"timeout" }).
      if (msg.sx === "scrapeTweets") return errorPage ? { ok: true, tweets: [], articleCount: 0, page } : { ok: false, noAnswer: true, error: "timeout", page };
      return { ok: true, page };
    };
    const check = async () => { await patchState({ lastWatchAt: 0 }); await engine.tick("alarm"); return getState(); };
    for (let i = 1; i <= 2; i++) assert.equal((await check()).softErrors, i);
    errorPage = true;
    let st = await check();
    assert.equal(st.status, STATUS.RUNNING, `stopped as '${st.stopReason}' after a single "Something went wrong" page`);
    st = await check();
    assert.equal(st.status, STATUS.RUNNING, "two error pages in a row are not three");
    st = await check();
    assert.equal(st.status, STATUS.STOPPED);
    assert.equal(st.stopReason, STOP.RATE_LIMIT, "three error pages in a row stop as a rate limit");
  });

  // ---------------- ENG2-5 ----------------

  test("ENG2-5: Pause during the profile visit before writing: no OpenAI call, nothing queued", async () => {
    await setup(env, { targets: { alice: notFollowing("alice") } }); // alice's profile was never read
    const calls = mockOpenAI();
    const post = { id: "1983000000000000501", url: "https://x.com/alice/status/1983000000000000501", author: "alice", authorName: "Alice", text: "Distribution beats features in crypto infra, every single cycle.", lang: "en", createdAt: Date.now() - 4 * MIN, metrics: {} };
    let paused = false;
    env.content = async (msg) => {
      if (msg.sx === "waitFor") return { ok: true, key: (msg.keys || [])[0] };
      if (msg.sx === "scrapeTweets") return { ok: true, tweets: [post], articleCount: 1 };
      if (msg.sx === "scrapeProfile") {
        await engine.pause(); // the owner presses Pause while ScoreX is on @alice's profile
        paused = true;
        return { ok: true, profile: { handle: "alice", name: "Alice", bio: "builder", followers: 5000, following: 300, followsYou: false }, tweets: [] };
      }
      return { ok: true };
    };
    await engine.tick("alarm");
    assert.ok(paused, "the profile visit happened (setup)");
    assert.equal((await getState()).status, STATUS.PAUSED);
    assert.equal(calls.length, 0, `OpenAI was called ${calls.length}x after Pause`);
    assert.equal((await H.byPostId(post.id)).length, 0, "no comment was written after Pause");
  });

  // ---------------- ENG2-6 ----------------

  test("ENG2-6: Stop during the live X self-test: no further X pages are loaded", async () => {
    await setup(env, { state: { status: STATUS.STOPPED, stopReason: STOP.USER } });
    let stoppedAt = null;
    env.content = async (msg) => {
      if (msg.sx === "waitFor") {
        if (stoppedAt == null) { await engine.stop(STOP.USER); stoppedAt = env.navigations.length; } // Stop on page 1
        return { ok: true, key: (msg.keys || [])[0] };
      }
      if (msg.sx === "selfTest") return { ok: true, me: ME, counts: { primaryColumn: 1, tweet: 3, tweetText: 3, tweetUserName: 3, tweetTime: 3, replyButton: 3, profileUserName: 1, profileFollowers: 1, userCell: 5, followsYouBadge: 5 }, cells: 5, badgeCells: 5 };
      return { ok: true };
    };
    await runSelfTest();
    assert.equal(stoppedAt, 1, "Stop was pressed while the first test page was open (setup)");
    assert.deepEqual(env.navigations.slice(stoppedAt).map(([, u]) => u), [], "X pages loaded after Stop");
    assert.equal((await getState()).job, null, "the lease is released");
    // A later self-test (a new job) runs normally.
    env.content = null;
    await runSelfTest();
    assert.equal(env.navigations.length, 1 + 3);
  });

  // ---------------- ENG2-7 / UIV-8 ----------------

  test("ENG2-7: hours to the daily limit use the time the 24 h count covers and are never below what the 2-minute gap allows", async () => {
    const T = Date.UTC(2026, 9, 30, 18, 0);
    const s = sanitizeSettings({ mode: "auto" }); // 200 a day
    const restarted = { firstStartedAt: T - 30 * DAY, startedAt: T - 10 * MIN }; // Start pressed again 10 min ago
    const fastest = ((200 - 150) * HARD.minGapMin * MIN) / HOUR; // 50 more replies need at least 100 min
    const r = safety.riskReport(s, restarted, { postedToday: 150 }, { total: 400 }, {}, T);
    assert.ok(r.hoursToLimit >= fastest, `hoursToLimit = ${r.hoursToLimit} h, but 50 more replies need at least ${fastest.toFixed(2)} h`);
    // The 150 replies span the last 20 h: 7.5 an hour, so 50 more take ~6.7 h whatever the last start.
    assert.equal(safety.riskReport(s, restarted, { postedToday: 150, firstPostedAt: T - 20 * HOUR }, { total: 400 }, {}, T).hoursToLimit, 6.7);
    // computeCounts reports that span (the oldest reply counted in the last 24 h).
    await setup(env);
    const t0 = Date.now();
    for (const ago of [25 * HOUR, 20 * HOUR, 5 * HOUR, HOUR]) await H.put(H.newRecord({ status: HS.POSTED, target: "a" + ago, comment: "c", createdAt: t0 - ago - MIN, postedAt: t0 - ago }));
    const c = await engine.computeCounts(sanitizeSettings(baseSettings), t0);
    assert.equal(c.postedToday, 3);
    assert.equal(c.firstPostedAt, t0 - 20 * HOUR);
  });

  test("UIV-8: the replies risk factor says '1 reply', not '1 replies'", () => {
    const s = sanitizeSettings({ mode: "auto" });
    const detail = (n) => safety.riskReport(s, {}, { postedToday: n }, { total: 0 }, {}, Date.now()).factors.find((f) => f.id === "volume").detail;
    assert.match(detail(1), /^1 reply in the last 24 h/);
    assert.match(detail(2), /^2 replies in the last 24 h/);
  });
});
