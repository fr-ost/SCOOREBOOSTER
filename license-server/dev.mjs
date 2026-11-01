// Local try-out: node dev.mjs  ->  http://localhost:3000 (admin password: ADMIN_SECRET or "local-dev-secret").
// In-memory storage (keys vanish when it stops), the same headers as vercel.json. Not used on Vercel.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { memoryDb } from "./lib/redis.js";

globalThis.__scxTestDb = memoryDb();
process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || "local-dev-secret";
const here = path.dirname(fileURLToPath(import.meta.url));
const conf = JSON.parse(fs.readFileSync(path.join(here, "vercel.json"), "utf8"));
const API = { "/api/activate": "./api/activate.js", "/api/verify": "./api/verify.js", "/api/admin": "./api/admin.js" };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const port = Number(process.env.PORT) || 3000;

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  for (const h of conf.headers[0].headers) res.setHeader(h.key, h.value);
  if (API[url.pathname]) {
    let raw = "";
    for await (const c of req) raw += c;
    try { req.body = raw ? JSON.parse(raw) : {}; } catch (_) { req.body = raw; }
    const mod = await import(API[url.pathname]);
    return mod.default(req, res);
  }
  const file = path.join(here, "public", url.pathname === "/" ? "index.html" : path.normalize(url.pathname).replace(/^([/\\])+/, ""));
  if (!file.startsWith(path.join(here, "public")) || !fs.existsSync(file)) { res.statusCode = 404; return res.end("Not found"); }
  res.setHeader("Content-Type", TYPES[path.extname(file)] || "application/octet-stream");
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`ScoreX license server (local, in memory): http://localhost:${port}  admin password: ${process.env.ADMIN_SECRET}`));
