/**
 * AutoSave and crash recovery.
 *
 * - A .bento file that already lives on disk saves itself a couple of
 *   seconds after you stop changing it (or every 30 s during long bursts),
 *   like Google Sheets. Can be turned off in Preferences.
 * - Anything else with unsaved changes — untitled sheets, CSVs (which are
 *   never overwritten automatically), or .bento files with AutoSave off —
 *   gets a recovery copy in Bento's own folder instead.
 * - Recovery copies are deleted when a file is saved or deliberately closed
 *   without saving. So any left behind at launch mean Bento didn't shut down
 *   properly, and they're offered back.
 */
import { isBentoPath } from "./bento";
import { Book } from "./doc";
import { isTauri, listRecovery, readFile, recoveryDir, removeFile, writeFile } from "./native";

const QUIET_MS = 2000;
const MAX_WAIT_MS = 30000;
const TICK_MS = 1000;

export interface RecoveredFile {
  id: string;
  name: string;
  path: string | null;
  savedAt: number;
  bytes: Uint8Array;
}

interface Meta { id: string; name: string; path: string | null; savedAt: number }

interface Track { token: string; changedAt: number; firstDirtyAt: number; handled: string; snap?: boolean }

export function autoSaveEnabled(): boolean {
  return localStorage.getItem("bento.autosave") !== "off";
}

export class AutoSaver {
  private dir: string | null = null;
  private track = new Map<string, Track>();
  private busy = false;

  constructor(
    private books: () => Book[],
    private encode: (b: Book) => Promise<Uint8Array>,
    /** Save a .bento in place, quietly. Returns false if it couldn't. */
    private saveInPlace: (b: Book) => Promise<boolean>,
  ) {}

  async start() {
    if (!isTauri) return;
    try { this.dir = await recoveryDir(); } catch { this.dir = null; }
    setInterval(() => this.tick(), TICK_MS);
  }

  /** Should this file save itself? */
  canAutoSave(b: Book): boolean {
    return isTauri && autoSaveEnabled() && isBentoPath(b.path);
  }

  private async tick() {
    if (this.busy) return;
    const now = Date.now();
    for (const b of this.books()) {
      if (b.sheets.some((s) => s.loading !== null)) continue;
      const token = b.token;
      let t = this.track.get(b.id);
      if (!t) { t = { token, changedAt: now, firstDirtyAt: now, handled: b.dirty ? "" : token }; this.track.set(b.id, t); }
      if (token !== t.token) {
        if (t.handled === t.token) t.firstDirtyAt = now; // a fresh burst of changes
        t.token = token;
        t.changedAt = now;
      }
      // Back to the saved state (e.g. undone): any recovery copy is now stale.
      if (!b.dirty && t.snap) { t.snap = false; await this.discard(b.id); this.track.set(b.id, { ...t, snap: false }); continue; }
      if (!b.dirty || t.handled === token) continue;
      const quiet = now - t.changedAt >= QUIET_MS;
      const overdue = now - t.firstDirtyAt >= MAX_WAIT_MS;
      if (!quiet && !overdue) continue;
      // Huge sheets take a moment to write (and the page pauses while the
      // file is put together), so they're saved — in place or as a recovery
      // copy — at most every 30 s rather than on every pause.
      const big = b.sheets.reduce((n, s) => n + s.rows.length, 0) > 200_000;
      if (big && !overdue) continue;
      this.busy = true;
      try {
        if (this.canAutoSave(b) && await this.saveInPlace(b)) {
          await this.discard(b.id);
          this.track.set(b.id, t);
        } else {
          // Not auto-saveable, or the save didn't work: keep a recovery copy.
          await this.snapshot(b);
          t.snap = true;
        }
        t.handled = token;
        t.firstDirtyAt = now;
      } catch (e) {
        console.warn("AutoSave failed", e);
      } finally {
        this.busy = false;
      }
    }
  }

  /** Write (or refresh) a recovery copy of a file. */
  async snapshot(b: Book) {
    if (!this.dir) return;
    const sep = this.dir.includes("\\") ? "\\" : "/";
    const meta: Meta = { id: b.id, name: b.name, path: b.path, savedAt: Date.now() };
    await writeFile(`${this.dir}${sep}${b.id}.bento`, await this.encode(b));
    await writeFile(`${this.dir}${sep}${b.id}.json`, new TextEncoder().encode(JSON.stringify(meta)));
  }

  /** Forget a file's recovery copy (it was saved, or closed on purpose). */
  async discard(id: string) {
    const t = this.track.get(id);
    if (t) t.snap = false;
    if (!this.dir) return;
    const sep = this.dir.includes("\\") ? "\\" : "/";
    await removeFile(`${this.dir}${sep}${id}.bento`).catch(() => {});
    await removeFile(`${this.dir}${sep}${id}.json`).catch(() => {});
  }

  /** Mark a file as handled right now (e.g. just saved by hand). */
  settled(b: Book) {
    this.track.set(b.id, { token: b.token, changedAt: Date.now(), firstDirtyAt: Date.now(), handled: b.token });
  }

  /** Recovery copies left behind by a crash. */
  async leftovers(): Promise<RecoveredFile[]> {
    if (!this.dir) { try { this.dir = await recoveryDir(); } catch { return []; } }
    if (!this.dir) return [];
    const sep = this.dir.includes("\\") ? "\\" : "/";
    let names: string[] = [];
    try { names = await listRecovery(); } catch { return []; }
    const out: RecoveredFile[] = [];
    for (const n of names.filter((x) => x.endsWith(".json"))) {
      try {
        const meta: Meta = JSON.parse(new TextDecoder().decode(await readFile({ name: n, path: `${this.dir}${sep}${n}` })));
        const bytes = await readFile({ name: `${meta.id}.bento`, path: `${this.dir}${sep}${meta.id}.bento` });
        out.push({ ...meta, bytes });
      } catch { /* half-written copy: skip */ }
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  }
}
