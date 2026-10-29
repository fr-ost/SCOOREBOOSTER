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
    targets.js            target CRUD, import parsing, tone/preset resolution, profile merge
    scores.js             own ranking ("ScoreX rank"), bot flags, tier suggestion, Sorsa mapping
    sorsa.js              optional Sorsa Score provider (user key + optional host permission)
    filters.js            post skip rules (ads, link-only, political, giveaway, gm, language, age)
    quality.js            comment sanitising + rule checks + similarity vs last 50 comments
    openai.js             raw Responses API client, usage extraction, error classification
    generator.js          prompt building, preset/fallback chain, quality check, regeneration
    safety.js             ramp limits, warm-up, active hours, gaps/breaks, per-target caps (pure)
    tabs.js               pinned X worker tab, navigation, content-script messaging
    watcher.js            new-post detection (X List / batched Latest search / profile rotation)
    poster.js             human-like posting flow (navigate, read, scroll, like, type, submit, verify)
    discovery.js          candidate discovery jobs (followers/following/search/common follows)
    learning.js           follow-back + engagement tracking, priorities, A/B testing (Thompson sampling)
    cleanup.js            optional unfollow of non-followers after N days (default OFF)
    engine.js             start/pause/stop/resume, the randomized tick, auto-stop, review actions
    notify.js             desktop notifications + badge
    backup.js             export / import JSON (never includes API keys)
  content/                classic scripts injected into x.com, in this order:
    selectors.js          THE single config of DOM selectors + text patterns (user overrides merged)
    dom.js  detect.js  scrape.js  actions.js  content.js (router)
  ui/                     dashboard (options page) + popup
```

## Ownership rule (race-free storage)

* `sx.settings`, `sx.secrets`, `sx.selectorOverrides`: written by the dashboard, read by the service worker.
* `sx.state`, `sx.targets`, `sx.candidates`, `sx.discovery`, `sx.logs`, `sx.spend`, `sx.learning`, `sx.seen`
  and the IndexedDB history: written **only** by the service worker. The UI reads them (and listens with
  `chrome.storage.onChanged`) and asks the worker for changes with messages.

## Message API (UI -> service worker)

`chrome.runtime.sendMessage({ sx: "<name>", ...payload })` resolves to `{ ok: true, ... }` or
`{ ok: false, error: "<human readable>" }`.

| name | payload | response |
|---|---|---|
| getStatus | - | `{ status }` (see below) |
| start / pause / resume / stop / runNow / clearAlert | - | `{}` |
| targetsUpsert | `{ rows, defaults: {group, tier, source}, overwrite }` | `{ added, updated }` |
| targetsImport | `{ text, defaults }` (CSV / JSON / plain list) | `{ added, updated, parsed }` |
| targetPatch | `{ handle, patch }` | `{ target }` |
| targetsBulk | `{ handles, patch }` | `{}` |
| targetsRemove | `{ handles }` | `{ removed }` |
| targetRefresh | `{ handles }` | `{ queued }` |
| candidatesAdd | `{ handles, group, tier }` | `{ added }` |
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
| learningRun | - | `{}` |
| learningSummary | - | `{ arms, suggestions }` |
| abReset | - | `{}` |
| cleanupPreview | - | `{ candidates }` |
| exportData | `{ parts }` | `{ data }` |
| importData | `{ data, parts }` | `{ imported }` |
| historyClear | - | `{}` |
| resetAll | - | `{}` |

`status` = `{ state, effectiveMode, warmup, today: { posted, limit, postedGroup, groupLimits, generated,
generationLimit, liked, likeLimit, skipped, failed, cost }, month: { cost, budget, pct, reached, warn },
pendingReview, queued, activeHours: { inside, opensAt, closesAt }, rampStage, daysSinceStart, hasApiKey,
targetCount, activeTargetCount, label }`.

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
safety gates -> expire stale queue items -> post one due item (approved/queued) -> otherwise watch for new
posts and generate for the best fresh one -> otherwise background work (profile refresh, learning checks,
cleanup) -> schedule the next tick at a random interval inside active hours. A job lease in `sx.state.job`
prevents two ticks from running at once, also across service-worker restarts.
