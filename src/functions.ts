/* ------------------------------------------------------------------ *
 * The function library. Each entry has its argument limits, a
 * signature and one-line description (shown while typing), and either
 * `fn` (gets evaluated arguments) or `lazy` (gets syntax nodes, for
 * IF, LET, LAMBDA and friends).
 *
 * `lift` marks arguments that work cell-by-cell: pass a range there and
 * the function runs once per cell, giving an array.
 * ------------------------------------------------------------------ */
import {
  Any, ERR, Env, FErr, LamV, Node, RefV, Val,
  arr, at, cmp, col, criterion, dateOf, dims, each, isArr, isErr, isLam, isMulti, isOmit, isRef,
  scalar, serialYMD, toArr, toBool, toNum, toStr, wildcard, OMIT, formatNumber,
} from "./fcore";
import { colName, parseNum } from "./util";

export interface Ctx {
  /** Evaluate a node in the current scope (or a given one). */
  ev(n: Node, env?: Env): Any;
  env: Env;
  call(l: LamV, args: Any[]): Any;
  /** The cell being calculated. */
  r: number; c: number;
  /** A reference from text, for INDIRECT. */
  refFromText(text: string): RefV | FErr;
  /** A sub-range of a reference (for INDEX / OFFSET), clipped to the sheet. */
  subRef(ref: RefV, r1: number, c1: number, r2: number, c2: number): RefV | FErr;
}

export type Cat = "Math" | "Statistics" | "Logic" | "Lookup" | "Text" | "Date" | "Finance" | "Info" | "Array" | "Lambda";

export interface FnSpec {
  min: number;
  max: number;
  /** e.g. "SUMIF(range, criterion, [sum_range])" */
  sig: string;
  desc: string;
  cat: Cat;
  fn?: (a: Any[], x: Ctx) => Any;
  lazy?: (n: Node[], x: Ctx) => Any;
  lift?: number[] | true;
  /** May give an array that spills. */
  spills?: boolean;
  /** Result is a date (or date-time) serial. */
  date?: "date" | "datetime";
  volatile?: boolean;
}

/* ------------------------------- helpers ------------------------------- */

const N = (a: Any | undefined): number | FErr => toNum(scalar(a ?? 0));
const S = (a: Any | undefined): string | FErr => { const v = scalar(a ?? ""); return isErr(v) ? v : toStr(v); };
const B = (a: Any | undefined): boolean | FErr => toBool(scalar(a ?? false));
const given = (a: Any | undefined): a is Any => a !== undefined && !isOmit(a);
const opt = <T>(a: Any | undefined, f: (a: Any) => T | FErr, d: T): T | FErr => given(a) ? f(a) : d;
const optN = (a: Any | undefined, d: number) => opt(a, N, d);
const optB = (a: Any | undefined, d: boolean) => opt(a, B, d);

/** Run `f` with numbers, bailing out on the first error. */
function num(...xs: (number | FErr | boolean | string)[]): FErr | null {
  for (const x of xs) if (isErr(x)) return x;
  return null;
}

/** Numbers for aggregates: from ranges only real numbers count; typed-in arguments are converted. */
function numbers(args: Any[]): number[] | FErr {
  const out: number[] = [];
  for (const a of args) {
    if (isOmit(a)) continue;
    if (isMulti(a)) {
      for (const v of each(a)) {
        if (isErr(v)) return v;
        if (typeof v === "number") out.push(v);
      }
    } else {
      const v = scalar(a);
      if (isErr(v)) return v;
      const n = toNum(v);
      if (isErr(n)) return n;
      out.push(n);
    }
  }
  return out;
}

const sum = (xs: number[]) => { let s = 0; for (const x of xs) s += x; return s; };
const mean = (xs: number[]) => xs.length ? sum(xs) / xs.length : ERR.div0;
function variance(xs: number[], sample: boolean): number | FErr {
  if (xs.length < (sample ? 2 : 1)) return ERR.div0;
  const m = sum(xs) / xs.length;
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return s / (xs.length - (sample ? 1 : 0));
}
function sorted(xs: number[]) { return [...xs].sort((a, b) => a - b); }
function percentile(xs: number[], k: number): number | FErr {
  if (!xs.length || k < 0 || k > 1) return ERR.num;
  const s = sorted(xs);
  const pos = (s.length - 1) * k;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Resize a range to h × w from its top-left (SUMIF's sum_range rule). */
function resized(a: Any, h: number, w: number): Any {
  if (isRef(a)) return { ...a, r2: a.r1 + h - 1, c2: a.c1 + w - 1 };
  return a;
}

/** Cells matching every (range, criterion) pair. */
function matching(pairs: Any[], x: Ctx, sizeFrom?: Any): { h: number; w: number; hit: (i: number, j: number) => boolean } | FErr {
  if (pairs.length % 2) return ERR.value;
  const [h, w] = dims(sizeFrom ?? pairs[0]);
  const tests: { r: Any; f: (v: Val) => boolean }[] = [];
  for (let k = 0; k < pairs.length; k += 2) {
    const [ph, pw] = dims(pairs[k]);
    if (ph !== h || pw !== w) return ERR.value;
    const c = scalar(pairs[k + 1]);
    tests.push({ r: pairs[k], f: criterion(c) });
  }
  void x;
  return { h, w, hit: (i, j) => tests.every((t) => t.f(at(t.r, i, j))) };
}

/** Compare for lookups: exact (with wildcards for text when allowed). */
function same(a: Val, b: Val, wild: boolean): boolean {
  if (typeof a === "string" && typeof b === "string") {
    if (wild && /[*?~]/.test(a)) return wildcard(a).test(b);
    return a.toLowerCase() === b.toLowerCase();
  }
  if (typeof a === "number" && typeof b === "string") return toNum(b) === a && b !== "";
  if (typeof b === "number" && typeof a === "string") return toNum(a) === b && a !== "";
  return a === b;
}

/** Index of the match in a 1-D list, or -1. mode: 0 exact, -1 next smaller, 1 next larger, 2 wildcard. */
function findIn(list: Val[], v: Val, mode: number, reverse = false): number {
  let best = -1;
  const order = reverse ? list.map((_, i) => list.length - 1 - i) : list.map((_, i) => i);
  for (const i of order) {
    const x = list[i];
    if (same(v, x, mode === 2)) return i;
    if (mode === -1 && typeof x === typeof v && cmp(x, v) < 0 && (best < 0 || cmp(x, list[best]) > 0)) best = i;
    if (mode === 1 && typeof x === typeof v && cmp(x, v) > 0 && (best < 0 || cmp(x, list[best]) < 0)) best = i;
  }
  return best;
}

/** MATCH/VLOOKUP's sorted search: last item ≤ v (or first ≥ v when descending). */
function approx(list: Val[], v: Val, desc = false): number {
  let best = -1;
  for (let i = 0; i < list.length; i++) {
    const x = list[i];
    if (x === "" || typeof x !== typeof v) continue;
    const d = cmp(x, v);
    if (!desc && d <= 0) best = i;
    else if (desc && d >= 0) best = i;
    else break;
  }
  return best;
}

const flat1 = (a: Any): Val[] => [...each(a)];
const rowOf = (a: Any, i: number): Val[] => toArr(a)[i] ?? [];
const colOf = (a: Any, j: number): Val[] => toArr(a).map((r) => r[j]);

/** Pick rows (or columns) of a 2-D array. */
const pickRows = (m: Val[][], idx: number[]) => idx.map((i) => m[i]);
const transpose = (m: Val[][]): Val[][] => (m[0] ?? []).map((_, j) => m.map((r) => r[j]));


/** Excel-style number/date formats for TEXT(). */
export function textFormat(v: Val, f: string): string {
  const n = toNum(v);
  if (isErr(n)) return toStr(v);
  if (/[yd]|m{3,}|h|s/i.test(f.replace(/"[^"]*"/g, "")) && !/[#0]/.test(f.replace(/"[^"]*"/g, ""))) {
    const d = dateOf(n);
    const Y = d.getUTCFullYear(), Mo = d.getUTCMonth(), D = d.getUTCDate(), wd = d.getUTCDay();
    const frac = n - Math.floor(n);
    let secs = Math.round(frac * 86400);
    const H = Math.floor(secs / 3600); secs -= H * 3600;
    const Mi = Math.floor(secs / 60); const Se = secs - Mi * 60;
    const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const ampm = /am\/pm|a\/p/i.test(f);
    const p2 = (x: number) => String(x).padStart(2, "0");
    let out = "";
    const toks = f.match(/"[^"]*"|yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|am\/pm|a\/p|./gi) ?? [];
    let lastWasHour = false;
    for (const t of toks) {
      const l = t.toLowerCase();
      if (t.startsWith('"')) { out += t.slice(1, -1); continue; }
      if (l === "yyyy") out += Y;
      else if (l === "yy") out += p2(Y % 100);
      else if (l === "mmmm") out += MONTHS[Mo];
      else if (l === "mmm") out += MONTHS[Mo].slice(0, 3);
      else if (l === "mm" || l === "m") out += lastWasHour ? (l === "mm" ? p2(Mi) : Mi) : l === "mm" ? p2(Mo + 1) : Mo + 1;
      else if (l === "dddd") out += DAYS[wd];
      else if (l === "ddd") out += DAYS[wd].slice(0, 3);
      else if (l === "dd") out += p2(D);
      else if (l === "d") out += D;
      else if (l === "hh" || l === "h") { const h = ampm ? ((H + 11) % 12) + 1 : H; out += l === "hh" ? p2(h) : h; }
      else if (l === "ss") out += p2(Se);
      else if (l === "s") out += Se;
      else if (l === "am/pm") out += H < 12 ? "AM" : "PM";
      else if (l === "a/p") out += H < 12 ? "A" : "P";
      else out += t;
      if (l === "hh" || l === "h") lastWasHour = true;
      else if (!/^[:\s]$/.test(t)) lastWasHour = false;
    }
    return out;
  }
  // Numbers: 0, 0.00, #,##0, 0%, $#,##0.00, 0.0E+0
  const [pos, neg] = f.split(";");
  const fmt = n < 0 && neg !== undefined ? neg : pos;
  const x = n < 0 && neg !== undefined ? -n : n;
  const lit = fmt.replace(/"([^"]*)"/g, "\u0001$1\u0001");
  const m = /[#0?][#0?,.]*%?|[#0?][#0?,.]*E[+-]0+/i.exec(lit);
  if (!m) return fmt.replace(/"/g, "");
  const code = m[0];
  let body: string;
  if (/E/i.test(code)) {
    const dp = (code.split(".")[1] ?? "").replace(/E.*/i, "").length;
    body = x.toExponential(dp).toUpperCase().replace("E+", "E+").replace(/E([+-])(\d)$/, "E$10$2");
  } else {
    const pct = code.endsWith("%") || lit.includes("%");
    const v = pct ? x * 100 : x;
    const dec = (code.replace("%", "").split(".")[1] ?? "");
    const dp = dec.length;
    const minDp = (dec.match(/0/g) ?? []).length;
    const grouped = code.includes(",");
    body = new Intl.NumberFormat("en-GB", { useGrouping: grouped, minimumFractionDigits: minDp, maximumFractionDigits: dp }).format(Math.abs(v));
    const intZeros = (code.split(".")[0].match(/0/g) ?? []).length;
    if (intZeros === 0 && body.startsWith("0") && dp > 0) body = body.slice(1);
    if (v < 0 && neg === undefined) body = "-" + body;
  }
  return lit.slice(0, m.index).replace(/\u0001/g, "") + body + lit.slice(m.index + code.length).replace(/\u0001/g, "");
}

/* -------------------------------- dates -------------------------------- */

const ymd = (n: number) => { const d = dateOf(Math.floor(n)); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()] as const; };
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function addMonths(n: number, k: number): number {
  const [y, m, d] = ymd(n);
  const t = m - 1 + k;
  const ny = y + Math.floor(t / 12), nm = ((t % 12) + 12) % 12 + 1;
  return serialYMD(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}
const weekday = (n: number) => dateOf(Math.floor(n)).getUTCDay(); // 0 = Sunday
function holidaySet(a: Any | undefined): Set<number> | FErr {
  const out = new Set<number>();
  if (!given(a)) return out;
  for (const v of each(a)) { if (v === "") continue; const n = toNum(v); if (isErr(n)) return n; out.add(Math.floor(n)); }
  return out;
}

/* ------------------------------- finance ------------------------------- */

function pmt(rate: number, n: number, pv: number, fv: number, type: number) {
  if (rate === 0) return -(pv + fv) / n;
  const f = (1 + rate) ** n;
  return -(rate * (fv + pv * f)) / ((1 + rate * type) * (f - 1));
}
function fvOf(rate: number, n: number, p: number, pv: number, type: number) {
  if (rate === 0) return -(pv + p * n);
  const f = (1 + rate) ** n;
  return -(pv * f + p * (1 + rate * type) * (f - 1) / rate);
}
function ipmt(rate: number, per: number, n: number, pv: number, fv: number, type: number) {
  const p = pmt(rate, n, pv, fv, type);
  if (per === 1 && type === 1) return 0;
  const bal = fvOf(rate, per - 1, p, pv, type);
  const i = bal * rate;
  return type === 1 ? i / (1 + rate) : i;
}
/** Solve f(r) = 0 near `guess` (Newton, then bisection as a fallback). */
function solve(f: (r: number) => number, guess: number): number | FErr {
  let r = guess;
  for (let k = 0; k < 100; k++) {
    const y = f(r);
    if (Math.abs(y) < 1e-10) return r;
    const h = 1e-7;
    const dy = (f(r + h) - y) / h;
    if (!Number.isFinite(dy) || dy === 0) break;
    const next = r - y / dy;
    if (!Number.isFinite(next) || next <= -1) break;
    if (Math.abs(next - r) < 1e-12) return next;
    r = next;
  }
  let lo = -0.9999, hi = 10;
  let flo = f(lo), fhi = f(hi);
  if (!(flo * fhi < 0)) return ERR.num;
  for (let k = 0; k < 300; k++) {
    const mid = (lo + hi) / 2, fm = f(mid);
    if (Math.abs(fm) < 1e-10) return mid;
    if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  void fhi;
  return (lo + hi) / 2;
}

/* ------------------------------- arrays ------------------------------- */

function sortRows(m: Val[][], keys: { j: number; desc: boolean; by?: Val[] }[]): Val[][] {
  const idx = m.map((_, i) => i);
  idx.sort((a, b) => {
    for (const k of keys) {
      const x = k.by ? k.by[a] : m[a][k.j], y = k.by ? k.by[b] : m[b][k.j];
      const d = cmp(x, y);
      if (d) return k.desc ? -d : d;
    }
    return a - b;
  });
  return pickRows(m, idx);
}

const lamOf = (a: Any | undefined): LamV | FErr => a && isLam(a) ? a : ERR.value;
const asVal = (a: Any): Val => isMulti(a) ? scalar(a) : isLam(a) ? ERR.calc : isOmit(a) ? "" : a;

/* ------------------------------- library ------------------------------- */

export const FUNCS: Record<string, FnSpec> = {};
function def(name: string, spec: Omit<FnSpec, "sig"> & { sig?: string; args?: string }) {
  FUNCS[name] = { sig: spec.sig ?? `${name}(${spec.args ?? ""})`, ...spec } as FnSpec;
}
const alias = (a: string, b: string) => { FUNCS[a] = { ...FUNCS[b], sig: FUNCS[b].sig.replace(/^[A-Z0-9.]+/, a) }; };

/* Math */
def("SUM", { min: 1, max: 255, args: "value1, [value2, …]", desc: "Adds up numbers and ranges.", cat: "Math", fn: (a) => { const n = numbers(a); return isErr(n) ? n : sum(n); } });
def("SUMPRODUCT", { min: 1, max: 255, args: "array1, [array2, …]", desc: "Multiplies matching items in the arrays, then adds them up.", cat: "Math", fn: (a) => {
  const ms = a.map(toArr);
  const [h, w] = [ms[0].length, ms[0][0]?.length ?? 0];
  if (ms.some((m) => m.length !== h || (m[0]?.length ?? 0) !== w)) return ERR.value;
  let s = 0;
  for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) {
    let p = 1;
    for (const m of ms) { const v = m[i][j]; if (isErr(v)) return v; p *= typeof v === "number" ? v : typeof v === "boolean" && ms.length === 1 ? 0 : typeof v === "boolean" ? Number(v) : 0; }
    s += p;
  }
  return s;
} });
def("SUMSQ", { min: 1, max: 255, args: "value1, [value2, …]", desc: "Sum of the squares.", cat: "Math", fn: (a) => { const n = numbers(a); return isErr(n) ? n : sum(n.map((x) => x * x)); } });
def("PRODUCT", { min: 1, max: 255, args: "value1, [value2, …]", desc: "Multiplies numbers together.", cat: "Math", fn: (a) => { const n = numbers(a); return isErr(n) ? n : n.reduce((s, x) => s * x, 1); } });
def("ABS", { min: 1, max: 1, args: "number", desc: "The number without its sign.", cat: "Math", lift: true, fn: (a) => { const x = N(a[0]); return isErr(x) ? x : Math.abs(x); } });
const roundTo = (x: number, d: number, mode: "round" | "up" | "down") => {
  const f = 10 ** Math.trunc(d);
  const v = Math.abs(x) * f;
  const r = mode === "round" ? Math.round(v + 1e-9) : mode === "up" ? Math.ceil(v - 1e-9) : Math.floor(v + 1e-9);
  return Math.sign(x) * r / f;
};
def("ROUND", { min: 1, max: 2, args: "number, [places]", desc: "Rounds to a number of decimal places.", cat: "Math", lift: true, fn: (a) => { const x = N(a[0]), d = optN(a[1], 0); return num(x, d) ?? roundTo(x as number, d as number, "round"); } });
def("ROUNDUP", { min: 1, max: 2, args: "number, [places]", desc: "Rounds away from zero.", cat: "Math", lift: true, fn: (a) => { const x = N(a[0]), d = optN(a[1], 0); return num(x, d) ?? roundTo(x as number, d as number, "up"); } });
def("ROUNDDOWN", { min: 1, max: 2, args: "number, [places]", desc: "Rounds towards zero.", cat: "Math", lift: true, fn: (a) => { const x = N(a[0]), d = optN(a[1], 0); return num(x, d) ?? roundTo(x as number, d as number, "down"); } });
def("MROUND", { min: 2, max: 2, args: "number, multiple", desc: "Rounds to the nearest multiple.", cat: "Math", lift: true, fn: (a) => { const x = N(a[0]), m = N(a[1]); if (num(x, m)) return num(x, m)!; if (m === 0) return 0; if (Math.sign(x as number) * Math.sign(m as number) < 0) return ERR.num; return Math.round((x as number) / (m as number) + 1e-12) * (m as number); } });
const ceilFloor = (up: boolean) => (a: Any[]) => {
  const x = N(a[0]), s = optN(a[1], 1);
  if (num(x, s)) return num(x, s)!;
  if (s === 0) return 0;
  const k = Math.abs(s as number);
  return (up ? Math.ceil((x as number) / k - 1e-12) : Math.floor((x as number) / k + 1e-12)) * k;
};
def("CEILING", { min: 1, max: 2, args: "number, [significance]", desc: "Rounds up to a multiple.", cat: "Math", lift: true, fn: ceilFloor(true) });
def("FLOOR", { min: 1, max: 2, args: "number, [significance]", desc: "Rounds down to a multiple.", cat: "Math", lift: true, fn: ceilFloor(false) });
alias("CEILING.MATH", "CEILING"); alias("FLOOR.MATH", "FLOOR");
def("INT", { min: 1, max: 1, args: "number", desc: "Rounds down to a whole number.", cat: "Math", lift: true, fn: (a) => { const x = N(a[0]); return isErr(x) ? x : Math.floor(x); } });
def("TRUNC", { min: 1, max: 2, args: "number, [places]", desc: "Cuts off the decimals.", cat: "Math", lift: true, fn: (a) => { const x = N(a[0]), d = optN(a[1], 0); return num(x, d) ?? roundTo(x as number, d as number, "down"); } });
def("MOD", { min: 2, max: 2, args: "number, divisor", desc: "The remainder after dividing.", cat: "Math", lift: true, fn: (a) => { const x = N(a[0]), y = N(a[1]); if (num(x, y)) return num(x, y)!; if (y === 0) return ERR.div0; const r = (x as number) - (y as number) * Math.floor((x as number) / (y as number)); return Math.abs(r) < 1e-12 ? 0 : r; } });
def("QUOTIENT", { min: 2, max: 2, args: "numerator, denominator", desc: "The whole part of a division.", cat: "Math", lift: true, fn: (a) => { const x = N(a[0]), y = N(a[1]); if (num(x, y)) return num(x, y)!; return y === 0 ? ERR.div0 : Math.trunc((x as number) / (y as number)); } });
def("POWER", { min: 2, max: 2, args: "number, power", desc: "A number raised to a power.", cat: "Math", lift: true, fn: (a) => { const x = N(a[0]), y = N(a[1]); return num(x, y) ?? (x as number) ** (y as number); } });
def("SQRT", { min: 1, max: 1, args: "number", desc: "Square root.", cat: "Math", lift: true, fn: (a) => { const x = N(a[0]); return isErr(x) ? x : x < 0 ? ERR.num : Math.sqrt(x); } });
def("EXP", { min: 1, max: 1, args: "number", desc: "e raised to a power.", cat: "Math", lift: true, fn: (a) => { const x = N(a[0]); return isErr(x) ? x : Math.exp(x); } });
def("LN", { min: 1, max: 1, args: "number", desc: "Natural logarithm.", cat: "Math", lift: true, fn: (a) => { const x = N(a[0]); return isErr(x) ? x : x <= 0 ? ERR.num : Math.log(x); } });
def("LOG", { min: 1, max: 2, args: "number, [base]", desc: "Logarithm (base 10 unless given).", cat: "Math", lift: true, fn: (a) => { const x = N(a[0]), b = optN(a[1], 10); if (num(x, b)) return num(x, b)!; return (x as number) <= 0 || (b as number) <= 0 || b === 1 ? ERR.num : Math.log(x as number) / Math.log(b as number); } });
def("LOG10", { min: 1, max: 1, args: "number", desc: "Base-10 logarithm.", cat: "Math", lift: true, fn: (a) => { const x = N(a[0]); return isErr(x) ? x : x <= 0 ? ERR.num : Math.log10(x); } });
def("PI", { min: 0, max: 0, desc: "π, to 15 digits.", cat: "Math", fn: () => Math.PI });
def("SIGN", { min: 1, max: 1, args: "number", desc: "1, 0 or -1, by sign.", cat: "Math", lift: true, fn: (a) => { const x = N(a[0]); return isErr(x) ? x : Math.sign(x); } });
def("EVEN", { min: 1, max: 1, args: "number", desc: "Rounds up to an even number.", cat: "Math", lift: true, fn: (a) => { const x = N(a[0]); if (isErr(x)) return x; const r = Math.ceil(Math.abs(x) / 2) * 2; return Math.sign(x) * r; } });
def("ODD", { min: 1, max: 1, args: "number", desc: "Rounds up to an odd number.", cat: "Math", lift: true, fn: (a) => { const x = N(a[0]); if (isErr(x)) return x; let r = Math.ceil(Math.abs(x)); if (r % 2 === 0) r++; return (x < 0 ? -1 : 1) * r; } });
const fact = (n: number) => { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; };
def("FACT", { min: 1, max: 1, args: "number", desc: "Factorial (n!).", cat: "Math", lift: true, fn: (a) => { const x = N(a[0]); return isErr(x) ? x : x < 0 ? ERR.num : fact(Math.floor(x)); } });
def("COMBIN", { min: 2, max: 2, args: "n, k", desc: "Ways to choose k items from n.", cat: "Math", lift: true, fn: (a) => { const n = N(a[0]), k = N(a[1]); if (num(n, k)) return num(n, k)!; const N0 = Math.floor(n as number), K = Math.floor(k as number); if (K < 0 || K > N0) return ERR.num; let r = 1; for (let i = 1; i <= K; i++) r = r * (N0 - K + i) / i; return Math.round(r); } });
def("PERMUT", { min: 2, max: 2, args: "n, k", desc: "Ordered ways to pick k items from n.", cat: "Math", lift: true, fn: (a) => { const n = N(a[0]), k = N(a[1]); if (num(n, k)) return num(n, k)!; const N0 = Math.floor(n as number), K = Math.floor(k as number); if (K < 0 || K > N0) return ERR.num; let r = 1; for (let i = 0; i < K; i++) r *= N0 - i; return r; } });
const gcd2 = (a: number, b: number): number => b ? gcd2(b, a % b) : a;
def("GCD", { min: 1, max: 255, args: "number1, [number2, …]", desc: "Greatest common divisor.", cat: "Math", fn: (a) => { const n = numbers(a); return isErr(n) ? n : n.map(Math.floor).reduce(gcd2, 0); } });
def("LCM", { min: 1, max: 255, args: "number1, [number2, …]", desc: "Least common multiple.", cat: "Math", fn: (a) => { const n = numbers(a); return isErr(n) ? n : n.map(Math.floor).reduce((x, y) => x && y ? x * y / gcd2(x, y) : 0, 1); } });
for (const [name, f, d] of [["SIN", Math.sin, "Sine"], ["COS", Math.cos, "Cosine"], ["TAN", Math.tan, "Tangent"], ["ASIN", Math.asin, "Arcsine"], ["ACOS", Math.acos, "Arccosine"], ["ATAN", Math.atan, "Arctangent"]] as const)
  def(name, { min: 1, max: 1, args: "angle", desc: `${d} (radians).`, cat: "Math", lift: true, fn: (a) => { const x = N(a[0]); return isErr(x) ? x : f(x); } });
def("ATAN2", { min: 2, max: 2, args: "x, y", desc: "Angle of the point (x, y), in radians.", cat: "Math", lift: true, fn: (a) => { const x = N(a[0]), y = N(a[1]); return num(x, y) ?? Math.atan2(y as number, x as number); } });
def("DEGREES", { min: 1, max: 1, args: "radians", desc: "Radians to degrees.", cat: "Math", lift: true, fn: (a) => { const x = N(a[0]); return isErr(x) ? x : x * 180 / Math.PI; } });
def("RADIANS", { min: 1, max: 1, args: "degrees", desc: "Degrees to radians.", cat: "Math", lift: true, fn: (a) => { const x = N(a[0]); return isErr(x) ? x : x * Math.PI / 180; } });
def("RAND", { min: 0, max: 0, desc: "A random number from 0 to 1.", cat: "Math", volatile: true, fn: () => Math.random() });
def("RANDBETWEEN", { min: 2, max: 2, args: "low, high", desc: "A random whole number between two numbers.", cat: "Math", volatile: true, lift: true, fn: (a) => { const lo = N(a[0]), hi = N(a[1]); if (num(lo, hi)) return num(lo, hi)!; const l = Math.ceil(lo as number), h = Math.floor(hi as number); return h < l ? ERR.num : l + Math.floor(Math.random() * (h - l + 1)); } });
def("SUMIF", { min: 2, max: 3, args: "range, criterion, [sum_range]", desc: "Adds the cells that meet a condition.", cat: "Math", fn: (a, x) => {
  const [h, w] = dims(a[0]);
  const target = given(a[2]) ? resized(a[2], h, w) : a[0];
  const m = matching([a[0], a[1]], x);
  if (isErr(m)) return m;
  let s = 0;
  for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) if (m.hit(i, j)) { const v = at(target, i, j); if (isErr(v)) return v; if (typeof v === "number") s += v; }
  return s;
} });
def("SUMIFS", { min: 3, max: 255, args: "sum_range, range1, criterion1, [range2, criterion2, …]", desc: "Adds the cells that meet every condition.", cat: "Math", fn: (a, x) => {
  const m = matching(a.slice(1), x, a[0]);
  if (isErr(m)) return m;
  let s = 0;
  for (let i = 0; i < m.h; i++) for (let j = 0; j < m.w; j++) if (m.hit(i, j)) { const v = at(a[0], i, j); if (isErr(v)) return v; if (typeof v === "number") s += v; }
  return s;
} });
def("SEQUENCE", { min: 1, max: 4, args: "rows, [columns], [start], [step]", desc: "A grid of numbers counting up, e.g. 1, 2, 3…", cat: "Array", spills: true, fn: (a) => {
  const h = N(a[0]), w = optN(a[1], 1), s = optN(a[2], 1), st = optN(a[3], 1);
  if (num(h, w, s, st)) return num(h, w, s, st)!;
  const H = Math.floor(h as number), W = Math.floor(w as number);
  if (H < 1 || W < 1 || H * W > 1_000_000) return H < 1 || W < 1 ? ERR.calc : ERR.num;
  const out: Val[][] = [];
  for (let i = 0; i < H; i++) { const row: number[] = []; for (let j = 0; j < W; j++) row.push((s as number) + (i * W + j) * (st as number)); out.push(row); }
  return arr(out);
} });
def("RANDARRAY", { min: 0, max: 5, args: "[rows], [columns], [min], [max], [whole_numbers]", desc: "A grid of random numbers.", cat: "Array", spills: true, volatile: true, fn: (a) => {
  const h = optN(a[0], 1), w = optN(a[1], 1), lo = optN(a[2], 0), hi = optN(a[3], 1), whole = optB(a[4], false);
  if (num(h, w, lo, hi, whole)) return num(h, w, lo, hi, whole)!;
  const out: Val[][] = [];
  for (let i = 0; i < (h as number); i++) { const row: number[] = []; for (let j = 0; j < (w as number); j++) { const r = (lo as number) + Math.random() * ((hi as number) - (lo as number)); row.push(whole ? Math.floor((lo as number) + Math.random() * ((hi as number) - (lo as number) + 1)) : r); } out.push(row); }
  return arr(out);
} });
def("MMULT", { min: 2, max: 2, args: "array1, array2", desc: "Matrix product of two arrays.", cat: "Array", spills: true, fn: (a) => {
  const A = toArr(a[0]), Bm = toArr(a[1]);
  if ((A[0]?.length ?? 0) !== Bm.length) return ERR.value;
  const out: Val[][] = [];
  for (let i = 0; i < A.length; i++) { const row: number[] = []; for (let j = 0; j < (Bm[0]?.length ?? 0); j++) { let s = 0; for (let k = 0; k < Bm.length; k++) { const x = A[i][k], y = Bm[k][j]; if (typeof x !== "number" || typeof y !== "number") return ERR.value; s += x * y; } row.push(s); } out.push(row); }
  return arr(out);
} });

/* Statistics */
def("AVERAGE", { min: 1, max: 255, args: "value1, [value2, …]", desc: "The mean of the numbers.", cat: "Statistics", fn: (a) => { const n = numbers(a); return isErr(n) ? n : mean(n); } });
def("MEDIAN", { min: 1, max: 255, args: "value1, [value2, …]", desc: "The middle number.", cat: "Statistics", fn: (a) => { const n = numbers(a); return isErr(n) ? n : n.length ? percentile(n, 0.5) : ERR.num; } });
def("MODE", { min: 1, max: 255, args: "value1, [value2, …]", desc: "The most common number.", cat: "Statistics", fn: (a) => {
  const n = numbers(a); if (isErr(n)) return n;
  const counts = new Map<number, number>(); let best = NaN, bc = 1;
  for (const x of n) { const k = (counts.get(x) ?? 0) + 1; counts.set(x, k); if (k > bc) { bc = k; best = x; } }
  return Number.isNaN(best) ? ERR.na : best;
} });
alias("MODE.SNGL", "MODE");
def("MIN", { min: 1, max: 255, args: "value1, [value2, …]", desc: "The smallest number.", cat: "Statistics", fn: (a) => { const n = numbers(a); if (isErr(n)) return n; let m = Infinity; for (const x of n) if (x < m) m = x; return n.length ? m : 0; } });
def("MAX", { min: 1, max: 255, args: "value1, [value2, …]", desc: "The largest number.", cat: "Statistics", fn: (a) => { const n = numbers(a); if (isErr(n)) return n; let m = -Infinity; for (const x of n) if (x > m) m = x; return n.length ? m : 0; } });
def("COUNT", { min: 1, max: 255, args: "value1, [value2, …]", desc: "How many numbers there are.", cat: "Statistics", fn: (a) => { let c = 0; for (const x of a) { if (isMulti(x)) { for (const v of each(x)) if (typeof v === "number") c++; } else { const v = scalar(x); if (!isErr(v) && v !== "" && !isErr(toNum(v))) c++; } } return c; } });
def("COUNTA", { min: 1, max: 255, args: "value1, [value2, …]", desc: "How many cells aren't empty.", cat: "Statistics", fn: (a) => { let c = 0; for (const x of a) for (const v of each(x)) if (v !== "") c++; return c; } });
def("COUNTBLANK", { min: 1, max: 1, args: "range", desc: "How many cells are empty.", cat: "Statistics", fn: (a) => { let c = 0; for (const v of each(a[0])) if (v === "") c++; return c; } });
def("COUNTIF", { min: 2, max: 2, args: "range, criterion", desc: "Counts the cells that meet a condition, e.g. \">10\" or \"apple*\".", cat: "Statistics", fn: (a, x) => {
  const m = matching(a, x); if (isErr(m)) return m;
  let c = 0; for (let i = 0; i < m.h; i++) for (let j = 0; j < m.w; j++) if (m.hit(i, j)) c++;
  return c;
} });
def("COUNTIFS", { min: 2, max: 254, args: "range1, criterion1, [range2, criterion2, …]", desc: "Counts the cells that meet every condition.", cat: "Statistics", fn: (a, x) => {
  const m = matching(a, x); if (isErr(m)) return m;
  let c = 0; for (let i = 0; i < m.h; i++) for (let j = 0; j < m.w; j++) if (m.hit(i, j)) c++;
  return c;
} });
const condAgg = (kind: "avg" | "min" | "max") => (vals: number[]) => kind === "avg" ? mean(vals) : vals.length ? (kind === "min" ? Math.min(...vals) : Math.max(...vals)) : 0;
def("AVERAGEIF", { min: 2, max: 3, args: "range, criterion, [average_range]", desc: "The mean of the cells that meet a condition.", cat: "Statistics", fn: (a, x) => {
  const [h, w] = dims(a[0]);
  const target = given(a[2]) ? resized(a[2], h, w) : a[0];
  const m = matching([a[0], a[1]], x); if (isErr(m)) return m;
  const vals: number[] = [];
  for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) if (m.hit(i, j)) { const v = at(target, i, j); if (isErr(v)) return v; if (typeof v === "number") vals.push(v); }
  return condAgg("avg")(vals);
} });
for (const [name, kind, d] of [["AVERAGEIFS", "avg", "The mean of the cells that meet every condition."], ["MINIFS", "min", "The smallest value that meets every condition."], ["MAXIFS", "max", "The largest value that meets every condition."]] as const)
  def(name, { min: 3, max: 255, args: `${kind === "avg" ? "average" : kind}_range, range1, criterion1, [range2, criterion2, …]`, desc: d, cat: "Statistics", fn: (a, x) => {
    const m = matching(a.slice(1), x, a[0]); if (isErr(m)) return m;
    const vals: number[] = [];
    for (let i = 0; i < m.h; i++) for (let j = 0; j < m.w; j++) if (m.hit(i, j)) { const v = at(a[0], i, j); if (isErr(v)) return v; if (typeof v === "number") vals.push(v); }
    return condAgg(kind)(vals);
  } });
def("STDEV", { min: 1, max: 255, args: "value1, [value2, …]", desc: "Standard deviation of a sample.", cat: "Statistics", fn: (a) => { const n = numbers(a); if (isErr(n)) return n; const v = variance(n, true); return isErr(v) ? v : Math.sqrt(v); } });
def("STDEV.P", { min: 1, max: 255, args: "value1, [value2, …]", desc: "Standard deviation of a whole population.", cat: "Statistics", fn: (a) => { const n = numbers(a); if (isErr(n)) return n; const v = variance(n, false); return isErr(v) ? v : Math.sqrt(v); } });
alias("STDEV.S", "STDEV"); alias("STDEVP", "STDEV.P");
def("VAR", { min: 1, max: 255, args: "value1, [value2, …]", desc: "Variance of a sample.", cat: "Statistics", fn: (a) => { const n = numbers(a); return isErr(n) ? n : variance(n, true); } });
def("VAR.P", { min: 1, max: 255, args: "value1, [value2, …]", desc: "Variance of a whole population.", cat: "Statistics", fn: (a) => { const n = numbers(a); return isErr(n) ? n : variance(n, false); } });
alias("VAR.S", "VAR"); alias("VARP", "VAR.P");
const rank = (avg: boolean) => (a: Any[]) => {
  const x = N(a[0]); if (isErr(x)) return x;
  const asc = optB(a[2], false); if (isErr(asc)) return asc;
  const list = numbers([a[1]]); if (isErr(list)) return list;
  if (!list.includes(x)) return ERR.na;
  const better = list.filter((v) => asc ? v < x : v > x).length;
  const ties = list.filter((v) => v === x).length;
  return avg ? better + (ties + 1) / 2 : better + 1;
};
def("RANK", { min: 2, max: 3, args: "number, range, [ascending]", desc: "A number's position in a list (1 = largest).", cat: "Statistics", lift: [0], fn: rank(false) });
alias("RANK.EQ", "RANK");
def("RANK.AVG", { min: 2, max: 3, args: "number, range, [ascending]", desc: "Like RANK, but ties share the average position.", cat: "Statistics", lift: [0], fn: rank(true) });
def("LARGE", { min: 2, max: 2, args: "range, k", desc: "The k-th largest number.", cat: "Statistics", lift: [1], fn: (a) => { const n = numbers([a[0]]), k = N(a[1]); if (num(k)) return num(k)!; if (isErr(n)) return n; const s = sorted(n).reverse(); const i = Math.ceil(k as number) - 1; return i < 0 || i >= s.length ? ERR.num : s[i]; } });
def("SMALL", { min: 2, max: 2, args: "range, k", desc: "The k-th smallest number.", cat: "Statistics", lift: [1], fn: (a) => { const n = numbers([a[0]]), k = N(a[1]); if (num(k)) return num(k)!; if (isErr(n)) return n; const s = sorted(n); const i = Math.ceil(k as number) - 1; return i < 0 || i >= s.length ? ERR.num : s[i]; } });
def("PERCENTILE", { min: 2, max: 2, args: "range, k", desc: "The value below which a fraction k (0–1) of the numbers fall.", cat: "Statistics", lift: [1], fn: (a) => { const n = numbers([a[0]]), k = N(a[1]); if (num(k)) return num(k)!; return isErr(n) ? n : percentile(n, k as number); } });
alias("PERCENTILE.INC", "PERCENTILE");
def("QUARTILE", { min: 2, max: 2, args: "range, quart", desc: "Quartile 0–4 (0 = min, 2 = median, 4 = max).", cat: "Statistics", lift: [1], fn: (a) => { const n = numbers([a[0]]), q = N(a[1]); if (num(q)) return num(q)!; if (isErr(n)) return n; const qi = Math.floor(q as number); return qi < 0 || qi > 4 ? ERR.num : percentile(n, qi / 4); } });
alias("QUARTILE.INC", "QUARTILE");
function pairs(a: Any, b: Any): [number[], number[]] | FErr {
  const A = flat1(a), Bv = flat1(b);
  if (A.length !== Bv.length) return ERR.na;
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < A.length; i++) { if (isErr(A[i])) return A[i] as FErr; if (isErr(Bv[i])) return Bv[i] as FErr; if (typeof A[i] === "number" && typeof Bv[i] === "number") { xs.push(A[i] as number); ys.push(Bv[i] as number); } }
  return [xs, ys];
}
function linfit(ys: Any, xs: Any): { slope: number; icpt: number; r: number } | FErr {
  const p = pairs(xs, ys); if (isErr(p)) return p;
  const [X, Y] = p;
  if (X.length < 2) return ERR.div0;
  const mx = sum(X) / X.length, my = sum(Y) / Y.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < X.length; i++) { sxy += (X[i] - mx) * (Y[i] - my); sxx += (X[i] - mx) ** 2; syy += (Y[i] - my) ** 2; }
  if (sxx === 0) return ERR.div0;
  return { slope: sxy / sxx, icpt: my - (sxy / sxx) * mx, r: syy === 0 ? NaN : sxy / Math.sqrt(sxx * syy) };
}
def("CORREL", { min: 2, max: 2, args: "range1, range2", desc: "How closely two sets of numbers move together (-1 to 1).", cat: "Statistics", fn: (a) => { const f = linfit(a[1], a[0]); return isErr(f) ? f : Number.isNaN(f.r) ? ERR.div0 : f.r; } });
def("SLOPE", { min: 2, max: 2, args: "known_ys, known_xs", desc: "Slope of the best-fit line.", cat: "Statistics", fn: (a) => { const f = linfit(a[0], a[1]); return isErr(f) ? f : f.slope; } });
def("INTERCEPT", { min: 2, max: 2, args: "known_ys, known_xs", desc: "Where the best-fit line crosses the y-axis.", cat: "Statistics", fn: (a) => { const f = linfit(a[0], a[1]); return isErr(f) ? f : f.icpt; } });
def("FORECAST", { min: 3, max: 3, args: "x, known_ys, known_xs", desc: "Predicts a value along the best-fit line.", cat: "Statistics", lift: [0], fn: (a) => { const x = N(a[0]); if (isErr(x)) return x; const f = linfit(a[1], a[2]); return isErr(f) ? f : f.icpt + f.slope * x; } });
alias("FORECAST.LINEAR", "FORECAST");
def("GEOMEAN", { min: 1, max: 255, args: "value1, [value2, …]", desc: "Geometric mean.", cat: "Statistics", fn: (a) => { const n = numbers(a); if (isErr(n)) return n; if (!n.length || n.some((x) => x <= 0)) return ERR.num; return Math.exp(sum(n.map(Math.log)) / n.length); } });

/* Logic */
def("IF", { min: 2, max: 3, args: "condition, value_if_true, [value_if_false]", desc: "One value if a condition is true, another if not.", cat: "Logic", lazy: (n, x) => {
  const c = x.ev(n[0]);
  if (isMulti(c)) {
    // Cell by cell.
    const t = x.ev(n[1]), f = n.length > 2 ? x.ev(n[2]) : false;
    const [h, w] = dims(c);
    const out: Val[][] = [];
    for (let i = 0; i < h; i++) { const row: Val[] = []; for (let j = 0; j < w; j++) { const b = toBool(at(c, i, j)); row.push(isErr(b) ? b : b ? pick(t, i, j) : pick(f, i, j)); } out.push(row); }
    return arr(out);
  }
  const b = toBool(scalar(c)); if (isErr(b)) return b;
  if (b) return x.ev(n[1]);
  return n.length > 2 && n[2].k !== "omit" ? x.ev(n[2]) : n.length > 2 ? 0 : false;
} });
function pick(v: Any, i: number, j: number): Val {
  if (!isMulti(v)) return asVal(v);
  const [h, w] = dims(v);
  return at(v, h === 1 ? 0 : i, w === 1 ? 0 : j);
}
def("IFS", { min: 2, max: 254, args: "condition1, value1, [condition2, value2, …]", desc: "The value for the first condition that's true.", cat: "Logic", lazy: (n, x) => {
  if (n.length % 2) return ERR.value;
  for (let i = 0; i < n.length; i += 2) { const b = toBool(scalar(x.ev(n[i]))); if (isErr(b)) return b; if (b) return x.ev(n[i + 1]); }
  return ERR.na;
} });
def("IFERROR", { min: 2, max: 2, args: "value, value_if_error", desc: "The value, or something else if it's an error.", cat: "Logic", lazy: (n, x) => {
  const v = x.ev(n[0]);
  if (isMulti(v)) { const m = toArr(v); if (m.some((r) => r.some(isErr))) { const alt = x.ev(n[1]); return arr(m.map((r, i) => r.map((e, j) => isErr(e) ? pick(alt, i, j) : e))); } return v; }
  return isErr(scalar(v)) ? x.ev(n[1]) : v;
} });
def("IFNA", { min: 2, max: 2, args: "value, value_if_na", desc: "The value, or something else if it's #N/A.", cat: "Logic", lazy: (n, x) => { const v = x.ev(n[0]); const s = scalar(v); return isErr(s) && s.code === "#N/A" ? x.ev(n[1]) : v; } });
def("SWITCH", { min: 3, max: 254, args: "expression, case1, value1, [case2, value2, …], [default]", desc: "Matches a value against a list of cases.", cat: "Logic", lazy: (n, x) => {
  const v = scalar(x.ev(n[0])); if (isErr(v)) return v;
  let i = 1;
  for (; i + 1 < n.length; i += 2) { const c = scalar(x.ev(n[i])); if (same(c, v, false)) return x.ev(n[i + 1]); }
  return i < n.length ? x.ev(n[i]) : ERR.na;
} });
def("CHOOSE", { min: 2, max: 255, args: "index, value1, [value2, …]", desc: "Picks a value from a list by its position.", cat: "Logic", lazy: (n, x) => { const i = N(x.ev(n[0])); if (isErr(i)) return i; const k = Math.floor(i); return k < 1 || k >= n.length ? ERR.value : x.ev(n[k]); } });
const logic = (op: "and" | "or" | "xor") => (a: Any[]) => {
  let any = false, all = true, odd = false, seen = false;
  for (const x of a) for (const v of each(x)) {
    if (isErr(v)) return v;
    if (isMulti(x) && typeof v === "string") continue;
    const b = toBool(v); if (isErr(b)) return b;
    seen = true; any ||= b; all &&= b; if (b) odd = !odd;
  }
  if (!seen) return ERR.value;
  return op === "and" ? all : op === "or" ? any : odd;
};
def("AND", { min: 1, max: 255, args: "condition1, [condition2, …]", desc: "TRUE if every condition is true.", cat: "Logic", fn: logic("and") });
def("OR", { min: 1, max: 255, args: "condition1, [condition2, …]", desc: "TRUE if any condition is true.", cat: "Logic", fn: logic("or") });
def("XOR", { min: 1, max: 255, args: "condition1, [condition2, …]", desc: "TRUE if an odd number of conditions are true.", cat: "Logic", fn: logic("xor") });
def("NOT", { min: 1, max: 1, args: "condition", desc: "Flips TRUE and FALSE.", cat: "Logic", lift: true, fn: (a) => { const b = B(a[0]); return isErr(b) ? b : !b; } });
def("TRUE", { min: 0, max: 0, desc: "The value TRUE.", cat: "Logic", fn: () => true });
def("FALSE", { min: 0, max: 0, desc: "The value FALSE.", cat: "Logic", fn: () => false });

/* Info */
const is = (name: string, desc: string, test: (v: Val) => boolean) => def(name, { min: 1, max: 1, args: "value", desc, cat: "Info", lift: true, fn: (a) => test(scalar(a[0])) });
is("ISBLANK", "TRUE if the cell is empty.", (v) => v === "");
is("ISNUMBER", "TRUE if it's a number.", (v) => typeof v === "number");
is("ISTEXT", "TRUE if it's text.", (v) => typeof v === "string" && v !== "");
is("ISNONTEXT", "TRUE if it isn't text.", (v) => typeof v !== "string" || v === "");
is("ISLOGICAL", "TRUE if it's TRUE or FALSE.", (v) => typeof v === "boolean");
is("ISERROR", "TRUE if it's any error.", (v) => isErr(v));
is("ISERR", "TRUE if it's an error other than #N/A.", (v) => isErr(v) && v.code !== "#N/A");
is("ISNA", "TRUE if it's #N/A.", (v) => isErr(v) && v.code === "#N/A");
def("ISEVEN", { min: 1, max: 1, args: "number", desc: "TRUE for even numbers.", cat: "Info", lift: true, fn: (a) => { const x = N(a[0]); return isErr(x) ? x : Math.floor(Math.abs(x)) % 2 === 0; } });
def("ISODD", { min: 1, max: 1, args: "number", desc: "TRUE for odd numbers.", cat: "Info", lift: true, fn: (a) => { const x = N(a[0]); return isErr(x) ? x : Math.floor(Math.abs(x)) % 2 === 1; } });
def("ISREF", { min: 1, max: 1, args: "value", desc: "TRUE if it's a cell reference.", cat: "Info", lazy: (n, x) => isRef(x.ev(n[0])) });
def("NA", { min: 0, max: 0, desc: "The #N/A error (\"no value\").", cat: "Info", fn: () => ERR.na });
def("N", { min: 1, max: 1, args: "value", desc: "Turns a value into a number (text → 0).", cat: "Info", lift: true, fn: (a) => { const v = scalar(a[0]); return typeof v === "number" ? v : typeof v === "boolean" ? Number(v) : isErr(v) ? v : 0; } });
def("ROW", { min: 0, max: 1, args: "[reference]", desc: "The row number of a cell.", cat: "Info", fn: (a, x) => { if (!given(a[0])) return x.r + 1; if (!isRef(a[0])) return ERR.value; const r = a[0]; return r.r1 === r.r2 ? r.r1 + 1 : col(Array.from({ length: r.r2 - r.r1 + 1 }, (_, i) => r.r1 + i + 1)); } });
def("COLUMN", { min: 0, max: 1, args: "[reference]", desc: "The column number of a cell.", cat: "Info", fn: (a, x) => { if (!given(a[0])) return x.c + 1; if (!isRef(a[0])) return ERR.value; const r = a[0]; return r.c1 === r.c2 ? r.c1 + 1 : arr([Array.from({ length: r.c2 - r.c1 + 1 }, (_, i) => r.c1 + i + 1)]); } });
def("ROWS", { min: 1, max: 1, args: "range", desc: "How many rows a range has.", cat: "Info", fn: (a) => dims(a[0])[0] });
def("COLUMNS", { min: 1, max: 1, args: "range", desc: "How many columns a range has.", cat: "Info", fn: (a) => dims(a[0])[1] });

/* Lookup */
def("VLOOKUP", { min: 3, max: 4, args: "search_key, range, column, [is_sorted]", desc: "Finds a value in the first column of a range and returns one from the same row.", cat: "Lookup", lift: [0], fn: (a) => {
  const v = scalar(a[0]); if (isErr(v)) return v;
  const k = N(a[2]); if (isErr(k)) return k;
  const sortedMode = optB(a[3], true); if (isErr(sortedMode)) return sortedMode;
  const [, w] = dims(a[1]);
  const ci = Math.floor(k) - 1;
  if (ci < 0) return ERR.value;
  if (ci >= w) return ERR.ref;
  const keys = colOf(a[1], 0);
  const i = sortedMode ? approx(keys, v) : findIn(keys, v, 2);
  return i < 0 ? ERR.na : at(a[1], i, ci);
} });
def("HLOOKUP", { min: 3, max: 4, args: "search_key, range, row, [is_sorted]", desc: "Finds a value in the first row of a range and returns one from the same column.", cat: "Lookup", lift: [0], fn: (a) => {
  const v = scalar(a[0]); if (isErr(v)) return v;
  const k = N(a[2]); if (isErr(k)) return k;
  const sortedMode = optB(a[3], true); if (isErr(sortedMode)) return sortedMode;
  const [h] = dims(a[1]);
  const ri = Math.floor(k) - 1;
  if (ri < 0) return ERR.value;
  if (ri >= h) return ERR.ref;
  const keys = rowOf(a[1], 0);
  const j = sortedMode ? approx(keys, v) : findIn(keys, v, 2);
  return j < 0 ? ERR.na : at(a[1], ri, j);
} });
def("XLOOKUP", { min: 3, max: 6, args: "search_key, lookup_range, result_range, [if_not_found], [match_mode], [search_mode]", desc: "Finds a value in one range and returns what's in the same position in another.", cat: "Lookup", lift: [0], spills: true, fn: (a) => {
  const v = scalar(a[0]); if (isErr(v)) return v;
  const mode = optN(a[4], 0), search = optN(a[5], 1);
  if (num(mode, search)) return num(mode, search)!;
  const [lh, lw] = dims(a[1]);
  const vertical = lw === 1;
  if (lh !== 1 && lw !== 1) return ERR.value;
  const list = flat1(a[1]);
  const i = findIn(list, v, mode as number, (search as number) < 0);
  if (i < 0) return given(a[3]) ? a[3] : ERR.na;
  const [rh, rw] = dims(a[2]);
  if (vertical) { if (rh !== lh) return ERR.value; return rw === 1 ? at(a[2], i, 0) : arr([rowOf(a[2], i)]); }
  if (rw !== lw) return ERR.value;
  return rh === 1 ? at(a[2], 0, i) : col(colOf(a[2], i));
} });
def("MATCH", { min: 2, max: 3, args: "search_key, range, [match_type]", desc: "The position of a value in a list (0 = exact match).", cat: "Lookup", lift: [0], fn: (a) => {
  const v = scalar(a[0]); if (isErr(v)) return v;
  const t = optN(a[2], 1); if (isErr(t)) return t;
  const list = flat1(a[1]);
  const i = t === 0 ? findIn(list, v, 2) : approx(list, v, t < 0);
  return i < 0 ? ERR.na : i + 1;
} });
def("XMATCH", { min: 2, max: 4, args: "search_key, lookup_range, [match_mode], [search_mode]", desc: "The position of a value in a list (exact by default).", cat: "Lookup", lift: [0], fn: (a) => {
  const v = scalar(a[0]); if (isErr(v)) return v;
  const mode = optN(a[2], 0), search = optN(a[3], 1);
  if (num(mode, search)) return num(mode, search)!;
  const i = findIn(flat1(a[1]), v, mode as number, (search as number) < 0);
  return i < 0 ? ERR.na : i + 1;
} });
def("LOOKUP", { min: 2, max: 3, args: "search_key, search_range, [result_range]", desc: "Looks up a value in a sorted list.", cat: "Lookup", lift: [0], fn: (a) => {
  const v = scalar(a[0]); if (isErr(v)) return v;
  const keys = flat1(a[1]);
  const i = approx(keys, v);
  if (i < 0) return ERR.na;
  return given(a[2]) ? flat1(a[2])[i] ?? ERR.na : keys[i];
} });
def("INDEX", { min: 2, max: 3, args: "range, row, [column]", desc: "The value at a row and column of a range (0 = the whole row/column).", cat: "Lookup", spills: true, fn: (a, x) => {
  const r = N(a[1]), c = optN(a[2], 0);
  if (num(r, c)) return num(r, c)!;
  const [h, w] = dims(a[0]);
  let ri = Math.floor(r as number), ci = Math.floor(c as number);
  if (!given(a[2]) && h === 1 && w > 1) { ci = ri; ri = 1; }
  if (ri < 0 || ci < 0 || ri > h || ci > w) return ERR.ref;
  if (h === 1 && ri === 0) ri = 1;
  if (w === 1 && ci === 0) ci = 1;
  const r1 = ri ? ri - 1 : 0, r2 = ri ? ri - 1 : h - 1, c1 = ci ? ci - 1 : 0, c2 = ci ? ci - 1 : w - 1;
  if (isRef(a[0])) return x.subRef(a[0], a[0].r1 + r1, a[0].c1 + c1, a[0].r1 + r2, a[0].c1 + c2);
  const m = toArr(a[0]);
  if (r1 === r2 && c1 === c2) return m[r1][c1];
  return arr(m.slice(r1, r2 + 1).map((row) => row.slice(c1, c2 + 1)));
} });
def("OFFSET", { min: 3, max: 5, args: "reference, rows, columns, [height], [width]", desc: "A range shifted from a starting cell.", cat: "Lookup", spills: true, volatile: true, fn: (a, x) => {
  if (!isRef(a[0])) return ERR.value;
  const dr = N(a[1]), dc = N(a[2]);
  const [h0, w0] = dims(a[0]);
  const h = optN(a[3], h0), w = optN(a[4], w0);
  if (num(dr, dc, h, w)) return num(dr, dc, h, w)!;
  if ((h as number) < 1 || (w as number) < 1) return ERR.ref;
  const r1 = a[0].r1 + Math.floor(dr as number), c1 = a[0].c1 + Math.floor(dc as number);
  if (r1 < 0 || c1 < 0) return ERR.ref;
  return x.subRef(a[0], r1, c1, r1 + Math.floor(h as number) - 1, c1 + Math.floor(w as number) - 1);
} });
def("INDIRECT", { min: 1, max: 2, args: "reference_text", desc: "The cell or range named by some text, e.g. \"B\"&A1.", cat: "Lookup", spills: true, volatile: true, fn: (a, x) => { const t = S(a[0]); return isErr(t) ? t : x.refFromText(t); } });
def("ADDRESS", { min: 2, max: 5, args: "row, column, [absolute], [a1], [sheet]", desc: "A cell's address as text, e.g. $B$3.", cat: "Lookup", lift: [0, 1], fn: (a) => {
  const r = N(a[0]), c = N(a[1]), mode = optN(a[2], 1);
  if (num(r, c, mode)) return num(r, c, mode)!;
  if ((r as number) < 1 || (c as number) < 1) return ERR.value;
  const ra = mode === 1 || mode === 2, ca = mode === 1 || mode === 3;
  const sheet = given(a[4]) ? S(a[4]) : "";
  if (isErr(sheet)) return sheet;
  return (sheet ? (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(sheet) ? sheet : `'${sheet}'`) + "!" : "") + (ca ? "$" : "") + colName(Math.floor(c as number) - 1) + (ra ? "$" : "") + Math.floor(r as number);
} });

/* Dynamic arrays */
def("FILTER", { min: 2, max: 3, args: "range, include, [if_empty]", desc: "The rows (or columns) of a range where the condition is TRUE.", cat: "Array", spills: true, fn: (a) => {
  const m = toArr(a[0]);
  const [h, w] = dims(a[0]);
  const [ih, iw] = dims(a[1]);
  const keep: number[] = [];
  if (ih === h && iw === 1) { for (let i = 0; i < h; i++) { const b = toBool(at(a[1], i, 0)); if (isErr(b)) return b; if (b) keep.push(i); } }
  else if (iw === w && ih === 1) {
    for (let j = 0; j < w; j++) { const b = toBool(at(a[1], 0, j)); if (isErr(b)) return b; if (b) keep.push(j); }
    if (!keep.length) return given(a[2]) ? a[2] : ERR.calc;
    return arr(m.map((row) => keep.map((j) => row[j])));
  } else return ERR.value;
  if (!keep.length) return given(a[2]) ? a[2] : ERR.calc;
  return arr(pickRows(m, keep));
} });
def("SORT", { min: 1, max: 4, args: "range, [sort_index], [sort_order], [by_column]", desc: "Sorts a range (1 = ascending, -1 = descending).", cat: "Array", spills: true, fn: (a) => {
  const k = optN(a[1], 1), o = optN(a[2], 1), byCol = optB(a[3], false);
  if (num(k, o, byCol)) return num(k, o, byCol)!;
  let m = toArr(a[0]);
  if (byCol) m = transpose(m);
  const j = Math.floor(k as number) - 1;
  if (j < 0 || j >= (m[0]?.length ?? 0)) return ERR.value;
  const out = sortRows(m, [{ j, desc: (o as number) < 0 }]);
  return arr(byCol ? transpose(out) : out);
} });
def("SORTBY", { min: 2, max: 255, args: "range, by_range1, [order1], [by_range2, order2, …]", desc: "Sorts a range by other ranges.", cat: "Array", spills: true, fn: (a) => {
  const m = toArr(a[0]);
  const keys: { j: number; desc: boolean; by: Val[] }[] = [];
  for (let i = 1; i < a.length; i += 2) {
    const by = flat1(a[i]);
    if (by.length !== m.length) return ERR.value;
    const o = optN(a[i + 1], 1); if (isErr(o)) return o;
    keys.push({ j: 0, desc: o < 0, by });
  }
  return arr(sortRows(m, keys));
} });
def("UNIQUE", { min: 1, max: 3, args: "range, [by_column], [exactly_once]", desc: "The distinct rows of a range.", cat: "Array", spills: true, fn: (a) => {
  const byCol = optB(a[1], false), once = optB(a[2], false);
  if (num(byCol, once)) return num(byCol, once)!;
  let m = toArr(a[0]);
  if (byCol) m = transpose(m);
  const key = (r: Val[]) => r.map((v) => (typeof v === "string" ? "s" + v.toLowerCase() : typeof v + String(v))).join("\u0001");
  const counts = new Map<string, number>();
  for (const r of m) counts.set(key(r), (counts.get(key(r)) ?? 0) + 1);
  const seen = new Set<string>();
  const out: Val[][] = [];
  for (const r of m) { const k = key(r); if (seen.has(k)) continue; seen.add(k); if (!once || counts.get(k) === 1) out.push(r); }
  if (!out.length) return ERR.calc;
  return arr(byCol ? transpose(out) : out);
} });
def("TRANSPOSE", { min: 1, max: 1, args: "range", desc: "Swaps rows and columns.", cat: "Array", spills: true, fn: (a) => arr(transpose(toArr(a[0]))) });
const takeDrop = (take: boolean) => (a: Any[]) => {
  const m = toArr(a[0]);
  const h = m.length, w = m[0]?.length ?? 0;
  const r = optN(a[1], take ? h : 0), c = optN(a[2], take ? w : 0);
  if (num(r, c)) return num(r, c)!;
  const slice = (n: number, len: number): [number, number] => take ? (n >= 0 ? [0, Math.min(n, len)] : [Math.max(0, len + n), len]) : (n >= 0 ? [Math.min(n, len), len] : [0, Math.max(0, len + n)]);
  const [r0, r1] = slice(Math.trunc(r as number), h), [c0, c1] = slice(Math.trunc(c as number), w);
  if (r1 <= r0 || c1 <= c0) return ERR.calc;
  return arr(m.slice(r0, r1).map((row) => row.slice(c0, c1)));
};
def("TAKE", { min: 2, max: 3, args: "range, rows, [columns]", desc: "The first (or, if negative, last) rows/columns.", cat: "Array", spills: true, fn: takeDrop(true) });
def("DROP", { min: 2, max: 3, args: "range, rows, [columns]", desc: "Everything but the first (or last) rows/columns.", cat: "Array", spills: true, fn: takeDrop(false) });
const choose = (rows: boolean) => (a: Any[]) => {
  let m = toArr(a[0]);
  if (!rows) m = transpose(m);
  const out: Val[][] = [];
  for (const x of a.slice(1)) for (const v of each(x)) { const n = toNum(v); if (isErr(n)) return n; const i = n < 0 ? m.length + n : n - 1; if (i < 0 || i >= m.length) return ERR.value; out.push(m[Math.floor(i)]); }
  return arr(rows ? out : transpose(out));
};
def("CHOOSEROWS", { min: 2, max: 255, args: "range, row1, [row2, …]", desc: "Picks rows by number.", cat: "Array", spills: true, fn: choose(true) });
def("CHOOSECOLS", { min: 2, max: 255, args: "range, column1, [column2, …]", desc: "Picks columns by number.", cat: "Array", spills: true, fn: choose(false) });
def("VSTACK", { min: 1, max: 255, args: "range1, [range2, …]", desc: "Stacks ranges on top of each other.", cat: "Array", spills: true, fn: (a) => {
  const ms = a.map(toArr); const w = Math.max(...ms.map((m) => m[0]?.length ?? 0));
  return arr(ms.flatMap((m) => m.map((r) => [...r, ...Array(w - r.length).fill(ERR.na)])));
} });
def("HSTACK", { min: 1, max: 255, args: "range1, [range2, …]", desc: "Puts ranges side by side.", cat: "Array", spills: true, fn: (a) => {
  const ms = a.map(toArr); const h = Math.max(...ms.map((m) => m.length));
  return arr(Array.from({ length: h }, (_, i) => ms.flatMap((m) => m[i] ?? Array(m[0]?.length ?? 0).fill(ERR.na))));
} });
def("TOCOL", { min: 1, max: 3, args: "range, [ignore], [by_column]", desc: "Everything in one column.", cat: "Array", spills: true, fn: (a) => {
  const ig = optN(a[1], 0), byc = optB(a[2], false); if (num(ig, byc)) return num(ig, byc)!;
  let m = toArr(a[0]); if (byc) m = transpose(m);
  const vals = m.flat().filter((v) => !((ig === 1 || ig === 3) && v === "") && !((ig === 2 || ig === 3) && isErr(v)));
  return vals.length ? col(vals) : ERR.calc;
} });
def("TOROW", { min: 1, max: 3, args: "range, [ignore], [by_column]", desc: "Everything in one row.", cat: "Array", spills: true, fn: (a, x) => { const c = FUNCS.TOCOL.fn!(a, x); return isArr(c) ? arr([c.v.map((r) => r[0])]) : c; } });

/* Text */
const txt = (name: string, args: string, desc: string, f: (s: string, a: Any[]) => Val, min = 1, max = 1) =>
  def(name, { min, max, args, desc, cat: "Text", lift: true, fn: (a) => { const s = S(a[0]); return isErr(s) ? s : f(s, a); } });
txt("LEFT", "text, [characters]", "The first characters of some text.", (s, a) => { const n = optN(a[1], 1); return isErr(n) ? n : n < 0 ? ERR.value : [...s].slice(0, Math.floor(n)).join(""); }, 1, 2);
txt("RIGHT", "text, [characters]", "The last characters of some text.", (s, a) => { const n = optN(a[1], 1); if (isErr(n)) return n; if (n < 0) return ERR.value; const cs = [...s]; return Math.floor(n) === 0 ? "" : cs.slice(-Math.floor(n)).join(""); }, 1, 2);
txt("MID", "text, start, characters", "Characters from the middle of some text.", (s, a) => { const st = N(a[1]), n = N(a[2]); if (num(st, n)) return num(st, n)!; if ((st as number) < 1 || (n as number) < 0) return ERR.value; return [...s].slice(Math.floor(st as number) - 1, Math.floor(st as number) - 1 + Math.floor(n as number)).join(""); }, 3, 3);
txt("LEN", "text", "How many characters.", (s) => [...s].length);
txt("UPPER", "text", "IN CAPITALS.", (s) => s.toUpperCase());
txt("LOWER", "text", "in lower case.", (s) => s.toLowerCase());
txt("PROPER", "text", "Capitalises Each Word.", (s) => s.toLowerCase().replace(/(^|[^\p{L}'])(\p{L})/gu, (_, p, c) => p + c.toUpperCase()));
txt("TRIM", "text", "Removes extra spaces.", (s) => s.trim().replace(/ +/g, " "));
txt("CLEAN", "text", "Removes invisible characters.", (s) => s.replace(/[\x00-\x1f]/g, ""));
txt("FIND", "search_for, text, [start]", "Where some text starts (case-sensitive).", (f, a) => { const s = S(a[1]), st = optN(a[2], 1); if (num(s, st)) return num(s, st)!; const i = (s as string).indexOf(f, Math.floor(st as number) - 1); return i < 0 ? ERR.value : i + 1; }, 2, 3);
txt("SEARCH", "search_for, text, [start]", "Where some text starts (any case, * and ? wildcards).", (f, a) => {
  const s = S(a[1]), st = optN(a[2], 1); if (num(s, st)) return num(s, st)!;
  const re = new RegExp(wildcard(f).source.slice(1, -1), "is");
  const from = Math.floor(st as number) - 1;
  const m = re.exec((s as string).slice(from));
  return m ? from + m.index + 1 : ERR.value;
}, 2, 3);
txt("SUBSTITUTE", "text, search_for, replace_with, [occurrence]", "Replaces some text with other text.", (s, a) => {
  const f = S(a[1]), r = S(a[2]); if (num(f, r)) return num(f, r)!;
  if (f === "") return s;
  if (!given(a[3])) return s.split(f as string).join(r as string);
  const k = N(a[3]); if (isErr(k)) return k;
  let idx = -1;
  for (let i = 0; i < k; i++) { idx = s.indexOf(f as string, idx + 1); if (idx < 0) return s; }
  return s.slice(0, idx) + r + s.slice(idx + (f as string).length);
}, 3, 4);
txt("REPLACE", "text, position, length, new_text", "Replaces part of some text by position.", (s, a) => { const p = N(a[1]), n = N(a[2]), t = S(a[3]); if (num(p, n, t)) return num(p, n, t)!; const i = Math.floor(p as number) - 1; return s.slice(0, i) + t + s.slice(i + Math.floor(n as number)); }, 4, 4);
txt("REPT", "text, times", "Repeats some text.", (s, a) => { const n = N(a[1]); return isErr(n) ? n : n < 0 ? ERR.value : s.repeat(Math.floor(n)); }, 2, 2);
txt("EXACT", "text1, text2", "TRUE if two texts match exactly (case too).", (s, a) => { const t = S(a[1]); return isErr(t) ? t : s === t; }, 2, 2);
txt("CODE", "text", "The character code of the first character.", (s) => s ? s.codePointAt(0)! : ERR.value);
alias("UNICODE", "CODE");
def("CHAR", { min: 1, max: 1, args: "number", desc: "The character with a code.", cat: "Text", lift: true, fn: (a) => { const n = N(a[0]); return isErr(n) ? n : n < 1 ? ERR.value : String.fromCodePoint(Math.floor(n)); } });
alias("UNICHAR", "CHAR");
def("VALUE", { min: 1, max: 1, args: "text", desc: "Turns text into a number.", cat: "Text", lift: true, fn: (a) => { const v = scalar(a[0]); if (typeof v === "number" || isErr(v)) return v; return toNum(v); } });
def("TEXT", { min: 2, max: 2, args: "value, format", desc: "Formats a number or date as text, e.g. TEXT(A1, \"dd mmm yyyy\").", cat: "Text", lift: true, fn: (a) => { const v = scalar(a[0]), f = S(a[1]); if (isErr(v)) return v; if (isErr(f)) return f; return textFormat(v, f); } });
def("FIXED", { min: 1, max: 3, args: "number, [decimals], [no_commas]", desc: "A number as text with fixed decimals.", cat: "Text", lift: true, fn: (a) => { const x = N(a[0]), d = optN(a[1], 2), nc = optB(a[2], false); if (num(x, d, nc)) return num(x, d, nc)!; return new Intl.NumberFormat("en-GB", { useGrouping: !nc, minimumFractionDigits: Math.max(0, d as number), maximumFractionDigits: Math.max(0, d as number) }).format(roundTo(x as number, d as number, "round")); } });
def("CONCAT", { min: 1, max: 255, args: "value1, [value2, …]", desc: "Joins text together.", cat: "Text", fn: (a) => { let s = ""; for (const x of a) for (const v of each(x)) { if (isErr(v)) return v; s += toStr(v); } return s; } });
def("CONCATENATE", { min: 1, max: 255, args: "text1, [text2, …]", desc: "Joins text together.", cat: "Text", lift: true, fn: (a) => { let s = ""; for (const x of a) { const v = scalar(x); if (isErr(v)) return v; s += toStr(v); } return s; } });
def("TEXTJOIN", { min: 3, max: 255, args: "delimiter, ignore_empty, text1, [text2, …]", desc: "Joins text with a separator between each.", cat: "Text", fn: (a) => {
  const d = S(a[0]), ig = B(a[1]); if (num(d, ig)) return num(d, ig)!;
  const parts: string[] = [];
  for (const x of a.slice(2)) for (const v of each(x)) { if (isErr(v)) return v; const s = toStr(v); if (ig && s === "") continue; parts.push(s); }
  return parts.join(d as string);
} });
const splitter = (seps: string[], each_: boolean) => {
  if (each_) { const chars = [...new Set(seps.join(""))]; return (s: string) => chars.length ? s.split(new RegExp(`[${chars.map((c) => c.replace(/[\]\\^-]/g, "\\$&")).join("")}]`)) : [s]; }
  const valid = seps.filter(Boolean);
  return (s: string) => valid.length ? s.split(new RegExp(valid.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"))) : [s];
};
def("SPLIT", { min: 2, max: 4, args: "text, delimiter, [split_by_each], [remove_empty]", desc: "Splits text into cells across a row.", cat: "Text", spills: true, fn: (a) => {
  const s = S(a[0]), d = S(a[1]), each_ = optB(a[2], true), rm = optB(a[3], true);
  if (num(s, d, each_, rm)) return num(s, d, each_, rm)!;
  let parts = splitter([d as string], each_ as boolean)(s as string);
  if (rm) parts = parts.filter((p) => p !== "");
  return parts.length ? arr([parts.map((p) => { const n = parseNum(p); return Number.isNaN(n) ? p : n; })]) : "";
} });
def("TEXTSPLIT", { min: 2, max: 4, args: "text, column_delimiter, [row_delimiter], [ignore_empty]", desc: "Splits text into a grid of cells.", cat: "Text", spills: true, fn: (a) => {
  const s = S(a[0]); if (isErr(s)) return s;
  const cd = given(a[1]) ? [...each(a[1])].map(toStr) : [];
  const rd = given(a[2]) ? [...each(a[2])].map(toStr) : [];
  const ig = optB(a[3], false); if (isErr(ig)) return ig;
  const rows = splitter(rd, false)(s).filter((r) => !ig || r !== "");
  const m = rows.map((r) => splitter(cd, false)(r).filter((c) => !ig || c !== ""));
  const w = Math.max(...m.map((r) => r.length));
  return arr(m.map((r) => [...r, ...Array(w - r.length).fill(ERR.na)]));
} });
const beforeAfter = (after: boolean) => (a: Any[]) => {
  const s = S(a[0]), d = S(a[1]), k = optN(a[2], 1);
  if (num(s, d, k)) return num(s, d, k)!;
  const str = s as string, del = d as string;
  let idx = -1;
  if ((k as number) > 0) { for (let i = 0; i < (k as number); i++) { idx = str.indexOf(del, idx + 1); if (idx < 0) return given(a[5]) ? a[5] : ERR.na; } }
  else { idx = str.length; for (let i = 0; i < -(k as number); i++) { idx = str.lastIndexOf(del, idx - 1); if (idx < 0) return given(a[5]) ? a[5] : ERR.na; } }
  return after ? str.slice(idx + del.length) : str.slice(0, idx);
};
def("TEXTBEFORE", { min: 2, max: 6, args: "text, delimiter, [instance]", desc: "The text before a delimiter.", cat: "Text", lift: [0], fn: beforeAfter(false) });
def("TEXTAFTER", { min: 2, max: 6, args: "text, delimiter, [instance]", desc: "The text after a delimiter.", cat: "Text", lift: [0], fn: beforeAfter(true) });

/* Dates */
def("TODAY", { min: 0, max: 0, desc: "Today's date.", cat: "Date", date: "date", volatile: true, fn: () => { const d = new Date(); return serialYMD(d.getFullYear(), d.getMonth() + 1, d.getDate()); } });
def("NOW", { min: 0, max: 0, desc: "The date and time right now.", cat: "Date", date: "datetime", volatile: true, fn: () => { const d = new Date(); return serialYMD(d.getFullYear(), d.getMonth() + 1, d.getDate()) + (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400; } });
def("DATE", { min: 3, max: 3, args: "year, month, day", desc: "A date from its parts.", cat: "Date", date: "date", lift: true, fn: (a) => {
  const y = N(a[0]), m = N(a[1]), d = N(a[2]); if (num(y, m, d)) return num(y, m, d)!;
  let Y = Math.floor(y as number); if (Y < 1900) Y += 1900;
  return (Date.UTC(Y, Math.floor(m as number) - 1, Math.floor(d as number)) - Date.UTC(1899, 11, 30)) / 86400000;
} });
def("TIME", { min: 3, max: 3, args: "hour, minute, second", desc: "A time of day (as a fraction of a day).", cat: "Date", lift: true, fn: (a) => { const h = N(a[0]), m = N(a[1]), s = N(a[2]); if (num(h, m, s)) return num(h, m, s)!; const t = ((h as number) * 3600 + (m as number) * 60 + (s as number)) / 86400; return t - Math.floor(t); } });
const datePart = (name: string, desc: string, f: (n: number) => number) => def(name, { min: 1, max: 1, args: "date", desc, cat: "Date", lift: true, fn: (a) => { const n = N(a[0]); return isErr(n) ? n : n < 0 ? ERR.num : f(n); } });
datePart("YEAR", "The year of a date.", (n) => ymd(n)[0]);
datePart("MONTH", "The month of a date (1–12).", (n) => ymd(n)[1]);
datePart("DAY", "The day of the month (1–31).", (n) => ymd(n)[2]);
datePart("HOUR", "The hour of a time (0–23).", (n) => Math.floor(Math.round((n - Math.floor(n)) * 86400) / 3600) % 24);
datePart("MINUTE", "The minute of a time.", (n) => Math.floor(Math.round((n - Math.floor(n)) * 86400) / 60) % 60);
datePart("SECOND", "The second of a time.", (n) => Math.round((n - Math.floor(n)) * 86400) % 60);
datePart("ISOWEEKNUM", "The ISO week number of a date.", (n) => { const d = dateOf(Math.floor(n)); const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day); const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return Math.ceil(((t.getTime() - y0.getTime()) / 86400000 + 1) / 7); });
def("WEEKDAY", { min: 1, max: 2, args: "date, [type]", desc: "Day of the week (1 = Sunday by default; type 2 → 1 = Monday).", cat: "Date", lift: true, fn: (a) => { const n = N(a[0]), t = optN(a[1], 1); if (num(n, t)) return num(n, t)!; const w = weekday(n as number); return t === 2 ? ((w + 6) % 7) + 1 : t === 3 ? (w + 6) % 7 : w + 1; } });
def("WEEKNUM", { min: 1, max: 2, args: "date, [type]", desc: "The week of the year (weeks start on Sunday, or Monday with type 2).", cat: "Date", lift: true, fn: (a) => { const n = N(a[0]), t = optN(a[1], 1); if (num(n, t)) return num(n, t)!; const [y] = ymd(n as number); const jan1 = serialYMD(y, 1, 1); const start = t === 2 ? 1 : 0; const off = (weekday(jan1) - start + 7) % 7; return Math.floor((Math.floor(n as number) - jan1 + off) / 7) + 1; } });
def("EDATE", { min: 2, max: 2, args: "date, months", desc: "The same day, some months before or after.", cat: "Date", date: "date", lift: true, fn: (a) => { const n = N(a[0]), k = N(a[1]); return num(n, k) ?? addMonths(n as number, Math.trunc(k as number)); } });
def("EOMONTH", { min: 2, max: 2, args: "date, months", desc: "The last day of the month, some months before or after.", cat: "Date", date: "date", lift: true, fn: (a) => { const n = N(a[0]), k = N(a[1]); if (num(n, k)) return num(n, k)!; const [y, m] = ymd(n as number); const t = m - 1 + Math.trunc(k as number); const ny = y + Math.floor(t / 12), nm = ((t % 12) + 12) % 12 + 1; return serialYMD(ny, nm, daysInMonth(ny, nm)); } });
def("DAYS", { min: 2, max: 2, args: "end_date, start_date", desc: "Days between two dates.", cat: "Date", lift: true, fn: (a) => { const e = N(a[0]), s = N(a[1]); return num(e, s) ?? Math.floor(e as number) - Math.floor(s as number); } });
def("DATEDIF", { min: 3, max: 3, args: "start_date, end_date, unit", desc: "Time between dates in \"Y\", \"M\", \"D\", \"MD\", \"YM\" or \"YD\".", cat: "Date", lift: true, fn: (a) => {
  const s = N(a[0]), e = N(a[1]), u = S(a[2]); if (num(s, e, u)) return num(s, e, u)!;
  if ((s as number) > (e as number)) return ERR.num;
  const [y1, m1, d1] = ymd(s as number), [y2, m2, d2] = ymd(e as number);
  let months = (y2 - y1) * 12 + (m2 - m1); if (d2 < d1) months--;
  switch ((u as string).toUpperCase()) {
    case "Y": return Math.floor(months / 12);
    case "M": return months;
    case "D": return Math.floor(e as number) - Math.floor(s as number);
    case "YM": return months % 12;
    case "MD": { let d = d2 - d1; if (d < 0) d += daysInMonth(m2 === 1 ? y2 - 1 : y2, m2 === 1 ? 12 : m2 - 1); return d; }
    case "YD": { let start = serialYMD(y2, m1, Math.min(d1, daysInMonth(y2, m1))); if (start > (e as number)) start = serialYMD(y2 - 1, m1, Math.min(d1, daysInMonth(y2 - 1, m1))); return Math.floor(e as number) - start; }
  }
  return ERR.num;
} });
def("NETWORKDAYS", { min: 2, max: 3, args: "start_date, end_date, [holidays]", desc: "Working days (Mon–Fri) between two dates, inclusive.", cat: "Date", fn: (a) => {
  const s = N(a[0]), e = N(a[1]); if (num(s, e)) return num(s, e)!;
  const hol = holidaySet(a[2]); if (isErr(hol)) return hol;
  let a0 = Math.floor(s as number), b0 = Math.floor(e as number), sign = 1;
  if (a0 > b0) { [a0, b0] = [b0, a0]; sign = -1; }
  let n = 0;
  for (let d = a0; d <= b0; d++) { const w = weekday(d); if (w !== 0 && w !== 6 && !hol.has(d)) n++; }
  return n * sign;
} });
def("WORKDAY", { min: 2, max: 3, args: "start_date, days, [holidays]", desc: "The date some working days later (or earlier).", cat: "Date", date: "date", fn: (a) => {
  const s = N(a[0]), k = N(a[1]); if (num(s, k)) return num(s, k)!;
  const hol = holidaySet(a[2]); if (isErr(hol)) return hol;
  let d = Math.floor(s as number), left = Math.trunc(k as number);
  const step = left < 0 ? -1 : 1;
  while (left !== 0) { d += step; const w = weekday(d); if (w !== 0 && w !== 6 && !hol.has(d)) left -= step; }
  return d;
} });
def("DATEVALUE", { min: 1, max: 1, args: "date_text", desc: "Turns a date written as text into a date.", cat: "Date", date: "date", lift: true, fn: (a) => { const v = scalar(a[0]); if (isErr(v)) return v; const n = toNum(v); return isErr(n) ? n : Math.floor(n); } });
def("YEARFRAC", { min: 2, max: 3, args: "start_date, end_date, [basis]", desc: "The fraction of a year between two dates.", cat: "Date", lift: true, fn: (a) => {
  let s = N(a[0]), e = N(a[1]); const b = optN(a[2], 0); if (num(s, e, b)) return num(s, e, b)!;
  if ((s as number) > (e as number)) [s, e] = [e, s];
  const [y1, m1, d1] = ymd(s as number), [y2, m2, d2] = ymd(e as number);
  switch (b) {
    case 0: { const D1 = Math.min(d1, 30), D2 = d2 === 31 && D1 >= 30 ? 30 : d2; return ((y2 - y1) * 360 + (m2 - m1) * 30 + (D2 - D1)) / 360; }
    case 1: { const days = (e as number) - (s as number); const yrs = y2 - y1 + 1; let tot = 0; for (let y = y1; y <= y2; y++) tot += (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365; return days / (tot / yrs); }
    case 2: return ((e as number) - (s as number)) / 360;
    case 3: return ((e as number) - (s as number)) / 365;
    case 4: return ((y2 - y1) * 360 + (m2 - m1) * 30 + (Math.min(d2, 30) - Math.min(d1, 30))) / 360;
  }
  return ERR.num;
} });

/* Finance */
const fin = (name: string, args: string, desc: string, n: number, opt_: number[], f: (x: number[]) => number | FErr) =>
  def(name, { min: n, max: n + opt_.length, args, desc, cat: "Finance", lift: true, fn: (a) => {
    const xs: number[] = [];
    for (let i = 0; i < n + opt_.length; i++) { const v = i < n ? N(a[i]) : optN(a[i], opt_[i - n]); if (isErr(v)) return v; xs.push(v); }
    return f(xs);
  } });
fin("PMT", "rate, periods, present_value, [future_value], [type]", "The regular payment on a loan or investment.", 3, [0, 0], ([r, n, pv, fv, t]) => n === 0 ? ERR.num : pmt(r, n, pv, fv, t));
fin("IPMT", "rate, period, periods, present_value, [future_value], [type]", "The interest part of one payment.", 4, [0, 0], ([r, per, n, pv, fv, t]) => per < 1 || per > n ? ERR.num : ipmt(r, per, n, pv, fv, t));
fin("PPMT", "rate, period, periods, present_value, [future_value], [type]", "The principal part of one payment.", 4, [0, 0], ([r, per, n, pv, fv, t]) => per < 1 || per > n ? ERR.num : pmt(r, n, pv, fv, t) - ipmt(r, per, n, pv, fv, t));
fin("FV", "rate, periods, payment, [present_value], [type]", "What an investment will be worth.", 3, [0, 0], ([r, n, p, pv, t]) => fvOf(r, n, p, pv, t));
fin("PV", "rate, periods, payment, [future_value], [type]", "What future payments are worth today.", 3, [0, 0], ([r, n, p, fv, t]) => r === 0 ? -(fv + p * n) : -(fv + p * (1 + r * t) * (((1 + r) ** n - 1) / r)) / (1 + r) ** n);
fin("NPER", "rate, payment, present_value, [future_value], [type]", "How many payments it takes.", 3, [0, 0], ([r, p, pv, fv, t]) => {
  if (r === 0) return p === 0 ? ERR.num : -(pv + fv) / p;
  const num_ = p * (1 + r * t) - fv * r, den = p * (1 + r * t) + pv * r;
  return num_ / den <= 0 ? ERR.num : Math.log(num_ / den) / Math.log(1 + r);
});
fin("RATE", "periods, payment, present_value, [future_value], [type], [guess]", "The interest rate per period.", 3, [0, 0, 0.1], ([n, p, pv, fv, t, g]) => solve((r) => Math.abs(r) < 1e-12 ? pv + p * n + fv : pv * (1 + r) ** n + p * (1 + r * t) * (((1 + r) ** n - 1) / r) + fv, g));
def("NPV", { min: 2, max: 255, args: "rate, value1, [value2, …]", desc: "Net present value of future cash flows.", cat: "Finance", fn: (a) => {
  const r = N(a[0]); if (isErr(r)) return r;
  const v = numbers(a.slice(1)); if (isErr(v)) return v;
  return v.reduce((s, x, i) => s + x / (1 + r) ** (i + 1), 0);
} });
def("IRR", { min: 1, max: 2, args: "cash_flows, [guess]", desc: "Internal rate of return of cash flows.", cat: "Finance", fn: (a) => {
  const v = numbers([a[0]]); if (isErr(v)) return v;
  const g = optN(a[1], 0.1); if (isErr(g)) return g;
  if (!v.some((x) => x > 0) || !v.some((x) => x < 0)) return ERR.num;
  return solve((r) => v.reduce((s, x, i) => s + x / (1 + r) ** i, 0), g);
} });
def("XNPV", { min: 3, max: 3, args: "rate, cash_flows, dates", desc: "Net present value of cash flows on given dates.", cat: "Finance", fn: (a) => {
  const r = N(a[0]); if (isErr(r)) return r;
  const v = flat1(a[1]).map(toNum), d = flat1(a[2]).map(toNum);
  if (v.length !== d.length) return ERR.num;
  const e = [...v, ...d].find(isErr); if (e) return e;
  return (v as number[]).reduce((s, x, i) => s + x / (1 + r) ** (((d[i] as number) - (d[0] as number)) / 365), 0);
} });
def("XIRR", { min: 2, max: 3, args: "cash_flows, dates, [guess]", desc: "Internal rate of return for cash flows on given dates.", cat: "Finance", fn: (a) => {
  const v = flat1(a[0]).map(toNum), d = flat1(a[1]).map(toNum);
  if (v.length !== d.length) return ERR.num;
  const e = [...v, ...d].find(isErr); if (e) return e;
  const g = optN(a[2], 0.1); if (isErr(g)) return g;
  return solve((r) => (v as number[]).reduce((s, x, i) => s + x / (1 + r) ** (((d[i] as number) - (d[0] as number)) / 365), 0), g);
} });

/* LET, LAMBDA and helpers */
def("LET", { min: 3, max: 253, args: "name1, value1, [name2, value2, …], calculation", desc: "Names values so a formula can reuse them.", cat: "Lambda", spills: true, lazy: (n, x) => {
  if (n.length % 2 === 0) return ERR.value;
  const env: Env = { vars: new Map(), parent: x.env };
  for (let i = 0; i + 1 < n.length; i += 2) {
    const nm = n[i];
    if (nm.k !== "name") return ERR.value;
    env.vars.set(nm.v, x.ev(n[i + 1], env));
  }
  return x.ev(n[n.length - 1], env);
} });
def("LAMBDA", { min: 1, max: 254, args: "[parameter1, …], calculation", desc: "Makes a reusable function, e.g. LAMBDA(x, x*2).", cat: "Lambda", lazy: (n, x) => {
  const params: string[] = [];
  for (const p of n.slice(0, -1)) { if (p.k !== "name") return ERR.value; params.push(p.v); }
  return { k: "lam", params, body: n[n.length - 1], env: x.env } as LamV;
} });
def("ISOMITTED", { min: 1, max: 1, args: "argument", desc: "TRUE if a LAMBDA argument was left out.", cat: "Lambda", lazy: (n, x) => isOmit(x.ev(n[0])) });
def("MAP", { min: 2, max: 254, args: "array1, [array2, …], lambda", desc: "Runs a LAMBDA on each value.", cat: "Lambda", spills: true, fn: (a, x) => {
  const l = lamOf(a[a.length - 1]); if (isErr(l)) return l;
  const arrs = a.slice(0, -1);
  const [h, w] = dims(arrs[0]);
  const out: Val[][] = [];
  for (let i = 0; i < h; i++) { const row: Val[] = []; for (let j = 0; j < w; j++) row.push(asVal(x.call(l, arrs.map((m) => at(m, i, j))))); out.push(row); }
  return arr(out);
} });
def("REDUCE", { min: 3, max: 3, args: "initial_value, array, lambda(total, value)", desc: "Builds up one result from each value.", cat: "Lambda", fn: (a, x) => {
  const l = lamOf(a[2]); if (isErr(l)) return l;
  let acc: Any = a[0];
  for (const v of each(a[1])) acc = x.call(l, [acc, v]);
  return acc;
} });
def("SCAN", { min: 3, max: 3, args: "initial_value, array, lambda(total, value)", desc: "Like REDUCE, but shows every step.", cat: "Lambda", spills: true, fn: (a, x) => {
  const l = lamOf(a[2]); if (isErr(l)) return l;
  let acc: Any = a[0];
  const m = toArr(a[1]);
  return arr(m.map((row) => row.map((v) => { acc = x.call(l, [acc, v]); return asVal(acc); })));
} });
def("BYROW", { min: 2, max: 2, args: "array, lambda(row)", desc: "Runs a LAMBDA on each row.", cat: "Lambda", spills: true, fn: (a, x) => { const l = lamOf(a[1]); if (isErr(l)) return l; return col(toArr(a[0]).map((r) => asVal(x.call(l, [arr([r])])))); } });
def("BYCOL", { min: 2, max: 2, args: "array, lambda(column)", desc: "Runs a LAMBDA on each column.", cat: "Lambda", spills: true, fn: (a, x) => { const l = lamOf(a[1]); if (isErr(l)) return l; return arr([transpose(toArr(a[0])).map((c) => asVal(x.call(l, [col(c)])))]); } });
def("MAKEARRAY", { min: 3, max: 3, args: "rows, columns, lambda(row, column)", desc: "Builds an array cell by cell.", cat: "Lambda", spills: true, fn: (a, x) => {
  const h = N(a[0]), w = N(a[1]); if (num(h, w)) return num(h, w)!;
  const l = lamOf(a[2]); if (isErr(l)) return l;
  const out: Val[][] = [];
  for (let i = 1; i <= (h as number); i++) { const row: Val[] = []; for (let j = 1; j <= (w as number); j++) row.push(asVal(x.call(l, [i, j]))); out.push(row); }
  return arr(out);
} });

void OMIT; void formatNumber;

export const FUNCTION_NAMES = Object.keys(FUNCS).sort();
