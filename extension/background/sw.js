// ScoreX service worker: wires Chrome events to the engine and answers dashboard/popup messages.
// Everything is persisted (chrome.storage + IndexedDB), so this file is safe to be killed and restarted
// at any time; on startup it re-arms the alarms and continues if the engine was running.

import { ALARM, MSG, STATUS, STOP, K } from "../lib/constants.js";
import { ensureDefaults, getSettings, getSecrets, getTargets, getState, patchState, updateCandidates, log, load, save } from "../lib/store.js";
import * as engine from "../lib/engine.js";
import * as T from "../lib/targets.js";
import * as SDB from "../lib/smartdb.js";
import { onContentReady, onTabRemoved } from "../lib/tabs.js";
import { runDiscovery, cancelDiscovery, candidatesToTargets } from "../lib/discovery.js";
import { testModel, buildInstructions, buildInput, generate } from "../lib/generator.js";
import { testSorsa, refreshScores } from "../lib/sorsa.js";
import { summary as learningSummary, resetAb } from "../lib/learning.js";
import { preview as cleanupPreview } from "../lib/cleanup.js";
import { exportData, importData, clearHistory, resetAll } from "../lib/backup.js";
import { blacklistAdd, blacklistRemove } from "../lib/follow.js";
import { normalizeHandle, now, sleep } from "../lib/util.js";
import * as H from "../lib/history.js";
import { recordSpend, getSpend, budgetStatus } from "../lib/costs.js";
import * as SB from "../lib/scoreboard.js";
import { runSelfTest } from "../lib/diagnostics.js";
import { closeStaleReaderTab } from "../lib/pagereader.js";
import { markDone as conversationDone } from "../lib/conversations.js";
import * as LIC from "../lib/license.js";
import * as FB from "../lib/followbacks.js";
import { notify } from "../lib/notify.js";

const EXT_ORIGIN = chrome.runtime.getURL("");

// ---------- lifecycle ----------

chrome.runtime.onInstalled.addListener(async (details) => {
  await ensureDefaults();
  await engine.ensureAlarms();
  await ensureScoresAlarm();
  await engine.refreshBadge();
  if (details.reason === "install") chrome.runtime.openOptionsPage().catch(() => {});
});

chrome.runtime.onStartup.addListener(async () => {
  // Auto-resume after a Chrome restart: a running engine keeps running; safety stops stay stopped.
  await ensureDefaults();
  const st = await getState();
  if (st.status === STATUS.RUNNING) log("info", "Chrome restarted - resuming");
  await engine.ensureAlarms();
  await ensureScoresAlarm();
  await engine.refreshBadge();
});

chrome.alarms.onAlarm.addListener((a) => {
  licensedNow().then((ok) => {
    if (!ok) return; // locked: nothing is watched, written or posted
    if (a.name === ALARM.TICK) engine.tick("alarm");
    else if (a.name === ALARM.WATCHDOG) engine.watchdog();
    else if (a.name === ALARM.SCORES) {
      autoRefreshScores().catch((e) => log("warn", "Score refresh failed: " + e.message));
      maintainHistory().catch((e) => log("warn", "History retention failed: " + e.message));
    }
  });
});

// ---------- license (lib/license.js) ----------
// Every alarm and every request from the dashboard / popup goes through the license first. The server is asked at
// most every 6 hours (LIC.verify); between checks this only reads chrome.storage.
async function licensedNow() {
  const st = await LIC.verify().catch(() => ({ ok: false, message: "License check failed" }));
  if (!st.ok) await onLocked(st);
  return !!st.ok;
}
// Locked while running (revoked, reset, 3 days offline): pause, say why once.
async function onLocked(st) {
  const s = await getState();
  if (s.status !== STATUS.RUNNING) return;
  await engine.pause().catch(() => {});
  log("warn", "ScoreX paused: " + (st.message || "the license is not active"));
  notify("sx-license", "ScoreX is locked", st.message || "The license is not active on this browser.").catch(() => {});
}
const LICENSE_FREE = new Set(["licenseState", "licenseActivate", "licenseCheck", "licenseRemove"]);

// History retention (settings.history), at most about once a day; rides on the 4-hourly scores alarm.
async function maintainHistory() {
  const st = await getState();
  if (st.lastHistoryMaintAt && now() - st.lastHistoryMaintAt < 20 * 3600e3) return;
  await patchState({ lastHistoryMaintAt: now() });
  const r = await H.maintain(await getSettings());
  if (r && (r.compacted || r.deleted)) log("info", `History tidied: ${r.compacted} old records compacted, ${r.deleted} removed`);
}

// Your own scores on the enabled providers, about once a day (refreshOwn skips anything newer than 20 h).
async function ensureScoresAlarm() {
  try { if (!(await chrome.alarms.get(ALARM.SCORES))) await chrome.alarms.create(ALARM.SCORES, { delayInMinutes: 3, periodInMinutes: 240 }); } catch (_) {}
}
async function autoRefreshScores() {
  const settings = await getSettings();
  if (!settings.scores.autoRefreshOwn || !Object.values(settings.providers || {}).some((p) => p.enabled)) return;
  await keepAlive(() => SB.refreshOwn({}));
}

// Keep the worker awake during long provider jobs (each extension API call resets the idle timer).
async function keepAlive(fn) {
  const t = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 20000);
  try { return await fn(); } finally { clearInterval(t); }
}

// Long provider jobs (smart-follower search, target scores) run in the background; progress is written to
// sx.scoreboard.job so the dashboard can show it. One job at a time; Stop in the dashboard cancels it.
let scoreJob = null;
let clearedTargets = null; // { at, snapshot }: the last Clear all, for Undo
// extra: fields kept on the job for the dashboard (e.g. { provider } for target scores).
function startScoreJob(kind, label, run, extra = {}) {
  if (scoreJob) return { ok: false, error: "Another score job is still running" };
  const job = { kind, label, cancel: false };
  scoreJob = job;
  const write = (patch) => SB.updateBoard((b) => ({ ...b, job: { ...(b.job || {}), ...patch, kind, label, updatedAt: now() } }));
  keepAlive(async () => {
    await write({ status: "running", startedAt: now(), finishedAt: null, done: 0, total: 0, current: "", error: "", result: null, provider: null, ...extra });
    let r;
    try {
      r = await run({ onProgress: (p) => write({ ...p }), shouldStop: async () => job.cancel });
    } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    await write({ status: job.cancel ? "cancelled" : r && r.ok ? "done" : "error", finishedAt: now(), error: r && !r.ok ? r.error || "error" : "", result: r || null });
  }).finally(() => { if (scoreJob === job) scoreJob = null; });
  return { ok: true, started: true };
}

chrome.tabs.onRemoved.addListener((tabId, info) => { onTabRemoved(tabId, info); });

chrome.notifications.onClicked.addListener((id) => {
  const hash = id === "sx-review" ? "#review" : "#overview";
  chrome.tabs.create({ url: chrome.runtime.getURL("ui/dashboard.html" + hash) }).catch(() => {});
  chrome.notifications.clear(id).catch(() => {});
});

// Every worker start: drop a lease left by a killed worker and re-arm alarms (cheap and idempotent).
engine.onWorkerStart().catch(() => {});
LIC.verify().then((st) => { if (!st.ok) return onLocked(st); }).catch(() => {}); // asks the server only when 6 h are up
// The follow-back record (History > Follow-backs): kept current; earlier follow-backs from your history are added once.
getState().then(async (st) => {
  await FB.syncFollowBacks({ fromHistory: !st.fbBackfilled });
  if (!st.fbBackfilled) await patchState({ fbBackfilled: true });
}).catch(() => {});
ensureScoresAlarm().catch(() => {});
// A worker that was killed mid-job leaves a "running" score job behind: mark it interrupted.
SB.updateBoard((b) => (b.job && b.job.status === "running" ? { ...b, job: { ...b.job, status: "error", error: "Interrupted (the browser stopped the worker)", finishedAt: now() } } : b)).catch(() => {});
closeStaleReaderTab().catch(() => {});

// ---------- discovery runner (needs the X tab, so it shares the engine lease) ----------

const ACTIVE_DISCOVERY = ["running", "waiting", "cancelling", "queued"];
async function startDiscovery(opts, jobId) {
  const until = now() + 3 * 60 * 1000;
  const mine = async () => { const d = await load(K.discovery, {}); return d.jobId === jobId ? d : null; };
  while (now() < until) {
    const cur = await mine();
    if (!cur) return { ok: false, error: "superseded" };
    if (cur.status === "cancelling") { await save({ [K.discovery]: { ...cur, status: "cancelled", finishedAt: now() } }); return { ok: false, error: "cancelled" }; }
    // Checked again under the lease: a check that held the X tab meanwhile may have ended in a safety stop.
    const r = await engine.withLease("discovery", async () => (engine.safetyStopped(await getState()) ? { ok: false, error: engine.SAFETY_STOP_ERROR } : runDiscovery({ ...opts, jobId }, engine.stop)));
    if (!r || !r.busy) return r;
    await sleep(5000);
  }
  log("warn", "Discovery could not start: ScoreX was busy for 3 minutes");
  const cur = await mine();
  if (cur) await save({ [K.discovery]: { ...cur, status: "error", message: "ScoreX was busy for 3 minutes - try again", finishedAt: now() } });
  return { ok: false, error: "busy" };
}

// Manual re-checks: engine.refreshTargetsNow (queued for the running engine, else a background job with its own
// abort token, 25 profiles at most right away, the rest while running).

async function previewPrompt(handle) {
  const [settings, targets] = await Promise.all([getSettings(), getTargets()]);
  const t = (handle && targets[normalizeHandle(handle)]) || Object.values(targets)[0] || T.newTarget("example", { tier: 1 });
  const post = (t.recentPosts && t.recentPosts[0] && { ...t.recentPosts[0], author: t.handle, authorName: t.name }) ||
    { id: "1", author: t.handle, authorName: t.name || "Example", text: "Most teams ship features. The best teams ship distribution. Building is no longer the hard part.", lang: "en", createdAt: now() - 6 * 60 * 1000 };
  const tone = T.effectiveTone(t, settings);
  const previous = (await H.recentPosted(12)).map((r) => r.comment);
  return {
    ok: true,
    // The length / emoji / ending / point-of-view knobs are drawn again for every real reply.
    instructions: buildInstructions({ settings, toneText: tone.text, myHandle: settings.account.handle, hasExamples: false, reasoning: !!((settings.models.find((m) => m.id === ((settings.presets[T.effectivePreset(t, settings)] || {}).modelId)) || {}).reasoning) }),
    input: buildInput({ post, target: t, styleExamples: [], avoid: previous }),
  };
}

// ---------- message router ----------

const handlers = {
  [MSG.GET_STATUS]: async () => ({ ok: true, status: await engine.getStatus() }),
  start: () => engine.start(),
  pause: () => engine.pause(),
  resume: () => engine.resume(),
  stop: () => engine.stop(STOP.USER),
  runNow: () => engine.runNow(),
  clearAlert: () => engine.clearAlert(),

  targetsUpsert: async (m) => {
    const settings = await getSettings();
    const r = await T.upsert(m.rows || [], { ...(m.defaults || {}), myHandle: settings.account.handle }, !!m.overwrite);
    return { ok: true, ...r };
  },
  // A file with TwitterScores (CSV / JSON) gets its tiers from the scores (500 or more -> Tier 1, else Tier 2) and the
  // tier picked in the dialog does not apply; a file of usernames only uses the picked tier.
  targetsImport: async (m) => {
    const settings = await getSettings();
    const parsed = T.parseImport(m.text || "");
    if (!parsed.length) return { ok: false, error: "No valid handles found in the file" };
    const auto = T.hasScores(parsed);
    const rows = T.autoTiers(parsed);
    const r = await T.upsert(rows, { ...(m.defaults || {}), source: "import", myHandle: settings.account.handle }, false);
    const t1 = auto ? rows.filter((x) => x.tier === 1).length : 0;
    return { ok: true, ...r, parsed: rows.length, auto, ...(auto ? { t1, t2: rows.length - t1, noScore: rows.filter((x) => x.twitterscore == null).length } : {}) };
  },
  targetPatch: async (m) => {
    const t = await T.patch(m.handle, m.patch || {});
    return t ? { ok: true, target: t } : { ok: false, error: "Target not found" };
  },
  targetsBulk: async (m) => { await T.bulk(m.handles || [], m.patch || {}); return { ok: true }; },
  targetsRemove: async (m) => ({ ok: true, removed: await T.removeMany(m.handles || []) }),
  // Targets > Clear all (one click) and its Undo (the cleared targets are kept here for 10 minutes).
  targetsClear: async () => {
    const r = await T.clearAll();
    clearedTargets = r.removed ? { at: now(), snapshot: r.snapshot } : null;
    if (r.removed) log("info", `Cleared all targets (${r.removed}); history and follow-backs are kept`);
    return { ok: true, removed: r.removed };
  },
  targetsUndoClear: async () => {
    const c = clearedTargets;
    if (!c || now() - c.at > 10 * 60e3) return { ok: false, error: "Undo is no longer available" };
    clearedTargets = null;
    const restored = await T.restoreTargets(c.snapshot);
    log("info", `Restored ${restored} cleared target${restored === 1 ? "" : "s"}`);
    return { ok: true, restored };
  },
  // Targets > Load TwitterScore: every target's TwitterScore through your TwitterScore API key (only on this button).
  targetsTwitterScore: async () => {
    const ready = await SB.twitterScoreApiReady();
    if (!ready.ok) return ready;
    return startScoreJob("targets", "TwitterScore of your targets", (ctl) => SB.loadTargetTwitterScores(ctl), { provider: "twitterscore" });
  },
  targetRefresh: (m) => engine.refreshTargetsNow(m.handles || (m.handle ? [m.handle] : [])),

  candidatesAdd: async (m) => {
    const r = await candidatesToTargets(m.handles || [], Number(m.tier) === 1 ? 1 : 2, T.upsert);
    return { ok: true, added: r.added, updated: r.updated, blacklisted: r.blacklisted || 0 };
  },
  blacklistAdd: async (m) => ({ ok: true, ...(await blacklistAdd(m.handles || [], "manual")) }),
  blacklistRemove: async (m) => ({ ok: true, ...(await blacklistRemove(m.handles || [])) }),
  candidatesRemove: async (m) => {
    const set = new Set((m.handles || []).map(normalizeHandle));
    await updateCandidates((all) => { for (const h of set) delete all[h]; return all; });
    return { ok: true };
  },
  candidatesClear: async () => { await updateCandidates(() => ({})); return { ok: true }; },

  discoveryStart: async (m) => {
    // After a safety stop (captcha, X warning, rate limit...) nothing drives the X tab until you review the stop.
    if (engine.safetyStopped(await getState())) return { ok: false, error: engine.SAFETY_STOP_ERROR };
    const cur = await load(K.discovery, {});
    if (ACTIVE_DISCOVERY.includes(cur.status)) return { ok: false, error: "A discovery is already running - cancel it first" };
    const jobId = "d" + now().toString(36);
    await save({ [K.discovery]: { jobId, status: "waiting", source: m.source, step: "Waiting for the X tab", message: "", startedAt: now(), finishedAt: null } });
    startDiscovery({ source: m.source, handles: m.handles || [], query: m.query || "", maxUsers: m.maxUsers, enrich: !!m.enrich }, jobId)
      .then(async (r) => {
        const d = await load(K.discovery, {});
        if (r && r.ok === false && d.jobId === jobId && ["waiting", "running"].includes(d.status)) await save({ [K.discovery]: { ...d, status: "error", message: r.error || "Could not start", finishedAt: now() } });
      })
      .catch((e) => log("error", "Discovery failed: " + e.message));
    return { ok: true };
  },
  discoveryCancel: async () => { await cancelDiscovery(); return { ok: true }; },

  reviewAction: (m) => engine.reviewAction(m),
  reviewApproveAll: (m) => engine.reviewBulk("approve", m.ids),
  reviewSkipAll: (m) => engine.reviewBulk("skip", m.ids),

  testOpenAI: async (m) => {
    const [settings, secrets] = await Promise.all([getSettings(), getSecrets()]);
    if (!secrets.openaiKey) return { ok: false, error: "Add your OpenAI API key first" };
    const modelId = m.modelId || settings.presets.cheap.modelId;
    const r = await testModel({ settings, apiKey: secrets.openaiKey, modelId, effort: m.effort });
    if (r.ok) await recordSpend(r.cost, modelId, settings.timezone);
    return r.ok ? { ok: true, text: r.text, usage: r.usage, cost: r.cost, ms: r.ms } : { ok: false, error: r.error ? `${r.error.kind}: ${r.error.message}` : "failed", usage: r.usage, ms: r.ms };
  },
  previewPrompt: (m) => previewPrompt(m.handle),

  sorsaTest: () => testSorsa(),
  sorsaRefresh: async (m) => ((await getSettings()).scores.checkOthers ? refreshScores(m.handles || []) : { ok: false, error: SB.OTHERS_OFF }),

  // ---- score providers (Scores tab) ----
  scoresState: async () => ({ ok: true, providers: await SB.providerStates(), board: await SB.getBoard() }),
  scoresRefreshOwn: (m) => keepAlive(() => SB.refreshOwn({ force: !!m.force, only: Array.isArray(m.only) ? m.only.map(String) : null })),
  providerTest: async (m) => {
    const r = await keepAlive(() => SB.refreshOwn({ force: true, only: [String(m.id || "")] }));
    const one = r.ok && r.results ? r.results[String(m.id || "")] : null;
    return one ? (one.ok ? { ok: true, score: one.score, max: one.max != null ? one.max : null, url: one.url || "", mode: one.mode || "" } : { ok: false, error: one.message || one.error || "Failed" }) : { ok: false, error: r.error || "That provider is off" };
  },
  scoreCheck: (m) => keepAlive(() => SB.checkScores(String(m.handle || ""))),
  smartFollowers: (m) => keepAlive(() => SB.smartFollowersOf(String(m.handle || ""), { maxAgeMs: m.fresh ? 0 : undefined })),
  smartSweep: (m) => startScoreJob("sweep", "Smart followers", (ctl) => SB.sweepSmartFollowers((m.handles || []).map(String), ctl)),
  // History > Follow-backs: the TwitterScore of accounts that followed you back, through your TwitterScore API key.
  followBackScores: () => keepAlive(() => SB.followBackScores()),
  targetScores: (m) => startScoreJob("targets", "Target scores", (ctl) => SB.refreshTargetScores((m.handles || []).map(String), String(m.provider || ""), ctl), { provider: String(m.provider || "") || null }),
  scoreJobCancel: async () => { if (scoreJob) scoreJob.cancel = true; return { ok: true }; },

  // ---- smart-follower database (TwitterScore paid API; Discover > Database) ----
  smartDbBuild: (m) => startScoreJob("smartdb", "Smart follower database", (ctl) => SB.buildSmartDb((m.handles || []).map(String), ctl), { provider: "twitterscore" }),
  smartDbList: async () => { const rows = await SDB.listRows(); return { ok: true, rows, count: rows.length }; },
  smartDbRemove: async (m) => ({ ok: true, removed: await SDB.removeRows(Array.isArray(m.handles) ? m.handles.map(String) : []) }),
  smartDbClear: async () => { await SDB.clearRows(); return { ok: true }; },

  // ---- Tone "Try it": write a sample reply to a pasted post (never posted; the real cost is recorded) ----
  sampleReply: async (m) => {
    const [settings, secrets, targets] = await Promise.all([getSettings(), getSecrets(), getTargets()]);
    if (!secrets.openaiKey) return { ok: false, error: "Add your OpenAI API key first (Models & Costs)" };
    if (budgetStatus(settings, await getSpend()).reached) return { ok: false, error: "Monthly OpenAI budget reached" };
    const text = String(m.text || "").trim().slice(0, 1500);
    if (text.length < 10) return { ok: false, error: "Paste the post text (a sentence or more)" };
    const h = normalizeHandle(m.handle || "");
    const t = (h && Object.hasOwn(targets, h) && targets[h]) || T.newTarget(h || "sample_author", { tier: Number(m.tier) === 1 ? 1 : 2 });
    const post = { id: "sample", author: t.handle, authorName: t.name || "", text, lang: "", createdAt: now() - 5 * 60000 };
    const tone = T.effectiveTone(t, settings);
    const presetKey = T.effectivePreset(t, settings);
    const previous = (await H.recentPosted(50)).map((r) => r.comment).filter(Boolean);
    const g = await keepAlive(() => generate({ settings, apiKey: secrets.openaiKey, target: t, post, tone, presetKey, previous, bestComments: [], myHandle: settings.account.handle, onCall: async (call) => { await recordSpend(call.cost, call.modelId, settings.timezone); } }));
    const cost = (g.calls || []).reduce((a, c) => a + (c.cost || 0), 0);
    if (g.ok) return { ok: true, comment: g.comment, model: g.model && g.model.name, effort: g.effort, cost, tone: tone.key, preset: presetKey, quality: g.quality };
    return { ok: false, error: g.skipped ? g.skipped.text : (g.error && g.error.message) || g.stop || "Generation failed", cost };
  },

  // ---- diagnostics ----
  selfTest: () => keepAlive(() => runSelfTest()),

  // ---- conversations (author replies) + reach monitor ----
  conversationDone: (m) => conversationDone(String(m.id || ""), m.done !== false),
  reachDismiss: async () => { await patchState({ reachAlert: null, reachDismissedAt: now() }); await engine.refreshBadge(); return { ok: true }; },

  learningRun: async () => {
    await patchState({ lastLearningAt: 0, learningForce: true });
    const st = await getState();
    if (st.status === STATUS.RUNNING) { await engine.requestTick(5000, "manual"); return { ok: true, note: "Checking now" }; }
    return { ok: true, note: "Checks run on the next check after you press Start" };
  },
  learningSummary: () => learningSummary(),
  abReset: () => resetAb(),
  cleanupPreview: () => cleanupPreview(),

  exportData: (m) => exportData(m.parts),
  importData: (m) => importData(m.data, m.parts),
  historyClear: async () => { const r = await clearHistory(); await engine.refreshBadge(); return r; },
  resetAll: async () => { await engine.stop(STOP.USER); const r = await resetAll(); await engine.refreshBadge(); return r; },

  // ---- license: the only requests that work while ScoreX is locked ----
  licenseState: async () => ({ ok: true, license: LIC.licenseView(await LIC.getLicense()) }),
  licenseActivate: async (m) => {
    const r = await LIC.activate(String(m.key || ""));
    if (!r.ok) return r;
    log("info", "ScoreX activated on this browser");
    return { ok: true, license: LIC.licenseView(await LIC.getLicense()) };
  },
  licenseCheck: async () => {
    const st = await LIC.verify({ force: true });
    if (!st.ok) await onLocked(st);
    return { ok: true, license: LIC.licenseView(await LIC.getLicense()) };
  },
  licenseRemove: async () => {
    const s = await getState();
    if (s.status === STATUS.RUNNING) await engine.pause().catch(() => {});
    await LIC.removeLicense();
    log("info", "License removed from this browser");
    return { ok: true };
  },
};


chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg.sx !== "string") return false;
  // Content scripts may only announce readiness; everything else must come from our own pages.
  if (msg.sx === MSG.CONTENT_READY) {
    if (sender.tab && sender.id === chrome.runtime.id) onContentReady(sender.tab.id, msg.url);
    return false;
  }
  const fromExtensionPage = sender.id === chrome.runtime.id && (sender.url || "").startsWith(EXT_ORIGIN);
  if (!fromExtensionPage) return false;
  const h = handlers[msg.sx];
  if (!h) { reply({ ok: false, error: "Unknown request: " + msg.sx }); return false; }
  Promise.resolve()
    .then(async () => {
      if (!LICENSE_FREE.has(msg.sx)) {
        const st = LIC.licenseState(await LIC.getLicense());
        if (!st.ok) return { ok: false, error: st.message, licensed: false };
      }
      return h(msg);
    })
    .then((r) => reply(r || { ok: true }))
    .catch((e) => { log("error", `Request ${msg.sx} failed: ${e && e.message}`); reply({ ok: false, error: String((e && e.message) || e) }); });
  return true;
});
