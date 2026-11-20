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

/** Fill a sheet from stored data. */
export function sheetFromData(doc: Doc, file: SheetData) {
  doc.load(file.rows ?? []);
  if (file.name) doc.sheetName = file.name;
  doc.tabColor = file.tabColor;
  doc.protected = !!file.protected;
  doc.objects = (file.objects ?? []).map((o) => ({ ...o }));
  doc.images = new Map(Object.entries(file.images ?? {}));
  // Map file style ids → this doc's ids (interning can merge duplicates).
  const map = (file.styles ?? [{}]).map((s) => doc.intern(s));
  for (const [r, st] of file.cellStyles ?? []) doc.setRowStyleArray(r, st.map((id) => map[id] ?? 0));
  doc.widths = new Map(Object.entries(file.columns?.widths ?? {}).map(([k, v]) => [Number(k), v]));
  doc.hidden = new Set(file.columns?.hidden ?? []);
  doc.frozenRows = file.frozenRows ?? (file.freezeHeader === false ? 0 : 1);
  doc.frozenCols = file.frozenCols ?? 0;
  if (file.gridRows) doc.gridRows = Math.max(file.gridRows, doc.rows.length);
  if (file.gridCols) doc.gridCols = Math.max(file.gridCols, doc.cols);
  doc.merges = (file.merges ?? []).map(([r0, c0, r1, c1]) => ({ r0, c0, r1, c1 }));
  doc.filters = new Map(Object.entries(file.filters ?? {}).map(([k, v]) => [Number(k), new Set(v)]));
  if (file.csv) {
    doc.delim = file.csv.delimiter ?? ",";
    doc.eol = file.csv.lineEnding ?? "\r\n";
    doc.encoding = file.csv.encoding ?? "utf-8";
    doc.bom = !!file.csv.bom;
  }
  doc.refreshView();
  if (file.rowMeta) doc.setRowMeta(file.rowMeta.heights ?? [], file.rowMeta.hidden ?? []);
}

export async function encodeBento(book: Book): Promise<Uint8Array> {
  const file: BentoFileV2 = {
    format: "bento",
    version: BENTO_VERSION,
    sheets: book.sheets.map(sheetToData),
    active: book.current,
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
  const sheets: SheetData[] = raw.version >= 2 && Array.isArray(raw.sheets) ? raw.sheets : [raw];
  const first = book.sheets[0];
  book.sheets = [first];
  sheets.forEach((data, i) => {
    const doc = i === 0 ? first : makeSheet(data.name ?? `Sheet${i + 1}`);
    if (i > 0) book.sheets.push(doc);
    sheetFromData(doc, { ...data, name: data.name ?? `Sheet${i + 1}` });
  });
  book.current = Math.min(Math.max(0, raw.active ?? 0), book.sheets.length - 1);
}
