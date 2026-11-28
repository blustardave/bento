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

/**
 * The file dialogs run in the Rust side: a path only becomes readable or
 * writable once the user has picked it there (see src-tauri/src/access.rs).
 */
export async function pickFiles(): Promise<FileRef[]> {
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    const list = await invoke<string[]>("pick_open");
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

/** Ask where to save. Returns a path (with the right extension), or null if cancelled. */
export async function pickSavePath(suggested: string, kind: "bento" | "csv"): Promise<string | null> {
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke<string | null>("pick_save", { suggested, kind })) ?? null;
  }
  if (kind === "bento" && !/\.bento$/i.test(suggested)) return suggested + ".bento";
  if (kind === "csv" && !/\.(csv|tsv|txt)$/i.test(suggested)) return suggested + ".csv";
  return suggested;
}

/** The Rust side refused a path the user hasn't chosen (e.g. a stale recent file). */
export function isNotAllowed(e: unknown): boolean {
  return /isn't allowed to use that file/.test(String(e instanceof Error ? e.message : e));
}

/* --------------------------- recent files --------------------------- */

const RECENT_KEY = "bento.recent";
const localRecent = (): string[] => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch { return []; } };

/** Recent files. In the app these live in the Rust side, which only lists files the user chose. */
export async function recentFiles(): Promise<string[]> {
  if (!isTauri) return localRecent();
  const { invoke } = await import("@tauri-apps/api/core");
  let list = await invoke<string[]>("recent_files");
  // First run after updating: bring the old list (kept in the page) across once.
  const old = localRecent();
  if (old.length) {
    list = await invoke<string[]>("import_recent", { paths: old });
    localStorage.removeItem(RECENT_KEY);
  }
  return list;
}

export async function noteRecent(path: string): Promise<void> {
  if (!isTauri) {
    localStorage.setItem(RECENT_KEY, JSON.stringify([path, ...localRecent().filter((p) => p.toLowerCase() !== path.toLowerCase())].slice(0, 8)));
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("note_recent", { path });
}

export async function forgetRecent(path: string): Promise<void> {
  if (!isTauri) { localStorage.setItem(RECENT_KEY, JSON.stringify(localRecent().filter((p) => p !== path))); return; }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("forget_recent", { path });
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
  /** Reveal the window (it starts hidden so it can open already in place). */
  async show() { if (isTauri) { const w = await win(); await w.show(); await w.setFocus(); } },
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
            await saveWindowState(StateFlags.SIZE | StateFlags.POSITION | StateFlags.MAXIMIZED);
          } catch (err) { console.warn(err); }
          (await win()).destroy();
        }
      });
    }
  },
};

/* ----------------------------- recovery ----------------------------- */

export async function recoveryDir(): Promise<string | null> {
  if (!isTauri) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("recovery_dir");
}

/** Names of the files in the recovery folder. */
export async function listRecovery(): Promise<string[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string[]>("list_recovery");
}

export async function removeFile(path: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("remove_file", { path });
}
