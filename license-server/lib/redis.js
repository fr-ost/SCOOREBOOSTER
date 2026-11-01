// Storage: Upstash Redis over its REST API (Vercel > Storage > Upstash Redis adds the variables). No npm package.
// Accepts both naming schemes the Vercel integration has used: KV_REST_API_* and UPSTASH_REDIS_REST_*.
// Tests swap in an in-memory store through globalThis.__scxTestDb.

export function upstash(url, token, fetchImpl = fetch) {
  async function cmd(...args) {
    const res = await fetchImpl(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
    let j = {};
    try { j = await res.json(); } catch (_) { /* not JSON */ }
    if (!res.ok || j.error) throw new Error(`Redis: ${j.error || "HTTP " + res.status}`);
    return j.result;
  }
  const parse = (v) => (v == null ? null : JSON.parse(v));
  return {
    get: async (k) => parse(await cmd("GET", k)),
    set: (k, v) => cmd("SET", k, JSON.stringify(v)),
    setNX: async (k, v) => (await cmd("SET", k, JSON.stringify(v), "NX")) === "OK", // true only for the first writer
    del: (...ks) => cmd("DEL", ...ks),
    sadd: (k, m) => cmd("SADD", k, m),
    srem: (k, m) => cmd("SREM", k, m),
    smembers: (k) => cmd("SMEMBERS", k),
    mget: async (ks) => (ks.length ? (await cmd("MGET", ...ks)).map(parse) : []),
    // A counter that starts expiring at its first hit (rate limits).
    hit: async (k, ttlSec) => { const n = await cmd("INCR", k); if (n === 1) await cmd("EXPIRE", k, ttlSec); return n; },
  };
}

// The same interface in memory (tests, and a clear error page when the store is not set up).
export function memoryDb() {
  const m = new Map(), sets = new Map();
  const clone = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));
  return {
    get: async (k) => clone(m.get(k)),
    set: async (k, v) => { m.set(k, clone(v)); return "OK"; },
    setNX: async (k, v) => { if (m.has(k)) return false; m.set(k, clone(v)); return true; },
    del: async (...ks) => { let n = 0; for (const k of ks) { if (m.delete(k)) n++; sets.delete(k); } return n; },
    sadd: async (k, v) => { const s = sets.get(k) || new Set(); const had = s.has(v); s.add(v); sets.set(k, s); return had ? 0 : 1; },
    srem: async (k, v) => { const s = sets.get(k); return s && s.delete(v) ? 1 : 0; },
    smembers: async (k) => [...(sets.get(k) || [])],
    mget: async (ks) => ks.map((k) => clone(m.get(k))),
    hit: async (k) => { const n = (m.get(k) || 0) + 1; m.set(k, n); return n; },
  };
}

export function db() {
  if (globalThis.__scxTestDb) return globalThis.__scxTestDb;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw Object.assign(new Error("Storage is not set up: add Upstash Redis to this Vercel project (Storage tab) and redeploy"), { setup: true });
  return upstash(url, token);
}
