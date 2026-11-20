/* ------------------------------------------------------------------ *
 * Help while typing a formula, in the cell or the formula bar:
 * function suggestions, the current function's arguments, and F4 to
 * cycle the $ signs of the reference at the caret.
 * ------------------------------------------------------------------ */
import { FUNCS, FUNCTION_NAMES } from "./functions";
import { el } from "./util";

type Field = HTMLInputElement | HTMLTextAreaElement;

interface Item { name: string; desc: string; kind: "fn" | "name" }

export interface AssistHost {
  /** Defined names, for suggestions. */
  names(): string[];
  /** Where to show the popup (screen rect of the field or cell). */
  anchor(field: Field): DOMRect;
}

/** Everyday functions come first in suggestions. */
const POPULAR = ["SUM", "AVERAGE", "COUNT", "IF", "VLOOKUP", "XLOOKUP", "SUMIF", "SUMIFS", "COUNTIF", "COUNTIFS", "MAX", "MIN", "ROUND", "INDEX", "MATCH", "IFERROR", "CONCAT", "TEXT", "LEFT", "RIGHT", "MID", "LEN", "TODAY", "DATE", "FILTER", "SORT", "UNIQUE", "AND", "OR", "COUNTA", "AVERAGEIF", "TRIM", "UPPER", "LOWER", "SUBSTITUTE", "NOW", "YEAR", "MONTH", "DAY", "SEQUENCE", "LET"];
const rank = (n: string) => { const i = POPULAR.indexOf(n); return i < 0 ? 999 : i; };

/** The function call the caret is in, and which argument. */
export function callAt(text: string, caret: number): { name: string; arg: number } | null {
  const stack: { name: string | null; arg: number }[] = [];
  let i = 0;
  const upto = text.slice(0, caret);
  while (i < upto.length) {
    const ch = upto[i];
    if (ch === '"') { const j = upto.indexOf('"', i + 1); if (j < 0) return null; i = j + 1; continue; }
    if (ch === "'") { const j = upto.indexOf("'", i + 1); if (j < 0) return null; i = j + 1; continue; }
    const m = /^[A-Za-z_][A-Za-z0-9_.]*(?=\()/.exec(upto.slice(i));
    if (m) { stack.push({ name: m[0].toUpperCase(), arg: 0 }); i += m[0].length + 1; continue; }
    if (ch === "(") stack.push({ name: null, arg: 0 });
    else if (ch === ")") stack.pop();
    else if ((ch === "," || ch === ";") && stack.length) stack[stack.length - 1].arg++;
    else if (ch === "{") stack.push({ name: null, arg: 0 });
    else if (ch === "}") stack.pop();
    i++;
  }
  for (let k = stack.length - 1; k >= 0; k--) if (stack[k].name) return stack[k] as { name: string; arg: number };
  return null;
}

/** The name being typed just before the caret, if suggestions make sense there. */
function wordAt(text: string, caret: number): { word: string; start: number } | null {
  if (!text.startsWith("=")) return null;
  const before = text.slice(0, caret);
  // Not inside a string.
  if ((before.match(/"/g) ?? []).length % 2) return null;
  const m = /[A-Za-z_][A-Za-z0-9_.]*$/.exec(before);
  if (!m) return null;
  const prev = before[m.index - 1] ?? "";
  if (/[A-Za-z0-9_.$!:'"]/.test(prev)) return null;
  if (/^[A-Za-z]{1,3}\d+$/.test(m[0])) return null; // a cell reference
  if (/[A-Za-z0-9_.(]/.test(text[caret] ?? "")) return null;
  return { word: m[0], start: m.index };
}

/** Text of a signature with the current argument wrapped in <b>. */
function sigHTML(sig: string, arg: number): string {
  const open = sig.indexOf("(");
  const name = sig.slice(0, open);
  const inner = sig.slice(open + 1, -1);
  const parts = inner ? inner.split(/, (?![^(]*\))/) : [];
  if (!parts.length) return esc(sig);
  let k = arg;
  const last = parts.length - 1;
  if (k > last) {
    // Repeating arguments ("value1, [value2, …]" or pairs like "range1, criterion1, …").
    const rep = parts.findIndex((p) => p.includes("…"));
    if (rep >= 0) {
      const firstRep = parts.findIndex((p) => /2/.test(p));
      const span = firstRep >= 0 ? rep - firstRep + 1 : 1;
      k = firstRep >= 0 ? firstRep + ((k - firstRep) % span) : last;
    } else k = last;
  }
  return `${esc(name)}(${parts.map((p, i) => i === k ? `<b>${esc(p)}</b>` : esc(p)).join(", ")})`;
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** Cycle $ signs: A1 → $A$1 → A$1 → $A1 → A1. Returns the new text and caret, or null. */
export function cycleAbsolute(text: string, caret: number): { text: string; caret: number } | null {
  if (!text.startsWith("=")) return null;
  const re = /((?:'[^']*'|[A-Za-z_][A-Za-z0-9_.]*)!)?(\$?[A-Za-z]{1,3}\$?\d+)(?::(\$?[A-Za-z]{1,3}\$?\d+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const s = m.index, e = s + m[0].length;
    if (caret < s || caret > e) continue;
    // Skip things that are really function names or inside strings.
    if (/[A-Za-z0-9_]/.test(text[s - 1] ?? "") || text[e] === "(") continue;
    const next = (ref: string) => {
      const p = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(ref)!;
      const state = (p[1] ? 1 : 0) + (p[3] ? 2 : 0); // 0 none, 3 both, 2 row, 1 col
      const order = [0, 3, 2, 1];
      const ns = order[(order.indexOf(state) + 1) % 4];
      return (ns & 1 ? "$" : "") + p[2] + (ns & 2 ? "$" : "") + p[4];
    };
    const first = next(m[2]);
    const firstState = first;
    let rep = (m[1] ?? "") + first;
    if (m[3]) {
      // Both ends of a range follow the first one's new style.
      const p = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(m[3])!;
      const f = /^(\$?)[A-Za-z]+(\$?)\d+$/.exec(firstState)!;
      rep += ":" + f[1] + p[2] + f[2] + p[4];
    }
    const out = text.slice(0, s) + rep + text.slice(e);
    return { text: out, caret: s + rep.length };
  }
  return null;
}

export class FormulaAssist {
  private pop: HTMLElement;
  private items: Item[] = [];
  private hot = 0;
  private word: { word: string; start: number } | null = null;
  private field: Field | null = null;

  constructor(private host: AssistHost) {
    this.pop = el("div", { class: "fx-pop", hidden: "" });
    document.body.append(this.pop);
    this.pop.addEventListener("pointerdown", (e) => e.preventDefault()); // keep focus in the field
  }

  attach(field: Field) {
    field.addEventListener("input", () => this.update(field));
    field.addEventListener("click", () => this.update(field));
    field.addEventListener("keyup", (ev) => { const e = ev as KeyboardEvent; if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") this.update(field); });
    field.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== field) this.hide(); }));
    field.addEventListener("keydown", (e) => this.onKey(e as KeyboardEvent, field), true);
  }

  hide() {
    this.pop.hidden = true;
    this.items = [];
    this.field = null;
  }

  /** Refresh for the field's text and caret. */
  update(field: Field) {
    const text = field.value;
    const caret = field.selectionStart ?? text.length;
    if (!text.startsWith("=") || field.selectionStart !== field.selectionEnd) { this.hide(); return; }
    this.field = field;
    this.word = wordAt(text, caret);
    if (this.word) {
      const w = this.word.word.toUpperCase();
      const fns: Item[] = FUNCTION_NAMES.filter((n) => n.startsWith(w))
        .sort((a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b))
        .map((n) => ({ name: n, desc: FUNCS[n].desc, kind: "fn" }));
      const names: Item[] = this.host.names().filter((n) => n.toUpperCase().startsWith(w)).map((n) => ({ name: n, desc: "Named range", kind: "name" }));
      this.items = [...names, ...fns].slice(0, 9);
      if (this.items.length === 1 && this.items[0].name.toUpperCase() === w && this.items[0].kind === "name") this.items = [];
      if (this.items.length) { this.hot = 0; this.showList(); return; }
    }
    this.items = [];
    const call = callAt(text, caret);
    const spec = call && FUNCS[call.name];
    if (call && spec) this.showHint(spec.sig, spec.desc, call.arg);
    else this.pop.hidden = true;
  }

  private showList() {
    const pop = this.pop;
    pop.className = "fx-pop list";
    pop.replaceChildren(...this.items.map((it, i) => {
      const row = el("div", { class: "fx-item" + (i === this.hot ? " hot" : "") },
        el("span", { class: "fx-name" + (it.kind === "name" ? " named" : ""), text: it.name }),
        el("span", { class: "fx-desc", text: it.desc }));
      row.addEventListener("pointerdown", (e) => { e.preventDefault(); this.hot = i; this.accept(); });
      row.addEventListener("mouseenter", () => { this.hot = i; this.paintHot(); });
      return row;
    }));
    this.place();
  }

  private paintHot() {
    [...this.pop.children].forEach((c, i) => c.classList.toggle("hot", i === this.hot));
  }

  private showHint(sig: string, desc: string, arg: number) {
    const pop = this.pop;
    pop.className = "fx-pop hint";
    const s = el("div", { class: "fx-sig" });
    s.innerHTML = sigHTML(sig, arg);
    pop.replaceChildren(s, el("div", { class: "fx-desc", text: desc }));
    this.place();
  }

  private place() {
    const f = this.field;
    if (!f) return;
    this.pop.hidden = false;
    const r = this.host.anchor(f);
    const pw = this.pop.offsetWidth, ph = this.pop.offsetHeight;
    let left = r.left, top = r.bottom + 4;
    if (top + ph > window.innerHeight - 6) top = Math.max(6, r.top - ph - 4);
    left = Math.max(6, Math.min(left, window.innerWidth - pw - 6));
    this.pop.style.left = `${left}px`;
    this.pop.style.top = `${top}px`;
  }

  /** Put the chosen function or name into the field. */
  private accept() {
    const f = this.field, w = this.word, it = this.items[this.hot];
    if (!f || !w || !it) return;
    const caret = f.selectionStart ?? f.value.length;
    const insert = it.kind === "fn" ? it.name + "(" : it.name;
    f.value = f.value.slice(0, w.start) + insert + f.value.slice(caret);
    const pos = w.start + insert.length;
    f.setSelectionRange(pos, pos);
    f.dispatchEvent(new Event("input", { bubbles: true }));
    this.update(f);
  }

  private onKey(e: KeyboardEvent, f: Field) {
    if (e.key === "F4") {
      const r = cycleAbsolute(f.value, f.selectionStart ?? f.value.length);
      if (r) {
        e.preventDefault(); e.stopImmediatePropagation();
        f.value = r.text;
        f.setSelectionRange(r.caret, r.caret);
        f.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return;
    }
    if (this.pop.hidden || !this.items.length) {
      if (e.key === "Escape" && !this.pop.hidden) { this.hide(); }
      return;
    }
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (e.key === "ArrowDown") { stop(); this.hot = (this.hot + 1) % this.items.length; this.paintHot(); }
    else if (e.key === "ArrowUp") { stop(); this.hot = (this.hot - 1 + this.items.length) % this.items.length; this.paintHot(); }
    else if (e.key === "Tab" || (e.key === "Enter" && !e.altKey)) { stop(); this.accept(); }
    else if (e.key === "Escape") { stop(); this.items = []; this.pop.hidden = true; }
  }
}
