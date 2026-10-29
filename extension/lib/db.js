// ScoreX - IndexedDB storage for history (one record per generated comment) and the activity log.
// Exposes a tiny repository API so the rest of the code never touches IndexedDB directly.
// In Node unit tests (no indexedDB) an in-memory adapter with the same API is used automatically,
// or can be forced with useMemoryDb().

const DB_NAME = "scorex";
const DB_VERSION = 2;
export const STORES = Object.freeze({ history: "history", events: "events", kv: "kv" });

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.history)) {
        const s = db.createObjectStore(STORES.history, { keyPath: "id" });
        s.createIndex("createdAt", "createdAt");
        s.createIndex("status", "status");
        s.createIndex("target", "target");
        s.createIndex("postId", "postId");
      }
      if (!db.objectStoreNames.contains(STORES.kv)) db.createObjectStore(STORES.kv, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORES.events)) {
        const e = db.createObjectStore(STORES.events, { keyPath: "id", autoIncrement: true });
        e.createIndex("ts", "ts");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const p = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

function idbAdapter() {
  let dbp = null;
  const db = () => (dbp ||= openIdb().catch((e) => { dbp = null; throw e; }));
  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      Promise.resolve(fn(s)).then((v) => { out = v; }, reject);
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  return {
    kind: "idb",
    put: (store, rec) => tx(store, "readwrite", (s) => p(s.put(rec))),
    putMany: (store, recs) => tx(store, "readwrite", (s) => Promise.all(recs.map((r) => p(s.put(r))))),
    get: (store, key) => tx(store, "readonly", (s) => p(s.get(key))),
    del: (store, key) => tx(store, "readwrite", (s) => p(s.delete(key))),
    // fn(current) -> new record to store, or null to leave it unchanged. Runs inside one transaction.
    update: (store, key, fn) => tx(store, "readwrite", (s) => p(s.get(key)).then((cur) => {
      const next = fn(cur);
      if (next == null) return null;
      return p(s.put(next)).then(() => next);
    })),
    clear: (store) => tx(store, "readwrite", (s) => p(s.clear())),
    count: (store) => tx(store, "readonly", (s) => p(s.count())),
    // All records with index value in [lo, hi] (either bound optional), oldest first.
    range: (store, index, lo, hi) => tx(store, "readonly", (s) => {
      let r = null;
      if (lo != null && hi != null) r = IDBKeyRange.bound(lo, hi);
      else if (lo != null) r = IDBKeyRange.lowerBound(lo);
      else if (hi != null) r = IDBKeyRange.upperBound(hi);
      return p(s.index(index).getAll(r));
    }),
    byIndex: (store, index, value) => tx(store, "readonly", (s) => p(s.index(index).getAll(value))),
    all: (store) => tx(store, "readonly", (s) => p(s.getAll())),
    // Newest-first, at most `limit` records, walking an index backwards.
    latest: (store, index, limit) => tx(store, "readonly", (s) => new Promise((resolve, reject) => {
      const out = [];
      const req = s.index(index).openCursor(null, "prev");
      req.onsuccess = () => {
        const c = req.result;
        if (!c || out.length >= limit) return resolve(out);
        out.push(c.value);
        c.continue();
      };
      req.onerror = () => reject(req.error);
    })),
    // Delete records whose index value is < hi.
    deleteBelow: (store, index, hi) => tx(store, "readwrite", (s) => new Promise((resolve, reject) => {
      let n = 0;
      const req = s.index(index).openCursor(IDBKeyRange.upperBound(hi, true));
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(n);
        c.delete(); n++; c.continue();
      };
      req.onerror = () => reject(req.error);
    })),
  };
}

export function memoryAdapter() {
  const stores = new Map();
  let auto = 0;
  const st = (name) => { if (!stores.has(name)) stores.set(name, new Map()); return stores.get(name); };
  const keyOf = (name, rec) => (name === STORES.events && rec.id == null ? (rec.id = ++auto) : rec.id);
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const sorted = (arr, index) => arr.sort((a, b) => (a[index] > b[index] ? 1 : a[index] < b[index] ? -1 : 0));
  return {
    kind: "memory",
    async put(name, rec) { const k = keyOf(name, rec); st(name).set(k, clone(rec)); return k; },
    async putMany(name, recs) { return Promise.all(recs.map((r) => this.put(name, r))); },
    async get(name, key) { return clone(st(name).get(key)); },
    async del(name, key) { st(name).delete(key); },
    async update(name, key, fn) {
      const next = fn(clone(st(name).get(key)));
      if (next == null) return null;
      st(name).set(key, clone(next));
      return clone(next);
    },
    async clear(name) { st(name).clear(); },
    async count(name) { return st(name).size; },
    async range(name, index, lo, hi) {
      const all = [...st(name).values()].filter((r) => (lo == null || r[index] >= lo) && (hi == null || r[index] <= hi));
      return clone(sorted(all, index));
    },
    async byIndex(name, index, value) { return clone(sorted([...st(name).values()].filter((r) => r[index] === value), "id")); },
    async all(name) { return clone([...st(name).values()]); },
    async latest(name, index, limit) { return clone(sorted([...st(name).values()], index).reverse().slice(0, limit)); },
    async deleteBelow(name, index, hi) {
      let n = 0;
      for (const [k, r] of st(name)) if (r[index] < hi) { st(name).delete(k); n++; }
      return n;
    },
  };
}

let adapter = null;
export function db() {
  if (!adapter) adapter = typeof indexedDB !== "undefined" ? idbAdapter() : memoryAdapter();
  return adapter;
}
export function useMemoryDb() { adapter = memoryAdapter(); return adapter; }
