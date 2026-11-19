import { CsvParser, Delimiter, LineEnding, delimiterLabel, sniffDelimiter, sniffLineEnding } from "./csv";
import { Doc, selRect } from "./doc";
import { Encoding, decodeBytes, encodeText, encodingLabel } from "./encoding";
import { openFilter } from "./filter";
import { FindPanel } from "./find";
import { Grid } from "./grid";
import {
  FileRef, isTauri, launchFiles, onFileDrop, onOpenFiles, pickFiles, pickSavePath, readFile,
  windowControls, writeFile,
} from "./native";
import { MenuItem, closeMenus, modal, showMenu, toast } from "./ui";
import { basename, cellName, colName, el, formatInt, formatStat, nextFrame, parseNum } from "./util";

type Theme = "system" | "light" | "dark";
const $ = (id: string) => document.getElementById(id)!;

export class App {
  docs: Doc[] = [];
  active: Doc | null = null;
  grid: Grid;
  find: FindPanel;
  private untitled = 0;
  private statsTimer = 0;
  private cellInput = $("cell-input") as HTMLInputElement;

  constructor() {
    this.grid = new Grid({
      onSelection: () => this.onSelection(),
      onChange: () => this.onChange(),
      onContextMenu: (zone, x, y) => this.contextMenu(zone, x, y),
      onColumnMenu: (c, x, y) => this.columnMenu(c, x, y),
      onEditText: (t) => { if (document.activeElement !== this.cellInput) this.cellInput.value = t ?? this.activeRaw(); },
    });
    this.find = new FindPanel(this.grid, () => this.active, () => this.onChange());
    this.bindChrome();
    this.bindKeys();
    this.bindCellBar();
    this.applyTheme();
    this.render();
    this.startup();
  }

  private async startup() {
    onFileDrop(
      (s) => ($("drop-hint").hidden = s !== "over"),
      (files) => this.open(files),
    );
    onOpenFiles((paths) => this.open(paths.map((p) => ({ name: basename(p), path: p }))));
    windowControls.onCloseRequested(() => this.confirmQuit());
    const files = await launchFiles();
    if (files.length) this.open(files.map((p) => ({ name: basename(p), path: p })));
  }

  /* ------------------------------ documents ------------------------------ */

  activate(doc: Doc | null) {
    if (this.grid.editing) this.grid.commitEdit();
    this.active = doc;
    this.grid.setDoc(doc);
    this.render();
    this.onSelection();
    this.grid.focus();
  }

  newDoc() {
    this.untitled++;
    const d = new Doc(this.untitled === 1 ? "Untitled.csv" : `Untitled ${this.untitled}.csv`, null);
    d.freezeHeader = true;
    this.docs.push(d);
    this.activate(d);
  }

  async openDialog() {
    const files = await pickFiles();
    if (files.length) this.open(files);
  }

  async open(refs: FileRef[]) {
    for (const ref of refs) {
      const existing = ref.path ? this.docs.find((d) => d.path && d.path.toLowerCase() === ref.path!.toLowerCase()) : null;
      if (existing) { this.activate(existing); continue; }
      const doc = new Doc(ref.name, ref.path);
      doc.source = ref;
      doc.loading = 0;
      // Replace a pristine empty "Untitled" tab instead of piling up tabs.
      const blank = this.active && !this.active.path && !this.active.dirty && this.active.rows.length === 0 ? this.active : null;
      if (blank) this.docs.splice(this.docs.indexOf(blank), 1, doc);
      else this.docs.push(doc);
      this.activate(doc);
      try {
        await this.load(doc, ref);
        this.addRecent(ref.path);
      } catch (e) {
        toast(String(e instanceof Error ? e.message : e), true);
        this.forget(ref.path);
        this.removeDoc(doc);
      }
    }
  }

  /** Read and parse a file into a doc, with optional overrides. */
  private async load(doc: Doc, ref: FileRef, opts: { delim?: Delimiter; encoding?: Encoding } = {}) {
    doc.loading = 0;
    this.renderLoading();
    const bytes = await readFile(ref);
    let dec = decodeBytes(bytes);
    if (opts.encoding && opts.encoding !== dec.encoding) {
      dec = { text: new TextDecoder(opts.encoding).decode(bytes), encoding: opts.encoding, bom: false };
    }
    doc.encoding = dec.encoding;
    doc.bom = dec.bom;
    const text = dec.text;
    doc.delim = opts.delim ?? sniffDelimiter(text, ref.name);
    doc.eol = sniffLineEnding(text);
    doc.trailingNewline = text.length === 0 || text.endsWith("\n") || text.endsWith("\r");
    const p = new CsvParser(text, doc.delim);
    while (!p.step(40)) {
      doc.loading = p.progress;
      this.renderLoading();
      await nextFrame();
    }
    doc.load(p.rows);
    doc.widths.clear();
    doc.filters.clear();
    doc.view = null;
    doc.loading = null;
    this.grid.autoFitInitial(doc);
    if (this.active === doc) this.grid.setDoc(doc);
    this.render();
    this.onSelection();
  }

  private removeDoc(doc: Doc) {
    const i = this.docs.indexOf(doc);
    if (i < 0) return;
    this.docs.splice(i, 1);
    if (this.active === doc) this.activate(this.docs[Math.min(i, this.docs.length - 1)] ?? null);
    else this.render();
  }

  async closeDoc(doc: Doc): Promise<boolean> {
    if (this.grid.editing && this.active === doc) this.grid.commitEdit();
    if (doc.dirty) {
      if (this.active !== doc) this.activate(doc);
      const choice = await modal(`Save changes to ${doc.name}?`, "Your changes will be lost if you don't save them.", [
        { label: "Cancel", value: "cancel" },
        { label: "Don't save", value: "discard" },
        { label: "Save", value: "save", primary: true },
      ]);
      if (choice === null || choice === "cancel") return false;
      if (choice === "save" && !(await this.save(doc))) return false;
    }
    this.removeDoc(doc);
    return true;
  }

  private async confirmQuit(): Promise<boolean> {
    for (const d of [...this.docs]) {
      if (!d.dirty) continue;
      if (!(await this.closeDoc(d))) return false;
    }
    return true;
  }

  async save(doc: Doc | null = this.active, saveAs = false): Promise<boolean> {
    if (!doc || doc.loading !== null) return false;
    if (this.grid.editing && this.active === doc) this.grid.commitEdit();
    let path = doc.path;
    if (!path || saveAs || !isTauri) {
      path = await pickSavePath(doc.path ?? doc.name);
      if (!path) return false;
      if (/\.tsv$/i.test(path) && doc.delim !== "\t") doc.delim = "\t";
    }
    let asValues = false;
    if (doc.hasFormulas()) {
      let mode = doc.saveFormulasAs;
      if (!mode) {
        mode = await modal(
          "This sheet has formulas",
          "CSV files can't store formulas. Save the calculated values, or keep the formulas as text? (Excel and Google Sheets recalculate formulas saved as text.)",
          [
            { label: "Cancel", value: null },
            { label: "Keep formulas", value: "formulas" as const },
            { label: "Save values", value: "values" as const, primary: true },
          ],
        );
        if (!mode) return false;
        doc.saveFormulasAs = mode;
      }
      asValues = mode === "values";
    }
    try {
      const bytes = encodeText(doc.toText(asValues), doc.encoding, doc.bom);
      await writeFile(path, bytes);
      doc.path = path;
      doc.name = basename(path);
      if (isTauri) doc.source = { name: doc.name, path };
      doc.markSaved();
      this.addRecent(path);
      this.render();
      toast(`Saved ${doc.name}`);
      return true;
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), true);
      return false;
    }
  }

  /* -------------------------------- recent -------------------------------- */

  private recent(): string[] {
    try { return JSON.parse(localStorage.getItem("bento.recent") ?? "[]"); } catch { return []; }
  }

  private addRecent(path: string | null) {
    if (!path) return;
    const list = [path, ...this.recent().filter((p) => p.toLowerCase() !== path.toLowerCase())].slice(0, 8);
    localStorage.setItem("bento.recent", JSON.stringify(list));
  }

  private forget(path: string | null) {
    if (!path) return;
    localStorage.setItem("bento.recent", JSON.stringify(this.recent().filter((p) => p !== path)));
  }

  /* ------------------------------- rendering ------------------------------- */

  render() {
    this.renderTabs();
    this.renderEmpty();
    this.renderLoading();
    this.renderStatus();
    const d = this.active;
    windowControls.setTitle(d ? `${d.name}${d.dirty ? " •" : ""} — Bento` : "Bento");
  }

  private renderTabs() {
    const box = $("tabs");
    box.textContent = "";
    for (const d of this.docs) {
      const closeBtn = el("span", { class: "x", title: "Close (Ctrl+W)" },
        el("span", { class: "dot" }),
        svg('<path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>', 12, "close-glyph"),
      );
      const tab = el("div", { class: "tab" + (d === this.active ? " active" : "") + (d.dirty ? " dirty" : ""), title: d.path ?? d.name },
        el("span", { class: "name", text: d.name }),
        closeBtn,
      );
      tab.addEventListener("pointerdown", (e) => {
        if (e.button === 1) { e.preventDefault(); this.closeDoc(d); }
        else if (e.button === 0 && !closeBtn.contains(e.target as Node)) this.activate(d);
      });
      closeBtn.addEventListener("click", (e) => { e.stopPropagation(); this.closeDoc(d); });
      box.append(tab);
    }
  }

  private renderEmpty() {
    const box = $("empty");
    const show = this.docs.length === 0;
    $("cellbar").style.visibility = show ? "hidden" : "visible";
    box.hidden = !show;
    if (!show) return;
    box.textContent = "";
    const open = el("button", { class: "btn primary" }, "Open a file", el("kbd", { text: "Ctrl+O" }));
    const blank = el("button", { class: "btn" }, "New sheet", el("kbd", { text: "Ctrl+N" }));
    open.addEventListener("click", () => this.openDialog());
    blank.addEventListener("click", () => this.newDoc());
    const recent = this.recent();
    const list = el("div", { class: "recent" });
    for (const p of recent.slice(0, 6)) {
      const b = el("button", {}, el("span", { text: basename(p) }), el("span", { class: "path", text: p }));
      b.addEventListener("click", () => this.open([{ name: basename(p), path: p }]));
      list.append(b);
    }
    box.append(el("div", { class: "welcome" },
      el("div", { class: "mark" }, svg(LOGO, 44)),
      el("h1", { text: "Bento" }),
      el("p", { text: "A calm, quick place for your CSV files." }),
      el("div", { class: "buttons" }, open, blank),
      recent.length ? el("h2", { text: "Recent" }) : null,
      recent.length ? list : null,
      el("div", { class: "hint", text: "Or drop a file anywhere in this window." }),
    ));
  }

  private renderLoading() {
    const d = this.active;
    const bar = $("progress").firstElementChild as HTMLElement;
    const box = $("loading");
    if (d && d.loading !== null) {
      bar.style.width = `${Math.round(d.loading * 100)}%`;
      box.hidden = false;
      box.textContent = `Reading ${d.name}… ${Math.round(d.loading * 100)}%`;
    } else {
      bar.style.width = "0";
      box.hidden = true;
    }
  }

  private renderStatus() {
    const left = $("status-left");
    const right = $("status-right");
    left.textContent = "";
    right.textContent = "";
    const d = this.active;
    if (!d || d.loading !== null) return;
    const total = Math.max(0, d.rows.length - (d.freezeHeader && d.rows.length ? 1 : 0));
    const rowsText = d.view
      ? `${formatInt(Math.max(0, d.view.length - (d.freezeHeader ? 1 : 0)))} of ${formatInt(total)} rows`
      : `${formatInt(total)} ${total === 1 ? "row" : "rows"}`;
    left.append(el("span", { class: "item", text: `${rowsText} · ${formatInt(d.cols)} ${d.cols === 1 ? "column" : "columns"}` }));
    const btn = (text: string, title: string, fn: (b: HTMLElement) => void) => {
      const b = el("button", { class: "item", text, title });
      b.addEventListener("click", () => fn(b));
      left.append(el("span", { class: "sep", text: "·" }), b);
    };
    btn(encodingLabel(d.encoding, d.bom), "Text encoding", (b) => this.encodingMenu(b));
    btn(delimiterLabel(d.delim), "Delimiter", (b) => this.delimiterMenu(b));
    btn(d.eol === "\r\n" ? "CRLF" : "LF", "Line endings", (b) => this.eolMenu(b));
    if (d.filters.size) {
      const b = el("button", { class: "item", text: "Clear filters", title: "Show all rows" });
      b.style.color = "var(--accent-text)";
      b.addEventListener("click", () => { d.clearFilters(); this.afterStructure(); });
      left.append(el("span", { class: "sep", text: "·" }), b);
    }
    this.renderStats();
  }

  private renderStats() {
    clearTimeout(this.statsTimer);
    this.statsTimer = window.setTimeout(() => {
      const right = $("status-right");
      right.textContent = "";
      const d = this.active;
      if (!d || d.loading !== null) return;
      const s = selRect(d.sel);
      const cells = (s.r1 - s.r0 + 1) * (s.c1 - s.c0 + 1);
      if (cells <= 1) return;
      const lastRow = Math.min(s.r1, (d.view ? d.view.length : d.rows.length) - 1);
      let sum = 0, nums = 0, filled = 0;
      if (cells <= 3_000_000) {
        for (let r = s.r0; r <= lastRow; r++) {
          const dr = d.dataRow(r);
          const row = d.rows[dr];
          if (!row) continue;
          for (let c = s.c0; c <= Math.min(s.c1, row.length - 1); c++) {
            const raw = row[c];
            if (!raw) continue;
            filled++;
            if (d.freezeHeader && dr === 0) continue;
            const n = parseNum(raw.charCodeAt(0) === 61 ? d.display(dr, c) : raw);
            if (!Number.isNaN(n)) { sum += n; nums++; }
          }
        }
      }
      const stat = (k: string, v: string) => el("span", { class: "item stat" }, `${k} `, el("b", { text: v }));
      if (nums > 0) {
        right.append(stat("Sum", formatStat(sum)), stat("Avg", formatStat(sum / nums)), stat("Count", formatInt(nums)));
      } else if (cells <= 3_000_000) {
        right.append(stat("Count", formatInt(filled)));
      } else {
        right.append(stat("Cells", formatInt(cells)));
      }
    }, 40);
  }

  private onSelection() {
    const d = this.active;
    if (!d) { $("cell-name").textContent = ""; this.cellInput.value = ""; return; }
    const s = selRect(d.sel);
    const name = (r: number, c: number) => cellName(d.dataRow(r), c);
    $("cell-name").textContent = s.r0 === s.r1 && s.c0 === s.c1
      ? name(d.sel.ar, d.sel.ac)
      : s.r0 === 0 && s.r1 >= this.grid.lastRow() ? (s.c0 === s.c1 ? colName(s.c0) : `${colName(s.c0)}:${colName(s.c1)}`)
      : `${name(s.r0, s.c0)}:${name(s.r1, s.c1)}`;
    if (!this.grid.editing && document.activeElement !== this.cellInput) this.cellInput.value = this.activeRaw();
    this.renderStats();
  }

  private activeRaw(): string {
    const d = this.active;
    return d ? d.raw(d.dataRow(d.sel.ar), d.sel.ac) : "";
  }

  private onChange() {
    this.render();
    this.find.refresh();
    this.grid.invalidate();
  }

  /** After rows/columns/filters change: keep the selection valid and redraw. */
  private afterStructure() {
    const d = this.active;
    if (!d) return;
    this.grid.select(d.sel, false);
    this.onChange();
  }

  /* -------------------------------- theme -------------------------------- */

  private theme(): Theme {
    return (localStorage.getItem("bento.theme") as Theme) || "system";
  }

  private setTheme(t: Theme) {
    localStorage.setItem("bento.theme", t);
    this.applyTheme();
  }

  private applyTheme() {
    const t = this.theme();
    const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    $("theme-btn").innerHTML = dark
      ? '<svg viewBox="0 0 16 16" width="15" height="15"><path d="M13 9.6A5.5 5.5 0 0 1 6.4 3 5.5 5.5 0 1 0 13 9.6Z" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/></svg>'
      : '<svg viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
    this.grid.readColors();
  }

  /* -------------------------------- menus -------------------------------- */

  private appMenu() {
    const d = this.active;
    const btn = $("menu-btn");
    const r = btn.getBoundingClientRect();
    btn.classList.add("open");
    const recent = this.recent().filter((p) => !this.docs.some((x) => x.path === p)).slice(0, 5);
    const items: MenuItem[] = [
      { label: "New sheet", key: "Ctrl+N", action: () => this.newDoc() },
      { label: "Open…", key: "Ctrl+O", action: () => this.openDialog() },
      ...(recent.length ? [{ heading: "Recent" } as MenuItem, ...recent.map((p) => ({ label: basename(p), action: () => this.open([{ name: basename(p), path: p }]) }))] : []),
      "sep",
      { label: "Save", key: "Ctrl+S", disabled: !d, action: () => this.save() },
      { label: "Save as…", key: "Ctrl+Shift+S", disabled: !d, action: () => this.save(d, true) },
      { label: "Close tab", key: "Ctrl+W", disabled: !d, action: () => d && this.closeDoc(d) },
      "sep",
      { label: "Find", key: "Ctrl+F", disabled: !d, action: () => this.find.open(false) },
      { label: "Find and replace", key: "Ctrl+H", disabled: !d, action: () => this.find.open(true) },
      "sep",
      { label: "Freeze header row", checked: !!d?.freezeHeader, disabled: !d, action: () => this.toggleFreeze() },
      { label: "Clear all filters", disabled: !d?.filters.size, action: () => { d!.clearFilters(); this.afterStructure(); } },
      { label: "Unhide all columns", disabled: !d?.hidden.size, action: () => { d!.hidden.clear(); this.onChange(); } },
      "sep",
      { label: "Keyboard shortcuts", key: "F1", action: () => this.shortcuts() },
      { label: "About Bento", action: () => modal("Bento", "Version 0.1.0\nA minimal, fast CSV editor.", [{ label: "Close", value: true, primary: true }]) },
    ];
    showMenu(items, r.left, r.bottom + 4, () => btn.classList.remove("open"));
  }

  private toggleFreeze() {
    const d = this.active;
    if (!d) return;
    d.freezeHeader = !d.freezeHeader;
    d.refreshView();
    d.version++;
    this.grid.setDoc(d);
    this.afterStructure();
  }

  private shortcuts() {
    modal("Keyboard shortcuts", [
      "Type to replace a cell  ·  Enter or F2 to edit",
      "Enter / Tab  commit and move  ·  Alt+Enter  new line",
      "Ctrl+Arrows  jump to edge of data  ·  Shift  extend",
      "Ctrl+C / X / V  copy, cut, paste  ·  Ctrl+D  fill down",
      "Ctrl+Z / Ctrl+Y  undo, redo  ·  Delete  clear",
      "Ctrl+F / Ctrl+H  find, replace  ·  Ctrl+A  select all",
      "Ctrl+S  save  ·  Ctrl+O  open  ·  Ctrl+N  new",
      "Ctrl+Tab  next tab  ·  Ctrl+W  close tab",
      "Formulas start with =, e.g. =SUM(B2:B100)",
    ].join("\n"), [{ label: "Done", value: true, primary: true }]);
  }

  private encodingMenu(anchor: HTMLElement) {
    const d = this.active!;
    const r = anchor.getBoundingClientRect();
    const set = (e: Encoding, bom: boolean) => () => { d.encoding = e; d.bom = bom; d.markDirty(); this.render(); };
    const canReread = !!d.source && !d.dirty;
    const reread = (e: Encoding) => () => this.load(d, d.source!, { encoding: e, delim: d.delim }).catch((err) => toast(String(err), true));
    showMenu([
      { heading: "Save with" },
      { label: "UTF-8", checked: d.encoding === "utf-8" && !d.bom, action: set("utf-8", false) },
      { label: "UTF-8 with BOM (best for Excel)", checked: d.encoding === "utf-8" && d.bom, action: set("utf-8", true) },
      { label: "Windows-1252", checked: d.encoding === "windows-1252", action: set("windows-1252", false) },
      { label: "UTF-16 LE", checked: d.encoding === "utf-16le", action: set("utf-16le", true) },
      ...(canReread ? ["sep" as const, { heading: "Reopen as" } as MenuItem,
        { label: "UTF-8", action: reread("utf-8") }, { label: "Windows-1252", action: reread("windows-1252") }] : []),
    ], r.left, r.top - 4);
  }

  private delimiterMenu(anchor: HTMLElement) {
    const d = this.active!;
    const r = anchor.getBoundingClientRect();
    const all: Delimiter[] = [",", ";", "\t", "|"];
    const canReread = !!d.source && !d.dirty;
    showMenu([
      { heading: "Save with" },
      ...all.map((x) => ({ label: delimiterLabel(x), checked: d.delim === x, action: () => { d.delim = x; d.markDirty(); this.render(); } })),
      ...(canReread ? ["sep" as const, { heading: "Re-read file split by" } as MenuItem,
        ...all.map((x) => ({ label: delimiterLabel(x), action: () => this.load(d, d.source!, { delim: x, encoding: d.encoding }).catch((err) => toast(String(err), true)) }))] : []),
    ], r.left, r.top - 4);
  }

  private eolMenu(anchor: HTMLElement) {
    const d = this.active!;
    const r = anchor.getBoundingClientRect();
    const set = (e: LineEnding) => () => { d.eol = e; d.markDirty(); this.render(); };
    showMenu([
      { heading: "Line endings" },
      { label: "Windows (CRLF)", checked: d.eol === "\r\n", action: set("\r\n") },
      { label: "Unix (LF)", checked: d.eol === "\n", action: set("\n") },
    ], r.left, r.top - 4);
  }

  /** Data rows covered by the selection (filter-aware). */
  private selectedDataRows(): number[] {
    const d = this.active!;
    const s = selRect(d.sel);
    const out: number[] = [];
    for (let r = s.r0; r <= s.r1; r++) out.push(d.dataRow(r));
    return out;
  }

  private rowItems(): MenuItem[] {
    const d = this.active!;
    const s = selRect(d.sel);
    const n = s.r1 - s.r0 + 1;
    const rows = n === 1 ? "row" : `${formatInt(n)} rows`;
    return [
      { label: `Insert ${rows} above`, action: () => { d.insertRows(d.dataRow(s.r0), n); this.afterStructure(); } },
      { label: `Insert ${rows} below`, action: () => {
        d.insertRows(d.dataRow(s.r1) + 1, n);
        this.grid.select({ ar: s.r1 + 1, ac: d.sel.ac, fr: s.r1 + n, fc: d.sel.fc }, false);
        this.afterStructure();
      } },
      { label: `Delete ${rows}`, danger: true, action: () => { d.deleteRows(this.selectedDataRows()); this.afterStructure(); } },
    ];
  }

  private colItems(): MenuItem[] {
    const d = this.active!;
    const s = selRect(d.sel);
    const n = s.c1 - s.c0 + 1;
    const cols = n === 1 ? "column" : `${n} columns`;
    return [
      { label: `Insert ${cols} left`, action: () => { d.insertCols(s.c0, n); this.afterStructure(); } },
      { label: `Insert ${cols} right`, action: () => {
        d.insertCols(s.c1 + 1, n);
        this.grid.select({ ar: d.sel.ar, ac: s.c1 + 1, fr: d.sel.fr, fc: s.c1 + n }, false);
        this.afterStructure();
      } },
      { label: `Delete ${cols}`, danger: true, action: () => { d.deleteCols(s.c0, n); this.afterStructure(); } },
    ];
  }

  private contextMenu(zone: "cell" | "col" | "row" | "corner", x: number, y: number) {
    const d = this.active;
    if (!d || d.loading !== null) return;
    if (zone === "col") { this.columnMenu(d.sel.ac, x, y); return; }
    const clipboard: MenuItem[] = [
      { label: "Cut", key: "Ctrl+X", action: () => this.clipboardWrite(this.grid.copy(true)) },
      { label: "Copy", key: "Ctrl+C", action: () => this.clipboardWrite(this.grid.copy()) },
      { label: "Paste", key: "Ctrl+V", action: () => this.clipboardPaste() },
    ];
    if (zone === "corner") {
      showMenu([
        { label: "Select all", key: "Ctrl+A", action: () => this.grid.selectAll() },
        { label: "Clear all filters", disabled: !d.filters.size, action: () => { d.clearFilters(); this.afterStructure(); } },
        { label: "Unhide all columns", disabled: !d.hidden.size, action: () => { d.hidden.clear(); this.onChange(); } },
      ], x, y);
      return;
    }
    if (zone === "row") {
      showMenu([
        ...clipboard, "sep", ...this.rowItems(), "sep",
        { label: "Freeze header row", checked: d.freezeHeader, action: () => this.toggleFreeze() },
      ], x, y);
      return;
    }
    showMenu([
      ...clipboard, "sep",
      ...this.rowItems().slice(0, 1), ...this.colItems().slice(0, 1), "sep",
      this.rowItems()[2], this.colItems()[2],
      { label: "Clear cells", key: "Delete", action: () => this.grid.clear() },
      "sep",
      { label: "Fill down", key: "Ctrl+D", action: () => this.grid.fillDown() },
    ], x, y);
  }

  private columnMenu(c: number, x: number, y: number) {
    const d = this.active;
    if (!d || d.loading !== null) return;
    const s = selRect(d.sel);
    const hideRange = () => { for (let i = s.c0; i <= s.c1; i++) d.hidden.add(i); this.onChange(); };
    showMenu([
      { label: "Sort A → Z", action: () => { d.sortBy(c, false); this.afterStructure(); } },
      { label: "Sort Z → A", action: () => { d.sortBy(c, true); this.afterStructure(); } },
      "sep",
      { label: d.filters.has(c) ? "Edit filter…" : "Filter…", action: () => openFilter(d, c, x, y, () => this.afterStructure()) },
      ...(d.filters.has(c) ? [{ label: "Remove filter", action: () => { d.setFilter(c, null); this.afterStructure(); } } as MenuItem] : []),
      "sep",
      ...this.colItems(),
      "sep",
      { label: s.c0 === s.c1 ? "Hide column" : "Hide columns", action: hideRange },
      ...(d.hidden.size ? [{ label: "Unhide all columns", action: () => { d.hidden.clear(); this.onChange(); } } as MenuItem] : []),
      { label: "Fit width to content", action: () => { for (let i = s.c0; i <= s.c1; i++) this.grid.autoFit(i); } },
    ], x, y);
  }

  private async clipboardWrite(text: string | null) {
    if (text === null) { toast("That selection is too big to copy", true); return; }
    try { await navigator.clipboard.writeText(text); } catch { toast("Couldn't reach the clipboard — try Ctrl+C", true); }
    this.onChange();
  }

  private async clipboardPaste() {
    try {
      const t = await navigator.clipboard.readText();
      if (t) this.grid.paste(t);
    } catch {
      toast("Use Ctrl+V to paste");
    }
  }

  /* ------------------------------- bindings ------------------------------- */

  private bindChrome() {
    $("menu-btn").addEventListener("click", () => this.appMenu());
    $("new-tab").addEventListener("click", () => this.newDoc());
    $("find-btn").addEventListener("click", () => this.active && (this.find.isOpen ? this.find.close() : this.find.open(false)));
    $("theme-btn").addEventListener("click", () => {
      const r = $("theme-btn").getBoundingClientRect();
      const t = this.theme();
      showMenu([
        { label: "Match Windows", checked: t === "system", action: () => this.setTheme("system") },
        { label: "Light", checked: t === "light", action: () => this.setTheme("light") },
        { label: "Dark", checked: t === "dark", action: () => this.setTheme("dark") },
      ], r.right - 200, r.bottom + 4);
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.applyTheme());
    $("win-min").addEventListener("click", () => windowControls.minimize());
    $("win-max").addEventListener("click", () => windowControls.toggleMaximize());
    $("win-close").addEventListener("click", () => windowControls.close());
    $("titlebar").addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).hasAttribute("data-tauri-drag-region")) windowControls.toggleMaximize();
    });
    if (!isTauri) ($("titlebar").querySelector(".winctl") as HTMLElement).style.display = "none";
  }

  private bindCellBar() {
    const input = this.cellInput;
    input.addEventListener("input", () => {
      if (!this.active) return;
      if (!this.grid.editing) this.grid.startEdit("edit", input.value, false);
      else this.grid.setEditorText(input.value);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); if (this.grid.editing) this.grid.commitEdit(1, 0); else this.grid.focus(); }
      else if (e.key === "Tab") { e.preventDefault(); if (this.grid.editing) this.grid.commitEdit(0, e.shiftKey ? -1 : 1); }
      else if (e.key === "Escape") { e.preventDefault(); if (this.grid.editing) this.grid.cancelEdit(); else this.grid.focus(); input.value = this.activeRaw(); }
    });
    input.addEventListener("blur", () => {
      setTimeout(() => {
        if (this.grid.editing && document.activeElement !== this.grid.editor && document.activeElement !== input) this.grid.commitEdit();
      });
    });
    // Mirror in-cell typing into the bar.
    this.grid.editor.addEventListener("input", () => { input.value = this.grid.editor.value; });
  }

  private bindKeys() {
    window.addEventListener("keydown", (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const d = this.active;
      if (ctrl && k === "n") { e.preventDefault(); this.newDoc(); }
      else if (ctrl && k === "o") { e.preventDefault(); this.openDialog(); }
      else if (ctrl && k === "s") { e.preventDefault(); this.save(d, e.shiftKey); }
      else if (ctrl && k === "w") { e.preventDefault(); if (d) this.closeDoc(d); }
      else if (ctrl && k === "f") { e.preventDefault(); if (d) this.find.open(false); }
      else if (ctrl && k === "h") { e.preventDefault(); if (d) this.find.open(true); }
      else if (ctrl && e.key === "Tab") {
        e.preventDefault();
        if (this.docs.length > 1 && d) {
          const i = this.docs.indexOf(d);
          this.activate(this.docs[(i + (e.shiftKey ? -1 : 1) + this.docs.length) % this.docs.length]);
        }
      }
      else if (e.key === "F1") { e.preventDefault(); this.shortcuts(); }
      else if (e.key === "Escape" && this.find.isOpen && document.activeElement === this.grid.sink) { this.find.close(); }
      else if (d && document.activeElement === document.body && !ctrl && !e.altKey) {
        // Focus drifted (e.g. after clicking the title bar): give keys back to the grid.
        this.grid.focus();
      }
    });
    // Clicking non-input chrome shouldn't strand keyboard focus.
    window.addEventListener("pointerup", () => {
      setTimeout(() => {
        const a = document.activeElement;
        if (this.active && (!a || a === document.body || a.tagName === "BUTTON") && !document.querySelector(".scrim,.menu,.filter")) this.grid.focus();
      });
    });
    window.addEventListener("blur", () => closeMenus());
  }
}

const LOGO = `<rect x="2" y="2" width="20" height="20" rx="5" fill="var(--accent)"/><rect x="5.2" y="5.2" width="6.2" height="13.6" rx="1.6" fill="var(--on-accent)"/><rect x="12.6" y="5.2" width="6.2" height="6.2" rx="1.6" fill="var(--on-accent)"/><rect x="12.6" y="12.6" width="6.2" height="6.2" rx="1.6" fill="var(--on-accent)" opacity=".55"/>`;

function svg(inner: string, size: number, cls = ""): SVGElement {
  const vb = size === 12 ? "0 0 12 12" : "0 0 24 24";
  const wrap = document.createElement("span");
  wrap.innerHTML = `<svg viewBox="${vb}" width="${size}" height="${size}" class="${cls}" fill="none">${inner}</svg>`;
  return wrap.firstElementChild as SVGElement;
}
