// ScoreX - smart follower database (Discover > Smart follower database): every smart follower TwitterScore lists for
// the accounts you scan (lib/scoreboard.js buildSmartDb), one row per username in IndexedDB ("smartdb", id = lowercase
// username). Scanning several accounts merges duplicates: the row keeps the newest score and date of scan, and the
// accounts it was found under. Exported as CSV or Excel (lib/xlsx.js). Written only by the service worker.
//
// Row { id, handle, score, scannedAt, sources: [handle] }   (rows from 1.3.0 builds may carry lastSeen instead)
import { db, STORES } from "./db.js";
import { normalizeHandle, now, zonedParts } from "./util.js";

const MAX_SOURCES = 200;
const scoreOf = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
export const scannedAt = (r) => (r && (r.scannedAt || r.lastSeen)) || null;

// Merge one page of smart followers of `source`. Returns { added, updated }.
export async function upsertRows(source, list, ts = now()) {
  const src = normalizeHandle(source);
  let added = 0, updated = 0;
  for (const it of list || []) {
    const h = normalizeHandle(it && it.handle);
    if (!h || h === src) continue;
    const cur = await db().get(STORES.smartdb, h);
    const sources = cur && Array.isArray(cur.sources) ? cur.sources.slice() : [];
    if (src && !sources.includes(src) && sources.length < MAX_SOURCES) sources.push(src);
    const score = scoreOf(it.score);
    await db().put(STORES.smartdb, { id: h, handle: h, score: score != null ? score : cur ? scoreOf(cur.score) : null, scannedAt: ts, sources });
    if (cur) updated++; else added++;
  }
  return { added, updated };
}

// Every row, best first (TwitterScore, then how many scanned accounts list it).
export async function listRows() {
  const rows = await db().all(STORES.smartdb);
  return rows.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || ((b.sources || []).length - (a.sources || []).length) || String(a.handle).localeCompare(String(b.handle)));
}
export async function countRows() { return db().count(STORES.smartdb); }
export async function removeRows(handles) {
  let n = 0;
  for (const h of (handles || []).map(normalizeHandle).filter(Boolean)) { await db().del(STORES.smartdb, h); n++; }
  return n;
}
export async function clearRows() { await db().clear(STORES.smartdb); }

// "2026-11-01 08:15" in your time zone (Settings).
export function fmtScan(ts, timeZone) {
  if (!ts) return "";
  try {
    const p = zonedParts(ts, timeZone || "UTC");
    const z = (n) => String(n).padStart(2, "0");
    return `${p.year}-${z(p.month)}-${z(p.day)} ${z(p.hour)}:${z(p.minute)}`;
  } catch (_) { return new Date(ts).toISOString().slice(0, 16).replace("T", " "); }
}

// The download (CSV / Excel): username, score, date of scan, and the scanned accounts that list it.
export const COLUMNS = [
  ["Username", (r) => r.handle],
  ["TwitterScore", (r) => (r.score == null ? "" : Number(r.score))],
  ["Date of scan", (r, tz) => fmtScan(scannedAt(r), tz)],
  ["Smart follower of", (r) => (r.sources || []).join(", ")], // no "@": a cell starting with @ reads as a formula
];
export function toTable(rows, timeZone) {
  return [COLUMNS.map(([h]) => h), ...(rows || []).map((r) => COLUMNS.map(([, f]) => f(r, timeZone)))];
}
