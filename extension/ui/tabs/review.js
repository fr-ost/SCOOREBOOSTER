// Review: keyboard-first queue of pending replies (approve / edit / regenerate / skip) with a 5 s undo window, plus
// the approved replies waiting for their posting slot. Reads history from IndexedDB, acts through reviewAction.
// Approve and skip are held on the page for 5 s (Z undoes) and sent when the timer ends, on pagehide / when the tab
// is hidden, or when you leave the screen. Cards are kept by id across redraws, so focus, caret and edits survive.

import { K, HS, HARD, MODE, STATUS } from "../../lib/constants.js";
import { weightedLength } from "../../lib/quality.js";
import * as history from "../../lib/history.js";
import { followStatus, FS } from "../../lib/targets.js";
import { num } from "../../lib/util.js";
import {
  h, clear, section, btn, busy, toast, icon, tierBadge, followBadge, statusBadge, badge, xLink, link, confirmDialog, modal, emptyState,
  fmtUsd, fmtCount, fmtNum, fmtAgo, fmtTime, fmtIn, fmtDateTime, truncate, debounce, uidShort, add, isTyping, hasOverlay, announce,
  kbd, keyLegend, helpSheet, expiryChip, followDay, dayMeter, primaryProvider, providerName, providerKey, segmented, isSafetyStop,
} from "../components.js";
import { toneLabel } from "./targets.js";
import { PRESET_LABEL } from "./models.js";

const UNDO_MS = 5000;
const SORT_KEY = "sx.review.sort";
const MOD = /Mac|iPhone|iPad/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "") ? "⌘" : "Ctrl";
const readLS = (k) => { try { return window.localStorage.getItem(k); } catch (_) { return null; } };
const writeLS = (k, v) => { try { window.localStorage.setItem(k, v); } catch (_) { /* storage blocked */ } };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
// Unsaved edits (id -> { text, base }) live outside the screen, so leaving Review (rail, a link, the popup opening
// another screen in this tab) and coming back keeps them. They last until this dashboard tab is closed or reloaded.
const drafts = new Map();

export default {
  id: "review",
  title: "Review",
  async render(root, ctx) {
    const cards = new Map(); // id -> { el, ta, kind, rec, sig, followsNow, refs }
    const ops = new Map(); // id -> held approve / skip { id, rec, action, text, kind, until, timer, tick, el, sending }
    const regenerating = new Set(); // ids with a Regenerate request running (a card rebuilt meanwhile stays busy)
    let opOrder = [];
    let pending = [], waiting = [];
    let lastSig = null;
    let focusId = null;
    let sortKey = ["expiring", "newest", "priority"].includes(readLS(SORT_KEY)) ? readLS(SORT_KEY) : "expiring";
    const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // ------------------------------------------------ toolbar, legend, lists
    const pendingCount = h("span", { class: "count-chip", id: "pendingCountChip" }, "0");
    const waitingCount = h("span", { class: "count-chip" }, "0");
    const note = h("p", { class: "review-note", id: "reviewModeNote" });
    const pendingHost = h("div", { class: "review-list", id: "pendingList", "aria-label": "Replies waiting for review" });
    const waitingHost = h("div", { class: "review-list", id: "waitingList", "aria-label": "Approved replies waiting to post" });
    const sortSeg = segmented([["expiring", "Expiring first"], ["newest", "Newest"], ["priority", "Priority", false, "Tier, then score, then target priority"]], sortKey, (v) => {
      sortKey = v; writeLS(SORT_KEY, v);
      sortLists(); render();
      announce(`Sorted: ${{ expiring: "expiring first", newest: "newest first", priority: "by priority" }[v]}.`);
    }, { label: "Sort replies", cls: "review-sort" });
    sortSeg.id = "reviewSort";
    const approveAll = btn("Approve all", () => approveAllFlow(), { kind: "primary", iconName: "check", id: "approveAllBtn", title: "Approve every waiting reply (Shift+A)" });
    const skipAll = btn("Skip all", () => skipAllFlow(), { id: "skipAllBtn" });
    const help = helpSheet({
      title: "Review shortcuts",
      rows: [
        ["Next / previous", ["J", "K"]],
        ["Approve (keeps your edit)", ["A"]],
        ["Approve from the text box", [MOD, "Enter"]],
        ["Edit reply", ["E"]],
        ["Leave the text box", ["Esc"]],
        ["Skip", ["S"]],
        ["Regenerate (one more API call)", ["R"]],
        ["Open the post on X", ["O"]],
        ["Undo the last action (5 s)", ["Z"]],
        ["Approve all (asks first)", ["Shift", "A"]],
        ["Show or hide this list", ["?"]],
      ],
    });
    const helpBtn = h("button", { type: "button", class: "linkish keys-help", id: "reviewHelpBtn", onClick: () => help.toggle(), "aria-label": "Show all review shortcuts" }, kbd("?"), " all shortcuts");
    const legend = keyLegend([[["J", "K"], "next / previous"], ["A", "approve"], ["E", "edit"], ["S", "skip"], ["R", "regenerate"], ["O", "open post"], ["Z", "undo"]], { label: "Review keyboard shortcuts", cls: "review-keys" });
    legend.appendChild(helpBtn);

    add(root,
      section({ wide: true, className: "sec-flush review-sec" },
        h("div", { class: "review-toolbar" },
          h("h2", { class: "review-title" }, "Waiting for review", pendingCount),
          h("div", { class: "review-sortwrap" }, h("span", { class: "muted small", "aria-hidden": "true" }, "Sort"), sortSeg),
          h("span", { class: "spacer" }),
          skipAll, approveAll),
        legend, note, pendingHost),
      section({ wide: true, className: "review-sec", title: h("span", null, "Approved, waiting to post ", waitingCount), hint: "Posted one at a time with random gaps, only inside active hours." }, waitingHost));

    function drawNote() {
      const s = ctx.settings;
      const eff = s.mode === MODE.AUTO ? MODE.AUTO : MODE.REVIEW; // the saved settings (the status poll lags a save)
      note.textContent = eff === MODE.AUTO
        ? "Full auto is on: new replies go straight to the posting queue. Items here came from Review mode or need attention."
        : `Nothing posts until you approve it. Replies expire ${s.review.pendingMaxAgeMin} min after they are written; at most ${s.review.maxPending} wait at once.`;
    }

    // ------------------------------------------------ helpers
    const board = () => ctx.data[K.scoreboard] || {};
    const targetOf = (rec) => ctx.targets[rec.target] || null;
    const followsNowOf = (rec) => { const t = targetOf(rec); const fs = t ? followStatus(t) : null; return fs === FS.FOLLOWS || fs === FS.FOLLOWED_BACK; };
    function providerScore(t, pid) {
      if (!t || !t.score || !pid) return null;
      const p = t.score.providers && t.score.providers[pid];
      if (p && p.score != null && Number.isFinite(Number(p.score))) return Number(p.score);
      if (pid === "sorsa" && t.score.sorsa != null && Number.isFinite(Number(t.score.sorsa))) return Number(t.score.sorsa);
      return null;
    }
    const visible = (list) => list.filter((r) => !ops.has(r.id));
    const visibleIds = () => visible(pending).map((r) => r.id);
    function sortLists() {
      const pid = primaryProvider(ctx.settings, board());
      const prio = (r) => { const t = targetOf(r) || {}; return [Number(r.tier || t.tier) || 3, -(providerScore(t, pid) ?? -1), -num(t.priority), r.createdAt || 0]; };
      const cmp = {
        expiring: (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
        newest: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
        priority: (a, b) => { const x = prio(a), y = prio(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; },
      }[sortKey];
      pending.sort(cmp);
      waiting.sort((x, y) => (x.scheduledFor || x.createdAt || 0) - (y.scheduledFor || y.createdAt || 0));
    }
    function cardSig(rec, kind) {
      const s = ctx.settings, t = targetOf(rec), pid = primaryProvider(s, board());
      const fd = t ? followDay(t, s) : null;
      return JSON.stringify([kind, rec.status, rec.updatedAt, rec.comment, rec.scheduledFor, t ? followStatus(t) : null, t && t.tier, t && t.stats && t.stats.comments,
        t && t.rel && t.rel.gone, fd && [fd.day, fd.of, fd.near], pid, providerScore(t, pid), s.quality.maxChars, s.review.pendingMaxAgeMin]);
    }

    // ------------------------------------------------ cards
    // Why an approved reply will not post (the engine drops it), or "".
    const dropReason = (rec) => {
      if (rec.status === HS.POSTING) return "";
      if (!targetOf(rec)) return `@${rec.target} is no longer one of your targets, so this reply will be dropped instead of posted.`;
      return followsNowOf(rec) ? `@${rec.target} follows you now, so this reply will be dropped instead of posted.` : "";
    };
    function slotNode(rec) {
      if (rec.status === HS.POSTING) return [h("span", { class: "spinner" }), " Posting now…"];
      if (dropReason(rec)) return [icon("alert"), "Will not post"];
      const st = ctx.state;
      if (st.status !== STATUS.RUNNING) return [icon("history"), st.status === STATUS.PAUSED || isSafetyStop(st) ? "Posts after you resume" : "Posts after you press Start"];
      if (rec.scheduledFor && rec.scheduledFor > Date.now() + 30000) return [icon("history"), `Posts around ${fmtTime(rec.scheduledFor)} (${fmtIn(rec.scheduledFor)})`];
      return [icon("history"), "Posts in the next free slot"];
    }

    function buildCard(rec, kind) {
      const s = ctx.settings;
      const t = targetOf(rec);
      const followsNow = kind === "pending" && followsNowOf(rec);
      const dropNote = kind === "waiting" ? dropReason(rec) : "";
      const base = rec.comment || "";
      const d = drafts.get(rec.id);
      if (d && d.base !== base) drafts.delete(rec.id);
      const text = d && d.base === base ? d.text : base;
      const refs = {};

      const taId = uidShort("rc_");
      const ta = h("textarea", { class: "input comment-input", id: taId, rows: 3, dataset: { recId: rec.id, ctl: "ta" }, spellcheck: "true" });
      ta.value = text;
      const counter = h("span", { class: "char-count", title: "X counts CJK characters and emoji as two" });
      let saveBtn = null;
      const el = h("article", { class: ["review-card", kind === "waiting" && "is-waiting", (followsNow || dropNote) && "is-follows", regenerating.has(rec.id) && "is-regenerating"], dataset: { id: rec.id }, tabindex: "-1", "aria-label": `Reply to @${rec.target}` });
      const updateCount = () => {
        const n = weightedLength(ta.value);
        counter.textContent = `${n} / ${HARD.maxCommentChars}`;
        counter.className = "char-count" + (n > HARD.maxCommentChars ? " is-over" : n > s.quality.maxChars ? " is-warn" : "");
        counter.title = n > HARD.maxCommentChars ? "Too long for X" : n > s.quality.maxChars ? `Longer than your max (${s.quality.maxChars})` : "X counts CJK characters and emoji as two";
        const dirty = ta.value !== base;
        if (dirty) drafts.set(rec.id, { text: ta.value, base }); else drafts.delete(rec.id);
        el.classList.toggle("is-dirty", dirty);
        if (saveBtn) saveBtn.hidden = !dirty;
      };
      ta.addEventListener("input", updateCount);

      // quality notes
      const q = rec.quality || {};
      const notes = [];
      for (const r of Array.isArray(q.reasons) ? q.reasons : []) notes.push(String(r));
      let checkPassed = false;
      if (q.modelVerdict) {
        const mv = q.modelVerdict;
        if (typeof mv === "string") notes.push("Checker: " + mv);
        else if (mv.issue) notes.push("Checker: " + mv.issue);
        else if (mv.pass === true) checkPassed = true;
      }
      if (rec.reason && kind === "pending") notes.push(rec.reason);
      if (rec.fallbackUsed) notes.push("Fallback model was used");
      if (rec.abExplore) notes.push("A/B test variant");

      // post side
      const bio = (t && t.profile && t.profile.bio) || "";
      const name = rec.targetName || (t && (t.name || (t.profile && t.profile.name))) || "";
      const fd = t ? followDay(t, s) : null;
      const comments = t ? num(t.stats && t.stats.comments) : null;
      const pid = primaryProvider(s, board());
      const ps = providerScore(t, pid);
      const m = rec.postMetrics || {};
      const metrics = [["likes", "likes"], ["replies", "replies"], ["reposts", "reposts"], ["views", "views"]].filter(([k]) => m[k] != null).map(([k, l]) => `${fmtCount(num(m[k]))} ${l}`);
      refs.posted = rec.postCreatedAt ? h("span", { title: fmtDateTime(rec.postCreatedAt) }, "posted " + fmtAgo(rec.postCreatedAt)) : null;
      const post = h("div", { class: "rc-post" },
        h("header", { class: "review-card-head" },
          h("div", { class: "avatar", "aria-hidden": "true" }, (rec.target || "?").charAt(0).toUpperCase()),
          h("div", { class: "review-who" },
            h("div", { class: "review-who-line" }, xLink(rec.target), tierBadge(rec.tier || (t && t.tier)), t ? followBadge(t, s, { compact: true }) : null, kind === "waiting" ? statusBadge(rec.status) : null),
            name || bio ? h("div", { class: "review-bio", title: bio || name }, [name, bio ? truncate(bio, 110) : null].filter(Boolean).join(" · ")) : null)),
        t ? h("div", { class: "rc-ctx" },
          fd ? h("span", { class: "rc-day", title: `Day ${fd.day} of ${fd.of} before ScoreX gives up on @${rec.target}` }, `day ${fd.day}/${fd.of}`, dayMeter(t, s)) : null,
          h("span", null, `${plural(comments, "comment")} so far`),
          ps != null ? h("span", { class: "rc-score", title: `${providerName(pid)} score of @${rec.target}` }, providerKey(pid), `${providerName(pid)} ${fmtNum(ps)}`) : null) : null,
        h("div", { class: "post-text" }, rec.postText || h("span", { class: "muted" }, "(no text)")),
        h("div", { class: "rc-meta" },
          rec.postUrl ? link(rec.postUrl, h("span", null, "Open post ", icon("external")), { cls: "post-link" }) : null,
          refs.posted,
          rec.postIsQuote ? h("span", null, "quote") : null,
          rec.postHasMedia ? h("span", null, "media") : null,
          metrics.length ? h("span", null, metrics.join(" · ")) : null));
      if (refs.posted) refs.posted.dataset.ts = String(rec.postCreatedAt);

      // reply side
      refs.chip = h("span", { class: "rc-exp" }, kind === "pending" ? expiryChip(rec.createdAt, s.review.pendingMaxAgeMin) : null);
      refs.slot = kind === "waiting" ? h("span", { class: "slot" }, slotNode(rec)) : null;
      const actions = h("div", { class: "review-actions" });
      let approveBtn = null;
      if (kind === "pending") {
        approveBtn = btn("Approve", () => approve(rec), { kind: "primary", size: "sm", iconName: "check", disabled: followsNow, title: followsNow ? `@${rec.target} follows you now` : "Approve this text (A). It posts in its own time slot." });
        approveBtn.dataset.ctl = "approve";
        saveBtn = btn("Save", (e) => save(rec, e.currentTarget), { size: "sm", title: "Save your edit without approving" });
        saveBtn.dataset.ctl = "save";
        const regen = btn("Regenerate", () => regenerate(rec), { size: "sm", iconName: "refresh", title: "Write a new reply with the same model (R). This calls OpenAI and costs money.", disabled: regenerating.has(rec.id) });
        regen.dataset.ctl = "regen";
        if (regenerating.has(rec.id)) regen.classList.add("is-busy");
        const skip = btn("Skip", () => skip(rec), { size: "sm", kind: "ghost", title: "Do not reply to this post (S)" });
        skip.dataset.ctl = "skip";
        add(actions, skip, regen, saveBtn, approveBtn);
      } else if (rec.status !== HS.POSTING) {
        saveBtn = btn("Save", (e) => save(rec, e.currentTarget), { size: "sm", title: "Save your edit" });
        saveBtn.dataset.ctl = "save";
        const cancel = btn("Cancel post", () => startOp(rec, "skip", "", "waiting"), { size: "sm", kind: "ghost", title: "Do not post this reply" });
        cancel.dataset.ctl = "cancel";
        add(actions, cancel, saveBtn);
      }
      if (saveBtn) saveBtn.hidden = true;
      const metaBits = [
        h("span", null, rec.modelName || rec.modelId || "model?"),
        rec.effort ? h("span", { title: "Reasoning effort" }, "effort " + rec.effort) : null,
        rec.tone ? h("span", null, "tone " + toneLabel(rec.tone, s)) : null,
        rec.preset ? h("span", { title: "Model preset" }, `${PRESET_LABEL[rec.preset] || rec.preset} preset`) : null,
        h("span", { title: "Real OpenAI cost of this reply so far" }, fmtUsd(rec.cost)),
        rec.attempts > 1 ? h("span", null, `${rec.attempts} attempts`) : null,
        rec.edited ? h("span", null, "edited") : null,
        checkPassed ? h("span", { class: "rc-pass", title: "The quality check model approved this reply" }, "check passed") : null,
      ];
      const main = h("div", { class: "rc-main" },
        h("div", { class: "comment-head" },
          h("label", { class: "field-label", for: taId }, kind === "pending" ? "Reply" : "Reply (approved)"),
          refs.chip,
          h("span", { class: "spacer" }),
          counter),
        ta,
        notes.length ? h("ul", { class: "quality-notes" }, notes.map((n) => h("li", null, n))) : null,
        followsNow ? h("p", { class: "rc-note" }, `@${rec.target} follows you now, so this reply would be dropped. Approve is off; skip it.`) : null,
        dropNote ? h("p", { class: "rc-note" }, dropNote) : null,
        h("div", { class: "review-foot" },
          h("div", { class: "rc-foot-meta" }, metaBits),
          refs.slot,
          actions));
      add(el, post, main, h("div", { class: "regen-overlay", "aria-hidden": "true" }, h("span", { class: "spinner" }), "Writing a new reply…"));
      updateCount();
      return { el, ta, kind, rec, followsNow, refs, approveBtn };
    }

    function refreshClocks() {
      const s = ctx.settings;
      for (const c of cards.values()) {
        if (c.kind === "pending" && c.refs.chip) add(clear(c.refs.chip), expiryChip(c.rec.createdAt, s.review.pendingMaxAgeMin));
        if (c.kind === "waiting" && c.refs.slot) add(clear(c.refs.slot), slotNode(c.rec));
        if (c.refs.posted) c.refs.posted.textContent = "posted " + fmtAgo(Number(c.refs.posted.dataset.ts));
      }
    }

    // ------------------------------------------------ redraw (keyed; keeps focus, caret and scroll position)
    function syncHost(host, list, kind) {
      const desired = [];
      for (const rec of list) {
        const op = ops.get(rec.id);
        if (op) { desired.push(op.el); continue; }
        const sig = cardSig(rec, kind);
        let c = cards.get(rec.id);
        if (!c || c.kind !== kind || c.sig !== sig) {
          c = buildCard(rec, kind);
          c.sig = sig;
          cards.set(rec.id, c);
        } else c.rec = rec;
        desired.push(c.el);
      }
      const want = new Set(desired);
      for (const el of [...host.children]) if (!want.has(el)) el.remove();
      let ref = host.firstChild;
      for (const el of desired) {
        if (el === ref) { ref = ref.nextSibling; continue; }
        host.insertBefore(el, ref);
      }
    }
    function render() {
      // snapshot focus (element + caret) and the focused card's position
      const a = document.activeElement;
      const snap = a && a !== document.body && root.contains(a) ? {
        el: a, cardId: a.closest("[data-id]") && a.closest("[data-id]").dataset.id, ctl: a.dataset && a.dataset.ctl,
        start: typeof a.selectionStart === "number" ? a.selectionStart : null, end: typeof a.selectionEnd === "number" ? a.selectionEnd : null, st: a.scrollTop,
      } : null;
      const anchorId = focusId;
      const anchorOld = anchorId && cards.get(anchorId) ? cards.get(anchorId).el : null;
      const top0 = anchorOld && anchorOld.isConnected ? anchorOld.getBoundingClientRect().top : null;

      const live = new Set([...pending, ...waiting].map((r) => r.id));
      for (const id of [...cards.keys()]) if (!live.has(id)) cards.delete(id);
      syncHost(pendingHost, pending, "pending");
      syncHost(waitingHost, waiting, "waiting");
      if (!visible(pending).length && !pendingHost.querySelector(".review-undo")) {
        const st = ctx.state.status;
        clear(pendingHost).appendChild(emptyState("Nothing to review right now",
          st === "running"
            ? "ScoreX is watching your targets. New replies show up here a few minutes after a target posts."
            : "New replies appear here when ScoreX finds a fresh post from one of your targets. Press Start at the top to begin."));
      }
      if (!waiting.length) clear(waitingHost).appendChild(h("p", { class: "muted small" }, "No approved replies waiting to post."));
      const vp = visible(pending).length;
      pendingCount.textContent = String(vp);
      waitingCount.textContent = String(waiting.length);
      approveAll.disabled = !vp;
      skipAll.disabled = !vp;

      // keep a focused card (first one by default)
      const ids = visibleIds();
      if (!focusId || !ids.includes(focusId)) focusId = ids[0] || null;
      for (const [id, c] of cards) c.el.classList.toggle("is-focus", id === focusId && c.kind === "pending");

      // restore focus / caret
      if (snap) {
        let target = snap.el.isConnected ? snap.el : null;
        if (!target && snap.cardId && snap.ctl) target = root.querySelector(`[data-id="${CSS.escape(snap.cardId)}"] [data-ctl="${snap.ctl}"]`);
        if (!target && snap.cardId && cards.get(focusId)) target = cards.get(focusId).el;
        if (target && document.activeElement !== target && !target.disabled) {
          try {
            target.focus({ preventScroll: true });
            if (snap.start != null && typeof target.setSelectionRange === "function") { target.setSelectionRange(snap.start, snap.end); target.scrollTop = snap.st; }
          } catch (_) { /* gone */ }
        }
      }
      // new items above the focused card must not move it
      const anchorNew = anchorId && cards.get(anchorId) ? cards.get(anchorId).el : null;
      if (top0 != null && anchorNew && anchorNew.isConnected) {
        const dy = anchorNew.getBoundingClientRect().top - top0;
        if (Math.abs(dy) > 1) window.scrollBy(0, dy);
      }
    }

    async function load(force) {
      let p = [], a = [], q = [], po = [];
      try {
        [p, a, q, po] = await Promise.all([HS.PENDING_REVIEW, HS.APPROVED, HS.QUEUED, HS.POSTING].map((x) => history.byStatus(x)));
      } catch (e) {
        if (lastSig === null) { clear(pendingHost).appendChild(h("div", { class: "table-empty" }, "Could not read the history database: " + e.message)); lastSig = "err"; }
        return;
      }
      if (!root.isConnected) return;
      const sig = [...p, ...po, ...a, ...q].map((r) => `${r.id}:${r.status}:${r.updatedAt}`).sort().join("|");
      pending = p;
      waiting = [...po, ...a, ...q];
      const open = new Set([...pending, ...waiting].map((r) => r.id));
      for (const id of [...drafts.keys()]) if (!open.has(id)) drafts.delete(id); // posted, skipped or expired meanwhile
      // ops whose record is no longer where it was (handled elsewhere): drop them
      for (const [id, op] of ops) if (!op.sending && ![...pending, ...waiting].some((r) => r.id === id)) { clearTimeout(op.timer); clearInterval(op.tick); ops.delete(id); }
      if (!force && sig === lastSig) { refreshClocks(); return; }
      lastSig = sig;
      sortLists();
      render();
      if (force) ctx.refreshCounts();
    }
    const reload = () => { lastSig = null; return load(true); };

    // ------------------------------------------------ focus between cards
    function setFocus(id, { dom = true, scroll = true } = {}) {
      const c = id && cards.get(id);
      if (!c || c.kind !== "pending" || ops.has(id)) return;
      focusId = id;
      for (const [cid, x] of cards) x.el.classList.toggle("is-focus", cid === id && x.kind === "pending");
      if (dom && document.activeElement !== c.el) c.el.focus({ preventScroll: true });
      if (scroll) c.el.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
    }
    function move(delta) {
      const ids = visibleIds();
      if (!ids.length) return;
      const i = ids.indexOf(focusId);
      setFocus(ids[Math.max(0, Math.min(ids.length - 1, (i < 0 ? 0 : i + delta)))]);
    }
    pendingHost.addEventListener("focusin", (e) => {
      const c = e.target.closest && e.target.closest(".review-card");
      if (c && c.dataset.id && c.dataset.id !== focusId) setFocus(c.dataset.id, { dom: false, scroll: false });
    });
    pendingHost.addEventListener("mousedown", (e) => {
      const c = e.target.closest && e.target.closest(".review-card");
      if (c && c.dataset.id && c.dataset.id !== focusId) setFocus(c.dataset.id, { dom: false, scroll: false });
    });

    // ------------------------------------------------ held actions with undo
    function startOp(rec, action, text, kind) {
      if (ops.has(rec.id)) return;
      const ids = visibleIds();
      const i = ids.indexOf(rec.id);
      const verb = action === "approve" ? "Approved" : kind === "waiting" ? "Post cancelled" : "Skipped";
      const op = { id: rec.id, rec, action, text, kind, until: Date.now() + UNDO_MS, sending: false };
      const sec = h("span", { class: "undo-sec" });
      const undoBtn = h("button", { type: "button", class: "linkish undo-btn", onClick: () => undo(rec.id) }, "Undo (Z)");
      op.sec = sec; op.undoBtn = undoBtn;
      op.el = h("div", { class: ["review-undo", action === "approve" ? "is-approve" : "is-skip"], dataset: { id: rec.id } },
        h("span", { class: "undo-sq", "aria-hidden": "true" }),
        h("span", { class: "undo-text" }, `${verb} @${rec.target}`), h("span", { class: "muted", "aria-hidden": "true" }, "·"), undoBtn, sec);
      const tickFn = () => { sec.textContent = `${Math.max(0, Math.ceil((op.until - Date.now()) / 1000))}s`; };
      tickFn();
      op.tick = setInterval(tickFn, 250);
      op.timer = setTimeout(() => commitOp(rec.id), UNDO_MS);
      ops.set(rec.id, op);
      opOrder.push(rec.id);
      const hadFocus = root.contains(document.activeElement);
      if (kind === "pending" && i >= 0) {
        const rest = ids.filter((x) => x !== rec.id);
        focusId = rest[Math.min(i, rest.length - 1)] || null;
      }
      render();
      const left = visible(pending).length;
      if (kind === "pending") {
        if (focusId && hadFocus) setFocus(focusId);
        else if (hadFocus) undoBtn.focus({ preventScroll: true });
        announce(`${verb} @${rec.target}. ${left ? plural(left, "reply", "replies") + " left." : "Queue empty."} Press Z to undo.`);
      } else announce(`${verb} @${rec.target}. Press Z to undo.`);
    }
    async function commitOp(id) {
      const op = ops.get(id);
      if (!op || op.sending) return;
      op.sending = true;
      clearTimeout(op.timer); clearInterval(op.tick);
      op.undoBtn.remove(); op.sec.textContent = "sending…";
      op.el.classList.add("is-sending");
      // The message is dispatched synchronously here, so this also works from pagehide.
      const r = await ctx.send("reviewAction", { id, action: op.action, text: op.action === "approve" ? op.text : "" }, { label: op.action === "approve" ? "Approve" : op.kind === "waiting" ? "Cancel post" : "Skip" });
      ops.delete(id);
      opOrder = opOrder.filter((x) => x !== id);
      if (r) drafts.delete(id);
      if (root.isConnected) { await reload(); ctx.refreshCounts(); }
    }
    function undo(id) {
      const target = id || [...opOrder].reverse().find((x) => ops.has(x) && !ops.get(x).sending);
      const op = target && ops.get(target);
      if (!op || op.sending) { announce("Nothing to undo."); return; }
      clearTimeout(op.timer); clearInterval(op.tick);
      ops.delete(target);
      opOrder = opOrder.filter((x) => x !== target);
      render();
      if (op.kind === "pending") setFocus(target); else { const c = cards.get(target); if (c) c.el.focus({ preventScroll: true }); }
      announce(`Undone: @${op.rec.target} is back${op.kind === "pending" ? " in the queue" : " in the posting queue"}.`);
    }
    function flushAll() { for (const id of [...ops.keys()]) commitOp(id); }
    const onHidden = () => { if (document.visibilityState === "hidden") flushAll(); };
    window.addEventListener("pagehide", flushAll);
    document.addEventListener("visibilitychange", onHidden);
    ctx.onDispose(() => {
      window.removeEventListener("pagehide", flushAll);
      document.removeEventListener("visibilitychange", onHidden);
      document.removeEventListener("keydown", onKey);
      help.close();
      flushAll();
    });

    // ------------------------------------------------ actions
    function approve(rec) {
      const c = cards.get(rec.id);
      if (!c || c.kind !== "pending" || ops.has(rec.id)) return;
      if (c.followsNow) { toast(`@${rec.target} follows you now, so this reply would be dropped. Skip it instead.`, { type: "warn" }); return; }
      const v = c.ta.value.trim();
      if (!v) { toast("The reply is empty.", { type: "warn" }); return; }
      if (weightedLength(v) > HARD.maxCommentChars) { toast(`Too long: X allows ${HARD.maxCommentChars} (CJK characters and emoji count double).`, { type: "warn" }); return; }
      startOp(rec, "approve", v, "pending");
    }
    function skip(rec) {
      const c = cards.get(rec.id);
      if (!c || c.kind !== "pending" || ops.has(rec.id)) return;
      startOp(rec, "skip", "", "pending");
    }
    function save(rec, button) {
      const c = cards.get(rec.id);
      if (!c) return;
      const v = c.ta.value.trim();
      if (weightedLength(v) > HARD.maxCommentChars) { toast(`Too long: X allows ${HARD.maxCommentChars}.`, { type: "warn" }); return; }
      return busy(button, async () => {
        const r = await ctx.send("reviewAction", { id: rec.id, action: "save", text: v }, { label: "Save edit" });
        if (r) { drafts.delete(rec.id); toast("Edit saved", { type: "success" }); await reload(); }
      });
    }
    // The busy state lives in `regenerating`, not on the button: a live redraw can rebuild the card while the model
    // writes, and the new card must not offer a second (paid) Regenerate.
    function setRegenBusy(id, on) {
      const c = cards.get(id);
      if (!c) return;
      c.el.classList.toggle("is-regenerating", on);
      const b = c.el.querySelector('[data-ctl="regen"]');
      if (b) { b.disabled = on; b.classList.toggle("is-busy", on); }
    }
    async function regenerate(rec) {
      const c = cards.get(rec.id);
      if (!c || c.kind !== "pending" || ops.has(rec.id) || regenerating.has(rec.id)) return;
      regenerating.add(rec.id);
      setRegenBusy(rec.id, true);
      announce(`Writing a new reply for @${rec.target}…`);
      try {
        const r = await ctx.send("reviewAction", { id: rec.id, action: "regenerate", text: c.ta.value.trim() }, { label: "Regenerate" });
        if (r) {
          drafts.delete(rec.id);
          const extra = r.record && r.record.cost != null ? Math.max(0, num(r.record.cost) - num(rec.cost)) : null;
          toast(`New reply written${extra ? ` · cost ${fmtUsd(extra)}` : ""}`, { type: "success" });
          announce(`New reply for @${rec.target} is ready.`);
        }
      } finally {
        regenerating.delete(rec.id);
        setRegenBusy(rec.id, false);
      }
      if (root.isConnected) await reload();
    }
    function openPost(rec) {
      if (!rec.postUrl) { toast("This post has no link.", { type: "warn" }); return; }
      window.open(rec.postUrl, "_blank", "noopener,noreferrer");
    }
    function editFocused() {
      const c = focusId && cards.get(focusId);
      if (!c) return;
      c.ta.focus({ preventScroll: true });
      const n = c.ta.value.length;
      try { c.ta.setSelectionRange(n, n); } catch (_) { /* not a text control */ }
      c.el.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
    }

    // Approve all: never throws away unsaved edits (asks which text to use), leaves out accounts that follow you now.
    async function approveAllFlow() {
      const list = visible(pending);
      if (!list.length) return;
      help.close();
      const blocked = list.filter((r) => followsNowOf(r));
      const okList = list.filter((r) => !followsNowOf(r));
      if (!okList.length) { toast("Every waiting reply is to an account that follows you now. Skip them instead.", { type: "warn" }); return; }
      const dirty = okList.filter((r) => drafts.has(r.id) && drafts.get(r.id).text.trim() !== (r.comment || "").trim());
      const leftOut = blocked.length ? ` ${plural(blocked.length, "reply", "replies")} to accounts that follow you now ${blocked.length === 1 ? "is" : "are"} left out.` : "";
      let mode = "originals";
      if (dirty.length) {
        mode = await new Promise((resolve) => {
          modal({
            title: "Approve all",
            body: h("div", { class: "stack-sm" },
              h("p", { class: "modal-text" }, `${plural(dirty.length, "item has", "items have")} unsaved edits: ${dirty.map((r) => "@" + r.target).join(", ")}.`),
              h("p", { class: "modal-text muted" }, `Approve all ${okList.length}? They post one by one inside your safety limits.${leftOut}`)),
            actions: [
              { label: "Cancel", value: null },
              { label: "Approve originals", value: "originals", id: "approveOriginalsBtn" },
              { label: "Approve with my edits", kind: "primary", value: "edits", id: "approveEditsBtn" },
            ],
            onClose: (v) => resolve(v || null),
          });
        });
        if (!mode) return;
      } else if (!(await confirmDialog(`Approve all ${plural(okList.length, "reply", "replies")}? They post one by one inside your safety limits.${leftOut}`, { title: "Approve all", okLabel: "Approve all" }))) return;
      approveAll.disabled = true;
      let n = 0;
      const problems = [];
      try {
        const bulk = mode === "edits" ? okList.filter((r) => !dirty.includes(r)) : okList;
        if (mode === "edits") {
          for (const r of dirty) {
            const v = drafts.get(r.id).text.trim();
            if (!v || weightedLength(v) > HARD.maxCommentChars) { problems.push(`@${r.target} (${v ? "too long" : "empty"})`); continue; }
            const res = await ctx.send("reviewAction", { id: r.id, action: "approve", text: v }, { label: `Approve @${r.target}` });
            if (res) { n++; drafts.delete(r.id); } else problems.push("@" + r.target);
          }
        }
        if (bulk.length) {
          const res = await ctx.send("reviewApproveAll", { ids: bulk.map((r) => r.id) }, { label: "Approve all" });
          if (res) { n += num(res.count); for (const r of bulk) drafts.delete(r.id); }
        }
      } finally { approveAll.disabled = false; }
      toast(`Approved ${n}${problems.length ? `. Not approved: ${problems.join(", ")}` : ""}`, { type: problems.length ? "warn" : "success" });
      announce(`Approved ${plural(n, "reply", "replies")}.`);
      await reload();
    }
    async function skipAllFlow() {
      const list = visible(pending);
      if (!list.length) return;
      help.close();
      const ids = list.map((r) => r.id);
      if (!(await confirmDialog(`Skip all ${plural(list.length, "reply", "replies")}? Skipped replies are kept in Results.`, { title: "Skip all", okLabel: "Skip all", danger: true }))) return;
      const r = await ctx.send("reviewSkipAll", { ids }, { label: "Skip all" });
      if (r) { for (const id of ids) drafts.delete(id); toast(`Skipped ${num(r.count)}`, { type: "success" }); announce(`Skipped ${plural(num(r.count), "reply", "replies")}.`); await reload(); }
    }

    // ------------------------------------------------ keyboard
    function onKey(e) {
      if (!root.isConnected || e.defaultPrevented) return;
      if (document.querySelector(".modal-overlay")) return;
      if (hasOverlay() && !help.isOpen()) return; // a drawer, sheet or menu is open
      const k = e.key;
      const mod = e.ctrlKey || e.metaKey;
      if (isTyping(e)) {
        const ta = e.target && e.target.closest && e.target.closest("textarea[data-rec-id]");
        if (!ta || !root.contains(ta)) return;
        const c = cards.get(ta.dataset.recId);
        if (k === "Escape") { e.preventDefault(); if (c && c.kind === "pending") setFocus(c.rec.id, { scroll: false }); else ta.blur(); return; }
        if (k === "Enter" && mod && !e.altKey && !e.shiftKey && c && c.kind === "pending") { e.preventDefault(); approve(c.rec); }
        return;
      }
      if (e.altKey || mod) return;
      if (k === "?" || (k === "/" && e.shiftKey)) { e.preventDefault(); help.toggle(); return; }
      const a = document.activeElement;
      const onCardOrPage = !a || a === document.body || (a.classList && a.classList.contains("review-card"));
      const c = focusId ? cards.get(focusId) : null;
      const lower = k.length === 1 ? k.toLowerCase() : k;
      if (e.shiftKey && lower !== "a") return;
      switch (lower) {
        case "j": e.preventDefault(); move(1); break;
        case "k": e.preventDefault(); move(-1); break;
        case "ArrowDown": case "ArrowUp":
          if (!onCardOrPage && !(a && a.closest && a.closest(".review-card"))) return;
          e.preventDefault(); move(lower === "ArrowDown" ? 1 : -1); break;
        case "a":
          e.preventDefault();
          if (e.shiftKey) approveAllFlow(); else if (c) approve(c.rec);
          break;
        case "e": if (c) { e.preventDefault(); editFocused(); } break;
        case "Enter": if (c && onCardOrPage) { e.preventDefault(); editFocused(); } break;
        case "s": if (c) { e.preventDefault(); skip(c.rec); } break;
        case "r": if (c) { e.preventDefault(); regenerate(c.rec); } break;
        case "o": if (c) { e.preventDefault(); openPost(c.rec); } break;
        case "z": e.preventDefault(); undo(); break;
        default: break;
      }
    }
    document.addEventListener("keydown", onKey);

    // ------------------------------------------------ start
    drawNote();
    await load(true);
    const soon = debounce(() => load(false), 400);
    ctx.interval(() => { if (document.visibilityState === "visible") load(false); }, 5000);
    ctx.on(K.state, soon);
    ctx.on("counts", soon);
    ctx.on("status", drawNote);
    ctx.on("settings", () => { drawNote(); lastSig = null; soon(); });
    ctx.on(K.targets, () => { lastSig = null; soon(); });
    ctx.on(K.scoreboard, () => { if (sortKey === "priority") { lastSig = null; soon(); } });
    ctx.on("tick", refreshClocks);
  },
};
