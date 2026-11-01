// POST /api/admin { action: "create" | "list" | "revoke" | "reset" | "delete", ... }
// Header: Authorization: Bearer <ADMIN_SECRET>. Used by the admin page at / (same origin, no CORS).
import { handler, ipOf } from "../lib/http.js";
import { admin } from "../lib/core.js";

export default handler((store, body, req) => admin(store, body, req.headers && req.headers.authorization, ipOf(req), process.env.ADMIN_SECRET));
