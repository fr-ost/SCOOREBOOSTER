// POST /api/activate { key, deviceId, version } - called by the extension when someone enters a key.
import { handler, ipOf } from "../lib/http.js";
import { activate } from "../lib/core.js";

export default handler((store, body, req) => activate(store, body, ipOf(req)), { cors: true });
