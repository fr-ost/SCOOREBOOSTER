// The Vercel function wrapper: method check, CORS for the extension's two public calls, JSON in and out,
// the caller's IP for rate limits, and a plain message instead of a stack trace when something breaks.
import { db } from "./redis.js";

export function ipOf(req) {
  const f = String((req.headers && (req.headers["x-forwarded-for"] || req.headers["x-real-ip"])) || "").split(",")[0].trim();
  return f || (req.socket && req.socket.remoteAddress) || "?";
}

function bodyOf(req) {
  try {
    const b = req.body;
    if (b && typeof b === "object") return b;
    if (typeof b === "string" && b) return JSON.parse(b);
  } catch (_) { /* not JSON */ }
  return {};
}

// run(store, body, req) -> { status, body }. cors: the extension (another origin) may call it; admin calls never.
export function handler(run, { cors = false } = {}) {
  return async function (req, res) {
    if (cors) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Max-Age", "86400");
      if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") { res.statusCode = 405; res.end(JSON.stringify({ ok: false, error: "method", message: "Use POST" })); return; }
    try {
      const r = await run(db(), bodyOf(req), req);
      res.statusCode = r.status;
      res.end(JSON.stringify(r.body));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: e && e.setup ? "setup" : "server", message: e && e.setup ? e.message : "The license server had a problem. Try again in a minute." }));
      if (!(e && e.setup)) console.error("[scorex-license]", e && e.message);
    }
  };
}
