/* A minimal browser environment for tests that touch the page (import first). */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Node", "Event", "KeyboardEvent", "getComputedStyle"]) {
  try { g[k] = dom.window[k]; } catch { /* read-only in this Node */ }
}
export {};
