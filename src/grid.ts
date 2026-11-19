import { fromTSV, toTSV } from "./csv";
import { CellSet, DEFAULT_WIDTH, Doc, Rect, Sel, selRect } from "./doc";
import { offsetFormula } from "./formula";
import { DEFAULT_SIZE, Style, Theme, applyNumFmt, ptToPx, resolveColor } from "./format";
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
}

export interface GridHooks {
  onSelection(): void;
  onChange(): void;
  onContextMenu(zone: Zone, x: number, y: number): void;
  onColumnMenu(c: number, x: number, y: number): void;
  onEditText(text: string | null): void;
}

type Drag =
  | { kind: "cells" }
  | { kind: "cols" }
  | { kind: "rows" }
  | { kind: "resize"; col: number; startX: number; startW: number };

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
    d.sel = {
      ar: clamp(sel.ar, 0, maxR), ac: clamp(sel.ac, 0, maxC),
      fr: clamp(sel.fr, 0, maxR), fc: clamp(sel.fc, 0, maxC),
    };
    if (scroll) this.scrollIntoView(d.sel.fr, d.sel.fc);
    this.hooks.onSelection();
    this.invalidate();
  }

  selectAll() {
    const d = this.doc;
    if (!d) return;
    this.select({ ar: 0, ac: 0, fr: this.lastRow(), fc: Math.max(0, d.cols - 1) }, false);
  }

  /** Last display row that holds data. */
  lastRow(): number {
    const d = this.doc!;
    return Math.max(0, (d.view ? d.view.length : d.rows.length) - 1);
  }

  /* ----------------------------- geometry ----------------------------- */

  private get fb(): number { return this.doc?.freezeHeader ? 1 : 0; }
  private get bodyTop(): number { return this.hh + (this.fb ? this.rowH(0) : 0); }

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
    const key = `${d.id}:${d.version}:${this.zoom}:${n}:${d.freezeHeader}`;
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
    return r < this.fb ? this.hh : this.bodyTop + this.yOf(r) - this.yOf(this.fb) - this.sy;
  }

  colLeft(c: number): number {
    return this.rowHeaderWidth() + this.xs[Math.min(c, this.ncols)] - this.sx;
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
    return this.colAtContent(x - this.rowHeaderWidth() + this.sx);
  }

  rowAt(y: number): number {
    if (this.fb && y >= this.hh && y < this.bodyTop) return 0;
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
      const right = rhw + this.xs[c + 1] - this.sx;
      if (right < rhw) continue;
      if (right > this.w + 10) break;
      if (Math.abs(x - right) <= 4 && this.cw(c) > 0) return c;
    }
    return -1;
  }

  scrollIntoView(r: number, c: number) {
    const d = this.doc;
    if (!d) return;
    const viewW = this.scroller.clientWidth - this.rowHeaderWidth();
    const viewH = this.scroller.clientHeight - this.bodyTop;
    let { scrollX: x, scrollY: y } = d;
    const left = this.xs[Math.min(c, this.ncols)];
    const right = this.xs[Math.min(c + 1, this.ncols)];
    if (left < x) x = left;
    else if (right > x + viewW) x = Math.max(0, right - viewW);
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
    return `${s.i ? "italic " : ""}${bold ? "600 " : ""}${px}px ${FONT_STACK}`;
  }

  /** What a cell shows: formula result, then number/date formatting. */
  private cellText(r: number, c: number, raw: string, s: Style, d: Doc = this.doc!): { text: string; err: boolean; numeric: boolean } {
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
      if (!s.size && s.wrap !== "wrap") continue;
      const lh = Math.round(ptToPx(s.size ?? DEFAULT_SIZE) * 1.35);
      let lines = 1;
      const raw = d.raw(r, c);
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
    const fb = this.fb;
    const bodyTop = this.bodyTop;
    const c0 = this.colAtContent(this.sx);
    const c1 = this.colAtContent(this.sx + w - rhw);
    const r0 = this.rowAtBody(this.sy);
    const r1 = this.rowAtBody(this.sy + h - bodyTop);
    const rect = selRect(d.sel);

    ctx.save();
    ctx.beginPath();
    ctx.rect(rhw, bodyTop, w - rhw, h - bodyTop);
    ctx.clip();
    this.drawCells(r0, r1, c0, c1, rect, false);
    ctx.restore();

    if (fb) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(rhw, this.hh, w - rhw, this.rowH(0));
      ctx.clip();
      ctx.fillStyle = k.surface;
      ctx.fillRect(rhw, this.hh, w - rhw, this.rowH(0));
      this.drawCells(0, 0, c0, c1, rect, true);
      ctx.restore();
      ctx.fillStyle = k.lineStrong;
      ctx.fillRect(0, bodyTop - 1, w, 1);
    }

    this.drawColHeaders(c0, c1, rect, rhw);
    this.drawRowHeaders(r0, r1, rect, rhw);

    ctx.fillStyle = k.surface;
    ctx.fillRect(0, 0, rhw, this.hh);
    ctx.fillStyle = k.lineStrong;
    ctx.fillRect(0, this.hh - 1, w, 1);
    ctx.fillRect(rhw - 1, 0, 1, h);
    if (d.filters.size) {
      ctx.fillStyle = k.accent;
      this.funnel(rhw / 2 - 5, this.hh / 2 - 5);
    }
  }

  private drawCells(r0: number, r1: number, c0: number, c1: number, sel: Rect, frozen: boolean) {
    const { ctx, colors: k } = this;
    const d = this.doc!;
    const rhw = this.rowHeaderWidth();
    const right = Math.min(this.w, this.colLeft(c1) + this.cw(c1));
    const pad = this.pad;

    // 1. Backgrounds: cell fills, find matches, selection.
    for (let r = r0; r <= r1; r++) {
      const dr = d.dataRow(r);
      if (dr >= d.rows.length) break;
      const st = d.rowStyleArray(dr);
      if (!st) continue;
      const y = this.rowTop(r), rh = this.rowH(r);
      for (let c = c0; c <= Math.min(c1, st.length - 1); c++) {
        const fill = st[c] ? resolveColor(d.styles[st[c]].fill, this.theme) : null;
        if (fill) { ctx.fillStyle = fill; ctx.fillRect(this.colLeft(c), y, this.cw(c), rh); }
      }
    }
    if (this.matcher) {
      ctx.fillStyle = k.match;
      for (let r = r0; r <= r1; r++) {
        const dr = d.dataRow(r);
        if (dr >= d.rows.length) break;
        const y = this.rowTop(r), rh = this.rowH(r);
        for (let c = c0; c <= c1; c++) {
          const cw = this.cw(c);
          if (cw && this.matcher(d.display(dr, c))) ctx.fillRect(this.colLeft(c), y, cw, rh);
        }
      }
    }
    const selVisible = sel.r1 >= r0 && sel.r0 <= r1;
    const selY0 = this.rowTop(Math.max(sel.r0, r0)) - (sel.r0 < r0 ? 3 : 0);
    const selY1 = this.rowTop(Math.min(sel.r1, r1)) + this.rowH(Math.min(sel.r1, r1)) + (sel.r1 > r1 ? 3 : 0);
    const selX0 = this.colLeft(sel.c0);
    const selX1 = this.colLeft(sel.c1) + this.cw(sel.c1);
    if (selVisible && (sel.r0 !== sel.r1 || sel.c0 !== sel.c1)) {
      ctx.fillStyle = k.accentSoft;
      ctx.fillRect(selX0, selY0, selX1 - selX0, selY1 - selY0);
    }

    // 2. Text. Overflowing text hides the grid line it crosses.
    const skip = new Set<number>(); // r * 65536 + c: no vertical line after column c
    ctx.textBaseline = "middle";
    for (let r = r0; r <= r1; r++) {
      const dr = d.dataRow(r);
      if (dr >= d.rows.length) break;
      const row = d.rows[dr];
      const st = d.rowStyleArray(dr);
      const y = this.rowTop(r), rh = this.rowH(r);
      for (let c = c0; c <= Math.min(c1, row.length - 1); c++) {
        const raw = row[c];
        if (!raw) continue;
        const cw = this.cw(c);
        if (cw < 6) continue;
        const s = st && st[c] ? d.styles[st[c]] : NO_STYLE;
        const { text: full, err, numeric } = this.cellText(dr, c, raw, s);
        const ha = s.ha ?? (numeric && !frozen ? "r" : "l");
        const va = s.va ?? "m";
        const wrap = s.wrap ?? "overflow";
        const px = ptToPx(s.size ?? DEFAULT_SIZE) * this.zoom;
        const lh = Math.round(px * 1.35);
        ctx.font = this.cellFont(s, frozen);
        const x = this.colLeft(c);
        let lines: string[];
        if (wrap === "wrap") lines = this.wrapLines(full, cw - pad * 2);
        else { const nl = full.indexOf("\n"); lines = [nl >= 0 ? full.slice(0, nl) + " ↵" : full]; }

        // Work out how far the text may draw.
        let clipW = cw - 1;
        if (wrap === "overflow" && ha === "l" && !numeric) {
          const need = ctx.measureText(lines[0]).width + pad * 2;
          let cc = c;
          while (clipW < need && cc + 1 < this.ncols && this.colLeft(cc + 1) < this.w) {
            const next = row[cc + 1];
            if (next !== undefined && next !== "") break;
            skip.add(r * 65536 + cc);
            cc++;
            clipW += this.cw(cc);
          }
        }

        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, clipW, rh - 1);
        ctx.clip();
        ctx.fillStyle = err ? k.error : resolveColor(s.color, this.theme) ?? k.text;
        ctx.textAlign = ha === "r" ? "right" : ha === "c" ? "center" : "left";
        const tx = ha === "r" ? x + cw - pad : ha === "c" ? x + cw / 2 : x + pad;
        const block = lines.length * lh;
        let ty = va === "t" ? y + 4 * this.zoom + lh / 2
          : va === "b" ? y + rh - 4 * this.zoom - block + lh / 2
          : y + (rh - block) / 2 + lh / 2;
        ty += 0.5;
        for (const line of lines) {
          ctx.fillText(line, tx, ty);
          if (s.u || s.s) {
            const tw = ctx.measureText(line).width;
            const lx = ha === "r" ? tx - tw : ha === "c" ? tx - tw / 2 : tx;
            const th = Math.max(1, Math.round(px / 13));
            if (s.u) ctx.fillRect(lx, Math.round(ty + px * 0.45), tw, th);
            if (s.s) ctx.fillRect(lx, Math.round(ty), tw, th);
          }
          ty += lh;
        }
        ctx.restore();
      }
    }

    // 3. Grid lines.
    ctx.fillStyle = k.line;
    for (let r = r0; r <= r1; r++) {
      const y = this.rowTop(r) + this.rowH(r) - 1;
      ctx.fillRect(rhw, y, right - rhw, 1);
    }
    for (let c = c0; c <= c1; c++) {
      const cw = this.cw(c);
      if (!cw) continue;
      const x = this.colLeft(c) + cw - 1;
      if (!skip.size) {
        const top = frozen ? this.hh : this.bodyTop;
        const bottom = frozen ? this.hh + this.rowH(0) : Math.min(this.h, this.rowTop(r1) + this.rowH(r1));
        ctx.fillRect(x, top, 1, bottom - top);
        continue;
      }
      for (let r = r0; r <= r1; r++) {
        if (skip.has(r * 65536 + c)) continue;
        ctx.fillRect(x, this.rowTop(r), 1, this.rowH(r));
      }
    }

    // 4. Selection border + active cell.
    if (selVisible) {
      ctx.strokeStyle = k.accent;
      ctx.lineWidth = 1;
      if (sel.r0 !== sel.r1 || sel.c0 !== sel.c1) ctx.strokeRect(selX0 - 0.5, selY0 - 0.5, selX1 - selX0, selY1 - selY0);
      if (d.sel.ar >= r0 && d.sel.ar <= r1 && !this.editing) {
        const ax = this.colLeft(d.sel.ac);
        const ay = this.rowTop(d.sel.ar);
        ctx.lineWidth = 2;
        ctx.strokeRect(ax, ay, this.cw(d.sel.ac) - 1, this.rowH(d.sel.ar) - 1);
      }
    }
  }

  private drawColHeaders(c0: number, c1: number, sel: Rect, rhw: number) {
    const { ctx, colors: k, w } = this;
    const d = this.doc!;
    const hh = this.hh;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rhw, 0, w - rhw, hh);
    ctx.clip();
    ctx.fillStyle = k.surface;
    ctx.fillRect(rhw, 0, w - rhw, hh);
    const whole = sel.r0 === 0 && sel.r1 >= this.lastRow();
    ctx.font = this.fontHead;
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
      const inSel = c >= sel.c0 && c <= sel.c1;
      if (inSel) {
        ctx.fillStyle = whole ? k.accentSoft : k.accentSofter;
        ctx.fillRect(x, 0, cw, hh);
      } else if (c === this.hoverCol) {
        ctx.fillStyle = k.surface2;
        ctx.fillRect(x, 0, cw, hh);
      }
      ctx.fillStyle = inSel ? k.accentText : k.muted;
      ctx.fillText(colName(c), x + cw / 2, hh / 2 + 0.5);
      if (d.filters.has(c)) {
        ctx.fillStyle = k.accent;
        this.funnel(x + cw - 20, hh / 2 - 5);
      } else if (c === this.hoverCol && cw > 44) {
        const cx = x + cw - 14;
        if (this.hoverChevron) {
          ctx.fillStyle = k.lineStrong;
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
      ctx.fillStyle = k.line;
      ctx.fillRect(x + cw - 1, 6, 1, hh - 12);
    }
    ctx.restore();
  }

  private drawRowHeaders(r0: number, r1: number, sel: Rect, rhw: number) {
    const { ctx, colors: k, h } = this;
    const d = this.doc!;
    const draw = (r: number) => {
      const y = this.rowTop(r);
      const rh = this.rowH(r);
      const inSel = r >= sel.r0 && r <= sel.r1;
      if (inSel) {
        ctx.fillStyle = k.accentSofter;
        ctx.fillRect(0, y, rhw, rh);
      }
      ctx.fillStyle = inSel ? k.accentText : k.muted;
      ctx.fillText(String(d.dataRow(r) + 1), rhw - 10 * this.zoom, y + rh / 2 + 0.5);
      if (rh > this.rh) { ctx.fillStyle = k.line; ctx.fillRect(6, y + rh - 1, rhw - 12, 1); }
    };
    ctx.font = this.fontHead;
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, this.bodyTop, rhw, h - this.bodyTop);
    ctx.clip();
    ctx.fillStyle = k.surface;
    ctx.fillRect(0, this.bodyTop, rhw, h - this.bodyTop);
    for (let r = r0; r <= r1; r++) draw(r);
    ctx.restore();
    if (this.fb) {
      ctx.fillStyle = k.surface;
      ctx.fillRect(0, this.hh, rhw, this.rowH(0));
      draw(0);
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
    const x = this.colLeft(e.c);
    const y = this.rowTop(e.r);
    const cw = this.cw(e.c);
    const offscreen = (e.r >= this.fb && y < this.bodyTop - this.rh / 2) || y > this.h || x + cw < this.rowHeaderWidth() || x > this.w;
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
    const height = Math.max(this.rowH(e.r) + 3, nlines * lh + 10);
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
    const s = selRect(d.sel);
    const cells: { r: number; c: number; v: string }[] = [];
    const lastData = d.view ? d.view.length - 1 : d.rows.length - 1;
    for (let r = s.r0; r <= Math.min(s.r1, lastData); r++) {
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
      const r = s.ar + dr, c = this.stepCol(s.ac, dc);
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
        case " ": this.select({ ar: s.ar, ac: s.ac, fr: this.lastRow(), fc: s.fc }); break;
        default: handled = false;
      }
    } else if (!handled && sh && e.key === " ") {
      this.select({ ...s, fc: Math.max(0, d.cols - 1) });
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
          : zone === "col" ? c >= s.c0 && c <= s.c1 && s.r0 === 0 && s.r1 >= this.lastRow()
          : zone === "row" ? r >= s.r0 && r <= s.r1 : true;
        if (!inside) this.pointSelect(zone, x, y, false);
        return;
      }
      if (e.button !== 0) return;
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
      this.pointSelect(zone, x, y, e.shiftKey);
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
      if (drag) { this.dragTo(x, y); return; }
      // Hover feedback
      const rc = this.resizeColAt(x, y);
      sc.style.cursor = rc >= 0 ? "col-resize" : "default";
      const hc = y < this.hh && x >= this.rowHeaderWidth() ? this.colAt(x) : -1;
      const chev = hc >= 0 && rc < 0 && x > this.colLeft(hc) + this.cw(hc) - 24 && this.cw(hc) > 44;
      if (hc !== this.hoverCol || chev !== this.hoverChevron) {
        this.hoverCol = hc;
        this.hoverChevron = chev;
        this.invalidate();
      }
    });

    const end = (e: PointerEvent) => {
      if (this.drag?.kind === "resize") { this.doc?.remeasureAll(); this.hooks.onChange(); }
      this.drag = null;
      cancelAnimationFrame(this.autoScroll);
      this.autoScroll = 0;
      if (sc.hasPointerCapture(e.pointerId)) sc.releasePointerCapture(e.pointerId);
    };
    sc.addEventListener("pointerup", end);
    sc.addEventListener("pointercancel", end);
    sc.addEventListener("pointerleave", () => {
      if (!this.drag && this.hoverCol !== -1) { this.hoverCol = -1; this.hoverChevron = false; this.invalidate(); }
    });

    sc.addEventListener("dblclick", (e) => {
      const d = this.doc;
      if (!d) return;
      const { x, y } = this.local(e);
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
    if (!(c >= s.c0 && c <= s.c1 && s.r0 === 0 && s.r1 >= this.lastRow())) {
      this.select({ ar: 0, ac: c, fr: this.lastRow(), fc: c }, false);
    }
    this.hooks.onColumnMenu(c, x, y);
  }

  private pointSelect(zone: Zone, x: number, y: number, extend: boolean) {
    const d = this.doc!;
    const s = d.sel;
    const r = this.rowAt(y), c = this.colAt(x);
    if (zone === "corner") this.selectAll();
    else if (zone === "col") this.select(extend ? { ...s, ar: 0, fr: this.lastRow(), fc: c } : { ar: 0, ac: c, fr: this.lastRow(), fc: c }, false);
    else if (zone === "row") this.select(extend ? { ...s, ac: 0, fr: r, fc: Math.max(0, d.cols - 1) } : { ar: r, ac: 0, fr: r, fc: Math.max(0, d.cols - 1) }, false);
    else this.select(extend ? { ...s, fr: r, fc: c } : { ar: r, ac: c, fr: r, fc: c }, false);
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
      if (!this.drag || this.drag.kind === "resize") return;
      const { x, y } = this.pointer;
      const d = this.doc!;
      let dx = 0, dy = 0;
      if (y > this.scroller.clientHeight - 8) dy = (y - this.scroller.clientHeight + 8) * 1.2;
      else if (y < this.bodyTop && this.drag.kind !== "cols" && y > 0) dy = -(this.bodyTop - y) * 1.2;
      if (x > this.scroller.clientWidth - 8) dx = (x - this.scroller.clientWidth + 8);
      else if (x < this.rowHeaderWidth() && this.drag.kind !== "rows") dx = -(this.rowHeaderWidth() - x);
      if (dx || dy) {
        this.setScroll(d.scrollX + dx, d.scrollY + dy);
        this.dragTo(x, y);
      }
      this.autoScroll = requestAnimationFrame(tick);
    };
    this.autoScroll = requestAnimationFrame(tick);
  }
}

export { DEFAULT_WIDTH };
