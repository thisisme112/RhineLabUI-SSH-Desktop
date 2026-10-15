/**
 * The two maids' pictures for the web build: the Unreal repository's Content/Data/claude and deepseek PNGs (cut-outs,
 * poses, the bust and its face patches, the fin), as WebP in public/maid/<who>/.
 *
 *   node scripts/build/build-maid-art.mjs --from <RhineLab-Unreal>/Unreal/Content/Data
 *
 * A fifth of the PNGs' size (29 MB → about 5 MB) and indistinguishable at twice the size: quality 92, and 95 for the
 * bust and the face patches laid over it, so no seam shows where a patch meets the bust.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const index = process.argv.indexOf("--from");
if (index < 0) throw new Error("--from <RhineLab-Unreal>/Unreal/Content/Data is required");
const from = path.resolve(process.argv[index + 1]);
let total = 0;
for (const who of ["claude", "deepseek"]) {
  const source = path.join(from, who), target = path.join(root, "public/maid", who);
  if (!fs.existsSync(source)) throw new Error("missing " + source);
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(source).filter(n => n.endsWith(".png"))) {
    const out = path.join(target, name.replace(/\.png$/, ".webp"));
    const quality = name === "bust.png" || name.startsWith("face-") ? "95" : "92";
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", path.join(source, name), "-c:v", "libwebp", "-quality", quality, "-compression_level", "6", out]);
    total += fs.statSync(out).size;
  }
}
console.log(`maid art: ${(total / 1048576).toFixed(1)} MB in public/maid`);
