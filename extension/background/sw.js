// ScoreX service worker: wires Chrome events to the engine and answers dashboard/popup messages.
// Everything is persisted (chrome.storage + IndexedDB), so this file is safe to be killed and restarted
// at any time; on startup it re-arms the alarms and continues if the engine was running.

import { ALARM, MSG, STATUS, STOP, K } from "../lib/constants.js";
import { ensureDefaults, getSettings, getSecrets, getTargets, getState, patchState, updateCandidates, log, load, save } from "../lib/store.js";
import * as engine from "../lib/engine.js";
import * as T from "../lib/targets.js";
import { onContentReady, onTabRemoved } from "../lib/tabs.js";
import { runDiscovery, cancelDiscovery, candidatesToTargets } from "../lib/discovery.js";
import { testModel, buildInstructions, buildInput } from "../lib/generator.js";
import { testSorsa, refreshScores } from "../lib/sorsa.js";
import { summary as learningSummary, resetAb } from "../lib/learning.js";
import { preview as cleanupPreview } from "../lib/cleanup.js";
import { exportData, importData, clearHistory, resetAll } from "../lib/backup.js";
import { blacklistAdd, blacklistRemove } from "../lib/follow.js";
import { normalizeHandle, now, sleep } from "../lib/util.js";
import * as H from "../lib/history.js";
import { refreshProfile } from "../lib/watcher.js";
import { workerTab } from "../lib/tabs.js";
import { recordSpend } from "../lib/costs.js";
import * as SB from "../lib/scoreboard.js";

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
  if (a.name === ALARM.TICK) engine.tick("alarm");
  else if (a.name === ALARM.WATCHDOG) engine.watchdog();
  else if (a.name === ALARM.SCORES) autoRefreshScores().catch((e) => log("warn", "Score refresh failed: " + e.message));
});

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
function startScoreJob(kind, label, run) {
  if (scoreJob) return { ok: false, error: "Another score job is still running" };
  const job = { kind, label, cancel: false };
  scoreJob = job;
  const write = (patch) => SB.updateBoard((b) => ({ ...b, job: { ...(b.job || {}), ...patch, kind, label, updatedAt: now() } }));
  keepAlive(async () => {
    await write({ status: "running", startedAt: now(), finishedAt: null, done: 0, total: 0, current: "", error: "", result: null });
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
ensureScoresAlarm().catch(() => {});
// A worker that was killed mid-job leaves a "running" score job behind: mark it interrupted.
SB.updateBoard((b) => (b.job && b.job.status === "running" ? { ...b, job: { ...b.job, status: "error", error: "Interrupted (the browser stopped the worker)", finishedAt: now() } } : b)).catch(() => {});

// ---------- discovery runner (needs the X tab, so it shares the engine lease) ----------

const ACTIVE_DISCOVERY = ["running", "waiting", "cancelling", "queued"];
async function startDiscovery(opts, jobId) {
  const until = now() + 3 * 60 * 1000;
  const mine = async () => { const d = await load(K.discovery, {}); return d.jobId === jobId ? d : null; };
  while (now() < until) {
    const cur = await mine();
    if (!cur) return { ok: false, error: "superseded" };
    if (cur.status === "cancelling") { await save({ [K.discovery]: { ...cur, status: "cancelled", finishedAt: now() } }); return { ok: false, error: "cancelled" }; }
    const r = await engine.withLease("discovery", () => runDiscovery({ ...opts, jobId }, engine.stop));
    if (!r || !r.busy) return r;
    await sleep(5000);
  }
  log("warn", "Discovery could not start: ScoreX was busy for 3 minutes");
  const cur = await mine();
  if (cur) await save({ [K.discovery]: { ...cur, status: "error", message: "ScoreX was busy for 3 minutes - try again", finishedAt: now() } });
  return { ok: false, error: "busy" };
}

async function refreshTargetsNow(handles) {
  const st = await getState();
  const list = handles.map(normalizeHandle).filter(Boolean);
  if (st.status === STATUS.RUNNING) {
    await patchState((s) => ({ pendingRefresh: [...new Set([...(s.pendingRefresh || []), ...list])] }));
    return { ok: true, queued: list.length, when: "next idle check" };
  }
  // Not running: refresh now in the background (same lease + page checks); Pause/Stop abort it.
  const now50 = list.slice(0, 50);
  engine.backgroundAbort.requested = false;
  (async () => {
    await engine.withLease("refresh", async () => {
      const settings = await getSettings();
      const tabId = await workerTab(settings);
      if (tabId == null) return;
      for (const h of now50) {
        if (engine.backgroundAbort.requested) { log("info", "Profile refresh stopped by you"); break; }
        const r = await refreshProfile(tabId, h, settings);
        if (r && r.stop) { await engine.stop(r.stop, r.detail); break; }
        await sleep(3000 + Math.random() * 5000);
      }
    });
  })().catch((e) => log("error", "Refresh failed: " + e.message));
  if (list.length > now50.length) await patchState((s) => ({ pendingRefresh: [...new Set([...(s.pendingRefresh || []), ...list.slice(50)])] }));
  return { ok: true, queued: list.length, when: list.length > 50 ? "50 now, the rest while running" : "now" };
}

async function previewPrompt(handle) {
  const [settings, targets] = await Promise.all([getSettings(), getTargets()]);
  const t = (handle && targets[normalizeHandle(handle)]) || Object.values(targets)[0] || T.newTarget("example", { tier: 1 });
  const post = (t.recentPosts && t.recentPosts[0] && { ...t.recentPosts[0], author: t.handle, authorName: t.name }) ||
    { id: "1", author: t.handle, authorName: t.name || "Example", text: "Most teams ship features. The best teams ship distribution. Building is no longer the hard part.", lang: "en", createdAt: now() - 6 * 60 * 1000 };
  const tone = T.effectiveTone(t, settings);
  const previous = (await H.recentPosted(12)).map((r) => r.comment);
  return {
    ok: true,
    instructions: buildInstructions({ settings, target: t, toneText: tone.text, angle: "(a random angle is chosen per comment)", myHandle: settings.account.handle, hasExamples: false }),
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
  targetsImport: async (m) => {
    const settings = await getSettings();
    const rows = T.parseImport(m.text || "");
    if (!rows.length) return { ok: false, error: "No valid handles found in the file" };
    const r = await T.upsert(rows, { ...(m.defaults || {}), source: "import", myHandle: settings.account.handle }, false);
    return { ok: true, ...r, parsed: rows.length };
  },
  targetPatch: async (m) => {
    const t = await T.patch(m.handle, m.patch || {});
    return t ? { ok: true, target: t } : { ok: false, error: "Target not found" };
  },
  targetsBulk: async (m) => { await T.bulk(m.handles || [], m.patch || {}); return { ok: true }; },
  targetsRemove: async (m) => ({ ok: true, removed: await T.removeMany(m.handles || []) }),
  targetRefresh: (m) => refreshTargetsNow(m.handles || (m.handle ? [m.handle] : [])),

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
  sorsaRefresh: (m) => refreshScores(m.handles || []),

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
  targetScores: (m) => startScoreJob("targets", "Target scores", (ctl) => SB.refreshTargetScores((m.handles || []).map(String), String(m.provider || ""), ctl)),
  scoreJobCancel: async () => { if (scoreJob) scoreJob.cancel = true; return { ok: true }; },

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
    .then(() => h(msg))
    .then((r) => reply(r || { ok: true }))
    .catch((e) => { log("error", `Request ${msg.sx} failed: ${e && e.message}`); reply({ ok: false, error: String((e && e.message) || e) }); });
  return true;
});
