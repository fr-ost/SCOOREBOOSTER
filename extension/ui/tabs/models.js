// Models & costs tab. Essentials: OpenAI key + test, the three presets, the preset per tier, the cost
// estimator and the monthly budget. Advanced: editable model/price table, fallback models, quality checker.
// Spend reports (totals per model / day / week / month, performance per model and tone) live in Results > Spend.

import { K, EFFORTS, PRESET_KEYS } from "../../lib/constants.js";
import { getSecrets, setSecrets } from "../../lib/store.js";
import { estimate, usageStats, budgetStatus, ASSUME } from "../../lib/costs.js";
import { dailyLimit } from "../../lib/safety.js";
import * as history from "../../lib/history.js";
import { num } from "../../lib/util.js";
import { h, clear, section, sub, advanced, btn, busy, toast, icon, selectEl, labeled, confirmDialog, progressBar, maskKey, getPath, setPath, fmtUsd, fmtTokens, fmtNum, uidShort, badge, debounce, add, fill } from "../components.js";

export const PRESET_LABEL = { high: "High quality", balanced: "Balanced", cheap: "Cheap" };
const effortOpts = EFFORTS.map((e) => [e, e.charAt(0).toUpperCase() + e.slice(1)]);
const modelOpts = (s, withNone) => [...(withNone ? [["", "None"]] : []), ...s.models.map((m) => [m.id, `${m.label}${m.name ? " - " + m.name : " (no model name)"}`])];

// Masked secret editor: shows "sk-…abcd" + Replace / Remove once saved. Never logs or re-displays the key.
export function secretField(ctx, { key, label, placeholder, hint, id, onChange }) {
  const box = h("div", { class: "secret-field", id: id || null });
  let replacing = false;
  async function draw() {
    let has = false, masked = "";
    try { const sec = await getSecrets(); has = !!sec[key]; masked = maskKey(sec[key]); } catch (_) {}
    clear(box);
    if (has && !replacing) {
      add(box, 
        h("div", { class: "field-label" }, label),
        h("div", { class: "secret-row" },
          h("code", { class: "masked-key", "data-masked": "1" }, masked),
          badge("saved", "green"),
          btn("Replace", () => { replacing = true; draw(); }, { size: "sm" }),
          btn("Remove", async () => {
            if (!(await confirmDialog(`Remove the saved ${label}?`, { title: "Remove key", okLabel: "Remove", danger: true }))) return;
            await setSecrets({ [key]: "" });
            toast(`${label} removed`);
            draw(); if (onChange) onChange(false);
          }, { size: "sm", kind: "ghost-danger" })),
        hint ? h("div", { class: "field-hint" }, hint) : null);
      return;
    }
    const inputId = uidShort("k_");
    const input = h("input", { id: inputId, type: "password", class: "input", placeholder: placeholder || "", autocomplete: "off", spellcheck: "false", "data-lpignore": "true" });
    const save = async () => {
      const v = input.value.trim();
      if (!v) { toast("Paste a key first.", { type: "warn" }); return; }
      if (/\s/.test(v)) { toast("The key contains spaces - check that you pasted only the key.", { type: "warn" }); return; }
      await setSecrets({ [key]: v });
      input.value = "";
      replacing = false;
      toast(`${label} saved`, { type: "success" });
      draw(); if (onChange) onChange(true);
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } });
    add(box, 
      h("label", { class: "field-label", for: inputId }, label),
      h("div", { class: "secret-row" }, input, btn("Save", save, { kind: "primary", size: "sm" }), replacing ? btn("Cancel", () => { replacing = false; draw(); }, { size: "sm", kind: "ghost" }) : null),
      hint ? h("div", { class: "field-hint" }, hint) : null);
  }
  draw();
  ctx.on("secrets", () => { if (!box.contains(document.activeElement)) draw(); });
  box.redraw = draw;
  return box;
}

export default {
  id: "models",
  title: "Models & costs",
  hint: "Your OpenAI key, which model writes for whom, and what it costs.",
  async render(root, ctx) {
    let records = [];
    const loadRecords = async () => { try { records = await history.all(); } catch (_) { records = []; } };
    await loadRecords();

    // ------------------------------------------------ API key + test
    const testModel = selectEl(modelOpts(ctx.settings), ctx.settings.presets.cheap.modelId, { id: "testModel" });
    const testEffort = selectEl(effortOpts, "low", { id: "testEffort" });
    const testOut = h("div", { class: "test-out", id: "testOut" });
    const testBtn = btn("Test", (e) => {
      const b = e.currentTarget;
      busy(b, async () => {
        clear(testOut).appendChild(h("div", { class: "muted small" }, h("span", { class: "spinner" }), " Calling OpenAI…"));
        const r = await ctx.send("testOpenAI", { modelId: testModel.value, effort: testEffort.value }, { label: "Test", quiet: true, raw: true });
        clear(testOut);
        const u = r.usage || {};
        add(testOut, 
          r.error ? h("div", { class: "banner banner-danger" }, icon("alert"), h("span", { class: "banner-text" }, String(r.error))) : h("div", { class: "small text-green" }, icon("check"), " The key works."),
          r.text ? h("blockquote", { class: "test-text" }, r.text) : null,
          h("div", { class: "chips-inline small" },
            h("span", null, `input ${fmtTokens(u.input)}`), h("span", null, `cached ${fmtTokens(u.cached)}`), h("span", null, `output ${fmtTokens(u.output)}`), h("span", null, `reasoning ${fmtTokens(u.reasoning)}`),
            h("strong", null, fmtUsd(r.cost)), h("span", null, `${fmtNum(r.ms)} ms`)));
      });
    }, { iconName: "bolt", id: "testOpenAIBtn", title: "Sends one tiny request (costs a fraction of a cent)" });

    const keySec = section({ title: "OpenAI API key", hint: "Stored only in this browser. Never exported or logged." },
      secretField(ctx, { key: "openaiKey", label: "API key", placeholder: "sk-...", id: "openaiKeyField", hint: h("span", null, "Create one at ", h("a", { href: "https://platform.openai.com/api-keys", target: "_blank", rel: "noopener noreferrer" }, "platform.openai.com/api-keys"), " and set a monthly limit there too.") }),
      sub("Test the key",
        h("div", { class: "toolbar toolbar-end" }, labeled("Model", testModel), labeled("Reasoning effort", testEffort), testBtn),
        testOut));

    // ------------------------------------------------ models table
    const modelsHost = h("div", { id: "modelsTable" });
    const modelField = (id, field, type, extra = {}) => ctx.field({
      type,
      get: (s) => getPath(s.models.find((m) => m.id === id) || {}, field),
      set: (s, v) => { const m = s.models.find((x) => x.id === id); if (m) setPath(m, field, v); },
      ...extra,
    });
    function drawModels() {
      const s = ctx.settings;
      const rows = s.models.map((m) => h("tr", { dataset: { modelId: m.id } },
        h("td", null, modelField(m.id, "label", "text", { ariaLabel: "Label", cls: "field-tight" })),
        h("td", null, modelField(m.id, "name", "text", { ariaLabel: "Model name (as in the OpenAI API)", placeholder: "model name", cls: "field-tight mono" })),
        h("td", { class: "align-center" }, modelField(m.id, "reasoning", "toggle", { label: "", ariaLabel: "Sends reasoning effort", cls: "field-tight" })),
        h("td", null, modelField(m.id, "maxOutputTokens", "number", { ariaLabel: "Max output tokens", min: 64, max: 32000, step: 100, cls: "field-tight num" })),
        h("td", null, modelField(m.id, "prices.input", "number", { ariaLabel: "Input price per 1M tokens", min: 0, step: 0.01, cls: "field-tight num" })),
        h("td", null, modelField(m.id, "prices.cachedInput", "number", { ariaLabel: "Cached input price per 1M tokens", min: 0, step: 0.001, cls: "field-tight num" })),
        h("td", null, modelField(m.id, "prices.cacheWrite", "number", { ariaLabel: "Cache write price per 1M tokens", min: 0, step: 0.01, cls: "field-tight num" })),
        h("td", null, modelField(m.id, "prices.output", "number", { ariaLabel: "Output price per 1M tokens", min: 0, step: 0.01, cls: "field-tight num" })),
        h("td", { class: "col-actions" }, btn("", async () => {
          if (ctx.settings.models.length <= 1) { toast("Keep at least one model.", { type: "warn" }); return; }
          const used = PRESET_KEYS.filter((k) => ctx.settings.presets[k].modelId === m.id).map((k) => PRESET_LABEL[k]);
          const msg = `Remove "${m.label}"${m.name ? ` (${m.name})` : ""}?` + (used.length ? ` It is used by: ${used.join(", ")} - those presets switch to another model.` : "");
          if (!(await confirmDialog(msg, { title: "Remove model", okLabel: "Remove", danger: true }))) return;
          ctx.save((d) => { d.models = d.models.filter((x) => x.id !== m.id); });
        }, { iconName: "trash", size: "sm", kind: "ghost-danger", title: "Remove model" }))));
      fill(modelsHost, 
        h("div", { class: "table-wrap" },
          h("table", { class: "table table-edit" },
            h("thead", null, h("tr", null,
              h("th", null, "Label"), h("th", null, "Model name"), h("th", { class: "align-center", title: "Sends reasoning effort (turn off for non-reasoning models)" }, "Reasoning"),
              h("th", null, "Max output"), h("th", null, "Input $/1M"), h("th", null, "Cached $/1M"), h("th", null, "Cache write $/1M"), h("th", null, "Output $/1M"), h("th", null, ""))),
            h("tbody", null, rows))),
        h("div", { class: "toolbar" },
          btn("Add model", async () => {
            const id = "m_" + Math.random().toString(36).slice(2, 8);
            await ctx.save((d) => { d.models.push({ id, label: "New model", name: "", reasoning: true, maxOutputTokens: 1500, prices: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 } }); });
            const inp = modelsHost.querySelector(`tr[data-model-id="${id}"] td:nth-child(2) input`);
            if (inp) inp.focus();
          }, { iconName: "plus", size: "sm", id: "addModelBtn" })));
    }
    const modelsSec = section({ wide: true, title: "Models and prices", hint: "Any model name the OpenAI Responses API accepts. Prices are USD per 1M tokens; reasoning is billed as output." }, modelsHost);

    // ------------------------------------------------ presets / fallback / matrix / quality
    const presetsHost = h("div", { id: "presetsGrid" });
    const fallbackHost = h("div", { class: "stack" });
    function drawPresets() {
      const s = ctx.settings;
      fill(presetsHost, h("table", { class: "preset-table" },
        h("thead", null, h("tr", null, h("th", { scope: "col" }, "Preset"), h("th", { scope: "col" }, "Model"), h("th", { scope: "col" }, "Reasoning effort"))),
        h("tbody", null, PRESET_KEYS.map((k) => h("tr", null,
          h("th", { scope: "row" }, PRESET_LABEL[k]),
          h("td", null, ctx.field({ path: `presets.${k}.modelId`, type: "select", options: modelOpts(s), ariaLabel: `${PRESET_LABEL[k]} model`, cls: "field-tight" })),
          h("td", null, ctx.field({ path: `presets.${k}.effort`, type: "select", options: effortOpts, ariaLabel: `${PRESET_LABEL[k]} reasoning effort`, cls: "field-tight" })))))));
      fill(fallbackHost,
        ctx.field({ path: "fallback.enabled", type: "toggle", label: "Retry with a fallback model on errors" }),
        h("div", { class: "form-row" },
          ctx.field({ path: "fallback.modelId", type: "select", label: "Fallback model", options: modelOpts(s) }),
          ctx.field({ path: "fallback.effort", type: "select", label: "Fallback effort", options: effortOpts }),
          ctx.field({ path: "fallback.secondModelId", type: "select", label: "Second fallback (optional)", options: modelOpts(s, true) })));
    }
    const presetOpts = PRESET_KEYS.map((k) => [k, PRESET_LABEL[k]]);
    // Only accounts that don't follow you are commented on, so only the B row of the stored matrix is used.
    const matrix = h("table", { class: "matrix", id: "presetMatrix" },
      h("thead", null, h("tr", null, h("th", { scope: "col" }, "Target"), h("th", { scope: "col" }, "Preset"))),
      h("tbody", null,
        [[1, "Tier 1 · big influencer"], [2, "Tier 2 · smart account"]].map(([t, label]) => h("tr", null,
          h("th", { scope: "row" }, label),
          h("td", null, ctx.field({ path: `presetMatrix.B${t}`, type: "select", options: presetOpts, ariaLabel: `Preset for tier ${t}`, cls: "field-tight" }))))));
    const qualityBox = h("div", { class: "stack" },
      ctx.field({ path: "quality.modelCheck", type: "toggle", label: "A second model call checks every comment", hint: "Catches generic, off-topic or wrong-language replies before you see them." }),
      h("div", { class: "form-row" },
        ctx.field({ path: "quality.checkerPreset", type: "select", label: "Checker preset", options: presetOpts }),
        ctx.field({ path: "quality.minChars", type: "number", label: "Min length", min: 1, max: 200 }),
        ctx.field({ path: "quality.maxChars", type: "number", label: "Max length", min: 20, max: 280, hint: "X allows 280" })));

    const presetsSec = section({ title: "Presets", hint: "Three model + effort combinations to choose from." }, presetsHost);
    const matrixSec = section({ title: "Preset per tier", hint: "Which preset each kind of target gets. A per-target override wins (Targets tab)." }, matrix);

    // ------------------------------------------------ estimator + budget
    const estPerDay = h("input", { type: "number", class: "input", min: "0", max: "500", step: "1", id: "estPerDay", value: String(dailyLimit(ctx.settings, ctx.state) || 10) });
    const estBasis = selectEl([...PRESET_KEYS.map((k) => ["preset:" + k, `Preset: ${PRESET_LABEL[k]}`]), ["custom", "Model + effort…"]], "preset:balanced", { id: "estBasis" });
    const estModel = selectEl(modelOpts(ctx.settings), ctx.settings.presets.balanced.modelId, { id: "estModel" });
    const estEffort = selectEl(effortOpts, "medium", { id: "estEffort" });
    const estCustom = h("div", { class: "form-row" }, labeled("Model", estModel), labeled("Effort", estEffort));
    const estOut = h("div", { class: "estimate", id: "estimateOut" });
    function drawEstimate() {
      const s = ctx.settings;
      estCustom.hidden = estBasis.value !== "custom";
      let modelId, effort;
      if (estBasis.value === "custom") { modelId = estModel.value; effort = estEffort.value; }
      else { const p = s.presets[estBasis.value.slice(7)] || s.presets.balanced; modelId = p.modelId; effort = p.effort; }
      const chk = s.presets[s.quality.checkerPreset] || s.presets.cheap;
      const stats = usageStats(records);
      const perDay = Math.max(0, num(estPerDay.value));
      const e = estimate(s, { modelId, effort, perDay, checkModelId: chk.modelId, checkEffort: chk.effort, stats });
      clear(estOut);
      if (!e) { estOut.appendChild(h("p", { class: "muted" }, "Pick a model to estimate.")); return; }
      const calls = Object.values(stats).reduce((a, x) => a + x.n, 0);
      add(estOut, 
        h("p", { class: "estimate-text", id: "estimateText" },
          `${perDay} comment${perDay === 1 ? "" : "s"} per day on ${e.model || "(no model name)"} (${e.effort}) will cost about `,
          h("strong", null, fmtUsd(e.perDay)), " per day and ", h("strong", null, fmtUsd(e.perMonth)), " per month."),
        h("p", { class: "muted small" }, `About ${fmtUsd(e.perComment)} per comment, ~${fmtNum(e.tokensPerComment)} tokens each${s.quality.modelCheck ? " with the quality check" : ""}, ~${Math.round(ASSUME.regenRate * 100)}% regenerations. `,
          e.fromHistory
            ? `From your real usage (${calls} calls).`
            : h("span", { title: `~${fmtNum(ASSUME.genInput)} input tokens, ~${ASSUME.genOutputVisible} visible output tokens plus reasoning (low ${ASSUME.reasoning.low}, medium ${fmtNum(ASSUME.reasoning.medium)}, high ${fmtNum(ASSUME.reasoning.high)}).` }, "Estimated until a few real comments exist.")));
    }
    for (const el of [estPerDay, estBasis, estModel, estEffort]) el.addEventListener(el.tagName === "INPUT" ? "input" : "change", drawEstimate);

    const budgetStatusHost = h("div", { class: "stack-sm", id: "budgetStatus" });
    function drawBudget() {
      const b = budgetStatus(ctx.settings, ctx.data[K.spend]);
      fill(budgetStatusHost, 
        h("div", { class: "small" }, "This month: ", h("strong", { class: "tnum" }, fmtUsd(b.spent)), b.limit ? ` of ${fmtUsd(b.limit, 2)} (${Math.round(b.pct)}%)` : " (no limit)", " · today ", h("span", { class: "tnum" }, fmtUsd(b.today))),
        b.limit ? progressBar(b.pct, { kind: b.reached ? "red" : b.warn ? "amber" : "accent" }) : null,
        b.reached ? h("div", { class: "small text-red" }, "Budget reached: ScoreX stops generating until next month or until you raise the budget.") : b.warn ? h("div", { class: "small text-amber" }, "Warning level reached.") : null);
    }
    const estSec = section({ title: "Cost estimator", hint: "What a daily volume costs on a preset or model." },
      h("div", { class: "form-row" }, labeled("Comments per day", estPerDay), labeled("Based on", estBasis)),
      estCustom,
      estOut);
    const budgetSec = section({ title: "Monthly budget", hint: "ScoreX stops generating when the month's real spend reaches it." },
      h("div", { class: "form-row" },
        ctx.field({ path: "budget.monthlyUsd", type: "number", label: "Monthly budget (USD)", min: 0, step: 1, hint: "0 = no limit" }),
        ctx.field({ path: "budget.warnAtPct", type: "number", label: "Warn at (%)", min: 10, max: 100, step: 5 })),
      budgetStatusHost);

    // ------------------------------------------------ spend reports (moved to Results > Spend)
    const reportsSec = section({ title: "Spend reports", hint: "Totals per model, day, week and month and performance per model and tone are in Results." },
      h("p", { class: "small muted" }, "See what each model and tone costs per posted comment and per follow-back, next to the daily cost chart and your budget."),
      h("a", { href: "#results?view=spend", class: "btn btn-sm", id: "spendReportsLink" }, "Open Results › Spend"));

    add(root, keySec, presetsSec, matrixSec, estSec, budgetSec, reportsSec,
      advanced({ key: "models.advanced", desc: "Model and price table, fallback models, quality checker" },
        modelsSec,
        section({ title: "Fallback", hint: "Used when the preset's model errors out." }, fallbackHost),
        section({ title: "Quality checker", hint: "Rule checks always run; this adds a model check." }, qualityBox)));

    let modelSig = "";
    const modelsSignature = (s) => JSON.stringify(s.models.map((m) => [m.id, m.label, m.name]));
    function syncModelSelects() {
      const s = ctx.settings;
      for (const [sel, fallback] of [[testModel, s.presets.cheap.modelId], [estModel, s.presets.balanced.modelId]]) {
        const cur = sel.value;
        clear(sel);
        for (const [v, l] of modelOpts(s)) sel.appendChild(h("option", { value: v }, l));
        sel.value = s.models.some((m) => m.id === cur) ? cur : fallback;
      }
    }
    const idsSig = (s) => s.models.map((m) => m.id).join(",");
    let lastIds = idsSig(ctx.settings);
    modelSig = modelsSignature(ctx.settings);
    drawModels(); drawPresets(); drawEstimate(); drawBudget();

    ctx.on("settings", (s) => {
      const ids = idsSig(s);
      if (ids !== lastIds) { lastIds = ids; drawModels(); }
      const sig = modelsSignature(s);
      if (sig !== modelSig) {
        modelSig = sig;
        if (!presetsHost.contains(document.activeElement) && !fallbackHost.contains(document.activeElement)) drawPresets();
        syncModelSelects();
      }
      drawEstimate(); drawBudget();
    });
    ctx.on(K.spend, drawBudget);
    // The estimator learns from real usage: re-read history only when it changed (new items in the queue), not on every tick.
    const reloadRecords = debounce(async () => { await loadRecords(); if (!estOut.contains(document.activeElement)) drawEstimate(); }, 2000);
    ctx.on("counts", reloadRecords);
  },
};
