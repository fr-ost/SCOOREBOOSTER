// ScoreX content script - message router. The service worker sends { sx: "<command>", ...args } and gets
// { ok, ...result, page } back. Every reply carries the current page state so the worker can stop on
// captcha / lock / logout / warnings immediately.

(function () {
  "use strict";
  if (globalThis.__SX_CS) return;
  globalThis.__SX_CS = true;
  const D = globalThis.SXDom, S = globalThis.SXScrape, A = globalThis.SXActions, X = globalThis.SXDetect;

  const handlers = {
    // No page-visible state (Web Locks, DOM markers, globals readable by x.com) is ever created here:
    // the tab is kept alive by chrome.tabs autoDiscardable:false from the worker instead.
    async ping() { return { ok: true, ready: document.readyState, me: X.myHandle() }; },
    async pageState() { return { ok: true }; },
    async waitFor(m) {
      const keys = [].concat(m.keys || []);
      const timeout = Math.min(Number(m.timeoutMs) || 15000, 60000);
      const st = await X.settle(Math.min(timeout, 20000));
      if (st.state !== "ok") return { ok: false, settled: st.state };
      if (!keys.length) return { ok: true };
      const hit = await D.waitFor(() => {
        const s = X.pageState();
        if (s.state !== "ok" && s.state !== "loading") return { stop: s.state };
        for (const k of keys) if (D.q(k)) return { key: k };
        return null;
      }, timeout, 400);
      if (!hit) return { ok: false, timeout: true };
      if (hit.stop) return { ok: false, settled: hit.stop };
      return { ok: true, key: hit.key };
    },
    async scrapeTweets(m) { return { ok: true, ...S.scrapeTweets(m.limit || 40), emptyState: !!D.q("emptyState") }; },
    async scrapeProfile() { return { ok: true, ...S.scrapeProfile() }; },
    async scrapeUsers(m) { return { ok: true, ...S.scrapeUsers(m.limit || 200) }; },
    async scrapeStatus(m) { return { ok: true, ...S.scrapeStatus(m.tweetId, m.me) }; },
    async scroll(m) { return A.scroll(m); },
    async like(m) { return A.like(m); },
    async openComposer(m) { return A.openComposer(m); },
    async type(m) { return A.type(m); },
    async composerText() { return A.composerText(); },
    // Diagnostics: how many elements each selector key finds on this page (read-only, nothing is clicked).
    async selfTest(m) {
      const keys = [].concat(m.keys || []).filter((k) => typeof k === "string").slice(0, 40);
      const counts = {};
      for (const k of keys) { try { counts[k] = D.qa(k).length; } catch (_) { counts[k] = -1; } }
      const cells = D.qa("userCell");
      const badgeCells = cells.filter((c) => !!D.q("followsYouBadge", c)).length;
      return { ok: true, counts, me: X.myHandle(), url: location.href, cells: cells.length, badgeCells };
    },
    async clearComposer() { return A.clearComposer(); },
    async closeComposer() { return A.closeComposer(); },
    async submitReply(m) { return A.submitReply(m); },
    async replyResult(m) { return A.replyResult(m); },
    async followState() { return A.followState(); },
    async unfollow(m) { return A.unfollow(m); },
    async replyStats(m) { return A.replyStats(m); },
  };

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg || typeof msg.sx !== "string" || sender.id !== chrome.runtime.id) return false;
    const h = handlers[msg.sx];
    if (!h) return false;
    (async () => {
      let out;
      try { out = await h(msg); } catch (e) { out = { ok: false, error: "exception", detail: String((e && e.message) || e).slice(0, 300) }; }
      let page;
      try { page = X.pageState(); } catch (_) { page = { state: "unknown" }; }
      reply({ ...(out || {}), page });
    })();
    return true;
  });

  // Announce readiness so navigation waits resolve quickly.
  try { chrome.runtime.sendMessage({ sx: "contentReady", url: location.href }).catch(() => {}); } catch (_) {}
})();
