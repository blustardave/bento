/**
 * Turning Ctrl + wheel (or a trackpad pinch) into zooming.
 *
 * A trackpad, or a free-spinning mouse wheel, keeps sending scroll events
 * for a moment after you stop. Pressing Ctrl/⌘ to copy during that tail
 * used to zoom one full step per event. So wheel events count as zooming
 * only once scrolling has paused; movement is added up (one step per mouse
 * notch, smooth for pinches); sideways movement never zooms. On a Mac a
 * zoom is a pinch (which arrives as Control + wheel), not ⌘ + scroll.
 */
export type WheelLike = Pick<WheelEvent, "ctrlKey" | "metaKey" | "deltaY" | "deltaMode">;
export type ZoomAction = { kind: "scroll" } | { kind: "ignore" } | { kind: "step"; dir: 1 | -1 } | { kind: "scale"; factor: number };

/** How long scrolling must have paused before a modified wheel event means "zoom". */
export const SCROLL_TAIL_MS = 350;
const NOTCH = 80;

export class WheelZoom {
  private lastScroll = -Infinity;
  private acc = 0;

  constructor(private readonly mac: boolean) {}

  handle(e: WheelLike, now: number): ZoomAction {
    const zoomKey = this.mac ? e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (!zoomKey || now - this.lastScroll < SCROLL_TAIL_MS) {
      this.lastScroll = now;
      this.acc = 0;
      return { kind: "scroll" }; // an ordinary scroll, or the tail of one
    }
    if (!e.deltaY) return { kind: "ignore" }; // sideways
    const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    if (Math.abs(dy) < 40 && e.deltaMode === 0) return { kind: "scale", factor: Math.exp(-dy / 120) }; // pinch
    this.acc += dy;
    if (Math.abs(this.acc) < NOTCH) return { kind: "ignore" };
    const dir = this.acc < 0 ? 1 : -1;
    this.acc = 0;
    return { kind: "step", dir };
  }
}
