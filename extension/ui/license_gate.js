// ScoreX - the lock screen. Until a license key is active (lib/license.js) the dashboard and the popup show only this:
// a box for the key, Activate, and - after 3 days without reaching the license server - Check again. When the license
// changes in another window (activated, revoked at a check, removed) every open page reloads into the right view.
import { K } from "../lib/constants.js";
import { licenseState } from "../lib/license.js";
import { h } from "./components.js";

export async function currentLicense() {
  try { return (await chrome.storage.local.get(K.license))[K.license] || {}; } catch (_) { return {}; }
}
export const unlocked = (lic) => licenseState(lic).ok;

// Reload when the page's view (locked / unlocked) no longer matches the stored license.
export function watchLicense(wasUnlocked) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[K.license]) return;
    if (licenseState(changes[K.license].newValue || {}).ok !== wasUnlocked) location.reload();
  });
  // The 3-day grace can run out while a page stays open (no storage change): look again every minute.
  setInterval(() => { currentLicense().then((l) => { if (licenseState(l).ok !== wasUnlocked) location.reload(); }); }, 60000);
}

const ask = (sx, payload = {}) => chrome.runtime.sendMessage({ sx, ...payload }).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));

// The activation card. compact: the popup's small version.
export function lockCard(lic, { compact = false } = {}) {
  const st = licenseState(lic);
  const msg = h("p", { class: "lock-msg", id: "licMsg", role: "status", "aria-live": "polite" });
  const input = h("input", { class: "input mono lock-input", id: "licKey", type: "text", autocomplete: "off", spellcheck: "false", placeholder: "SCX-XXXX-XXXX-XXXX-XXXX", "aria-label": "License key", maxlength: "40" });
  const go = h("button", { type: "button", class: "btn btn-primary", id: "licActivate" }, "Activate");
  const say = (text, bad = true) => { msg.textContent = text || ""; msg.classList.toggle("lock-msg-bad", !!bad && !!text); };
  async function activate() {
    const key = input.value.trim();
    if (!key) { say("Paste your license key."); input.focus(); return; }
    go.disabled = true; say("Checking...", false);
    const r = await ask("licenseActivate", { key });
    go.disabled = false;
    if (r && r.ok) { say("Activated.", false); setTimeout(() => location.reload(), 300); return; }
    say((r && r.error) || "Activation failed.");
  }
  go.addEventListener("click", activate);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); activate(); } });
  const again = st.reason === "offline" || st.reason === "inactive" ? h("button", { type: "button", class: "btn", id: "licCheck", onClick: async (e) => {
    e.currentTarget.disabled = true; say("Checking...", false);
    const r = await ask("licenseCheck");
    if (r && r.ok && r.license && r.license.ok) { location.reload(); return; }
    e.currentTarget.disabled = false;
    say((r && r.license && r.license.message) || (r && r.error) || "Still not active.");
  } }, "Check again") : null;
  const lead = st.reason === "none" ? "Enter the license key you were given. A key works on one browser only." : st.message;
  return h("div", { class: ["lock-card", compact && "lock-card-compact"], id: "lockCard" },
    h("div", { class: "lock-brand" }, h("span", { class: "wordmark" }, "Score", h("span", { class: "wordmark-x", "aria-hidden": "true" }, "X"))),
    h("h1", { class: "lock-title" }, st.reason === "none" ? "Activate ScoreX" : "ScoreX is locked"),
    h("p", { class: "lock-lead", id: "licLead" }, lead),
    h("div", { class: "lock-row" }, input, go),
    again ? h("div", { class: "lock-row" }, again) : null,
    msg,
    h("p", { class: "lock-notice" }, "Sharing this without permission is strictly prohibited. A product of Unique Labs. Developed by Shahriar Ahmed."),
    compact ? null : h("p", { class: "lock-fine" }, "Only the key, a random install ID and the ScoreX version are sent to the license server. Ask your admin for a key, or for a reset when you move to a new computer."));
}

// Full page (dashboard): hide the app, show the card.
export function showLockPage(lic) {
  const app = document.getElementById("app");
  if (app) app.hidden = true;
  document.body.appendChild(h("main", { class: "lock-wrap", id: "lockPage" }, lockCard(lic)));
  document.title = "Activate · ScoreX";
  setTimeout(() => { const i = document.getElementById("licKey"); if (i) i.focus(); }, 50);
}
