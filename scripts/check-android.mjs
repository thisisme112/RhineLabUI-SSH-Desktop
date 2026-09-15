/**
 * Android navigation and touch behaviour of the web build.
 *
 *   npm run check:android
 *
 * Runs the real `dist/` under an emulated Android handset (Pixel-sized viewport,
 * coarse pointer, touch events) and drives it the way a phone does. The subject
 * is the back stack: Android's back gesture is a history event, and until now
 * the app had none — pressing back from a document, the viewer or a dialog left
 * the page outright from wherever you were.
 *
 * Reports land in verification/android/.
 */
import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const outDir = path.join(root, "verification", "android");
await mkdir(outDir, { recursive: true });

if (!existsSync(path.join(distDir, "index.html")))
  throw new Error("Build the web app first: npm run build");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".glb": "model/gltf-binary",
  ".woff2": "font/woff2",
  ".ogg": "audio/ogg",
  ".txt": "text/plain; charset=utf-8",
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  // The offline worker is not the subject here, and its first install precaches
  // ~28 MiB. Refusing it keeps the run fast and each navigation honest.
  if (url.pathname === "/sw.js" || url.pathname === "/manifest.webmanifest") {
    response.writeHead(404).end();
    return;
  }
  const disk = path.join(distDir, decodeURIComponent(url.pathname));
  const file = url.pathname === "/" ? path.join(distDir, "index.html") : disk;
  if (!file.startsWith(distDir) || !existsSync(file)) {
    response.writeHead(404).end("not found");
    return;
  }
  response.writeHead(200, {
    "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
  });
  createReadStream(file).pipe(response);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const debugPort = 9379;
const profile = path.join(os.tmpdir(), `rhine-android-${process.pid}`);
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
const errors = [];
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }
  if (message.method === "Runtime.exceptionThrown") {
    const detail = message.params.exceptionDetails;
    errors.push(`exception: ${detail.text} ${detail.exception?.description ?? ""}`);
  }
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    errors.push(
      `console.error: ${message.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`,
    );
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
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails)
    throw new Error(
      `evaluate failed: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ""}`,
    );
  return result.result?.value;
};
const until = async (label, expression, timeoutMs = 30000) => {
  await send("Page.bringToFront");
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await evaluate(expression);
    if (value) return value;
    await sleep(150);
  }
  const state = await evaluate(
    `({ mode: document.querySelector('#stage')?.dataset.mode, layout: document.querySelector('#stage')?.dataset.layout, modal: !!document.querySelector('.modal-backdrop'), viewer: !!document.querySelector('.model-viewer:not([hidden])') })`,
  );
  throw new Error(`Timed out: ${label} — ${JSON.stringify(state)}`);
};
const checks = {};
const check = async (name, expression) => {
  checks[name] = Boolean(await evaluate(expression));
  console.log(`${checks[name] ? "PASS" : "FAIL"} ${name}`);
};
const shot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(outDir, `${name}.png`), Buffer.from(data, "base64"));
};
/** A phone's back gesture is `history.back()`; that is what this dispatches, so
 *  what is under test is the app's popstate handling, not a synthetic shortcut. */
const pressBack = async () => {
  await evaluate("history.back()");
  await sleep(450);
};
const tapSelector = async (selector) => {
  const box = await evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  if (!box) throw new Error(`no element for ${selector}`);
  await send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: box.x, y: box.y, id: 1 }],
  });
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(400);
};
const evidence = {};

try {
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  // Pixel 7: 412 x 915 CSS px at DPR 2.625, coarse pointer, real touch events.
  await send("Emulation.setDeviceMetricsOverride", {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
  });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/?scene=archive` });
  await until("archive ready", `window.rhine?.stats().ready && !document.querySelector('#loading')`);
  await sleep(600);

  await check(
    "the phone gets the portrait layout, not a shrunken desktop",
    `document.querySelector('#stage').dataset.layout === 'portrait' && matchMedia('(pointer: coarse)').matches`,
  );
  // The stage is centred by a transform either way, so the meaningful question
  // is whether it was *scaled*: at scale 1 it fills the viewport exactly, and
  // the portrait CSS reflows rather than the whole 1920x1080 stage shrinking.
  await check(
    "the stage fills the viewport instead of being scaled down",
    `(() => { const s = document.querySelector('#stage'); const r = s.getBoundingClientRect(); const scaled = getComputedStyle(s).transform.match(/matrix\\(([^)]+)\\)/)?.[1].split(',').map(Number); return Math.abs(r.width - innerWidth) <= 1 && Math.abs(r.height - innerHeight) <= 1 && (!scaled || (Math.abs(scaled[0] - 1) < 0.001 && Math.abs(scaled[3] - 1) < 0.001)); })()`,
  );
  await shot("01-portrait-archive");

  // ── the back stack ───────────────────────────────────────────────────────
  const startUrl = await evaluate("location.href");
  await tapSelector('[data-action="open"]');
  await until("detail open", `document.querySelector('#stage').dataset.mode === 'detail'`);
  await shot("02-detail");
  await pressBack();
  await check(
    "back leaves the document for the archive, without leaving the page",
    `document.querySelector('#stage').dataset.mode === 'archive' && location.href === ${JSON.stringify(startUrl)}`,
  );
  await check(
    "back did not reload the app",
    `typeof window.rhine === 'object' && window.rhine.stats().ready === true`,
  );

  // Viewer sits above the detail; back must close only the viewer.
  await tapSelector('[data-action="open"]');
  await until("detail again", `document.querySelector('#stage').dataset.mode === 'detail'`);
  await tapSelector('[data-action="model-viewer"]');
  await until("viewer open", `!!document.querySelector('.model-viewer:not([hidden])')`);
  await shot("03-viewer");
  await pressBack();
  await check(
    "back closes the viewer and keeps the document underneath",
    `!document.querySelector('.model-viewer:not([hidden])') && document.querySelector('#stage').dataset.mode === 'detail'`,
  );
  await pressBack();
  await check(
    "a second back then leaves the document",
    `document.querySelector('#stage').dataset.mode === 'archive'`,
  );

  // Modal sits above whatever is under it.
  await tapSelector('[data-action="settings"]');
  await until("settings open", `!!document.querySelector('.modal-backdrop')`);
  await shot("04-settings");
  await pressBack();
  await check(
    "back closes a dialog rather than leaving the aborted screen",
    `!document.querySelector('.modal-backdrop') && document.querySelector('#stage').dataset.mode === 'archive'`,
  );

  // At the archive there is nothing of ours left to undo, so the press must be
  // passed through: Android leaves the app from here, and the app must not
  // swallow it into a no-op that looks like a broken button. The sentinel entry
  // gives the press somewhere to land, which is how "not intercepted" becomes
  // observable — a swallowed press would leave us on the sentinel.
  await evaluate("history.pushState({sentinel: true}, '')");
  await pressBack();
  await check(
    "back at the archive is passed through, not swallowed",
    `history.state === null && document.querySelector('#stage').dataset.mode === 'archive'`,
  );
  await check(
    "and the app is still running on the same document",
    `location.href === ${JSON.stringify(startUrl)} && window.rhine.stats().ready === true`,
  );

  // ── status bar ───────────────────────────────────────────────────────────
  evidence.themeColorLight = await evaluate(
    `document.querySelector('meta[name="theme-color"]').content`,
  );
  await tapSelector('[data-action="settings"]');
  await until("settings for theme", `!!document.querySelector('[data-color-theme="dark"]')`);
  await tapSelector('[data-color-theme="dark"]');
  await sleep(300);
  evidence.themeColorDark = await evaluate(
    `({ meta: document.querySelector('meta[name="theme-color"]').content, paper: getComputedStyle(document.documentElement).getPropertyValue('--theme-paper').trim() })`,
  );
  await check(
    "the status bar colour follows the theme",
    `(() => { const meta = document.querySelector('meta[name="theme-color"]').content; const paper = getComputedStyle(document.documentElement).getPropertyValue('--theme-paper').trim(); return meta === paper && meta !== ${JSON.stringify(evidence.themeColorLight)}; })()`,
  );
  await shot("05-dark");
  // Back to light inside the same dialog, so the run leaves no preferences
  // behind and the reverse direction is covered too. The theme is a spring, so
  // this waits for it to settle rather than sampling mid-transition.
  await tapSelector('[data-color-theme="light"]');
  await until(
    "theme settles back to light",
    `document.querySelector('meta[name="theme-color"]').content === ${JSON.stringify(evidence.themeColorLight)}`,
    8000,
  );
  await check(
    "and follows it back to light",
    `document.querySelector('meta[name="theme-color"]').content === ${JSON.stringify(evidence.themeColorLight)}`,
  );
  await pressBack();

  // ── touch targets ────────────────────────────────────────────────────────
  evidence.touchTargets = await evaluate(
    `(() => { const out = {}; for (const sel of ['.system-nav button','.read-file','.archive-navigation button','.column-navigation button','.file-title']) { const el = document.querySelector(sel); if (!el) continue; const r = el.getBoundingClientRect(); out[sel] = { width: Math.round(r.width), height: Math.round(r.height) }; } const tick = document.querySelector('.file-ticks button'); if (tick) { const r = tick.getBoundingClientRect(); out['.file-ticks button'] = { width: Math.round(r.width), height: Math.round(r.height), count: document.querySelectorAll('.file-ticks button').length }; } return out; })()`,
  );
  await check(
    "every primary control clears 44px on both axes",
    `Object.entries(${JSON.stringify(evidence.touchTargets)}).filter(([k]) => k !== '.file-ticks button').every(([, r]) => r.width >= 44 && r.height >= 44)`,
  );
  await check("frame loop stays alive", `window.rhine.stats().fps > 0`);
} catch (driverError) {
  console.log("\n=== driver error ===");
  console.log(String(driverError));
  checks["driver completed"] = false;
} finally {
  await writeFile(
    path.join(outDir, "report.json"),
    JSON.stringify({ checks, errors, evidence }, null, 2),
  );
  console.log("\n=== errors ===");
  console.log(errors.length ? errors.join("\n") : "(none)");
  console.log("touch targets:", JSON.stringify(evidence.touchTargets));
  console.log("theme-color light:", evidence.themeColorLight, "dark:", JSON.stringify(evidence.themeColorDark));
  console.log(JSON.stringify(checks, null, 2));
  ws.close();
  edge.kill();
  server.close();
  process.exitCode = Object.values(checks).every(Boolean) && !errors.length ? 0 : 1;
}
