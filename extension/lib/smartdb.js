// ScoreX - smart-follower database: every smart follower the TwitterScore API lists for the big accounts you sweep
// (lib/scoreboard.js buildSmartDb), one row per account in IndexedDB ("smartdb", id = lowercase handle), merged across
// sweeps: who they are, their TwitterScore, whose smart follower they are, and when they were first and last seen.
// Discover shows it and exports it as CSV or XLSX (lib/xlsx.js). Written only by the service worker.
//
// Row { id, handle, name, score, followers, bio, tags: [], sources: [handle], sourceCount, firstSeen, lastSeen }
import { db, STORES } from "./db.js";
import { normalizeHandle, now } from "./util.js";

const MAX_SOURCES = 200;

// Merge one page of smart followers of `source` into the database. Returns { added, updated }.
export async function upsertRows(source, list, ts = now()) {
  const src = normalizeHandle(source);
  let added = 0, updated = 0;
  for (const it of list || []) {
    const h = normalizeHandle(it && it.handle);
    if (!h || h === src) continue;
    const cur = await db().get(STORES.smartdb, h);
    const sources = cur && Array.isArray(cur.sources) ? cur.sources.slice() : [];
    if (src && !sources.includes(src) && sources.length < MAX_SOURCES) sources.push(src);
    const num = (v, old) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : old ?? null);
    const row = {
      id: h, handle: h,
      name: String((it.name || (cur && cur.name) || "")).slice(0, 80),
      score: num(it.score, cur && cur.score),
      followers: num(it.followers, cur && cur.followers),
      bio: String((it.bio || (cur && cur.bio) || "")).slice(0, 300),
      tags: Array.isArray(it.tags) && it.tags.length ? it.tags.slice(0, 8) : (cur && cur.tags) || [],
      sources, sourceCount: sources.length,
      firstSeen: (cur && cur.firstSeen) || ts, lastSeen: ts,
    };
    await db().put(STORES.smartdb, row);
    if (cur) updated++; else added++;
  }
  return { added, updated };
}

// Every row, best first (TwitterScore, then how many swept accounts list it).
export async function listRows() {
  const rows = await db().all(STORES.smartdb);
  return rows.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || (b.sourceCount || 0) - (a.sourceCount || 0) || a.handle.localeCompare(b.handle));
}
export async function countRows() { return db().count(STORES.smartdb); }
export async function removeRows(handles) {
  let n = 0;
  for (const h of (handles || []).map(normalizeHandle).filter(Boolean)) { await db().del(STORES.smartdb, h); n++; }
  return n;
}
export async function clearRows() { await db().clear(STORES.smartdb); }

// Export columns (CSV / XLSX): header, value.
export const COLUMNS = [
  ["Handle", (r) => r.handle],
  ["Name", (r) => r.name || ""],
  ["TwitterScore", (r) => (r.score == null ? "" : r.score)],
  ["Followers", (r) => (r.followers == null ? "" : r.followers)],
  ["Smart follower of (count)", (r) => r.sourceCount || 0],
  ["Smart follower of", (r) => (r.sources || []).join(" ")],
  ["Tags", (r) => (r.tags || []).join(", ")],
  ["Bio", (r) => r.bio || ""],
  ["Profile", (r) => "https://x.com/" + r.handle],
  ["First seen", (r) => (r.firstSeen ? new Date(r.firstSeen).toISOString().slice(0, 10) : "")],
  ["Last seen", (r) => (r.lastSeen ? new Date(r.lastSeen).toISOString().slice(0, 10) : "")],
];
export function toTable(rows) {
  return [COLUMNS.map(([h]) => h), ...(rows || []).map((r) => COLUMNS.map(([, f]) => f(r)))];
}
