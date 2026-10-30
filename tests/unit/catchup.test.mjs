import "./_chrome.mjs";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { catchUpCandidates, catchUpMaxAgeMin } from "../../extension/lib/catchup.js";
import { skipReason } from "../../extension/lib/filters.js";
import { sanitizeSettings } from "../../extension/lib/store.js";
import { HOUR, MIN } from "../../extension/lib/util.js";

const NOW = Date.UTC(2026, 9, 29, 12, 0);
const T = (handle, posts, o = {}) => ({ handle, name: handle.toUpperCase(), enabled: o.enabled !== false, tier: o.tier || 2, priority: o.priority || 50, coldUntil: o.coldUntil || null,
  rel: { followsYou: o.follows === undefined ? false : o.follows }, recentPosts: posts.map(([id, hoursAgo]) => ({ id, text: "Post " + id + " about rollups and distribution", createdAt: NOW - hoursAgo * HOUR, lang: "en" })) });

describe("catch-up", () => {
  const settings = sanitizeSettings({});
  test("defaults: on, 2 latest posts per account, up to 48 hours old", () => {
    assert.deepEqual(settings.watch.catchUp, { enabled: true, perTarget: 2, maxAgeHours: 48 });
    assert.equal(sanitizeSettings({ watch: { catchUp: { perTarget: 9, maxAgeHours: 999 } } }).watch.catchUp.perTarget, 3);
    assert.equal(sanitizeSettings({ watch: { catchUp: { enabled: false } } }).watch.catchUp.enabled, false);
  });
  test("newest earlier posts per account, only accounts that don't follow you, not cold, not fresh, not too old", () => {
    const targets = {
      a: T("a", [["a1", 1], ["a2", 5], ["a3", 30], ["a4", 60]]),
      b: T("b", [["b1", 0.1], ["b2", 3]]), // b1 is still in the live window (watcher handles it)
      c: T("c", [["c1", 2]], { follows: true }), // follows you: never
      d: T("d", [["d1", 2]], { follows: null }), // not checked yet
      e: T("e", [["e1", 2]], { coldUntil: NOW + HOUR }),
      f: T("f", [["f1", 2]], { enabled: false }),
      g: T("g", [["g1", 4]], { tier: 1, priority: 90 }),
    };
    const c = catchUpCandidates(targets, settings, NOW);
    assert.deepEqual(c.map((p) => p.id).sort(), ["a1", "a2", "b2", "g1"]);
    assert.equal(c[0].id, "g1", "tier 1 / high priority first");
    assert.ok(c.every((p) => p.catchUp && p.url === `https://x.com/${p.author}/status/${p.id}`));
    const three = sanitizeSettings({ watch: { catchUp: { perTarget: 3 } } });
    assert.ok(catchUpCandidates(targets, three, NOW).some((p) => p.id === "a3"));
    assert.deepEqual(catchUpCandidates(targets, sanitizeSettings({ watch: { catchUp: { enabled: false } } }), NOW), []);
  });
  test("skip rules use the catch-up age limit, and queued items live as long as the window", () => {
    const post = { id: "1", author: "a", text: "A longer post about onchain distribution and retention", lang: "en", createdAt: NOW - 5 * HOUR };
    assert.equal(skipReason(post, settings, { ts: NOW }).code, "stale");
    assert.equal(skipReason(post, settings, { ts: NOW, maxAgeMin: 48 * 60 }), null);
    assert.equal(catchUpMaxAgeMin(settings), 48 * 60 + 120);
    assert.ok(MIN > 0);
  });
});
