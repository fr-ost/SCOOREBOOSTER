// ScoreX - built-in score provider definitions (data only; see lib/providers.js for how they run).
// URL templates use {handle} (lowercase X handle, no @) and {key} (your key for that site).
// Value specs: { path } for JSON field paths (alternatives allowed), { regex } over page text,
// { selector, attr?, regex? } for rendered pages. List specs: { path | selector, fields, limit }.

export const PROVIDER_DEFS = {
  sorsa: {
    id: "sorsa",
    name: "Sorsa",
    site: "https://sorsa.io",
    about: "Influence score based on who follows an account. Follow-backs from high-score accounts raise yours.",
    profileUrl: "https://app.sorsa.io/?q={handle}",
    max: null,
    keyName: "sorsaKey",
    keyHelp: "https://api.sorsa.io",
    modes: {
      api: {
        hosts: ["https://api.sorsa.io/*"],
        score: { kind: "json", url: "https://api.sorsa.io/v3/score?username={handle}", headers: { ApiKey: "{key}" }, value: { path: ["score", "data.score"] } },
      },
    },
  },
};
