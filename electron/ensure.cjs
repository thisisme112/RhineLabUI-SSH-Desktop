/**
 * Electron 44 ships `install.js` but declares no `postinstall` hook, so `npm ci`
 * alone leaves the runtime binary missing and the first launch fails with the
 * unhelpful "Electron failed to install correctly". Fetch it on demand instead.
 */
const { existsSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const electronDir = path.join(__dirname, "..", "node_modules", "electron");
if (!existsSync(electronDir)) {
  console.error("[desktop] electron is not installed. Run: npm install");
  process.exit(1);
}
if (existsSync(path.join(electronDir, "path.txt"))) process.exit(0);

console.log("[desktop] Electron runtime missing; downloading it once…");
const result = spawnSync(
  process.execPath,
  [path.join(electronDir, "install.js")],
  {
    cwd: electronDir,
    stdio: "inherit",
  },
);
if (result.status !== 0 || !existsSync(path.join(electronDir, "path.txt"))) {
  console.error("[desktop] Electron runtime download failed.");
  process.exit(1);
}
