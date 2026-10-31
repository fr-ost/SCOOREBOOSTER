// Discover (#discover): find new accounts to target. Source switch: Smart followers (score sites) | Followers of |
// Following of | Common follows | People search (the last four are read on X in the worker tab; nothing is followed
// or posted). Smart followers of ONE account show its list per provider plus a merged list; SEVERAL accounts run a
// background sweep (sx.scoreboard.job, kind "sweep") whose finds land in the candidates. "Big accounts swept" shows the
// cached lists (sx.scoreboard.smart, 3 days). The candidates table (sx.candidates) has provider score columns, the
// "listed by" overlap, the filter result and "Add N as Tier X".
// Route params: #discover?h=<handle> prefills and runs the smart-follower lookup; ?s=<source> picks the source.

import { K } from "../../lib/constants.js";
import { parseHandleList, normalizeHandle, num } from "../../lib/util.js";
import {
  h, clear, fill, add, section, advanced, btn, busy, toast, icon, segmented, segFilter, selectEl, toggleEl, renderTable,
  confirmDialog, link, xLink, tag, statusSquare, providerKey, providerName, progressBar, fmtAgo, fmtCount, fmtNum, debounce,
  truncate, isSafetyStop,
} from "../components.js";
import { barInCell, overlapDots, fmtShort } from "../charts.js";
import { readiness, usageLeft, MODE_TAG } from "./scores.js";

const DAY = 864e5;
const SMART_TTL = 3 * DAY; // lib/scoreboard.js smartFollowersOf cache
// Values of the X sources match lib/discovery.js sourceUrls(). "My followers" is not offered: followers are never commented on.
const SOURCES = [
  ["smart", "Smart followers"],
  ["followersOf", "Followers of"],
  ["followingOf", "Following of"],
  ["common", "Common follows"],
  ["search", "People search"],
];
const SOURCE_LONG = { followersOf: "Followers of @account", followingOf: "Following of @account", search: "Keyword search (people)", common: "Common follows of several smart accounts", smart: "Smart followers" };
const ACTIVE = ["running", "queued", "waiting", "cancelling"];
const lsGet = (k, d) => { try { const v = window.localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } };
const lsSet = (k, v) => { try { window.localStorage.setItem(k, v); } catch (_) { /* storage blocked */ } };
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const btnLabel = (b) => b.querySelector(":scope > span:not(.icon)") || b.appendChild(document.createElement("span"));

// Candidate field accessors (the worker owns the shape; read defensively).
const C = {
  followers: (c) => (c.followers != null ? c.followers : c.profile && c.profile.followers),
  name: (c) => c.name || (c.profile && c.profile.name) || "",
  bio: (c) => (c.profile && c.profile.bio) || c.bio || "",
  score: (c) => (typeof c.score === "number" ? c.score : c.score ? (c.score.combined != null ? c.score.combined : c.score.own) : null),
  flags: (c) => c.flags || (c.score && c.score.flags) || [],
  overlap: (c) => (c.overlap != null ? c.overlap : c.overlapCount != null ? c.overlapCount : null),
  sources: (c) => (Array.isArray(c.sources) ? c.sources : c.source ? [c.source] : []),
  tier: (c) => Number(c.suggestedTier || c.tier) || null,
  followsYou: (c) => !!(c.followsYou || (c.rel && c.rel.followsYou) || (c.profile && c.profile.followsYou)),
  pass: (c) => (c.pass != null ? c.pass : c.filter ? c.filter.pass : null),
  why: (c) => c.why || (c.filter && c.filter.why) || [],
  pscore: (c, pid) => { const v = c.providerScores && c.providerScores[pid]; return v != null && Number.isFinite(Number(v)) ? Number(v) : null; },
};

function addedToast(r, verb = "Added", suffix = "") {
  const added = num(r.added), updated = num(r.updated), black = num(r.blacklisted);
  const parts = [`${verb} ${added}${suffix}`];
  if (updated) parts.push(`${updated} updated`);
  if (black) parts.push(`${black} skipped (blacklisted)`);
  const text = parts.join(", ") + (added ? ". Follow status is checked before any comment." : ".");
  toast(text, { type: added || updated ? "success" : "warn" });
}

// One list across providers from a cached smart entry { at, results: { [pid]: { list, total, url, at, error } } }.
function mergeResults(results) {
  const by = new Map();
  for (const [pid, r] of Object.entries(results || {})) {
    for (const it of (r && r.list) || []) {
      if (!it || !it.handle) continue;
      const cur = by.get(it.handle) || { handle: it.handle, name: "", followers: null, scores: {}, providers: [] };
      if (!cur.name && it.name) cur.name = it.name;
      if (cur.followers == null && it.followers != null) cur.followers = it.followers;
      if (it.score != null) cur.scores[pid] = Number(it.score);
      if (!cur.providers.includes(pid)) cur.providers.push(pid);
      by.set(it.handle, cur);
    }
  }
  return [...by.values()];
}
const listTotal = (results) => Math.max(0, ...Object.values(results || {}).map((r) => num(r && r.total)));

export default {
  id: "discover",
  title: "Discover",
  hint: "Find new accounts to target. Nothing is followed or posted.",
  async render(root, ctx) {
    let providers = [];
    let src = SOURCES.some(([v]) => v === ctx.params.s) ? ctx.params.s : SOURCES.some(([v]) => v === lsGet("sx.discover.src", "")) ? lsGet("sx.discover.src", "") : "smart";
    let focus = null; // handle shown in "Smart followers of @x"
    let lookupBusy = null; // handle being looked up
    let showAllSwept = false;
    const candSelected = new Set();
    const lookSelected = new Set();
    let lookTier = "2"; // tier for "Add N as Tier X" (kept across redraws: sx.scoreboard changes often)
    const candSort = { key: "overlap", dir: "desc" };
    const lookSort = { key: "listed", dir: "desc" };
    const cf = { q: "", view: "all" };

    const board = () => ctx.data[K.scoreboard] || {};
    const smartProviders = () => providers.filter((p) => p.enabled && (!p.caps || p.caps.smartFollowers));
    const discovery = () => { const d = ctx.data[K.discovery]; return d && typeof d === "object" ? d : null; };
    const sweepJob = () => { const j = board().job; return j && typeof j === "object" && j.kind === "sweep" ? j : null; };
    const anyJob = () => { const j = board().job; return j && typeof j === "object" && j.status === "running" ? j : null; };
    async function loadProviders() {
      const r = await ctx.send("scoresState", {}, { quiet: true });
      if (r && Array.isArray(r.providers)) providers = r.providers;
    }
    const reloadProviders = debounce(async () => { if (!root.isConnected) return; await loadProviders(); drawForm(); drawLookup(); drawCandidates(); }, 300);

    // ------------------------------------------------ source switch + input row
    const srcSeg = segmented(SOURCES.map(([v, l]) => [v, l]), src, (v) => { src = v; lsSet("sx.discover.src", v); ctx.setParams({ s: v === "smart" ? null : v }); drawForm(); }, { label: "Where to look" });
    srcSeg.id = "discSource";
    const dHandles = h("input", { class: "input", id: "discHandles", type: "text", autocomplete: "off", spellcheck: "false", "aria-label": "Accounts (@handles, comma separated)" });
    const dQuery = h("input", { class: "input", id: "discQuery", type: "text", placeholder: "e.g. onchain analyst, AI researcher", "aria-label": "Search words (names and bios)" });
    const dMax = h("input", { class: "input input-sm", type: "number", min: "10", max: "1000", step: "10", id: "discMax", value: String((ctx.settings.discovery && ctx.settings.discovery.maxUsers) || 150), "aria-label": "Max users" });
    const dEnrich = toggleEl("Visit profiles to score them (slower, better)", true, null, { id: "discEnrich" });
    const startBtn = btn("Find smart followers", null, { kind: "primary", iconName: "discover", id: "discStartBtn" });
    const availEl = h("div", { class: "disc-avail small muted", id: "discAvail" });
    const hintEl = h("p", { class: "small muted disc-hint", id: "discHint" });
    const optRow = h("div", { class: "filterbar disc-opts" }, h("label", { class: "small muted", for: "discMax" }, "Max users"), dMax, dEnrich);
    const formRow = h("div", { class: "filterbar disc-form" }, dHandles, dQuery, startBtn, availEl);

    function startLabel() {
      if (src === "smart") { const n = parseHandleList(dHandles.value).length; return n >= 2 ? `Sweep ${n} accounts` : "Find smart followers"; }
      return { followersOf: "Read followers", followingOf: "Read following", common: "Find common follows", search: "Search people" }[src];
    }
    function availNodes() {
      if (src !== "smart") return [h("span", null, "Reads X in the worker tab · nothing is followed or posted")];
      const list = smartProviders();
      if (!list.length) return [h("span", null, "No score site lists smart followers yet. "), link("#scores?view=providers", "Connect a score site", { external: false })];
      const parts = [];
      list.forEach((p, i) => {
        const r = readiness(p);
        const text = r.kind === "ready" || r.kind === "error"
          ? (p.mode === "api" ? `${p.name} ${usageLeft(p)} left` : `${p.name} ${(MODE_TAG[p.mode] || p.mode || "").toLowerCase()} · ${usageLeft(p)} left`)
          : r.kind === "key" ? `${p.name}: add your API key` : r.kind === "access" ? `${p.name}: allow access` : r.kind === "cap" ? `${p.name}: cap reached today` : `${p.name}: ${r.label}`;
        if (i) parts.push(h("span", { class: "avail-sep", "aria-hidden": "true" }, "·"));
        const ok = r.kind === "ready" || r.kind === "error";
        parts.push(h("span", { class: ["avail", !ok && "text-amber"], title: ok ? `${usageLeft(p)} of ${num(p.usage && p.usage.cap)} requests left today` : r.label }, providerKey(p.id), " ", ok ? text : link("#scores?view=providers", text, { external: false })));
      });
      return parts;
    }
    function drawForm() {
      srcSeg.set(src);
      const isSmart = src === "smart", isSearch = src === "search";
      dHandles.hidden = isSearch;
      dQuery.hidden = !isSearch;
      dHandles.placeholder = isSmart ? "@cobie, @hsaka (one account shows its lists, several run a sweep)" : src === "common" ? "@smart1, @smart2, @smart3 (2-5 accounts)" : "@account";
      optRow.hidden = isSmart;
      btnLabel(startBtn).textContent = startLabel();
      const d = discovery(), sj = anyJob();
      let why = "";
      if (isSmart) {
        if (!smartProviders().length) why = "Turn on a score site that lists smart followers first (Scores).";
        else if (parseHandleList(dHandles.value).length >= 2 && sj) why = "A score job is running - wait or cancel it.";
      } else if (isSafetyStop(ctx.state)) why = "ScoreX stopped for safety. Review the stop first: these sources read X in the worker tab.";
      else if (d && ACTIVE.includes(d.status)) why = "A discovery is running - one at a time.";
      startBtn.disabled = !!why || !!(isSmart && lookupBusy);
      startBtn.title = why || (isSmart ? "Smart followers from your connected score sites (lists are cached for 3 days)" : "Runs in the X tab; progress shows below");
      fill(availEl, !isSmart && isSafetyStop(ctx.state) ? [h("span", { class: "text-red" }, "Stopped for safety: X is not read until you review the stop. "), h("button", { type: "button", class: "linkish small", id: "discReviewStop", onClick: () => ctx.openReviewStop() }, "Review stop…")] : availNodes());
      hintEl.textContent = isSmart
        ? "Smart followers are the high-score accounts that follow a big account. They follow back more often than random followers."
        : src === "common" ? "Accounts that several smart accounts follow (2-5 accounts)." : src === "search" ? "People whose name or bio matches the words." : "Reads the list on X and scores the accounts it finds.";
    }
    dHandles.addEventListener("input", () => { btnLabel(startBtn).textContent = startLabel(); drawFormSoon(); });
    const drawFormSoon = debounce(() => drawForm(), 200);
    const onEnter = (e) => { if (e.key === "Enter") { e.preventDefault(); if (!startBtn.disabled) startBtn.click(); } };
    dHandles.addEventListener("keydown", onEnter);
    dQuery.addEventListener("keydown", onEnter);

    startBtn.addEventListener("click", async () => {
      const handles = parseHandleList(dHandles.value);
      if (src === "smart") {
        if (!handles.length) { toast("Enter one or more @accounts first.", { type: "warn" }); dHandles.focus(); return; }
        if (handles.length === 1) { lookup(handles[0]); return; }
        const n = smartProviders().length;
        if (handles.length > 5 && !(await confirmDialog(`Find the smart followers of ${handles.length} accounts? This uses up to ${handles.length * n} score-site requests (lists from the last 3 days are reused for free). Finds land in the candidates below.`, { title: "Smart-follower sweep", okLabel: "Start" }))) return;
        await busy(startBtn, async () => {
          const r = await ctx.send("smartSweep", { handles }, { label: "Smart followers" });
          if (r) toast(`Sweeping ${plural(handles.length, "account")} - candidates appear below.`, { type: "success" });
        });
        drawForm();
        return;
      }
      const query = dQuery.value.trim();
      if (["followersOf", "followingOf"].includes(src) && !handles.length) { toast("Enter an @account first.", { type: "warn" }); dHandles.focus(); return; }
      if (src === "common" && handles.length < 2) { toast("Enter at least two smart accounts.", { type: "warn" }); dHandles.focus(); return; }
      if (src === "search" && !query) { toast("Enter search words first.", { type: "warn" }); dQuery.focus(); return; }
      await busy(startBtn, async () => {
        const r = await ctx.send("discoveryStart", { source: src, handles, query, maxUsers: Math.max(10, Math.min(1000, Number(dMax.value) || 150)), enrich: dEnrich.input.checked }, { label: "Discovery" });
        if (r) toast("Discovery started - it runs in the X tab, progress shows below.", { type: "success" });
      });
      drawForm();
    });

    // ------------------------------------------------ discovery filters (collapsed)
    const filtersAdv = advanced({ key: "discover.filters", title: "Discovery filters", desc: "Min/max followers, posted within, languages, max users, profiles scored per run, skip bots" },
      h("p", { class: "small muted" }, "Candidates outside these are marked as not passing; you can still add them."),
      h("div", { class: "form-grid" },
        ctx.field({ path: "discovery.minFollowers", type: "number", label: "Min followers", min: 0, step: 100 }),
        ctx.field({ path: "discovery.maxFollowers", type: "number", label: "Max followers", min: 0, step: 1000 }),
        ctx.field({ path: "discovery.activeWithinDays", type: "number", label: "Posted within (days)", min: 0, max: 365 }),
        ctx.field({ path: "discovery.languages", type: "csv", label: "Languages", placeholder: "en, bn (empty = any)", hint: "Language codes, comma separated" }),
        ctx.field({ path: "discovery.maxUsers", type: "number", label: "Default max users", min: 10, max: 1000, step: 10 }),
        ctx.field({ path: "discovery.enrichMax", type: "number", label: "Profiles scored per run", min: 0, max: 200 }),
        ctx.field({ path: "discovery.skipBots", type: "toggle", label: "Skip bots and spam accounts" })));

    // ------------------------------------------------ progress strips (X discovery, smart sweep)
    const discHost = h("div", { class: "disc-progress", id: "discProgress", "aria-live": "polite" });
    const sweepHost = h("div", { class: "disc-progress", id: "sweepProgress", "aria-live": "polite" });
    function jobSquare(status, running) {
      if (running) return statusSquare("ink", status === "waiting" ? "Waiting" : status === "cancelling" ? "Cancelling" : "Running");
      return status === "done" ? statusSquare("green", "Done") : status === "error" ? statusSquare("red", "Error") : status === "cancelled" ? statusSquare("grey", "Cancelled") : statusSquare("grey", status || "Idle");
    }
    // sx.discovery (lib/discovery.js): { status, source, step, message, found, progress: {done,total}, startedAt, finishedAt }
    function drawDiscovery() {
      const d = discovery();
      clear(discHost);
      if (!d || (!d.status && !d.startedAt)) { discHost.hidden = true; return; }
      discHost.hidden = false;
      const running = ACTIVE.includes(d.status);
      const p = d.progress || {};
      const done = num(p.done), total = num(p.total);
      const pct = total ? (running ? Math.max(4, ((done + 0.5) / total) * 100) : 100) : running ? 10 : 100;
      const facts = [];
      if (d.found != null) facts.push(`${num(d.found)} accounts found`);
      if (total) facts.push(`${done} of ${total} source${total === 1 ? "" : "s"} read`);
      if (d.startedAt) facts.push(`started ${fmtAgo(d.startedAt)}`);
      if (d.finishedAt) facts.push(`finished ${fmtAgo(d.finishedAt)}`);
      add(discHost, h("div", { class: "job-strip" },
        h("div", { class: "job-head" },
          jobSquare(d.status, running),
          h("strong", { class: "small" }, SOURCE_LONG[d.source] || d.source || "Discovery"),
          d.step ? h("span", { class: "small muted" }, d.step) : null,
          h("span", { class: "spacer" }),
          h("span", { class: "mono small muted" }, facts.join(" · ")),
          running ? btn("Cancel", async (e) => { await busy(e.currentTarget, async () => { const r = await ctx.send("discoveryCancel", {}, { label: "Cancel discovery" }); if (r) toast("Discovery cancelled"); }); }, { size: "xs", id: "discCancelBtn", disabled: d.status === "cancelling" }) : null),
        running ? progressBar(pct) : null,
        d.message ? h("div", { class: ["small", d.status === "error" && "text-red"] }, d.message) : null,
        d.error ? h("div", { class: "small text-red" }, String(d.error)) : null));
    }
    function drawSweep() {
      const j = sweepJob();
      clear(sweepHost);
      const nowTs = Date.now();
      if (!j || (j.status !== "running" && !(j.finishedAt && nowTs - j.finishedAt < 12 * 36e5))) { sweepHost.hidden = true; return; }
      sweepHost.hidden = false;
      const running = j.status === "running";
      const total = num(j.total), done = num(j.done);
      const res = j.result || {};
      const found = j.found != null ? num(j.found) : num(res.found);
      const counter = running
        ? `${done} of ${total || "?"} accounts${j.current ? " · @" + j.current : ""} · ${found} found`
        : `${found} candidate${found === 1 ? "" : "s"}${total ? ` from ${plural(total, "account")}` : ""} · ${fmtAgo(j.finishedAt)}`;
      const errs = Array.isArray(res.errors) ? res.errors : [];
      add(sweepHost, h("div", { class: "job-strip" },
        h("div", { class: "job-head" },
          jobSquare(j.status, running),
          h("strong", { class: "small" }, j.label || "Smart followers"),
          h("span", { class: "spacer" }),
          h("span", { class: "mono small muted" }, counter),
          running ? btn("Cancel", (e) => busy(e.currentTarget, async () => { const r = await ctx.send("scoreJobCancel", {}, { label: "Cancel" }); if (r) toast("Stopping after the current account"); }), { size: "xs", id: "sweepCancelBtn" }) : null),
        running ? progressBar(total ? Math.max(4, ((done + 0.5) / total) * 100) : 8) : null,
        j.status === "error" && j.error ? h("div", { class: "small text-red" }, String(j.error)) : null,
        errs.length && j.status !== "error" ? h("div", { class: "small text-amber", title: errs.join("\n") }, `${plural(errs.length, "problem")}: ${truncate(errs.slice(0, 2).join(" · "), 160)}`) : null));
    }

    // ------------------------------------------------ smart followers of one account (lookup + detail)
    const lookHost = h("div", { id: "smartLookup" });
    async function lookup(handle, { fresh = false } = {}) {
      const hd = normalizeHandle(handle);
      if (!hd) { toast("Enter a valid @handle.", { type: "warn" }); return; }
      src = "smart"; lsSet("sx.discover.src", "smart");
      dHandles.value = "@" + hd;
      focus = hd; lookupBusy = hd;
      lookSelected.clear();
      ctx.setParams({ h: hd, s: null });
      drawForm(); drawLookup(); drawSwept();
      const r = await ctx.send("smartFollowers", { handle: hd, fresh }, { label: `Smart followers of @${hd}` });
      lookupBusy = null;
      if (r) {
        const errs = Object.entries(r.results || {}).filter(([, x]) => x && x.error);
        if (errs.length && !(r.merged || []).length) toast(errs.map(([id, x]) => `${providerName(id)}: ${x.error}`).join(" · "), { type: "warn" });
      }
      if (root.isConnected) { drawForm(); drawLookup(); drawSwept(); }
    }
    function closeLookup() { focus = null; lookSelected.clear(); ctx.setParams({ h: null }); drawLookup(); drawSwept(); }
    function rankedList(rows, pid, { limit = 10 } = {}) {
      const max = Math.max(1, ...rows.map((x) => num(x.score)));
      return h("ol", { class: "rank-list" }, rows.slice(0, limit).map((x, i) => h("li", { class: "rank-li" },
        h("span", { class: "mono muted rank-i" }, String(i + 1)),
        h("span", { class: "rank-h" }, xLink(x.handle)),
        x.score != null ? barInCell(x.score, max, { w: 60, label: `${providerName(pid)} ${fmtNum(x.score)}` }) : h("span"),
        h("span", { class: "mono rank-v" }, x.score != null ? fmtShort(x.score) : "-"))));
    }
    function statusTags(hd) {
      const t = ctx.targets[hd], black = ctx.data[K.blacklist] || {};
      return [
        t ? tag("target", "", `Already a target (Tier ${t.tier})`) : null,
        t && t.rel && t.rel.followsYou ? tag("follows you", "green", "Already follows you - ScoreX never comments on it") : null,
        Object.hasOwn(black, hd) ? tag("blacklisted", "red", "On your blacklist - skipped when added") : null,
      ];
    }
    async function addHandles(list, tier, sel) {
      const r = await ctx.send("targetsUpsert", { rows: list.map((x) => ({ handle: x.handle, name: x.name || "" })), defaults: { tier, source: "smart followers" } }, { label: "Add targets" });
      if (!r) return;
      addedToast(r, "Added", ` as Tier ${tier}`);
      sel.clear();
    }
    function drawLookup() {
      clear(lookHost);
      if (!focus) { lookHost.hidden = true; return; }
      lookHost.hidden = false;
      const entry = (board().smart || {})[focus];
      const results = (entry && entry.results) || {};
      const merged = mergeResults(results);
      const pids = Object.keys(results);
      const total = listTotal(results);
      const busyNow = lookupBusy === focus;
      const head = h("div", { class: "sec-actions" },
        entry ? h("span", { class: "small muted" }, `checked ${fmtAgo(entry.at)}`) : null,
        btn("Re-run", () => lookup(focus, { fresh: true }), { size: "sm", iconName: "refresh", disabled: busyNow || !smartProviders().length, title: "Ask the score sites again (uses requests)" }),
        btn("", closeLookup, { size: "sm", kind: "ghost", iconName: "x", title: "Close" }));
      let body;
      if (!entry) {
        body = h("p", { class: "small muted" }, busyNow ? "Looking up…" : smartProviders().length ? "Not looked up yet." : "Connect a score site that lists smart followers (Scores) to see who follows this account.");
      } else {
        const blocks = pids.map((pid) => {
          const r = results[pid] || {};
          const rows = (r.list || []).slice().sort((a, b) => num(b.score) - num(a.score));
          return h("div", { class: "swept-block" },
            h("div", { class: "swept-head" }, h("span", { class: "cap" }, providerKey(pid), providerName(pid)),
              h("span", { class: "small muted mono" }, r.error ? "" : `${rows.length}${r.total ? " of " + fmtNum(r.total) : ""} shown`),
              h("span", { class: "spacer" }), r.url ? link(r.url, "Open ↗", { cls: "small ext-link" }) : null),
            r.error ? h("p", { class: "small text-red" }, String(r.error)) : rows.length ? rankedList(rows, pid) : h("p", { class: "small muted" }, "No smart followers listed."));
        });
        const sel = lookSelected;
        const tierSel = selectEl([["2", "Tier 2"], ["1", "Tier 1"]], lookTier, { class: "input input-sm", "aria-label": "Tier for added accounts" });
        const addBtn = btn("Add as targets", () => {
          const list = merged.filter((x) => sel.has(x.handle));
          if (list.length) busy(addBtn, () => addHandles(list, Number(tierSel.value), sel).then(drawLookup));
        }, { kind: "primary", size: "sm", iconName: "plus", id: "lookAddBtn" });
        const selInfo = h("span", { class: "small muted" });
        const syncSel = () => { const n = sel.size; selInfo.textContent = n ? `${n} selected` : "Select accounts to add them"; addBtn.disabled = !n; btnLabel(addBtn).textContent = n ? `Add ${n} as Tier ${tierSel.value}` : "Add as targets"; };
        tierSel.addEventListener("change", () => { lookTier = tierSel.value; syncSel(); });
        const cols = [
          { key: "handle", label: "Account", render: (x) => h("div", { class: "who" }, h("span", { class: "who-row" }, xLink(x.handle), statusTags(x.handle)), x.name ? h("span", { class: "who-name" }, x.name) : null), sort: (x) => x.handle, defaultDir: "asc" },
          { key: "followers", label: "Followers", align: "right", render: (x) => fmtCount(x.followers), sort: (x) => x.followers },
          ...pids.map((pid) => ({ key: "p_" + pid, label: h("span", { class: "th-prov" }, providerKey(pid), providerName(pid)), align: "right", render: (x) => (x.scores[pid] != null ? fmtNum(x.scores[pid]) : "-"), sort: (x) => x.scores[pid] })),
          { key: "listed", label: "Listed by", title: "How many score sites list this account", render: (x) => h("span", { class: "listed" }, overlapDots(x.providers.length, pids.length, { label: `${x.providers.length} of ${pids.length} sites` }), h("span", { class: "small muted listed-n" }, `${x.providers.length} of ${pids.length}`)), sort: (x) => x.providers.length * 1e6 + Math.max(0, ...Object.values(x.scores)) },
        ];
        body = [
          h("div", { class: "cols-3 swept-grid" }, blocks),
          merged.length ? h("div", { class: "look-merged" },
            h("div", { class: "filterbar" }, h("h3", { class: "sub-title" }, `Merged · ${merged.length}`), h("span", { class: "spacer" }), selInfo, tierSel, addBtn),
            renderTable({ columns: cols, rows: merged, rowKey: (x) => x.handle, selection: sel, onSelectionChange: syncSel, sortState: lookSort, maxRows: 25, caption: "Merged smart followers", empty: "No accounts." })) : null,
        ];
        setTimeout(syncSel, 0);
      }
      lookHost.appendChild(section({ wide: true, title: `Smart followers of @${focus}`, hint: total ? `${fmtNum(total)} in total on the largest list` : "", actions: head }, body));
      const t = lookHost.querySelector(".sec-title");
      if (t) { t.textContent = ""; add(t, "Smart followers of ", link(`https://x.com/${encodeURIComponent(focus)}`, "@" + focus, { cls: "handle-link" })); }
    }

    // ------------------------------------------------ Big accounts swept (cached lists)
    const sweptHost = h("div", { id: "swept" });
    function sweptBlock(hd, entry) {
      const results = entry.results || {};
      const merged = mergeResults(results);
      const total = listTotal(results);
      const errs = Object.entries(results).filter(([, r]) => r && r.error);
      // rank by the first provider (in the user's provider order) that scores the account, relative to that provider's max here
      const order = providers.map((p) => p.id);
      const maxBy = {};
      for (const x of merged) for (const [pid, v] of Object.entries(x.scores)) maxBy[pid] = Math.max(maxBy[pid] || 1, num(v));
      const best = (x) => { const pid = order.find((id) => x.scores[id] != null) || Object.keys(x.scores)[0]; return pid ? { pid, v: x.scores[pid] } : null; };
      const rows = merged.map((x) => ({ x, b: best(x) })).sort((a, c) => (c.b ? c.b.v / maxBy[c.b.pid] : 0) - (a.b ? a.b.v / maxBy[a.b.pid] : 0));
      const targets = ctx.targets;
      const nTargets = merged.filter((x) => Object.hasOwn(targets, x.handle)).length;
      const nFollows = merged.filter((x) => targets[x.handle] && targets[x.handle].rel && targets[x.handle].rel.followsYou).length;
      const stale = entry.at && Date.now() - entry.at > SMART_TTL;
      return h("div", { class: "swept-block", dataset: { handle: hd } },
        h("div", { class: "swept-head" },
          h("button", { type: "button", class: "linkish handle", title: `Open the smart followers of @${hd}`, onClick: () => { focus = hd; lookSelected.clear(); ctx.setParams({ h: hd, s: null }); drawLookup(); drawSwept(); lookHost.scrollIntoView({ block: "start", behavior: "smooth" }); } }, "@" + hd),
          h("span", { class: "small muted mono" }, `${merged.length}${total ? " of " + fmtNum(total) : ""} shown`),
          h("span", { class: "spacer" }),
          h("span", { class: ["small", stale ? "text-amber" : "muted"], title: stale ? "Older than 3 days: a re-run asks again" : "" }, fmtAgo(entry.at))),
        rows.length ? h("ol", { class: "rank-list" }, rows.slice(0, 6).map(({ x, b }, i) => h("li", { class: "rank-li", title: Object.entries(x.scores).map(([pid, v]) => `${providerName(pid)} ${fmtNum(v)}`).join(" · ") },
          h("span", { class: "mono muted rank-i" }, String(i + 1)),
          h("span", { class: "rank-h" }, xLink(x.handle)),
          b ? barInCell(b.v, maxBy[b.pid], { w: 60, label: `${providerName(b.pid)} ${fmtNum(b.v)}` }) : h("span"),
          h("span", { class: "mono rank-v" }, b ? fmtShort(b.v) : "-")))) : null,
        errs.length && !rows.length ? h("p", { class: "small text-red" }, errs.map(([pid, r]) => `${providerName(pid)}: ${r.error}`).join(" · ")) : null,
        h("div", { class: "swept-foot small muted" },
          h("span", null, `${nTargets} already target${nTargets === 1 ? "" : "s"} · ${nFollows} follow${nFollows === 1 ? "s" : ""} you`),
          h("span", { class: "spacer" }),
          h("button", { type: "button", class: "linkish small", disabled: !!lookupBusy || !smartProviders().length, onClick: () => lookup(hd, { fresh: true }) }, "Re-run")));
    }
    function drawSwept() {
      clear(sweptHost);
      const all = Object.entries(board().smart || {}).filter(([hd, e]) => e && typeof e === "object" && hd !== focus).sort((a, b) => num(b[1].at) - num(a[1].at));
      if (!all.length) { sweptHost.hidden = !!focus; if (!focus) sweptHost.appendChild(section({ wide: true, title: "Big accounts swept", hint: "No smart-follower lists yet" }, h("p", { class: "small muted" }, "Enter big accounts above and press Find smart followers. Each list is kept for 3 days."))); return; }
      sweptHost.hidden = false;
      const shown = showAllSwept ? all : all.slice(0, 6);
      sweptHost.appendChild(section({ wide: true, title: "Big accounts swept", hint: "lists are kept for 3 days; free tiers show only the top few smart followers of each",
        actions: all.length > 6 ? btn(showAllSwept ? "Show fewer" : `Show all ${all.length}`, () => { showAllSwept = !showAllSwept; drawSwept(); }, { size: "sm", kind: "ghost" }) : null },
        h("div", { class: "cols-3 swept-grid" }, shown.map(([hd, e]) => sweptBlock(hd, e)))));
    }

    // ------------------------------------------------ candidates
    const candSearch = h("input", { class: "input", type: "search", placeholder: "Search candidates", "aria-label": "Search candidates", id: "candSearch" });
    candSearch.addEventListener("input", debounce(() => { cf.q = candSearch.value.trim().toLowerCase(); drawCandidates(true); }, 200));
    const candView = segFilter([["all", "All"], ["pass", "Pass"], ["smart", "Smart followers"], ["fail", "Not passing"]], cf.view, (v) => { cf.view = v; drawCandidates(true); }, { label: "Show candidates", id: "candView" });
    const candTier = selectEl([["suggested", "Suggested tier"], ["1", "Tier 1"], ["2", "Tier 2"]], "suggested", { class: "input input-sm", "aria-label": "Tier for added candidates", id: "candTier" });
    const candAddBtn = btn("Add to targets", () => addCandidates(), { kind: "primary", size: "sm", iconName: "plus", id: "candAddBtn", title: "Add the selected accounts to your targets (who already follows you is checked first)" });
    const candRemoveBtn = btn("Remove", async () => { const r = await ctx.send("candidatesRemove", { handles: [...candSelected] }, { label: "Remove candidates" }); if (r) { candSelected.clear(); drawCandidates(true); } }, { size: "sm", kind: "ghost", id: "candRemoveBtn" });
    const candClearBtn = btn("Clear all", async () => {
      if (!(await confirmDialog("Remove every candidate from the list?", { title: "Clear candidates", okLabel: "Clear", danger: true }))) return;
      const r = await ctx.send("candidatesClear", {}, { label: "Clear candidates" });
      if (r) { candSelected.clear(); toast("Candidates cleared"); }
    }, { size: "sm", kind: "ghost-danger", id: "candClearBtn" });
    const candSelInfo = h("span", { class: "small muted" });
    candTier.addEventListener("change", () => drawCandBar());
    const candBar = h("div", { class: "filterbar cand-bar", id: "candBar" },
      h("div", { class: "search-wrap" }, icon("search"), candSearch), candView, h("span", { class: "spacer" }), candClearBtn);
    const candActions = h("div", { class: "filterbar cand-actions", id: "candActions" }, candSelInfo, candTier, candAddBtn, candRemoveBtn);
    const candHost = h("div", { id: "candidatesTable" });
    const candCount = h("span", { class: "count", id: "candCount" }, "0");

    const addCandidates = async () => {
      const handles = [...candSelected];
      if (!handles.length) return;
      const cands = ctx.data[K.candidates] || {};
      const byTier = new Map();
      for (const hd of handles) {
        const tier = candTier.value === "suggested" ? C.tier(cands[hd] || {}) || 2 : Number(candTier.value);
        if (!byTier.has(tier)) byTier.set(tier, []);
        byTier.get(tier).push(hd);
      }
      const sum = { added: 0, updated: 0, blacklisted: 0 };
      let okAll = true;
      await busy(candAddBtn, async () => {
        for (const [tier, list] of byTier) {
          const r = await ctx.send("candidatesAdd", { handles: list, tier }, { label: "Add candidates" });
          if (r) { sum.added += num(r.added); sum.updated += num(r.updated); sum.blacklisted += num(r.blacklisted); } else okAll = false;
        }
      });
      if (sum.added || sum.updated || sum.blacklisted) addedToast(sum, "Added", " to your targets");
      if (okAll) candSelected.clear();
      drawCandidates(true);
    };
    function drawCandBar() {
      const n = candSelected.size;
      candSelInfo.textContent = n ? `${n} selected` : "";
      const tierTxt = candTier.value === "suggested" ? " (suggested tier)" : ` as Tier ${candTier.value}`;
      btnLabel(candAddBtn).textContent = n ? `Add ${n}${tierTxt}` : "Add to targets";
      candAddBtn.disabled = !n;
      candRemoveBtn.disabled = !n;
    }
    function filterCell(c) {
      if (C.followsYou(c)) return tag("follows you", "red", "Already follows you - ScoreX never comments on it");
      const p = C.pass(c), why = C.why(c), fl = C.flags(c);
      if (p === false) return h("span", { class: "filter-cell", title: why.join(", ") }, tag(truncate(why[0] || "filtered", 28), "red"), why.length > 1 ? h("span", { class: "small muted" }, ` +${why.length - 1}`) : null);
      if (p === true) return tag("pass", "green", "Passes your discovery filters");
      if (fl.length) return h("span", { class: "filter-cell" }, fl.slice(0, 2).map((x) => tag(String(x).replace(/_/g, " "), "amber")));
      return h("span", { class: "muted", title: "Not checked against the discovery filters yet (no profile visit)" }, "-");
    }
    function drawCandidates(force) {
      if (!force && candHost.contains(document.activeElement) && document.activeElement !== document.body) return;
      const all = Object.values(ctx.data[K.candidates] || {}).filter((c) => c && c.handle);
      const targetSet = new Set(ctx.targetList().map((t) => t.handle));
      const black = ctx.data[K.blacklist] || {};
      for (const hd of [...candSelected]) if (!all.some((c) => c.handle === hd)) candSelected.delete(hd);
      const counts = { all: all.length, pass: 0, smart: 0, fail: 0 };
      for (const c of all) { if (C.pass(c) === true && !C.followsYou(c)) counts.pass++; if (c.smart) counts.smart++; if (C.pass(c) === false || C.followsYou(c)) counts.fail++; }
      candView.setCounts(counts);
      candCount.textContent = String(all.length);
      const list = all.filter((c) => {
        if (cf.view === "pass" && !(C.pass(c) === true && !C.followsYou(c))) return false;
        if (cf.view === "smart" && !c.smart) return false;
        if (cf.view === "fail" && !(C.pass(c) === false || C.followsYou(c))) return false;
        if (cf.q && !`${c.handle} ${C.name(c)} ${C.bio(c)} ${C.sources(c).join(" ")}`.toLowerCase().includes(cf.q)) return false;
        return true;
      });
      // provider columns: enabled providers plus any provider that scored a candidate
      const pids = [...new Set([...providers.filter((p) => p.enabled).map((p) => p.id), ...all.flatMap((c) => Object.keys(c.providerScores || {}))])]
        .filter((pid) => all.some((c) => C.pscore(c, pid) != null));
      // "listed by k of n": n = big accounts swept (smart) or source accounts (common follows)
      const smartSrc = new Set(), otherSrc = new Set();
      for (const c of all) for (const s of C.sources(c)) (c.smart ? smartSrc : otherSrc).add(s);
      const nFor = (c) => Math.max(num(C.overlap(c)), c.smart ? smartSrc.size : Math.min(otherSrc.size, Math.max(1, ...all.filter((x) => !x.smart).map((x) => num(C.overlap(x))))));
      const hasRank = all.some((c) => C.score(c) != null);
      drawCandBar();
      const cols = [
        { key: "handle", label: "Account", render: (c) => h("div", { class: "who" },
          h("span", { class: "who-row" }, xLink(c.handle), targetSet.has(c.handle) ? tag("target", "", "Already a target") : null, Object.hasOwn(black, c.handle) ? tag("blacklisted", "red", "On your blacklist - it is skipped when added") : null),
          C.name(c) ? h("span", { class: "who-name", title: C.bio(c) }, C.name(c)) : null), sort: (c) => c.handle, defaultDir: "asc" },
        { key: "followers", label: "Followers", align: "right", render: (c) => fmtCount(C.followers(c)), sort: C.followers },
        ...pids.map((pid) => ({ key: "p_" + pid, label: h("span", { class: "th-prov" }, providerKey(pid), providerName(pid)), align: "right", title: `${providerName(pid)} score`, render: (c) => { const v = C.pscore(c, pid); return v == null ? "-" : fmtNum(v); }, sort: (c) => C.pscore(c, pid) })),
        hasRank ? { key: "score", label: "Rank", align: "right", title: "ScoreX rank (0-100) from the profile visit", render: (c) => { const v = C.score(c); return v == null ? "-" : String(Math.round(Number(v))); }, sort: C.score } : null,
        { key: "overlap", label: "Listed by", title: "How many of your source accounts list or follow this account", render: (c) => {
          const k = C.overlap(c) != null ? num(C.overlap(c)) : C.sources(c).length, n = Math.max(k, nFor(c));
          const s = C.sources(c);
          return h("span", { class: "listed", title: s.length ? s.join("\n") : "" }, k ? overlapDots(k, n, { label: `${k} of ${n}${s.length ? ": " + s.join(", ") : ""}` }) : null, h("span", { class: ["small muted", k && "listed-n"] }, k ? `${k} of ${n}` : s.length ? truncate(s[0], 28) : "-"));
        }, sort: (c) => num(C.overlap(c)) * 1e6 + Math.max(0, ...Object.values(c.providerScores || {}).map(num)) },
        { key: "suggested", label: "Suggested", sort: (c) => C.tier(c), render: (c) => (C.tier(c) ? tag("T" + C.tier(c), "", C.tier(c) === 1 ? "Tier 1: big influencer" : "Tier 2: smart account") : "-") },
        { key: "pass", label: "Filters", sort: (c) => (C.followsYou(c) || C.pass(c) === false ? 0 : C.pass(c) === true ? 2 : 1), render: filterCell },
      ].filter(Boolean);
      clear(candHost).appendChild(renderTable({
        columns: cols,
        rows: list,
        rowKey: (c) => c.handle,
        selection: candSelected,
        onSelectionChange: drawCandBar,
        sortState: candSort,
        maxRows: 100,
        empty: all.length ? "No candidates match." : "No candidates yet. Find smart followers or run a discovery above.",
        caption: "Candidates",
      }));
    }
    const candSec = section({ wide: true, id: "candidates", title: "Candidates", hint: "found by sweeps and discovery; accounts that follow you are never commented on", actions: candActions }, candBar, candHost);
    const candTitle = candSec.querySelector(".sec-title");
    if (candTitle) candTitle.appendChild(candCount);

    // ------------------------------------------------ layout
    add(root,
      h("div", { class: "disc-top" }, h("div", { class: "filterbar" }, srcSeg), formRow, optRow, hintEl, filtersAdv, discHost, sweepHost),
      lookHost,
      sweptHost,
      candSec);

    await loadProviders();
    drawForm();
    drawDiscovery();
    drawSweep();
    drawLookup();
    drawSwept();
    drawCandidates(true);
    ctx.on(K.discovery, () => { drawDiscovery(); drawForm(); });
    let inStop = isSafetyStop(ctx.state);
    ctx.on(K.state, () => { if (isSafetyStop(ctx.state) !== inStop) { inStop = !inStop; drawForm(); } });
    ctx.on(K.scoreboard, () => { drawSweep(); drawLookup(); drawSwept(); drawForm(); reloadProviders(); });
    ctx.on(K.candidates, () => drawCandidates());
    ctx.on(K.targets, () => { drawCandidates(); drawSwept(); });
    ctx.on(K.blacklist, () => drawCandidates());
    ctx.on("settings", reloadProviders);
    ctx.on("secrets", reloadProviders);
    const applyParams = (prm) => {
      if (prm && SOURCES.some(([v]) => v === prm.s) && prm.s !== src) { src = prm.s; drawForm(); }
      const hd = prm && normalizeHandle(prm.h);
      if (hd && hd !== lookupBusy && (hd !== focus || !(board().smart || {})[hd])) {
        if (smartProviders().length) lookup(hd);
        else { src = "smart"; dHandles.value = "@" + hd; focus = hd; drawForm(); drawLookup(); drawSwept(); }
      }
    };
    ctx.on("params", applyParams);
    applyParams(ctx.params);
  },
};
