import { Doc } from "./doc";
import { closeMenus } from "./ui";
import { colName, el, formatInt, parseNum } from "./util";

const MAX_SHOWN = 1000;
let current: { close: () => void } | null = null;

/** The per-column "show only these values" popover. */
export function openFilter(doc: Doc, col: number, x: number, y: number, onApply: () => void) {
  closeMenus();
  current?.close();

  // Count each distinct value in the column (below the header row).
  const counts = new Map<string, number>();
  const start = doc.freezeHeader ? 1 : 0;
  for (let r = start; r < doc.rows.length; r++) {
    const v = doc.display(r, col);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const values = [...counts.keys()].sort((a, b) => {
    if (a === "") return 1;
    if (b === "") return -1;
    const an = parseNum(a), bn = parseNum(b);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn;
    return coll.compare(a, b);
  });
  const hidden = new Set(doc.filters.get(col) ?? []);

  const header = doc.freezeHeader ? doc.display(0, col) : "";
  const search = el("input", { class: "field", placeholder: `Search ${formatInt(values.length)} values`, spellcheck: "false" });
  const list = el("div", { class: "list" });
  const note = el("div", { class: "note" });
  const all = el("button", { text: "Select all" });
  const none = el("button", { text: "Clear" });
  const cancel = el("button", { class: "small-btn", text: "Cancel" });
  const apply = el("button", { class: "small-btn primary", text: "Apply" });
  const reset = el("button", { class: "small-btn", text: "Remove filter" });
  const panel = el("div", { class: "panel filter" },
    el("div", { class: "title", text: header ? `Filter “${header}”` : `Filter column ${colName(col)}` }),
    search,
    el("div", { class: "links" }, all, none),
    list,
    note,
    el("div", { class: "foot" }, doc.filters.has(col) ? reset : null, el("span", { style: "flex:1" }), cancel, apply),
  );

  function shown(): string[] {
    const q = search.value.toLowerCase();
    return q ? values.filter((v) => v.toLowerCase().includes(q)) : values;
  }

  function render() {
    list.textContent = "";
    const vs = shown();
    for (const v of vs.slice(0, MAX_SHOWN)) {
      const cb = el("input", { type: "checkbox" });
      cb.checked = !hidden.has(v);
      cb.addEventListener("change", () => { if (cb.checked) hidden.delete(v); else hidden.add(v); });
      list.append(el("label", {},
        cb,
        el("span", { class: "v", text: v === "" ? "(Blanks)" : v }),
        el("span", { class: "n", text: formatInt(counts.get(v) ?? 0) }),
      ));
    }
    note.textContent = vs.length > MAX_SHOWN ? `Showing ${formatInt(MAX_SHOWN)} of ${formatInt(vs.length)} — search to narrow down` : vs.length ? "" : "No matching values";
    note.hidden = !note.textContent;
  }

  search.addEventListener("input", render);
  all.addEventListener("click", () => { for (const v of shown()) hidden.delete(v); render(); });
  none.addEventListener("click", () => { for (const v of shown()) hidden.add(v); render(); });
  cancel.addEventListener("click", () => close());
  reset.addEventListener("click", () => { doc.setFilter(col, null); close(); onApply(); });
  apply.addEventListener("click", () => { doc.setFilter(col, new Set(hidden)); close(); onApply(); });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); apply.click(); }
  });

  function onKey(e: KeyboardEvent) { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } }
  function onDown(e: PointerEvent) { if (!panel.contains(e.target as Node)) close(); }
  function close() {
    panel.remove();
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("pointerdown", onDown, true);
    current = null;
  }

  render();
  document.body.append(panel);
  const r = panel.getBoundingClientRect();
  panel.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + "px";
  panel.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + "px";
  search.focus();
  setTimeout(() => {
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
  });
  current = { close };
}
