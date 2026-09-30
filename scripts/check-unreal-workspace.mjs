/**
 * The Unreal session workspace (文件 / 监控) against real OpenSSH, the desktop's
 * native bridge and the isolated Go SSH/SFTP fixture (services/ssh/cmd/fixture).
 *
 *   node scripts/check-unreal-workspace.mjs [--stage <dir>]
 *
 * The app connects with the fixture's key profile, opens the SFTP browser,
 * creates a folder, uploads, downloads, renames and deletes, then streams the
 * monitor, then does it again behind a saved jump host (the fixture is both).
 * Reports land in verification/unreal-prototype/workspace/.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ensureServices, goExecutable } from "./build-ssh-services.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = path.join(root, "prototypes", "unreal");
const builtExe = path.join(project, "Binaries", "Win64", "RhineLabViewer.exe");
const stageIndex = process.argv.indexOf("--stage");
const staged = path.resolve(root, stageIndex >= 0 ? process.argv[stageIndex + 1] : process.env.RHINE_UNREAL_STAGE ?? "release/RhineLab-Unreal-Verify/Windows/RhineLabViewer");
const stagedExe = path.join(staged, "Binaries", "Win64", "RhineLabViewer.exe");
const saved = path.join(staged, "Saved");
const outDir = path.join(root, "verification", "unreal-prototype", "workspace");
const run = promisify(execFile);
const sha = buffer => createHash("sha256").update(buffer).digest("hex");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
mkdirSync(outDir, { recursive: true });

// Stage the fresh binary and the bridge resources beside it.
for (let attempt = 0; ; ++attempt) {
  try { copyFileSync(builtExe, stagedExe); break; }
  catch (error) { if (error.code !== "EBUSY" || attempt >= 20) throw error; await sleep(500); }
}
cpSync(path.join(project, "Binaries", "Win64", "ssh-services"), path.join(staged, "Binaries", "Win64", "ssh-services"), { recursive: true });
console.log("ok    staged binary and ssh-services into " + staged);

await ensureServices();
await fs.mkdir(path.join(root, ".tools/ssh-fixtures"), { recursive: true });
const directory = await fs.mkdtemp(path.join(root, ".tools/ssh-fixtures/unreal-"));
if (process.platform === "win32") {
  // OpenSSH refuses a private key others can read (check-ssh-services.mjs does the same).
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], { windowsHide: true });
  await run("icacls.exe", [directory, "/inheritance:r", "/grant:r", "*" + stdout.trim() + ":(OI)(CI)F"], { windowsHide: true });
}
const fixtureExe = path.join(directory, "fixture.exe");
await run(await goExecutable(), ["build", "-trimpath", "-buildvcs=false", "-o", fixtureExe, "./cmd/fixture"],
  { cwd: path.join(root, "services/ssh"), windowsHide: true, env: { ...process.env, GOTOOLCHAIN: "local", CGO_ENABLED: "0" } });

const fixture = spawn(fixtureExe, ["--directory", directory, "--port", "0"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
let ready, buffer = "", diagnostic = "", counter = 0;
const pending = new Map(), authenticated = [];
fixture.stderr.on("data", chunk => { diagnostic += chunk; });
fixture.stdout.setEncoding("utf8");
fixture.stdout.on("data", chunk => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n"), message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
    else if (message.event === "ready") ready = message;
    else if (message.event === "authenticated") authenticated.push(message.user);
  }
});
const control = (method, params = {}) => new Promise((resolve, reject) => {
  const id = String(++counter);
  const timer = setTimeout(() => { pending.delete(id); reject(new Error("fixture control timeout: " + method)); }, 10000);
  pending.set(id, response => { clearTimeout(timer); response.ok ? resolve(response.result) : reject(new Error(response.error)); });
  fixture.stdin.write(JSON.stringify({ id, method, ...params }) + "\n");
});
for (let waited = 0; !ready; waited += 50) {
  if (fixture.exitCode != null || waited > 20000) throw new Error("fixture did not start: " + diagnostic);
  await sleep(50);
}
console.log(`ok    fixture listening on 127.0.0.1:${ready.port} (${ready.fingerprint})`);

const quote = value => '"' + value.replaceAll("\\", "/") + '"';
const config = path.join(directory, "config"), known = path.join(directory, "known_hosts");
writeFileSync(known, `[127.0.0.1]:${ready.port} ${ready.hostKey}\n[localhost]:${ready.port} ${ready.hostKey}\n`);
writeFileSync(config, `Host *\n UserKnownHostsFile ${quote(known)}\n GlobalKnownHostsFile none\n StrictHostKeyChecking yes\n IdentityAgent none\n ControlMaster no\n ControlPath none\n ConnectTimeout 5\n ServerAliveInterval 1\n ServerAliveCountMax 2\n`);
const upload = path.join(directory, "payload-" + randomBytes(3).toString("hex") + ".bin"), payload = randomBytes(384 * 1024);
writeFileSync(upload, payload);
const downloads = path.join(directory, "downloads");
mkdirSync(downloads);
const setup = path.join(directory, "probe.json");
const fxOnly = process.argv.includes("--fx");
writeFileSync(setup, JSON.stringify({ port: ready.port, identity: ready.identity, fingerprint: ready.fingerprint, upload, downloads, ...(fxOnly ? { fx: true } : {}) }));
const vault = path.join(directory, "credential-vault.json");

const reportFile = path.join(saved, "workspace-probe.json");
rmSync(reportFile, { force: true });
const started = Date.now();
const app = spawnSync("cmd.exe", ["/c", "start", "/wait", "", stagedExe, "-workspace-probe", "-windowed", "-ResX=1707", "-ResY=1067", "-dpr=1", "-nosound"], {
  cwd: path.dirname(stagedExe), timeout: 240000, encoding: "utf8",
  env: { ...process.env, RHINE_SSH_CONFIG: config, RHINE_WORKSPACE_PROBE: setup, RHINE_CREDENTIAL_VAULT: vault },
});
const seconds = ((Date.now() - started) / 1000).toFixed(1);
let failure;
try {
  assert.equal(app.status, 0, "app exit " + app.status);
  assert(existsSync(reportFile), "no workspace-probe.json");
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  writeFileSync(path.join(outDir, "workspace-probe.json"), JSON.stringify(report, null, 2) + "\n");
  for (const name of report.checks) console.log("ok    " + name);
  for (const name of report.failed) console.log("FAIL  " + name);
  assert(report.passed, "probe failures: " + report.failed.join("; "));
  if (fxOnly) {
    // Theme entrances only: collect the gallery and stop.
    const shots = path.join(saved, "Screenshots", "Windows");
    for (const name of (await fs.readdir(shots)).filter(name => name.startsWith("fx-") && statSync(path.join(shots, name)).mtimeMs >= started))
      copyFileSync(path.join(shots, name), path.join(outDir, name));
    console.log(`ok    theme entrances photographed into ${path.relative(root, outDir)}`);
    throw Object.assign(new Error("fx-done"), { fxDone: true });
  }
  // The fixture's own store: the folder is there and the file really left it.
  const listing = await control("list", { Path: report.folder });
  assert.equal(JSON.stringify(listing), "[]", "fixture folder is empty after delete: " + JSON.stringify(listing));
  console.log("ok    the fixture store shows the folder and no leftover file");
  const downloaded = path.join(downloads, path.basename(upload));
  assert.equal(sha(readFileSync(downloaded)), sha(payload), "downloaded bytes match");
  console.log("ok    the downloaded file hashes the same as the upload (" + payload.length + " bytes)");
  assert(authenticated.filter(user => user === "key").length >= 3, "terminal + sftp + monitor each authenticated: " + authenticated.join(","));
  console.log(`ok    ${authenticated.length} authenticated connections (terminal, files, monitor)`);
  const shots = path.join(saved, "Screenshots", "Windows");
  const sealed = readFileSync(vault, "utf8");
  assert(!sealed.includes("fixture-password") && !sealed.includes("stale-password"), "vault holds no plain secret");
  console.log("ok    the vault file on disk holds only DPAPI-sealed values");
  for (const name of ["ws-01-files.png", "ws-02-upload.png", "ws-03-confirm-delete.png", "ws-04-monitor.png", "ws-05-password-services.png",
    ...["paper", "night", "hazard", "clinic", "orbit", "print"].map(theme => `ws-theme-${theme}.png`)]) {
    const file = path.join(shots, name);
    assert(existsSync(file) && statSync(file).mtimeMs >= started, "fresh screenshot " + name);
    copyFileSync(file, path.join(outDir, name));
  }
  console.log(`ok    screenshots copied to ${path.relative(root, outDir)} (${seconds}s)`);
} catch (error) {
  if (!error.fxDone) failure = error;
  const log = path.join(saved, "Logs", "RhineLabViewer.log");
  if (existsSync(log)) copyFileSync(log, path.join(outDir, "RhineLabViewer.log"));
} finally {
  fixture.stdin.end(JSON.stringify({ id: "stop", method: "stop" }) + "\n");
  await sleep(300);
  fixture.kill();
}
if (failure) { console.error("FAIL  " + failure.message); process.exit(1); }
console.log("PASS  unreal workspace");
