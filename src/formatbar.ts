/** Formatting controls for the toolbar, laid out like Google Sheets' (minus the clutter). */
import {
  DEFAULT_FONT, DEFAULT_SIZE, FONTS, FONT_SIZES, HAlign, HUES, Rotation, Style, VAlign, Wrap,
  colorLabel, defaultCurrency, resolveColor, shownDecimals,
} from "./format";
import { IconName, ToolButton, icon, toolButton } from "./toolbar";
import { showMenu, showPopover } from "./ui";
import { el } from "./util";
import { isMac, keys } from "./platform";

export interface FormatContext {
  /** Style of the active cell (and whether it's in the frozen header row). */
  active(): { style: Style; header: boolean; shown: string } | null;
  apply(patch: (s: Style) => Style, label: string): void;
  theme(): "light" | "dark" | "dusk";
  /** Merge the selection, or unmerge it if it already holds merges. */
  toggleMerge(): void;
  selectionMerged(): boolean;
}

const ALIGN_ICONS: Record<HAlign, IconName> = { l: "alignL", c: "alignC", r: "alignR" };
const VALIGN_ICONS: Record<VAlign, IconName> = { t: "vTop", m: "vMid", b: "vBot" };
const WRAP_ICONS: Record<Wrap, IconName> = { overflow: "wrapOverflow", wrap: "wrapWrap", clip: "wrapClip" };
type Rot = Rotation | "none";
const ROT_ICONS: Record<Rot, IconName> = { none: "rotNone", stack: "rotStack", up: "rotUp" };

export interface FormatGroups {
  numbers: HTMLElement[];
  font: HTMLElement[];
  size: HTMLElement[];
  text: HTMLElement[];
  fill: HTMLElement[];
  align: HTMLElement[];
}

/**
 * ".0 ←" / ".00 →": real text (crisp at any scaling) with a pixel-exact
 * arrow tucked underneath, rather than tiny drawn curves.
 */
function decimalButton(label: string, dir: "left" | "right", title: string, onClick: () => void): ToolButton {
  const b = toolButton({ title, onClick });
  const arrow = dir === "left"
    ? '<path d="M10.5 3.5H3"/><path d="M0.5 3.5 4 0.75v5.5Z" class="head"/>'
    : '<path d="M0.5 3.5H8"/><path d="M10.5 3.5 7 0.75v5.5Z" class="head"/>';
  b.el.classList.add("dec-btn");
  b.el.innerHTML = `<span class="dec-icon dec-${dir}"><span class="dec-text">${label}</span><svg viewBox="0 0 11 7" width="11" height="7" aria-hidden="true">${arrow}</svg></span>`;
  return b;
}

export class FormatBar {
  private t: Record<string, ToolButton> = {};
  private size!: HTMLInputElement;
  private fontLabel!: HTMLElement;

  constructor(private ctx: FormatContext) {}

  build(): FormatGroups {
    const c = this.ctx;
    const t = (k: string, b: ToolButton) => { this.t[k] = b; return b.el; };

    /* Numbers */
    const numbers = [
      t("cur", toolButton({ glyph: defaultCurrency().trim(), glyphClass: "sym", title: "Format as currency", onClick: () =>
        c.apply((s) => ({ ...s, nf: s.nf?.k === "cur" ? undefined : { k: "cur", cur: defaultCurrency(), dp: 2, sep: true } }), "Currency") })),
      t("pct", toolButton({ glyph: "%", glyphClass: "sym", title: "Format as percent", onClick: () =>
        c.apply((s) => ({ ...s, nf: s.nf?.k === "pct" ? undefined : { k: "pct", dp: 2 } }), "Percent") })),
      t("decDown", decimalButton(".0", "left", "Decrease decimal places", () => this.stepDecimals(-1))),
      t("decUp", decimalButton(".00", "right", "Increase decimal places", () => this.stepDecimals(1))),
      t("numFmt", toolButton({ glyph: "123", glyphClass: "sym small", caret: true, title: "More formats", onClick: (b) => {
        const r = b.getBoundingClientRect();
        const isText = c.active()?.style.nf?.k === "text";
        b.classList.add("open");
        showMenu([
          { label: "Plain text", checked: isText, action: () => c.apply((s) => ({ ...s, nf: isText ? undefined : { k: "text" } }), "Plain text") },
        ], r.left, r.bottom + 4, () => b.classList.remove("open"));
      } })),
    ];

    /* Font */
    const fontBtn = toolButton({ text: "Default", caret: true, title: "Font", onClick: (b) => {
      const r = b.getBoundingClientRect();
      const cur = c.active()?.style.font ?? DEFAULT_FONT;
      b.classList.add("open");
      showMenu(FONTS.map((f) => ({
        label: f === DEFAULT_FONT ? isMac ? "Default (San Francisco)" : "Default (Segoe UI)" : f, font: f, checked: f === cur,
        action: () => c.apply((s) => ({ ...s, font: f === DEFAULT_FONT ? undefined : f }), "Font"),
      })), r.left, r.bottom + 4, () => b.classList.remove("open"));
    } });
    fontBtn.el.classList.add("font-btn");
    this.fontLabel = fontBtn.el.querySelector(".txt")!;
    this.t.font = fontBtn;

    /* Font size */
    this.size = el("input", { class: "size-input", value: String(DEFAULT_SIZE), title: "Font size", spellcheck: "false" });
    const applySize = (v: number) => {
      const n = Math.max(4, Math.min(96, Math.round(v)));
      c.apply((s) => ({ ...s, size: n === DEFAULT_SIZE ? undefined : n }), "Font size");
    };
    const current = () => c.active()?.style.size ?? DEFAULT_SIZE;
    const minus = toolButton({ icon: "minus", title: "Decrease font size", onClick: () => {
      const cur = current();
      applySize([...FONT_SIZES].reverse().find((x) => x < cur) ?? Math.max(4, cur - 1));
    } });
    const plus = toolButton({ icon: "plus", title: "Increase font size", onClick: () => {
      const cur = current();
      applySize(FONT_SIZES.find((x) => x > cur) ?? cur + 2);
    } });
    this.t.sizeMinus = minus;
    this.t.sizePlus = plus;
    this.size.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); const v = Number(this.size.value); if (v) applySize(v); this.size.blur(); }
      else if (e.key === "Escape") this.size.blur();
      e.stopPropagation();
    });
    this.size.addEventListener("click", () => {
      const r = this.size.getBoundingClientRect();
      const cur = current();
      showMenu(FONT_SIZES.map((x) => ({ label: String(x), checked: x === cur, action: () => applySize(x) })), r.left, r.bottom + 4);
    });
    this.size.addEventListener("blur", () => this.refresh());
    const size = [el("div", { class: "stepper" }, minus.el, this.size, plus.el)];

    /* Text style */
    const toggle = (key: "b" | "i" | "s", label: string) => () => {
      const a = c.active();
      const on = a ? !!(a.style[key] ?? (key === "b" && a.header)) : false;
      c.apply((s) => ({ ...s, [key]: on ? (key === "b" && a?.header ? false : undefined) : true }), label);
    };
    const text = [
      t("b", toolButton({ icon: "bold", title: keys("Bold (Ctrl+B)"), onClick: toggle("b", "Bold") })),
      t("i", toolButton({ icon: "italic", title: keys("Italic (Ctrl+I)"), onClick: toggle("i", "Italic") })),
      t("s", toolButton({ icon: "strike", title: keys("Strikethrough (Alt+Shift+5)"), onClick: toggle("s", "Strikethrough") })),
      t("color", toolButton({ icon: "textColor", title: "Text colour", onClick: (b) => this.palette(b, "color") })),
    ];

    /* Fill + merge */
    const fill = [
      t("fill", toolButton({ icon: "fill", title: "Fill colour", onClick: (b) => this.palette(b, "fill") })),
      t("merge", toolButton({ icon: "merge", title: "Merge cells", onClick: () => c.toggleMerge() })),
    ];

    /* Alignment, wrapping, rotation — each a horizontal row of icons */
    const picker = <T extends string>(key: string, title: string, icons: Record<T, IconName>, labels: Record<T, string>, apply: (s: Style, v: T) => Style, current: (s: Style) => T) =>
      t(key, toolButton({ icon: Object.values<IconName>(icons)[0], caret: true, title, onClick: (b) => {
        const cur = current(c.active()?.style ?? {});
        const row = el("div", { class: "icon-row" });
        let close = () => {};
        for (const [v, ic] of Object.entries(icons) as [T, IconName][]) {
          const btn = el("button", { class: "tb" + (cur === v ? " on" : ""), title: labels[v] }, icon(ic));
          btn.addEventListener("click", () => { c.apply((s) => apply(s, v), title); close(); });
          row.append(btn);
        }
        close = showPopover(b, row);
      } }));
    const align = [
      picker<HAlign>("ha", "Horizontal align", ALIGN_ICONS, { l: keys("Left (Ctrl+Shift+L)"), c: keys("Centre (Ctrl+Shift+E)"), r: keys("Right (Ctrl+Shift+R)") },
        (s, v) => ({ ...s, ha: v }), (s) => s.ha ?? "l"),
      picker<VAlign>("va", "Vertical align", VALIGN_ICONS, { t: "Top", m: "Middle", b: "Bottom" },
        (s, v) => ({ ...s, va: v === "b" ? undefined : v }), (s) => s.va ?? "b"),
      picker<Wrap>("wrap", "Text wrapping", WRAP_ICONS, { overflow: "Overflow", wrap: "Wrap", clip: "Clip" },
        (s, v) => ({ ...s, wrap: v === "overflow" ? undefined : v }), (s) => s.wrap ?? "overflow"),
      picker<Rot>("rot", "Text rotation", ROT_ICONS, { none: "None", stack: "Stack vertically", up: "Rotate up" },
        (s, v) => ({ ...s, rot: v === "none" ? undefined : v }), (s) => s.rot ?? "none"),
    ];

    return { numbers, font: [fontBtn.el], size, text, fill, align };
  }

  private stepDecimals(dir: 1 | -1) {
    const a = this.ctx.active();
    if (!a) return;
    const startDp = a.style.nf?.dp ?? shownDecimals(a.shown);
    this.ctx.apply((s) => {
      const n = s.nf && s.nf.k !== "date" && s.nf.k !== "text" ? s.nf : { k: "num" as const };
      const dp = Math.max(0, Math.min(10, (n.dp ?? startDp) + dir));
      return { ...s, nf: { ...n, dp } };
    }, dir > 0 ? "More decimals" : "Fewer decimals");
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
    const rows: ((h: string) => string)[] = prop === "color" ? [(h) => `@${h}`] : [(h) => `@${h}-1`, (h) => `@${h}-2`];
    for (const tok of rows) {
      const row = el("div", { class: "swatches" });
      for (const h of HUES) row.append(swatch(tok(h), colorLabel(h)));
      box.append(row);
    }
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
    this.t.s.set({ on: !!s.s });
    this.t.pct.set({ on: s.nf?.k === "pct" });
    this.t.cur.set({ on: s.nf?.k === "cur" });
    const g = this.t.cur.el.querySelector(".glyph");
    if (g) g.textContent = (s.nf?.k === "cur" ? s.nf.cur ?? defaultCurrency() : defaultCurrency()).trim();
    this.t.numFmt.set({ on: s.nf?.k === "text" });
    this.t.merge.set({ on: this.ctx.selectionMerged() });
    this.fontLabel.textContent = !s.font || s.font === DEFAULT_FONT ? "Default" : s.font;
    this.fontLabel.style.fontFamily = s.font ? `"${s.font}", var(--font-ui)` : "";
    if (document.activeElement !== this.size) this.size.value = String(s.size ?? DEFAULT_SIZE);
    this.t.ha.set({ icon: ALIGN_ICONS[s.ha ?? "l"] });
    this.t.va.set({ icon: VALIGN_ICONS[s.va ?? "b"] });
    this.t.wrap.set({ icon: WRAP_ICONS[s.wrap ?? "overflow"] });
    this.t.rot.set({ icon: ROT_ICONS[s.rot ?? "none"] });
    this.t.color.set({ swatch: resolveColor(s.color, theme) ?? getComputedStyle(document.documentElement).getPropertyValue("--text").trim() });
    this.t.fill.set({ swatch: resolveColor(s.fill, theme) });
  }
}
