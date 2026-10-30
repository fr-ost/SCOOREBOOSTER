// ScoreX - new post detection through the x.com page (no X API).
// Strategies (Settings > Watch):
//   list      one X List page shows the latest posts of every member: 1 page view covers all targets (best)
//   search    Latest search "(from:a OR from:b ...) -filter:replies" in batches of N targets
//   rotation  visit a few target profiles per check (slow for many targets; also refreshes their profiles)

import { CMD, STOP, STATUS } from "./constants.js";
import { navigate, send, waitForPage } from "./tabs.js";
import { pageVerdict } from "./guard.js";
import { mergePosts, applyProfile, isActive, followStatus, FS } from "./targets.js";
import { getSeen, markSeen, updateTargets, getState, patchState, log } from "./store.js";
import { badgeTrusted } from "./follow.js";
import { notify } from "./notify.js";
import { MIN, HOUR, now, sleep, humanDelay, randInt } from "./util.js";

// A list that X answered with "this page doesn't exist" is skipped (batched search is used instead) for this
// long, then tried again.
export const DEAD_LIST_RETRY_MS = 6 * HOUR;

export function listUrl(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/lists\/(\d{5,25})/) || s.match(/^(\d{5,25})$/);
  return m ? `https://x.com/i/lists/${m[1]}` : null;
}

// A "does not follow you" reading only counts while X's "Follows you" badge was recently seen working (the
// followers-list check in follow.js). Otherwise it stays unknown: a checking target is not turned into "not
// following" and a follower is not counted toward the downgrade. A badge that was seen is always applied.
export function trustedFollowReading(profile, st, ts = now()) {
  if (profile && profile.followsYou === false && !badgeTrusted(st || {}, ts)) return { ...profile, followsYou: null };
  return profile;
}

export function searchUrl(handles) {
  const q = "(" + handles.map((h) => "from:" + h).join(" OR ") + ") -filter:replies";
  return "https://x.com/search?q=" + encodeURIComponent(q) + "&f=live&src=typed_query";
}

// Targets ordered for batching: tier 1 and high priority first so they are checked in the earliest batch.
export function orderTargets(targets) {
  return targets.slice().sort((a, b) => (a.tier - b.tier) || ((b.priority || 0) - (a.priority || 0)) || a.handle.localeCompare(b.handle));
}
export function batches(targets, size) {
  const out = [];
  const ordered = orderTargets(targets);
  for (let i = 0; i < ordered.length; i += size) out.push(ordered.slice(i, i + size).map((t) => t.handle));
  return out;
}

// Which source to check this tick (round-robin over lists / search batches / rotation picks).
// deadLists: { [listUrl]: ts } lists X recently reported as missing; they are skipped until DEAD_LIST_RETRY_MS.
export function planSource(settings, targets, cursor, ts = now(), deadLists = {}) {
  const w = settings.watch;
  const active = targets.filter((t) => isActive(t, settings, ts));
  if (!active.length) return null;
  if (w.strategy === "list") {
    const dead = deadLists || {};
    const urls = w.listUrls.map(listUrl).filter(Boolean).filter((u) => !(dead[u] && ts - dead[u] < DEAD_LIST_RETRY_MS));
    if (urls.length) return { kind: "list", url: urls[cursor % urls.length], label: "X List", next: cursor + 1 };
    // fall back to search when no valid (or no reachable) list URL is configured
  }
  if (w.strategy === "rotation") {
    const picks = active
      .slice()
      .sort((a, b) => ((a.lastCheckedAt || 0) - (a.tier === 1 ? 20 * MIN : 0)) - ((b.lastCheckedAt || 0) - (b.tier === 1 ? 20 * MIN : 0)))
      .slice(0, w.rotationPerTick)
      .map((t) => t.handle);
    return { kind: "rotation", handles: picks, label: "profiles " + picks.map((h) => "@" + h).join(", "), next: cursor + 1 };
  }
  const bs = batches(active, w.searchBatchSize);
  const i = cursor % bs.length;
  return { kind: "search", url: searchUrl(bs[i]), handles: bs[i], label: `search batch ${i + 1}/${bs.length}`, next: cursor + 1 };
}

const NEVER = async () => false;
const ABORTED = { ok: false, aborted: true };

// shouldStop() (Pause/Stop pressed) is checked before every navigation and every scroll.
async function scrollAFew(tabId, n, stopped = NEVER) {
  for (let i = 0; i < n; i++) {
    await sleep(humanDelay(1200, 3200));
    if (await stopped()) return false;
    await send(tabId, CMD.SCROLL, {}, 8000);
  }
  if (n) await sleep(humanDelay(800, 1800));
  return true;
}

// navigate() refused by the X page-load budget (settings.safety.maxPageLoads24h): nothing was loaded, the caller waits.
const navFailed = (nav) => ({ ok: false, soft: nav.error, ...(nav.budget ? { budget: true, until: nav.until } : {}) });

// Visit one watch page and return its posts. Never acts on the page.
async function readPage(tabId, url, settings, stopped = NEVER) {
  if (await stopped()) return ABORTED;
  const nav = await navigate(tabId, url);
  if (!nav.ok) return navFailed(nav);
  const w = await waitForPage(tabId, ["tweet", "emptyState"], 20000);
  const v = pageVerdict(w.page, settings);
  if (v && v.stop) return { ok: false, stop: v.stop, detail: v.detail };
  if (v && v.notFound) return { ok: true, posts: [], notFound: true, detail: v.detail, page: w.page };
  await sleep(humanDelay(1500, 3500)); // glance at the page like a person would
  if (!(await scrollAFew(tabId, settings.watch.scrolls, stopped))) return ABORTED;
  if (w.ok && w.key === "emptyState") return { ok: true, posts: [], articleCount: 0, unparsed: 0, emptyResult: true, page: w.page };
  if (await stopped()) return ABORTED;
  const r = await send(tabId, CMD.SCRAPE_TWEETS, { limit: 50 }, 20000);
  const v2 = pageVerdict(r.page, settings);
  if (v2 && v2.stop) return { ok: false, stop: v2.stop, detail: v2.detail };
  if (!r.ok) return { ok: false, soft: r.error || "scrape_failed", page: r.page };
  if (v2 && v2.soft === "error_page") return { ok: false, soft: "error_page", detail: v2.detail, page: r.page };
  return { ok: true, posts: r.tweets || [], articleCount: r.articleCount || 0, unparsed: r.unparsed || 0, emptyResult: !!r.emptyState, page: r.page };
}

// purpose: the footprint ledger's page-load purpose (lib/tabs.js); left out, the engine's current job decides.
async function readProfile(tabId, handle, settings, stopped = NEVER, purpose) {
  if (await stopped()) return ABORTED;
  const nav = await navigate(tabId, `https://x.com/${handle}`, purpose ? { purpose } : undefined);
  if (!nav.ok) return navFailed(nav);
  const w = await waitForPage(tabId, ["profileUserName", "emptyState"], 20000);
  const v = pageVerdict(w.page, settings);
  if (v && v.stop) return { ok: false, stop: v.stop, detail: v.detail };
  if (v && v.notFound) return { ok: true, notFound: true, posts: [] };
  await sleep(humanDelay(1200, 3000));
  if (settings.watch.scrolls && !(await scrollAFew(tabId, 1, stopped))) return ABORTED;
  if (await stopped()) return ABORTED;
  const r = await send(tabId, CMD.SCRAPE_PROFILE, {}, 20000);
  const v2 = pageVerdict(r.page, settings);
  if (v2 && v2.stop) return { ok: false, stop: v2.stop, detail: v2.detail };
  if (!r.ok || !r.profile) return { ok: false, soft: "profile_not_rendered", page: r.page };
  return { ok: true, profile: r.profile, posts: r.tweets || [], page: r.page };
}

// X answered a watched list with "this page doesn't exist" (mistyped, deleted, or someone else's private list):
// skip it for a while (batched search covers the targets meanwhile) and tell the user once.
async function markListMissing(url, detail) {
  const ts = now();
  let warn = false;
  await patchState((s) => {
    const dead = { ...(s.deadLists || {}) };
    for (const [u, at] of Object.entries(dead)) if (ts - at > 7 * 24 * HOUR) delete dead[u];
    warn = !dead[url] || ts - dead[url] >= DEAD_LIST_RETRY_MS;
    dead[url] = ts;
    return { deadLists: dead };
  });
  const msg = `X List not found or not accessible (${url}) - check Settings > Watch. Using a batched search meanwhile.`;
  log("warn", msg, detail || "");
  if (warn) await notify("sx-list-missing", "ScoreX: X List not found", msg);
}

// The engine only watches while it runs: Pause/Stop end a watch check at the next page step.
const engineStopped = async () => (await getState()).status !== STATUS.RUNNING;

/**
 * One watch check. Returns { ok, posts (fresh candidates, newest first), waiting (too fresh, retry soon),
 * scanned, source, page (last page report), stop?, soft?, hiddenEmpty?, aborted? }
 * opts.shouldStop(): Pause/Stop pressed (default: the engine is no longer running). It is checked before every
 * navigation and scroll; an aborted check returns { ok:true, aborted:true, posts:[] } and touches no state.
 * A watched X List that does not exist returns { ok:false, soft:"list_not_found" } (and is skipped for a while).
 */
export async function watchOnce(tabId, settings, targetsMap, ts = now(), opts = {}) {
  const stopped = opts.shouldStop || engineStopped;
  const st = await getState();
  const targets = Object.values(targetsMap);
  const plan = planSource(settings, targets, st.watchCursor || 0, ts, st.deadLists);
  if (!plan) return { ok: true, posts: [], waiting: [], scanned: 0, source: null, idle: "no_active_targets" };
  const aborted = { ok: true, aborted: true, posts: [], waiting: [], scanned: 0, source: plan.label };
  if (await stopped()) return aborted;
  await patchState({ watchCursor: plan.next });

  let posts = [];
  let pageInfo = null;
  let lastPage = null;
  const profileUpdates = {};
  if (plan.kind === "rotation") {
    for (const h of plan.handles) {
      const r = await readProfile(tabId, h, settings, stopped, "watch");
      if (r.aborted) return aborted;
      if (r.stop) return { ok: false, stop: r.stop, detail: r.detail, source: plan.label };
      if (r.budget) return { ok: false, soft: r.soft, budget: true, until: r.until, source: plan.label };
      if (r.page) lastPage = r.page;
      if (r.ok) { posts.push(...(r.posts || [])); if (r.profile) profileUpdates[h] = { profile: r.profile, posts: r.posts }; }
      await sleep(humanDelay(2000, 6000));
    }
  } else {
    const r = await readPage(tabId, plan.url, settings, stopped);
    if (r.aborted) return aborted;
    if (r.stop) return { ok: false, stop: r.stop, detail: r.detail, source: plan.label };
    if (plan.kind === "list" && r.notFound) {
      await markListMissing(plan.url, r.detail);
      return { ok: false, soft: "list_not_found", detail: "X List not found or not accessible - check Settings > Watch", source: plan.label, page: r.page };
    }
    if (!r.ok) return { ok: false, soft: r.soft, detail: r.detail, source: plan.label, page: r.page };
    posts = r.posts;
    pageInfo = r;
    lastPage = r.page || null;
  }
  if (await stopped()) return aborted;

  // Structural sanity: articles rendered but none could be parsed -> selectors are outdated.
  if (pageInfo && pageInfo.articleCount >= 3 && pageInfo.unparsed >= pageInfo.articleCount) {
    return { ok: false, stop: STOP.DOM_CHANGED, detail: `${pageInfo.articleCount} posts on the page but none could be read`, source: plan.label };
  }
  const realEmpty = !!(pageInfo && (pageInfo.notFound || pageInfo.emptyResult)); // X said "no results"
  const hiddenEmpty = !!(pageInfo && !pageInfo.articleCount && pageInfo.page && pageInfo.page.hidden && !realEmpty);
  const visibleEmpty = !!(pageInfo && !pageInfo.articleCount && pageInfo.page && !pageInfo.page.hidden && !realEmpty);

  // Update target caches (recent posts feed the prompt; profiles from rotation feed the ranking).
  const byAuthor = Object.create(null);
  for (const p of posts) if (!p.isRepost && Object.hasOwn(targetsMap, p.author)) (byAuthor[p.author] ||= []).push(p);
  if (Object.keys(byAuthor).length || Object.keys(profileUpdates).length) {
    const stNow = Object.keys(profileUpdates).length ? await getState() : st;
    await updateTargets((all) => {
      for (const [h, ps] of Object.entries(byAuthor)) if (all[h]) mergePosts(all[h], ps);
      for (const [h, u] of Object.entries(profileUpdates)) if (all[h]) applyProfile(all[h], trustedFollowReading(u.profile, stNow), u.posts, settings.scores.blendSorsa);
      for (const h of plan.handles || []) if (all[h]) all[h].lastCheckedAt = now();
      return all;
    });
  }

  const seen = await getSeen();
  const fresh = [], waiting = [], seenNow = [];
  const minAge = settings.watch.minPostAgeMin * MIN, maxAge = settings.watch.maxPostAgeMin * MIN;
  for (const p of posts) {
    if (!p.id || seen[p.id]) continue;
    const t = Object.hasOwn(targetsMap, p.author) ? targetsMap[p.author] : null;
    if (p.isRepost) continue; // the original may be another target's post: don't mark it seen
    // A target still waiting for its follow check may turn out not to follow you: look at it again later.
    if (t && t.enabled !== false && followStatus(t) === FS.CHECKING) continue;
    if (!t || !isActive(t, settings, ts)) { seenNow.push(p.id); continue; }
    const age = p.createdAt ? ts - p.createdAt : null;
    if (age != null && age < minAge) { waiting.push(p); continue; } // revisit next tick
    if (age != null && age > maxAge) { seenNow.push(p.id); continue; }
    fresh.push(p);
  }
  if (seenNow.length) await markSeen(seenNow);
  fresh.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (hiddenEmpty) log("warn", "The X tab rendered no posts while hidden. If this repeats, use Settings > Advanced > separate window, or allow bringing the tab to front.");
  return { ok: true, posts: fresh, waiting, scanned: posts.length, source: plan.label, hiddenEmpty, visibleEmpty, page: lastPage };
}

// Visit one profile to refresh a target (used for "refresh" buttons, follow-back checks, context).
// A "does not follow you" reading is applied only while the "Follows you" badge is trusted (see
// trustedFollowReading); followUntrusted:true in the result says it was left unknown.
// opts.shouldStop(): checked before the navigation and the scroll (aborted -> { ok:false, aborted:true }).
export async function refreshProfile(tabId, handle, settings, opts = {}) {
  const r = await readProfile(tabId, handle, settings, opts.shouldStop || NEVER);
  if (r.stop) return r;
  if (!r.ok) return r;
  if (r.notFound) return { ok: true, notFound: true };
  const profile = trustedFollowReading(r.profile, await getState(), now());
  await updateTargets((all) => {
    if (all[handle]) applyProfile(all[handle], profile, r.posts, settings.scores.blendSorsa);
    return all;
  });
  return { ok: true, profile, posts: r.posts, page: r.page, ...(profile !== r.profile ? { followUntrusted: true } : {}) };
}

export const _test = { readPage, readProfile, scrollAFew, randInt };
