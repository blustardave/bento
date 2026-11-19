/**
 * Fill-handle series logic, modelled on Google Sheets / Excel autofill.
 *
 * Given the source values along the fill direction, produce the values for
 * `count` new cells. `backward` fills up/left (the series runs in reverse).
 * `alt` is the Ctrl key: it flips between "continue the series" and "copy".
 */
import { DateFmt, formatDate, parseDate } from "./format";
import { parseNum } from "./util";

type Kind =
  | { t: "num"; n: number; dp: number }
  | { t: "date"; day: number; fmt: DateFmt }
  | { t: "textnum"; pre: string; n: number; post: string; width: number }
  | { t: "list"; list: number; i: number; caseStyle: "upper" | "lower" | "title" }
  | { t: "other" };

const LISTS = [
  ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
  ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
  ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
  ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"],
];

const DAY = 86400000;

/** Which way a typed date was written, so the series keeps the same look. */
function dateFormatOf(text: string): DateFmt | null {
  const t = text.trim();
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(t)) return "iso";
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(t)) return "dmy";
  if (/^\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}$/.test(t)) return "long";
  return null;
}

function classify(v: string): Kind {
  if (v === "") return { t: "other" };
  const fmt = dateFormatOf(v);
  if (fmt) {
    const d = parseDate(v);
    if (d) return { t: "date", day: Math.round(d.getTime() / DAY), fmt };
  }
  if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(v.trim())) {
    const n = Number(v);
    const dp = (v.split(".")[1] ?? "").length;
    return { t: "num", n, dp };
  }
  const low = v.toLowerCase();
  for (let li = 0; li < LISTS.length; li++) {
    const i = LISTS[li].indexOf(low);
    if (i >= 0) {
      const caseStyle = v === v.toUpperCase() ? "upper" : v === v.toLowerCase() ? "lower" : "title";
      return { t: "list", list: li, i, caseStyle };
    }
  }
  const m = /^(.*?)(\d+)(\D*)$/.exec(v);
  if (m && m[1] + m[3] !== "") return { t: "textnum", pre: m[1], n: Number(m[2]), post: m[3], width: m[2].length };
  return { t: "other" };
}

/** Least-squares line through (0, y0), (1, y1)…; returns [intercept, slope]. */
function fit(ys: number[]): [number, number] {
  const n = ys.length;
  if (n === 1) return [ys[0], 1];
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  ys.forEach((y, i) => { num += (i - mx) * (y - my); den += (i - mx) ** 2; });
  const slope = den ? num / den : 0;
  return [my - slope * mx, slope];
}

const round = (n: number, dp: number) => Number(n.toFixed(Math.min(12, dp)));

function applyCase(s: string, c: "upper" | "lower" | "title"): string {
  return c === "upper" ? s.toUpperCase() : c === "lower" ? s : s[0].toUpperCase() + s.slice(1);
}

/**
 * Positions to generate, as indexes along the series: forward fills are
 * n, n+1, …; backward fills are -1, -2, … (nearest first).
 */
export function fillValues(src: string[], count: number, backward: boolean, alt = false): string[] {
  const n = src.length;
  const idx = (k: number) => (backward ? -(k + 1) : n + k);
  const copy = () => Array.from({ length: count }, (_, k) => src[((idx(k) % n) + n) % n]);
  if (!n || !count) return [];
  const kinds = src.map(classify);
  const same = (t: Kind["t"]) => kinds.every((k) => k.t === t);
  // One cell: numbers copy (Ctrl counts); everything series-like counts (Ctrl copies).
  const series = n === 1 ? (same("num") ? alt : !alt) : !alt;
  if (!series) return copy();

  if (same("num")) {
    const ks = kinds as Extract<Kind, { t: "num" }>[];
    const [a, b] = fit(ks.map((k) => k.n));
    const dp = Math.max(...ks.map((k) => k.dp));
    return Array.from({ length: count }, (_, k) => String(round(a + b * idx(k), dp + (n > 2 ? 4 : 0))));
  }
  if (same("date")) {
    const ks = kinds as Extract<Kind, { t: "date" }>[];
    const [a, b] = fit(ks.map((k) => k.day));
    return Array.from({ length: count }, (_, k) => formatDate(new Date(Math.round(a + b * idx(k)) * DAY), ks[0].fmt));
  }
  if (same("textnum")) {
    const ks = kinds as Extract<Kind, { t: "textnum" }>[];
    if (ks.every((k) => k.pre === ks[0].pre && k.post === ks[0].post)) {
      const [a, b] = fit(ks.map((k) => k.n));
      const width = ks[ks.length - 1].width;
      return Array.from({ length: count }, (_, k) => {
        const v = Math.round(a + b * idx(k));
        const digits = String(Math.abs(v)).padStart(width, "0");
        return ks[0].pre + (v < 0 ? "-" : "") + digits + ks[0].post;
      });
    }
    return copy();
  }
  if (same("list")) {
    const ks = kinds as Extract<Kind, { t: "list" }>[];
    const list = LISTS[ks[0].list];
    if (ks.every((k) => k.list === ks[0].list)) {
      const len = list.length;
      // Step must be constant (mod the list length), e.g. Mon, Wed → +2.
      const steps = ks.slice(1).map((k, i) => (((k.i - ks[i].i) % len) + len) % len);
      const step = n === 1 ? 1 : steps[0];
      if (steps.every((s) => s === step)) {
        return Array.from({ length: count }, (_, k) => {
          const i = (((ks[0].i + step * idx(k)) % len) + len) % len;
          return applyCase(list[i], ks[0].caseStyle);
        });
      }
    }
    return copy();
  }
  return copy();
}

/** True if a value is something the fill handle can continue as a series. */
export function isSeriesLike(v: string): boolean {
  return classify(v).t !== "other" || !Number.isNaN(parseNum(v));
}
