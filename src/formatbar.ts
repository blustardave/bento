/** Formatting controls for the toolbar: numbers, size, text style, colour, alignment. */
import {
  DateFmt, FONT_SIZES, DEFAULT_SIZE, HUES, HAlign, NumFmt, Style, VAlign, Wrap,
  colorLabel, resolveColor, shownDecimals,
} from "./format";
import { IconName, ToolButton, divider, icon, toolButton } from "./toolbar";
import { showMenu, showPopover } from "./ui";
import { el } from "./util";

export interface FormatContext {
  /** Style of the active cell (and whether it's in the frozen header row). */
  active(): { style: Style; header: boolean; shown: string } | null;
  apply(patch: (s: Style) => Style, label: string): void;
  theme(): "light" | "dark";
}

const ALIGN_ICONS: Record<HAlign, IconName> = { l: "alignL", c: "alignC", r: "alignR" };
const VALIGN_ICONS: Record<VAlign, IconName> = { t: "vTop", m: "vMid", b: "vBot" };
const WRAP_ICONS: Record<Wrap, IconName> = { overflow: "wrapOverflow", wrap: "wrapWrap", clip: "wrapClip" };

export class FormatBar {
  private t: Record<string, ToolButton> = {};
  private size!: HTMLInputElement;

  constructor(private ctx: FormatContext) {}

  build(): HTMLElement[] {
    const c = this.ctx;
    const t = (k: string, b: ToolButton) => { this.t[k] = b; return b.el; };
    const nf = (patch: (n: NumFmt | undefined) => NumFmt | undefined, label = "Number format") =>
      c.apply((s) => ({ ...s, nf: patch(s.nf) }), label);

    // Numbers
    const numbers = [
      t("cur", toolButton({ glyph: "£", glyphClass: "sym", caret: true, title: "Currency", onClick: (b) => {
        const r = b.getBoundingClientRect();
        showMenu([
          ...[["£", "Pounds"], ["$", "Dollars"], ["€", "Euros"]].map(([sym, name]) => ({
            label: `${sym}  ${name}`, action: () => nf(() => ({ k: "cur", cur: sym, dp: 2, sep: true }), "Currency"),
          })),
        ], r.left, r.bottom + 4);
      } })),
      t("pct", toolButton({ glyph: "%", glyphClass: "sym", title: "Format as percent", onClick: () =>
        nf((n) => (n?.k === "pct" ? undefined : { k: "pct", dp: 2 }), "Percent") })),
      t("decDown", toolButton({ glyph: ".0", glyphClass: "dec", icon: "arrowL", title: "Fewer decimal places", onClick: () => this.stepDecimals(-1) })),
      t("decUp", toolButton({ glyph: ".00", glyphClass: "dec", icon: "arrowR", title: "More decimal places", onClick: () => this.stepDecimals(1) })),
      t("numFmt", toolButton({ glyph: "123", glyphClass: "sym small", caret: true, title: "More formats", onClick: (b) => this.formatsMenu(b) })),
    ];
    // icon after glyph for decimal buttons (".0 ←")
    for (const k of ["decDown", "decUp"]) { const b = this.t[k].el; b.append(b.firstElementChild!); }

    // Font size stepper
    this.size = el("input", { class: "size-input", value: String(DEFAULT_SIZE), title: "Font size", spellcheck: "false" });
    const applySize = (v: number) => {
      const n = Math.max(4, Math.min(96, Math.round(v)));
      c.apply((s) => ({ ...s, size: n === DEFAULT_SIZE ? undefined : n }), "Font size");
    };
    const current = () => c.active()?.style.size ?? DEFAULT_SIZE;
    const minus = toolButton({ icon: "minus", title: "Smaller text", onClick: () => {
      const cur = current();
      applySize([...FONT_SIZES].reverse().find((x) => x < cur) ?? Math.max(4, cur - 1));
    } });
    const plus = toolButton({ icon: "plus", title: "Bigger text", onClick: () => {
      const cur = current();
      applySize(FONT_SIZES.find((x) => x > cur) ?? cur + 2);
    } });
    this.t.sizeMinus = minus;
    this.t.sizePlus = plus;
    this.size.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); const v = Number(this.size.value); if (v) applySize(v); this.size.blur(); }
      else if (e.key === "Escape") { this.size.blur(); }
      e.stopPropagation();
    });
    this.size.addEventListener("click", () => {
      const r = this.size.getBoundingClientRect();
      const cur = current();
      showMenu(FONT_SIZES.map((x) => ({ label: String(x), checked: x === cur, action: () => applySize(x) })), r.left, r.bottom + 4);
    });
    this.size.addEventListener("blur", () => this.refresh());
    const sizeGroup = el("div", { class: "stepper" }, minus.el, this.size, plus.el);

    // Text style
    const toggle = (key: "b" | "i" | "u" | "s", label: string) => () => {
      const a = c.active();
      const on = a ? !!(a.style[key] ?? (key === "b" && a.header)) : false;
      c.apply((s) => ({ ...s, [key]: on ? (key === "b" && a?.header ? false : undefined) : true }), label);
    };
    const textStyle = [
      t("b", toolButton({ glyph: "B", glyphClass: "bold", title: "Bold (Ctrl+B)", onClick: toggle("b", "Bold") })),
      t("i", toolButton({ glyph: "I", glyphClass: "italic", title: "Italic (Ctrl+I)", onClick: toggle("i", "Italic") })),
      t("u", toolButton({ glyph: "U", glyphClass: "underline", title: "Underline (Ctrl+U)", onClick: toggle("u", "Underline") })),
      t("s", toolButton({ glyph: "S", glyphClass: "strike", title: "Strikethrough (Alt+Shift+5)", onClick: toggle("s", "Strikethrough") })),
      t("color", toolButton({ icon: "textColor", caret: true, title: "Text colour", onClick: (b) => this.palette(b, "color") })),
      t("fill", toolButton({ icon: "fill", caret: true, title: "Fill colour", onClick: (b) => this.palette(b, "fill") })),
    ];

    // Alignment
    const picker = <T extends string>(key: string, title: string, icons: Record<T, IconName>, labels: Record<T, string>, prop: "ha" | "va" | "wrap") =>
      t(key, toolButton({ icon: Object.values<IconName>(icons)[0], caret: true, title, onClick: (b) => {
        const cur = c.active()?.style[prop];
        const row = el("div", { class: "icon-row" });
        let close = () => {};
        for (const [v, ic] of Object.entries(icons) as [T, IconName][]) {
          const btn = el("button", { class: "tb" + (cur === v ? " on" : ""), title: labels[v] }, icon(ic));
          btn.addEventListener("click", () => { c.apply((s) => ({ ...s, [prop]: v }), title); close(); });
          row.append(btn);
        }
        close = showPopover(b, row);
      } }));
    const align = [
      picker<HAlign>("ha", "Horizontal align", ALIGN_ICONS, { l: "Left (Ctrl+Shift+L)", c: "Centre (Ctrl+Shift+E)", r: "Right (Ctrl+Shift+R)" }, "ha"),
      picker<VAlign>("va", "Vertical align", VALIGN_ICONS, { t: "Top", m: "Middle", b: "Bottom" }, "va"),
      picker<Wrap>("wrap", "Text wrapping", WRAP_ICONS, { overflow: "Overflow", wrap: "Wrap", clip: "Clip" }, "wrap"),
    ];

    return [
      ...numbers, divider(),
      sizeGroup, divider(),
      ...textStyle, divider(),
      ...align,
    ];
  }

  private stepDecimals(dir: 1 | -1) {
    const a = this.ctx.active();
    if (!a) return;
    const startDp = a.style.nf?.dp ?? shownDecimals(a.shown);
    this.ctx.apply((s) => {
      const n = s.nf && s.nf.k !== "date" ? s.nf : { k: "num" as const };
      const dp = Math.max(0, Math.min(10, (n.dp ?? startDp) + dir));
      return { ...s, nf: { ...n, dp } };
    }, dir > 0 ? "More decimals" : "Fewer decimals");
  }

  private formatsMenu(b: HTMLElement) {
    const a = this.ctx.active();
    const cur = a?.style.nf;
    const set = (n: NumFmt | undefined, label: string) => () => this.ctx.apply((s) => ({ ...s, nf: n }), label);
    const date = (f: DateFmt, sample: string) => ({ label: sample, checked: cur?.k === "date" && (cur.date ?? "iso") === f, action: set({ k: "date", date: f }, "Date format") });
    const r = b.getBoundingClientRect();
    showMenu([
      { label: "Automatic", checked: !cur, action: set(undefined, "Automatic format") },
      { label: "Number", key: "1,000.12", checked: cur?.k === "num", action: set({ k: "num", dp: 2, sep: true }, "Number format") },
      { label: "Percent", key: "10.12%", checked: cur?.k === "pct", action: set({ k: "pct", dp: 2 }, "Percent") },
      { label: "Currency", key: "£1,000.12", checked: cur?.k === "cur", action: set({ k: "cur", cur: cur?.cur ?? "£", dp: 2, sep: true }, "Currency") },
      "sep",
      { heading: "Dates" },
      date("iso", "2026-01-31"),
      date("dmy", "31/01/2026"),
      date("mdy", "01/31/2026"),
      date("long", "31 Jan 2026"),
      "sep",
      { label: "Thousands separator", checked: !!cur?.sep && cur.k !== "date", disabled: cur?.k === "date", action: () =>
        this.ctx.apply((s) => {
          const n = s.nf ?? { k: "num" as const };
          return { ...s, nf: { ...n, sep: !n.sep } };
        }, "Thousands separator") },
    ], r.left, r.bottom + 4);
  }

  private palette(anchor: HTMLElement, prop: "color" | "fill") {
    const c = this.ctx;
    const cur = c.active()?.style[prop];
    const theme = c.theme();
    const box = el("div", { class: "palette" });
    let close = () => {};
    const pick = (v: string | undefined) => { c.apply((s) => ({ ...s, [prop]: v }), prop === "color" ? "Text colour" : "Fill colour"); close(); };
    const swatch = (token: string, title: string) => {
      const sw = el("button", { class: "swatch" + (cur === token ? " on" : ""), title });
      sw.style.background = resolveColor(token, theme) ?? "transparent";
      sw.addEventListener("click", () => pick(token));
      return sw;
    };
    const reset = el("button", { class: "reset" }, icon("clearFormat", 14), prop === "color" ? "Automatic" : "No fill");
    reset.addEventListener("click", () => pick(undefined));
    box.append(reset);
    const rows: [string, (h: string) => string][] = prop === "color"
      ? [["", (h) => `@${h}`]]
      : [["", (h) => `@${h}-1`], ["", (h) => `@${h}-2`]];
    for (const [, tok] of rows) {
      const row = el("div", { class: "swatches" });
      for (const h of HUES) row.append(swatch(tok(h), colorLabel(h)));
      box.append(row);
    }
    // Custom colours (remembered).
    const key = `bento.custom.${prop}`;
    let recent: string[] = [];
    try { recent = JSON.parse(localStorage.getItem(key) ?? "[]"); } catch { /* ignore */ }
    const customRow = el("div", { class: "swatches" });
    for (const hex of recent) customRow.append(swatch(hex, hex));
    const input = el("input", { type: "color", class: "color-input" });
    input.value = cur && cur[0] === "#" ? cur : prop === "color" ? "#c4453a" : "#f8efcf";
    const add = el("button", { class: "swatch add", title: "Custom colour…" }, icon("plus", 12));
    add.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      const hex = input.value;
      localStorage.setItem(key, JSON.stringify([hex, ...recent.filter((x) => x !== hex)].slice(0, 8)));
      pick(hex);
    });
    customRow.append(add, input);
    box.append(el("div", { class: "pal-label", text: "Custom" }), customRow);
    close = showPopover(anchor, box);
  }

  /** Reflect the active cell's formatting in the controls. */
  refresh(enabled = true) {
    for (const b of Object.values(this.t)) b.set({ disabled: !enabled });
    this.size.disabled = !enabled;
    const a = this.ctx.active();
    if (!enabled || !a) return;
    const s = a.style;
    const theme = this.ctx.theme();
    this.t.b.set({ on: !!(s.b ?? a.header) });
    this.t.i.set({ on: !!s.i });
    this.t.u.set({ on: !!s.u });
    this.t.s.set({ on: !!s.s });
    this.t.pct.set({ on: s.nf?.k === "pct" });
    this.t.cur.set({ on: s.nf?.k === "cur" });
    const g = this.t.cur.el.querySelector(".glyph");
    if (g) g.textContent = s.nf?.k === "cur" ? s.nf.cur ?? "£" : "£";
    this.t.numFmt.set({ on: s.nf?.k === "num" || s.nf?.k === "date" });
    if (document.activeElement !== this.size) this.size.value = String(s.size ?? DEFAULT_SIZE);
    this.t.ha.set({ icon: ALIGN_ICONS[s.ha ?? "l"] });
    this.t.va.set({ icon: VALIGN_ICONS[s.va ?? "m"] });
    this.t.wrap.set({ icon: WRAP_ICONS[s.wrap ?? "overflow"] });
    this.t.color.set({ swatch: resolveColor(s.color, theme) ?? getComputedStyle(document.documentElement).getPropertyValue("--text").trim() });
    this.t.fill.set({ swatch: resolveColor(s.fill, theme) });
  }
}
