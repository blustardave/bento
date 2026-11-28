/* Keyboard and wheel handling. */
import "./dom";
import { WheelZoom, SCROLL_TAIL_MS } from "../src/wheelzoom";
import { isAltGr, cmdKey } from "../src/platform";

let fails = 0;
function eq(a: unknown, b: unknown, msg: string) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) { fails++; console.log(`FAIL ${msg}\n  got ${ja}\n  exp ${jb}`); }
}
const ev = (o: Partial<{ ctrlKey: boolean; metaKey: boolean; deltaY: number; deltaMode: number }>) => ({ ctrlKey: false, metaKey: false, deltaY: 0, deltaMode: 0, ...o });

/* The copy-zooms-the-app bug: scrolling, then pressing Ctrl to copy during the scroll's tail. */
for (const mac of [false, true]) {
  const z = new WheelZoom(mac);
  let t = 0;
  for (let i = 0; i < 20; i++) z.handle(ev({ deltaY: -30 }), (t += 16)); // a trackpad scroll
  const tail = [];
  for (let i = 0; i < 20; i++) tail.push(z.handle(ev({ deltaY: -10, ctrlKey: true, metaKey: mac }), (t += 16)).kind);
  eq([...new Set(tail)], ["scroll"], `${mac ? "Mac" : "Windows"}: scroll tail with Ctrl/⌘ held never zooms`);
}
{
  const z = new WheelZoom(false);
  z.handle(ev({ deltaY: 100 }), 0);
  eq(z.handle(ev({ ctrlKey: true, deltaY: -100 }), SCROLL_TAIL_MS + 10), { kind: "step", dir: 1 }, "Ctrl + wheel after a pause zooms in one step");
  eq(z.handle(ev({ ctrlKey: true, deltaY: 100 }), SCROLL_TAIL_MS + 50), { kind: "step", dir: -1 }, "…and out");
  eq(z.handle(ev({ ctrlKey: true, deltaY: 0 }), SCROLL_TAIL_MS + 90).kind, "ignore", "sideways Ctrl+scroll doesn't zoom out");
  eq(z.handle(ev({ ctrlKey: true, deltaY: 60 }), SCROLL_TAIL_MS + 130).kind, "ignore", "half a notch: not yet");
  eq(z.handle(ev({ ctrlKey: true, deltaY: 60 }), SCROLL_TAIL_MS + 170), { kind: "step", dir: -1 }, "…two halves make a step");
  const pinch = z.handle(ev({ ctrlKey: true, deltaY: -5 }), SCROLL_TAIL_MS + 210);
  eq(pinch.kind === "scale" && pinch.factor > 1 && pinch.factor < 1.1, true, "pinch zooms smoothly");
}
{
  const z = new WheelZoom(true);
  eq(z.handle(ev({ metaKey: true, deltaY: -100 }), 10_000).kind, "scroll", "Mac: ⌘ + scroll just scrolls");
  eq(z.handle(ev({ ctrlKey: true, deltaY: -4 }), 20_000).kind, "scale", "Mac: pinch zooms");
}

/* AltGr (Ctrl+Alt on Windows) types characters; it's never a shortcut. */
{
  const k = (key: string, o: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key, ctrlKey: true, altKey: true, ...o });
  eq([isAltGr(k("\\")), isAltGr(k("]")), isAltGr(k("@")), isAltGr(k("€"))], [true, true, true, true], "AltGr symbols are typing");
  eq([isAltGr(k("-")), isAltGr(k("a")), isAltGr(new KeyboardEvent("keydown", { key: "\\", ctrlKey: true }))], [false, false, false], "real Ctrl+Alt shortcuts and Ctrl+\\ still work");
  eq([cmdKey({ ctrlKey: true, metaKey: false }), cmdKey({ ctrlKey: false, metaKey: true })], [true, false], "Ctrl is the shortcut key off a Mac");
}

console.log(fails ? `${fails} INPUT FAILURE(S)` : "INPUT PASS");
if (fails) process.exit(1);
