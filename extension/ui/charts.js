// ScoreX - small inline SVG charts (no libraries, no innerHTML): sparkline, daily bars, funnel, meter.
// Colors come from CSS variables (--chart-*), so both themes work. Every chart has a text alternative.

const NS = "http://www.w3.org/2000/svg";
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, String(v));
  for (const c of kids) if (c != null) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}
const fmt = (n) => (n == null || !Number.isFinite(n) ? "-" : Math.abs(n) >= 1000 ? (Math.round(n / 100) / 10) + "K" : String(Math.round(n * 10) / 10));

// points: [{ x?: label, y: number }] oldest first. Draws a line + last-point dot; flat line when < 2 points.
export function sparkline(points, { width = 120, height = 32, label = "", strokeVar = "--chart-line" } = {}) {
  const ys = (points || []).map((p) => Number(p.y)).filter(Number.isFinite);
  const svg = s("svg", { class: "spark", viewBox: `0 0 ${width} ${height}`, width, height, role: "img", "aria-label": label || (ys.length ? `Trend: ${ys.map(fmt).join(", ")}` : "No data yet") });
  if (!ys.length) { svg.appendChild(s("line", { x1: 0, y1: height - 2, x2: width, y2: height - 2, class: "spark-empty" })); return svg; }
  const min = Math.min(...ys), max = Math.max(...ys), pad = 3;
  const span = max - min || 1;
  const xAt = (i) => (ys.length === 1 ? width - pad : pad + (i * (width - 2 * pad)) / (ys.length - 1));
  const yAt = (v) => (max === min ? height / 2 : height - pad - ((v - min) / span) * (height - 2 * pad));
  const d = ys.map((v, i) => `${i ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ");
  svg.appendChild(s("path", { d, class: "spark-line", style: `stroke: var(${strokeVar})` }));
  svg.appendChild(s("circle", { cx: xAt(ys.length - 1).toFixed(1), cy: yAt(ys[ys.length - 1]).toFixed(1), r: 2.5, class: "spark-dot" }));
  return svg;
}

// rows: [{ label, value }] oldest first; optional second series `value2` drawn as a marker on top.
export function bars(rows, { width = 560, height = 120, label = "", unit = "", value2Label = "" } = {}) {
  const vals = (rows || []).map((r) => Number(r.value) || 0);
  const max = Math.max(1, ...vals, ...(rows || []).map((r) => Number(r.value2) || 0));
  const n = vals.length || 1, gap = 2, bw = Math.max(2, (width - gap * (n - 1)) / n);
  const svg = s("svg", { class: "bars", viewBox: `0 0 ${width} ${height + 14}`, preserveAspectRatio: "none", role: "img", "aria-label": label || "Daily values" });
  const title = s("title", {}, label);
  svg.appendChild(title);
  (rows || []).forEach((r, i) => {
    const v = Number(r.value) || 0, x = i * (bw + gap), h = (v / max) * height;
    const g = s("g", { class: "bar" });
    g.appendChild(s("title", {}, `${r.label}: ${fmt(v)}${unit}${r.value2 ? ` · ${value2Label} ${fmt(r.value2)}` : ""}`));
    g.appendChild(s("rect", { x: x.toFixed(1), y: (height - h).toFixed(1), width: bw.toFixed(1), height: Math.max(v ? 1 : 0, h).toFixed(1), class: "bar-fill" }));
    if (r.value2) g.appendChild(s("rect", { x: x.toFixed(1), y: (height - (r.value2 / max) * height - 2).toFixed(1), width: bw.toFixed(1), height: 3, class: "bar-mark" }));
    svg.appendChild(g);
  });
  if (rows && rows.length) {
    svg.appendChild(s("text", { x: 0, y: height + 12, class: "bar-axis" }, String(rows[0].label)));
    svg.appendChild(s("text", { x: width, y: height + 12, class: "bar-axis", "text-anchor": "end" }, String(rows[rows.length - 1].label)));
  }
  return svg;
}

// stages: [{ label, value, hint? }] widest first. Horizontal bars proportional to the first stage.
export function funnel(stages, { width = 560 } = {}) {
  const top = Math.max(1, Number(stages && stages[0] && stages[0].value) || 0);
  const rowH = 30, h = (stages || []).length * rowH;
  const svg = s("svg", { class: "funnel", viewBox: `0 0 ${width} ${h}`, role: "img", "aria-label": (stages || []).map((x) => `${x.label}: ${x.value}`).join(", ") });
  (stages || []).forEach((st, i) => {
    const v = Number(st.value) || 0, w = Math.max(v ? 3 : 0, (v / top) * (width * 0.62));
    const y = i * rowH;
    svg.appendChild(s("rect", { x: 0, y: y + 5, width: w.toFixed(1), height: rowH - 10, class: `funnel-bar funnel-${i}` }));
    svg.appendChild(s("text", { x: w + 8, y: y + rowH / 2 + 4, class: "funnel-label" }, `${fmt(v)}  ${st.label}${st.hint ? "  ·  " + st.hint : ""}`));
  });
  return svg;
}

// A thin horizontal meter: value of max, with an optional tick (e.g. a goal).
export function meter(value, max, { width = 160, height = 6, label = "" } = {}) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const svg = s("svg", { class: "meter", viewBox: `0 0 ${width} ${height}`, width, height, role: "img", "aria-label": label || `${fmt(value)} of ${fmt(max)}` });
  svg.appendChild(s("rect", { x: 0, y: 0, width, height, class: "meter-track" }));
  svg.appendChild(s("rect", { x: 0, y: 0, width: (pct * width).toFixed(1), height, class: "meter-fill" }));
  return svg;
}
