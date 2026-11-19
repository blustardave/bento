/**
 * The .bento file: gzip-compressed JSON holding the data plus everything
 * CSV can't — formatting, formulas, column widths, frozen header, filters.
 */
import { Delimiter, LineEnding } from "./csv";
import { Doc } from "./doc";
import { Encoding } from "./encoding";
import { Style } from "./format";

export const BENTO_VERSION = 1;

interface BentoFile {
  format: "bento";
  version: number;
  rows: string[][];
  /** Style table; index 0 is always {} (no formatting). */
  styles: Style[];
  /** [row index, style id per column] for rows that have formatting. */
  cellStyles: [number, number[]][];
  columns: { widths: Record<string, number>; hidden: number[] };
  freezeHeader: boolean;
  frozenRows?: number;
  frozenCols?: number;
  /** Merged ranges [r0, c0, r1, c1]. */
  merges?: [number, number, number, number][];
  filters: Record<string, string[]>;
  csv: { delimiter: Delimiter; lineEnding: LineEnding; encoding: Encoding; bom: boolean };
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

export async function encodeBento(doc: Doc): Promise<Uint8Array> {
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
  const file: BentoFile = {
    format: "bento",
    version: BENTO_VERSION,
    rows: doc.rows.slice(0, n).map((row) => {
      let end = row.length;
      while (end > 0 && row[end - 1] === "") end--;
      return end === row.length ? row : row.slice(0, end);
    }),
    styles,
    cellStyles,
    columns: {
      widths: Object.fromEntries([...doc.widths].map(([k, v]) => [String(k), Math.round(v)])),
      hidden: [...doc.hidden],
    },
    freezeHeader: doc.freezeHeader,
    frozenRows: doc.frozenRows,
    frozenCols: doc.frozenCols,
    merges: doc.merges.filter((m) => m.r0 < n).map((m) => [m.r0, m.c0, Math.min(m.r1, n - 1), m.c1]),
    filters: Object.fromEntries([...doc.filters].map(([k, v]) => [String(k), [...v]])),
    csv: { delimiter: doc.delim, lineEnding: doc.eol, encoding: doc.encoding, bom: doc.bom },
  };
  return gzip(JSON.stringify(file));
}

export async function decodeBento(bytes: Uint8Array, doc: Doc) {
  let file: BentoFile;
  try {
    file = JSON.parse(await gunzip(bytes));
  } catch {
    throw new Error("This doesn't look like a Bento sheet — the file may be damaged.");
  }
  if (file.format !== "bento") throw new Error("This doesn't look like a Bento sheet.");
  if (file.version > BENTO_VERSION) throw new Error("This sheet was made by a newer version of Bento. Update Bento to open it.");
  doc.load(file.rows ?? []);
  for (const s of (file.styles ?? []).slice(1)) doc.intern(s);
  // Map file style ids → this doc's ids (interning can reorder duplicates).
  const map = (file.styles ?? [{}]).map((s) => doc.intern(s));
  for (const [r, st] of file.cellStyles ?? []) doc.setRowStyleArray(r, st.map((id) => map[id] ?? 0));
  doc.widths = new Map(Object.entries(file.columns?.widths ?? {}).map(([k, v]) => [Number(k), v]));
  doc.hidden = new Set(file.columns?.hidden ?? []);
  doc.frozenRows = file.frozenRows ?? (file.freezeHeader === false ? 0 : 1);
  doc.frozenCols = file.frozenCols ?? 0;
  doc.merges = (file.merges ?? []).map(([r0, c0, r1, c1]) => ({ r0, c0, r1, c1 }));
  doc.filters = new Map(Object.entries(file.filters ?? {}).map(([k, v]) => [Number(k), new Set(v)]));
  if (file.csv) {
    doc.delim = file.csv.delimiter ?? ",";
    doc.eol = file.csv.lineEnding ?? "\r\n";
    doc.encoding = file.csv.encoding ?? "utf-8";
    doc.bom = !!file.csv.bom;
  }
  doc.refreshView();
}
