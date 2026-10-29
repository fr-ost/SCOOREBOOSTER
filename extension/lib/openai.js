// ScoreX - minimal OpenAI Responses API client (raw fetch, no SDK, no remote code).
// POST https://api.openai.com/v1/responses with store:false. Reads the real token usage from every
// response. The API key is only ever placed in the Authorization header - never logged or returned.

import { redact, now } from "./util.js";

export const OPENAI_URL = "https://api.openai.com/v1/responses";

// Optional request parameters some models reject; dropped automatically on a 400 that names them.
const DROPPABLE = {
  "text.verbosity": "noVerbosity",
  verbosity: "noVerbosity",
  "text.format": "noFormat",
  "text.format.type": "noFormat",
  text: "noFormat",
  response_format: "noFormat",
  "reasoning.effort": "noReasoning",
  reasoning: "noReasoning",
  store: "noStore",
};

export function extractUsage(u) {
  if (!u) return { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  const it = u.input_tokens_details || u.prompt_tokens_details || {};
  const ot = u.output_tokens_details || u.completion_tokens_details || {};
  return {
    input: Number(u.input_tokens ?? u.prompt_tokens ?? 0) || 0,
    cached: Number(it.cached_tokens ?? 0) || 0,
    cacheWrite: Number(it.cache_write_tokens ?? 0) || 0,
    output: Number(u.output_tokens ?? u.completion_tokens ?? 0) || 0,
    reasoning: Number(ot.reasoning_tokens ?? 0) || 0,
  };
}

export function extractText(r) {
  let text = "", refusal = "";
  if (r && Array.isArray(r.output)) {
    for (const item of r.output) {
      if (!item || item.type !== "message") continue;
      for (const part of item.content || []) {
        if (!part) continue;
        if (part.type === "output_text" && typeof part.text === "string") text += part.text;
        else if (part.type === "refusal") refusal += part.refusal || "";
      }
    }
  }
  if (!text && r && typeof r.output_text === "string") text = r.output_text;
  if (!text && r && r.choices && r.choices[0] && r.choices[0].message) text = r.choices[0].message.content || "";
  return { text: text.trim(), refusal: refusal.trim() };
}

// Classify an HTTP error into a kind the engine acts on.
export function classifyError(status, body, headers) {
  const err = (body && body.error) || {};
  const code = err.code || "";
  const type = err.type || "";
  const message = redact(String(err.message || (typeof body === "string" ? body : "") || `HTTP ${status}`)).slice(0, 300);
  const param = err.param || "";
  let retryAfterMs = null;
  const ra = headers && (headers.get ? headers.get("retry-after") : headers["retry-after"]);
  if (ra && Number.isFinite(Number(ra))) retryAfterMs = Number(ra) * 1000;
  let kind = "bad_request";
  if (status === 401) kind = "auth";
  else if (status === 403) kind = "forbidden";
  else if (status === 404 || code === "model_not_found") kind = "model";
  else if (status === 429) {
    const quotaCodes = ["insufficient_quota", "credit_balance_exhausted", "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "organization_usage_limit_exceeded", "billing_hard_limit_reached"];
    kind = quotaCodes.includes(code) || type === "insufficient_quota" ? "quota" : "rate";
  }
  else if (status === 400 && (code === "unsupported_parameter" || code === "unsupported_value") && param) kind = "unsupported";
  else if (status >= 500) kind = "server";
  if (status === 429 && /quota|billing|credit|spend/i.test(message) && code !== "rate_limit_exceeded") kind = "quota";
  return { kind, status, code, type, param, message, retryAfterMs };
}

export function buildBody({ model, instructions, input, effort, maxOutputTokens, jsonSchema, compat = {} }) {
  const body = {
    model: model.name,
    instructions,
    input: [{ role: "user", content: [{ type: "input_text", text: input }] }],
    max_output_tokens: model.maxOutputTokens || maxOutputTokens || 1500,
  };
  if (!compat.noStore) body.store = false;
  if (model.reasoning && effort && !compat.noReasoning) body.reasoning = { effort };
  const text = {};
  if (!compat.noVerbosity) text.verbosity = "low";
  if (jsonSchema && !compat.noFormat) text.format = { type: "json_schema", name: jsonSchema.name, schema: jsonSchema.schema, strict: true };
  if (Object.keys(text).length) body.text = text;
  return body;
}

// One model call. Returns { ok, text, refusal, usage, status, incompleteReason, ms, compat, error }.
// compat (per model name) is updated in place when the API rejects an optional parameter.
export async function callModel({ apiKey, model, instructions, input, effort, jsonSchema, timeoutMs = 90000, compat = {}, fetchImpl }) {
  const f = fetchImpl || globalThis.fetch;
  if (!apiKey) return { ok: false, error: { kind: "no_key", message: "No OpenAI API key set" }, usage: extractUsage(null), ms: 0, compat };
  const started = now();
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const body = buildBody({ model, instructions, input, effort, jsonSchema, compat });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res, json = null, raw = "";
    try {
      res = await f(OPENAI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      raw = await res.text();
      try { json = JSON.parse(raw); } catch (_) { json = null; }
    } catch (e) {
      clearTimeout(timer);
      const aborted = e && (e.name === "AbortError" || /abort/i.test(String(e.message)));
      return { ok: false, error: { kind: aborted ? "timeout" : "network", message: aborted ? `No answer within ${Math.round(timeoutMs / 1000)}s` : redact(String((e && e.message) || e)).slice(0, 200) }, usage: extractUsage(null), ms: now() - started, compat };
    }
    clearTimeout(timer);
    if (!res.ok) {
      const err = classifyError(res.status, json || raw, res.headers);
      if (err.kind === "unsupported" && DROPPABLE[err.param] && !compat[DROPPABLE[err.param]]) {
        compat[DROPPABLE[err.param]] = true;
        lastErr = err;
        continue; // retry without the rejected parameter
      }
      return { ok: false, error: err, usage: extractUsage(json && json.usage), ms: now() - started, compat };
    }
    if (!json) return { ok: false, error: { kind: "bad_response", message: "Response was not JSON" }, usage: extractUsage(null), ms: now() - started, compat };
    const usage = extractUsage(json.usage);
    const { text, refusal } = extractText(json);
    const status = json.status || "completed";
    const incompleteReason = (json.incomplete_details && json.incomplete_details.reason) || null;
    if (!text) {
      const kind = refusal ? "refusal" : status === "incomplete" ? "incomplete" : "empty";
      return { ok: false, error: { kind, message: refusal || (incompleteReason ? `Incomplete: ${incompleteReason}` : "Empty output") }, usage, status, incompleteReason, ms: now() - started, compat };
    }
    return { ok: true, text, refusal, usage, status, incompleteReason, ms: now() - started, compat };
  }
  return { ok: false, error: lastErr || { kind: "bad_request", message: "Request rejected" }, usage: extractUsage(null), ms: now() - started, compat };
}

// Parse a JSON-schema answer, tolerating code fences or extra prose around it.
export function parseJsonAnswer(text) {
  const t = String(text || "").trim();
  try { return JSON.parse(t); } catch (_) {}
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1]); } catch (_) {} }
  const i = t.indexOf("{"), j = t.lastIndexOf("}");
  if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch (_) {} }
  return null;
}
