/** The slim tools row under the title bar. */
import { el } from "./util";

/** 16×16 icons drawn with the shared 1.4px stroke style (see .ico in CSS). */
export const ICONS = {
  // All drawn on a 16px grid, kept inside roughly 2.5–13.5 so they share one optical size.
  undo: '<path d="M6 3.75 3.25 6.5 6 9.25"/><path d="M3.5 6.5h6a3.25 3.25 0 0 1 0 6.5H7.5"/>',
  redo: '<path d="M10 3.75 12.75 6.5 10 9.25"/><path d="M12.5 6.5h-6a3.25 3.25 0 0 0 0 6.5h2"/>',
  sortAsc: '<path d="M2.75 4.5h3.5M2.75 8h5M2.75 11.5h6.5"/><path d="M12.25 3.5v9M10.5 10.75l1.75 1.75L14 10.75"/>',
  sortDesc: '<path d="M2.75 4.5h6.5M2.75 8h5M2.75 11.5h3.5"/><path d="M12.25 3.5v9M10.5 10.75l1.75 1.75L14 10.75"/>',
  filter: '<path d="M2.75 3.75h10.5l-4 4.75v3.75l-2.5 1.25v-5Z"/>',
  freeze: '<rect x="2.5" y="3" width="11" height="10" rx="1.75"/><path d="M2.5 6.5h11"/>',
  insertRow: '<rect x="2.5" y="9" width="11" height="4.25" rx="1.25"/><path d="M8 2.5v4.5M5.75 4.75h4.5"/>',
  insertCol: '<rect x="9" y="2.5" width="4.25" height="11" rx="1.25"/><path d="M2.5 8H7M4.75 5.75v4.5"/>',
  deleteRow: '<rect x="2.5" y="9" width="11" height="4.25" rx="1.25"/><path d="M6.25 3l3.5 3.5M9.75 3l-3.5 3.5"/>',
  deleteCol: '<rect x="9" y="2.5" width="4.25" height="11" rx="1.25"/><path d="M3 6.25l3.5 3.5M6.5 6.25 3 9.75"/>',
  fitWidth: '<path d="M2.75 3.5v9M13.25 3.5v9M5 8h6M6.75 6.25 5 8l1.75 1.75M9.25 6.25 11 8l-1.75 1.75"/>',
  sum: '<path d="M11.5 3.5h-7L8.25 8 4.5 12.5h7"/>',
  search: '<circle cx="7.25" cy="7.25" r="4"/><path d="m10.25 10.25 3 3"/>',
  caret: '<path d="M5.5 6.75 8 9.25l2.5-2.5"/>',
  alignL: '<path d="M2.5 3h11M2.5 5.5h7M2.5 8h11M2.5 10.5h7M2.5 13h11" style="stroke-width:1.3"/>',
  alignC: '<path d="M2.5 3h11M4.5 5.5h7M2.5 8h11M4.5 10.5h7M2.5 13h11" style="stroke-width:1.3"/>',
  alignR: '<path d="M2.5 3h11M6.5 5.5h7M2.5 8h11M6.5 10.5h7M2.5 13h11" style="stroke-width:1.3"/>',
  vTop: '<path d="M2.5 2.75h11M8 13.5V7.5"/><path d="M5.25 8.5 8 5l2.75 3.5Z" style="fill:currentColor;stroke:none"/>',
  vMid: '<path d="M2.5 8h11M8 1.75v2.5M8 14.25v-2.5"/><path d="M5.75 4 8 6.4 10.25 4Z M5.75 12 8 9.6l2.25 2.4Z" style="fill:currentColor;stroke:none"/>',
  vBot: '<path d="M2.5 13.25h11M8 2.5v6"/><path d="M5.25 7.5 8 11l2.75-3.5Z" style="fill:currentColor;stroke:none"/>',
  wrapOverflow: '<path d="M2.75 2.75v10.5M5 8h6.5"/><path d="M10.5 5.25 14 8l-3.5 2.75Z" style="fill:currentColor;stroke:none"/>',
  wrapWrap: '<path d="M2.75 2.75v10.5M13.25 2.75v10.5M5 4.25h3.75a2.75 2.75 0 0 1 0 5.5H7.25"/><path d="M7.75 7.6 4.9 9.75l2.85 2.15Z" style="fill:currentColor;stroke:none"/>',
  wrapClip: '<path d="M2.75 2.75v10.5M13.25 2.75v10.5M5 8h6"/>',
  rotNone: '<path d="M3.5 10 6.75 2.25 10 10M4.7 7.25h4.1M2.75 13h8"/><path d="M10.5 11 13.5 13l-3 2Z" style="fill:currentColor;stroke:none"/>',
  rotStack: '<path d="M9 9.5 11.25 3.25 13.5 9.5M9.9 7.25h2.7M5 2.25v9.75"/><path d="M2.75 11 5 14l2.25-3Z" style="fill:currentColor;stroke:none"/>',
  rotUp: '<path d="M10.25 13.25 3.25 10.5l7-2.75M8.2 12.4V8.6M12.75 13V4"/><path d="M10.75 5 12.75 2l2 3Z" style="fill:currentColor;stroke:none"/>',
  link: '<path d="M6.75 9.25a2.75 2.75 0 0 0 3.9 0l2-2a2.75 2.75 0 0 0-3.9-3.9l-.75.75M9.25 6.75a2.75 2.75 0 0 0-3.9 0l-2 2a2.75 2.75 0 0 0 3.9 3.9l.75-.75"/>',
  merge: '<path d="M5.25 2.75H2.75v3M2.75 10.25v3h2.5M10.75 2.75h2.5v3M13.25 10.25v3h-2.5"/><path d="M2.75 8H7M5.25 6 7.25 8l-2 2M13.25 8H9M10.75 6 8.75 8l2 2"/>',
  // Colour icons: glyph above, a swatch bar along the bottom.
  textColor: '<path d="M4.6 10.25 8 2.25l3.4 8M5.85 7.4h4.3"/><rect class="swatch" x="2" y="11.75" width="12" height="3" rx="1" style="stroke:none"/>',
  fill: '<path d="M6.75 2.5 11.25 7 7.2 11.05a.85.85 0 0 1-1.2 0L2.7 7.75a.85.85 0 0 1 0-1.2Z"/><path d="M2.6 7.4h8.3L7.2 11.05a.85.85 0 0 1-1.2 0L2.7 7.75Z" style="fill:currentColor;stroke:none"/><path d="M5 1.75 6.9 3.65"/><path d="M13.25 7.5s1.3 1.5 1.3 2.3a1.3 1.3 0 0 1-2.6 0c0-.8 1.3-2.3 1.3-2.3Z" style="fill:currentColor;stroke:none"/><rect class="swatch" x="2" y="11.75" width="12" height="3" rx="1" style="stroke:none"/>',
  decDown: '<circle cx="2.6" cy="9" r="1.05" style="fill:currentColor;stroke:none"/><ellipse cx="7" cy="6" rx="2.25" ry="3.4"/><path d="M14 13.25H8.5M10.25 11.5 8.5 13.25 10.25 15"/>',
  decUp: '<circle cx="1.6" cy="9" r="1.05" style="fill:currentColor;stroke:none"/><ellipse cx="5.25" cy="6" rx="2" ry="3.4"/><ellipse cx="10.75" cy="6" rx="2" ry="3.4"/><path d="M7.5 13.25H13M11.25 11.5 13 13.25 11.25 15"/>',
  bold: '<path d="M4.75 2.75h4a2.5 2.5 0 0 1 0 5h-4Zm0 5h4.75a2.75 2.75 0 0 1 0 5.5H4.75Z" style="stroke-width:2"/>',
  italic: '<path d="M7 2.75h5.5M3.5 13.25H9M9.75 2.75 6.25 13.25" style="stroke-width:1.6"/>',
  strike: '<path d="M2.5 8.25h11"/><path d="M11.1 4.6C10.6 3.4 9.4 2.75 8 2.75c-1.9 0-3.25 1-3.25 2.55 0 .9.45 1.55 1.2 2"/><path d="M10.65 10c.4.4.6.9.6 1.45 0 1.6-1.45 2.55-3.25 2.55-1.65 0-2.9-.65-3.4-1.9"/>',
  arrowL: '<path d="M12 8.5H4.5M6.75 6.25 4.5 8.5l2.25 2.25"/>',
  arrowR: '<path d="M4 8.5h7.5M9.25 6.25l2.25 2.25-2.25 2.25"/>',
  minus: '<path d="M4.5 8h7"/>',
  plus: '<path d="M8 4.5v7M4.5 8h7"/>',
  clearFormat: '<path d="M4 3.25h8M8 3.25 6 12.75M3 13.25l10-10" />',
};

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 16): SVGElement {
  const span = document.createElement("span");
  span.innerHTML = `<svg viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true">${ICONS[name]}</svg>`;
  return span.firstElementChild as SVGElement;
}

export interface ToolButton {
  el: HTMLButtonElement;
  set(state: { disabled?: boolean; on?: boolean; text?: string; icon?: IconName; swatch?: string | null }): void;
}

export function toolButton(opts: {
  icon?: IconName;
  text?: string;
  /** A styled letter (B, I, U, S) instead of an icon. */
  glyph?: string;
  glyphClass?: string;
  title: string;
  caret?: boolean;
  onClick: (b: HTMLButtonElement) => void;
}): ToolButton {
  const b = el("button", { class: "tb", title: opts.title, "aria-label": opts.title });
  let ico: SVGElement | null = opts.icon ? icon(opts.icon) : null;
  if (ico) b.append(ico);
  if (opts.glyph) b.append(el("span", { class: "glyph " + (opts.glyphClass ?? ""), text: opts.glyph }));
  const txt = opts.text !== undefined ? el("span", { class: "txt", text: opts.text }) : null;
  if (txt) b.append(txt);
  if (opts.caret) { const c = icon("caret", 10); c.classList.add("caret"); b.append(c); }
  // Keep keyboard focus in the grid when clicking toolbar buttons.
  b.addEventListener("pointerdown", (e) => e.preventDefault());
  b.addEventListener("click", () => opts.onClick(b));
  return {
    el: b,
    set(s) {
      if (s.disabled !== undefined) b.disabled = s.disabled;
      if (s.on !== undefined) b.classList.toggle("on", s.on);
      if (s.text !== undefined && txt) txt.textContent = s.text;
      if (s.icon && ico) { const n = icon(s.icon); ico.replaceWith(n); ico = n; }
      if (s.swatch !== undefined && ico) {
        const sw = ico.querySelector<SVGRectElement>(".swatch");
        if (sw) { sw.style.fill = s.swatch ?? "var(--line-strong)"; sw.style.stroke = "none"; }
      }
    },
  };
}

export const divider = () => el("span", { class: "div" });
export const grow = () => el("span", { class: "grow" });
