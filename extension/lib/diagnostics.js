// ScoreX - diagnostics self-test: opens your X home timeline, your profile and your followers list in the
// worker tab and checks that ScoreX can still read them (the selectors match, the right account is logged in,
// X's "Follows you" badge is visible on your followers). Read-only: nothing is clicked or typed. Runs under the
// job lease, so it never overlaps a running check, post or discovery.

import { CMD } from "./constants.js";
import { getSettings, log, patchState } from "./store.js";
import { workerTab, navigate, send, waitForPage } from "./tabs.js";
import { pageVerdict } from "./guard.js";
import { withLease, stop } from "./engine.js";
import { now, sleep } from "./util.js";

const PAGES = [
  {
    id: "home", label: "Home timeline", url: () => "https://x.com/home", wait: ["tweet", "emptyState"],
    keys: ["primaryColumn", "tweet", "tweetText", "tweetUserName", "tweetTime", "replyButton", "likeButton", "unlikeButton", "actionGroup"],
    need: { primaryColumn: "page frame", tweet: "posts", tweetText: "post text", tweetUserName: "post author", tweetTime: "post time", replyButton: "reply button" },
  },
  {
    id: "profile", label: "Your profile", url: (me) => `https://x.com/${me}`, wait: ["profileUserName", "emptyState"],
    keys: ["profileUserName", "profileBio", "profileFollowers", "profileFollowing", "tweet"],
    need: { profileUserName: "name and handle", profileFollowers: "followers count" },
  },
  {
    id: "followers", label: "Your followers", url: (me) => `https://x.com/${me}/followers`, wait: ["userCell", "emptyState"],
    keys: ["userCell", "followsYouBadge", "emptyState"],
    need: {},
  },
];

export async function runSelfTest() {
  const settings = await getSettings();
  const me = String(settings.account.handle || "").toLowerCase().replace(/^@/, "");
  if (!me) return { ok: false, error: "Set your X handle first (Settings)" };
  const res = await withLease("selftest", async () => {
    const tabId = await workerTab(settings);
    if (tabId == null) return { ok: false, error: "Could not open the X tab" };
    const checks = [];
    const add = (id, label, ok, detail) => checks.push({ id, label, ok, detail });
    for (const p of PAGES) {
      const nav = await navigate(tabId, p.url(me), { purpose: "diagnostics" }); // counted in the X footprint as diagnostics
      // Pause/Stop pressed: nothing more is loaded, and the partial run is not kept as the last live test.
      if (nav.aborted) return { ok: false, aborted: true, error: "Stopped by Pause/Stop before the test finished", checks, at: now() };
      if (!nav.ok) { add(p.id, p.label, false, nav.budget ? "Not loaded: the X page-load budget (Safety) is used up - try again later" : "The page did not load"); continue; }
      const w = await waitForPage(tabId, p.wait, 20000);
      const v = pageVerdict(w.page, settings);
      if (v && v.stop) {
        add(p.id, p.label, false, `X shows a problem: ${v.stop}${v.detail ? " (" + v.detail + ")" : ""}`);
        // Same rule as everywhere else: a captcha, warning, rate limit, logout or wrong account seen in the X tab is a
        // safety stop (notification + red badge, manual resume), so the engine never runs into it on its next check.
        await stop(v.stop, v.detail || "Seen during the self-test").catch(() => {});
        return { ok: true, checks, stop: v.stop, at: now() };
      }
      let r = await send(tabId, CMD.SELF_TEST, { keys: p.keys }, 15000);
      // Your followers list can still be filling in: read it again (twice at most) before judging the badge.
      for (let i = 0; p.id === "followers" && i < 2 && r && r.ok && (r.cells < 3 || !r.badgeCells); i++) {
        await sleep(2500);
        r = await send(tabId, CMD.SELF_TEST, { keys: p.keys }, 15000);
      }
      if (!r || !r.ok) { add(p.id, p.label, false, "The page could not be read (the content script did not answer)"); continue; }
      if (p.id === "home") {
        add("account", "Logged-in account", r.me ? r.me.toLowerCase() === me : false, r.me ? `@${r.me}${r.me.toLowerCase() === me ? "" : ` (ScoreX expects @${me})`}` : "Could not read which account is logged in");
      }
      const missing = Object.entries(p.need).filter(([k]) => !(r.counts && r.counts[k] > 0)).map(([, what]) => what);
      if (p.id === "followers") {
        if (r.counts && r.counts.emptyState > 0 && !r.cells) add(p.id, p.label, true, "Nobody follows you yet (nothing to check)");
        else if (!r.cells) add(p.id, p.label, false, "No follower rows found - X may have changed the list");
        else if (!r.badgeCells && r.cells >= 3) add(p.id, p.label, false, `${r.cells} followers shown but no "Follows you" badge - follow tracking would not be safe`);
        else if (!r.badgeCells) add(p.id, p.label, true, `Only ${r.cells} follower${r.cells === 1 ? "" : "s"} shown, too few to judge the "Follows you" badge (the follow check reads the list again later)`);
        else add(p.id, p.label, true, `${r.cells} followers read, "Follows you" badge found on ${r.badgeCells}${r.badgeElements === 0 ? " (as text: X renamed the badge element, still readable)" : ""}`);
        continue;
      }
      if (p.id === "home" && r.counts && !r.counts.tweet && r.counts.emptyState) { add(p.id, p.label, true, "Your timeline is empty (nothing to read)"); continue; }
      add(p.id, p.label, !missing.length, missing.length ? `Not found: ${missing.join(", ")} - X may have changed its page (Settings > Selector overrides)` : summarize(r.counts));
    }
    return { ok: true, checks, at: now() };
  });
  if (res && res.busy) return { ok: false, error: "ScoreX is busy in the X tab - try again in a minute (or pause it first)" };
  const failedN = res && res.checks ? res.checks.filter((c) => !c.ok).length : 0;
  if (res && res.ok) {
    log(failedN ? "warn" : "info", `Self-test: ${res.checks.length - failedN} of ${res.checks.length} checks passed`);
    // The last live test, for Settings > Diagnostics (survives a dashboard reload).
    await patchState({ lastSelfTest: { at: res.at || now(), ok: !failedN && !res.stop, checks: res.checks.slice(0, 20), stop: res.stop || null } }).catch(() => {});
  }
  return res;
}

function summarize(counts) {
  return Object.entries(counts || {}).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(" · ") || "ok";
}
