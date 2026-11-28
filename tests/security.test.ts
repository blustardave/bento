/* A crafted .bento file must not be able to get markup into the page. */
import { Book, Doc } from "../src/doc";
import { decodeBento } from "../src/bento";
import { resolveColor } from "../src/format";
import { chartSvg } from "../src/chart";

let fails = 0;
function ok(cond: boolean, msg: string) { if (!cond) { fails++; console.log("FAIL", msg); } }

const evil = '"><img src=x onerror="alert(1)">';

async function gz(obj: unknown): Promise<Uint8Array> {
  const stream = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

(async () => {
  const file = {
    format: "bento", version: 2, active: "0; alert(1)",
    names: [{ name: "Good", ref: "Sheet1!$A$1" }, { name: evil, ref: "A1" }, { nope: 1 }],
    sheets: [{
      name: "Sheet1", tabColor: `red; background: url(${evil})`,
      rows: [["a", 5, null], "not a row"],
      styles: [{}, { color: evil, fill: "#ff0000", font: `x"; ${evil}`, size: "huge", nf: { k: "evil" } }],
      cellStyles: [[0, [1, 1]], ["x", [1]]],
      columns: { widths: { "0": 120, "-5": 3, "1": "wide" }, hidden: [2, -1, "x"] },
      merges: [[0, 0, 0, 1], [5, 5, 1, 1], ["a"]],
      filters: { "0": ["x", 3] },
      objects: [
        { id: "s1", kind: "shape", shape: "rect", r: 0, c: 0, dx: 0, dy: 0, w: 100, h: 50, fill: evil, stroke: "#00f", color: evil, text: evil },
        { id: "c1", kind: "chart", chart: evil, r: 0, c: 0, dx: 0, dy: 0, w: evil, h: evil, range: "A1:B2", title: 5 },
        { id: "i1", kind: "image", img: "pic", r: 0, c: 0, dx: 0, dy: 0, w: 10, h: 10 },
        { id: "z", kind: "script" },
      ],
      images: { pic: "https://tracker.example/pixel.png", ok: "data:image/png;base64,iVBORw0KGgo=" },
    }],
  };
  const book = new Book("evil.bento", null);
  const doc = new Doc("evil.bento", null, book);
  book.sheets.push(doc);
  await decodeBento(await gz(file), book, (n) => { const d = new Doc(n, null, book); d.sheetName = n; return d; });

  ok(book.current === 0, "active index must be a number");
  ok(book.names.size === 1 && book.names.has("GOOD"), "only valid defined names are kept");
  ok(doc.tabColor === undefined, "tab colour must be a real colour");
  ok(JSON.stringify(doc.rows) === JSON.stringify([["a", "5", ""], []]), "rows become plain strings");
  const st = doc.style(0, 0);
  ok(st.color === undefined && st.fill === "#ff0000" && st.font === undefined && st.size === 10 && st.nf === undefined, "cell styles are checked: " + JSON.stringify(st));
  ok(doc.widths.get(0) === 120 && !doc.widths.has(-5) && !doc.widths.has(1), "column widths are checked");
  ok([...doc.hidden].join() === "2", "hidden columns are checked");
  ok(doc.merges.length === 1, "bad merges dropped");
  ok([...(doc.filters.get(0) ?? [])].join() === "x", "filter values are text");

  ok(doc.objects.length === 3, "unknown object kinds are dropped");
  const shape = doc.objects.find((o) => o.kind === "shape") as { fill?: string; stroke?: string; color?: string };
  ok(shape.fill === undefined && shape.color === undefined && shape.stroke === "#00f", "shape colours are checked");
  const chart = doc.objects.find((o) => o.kind === "chart") as { chart: string; w: number; h: number; title?: string };
  ok(chart.chart === "column" && typeof chart.w === "number" && typeof chart.h === "number" && chart.title === undefined, "chart fields are checked");
  ok(!doc.images.has("pic") && doc.images.has("ok"), "only inline data: images are kept (no remote URLs)");

  // Belt and braces at render time too.
  ok(resolveColor(evil, "light") === null, "resolveColor rejects non-colours");
  ok(resolveColor("#abcdef", "light") === "#abcdef", "resolveColor keeps hex colours");
  const svg = chartSvg("column", null, evil as unknown as number, evil as unknown as number, evil);
  ok(!svg.includes("<img") && !svg.includes("onerror=\""), "chart SVG never carries raw input");

  console.log(fails ? `${fails} SECURITY FAILURE(S)` : "SECURITY PASS");
  if (fails) process.exit(1);
})();
