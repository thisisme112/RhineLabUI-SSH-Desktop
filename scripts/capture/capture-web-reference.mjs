import { artifactPath } from "../lib/artifacts.mjs";
/** Captures the web desktop bundle at the same states and size as the Unreal
 * home-flow probe (`check-unreal-workbench.mjs --home-flow`), so each Unreal
 * change can be judged against the source of truth frame for frame.
 *
 *   node scripts/capture/capture-web-reference.mjs [--out dir] [--width 1600 --height 900]
 */
import http from "node:http";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

const root = process.cwd(),
  dist = path.join(root, "dist-desktop");
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const out = path.resolve(root, arg("--out", artifactPath("web-reference")));
const width = Number(arg("--width", "1600")),
  height = Number(arg("--height", "900"));
await mkdir(out, { recursive: true });
if (!existsSync(path.join(dist, "index.html"))) throw new Error("dist-desktop missing: run npm run build:desktop");

const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".glb": "model/gltf-binary",
  ".svg": "image/svg+xml",
  ".ogg": "audio/ogg",
  ".json": "application/json",
  ".png": "image/png",
  ".webp": "image/webp",
  ".hdr": "application/octet-stream",
};
const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (pathname === "/fixture.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    createReadStream(path.join(root, "scripts/fixtures/terminal-deck-bridge.js")).pipe(res);
    return;
  }
  const file = path.resolve(dist, "." + (pathname === "/" ? "/index.html" : pathname));
  if (!file.startsWith(dist + path.sep) || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": `${mime[path.extname(file)] ?? "application/octet-stream"}; charset=utf-8` });
  if (file.endsWith("index.html"))
    res.end((await readFile(file, "utf8")).replace('<script type="module"', '<script src="/fixture.js"></script><script type="module"'));
  else createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port,
  debugPort = 9800 + (process.pid % 150);
const profile = await mkdtemp(path.join(os.tmpdir(), "rhine-web-reference-"));
const browser = spawn(
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  [
    "--headless=new",
    "--disable-extensions",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--enable-gpu",
    "--use-angle=d3d11",
    "--ignore-gpu-blocklist",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    "about:blank",
  ],
  { windowsHide: true, stdio: "ignore" },
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errors = [],
  shots = [];
let ws;
try {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(200);
    try {
      target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((t) => t.type === "page");
    } catch {}
  }
  if (!target) throw new Error("Browser did not start");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
    if (message.method === "Runtime.exceptionThrown")
      errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => reject(new Error(`${method} timeout`)), 60000);
      pending.set(id, (message) => {
        clearTimeout(timeout);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const until = async (name, expression, timeout = 60000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await evaluate(expression)) return;
      await sleep(150);
    }
    throw new Error(`Timed out: ${name}`);
  };
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(out, `${name}.png`), Buffer.from(data, "base64"));
    shots.push(name);
    console.log(`shot ${name}`);
  };
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });

  for (const theme of ["light", "dark"]) {
    await send("Page.navigate", { url: "about:blank" });
    await sleep(200);
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `localStorage.setItem('rhine-settings', JSON.stringify({sound:false,music:false,reduced:false,colorTheme:'${theme}'}));`,
    });
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/?scene=archive` });
    await until("scene ready", `window.rhine?.stats().ready && window.rhine.stats().mode === 'archive'`);
    await sleep(4500);
    const prefix = theme === "light" ? "web" : "web-dark";
    await shot(`${prefix}-01-home`);
    if (theme === "light") {
      await evaluate(`rhine.select(1)`);
      await sleep(2500);
      await shot(`${prefix}-02-selected`);
      await evaluate(`rhine.select(0)`);
      await sleep(2500);
    }
    await evaluate(`rhine.detail()`);
    await sleep(900);
    await shot(`${prefix}-03-scanning`);
    await sleep(4200);
    await shot(`${prefix}-03-detail`);
    if (theme === "light") {
      await evaluate(`document.querySelector('[data-action="back"]').click()`);
      await sleep(3000);
      await shot(`${prefix}-04-return`);
      await evaluate(`document.querySelector('[data-action="ssh-hosts"]')?.click()`);
      await sleep(2200);
      await shot(`${prefix}-05-overview`);
    }
  }
  const stats = await evaluate(`window.rhine.stats()`);
  await writeFile(
    path.join(out, "report.json"),
    JSON.stringify({ width, height, shots, errors, stats: { threeState: stats.threeState, fps: stats.fps, mode: stats.mode } }, null, 2),
  );
  console.log(errors.length ? `errors: ${errors.join(" | ")}` : "no page errors");
} finally {
  if (ws?.readyState === WebSocket.OPEN) ws.close();
  browser.kill();
  server.close();
}
