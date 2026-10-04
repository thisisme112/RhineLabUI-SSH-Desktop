import { artifactPath } from "../lib/artifacts.mjs";
/**
 * The label design's host overview under a moving hand, in headless Edge against dist-desktop.
 *
 *   npm run build:desktop && npm run check:ssh-overview-hover
 *
 * The pointer rests on one row after another. Every frame records which row is printed in reverse
 * (data-focus), which archive is selected and how long the frame took. Three things are asserted:
 * the reverse print reaches the row at once, it stays there while the hand rests (it used to go
 * back to the row the hand had left for a third of a second, because the row only waited 500 ms
 * for an archive that took 810 ms to follow), and the archive follows within a fifth of a second.
 * Frame times are reported, not asserted: this machine's timing is not steady enough to gate on.
 *
 * The report lands in .artifacts/checks/overview-hover/.
 */
import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distDir = path.join(root, "dist-desktop");
const outDir = path.join(root, artifactPath("overview-hover"));
await mkdir(outDir, { recursive: true });

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png",
  ".svg": "image/svg+xml", ".glb": "model/gltf-binary", ".woff2": "font/woff2", ".ogg": "audio/ogg", ".txt": "text/plain; charset=utf-8" };
const HOSTS = 6, DWELL = 1000;
/** Six saved hosts and nothing else: the rows all fit the list without scrolling. */
const PROFILES = `(() => {
  const saved = Array.from({ length: ${HOSTS} }, (_, i) => ({ id: "p-" + (i + 1), name: "节点 " + String(i + 1).padStart(2, "0"), hostname: "10.0.0." + (i + 5), user: "ops", port: 22 }));
  window.rhineDesktop.hosts = async () => ({ ok: true, configPath: "fixture", revision: "1", hosts: saved.map(profile => ({ alias: "rhine-profile:" + profile.id, displayName: profile.name, source: "saved",
    hostname: profile.hostname, user: profile.user, port: String(profile.port), profile: { ...profile }, raw: "HostName " + profile.hostname })) });
  window.rhineDesktop.hostProfiles = { save: async profile => ({ ok: true, profile, revision: "1" }), remove: async () => ({ ok: true }), pickIdentity: async () => ({ ok: false, canceled: true }) };
})();`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  if (filePath === "/fake-desktop-bridge.js") { res.writeHead(200, { "content-type": MIME[".js"] }); createReadStream(path.join(root, "scripts", "repro-deck", "fake-desktop-bridge.js")).pipe(res); return; }
  if (filePath === "/profiles-bridge.js") { res.writeHead(200, { "content-type": MIME[".js"] }); res.end(PROFILES); return; }
  const disk = path.join(distDir, decodeURIComponent(filePath));
  if (!disk.startsWith(distDir) || !existsSync(disk)) { res.writeHead(404).end("not found"); return; }
  if (filePath === "/index.html") {
    const html = await readFile(disk, "utf8");
    res.writeHead(200, { "content-type": MIME[".html"] });
    res.end(html.replace(/<script type="module"/, '<script src="./fake-desktop-bridge.js"></script>\n    <script src="./profiles-bridge.js"></script>\n    <script type="module"'));
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(disk)] ?? "application/octet-stream" });
  createReadStream(disk).pipe(res);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port, debugPort = 9363;
const edge = spawn(EDGE, ["--headless=new", "--disable-extensions", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(os.tmpdir(), `rhine-hover-${process.pid}`)}`, "--window-size=1920,1080", "about:blank"]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let target = null;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(300);
  try { target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(t => t.type === "page"); } catch { /* DevTools endpoint not up yet */ }
}
if (!target) throw new Error("Edge DevTools endpoint never came up");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 1;
const pending = new Map(), errors = [];
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); return; }
  if (message.method === "Runtime.exceptionThrown") errors.push(`exception: ${message.params.exceptionDetails.text} ${message.params.exceptionDetails.exception?.description ?? ""}`);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++, timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30000);
  pending.set(id, message => { clearTimeout(timer); message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result); });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(`evaluate failed: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ""}`);
  return result.result?.value;
};
const checks = {};
const check = (name, ok, detail = "") => { checks[name] = Boolean(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const hovers = [];

try {
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem('rhine-ssh-overview-collapsed', '0'); localStorage.setItem('rhine-settings', JSON.stringify({...JSON.parse(localStorage.getItem('rhine-settings') || '{}'), design: 'label'}));` });
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/?scene=archive` });
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline && !(await evaluate(`window.rhine?.stats().ready && document.querySelectorAll('.ssh-overview-host').length === ${HOSTS}`))) await sleep(150);
  await send("Page.bringToFront");
  await sleep(2500);
  check("the label design's overview is up", await evaluate(`document.querySelector('#stage').dataset.design === 'label' && document.querySelectorAll('.ssh-overview-host').length === ${HOSTS}`));
  // Every frame: when, how long since the last, the row printed in reverse, the selected archive.
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.ssh-overview-host')];
    window.__log = [];
    let last = performance.now();
    const frame = now => { window.__log.push([Math.round(now), +(now - last).toFixed(1), rows.findIndex(row => row.dataset.focus === 'true'), rhine.stats().selectedIndex]); last = now; requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  })()`);
  const moveTo = async row => {
    const box = await evaluate(`(() => { const r = document.querySelectorAll('.ssh-overview-host')[${row}].getBoundingClientRect(); return { x: Math.round(r.x + r.width * .4), y: Math.round(r.y + r.height / 2) }; })()`);
    hovers.push({ row, at: Math.round(await evaluate("performance.now()")) });
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    await sleep(DWELL);
  };
  for (const row of [0, 1, 2, 3, 2, 1]) await moveTo(row);
  const log = await evaluate("window.__log");
  for (const [k, hover] of hovers.entries()) {
    const span = log.filter(f => f[0] >= hover.at && f[0] < hover.at + DWELL - 60);
    const reached = span.find(f => f[2] === hover.row), left = reached && span.find(f => f[0] > reached[0] && f[2] !== hover.row);
    const before = log.filter(f => f[0] < hover.at).at(-1)?.[3], followed = span.find(f => f[3] !== before);
    Object.assign(hover, { focusAfter: reached ? reached[0] - hover.at : null, leftAfter: left ? left[0] - hover.at : null, leftFor: left ? left[2] : null,
      archiveAfter: followed ? followed[0] - hover.at : null, worstFrame: Math.max(0, ...span.map(f => f[1])) });
    console.log(`hover ${k + 1} on row ${hover.row}: reverse print after ${hover.focusAfter ?? "—"} ms${left ? `, LEFT for row ${hover.leftFor} after ${hover.leftAfter} ms` : ", stays"}; archive follows after ${hover.archiveAfter ?? "—"} ms; worst frame ${hover.worstFrame.toFixed(0)} ms`);
  }
  // The first hover may land on the row that is already selected: its archive has nowhere to go.
  const moved = hovers.slice(1);
  check("the reverse print reaches the hovered row at once", hovers.every(h => h.focusAfter !== null && h.focusAfter <= 60), `${Math.max(...hovers.map(h => h.focusAfter ?? 9999))} ms at worst`);
  check("it stays on that row while the hand rests there", hovers.every(h => h.leftAfter === null), hovers.filter(h => h.leftAfter !== null).map(h => `row ${h.row} left for row ${h.leftFor} after ${h.leftAfter} ms`).join("; "));
  check("the archive follows within a fifth of a second", moved.every(h => h.archiveAfter !== null && h.archiveAfter <= 200), `${Math.max(...moved.map(h => h.archiveAfter ?? 9999))} ms at worst`);
  const frames = log.slice(5).map(f => f[1]).sort((a, b) => a - b), q = v => frames[Math.floor((frames.length - 1) * v)];
  console.log(`frames: p50 ${q(.5)} ms, p95 ${q(.95)} ms, p99 ${q(.99)} ms, worst ${frames.at(-1)} ms`);
} catch (driverError) {
  console.log("\n=== driver error ===");
  console.log(String(driverError));
  checks["driver completed"] = false;
} finally {
  await writeFile(path.join(outDir, "report.json"), JSON.stringify({ checks, hovers, errors }, null, 2));
  if (errors.length) console.log("errors:\n" + errors.join("\n"));
  ws.close();
  edge.kill();
  server.close();
  process.exitCode = Object.values(checks).every(Boolean) && !errors.length ? 0 : 1;
}
