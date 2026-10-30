# ScoreX

A Chrome extension (Manifest V3) that writes short, thoughtful replies to posts on X with OpenAI and
posts them **from your own logged-in browser tab**, with a review queue, real cost tracking and strict
safety limits for a main account. It does **not** use the X API: it works through the x.com page like
you would (content scripts in a pinned X tab).

> **Read this first: no guarantees.**
> * X's rules restrict automated replies. Every safety feature below lowers the risk, but none of them makes
>   automation undetectable or risk-free. Review mode (the default) is the safest way to use ScoreX.
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

1. **Models & Costs > OpenAI API key**: paste your key and press **Save**, then **Test**. The key is stored only
   inside the extension (its own IndexedDB, which pages on x.com cannot read), is shown masked, and is never
   logged or exported.
2. **Settings > Account**: your handle is preset to `0x_nation`. ScoreX stops if a different account is logged in.
3. **Settings > Watching for new posts**: choose how new posts are found:
   * **X List (recommended)**: create a *private* X List with all your targets and paste its URL. One page view
     then shows every target's newest posts, which is the lightest and fastest way to watch many accounts.
   * **Batched Latest search** (default, no setup): `(from:a OR from:b ...) -filter:replies`, 12 accounts per search.
   * **Profile rotation**: visits a few profiles per check. Fine for a handful of targets only.
4. **Targets**: paste handles or profile links (or import CSV / JSON / TXT) and choose the **Tier**
   (**Tier 1**: big influencers, **Tier 2**: smart accounts). You don't have to sort out who follows you:
   ScoreX checks every account first and **only comments on accounts that don't follow you** (see
   [Follow tracking](#follow-tracking)). Or use **Find new targets** (followers/following of a big account,
   people search, or accounts that several smart accounts follow). Candidates are ranked and bot-filtered;
   you pick which to add.
5. **Tone & Prompts > Tone prompt**: describe in your own words how your replies should sound (voice,
   attitude, wording, length, casing). It is sent with every comment. A sensible default is filled in.
6. **Models & Costs > Monthly budget**: set a limit (for example $10). ScoreX stops when it is reached.
7. Press **Start** (header or popup). It starts in **Review mode**; switch to **Full auto** on the Dashboard
   whenever you want.

## 3. How it works

```
 every 2.5-6 min (random, only in active hours)
   watch page (X List / Latest search / profiles) in the pinned X tab
     -> new original post by a target, 2-20 min old?
     -> skip rules (ads, link-only, political/controversial, giveaways, "gm", language...)
     -> only targets that don't follow you (new targets are checked first)
     -> limits (daily ramp, 1 per target per day, 3 per week, budget)
     -> OpenAI: post + bio + 2-3 recent posts + your Tone prompt -> reply (JSON)
     -> rule check + quality model check (generic? off-topic? repeated vs your last 50?) -> regenerate once or skip
   Review mode: reply waits in the Review Queue (edit / approve / regenerate / skip)
   Full auto:   reply is queued with a human delay
     -> open the post, "read" it, scroll, optional like, type at a human speed, verify, submit, confirm
     -> random 3-12 min gap (and longer breaks) before the next comment
 background when idle: follow checks (your followers list + profiles), follow-backs, removal after
 14 days without a follow-back, engagement checks, optional cleanup
```

## 4. Dashboard guide

The Dashboard shows a short setup checklist until ScoreX is ready. Every tab shows the essentials first;
everything else is in collapsed **Advanced** sections (their open/closed state is remembered).

| Tab | What you do there |
|---|---|
| **Dashboard** | Status (Running / Paused / Stopped with the reason), today's counters vs limits, cost today / this month, Review / Full auto switch, recent activity, "Run a check now". A red banner appears after an auto-stop. |
| **Targets** | Add / import / export targets, follow status of every account (checking / not following - day N of 14 / follows you / followed back), follow-back rules, blacklist, tier, tone and preset per target, enable/disable, re-check. Discovery and candidates. Rank columns: **ScoreX rank** (own formula) and **Sorsa Score** (if enabled). |
| **Review Queue** | Every generated reply with the post, the author, the model, the cost and quality notes. Edit, Approve, Regenerate (costs another call), Skip. Approved replies post one by one in their own time slots. |
| **Models & Costs** | API key, model list with **editable model names** and **price table** (per 1M tokens: input, cached input, cache write, output), presets High quality / Balanced / Cheap with reasoning effort Low / Medium / High, fallback models, preset per tier, quality checker, cost estimator, budget, totals per model / day / week / month, performance per model and tone. |
| **Tone & Prompts** | Your **Tone prompt** (the one input that sets how replies sound) and a prompt preview. Advanced: extra rules, learning from your best-performing replies, built-in and custom tones (per-target overrides), A/B testing settings, results and suggestions. |
| **Safety** | Ramp limits, gaps and breaks, active hours and time zone (default 10:00-00:00 Asia/Dhaka), per-target caps, like + comment combo, typing speed, skip rules, failure limit, the list of auto-stop triggers. |
| **History** | Every reply attempt: date, target, tier, post link, model, reasoning level, tokens, cost, comment, status (posted / skipped / failed + reason) and results (liked, reply likes, replies, author replied, followed back). Filters, totals, CSV export. |
| **Settings** | Account, watch strategy, comment window (default 2-20 min after a post), review expiry, learning, cleanup, Sorsa, worker tab mode, selector overrides, theme, export / import JSON, history CSV, reset. |

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

The estimator in Models & Costs uses your own average token usage once you have history.

## 5. Safety (main account)

**Limits** (editable, but never above the hard caps):

| Rule | Default | Hard cap |
|---|---|---|
| Comments per 24 hours (rolling): week 1 / week 2 / week 3+ | 10 / 20 / 30 | 30 |
| Gap between comments | random 3-12 min | never below 2 min |
| Long breaks | after every 3-6 comments, 20-60 min | - |
| Active hours | 10:00-00:00 Asia/Dhaka | - |
| Same target | 1 per 24 hours, 3 per 7 days | 1 / 3 |
| Likes (like + comment combo) | off, 20/day when on | 50 |
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
row), a locked or restricted account, the login page, a different logged-in account, 2 posting failures in a
row, a page whose posts can no longer be read (X changed its markup), a rejected OpenAI key, exhausted OpenAI
quota, or the monthly budget. **Resume is always manual**: check your account on x.com first, then press
"I checked my account - resume".

**Pause / Stop** take effect immediately, also in the middle of typing a reply: nothing is submitted after
you press them, and the half-typed text is cleared.

**Never done**: no blind re-submit (if the confirmation is unclear ScoreX checks the thread for your reply
instead of posting again), no replies to posts it already handled, no clicking through captchas or warnings,
no X API, no other accounts.

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
   Targets tab.

Safety check: if X shows your followers list without any "Follows you" badge, the badge markup has changed
and every account would look like a non-follower, so ScoreX stops ("X page changed") instead of commenting.
"Doesn't follow you" is only trusted while the badge was seen working in the last 3 days. If an account
that followed you unfollows later, it is treated as not following again (after two checks in a row).

## 6. Scores: what ScoreX uses (Kaito / Sorsa)

* **Kaito**: not available. Kaito shut down Yaps and its leaderboards on 2026-01-15 after X changed its API
  policy. Its old public Yaps API is gone, and the later Kaito / X data agreement came with no public
  developer API. ScoreX does not use Kaito.
* **Sorsa**: available as an **optional** provider (off by default). It is a paid API ($49/month for 10k
  requests; new accounts get 100 free requests). Enable it in Settings with your own key: Chrome asks for
  permission to reach `api.sorsa.io`, and scores are cached for 24 hours. The Sorsa Score is based on who
  follows an account, so follow-backs from high-Sorsa accounts are what move your own score.
* **ScoreX rank** (always used, no network): a 0-100 score built from followers (reach, 40%), engagement rate of
  recent posts (25%), posting activity and recency (20%) and follower/following ratio plus verification (15%).
  Spam/bot signals (spam bio, repetitive or "gm"-only posts, following far more than followers, default
  avatar, very new account...) reduce it strongly. Tier 1 is suggested at 50k+ followers or rank 78+.
  With Sorsa enabled, the **combined** rank blends both (50/50 by default).

## 7. Self-learning (Phase 3)

* About 24 hours after each reply (and again after about 72 hours) ScoreX opens it and records likes, replies,
  and whether the author answered.
* Follow-backs found by [follow tracking](#follow-tracking) are credited to your comments from the previous
  14 days (the account gets no more comments from then on), and a responsive account is raised to tier 1
  with a higher priority.
* Targets that never respond after N comments (default 6) cool down for 10 days.
* **A/B testing**: your Tone prompt is always the default. Pick extra tones (and/or presets) to test against
  it in Tone & Prompts (none by default, so every reply uses your Tone prompt until you do). Variants are
  chosen with Thompson sampling, starting with a lean towards your Tone prompt, plus an exploration share
  (20%). Tone & Prompts shows results and suggests the best tone and model once each combination has
  enough checked replies. A tone or preset set on a single target is never overridden by A/B tests.
* **Cleanup** (default **OFF**): unfollows targets you follow that did not follow back within 7+ days. It has its
  own daily limit, a whitelist and tier-1 protection, and it re-checks each profile right before unfollowing.
  Only accounts in your target list are ever considered (an account removed after 14 days without a
  follow-back is no longer in the list, so with cleanup on keep its days below the give-up days; the
  defaults are 7 and 14).

## 8. Testing each phase in Chrome

Load the extension (section 1), add your API key, then:

**Phase 1: core**
1. Add 2-3 targets that post often and don't follow you (Tier 2), plus one account that does follow you, set
   the watch strategy, press **Start**. Within a minute or two the Targets tab shows **Not following** for the
   first ones and **Follows you** for the other; only the first ones ever get replies.
2. Within a few minutes of one of them posting, a reply should appear in **Review Queue**. Check the post link,
   the model and the cost.
3. Edit it and **Approve**. Watch the pinned X tab: it opens the post, types the reply and posts it.
4. Check: the reply on x.com is exactly your text; **History** shows it as posted with tokens and cost;
   **Models & Costs** totals and the estimator update; skipped posts (giveaways, links, too old) show a reason.

**Phase 2: full auto and safety**
1. **Safety** shows the ramp (10/day in week 1). Try a narrow active-hours window: the status says "Sleeping".
2. Switch to Full auto on the Dashboard and check that replies are posted with 3-12 minute gaps, at most
   1 per target per 24 hours.
3. Safe things to try: close the pinned X tab (it comes back), restart Chrome (it resumes by itself), log
   out of X in that profile (ScoreX stops with "Logged out", notifies you and shows a red badge).

**Phase 3: learning and cleanup**
1. A day after posting, **History** fills in the result columns (reply likes, replies, author replied).
   When an account you commented on follows you, the Targets tab shows **Followed back** and it gets no more
   replies; an account with no follow-back 14 days after the first reply moves to **Targets > Blacklist**.
2. **Tone & Prompts > A/B testing** shows arms and, once there is enough data, suggestions.
3. **Settings > Cleanup**: leave it off unless you want it. Use **Preview** first to see who would be unfollowed.

## 9. Updating selectors when X changes

All X selectors and page text patterns live in **`extension/content/selectors.js`**. Each entry is a list of
fallbacks. To patch without editing code, use **Settings > Advanced > Selector overrides** with the same shape,
for example:

```json
{ "sel": { "replySubmitInline": ["[data-testid=\"tweetButtonInline\"]", "button[data-testid=\"replyButton\"]"] } }
```

The patterns are written for an English X interface. If you use X in another language, add your language's
wording to the `text` patterns (captcha, rate limit, "Your post was sent", ...).

## 10. Known limits

* **X can change its page** at any time. ScoreX detects broken pages and stops, but it cannot fix them alone.
* **Background tab rendering**: Chrome may not fully render x.com in a hidden tab. If ScoreX reports "X tab
  not rendering", switch **Settings > Advanced > Worker tab** to *separate window* (keep that window visible, for
  example on a second screen) or enable **Safety > Bring X tab to front while posting**.
* Only **original posts** are commented (no replies inside threads, no reposts). Quote posts are included by default.
* "Following since" for cleanup is the first time ScoreX saw that you follow an account.
* Engagement numbers come from what the page shows. X does not show whether the author liked your reply, so
  "author replied" and follow-backs are used instead.
* Prices and model names change. Keep the price table up to date.
* The comment rules are enforced by checks, not guaranteed by the model. Review mode is there for a reason.

## 11. Privacy

Everything stays in your browser (`chrome.storage.local` and IndexedDB). The only outbound requests are to
`api.openai.com` (and `api.sorsa.io` only if you enable Sorsa). There is no telemetry, no remote code and no
X API. API keys are never exported, logged or sent to x.com. Permissions: `storage`, `alarms` and
`notifications`, plus host access to `x.com` and `api.openai.com` (Sorsa is an optional permission).

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
  `node tests/e2e/p1_core.mjs`, `node tests/e2e/p2_auto.mjs`, `node tests/e2e/p3_learning.mjs` and
  `node tests/e2e/ui_smoke.mjs`. They map x.com / api.openai.com to a local HTTPS mock, so no real account or
  key is used.
