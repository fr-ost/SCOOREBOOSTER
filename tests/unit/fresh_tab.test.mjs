// Fresh X tab: Chrome throttles a tab that stays in the background for about 5 minutes and X then renders no posts in
// it, so (like UniqueFarm's fresh tab per job) the worker tab is replaced when a job starts and it has been in the
// background longer than FRESH_TAB_MS. A tab you are looking at, a fresh one, or the setting turned off is kept.
import { resetStorage } from "./_chrome.mjs";
import { install } from "./_engine_env.mjs";
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as tabs from "../../extension/lib/tabs.js";
import { getState, patchState, sanitizeSettings } from "../../extension/lib/store.js";

describe("fresh X tab", () => {
  let env;
  before(() => { env = install({ session: true }); });
  after(() => env.uninstall());
  beforeEach(() => { resetStorage(); env.tabs.clear(); env.navigations.length = 0; env.commands.length = 0; env.sessionData && env.sessionData.clear(); });

  async function ours(id, extra = {}) {
    env.addTab({ id, url: "https://x.com/home", pinned: true, index: 0, ...extra });
    if (env.sessionData) env.sessionData.set(tabs._test.SESSION_KEY, id);
    await patchState({ workerTabId: id, workerTabPinned: true, workerTabIndex: 0, workerLastUrl: "https://x.com/home", ...extra.state });
  }

  test("a worker tab in the background for 4+ minutes is replaced by a fresh pinned tab at the same place", async () => {
    await ours(3, { state: { workerTabFreshAt: Date.now() - tabs.FRESH_TAB_MS - 1000 } });
    const id = await tabs.workerTab(sanitizeSettings({}));
    assert.notEqual(id, 3);
    assert.equal(env.tabs.has(3), false, "the old tab is closed");
    const t = env.tabs.get(id);
    assert.equal(t.pinned, true);
    assert.equal(t.active, false, "opened in the background");
    const st = await getState();
    assert.equal(st.workerTabId, id);
    assert.ok(Date.now() - st.workerTabFreshAt < 5000);
    // Right after, it is fresh: kept.
    assert.equal(await tabs.workerTab(sanitizeSettings({})), id);
  });

  test("a fresh tab, a tab you are looking at, or the setting turned off: the tab is kept", async () => {
    await ours(4, { state: { workerTabFreshAt: Date.now() - 60 * 1000 } });
    assert.equal(await tabs.workerTab(sanitizeSettings({})), 4, "fresh");
    resetStorage(); env.tabs.clear();
    await ours(5, { active: true, state: { workerTabFreshAt: 0 } });
    assert.equal(await tabs.workerTab(sanitizeSettings({})), 5, "visible to you: not throttled");
    resetStorage(); env.tabs.clear();
    await ours(6, { state: { workerTabFreshAt: 0 } });
    assert.equal(await tabs.workerTab(sanitizeSettings({ advanced: { freshTab: false } })), 6, "setting off");
    assert.equal(env.tabs.size, 1, "no extra tab opened");
  });

  test("a tab from before this feature (no fresh time) is replaced once on the next job", async () => {
    await ours(7);
    const id = await tabs.workerTab(sanitizeSettings({}));
    assert.notEqual(id, 7);
    assert.equal(env.tabs.size, 1, "one X tab, never a pile");
  });
});

// The engine: a watch check where X rendered nothing in the hidden tab makes the next check start in a fresh tab.
import * as engine from "../../extension/lib/engine.js";
import { save, setSecrets } from "../../extension/lib/store.js";
import { useMemoryDb } from "../../extension/lib/db.js";
import { K, STATUS } from "../../extension/lib/constants.js";
import { newTarget, applyFollow } from "../../extension/lib/targets.js";

describe("fresh X tab after an empty hidden watch page", () => {
  let env;
  before(() => { env = install(); });
  after(() => env.uninstall());

  test("X rendered no posts while the tab was hidden: the fresh-tab clock is reset for the next check", async () => {
    resetStorage();
    useMemoryDb();
    env.tabs.clear();
    await save({ [K.settings]: { mode: "review", account: { handle: "0x_nation", verifyAccount: true }, watch: { strategy: "list", listUrls: ["https://x.com/i/lists/1234567890"], scrolls: 0, catchUp: { enabled: false } }, safety: { activeHours: { enabled: false }, breaks: { enabled: false } }, learning: { enabled: false, conversations: { enabled: false } } } });
    await setSecrets({ openaiKey: "sk-test-1234567890abcdef" });
    await save({ [K.targets]: { alice: applyFollow(newTarget("alice"), false, Date.now() - 86400000) } });
    env.addTab({ id: 3, url: "https://x.com/home", pinned: true, index: 0 });
    await patchState({ status: STATUS.RUNNING, firstStartedAt: Date.now() - 20 * 86400000, workerTabId: 3, workerTabPinned: true, workerTabIndex: 0, workerTabFreshAt: Date.now(), followBadgeOkAt: Date.now(), followersScanAt: Date.now() });
    env.page = { state: "ok", detail: "", me: "0x_nation", hidden: true };
    env.content = async (msg, tab) => {
      const page = { ...env.page, url: tab.url };
      if (msg.sx === "waitFor") return { ok: false, settled: "timeout", timeout: true, page };
      if (msg.sx === "scrapeTweets") return { ok: true, tweets: [], articleCount: 0, page };
      return { ok: true, page };
    };
    await engine.tick("alarm");
    await engine.pause().catch(() => {});
    const st = await getState();
    assert.equal(st.hiddenEmptyStreak, 1, "the empty hidden page was seen");
    assert.equal(st.workerTabFreshAt, 0, "the next check starts in a fresh tab");
  });
});
