/**
 * Launcher icons and splash screens for the Android shell, from the shared mark.
 *
 *   npm run build:android-assets
 *
 * The same reasoning as `scripts/build-app-icon.mjs`: this repo does not depend
 * on `sharp`, and the Chromium that is already here renders each target at its
 * own size rather than downscaling one large image — which is what a thin-line
 * mark needs to stay legible at 48px.
 *
 * Targets and their exact pixel sizes are the ones the Capacitor template
 * ships, so this replaces them one for one instead of resizing anything.
 */
import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { labelMarkSvg } from "../src/brand.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const res = path.join(root, "android", "app", "src", "main", "res");
if (!existsSync(res)) {
  console.error("No android/ project. Run `npm run android:add` first.");
  process.exit(1);
}

/** The application's paper and ink, the same pair the desktop icon uses. */
const PAPER = "#e8e5e1";
const INK = "#171713";

const mark = labelMarkSvg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
const MARK = { width: 310, height: 145 };

/**
 * `fill` is how much of the canvas width the mark spans.
 *
 * 0.6455 is the composition the web and desktop icons already use, and it is
 * also what survives a round mask: the mark's corners sit at 0.35 of the radius
 * from the centre, well inside the circle.
 *
 * 0.61 for the adaptive foreground is not a preference but the format's rule —
 * of the 108dp canvas only the inner 66dp is guaranteed to survive whatever
 * shape the launcher applies, so anything wider can be clipped away.
 */
function artwork({ width, height, fill, background, circle = false }) {
  const scale = (width * fill) / MARK.width;
  const x = (width - MARK.width * scale) / 2;
  const y = (height - MARK.height * scale) / 2;
  const backdrop = background
    ? circle
      ? `<circle cx="${width / 2}" cy="${height / 2}" r="${width / 2}" fill="${background}"/>`
      : `<rect width="${width}" height="${height}" fill="${background}"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${backdrop}<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(4)})" color="${INK}">${mark}</g></svg>`;
}

const LAUNCHER = [
  ["mipmap-mdpi", 48],
  ["mipmap-hdpi", 72],
  ["mipmap-xhdpi", 96],
  ["mipmap-xxhdpi", 144],
  ["mipmap-xxxhdpi", 192],
];
/** Adaptive foreground: transparent, inner 66dp only. */
const FOREGROUND = [
  ["mipmap-mdpi", 108],
  ["mipmap-hdpi", 162],
  ["mipmap-xhdpi", 216],
  ["mipmap-xxhdpi", 324],
  ["mipmap-xxxhdpi", 432],
];
/** Splashes ship at the device aspect ratios, so each is rendered to fit. */
const SPLASH = [
  ["drawable", 480, 320],
  ["drawable-land-mdpi", 480, 320],
  ["drawable-land-hdpi", 800, 480],
  ["drawable-land-xhdpi", 1280, 720],
  ["drawable-land-xxhdpi", 1600, 960],
  ["drawable-land-xxxhdpi", 1920, 1280],
  ["drawable-port-mdpi", 320, 480],
  ["drawable-port-hdpi", 480, 800],
  ["drawable-port-xhdpi", 720, 1280],
  ["drawable-port-xxhdpi", 960, 1600],
  ["drawable-port-xxxhdpi", 1280, 1920],
];

const targets = [];
for (const [dir, size] of LAUNCHER) {
  targets.push({ dir, name: "ic_launcher.png", width: size, height: size, fill: 0.6455, background: PAPER });
  targets.push({ dir, name: "ic_launcher_round.png", width: size, height: size, fill: 0.6455, background: PAPER, circle: true });
}
for (const [dir, size] of FOREGROUND)
  targets.push({ dir, name: "ic_launcher_foreground.png", width: size, height: size, fill: 0.61, background: null });
for (const [dir, width, height] of SPLASH)
  // A consistent optical size across both orientations: the mark is set against
  // the shorter side, so a phone held sideways shows the same mark as upright.
  targets.push({ dir, name: "splash.png", width, height, fill: (Math.min(width, height) * 0.34) / width, background: PAPER });

const pageFor = (target) =>
  `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block;width:100vw;height:100vh}</style>${artwork(target)}`;
let current = pageFor(targets[0]);

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(current);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const debugPort = 9385;
const profile = path.join(os.tmpdir(), `rhine-android-assets-${process.pid}`);
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
    const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
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
  await send("Emulation.setDefaultBackgroundColorOverride", {
    color: { r: 0, g: 0, b: 0, a: 0 },
  });
  let sequence = 0;
  for (const item of targets) {
    current = pageFor(item);
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/?n=${sequence++}` });
    await send("Emulation.setDeviceMetricsOverride", {
      width: item.width,
      height: item.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(140);
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const png = Buffer.from(data, "base64");
    const dir = path.join(res, item.dir);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, item.name), png);
    console.log(
      `${item.dir}/${item.name}  ${item.width}x${item.height}  ${png.length} bytes`,
    );
  }
  console.log(`\n${targets.length} assets written to android/app/src/main/res`);
} finally {
  ws.close();
  edge.kill();
  server.close();
}
