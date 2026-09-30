import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { ensureServices, goExecutable, resourceDir } from "../build/build-ssh-services.mjs";
import { sha256, writeZip } from "../lib/shared-package.mjs";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
if (execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()) throw new Error("Commit the source changes before exporting a shared package");
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const version = arg("--version", JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version + "-shared.1");
if (!/^[a-zA-Z0-9.-]+$/.test(version)) throw new Error("Invalid shared version");
await ensureServices();
const staging = path.join(root, ".artifacts/shared-sources"); fs.mkdirSync(staging, { recursive: true });
for (const [script, output] of [["export-boot-tracks.mjs", "generated/SharedRhineBootTracksData.h"], ["export-deck-tracks.mjs", "generated/SharedRhineDeckTracksData.h"], ["export-unreal-fonts.mjs", "fonts/MiSans"]]) {
  const target = path.join(staging, output); fs.mkdirSync(path.dirname(target), { recursive: true });
  execFileSync(process.execPath, [path.join(root, "scripts/export", script), "--out", target], { cwd: root, stdio: "inherit", windowsHide: true });
}
const files = new Map();
const add = (name, source) => files.set(name, fs.readFileSync(source));
const tree = (directory, prefix) => { for (const e of fs.readdirSync(directory, { withFileTypes: true })) { const source = path.join(directory, e.name), name = `${prefix}/${e.name}`; if (e.isDirectory()) tree(source, name); else if (e.isFile()) add(name, source); else throw new Error(`Unsupported shared file: ${source}`); } };
tree(resourceDir, "ssh-services"); tree(path.join(staging, "generated"), "generated"); tree(path.join(staging, "fonts"), "fonts");
for (const source of ["features/boot/boot-motion", "features/boot/boot-tracks", "features/boot/boot-orbit-tracks", "features/boot/boot-logo-tracks", "features/ssh/deck-motion"]) {
  const original = fs.readFileSync(path.join(root, "src", source + ".ts"), "utf8");
  const compiled = ts.transpileModule(original, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/(from\s+["']\.\/[^"']+)\.ts(["'])/g, "$1.mjs$2");
  files.set(`references/${path.basename(source)}.mjs`, Buffer.from(compiled));
}
const fixtureExe = path.join(staging, "rhine-fixture-windows-amd64.exe");
execFileSync(await goExecutable(), ["build", "-trimpath", "-buildvcs=false", "-o", fixtureExe, "./cmd/fixture"], { cwd: path.join(root, "services/ssh"), env: { ...process.env, GOTOOLCHAIN: "local", CGO_ENABLED: "0", GOOS: "windows", GOARCH: "amd64" }, windowsHide: true, stdio: "inherit" });
add("testing/rhine-fixture-windows-amd64.exe", fixtureExe);
const { fixture, reference } = await import("../fixtures/unreal-ssh-events.mjs");
files.set("testing/unreal-ssh-events.json", Buffer.from(JSON.stringify({ fixture, reference: reference() }) + "\n"));
for (const name of ["archive-assembly", "archive-cassette"]) add(`models/${name}.glb`, path.join(root, "public/assets", name + ".glb"));
add("models/ssh-terminal.glb", path.join(root, "src/features/ssh/assets/ssh-terminal.glb"));
tree(path.join(root, "art/exports/unreal-brand"), "brand");
for (const [abi, architecture] of [["arm64-v8a", "arm64"], ["armeabi-v7a", "armv7"], ["x86_64", "amd64"]]) add(`android/${abi}/librhine-session.so`, path.join(resourceDir, `rhine-session-android-${architecture}.so`));
add("licenses/project.txt", path.join(root, "LICENSE")); tree(path.join(root, "public/licenses"), "licenses/assets");
add("licenses/jetbrains-mono.txt", path.join(root, "node_modules/@fontsource/jetbrains-mono/LICENSE"));
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const manifest = { schemaVersion: 1, version, sourceCommit, protocol: 1, files: Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => [name, { size: bytes.length, sha256: sha256(bytes) }])) };
files.set("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
const out = path.resolve(root, arg("--out", `.artifacts/shared/${version}`)); fs.mkdirSync(out, { recursive: true });
const archive = `rhine-shared-${version}.zip`, bytes = writeZip(files); fs.writeFileSync(path.join(out, archive), bytes);
fs.writeFileSync(path.join(out, "shared.lock.json"), JSON.stringify({ schemaVersion: 1, version, sourceCommit, protocol: 1, archive, sha256: sha256(bytes), manifestSha256: sha256(files.get("manifest.json")) }, null, 2) + "\n");
console.log(`Shared package: ${path.join(out, archive)} (${files.size} files)`);
