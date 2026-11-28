/* Data-loss and corruption bugs (each case once lost or changed data). */
import "./dom";
import { Doc, Book } from "../src/doc";
import { looksLikeHeader } from "../src/csv";
import { parseNum, maxOf } from "../src/util";
import { defineName } from "../src/formulatools";
import { FindPanel } from "../src/find";

let fails = 0;
function eq(a: unknown, b: unknown, msg: string) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) { fails++; console.log(`FAIL ${msg}\n  got ${ja}\n  exp ${jb}`); }
}
const sheets = () => {
  const book = new Book("b", null);
  const s1 = new Doc("b", null, book); book.sheets.push(s1); s1.sheetName = "S1";
  const s2 = new Doc("b", null, book); book.sheets.push(s2); s2.sheetName = "S2";
  return { book, s1, s2 };
};

/* ---- Defined names and undo ---- */
{
  const { book, s1, s2 } = sheets();
  s1.setCells([{ r: 0, c: 0, v: "5" }]);
  defineName(s2, "Total", "S1!$A$1");
  s1.undo(); // undo an unrelated edit on another sheet
  eq([...book.names.keys()], ["TOTAL"], "undoing an edit doesn't delete a name made since");
  s2.undo();
  eq(book.names.size, 0, "undo removes the name that was just defined");
  s2.redo();
  eq([...book.names.keys()], ["TOTAL"], "redo brings it back");
  // Deleting rows a name points at still updates (and undo restores) the name.
  s1.load([["1"], ["2"], ["3"]]);
  defineName(s1, "Third", "S1!$A$3");
  s1.deleteRows([0]);
  eq(book.names.get("THIRD")?.ref, "S1!$A$2", "names follow deleted rows");
  s1.undo();
  eq(book.names.get("THIRD")?.ref, "S1!$A$3", "…and undo puts them back");
}
{
  const { book, s1, s2 } = sheets();
  s1.load([["10"]]);
  defineName(s1, "Rate", "S1!$A$1");
  s2.load([["=Rate*2", "=RATE(1,2,3)", '="Rate"']]);
  s1.renameName("Rate", "Tax", "S1!$A$1");
  eq(s2.raw(0, 0), "=Tax*2", "renaming a name updates formulas that use it");
  eq(s2.raw(0, 1), "=RATE(1,2,3)", "…but not the RATE function");
  eq(s2.raw(0, 2), '="Rate"', "…or text that happens to match");
  eq(s2.display(0, 0), "20", "renamed formula still works");
  s1.undo();
  eq([s2.raw(0, 0), [...book.names.keys()].join()], ["=Rate*2", "RATE"], "undo of a rename restores both");
}

/* ---- Undo of insert columns keeps neighbouring widths ---- */
{
  const d = new Doc("t", null);
  d.load([["a", "b", "c", "d"]]);
  d.widths.set(1, 50); d.widths.set(2, 300);
  d.insertCols(2, 1, 2);
  d.undo();
  eq([d.widths.get(1), d.widths.get(2)], [50, 300], "insert column + undo leaves widths as they were");
  d.insertCols(1, 3, 2);
  d.undo();
  eq([d.widths.get(1), d.widths.get(2)], [50, 300], "inserting several columns + undo");
}

/* ---- Redo after inserting rows ---- */
{
  const d = new Doc("t", null);
  d.load([["a"], ["b"], ["c"]]);
  d.insertRows(1, 1);
  d.setRowHeights([1], 80);
  d.undo(); d.undo(); d.redo(); d.redo();
  eq(d.rowHeight(1), 80, "row height survives undo/redo of the insert");
  d.setRowsHidden([1], true);
  d.undo(); d.undo(); d.undo(); d.redo(); d.redo(); d.redo();
  eq(d.hiddenRowCount(), 1, "hidden row survives undo/redo of the insert");
}

/* ---- Big selections don't crash ---- */
{
  const d = new Doc("t", null);
  d.load([["1"]]);
  let threw = "";
  try { d.setRowHeights(Array.from({ length: 300_000 }, (_, i) => i), 30); } catch (e) { threw = String(e); }
  eq(threw, "", "resizing 300,000 rows");
  eq(maxOf(new Array(1_000_000).fill(1)), 1, "maxOf a million items");
  const rows: string[][] = [];
  for (let i = 1; i <= 250_000; i++) rows.push([String(i), `=A${i}*2`]);
  const e = new Doc("t", null);
  e.load(rows);
  try { e.deleteRows([0]); e.applyMove("row", 0, 200_000, 10_000); } catch (err) { threw = String(err); }
  eq(threw, "", "deleting/moving rows in a 250,000-formula sheet");
}

/* ---- CSV export keeps text that only looks like a formula ---- */
{
  const d = new Doc("t", null);
  d.load([["note"], ["=== Totals ==="], ["=Notes"], ["=1+1"], ["=)"]]);
  eq(d.toText(true), "note\r\n=== Totals ===\r\n=Notes\r\n2\r\n=)\r\n", "export as values");
}

/* ---- Changes that used to go unsaved ---- */
{
  const d = new Doc("t", null);
  d.load([["a", "b"]]);
  const before = new Map(d.widths);
  d.widths.set(0, 250);
  d.commitWidths(before);
  eq(d.dirty, true, "resizing a column counts as a change");
  d.undo();
  eq(d.width(0), 100, "…and can be undone");
  d.markSaved();
  d.setColumnsHidden([1], true);
  eq([d.dirty, d.width(1)], [true, 0], "hiding a column counts as a change");
  d.undo();
  eq(d.width(1), 100, "…and can be undone");
  d.markSaved();
  d.setFilter(0, new Set(["a"]));
  eq(d.dirty, true, "filtering counts as a change (filters are saved)");
}

/* ---- Header detection for CSVs ---- */
{
  const num = (s: string) => !Number.isNaN(parseNum(s));
  eq(looksLikeHeader([["Name", "Qty"], ["Apple", "5"], ["Pear", "3"]], num), true, "text over numbers");
  eq(looksLikeHeader([["Name", "City"], ["Ann", "Leeds"], ["Bob", "York"]], num), true, "all text, headings don't recur");
  eq(looksLikeHeader([["1", "2"], ["3", "4"]], num), false, "numbers aren't headings");
  eq(looksLikeHeader([["Ann", "Leeds"], ["Bob", "Leeds"], ["Ann", "York"]], num), false, "values that recur below are data");
  eq(looksLikeHeader([["2026-01-01", "x"], ["2026-01-02", "y"]], num), false, "dates aren't headings");
  eq(looksLikeHeader([["only"]], num), false, "one row");
}

/* ---- Find & Replace never rewrites a formula by its answer ---- */
{
  const d = new Doc("t", null);
  d.load([["10"], ["20"], ["30"], ["40"], ["=SUM(A1:A4)"], ["1 apple"]]);
  const grid = { select() {}, invalidate() {}, focus() {}, matcher: null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fp: any = new FindPanel(grid as never, () => d, () => {});
  fp.q.value = "1"; fp.rep.value = "2";
  fp.replaceAll();
  eq([d.raw(4, 0), d.raw(5, 0), d.raw(0, 0), d.display(4, 0)], ["=SUM(A1:A4)", "2 apple", "20", "110"], "formula left alone, text replaced");
  fp.opts.formulas = true;
  fp.q.value = "A4"; fp.rep.value = "A3";
  fp.replaceAll();
  eq(d.raw(4, 0), "=SUM(A1:A3)", "with “In formulas”, the formula itself is edited");
}

console.log(fails ? `${fails} DATA FAILURE(S)` : "DATA PASS");
if (fails) process.exit(1);
