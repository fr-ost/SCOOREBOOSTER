// Review Queue tab: pending comments to approve / edit / regenerate / skip, plus approved & queued items
// waiting for their posting slot. Reads history from IndexedDB, acts through reviewAction messages.

import { K, HS, HARD, MODE } from "../../lib/constants.js";
import { weightedLength } from "../../lib/quality.js";
import * as history from "../../lib/history.js";
import { num } from "../../lib/util.js";
import { h, clear, section, btn, busy, toast, icon, groupBadge, tierBadge, statusBadge, badge, xLink, link, confirmDialog, emptyState, fmtUsd, fmtCount, fmtAgo, fmtTime, fmtIn, fmtDateTime, truncate, debounce, uidShort, add } from "../components.js";
import { toneLabel } from "./targets.js";

export default {
  id: "review",
  title: "Review Queue",
  hint: "Edit, approve or skip each comment. Approved comments post one at a time in their own slot.",
  async render(root, ctx) {
    const drafts = new Map(); // id -> { text, base }
    let lastSig = null;
    let pending = [], waiting = [];

    const head = h("p", { class: "note" });
    const pendingHost = h("div", { class: "review-list", id: "pendingList" });
    const waitingHost = h("div", { class: "review-list", id: "waitingList" });
    const pendingCount = h("span", { class: "count-chip" }, "0");
    const waitingCount = h("span", { class: "count-chip" }, "0");

    const approveAll = btn("Approve all", async (e) => {
      if (!pending.length) return;
      const dirty = [...drafts.keys()].filter((id) => pending.some((r) => r.id === id)).length;
      const msg = `Approve all ${pending.length} pending comment${pending.length === 1 ? "" : "s"}? They post one by one inside your safety limits.` + (dirty ? ` ${dirty} unsaved edit${dirty === 1 ? " is" : "s are"} not included - save them first.` : "");
      const ids = pending.map((r) => r.id); // only what the user saw when clicking
      if (!(await confirmDialog(msg, { title: "Approve all", okLabel: "Approve all" }))) return;
      const r = await ctx.send("reviewApproveAll", { ids }, { label: "Approve all" });
      if (r) { toast(`Approved ${num(r.count)}`, { type: "success" }); load(true); }
    }, { kind: "primary", iconName: "check", id: "approveAllBtn" });
    const skipAll = btn("Skip all", async () => {
      if (!pending.length) return;
      const ids = pending.map((r) => r.id);
      if (!(await confirmDialog(`Skip all ${pending.length} pending comment${pending.length === 1 ? "" : "s"}? Skipped comments are kept in History.`, { title: "Skip all", okLabel: "Skip all", danger: true }))) return;
      const r = await ctx.send("reviewSkipAll", { ids }, { label: "Skip all" });
      if (r) { toast(`Skipped ${num(r.count)}`, { type: "success" }); load(true); }
    }, { id: "skipAllBtn" });

    add(root,
      section({ wide: true, className: "sec-flush", title: h("span", null, "Waiting for your review ", pendingCount), actions: [skipAll, approveAll] }, head, pendingHost),
      section({ wide: true, title: h("span", null, "Approved, waiting to post ", waitingCount), hint: "Posted one at a time with random gaps, only inside active hours." }, waitingHost));

    function drawHead() {
      const s = ctx.settings;
      const st = ctx.status;
      const eff = (st && st.effectiveMode) || (s.mode === MODE.AUTO ? MODE.AUTO : MODE.REVIEW);
      head.textContent = eff === MODE.AUTO
        ? "Full auto is on: new comments go straight to the posting queue. Items here came from Review mode or need attention."
        : `Review mode: nothing posts until you approve it. Pending items expire after ${s.review.pendingMaxAgeMin} min; at most ${s.review.maxPending} wait at once.`;
    }

    function snapshotFocus() {
      const a = document.activeElement;
      if (a && a.tagName === "TEXTAREA" && a.dataset.recId) return { id: a.dataset.recId, start: a.selectionStart, end: a.selectionEnd, scroll: a.scrollTop };
      return null;
    }
    function restoreFocus(f) {
      if (!f) return;
      const ta = root.querySelector(`textarea[data-rec-id="${CSS.escape(f.id)}"]`);
      if (!ta) return;
      ta.focus();
      try { ta.setSelectionRange(f.start, f.end); ta.scrollTop = f.scroll; } catch (_) {}
    }

    async function act(rec, action, text, button, cardEl) {
      const labels = { approve: "Approve", save: "Save edit", regenerate: "Regenerate", skip: "Skip" };
      return busy(button, async () => {
        if (action === "regenerate") cardEl.classList.add("is-regenerating");
        try {
          const r = await ctx.send("reviewAction", { id: rec.id, action, text }, { label: labels[action] });
          if (r) {
            drafts.delete(rec.id);
            toast(action === "approve" ? "Approved - it will post in its slot" : action === "save" ? "Edit saved" : action === "regenerate" ? "New comment generated" : "Skipped", { type: "success" });
            await load(true);
          }
          return r;
        } finally { cardEl.classList.remove("is-regenerating"); }
      });
    }

    function buildCard(rec, kind) {
      const s = ctx.settings;
      const t = ctx.targets[rec.target] || {};
      const bio = (t.profile && t.profile.bio) || "";
      const d = drafts.get(rec.id);
      const text = d && d.base === (rec.comment || "") ? d.text : rec.comment || "";
      if (d && d.base !== (rec.comment || "")) drafts.delete(rec.id);

      const taId = uidShort("rc_");
      const ta = h("textarea", { class: "input comment-input", id: taId, rows: 3, dataset: { recId: rec.id }, spellcheck: "true" });
      ta.value = text;
      const counter = h("span", { class: "char-count", "aria-live": "polite" });
      const updateCount = () => {
        const n = weightedLength(ta.value); // X's count: CJK characters and emoji count double
        counter.textContent = `${n} / ${HARD.maxCommentChars}`;
        counter.className = "char-count" + (n > HARD.maxCommentChars ? " is-over" : n > s.quality.maxChars ? " is-warn" : "");
        counter.title = n > HARD.maxCommentChars ? "Too long for X" : n > s.quality.maxChars ? `Longer than your max (${s.quality.maxChars})` : "";
        const dirty = ta.value !== (rec.comment || "");
        if (dirty) drafts.set(rec.id, { text: ta.value, base: rec.comment || "" }); else drafts.delete(rec.id);
        el.classList.toggle("is-dirty", dirty);
        if (saveBtn) saveBtn.disabled = !dirty;
      };
      ta.addEventListener("input", updateCount);

      const m = rec.postMetrics || {};
      const metrics = [["likes", "likes"], ["replies", "replies"], ["reposts", "reposts"], ["views", "views"]].filter(([k]) => m[k] != null).map(([k, l]) => h("span", { class: "metric" }, h("strong", null, fmtCount(num(m[k]))), " " + l));
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

      let saveBtn = null;
      const el = h("article", { class: ["review-card", kind === "waiting" && "is-waiting"], dataset: { id: rec.id } });
      const actions = h("div", { class: "review-actions" });
      if (kind === "pending") {
        const approve = btn("Approve", (e) => {
          const v = ta.value.trim();
          if (!v) { toast("The comment is empty.", { type: "warn" }); return; }
          if (weightedLength(v) > HARD.maxCommentChars) { toast(`Too long: X allows ${HARD.maxCommentChars} (CJK characters and emoji count double).`, { type: "warn" }); return; }
          act(rec, "approve", v, e.currentTarget, el);
        }, { kind: "primary", size: "sm", iconName: "check", title: "Approve this text; it posts in its time slot" });
        saveBtn = btn("Save", (e) => act(rec, "save", ta.value.trim(), e.currentTarget, el), { size: "sm", title: "Save your edit without approving" });
        const regen = btn("Regenerate", (e) => act(rec, "regenerate", ta.value.trim(), e.currentTarget, el), { size: "sm", iconName: "refresh", title: "Writes a new comment with the same model. This calls OpenAI and costs money." });
        const skip = btn("Skip", (e) => act(rec, "skip", "", e.currentTarget, el), { size: "sm", kind: "ghost", title: "Do not post anything for this post" });
        add(actions, skip, h("span", { class: "spacer" }), regen, saveBtn, approve);
      } else if (rec.status !== HS.POSTING) {
        saveBtn = btn("Save", (e) => act(rec, "save", ta.value.trim(), e.currentTarget, el), { size: "sm", title: "Save your edit" });
        const skip = btn("Cancel post", (e) => act(rec, "skip", "", e.currentTarget, el), { size: "sm", kind: "ghost", title: "Skip: do not post this comment" });
        add(actions, skip, h("span", { class: "spacer" }), saveBtn);
      }
      if (saveBtn) saveBtn.disabled = true;

      const when = rec.status === HS.POSTING
        ? h("span", { class: "slot" }, h("span", { class: "spinner" }), " Posting now…")
        : rec.scheduledFor
          ? h("span", { class: "slot" }, icon("history"), `Posts around ${fmtTime(rec.scheduledFor)} (${fmtIn(rec.scheduledFor)})`)
          : kind === "waiting" ? h("span", { class: "slot" }, "Waiting for the next free slot") : h("span", { class: "slot" });

      add(el,
        h("div", { class: "rc-post" },
          h("header", { class: "review-card-head" },
            h("div", { class: "avatar", "aria-hidden": "true" }, (rec.target || "?").charAt(0).toUpperCase()),
            h("div", { class: "review-who" },
              h("div", { class: "review-who-line" }, xLink(rec.target), groupBadge(rec.group || t.group), tierBadge(rec.tier || t.tier), kind === "waiting" ? statusBadge(rec.status) : null),
              rec.targetName || t.name || bio ? h("div", { class: "review-bio", title: bio || "" }, [rec.targetName || t.name, bio ? truncate(bio, 120) : null].filter(Boolean).join(" · ")) : null)),
          h("div", { class: "post-meta" },
            rec.postUrl ? link(rec.postUrl, h("span", null, "Open post ", icon("external")), { cls: "post-link" }) : h("span", null, "Post"),
            rec.postCreatedAt ? h("span", { title: fmtDateTime(rec.postCreatedAt) }, "posted " + fmtAgo(rec.postCreatedAt)) : null,
            rec.postIsQuote ? badge("quote", "grey") : null,
            rec.postHasMedia ? badge("media", "grey") : null),
          h("div", { class: "post-text" }, rec.postText || h("span", { class: "muted" }, "(no text)")),
          metrics.length ? h("div", { class: "metrics" }, metrics) : null),
        h("div", { class: "rc-main" },
          h("div", { class: "comment-head" },
            h("label", { class: "field-label", for: taId }, kind === "pending" ? `Reply to @${rec.target}` : `Reply to post for @${rec.target}`),
            h("span", { class: "when", title: "Generated " + fmtDateTime(rec.createdAt) }, "generated " + fmtAgo(rec.createdAt)),
            h("span", { class: "spacer" }),
            counter),
          ta,
          h("div", { class: "comment-meta" },
            h("span", { class: "mono" }, rec.modelName || rec.modelId || "model?"),
            rec.effort ? h("span", null, "effort " + rec.effort) : null,
            rec.tone ? h("span", null, "tone " + toneLabel(rec.tone, s)) : null,
            rec.preset ? h("span", null, "preset " + rec.preset) : null,
            h("span", { class: "mono", title: "Real OpenAI cost of this comment so far" }, fmtUsd(rec.cost)),
            rec.attempts > 1 ? h("span", null, `${rec.attempts} attempts`) : null,
            rec.edited ? badge("edited", "grey") : null,
            checkPassed ? badge("check passed", "green", "The quality check model approved this comment") : null),
          notes.length ? h("ul", { class: "quality-notes" }, notes.map((n) => h("li", null, n))) : null,
          h("div", { class: "review-foot" }, when, actions)),
        h("div", { class: "regen-overlay", "aria-hidden": "true" }, h("span", { class: "spinner" }), "Generating a new comment…"));
      updateCount();
      return el;
    }

    function draw() {
      const focus = snapshotFocus();
      pendingCount.textContent = String(pending.length);
      waitingCount.textContent = String(waiting.length);
      approveAll.disabled = !pending.length;
      skipAll.disabled = !pending.length;
      clear(pendingHost);
      if (!pending.length) {
        const st = ctx.state.status;
        pendingHost.appendChild(emptyState("Nothing to review right now",
          st === "running"
            ? "ScoreX is watching your targets. New comments show up here within a few minutes of a fresh post."
            : "New comments appear here when ScoreX finds a fresh post from one of your targets. Press Start at the top to begin."));
      } else for (const r of pending) pendingHost.appendChild(buildCard(r, "pending"));
      clear(waitingHost);
      if (!waiting.length) waitingHost.appendChild(h("p", { class: "muted small" }, "No approved comments waiting to post."));
      else for (const r of waiting) waitingHost.appendChild(buildCard(r, "waiting"));
      restoreFocus(focus);
    }

    async function load(force) {
      let p = [], a = [], q = [], po = [];
      try {
        [p, a, q, po] = await Promise.all([HS.PENDING_REVIEW, HS.APPROVED, HS.QUEUED, HS.POSTING].map((x) => history.byStatus(x)));
      } catch (e) {
        if (lastSig === null) { clear(pendingHost).appendChild(h("div", { class: "table-empty" }, "Could not read the history database: " + e.message)); lastSig = "err"; }
        return;
      }
      const nextPending = p.sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
      const nextWaiting = [...po, ...a, ...q].sort((x, y) => (x.scheduledFor || x.createdAt || 0) - (y.scheduledFor || y.createdAt || 0));
      const sig = [...nextPending, ...nextWaiting].map((r) => `${r.id}:${r.status}:${r.updatedAt}`).join("|");
      pending = nextPending;
      waiting = nextWaiting;
      if (!force && sig === lastSig) return;
      lastSig = sig;
      draw();
      if (force) ctx.refreshCounts();
    }

    drawHead();
    await load(true);
    const soon = debounce(() => load(false), 400);
    ctx.interval(() => { if (document.visibilityState === "visible") load(false); }, 5000);
    ctx.on(K.state, soon);
    ctx.on("counts", soon);
    ctx.on("status", drawHead);
    ctx.on("settings", drawHead);
    ctx.on(K.targets, () => { lastSig = null; soon(); });
    // Keep relative times fresh.
    ctx.on("tick", () => {
      const a = document.activeElement;
      if (a && a.dataset && a.dataset.recId) return; // never rebuild under the user's cursor just for clocks
      lastSig = null;
      load(false);
    });
  },
};
