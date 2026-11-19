/* ------------------------------------------------------------------ *
 * Cell formatting: the style model, number/date formats and colours.
 * Formatting is display-only — it never changes a cell's raw value.
 * ------------------------------------------------------------------ */
import { parseNum } from "./util";

export type HAlign = "l" | "c" | "r";
export type VAlign = "t" | "m" | "b";
export type Wrap = "overflow" | "wrap" | "clip";
export type DateFmt = "iso" | "dmy" | "mdy" | "long";

export interface NumFmt {
  k: "num" | "pct" | "cur" | "date";
  dp?: number;     // decimal places (undefined = as typed)
  sep?: boolean;   // thousands separators
  cur?: string;    // currency symbol
  date?: DateFmt;
}

export interface Style {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  color?: string;  // "@red" palette token or "#rrggbb"
  fill?: string;   // "@red-1" / "@red-2" palette token or "#rrggbb"
  ha?: HAlign;
  va?: VAlign;
  wrap?: Wrap;
  size?: number;   // points (default 10)
  nf?: NumFmt;
}

export const DEFAULT_SIZE = 10;
export const FONT_SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36];
/** Points → CSS pixels at 100% zoom (10pt ≈ 13px, matching the grid). */
export const ptToPx = (pt: number) => pt * 1.3;

/** A stable key so identical styles share one id. */
export function styleKey(s: Style): string {
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(s).sort()) {
    const v = (s as Record<string, unknown>)[k];
    if (v === undefined) continue;
    o[k] = k === "nf" && v ? Object.fromEntries(Object.entries(v as object).filter(([, x]) => x !== undefined).sort()) : v;
  }
  return JSON.stringify(o);
}

export function isEmptyStyle(s: Style): boolean {
  return styleKey(s) === "{}";
}

/* ---------------------------- number formats ---------------------------- */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Read a date from common spellings: 2026-01-04, 04/01/2026, 4 Jan 2026, or a spreadsheet serial. */
export function parseDate(text: string): Date | null {
  const t = text.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
  if (m) return mk(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(t);
  if (m) return +m[2] > 12 ? mk(+m[3], +m[1], +m[2]) : mk(+m[3], +m[2], +m[1]); // UK-style unless impossible
  m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(t);
  if (m) { const mo = MONTHS.findIndex((x) => x.toLowerCase() === m![2].toLowerCase()); if (mo >= 0) return mk(+m[3], mo + 1, +m[1]); }
  const n = parseNum(t);
  if (!Number.isNaN(n) && n > 1000 && n < 100000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
    return d;
  }
  return null;
}

function mk(y: number, mo: number, d: number): Date | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCMonth() === mo - 1 ? dt : null;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export function formatDate(d: Date, f: DateFmt): string {
  const y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1, day = d.getUTCDate();
  switch (f) {
    case "iso": return `${y}-${pad2(mo)}-${pad2(day)}`;
    case "dmy": return `${pad2(day)}/${pad2(mo)}/${y}`;
    case "mdy": return `${pad2(mo)}/${pad2(day)}/${y}`;
    case "long": return `${day} ${MONTHS[mo - 1]} ${y}`;
  }
}

function fixed(n: number, dp: number | undefined, sep: boolean): string {
  const opts: Intl.NumberFormatOptions = { useGrouping: sep };
  if (dp !== undefined) { opts.minimumFractionDigits = dp; opts.maximumFractionDigits = dp; }
  else opts.maximumFractionDigits = 10;
  return new Intl.NumberFormat("en-GB", opts).format(n);
}

/** Apply a number format to a cell's displayed text. Non-numbers pass through. */
export function applyNumFmt(text: string, nf: NumFmt | undefined): string {
  if (!nf || text === "") return text;
  if (nf.k === "date") {
    const d = parseDate(text);
    return d ? formatDate(d, nf.date ?? "iso") : text;
  }
  const n = parseNum(text);
  if (Number.isNaN(n)) return text;
  switch (nf.k) {
    case "num": return fixed(n, nf.dp, nf.sep ?? false);
    case "pct": return fixed(n * 100, nf.dp ?? 2, nf.sep ?? false) + "%";
    case "cur": {
      const body = fixed(Math.abs(n), nf.dp ?? 2, nf.sep ?? true);
      return (n < 0 ? "-" : "") + (nf.cur ?? "£") + body;
    }
  }
}

/** How many decimals a value is currently showing (for the .0 / .00 buttons). */
export function shownDecimals(text: string): number {
  const m = /\.(\d+)/.exec(text.replace(/[^\d.]/g, ""));
  return m ? m[1].length : 0;
}

/* ------------------------------- colours ------------------------------- */

export const HUES = ["gray", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"] as const;
export type Hue = (typeof HUES)[number];

type Pair = { light: string; dark: string };
const TEXT: Record<Hue, Pair> = {
  gray: { light: "#6b6a65", dark: "#aaa89f" },
  red: { light: "#c4453a", dark: "#f0806f" },
  orange: { light: "#c2602b", dark: "#f0a070" },
  yellow: { light: "#9c7410", dark: "#e3c06a" },
  green: { light: "#3c7d3e", dark: "#8cc98a" },
  teal: { light: "#2a7a78", dark: "#72c7c0" },
  blue: { light: "#2f6db3", dark: "#82b1ec" },
  purple: { light: "#7a4fb0", dark: "#b99ae6" },
  pink: { light: "#b4467f", dark: "#ea8fbf" },
};
const FILL_SOFT: Record<Hue, Pair> = {
  gray: { light: "#ecebe5", dark: "#353431" },
  red: { light: "#f9e1dc", dark: "#4a2d28" },
  orange: { light: "#fbe6d7", dark: "#4b3425" },
  yellow: { light: "#f8efcf", dark: "#463c21" },
  green: { light: "#e1efdc", dark: "#2e3f2c" },
  teal: { light: "#dcefed", dark: "#253e3c" },
  blue: { light: "#e0e9f6", dark: "#2a374b" },
  purple: { light: "#ebe3f5", dark: "#392f4b" },
  pink: { light: "#f6e0ea", dark: "#462a3b" },
};
const FILL_STRONG: Record<Hue, Pair> = {
  gray: { light: "#d7d5cd", dark: "#4a4943" },
  red: { light: "#f1bfb5", dark: "#6e382f" },
  orange: { light: "#f5c9a8", dark: "#6f4728" },
  yellow: { light: "#f0dc96", dark: "#665420" },
  green: { light: "#bfdeb7", dark: "#3c5c38" },
  teal: { light: "#b5dedb", dark: "#305955" },
  blue: { light: "#bcd0ee", dark: "#354f70" },
  purple: { light: "#d3c3ec", dark: "#51406f" },
  pink: { light: "#ecbfd4", dark: "#663654" },
};

export type Theme = "light" | "dark";

/** Turn a stored colour into a real one for the current theme. */
export function resolveColor(c: string | undefined, theme: Theme): string | null {
  if (!c) return null;
  if (c[0] !== "@") return c;
  const [hue, tone] = c.slice(1).split("-") as [Hue, string | undefined];
  const table = tone === "2" ? FILL_STRONG : tone === "1" ? FILL_SOFT : TEXT;
  return table[hue]?.[theme] ?? null;
}

export const colorLabel = (hue: Hue) => hue[0].toUpperCase() + hue.slice(1);
