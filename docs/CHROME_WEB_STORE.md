# Chrome Web Store listing - ScoreX 1.0.0

Copy-paste text for the Chrome Web Store Developer Dashboard. Release plan: **Unlisted** (only people with the link
can find and install it) and **invite only** (it does nothing without a license key from Unique Labs). A public,
global release comes later; see the end of this file for what to change then.

---

## Store listing tab

**Name** (from the manifest, 46/75 characters)

```
ScoreX: Boost your Influencer Score on Twitter
```

**Summary** (manifest description, 126/132 characters)

```
Grow your influencer score on X (Twitter): AI replies to the accounts that matter, written in your voice, with you in control.
```

**Category:** Social & Communication   **Language:** English

**Description**

```
ScoreX helps you grow your influencer score on X (Twitter) by showing up in the right conversations, every day,
in your own voice.

INVITE ONLY - EARLY ACCESS
ScoreX is currently available by invitation only. It needs a license key from Unique Labs to run: without one, the
extension shows the activation screen and does nothing else. If you received an invite, open ScoreX after
installing and enter your key. A public release will follow later.

WHAT IT DOES
Influencer and smart-follower scores (like TwitterScore) rise when respected accounts notice and follow you.
ScoreX makes that work steady and manageable:
- You choose the accounts that matter (paste them or import a CSV - TwitterScores in the file sort them into
  Tier 1 and Tier 2 automatically).
- When one of them posts, ScoreX writes a short, specific reply in your voice with your own OpenAI key.
- You review and approve each reply, or let Full auto post within strict daily limits.
- It follows an account before replying to it, tracks who followed you back, and shows what works.

BUILT FOR CONTROL AND SAFETY
- Runs in your own browser, in your own logged-in X session. No password is ever asked for or stored.
- Review mode by default: nothing is posted until you approve it.
- Hard daily limits, human-like pacing, active hours and breaks.
- Skips ads, giveaways, political posts and posts whose replies are restricted.
- Stops immediately on X warnings (captcha, rate limit, "unusual activity") and never clicks prompts it does not know.
- Real cost tracking for your OpenAI usage, with a monthly budget.

YOUR DATA STAYS WITH YOU
Targets, history and settings are stored in your browser only. Post text is sent to OpenAI with your own API key
to write replies. Score sites (TwitterScore, Sorsa, Ethos, Moni) are contacted only if you turn them on. Your
license key is checked with the Unique Labs license server. Nothing is sold or shared, and there are no ads or
trackers.

You are responsible for using ScoreX in line with X's rules. ScoreX is not affiliated with or endorsed by X Corp.

A product of Unique Labs. Developed by Shahriar Ahmed.
```

**Graphics to upload**
- Store icon 128x128: `extension/icons/icon128.png`
- Screenshots (1280x800 or 640x400, at least 1): Today, Review, Targets, History > Follow-backs, Settings > Safety.
  The UI test run saves light/dark captures in `tests/e2e/out/` that can be cropped to 1280x800.
- Small promo tile 440x280 (optional for unlisted).

---

## Distribution tab

- **Visibility: Unlisted.** Share the store link only with invited users.
- Regions: all regions (access is controlled by license keys, not by region).
- Pricing: free to install (keys are issued separately by Unique Labs).

---

## Privacy practices tab

**Single purpose**

```
ScoreX helps the user grow their influencer score on X (Twitter) by drafting and posting replies to accounts the
user chooses, from the user's own logged-in X session, and tracking the results.
```

**Permission justifications**

| Permission | Justification |
| --- | --- |
| `storage` | Saves the user's targets, reply history, settings and API keys locally in the browser. |
| `alarms` | Schedules the next check for new posts and spreads replies out over time while the browser is open. |
| `notifications` | Tells the user when a reply is ready to review, when X shows a warning, or when ScoreX stops. |
| Host `https://x.com/*` | Reads posts from the accounts the user chose and posts the replies the user approved, in the user's own X tab. |
| Host `https://api.openai.com/*` | Sends a post's text to OpenAI with the user's own API key to write a reply. |
| Optional hosts (twitterscore.io, api.sorsa.io, api.ethos.network, api.discover.getmoni.io) | Requested only when the user turns on a score site, to read scores and smart followers. |

**Remote code:** No. All code ships in the package; no remote scripts are loaded or evaluated.

**Data usage** - tick:
- *Website content* (post text from x.com, sent to OpenAI to write replies)
- *Authentication information* (the user's own API keys, stored locally; the license key, sent to the license server)

Certify: data is not sold, not used for unrelated purposes, not used for creditworthiness or lending.

**Privacy policy URL:** `https://scorex-license.vercel.app/privacy.html` (the page is `license-server/public/privacy.html`,
published with the license server on its next deploy). Replace the placeholder contact email in it first.

---

## Before submitting

- Version in `manifest.json` and `lib/constants.js`: 1.0.0. Upload a zip whose root contains `manifest.json`.
- Trademark: "Twitter" in the name is descriptive; reviewers sometimes question third-party brand names. If the
  listing is rejected for it, use "ScoreX: Boost your Influencer Score on X".
- Review risk: automated posting is a sensitive area for Chrome Web Store reviewers (spam policy). Keep Review mode
  as the default and the safety limits described above; mention them in the "notes for reviewer" field together with
  a test license key so the reviewer can get past the activation screen.

## Later: global release

- Distribution > Visibility: Public.
- Description: replace the "INVITE ONLY - EARLY ACCESS" block with how to get a key (or remove the license gate),
  and drop "invitation only" from the first lines.
