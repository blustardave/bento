/* Sorting a range, and sorting dates. */
import { Doc } from "../src/doc";

let fails = 0;
function eq(a: unknown, b: unknown, msg: string) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) { fails++; console.log(`FAIL ${msg}\n  got ${ja}\n  exp ${jb}`); }
}
const col = (d: Doc, c: number) => d.rows.map((r) => r[c] ?? "");

{
  const d = new Doc("t", null);
  d.load([["Name", "Qty", "keep"], ["Pear", "3", "x1"], ["Apple", "5", "x2"], ["Plum", "1", "x3"], ["Total", "=SUM(B2:B4)", "x4"]]);
  d.sortRange(1, 3, 0, 1, 0, false); // sort A2:B4 by A
  eq(col(d, 0), ["Name", "Apple", "Pear", "Plum", "Total"], "only the range is sorted");
  eq(col(d, 1), ["Qty", "5", "3", "1", "=SUM(B2:B4)"], "its other column moves with it");
  eq(col(d, 2), ["keep", "x1", "x2", "x3", "x4"], "columns outside the range stay put");
  eq(d.display(4, 1), "9", "the total below still adds up");
  d.undo();
  eq(col(d, 0), ["Name", "Pear", "Apple", "Plum", "Total"], "one undo step");
}
{
  const d = new Doc("t", null);
  d.load([["When"], ["03/04/2026"], ["12/01/2026"], ["01/02/2026"]]);
  d.frozenRows = 1;
  d.sortBy(0, false);
  eq(col(d, 0), ["When", "12/01/2026", "01/02/2026", "03/04/2026"], "day/month/year dates sort as dates");
}
{
  const d = new Doc("t", null);
  d.load([["a", "1"], ["b", "2"]]);
  d.merges = [{ r0: 0, c0: 0, r1: 1, c1: 0 }];
  eq(d.sortRange(0, 1, 0, 1, 0, true), false, "refuses to sort through merged cells");
}

console.log(fails ? `${fails} UX FAILURE(S)` : "UX PASS");
if (fails) process.exit(1);
