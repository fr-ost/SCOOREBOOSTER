// Regression tests for behaviour tightened after the first review round.
import "./_chrome.mjs";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyError, extractText } from "../../extension/lib/openai.js";
import { ruleCheck } from "../../extension/lib/quality.js";
import { skipReason } from "../../extension/lib/filters.js";
import { sanitizeSettings } from "../../extension/lib/store.js";
import { sanitizePatch } from "../../extension/lib/targets.js";
import { countEmoji } from "../../extension/lib/util.js";

const settings = sanitizeSettings({});
const post = (text, extra = {}) => ({ id: "1", author: "a", text, lang: "en", createdAt: Date.now() - 5 * 60000, ...extra });

describe("follow-up fixes", () => {
  test("429 without a code is a retryable rate limit, explicit quota codes stop", () => {
    assert.equal(classifyError(429, "<html>Too Many Requests</html>", {}).kind, "rate");
    assert.equal(classifyError(429, { error: { code: "rate_limit_exceeded", message: "x" } }, {}).kind, "rate");
    assert.equal(classifyError(429, { error: { code: "insufficient_quota", type: "insufficient_quota", message: "quota" } }, {}).kind, "quota");
    assert.equal(classifyError(429, { error: { code: "credit_balance_exhausted", message: "no credits" } }, {}).kind, "quota");
  });

  test("talking about OpenAI / ChatGPT is fine, self-references are not", () => {
    assert.equal(ruleCheck("ChatGPT shipping memory to everyone changes onboarding expectations for every app.", { settings }).pass, true);
    assert.equal(ruleCheck("OpenAI pricing drops make agent startups viable at seed stage now.", { settings }).pass, true);
    assert.equal(ruleCheck("As an AI, I think distribution matters more than features here.", { settings }).reasons[0].code, "ai_mention");
  });

  test("short X/link domains are links", () => {
    assert.ok(ruleCheck("Read my take on x.com later today before the launch.", { settings }).reasons.some((r) => r.code === "link"));
    assert.ok(ruleCheck("Details here t.co for the curious founders reading this.", { settings }).reasons.some((r) => r.code === "link"));
  });

  test("flags and keycaps count as emoji", () => {
    assert.equal(countEmoji("Go 🇧🇩"), 1);
    assert.equal(countEmoji("🇧🇩🇺🇸"), 2);
    assert.equal(countEmoji("Step 1️⃣ then"), 1);
  });

  test("filters no longer reject everyday phrases", () => {
    assert.equal(skipReason(post("Good time to enter a position when funding rates reset to neutral levels."), settings), null);
    assert.equal(skipReason(post("This protocol update killed fees for small transfers, which is huge for remittances."), settings), null);
    assert.equal(skipReason(post("Enter to win a free year of our pro plan, retweet and follow!"), settings).code, "giveaway");
    assert.equal(skipReason(post("RIP to a legend of the open source world, his work shaped all of us."), settings).code, "sensitive");
  });

  test("sanitizePatch accepts lowercase group", () => {
    assert.equal(sanitizePatch({ group: "a" }).group, "A");
    assert.equal(sanitizePatch({ group: "b" }).group, "B");
    assert.equal(sanitizePatch({ priority: 70 }).priorityManual, true);
  });

  test("extractText ignores null content parts", () => {
    assert.equal(extractText({ output: [{ type: "message", content: [null, { type: "output_text", text: "hi" }] }] }).text, "hi");
  });
});
