/**
 * Build the Android app.
 *
 *   npm run android:build     # debug APK
 *   npm run android:sync      # web build + cap sync only
 *
 * Gradle needs a JDK and an Android SDK. Neither is installed system-wide on
 * this machine, but a complete working pair exists (see `TOOLCHAIN_CANDIDATES`)
 * and has already produced a signed APK for another project here. They are
 * located at run time and exported into *this process only* — nothing global is
 * changed — and `local.properties` is written for Gradle with the same value.
 *
 * Everything lives under a temp directory, so it can vanish without warning.
 * Pass `ANDROID_HOME` / `JAVA_HOME` yourself, or install Android Studio, to use
 * a durable toolchain instead; those always win over the search below.
 */
import { existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const androidDir = path.join(root, "android");

if (!existsSync(androidDir)) {
  console.error("No android/ project. Run `npm run android:add` first.");
  process.exit(1);
}

const temp = process.env.TEMP || process.env.TMP || "";
const TOOLCHAIN_CANDIDATES = {
  JAVA_HOME: [
    process.env.JAVA_HOME,
    path.join(temp, "opencode", "apktools", "jdk", "jdk-17.0.20.1+1"),
    "C:/Program Files/Android/Android Studio/jbr",
    "C:/Program Files/Eclipse Adoptium",
  ],
  ANDROID_HOME: [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(temp, "opencode", "apktools", "sdk"),
    "C:/Android/Sdk",
  ],
};

const resolved = {};
for (const [name, candidates] of Object.entries(TOOLCHAIN_CANDIDATES)) {
  const found = candidates.find(
    (candidate) => candidate && existsSync(candidate),
  );
  if (!found) {
    console.error(
      `[android] ${name} not found. Install a JDK 17 and the Android SDK, or set ${name}.`,
    );
    process.exit(1);
  }
  // JAVA_HOME must point at the JDK root, not a nested jre.
  resolved[name] = found.replaceAll("\\", "/");
  console.log(`[android] ${name} = ${resolved[name]}`);
  if (!found.startsWith(temp) && !process.env[name]) {
    console.log(`[android]   (system install, not the temp toolchain)`);
  }
}

// Gradle reads sdk.dir from here; it is a generated file and is gitignored.
writeFileSync(
  path.join(androidDir, "local.properties"),
  `sdk.dir=${resolved.ANDROID_HOME}\n`,
);

const task = process.argv.includes("--sync-only")
  ? null
  : process.argv.includes("--release")
    ? "assembleRelease"
    : "assembleDebug";

if (!task) {
  console.log("[android] --sync-only: toolchain resolved, nothing built.");
  process.exit(0);
}

const gradlew = path.join(
  androidDir,
  process.platform === "win32" ? "gradlew.bat" : "gradlew",
);
// `gradlew.bat` is a batch file, which Node cannot spawn directly any more
// (EINVAL, Node 24). `shell` hands it to cmd.exe. Neither the path nor the
// arguments contain spaces, so there is nothing for the shell to mis-split.
const result = spawnSync(gradlew, [task, "--no-daemon"], {
  cwd: androidDir,
  stdio: "inherit",
  windowsHide: true,
  shell: process.platform === "win32",
  env: { ...process.env, ...resolved },
});
if (result.error) throw result.error;
if (result.status !== 0) {
  console.error(`[android] gradle exited with ${result.status}`);
  process.exit(result.status ?? 1);
}

const apk = path.join(
  androidDir,
  "app",
  "build",
  "outputs",
  "apk",
  task === "assembleRelease" ? "release" : "debug",
  `app-${task === "assembleRelease" ? "release" : "debug"}.apk`,
);
console.log(`[android] ${existsSync(apk) ? "built" : "expected"}: ${apk}`);
