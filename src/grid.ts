import { fromTSV, toTSV } from "./csv";
import { CellSet, DEFAULT_WIDTH, Doc, Rect, Sel, allRects, selRect } from "./doc";
import { offsetFormula } from "./formula";
import { fillValues } from "./fill";
import { DEFAULT_FONT, DEFAULT_SIZE, Style, Theme, applyNumFmt, ptToPx, resolveColor } from "./format";
import { clamp, colName, parseNum } from "./util";

const BASE_ROW_H = 26;
const BASE_HEAD_H = 28;
const MAX_PX = 15_000_000; // browsers cap element height; beyond this we scale the scrollbar
const BASE_PAD = 8;
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
}

type Drag =
  | { kind: "cells" }
  | { kind: "cols" }
  | { kind: "rows" }
  | { kind: "resize"; col: number; startX: number; startW: number }
  | { kind: "fill"; src: Rect }
  | { kind: "freezeRows" }
  | { kind: "freezeCols" };

interface Editing { r: number; c: number; mode: "replace" | "edit" }

/** Internal clipboard: lets formulas survive copy/paste inside Bento. */
let lastCopy: { tsv: string; raw: string[][]; styles: Style[][]; rows: number[]; c: number } | null = null;

export class Grid {
  doc: Doc | null = null;
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
  /** Freeze drag: how many rows/columns would be frozen. */
  private freezePreview: number | null = null;
  private hoverFreeze: "freezeRows" | "freezeCols" | null = null;
  private editorWraps = false;
  /** When set, cells whose text matches are highlighted (find). */
  matcher: ((s: string) => boolean) | null = null;
  /** Zoom factor (1 = 100%). Column widths are stored unzoomed. */
  zoom = 1;

  private get rh() { return Math.round(BASE_ROW_H * this.zoom); }
  private get hh() { return Math.round(BASE_HEAD_H * this.zoom); }
  private get pad() { return Math.round(BASE_PAD * this.zoom); }
  private get font() { return `${13 * this.zoom}px ${FONT_STACK}`; }
  private get fontHead() { return `${12 * this.zoom}px ${FONT_STACK}`; }
  private get fontHeadBold() { return `600 ${12 * this.zoom}px ${FONT_STACK}`; }
  /** On-screen width of a column. */
  private cw(c: number): number { return Math.round(this.doc!.width(c) * this.zoom); }

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
    if (!d || !d.tallRows) return this.rh;
    const h = d.rowHeight(d.dataRow(r));
    return h ? Math.round(h * this.zoom) : this.rh;
  }

  /** Running row tops, only built when some rows are taller than default. */
  private ys: Float64Array | null = null;
  private ysKey = "";

  private buildYs() {
    const d = this.doc;
    if (!d || !d.tallRows) { this.ys = null; this.ysKey = ""; return; }
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
    return Math.round(Math.max(46, 20 + String(last).length * 7.6) * this.zoom);
  }

  private layout() {
    const d = this.doc;
    if (!d) { this.spacer.style.width = "1px"; this.spacer.style.height = "1px"; return; }
    this.theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
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

  private get sx(): number { return this.doc?.scrollX ?? 0; }
  private get sy(): number { return this.doc?.scrollY ?? 0; }

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
    const st = d.rowStyleArray(r);
    if (!st) return 0;
    const ctx = this.ctx;
    let max = 0;
    for (let c = 0; c < st.length; c++) {
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
      if (s.wrap === "wrap" && raw) {
        ctx.font = this.cellFont(s, r === 0 && d.freezeHeader, 1);
        lines = this.wrapLines(this.cellText(r, c, raw, s, d).text, d.width(c) - BASE_PAD * 2).length;
      } else if (!raw && !s.size) continue;
      max = Math.max(max, lines * lh + 8);
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

    this.drawFillHandle(rect);
    this.drawFillPreview();

    this.drawColHeaders(c0, c1, rect, bodyLeft, w);
    if (fc) this.drawColHeaders(0, fc - 1, rect, rhw, bodyLeft);
    this.drawRowHeaders(r0, r1, rect, rhw);

    // Freeze lines.
    const drag = this.drag;
    const hot = (kind: "freezeRows" | "freezeCols") => drag?.kind === kind || this.hoverFreeze === kind;
    ctx.fillStyle = k.lineStrong;
    ctx.fillRect(0, this.hh - 1, w, 1);
    ctx.fillRect(rhw - 1, 0, 1, h);
    if (fb) { ctx.fillStyle = hot("freezeRows") ? k.accent : k.lineStrong; ctx.fillRect(0, bodyTop - 2, w, 2); }
    if (fc) { ctx.fillStyle = hot("freezeCols") ? k.accent : k.lineStrong; ctx.fillRect(bodyLeft - 2, 0, 2, h); }

    // Corner, with the two freeze handles on its bottom and right edges.
    ctx.fillStyle = k.bg;
    ctx.fillRect(0, 0, rhw - 1, this.hh - 1);
    const bar = Math.max(3, Math.round(3 * this.zoom));
    ctx.fillStyle = hot("freezeRows") ? k.accent : k.muted;
    ctx.fillRect(0, this.hh - bar, rhw, bar);
    ctx.fillStyle = hot("freezeCols") ? k.accent : k.muted;
    ctx.fillRect(rhw - bar, 0, bar, this.hh);
    if (d.filters.size) {
      ctx.fillStyle = k.accent;
      this.funnel(rhw / 2 - 6, this.hh / 2 - 6);
    }
    this.drawFreezePreview();
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
    const drawText = (r: number, c: number) => {
      const dr = d.dataRow(r);
      const row = d.rows[dr];
      if (!row) return;
      const raw = row[c];
      if (!raw) return;
      const m = mergeOf(r, c);
      const box = boxOf(r, c, m);
      if (box.w < 6) return;
      const st = d.rowStyleArray(dr);
      const s = st && st[c] ? d.styles[st[c]] : NO_STYLE;
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
      else { const nl = full.indexOf("\n"); lines = [nl >= 0 ? full.slice(0, nl) + " ↵" : full]; }

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
      let ty = va === "t" ? y + 4 * this.zoom + lh / 2
        : va === "m" ? y + (rh - block) / 2 + lh / 2
        : y + rh - 4 * this.zoom - block + lh / 2;
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

    // 3. Grid lines (none inside merged cells).
    ctx.fillStyle = k.line;
    const inMergeH = (r: number, c: number) => merges.some((m) => r >= m.r0 && r < m.r1 && c >= m.c0 && c <= m.c1);
    const inMergeV = (r: number, c: number) => merges.some((m) => r >= m.r0 && r <= m.r1 && c >= m.c0 && c < m.c1);
    for (let r = r0; r <= r1; r++) {
      const y = this.rowTop(r) + this.rowH(r) - 1;
      if (!merges.length) { ctx.fillRect(rhw, y, right - rhw, 1); continue; }
      for (let c = c0; c <= c1; c++) {
        if (inMergeH(r, c)) continue;
        ctx.fillRect(this.colLeft(c), y, this.cw(c), 1);
      }
    }
    for (let c = c0; c <= c1; c++) {
      const cw = this.cw(c);
      if (!cw) continue;
      const x = this.colLeft(c) + cw - 1;
      if (!skipV.size && !merges.length) {
        const top = frozen ? this.hh : this.bodyTop;
        const bottom = frozen ? this.bodyTop : Math.min(this.h, this.rowTop(r1) + this.rowH(r1));
        ctx.fillRect(x, top, 1, bottom - top);
        continue;
      }
      for (let r = r0; r <= r1; r++) {
        if (skipV.has(r * 65536 + c) || inMergeV(r, c)) continue;
        ctx.fillRect(x, this.rowTop(r), 1, this.rowH(r));
      }
    }

    // 4. Selection borders + active cell.
    ctx.strokeStyle = k.accent;
    ctx.lineWidth = 1;
    for (const e of extras) { const b = extraBox(e); ctx.strokeRect(b.x0 - 0.5, b.y0 - 0.5, b.x1 - b.x0, b.y1 - b.y0); }
    if (selVisible) {
      ctx.strokeStyle = k.accent;
      ctx.lineWidth = 1;
      if (!single) ctx.strokeRect(selX0 - 0.5, selY0 - 0.5, selX1 - selX0, selY1 - selY0);
      if (!this.editing && (activeM ? activeM.r1 >= r0 && activeM.r0 <= r1 : d.sel.ar >= r0 && d.sel.ar <= r1)) {
        const b = this.cellBox(d.sel.ar, d.sel.ac);
        ctx.lineWidth = 2;
        ctx.strokeRect(b.x, b.y, b.w - 1, b.h - 1);
      }
    }
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
        ctx.fillStyle = k.muted;
        ctx.fillRect(x - 2, 8, 3, hh - 16);
        continue;
      }
      const hits = rects.filter((r) => c >= r.c0 && c <= r.c1 && (!this.isWholeRows(r) || this.isWholeCols(r)));
      const inSel = hits.length > 0;
      const whole = hits.some((r) => this.isWholeCols(r));
      if (inSel) {
        ctx.fillStyle = whole ? k.selHeadStrong : k.selHead;
        ctx.fillRect(x, 0, cw, hh);
      } else if (c === this.hoverCol) {
        ctx.fillStyle = k.surface;
        ctx.fillRect(x, 0, cw, hh);
      }
      ctx.font = whole ? this.fontHeadBold : this.fontHead;
      ctx.fillStyle = whole ? k.text : inSel ? k.accentText : k.muted;
      ctx.fillText(colName(c), x + cw / 2, hh / 2 + 0.5);
      if (d.filters.has(c)) {
        ctx.fillStyle = k.accent;
        this.funnel(x + cw - 20, hh / 2 - 5);
      } else if (c === this.hoverCol && cw > 44) {
        const cx = x + cw - 14;
        if (this.hoverChevron) {
          ctx.fillStyle = k.surface2;
          this.roundRect(cx - 9, 5, 18, hh - 10, 4);
        }
        ctx.strokeStyle = k.text2;
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(cx - 3.5, hh / 2 - 1.5);
        ctx.lineTo(cx, hh / 2 + 2);
        ctx.lineTo(cx + 3.5, hh / 2 - 1.5);
        ctx.stroke();
      }
      // Full-height separator, continuous with the grid line below.
      ctx.fillStyle = k.line;
      ctx.fillRect(x + cw - 1, 0, 1, hh);
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
        ctx.fillStyle = whole ? k.selHeadStrong : k.selHead;
        ctx.fillRect(0, y, rhw - 1, rh);
      }
      ctx.font = whole ? this.fontHeadBold : this.fontHead;
      ctx.fillStyle = whole ? k.text : inSel ? k.accentText : k.muted;
      ctx.fillText(String(d.dataRow(r) + 1), rhw / 2, y + rh / 2 + 0.5);
      ctx.fillStyle = k.line;
      ctx.fillRect(0, y + rh - 1, rhw - 1, 1);
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

  private roundRect(x: number, y: number, w: number, h: number, r: number) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
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
      const t = this.cellText(r, c, raw, s).text;
      const nl = t.indexOf("\n");
      const m = ctx.measureText(nl >= 0 ? t.slice(0, nl) + " ↵" : t).width;
      if (m > max) max = m;
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
    const x = b.x + b.w - 1, y = b.y + b.h - 1;
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
    const onRows = this.fb === 0
      ? x < rhw && y >= this.hh - 6 && y <= this.hh + 2
      : Math.abs(y - (this.bodyTop - 1)) <= 3 && y > this.hh;
    const onCols = this.fc === 0
      ? y < this.hh && x >= rhw - 6 && x <= rhw + 2
      : Math.abs(x - (this.bodyLeft - 1)) <= 3 && y >= this.hh;
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
    const { x, y } = this.pointer;
    ctx.save();
    if (drag.kind === "freezeRows") {
      const pos = this.hh + this.yOf(this.freezePreview);
      ctx.fillStyle = k.accent;
      ctx.fillRect(0, pos - 2, this.w, 3);
      ctx.globalAlpha = 0.35;
      ctx.fillRect(0, clamp(y, this.hh, this.h) - 2, this.w, 4);
    } else {
      const pos = this.rowHeaderWidth() + this.xs[this.freezePreview];
      ctx.fillStyle = k.accent;
      ctx.fillRect(pos - 2, 0, 3, this.h);
      ctx.globalAlpha = 0.35;
      ctx.fillRect(clamp(x, this.rowHeaderWidth(), this.w) - 2, 0, 4, this.h);
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
    // The editor takes on the cell's look, so typing feels in place.
    const dr = d.dataRow(ar);
    const s = d.style(dr, ac);
    const px = ptToPx(s.size ?? DEFAULT_SIZE) * this.zoom;
    const es = this.editor.style;
    es.font = this.cellFont(s, ar === 0 && d.freezeHeader);
    es.lineHeight = Math.round(px * 1.35) + "px";
    es.padding = `${Math.max(2, Math.round((this.rh - px * 1.35) / 2) - 2)}px ${this.pad - 1}px`;
    es.color = resolveColor(s.color, this.theme) ?? "";
    es.textDecoration = [s.u ? "underline" : "", s.s ? "line-through" : ""].join(" ").trim() || "none";
    es.textAlign = s.ha === "c" ? "center" : s.ha === "r" ? "right" : "left";
    es.whiteSpace = s.wrap === "wrap" ? "pre-wrap" : "pre";
    this.editorWraps = s.wrap === "wrap";
    this.placeEditor();
    if (focusEditor) {
      this.editor.focus({ preventScroll: true });
      const end = this.editor.value.length;
      this.editor.setSelectionRange(end, end);
    }
    this.hooks.onEditText(this.editor.value);
    this.invalidate();
  }

  /** Commit the edit, then optionally move the selection. */
  commitEdit(dr = 0, dc = 0) {
    const e = this.editing;
    const d = this.doc;
    if (!e || !d) return;
    const v = this.editor.value;
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

  private stopEdit() {
    this.editing = null;
    this.editor.style.display = "none";
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
  }

  /** The cell bar edits the same value; keep the in-cell editor in sync. */
  setEditorText(v: string) {
    if (!this.editing) return;
    this.editor.value = v;
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
    const shown: string[][] = [];
    const styles: Style[][] = [];
    const rows: number[] = [];
    for (let r = s.r0; r <= s.r1; r++) {
      const dr = d.dataRow(r);
      rows.push(dr);
      const a: string[] = [], b: string[] = [], st: Style[] = [];
      for (let c = s.c0; c <= s.c1; c++) {
        const v = d.raw(dr, c);
        const sty = d.style(dr, c);
        a.push(v);
        st.push(sty);
        b.push(v ? this.cellText(dr, c, v, sty).text : "");
      }
      raw.push(a);
      shown.push(b);
      styles.push(st);
    }
    const tsv = toTSV(shown);
    lastCopy = { tsv, raw, styles, rows, c: s.c0 };
    if (cut) this.clear("Cut");
    return tsv;
  }

  paste(text: string) {
    const d = this.doc;
    if (!d) return;
    const internal = lastCopy && lastCopy.tsv === text ? lastCopy : null;
    const block = internal ? internal.raw : fromTSV(text);
    if (!block.length) return;
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
        if (internal) {
          const srcR = internal.rows[fill ? 0 : i];
          const srcC = internal.c + (fill ? 0 : j);
          v = offsetFormula(v, dr - srcR, s.c0 + j - srcC);
          // Formatting comes along when copying inside Bento.
          const sty = fill ? internal.styles[0][0] : internal.styles[i]?.[j];
          cells.push({ r: dr, c: s.c0 + j, v, style: d.intern(sty ?? {}) });
          continue;
        }
        cells.push({ r: dr, c: s.c0 + j, v });
      }
    }
    const after: Sel = { ar: s.r0, ac: s.c0, fr: s.r0 + h - 1, fc: s.c0 + w - 1 };
    d.setCells(cells, "Paste", after);
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
    d.setCells(cells, label);
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
      case "ArrowDown": ctrl ? this.jump(1, 0, sh) : this.move(1, 0, sh); break;
      case "ArrowLeft": ctrl ? this.jump(0, -1, sh) : this.move(0, -1, sh); break;
      case "ArrowRight": ctrl ? this.jump(0, 1, sh) : this.move(0, 1, sh); break;
      case "Tab": this.move(0, sh ? -1 : 1, false); break;
      case "Enter": if (sh) this.move(-1, 0, false); else this.startEdit("edit"); break;
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
    this.select(sel);
    this.hooks.onChange();
  }

  private onEditorKey(e: KeyboardEvent) {
    const ed = this.editing;
    if (!ed) return;
    const replace = ed.mode === "replace";
    if (e.key === "Enter" && !e.altKey) { e.preventDefault(); this.commitEdit(e.shiftKey ? -1 : 1, 0); }
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
    else if (e.key === "Escape") { e.preventDefault(); this.cancelEdit(); }
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
      if (this.editing) this.commitEdit();
      this.focus();
      if (e.button === 2) {
        const zone = this.zoneAt(x, y);
        const s = selRect(d.sel);
        const r = this.rowAt(y), c = this.colAt(x);
        const inside = zone === "cell" ? r >= s.r0 && r <= s.r1 && c >= s.c0 && c <= s.c1
          : zone === "col" ? c >= s.c0 && c <= s.c1 && this.isWholeCols(s)
          : zone === "row" ? r >= s.r0 && r <= s.r1 : true;
        if (!inside) this.pointSelect(zone, x, y, false);
        return;
      }
      if (e.button !== 0) return;
      if (this.nearFillHandle(x, y)) {
        this.drag = { kind: "fill", src: selRect(d.sel) };
        this.fillTarget = null;
        sc.setPointerCapture(e.pointerId);
        this.pointer = { x, y };
        this.startAutoScroll();
        this.invalidate();
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
      this.pointSelect(zone, x, y, e.shiftKey, (e.ctrlKey || e.metaKey) && !e.shiftKey);
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
      if (drag?.kind === "fill") { this.updateFillTarget(drag.src, x, y); this.invalidate(); return; }
      if (drag?.kind === "freezeRows" || drag?.kind === "freezeCols") {
        this.freezePreview = this.freezeCountAt(drag.kind, x, y);
        this.invalidate();
        return;
      }
      if (drag) { this.dragTo(x, y); return; }
      // Hover feedback
      const rc = this.resizeColAt(x, y);
      const fz = rc < 0 || y >= this.hh ? this.freezeHit(x, y) : null;
      const onFill = this.nearFillHandle(x, y);
      sc.style.cursor = onFill ? "crosshair" : fz ? "grab" : rc >= 0 ? "col-resize" : "default";
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
      if (drag?.kind === "resize") { this.doc?.remeasureAll(); this.hooks.onChange(); }
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
      const t = e.clipboardData?.getData("text/plain");
      if (t) this.paste(t);
    });

    this.editor.addEventListener("keydown", (e) => this.onEditorKey(e));
    this.editor.addEventListener("input", () => {
      this.placeEditor();
      this.hooks.onEditText(this.editor.value);
    });
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
        else this.dragTo(x, y);
      }
      this.autoScroll = requestAnimationFrame(tick);
    };
    this.autoScroll = requestAnimationFrame(tick);
  }
}

export { DEFAULT_WIDTH };
