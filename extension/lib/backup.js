// ScoreX - export / import as JSON. API keys (sx.secrets) are never exported or imported.

import { K, VERSION, STATUS } from "./constants.js";
import { load, save, remove, getSettings, saveSettings, sanitizeSettings, updateTargets, patchState, DEFAULT_STATE } from "./store.js";
import * as H from "./history.js";
import { db, STORES } from "./db.js";
import { now, normalizeHandle } from "./util.js";
import { newTarget } from "./targets.js";

export async function exportData(parts = ["settings", "targets", "history"]) {
  const out = { app: "ScoreX", version: VERSION, exportedAt: new Date(now()).toISOString() };
  if (parts.includes("settings")) out.settings = await getSettings();
  if (parts.includes("targets")) out.targets = await load(K.targets, {});
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
    let n = 0;
    await updateTargets((all) => {
      for (const [k, t] of Object.entries(data.targets)) {
        const h = normalizeHandle((t && t.handle) || k);
        if (!h) continue;
        all[h] = { ...newTarget(h, t || {}), ...(t || {}), handle: h };
        n++;
      }
      return all;
    });
    imported.targets = n;
  }
  if (parts.includes("history") && Array.isArray(data.history)) {
    const recs = data.history.filter((r) => r && r.id && r.createdAt);
    await db().putMany(STORES.history, recs);
    imported.history = recs.length;
  }
  if (parts.includes("learning") && data.learning) { await save({ [K.learning]: data.learning }); imported.learning = true; }
  return { ok: true, imported };
}

export async function clearHistory() { await H.clearAll(); return { ok: true }; }

// Factory reset of everything except API keys.
export async function resetAll() {
  await remove([K.settings, K.targets, K.candidates, K.seen, K.logs, K.discovery, K.selectorOverrides, K.learning, K.spend, K.state]);
  await H.clearAll();
  await db().clear(STORES.events).catch(() => {});
  await save({ [K.state]: { ...DEFAULT_STATE, status: STATUS.STOPPED } });
  return { ok: true };
}
