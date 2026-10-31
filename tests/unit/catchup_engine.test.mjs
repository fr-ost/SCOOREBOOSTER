// GEN2-1 (engine side): catch-up leaves out accounts that cannot take a comment now. The engine keeps only the
// first 12 candidates without a history record; posts of accounts that already had their 2 comments today never get
// a record, so before the fix 6 capped tier-1 accounts held all 12 slots and no other account got a catch-up comment
// until their 24 h rolled over. The engine now passes its counts to catchUpCandidates().
import { resetStorage } from "./_chrome.mjs";
import { install, mockOpenAI } from "./_engine_env.mjs";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { useMemoryDb } from "../../extension/lib/db.js";
import * as H from "../../extension/lib/history.js";
import * as engine from "../../extension/lib/engine.js";
import { patchState, save, setSecrets } from "../../extension/lib/store.js";
import { K, HS, STATUS } from "../../extension/lib/constants.js";
import { newTarget, applyFollow } from "../../extension/lib/targets.js";
import { catchUpCandidates } from "../../extension/lib/catchup.js";
import { sanitizeSettings } from "../../extension/lib/store.js";
import { MIN, HOUR, DAY } from "../../extension/lib/util.js";

const ME = "0x_nation";

const settingsRaw = {
  mode: "review",
  account: { handle: ME, verifyAccount: true },
  watch: { strategy: "list", listUrls: ["https://x.com/i/lists/1234567890"], scrolls: 0, catchUp: { enabled: true, perTarget: 2, maxAgeHours: 48 } },
  safety: { activeHours: { enabled: false }, breaks: { enabled: false }, maxPageLoads24h: 3 }, // no page loads needed; keeps the idle follow checks out
  learning: { enabled: false, conversations: { enabled: false } },
  review: { notifyNew: false },
};
const post = (id, hoursAgo, i) => ({ id, text: `Rollup ${i}: sequencer revenue is the number nobody tracks, and it decides who survives the next fee war`, createdAt: Date.now() - hoursAgo * HOUR, lang: "en", metrics: null, isQuote: false, hasMedia: false, hasCard: false, links: [] });

describe("catch-up in the engine", () => {
  let env;
  before(() => { env = install(); });
  after(() => env.uninstall());

  test("capped tier-1 accounts do not hold every catch-up slot: the account that can still take a comment gets one", async () => {
    env.tabs.clear();
    env.content = async (msg) => (msg.sx === "waitFor" ? { ok: true, key: "tweet" } : msg.sx === "scrapeTweets" ? { ok: true, tweets: [], articleCount: 0 } : { ok: true });
    resetStorage();
    useMemoryDb();
    const calls = mockOpenAI("Sequencer revenue is the cleanest signal, fees alone hide who actually pays for blobspace");
    const targets = {};
    for (let i = 1; i <= 6; i++) {
      const h = "big" + i;
      const t = applyFollow(newTarget(h, { tier: 1 }), false, Date.now() - 3 * DAY);
      t.recentPosts = [post(`9${i}1`, 1, i), post(`9${i}2`, 2, i)];
      targets[h] = t;
    }
    const zed = applyFollow(newTarget("zed", { tier: 2 }), false, Date.now() - 3 * DAY);
    zed.recentPosts = [post("8001", 3, 99)];
    targets.zed = zed;
    await save({ [K.settings]: settingsRaw, [K.targets]: targets });
    await setSecrets({ openaiKey: "sk-test-1234567890abcdef" });
    // Each tier-1 account already got its 2 comments in the last 24 h (live replies to other posts).
    for (let i = 1; i <= 6; i++) for (let k = 0; k < 2; k++) {
      await H.put(H.newRecord({ status: HS.POSTED, target: "big" + i, postId: `7${i}${k}`, comment: "earlier reply " + i + k, attempts: 1, createdAt: Date.now() - 2 * HOUR, postedAt: Date.now() - 2 * HOUR + k * MIN }));
    }
    env.addTab({ id: 3, url: "https://x.com/home", pinned: true, index: 0 });
    await patchState({ status: STATUS.RUNNING, firstStartedAt: Date.now() - 20 * DAY, startedAt: Date.now() - HOUR, workerTabId: 3, workerTabPinned: true, workerTabIndex: 0, workerTabFreshAt: Date.now(),
      followBadgeOkAt: Date.now(), followersScanAt: Date.now(), lastWatchAt: Date.now() - 30 * 1000 }); // watched 30 s ago: this tick skips the watch page

    // The selection the engine works from: 12 tier-1 posts first, zed's post 13th.
    const cands = catchUpCandidates(targets, sanitizeSettings(settingsRaw), Date.now());
    assert.equal(cands.length, 13);
    assert.equal(cands[12].author, "zed");

    await engine.tick("alarm");
    await engine.pause().catch(() => {});

    const zedRecs = await H.byPostId("8001");
    const gens = calls.filter((b) => !/pass/.test(JSON.stringify(b.text && b.text.format && b.text.format.schema)));
    assert.equal(zedRecs.length, 1, `zed (no comment today, within every limit) got no catch-up comment; OpenAI generation calls: ${gens.length}; records: ${(await H.all()).length}`);
  });
});
