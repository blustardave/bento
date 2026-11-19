/**
 * Bridge to Windows (via Tauri). When run in a plain browser during
 * development, falls back to file inputs and downloads.
 */
import { basename } from "./util";

export const isTauri = "__TAURI_INTERNALS__" in window;

export interface FileRef {
  name: string;
  path: string | null;
  file?: File; // browser fallback only
}

const OPEN_FILTERS = [
  { name: "Sheets", extensions: ["bento", "csv", "tsv", "txt", "tab"] },
  { name: "All files", extensions: ["*"] },
];
const SAVE_FILTERS = {
  bento: [{ name: "Bento sheet", extensions: ["bento"] }],
  csv: [{ name: "CSV", extensions: ["csv"] }, { name: "TSV", extensions: ["tsv"] }],
};

export async function pickFiles(): Promise<FileRef[]> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const res = await open({ multiple: true, filters: OPEN_FILTERS });
    if (!res) return [];
    const list = Array.isArray(res) ? res : [res];
    return list.map((p) => ({ name: basename(p), path: p }));
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ".bento,.csv,.tsv,.txt,.tab";
    input.onchange = () => resolve([...(input.files ?? [])].map((f) => ({ name: f.name, path: null, file: f })));
    input.click();
  });
}

export async function readFile(ref: FileRef): Promise<Uint8Array> {
  if (ref.file) return new Uint8Array(await ref.file.arrayBuffer());
  const { invoke } = await import("@tauri-apps/api/core");
  const buf = await invoke<ArrayBuffer>("read_file", { path: ref.path });
  return new Uint8Array(buf);
}

/** Ask where to save. Returns a path, or null if cancelled. */
export async function pickSavePath(suggested: string, kind: "bento" | "csv"): Promise<string | null> {
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    return (await save({ defaultPath: suggested, filters: SAVE_FILTERS[kind] })) ?? null;
  }
  return suggested;
}

export async function writeFile(path: string, bytes: Uint8Array): Promise<void> {
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("write_file", bytes, { headers: { "x-path": encodeURIComponent(path) } });
    return;
  }
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = basename(path);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function launchFiles(): Promise<string[]> {
  if (!isTauri) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string[]>("launch_files");
}

export async function onOpenFiles(cb: (paths: string[]) => void) {
  if (!isTauri) return;
  const { listen } = await import("@tauri-apps/api/event");
  await listen<string[]>("open-files", (e) => cb(e.payload));
}

export type DropState = "over" | "leave";

export async function onFileDrop(onState: (s: DropState) => void, onDrop: (files: FileRef[]) => void) {
  if (isTauri) {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "enter" || p.type === "over") onState("over");
      else if (p.type === "leave") onState("leave");
      else if (p.type === "drop") {
        onState("leave");
        onDrop(p.paths.map((path) => ({ name: basename(path), path })));
      }
    });
    return;
  }
  window.addEventListener("dragover", (e) => { e.preventDefault(); onState("over"); });
  window.addEventListener("dragleave", (e) => { if (!e.relatedTarget) onState("leave"); });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    onState("leave");
    const files = [...(e.dataTransfer?.files ?? [])];
    onDrop(files.map((f) => ({ name: f.name, path: null, file: f })));
  });
}

/* ----------------------------- window ----------------------------- */

async function win() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export const windowControls = {
  async minimize() { if (isTauri) (await win()).minimize(); },
  async toggleMaximize() { if (isTauri) (await win()).toggleMaximize(); },
  async close() { if (isTauri) (await win()).close(); },
  async destroy() { if (isTauri) (await win()).destroy(); },
  async setTitle(t: string) { if (isTauri) (await win()).setTitle(t); else document.title = t; },
  async isMaximized() { return isTauri ? (await win()).isMaximized() : false; },
  async onResized(cb: () => void) { if (isTauri) (await win()).onResized(cb); },
  /** Paint behind the page too, so resizing never flashes black at the edges. */
  async setBackground(hex: string) {
    if (!isTauri) return;
    try {
      (await win()).setBackgroundColor(hex);
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      await getCurrentWebview().setBackgroundColor(hex);
    } catch (e) { console.warn(e); }
  },
  async onCloseRequested(cb: () => Promise<boolean>) {
    if (isTauri) {
      (await win()).onCloseRequested(async (e) => {
        e.preventDefault();
        if (await cb()) {
          try {
            const { saveWindowState, StateFlags } = await import("@tauri-apps/plugin-window-state");
            await saveWindowState(StateFlags.ALL);
          } catch (err) { console.warn(err); }
          (await win()).destroy();
        }
      });
    }
  },
};
