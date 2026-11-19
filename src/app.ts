import { CsvParser, Delimiter, LineEnding, delimiterLabel, sniffDelimiter, sniffLineEnding } from "./csv";
import { Doc, selRect } from "./doc";
import { Encoding, decodeBytes, encodeText, encodingLabel } from "./encoding";
import { openFilter } from "./filter";
import { FindPanel } from "./find";
import { Grid } from "./grid";
import { decodeBento, encodeBento, isBentoPath, looksLikeBento } from "./bento";
import {
  FileRef, isTauri, launchFiles, onFileDrop, onOpenFiles, pickFiles, pickSavePath, readFile,
  windowControls, writeFile,
} from "./native";
import { MenuItem, closeMenus, modal, showMenu, toast } from "./ui";
import { ToolButton, divider, grow, toolButton } from "./toolbar";
import { ZOOMS } from "./grid";
import { FormatBar } from "./formatbar";
import { Style } from "./format";
import { appVersion, initUpdater } from "./updater";
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
  private tools: Record<string, ToolButton> = {};
  private formatBar = new FormatBar({
    active: () => {
      const d = this.active;
      if (!d) return null;
      const r = d.dataRow(d.sel.ar);
      return { style: d.style(r, d.sel.ac), header: d.freezeHeader && r === 0, shown: d.display(r, d.sel.ac) };
    },
    apply: (patch, label) => this.applyFormat(patch, label),
    theme: () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"),
  });

  constructor() {
    this.grid = new Grid({
      onSelection: () => this.onSelection(),
      onChange: () => this.onChange(),
      onContextMenu: (zone, x, y) => this.contextMenu(zone, x, y),
      onColumnMenu: (c, x, y) => this.columnMenu(c, x, y),
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
    initUpdater((version, install) => {
      const btn = $("update-btn");
      btn.hidden = false;
      btn.title = `Bento ${version} is ready to install`;
      btn.onclick = async () => {
        // Give unsaved work a chance to be saved first.
        if (!(await this.confirmQuit())) return;
        btn.textContent = "Updating…";
        try { await install(); } catch (e) { toast(`Update failed: ${e}`, true); btn.textContent = "Update ready · Restart"; }
      };
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
  private makeDoc(name: string, path: string | null): Doc {
    const d = new Doc(name, path);
    d.measureRow = (r) => this.grid.measureRow(d, r);
    return d;
  }

  newDoc() {
    this.untitled++;
    const d = this.makeDoc(this.untitled === 1 ? "Untitled.bento" : `Untitled ${this.untitled}.bento`, null);
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
      const doc = this.makeDoc(ref.name, ref.path);
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
    if (isBentoPath(ref.name) || looksLikeBento(bytes)) {
      await decodeBento(bytes, doc);
      doc.loading = null;
      if (!doc.widths.size) this.grid.autoFitInitial(doc);
      doc.remeasureAll();
      doc.markSaved();
      if (this.active === doc) this.grid.setDoc(doc);
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
      await writeFile(path, await encodeBento(doc));
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

  /** Write a plain CSV copy. The sheet itself stays as it is. */
  async exportCsv(doc: Doc | null = this.active): Promise<boolean> {
    if (!doc || doc.loading !== null) return false;
    if (this.grid.editing && this.active === doc) this.grid.commitEdit();
    const base = (doc.path ?? doc.name).replace(/\.[^.\\/]+$/, "");
    let path = await pickSavePath(base + (doc.delim === "\t" ? ".tsv" : ".csv"), "csv");
    if (!path) return false;
    if (!/\.(csv|tsv|txt)$/i.test(path)) path += ".csv";
    const delim = /\.tsv$/i.test(path) ? "\t" as const : doc.delim === "\t" ? "," as const : doc.delim;
    let asValues = false;
    if (doc.hasFormulas()) {
      let mode = doc.saveFormulasAs;
      if (!mode) {
        mode = await modal(
          "This sheet has formulas",
          "CSV files can't store formulas. Export the calculated values, or the formulas as text? (Excel and Google Sheets recalculate formulas saved as text.)",
          [
            { label: "Cancel", value: null },
            { label: "Formulas as text", value: "formulas" as const },
            { label: "Values", value: "values" as const, primary: true },
          ],
        );
        if (!mode) return false;
        doc.saveFormulasAs = mode;
      }
      asValues = mode === "values";
    }
    try {
      const saved = doc.delim;
      doc.delim = delim;
      const text = doc.toText(asValues);
      doc.delim = saved;
      await writeFile(path, encodeText(text, doc.encoding, doc.bom));
      toast(`Exported ${basename(path)}${doc.hasFormatting() ? " (formatting isn't kept in CSV)" : ""}`);
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
      el("p", { text: "A calm, quick place for your spreadsheets and CSV files." }),
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
    btn(encodingLabel(d.encoding, d.bom), "Text encoding (for CSV export)", (b) => this.encodingMenu(b));
    btn(delimiterLabel(d.delim), "Delimiter (for CSV export)", (b) => this.delimiterMenu(b));
    btn(d.eol === "\r\n" ? "CRLF" : "LF", "Line endings (for CSV export)", (b) => this.eolMenu(b));
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
    document.documentElement.dataset.theme = dark ? "dark" : "light";
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
    z = Math.min(2, Math.max(0.5, Math.round(z * 100) / 100));
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
    const col = () => this.active!.sel.ac;
    bar.append(
      t("undo", toolButton({ icon: "undo", title: "Undo (Ctrl+Z)", onClick: withDoc((d) => this.grid.applyUndo(d.undo())) })),
      t("redo", toolButton({ icon: "redo", title: "Redo (Ctrl+Y)", onClick: withDoc((d) => this.grid.applyUndo(d.redo())) })),
      divider(),
      t("zoom", toolButton({ text: "100%", caret: true, title: "Zoom (Ctrl+= / Ctrl+-)", onClick: (b) => {
        const r = b.getBoundingClientRect();
        b.classList.add("open");
        showMenu(ZOOMS.map((z) => ({ label: `${Math.round(z * 100)}%`, checked: Math.abs(this.grid.zoom - z) < 0.001, action: () => this.setZoom(z) })),
          r.left, r.bottom + 4, () => b.classList.remove("open"));
      } })),
      divider(),
      ...this.formatBar.build(),
      divider(),
      t("sortAsc", toolButton({ icon: "sortAsc", title: "Sort column A → Z", onClick: withDoc((d) => { d.sortBy(col(), false); this.afterStructure(); }) })),
      t("sortDesc", toolButton({ icon: "sortDesc", title: "Sort column Z → A", onClick: withDoc((d) => { d.sortBy(col(), true); this.afterStructure(); }) })),
      t("filter", toolButton({ icon: "filter", title: "Filter column", onClick: (b) => withDoc((d) => {
        const r = b.getBoundingClientRect();
        openFilter(d, col(), r.left, r.bottom + 4, () => this.afterStructure());
      })() })),
      t("freeze", toolButton({ icon: "freeze", title: "Freeze header row", onClick: withDoc(() => this.toggleFreeze()) })),
      divider(),
      t("insRow", toolButton({ icon: "insertRow", title: "Insert row above", onClick: withDoc(() => runItem(this.rowItems()[0])) })),
      t("insCol", toolButton({ icon: "insertCol", title: "Insert column left", onClick: withDoc(() => runItem(this.colItems()[0])) })),
      t("delRow", toolButton({ icon: "deleteRow", title: "Delete row", onClick: withDoc(() => runItem(this.rowItems()[2])) })),
      t("delCol", toolButton({ icon: "deleteCol", title: "Delete column", onClick: withDoc(() => runItem(this.colItems()[2])) })),
      t("fit", toolButton({ icon: "fitWidth", title: "Fit column width to content", onClick: withDoc((d) => {
        const s = selRect(d.sel);
        for (let c = s.c0; c <= s.c1; c++) this.grid.autoFit(c);
      }) })),
      divider(),
      t("sum", toolButton({ icon: "sum", caret: true, title: "Functions", onClick: (b) => {
        if (!this.active) return;
        const r = b.getBoundingClientRect();
        b.classList.add("open");
        showMenu(["SUM", "AVERAGE", "COUNT", "MIN", "MAX"].map((f) => ({ label: f[0] + f.slice(1).toLowerCase(), key: f, action: () => this.autoSum(f) })),
          r.left, r.bottom + 4, () => b.classList.remove("open"));
      } })),
      grow(),
      t("find", toolButton({ icon: "search", title: "Find and replace (Ctrl+F)", onClick: withDoc(() => (this.find.isOpen ? this.find.close() : this.find.open(false))) })),
    );
    const z = Number(localStorage.getItem("bento.zoom"));
    if (z) this.grid.setZoom(z);
  }

  private refreshToolbar() {
    const d = this.active;
    const ready = !!d && d.loading === null;
    for (const b of Object.values(this.tools)) b.set({ disabled: !ready });
    this.tools.zoom.set({ disabled: false, text: `${Math.round(this.grid.zoom * 100)}%` });
    if (!ready || !d) { this.formatBar.refresh(false); return; }
    this.tools.undo.set({ disabled: !d.canUndo });
    this.tools.redo.set({ disabled: !d.canRedo });
    this.tools.filter.set({ on: d.filters.has(d.sel.ac) });
    this.tools.freeze.set({ on: d.freezeHeader });
    this.formatBar.refresh(ready);
  }

  /** Apply a formatting change to every selected cell. */
  applyFormat(patch: (s: Style) => Style, label: string) {
    const d = this.active;
    if (!d || d.loading !== null) return;
    const s = selRect(d.sel);
    const count = (s.r1 - s.r0 + 1) * (s.c1 - s.c0 + 1);
    if (count > 5_000_000) { toast("That selection is too big to format in one go", true); return; }
    const cells: { r: number; c: number }[] = [];
    for (let r = s.r0; r <= s.r1; r++) {
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
      { label: "About Bento", action: async () => modal("Bento", `Version ${await appVersion()}\nA minimal, fast CSV editor.\nUpdates install automatically.`, [{ label: "Close", value: true, primary: true }]) },
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
      "Ctrl+B / I / U  bold, italic, underline  ·  Alt+Shift+5  strikethrough",
      "Ctrl+Shift+L / E / R  align left, centre, right  ·  Ctrl+\\  clear formatting",
      "Ctrl+S  save (.bento)  ·  Ctrl+E  export CSV  ·  Ctrl+O  open  ·  Ctrl+N  new",
      "Ctrl+Tab  next tab  ·  Ctrl+W  close tab",
      "Formulas start with =, e.g. =SUM(B2:B100)",
    ].join("\n"), [{ label: "Done", value: true, primary: true }]);
  }

  private encodingMenu(anchor: HTMLElement) {
    const d = this.active!;
    const r = anchor.getBoundingClientRect();
    const set = (e: Encoding, bom: boolean) => () => { d.encoding = e; d.bom = bom; d.markDirty(); this.render(); };
    const canReread = !!d.source && !d.dirty && !isBentoPath(d.source.name);
    const reread = (e: Encoding) => () => this.load(d, d.source!, { encoding: e, delim: d.delim }).catch((err) => toast(String(err), true));
    showMenu([
      { heading: "Export CSV as" },
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
    const canReread = !!d.source && !d.dirty && !isBentoPath(d.source.name);
    showMenu([
      { heading: "Export CSV with" },
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
      if (ctrl && k === "n") { e.preventDefault(); this.newDoc(); }
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
      else if (ctrl && e.key === "-") { e.preventDefault(); this.stepZoom(-1); }
      else if (ctrl && e.key === "0") { e.preventDefault(); this.setZoom(1); }
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
    // Ctrl + mouse wheel zooms the grid.
    $("grid-wrap").addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.stepZoom(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
  }
}

function runItem(it: MenuItem) {
  if (typeof it === "object" && "label" in it) it.action?.();
}

const LOGO = `<rect x="2" y="2" width="20" height="20" rx="5" fill="var(--accent)"/><rect x="5.2" y="5.2" width="6.2" height="13.6" rx="1.6" fill="var(--on-accent)"/><rect x="12.6" y="5.2" width="6.2" height="6.2" rx="1.6" fill="var(--on-accent)"/><rect x="12.6" y="12.6" width="6.2" height="6.2" rx="1.6" fill="var(--on-accent)" opacity=".55"/>`;

function svg(inner: string, size: number, cls = ""): SVGElement {
  const vb = size === 12 ? "0 0 12 12" : "0 0 24 24";
  const wrap = document.createElement("span");
  wrap.innerHTML = `<svg viewBox="${vb}" width="${size}" height="${size}" class="${cls}" fill="none">${inner}</svg>`;
  return wrap.firstElementChild as SVGElement;
}
