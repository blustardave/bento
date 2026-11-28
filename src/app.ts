import { CsvParser, Delimiter, LineEnding, looksLikeHeader, sniffDelimiter, sniffLineEnding } from "./csv";
import { Book, Doc, allRects, selRect } from "./doc";
import { Encoding, decodeBytes, encodeText } from "./encoding";
import { openFilter } from "./filter";
import { FindPanel } from "./find";
import { Grid, type PasteMode } from "./grid";
import { Engine, FUNCS } from "./formula";
import { FormulaAssist } from "./fassist";
import { absRef, defineName, evaluateDialog, nameProblem, namesDialog } from "./formulatools";
import { validName } from "./fcore";
import { ACCENTS, applyAccent } from "./accent";
import { decodeBento, encodeBento, isBentoPath, looksLikeBento, sheetFromData, sheetToData } from "./bento";
import {
  FileRef, forgetRecent, isNotAllowed, isTauri, launchFiles, noteRecent, onFileDrop, onOpenFiles, pickFiles, pickSavePath, readFile,
  recentFiles, windowControls, writeFile,
} from "./native";
import { MenuItem, closeMenus, formDialog, modal, showMenu, toast } from "./ui";
import { ToolButton, divider, grow, toolButton } from "./toolbar";
import { ZOOMS } from "./grid";
import { AutoSaver, RecoveredFile, autoSaveEnabled } from "./autosave";
import { FormatBar } from "./formatbar";
import { CURRENCIES, HUES, Style, colorLabel, detectCurrency, resolveColor } from "./format";
import { showPopover } from "./ui";
import { ObjectLayer, SHAPES } from "./objects";
import { CHART_TYPES, chartData, dataRegion, parseRange, rangeText } from "./chart";
import type { ChartObject, ChartType, ShapeObject, ShapeType, SheetObject } from "./doc";
import { appVersion, initUpdater } from "./updater";
import { maxOf } from "./util";
import { basename, cellName, clamp, colIndex, colName, el, formatInt, formatStat, nextFrame, parseNum } from "./util";
import { cmdKey, isAltGr, isMac, keys, localiseTitles, osName } from "./platform";
import { WheelZoom } from "./wheelzoom";

type Theme = "system" | "light" | "dusk" | "dark";
const $ = (id: string) => document.getElementById(id)!;

export class App {
  docs: Doc[] = [];
  active: Doc | null = null;
  grid: Grid;
  find: FindPanel;
  objects!: ObjectLayer;
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
    theme: () => { const t = document.documentElement.dataset.theme; return t === "dusk" ? "dusk" : t === "dark" ? "dark" : "light"; },
    toggleMerge: () => this.toggleMerge(),
    selectionMerged: () => {
      const d = this.active;
      if (!d || !d.merges.length) return false;
      const s = selRect(d.sel);
      return this.grid.visibleMerges().some((m) => m.r0 <= s.r1 && s.r0 <= m.r1 && m.c0 <= s.c1 && s.c0 <= m.c1);
    },
  });
  private zoomInput!: HTMLInputElement;
  private autosaver = new AutoSaver(
    () => this.docs.map((d) => d.book),
    (b) => encodeBento(b),
    (b) => this.saveQuietly(b),
  );

  constructor() {
    this.grid = new Grid({
      onSelection: () => this.onSelection(),
      onChange: () => this.onChange(),
      onContextMenu: (zone, x, y) => this.contextMenu(zone, x, y),
      onColumnMenu: (_c, x, y) => this.columnMenu(x, y),
      onNotice: (t) => toast(t),
      onConfirm: async (title, message, yes) => !!(await modal(title, message, [{ label: "Cancel", value: false }, { label: yes, value: true, primary: true }])),
      onEditText: (t) => { if (document.activeElement !== this.cellInput) this.cellInput.value = t ?? this.activeRaw(); },
      onRender: () => this.objects?.render(),
      onDropdown: (r, c, x, y) => this.dropdownMenu(r, c, x, y),
      onPasteImage: (f) => this.insertImageFile(f, "over"),
      onPasteValues: () => this.clipboardPaste("values"),
    });
    this.objects = new ObjectLayer(this.grid, {
      doc: () => this.active,
      onChange: () => this.onChange(),
      menu: (o, x, y) => this.objectMenu(o, x, y),
      editChart: (o) => { if (o.kind === "chart") this.chartEditor(o); },
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
    await this.loadRecent();
    await this.autosaver.start();
    this.offerRecovery();
    onFileDrop(
      (s) => ($("drop-hint").hidden = s !== "over"),
      (files) => {
        // Dropping pictures onto a sheet places them on it.
        const pics = files.filter((f) => IMAGE_EXT.test(f.name));
        if (pics.length && this.active && pics.length === files.length) { for (const f of pics) this.insertImageRef(f); return; }
        this.open(files.filter((f) => !IMAGE_EXT.test(f.name)));
      },
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
    // A heading row stays put when sorting/filtering (and shows as one).
    doc.frozenRows = looksLikeHeader(p.rows, (s) => !Number.isNaN(parseNum(s))) ? 1 : 0;
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
    let autoSaveFailed = false;
    if (doc.book.dirty && this.autosaver.canAutoSave(doc.book)) {
      // If the quiet save fails (file locked, drive gone…), fall through to
      // asking: never leave the tab impossible to close.
      autoSaveFailed = !(await this.saveQuietly(doc.book));
    }
    if (doc.book.dirty) {
      if (this.active !== doc) this.activate(doc);
      const why = autoSaveFailed ? `AutoSave couldn't write to ${doc.name}, so your latest changes aren't saved yet.` : "Your changes will be lost if you don't save them.";
      const choice = await modal(`Save changes to ${doc.name}?`, why, [
        { label: "Cancel", value: "cancel" },
        { label: "Don't save", value: "discard" },
        { label: "Save", value: "save", primary: true },
      ]);
      if (choice === null || choice === "cancel") return false;
      if (choice === "save" && !(await this.save(doc))) return false;
    }
    this.autosaver.discard(doc.book.id);
    this.removeDoc(doc);
    return true;
  }

  private async confirmQuit(): Promise<boolean> {
    for (const d of [...this.docs]) {
      if (!d.book.dirty) continue;
      if (!(await this.closeDoc(d))) return false;
    }
    // A clean exit leaves nothing to recover.
    for (const d of this.docs) await this.autosaver.discard(d.book.id);
    return true;
  }

  /** AutoSave: write a .bento back to where it lives, without any fuss. */
  private async saveQuietly(book: Book): Promise<boolean> {
    if (!book.path || !isBentoPath(book.path)) return false;
    if (this.grid.editing && this.active?.book === book) return false; // wait until the edit is committed
    try {
      const token = book.token;
      await writeFile(book.path, await encodeBento(book));
      // Only mark saved if nothing changed while writing.
      if (book.token === token) book.markSaved();
      this.autoSaveWarned.delete(book.id);
      this.render();
      return true;
    } catch (e) {
      console.warn("AutoSave couldn't write", e);
      // Say so once (until it works again): a silent failure looks like it's saving.
      if (!this.autoSaveWarned.has(book.id)) {
        this.autoSaveWarned.add(book.id);
        toast(`AutoSave couldn't save ${book.name}. Your changes are kept safe — use Save As to save them somewhere else.`, true);
      }
      return false;
    }
  }

  private autoSaveWarned = new Set<string>();

  /** After a crash: offer back any recovery copies that were left behind. */
  private async offerRecovery() {
    const found = await this.autosaver.leftovers();
    if (!found.length) return;
    const names = found.slice(0, 5).map((f) => `•  ${f.name}  (${new Date(f.savedAt).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })})`).join("\n");
    const more = found.length > 5 ? `\n…and ${found.length - 5} more` : "";
    const choice = await modal(
      "Recover unsaved work?",
      `Bento didn't close properly last time. These had changes that weren't saved:\n\n${names}${more}`,
      [
        { label: "Discard", value: "discard" },
        { label: "Recover", value: "recover", primary: true },
      ],
    );
    if (choice === "recover") {
      for (const f of found) await this.restore(f);
    } else if (choice === "discard") {
      for (const f of found) await this.autosaver.discard(f.id);
    }
  }

  private async restore(f: RecoveredFile) {
    const doc = this.makeDoc(f.name, f.path);
    const book = doc.book;
    book.id = f.id; // keep updating the same recovery copy until it's saved
    if (f.path) book.source = { name: f.name, path: f.path };
    try {
      await decodeBento(f.bytes, book, (name) => this.makeSheet(book, name));
    } catch {
      await this.autosaver.discard(f.id);
      return;
    }
    for (const sh of book.sheets) {
      sh.loading = null;
      if (!sh.widths.size) this.grid.autoFitInitial(sh);
      sh.remeasureAll();
    }
    book.structureDirty = true; // recovered work counts as unsaved
    const blank = this.active && !this.active.path && !this.active.book.dirty && this.active.rows.length === 0 ? this.active : null;
    if (blank) this.docs.splice(this.docs.indexOf(blank), 1, book.sheet);
    else this.docs.push(book.sheet);
    this.activate(book.sheet);
  }

  /**
   * Save. A .bento saves in place; a CSV you opened saves back to the same
   * CSV (with the separator, encoding and line endings it came with) —
   * asking first if the sheet has things a CSV can't hold. Anything else, or
   * Save As, asks where to put a .bento.
   */
  async save(doc: Doc | null = this.active, saveAs = false): Promise<boolean> {
    if (!doc || doc.loading !== null) return false;
    if (this.grid.editing && this.active === doc) this.grid.commitEdit();
    if (!saveAs && isTauri && doc.path && CSV_PATH.test(doc.path) && doc.book.sheets.length === 1) {
      const r = await this.saveCsvInPlace(doc);
      if (r !== "bento") return r === "saved";
    }
    let path = doc.path;
    if (!path || !isBentoPath(path) || saveAs || !isTauri) {
      const suggested = (doc.path ?? doc.name).replace(/\.[^.\\/]+$/, "") + ".bento";
      path = await pickSavePath(suggested, "bento");
      if (!path) return false;
    }
    try {
      await writeFile(path, await encodeBento(doc.book));
    } catch (e) {
      // A file from an earlier session that Bento may no longer write to: ask where instead.
      if (isNotAllowed(e) && !saveAs) return this.save(doc, true);
      toast(String(e instanceof Error ? e.message : e), true);
      return false;
    }
    doc.path = path;
    doc.name = basename(path);
    if (isTauri) doc.source = { name: doc.name, path };
    doc.book.markSaved();
    this.autosaver.discard(doc.book.id);
    this.autosaver.settled(doc.book);
    this.addRecent(path);
    this.render();
    toast(`Saved ${doc.name}`);
    return true;
  }

  /** Files this sheet already said "yes, save as plain CSV" for (this session). */
  private csvLossOk = new WeakSet<Book>();

  /** Save an opened CSV back to itself. "bento" means: save a .bento copy instead. */
  private async saveCsvInPlace(doc: Doc): Promise<"saved" | "cancel" | "bento"> {
    const lost: string[] = [];
    if (doc.hasFormatting()) lost.push(doc.objects.length ? "formatting, charts and pictures" : "formatting");
    if (doc.merges.length) lost.push("merged cells");
    if (doc.book.names.size) lost.push("named ranges");
    if (lost.length && !this.csvLossOk.has(doc.book)) {
      const formulas = doc.hasFormulas() ? (doc.saveFormulasAs === "formulas" ? " Formulas are saved as text." : " Formulas are saved as their results.") : "";
      const choice = await modal(`Save ${doc.name} as plain CSV?`,
        `A CSV only holds the values in this sheet, so the ${lost.join(", ")} won't be kept.${formulas} To keep everything, save a Bento copy instead.`,
        [{ label: "Cancel", value: "cancel" as const }, { label: "Save a Bento copy…", value: "bento" as const }, { label: "Save CSV", value: "csv" as const, primary: true }]);
      if (choice === null || choice === "cancel") return "cancel";
      if (choice === "bento") return "bento";
      this.csvLossOk.add(doc.book);
    }
    try {
      const text = doc.toText(doc.saveFormulasAs !== "formulas");
      await writeFile(doc.path!, encodeText(text, doc.encoding, doc.bom));
    } catch (e) {
      if (isNotAllowed(e)) return "bento";
      toast(String(e instanceof Error ? e.message : e), true);
      return "cancel";
    }
    doc.book.markSaved();
    this.autosaver.discard(doc.book.id);
    this.autosaver.settled(doc.book);
    this.addRecent(doc.path);
    this.render();
    toast(`Saved ${doc.name}`);
    return "saved";
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
    const path = await pickSavePath(base + sheetPart + (doc.delim === "\t" ? ".tsv" : ".csv"), "csv");
    if (!path) return false;
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
    book.recalcAll();
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
    book.recalcAll();
    this.showSheet(copy);
  }

  private async deleteSheet(doc: Doc) {
    const book = doc.book;
    if (doc.protected) { toast(`"${doc.sheetName}" is protected — unprotect it first`); return; }
    if (book.sheets.length < 2) { toast("A file needs at least one sheet"); return; }
    if (doc.rows.length || doc.objects.length) {
      // Enter cancels here: deleting a sheet can't be undone.
      const ok = await modal(`Delete "${doc.sheetName}"?`, "This removes the sheet and everything on it. You can't undo this.", [
        { label: "Delete", value: true, danger: true },
        { label: "Cancel", value: false, primary: true },
      ]);
      if (!ok) return;
    }
    const i = book.sheets.indexOf(doc);
    book.sheets.splice(i, 1);
    book.structureDirty = true;
    book.recalcAll();
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
    if (doc.protected) { toast(`"${doc.sheetName}" is protected — unprotect it first`); return; }
    const tab = document.querySelector<HTMLElement>(`.sheet-tab[data-sheet="${doc.book.sheets.indexOf(doc)}"]`);
    const label = tab?.querySelector<HTMLElement>(".label");
    if (!tab || !label) return;
    // Edit the name right where it is, so nothing shifts.
    tab.classList.add("renaming");
    label.contentEditable = "plaintext-only";
    if (label.contentEditable !== "plaintext-only") label.contentEditable = "true";
    label.spellcheck = false;
    label.focus();
    const range = document.createRange();
    range.selectNodeContents(label);
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    let finished = false;
    const finish = (save: boolean) => {
      if (finished) return;
      finished = true;
      const v = (label.textContent ?? "").replace(/\s+/g, " ").trim();
      if (save && v && v !== doc.sheetName) {
        if (doc.book.sheets.some((s) => s !== doc && s.sheetName.toLowerCase() === v.toLowerCase())) toast(`There's already a sheet called "${v}"`);
        else { doc.book.renameSheet(doc, v); this.grid.invalidate(); }
      }
      this.render();
      this.grid.focus();
    };
    label.addEventListener("keydown", (e) => {
      e.stopPropagation();
      // preventDefault matters: focus returns to the grid during this key press,
      // and the Enter must not carry over into a cell.
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    label.addEventListener("blur", () => finish(true));
  }

  private sheetMenu(doc: Doc, x: number, y: number, anchor?: HTMLElement) {
    const book = doc.book;
    const i = book.sheets.indexOf(doc);
    const locked = doc.protected;
    showMenu([
      { label: "Duplicate", action: () => this.duplicateSheet(doc) },
      { label: "Rename", disabled: locked, action: () => this.renameSheet(doc) },
      { label: "Change colour", action: () => this.tabColorPicker(doc, anchor) },
      { label: locked ? "Unprotect sheet" : "Protect sheet", action: () => {
        doc.protected = !locked;
        book.structureDirty = true;
        this.render();
        toast(locked ? `"${doc.sheetName}" can be renamed and deleted again` : `"${doc.sheetName}" is protected from renaming and deleting`);
      } },
      "sep",
      { label: "Move left", disabled: i === 0, action: () => this.moveSheet(doc, -1) },
      { label: "Move right", disabled: i === book.sheets.length - 1, action: () => this.moveSheet(doc, 1) },
      "sep",
      { label: "Delete", danger: true, disabled: locked || book.sheets.length < 2, action: () => this.deleteSheet(doc) },
    ], x, y - 4, undefined, "up");
  }

  /** Pick a tab colour from the same theme-aware palette as cell fills. */
  private tabColorPicker(doc: Doc, anchor?: HTMLElement) {
    const tab = anchor ?? document.querySelector<HTMLElement>(`.sheet-tab[data-sheet="${doc.book.sheets.indexOf(doc)}"]`);
    if (!tab) return;
    const theme = (document.documentElement.dataset.theme ?? "light") as "light" | "dark" | "dusk";
    const box = el("div", { class: "palette" });
    let close = () => {};
    const pick = (v: string | undefined) => { doc.tabColor = v; doc.book.structureDirty = true; close(); this.render(); };
    const reset = el("button", { class: "reset", text: "No colour" });
    reset.addEventListener("click", () => pick(undefined));
    box.append(reset);
    for (const tone of ["1", "2"]) {
      const row = el("div", { class: "swatches" });
      for (const h of HUES) {
        const token = `@${h}-${tone}`;
        const sw = el("button", { class: "swatch" + (doc.tabColor === token ? " on" : ""), title: colorLabel(h) });
        sw.style.background = resolveColor(token, theme) ?? "transparent";
        sw.addEventListener("click", () => pick(token));
        row.append(sw);
      }
      box.append(row);
    }
    close = showPopover(tab, box);
    // Open upwards: the tab sits at the bottom of the window.
    const pop = document.querySelector<HTMLElement>(".popover:last-of-type");
    if (pop) { const r = tab.getBoundingClientRect(); pop.style.top = `${r.top - pop.getBoundingClientRect().height - 6}px`; }
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
    const theme = (document.documentElement.dataset.theme ?? "light") as "light" | "dark" | "dusk";
    const els: HTMLElement[] = [];
    book.sheets.forEach((s, i) => {
      const caret = el("span", { class: "caret" });
      caret.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M5.5 6.75 8 9.25l2.5-2.5"/></svg>';
      const lock = s.protected ? el("span", { class: "lock", title: "Protected" }) : null;
      if (lock) lock.innerHTML = '<svg viewBox="0 0 16 16" width="11" height="11"><rect x="4" y="7" width="8" height="6" rx="1.25"/><path d="M5.75 7V5.5a2.25 2.25 0 0 1 4.5 0V7"/></svg>';
      const tab = el("button", { class: "sheet-tab" + (s === d ? " active" : "") + (s.tabColor ? " coloured" : ""), "data-sheet": String(i), title: s.sheetName },
        lock, el("span", { class: "label", text: s.sheetName, "data-text": s.sheetName }), caret);
      const bg = resolveColor(s.tabColor, theme);
      if (bg) tab.style.background = bg;
      // Click to switch; hold or drag to lift the tab and slide it into place,
      // with its neighbours stepping aside as it passes them.
      tab.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || caret.contains(e.target as Node) || tab.classList.contains("renaming")) return;
        e.preventDefault();
        const startX = e.clientX;
        let lifted = false;
        let to = i;
        let dx = 0;
        const rects = els.map((t) => t.getBoundingClientRect());
        const me = rects[i];
        const gap = rects.length > 1 ? rects[1].left - rects[0].right : 0;
        const step = me.width + gap;
        const strip = tabs.getBoundingClientRect();
        const lift = () => {
          if (lifted) return;
          lifted = true;
          tabs.classList.add("reordering");
          tab.classList.add("lifted");
          document.body.classList.add("grabbing");
        };
        const hold = window.setTimeout(lift, 220);
        const place = () => {
          // Keep the tab within the row of tabs (and the strip).
          const minX = Math.max(strip.left, rects[0].left) - me.left;
          const maxX = Math.min(strip.right, rects[rects.length - 1].right) - me.right;
          dx = Math.max(minX, Math.min(maxX, dx));
          tab.style.transform = `translate(${dx}px, -2px)`;
          // Swap with a neighbour once the leading edge passes its middle,
          // so the ends are always reachable.
          const left = me.left + dx, right = me.right + dx;
          to = i;
          for (let k = 0; k < rects.length; k++) {
            if (k === i) continue;
            const c = rects[k].left + rects[k].width / 2;
            if (k > i && right > c) to = k;
            if (k < i && left < c && to === i) to = k;
          }
          els.forEach((t, k) => {
            if (k === i) return;
            const shift = to > i && k > i && k <= to ? -step : to < i && k >= to && k < i ? step : 0;
            t.style.transform = shift ? `translateX(${shift}px)` : "";
          });
        };
        const move = (ev: PointerEvent) => {
          if (!lifted && Math.abs(ev.clientX - startX) < 4) return;
          lift();
          dx = ev.clientX - startX;
          place();
        };
        const finish = () => {
          els.forEach((t) => (t.style.transform = ""));
          tabs.classList.remove("reordering", "settling");
          tab.classList.remove("lifted");
          if (to !== i) {
            book.sheets.splice(i, 1);
            book.sheets.splice(to, 0, s);
            book.current = book.sheets.indexOf(this.active!);
            book.structureDirty = true;
          }
          this.render();
        };
        const up = () => {
          window.clearTimeout(hold);
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", up);
          document.body.classList.remove("grabbing");
          if (!lifted) { if (s !== d) this.showSheet(s); return; }
          // Glide into the gap that opened up, then commit the new order.
          const slot = to > i ? rects[to].right - me.right : to < i ? rects[to].left - me.left : 0;
          tabs.classList.add("settling");
          tab.style.transform = `translate(${slot}px, 0)`;
          window.setTimeout(finish, 160);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
      });
      caret.addEventListener("click", (e) => { e.stopPropagation(); const r = tab.getBoundingClientRect(); this.sheetMenu(s, r.left, r.top, tab); });
      tab.addEventListener("dblclick", () => { if (!tab.classList.contains("renaming")) this.renameSheet(s); });
      tab.addEventListener("contextmenu", (e) => { e.preventDefault(); this.sheetMenu(s, e.clientX, e.clientY, tab); });
      els.push(tab);
      tabs.append(tab);
    });
    box.append(add, all, tabs);
  }

  /* -------------------------------- recent -------------------------------- */

  /** Recent files, most recent first (kept by the Rust side in the app). */
  private recentList: string[] = [];

  private recent(): string[] {
    return this.recentList;
  }

  private async loadRecent() {
    try { this.recentList = await recentFiles(); } catch (e) { console.warn(e); }
    if (!this.docs.length) this.render();
  }

  private addRecent(path: string | null) {
    if (!path) return;
    this.recentList = [path, ...this.recentList.filter((p) => p.toLowerCase() !== path.toLowerCase())].slice(0, 8);
    noteRecent(path).catch((e) => console.warn(e));
  }

  private forget(path: string | null) {
    if (!path) return;
    this.recentList = this.recentList.filter((p) => p !== path);
    forgetRecent(path).catch((e) => console.warn(e));
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
      const closeBtn = el("span", { class: "x", title: keys("Close (Ctrl+W)") },
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
    const open = el("button", { class: "btn primary" }, "Open a file", el("kbd", { text: keys("Ctrl+O") }));
    const blank = el("button", { class: "btn" }, "New sheet", el("kbd", { text: keys("Ctrl+N") }));
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
    const nameBox = $("cell-name") as HTMLInputElement;
    if (!d) { nameBox.value = ""; this.cellInput.value = ""; return; }
    const s = selRect(d.sel);
    const name = (r: number, c: number) => cellName(d.dataRow(r), c);
    const label = s.r0 === s.r1 && s.c0 === s.c1
      ? name(d.sel.ar, d.sel.ac)
      : this.grid.isWholeCols(s) ? (s.c0 === s.c1 ? colName(s.c0) : `${colName(s.c0)}:${colName(s.c1)}`)
      : this.grid.isWholeRows(s) ? (s.r0 === s.r1 ? `${d.dataRow(s.r0) + 1}` : `${d.dataRow(s.r0) + 1}:${d.dataRow(s.r1) + 1}`)
      : `${name(s.r0, s.c0)}:${name(s.r1, s.c1)}`;
    if (document.activeElement !== nameBox) nameBox.value = label;
    if (!this.grid.editing && document.activeElement !== this.cellInput) this.cellInput.value = this.activeRaw();
    // Part of a spill: show the formula it comes from, greyed out.
    const dr = d.dataRow(d.sel.ar);
    const sp = d.raw(dr, d.sel.ac) === "" ? d.engine.spillAnchor(dr, d.sel.ac) : null;
    this.cellInput.placeholder = sp ? d.raw(sp.r, sp.c) : "";
    if (document.activeElement !== nameBox) { const n = this.nameFor(s); if (n) nameBox.value = n; }
    this.renderStats();
    this.refreshToolbar();
  }

  /** A defined name that covers exactly this selection, if any. */
  private nameFor(s: { r0: number; c0: number; r1: number; c1: number }): string | null {
    const d = this.active!;
    if (!d.book.names.size || d.view) return null;
    for (const { name, ref } of d.book.names.values()) {
      const refs = Engine.references("=" + ref);
      if (refs.length !== 1) continue;
      const x = refs[0];
      if ((x.sheet ?? d.sheetName).toLowerCase() !== d.sheetName.toLowerCase()) continue;
      if (x.r1 === s.r0 && x.r2 === s.r1 && x.c1 === s.c0 && x.c2 === s.c1) return name;
    }
    return null;
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
    // Dusk is retired for now; anyone who had it gets Dark.
    const t = localStorage.getItem("bento.theme") as Theme | null;
    return t === "dusk" ? "dark" : t || "system";
  }

  private setTheme(t: Theme) {
    localStorage.setItem("bento.theme", t);
    this.applyTheme();
  }

  private applyTheme() {
    const t = this.theme();
    const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = t === "dusk" ? "dusk" : dark ? "dark" : "light";
    applyAccent(localStorage.getItem("bento.accent") ?? "clay", document.documentElement.dataset.theme as "light" | "dark" | "dusk");
    document.querySelectorAll<HTMLElement>("#theme-toggle button").forEach((b) => {
      const on = b.dataset.themeOpt === t;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    });
    windowControls.setBackground(getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
    this.grid.readColors();
    // Tab colours are resolved per theme.
    if (this.active) this.renderStatus();
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
    this.zoomInput = el("input", { class: "zoom-input", value: "100%", title: keys("Zoom (Ctrl+= / Ctrl+-)"), spellcheck: "false" });
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
      t("undo", toolButton({ icon: "undo", title: keys("Undo (Ctrl+Z)"), onClick: withDoc((d) => this.grid.applyUndo(d.undo())) })),
      t("redo", toolButton({ icon: "redo", title: keys("Redo (Ctrl+Y)"), onClick: withDoc((d) => this.grid.applyUndo(d.redo())) })),
      zoomBox,
      divider(), ...f.numbers,
      divider(), ...f.font,
      divider(), ...f.size,
      divider(), ...f.text,
      divider(), ...f.fill,
      divider(), ...f.align,
      divider(),
      t("filter", toolButton({ icon: "filter", title: "Filter column", onClick: (b) => withDoc((d) => {
        const r = b.getBoundingClientRect();
        openFilter(d, d.sel.ac, r.left, r.bottom + 4, () => this.afterStructure());
      })() })),
      t("sum", toolButton({ icon: "sum", caret: true, title: "Functions", onClick: (b) => {
        if (!this.active) return;
        const r = b.getBoundingClientRect();
        b.classList.add("open");
        showMenu(this.functionMenu(), r.left, r.bottom + 4, () => b.classList.remove("open"));
      } })),
      grow(),
      t("find", toolButton({ icon: "search", title: keys("Find and replace (Ctrl+F)"), onClick: withDoc(() => (this.find.isOpen ? this.find.close() : this.find.open(false))) })),
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

  /** "Sort range" for a block of selected cells (not whole columns, which sort the sheet). */
  private sortRangeItems(): MenuItem[] {
    const d = this.active!;
    const s = selRect(d.sel);
    if (s.r1 <= s.r0 || this.grid.isWholeCols(s) || d.sel.extra?.length) return [];
    const by = colName(d.sel.ac);
    const run = (desc: boolean) => {
      if (d.view) { toast("Clear filters and show hidden rows before sorting a range"); return; }
      // A frozen heading row stays where it is.
      const r0 = Math.max(s.r0, Math.min(d.frozenRows, s.r1)), r1 = Math.min(s.r1, d.rows.length - 1);
      if (!d.sortRange(r0, r1, s.c0, s.c1, d.sel.ac, desc)) { toast("Can't sort a range with merged cells in it"); return; }
      this.afterStructure();
    };
    return [{ label: "Sort range", children: [
      { label: "A → Z", key: `by ${by}`, action: () => run(false) },
      { label: "Z → A", key: `by ${by}`, action: () => run(true) },
    ] }];
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
    // The first row below the selection with room for the totals (never
    // writing over something that's already there).
    const free = (r: number) => { for (let c = s.c0; c <= s.c1; c++) if (d.raw(d.dataRow(r), c) !== "") return false; return true; };
    let below = s.r1 + 1;
    while (!free(below) && below < s.r1 + 10_000) below++;
    if (!free(below)) { toast("There's no empty row below the selection for the totals"); return; }
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
      { label: "New sheet", key: keys("Ctrl+N"), action: () => this.newDoc() },
      { label: "Open…", key: keys("Ctrl+O"), action: () => this.openDialog() },
      ...(recent.length ? [{ heading: "Recent" } as MenuItem, ...recent.map((p) => ({ label: basename(p), action: () => this.open([{ name: basename(p), path: p }]) }))] : []),
      "sep",
      { label: "Save", key: keys("Ctrl+S"), disabled: !d, action: () => this.save() },
      { label: "Save as…", key: keys("Ctrl+Shift+S"), disabled: !d, action: () => this.save(d, true) },
      { label: "Export as CSV…", key: keys("Ctrl+E"), disabled: !d, action: () => this.exportCsv(d) },
      ...(d?.source && !isBentoPath(d.source.name) ? [{ label: "Reopen CSV with other settings…", disabled: d.book.dirty, action: () => this.reopenCsv() } as MenuItem] : []),
      { label: "Close tab", key: keys("Ctrl+W"), disabled: !d, action: () => d && this.closeDoc(d) },
      "sep",
      { label: "Find", key: keys("Ctrl+F"), disabled: !d, action: () => this.find.open(false) },
      { label: "Find and replace", key: keys("Ctrl+H"), disabled: !d, action: () => this.find.open(true) },
      "sep",
      { label: "Unfreeze rows and columns", disabled: !d || (!d.frozenRows && !d.frozenCols), action: () => { d!.setFrozen(0, 0); this.afterFreeze(); } },
      { label: "Clear all filters", disabled: !d?.filters.size, action: () => { d!.clearFilters(); this.afterStructure(); } },
      { label: "Unhide all columns", disabled: !d?.hidden.size, action: () => { d!.setColumnsHidden("all", false); this.onChange(); } },
      "sep",
      { label: "Preferences…", key: keys("Ctrl+,"), action: () => this.preferences() },
      { label: "Keyboard shortcuts", key: "F1", action: () => this.shortcuts() },
      { label: "About Bento", action: async () => modal("Bento", `Version ${await appVersion()}\nA minimal, fast CSV editor.\nUpdates install automatically.\nAutoSave is ${autoSaveEnabled() ? "on" : "off"} (Preferences).`, [{ label: "Close", value: true, primary: true }]) },
    ];
    showMenu(items, r.left, r.bottom + 4, () => btn.classList.remove("open"));
  }

  private afterFreeze() {
    const d = this.active;
    if (!d) return;
    this.grid.setDoc(d);
    this.afterStructure();
  }

  private preferences(section = "appearance") {
    closeMenus();
    const isTauriApp = isTauri;
    const row = (label: string, hint: string | null, control: HTMLElement) =>
      el("div", { class: "prow" }, el("div", { class: "plabel" }, el("b", { text: label }), hint ? el("small", { text: hint }) : null), el("div", { class: "pctl" }, control));
    const seg = (opts: [string, string][], value: string, onPick: (v: string) => void) => {
      const box = el("div", { class: "segmented" });
      for (const [v, label] of opts) {
        const b = el("button", { text: label, class: v === value ? "on" : "" });
        b.addEventListener("click", () => { box.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); onPick(v); });
        box.append(b);
      }
      return box;
    };
    const sw = (on: boolean, onFlip: (v: boolean) => void) => {
      const cb = el("input", { type: "checkbox", class: "switch", role: "switch" }) as HTMLInputElement;
      cb.checked = on;
      cb.addEventListener("change", () => onFlip(cb.checked));
      return cb;
    };
    const flag = (key: string, onByDefault = true) => onByDefault ? localStorage.getItem(key) !== "off" : localStorage.getItem(key) === "on";

    /* Appearance */
    const accent = el("div", { class: "accents" });
    const curAccent = localStorage.getItem("bento.accent") ?? "clay";
    for (const a of ACCENTS) {
      const b = el("button", { class: "accent-swatch" + (a.id === curAccent ? " on" : ""), title: a.label, "aria-label": a.label });
      b.style.setProperty("--sw", a.base);
      b.addEventListener("click", () => {
        localStorage.setItem("bento.accent", a.id);
        accent.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
        accentName.textContent = a.label;
        this.applyTheme();
      });
      accent.append(b);
    }
    // Any colour at all, via the system colour picker.
    const custom = el("button", { class: "accent-swatch custom" + (curAccent.startsWith("custom:") ? " on" : ""), title: "Custom colour…", "aria-label": "Custom colour" });
    if (curAccent.startsWith("custom:")) custom.style.setProperty("--sw", curAccent.slice(7));
    const picker = el("input", { type: "color", class: "accent-picker", value: curAccent.startsWith("custom:") ? curAccent.slice(7) : "#4f86c6" }) as HTMLInputElement;
    picker.addEventListener("input", () => {
      localStorage.setItem("bento.accent", `custom:${picker.value}`);
      custom.style.setProperty("--sw", picker.value);
      accent.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === custom));
      accentName.textContent = "Custom";
      this.applyTheme();
    });
    custom.addEventListener("click", () => picker.click());
    accent.append(custom, picker);
    const accentName = el("span", { class: "accent-name", text: curAccent.startsWith("custom:") ? "Custom" : ACCENTS.find((a) => a.id === curAccent)?.label ?? "Clay" });
    const grid = el("input", { type: "range", min: "0", max: "100", step: "5", class: "slider", value: String(Math.round(this.grid.gridAlpha * 100)) }) as HTMLInputElement;
    const gridVal = el("span", { class: "slider-val", text: `${grid.value}%` });
    const paintSlider = () => grid.style.setProperty("--fill", `${grid.value}%`);
    paintSlider();
    grid.addEventListener("input", () => {
      gridVal.textContent = `${grid.value}%`;
      paintSlider();
      localStorage.setItem("bento.gridOpacity", grid.value);
      this.grid.gridAlpha = Number(grid.value) / 100;
      this.grid.invalidate();
    });
    const appearance = el("div", { class: "psec" },
      row("Theme", `Follow ${osName}, or pick one.`, seg([["system", "System"], ["light", "Light"], ["dark", "Dark"]], this.theme(), (v) => this.setTheme(v as Theme))),
      row("Accent colour", "Selections, highlights and buttons.", el("div", { class: "accent-wrap" }, accent, accentName)),
      row("Gridlines", "How strongly the lines between cells show. The header edges always stay.", el("div", { class: "slider-wrap" }, grid, gridVal)),
      row("Toolbar", keys("Ctrl+Shift+F also shows and hides it."), sw(!document.getElementById("app")!.classList.contains("toolbar-hidden"), (v) => this.setToolbar(v))),
    );

    /* Editing */
    const cur = el("select", { class: "field" }) as HTMLSelectElement;
    const detected = detectCurrency().trim();
    cur.append(el("option", { value: "auto", text: `Automatic (${detected})` }));
    for (const [sym, name] of CURRENCIES) cur.append(el("option", { value: sym, text: `${sym.trim()}  ${name}` }));
    cur.value = localStorage.getItem("bento.currency") ?? "auto";
    cur.addEventListener("change", () => { localStorage.setItem("bento.currency", cur.value); this.refreshToolbar(); this.grid.invalidate(); });
    const editing = el("div", { class: "psec" },
      row("After Enter, move", "Where the selection goes when you finish typing in a cell.", seg([["down", "Down"], ["right", "Right"]], this.grid.enterRight ? "right" : "down", (v) => { localStorage.setItem("bento.enterMoves", v); this.grid.enterRight = v === "right"; })),
      row("Autocomplete", "Suggest matching text from the same column. Enter or Tab accepts; keep typing to ignore.", sw(flag("bento.autocomplete"), (v) => localStorage.setItem("bento.autocomplete", v ? "on" : "off"))),
      row("Currency", `Used by the $ button in the toolbar. Automatic follows your ${osName} region (${detected}).`, cur),
    );

    /* Saving */
    const saving = el("div", { class: "psec" },
      row("AutoSave", keys("Saved .bento files save themselves as you work. CSVs are never overwritten automatically — Ctrl+S saves them."), sw(flag("bento.autosave"), (v) => localStorage.setItem("bento.autosave", v ? "on" : "off"))),
      row("Crash recovery", "Unsaved work is always kept safe in the background and offered back if Bento closes unexpectedly.", el("span", { class: "pnote", text: "Always on" })),
    );

    /* About */
    const ver = el("span", { class: "pnote", text: "…" });
    appVersion().then((v) => (ver.textContent = v));
    const upd = el("button", { class: "btn", text: "Check now" });
    upd.addEventListener("click", () => { close(); $("check-btn").click(); });
    const keysBtn = el("button", { class: "btn", text: "Show" });
    keysBtn.addEventListener("click", () => { close(); this.shortcuts(); });
    const about = el("div", { class: "psec" },
      row("Version", "Bento updates itself from GitHub.", ver),
      ...(isTauriApp ? [row("Updates", "Look for a newer version now.", upd)] : []),
      row("Keyboard shortcuts", "Also on F1.", keysBtn),
    );

    const sections: [string, string, HTMLElement][] = [
      ["appearance", "Appearance", appearance],
      ["editing", "Editing", editing],
      ["saving", "Saving", saving],
      ["about", "About", about],
    ];
    const nav = el("nav", { class: "pnav" });
    const pane = el("div", { class: "ppane" });
    const head = el("h4", { class: "phead" });
    const show = (id: string) => {
      const sec = sections.find((x) => x[0] === id) ?? sections[0];
      nav.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.sec === sec[0]));
      head.textContent = sec[1];
      pane.replaceChildren(head, sec[2]);
    };
    for (const [id, label] of sections) {
      const b = el("button", { text: label, "data-sec": id });
      b.addEventListener("click", () => show(id));
      nav.append(b);
    }
    const x = el("button", { class: "icon-btn pclose", title: "Close (Esc)", "aria-label": "Close" });
    x.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg>';
    const box = el("div", { class: "modal prefs2", role: "dialog" },
      el("div", { class: "pside" }, el("h3", { text: "Preferences" }), nav),
      pane, x);
    const scrim = el("div", { class: "scrim" }, box);
    const close = () => { scrim.remove(); window.removeEventListener("keydown", onKey, true); this.grid.focus(); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
      else e.stopPropagation();
    };
    x.addEventListener("click", close);
    scrim.addEventListener("pointerdown", (e) => { if (e.target === scrim) close(); });
    window.addEventListener("keydown", onKey, true);
    show(section);
    document.body.append(scrim);
    box.tabIndex = -1;
    box.focus();
  }

  private shortcuts() {
    closeMenus();
    // "~" marks a mouse action (shown as text, not keys).
    const groups: [string, [string, string][]][] = [
      ["Editing", [
        ["Edit cell", "F2 / Enter"], ["New line in a cell", keys("Alt+Enter")], ["Confirm and move", "Enter / Tab"],
        ["Cancel editing", "Esc"], ["Clear cells", "Delete"], ["Fill down", keys("Ctrl+D")],
        ["Cycle $ in a reference", "F4"], ["Accept a function suggestion", "Tab"],
        ["Undo", keys("Ctrl+Z")], ["Redo", keys("Ctrl+Y")],
      ]],
      ["Clipboard", [
        ["Copy", keys("Ctrl+C")], ["Cut", keys("Ctrl+X")], ["Paste", keys("Ctrl+V")], ["Paste values only", keys("Ctrl+Shift+V")],
        ["Move cells", "~Drag the selection's edge"], ["Copy cells", keys("~Ctrl-drag the edge")],
      ]],
      ["Moving around", [
        ["Jump to edge of data", keys("Ctrl+Arrow")], ["Extend selection", "Shift+Arrow"], ["Select all", keys("Ctrl+A")],
        ["Go to a cell or range", keys("Ctrl+G")], ["Add another range", keys("~Ctrl-click")],
      ]],
      ["Formatting", [
        ["Bold", keys("Ctrl+B")], ["Italic", keys("Ctrl+I")], ["Underline", keys("Ctrl+U")], ["Strikethrough", keys("Alt+Shift+5")],
        ["Align left", keys("Ctrl+Shift+L")], ["Align centre", keys("Ctrl+Shift+E")], ["Align right", keys("Ctrl+Shift+R")],
        ["Clear formatting", keys("Ctrl+\\")],
      ]],
      ["Rows, columns & sheets", [
        ["Delete rows or columns", keys("Ctrl+Alt+−")], ["Next sheet", keys("Ctrl+PgDn")], ["Previous sheet", keys("Ctrl+PgUp")],
        ["Tick checkboxes", "Space"], ["Open a dropdown", keys("Alt+↓")],
      ]],
      ["Files & view", [
        ["New", keys("Ctrl+N")], ["Open", keys("Ctrl+O")], ["Save", keys("Ctrl+S")], ["Save as", keys("Ctrl+Shift+S")], ["Export CSV", keys("Ctrl+E")],
        ["Find", keys("Ctrl+F")], ["Find and replace", keys("Ctrl+H")], ["Next file", keys("Ctrl+Tab")], ["Close file", keys("Ctrl+W")],
        ["Zoom", keys("~Ctrl + scroll")], ["Hide the toolbar", keys("Ctrl+Shift+F")], ["Preferences", keys("Ctrl+,")],
      ]],
    ];
    const keyEl = (combo: string) => {
      const span = el("span", { class: "keys" });
      if (combo.startsWith("~")) { span.append(el("span", { class: "mouse", text: combo.slice(1) })); return span; }
      combo.split(" / ").forEach((alt, i) => {
        if (i) span.append(el("span", { class: "or", text: "or" }));
        // "Ctrl+B / I / U" style: later parts are just keys.
        if (isMac) {
          // "⇧⌘S": one key cap per symbol, no plus signs (the Mac way).
          const m = keys(alt).match(/^([⌃⌥⇧⌘]*)(.*)$/)!;
          for (const sym of m[1]) span.append(el("kbd", { text: sym }));
          if (m[2]) span.append(el("kbd", { text: m[2] === "Enter" ? "Return" : m[2] }));
          return;
        }
        alt.split("+").forEach((k, j) => {
          if (j) span.append(el("span", { class: "plus", text: "+" }));
          span.append(el("kbd", { text: k }));
        });
      });
      return span;
    };
    const cols = el("div", { class: "kgrid" });
    for (const [title, rows] of groups) {
      const sec = el("section", {}, el("h4", { text: title }));
      for (const [what, combo] of rows) sec.append(el("div", { class: "krow" }, el("span", { class: "what", text: what }), keyEl(combo)));
      cols.append(sec);
    }
    const x = el("button", { class: "icon-btn pclose", title: "Close (Esc)", "aria-label": "Close" });
    x.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg>';
    const box = el("div", { class: "modal shortcuts", role: "dialog" },
      el("h3", { text: "Keyboard shortcuts" }),
      el("p", { class: "ksub", text: "Formulas start with =, for example =SUM(B2:B100)." }),
      cols, x);
    const scrim = el("div", { class: "scrim" }, box);
    const close = () => { scrim.remove(); window.removeEventListener("keydown", onKey, true); this.grid.focus(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" || e.key === "Enter" || e.key === "F1") { e.preventDefault(); e.stopPropagation(); close(); } else e.stopPropagation(); };
    x.addEventListener("click", close);
    scrim.addEventListener("pointerdown", (e) => { if (e.target === scrim) close(); });
    window.addEventListener("keydown", onKey, true);
    document.body.append(scrim);
  }

  /** Data rows covered by the selection (filter-aware). */
  private selectedDataRows(): number[] {
    const d = this.active!;
    const s = selRect(d.sel);
    const out: number[] = [];
    for (let r = s.r0; r <= s.r1; r++) out.push(d.dataRow(r));
    return out;
  }

  private rowItems() {
    const d = this.active!;
    const s = selRect(d.sel);
    const n = s.r1 - s.r0 + 1;
    const rows = n === 1 ? "row" : `${formatInt(n)} rows`;
    const item = (label: string, action: () => void, extra: Partial<Extract<MenuItem, { label: string }>> = {}) => ({ label, action, icon: undefined, ...extra }) as Extract<MenuItem, { label: string }>;
    return {
      above: item(`Insert ${rows} above`, () => { d.insertRows(d.dataRow(s.r0), n, d.dataRow(s.r0)); this.afterStructure(); }, { icon: ROWCOL_ICONS.above }),
      below: item(`Insert ${rows} below`, () => {
        d.insertRows(d.dataRow(s.r1) + 1, n, d.dataRow(s.r1));
        this.grid.select({ ar: s.r1 + 1, ac: d.sel.ac, fr: s.r1 + n, fc: d.sel.fc }, false);
        this.afterStructure();
      }, { icon: ROWCOL_ICONS.below }),
      del: item(n === 1 ? "Delete row" : `Delete ${rows}`, () => { d.deleteRows(this.selectedDataRows()); this.afterStructure(); }, { danger: true }),
    };
  }

  private colItems() {
    const d = this.active!;
    const s = selRect(d.sel);
    const n = s.c1 - s.c0 + 1;
    const cols = n === 1 ? "column" : `${n} columns`;
    const item = (label: string, action: () => void, extra: Partial<Extract<MenuItem, { label: string }>> = {}) => ({ label, action, ...extra }) as Extract<MenuItem, { label: string }>;
    return {
      left: item(`Insert ${cols} left`, () => { d.insertCols(s.c0, n, s.c0); this.afterStructure(); }, { icon: ROWCOL_ICONS.left }),
      right: item(`Insert ${cols} right`, () => {
        d.insertCols(s.c1 + 1, n, s.c1);
        this.grid.select({ ar: d.sel.ar, ac: s.c1 + 1, fr: d.sel.fr, fc: s.c1 + n }, false);
        this.afterStructure();
      }, { icon: ROWCOL_ICONS.right }),
      del: item(n === 1 ? "Delete column" : `Delete ${cols}`, () => { d.deleteCols(s.c0, n); this.afterStructure(); }, { danger: true }),
    };
  }

  /** Cut / Copy / Paste / Paste special. */
  private clipboardItems(): MenuItem[] {
    return [
      { label: "Cut", key: keys("Ctrl+X"), action: () => this.clipboardWrite(this.grid.copy(true)) },
      { label: "Copy", key: keys("Ctrl+C"), action: () => this.clipboardWrite(this.grid.copy()) },
      { label: "Paste", key: keys("Ctrl+V"), action: () => this.clipboardPaste() },
      { label: "Paste special", children: [
        { label: "Values only", key: keys("Ctrl+Shift+V"), action: () => this.clipboardPaste("values") },
        { label: "Formatting only", action: () => this.clipboardPaste("format") },
        { label: "Without formatting", action: () => this.clipboardPaste("plain") },
        "sep",
        { label: "Transposed", action: () => this.clipboardPaste("transpose") },
      ] },
    ];
  }

  private contextMenu(zone: "cell" | "col" | "row" | "corner", x: number, y: number) {
    const d = this.active;
    if (!d || d.loading !== null) return;
    if (zone === "col") { this.columnMenu(x, y); return; }
    if (zone === "row") { this.rowMenu(x, y); return; }
    if (zone === "corner") {
      showMenu([
        { label: "Select all", key: keys("Ctrl+A"), action: () => this.grid.selectAll() },
        { label: "Clear all filters", disabled: !d.filters.size, action: () => { d.clearFilters(); this.afterStructure(); } },
        { label: "Unhide all rows", disabled: !d.hiddenRowCount(), action: () => this.unhideRows() },
        { label: "Unhide all columns", disabled: !d.hidden.size, action: () => { d.setColumnsHidden("all", false); this.onChange(); } },
      ], x, y);
      return;
    }
    const rows = this.rowItems(), cols = this.colItems();
    const st = d.style(d.dataRow(d.sel.ar), d.sel.ac);
    const extras: MenuItem[] = [];
    if (st.list) extras.push({ label: "Edit dropdown…", action: () => this.dropdownDialog() });
    if (this.selectionHasChecks()) extras.push({ label: "Remove checkboxes", action: () => this.applyFormat((s) => ({ ...s, check: undefined }), "Remove checkboxes") });
    showMenu([
      ...this.clipboardItems(),
      "sep",
      { label: "Insert", children: [
        rows.above, rows.below, cols.left, cols.right,
        "sep",
        ...this.insertItems(),
      ] },
      { label: "Delete", children: [rows.del, cols.del] },
      { label: "Clear", children: [
        { label: "Contents", key: "Delete", action: () => this.grid.clear() },
        { label: "Formatting", key: keys("Ctrl+\\"), action: () => this.applyFormat(() => ({}), "Clear formatting") },
        { label: "Everything", action: () => { this.grid.clear(); this.applyFormat(() => ({}), "Clear formatting"); } },
      ] },
      "sep",
      ...this.sortRangeItems(),
      { label: "Formula", children: this.formulaItems() },
      ...extras,
      { label: "Fill down", key: keys("Ctrl+D"), action: () => this.grid.fillDown() },
    ], x, y);
  }

  /* ------------------------------- formulas ------------------------------- */

  /** The Σ menu: quick totals, then every function by category, then the tools. */
  private functionMenu(): MenuItem[] {
    const cats = ["Math", "Statistics", "Logic", "Lookup", "Text", "Date", "Finance", "Array", "Database", "Engineering", "Info", "Lambda"] as const;
    const label: Record<string, string> = { Math: "Maths", Statistics: "Statistics", Logic: "Logic", Lookup: "Lookup", Text: "Text", Date: "Date & time", Finance: "Finance", Array: "Arrays", Database: "Database", Engineering: "Engineering", Info: "Information", Lambda: "LET & LAMBDA" };
    const seen = new Set<string>();
    const byCat = (cat: string): MenuItem[] => Object.keys(FUNCS).sort()
      .filter((n) => FUNCS[n].cat === cat && !seen.has(FUNCS[n].sig))
      .map((n) => { seen.add(FUNCS[n].sig); return { label: n, action: () => this.insertFunction(n) } as MenuItem; });
    return [
      ...["SUM", "AVERAGE", "COUNT", "MIN", "MAX"].map((fn) => ({ label: fn[0] + fn.slice(1).toLowerCase(), key: fn, action: () => this.autoSum(fn) }) as MenuItem),
      "sep",
      ...cats.map((c) => ({ label: label[c], children: byCat(c) }) as MenuItem),
      "sep",
      ...this.formulaItems(),
    ];
  }

  private formulaItems(): MenuItem[] {
    const d = this.active!;
    const isFormula = d.raw(d.dataRow(d.sel.ar), d.sel.ac).startsWith("=");
    return [
      { label: "Evaluate formula…", disabled: !isFormula, action: () => this.evaluateFormula() },
      { label: "Trace precedents", disabled: !isFormula, action: () => this.trace("precedents") },
      { label: "Trace dependents", action: () => this.trace("dependents") },
      { label: "Remove arrows", disabled: !this.grid.hasTraces, action: () => this.grid.setTraces([]) },
      "sep",
      { label: "Name this range…", action: () => this.nameSelection() },
      { label: "Named ranges…", action: () => this.openNames() },
    ];
  }

  /** Start (or add to) a formula with a function. */
  private insertFunction(name: string) {
    const d = this.active;
    if (!d) return;
    const f = document.activeElement === this.cellInput ? this.cellInput : this.grid.editing ? this.grid.editor : null;
    if (f && f.value.startsWith("=")) {
      const a = f.selectionStart ?? f.value.length, b = f.selectionEnd ?? a;
      f.value = f.value.slice(0, a) + name + "(" + f.value.slice(b);
      f.focus();
      f.setSelectionRange(a + name.length + 1, a + name.length + 1);
      f.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    this.grid.startEdit("replace", `=${name}(`);
    this.grid.editor.dispatchEvent(new Event("input", { bubbles: true }));
  }

  private evaluateFormula() {
    const d = this.active;
    if (!d) return;
    if (this.grid.editing) this.grid.commitEdit();
    evaluateDialog(d, d.dataRow(d.sel.ar), d.sel.ac, () => this.grid.focus());
  }

  /** Arrows from the cells a formula reads, or to the formulas that read this cell. */
  private trace(kind: "precedents" | "dependents") {
    const d = this.active;
    if (!d) return;
    if (d.view) { toast("Clear filters and show hidden rows to trace cells"); return; }
    const r = d.dataRow(d.sel.ar), c = d.sel.ac;
    const here = { r, c };
    const elsewhere: string[] = [];
    const list: { from: { r1: number; c1: number; r2: number; c2: number }; to: { r: number; c: number } }[] = [];
    if (kind === "precedents") {
      for (const ref of Engine.references(d.raw(r, c))) {
        if (ref.sheet && ref.sheet.toLowerCase() !== d.sheetName.toLowerCase()) { elsewhere.push(`${ref.sheet}`); continue; }
        list.push({ from: ref, to: here });
      }
      if (!list.length && !elsewhere.length) { toast("This formula doesn't read any cells"); return; }
    } else {
      for (const [fr, fc] of d.engine.dependentsOf(r, c)) list.push({ from: { r1: r, c1: c, r2: r, c2: c }, to: { r: fr, c: fc } });
      for (const s of d.book.sheets) if (s !== d && s.engine.dependentsOf(r, c, d.sheetName).length) elsewhere.push(s.sheetName);
      if (!list.length && !elsewhere.length) { toast("No formulas use this cell"); return; }
    }
    this.grid.setTraces(list);
    if (elsewhere.length) toast(`${kind === "precedents" ? "Also reads cells on" : "Also used by formulas on"} ${[...new Set(elsewhere)].map((n) => `"${n}"`).join(", ")}`);
  }

  private selectionRef(): string {
    const d = this.active!;
    const s = selRect(d.sel);
    const rect = { r0: d.dataRow(s.r0), c0: s.c0, r1: d.dataRow(s.r1), c1: s.c1 };
    return absRef(d, rect, { cols: this.grid.isWholeCols(s), rows: this.grid.isWholeRows(s) });
  }

  private nameSelection() {
    const d = this.active;
    if (!d) return;
    const box = $("cell-name") as HTMLInputElement;
    box.focus();
    box.value = "";
    box.placeholder = "Type a name, then Enter";
    setTimeout(() => (box.placeholder = ""), 4000);
  }

  private openNames() {
    const d = this.active;
    if (!d) return;
    namesDialog(d, this.selectionRef(), () => { this.grid.invalidate(); this.onSelection(); }, (ref) => this.goTo(ref));
  }

  private selectionHasChecks(): boolean {
    const d = this.active!;
    for (const rect of allRects(d.sel))
      for (let r = rect.r0; r <= Math.min(rect.r1, rect.r0 + 2000); r++)
        for (let c = rect.c0; c <= Math.min(rect.c1, rect.c0 + 200); c++) if (d.style(d.dataRow(r), c).check) return true;
    return false;
  }

  private columnMenu(x: number, y: number) {
    const d = this.active;
    if (!d || d.loading !== null) return;
    const s = selRect(d.sel);
    const c = d.sel.ac;
    const n = s.c1 - s.c0 + 1;
    const what = n === 1 ? "column" : `${n} columns`;
    const cols = this.colItems();
    const hideRange = () => {
      d.setColumnsHidden(Array.from({ length: s.c1 - s.c0 + 1 }, (_, k) => s.c0 + k), true);
      // Move the selection off the hidden columns.
      const next = s.c1 + 1 < d.displayCols() ? s.c1 + 1 : Math.max(0, s.c0 - 1);
      this.grid.select({ ar: d.sel.ar, ac: next, fr: d.sel.ar, fc: next }, false);
      this.onChange();
    };
    showMenu([
      ...this.clipboardItems(),
      "sep",
      cols.left, cols.right,
      { ...cols.del, label: `Delete ${what}` },
      { label: `Clear ${what}`, action: () => this.grid.clear() },
      { label: `Hide ${what}`, action: hideRange },
      { label: `Resize ${what}…`, action: () => this.resizeDialog("col") },
      "sep",
      { label: "Sort sheet A → Z", action: () => this.sort(d, c, false) },
      { label: "Sort sheet Z → A", action: () => this.sort(d, c, true) },
      "sep",
      { label: "More", children: [
        { label: d.filters.has(c) ? "Edit filter…" : "Filter…", action: () => openFilter(d, c, x, y, () => this.afterStructure()) },
        ...(d.filters.has(c) ? [{ label: "Remove filter", action: () => { d.setFilter(c, null); this.afterStructure(); } } as MenuItem] : []),
        "sep",
        { label: `Freeze up to column ${colName(s.c1)}`, action: () => { d.setFrozen(d.frozenRows, s.c1 + 1); this.afterFreeze(); } },
        { label: "Unfreeze columns", disabled: !d.frozenCols, action: () => { d.setFrozen(d.frozenRows, 0); this.afterFreeze(); } },
        { label: "Unhide all columns", disabled: !d.hidden.size, action: () => { d.setColumnsHidden("all", false); this.onChange(); } },
      ] },
    ], x, y);
  }

  private rowMenu(x: number, y: number) {
    const d = this.active;
    if (!d || d.loading !== null) return;
    const s = selRect(d.sel);
    const n = s.r1 - s.r0 + 1;
    const what = n === 1 ? "row" : `${formatInt(n)} rows`;
    const rows = this.rowItems();
    const c = d.sel.ac;
    const lastRow = d.dataRow(s.r1) + 1;
    showMenu([
      ...this.clipboardItems(),
      "sep",
      rows.above, rows.below,
      { ...rows.del, label: `Delete ${what}` },
      { label: `Clear ${what}`, action: () => this.grid.clear() },
      { label: `Hide ${what}`, action: () => this.hideRows() },
      { label: `Resize ${what}…`, action: () => this.resizeDialog("row") },
      "sep",
      { label: "Sort sheet A → Z", key: `by ${colName(c)}`, action: () => this.sort(d, c, false) },
      { label: "Sort sheet Z → A", key: `by ${colName(c)}`, action: () => this.sort(d, c, true) },
      "sep",
      { label: "More", children: [
        { label: `Freeze up to row ${formatInt(lastRow)}`, action: () => { d.setFrozen(lastRow, d.frozenCols); this.afterFreeze(); } },
        { label: "Unfreeze rows", disabled: !d.frozenRows, action: () => { d.setFrozen(0, d.frozenCols); this.afterFreeze(); } },
        { label: "Unhide all rows", disabled: !d.hiddenRowCount(), action: () => this.unhideRows() },
      ] },
    ], x, y);
  }

  private hideRows() {
    const d = this.active!;
    const rows = this.selectedDataRows().filter((r) => r < d.rows.length || (d.rows.length <= r && false));
    // Rows past the data need to exist before they can be hidden.
    const s = selRect(d.sel);
    const want = rows.length ? rows : [];
    if (!want.length) for (let r = s.r0; r <= s.r1; r++) want.push(d.dataRow(r));
    const lastWanted = maxOf(want, -1);
    while (d.rows.length <= lastWanted) d.rows.push(new Array(d.cols).fill(""));
    if (want.length >= d.displayRows()) { toast("At least one row has to stay visible"); return; }
    d.setRowsHidden(want, true);
    this.grid.select({ ar: s.r0, ac: d.sel.ac, fr: s.r0, fc: d.sel.ac }, false);
    this.afterStructure();
    toast(`${want.length === 1 ? "Row" : `${formatInt(want.length)} rows`} hidden — right-click a row number → More to unhide`);
  }

  private unhideRows() {
    const d = this.active!;
    d.setRowsHidden("all", false);
    this.afterStructure();
  }

  /** Type a width/height, or fit to the content. */
  private resizeDialog(axis: "col" | "row") {
    const d = this.active;
    if (!d) return;
    const s = selRect(d.sel);
    const z = this.grid.zoom;
    void z;
    const isCol = axis === "col";
    const n = isCol ? s.c1 - s.c0 + 1 : s.r1 - s.r0 + 1;
    const current = isCol ? d.width(s.c0) : (d.rowHeight(d.dataRow(s.r0)) || 22);
    const title = isCol
      ? (n === 1 ? `Resize column ${colName(s.c0)}` : `Resize columns ${colName(s.c0)}–${colName(s.c1)}`)
      : (n === 1 ? `Resize row ${formatInt(d.dataRow(s.r0) + 1)}` : `Resize rows ${formatInt(d.dataRow(s.r0) + 1)}–${formatInt(d.dataRow(s.r1) + 1)}`);
    const input = el("input", { class: "field num", type: "number", min: isCol ? "20" : "12", max: isCol ? "2000" : "1000", value: String(Math.round(current)) }) as HTMLInputElement;
    const mode = { v: "set" as "set" | "fit" };
    const setOpt = el("label", { class: "radio" }, el("input", { type: "radio", name: "rz", checked: "" }), el("span", { text: isCol ? "Width" : "Height" }), el("span", { class: "with-unit" }, input, el("span", { class: "unit", text: "px" })));
    const fitOpt = el("label", { class: "radio" }, el("input", { type: "radio", name: "rz" }), el("span", { text: isCol ? "Fit width to content" : "Fit height to content" }));
    const radios = [setOpt, fitOpt].map((l) => l.querySelector("input") as HTMLInputElement);
    radios[0].addEventListener("change", () => { mode.v = "set"; input.focus(); });
    radios[1].addEventListener("change", () => { mode.v = "fit"; });
    input.addEventListener("focus", () => { radios[0].checked = true; mode.v = "set"; });
    const apply = () => {
      if (mode.v === "set") {
        const v = Number(input.value);
        if (!Number.isFinite(v) || v <= 0) { input.focus(); return false; }
        if (isCol) {
          const before = new Map(d.widths);
          for (let c = s.c0; c <= s.c1; c++) d.widths.set(c, clamp(Math.round(v), 20, 2000));
          d.commitWidths(before, "Resize columns");
          this.grid.invalidate();
          this.onChange();
        }
        else { d.setRowHeights(this.selectedDataRows(), clamp(Math.round(v), 12, 1000)); this.onChange(); }
      } else {
        if (isCol) for (let c = s.c0; c <= s.c1; c++) this.grid.autoFit(c);
        else { d.setRowHeights(this.selectedDataRows(), null, "Fit rows"); this.onChange(); }
      }
      return true;
    };
    formDialog(title, el("div", { class: "resize-opts" }, setOpt, fitOpt), "OK", apply, () => this.grid.focus());
    input.select();
  }

  /* ------------------------------- inserting ------------------------------- */

  /** Chart / image / shape / dropdown / checkbox items for the cell menu. */
  private insertItems(): MenuItem[] {
    return [
      { label: "Chart", icon: CHART_ICONS.column, children: CHART_TYPES.map(({ type, label }) => ({ label, icon: CHART_ICONS[type], action: () => this.insertChart(type) })) },
      { label: "Image", icon: IMG_ICONS.cell, children: [
        { label: "In cell", icon: IMG_ICONS.cell, action: () => this.pickImage("cell") },
        { label: "Over cells", icon: IMG_ICONS.over, action: () => this.pickImage("over") },
      ] },
      { label: "Shape", icon: SHAPES[1].icon, children: SHAPES.map(({ shape, label, icon }) => ({ label, icon, action: () => this.insertShape(shape) }) as MenuItem) },
      { label: "Text box", icon: IMG_ICONS.text, action: () => this.insertShape("text") },
      "sep",
      { label: "Dropdown…", icon: IMG_ICONS.dropdown, action: () => this.dropdownDialog() },
      { label: "Checkbox", icon: IMG_ICONS.check, action: () => this.insertCheckboxes() },
    ];
  }

  /** A good spot for something new: right of the selection if that's in view, else mid-screen. */
  private placement(w: number, h: number, beside: boolean, around?: { r0: number; c0: number; r1: number; c1: number }) {
    const at = this.placementRaw(w, h, beside, around);
    // Don't stack exactly on top of something already there.
    const d = this.active!;
    for (let k = 0; k < 20 && d.objects.some((o) => o.r === at.r && o.c === at.c && Math.abs(o.dx - at.dx) < 4 && Math.abs(o.dy - at.dy) < 4); k++) { at.dx += 24; at.dy += 24; }
    return at;
  }

  private placementRaw(w: number, h: number, beside: boolean, around?: { r0: number; c0: number; r1: number; c1: number }) {
    const g = this.grid, d = this.active!;
    const s = around ?? selRect(d.sel);
    const vp = g.viewport();
    const z = g.zoom;
    if (beside) {
      const x = g.colLeft(s.c1) + g.colWidth(s.c1) + 16 * z;
      const y = Math.max(g.headerHeight + 8, g.rowTop(s.r0));
      if (x + w * z < vp.w - 8 && y + 40 < vp.h) return this.objects.anchorAt(x, y);
    } else {
      const x = g.colLeft(s.c0), y = g.rowTop(s.r0);
      if (x >= g.rowHeaderWidth() && x + 40 < vp.w && y >= g.headerHeight && y + 40 < vp.h) {
        // Nudge it back so it's fully on screen.
        const fx = Math.max(g.rowHeaderWidth() + 8, Math.min(x + 4 * z, vp.w - w * z - 16));
        const fy = Math.max(g.headerHeight + 8, Math.min(y + 4 * z, vp.h - h * z - 16));
        return this.objects.anchorAt(fx, fy);
      }
    }
    const cx = Math.max(g.rowHeaderWidth() + 8, (g.rowHeaderWidth() + vp.w - w * z) / 2);
    const cy = Math.max(g.headerHeight + 8, (g.headerHeight + vp.h - h * z) / 2);
    return this.objects.anchorAt(cx, cy);
  }

  private insertChart(chart: ChartType) {
    const d = this.active;
    if (!d) return;
    if (this.grid.editing) this.grid.commitEdit();
    let s = selRect(d.sel);
    let rect = { r0: d.dataRow(s.r0), c0: s.c0, r1: d.dataRow(Math.min(s.r1, this.grid.lastRow())), c1: s.c1 };
    // One cell selected: chart the block of data around it.
    if (s.r0 === s.r1 && s.c0 === s.c1) rect = dataRegion(d, d.dataRow(s.r0), s.c0);
    if (this.grid.isWholeCols(s)) rect.r1 = Math.max(0, d.rows.length - 1);
    if (this.grid.isWholeRows(s)) rect.c1 = Math.max(0, d.cols - 1);
    s = rect;
    const w = 440, h = 280;
    // Beside the data (in display rows; the range is in data rows).
    const shown = d.displayRow(s.r0);
    const at = this.placement(w, h, true, { r0: shown >= 0 ? shown : selRect(d.sel).r0, c0: s.c0, r1: s.r1, c1: s.c1 });
    const range = rangeText(s);
    const data = chartData(d, range);
    // One series: name the chart after it, like Sheets.
    const title = data && (data.series.length === 1 || chart === "pie") && !/^Series \d+$/.test(data.series[0].name) ? data.series[0].name : undefined;
    this.objects.add({ kind: "chart", chart, range, title, ...at, w, h } as Omit<ChartObject, "id">, "Insert chart");
  }

  private insertShape(shape: ShapeType) {
    const d = this.active;
    if (!d) return;
    if (this.grid.editing) this.grid.commitEdit();
    const text = shape === "text";
    const w = text ? 180 : 150, h = text ? 44 : 96;
    const at = this.placement(w, h, false);
    const o = this.objects.add({
      kind: "shape", shape, ...at, w, h,
      fill: text ? undefined : "@orange-1", stroke: text ? undefined : "@orange", text: text ? "Text" : "",
    } as Omit<ShapeObject, "id">, text ? "Insert text box" : "Insert shape");
    if (text) requestAnimationFrame(() => this.objects.editText(o.id));
  }

  /** Ask for a picture file. */
  private pickImage(mode: "cell" | "over") {
    const input = el("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp,image/bmp,image/svg+xml" }) as HTMLInputElement;
    input.addEventListener("change", () => { const f = input.files?.[0]; if (f) this.insertImageFile(f, mode); });
    input.click();
  }

  private async insertImageRef(ref: import("./native").FileRef) {
    try {
      const bytes = await readFile(ref);
      const ext = ref.name.split(".").pop()!.toLowerCase();
      const type = ext === "jpg" ? "image/jpeg" : ext === "svg" ? "image/svg+xml" : `image/${ext}`;
      await this.insertImageFile(new File([bytes as Uint8Array<ArrayBuffer>], ref.name, { type }), "over");
    } catch (e) { toast(`Couldn't read ${ref.name}: ${e}`, true); }
  }

  async insertImageFile(file: Blob, mode: "cell" | "over") {
    const d = this.active;
    if (!d) return;
    if (this.grid.editing) this.grid.commitEdit();
    let img: { url: string; w: number; h: number };
    try { img = await loadImage(file); } catch { toast("That image couldn't be opened", true); return; }
    const id = d.addImage(img.url);
    if (mode === "cell") {
      const r = d.dataRow(d.sel.ar), c = d.sel.ac;
      const cur = d.style(r, c);
      d.setCells([{ r, c, v: "", style: d.intern({ ...cur, img: id, check: undefined, list: undefined }) }], "Insert image");
      this.onChange();
      return;
    }
    // Over cells: natural size, scaled down to fit comfortably.
    const scale = Math.min(1, 420 / img.w, 300 / img.h);
    const w = Math.max(24, Math.round(img.w * scale)), h = Math.max(24, Math.round(img.h * scale));
    this.objects.add({ kind: "image", img: id, ...this.placement(w, h, false), w, h } as Omit<SheetObject, "id">, "Insert image");
  }

  private insertCheckboxes() {
    const d = this.active;
    if (!d) return;
    if (this.grid.editing) this.grid.commitEdit();
    const cells: { r: number; c: number; v?: string; style?: number }[] = [];
    const cache = new Map<number, number>();
    for (const rect of allRects(d.sel)) {
      const r1 = this.grid.isWholeCols(rect) ? Math.max(rect.r0, Math.min(rect.r1, Math.max(d.rows.length, 100) - 1)) : rect.r1;
      if ((r1 - rect.r0 + 1) * (rect.c1 - rect.c0 + 1) > 200_000) { toast("That's too many cells for checkboxes", true); return; }
      for (let r = rect.r0; r <= r1; r++) {
        if (d.view && r >= d.view.length) break;
        const dr = d.dataRow(r);
        for (let c = rect.c0; c <= rect.c1; c++) {
          const id = d.styleId(dr, c);
          let next = cache.get(id);
          if (next === undefined) { const { list: _l, img: _i, ...rest } = d.styles[id] ?? {}; next = d.intern({ ...rest, check: true }); cache.set(id, next); }
          const raw = d.raw(dr, c).trim().toUpperCase();
          cells.push({ r: dr, c, style: next, v: raw === "TRUE" ? "TRUE" : "FALSE" });
        }
      }
    }
    d.setCells(cells, "Insert checkboxes");
    this.onChange();
  }

  /** Set up (or change, or remove) a dropdown on the selected cells. */
  private dropdownDialog() {
    const d = this.active;
    if (!d) return;
    if (this.grid.editing) this.grid.commitEdit();
    const existing = d.style(d.dataRow(d.sel.ar), d.sel.ac).list;
    let options = existing ?? [];
    if (!options.length) {
      // Suggest what's already in the selection.
      const seen = new Set<string>();
      for (const rect of allRects(d.sel)) for (let r = rect.r0; r <= Math.min(rect.r1, this.grid.lastRow()) && seen.size < 40; r++)
        for (let c = rect.c0; c <= rect.c1 && seen.size < 40; c++) { const v = d.display(d.dataRow(r), c).trim(); if (v) seen.add(v); }
      options = seen.size ? [...seen] : ["Option 1", "Option 2"];
    }
    const prev = document.activeElement as HTMLElement | null;
    const area = el("textarea", { class: "options", spellcheck: "false", rows: "7" }) as HTMLTextAreaElement;
    area.value = options.join("\n");
    const foot = el("div", { class: "foot" });
    const box = el("div", { class: "modal dropdown-dialog", role: "dialog" },
      el("h3", { text: existing ? "Edit dropdown" : "Dropdown" }),
      el("p", { text: "One choice per line." }),
      area, foot);
    const scrim = el("div", { class: "scrim" }, box);
    const done = (list: string[] | null | undefined) => {
      scrim.remove();
      window.removeEventListener("keydown", onKey, true);
      prev?.focus();
      if (list === undefined) return;
      this.applyFormat((s) => ({ ...s, list: list ?? undefined, check: undefined }), list ? (existing ? "Edit dropdown" : "Insert dropdown") : "Remove dropdown");
      this.grid.focus();
    };
    const apply = () => {
      const list = [...new Set(area.value.split("\n").map((x) => x.trim()).filter(Boolean))];
      done(list.length ? list : null);
    };
    if (existing) {
      const rm = el("button", { class: "btn danger-text", text: "Remove" });
      rm.addEventListener("click", () => done(null));
      foot.append(rm, el("div", { class: "grow" }));
    }
    const cancel = el("button", { class: "btn", text: "Cancel" });
    const ok = el("button", { class: "btn primary", text: "Done" });
    cancel.addEventListener("click", () => done(undefined));
    ok.addEventListener("click", apply);
    foot.append(cancel, ok);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(undefined); }
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); apply(); }
      else e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    document.body.append(scrim);
    area.focus();
    area.select();
  }

  /** The choices of a dropdown cell. */
  private dropdownMenu(r: number, c: number, x: number, y: number) {
    const d = this.active;
    if (!d) return;
    const dr = d.dataRow(r);
    const list = d.style(dr, c).list ?? [];
    const cur = d.display(dr, c);
    showMenu([
      ...list.map((v) => ({ label: v, checked: v === cur, action: () => { d.setCells([{ r: dr, c, v }], "Choose"); this.onChange(); } }) as MenuItem),
      ...(cur ? ["sep", { label: "Clear", action: () => { d.setCells([{ r: dr, c, v: "" }], "Clear"); this.onChange(); } }] as MenuItem[] : []),
      "sep",
      { label: "Edit dropdown…", action: () => this.dropdownDialog() },
    ], x, y, () => this.grid.focus());
  }

  /* -------------------------------- objects -------------------------------- */

  private objectMenu(o: SheetObject, x: number, y: number) {
    const L = this.objects;
    const swatches = (current: string | undefined, apply: (v: string | undefined) => void, tone: "" | "-1" | "-2"): MenuItem[] => {
      const theme = (document.documentElement.dataset.theme ?? "light") as "light" | "dark" | "dusk";
      return [
        { label: "None", checked: !current, action: () => apply(undefined) },
        "sep",
        ...HUES.map((h) => {
          const token = `@${h}${tone}`;
          return { label: colorLabel(h), checked: current === token, icon: dot(resolveColor(token, theme) ?? "transparent", resolveColor(`@${h}`, theme) ?? "transparent"), action: () => apply(token) } as MenuItem;
        }),
      ];
    };
    const items: MenuItem[] = [];
    if (o.kind === "chart") {
      items.push({ label: "Edit chart…", action: () => this.chartEditor(o) });
      items.push({ label: "Chart type", children: CHART_TYPES.map(({ type, label }) => ({ label, icon: CHART_ICONS[type], checked: o.chart === type, action: () => L.update(o.id, { chart: type }, "Chart type") }) as MenuItem) });
      items.push("sep");
    }
    if (o.kind === "shape") {
      items.push({ label: "Edit text", key: "Enter", action: () => L.editText(o.id) });
      if (o.shape !== "text") {
        items.push({ label: "Fill colour", children: swatches(o.fill, (v) => L.update(o.id, { fill: v }, "Fill colour"), "-1") });
        items.push({ label: "Border colour", children: swatches(o.stroke, (v) => L.update(o.id, { stroke: v }, "Border colour"), "") });
      }
      items.push({ label: "Text colour", children: swatches(o.color, (v) => L.update(o.id, { color: v }, "Text colour"), "") });
      items.push("sep");
    }
    items.push(
      { label: "Duplicate", key: keys("Ctrl+D"), action: () => L.duplicate(o.id) },
      { label: "Bring to front", action: () => L.order(o.id, true) },
      { label: "Send to back", action: () => L.order(o.id, false) },
      "sep",
      { label: "Delete", key: "Delete", danger: true, action: () => L.remove(o.id) },
    );
    showMenu(items, x, y);
  }

  /** A small panel beside a chart: type, data range and title. Changes show live; one undo step. */
  private chartEditor(o: ChartObject) {
    const d = this.active;
    const node = document.querySelector<HTMLElement>(`#objects .obj.selected`);
    if (!d || !node) return;
    const before = d.snapshotObjects();
    const live = () => d.objects.find((x) => x.id === o.id) as ChartObject | undefined;
    const set = (patch: Partial<ChartObject>) => { const x = live(); if (x) { Object.assign(x, patch); this.grid.invalidate(); } };
    const types = el("div", { class: "segmented chart-types" });
    const refresh = () => types.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.type === live()?.chart));
    for (const { type, label } of CHART_TYPES) {
      const b = el("button", { title: label, "data-type": type });
      b.innerHTML = CHART_ICONS[type] + `<span>${label}</span>`;
      b.addEventListener("click", () => { set({ chart: type }); refresh(); });
      types.append(b);
    }
    refresh();
    const range = el("input", { class: "field", spellcheck: "false", value: o.range }) as HTMLInputElement;
    const title = el("input", { class: "field", spellcheck: "false", placeholder: "No title", value: o.title ?? "" }) as HTMLInputElement;
    range.addEventListener("input", () => {
      const ok = !!parseRange(range.value);
      range.classList.toggle("bad", !ok);
      if (ok) set({ range: range.value.trim().toUpperCase().replace(/\$/g, "") });
    });
    title.addEventListener("input", () => set({ title: title.value || undefined }));
    for (const inp of [range, title]) inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); close(); } e.stopPropagation(); });
    const useSel = el("button", { class: "link", text: "Use selection" });
    useSel.addEventListener("click", () => {
      const s = selRect(d.sel);
      range.value = rangeText({ r0: d.dataRow(s.r0), c0: s.c0, r1: d.dataRow(Math.min(s.r1, this.grid.lastRow())), c1: s.c1 });
      range.dispatchEvent(new Event("input"));
    });
    const panel = el("div", { class: "chart-editor" },
      el("div", { class: "row" }, types),
      el("label", {}, el("span", { class: "cap" }, "Data", useSel), range),
      el("label", {}, el("span", { class: "cap", text: "Title" }), title),
    );
    const close = showPopover(node, panel, () => { d.commitObjects(before, "Edit chart"); this.onChange(); });
    // Sit beside the chart rather than under it.
    const pop = panel.parentElement as HTMLElement;
    const a = node.getBoundingClientRect(), p = pop.getBoundingClientRect();
    let left = a.right + 8;
    if (left + p.width > window.innerWidth - 8) left = a.left - p.width - 8;
    if (left < 8) left = Math.min(window.innerWidth - p.width - 8, Math.max(8, a.left + 8));
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.max(48, Math.min(a.top, window.innerHeight - p.height - 8))}px`;
    range.focus();
    range.select();
  }

  private async clipboardWrite(text: string | null) {
    if (text === null) return; // the grid has already said why
    try { await navigator.clipboard.writeText(text); } catch { toast(keys("Couldn't reach the clipboard — try Ctrl+C"), true); }
    this.onChange();
  }

  private async clipboardPaste(mode: PasteMode = "normal") {
    try {
      const t = await navigator.clipboard.readText();
      if (t) this.grid.paste(t, mode);
    } catch {
      toast(keys("Use Ctrl+V to paste"));
    }
  }

  /* ------------------------------- bindings ------------------------------- */

  /** Fold the toolbar away (and back). Remembered between launches. */
  private setToolbar(show: boolean) {
    localStorage.setItem("bento.toolbar", show ? "shown" : "hidden");
    document.getElementById("app")!.classList.toggle("toolbar-hidden", !show);
    const b = $("toolbar-toggle");
    b.title = show ? keys("Hide the toolbar (Ctrl+Shift+F)") : keys("Show the toolbar (Ctrl+Shift+F)");
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
    // On a Mac the window keeps its own traffic-light buttons (top left).
    if (isMac) document.documentElement.classList.add("mac");
    const sys = document.querySelector<HTMLElement>('[data-theme-opt="system"]');
    if (sys) sys.title = `Match ${osName}`;
    localiseTitles();
  }

  /**
   * Go To: jump to "B12", "A1:C9", "C" or "C:E" (columns), "12" or "3:8"
   * (rows), optionally prefixed by a sheet ("Totals!A1"), or just a sheet name.
   */
  private goTo(text: string, depth = 0): boolean {
    let t = text.trim();
    let d = this.active;
    if (!d || !t) return false;
    const bang = t.lastIndexOf("!");
    const findSheet = (n: string) => d!.book.sheets.find((x) => x.sheetName.toLowerCase() === n.toLowerCase());
    if (bang > 0) {
      const target = findSheet(t.slice(0, bang).replace(/^'(.*)'$/, "$1"));
      if (!target) return false;
      if (target !== d) { this.showSheet(target); d = target; }
      t = t.slice(bang + 1);
    } else {
      const target = findSheet(t);
      if (target && !/^[A-Za-z]{1,3}\d*$/.test(t)) { if (target !== d) this.showSheet(target); return true; }
    }
    // Defined names win over things that merely look like columns (QTY).
    if (d.book.names.has(t.toUpperCase()) && depth < 3) return this.goTo(d.book.names.get(t.toUpperCase())!.ref, depth + 1);
    if (/^[A-Za-z]{3}$/.test(t)) return false; // "QTY": a name, not column QTY
    const up = t.toUpperCase().replace(/\$/g, "");
    const R = this.grid.fullRow(), C = this.grid.fullCol();
    const row = (n: string) => { const r = d!.displayRow(Number(n) - 1); return r; };
    let m: RegExpExecArray | null;
    let sel: { ar: number; ac: number; fr: number; fc: number } | null = null;
    if ((m = /^([A-Z]{1,3})(\d+)(?::([A-Z]{1,3})(\d+))?$/.exec(up))) {
      const r0 = row(m[2]), r1 = m[4] ? row(m[4]) : r0;
      if (r0 < 0 || r1 < 0) { toast("That row is hidden by a filter"); return true; }
      sel = { ar: r0, ac: colIndex(m[1]), fr: r1, fc: m[3] ? colIndex(m[3]) : colIndex(m[1]) };
    } else if ((m = /^([A-Z]{1,3})(?::([A-Z]{1,3}))?$/.exec(up))) {
      sel = { ar: 0, ac: colIndex(m[1]), fr: R, fc: m[2] ? colIndex(m[2]) : colIndex(m[1]) };
    } else if ((m = /^(\d+)(?::(\d+))?$/.exec(up))) {
      const r0 = row(m[1]), r1 = m[2] ? row(m[2]) : r0;
      if (r0 < 0 || r1 < 0) { toast("That row is hidden by a filter"); return true; }
      sel = { ar: r0, ac: 0, fr: r1, fc: C };
    }
    if (!sel || Number.isNaN(sel.ar)) return false;
    this.grid.select(sel);
    return true;
  }

  private bindNameBox() {
    const box = $("cell-name") as HTMLInputElement;
    box.addEventListener("focus", () => box.select());
    // A click would otherwise drop the caret and undo the select-all.
    box.addEventListener("mouseup", (e) => { if (box.selectionStart === box.selectionEnd) { e.preventDefault(); box.select(); } });
    box.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        const v = box.value.trim();
        const d0 = this.active;
        // A new name: valid, unused, not a sheet, and not a short column jump like "C" or "AB".
        const isNewName = !!d0 && validName(v) && !d0.book.names.has(v.toUpperCase())
          && !d0.book.sheets.some((x) => x.sheetName.toLowerCase() === v.toLowerCase()) && !/^[A-Za-z]{1,2}$/.test(v);
        if (!isNewName && this.goTo(v)) { box.blur(); this.grid.focus(); this.onSelection(); }
        else if (this.active && validName(v)) {
          // Typing a new name with cells selected names them, as in Excel.
          const d = this.active;
          const p = nameProblem(d.book, v);
          if (p) { toast(p, true); box.select(); return; }
          defineName(d, v, this.selectionRef());
          toast(`Named ${this.selectionRef()} "${v}" — use it in formulas, e.g. =SUM(${v})`);
          box.blur(); this.grid.focus(); this.onSelection();
        }
        else { toast(`Couldn't find "${v}"`); box.select(); }
      } else if (e.key === "Escape") {
        e.preventDefault();
        box.blur();
        this.grid.focus();
        this.onSelection();
      }
    });
    box.addEventListener("blur", () => this.onSelection());
  }

  private bindCellBar() {
    this.bindNameBox();
    const input = this.cellInput;
    this.grid.setFormulaBar(input);
    const assist = new FormulaAssist({
      names: () => this.active ? [...this.active.book.names.values()].map((n) => n.name) : [],
      anchor: (f) => f.getBoundingClientRect(),
    });
    assist.attach(this.grid.editor);
    assist.attach(input);
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

  private wheelZoom = new WheelZoom(isMac);

  /** Ctrl + wheel / pinch zoom (see wheelzoom.ts for why it's careful). */
  private onZoomWheel(e: WheelEvent) {
    const a = this.wheelZoom.handle(e, performance.now());
    if (a.kind === "scroll") return; // let the sheet scroll
    e.preventDefault();
    if (a.kind === "step") this.stepZoom(a.dir);
    else if (a.kind === "scale") this.setZoom(this.grid.zoom * a.factor);
  }

  private bindKeys() {
    window.addEventListener("keydown", (e) => {
      // AltGr types characters (\ ] @ € …) on many keyboards: let it.
      if (isAltGr(e)) return;
      const ctrl = cmdKey(e);
      const k = e.key.toLowerCase();
      const d = this.active;
      // The web view's own reload (and print) would throw away every open tab.
      // Ctrl+Shift+R is still "align right" below.
      if ((ctrl && (k === "r" || k === "p")) || e.key === "BrowserRefresh") {
        e.preventDefault();
        if (!(ctrl && e.shiftKey && k === "r" && d)) return;
      }
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
      else if (ctrl && k === "h" && (!isMac || e.shiftKey)) { e.preventDefault(); if (d) this.find.open(true); }
      else if (e.ctrlKey && e.key === "Tab") { // Control+Tab on a Mac too
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
      else if ((ctrl && k === "g") || e.key === "F5") { e.preventDefault(); if (d) { const nb = $("cell-name") as HTMLInputElement; nb.focus(); nb.select(); } }
      else if (ctrl && (e.key === "PageDown" || e.key === "PageUp") && d) {
        e.preventDefault();
        const sh = d.book.sheets, i = sh.indexOf(d);
        const next = sh[(i + (e.key === "PageDown" ? 1 : -1) + sh.length) % sh.length];
        if (next !== d) this.showSheet(next);
      }
      else if (ctrl && e.altKey && (e.key === "-" || (isMac && e.code === "Minus")) && d) { // ⌥- types "–" on a Mac
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
    // Ctrl + wheel (or a trackpad pinch) zooms the grid.
    $("grid-wrap").addEventListener("wheel", (e) => this.onZoomWheel(e), { passive: false });
  }
}

const LOGO = `<rect x="2" y="2" width="20" height="20" rx="5" fill="#d97757"/><rect x="5.2" y="5.2" width="6.2" height="13.6" rx="1.6" fill="#fbf9f4"/><rect x="12.6" y="5.2" width="6.2" height="6.2" rx="1.6" fill="#fbf9f4"/><rect x="12.6" y="12.6" width="6.2" height="6.2" rx="1.6" fill="#fbf9f4" opacity=".55"/>`;

function svg(inner: string, size: number, cls = ""): SVGElement {
  const vb = size === 12 ? "0 0 12 12" : "0 0 24 24";
  const wrap = document.createElement("span");
  wrap.innerHTML = `<svg viewBox="${vb}" width="${size}" height="${size}" class="${cls}" fill="none">${inner}</svg>`;
  return wrap.firstElementChild as SVGElement;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
/** Files that save back as CSV/TSV text. */
const CSV_PATH = /\.(csv|tsv|txt|tab)$/i;

const CHART_ICONS: Record<ChartType, string> = {
  column: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M3.5 13V8.5M8 13V3.5M12.5 13V6.5" stroke-width="2.2"/></svg>',
  bar: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M3 3.5h4.5M3 8h10M3 12.5h7" stroke-width="2.2"/></svg>',
  line: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M2.5 11.5 6 7.5l3 2.5 4.5-6"/></svg>',
  pie: '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5V8l4.25 3.5"/></svg>',
};
const IMG_ICONS = {
  cell: '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="m4.5 11 2.5-3 2 2 1.25-1.5L12 11"/></svg>',
  over: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M2.5 6h11M6 2.5v11" opacity=".45"/><rect x="5" y="5" width="8.5" height="8" rx="1.25"/><path d="m6.5 11.5 2-2.25 1.5 1.5 1-1 1 1.75"/></svg>',
  text: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 4.5h8M8 4.5v8"/></svg>',
  dropdown: '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="2" y="4.5" width="12" height="7" rx="3.5"/><path d="m9.25 7.25 1.25 1.25 1.25-1.25"/></svg>',
  check: '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="3" y="3" width="10" height="10" rx="2.25"/><path d="m5.75 8.25 1.6 1.6 3-3.35"/></svg>',
};
const ROWCOL_ICONS = {
  above: '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="2.5" y="8.5" width="11" height="5" rx="1"/><path d="M8 2.5v4M6 4.5h4"/></svg>',
  below: '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="2.5" y="2.5" width="11" height="5" rx="1"/><path d="M8 9.5v4M6 11.5h4"/></svg>',
  left: '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="8.5" y="2.5" width="5" height="11" rx="1"/><path d="M2.5 8h4M4.5 6v4"/></svg>',
  right: '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="2.5" y="2.5" width="5" height="11" rx="1"/><path d="M9.5 8h4M11.5 6v4"/></svg>',
};

/** A small coloured circle for colour menus. */
function dot(fill: string, ring: string): string {
  return `<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="5.25" fill="${fill}" stroke="${ring}" stroke-width="1.5"/></svg>`;
}

/** Read a picture, shrinking very large ones so files stay small. */
async function loadImage(file: Blob): Promise<{ url: string; w: number; h: number }> {
  const url = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
  const img = new Image();
  await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("bad image")); img.src = url; });
  let w = img.naturalWidth || 300, h = img.naturalHeight || 200;
  const MAX = 1600;
  if ((w > MAX || h > MAX || file.size > 1_500_000) && file.type !== "image/svg+xml" && file.type !== "image/gif") {
    const k = Math.min(1, MAX / Math.max(w, h));
    w = Math.round(w * k); h = Math.round(h * k);
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    cv.getContext("2d")!.drawImage(img, 0, 0, w, h);
    const png = file.type === "image/png";
    return { url: cv.toDataURL(png ? "image/png" : "image/jpeg", 0.88), w, h };
  }
  return { url, w, h };
}
