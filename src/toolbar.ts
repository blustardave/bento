/** The slim tools row under the title bar. */
import { el } from "./util";

/** 16×16 icons drawn with the shared 1.4px stroke style (see .ico in CSS). */
export const ICONS = {
  undo: '<path d="M5.75 3.75 3 6.5l2.75 2.75"/><path d="M3.25 6.5h6a3.5 3.5 0 0 1 0 7H7.5"/>',
  redo: '<path d="M10.25 3.75 13 6.5l-2.75 2.75"/><path d="M12.75 6.5h-6a3.5 3.5 0 0 0 0 7H8.5"/>',
  sortAsc: '<path d="M2.75 4h3.5M2.75 8h5M2.75 12h6.5"/><path d="M12.5 3.25v9.5M10.75 11l1.75 1.75L14.25 11"/>',
  sortDesc: '<path d="M2.75 4h6.5M2.75 8h5M2.75 12h3.5"/><path d="M12.5 3.25v9.5M10.75 11l1.75 1.75L14.25 11"/>',
  filter: '<path d="M2.75 3.5h10.5L9.25 8.25v4.5l-2.5-1.25V8.25Z"/>',
  freeze: '<rect x="2.5" y="3" width="11" height="10" rx="1.75"/><path d="M2.5 6.5h11"/><path d="M5.5 4.75h5" stroke-width="1.6"/>',
  insertRow: '<rect x="2.5" y="9" width="11" height="4.25" rx="1.25"/><path d="M8 2.5v4.5M5.75 4.75h4.5"/>',
  insertCol: '<rect x="9" y="2.5" width="4.25" height="11" rx="1.25"/><path d="M2.5 8H7M4.75 5.75v4.5"/>',
  deleteRow: '<rect x="2.5" y="9" width="11" height="4.25" rx="1.25"/><path d="M6.25 3l3.5 3.5M9.75 3l-3.5 3.5"/>',
  deleteCol: '<rect x="9" y="2.5" width="4.25" height="11" rx="1.25"/><path d="M3 6.25l3.5 3.5M6.5 6.25 3 9.75"/>',
  fitWidth: '<path d="M2.75 3v10M13.25 3v10M5 8h6M6.75 6.25 5 8l1.75 1.75M9.25 6.25 11 8l-1.75 1.75"/>',
  sum: '<path d="M11.75 3.5h-7.5L8.5 8l-4.25 4.5h7.5"/>',
  search: '<circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25 13.25 13.25"/>',
  caret: '<path d="M4.5 6.5 8 10l3.5-3.5"/>',
};

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 16): SVGElement {
  const span = document.createElement("span");
  span.innerHTML = `<svg viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true">${ICONS[name]}</svg>`;
  return span.firstElementChild as SVGElement;
}

export interface ToolButton {
  el: HTMLButtonElement;
  set(state: { disabled?: boolean; on?: boolean; text?: string }): void;
}

export function toolButton(opts: {
  icon?: IconName;
  text?: string;
  title: string;
  caret?: boolean;
  onClick: (b: HTMLButtonElement) => void;
}): ToolButton {
  const b = el("button", { class: "tb", title: opts.title, "aria-label": opts.title });
  if (opts.icon) b.append(icon(opts.icon));
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
    },
  };
}

export const divider = () => el("span", { class: "div" });
export const grow = () => el("span", { class: "grow" });
