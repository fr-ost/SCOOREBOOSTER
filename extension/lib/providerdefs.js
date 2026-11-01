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
//     for free; logged in with a PRO plan your own browser tab shows more rows, so the tab reader takes up to 50).
//     ScoreX asks it at most 100 times a day by default. API v1 (paid key): get_twitter_score?username= -> { twitter_score },
//     top_followers_paginate?username=&page=&size= -> { top_followers: [{ username, name, twitter_score, followers_count }] }.
//   Ethos: free public API v2, GET /api/v2/user/by/x/<handle> -> { score (0-2800 credibility), profileId (null = no
//     Ethos profile), username, displayName }. No follower data. Header X-Ethos-Client identifies the app.
//   Moni: Social API v3 with your (free) key, header "Api-Key": accounts/<handle>/info/smart_engagement/ ->
//     { smartEngagement: { moniScore, smartsCount } }, accounts/<handle>/smarts/meta/?orderBy=SCORE ->
//     { items: [{ meta: { userUrl } }] }. A free Moni account gets about 300 requests a month.

// Field names of a smart follower row in TwitterScore's API answers (both endpoints; the first one present is used).
const TS_FIELDS = {
  handle: ["username", "screen_name", "twitter_username", "twitter_screen_name", "user.username", "user.screen_name", "handle"],
  name: ["name", "display_name", "user.name"],
  score: ["twitter_score", "score", "twitterScore", "user.twitter_score"],
  followers: ["followers_count", "followers", "followersCount", "user.followers_count"],
};

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
    dailyCap: 100, // be polite to the site: the public page and the browser-tab mode are read like a person would
    listLimit: 100, // API pages hold up to 100 smart followers
    // Your own score never spends API requests: the free public page, then a browser tab when the site's bot check
    // blocks the direct read. The paid API is used only for smart followers (the smart-follower database).
    ownModes: ["public", "page"],
    smartMode: "api",
    // API requests are paid for in your TwitterScore plan, so ScoreX's daily cap does not hold them back (they are still
    // counted and paced at 50 a minute, under the plan's 60). The cap keeps limiting reads of the public page.
    apiUncapped: true,
    notFound: "(?:page|account|user) (?:was )?not found|doesn't exist|no data for this account",
    modes: {
      public: {
        hosts: ["https://twitterscore.io/*"],
        score: { kind: "html", url: "https://twitterscore.io/twitter/{handle}/", value: { regex: "Twitter Score(?: of| is)?\\s*:?\\s*(\\d+(?:\\.\\d+)?)" } },
        smartFollowers: {
          kind: "tab", url: "https://twitterscore.io/twitter/{handle}/",
          list: { selector: "a[href*='/twitter/']", containerText: "smart followers", fields: { handle: { attr: "href", regex: "/twitter/([A-Za-z0-9_]{1,15})(?:[/?#]|$)" }, score: { regex: "(\\d{1,4}(?:\\.\\d+)?)\\s*(?:/\\s*1000)?\\s*$" } }, limit: 50 },
        },
      },
      page: {
        hosts: ["https://twitterscore.io/*"],
        score: { kind: "tab", url: "https://twitterscore.io/twitter/{handle}/", value: { regex: "Twitter Score(?: of| is)?\\s*:?\\s*(\\d+(?:\\.\\d+)?)" } },
        smartFollowers: {
          kind: "tab", url: "https://twitterscore.io/twitter/{handle}/",
          list: { selector: "a[href*='/twitter/']", containerText: "smart followers", fields: { handle: { attr: "href", regex: "/twitter/([A-Za-z0-9_]{1,15})(?:[/?#]|$)" }, score: { regex: "(\\d{1,4}(?:\\.\\d+)?)\\s*(?:/\\s*1000)?\\s*$" } }, limit: 50 },
        },
      },
      api: {
        hosts: ["https://twitterscore.io/*"],
        score: { kind: "json", url: "https://twitterscore.io/api/v1/get_twitter_score?username={handle}&api_key={key}", headers: { "X-API-Key": "{key}" }, value: { path: ["twitter_score", "data.twitter_score", "score"] } },
        // Paged: {page} is 1-based, {size} is at most 25 (TwitterScore's documented cap; an empty page follows the last).
        // lib/scoreboard.js pagedSmartFollowers walks every page (the smart follower database) or the first few (Find
        // targets). TwitterScore marks top_followers_paginate deprecated; get_followers below replaces it when it stops
        // answering. auto: an answer whose list sits under another key is still found.
        smartFollowers: {
          kind: "json", url: "https://twitterscore.io/api/v1/top_followers_paginate?username={handle}&page={page}&size={size}&api_key={key}", headers: { "X-API-Key": "{key}" },
          pageSize: 25,
          list: { path: ["top_followers", "data.top_followers", "followers", "data.followers", "data.items", "items", "data", "results"], auto: true, fields: TS_FIELDS, limit: 100 },
          total: { path: ["total", "data.total", "total_count", "totalCount", "meta.total", "pagination.total"] }, // never "count" (often this page's)
        },
        smartFollowersAlt: {
          kind: "json", url: "https://twitterscore.io/api/v1/get_followers?username={handle}&page={page}&size={size}&api_key={key}", headers: { "X-API-Key": "{key}" },
          pageSize: 25,
          list: { path: ["followers", "data.followers", "top_followers", "data.top_followers", "data.items", "items", "data", "results"], auto: true, fields: TS_FIELDS, limit: 100 },
          total: { path: ["total", "data.total", "total_count", "totalCount", "meta.total", "pagination.total"] }, // never "count" (often this page's)
        },
      },
    },
  },

  ethos: {
    id: "ethos",
    ownOnly: true, // only your own score (once a day): never asked about other accounts or smart followers
    name: "Ethos",
    site: "https://ethos.network",
    about: "Free credibility score (0-2800) from reviews and vouches on Ethos. No follower data.",
    profileUrl: "https://app.ethos.network/profile/x/{handle}",
    max: 2800,
    dailyCap: 500,
    modes: {
      public: {
        hosts: ["https://api.ethos.network/*"],
        score: { kind: "json", url: "https://api.ethos.network/api/v2/user/by/x/{handle}", headers: { "X-Ethos-Client": "scorex@1.2" }, value: { path: ["score", "user.score"] }, requirePath: ["profileId", "user.profileId"] },
      },
    },
  },

  moni: {
    id: "moni",
    ownOnly: true, // only your own score (once a day): never asked about other accounts or smart followers
    name: "Moni",
    site: "https://moni.ai",
    about: "Moni Score and the account's 'smarts' (smart followers) from Moni Discover.",
    profileUrl: "https://discover.getmoni.io/{handle}",
    max: null,
    keyName: "moniKey",
    keyHelp: "https://moni.ai/api",
    keyNote: "A free Moni account's API key includes about 300 requests a month.",
    dailyCap: 20,
    modes: {
      api: {
        hosts: ["https://api.discover.getmoni.io/*"],
        score: { kind: "json", url: "https://api.discover.getmoni.io/api/v3/accounts/{handle}/info/smart_engagement/", headers: { "Api-Key": "{key}" }, value: { path: ["smartEngagement.moniScore", "moniScore"] } },
        smartFollowers: {
          kind: "json", url: "https://api.discover.getmoni.io/api/v3/accounts/{handle}/smarts/meta/?limit=20&offset=0&orderBy=SCORE&orderByDirection=DESC", headers: { "Api-Key": "{key}" },
          list: { path: ["items"], fields: { handle: ["meta.userUrl", "meta.username", "userUrl"], name: ["meta.name"], score: ["smartEngagement.moniScore"] }, limit: 20 },
          total: { path: ["totalCount"] },
        },
      },
    },
  },
};
