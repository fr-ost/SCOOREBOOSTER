// ScoreX - IndexedDB storage for history (one record per generated comment) and the activity log.
// Exposes a tiny repository API so the rest of the code never touches IndexedDB directly.
// In Node unit tests (no indexedDB) an in-memory adapter with the same API is used automatically,
// or can be forced with useMemoryDb().

const DB_NAME = "scorex";
const DB_VERSION = 3;
export const STORES = Object.freeze({ history: "history", events: "events", kv: "kv", smartdb: "smartdb" });

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
      // Smart-follower database (lib/smartdb.js): one row per account, id = lowercase handle.
      if (!db.objectStoreNames.contains(STORES.smartdb)) db.createObjectStore(STORES.smartdb, { keyPath: "id" });
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
  // A connection Chrome closed (site data cleared, storage error) or that a newer version needs closed is dropped, so
  // the next call reconnects instead of failing until the worker restarts.
  const db = () => (dbp ||= openIdb().then((d) => {
    d.onversionchange = () => { try { d.close(); } catch (_) {} dbp = null; };
    d.onclose = () => { dbp = null; };
    return d;
  }).catch((e) => { dbp = null; throw e; }));
  async function tx(store, mode, fn) {
    let d = await db();
    let t;
    try { t = d.transaction(store, mode); } catch (e) {
      if (!e || e.name !== "InvalidStateError") throw e;
      dbp = null; // closed under us: reconnect once
      d = await db();
      t = d.transaction(store, mode);
    }
    return new Promise((resolve, reject) => {
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
    // Walk the records whose index value is < hi (oldest first) inside ONE readwrite transaction, one record in
    // memory at a time. fn(record) -> "delete" | a replacement record (same id) | anything else = keep as is.
    // fn must be synchronous (awaiting other work would end the transaction). Returns { scanned, updated, deleted }.
    rewrite: (store, index, hi, fn) => tx(store, "readwrite", (s) => new Promise((resolve, reject) => {
      const out = { scanned: 0, updated: 0, deleted: 0 };
      const req = s.index(index).openCursor(IDBKeyRange.upperBound(hi, true));
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(out);
        out.scanned++;
        let r;
        try { r = fn(c.value); } catch (e) { try { s.transaction.abort(); } catch (_) {} reject(e); return; }
        if (r === "delete") { c.delete(); out.deleted++; } else if (r && typeof r === "object") { c.update(r); out.updated++; }
        c.continue();
      };
      req.onerror = () => reject(req.error);
    })),
  };
}

// IndexedDB only indexes records whose key-path value is a valid key (number, string, Date, array); records with
// null / undefined / boolean there are invisible to index queries. The memory adapter mirrors that so unit tests see
// what the real database does.
const validKey = (v) => (typeof v === "number" && !Number.isNaN(v)) || typeof v === "string" || v instanceof Date || Array.isArray(v);

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
      const all = indexed(name, index).filter((r) => (lo == null || r[index] >= lo) && (hi == null || r[index] <= hi));
      return clone(sorted(all, index));
    },
    async byIndex(name, index, value) { return clone(sorted(indexed(name, index).filter((r) => r[index] === value), "id")); },
    async all(name) { return clone([...st(name).values()]); },
    async latest(name, index, limit) { return clone(sorted(indexed(name, index), index).reverse().slice(0, limit)); },
    async deleteBelow(name, index, hi) {
      let n = 0;
      for (const [k, r] of st(name)) if (validKey(r[index]) && r[index] < hi) { st(name).delete(k); n++; }
      return n;
    },
    // Same contract as the IndexedDB version (synchronous fn, oldest first, one pass).
    async rewrite(name, index, hi, fn) {
      const out = { scanned: 0, updated: 0, deleted: 0 };
      const store = st(name);
      const recs = sorted(indexed(name, index).filter((r) => r[index] < hi), index);
      const before = new Map(store);
      try {
        for (const rec of recs) {
          out.scanned++;
          const r = fn(clone(rec));
          if (r === "delete") { store.delete(rec.id); out.deleted++; } else if (r && typeof r === "object") { store.set(rec.id, clone({ ...r, id: rec.id })); out.updated++; }
        }
      } catch (e) {
        store.clear(); for (const [k, v] of before) store.set(k, v); // all or nothing, like an aborted transaction
        throw e;
      }
      return out;
    },
  };
  function indexed(name, index) { return [...st(name).values()].filter((r) => validKey(r[index])); }
}

let adapter = null;
export function db() {
  if (!adapter) adapter = typeof indexedDB !== "undefined" ? idbAdapter() : memoryAdapter();
  return adapter;
}
export function useMemoryDb() { adapter = memoryAdapter(); return adapter; }
