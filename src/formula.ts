/* ------------------------------------------------------------------ *
 * The formula engine: evaluates cells (with caching), references to
 * other sheets, defined names, LET/LAMBDA, and dynamic arrays that
 * spill into the cells next to them.
 * ------------------------------------------------------------------ */
import {
  Any, ArrV, ERR, Env, FErr, LamV, Node, RefV, Val, EngineLike,
  at, dims, formatNumber, isArr, isErr, isLam, isMulti, isOmit, isRef, literal, lookupEnv, parse, rewriteRefs,
  scalar, toArr, toNum, toStr, compareOp, COMPARE_OPS, OMIT, dateOf, sheetPrefix, tokenize,
} from "./fcore";
import type { Ctx } from "./functions";
import { FUNCS } from "./library";
import { colName, pushAll } from "./util";

export { FErr, formatNumber };
export type { Val };
export { FUNCS, FUNCTION_NAMES } from "./library";

export interface Host {
  raw(r: number, c: number): string;
  rowCount(): number;
  colCount?(): number;
  sheetName?(): string;
  /** Another sheet of the same file, by name (any case). */
  sheet?(name: string): Engine | null;
  /** A defined name's formula text (without "="), e.g. "Sheet1!$A$2:$A$40". */
  definedName?(name: string): string | undefined;
  /** Names of all sheets in the file, in order. */
  sheetNames?(): string[];
  /** Every formula cell, for finding spills and dependents. */
  formulas?(): Iterable<[number, number]>;
}

export interface Rect { r: number; c: number; h: number; w: number }
export interface RefInfo { sheet?: string; r1: number; c1: number; r2: number; c2: number; s: number; e: number }

const KEY = 65536;
const MAX_SPILL = 2_000_000;

/**
 * Formulas that read formulas that read formulas… (a running total down
 * 10,000 rows) would overflow the JavaScript stack if worked out by plain
 * recursion. So recursion through cells is capped: past DEPTH_LIMIT the
 * engine stops, works out the deepest cell on its own first, and tries
 * again. Each retry starts from a cached result, so the total work stays
 * about the same while the stack never grows past the cap.
 */
const DEPTH_LIMIT = 120;
const depth = { n: 0 };

/** Thrown (internally) when a chain of cells gets too deep: "work this one out first". */
class TooDeep {
  constructor(readonly eng: Engine, readonly r: number, readonly c: number) {}
}

/** Run a top-level calculation, settling any too-deep chains it runs into. */
function settled<T>(fn: () => T): T {
  for (;;) {
    try { return fn(); } catch (e) {
      if (!(e instanceof TooDeep)) throw e;
      // Work down the chain, deepest first, without letting the stack grow.
      const work: TooDeep[] = [e];
      const onStack = new Set<string>([e.eng.uid + ":" + (e.r * KEY + e.c)]);
      while (work.length) {
        const w = work[work.length - 1];
        try { w.eng.compute(w.r, w.c); work.pop(); onStack.delete(w.eng.uid + ":" + (w.r * KEY + w.c)); }
        catch (e2) {
          if (!(e2 instanceof TooDeep)) throw e2;
          const id = e2.eng.uid + ":" + (e2.r * KEY + e2.c);
          // Back to a cell we're already waiting on: a (long) circular reference.
          if (onStack.has(id)) e2.eng.markCircular(e2.r, e2.c);
          else { onStack.add(id); work.push(e2); }
        }
      }
    }
  }
}

let engineIds = 0;

export class Engine implements EngineLike {
  private results = new Map<number, Val | ArrV>();
  private active = new Set<number>();
  private asts = new Map<string, Node | FErr>();
  private spills = new Map<number, Rect>();
  private spillsReady = false;
  private building = false;
  private candidates: Set<number> | null = null;
  private namesBusy = new Set<string>();
  /** Can this formula give an array? By formula text (cheap to keep, unlike ASTs). */
  private arrayish = new Map<string, boolean>();
  readonly uid = ++engineIds;

  constructor(private readonly host: Host) {}

  /* ------------------------------ bookkeeping ------------------------------ */

  invalidate() {
    this.results.clear();
    this.spillsReady = false;
  }

  /** Rows/columns moved: forget which cells might spill. */
  structureChanged() {
    this.candidates = null;
    this.invalidate();
  }

  /** Defined names changed: whether formulas can spill may have changed too. */
  namesChanged() {
    this.arrayish.clear();
    this.structureChanged();
  }

  /** A cell's text changed (keeps the list of possible spills current). */
  noteCell(r: number, c: number, raw: string) {
    if (!this.candidates) return;
    const key = r * KEY + c;
    if (raw.charCodeAt(0) === 61 && this.mayGiveArray(raw)) { this.candidates.add(key); return; }
    this.candidates.delete(key);
  }

  private mayGiveArray(raw: string): boolean {
    let v = this.arrayish.get(raw);
    if (v === undefined) {
      const ast = this.compile(raw);
      v = !isErr(ast) && mayArray(ast, (name) => this.nameMayArray(name));
      if (this.arrayish.size > 500_000) this.arrayish.clear();
      this.arrayish.set(raw, v);
    }
    return v;
  }

  /** Could a defined name stand for more than one cell? (A name for one cell can't spill.) */
  private nameMayArray(name: string, seen = new Set<string>()): boolean {
    const text = this.host.definedName?.(name);
    if (text === undefined) return true; // a LET variable or LAMBDA parameter: can't tell
    if (seen.has(name) || seen.size > 8) return true;
    seen.add(name);
    const ast = this.compile("=" + text);
    return isErr(ast) || mayArray(ast, (n) => this.nameMayArray(n, seen));
  }

  rowCount() { return Math.max(1, this.host.rowCount()); }
  rawAt(r: number, c: number) { return this.host.raw(r, c); }
  colCount() { return Math.max(1, this.host.colCount?.() ?? 26); }
  sheetName() { return this.host.sheetName?.() ?? ""; }

  /* ------------------------------- reading ------------------------------- */

  /** The value a cell shows: a literal for normal text, a result for formulas, or part of a spill. */
  value(r: number, c: number): Val {
    const raw = this.host.raw(r, c);
    if (raw === "") { const s = this.spilled(r, c); return s === undefined ? "" : s; }
    if (raw.charCodeAt(0) !== 61) return literal(raw);
    // Text that can't be a formula at all ("=== Totals ===" in a CSV) is just text.
    if (this.unparseable(raw)) return raw;
    const res = this.result(r, c, raw);
    if (isArr(res)) return this.blocked(r, c, res) ? ERR.spill : res.v[0][0];
    return res;
  }

  /** Text for the cell, as the grid shows it. */
  display(r: number, c: number): string {
    const raw = this.host.raw(r, c);
    if (raw === "") {
      const s = this.spilled(r, c);
      if (s === undefined) return "";
      const a = this.spillAnchor(r, c);
      return a ? this.show(s, this.dateKind(a.r, a.c)) : toStr(s);
    }
    if (raw.charCodeAt(0) !== 61 || this.unparseable(raw)) return raw;
    return this.show(this.value(r, c), this.dateKind(r, c));
  }

  private show(v: Val, kind: "date" | "datetime" | null): string {
    if (typeof v === "number" && kind && v > -1 && v < 2958466) {
      const d = dateOf(v);
      const p = (n: number) => String(n).padStart(2, "0");
      const day = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
      return kind === "datetime" ? `${day} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : day;
    }
    return toStr(v);
  }

  /** A formula's full result (arrays included), cached. */
  private result(r: number, c: number, raw = this.host.raw(r, c)): Val | ArrV {
    const hit = this.results.get(r * KEY + c);
    if (hit !== undefined) return hit;
    // The outermost calculation handles chains that get too deep (see `settled`).
    return depth.n === 0 ? settled(() => this.compute(r, c, raw)) : this.compute(r, c, raw);
  }

  /** Work out one formula cell (used by `result`, and by `settled` for deep chains). */
  compute(r: number, c: number, raw = this.host.raw(r, c)): Val | ArrV {
    const key = r * KEY + c;
    const hit = this.results.get(key);
    if (hit !== undefined) return hit;
    if (this.active.has(key)) return ERR.circ;
    if (depth.n >= DEPTH_LIMIT) throw new TooDeep(this, r, c);
    this.active.add(key);
    depth.n++;
    let v: Val | ArrV;
    try {
      const ast = this.compile(raw);
      v = isErr(ast) ? ast : normalize(this.ev(ast, null, r, c));
    } catch (e) {
      if (e instanceof TooDeep) throw e; // not an answer for this cell: it'll be retried
      // Very deep recursion within one formula (e.g. a recursive LAMBDA) can still run out of stack.
      v = isErr(e) ? e : e instanceof RangeError ? ERR.num : ERR.parse;
    } finally {
      this.active.delete(key);
      depth.n--;
    }
    this.results.set(key, v);
    // A formula that wasn't expected to give an array did: it can spill after all.
    if (isArr(v) && this.candidates && !this.candidates.has(key)) { this.candidates.add(key); this.spillsReady = false; }
    return v;
  }

  /** A long circular chain found by `settled`. */
  markCircular(r: number, c: number) {
    this.results.set(r * KEY + c, ERR.circ);
  }

  compile(src: string): Node | FErr {
    let ast = this.asts.get(src);
    if (ast === undefined) {
      try { ast = parse(src.slice(1)); } catch (e) { ast = isErr(e) ? e : ERR.parse; }
      // Drop the oldest entries rather than everything, so a big sheet doesn't re-parse constantly.
      if (this.asts.size >= 50_000) {
        let n = 0;
        for (const k of this.asts.keys()) { this.asts.delete(k); if (++n >= 5_000) break; }
      }
      this.asts.set(src, ast);
    }
    return ast;
  }

  /**
   * Text starting with "=" that isn't a working formula at all: it doesn't
   * parse ("=== Totals ==="), or is a lone word that names nothing ("=Notes").
   */
  /**
   * Text that starts with "=" but isn't an attempt at a formula ("=== Totals
   * ===", "= note", "=)"): it doesn't parse, and what follows the "=" can't
   * begin a formula. A real attempt with a mistake ("=SUM(A1") still shows
   * #ERROR!, so typos aren't mistaken for accepted text.
   */
  private unparseable(raw: string): boolean {
    return raw.length > 1 && !/^=[A-Za-z0-9_$@'"(+\-.{#]/.test(raw) && isErr(this.compile(raw));
  }

  isNotAFormula(raw: string): boolean {
    const ast = this.compile(raw);
    return isErr(ast) || (ast.k === "name" && this.host.definedName?.(ast.v) === undefined);
  }

  /* -------------------------------- spills -------------------------------- */

  private blocked(r: number, c: number, a: ArrV): boolean {
    const h = a.v.length, w = a.v[0]?.length ?? 0;
    if (h * w > MAX_SPILL) return true;
    for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) {
      if (!i && !j) continue;
      if (this.host.raw(r + i, c + j) !== "") return true;
    }
    return false;
  }

  private ensureSpills() {
    if (this.spillsReady || this.building) return;
    this.building = true;
    try {
      if (!this.candidates) this.scan();
      this.spills.clear();
      for (const key of this.candidates!) {
        const r = Math.floor(key / KEY), c = key % KEY;
        const raw = this.host.raw(r, c);
        if (raw.charCodeAt(0) !== 61) continue;
        const res = this.result(r, c, raw);
        if (isArr(res) && !this.blocked(r, c, res)) this.spills.set(key, { r, c, h: res.v.length, w: res.v[0]?.length ?? 0 });
      }
      this.spillsReady = true;
    } finally {
      this.building = false;
    }
  }

  private scan() {
    this.candidates = new Set();
    const list = this.host.formulas?.();
    if (!list) return;
    for (const [r, c] of list) this.noteCell(r, c, this.host.raw(r, c));
  }

  private spilled(r: number, c: number): Val | undefined {
    this.ensureSpills();
    for (const s of this.spills.values()) {
      if (r >= s.r && r < s.r + s.h && c >= s.c && c < s.c + s.w) {
        const res = this.results.get(s.r * KEY + s.c) ?? this.result(s.r, s.c);
        return isArr(res) ? res.v[r - s.r]?.[c - s.c] ?? "" : undefined;
      }
    }
    if (this.building && this.candidates) {
      // Spills are still being worked out: check the possible ones directly.
      for (const key of this.candidates) {
        const ar = Math.floor(key / KEY), ac = key % KEY;
        if (ar > r || ac > c || this.active.has(key)) continue;
        const raw = this.host.raw(ar, ac);
        if (raw.charCodeAt(0) !== 61) continue;
        const res = this.result(ar, ac, raw);
        if (isArr(res) && r < ar + res.v.length && c < ac + (res.v[0]?.length ?? 0) && !this.blocked(ar, ac, res)) return res.v[r - ar][c - ac];
      }
    }
    return undefined;
  }

  /** Every active spill (anchor and size). */
  spillRects(): Rect[] {
    this.ensureSpills();
    return [...this.spills.values()];
  }

  /** The spill a cell belongs to, if any (including its anchor). */
  spillAnchor(r: number, c: number): Rect | null {
    this.ensureSpills();
    for (const s of this.spills.values()) if (r >= s.r && r < s.r + s.h && c >= s.c && c < s.c + s.w) return s;
    return null;
  }

  /* --------------------------------- dates --------------------------------- */

  /** Should a formula's number be shown as a date? (TODAY(), DATE(…), A1+7 where A1 is a date…) */
  dateKind(r: number, c: number, depth = 0): "date" | "datetime" | null {
    const raw = this.host.raw(r, c);
    if (raw.charCodeAt(0) !== 61) return /^\d{4}-\d{1,2}-\d{1,2}(\s+\d{1,2}:\d{2})?$/.test(raw.trim()) ? (raw.includes(":") ? "datetime" : "date") : null;
    if (depth > 8) return null;
    const ast = this.compile(raw);
    if (isErr(ast)) return null;
    const kind = (n: Node): "date" | "datetime" | null => {
      switch (n.k) {
        case "fn": {
          const f = FUNCS[n.name];
          if (f?.date) return f.date;
          if (n.name === "IF" || n.name === "IFERROR" || n.name === "IFNA" || n.name === "MIN" || n.name === "MAX" || n.name === "INDEX" || n.name === "XLOOKUP" || n.name === "VLOOKUP" || n.name === "SORT" || n.name === "FILTER" || n.name === "LARGE" || n.name === "SMALL" || n.name === "MEDIAN") {
            for (const a of n.args.slice(n.name === "IF" ? 1 : 0)) { const k = kind(a); if (k) return k; }
            if ((n.name === "VLOOKUP" || n.name === "XLOOKUP") && n.args[n.name === "VLOOKUP" ? 1 : 2]) {
              const t = n.args[n.name === "VLOOKUP" ? 1 : 2];
              if (t.k === "range" && !t.sh) { const cc = n.name === "VLOOKUP" && n.args[2].k === "lit" ? t.c1 + Number((n.args[2] as { v: Val }).v) - 1 : t.c1; return this.dateKind(Math.max(0, t.r1) + 1, cc, depth + 1) ?? this.dateKind(Math.max(0, t.r1), cc, depth + 1); }
            }
          }
          return null;
        }
        case "paren": return kind(n.a);
        case "ref": return n.sh ? null : this.dateKind(n.r, n.c, depth + 1);
        case "range": return n.sh || n.r1 < 0 ? null : this.dateKind(n.r1, n.c1, depth + 1);
        case "bin": {
          if (n.op !== "+" && n.op !== "-") return null;
          const a = kind(n.a), b = kind(n.b);
          if (a && b) return n.op === "-" ? null : a;
          return a ?? (n.op === "+" ? b : null);
        }
        default: return null;
      }
    };
    return kind(ast);
  }

  /* ------------------------------- evaluation ------------------------------- */

  private sheetEngine(name: string | undefined): Engine | FErr {
    if (name === undefined) return this;
    if (name.toLowerCase() === this.sheetName().toLowerCase()) return this;
    return this.host.sheet?.(name) ?? ERR.ref;
  }

  private rangeOf(eng: Engine, r1: number, c1: number, r2: number, c2: number): RefV {
    const R1 = r1 < 0 ? 0 : r1, R2 = r2 < 0 ? eng.rowCount() - 1 : r2;
    const C1 = c1 < 0 ? 0 : c1, C2 = c2 < 0 ? eng.colCount() - 1 : c2;
    return { k: "ref", eng, r1: R1, c1: C1, r2: Math.max(R1, R2), c2: Math.max(C1, C2) };
  }

  private ctx(env: Env, r: number, c: number): Ctx {
    return {
      ev: (n, e) => this.ev(n, e === undefined ? env : e, r, c),
      env,
      call: (l, args) => this.callLambda(l, args, r, c),
      r, c,
      refFromText: (t, a1 = true) => this.refFromText(t, r, c, a1),
      sheetName: () => this.sheetName(),
      sheetIndex: (n) => (this.host.sheetNames?.() ?? [this.sheetName()]).findIndex((x) => x.toLowerCase() === n.toLowerCase()),
      sheetCount: () => this.host.sheetNames?.().length ?? 1,
      subRef: (ref, r1, c1, r2, c2) => r1 < 0 || c1 < 0 ? ERR.ref : { ...ref, r1, c1, r2, c2 },
    };
  }

  /** Sheet1:Sheet3!A1:B2 — the same block from every sheet in between, stacked. */
  private threeD(from: string, to: string, r1: number, c1: number, r2: number, c2: number): Any {
    const names = this.host.sheetNames?.() ?? [this.sheetName()];
    const i = names.findIndex((x) => x.toLowerCase() === from.toLowerCase());
    const j = names.findIndex((x) => x.toLowerCase() === to.toLowerCase());
    if (i < 0 || j < 0) return ERR.ref;
    const rows: Val[][] = [];
    for (let k = Math.min(i, j); k <= Math.max(i, j); k++) {
      const eng = this.sheetEngine(names[k]);
      if (isErr(eng)) return eng;
      pushAll(rows, toArr(this.rangeOf(eng, r1, c1, r2, c2)));
    }
    return { k: "arr", v: rows };
  }

  private callLambda(l: LamV, args: Any[], r: number, c: number): Any {
    if (args.length > l.params.length) return ERR.value;
    const env: Env = { vars: new Map(), parent: l.env };
    l.params.forEach((p, i) => env.vars.set(p, i < args.length ? args[i] : OMIT));
    return this.ev(l.body, env, r, c);
  }

  private refFromText(text: string, r: number, c: number, a1 = true): RefV | FErr {
    let ast: Node;
    let t = text.trim();
    if (!a1) {
      // R1C1 style: R2C3, R[-1]C[2], RC[1] (relative to the calling cell).
      const one = (s: string): string | null => {
        const m = /^R(\[-?\d+\]|\d+)?C(\[-?\d+\]|\d+)?$/i.exec(s);
        if (!m) return null;
        const part = (p: string | undefined, here: number) => p === undefined ? here : p.startsWith("[") ? here + Number(p.slice(1, -1)) : Number(p) - 1;
        const rr = part(m[1], r), cc = part(m[2], c);
        return rr < 0 || cc < 0 ? null : colName(cc) + (rr + 1);
      };
      const bang = t.lastIndexOf("!");
      const prefix = bang >= 0 ? t.slice(0, bang + 1) : "";
      const parts = t.slice(bang + 1).split(":").map(one);
      if (parts.some((p) => p === null)) return ERR.ref;
      t = prefix + parts.join(":");
    }
    try { ast = parse(t); } catch { return ERR.ref; }
    if (ast.k !== "ref" && ast.k !== "range" && ast.k !== "name") return ERR.ref;
    const v = this.ev(ast, null, r, c);
    return isRef(v) ? v : ERR.ref;
  }

  private nameValue(name: string, env: Env, r: number, c: number): Any {
    const local = lookupEnv(env, name);
    if (local !== undefined) return local;
    const text = this.host.definedName?.(name);
    if (text === undefined) return ERR.name;
    if (this.namesBusy.has(name)) return ERR.circ;
    const ast = this.compile("=" + text);
    if (isErr(ast)) return ast;
    this.namesBusy.add(name);
    try { return this.ev(ast, null, r, c); } finally { this.namesBusy.delete(name); }
  }

  /** Evaluate a syntax node (the cell being calculated is (r, c)). */
  ev(n: Node, env: Env, r: number, c: number): Any {
    switch (n.k) {
      case "lit": return n.v;
      case "omit": return OMIT;
      case "ref": {
        if (n.sh2) return this.threeD(n.sh!, n.sh2, n.r, n.c, n.r, n.c);
        const eng = this.sheetEngine(n.sh);
        if (isErr(eng)) return eng;
        return { k: "ref", eng, r1: n.r, c1: n.c, r2: n.r, c2: n.c };
      }
      case "range": {
        if (n.sh2) return this.threeD(n.sh!, n.sh2, n.r1, n.c1, n.r2, n.c2);
        const eng = this.sheetEngine(n.sh);
        if (isErr(eng)) return eng;
        return this.rangeOf(eng, n.r1, n.c1, n.r2, n.c2);
      }
      case "union": {
        // (A1:A3, C1:C3): every value, one after another.
        const vals: Val[] = [];
        for (const p of n.parts) for (const v of eachAny(this.ev(p, env, r, c))) vals.push(v);
        return { k: "arr", v: vals.map((v) => [v]) };
      }
      case "spill": {
        const a = n.a as Extract<Node, { k: "ref" }>;
        const eng = this.sheetEngine(a.sh);
        if (isErr(eng)) return eng;
        const s = eng.spillAnchor(a.r, a.c);
        if (!s || s.r !== a.r || s.c !== a.c) return ERR.ref;
        return this.rangeOf(eng, s.r, s.c, s.r + s.h - 1, s.c + s.w - 1);
      }
      case "name": return this.nameValue(n.v, env, r, c);
      case "paren": return this.ev(n.a, env, r, c);
      case "array": return { k: "arr", v: n.rows.map((row) => row.map((x) => scalar(this.ev(x, env, r, c)))) };
      case "neg": return lift1(this.ev(n.a, env, r, c), (v) => { const x = toNum(v); return isErr(x) ? x : -x; });
      case "pct": return lift1(this.ev(n.a, env, r, c), (v) => { const x = toNum(v); return isErr(x) ? x : x / 100; });
      case "bin": if (n.op === "∩") return intersect(this.ev(n.a, env, r, c), this.ev(n.b, env, r, c));
        return lift2(this.ev(n.a, env, r, c), this.ev(n.b, env, r, c), (a, b) => binop(n.op, a, b));
      case "call": {
        const f = this.ev(n.callee, env, r, c);
        if (!isLam(f)) return isErr(f) ? f : ERR.value;
        return this.callLambda(f, n.args.map((a) => this.ev(a, env, r, c)), r, c);
      }
      case "fn": {
        const spec = FUNCS[n.name];
        if (!spec) {
          // A LET variable or defined name holding a LAMBDA.
          const l = lookupEnv(env, n.name) ?? (this.host.definedName?.(n.name) !== undefined ? this.nameValue(n.name, env, r, c) : undefined);
          if (l && isLam(l)) return this.callLambda(l, n.args.map((a) => this.ev(a, env, r, c)), r, c);
          return ERR.name;
        }
        if (n.args.length < spec.min || n.args.length > spec.max) return ERR.value;
        const x = this.ctx(env, r, c);
        if (spec.lazy) return spec.lazy(n.args, x);
        const args = n.args.map((a) => this.ev(a, env, r, c));
        if (spec.lift) {
          const lifted = (i: number) => spec.lift === true || (spec.lift as number[]).includes(i);
          let H = 1, W = 1, any = false;
          args.forEach((a, i) => {
            if (!lifted(i) || !isMulti(a)) return;
            const [h, w] = dims(a);
            if (h * w <= 1) return;
            any = true; H = Math.max(H, h); W = Math.max(W, w);
          });
          if (any) {
            if (H * W > MAX_SPILL) return ERR.num;
            const out: Val[][] = [];
            for (let i = 0; i < H; i++) {
              const row: Val[] = [];
              for (let j = 0; j < W; j++) {
                const a2 = args.map((a, k) => lifted(k) && isMulti(a) ? pickAt(a, i, j) : a);
                row.push(scalarOf(spec.fn!(a2, x)));
              }
              out.push(row);
            }
            return { k: "arr", v: out };
          }
        }
        return spec.fn!(args, x);
      }
    }
  }

  /* ------------------------- for the formula tools ------------------------- */

  /** Evaluate part of a cell's formula on its own (Evaluate Formula). */
  evalPart(n: Node, r: number, c: number): Val | ArrV {
    try { return normalize(this.ev(n, null, r, c)); } catch (e) { return isErr(e) ? e : ERR.parse; }
  }

  /** What a formula being typed would give, as short text for a preview ("" if it doesn't parse yet). */
  preview(src: string, r: number, c: number): string {
    if (src.length < 2) return "";
    let ast: Node;
    try { ast = parse(src.slice(1)); } catch { return ""; }
    if ((ast.k === "lit" && typeof ast.v !== "object") || ast.k === "name") return "";
    const v = this.evalPart(ast, r, c);
    if (isArr(v)) { const h = v.v.length, w = v.v[0]?.length ?? 0; return `${this.show(v.v[0][0], null)}${h * w > 1 ? `  … ${h}×${w}` : ""}`; }
    return this.show(v, null);
  }

  /** Every reference in some formula text, with where it sits. */
  static references(src: string): RefInfo[] {
    if (!src.startsWith("=")) return [];
    let toks;
    try { toks = tokenize(src.slice(1)); } catch { return []; }
    const out: RefInfo[] = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.t === "ref") {
        const nx = toks[i + 1], b = toks[i + 2];
        if (nx?.t === "op" && nx.v === ":" && b?.t === "ref" && !b.sh) {
          out.push({ sheet: t.sh, r1: Math.min(t.r, b.r), c1: Math.min(t.c, b.c), r2: Math.max(t.r, b.r), c2: Math.max(t.c, b.c), s: t.s + 1, e: b.e + 1 });
          i += 2;
        } else out.push({ sheet: t.sh, r1: t.r, c1: t.c, r2: t.r, c2: t.c, s: t.s + 1, e: t.e + 1 });
      } else if (t.t === "cols") out.push({ sheet: t.sh, r1: -1, c1: Math.min(t.c1, t.c2), r2: -1, c2: Math.max(t.c1, t.c2), s: t.s + 1, e: t.e + 1 });
      else if (t.t === "rows") out.push({ sheet: t.sh, r1: Math.min(t.r1, t.r2), c1: -1, r2: Math.max(t.r1, t.r2), c2: -1, s: t.s + 1, e: t.e + 1 });
    }
    return out;
  }

  /** Formula cells on this sheet that read (r, c) of sheet `target` (this sheet if omitted). */
  dependentsOf(r: number, c: number, target?: string): [number, number][] {
    const out: [number, number][] = [];
    const list = this.host.formulas?.();
    if (!list) return out;
    const me = this.sheetName().toLowerCase();
    const want = (target ?? this.sheetName()).toLowerCase();
    for (const [fr, fc] of list) {
      const refs = Engine.references(this.host.raw(fr, fc));
      if (refs.some((x) => (x.sheet ?? me).toLowerCase() === want && (x.r1 < 0 || (r >= x.r1 && r <= x.r2)) && (x.c1 < 0 || (c >= x.c1 && c <= x.c2)))) out.push([fr, fc]);
    }
    return out;
  }
}

/* ------------------------------- helpers ------------------------------- */

function scalarOf(v: Any): Val {
  if (isMulti(v)) return scalar(v);
  if (isLam(v)) return ERR.calc;
  if (isOmit(v)) return "";
  return v;
}

/** A finished result: a value, or an array of values (for spilling). */
function normalize(v: Any): Val | ArrV {
  if (isOmit(v)) return 0;
  if (isLam(v)) return ERR.calc;
  if (isMulti(v)) {
    const [h, w] = dims(v);
    if (h === 0 || w === 0) return ERR.calc;
    if (h === 1 && w === 1) return fin(at(v, 0, 0));
    if (h * w > MAX_SPILL) return ERR.num;
    return { k: "arr", v: toArr(v).map((row) => row.map(fin)) };
  }
  return fin(v);
}

function fin(v: Val): Val {
  if (typeof v === "number" && !Number.isFinite(v)) return Number.isNaN(v) ? ERR.num : ERR.div0;
  return v;
}

function* eachAny(v: Any): Iterable<Val> {
  if (isMulti(v)) { for (const row of toArr(v)) yield* row; }
  else yield scalarOf(v);
}

/** The overlap of two references (A1:C5 B2:B9), or #NULL! if none. */
function intersect(a: Any, b: Any): Any {
  if (!isRef(a) || !isRef(b) || a.eng !== b.eng) return isErr(a) ? a : isErr(b) ? b : new FErr("#NULL!");
  const r1 = Math.max(a.r1, b.r1), r2 = Math.min(a.r2, b.r2), c1 = Math.max(a.c1, b.c1), c2 = Math.min(a.c2, b.c2);
  if (r1 > r2 || c1 > c2) return new FErr("#NULL!");
  return { k: "ref", eng: a.eng, r1, c1, r2, c2 };
}

/** One cell of an array, repeating single rows/columns to fit. */
function pickAt(a: RefV | ArrV, i: number, j: number): Val {
  const [h, w] = dims(a);
  const ii = h === 1 ? 0 : i, jj = w === 1 ? 0 : j;
  if (ii >= h || jj >= w) return ERR.na;
  return at(a, ii, jj);
}

function lift1(a: Any, f: (v: Val) => Val): Any {
  if (isMulti(a) && dims(a)[0] * dims(a)[1] > 1) return { k: "arr", v: toArr(a).map((row) => row.map(f)) };
  return f(scalarOf(a));
}

function lift2(a: Any, b: Any, f: (x: Val, y: Val) => Val): Any {
  const ma = isMulti(a) && dims(a)[0] * dims(a)[1] > 1, mb = isMulti(b) && dims(b)[0] * dims(b)[1] > 1;
  if (!ma && !mb) return f(scalarOf(a), scalarOf(b));
  const [ah, aw] = ma ? dims(a) : [1, 1], [bh, bw] = mb ? dims(b) : [1, 1];
  const H = Math.max(ah, bh), W = Math.max(aw, bw);
  if (H * W > MAX_SPILL) return ERR.num;
  const out: Val[][] = [];
  for (let i = 0; i < H; i++) {
    const row: Val[] = [];
    for (let j = 0; j < W; j++) row.push(f(ma ? pickAt(a as RefV | ArrV, i, j) : scalarOf(a), mb ? pickAt(b as RefV | ArrV, i, j) : scalarOf(b)));
    out.push(row);
  }
  return { k: "arr", v: out };
}

function binop(op: string, a: Val, b: Val): Val {
  if (isErr(a)) return a;
  if (isErr(b)) return b;
  if (op === "&") return toStr(a) + toStr(b);
  if (COMPARE_OPS.has(op)) return compareOp(a, b, op);
  const x = toNum(a); if (isErr(x)) return x;
  const y = toNum(b); if (isErr(y)) return y;
  switch (op) {
    case "+": return x + y;
    case "-": return x - y;
    case "*": return x * y;
    case "/": return y === 0 ? ERR.div0 : x / y;
    case "^": { const p = Math.pow(x, y); return Number.isNaN(p) ? ERR.num : p; }
  }
  return ERR.value;
}

/** Rows × columns a node is sure to cover, if that can be told from the formula alone. */
function shapeOf(n: Node): [number, number] | null {
  switch (n.k) {
    case "ref": return n.sh2 ? null : [1, 1];
    case "range": {
      if (n.sh2) return null;
      const h = n.r1 < 0 ? Infinity : n.r2 - n.r1 + 1, w = n.c1 < 0 ? Infinity : n.c2 - n.c1 + 1;
      return [h, w];
    }
    case "paren": return shapeOf(n.a);
    default: return null;
  }
}

/**
 * Could this formula give an array (and so spill)? Erring towards "yes" is
 * safe but costly: every possible spill is worked out after each edit, so
 * common one-value lookups (XLOOKUP into one column, INDEX/MATCH, a name
 * for one cell) are recognised as such. A formula that gives an array
 * anyway is picked up when it's calculated (see Engine.compute).
 */
export function mayArray(n: Node, nameMayArray: (name: string) => boolean = () => true): boolean {
  const may = (x: Node | undefined): boolean => !!x && x.k !== "omit" && mayArray(x, nameMayArray);
  switch (n.k) {
    case "range": case "spill": case "array": case "call": case "union": return true;
    case "name": return nameMayArray(n.v);
    case "lit": case "ref": case "omit": return false;
    case "paren": case "neg": case "pct": return may(n.a);
    case "bin": return may(n.a) || may(n.b);
    case "fn": {
      const f = FUNCS[n.name];
      if (!f) return true;
      const a = n.args;
      if (n.name === "XLOOKUP") {
        // One value comes back unless the key is an array, the fallback is,
        // or the result range is wider than the lookup range is long.
        if (may(a[0]) || may(a[3])) return true;
        const look = shapeOf(a[1]), res = shapeOf(a[2]);
        if (!look || !res) return true;
        if (look[1] === 1) return res[1] !== 1; // looking down a column
        if (look[0] === 1) return res[0] !== 1; // looking along a row
        return true;
      }
      if (n.name === "INDEX") {
        // INDEX(one column, row) or INDEX(range, row, column) with real numbers is one cell.
        if (a.slice(1).some(may)) return true;
        const zero = (x: Node | undefined) => !x || x.k === "omit" || (x.k === "lit" && x.v === 0);
        const s = shapeOf(a[0]);
        if (!s) return true;
        if (s[0] === 1 && s[1] === 1) return false;
        if (s[1] === 1 || s[0] === 1) return zero(a[1]);
        return zero(a[1]) || zero(a[2]);
      }
      if (n.name === "OFFSET") {
        // OFFSET(cell, rows, cols) with no height/width is one cell.
        if (a.slice(1).some(may)) return true;
        const s = shapeOf(a[0]);
        return !(s && s[0] === 1 && s[1] === 1 && (!a[3] || a[3].k === "omit") && (!a[4] || a[4].k === "omit"));
      }
      if (f.spills) return true;
      if (["IF", "IFS", "IFERROR", "IFNA", "SWITCH", "CHOOSE"].includes(n.name)) return a.some(may);
      if (f.lift === true) return a.some(may);
      if (Array.isArray(f.lift)) return f.lift.some((i) => may(a[i]));
      return false;
    }
  }
}

export function isFormulaError(v: Val): boolean {
  return v instanceof FErr;
}

/** Parse a formula (with "="), or null if it doesn't parse. */
export function parseFormula(src: string): Node | null {
  try { return parse(src.replace(/^=/, "")); } catch { return null; }
}

/* ------------------------- rewriting references ------------------------- */

/**
 * Which references a rewrite applies to: with `local`, ones without a
 * sheet name (they point at the formula's own sheet); and any naming
 * `sheet` explicitly.
 */
export interface Scope { local: boolean; sheet?: string }
const LOCAL: Scope = { local: true };
const applies = (sh: string | undefined, s: Scope) => sh === undefined ? s.local : !!s.sheet && sh.toLowerCase() === s.sheet.toLowerCase();

/**
 * Rewrite cell references after rows/columns are inserted or deleted.
 * `at` is the first affected index, `delta` how many were added
 * (positive) or removed (negative). References into removed cells → #REF!.
 */
export function shiftFormula(src: string, axis: "row" | "col", at_: number, delta: number, scope: Scope = LOCAL): string {
  const shift = (i: number): number | null => {
    if (i < at_) return i;
    if (delta < 0 && i < at_ - delta) return null; // removed
    return i + delta;
  };
  return rewriteRefs(src, (t, prefix) => {
    if (!applies(t.sh, scope)) return null;
    if (t.t === "ref") {
      const r = axis === "row" ? shift(t.r) : t.r;
      const c = axis === "col" ? shift(t.c) : t.c;
      return r === null || c === null ? "#REF!" : prefix + (t.ca ? "$" : "") + colName(c) + (t.ra ? "$" : "") + (r + 1);
    }
    if (t.t === "cols" && axis === "col") {
      const c1 = shift(t.c1), c2 = shift(t.c2);
      return c1 === null || c2 === null ? "#REF!" : prefix + (t.a1 ? "$" : "") + colName(c1) + ":" + (t.a2 ? "$" : "") + colName(c2);
    }
    if (t.t === "rows" && axis === "row") {
      const r1 = shift(t.r1), r2 = shift(t.r2);
      return r1 === null || r2 === null ? "#REF!" : prefix + (t.a1 ? "$" : "") + (r1 + 1) + ":" + (t.a2 ? "$" : "") + (r2 + 1);
    }
    return null;
  });
}

/** Rewrite references after rows/columns were reordered: old index → new index. */
export function remapFormula(src: string, axis: "row" | "col", map: (i: number) => number, scope: Scope = LOCAL): string {
  return rewriteRefs(src, (t, prefix) => {
    if (!applies(t.sh, scope)) return null;
    if (t.t === "ref") {
      const r = axis === "row" ? map(t.r) : t.r;
      const c = axis === "col" ? map(t.c) : t.c;
      return r !== t.r || c !== t.c ? prefix + (t.ca ? "$" : "") + colName(c) + (t.ra ? "$" : "") + (r + 1) : null;
    }
    if (t.t === "cols" && axis === "col") {
      const c1 = map(t.c1), c2 = map(t.c2);
      return c1 !== t.c1 || c2 !== t.c2 ? prefix + (t.a1 ? "$" : "") + colName(Math.min(c1, c2)) + ":" + (t.a2 ? "$" : "") + colName(Math.max(c1, c2)) : null;
    }
    if (t.t === "rows" && axis === "row") {
      const r1 = map(t.r1), r2 = map(t.r2);
      return r1 !== t.r1 || r2 !== t.r2 ? prefix + (t.a1 ? "$" : "") + (Math.min(r1, r2) + 1) + ":" + (t.a2 ? "$" : "") + (Math.max(r1, r2) + 1) : null;
    }
    return null;
  });
}

/**
 * Move a formula's relative references by (dr, dc), as when it's copied
 * to another cell. $-anchored parts stay put. Off-grid → #REF!.
 */
export function offsetFormula(src: string, dr: number, dc: number): string {
  if (!src.startsWith("=") || (dr === 0 && dc === 0)) return src;
  return rewriteRefs(src, (t, prefix) => {
    if (t.t === "ref") {
      const r = t.ra ? t.r : t.r + dr;
      const c = t.ca ? t.c : t.c + dc;
      return r < 0 || c < 0 ? "#REF!" : prefix + (t.ca ? "$" : "") + colName(c) + (t.ra ? "$" : "") + (r + 1);
    }
    if (t.t === "cols") {
      const c1 = t.a1 ? t.c1 : t.c1 + dc, c2 = t.a2 ? t.c2 : t.c2 + dc;
      return c1 < 0 || c2 < 0 ? "#REF!" : prefix + (t.a1 ? "$" : "") + colName(c1) + ":" + (t.a2 ? "$" : "") + colName(c2);
    }
    const r1 = t.a1 ? t.r1 : t.r1 + dr, r2 = t.a2 ? t.r2 : t.r2 + dr;
    return r1 < 0 || r2 < 0 ? "#REF!" : prefix + (t.a1 ? "$" : "") + (r1 + 1) + ":" + (t.a2 ? "$" : "") + (r2 + 1);
  });
}

/** Point references at a renamed sheet. */
export function renameSheetInFormula(src: string, from: string, to: string): string {
  const same = (x?: string) => !!x && x.toLowerCase() === from.toLowerCase();
  return rewriteRefs(src, (t) => {
    if (!same(t.sh) && !same(t.sh2)) return null;
    const a = same(t.sh) ? to : t.sh!, b = t.sh2 ? (same(t.sh2) ? to : t.sh2) : undefined;
    const rest = (() => {
      if (t.t === "ref") return (t.ca ? "$" : "") + colName(t.c) + (t.ra ? "$" : "") + (t.r + 1);
      if (t.t === "cols") return (t.a1 ? "$" : "") + colName(t.c1) + ":" + (t.a2 ? "$" : "") + colName(t.c2);
      return (t.a1 ? "$" : "") + (t.r1 + 1) + ":" + (t.a2 ? "$" : "") + (t.r2 + 1);
    })();
    return sheetPrefix(b ? `${a}:${b}` : a) + rest;
  });
}

/** Replace a defined name used in a formula (not functions or text that happen to match). */
export function renameNameInFormula(src: string, from: string, to: string): string {
  if (!src.startsWith("=")) return src;
  let toks;
  try { toks = tokenize(src.slice(1)); } catch { return src; }
  const body = src.slice(1);
  const want = from.toUpperCase();
  let out = "", last = 0;
  toks.forEach((t, i) => {
    if (t.t !== "id" || t.v !== want) return;
    const next = toks[i + 1];
    if (next && next.t === "op" && next.v === "(") return; // a function call, not the name
    out += body.slice(last, t.s) + to;
    last = t.e;
  });
  return last ? "=" + out + body.slice(last) : src;
}

export { sheetPrefix };
