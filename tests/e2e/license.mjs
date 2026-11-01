// License end to end (real Chromium, the mock license server): ScoreX is locked until a key is activated, a key works
// on one browser, a revoked key locks it at the next check, and an unreachable server is tolerated (grace).
import fs from "fs";
import path from "path";
import { boot, setup, assert, log, sleep, passCount, TEST_LICENSE_KEY } from "./harness.mjs";

const OUT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "out");
fs.mkdirSync(OUT, { recursive: true });

const H = await boot({ license: false });
const { M } = H;
let failed = false;
const base = `chrome-extension://${H.extId}/ui/`;
try {
  // ---- locked ----
  const page = await H.ctx.newPage();
  await page.goto(base + "dashboard.html#overview");
  await page.waitForSelector("#lockCard", { timeout: 15000 });
  assert(await page.locator("#app").isHidden(), "locked: the dashboard shows only the activation card");
  assert(/Activate ScoreX/.test(await page.locator("#lockCard h1").innerText()), "the card asks for a license key");
  let r = await H.msg("getStatus");
  assert(r && r.ok === false && r.licensed === false, "locked: the worker refuses every other request (" + JSON.stringify(r) + ")");
  r = await H.msg("start");
  assert(r && r.licensed === false, "locked: Start is refused");
  const popup = await H.ctx.newPage();
  await popup.goto(base + "popup.html");
  await popup.waitForSelector("#lockCard", { timeout: 10000 });
  assert(await popup.locator("#popup").isHidden(), "locked: the popup shows only the activation card");
  await page.screenshot({ path: path.join(OUT, "license-lock.png") });
  await popup.setViewportSize({ width: 360, height: 420 });
  await popup.screenshot({ path: path.join(OUT, "license-lock-popup.png") });

  // ---- wrong keys ----
  await page.fill("#licKey", "hello");
  await page.click("#licActivate");
  await page.waitForFunction(() => /doesn't look like a ScoreX key/.test(document.getElementById("licMsg").textContent), null, { timeout: 5000 });
  assert(M.license.calls.length === 0, "a malformed key never reaches the server");
  M.license.unknown.push("SCX-NNNN-PPPP-QQQQ-RRRR");
  await page.fill("#licKey", "scx-nnnn-pppp-qqqq-rrrr");
  await page.click("#licActivate");
  await page.waitForFunction(() => /doesn't exist/.test(document.getElementById("licMsg").textContent), null, { timeout: 5000 });
  assert(true, "an unknown key: the server's plain message is shown");

  // ---- activate ----
  await page.fill("#licKey", TEST_LICENSE_KEY.toLowerCase());
  await page.click("#licActivate");
  await page.waitForSelector('#view[data-ready="overview"]', { timeout: 15000 });
  assert(await page.locator("#app").isVisible(), "activated: the page reloads into the dashboard");
  await popup.waitForSelector("#pStatusBox", { state: "visible", timeout: 10000 });
  assert(await popup.locator("#popup").isVisible(), "the open popup unlocks too");
  r = await H.msg("getStatus");
  assert(r && r.ok !== false, "activated: requests work");
  const lic = await H.store("sx.license");
  assert(lic.key === TEST_LICENSE_KEY && lic.status === "active" && lic.deviceId && M.license.bound[TEST_LICENSE_KEY] === lic.deviceId, "stored: the key, its status and this browser's install ID (bound on the server)");

  // ---- Settings > General shows it ----
  await page.goto(base + "dashboard.html#settings");
  await page.waitForSelector("#licenseBox .badge", { timeout: 10000 });
  assert(/Active/.test(await page.locator("#licenseBox").innerText()) && /…TEST/.test(await page.locator("#licHint").innerText()) && !(await page.locator("#licenseBox").innerText()).includes(TEST_LICENSE_KEY), "Settings › General › License: Active, key …TEST (never the full key)");

  // ---- the same key in another browser ----
  const mine = lic.deviceId;
  await H.setStore({ "sx.license": {} }); // another browser: no install ID yet
  await page.waitForSelector("#lockCard", { timeout: 10000 });
  assert(true, "license gone: the open dashboard switches to the lock card");
  await page.fill("#licKey", TEST_LICENSE_KEY);
  await page.click("#licActivate");
  await page.waitForFunction(() => /already used on another browser/.test(document.getElementById("licMsg").textContent), null, { timeout: 5000 });
  assert(true, "the same key on another browser is refused");
  await H.setStore({ "sx.license": { ...lic, deviceId: mine } }); // back to the first browser
  await page.waitForSelector('#view[data-ready]', { timeout: 15000 });

  // ---- revoked at a check: the running engine pauses ----
  await setup(H, {});
  await H.msg("targetsUpsert", { rows: ["bigbob"], defaults: { tier: 1 } });
  M.addUser("bigbob", { followers: 20000 });
  r = await H.msg("start");
  assert(r && r.ok, "running before the revoke: " + JSON.stringify(r));
  M.license.revoked.push(TEST_LICENSE_KEY);
  r = await H.msg("licenseCheck");
  assert(r.ok && r.license && r.license.ok === false && r.license.reason === "revoked", "a revoked key locks at the check");
  const st = await H.waitFor(async () => { const s = await H.store("sx.state"); return s.status === "paused" ? s : null; }, "engine paused", 10000);
  assert(st.status === "paused", "the running engine is paused");
  await page.waitForSelector("#lockCard", { timeout: 10000 });
  assert(/turned off by your admin/.test(await page.locator("#licLead").innerText()), "the lock card says the key was turned off");

  // ---- server unreachable: grace ----
  M.license.revoked.length = 0;
  r = await H.msg("licenseCheck");
  assert(r.license.ok === true, "turned back on: the next check unlocks");
  M.license.mode = "down";
  r = await H.msg("licenseCheck");
  assert(r.license.ok === true, "server down: still working (3 days of grace from the last good check)");
  M.license.mode = "ok";
  const logs = JSON.stringify(await H.store("sx.logs"));
  assert(!logs.includes(TEST_LICENSE_KEY), "the license key never appears in the activity log");

  log(`\nLicense e2e: ${passCount()} checks passed`);
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await H.close();
  process.exit(failed ? 1 : 0);
}
