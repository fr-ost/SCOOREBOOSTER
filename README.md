# ScoreX

A Chrome extension (Manifest V3) that writes short, thoughtful replies to posts on X with OpenAI and
posts them **from your own logged-in browser tab**, with a review queue, real cost tracking and strict
safety limits for a main account. It does **not** use the X API: it works through the x.com page like
you would (content scripts in a pinned X tab).

> **Read this first: no guarantees.**
> * X's rules restrict automated replies. Every safety feature below lowers the risk, but none of them makes
>   automation undetectable or risk-free. Review mode (the default) is the safest way to use ScoreX.
> * The default volume is high (up to 200 replies a day, each with a like, around the clock). That is your
>   choice as the account owner; a lower daily limit, a weekly ramp and active hours (Safety screen) lower the
>   risk of X limiting the account. ScoreX stops at the first warning, captcha or rate-limit message.
> * Nothing here can guarantee more follow-backs or a higher Kaito / Sorsa score. Good replies help, but
>   results depend on your content and on the accounts you reply to.
> * X changes its page markup from time to time. When that happens ScoreX stops itself ("X page changed")
>   and the selectors need an update (one file, see below).

---

## 1. Install (load unpacked)

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the **`extension`** folder of this repository (the folder that contains
   `manifest.json`), not the repository root.
5. Pin the ScoreX icon. The dashboard opens automatically the first time. Later, open it with right-click on
   the icon > **Options**, or the **Open dashboard** button in the popup.
6. Make sure you are logged in to x.com as **@0x_nation** in this Chrome profile.

After editing any file, press the reload button on the ScoreX card in `chrome://extensions`.

## 2. First-time setup (5 minutes)

1. **Models & costs > OpenAI API key**: paste your key and press **Save**, then **Test**. The key is stored only
   inside the extension (its own IndexedDB, which pages on x.com cannot read), is shown masked, and is never
   logged or exported.
2. **Settings > Account**: your handle is preset to `0x_nation`. ScoreX stops if a different account is logged in.
3. **Settings > Watching for new posts**: choose how new posts are found:
   * **X List (recommended)**: create a *private* X List with all your targets and paste its URL. One page view
     then shows every target's newest posts, which is the lightest and fastest way to watch many accounts.
   * **Batched Latest search** (default, no setup): `(from:a OR from:b ...) -filter:replies`, 12 accounts per search.
   * **Profile rotation**: visits a few profiles per check. Fine for a handful of targets only.
4. **Targets > Add targets**: paste handles or profile links (or import CSV / JSON / TXT) and choose the **Tier**
   (**Tier 1**: big influencers, **Tier 2**: smart accounts). You don't have to sort out who follows you:
   ScoreX checks every account first and **only comments on accounts that don't follow you** (see
   [Follow tracking](#follow-tracking)). Or use **Discover**: the smart followers of big accounts (from the score
   sites you connect), followers / following of a big account, people search, or accounts that several smart
   accounts follow. Candidates are ranked and bot-filtered; you pick which to add.
5. **Tone > Tone prompt**: describe in your own words how your replies should sound (voice, attitude, wording,
   length, casing). It is sent with every comment. A sensible default is filled in. **Try it** writes a sample
   reply for any post text you paste (one real generation, never posted).
6. **Models & costs > Monthly budget**: set a limit (for example $10). ScoreX stops when it is reached.
7. Press **Start** (engine bar or popup). It starts in **Review mode**; switch to **Full auto** on Today whenever
   you want (ScoreX asks you to confirm). The **Today** screen shows the setup steps that are still open.

## 3. How it works

```
 every 2.5-6 min (random; around the clock unless you turn on active hours)
   watch page (X List / Latest search / profiles) in the pinned X tab
     -> new original post by a target, 2-20 min old?
     -> skip rules (ads, link-only, political/controversial, giveaways, "gm", language...)
     -> only targets that don't follow you (new targets are checked first)
     -> limits (200 per 24 h, 2 per account per day, 100 accounts per day, budget)
     -> OpenAI: post + bio + 2-3 recent posts + your Tone prompt -> reply (JSON)
     -> rule check + quality model check (generic? off-topic? repeated vs your last 50?) -> regenerate once or skip
   Review mode: reply waits in Review (edit / approve / regenerate / skip)
   Full auto:   reply is queued with a human delay
     -> open the post, "read" it, scroll, optional like, type at a human speed, verify, submit, confirm
     -> random 2-6 min gap (and longer breaks) before the next comment
 catch-up: when the queue is nearly empty, each account's latest 2 earlier posts (up to 48 h old) get
 comments too, so posts from before ScoreX ran are not missed
 background when idle: follow checks (your followers list + profiles), follow-backs, removal after
 14 days without a follow-back, replies from authors (your mentions), engagement and reach checks,
 optional cleanup
```

## 4. Dashboard guide

The dashboard has a left rail in three groups (**Work**, **Growth**, **Setup**) and an engine bar at the top
with the status, Start / Pause / Stop and the Review / Full auto switch. Details open in a drawer on the right,
so the list stays where it was. Light and dark themes (Settings); narrow windows get a compact rail.

| Screen | What you do there |
|---|---|
| **Today** | Engine state and **Run a check now**, the day's rhythm and counters vs limits, the setup steps until ScoreX is ready, this week's figures (comments, follow-backs, cost, your main score), replies waiting for review (expiring first), **Needs you** (reach alert, authors who answered your replies, page-load budget near its cap, targets close to their give-up day, new candidates, budget, health) and the activity log in plain words. After a safety stop a banner offers **Review stop...**: you confirm that you checked your account before ScoreX resumes. |
| **Review** | Keyboard-first queue: **J/K** move, **A** approve, **E** edit, **S** skip, **R** regenerate, **O** open the post, **Z** undo (5 s), **?** lists the keys. Sort by expiring first, newest or priority. Approve is disabled for accounts that follow you now. **Approve all** asks whether to keep your unsaved edits. Approved replies show when they will post, with Cancel. |
| **Targets** | Status chips with counts (Commenting, Checking, Followed back, Follow you, Off, Not found), search (**/**), tier and **High value** filters, a Columns menu, and bulk actions (tier, tone, preset, on/off, re-check, fetch scores, blacklist, remove). Click a row (or press Enter) for the target drawer: profile, scores, value and follow-back chance with the reason, the timeline (every comment and its results, follow checks, the planned give-up day) and per-account settings. **Add targets** and **Edit rules** (follow rules, check frequency, value ranking) open as sheets; the blacklist is a sub-view. |
| **Discover** | Find new targets: smart followers of big accounts (score sites), followers or following of an account, common follows, people search. Shows the big accounts already swept and a candidates table with per-site scores, overlap ("listed by 3 of 5"), filter verdicts and **Add N as Tier X**. |
| **Scores** | Your score on each connected site (tier, 7- and 30-day change, history chart with follow-back ticks), **Follow-backs that count**, **Check any account**, score coverage of your targets with a refresh job (progress and Cancel), and the providers setup (on/off, mode, key, daily cap, usage, Test, overrides). |
| **Results** | **Overview** (funnel, activity, which tones, models and tiers bring follow-backs), **Comments** (every attempt with filters, a drawer with model, tokens, cost and quality notes, CSV export, history retention) and **Spend** (budget, daily cost, totals and performance per model). Ranges 7 d / 30 d / All. |
| **Tone** | Your Tone prompt, **Try it**, **Learn from my edits** with this week's edit rate, extra rules, built-in and custom tones, A/B tests and suggestions. |
| **Models & costs** | API key, model list with **editable model names** and the **price table** (per 1M tokens: input, cached input, cache write, output), presets High quality / Balanced / Cheap with reasoning effort, fallback models, preset per tier, quality checker, cost estimator, budget. |
| **Safety** | Risk report, reach alert, **Safety profile** (Careful / Standard / Max / Custom), daily limits and ramp, gaps and breaks, active hours (off by default), like before replying, typing speed, skip rules, **X page loads** in the last 24 hours (with an optional cap), the **reply reach monitor**, adaptive watching and the list of auto-stop reasons. |
| **Settings** | **Diagnostics** first (quick check, live X test, copy a redacted report), then account, watching, comment window, review expiry, learning and conversation alerts, cleanup, worker tab, selector overrides, theme, backup export / import, reset. |

The **popup** shows the status, the main action and the next reply to review (approve or skip it there). On an
X profile page it adds a **This profile** card: target status, scores from your connected sites, **Check
scores**, **Add as Tier 1 / 2**, **Smart followers** and **Blacklist**.

### Models and prices
Model names are free text: when OpenAI releases a new model, type its name into a model row (or add a row) and
update its prices. Presets use the GPT-6 family by default (late October 2026): `gpt-6-luna` (fast/cheap),
`gpt-6.1-terra` (balanced), `gpt-6.1-sol` (high quality). The **GPT-5 family** is in the list too, ready to
pick for any preset: `gpt-5-nano`, `gpt-5-mini`, `gpt-5`, `gpt-5.1`, `gpt-5.2`, `gpt-5.4-nano`,
`gpt-5.4-mini`, `gpt-5.4`, `gpt-5.5` (USD per 1M tokens input / output: 0.05 / 0.40, 0.25 / 2, 1.25 / 10,
1.25 / 10, 1.75 / 14, 0.20 / 1.25, 0.75 / 4.50, 2.50 / 15, 5 / 30). **Check the prices on
openai.com/api/pricing and update them**; the cost numbers are only as good as this table. Use **Test** next to
a model to confirm your key can use it. Defaults per tier: tier 1 High quality, tier 2 Balanced.
If a model errors, times out or hits a rate limit, the fallback is used once: Balanced at low effort, then
GPT-5 mini as the last resort, so one renamed or unavailable model never stops comment generation.

### Cost
After every OpenAI call ScoreX reads the real token usage from the response (input, cached input, cache writes,
output, reasoning) and computes the cost from your price table. Reasoning tokens are billed as output and are
not counted twice. Rough per-reply costs with the default prices, including the quality check:

| Preset | Model / effort | Per reply | 30 replies/day, per month |
|---|---|---|---|
| Cheap | gpt-6-luna / low | ~$0.0007 | ~$0.60 |
| Balanced | gpt-6.1-terra / medium | ~$0.008 | ~$7 |
| High quality | gpt-6.1-sol / high | ~$0.036 | ~$32 |

The estimator in Models & costs uses your own average token usage once you have history.

## 5. Safety (main account)

**Limits** (editable, but never above the hard caps):

| Rule | Default | Hard cap |
|---|---|---|
| Comments per 24 hours (rolling) | 200 (set lower week 1 / week 2 numbers for a ramp) | 200 |
| Different accounts per 24 hours | 100 | 200 |
| Same account | 2 per 24 hours, 14 per 7 days | 2 / 14 |
| Gap between comments | random 2-6 min | never below 2 min |
| Long breaks | after every 10-15 comments, 8-15 min | - |
| Active hours | off (works around the clock); optional window, e.g. 10:00-00:00 Asia/Dhaka | - |
| Likes | on: every post is liked right before the reply, no separate limit | one per comment |
| Generations per 24 hours | 2 x the comment limit (protects your OpenAI spend) | - |
| Unfollow cleanup | off, 10/day when on, min 7 days | 30/day |

Limits use rolling windows (the last 24 hours / 7 days), so an active-hours window that crosses midnight
never gets two daily limits in one session. A reply whose confirmation was unclear ("probably sent") counts
toward every limit. Watch pages are never loaded more often than every 90 seconds.

**Human-like behaviour**: random check intervals, the post is opened and "read" for a few seconds (longer for
longer posts), a small scroll, optional like, typing at 170-320 characters per minute in small chunks with
pauses, a re-read before sending, X's confirmation is awaited. Typing is paced from the service worker, so it
stays realistic even when the X tab is in the background.

**Auto-stop**: ScoreX stops immediately, shows a desktop notification and a red **!** badge, and does **not**
retry when it sees: a captcha / verification page, X's "this request looks like it might be automated" or any
unusual-activity warning, a rate-limit message ("over the daily limit", "Something went wrong" three times in a
row), a locked or restricted account, the login page, a different logged-in account (or one ScoreX cannot read
on 3 page loads in a row), a dialog or notice ScoreX does not know (for example a new "label AI content"
question: it is never clicked, and its text is shown with the stop), 2 posting failures in a row, a page whose
posts can no longer be read (X changed its markup), a rejected OpenAI key, exhausted OpenAI quota, the monthly
budget, or a reach collapse when the reach monitor is set to *Stop*. **Resume is always manual**: press
**Review stop...**, check your account on x.com, tick the box and resume.

**Account check before every action**: right before each like, reply and unfollow click the page checks again
that it is logged in as your account. If the account cannot be read, nothing is clicked or typed and the reply
waits for the next slot.

**Pause / Stop** take effect immediately, also in the middle of typing a reply: nothing is submitted after
you press them, and the half-typed text is cleared.

**Never done**: no blind re-submit (if the confirmation is unclear ScoreX checks the thread for your reply
instead of posting again), no replies to posts it already handled, no clicking through captchas or warnings,
no X API, no other accounts.

**Safety profiles** (Safety screen): *Careful* (20, 40, then 60 a day, 1 per account, 40 accounts, gaps of
6-15 min), *Standard* (60, 90, then 120 a day, 2 per account, 70 accounts, gaps of 3-8 min) and *Max* (your
defaults: 200 a day, 2 per account, 100 accounts, gaps of 2-6 min). Changing any single field shows *Custom*.

**Risk report**: an estimate built from what raises the risk most (replies in the last 24 hours vs the limit,
hours active per day, Full auto, a like on every reply, how fast replies follow a post, X page loads, and your
reply reach), with the hours you need to reach today's limit. The points are hand-picked heuristics, not a
guarantee and not something X publishes.

**X page loads**: every page ScoreX opens in the X tab is counted by purpose (watching, posting, follow checks,
engagement checks, mentions, diagnostics) for the last 24 hours. You can set a cap; at the cap ScoreX waits
until older loads leave the 24-hour window (never a stop). **Adaptive watching** slows the watch checks down
(1.5x per empty check, up to 15 min) after 6 checks in a row found nothing new, and returns to normal with the
first new post.

**Reply reach monitor** (on, action *Review*): after enough checked replies (15) ScoreX compares the views of
your recent replies with your earlier ones. If the median drops by 60% or more, or more than half of the recent
replies get fewer than 10 views, it alerts you (notification, banner on Today and Safety) and then does what
you chose: only notify, switch to Review mode, halve the daily limit until you dismiss the alert, or stop. It
never switches anything back by itself. View counts are what X shows on the page, and low reach can have other
causes (topic, time of day), so treat the alert as a signal to look, not proof of a penalty.

**Keeps running**: all state is in `chrome.storage` and IndexedDB, so the service worker can sleep or be
killed at any time. After a Chrome restart a running engine resumes by itself (a safety stop stays stopped).
A closed X tab is reopened (pinned, in the background).

<a id="follow-tracking"></a>
### Follow tracking (who gets comments)

ScoreX only comments on accounts that **don't follow you**. Import a list of 100 smart accounts and the 10 or
20 that already follow you are found and left alone:

1. Every new target starts as **Checking** and gets no comments until it is checked.
2. ScoreX reads your own followers list (`x.com/0x_nation/followers`, newest first): every account there with
   X's "Follows you" badge follows you. After new targets were added it reads deeper; later it reads your
   newest followers every 2 hours, which is where follow-backs show up.
3. Targets that were not in that list get a profile visit (the "Follows you" badge next to their name), a
   few per check, so 100 new targets take about an hour to check.
4. **Follows you** -> never commented on. **Not following** -> comments start.
5. **Followed back** (seen in your followers list, or on a profile re-check every 3 days) -> no more comments.
   Replies still waiting in the queue for that account are dropped. You get a notification.
6. **14 days** after the first comment to an account, if it still doesn't follow you, ScoreX checks the
   profile one last time and then **removes it from your targets and adds it to the blacklist**. Blacklisted
   accounts are never added again by import, paste or discovery until you remove them from the blacklist
   (Targets > Blacklist). The number of days, automatic removal and the blacklist are switches on the
   Targets screen (**Edit rules**).

Safety check: if X shows your followers list without any "Follows you" badge, the badge markup has changed
and every account would look like a non-follower, so ScoreX stops ("X page changed") instead of commenting.
"Doesn't follow you" is only trusted while the badge was seen working in the last 3 days. If an account
that followed you unfollows later, it is treated as not following again (after two checks in a row).

## 6. Scores (TwitterScore, Sorsa, Ethos, Moni)

ScoreX can show your own score on four score sites, check any account, and turn the "smart followers" of big
accounts into targets. Every provider is **off** until you turn it on in **Scores > Providers**; Chrome then asks
for permission to reach that one site. Only X handles are sent (yours, your targets' or the account you check).
Provider keys are stored like the OpenAI key (the extension's IndexedDB) and are never logged or exported.

| Provider | What you get | Key | How ScoreX reads it |
|---|---|---|---|
| **TwitterScore** (twitterscore.io) | score out of 1000; the first 3 smart followers (free profile page) | not needed (paid API optional) | the free public page; *browser tab* mode reads the rendered page in a background tab; API mode (your key) lists every smart follower |
| **Sorsa** (sorsa.io, formerly TweetScout) | Sorsa Score with tiers (Noted / Credible / Significant / Supreme); the 20 highest-score followers | needed: 100 free requests, then paid | API v3 (`api.sorsa.io`) |
| **Ethos** (ethos.network) | credibility score out of 2800 | not needed | free public API |
| **Moni** (getmoni.io) | Moni score; smart followers | free key (a few hundred requests a month) | API |

* **Your scores**: refreshed about once a day (or with *Refresh now*), with a daily history for the chart and
  the 7- and 30-day changes.
* **Check any account**: scores from every enabled provider, then *Add as target* or *Show smart followers*.
* **Smart followers -> targets** (Discover): pick big accounts, for example your Tier 1 targets. ScoreX asks each
  enabled provider for their smart followers, merges the lists, skips accounts that already follow you, your
  targets and the blacklist, and shows the rest as candidates with their scores. Accounts listed under several
  big accounts rank higher. Nothing is added or followed until you choose.
* **Target scores**: fetch provider scores for your targets (a background job with progress and Cancel).
* **Daily request caps** per provider protect your free quotas and the sites; requests are paced and cached
  (your own score 20 h, checks and smart-follower lists 3 days, target scores 7 days).
* **Provider overrides** (Scores > Advanced): if a site renames a field or moves an endpoint, patch it there
  (JSON, limited to that provider's own https hosts) without waiting for an update.

What cannot be guaranteed: these sites change their pages and APIs without notice, and some block automated
reads (ScoreX shows "bot check" and tries again another day). The free TwitterScore page shows 3 smart
followers, not 5-6. Sorsa's web app now needs a login, so ScoreX uses its API. The provider definitions were
written from each site's public documentation and tested against mock servers, not against the live sites
from the development machine. Kaito is not available (it shut down its Yaps API in January 2026).

**ScoreX rank** (always on, no network): a 0-100 score built from followers (reach, 40%), engagement rate of
recent posts (25%), posting activity and recency (20%) and follower/following ratio plus verification (15%).
Spam/bot signals (spam bio, repetitive or "gm"-only posts, following far more than followers, default avatar,
very new account...) reduce it strongly. Tier 1 is suggested at 50k+ followers or rank 78+. With Sorsa enabled,
the **combined** rank blends both (50/50 by default).

## 7. Self-learning (Phase 3)

* About 24 hours after each reply (and again after about 72 hours) ScoreX opens it and records likes, replies,
  and whether the author answered.
* Follow-backs found by [follow tracking](#follow-tracking) are credited to your comments from the previous
  14 days (the account gets no more comments from then on), and a responsive account is raised to tier 1
  with a higher priority.
* Targets that never respond after N comments (default 6) cool down for 10 days.
* **A/B testing**: your Tone prompt is always the default. Pick extra tones (and/or presets) to test against
  it on the Tone screen (none by default, so every reply uses your Tone prompt until you do). Variants are
  chosen with Thompson sampling, starting with a lean towards your Tone prompt, plus an exploration share
  (20%). The Tone screen shows results and suggests the best tone and model once each combination has
  enough checked replies. A tone or preset set on a single target is never overridden by A/B tests.
* **Conversation alerts** (on): when idle, at most every 40 minutes, ScoreX reads your mentions and spots
  authors who answered one of your replies from the last 72 hours. They show up under **Today > Needs you**
  (Open on X, Mark done) with a notification. ScoreX never answers for you.
* **Learn from my edits** (on, Tone screen): when you change a reply in Review before approving it, your last
  few edits (draft -> what you posted) are shown to the model as style examples. They are data only, like the
  post text, and never become instructions. Small typo fixes are ignored.
* **Value ranking** (on, Targets > Edit rules): a target's priority starts from its *value* = its score (the
  score sites when available, otherwise ScoreX rank) x its chance to follow back (learned from your own
  results), plus a boost for tier 1. The weights are heuristics. **High value** on Targets shows value 70+,
  and the drawer explains each value.
* **History retention** (Results > Comments): skipped and failed attempts older than 30 days are shortened to
  the essentials, and deleted after 90 days. Posted replies (with their results) and anything still waiting are
  never touched.
* **Cleanup** (default **OFF**): unfollows targets you follow that did not follow back within 7+ days. It has its
  own daily limit, a whitelist and tier-1 protection, and it re-checks each profile right before unfollowing.
  Only accounts in your target list are ever considered (an account removed after 14 days without a
  follow-back is no longer in the list, so with cleanup on keep its days below the give-up days; the
  defaults are 7 and 14).

## 8. Testing each phase in Chrome

Load the extension (section 1), add your API key, then:

**Phase 1: core**
1. Add 2-3 targets that post often and don't follow you (Tier 2), plus one account that does follow you, set
   the watch strategy, press **Start**. Within a minute or two the Targets screen shows **Not following** for the
   first ones and **Follows you** for the other; only the first ones ever get replies.
2. Within a few minutes of one of them posting, a reply should appear in **Review**. Check the post link,
   the model and the cost.
3. Edit it and **Approve**. Watch the pinned X tab: it opens the post, types the reply and posts it.
4. Check: the reply on x.com is exactly your text; **Results > Comments** shows it as posted with tokens and cost;
   **Results > Spend** and the estimator in Models & costs update; skipped posts (giveaways, links, too old) show a reason.

**Phase 2: full auto and safety**
1. **Safety** shows the daily limits (200/day, 2 per account, 100 accounts). Try a narrow active-hours window:
   the status says "Sleeping".
2. Switch to Full auto on Today and check that replies are posted with 2-6 minute gaps, at most
   2 per account per 24 hours, each post liked first.
3. Safe things to try: close the pinned X tab (it comes back), restart Chrome (it resumes by itself), log
   out of X in that profile (ScoreX stops with "Logged out", notifies you and shows a red badge).

**Phase 3: learning and cleanup**
1. A day after posting, **Results > Comments** fills in the result columns (reply likes, replies, author replied).
   When an account you commented on follows you, the Targets screen shows **Followed back** and it gets no more
   replies; an account with no follow-back 14 days after the first reply moves to **Targets > Blacklist**.
2. **Tone > A/B testing** shows arms and, once there is enough data, suggestions.
3. **Settings > Cleanup**: leave it off unless you want it. Use **Preview unfollows** first to see who would be unfollowed.

## 9. Updating selectors when X changes

All X selectors and page text patterns live in **`extension/content/selectors.js`**. Each entry is a list of
fallbacks. To patch without editing code, use **Settings > Worker tab and selectors > Selector overrides** with the same shape,
for example:

```json
{ "sel": { "replySubmitInline": ["[data-testid=\"tweetButtonInline\"]", "button[data-testid=\"replyButton\"]"] } }
```

**Settings > Diagnostics** runs a quick check (permissions, storage, key, handle, the "Follows you" badge, the
engine) and a **live X test**: it opens your home timeline, profile and followers list in the X tab (about
30 seconds, never clicks or types) and shows which selectors still match. **Copy report** gives a redacted
JSON (no keys, no other accounts' handles) to share when asking for help.

The patterns are written for an English X interface. If you use X in another language, add your language's
wording to the `text` patterns (captcha, rate limit, "Your post was sent", ...).

## 10. Known limits

* **X can change its page** at any time. ScoreX detects broken pages and stops, but it cannot fix them alone.
* **Background tab rendering**: Chrome may not fully render x.com in a hidden tab. If ScoreX reports "X tab
  not rendering", switch **Settings > Worker tab and selectors > Worker tab** to *separate window* (keep that window visible, for
  example on a second screen) or enable **Safety > Bring X tab to front while posting**.
* Only **original posts** are commented (no replies inside threads, no reposts). Quote posts are included by default.
* "Following since" for cleanup is the first time ScoreX saw that you follow an account.
* Engagement numbers come from what the page shows. X does not show whether the author liked your reply, so
  "author replied" and follow-backs are used instead.
* Prices and model names change. Keep the price table up to date.
* The comment rules are enforced by checks, not guaranteed by the model. Review mode is there for a reason.

## 11. Privacy

Everything stays in your browser (`chrome.storage.local` and IndexedDB). The only outbound requests are to
`api.openai.com` and, only for the score sites you turn on, `api.sorsa.io`, `twitterscore.io`,
`api.ethos.network` and `api.discover.getmoni.io` (they receive X handles, nothing else). There is no telemetry,
no remote code and no X API. API keys are never exported, logged or sent to x.com. Permissions: `storage`,
`alarms` and `notifications`, plus host access to `x.com` and `api.openai.com`; the score sites and `scripting`
(only for TwitterScore's browser-tab mode) are optional permissions that Chrome asks for when you turn them on.

## 12. Development

```
extension/          the unpacked extension (load this folder)
  manifest.json
  background/sw.js  service worker: events + message router
  lib/              engine, watcher, poster, generator, safety, costs, history, learning, cleanup, ...
  content/          x.com content scripts (selectors.js = all selectors)
  ui/               dashboard (options page) + popup
tests/unit/         node:test unit tests (no dependencies)
tests/e2e/          Playwright tests against a local mock of x.com and the OpenAI API
docs/ARCHITECTURE.md
```

* Unit tests: `npm test` (Node 22+, no install needed).
* End-to-end: needs Playwright with Chromium (`npm i -D playwright && npx playwright install chromium`), then
  `node tests/e2e/p1_core.mjs`, `node tests/e2e/p2_auto.mjs`, `node tests/e2e/p3_learning.mjs`,
  `node tests/e2e/scores.mjs`, `node tests/e2e/ui_smoke.mjs` and the long run `node tests/e2e/soak.mjs`
  (`SX_CYCLES=n` sets its length). They map x.com, api.openai.com and the score sites to local HTTPS mocks, so
  no real account or key is used. `SX_PORT` gives each run its own port when several run at once.
