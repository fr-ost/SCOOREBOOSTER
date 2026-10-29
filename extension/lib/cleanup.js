// ScoreX - optional cleanup (Phase 3, default OFF): unfollow targets you follow that did not follow you
// back within N days (minimum 7). Own daily limit (hard cap 30), whitelist, tier-1 protection, at most one
// unfollow per check and a 20-40 minute gap between unfollows. Only accounts in your ScoreX target list are
// ever considered, and every candidate's profile is re-checked right before unfollowing.
//
// "Following since" is the first time ScoreX saw that you follow the account (target.rel.youFollowSince),
// so accounts you already followed become eligible N days after ScoreX first checked them.

import { CMD, HARD } from "./constants.js";
import { getState, patchState, getTargets, updateTargets, getSettings, log } from "./store.js";
import { navigate, send, waitForPage } from "./tabs.js";
import { pageVerdict } from "./guard.js";
import { applyProfile } from "./targets.js";
import { now, DAY, MIN, randInt, sleep, humanDelay, clamp } from "./util.js";

export function eligible(t, settings, ts = now()) {
  const c = settings.cleanup;
  const why = [];
  const rel = t.rel || {};
  if (!rel.youFollow) why.push("you don't follow them");
  if (rel.followsYou !== false) why.push(rel.followsYou ? "follows you" : "follow-back unknown");
  if (!rel.youFollowSince || ts - rel.youFollowSince < c.afterDays * DAY) why.push(`followed less than ${c.afterDays} days ago`);
  if ((c.whitelist || []).includes(t.handle)) why.push("whitelisted");
  if (rel.cleanupSkipUntil && rel.cleanupSkipUntil > ts) why.push("re-check postponed");
  if (c.protectTier1 && t.tier === 1) why.push("tier 1 protected");
  return { ok: why.length === 0, why };
}

export async function preview() {
  const [settings, targets] = await Promise.all([getSettings(), getTargets()]);
  const ts = now();
  const candidates = Object.values(targets)
    .map((t) => ({ t, e: eligible(t, settings, ts) }))
    .filter((x) => x.e.ok)
    .map(({ t }) => ({
      handle: t.handle,
      name: t.name,
      tier: t.tier,
      group: t.group,
      followedSince: t.rel.youFollowSince,
      youFollowSince: t.rel.youFollowSince,
      followers: t.profile ? t.profile.followers : null,
      days: Math.floor((ts - t.rel.youFollowSince) / DAY),
      comments: (t.stats && t.stats.comments) || 0,
      reason: `No follow-back after ${Math.floor((ts - t.rel.youFollowSince) / DAY)} days`,
    }))
    .sort((a, b) => b.days - a.days);
  return { ok: true, enabled: settings.cleanup.enabled, candidates, dailyLimit: settings.cleanup.dailyLimit };
}

// Unfollows in the last 24 hours (rolling, independent of the time zone setting).
function unfollowsLast24h(st, ts) { return (st.unfollowTimes || []).filter((t) => ts - t < DAY).length; }

// Once a day, before the first unfollow: open your own followers list and require that X still marks those
// accounts with "Follows you". If the badge cannot be detected (markup changed), cleanup must not run,
// because it would read every profile as "doesn't follow you".
async function followsYouCanary(tabId, settings, me, ts) {
  const st = await getState();
  if (st.followsYouCanaryAt && ts - st.followsYouCanaryAt < DAY) return { ok: true };
  if (!me) return { ok: false, reason: "no handle" };
  const nav = await navigate(tabId, `https://x.com/${me}/followers`);
  if (!nav.ok) return { ok: false, reason: "followers page did not load" };
  const w = await waitForPage(tabId, ["userCell", "emptyState"], 20000);
  const v = pageVerdict(w.page, settings);
  if (v && v.stop) return { stop: v.stop, detail: v.detail };
  if (w.key === "emptyState") { await patchState({ followsYouCanaryAt: ts }); return { ok: true }; } // nobody follows you yet
  await sleep(humanDelay(1500, 3000));
  const u = await send(tabId, CMD.SCRAPE_USERS, { limit: 30 }, 15000);
  const users = (u && u.users) || [];
  if (!users.length) return { ok: false, reason: "followers list did not render" };
  if (!users.some((x) => x.followsYou)) return { stop: "dom_changed", detail: "Cannot detect the 'Follows you' badge on your followers list - cleanup is not safe" };
  await patchState({ followsYouCanaryAt: ts });
  return { ok: true };
}

// shouldStop(): true once the user pressed Pause/Stop - checked before every page visit and right before
// the unfollow click.
export async function cleanupStep({ tabId, settings, me, shouldStop }) {
  const c = settings.cleanup;
  if (!c.enabled) return null;
  const stopped = shouldStop || (async () => false);
  const ts = now();
  const st = await getState();
  const limit = clamp(c.dailyLimit, 0, HARD.dailyUnfollows);
  if (unfollowsLast24h(st, ts) >= limit) return null;
  if (st.lastUnfollowAt && ts - st.lastUnfollowAt < (st.nextUnfollowGapMin || 25) * MIN) return null;
  const targets = await getTargets();
  const pick = Object.values(targets).filter((t) => eligible(t, settings, ts).ok).sort((a, b) => a.rel.youFollowSince - b.rel.youFollowSince)[0];
  if (!pick) return null;

  const canary = await followsYouCanary(tabId, settings, String(me || settings.account.handle || "").toLowerCase(), ts);
  if (canary.stop) return canary;
  if (!canary.ok) { await patchState({ lastUnfollowAt: now(), nextUnfollowGapMin: randInt(30, 60) }); return { did: "cleanup_skip" }; }
  if (await stopped()) return { did: "aborted" };

  // Postpone this account for a day when the re-check is inconclusive, so the same profile is not
  // reloaded on every check, and keep the normal gap before the next cleanup attempt.
  const postpone = async (disable) => {
    await updateTargets((all) => {
      const t = Object.hasOwn(all, pick.handle) ? all[pick.handle] : null;
      if (t) { t.rel = { ...(t.rel || {}), cleanupSkipUntil: now() + DAY }; if (disable) t.enabled = false; }
      return all;
    });
    await patchState({ lastUnfollowAt: now(), nextUnfollowGapMin: randInt(20, 40) });
    return { did: "cleanup_skip" };
  };
  // Re-check the profile right before acting.
  const nav = await navigate(tabId, `https://x.com/${pick.handle}`);
  if (!nav.ok) return postpone(false);
  const w = await waitForPage(tabId, ["profileUserName", "emptyState"], 20000);
  const v = pageVerdict(w.page, settings);
  if (v && v.stop) return v;
  if (v && v.notFound) return postpone(true); // suspended / deleted: nothing to unfollow, stop targeting it
  await sleep(humanDelay(1500, 3500));
  const fs = await send(tabId, CMD.FOLLOW_STATE, {}, 15000);
  const v2 = pageVerdict(fs.page, settings);
  if (v2 && v2.stop) return v2;
  if (!fs.ok || fs.youFollow == null) return postpone(false);
  await updateTargets((all) => { if (Object.hasOwn(all, pick.handle)) applyProfile(all[pick.handle], fs.profile, null); return all; });
  if (fs.followsYou || !fs.youFollow) return { did: "cleanup_recheck" };
  if (await stopped()) return { did: "aborted" }; // last chance: Pause/Stop wins

  const r = await send(tabId, CMD.UNFOLLOW, { handle: pick.handle }, 30000);
  const v3 = pageVerdict(r.page, settings);
  if (v3 && v3.stop) return v3;
  if (r.state) return { stop: r.state === "rate_limit" ? "rate_limit" : "unusual_activity", detail: r.detail || "X warning after unfollow" };
  if (r.dom) return { stop: "dom_changed", detail: "Unfollow button not found: " + r.error };
  await patchState((s) => ({
    lastUnfollowAt: now(), nextUnfollowGapMin: randInt(20, 40),
    unfollowTimes: r.ok ? [...(s.unfollowTimes || []).filter((t) => now() - t < DAY), now()] : (s.unfollowTimes || []),
  }));
  if (r.ok) {
    await updateTargets((all) => {
      const t = Object.hasOwn(all, pick.handle) ? all[pick.handle] : null;
      if (t) { t.rel = { ...(t.rel || {}), youFollow: false, youFollowSince: null, unfollowedAt: now() }; t.enabled = false; }
      return all;
    });
    log("info", `Cleanup: unfollowed @${pick.handle} (no follow-back after ${Math.floor((ts - pick.rel.youFollowSince) / DAY)} days); target disabled`);
  } else log("warn", `Cleanup: could not unfollow @${pick.handle}: ${r.error || "unknown"}`);
  return { did: "cleanup" };
}
