// ScoreX - default OpenAI model list, presets and fallback. These are only starting values:
// every model name, reasoning flag and price is editable in Dashboard > Models & Costs, so new models
// can be used without touching code. Prices are USD per 1M tokens (input / cached input / output) as listed
// in late October 2026 - check https://openai.com/api/pricing and update them in the dashboard.
// OpenAI does not charge for cache writes, so cacheWrite equals the normal input price.
//
// `addedIn` = the model-list revision that introduced a model. Existing installs receive the models of a
// newer revision once (lib/store.js sanitizeSettings), without bringing back models you deleted.

export const MODELS_REV = 2;

const m = (id, label, name, maxOutputTokens, input, cachedInput, output, addedIn = 1) => ({
  id, label, name, reasoning: true, maxOutputTokens, prices: { input, cachedInput, output, cacheWrite: input }, addedIn,
});

export const DEFAULT_MODELS = [
  // GPT-6 family (presets use these by default).
  { ...m("m_cheap", "Fast / cheap", "gpt-6-luna", 1500, 0.1, 0.01, 0.5), prices: { input: 0.1, cachedInput: 0.01, output: 0.5, cacheWrite: 0.125 } },
  { ...m("m_balanced", "Balanced", "gpt-6.1-terra", 2500, 1.0, 0.05, 5.0), prices: { input: 1.0, cachedInput: 0.05, output: 5.0, cacheWrite: 1.25 } },
  { ...m("m_best", "High quality", "gpt-6.1-sol", 4000, 2.0, 0.1, 10.0), prices: { input: 2.0, cachedInput: 0.1, output: 10.0, cacheWrite: 2.5 } },
  // GPT-5 family (reasoning models; all support reasoning effort and verbosity).
  m("m_g5_nano", "GPT-5 nano", "gpt-5-nano", 1500, 0.05, 0.005, 0.4, 2),
  m("m_g5_mini", "GPT-5 mini", "gpt-5-mini", 2500, 0.25, 0.025, 2.0, 2),
  m("m_g5", "GPT-5", "gpt-5", 4000, 1.25, 0.125, 10.0, 2),
  m("m_g51", "GPT-5.1", "gpt-5.1", 4000, 1.25, 0.125, 10.0, 2),
  m("m_g52", "GPT-5.2", "gpt-5.2", 4000, 1.75, 0.175, 14.0, 2),
  m("m_g54_nano", "GPT-5.4 nano", "gpt-5.4-nano", 1500, 0.2, 0.02, 1.25, 2),
  m("m_g54_mini", "GPT-5.4 mini", "gpt-5.4-mini", 2500, 0.75, 0.075, 4.5, 2),
  m("m_g54", "GPT-5.4", "gpt-5.4", 4000, 2.5, 0.25, 15.0, 2),
  m("m_g55", "GPT-5.5", "gpt-5.5", 4000, 5.0, 0.5, 30.0, 2),
];

export const DEFAULT_PRESETS = {
  high: { modelId: "m_best", effort: "high" },
  balanced: { modelId: "m_balanced", effort: "medium" },
  cheap: { modelId: "m_cheap", effort: "low" },
};

// Used once when the preset's model errors, times out or hits a rate limit. The last resort is GPT-5 mini,
// a long-available model, so a renamed or unavailable model never stops comment generation entirely.
export const DEFAULT_FALLBACK = { enabled: true, modelId: "m_balanced", effort: "low", secondModelId: "m_g5_mini" };
