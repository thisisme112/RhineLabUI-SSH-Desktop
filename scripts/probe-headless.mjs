/** Quick probe: does RAF tick and WebGL exist in headless Edge here? */
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const EDGE =
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const debugPort = 9334;
const profile = path.join(os.tmpdir(), `rhine-probe-${process.pid}`);
const args = process.argv.includes("--swiftshader")
  ? ["--use-gl=angle", "--use-angle=swiftshader"]
  : ["--disable-gpu"];
const edge = spawn(EDGE, [
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profile}`,
  "--headless=new",
  ...args,
  "about:blank",
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target = null;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(300);
  try {
    const list = await (
      await fetch(`http://127.0.0.1:${debugPort}/json/list`)
    ).json();
    target = list.find((t) => t.type === "page");
  } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 1;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const i = id++;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expression) =>
  (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))
    .result?.result?.value;

console.log(
  await evaluate(`(async () => {
    const raf = await new Promise((resolve) => {
      let n = 0;
      const t0 = performance.now();
      const tick = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(tick); else resolve(n); };
      requestAnimationFrame(tick);
      setTimeout(() => resolve(-n), 2500);
    });
    let webgl = false;
    try {
      const c = document.createElement("canvas");
      webgl = Boolean(c.getContext("webgl2") || c.getContext("webgl"));
    } catch {}
    return JSON.stringify({
      visibility: document.visibilityState,
      hidden: document.hidden,
      rafPerSecond: raf,
      webgl,
    });
  })()`),
);
edge.kill();
process.exit(0);
