import { parseSync, sniffDelimiter, serialize, CsvParser } from "../src/csv";
import { decodeBytes, encodeText } from "../src/encoding";
import { Engine, shiftFormula } from "../src/formula";
import { Doc } from "../src/doc";
import { parseNum, colName, colIndex } from "../src/util";
import { applyNumFmt, parseDate, formatDate } from "../src/format";
import { encodeBento, decodeBento } from "../src/bento";
import { fillValues } from "../src/fill";

let fails = 0;
function eq(a: unknown, b: unknown, msg: string) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) { fails++; console.log("FAIL", msg, "\n  got", ja, "\n  exp", jb); }
}

eq(parseSync('a,b,c\n1,"x,y",3\n', ","), [["a","b","c"],["1","x,y","3"]], "basic");
eq(parseSync('"he said ""hi""",2\r\n"multi\nline",x', ","), [['he said "hi"',"2"],["multi\nline","x"]], "quotes");
eq(parseSync("a,\n,b", ","), [["a",""],["","b"]], "empties");
eq(parseSync("a,b,", ","), [["a","b",""]], "trailing delim");
eq(parseSync("", ","), [], "empty");
eq(parseSync("a\n\nb\n", ","), [["a"],[""],["b"]], "blank line");
eq(sniffDelimiter("a;b;c\n1;2,5;3\n4;5;6"), ";", "sniff semicolon");
eq(sniffDelimiter("a\tb\n1\t2"), "\t", "sniff tab");
eq(sniffDelimiter("name,age\nbob,3"), ",", "sniff comma");
const rows = [["a","b"],["x,y",'q"']];
eq(serialize(2,2,(r,c)=>rows[r][c],",","\r\n",true), 'a,b\r\n"x,y","q"""\r\n', "serialize");
eq(decodeBytes(encodeText("café €", "windows-1252", false)).text, "café €", "1252 roundtrip");
eq(decodeBytes(encodeText("café", "utf-8", true)), {text:"café",encoding:"utf-8",bom:true}, "bom");
eq([parseNum("1,234.5"), parseNum("$12"), parseNum("45%"), parseNum("abc"), parseNum("-3e2"), parseNum("1,2")], [1234.5,12,0.45,NaN,-300,NaN], "parseNum");
eq([colName(0), colName(25), colName(26), colName(701), colIndex("AA")], ["A","Z","AA","ZZ",26], "cols");

const g = [["1","2","=A1+B1"],["3","x","=SUM(A1:B2)"],["=C1*2","=AVERAGE(A:A)","=IF(A1>0,\"pos\",\"neg\")"],["=A4","=1/0","=CONCAT(\"a\",A1,TRUE)"],["=ROUND(2.345,2)","=2^3^2","=-2^2"],["=SUM(A1:A2)*10%","=IF(FALSE,1)","=COUNT(A1:C2)"],["=IF(1,IF(0,1),5)","=MAX(A1:A2)&\"!\"", "=foo(1)"]];
const e = new Engine({ raw:(r,c)=>g[r]?.[c] ?? "", rowCount:()=>g.length });
const d = (r:number,c:number)=>e.display(r,c);
eq([d(0,2), d(1,2), d(2,0), d(2,2)], ["3","6","6","pos"], "formulas 1");
eq([d(3,0), d(3,1), d(3,2)], ["#CIRC!","#DIV/0!","a1TRUE"], "formulas 2");
eq([d(4,0), d(4,1), d(4,2)], ["2.35","64","4"], "formulas 3 (^ is left to right, as in Excel)");
eq([d(5,0), d(5,1), d(5,2)], ["0.4","FALSE","5"], "formulas 4");
eq([d(6,0), d(6,1), d(6,2)], ["FALSE","3!","#NAME?"], "formulas 5 nested IF");
eq(d(2,1), "#CIRC!", "errors propagate through ranges");
eq(shiftFormula("=A1+B3*$C$5", "row", 2, 1), "=A1+B4*$C$6", "shift row");
eq(shiftFormula("=SUM(A1:C1)+D1", "col", 1, -1), "=SUM(A1:B1)+C1", "shift col delete");
eq(shiftFormula("=B1*2", "col", 1, -1), "=#REF!*2", "deleted ref");
eq(shiftFormula("=SUM(B:B)", "col", 0, 2), "=SUM(D:D)", "shift cols range");

// Doc ops + undo
const doc = new Doc("t", null);
doc.load([["h1","h2"],["2","b"],["1","a"],["10","c"]]);
doc.frozenRows = 1;
doc.sortBy(0, false);
eq(doc.rows.map(r=>r[0]), ["h1","1","2","10"], "sort numeric");
doc.undo();
eq(doc.rows.map(r=>r[0]), ["h1","2","1","10"], "undo sort");
doc.setCells([{r:1,c:2,v:"=A2*2"}]);
eq(doc.display(1,2), "4", "formula in doc");
doc.insertRows(1, 2);
eq(doc.raw(3,2), "=A4*2", "formula shifted on insert");
eq(doc.display(3,2), "4", "value kept");
doc.deleteCols(0,1);
eq(doc.raw(3,1), "=#REF!*2", "ref error on delete");
doc.undo(); doc.undo();
eq(doc.raw(1,2), "=A2*2", "undo both");
eq(doc.dirty, true, "dirty");
doc.undo();
eq(doc.dirty, false, "clean after full undo");
doc.setFilter(1, new Set(["a"]));
eq(Array.from(doc.view!), [0,1,3], "filter");
doc.redo();
eq(doc.toText(false), "h1,h2,\r\n2,b,=A2*2\r\n1,a,\r\n10,c,\r\n", "toText keeps ragged as rectangle");

// Number formats
eq([applyNumFmt("1234.5", {k:"cur",cur:"£",dp:2,sep:true}), applyNumFmt("-3", {k:"cur",cur:"$"}), applyNumFmt("0.256", {k:"pct",dp:1}), applyNumFmt("1234.5678", {k:"num",dp:2,sep:true}), applyNumFmt("abc", {k:"num",dp:2})],
  ["£1,234.50","-$3.00","25.6%","1,234.57","abc"], "number formats");
eq([formatDate(parseDate("2026-01-04")!, "long"), formatDate(parseDate("31/01/2026")!, "iso"), formatDate(parseDate("46026")!, "dmy")], ["4 Jan 2026","2026-01-31","04/01/2026"], "dates");

// Formatting moves with rows, undoes, and survives .bento
const fd = new Doc("f", null);
fd.load([["h"],["b"],["a"],["c"]]);
fd.frozenRows = 1;
fd.format([{r:1,c:0}], (s)=>({...s, b:true, color:"@red"}));
fd.sortBy(0, false);
eq([fd.raw(2,0), fd.style(2,0).b, fd.style(1,0).b], ["b", true, undefined], "style follows row on sort");
fd.insertCols(0, 1);
eq(fd.style(2,1).color, "@red", "style shifts with column insert");
fd.undo(); fd.undo();
eq(fd.style(1,0).b, true, "undo sort+insert");
fd.undo();
eq(fd.hasFormatting(), false, "undo format");
fd.redo();
// Merges: keep top-left value, survive structural edits, undo exactly
const md = new Doc("m", null);
md.load([["h","x"],["a","b"],["c","d"],["e","f"]]);
md.frozenRows = 1;
md.merge({ r0: 1, c0: 0, r1: 2, c1: 1 });
eq([md.raw(1,0), md.raw(1,1), md.raw(2,0), md.merges.length], ["a","","",1], "merge clears covered cells");
md.insertRows(2, 1);
eq(md.merges[0], { r0: 1, c0: 0, r1: 3, c1: 1 }, "insert inside merge grows it");
md.deleteRows([1]);
eq(md.merges[0], { r0: 1, c0: 0, r1: 2, c1: 1 }, "delete anchor row shrinks merge");
eq(md.sortBy(0, false), false, "sort refused with vertical merge");
md.undo(); md.undo(); md.undo();
eq([md.merges.length, md.raw(1,1), md.raw(2,0)], [0, "b", "c"], "undo merge restores values");

// Sheet size: inserting/deleting changes it even where there's no data
const gd = new Doc("g", null);
eq([gd.displayRows(), gd.displayCols()], [1000, 26], "new sheet is 1000 x 26");
gd.insertCols(26, 1);
eq(gd.displayCols(), 27, "insert right of Z adds AA");
gd.insertCols(25, 1);
eq(gd.displayCols(), 28, "insert left of Z");
gd.deleteCols(25, 1);
eq(gd.displayCols(), 27, "delete column shrinks the sheet");
gd.undo(); gd.undo(); gd.undo();
eq(gd.displayCols(), 26, "undo restores width");
gd.deleteRows([999]);
eq(gd.displayRows(), 999, "deleting an empty row shrinks the sheet");
gd.insertRows(500, 3);
eq(gd.displayRows(), 1002, "inserting rows below data grows it");
gd.undo(); gd.undo();
eq(gd.displayRows(), 1000, "undo restores height");

// Fill handle series
eq(fillValues(["5"], 3, false), ["5","5","5"], "single number copies");
eq(fillValues(["5"], 3, false, true), ["6","7","8"], "Ctrl counts single number");
eq(fillValues(["1","2"], 3, false), ["3","4","5"], "1,2 continues");
eq(fillValues(["2","4"], 2, false, true), ["2","4"], "Ctrl copies a series");
eq(fillValues(["0.1","0.2"], 2, false), ["0.3","0.4"], "decimals stay clean");
eq(fillValues(["1","2"], 2, true), ["0","-1"], "backwards");
eq(fillValues(["1","3","4"], 2, false), ["5.6667","7.1667"], "linear trend");
eq(fillValues(["Item 1"], 3, false), ["Item 2","Item 3","Item 4"], "text + number");
eq(fillValues(["Q09"], 2, false), ["Q10","Q11"], "zero padding");
eq(fillValues(["2026-01-30"], 3, false), ["2026-01-31","2026-02-01","2026-02-02"], "dates by day");
eq(fillValues(["01/01/2026","08/01/2026"], 2, false), ["15/01/2026","22/01/2026"], "weekly dates");
eq(fillValues(["Mon"], 3, false), ["Tue","Wed","Thu"], "weekdays");
eq(fillValues(["Friday","Saturday"], 2, false), ["Sunday","Monday"], "weekdays wrap");
eq(fillValues(["JAN","MAR"], 2, false), ["MAY","JUL"], "months step 2 keeps case");
eq(fillValues(["a","b"], 3, false), ["a","b","a"], "text repeats");
eq(fillValues(["a","b"], 3, true), ["b","a","b"], "text repeats backwards");
eq(fillValues(["1","x"], 3, false), ["1","x","1"], "mixed repeats");

(async () => {
  // Two sheets in one file.
  const extra = new Doc("f", null, fd.book);
  extra.sheetName = "Totals";
  extra.load([["sum"], ["42"]]);
  fd.book.sheets.push(extra);
  fd.book.current = 1;
  const bytes = await encodeBento(fd.book);
  const back = new Doc("g", null);
  await decodeBento(bytes, back.book, (name) => { const d = new Doc("g", null, back.book); d.sheetName = name; return d; });
  eq([back.book.sheets.length, back.book.sheets[1].sheetName, back.book.sheets[1].raw(1, 0), back.book.current], [2, "Totals", "42", 1], "multi-sheet round trip");
  eq([back.rows.length, back.style(1,0).color, back.style(2,0).b], [4, "@red", undefined], "bento round trip");
    if (fails) process.exit(1);
})();

// Big parse timing
let big = "id,name,value,date,note\n";
const parts: string[] = [];
for (let i=0;i<1_000_000;i++) parts.push(`${i},name ${i},${(i*1.5).toFixed(2)},2024-01-${(i%28)+1},"note, with comma"`);
big += parts.join("\n");
const t0 = performance.now();
const p = new CsvParser(big, ",");
while (!p.step(50)) {}
console.log(`1M rows parsed in ${(performance.now()-t0).toFixed(0)}ms, rows=${p.rows.length}`);
const bd = new Doc("big", null); bd.load(p.rows);
const t1 = performance.now(); bd.sortBy(2, true); console.log(`sorted in ${(performance.now()-t1).toFixed(0)}ms`);
const t2 = performance.now(); const txt = bd.toText(false); console.log(`serialized ${txt.length} chars in ${(performance.now()-t2).toFixed(0)}ms`);
console.log(fails ? `${fails} FAILED` : "ALL PASS");
