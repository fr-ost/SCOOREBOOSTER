import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { extractUsage, extractText, classifyError, buildBody, callModel, parseJsonAnswer, OPENAI_URL } from "../../extension/lib/openai.js";
import { _setClock } from "../../extension/lib/util.js";

const KEY = "sk-test-SECRET1234567890abcdef";
const MODEL = { id: "m_cheap", name: "gpt-6-luna", reasoning: true, maxOutputTokens: 1500, prices: { input: 0.1, output: 0.5 } };
const SCHEMA = { name: "scorex_reply", schema: { type: "object", properties: { comment: { type: "string" } }, required: ["comment"], additionalProperties: false } };

const okBody = (text, extra = {}) => ({
  id: "resp_1", status: "completed",
  output: [{ type: "reasoning", id: "rs_1", summary: [] }, { type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
  usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 300 }, output_tokens: 500, output_tokens_details: { reasoning_tokens: 400 }, total_tokens: 1700 },
  ...extra,
});
const errBody = (code, message, param = null, type = "invalid_request_error") => ({ error: { message, type, param, code } });
const respond = (status, body, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

// Fake fetch: replies from a queue of handlers, records every request.
function fakeFetch(...handlers) {
  const calls = [];
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    const hnd = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    return typeof hnd === "function" ? hnd(body, init) : hnd;
  };
  f.calls = calls;
  return f;
}

describe("openai.js", () => {
  afterEach(() => _setClock(null));

  describe("extractUsage", () => {
    test("Responses API shape", () => {
      assert.deepEqual(extractUsage(okBody("x").usage), { input: 1200, cached: 300, cacheWrite: 0, output: 500, reasoning: 400 });
      assert.deepEqual(extractUsage({ input_tokens: 10, input_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 }, output_tokens: 4 }), { input: 10, cached: 2, cacheWrite: 3, output: 4, reasoning: 0 });
    });
    test("Chat Completions shape", () => {
      const u = { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 10 } };
      assert.deepEqual(extractUsage(u), { input: 100, cached: 20, cacheWrite: 0, output: 30, reasoning: 10 });
    });
    test("missing / broken fields are zero", () => {
      const zero = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };
      assert.deepEqual(extractUsage(null), zero);
      assert.deepEqual(extractUsage(undefined), zero);
      assert.deepEqual(extractUsage({}), zero);
      assert.deepEqual(extractUsage({ input_tokens: "abc", output_tokens: null, input_tokens_details: null }), zero);
      assert.deepEqual(extractUsage({ input_tokens: 5 }), { ...zero, input: 5 });
    });
  });

  describe("extractText", () => {
    test("skips the reasoning item and joins output_text parts", () => {
      const r = { output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "thinking..." }] }, { type: "message", content: [{ type: "output_text", text: " Hello " }, { type: "output_text", text: "world" }] }] };
      assert.deepEqual(extractText(r), { text: "Hello world", refusal: "" });
    });
    test("refusal", () => {
      const r = { output: [{ type: "message", content: [{ type: "refusal", refusal: "I can't help with that." }] }] };
      assert.deepEqual(extractText(r), { text: "", refusal: "I can't help with that." });
    });
    test("output_text and chat fallbacks", () => {
      assert.equal(extractText({ output: [], output_text: "fallback" }).text, "fallback");
      assert.equal(extractText({ choices: [{ message: { content: " chat " } }] }).text, "chat");
      assert.equal(extractText({ output: [{ type: "message", content: [{ type: "output_text", text: "primary" }] }], output_text: "ignored" }).text, "primary");
      assert.deepEqual(extractText(null), { text: "", refusal: "" });
      assert.deepEqual(extractText({ output: [null, { type: "message" }] }), { text: "", refusal: "" });
    });
  });

  describe("classifyError", () => {
    test("401 auth, 403 forbidden", () => {
      assert.equal(classifyError(401, errBody("invalid_api_key", "Incorrect API key provided: sk-abc12345678901234")).kind, "auth");
      assert.ok(!classifyError(401, errBody("invalid_api_key", "Incorrect API key provided: sk-abc12345678901234")).message.includes("abc12345678901234"));
      assert.equal(classifyError(403, errBody("unsupported_country_region_territory", "Country not supported")).kind, "forbidden");
    });
    test("429 rate limit vs quota", () => {
      const rate = classifyError(429, errBody("rate_limit_exceeded", "Rate limit reached for requests", null, "requests"), new Headers({ "retry-after": "7" }));
      assert.equal(rate.kind, "rate");
      assert.equal(rate.retryAfterMs, 7000);
      assert.equal(classifyError(429, errBody("rate_limit_exceeded", "Rate limit reached for TPM; you exceeded your current quota of tokens per minute")).kind, "rate");
      assert.equal(classifyError(429, errBody(null, "Too many tokens", null, "tokens")).kind, "rate");
      assert.equal(classifyError(429, errBody("insufficient_quota", "You exceeded your current quota, please check your plan and billing details.", null, "insufficient_quota")).kind, "quota");
      assert.equal(classifyError(429, errBody("credit_balance_exhausted", "Your credit balance is too low")).kind, "quota");
      assert.equal(classifyError(429, errBody(null, "Billing hard limit has been reached", null, "requests")).kind, "quota");
      assert.equal(classifyError(429, {}, { "retry-after": "3" }).retryAfterMs, 3000);
      assert.equal(classifyError(429, {}, new Headers({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" })).retryAfterMs, null);
    });
    test("404 / model_not_found -> model", () => {
      assert.equal(classifyError(404, errBody("model_not_found", "The model `gpt-9` does not exist")).kind, "model");
      assert.equal(classifyError(400, errBody("model_not_found", "The model `gpt-9` does not exist")).kind, "model");
    });
    test("400 unsupported_parameter / unsupported_value with param", () => {
      const e = classifyError(400, errBody("unsupported_parameter", "Unsupported parameter: 'text.verbosity'", "text.verbosity"));
      assert.equal(e.kind, "unsupported");
      assert.equal(e.param, "text.verbosity");
      assert.equal(e.code, "unsupported_parameter");
      assert.equal(classifyError(400, errBody("unsupported_value", "Unsupported value: 'reasoning.effort'", "reasoning.effort")).kind, "unsupported");
      assert.equal(classifyError(400, errBody("unsupported_parameter", "Unsupported parameter")).kind, "bad_request"); // no param
      assert.equal(classifyError(400, errBody("invalid_value", "bad", "input")).kind, "bad_request");
    });
    test("5xx server, raw text body, message capped", () => {
      for (const s of [500, 502, 503, 504]) assert.equal(classifyError(s, null).kind, "server");
      const raw = classifyError(502, "<html>Bad gateway</html>");
      assert.equal(raw.kind, "server");
      assert.equal(raw.message, "<html>Bad gateway</html>");
      assert.equal(classifyError(500, null).message, "HTTP 500");
      assert.ok(classifyError(400, errBody("x", "y".repeat(1000))).message.length <= 300);
    });
  });

  describe("buildBody", () => {
    const base = { model: MODEL, instructions: "INSTR", input: "INPUT", effort: "low", jsonSchema: SCHEMA };
    test("full body for a reasoning model", () => {
      const b = buildBody(base);
      assert.deepEqual(b, {
        model: "gpt-6-luna",
        instructions: "INSTR",
        input: [{ role: "user", content: [{ type: "input_text", text: "INPUT" }] }],
        max_output_tokens: 1500,
        store: false,
        reasoning: { effort: "low" },
        text: { verbosity: "low", format: { type: "json_schema", name: "scorex_reply", schema: SCHEMA.schema, strict: true } },
      });
    });
    test("reasoning only when model.reasoning and an effort is given", () => {
      assert.equal("reasoning" in buildBody({ ...base, model: { ...MODEL, reasoning: false } }), false);
      assert.equal("reasoning" in buildBody({ ...base, effort: undefined }), false);
    });
    test("no schema -> only verbosity; max tokens fallbacks", () => {
      const b = buildBody({ ...base, jsonSchema: null, model: { name: "m" } });
      assert.deepEqual(b.text, { verbosity: "low" });
      assert.equal(b.max_output_tokens, 1500);
      assert.equal(buildBody({ ...base, model: { name: "m" }, maxOutputTokens: 900 }).max_output_tokens, 900);
    });
    test("compat flags drop the rejected fields", () => {
      assert.deepEqual(buildBody({ ...base, compat: { noVerbosity: true } }).text, { format: { type: "json_schema", name: "scorex_reply", schema: SCHEMA.schema, strict: true } });
      assert.deepEqual(buildBody({ ...base, compat: { noFormat: true } }).text, { verbosity: "low" });
      assert.equal("text" in buildBody({ ...base, compat: { noFormat: true, noVerbosity: true } }), false);
      assert.equal("reasoning" in buildBody({ ...base, compat: { noReasoning: true } }), false);
      assert.equal("store" in buildBody({ ...base, compat: { noStore: true } }), false);
    });
  });

  describe("callModel", () => {
    const args = (over = {}) => ({ apiKey: KEY, model: MODEL, instructions: "INSTR", input: "INPUT", effort: "low", jsonSchema: SCHEMA, compat: {}, ...over });

    test("no API key -> no request", async () => {
      const f = fakeFetch(respond(200, okBody("x")));
      const r = await callModel(args({ apiKey: "", fetchImpl: f }));
      assert.equal(r.ok, false);
      assert.equal(r.error.kind, "no_key");
      assert.equal(f.calls.length, 0);
    });

    test("success: request shape, text, usage, timing", async () => {
      let t = 1000;
      _setClock(() => (t += 250));
      const f = fakeFetch(respond(200, okBody('{"comment":"hi"}')));
      const r = await callModel(args({ fetchImpl: f }));
      assert.equal(r.ok, true);
      assert.equal(r.text, '{"comment":"hi"}');
      assert.deepEqual(r.usage, { input: 1200, cached: 300, cacheWrite: 0, output: 500, reasoning: 400 });
      assert.equal(r.status, "completed");
      assert.equal(r.incompleteReason, null);
      assert.equal(r.ms, 250);
      assert.equal(f.calls.length, 1);
      const { url, init, body } = f.calls[0];
      assert.equal(url, OPENAI_URL);
      assert.equal(init.method, "POST");
      assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
      assert.equal(init.headers["Content-Type"], "application/json");
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(body.store, false);
      assert.equal(body.model, "gpt-6-luna");
      assert.equal(body.text.verbosity, "low");
      assert.ok(!JSON.stringify(r).includes("SECRET1234567890"));
    });

    test('400 unsupported_parameter "text.verbosity" -> retried without verbosity, compat.noVerbosity set', async () => {
      const compat = {};
      const f = fakeFetch(
        respond(400, errBody("unsupported_parameter", "Unsupported parameter: 'text.verbosity' is not supported with this model.", "text.verbosity")),
        (body) => respond(200, okBody("retried ok " + JSON.stringify(body.text))),
      );
      const r = await callModel(args({ fetchImpl: f, compat }));
      assert.equal(r.ok, true);
      assert.equal(f.calls.length, 2);
      assert.equal(f.calls[0].body.text.verbosity, "low");
      assert.equal("verbosity" in f.calls[1].body.text, false);
      assert.ok(f.calls[1].body.text.format);
      assert.equal(compat.noVerbosity, true);
      assert.equal(r.compat, compat);
    });

    test("known compat flags are applied on the first request", async () => {
      const f = fakeFetch(respond(200, okBody("ok")));
      await callModel(args({ fetchImpl: f, compat: { noVerbosity: true, noReasoning: true } }));
      assert.equal("verbosity" in f.calls[0].body.text, false);
      assert.equal("reasoning" in f.calls[0].body, false);
    });

    test("the same parameter rejected again is not retried forever", async () => {
      const f = fakeFetch(() => respond(400, errBody("unsupported_parameter", "nope", "text.verbosity"))); // fresh Response each time
      const r = await callModel(args({ fetchImpl: f }));
      assert.equal(r.ok, false);
      assert.equal(r.error.kind, "unsupported");
      assert.equal(f.calls.length, 2);
    });

    test("several optional parameters dropped one by one (max 4 attempts)", async () => {
      const compat = {};
      const f = fakeFetch(
        respond(400, errBody("unsupported_parameter", "x", "text.verbosity")),
        respond(400, errBody("unsupported_parameter", "x", "text.format")),
        respond(400, errBody("unsupported_value", "x", "reasoning.effort")),
        respond(400, errBody("unsupported_parameter", "x", "store")),
      );
      const r = await callModel(args({ fetchImpl: f, compat }));
      assert.equal(r.ok, false);
      assert.equal(f.calls.length, 4);
      assert.deepEqual(compat, { noVerbosity: true, noFormat: true, noReasoning: true, noStore: true });
      assert.equal(r.error.param, "store");
      assert.equal("text" in f.calls[2].body, false);
      assert.equal("reasoning" in f.calls[3].body, false);
    });

    test("unknown unsupported parameter is returned, not retried", async () => {
      const f = fakeFetch(respond(400, errBody("unsupported_parameter", "x", "temperature")));
      const r = await callModel(args({ fetchImpl: f }));
      assert.equal(r.error.kind, "unsupported");
      assert.equal(f.calls.length, 1);
    });

    test("timeout via AbortController", async () => {
      const f = (url, init) => new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
      });
      const r = await callModel(args({ fetchImpl: f, timeoutMs: 20 }));
      assert.equal(r.ok, false);
      assert.equal(r.error.kind, "timeout");
      assert.match(r.error.message, /No answer within/);
      const f2 = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
      assert.equal((await callModel(args({ fetchImpl: f2, timeoutMs: 15 }))).error.kind, "timeout");
    });

    test("network error (message redacted)", async () => {
      const f = async () => { throw new TypeError("fetch failed: proxy said sk-leakedKEY1234567890"); };
      const r = await callModel(args({ fetchImpl: f }));
      assert.equal(r.error.kind, "network");
      assert.ok(!r.error.message.includes("leakedKEY1234567890"), r.error.message);
      assert.deepEqual(r.usage, { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 });
    });

    test("HTTP errors are classified and not retried", async () => {
      const f = fakeFetch(respond(429, errBody("insufficient_quota", "You exceeded your current quota", null, "insufficient_quota")));
      const r = await callModel(args({ fetchImpl: f }));
      assert.equal(r.error.kind, "quota");
      assert.equal(f.calls.length, 1);
      const g = fakeFetch(respond(502, "<html>bad gateway</html>"));
      assert.equal((await callModel(args({ fetchImpl: g }))).error.kind, "server");
    });

    test("200 with non-JSON body -> bad_response", async () => {
      const f = fakeFetch(respond(200, "not json at all"));
      assert.equal((await callModel(args({ fetchImpl: f }))).error.kind, "bad_response");
    });

    test("empty output with status incomplete -> kind incomplete, usage kept", async () => {
      const body = { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "reasoning", summary: [] }], usage: { input_tokens: 900, output_tokens: 1500, output_tokens_details: { reasoning_tokens: 1500 } } };
      const r = await callModel(args({ fetchImpl: fakeFetch(respond(200, body)) }));
      assert.equal(r.ok, false);
      assert.equal(r.error.kind, "incomplete");
      assert.equal(r.error.message, "Incomplete: max_output_tokens");
      assert.equal(r.incompleteReason, "max_output_tokens");
      assert.equal(r.usage.output, 1500);
      assert.equal(r.usage.reasoning, 1500);
    });

    test("empty completed output -> empty; refusal -> refusal", async () => {
      const empty = await callModel(args({ fetchImpl: fakeFetch(respond(200, { status: "completed", output: [] })) }));
      assert.equal(empty.error.kind, "empty");
      const refused = await callModel(args({ fetchImpl: fakeFetch(respond(200, { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "No." }] }] })) }));
      assert.equal(refused.error.kind, "refusal");
      assert.equal(refused.error.message, "No.");
    });

    test("partial text from an incomplete response is still returned", async () => {
      const r = await callModel(args({ fetchImpl: fakeFetch(respond(200, okBody("partial", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }))) }));
      assert.equal(r.ok, true);
      assert.equal(r.status, "incomplete");
      assert.equal(r.incompleteReason, "max_output_tokens");
    });
  });

  describe("parseJsonAnswer", () => {
    test("plain JSON, fences, prose around it", () => {
      assert.deepEqual(parseJsonAnswer('{"a":1}'), { a: 1 });
      assert.deepEqual(parseJsonAnswer('  {"a":1}  '), { a: 1 });
      assert.deepEqual(parseJsonAnswer('```json\n{"skip": false, "comment": "x"}\n```'), { skip: false, comment: "x" });
      assert.deepEqual(parseJsonAnswer('```\n{"a":2}\n```'), { a: 2 });
      assert.deepEqual(parseJsonAnswer('Sure! Here it is: {"comment": "nested {braces} ok"} Hope it helps.'), { comment: "nested {braces} ok" });
      assert.deepEqual(parseJsonAnswer("[1,2]"), [1, 2]);
    });
    test("garbage -> null", () => {
      assert.equal(parseJsonAnswer("not json"), null);
      assert.equal(parseJsonAnswer(""), null);
      assert.equal(parseJsonAnswer(null), null);
      assert.equal(parseJsonAnswer("{broken"), null);
      assert.equal(parseJsonAnswer("} backwards {"), null);
    });
  });
});
