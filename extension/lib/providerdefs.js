// ScoreX - built-in score provider definitions (data only; see lib/providers.js for how they run).
// URL templates use {handle} (lowercase X handle, no @) and {key} (your key for that site).
// Value specs: { path } for JSON field paths (alternatives allowed), { regex } over page text,
// { selector, attr?, regex? } for rendered pages. List specs: { path | selector, fields, limit, containerText }.
//
// Sources (researched October 2026; the sites block this project's build environment, so the endpoints and
// page fields could not be tried live - every provider reports a clear error instead of breaking anything,
// and Settings > Scores > Provider overrides can patch any field):
//   Sorsa (formerly TweetScout): REST API v3, header "ApiKey", GET /v3/score?username= -> { score },
//     GET /v3/top-followers?username= -> { users: [{ username, display_name, score, followers_count }] } (20).
//     New keys include 100 free requests. The web app needs a login and shows no follower names for free.
//   TwitterScore: public profile https://twitterscore.io/twitter/<handle>/ (title "... Twitter Score 385/1000",
//     score in the server-rendered HTML; the smart-followers panel is filled by JavaScript and shows the first 3
//     for free). API v1 (paid key): get_twitter_score?username= -> { twitter_score },
//     top_followers_paginate?username=&page=&size= -> { top_followers: [{ username, name, twitter_score, followers_count }] }.

export const PROVIDER_DEFS = {
  sorsa: {
    id: "sorsa",
    name: "Sorsa",
    alias: "formerly TweetScout",
    site: "https://sorsa.io",
    about: "Crypto influence score from who follows an account (100 Noted, 500 Credible, 1000 Significant, 2000 Supreme). Follow-backs from high-score accounts raise yours.",
    profileUrl: "https://app.sorsa.io/profile/{handle}",
    max: null,
    tiers: [[2000, "Supreme"], [1000, "Significant"], [500, "Credible"], [100, "Noted"], [0, "Unknown"]],
    keyName: "sorsaKey",
    keyHelp: "https://api.sorsa.io",
    keyNote: "New Sorsa API keys include 100 free requests (one request = one score or one list of 20 smart followers).",
    dailyCap: 100,
    modes: {
      api: {
        hosts: ["https://api.sorsa.io/*"],
        score: { kind: "json", url: "https://api.sorsa.io/v3/score?username={handle}", headers: { ApiKey: "{key}" }, value: { path: ["score", "data.score"] } },
        smartFollowers: {
          kind: "json", url: "https://api.sorsa.io/v3/top-followers?username={handle}", headers: { ApiKey: "{key}" },
          list: { path: ["users", "data.users", "data"], fields: { handle: ["username", "screen_name", "screeName"], name: ["display_name", "name"], score: ["score"], followers: ["followers_count", "followersCount"] }, limit: 20 },
        },
      },
    },
  },

  twitterscore: {
    id: "twitterscore",
    name: "TwitterScore",
    site: "https://twitterscore.io",
    about: "0-1000 score of how many quality crypto accounts (VCs, founders, influencers) follow an account.",
    profileUrl: "https://twitterscore.io/twitter/{handle}/",
    max: 1000,
    keyName: "twitterscoreKey",
    keyHelp: "https://twitterscore.io/api/prices",
    keyNote: "Optional: without a key ScoreX reads the free public profile page (score + the first 3 smart followers).",
    dailyCap: 300,
    notFound: "(?:page|account|user) (?:was )?not found|doesn't exist|no data for this account",
    modes: {
      public: {
        hosts: ["https://twitterscore.io/*"],
        score: { kind: "html", url: "https://twitterscore.io/twitter/{handle}/", value: { regex: "Twitter Score(?: of| is)?\\s*:?\\s*(\\d+(?:\\.\\d+)?)" } },
        smartFollowers: {
          kind: "tab", url: "https://twitterscore.io/twitter/{handle}/",
          list: { selector: "a[href*='/twitter/']", containerText: "smart followers", fields: { handle: { attr: "href", regex: "/twitter/([A-Za-z0-9_]{1,15})(?:[/?#]|$)" }, score: { regex: "(\\d{1,4}(?:\\.\\d+)?)\\s*(?:/\\s*1000)?\\s*$" } }, limit: 6 },
        },
      },
      page: {
        hosts: ["https://twitterscore.io/*"],
        score: { kind: "tab", url: "https://twitterscore.io/twitter/{handle}/", value: { regex: "Twitter Score(?: of| is)?\\s*:?\\s*(\\d+(?:\\.\\d+)?)" } },
        smartFollowers: {
          kind: "tab", url: "https://twitterscore.io/twitter/{handle}/",
          list: { selector: "a[href*='/twitter/']", containerText: "smart followers", fields: { handle: { attr: "href", regex: "/twitter/([A-Za-z0-9_]{1,15})(?:[/?#]|$)" }, score: { regex: "(\\d{1,4}(?:\\.\\d+)?)\\s*(?:/\\s*1000)?\\s*$" } }, limit: 6 },
        },
      },
      api: {
        hosts: ["https://twitterscore.io/*"],
        score: { kind: "json", url: "https://twitterscore.io/api/v1/get_twitter_score?username={handle}&api_key={key}", headers: { "X-API-Key": "{key}" }, value: { path: ["twitter_score", "data.twitter_score", "score"] } },
        smartFollowers: {
          kind: "json", url: "https://twitterscore.io/api/v1/top_followers_paginate?username={handle}&page=1&size=20&api_key={key}", headers: { "X-API-Key": "{key}" },
          list: { path: ["top_followers", "data.top_followers", "followers", "data"], fields: { handle: ["username", "screen_name"], name: ["name"], score: ["twitter_score", "score"], followers: ["followers_count"] }, limit: 20 },
        },
      },
    },
  },
};
