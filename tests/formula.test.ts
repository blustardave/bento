import { Doc, Book } from "../src/doc";

let fails = 0;
function eq(a: unknown, b: unknown, msg: string) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) { fails++; console.log(`FAIL ${msg}\n  got ${ja}\n  exp ${jb}`); }
}

const book = new Book("t", null);
const s1 = new Doc("t", null, book); book.sheets.push(s1); s1.sheetName = "Sheet1";
const s2 = new Doc("t", null, book); book.sheets.push(s2); s2.sheetName = "Data 2";
s1.load([
  ["Name", "Qty", "Price", "Date"],
  ["Apple", "5", "1.2", "2026-01-15"],
  ["Pear", "3", "0.8", "2026-02-10"],
  ["Plum", "8", "2.5", "2026-03-31"],
  ["Apple", "2", "1.3", "2026-04-01"],
]);
s2.load([["10", "x"], ["20", "y"], ["30", "z"]]);
book.names.set("QTY", { name: "Qty", ref: "Sheet1!$B$2:$B$5" });

// Put a formula in a scratch cell and read it back.
let row = 20;
const f = (src: string, doc = s1) => { const r = row++; doc.setCells([{ r, c: 6, v: src }]); return doc.display(r, 6); };

eq(f("=SUM('Data 2'!A1:A3)"), "60", "cross-sheet range");
eq(f("='Data 2'!B2"), "y", "cross-sheet cell");
eq(f("=SUM(Qty)"), "18", "named range");
eq(f("=SUMIF(A2:A5,\"Apple\",B2:B5)"), "7", "SUMIF");
eq(f("=SUMIFS(B2:B5,A2:A5,\"Apple\",C2:C5,\">1.25\")"), "2", "SUMIFS");
eq(f("=COUNTIF(B2:B5,\">=3\")"), "3", "COUNTIF");
eq(f("=COUNTIFS(A2:A5,\"p*\",B2:B5,\">4\")"), "1", "COUNTIFS wildcard");
eq(f("=AVERAGEIF(A2:A5,\"Apple\",B2:B5)"), "3.5", "AVERAGEIF");
eq(f("=VLOOKUP(\"Plum\",A2:C5,3,FALSE)"), "2.5", "VLOOKUP");
eq(f("=XLOOKUP(\"Pear\",A2:A5,B2:B5)"), "3", "XLOOKUP");
eq(f("=XLOOKUP(\"Kiwi\",A2:A5,B2:B5,\"none\")"), "none", "XLOOKUP not found");
eq(f("=INDEX(B2:B5,MATCH(\"Plum\",A2:A5,0))"), "8", "INDEX/MATCH");
eq(f("=LEFT(\"Bento\",3)&RIGHT(\"Bento\",2)&MID(\"Bento\",2,3)"), "Bentoent", "LEFT/RIGHT/MID");
eq(f("=FIND(\"n\",\"Bento\")"), "3", "FIND");
eq(f("=SUBSTITUTE(\"a-b-c\",\"-\",\"+\",2)"), "a-b+c", "SUBSTITUTE nth");
eq(f("=TEXT(1234.5,\"#,##0.00\")"), "1,234.50", "TEXT number");
eq(f("=TEXT(DATE(2026,3,5),\"dd mmm yyyy\")"), "05 Mar 2026", "TEXT date");
eq(f("=TEXTJOIN(\", \",TRUE,A2:A4)"), "Apple, Pear, Plum", "TEXTJOIN");
eq(f("=DATE(2026,1,31)"), "2026-01-31", "DATE shows as a date");
eq(f("=EOMONTH(D2,1)"), "2026-02-28", "EOMONTH");
eq(f("=YEAR(D3)*100+MONTH(D3)"), "202602", "YEAR/MONTH of date text");
eq(f("=D2+30"), "2026-02-14", "date arithmetic");
eq(f("=NETWORKDAYS(\"2026-11-02\",\"2026-11-13\")"), "10", "NETWORKDAYS");
eq(f("=MEDIAN(B2:B5)"), "4", "MEDIAN");
eq(f("=ROUND(STDEV(B2:B5),4)"), "2.6458", "STDEV");
eq(f("=RANK(8,B2:B5)"), "1", "RANK");
eq(f("=SUMPRODUCT(B2:B5,C2:C5)"), "31", "SUMPRODUCT");
eq(f("=ROUNDUP(2.341,2)&\"/\"&ROUNDDOWN(2.349,2)"), "2.35/2.34", "ROUNDUP/DOWN");
eq(f("=IFS(B2>10,\"big\",B2>3,\"mid\",TRUE,\"small\")"), "mid", "IFS");
eq(f("=SWITCH(A3,\"Apple\",1,\"Pear\",2,0)"), "2", "SWITCH");
eq(f("=ROUND(PMT(0.05/12,360,200000),2)"), "-1073.64", "PMT");
eq(f("=ROUND(NPV(0.1,-100,50,60,70),2)"), "43.3", "NPV");
eq(f("=ROUND(IRR({-100,50,60}),4)"), "0.0639", "IRR");
eq(f("=LET(x,5,y,x*2,x+y)"), "15", "LET");
eq(f("=LAMBDA(a,b,a*b)(3,4)"), "12", "LAMBDA call");
eq(f("=REDUCE(0,B2:B5,LAMBDA(t,v,t+v))"), "18", "REDUCE");
book.names.set("DOUBLE", { name: "Double", ref: "LAMBDA(x,x*2)" });
eq(f("=DOUBLE(21)"), "42", "named LAMBDA");
eq(f("=SUM(MAP(B2:B5,LAMBDA(v,v*10)))"), "180", "MAP");
eq(f("=SUM(BYROW(B2:C5,LAMBDA(r,SUM(r))))"), "23.8", "BYROW");
eq(f("=XMATCH(\"Plum\",A2:A5)"), "3", "XMATCH");
eq(f("=SUM(TAKE(B2:B5,2))"), "8", "TAKE");
eq(f("=SUM(CHOOSECOLS(B2:C5,2))"), "5.8", "CHOOSECOLS");
eq(f("=ROWS(VSTACK(A2:A3,A4:A5))"), "4", "VSTACK");
eq(f("=WORKDAY(\"2026-11-20\",1)"), "2026-11-23", "WORKDAY skips the weekend");
eq(f("=DATEDIF(\"2020-05-15\",\"2026-11-20\",\"Y\")"), "6", "DATEDIF");
eq(f("=TEXT(0.75,\"hh:mm\")"), "18:00", "TEXT time");
eq(f("=SUM(IFERROR(1/(B2:B5-3),0))"), "-0.3", "IFERROR over arrays");
eq(f("=SUM(INDIRECT(\"B2:B\"&5))"), "18", "INDIRECT");
eq(f("=SUM(OFFSET(B2,1,0,2,1))"), "11", "OFFSET");
eq(f("=LARGE(B2:B5,2)&\",\"&SMALL(B2:B5,1)"), "5,2", "LARGE/SMALL");
eq(f("=PERCENTILE(B2:B5,0.5)"), "4", "PERCENTILE");
eq(f("=PROPER(\"hello wide world\")"), "Hello Wide World", "PROPER");
eq(f("=COUNTA(SPLIT(\"a,b,,c\",\",\"))"), "3", "SPLIT");
eq(f("=CONCAT(TEXTSPLIT(\"a-b\",\"-\"))"), "ab", "TEXTSPLIT");
eq(f("=SUM(SEQUENCE(4,1,10,5))"), "70", "SEQUENCE args");
eq(f("=ISNUMBER(SEARCH(\"pp\",\"Apple\"))"), "TRUE", "SEARCH");
eq(f("=A99+1"), "1", "empty cell is 0");
eq(f("=NotAThing"), "#NAME?", "unknown name");
// Spills
s1.setCells([{ r: 40, c: 0, v: "=SEQUENCE(3)" }]);
eq([s1.display(40, 0), s1.display(41, 0), s1.display(42, 0)], ["1", "2", "3"], "SEQUENCE spills");
s1.setCells([{ r: 40, c: 2, v: "=SORT(B2:B5,1,-1)" }]);
eq([s1.display(40, 2), s1.display(43, 2)], ["8", "2"], "SORT spills");
s1.setCells([{ r: 50, c: 0, v: "=UNIQUE(A2:A5)" }]);
eq([s1.display(50, 0), s1.display(51, 0), s1.display(52, 0), s1.display(53, 0)], ["Apple", "Pear", "Plum", ""], "UNIQUE");
s1.setCells([{ r: 60, c: 0, v: "=FILTER(A2:B5,B2:B5>4)" }]);
eq([s1.display(60, 0), s1.display(60, 1), s1.display(61, 0)], ["Apple", "5", "Plum"], "FILTER");
s1.setCells([{ r: 41, c: 0, v: "blocker" }]);
eq(s1.display(40, 0), "#SPILL!", "blocked spill");
s1.setCells([{ r: 41, c: 0, v: "" }]);
eq(s1.display(41, 0), "2", "unblocked");
eq(f("=SUM(A41#)"), "6", "spill reference");
eq(f("=SUM(B2:B5*C2:C5)"), "31", "array arithmetic");
// Insert a row on Sheet1: Data 2's reference to Sheet1 follows.
s2.setCells([{ r: 5, c: 0, v: "=Sheet1!B3" }]);
eq(s2.display(5, 0), "3", "ref into Sheet1");
s1.insertRows(0, 1);
eq([s2.raw(5, 0), s2.display(5, 0)], ["=Sheet1!B4", "3"], "cross-sheet shift on insert");
s1.undo();
eq(s2.raw(5, 0), "=Sheet1!B3", "undo restores cross-sheet ref");
book.renameSheet(s1, "Fruit stall");
eq(s2.raw(5, 0), "='Fruit stall'!B3", "rename sheet rewrites refs");
eq(book.names.get("QTY")!.ref, "'Fruit stall'!$B$2:$B$5", "rename sheet rewrites names");

console.log(fails ? `${fails} FAILED` : "FORMULAS PASS");
if (fails) process.exitCode = 1;
