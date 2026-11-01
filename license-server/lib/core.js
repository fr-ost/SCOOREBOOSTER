// ScoreX license logic: one key works on one browser.
//   create (admin)  -> random keys "SCX-XXXX-XXXX-XXXX-XXXX" (80 random bits); only their SHA-256 is stored
//   activate        -> the first browser (a random install ID) that sends a key owns it; any other browser is refused
//   verify          -> the extension asks every few hours: still active, not revoked, still this browser?
//   revoke / reset / delete (admin) -> turn a key off, free it for a new browser, or remove it
// Every function returns { status, body } and never throws for bad input; storage errors propagate (500).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 symbols, no 0/O/1/I
export const KEY_RE = /^SCX(?:-[A-HJ-NP-Z2-9]{4}){4}$/;
const DEVICE_RE = /^[A-Za-z0-9-]{8,64}$/;
const RATE = { activate: [20, 600], verify: [120, 600], adminFail: [10, 600] }; // [max hits, window seconds] per IP

const out = (status, body) => ({ status, body });
const fail = (status, error, message) => out(status, { ok: false, error, message });
export const hashKey = (key) => createHash("sha256").update(key).digest("hex");
const recKey = (id) => `lic:${id}`;
const devKey = (id) => `lic:${id}:dev`;

export function newKey() {
  const bytes = randomBytes(16);
  let s = "";
  for (let i = 0; i < 16; i++) s += ALPHABET[bytes[i] & 31];
  return `SCX-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
}

// "scx-abcd-..." or pasted without dashes -> the canonical form ("" when it cannot be a key).
export function normalizeKey(raw) {
  const c = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (c.length !== 19 || !c.startsWith("SCX")) return "";
  const k = `SCX-${c.slice(3, 7)}-${c.slice(7, 11)}-${c.slice(11, 15)}-${c.slice(15, 19)}`;
  return KEY_RE.test(k) ? k : "";
}

async function limited(store, kind, ip) {
  const [max, ttl] = RATE[kind];
  return (await store.hit(`rl:${kind}:${ip || "?"}`, ttl)) > max;
}

function input(body) {
  const key = normalizeKey(body && body.key);
  const deviceId = String((body && body.deviceId) || "");
  const version = String((body && body.version) || "").slice(0, 20);
  return { key, deviceId, version, ok: !!key && DEVICE_RE.test(deviceId) };
}

const MSG = {
  invalid: "This license key doesn't exist. Check it, or ask your admin for a key.",
  revoked: "This license key was turned off by your admin.",
  used: "This license key is already used on another browser. Ask your admin for a new key, or to reset this one.",
  inactive: "This license key is no longer active on this browser. Enter it again, or ask your admin.",
  rate: "Too many tries. Wait a few minutes and try again.",
};

export async function activate(store, body, ip, ts = Date.now()) {
  const q = input(body);
  if (!q.ok) return fail(400, "bad_request", "Enter a key like SCX-XXXX-XXXX-XXXX-XXXX");
  if (await limited(store, "activate", ip)) return fail(429, "rate", MSG.rate);
  const id = hashKey(q.key);
  const rec = await store.get(recKey(id));
  if (!rec) return fail(404, "invalid", MSG.invalid);
  if (rec.status === "revoked") return fail(403, "revoked", MSG.revoked);
  // The first browser wins, atomically (two activations at the same moment cannot both bind).
  const first = await store.setNX(devKey(id), q.deviceId);
  if (!first && (await store.get(devKey(id))) !== q.deviceId) return fail(409, "used", MSG.used);
  const next = { ...rec, status: "active", deviceId: q.deviceId, activatedAt: rec.deviceId === q.deviceId && rec.activatedAt ? rec.activatedAt : ts, lastSeenAt: ts, version: q.version || rec.version || null };
  await store.set(recKey(id), next);
  return out(200, { ok: true, status: "active", note: rec.note || "", activatedAt: next.activatedAt });
}

export async function verify(store, body, ip, ts = Date.now()) {
  const q = input(body);
  if (!q.ok) return fail(400, "bad_request", "Missing key or install ID");
  if (await limited(store, "verify", ip)) return fail(429, "rate", MSG.rate);
  const id = hashKey(q.key);
  const rec = await store.get(recKey(id));
  if (!rec) return fail(404, "invalid", MSG.invalid);
  if (rec.status === "revoked") return fail(403, "revoked", MSG.revoked);
  const dev = await store.get(devKey(id));
  if (!dev) return fail(409, "inactive", MSG.inactive);
  if (dev !== q.deviceId) return fail(409, "used", MSG.used);
  await store.set(recKey(id), { ...rec, status: "active", lastSeenAt: ts, version: q.version || rec.version || null });
  return out(200, { ok: true, status: "active", note: rec.note || "" });
}

// ---------- admin ----------

function sameSecret(given, secret) {
  const a = createHash("sha256").update(String(given || "")).digest();
  const b = createHash("sha256").update(String(secret || "")).digest();
  return timingSafeEqual(a, b);
}
const bearer = (h) => String(h || "").replace(/^Bearer\s+/i, "");
const view = (r) => ({ id: r.id, hint: r.hint, note: r.note || "", status: r.status, createdAt: r.createdAt, activatedAt: r.activatedAt || null, lastSeenAt: r.lastSeenAt || null, version: r.version || null, device: r.deviceId ? String(r.deviceId).slice(0, 8) : null });

export async function admin(store, body, authHeader, ip, secret, ts = Date.now()) {
  if (!secret || String(secret).length < 12) return fail(500, "setup", "Set ADMIN_SECRET (12+ characters) in the Vercel project's Environment Variables, then redeploy");
  if (!sameSecret(bearer(authHeader), secret)) {
    if (await limited(store, "adminFail", ip)) return fail(429, "rate", MSG.rate);
    return fail(401, "unauthorized", "Wrong admin password");
  }
  const action = String((body && body.action) || "");
  if (action === "create") {
    const count = Math.max(1, Math.min(100, Math.round(Number(body.count) || 1)));
    const note = String(body.note || "").replace(/\s+/g, " ").trim().slice(0, 60);
    const keys = [];
    while (keys.length < count) {
      const key = newKey(), id = hashKey(key);
      const rec = { id, hint: key.slice(-4), note, status: "unused", createdAt: ts, deviceId: null, activatedAt: null, lastSeenAt: null, version: null };
      if (!(await store.setNX(recKey(id), rec))) continue; // (a collision is practically impossible; never overwrite)
      await store.sadd("lic:all", id);
      keys.push({ key, id, hint: rec.hint, note });
    }
    return out(200, { ok: true, keys });
  }
  if (action === "list") {
    const ids = await store.smembers("lic:all");
    const recs = (await store.mget(ids.map(recKey))).filter(Boolean);
    recs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return out(200, { ok: true, keys: recs.map(view) });
  }
  const id = String((body && body.id) || "");
  if (!/^[a-f0-9]{64}$/.test(id)) return fail(400, "bad_request", "Unknown action or missing key id");
  const rec = await store.get(recKey(id));
  if (!rec) return fail(404, "invalid", "No such key");
  if (action === "revoke") { await store.set(recKey(id), { ...rec, status: "revoked" }); return out(200, { ok: true }); }
  if (action === "reset") {
    await store.del(devKey(id));
    await store.set(recKey(id), { ...rec, status: "unused", deviceId: null, activatedAt: null, lastSeenAt: null });
    return out(200, { ok: true });
  }
  if (action === "delete") { await store.del(recKey(id), devKey(id)); await store.srem("lic:all", id); return out(200, { ok: true }); }
  return fail(400, "bad_request", "Unknown action");
}
