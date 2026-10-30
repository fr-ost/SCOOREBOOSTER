import "./_chrome.mjs";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sanitizeSettings } from "../../extension/lib/store.js";
import { DEFAULT_MODELS, MODELS_REV } from "../../extension/lib/models.js";

describe("model list", () => {
  test("defaults include the GPT-6 and GPT-5 families with prices", () => {
    const names = DEFAULT_MODELS.map((m) => m.name);
    for (const n of ["gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-5-nano", "gpt-5-mini", "gpt-5", "gpt-5.1", "gpt-5.2", "gpt-5.4-nano", "gpt-5.4-mini", "gpt-5.4", "gpt-5.5"]) assert.ok(names.includes(n), n);
    for (const m of DEFAULT_MODELS) assert.ok(m.prices.input > 0 && m.prices.output > m.prices.input && m.prices.cachedInput < m.prices.input, m.name);
    assert.equal(new Set(DEFAULT_MODELS.map((m) => m.id)).size, DEFAULT_MODELS.length, "unique ids");
  });
  test("fresh settings: every model, GPT-5 mini as the last-resort fallback", () => {
    const s = sanitizeSettings({});
    assert.equal(s.models.length, DEFAULT_MODELS.length);
    assert.equal(s.modelsRev, MODELS_REV);
    assert.equal(s.fallback.secondModelId, "m_g5_mini");
  });
  test("older installs receive the new models once; custom and deleted models are respected", () => {
    const old = sanitizeSettings({ models: [{ id: "m_cheap", name: "gpt-6-luna" }, { id: "mine", name: "gpt-4.1-mini", reasoning: false }, { id: "x5", name: "gpt-5" }], fallback: { enabled: true, modelId: "m_cheap", effort: "low", secondModelId: "m_cheap" } });
    const names = old.models.map((m) => m.name);
    assert.ok(names.includes("gpt-5-mini") && names.includes("gpt-5.5") && names.includes("gpt-4.1-mini"));
    assert.equal(names.filter((n) => n === "gpt-5").length, 1, "a model you already had is not added twice");
    assert.ok(!names.includes("gpt-6.1-sol"), "models of the old revision you deleted are not brought back");
    assert.equal(old.fallback.secondModelId, "m_g5_mini");
    const again = sanitizeSettings(old);
    assert.equal(again.models.length, old.models.length, "idempotent");
    const deleted = sanitizeSettings({ modelsRev: MODELS_REV, models: [{ id: "m_best", name: "gpt-6.1-sol" }] });
    assert.equal(deleted.models.length, 1, "after the upgrade, deleting GPT-5 models sticks");
  });
});
