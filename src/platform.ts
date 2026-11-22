/**
 * Small platform differences. Shortcuts are written Windows-style in the
 * source ("Ctrl+Shift+S"); on a Mac, `keys()` rewrites them the Mac way
 * ("⇧⌘S"). The key handlers already accept ⌘ wherever they accept Ctrl.
 */
export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");

/** Name of the OS for "Match system"-style labels. */
export const osName = isMac ? "macOS" : "Windows";

const ORDER: [RegExp, string][] = [[/Control/, "⌃"], [/Alt/, "⌥"], [/Shift/, "⇧"], [/Ctrl/, "⌘"]];
const KEY_NAMES: Record<string, string> = { Enter: "Return", Tab: "Tab", PgDn: "PgDn", PgUp: "PgUp" };

function macCombo(mods: string, key: string): string {
  const sym = ORDER.filter(([re]) => re.test(mods)).map(([, s]) => s).join("");
  return sym + (KEY_NAMES[key] ?? key);
}

/** Rewrite every shortcut in a piece of text for the current platform. */
export function keys(text: string): string {
  if (!isMac) return text;
  return text
    // Mac conventions where the keys themselves differ.
    .replace(/Ctrl\+Y\b/g, "Ctrl+Shift+Z")
    .replace(/Ctrl\+H\b/g, "Ctrl+Shift+H")
    .replace(/Ctrl\+Tab\b/g, "Control+Tab")
    .replace(/Ctrl \+ scroll/g, "⌘ + scroll or pinch")
    .replace(/\bCtrl-(click|drag)/g, "⌘-$1")
    .replace(/((?:(?:Control|Ctrl|Alt|Shift)\+)+)([^\s)/,]+|,)/g, (_, mods: string, key: string) => macCombo(mods, key));
}

/** Rewrite shortcut hints in tooltips already in the page (from index.html). */
export function localiseTitles(root: ParentNode = document) {
  if (!isMac) return;
  root.querySelectorAll<HTMLElement>("[title]").forEach((n) => { n.title = keys(n.title); });
}
