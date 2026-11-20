import { Delimiter, LineEnding, serialize } from "./csv";
import { Encoding } from "./encoding";
import { Engine, remapFormula, shiftFormula } from "./formula";
import { Style, isEmptyStyle, styleKey } from "./format";
import { parseNum } from "./util";

/** Selection in *display* coordinates (what's on screen, after filtering). */
export interface Sel {
  ar: number; // active cell (the anchor)
  ac: number;
  fr: number; // the other corner of the range
  fc: number;
  /** Extra ranges added with Ctrl+click (display coordinates). */
  extra?: Rect[];
}

export interface Rect { r0: number; c0: number; r1: number; c1: number }

/** Every selected range: the main one first, then any Ctrl+clicked extras. */
export function allRects(s: Sel): Rect[] {
  return [selRect(s), ...(s.extra ?? [])];
}

export function selRect(s: Sel): Rect {
  return {
    r0: Math.min(s.ar, s.fr), r1: Math.max(s.ar, s.fr),
    c0: Math.min(s.ac, s.fc), c1: Math.max(s.ac, s.fc),
  };
}

interface Op {
  label: string;
  run(): void;   // do / redo
  undo(): void;
  selBefore: Sel;
  selAfter?: Sel;
}

interface CellChange { r: number; c: number; before: string; after: string }

/** A cell edit: a new value, a new style id, or both. */
export interface CellSet { r: number; c: number; v?: string; style?: number }
interface FullChange { r: number; c: number; vb?: string; va?: string; sb?: number; sa?: number }

const NO_STYLE: Style = Object.freeze({}) as Style;

const MAX_UNDO = 300;
let nextId = 1;

export const DEFAULT_WIDTH = 100;

/* ------------------------------ floating objects ------------------------------ */

export type ChartType = "column" | "bar" | "line" | "pie";
export type ShapeType = "rect" | "round" | "ellipse" | "triangle" | "diamond" | "arrow" | "text";

interface ObjectBase {
  id: string;
  /** Top-left corner: a display cell plus an offset into it (unzoomed px). */
  r: number; c: number; dx: number; dy: number;
  /** Size in unzoomed px. */
  w: number; h: number;
}
export interface ChartObject extends ObjectBase { kind: "chart"; chart: ChartType; range: string; title?: string }
export interface ImageObject extends ObjectBase { kind: "image"; img: string }
export interface ShapeObject extends ObjectBase {
  kind: "shape"; shape: ShapeType;
  fill?: string; stroke?: string; text?: string;
  /** Text colour (palette token or hex). */
  color?: string;
}
export type SheetObject = ChartObject | ImageObject | ShapeObject;

export const newId = () => Math.random().toString(36).slice(2, 9);
const cloneObjects = (list: SheetObject[]) => list.map((o) => ({ ...o }));

export class Doc {
  readonly id = nextId++;
  /** The file this sheet belongs to. Name, path and source are the file's. */
  book: Book;
  /** This sheet's own name (shown on the tab at the bottom). */
  sheetName = "Sheet1";
  /** Tab colour (palette token or hex), if any. */
  tabColor: string | undefined;
  /** Protected sheets can't be renamed or deleted. */
  protected = false;
  /** Charts, images, shapes and text boxes floating over the grid (bottom first). */
  objects: SheetObject[] = [];
  /** Image data (data: URLs) by id, used by image objects and images in cells. */
  images = new Map<string, string>();
  get name(): string { return this.book.name; }
  set name(v: string) { this.book.name = v; }
  get path(): string | null { return this.book.path; }
  set path(v: string | null) { this.book.path = v; }
  get source(): import("./native").FileRef | null { return this.book.source; }
  set source(v: import("./native").FileRef | null) { this.book.source = v; }
  rows: string[][] = [];
  cols = 0;
  /**
   * The sheet's size: how many rows and columns it has, whether or not
   * they hold anything (like Sheets: a new sheet is 1,000 × 26). Inserting
   * and deleting rows/columns changes these.
   */
  gridRows = 1000;
  gridCols = 26;
  /** Rows/cols that belong in the saved file even if empty. */
  keepRows = 0;
  keepCols = 0;

  delim: Delimiter = ",";
  eol: LineEnding = "\r\n";
  encoding: Encoding = "utf-8";
  bom = false;
  trailingNewline = true;

  widths = new Map<number, number>();
  hidden = new Set<number>();
  /** Rows / columns pinned at the top / left. Row 0 is treated as the header when rows are frozen. */
  frozenRows = 0;
  frozenCols = 0;
  get freezeHeader(): boolean { return this.frozenRows > 0; }
  set freezeHeader(v: boolean) { this.frozenRows = v ? Math.max(1, this.frozenRows) : 0; }

  /** Per-column sets of values to hide. */
  filters = new Map<number, Set<string>>();
  /** Display row → data row. null means "no filter" (identity). */
  view: Int32Array | null = null;

  sel: Sel = { ar: 0, ac: 0, fr: 0, fc: 0 };
  scrollX = 0;
  scrollY = 0;
  loading: number | null = null;
  saveFormulasAs: "values" | "formulas" | null = null;
  /** Where the file came from, so it can be re-read with other settings. */

  /**
   * Formatting lives beside each row (keyed by the row array itself), so it
   * travels with the row through sorting, inserting and deleting.
   */
  private rowStyles = new WeakMap<string[], number[]>();
  /** Rows taller than default (wrapped text, big fonts), unzoomed px. */
  private rowHeights = new WeakMap<string[], number>();
  tallRows = 0;
  /** Heights set by hand (Resize row…), which win over measured heights. */
  private manualHeights = new WeakMap<string[], number>();
  private manualCount = 0;
  /** Rows hidden by hand (by row identity, so they survive sorting). */
  hiddenRows = new Set<string[]>();
  /** Any row not at the default height? */
  get anyTall(): boolean { return this.tallRows > 0 || this.manualCount > 0; }
  /** Merged ranges, in data coordinates. */
  merges: Rect[] = [];
  /** Style table: id → style. Id 0 is "no formatting". */
  styles: Style[] = [NO_STYLE];
  private styleIds = new Map<string, number>([["{}", 0]]);
  /** Set by the grid: measures how tall a row needs to be. */
  measureRow: ((r: number) => number) | null = null;

  readonly engine: Engine;
  private undoStack: Op[] = [];
  private redoStack: Op[] = [];
  private savedAt: Op | null = null;
  private dirtyOverride = false;
  /** Bumped on every change, so views know to redraw. */
  version = 0;

  constructor(name: string, path: string | null, book?: Book) {
    this.book = book ?? new Book(name, path);
    if (!book) this.book.sheets.push(this);
    this.engine = new Engine({ raw: (r, c) => this.raw(r, c), rowCount: () => this.rows.length });
  }

  /* ----------------------------- reading ----------------------------- */

  raw(r: number, c: number): string {
    const row = this.rows[r];
    if (!row) return "";
    const v = row[c];
    return v === undefined ? "" : v;
  }

  display(r: number, c: number): string {
    return this.engine.display(r, c);
  }

  /** Rows shown in the grid (includes spare empty rows when unfiltered). */
  displayRows(): number {
    if (this.view) return this.view.length;
    return Math.max(this.gridRows, this.rows.length);
  }

  displayCols(): number {
    return Math.max(this.gridCols, this.cols);
  }

  dataRow(d: number): number {
    if (!this.view) return d;
    return d < this.view.length ? this.view[d] : this.rows.length + (d - this.view.length);
  }

  /** Data row → display row, or -1 if it's filtered out. */
  displayRow(r: number): number {
    if (!this.view) return r;
    // view is sorted ascending, so binary search.
    let lo = 0, hi = this.view.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      const v = this.view[m];
      if (v === r) return m;
      if (v < r) lo = m + 1; else hi = m - 1;
    }
    return -1;
  }

  width(c: number): number {
    if (this.hidden.has(c)) return 0;
    return this.widths.get(c) ?? DEFAULT_WIDTH;
  }

  get dirty(): boolean {
    return this.dirtyOverride || this.top() !== this.savedAt;
  }

  markSaved() {
    this.savedAt = this.top();
    this.dirtyOverride = false;
    this.keepRows = this.rows.length;
    this.keepCols = this.cols;
    this.version++;
  }

  /** Mark as changed without an undo step (e.g. changing the save format). */
  markDirty() {
    this.dirtyOverride = true;
    this.version++;
  }

  private top(): Op | null {
    return this.undoStack.length ? this.undoStack[this.undoStack.length - 1] : null;
  }

  hasFormulas(): boolean {
    for (const row of this.rows) for (const v of row) if (v.charCodeAt(0) === 61) return true;
    return false;
  }

  /* ---------------------------- low level ---------------------------- */

  private put(r: number, c: number, v: string) {
    // Pasting past the edge makes the sheet bigger, as in Sheets.
    if (r >= this.gridRows) this.gridRows = r + 1;
    if (c >= this.gridCols) this.gridCols = c + 1;
    while (this.rows.length <= r) this.rows.push([]);
    const row = this.rows[r];
    while (row.length < c) row.push("");
    row[c] = v;
    if (v !== "" && c >= this.cols) this.cols = c + 1;
  }

  private changed() {
    this.engine.invalidate();
    this.version++;
  }

  private push(op: Op) {
    // Every step remembers the merges before and after, so undo/redo of
    // structural changes puts merged cells back exactly.
    // Floating objects too, since inserting/deleting rows moves them.
    const mBefore = this.merges.map((m) => ({ ...m }));
    const gBefore = [this.gridRows, this.gridCols];
    const oBefore = cloneObjects(this.objects);
    let mAfter: Rect[] = [];
    let gAfter = gBefore;
    let oAfter: SheetObject[] = [];
    const run = op.run, undo = op.undo;
    op.run = () => { run(); };
    op.undo = () => { undo(); this.merges = mBefore.map((m) => ({ ...m })); [this.gridRows, this.gridCols] = gBefore; this.objects = cloneObjects(oBefore); };
    op.run();
    mAfter = this.merges.map((m) => ({ ...m }));
    gAfter = [this.gridRows, this.gridCols];
    oAfter = cloneObjects(this.objects);
    op.run = () => { run(); this.merges = mAfter.map((m) => ({ ...m })); [this.gridRows, this.gridCols] = gAfter; this.objects = cloneObjects(oAfter); };
    this.undoStack.push(op);
    if (this.undoStack.length > MAX_UNDO) {
      const dropped = this.undoStack.shift();
      if (dropped === this.savedAt) this.dirtyOverride = true;
    }
    this.redoStack = [];
    this.changed();
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  undo(): Sel | null {
    const op = this.undoStack.pop();
    if (!op) return null;
    op.undo();
    this.redoStack.push(op);
    this.refreshView();
    this.changed();
    return op.selBefore;
  }

  redo(): Sel | null {
    const op = this.redoStack.pop();
    if (!op) return null;
    op.run();
    this.undoStack.push(op);
    this.refreshView();
    this.changed();
    return op.selAfter ?? op.selBefore;
  }

  /* ------------------------------ edits ------------------------------ */

  /** Set many cells' values and/or styles (data coordinates) as one undoable step. */
  setCells(cells: CellSet[], label = "Edit", selAfter?: Sel) {
    const changes: FullChange[] = [];
    for (const { r, c, v, style } of cells) {
      const ch: FullChange = { r, c };
      let any = false;
      if (v !== undefined) { const before = this.raw(r, c); if (before !== v) { ch.vb = before; ch.va = v; any = true; } }
      if (style !== undefined) { const before = this.styleId(r, c); if (before !== style) { ch.sb = before; ch.sa = style; any = true; } }
      if (any) changes.push(ch);
    }
    if (!changes.length) return;
    const remeasure = () => this.remeasure(changes.filter((ch) =>
      ch.sa !== undefined || this.styleId(ch.r, ch.c) !== 0 || ch.va?.includes("\n") || ch.vb?.includes("\n")).map((ch) => ch.r));
    this.push({
      label,
      selBefore: { ...this.sel },
      selAfter,
      run: () => {
        for (const ch of changes) {
          if (ch.va !== undefined) this.put(ch.r, ch.c, ch.va);
          if (ch.sa !== undefined) this.putStyle(ch.r, ch.c, ch.sa);
        }
        remeasure();
      },
      undo: () => {
        for (let i = changes.length - 1; i >= 0; i--) {
          const ch = changes[i];
          if (ch.vb !== undefined) this.put(ch.r, ch.c, ch.vb);
          if (ch.sb !== undefined) this.putStyle(ch.r, ch.c, ch.sb);
        }
        remeasure();
      },
    });
  }

  /**
   * Record a change to the floating objects as one undo step. `before` is a
   * snapshot taken before the change; the current list is the "after".
   */
  commitObjects(before: SheetObject[], label = "Edit object") {
    const after = cloneObjects(this.objects);
    if (JSON.stringify(after) === JSON.stringify(before)) return;
    const b = cloneObjects(before);
    this.push({
      label,
      selBefore: { ...this.sel },
      run: () => { this.objects = cloneObjects(after); },
      undo: () => { this.objects = cloneObjects(b); },
    });
  }

  snapshotObjects(): SheetObject[] { return cloneObjects(this.objects); }

  /** Store image data, returning its id (the same data gets the same id). */
  addImage(url: string): string {
    for (const [id, u] of this.images) if (u === url) return id;
    const id = newId();
    this.images.set(id, url);
    return id;
  }

  /* ----------------------------- formatting ----------------------------- */

  styleId(r: number, c: number): number {
    const row = this.rows[r];
    if (!row) return 0;
    const st = this.rowStyles.get(row);
    return st ? st[c] ?? 0 : 0;
  }

  style(r: number, c: number): Style {
    return this.styles[this.styleId(r, c)] ?? NO_STYLE;
  }

  /** The style's id in this sheet's table (adding it if new). */
  intern(s: Style): number {
    if (isEmptyStyle(s)) return 0;
    const k = styleKey(s);
    let id = this.styleIds.get(k);
    if (id === undefined) {
      id = this.styles.length;
      this.styles.push(JSON.parse(k));
      this.styleIds.set(k, id);
    }
    return id;
  }

  /** Change formatting of the given data cells with `patch`, as one undo step. */
  format(cells: { r: number; c: number }[], patch: (s: Style) => Style, label = "Format") {
    const cache = new Map<number, number>();
    const sets: CellSet[] = [];
    for (const { r, c } of cells) {
      const cur = this.styleId(r, c);
      let next = cache.get(cur);
      if (next === undefined) {
        const p = patch({ ...this.styles[cur] });
        for (const k of Object.keys(p) as (keyof Style)[]) if (p[k] === undefined) delete p[k];
        next = this.intern(p);
        cache.set(cur, next);
      }
      sets.push({ r, c, style: next });
    }
    this.setCells(sets, label);
  }

  hasFormatting(): boolean {
    if (this.objects.length) return true;
    for (const row of this.rows) { const st = this.rowStyles.get(row); if (st && st.some((x) => x)) return true; }
    return false;
  }

  private putStyle(r: number, c: number, id: number) {
    while (this.rows.length <= r) this.rows.push([]);
    const row = this.rows[r];
    let st = this.rowStyles.get(row);
    if (!st) { if (!id) return; st = []; this.rowStyles.set(row, st); }
    while (st.length < c) st.push(0);
    st[c] = id;
  }

  /** Style ids for a row (read-only use), if it has any. */
  rowStyleArray(r: number): number[] | undefined {
    const row = this.rows[r];
    return row ? this.rowStyles.get(row) : undefined;
  }

  setRowStyleArray(r: number, st: number[]) {
    while (this.rows.length <= r) this.rows.push([]);
    this.rowStyles.set(this.rows[r], st);
  }

  /** Height of a data row in unzoomed px (0 = default). */
  rowHeight(r: number): number {
    const row = this.rows[r];
    return row ? this.manualHeights.get(row) ?? this.rowHeights.get(row) ?? 0 : 0;
  }

  /** A hand-set height, if any. */
  manualHeight(r: number): number | undefined {
    const row = this.rows[r];
    return row ? this.manualHeights.get(row) : undefined;
  }

  private putManual(row: string[], h: number | undefined) {
    const had = this.manualHeights.has(row);
    if (h === undefined) { if (had) { this.manualHeights.delete(row); this.manualCount--; } }
    else { if (!had) this.manualCount++; this.manualHeights.set(row, h); }
  }

  /** Set (or with null, clear) the height of some data rows, as one undo step. */
  setRowHeights(rows: number[], h: number | null, label = "Resize rows") {
    while (this.rows.length <= Math.max(...rows)) this.rows.push(new Array(this.cols).fill(""));
    const targets = rows.map((r) => this.rows[r]);
    const before = targets.map((row) => this.manualHeights.get(row));
    this.push({
      label,
      selBefore: { ...this.sel },
      run: () => { for (const row of targets) this.putManual(row, h ?? undefined); this.version++; },
      undo: () => { targets.forEach((row, i) => this.putManual(row, before[i])); this.version++; },
    });
  }

  /** Hide or show data rows, as one undo step. */
  setRowsHidden(rows: number[] | "all", hide: boolean) {
    const targets = rows === "all" ? [...this.hiddenRows] : rows.map((r) => this.rows[r]).filter(Boolean);
    const was = targets.map((row) => this.hiddenRows.has(row));
    const apply = (on: (i: number) => boolean) => {
      targets.forEach((row, i) => { if (on(i)) this.hiddenRows.add(row); else this.hiddenRows.delete(row); });
      this.refreshView();
      this.version++;
    };
    this.push({
      label: hide ? "Hide rows" : "Unhide rows",
      selBefore: { ...this.sel },
      run: () => apply(() => hide),
      undo: () => apply((i) => was[i]),
    });
  }

  /** For saving: hand-set heights and hidden rows, by row index. */
  rowMeta(): { heights: [number, number][]; hidden: number[] } {
    const heights: [number, number][] = [], hidden: number[] = [];
    if (!this.manualCount && !this.hiddenRows.size) return { heights, hidden };
    this.rows.forEach((row, r) => {
      const h = this.manualHeights.get(row);
      if (h !== undefined) heights.push([r, h]);
      if (this.hiddenRows.has(row)) hidden.push(r);
    });
    return { heights, hidden };
  }

  /** For loading (not undoable). */
  setRowMeta(heights: [number, number][], hidden: number[]) {
    for (const [r, h] of heights) if (this.rows[r]) this.putManual(this.rows[r], h);
    for (const r of hidden) if (this.rows[r]) this.hiddenRows.add(this.rows[r]);
    this.refreshView();
  }

  /** How many hidden rows are still part of the sheet. */
  hiddenRowCount(): number {
    if (!this.hiddenRows.size) return 0;
    let n = 0;
    for (const row of this.rows) if (this.hiddenRows.has(row)) n++;
    return n;
  }

  /** Re-measure rows whose content or formatting changed. */
  remeasure(rows: Iterable<number>) {
    if (!this.measureRow) return;
    for (const r of new Set(rows)) {
      const row = this.rows[r];
      if (!row) continue;
      const h = this.measureRow(r);
      const had = this.rowHeights.has(row);
      if (h > 0) { if (!had) this.tallRows++; this.rowHeights.set(row, h); }
      else if (had) { this.tallRows--; this.rowHeights.delete(row); }
    }
  }

  /** Re-measure every formatted row (after a column resize or on load). */
  remeasureAll() {
    const rows: number[] = [];
    for (let r = 0; r < this.rows.length; r++) {
      const row = this.rows[r];
      if (this.rowStyles.has(row) || row.some((v) => v.includes("\n"))) rows.push(r);
    }
    this.remeasure(rows);
    this.version++;
  }

  /* ------------------------------- merges ------------------------------- */

  /** The merged range containing a data cell, if any. */
  mergeAt(r: number, c: number): Rect | null {
    for (const m of this.merges) if (r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1) return m;
    return null;
  }

  /** Merge a data range: keeps the top-left value, clears the rest. */
  merge(rect: Rect) {
    if (rect.r0 === rect.r1 && rect.c0 === rect.c1) return;
    const cleared: { r: number; c: number; v: string }[] = [];
    for (let r = rect.r0; r <= rect.r1; r++) for (let c = rect.c0; c <= rect.c1; c++) {
      if (r === rect.r0 && c === rect.c0) continue;
      const v = this.raw(r, c);
      if (v !== "") cleared.push({ r, c, v });
    }
    this.push({
      label: "Merge cells",
      selBefore: { ...this.sel },
      run: () => {
        this.merges = this.merges.filter((m) => !overlaps(m, rect));
        this.merges.push({ ...rect });
        for (const { r, c } of cleared) this.put(r, c, "");
      },
      undo: () => { for (const { r, c, v } of cleared) this.put(r, c, v); },
    });
  }

  /** Remove merges that touch a data range. */
  unmerge(rect: Rect) {
    if (!this.merges.some((m) => overlaps(m, rect))) return;
    this.push({
      label: "Unmerge cells",
      selBefore: { ...this.sel },
      run: () => { this.merges = this.merges.filter((m) => !overlaps(m, rect)); },
      undo: () => {},
    });
  }

  /** Re-map merges through a row/column index change (kept → new index, removed → -1). */
  private remapMerges(axis: "row" | "col", map: (i: number) => number) {
    const out: Rect[] = [];
    for (const m of this.merges) {
      const a0 = axis === "row" ? m.r0 : m.c0, a1 = axis === "row" ? m.r1 : m.c1;
      let n0 = -1, n1 = -1;
      for (let i = a0; i <= a1; i++) { const j = map(i); if (j >= 0) { if (n0 < 0) n0 = j; n1 = j; } }
      if (n0 < 0) continue;
      const nm = axis === "row" ? { ...m, r0: n0, r1: n1 } : { ...m, c0: n0, c1: n1 };
      if (nm.r0 === nm.r1 && nm.c0 === nm.c1) continue;
      out.push(nm);
    }
    this.merges = out;
  }

  /** Rewrite formulas after a structural change; returns what changed. */
  private shiftFormulas(axis: "row" | "col", at: number, delta: number): CellChange[] {
    this.shiftObjects(axis, at, delta);
    const out: CellChange[] = [];
    const rows = this.rows;
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      for (let c = 0; c < row.length; c++) {
        const v = row[c];
        if (v.charCodeAt(0) !== 61) continue;
        const nv = shiftFormula(v, axis, at, delta);
        if (nv !== v) { out.push({ r, c, before: v, after: nv }); row[c] = nv; }
      }
    }
    return out;
  }

  /* --------------------------- moving rows / columns --------------------------- */

  /** Where index i ends up when the block [from, from+n) is moved to start at `to`. */
  static movedIndex(i: number, from: number, n: number, to: number): number {
    if (i >= from && i < from + n) return to + (i - from);
    let j = i >= from + n ? i - n : i;
    if (j >= to) j += n;
    return j;
  }

  /** Can this block move without splitting a merged cell? */
  canMove(axis: "row" | "col", from: number, n: number, to: number): boolean {
    const lo = Math.min(from, to), hi = Math.max(from + n, to + n) - 1;
    return !this.merges.some((m) => {
      const a = axis === "col" ? m.c0 : m.r0, b = axis === "col" ? m.c1 : m.r1;
      return b >= lo && a <= hi;
    }) && !(axis === "row" && this.filters.size);
  }

  /** Reorder columns/rows in place (no undo; see moveBlock). */
  applyMove(axis: "row" | "col", from: number, n: number, to: number) {
    if (from === to || n <= 0) return;
    const map = (i: number) => Doc.movedIndex(i, from, n, to);
    const end = Math.max(from, to) + n;
    if (axis === "col") {
      let longest = 0;
      for (const row of this.rows) {
        if (row.length > Math.min(from, to)) {
          while (row.length < end) row.push("");
          longest = Math.max(longest, row.length);
          const block = row.splice(from, n);
          row.splice(to, 0, ...block);
        }
        const st = this.rowStyles.get(row);
        if (st && st.length > Math.min(from, to)) {
          while (st.length < end) st.push(0);
          const b = st.splice(from, n);
          st.splice(to, 0, ...b);
        }
      }
      this.cols = Math.max(this.cols, longest);
      this.widths = new Map([...this.widths].map(([k, v]) => [map(k), v]));
      this.hidden = new Set([...this.hidden].map(map));
      this.filters = new Map([...this.filters].map(([k, v]) => [map(k), v]));
    } else {
      while (this.rows.length < end) this.rows.push(new Array(this.cols).fill(""));
      const block = this.rows.splice(from, n);
      this.rows.splice(to, 0, ...block);
    }
    for (const row of this.rows) for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (v.charCodeAt(0) === 61) row[c] = remapFormula(v, axis, map);
    }
    for (const o of this.objects) {
      if (axis === "col") o.c = map(o.c); else o.r = map(o.r);
      if (o.kind === "chart") o.range = remapFormula("=" + o.range, axis, map).slice(1);
    }
    this.refreshView();
    this.changed();
  }

  /** Record a move that has already been shown live (state is back at the start). */
  moveBlock(axis: "row" | "col", from: number, n: number, to: number, selAfter: Sel) {
    if (from === to) return;
    this.push({
      label: axis === "col" ? "Move columns" : "Move rows",
      selBefore: { ...this.sel },
      selAfter,
      run: () => this.applyMove(axis, from, n, to),
      undo: () => this.applyMove(axis, to, n, from),
    });
  }

  /** Objects below/right of inserted or deleted rows/columns move with the cells; chart ranges follow. */
  private shiftObjects(axis: "row" | "col", at: number, delta: number) {
    for (const o of this.objects) {
      const k = axis === "row" ? "r" : "c";
      if (delta > 0 && o[k] >= at) o[k] += delta;
      else if (delta < 0 && o[k] >= at) {
        if (o[k] < at - delta) { o[k] = at; if (axis === "row") o.dy = 0; else o.dx = 0; }
        else o[k] += delta;
      }
      if (o.kind === "chart") {
        const next = shiftFormula("=" + o.range, axis, at, delta).slice(1);
        if (!next.includes("#")) o.range = next;
      }
    }
  }

  private restore(changes: CellChange[]) {
    for (let i = changes.length - 1; i >= 0; i--) {
      const ch = changes[i];
      this.rows[ch.r][ch.c] = ch.before;
    }
  }

  insertRows(at: number, n: number) {
    let before: string[][] = [];
    let fx: CellChange[] = [];
    this.push({
      label: "Insert rows",
      selBefore: { ...this.sel },
      run: () => {
        before = this.rows;
        this.gridRows = Math.max(this.gridRows, this.rows.length) + n;
        if (at >= this.rows.length) { fx = []; return; } // below the data: the sheet just gets longer
        const fresh: string[][] = [];
        for (let i = 0; i < n; i++) fresh.push([]);
        this.rows = [...this.rows.slice(0, at), ...fresh, ...this.rows.slice(at)];
        this.keepRows = Math.max(this.keepRows, 0) + n;
        fx = this.shiftFormulas("row", at, n);
        this.merges = this.merges.map((m) => m.r0 >= at ? { ...m, r0: m.r0 + n, r1: m.r1 + n } : m.r1 >= at ? { ...m, r1: m.r1 + n } : m);
        this.refreshView();
      },
      undo: () => { this.restore(fx); if (this.rows !== before) { this.rows = before; this.keepRows -= n; } },
    });
  }

  /** Delete data rows (any order, may be non-contiguous). */
  deleteRows(dataRows: number[]) {
    const all = new Set(dataRows);
    if (!all.size) return;
    const idx = [...all].filter((r) => r < this.rows.length).sort((a, b) => b - a);
    let before: string[][] = [];
    let fx: CellChange[] = [];
    this.push({
      label: "Delete rows",
      selBefore: { ...this.sel },
      run: () => {
        before = this.rows;
        // The sheet loses these rows even if they were empty.
        this.gridRows = Math.max(1, Math.max(this.gridRows, this.rows.length) - all.size);
        const drop = new Set(idx);
        this.rows = this.rows.filter((_, i) => !drop.has(i));
        const asc = [...idx].reverse();
        this.remapMerges("row", (i) => {
          if (drop.has(i)) return -1;
          let lo = 0, hi = asc.length; // count deleted rows below i
          while (lo < hi) { const m = (lo + hi) >> 1; if (asc[m] < i) lo = m + 1; else hi = m; }
          return i - lo;
        });
        this.keepRows = Math.max(0, this.keepRows - idx.length);
        // Shift formula refs one contiguous block at a time, from the bottom up.
        fx = [];
        let i = 0;
        while (i < idx.length) {
          let j = i;
          while (j + 1 < idx.length && idx[j + 1] === idx[j] - 1) j++;
          const start = idx[j];
          const count = j - i + 1;
          fx.push(...this.shiftFormulas("row", start, -count));
          i = j + 1;
        }
        this.refreshView();
      },
      undo: () => { this.restore(fx); this.rows = before; this.keepRows += idx.length; },
    });
  }

  insertCols(at: number, n: number) {
    let fx: CellChange[] = [];
    let oldCols = 0;
    let oldKeep = 0;
    const shiftMeta = (dir: 1 | -1) => {
      this.widths = shiftMap(this.widths, at, dir * n);
      this.hidden = shiftSet(this.hidden, at, dir * n);
      this.filters = shiftMap(this.filters, at, dir * n);
    };
    this.push({
      label: "Insert columns",
      selBefore: { ...this.sel },
      run: () => {
        oldCols = this.cols;
        oldKeep = this.keepCols;
        this.gridCols = Math.max(this.gridCols, this.cols) + n;
        const blanks = new Array<string>(n).fill("");
        const zeros = new Array<number>(n).fill(0);
        for (const row of this.rows) {
          if (row.length > at) row.splice(at, 0, ...blanks);
          const st = this.rowStyles.get(row);
          if (st && st.length > at) st.splice(at, 0, ...zeros);
        }
        if (this.cols > at || at < this.keepCols) this.cols += n;
        this.keepCols = Math.max(this.keepCols, at) + n;
        shiftMeta(1);
        fx = this.shiftFormulas("col", at, n);
        this.merges = this.merges.map((m) => m.c0 >= at ? { ...m, c0: m.c0 + n, c1: m.c1 + n } : m.c1 >= at ? { ...m, c1: m.c1 + n } : m);
      },
      undo: () => {
        this.restore(fx);
        for (const row of this.rows) {
          if (row.length > at) row.splice(at, n);
          const st = this.rowStyles.get(row);
          if (st && st.length > at) st.splice(at, n);
        }
        this.cols = oldCols;
        this.keepCols = oldKeep;
        shiftMeta(-1);
      },
    });
  }

  deleteCols(at: number, n: number) {
    let removed: (string[] | null)[] = [];
    let removedSt: (number[] | null)[] = [];
    let fx: CellChange[] = [];
    let oldCols = 0;
    let oldKeep = 0;
    let oldMeta: [Map<number, number>, Set<number>, Map<number, Set<string>>] | null = null;
    this.push({
      label: "Delete columns",
      selBefore: { ...this.sel },
      run: () => {
        oldCols = this.cols;
        oldKeep = this.keepCols;
        this.gridCols = Math.max(1, Math.max(this.gridCols, this.cols) - n);
        oldMeta = [this.widths, this.hidden, this.filters];
        removed = this.rows.map((row) => (row.length > at ? row.splice(at, n) : null));
        removedSt = this.rows.map((row) => { const st = this.rowStyles.get(row); return st && st.length > at ? st.splice(at, n) : null; });
        this.cols = Math.max(0, this.cols - Math.max(0, Math.min(n, this.cols - at)));
        this.keepCols = Math.max(0, this.keepCols - Math.max(0, Math.min(n, this.keepCols - at)));
        const drop = (k: number) => k >= at && k < at + n;
        this.widths = shiftMap(new Map([...this.widths].filter(([k]) => !drop(k))), at + n, -n);
        this.hidden = shiftSet(new Set([...this.hidden].filter((k) => !drop(k))), at + n, -n);
        this.filters = shiftMap(new Map([...this.filters].filter(([k]) => !drop(k))), at + n, -n);
        fx = this.shiftFormulas("col", at, -n);
        this.remapMerges("col", (i) => (i < at ? i : i < at + n ? -1 : i - n));
        this.refreshView();
      },
      undo: () => {
        this.restore(fx);
        this.rows.forEach((row, i) => {
          const rm = removed[i]; if (rm) row.splice(at, 0, ...rm);
          const rs = removedSt[i]; if (rs) this.rowStyles.get(row)!.splice(at, 0, ...rs);
        });
        this.cols = oldCols;
        this.keepCols = oldKeep;
        if (oldMeta) [this.widths, this.hidden, this.filters] = oldMeta;
      },
    });
  }

  /** Sort rows by a column. Numbers sort numerically, blanks always last. */
  /** Returns false (and does nothing) if merged cells span rows in the sorted area. */
  sortBy(col: number, desc: boolean): boolean {
    const start = this.frozenRows;
    if (this.rows.length - start < 2) return true;
    if (this.merges.some((m) => m.r1 >= start && m.r1 > m.r0)) return false;
    let before: string[][] = [];
    this.push({
      label: "Sort",
      selBefore: { ...this.sel },
      run: () => {
        before = this.rows;
        const body = this.rows.slice(start);
        const keys = body.map((row, i) => {
          const disp = row[col] === undefined ? "" : row[col].charCodeAt(0) === 61 ? this.engine.display(i + start, col) : row[col];
          const n = parseNum(disp);
          return { row, s: disp, n, blank: disp === "" };
        });
        const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
        const dir = desc ? -1 : 1;
        keys.sort((a, b) => {
          if (a.blank !== b.blank) return a.blank ? 1 : -1;
          const an = !Number.isNaN(a.n), bn = !Number.isNaN(b.n);
          if (an && bn) return (a.n - b.n) * dir;
          if (an !== bn) return (an ? -1 : 1) * dir; // numbers before text (ascending)
          return coll.compare(a.s, b.s) * dir;
        });
        this.rows = [...this.rows.slice(0, start), ...keys.map((k) => k.row)];
        // Single-row merges travel with their rows.
        if (this.merges.length) {
          const pos = new Map<string[], number>();
          this.rows.forEach((row, i) => pos.set(row, i));
          this.merges = this.merges.map((m) => {
            if (m.r0 < start) return m;
            const r = pos.get(before[m.r0]) ?? m.r0;
            return { ...m, r0: r, r1: r };
          });
        }
        this.refreshView();
      },
      undo: () => { this.rows = before; },
    });
    return true;
  }

  /** Freeze the first `rows` rows and `cols` columns. */
  setFrozen(rows: number, cols: number) {
    if (rows === this.frozenRows && cols === this.frozenCols) return;
    this.frozenRows = Math.max(0, rows);
    this.frozenCols = Math.max(0, cols);
    this.refreshView();
    this.markDirty();
  }

  /* ----------------------------- filters ----------------------------- */

  setFilter(col: number, hiddenValues: Set<string> | null) {
    if (hiddenValues && hiddenValues.size) this.filters.set(col, hiddenValues);
    else this.filters.delete(col);
    this.refreshView();
    this.version++;
  }

  clearFilters() {
    this.filters.clear();
    this.refreshView();
    this.version++;
  }

  refreshView() {
    const hid = this.hiddenRows;
    if (!this.filters.size && !hid.size) { this.view = null; return; }
    const out: number[] = [];
    const start = this.frozenRows;
    for (let r = 0; r < start && r < this.rows.length; r++) if (!hid.has(this.rows[r])) out.push(r);
    const fs = [...this.filters];
    outer: for (let r = start; r < this.rows.length; r++) {
      if (hid.size && hid.has(this.rows[r])) continue;
      for (const [c, hide] of fs) if (hide.has(this.display(r, c))) continue outer;
      out.push(r);
    }
    this.view = Int32Array.from(out);
  }

  /* ------------------------------ saving ----------------------------- */

  toText(asValues: boolean): string {
    // Trim empty rows/columns that only exist because someone typed then cleared.
    let rowCount = this.rows.length;
    while (rowCount > this.keepRows && this.rows[rowCount - 1].every((v) => v === "")) rowCount--;
    let colCount = this.cols;
    while (colCount > this.keepCols && colCount > 0) {
      const c = colCount - 1;
      let empty = true;
      for (let r = 0; r < rowCount; r++) if (this.raw(r, c) !== "") { empty = false; break; }
      if (!empty) break;
      colCount--;
    }
    const get = asValues ? (r: number, c: number) => this.display(r, c) : (r: number, c: number) => this.raw(r, c);
    return serialize(rowCount, colCount, get, this.delim, this.eol, this.trailingNewline);
  }

  /** Load parsed rows (from a file). Not undoable. */
  load(rows: string[][]) {
    this.rows = rows;
    this.rowStyles = new WeakMap();
    this.rowHeights = new WeakMap();
    this.tallRows = 0;
    this.manualHeights = new WeakMap();
    this.manualCount = 0;
    this.hiddenRows = new Set();
    this.styles = [NO_STYLE];
    this.styleIds = new Map([["{}", 0]]);
    this.merges = [];
    let cols = 0;
    for (const row of rows) if (row.length > cols) cols = row.length;
    this.cols = cols;
    this.gridRows = Math.max(1000, rows.length + 100);
    this.gridCols = Math.max(26, cols);
    this.keepRows = rows.length;
    this.keepCols = cols;
    this.undoStack = [];
    this.redoStack = [];
    this.savedAt = null;
    this.changed();
  }
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.r0 <= b.r1 && b.r0 <= a.r1 && a.c0 <= b.c1 && b.c0 <= a.c1;
}

function shiftMap<V>(m: Map<number, V>, at: number, delta: number): Map<number, V> {
  const out = new Map<number, V>();
  for (const [k, v] of m) out.set(k >= at ? k + delta : k, v);
  return out;
}

function shiftSet(s: Set<number>, at: number, delta: number): Set<number> {
  const out = new Set<number>();
  for (const k of s) out.add(k >= at ? k + delta : k);
  return out;
}


/** A file: one or more sheets, plus the file's name and location. */
export class Book {
  /** Stable id for this open file (names its crash-recovery copy). */
  id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  name: string;
  path: string | null;
  source: import("./native").FileRef | null = null;
  sheets: Doc[] = [];
  current = 0;
  /** Sheets added, removed, renamed or reordered since the last save. */
  structureDirty = false;

  constructor(name: string, path: string | null) {
    this.name = name;
    this.path = path;
  }

  get sheet(): Doc { return this.sheets[this.current]; }

  /** Changes whenever anything in the file changes (for AutoSave). */
  get token(): string {
    return this.sheets.map((s) => `${s.sheetName}:${s.version}`).join("|") + `|${this.structureDirty}`;
  }

  get dirty(): boolean {
    return this.structureDirty || this.sheets.some((s) => s.dirty);
  }

  markSaved() {
    this.structureDirty = false;
    for (const s of this.sheets) s.markSaved();
  }

  /** A sheet name not already taken: "Sheet2", "Sheet3"… */
  freshName(base = "Sheet"): string {
    const taken = new Set(this.sheets.map((s) => s.sheetName.toLowerCase()));
    for (let i = 1; ; i++) { const n = `${base}${i}`; if (!taken.has(n.toLowerCase())) return n; }
  }
}
