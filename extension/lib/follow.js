// ScoreX - follow tracking. Only accounts that do NOT follow you are commented on.
//   1. Every new target starts as "checking" and is never watched or commented on until it is checked.
//   2. Your followers list (x.com/<you>/followers, newest first) is scanned: one page shows many accounts
//      at once, and every account there with X's "Follows you" badge follows you. Scans right after new
//      targets were added go deeper; routine scans read your newest followers, where follow-backs appear.
//   3. Targets that are still unknown get a profile visit ("Follows you" badge next to their name).
//      Targets you comment on are re-checked on their profile every few days as well.
//   4. Follows you -> never commented on. Followed back -> comments stop (open queue items are dropped).
//   5. After N days (default 14) of comments without a follow-back, one last profile check; if they still
//      don't follow you, the target is removed and (by default) added to the blacklist.
// The followers scan is also a safety check: if X shows follower cells without any "Follows you" badge,
// the badge markup changed and every account would look like a non-follower, so ScoreX stops. A "does not
// follow you" reading is only trusted while the badge was seen recently.

import { CMD, STOP } from "./constants.js";
import { getState, patchState, getTargets, updateTargets, updateBlacklist, log } from "./store.js";
import { navigate, send, waitForPage } from "./tabs.js";
import { pageVerdict } from "./guard.js";
import { refreshProfile } from "./watcher.js";
import { processFollowBacks } from "./learning.js";
import { applyFollow, followStatus, followDays, FS } from "./targets.js";
import { normalizeHandle, now, DAY, HOUR, MIN, sleep, humanDelay } from "./util.js";

const BADGE_TRUST_MS = 3 * DAY; // negatives are trusted this long after the badge was last seen working
const SCAN_RETRY_MS = 30 * MIN;
// Accounts that follow you are looked at again now and then, so one that unfollows you gets comments again (after two
// checks in a row). Heuristics: every 10 days, a missing badge is confirmed the next day, at most 2 per run and 12
// per 24 h (rel.verifiedAt), and only with what is left of the run's profile-visit budget, so a long list of
// accounts that follow you never adds many X page loads.
const VERIFY_EVERY_MS = 10 * DAY;
const VERIFY_CONFIRM_MS = DAY;
const VERIFY_PER_RUN = 2;
const VERIFY_PER_DAY = 12;
// navigate()'s 3rd argument: the page-load purpose for the X footprint ledger (lib/tabs.js). valueOf keeps it a valid
// timeout (45 s) for the older navigate(tabId, url, timeoutMs) signature.
const NAV = (purpose) => ({ purpose, timeoutMs: 45000, valueOf: () => 45000 });

export function giveUpDue(t, settings, ts = now()) {
  const f = settings.follow;
  if (!f.autoRemove || !t || t.enabled === false || followStatus(t) !== FS.ACTIVE) return false;
  const first = t.stats && t.stats.firstCommentAt;
  return !!first && ts - first >= f.giveUpDays * DAY;
}

export function badgeTrusted(st, ts = now()) {
  return !!(st.followBadgeOkAt && ts - st.followBadgeOkAt < BADGE_TRUST_MS);
}

// What the next follow step should do (pure). Returns { scan, deep, profiles: [{handle, why}], verify: [{handle, why}],
// counts }. `verify` (accounts that follow you, re-checked now and then) only gets what is left of a run's budget.
// A target that was "not found" is turned off; once it is turned on again it is tracked like any other.
export function followPlan(targets, settings, st, ts = now()) {
  const f = settings.follow;
  const list = Object.values(targets || {}).filter((t) => t && t.handle && t.enabled !== false);
  const waitOk = (t) => !(t.rel && t.rel.followCheckAfter > ts);
  const checking = list.filter((t) => followStatus(t) === FS.CHECKING).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  const active = list.filter((t) => followStatus(t) === FS.ACTIVE);
  const newestChecking = checking.reduce((m, t) => Math.max(m, t.addedAt || 0), 0);
  const scanAt = st.followersScanAt || 0;
  const retryOk = !st.followersScanRetryAt || ts >= st.followersScanRetryAt;
  const scan = retryOk && (checking.length > 0 || active.length > 0) &&
    (ts - scanAt >= f.scanEveryHours * HOUR || (checking.length > 0 && newestChecking > scanAt) || !badgeTrusted(st, ts));
  const giveUp = active.filter((t) => giveUpDue(t, settings, ts) && waitOk(t));
  const recheck = active
    .filter((t) => t.stats && t.stats.comments > 0 && !giveUpDue(t, settings, ts) && waitOk(t) && (!t.rel.checkedAt || ts - t.rel.checkedAt >= f.recheckHours * HOUR))
    .sort((a, b) => (a.rel.checkedAt || 0) - (b.rel.checkedAt || 0));
  const profiles = [
    ...giveUp.map((t) => ({ handle: t.handle, why: "give_up" })),
    ...checking.filter(waitOk).map((t) => ({ handle: t.handle, why: "check" })),
    ...recheck.map((t) => ({ handle: t.handle, why: "recheck" })),
  ];
  const verifiedToday = list.filter((t) => t.rel && t.rel.verifiedAt && ts - t.rel.verifiedAt < DAY).length;
  const verify = list
    .filter((t) => [FS.FOLLOWS, FS.FOLLOWED_BACK].includes(followStatus(t)) && waitOk(t))
    .filter((t) => !t.rel.checkedAt || ts - t.rel.checkedAt >= (t.rel.notFollowingSeen > 0 ? VERIFY_CONFIRM_MS : VERIFY_EVERY_MS))
    .sort((a, b) => (b.rel.notFollowingSeen || 0) - (a.rel.notFollowingSeen || 0) || (a.rel.checkedAt || 0) - (b.rel.checkedAt || 0))
    .slice(0, Math.max(0, Math.min(VERIFY_PER_RUN, VERIFY_PER_DAY - verifiedToday)))
    .map((t) => ({ handle: t.handle, why: "verify" }));
  return { scan, deep: checking.length > 0, profiles, verify, counts: { checking: checking.length, active: active.length, giveUp: giveUp.length } };
}

// Read your followers list. Returns { ok, followers: Set, cells, empty } | { stop, detail } | { ok:false, soft } |
// { aborted: true } (Pause/Stop pressed: checked before every scroll).
async function scanFollowers(tabId, settings, me, deep, stopped = async () => false) {
  const nav = await navigate(tabId, `https://x.com/${me}/followers`, NAV("follow"));
  if (!nav.ok && nav.budget) return { budget: true }; // X page-load budget reached: nothing was loaded
  if (!nav.ok) return { ok: false, soft: nav.error || "followers page did not load" };
  const w = await waitForPage(tabId, ["userCell", "emptyState"], 20000);
  const v = pageVerdict(w.page, settings);
  if (v && v.stop) return { stop: v.stop, detail: v.detail };
  if (w.ok && w.key === "emptyState") return { ok: true, followers: new Set(), cells: 0, empty: true };
  if (!w.ok) return { ok: false, soft: "followers list did not render" };
  await sleep(humanDelay(1500, 3000));
  const followers = new Set(), others = new Set();
  const scrolls = deep ? 12 : 2;
  let stale = 0;
  for (let i = 0; i <= scrolls; i++) {
    const u = await send(tabId, CMD.SCRAPE_USERS, { limit: 400 }, 15000);
    const v2 = pageVerdict(u.page, settings);
    if (v2 && v2.stop) return { stop: v2.stop, detail: v2.detail };
    const before = followers.size + others.size;
    for (const x of (u && u.users) || []) (x.followsYou ? followers : others).add(x.handle);
    stale = followers.size + others.size === before ? stale + 1 : 0;
    if (stale >= 2 || i === scrolls) break; // end of the list (or nothing new is loading)
    await sleep(humanDelay(1200, 2800));
    if (await stopped()) return { aborted: true };
    await send(tabId, CMD.SCROLL, {}, 8000);
  }
  const cells = followers.size + others.size;
  if (!cells) return { ok: false, soft: "followers list did not render" };
  if (cells >= 3 && !followers.size) {
    return { stop: STOP.DOM_CHANGED, detail: "Your followers list shows accounts but no 'Follows you' badge - follow detection is not safe" };
  }
  return { ok: true, followers, cells, empty: false };
}

// Remove a target that did not follow back in time (and blacklist it when enabled).
export async function giveUp(handle, settings, ts = now()) {
  let removed = null;
  await updateTargets((all) => {
    if (Object.hasOwn(all, handle) && followStatus(all[handle]) === FS.ACTIVE) { removed = all[handle]; delete all[handle]; }
    return all;
  });
  if (!removed) return false;
  const days = followDays(removed, ts);
  if (settings.follow.blacklist) {
    await updateBlacklist((bl) => {
      bl[handle] = blEntry(removed, "no_followback", ts);
      return bl;
    });
  }
  log("info", `Removed @${handle}: no follow-back after ${days} days of comments${settings.follow.blacklist ? " (blacklisted)" : ""}`);
  return true;
}

function blEntry(t, reason, ts) {
  return {
    handle: t.handle, name: t.name || (t.profile && t.profile.name) || "", reason, at: ts,
    days: followDays(t, ts), comments: (t.stats && t.stats.comments) || 0, tier: t.tier || null,
    followers: (t.profile && t.profile.followers) || null,
    following: t.profile && t.profile.following != null ? t.profile.following : null, // learned follow-back rates (scores.learnedRates)
  };
}

// Blacklist handles by hand (they are removed from the targets as well).
export async function blacklistAdd(handles, reason = "manual") {
  const list = [...new Set((handles || []).map(normalizeHandle).filter(Boolean))];
  const removed = {};
  await updateTargets((all) => {
    for (const h of list) if (Object.hasOwn(all, h)) { removed[h] = all[h]; delete all[h]; }
    return all;
  });
  let added = 0;
  const ts = now();
  await updateBlacklist((bl) => {
    for (const h of list) {
      if (!Object.hasOwn(bl, h)) added++;
      bl[h] = blEntry(removed[h] || { handle: h }, reason, ts);
    }
    return bl;
  });
  return { added, removedTargets: Object.keys(removed).length };
}

export async function blacklistRemove(handles) {
  const list = (handles || []).map(normalizeHandle).filter(Boolean);
  let removed = 0;
  await updateBlacklist((bl) => { for (const h of list) if (Object.hasOwn(bl, h)) { delete bl[h]; removed++; } return bl; });
  return { removed };
}

// One follow-tracking step on the worker tab (called by the engine when idle). shouldStop() is checked
// before every page visit and every scroll of the followers list. Returns null (nothing to do), { did, visits },
// { did: "aborted" } or { stop, detail }.
export async function followStep({ tabId, settings, me, shouldStop }) {
  const stopped = shouldStop || (async () => false);
  let ts = now();
  let st = await getState();
  const plan = followPlan(await getTargets(), settings, st, ts);
  let visits = 0;
  const budget = settings.follow.checksPerRun;
  const handle = String(me || settings.account.handle || "").toLowerCase().replace(/^@/, "");

  if (plan.scan && handle) {
    if (await stopped()) return { did: "aborted" };
    visits++;
    const r = await scanFollowers(tabId, settings, handle, plan.deep, stopped);
    if (r.stop) return r;
    if (r.aborted) return { did: "aborted" }; // not recorded as a scan: the next run reads the list again
    if (r.budget) return null; // the engine waits for room under the page-load budget; nothing to record
    if (!r.ok) {
      await patchState({ followersScanRetryAt: now() + SCAN_RETRY_MS });
      log("warn", "Follow check: could not read your followers list (" + (r.soft || "unknown") + ") - will retry");
    } else {
      ts = now();
      let found = 0;
      if (r.followers.size) {
        await updateTargets((all) => {
          for (const h of r.followers) if (Object.hasOwn(all, h)) { applyFollow(all[h], true, ts); found++; }
          return all;
        });
      }
      // No followers at all: nobody can follow back yet, so "does not follow you" readings are true. A list
      // too short to judge the badge is read again later instead of on every check.
      const verified = r.followers.size > 0 || r.empty;
      await patchState({ followersScanAt: ts, followersScanRetryAt: verified ? null : ts + 2 * HOUR, followBadgeOkAt: verified ? ts : st.followBadgeOkAt });
      if (found) log("info", `Follow check: ${found} target${found === 1 ? "" : "s"} found in your followers list`);
    }
    await sleep(humanDelay(2000, 5000));
  }

  st = await getState();
  if (!badgeTrusted(st, now())) {
    // Nobody is marked "doesn't follow you" (so nobody gets comments) until the badge is verified again.
    if (plan.profiles.length && (!st.followWaitLoggedAt || now() - st.followWaitLoggedAt > HOUR)) {
      await patchState({ followWaitLoggedAt: now() });
      log("warn", "Follow check: waiting for a readable followers list before checking profiles");
    }
  } else {
    const targetsNow = await getTargets();
    const next = followPlan(targetsNow, settings, st, now());
    const todo = [...next.profiles, ...next.verify].slice(0, Math.max(0, budget - visits));
    for (const p of todo) {
      if (await stopped()) return { did: "aborted" };
      visits++;
      const r = await refreshProfile(tabId, p.handle, settings, { shouldStop: stopped }); // also checked inside the visit
      if (r && r.stop) return r;
      if (r && r.aborted) return { did: "aborted" };
      if (r && r.budget) { visits--; break; } // page-load budget reached: nothing was loaded, the check stays due
      ts = now();
      if (p.why === "verify") {
        await updateTargets((all) => {
          if (Object.hasOwn(all, p.handle)) all[p.handle].rel = { ...(all[p.handle].rel || {}), verifiedAt: ts }; // the 24 h cap
          return all;
        });
      }
      if (r && r.ok && r.notFound) {
        await updateTargets((all) => {
          const t = Object.hasOwn(all, p.handle) ? all[p.handle] : null;
          if (t) { t.rel = { ...(t.rel || {}), gone: true, checkedAt: ts }; t.enabled = false; }
          return all;
        });
        log("info", `@${p.handle}: profile not found (suspended, deleted or renamed) - target turned off`);
      } else if (!r || !r.ok) {
        await updateTargets((all) => {
          const t = Object.hasOwn(all, p.handle) ? all[p.handle] : null;
          if (t) t.rel = { ...(t.rel || {}), followCheckAfter: ts + 2 * HOUR };
          return all;
        });
      } else {
        if (r.profile && r.profile.followsYou) await patchState({ followBadgeOkAt: ts });
        if (p.why === "give_up") {
          const cur = (await getTargets())[p.handle];
          if (cur && giveUpDue(cur, settings, ts)) await giveUp(p.handle, settings, ts);
        }
      }
      await sleep(humanDelay(3000, 8000));
    }
  }

  await processFollowBacks(settings);
  if (!visits) return null;
  const left = followPlan(await getTargets(), settings, await getState(), now()).counts.checking;
  return { did: "follow", visits, checkingLeft: left };
}
