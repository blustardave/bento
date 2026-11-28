/* Formula and formatting results that used to differ from Excel. */
import { Doc } from "../src/doc";
import { applyNumFmt } from "../src/format";
import { shortenNumber } from "../src/fcore";

let fails = 0;
function eq(a: unknown, b: unknown, msg: string) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) { fails++; console.log(`FAIL ${msg}\n  got ${ja}\n  exp ${jb}`); }
}

const d = new Doc("t", null);
d.load([["1234567.891234567"], ["0.1"], ["0.2"]]);
let row = 10;
const f = (src: string) => { const r = row++; d.setCells([{ r, c: 0, v: src }]); return d.display(r, 0); };

eq(f('=TEXT(0.5,"0%")'), "50%", "TEXT keeps the % sign");
eq(f('=TEXT(0.256,"0.0%")'), "25.6%", "TEXT percent with decimals");
eq(f('=TEXT(42,"000")'), "042", "TEXT zero-pads");
eq(f('=TEXT(7,"00.0")'), "07.0", "TEXT zero-pads with decimals");
eq(f('=TEXT(1234.5,"#,##0.00")'), "1,234.50", "TEXT thousands still fine");
eq(f('=TEXT(0.5,"#.00")'), ".50", "TEXT with no integer digit");
eq(f("=2^3^2"), "64", "^ works left to right, as in Excel");
eq(f("=-2^2"), "4", "unary minus binds tighter than ^, as in Excel");
eq(f("=A2+A3=0.3"), "TRUE", "0.1 + 0.2 = 0.3, as in Excel");
eq(f("=A2+A3<>0.3"), "FALSE", "…and isn't unequal");
eq(f("=1/3&\"\""), "0.333333333333333", "15 significant digits in text, as in Excel");
eq(f("=A1*1"), "1234567.89123457", "big numbers keep 15 digits");
eq(f("=A2+A3"), "0.3", "float noise stays hidden");

// Text that merely starts with "=" shows as text; a broken formula still shows an error.
{
  const t = new Doc("t", null);
  t.load([["=== Totals ==="], ["=)"], ["=SUM(A1"], ["=A1"]]);
  eq([t.display(0, 0), t.display(1, 0), t.display(2, 0), t.display(3, 0)], ["=== Totals ===", "=)", "#ERROR!", "=== Totals ==="], "text vs broken formulas");
}

// CSV export of calculated values keeps their precision.
const e = new Doc("t", null);
e.load([["1234567.891234567", "=A1*2"]]);
eq(e.toText(true), "1234567.891234567,2469135.78246913\r\n", "exported values keep 15 digits");

// Narrow columns round calculated numbers to fit instead of cutting them off.
const fits = (w: number) => (s: string) => s.length <= w;
eq(shortenNumber("0.666666666666667", fits(8)), "0.666667", "rounds to fit");
eq(shortenNumber("1234567.89123457", fits(9)), "1234567.9", "rounds decimals to fit");
eq(shortenNumber("1234567.89123457", fits(8)), "1234568", "keeps the whole-number digits");
eq(shortenNumber("123456789.5", fits(7)), "1.23E+8", "falls back to scientific");
eq(shortenNumber("123456789.5", fits(5)), "1E+8", "…with fewer digits if need be");
eq(shortenNumber("0.5", fits(8)), "0.5", "leaves short numbers alone");

// Number formats offered in the toolbar.
eq(applyNumFmt("1234.5", { k: "num", sep: true }), "1,234.5", "thousands separators");
eq(applyNumFmt("1234.5", { k: "num", dp: 0, sep: true }), "1,235", "whole number");
eq(applyNumFmt("2026-11-28", { k: "date", date: "long" }), "28 Nov 2026", "long date");
eq(applyNumFmt("46354", { k: "date", date: "dmy" }), "28/11/2026", "a date serial as a date");

console.log(fails ? `${fails} CORRECTNESS FAILURE(S)` : "CORRECTNESS PASS");
if (fails) process.exit(1);
