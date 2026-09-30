/**
 * Records the raw footage for the promotional video.
 *
 *   node scripts/record-promo.mjs [--unreal] [--electron] [--out release/promo/raw]
 *
 * Both apps run against the showcase SSH fixture (services/ssh/cmd/fixture
 * -showcase: named hosts, moving GPU telemetry, a shell with a prompt), never
 * against the user's own hosts, settings or credentials:
 *
 *   Unreal    -promo-tour with -saveddirsuffix=Demo (its own Saved_Demo), APPDATA
 *             and the credential vault pointed into the run directory.
 *   Electron  its own --user-data-dir and LOCALAPPDATA, driven over CDP.
 *
 * Each window is captured with ffmpeg's gfxcapture at 60 fps (NVENC, near
 * lossless) and a beats file records when each part of the tour happened.
 */
import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { goExecutable } from "./build-ssh-services.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const outDir = path.resolve(root, arg("--out") ?? "release/promo/raw");
const doUnreal = process.argv.includes("--unreal") || !process.argv.includes("--electron");
const doElectron = process.argv.includes("--electron") || !process.argv.includes("--unreal");
const ffmpeg = process.env.RHINE_FFMPEG ?? path.join(os.homedir(), "AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-full_build/bin/ffmpeg.exe");
const unrealStage = path.resolve(root, process.env.RHINE_UNREAL_STAGE ?? "release/RhineLab-Unreal-Verify/Windows/RhineLabViewer");
mkdirSync(outDir, { recursive: true });

// ── The showcase fixture ──────────────────────────────────────────────────────
const HOSTS = [
  ["atlas-a100", "atlas"], ["orion-render", "orion"], ["vela-edge", "vela"], ["lyra-archive", "lyra"], ["carina-lab", "carina"],
];
await fs.mkdir(path.join(root, ".tools/showcase"), { recursive: true });
const directory = await fs.mkdtemp(path.join(root, ".tools/showcase/run-"));
{
  // OpenSSH refuses a private key others can read.
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], { windowsHide: true });
  await run("icacls.exe", [directory, "/inheritance:r", "/grant:r", "*" + stdout.trim() + ":(OI)(CI)F"], { windowsHide: true });
}
const fixtureExe = path.join(directory, "fixture.exe");
await run(await goExecutable(), ["build", "-trimpath", "-buildvcs=false", "-o", fixtureExe, "./cmd/fixture"],
  { cwd: path.join(root, "services/ssh"), windowsHide: true, env: { ...process.env, GOTOOLCHAIN: "local", CGO_ENABLED: "0" } });
const fixture = spawn(fixtureExe, ["--directory", directory, "--port", "0", "--showcase"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
let ready, buffer = "", counter = 0;
const pending = new Map();
fixture.stdout.setEncoding("utf8");
fixture.stdout.on("data", chunk => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n"), message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
    else if (message.event === "ready") ready = message;
  }
});
const control = (method, params = {}) => new Promise((resolve, reject) => {
  const id = String(++counter);
  pending.set(id, response => response.ok ? resolve(response.result) : reject(new Error(response.error)));
  fixture.stdin.write(JSON.stringify({ id, method, ...params }) + "\n");
});
for (let waited = 0; !ready; waited += 50) {
  if (fixture.exitCode != null || waited > 20000) throw new Error("fixture did not start");
  await sleep(50);
}
// The remote home (/cache) as a working machine would have it.
for (const dir of ["checkpoints", "datasets", "datasets/imagenet-subset", "notebooks", "renders", "logs", ".config"]) await control("mkdir", { Path: "/cache/" + dir });
const seed = (file, text) => control("seed", { Path: "/cache/" + file, Data: Buffer.from(text).toString("base64") });
await seed("README.md", "# Rhine Lab compute node\n\nTraining runs live under checkpoints/, renders under renders/.\n");
await seed("train.sh", "#!/usr/bin/env bash\nset -euo pipefail\ntorchrun --nproc_per_node=4 train.py --config config.yaml\n");
await seed("config.yaml", "model: vit-large\nbatch_size: 256\nlr: 3.0e-4\nepochs: 90\nprecision: bf16\n");
await seed("metrics.csv", "epoch,loss,top1\n1,6.12,0.081\n2,4.87,0.214\n3,3.95,0.352\n");
await seed("train.py", "import torch\n\n# placeholder for the showcase\n");
await seed(".bashrc", "export PATH=$HOME/.local/bin:$PATH\n");
await seed("checkpoints/epoch-042.pt", "x".repeat(4096));
await seed("renders/frame-0001.png", "x".repeat(2048));
const quote = value => '"' + value.replaceAll("\\", "/") + '"';
const known = path.join(directory, "known_hosts"), config = path.join(directory, "config");
writeFileSync(known, `[127.0.0.1]:${ready.port} ${ready.hostKey}\n`);
writeFileSync(config, HOSTS.map(([alias, user]) => `Host ${alias}\n HostName 127.0.0.1\n User ${user}\n Port ${ready.port}\n IdentityFile ${quote(ready.identity)}\n`).join("")
  + `Host *\n IdentityFile ${quote(ready.identity)}\n IdentitiesOnly yes\n UserKnownHostsFile ${quote(known)}\n GlobalKnownHostsFile none\n StrictHostKeyChecking yes\n IdentityAgent none\n ControlMaster no\n ControlPath none\n ConnectTimeout 5\n ServerAliveInterval 5\n`);
console.log(`showcase fixture on 127.0.0.1:${ready.port}, run directory ${path.relative(root, directory)}`);

// ── Capture ──────────────────────────────────────────────────────────────────
async function windowOf(pid, timeout = 60000) {
  for (const started = Date.now(); Date.now() - started < timeout; await sleep(200)) {
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).MainWindowHandle`], { windowsHide: true }).catch(() => ({ stdout: "" }));
    const hwnd = Number(stdout.trim());
    if (hwnd) return hwnd;
  }
  throw new Error("no window for pid " + pid);
}
function capture(hwnd, file) {
  const started = Date.now();
  const recorder = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `gfxcapture=hwnd=${hwnd}:max_framerate=60:capture_cursor=1,hwdownload,format=bgra`,
    "-fps_mode", "cfr", "-r", "60", "-c:v", "h264_nvenc", "-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", "14", "-b:v", "0",
    "-pix_fmt", "yuv420p", file], { stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
  // gfxcapture ends by itself when the window closes, so stop() may come after the exit.
  const exited = new Promise(resolve => recorder.on("exit", resolve));
  return {
    started,
    stop: () => { if (recorder.exitCode === null) { try { recorder.stdin.write("q"); } catch { recorder.kill(); } setTimeout(() => recorder.kill(), 8000); } return exited; },
    exited,
  };
}

// ── Unreal ───────────────────────────────────────────────────────────────────
async function recordUnreal() {
  const exe = path.join(unrealStage, "Binaries/Win64/RhineLabViewer.exe");
  const saved = path.join(unrealStage, "Saved_Demo");
  // Empty it rather than remove it: the folder itself may be held open (a shell's cwd).
  mkdirSync(saved, { recursive: true });
  for (const entry of readdirSync(saved)) rmSync(path.join(saved, entry), { recursive: true, force: true });
  writeFileSync(path.join(saved, "ssh-hosts.json"), JSON.stringify({
    // The key comes from the isolated ssh config (Host *), so no local path shows in the host file.
    profiles: HOSTS.map(([alias, user], i) => ({ id: "demo-" + i, name: alias, hostname: "127.0.0.1", user, port: ready.port, authMode: "key", connectTimeout: 5, keepAliveInterval: 5, keepAliveCountMax: 3 })),
  }, null, 2));
  const appData = path.join(directory, "appdata");
  mkdirSync(appData, { recursive: true });
  // Launched through `start`, as a double click launches it: a ConPTY child
  // started from a console-attached parent exits at once (check-unreal-workbench.mjs play()).
  const launchedAt = Date.now();
  const app = spawn("cmd.exe", ["/c", "start", "/wait", '""', `"${exe}"`, "-promo-tour", "-windowed", "-ResX=2560", "-ResY=1440", "-dpr=1.3333", "-saveddirsuffix=Demo", "-nosound"], {
    cwd: path.dirname(exe), windowsHide: true, stdio: "ignore", windowsVerbatimArguments: true,
    env: { ...process.env, APPDATA: appData, RHINE_SSH_CONFIG: config, RHINE_CREDENTIAL_VAULT: path.join(directory, "vault.json") },
  });
  let pid = 0;
  for (const started = Date.now(); !pid && Date.now() - started < 60000; await sleep(300)) {
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Get-Process RhineLabViewer -ErrorAction SilentlyContinue | ? { $_.StartTime -gt [DateTime]::FromFileTimeUtc(${(BigInt(launchedAt) * 10000n + 116444736000000000n) - 20000000n}).ToLocalTime() } | Select -First 1 -ExpandProperty Id`], { windowsHide: true }).catch(() => ({ stdout: "" }));
    pid = Number(stdout.trim());
  }
  if (!pid) throw new Error("the Unreal app did not start");
  const hwnd = await windowOf(pid);
  const video = path.join(outDir, "unreal.mp4");
  const recorder = capture(hwnd, video);
  console.log(`unreal: recording window ${hwnd}`);
  const exit = await new Promise(resolve => { app.on("exit", resolve); setTimeout(() => { try { process.kill(pid); } catch {} app.kill(); resolve("timeout"); }, 480000); });
  await recorder.stop();
  const beats = path.join(saved, "promo-tour.json");
  const report = existsSync(beats) ? JSON.parse(readFileSync(beats, "utf8")) : { beats: [] };
  writeFileSync(path.join(outDir, "unreal-beats.json"), JSON.stringify({ recordingStarted: recorder.started, exit, ...report }, null, 2));
  console.log(`unreal: exit ${exit}, ${report.beats.length} beats, ${path.relative(root, video)}`);
}

// ── Electron ─────────────────────────────────────────────────────────────────
async function cdp(port) {
  for (let attempt = 0; attempt < 120; attempt++, await sleep(250)) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []);
    const page = targets.find(target => target.type === "page" && !target.url.startsWith("devtools"));
    if (!page) continue;
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let id = 0;
    const waiting = new Map();
    socket.onmessage = event => { const message = JSON.parse(event.data); if (message.id) { waiting.get(message.id)?.(message); waiting.delete(message.id); } };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const call = ++id;
      waiting.set(call, message => message.error ? reject(new Error(method + ": " + message.error.message)) : resolve(message.result));
      socket.send(JSON.stringify({ id: call, method, params }));
    });
    return { send, close: () => socket.close() };
  }
  throw new Error("no CDP page");
}

async function recordElectron() {
  const port = 9400 + Math.floor(Math.random() * 400);
  const profile = path.join(directory, "electron-profile"), local = path.join(directory, "electron-local");
  mkdirSync(profile, { recursive: true }); mkdirSync(local, { recursive: true });
  const env = { ...process.env, RHINE_SSH_CONFIG: config, LOCALAPPDATA: local };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(path.join(root, "node_modules/electron/dist/electron.exe"),
    [".", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--force-device-scale-factor=1"],
    { cwd: root, env, stdio: "ignore", windowsHide: false });
  const page = await cdp(port);
  const js = async (expression) => {
    const result = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(expression.slice(0, 80) + ": " + (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text));
    return result.result.value;
  };
  const until = async (expression, timeout = 30000) => {
    for (const started = Date.now(); Date.now() - started < timeout; await sleep(100)) if (await js(expression).catch(() => false)) return;
    throw new Error("timed out: " + expression);
  };
  // A window whose page is exactly 1920 × 1080.
  const { windowId } = await page.send("Browser.getWindowForTarget");
  await page.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
  await page.send("Browser.setWindowBounds", { windowId, bounds: { left: 40, top: 20, width: 1920, height: 1080 } });
  await sleep(400);
  const inner = await js("[innerWidth, innerHeight]");
  await page.send("Browser.setWindowBounds", { windowId, bounds: { width: 1920 + 1920 - inner[0], height: 1080 + 1080 - inner[1] } });
  await sleep(300);
  // A drawn pointer: CDP moves do not move the system cursor.
  await js(`(() => { const c = document.createElement('div'); c.id = 'promo-cursor';
    c.innerHTML = '<svg width="26" height="30" viewBox="0 0 26 30"><path d="M3 2 L3 24 L9 18.5 L13 27 L17 25.2 L13 17 L21 17 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none', transform: 'translate(1700px, 900px)', filter: 'drop-shadow(0 2px 3px rgb(0 0 0 / .35))' });
    document.documentElement.append(c); return true; })()`);
  let pointer = { x: 1700, y: 900 };
  const move = async (x, y, ms = 600) => {
    const from = { ...pointer }, frames = Math.max(1, Math.round(ms / 16.7));
    for (let i = 1; i <= frames; i++) {
      const t = i / frames, e = t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      pointer = { x: from.x + (x - from.x) * e, y: from.y + (y - from.y) * e };
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pointer.x, y: pointer.y });
      await js(`document.getElementById('promo-cursor').style.transform = 'translate(${pointer.x - 3}px, ${pointer.y - 2}px)'`);
      await sleep(16);
    }
  };
  const click = async () => {
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pointer.x, y: pointer.y, button: "left", clickCount: 1 });
    await sleep(60);
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pointer.x, y: pointer.y, button: "left", clickCount: 1 });
  };
  const center = selector => js(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r && r.width ? [r.left + r.width / 2, r.top + r.height / 2] : null; })()`);
  const moveTo = async (selector, ms = 600, dx = 0, dy = 0) => { const p = await center(selector); if (p) await move(p[0] + dx, p[1] + dy, ms); return Boolean(p); };
  const key = async (name, code = name, keyCode = 0) => {
    await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: name, code, windowsVirtualKeyCode: keyCode });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code, windowsVirtualKeyCode: keyCode });
  };
  const beats = [];
  const beat = name => { beats.push({ beat: name, utc: Date.now() }); console.log("electron: " + name); };

  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${app.pid}).MainWindowHandle`], { windowsHide: true });
  const hwnd = Number(stdout.trim()) || await windowOf(app.pid);
  // Straight past the opening; the Unreal cut carries the opening.
  await until("typeof rhineSshUi === 'object' && Array.isArray(rhineSshUi.boundHosts) && rhineSshUi.boundHosts.length > 0", 60000);
  await js("document.querySelector('#skip')?.click(), true");
  await until("document.querySelector('#archive-ui') && getComputedStyle(document.querySelector('#archive-ui')).opacity === '1'", 30000).catch(() => {});
  await sleep(2500);
  const video = path.join(outDir, "electron.mp4");
  const recorder = capture(hwnd, video);
  await sleep(800);
  try {
    beat("home");
    await move(1100, 560, 900);
    await sleep(500);
    beat("archive-next");
    for (const k of [["ArrowRight", 39], ["ArrowRight", 39], ["ArrowDown", 40]]) { await key(k[0], k[0], k[1]); await sleep(750); }
    // Themes from the settings sheet, each with its change-over.
    beat("settings");
    await moveTo('[data-action="settings"]', 700); await click(); await sleep(900);
    await js(`document.querySelector('[data-settings-section="appearance"], [data-settings-section="theme"]')?.click(), true`);
    await sleep(700);
    for (const name of ["hazard", "cryo", "riso", "voidwave"]) {
      if (!await moveTo(`button[data-color-palette="${name}"]`, 550)) continue;
      beat("theme-" + name); await click(); await sleep(1900);
    }
    await key("Escape", "Escape", 27); await sleep(900);
    // The spatial portals.
    beat("portals");
    await moveTo(".portal-launcher", 700); await click(); await sleep(900);
    await moveTo('.portal-card[data-portal="1"]', 450); await sleep(450);
    await moveTo('.portal-card[data-portal="2"]', 450); await sleep(450);
    await moveTo('.portal-card[data-portal="3"]', 450); await sleep(500);
    await moveTo('.portal-card[data-portal="2"]', 400); await click(); await sleep(2200);
    await key("Escape", "Escape", 27); await sleep(1000);
    // A session with its monitor and files.
    beat("connect");
    await js(`rhineSshUi.connectHost('atlas-a100'), true`);
    await until("rhineSshUi.sessions.some(s => s.target === 'atlas-a100' && s.phase === 'interactive')", 40000);
    await sleep(1500);
    await js(`(() => { const s = rhineSshUi.sessions.find(s => s.target === 'atlas-a100'); rhineSsh.write('nvidia-smi\\r'); return true; })()`).catch(() => {});
    await sleep(2200);
    beat("monitor");
    await moveTo('[data-workspace-page="monitor"]', 600); await click(); await sleep(1500);
    await moveTo(".ssh-gpu-overview-row", 600, -40); await sleep(1400);
    await moveTo(".ssh-gpu-overview-row:nth-child(3)", 500, -40); await sleep(1300);
    await moveTo('.ssh-metric[data-metric="cpu"]', 500); await sleep(1200);
    beat("files");
    await moveTo('[data-workspace-page="files"]', 600); await click(); await sleep(1400);
    await moveTo(".ssh-file-row:nth-child(2)", 500, -30); await sleep(1200);
    await moveTo(".ssh-file-row:nth-child(5)", 500, -30); await sleep(1200);
    await moveTo(".ssh-file-row:nth-child(7)", 500, -30); await sleep(1300);
    beat("end");
    await sleep(800);
  } finally {
    await recorder.stop();
    writeFileSync(path.join(outDir, "electron-beats.json"), JSON.stringify({ recordingStarted: recorder.started, beats }, null, 2));
    page.close();
    app.kill();
  }
  console.log(`electron: ${path.relative(root, video)}`);
}

try {
  if (doUnreal) await recordUnreal();
  if (doElectron) await recordElectron();
} finally {
  await control("stop").catch(() => {});
  fixture.kill();
}
