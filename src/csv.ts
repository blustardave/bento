export type Delimiter = "," | ";" | "\t" | "|";
export type LineEnding = "\r\n" | "\n";

export function delimiterLabel(d: Delimiter): string {
  return d === "," ? "Comma" : d === ";" ? "Semicolon" : d === "\t" ? "Tab" : "Pipe";
}

/** Guess the delimiter from the first few lines (ignoring anything inside quotes). */
export function sniffDelimiter(text: string, filename = ""): Delimiter {
  if (/\.tsv$|\.tab$/i.test(filename)) return "\t";
  const sample = text.slice(0, 64 * 1024);
  const candidates: Delimiter[] = [",", ";", "\t", "|"];
  const perLine: Record<string, number[]> = { ",": [], ";": [], "\t": [], "|": [] };
  let inQ = false;
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0, "|": 0 };
  let lines = 0;
  for (let i = 0; i < sample.length && lines < 30; i++) {
    const ch = sample[i];
    if (ch === '"') inQ = !inQ;
    else if (!inQ && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && sample[i + 1] === "\n") i++;
      for (const d of candidates) { perLine[d].push(counts[d]); counts[d] = 0; }
      lines++;
    } else if (!inQ && ch in counts) counts[ch]++;
  }
  if (lines < 30) for (const d of candidates) if (counts[d]) perLine[d].push(counts[d]);

  let best: Delimiter = ",";
  let bestScore = 0;
  for (const d of candidates) {
    const arr = perLine[d];
    if (!arr.length) continue;
    const freq = new Map<number, number>();
    for (const n of arr) if (n > 0) freq.set(n, (freq.get(n) ?? 0) + 1);
    let modeCount = 0;
    let mode = 0;
    for (const [n, f] of freq) if (f > modeCount || (f === modeCount && n > mode)) { modeCount = f; mode = n; }
    // Consistency matters most; more columns breaks ties.
    const score = modeCount * 100 + mode;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/**
 * Does the first row look like column headings? Used to freeze it when a
 * CSV opens, so sorting and filtering leave it alone (and it's visibly
 * different, so a wrong guess is easy to spot and unfreeze).
 *
 * Headings: every filled cell in row 1 is text (not a number or date), the
 * row isn't sparse, no heading repeats, and either some column changes
 * kind below it (text over numbers) or none of the headings recur below.
 */
export function looksLikeHeader(rows: string[][], isNumber: (s: string) => boolean): boolean {
  if (rows.length < 2) return false;
  const head = rows[0];
  const filled = head.filter((v) => v.trim() !== "");
  if (!filled.length || filled.length < head.length / 2) return false;
  if (filled.some((v) => isNumber(v) || /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/.test(v.trim()))) return false;
  if (new Set(filled.map((v) => v.trim().toLowerCase())).size !== filled.length) return false;
  const body = rows.slice(1, 51);
  // Strong sign: text on top of a column that's mostly numbers.
  for (let c = 0; c < head.length; c++) {
    if (!head[c]?.trim()) continue;
    const vals = body.map((r) => r[c] ?? "").filter((v) => v.trim() !== "");
    if (vals.length && vals.filter(isNumber).length >= vals.length * 0.8) return true;
  }
  // All text: a heading wouldn't normally appear again in its own column.
  if (rows.length < 3) return false;
  return head.every((h, c) => !h.trim() || !body.some((r) => (r[c] ?? "").trim().toLowerCase() === h.trim().toLowerCase()));
}

export function sniffLineEnding(text: string): LineEnding {
  const i = text.indexOf("\n");
  return i > 0 && text[i - 1] === "\r" ? "\r\n" : i >= 0 ? "\n" : "\r\n";
}

/**
 * RFC-4180-ish CSV parser that can run in time slices, so a huge file
 * doesn't freeze the window while it loads.
 */
export class CsvParser {
  rows: string[][] = [];
  private i = 0;
  private readonly n: number;
  private readonly d: number;

  constructor(private readonly text: string, delim: Delimiter) {
    this.n = text.length;
    this.d = delim.charCodeAt(0);
  }

  get progress(): number {
    return this.n ? this.i / this.n : 1;
  }

  get done(): boolean {
    return this.i >= this.n;
  }

  /** Parse until `budgetMs` has passed (or forever if Infinity). */
  step(budgetMs: number): boolean {
    const { text, n, d, rows } = this;
    const deadline = performance.now() + budgetMs;
    let i = this.i;
    let row: string[] = [];
    let check = 0;
    while (i < n) {
      let c = text.charCodeAt(i);
      let field: string;
      if (c === 34) {
        // Quoted field: "" inside means a literal quote.
        let start = i + 1;
        let j = start;
        field = "";
        for (;;) {
          const k = text.indexOf('"', j);
          if (k < 0) { field += text.slice(start); i = n; break; }
          if (text.charCodeAt(k + 1) === 34) { field += text.slice(start, k + 1); j = k + 2; start = j; continue; }
          field += text.slice(start, k);
          i = k + 1;
          break;
        }
        // Tolerate junk between the closing quote and the delimiter.
        const s = i;
        while (i < n) { c = text.charCodeAt(i); if (c === d || c === 10 || c === 13) break; i++; }
        if (i > s) field += text.slice(s, i);
      } else {
        const s = i;
        while (i < n) { c = text.charCodeAt(i); if (c === d || c === 10 || c === 13) break; i++; }
        field = text.slice(s, i);
      }
      row.push(field);
      if (i >= n) { rows.push(row); row = []; break; }
      c = text.charCodeAt(i);
      if (c === d) {
        i++;
        if (i >= n) { row.push(""); rows.push(row); row = []; }
        continue;
      }
      // Newline (CRLF, LF or lone CR).
      i += c === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
      rows.push(row);
      row = [];
      if (++check >= 2048) {
        check = 0;
        if (performance.now() > deadline) break;
      }
    }
    // `row` is always empty here: rows are only split at newline boundaries.
    this.i = i;
    return i >= n;
  }
}

export function parseSync(text: string, delim: Delimiter): string[][] {
  const p = new CsvParser(text, delim);
  p.step(Infinity);
  return p.rows;
}

function quoteField(v: string, delim: string): string {
  if (v.length === 0) return v;
  if (v.includes(delim) || v.includes('"') || v.includes("\n") || v.includes("\r")) {
    return '"' + v.replace(/"/g, '""') + '"';
  }
  return v;
}

/** Turn a grid of values back into CSV text. */
export function serialize(
  rowCount: number,
  colCount: number,
  get: (r: number, c: number) => string,
  delim: Delimiter,
  eol: LineEnding,
  trailingNewline: boolean,
): string {
  const parts: string[] = [];
  const line: string[] = new Array(colCount);
  for (let r = 0; r < rowCount; r++) {
    for (let c = 0; c < colCount; c++) line[c] = quoteField(get(r, c), delim);
    parts.push(line.join(delim));
  }
  let out = parts.join(eol);
  if (trailingNewline && rowCount > 0) out += eol;
  return out;
}

/** Tab-separated text for the clipboard (what Excel and Google Sheets expect). */
export function toTSV(block: string[][]): string {
  return block.map((row) => row.map((v) => quoteField(v, "\t")).join("\t")).join("\r\n");
}

export function fromTSV(text: string): string[][] {
  if (text.endsWith("\r\n")) text = text.slice(0, -2);
  else if (text.endsWith("\n")) text = text.slice(0, -1);
  return parseSync(text, "\t");
}
