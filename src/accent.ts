/* ------------------------------------------------------------------ *
 * Accent colours. "Clay" is the stylesheet's own; the others override
 * the accent variables, worked out per theme from one base colour.
 * ------------------------------------------------------------------ */
type Mode = "light" | "dark" | "dusk";

export const ACCENTS: { id: string; label: string; base: string }[] = [
  { id: "clay", label: "Clay", base: "#d97757" },
  { id: "ocean", label: "Ocean", base: "#4f86c6" },
  { id: "teal", label: "Teal", base: "#3d968d" },
  { id: "sage", label: "Sage", base: "#6c8c55" },
  { id: "amber", label: "Amber", base: "#c48a2c" },
  { id: "rose", label: "Rose", base: "#c9617f" },
  { id: "plum", label: "Plum", base: "#8c68b0" },
  { id: "graphite", label: "Graphite", base: "#6e6c66" },
];

const VARS = ["--accent", "--accent-text", "--accent-soft", "--accent-softer", "--sel-fill", "--sel-head", "--sel-head-strong"];

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as [number, number, number];
}
const hex = (c: [number, number, number]) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
const rgba = (c: [number, number, number], a: number) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;

export function applyAccent(id: string, mode: Mode) {
  const root = document.documentElement.style;
  // "custom:#4f86c6" is a colour picked by hand.
  const a = id.startsWith("custom:") && /^#[0-9a-f]{6}$/i.test(id.slice(7)) ? { id, label: "Custom", base: id.slice(7) } : ACCENTS.find((x) => x.id === id);
  if (!a || a.id === "clay") { for (const v of VARS) root.removeProperty(v); return; }
  const base = rgb(a.base);
  const white: [number, number, number] = [255, 255, 255], black: [number, number, number] = [0, 0, 0];
  const c = mode === "light" ? base : mix(base, white, mode === "dusk" ? 0.24 : 0.14);
  const text = mode === "light" ? mix(base, black, 0.18) : mix(base, white, mode === "dusk" ? 0.36 : 0.26);
  const k = mode === "light" ? 1 : mode === "dusk" ? 1.9 : 1.6;
  root.setProperty("--accent", hex(c));
  root.setProperty("--accent-text", hex(text));
  root.setProperty("--accent-soft", rgba(c, +(0.1 * k).toFixed(3)));
  root.setProperty("--accent-softer", rgba(c, +(0.06 * k * 0.85).toFixed(3)));
  root.setProperty("--sel-fill", rgba(c, +(0.065 * (mode === "light" ? 1 : 1.7)).toFixed(3)));
  root.setProperty("--sel-head", rgba(c, +(0.15 * (mode === "light" ? 1 : 1.3)).toFixed(3)));
  root.setProperty("--sel-head-strong", rgba(c, +(0.32 * (mode === "light" ? 1 : 1.2)).toFixed(3)));
}
