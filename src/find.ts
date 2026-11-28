import { Doc } from "./doc";
import { Grid } from "./grid";
import { toast } from "./ui";
import { el, formatInt } from "./util";
import { icon } from "./toolbar";
import { keys } from "./platform";

const MAX_MATCHES = 100_000;

interface Match { r: number; c: number } // display coordinates

export class FindPanel {
  private root: HTMLElement;
  private q: HTMLInputElement;
  private rep: HTMLInputElement;
  private repRow: HTMLElement;
  private showRep!: HTMLElement;
  private count: HTMLElement;
  private opts = { caseSensitive: false, whole: false, regex: false, formulas: false };
  private matches: Match[] = [];
  private idx = -1;
  private capped = false;
  private timer = 0;
  private searchedVersion = -1;

  constructor(private grid: Grid, private getDoc: () => Doc | null, private onChange: () => void) {
    this.q = el("input", { class: "find-input", placeholder: "Find in sheet", spellcheck: "false" });
    this.rep = el("input", { class: "find-input", placeholder: "Replace with", spellcheck: "false" });
    this.count = el("span", { class: "count" });
    const iconBtn = (name: Parameters<typeof icon>[0], title: string, flip = false) => {
      const b = el("button", { class: "find-icon", title }, icon(name, 15));
      if (flip) b.style.transform = "scaleY(-1)";
      return b;
    };
    const prev = iconBtn("caret", "Previous (Shift+Enter)", true);
    const next = iconBtn("caret", "Next (Enter)");
    const close = el("button", { class: "find-icon", title: "Close (Esc)" });
    close.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5"/></svg>';
    const toggles = (["caseSensitive", "whole", "regex", "formulas"] as const).map((k) => {
      const label = k === "caseSensitive" ? "Match case" : k === "whole" ? "Whole cell" : k === "regex" ? "Regex" : "In formulas";
      const title = k === "caseSensitive" ? "Match case" : k === "whole" ? "Match entire cell" : k === "regex" ? "Regular expression"
        : "Search the formulas themselves (e.g. A1 in =SUM(A1:A9)), not the answers they show";
      const b = el("button", { class: "find-opt", text: label, title });
      b.addEventListener("click", () => { this.opts[k] = !this.opts[k]; b.classList.toggle("on", this.opts[k]); this.search(); this.q.focus(); });
      return b;
    });
    const repOne = el("button", { class: "find-opt", text: "Replace" });
    const repAll = el("button", { class: "find-opt strong", text: "Replace all" });
    const showRep = el("button", { class: "find-opt", text: "Replace…", title: keys("Show replace (Ctrl+H)") });
    this.showRep = showRep;
    showRep.addEventListener("click", () => this.setReplace(this.repRow.hidden));
    this.repRow = el("div", { class: "row field-row" }, icon("redo", 15), this.rep, repOne, repAll);
    this.repRow.hidden = true;
    this.root = el("div", { class: "panel find" },
      el("div", { class: "row field-row" }, icon("search", 15), this.q, this.count, prev, next, close),
      this.repRow,
      el("div", { class: "row opts" }, ...toggles, el("span", { style: "flex:1" }), showRep),
    );
    this.root.hidden = true;
    document.body.append(this.root);

    this.q.addEventListener("input", () => { clearTimeout(this.timer); this.timer = window.setTimeout(() => this.search(), 120); });
    this.q.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this.step(e.shiftKey ? -1 : 1); }
      else if (e.key === "Escape") { e.preventDefault(); this.close(); }
    });
    this.rep.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this.replaceOne(); }
      else if (e.key === "Escape") { e.preventDefault(); this.close(); }
    });
    prev.addEventListener("click", () => this.step(-1));
    next.addEventListener("click", () => this.step(1));
    close.addEventListener("click", () => this.close());
    repOne.addEventListener("click", () => this.replaceOne());
    repAll.addEventListener("click", () => this.replaceAll());
  }

  get isOpen() { return !this.root.hidden; }

  open(replace: boolean) {
    this.root.hidden = false;
    this.setReplace(replace || !this.repRow.hidden);
    this.q.focus();
    this.q.select();
    if (this.q.value) this.search();
  }

  close() {
    this.root.hidden = true;
    this.grid.matcher = null;
    this.grid.invalidate();
    this.grid.focus();
  }

  private setReplace(on: boolean) {
    this.repRow.hidden = !on;
    this.showRep.classList.toggle("on", on);
  }

  /** Re-run the search if the sheet changed since last time. */
  refresh() {
    const d = this.getDoc();
    if (this.isOpen && d && d.version !== this.searchedVersion) this.search(false);
  }

  private regex(global = false): RegExp | null {
    const q = this.q.value;
    if (!q) return null;
    let src = this.opts.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (this.opts.whole) src = `^(?:${src})$`;
    try {
      return new RegExp(src, (this.opts.caseSensitive ? "" : "i") + (global ? "g" : ""));
    } catch {
      return null;
    }
  }

  private search(jump = true) {
    const d = this.getDoc();
    this.matches = [];
    this.idx = -1;
    this.capped = false;
    const re = this.regex();
    if (!d || !re) {
      this.grid.matcher = null;
      this.count.textContent = this.q.value && !re ? "Bad regex" : "";
      this.grid.invalidate();
      return;
    }
    this.searchedVersion = d.version;
    const rows = d.view ? d.view.length : d.rows.length;
    for (let r = 0; r < rows && !this.capped; r++) {
      const dr = d.dataRow(r);
      const row = d.rows[dr];
      for (let c = 0; c < row.length; c++) {
        const v = row[c];
        if (!v) continue;
        if (re.test(this.searchText(d, dr, c, v))) {
          this.matches.push({ r, c });
          if (this.matches.length >= MAX_MATCHES) { this.capped = true; break; }
        }
      }
    }
    const inFormulas = this.opts.formulas;
    this.grid.matcher = (shown, raw) => {
      const t = inFormulas && raw.charCodeAt(0) === 61 ? raw : shown;
      return t !== "" && re.test(t);
    };
    // Start from the first match at or after the current cell.
    const { ar, ac } = d.sel;
    const i = this.matches.findIndex((m) => m.r > ar || (m.r === ar && m.c >= ac));
    this.idx = this.matches.length ? (i < 0 ? 0 : i) : -1;
    if (jump && this.idx >= 0) this.goto();
    this.updateCount();
    this.grid.invalidate();
  }

  private updateCount() {
    const n = this.matches.length;
    this.count.textContent = !this.q.value ? "" : n === 0 ? "No results" : `${formatInt(this.idx + 1)} of ${formatInt(n)}${this.capped ? "+" : ""}`;
  }

  private goto() {
    const m = this.matches[this.idx];
    if (!m) return;
    this.grid.select({ ar: m.r, ac: m.c, fr: m.r, fc: m.c });
  }

  private step(dir: number) {
    const d = this.getDoc();
    if (d && d.version !== this.searchedVersion) this.search(false);
    if (!this.matches.length) return;
    this.idx = (this.idx + dir + this.matches.length) % this.matches.length;
    this.goto();
    this.updateCount();
  }

  /** What a cell is searched by: its text, or for a formula its answer (or the formula itself, with "In formulas"). */
  private searchText(d: Doc, dr: number, c: number, raw: string): string {
    return raw.charCodeAt(0) === 61 && !this.opts.formulas ? d.display(dr, c) : raw;
  }

  /** Replace can only change what's typed in a cell: a formula's answer isn't. */
  private replaceable(raw: string): boolean {
    return raw.charCodeAt(0) !== 61 || this.opts.formulas;
  }

  private replaceIn(v: string): string {
    const re = this.regex(true)!;
    const rep = this.rep.value;
    return this.opts.regex ? v.replace(re, rep) : v.replace(re, () => rep);
  }

  private replaceOne() {
    const d = this.getDoc();
    if (!d) return;
    if (d.version !== this.searchedVersion) this.search(false);
    const m = this.matches[this.idx];
    if (!m) return;
    const dr = d.dataRow(m.r);
    const raw = d.raw(dr, m.c);
    if (!this.replaceable(raw)) {
      toast("That's a formula's answer, which Replace can't change — turn on “In formulas” to edit the formula");
      this.step(1);
      return;
    }
    const nv = this.replaceIn(raw);
    if (nv !== raw) { d.setCells([{ r: dr, c: m.c, v: nv }], "Replace"); this.onChange(); }
    this.search(false);
    if (this.matches.length) { this.idx = Math.min(this.idx, this.matches.length - 1); this.goto(); this.updateCount(); }
  }

  private replaceAll() {
    const d = this.getDoc();
    if (!d) return;
    this.search(false);
    const cells: { r: number; c: number; v: string }[] = [];
    let skipped = 0;
    for (const m of this.matches) {
      const dr = d.dataRow(m.r);
      const raw = d.raw(dr, m.c);
      if (!this.replaceable(raw)) { skipped++; continue; }
      const nv = this.replaceIn(raw);
      if (nv !== raw) cells.push({ r: dr, c: m.c, v: nv });
    }
    d.setCells(cells, "Replace all");
    this.onChange();
    const done = cells.length ? `Replaced ${formatInt(cells.length)} cell${cells.length === 1 ? "" : "s"}` : "Nothing to replace";
    const left = skipped ? ` · ${formatInt(skipped)} formula answer${skipped === 1 ? "" : "s"} matched but weren't changed (turn on “In formulas” to edit formulas)` : "";
    toast(done + left);
    this.search(false);
  }
}
