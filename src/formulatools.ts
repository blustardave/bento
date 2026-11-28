/* ------------------------------------------------------------------ *
 * Formula tools: Evaluate Formula (step through a calculation) and the
 * named ranges manager.
 * ------------------------------------------------------------------ */
import type { Book, Doc } from "./doc";
import { ArrV, FErr, Node, Val, formatNumber, isArr, isErr, parse, sheetPrefix, validName } from "./fcore";
import { Engine } from "./formula";
import { closeMenus, toast } from "./ui";
import { cellName, colName, el } from "./util";

/* ---------------------------- Evaluate Formula ---------------------------- */

/** Functions whose insides can't be stepped through on their own. */
const OPAQUE = new Set(["LET", "LAMBDA", "MAP", "REDUCE", "SCAN", "BYROW", "BYCOL", "MAKEARRAY", "ISOMITTED"]);

function valueText(v: Val | ArrV): string {
  if (isArr(v)) {
    const rows = v.v;
    const total = rows.length * (rows[0]?.length ?? 0);
    const flat: string[] = [];
    outer: for (const r of rows) { const row: string[] = []; for (const x of r) { if (flat.length + row.length >= 12) { row.push("…"); flat.push(row.join(",")); break outer; } row.push(valueText(x)); } flat.push(row.join(",")); }
    return `{${flat.join(";")}}${total > 12 ? ` (${total.toLocaleString("en-GB")} values)` : ""}`;
  }
  if (typeof v === "string") return `"${v.replace(/"/g, '""')}"`;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (isErr(v)) return (v as FErr).code;
  return formatNumber(v);
}

function children(n: Node): Node[] {
  switch (n.k) {
    case "fn": return OPAQUE.has(n.name) ? [] : n.args;
    case "call": return [];
    case "bin": return [n.a, n.b];
    case "neg": case "pct": case "paren": return [n.a];
    case "array": return [];
    default: return [];
  }
}

export function evaluateDialog(doc: Doc, r: number, c: number, onClose: () => void) {
  closeMenus();
  const raw = doc.raw(r, c);
  let ast: Node;
  try { ast = parse(raw.slice(1)); } catch { toast("This formula has a mistake in it, so it can't be evaluated", true); return; }
  const done = new Map<Node, string>();
  const isLeafDone = (n: Node) => n.k === "lit" || n.k === "omit" || n.k === "array" || done.has(n);

  /** The next part to work out: innermost, leftmost. */
  const next = (n: Node): Node | null => {
    if (done.has(n) || n.k === "lit" || n.k === "omit") return null;
    for (const ch of children(n)) { const x = next(ch); if (x) return x; }
    return children(n).every(isLeafDone) ? n : null;
  };

  const lit = (v: Val) => valueText(v);
  const render = (n: Node, hot: Node | null): string => {
    const wrap = (s: string) => (n === hot ? `<mark>${s}</mark>` : s);
    if (done.has(n)) return wrap(`<i>${esc(done.get(n)!)}</i>`);
    const R = (x: Node) => render(x, hot);
    switch (n.k) {
      case "lit": return wrap(esc(lit(n.v)));
      case "omit": return "";
      case "ref": return wrap(esc((n.sh ? sheetPrefix(n.sh2 ? `${n.sh}:${n.sh2}` : n.sh) : "") + colName(n.c) + (n.r + 1)));
      case "range": {
        const p = n.sh ? sheetPrefix(n.sh2 ? `${n.sh}:${n.sh2}` : n.sh) : "";
        const t = n.r1 < 0 ? `${colName(n.c1)}:${colName(n.c2)}` : n.c1 < 0 ? `${n.r1 + 1}:${n.r2 + 1}` : `${colName(n.c1)}${n.r1 + 1}:${colName(n.c2)}${n.r2 + 1}`;
        return wrap(esc(p + t));
      }
      case "name": return wrap(esc(n.v));
      case "fn": return wrap(`${esc(n.name)}(${n.args.map(R).join(", ")})`);
      case "call": return wrap(`${R(n.callee)}(${n.args.map(R).join(", ")})`);
      case "bin": return wrap(`${R(n.a)}${esc(n.op)}${R(n.b)}`);
      case "neg": return wrap(`-${R(n.a)}`);
      case "pct": return wrap(`${R(n.a)}%`);
      case "paren": return wrap(`(${R(n.a)})`);
      case "array": return wrap(esc(`{${n.rows.map((row) => row.map((x) => (x.k === "lit" ? lit(x.v) : "?")).join(",")).join(";")}}`));
      case "spill": return wrap(`${R(n.a)}#`);
      case "union": return wrap(`(${n.parts.map(R).join(", ")})`);
    }
  };

  const expr = el("div", { class: "eval-expr" });
  const note = el("div", { class: "eval-note" });
  const step = el("button", { class: "btn primary", text: "Evaluate" });
  const restart = el("button", { class: "btn", text: "Restart" });
  const close = el("button", { class: "btn", text: "Close" });
  const where = `${doc.book.sheets.length > 1 ? sheetPrefix(doc.sheetName) : ""}${cellName(r, c)}`;
  const box = el("div", { class: "modal eval-dialog", role: "dialog" },
    el("h3", { text: "Evaluate formula" }),
    el("p", { class: "eval-where", text: `Cell ${where}` }),
    expr, note,
    el("div", { class: "foot" }, restart, el("div", { class: "grow" }), close, step));
  const scrim = el("div", { class: "scrim" }, box);

  const paint = () => {
    const hot = next(ast);
    expr.innerHTML = "=" + render(ast, hot);
    if (!hot) {
      note.textContent = "That's the result.";
      step.textContent = "Again";
    } else {
      step.textContent = "Evaluate";
      const what = hot.k === "ref" || hot.k === "range" ? "Next: look up the highlighted reference." : hot.k === "name" ? "Next: look up the highlighted name." : "Next: work out the highlighted part.";
      note.textContent = what;
    }
  };
  step.addEventListener("click", () => {
    const hot = next(ast);
    if (!hot) { done.clear(); paint(); return; }
    done.set(hot, valueText(doc.engine.evalPart(hot, r, c)));
    paint();
  });
  restart.addEventListener("click", () => { done.clear(); paint(); });
  const finish = () => { scrim.remove(); window.removeEventListener("keydown", onKey, true); onClose(); };
  close.addEventListener("click", finish);
  scrim.addEventListener("pointerdown", (e) => { if (e.target === scrim) finish(); });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(); }
    else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); step.click(); }
    else e.stopPropagation();
  };
  window.addEventListener("keydown", onKey, true);
  paint();
  document.body.append(scrim);
  step.focus();
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ------------------------------ named ranges ------------------------------ */

/** The selection as an absolute reference on its sheet, e.g. Sheet1!$B$2:$B$40. */
export function absRef(doc: Doc, s: { r0: number; c0: number; r1: number; c1: number }, whole: { cols: boolean; rows: boolean }): string {
  const p = sheetPrefix(doc.sheetName);
  if (whole.cols) return `${p}$${colName(s.c0)}:$${colName(s.c1)}`;
  if (whole.rows) return `${p}$${s.r0 + 1}:$${s.r1 + 1}`;
  const a = `$${colName(s.c0)}$${s.r0 + 1}`, b = `$${colName(s.c1)}$${s.r1 + 1}`;
  return p + (a === b ? a : `${a}:${b}`);
}

/** Check a proposed name; returns an error message, or null if it's fine. */
export function nameProblem(book: Book, name: string, except?: string): string | null {
  if (!validName(name)) return `"${name}" can't be a name: use letters, numbers and _ (starting with a letter), and nothing that looks like a cell like B12`;
  if (book.names.has(name.toUpperCase()) && name.toUpperCase() !== except?.toUpperCase()) return `There's already a range called "${name}"`;
  return null;
}

/** Add a defined name, as an undo step on the current sheet. */
export function defineName(doc: Doc, name: string, ref: string) {
  doc.changeNames((names) => names.set(name.toUpperCase(), { name, ref }));
}

export function namesDialog(doc: Doc, selectionRef: string, onDone: () => void, goTo: (ref: string) => void) {
  closeMenus();
  const book = doc.book;
  const list = el("div", { class: "names-list" });
  const paint = () => {
    list.replaceChildren();
    const all = [...book.names.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (!all.length) list.append(el("p", { class: "names-empty", text: "No named ranges yet. Name a range to use it in formulas, e.g. =SUM(Sales)." }));
    for (const n of all) {
      const name = el("input", { class: "field nm", value: n.name, spellcheck: "false" }) as HTMLInputElement;
      const ref = el("input", { class: "field rf", value: n.ref, spellcheck: "false" }) as HTMLInputElement;
      const go = el("button", { class: "icon-btn", title: "Go to range" });
      go.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M3.5 8h8.5M8.5 4.5 12 8l-3.5 3.5"/></svg>';
      const del = el("button", { class: "icon-btn", title: "Delete name" });
      del.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg>';
      const save = () => {
        const nn = name.value.trim(), rr = ref.value.trim().replace(/^=/, "");
        if (nn === n.name && rr === n.ref) return;
        const p = nameProblem(book, nn, n.name);
        if (p) { toast(p, true); name.value = n.name; return; }
        if (!Engine.references("=" + rr).length && !/^[A-Za-z_]/.test(rr)) { toast("That doesn't look like a range", true); ref.value = n.ref; return; }
        // Formulas using the old name follow the new one.
        doc.renameName(n.name, nn, rr);
        onDone();
        paint();
      };
      name.addEventListener("change", save);
      ref.addEventListener("change", save);
      go.addEventListener("click", () => { finish(); goTo(n.ref); });
      del.addEventListener("click", () => { doc.changeNames((names) => names.delete(n.name.toUpperCase()), "Delete name"); onDone(); paint(); });
      list.append(el("div", { class: "names-row" }, name, ref, go, del));
    }
  };
  const newName = el("input", { class: "field nm", placeholder: "New name", spellcheck: "false" }) as HTMLInputElement;
  const newRef = el("input", { class: "field rf", value: selectionRef, spellcheck: "false" }) as HTMLInputElement;
  const add = el("button", { class: "btn", text: "Add" });
  add.addEventListener("click", () => {
    const nn = newName.value.trim();
    const p = nameProblem(book, nn);
    if (p) { toast(p, true); newName.focus(); return; }
    defineName(doc, nn, newRef.value.trim().replace(/^=/, ""));
    newName.value = "";
    onDone();
    paint();
  });
  const done = el("button", { class: "btn primary", text: "Done" });
  const box = el("div", { class: "modal names-dialog", role: "dialog" },
    el("h3", { text: "Named ranges" }),
    el("div", { class: "names-head" }, el("span", { text: "Name" }), el("span", { text: "Range" })),
    list,
    el("div", { class: "names-row add" }, newName, newRef, add),
    el("div", { class: "foot" }, done));
  const scrim = el("div", { class: "scrim" }, box);
  const finish = () => { scrim.remove(); window.removeEventListener("keydown", onKey, true); onDone(); };
  done.addEventListener("click", finish);
  scrim.addEventListener("pointerdown", (e) => { if (e.target === scrim) finish(); });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(); return; }
    e.stopPropagation();
    if (e.key !== "Enter") return;
    e.preventDefault();
    const t = e.target as HTMLElement;
    if (t === newName || t === newRef) add.click();
    else if (t instanceof HTMLInputElement) t.blur(); // saves the edit
  };
  window.addEventListener("keydown", onKey, true);
  paint();
  document.body.append(scrim);
  newName.focus();
}
