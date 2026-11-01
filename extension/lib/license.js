// ScoreX - license (team copies). ScoreX stays locked until a license key from your license server (license-server/,
// on Vercel) is activated. A key works on ONE browser: the first install that activates it owns it (a random install
// ID, never anything about you). The worker checks it again every 6 hours; when the server cannot be reached ScoreX
// keeps working for 3 days after the last good check, then locks until it can check again. A key your admin revoked
// or reset stops ScoreX at the next check. Sent to the server: the key, the install ID and the ScoreX version.
// Stored in chrome.storage.local "sx.license" (kept by Reset everything and never part of a backup).
import { K, VERSION } from "./constants.js";
import { load, save } from "./store.js";
import { now, HOUR, DAY } from "./util.js";

// >>> Your license server: the URL of the Vercel project (README > License). Set it before you zip ScoreX. <<<
export const LICENSE_SERVER = "https://scorex-license.vercel.app";

export const CHECK_EVERY_MS = 6 * HOUR;
export const GRACE_MS = 3 * DAY;
const TIMEOUT_MS = 15000;
const KEY_RE = /^SCX(?:-[A-HJ-NP-Z2-9]{4}){4}$/;

// "scx-abcd..." or pasted without dashes -> "SCX-ABCD-EFGH-JKLM-NPQR" ("" when it cannot be a key).
export function normalizeKey(raw) {
  const c = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (c.length !== 19 || !c.startsWith("SCX")) return "";
  const k = `SCX-${c.slice(3, 7)}-${c.slice(7, 11)}-${c.slice(11, 15)}-${c.slice(15, 19)}`;
  return KEY_RE.test(k) ? k : "";
}
export const keyHint = (key) => (key ? "…" + String(key).slice(-4) : "");

const LOCKED_TEXT = {
  none: "Enter your license key to use ScoreX.",
  invalid: "This license key doesn't exist. Check it, or ask your admin for a key.",
  revoked: "This license key was turned off by your admin.",
  used: "This license key is used on another browser. Ask your admin for a new key, or to reset this one.",
  inactive: "This license key is no longer active on this browser. Enter it again, or ask your admin.",
  offline: "ScoreX could not reach the license server for 3 days. Connect to the internet and check again.",
};

// Is ScoreX unlocked? { ok, reason, message }. Pure: the dashboard, the popup and the worker all use it.
export function licenseState(lic, ts = now()) {
  if (!lic || !lic.key) return { ok: false, reason: "none", message: LOCKED_TEXT.none };
  if (lic.status !== "active") return { ok: false, reason: lic.status || "none", message: lic.message || LOCKED_TEXT[lic.status] || LOCKED_TEXT.none };
  if (!lic.checkedAt || ts - lic.checkedAt > GRACE_MS) return { ok: false, reason: "offline", message: LOCKED_TEXT.offline };
  return { ok: true, reason: "active", message: "" };
}

export async function getLicense() { return load(K.license, {}); }

function newDeviceId() {
  try { if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (_) { /* fall through */ }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// POST to the license server. { status, body } or { network: true } (no answer / not JSON).
async function post(path, body, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
  try {
    const res = await f(LICENSE_SERVER.replace(/\/+$/, "") + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl ? ctl.signal : undefined, credentials: "omit" });
    let j = null;
    try { j = await res.json(); } catch (_) { j = null; }
    if (!j || typeof j !== "object") return { network: true, status: res.status };
    return { status: res.status, body: j };
  } catch (_) {
    return { network: true };
  } finally { if (timer) clearTimeout(timer); }
}

// The server refused for good (the key is unknown, revoked, reset or bound to another browser).
const FINAL = ["invalid", "revoked", "used", "inactive"];

// Enter a key. { ok, error? }. On success ScoreX unlocks at once.
export async function activate(rawKey, { fetchImpl } = {}) {
  const key = normalizeKey(rawKey);
  if (!key) return { ok: false, error: "That doesn't look like a ScoreX key (SCX-XXXX-XXXX-XXXX-XXXX)." };
  const cur = await getLicense();
  const deviceId = cur.deviceId || newDeviceId();
  if (!cur.deviceId) await save({ [K.license]: { ...cur, deviceId } }); // the same install ID for every try
  const r = await post("/api/activate", { key, deviceId, version: VERSION }, fetchImpl);
  if (r.network) return { ok: false, error: "Can't reach the license server. Check your internet connection and try again." };
  if (r.status === 200 && r.body.ok) {
    const ts = now();
    await save({ [K.license]: { key, deviceId, status: "active", message: "", note: String(r.body.note || "").slice(0, 60), activatedAt: ts, checkedAt: ts } });
    return { ok: true };
  }
  return { ok: false, error: (r.body && r.body.message) || (r.status === 429 ? "Too many tries. Wait a few minutes." : `The license server answered ${r.status}.`) };
}

// Check the key with the server (at most every 6 hours unless forced). Returns licenseState() afterwards.
// No answer: nothing changes (3 days of grace from the last good check). A final refusal locks ScoreX.
export async function verify({ force = false, fetchImpl } = {}) {
  const lic = await getLicense();
  if (!lic.key) return licenseState(lic);
  if (!force && lic.status === "active" && lic.checkedAt && now() - lic.checkedAt < CHECK_EVERY_MS) return licenseState(lic);
  const r = await post("/api/verify", { key: lic.key, deviceId: lic.deviceId, version: VERSION }, fetchImpl);
  if (r.network || !r.body) return licenseState(await getLicense());
  const cur = await getLicense();
  if (cur.key !== lic.key) return licenseState(cur); // a different key was entered meanwhile
  if (r.status === 200 && r.body.ok) {
    const next = { ...cur, status: "active", message: "", checkedAt: now(), note: String(r.body.note || cur.note || "").slice(0, 60) };
    await save({ [K.license]: next });
    return licenseState(next);
  }
  if (FINAL.includes(r.body.error)) {
    const next = { ...cur, status: r.body.error, message: String(r.body.message || "").slice(0, 200), lockedAt: now() };
    await save({ [K.license]: next });
    return licenseState(next);
  }
  return licenseState(cur); // 429 / 5xx: try again later, grace applies
}

// Forget the key on this browser (the install ID stays, so the same key can be entered here again).
export async function removeLicense() {
  const cur = await getLicense();
  await save({ [K.license]: cur.deviceId ? { deviceId: cur.deviceId } : {} });
}

// What the dashboard shows (never the full key).
export function licenseView(lic, ts = now()) {
  const st = licenseState(lic, ts);
  return { ...st, hint: keyHint(lic && lic.key), note: (lic && lic.note) || "", activatedAt: (lic && lic.activatedAt) || null, checkedAt: (lic && lic.checkedAt) || null, server: LICENSE_SERVER };
}
