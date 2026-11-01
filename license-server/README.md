# ScoreX license server

Keeps ScoreX locked for anyone without a license key you created. **One key works on one browser**: the first ScoreX
that activates a key owns it, and the same key on any other browser is refused. You can turn a key off (Revoke), free
it for a new computer (Reset) or delete it, from a small admin page.

Vercel functions plus an Upstash Redis database (Vercel's free storage). No npm packages.

## Set it up (about 10 minutes)

1. **Create the Vercel project.** On vercel.com click Add New > Project and import this GitHub repository. Set **Root
   Directory** to `license-server` and **Framework Preset** to *Other*, then click Deploy. (With the CLI:
   `cd license-server && npx vercel --prod`.)
2. **Add the database.** In the project open **Storage** > Create Database > **Upstash for Redis**, pick the free plan
   and connect it to the project for all environments. This adds the `KV_REST_API_URL` / `KV_REST_API_TOKEN` variables
   (or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`; both names work).
3. **Set your admin password.** Settings > Environment Variables > add `ADMIN_SECRET` with a long random password
   (20+ characters; it must be at least 12). Anyone with it can create keys, so keep it to yourself.
4. **Redeploy** (Deployments > the latest one > Redeploy) so the new variables are used.
5. **Point ScoreX at it.** In the extension, open `extension/lib/license.js` and set
   `LICENSE_SERVER = "https://YOUR-PROJECT.vercel.app"` (your project's URL, no slash at the end). Then zip the
   `extension` folder and share that zip.

## Create and manage keys

Open `https://YOUR-PROJECT.vercel.app`, enter `ADMIN_SECRET`, and:

* **Create**: how many keys, and who they are for (a name or note). Copy the keys right away: only their fingerprint is
  stored, so they are never shown again. Give each team member one key.
* **Keys list**: who each key is for, its status (unused, active, revoked), when it was activated, its last check and
  the ScoreX version.
* **Reset**: the member moved to a new computer, reinstalled ScoreX or loaded it from another folder. The old browser
  stops at its next check and the key can be activated once more.
* **Revoke**: the member left. ScoreX stops on that browser at its next check (within 6 hours; it pauses if it is
  running).
* **Delete**: removes the key for good.

The team member opens ScoreX, pastes the key on the activation screen and clicks Activate. Settings > General > License
shows the status, with *Check now* and *Remove from this browser*.

**Updating ScoreX for your team:** they unzip the new version over the same folder and click the reload icon in
`chrome://extensions`. Loading it from a different folder makes Chrome treat it as a new install, which needs a Reset of
their key.

## How it works

* `POST /api/activate {key, deviceId, version}`: the first install ID (a random ID ScoreX makes, nothing about the
  person) to send a key owns it. This is atomic, so two browsers activating at the same moment cannot both win.
* `POST /api/verify {key, deviceId, version}`: ScoreX checks every 6 hours. If the key is revoked, reset or bound to
  another browser, ScoreX locks. If the server can't be reached, ScoreX keeps working for 3 days after its last good
  check, then locks until it can check again.
* `POST /api/admin {action: create | list | revoke | reset | delete}` with `Authorization: Bearer <ADMIN_SECRET>`: used
  by the admin page.
* Keys are `SCX-XXXX-XXXX-XXXX-XXXX` with 80 random bits. Only their SHA-256 is stored, so a database leak gives no
  usable keys. Activation, checks and wrong admin passwords are rate limited per IP.
* The server receives the key, the install ID, the ScoreX version and (as on every website) the IP address. It never
  receives X data, OpenAI keys or anything else.

Try it locally with `node dev.mjs` (in-memory storage, admin password `local-dev-secret`). Run the tests with `npm test`.

## What it cannot do (honestly)

ScoreX is plain JavaScript running on your team members' computers. Someone who can edit code could remove the license
check from their copy, and copying an entire Chrome profile copies an activation with it. This system stops the zip or a
key from being passed around and used by others. It does not stop a determined developer. No browser extension can
fully prevent that, because every check runs on the user's own machine.
