// POST /api/verify { key, deviceId, version } - called by the extension every few hours.
import { handler, ipOf } from "../lib/http.js";
import { verify } from "../lib/core.js";

export default handler((store, body, req) => verify(store, body, ipOf(req)), { cors: true });
