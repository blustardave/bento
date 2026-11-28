/* ------------------------------------------------------------------ *
 * The full function library: Bento's own functions (functions.ts),
 * more of our own here (bonds, regex, GROUPBY/PIVOTBY…), and the
 * specialist families (distributions, engineering, database…) from
 * Formula.js (MIT licence), adapted to Bento's values.
 * ------------------------------------------------------------------ */
import * as fjs from "@formulajs/formulajs";
import { jStat } from "jstat";
import { maxOf, minOf } from "./util";
import {
  Any, ERR, FErr, LamV, Node, Val, criterion,
  arr, at, cmp, col, dateOf, dims, each, isArr, isErr, isLam, isMulti, isOmit, isRef, scalar, serialOf, toArr, toNum, toStr,
} from "./fcore";
import {
  FUNCS, type Cat, type Ctx, type FnSpec,
  N, S, given, optN, optB, num, numbers, def, alias, ymd, daysInMonth, addMonths, solve, transpose, flat1,
} from "./functions";

/* ------------------------------ Formula.js ------------------------------ */

const FJS_ERRORS: Record<string, FErr> = {
  "#VALUE!": ERR.value, "#DIV/0!": ERR.div0, "#NAME?": ERR.name, "#REF!": ERR.ref, "#N/A": ERR.na, "#NUM!": ERR.num, "#NULL!": new FErr("#NULL!"), "#GETTING_DATA": ERR.na, "#ERROR!": ERR.parse,
};
const fjsErrors = (fjs as unknown as { utils?: { errors?: Record<string, Error> } }).utils?.errors ?? {};
const toFjsError = (e: FErr): Error => {
  for (const v of Object.values(fjsErrors)) if (v?.message === e.code) return v;
  return new Error(e.code);
};

/** Bento values → what Formula.js expects. Ranges become 2-D arrays; one cell becomes a plain value. */
function toJs(a: Any): unknown {
  if (isOmit(a)) return undefined;
  if (isLam(a)) return undefined;
  const one = (v: Val): unknown => isErr(v) ? toFjsError(v) : v === "" ? null : v;
  if (isMulti(a)) {
    const [h, w] = dims(a);
    if (h === 1 && w === 1) return one(at(a, 0, 0));
    return toArr(a).map((r) => r.map(one));
  }
  return one(a as Val);
}

/** Formula.js results → Bento values. */
function fromJs(v: unknown): Any {
  if (v instanceof Error) return FJS_ERRORS[v.message] ?? ERR.value;
  if (v instanceof Date) return serialOf(new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate())));
  if (typeof v === "number") return Number.isFinite(v) ? v : ERR.num;
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) {
    const rows = Array.isArray(v[0]) ? (v as unknown[][]) : (v as unknown[]).map((x) => [x]);
    return arr(rows.map((r) => r.map((x) => { const y = fromJs(x); return isMulti(y) || isLam(y) || isOmit(y) ? ERR.value : y as Val; })));
  }
  return ERR.value;
}

/** Excel's names for Formula.js functions that are exported under other names. */
const RENAME: Record<string, string> = { POISSONDIST: "POISSON", WEIBULLDIST: "WEIBULL" };
/** Formula.js internals / duplicates that aren't real Excel names. */
const SKIP = new Set([
  "CEILINGMATH", "CEILINGPRECISE", "FLOORMATH", "FLOORPRECISE", "GAMMALNPRECISE", "NETWORKDAYSINTL", "WORKDAYINTL",
  "MODEMULT", "MODESNGL", "PERCENTILEEXC", "PERCENTILEINC", "PERCENTRANKEXC", "PERCENTRANKINC", "QUARTILEEXC", "QUARTILEINC",
  "RANKAVG", "RANKEQ", "STDEVS", "VARS", "CHIDISTRT", "CHIINVRT", "FDISTRT", "FINVRT", "TDISTRT", "COVARIANCEP", "COVARIANCES",
  "BINOMDIST.RANGE", "CHIDIST.RT", "CHIINV.RT", "FDIST.RT", "FINV.RT", "TDIST.2T", "TDIST.RT", "TINV.2T", "ISO.CEILING.MATH",
  "ISO.CEILING.PRECISE", "LOGNORMINV", "SKEWP", "EXPAND", "NORM.S",
]);
/** Ones that give arrays (and so may spill). */
const ARRAY_FNS = new Set(["FREQUENCY", "LINEST", "LOGEST", "TREND", "GROWTH", "MODE.MULT", "MUNIT"]);

function category(n: string): Cat {
  if (/^(IM|BESSEL|BIN2|DEC2|HEX2|OCT2|BIT|ERF|COMPLEX|CONVERT|DELTA|GESTEP|BASE|DECIMAL)/.test(n)) return "Engineering";
  if (/^D(AVERAGE|COUNT|COUNTA|GET|MAX|MIN|PRODUCT|STDEV|STDEVP|SUM|VAR|VARP)$/.test(n)) return "Database";
  if (/^(ACCRINT|COUP|CUM|DB|DDB|DISC|DOLLAR|EFFECT|FVSCHEDULE|ISPMT|MIRR|NOMINAL|PDURATION|PRICEDISC|RRI|SLN|SYD|TBILL)/.test(n)) return "Finance";
  if (/^(ARABIC|ROMAN|DOLLAR|NUMBERVALUE|T)$/.test(n)) return "Text";
  if (/^(DAYS360|NETWORKDAYS\.INTL|WORKDAY\.INTL|TIMEVALUE)$/.test(n)) return "Date";
  if (/^(TYPE|ERROR\.TYPE)$/.test(n)) return "Info";
  if (/^(ACOSH|ACOT|ACOTH|ASINH|ATANH|COSH|COT|COTH|CSC|CSCH|SEC|SECH|SINH|TANH|COMBINA|FACTDOUBLE|MULTINOMIAL|PERMUTATIONA|SERIESSUM|SQRTPI|SUMX2MY2|SUMX2PY2|SUMXMY2|MUNIT|SUBTOTAL|AGGREGATE|CEILING\.PRECISE|FLOOR\.PRECISE|ISO\.CEILING)$/.test(n)) return "Math";
  return "Statistics";
}

/** Short descriptions for suggestions; the rest get a generic one. */
const DESC: Record<string, string> = {
  "NORM.DIST": "Normal distribution (TRUE = cumulative).", "NORM.INV": "Inverse of the normal distribution.", "NORM.S.DIST": "Standard normal distribution.", "NORM.S.INV": "Inverse of the standard normal distribution.",
  "T.DIST": "Student's t-distribution.", "T.INV": "Inverse of the t-distribution.", "T.TEST": "Probability from a Student's t-test.", "T.DIST.2T": "Two-tailed t-distribution.", "T.DIST.RT": "Right-tailed t-distribution.", "T.INV.2T": "Two-tailed inverse t-distribution.",
  "BINOM.DIST": "Binomial distribution probability.", "POISSON.DIST": "Poisson distribution.", "EXPON.DIST": "Exponential distribution.", "CHISQ.TEST": "Chi-squared test of independence.", "CHISQ.DIST": "Chi-squared distribution.",
  "F.TEST": "F-test: are two variances different?", "Z.TEST": "One-tailed P-value of a z-test.", "CONFIDENCE.NORM": "Confidence interval for a mean (normal).", "CONFIDENCE.T": "Confidence interval for a mean (t).",
  "COVARIANCE.P": "Covariance of a population.", "COVARIANCE.S": "Covariance of a sample.", "PEARSON": "Pearson correlation coefficient.", "RSQ": "R² of the best-fit line.", "STEYX": "Standard error of predicted y-values.",
  "KURT": "Kurtosis (how peaked the data is).", "SKEW": "Skewness of the data.", "SKEW.P": "Skewness of a population.", "AVEDEV": "Average distance from the mean.", "DEVSQ": "Sum of squared deviations.", "HARMEAN": "Harmonic mean.",
  "TRIMMEAN": "Mean without the outer percentage of values.", "STANDARDIZE": "z-score of a value.", "FREQUENCY": "How many values fall in each bin.", "LINEST": "Statistics for a best-fit line.", "TREND": "Values along a best-fit line.", "GROWTH": "Values along an exponential trend.", "LOGEST": "Statistics for an exponential curve.",
  "PERCENTRANK.INC": "A value's rank as a percentage.", "PERCENTILE.EXC": "Percentile (excluding 0 and 1).", "QUARTILE.EXC": "Quartile (excluding 0 and 1).", "MODE.MULT": "All the most common values.", "AVERAGEA": "Mean, counting text as 0 and TRUE as 1.", "MAXA": "Largest value, counting TRUE as 1.", "MINA": "Smallest value, counting TRUE as 1.",
  "STDEVA": "Standard deviation, counting text and logicals.", "VARA": "Variance, counting text and logicals.", "GAMMA": "The gamma function.", "GAMMALN": "Natural log of the gamma function.", "FISHER": "Fisher transformation.", "PHI": "Standard normal density.", "GAUSS": "Probability between the mean and z standard deviations.", "PROB": "Probability that values fall between limits.",
  CONVERT: "Converts between units, e.g. CONVERT(1, \"mi\", \"km\").", BIN2DEC: "Binary to decimal.", DEC2BIN: "Decimal to binary.", DEC2HEX: "Decimal to hexadecimal.", HEX2DEC: "Hexadecimal to decimal.", DEC2OCT: "Decimal to octal.", OCT2DEC: "Octal to decimal.", BASE: "A number in another base.", DECIMAL: "A number from another base.",
  BITAND: "Bitwise AND.", BITOR: "Bitwise OR.", BITXOR: "Bitwise XOR.", BITLSHIFT: "Shift bits left.", BITRSHIFT: "Shift bits right.", COMPLEX: "Builds a complex number.", IMSUM: "Adds complex numbers.", IMPRODUCT: "Multiplies complex numbers.", IMABS: "Size of a complex number.", ERF: "The error function.", DELTA: "1 if two numbers are equal.", GESTEP: "1 if a number is at least a step.",
  DSUM: "Adds a database column where rows meet criteria.", DAVERAGE: "Averages a database column where rows meet criteria.", DCOUNT: "Counts numbers in a database column meeting criteria.", DCOUNTA: "Counts non-empty cells in a database column meeting criteria.", DGET: "The one value in a database column meeting criteria.", DMAX: "Largest database value meeting criteria.", DMIN: "Smallest database value meeting criteria.",
  SLN: "Straight-line depreciation for one period.", SYD: "Sum-of-years' digits depreciation.", DB: "Fixed-declining balance depreciation.", DDB: "Double-declining balance depreciation.", EFFECT: "Effective annual interest rate.", NOMINAL: "Nominal annual interest rate.", MIRR: "Modified internal rate of return.", CUMIPMT: "Interest paid between two periods.", CUMPRINC: "Principal paid between two periods.",
  ACCRINT: "Accrued interest for a security that pays periodically.", DISC: "Discount rate of a security.", PRICEDISC: "Price of a discounted security.", TBILLPRICE: "Price of a Treasury bill.", TBILLYIELD: "Yield of a Treasury bill.", TBILLEQ: "Bond-equivalent yield of a Treasury bill.", RRI: "Equivalent interest rate for growth.", PDURATION: "Periods for an investment to reach a value.", FVSCHEDULE: "Future value with changing rates.", ISPMT: "Interest paid in a period (even principal).", DOLLARDE: "Fractional dollar price as a decimal.", DOLLARFR: "Decimal dollar price as a fraction.",
  SUBTOTAL: "A subtotal (9 = SUM, 1 = AVERAGE, …) ignoring other subtotals.", AGGREGATE: "Like SUBTOTAL, with options to ignore errors.", SINH: "Hyperbolic sine.", COSH: "Hyperbolic cosine.", TANH: "Hyperbolic tangent.", MUNIT: "Identity matrix.", SUMXMY2: "Sum of squared differences.", COMBINA: "Combinations with repetition.", MULTINOMIAL: "Multinomial of the numbers.", FACTDOUBLE: "Double factorial.",
  ROMAN: "Roman numerals.", ARABIC: "Roman numerals to a number.", DOLLAR: "A number as currency text.", NUMBERVALUE: "Text to a number, with chosen separators.", T: "The text, or \"\" if it isn't text.", TYPE: "1 number, 2 text, 4 logical, 16 error, 64 array.", "ERROR.TYPE": "Which error it is (1–8).",
  DAYS360: "Days between dates on a 360-day year.", "NETWORKDAYS.INTL": "Working days, with your own weekend.", "WORKDAY.INTL": "A date some working days away, with your own weekend.", TIMEVALUE: "A time from text.",
};

function paramsOf(f: (...a: unknown[]) => unknown): string {
  const src = f.toString();
  const m = /^(?:function\s*[\w$]*\s*)?\(([^)]*)\)/.exec(src) ?? /^([\w$]+)\s*=>/.exec(src);
  const list = (m?.[1] ?? "").split(",").map((p) => p.trim().replace(/\s*=.*$/, "").replace(/\$\d+$/, "")).filter(Boolean);
  return list.length ? list.join(", ") : "value1, [value2, …]";
}

function addFormulaJs() {
  const found: [string, (...a: unknown[]) => unknown][] = [];
  const walk = (o: Record<string, unknown>, prefix: string, depth: number) => {
    for (const k of Object.keys(o)) {
      if (k === "utils" || !/^[A-Z0-9]/.test(k)) continue;
      const v = o[k];
      const name = prefix ? `${prefix}.${k}` : k;
      if (typeof v === "function") found.push([name, v as (...a: unknown[]) => unknown]);
      if (v && (typeof v === "object" || typeof v === "function") && depth < 3) walk(v as Record<string, unknown>, name, depth + 1);
    }
  };
  walk(fjs as unknown as Record<string, unknown>, "", 0);
  for (const [raw, f] of found) {
    const name = RENAME[raw] ?? raw;
    if (SKIP.has(raw) || FUNCS[name]) continue;
    const cat = category(name);
    const spec: FnSpec = {
      min: 0, max: 255,
      sig: `${name}(${paramsOf(f)})`,
      desc: DESC[name] ?? `${cat === "Engineering" ? "Engineering" : cat === "Database" ? "Database" : cat} function, as in Excel.`,
      cat,
      spills: ARRAY_FNS.has(name),
      fn: (a) => {
        try { return fromJs(f(...a.map(toJs))); } catch { return ERR.value; }
      },
    };
    FUNCS[name] = spec;
  }
}
addFormulaJs();

/* ------------- fixes where Formula.js disagrees with Excel ------------- */

def("T.DIST", { min: 3, max: 3, args: "x, deg_freedom, cumulative", desc: "Student's t-distribution (TRUE = cumulative).", cat: "Statistics", fn: (a) => {
  const x = N(a[0]), df = N(a[1]), c = optB(a[2], true); const e = num(x, df, c); if (e) return e;
  if ((df as number) < 1) return ERR.num;
  return c ? jStat.studentt.cdf(x, Math.floor(df as number)) : jStat.studentt.pdf(x, Math.floor(df as number));
} });

FUNCS["WORKDAY.INTL"] = { ...FUNCS["WORKDAY.INTL"], date: "date" };

const tbill = (a: Any[]) => {
  const s0 = N(a[0]), m0 = N(a[1]), r = N(a[2]); const e = num(s0, m0, r); if (e) return e;
  const dsm = Math.floor(m0 as number) - Math.floor(s0 as number);
  if (dsm <= 0 || dsm > 365 || (r as number) <= 0) return ERR.num;
  return { dsm, r: r as number };
};
def("TBILLPRICE", { min: 3, max: 3, args: "settlement, maturity, discount", desc: "Price per 100 of a Treasury bill.", cat: "Finance", fn: (a) => { const t = tbill(a); return isErr(t) ? t : 100 * (1 - (t.r * t.dsm) / 360); } });
def("TBILLYIELD", { min: 3, max: 3, args: "settlement, maturity, price", desc: "Yield of a Treasury bill.", cat: "Finance", fn: (a) => { const t = tbill(a); return isErr(t) ? t : ((100 - t.r) / t.r) * (360 / t.dsm); } });
def("TBILLEQ", { min: 3, max: 3, args: "settlement, maturity, discount", desc: "Bond-equivalent yield of a Treasury bill.", cat: "Finance", fn: (a) => {
  const t = tbill(a); if (isErr(t)) return t;
  if (t.dsm <= 182) return (365 * t.r) / (360 - t.r * t.dsm);
  const p = 100 * (1 - (t.r * t.dsm) / 360), x = t.dsm / 365;
  return (-x + Math.sqrt(x * x - (2 * x - 1) * (1 - 100 / p))) / (x - 0.5);
} });

/** CONVERT, with the temperature units Formula.js lacks. */
const fjsConvert = FUNCS.CONVERT.fn!;
const TEMP: Record<string, [(v: number) => number, (k: number) => number]> = {
  // to kelvin, from kelvin
  C: [(v) => v + 273.15, (k) => k - 273.15], cel: [(v) => v + 273.15, (k) => k - 273.15],
  F: [(v) => (v - 32) * 5 / 9 + 273.15, (k) => (k - 273.15) * 9 / 5 + 32], fah: [(v) => (v - 32) * 5 / 9 + 273.15, (k) => (k - 273.15) * 9 / 5 + 32],
  K: [(v) => v, (k) => k], kel: [(v) => v, (k) => k],
  Rank: [(v) => v * 5 / 9, (k) => k * 9 / 5], Reau: [(v) => v * 1.25 + 273.15, (k) => (k - 273.15) * 0.8],
};
FUNCS.CONVERT = { ...FUNCS.CONVERT, sig: "CONVERT(number, from_unit, to_unit)", fn: (a, x) => {
  const from = S(a[1]), to = S(a[2]);
  if (!isErr(from) && !isErr(to) && (TEMP[from] || TEMP[to])) {
    const v = N(a[0]); if (isErr(v)) return v;
    if (!TEMP[from] || !TEMP[to]) return ERR.na;
    return TEMP[to][1](TEMP[from][0](v));
  }
  return fjsConvert(a, x);
} };

/** Database functions: rows with a header, a field (name or number), and a criteria block. */
function dbValues(a: Any[]): Val[] | FErr {
  const db = toArr(a[0]), crit = toArr(a[2]);
  if (db.length < 1 || crit.length < 1) return ERR.value;
  const head = db[0].map((h) => toStr(h).toLowerCase());
  const f = scalar(a[1]);
  let fi = -1;
  if (typeof f === "number") fi = Math.floor(f) - 1;
  else if (typeof f === "string") fi = head.indexOf(f.toLowerCase());
  else if (given(a[1])) return ERR.value;
  if (given(a[1]) && (fi < 0 || fi >= head.length)) return ERR.value;
  // Each criteria row is ANDed; the rows are ORed.
  const cHead = crit[0].map((h) => head.indexOf(toStr(h).toLowerCase()));
  const tests = crit.slice(1).map((row) => row.map((c, j) => (c === "" || cHead[j] < 0 ? null : { j: cHead[j], f: criterion(c) })).filter(Boolean) as { j: number; f: (v: Val) => boolean }[]);
  const out: Val[] = [];
  for (const row of db.slice(1)) {
    const ok = !tests.length || tests.some((t) => t.every(({ j, f }) => f(row[j])));
    if (ok) out.push(fi >= 0 ? row[fi] : 1);
  }
  return out;
}
const dbFn = (name: string, desc: string, f: (nums: number[], vals: Val[]) => Val) =>
  def(name, { min: 2, max: 3, args: "database, field, criteria", desc, cat: "Database", fn: (a) => {
    const v = dbValues(a.length === 2 ? [a[0], OMIT_ARG, a[1]] : a); if (isErr(v)) return v;
    return f(v.filter((x): x is number => typeof x === "number"), v);
  } });
const OMIT_ARG: Any = { k: "omit" };
const dbVar = (xs: number[], sample: boolean) => { if (xs.length < (sample ? 2 : 1)) return ERR.div0; const m = xs.reduce((p, q) => p + q, 0) / xs.length; return xs.reduce((p, q) => p + (q - m) ** 2, 0) / (xs.length - (sample ? 1 : 0)); };
dbFn("DSUM", "Adds a database column where rows meet criteria.", (n) => n.reduce((p, q) => p + q, 0));
dbFn("DAVERAGE", "Averages a database column where rows meet criteria.", (n) => n.length ? n.reduce((p, q) => p + q, 0) / n.length : ERR.div0);
dbFn("DCOUNT", "Counts numbers in a database column where rows meet criteria.", (n) => n.length);
dbFn("DCOUNTA", "Counts non-empty cells where rows meet criteria.", (_n, v) => v.filter((x) => x !== "").length);
dbFn("DMAX", "Largest value where rows meet criteria.", (n) => maxOf(n, 0));
dbFn("DMIN", "Smallest value where rows meet criteria.", (n) => minOf(n, 0));
dbFn("DPRODUCT", "Multiplies values where rows meet criteria.", (n) => n.reduce((p, q) => p * q, 1));
dbFn("DGET", "The one value where rows meet criteria.", (_n, v) => v.length === 1 ? v[0] : v.length ? ERR.num : ERR.value);
dbFn("DSTDEV", "Standard deviation (sample) where rows meet criteria.", (n) => { const v = dbVar(n, true); return isErr(v) ? v : Math.sqrt(v); });
dbFn("DSTDEVP", "Standard deviation (population) where rows meet criteria.", (n) => { const v = dbVar(n, false); return isErr(v) ? v : Math.sqrt(v); });
dbFn("DVAR", "Variance (sample) where rows meet criteria.", (n) => dbVar(n, true));
dbFn("DVARP", "Variance (population) where rows meet criteria.", (n) => dbVar(n, false));

/* ------------------------------ day counts ------------------------------ */

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const lastOfFeb = (y: number, m: number, d: number) => m === 2 && d === daysInMonth(y, 2);

/** Days between two dates under a day-count basis (0 US 30/360, 1–3 actual, 4 European 30/360). */
function dayCount(a: number, b: number, basis: number): number {
  if (basis === 0 || basis === 4) {
    let [y1, m1, d1] = ymd(a), [y2, m2, d2] = ymd(b);
    if (basis === 0) {
      if (lastOfFeb(y1, m1, d1) && lastOfFeb(y2, m2, d2)) d2 = 30;
      if (lastOfFeb(y1, m1, d1)) d1 = 30;
      if (d2 === 31 && d1 >= 30) d2 = 30;
      if (d1 === 31) d1 = 30;
    } else { if (d1 === 31) d1 = 30; if (d2 === 31) d2 = 30; }
    return (y2 - y1) * 360 + (m2 - m1) * 30 + (d2 - d1);
  }
  return Math.floor(b) - Math.floor(a);
}

function yearFrac(a: number, b: number, basis: number): number {
  if (a > b) [a, b] = [b, a];
  switch (basis) {
    case 0: case 4: return dayCount(a, b, basis) / 360;
    case 2: return (b - a) / 360;
    case 3: return (b - a) / 365;
    default: {
      const [y1] = ymd(a), [y2] = ymd(b);
      if (y1 === y2) return (b - a) / (isLeap(y1) ? 366 : 365);
      // Within a year of each other: actual days over the year length that applies.
      const oneYear = addMonths(a, 12);
      if (b <= oneYear) { const feb29 = [y1, y2].some((y) => isLeap(y) && serialOf(new Date(Date.UTC(y, 1, 29))) >= a && serialOf(new Date(Date.UTC(y, 1, 29))) <= b); return (b - a) / (feb29 ? 366 : 365); }
      let tot = 0; for (let y = y1; y <= y2; y++) tot += isLeap(y) ? 366 : 365;
      return (b - a) / (tot / (y2 - y1 + 1));
    }
  }
}

/* -------------------------- bonds and securities -------------------------- */

interface Bond { settle: number; mat: number; freq: number; basis: number }

function bondArgs(a: Any[], si: number, mi: number, fi: number, bi: number): Bond | FErr {
  const s = N(a[si]), m = N(a[mi]), f = N(a[fi]), b = optN(a[bi], 0);
  const e = num(s, m, f, b); if (e) return e;
  const freq = Math.floor(f as number), basis = Math.floor(b as number);
  if (![1, 2, 4].includes(freq) || basis < 0 || basis > 4 || Math.floor(s as number) >= Math.floor(m as number)) return ERR.num;
  return { settle: Math.floor(s as number), mat: Math.floor(m as number), freq, basis };
}

/** The coupon dates either side of settlement, and how many coupons remain. */
function coupons(b: Bond) {
  const step = 12 / b.freq;
  let n = 0;
  let next = b.mat;
  let prev = addMonths(b.mat, -step);
  // Keep the maturity day-of-month (end-of-month bonds stay end-of-month).
  const [, , md] = ymd(b.mat);
  const eom = md === daysInMonth(ymd(b.mat)[0], ymd(b.mat)[1]);
  const shift = (k: number) => { const d = addMonths(b.mat, -step * k); if (!eom) return d; const [y, m] = ymd(d); return serialOf(new Date(Date.UTC(y, m - 1, daysInMonth(y, m)))); };
  while (true) { n++; prev = shift(n); next = shift(n - 1); if (prev <= b.settle) break; if (n > 2000) break; }
  return { pcd: prev, ncd: next, num: n };
}

function coupDays(b: Bond): number {
  if (b.basis === 1) { const c = coupons(b); return c.ncd - c.pcd; }
  return (b.basis === 3 ? 365 : 360) / b.freq;
}
const coupDayBs = (b: Bond) => dayCount(coupons(b).pcd, b.settle, b.basis);
const coupDaysNc = (b: Bond) => b.basis === 0 || b.basis === 4 ? coupDays(b) - coupDayBs(b) : coupons(b).ncd - b.settle;

function bondPrice(b: Bond, rate: number, yld: number, red: number): number {
  const E = coupDays(b), A = coupDayBs(b), DSC = coupDaysNc(b), n = coupons(b).num;
  const c = (100 * rate) / b.freq, y = yld / b.freq;
  if (n === 1) return (red + c) / (1 + (DSC / E) * y) - c * (A / E);
  let p = red / (1 + y) ** (n - 1 + DSC / E);
  for (let k = 1; k <= n; k++) p += c / (1 + y) ** (k - 1 + DSC / E);
  return p - c * (A / E);
}

function duration(b: Bond, coupon: number, yld: number): number {
  const E = coupDays(b), DSC = coupDaysNc(b), n = coupons(b).num;
  const c = (100 * coupon) / b.freq, y = yld / b.freq;
  let pv = 0, wt = 0;
  for (let k = 1; k <= n; k++) {
    const t = k - 1 + DSC / E;
    const cf = c + (k === n ? 100 : 0);
    const d = cf / (1 + y) ** t;
    pv += d; wt += t * d;
  }
  return wt / pv / b.freq;
}

const couponFn = (name: string, desc: string, f: (b: Bond) => number) =>
  def(name, { min: 3, max: 4, args: "settlement, maturity, frequency, [basis]", desc, cat: "Finance", fn: (a) => { const b = bondArgs(a, 0, 1, 2, 3); return isErr(b) ? b : f(b); } });
couponFn("COUPDAYS", "Days in the coupon period containing settlement.", coupDays);
couponFn("COUPDAYBS", "Days from the start of the coupon period to settlement.", coupDayBs);
couponFn("COUPDAYSNC", "Days from settlement to the next coupon date.", coupDaysNc);
couponFn("COUPNUM", "Coupons payable between settlement and maturity.", (b) => coupons(b).num);
FUNCS.COUPNCD = { ...FUNCS.COUPNUM, sig: "COUPNCD(settlement, maturity, frequency, [basis])", desc: "The next coupon date after settlement.", date: "date", fn: (a) => { const b = bondArgs(a, 0, 1, 2, 3); return isErr(b) ? b : coupons(b).ncd; } };
FUNCS.COUPPCD = { ...FUNCS.COUPNUM, sig: "COUPPCD(settlement, maturity, frequency, [basis])", desc: "The coupon date before settlement.", date: "date", fn: (a) => { const b = bondArgs(a, 0, 1, 2, 3); return isErr(b) ? b : coupons(b).pcd; } };
def("PRICE", { min: 6, max: 7, args: "settlement, maturity, rate, yield, redemption, frequency, [basis]", desc: "Price per 100 face value of a bond.", cat: "Finance", fn: (a) => {
  const b = bondArgs(a, 0, 1, 5, 6); if (isErr(b)) return b;
  const r = N(a[2]), y = N(a[3]), red = N(a[4]); const e = num(r, y, red); if (e) return e;
  if ((r as number) < 0 || (y as number) < 0 || (red as number) <= 0) return ERR.num;
  return bondPrice(b, r as number, y as number, red as number);
} });
def("YIELD", { min: 6, max: 7, args: "settlement, maturity, rate, price, redemption, frequency, [basis]", desc: "Yield of a bond.", cat: "Finance", fn: (a) => {
  const b = bondArgs(a, 0, 1, 5, 6); if (isErr(b)) return b;
  const r = N(a[2]), pr = N(a[3]), red = N(a[4]); const e = num(r, pr, red); if (e) return e;
  if ((r as number) < 0 || (pr as number) <= 0 || (red as number) <= 0) return ERR.num;
  const n = coupons(b).num;
  if (n === 1) {
    const E = coupDays(b), A = coupDayBs(b), DSR = E - A, f = b.freq, R = r as number;
    return (((red as number) / 100 + R / f) - ((pr as number) / 100 + (A / E) * (R / f))) / ((pr as number) / 100 + (A / E) * (R / f)) * (f * E) / DSR;
  }
  return solve((y) => bondPrice(b, r as number, y, red as number) - (pr as number), 0.05);
} });
def("DURATION", { min: 5, max: 6, args: "settlement, maturity, coupon, yield, frequency, [basis]", desc: "Macaulay duration of a bond, in years.", cat: "Finance", fn: (a) => {
  const b = bondArgs(a, 0, 1, 4, 5); if (isErr(b)) return b;
  const c = N(a[2]), y = N(a[3]); const e = num(c, y); if (e) return e;
  return duration(b, c as number, y as number);
} });
def("MDURATION", { min: 5, max: 6, args: "settlement, maturity, coupon, yield, frequency, [basis]", desc: "Modified duration of a bond.", cat: "Finance", fn: (a) => {
  const b = bondArgs(a, 0, 1, 4, 5); if (isErr(b)) return b;
  const c = N(a[2]), y = N(a[3]); const e = num(c, y); if (e) return e;
  return duration(b, c as number, y as number) / (1 + (y as number) / b.freq);
} });
const sec = (a: Any[], si: number, mi: number, bi: number) => {
  const s = N(a[si]), m = N(a[mi]), bs = optN(a[bi], 0); const e = num(s, m, bs); if (e) return e;
  if (Math.floor(s as number) >= Math.floor(m as number) || (bs as number) < 0 || (bs as number) > 4) return ERR.num;
  return { s: Math.floor(s as number), m: Math.floor(m as number), basis: Math.floor(bs as number) };
};
def("ACCRINT", { min: 6, max: 8, args: "issue, first_interest, settlement, rate, par, frequency, [basis], [calc_method]", desc: "Accrued interest for a security that pays periodically.", cat: "Finance", fn: (a) => {
  const iss = N(a[0]), set = N(a[2]), r = N(a[3]), par = N(a[4]), f = N(a[5]), b = optN(a[6], 0);
  const e = num(iss, set, r, par, f, b); if (e) return e;
  if ((r as number) <= 0 || (par as number) <= 0 || ![1, 2, 4].includes(f as number) || (iss as number) >= (set as number)) return ERR.num;
  return (par as number) * (r as number) * yearFrac(Math.floor(iss as number), Math.floor(set as number), Math.floor(b as number));
} });
def("ACCRINTM", { min: 3, max: 5, args: "issue, settlement, rate, [par], [basis]", desc: "Accrued interest for a security that pays at maturity.", cat: "Finance", fn: (a) => {
  const t = sec(a, 0, 1, 4); if (isErr(t)) return t;
  const r = N(a[2]), par = optN(a[3], 1000); const e = num(r, par); if (e) return e;
  return (par as number) * (r as number) * yearFrac(t.s, t.m, t.basis);
} });
def("INTRATE", { min: 4, max: 5, args: "settlement, maturity, investment, redemption, [basis]", desc: "Interest rate of a fully invested security.", cat: "Finance", fn: (a) => {
  const t = sec(a, 0, 1, 4); if (isErr(t)) return t;
  const inv = N(a[2]), red = N(a[3]); const e = num(inv, red); if (e) return e;
  return ((red as number) - (inv as number)) / (inv as number) / yearFrac(t.s, t.m, t.basis);
} });
def("RECEIVED", { min: 4, max: 5, args: "settlement, maturity, investment, discount, [basis]", desc: "Amount received at maturity for a fully invested security.", cat: "Finance", fn: (a) => {
  const t = sec(a, 0, 1, 4); if (isErr(t)) return t;
  const inv = N(a[2]), d = N(a[3]); const e = num(inv, d); if (e) return e;
  return (inv as number) / (1 - (d as number) * yearFrac(t.s, t.m, t.basis));
} });
def("YIELDDISC", { min: 4, max: 5, args: "settlement, maturity, price, redemption, [basis]", desc: "Annual yield of a discounted security.", cat: "Finance", fn: (a) => {
  const t = sec(a, 0, 1, 4); if (isErr(t)) return t;
  const pr = N(a[2]), red = N(a[3]); const e = num(pr, red); if (e) return e;
  return ((red as number) - (pr as number)) / (pr as number) / yearFrac(t.s, t.m, t.basis);
} });
const yearDays = (basis: number, y: number) => basis === 1 ? (isLeap(y) ? 366 : 365) : basis === 3 ? 365 : 360;
def("PRICEMAT", { min: 5, max: 6, args: "settlement, maturity, issue, rate, yield, [basis]", desc: "Price per 100 of a security that pays interest at maturity.", cat: "Finance", fn: (a) => {
  const t = sec(a, 0, 1, 5); if (isErr(t)) return t;
  const iss = N(a[2]), r = N(a[3]), y = N(a[4]); const e = num(iss, r, y); if (e) return e;
  const B = yearDays(t.basis, ymd(t.s)[0]);
  const DSM = dayCount(t.s, t.m, t.basis), DIM = dayCount(iss as number, t.m, t.basis), A = dayCount(iss as number, t.s, t.basis);
  return (100 + (DIM / B) * (r as number) * 100) / (1 + (DSM / B) * (y as number)) - (A / B) * (r as number) * 100;
} });
def("YIELDMAT", { min: 5, max: 6, args: "settlement, maturity, issue, rate, price, [basis]", desc: "Annual yield of a security that pays interest at maturity.", cat: "Finance", fn: (a) => {
  const t = sec(a, 0, 1, 5); if (isErr(t)) return t;
  const iss = N(a[2]), r = N(a[3]), pr = N(a[4]); const e = num(iss, r, pr); if (e) return e;
  const B = yearDays(t.basis, ymd(t.s)[0]);
  const DSM = dayCount(t.s, t.m, t.basis), DIM = dayCount(iss as number, t.m, t.basis), A = dayCount(iss as number, t.s, t.basis);
  const R = r as number, P = (pr as number) / 100;
  return ((1 + (DIM / B) * R) - (P + (A / B) * R)) / (P + (A / B) * R) * (B / DSM);
} });
def("VDB", { min: 5, max: 7, args: "cost, salvage, life, start_period, end_period, [factor], [no_switch]", desc: "Declining-balance depreciation over any span of periods.", cat: "Finance", fn: (a) => {
  const cost = N(a[0]), salv = N(a[1]), life = N(a[2]), st = N(a[3]), en = N(a[4]), fac = optN(a[5], 2), ns = optB(a[6], false);
  const e = num(cost, salv, life, st, en, fac, ns); if (e) return e;
  const C = cost as number, S0 = salv as number, L = life as number, F = fac as number;
  if (C < S0 || L <= 0 || (st as number) < 0 || (en as number) < (st as number) || (en as number) > L) return ERR.num;
  // Depreciation per period, switching to straight-line once that's larger.
  let book = C;
  const per: number[] = [];
  let switched = false;
  for (let p = 0; p < Math.ceil(L); p++) {
    const ddb = Math.min(book * F / L, Math.max(0, book - S0));
    const sl = (book - S0) / (L - p);
    let d = ddb;
    if (!ns && (switched || sl > ddb)) { switched = true; d = sl; }
    d = Math.max(0, Math.min(d, book - S0));
    per.push(d);
    book -= d;
  }
  let total = 0;
  const s0 = st as number, e0 = en as number;
  for (let p = 0; p < per.length; p++) {
    const lo = Math.max(p, s0), hi = Math.min(p + 1, e0);
    if (hi > lo) total += per[p] * (hi - lo);
  }
  return total;
} });

/* ------------------------------- text & web ------------------------------- */

const flags = (caseArg: Any | undefined, extra = "") => { const c = optN(caseArg, 0); return isErr(c) ? c : (c === 1 ? "i" : "") + extra; };
const regex = (p: string, f: string): RegExp | FErr => { try { return new RegExp(p, f + "u"); } catch { return ERR.value; } };
def("REGEXTEST", { min: 2, max: 3, args: "text, pattern, [case_sensitivity]", desc: "TRUE if the text matches a regular expression.", cat: "Text", lift: [0], fn: (a) => {
  const t = S(a[0]), p = S(a[1]); const e = num(t, p); if (e) return e;
  const f = flags(a[2]); if (isErr(f)) return f;
  const re = regex(p as string, f); return isErr(re) ? re : re.test(t as string);
} });
def("REGEXEXTRACT", { min: 2, max: 4, args: "text, pattern, [return_mode], [case_sensitivity]", desc: "The part of the text that matches (0 first, 1 all, 2 groups).", cat: "Text", lift: [0], spills: true, fn: (a) => {
  const t = S(a[0]), p = S(a[1]), mode = optN(a[2], 0); const e = num(t, p, mode); if (e) return e;
  const f = flags(a[3]); if (isErr(f)) return f;
  const re = regex(p as string, f + (mode === 1 ? "g" : "")); if (isErr(re)) return re;
  if (mode === 1) { const all = [...(t as string).matchAll(re)].map((m) => m[0]); return all.length ? arr([all]) : ERR.na; }
  const m = re.exec(t as string);
  if (!m) return ERR.na;
  if (mode === 2) return m.length > 1 ? arr([m.slice(1).map((x) => x ?? "")]) : m[0];
  return m[0];
} });
def("REGEXREPLACE", { min: 3, max: 5, args: "text, pattern, replacement, [occurrence], [case_sensitivity]", desc: "Replaces what matches a regular expression ($1 for groups).", cat: "Text", lift: [0], fn: (a) => {
  const t = S(a[0]), p = S(a[1]), r = S(a[2]), occ = optN(a[3], 0); const e = num(t, p, r, occ); if (e) return e;
  const f = flags(a[4]); if (isErr(f)) return f;
  const re = regex(p as string, f + "g"); if (isErr(re)) return re;
  if (!occ) return (t as string).replace(re, r as string);
  const all = [...(t as string).matchAll(re)];
  const k = (occ as number) > 0 ? (occ as number) - 1 : all.length + (occ as number);
  const m = all[k];
  if (!m) return t;
  const one = m[0].replace(new RegExp(re.source, f + "u"), r as string);
  return (t as string).slice(0, m.index) + one + (t as string).slice(m.index! + m[0].length);
} });
// Google Sheets spellings.
def("REGEXMATCH", { min: 2, max: 2, args: "text, regular_expression", desc: "TRUE if the text matches (Google Sheets).", cat: "Text", lift: [0], fn: (a, x) => FUNCS.REGEXTEST.fn!(a, x) });
def("JOIN", { min: 2, max: 255, args: "delimiter, value1, [value2, …]", desc: "Joins values with a separator (Google Sheets).", cat: "Text", fn: (a) => { const d = S(a[0]); if (isErr(d)) return d; const parts: string[] = []; for (const x of a.slice(1)) for (const v of each(x)) { if (isErr(v)) return v; parts.push(toStr(v)); } return parts.join(d); } });
def("ARRAYFORMULA", { min: 1, max: 1, args: "array_formula", desc: "Shows a formula's array result (Google Sheets; arrays spill anyway).", cat: "Array", spills: true, fn: (a) => a[0] });
def("COUNTUNIQUE", { min: 1, max: 255, args: "value1, [value2, …]", desc: "How many different values there are (Google Sheets).", cat: "Statistics", fn: (a) => { const s = new Set<string>(); for (const x of a) for (const v of each(x)) if (v !== "") s.add(typeof v === "string" ? "s" + v.toLowerCase() : String(v)); return s.size; } });
def("HYPERLINK", { min: 1, max: 2, args: "url, [link_label]", desc: "A link (shows its label).", cat: "Text", lift: true, fn: (a) => { const u = S(a[0]); if (isErr(u)) return u; return given(a[1]) ? scalar(a[1]) : u; } });
def("ENCODEURL", { min: 1, max: 1, args: "text", desc: "Text made safe for a web address.", cat: "Text", lift: true, fn: (a) => { const t = S(a[0]); return isErr(t) ? t : encodeURIComponent(t); } });
def("VALUETOTEXT", { min: 1, max: 2, args: "value, [format]", desc: "A value as text (1 = with quotes, like in a formula).", cat: "Text", lift: [0], fn: (a) => { const v = scalar(a[0]); const f = optN(a[1], 0); if (isErr(f)) return f; return f === 1 && typeof v === "string" ? `"${v}"` : toStr(v); } });
def("ARRAYTOTEXT", { min: 1, max: 2, args: "array, [format]", desc: "An array as text, e.g. {1,2;3,4}.", cat: "Text", fn: (a) => {
  const f = optN(a[1], 0); if (isErr(f)) return f;
  const m = toArr(a[0]);
  const q = (v: Val) => f === 1 && typeof v === "string" ? `"${v}"` : toStr(v);
  return f === 1 ? `{${m.map((r) => r.map(q).join(",")).join(";")}}` : m.flat().map(q).join(", ");
} });
for (const [b, base] of [["LEFTB", "LEFT"], ["RIGHTB", "RIGHT"], ["MIDB", "MID"], ["LENB", "LEN"], ["FINDB", "FIND"], ["SEARCHB", "SEARCH"], ["REPLACEB", "REPLACE"]] as const) alias(b, base);
for (const name of ["ASC", "DBCS", "JIS", "PHONETIC"]) def(name, { min: 1, max: 1, args: "text", desc: "Text unchanged (for East Asian character widths in Excel).", cat: "Text", lift: true, fn: (a) => S(a[0]) });

/* ------------------------------- arrays ------------------------------- */

def("EXPAND", { min: 2, max: 4, args: "array, rows, [columns], [pad_with]", desc: "Pads an array out to a size.", cat: "Array", spills: true, fn: (a) => {
  const m = toArr(a[0]); const h = m.length, w = m[0]?.length ?? 0;
  const r = given(a[1]) ? N(a[1]) : h, c = optN(a[2], w); const e = num(r, c); if (e) return e;
  if ((r as number) < h || (c as number) < w) return ERR.value;
  const pad: Val = given(a[3]) ? scalar(a[3]) : ERR.na;
  return arr(Array.from({ length: r as number }, (_, i) => Array.from({ length: c as number }, (_, j) => m[i]?.[j] ?? pad)));
} });
const wrap = (byRow: boolean) => (a: Any[]) => {
  const v = flat1(a[0]); const k = N(a[1]); if (isErr(k)) return k;
  const n = Math.floor(k); if (n < 1) return ERR.num;
  const pad: Val = given(a[2]) ? scalar(a[2]) : ERR.na;
  const groups: Val[][] = [];
  for (let i = 0; i < v.length; i += n) { const g = v.slice(i, i + n); while (g.length < n) g.push(pad); groups.push(g); }
  return arr(byRow ? groups : transpose(groups));
};
def("WRAPROWS", { min: 2, max: 3, args: "vector, wrap_count, [pad_with]", desc: "Wraps a list into rows of a given length.", cat: "Array", spills: true, fn: wrap(true) });
def("WRAPCOLS", { min: 2, max: 3, args: "vector, wrap_count, [pad_with]", desc: "Wraps a list into columns of a given length.", cat: "Array", spills: true, fn: wrap(false) });
def("PERCENTOF", { min: 2, max: 2, args: "data_subset, data_all", desc: "What fraction the subset's total is of the whole.", cat: "Math", fn: (a) => { const x = numbers([a[0]]), y = numbers([a[1]]); if (isErr(x)) return x; if (isErr(y)) return y; const t = y.reduce((s, v) => s + v, 0); return t === 0 ? ERR.div0 : x.reduce((s, v) => s + v, 0) / t; } });
def("TRIMRANGE", { min: 1, max: 3, args: "range, [trim_rows], [trim_cols]", desc: "A range without its empty outer rows and columns.", cat: "Array", spills: true, fn: (a) => {
  const m = toArr(a[0]);
  let r0 = 0, r1 = m.length - 1, c0 = 0, c1 = (m[0]?.length ?? 1) - 1;
  const rowEmpty = (i: number) => m[i].every((v) => v === "");
  const colEmpty = (j: number) => m.every((r) => r[j] === "");
  while (r1 >= r0 && rowEmpty(r1)) r1--;
  while (r0 <= r1 && rowEmpty(r0)) r0++;
  while (c1 >= c0 && colEmpty(c1)) c1--;
  while (c0 <= c1 && colEmpty(c0)) c0++;
  if (r1 < r0 || c1 < c0) return ERR.ref;
  return arr(m.slice(r0, r1 + 1).map((r) => r.slice(c0, c1 + 1)));
} });
def("ARRAY_CONSTRAIN", { min: 3, max: 3, args: "range, rows, columns", desc: "The top-left part of an array (Google Sheets).", cat: "Array", spills: true, fn: (a) => { const r = N(a[1]), c = N(a[2]); const e = num(r, c); if (e) return e; return arr(toArr(a[0]).slice(0, r as number).map((row) => row.slice(0, c as number))); } });

/* --------------------------- GROUPBY / PIVOTBY --------------------------- */

/** An aggregation given to GROUPBY: a LAMBDA, or a function name like SUM. */
function aggregator(n: Node, x: Ctx): ((vals: Val[]) => Val) | FErr {
  if (n.k === "name" && FUNCS[n.v] && FUNCS[n.v].fn) {
    const f = FUNCS[n.v];
    return (vals) => { const r = f.fn!([col(vals)], x); return isMulti(r) ? scalar(r) : r as Val; };
  }
  const l = x.ev(n);
  if (!isLam(l)) return ERR.value;
  return (vals) => { const r = x.call(l as LamV, [col(vals)]); return isMulti(r) ? scalar(r) : isLam(r) || isOmit(r) ? ERR.calc : r; };
}
const keyOf = (r: Val[]) => r.map((v) => typeof v === "string" ? "s" + v.toLowerCase() : typeof v + String(v)).join("\u0001");

def("GROUPBY", { min: 3, max: 8, args: "row_fields, values, function, [field_headers], [total_depth], [sort_order], [filter_array]", desc: "Groups rows by a field and totals the values, e.g. GROUPBY(A2:A99, C2:C99, SUM).", cat: "Array", spills: true, lazy: (n, x) => {
  const keys = toArr(x.ev(n[0])), vals = toArr(x.ev(n[1]));
  if (keys.length !== vals.length) return ERR.value;
  const agg = aggregator(n[2], x); if (isErr(agg)) return agg;
  const opt = (i: number, d: number) => { if (!n[i] || n[i].k === "omit") return d; const v = toNum(scalar(x.ev(n[i]))); return isErr(v) ? d : v; };
  const headers = opt(3, 0), totals = opt(4, 1), order = opt(5, 1);
  const filter = n[6] && n[6].k !== "omit" ? flat1(x.ev(n[6])) : null;
  let start = 0;
  let head: Val[] | null = null;
  if (headers === 1 || headers === 3) { start = 1; if (headers === 3) head = [...keys[0], ...vals[0]]; }
  const groups = new Map<string, { key: Val[]; rows: Val[][] }>();
  for (let i = start; i < keys.length; i++) {
    if (filter && filter[i] !== true && !(typeof filter[i] === "number" && filter[i] !== 0)) continue;
    if (keys[i].every((v) => v === "")) continue;
    const k = keyOf(keys[i]);
    if (!groups.has(k)) groups.set(k, { key: keys[i], rows: [] });
    groups.get(k)!.rows.push(vals[i]);
  }
  const vw = vals[0]?.length ?? 1;
  const total = (rows: Val[][]) => Array.from({ length: vw }, (_, j) => agg(rows.map((r) => r[j])));
  let out = [...groups.values()].map((g) => [...g.key, ...total(g.rows)]);
  const kw = keys[0]?.length ?? 1;
  const j = Math.abs(order) - 1;
  if (j >= 0) out.sort((p, q) => (order < 0 ? -1 : 1) * cmp(p[j] ?? "", q[j] ?? ""));
  if (totals) out = [...out, ["Total", ...Array(kw - 1).fill(""), ...total([...groups.values()].flatMap((g) => g.rows))]];
  if (head) out = [head, ...out];
  return out.length ? arr(out) : ERR.calc;
} });
def("PIVOTBY", { min: 4, max: 11, args: "row_fields, col_fields, values, function, [field_headers], [row_total_depth], [row_sort_order], [col_total_depth]", desc: "A pivot table: rows by one field, columns by another, values totalled.", cat: "Array", spills: true, lazy: (n, x) => {
  const rk = flat1(x.ev(n[0])), ck = flat1(x.ev(n[1])), vals = flat1(x.ev(n[2]));
  if (rk.length !== ck.length || rk.length !== vals.length) return ERR.value;
  const agg = aggregator(n[3], x); if (isErr(agg)) return agg;
  const rows = [...new Map(rk.filter((v) => v !== "").map((v) => [keyOf([v]), v])).values()].sort(cmp);
  const cols = [...new Map(ck.filter((v) => v !== "").map((v) => [keyOf([v]), v])).values()].sort(cmp);
  const cell = (rv: Val | null, cv: Val | null) => {
    const pick = vals.filter((_, i) => (rv === null || keyOf([rk[i]]) === keyOf([rv])) && (cv === null || keyOf([ck[i]]) === keyOf([cv])) && rk[i] !== "" && ck[i] !== "");
    return pick.length ? agg(pick) : "";
  };
  const out: Val[][] = [["", ...cols, "Total"]];
  for (const r of rows) out.push([r, ...cols.map((c) => cell(r, c)), cell(r, null)]);
  out.push(["Total", ...cols.map((c) => cell(null, c)), cell(null, null)]);
  return arr(out);
} });

/* ------------------------------ information ------------------------------ */

def("SHEET", { min: 0, max: 1, args: "[value]", desc: "The number of the sheet (1 = first).", cat: "Info", fn: (a, x) => { const r = a[0] && isRef(a[0]) ? a[0] : null; const name = r ? r.eng.sheetName() : x.sheetName(); return x.sheetIndex(name) + 1 || ERR.na; } });
def("SHEETS", { min: 0, max: 1, args: "[reference]", desc: "How many sheets there are.", cat: "Info", fn: (_a, x) => x.sheetCount() });
def("ISFORMULA", { min: 1, max: 1, args: "reference", desc: "TRUE if the cell holds a formula.", cat: "Info", fn: (a) => isRef(a[0]) ? a[0].eng.rawAt(a[0].r1, a[0].c1).startsWith("=") : ERR.value });
def("FORMULATEXT", { min: 1, max: 1, args: "reference", desc: "The formula in a cell, as text.", cat: "Info", fn: (a) => { if (!isRef(a[0])) return ERR.value; const r = a[0].eng.rawAt(a[0].r1, a[0].c1); return r.startsWith("=") ? r : ERR.na; } });
def("AREAS", { min: 1, max: 1, args: "reference", desc: "How many areas a reference has.", cat: "Info", fn: () => 1 });
def("CELL", { min: 1, max: 2, args: "info_type, [reference]", desc: "Information about a cell: \"address\", \"row\", \"col\", \"contents\", \"type\".", cat: "Info", fn: (a, x) => {
  const t = S(a[0]); if (isErr(t)) return t;
  const ref = a[1] && isRef(a[1]) ? a[1] : null;
  const r = ref ? ref.r1 : x.r, c = ref ? ref.c1 : x.c;
  const v = ref ? ref.eng.value(r, c) : "";
  const colName_ = (i: number) => { let s = ""; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  switch (t.toLowerCase()) {
    case "address": return `$${colName_(c)}$${r + 1}`;
    case "row": return r + 1;
    case "col": return c + 1;
    case "contents": return v;
    case "type": return v === "" ? "b" : typeof v === "string" ? "l" : "v";
    case "filename": return "";
  }
  return ERR.value;
} });
def("INFO", { min: 1, max: 1, args: "type_text", desc: "About the app: \"release\", \"system\", \"numfile\".", cat: "Info", fn: (a, x) => { const t = S(a[0]); if (isErr(t)) return t; switch (t.toLowerCase()) { case "release": return "Bento"; case "system": return "pcdos"; case "numfile": return x.sheetCount(); case "recalc": return "Automatic"; } return ERR.na; } });

/* -------------------------------- finish -------------------------------- */

void dateOf; void isArr;
export { FUNCS };
export const FUNCTION_NAMES = Object.keys(FUNCS).sort();
