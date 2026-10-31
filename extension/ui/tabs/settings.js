// Settings tab. Diagnostics first (quick check without the X tab + the live X test + a redacted report; #diagnostics
// shows every check), then the essentials: your X account, watch strategy (+ list URLs), comment window.
// Advanced (collapsed groups): mode/time zone/theme, watching details, review expiry, learning, cleanup
// (OFF by default, with a confirm), worker tab + debug + selector overrides, data import/export/reset.
// Score sites (Sorsa, TwitterScore, Ethos, Moni: keys, caps, the Sorsa blend) are set up on the Scores screen.

import { K, MODE, HARD, STATUS, STOP_LABEL } from "../../lib/constants.js";
import { PROVIDER_DEFS } from "../../lib/providerdefs.js";
import * as history from "../../lib/history.js";
import { sanitizeSettings } from "../../lib/store.js";
import { num } from "../../lib/util.js";
import { h, clear, fill, section, sub, advanced, btn, busy, toast, icon, selectEl, labeled, confirmDialog, confirmFullAuto, hasOpenaiKey, modal, download, readFileText, stamp, toggleEl, xLink, badge, fmtCount, uidShort, renderTable, add, diagSquare, fmtAgo, fmtTime, fmtUsd, fmtDateTime, announce } from "../components.js";
import { timeZones } from "./safety.js";

const DATA_PARTS = [
  ["settings", "Settings (never includes API keys)"],
  ["targets", "Targets"],
  ["candidates", "Discovery candidates"],
  ["history", "Comment history"],
  ["learning", "Learning / A/B data"],
];
const STRATEGIES = [
  ["list", "X List", "Best for many targets: one List page shows all their new posts.", true],
  ["search", "Batched Latest search", "Searches \"from:a OR from:b\" in Latest. No setup needed."],
  ["rotation", "Profile rotation", "Visits a few profiles per check. Slowest; fine for small lists."],
];


// ---------------------------------------------------------------- diagnostics

const DAY_MS = 864e5;
const LIVE_KEY = "sx.diag.live"; // last live X test result in this browser (state.lastSelfTest is preferred when newer)
const STATUS_WORD = { pass: "Pass", warn: "Warning", fail: "Failure", skip: "Not checked" };
const readLive = () => { try { const v = JSON.parse(window.localStorage.getItem(LIVE_KEY) || "null"); return v && Array.isArray(v.checks) ? v : null; } catch (_) { return null; } };
const writeLive = (v) => { try { window.localStorage.setItem(LIVE_KEY, JSON.stringify(v)); } catch (_) { /* storage blocked */ } };
const mb = (b) => (b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} KB` : (b / 1048576).toFixed(b >= 10485760 ? 0 : 1) + " MB");

// Provider site access, same rule as the health check: any usable mode with its hosts (+ scripting for tab modes) granted.
async function providerAccess(def, cfg) {
  const modes = Object.entries(def.modes || {}).filter(([m]) => !cfg || !cfg.mode || cfg.mode === "auto" || cfg.mode === m);
  if (!modes.length) return { ok: true, hosts: [] };
  let hosts = [];
  for (const [, m] of modes) {
    const origins = m.hosts || [];
    const perms = ["score", "smartFollowers"].some((c) => m[c] && m[c].kind === "tab") ? ["scripting"] : [];
    hosts = hosts.concat(origins);
    if (!origins.length && !perms.length) return { ok: true, hosts: [] };
    try { if (await chrome.permissions.contains({ origins, permissions: perms })) return { ok: true, hosts: origins }; } catch (_) { return { ok: true, hosts: origins }; }
  }
  return { ok: false, hosts };
}
const hostNames = (list) => [...new Set((list || []).map((o) => String(o).replace(/^https?:\/\//, "").replace(/\/\*$/, "")))].join(", ");

// The quick check (no X tab): [{ title, rows: [{ id, label, status: pass|warn|fail|skip, detail, action: [label, href] }] }].
async function quickCheck(ctx) {
  const s = ctx.settings, st = ctx.state, status = ctx.status || {};
  const rev = ctx.data[K.secretsRev] || {}, has = rev.has || {};
  const now = Date.now();
  const handle = String((s.account && s.account.handle) || "").replace(/^@+/, "");
  const me = st.me && st.me.handle ? String(st.me.handle).replace(/^@+/, "") : "";
  const R = (id, label, statusKind, detail, action) => ({ id, label, status: statusKind, detail, action: action || null });
  const groups = [];

  const x = [];
  x.push(handle ? R("handle", "Your X handle", "pass", "@" + handle) : R("handle", "Your X handle", "fail", "Not set: ScoreX cannot check follow-backs or which account is logged in.", ["Set handle", "#settings?focus=handle"]));
  if (me) {
    const same = handle && me.toLowerCase() === handle.toLowerCase();
    x.push(R("me", "Logged-in account", same ? "pass" : handle ? "fail" : "warn", `@${me} on x.com${st.me.checkedAt ? ` (checked ${fmtAgo(st.me.checkedAt)})` : ""}${handle && !same ? `; ScoreX expects @${handle}` : ""}`));
  } else x.push(R("me", "Logged-in account", "skip", "Not checked yet: read the next time the X tab loads a page, or run the live X test."));
  const fb = Number(st.followBadgeOkAt) || 0;
  if (fb && now - fb <= 3 * DAY_MS) x.push(R("badge", "\"Follows you\" badge", "pass", `Seen on your followers list ${fmtAgo(fb)} (trusted for 3 days)`));
  else if (fb) x.push(R("badge", "\"Follows you\" badge", "warn", `Last seen ${fmtAgo(fb)}: follow checks wait until it is seen again (run the live X test)`));
  else x.push(R("badge", "\"Follows you\" badge", st.firstStartedAt ? "warn" : "skip", "Not seen yet: follow checks start once the badge is seen on your followers list."));
  let ov = null;
  try { ov = (await chrome.storage.local.get(K.selectorOverrides))[K.selectorOverrides]; } catch (_) { ov = null; }
  const ovN = ov && typeof ov === "object" ? ["sel", "text", "misc"].reduce((a, g) => a + Object.keys(ov[g] || {}).length, 0) : 0;
  x.push(R("overrides", "Selector overrides", ovN ? "pass" : "skip", ovN ? `${ovN} override${ovN === 1 ? "" : "s"} active, merged over the built-in selectors` : "None active: the built-in selectors are used."));
  groups.push({ title: "X account and page", rows: x });

  const perm = [];
  const mf = chrome.runtime.getManifest();
  const req = mf.host_permissions || [];
  let reqOk = true, notif = true;
  try { reqOk = await chrome.permissions.contains({ origins: req }); } catch (_) { reqOk = true; }
  try { notif = await chrome.permissions.contains({ permissions: ["notifications"] }); } catch (_) { notif = true; }
  perm.push(R("hosts", hostNames(req) || "Required sites", reqOk ? "pass" : "fail", reqOk ? "Granted at install" : "Missing: allow site access for ScoreX in chrome://extensions"));
  perm.push(R("notifications", "Notifications", notif ? "pass" : "warn", notif ? "Granted: safety stops show a desktop notification" : "Not granted: safety stops only show in the dashboard and the badge"));
  for (const [id, def] of Object.entries(PROVIDER_DEFS)) {
    const cfg = (s.providers || {})[id];
    if (!cfg || !cfg.enabled) { perm.push(R("p_" + id, `${def.name} (optional)`, "skip", "Not connected", ["Connect", "#scores?view=providers"])); continue; }
    const a = await providerAccess(def, cfg);
    perm.push(R("p_" + id, `${def.name} (optional)`, a.ok ? "pass" : "warn", a.ok ? `${hostNames(a.hosts) || "No site access needed"}${a.hosts.length ? " granted" : ""}` : `Site access not granted (${hostNames(a.hosts)})`, a.ok ? null : ["Fix", "#scores?view=providers"]));
  }
  groups.push({ title: "Permissions", rows: perm });

  const ai = [];
  // sx.secretsRev changes the moment a key is saved or removed (the status poll lags); without it the stored secrets
  // are asked (presence only).
  const hasOpenai = (await hasOpenaiKey(ctx.data[K.secretsRev])) ?? (typeof status.hasApiKey === "boolean" ? status.hasApiKey : null);
  ai.push(hasOpenai === false ? R("openai", "OpenAI key", "fail", "Missing: ScoreX cannot write replies.", ["Add key", "#models"]) : hasOpenai ? R("openai", "OpenAI key", "pass", "Saved (the key itself never leaves this browser except to OpenAI)") : R("openai", "OpenAI key", "skip", "Unknown"));
  for (const [id, def] of Object.entries(PROVIDER_DEFS)) {
    const cfg = (s.providers || {})[id];
    if (!cfg || !cfg.enabled || !def.keyName) continue;
    const k = has[def.keyName];
    ai.push(R("k_" + id, `${def.name} key`, k ? "pass" : "skip", k ? "Saved" : "Not saved (optional): modes that need no key still work", k ? null : ["Add key", "#scores?view=providers"]));
  }
  const budget = num(s.budget && s.budget.monthlyUsd);
  const month = status.month || null;
  ai.push(budget > 0
    ? R("budget", "Monthly budget", month && month.reached ? "fail" : month && month.warn ? "warn" : "pass", `${fmtUsd(budget)}${month && month.pct != null ? ` · ${Math.round(num(month.pct))}% used` : ""}${month && month.reached ? " · reached: replies are paused" : ""}`)
    : R("budget", "Monthly budget", "skip", "No limit set", ["Set budget", "#models"]));
  groups.push({ title: "AI and budget", rows: ai });

  const eng = [];
  const running = st.status === STATUS.RUNNING;
  const lastTxt = st.lastTickAt ? `Last check ${fmtAgo(st.lastTickAt)}` : "No check yet";
  const nextTxt = running && st.nextTickAt ? ` · next ${fmtTime(st.nextTickAt)}` : "";
  if (running && st.nextTickAt && now - st.nextTickAt > 10 * 60000) eng.push(R("tick", "Scheduler", "warn", `${lastTxt}; the check planned for ${fmtTime(st.nextTickAt)} did not run: the scheduler may be stuck (Pause, then Resume)`));
  else eng.push(R("tick", "Scheduler", running ? "pass" : "skip", `${lastTxt}${nextTxt}${running ? "" : ` · engine ${st.status || "stopped"}`}`));
  const job = st.job;
  if (job && job.kind) {
    const expired = job.leaseUntil && job.leaseUntil < now;
    eng.push(R("lease", "Job lease", expired ? "warn" : "pass", `${job.kind}${job.step ? " (" + job.step + ")" : ""} since ${fmtTime(job.startedAt)}${job.leaseUntil ? `${expired ? ", lease ran out at " : ", lease until "}${fmtTime(job.leaseUntil)}` : ""}${expired ? ": cleaned up on the next check" : ""}`));
  } else eng.push(R("lease", "Job lease", "pass", "Free: no job holds the X tab"));
  let used = null, recs = null, schema = null;
  try { used = await chrome.storage.local.getBytesInUse(null); } catch (_) { used = null; }
  try { recs = await history.count(); } catch (_) { recs = null; }
  try { schema = (await chrome.storage.local.get(K.schema))[K.schema]; } catch (_) { schema = null; }
  const quota = 10 * 1048576;
  if (used != null) eng.push(R("storage", "Storage", used >= quota * 0.9 ? "fail" : used >= quota * 0.7 ? "warn" : "pass", `chrome.storage ${mb(used)} of 10 MB${recs != null ? ` · history ${recs.toLocaleString()} records` : ""}`));
  else eng.push(R("storage", "Storage", "skip", recs != null ? `history ${recs.toLocaleString()} records` : "Unknown"));
  eng.push(R("version", "Version", "pass", `ScoreX ${mf.version}${schema != null ? ` · data schema ${schema}` : ""}`));
  groups.push({ title: "Engine and storage", rows: eng });
  return { at: now, groups };
}

const redactText = (text, own) => String(text == null ? "" : text)
  .replace(/sk-[A-Za-z0-9_-]{6,}/g, "sk-[redacted]")
  .replace(/@([A-Za-z0-9_]{1,15})/g, (m, hd) => (own && hd.toLowerCase() === own.toLowerCase() ? m : "@[account]"));

// Diagnostics section. full: every check (#diagnostics); otherwise only warnings and failures plus a link.
function diagnosticsSection(ctx, { full = false } = {}) {
  let quick = null;
  // The last live test: the worker saves it in state.lastSelfTest (any browser window); this browser's copy is the fallback.
  const fromState = () => { const v = ctx.data[K.state] && ctx.data[K.state].lastSelfTest; return v && Array.isArray(v.checks) ? { at: v.at, checks: v.checks, stop: v.stop || null } : null; };
  const newer = (a, b) => (!a ? b : !b ? a : (Number(b.at) || 0) > (Number(a.at) || 0) ? b : a);
  let live = newer(readLive(), fromState());
  let liveRunning = false;
  const head = h("div", { class: "diag-head", id: "diagHead" });
  const rowsHost = h("div", { class: "dg-list", id: "diagList" });
  const liveHost = h("div", { class: "dg-list", id: "diagLive", "aria-live": "polite" });
  const own = () => String((ctx.settings.account && ctx.settings.account.handle) || "").replace(/^@+/, "");

  const quickBtn = btn("Run quick check", (e) => busy(e.currentTarget, async () => { await runQuick(); announce(summaryText()); }), { iconName: "refresh", id: "diagQuickBtn", title: "Checks permissions, keys, storage and the scheduler. Does not use the X tab." });
  const liveBtn = btn("Run live X test", (e) => busy(e.currentTarget, runLive), { kind: "primary", iconName: "play", id: "diagLiveBtn", title: "Uses the X tab for about 30 seconds. It only reads pages: it never clicks, likes or types." });
  const copyBtn = btn("Copy report", () => copyReport(), { kind: "ghost", iconName: "copy", id: "diagCopyBtn", title: "Copies a JSON report without API keys or other accounts' handles" });

  const counts = () => {
    const all = [...(quick ? quick.groups.flatMap((g) => g.rows) : []), ...(live ? live.checks.map((c) => ({ status: c.ok ? "pass" : "fail" })) : [])];
    return { warn: all.filter((r) => r.status === "warn").length, fail: all.filter((r) => r.status === "fail").length, n: all.length };
  };
  const summaryText = () => { const c = counts(); return `${c.warn} warning${c.warn === 1 ? "" : "s"}, ${c.fail} failure${c.fail === 1 ? "" : "s"}`; };
  // The buttons are built once (a redraw never takes focus away from them); only the summary is refreshed.
  const sumHost = h("div", { class: "diag-sum" });
  add(head, sumHost, h("div", { class: "diag-actions" }, quickBtn, liveBtn, copyBtn));
  function drawHead() {
    const c = counts();
    const worst = c.fail ? "fail" : c.warn ? "warn" : quick ? "pass" : "skip";
    fill(sumHost,
      diagSquare(worst, STATUS_WORD[worst]),
      h("strong", { id: "diagSummary" }, quick ? summaryText() : "Checking…"),
      h("span", { class: "muted small" }, `quick check ${quick ? fmtAgo(quick.at) : "-"} · live X test ${live && live.at ? fmtAgo(live.at) : "not run yet"}`));
  }
  const dgRow = (r) => h("div", { class: "dg", dataset: { check: r.id, status: r.status } },
    diagSquare(r.status, STATUS_WORD[r.status]),
    h("div", { class: "dg-name" }, r.label),
    h("div", { class: "dg-detail" }, r.detail || ""),
    h("div", { class: "dg-act" }, r.action ? h("a", { class: "btn btn-sm", href: r.action[1] }, r.action[0]) : null));
  function drawRows() {
    if (!quick) { fill(rowsHost, h("p", { class: "muted small" }, "Running the quick check…")); return; }
    if (full) { fill(rowsHost, quick.groups.map((g) => [h("h3", { class: "dg-group" }, g.title), g.rows.map(dgRow)])); return; }
    const issues = quick.groups.flatMap((g) => g.rows).filter((r) => r.status === "warn" || r.status === "fail");
    const total = quick.groups.reduce((a, g) => a + g.rows.length, 0);
    fill(rowsHost,
      issues.length ? issues.map(dgRow) : h("p", { class: "muted small dg-allok" }, `No problems in the quick check (${total} checks).`),
      h("p", { class: "small" }, h("a", { href: "#diagnostics", id: "diagAllLink" }, `See all ${total} checks and the live X test`), " →"));
  }
  function drawLive() {
    if (liveRunning) {
      fill(liveHost, h("h3", { class: "dg-group" }, "Live X test"),
        h("div", { class: "dg" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("div", { class: "dg-name" }, "Running…"), h("div", { class: "dg-detail" }, "The X tab opens your home timeline, your profile and your followers list (about 30 s). It never clicks, likes or types."), h("div", { class: "dg-act" })));
      return;
    }
    if (!live) {
      fill(liveHost, full ? [h("h3", { class: "dg-group" }, "Live X test"), h("p", { class: "muted small dg-note" }, "Not run yet. It uses the X tab for about 30 seconds and only reads pages: it never clicks, likes or types, and it stops at the first captcha or warning.")] : []);
      return;
    }
    const rows = live.error ? [{ id: "live", label: "Live X test", status: "fail", detail: live.error }]
      : live.checks.map((c) => ({ id: "live_" + c.id, label: c.label || c.id, status: c.ok ? "pass" : "fail", detail: c.detail || "" }));
    if (live.stop) rows.push({ id: "live_stop", label: "Safety stop", status: "fail", detail: `${STOP_LABEL[live.stop] || live.stop}: the test stopped there and ScoreX stopped for safety.` });
    const failed = rows.filter((r) => r.status === "fail").length;
    if (!full && !failed) { fill(liveHost, []); return; }
    fill(liveHost, h("h3", { class: "dg-group" }, `Live X test · ${live.at ? fmtDateTime(live.at) : ""}`), (full ? rows : rows.filter((r) => r.status === "fail")).map(dgRow));
  }
  let quickHadStatus = false;
  async function runQuick() {
    quickHadStatus = !!ctx.status;
    try { quick = await quickCheck(ctx); } catch (e) { console.error("[ScoreX UI] quick check", e); quick = { at: Date.now(), groups: [{ title: "Quick check", rows: [{ id: "error", label: "Quick check", status: "fail", detail: String((e && e.message) || e) }] }] }; }
    drawHead(); drawRows();
  }
  async function runLive() {
    if (!(ctx.settings.account && String(ctx.settings.account.handle || "").trim())) { toast("Set your X handle first (Your X account, below).", { type: "warn" }); return; }
    liveRunning = true; drawLive();
    announce("Live X test started. It takes about 30 seconds.");
    const r = await ctx.send("selfTest", {}, { raw: true, quiet: true, label: "Live X test" });
    liveRunning = false;
    // Stopped by Pause/Stop: not a test result. The last complete test stays shown and saved (the worker does not keep
    // the partial run either).
    if (r && r.aborted) {
      drawHead(); drawLive();
      announce("Live X test stopped by Pause/Stop before it finished.");
      toast("Live X test stopped by Pause/Stop before it finished. The last complete test is still shown.", { type: "info" });
      return;
    }
    live = r && r.ok !== false && Array.isArray(r.checks) ? { at: r.at || Date.now(), checks: r.checks, stop: r.stop || null } : { at: Date.now(), checks: [], error: (r && r.error) || "No answer from the background worker." };
    writeLive(live);
    drawHead(); drawLive();
    const failed = live.error ? 1 : live.checks.filter((c) => !c.ok).length + (live.stop ? 1 : 0);
    announce(`Live X test finished: ${failed ? failed + " failed" : "all checks passed"}.`);
    toast(live.error ? `Live X test: ${live.error}` : failed ? `Live X test: ${failed} check${failed === 1 ? "" : "s"} failed` : "Live X test: all checks passed", { type: live.error || failed ? "warn" : "success" });
    ctx.refreshHealth();
  }
  async function copyReport() {
    if (!quick) await runQuick();
    const s = ctx.settings, st = ctx.state, me = own();
    const report = {
      app: "ScoreX", version: chrome.runtime.getManifest().version, generatedAt: new Date().toISOString(),
      note: "Redacted: no API keys, no other accounts' handles.",
      summary: summaryText(),
      quickCheck: quick ? { at: new Date(quick.at).toISOString(), groups: quick.groups.map((g) => ({ group: g.title, checks: g.rows.map((r) => ({ id: r.id, status: r.status, label: redactText(r.label, me), detail: redactText(r.detail, me) })) })) } : null,
      liveTest: live ? { at: live.at ? new Date(live.at).toISOString() : null, error: live.error ? redactText(live.error, me) : undefined, stop: live.stop || null, checks: live.checks.map((c) => ({ id: c.id, ok: !!c.ok, label: redactText(c.label, me), detail: redactText(c.detail, me) })) } : null,
      engine: { status: st.status, stopReason: st.stopReason || null, mode: s.mode, watchStrategy: s.watch && s.watch.strategy, workerTab: s.advanced && s.advanced.tabMode, debug: !!(s.advanced && s.advanced.debug) },
      limits: { ramp: s.safety.ramp, accountsPerDay: s.safety.accountsPerDay, perTargetDay: s.safety.perTargetDay, gapMin: s.safety.gapMin, activeHours: !!s.safety.activeHours.enabled, maxPageLoads24h: s.safety.maxPageLoads24h },
      counts: { targets: ctx.targetList().length, pending: ctx.counts.pending, queued: ctx.counts.queued },
    };
    const text = JSON.stringify(report, null, 2);
    try { await navigator.clipboard.writeText(text); toast("Diagnostics report copied (no keys)", { type: "success" }); }
    catch (_) { download(`scorex-diagnostics-${stamp()}.json`, text, "application/json"); toast("Clipboard blocked: the report was downloaded instead.", { type: "warn" }); }
  }

  const sec = section({ wide: true, className: "diag-sec", id: "diagnostics", title: full ? "Diagnostics" : "Diagnostics", hint: full ? "A quick check (no X tab) and a live test of the X pages ScoreX reads. Use Copy report when you ask for help." : "Problems found by the quick check. It does not use the X tab." },
    head, rowsHost, liveHost,
    h("p", { class: "muted small dg-note" }, "The live X test uses the X tab for about 30 seconds. It only reads pages: it never clicks, likes or types."));
  drawHead(); drawRows(); drawLive();
  sec.runQuick = runQuick;
  ctx.on(K.state, () => { if (quick) drawHead(); });
  ctx.on("tick", () => { drawHead(); });
  ctx.on("status", () => { if (quick && !quickHadStatus && ctx.status) runQuick(); }); // first status: key, budget use
  ctx.on("secrets", () => { if (quick) runQuick(); });
  return sec;
}

export default {
  id: "settings",
  title: "Settings",
  hint: "Diagnostics, your account, how new posts are found, and everything else under Advanced.",
  async render(root, ctx) {
    const f = (spec) => ctx.field(spec);

    // ------------------------------------------------ account & general
    const themeSel = selectEl([["system", "System"], ["light", "Light"], ["dark", "Dark"]], (window.sxTheme && window.sxTheme.get()) || "system", { id: "themeSelect" });
    themeSel.addEventListener("change", () => {
      if (window.sxTheme) window.sxTheme.set(themeSel.value);
      ctx.save((d) => { d.ui = { ...(d.ui || {}), theme: themeSel.value }; });
    });
    const onTheme = (e) => { if (themeSel.isConnected && e && e.detail) themeSel.value = e.detail.pref; };
    window.addEventListener("sx-theme", onTheme);
    ctx.onDispose(() => window.removeEventListener("sx-theme", onTheme));
    // Mode goes through the Full-auto confirm (switchMode); a cancelled confirm puts the select back.
    const modeSel = selectEl([[MODE.REVIEW, "Review"], [MODE.AUTO, "Full auto"]], ctx.settings.mode === MODE.AUTO ? MODE.AUTO : MODE.REVIEW, { id: "settingsMode" });
    modeSel.addEventListener("change", async () => {
      await ctx.setMode(modeSel.value);
      modeSel.value = ctx.settings.mode === MODE.AUTO ? MODE.AUTO : MODE.REVIEW;
    });
    ctx.addRefresher((st) => { if (!modeSel.isConnected) return false; if (document.activeElement !== modeSel) modeSel.value = st.mode === MODE.AUTO ? MODE.AUTO : MODE.REVIEW; return true; });

    const accountSec = section({ title: "Your X account", hint: "The account ScoreX acts as. It stops if another one is logged in." },
      h("div", { class: "form-row" },
        f({ path: "account.handle", type: "text", label: "Your X handle", placeholder: "your_handle", hint: "Without @" }),
        f({ path: "account.verifyAccount", type: "toggle", label: "Stop if a different account is logged in" })));
    const generalSec = section({ hint: h("span", null, "Mode is also on ", h("a", { href: "#overview" }, "Today"), " and in the top bar; the time zone is also in ", h("a", { href: "#safety" }, "Safety"), "; the theme is in the top bar.") },
      h("div", { class: "form-row" },
        labeled("Mode", modeSel, "Full auto asks first"),
        f({ path: "timezone", type: "select", label: "Time zone", options: timeZones(ctx.settings.timezone), hint: "Active hours, daily limits, dates" }),
        labeled("Theme", themeSel)));

    // ------------------------------------------------ watch
    const strategyHost = h("div", { class: "radio-cards", role: "radiogroup", "aria-label": "Watch strategy" });
    const listUrls = f({ path: "watch.listUrls", type: "list", label: "X List URLs", rows: 3, placeholder: "https://x.com/i/lists/1234567890", hint: "One per line. Private lists work too." });
    function drawStrategy() {
      const cur = ctx.settings.watch.strategy;
      clear(strategyHost);
      for (const [v, title, desc, rec] of STRATEGIES) {
        const id = uidShort("ws_");
        const input = h("input", { type: "radio", name: "watchStrategy", id, value: v, checked: v === cur });
        input.addEventListener("change", () => { if (input.checked) ctx.save((d) => { d.watch.strategy = v; }); });
        strategyHost.appendChild(h("label", { class: ["radio-card", v === cur && "active"], for: id }, input,
          h("div", null, h("div", { class: "radio-title" }, title, rec ? badge("best", "green") : null), h("div", { class: "muted small" }, desc))));
      }
      listUrls.hidden = cur !== "list";
    }
    const watchSec = section({ title: "Watching for new posts", hint: "How ScoreX finds fresh posts from your targets." },
      strategyHost,
      listUrls);
    const windowSec = section({ title: "Comment window", hint: "New posts get a reply this many minutes after they appear. Early replies get seen most." },
      h("div", { class: "form-row" },
        f({ path: "watch.minPostAgeMin", type: "number", label: "From (min)", min: 0, max: 30, hint: "Never instantly" }),
        f({ path: "watch.maxPostAgeMin", type: "number", label: "Until (min)", min: 5, max: 180 })),
      f({ path: "watch.catchUp.enabled", type: "toggle", label: "Also comment on each account's latest earlier posts (catch-up)", hint: "Posts from before ScoreX ran, or that it missed. Uses the posts already read from their profiles; every limit still applies, and new posts always go first." }),
      h("div", { class: "form-row" },
        f({ path: "watch.catchUp.perTarget", type: "number", label: "Latest posts per account", min: 1, max: 3 }),
        f({ path: "watch.catchUp.maxAgeHours", type: "number", label: "Not older than (hours)", min: 1, max: 168 })));
    const watchMoreSec = section({ hint: "Fine-tuning for the search and rotation strategies." },
      h("div", { class: "form-row" },
        f({ path: "watch.searchBatchSize", type: "number", label: "Search batch size", min: 1, max: 20, hint: "Targets per search (search mode)" }),
        f({ path: "watch.rotationPerTick", type: "number", label: "Profiles per check", min: 1, max: 6, hint: "Rotation mode" }),
        f({ path: "watch.checkIntervalSec.min", type: "number", label: "Check every, min (s)", min: HARD.minCheckIntervalSec, max: 3600, step: 10, hint: `At least ${HARD.minCheckIntervalSec} s` }),
        f({ path: "watch.checkIntervalSec.max", type: "number", label: "Check every, max (s)", min: HARD.minCheckIntervalSec, max: 3600, step: 10 })),
      f({ path: "watch.includeQuotes", type: "toggle", label: "Include quote posts" }));

    // ------------------------------------------------ review + learning
    const reviewSec = section({ hint: "When pending items expire and how many may wait." },
      h("div", { class: "form-row" },
        f({ path: "review.pendingMaxAgeMin", type: "number", label: "Pending items expire after (min)", min: 10, max: 1440 }),
        f({ path: "review.approvedMaxAgeMin", type: "number", label: "Approved items expire after (min)", min: 10, max: 1440 }),
        f({ path: "review.maxPending", type: "number", label: "Max waiting for review", min: 1, max: 200, hint: "Generation pauses here" })),
      f({ path: "review.notifyNew", type: "toggle", label: "Desktop notification for new items" }));

    const learningSec = section({ hint: "Tracks follow-backs and responses to adjust priorities and tiers.", actions: btn("Run learning now", (e) => { const b = e.currentTarget; busy(b, async () => { const r = await ctx.send("learningRun", {}, { label: "Learning" }); if (r) toast("Learning run started", { type: "success" }); }); }, { size: "sm", iconName: "refresh" }) },
      h("div", { class: "toggle-grid" },
        f({ path: "learning.enabled", type: "toggle", label: "Learning on" }),
        f({ path: "learning.autoTierUp", type: "toggle", label: "Move responsive accounts up a tier" })),
      h("div", { class: "form-grid" },
        f({ path: "learning.coldAfterComments", type: "number", label: "Cool down after N comments without response", min: 2, max: 50 }),
        f({ path: "learning.coldCooldownDays", type: "number", label: "Cool-down length (days)", min: 1, max: 90 }),
        f({ path: "learning.engagementCheckAfterHours", type: "number", label: "Check reply engagement after (hours)", min: 1, max: 720 }),
        f({ path: "learning.maxChecksPerRun", type: "number", label: "Max checks per run", min: 0, max: 10 })),
      sub("Replies to you",
        h("div", { class: "form-row" },
          f({ path: "learning.conversations.enabled", type: "toggle", label: "Check my mentions for replies from accounts I comment on", id: "convEnabled", hint: "They show under Needs you on Today and in the popup." }),
          f({ path: "learning.conversations.everyMin", type: "number", label: "Check every (min)", min: 15, max: 240, id: "convEvery" }))));

    // ------------------------------------------------ cleanup
    const cleanupToggle = toggleEl("Unfollow accounts that don't follow back", ctx.settings.cleanup.enabled, async (v, input) => {
      if (v) {
        const ok = await confirmDialog(`ScoreX will unfollow accounts you followed more than ${ctx.settings.cleanup.afterDays} days ago that still don't follow you back (max ${ctx.settings.cleanup.dailyLimit} per day, whitelist respected). Turn it on?`, { title: "Turn on cleanup", okLabel: "Turn on" });
        if (!ok) { input.checked = false; return; }
      }
      ctx.save((d) => { d.cleanup.enabled = v; });
    }, { id: "cleanupEnabled" });
    ctx.addRefresher((s) => { if (!cleanupToggle.isConnected) return false; cleanupToggle.input.checked = !!s.cleanup.enabled; return true; });
    const cleanupSec = section({ hint: "Off by default. Only touches accounts you follow that never followed back.", actions: btn("Preview unfollows", (e) => {
      const b = e.currentTarget;
      busy(b, async () => {
        const r = await ctx.send("cleanupPreview", {}, { label: "Cleanup preview" });
        if (!r) return;
        const list = (Array.isArray(r.candidates) ? r.candidates : []).map((c) => (typeof c === "string" ? { handle: c } : c || {}));
        modal({
          title: `Cleanup preview (${list.length})`, wide: true,
          body: list.length ? renderTable({
            columns: [
              { key: "handle", label: "Account", render: (c) => xLink(c.handle) },
              { key: "name", label: "Name" },
              { key: "followers", label: "Followers", align: "right", render: (c) => fmtCount(c.followers != null ? c.followers : null) },
              { key: "since", label: "Followed for", render: (c) => (c.youFollowSince || c.since ? `${Math.floor((Date.now() - (c.youFollowSince || c.since)) / 864e5)} days` : "-") },
              { key: "reason", label: "Why", render: (c) => c.reason || "No follow-back" },
            ],
            rows: list, rowKey: (c) => c.handle, sortState: {},
          }) : h("p", null, "Nobody would be unfollowed with the current settings."),
        });
      });
    }, { size: "sm", iconName: "eye", id: "cleanupPreviewBtn" }) },
      h("div", { class: "toggle-grid" },
        h("div", { class: "field field-check" }, cleanupToggle),
        f({ path: "cleanup.protectTier1", type: "toggle", label: "Never unfollow tier 1 targets" })),
      h("div", { class: "form-row" },
        f({ path: "cleanup.afterDays", type: "number", label: "Only after (days)", min: 7, max: 365, hint: "Minimum 7" }),
        f({ path: "cleanup.dailyLimit", type: "number", label: "Max unfollows per day", min: 0, max: HARD.dailyUnfollows, hint: `Cap ${HARD.dailyUnfollows}` })),
      f({ path: "cleanup.whitelist", type: "list", label: "Never unfollow (whitelist)", rows: 3, placeholder: "@friend\n@brand" }));

    // ------------------------------------------------ advanced
    const ovText = h("textarea", { class: "input mono", rows: 8, id: "selectorOverrides", spellcheck: "false", placeholder: '{\n  "sel": { "likeButton": ["[data-testid=\\"like\\"]"] }\n}' });
    const ovStatus = h("div", { class: "small", id: "overrideStatus", "aria-live": "polite" });
    const loadOverrides = async () => {
      try {
        const r = await chrome.storage.local.get(K.selectorOverrides);
        const v = r[K.selectorOverrides];
        ovText.value = v && Object.keys(v).length ? JSON.stringify(v, null, 2) : "";
        ovStatus.className = "small muted";
        ovStatus.textContent = v && Object.keys(v).length ? "Overrides active." : "No overrides - the built-in selectors are used.";
      } catch (e) { ovStatus.textContent = "Could not load overrides: " + e.message; }
    };
    const validate = () => {
      const raw = ovText.value.trim();
      if (!raw) return { ok: true, value: null };
      let v;
      try { v = JSON.parse(raw); } catch (e) { return { ok: false, error: "Not valid JSON: " + e.message }; }
      if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "The overrides must be a JSON object, e.g. {\"sel\": {...}}." };
      const allowed = new Set(["sel", "text", "misc", "version"]);
      const bad = Object.keys(v).filter((k) => !allowed.has(k));
      if (bad.length) return { ok: false, error: `Unknown top-level key(s): ${bad.join(", ")}. Use sel, text or misc.` };
      for (const grp of ["sel", "text", "misc"]) {
        if (v[grp] != null && (typeof v[grp] !== "object" || Array.isArray(v[grp]))) return { ok: false, error: `"${grp}" must be an object of named entries, e.g. {"${grp}": {"likeButton": ...}}.` };
      }
      // dashboard.html loads content/selectors.js, so the built-in keys are known here.
      const known = globalThis.SX_SELECTORS ? { sel: Object.keys(globalThis.SX_SELECTORS.sel), text: Object.keys(globalThis.SX_SELECTORS.text) } : null;
      const unknown = known ? Object.keys(v.sel || {}).filter((k) => !known.sel.includes(k)).concat(Object.keys(v.text || {}).filter((k) => !known.text.includes(k))) : [];
      if (unknown.length) return { ok: false, error: `Unknown selector key(s): ${unknown.join(", ")}. Check the spelling against content/selectors.js.` };
      const frag = document.createDocumentFragment();
      for (const [k, list] of Object.entries(v.sel || {})) {
        for (const sel of Array.isArray(list) ? list : [list]) {
          if (typeof sel !== "string") return { ok: false, error: `sel.${k}: selectors must be strings.` };
          try { frag.querySelector(sel); } catch (_) { return { ok: false, error: `sel.${k}: invalid CSS selector "${sel}".` }; }
        }
      }
      for (const grp of ["text", "misc"]) {
        for (const [k, src] of Object.entries(v[grp] || {})) {
          if (typeof src !== "string") return { ok: false, error: `${grp}.${k}: must be a regular expression string.` };
          try { new RegExp(src, "i"); } catch (e) { return { ok: false, error: `${grp}.${k}: invalid regular expression (${e.message}).` }; }
        }
      }
      return { ok: true, value: v };
    };
    const showValidation = (r) => {
      ovStatus.className = "small " + (r.ok ? "text-green" : "text-red");
      ovStatus.textContent = r.ok ? (r.value ? "Valid JSON. Not saved yet." : "Empty: saving removes all overrides.") : r.error;
    };
    const workerSec = section({ title: "Worker tab and debugging" },
      h("div", { class: "form-grid" },
        f({ path: "advanced.tabMode", type: "select", label: "Worker tab", options: [["pinned", "Pinned tab in this window"], ["window", "Separate window (keep it visible)"]], format: (v) => v || "pinned", hint: "Use a visible window if X does not render in a background tab." }),
        f({ path: "advanced.debug", type: "toggle", label: "Debug logging", hint: "More detail in Recent activity. Keys are always redacted." })));
    const selectorsSec = section({ title: "Selector overrides", hint: "Patch selectors when X changes its page (\"X page changed\" stop). Same shape as content/selectors.js; merged over the built-in values." },
      labeled("Overrides JSON", ovText),
      ovStatus,
      h("div", { class: "toolbar" },
        btn("Validate", () => showValidation(validate()), { id: "ovValidate" }),
        btn("Save overrides", async () => {
          const r = validate();
          showValidation(r);
          if (!r.ok) return;
          try {
            if (r.value) await chrome.storage.local.set({ [K.selectorOverrides]: r.value });
            else await chrome.storage.local.remove(K.selectorOverrides);
            toast(r.value ? "Selector overrides saved" : "Selector overrides removed", { type: "success" });
            loadOverrides();
          } catch (e) { toast("Could not save: " + e.message, { type: "error" }); }
        }, { kind: "primary", id: "ovSave" }),
        btn("Reset to built-in", async () => {
          if (!(await confirmDialog("Remove all selector overrides and use the built-in selectors?", { title: "Reset selectors", okLabel: "Reset", danger: true }))) return;
          await chrome.storage.local.remove(K.selectorOverrides);
          toast("Selector overrides removed");
          loadOverrides();
        }, { kind: "ghost", id: "ovReset" })));

    // ------------------------------------------------ data
    const partBoxes = DATA_PARTS.map(([k, label]) => {
      const id = uidShort("p_");
      const cb = h("input", { type: "checkbox", id, checked: true, value: k });
      return { k, cb, el: h("label", { class: "chip", for: id }, cb, h("span", null, label)) };
    });
    const parts = () => partBoxes.filter((p) => p.cb.checked).map((p) => p.k);
    const importFile = h("input", { type: "file", accept: ".json,application/json", class: "sr-only", id: "importDataFile" });
    importFile.addEventListener("change", async () => {
      const file = importFile.files && importFile.files[0];
      importFile.value = "";
      if (!file) return;
      let data;
      try { data = JSON.parse(await readFileText(file)); } catch (e) { toast("That file is not valid JSON: " + e.message, { type: "error" }); return; }
      const sel = parts();
      if (!sel.length) { toast("Pick at least one part to import.", { type: "warn" }); return; }
      // A backup never switches on Full auto or cleanup (unfollows) by itself: each asks its own confirm first, and
      // Cancel imports the rest with your current choice.
      const cur = ctx.settings;
      const inc = sel.includes("settings") && data && data.settings && typeof data.settings === "object" ? sanitizeSettings(data.settings) : null;
      const toAuto = !!inc && inc.mode === MODE.AUTO && cur.mode !== MODE.AUTO;
      const toReview = !!inc && inc.mode !== MODE.AUTO && cur.mode === MODE.AUTO;
      const cleanupOn = !!inc && !!inc.cleanup.enabled && !cur.cleanup.enabled;
      const cleanupOff = !!inc && !inc.cleanup.enabled && !!cur.cleanup.enabled;
      const changes = [
        toAuto && "switch to Full auto (you confirm that next; Cancel keeps Review)",
        toReview && "switch to Review mode",
        cleanupOn && "turn on cleanup, which unfollows accounts (you confirm that next; Cancel keeps it off)",
        cleanupOff && "turn cleanup off",
      ].filter(Boolean);
      const msg = `Import ${sel.join(", ")} from ${file.name}? Existing data of those parts is replaced or merged by the worker. API keys are never imported.${changes.length ? ` The backup's settings would ${changes.join(" and ")}.` : ""}`;
      if (!(await confirmDialog(msg, { title: "Import data", okLabel: "Import" }))) return;
      let payload = data;
      if (toAuto || cleanupOn) {
        const next = { ...data.settings };
        if (toAuto && !(await confirmFullAuto({ settings: inc, state: ctx.state }))) next.mode = cur.mode;
        if (cleanupOn && !(await confirmDialog(`ScoreX will unfollow accounts you followed more than ${inc.cleanup.afterDays} days ago that still don't follow you back (max ${inc.cleanup.dailyLimit} per day, whitelist respected). Turn it on?`, { title: "Turn on cleanup", okLabel: "Turn on", cancelLabel: "Keep it off" }))) next.cleanup = { ...(next.cleanup || {}), enabled: false };
        payload = { ...data, settings: next };
      }
      const r = await ctx.send("importData", { data: payload, parts: sel }, { label: "Import" });
      if (r) ctx.refreshStatus();
      if (r) toast("Imported: " + (typeof r.imported === "object" && r.imported ? Object.entries(r.imported).map(([k, v]) => (v === true ? k : `${k} (${v})`)).join(", ") || "nothing" : String(r.imported != null ? r.imported : "done")), { type: "success" });
    });
    const dataSec = section({ title: "Backup", hint: "Backups never include your API keys." },
      h("div", { class: "field" }, h("div", { class: "field-label" }, "Parts for export / import"), h("div", { class: "chip-select" }, partBoxes.map((p) => p.el))),
      h("div", { class: "toolbar" },
        btn("Export settings JSON", () => {
          const out = JSON.parse(JSON.stringify(ctx.settings));
          download(`scorex-settings-${stamp()}.json`, JSON.stringify({ app: "ScoreX", kind: "settings", exportedAt: new Date().toISOString(), settings: out }, null, 2), "application/json");
        }, { iconName: "download", id: "exportSettingsBtn" }),
        btn("Export everything", (e) => {
          const b = e.currentTarget;
          busy(b, async () => {
            const sel = parts();
            if (!sel.length) { toast("Pick at least one part.", { type: "warn" }); return; }
            const r = await ctx.send("exportData", { parts: sel }, { label: "Export" });
            if (r) download(`scorex-backup-${stamp()}.json`, JSON.stringify(r.data, null, 2), "application/json");
          });
        }, { iconName: "download", id: "exportAllBtn" }),
        h("label", { class: "btn", for: "importDataFile", tabindex: "0", onKeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); importFile.click(); } } }, icon("upload"), h("span", null, "Import JSON…")),
        importFile,
        btn("Export history CSV", async () => {
          try {
            const recs = (await history.all()).sort((a, b) => b.createdAt - a.createdAt);
            if (!recs.length) { toast("History is empty.", { type: "warn" }); return; }
            download(`scorex-history-${stamp()}.csv`, history.toCsvText(recs), "text/csv");
          } catch (e) { toast("Could not read history: " + e.message, { type: "error" }); }
        }, { iconName: "download" })));
    const resetSec = section({ title: "Reset", hint: "Stops the engine and deletes settings, targets, candidates, history, logs, learning data and selector overrides. API keys are kept." },
      btn("Reset everything", async () => {
        if (!(await confirmDialog("Reset ScoreX completely? Settings, targets, candidates, history and logs are deleted. Kept: API keys, the spend ledger, and comments posted in the last 8 days (the 24h / 7-day safety limits and the monthly budget depend on them). The daily ramp starts again at week 1.", { title: "Reset everything", okLabel: "Continue", danger: true }))) return;
        if (!(await confirmDialog("This cannot be undone. Really delete everything?", { title: "Are you sure?", okLabel: "Delete everything", danger: true }))) return;
        const r = await ctx.send("resetAll", {}, { label: "Reset" });
        if (r) { toast("ScoreX was reset"); setTimeout(() => location.reload(), 600); }
      }, { kind: "danger", iconName: "trash", id: "resetAllBtn" }));

    const cleanupAdv = advanced({ key: "settings.cleanup", title: "Cleanup", desc: "Optional unfollow of accounts that never followed back" }, cleanupSec);
    const syncTags = () => { cleanupAdv.setTag(ctx.settings.cleanup.enabled ? "on" : "off"); };
    syncTags();
    ctx.on("settings", syncTags);

    const full = ctx.params && ctx.params.view === "diagnostics";
    const diagSec = diagnosticsSection(ctx, { full });
    if (full) {
      ctx.setTitle("Settings › Diagnostics");
      const ph = root.querySelector(":scope > .page-hint");
      if (ph) ph.remove();
      add(root, diagSec, h("p", { class: "small" }, h("a", { href: "#settings", id: "allSettingsLink" }, "← All settings")));
      await diagSec.runQuick();
      return;
    }
    add(root,
      diagSec,
      accountSec,
      watchSec,
      windowSec,
      h("div", { class: "adv-group-label" }, "Advanced"),
      advanced({ key: "settings.general", title: "Mode, time zone and theme", desc: "Also available on the Dashboard, in Safety and in the top bar" }, generalSec),
      advanced({ key: "settings.watch", title: "Watching details", desc: "Search batch size, profiles per check, check interval, quote posts" }, watchMoreSec),
      advanced({ key: "settings.review", title: "Review queue", desc: "Expiry of pending and approved items, max waiting, notifications" }, reviewSec),
      advanced({ key: "settings.learning", title: "Learning and background checks", desc: "Engagement checks, replies to you, cool-downs, automatic tier moves (follow checks: Targets tab)" }, learningSec),
      cleanupAdv,
      advanced({ key: "settings.worker", title: "Worker tab and selectors", desc: "Pinned tab or separate window, debug logging, selector overrides" }, workerSec, selectorsSec),
      advanced({ key: "settings.data", title: "Data", desc: "Export and import backups, export history, reset everything" }, dataSec, resetSec));

    drawStrategy();
    await loadOverrides();
    diagSec.runQuick();
    if (ctx.params && ctx.params.focus === "handle") {
      const inp = accountSec.querySelector("input");
      if (inp) setTimeout(() => { accountSec.scrollIntoView({ block: "start" }); inp.focus({ preventScroll: true }); }, 0);
    }
    ctx.on("settings", () => { if (!strategyHost.contains(document.activeElement)) drawStrategy(); else listUrls.hidden = ctx.settings.watch.strategy !== "list"; });
    ctx.on(K.selectorOverrides, () => { if (document.activeElement !== ovText) loadOverrides(); });
  },
};
