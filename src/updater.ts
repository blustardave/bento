/**
 * Auto-update: checks GitHub for a newer build shortly after launch (and
 * hourly), downloads it quietly in the background, then offers a restart.
 */
import { isTauri } from "./native";

const HOUR = 60 * 60 * 1000;

export async function appVersion(): Promise<string> {
  if (!isTauri) return "dev";
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}

export type CheckResult = "found" | "none" | "error";

export function initUpdater(onReady: (version: string, install: () => Promise<void>) => void): { checkNow(): Promise<CheckResult> } {
  let found = false;
  let running: Promise<CheckResult> | null = null;
  const run = (): Promise<CheckResult> => {
    if (!isTauri) return Promise.resolve("none");
    if (found) return Promise.resolve("found");
    if (running) return running;
    running = (async (): Promise<CheckResult> => {
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        if (!update) return "none";
        await update.download();
        found = true;
        onReady(update.version, () => update.install());
        return "found";
      } catch (e) {
        // Offline, GitHub hiccup, etc. — the hourly check will try again.
        console.warn("Update check failed", e);
        return "error";
      } finally {
        running = null;
      }
    })();
    return running;
  };
  if (isTauri) {
    setTimeout(run, 4000);
    setInterval(run, HOUR);
  }
  return { checkNow: run };
}
