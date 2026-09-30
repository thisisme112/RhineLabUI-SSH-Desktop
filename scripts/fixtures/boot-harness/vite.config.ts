import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const harnessDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(harnessDir, "../../..");

/**
 * Standalone build of the boot harness, served to headless Edge for baking.
 *
 * `root` is the harness folder so the emitted page lands flat in Build/; the
 * harness itself imports the real src/ modules and stylesheet by relative path.
 */
export default defineConfig({
  root: harnessDir,
  publicDir: path.resolve(root, "public"),
  base: "./",
  define: { __RHINE_MODELS__: "{}", __RHINE_NOVECENTO__: "false" },
  build: {
    outDir: path.resolve(root, ".artifacts/boot-harness"),
    emptyOutDir: true,
  },
});
