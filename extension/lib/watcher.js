// ScoreX - new post detection through the x.com page (no X API).
// Strategies (Settings > Watch):
//   list      one X List page shows the latest posts of every member: 1 page view covers all targets (best)
//   search    Latest search "(from:a OR from:b ...) -filter:replies" in batches of N targets
//   rotation  visit a few target profiles per check (slow for many targets; also refreshes their profiles)

import { CMD, STOP } from "./constants.js";
import { navigate, send, waitForPage } from "./tabs.js";
import { pageVerdict } from "./guard.js";
import { mergePosts, applyProfile, isActive } from "./targets.js";
import { getSeen, markSeen, updateTargets, getState, patchState, log } from "./store.js";
import { MIN, now, sleep, humanDelay, randInt } from "./util.js";

export function listUrl(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/lists\/(\d{5,25})/) || s.match(/^(\d{5,25})$/);
  return m ? `https://x.com/i/lists/${m[1]}` : null;
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
export function planSource(settings, targets, cursor, ts = now()) {
  const w = settings.watch;
  const active = targets.filter((t) => isActive(t, settings, ts));
  if (!active.length) return null;
  if (w.strategy === "list") {
    const urls = w.listUrls.map(listUrl).filter(Boolean);
    if (urls.length) return { kind: "list", url: urls[cursor % urls.length], label: "X List", next: cursor + 1 };
    // fall back to search when no valid list URL is configured
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

async function scrollAFew(tabId, n) {
  for (let i = 0; i < n; i++) {
    await sleep(humanDelay(1200, 3200));
    await send(tabId, CMD.SCROLL, {}, 8000);
  }
  if (n) await sleep(humanDelay(800, 1800));
}

// Visit one watch page and return its posts. Never acts on the page.
async function readPage(tabId, url, settings) {
  const nav = await navigate(tabId, url);
  if (!nav.ok) return { ok: false, soft: nav.error };
  const w = await waitForPage(tabId, ["tweet", "emptyState"], 20000);
  const v = pageVerdict(w.page, settings);
  if (v && v.stop) return { ok: false, stop: v.stop, detail: v.detail };
  if (v && v.notFound) return { ok: true, posts: [], notFound: true, page: w.page };
  await sleep(humanDelay(1500, 3500)); // glance at the page like a person would
  await scrollAFew(tabId, settings.watch.scrolls);
  const r = await send(tabId, CMD.SCRAPE_TWEETS, { limit: 50 }, 20000);
  const v2 = pageVerdict(r.page, settings);
  if (v2 && v2.stop) return { ok: false, stop: v2.stop, detail: v2.detail };
  if (!r.ok) return { ok: false, soft: r.error || "scrape_failed", page: r.page };
  if (v2 && v2.soft === "error_page") return { ok: false, soft: "error_page", detail: v2.detail, page: r.page };
  return { ok: true, posts: r.tweets || [], articleCount: r.articleCount || 0, unparsed: r.unparsed || 0, page: r.page };
}

async function readProfile(tabId, handle, settings) {
  const nav = await navigate(tabId, `https://x.com/${handle}`);
  if (!nav.ok) return { ok: false, soft: nav.error };
  const w = await waitForPage(tabId, ["profileUserName", "emptyState"], 20000);
  const v = pageVerdict(w.page, settings);
  if (v && v.stop) return { ok: false, stop: v.stop, detail: v.detail };
  if (v && v.notFound) return { ok: true, notFound: true, posts: [] };
  await sleep(humanDelay(1200, 3000));
  if (settings.watch.scrolls) await scrollAFew(tabId, 1);
  const r = await send(tabId, CMD.SCRAPE_PROFILE, {}, 20000);
  const v2 = pageVerdict(r.page, settings);
  if (v2 && v2.stop) return { ok: false, stop: v2.stop, detail: v2.detail };
  if (!r.ok || !r.profile) return { ok: false, soft: "profile_not_rendered", page: r.page };
  return { ok: true, profile: r.profile, posts: r.tweets || [], page: r.page };
}

/**
 * One watch check. Returns { ok, posts (fresh candidates, newest first), waiting (too fresh, retry soon),
 * scanned, source, stop?, soft?, hiddenEmpty? }
 */
export async function watchOnce(tabId, settings, targetsMap, ts = now()) {
  const st = await getState();
  const targets = Object.values(targetsMap);
  const plan = planSource(settings, targets, st.watchCursor || 0, ts);
  if (!plan) return { ok: true, posts: [], waiting: [], scanned: 0, source: null, idle: "no_active_targets" };
  await patchState({ watchCursor: plan.next });

  let posts = [];
  let pageInfo = null;
  const profileUpdates = {};
  if (plan.kind === "rotation") {
    for (const h of plan.handles) {
      const r = await readProfile(tabId, h, settings);
      if (r.stop) return { ok: false, stop: r.stop, detail: r.detail, source: plan.label };
      if (r.ok) { posts.push(...(r.posts || [])); if (r.profile) profileUpdates[h] = { profile: r.profile, posts: r.posts }; }
      await sleep(humanDelay(2000, 6000));
    }
  } else {
    const r = await readPage(tabId, plan.url, settings);
    if (r.stop) return { ok: false, stop: r.stop, detail: r.detail, source: plan.label };
    if (!r.ok) return { ok: false, soft: r.soft, detail: r.detail, source: plan.label, page: r.page };
    posts = r.posts;
    pageInfo = r;
  }

  // Structural sanity: articles rendered but none could be parsed -> selectors are outdated.
  if (pageInfo && pageInfo.articleCount >= 3 && pageInfo.unparsed >= pageInfo.articleCount) {
    return { ok: false, stop: STOP.DOM_CHANGED, detail: `${pageInfo.articleCount} posts on the page but none could be read`, source: plan.label };
  }
  const hiddenEmpty = !!(pageInfo && !pageInfo.articleCount && pageInfo.page && pageInfo.page.hidden && !pageInfo.notFound);
  const visibleEmpty = !!(pageInfo && !pageInfo.articleCount && pageInfo.page && !pageInfo.page.hidden && !pageInfo.notFound);

  // Update target caches (recent posts feed the prompt; profiles from rotation feed the ranking).
  const byAuthor = {};
  for (const p of posts) if (!p.isRepost && targetsMap[p.author]) (byAuthor[p.author] ||= []).push(p);
  if (Object.keys(byAuthor).length || Object.keys(profileUpdates).length) {
    await updateTargets((all) => {
      for (const [h, ps] of Object.entries(byAuthor)) if (all[h]) mergePosts(all[h], ps);
      for (const [h, u] of Object.entries(profileUpdates)) if (all[h]) applyProfile(all[h], u.profile, u.posts, settings.scores.blendSorsa);
      for (const h of plan.handles || []) if (all[h]) all[h].lastCheckedAt = now();
      return all;
    });
  }

  const seen = await getSeen();
  const fresh = [], waiting = [], seenNow = [];
  const minAge = settings.watch.minPostAgeMin * MIN, maxAge = settings.watch.maxPostAgeMin * MIN;
  for (const p of posts) {
    if (!p.id || seen[p.id]) continue;
    const t = targetsMap[p.author];
    if (!t || !isActive(t, settings, ts) || p.isRepost) { seenNow.push(p.id); continue; }
    const age = p.createdAt ? ts - p.createdAt : null;
    if (age != null && age < minAge) { waiting.push(p); continue; } // revisit next tick
    if (age != null && age > maxAge) { seenNow.push(p.id); continue; }
    fresh.push(p);
  }
  if (seenNow.length) await markSeen(seenNow);
  fresh.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (hiddenEmpty) log("warn", "The X tab rendered no posts while hidden. If this repeats, use Settings > Advanced > separate window, or allow bringing the tab to front.");
  return { ok: true, posts: fresh, waiting, scanned: posts.length, source: plan.label, hiddenEmpty, visibleEmpty };
}

// Visit one profile to refresh a target (used for "refresh" buttons, follow-back checks, context).
export async function refreshProfile(tabId, handle, settings) {
  const r = await readProfile(tabId, handle, settings);
  if (r.stop) return r;
  if (!r.ok) return r;
  if (r.notFound) return { ok: true, notFound: true };
  await updateTargets((all) => {
    if (all[handle]) applyProfile(all[handle], r.profile, r.posts, settings.scores.blendSorsa);
    return all;
  });
  return { ok: true, profile: r.profile, posts: r.posts };
}

export const _test = { readPage, readProfile, randInt };
