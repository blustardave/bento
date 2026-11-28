/**
 * The .bento file: gzip-compressed JSON holding the data plus everything
 * CSV can't — several sheets, formatting, formulas, column widths, frozen
 * rows/columns, merges, filters.
 *
 * Version 1 held a single sheet at the top level; version 2 holds a list of
 * sheets. Both are read.
 */
import { Delimiter, LineEnding } from "./csv";
import { Book, Doc, SheetObject } from "./doc";
import { Encoding } from "./encoding";
import { Style } from "./format";
import { cleanImages, cleanObjects, cleanStyle, safeColor } from "./sanitize";
import { validName } from "./fcore";

export const BENTO_VERSION = 2;

/** One sheet's contents, as stored in the file. */
export interface SheetData {
  name?: string;
  tabColor?: string;
  protected?: boolean;
  rows: string[][];
  /** Style table; index 0 is always {} (no formatting). */
  styles: Style[];
  /** [row index, style id per column] for rows that have formatting. */
  cellStyles: [number, number[]][];
  columns: { widths: Record<string, number>; hidden: number[] };
  freezeHeader?: boolean; // v1 only
  /** Sheet size in rows/columns (older files: worked out from the data). */
  gridRows?: number;
  gridCols?: number;
  frozenRows?: number;
  frozenCols?: number;
  /** Merged ranges [r0, c0, r1, c1]. */
  merges?: [number, number, number, number][];
  filters: Record<string, string[]>;
  csv?: CsvSettings;
  /** Charts, images, shapes and text boxes. */
  objects?: SheetObject[];
  /** Hand-set row heights and hidden rows. */
  rowMeta?: { heights: [number, number][]; hidden: number[] };
  /** Image data by id (only images still in use). */
  images?: Record<string, string>;
}

interface CsvSettings { delimiter: Delimiter; lineEnding: LineEnding; encoding: Encoding; bom: boolean }

interface BentoFileV2 {
  format: "bento";
  version: number;
  sheets: SheetData[];
  active?: number;
  csv?: CsvSettings;
  /** Defined names (file-wide). */
  names?: { name: string; ref: string }[];
}

export function isBentoPath(p: string | null | undefined): boolean {
  return !!p && /\.bento$/i.test(p);
}

/** gzip files start with 1f 8b. */
export function looksLikeBento(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/** Snapshot one sheet (also used to duplicate sheets). */
export function sheetToData(doc: Doc): SheetData {
  // Drop rows at the end that hold nothing at all.
  let n = doc.rows.length;
  while (n > 0 && doc.rows[n - 1].every((v) => v === "") && !doc.rowStyleArray(n - 1)?.some((x) => x)) n--;
  const cellStyles: [number, number[]][] = [];
  const used = new Map<number, number>([[0, 0]]);
  const styles: Style[] = [{}];
  for (let r = 0; r < n; r++) {
    const st = doc.rowStyleArray(r);
    if (!st || !st.some((x) => x)) continue;
    // Only keep styles that are still in use, renumbered compactly.
    const out = st.map((id) => {
      let m = used.get(id);
      if (m === undefined) { m = styles.length; styles.push(doc.styles[id]); used.set(id, m); }
      return m;
    });
    while (out.length && out[out.length - 1] === 0) out.pop();
    cellStyles.push([r, out]);
  }
  // Images still referenced by an object or a cell style.
  const usedImages = new Set<string>();
  for (const o of doc.objects) if (o.kind === "image") usedImages.add(o.img);
  for (const st of styles) if (st.img) usedImages.add(st.img);
  const images: Record<string, string> = {};
  for (const id of usedImages) { const u = doc.images.get(id); if (u) images[id] = u; }
  return {
    objects: doc.objects.length ? doc.objects.map((o) => ({ ...o })) : undefined,
    rowMeta: (() => { const m = doc.rowMeta(); return m.heights.length || m.hidden.length ? m : undefined; })(),
    images: usedImages.size ? images : undefined,
    name: doc.sheetName,
    tabColor: doc.tabColor,
    protected: doc.protected || undefined,
    rows: doc.rows.slice(0, n).map((row) => {
      let end = row.length;
      while (end > 0 && row[end - 1] === "") end--;
      return row.slice(0, end);
    }),
    styles,
    cellStyles,
    columns: {
      widths: Object.fromEntries([...doc.widths].map(([k, v]) => [String(k), Math.round(v)])),
      hidden: [...doc.hidden],
    },
    frozenRows: doc.frozenRows,
    frozenCols: doc.frozenCols,
    gridRows: doc.gridRows,
    gridCols: doc.gridCols,
    merges: doc.merges.filter((m) => m.r0 < n).map((m) => [m.r0, m.c0, Math.min(m.r1, n - 1), m.c1]),
    filters: Object.fromEntries([...doc.filters].map(([k, v]) => [String(k), [...v]])),
    csv: { delimiter: doc.delim, lineEnding: doc.eol, encoding: doc.encoding, bom: doc.bom },
  };
}

const MAX_ROW = 1_048_576, MAX_COL = 16_384;
const isIndex = (v: unknown, max: number): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < max;
const DELIMS = new Set<Delimiter>([",", ";", "\t", "|"]);
const ENCODINGS = new Set<Encoding>(["utf-8", "utf-16le", "utf-16be", "windows-1252"]);

/** Rows from a file: arrays of strings (anything else becomes text or is dropped). */
function cleanRows(v: unknown): string[][] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, MAX_ROW).map((row) => Array.isArray(row)
    ? row.slice(0, MAX_COL).map((x) => (typeof x === "string" ? x : x === null || x === undefined ? "" : String(x)))
    : []);
}

/**
 * Fill a sheet from stored data. The data comes from a file, so every part
 * of it is checked: nothing in a .bento can reach the page as markup.
 */
export function sheetFromData(doc: Doc, file: SheetData) {
  doc.load(cleanRows(file.rows));
  if (typeof file.name === "string" && file.name.trim()) doc.sheetName = file.name.slice(0, 100);
  doc.tabColor = safeColor(file.tabColor);
  doc.protected = file.protected === true;
  doc.objects = cleanObjects(file.objects);
  doc.images = cleanImages(file.images);
  // Map file style ids → this doc's ids (interning can merge duplicates).
  const map = (Array.isArray(file.styles) ? file.styles : [{}]).map((s) => doc.intern(cleanStyle(s)));
  for (const entry of Array.isArray(file.cellStyles) ? file.cellStyles : []) {
    if (!Array.isArray(entry) || !isIndex(entry[0], MAX_ROW) || !Array.isArray(entry[1])) continue;
    doc.setRowStyleArray(entry[0], entry[1].slice(0, MAX_COL).map((id) => (Number.isInteger(id) ? map[id] ?? 0 : 0)));
  }
  const widths = file.columns?.widths && typeof file.columns.widths === "object" ? file.columns.widths : {};
  doc.widths = new Map(Object.entries(widths)
    .filter(([k, v]) => isIndex(Number(k), MAX_COL) && Number.isFinite(v))
    .map(([k, v]) => [Number(k), Math.min(2000, Math.max(0, v))]));
  doc.hidden = new Set((Array.isArray(file.columns?.hidden) ? file.columns.hidden : []).filter((c) => isIndex(c, MAX_COL)));
  const frozen = (v: unknown, fallback: number) => (isIndex(v, 10_000) ? v : fallback);
  doc.frozenRows = frozen(file.frozenRows, file.freezeHeader === false ? 0 : 1);
  doc.frozenCols = frozen(file.frozenCols, 0);
  if (isIndex(file.gridRows, MAX_ROW + 1)) doc.gridRows = Math.max(file.gridRows, doc.rows.length);
  if (isIndex(file.gridCols, MAX_COL + 1)) doc.gridCols = Math.max(file.gridCols, doc.cols);
  doc.merges = (Array.isArray(file.merges) ? file.merges : [])
    .filter((m) => Array.isArray(m) && isIndex(m[0], MAX_ROW) && isIndex(m[1], MAX_COL) && isIndex(m[2], MAX_ROW) && isIndex(m[3], MAX_COL) && m[2] >= m[0] && m[3] >= m[1])
    .map(([r0, c0, r1, c1]) => ({ r0, c0, r1, c1 }));
  const filters = file.filters && typeof file.filters === "object" ? file.filters : {};
  doc.filters = new Map(Object.entries(filters)
    .filter(([k, v]) => isIndex(Number(k), MAX_COL) && Array.isArray(v))
    .map(([k, v]) => [Number(k), new Set(v.filter((x): x is string => typeof x === "string"))]));
  if (file.csv && typeof file.csv === "object") {
    doc.delim = DELIMS.has(file.csv.delimiter) ? file.csv.delimiter : ",";
    doc.eol = file.csv.lineEnding === "\n" ? "\n" : "\r\n";
    doc.encoding = ENCODINGS.has(file.csv.encoding) ? file.csv.encoding : "utf-8";
    doc.bom = file.csv.bom === true;
  }
  doc.refreshView();
  const meta = file.rowMeta;
  if (meta && typeof meta === "object") {
    const heights = (Array.isArray(meta.heights) ? meta.heights : [])
      .filter((h): h is [number, number] => Array.isArray(h) && isIndex(h[0], MAX_ROW) && Number.isFinite(h[1]) && h[1] > 0)
      .map(([r, h]) => [r, Math.min(1000, h)] as [number, number]);
    const hidden = (Array.isArray(meta.hidden) ? meta.hidden : []).filter((r) => isIndex(r, MAX_ROW));
    doc.setRowMeta(heights, hidden);
  }
}

export async function encodeBento(book: Book): Promise<Uint8Array> {
  const file: BentoFileV2 = {
    format: "bento",
    version: BENTO_VERSION,
    sheets: book.sheets.map(sheetToData),
    active: book.current,
    names: book.names.size ? [...book.names.values()] : undefined,
  };
  return gzip(JSON.stringify(file));
}

/**
 * Read a .bento file into `book`. The book's first sheet is reused; further
 * sheets are made with `makeSheet`.
 */
export async function decodeBento(bytes: Uint8Array, book: Book, makeSheet: (name: string) => Doc) {
  let raw: (BentoFileV2 & SheetData) | null;
  try {
    raw = JSON.parse(await gunzip(bytes));
  } catch {
    throw new Error("This doesn't look like a Bento sheet — the file may be damaged.");
  }
  if (!raw || raw.format !== "bento") throw new Error("This doesn't look like a Bento sheet.");
  if (raw.version > BENTO_VERSION) throw new Error("This sheet was made by a newer version of Bento. Update Bento to open it.");
  const sheets: SheetData[] = (raw.version >= 2 && Array.isArray(raw.sheets) ? raw.sheets : [raw])
    .filter((s) => s && typeof s === "object").slice(0, 500);
  if (!sheets.length) throw new Error("This Bento sheet has nothing in it — the file may be damaged.");
  const first = book.sheets[0];
  book.sheets = [first];
  const taken = new Set<string>();
  sheets.forEach((data, i) => {
    // Sheet names must be text and unique (formulas find sheets by name).
    let name = typeof data.name === "string" && data.name.trim() ? data.name.slice(0, 100) : `Sheet${i + 1}`;
    while (taken.has(name.toLowerCase())) name = `${name} (${i + 1})`;
    taken.add(name.toLowerCase());
    const doc = i === 0 ? first : makeSheet(name);
    if (i > 0) book.sheets.push(doc);
    sheetFromData(doc, { ...data, name });
  });
  book.current = Number.isInteger(raw.active) ? Math.min(Math.max(0, raw.active!), book.sheets.length - 1) : 0;
  book.names = new Map((Array.isArray(raw.names) ? raw.names : [])
    .filter((n) => n && typeof n.name === "string" && typeof n.ref === "string" && validName(n.name))
    .map((n) => [n.name.toUpperCase(), { name: n.name, ref: n.ref.slice(0, 2000) }]));
  book.recalcAll();
}
