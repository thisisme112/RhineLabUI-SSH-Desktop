// The frame gate in the real page: an untouched archive idles, input lifts it, and it settles again.
// Drives Edge over the DevTools protocol, as check-inspection-performance.mjs does.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

const port = 5199, debugPort = 9611;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const edge = process.env.EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const profile = await mkdtemp(path.join(os.tmpdir(), "rhine-frame-budget-"));
const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { stdio: "ignore", windowsHide: true });
let browser, ws;
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break; } catch {} await sleep(250); }
  browser = spawn(edge, ["--headless=new", "--disable-extensions", "--no-first-run", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "--window-size=1600,900", "about:blank"], { stdio: "ignore", windowsHide: true });
  let target;
  for (let i = 0; i < 60 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((t) => t.type === "page"); } catch {} await sleep(200); }
  if (!target) throw Error("Browser unavailable");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => (ws.onopen = resolve));
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
    else if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? "exception");
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id;
    const timer = setTimeout(() => reject(Error(method + " timeout")), 60000);
    pending.set(next, (msg) => { clearTimeout(timer); msg.error ? reject(Error(msg.error.message)) : resolve(msg.result); });
    ws.send(JSON.stringify({ id: next, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  const ready = async () => { for (let i = 0; i < 240; i++) { if (await evaluate("!!window.rhine?.stats().ready").catch(() => false)) return; await sleep(250); } throw Error("page never became ready"); };
  const budget = () => evaluate("window.rhine.stats().budget");
  // Frames the page asked for in `ms`, split into admitted and skipped by the gate.
  const measure = async (ms) => {
    const a = await budget();
    await sleep(ms);
    const b = await budget();
    const admitted = b.admitted - a.admitted, skipped = b.skipped - a.skipped;
    return { admitted, skipped, share: admitted / Math.max(1, admitted + skipped), tier: b.tier, refreshMs: b.refreshMs };
  };
  const mouse = (x, y) => send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });

  const base = `http://127.0.0.1:${port}/?scene=archive`;
  await send("Page.navigate", { url: base + "&frame-budget" });
  await ready();
  await sleep(6000); // the opening settles and the input hold expires
  const idle = await measure(4000);
  await mouse(800, 450);
  await mouse(820, 470);
  await sleep(150);
  const afterInput = await budget();
  const busy = await measure(1200);
  await sleep(4000);
  const settled = await measure(3000);
  await evaluate("window.rhine.select(7)");
  await sleep(200);
  const afterSelect = await budget();

  // Control: the same page without the gate lets every frame through.
  await send("Page.navigate", { url: base + "&no-frame-budget" });
  await ready();
  await sleep(1500);
  const gateOff = await budget();

  const report = { idle, afterInput, busy, settled, afterSelect, gateOff, errors };
  await mkdir("verification/frame-budget", { recursive: true });
  await writeFile("verification/frame-budget/report.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));

  assert.equal(gateOff, null, "?no-frame-budget removes the gate");
  // A display that cannot deliver 60 frames (software GL) leaves the gate nothing to hold back.
  const fastEnough = idle.admitted + idle.skipped >= 4 * 50;
  if (fastEnough) {
    assert.ok(idle.share < 0.62, `idle should admit about half the frames, admitted ${(idle.share * 100).toFixed(0)}%`);
    assert.equal(idle.tier, "idle");
    assert.ok(busy.share > 0.85, `input should lift the rate to the display's, admitted ${(busy.share * 100).toFixed(0)}%`);
    assert.ok(settled.share < 0.62, "the rate settles again after input");
  } else console.log("display too slow to judge the idle share; tier transitions only");
  assert.equal(afterInput.tier, "busy", "input reports busy at once");
  assert.ok(["busy", "active"].includes(afterSelect.tier), "a selection lifts the rate");
  assert.deepEqual(errors, []);
} finally {
  ws?.close();
  browser?.kill();
  vite.kill();
}
