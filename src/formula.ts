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
import { FUNCS, type Ctx } from "./functions";
import { colName } from "./util";

export { FErr, formatNumber };
export type { Val };
export { FUNCS, FUNCTION_NAMES } from "./functions";

export interface Host {
  raw(r: number, c: number): string;
  rowCount(): number;
  colCount?(): number;
  sheetName?(): string;
  /** Another sheet of the same file, by name (any case). */
  sheet?(name: string): Engine | null;
  /** A defined name's formula text (without "="), e.g. "Sheet1!$A$2:$A$40". */
  definedName?(name: string): string | undefined;
  /** Every formula cell, for finding spills and dependents. */
  formulas?(): Iterable<[number, number]>;
}

export interface Rect { r: number; c: number; h: number; w: number }
export interface RefInfo { sheet?: string; r1: number; c1: number; r2: number; c2: number; s: number; e: number }

const KEY = 65536;
const MAX_SPILL = 2_000_000;

export class Engine implements EngineLike {
  private results = new Map<number, Val | ArrV>();
  private active = new Set<number>();
  private asts = new Map<string, Node | FErr>();
  private spills = new Map<number, Rect>();
  private spillsReady = false;
  private building = false;
  private candidates: Set<number> | null = null;
  private namesBusy = new Set<string>();

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

  /** A cell's text changed (keeps the list of possible spills current). */
  noteCell(r: number, c: number, raw: string) {
    if (!this.candidates) return;
    const key = r * KEY + c;
    if (raw.charCodeAt(0) === 61) { const ast = this.compile(raw); if (!isErr(ast) && mayArray(ast)) { this.candidates.add(key); return; } }
    this.candidates.delete(key);
  }

  rowCount() { return Math.max(1, this.host.rowCount()); }
  colCount() { return Math.max(1, this.host.colCount?.() ?? 26); }
  sheetName() { return this.host.sheetName?.() ?? ""; }

  /* ------------------------------- reading ------------------------------- */

  /** The value a cell shows: a literal for normal text, a result for formulas, or part of a spill. */
  value(r: number, c: number): Val {
    const raw = this.host.raw(r, c);
    if (raw === "") { const s = this.spilled(r, c); return s === undefined ? "" : s; }
    if (raw.charCodeAt(0) !== 61) return literal(raw);
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
    if (raw.charCodeAt(0) !== 61) return raw;
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
    const key = r * KEY + c;
    const hit = this.results.get(key);
    if (hit !== undefined) return hit;
    if (this.active.has(key)) return ERR.circ;
    this.active.add(key);
    let v: Val | ArrV;
    try {
      const ast = this.compile(raw);
      v = isErr(ast) ? ast : normalize(this.ev(ast, null, r, c));
    } catch (e) {
      v = isErr(e) ? e : ERR.parse; // includes stack overflow on very deep chains
    } finally {
      this.active.delete(key);
    }
    this.results.set(key, v);
    return v;
  }

  compile(src: string): Node | FErr {
    let ast = this.asts.get(src);
    if (ast === undefined) {
      try { ast = parse(src.slice(1)); } catch (e) { ast = isErr(e) ? e : ERR.parse; }
      if (this.asts.size > 5000) this.asts.clear();
      this.asts.set(src, ast);
    }
    return ast;
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
      refFromText: (t) => this.refFromText(t, r, c),
      subRef: (ref, r1, c1, r2, c2) => r1 < 0 || c1 < 0 ? ERR.ref : { ...ref, r1, c1, r2, c2 },
    };
  }

  private callLambda(l: LamV, args: Any[], r: number, c: number): Any {
    if (args.length > l.params.length) return ERR.value;
    const env: Env = { vars: new Map(), parent: l.env };
    l.params.forEach((p, i) => env.vars.set(p, i < args.length ? args[i] : OMIT));
    return this.ev(l.body, env, r, c);
  }

  private refFromText(text: string, r: number, c: number): RefV | FErr {
    let ast: Node;
    try { ast = parse(text.trim()); } catch { return ERR.ref; }
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
        const eng = this.sheetEngine(n.sh);
        if (isErr(eng)) return eng;
        return { k: "ref", eng, r1: n.r, c1: n.c, r2: n.r, c2: n.c };
      }
      case "range": {
        const eng = this.sheetEngine(n.sh);
        if (isErr(eng)) return eng;
        return this.rangeOf(eng, n.r1, n.c1, n.r2, n.c2);
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
      case "bin": return lift2(this.ev(n.a, env, r, c), this.ev(n.b, env, r, c), (a, b) => binop(n.op, a, b));
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

/** Could this formula give an array (and so spill)? */
export function mayArray(n: Node): boolean {
  switch (n.k) {
    case "range": case "spill": case "array": case "name": case "call": return true;
    case "lit": case "ref": case "omit": return false;
    case "paren": case "neg": case "pct": return mayArray(n.a);
    case "bin": return mayArray(n.a) || mayArray(n.b);
    case "fn": {
      const f = FUNCS[n.name];
      if (!f) return true;
      if (f.spills) return true;
      if (["IF", "IFS", "IFERROR", "IFNA", "SWITCH", "CHOOSE"].includes(n.name)) return n.args.some(mayArray);
      if (f.lift === true) return n.args.some(mayArray);
      if (Array.isArray(f.lift)) return f.lift.some((i) => n.args[i] && mayArray(n.args[i]));
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
  return rewriteRefs(src, (t) => {
    if (!t.sh || t.sh.toLowerCase() !== from.toLowerCase()) return null;
    const rest = (() => {
      if (t.t === "ref") return (t.ca ? "$" : "") + colName(t.c) + (t.ra ? "$" : "") + (t.r + 1);
      if (t.t === "cols") return (t.a1 ? "$" : "") + colName(t.c1) + ":" + (t.a2 ? "$" : "") + colName(t.c2);
      return (t.a1 ? "$" : "") + (t.r1 + 1) + ":" + (t.a2 ? "$" : "") + (t.r2 + 1);
    })();
    return sheetPrefix(to) + rest;
  });
}

export { sheetPrefix };
