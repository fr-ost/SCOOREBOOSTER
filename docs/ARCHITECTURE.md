# ScoreX architecture

Plain JavaScript, Manifest V3, no build step. The loadable extension is the `extension/` folder.

```
extension/
  manifest.json
  background/sw.js        service worker entry: listeners, message router, alarms (ES module)
  lib/                    ES modules shared by the service worker and the dashboard (no chrome.* at import time)
    constants.js          storage keys, statuses, message names, HARD safety caps
    util.js               pure helpers: time zones, random, text, CSV, redaction
    store.js              chrome.storage access, DEFAULT_SETTINGS / DEFAULT_STATE, sanitizeSettings, locks
    models.js             default OpenAI models / presets / fallback (editable in the UI)
    db.js                 IndexedDB adapter (+ in-memory adapter for Node tests)
    history.js            history records = review queue + log of every generated comment
    costs.js              real cost from usage, spend ledger, budget, estimates, totals, performance
    targets.js            target CRUD, import parsing, follow status, tone/preset resolution, profile merge
    scores.js             own ranking ("ScoreX rank"), bot flags, tier suggestion, value x follow-back chance
    sorsa.js              older Sorsa-only refresh (kept for the sorsaTest / sorsaRefresh messages)
    providerdefs.js       data-only definitions of the score sites (TwitterScore, Sorsa, Ethos, Moni)
    providers.js          runs one provider capability (score / smart followers): api, public or page mode,
                          owner overrides limited to the provider's own https hosts, optional permissions
    pagereader.js         "browser tab" mode: reads a rendered provider page in a background tab, then closes it
    scoreboard.js         sx.scoreboard: own scores + history, checks, smart lists, target scores, usage caps,
                          pagedSmartFollowers (TwitterScore API, 25 per page) and the smart follower database scan
    smartdb.js            IndexedDB "smartdb": one row per username (score, date of scan, accounts it was found under)
    xlsx.js               CSV and a minimal XLSX writer (no library) for the downloads
    analytics.js          funnel, heatmap and follow-back attribution for History > Stats
    diagnostics.js        live X self-test (home, profile, followers list; never clicks or types)
    catchup.js            catch-up: each target's latest earlier posts when the queue runs dry
    guard.js              pageVerdict: turns the page report into stop / soft / not-found verdicts
    reach.js              reply reach monitor (median views now vs before, alert + chosen action)
    conversations.js      conversation alerts: authors who answered your replies (mentions page)
    filters.js            post skip rules (ads, link-only, political, giveaway, gm, language, age)
    quality.js            comment sanitising, final touches (humanize), rule checks (bot phrases, openers,
                          links, length) + similarity vs last 50 comments
    openai.js             raw Responses API client, usage extraction, error classification
    voices.js             the UniqueFarm reply voice: system prompt, default voice, voice presets, bot phrases
    generator.js          prompt building (voice + per-reply knobs + greeting rule), plain-text replies,
                          preset/fallback chain, editor check, regeneration
    safety.js             ramp limits, active hours, gaps/breaks, per-target caps, page-load budget, adaptive
                          watch cadence, risk report (pure)
    tabs.js               pinned X worker tab, navigation (+ X page-load ledger by purpose), content-script
                          messaging, logged-in account tracking (state.me, unreadable-account streak)
    watcher.js            new-post detection (X List / batched Latest search / profile rotation)
    poster.js             human-like posting flow (navigate, read, scroll, like, type, submit, verify)
    discovery.js          candidate discovery jobs (followers/following/search/common follows)
    follow.js             follow tracking: followers-list scan + profile checks, give-up removal, blacklist
    learning.js           follow-back credit + engagement tracking, priorities, A/B testing (Thompson sampling)
    cleanup.js            optional unfollow of non-followers after N days (default OFF)
    engine.js             start/pause/stop/resume, the randomized tick, auto-stop, review actions
    notify.js             desktop notifications + badge
    backup.js             export / import JSON (never includes API keys)
  content/                classic scripts injected into x.com, in this order:
    selectors.js          THE single config of DOM selectors + text patterns (user overrides merged)
    dom.js  detect.js  scrape.js  actions.js  content.js (router)
  ui/                     dashboard (options page) + popup
    dashboard.js          shell: left rail with 7 screens (Work / Track / Setup), the Settings tab strip (General,
                          Tone, Models & costs, Safety are separate routes under one rail item), engine bar, routes
                          (#screen?param=..), storage watch + redraw, Full-auto confirm, safety-stop review dialog
    components.js         DOM helpers (h(), no innerHTML with untrusted text), fields, drawer, sheets, tables
    charts.js             inline SVG charts (sparklines, bars, history with event ticks, heatmap)
    tabs/*.js             one module per screen: overview (Today), review, targets, discover (tabs: smartdb_ui.js
                          database | Find targets), scores, history (Comments | Stats | Spend), and the Settings
                          tabs settings (General, with Diagnostics), tones (Tone), models, safety
    css/*.css             per-screen styles on the shared tokens in dashboard.css (light + dark)
```

## Ownership rule (race-free storage)

* `sx.settings`, `sx.secrets`, `sx.selectorOverrides`: written by the dashboard, read by the service worker.
* `sx.providerOverrides`: written by the dashboard (Scores > Advanced), read by the service worker.
* `sx.state`, `sx.targets`, `sx.candidates`, `sx.blacklist`, `sx.discovery`, `sx.logs`, `sx.spend`, `sx.learning`, `sx.seen`,
  `sx.scoreboard`, `sx.conversations` and the IndexedDB history: written **only** by the service worker. The UI reads them (and listens with
  `chrome.storage.onChanged`) and asks the worker for changes with messages.

## Message API (UI -> service worker)

`chrome.runtime.sendMessage({ sx: "<name>", ...payload })` resolves to `{ ok: true, ... }` or
`{ ok: false, error: "<human readable>" }`.

| name | payload | response |
|---|---|---|
| getStatus | - | `{ status }` (see below) |
| start / pause / resume / stop / runNow / clearAlert | - | `{}` |
| targetsUpsert | `{ rows, defaults: {tier, source}, overwrite }` | `{ added, updated, blacklisted }` |
| targetsImport | `{ text, defaults }` (CSV / JSON / plain list) | `{ added, updated, blacklisted, parsed }` |
| targetPatch | `{ handle, patch }` | `{ target }` |
| targetsBulk | `{ handles, patch }` | `{}` |
| targetsRemove | `{ handles }` | `{ removed }` |
| targetRefresh | `{ handles }` | `{ queued }` |
| candidatesAdd | `{ handles, tier }` | `{ added, updated, blacklisted }` |
| blacklistAdd | `{ handles }` (also removes them from the targets) | `{ added, removedTargets }` |
| blacklistRemove | `{ handles }` | `{ removed }` |
| candidatesRemove | `{ handles }` | `{}` |
| candidatesClear | - | `{}` |
| discoveryStart | `{ source, handles, query, maxUsers, enrich }` | `{}` (progress in `sx.discovery`) |
| discoveryCancel | - | `{}` |
| reviewAction | `{ id, action: approve\|skip\|regenerate\|save, text }` | `{ record }` |
| reviewApproveAll / reviewSkipAll | `{ ids }` (the items the user saw) | `{ count }` |
| testOpenAI | `{ modelId, effort }` | `{ text, usage, cost, ms, error }` |
| previewPrompt | `{ handle? }` | `{ instructions, input }` |
| sorsaTest | - | `{ score, remaining }` |
| sorsaRefresh | `{ handles }` | `{ updated }` |
| scoresState | - | `{ providers, board }` |
| scoresRefreshOwn | `{ force, only }` | `{ results }` |
| providerTest | `{ id }` | `{ score, max, url, mode }` |
| scoreCheck | `{ handle }` | `{ handle, results }` (also stored on the target when it is one) |
| smartFollowers | `{ handle, fresh }` | `{ handle, results, merged }` (cached 3 days) |
| smartSweep / targetScores | `{ handles }` / `{ handles, provider }` | `{ started }` (progress in `sx.scoreboard.job`) |
| scoreJobCancel | - | `{}` |
| sampleReply | `{ text, handle \| tier }` | `{ comment, model, effort, cost, tone, preset, quality }` (never posted) |
| selfTest | - | `{ checks, stop }` (also kept in `state.lastSelfTest`) |
| conversationDone | `{ id, done }` | `{}` |
| reachDismiss | - | `{}` |
| learningRun | - | `{}` |
| learningSummary | - | `{ arms, suggestions }` |
| abReset | - | `{}` |
| cleanupPreview | - | `{ candidates }` |
| exportData | `{ parts }` | `{ data }` |
| importData | `{ data, parts }` | `{ imported }` |
| historyClear | - | `{}` |
| resetAll | - | `{}` |

`status` = `{ state, effectiveMode, today: { posted, limit, generated, generationLimit, liked, likeLimit,
skipped, failed, cost }, month: { cost, budget, pct, reached, warn }, pendingReview, queued,
activeHours: { inside, opensAt, closesAt }, rampStage, daysSinceStart, hasApiKey, targetCount,
activeTargetCount, follow: { checking, active, follows, followedBack, off, blacklisted }, label,
risk: { level, score, factors, hoursToLimit }, footprint: { total, cap, byPurpose, hourly }, watch: { slow,
intervalSec, emptyStreak }, reach: { ..., alert } }`.

## Follow status

`followStatus(target)` (lib/targets.js) from `target.rel.followsYou`: `checking` (null, not checked yet),
`active` (false: the only status that is watched and commented on), `follows` (true without a follow-back) and
`followed_back` (true with `rel.followedBackAt`). `target.group` mirrors it (A = follows you, B = not) and is
not editable. The 14-day give-up window starts at `target.stats.firstCommentAt`.

## Content commands (service worker -> x.com tab)

`chrome.tabs.sendMessage(tabId, { sx: "<cmd>", ...args })` -> `{ ok, ..., page: { state, detail, me, hidden } }`.
Commands: ping, pageState, waitFor, scrapeTweets, scrapeProfile, scrapeUsers, scrapeStatus, scroll, like,
openComposer, type, composerText, clearComposer, closeComposer, submitReply, replyResult, followState,
unfollow, replyStats. Long timing (typing speed, reading pauses, scrolling) is driven by the service worker,
because background tabs throttle page timers.

## History record (IndexedDB `scorex/history`)

See the header of `lib/history.js`. One record per generated comment. Records with status
`pending_review | approved | queued | posting` form the open queue; `posted | skipped | failed` are final.

## Consistency rules

* History status changes are compare-and-set inside one IndexedDB transaction (`history.patch(id, fn)`):
  an item is only claimed for posting if it is still APPROVED/QUEUED, and review actions never overwrite an
  item that started posting.
* Safety limits count posted (and "probably posted") records in rolling 24 h / 7 day windows.
* The job lease lasts 3 minutes and is renewed every minute while its holder runs; a new worker instance
  drops any lease left by a killed one.
* Pause/Stop are re-checked inside the posting flow up to the moment of submit.

## Engine tick

One randomized one-shot alarm (`sx.tick`) plus a 1-minute watchdog alarm. Each tick, in order:
safety gates -> expire stale queue items (and drop items for accounts that follow you now or were removed)
-> post one due item (approved/queued) -> otherwise watch for new posts and generate for the best fresh one
-> otherwise background work (queued profile refreshes and follow tracking take turns; then conversation alerts,
engagement + reach checks, cleanup) -> schedule the next tick at a random interval inside active hours
(stretched by adaptive watching after empty checks). Every X page load goes through `tabs.navigate`, which
counts it by purpose and refuses it softly at the optional 24 h budget. A separate 4-hourly alarm refreshes
your own scores and tidies the history (retention). A job lease in `sx.state.job`
prevents two ticks from running at once, also across service-worker restarts.
