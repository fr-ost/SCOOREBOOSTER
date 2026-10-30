// ScoreX - hand-made inline SVG charts (no libraries, no innerHTML). Colours come only from CSS classes
// (viz-*, mark-*, bar-*, heat-*, grid-line, axis, ...) styled in dashboard.css, so the light and dark themes
// just work. Every SVG has role="img" + an aria-label summary, and marks carry a <title>.
//
// Charts take a pixel width. Wrap them in responsive(build) to draw at the container's measured width:
//   host.appendChild(responsive((w) => rhythm(data, { w, h: 46 })));
// A ResizeObserver redraws when the container width changes (no scaled-down text at narrow widths).
//
// SVG charts (return <svg>):
//   spark(values, { w, h, step, cls, dot, label })        sparkline; values oldest first, null = gap; step = daily step line
//   stepLine(values, opts)                                 spark with step: true (scores change once a day)
//   miniBars(values, { w, h, label, titles })              e.g. follow-backs per day; zero days draw a 1px stub
//   scoreHistory(series, events, { w, h, labels, indexed }) indexed step lines per provider + follow-back event track
//   dailyBars(rows, { w, h, label })                       rows [{ label, posted, fb }]: neutral bars + lime squares
//   funnel(stages, { w })                                  stages [{ label, value, sub? }]: last stage in lime
//   rhythm(data, { w, h })                                 day-rhythm strip; build data with rhythmFrom({...timestamps})
//   heatmap(weeks, { cell, gap, label, titles })           weeks = [[7 values, Monday first], ...]
//   histogram(bins, { w, h, label, start })                bins = counts (e.g. days 1..14)
// HTML marks (return <span>/<div>):
//   barInCell(value, max, { w, text, label })              90x6 bar with an optional mono value in front
//   segMeter(n, of, { warnFrom, signal, label })           N/M segment meter ("day 5/14", quotas); amber from warnFrom
//   coverageBar(fresh, stale, total, { label })            ink = fresh, amber = stale, track = never
//   partsBar(parts, { label })                             parts [{ label, value 0..1, weight }]: ScoreX rank parts
//   overlapDots(k, n, { label })                           "listed by k of n" squares
// Helpers: responsive(build, opts), rhythmFrom(opts), vizIndex(providerId), vizClass(providerId), fmtShort(n), svgEl(tag, attrs, ...kids)
// Legacy exports (kept working): sparkline(points, { width, height, label }), bars(rows, { width, height, label, unit, value2Label }),
//   meter(value, max, { width, height, label }); funnel() also accepts { width } and stage.hint.

import { inWindow, HOUR, MIN } from "../lib/util.js";

const NS = "http://www.w3.org/2000/svg";

export function svgEl(tag, attrs, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) el.setAttribute(k, String(v));
  for (const c of kids.flat(3)) if (c != null && c !== false) el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  return el;
}
const s = svgEl;
const html = (tag, attrs, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.setAttribute("style", v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids.flat(3)) if (c != null && c !== false) el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
};
const title = (text) => s("title", {}, String(text));
const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : "0");
const finite = (v) => v != null && v !== "" && Number.isFinite(Number(v));

// 1284 -> "1,284", 18400 -> "18K", 1.3e6 -> "1.3M".
export function fmtShort(n) {
  if (!finite(n)) return "-";
  n = Number(n);
  const a = Math.abs(n);
  if (a >= 1e6) return Math.round(n / 1e5) / 10 + "M";
  if (a >= 1e4) return Math.round(n / 1e3) + "K";
  if (a >= 1e3) return Math.round(n).toLocaleString("en");
  return String(Math.round(n * 10) / 10);
}

// Provider colour slot (1..6) for the --viz-N palette: keys and lines only, never fills.
const VIZ = { sorsa: 1, twitterscore: 2, ethos: 3, moni: 4 };
export function vizIndex(id) {
  if (VIZ[id]) return VIZ[id];
  let hsh = 0;
  for (const ch of String(id || "")) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
  return 5 + (hsh % 2);
}
export const vizClass = (id) => "viz-" + vizIndex(id);

// ---------------------------------------------------------------- responsive host

// Draws build(width) at the host's measured width and redraws on resize. The first draw uses initialWidth so the
// host has content before it is attached; right after insertion it re-measures (microtask) and a ResizeObserver
// keeps it in sync. host.update(build) swaps the builder (new data), host.redraw() forces a redraw.
export function responsive(build, { initialWidth = 560, minWidth = 60, cls = "", label } = {}) {
  const host = html("div", { class: "chart-host" + (cls ? " " + cls : "") });
  let builder = build, lastW = 0, raf = 0;
  const draw = (w, force) => {
    w = Math.max(minWidth, Math.floor(w));
    if (!force && w === lastW) return;
    lastW = w;
    let node = null;
    try { node = builder(w); } catch (e) { console.error("[ScoreX chart]", e); }
    host.replaceChildren(...(node ? [node] : []));
  };
  draw(initialWidth, true);
  if (label) host.setAttribute("title", label);
  const measure = () => { if (host.isConnected && host.clientWidth > 0) draw(host.clientWidth); };
  queueMicrotask(measure);
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver((entries) => {
      if (!host.isConnected) { ro.disconnect(); return; }
      const w = entries[0] && entries[0].contentRect ? entries[0].contentRect.width : host.clientWidth;
      if (w > 0 && Math.abs(Math.floor(w) - lastW) >= 1) { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => draw(w)); }
    });
    ro.observe(host);
  }
  host.update = (nextBuild) => { if (nextBuild) builder = nextBuild; draw(host.clientWidth || lastW || initialWidth, true); };
  host.redraw = () => draw(host.clientWidth || lastW || initialWidth, true);
  return host;
}

// ---------------------------------------------------------------- sparkline / step line

// values oldest first (null = gap). cls: viz-ink (default) | viz-signal | viz-red | viz-1..6.
export function spark(values, { w = 96, h = 24, step = false, cls = "viz-ink", dot = true, label = "" } = {}) {
  const vals = (values || []).map((v) => (finite(v) ? Number(v) : null));
  const pts = vals.map((v, i) => [i, v]).filter((p) => p[1] != null);
  const svg = s("svg", { class: "spark", viewBox: `0 0 ${w} ${h}`, width: w, height: h, role: "img", "aria-label": label || (pts.length ? `Trend from ${fmtShort(pts[0][1])} to ${fmtShort(pts[pts.length - 1][1])}` : "No data yet") });
  if (pts.length < 2) {
    svg.appendChild(s("line", { x1: 0, y1: h - 1.5, x2: w, y2: h - 1.5, class: "grid-line" }));
    if (pts.length === 1 && dot) svg.appendChild(s("rect", { x: w - 4, y: f1(h / 2 - 2), width: 4, height: 4, class: "spark-dot " + cls }));
    return svg;
  }
  const ys = pts.map((p) => p[1]), min = Math.min(...ys), max = Math.max(...ys), pad = 2.5, n = vals.length;
  const X = (i) => pad + (i * (w - 2 * pad)) / Math.max(1, n - 1);
  const Y = (v) => (max === min ? h / 2 : h - pad - ((v - min) / (max - min)) * (h - 2 * pad));
  let d = "";
  pts.forEach(([i, v], k) => { d += !k ? `M${f1(X(i))},${f1(Y(v))}` : step ? `H${f1(X(i))}V${f1(Y(v))}` : `L${f1(X(i))},${f1(Y(v))}`; });
  svg.appendChild(s("path", { d, class: "spark-line " + cls }));
  if (dot) { const [li, lv] = pts[pts.length - 1]; svg.appendChild(s("rect", { x: f1(X(li) - 2), y: f1(Y(lv) - 2), width: 4, height: 4, class: "spark-dot " + cls })); }
  return svg;
}
export const stepLine = (values, opts = {}) => spark(values, { ...opts, step: true });

// ---------------------------------------------------------------- mini bars

// Days with a value are lime with the mark edge, zero days are 1px stubs so the rhythm stays readable.
export function miniBars(values, { w = 96, h = 24, label = "", titles = null } = {}) {
  const vals = (values || []).map((v) => Math.max(0, Number(v) || 0));
  const n = vals.length || 1, gap = n > 40 ? 0.5 : 1, bw = Math.max(0.5, (w - gap * (n - 1)) / n), max = Math.max(1, ...vals);
  const svg = s("svg", { class: "minibars", viewBox: `0 0 ${w} ${h}`, width: w, height: h, role: "img", "aria-label": label || `Per day: ${vals.join(", ")}` });
  vals.forEach((v, i) => {
    const bh = v ? Math.max(3, (v / max) * (h - 1)) : 1;
    const r = s("rect", { x: f1(i * (bw + gap)), y: f1(h - bh), width: f1(bw), height: f1(bh), class: v ? "mark-signal" : "bar-off" });
    if (titles && titles[i]) r.appendChild(title(titles[i]));
    svg.appendChild(r);
  });
  return svg;
}

// ---------------------------------------------------------------- score history (Scores hero)

// series: [{ name, color: 1..6 | "viz-..", values: [..] }] (same length, oldest first, null = no data).
// events: [{ i (index into values), weight (e.g. that account's score), label (title), short (text for the top 3) }].
// indexed: 100 = first value shown (providers use different scales).
export function scoreHistory(series, events = [], { w = 1180, h = 250, labels = [], indexed = true } = {}) {
  const list = (series || []).filter((x) => x && Array.isArray(x.values) && x.values.some(finite));
  const top = 10, right = events && events.length ? 92 : 56, axisH = 16, trackH = events && events.length ? 34 : 6, chartH = Math.max(40, h - top - axisH - trackH - 10);
  const n = Math.max(2, ...list.map((x) => x.values.length));
  const prep = list.map((x) => {
    const first = x.values.find(finite);
    return { ...x, plot: x.values.map((v) => (!finite(v) ? null : indexed && Number(first) ? (Number(v) / Number(first)) * 100 : Number(v))) };
  });
  const all = prep.flatMap((x) => x.plot.filter((v) => v != null));
  const summary = list.map((x) => { const f = x.values.find(finite); const l = [...x.values].reverse().find(finite); return `${x.name}: ${fmtShort(f)} to ${fmtShort(l)}`; }).join("; ");
  const svg = s("svg", { class: "chart", viewBox: `0 0 ${w} ${h}`, width: w, height: h, role: "img", "aria-label": (summary || "No score history yet") + `; ${(events || []).length} follow-backs marked` });
  if (!all.length) {
    svg.appendChild(s("line", { x1: 0, y1: top + chartH, x2: w - right, y2: top + chartH, class: "base-line" }));
    svg.appendChild(s("text", { x: 0, y: top + chartH - 8, class: "axis" }, "No score history yet"));
    return svg;
  }
  let lo = Math.min(...all), hi = Math.max(...all);
  const padV = (hi - lo) * 0.12 || Math.max(1, Math.abs(hi) * 0.05);
  lo = Math.floor(lo - padV); hi = Math.ceil(hi + padV);
  const X = (i) => (i * (w - right)) / (n - 1);
  const Y = (v) => top + chartH - ((v - lo) / (hi - lo || 1)) * chartH;
  for (let k = 0; k <= 3; k++) {
    const v = lo + ((hi - lo) * k) / 3, y = Y(v);
    svg.appendChild(s("line", { x1: 0, y1: f1(y), x2: w - right, y2: f1(y), class: "grid-line" }));
    svg.appendChild(s("text", { x: w - right + 8, y: f1(y + 3.5), class: "axis" }, indexed ? String(Math.round(v)) : fmtShort(v)));
  }
  if (indexed && lo < 100 && hi > 100) svg.appendChild(s("line", { x1: 0, y1: f1(Y(100)), x2: w - right, y2: f1(Y(100)), class: "base-line", "stroke-dasharray": "3 3" }));
  for (const x of prep) {
    const cls = typeof x.color === "string" && x.color.startsWith("viz-") ? x.color : "viz-" + (x.color || 1);
    let d = "", started = false, last = null;
    x.plot.forEach((v, i) => {
      if (v == null) { started = false; return; }
      d += started ? `H${f1(X(i))}V${f1(Y(v))}` : `M${f1(X(i))},${f1(Y(v))}`;
      started = true; last = [i, v];
    });
    const path = s("path", { d, class: "spark-line " + cls, "stroke-width": 1.8 });
    path.appendChild(title(x.name));
    svg.appendChild(path);
    if (last) svg.appendChild(s("rect", { x: f1(X(last[0]) - 2.5), y: f1(Y(last[1]) - 2.5), width: 5, height: 5, class: "spark-dot " + cls }));
  }
  const ay = top + chartH + axisH;
  [[0, "start"], [Math.floor((n - 1) / 2), "middle"], [n - 1, "end"]].forEach(([i, anchor]) => { if (labels[i]) svg.appendChild(s("text", { x: f1(X(i)), y: ay, class: "axis", "text-anchor": anchor }, labels[i])); });
  if (events && events.length) {
    const ty = h - 4;
    svg.appendChild(s("line", { x1: 0, y1: ty, x2: w - right, y2: ty, class: "base-line" }));
    svg.appendChild(s("text", { x: w - right + 8, y: ty - 2, class: "axis" }, "follow-backs"));
    const maxW = Math.max(1, ...events.map((e) => Number(e.weight) || 0));
    const labelled = new Set(events.slice().sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0)).slice(0, 3));
    for (const e of events) {
      if (!(e.i >= 0 && e.i < n)) continue;
      const th = 4 + ((Number(e.weight) || 0) / maxW) * (trackH - 10);
      svg.appendChild(s("rect", { x: f1(X(e.i) - 1.5), y: f1(ty - th), width: 3, height: f1(th), class: "mark-signal" }, title(e.label || "")));
      if (labelled.has(e) && (e.short || e.label)) {
        const nearEnd = X(e.i) > w - right - 90;
        svg.appendChild(s("text", { x: f1(X(e.i) + (nearEnd ? -4 : 4)), y: f1(ty - th + 7), class: "ev-label", "text-anchor": nearEnd ? "end" : "start" }, e.short || e.label));
      }
    }
  }
  return svg;
}

// ---------------------------------------------------------------- daily bars (+ follow-back squares)

// rows: [{ label, posted, fb }] oldest first. Gridlines at half and full height, labelled on the right.
export function dailyBars(rows, { w = 720, h = 150, label = "" } = {}) {
  const list = rows || [];
  const n = Math.max(1, list.length), gap = n > 45 ? 1 : 3, bw = Math.max(1, (w - gap * (n - 1)) / n), top = 8, axisH = 16;
  const maxP = Math.max(1, ...list.map((r) => Number(r.posted) || 0)), sq = Math.max(2, Math.min(6, bw - 1));
  const maxStack = Math.min(8, Math.max(0, ...list.map((r) => Number(r.fb) || 0))) * (sq + 1);
  const chartH = Math.max(20, h - top - axisH - maxStack);
  const svg = s("svg", { class: "chart", viewBox: `0 0 ${w} ${h}`, width: w, height: h, role: "img", "aria-label": label || list.map((r) => `${r.label}: ${r.posted || 0} posted, ${r.fb || 0} follow-backs`).join("; ") || "No data yet" });
  const base = top + maxStack + chartH;
  [0.5, 1].forEach((k) => {
    const y = base - chartH * k;
    svg.appendChild(s("line", { x1: 0, y1: f1(y), x2: w, y2: f1(y), class: "grid-line" }));
    svg.appendChild(s("text", { x: w, y: f1(y - 3), class: "axis", "text-anchor": "end" }, String(Math.round(maxP * k))));
  });
  list.forEach((r, i) => {
    const posted = Number(r.posted) || 0, fb = Number(r.fb) || 0;
    const x = i * (bw + gap), bh = (posted / maxP) * chartH;
    const g = s("g", {}, title(`${r.label}: ${posted} posted, ${fb} follow-back${fb === 1 ? "" : "s"}`));
    g.appendChild(s("rect", { x: f1(x), y: f1(base - bh), width: f1(bw), height: f1(Math.max(posted ? 1 : 0, bh)), class: "bar-neutral" }));
    for (let k = 0; k < Math.min(fb, 8); k++) g.appendChild(s("rect", { x: f1(x + (bw - sq) / 2), y: f1(base - bh - (k + 1) * (sq + 1)), width: f1(sq), height: f1(sq), class: "mark-signal" }));
    svg.appendChild(g);
  });
  svg.appendChild(s("line", { x1: 0, y1: f1(base), x2: w, y2: f1(base), class: "base-line" }));
  if (list.length) {
    svg.appendChild(s("text", { x: 0, y: h - 2, class: "axis" }, String(list[0].label)));
    svg.appendChild(s("text", { x: w, y: h - 2, class: "axis", "text-anchor": "end" }, String(list[list.length - 1].label)));
  }
  return svg;
}

// ---------------------------------------------------------------- funnel

// stages: [{ label, value, sub? }] widest first. Left 190px column: stage label + conversion from the previous
// stage (or stage.sub / stage.hint); neutral bars proportional to the first stage; the last stage in lime.
export function funnel(stages, { w, width } = {}) {
  const list = stages || [];
  w = w || width || 720;
  const rowH = 38, labelW = Math.min(190, Math.round(w * 0.36)), valW = 60;
  const topV = Math.max(1, Number(list[0] && list[0].value) || 0), barMax = Math.max(20, w - labelW - valW);
  const svg = s("svg", { class: "chart funnel", viewBox: `0 0 ${w} ${Math.max(rowH, list.length * rowH)}`, width: w, height: Math.max(rowH, list.length * rowH), role: "img", "aria-label": list.map((x) => `${x.label}: ${x.value}`).join(", ") || "No data yet" });
  list.forEach((st, i) => {
    const v = Number(st.value) || 0;
    const y = i * rowH, bw = Math.max(v ? 3 : 0, (v / topV) * barMax);
    let sub = st.sub || st.hint || "";
    if (!sub && i > 0) {
      const prev = Number(list[i - 1].value) || 0;
      if (prev) sub = `${Math.round((v / prev) * 1000) / 10}% of ${String(list[i - 1].label).toLowerCase()}`;
    }
    svg.appendChild(s("text", { x: 0, y: y + (sub ? 16 : 23), class: "funnel-label" }, st.label));
    if (sub) svg.appendChild(s("text", { x: 0, y: y + 31, class: "funnel-conv" }, sub));
    svg.appendChild(s("rect", { x: labelW, y: y + 8, width: f1(bw), height: rowH - 16, class: "funnel-bar" + (i === list.length - 1 ? " last" : "") }, title(`${st.label}: ${v}`)));
    svg.appendChild(s("text", { x: f1(labelW + bw + 8), y: y + rowH / 2 + 4, class: "funnel-val" }, fmtShort(v)));
  });
  return svg;
}

// ---------------------------------------------------------------- day rhythm strip

// data (fractions of the window, 0..1): { hoursLabels: [[frac, text]], active: [[a, b]], posts: [x], fails: [x],
// breaks: [[a, b]], next: x | null, now: x }. Build it from timestamps with rhythmFrom().
export function rhythm({ hoursLabels = [], active = [], posts = [], fails = [], breaks = [], next = null, now = 0.75, label = "" } = {}, { w = 560, h = 46 } = {}) {
  const ty = 12, th = Math.max(8, h - 30);
  const svg = s("svg", { class: "chart rhythm", viewBox: `0 0 ${w} ${h}`, width: w, height: h, role: "img", "aria-label": label || `Day rhythm: ${posts.length} comments posted, ${fails.length} failed${next != null ? ", next comment planned" : ""}` });
  svg.appendChild(s("rect", { x: 0.5, y: ty, width: w - 1, height: th, class: "track" }));
  for (const [a, b] of active) if (b > a) svg.appendChild(s("rect", { x: f1(a * w), y: ty, width: f1((b - a) * w), height: th, class: "band-active" }));
  for (const [a, b] of breaks) if (b > a) svg.appendChild(s("rect", { x: f1(a * w), y: ty + 2, width: f1(Math.max(2, (b - a) * w)), height: th - 4, class: "break" }, title("Break")));
  for (const p of posts) svg.appendChild(s("rect", { x: f1(p * w - 1), y: ty - 3, width: 2, height: th + 6, class: "mark-ink" }));
  for (const p of fails) svg.appendChild(s("rect", { x: f1(p * w - 1), y: ty - 3, width: 2, height: th + 6, class: "mark-red" }, title("Failed")));
  const nx = Math.min(w - 1, Math.max(1, now * w));
  svg.appendChild(s("line", { x1: f1(nx), y1: 2, x2: f1(nx), y2: ty + th + 4, class: "now-line" }));
  const nowRight = nx > w - 34;
  svg.appendChild(s("text", { x: f1(nowRight ? nx - 4 : nx + 4), y: 8, class: "axis axis-strong", "text-anchor": nowRight ? "end" : "start" }, "now"));
  if (next != null) {
    const xx = Math.min(w - 5, Math.max(5, next * w));
    svg.appendChild(s("line", { x1: f1(nx), y1: ty + th / 2, x2: f1(xx), y2: ty + th / 2, class: "next-mark", "stroke-dasharray": "2 2" }));
    svg.appendChild(s("rect", { x: f1(xx - 4), y: f1(ty + th / 2 - 4), width: 8, height: 8, class: "next-mark" }, title("Next planned comment")));
  }
  hoursLabels.forEach(([frac, text]) => svg.appendChild(s("text", { x: f1(Math.min(w, Math.max(0, frac * w))), y: h - 2, class: "axis", "text-anchor": frac < 0.02 ? "start" : frac > 0.98 ? "end" : "middle" }, text)));
  return svg;
}

function hourFmt(tz) {
  try { return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz || undefined }); }
  catch (_) { return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); }
}

// Builds rhythm() data from timestamps: window [now - beforeH, now + afterH].
// posts / fails: [ts]; breaks: [[fromTs, toTs]]; next: ts; activeHours: settings.safety.activeHours ({ enabled, start, end }).
// labels: number of hour labels along the bottom (2 = first + last); endLabel replaces the last one (e.g. "+6 h").
export function rhythmFrom({ now = Date.now(), beforeH = 18, afterH = 6, posts = [], fails = [], breaks = [], next = null, activeHours = null, tz, labels = 5, endLabel = null } = {}) {
  const from = now - beforeH * HOUR, to = now + afterH * HOUR, span = to - from;
  const f = (ts) => (Number(ts) - from) / span;
  const inside = (ts) => finite(ts) && ts >= from && ts <= to;
  let active = [];
  if (!activeHours || !activeHours.enabled) active = [[0, 1]];
  else {
    let cur = null;
    for (let t = from; t <= to; t += 10 * MIN) {
      let on = true;
      try { on = inWindow(t, activeHours.start, activeHours.end, tz); } catch (_) { on = true; }
      if (on && cur == null) cur = f(t);
      if (!on && cur != null) { active.push([cur, f(t)]); cur = null; }
    }
    if (cur != null) active.push([cur, 1]);
  }
  const fmt = hourFmt(tz);
  const hoursLabels = [];
  const nL = Math.max(2, labels);
  for (let i = 0; i < nL; i++) { const frac = i / (nL - 1); hoursLabels.push([frac, i === nL - 1 && endLabel ? endLabel : fmt.format(new Date(from + frac * span))]); }
  return {
    hoursLabels, active,
    posts: (posts || []).filter(inside).map(f),
    fails: (fails || []).filter(inside).map(f),
    breaks: (breaks || []).filter((b) => b && finite(b[0]) && finite(b[1]) && b[1] > from && b[0] < to).map(([a, b]) => [f(Math.max(a, from)), f(Math.min(b, to))]),
    next: inside(next) && next >= now ? f(next) : null,
    now: f(now),
    label: `Last ${beforeH} hours and next ${afterH}: ${(posts || []).filter(inside).length} comments posted, ${(fails || []).filter(inside).length} failed${inside(next) ? ", next comment planned" : ""}`,
  };
}

// ---------------------------------------------------------------- heatmap

// weeks: [[7 values, Monday first], ...] oldest first; 5 levels (heat-0..4); titles: same shape with per-day text.
export function heatmap(weeks, { cell = 11, gap = 2, label = "", titles = null } = {}) {
  const list = weeks || [];
  const w = Math.max(1, list.length * (cell + gap) - gap), h = 7 * (cell + gap) - gap;
  const flat = list.flat().map((v) => Number(v) || 0), max = Math.max(1, ...flat);
  const svg = s("svg", { class: "chart heatmap", viewBox: `0 0 ${w} ${h}`, width: w, height: h, role: "img", "aria-label": label || `${flat.reduce((a, b) => a + b, 0)} in ${list.length} weeks` });
  list.forEach((wk, x) => (wk || []).forEach((raw, y) => {
    const v = Number(raw) || 0;
    const lvl = v ? Math.min(4, 1 + Math.floor((v / max) * 3.999)) : 0;
    const t = titles && titles[x] && titles[x][y] != null ? titles[x][y] : String(v);
    svg.appendChild(s("rect", { x: x * (cell + gap), y: y * (cell + gap), width: cell, height: cell, class: "heat-" + lvl }, title(t)));
  }));
  return svg;
}

// ---------------------------------------------------------------- histogram

// bins: counts (bin i = start + i, e.g. days 1..14). Labels first, last and the 7th bin.
export function histogram(bins, { w = 340, h = 96, label = "", start = 1, unit = "day" } = {}) {
  const list = (bins || []).map((b) => Number(b) || 0);
  const n = Math.max(1, list.length), gap = 3, bw = Math.max(1, (w - gap * (n - 1)) / n), max = Math.max(1, ...list), axisH = 14, ch = h - axisH - 4;
  const svg = s("svg", { class: "chart", viewBox: `0 0 ${w} ${h}`, width: w, height: h, role: "img", "aria-label": label || list.map((b, i) => `${unit} ${i + start}: ${b}`).join(", ") || "No data yet" });
  list.forEach((b, i) => {
    const bh = (b / max) * ch;
    svg.appendChild(s("rect", { x: f1(i * (bw + gap)), y: f1(4 + ch - Math.max(b ? 2 : 1, bh)), width: f1(bw), height: f1(Math.max(b ? 2 : 1, bh)), class: b ? "bar-neutral" : "bar-off" }, title(`${unit} ${i + start}: ${b}`)));
    if (i === 0 || i === n - 1 || i === 6) svg.appendChild(s("text", { x: f1(i * (bw + gap) + bw / 2), y: h - 1, class: "axis", "text-anchor": "middle" }, String(i + start)));
  });
  return svg;
}

// ---------------------------------------------------------------- HTML marks

// 90x6 bar-in-cell (conversion rates, provider scores in lists). text: optional mono value shown in front.
export function barInCell(value, max, { w = 90, text = null, label = "" } = {}) {
  const v = Number(value) || 0, m = Number(max) || 0;
  const pct = m > 0 ? Math.max(0, Math.min(100, (v / m) * 100)) : 0;
  return html("span", { class: "barcell", role: "img", "aria-label": label || (text != null ? String(text) : `${fmtShort(v)} of ${fmtShort(m)}`) },
    text != null ? html("span", { class: "mono" }, String(text)) : null,
    html("span", { class: "b", style: `width:${w}px` }, html("i", { style: `width:${pct.toFixed(1)}%` })));
}

// N/M segment meter: one 6px segment per unit (up to 30), a continuous bar above that. warnFrom: the value from
// which filled segments turn amber (e.g. giveUpDays - 2); signal: lime segments instead of ink.
export function segMeter(n, of, { warnFrom = null, signal = false, label = "" } = {}) {
  const v = Math.max(0, Math.round(Number(n) || 0)), m = Math.max(0, Math.round(Number(of) || 0));
  const warn = warnFrom != null && v >= warnFrom;
  const attrs = { class: "segs" + (signal ? " signal" : "") + (warn ? " is-warn" : "") + (m > 30 ? " segs-cont" : ""), role: "meter", "aria-valuemin": "0", "aria-valuemax": String(m), "aria-valuenow": String(Math.min(v, m || v)), "aria-label": label || `${v} of ${m}` };
  if (m > 30) {
    const pct = m ? Math.min(100, (v / m) * 100) : 0;
    return html("span", attrs, html("span", { class: "on" + (warn ? " warn" : ""), style: `width:${pct.toFixed(1)}%` }));
  }
  const kids = [];
  for (let i = 0; i < m; i++) kids.push(html("span", { class: i < v ? (warn ? "warn" : "on") : "" }));
  return html("span", attrs, kids);
}

// Coverage: fresh (ink) / older (amber) / never (track).
export function coverageBar(fresh, stale, total, { label = "" } = {}) {
  const t = Math.max(0, Number(total) || 0), fr = Math.max(0, Number(fresh) || 0), st = Math.max(0, Number(stale) || 0);
  const p = (x) => (t ? Math.min(100, (x / t) * 100) : 0).toFixed(1) + "%";
  return html("div", { class: "cover-bar", role: "img", "aria-label": label || `${fr} fresh, ${st} older, ${Math.max(0, t - fr - st)} never`, title: label || `${fr} fresh, ${st} older than 7 days, ${Math.max(0, t - fr - st)} never` },
    html("i", { class: "fresh", style: `width:${p(fr)}` }), html("i", { class: "stale", style: `width:${p(st)}` }));
}

// ScoreX rank parts: [{ label, value (0..1), weight (share of 100) }] -> 4 ink-to-grey segments sized value x weight.
export function partsBar(parts, { label = "" } = {}) {
  const list = (parts || []).filter(Boolean);
  return html("div", { class: "parts", role: "img", "aria-label": label || list.map((p) => `${p.label} ${Math.round((Number(p.value) || 0) * 100)}%`).join(", ") },
    list.map((p) => html("i", { style: `width:${(Math.max(0, Math.min(1, Number(p.value) || 0)) * (Number(p.weight) || 0)).toFixed(1)}%`, title: `${p.label}: ${Math.round((Number(p.value) || 0) * 100)}% (weight ${p.weight})` })));
}

// "listed by k of n": k filled squares out of n.
export function overlapDots(k, n, { label = "" } = {}) {
  const kk = Math.max(0, Number(k) || 0), nn = Math.max(kk, Number(n) || 0);
  const dots = [];
  for (let i = 0; i < Math.min(nn, 12); i++) dots.push(html("i", { class: i < kk ? "on" : "" }));
  return html("span", { class: "dots", role: "img", "aria-label": label || `${kk} of ${nn}`, title: label || `${kk} of ${nn}` }, dots);
}

// ---------------------------------------------------------------- legacy exports

// points: [{ x?: label, y: number }] oldest first.
export function sparkline(points, { width = 120, height = 32, label = "", step = false, cls = "viz-ink" } = {}) {
  const vals = (points || []).map((p) => (p && typeof p === "object" ? p.y : p));
  return spark(vals, { w: width, h: height, label, step, cls });
}

// rows: [{ label, value, value2? }] oldest first: neutral bars, optional second series as lime squares on top.
export function bars(rows, { width = 560, height = 120, label = "", unit = "", value2Label = "" } = {}) {
  const list = rows || [];
  const n = Math.max(1, list.length), gap = 2, bw = Math.max(1, (width - gap * (n - 1)) / n), axisH = 14;
  const max = Math.max(1, ...list.map((r) => Number(r.value) || 0));
  const svg = s("svg", { class: "chart bars", viewBox: `0 0 ${width} ${height + axisH}`, width, height: height + axisH, role: "img", "aria-label": label || "Daily values" });
  list.forEach((r, i) => {
    const v = Number(r.value) || 0, x = i * (bw + gap), bh = (v / max) * height;
    const g = s("g", { class: "bar" }, title(`${r.label}: ${fmtShort(v)}${unit}${r.value2 ? ` · ${value2Label} ${fmtShort(r.value2)}` : ""}`));
    g.appendChild(s("rect", { x: f1(x), y: f1(height - bh), width: f1(bw), height: f1(Math.max(v ? 1 : 0, bh)), class: "bar-neutral" }));
    if (r.value2) g.appendChild(s("rect", { x: f1(x), y: f1(Math.max(0, height - bh - 4)), width: f1(bw), height: 3, class: "mark-signal" }));
    svg.appendChild(g);
  });
  if (list.length) {
    svg.appendChild(s("text", { x: 0, y: height + 12, class: "axis" }, String(list[0].label)));
    svg.appendChild(s("text", { x: width, y: height + 12, class: "axis", "text-anchor": "end" }, String(list[list.length - 1].label)));
  }
  return svg;
}

// Thin horizontal meter: value of max.
export function meter(value, max, { width = 160, height = 6, label = "" } = {}) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const svg = s("svg", { class: "meter", viewBox: `0 0 ${width} ${height}`, width, height, role: "img", "aria-label": label || `${fmtShort(value)} of ${fmtShort(max)}` });
  svg.appendChild(s("rect", { x: 0, y: 0, width, height, class: "meter-track" }));
  svg.appendChild(s("rect", { x: 0, y: 0, width: f1(pct * width), height, class: "meter-fill" + (pct >= 1 ? " is-full" : "") }));
  return svg;
}
