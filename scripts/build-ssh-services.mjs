import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "services/ssh");
const config = JSON.parse(
  fs.readFileSync(path.join(source, "toolchain.json"), "utf8"),
);
const tools = path.join(root, ".tools/ssh-toolchain", config.version);
export const resourceDir = path.join(root, "electron/resources/ssh-services");
const hash = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function sourceDigest() {
  const digest = createHash("sha256");
  const walk = (directory) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".go") && !entry.name.endsWith("_test.go"))
        digest
          .update(path.relative(source, file).replaceAll("\\", "/"))
          .update(fs.readFileSync(file));
    }
  };
  for (const directory of ["internal", "cmd/bridge", "cmd/monitor", "cmd/session"])
    walk(path.join(source, directory));
  for (const file of [
    "go.mod",
    "go.sum",
    "toolchain.json",
    "THIRD_PARTY_NOTICES.txt",
  ])
    digest.update(fs.readFileSync(path.join(source, file)));
  digest.update(fs.readFileSync(fileURLToPath(import.meta.url)));
  return digest.digest("hex");
}

function currentResources() {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(resourceDir, "manifest.json"), "utf8"),
    );
    const os = process.platform === "win32" ? "windows" : process.platform;
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    return (
      manifest.sourceDigest === sourceDigest() &&
      manifest.protocol === config.protocol &&
      manifest.notices?.sha256 ===
        hash(path.join(resourceDir, "THIRD_PARTY_NOTICES.txt")) &&
      [
        "bridge/" + os + "/" + arch,
        "monitor/linux/amd64",
        "monitor/linux/arm64",
        // Listed so that a resource directory built before the Android agent
        // existed is rebuilt rather than quietly kept.
        "session/android/arm64",
        "session/android/armv7",
        "session/android/amd64",
      ].every((key) => {
        const entry = manifest.files?.[key];
        return (
          entry &&
          path.basename(entry.name) === entry.name &&
          hash(path.join(resourceDir, entry.name)) === entry.sha256
        );
      })
    );
  } catch {
    return false;
  }
}

function run(file, args, env = {}) {
  const result = spawnSync(file, args, {
    cwd: source,
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, GOTOOLCHAIN: "local", CGO_ENABLED: "0", ...env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(file + " exited with " + result.status);
}

export async function goExecutable() {
  const local = path.join(tools, "go/bin/go.exe");
  if (process.platform !== "win32") return process.env.RHINE_GO || "go";
  if (fs.existsSync(local)) return local;
  fs.mkdirSync(tools, { recursive: true });
  const archive = path.join(tools, config.windowsAmd64.filename);
  if (!fs.existsSync(archive) || hash(archive) !== config.windowsAmd64.sha256) {
    console.log("[ssh] Downloading the pinned Go toolchain into .tools");
    const response = await fetch(
      "https://go.dev/dl/" + config.windowsAmd64.filename,
    );
    if (!response.ok || !response.body)
      throw new Error("Go download failed: " + response.status);
    await pipeline(
      Readable.fromWeb(response.body),
      fs.createWriteStream(archive),
    );
    if (hash(archive) !== config.windowsAmd64.sha256)
      throw new Error("Go toolchain SHA-256 mismatch");
  }
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Expand-Archive -LiteralPath " +
      quote(archive) +
      " -DestinationPath " +
      quote(tools) +
      " -Force",
  ]);
  return local;
}

export async function buildServices() {
  const go = await goExecutable();
  const check = spawnSync(go, ["version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (!check.stdout?.includes(config.version + " "))
    throw new Error("Expected " + config.version);
  fs.mkdirSync(resourceDir, { recursive: true });
  const manifest = {
    protocol: config.protocol,
    version: config.agentVersion,
    toolchain: config.version,
    sourceDigest: sourceDigest(),
    files: {},
  };
  /**
   * Android gets the SSH session agent as well as the collectors.
   *
   * A sandboxed Android app may not execute a binary it wrote into its own
   * data directory, but it may execute one the installer placed in the app's
   * native library directory. So each agent is shipped as a `lib*.so` in the
   * matching ABI folder and spawned from `nativeLibraryDir` — the technique
   * Termux uses, and the reason these are built for linux/arm64, linux/arm and
   * linux/amd64 rather than GOOS=android (which would require cgo).
   *
   * The names are distinct here because the manifest keys files by basename;
   * the Android packaging step renames each to `librhine-session.so` inside its
   * own ABI directory.
   */
  const android = [
    ["arm64", "arm64", ""],
    ["armv7", "arm", "7"],
    ["amd64", "amd64", ""],
  ];
  for (const [abi, goarch, goarm] of android) {
    const name = `rhine-session-android-${abi}.so`;
    const output = path.join(resourceDir, name);
    run(
      go,
      [
        "build",
        "-trimpath",
        "-buildvcs=false",
        "-ldflags=-s -w",
        "-o",
        output,
        "./cmd/session",
      ],
      { GOOS: "linux", GOARCH: goarch, ...(goarm ? { GOARM: goarm } : {}) },
    );
    manifest.files["session/android/" + abi] = {
      name,
      sha256: hash(output),
      size: fs.statSync(output).size,
    };
  }

  const targets = [
    [
      process.platform === "win32"
        ? "windows"
        : process.platform === "darwin"
          ? "darwin"
          : "linux",
      process.arch === "arm64" ? "arm64" : "amd64",
      "bridge",
    ],
    ["linux", "amd64", "monitor"],
    ["linux", "arm64", "monitor"],
  ];
  for (const [os, arch, command] of targets) {
    const name =
      "rhine-" +
      command +
      "-" +
      os +
      "-" +
      arch +
      (os === "windows" ? ".exe" : "");
    const output = path.join(resourceDir, name);
    run(
      go,
      [
        "build",
        "-trimpath",
        "-buildvcs=false",
        "-ldflags=-s -w",
        "-o",
        output,
        "./cmd/" + command,
      ],
      { GOOS: os, GOARCH: arch },
    );
    manifest.files[command + "/" + os + "/" + arch] = {
      name,
      sha256: hash(output),
      size: fs.statSync(output).size,
    };
  }
  fs.copyFileSync(
    path.join(source, "THIRD_PARTY_NOTICES.txt"),
    path.join(resourceDir, "THIRD_PARTY_NOTICES.txt"),
  );
  manifest.notices = {
    name: "THIRD_PARTY_NOTICES.txt",
    sha256: hash(path.join(resourceDir, "THIRD_PARTY_NOTICES.txt")),
  };
  fs.writeFileSync(
    path.join(resourceDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(
    "[ssh] Desktop bridge and Linux collectors built and checksummed",
  );
}

export async function ensureServices() {
  if (currentResources()) {
    console.log("[ssh] Desktop services verified");
    return;
  }
  await buildServices();
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.includes("--toolchain-only"))
    console.log(await goExecutable());
  else if (process.argv.includes("--ensure")) await ensureServices();
  else await buildServices();
}
