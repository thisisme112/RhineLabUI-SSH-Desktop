/**
 * Place the Android SSH agent into the app's native library directories.
 *
 *   npm run build:android-native
 *
 * A sandboxed Android app may not execute a binary it wrote into its own data
 * directory, but it may execute one the installer put in the app's native
 * library directory. So the agent ships as `librhine-session.so` under the
 * matching ABI folder and is spawned from `nativeLibraryDir`.
 *
 * For Gradle to actually extract those files to disk — which is what makes them
 * executable — the app must be packaged with legacy JNI packaging; see
 * `useLegacyPackaging` in android/app/build.gradle. With AGP's default the
 * libraries stay inside the APK and are mapped, never materialised, and there
 * would be nothing on disk to run.
 *
 * The checksums are verified here, at build time. On the desktop the equivalent
 * check runs at load because the binaries sit in a writable directory; here the
 * APK signature is what protects them in transit, so the meaningful moment to
 * catch a stale or wrong-architecture file is before it is packaged.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ensureServices } from "./build-ssh-services.mjs";

await ensureServices();

const root = process.cwd();
const resources = path.join(root, "electron/resources/ssh-services");
const manifestPath = path.join(resources, "manifest.json");
if (!fs.existsSync(manifestPath)) {
  console.error("No SSH resources. Run `npm run build:ssh-services` first.");
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

/** Go's linux targets to the ABI folder Android looks in. */
const ABI = {
  arm64: "arm64-v8a",
  armv7: "armeabi-v7a",
  amd64: "x86_64",
};

const jniLibs = path.join(root, "android/app/src/main/jniLibs");
let placed = 0;
for (const [abi, folder] of Object.entries(ABI)) {
  const entry = manifest.files?.[`session/android/${abi}`];
  if (!entry) {
    console.error(`manifest has no session/android/${abi}`);
    process.exit(1);
  }
  if (path.basename(entry.name) !== entry.name || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
    console.error(`manifest entry for ${abi} is malformed`);
    process.exit(1);
  }
  const source = path.join(resources, entry.name);
  const digest = createHash("sha256").update(fs.readFileSync(source)).digest("hex");
  if (digest !== entry.sha256) {
    console.error(`${entry.name} does not match its recorded sha256 — rebuild the services`);
    process.exit(1);
  }
  const target = path.join(jniLibs, folder, "librhine-session.so");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  console.log(
    `jniLibs/${folder}/librhine-session.so  ${(entry.size / 1048576).toFixed(2)} MiB  ${digest.slice(0, 12)}…`,
  );
  placed++;
}
console.log(`\n${placed} architectures placed under android/app/src/main/jniLibs`);
const androidAssets = path.join(root, "android/app/src/main/assets/ssh-services");
fs.mkdirSync(androidAssets, { recursive: true });
for (const arch of ["amd64", "arm64"]) {
  const entry = manifest.files[`monitor/linux/${arch}`];
  const bytes = fs.readFileSync(path.join(resources, entry.name));
  if (path.basename(entry.name) !== entry.name || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error("Monitor checksum mismatch");
  fs.writeFileSync(path.join(androidAssets, entry.name), bytes);
}
fs.copyFileSync(manifestPath, path.join(androidAssets, "manifest.json"));
fs.copyFileSync(path.join(resources, "THIRD_PARTY_NOTICES.txt"), path.join(androidAssets, "THIRD_PARTY_NOTICES.txt"));
