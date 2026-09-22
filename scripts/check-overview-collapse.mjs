/**
 * The host overview's stow control, driven in headless Edge.
 *
 *   npm run check:ssh-overview-collapse
 *
 * The overview is a full-viewport layer over the archive; before it could be
 * stowed there was no way to see or use the array underneath it. Three things
 * are worth asserting and none are visible in a unit test: the sheet really
 * leaves, the archive underneath becomes usable again, and the stowed state is
 * remembered across a reload.
 *
 * Reports land in verification/overview-collapse/.
 */
import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist-desktop");
const outDir = path.join(root, "verification", "overview-collapse");
await mkdir(outDir, { recursive: true });

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
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

const debugPort = 9353;
const profile = path.join(os.tmpdir(), `rhine-collapse-${process.pid}`);
const edge = spawn(EDGE, [
  "--headless=new",
  "--disable-extensions",
  "--no-first-run",
  "--no-default-browser-check",
  "--hide-scrollbars",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profile}`,
  "--window-size=1920,1080",
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
const until = async (label, expression, timeoutMs = 40000) => {
  await send("Page.bringToFront");
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await evaluate(expression);
    if (value) return value;
    await sleep(200);
  }
  const state = await evaluate(
    `({ collapsed: document.querySelector('.ssh-overview')?.dataset.collapsed, glass: document.querySelector('.ssh-overview-glass')?.getBoundingClientRect().toJSON(), restore: document.querySelector('.ssh-overview-restore')?.outerHTML?.slice(0, 200) })`,
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
const clickCentre = async (selector) => {
  const box = await evaluate(
    `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`,
  );
  if (!box) throw new Error(`no element for ${selector}`);
  for (const type of ["mousePressed", "mouseReleased"])
    await send("Input.dispatchMouseEvent", {
      type,
      x: box.x,
      y: box.y,
      button: "left",
      clickCount: 1,
    });
};
const chord = async (key, code, keyCode) => {
  for (const type of ["rawKeyDown", "keyUp"])
    await send("Input.dispatchKeyEvent", {
      type,
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      modifiers: 2 | 8, // Ctrl + Shift
    });
};

try {
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // Only for the first document: the reload later in this run is checking that
  // the stowed state survives, so it must not be primed away.
  const prime = await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.removeItem('rhine-ssh-overview-collapsed');`,
  });
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/?scene=archive` });
  await until(
    "overview with hosts",
    `window.rhine?.stats().ready && document.querySelectorAll('.ssh-overview-host').length > 0`,
  );
  await check(
    "the overview starts expanded",
    `document.querySelector('.ssh-overview').dataset.collapsed === 'false' && document.querySelector('.ssh-overview-restore').getBoundingClientRect().width > 0 && getComputedStyle(document.querySelector('.ssh-overview-restore')).opacity === '0'`,
  );
  await shot("01-expanded");
  const dragStart = await evaluate(`(() => { const r = document.querySelector('.ssh-overview-heading h1').getBoundingClientRect(); const p = document.querySelector('.ssh-overview-glass').getBoundingClientRect(); return { x:r.x+30, y:r.y+15, left:p.left, top:p.top }; })()`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: dragStart.x, y: dragStart.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: dragStart.x + 80, y: dragStart.y + 35, button: "left", buttons: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: dragStart.x + 80, y: dragStart.y + 35, button: "left", clickCount: 1 });
  await check("dragging the title moves and remembers the overview", `(() => { const r = document.querySelector('.ssh-overview-glass').getBoundingClientRect(); const saved = JSON.parse(localStorage.getItem('rhine-ssh-overview-position')); return Math.abs(r.left - ${dragStart.left} - 80) < 2 && Math.abs(r.top - ${dragStart.top} - 35) < 2 && saved.x === 80 && saved.y === 35; })()`);

  await clickCentre('[data-overview-action="collapse"]');
  // Wait for the transition to settle rather than sleeping a fixed time: a
  // slow frame would otherwise be caught mid-fade and read as a failure.
  await until(
    "sheet leaves the frame",
    `(() => { const g = document.querySelector('.ssh-overview-glass').getBoundingClientRect(); return getComputedStyle(document.querySelector('.ssh-overview-glass')).opacity === '0' && g.top >= innerHeight; })()`,
    8000,
  );
  await check(
    "stowing takes the sheet out of the frame",
    `(() => { const g = document.querySelector('.ssh-overview-glass').getBoundingClientRect(); return getComputedStyle(document.querySelector('.ssh-overview-glass')).opacity === '0' && g.top >= innerHeight; })()`,
  );
  await check(
    "the sheet stops taking clicks where it used to be",
    `document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('.ssh-overview-glass') === null`,
  );
  await check(
    "the archive underneath receives pointer events again",
    `document.elementFromPoint(innerWidth / 2, innerHeight / 2) !== null && !document.elementFromPoint(innerWidth / 2, innerHeight / 2).closest('.ssh-overview')`,
  );
  await shot("02-stowed");
  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  await check("resizing a stowed overview does not corrupt its position", `document.querySelector('.ssh-overview-glass').style.getPropertyValue('--overview-y') === '35px'`);
  await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await sleep(400);

  await check(
    "the stowed tab carries the live counts",
    `/\\d+ 台主机/.test(document.querySelector('.ssh-overview-restore small').textContent)`,
  );
  await clickCentre(".ssh-overview-restore");
  await until(
    "sheet returns",
    `document.querySelector('.ssh-overview').dataset.collapsed === 'false' && getComputedStyle(document.querySelector('.ssh-overview-glass')).opacity === '1'`,
    8000,
  );
  await check("the tab brings the sheet back", `true`);

  await chord("H", "KeyH", 72);
  await until(
    "keyboard stow",
    `document.querySelector('.ssh-overview').dataset.collapsed === 'true'`,
    8000,
  );
  await check("Ctrl+Shift+H stows it from the keyboard", `true`);
  await check(
    "the stowed state is remembered",
    `localStorage.getItem('rhine-ssh-overview-collapsed') === '1'`,
  );

  await send("Page.removeScriptToEvaluateOnNewDocument", {
    identifier: prime.identifier,
  });
  await send("Page.reload");
  await until(
    "reloaded with hosts",
    `window.rhine?.stats().ready && document.querySelectorAll('.ssh-overview-host').length > 0`,
  );
  await sleep(300);
  await check(
    "a reload comes back stowed",
    `document.querySelector('.ssh-overview').dataset.collapsed === 'true'`,
  );
  await shot("03-stowed-after-reload");

  // The host picker routes to the overview's own hosts page, so a stowed sheet
  // has to be brought back before it can be routed to.
  await chord("S", "KeyS", 83);
  await sleep(600);
  await check(
    "the host picker expands a stowed sheet before routing",
    `document.querySelector('.ssh-overview').dataset.collapsed === 'false'`,
  );
  await shot("04-expanded-by-host-picker");
} catch (driverError) {
  console.log("\n=== driver error ===");
  console.log(String(driverError));
  checks["driver completed"] = false;
} finally {
  await writeFile(
    path.join(outDir, "report.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log("\n=== errors ===");
  console.log(errors.length ? errors.join("\n") : "(none)");
  console.log(JSON.stringify(checks, null, 2));
  ws.close();
  edge.kill();
  server.close();
  process.exitCode = Object.values(checks).every(Boolean) && !errors.length ? 0 : 1;
}
