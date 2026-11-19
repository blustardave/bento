/* ------------------------------------------------------------------ *
 * Charts: read a range of the sheet and draw it as SVG.
 * Colours come from CSS variables, so charts follow the theme.
 * ------------------------------------------------------------------ */
import type { ChartType, Doc, Rect } from "./doc";
import { cellName, colIndex, parseNum } from "./util";

export interface Series { name: string; values: (number | null)[] }
export interface ChartData { categories: string[]; series: Series[] }

export const CHART_TYPES: { type: ChartType; label: string }[] = [
  { type: "column", label: "Column" },
  { type: "bar", label: "Bar" },
  { type: "line", label: "Line" },
  { type: "pie", label: "Pie" },
];

const MAX_POINTS = 1000;
const COLORS = 6;

/** "A1:C10" (or "A1") → a rectangle in data coordinates. */
export function parseRange(text: string): Rect | null {
  const m = /^\s*\$?([a-z]+)\$?(\d+)(?:\s*:\s*\$?([a-z]+)\$?(\d+))?\s*$/i.exec(text);
  if (!m) return null;
  const c0 = colIndex(m[1].toUpperCase()), r0 = Number(m[2]) - 1;
  const c1 = m[3] ? colIndex(m[3].toUpperCase()) : c0, r1 = m[4] ? Number(m[4]) - 1 : r0;
  if (r0 < 0 || r1 < 0 || c0 < 0 || c1 < 0) return null;
  return { r0: Math.min(r0, r1), c0: Math.min(c0, c1), r1: Math.max(r0, r1), c1: Math.max(c0, c1) };
}

export function rangeText(r: Rect): string {
  return r.r0 === r.r1 && r.c0 === r.c1 ? cellName(r.r0, r.c0) : `${cellName(r.r0, r.c0)}:${cellName(r.r1, r.c1)}`;
}

/**
 * The block of data around a cell: grows while there's anything in the
 * next row or column (like Sheets picking a chart's range).
 */
export function dataRegion(doc: Doc, r: number, c: number): Rect {
  const filled = (rr: number, cc: number) => doc.raw(rr, cc) !== "";
  const rect = { r0: r, c0: c, r1: r, c1: c };
  for (let grew = true, guard = 0; grew && guard < 5000; guard++) {
    grew = false;
    const rowHas = (rr: number) => { for (let cc = rect.c0; cc <= rect.c1; cc++) if (filled(rr, cc)) return true; return false; };
    const colHas = (cc: number) => { for (let rr = rect.r0; rr <= rect.r1; rr++) if (filled(rr, cc)) return true; return false; };
    if (rect.r0 > 0 && rowHas(rect.r0 - 1)) { rect.r0--; grew = true; }
    if (rect.r1 + 1 < doc.rows.length && rowHas(rect.r1 + 1)) { rect.r1++; grew = true; }
    if (rect.c0 > 0 && colHas(rect.c0 - 1)) { rect.c0--; grew = true; }
    if (colHas(rect.c1 + 1) && rect.c1 + 1 < doc.displayCols()) { rect.c1++; grew = true; }
  }
  return rect;
}

function numberAt(doc: Doc, r: number, c: number): number | null {
  const v = doc.engine.value(r, c);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = parseNum(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Work out labels and series from a range: text in the first row / column is used as names. */
export function chartData(doc: Doc, range: string): ChartData | null {
  const rect = parseRange(range);
  if (!rect) return null;
  const r1 = Math.min(rect.r1, rect.r0 + MAX_POINTS);
  const text = (r: number, c: number) => doc.display(r, c).trim();
  const isText = (r: number, c: number) => text(r, c) !== "" && numberAt(doc, r, c) === null;

  const cols = rect.c1 - rect.c0 + 1, rows = r1 - rect.r0 + 1;
  let labelCol = false;
  if (cols > 1) for (let r = rect.r0 + 1; r <= r1 && !labelCol; r++) if (isText(r, rect.c0)) labelCol = true;
  const vc0 = rect.c0 + (labelCol ? 1 : 0);
  let headerRow = false;
  if (rows > 1) {
    headerRow = true;
    let any = false;
    for (let c = vc0; c <= rect.c1; c++) {
      if (text(rect.r0, c) === "") continue;
      any = true;
      if (!isText(rect.r0, c)) headerRow = false;
    }
    if (!any && !(labelCol && text(rect.r0, rect.c0))) headerRow = false;
  }
  const dr0 = rect.r0 + (headerRow ? 1 : 0);
  const categories: string[] = [];
  for (let r = dr0; r <= r1; r++) categories.push(labelCol ? text(r, rect.c0) : String(r - dr0 + 1));
  const series: Series[] = [];
  for (let c = vc0; c <= rect.c1; c++) {
    const values: (number | null)[] = [];
    let any = false;
    for (let r = dr0; r <= r1; r++) { const n = numberAt(doc, r, c); values.push(n); if (n !== null) any = true; }
    if (!any) continue;
    series.push({ name: headerRow ? text(rect.r0, c) || cellName(rect.r0, c).replace(/\d+/, "") : `Series ${series.length + 1}`, values });
  }
  if (!series.length || !categories.length) return null;
  return { categories, series };
}

/* -------------------------------- drawing -------------------------------- */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const color = (i: number) => `var(--chart-${(i % COLORS) + 1})`;
/** Rough text width for 11px UI text; good enough for layout decisions. */
const textW = (s: string, px = 11) => s.length * px * 0.56;

function fit(s: string, w: number, px = 11): string {
  if (textW(s, px) <= w) return s;
  const n = Math.max(1, Math.floor(w / (px * 0.56)) - 1);
  return n >= s.length ? s : s.slice(0, n) + "…";
}

function niceStep(span: number, target: number): number {
  const raw = span / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
}

export function compact(n: number): string {
  const a = Math.abs(n);
  const t = (v: number) => String(Number(v.toFixed(Math.abs(v) < 10 ? 1 : 0)));
  if (a >= 1e9) return t(n / 1e9) + "B";
  if (a >= 1e6) return t(n / 1e6) + "M";
  if (a >= 1e4) return t(n / 1e3) + "k";
  return String(Number(n.toPrecision(6)));
}

interface Box { x: number; y: number; w: number; h: number }

function legend(series: string[], box: Box, out: string[]): number {
  // One row, centred; drops names that don't fit.
  const items = series.map((s, i) => ({ s: fit(s, 120), i }));
  const widths = items.map((it) => 14 + textW(it.s) + 14);
  let total = 0, n = 0;
  while (n < items.length && total + widths[n] <= box.w) total += widths[n++];
  let x = box.x + (box.w - total) / 2;
  for (let k = 0; k < n; k++) {
    const it = items[k];
    out.push(`<rect x="${x}" y="${box.y + 1}" width="8" height="8" rx="2" fill="${color(it.i)}"/>`);
    out.push(`<text x="${x + 13}" y="${box.y + 9}" class="lbl">${esc(it.s)}</text>`);
    x += widths[k];
  }
  return 18;
}

/** Draw a chart as an SVG string sized w × h. */
export function chartSvg(type: ChartType, data: ChartData | null, w: number, h: number, title?: string): string {
  const out: string[] = [];
  const pad = 14;
  let top = pad;
  if (title) {
    out.push(`<text x="${pad}" y="${top + 11}" class="title">${esc(fit(title, w - pad * 2, 13))}</text>`);
    top += 26;
  }
  if (!data) {
    out.push(`<text x="${w / 2}" y="${(top + h) / 2}" class="lbl empty" text-anchor="middle">No numbers to chart in this range</text>`);
    return wrap(w, h, out);
  }
  if (type === "pie") return pie(data, { x: pad, y: top, w: w - pad * 2, h: h - top - pad }, out, w, h);

  const names = data.series.map((s) => s.name);
  if (data.series.length > 1) top += legend(names, { x: pad, y: top, w: w - pad * 2, h: 0 }, out) + 4;

  const all = data.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  let lo = Math.min(0, ...all), hi = Math.max(0, ...all);
  if (lo === hi) hi = lo + 1;
  const horizontal = type === "bar";
  const plotLen = horizontal ? w - pad * 2 : h - top - pad - 18;
  const step = niceStep(hi - lo, Math.max(2, Math.min(6, Math.floor(plotLen / 48))));
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  const tickLabels = ticks.map(compact);
  const n = data.categories.length;

  if (!horizontal) {
    const axisW = Math.max(...tickLabels.map((t) => textW(t))) + 8;
    const plot: Box = { x: pad + axisW, y: top + 4, w: w - pad * 2 - axisW, h: h - top - pad - 22 };
    if (plot.w < 20 || plot.h < 20) return wrap(w, h, out);
    const Y = (v: number) => plot.y + plot.h - ((v - lo) / (hi - lo)) * plot.h;
    for (let i = 0; i < ticks.length; i++) {
      const y = Math.round(Y(ticks[i])) + 0.5;
      out.push(`<line x1="${plot.x}" x2="${plot.x + plot.w}" y1="${y}" y2="${y}" class="${ticks[i] === 0 ? "axis" : "grid"}"/>`);
      out.push(`<text x="${plot.x - 6}" y="${y + 4}" class="lbl" text-anchor="end">${tickLabels[i]}</text>`);
    }
    const band = plot.w / n;
    const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plot.w / 56))));
    for (let i = 0; i < n; i += every) {
      const cx = plot.x + band * (i + 0.5);
      out.push(`<text x="${cx}" y="${plot.y + plot.h + 15}" class="lbl" text-anchor="middle">${esc(fit(data.categories[i], band * every - 4))}</text>`);
    }
    if (type === "column") {
      const k = data.series.length;
      const group = band * (k > 1 ? 0.78 : 0.62);
      const bw = Math.max(1, group / k - (k > 1 ? 1 : 0));
      const zero = Y(0);
      data.series.forEach((s, si) => {
        s.values.forEach((v, i) => {
          if (v === null || v === 0) return;
          const x = plot.x + band * i + (band - group) / 2 + si * (group / k);
          const y = Y(v);
          out.push(barPath(x, Math.min(y, zero), bw, Math.abs(zero - y), v > 0 ? "top" : "bottom", color(si), `${s.name} · ${data.categories[i]}: ${v}`));
        });
      });
    } else {
      data.series.forEach((s, si) => {
        const pts: string[] = [];
        let path = "";
        s.values.forEach((v, i) => {
          if (v === null) { path += " "; return; }
          const x = plot.x + band * (i + 0.5), y = Y(v);
          path += (path === "" || path.endsWith(" ") ? "M" : "L") + `${x.toFixed(1)},${y.toFixed(1)}`;
          if (n <= 40) pts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="${color(si)}"><title>${esc(`${s.name} · ${data.categories[i]}: ${v}`)}</title></circle>`);
        });
        out.push(`<path d="${path.trim()}" fill="none" stroke="${color(si)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
        out.push(...pts);
      });
    }
  } else {
    const labelW = Math.min(w * 0.3, Math.max(...data.categories.map((c) => textW(c))) + 8);
    const plot: Box = { x: pad + labelW, y: top + 4, w: w - pad * 2 - labelW - 6, h: h - top - pad - 22 };
    if (plot.w < 20 || plot.h < 20) return wrap(w, h, out);
    const X = (v: number) => plot.x + ((v - lo) / (hi - lo)) * plot.w;
    const every = Math.max(1, Math.ceil(ticks.length / Math.max(2, Math.floor(plot.w / 56))));
    for (let i = 0; i < ticks.length; i++) {
      const x = Math.round(X(ticks[i])) + 0.5;
      out.push(`<line y1="${plot.y}" y2="${plot.y + plot.h}" x1="${x}" x2="${x}" class="${ticks[i] === 0 ? "axis" : "grid"}"/>`);
      if (i % every === 0) out.push(`<text x="${x}" y="${plot.y + plot.h + 15}" class="lbl" text-anchor="middle">${tickLabels[i]}</text>`);
    }
    const band = plot.h / n;
    const everyCat = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plot.h / 16))));
    for (let i = 0; i < n; i += everyCat) {
      out.push(`<text x="${plot.x - 6}" y="${plot.y + band * (i + 0.5) + 4}" class="lbl" text-anchor="end">${esc(fit(data.categories[i], labelW - 6))}</text>`);
    }
    const k = data.series.length;
    const group = band * (k > 1 ? 0.78 : 0.62);
    const bh = Math.max(1, group / k - (k > 1 ? 1 : 0));
    const zero = X(0);
    data.series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        if (v === null || v === 0) return;
        const y = plot.y + band * i + (band - group) / 2 + si * (group / k);
        const x = X(v);
        out.push(barPath(Math.min(x, zero), y, Math.abs(x - zero), bh, v > 0 ? "right" : "left", color(si), `${s.name} · ${data.categories[i]}: ${v}`));
      });
    });
  }
  return wrap(w, h, out);
}

/** A bar with its far end slightly rounded. */
function barPath(x: number, y: number, w: number, h: number, end: "top" | "bottom" | "left" | "right", fill: string, tip: string): string {
  const r = Math.min(3, (end === "top" || end === "bottom" ? w : h) / 3, end === "top" || end === "bottom" ? h : w);
  const f = (v: number) => v.toFixed(1);
  let d: string;
  if (end === "top") d = `M${f(x)},${f(y + h)}V${f(y + r)}Q${f(x)},${f(y)} ${f(x + r)},${f(y)}H${f(x + w - r)}Q${f(x + w)},${f(y)} ${f(x + w)},${f(y + r)}V${f(y + h)}Z`;
  else if (end === "bottom") d = `M${f(x)},${f(y)}V${f(y + h - r)}Q${f(x)},${f(y + h)} ${f(x + r)},${f(y + h)}H${f(x + w - r)}Q${f(x + w)},${f(y + h)} ${f(x + w)},${f(y + h - r)}V${f(y)}Z`;
  else if (end === "right") d = `M${f(x)},${f(y)}H${f(x + w - r)}Q${f(x + w)},${f(y)} ${f(x + w)},${f(y + r)}V${f(y + h - r)}Q${f(x + w)},${f(y + h)} ${f(x + w - r)},${f(y + h)}H${f(x)}Z`;
  else d = `M${f(x + w)},${f(y)}H${f(x + r)}Q${f(x)},${f(y)} ${f(x)},${f(y + r)}V${f(y + h - r)}Q${f(x)},${f(y + h)} ${f(x + r)},${f(y + h)}H${f(x + w)}Z`;
  return `<path d="${d}" fill="${fill}"><title>${esc(tip)}</title></path>`;
}

function pie(data: ChartData, box: Box, out: string[], w: number, h: number): string {
  const s = data.series[0];
  const slices = s.values.map((v, i) => ({ v: v ?? 0, label: data.categories[i], i })).filter((x) => x.v > 0);
  const total = slices.reduce((a, x) => a + x.v, 0);
  if (!total) {
    out.push(`<text x="${w / 2}" y="${box.y + box.h / 2}" class="lbl empty" text-anchor="middle">Pie charts need positive numbers</text>`);
    return wrap(w, h, out);
  }
  const showLegend = box.w > 260;
  const legendW = showLegend ? Math.min(box.w * 0.42, Math.max(...slices.map((x) => textW(x.label))) + 60) : 0;
  const R = Math.max(10, Math.min(box.h, box.w - legendW - 12) / 2);
  const cx = box.x + (box.w - legendW - (showLegend ? 12 : 0)) / 2, cy = box.y + box.h / 2;
  let a = -Math.PI / 2;
  for (const sl of slices) {
    const frac = sl.v / total;
    const b = a + frac * Math.PI * 2;
    const tip = esc(`${sl.label}: ${sl.v} (${Math.round(frac * 1000) / 10}%)`);
    if (slices.length === 1) {
      out.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="${color(sl.i)}"><title>${tip}</title></circle>`);
    } else {
      const large = b - a > Math.PI ? 1 : 0;
      const p = (t: number) => `${(cx + R * Math.cos(t)).toFixed(2)},${(cy + R * Math.sin(t)).toFixed(2)}`;
      out.push(`<path d="M${cx},${cy}L${p(a)}A${R},${R} 0 ${large} 1 ${p(b)}Z" fill="${color(sl.i)}" class="slice"><title>${tip}</title></path>`);
    }
    if (frac >= 0.06 && R > 40) {
      const m = (a + b) / 2;
      out.push(`<text x="${(cx + R * 0.64 * Math.cos(m)).toFixed(1)}" y="${(cy + R * 0.64 * Math.sin(m) + 4).toFixed(1)}" class="pct" text-anchor="middle">${Math.round(frac * 100)}%</text>`);
    }
    a = b;
  }
  if (showLegend) {
    const lx = box.x + box.w - legendW;
    const rows = Math.min(slices.length, Math.floor(box.h / 20));
    let ly = cy - (rows * 20) / 2;
    for (let k = 0; k < rows; k++) {
      const sl = slices[k];
      out.push(`<rect x="${lx}" y="${ly + 5}" width="8" height="8" rx="2" fill="${color(sl.i)}"/>`);
      out.push(`<text x="${lx + 14}" y="${ly + 13}" class="lbl">${esc(fit(sl.label, legendW - 20))}</text>`);
      ly += 20;
    }
  }
  return wrap(w, h, out);
}

function wrap(w: number, h: number, body: string[]): string {
  return `<svg class="chart-svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${body.join("")}</svg>`;
}
