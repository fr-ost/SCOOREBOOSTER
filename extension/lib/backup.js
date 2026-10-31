// ScoreX - export / import as JSON. API keys (sx.secrets) are never exported or imported.

import { K, VERSION, STATUS, HS, OPEN_STATUSES } from "./constants.js";
import { load, save, remove, update, getSettings, saveSettings, sanitizeSettings, updateTargets, updateBlacklist, updateCandidates, getTargets, getBlacklist, CANDIDATES_CAP, DEFAULT_STATE, noteReset } from "./store.js";
import * as H from "./history.js";
import { db, STORES } from "./db.js";
import { now, normalizeHandle } from "./util.js";
import { newTarget, sanitizePatch } from "./targets.js";
import { sumCalls } from "./costs.js";

// Size limits for imported files (an imported file is untrusted; chrome.storage.local has a 10 MB quota that the
// engine's own state shares, so a huge import must not fill it).
const MAX_IMPORT_TARGETS = 5000;
const MAX_IMPORT_BLACKLIST = 20000;
const MAX_IMPORT_HISTORY = 50000;

export async function exportData(parts = ["settings", "targets", "history"]) {
  const out = { app: "ScoreX", version: VERSION, exportedAt: new Date(now()).toISOString() };
  if (parts.includes("settings")) out.settings = await getSettings();
  if (parts.includes("targets")) { out.targets = await load(K.targets, {}); out.blacklist = await load(K.blacklist, {}); }
  if (parts.includes("candidates")) out.candidates = await load(K.candidates, {});
  if (parts.includes("history")) out.history = await H.all();
  if (parts.includes("learning")) out.learning = await load(K.learning, {});
  if (out.settings && out.settings.secrets) delete out.settings.secrets;
  return { ok: true, data: out };
}

export async function importData(data, parts = ["settings", "targets", "history"]) {
  if (!data || typeof data !== "object") return { ok: false, error: "Not a ScoreX export" };
  const imported = {};
  if (parts.includes("settings") && data.settings) {
    const clean = sanitizeSettings(data.settings);
    delete clean.secrets;
    await saveSettings(clean);
    imported.settings = true;
  }
  if (parts.includes("targets") && data.targets && typeof data.targets === "object") {
    const me = normalizeHandle((await getSettings()).account.handle);
    // The blacklist first: the backup's entries join yours (yours win for accounts on both), and nothing on the
    // merged list comes back as a NEW target - a restored old backup must not re-add accounts given up on since.
    const cleanBl = {};
    if (data.blacklist && typeof data.blacklist === "object") {
      for (const [k, e] of Object.entries(data.blacklist).slice(0, MAX_IMPORT_BLACKLIST)) {
        const h = normalizeHandle((e && e.handle) || k);
        if (!h || !e || typeof e !== "object") continue;
        const at = Number(e.at);
        cleanBl[h] = { handle: h, name: String(e.name || "").slice(0, 80), reason: e.reason === "no_followback" ? "no_followback" : "manual", at: Number.isFinite(at) ? Math.min(at, now()) : now(), days: Number.isFinite(Number(e.days)) ? Number(e.days) : null, comments: Math.max(0, Number(e.comments) || 0), tier: Number(e.tier) === 1 ? 1 : Number(e.tier) === 2 ? 2 : null, followers: Number(e.followers) || null };
      }
    }
    let black = {};
    await updateBlacklist((cur) => {
      for (const [h, e] of Object.entries(cleanBl)) if (!Object.hasOwn(cur, h)) cur[h] = e;
      black = { ...cur };
      return cur;
    });
    const added = new Set();
    let skipped = 0;
    await updateTargets((all) => {
      for (const [k, t] of Object.entries(data.targets).slice(0, MAX_IMPORT_TARGETS)) {
        const h = normalizeHandle((t && t.handle) || k);
        if (!h || !t || typeof t !== "object" || h === me) continue;
        const cur = Object.hasOwn(all, h) ? all[h] : null;
        if (!cur && Object.hasOwn(black, h)) { skipped++; continue; }
        const wasManualTier = !!(cur && cur.tierManual);
        const manualPriority = cur && cur.priorityManual ? cur.priority : null;
        // Only user-editable fields + scraped data; relationship timing (used by cleanup) is re-observed.
        // Follow status is not imported either: every imported target is checked on X again.
        const base = cur || newTarget(h, { tier: t.tier, source: "import" });
        Object.assign(base, sanitizePatch(t));
        // sanitizePatch marks every priority as set by hand: only the ones that were stay so (self-learning sets the
        // rest). A priority you set here wins over an automatic one from the backup.
        if (t.priorityManual === true && Object.hasOwn(t, "priority")) base.priorityManual = true;
        else if (manualPriority != null) { base.priority = manualPriority; base.priorityManual = true; }
        else delete base.priorityManual;
        // sanitizePatch marks every tier as chosen by hand; after a restore only the tiers that were manual stay
        // manual (otherwise self-learning would never move any imported target to tier 1).
        if (t.tierManual === true || wasManualTier) base.tierManual = true; else delete base.tierManual;
        if (t.profile && typeof t.profile === "object") base.profile = sanitizeData(t.profile);
        if (Array.isArray(t.recentPosts)) base.recentPosts = t.recentPosts.slice(0, 5).map(sanitizeData);
        if (t.score && typeof t.score === "object") base.score = sanitizeData(t.score);
        all[h] = base;
        added.add(h);
      }
      for (const h of Object.keys(cleanBl)) { delete all[h]; added.delete(h); }
      return all;
    });
    imported.targets = added.size;
    if (skipped) imported.blacklisted = skipped; // on your blacklist: not added (remove them from the blacklist first)
    if (data.blacklist && typeof data.blacklist === "object") imported.blacklist = Object.keys(cleanBl).length;
  }
  if (parts.includes("history") && Array.isArray(data.history)) {
    const existing = new Set((await H.all()).map((r) => r.id));
    const recs = data.history.slice(0, MAX_IMPORT_HISTORY).map(cleanHistoryRecord).filter((r) => r && !existing.has(r.id));
    await db().putMany(STORES.history, recs);
    imported.history = recs.length;
  }
  if (parts.includes("candidates") && data.candidates && typeof data.candidates === "object") {
    // Under the candidates lock (a running smart-follower search writes them too) and capped like every other write
    // (CANDIDATES_CAP newest / best). Your targets, blacklisted accounts and your own handle are not candidates.
    const me = normalizeHandle((await getSettings()).account.handle);
    const [targetsNow, blackNow] = await Promise.all([getTargets(), getBlacklist()]);
    const mine = new Set();
    const after = await updateCandidates((all) => {
      for (const [k, c] of Object.entries(data.candidates).slice(0, 2 * CANDIDATES_CAP)) {
        const h = normalizeHandle((c && c.handle) || k);
        if (!h || !c || typeof c !== "object" || h === me || Object.hasOwn(targetsNow, h) || Object.hasOwn(blackNow, h)) continue;
        all[h] = { ...sanitizeData(c), handle: h };
        mine.add(h);
      }
      return all;
    });
    imported.candidates = [...mine].filter((h) => Object.hasOwn(after, h)).length;
  }
  if (parts.includes("learning") && data.learning && typeof data.learning === "object") {
    const at = Number(data.learning.abResetAt);
    await save({ [K.learning]: { abResetAt: Number.isFinite(at) ? Math.min(at, now()) : 0 } });
    imported.learning = true;
  }
  return { ok: true, imported };
}

// ---------- import sanitising (an imported file is untrusted) ----------

// Plain JSON data only: primitives, arrays and objects, no prototype keys, bounded size.
function sanitizeData(v, depth = 0) {
  if (v == null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return v.slice(0, 2000);
  if (depth > 4) return null;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => sanitizeData(x, depth + 1));
  if (typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, 60)) if (!["__proto__", "constructor", "prototype"].includes(k)) out[k] = sanitizeData(x, depth + 1);
    return out;
  }
  return null;
}
const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const tsOk = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(n, now()) : null; };
const numOk = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const FINAL = [HS.POSTED, HS.SKIPPED, HS.FAILED];

// History records keep their data, but imported items can never enter the posting queue: open statuses
// become "skipped (imported)", schedule fields are dropped, and the post URL is rebuilt from handle + id.
export function cleanHistoryRecord(r) {
  if (!r || typeof r !== "object") return null;
  const id = str(r.id, 64);
  const createdAt = tsOk(r.createdAt);
  const target = normalizeHandle(r.target);
  if (!id || !createdAt || !target) return null;
  const postId = /^\d{5,25}$/.test(String(r.postId || "")) ? String(r.postId) : "";
  const status = FINAL.includes(r.status) ? r.status : HS.SKIPPED;
  const replyId = /^\d{5,25}$/.test(String(r.replyId || "")) ? String(r.replyId) : "";
  const calls = Array.isArray(r.calls) ? r.calls.slice(0, 10).map((c) => ({
    kind: str(c && c.kind, 20), modelId: str(c && c.modelId, 64), modelName: str(c && c.modelName, 80), effort: str(c && c.effort, 10),
    usage: { input: numOk(c && c.usage && c.usage.input), cached: numOk(c && c.usage && c.usage.cached), cacheWrite: numOk(c && c.usage && c.usage.cacheWrite), output: numOk(c && c.usage && c.usage.output), reasoning: numOk(c && c.usage && c.usage.reasoning) },
    cost: numOk(c && c.cost), ms: numOk(c && c.ms), ok: !!(c && c.ok), ts: tsOk(c && c.ts),
  })) : [];
  const res = r.results && typeof r.results === "object" ? r.results : {};
  const rec = {
    id, createdAt, updatedAt: now(), status,
    reason: FINAL.includes(r.status) ? str(r.reason, 300) : "Imported (was " + str(r.status, 20) + ")",
    mode: r.mode === "auto" ? "auto" : "review",
    target, targetName: str(r.targetName, 80), group: r.group === "A" ? "A" : "B", tier: Number(r.tier) === 1 ? 1 : 2,
    postId, postUrl: postId ? `https://x.com/${target}/status/${postId}` : "", postText: str(r.postText, 1200), postLang: str(r.postLang, 10),
    postCreatedAt: tsOk(r.postCreatedAt), postedAt: status === HS.POSTED ? tsOk(r.postedAt) : null, scheduledFor: null, approvedAt: null,
    tone: str(r.tone, 60), preset: str(r.preset, 20), modelId: str(r.modelId, 64), modelName: str(r.modelName, 80), effort: str(r.effort, 10),
    abArm: r.abArm ? str(r.abArm, 100) : null, comment: str(r.comment, 1000), originalComment: str(r.originalComment, 1000), edited: !!r.edited,
    attempts: Math.max(0, Math.min(10, Math.round(numOk(r.attempts)))), calls, liked: !!r.liked, likedAt: tsOk(r.likedAt),
    replyId, replyUrl: replyId ? `https://x.com/${normalizeHandle(String(r.replyUrl || "").split("/")[3]) || "i"}/status/${replyId}` : "",
    maybePosted: !!r.maybePosted,
    results: { likes: numOk(res.likes), replies: numOk(res.replies), views: res.views == null || !Number.isFinite(Number(res.views)) ? null : Math.max(0, Number(res.views)), authorReplied: !!res.authorReplied, followedBack: !!res.followedBack, followBackAt: tsOk(res.followBackAt), checkedAt: tsOk(res.checkedAt), checks: numOk(res.checks), ...(res.gone ? { gone: true } : {}) },
  };
  const { usage, cost } = sumCalls(rec.calls);
  rec.tokens = usage; rec.cost = cost;
  return rec;
}

// Clears history but keeps what the safety limits depend on: comments posted (or probably posted) in the
// last 8 days and items still in the queue. Without them the daily / per-target limits would reset.
// Skipped and failed records of the last 8 days are shortened like the retention does (lib/history.js
// compactRecord), not deleted: their post id is the engine's only "post already handled" mark (a post you skipped
// must not get a new reply from catch-up, whose window is at most 168 h), and their attempts keep counting toward
// today's generation limit.
export async function clearHistory() {
  const keepSince = now() - 8 * 864e5;
  let removed = 0, kept = 0, shortened = 0;
  for (const r of await H.all()) {
    const recentPost = (r.status === HS.POSTED || r.maybePosted) && (r.postedAt || r.attemptAt || r.createdAt) >= keepSince;
    if (recentPost || OPEN_STATUSES.includes(r.status)) { kept++; continue; }
    if ((r.status === HS.SKIPPED || r.status === HS.FAILED) && r.createdAt >= keepSince) {
      const short = H.compactRecord(r);
      if (r.attempts > 0) short.attempts = r.attempts;
      if (Object.keys(short).length !== Object.keys(r).length) { await db().put(STORES.history, short); shortened++; }
      kept++;
      continue;
    }
    await H.remove(r.id);
    removed++;
  }
  return { ok: true, removed, kept, shortened };
}

// Factory reset of everything except API keys and what the safety limits depend on: comments posted in the
// last 8 days (rolling 24h / 7-day caps) and the spend ledger (monthly budget). The ramp starts again.
export async function resetAll() {
  // First: a score job still running (smart-follower search, target scores) stops before its next request and does
  // not write its results back into the lists cleared here (lib/scoreboard.js).
  noteReset();
  // Provider overrides are your config like the selector overrides, conversation alerts are worker data: both go.
  await remove([K.settings, K.targets, K.candidates, K.blacklist, K.seen, K.logs, K.discovery, K.selectorOverrides, K.providerOverrides, K.learning, K.conversations, K.state]);
  // Score history, checks and smart-follower lists go; today's request counts per provider stay (like the spend
  // ledger they protect a cap: a reset must not let a provider be asked past its daily cap).
  await update(K.scoreboard, {}, (b) => (b && b.usage && typeof b.usage === "object" ? { usage: b.usage } : {}));
  const keepSince = now() - 8 * 864e5;
  for (const r of await H.all()) {
    // Everything that counts toward the limits stays: posted, probably posted (maybePosted) and a post still in
    // flight (status posting - the stop that precedes a reset may come after X already accepted it).
    const counts = r.status === HS.POSTED || r.status === HS.POSTING || !!r.maybePosted;
    const recentPost = counts && (r.postedAt || r.attemptAt || r.updatedAt || r.createdAt) >= keepSince;
    if (recentPost) {
      if (r.status === HS.POSTING) await H.patch(r.id, (cur) => (cur.status === HS.POSTING ? { status: HS.FAILED, maybePosted: true, reason: "Reset while posting - check the post manually" } : null));
      else if (OPEN_STATUSES.includes(r.status)) await H.patch(r.id, (cur) => (OPEN_STATUSES.includes(cur.status) ? { status: HS.SKIPPED, reason: "Reset" } : null));
      continue;
    }
    await H.remove(r.id);
  }
  await db().clear(STORES.events).catch(() => {});
  await save({ [K.state]: { ...DEFAULT_STATE, status: STATUS.STOPPED } });
  return { ok: true };
}
