/**
 * Bake the web opening sequence into a frame sequence for Unreal.
 *
 *   node scripts/render-boot-frames.mjs                 # all 1316 frames at 60 fps (2560x1440)
 *   node scripts/render-boot-frames.mjs --width 3840 --height 2160 --quality 92 --out prototypes/unreal/Build/BootFrames4k
 *   node scripts/render-boot-frames.mjs --frames 0,25,50 --out .tools/boot-check
 *   node scripts/render-boot-frames.mjs --skip-build
 *
 * The Unreal build plays the opening as baked frames, so the frames have to come
 * from the real web implementation: the harness bundles src/boot.ts plus the
 * real stylesheet, and each frame is stepped through `window.__boot.render(t)`
 * on the fps grid. Output lands in
 * prototypes/unreal/Build/BootFrames as frame_0000.jpg.
 */
import http from "node:http";
import { createReadStream, existsSync, mkdirSync, statSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};

const FPS = Number(argument("--fps", "60"));
const DURATION = 21.92;
const TOTAL = Math.ceil(DURATION * FPS);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

const frames = argument("--frames", null)?.split(",").map(Number) ?? Array.from({ length: TOTAL }, (_, index) => index);
const outDir = path.resolve(root, argument("--out", "prototypes/unreal/Build/BootFrames"));
const quality = Number(argument("--quality", "95"));
const width = Number(argument("--width", "2560"));
const height = Number(argument("--height", "1440"));
const skipBuild = process.argv.includes("--skip-build");
const distDir = path.join(root, "prototypes/unreal/Build/boot-harness");

if (!skipBuild) {
  const build = spawn(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "build",
    "--config", path.join(root, "prototypes/unreal/boot-harness/vite.config.ts")], { cwd: root, stdio: "inherit" });
  const code = await new Promise(resolve => build.on("exit", resolve));
  if (code !== 0) throw new Error(`harness build failed with ${code}`);
}
if (!existsSync(path.join(distDir, "index.html"))) throw new Error(`harness build missing at ${distDir}`);

mkdirSync(outDir, { recursive: true });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  // The stylesheet points at /fonts and /assets with absolute URLs; serve those
  // from the repo's public folder so the bake uses the shipped webfonts instead
  // of a fallback face.
  const disk = existsSync(path.join(distDir, requested))
    ? path.join(distDir, requested)
    : path.join(root, "public", requested);
  if (!existsSync(disk) || statSync(disk).isDirectory()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(disk)] ?? "application/octet-stream" });
  createReadStream(disk).pipe(res);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const debugPort = 9366;
const profile = path.join(os.tmpdir(), `rhine-boot-${process.pid}`);
const edge = spawn(EDGE, [
  "--headless=new", "--disable-extensions", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  `--force-device-scale-factor=1`, `--window-size=${width},${height}`,
  `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "about:blank",
]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let target = null;
for (let attempt = 0; attempt < 50 && !target; attempt++) {
  await sleep(300);
  try {
    const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    target = list.find(entry => entry.type === "page");
  } catch {
    /* DevTools endpoint not up yet */
  }
}
if (!target) throw new Error("Edge DevTools endpoint never came up");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});

let nextId = 1;
const pending = new Map();
const problems = [];
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }
  if (message.method === "Runtime.exceptionThrown") {
    problems.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 60000);
  pending.set(id, message => {
    clearTimeout(timer);
    if (message.error) reject(new Error(`${method}: ${message.error.message}`));
    else resolve(message.result);
  });
  socket.send(JSON.stringify({ id, method, params }));
});

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/index.html?w=${width}&h=${height}` });

  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    await sleep(250);
    const probe = await send("Runtime.evaluate", { expression: "Boolean(window.__boot?.ready)", returnByValue: true });
    ready = probe.result?.value === true;
  }
  if (!ready) throw new Error("boot harness never became ready");

  const started = Date.now();
  let bytes = 0;
  for (const frame of frames) {
    const appTime = frame / FPS;
    await send("Runtime.evaluate", { expression: `window.__boot.render(${appTime})`, returnByValue: true });
    await send("Runtime.evaluate", {
      expression: "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
      awaitPromise: true,
    });
    const shot = await send("Page.captureScreenshot", { format: "jpeg", quality, captureBeyondViewport: false });
    const buffer = Buffer.from(shot.data, "base64");
    bytes += buffer.length;
    const name = `frame_${String(frame).padStart(4, "0")}.jpg`;
    await new Promise((resolve, reject) =>
      import("node:fs").then(({ writeFileSync }) => {
        try { writeFileSync(path.join(outDir, name), buffer); resolve(); } catch (error) { reject(error); }
      }));
  }
  const seconds = (Date.now() - started) / 1000;
  console.log(`RHINE_BOOT_FRAMES ${frames.length} frames at ${width}x${height} ${FPS}fps → ${path.relative(root, outDir)}`);
  console.log(`  ${(bytes / 1048576).toFixed(1)} MB total, ${(bytes / frames.length / 1024).toFixed(0)} KB average, ${(frames.length / seconds).toFixed(1)} fps capture`);
  // The Unreal loader reads this instead of hard-coding frame count and size.
  writeFileSync(path.join(outDir, "boot-frames.json"), `${JSON.stringify({
    fps: FPS, width, height, count: frames.length, duration: DURATION, format: "jpg", quality,
  }, null, 2)}\n`);
  if (problems.length) console.log(`  renderer problems: ${problems.slice(0, 3).join(" | ")}`);
} finally {
  socket.close();
  edge.kill();
  server.close();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
}