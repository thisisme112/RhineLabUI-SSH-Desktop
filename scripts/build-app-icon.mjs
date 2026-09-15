/**
 * The desktop window/taskbar icon, from the same shared mark as the web icons.
 *
 *   npm run build:app-icon
 *
 * `scripts/build-icons.mjs` rasterizes the mark with `sharp`, which this repo
 * does not depend on (that script takes an external `SHARP_MODULE`). This one
 * uses the Chromium that is already here — the same headless Edge the check
 * scripts drive — and renders each size natively rather than downscaling a
 * large one, which is what a thin-line mark needs to stay legible at 16px.
 *
 * Output is committed: `electron/assets/app-icon.ico`. Windows reads a
 * multi-size icon to pick the right one per surface (taskbar, Alt-Tab, Explorer
 * large icons), and each entry below is a PNG, which Vista and later accept
 * directly.
 */
import http from "node:http";
import { writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { labelMarkSvg } from "../src/brand.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "electron", "assets", "app-icon.ico");

/** The same composition `build-icons.mjs` exports for the home-screen icons:
 *  the shared mark centred on the application's own paper. */
const mark = labelMarkSvg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
const MARK = { width: 310, height: 145 };

/**
 * The mark is 2.1:1, so fitting it to a square on width leaves a lot of paper
 * above and below. That is right at 128px and up — it matches the home-screen
 * icons — and wrong at 16–48, where the mark's 26-unit strokes land under two
 * pixels and the `+` / `−` disappear. The small entries are drawn larger so the
 * drawing survives; the drawing itself is unchanged.
 */
function artwork(fill) {
  const scale = (512 * fill) / MARK.width;
  const x = (512 - MARK.width * scale) / 2;
  const y = (512 - MARK.height * scale) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#e8e5e1"/><g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(4)})" color="#171713">${mark}</g></svg>`;
}

const SIZES = [16, 24, 32, 48, 64, 128, 256];
/** 0.6455 reproduces the existing icon set's composition exactly. */
const fillFor = (size) => (size <= 48 ? 0.84 : 0.6455);

/** ICONDIR + one ICONDIRENTRY per image. 256 is written as 0, which is how the
 *  format has always spelled it — the field is a byte. */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(16 * images.length);
  let offset = header.length + entries.length;
  images.forEach(({ size, png }, index) => {
    const at = index * 16;
    const extent = size >= 256 ? 0 : size;
    entries.writeUInt8(extent, at);
    entries.writeUInt8(extent, at + 1);
    entries.writeUInt8(0, at + 2);
    entries.writeUInt8(0, at + 3);
    entries.writeUInt16LE(1, at + 4);
    entries.writeUInt16LE(32, at + 6);
    entries.writeUInt32LE(png.length, at + 8);
    entries.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, entries, ...images.map((image) => image.png)]);
}

const pageFor = (fill) =>
  `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#e8e5e1;overflow:hidden}svg{display:block;width:100vw;height:100vh}</style>${artwork(fill)}`;
let current = pageFor(fillFor(256));

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(current);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const debugPort = 9367;
const profile = path.join(os.tmpdir(), `rhine-icon-${process.pid}`);
const edge = spawn(
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  [
    "--headless=new",
    "--disable-extensions",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { windowsHide: true, stdio: "ignore" },
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let target = null;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(300);
  try {
    const list = await (
      await fetch(`http://127.0.0.1:${debugPort}/json/list`)
    ).json();
    target = list.find((entry) => entry.type === "page");
  } catch {
    /* DevTools endpoint not up yet */
  }
}
if (!target) throw new Error("Edge DevTools endpoint never came up");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let nextId = 1;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else resolve(message.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });

try {
  await send("Page.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  await sleep(600);

  const images = [];
  for (const size of SIZES) {
    // Re-navigate rather than only resizing: the artwork differs by size, and
    // a resize alone would keep the previous composition.
    current = pageFor(fillFor(size));
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/?s=${size}` });
    await send("Emulation.setDeviceMetricsOverride", {
      width: size,
      height: size,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(220);
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const png = Buffer.from(data, "base64");
    images.push({ size, png });
    console.log(
      `${String(size).padStart(3)}px  ${String(png.length).padStart(5)} bytes  fill ${fillFor(size)}`,
    );
  }

  await mkdir(path.dirname(out), { recursive: true });
  const ico = buildIco(images);
  await writeFile(out, ico);
  console.log(
    `\n${path.relative(root, out)}  ${ico.length} bytes, ${images.length} sizes`,
  );
} finally {
  ws.close();
  edge.kill();
  server.close();
}
