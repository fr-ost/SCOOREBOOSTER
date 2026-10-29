// Settings tab: account, general, watch strategy, review, learning, cleanup, Sorsa, advanced
// (worker tab mode, debug, selector overrides) and data (export / import / reset).

import { K, MODE, HARD } from "../../lib/constants.js";
import { SORSA } from "../../lib/scores.js";
import { warmup } from "../../lib/safety.js";
import * as history from "../../lib/history.js";
import { num } from "../../lib/util.js";
import { h, clear, card, btn, busy, toast, icon, selectEl, labeled, confirmDialog, modal, download, readFileText, stamp, toggleEl, xLink, badge, fmtCount, sectionTitle, uidShort, renderTable, add } from "../components.js";
import { secretField } from "./models.js";
import { timeZones } from "./safety.js";

const DATA_PARTS = [
  ["settings", "Settings (never includes API keys)"],
  ["targets", "Targets"],
  ["candidates", "Discovery candidates"],
  ["history", "Comment history"],
  ["learning", "Learning / A/B data"],
];
const STRATEGIES = [
  ["list", "X List", "Recommended for many targets: put your targets in one or more X Lists; one page shows all their new posts.", true],
  ["search", "Batched Latest search", "Searches \"from:a OR from:b ...\" in Latest, a batch of targets per check. No setup needed."],
  ["rotation", "Profile rotation", "Visits a few target profiles per check. Slowest; fine for a small list."],
];

export default {
  id: "settings",
  title: "Settings",
  icon: "settings",
  async render(root, ctx) {
    const f = (spec) => ctx.field(spec);

    // ------------------------------------------------ account & general
    const wu = (ctx.status && ctx.status.warmup) || warmup(ctx.state);
    const themeSel = selectEl([["system", "System"], ["light", "Light"], ["dark", "Dark"]], (window.sxTheme && window.sxTheme.get()) || "system", { id: "themeSelect" });
    themeSel.addEventListener("change", () => {
      if (window.sxTheme) window.sxTheme.set(themeSel.value);
      ctx.save((d) => { d.ui = { ...(d.ui || {}), theme: themeSel.value }; });
    });
    window.addEventListener("sx-theme", (e) => { if (themeSel.isConnected) themeSel.value = e.detail.pref; });

    const generalCard = card({ title: "Account and general" },
      h("div", { class: "form-grid" },
        f({ path: "account.handle", type: "text", label: "Your X handle", placeholder: "0x_nation", hint: "Without @. Used to make sure the right account is logged in." }),
        f({ path: "account.verifyAccount", type: "toggle", label: "Stop if a different account is logged in" }),
        f({ path: "timezone", type: "select", label: "Time zone", options: timeZones(ctx.settings.timezone), hint: "Used for active hours, daily limits and dates." }),
        f({ path: "mode", type: "select", label: "Mode", options: [[MODE.REVIEW, "Review"], [MODE.AUTO, wu.active ? "Full auto (after warm-up)" : "Full auto"]], hint: wu.active ? "Review approves every comment. Full auto can be picked now but only switches on after the 3-day warm-up." : "Review approves every comment; Full auto posts within your safety limits." }),
        labeled("Theme", themeSel)));

    // ------------------------------------------------ watch
    const strategyHost = h("div", { class: "radio-cards", role: "radiogroup", "aria-label": "Watch strategy" });
    const listUrls = f({ path: "watch.listUrls", type: "list", label: "X List URLs", rows: 3, placeholder: "https://x.com/i/lists/1234567890", hint: "One per line. Make the lists private if you prefer; your account just needs to see them." });
    function drawStrategy() {
      const cur = ctx.settings.watch.strategy;
      clear(strategyHost);
      for (const [v, title, desc, rec] of STRATEGIES) {
        const id = uidShort("ws_");
        const input = h("input", { type: "radio", name: "watchStrategy", id, value: v, checked: v === cur });
        input.addEventListener("change", () => { if (input.checked) ctx.save((d) => { d.watch.strategy = v; }); });
        strategyHost.appendChild(h("label", { class: ["radio-card", v === cur && "active"], for: id }, input,
          h("div", null, h("div", { class: "radio-title" }, title, rec ? badge("recommended", "green") : null), h("div", { class: "muted small" }, desc))));
      }
      listUrls.hidden = cur !== "list";
    }
    const watchCard = card({ title: "Watching for new posts", subtitle: "How ScoreX finds fresh posts from your targets in the worker tab." },
      strategyHost,
      listUrls,
      h("div", { class: "form-grid" },
        f({ path: "watch.searchBatchSize", type: "number", label: "Search batch size", min: 1, max: 20, hint: "Targets per Latest search (search mode)" }),
        f({ path: "watch.rotationPerTick", type: "number", label: "Profiles per check", min: 1, max: 6, hint: "Rotation mode" }),
        f({ path: "watch.checkIntervalSec.min", type: "number", label: "Check every (min seconds)", min: HARD.minCheckIntervalSec, max: 3600, step: 10, hint: `At least ${HARD.minCheckIntervalSec} s` }),
        f({ path: "watch.checkIntervalSec.max", type: "number", label: "Check every (max seconds)", min: HARD.minCheckIntervalSec, max: 3600, step: 10 }),
        f({ path: "watch.minPostAgeMin", type: "number", label: "Comment window: from (min)", min: 0, max: 30, hint: "Never reply instantly" }),
        f({ path: "watch.maxPostAgeMin", type: "number", label: "Comment window: until (min)", min: 5, max: 180, hint: "Early replies get seen most" }),
        f({ path: "watch.includeQuotes", type: "toggle", label: "Include quote posts" })));

    // ------------------------------------------------ review + learning
    const reviewCard = card({ title: "Review queue" },
      h("div", { class: "form-grid" },
        f({ path: "review.pendingMaxAgeMin", type: "number", label: "Pending items expire after (min)", min: 10, max: 1440 }),
        f({ path: "review.approvedMaxAgeMin", type: "number", label: "Approved items expire after (min)", min: 10, max: 1440 }),
        f({ path: "review.maxPending", type: "number", label: "Max waiting for review", min: 1, max: 200, hint: "Generation pauses at this number" }),
        f({ path: "review.notifyNew", type: "toggle", label: "Desktop notification for new items" })));

    const learningCard = card({ title: "Learning", subtitle: "Tracks follow-backs and responses to adjust priorities and tiers.", actions: btn("Run learning now", (e) => { const b = e.currentTarget; busy(b, async () => { const r = await ctx.send("learningRun", {}, { label: "Learning" }); if (r) toast("Learning run started", { type: "success" }); }); }, { size: "sm", iconName: "refresh" }) },
      h("div", { class: "form-grid" },
        f({ path: "learning.enabled", type: "toggle", label: "Learning on" }),
        f({ path: "learning.autoTierUp", type: "toggle", label: "Move responsive accounts up a tier" }),
        f({ path: "learning.autoMoveToA", type: "toggle", label: "Move to group A when they follow back" }),
        f({ path: "learning.coldAfterComments", type: "number", label: "Cool down after N comments without response", min: 2, max: 50 }),
        f({ path: "learning.coldCooldownDays", type: "number", label: "Cool-down length (days)", min: 1, max: 90 }),
        f({ path: "learning.followCheckEveryHours", type: "number", label: "Check follow-backs every (hours)", min: 1, max: 720 }),
        f({ path: "learning.engagementCheckAfterHours", type: "number", label: "Check reply engagement after (hours)", min: 1, max: 720 }),
        f({ path: "learning.maxChecksPerRun", type: "number", label: "Max checks per run", min: 0, max: 10 })));

    // ------------------------------------------------ cleanup
    const cleanupToggle = toggleEl("Unfollow accounts that don't follow back", ctx.settings.cleanup.enabled, async (v, input) => {
      if (v) {
        const ok = await confirmDialog(`ScoreX will unfollow accounts you followed more than ${ctx.settings.cleanup.afterDays} days ago that still don't follow you back (max ${ctx.settings.cleanup.dailyLimit} per day, whitelist respected). Turn it on?`, { title: "Turn on cleanup", okLabel: "Turn on" });
        if (!ok) { input.checked = false; return; }
      }
      ctx.save((d) => { d.cleanup.enabled = v; });
    }, { id: "cleanupEnabled" });
    ctx.addRefresher((s) => { if (!cleanupToggle.isConnected) return false; cleanupToggle.input.checked = !!s.cleanup.enabled; return true; });
    const cleanupCard = card({ title: "Cleanup (optional)", subtitle: "Default OFF. Only touches accounts you follow that never followed back.", actions: btn("Preview who would be unfollowed", (e) => {
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
      h("div", { class: "form-grid" },
        h("div", { class: "field field-check" }, cleanupToggle),
        f({ path: "cleanup.protectTier1", type: "toggle", label: "Never unfollow tier 1 targets" }),
        f({ path: "cleanup.afterDays", type: "number", label: "Only after (days)", min: 7, max: 365, hint: "Minimum 7" }),
        f({ path: "cleanup.dailyLimit", type: "number", label: "Max unfollows per day", min: 0, max: HARD.dailyUnfollows, hint: `Cap ${HARD.dailyUnfollows}` })),
      f({ path: "cleanup.whitelist", type: "list", label: "Never unfollow (whitelist)", rows: 3, placeholder: "@friend\n@brand" }));

    // ------------------------------------------------ Sorsa
    const sorsaToggle = toggleEl("Use Sorsa Score", ctx.settings.scores.sorsaEnabled, null, { id: "sorsaEnabled" });
    // The permission prompt must be requested synchronously inside the click/change handler (user gesture).
    sorsaToggle.input.addEventListener("change", () => {
      const input = sorsaToggle.input;
      if (input.checked) {
        let req;
        try { req = chrome.permissions.request({ origins: [SORSA.permission] }); } catch (e) { input.checked = false; toast("Permission request failed: " + e.message, { type: "error" }); return; }
        Promise.resolve(req).then((granted) => {
          if (!granted) { input.checked = false; toast("Sorsa stays off: access to api.sorsa.io was not granted.", { type: "warn" }); return; }
          ctx.save((d) => { d.scores.sorsaEnabled = true; });
          toast("Sorsa enabled", { type: "success" });
        }, (e) => { input.checked = false; toast("Permission request failed: " + ((e && e.message) || e), { type: "error" }); });
      } else {
        ctx.save((d) => { d.scores.sorsaEnabled = false; });
        try { Promise.resolve(chrome.permissions.remove({ origins: [SORSA.permission] })).catch(() => {}); } catch (_) {}
      }
    });
    ctx.addRefresher((s) => { if (!sorsaToggle.isConnected) return false; sorsaToggle.input.checked = !!s.scores.sorsaEnabled; return true; });
    const sorsaOut = h("div", { class: "small", id: "sorsaOut" });
    const sorsaCard = card({ title: "Sorsa Score (optional)", subtitle: "Adds Sorsa's influence score next to ScoreX rank. Paid API with 100 free requests - each profile refresh uses one." },
      h("div", { class: "grid-2" },
        h("div", { class: "stack" },
          secretField(ctx, { key: "sorsaKey", label: "Sorsa API key", placeholder: "Your Sorsa key", id: "sorsaKeyField", hint: h("span", null, "Get one at ", h("a", { href: "https://api.sorsa.io", target: "_blank", rel: "noopener noreferrer" }, "api.sorsa.io"), ".") }),
          h("div", { class: "field field-check" }, sorsaToggle, h("div", { class: "field-hint" }, "Asks Chrome for access to api.sorsa.io the first time.")),
          f({ path: "scores.blendSorsa", type: "percent", label: "Weight of Sorsa in the combined rank", min: 0, max: 100, step: 5, suffix: "%" })),
        h("div", { class: "subpanel" },
          h("h3", { class: "subpanel-title" }, "Check and refresh"),
          h("div", { class: "toolbar" },
            btn("Test", (e) => { const b = e.currentTarget; busy(b, async () => { const r = await ctx.send("sorsaTest", {}, { label: "Sorsa test" }); clear(sorsaOut); if (r) add(sorsaOut, `Works. Sample score: ${r.score != null ? r.score : "-"}`, r.remaining != null ? ` · ${r.remaining} requests left` : ""); }); }, { iconName: "bolt", id: "sorsaTestBtn" }),
            btn("Refresh all targets", async (e) => {
              const handles = ctx.targetList().map((t) => t.handle);
              if (!handles.length) { toast("No targets yet.", { type: "warn" }); return; }
              if (!(await confirmDialog(`Fetch Sorsa scores for ${handles.length} target${handles.length === 1 ? "" : "s"}? This uses about ${handles.length} Sorsa requests.`, { title: "Refresh Sorsa scores", okLabel: "Refresh" }))) return;
              const r = await ctx.send("sorsaRefresh", { handles }, { label: "Sorsa refresh" });
              if (r) toast(`Updated ${num(r.updated)} Sorsa scores`, { type: "success" });
            }, { iconName: "refresh" })),
          sorsaOut)));

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
    const advancedCard = card({ title: "Advanced" },
      h("div", { class: "form-grid" },
        f({ path: "advanced.tabMode", type: "select", label: "Worker tab", options: [["pinned", "Pinned tab in this window"], ["window", "Separate minimised window"]], format: (v) => v || "pinned", hint: "Where ScoreX opens its own X tab." }),
        f({ path: "advanced.debug", type: "toggle", label: "Debug logging", hint: "More detail in Recent activity. API keys are always redacted." })),
      sectionTitle("Selector overrides"),
      h("p", { class: "muted small" }, "When X changes its page and ScoreX stops with \"X page changed\", you can patch selectors here without waiting for an update. Same shape as content/selectors.js (sel / text / misc); merged over the built-in values."),
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
      if (!(await confirmDialog(`Import ${sel.join(", ")} from ${file.name}? Existing data of those parts is replaced or merged by the worker. API keys are never imported.`, { title: "Import data", okLabel: "Import" }))) return;
      const r = await ctx.send("importData", { data, parts: sel }, { label: "Import" });
      if (r) toast("Imported: " + (typeof r.imported === "object" && r.imported ? Object.entries(r.imported).map(([k, v]) => (v === true ? k : `${k} (${v})`)).join(", ") || "nothing" : String(r.imported != null ? r.imported : "done")), { type: "success" });
    });
    const dataCard = card({ title: "Data", subtitle: "Backups never include your API keys." },
      h("div", { class: "field" }, h("div", { class: "field-label" }, "Parts for export / import"), h("div", { class: "chip-select" }, partBoxes.map((p) => p.el))),
      h("div", { class: "toolbar wrap" },
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
        }, { iconName: "download" })),
      sectionTitle("Reset"),
      h("p", { class: "muted small" }, "Stops the engine and deletes settings, targets, candidates, history, logs, learning data and selector overrides. Your API keys are kept (remove them above or in Models & Costs)."),
      btn("Reset everything", async () => {
        if (!(await confirmDialog("Reset ScoreX completely? Settings, targets, candidates, history and logs are deleted. API keys are kept.", { title: "Reset everything", okLabel: "Continue", danger: true }))) return;
        if (!(await confirmDialog("This cannot be undone. Really delete everything?", { title: "Are you sure?", okLabel: "Delete everything", danger: true }))) return;
        const r = await ctx.send("resetAll", {}, { label: "Reset" });
        if (r) { toast("ScoreX was reset"); setTimeout(() => location.reload(), 600); }
      }, { kind: "danger", iconName: "trash", id: "resetAllBtn" }));

    add(root, 
      h("div", { class: "grid-2" }, generalCard, reviewCard),
      watchCard,
      h("div", { class: "grid-2" }, learningCard, cleanupCard),
      sorsaCard,
      h("div", { class: "grid-2" }, advancedCard, dataCard));

    drawStrategy();
    await loadOverrides();
    ctx.on("settings", () => { if (!strategyHost.contains(document.activeElement)) drawStrategy(); else listUrls.hidden = ctx.settings.watch.strategy !== "list"; });
    ctx.on(K.selectorOverrides, () => { if (document.activeElement !== ovText) loadOverrides(); });
  },
};
