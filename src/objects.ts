/* ------------------------------------------------------------------ *
 * Floating objects: charts, images, shapes and text boxes drawn over
 * the grid as DOM elements, anchored to a cell so they scroll, zoom and
 * follow column resizes with the sheet.
 * ------------------------------------------------------------------ */
import { chartData, chartSvg } from "./chart";
import type { Doc, ShapeObject, ShapeType, SheetObject } from "./doc";
import { newId } from "./doc";
import { resolveColor, type Theme } from "./format";
import type { Grid } from "./grid";
import { clamp, el } from "./util";

export interface LayerHost {
  doc(): Doc | null;
  onChange(): void;
  menu(o: SheetObject, x: number, y: number): void;
  editChart(o: SheetObject): void;
}

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const MIN = 16;

interface Node { el: HTMLElement; body: HTMLElement; key: string }

export const SHAPES: { shape: ShapeType; label: string; icon: string }[] = [
  { shape: "rect", label: "Rectangle", icon: '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="2.5" y="4" width="11" height="8" rx=".6"/></svg>' },
  { shape: "round", label: "Rounded rectangle", icon: '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="2.5" y="4" width="11" height="8" rx="2.4"/></svg>' },
  { shape: "ellipse", label: "Ellipse", icon: '<svg viewBox="0 0 16 16" width="14" height="14"><ellipse cx="8" cy="8" rx="5.5" ry="4.25"/></svg>' },
  { shape: "triangle", label: "Triangle", icon: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 3.25 13.5 12.5h-11Z"/></svg>' },
  { shape: "diamond", label: "Diamond", icon: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 2.5 13.5 8 8 13.5 2.5 8Z"/></svg>' },
  { shape: "arrow", label: "Arrow", icon: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M2.5 6.25h6.5V3.5L13.5 8 9 12.5V9.75H2.5Z"/></svg>' },
];

/** The outline of a shape in a w × h box. */
function shapePath(shape: ShapeType, w: number, h: number): string {
  const i = 0.75; // half the stroke, so it isn't clipped
  const W = w - i, H = h - i;
  switch (shape) {
    case "ellipse": return `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2 - i}" ry="${h / 2 - i}"/>`;
    case "triangle": return `<path d="M${w / 2},${i} L${W},${H} L${i},${H} Z"/>`;
    case "diamond": return `<path d="M${w / 2},${i} L${W},${h / 2} L${w / 2},${H} L${i},${h / 2} Z"/>`;
    case "arrow": {
      const head = Math.min(w * 0.45, h * 0.75);
      const x = W - head;
      return `<path d="M${i},${h * 0.3} H${x} V${i} L${W},${h / 2} L${x},${H} V${h * 0.7} H${i} Z"/>`;
    }
    case "round": { const r = Math.min(w, h) * 0.18; return `<rect x="${i}" y="${i}" width="${W - i}" height="${H - i}" rx="${r}"/>`; }
    case "rect": return `<rect x="${i}" y="${i}" width="${W - i}" height="${H - i}" rx="1"/>`;
    default: return "";
  }
}

export class ObjectLayer {
  readonly el: HTMLElement;
  selected: string | null = null;
  private nodes = new Map<string, Node>();
  private editingText: string | null = null;
  private clip: SheetObject | null = null;

  constructor(private grid: Grid, private host: LayerHost) {
    this.el = el("div", { id: "objects" });
    grid.wrap.append(this.el);
    // Clicking the grid deselects.
    document.getElementById("scroller")!.addEventListener("pointerdown", () => { if (this.selected) this.select(null, false); }, true);
  }

  private get doc() { return this.host.doc(); }
  private theme(): Theme {
    const t = document.documentElement.dataset.theme;
    return t === "dusk" ? "dusk" : t === "dark" ? "dark" : "light";
  }

  find(id: string | null): SheetObject | undefined {
    return id ? this.doc?.objects.find((o) => o.id === id) : undefined;
  }

  /** Screen box (relative to the grid area) of an object. */
  box(o: SheetObject): { x: number; y: number; w: number; h: number } {
    const g = this.grid, z = g.zoom;
    return { x: g.colLeft(o.c) + o.dx * z, y: g.rowTop(o.r) + o.dy * z, w: o.w * z, h: o.h * z };
  }

  /** Re-anchor an object so its top-left sits at screen point (x, y). */
  private placeAt(o: SheetObject, x: number, y: number) {
    const g = this.grid, z = g.zoom;
    const c = g.colAt(Math.max(g.rowHeaderWidth(), x));
    const r = g.rowAt(Math.max(g.headerHeight, y));
    o.c = c; o.r = r;
    o.dx = Math.max(0, (x - g.colLeft(c)) / z);
    o.dy = Math.max(0, (y - g.rowTop(r)) / z);
    if (x < g.colLeft(c)) o.dx = 0;
    if (y < g.rowTop(r)) o.dy = 0;
  }

  /** Where a new object should go: at screen point (x, y), or the view's centre. */
  anchorAt(x: number, y: number): { r: number; c: number; dx: number; dy: number } {
    const tmp = { r: 0, c: 0, dx: 0, dy: 0 } as SheetObject;
    this.placeAt(tmp, x, y);
    return { r: tmp.r, c: tmp.c, dx: tmp.dx, dy: tmp.dy };
  }

  add(o: Omit<SheetObject, "id">, label: string): SheetObject {
    const d = this.doc!;
    const before = d.snapshotObjects();
    const obj = { ...o, id: newId() } as SheetObject;
    d.objects.push(obj);
    d.commitObjects(before, label);
    this.select(obj.id);
    this.host.onChange();
    return obj;
  }

  /** Change an object as one undo step. */
  update(id: string, patch: Partial<SheetObject>, label = "Edit object") {
    const d = this.doc, o = this.find(id);
    if (!d || !o) return;
    const before = d.snapshotObjects();
    Object.assign(o, patch);
    d.commitObjects(before, label);
    this.host.onChange();
  }

  remove(id: string) {
    const d = this.doc;
    if (!d) return;
    const before = d.snapshotObjects();
    d.objects = d.objects.filter((o) => o.id !== id);
    d.commitObjects(before, "Delete object");
    if (this.selected === id) this.selected = null;
    this.host.onChange();
    this.grid.focus();
  }

  duplicate(id: string) {
    const o = this.find(id);
    if (!o) return;
    const { id: _, ...rest } = o;
    const copy = this.add({ ...rest, dx: rest.dx + 16, dy: rest.dy + 16 } as Omit<SheetObject, "id">, "Duplicate");
    void copy;
  }

  order(id: string, front: boolean) {
    const d = this.doc, o = this.find(id);
    if (!d || !o) return;
    const before = d.snapshotObjects();
    d.objects = d.objects.filter((x) => x !== o);
    if (front) d.objects.push(o); else d.objects.unshift(o);
    d.commitObjects(before, front ? "Bring to front" : "Send to back");
    this.host.onChange();
  }

  select(id: string | null, focus = true) {
    if (this.editingText && this.editingText !== id) this.finishText();
    this.selected = id;
    this.render();
    if (id && focus) this.nodes.get(id)?.el.focus({ preventScroll: true });
    if (!id && focus) this.grid.focus();
  }

  /* -------------------------------- drawing -------------------------------- */

  render() {
    const d = this.doc;
    const g = this.grid;
    if (!d || d.loading !== null) {
      for (const n of this.nodes.values()) n.el.remove();
      this.nodes.clear();
      this.el.hidden = true;
      return;
    }
    this.el.hidden = !d.objects.length;
    const rhw = g.rowHeaderWidth(), hh = g.headerHeight;
    const vp = g.viewport();
    Object.assign(this.el.style, { left: `${rhw}px`, top: `${hh}px`, width: `${Math.max(0, vp.w - rhw)}px`, height: `${Math.max(0, vp.h - hh)}px` });
    const seen = new Set<string>();
    const theme = this.theme();
    d.objects.forEach((o, z) => {
      seen.add(o.id);
      let n = this.nodes.get(o.id);
      if (!n) { n = this.makeNode(o); this.nodes.set(o.id, n); }
      const b = this.box(o);
      const st = n.el.style;
      st.transform = `translate(${b.x - rhw}px, ${b.y - hh}px)`;
      st.width = `${b.w}px`;
      st.height = `${b.h}px`;
      st.zIndex = String(z + 1);
      n.el.classList.toggle("selected", this.selected === o.id);
      // Content only changes when the object or (for charts) the data does.
      const key = JSON.stringify(o) + (o.kind === "chart" ? `|${d.version}|${g.zoom}` : "") + (o.kind === "shape" ? `|${theme}|${g.zoom}` : "") + (o.kind === "image" ? `|${d.images.get(o.img)?.length}` : "");
      if (key !== n.key && this.editingText !== o.id) { n.key = key; this.paint(o, n, d, theme); }
      if (n.el.parentElement !== this.el) this.el.append(n.el);
    });
    for (const [id, n] of this.nodes) if (!seen.has(id)) { n.el.remove(); this.nodes.delete(id); }
    if (this.selected && !seen.has(this.selected)) this.selected = null;
  }

  private paint(o: SheetObject, n: Node, d: Doc, theme: Theme) {
    const z = this.grid.zoom;
    n.el.dataset.kind = o.kind === "shape" && o.shape === "text" ? "text" : o.kind;
    if (o.kind === "chart") {
      n.body.innerHTML = chartSvg(o.chart, chartData(d, o.range), o.w, o.h, o.title);
    } else if (o.kind === "image") {
      let img = n.body.firstElementChild as HTMLImageElement | null;
      if (!img) { img = el("img", { draggable: "false", alt: "" }) as HTMLImageElement; n.body.append(img); }
      const src = d.images.get(o.img) ?? "";
      if (img.src !== src) img.src = src;
    } else {
      const fill = o.shape === "text" ? null : resolveColor(o.fill, theme);
      const stroke = o.shape === "text" ? null : resolveColor(o.stroke, theme);
      const text = resolveColor(o.color, theme);
      const w = o.w * z, h = o.h * z;
      n.body.innerHTML = o.shape === "text" ? "" :
        `<svg class="shape" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="${fill ?? "none"}" stroke="${stroke ?? "none"}" stroke-width="1.5" stroke-linejoin="round">${shapePath(o.shape, w, h)}</svg>`;
      const t = el("div", { class: "text" });
      t.textContent = o.text ?? "";
      t.style.fontSize = `${13 * z}px`;
      if (text) t.style.color = text;
      n.body.append(t);
    }
  }

  private makeNode(o: SheetObject): Node {
    const body = el("div", { class: "body" });
    const node = el("div", { class: "obj", tabindex: "-1" }, body);
    for (const h of HANDLES) node.append(el("div", { class: `handle ${h}`, "data-h": h }));
    const n: Node = { el: node, body, key: "" };
    node.addEventListener("pointerdown", (e) => this.onDown(e, o.id));
    node.addEventListener("dblclick", (e) => {
      const obj = this.find(o.id);
      if (!obj) return;
      e.stopPropagation();
      if (obj.kind === "chart") this.host.editChart(obj);
      else if (obj.kind === "shape") this.editText(obj.id);
    });
    node.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (this.editingText === o.id) return;
      const obj = this.find(o.id);
      if (!obj) return;
      this.select(obj.id);
      this.host.menu(obj, e.clientX, e.clientY);
    });
    node.addEventListener("keydown", (e) => this.onKey(e, o.id));
    // Scrolling over an object scrolls the sheet underneath.
    node.addEventListener("wheel", (e) => {
      if (e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      this.grid.scrollBy(e.shiftKey ? e.deltaY : e.deltaX, e.shiftKey ? 0 : e.deltaY);
    }, { passive: false });
    return n;
  }

  /* ------------------------------ interaction ------------------------------ */

  private onDown(e: PointerEvent, id: string) {
    const d = this.doc, o = this.find(id);
    if (!d || !o || e.button !== 0) return;
    if (this.editingText === id) return; // let the caret move
    e.preventDefault();
    e.stopPropagation();
    if (this.grid.editing) this.grid.commitEdit();
    this.select(id);
    const handle = (e.target as HTMLElement).dataset.h as Handle | undefined;
    const before = d.snapshotObjects();
    const start = this.box(o);
    const sx = e.clientX, sy = e.clientY;
    const aspect = o.w / o.h;
    const keepAspect = (o.kind === "image") !== e.shiftKey; // images keep their shape unless Shift
    let moved = false;
    const z = this.grid.zoom;
    const node = this.nodes.get(id)!.el;
    node.setPointerCapture(e.pointerId);
    document.body.classList.toggle("dragging-object", !handle);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      moved = true;
      if (!handle) {
        this.placeAt(o, start.x + dx, start.y + dy);
      } else {
        let { x, y, w, h } = start;
        if (handle.includes("e")) w = start.w + dx;
        if (handle.includes("w")) { w = start.w - dx; x = start.x + dx; }
        if (handle.includes("s")) h = start.h + dy;
        if (handle.includes("n")) { h = start.h - dy; y = start.y + dy; }
        const corner = handle.length === 2;
        if (keepAspect && corner) {
          // Follow whichever edge moved further, keeping the proportions.
          if (Math.abs(w / start.w) > Math.abs(h / start.h)) h = w / aspect; else w = h * aspect;
          if (handle.includes("w")) x = start.x + start.w - w;
          if (handle.includes("n")) y = start.y + start.h - h;
        }
        const m = MIN * z;
        if (w < m) { if (handle.includes("w")) x -= m - w; w = m; }
        if (h < m) { if (handle.includes("n")) y -= m - h; h = m; }
        o.w = w / z; o.h = h / z;
        this.placeAt(o, x, y);
      }
      this.render();
    };
    const up = () => {
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", up);
      document.body.classList.remove("dragging-object");
      if (moved) {
        d.commitObjects(before, handle ? "Resize" : "Move");
        this.host.onChange();
      }
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", up);
  }

  private onKey(e: KeyboardEvent, id: string) {
    if (this.editingText === id) return;
    const d = this.doc, o = this.find(id);
    if (!d || !o) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === "Delete" || e.key === "Backspace") { stop(); this.remove(id); }
    else if (e.key === "Escape") { stop(); this.select(null); }
    else if (e.key === "Enter" || e.key === "F2") {
      stop();
      if (o.kind === "chart") this.host.editChart(o);
      else if (o.kind === "shape") this.editText(id);
    }
    else if (e.key.startsWith("Arrow")) {
      stop();
      const step = (e.shiftKey ? 10 : 1) * this.grid.zoom;
      const b = this.box(o);
      const before = d.snapshotObjects();
      this.placeAt(o, b.x + (e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0), b.y + (e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0));
      d.commitObjects(before, "Move");
      this.host.onChange();
    }
    else if (ctrl && k === "z") { stop(); this.grid.applyUndo(e.shiftKey ? d.redo() : d.undo()); this.host.onChange(); }
    else if (ctrl && k === "y") { stop(); this.grid.applyUndo(d.redo()); this.host.onChange(); }
    else if (ctrl && k === "d") { stop(); this.duplicate(id); }
    else if (ctrl && (k === "c" || k === "x")) { stop(); this.clip = { ...o }; if (k === "x") this.remove(id); }
    else if (ctrl && k === "v") { stop(); this.pasteObject(); }
    else if (o.kind === "shape" && e.key.length === 1 && !ctrl && !e.altKey) {
      // Typing on a shape starts editing its text, like Slides.
      stop();
      this.editText(id, e.key);
    }
  }

  pasteObject(): boolean {
    if (!this.clip || !this.doc) return false;
    const { id: _, ...rest } = this.clip;
    this.clip = { ...this.clip, dx: this.clip.dx + 16, dy: this.clip.dy + 16 };
    this.add({ ...rest, dx: rest.dx + 16, dy: rest.dy + 16 } as Omit<SheetObject, "id">, "Paste");
    return true;
  }

  /** Type into a shape or text box. */
  editText(id: string, initial?: string) {
    const o = this.find(id) as ShapeObject | undefined;
    const n = this.nodes.get(id);
    if (!o || o.kind !== "shape" || !n) return;
    const t = n.body.querySelector<HTMLElement>(".text");
    if (!t) return;
    this.editingText = id;
    n.el.classList.add("editing");
    t.contentEditable = "plaintext-only";
    if (t.contentEditable !== "plaintext-only") t.contentEditable = "true";
    if (initial !== undefined) t.textContent = initial;
    t.focus();
    const range = document.createRange();
    range.selectNodeContents(t);
    if (initial !== undefined) range.collapse(false);
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    const key = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) { e.preventDefault(); this.finishText(); n.el.focus(); }
      else if (e.key === "Tab") e.preventDefault();
    };
    const blur = () => this.finishText();
    t.addEventListener("keydown", key);
    t.addEventListener("blur", blur, { once: true });
    this.finishCleanup = () => { t.removeEventListener("keydown", key); t.removeEventListener("blur", blur); };
  }

  private finishCleanup: (() => void) | null = null;

  private finishText() {
    const id = this.editingText;
    if (!id) return;
    this.editingText = null;
    this.finishCleanup?.();
    this.finishCleanup = null;
    const n = this.nodes.get(id);
    const t = n?.body.querySelector<HTMLElement>(".text");
    n?.el.classList.remove("editing");
    if (t) t.contentEditable = "false";
    const o = this.find(id) as ShapeObject | undefined;
    if (!o || !t) return;
    const text = (t.innerText ?? "").replace(/\n$/, "");
    if (text !== (o.text ?? "")) this.update(id, { text }, "Edit text");
    else this.render();
  }

  /** Keep objects in view after the sheet changed size (e.g. rows deleted). */
  clampToSheet(d: Doc) {
    for (const o of d.objects) {
      o.r = clamp(o.r, 0, Math.max(0, d.displayRows() - 1));
      o.c = clamp(o.c, 0, Math.max(0, d.displayCols() - 1));
    }
  }
}
