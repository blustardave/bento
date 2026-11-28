/* Formula engine: deep chains and the cost of an edit. */
import { Doc, Book } from "../src/doc";

let fails = 0;
function eq(a: unknown, b: unknown, msg: string) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) { fails++; console.log(`FAIL ${msg}\n  got ${ja}\n  exp ${jb}`); }
}
function ok(c: boolean, msg: string) { if (!c) { fails++; console.log("FAIL", msg); } }

/* ---- Long chains, worked out bottom-first (as when the view sits at the bottom). ---- */
for (const N of [1_000, 20_000, 100_000]) {
  const d = new Doc("t", null);
  const rows: string[][] = [["0", "0"]];
  for (let i = 1; i < N; i++) rows.push(["1", `=B${i}+A${i + 1}`]);
  d.load(rows);
  eq(d.display(N - 1, 1), String(N - 1), `running total of ${N} rows, bottom first`);
  let bad = -1;
  for (let r = 0; r < N; r++) if (d.display(r, 1).startsWith("#")) { bad = r; break; }
  eq(bad, -1, `no errors anywhere in the ${N}-row chain`);
  // Edit the top: everything below follows.
  d.setCells([{ r: 1, c: 0, v: "2" }]);
  eq(d.display(N - 1, 1), String(N), `chain of ${N} updates after an edit`);
}

// A chain that runs through a SUM range, bottom first.
{
  const d = new Doc("t", null);
  const rows: string[][] = [["1", "=A1"]];
  for (let i = 2; i <= 5000; i++) rows.push(["1", `=SUM(B${i - 1}:B${i - 1})+A${i}`]);
  d.load(rows);
  eq(d.display(4999, 1), "5000", "deep chain through ranges");
}

// Circular references, short and long.
{
  const d = new Doc("t", null);
  d.load([["=B1", "=A1"]]);
  eq([d.display(0, 0), d.display(0, 1)], ["#CIRC!", "#CIRC!"], "short cycle");
  const rows: string[][] = [];
  const N = 2000;
  for (let i = 1; i <= N; i++) rows.push([i === N ? "=A1+1" : `=A${i + 1}+1`]);
  const e = new Doc("t", null);
  e.load(rows);
  eq(e.display(0, 0), "#CIRC!", "long cycle is reported, not a hang");
}

// Chains across sheets.
{
  const book = new Book("b", null);
  const s1 = new Doc("b", null, book); book.sheets.push(s1); s1.sheetName = "S1";
  const s2 = new Doc("b", null, book); book.sheets.push(s2); s2.sheetName = "S2";
  const N = 3000;
  const r1: string[][] = [], r2: string[][] = [];
  for (let i = 1; i <= N; i++) {
    r1.push([i === 1 ? "1" : `=S2!A${i - 1}+1`]);
    r2.push([`=S1!A${i}+1`]);
  }
  s1.load(r1); s2.load(r2);
  eq(s2.display(N - 1, 0), String(2 * N), "deep chain that zig-zags between sheets");
}

/* ---- Editing next to thousands of lookups stays quick. ---- */
function timeEdit(rows: string[][], setup?: (d: Doc) => void): number {
  const d = new Doc("t", null);
  d.load(rows);
  setup?.(d);
  d.display(0, 2); // empty cell: builds the spill list once
  const t = performance.now();
  for (let k = 0; k < 3; k++) { d.setCells([{ r: 0, c: 5, v: String(k) }]); d.display(0, 2); d.display(1, 1); }
  return (performance.now() - t) / 3;
}
{
  const N = 10_000;
  const xl: string[][] = [], im: string[][] = [], nm: string[][] = [];
  for (let i = 1; i <= N; i++) {
    xl.push([`k${i}`, `=XLOOKUP(A${i},D:D,E:E)`, "", `k${N - i}`, String(i)]);
    im.push([`k${i}`, `=INDEX(E:E,MATCH(A${i},D:D,0))`, "", `k${N - i}`, String(i)]);
    nm.push([String(i), `=A${i}*RATE`]);
  }
  const tx = timeEdit(xl), ti = timeEdit(im);
  const tn = timeEdit(nm, (d) => d.book.names.set("RATE", { name: "Rate", ref: "Sheet1!$A$1" }));
  ok(tx < 50, `10,000 XLOOKUPs: an edit took ${tx.toFixed(1)} ms`);
  ok(ti < 50, `10,000 INDEX/MATCH: an edit took ${ti.toFixed(1)} ms`);
  ok(tn < 50, `10,000 formulas using a name: an edit took ${tn.toFixed(1)} ms`);
}

/* ---- Spills still appear (including ones not predicted from the formula). ---- */
{
  const d = new Doc("t", null);
  d.load([["1", "a", "b"], ["2", "c", "d"], ["3", "e", "f"], ["", "=SEQUENCE(3)", "", "=INDEX(A1:A3,0)", "=INDEX(A1:A3,F4)"], [], [], ["=XLOOKUP(2,A1:A3,A1:C3)"]]);
  eq([d.display(4, 1), d.display(5, 1)], ["2", "3"], "SEQUENCE spills");
  eq([d.display(6, 0), d.display(6, 1), d.display(6, 2)], ["2", "c", "d"], "XLOOKUP into a wider range still spills");
  eq([d.display(4, 3), d.display(5, 3)], ["2", "3"], "INDEX with row 0 spills");
  // INDEX with a row number from a cell is assumed to be one value — until it isn't.
  d.setCells([{ r: 3, c: 5, v: "0" }]);
  d.display(3, 4); // calculating it reveals an array…
  eq([d.display(4, 4), d.display(5, 4)], ["2", "3"], "…which then spills");
}

console.log(fails ? `${fails} ENGINE FAILURE(S)` : "ENGINE PASS");
if (fails) process.exit(1);
