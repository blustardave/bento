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

export function initUpdater(onReady: (version: string, install: () => Promise<void>) => void) {
  if (!isTauri) return;
  let found = false;
  const run = async () => {
    if (found) return;
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) return;
      await update.download();
      found = true;
      onReady(update.version, () => update.install());
    } catch (e) {
      // Offline, GitHub hiccup, etc. — just try again later.
      console.warn("Update check failed", e);
    }
  };
  setTimeout(run, 4000);
  setInterval(run, HOUR);
}
