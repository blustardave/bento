import { Delimiter, LineEnding, serialize } from "./csv";
import { Encoding } from "./encoding";
import { Engine, shiftFormula } from "./formula";
import { parseNum } from "./util";

/** Selection in *display* coordinates (what's on screen, after filtering). */
export interface Sel {
  ar: number; // active cell (the anchor)
  ac: number;
  fr: number; // the other corner of the range
  fc: number;
}

export interface Rect { r0: number; c0: number; r1: number; c1: number }

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

const MAX_UNDO = 300;
let nextId = 1;

export const DEFAULT_WIDTH = 120;

export class Doc {
  readonly id = nextId++;
  name: string;
  path: string | null;
  rows: string[][] = [];
  cols = 0;
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
  freezeHeader = true;

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
  source: import("./native").FileRef | null = null;

  readonly engine: Engine;
  private undoStack: Op[] = [];
  private redoStack: Op[] = [];
  private savedAt: Op | null = null;
  private dirtyOverride = false;
  /** Bumped on every change, so views know to redraw. */
  version = 0;

  constructor(name: string, path: string | null) {
    this.name = name;
    this.path = path;
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
    return Math.max(this.rows.length + 100, 1000);
  }

  displayCols(): number {
    return Math.max(this.cols + 5, 26);
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
    op.run();
    this.undoStack.push(op);
    if (this.undoStack.length > MAX_UNDO) {
      const dropped = this.undoStack.shift();
      if (dropped === this.savedAt) this.dirtyOverride = true;
    }
    this.redoStack = [];
    this.changed();
  }

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

  /** Set many cells at once (data coordinates) as one undoable step. */
  setCells(cells: { r: number; c: number; v: string }[], label = "Edit", selAfter?: Sel) {
    const changes: CellChange[] = [];
    for (const { r, c, v } of cells) {
      const before = this.raw(r, c);
      if (before !== v) changes.push({ r, c, before, after: v });
    }
    if (!changes.length) return;
    this.push({
      label,
      selBefore: { ...this.sel },
      selAfter,
      run: () => { for (const ch of changes) this.put(ch.r, ch.c, ch.after); },
      undo: () => { for (let i = changes.length - 1; i >= 0; i--) { const ch = changes[i]; this.put(ch.r, ch.c, ch.before); } },
    });
  }

  /** Rewrite formulas after a structural change; returns what changed. */
  private shiftFormulas(axis: "row" | "col", at: number, delta: number): CellChange[] {
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
        const pad = Math.max(0, at - this.rows.length);
        const fresh: string[][] = [];
        for (let i = 0; i < n + pad; i++) fresh.push([]);
        this.rows = [...this.rows.slice(0, at), ...fresh, ...this.rows.slice(at)];
        this.keepRows = Math.max(this.keepRows, 0) + n;
        fx = this.shiftFormulas("row", at, n);
        this.refreshView();
      },
      undo: () => { this.restore(fx); this.rows = before; this.keepRows -= n; },
    });
  }

  /** Delete data rows (any order, may be non-contiguous). */
  deleteRows(dataRows: number[]) {
    const idx = [...new Set(dataRows)].filter((r) => r < this.rows.length).sort((a, b) => b - a);
    if (!idx.length) return;
    let before: string[][] = [];
    let fx: CellChange[] = [];
    this.push({
      label: "Delete rows",
      selBefore: { ...this.sel },
      run: () => {
        before = this.rows;
        const drop = new Set(idx);
        this.rows = this.rows.filter((_, i) => !drop.has(i));
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
        const blanks = new Array<string>(n).fill("");
        for (const row of this.rows) if (row.length > at) row.splice(at, 0, ...blanks);
        if (this.cols > at || at < this.keepCols) this.cols += n;
        this.keepCols = Math.max(this.keepCols, at) + n;
        shiftMeta(1);
        fx = this.shiftFormulas("col", at, n);
      },
      undo: () => {
        this.restore(fx);
        for (const row of this.rows) if (row.length > at) row.splice(at, n);
        this.cols = oldCols;
        this.keepCols = oldKeep;
        shiftMeta(-1);
      },
    });
  }

  deleteCols(at: number, n: number) {
    let removed: (string[] | null)[] = [];
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
        oldMeta = [this.widths, this.hidden, this.filters];
        removed = this.rows.map((row) => (row.length > at ? row.splice(at, n) : null));
        this.cols = Math.max(0, this.cols - Math.max(0, Math.min(n, this.cols - at)));
        this.keepCols = Math.max(0, this.keepCols - Math.max(0, Math.min(n, this.keepCols - at)));
        const drop = (k: number) => k >= at && k < at + n;
        this.widths = shiftMap(new Map([...this.widths].filter(([k]) => !drop(k))), at + n, -n);
        this.hidden = shiftSet(new Set([...this.hidden].filter((k) => !drop(k))), at + n, -n);
        this.filters = shiftMap(new Map([...this.filters].filter(([k]) => !drop(k))), at + n, -n);
        fx = this.shiftFormulas("col", at, -n);
        this.refreshView();
      },
      undo: () => {
        this.restore(fx);
        this.rows.forEach((row, i) => { const rm = removed[i]; if (rm) row.splice(at, 0, ...rm); });
        this.cols = oldCols;
        this.keepCols = oldKeep;
        if (oldMeta) [this.widths, this.hidden, this.filters] = oldMeta;
      },
    });
  }

  /** Sort rows by a column. Numbers sort numerically, blanks always last. */
  sortBy(col: number, desc: boolean) {
    const start = this.freezeHeader ? 1 : 0;
    if (this.rows.length - start < 2) return;
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
        this.refreshView();
      },
      undo: () => { this.rows = before; },
    });
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
    if (!this.filters.size) { this.view = null; return; }
    const out: number[] = [];
    const start = this.freezeHeader ? 1 : 0;
    for (let r = 0; r < start && r < this.rows.length; r++) out.push(r);
    const fs = [...this.filters];
    outer: for (let r = start; r < this.rows.length; r++) {
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
    let cols = 0;
    for (const row of rows) if (row.length > cols) cols = row.length;
    this.cols = cols;
    this.keepRows = rows.length;
    this.keepCols = cols;
    this.undoStack = [];
    this.redoStack = [];
    this.savedAt = null;
    this.changed();
  }
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
