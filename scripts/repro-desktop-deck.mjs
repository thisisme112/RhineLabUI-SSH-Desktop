/**
 * Browser repro for the session deck — zero-dependency CDP driver.
 *
 * Serves dist-desktop with the fake bridge injected, drives the real connect
 * flow in headless Edge over the DevTools protocol (Node 22's built-in
 * WebSocket), and captures exactly what breaks: page exceptions, console
 * errors, a dead render loop (fps stops), and a screenshot per stage.
 *
 *   node scripts/repro-desktop-deck.mjs
 *
 * Reports land in verification/repro-deck/. Only the network is faked.
 */
import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist-desktop");
const outDir = path.join(root, "verification", "repro-deck");
mkdirSync(outDir, { recursive: true });

const EDGE =
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

// ── static server: dist-desktop + injected fake bridge ─────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".glb": "model/gltf-binary",
  ".woff2": "font/woff2",
  ".ogg": "audio/ogg",
  ".txt": "text/plain; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  if (filePath === "/fake-desktop-bridge.js") {
    res.writeHead(200, { "content-type": MIME[".js"] });
    createReadStream(
      path.join(root, "scripts", "repro-deck", "fake-desktop-bridge.js"),
    ).pipe(res);
    return;
  }
  const disk = path.join(distDir, decodeURIComponent(filePath));
  if (!disk.startsWith(distDir) || !existsSync(disk)) {
    res.writeHead(404).end("not found");
    return;
  }
  if (filePath === "/index.html") {
    // The bridge must exist before the app bundle reads it. CSP allows
    // same-origin scripts, so inject an external tag ahead of the module.
    const html = await readFile(disk, "utf8");
    res.writeHead(200, { "content-type": MIME[".html"] });
    res.end(
      html.replace(
        /<script type="module"/,
        '<script src="./fake-desktop-bridge.js"></script>\n    <script type="module"',
      ),
    );
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(disk)] ?? "application/octet-stream",
  });
  createReadStream(disk).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
console.log(`serving on http://127.0.0.1:${port}`);

// ── minimal CDP client ─────────────────────────────────────────────────────
const debugPort = 9333;
const profile = path.join(os.tmpdir(), `rhine-repro-${process.pid}`);
const edge = spawn(EDGE, [
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profile}`,
  "--headless=new",
  "--disable-gpu",
  "--window-size=1600,900",
  "about:blank",
]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let target = null;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(300);
  try {
    const list = await (
      await fetch(`http://127.0.0.1:${debugPort}/json/list`)
    ).json();
    target = list.find((t) => t.type === "page");
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
    errors.push(
      `exception: ${detail.text} ${detail.exception?.description ?? ""}`,
    );
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
      `evaluate failed: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ""}\n  in: ${expression.slice(0, 120)}`,
    );
  return result.result?.value;
};
const until = async (label, expression, timeoutMs = 40000) => {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await evaluate(expression);
    if (value) return value;
    await sleep(400);
  }
  console.log(`timeout waiting for ${label}`);
  return value;
};

await send("Runtime.enable");
await send("Page.enable");

const shot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(outDir, `${name}.png`), Buffer.from(data, "base64"));
};
const key = async (keyName, code, keyCode) => {
  for (const type of ["rawKeyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type,
      key: keyName,
      code,
      windowsVirtualKeyCode: keyCode,
    });
  }
};
const fps = () =>
  evaluate(`document.querySelector("#three-scene")?.dataset.fps ?? null`);

try {
  // ?scene=archive skips the entry gate and the opening cinematic, so the
  // render loop starts as soon as the scene has loaded.
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/?scene=archive` });
  let bootFps = null;
  for (let i = 0; i < 100; i++) {
    await sleep(400);
    bootFps = await fps();
    if (bootFps && Number(bootFps) > 0) break;
  }
  console.log("fps after boot:", bootFps);
  await until("rhineSshUi", `Boolean(window.rhineSshUi)`);
  await until("hosts loaded", `window.rhineSshUi.cardOf("demo-box") !== null`);

  await evaluate(`window.rhineSshUi.connectHost("demo-box")`);
  await sleep(2500);
  console.log("fps during handshake:", await fps());
  await shot("1-connecting");

  const kind = await until("password prompt", `window.rhineSshUi.promptKind`);
  console.log("prompt kind:", kind);
  await shot("2-password-prompt");
  if (kind) await evaluate(`window.rhineSshUi.answerSecret("review")`);

  await until("interactive phase", `window.rhineSsh?.status().phase === "interactive"`);
  await sleep(2500);
  console.log("fps after interactive:", await fps());
  console.log("phase:", await evaluate(`window.rhineSsh?.status().phase`));
  console.log("terminal open:", await evaluate(`window.rhineSshUi.isOpen`));
  await shot("3-open");

  // Real keystrokes into the live session, so the deck mirror has I/O to show.
  for (const ch of "ls -la") {
    await send("Input.dispatchKeyEvent", { type: "char", text: ch });
  }
  await key("Enter", "Enter", 13);
  await sleep(900);
  await shot("4-typing");
  console.log("fps at end:", await fps());
} catch (driverError) {
  console.log("\n=== driver error ===");
  console.log(String(driverError));
} finally {
  console.log("\n=== errors ===");
  console.log(errors.length ? errors.join("\n") : "(none)");
  edge.kill();
  server.close();
  process.exit(0);
}
