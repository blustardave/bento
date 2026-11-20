/* ------------------------------------------------------------------ *
 * Formula language core: values, tokens, parsing and coercions.
 * The engine (formula.ts) evaluates; functions.ts holds the library.
 * ------------------------------------------------------------------ */
import { parseDate } from "./format";
import { colIndex, parseNum } from "./util";

export class FErr {
  constructor(public readonly code: string) {}
  toString() { return this.code; }
}
export type Val = number | string | boolean | FErr;

export const ERR = {
  value: new FErr("#VALUE!"),
  div0: new FErr("#DIV/0!"),
  name: new FErr("#NAME?"),
  ref: new FErr("#REF!"),
  circ: new FErr("#CIRC!"),
  parse: new FErr("#ERROR!"),
  na: new FErr("#N/A"),
  num: new FErr("#NUM!"),
  spill: new FErr("#SPILL!"),
  calc: new FErr("#CALC!"),
};

/* --------------------------- evaluated values --------------------------- */

/** A rectangle of cells on some sheet, read lazily. */
export interface RefV { k: "ref"; eng: EngineLike; r1: number; c1: number; r2: number; c2: number }
/** An in-memory array (rows of columns). */
export interface ArrV { k: "arr"; v: Val[][] }
/** A LAMBDA, with the variables it closed over. */
export interface LamV { k: "lam"; params: string[]; body: Node; env: Env }
/** An argument that was left out, e.g. the third in XLOOKUP(a, b, c, , 2). */
export interface OmitV { k: "omit" }
export type Any = Val | RefV | ArrV | LamV | OmitV;

export const OMIT: OmitV = { k: "omit" };

export interface EngineLike {
  value(r: number, c: number): Val;
  rowCount(): number;
  colCount(): number;
  sheetName(): string;
}

export type Env = { vars: Map<string, Any>; parent: Env } | null;

export function lookupEnv(env: Env, name: string): Any | undefined {
  for (let e = env; e; e = e.parent) { const v = e.vars.get(name); if (v !== undefined) return v; }
  return undefined;
}

export const isErr = (v: unknown): v is FErr => v instanceof FErr;
export const isRef = (v: Any): v is RefV => typeof v === "object" && !isErr(v) && (v as RefV).k === "ref";
export const isArr = (v: Any): v is ArrV => typeof v === "object" && !isErr(v) && (v as ArrV).k === "arr";
export const isLam = (v: Any): v is LamV => typeof v === "object" && !isErr(v) && (v as LamV).k === "lam";
export const isOmit = (v: Any): v is OmitV => typeof v === "object" && !isErr(v) && (v as OmitV).k === "omit";
export const isMulti = (v: Any): v is RefV | ArrV => isRef(v) || isArr(v);

export function dims(v: Any): [number, number] {
  if (isRef(v)) return [v.r2 - v.r1 + 1, v.c2 - v.c1 + 1];
  if (isArr(v)) return [v.v.length, v.v[0]?.length ?? 0];
  return [1, 1];
}

/** Cell (i, j) of a range/array (0-based within it). */
export function at(v: Any, i: number, j: number): Val {
  if (isRef(v)) return v.eng.value(v.r1 + i, v.c1 + j);
  if (isArr(v)) return v.v[i]?.[j] ?? ERR.na;
  if (isLam(v)) return ERR.calc;
  if (isOmit(v)) return "";
  return v;
}

/** The whole thing as an array of values. */
export function toArr(v: Any): Val[][] {
  if (isArr(v)) return v.v;
  if (isRef(v)) {
    const out: Val[][] = [];
    for (let r = v.r1; r <= v.r2; r++) {
      const row: Val[] = [];
      for (let c = v.c1; c <= v.c2; c++) row.push(v.eng.value(r, c));
      out.push(row);
    }
    return out;
  }
  return [[at(v, 0, 0)]];
}

/** Every value, row by row. */
export function* each(v: Any): Iterable<Val> {
  if (isRef(v)) { for (let r = v.r1; r <= v.r2; r++) for (let c = v.c1; c <= v.c2; c++) yield v.eng.value(r, c); }
  else if (isArr(v)) { for (const row of v.v) yield* row; }
  else yield at(v, 0, 0);
}

/** One value: the top-left of a range/array. */
export function scalar(v: Any): Val {
  if (isMulti(v)) { const [h, w] = dims(v); return h && w ? at(v, 0, 0) : ""; }
  if (isLam(v)) return ERR.calc;
  if (isOmit(v)) return "";
  return v;
}

export const arr = (v: Val[][]): ArrV => ({ k: "arr", v });
export const col = (v: Val[]): ArrV => arr(v.map((x) => [x]));

/* ------------------------------ coercions ------------------------------ */

const DAY = 86400000;
const EPOCH = Date.UTC(1899, 11, 30);
export const serialOf = (d: Date) => (d.getTime() - EPOCH) / DAY;
export const dateOf = (n: number) => new Date(EPOCH + Math.round(n * DAY));
export const serialYMD = (y: number, m: number, d: number) => (Date.UTC(y, m - 1, d) - EPOCH) / DAY;

const DATEISH = /^\d{4}-\d{1,2}-\d{1,2}|^\d{1,2}[/.]\d{1,2}[/.]\d{4}$|^\d{1,2}\s+[A-Za-z]{3}/;

export function toNum(v: Val): number | FErr {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (isErr(v)) return v;
  if (v === "") return 0;
  const n = parseNum(v);
  if (!Number.isNaN(n)) return n;
  if (DATEISH.test(v.trim())) {
    const d = parseDate(v);
    if (d) {
      let s = serialOf(d);
      const t = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(v);
      if (t) s += (+t[1] * 3600 + +t[2] * 60 + +(t[3] ?? 0)) / 86400;
      return s;
    }
  }
  return ERR.value;
}

export function toStr(v: Val): string {
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (isErr(v)) return v.code;
  return formatNumber(v);
}

export function toBool(v: Val): boolean | FErr {
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
  return String(Number(n.toPrecision(12)));
}

/** How a plain (non-formula) cell behaves when a formula reads it. */
export function literal(raw: string): Val {
  if (raw === "") return "";
  const n = parseNum(raw);
  if (!Number.isNaN(n)) return n;
  const u = raw.toUpperCase();
  if (u === "TRUE") return true;
  if (u === "FALSE") return false;
  if (raw.charCodeAt(0) === 35 /* # */) { const e = ERROR_CODES.find((x) => x === u); if (e) return new FErr(e); }
  return raw;
}

const ERROR_CODES = ["#VALUE!", "#DIV/0!", "#NAME?", "#REF!", "#N/A", "#NUM!", "#NULL!", "#SPILL!", "#CALC!", "#CIRC!", "#ERROR!"];

/** Compare two values like Excel: numbers before text before booleans; text case-insensitive. */
export function cmp(a: Val, b: Val): number {
  const rank = (v: Val) => typeof v === "number" ? 0 : typeof v === "string" ? 1 : typeof v === "boolean" ? 2 : 3;
  if (a === "" && b !== "") return typeof b === "number" ? cmp(0, b) : typeof b === "string" ? -1 : cmp(false, b);
  if (b === "" && a !== "") return -cmp(b, a);
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === "number") return a - (b as number);
  if (typeof a === "string") { const x = a.toLowerCase(), y = (b as string).toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
  if (typeof a === "boolean") return Number(a) - Number(b as boolean);
  return 0;
}

/** = comparison used by operators: numbers (and numeric text) compare as numbers. */
export function compareOp(a: Val, b: Val, op: string): boolean {
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

/** Wildcard text match: * any run, ? one character, ~ escapes. */
export function wildcard(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "~" && i + 1 < pattern.length) { re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue; }
    re += ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$", "is");
}

/** A COUNTIF-style criterion: 5, ">5", "<>x", "app*", "=". */
export function criterion(c: Val): (v: Val) => boolean {
  if (typeof c === "number" || typeof c === "boolean") return (v) => typeof v === typeof c ? v === c : typeof v === "string" && toNum(v) === c && typeof c === "number";
  if (isErr(c)) return (v) => isErr(v) && v.code === c.code;
  const m = /^(<>|>=|<=|=|<|>)?([\s\S]*)$/.exec(c)!;
  const op = m[1] ?? "=";
  const rhs = m[2];
  const n = rhs === "" ? NaN : parseNum(rhs);
  const dn = Number.isNaN(n) && DATEISH.test(rhs) ? toNum(rhs) : NaN;
  const num = !Number.isNaN(n) ? n : typeof dn === "number" && !Number.isNaN(dn) ? dn : NaN;
  if (!Number.isNaN(num)) {
    return (v) => {
      const x = typeof v === "number" ? v : typeof v === "string" && v !== "" ? toNum(v) : NaN;
      if (typeof x !== "number" || Number.isNaN(x)) return op === "<>";
      switch (op) { case "=": return x === num; case "<>": return x !== num; case "<": return x < num; case ">": return x > num; case "<=": return x <= num; default: return x >= num; }
    };
  }
  if (op === "=" || op === "<>") {
    if (rhs === "") return op === "=" ? (v) => v === "" : (v) => v !== "";
    const re = /[*?~]/.test(rhs) ? wildcard(rhs) : null;
    const low = rhs.toLowerCase();
    const eq = (v: Val) => { if (isErr(v)) return false; const s = toStr(v); return re ? re.test(s) : s.toLowerCase() === low; };
    return op === "=" ? eq : (v) => !eq(v);
  }
  return (v) => typeof v === "string" && v !== "" && compareOp(v, rhs, op);
}

/* -------------------------------- tokens -------------------------------- */

export type Tok =
  | { t: "num"; v: number; s: number; e: number }
  | { t: "str"; v: string; s: number; e: number }
  | { t: "ref"; r: number; c: number; s: number; e: number; ra: boolean; ca: boolean; sh?: string; shs?: number }
  | { t: "cols"; c1: number; c2: number; s: number; e: number; a1: boolean; a2: boolean; sh?: string; shs?: number }
  | { t: "rows"; r1: number; r2: number; s: number; e: number; a1: boolean; a2: boolean; sh?: string; shs?: number }
  | { t: "id"; v: string; s: number; e: number }
  | { t: "op"; v: string; s: number; e: number }
  | { t: "err"; v: string; s: number; e: number };

const REF_RE = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)/;
const COLS_RE = /^(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9_(])/;
const ROWS_RE = /^(\$?)(\d+):(\$?)(\d+)(?![A-Za-z0-9_.(])/;
const SHEET_RE = /^(?:'((?:[^']|'')+)'|([A-Za-z_À-￿][A-Za-z0-9_.À-￿]*))!/;
const MAX_COL = 16384, MAX_ROW = 1048576;

/** Split formula text (without the "=") into tokens with their positions. */
export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i++; continue; }
    const rest = src.slice(i);
    let m: RegExpExecArray | null;
    // Sheet prefix: Sheet2!A1, 'My sheet'!A1:B4
    let sh: string | undefined, shs: number | undefined, j = i;
    if ((m = SHEET_RE.exec(rest)) && (REF_RE.test(rest.slice(m[0].length)) || COLS_RE.test(rest.slice(m[0].length)) || ROWS_RE.test(rest.slice(m[0].length)))) {
      sh = m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2];
      shs = i;
      j = i + m[0].length;
    }
    const r2 = src.slice(j);
    if (sh === undefined && (m = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(rest)) && !ROWS_RE.test(rest)) {
      out.push({ t: "num", v: Number(m[0]), s: i, e: i + m[0].length });
      i += m[0].length;
    } else if (sh === undefined && ch === '"') {
      let k = i + 1;
      let v = "";
      while (k < src.length) {
        if (src[k] === '"') { if (src[k + 1] === '"') { v += '"'; k += 2; continue; } break; }
        v += src[k++];
      }
      out.push({ t: "str", v, s: i, e: k + 1 });
      i = k + 1;
    } else if ((m = COLS_RE.exec(r2))) {
      out.push({ t: "cols", c1: colIndex(m[2].toUpperCase()), c2: colIndex(m[4].toUpperCase()), a1: !!m[1], a2: !!m[3], s: i, e: j + m[0].length, sh, shs });
      i = j + m[0].length;
    } else if ((m = ROWS_RE.exec(r2)) && (sh !== undefined || !/[\d.]/.test(src[i - 1] ?? ""))) {
      out.push({ t: "rows", r1: Number(m[2]) - 1, r2: Number(m[4]) - 1, a1: !!m[1], a2: !!m[3], s: i, e: j + m[0].length, sh, shs });
      i = j + m[0].length;
    } else if ((m = REF_RE.exec(r2)) && !/^[A-Za-z0-9_(.]/.test(r2.slice(m[0].length)) && colIndex(m[2].toUpperCase()) < MAX_COL && Number(m[4]) >= 1 && Number(m[4]) <= MAX_ROW) {
      out.push({ t: "ref", c: colIndex(m[2].toUpperCase()), r: Number(m[4]) - 1, ca: !!m[1], ra: !!m[3], s: i, e: j + m[0].length, sh, shs });
      i = j + m[0].length;
    } else if ((m = /^#(?:N\/A|[A-Z0-9/]+[!?])/.exec(rest))) {
      out.push({ t: "err", v: m[0], s: i, e: i + m[0].length });
      i += m[0].length;
    } else if ((m = /^[A-Za-z_\\À-￿][A-Za-z0-9_.À-￿]*/.exec(rest))) {
      out.push({ t: "id", v: m[0].toUpperCase(), s: i, e: i + m[0].length });
      i += m[0].length;
    } else if ((m = /^(<>|<=|>=|[-+*/^&=<>%(),:;{}#@])/.exec(rest))) {
      out.push({ t: "op", v: m[0], s: i, e: i + m[0].length });
      i += m[0].length;
    } else {
      throw ERR.parse;
    }
  }
  return out;
}

/* -------------------------------- syntax -------------------------------- */

export type Node = (
  | { k: "lit"; v: Val }
  | { k: "ref"; r: number; c: number; sh?: string }
  | { k: "range"; r1: number; c1: number; r2: number; c2: number; sh?: string } // r = -1 → whole column, c = -1 → whole row
  | { k: "name"; v: string }
  | { k: "fn"; name: string; args: Node[] }
  | { k: "call"; callee: Node; args: Node[] }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "neg"; a: Node }
  | { k: "pct"; a: Node }
  | { k: "paren"; a: Node }
  | { k: "array"; rows: Node[][] }
  | { k: "spill"; a: Node }
  | { k: "omit" }
) & { s: number; e: number };

const BIN_PREC: Record<string, number> = {
  "=": 1, "<>": 1, "<": 1, ">": 1, "<=": 1, ">=": 1,
  "&": 2, "+": 3, "-": 3, "*": 4, "/": 4, "^": 5,
};
export const COMPARE_OPS = new Set(["=", "<>", "<", ">", "<=", ">="]);

export function parse(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => { const t = toks[p]; return !!t && t.t === "op" && t.v === v; };
  const expect = (v: string) => { if (!isOp(v)) throw ERR.parse; p++; };
  const end = () => toks[p - 1]?.e ?? 0;

  function args(): Node[] {
    const out: Node[] = [];
    if (isOp(")")) return out;
    for (;;) {
      // An empty argument: f(a, , c)
      if (isOp(",") || isOp(";") || isOp(")")) { const s = toks[p].s; out.push({ k: "omit", s, e: s }); }
      else out.push(expr(0));
      if (isOp(",") || isOp(";")) { p++; continue; }
      break;
    }
    return out;
  }

  function primary(): Node {
    const t = toks[p++];
    if (!t) throw ERR.parse;
    const s = t.s;
    let node: Node;
    switch (t.t) {
      case "num": node = { k: "lit", v: t.v, s, e: t.e }; break;
      case "str": node = { k: "lit", v: t.v, s, e: t.e }; break;
      case "err": node = { k: "lit", v: new FErr(t.v), s, e: t.e }; break;
      case "cols": node = { k: "range", r1: -1, c1: Math.min(t.c1, t.c2), r2: -1, c2: Math.max(t.c1, t.c2), sh: t.sh, s, e: t.e }; break;
      case "rows": node = { k: "range", r1: Math.min(t.r1, t.r2), c1: -1, r2: Math.max(t.r1, t.r2), c2: -1, sh: t.sh, s, e: t.e }; break;
      case "ref": {
        if (isOp(":") && toks[p + 1]?.t === "ref" && !(toks[p + 1] as { sh?: string }).sh) {
          p++;
          const b = toks[p++] as Extract<Tok, { t: "ref" }>;
          node = { k: "range", r1: Math.min(t.r, b.r), c1: Math.min(t.c, b.c), r2: Math.max(t.r, b.r), c2: Math.max(t.c, b.c), sh: t.sh, s, e: b.e };
        } else node = { k: "ref", r: t.r, c: t.c, sh: t.sh, s, e: t.e };
        break;
      }
      case "id": {
        if (isOp("(")) {
          p++;
          const a = args();
          expect(")");
          node = { k: "fn", name: t.v.replace(/^_XLFN\./, ""), args: a, s, e: end() };
        } else if (t.v === "TRUE") node = { k: "lit", v: true, s, e: t.e };
        else if (t.v === "FALSE") node = { k: "lit", v: false, s, e: t.e };
        else node = { k: "name", v: t.v, s, e: t.e };
        break;
      }
      case "op": {
        if (t.v === "(") { const a = expr(0); expect(")"); node = { k: "paren", a, s, e: end() }; break; }
        if (t.v === "-") { const a = expr(6); node = { k: "neg", a, s, e: a.e }; break; }
        if (t.v === "+") return expr(6);
        if (t.v === "@") return primary();
        if (t.v === "{") {
          const rows: Node[][] = [[]];
          for (;;) {
            let sign = 1;
            if (isOp("-")) { p++; sign = -1; }
            const v = toks[p++];
            if (!v) throw ERR.parse;
            let lit: Val;
            if (v.t === "num") lit = sign * v.v;
            else if (v.t === "str") lit = v.v;
            else if (v.t === "err") lit = new FErr(v.v);
            else if (v.t === "id" && (v.v === "TRUE" || v.v === "FALSE")) lit = v.v === "TRUE";
            else throw ERR.parse;
            rows[rows.length - 1].push({ k: "lit", v: lit, s: v.s, e: v.e });
            if (isOp(",")) { p++; continue; }
            if (isOp(";")) { p++; rows.push([]); continue; }
            expect("}");
            break;
          }
          const w = rows[0].length;
          if (rows.some((r) => r.length !== w)) throw ERR.parse;
          node = { k: "array", rows, s, e: end() };
          break;
        }
        throw ERR.parse;
      }
    }
    // Postfix: A1# (spill range), LAMBDA(...)(args)
    for (;;) {
      if (isOp("#") && (node.k === "ref")) { p++; node = { k: "spill", a: node, s, e: end() }; continue; }
      if (isOp("(") && (node.k === "fn" || node.k === "call" || node.k === "paren")) {
        p++;
        const a = args();
        expect(")");
        node = { k: "call", callee: node, args: a, s, e: end() };
        continue;
      }
      break;
    }
    return node;
  }

  function expr(minPrec: number): Node {
    let left = primary();
    for (;;) {
      const t = peek();
      if (!t || t.t !== "op") break;
      if (t.v === "%") { p++; left = { k: "pct", a: left, s: left.s, e: t.e }; continue; }
      const prec = BIN_PREC[t.v];
      if (prec === undefined || prec < minPrec) break;
      p++;
      const right = expr(t.v === "^" ? prec : prec + 1);
      left = { k: "bin", op: t.v, a: left, b: right, s: left.s, e: right.e };
    }
    return left;
  }

  const n = expr(0);
  if (p < toks.length) throw ERR.parse;
  return n;
}

/* ------------------------- rewriting references ------------------------- */

type RefTok = Extract<Tok, { t: "ref" | "cols" | "rows" }>;

/** Rewrite each reference token; return text for it, or null to leave it alone. */
export function rewriteRefs(src: string, f: (t: RefTok, prefix: string) => string | null): string {
  if (!src.startsWith("=")) return src;
  let toks: Tok[];
  try { toks = tokenize(src.slice(1)); } catch { return src; }
  const body = src.slice(1);
  let out = "";
  let last = 0;
  for (const t of toks) {
    if (t.t !== "ref" && t.t !== "cols" && t.t !== "rows") continue;
    const prefix = t.shs !== undefined ? body.slice(t.shs, body.indexOf("!", t.shs) + 1) : "";
    const rep = f(t, prefix);
    if (rep !== null) { out += body.slice(last, t.s) + rep; last = t.e; }
  }
  return "=" + out + body.slice(last);
}

/** Text for a sheet name inside a reference: quoted when it needs to be. */
export function sheetPrefix(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !REF_RE.test(name) ? `${name}!` : `'${name.replace(/'/g, "''")}'!`;
}

/** Can this be used as a defined name? */
export function validName(name: string): boolean {
  if (!/^[A-Za-z_\\][A-Za-z0-9_.]*$/.test(name) || name.length > 255) return false;
  const u = name.toUpperCase();
  if (u === "TRUE" || u === "FALSE") return false;
  if (/^[A-Za-z]{1,3}\d+$/.test(name) && colIndex(name.replace(/\d+$/, "").toUpperCase()) < MAX_COL) return false; // looks like A1
  if (/^R\d*C\d*$/i.test(name)) return false;
  return true;
}
