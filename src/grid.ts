import { fromTSV, toTSV } from "./csv";
import { CellSet, DEFAULT_WIDTH, Doc, Rect, Sel, allRects, selRect } from "./doc";
import { Engine, offsetFormula } from "./formula";
import { tokenize, type Tok } from "./fcore";
import { fillValues } from "./fill";
import { DEFAULT_FONT, DEFAULT_SIZE, Style, Theme, applyNumFmt, ptToPx, resolveColor } from "./format";
import { clamp, colName, parseNum } from "./util";

const BASE_ROW_H = 22;
const BASE_HEAD_H = 24;
const MAX_PX = 15_000_000; // browsers cap element height; beyond this we scale the scrollbar
const BASE_PAD = 5;
const FONT_STACK = '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif';
const BASE_FONT = `13px ${FONT_STACK}`;
const BASE_FONT_BOLD = `600 13px ${FONT_STACK}`;
export const ZOOMS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 2];

const NO_STYLE: Style = {};

type Zone = "cell" | "col" | "row" | "corner";

interface Colors {
  bg: string; surface: string; surface2: string; line: string; lineStrong: string;
  text: string; text2: string; muted: string; accent: string; accentText: string;
  accentSoft: string; accentSofter: string; error: string; match: string; raised: string;
  selFill: string; selHead: string; selHeadStrong: string;
}

export interface GridHooks {
  onSelection(): void;
  onChange(): void;
  onContextMenu(zone: Zone, x: number, y: number): void;
  onColumnMenu(c: number, x: number, y: number): void;
  onEditText(text: string | null): void;
  onNotice?(text: string): void;
  /** Ask a yes/no question (e.g. before overwriting cells). */
  onConfirm?(title: string, message: string, yes: string): Promise<boolean>;
  /** After every repaint (floating objects follow the grid). */
  onRender?(): void;
  /** A click on a dropdown cell's chip: show its choices. */
  onDropdown?(r: number, c: number, x: number, y: number): void;
  /** An image on the clipboard was pasted. */
  onPasteImage?(file: File): void;
}

type Drag =
  | { kind: "cells" }
  | { kind: "cols" }
  | { kind: "rows" }
  | { kind: "resize"; col: number; startX: number; startW: number }
  | { kind: "fill"; src: Rect }
  | { kind: "move"; src: Rect; grabR: number; grabC: number }
  | { kind: "freezeRows" }
  | { kind: "freezeCols" }
  | { kind: "pointref" }
  | Reorder;

/** Dragging whole selected columns/rows to a new place. */
interface Reorder {
  kind: "reorder";
  axis: "col" | "row";
  from: number; n: number; cur: number;
  start: number;          // pointer x (cols) / y (rows) at pointerdown
  blockStart: number;     // block's left/top on screen at pointerdown
  blockSize: number;
  /** Screen geometry of every visible line at pointerdown: [index, start, size]. */
  lines: [number, number, number][];
  before: number;         // lines before the visible window (not in the block)
  lifted: boolean;
  click: { zone: string; x: number; y: number };
  ghost: HTMLCanvasElement | null;
}

interface Editing { r: number; c: number; mode: "replace" | "edit" }

/** Internal clipboard: lets formulas survive copy/paste inside Bento. */
let lastCopy: { tsv: string; raw: string[][]; values: string[][]; styles: Style[][]; rows: number[]; c: number; widths?: number[]; heights?: (number | undefined)[] } | null = null;

export type PasteMode = "normal" | "values" | "format" | "plain" | "transpose";

function prefNumber(key: string, fallback: number): number {
  const v = Number(localStorage.getItem(key));
  return localStorage.getItem(key) !== null && Number.isFinite(v) ? v : fallback;
}

/** The formula as HTML with references coloured (same colours as the boxes on the grid). */
/** A reference's identity for colouring: B2 and $B$2 are the same cell. */
function refKey(text: string, r: { s: number; e: number }): string {
  return text.slice(r.s, r.e).replace(/\$/g, "").toUpperCase();
}
/** One colour per distinct reference, in order of first appearance. */
function refColors(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of Engine.references(text)) { const k = refKey(text, r); if (!m.has(k)) m.set(k, REF_COLORS[m.size % REF_COLORS.length]); }
  return m;
}
/** The reference the caret is in or touching, if any. */
function refAt(text: string, caret: number) {
  if (caret < 0 || !text.startsWith("=")) return null;
  return Engine.references(text).find((r) => caret >= r.s && caret <= r.e) ?? null;
}

function highlightFormula(text: string, caret = -1): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  let toks: Tok[];
  try { toks = tokenize(text.slice(1)); } catch { return esc(text); }
  let out = "=";
  let last = 0;
  const body = text.slice(1);
  const colors = refColors(text);
  const active = refAt(text, caret);
  const activeKey = active ? refKey(text, active) : null;
  const paint = (span: string) => {
    const key = span.replace(/\$/g, "").toUpperCase();
    const color = colors.get(key) ?? REF_COLORS[0];
    return key === activeKey
      ? `<span style="color:${color};background:${color}26;border-radius:2px;box-shadow:0 0 0 1px ${color}55">${esc(span)}</span>`
      : `<span style="color:${color}">${esc(span)}</span>`;
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    out += esc(body.slice(last, t.s));
    let span = body.slice(t.s, t.e);
    let cls = "";
    let color = "";
    if (t.t === "ref" || t.t === "cols" || t.t === "rows") {
      // A1:B5 is one reference, one colour.
      const nx = toks[i + 1], b = toks[i + 2];
      if (t.t === "ref" && nx?.t === "op" && nx.v === ":" && b?.t === "ref" && !b.sh) { span = body.slice(t.s, b.e); i += 2; last = b.e; out += paint(span); continue; }
      out += paint(span);
      last = t.e;
      continue;
    } else if (t.t === "str") cls = "hl-str";
    else if (t.t === "num") cls = "hl-num";
    else if (t.t === "err") cls = "hl-err";
    else if (t.t === "id" && body[t.e] === "(") cls = "hl-fn";
    else if (t.t === "id") cls = t.v === "TRUE" || t.v === "FALSE" ? "hl-num" : "hl-name";
    out += color ? `<span style="color:${color}">${esc(span)}</span>` : cls ? `<span class="${cls}">${esc(span)}</span>` : esc(span);
    last = t.e;
  }
  return out + esc(body.slice(last));
}

const REF_COLORS = ["#4f86c6", "#d97757", "#6c8c55", "#9b7bb8", "#c9922e", "#3d968d", "#c9617f"];

export class Grid {
  doc: Doc | null = null;
  private pasteValuesNext = false;
  /** Gridline strength, 0–1 (Preferences). */
  gridAlpha = prefNumber("bento.gridOpacity", 100) / 100;
  /** Where Enter moves after typing (Preferences). */
  enterRight = localStorage.getItem("bento.enterMoves") === "right";
  readonly wrap: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scroller: HTMLElement;
  private spacer: HTMLElement;
  readonly editor: HTMLTextAreaElement;
  readonly sink: HTMLTextAreaElement;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private colors!: Colors;
  private xs = new Float64Array(1);
  private ncols = 0;
  private hoverCol = -1;
  private hoverChevron = false;
  private drag: Drag | null = null;
  private pointer = { x: 0, y: 0 };
  private autoScroll = 0;
  private raf = 0;
  private settingScroll = false;
  editing: Editing | null = null;
  /** Fill-handle drag: the range it would fill to. */
  private fillTarget: Rect | null = null;
  /** Drag-to-move: where the selection would land. */
  private moveTarget: Rect | null = null;
  /** Freeze drag: how many rows/columns would be frozen. */
  private freezePreview: number | null = null;
  private hoverFreeze: "freezeRows" | "freezeCols" | null = null;
  private editorWraps = false;
  /** When set, cells whose text matches are highlighted (find). */
  matcher: ((s: string) => boolean) | null = null;
  /** Zoom factor (1 = 100%). Column widths are stored unzoomed. */
  zoom = 1;

  /** Snap a CSS-pixel value to whole device pixels, so lines stay crisp at 125%/150% scaling. */
  private S(v: number): number { return Math.round(v * this.dpr) / this.dpr; }
  /** One device pixel (or two on 150%+ screens), in CSS pixels: the thickness of grid lines. */
  private get lw() { return Math.max(1, Math.round(this.dpr)) / this.dpr; }
  private get rh() { return this.S(BASE_ROW_H * this.zoom); }
  private get hh() { return this.S(BASE_HEAD_H * this.zoom); }
  private get pad() { return Math.round(BASE_PAD * this.zoom); }
  private get font() { return `${13 * this.zoom}px ${FONT_STACK}`; }
  private get fontHead() { return `${12 * this.zoom}px ${FONT_STACK}`; }
  /** Thickness of the freeze bars / lines. */
  private get freezeBar() { return this.S(Math.max(3, Math.round(3 * this.zoom))); }
  private get fontHeadBold() { return `600 ${12 * this.zoom}px ${FONT_STACK}`; }
  /** On-screen width of a column. */
  private cw(c: number): number { return this.S(this.doc!.width(c) * this.zoom); }

  setZoom(z: number) {
    const d = this.doc;
    // Keep the top-left cell in place.
    const ratio = z / this.zoom;
    this.zoom = z;
    if (d) { d.scrollX *= ratio; d.scrollY *= ratio; }
    this.layout();
    if (d) this.setScroll(d.scrollX, d.scrollY);
    this.invalidate();
  }

  constructor(private hooks: GridHooks) {
    this.wrap = document.getElementById("grid-wrap")!;
    this.canvas = document.getElementById("grid-canvas") as HTMLCanvasElement;
    this.ctx = this.canvas.getContext("2d", { alpha: false })!;
    this.scroller = document.getElementById("scroller")!;
    this.spacer = document.getElementById("spacer")!;
    this.editor = document.getElementById("editor") as HTMLTextAreaElement;
    this.sink = document.getElementById("keysink") as HTMLTextAreaElement;
    this.readColors();
    new ResizeObserver(() => this.resize()).observe(this.wrap);
    this.bind();
  }

  /* ------------------------------ public ------------------------------ */

  setDoc(doc: Doc | null) {
    if (this.editing) this.commitEdit();
    this.doc = doc;
    this.layout();
    if (doc) {
      this.settingScroll = true;
      this.scroller.scrollLeft = doc.scrollX;
      this.scroller.scrollTop = this.toScrollTop(doc.scrollY);
      requestAnimationFrame(() => (this.settingScroll = false));
    }
    this.invalidate();
  }

  readColors() {
    const s = getComputedStyle(document.documentElement);
    const v = (n: string) => s.getPropertyValue(n).trim();
    this.colors = {
      bg: v("--bg"), surface: v("--surface"), surface2: v("--surface-2"), line: v("--line"),
      lineStrong: v("--line-strong"), text: v("--text"), text2: v("--text-2"), muted: v("--muted"),
      accent: v("--accent"), accentText: v("--accent-text"), accentSoft: v("--accent-soft"),
      accentSofter: v("--accent-softer"), error: v("--error"), match: v("--match"), raised: v("--raised"),
      selFill: v("--sel-fill"), selHead: v("--sel-head"), selHeadStrong: v("--sel-head-strong"),
    };
    this.invalidate();
  }

  invalidate() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.layout();
      this.render();
      this.placeEditor();
    });
  }

  focus() {
    if (!this.editing) {
      this.sink.value = "";
      this.sink.focus({ preventScroll: true });
    }
  }

  /** Change selection and scroll it into view. */
  select(sel: Sel, scroll = true) {
    const d = this.doc;
    if (!d) return;
    const maxR = d.displayRows() - 1;
    const maxC = d.displayCols() - 1;
    let ns: Sel = {
      ar: clamp(sel.ar, 0, maxR), ac: clamp(sel.ac, 0, maxC),
      fr: clamp(sel.fr, 0, maxR), fc: clamp(sel.fc, 0, maxC),
    };
    ns = this.snapToMerges(ns);
    if (sel.extra?.length) ns.extra = sel.extra;
    d.sel = ns;
    if (scroll) this.scrollIntoView(d.sel.fr, d.sel.fc);
    this.hooks.onSelection();
    this.invalidate();
  }

  /* ------------------------------ merges ------------------------------ */

  private mergeCache: { key: string; list: Rect[] } = { key: "", list: [] };

  /** Merged ranges in display coordinates (skipping any split up by a filter). */
  visibleMerges(): Rect[] {
    const d = this.doc;
    if (!d || !d.merges.length) return [];
    const key = `${d.id}:${d.version}:${d.merges.length}:${this.fb}:${this.fc}`;
    if (this.mergeCache.key === key) return this.mergeCache.list;
    const list: Rect[] = [];
    for (const m of d.merges) {
      const r0 = d.displayRow(m.r0), r1 = d.displayRow(m.r1);
      if (r0 < 0 || r1 < 0 || r1 - r0 !== m.r1 - m.r0) continue;
      // Merges can't straddle the frozen edge.
      if (r0 < this.fb && r1 >= this.fb) continue;
      if (m.c0 < this.fc && m.c1 >= this.fc) continue;
      list.push({ r0, c0: m.c0, r1, c1: m.c1 });
    }
    this.mergeCache = { key, list };
    return list;
  }

  /** The merged range (display coords) containing a cell, if any. */
  mergeAt(r: number, c: number): Rect | null {
    for (const m of this.visibleMerges()) if (r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1) return m;
    return null;
  }

  /** Active cell goes to a merge's top-left; the range grows to cover merges it touches. */
  private snapToMerges(s: Sel): Sel {
    const ms = this.visibleMerges();
    if (!ms.length) return s;
    const am = this.mergeAt(s.ar, s.ac);
    if (am) { s = { ...s, ar: am.r0, ac: am.c0 }; if (s.fr >= am.r0 && s.fr <= am.r1 && s.fc >= am.c0 && s.fc <= am.c1) { s.fr = am.r1; s.fc = am.c1; } }
    let rect = selRect(s);
    for (let changed = true; changed;) {
      changed = false;
      for (const m of ms) {
        if (m.r0 <= rect.r1 && rect.r0 <= m.r1 && m.c0 <= rect.c1 && rect.c0 <= m.c1) {
          const n = { r0: Math.min(rect.r0, m.r0), c0: Math.min(rect.c0, m.c0), r1: Math.max(rect.r1, m.r1), c1: Math.max(rect.c1, m.c1) };
          if (n.r0 !== rect.r0 || n.c0 !== rect.c0 || n.r1 !== rect.r1 || n.c1 !== rect.c1) { rect = n; changed = true; }
        }
      }
    }
    return {
      ar: s.ar, ac: s.ac,
      fr: s.fr >= s.ar ? rect.r1 : rect.r0,
      fc: s.fc >= s.ac ? rect.c1 : rect.c0,
    };
  }

  /** Screen rectangle of a cell, covering its whole merge. */
  private cellBox(r: number, c: number): { x: number; y: number; w: number; h: number } {
    const m = this.mergeAt(r, c);
    const r0 = m ? m.r0 : r, c0 = m ? m.c0 : c, r1 = m ? m.r1 : r, c1 = m ? m.c1 : c;
    const x = this.colLeft(c0), y = this.rowTop(r0);
    return { x, y, w: this.colLeft(c1) + this.cw(c1) - x, h: this.rowTop(r1) + this.rowH(r1) - y };
  }

  selectAll() {
    const d = this.doc;
    if (!d) return;
    this.select({ ar: 0, ac: 0, fr: this.fullRow(), fc: this.fullCol() }, false);
  }

  /** Last row / column a whole-column / whole-row selection reaches. */
  fullRow(): number { return Math.max(0, this.doc!.displayRows() - 1); }
  fullCol(): number { return Math.max(0, this.doc!.displayCols() - 1); }

  /** Does a range cover whole columns / whole rows? */
  isWholeCols(r: Rect): boolean { return r.r0 === 0 && r.r1 >= this.fullRow(); }
  isWholeRows(r: Rect): boolean { return r.c0 === 0 && r.c1 >= this.fullCol(); }

  /** Last display row that holds data. */
  lastRow(): number {
    const d = this.doc!;
    return Math.max(0, (d.view ? d.view.length : d.rows.length) - 1);
  }

  /* ----------------------------- geometry ----------------------------- */

  /** Frozen rows / columns actually shown (capped so the scrolling area never disappears). */
  private fbEff = 0;
  private fcEff = 0;
  private get fb(): number { return this.fbEff; }
  private get fc(): number { return this.fcEff; }
  private get bodyTop(): number { return this.hh + this.yOf(this.fb); }
  private get frozenW(): number { return this.xs[Math.min(this.fc, this.ncols)] ?? 0; }
  private get bodyLeft(): number { return this.rowHeaderWidth() + this.frozenW; }

  private updateFrozen() {
    const d = this.doc!;
    let k = Math.min(d.frozenRows, d.displayRows() - 1);
    while (k > 0 && this.hh + this.yOf(k) > this.scroller.clientHeight - this.rh * 2) k--;
    this.fbEff = Math.max(0, k);
    let j = Math.min(d.frozenCols, this.ncols - 1);
    while (j > 0 && this.rowHeaderWidth() + this.xs[j] > this.scroller.clientWidth - 80 * this.zoom) j--;
    this.fcEff = Math.max(0, j);
  }

  /** Height of a display row on screen. */
  rowH(r: number): number {
    const d = this.doc;
    if (!d || !d.anyTall) return this.rh;
    const h = d.rowHeight(d.dataRow(r));
    return h ? this.S(h * this.zoom) : this.rh;
  }

  /** Running row tops, only built when some rows are taller than default. */
  private ys: Float64Array | null = null;
  private ysKey = "";

  private buildYs() {
    const d = this.doc;
    if (!d || !d.anyTall) { this.ys = null; this.ysKey = ""; return; }
    const n = d.displayRows();
    const key = `${d.id}:${d.version}:${this.zoom}:${n}`;
    if (key === this.ysKey) return;
    this.ysKey = key;
    const ys = this.ys && this.ys.length === n + 1 ? this.ys : new Float64Array(n + 1);
    let y = 0;
    for (let r = 0; r < n; r++) { ys[r] = y; y += this.rowH(r); }
    ys[n] = y;
    this.ys = ys;
  }

  /** Top of display row r, measured from the top of row 0. */
  private yOf(r: number): number {
    return this.ys ? this.ys[Math.min(r, this.ys.length - 1)] : r * this.rh;
  }

  /** Which display row sits at a y offset inside the scrolling body. */
  private rowAtBody(y: number): number {
    const d = this.doc!;
    const n = d.displayRows();
    const fb = this.fb;
    if (!this.ys) return clamp(fb + Math.floor(y / this.rh), fb, n - 1);
    const target = this.ys[fb] + y;
    let lo = fb, hi = n - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (this.ys[m] <= target) lo = m; else hi = m - 1;
    }
    return lo;
  }

  rowHeaderWidth(): number {
    const d = this.doc;
    if (!d) return 46;
    const last = d.dataRow(d.displayRows() - 1) + 1;
    return this.S(Math.round(Math.max(46, 20 + String(last).length * 7.6) * this.zoom));
  }

  private layout() {
    const d = this.doc;
    if (!d) { this.spacer.style.width = "1px"; this.spacer.style.height = "1px"; return; }
    // Dusk uses the dark versions of palette colours.
    const t = document.documentElement.dataset.theme;
    this.theme = t === "dusk" ? "dusk" : t === "dark" ? "dark" : "light";
    const n = d.displayCols();
    if (this.xs.length !== n + 1) this.xs = new Float64Array(n + 1);
    let x = 0;
    for (let c = 0; c < n; c++) { this.xs[c] = x; x += this.cw(c); }
    this.xs[n] = x;
    this.ncols = n;
    this.buildYs();
    this.updateFrozen();
    const w = this.rowHeaderWidth() + x + 60;
    const h = this.bodyTop + Math.min(this.contentH(), MAX_PX);
    if (this.spacer.style.width !== w + "px") this.spacer.style.width = w + "px";
    if (this.spacer.style.height !== h + "px") this.spacer.style.height = h + "px";
  }

  private contentH(): number {
    const d = this.doc;
    return d ? this.yOf(d.displayRows()) - this.yOf(this.fb) + 12 : 0;
  }

  private realMaxY(): number {
    return Math.max(0, this.contentH() - (this.scroller.clientHeight - this.bodyTop));
  }

  private spacerMaxY(): number {
    return Math.max(0, this.scroller.scrollHeight - this.scroller.clientHeight);
  }

  private fromScrollTop(t: number): number {
    const sm = this.spacerMaxY();
    return sm > 0 ? (t / sm) * this.realMaxY() : 0;
  }

  private toScrollTop(y: number): number {
    const rm = this.realMaxY();
    return rm > 0 ? (y / rm) * this.spacerMaxY() : 0;
  }

  private get sx(): number { return this.S(this.doc?.scrollX ?? 0); }
  private get sy(): number { return this.S(this.doc?.scrollY ?? 0); }

  rowTop(r: number): number {
    return r < this.fb ? this.hh + this.yOf(r) : this.bodyTop + this.yOf(r) - this.yOf(this.fb) - this.sy;
  }

  colLeft(c: number): number {
    const x = this.rowHeaderWidth() + this.xs[Math.min(c, this.ncols)];
    return c < this.fc ? x : x - this.sx;
  }

  private colAtContent(cx: number): number {
    const xs = this.xs;
    let lo = 0, hi = this.ncols - 1;
    if (cx <= 0) return 0;
    if (cx >= xs[this.ncols]) return this.ncols - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (xs[m] <= cx) lo = m; else hi = m - 1;
    }
    while (lo < this.ncols - 1 && xs[lo + 1] === xs[lo]) lo++;
    return lo;
  }

  colAt(x: number): number {
    const rhw = this.rowHeaderWidth();
    if (this.fc && x < this.bodyLeft) return Math.min(this.fc - 1, this.colAtContent(x - rhw));
    return Math.max(this.fc, this.colAtContent(x - rhw + this.sx));
  }

  rowAt(y: number): number {
    if (this.fb && y >= this.hh && y < this.bodyTop) {
      let r = 0;
      while (r + 1 < this.fb && this.hh + this.yOf(r + 1) <= y) r++;
      return r;
    }
    return this.rowAtBody(y - this.bodyTop + this.sy);
  }

  private zoneAt(x: number, y: number): Zone {
    const rhw = this.rowHeaderWidth();
    if (y < this.hh) return x < rhw ? "corner" : "col";
    return x < rhw ? "row" : "cell";
  }

  /** If (x, y) is on a column border in the header, which column it resizes. */
  private resizeColAt(x: number, y: number): number {
    if (y >= this.hh || !this.doc) return -1;
    const rhw = this.rowHeaderWidth();
    for (let c = 0; c < this.ncols; c++) {
      const right = this.colLeft(c) + this.cw(c);
      if (right < rhw || (c >= this.fc && right <= this.bodyLeft + 2)) continue;
      if (right > this.w + 10) break;
      if (Math.abs(x - right) <= 4 && this.cw(c) > 0) return c;
    }
    return -1;
  }

  scrollIntoView(r: number, c: number) {
    const d = this.doc;
    if (!d) return;
    const viewW = this.scroller.clientWidth - this.bodyLeft;
    const viewH = this.scroller.clientHeight - this.bodyTop;
    let { scrollX: x, scrollY: y } = d;
    if (c >= this.fc) {
      const left = this.xs[Math.min(c, this.ncols)] - this.frozenW;
      const right = this.xs[Math.min(c + 1, this.ncols)] - this.frozenW;
      if (left < x) x = left;
      else if (right > x + viewW) x = Math.max(0, right - viewW);
    }
    if (r >= this.fb) {
      const top = this.yOf(r) - this.yOf(this.fb);
      const h = this.rowH(r);
      if (top < y) y = top;
      else if (top + h > y + viewH) y = top + h - viewH;
    }
    if (x !== d.scrollX || y !== d.scrollY) this.setScroll(x, y);
  }

  private setScroll(x: number, y: number) {
    const d = this.doc!;
    d.scrollX = Math.max(0, x);
    d.scrollY = clamp(y, 0, this.realMaxY());
    this.settingScroll = true;
    this.scroller.scrollLeft = d.scrollX;
    this.scroller.scrollTop = this.toScrollTop(d.scrollY);
    d.scrollX = this.scroller.scrollLeft;
    requestAnimationFrame(() => (this.settingScroll = false));
    this.invalidate();
  }

  private resize() {
    this.dpr = window.devicePixelRatio || 1;
    this.ysKey = ""; // row tops depend on pixel snapping
    this.w = this.wrap.clientWidth;
    this.h = this.wrap.clientHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    // Draw straight away: resizing a canvas clears it, and waiting a frame
    // shows up as flicker while the window is being dragged bigger.
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.layout();
    this.render();
    this.placeEditor();
  }

  /* ----------------------------- cell styling ----------------------------- */

  private theme: Theme = "light";

  private cellFont(s: Style, header: boolean, zoom = this.zoom): string {
    const px = ptToPx(s.size ?? DEFAULT_SIZE) * zoom;
    const bold = s.b ?? header;
    const family = s.font && s.font !== DEFAULT_FONT ? `"${s.font}", ${FONT_STACK}` : FONT_STACK;
    return `${s.i ? "italic " : ""}${bold ? "600 " : ""}${px}px ${family}`;
  }

  /** What a cell shows: formula result, then number/date formatting. */
  private cellText(r: number, c: number, raw: string, s: Style, d: Doc = this.doc!): { text: string; err: boolean; numeric: boolean } {
    if (s.nf?.k === "text") return { text: raw, err: false, numeric: false };
    const shown = raw.charCodeAt(0) === 61 ? d.display(r, c) : raw;
    const err = raw.charCodeAt(0) === 61 && shown.charCodeAt(0) === 35 && /^#[A-Z0-9/]+[!?A]$/.test(shown);
    const numeric = !err && (!Number.isNaN(parseNum(shown)) || (s.nf?.k === "date" && applyNumFmt(shown, s.nf) !== shown));
    return { text: err ? shown : applyNumFmt(shown, s.nf), err, numeric };
  }

  /** Break text into lines that fit `maxW` (ctx.font must already be set). */
  private wrapLines(text: string, maxW: number): string[] {
    const ctx = this.ctx;
    const out: string[] = [];
    for (const para of text.split("\n")) {
      if (ctx.measureText(para).width <= maxW) { out.push(para); continue; }
      let line = "";
      for (const word of para.split(/(\s+)/)) {
        const next = line + word;
        if (ctx.measureText(next).width <= maxW || line === "") {
          // A single word wider than the cell: break it by characters.
          if (line === "" && ctx.measureText(word).width > maxW) {
            let chunk = "";
            for (const ch of word) {
              if (ctx.measureText(chunk + ch).width > maxW && chunk) { out.push(chunk); chunk = ""; }
              chunk += ch;
            }
            line = chunk;
          } else line = next;
        } else {
          out.push(line.trimEnd());
          line = word.trimStart();
        }
      }
      out.push(line);
    }
    return out;
  }

  /** How tall a data row needs to be (unzoomed px), or 0 for the default. */
  measureRow(d: Doc, r: number): number {
    const st = d.rowStyleArray(r) ?? [];
    const row = d.rows[r] ?? [];
    const ctx = this.ctx;
    let max = 0;
    for (let c = 0; c < Math.max(st.length, row.length); c++) {
      let v = row[c];
      // A formula's own line breaks are just layout: what counts is its result.
      if (v && v.charCodeAt(0) === 61) v = d.display(r, c);
      // Line breaks make a row taller even without any formatting.
      if (!st[c] && v && v.includes("\n")) {
        max = Math.max(max, v.split("\n").length * Math.round(ptToPx(DEFAULT_SIZE) * 1.35) + 4);
        continue;
      }
      if (!st[c]) continue;
      const s = d.styles[st[c]];
      if (!s.size && s.wrap !== "wrap" && !s.rot) continue;
      const lh = Math.round(ptToPx(s.size ?? DEFAULT_SIZE) * 1.35);
      let lines = 1;
      const raw = d.raw(r, c);
      if (s.rot && raw) {
        ctx.font = this.cellFont(s, r === 0 && d.freezeHeader, 1);
        const t = this.cellText(r, c, raw, s, d).text;
        const h = s.rot === "stack" ? [...t].length * lh + 8 : Math.ceil(ctx.measureText(t).width) + BASE_PAD * 2;
        max = Math.max(max, h);
        continue;
      }
      const shown = raw && raw.charCodeAt(0) === 61 ? d.display(r, c) : raw;
      if (s.wrap !== "wrap" && shown && shown.includes("\n") && !s.rot) {
        lines = shown.split("\n").length;
      } else if (s.wrap === "wrap" && raw) {
        ctx.font = this.cellFont(s, r === 0 && d.freezeHeader, 1);
        lines = this.wrapLines(this.cellText(r, c, raw, s, d).text, d.width(c) - BASE_PAD * 2).length;
      } else if (!raw && !s.size) continue;
      max = Math.max(max, lines * lh + 4);
    }
    return max > BASE_ROW_H ? max : 0;
  }

  /* ------------------------------ drawing ----------------------------- */

  private render() {
    const { ctx, w, h, colors: k } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = k.bg;
    ctx.fillRect(0, 0, w, h);
    const d = this.doc;
    if (!d) return;

    const rhw = this.rowHeaderWidth();
    const fb = this.fb, fc = this.fc;
    const bodyTop = this.bodyTop, bodyLeft = this.bodyLeft;
    const c0 = Math.max(fc, this.colAtContent(this.frozenW + this.sx));
    const c1 = Math.max(c0, this.colAtContent(this.sx + w - rhw));
    const r0 = this.rowAtBody(this.sy);
    const r1 = this.rowAtBody(this.sy + h - bodyTop);
    const rect = selRect(d.sel);
    const pass = (x: number, y: number, pw: number, ph: number, ra: number, rb: number, ca: number, cb: number, frozenRows: boolean) => {
      if (pw <= 0 || ph <= 0 || rb < ra || cb < ca) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, pw, ph);
      ctx.clip();
      void frozenRows;
      this.drawCells(ra, rb, ca, cb, rect, frozenRows);
      ctx.restore();
    };
    pass(bodyLeft, bodyTop, w - bodyLeft, h - bodyTop, r0, r1, c0, c1, false);
    if (fc) pass(rhw, bodyTop, this.frozenW, h - bodyTop, r0, r1, 0, fc - 1, false);
    if (fb) pass(bodyLeft, this.hh, w - bodyLeft, bodyTop - this.hh, 0, fb - 1, c0, c1, true);
    if (fb && fc) pass(rhw, this.hh, this.frozenW, bodyTop - this.hh, 0, fb - 1, 0, fc - 1, true);

    this.drawFillPreview();

    this.drawColHeaders(c0, c1, rect, bodyLeft, w);
    if (fc) this.drawColHeaders(0, fc - 1, rect, rhw, bodyLeft);
    this.drawRowHeaders(r0, r1, rect, rhw);

    // Grid edges.
    const drag = this.drag;
    const hot = (kind: "freezeRows" | "freezeCols") => drag?.kind === kind || this.hoverFreeze === kind;
    ctx.fillStyle = k.lineStrong;
    const L = this.lw;
    ctx.fillRect(0, this.hh - L, w, L);
    ctx.fillRect(rhw - L, 0, L, h);

    // Corner cell.
    ctx.fillStyle = k.bg;
    ctx.fillRect(0, 0, rhw - L, this.hh - L);
    if (d.filters.size) {
      ctx.fillStyle = k.accent;
      this.funnel(rhw / 2 - 6, this.hh / 2 - 6);
    }

    // Freeze handles: one thickness everywhere. With nothing frozen they sit on
    // the corner's edges; once frozen, the bar leaves the corner and becomes
    // the line across the sheet.
    const bar = this.freezeBar;
    const rowsColor = hot("freezeRows") ? k.accent : k.lineStrong;
    const colsColor = hot("freezeCols") ? k.accent : k.lineStrong;
    const hidingRows = drag?.kind === "freezeRows";
    const hidingCols = drag?.kind === "freezeCols";
    if (!hidingRows) {
      ctx.fillStyle = rowsColor;
      if (fb) ctx.fillRect(0, bodyTop - bar, w, bar);
      else ctx.fillRect(0, this.hh - bar, rhw, bar);
    }
    if (!hidingCols) {
      ctx.fillStyle = colsColor;
      if (fc) ctx.fillRect(bodyLeft - bar, 0, bar, h);
      else ctx.fillRect(rhw - bar, 0, bar, this.hh);
    }
    this.drawReorderGap();
    this.drawSpillOutline();
    this.drawSelectionOverlay();
    this.drawFormulaRefs();
    this.drawTraces();
    this.drawFreezePreview();
    this.hooks.onRender?.();
  }

  /* ------------------------- for floating objects ------------------------- */

  get headerHeight(): number { return this.hh; }
  colWidth(c: number): number { return this.cw(c); }
  viewport(): { w: number; h: number } { return { w: this.scroller.clientWidth, h: this.scroller.clientHeight }; }
  scrollBy(dx: number, dy: number) {
    const d = this.doc;
    if (d) this.setScroll(d.scrollX + dx, d.scrollY + dy);
  }
  /** Repaint right away (not on the next frame). */
  paintNow() { cancelAnimationFrame(this.raf); this.raf = 0; this.render(); }

  /**
   * Selection borders and the fill handle, drawn after everything else so
   * nothing (freeze lines, header edges) can cover them. Borders sit on the
   * grid lines, like Sheets. Each frozen region is clipped separately so a
   * scrolled selection never shows through the frozen panes.
   */
  private drawSelectionOverlay() {
    const d = this.doc!;
    const { ctx, colors: k } = this;
    const L = this.lw;
    const rhw = this.rowHeaderWidth();
    const regions: [number, number, number, number, boolean, boolean][] = [
      [this.bodyLeft - L, this.bodyTop - L, this.w, this.h, false, false],
    ];
    if (this.fc) regions.push([rhw - L, this.bodyTop - L, this.bodyLeft, this.h, false, true]);
    if (this.fb) regions.push([this.bodyLeft - L, this.hh - L, this.w, this.bodyTop, true, false]);
    if (this.fb && this.fc) regions.push([rhw - L, this.hh - L, this.bodyLeft, this.bodyTop, true, true]);
    const outline = (r: Rect, t: number) => {
      // Box from the grid line before the range to the grid line after it.
      const x0 = this.colLeft(r.c0) - L, x1 = this.colLeft(r.c1) + this.cw(r.c1);
      const y0 = this.rowTop(r.r0) - L, y1 = this.rowTop(r.r1) + this.rowH(r.r1);
      const T = this.S(t);
      ctx.fillRect(x0, y0, x1 - x0, T);
      ctx.fillRect(x0, y1 - T, x1 - x0, T);
      ctx.fillRect(x0, y0, T, y1 - y0);
      ctx.fillRect(x1 - T, y0, T, y1 - y0);
    };
    const main = selRect(d.sel);
    const am = this.mergeAt(d.sel.ar, d.sel.ac);
    const active: Rect = am ?? { r0: d.sel.ar, c0: d.sel.ac, r1: d.sel.ar, c1: d.sel.ac };
    const single = main.r0 === active.r0 && main.r1 === active.r1 && main.c0 === active.c0 && main.c1 === active.c1;
    for (const [x0, y0, x1, y1] of regions) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
      ctx.clip();
      ctx.fillStyle = k.accent;
      for (const e of d.sel.extra ?? []) outline(e, L);
      if (!single) outline(main, L);
      if (!this.editing) outline(active, 2);
      ctx.restore();
    }
    this.drawFillHandle(main);
  }

  private drawCells(r0: number, r1: number, c0: number, c1: number, sel: Rect, frozen: boolean) {
    const { ctx, colors: k } = this;
    const d = this.doc!;
    const rhw = this.rowHeaderWidth();
    const right = Math.min(this.w, this.colLeft(c1) + this.cw(c1));
    const pad = this.pad;

    // Merges touching this band of rows. Covered cells (not the top-left) are skipped.
    const merges = this.visibleMerges().filter((m) => m.r1 >= r0 && m.r0 <= r1 && m.c1 >= c0 && m.c0 <= c1);
    const covered = new Set<number>();
    for (const m of merges) for (let r = Math.max(m.r0, r0); r <= Math.min(m.r1, r1); r++)
      for (let c = Math.max(m.c0, c0); c <= Math.min(m.c1, c1); c++) if (r !== m.r0 || c !== m.c0) covered.add(r * 65536 + c);
    const mergeOf = (r: number, c: number) => merges.find((m) => m.r0 === r && m.c0 === c) ?? null;
    const boxOf = (r: number, c: number, m: Rect | null) => {
      if (!m) return { x: this.colLeft(c), y: this.rowTop(r), w: this.cw(c), h: this.rowH(r) };
      const x = this.colLeft(m.c0), y = this.rowTop(m.r0);
      return { x, y, w: this.colLeft(m.c1) + this.cw(m.c1) - x, h: this.rowTop(m.r1) + this.rowH(m.r1) - y };
    };
    // Merges whose top-left is scrolled off still need drawing.
    const anchors: [number, number][] = [];
    for (const m of merges) if (m.r0 < r0 || m.c0 < c0) anchors.push([m.r0, m.c0]);

    // 1. Backgrounds: fills, find matches, selection.
    const fillCell = (r: number, c: number) => {
      const dr = d.dataRow(r);
      const id = d.styleId(dr, c);
      const fill = id ? resolveColor(d.styles[id].fill, this.theme) : null;
      if (!fill) return;
      const b = boxOf(r, c, mergeOf(r, c));
      ctx.fillStyle = fill;
      ctx.fillRect(b.x, b.y, b.w, b.h);
    };
    for (let r = r0; r <= r1; r++) {
      const dr = d.dataRow(r);
      if (dr >= d.rows.length) break;
      const st = d.rowStyleArray(dr);
      if (!st) continue;
      for (let c = c0; c <= Math.min(c1, st.length - 1); c++) if (st[c] && !covered.has(r * 65536 + c)) fillCell(r, c);
    }
    for (const [r, c] of anchors) fillCell(r, c);
    if (this.matcher) {
      ctx.fillStyle = k.match;
      for (let r = r0; r <= r1; r++) {
        const dr = d.dataRow(r);
        if (dr >= d.rows.length) break;
        for (let c = c0; c <= c1; c++) {
          if (covered.has(r * 65536 + c) || !this.cw(c)) continue;
          if (this.matcher(d.display(dr, c))) { const b = boxOf(r, c, mergeOf(r, c)); ctx.fillRect(b.x, b.y, b.w, b.h); }
        }
      }
    }
    const selVisible = sel.r1 >= r0 && sel.r0 <= r1;
    const selY0 = this.rowTop(Math.max(sel.r0, r0)) - (sel.r0 < r0 ? 3 : 0);
    const selY1 = this.rowTop(Math.min(sel.r1, r1)) + this.rowH(Math.min(sel.r1, r1)) + (sel.r1 > r1 ? 3 : 0);
    const selX0 = this.colLeft(sel.c0);
    const selX1 = this.colLeft(sel.c1) + this.cw(sel.c1);
    const activeM = this.mergeAt(d.sel.ar, d.sel.ac);
    const single = activeM ? sel.r0 === activeM.r0 && sel.r1 === activeM.r1 && sel.c0 === activeM.c0 && sel.c1 === activeM.c1 : sel.r0 === sel.r1 && sel.c0 === sel.c1;
    if (selVisible && !single) {
      ctx.fillStyle = k.selFill;
      ctx.fillRect(selX0, selY0, selX1 - selX0, selY1 - selY0);
    }
    const extras = (d.sel.extra ?? []).filter((e) => e.r1 >= r0 && e.r0 <= r1);
    const extraBox = (e: Rect) => {
      const x0 = this.colLeft(e.c0), x1 = this.colLeft(e.c1) + this.cw(e.c1);
      const y0 = this.rowTop(Math.max(e.r0, r0)) - (e.r0 < r0 ? 3 : 0);
      const y1 = this.rowTop(Math.min(e.r1, r1)) + this.rowH(Math.min(e.r1, r1)) + (e.r1 > r1 ? 3 : 0);
      return { x0, y0, x1, y1 };
    };
    ctx.fillStyle = k.selFill;
    for (const e of extras) { const b = extraBox(e); ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); }

    // 2. Text. Overflowing text hides the grid lines it crosses.
    const skipV = new Set<number>(); // no vertical line after (r, c)
    ctx.textBaseline = "middle";
    const drawText = (r: number, c: number, spilled = false) => {
      const dr = d.dataRow(r);
      const row = d.rows[dr];
      if (!row && !spilled) return;
      // Spilled cells have no text of their own: show them like a formula result.
      const raw = spilled ? "=" : row[c];
      if (!raw) return;
      const m = mergeOf(r, c);
      const box = boxOf(r, c, m);
      if (box.w < 6) return;
      const st = d.rowStyleArray(dr);
      const s = st && st[c] ? d.styles[st[c]] : NO_STYLE;
      if (s.check || s.list || s.img) return; // drawn as widgets below
      const { text: full, err, numeric } = this.cellText(dr, c, raw, s);
      const header = r === 0 && d.frozenRows > 0;
      const ha = s.ha ?? (numeric && !header ? "r" : "l");
      const va = s.va ?? "b";
      const wrap = s.wrap ?? "overflow";
      const px = ptToPx(s.size ?? DEFAULT_SIZE) * this.zoom;
      const lh = Math.round(px * 1.35);
      ctx.font = this.cellFont(s, header);
      const { x, y, w: cw, h: rh } = box;
      const color = err ? k.error : resolveColor(s.color, this.theme) ?? k.text;

      if (s.rot === "up") {
        ctx.save();
        ctx.beginPath(); ctx.rect(x, y, cw - 1, rh - 1); ctx.clip();
        ctx.fillStyle = color;
        const tx = ha === "r" ? x + cw - pad - lh / 2 : ha === "c" ? x + cw / 2 : x + pad + lh / 2;
        const ty = va === "t" ? y + pad : va === "m" ? y + rh / 2 : y + rh - pad;
        ctx.translate(tx, ty);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = va === "t" ? "right" : va === "m" ? "center" : "left";
        const line = full.split("\n")[0];
        ctx.fillText(line, 0, 0.5);
        this.decorate(s, line, 0, 0.5, px, ctx.textAlign as CanvasTextAlign);
        ctx.restore();
        return;
      }

      let lines: string[];
      if (s.rot === "stack") lines = [...full.replace(/\n/g, " ")];
      else if (wrap === "wrap") lines = this.wrapLines(full, cw - pad * 2);
      else lines = full.split("\n");

      // How far the text may draw: into empty neighbours when overflowing.
      let clipW = cw - 1;
      if (!m && !s.rot && wrap === "overflow" && ha === "l" && !numeric) {
        const need = ctx.measureText(lines[0]).width + pad * 2;
        let cc = c;
        while (clipW < need && cc + 1 < this.ncols && this.colLeft(cc + 1) < this.w) {
          const next = row[cc + 1];
          if ((next !== undefined && next !== "") || covered.has(r * 65536 + cc + 1) || this.mergeAt(r, cc + 1)) break;
          skipV.add(r * 65536 + cc);
          cc++;
          clipW += this.cw(cc);
        }
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, clipW, rh - 1);
      ctx.clip();
      ctx.fillStyle = color;
      const align: CanvasTextAlign = s.rot === "stack" ? "center" : ha === "r" ? "right" : ha === "c" ? "center" : "left";
      ctx.textAlign = align;
      const tx = s.rot === "stack"
        ? (ha === "r" ? x + cw - pad - px / 2 : ha === "l" && s.ha ? x + pad + px / 2 : x + cw / 2)
        : ha === "r" ? x + cw - pad : ha === "c" ? x + cw / 2 : x + pad;
      const block = lines.length * lh;
      // Inset from the edge, but never more than fits: in a short row "top" stays above "bottom".
      const vp = Math.max(0, Math.min(4 * this.zoom, (rh - block) / 2));
      let ty = va === "t" ? y + vp + lh / 2
        : va === "m" ? y + (rh - block) / 2 + lh / 2
        : y + rh - vp - block + lh / 2;
      ty += 0.5;
      for (const line of lines) {
        ctx.fillText(line, tx, ty);
        if (!s.rot) this.decorate(s, line, tx, ty, px, align);
        ty += lh;
      }
      ctx.restore();
    };
    for (let r = r0; r <= r1; r++) {
      const dr = d.dataRow(r);
      if (dr >= d.rows.length) break;
      const len = d.rows[dr].length;
      for (let c = c0; c <= Math.min(c1, len - 1); c++) if (!covered.has(r * 65536 + c)) drawText(r, c);
    }
    for (const [r, c] of anchors) drawText(r, c);
    // Values spilled from dynamic-array formulas (FILTER, SORT, SEQUENCE…).
    for (const sp of d.engine.spillRects()) {
      for (let i = 0; i < sp.h; i++) {
        const dr = sp.r + i;
        const r = d.view ? d.displayRow(dr) : dr;
        if (r < r0 || r > r1) { if (!d.view && r > r1) break; continue; }
        for (let j = 0; j < sp.w; j++) {
          const c = sp.c + j;
          if ((!i && !j) || c < c0 || c > c1 || covered.has(r * 65536 + c)) continue;
          drawText(r, c, true);
        }
      }
    }

    // 2b. Checkboxes, dropdown chips and images in cells.
    for (let r = r0; r <= r1; r++) {
      const dr = d.dataRow(r);
      if (dr >= d.rows.length) break;
      const st = d.rowStyleArray(dr);
      if (!st) continue;
      for (let c = c0; c <= Math.min(c1, st.length - 1); c++) {
        if (!st[c] || covered.has(r * 65536 + c)) continue;
        const s = d.styles[st[c]];
        if (s.check || s.list || s.img) this.drawWidget(r, c, s, boxOf(r, c, mergeOf(r, c)));
      }
    }
    for (const [r, c] of anchors) {
      const s = d.style(d.dataRow(r), c);
      if (s.check || s.list || s.img) this.drawWidget(r, c, s, boxOf(r, c, mergeOf(r, c)));
    }

    // 3. Grid lines (none inside merged cells).
    const L = this.lw;
    ctx.fillStyle = k.line;
    ctx.globalAlpha = this.gridAlpha;
    const inMergeH = (r: number, c: number) => merges.some((m) => r >= m.r0 && r < m.r1 && c >= m.c0 && c <= m.c1);
    const inMergeV = (r: number, c: number) => merges.some((m) => r >= m.r0 && r <= m.r1 && c >= m.c0 && c < m.c1);
    for (let r = r0; r <= r1; r++) {
      const y = this.rowTop(r) + this.rowH(r) - L;
      if (!merges.length) { ctx.fillRect(rhw, y, right - rhw, L); continue; }
      for (let c = c0; c <= c1; c++) {
        if (inMergeH(r, c)) continue;
        ctx.fillRect(this.colLeft(c), y, this.cw(c), L);
      }
    }
    for (let c = c0; c <= c1; c++) {
      const cw = this.cw(c);
      if (!cw) continue;
      const x = this.colLeft(c) + cw - L;
      if (!skipV.size && !merges.length) {
        const top = frozen ? this.hh : this.bodyTop;
        const bottom = frozen ? this.bodyTop : Math.min(this.h, this.rowTop(r1) + this.rowH(r1));
        ctx.fillRect(x, top, L, bottom - top);
        continue;
      }
      for (let r = r0; r <= r1; r++) {
        if (skipV.has(r * 65536 + c) || inMergeV(r, c)) continue;
        ctx.fillRect(x, this.rowTop(r), L, this.rowH(r));
      }
    }

    ctx.globalAlpha = 1;
    void single;
  }

  /* ------------------------------ cell widgets ------------------------------ */

  private images = new Map<string, HTMLImageElement>();

  private imageFor(id: string): HTMLImageElement | null {
    const d = this.doc!;
    const url = d.images.get(id);
    if (!url) return null;
    let img = this.images.get(id);
    if (!img || img.src !== url) {
      img = new Image();
      img.onload = () => this.invalidate();
      img.src = url;
      this.images.set(id, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  /** Is this cell's checkbox ticked? */
  isChecked(dr: number, c: number): boolean {
    const v = this.doc!.engine.value(dr, c);
    return v === true || (typeof v === "string" && v.trim().toUpperCase() === "TRUE");
  }

  /** Where a cell's checkbox sits. */
  private checkBox(box: { x: number; y: number; w: number; h: number }, s: Style) {
    const z = this.zoom;
    const size = Math.round(13 * z);
    const ha = s.ha ?? "c";
    const x = ha === "l" ? box.x + this.pad : ha === "r" ? box.x + box.w - this.pad - size : box.x + (box.w - size) / 2;
    const va = s.va ?? "m";
    const y = va === "t" ? box.y + 5 * z : va === "b" && box.h > this.rh * 1.5 ? box.y + box.h - 5 * z - size : box.y + (box.h - size) / 2;
    return { x: Math.round(x), y: Math.round(y), w: size, h: size };
  }

  /** The clickable chip (or bare chevron) of a dropdown cell. */
  private chipBox(r: number, c: number, s: Style, box: { x: number; y: number; w: number; h: number }) {
    const d = this.doc!;
    const z = this.zoom;
    const text = d.display(d.dataRow(r), c);
    const h = Math.min(box.h - 6 * z, Math.round(20 * z));
    const y = box.y + (box.h - h) / 2;
    const chev = 16 * z;
    if (!text) return { x: box.x + box.w - chev - 4 * z, y, w: chev, h, text, valid: true };
    this.ctx.font = this.cellFont(s, false);
    const w = Math.min(box.w - 8 * z, this.ctx.measureText(text).width + 10 * z + chev);
    const valid = !!s.list?.includes(text);
    return { x: box.x + 4 * z, y, w, h, text, valid };
  }

  private drawWidget(r: number, c: number, s: Style, box: { x: number; y: number; w: number; h: number }) {
    const { ctx, colors: k } = this;
    const d = this.doc!;
    const dr = d.dataRow(r);
    const z = this.zoom;
    if (box.w < 8) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w - 1, box.h - 1);
    ctx.clip();
    if (s.img) {
      const img = this.imageFor(s.img);
      if (img) {
        const inset = 2 * z;
        const bw = box.w - inset * 2 - 1, bh = box.h - inset * 2 - 1;
        const scale = Math.min(bw / img.naturalWidth, bh / img.naturalHeight);
        const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
        const ha = s.ha ?? "c";
        const x = ha === "l" ? box.x + inset : ha === "r" ? box.x + box.w - inset - w - 1 : box.x + (box.w - w) / 2;
        const va = s.va ?? "m";
        const y = va === "t" ? box.y + inset : va === "b" ? box.y + box.h - inset - h - 1 : box.y + (box.h - h) / 2;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, x, y, w, h);
      }
    } else if (s.check) {
      const b = this.checkBox(box, s);
      const on = this.isChecked(dr, c);
      const rad = 2.5 * z;
      ctx.beginPath(); ctx.roundRect(b.x, b.y, b.w, b.h, rad);
      if (on) {
        ctx.fillStyle = k.accent;
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.7 * z;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(b.x + b.w * 0.26, b.y + b.h * 0.53);
        ctx.lineTo(b.x + b.w * 0.43, b.y + b.h * 0.7);
        ctx.lineTo(b.x + b.w * 0.75, b.y + b.h * 0.33);
        ctx.stroke();
      } else {
        ctx.beginPath(); ctx.roundRect(b.x + 0.8, b.y + 0.8, b.w - 1.6, b.h - 1.6, rad);
        ctx.strokeStyle = k.text2;
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
    } else if (s.list) {
      const chip = this.chipBox(r, c, s, box);
      const chevX = chip.x + chip.w - 11 * z;
      const chevY = chip.y + chip.h / 2;
      if (chip.text) {
        ctx.beginPath(); ctx.roundRect(chip.x, chip.y, chip.w, chip.h, chip.h / 2);
        if (chip.valid) { ctx.fillStyle = k.surface2; ctx.fill(); }
        else { ctx.strokeStyle = k.error; ctx.lineWidth = 1; ctx.setLineDash([3, 2]); ctx.stroke(); ctx.setLineDash([]); }
        ctx.font = this.cellFont(s, false);
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        ctx.fillStyle = chip.valid ? resolveColor(s.color, this.theme) ?? k.text : k.error;
        ctx.save();
        ctx.beginPath(); ctx.rect(chip.x, chip.y, chip.w - 16 * z, chip.h); ctx.clip();
        ctx.fillText(chip.text, chip.x + 8 * z, chevY + 0.5);
        ctx.restore();
      }
      ctx.strokeStyle = k.muted;
      ctx.lineWidth = 1.3 * z;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(chevX - 3 * z, chevY - 1.5 * z);
      ctx.lineTo(chevX, chevY + 1.5 * z);
      ctx.lineTo(chevX + 3 * z, chevY - 1.5 * z);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Did a click at (x, y) land on a cell's checkbox or dropdown chip? */
  private widgetHit(x: number, y: number): { kind: "check" | "list"; r: number; c: number } | null {
    const d = this.doc!;
    if (this.zoneAt(x, y) !== "cell") return null;
    let r = this.rowAt(y), c = this.colAt(x);
    const m = this.mergeAt(r, c);
    if (m) { r = m.r0; c = m.c0; }
    const dr = d.dataRow(r);
    if (dr >= d.rows.length && !d.rowStyleArray(dr)) return null;
    const s = d.style(dr, c);
    if (!s.check && !s.list) return null;
    const box = this.cellBox(r, c);
    const slop = 3 * this.zoom;
    const inside = (b: { x: number; y: number; w: number; h: number }) => x >= b.x - slop && x <= b.x + b.w + slop && y >= b.y - slop && y <= b.y + b.h + slop;
    if (s.check) return inside(this.checkBox(box, s)) ? { kind: "check", r, c } : null;
    return inside(this.chipBox(r, c, s, box)) ? { kind: "list", r, c } : null;
  }

  /** Tick or untick checkboxes: the clicked one, or every one in the selection. */
  toggleChecks(cells?: { r: number; c: number }[]) {
    const d = this.doc!;
    const list: { r: number; c: number }[] = [];
    if (cells) list.push(...cells.map(({ r, c }) => ({ r: d.dataRow(r), c })));
    else for (const rect of allRects(d.sel)) for (let r = rect.r0; r <= Math.min(rect.r1, this.lastRow() + 1000); r++) {
      const dr = d.dataRow(r);
      if (dr >= d.rows.length) break;
      for (let c = rect.c0; c <= rect.c1; c++) if (d.style(dr, c).check) list.push({ r: dr, c });
    }
    if (!list.length) return false;
    const allOn = list.every(({ r, c }) => this.isChecked(r, c));
    d.setCells(list.map(({ r, c }) => ({ r, c, v: allOn ? "FALSE" : "TRUE" })), allOn ? "Untick" : "Tick");
    this.hooks.onChange();
    return true;
  }

  /** Open the active cell's dropdown, if it has one. */
  openDropdown(): boolean {
    const d = this.doc!;
    const { ar, ac } = d.sel;
    const s = d.style(d.dataRow(ar), ac);
    if (!s.list) return false;
    const box = this.cellBox(ar, ac);
    const rect = this.wrap.getBoundingClientRect();
    this.hooks.onDropdown?.(ar, ac, rect.left + box.x, rect.top + box.y + box.h + 2);
    return true;
  }

  /* ------------------------- formulas: pointing ------------------------- */

  /** The formula bar, so clicks can put references into it too. */
  private bar: HTMLInputElement | null = null;
  private pointRef: { field: HTMLInputElement | HTMLTextAreaElement; start: number; end: number; ar: number; ac: number } | null = null;
  private pointing = false;

  setFormulaBar(input: HTMLInputElement) {
    this.bar = input;
    input.addEventListener("input", () => { if (!this.pointing) this.pointRef = null; if (this.editing) this.invalidate(); });
    for (const ev of ["keyup", "click", "select"]) input.addEventListener(ev, () => { if (this.editing && input.value.startsWith("=")) this.invalidate(); });
  }

  private formulaField(): HTMLInputElement | HTMLTextAreaElement | null {
    if (!this.editing) return null;
    const f = document.activeElement === this.bar && this.bar ? this.bar : this.editor;
    return f.value.startsWith("=") ? f : null;
  }

  /** Is the caret somewhere a reference could go (after "=", "(", ",", an operator…)? */
  private expectsRef(f: HTMLInputElement | HTMLTextAreaElement): boolean {
    const caret = f.selectionStart ?? f.value.length;
    if (this.pointRef && this.pointRef.field === f && caret === this.pointRef.end) return true;
    // Anywhere in a formula except inside quoted text (as in Sheets).
    const before = f.value.slice(0, caret);
    return (before.match(/"/g) ?? []).length % 2 === 0;
  }

  /** Put (or update) a pointed-at reference in the formula being typed. */
  private insertPointRef(f: HTMLInputElement | HTMLTextAreaElement, r1: number, c1: number, r2: number, c2: number, fresh: boolean) {
    const d = this.doc!;
    const a = colName(Math.min(c1, c2)) + (d.dataRow(Math.min(r1, r2)) + 1);
    const b = colName(Math.max(c1, c2)) + (d.dataRow(Math.max(r1, r2)) + 1);
    const ref = a === b ? a : `${a}:${b}`;
    const caret = f.selectionStart ?? f.value.length;
    const p = this.pointRef;
    const replacing = p && p.field === f && (!fresh || caret === p.end);
    // Clicking with the caret on a reference swaps that reference.
    const under = !replacing && f.selectionStart === f.selectionEnd ? refAt(f.value, caret) : null;
    const start = replacing ? p!.start : under ? under.s : f.selectionStart ?? caret;
    const end = replacing ? p!.end : under ? under.e : f.selectionEnd ?? caret;
    f.value = f.value.slice(0, start) + ref + f.value.slice(end);
    const pos = start + ref.length;
    f.focus();
    f.setSelectionRange(pos, pos);
    this.pointRef = { field: f, start, end: pos, ar: fresh ? r1 : p!.ar, ac: fresh ? c1 : p!.ac };
    this.pointing = true;
    f.dispatchEvent(new Event("input", { bubbles: true }));
    this.pointing = false;
    this.invalidate();
  }

  /** Coloured boxes round the references in the formula being typed. */
  private drawFormulaRefs() {
    const d = this.doc;
    if (!d || !this.editing) return;
    const text = document.activeElement === this.bar && this.bar ? this.bar.value : this.editor.value;
    if (!text.startsWith("=")) return;
    const { ctx } = this;
    const field = document.activeElement === this.bar && this.bar ? this.bar : this.editor;
    const active = refAt(text, field.selectionStart ?? -1);
    const colors = refColors(text);
    for (const ref of Engine.references(text)) {
      const color = colors.get(refKey(text, ref))!;
      const hot = !!active && refKey(text, active) === refKey(text, ref);
      if (ref.sheet && ref.sheet.toLowerCase() !== d.sheetName.toLowerCase()) continue;
      if (d.view) continue;
      const r1 = ref.r1 < 0 ? 0 : ref.r1, r2 = ref.r2 < 0 ? d.displayRows() - 1 : Math.min(ref.r2, d.displayRows() - 1);
      const c1 = ref.c1 < 0 ? 0 : ref.c1, c2 = ref.c2 < 0 ? d.displayCols() - 1 : Math.min(ref.c2, d.displayCols() - 1);
      const x0 = this.colLeft(c1), y0 = this.rowTop(r1);
      const x1 = this.colLeft(c2) + this.cw(c2), y1 = this.rowTop(r2) + this.rowH(r2);
      if (x1 < 0 || y1 < 0 || x0 > this.w || y0 > this.h) continue;
      ctx.save();
      // The reference the caret is on stands out; the rest stay quiet.
      ctx.globalAlpha = hot ? 0.2 : 0.08;
      ctx.fillStyle = color;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.globalAlpha = active && !hot ? 0.6 : 1;
      ctx.strokeStyle = color;
      const lw = hot ? 2.5 : 1.5;
      ctx.lineWidth = lw;
      ctx.strokeRect(Math.round(x0) + lw / 2, Math.round(y0) + lw / 2, Math.round(x1 - x0) - lw, Math.round(y1 - y0) - lw);
      if (hot) {
        // Little corner squares, like a selection.
        ctx.globalAlpha = 1;
        ctx.fillStyle = color;
        for (const [cx, cy] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) ctx.fillRect(Math.round(cx) - 3, Math.round(cy) - 3, 6, 6);
      }
      ctx.restore();
    }
  }

  /* ---------------------------- trace arrows ---------------------------- */

  private traces: { from: { r1: number; c1: number; r2: number; c2: number }; to: { r: number; c: number } }[] = [];
  private traceFor = -1;

  /** Arrows from cells to the formulas that use them (data coordinates). */
  setTraces(list: { from: { r1: number; c1: number; r2: number; c2: number }; to: { r: number; c: number } }[]) {
    this.traces = list;
    this.traceFor = this.doc?.version ?? -1;
    this.invalidate();
  }

  get hasTraces() { return this.traces.length > 0; }

  private drawTraces() {
    const d = this.doc;
    if (!d || !this.traces.length) return;
    if (d.version !== this.traceFor || d.view) { this.traces = []; return; }
    const { ctx } = this;
    const blue = "#4f86c6";
    const centre = (r: number, c: number) => ({ x: this.colLeft(c) + this.cw(c) / 2, y: this.rowTop(r) + this.rowH(r) / 2 });
    ctx.save();
    ctx.strokeStyle = blue;
    ctx.fillStyle = blue;
    ctx.lineWidth = 1.5;
    for (const t of this.traces) {
      const f = t.from;
      const r1 = Math.max(0, f.r1), r2 = f.r2 < 0 ? d.displayRows() - 1 : f.r2;
      const c1 = Math.max(0, f.c1), c2 = f.c2 < 0 ? d.displayCols() - 1 : f.c2;
      const range = r1 !== r2 || c1 !== c2;
      if (range) {
        const x0 = this.colLeft(c1), y0 = this.rowTop(r1);
        const x1 = this.colLeft(c2) + this.cw(c2), y1 = this.rowTop(r2) + this.rowH(r2);
        ctx.strokeRect(Math.round(x0) + 0.75, Math.round(y0) + 0.75, Math.round(x1 - x0) - 1.5, Math.round(y1 - y0) - 1.5);
      }
      const a = centre(r1, c1), b = centre(t.to.r, t.to.c);
      ctx.beginPath(); ctx.arc(a.x, a.y, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      const ang = Math.atan2(b.y - a.y, b.x - a.x), L = 8;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - L * Math.cos(ang - 0.4), b.y - L * Math.sin(ang - 0.4));
      ctx.lineTo(b.x - L * Math.cos(ang + 0.4), b.y - L * Math.sin(ang + 0.4));
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /** A dashed outline round the spill the active cell is part of. */
  private drawSpillOutline() {
    const d = this.doc;
    if (!d || this.editing) return;
    const sp = d.engine.spillAnchor(d.dataRow(d.sel.ar), d.sel.ac);
    if (!sp || d.view) return;
    const { ctx, colors: k } = this;
    const x0 = this.colLeft(sp.c), y0 = this.rowTop(sp.r);
    const x1 = this.colLeft(sp.c + sp.w - 1) + this.cw(sp.c + sp.w - 1), y1 = this.rowTop(sp.r + sp.h - 1) + this.rowH(sp.r + sp.h - 1);
    ctx.save();
    ctx.strokeStyle = k.accent;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(x1 - x0) - 1, Math.round(y1 - y0) - 1);
    ctx.restore();
  }

  /** Set the pointer for what's under (x, y); returns the freeze handle there, if any. */
  private hoverCursor(x: number, y: number) {
    const rc = this.resizeColAt(x, y);
    const fz = rc < 0 || y >= this.hh ? this.freezeHit(x, y) : null;
    const onFill = this.nearFillHandle(x, y);
    const onEdge = !onFill && !fz && rc < 0 && this.onSelectionEdge(x, y);
    const grabbable = !onFill && !fz && rc < 0 && this.overSelectedHeader(x, y);
    this.scroller.style.cursor = onFill ? "crosshair" : onEdge ? "move" : fz || grabbable ? "grab" : rc >= 0 ? "col-resize" : "default";
    return fz;
  }

  /* ----------------------- dragging columns / rows ----------------------- */

  /** Is (x, y) on the header of a whole column/row that's selected? */
  private overSelectedHeader(x: number, y: number): boolean {
    const d = this.doc;
    if (!d || d.sel.extra?.length) return false;
    const zone = this.zoneAt(x, y);
    const s = selRect(d.sel);
    if (zone === "col") { const c = this.colAt(x); return this.isWholeCols(s) && !this.isWholeRows(s) && c >= s.c0 && c <= s.c1; }
    if (zone === "row") { const r = this.rowAt(y); return this.isWholeRows(s) && !this.isWholeCols(s) && r >= s.r0 && r <= s.r1 && !d.view; }
    return false;
  }

  private startReorder(zone: string, x: number, y: number): boolean {
    const d = this.doc!;
    if (!this.overSelectedHeader(x, y)) return false;
    const s = selRect(d.sel);
    const axis = zone === "col" ? "col" : "row";
    const from = axis === "col" ? s.c0 : s.r0;
    const n = axis === "col" ? s.c1 - s.c0 + 1 : s.r1 - s.r0 + 1;
    const lines: [number, number, number][] = [];
    let before = 0;
    if (axis === "col") {
      const vis0 = this.fcEff > 0 ? 0 : this.colAt(this.rowHeaderWidth());
      for (let c = 0; c < vis0; c++) if (c < from || c >= from + n) before++;
      for (let c = vis0; c < d.displayCols(); c++) {
        const left = this.colLeft(c);
        if (left > this.w) break;
        lines.push([c, left, this.cw(c)]);
      }
    } else {
      const vis0 = this.fb > 0 ? 0 : this.rowAt(this.bodyTop);
      for (let r = 0; r < vis0; r++) if (r < from || r >= from + n) before++;
      for (let r = vis0; r < d.displayRows(); r++) {
        const top = this.rowTop(r);
        if (top > this.h) break;
        lines.push([r, top, this.rowH(r)]);
      }
    }
    const inBlock = lines.filter(([i]) => i >= from && i < from + n);
    if (!inBlock.length) return false;
    const blockStart = inBlock[0][1];
    const blockSize = inBlock.reduce((a, l) => a + l[2], 0);
    this.drag = { kind: "reorder", axis, from, n, cur: from, start: axis === "col" ? x : y, blockStart, blockSize, lines, before, lifted: false, click: { zone, x, y }, ghost: null };
    return true;
  }

  private updateReorder(g: Reorder, x: number, y: number) {
    const d = this.doc!;
    const p = g.axis === "col" ? x : y;
    if (!g.lifted) {
      if (Math.abs(p - g.start) < 4) return;
      g.lifted = true;
      g.ghost = this.makeGhost(g);
      this.scroller.style.cursor = "grabbing";
    }
    const lo = g.axis === "col" ? this.rowHeaderWidth() : this.hh;
    const hi = (g.axis === "col" ? this.w : this.h) - g.blockSize;
    const pos = clamp(g.blockStart + p - g.start, lo, Math.max(lo, hi));
    if (g.ghost) g.ghost.style.transform = g.axis === "col" ? `translate(${pos - g.blockStart}px, -2px)` : `translate(-2px, ${pos - g.blockStart}px)`;
    // Lay the other lines out as if the block weren't there, then count
    // how many the ghost's leading edge has passed.
    const forward = pos > g.blockStart;
    const lead = forward ? pos + g.blockSize : pos;
    let to = g.before;
    for (const [i, start, size] of g.lines) {
      if (i >= g.from && i < g.from + g.n) continue;
      const at = i > g.from ? start - g.blockSize : start;
      if (lead > at + size / 2) to++;
    }
    if (to !== g.cur) {
      if (!d.canMove(g.axis, g.from, g.n, to)) return;
      d.applyMove(g.axis, g.cur, g.n, to);
      g.cur = to;
      this.selectBlock(g.axis, to, g.n);
    }
    this.invalidate();
  }

  private selectBlock(axis: "col" | "row", start: number, n: number) {
    const d = this.doc!;
    if (axis === "col") d.sel = { ar: 0, ac: start, fr: this.fullRow(), fc: start + n - 1 };
    else d.sel = { ar: start, ac: 0, fr: start + n - 1, fc: this.fullCol() };
    this.hooks.onSelection();
  }

  private endReorder(g: Reorder, commit: boolean) {
    const d = this.doc!;
    g.ghost?.remove();
    this.scroller.style.cursor = "default";
    this.drag = null;
    if (!g.lifted) {
      // A plain click on a selected header selects just that line.
      this.pointSelect(g.click.zone as "col" | "row", g.click.x, g.click.y, false);
      return;
    }
    const final = g.cur;
    // Put things back, then record the whole move as one undo step.
    if (final !== g.from) d.applyMove(g.axis, final, g.n, g.from);
    if (commit && final !== g.from) {
      this.selectBlock(g.axis, final, g.n);
      d.moveBlock(g.axis, g.from, g.n, final, { ...d.sel });
    } else this.selectBlock(g.axis, g.from, g.n);
    this.invalidate();
    this.hooks.onChange();
  }

  /** A picture of the dragged columns/rows that follows the pointer. */
  private makeGhost(g: Reorder): HTMLCanvasElement {
    const dpr = this.dpr;
    const c = document.createElement("canvas");
    c.className = "reorder-ghost";
    const w = g.axis === "col" ? g.blockSize : this.w;
    const h = g.axis === "col" ? this.h : g.blockSize;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    c.style.left = `${g.axis === "col" ? g.blockStart : 0}px`;
    c.style.top = `${g.axis === "col" ? 0 : g.blockStart}px`;
    const sx = (g.axis === "col" ? g.blockStart : 0) * dpr, sy = (g.axis === "col" ? 0 : g.blockStart) * dpr;
    c.getContext("2d")!.drawImage(this.canvas, sx, sy, c.width, c.height, 0, 0, c.width, c.height);
    this.wrap.append(c);
    return c;
  }

  /** While dragging, the block's new home shows as an empty slot. */
  private drawReorderGap() {
    const g = this.drag;
    if (g?.kind !== "reorder" || !g.lifted) return;
    const { ctx, colors: k } = this;
    ctx.fillStyle = k.surface2;
    if (g.axis === "col") {
      const x = this.colLeft(g.cur);
      let w = 0;
      for (let c = g.cur; c < g.cur + g.n; c++) w += this.cw(c);
      ctx.fillRect(x, 0, w, this.h);
    } else {
      const y = this.rowTop(g.cur);
      let h = 0;
      for (let r = g.cur; r < g.cur + g.n; r++) h += this.rowH(r);
      ctx.fillRect(0, y, this.w, h);
    }
  }

  /** Data rows hidden by hand just above display row r. */
  hiddenAbove(r: number): number[] {
    const d = this.doc!;
    const to = d.dataRow(r);
    const from = r === 0 ? 0 : d.dataRow(r - 1) + 1;
    const out: number[] = [];
    for (let k = from; k < to; k++) if (d.hiddenRows.has(d.rows[k])) out.push(k);
    return out;
  }

  /** Two tiny arrows pointing away from a boundary where rows/columns are hidden. */
  private hiddenMarker(x: number, y: number, axis: "row" | "col") {
    const { ctx, colors: k } = this;
    ctx.save();
    ctx.fillStyle = k.accent;
    ctx.beginPath();
    if (axis === "row") {
      ctx.moveTo(x - 3.5, y - 2); ctx.lineTo(x + 3.5, y - 2); ctx.lineTo(x, y - 5.5); ctx.closePath();
      ctx.moveTo(x - 3.5, y + 2); ctx.lineTo(x + 3.5, y + 2); ctx.lineTo(x, y + 5.5); ctx.closePath();
    } else {
      ctx.moveTo(x - 2, y - 3.5); ctx.lineTo(x - 2, y + 3.5); ctx.lineTo(x - 5.5, y); ctx.closePath();
      ctx.moveTo(x + 2, y - 3.5); ctx.lineTo(x + 2, y + 3.5); ctx.lineTo(x + 5.5, y); ctx.closePath();
    }
    ctx.fill();
    ctx.restore();
  }

  /** A click on a hidden-rows/columns marker shows them again. */
  private unhideAt(zone: string, x: number, y: number): boolean {
    const d = this.doc!;
    if (zone === "row" && d.hiddenRows.size) {
      const r = this.rowAt(y);
      for (const rr of [r, r + 1]) {
        if (rr >= d.displayRows() + 1) continue;
        const top = rr < d.displayRows() ? this.rowTop(rr) : this.rowTop(rr - 1) + this.rowH(rr - 1);
        if (Math.abs(y - top) > 6 || x < this.rowHeaderWidth() - 18) continue;
        const rows = rr < d.displayRows() ? this.hiddenAbove(rr) : [];
        if (rows.length) { d.setRowsHidden(rows, false); this.invalidate(); this.hooks.onChange(); return true; }
      }
    }
    if (zone === "col" && d.hidden.size) {
      const c = this.colAt(x);
      for (const cc of [c - 1, c, c + 1]) {
        if (!d.hidden.has(cc) || Math.abs(x - this.colLeft(cc)) > 6) continue;
        let a = cc, b = cc;
        while (a > 0 && d.hidden.has(a - 1)) a--;
        while (d.hidden.has(b + 1)) b++;
        for (let i = a; i <= b; i++) d.hidden.delete(i);
        d.version++;
        this.invalidate();
        this.hooks.onChange();
        return true;
      }
    }
    return false;
  }

  /** Underline / strikethrough for one line of text. */
  private decorate(s: Style, line: string, tx: number, ty: number, px: number, align: CanvasTextAlign) {
    if (!s.u && !s.s) return;
    const ctx = this.ctx;
    const tw = ctx.measureText(line).width;
    const lx = align === "right" ? tx - tw : align === "center" ? tx - tw / 2 : tx;
    const th = Math.max(1, Math.round(px / 13));
    if (s.u) ctx.fillRect(lx, Math.round(ty + px * 0.45), tw, th);
    if (s.s) ctx.fillRect(lx, Math.round(ty), tw, th);
  }

  private drawColHeaders(c0: number, c1: number, _sel: Rect, x0: number, x1: number) {
    const { ctx, colors: k } = this;
    const d = this.doc!;
    const hh = this.hh;
    const rects = allRects(d.sel);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, 0, x1 - x0, hh);
    ctx.clip();
    ctx.fillStyle = k.bg;
    ctx.fillRect(x0, 0, x1 - x0, hh);
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    for (let c = c0; c <= c1; c++) {
      const cw = this.cw(c);
      const x = this.colLeft(c);
      if (!cw) {
        // Only one marker per run of hidden columns.
        if (c === 0 || this.cw(c - 1)) this.hiddenMarker(x, hh - 8, "col");
        continue;
      }
      const hits = rects.filter((r) => c >= r.c0 && c <= r.c1 && (!this.isWholeRows(r) || this.isWholeCols(r)));
      const inSel = hits.length > 0;
      const whole = hits.some((r) => this.isWholeCols(r));
      if (inSel) {
        ctx.fillStyle = whole ? k.accent : k.selHead;
        ctx.fillRect(x, 0, cw, hh);
      } else if (c === this.hoverCol) {
        ctx.fillStyle = k.surface;
        ctx.fillRect(x, 0, cw, hh);
      }
      ctx.font = whole ? this.fontHeadBold : this.fontHead;
      ctx.fillStyle = whole ? "#fff" : inSel ? k.accentText : k.muted;
      ctx.fillText(colName(c), x + cw / 2, hh / 2 + 0.5);
      if (d.filters.has(c)) {
        ctx.fillStyle = k.accent;
        this.funnel(x + cw - 20, hh / 2 - 5);
      } else if (c === this.hoverCol && cw > 44) {
        const cx = x + cw - 14;
        if (this.hoverChevron) {
          ctx.fillStyle = whole ? "rgba(255,255,255,0.22)" : k.surface2;
          ctx.beginPath();
          ctx.arc(cx, hh / 2, 9, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.strokeStyle = whole ? "#fff" : k.text2;
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(cx - 3.5, hh / 2 - 1.5);
        ctx.lineTo(cx, hh / 2 + 2);
        ctx.lineTo(cx + 3.5, hh / 2 - 1.5);
        ctx.stroke();
      }
      // Full-height separator, continuous with the grid line below.
      ctx.fillStyle = k.line;
      ctx.globalAlpha = this.gridAlpha;
      ctx.fillRect(x + cw - this.lw, 0, this.lw, hh);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  private drawRowHeaders(r0: number, r1: number, _sel: Rect, rhw: number) {
    const { ctx, colors: k, h } = this;
    const d = this.doc!;
    const rects = allRects(d.sel);
    const draw = (r: number) => {
      const y = this.rowTop(r);
      const rh = this.rowH(r);
      // A whole-column selection doesn't light up every row number (and vice versa).
      const hits = rects.filter((x) => r >= x.r0 && r <= x.r1 && (!this.isWholeCols(x) || this.isWholeRows(x)));
      const inSel = hits.length > 0;
      const whole = hits.some((x) => this.isWholeRows(x));
      if (inSel) {
        ctx.fillStyle = whole ? k.accent : k.selHead;
        ctx.fillRect(0, y, rhw - this.lw, rh);
      }
      ctx.font = whole ? this.fontHeadBold : this.fontHead;
      ctx.fillStyle = whole ? "#fff" : inSel ? k.accentText : k.muted;
      ctx.fillText(String(d.dataRow(r) + 1), rhw / 2, y + rh / 2 + 0.5);
      // Rows hidden just above this one: a small up/down marker on the boundary.
      if (d.hiddenRows.size && this.hiddenAbove(r).length) this.hiddenMarker(rhw - 9, y, "row");
      ctx.fillStyle = k.line;
      ctx.globalAlpha = this.gridAlpha;
      ctx.fillRect(0, y + rh - this.lw, rhw - this.lw, this.lw);
      ctx.globalAlpha = 1;
    };
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, this.bodyTop, rhw, h - this.bodyTop);
    ctx.clip();
    ctx.fillStyle = k.bg;
    ctx.fillRect(0, this.bodyTop, rhw, h - this.bodyTop);
    for (let r = r0; r <= r1; r++) draw(r);
    ctx.restore();
    if (this.fb) {
      ctx.fillStyle = k.bg;
      ctx.fillRect(0, this.hh, rhw, this.bodyTop - this.hh);
      for (let r = 0; r < this.fb; r++) draw(r);
    }
  }

  private funnel(x: number, y: number) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 10, y);
    ctx.lineTo(x + 6, y + 5);
    ctx.lineTo(x + 6, y + 10);
    ctx.lineTo(x + 4, y + 9);
    ctx.lineTo(x + 4, y + 5);
    ctx.closePath();
    ctx.fill();
  }

  /** Width that fits a column's content (header + a sample of rows). */
  autoFit(c: number) {
    const d = this.doc;
    if (!d) return;
    const ctx = this.ctx;
    let max = 30;
    const n = d.rows.length;
    const sample = (r: number) => {
      const raw = d.raw(r, c);
      if (!raw) return;
      const s = d.style(r, c);
      if (s.wrap === "wrap") return; // wrapped cells don't drive the width
      ctx.font = this.cellFont(s, r === 0 && d.freezeHeader, 1);
      for (const line of this.cellText(r, c, raw, s).text.split("\n")) {
        const m = ctx.measureText(line).width;
        if (m > max) max = m;
      }
    };
    for (let r = 0; r < Math.min(n, 3000); r++) sample(r);
    const first = this.rowAtBody(this.sy);
    for (let r = first; r < first + 80; r++) { const dr = d.dataRow(r); if (dr < n) sample(dr); }
    d.widths.set(c, clamp(Math.ceil(max + BASE_PAD * 2 + 4), 44, 640));
    d.remeasureAll();
    this.invalidate();
    this.hooks.onChange();
  }

  /** Give columns sensible starting widths from a sample of rows (top, spread, bottom). */
  autoFitInitial(d: Doc) {
    const ctx = this.ctx;
    const n = d.rows.length;
    const sample = new Set<number>();
    for (let r = 0; r < Math.min(n, 200); r++) sample.add(r);
    const step = Math.max(1, Math.floor(n / 200));
    for (let r = 0; r < n; r += step) sample.add(r);
    for (let r = Math.max(0, n - 100); r < n; r++) sample.add(r);
    const widths = new Array<number>(Math.min(d.cols, 300)).fill(0);
    for (const r of sample) {
      const row = d.rows[r];
      ctx.font = r === 0 && d.freezeHeader ? BASE_FONT_BOLD : BASE_FONT;
      for (let c = 0; c < Math.min(row.length, widths.length); c++) {
        const t = row[c];
        if (!t) continue;
        const nl = t.indexOf("\n");
        const m = ctx.measureText(nl >= 0 ? t.slice(0, nl) : t).width;
        if (m > widths[c]) widths[c] = m;
      }
    }
    widths.forEach((m, c) => d.widths.set(c, clamp(Math.ceil(m + BASE_PAD * 2 + 6), 64, 320)));
  }

  /* --------------------------- fill handle --------------------------- */

  /** Where the fill handle sits (bottom-right of the selection), or null if hidden. */
  private fillHandlePos(): { x: number; y: number } | null {
    const d = this.doc;
    if (!d || this.editing || d.loading !== null || this.drag?.kind === "fill" || d.sel.extra?.length) return null;
    const s = selRect(d.sel);
    const b = this.cellBox(s.r1, s.c1);
    const x = b.x + b.w - this.lw, y = b.y + b.h - this.lw;
    const minX = s.c1 >= this.fc ? this.bodyLeft : this.rowHeaderWidth();
    const minY = s.r1 >= this.fb ? this.bodyTop : this.hh;
    if (x < minX || y < minY || x > this.w || y > this.h) return null;
    return { x, y };
  }

  private nearFillHandle(x: number, y: number): boolean {
    const p = this.fillHandlePos();
    return !!p && Math.hypot(x - p.x, y - p.y) <= 7;
  }

  private drawFillHandle(_sel: Rect) {
    const p = this.fillHandlePos();
    if (!p) return;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = this.colors.accent;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = this.colors.bg;
    ctx.stroke();
  }

  private drawFillPreview() {
    if (this.moveTarget) { this.drawMovePreview(this.moveTarget); return; }
    const t = this.fillTarget;
    if (!t) return;
    const ctx = this.ctx;
    const x0 = this.colLeft(t.c0), x1 = this.colLeft(t.c1) + this.cw(t.c1);
    const y0 = this.rowTop(t.r0), y1 = this.rowTop(t.r1) + this.rowH(t.r1);
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.rowHeaderWidth(), this.hh, this.w, this.h);
    ctx.clip();
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = this.colors.muted;
    ctx.strokeRect(x0 - 0.5, y0 - 0.5, x1 - x0, y1 - y0);
    ctx.restore();
  }

  /** Outline where dragged cells will land. */
  private drawMovePreview(t: Rect) {
    const ctx = this.ctx;
    const L = this.lw;
    const x0 = this.colLeft(t.c0) - L, x1 = this.colLeft(t.c1) + this.cw(t.c1);
    const y0 = this.rowTop(t.r0) - L, y1 = this.rowTop(t.r1) + this.rowH(t.r1);
    const T = this.S(2);
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.rowHeaderWidth(), this.hh, this.w, this.h);
    ctx.clip();
    ctx.fillStyle = this.colors.muted;
    ctx.fillRect(x0, y0, x1 - x0, T);
    ctx.fillRect(x0, y1 - T, x1 - x0, T);
    ctx.fillRect(x0, y0, T, y1 - y0);
    ctx.fillRect(x1 - T, y0, T, y1 - y0);
    ctx.restore();
  }

  /** Is the pointer on the edge of the selection (where you grab it to move)? */
  private onSelectionEdge(x: number, y: number): boolean {
    const d = this.doc;
    if (!d || this.editing || d.loading !== null || d.sel.extra?.length) return false;
    const s = selRect(d.sel);
    if ((s.r1 - s.r0 + 1) * (s.c1 - s.c0 + 1) > 200_000) return false;
    if (y < this.hh || x < this.rowHeaderWidth()) return false;
    const x0 = this.colLeft(s.c0), x1 = this.colLeft(s.c1) + this.cw(s.c1);
    const y0 = this.rowTop(s.r0), y1 = this.rowTop(s.r1) + this.rowH(s.r1);
    const inX = x >= x0 - 3 && x <= x1 + 3, inY = y >= y0 - 3 && y <= y1 + 3;
    const nearV = inY && (Math.abs(x - x0) <= 3 || Math.abs(x - x1) <= 3);
    const nearH = inX && (Math.abs(y - y0) <= 3 || Math.abs(y - y1) <= 3);
    return (nearV || nearH) && !this.nearFillHandle(x, y);
  }

  private updateMoveTarget(drag: { src: Rect; grabR: number; grabC: number }, x: number, y: number) {
    const r = this.rowAt(clamp(y, this.hh, this.h - 1));
    const c = this.colAt(clamp(x, this.rowHeaderWidth(), this.w - 1));
    const s = drag.src;
    const dr = Math.max(-s.r0, r - drag.grabR);
    const dc = Math.max(-s.c0, c - drag.grabC);
    this.moveTarget = dr || dc ? { r0: s.r0 + dr, r1: s.r1 + dr, c0: s.c0 + dc, c1: s.c1 + dc } : null;
  }

  /**
   * Move (or with Ctrl, copy) a block of cells — values and formatting — as
   * one undo step. Asks before overwriting existing data, like Excel.
   */
  async moveCells(src: Rect, dst: Rect, copy: boolean) {
    const d = this.doc;
    if (!d) return;
    const touches = (m: Rect, r: Rect) => m.r0 <= r.r1 && r.r0 <= m.r1 && m.c0 <= r.c1 && r.c0 <= m.c1;
    if (this.visibleMerges().some((m) => touches(m, src) || touches(m, dst))) {
      this.hooks.onNotice?.("Unmerge the cells first to move them");
      return;
    }
    const h = src.r1 - src.r0 + 1, w = src.c1 - src.c0 + 1;
    const inSrc = (r: number, c: number) => !copy && r >= src.r0 && r <= src.r1 && c >= src.c0 && c <= src.c1;
    const lastDisp = d.view ? d.view.length - 1 : Infinity;
    let conflict = false;
    for (let i = 0; i < h && !conflict; i++) {
      const tr = dst.r0 + i;
      if (tr > lastDisp) break;
      for (let j = 0; j < w; j++) {
        if (!inSrc(tr, dst.c0 + j) && d.raw(d.dataRow(tr), dst.c0 + j) !== "") { conflict = true; break; }
      }
    }
    if (conflict && this.hooks.onConfirm && !(await this.hooks.onConfirm("Replace existing data?", "There's already data where you're dropping these cells. Replace it?", "Replace"))) return;
    const cells: CellSet[] = [];
    const src2: { r: number; c: number; v: string; style: number }[] = [];
    for (let i = 0; i < h; i++) {
      const sr = d.dataRow(src.r0 + i);
      for (let j = 0; j < w; j++) src2.push({ r: sr, c: src.c0 + j, v: d.raw(sr, src.c0 + j), style: d.styleId(sr, src.c0 + j) });
    }
    if (!copy) for (const s of src2) cells.push({ r: s.r, c: s.c, v: "", style: 0 });
    for (let i = 0; i < h; i++) {
      const disp = dst.r0 + i;
      if (disp > lastDisp) break;
      const tr = d.dataRow(disp);
      for (let j = 0; j < w; j++) {
        const s = src2[i * w + j];
        const tc = dst.c0 + j;
        // Copies shift relative references, like paste; moves keep formulas exactly as they were.
        const v = copy ? offsetFormula(s.v, tr - s.r, tc - s.c) : s.v;
        cells.push({ r: tr, c: tc, v, style: s.style });
      }
    }
    d.setCells(cells, copy ? "Copy cells" : "Move cells");
    const sel = d.sel;
    this.select({
      ar: sel.ar + (dst.r0 - src.r0), ac: sel.ac + (dst.c0 - src.c0),
      fr: sel.fr + (dst.r0 - src.r0), fc: sel.fc + (dst.c0 - src.c0),
    });
    this.hooks.onChange();
  }

  /** Work out the fill range from the pointer, like Sheets: pick the axis you've dragged further along. */
  private updateFillTarget(src: Rect, x: number, y: number) {
    const sx0 = this.colLeft(src.c0), sx1 = this.colLeft(src.c1) + this.cw(src.c1);
    const sy0 = this.rowTop(src.r0), sy1 = this.rowTop(src.r1) + this.rowH(src.r1);
    const dy = y > sy1 ? y - sy1 : y < sy0 ? sy0 - y : 0;
    const dx = x > sx1 ? x - sx1 : x < sx0 ? sx0 - x : 0;
    if (!dx && !dy) { this.fillTarget = null; return; }
    const r = this.rowAt(clamp(y, this.hh, this.h - 1));
    const c = this.colAt(clamp(x, this.rowHeaderWidth(), this.w - 1));
    const lastRow = this.doc!.view ? this.doc!.view.length - 1 : this.doc!.displayRows() - 1;
    if (dy >= dx) {
      if (r > src.r1) this.fillTarget = { ...src, r1: Math.min(r, lastRow) };
      else if (r < src.r0) this.fillTarget = { ...src, r0: r };
      else this.fillTarget = null;
    } else {
      if (c > src.c1) this.fillTarget = { ...src, c1: c };
      else if (c < src.c0) this.fillTarget = { ...src, c0: c };
      else this.fillTarget = null;
    }
  }

  /** Fill from `src` out to `tgt` (which contains it). */
  fill(src: Rect, tgt: Rect, alt: boolean) {
    const d = this.doc;
    if (!d) return;
    const vertical = tgt.r0 !== src.r0 || tgt.r1 !== src.r1;
    const backward = vertical ? tgt.r0 < src.r0 : tgt.c0 < src.c0;
    const count = vertical ? (tgt.r1 - tgt.r0) - (src.r1 - src.r0) : (tgt.c1 - tgt.c0) - (src.c1 - src.c0);
    if (count <= 0) return;
    const cells: CellSet[] = [];
    // One "line" per column (vertical fill) or row (horizontal fill).
    const lines = vertical ? src.c1 - src.c0 + 1 : src.r1 - src.r0 + 1;
    const n = vertical ? src.r1 - src.r0 + 1 : src.c1 - src.c0 + 1;
    for (let li = 0; li < lines; li++) {
      const srcCells: { r: number; c: number }[] = [];
      for (let i = 0; i < n; i++) {
        srcCells.push(vertical ? { r: d.dataRow(src.r0 + i), c: src.c0 + li } : { r: d.dataRow(src.r0 + li), c: src.c0 + i });
      }
      const raws = srcCells.map((p) => d.raw(p.r, p.c));
      const hasFormula = raws.some((v) => v.charCodeAt(0) === 61);
      const values = hasFormula ? null : fillValues(raws, count, backward, alt);
      for (let k = 0; k < count; k++) {
        const pos = backward ? -(k + 1) : n + k; // index along the line
        const si = ((pos % n) + n) % n;
        const from = srcCells[si];
        let tr: number, tc: number;
        if (vertical) {
          const disp = backward ? src.r0 - 1 - k : src.r1 + 1 + k;
          if (disp < 0 || (d.view && disp >= d.view.length)) continue;
          tr = d.dataRow(disp); tc = src.c0 + li;
        } else {
          const col = backward ? src.c0 - 1 - k : src.c1 + 1 + k;
          if (col < 0) continue;
          tr = d.dataRow(src.r0 + li); tc = col;
        }
        const v = values ? values[k] : offsetFormula(raws[si], tr - from.r, tc - from.c);
        cells.push({ r: tr, c: tc, v, style: d.styleId(from.r, from.c) });
      }
    }
    const all = { ...tgt };
    d.setCells(cells, "Fill");
    this.select(backward ? { ar: all.r0, ac: all.c0, fr: all.r1, fc: all.c1 } : { ar: src.r0, ac: src.c0, fr: all.r1, fc: all.c1 }, false);
    this.hooks.onChange();
  }

  /** Double-clicking the handle fills down as far as the neighbouring column has data. */
  private fillDownToNeighbour() {
    const d = this.doc;
    if (!d) return;
    const s = selRect(d.sel);
    const last = d.view ? d.view.length - 1 : d.rows.length - 1;
    const filled = (r: number, c: number) => c >= 0 && r <= last && d.raw(d.dataRow(r), c) !== "";
    let end = s.r1;
    for (const c of [s.c0 - 1, s.c1 + 1]) {
      let r = s.r1;
      while (filled(r + 1, c)) r++;
      if (r > end) { end = r; break; }
    }
    if (end > s.r1) this.fill(s, { ...s, r1: end }, false);
  }

  /* ------------------------------ freezing ------------------------------ */

  /** Is the pointer on one of the freeze handles (corner bars or freeze lines)? */
  private freezeHit(x: number, y: number): "freezeRows" | "freezeCols" | null {
    const rhw = this.rowHeaderWidth();
    // With nothing frozen, the handle is the whole bottom edge of the letter row…
    const onRows = this.fb === 0
      ? y >= this.hh - 5 && y <= this.hh + 1 && x >= 0
      : y >= this.bodyTop - this.freezeBar - 2 && y <= this.bodyTop + 2 && y > this.hh;
    // …and the whole right edge of the row-number column.
    const onCols = this.fc === 0
      ? x >= rhw - 5 && x <= rhw + 1 && y >= 0
      : x >= this.bodyLeft - this.freezeBar - 2 && x <= this.bodyLeft + 2 && y >= this.hh;
    if (onRows && onCols) return Math.abs(y - this.hh) < Math.abs(x - rhw) ? "freezeRows" : "freezeCols";
    return onRows ? "freezeRows" : onCols ? "freezeCols" : null;
  }

  /** Snap a pointer position to the nearest row/column boundary that keeps the grid usable. */
  private freezeCountAt(kind: "freezeRows" | "freezeCols", x: number, y: number): number {
    const d = this.doc!;
    if (kind === "freezeRows") {
      const maxY = this.scroller.clientHeight - this.rh * 2;
      let best = 0, bestD = Infinity;
      for (let k = 0; k < d.displayRows(); k++) {
        const pos = this.hh + this.yOf(k);
        if (pos > maxY) break;
        const dist = Math.abs(pos - y);
        if (dist < bestD) { best = k; bestD = dist; }
      }
      return best;
    }
    const rhw = this.rowHeaderWidth();
    const maxX = this.scroller.clientWidth - 80 * this.zoom;
    let best = 0, bestD = Infinity;
    for (let k = 0; k < this.ncols; k++) {
      const pos = rhw + this.xs[k];
      if (pos > maxX) break;
      const dist = Math.abs(pos - x);
      if (dist < bestD) { best = k; bestD = dist; }
    }
    return best;
  }

  private drawFreezePreview() {
    const drag = this.drag;
    if (!drag || (drag.kind !== "freezeRows" && drag.kind !== "freezeCols") || this.freezePreview === null) return;
    const ctx = this.ctx;
    const k = this.colors;
    const bar = this.freezeBar;
    const { x, y } = this.pointer;
    ctx.save();
    if (drag.kind === "freezeRows") {
      // Where it will snap to, and the bar itself following the pointer.
      const pos = this.hh + this.yOf(this.freezePreview);
      ctx.fillStyle = k.accent;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(0, pos - bar, this.w, bar);
      ctx.globalAlpha = 1;
      ctx.fillStyle = k.lineStrong;
      ctx.fillRect(0, clamp(y, this.hh, this.h) - bar / 2, this.w, bar);
    } else {
      const pos = this.rowHeaderWidth() + this.xs[this.freezePreview];
      ctx.fillStyle = k.accent;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(pos - bar, 0, bar, this.h);
      ctx.globalAlpha = 1;
      ctx.fillStyle = k.lineStrong;
      ctx.fillRect(clamp(x, this.rowHeaderWidth(), this.w) - bar / 2, 0, bar, this.h);
    }
    ctx.restore();
  }

  /* ------------------------------ editing ------------------------------ */

  startEdit(mode: "replace" | "edit", initial?: string, focusEditor = true) {
    const d = this.doc;
    if (!d || d.loading !== null) return;
    const { ar, ac } = d.sel;
    if (this.cw(ac) === 0) return;
    this.scrollIntoView(ar, ac);
    this.editing = { r: ar, c: ac, mode };
    const raw = d.raw(d.dataRow(ar), ac);
    this.editor.value = initial ?? raw;
    this.editor.style.display = "block";
    this.formulaLook = null;
    this.styleEditor();
    this.placeEditor();
    if (focusEditor) {
      this.editor.focus({ preventScroll: true });
      const end = this.editor.value.length;
      this.editor.setSelectionRange(end, end);
    }
    this.hooks.onEditText(this.editor.value);
    this.invalidate();
  }

  /** null until styled; then whether the editor is in formula mode. */
  private formulaLook: boolean | null = null;

  /**
   * The editor takes on the cell's look, so typing feels in place — except
   * for formulas (text starting with "="), which get a code look: left
   * aligned, monospaced, with coloured references, like Sheets.
   */
  private styleEditor() {
    const d = this.doc, e = this.editing;
    if (!d || !e) return;
    const formula = this.editor.value.startsWith("=");
    if (formula === this.formulaLook) return;
    this.formulaLook = formula;
    const es = this.editor.style;
    const z = this.zoom;
    this.editor.classList.toggle("formula", formula);
    if (formula) {
      const px = 13 * z;
      es.font = `${px}px "Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace`;
      es.lineHeight = Math.round(px * 1.45) + "px";
      es.padding = `${Math.max(2, Math.round((this.rh - px * 1.45) / 2) - 2)}px ${this.pad - 1}px`;
      es.color = "";
      es.textDecoration = "none";
      es.textAlign = "left";
      es.whiteSpace = "pre";
      this.editorWraps = false;
    } else {
      const s = d.style(d.dataRow(e.r), e.c);
      const px = ptToPx(s.size ?? DEFAULT_SIZE) * z;
      es.font = this.cellFont(s, e.r === 0 && d.freezeHeader);
      es.lineHeight = Math.round(px * 1.35) + "px";
      es.padding = `${Math.max(2, Math.round((this.rh - px * 1.35) / 2) - 2)}px ${this.pad - 1}px`;
      es.color = resolveColor(s.color, this.theme) ?? "";
      es.textDecoration = [s.u ? "underline" : "", s.s ? "line-through" : ""].join(" ").trim() || "none";
      es.textAlign = s.ha === "c" ? "center" : s.ha === "r" ? "right" : "left";
      es.whiteSpace = s.wrap === "wrap" ? "pre-wrap" : "pre";
      this.editorWraps = s.wrap === "wrap";
    }
  }

  /** Coloured copy of the formula drawn under the (see-through) editor text, and a live result. */
  private hl: HTMLElement | null = null;
  private preview: HTMLElement | null = null;

  private paintFormula() {
    const on = !!this.editing && this.editor.value.startsWith("=") && this.editor.style.visibility !== "hidden";
    if (!this.hl) {
      this.hl = document.createElement("div");
      this.hl.id = "editor-hl";
      this.preview = document.createElement("div");
      this.preview.id = "editor-preview";
      this.wrap.append(this.hl, this.preview);
    }
    const hl = this.hl, pv = this.preview!;
    hl.hidden = !on;
    if (!on) { pv.hidden = true; return; }
    const es = this.editor.style;
    Object.assign(hl.style, { left: es.left, top: es.top, width: es.width, height: es.height, font: es.font, lineHeight: es.lineHeight, padding: es.padding });
    hl.innerHTML = highlightFormula(this.editor.value, this.editor.selectionStart ?? -1) + "\n";
    hl.scrollTop = this.editor.scrollTop;
    hl.scrollLeft = this.editor.scrollLeft;
    // The answer so far, in a little chip above the editor.
    const d = this.doc!, e = this.editing!;
    let text = "";
    try {
      const v = d.engine.preview(this.editor.value, d.dataRow(e.r), e.c);
      text = v;
    } catch { text = ""; }
    pv.hidden = text === "";
    pv.textContent = text;
    pv.style.left = es.left;
    pv.style.top = `${parseFloat(es.top) - 24}px`;
  }

  /** Commit the edit, then optionally move the selection. */
  commitEdit(dr = 0, dc = 0) {
    const e = this.editing;
    const d = this.doc;
    if (!e || !d) return;
    let v = this.editor.value;
    // Accepting a suggestion takes the existing entry's exact spelling and case.
    const ac = this.ac;
    if (ac && v.toLowerCase() === ac.entry.toLowerCase()) v = ac.entry;
    this.stopEdit();
    const r = d.dataRow(e.r);
    if (d.raw(r, e.c) !== v) {
      d.setCells([{ r, c: e.c, v }], "Edit");
      this.hooks.onChange();
    }
    if (dr || dc) this.select({ ar: e.r + dr, ac: e.c + dc, fr: e.r + dr, fc: e.c + dc });
    else this.hooks.onSelection();
  }

  cancelEdit() {
    this.stopEdit();
    this.hooks.onSelection();
  }

  /* ---------------------------- autocomplete ---------------------------- */

  /** The suggestion currently showing (as selected text after the caret). */
  private ac: { entry: string; typed: number } | null = null;
  private acIndex: { key: string; map: Map<string, string> } | null = null;

  /** Distinct text values in the column being edited (lower-case → as written). */
  private columnEntries(): Map<string, string> {
    const d = this.doc!, e = this.editing!;
    const key = `${d.id}:${d.version}:${e.c}:${d.dataRow(e.r)}`;
    if (this.acIndex?.key === key) return this.acIndex.map;
    const map = new Map<string, string>();
    const me = d.dataRow(e.r);
    const n = d.rows.length;
    // Look outwards from the cell so huge sheets stay quick.
    for (let k = 1; k <= Math.min(n, 20_000) && map.size < 5_000; k++) {
      for (const r of [me - k, me + k]) {
        if (r < 0 || r >= n) continue;
        const v = d.rows[r][e.c];
        if (!v || v.length < 2 || v.charCodeAt(0) === 61 || v.includes("\n") || !Number.isNaN(parseNum(v))) continue;
        const low = v.toLowerCase();
        if (!map.has(low)) map.set(low, v);
      }
    }
    this.acIndex = { key, map };
    return map;
  }

  /**
   * Excel-style autocomplete, kept polite: text only (never numbers or
   * formulas), at least two characters typed, and only when exactly one
   * existing entry in the column starts that way. The rest of the entry
   * appears selected, so typing simply carries on over it; Backspace or Esc
   * removes it, Enter or Tab accepts it.
   */
  private autocomplete(e: InputEvent) {
    this.ac = null;
    if (localStorage.getItem("bento.autocomplete") === "off" || e.isComposing || !this.editing) return;
    if (!e.inputType?.startsWith("insert") || e.inputType === "insertLineBreak") return;
    const ed = this.editor;
    const text = ed.value;
    if (ed.selectionStart !== text.length || text.length < 2 || text.startsWith("=") || text.includes("\n")) return;
    if (!Number.isNaN(parseNum(text))) return;
    const low = text.toLowerCase();
    let match: string | null = null;
    for (const [k, v] of this.columnEntries()) {
      if (!k.startsWith(low)) continue;
      if (match !== null || k.length === low.length) return; // ambiguous, or already complete
      match = v;
    }
    if (!match) return;
    ed.value = text + match.slice(text.length);
    ed.setSelectionRange(text.length, match.length);
    this.ac = { entry: match, typed: text.length };
  }

  /** Esc with a suggestion showing removes just the suggestion. */
  private dismissSuggestion(): boolean {
    const ac = this.ac;
    if (!ac || this.editor.selectionEnd !== this.editor.value.length || this.editor.selectionStart === this.editor.selectionEnd) return false;
    this.editor.value = this.editor.value.slice(0, this.editor.selectionStart);
    this.ac = null;
    this.hooks.onEditText(this.editor.value);
    return true;
  }

  private stopEdit() {
    this.ac = null;
    this.editing = null;
    this.editor.style.display = "none";
    this.editor.classList.remove("formula");
    this.paintFormula();
    this.hooks.onEditText(null);
    this.focus();
    this.invalidate();
  }

  private placeEditor() {
    const e = this.editing;
    const d = this.doc;
    if (!e || !d) return;
    const { x, y, w: cw, h: ch } = this.cellBox(e.r, e.c);
    const offscreen = (e.r >= this.fb && y + ch < this.bodyTop + 4) || y > this.h || (e.c >= this.fc && x + cw < this.bodyLeft + 4) || x > this.w;
    this.editor.style.visibility = offscreen ? "hidden" : "visible";
    this.ctx.font = this.editor.style.font || this.font;
    const lh = parseFloat(this.editor.style.lineHeight) || 18;
    let width: number, nlines: number;
    if (this.editorWraps) {
      width = cw + 3;
      nlines = this.wrapLines(this.editor.value, cw - this.pad * 2).length;
    } else {
      const lines = this.editor.value.split("\n");
      let tw = 0;
      for (const l of lines) tw = Math.max(tw, this.ctx.measureText(l).width);
      width = clamp(Math.ceil(tw + this.pad * 2 + 14), cw + 3, Math.max(cw + 3, this.w - x - 16));
      nlines = lines.length;
    }
    const height = Math.max(ch + 3, nlines * lh + 10);
    Object.assign(this.editor.style, {
      left: x - 2 + "px", top: y - 2 + "px", width: width + "px", height: height + "px",
    });
    this.paintFormula();
  }

  /** The cell bar edits the same value; keep the in-cell editor in sync. */
  setEditorText(v: string) {
    if (!this.editing) return;
    this.editor.value = v;
    this.styleEditor();
    this.placeEditor();
  }

  /* ---------------------------- clipboard ---------------------------- */

  copy(cut = false): string | null {
    const d = this.doc;
    if (!d) return null;
    if (d.sel.extra?.length) { this.hooks.onNotice?.("Copying more than one range at a time isn't supported"); return null; }
    const s = selRect(d.sel);
    const cells = (s.r1 - s.r0 + 1) * (s.c1 - s.c0 + 1);
    if (cells > 5_000_000) return null;
    const raw: string[][] = [];
    const values: string[][] = [];
    const shown: string[][] = [];
    const styles: Style[][] = [];
    const rows: number[] = [];
    for (let r = s.r0; r <= s.r1; r++) {
      const dr = d.dataRow(r);
      rows.push(dr);
      const a: string[] = [], b: string[] = [], st: Style[] = [], vals: string[] = [];
      for (let c = s.c0; c <= s.c1; c++) {
        const v = d.raw(dr, c);
        const sty = d.style(dr, c);
        a.push(v);
        if (v.charCodeAt(0) === 61) { const val = d.engine.value(dr, c); vals.push(val === null || val === undefined ? "" : typeof val === "boolean" ? (val ? "TRUE" : "FALSE") : String(val)); }
        else vals.push(v);
        st.push(sty);
        b.push(v ? this.cellText(dr, c, v, sty).text : "");
      }
      raw.push(a);
      values.push(vals);
      shown.push(b);
      styles.push(st);
    }
    const tsv = toTSV(shown);
    lastCopy = { tsv, raw, values, styles, rows, c: s.c0 };
    // Whole columns/rows bring their size along when pasted onto whole columns/rows.
    if (this.isWholeCols(s) && !this.isWholeRows(s)) lastCopy.widths = Array.from({ length: s.c1 - s.c0 + 1 }, (_, j) => d.width(s.c0 + j));
    if (this.isWholeRows(s) && !this.isWholeCols(s)) lastCopy.heights = rows.map((r) => d.manualHeight(r));
    if (cut) this.clear("Cut");
    return tsv;
  }

  paste(text: string, mode: PasteMode = "normal") {
    const d = this.doc;
    if (!d) return;
    let internal = lastCopy && lastCopy.tsv === text ? lastCopy : null;
    if (mode === "format" && !internal) { this.hooks.onNotice?.("Formatting can only be pasted from cells copied in Bento"); return; }
    let block = internal ? (mode === "values" ? internal.values : internal.raw) : fromTSV(text);
    let styles = internal?.styles;
    if (mode === "transpose") {
      const t = <T,>(m: T[][], blank: T) => { const w = Math.max(...m.map((r) => r.length)); return Array.from({ length: w }, (_, j) => m.map((r) => r[j] ?? blank)); };
      block = t(block, "");
      if (styles) styles = t(styles, {} as Style);
      // Formulas would point the wrong way once flipped: keep them only from outside.
      if (internal) { internal = { ...internal, raw: block, styles: styles!, rows: [], c: 0 }; }
    }
    if (!block.length) return;
    const keepFormat = mode === "normal" || mode === "transpose";
    const keepValues = mode !== "format";
    const s = selRect(d.sel);
    const bh = block.length;
    const bw = Math.max(...block.map((r) => r.length));
    // A single copied value pasted onto a bigger selection fills it.
    const fill = bh === 1 && bw === 1 && (s.r1 > s.r0 || s.c1 > s.c0);
    const h = fill ? s.r1 - s.r0 + 1 : bh;
    const w = fill ? s.c1 - s.c0 + 1 : bw;
    const cells: CellSet[] = [];
    for (let i = 0; i < h; i++) {
      const disp = s.r0 + i;
      if (d.view && disp >= d.view.length) break;
      const dr = d.dataRow(disp);
      for (let j = 0; j < w; j++) {
        let v = fill ? block[0][0] : block[i][j] ?? "";
        if (internal && mode !== "values" && mode !== "transpose") {
          const srcR = internal.rows[fill ? 0 : i];
          const srcC = internal.c + (fill ? 0 : j);
          v = offsetFormula(v, dr - srcR, s.c0 + j - srcC);
        }
        if (internal && (keepFormat || mode === "format")) {
          // Formatting comes along when copying inside Bento.
          const sty = fill ? styles![0][0] : styles![i]?.[j];
          cells.push(keepValues ? { r: dr, c: s.c0 + j, v, style: d.intern(sty ?? {}) } : { r: dr, c: s.c0 + j, style: d.intern(sty ?? {}) });
          continue;
        }
        cells.push({ r: dr, c: s.c0 + j, v });
      }
    }
    const after: Sel = { ar: s.r0, ac: s.c0, fr: s.r0 + h - 1, fc: s.c0 + w - 1 };
    d.setCells(cells, mode === "normal" ? "Paste" : "Paste special", after);
    if (internal && (mode === "normal" || mode === "format")) {
      if (internal.widths && this.isWholeCols(s)) {
        internal.widths.forEach((w, j) => d.widths.set(s.c0 + j, w));
        d.remeasureAll();
      }
      if (internal.heights && this.isWholeRows(s)) {
        const byH = new Map<number | null, number[]>();
        internal.heights.forEach((hgt, i) => { const k = hgt ?? null; byH.set(k, [...(byH.get(k) ?? []), d.dataRow(s.r0 + i)]); });
        for (const [hgt, rs] of byH) d.setRowHeights(rs, hgt, "Paste row heights");
      }
    }
    this.select(after, false);
    this.hooks.onChange();
  }

  /** Clear every cell in the selection. */
  clear(label = "Clear") {
    const d = this.doc;
    if (!d) return;
    const cells: { r: number; c: number; v: string }[] = [];
    const lastData = d.view ? d.view.length - 1 : d.rows.length - 1;
    for (const s of allRects(d.sel)) for (let r = s.r0; r <= Math.min(s.r1, lastData); r++) {
      const dr = d.dataRow(r);
      const row = d.rows[dr];
      if (!row) continue;
      for (let c = s.c0; c <= Math.min(s.c1, row.length - 1); c++) if (row[c] !== "") cells.push({ r: dr, c, v: "" });
    }
    // Images and checkboxes in cells count as content: Delete removes them.
    const sets: { r: number; c: number; v?: string; style?: number }[] = cells;
    for (const s of allRects(d.sel)) for (let r = s.r0; r <= Math.min(s.r1, lastData); r++) {
      const dr = d.dataRow(r);
      const st = d.rowStyleArray(dr);
      if (!st) continue;
      for (let c = s.c0; c <= Math.min(s.c1, st.length - 1); c++) {
        const style = d.styles[st[c]];
        if (!style?.img && !style?.check) continue;
        const { img: _, check: _c, ...rest } = style;
        const ex = sets.find((x) => x.r === dr && x.c === c);
        if (ex) ex.style = d.intern(rest); else sets.push({ r: dr, c, style: d.intern(rest) });
      }
    }
    d.setCells(sets, label);
    this.hooks.onChange();
  }

  /** Ctrl+D: copy the top row of the selection down through it. */
  fillDown() {
    const d = this.doc;
    if (!d) return;
    const s = selRect(d.sel);
    if (s.r1 === s.r0) {
      if (s.r0 === 0) return;
      s.r0 -= 1; // single row: copy from the row above, like Sheets
    }
    const src = d.dataRow(s.r0);
    const cells: CellSet[] = [];
    for (let r = s.r0 + 1; r <= s.r1; r++) {
      const dr = d.dataRow(r);
      for (let c = s.c0; c <= s.c1; c++) cells.push({ r: dr, c, v: offsetFormula(d.raw(src, c), dr - src, 0), style: d.styleId(src, c) });
    }
    d.setCells(cells, "Fill down");
    this.hooks.onChange();
    this.invalidate();
  }

  /* ---------------------------- navigation ---------------------------- */

  private move(dr: number, dc: number, extend: boolean) {
    const d = this.doc!;
    const s = d.sel;
    if (extend) this.select({ ...s, fr: s.fr + dr, fc: this.stepCol(s.fc, dc) });
    else {
      // Leaving a merged cell steps past its far edge.
      const m = this.mergeAt(s.ar, s.ac);
      const fromR = m ? (dr > 0 ? m.r1 : m.r0) : s.ar;
      const fromC = m ? (dc > 0 ? m.c1 : m.c0) : s.ac;
      const r = dr ? fromR + dr : s.ar, c = dc ? this.stepCol(fromC, dc) : s.ac;
      this.select({ ar: r, ac: c, fr: r, fc: c });
    }
  }

  /** Step over hidden columns. */
  private stepCol(c: number, dc: number): number {
    const d = this.doc!;
    if (!dc) return c;
    let n = c + dc;
    while (n >= 0 && n < d.displayCols() && this.cw(n) === 0) n += Math.sign(dc);
    return n < 0 || n >= d.displayCols() ? c : n;
  }

  /** Ctrl+Arrow: jump to the edge of the current block of data. */
  private jump(dr: number, dc: number, extend: boolean) {
    const d = this.doc!;
    const s = d.sel;
    let r = extend ? s.fr : s.ar;
    let c = extend ? s.fc : s.ac;
    const lastR = this.lastRow();
    const lastC = Math.max(0, d.cols - 1);
    const filled = (rr: number, cc: number) => rr >= 0 && cc >= 0 && rr <= lastR && d.raw(d.dataRow(rr), cc) !== "";
    if (dr) {
      if (filled(r, c) && filled(r + dr, c)) { while (filled(r + dr, c)) r += dr; }
      else { r += dr; while (r > 0 && r < lastR && !filled(r, c)) r += dr; r = clamp(r, 0, lastR); }
    } else {
      if (filled(r, c) && filled(r, c + dc)) { while (filled(r, c + dc)) c += dc; }
      else { c += dc; while (c > 0 && c < lastC && !filled(r, c)) c += dc; c = clamp(c, 0, lastC); }
    }
    if (extend) this.select({ ...s, fr: r, fc: c });
    else this.select({ ar: r, ac: c, fr: r, fc: c });
  }

  private pageRows(): number {
    return Math.max(1, Math.floor((this.scroller.clientHeight - this.bodyTop) / this.rh) - 1);
  }

  /** Keyboard handling while the grid (not the editor) has focus. */
  private onSinkKey(e: KeyboardEvent) {
    const d = this.doc;
    if (!d || d.loading !== null) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const sh = e.shiftKey;
    const s = d.sel;
    let handled = true;
    switch (e.key) {
      case "ArrowUp": ctrl ? this.jump(-1, 0, sh) : this.move(-1, 0, sh); break;
      case "ArrowDown": if (e.altKey && this.openDropdown()) break; ctrl ? this.jump(1, 0, sh) : this.move(1, 0, sh); break;
      case "ArrowLeft": ctrl ? this.jump(0, -1, sh) : this.move(0, -1, sh); break;
      case "ArrowRight": ctrl ? this.jump(0, 1, sh) : this.move(0, 1, sh); break;
      case "Tab": this.move(0, sh ? -1 : 1, false); break;
      case "Enter": if (sh) this.move(-1, 0, false); else if (!ctrl && !e.altKey && this.openDropdown()) break; else this.startEdit("edit"); break;
      case "F2": this.startEdit("edit"); break;
      case "PageDown": this.move(this.pageRows(), 0, sh); break;
      case "PageUp": this.move(-this.pageRows(), 0, sh); break;
      case "Home":
        if (ctrl) this.select(sh ? { ...s, fr: 0, fc: 0 } : { ar: 0, ac: 0, fr: 0, fc: 0 });
        else this.select(sh ? { ...s, fc: 0 } : { ar: s.ar, ac: 0, fr: s.ar, fc: 0 });
        break;
      case "End": {
        const lc = Math.max(0, d.cols - 1);
        if (ctrl) { const lr = this.lastRow(); this.select(sh ? { ...s, fr: lr, fc: lc } : { ar: lr, ac: lc, fr: lr, fc: lc }); }
        else this.select(sh ? { ...s, fc: lc } : { ar: s.ar, ac: lc, fr: s.ar, fc: lc });
        break;
      }
      case "Delete":
      case "Backspace": this.clear(); break;
      case "Escape": this.matcher = null; this.invalidate(); handled = false; break;
      case " ":
        // Space ticks the selection's checkboxes.
        handled = !ctrl && !sh && !e.altKey && d.style(d.dataRow(s.ar), s.ac).check === true && this.toggleChecks();
        break;
      default: handled = false;
    }
    if (!handled && ctrl) {
      handled = true;
      switch (e.key.toLowerCase()) {
        case "a": this.selectAll(); break;
        case "d": this.fillDown(); break;
        case "z": this.applyUndo(sh ? d.redo() : d.undo()); break;
        case "y": this.applyUndo(d.redo()); break;
        case " ": this.select({ ar: 0, ac: s.ac, fr: this.fullRow(), fc: s.fc }, false); break;
        default: handled = false;
      }
    } else if (!handled && sh && e.key === " ") {
      this.select({ ar: s.ar, ac: 0, fr: s.fr, fc: this.fullCol() }, false);
      handled = true;
    }
    if (handled) e.preventDefault();
  }

  applyUndo(sel: Sel | null) {
    if (!sel) return;
    // Bring the active cell into view (not the far corner of, say, a whole row).
    this.select(sel, false);
    this.scrollIntoView(this.doc!.sel.ar, this.doc!.sel.ac);
    this.hooks.onChange();
  }

  private onEditorKey(e: KeyboardEvent) {
    const ed = this.editing;
    if (!ed) return;
    const replace = ed.mode === "replace";
    if (e.key === "Enter" && !e.altKey) {
      e.preventDefault();
      const step = e.shiftKey ? -1 : 1;
      if (this.enterRight) this.commitEdit(0, step); else this.commitEdit(step, 0);
    }
    else if (e.key === "Enter" && e.altKey) {
      e.preventDefault();
      const t = this.editor;
      const a = t.selectionStart, b = t.selectionEnd;
      t.value = t.value.slice(0, a) + "\n" + t.value.slice(b);
      t.setSelectionRange(a + 1, a + 1);
      this.placeEditor();
      this.hooks.onEditText(t.value);
    }
    else if (e.key === "Tab") { e.preventDefault(); this.commitEdit(0, e.shiftKey ? -1 : 1); }
    else if (e.key === "Escape") { e.preventDefault(); if (!this.dismissSuggestion()) this.cancelEdit(); }
    else if (replace && !e.shiftKey && !this.editor.value.startsWith("=")) {
      const dir: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      const m = dir[e.key];
      if (m) { e.preventDefault(); this.commitEdit(m[0], m[1]); }
    }
  }

  /* ------------------------------ events ------------------------------ */

  private local(e: MouseEvent) {
    const r = this.wrap.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private bind() {
    const sc = this.scroller;

    sc.addEventListener("scroll", () => {
      const d = this.doc;
      if (!d) return;
      d.scrollX = sc.scrollLeft;
      if (!this.settingScroll) d.scrollY = this.fromScrollTop(sc.scrollTop);
      this.invalidate();
    });

    sc.addEventListener("pointerdown", (e) => {
      const d = this.doc;
      if (!d || d.loading !== null) return;
      const { x, y } = this.local(e);
      if (x > sc.clientWidth || y > sc.clientHeight) return; // on a scrollbar
      e.preventDefault();
      // Typing a formula: clicking a cell puts its reference in.
      const ff = this.formulaField();
      if (ff && e.button === 0 && this.zoneAt(x, y) === "cell" && this.expectsRef(ff)) {
        let r = this.rowAt(y), c = this.colAt(x);
        const m = this.mergeAt(r, c);
        if (m) { r = m.r0; c = m.c0; }
        this.insertPointRef(ff, r, c, r, c, true);
        this.drag = { kind: "pointref" };
        sc.setPointerCapture(e.pointerId);
        return;
      }
      if (this.editing) this.commitEdit();
      this.focus();
      if (e.button === 2) {
        const zone = this.zoneAt(x, y);
        const s = selRect(d.sel);
        const r = this.rowAt(y), c = this.colAt(x);
        const inside = zone === "cell" ? r >= s.r0 && r <= s.r1 && c >= s.c0 && c <= s.c1
          : zone === "col" ? c >= s.c0 && c <= s.c1 && this.isWholeCols(s)
          : zone === "row" ? r >= s.r0 && r <= s.r1 && this.isWholeRows(s) : true;
        if (!inside) this.pointSelect(zone, x, y, false);
        return;
      }
      if (e.button !== 0) return;
      if (!e.shiftKey && !e.ctrlKey && this.unhideAt(this.zoneAt(x, y), x, y)) return;
      if (this.nearFillHandle(x, y)) {
        this.drag = { kind: "fill", src: selRect(d.sel) };
        this.fillTarget = null;
        sc.setPointerCapture(e.pointerId);
        this.pointer = { x, y };
        this.startAutoScroll();
        this.invalidate();
        return;
      }
      if (this.onSelectionEdge(x, y)) {
        const s = selRect(d.sel);
        this.drag = { kind: "move", src: s, grabR: clamp(this.rowAt(y), s.r0, s.r1), grabC: clamp(this.colAt(x), s.c0, s.c1) };
        this.moveTarget = null;
        sc.setPointerCapture(e.pointerId);
        sc.style.cursor = "grabbing";
        this.pointer = { x, y };
        this.startAutoScroll();
        return;
      }
      const rcFirst = y < this.hh ? this.resizeColAt(x, y) : -1;
      const fz = rcFirst < 0 ? this.freezeHit(x, y) : null;
      if (fz) {
        // Start from the top/left so boundaries line up with real rows/columns.
        if (fz === "freezeRows") this.setScroll(d.scrollX, 0); else this.setScroll(0, d.scrollY);
        this.drag = { kind: fz };
        this.pointer = { x, y };
        this.freezePreview = this.freezeCountAt(fz, x, y);
        sc.setPointerCapture(e.pointerId);
        sc.style.cursor = "grabbing";
        this.invalidate();
        return;
      }
      const rc = this.resizeColAt(x, y);
      if (rc >= 0) {
        this.drag = { kind: "resize", col: rc, startX: x, startW: d.width(rc) };
        sc.setPointerCapture(e.pointerId);
        return;
      }
      const zone = this.zoneAt(x, y);
      if (zone === "col" && this.hoverChevron && this.hoverCol >= 0) {
        const c = this.hoverCol;
        const rect = this.wrap.getBoundingClientRect();
        this.onColumnHeaderMenu(c, rect.left + this.colLeft(c) + this.cw(c) - 24, rect.top + this.hh);
        return;
      }
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey && this.startReorder(zone, x, y)) { sc.setPointerCapture(e.pointerId); return; }
      const hit = !e.shiftKey && !e.ctrlKey && !e.metaKey ? this.widgetHit(x, y) : null;
      this.pointSelect(zone, x, y, e.shiftKey, (e.ctrlKey || e.metaKey) && !e.shiftKey);
      if (hit?.kind === "check") { this.toggleChecks([{ r: hit.r, c: hit.c }]); return; }
      if (hit?.kind === "list") { this.openDropdown(); return; }
      this.drag = zone === "col" ? { kind: "cols" } : zone === "row" ? { kind: "rows" } : zone === "cell" ? { kind: "cells" } : null;
      if (this.drag) { sc.setPointerCapture(e.pointerId); this.pointer = { x, y }; this.startAutoScroll(); }
    });

    sc.addEventListener("pointermove", (e) => {
      const d = this.doc;
      if (!d) return;
      const { x, y } = this.local(e);
      this.pointer = { x, y };
      const drag = this.drag;
      if (drag?.kind === "resize") {
        d.widths.set(drag.col, clamp(drag.startW + (x - drag.startX) / this.zoom, 24, 2000));
        this.invalidate();
        return;
      }
      if (drag?.kind === "reorder") { this.updateReorder(drag, x, y); return; }
      if (drag?.kind === "pointref") {
        const p = this.pointRef;
        if (p) { const r = clamp(this.rowAt(y), 0, d.displayRows() - 1), c = clamp(this.colAt(x), 0, d.displayCols() - 1); this.insertPointRef(p.field, p.ar, p.ac, r, c, false); }
        return;
      }
      if (drag?.kind === "fill") { this.updateFillTarget(drag.src, x, y); this.invalidate(); return; }
      if (drag?.kind === "move") { this.updateMoveTarget(drag, x, y); this.invalidate(); return; }
      if (drag?.kind === "freezeRows" || drag?.kind === "freezeCols") {
        this.freezePreview = this.freezeCountAt(drag.kind, x, y);
        this.invalidate();
        return;
      }
      if (drag) { this.dragTo(x, y); return; }
      // Hover feedback
      const rc = this.resizeColAt(x, y);
      const fz = this.hoverCursor(x, y);
      if (fz !== this.hoverFreeze) { this.hoverFreeze = fz; this.invalidate(); }
      const hc = y < this.hh && x >= this.rowHeaderWidth() ? this.colAt(x) : -1;
      const chev = hc >= 0 && rc < 0 && x > this.colLeft(hc) + this.cw(hc) - 24 && this.cw(hc) > 44;
      if (hc !== this.hoverCol || chev !== this.hoverChevron) {
        this.hoverCol = hc;
        this.hoverChevron = chev;
        this.invalidate();
      }
    });

    const end = (e: PointerEvent) => {
      const drag = this.drag;
      // The cursor reflects the new selection straight away (e.g. the hand
      // over a header that's just been selected), without waiting for a move.
      if (drag && drag.kind !== "reorder" && drag.kind !== "move" && drag.kind !== "fill") {
        const p = this.local(e);
        requestAnimationFrame(() => { if (!this.drag) this.hoverCursor(p.x, p.y); });
      }
      if (drag?.kind === "reorder") this.endReorder(drag, e.type === "pointerup");
      if (drag?.kind === "resize") { this.doc?.remeasureAll(); this.hooks.onChange(); }
      if (drag?.kind === "move") {
        const t = this.moveTarget;
        this.moveTarget = null;
        this.drag = null;
        sc.style.cursor = "default";
        if (t && e.type === "pointerup") this.moveCells(drag.src, t, e.ctrlKey || e.metaKey);
        this.invalidate();
      }
      if (drag?.kind === "fill") {
        const t = this.fillTarget;
        this.fillTarget = null;
        this.drag = null;
        if (t && e.type === "pointerup") this.fill(drag.src, t, e.ctrlKey || e.metaKey);
        this.invalidate();
      }
      if ((drag?.kind === "freezeRows" || drag?.kind === "freezeCols") && this.doc && this.freezePreview !== null) {
        const d = this.doc;
        if (drag.kind === "freezeRows") d.setFrozen(this.freezePreview, d.frozenCols);
        else d.setFrozen(d.frozenRows, this.freezePreview);
        this.freezePreview = null;
        sc.style.cursor = "grab";
        this.drag = null;
        this.layout();
        this.select(d.sel, false);
        this.hooks.onChange();
      }
      this.drag = null;
      cancelAnimationFrame(this.autoScroll);
      this.autoScroll = 0;
      if (sc.hasPointerCapture(e.pointerId)) sc.releasePointerCapture(e.pointerId);
    };
    sc.addEventListener("pointerup", end);
    sc.addEventListener("pointercancel", end);
    sc.addEventListener("pointerleave", () => {
      if (!this.drag && this.hoverFreeze) { this.hoverFreeze = null; this.invalidate(); }
      if (!this.drag && this.hoverCol !== -1) { this.hoverCol = -1; this.hoverChevron = false; this.invalidate(); }
    });

    sc.addEventListener("dblclick", (e) => {
      const d = this.doc;
      if (!d) return;
      const { x, y } = this.local(e);
      if (this.nearFillHandle(x, y)) { this.fillDownToNeighbour(); return; }
      const rc = this.resizeColAt(x, y);
      if (rc >= 0) { this.autoFit(rc); return; }
      if (this.zoneAt(x, y) === "cell") this.startEdit("edit");
    });

    sc.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const d = this.doc;
      if (!d) return;
      const { x, y } = this.local(e);
      this.hooks.onContextMenu(this.zoneAt(x, y), e.clientX, e.clientY);
    });

    // Keyboard sink: navigation, typing to start editing, clipboard.
    this.sink.addEventListener("keydown", (e) => this.onSinkKey(e));
    this.sink.addEventListener("input", (e) => {
      if ((e as InputEvent).isComposing) return;
      const v = this.sink.value;
      this.sink.value = "";
      if (v) this.startEdit("replace", v);
    });
    this.sink.addEventListener("compositionstart", () => {
      // IME input: hand over to the real editor straight away.
      this.startEdit("replace", "");
    });
    this.sink.addEventListener("copy", (e) => {
      const t = this.copy();
      if (t !== null) { e.clipboardData?.setData("text/plain", t); e.preventDefault(); }
    });
    this.sink.addEventListener("cut", (e) => {
      const t = this.copy(true);
      if (t !== null) { e.clipboardData?.setData("text/plain", t); e.preventDefault(); }
    });
    this.sink.addEventListener("paste", (e) => {
      e.preventDefault();
      const pic = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
      if (pic && this.hooks.onPasteImage) { this.hooks.onPasteImage(pic); return; }
      const t = e.clipboardData?.getData("text/plain");
      const mode = this.pasteValuesNext ? "values" : "normal";
      this.pasteValuesNext = false;
      if (t) this.paste(t, mode);
    });
    // Ctrl+Shift+V: the browser still fires "paste"; remember to drop formulas and formatting.
    this.sink.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "v") this.pasteValuesNext = true;
    }, true);

    this.editor.addEventListener("keydown", (e) => this.onEditorKey(e));
    this.editor.addEventListener("input", (e) => {
      if (!this.pointing) this.pointRef = null;
      this.autocomplete(e as InputEvent);
      this.styleEditor();
      this.placeEditor();
      this.hooks.onEditText(this.editor.value);
      if (this.editor.value.startsWith("=")) this.invalidate();
    });
    // Moving the caret onto a reference highlights it.
    const caretMoved = () => { if (this.editing && this.editor.value.startsWith("=")) { this.paintFormula(); this.invalidate(); } };
    for (const ev of ["keyup", "click", "select"]) this.editor.addEventListener(ev, caretMoved);
    this.editor.addEventListener("blur", () => {
      // Clicking elsewhere in the app commits, like a spreadsheet.
      setTimeout(() => {
        if (this.editing && document.activeElement !== this.editor && document.activeElement?.id !== "cell-input") this.commitEdit();
      });
    });
  }

  /** Column header menu (also used by the chevron). */
  onColumnHeaderMenu(c: number, x: number, y: number) {
    const d = this.doc!;
    const s = selRect(d.sel);
    if (!(c >= s.c0 && c <= s.c1 && this.isWholeCols(s))) {
      this.select({ ar: 0, ac: c, fr: this.fullRow(), fc: c }, false);
    }
    this.hooks.onColumnMenu(c, x, y);
  }

  /**
   * Click selection. Shift extends the current range to the clicked cell;
   * Ctrl keeps what's selected and starts another range.
   */
  private pointSelect(zone: Zone, x: number, y: number, extend: boolean, add = false) {
    const d = this.doc!;
    const s = d.sel;
    const r = this.rowAt(y), c = this.colAt(x);
    const extra = add ? [...(s.extra ?? []), selRect(s)] : extend ? s.extra : undefined;
    const R = this.fullRow(), C = this.fullCol();
    if (zone === "corner") { this.selectAll(); return; }
    let next: Sel;
    if (zone === "col") next = extend ? { ar: 0, ac: s.ac, fr: R, fc: c } : { ar: 0, ac: c, fr: R, fc: c };
    else if (zone === "row") next = extend ? { ar: s.ar, ac: 0, fr: r, fc: C } : { ar: r, ac: 0, fr: r, fc: C };
    else next = extend ? { ...s, fr: r, fc: c } : { ar: r, ac: c, fr: r, fc: c };
    next.extra = extra;
    this.select(next, false);
  }

  private dragTo(x: number, y: number) {
    const d = this.doc!;
    const drag = this.drag!;
    const s = d.sel;
    const c = this.colAt(clamp(x, this.rowHeaderWidth(), this.w - 1));
    const r = this.rowAt(clamp(y, this.hh, this.h - 1));
    if (drag.kind === "cells") { if (r !== s.fr || c !== s.fc) this.select({ ...s, fr: r, fc: c }, false); }
    else if (drag.kind === "cols") { if (c !== s.fc) this.select({ ...s, fc: c }, false); }
    else if (drag.kind === "rows") { if (r !== s.fr) this.select({ ...s, fr: r }, false); }
  }

  private startAutoScroll() {
    const tick = () => {
      if (!this.drag || this.drag.kind === "resize" || this.drag.kind === "freezeRows" || this.drag.kind === "freezeCols") return;
      const { x, y } = this.pointer;
      const d = this.doc!;
      let dx = 0, dy = 0;
      // Speed grows with distance past the edge, in every direction.
      const speed = (past: number) => Math.min(80, past * 1.2);
      const bottom = this.scroller.clientHeight - 8, right = this.scroller.clientWidth - 8;
      if (y > bottom) dy = speed(y - bottom);
      else if (y < this.bodyTop + 4 && this.drag.kind !== "cols" && d.scrollY > 0) dy = -speed(this.bodyTop + 4 - y);
      if (x > right) dx = speed(x - right);
      else if (x < this.bodyLeft + 4 && this.drag.kind !== "rows" && d.scrollX > 0) dx = -speed(this.bodyLeft + 4 - x);
      if (dx || dy) {
        this.setScroll(d.scrollX + dx, d.scrollY + dy);
        if (this.drag.kind === "fill") this.updateFillTarget(this.drag.src, x, y);
        else if (this.drag.kind === "move") this.updateMoveTarget(this.drag, x, y);
        else this.dragTo(x, y);
      }
      this.autoScroll = requestAnimationFrame(tick);
    };
    this.autoScroll = requestAnimationFrame(tick);
  }
}

export { DEFAULT_WIDTH };
