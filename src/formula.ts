import { colIndex, colName, parseNum } from "./util";

/* ------------------------------------------------------------------ *
 * A small spreadsheet formula engine.
 * Supports: numbers, "strings", TRUE/FALSE, A1 / $A$1 refs, A1:B9 and
 * A:A ranges, + - * / ^ & = <> < > <= >= and %, plus a core set of
 * functions (see FUNCS).
 * ------------------------------------------------------------------ */

export class FErr {
  constructor(public readonly code: string) {}
  toString() { return this.code; }
}
export type Val = number | string | boolean | FErr;

const ERR = {
  value: new FErr("#VALUE!"),
  div0: new FErr("#DIV/0!"),
  name: new FErr("#NAME?"),
  ref: new FErr("#REF!"),
  circ: new FErr("#CIRC!"),
  parse: new FErr("#ERROR!"),
  na: new FErr("#N/A"),
};

type Tok =
  | { t: "num"; v: number; s: number; e: number }
  | { t: "str"; v: string; s: number; e: number }
  | { t: "ref"; r: number; c: number; s: number; e: number; ra: boolean; ca: boolean }
  | { t: "cols"; c1: number; c2: number; s: number; e: number; a1: boolean; a2: boolean }
  | { t: "id"; v: string; s: number; e: number }
  | { t: "op"; v: string; s: number; e: number }
  | { t: "err"; v: string; s: number; e: number };

const REF_RE = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)/;
const COLS_RE = /^(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9_(])/;

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i++; continue; }
    const rest = src.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(rest))) {
      out.push({ t: "num", v: Number(m[0]), s: i, e: i + m[0].length });
      i += m[0].length;
    } else if (ch === '"') {
      let j = i + 1;
      let v = "";
      while (j < src.length) {
        if (src[j] === '"') { if (src[j + 1] === '"') { v += '"'; j += 2; continue; } break; }
        v += src[j++];
      }
      out.push({ t: "str", v, s: i, e: j + 1 });
      i = j + 1;
    } else if ((m = COLS_RE.exec(rest))) {
      out.push({ t: "cols", c1: colIndex(m[2]), c2: colIndex(m[4]), a1: !!m[1], a2: !!m[3], s: i, e: i + m[0].length });
      i += m[0].length;
    } else if ((m = REF_RE.exec(rest)) && !/^[A-Za-z0-9_(]/.test(rest.slice(m[0].length))) {
      out.push({ t: "ref", c: colIndex(m[2]), r: Number(m[4]) - 1, ca: !!m[1], ra: !!m[3], s: i, e: i + m[0].length });
      i += m[0].length;
    } else if ((m = /^#[A-Z0-9\/]+[!?]?/.exec(rest))) {
      out.push({ t: "err", v: m[0], s: i, e: i + m[0].length });
      i += m[0].length;
    } else if ((m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest))) {
      out.push({ t: "id", v: m[0].toUpperCase(), s: i, e: i + m[0].length });
      i += m[0].length;
    } else if ((m = /^(<>|<=|>=|[-+*/^&=<>%(),:;])/.exec(rest))) {
      out.push({ t: "op", v: m[0] === ";" ? "," : m[0], s: i, e: i + m[0].length });
      i += m[0].length;
    } else {
      throw ERR.parse;
    }
  }
  return out;
}

type Node =
  | { k: "lit"; v: Val }
  | { k: "ref"; r: number; c: number }
  | { k: "range"; r1: number; c1: number; r2: number; c2: number } // r = -1 → whole column
  | { k: "fn"; name: string; args: Node[] }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "neg"; a: Node }
  | { k: "pct"; a: Node };

const BIN_PREC: Record<string, number> = {
  "=": 1, "<>": 1, "<": 1, ">": 1, "<=": 1, ">=": 1,
  "&": 2, "+": 3, "-": 3, "*": 4, "/": 4, "^": 5,
};

function parse(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => { const t = toks[p]; return t && t.t === "op" && t.v === v; };
  const expect = (v: string) => { if (!isOp(v)) throw ERR.parse; p++; };

  function primary(): Node {
    const t = toks[p++];
    if (!t) throw ERR.parse;
    switch (t.t) {
      case "num": return { k: "lit", v: t.v };
      case "str": return { k: "lit", v: t.v };
      case "err": return { k: "lit", v: new FErr(t.v) };
      case "cols": return { k: "range", r1: -1, c1: Math.min(t.c1, t.c2), r2: -1, c2: Math.max(t.c1, t.c2) };
      case "ref": {
        if (isOp(":") && toks[p + 1]?.t === "ref") {
          p++;
          const b = toks[p++] as Extract<Tok, { t: "ref" }>;
          return {
            k: "range",
            r1: Math.min(t.r, b.r), c1: Math.min(t.c, b.c),
            r2: Math.max(t.r, b.r), c2: Math.max(t.c, b.c),
          };
        }
        return { k: "ref", r: t.r, c: t.c };
      }
      case "id": {
        if (isOp("(")) {
          p++;
          const args: Node[] = [];
          if (!isOp(")")) {
            for (;;) {
              args.push(expr(0));
              if (isOp(",")) { p++; continue; }
              break;
            }
          }
          expect(")");
          return { k: "fn", name: t.v, args };
        }
        if (t.v === "TRUE") return { k: "lit", v: true };
        if (t.v === "FALSE") return { k: "lit", v: false };
        return { k: "lit", v: ERR.name };
      }
      case "op": {
        if (t.v === "(") { const e = expr(0); expect(")"); return e; }
        if (t.v === "-") return { k: "neg", a: expr(6) };
        if (t.v === "+") return expr(6);
        throw ERR.parse;
      }
    }
  }

  function expr(minPrec: number): Node {
    let left = primary();
    for (;;) {
      const t = peek();
      if (!t || t.t !== "op") break;
      if (t.v === "%") { p++; left = { k: "pct", a: left }; continue; }
      const prec = BIN_PREC[t.v];
      if (prec === undefined || prec < minPrec) break;
      p++;
      // ^ is right-associative; everything else is left-associative.
      const right = expr(t.v === "^" ? prec : prec + 1);
      left = { k: "bin", op: t.v, a: left, b: right };
    }
    return left;
  }

  const n = expr(0);
  if (p < toks.length) throw ERR.parse;
  return n;
}

/* ---------------------------- evaluation ---------------------------- */

type Range = { k: "rangeVal"; vals: () => Iterable<Val> };
type Arg = Val | Range;

function isErr(v: unknown): v is FErr { return v instanceof FErr; }

function toNum(v: Val): number | FErr {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (isErr(v)) return v;
  if (v === "") return 0;
  const n = parseNum(v);
  return Number.isNaN(n) ? ERR.value : n;
}

function toStr(v: Val): string {
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (isErr(v)) return v.code;
  return formatNumber(v);
}

function toBool(v: Val): boolean | FErr {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (isErr(v)) return v;
  const u = v.toUpperCase();
  if (u === "TRUE") return true;
  if (u === "FALSE" || u === "") return false;
  const n = parseNum(v);
  return Number.isNaN(n) ? ERR.value : n !== 0;
}

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return ERR.div0.code;
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  const p = Number(n.toPrecision(12));
  return String(p);
}

/** Spread every argument (including ranges) into one flat list of values. */
function* flat(args: Arg[]): Iterable<{ v: Val; fromRange: boolean }> {
  for (const a of args) {
    if (typeof a === "object" && a !== null && !isErr(a) && (a as Range).k === "rangeVal") {
      for (const v of (a as Range).vals()) yield { v, fromRange: true };
    } else yield { v: a as Val, fromRange: false };
  }
}

/** Numbers to aggregate: in ranges, only real numbers count (text is skipped). */
function nums(args: Arg[]): number[] | FErr {
  const out: number[] = [];
  for (const { v, fromRange } of flat(args)) {
    if (isErr(v)) return v;
    if (fromRange) {
      if (typeof v === "number") out.push(v);
    } else {
      const n = toNum(v);
      if (isErr(n)) return n;
      out.push(n);
    }
  }
  return out;
}

function scalar(a: Arg): Val {
  if (typeof a === "object" && a !== null && !isErr(a) && (a as Range).k === "rangeVal") {
    for (const v of (a as Range).vals()) return v; // first cell
    return "";
  }
  return a as Val;
}

type Fn = (args: Arg[], lazy: (i: number) => Arg, argc: number) => Val;

const FUNCS: Record<string, { min: number; max: number; fn: Fn; lazy?: boolean }> = {
  SUM: { min: 1, max: 255, fn: (a) => { const n = nums(a); return isErr(n) ? n : n.reduce((s, x) => s + x, 0); } },
  AVERAGE: { min: 1, max: 255, fn: (a) => { const n = nums(a); if (isErr(n)) return n; return n.length ? n.reduce((s, x) => s + x, 0) / n.length : ERR.div0; } },
  MIN: { min: 1, max: 255, fn: (a) => { const n = nums(a); if (isErr(n)) return n; let m = Infinity; for (const x of n) if (x < m) m = x; return n.length ? m : 0; } },
  MAX: { min: 1, max: 255, fn: (a) => { const n = nums(a); if (isErr(n)) return n; let m = -Infinity; for (const x of n) if (x > m) m = x; return n.length ? m : 0; } },
  PRODUCT: { min: 1, max: 255, fn: (a) => { const n = nums(a); return isErr(n) ? n : n.reduce((s, x) => s * x, 1); } },
  COUNT: { min: 1, max: 255, fn: (a) => { let c = 0; for (const { v, fromRange } of flat(a)) if (typeof v === "number" || (!fromRange && !isErr(toNum(v)) && v !== "")) c++; return c; } },
  COUNTA: { min: 1, max: 255, fn: (a) => { let c = 0; for (const { v } of flat(a)) if (v !== "") c++; return c; } },
  ROUND: { min: 1, max: 2, fn: (a) => {
    const x = toNum(scalar(a[0])); if (isErr(x)) return x;
    const d = a.length > 1 ? toNum(scalar(a[1])) : 0; if (isErr(d)) return d;
    const f = Math.pow(10, Math.trunc(d));
    return Math.sign(x) * Math.round(Math.abs(x) * f + 1e-9) / f;
  } },
  ABS: { min: 1, max: 1, fn: (a) => { const x = toNum(scalar(a[0])); return isErr(x) ? x : Math.abs(x); } },
  IF: { min: 2, max: 3, lazy: true, fn: (_a, lazy, argc) => {
    const c = toBool(scalar(lazy(0))); if (isErr(c)) return c;
    if (c) return scalar(lazy(1));
    return argc > 2 ? scalar(lazy(2)) : false;
  } },
  IFERROR: { min: 2, max: 2, lazy: true, fn: (_a, lazy) => { const v = scalar(lazy(0)); return isErr(v) ? scalar(lazy(1)) : v; } },
  AND: { min: 1, max: 255, fn: (a) => { for (const { v } of flat(a)) { const b = toBool(v); if (isErr(b)) return b; if (!b) return false; } return true; } },
  OR: { min: 1, max: 255, fn: (a) => { for (const { v } of flat(a)) { const b = toBool(v); if (isErr(b)) return b; if (b) return true; } return false; } },
  NOT: { min: 1, max: 1, fn: (a) => { const b = toBool(scalar(a[0])); return isErr(b) ? b : !b; } },
  CONCAT: { min: 1, max: 255, fn: (a) => { let s = ""; for (const { v } of flat(a)) { if (isErr(v)) return v; s += toStr(v); } return s; } },
  LEN: { min: 1, max: 1, fn: (a) => { const v = scalar(a[0]); return isErr(v) ? v : toStr(v).length; } },
  UPPER: { min: 1, max: 1, fn: (a) => { const v = scalar(a[0]); return isErr(v) ? v : toStr(v).toUpperCase(); } },
  LOWER: { min: 1, max: 1, fn: (a) => { const v = scalar(a[0]); return isErr(v) ? v : toStr(v).toLowerCase(); } },
  TRIM: { min: 1, max: 1, fn: (a) => { const v = scalar(a[0]); return isErr(v) ? v : toStr(v).trim().replace(/\s+/g, " "); } },
};
FUNCS.CONCATENATE = FUNCS.CONCAT;

export const FUNCTION_NAMES = Object.keys(FUNCS).sort();

export interface Grid {
  raw(r: number, c: number): string;
  rowCount(): number;
}

/** Evaluates formulas against a grid, caching results until invalidated. */
export class Engine {
  private cache = new Map<number, Val>();
  private active = new Set<number>();
  private asts = new Map<string, Node | FErr>();

  constructor(private readonly grid: Grid) {}

  invalidate() {
    this.cache.clear();
  }

  /** The value a cell shows: a literal for normal text, a result for formulas. */
  value(r: number, c: number): Val {
    const raw = this.grid.raw(r, c);
    if (raw.length === 0 || raw.charCodeAt(0) !== 61 /* = */) return literal(raw);
    const key = r * 65536 + c;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    if (this.active.has(key)) return ERR.circ;
    this.active.add(key);
    let v: Val;
    try {
      const ast = this.compile(raw);
      v = isErr(ast) ? ast : scalar(this.eval(ast));
      if (typeof v === "number" && !Number.isFinite(v)) v = ERR.div0;
    } catch (e) {
      v = isErr(e) ? e : ERR.parse; // includes stack overflow on very deep chains
    } finally {
      this.active.delete(key);
    }
    this.cache.set(key, v);
    return v;
  }

  display(r: number, c: number): string {
    const raw = this.grid.raw(r, c);
    if (raw.length === 0 || raw.charCodeAt(0) !== 61) return raw;
    return toStr(this.value(r, c));
  }

  private compile(src: string): Node | FErr {
    let ast = this.asts.get(src);
    if (ast === undefined) {
      try { ast = parse(src.slice(1)); } catch (e) { ast = isErr(e) ? e : ERR.parse; }
      if (this.asts.size > 5000) this.asts.clear();
      this.asts.set(src, ast);
    }
    return ast;
  }

  private eval(n: Node): Arg {
    switch (n.k) {
      case "lit": return n.v;
      case "ref": return this.value(n.r, n.c);
      case "range": {
        const r1 = n.r1 < 0 ? 0 : n.r1;
        const r2 = n.r2 < 0 ? this.grid.rowCount() - 1 : Math.min(n.r2, this.grid.rowCount() - 1);
        const self = this;
        return {
          k: "rangeVal",
          vals: function* () {
            for (let r = r1; r <= r2; r++) for (let c = n.c1; c <= n.c2; c++) yield self.value(r, c);
          },
        };
      }
      case "neg": { const x = toNum(scalar(this.eval(n.a))); return isErr(x) ? x : -x; }
      case "pct": { const x = toNum(scalar(this.eval(n.a))); return isErr(x) ? x : x / 100; }
      case "fn": {
        const f = FUNCS[n.name];
        if (!f) return ERR.name;
        if (n.args.length < f.min || n.args.length > f.max) return ERR.value;
        if (f.lazy) return f.fn([], (i) => this.eval(n.args[i]), n.args.length);
        const args = n.args.map((a) => this.eval(a));
        return f.fn(args, (i) => args[i], args.length);
      }
      case "bin": {
        const a = scalar(this.eval(n.a));
        const b = scalar(this.eval(n.b));
        if (isErr(a)) return a;
        if (isErr(b)) return b;
        if (n.op === "&") return toStr(a) + toStr(b);
        if (BIN_PREC[n.op] === 1) return compare(a, b, n.op);
        const x = toNum(a); if (isErr(x)) return x;
        const y = toNum(b); if (isErr(y)) return y;
        switch (n.op) {
          case "+": return x + y;
          case "-": return x - y;
          case "*": return x * y;
          case "/": return y === 0 ? ERR.div0 : x / y;
          case "^": return Math.pow(x, y);
        }
        return ERR.value;
      }
    }
  }
}

function compare(a: Val, b: Val, op: string): boolean {
  let d: number;
  const an = typeof a === "number" ? a : typeof a === "string" ? parseNum(a) : NaN;
  const bn = typeof b === "number" ? b : typeof b === "string" ? parseNum(b) : NaN;
  if (!Number.isNaN(an) && !Number.isNaN(bn) && typeof a !== "boolean" && typeof b !== "boolean") d = an - bn;
  else { const x = toStr(a).toLowerCase(); const y = toStr(b).toLowerCase(); d = x < y ? -1 : x > y ? 1 : 0; }
  switch (op) {
    case "=": return d === 0;
    case "<>": return d !== 0;
    case "<": return d < 0;
    case ">": return d > 0;
    case "<=": return d <= 0;
    default: return d >= 0;
  }
}

/** How a plain (non-formula) cell behaves when a formula reads it. */
function literal(raw: string): Val {
  if (raw === "") return "";
  const n = parseNum(raw);
  if (!Number.isNaN(n)) return n;
  const u = raw.toUpperCase();
  if (u === "TRUE") return true;
  if (u === "FALSE") return false;
  return raw;
}

export function isFormulaError(v: Val): boolean {
  return v instanceof FErr;
}

/**
 * Rewrite cell references in a formula after rows/columns are inserted or
 * deleted. `at` is the first affected index, `delta` how many were added
 * (positive) or removed (negative). References into removed cells → #REF!.
 */
export function shiftFormula(src: string, axis: "row" | "col", at: number, delta: number): string {
  if (!src.startsWith("=")) return src;
  let toks: Tok[];
  try { toks = tokenize(src.slice(1)); } catch { return src; }
  const body = src.slice(1);
  let out = "";
  let last = 0;
  const shift = (i: number): number | null => {
    if (i < at) return i;
    if (delta < 0 && i < at - delta) return null; // removed
    return i + delta;
  };
  for (const t of toks) {
    let rep: string | null = null;
    if (t.t === "ref") {
      const r = axis === "row" ? shift(t.r) : t.r;
      const c = axis === "col" ? shift(t.c) : t.c;
      rep = r === null || c === null ? "#REF!" : (t.ca ? "$" : "") + colName(c) + (t.ra ? "$" : "") + (r + 1);
    } else if (t.t === "cols" && axis === "col") {
      const c1 = shift(t.c1);
      const c2 = shift(t.c2);
      rep = c1 === null || c2 === null ? "#REF!" : (t.a1 ? "$" : "") + colName(c1) + ":" + (t.a2 ? "$" : "") + colName(c2);
    }
    if (rep !== null) {
      out += body.slice(last, t.s) + rep;
      last = t.e;
    }
  }
  return "=" + out + body.slice(last);
}

/** Rewrite references after rows/columns were reordered: old index → new index. */
export function remapFormula(src: string, axis: "row" | "col", map: (i: number) => number): string {
  if (!src.startsWith("=")) return src;
  let toks: Tok[];
  try { toks = tokenize(src.slice(1)); } catch { return src; }
  const body = src.slice(1);
  let out = "";
  let last = 0;
  for (const t of toks) {
    let rep: string | null = null;
    if (t.t === "ref") {
      const r = axis === "row" ? map(t.r) : t.r;
      const c = axis === "col" ? map(t.c) : t.c;
      if (r !== t.r || c !== t.c) rep = (t.ca ? "$" : "") + colName(c) + (t.ra ? "$" : "") + (r + 1);
    } else if (t.t === "cols" && axis === "col") {
      const c1 = map(t.c1), c2 = map(t.c2);
      if (c1 !== t.c1 || c2 !== t.c2) rep = (t.a1 ? "$" : "") + colName(Math.min(c1, c2)) + ":" + (t.a2 ? "$" : "") + colName(Math.max(c1, c2));
    }
    if (rep !== null) {
      out += body.slice(last, t.s) + rep;
      last = t.e;
    }
  }
  return "=" + out + body.slice(last);
}

/**
 * Move a formula's relative references by (dr, dc), as when it's copied
 * to another cell. $-anchored parts stay put. Off-grid → #REF!.
 */
export function offsetFormula(src: string, dr: number, dc: number): string {
  if (!src.startsWith("=") || (dr === 0 && dc === 0)) return src;
  let toks: Tok[];
  try { toks = tokenize(src.slice(1)); } catch { return src; }
  const body = src.slice(1);
  let out = "";
  let last = 0;
  for (const t of toks) {
    let rep: string | null = null;
    if (t.t === "ref") {
      const r = t.ra ? t.r : t.r + dr;
      const c = t.ca ? t.c : t.c + dc;
      rep = r < 0 || c < 0 ? "#REF!" : (t.ca ? "$" : "") + colName(c) + (t.ra ? "$" : "") + (r + 1);
    } else if (t.t === "cols") {
      const c1 = t.a1 ? t.c1 : t.c1 + dc;
      const c2 = t.a2 ? t.c2 : t.c2 + dc;
      rep = c1 < 0 || c2 < 0 ? "#REF!" : (t.a1 ? "$" : "") + colName(c1) + ":" + (t.a2 ? "$" : "") + colName(c2);
    }
    if (rep !== null) { out += body.slice(last, t.s) + rep; last = t.e; }
  }
  return "=" + out + body.slice(last);
}
