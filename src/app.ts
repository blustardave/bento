import { CsvParser, Delimiter, LineEnding, sniffDelimiter, sniffLineEnding } from "./csv";
import { Book, Doc, allRects, selRect } from "./doc";
import { Encoding, decodeBytes, encodeText } from "./encoding";
import { openFilter } from "./filter";
import { FindPanel } from "./find";
import { Grid } from "./grid";
import { decodeBento, encodeBento, isBentoPath, looksLikeBento, sheetFromData, sheetToData } from "./bento";
import {
  FileRef, isTauri, launchFiles, onFileDrop, onOpenFiles, pickFiles, pickSavePath, readFile,
  windowControls, writeFile,
} from "./native";
import { MenuItem, closeMenus, modal, showMenu, toast } from "./ui";
import { ToolButton, divider, grow, toolButton } from "./toolbar";
import { ZOOMS } from "./grid";
import { FormatBar } from "./formatbar";
import { CURRENCIES, Style, detectCurrency } from "./format";
import { appVersion, initUpdater } from "./updater";
import { basename, cellName, colName, el, formatInt, formatStat, nextFrame, parseNum } from "./util";

type Theme = "system" | "light" | "dusk" | "dark";
const $ = (id: string) => document.getElementById(id)!;

export class App {
  docs: Doc[] = [];
  active: Doc | null = null;
  grid: Grid;
  find: FindPanel;
  private untitled = 0;
  private statsTimer = 0;
  private cellInput = $("cell-input") as HTMLInputElement;
  private tools: Record<string, ToolButton> = {};
  private formatBar = new FormatBar({
    active: () => {
      const d = this.active;
      if (!d) return null;
      const r = d.dataRow(d.sel.ar);
      return { style: d.style(r, d.sel.ac), header: d.freezeHeader && r === 0, shown: d.display(r, d.sel.ac) };
    },
    apply: (patch, label) => this.applyFormat(patch, label),
    theme: () => (document.documentElement.dataset.theme === "light" ? "light" : "dark"),
    toggleMerge: () => this.toggleMerge(),
    selectionMerged: () => {
      const d = this.active;
      if (!d || !d.merges.length) return false;
      const s = selRect(d.sel);
      return this.grid.visibleMerges().some((m) => m.r0 <= s.r1 && s.r0 <= m.r1 && m.c0 <= s.c1 && s.c0 <= m.c1);
    },
  });
  private zoomInput!: HTMLInputElement;

  constructor() {
    this.grid = new Grid({
      onSelection: () => this.onSelection(),
      onChange: () => this.onChange(),
      onContextMenu: (zone, x, y) => this.contextMenu(zone, x, y),
      onColumnMenu: (c, x, y) => this.columnMenu(c, x, y),
      onNotice: (t) => toast(t),
      onEditText: (t) => { if (document.activeElement !== this.cellInput) this.cellInput.value = t ?? this.activeRaw(); },
    });
    this.find = new FindPanel(this.grid, () => this.active, () => this.onChange());
    this.buildToolbar();
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
    const check = $("check-btn");
    const updater = initUpdater((version, install) => {
      const btn = $("update-btn");
      check.hidden = true;
      btn.hidden = false;
      btn.title = `Bento ${version} is ready to install`;
      btn.onclick = async () => {
        // Give unsaved work a chance to be saved first.
        if (!(await this.confirmQuit())) return;
        btn.textContent = "Updating…";
        try { await install(); } catch (e) { toast(`Update failed: ${e}`, true); btn.textContent = "Update ready · Restart"; }
      };
    });
    if (!isTauri) check.hidden = true;
    check.addEventListener("click", async () => {
      if (check.classList.contains("spinning")) return;
      check.classList.add("spinning");
      const started = Date.now();
      const result = await updater.checkNow();
      // Spin for at least a moment so the click visibly did something.
      await new Promise((r) => setTimeout(r, Math.max(0, 600 - (Date.now() - started))));
      check.classList.remove("spinning");
      if (result === "none") toast(`You're up to date (version ${await appVersion()})`);
      else if (result === "error") toast("Couldn't check for updates — are you online?", true);
    });
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

  /** Every sheet asks the grid to measure tall rows (wrapped text, big fonts). */
  private makeDoc(name: string, path: string | null, book?: Book): Doc {
    const d = new Doc(name, path, book);
    d.measureRow = (r) => this.grid.measureRow(d, r);
    return d;
  }

  /** A new, empty sheet in an existing file (not yet added to it). */
  private makeSheet(book: Book, sheetName: string): Doc {
    const d = this.makeDoc(book.name, book.path, book);
    d.sheetName = sheetName;
    const base = book.sheets[0];
    if (base) { d.delim = base.delim; d.eol = base.eol; d.encoding = base.encoding; d.bom = base.bom; }
    return d;
  }

  newDoc() {
    this.untitled++;
    const d = this.makeDoc(this.untitled === 1 ? "Untitled.bento" : `Untitled ${this.untitled}.bento`, null);
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
      const doc = this.makeDoc(ref.name, ref.path);
      doc.source = ref;
      doc.loading = 0;
      // Replace a pristine empty "Untitled" tab instead of piling up tabs.
      const blank = this.active && !this.active.path && !this.active.book.dirty && this.active.book.sheets.length === 1 && this.active.rows.length === 0 ? this.active : null;
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
    if (isBentoPath(ref.name) || looksLikeBento(bytes)) {
      const book = doc.book;
      await decodeBento(bytes, book, (name) => this.makeSheet(book, name));
      for (const sh of book.sheets) {
        sh.loading = null;
        if (!sh.widths.size) this.grid.autoFitInitial(sh);
        sh.remeasureAll();
      }
      book.markSaved();
      // Show the sheet that was open when the file was saved.
      const shown = book.sheet;
      const i = this.docs.indexOf(doc);
      if (shown !== doc && i >= 0) this.docs[i] = shown;
      if (this.active === doc) this.activate(shown);
      this.render();
      this.onSelection();
      return;
    }
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
    doc.remeasureAll(); // rows with line breaks grow to fit
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
    if (doc.book.dirty) {
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
      if (!d.book.dirty) continue;
      if (!(await this.closeDoc(d))) return false;
    }
    return true;
  }

  /** Save as a .bento sheet (keeps formatting, formulas, widths…). */
  async save(doc: Doc | null = this.active, saveAs = false): Promise<boolean> {
    if (!doc || doc.loading !== null) return false;
    if (this.grid.editing && this.active === doc) this.grid.commitEdit();
    let path = doc.path;
    if (!path || !isBentoPath(path) || saveAs || !isTauri) {
      // A CSV you opened gets a .bento next to it; the CSV is left alone.
      const suggested = (doc.path ?? doc.name).replace(/\.[^.\\/]+$/, "") + ".bento";
      path = await pickSavePath(suggested, "bento");
      if (!path) return false;
      if (!isBentoPath(path)) path += ".bento";
    }
    try {
      await writeFile(path, await encodeBento(doc.book));
      doc.path = path;
      doc.name = basename(path);
      if (isTauri) doc.source = { name: doc.name, path };
      doc.book.markSaved();
      this.addRecent(path);
      this.render();
      toast(`Saved ${doc.name}`);
      return true;
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), true);
      return false;
    }
  }

  /**
   * Write a plain CSV copy of the current sheet. The options (delimiter,
   * encoding, line endings, formulas) are chosen in a small dialog and
   * remembered with the file.
   */
  async exportCsv(doc: Doc | null = this.active): Promise<boolean> {
    if (!doc || doc.loading !== null) return false;
    if (this.grid.editing && this.active === doc) this.grid.commitEdit();
    const opts = await this.csvDialog(doc, "export");
    if (!opts) return false;
    doc.delim = opts.delim; doc.encoding = opts.encoding; doc.bom = opts.bom; doc.eol = opts.eol;
    if (opts.formulas) doc.saveFormulasAs = opts.formulas;
    const base = (doc.path ?? doc.name).replace(/\.[^.\\/]+$/, "");
    const sheetPart = doc.book.sheets.length > 1 ? ` - ${doc.sheetName}` : "";
    let path = await pickSavePath(base + sheetPart + (doc.delim === "\t" ? ".tsv" : ".csv"), "csv");
    if (!path) return false;
    if (!/\.(csv|tsv|txt)$/i.test(path)) path += ".csv";
    try {
      const text = doc.toText(doc.saveFormulasAs !== "formulas");
      await writeFile(path, encodeText(text, doc.encoding, doc.bom));
      toast(`Exported ${basename(path)}${doc.hasFormatting() ? " (formatting isn't kept in CSV)" : ""}`);
      return true;
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), true);
      return false;
    }
  }

  /** Pick CSV settings: for exporting, or for re-reading a CSV that was split wrongly. */
  private csvDialog(doc: Doc, mode: "export" | "reopen"): Promise<{ delim: Delimiter; encoding: Encoding; bom: boolean; eol: LineEnding; formulas?: "values" | "formulas" } | null> {
    closeMenus();
    return new Promise((resolve) => {
      const select = (label: string, options: [string, string][], value: string) => {
        const sel = el("select", { class: "field" });
        for (const [v, t] of options) sel.append(el("option", { value: v, text: t }));
        sel.value = value;
        return { row: el("label", { class: "pref" }, el("span", { text: label }), sel), sel };
      };
      const delim = select("Separator", [[",", "Comma ( , )"], [";", "Semicolon ( ; )"], ["\t", "Tab"], ["|", "Pipe ( | )"]], doc.delim);
      const enc = select("Encoding", [["utf-8", "UTF-8"], ["utf-8-bom", "UTF-8 with BOM (best for Excel)"], ["windows-1252", "Windows-1252"], ["utf-16le", "UTF-16 LE"]],
        doc.encoding === "utf-8" && doc.bom ? "utf-8-bom" : doc.encoding);
      const eol = select("Line endings", [["\r\n", "Windows (CRLF)"], ["\n", "Mac / Linux (LF)"]], doc.eol);
      const hasF = mode === "export" && doc.hasFormulas();
      const formulas = select("Formulas", [["values", "Export the calculated values"], ["formulas", "Keep formulas as text"]], doc.saveFormulasAs ?? "values");
      const ok = el("button", { class: "btn primary", text: mode === "export" ? "Export…" : "Reopen" });
      const cancel = el("button", { class: "btn", text: "Cancel" });
      const box = el("div", { class: "modal prefs", role: "dialog" },
        el("h3", { text: mode === "export" ? "Export as CSV" : "Reopen CSV" }),
        delim.row, enc.row,
        mode === "export" ? eol.row : null,
        hasF ? formulas.row : null,
        el("p", { class: "hint", text: mode === "export"
          ? (doc.book.sheets.length > 1 ? `Exports the "${doc.sheetName}" sheet. ` : "") + "Formatting isn't kept in CSV."
          : "Reads the file again with these settings." }),
        el("div", { class: "foot" }, cancel, ok),
      );
      const scrim = el("div", { class: "scrim" }, box);
      const done = (v: Parameters<typeof resolve>[0]) => { scrim.remove(); window.removeEventListener("keydown", onKey, true); this.grid.focus(); resolve(v); };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(null); }
        else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); ok.click(); }
      };
      ok.addEventListener("click", () => {
        const e = enc.sel.value;
        done({
          delim: delim.sel.value as Delimiter,
          encoding: (e === "utf-8-bom" ? "utf-8" : e) as Encoding,
          bom: e === "utf-8-bom" || e === "utf-16le",
          eol: eol.sel.value as LineEnding,
          formulas: hasF ? formulas.sel.value as "values" | "formulas" : undefined,
        });
      });
      cancel.addEventListener("click", () => done(null));
      scrim.addEventListener("pointerdown", (e) => { if (e.target === scrim) done(null); });
      window.addEventListener("keydown", onKey, true);
      document.body.append(scrim);
      ok.focus();
    });
  }

  /** Re-read a CSV that came in with the wrong separator or encoding. */
  private async reopenCsv() {
    const d = this.active;
    if (!d || !d.source || isBentoPath(d.source.name)) return;
    if (d.book.dirty) { toast("Save or undo your changes before reopening the file"); return; }
    const opts = await this.csvDialog(d, "reopen");
    if (!opts) return;
    this.load(d, d.source, { delim: opts.delim, encoding: opts.encoding }).catch((err) => toast(String(err), true));
  }

  /* ------------------------------- sheets ------------------------------- */

  private showSheet(doc: Doc) {
    const book = doc.book;
    const i = this.docs.indexOf(this.active!);
    book.current = book.sheets.indexOf(doc);
    if (i >= 0 && this.active?.book === book) this.docs[i] = doc;
    this.activate(doc);
  }

  private addSheet() {
    const d = this.active;
    if (!d) return;
    const book = d.book;
    const sheet = this.makeSheet(book, book.freshName());
    book.sheets.splice(book.current + 1, 0, sheet);
    book.structureDirty = true;
    this.showSheet(sheet);
  }

  private duplicateSheet(doc: Doc) {
    const book = doc.book;
    const copy = this.makeSheet(book, "");
    sheetFromData(copy, sheetToData(doc));
    copy.sheetName = book.freshName(`${doc.sheetName} copy`.replace(/\d+$/, "") + " ");
    copy.remeasureAll();
    book.sheets.splice(book.sheets.indexOf(doc) + 1, 0, copy);
    book.structureDirty = true;
    this.showSheet(copy);
  }

  private async deleteSheet(doc: Doc) {
    const book = doc.book;
    if (book.sheets.length < 2) { toast("A file needs at least one sheet"); return; }
    if (doc.rows.length) {
      const ok = await modal(`Delete "${doc.sheetName}"?`, "This removes the sheet and everything on it. You can't undo this.", [
        { label: "Cancel", value: false },
        { label: "Delete", value: true, primary: true },
      ]);
      if (!ok) return;
    }
    const i = book.sheets.indexOf(doc);
    book.sheets.splice(i, 1);
    book.structureDirty = true;
    const next = book.sheets[Math.min(i, book.sheets.length - 1)];
    if (this.active === doc) this.showSheet(next);
    else this.render();
  }

  private moveSheet(doc: Doc, dir: -1 | 1) {
    const book = doc.book;
    const i = book.sheets.indexOf(doc), j = i + dir;
    if (j < 0 || j >= book.sheets.length) return;
    [book.sheets[i], book.sheets[j]] = [book.sheets[j], book.sheets[i]];
    book.current = book.sheets.indexOf(this.active!);
    book.structureDirty = true;
    this.render();
  }

  /** Rename in place: the tab turns into a little text box. */
  private renameSheet(doc: Doc) {
    const tab = document.querySelector<HTMLElement>(`.sheet-tab[data-sheet="${doc.book.sheets.indexOf(doc)}"]`);
    if (!tab) return;
    const input = el("input", { class: "sheet-rename", value: doc.sheetName, spellcheck: "false" });
    tab.replaceWith(input);
    input.focus();
    input.select();
    let finished = false;
    const finish = (save: boolean) => {
      if (finished) return;
      finished = true;
      const v = input.value.trim();
      if (save && v && v !== doc.sheetName) {
        if (doc.book.sheets.some((s) => s !== doc && s.sheetName.toLowerCase() === v.toLowerCase())) toast(`There's already a sheet called "${v}"`);
        else { doc.sheetName = v; doc.book.structureDirty = true; }
      }
      this.render();
      this.grid.focus();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      // preventDefault matters: focus returns to the grid during this key press,
      // and the Enter must not carry over into a cell.
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  }

  private sheetMenu(doc: Doc, x: number, y: number) {
    const book = doc.book;
    const i = book.sheets.indexOf(doc);
    showMenu([
      { label: "Rename", action: () => this.renameSheet(doc) },
      { label: "Duplicate", action: () => this.duplicateSheet(doc) },
      { label: "Move left", disabled: i === 0, action: () => this.moveSheet(doc, -1) },
      { label: "Move right", disabled: i === book.sheets.length - 1, action: () => this.moveSheet(doc, 1) },
      "sep",
      { label: "Delete", danger: true, disabled: book.sheets.length < 2, action: () => this.deleteSheet(doc) },
    ], x, y - 4, undefined, "up");
  }

  private renderSheetTabs(box: HTMLElement) {
    const d = this.active!;
    const book = d.book;
    const add = el("button", { class: "sheet-btn", title: "Add sheet" });
    add.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 3.5v9M3.5 8h9"/></svg>';
    add.addEventListener("click", () => this.addSheet());
    const all = el("button", { class: "sheet-btn", title: "All sheets" });
    all.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M3 4.5h10M3 8h10M3 11.5h10"/></svg>';
    all.addEventListener("click", () => {
      const r = all.getBoundingClientRect();
      showMenu(book.sheets.map((s) => ({ label: s.sheetName, checked: s === d, action: () => this.showSheet(s) })), r.left, r.top - 4, undefined, "up");
    });
    const tabs = el("div", { class: "sheet-tabs" });
    book.sheets.forEach((s, i) => {
      const caret = el("span", { class: "caret" });
      caret.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M5.5 6.75 8 9.25l2.5-2.5"/></svg>';
      const tab = el("button", { class: "sheet-tab" + (s === d ? " active" : ""), "data-sheet": String(i), title: s.sheetName },
        el("span", { class: "label", text: s.sheetName }), s === d ? caret : null);
      tab.addEventListener("click", (e) => {
        if (s !== d) this.showSheet(s);
        else if (caret.contains(e.target as Node)) { const r = tab.getBoundingClientRect(); this.sheetMenu(s, r.left, r.top); }
      });
      tab.addEventListener("dblclick", () => this.renameSheet(s));
      tab.addEventListener("contextmenu", (e) => { e.preventDefault(); this.sheetMenu(s, e.clientX, e.clientY); });
      tabs.append(tab);
    });
    box.append(add, all, tabs);
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
    windowControls.setTitle(d ? `${d.name}${d.book.dirty ? " •" : ""} — Bento` : "Bento");
    this.refreshToolbar();
  }

  private renderTabs() {
    const box = $("tabs");
    box.textContent = "";
    for (const d of this.docs) {
      const closeBtn = el("span", { class: "x", title: "Close (Ctrl+W)" },
        el("span", { class: "dot" }),
        svg('<path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>', 12, "close-glyph"),
      );
      const tab = el("div", { class: "tab" + (d === this.active ? " active" : "") + (d.book.dirty ? " dirty" : ""), title: d.path ?? d.name },
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
    $("toolbar").style.visibility = show ? "hidden" : "visible";
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
      el("div", { class: "buttons" }, open, blank),
      el("div", { class: "hint", text: "Or drop a file anywhere in this window." }),
      recent.length ? el("h2", { text: "Recent" }) : null,
      recent.length ? list : null,
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
    const dims = $("status-dims");
    left.textContent = "";
    dims.textContent = "";
    const d = this.active;
    if (!d || d.loading !== null) { $("status-stats").textContent = ""; return; }
    this.renderSheetTabs(left);
    if (d.filters.size) {
      const b = el("button", { class: "item accent", text: "Clear filters", title: "Show all rows" });
      b.addEventListener("click", () => { d.clearFilters(); this.afterStructure(); });
      dims.append(b);
    }
    const header = d.freezeHeader && d.rows.length ? 1 : 0;
    const total = Math.max(0, d.rows.length - header);
    const rowsText = d.view
      ? `${formatInt(Math.max(0, d.view.length - header))} of ${formatInt(total)} rows`
      : `${formatInt(total)} ${total === 1 ? "row" : "rows"}`;
    dims.append(el("span", { class: "item", text: `${rowsText} · ${formatInt(d.cols)} ${d.cols === 1 ? "column" : "columns"}` }));
    this.renderStats();
  }

  private renderStats() {
    clearTimeout(this.statsTimer);
    this.statsTimer = window.setTimeout(() => {
      const right = $("status-stats");
      right.textContent = "";
      const d = this.active;
      if (!d || d.loading !== null) return;
      const rects = allRects(d.sel);
      const cells = rects.reduce((n, s) => n + (s.r1 - s.r0 + 1) * (s.c1 - s.c0 + 1), 0);
      if (cells <= 1) return;
      const dataEnd = (d.view ? d.view.length : d.rows.length) - 1;
      let sum = 0, nums = 0, filled = 0;
      if (cells <= 3_000_000) for (const s of rects) {
        const lastRow = Math.min(s.r1, dataEnd);
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
      : this.grid.isWholeCols(s) ? (s.c0 === s.c1 ? colName(s.c0) : `${colName(s.c0)}:${colName(s.c1)}`)
      : this.grid.isWholeRows(s) ? (s.r0 === s.r1 ? `${d.dataRow(s.r0) + 1}` : `${d.dataRow(s.r0) + 1}:${d.dataRow(s.r1) + 1}`)
      : `${name(s.r0, s.c0)}:${name(s.r1, s.c1)}`;
    if (!this.grid.editing && document.activeElement !== this.cellInput) this.cellInput.value = this.activeRaw();
    this.renderStats();
    this.refreshToolbar();
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
    document.documentElement.dataset.theme = t === "dusk" ? "dusk" : dark ? "dark" : "light";
    document.querySelectorAll<HTMLElement>("#theme-toggle button").forEach((b) => {
      const on = b.dataset.themeOpt === t;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    });
    windowControls.setBackground(getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
    this.grid.readColors();
  }

  /* -------------------------------- zoom -------------------------------- */

  private setZoom(z: number) {
    z = Math.min(4, Math.max(0.25, Math.round(z * 100) / 100));
    localStorage.setItem("bento.zoom", String(z));
    this.grid.setZoom(z);
    this.refreshToolbar();
  }

  private stepZoom(dir: 1 | -1) {
    const z = this.grid.zoom;
    const next = dir > 0 ? ZOOMS.find((v) => v > z + 0.001) : [...ZOOMS].reverse().find((v) => v < z - 0.001);
    if (next) this.setZoom(next);
  }

  /* ------------------------------- toolbar ------------------------------- */

  private buildToolbar() {
    const bar = $("toolbar");
    const t = (key: string, b: ToolButton) => { this.tools[key] = b; return b.el; };
    const withDoc = (fn: (d: Doc) => void) => () => { const d = this.active; if (d && d.loading === null) fn(d); };
    const f = this.formatBar.build();

    // Zoom: pick a level or type your own (e.g. 135).
    this.zoomInput = el("input", { class: "zoom-input", value: "100%", title: "Zoom (Ctrl+= / Ctrl+-)", spellcheck: "false" });
    const zoomCaret = toolButton({ icon: "caret", title: "Zoom levels", onClick: () => openZoomMenu() });
    zoomCaret.el.classList.add("caret-btn");
    const zoomBox = el("div", { class: "combo" }, this.zoomInput, zoomCaret.el);
    const openZoomMenu = () => {
      const r = zoomBox.getBoundingClientRect();
      zoomBox.classList.add("open");
      showMenu(ZOOMS.map((z) => ({ label: `${Math.round(z * 100)}%`, checked: Math.abs(this.grid.zoom - z) < 0.001, action: () => this.setZoom(z) })),
        r.left, r.bottom + 4, () => zoomBox.classList.remove("open"));
    };
    this.zoomInput.addEventListener("click", () => { this.zoomInput.select(); openZoomMenu(); });
    this.zoomInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        closeMenus();
        const v = parseFloat(this.zoomInput.value);
        if (v > 0) this.setZoom(v / 100);
        this.zoomInput.blur();
        this.grid.focus();
      } else if (e.key === "Escape") { closeMenus(); this.zoomInput.blur(); this.grid.focus(); }
    });
    this.zoomInput.addEventListener("input", () => closeMenus());
    this.zoomInput.addEventListener("blur", () => this.refreshToolbar());

    bar.append(
      t("undo", toolButton({ icon: "undo", title: "Undo (Ctrl+Z)", onClick: withDoc((d) => this.grid.applyUndo(d.undo())) })),
      t("redo", toolButton({ icon: "redo", title: "Redo (Ctrl+Y)", onClick: withDoc((d) => this.grid.applyUndo(d.redo())) })),
      zoomBox,
      divider(), ...f.numbers,
      divider(), ...f.font,
      divider(), ...f.size,
      divider(), ...f.text,
      divider(), ...f.fill,
      divider(), ...f.align,
      divider(),
      t("link", toolButton({ icon: "link", title: "Insert link (coming soon)", onClick: () => {} })),
      t("filter", toolButton({ icon: "filter", title: "Filter column", onClick: (b) => withDoc((d) => {
        const r = b.getBoundingClientRect();
        openFilter(d, d.sel.ac, r.left, r.bottom + 4, () => this.afterStructure());
      })() })),
      t("sum", toolButton({ icon: "sum", caret: true, title: "Functions", onClick: (b) => {
        if (!this.active) return;
        const r = b.getBoundingClientRect();
        b.classList.add("open");
        showMenu(["SUM", "AVERAGE", "COUNT", "MIN", "MAX"].map((fn) => ({ label: fn[0] + fn.slice(1).toLowerCase(), key: fn, action: () => this.autoSum(fn) })),
          r.left, r.bottom + 4, () => b.classList.remove("open"));
      } })),
      grow(),
      t("find", toolButton({ icon: "search", title: "Find and replace (Ctrl+F)", onClick: withDoc(() => (this.find.isOpen ? this.find.close() : this.find.open(false))) })),
    );
    const z = Number(localStorage.getItem("bento.zoom"));
    if (z) this.grid.setZoom(z);
  }

  /** Merge the selection, or unmerge if it already contains merged cells. */
  private toggleMerge() {
    const d = this.active;
    if (!d || d.loading !== null) return;
    if (this.grid.editing) this.grid.commitEdit();
    const s = selRect(d.sel);
    const lo = d.dataRow(s.r0), hi = d.dataRow(s.r1);
    const rect = { r0: lo, c0: s.c0, r1: hi, c1: s.c1 };
    if (this.formatBar && this.grid.visibleMerges().some((m) => m.r0 <= s.r1 && s.r0 <= m.r1 && m.c0 <= s.c1 && s.c0 <= m.c1)) {
      d.unmerge(rect);
    } else {
      if (s.r0 === s.r1 && s.c0 === s.c1) { toast("Select two or more cells to merge"); return; }
      if (d.view) { toast("Clear filters before merging cells"); return; }
      if ((s.r0 < d.frozenRows && s.r1 >= d.frozenRows) || (s.c0 < d.frozenCols && s.c1 >= d.frozenCols)) { toast("Can't merge across frozen rows or columns"); return; }
      if ((s.r1 - s.r0 + 1) * (s.c1 - s.c0 + 1) > 100_000) { toast("That's too many cells to merge"); return; }
      d.merge(rect);
    }
    this.grid.select({ ar: s.r0, ac: s.c0, fr: s.r1, fc: s.c1 }, false);
    this.onChange();
  }

  /** Sort, unless merged cells make it impossible. */
  private sort(d: Doc, col: number, desc: boolean) {
    if (!d.sortBy(col, desc)) { toast("Can't sort while cells are merged across rows — unmerge them first"); return; }
    this.afterStructure();
  }

  private refreshToolbar() {
    const d = this.active;
    const ready = !!d && d.loading === null;
    for (const b of Object.values(this.tools)) b.set({ disabled: !ready });
    if (document.activeElement !== this.zoomInput) this.zoomInput.value = `${Math.round(this.grid.zoom * 100)}%`;
    if (!ready || !d) { this.formatBar.refresh(false); return; }
    this.tools.undo.set({ disabled: !d.canUndo });
    this.tools.redo.set({ disabled: !d.canRedo });
    this.tools.filter.set({ on: d.filters.has(d.sel.ac) });
    this.formatBar.refresh(ready);
  }

  /** Apply a formatting change to every selected cell. */
  applyFormat(patch: (s: Style) => Style, label: string) {
    const d = this.active;
    if (!d || d.loading !== null) return;
    const rects = allRects(d.sel);
    const count = rects.reduce((n, s) => n + (s.r1 - s.r0 + 1) * (s.c1 - s.c0 + 1), 0);
    if (count > 5_000_000) { toast("That selection is too big to format in one go", true); return; }
    const cells: { r: number; c: number }[] = [];
    for (const s of rects) for (let r = s.r0; r <= s.r1; r++) {
      if (d.view && r >= d.view.length) break;
      const dr = d.dataRow(r);
      for (let c = s.c0; c <= s.c1; c++) cells.push({ r: dr, c });
    }
    d.format(cells, patch, label);
    this.onChange();
    this.onSelection();
  }

  /**
   * Σ: with a range of cells selected, put the formula in the cell just
   * below it; with one cell, start a formula there for you to finish.
   */
  private autoSum(fn: string) {
    const d = this.active;
    if (!d) return;
    if (this.grid.editing) this.grid.commitEdit();
    const s = selRect(d.sel);
    if (s.r0 === s.r1 && s.c0 === s.c1) {
      this.grid.startEdit("edit", `=${fn}(`);
      return;
    }
    const cells: { r: number; c: number; v: string }[] = [];
    const below = s.r1 + 1;
    const top = d.dataRow(s.r0) + 1;
    const bottom = d.dataRow(s.r1) + 1;
    for (let c = s.c0; c <= s.c1; c++) {
      cells.push({ r: d.dataRow(below), c, v: `=${fn}(${colName(c)}${top}:${colName(c)}${bottom})` });
    }
    d.setCells(cells, fn);
    this.grid.select({ ar: below, ac: s.c0, fr: below, fc: s.c1 });
    this.onChange();
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
      { label: "Export as CSV…", key: "Ctrl+E", disabled: !d, action: () => this.exportCsv(d) },
      ...(d?.source && !isBentoPath(d.source.name) ? [{ label: "Reopen CSV with other settings…", disabled: d.book.dirty, action: () => this.reopenCsv() } as MenuItem] : []),
      { label: "Close tab", key: "Ctrl+W", disabled: !d, action: () => d && this.closeDoc(d) },
      "sep",
      { label: "Find", key: "Ctrl+F", disabled: !d, action: () => this.find.open(false) },
      { label: "Find and replace", key: "Ctrl+H", disabled: !d, action: () => this.find.open(true) },
      "sep",
      { label: "Unfreeze rows and columns", disabled: !d || (!d.frozenRows && !d.frozenCols), action: () => { d!.setFrozen(0, 0); this.afterFreeze(); } },
      { label: "Clear all filters", disabled: !d?.filters.size, action: () => { d!.clearFilters(); this.afterStructure(); } },
      { label: "Unhide all columns", disabled: !d?.hidden.size, action: () => { d!.hidden.clear(); this.onChange(); } },
      "sep",
      { label: "Preferences…", key: "Ctrl+,", action: () => this.preferences() },
      { label: "Keyboard shortcuts", key: "F1", action: () => this.shortcuts() },
      { label: "About Bento", action: async () => modal("Bento", `Version ${await appVersion()}\nA minimal, fast CSV editor.\nUpdates install automatically.`, [{ label: "Close", value: true, primary: true }]) },
    ];
    showMenu(items, r.left, r.bottom + 4, () => btn.classList.remove("open"));
  }

  private afterFreeze() {
    const d = this.active;
    if (!d) return;
    this.grid.setDoc(d);
    this.afterStructure();
  }

  private preferences() {
    closeMenus();
    const sel = el("select", { class: "field" });
    const detected = detectCurrency().trim();
    sel.append(el("option", { value: "auto", text: `Automatic (${detected}, from your Windows region)` }));
    for (const [sym, name] of CURRENCIES) sel.append(el("option", { value: sym, text: `${sym.trim()}  ${name}` }));
    sel.value = localStorage.getItem("bento.currency") ?? "auto";
    const done = el("button", { class: "btn primary", text: "Done" });
    const box = el("div", { class: "modal prefs", role: "dialog" },
      el("h3", { text: "Preferences" }),
      el("label", { class: "pref" }, el("span", { text: "Default currency" }), sel),
      el("p", { class: "hint", text: "Used by the currency button in the toolbar." }),
      el("div", { class: "foot" }, done),
    );
    const scrim = el("div", { class: "scrim" }, box);
    const close = () => { scrim.remove(); window.removeEventListener("keydown", onKey, true); this.grid.focus(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" || (e.key === "Enter" && document.activeElement !== sel)) { e.preventDefault(); e.stopPropagation(); close(); } };
    sel.addEventListener("change", () => { localStorage.setItem("bento.currency", sel.value); this.refreshToolbar(); this.grid.invalidate(); });
    done.addEventListener("click", close);
    scrim.addEventListener("pointerdown", (e) => { if (e.target === scrim) close(); });
    window.addEventListener("keydown", onKey, true);
    document.body.append(scrim);
    sel.focus();
  }

  private shortcuts() {
    modal("Keyboard shortcuts", [
      "Type to replace a cell  ·  Enter or F2 to edit",
      "Enter / Tab  commit and move  ·  Alt+Enter  new line",
      "Ctrl+Arrows  jump to edge of data  ·  Shift  extend",
      "Ctrl+C / X / V  copy, cut, paste  ·  Ctrl+D  fill down",
      "Ctrl+Z / Ctrl+Y  undo, redo  ·  Delete  clear",
      "Ctrl+F / Ctrl+H  find, replace  ·  Ctrl+A  select all",
      "Ctrl+B / I / U  bold, italic, underline  ·  Alt+Shift+5  strikethrough",
      "Ctrl+Shift+L / E / R  align left, centre, right  ·  Ctrl+\\  clear formatting",
      "Ctrl+S  save (.bento)  ·  Ctrl+E  export CSV  ·  Ctrl+O  open  ·  Ctrl+N  new",
      "Ctrl+Tab  next file  ·  Ctrl+PgDn / PgUp  next sheet  ·  Ctrl+W  close",
      "Ctrl+Alt+−  delete selected rows/columns  ·  Ctrl+Shift+F  hide toolbar",
      "Formulas start with =, e.g. =SUM(B2:B100)",
    ].join("\n"), [{ label: "Done", value: true, primary: true }]);
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
        { label: `Freeze up to row ${formatInt(d.dataRow(selRect(d.sel).r1) + 1)}`, action: () => { d.setFrozen(d.dataRow(selRect(d.sel).r1) + 1, d.frozenCols); this.afterFreeze(); } },
        ...(d.frozenRows ? [{ label: "Unfreeze rows", action: () => { d.setFrozen(0, d.frozenCols); this.afterFreeze(); } } as MenuItem] : []),
      ], x, y);
      return;
    }
    showMenu([
      ...clipboard, "sep",
      ...this.rowItems().slice(0, 1), ...this.colItems().slice(0, 1), "sep",
      this.rowItems()[2], this.colItems()[2],
      { label: "Clear cells", key: "Delete", action: () => this.grid.clear() },
      { label: "Clear formatting", key: "Ctrl+\\", action: () => this.applyFormat(() => ({}), "Clear formatting") },
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
      { label: "Sort A → Z", action: () => this.sort(d, c, false) },
      { label: "Sort Z → A", action: () => this.sort(d, c, true) },
      "sep",
      { label: d.filters.has(c) ? "Edit filter…" : "Filter…", action: () => openFilter(d, c, x, y, () => this.afterStructure()) },
      ...(d.filters.has(c) ? [{ label: "Remove filter", action: () => { d.setFilter(c, null); this.afterStructure(); } } as MenuItem] : []),
      "sep",
      ...this.colItems(),
      "sep",
      { label: `Freeze up to column ${colName(s.c1)}`, action: () => { d.setFrozen(d.frozenRows, s.c1 + 1); this.afterFreeze(); } },
      ...(d.frozenCols ? [{ label: "Unfreeze columns", action: () => { d.setFrozen(d.frozenRows, 0); this.afterFreeze(); } } as MenuItem] : []),
      "sep",
      { label: s.c0 === s.c1 ? "Hide column" : "Hide columns", action: hideRange },
      ...(d.hidden.size ? [{ label: "Unhide all columns", action: () => { d.hidden.clear(); this.onChange(); } } as MenuItem] : []),
      { label: "Fit width to content", action: () => { for (let i = s.c0; i <= s.c1; i++) this.grid.autoFit(i); } },
    ], x, y);
  }

  private async clipboardWrite(text: string | null) {
    if (text === null) { if (!this.active?.sel.extra?.length) toast("That selection is too big to copy", true); return; }
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

  /** Fold the toolbar away (and back). Remembered between launches. */
  private setToolbar(show: boolean) {
    localStorage.setItem("bento.toolbar", show ? "shown" : "hidden");
    document.getElementById("app")!.classList.toggle("toolbar-hidden", !show);
    const b = $("toolbar-toggle");
    b.title = show ? "Hide the toolbar (Ctrl+Shift+F)" : "Show the toolbar (Ctrl+Shift+F)";
    b.classList.toggle("flipped", !show);
  }

  private bindChrome() {
    this.setToolbar(localStorage.getItem("bento.toolbar") !== "hidden");
    $("toolbar-toggle").addEventListener("pointerdown", (e) => e.preventDefault());
    $("toolbar-toggle").addEventListener("click", () => this.setToolbar(document.getElementById("app")!.classList.contains("toolbar-hidden")));
    $("menu-btn").addEventListener("click", () => this.appMenu());
    $("new-tab").addEventListener("click", () => this.newDoc());
    document.querySelectorAll<HTMLElement>("#theme-toggle button").forEach((b) => {
      b.addEventListener("pointerdown", (e) => e.preventDefault());
      b.addEventListener("click", () => this.setTheme(b.dataset.themeOpt as Theme));
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.applyTheme());
    $("win-min").addEventListener("click", () => windowControls.minimize());
    $("win-max").addEventListener("click", () => windowControls.toggleMaximize());
    $("win-close").addEventListener("click", () => windowControls.close());
    const syncMax = async () => {
      const max = await windowControls.isMaximized();
      $("win-max").title = max ? "Restore" : "Maximise";
      $("win-max").innerHTML = max
        ? '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="3.5" y="5.5" width="7" height="7" rx="1.5"/><path d="M6 3.5h4.75a1.75 1.75 0 0 1 1.75 1.75V10"/></svg>'
        : '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="3.5" y="3.5" width="9" height="9" rx="1.75"/></svg>';
    };
    windowControls.onResized(() => { syncMax(); });
    syncMax();
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
      const typing = (() => { const a = document.activeElement; return a instanceof HTMLInputElement || a instanceof HTMLSelectElement || a === this.grid.editor; })();
      if (ctrl && k === "a" && d && !typing && !e.defaultPrevented) { e.preventDefault(); this.grid.selectAll(); this.grid.focus(); }
      else if (ctrl && k === "n") { e.preventDefault(); this.newDoc(); }
      else if (ctrl && k === "o") { e.preventDefault(); this.openDialog(); }
      else if (ctrl && k === "s") { e.preventDefault(); this.save(d, e.shiftKey); }
      else if (ctrl && !e.shiftKey && k === "e") { e.preventDefault(); this.exportCsv(d); }
      else if (d && ctrl && !e.shiftKey && (k === "b" || k === "i" || k === "u")) {
        e.preventDefault();
        if (this.grid.editing) this.grid.commitEdit();
        const key = k === "b" ? "b" : k === "i" ? "i" : "u";
        const r = d.dataRow(d.sel.ar);
        const st = d.style(r, d.sel.ac);
        const header = d.freezeHeader && r === 0;
        const on = !!(st[key] ?? (key === "b" && header));
        this.applyFormat((s) => ({ ...s, [key]: on ? (key === "b" && header ? false : undefined) : true }), key === "b" ? "Bold" : key === "i" ? "Italic" : "Underline");
      }
      else if (d && e.altKey && e.shiftKey && (e.key === "%" || e.code === "Digit5")) {
        e.preventDefault();
        const on = !!d.style(d.dataRow(d.sel.ar), d.sel.ac).s;
        this.applyFormat((s) => ({ ...s, s: on ? undefined : true }), "Strikethrough");
      }
      else if (d && ctrl && e.shiftKey && (k === "l" || k === "e" || k === "r")) {
        e.preventDefault();
        const ha = k === "l" ? "l" : k === "e" ? "c" : "r";
        this.applyFormat((s) => ({ ...s, ha }), "Align");
      }
      else if (d && ctrl && e.key === "\\") { e.preventDefault(); this.applyFormat(() => ({}), "Clear formatting"); }
      else if (ctrl && k === "w") { e.preventDefault(); if (d) this.closeDoc(d); }
      else if (ctrl && e.shiftKey && k === "f") { e.preventDefault(); this.setToolbar(document.getElementById("app")!.classList.contains("toolbar-hidden")); }
      else if (ctrl && k === "f") { e.preventDefault(); if (d) this.find.open(false); }
      else if (ctrl && k === "h") { e.preventDefault(); if (d) this.find.open(true); }
      else if (ctrl && e.key === "Tab") {
        e.preventDefault();
        if (this.docs.length > 1 && d) {
          const i = this.docs.indexOf(d);
          this.activate(this.docs[(i + (e.shiftKey ? -1 : 1) + this.docs.length) % this.docs.length]);
        }
      }
      else if (ctrl && (e.key === "=" || e.key === "+")) { e.preventDefault(); this.stepZoom(1); }
      else if (ctrl && !e.altKey && e.key === "-") { e.preventDefault(); this.stepZoom(-1); }
      else if (ctrl && e.key === "0") { e.preventDefault(); this.setZoom(1); }
      else if (e.key === "F1") { e.preventDefault(); this.shortcuts(); }
      else if (ctrl && (e.key === "PageDown" || e.key === "PageUp") && d) {
        e.preventDefault();
        const sh = d.book.sheets, i = sh.indexOf(d);
        const next = sh[(i + (e.key === "PageDown" ? 1 : -1) + sh.length) % sh.length];
        if (next !== d) this.showSheet(next);
      }
      else if (ctrl && e.altKey && (e.key === "-" || e.code === "Minus") && d) {
        // Delete selected whole rows or columns (Sheets: Ctrl+Alt+-).
        e.preventDefault();
        const s = selRect(d.sel);
        if (this.grid.isWholeRows(s)) { d.deleteRows(this.selectedDataRows()); this.afterStructure(); }
        else if (this.grid.isWholeCols(s)) { d.deleteCols(s.c0, s.c1 - s.c0 + 1); this.afterStructure(); }
        else toast("Select whole rows or columns to delete them");
      }
      else if (ctrl && e.key === ",") { e.preventDefault(); this.preferences(); }
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
    // Ctrl + mouse wheel zooms the grid.
    $("grid-wrap").addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.stepZoom(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
  }
}

const LOGO = `<rect x="2" y="2" width="20" height="20" rx="5" fill="#d97757"/><rect x="5.2" y="5.2" width="6.2" height="13.6" rx="1.6" fill="#fbf9f4"/><rect x="12.6" y="5.2" width="6.2" height="6.2" rx="1.6" fill="#fbf9f4"/><rect x="12.6" y="12.6" width="6.2" height="6.2" rx="1.6" fill="#fbf9f4" opacity=".55"/>`;

function svg(inner: string, size: number, cls = ""): SVGElement {
  const vb = size === 12 ? "0 0 12 12" : "0 0 24 24";
  const wrap = document.createElement("span");
  wrap.innerHTML = `<svg viewBox="${vb}" width="${size}" height="${size}" class="${cls}" fill="none">${inner}</svg>`;
  return wrap.firstElementChild as SVGElement;
}
