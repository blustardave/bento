/** Column index (0-based) → spreadsheet letters: 0 → A, 25 → Z, 26 → AA. */
export function colName(c: number): string {
  let s = "";
  c += 1;
  while (c > 0) {
    const m = (c - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    c = Math.floor((c - 1) / 26);
  }
  return s;
}

/** Letters → 0-based column index. "A" → 0, "AA" → 26. */
export function colIndex(letters: string): number {
  let n = 0;
  const up = letters.toUpperCase();
  for (let i = 0; i < up.length; i++) n = n * 26 + (up.charCodeAt(i) - 64);
  return n - 1;
}

export function cellName(r: number, c: number): string {
  return colName(c) + (r + 1);
}

const NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const LOOSE_RE = /^[-+]?[$£€¥]?\s?[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?%?$/;

/**
 * Parse a cell's text as a number the way a person would read it:
 * "12", "-3.5", "1e3", "1,234.50", "$12", "£1,000", "45%".
 * Returns NaN for anything that isn't clearly a number.
 */
export function parseNum(raw: string): number {
  if (raw.length === 0 || raw.length > 40) return NaN;
  let s = raw;
  const c0 = s.charCodeAt(0);
  const cl = s.charCodeAt(s.length - 1);
  if (c0 === 32 || cl === 32 || c0 === 9) s = s.trim();
  if (NUM_RE.test(s)) return Number(s);
  if (!LOOSE_RE.test(s) || !/\d/.test(s)) return NaN;
  const pct = s.endsWith("%");
  const neg = s.includes("-");
  const cleaned = s.replace(/[-+$£€¥,%\s]/g, "");
  let n = Number(cleaned);
  if (Number.isNaN(n)) return NaN;
  if (neg) n = -n;
  return pct ? n / 100 : n;
}

export function isNumeric(raw: string): boolean {
  return !Number.isNaN(parseNum(raw));
}

const fmt = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 6 });
export function formatStat(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1e15) return n.toExponential(4);
  return fmt.format(n);
}

export function formatInt(n: number): string {
  return n.toLocaleString("en-GB");
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const ch of children) if (ch) e.append(ch);
  return e;
}

export const nextFrame = () => new Promise<void>((r) => setTimeout(r, 0));
