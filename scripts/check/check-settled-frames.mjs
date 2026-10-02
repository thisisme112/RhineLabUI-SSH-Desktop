import { artifactPath } from "../lib/artifacts.mjs";
/**
 * A resting desktop scene stops drawing and keeps its last picture (scene.ts
 * showsPicture). This checks both halves in the real desktop bundle: in each
 * resting state no frame is drawn while the loop keeps ticking, and the picture
 * left on the canvas equals a fresh draw of the same state (rhine.redraw()).
 * An animation that changes the picture without moving anything the scene
 * compares would fail the second half.
 *
 *   npm run build:desktop && node scripts/check/check-settled-frames.mjs
 */
import http from "node:http";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

const root = process.cwd(), dist = path.join(root, "dist-desktop");
if (!existsSync(path.join(dist, "index.html"))) throw new Error("dist-desktop missing: run npm run build:desktop");
const out = artifactPath("settled-frames");
await mkdir(out, { recursive: true });
const edge = process.env.EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const width = 1600, height = 900, footer = 80; // the rolling clock lives in the footer

const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (pathname === "/fixture.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    createReadStream(path.join(root, "scripts/fixtures/terminal-deck-bridge.js")).pipe(res);
    return;
  }
  const file = path.resolve(dist, "." + (pathname === "/" ? "/index.html" : pathname));
  if (!file.startsWith(dist + path.sep) || !existsSync(file)) { res.writeHead(404).end(); return; }
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".glb": "model/gltf-binary", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp" };
  res.writeHead(200, { "content-type": `${types[path.extname(file)] ?? "application/octet-stream"}; charset=utf-8` });
  if (file.endsWith("index.html")) res.end((await readFile(file, "utf8")).replace('<script type="module"', '<script src="/fixture.js"></script><script type="module"'));
  else createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

/** 8-bit, non-interlaced RGB(A) PNG, which is what the DevTools screenshot produces. */
function decodePng(buffer) {
  let offset = 8, w = 0, h = 0, depth = 0, colour = 0, interlace = 0;
  const data = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString("ascii", offset + 4, offset + 8), body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") { w = body.readUInt32BE(0); h = body.readUInt32BE(4); depth = body[8]; colour = body[9]; interlace = body[12]; }
    else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (depth !== 8 || interlace || ![2, 6].includes(colour)) throw new Error(`unsupported PNG (depth ${depth}, colour ${colour}, interlace ${interlace})`);
  const channels = colour === 6 ? 4 : 3, stride = w * channels, raw = zlib.inflateSync(Buffer.concat(data)), pixels = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = pixels.subarray(y * stride, (y + 1) * stride), up = y ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0, b = up ? up[x] : 0, c = up && x >= channels ? up[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      row[x] = value & 255;
    }
  }
  return { width: w, height: h, channels, pixels };
}
function psnr(a, b, rows) {
  let sum = 0, count = 0;
  for (let y = 0; y < rows; y++) for (let x = 0; x < a.width; x++) for (let c = 0; c < 3; c++) {
    const d = a.pixels[(y * a.width + x) * a.channels + c] - b.pixels[(y * b.width + x) * b.channels + c];
    sum += d * d; count++;
  }
  return sum === 0 ? Infinity : 10 * Math.log10((255 * 255 * count) / sum);
}

async function theme(name, debugPort) {
  const profile = await mkdtemp(path.join(os.tmpdir(), "rhine-settled-"));
  // A fresh browser per theme: headless Edge slows a long-lived page's frames to about one a second.
  const browser = spawn(edge, ["--headless=new", "--disable-extensions", "--no-first-run", "--hide-scrollbars", "--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist",
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
  let ws;
  const results = [], errors = [];
  try {
    let target;
    for (let i = 0; i < 60 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((t) => t.type === "page"); } catch {} }
    if (!target) throw new Error("Browser did not start");
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let sequence = 0;
    const pending = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
      if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence, timeout = setTimeout(() => reject(new Error(`${method} timeout`)), 60000);
      pending.set(id, (message) => { clearTimeout(timeout); message.error ? reject(new Error(message.error.message)) : resolve(message.result); });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    const counters = () => evaluate("({ updated: window.rhineSshUi?.rendering?.frames ?? 0, composed: window.rhine.stats().composedFrames })");
    const screenshot = async (file) => {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      const buffer = Buffer.from(data, "base64");
      await writeFile(path.join(out, file), buffer);
      return decodePng(buffer);
    };
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `localStorage.setItem('rhine-settings', JSON.stringify({sound:false,music:false,reduced:false,colorTheme:'${name}'})); localStorage.setItem('rhine-ssh-overview-collapsed','1');`,
    });
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/?scene=archive&frame-budget` });
    for (let i = 0; i < 300 && !(await evaluate("!!window.rhine?.stats().ready && window.rhine.stats().mode === 'archive'").catch(() => false)); i++) await sleep(200);

    const settle = async (state) => {
      // Rest is a second in which the loop ticked and the scene drew nothing.
      let settled = null, last = await counters();
      for (let i = 0; i < 25 && !settled; i++) {
        await sleep(1000);
        const now = await counters();
        if (now.updated - last.updated >= 20 && now.composed === last.composed) settled = { updates: now.updated - last.updated, after: i + 1 };
        last = now;
      }
      const shown = await screenshot(`${name}-${state}-shown.png`);
      const before = (await counters()).composed;
      await evaluate("rhine.redraw()");
      await sleep(400);
      const redrawn = (await counters()).composed - before;
      const fresh = await screenshot(`${name}-${state}-fresh.png`);
      const result = { theme: name, state, settled, redrawn, psnr: psnr(shown, fresh, height - footer) };
      results.push(result);
      console.log(`${name} ${state}: ${settled ? `rested after ${settled.after} s at ${settled.updates} updates/s` : "never rested"}, redraw drew ${redrawn}, shown vs fresh ${result.psnr === Infinity ? "identical" : result.psnr.toFixed(1) + " dB"}`);
    };
    await settle("home");
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
    await settle("next");
    await evaluate("rhine.detail()");
    await settle("detail");
    return { results, errors };
  } finally {
    if (ws?.readyState === WebSocket.OPEN) ws.close();
    browser.kill();
  }
}

try {
  const runs = [await theme("light", 9600 + (process.pid % 100)), await theme("dark", 9700 + (process.pid % 100))];
  const results = runs.flatMap((run) => run.results), errors = runs.flatMap((run) => run.errors);
  await writeFile(path.join(out, "report.json"), JSON.stringify({ results, errors }, null, 2));
  for (const r of results) {
    assert.ok(r.settled, `${r.theme} ${r.state}: the scene never stopped drawing while at rest`);
    assert.ok(r.redrawn >= 1, `${r.theme} ${r.state}: rhine.redraw() drew nothing`);
    assert.ok(r.psnr >= 50, `${r.theme} ${r.state}: the kept picture differs from a fresh draw (${r.psnr.toFixed(1)} dB)`);
  }
  assert.deepEqual(errors, []);
  console.log("Settled frames: the scene rests and what it keeps on screen is current.");
} finally {
  server.close();
}
