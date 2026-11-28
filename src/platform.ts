/**
 * Small platform differences. Shortcuts are written Windows-style in the
 * source ("Ctrl+Shift+S"); on a Mac, `keys()` rewrites them the Mac way
 * ("⇧⌘S"). The key handlers already accept ⌘ wherever they accept Ctrl.
 */
export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");

/**
 * The shortcut key: ⌘ on a Mac, Ctrl elsewhere. On a Mac, Control+letter
 * moves the cursor in text boxes (Control+A/E/F/B/N/P…), so it must never
 * run an app command there.
 */
export function cmdKey(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

/**
 * AltGr, which on Windows arrives as Ctrl+Alt. On many keyboards it types
 * characters (German AltGr+ß = \, French AltGr+) = ], AltGr+E = €…), so a
 * key press with it is typing, never a shortcut.
 */
export function isAltGr(e: KeyboardEvent): boolean {
  if (isMac) return false;
  if (e.getModifierState?.("AltGraph")) return true;
  // Some setups don't report AltGraph: Ctrl+Alt giving a symbol is still AltGr.
  return e.ctrlKey && e.altKey && e.key.length === 1 && !/^[a-z0-9=+-]$/i.test(e.key);
}

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
    .replace(/Ctrl \+ scroll/g, "Pinch")
    .replace(/\bCtrl-(click|drag)/g, "⌘-$1")
    .replace(/((?:(?:Control|Ctrl|Alt|Shift)\+)+)([^\s)/,]+|,)/g, (_, mods: string, key: string) => macCombo(mods, key));
}

/** Rewrite shortcut hints in tooltips already in the page (from index.html). */
export function localiseTitles(root: ParentNode = document) {
  if (!isMac) return;
  root.querySelectorAll<HTMLElement>("[title]").forEach((n) => { n.title = keys(n.title); });
}
