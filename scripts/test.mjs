// Bundles each tests/*.test.ts with esbuild and runs it with Node.
import { build } from "esbuild";
import { readdirSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const only = process.argv[2];
const files = readdirSync("tests").filter((f) => f.endsWith(".test.ts") && (!only || f.includes(only))).sort();
mkdirSync("node_modules/.cache", { recursive: true });
let failed = 0;
for (const f of files) {
  const out = `node_modules/.cache/${f.replace(/\.ts$/, ".cjs")}`;
  await build({ entryPoints: [`tests/${f}`], bundle: true, platform: "node", outfile: out, logLevel: "warning", external: ["jsdom"] });
  const r = spawnSync(process.execPath, ["--max-old-space-size=4096", "--stack-size=984", out], { stdio: "inherit" });
  if (r.status !== 0) { failed++; console.log(`✗ ${f}`); }
}
if (failed) { console.log(`${failed} test file(s) failed`); process.exit(1); }
