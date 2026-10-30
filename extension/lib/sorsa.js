// ScoreX - optional Sorsa Score provider (https://docs.sorsa.io). OFF by default.
// Uses YOUR Sorsa API key (paid API; new accounts get 100 free requests) and the optional host
// permission https://api.sorsa.io/*, which the dashboard requests when you enable it.
// GET /v3/score?username=<handle> with header "ApiKey: <key>" -> { score }. Cached 24h per account.

import { getSecrets, getSettings, updateTargets, getTargets, log } from "./store.js";
import { combinedScore } from "./scores.js";
import { now, DAY, sleep, redact } from "./util.js";

const BASE = "https://api.sorsa.io/v3";
export const SORSA_ORIGIN = "https://api.sorsa.io/*";

export async function hasPermission() {
  try { return await chrome.permissions.contains({ origins: [SORSA_ORIGIN] }); } catch (_) { return false; }
}

async function get(path, key) {
  let res;
  try {
    res = await fetch(BASE + path, { headers: { ApiKey: key, Accept: "application/json" } });
  } catch (e) { return { ok: false, error: "network", message: redact(String(e && e.message || e)) }; }
  let body = null;
  try { body = await res.json(); } catch (_) {}
  // 401 = missing or wrong key; 403 = valid key without credits or with an expired plan.
  if (res.status === 401) return { ok: false, error: "auth", message: "Sorsa rejected the API key" };
  if (res.status === 403) return { ok: false, error: "auth", message: "Sorsa: no requests left or the plan expired - check your key's usage" };
  if (res.status === 429) return { ok: false, error: "rate", message: "Sorsa rate limit / quota reached" };
  if (res.status === 404) return { ok: true, body: null };
  if (!res.ok) return { ok: false, error: "http_" + res.status, message: (body && body.message) || "Sorsa error " + res.status };
  return { ok: true, body };
}

export async function fetchScore(handle, key) {
  const r = await get("/score?username=" + encodeURIComponent(handle), key);
  if (!r.ok) return r;
  const v = r.body && r.body.score;
  const n = v == null || v === "" ? NaN : Number(v);
  return { ok: true, score: Number.isFinite(n) ? n : null }; // a non-numeric score is "no score", never NaN
}

export async function keyUsage(key) {
  const r = await get("/key-usage-info", key);
  // key_requests = this period's allocation, remaining_requests = what is left of it.
  return r.ok ? { ok: true, remaining: r.body && r.body.remaining_requests, total: r.body && (r.body.key_requests != null ? r.body.key_requests : r.body.total_requests), validUntil: r.body && r.body.valid_until } : r;
}

async function ready() {
  const [settings, secrets] = await Promise.all([getSettings(), getSecrets()]);
  if (!settings.scores.sorsaEnabled) return { ok: false, error: "Enable Sorsa in Settings first" };
  if (!secrets.sorsaKey) return { ok: false, error: "Add your Sorsa API key in Settings" };
  if (!(await hasPermission())) return { ok: false, error: "Allow access to api.sorsa.io (toggle Sorsa off and on in Settings)" };
  return { ok: true, settings, key: secrets.sorsaKey };
}

export async function testSorsa() {
  const r = await ready();
  if (!r.ok) return r;
  const s = await fetchScore(r.settings.account.handle || "0x_nation", r.key);
  if (!s.ok) return { ok: false, error: s.message || s.error };
  const u = await keyUsage(r.key);
  return { ok: true, score: s.score, remaining: u.ok ? u.remaining : null };
}

const MAX_FAILURES_IN_A_ROW = 3; // an outage (5xx, network) ends the refresh instead of hitting Sorsa for every target
const FAIL_BACKOFF_MS = 1500; // first pause after a failed request, doubled for each further failure in a row

// Refresh Sorsa scores for handles (all targets when empty). Skips scores fetched in the last 24h.
// Returns { ok, updated, failed } or { ok: false, error, updated, failed } (also when every request failed).
export async function refreshScores(handles) {
  const r = await ready();
  if (!r.ok) return r;
  const targets = await getTargets();
  const list = (handles && handles.length ? handles : Object.keys(targets)).filter((h) => targets[h]);
  let updated = 0, failed = 0, inARow = 0, lastError = "";
  for (const h of list) {
    const t = targets[h];
    if (t.score && t.score.sorsaUpdatedAt && now() - t.score.sorsaUpdatedAt < DAY) continue;
    const s = await fetchScore(h, r.key);
    if (!s.ok) {
      if (s.error === "auth" || s.error === "rate") return { ok: false, error: s.message, updated, failed: failed + 1 };
      failed++;
      inARow++;
      lastError = s.message || s.error || "Sorsa error";
      if (inARow >= MAX_FAILURES_IN_A_ROW) {
        log("warn", `Sorsa: stopped after ${inARow} failed requests in a row (${lastError})`);
        return { ok: false, error: `Sorsa is not answering properly (${lastError}) - try again later`, updated, failed };
      }
      await sleep(FAIL_BACKOFF_MS * Math.pow(2, inARow - 1));
      continue;
    }
    inARow = 0;
    await updateTargets((all) => {
      if (all[h]) {
        all[h].score = { ...(all[h].score || {}), sorsa: s.score, sorsaUpdatedAt: now() };
        all[h].score.combined = combinedScore(all[h].score.own, s.score, r.settings.scores.blendSorsa);
      }
      return all;
    });
    updated++;
    await sleep(250);
  }
  log("info", `Sorsa: updated ${updated} score(s)${failed ? `, ${failed} failed` : ""}`);
  if (failed && !updated) return { ok: false, error: `Sorsa: no score could be updated (${lastError})`, updated, failed };
  return { ok: true, updated, failed };
}
