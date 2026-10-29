// Fake chrome.storage.local for Node unit tests (in-memory, same promise API as MV3).
// Import this file BEFORE any module that reads/writes storage:
//   import { resetStorage, dumpStorage } from "./_chrome.mjs";
// Values are structured-cloned on the way in and out, like the real storage area.

const data = new Map();
const listeners = new Set();
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

function pick(keys) {
  const out = {};
  if (keys == null) {
    for (const [k, v] of data) out[k] = clone(v);
    return out;
  }
  if (typeof keys === "string") {
    if (data.has(keys)) out[keys] = clone(data.get(keys));
    return out;
  }
  if (Array.isArray(keys)) {
    for (const k of keys) if (data.has(k)) out[k] = clone(data.get(k));
    return out;
  }
  if (typeof keys === "object") {
    for (const [k, def] of Object.entries(keys)) out[k] = data.has(k) ? clone(data.get(k)) : clone(def);
    return out;
  }
  return out;
}

export const stats = { gets: 0, sets: 0, removes: 0 };

const local = {
  async get(keys) {
    stats.gets++;
    await Promise.resolve();
    return pick(keys);
  },
  async set(items) {
    stats.sets++;
    await Promise.resolve();
    for (const [k, v] of Object.entries(items || {})) data.set(k, clone(v));
  },
  async remove(keys) {
    stats.removes++;
    await Promise.resolve();
    for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
  },
  async clear() {
    await Promise.resolve();
    data.clear();
  },
};

const onChanged = {
  addListener(fn) { listeners.add(fn); },
  removeListener(fn) { listeners.delete(fn); },
  hasListener(fn) { return listeners.has(fn); },
};

globalThis.chrome = globalThis.chrome || {};
globalThis.chrome.storage = { local, onChanged };
globalThis.chrome.runtime = globalThis.chrome.runtime || { id: "test-extension", lastError: undefined };

export function resetStorage(initial = {}) {
  data.clear();
  for (const [k, v] of Object.entries(initial)) data.set(k, clone(v));
  stats.gets = 0; stats.sets = 0; stats.removes = 0;
}
export function dumpStorage() {
  const out = {};
  for (const [k, v] of data) out[k] = clone(v);
  return out;
}
export function rawGet(key) { return clone(data.get(key)); }
export const chromeLocal = local;
