/* ------------------------------------------------------------------ *
 * Checks on everything read from a .bento file (or a recovery copy).
 * A file is untrusted input: anything that ends up in the page — colours,
 * sizes, image URLs, object kinds — is checked here so a crafted file
 * can't inject markup or script.
 * ------------------------------------------------------------------ */
import type { ChartType, ShapeType, SheetObject } from "./doc";
import type { NumFmt, Style } from "./format";

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const TOKEN = /^@(?:gray|red|orange|yellow|green|teal|blue|purple|pink)(?:-[12])?$/;

/** A colour as stored in a file: a palette token ("@red", "@red-1") or a hex colour. */
export function safeColor(v: unknown): string | undefined {
  return typeof v === "string" && (TOKEN.test(v) || HEX.test(v)) ? v : undefined;
}

/** Only pictures held inline as base64 data URLs (never remote URLs, which would phone home). */
const IMAGE_URL = /^data:image\/(?:png|jpeg|gif|webp|bmp|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/;
export function safeImageUrl(v: unknown): string | undefined {
  return typeof v === "string" && IMAGE_URL.test(v) ? v : undefined;
}

const finite = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};
const int = (v: unknown, lo: number, hi: number, fallback: number) => Math.round(finite(v, lo, hi, fallback));
const str = (v: unknown, max = 10_000): string | undefined => (typeof v === "string" ? v.slice(0, max) : undefined);

const CHARTS = new Set<ChartType>(["column", "bar", "line", "pie"]);
const SHAPES = new Set<ShapeType>(["rect", "round", "ellipse", "triangle", "diamond", "arrow", "text"]);
const ID = /^[A-Za-z0-9_-]{1,40}$/;

/** Floating objects from a file, with anything unexpected dropped or clamped. */
export function cleanObjects(list: unknown): SheetObject[] {
  if (!Array.isArray(list)) return [];
  const out: SheetObject[] = [];
  const seen = new Set<string>();
  for (const raw of list.slice(0, 5000)) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    let id = typeof o.id === "string" && ID.test(o.id) ? o.id : "";
    while (!id || seen.has(id)) id = Math.random().toString(36).slice(2, 9);
    seen.add(id);
    const base = {
      id,
      r: int(o.r, 0, 1_048_575, 0), c: int(o.c, 0, 16_383, 0),
      dx: finite(o.dx, 0, 100_000, 0), dy: finite(o.dy, 0, 100_000, 0),
      w: finite(o.w, 16, 20_000, 200), h: finite(o.h, 16, 20_000, 120),
    };
    if (o.kind === "chart") {
      const chart = CHARTS.has(o.chart as ChartType) ? (o.chart as ChartType) : "column";
      out.push({ ...base, kind: "chart", chart, range: str(o.range, 200) ?? "A1", title: str(o.title, 500) });
    } else if (o.kind === "image") {
      if (typeof o.img !== "string" || !ID.test(o.img)) continue;
      out.push({ ...base, kind: "image", img: o.img });
    } else if (o.kind === "shape") {
      const shape = SHAPES.has(o.shape as ShapeType) ? (o.shape as ShapeType) : "rect";
      out.push({ ...base, kind: "shape", shape, fill: safeColor(o.fill), stroke: safeColor(o.stroke), color: safeColor(o.color), text: str(o.text) });
    }
  }
  return out;
}

/** Image table from a file: id → data URL (anything else is dropped). */
export function cleanImages(v: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!v || typeof v !== "object") return out;
  for (const [id, url] of Object.entries(v as Record<string, unknown>)) {
    const u = safeImageUrl(url);
    if (ID.test(id) && u) out.set(id, u);
  }
  return out;
}

const HA = new Set(["l", "c", "r"]), VA = new Set(["t", "m", "b"]), WRAP = new Set(["overflow", "wrap", "clip"]);
const ROT = new Set(["stack", "up"]), NFK = new Set(["num", "pct", "cur", "date", "text"]), DATEF = new Set(["iso", "dmy", "mdy", "long"]);
const FONT = /^[A-Za-z0-9 ._-]{1,64}$/;

function cleanNumFmt(v: unknown): NumFmt | undefined {
  if (!v || typeof v !== "object") return undefined;
  const n = v as Record<string, unknown>;
  if (!NFK.has(n.k as string)) return undefined;
  const out: NumFmt = { k: n.k as NumFmt["k"] };
  if (n.dp !== undefined) out.dp = int(n.dp, 0, 10, 2);
  if (typeof n.sep === "boolean") out.sep = n.sep;
  if (typeof n.cur === "string") out.cur = n.cur.slice(0, 8);
  if (DATEF.has(n.date as string)) out.date = n.date as NumFmt["date"];
  return out;
}

/** One cell style from a file. */
export function cleanStyle(v: unknown): Style {
  if (!v || typeof v !== "object") return {};
  const s = v as Record<string, unknown>;
  const out: Style = {};
  for (const k of ["b", "i", "u", "s", "check"] as const) if (s[k] === true || s[k] === false) out[k] = s[k] as boolean;
  const color = safeColor(s.color), fill = safeColor(s.fill);
  if (color) out.color = color;
  if (fill) out.fill = fill;
  if (HA.has(s.ha as string)) out.ha = s.ha as Style["ha"];
  if (VA.has(s.va as string)) out.va = s.va as Style["va"];
  if (WRAP.has(s.wrap as string)) out.wrap = s.wrap as Style["wrap"];
  if (ROT.has(s.rot as string)) out.rot = s.rot as Style["rot"];
  if (s.size !== undefined) out.size = int(s.size, 4, 96, 10);
  if (typeof s.font === "string" && FONT.test(s.font)) out.font = s.font;
  const nf = cleanNumFmt(s.nf);
  if (nf) out.nf = nf;
  if (Array.isArray(s.list)) out.list = s.list.filter((x): x is string => typeof x === "string").slice(0, 1000).map((x) => x.slice(0, 1000));
  if (typeof s.img === "string" && ID.test(s.img)) out.img = s.img;
  return out;
}
