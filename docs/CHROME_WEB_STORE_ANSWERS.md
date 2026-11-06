# ScoreX 1.0.0 – Chrome Web Store dashboard answers

## STORE LISTING TAB

### Description (paste into "Description")

ScoreX helps you grow your influencer score on X (Twitter) by showing up in the right conversations, every day, in your own voice.

INVITE ONLY – EARLY ACCESS
ScoreX is currently available by invitation only. It needs a license key from Unique Labs to run: without one, the extension shows the activation screen and does nothing else. If you received an invite, open ScoreX after installing and enter your key. A public release will follow later.

WHAT IT DOES
Influencer and smart-follower scores (like TwitterScore) rise when respected accounts notice and follow you. ScoreX makes that work steady and manageable:
- You choose the accounts that matter (paste them or import a CSV; TwitterScores in the file sort them into Tier 1 and Tier 2 automatically).
- When one of them posts, ScoreX writes a short, specific reply in your voice with your own OpenAI key – one that adds something the author would want to answer.
- You review and approve each reply, or let Full auto post within strict daily limits.
- It follows an account before replying, skips accounts that rarely follow back, tracks who followed you back and shows what works.

BUILT FOR CONTROL AND SAFETY
- Runs in your own browser, in your own logged-in X session. No password is ever asked for or stored.
- Review mode by default: nothing is posted until you approve it.
- Hard daily limits, human-like pacing, active hours and breaks.
- Skips ads, giveaways, political posts and posts whose replies are restricted.
- Stops on X warnings (captcha, rate limit, "unusual activity") and never clicks prompts it does not know.
- Real cost tracking for your OpenAI usage, with a monthly budget.

YOUR DATA STAYS WITH YOU
Targets, history and settings are stored in your browser only. Post text is sent to OpenAI with your own API key to write replies. Score sites (TwitterScore, Sorsa, Ethos, Moni) are contacted only if you turn them on. Your license key is checked with the Unique Labs license server. Nothing is sold or shared, and there are no ads or trackers.

You are responsible for using ScoreX in line with X's rules. ScoreX is not affiliated with or endorsed by X Corp.

A product of Unique Labs. Developed by Shahriar Ahmed.

### Category / Language
Category: Social & Communication  ·  Language: English

### Store icon (128x128)
Upload: icon-128.png

### Screenshots (1280x800) – upload all five
1-today.png, 2-review.png, 3-targets.png, 4-follow-backs.png, 5-safety.png

---

## PRIVACY PRACTICES TAB

### Single purpose description

ScoreX helps the user grow their influencer score on X (Twitter) by drafting and posting replies to accounts the user chooses, from the user's own logged-in X session, and tracking the results (follow-backs and engagement).

### storage justification

Saves the user's chosen target accounts, reply history, settings, license status and their own API keys locally in the browser, so ScoreX keeps working across browser restarts. Nothing in storage is sent to us.

### alarms justification

Schedules the next check for new posts from the user's target accounts and spaces replies out over time (daily limits, pacing, breaks) while the browser is open. Without alarms the background service worker could not resume this schedule.

### notifications justification

Tells the user when a drafted reply is waiting for their review, when someone they replied to follows them back, and when ScoreX pauses because X showed a warning or something that needs the user's attention.

### scripting justification

Optional permission, requested only if the user turns on a score site's "browser tab" mode. ScoreX then opens that score site (for example twitterscore.io) in a tab and reads the score shown on the page, because the site blocks direct requests. It is never used on any other site.

### Host permission justification

https://x.com/* – ScoreX reads posts from the accounts the user chose and, in the user's own logged-in tab, likes, follows and posts the replies the user approved (or that Full auto posts within the user's limits).
https://api.openai.com/* – sends the text of the post being replied to, with the user's own OpenAI API key, to write a reply.
Optional hosts (twitterscore.io, api.sorsa.io, api.ethos.network, api.discover.getmoni.io) – requested only when the user turns on that score site, to read account scores and smart-follower lists.

### Remote code

Select: **"No, I am not using Remote code"**.
(If a text box still shows: "All JavaScript is included in the extension package. ScoreX does not load or execute any remote code; it only exchanges JSON data with x.com, the OpenAI API, optional score-site APIs and the license server.")

### Data usage – tick these
- [x] Authentication information (the user's own API keys, stored locally; the license key, checked with the license server)
- [x] Website content (text of X posts, sent to OpenAI to write replies)
Leave everything else unticked.

Then tick all three certifications:
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

### Privacy policy URL
https://scorex-license.vercel.app/privacy.html
(Redeploy the license server first so this page is live.)

---

## DISTRIBUTION TAB
Visibility: **Unlisted** · Regions: all · Free

## Notes for the reviewer (Test instructions, if asked)
ScoreX requires a license key. Test key: <create one in the license admin page and paste it here>.
After installing, open ScoreX, enter the key, add your own OpenAI API key and a few X accounts on Targets. Review mode is on by default: replies are only drafted and wait for approval; nothing is posted without the user's action unless they switch to Full auto, which stays within strict daily limits.

Then press **Save Draft**, then **Submit for review**.
