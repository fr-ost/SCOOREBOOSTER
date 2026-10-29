// ScoreX - default OpenAI model list, presets and fallback. These are only starting values:
// every model name, reasoning flag and price is editable in Dashboard > Models & Costs, so new models
// can be used without touching code. Prices are USD per 1M tokens as listed on OpenAI's pricing page
// in late October 2026 - check https://openai.com/api/pricing and update them in the dashboard.

export const DEFAULT_MODELS = [
  {
    id: "m_cheap",
    label: "Fast / cheap",
    name: "gpt-6-luna",
    reasoning: true, // sends reasoning.effort; turn off for non-reasoning models (e.g. gpt-4.1 family)
    maxOutputTokens: 1500, // includes reasoning tokens
    prices: { input: 0.1, cachedInput: 0.01, output: 0.5, cacheWrite: 0.125 },
  },
  {
    id: "m_balanced",
    label: "Balanced",
    name: "gpt-6.1-terra",
    reasoning: true,
    maxOutputTokens: 2500,
    prices: { input: 1.0, cachedInput: 0.05, output: 5.0, cacheWrite: 1.25 },
  },
  {
    id: "m_best",
    label: "High quality",
    name: "gpt-6.1-sol",
    reasoning: true,
    maxOutputTokens: 4000,
    prices: { input: 2.0, cachedInput: 0.1, output: 10.0, cacheWrite: 2.5 },
  },
];

export const DEFAULT_PRESETS = {
  high: { modelId: "m_best", effort: "high" },
  balanced: { modelId: "m_balanced", effort: "medium" },
  cheap: { modelId: "m_cheap", effort: "low" },
};

// Used once when the preset's model errors, times out or hits a rate limit.
export const DEFAULT_FALLBACK = { enabled: true, modelId: "m_balanced", effort: "low", secondModelId: "m_cheap" };
