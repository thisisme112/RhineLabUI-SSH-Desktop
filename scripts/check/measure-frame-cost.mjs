import { artifactPath } from "../lib/artifacts.mjs";
/**
 * What the real page costs per second, so a performance change can be judged
 * by numbers instead of by eye. Nothing is asserted: the report is the result.
 *
 *   node scripts/check/measure-frame-cost.mjs [--build dist-desktop] [--build <copy of an older build>] [--rounds 3] [--shots]
 *
 * Each --build is a built bundle (dist, dist-desktop, or a copy of one kept for
 * comparison). Builds are measured in turn, A B A B ..., so drift on this
 * machine lands on both sides; compare medians, and only trust a difference
 * larger than the spread between rounds of the same build. A desktop bundle
 * gets the same fake bridge as capture-web-reference.mjs.
 */
import http from "node:http";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

const root = process.cwd();
const args = process.argv.slice(2);
const values = (name) => args.flatMap((arg, i) => (arg === name && args[i + 1] ? [args[i + 1]] : []));
const value = (name, fallback) => values(name)[0] ?? fallback;
const builds = (values("--build").length ? values("--build") : ["dist-desktop"]).map((dir) => path.resolve(root, dir));
const rounds = Number(value("--rounds", "1"));
const width = Number(value("--width", "1600")), height = Number(value("--height", "900"));
const idleMs = Number(value("--idle-ms", "10000")), busyMs = Number(value("--busy-ms", "6000"));
const shots = args.includes("--shots");
const out = path.resolve(root, value("--out", artifactPath("frame-cost")));
const edge = process.env.EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (const build of builds) if (!existsSync(path.join(build, "index.html"))) throw new Error(`${build} has no index.html: build it first`);
await mkdir(out, { recursive: true });

const mime = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".glb": "model/gltf-binary",
  ".svg": "image/svg+xml", ".ogg": "audio/ogg", ".json": "application/json", ".png": "image/png", ".webp": "image/webp",
  ".hdr": "application/octet-stream", ".webmanifest": "application/manifest+json",
};
function serve(dist) {
  const server = http.createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (pathname === "/fixture.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      createReadStream(path.join(root, "scripts/fixtures/terminal-deck-bridge.js")).pipe(res);
      return;
    }
    const file = path.resolve(dist, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(dist + path.sep) || !existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": `${mime[path.extname(file)] ?? "application/octet-stream"}; charset=utf-8` });
    if (!file.endsWith("index.html")) { createReadStream(file).pipe(res); return; }
    const html = await readFile(file, "utf8");
    // Only the desktop bundle expects a native bridge (vite.config.ts "desktop-index" marks it).
    res.end(/name="rhine-host" content="desktop"/.test(html) ? html.replace('<script type="module"', '<script src="/fixture.js"></script><script type="module"') : html);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/**
 * Mean 3D-engine utilisation of this browser over `seconds`, from the Windows
 * GPU counters. Only the browser process and its descendants count, so
 * whatever else the machine is drawing stays out of the number.
 */
function gpuUtilization(browserPid, seconds) {
  const script = `
$all = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Select-Object ProcessId, ParentProcessId)
$ids = New-Object 'System.Collections.Generic.HashSet[int]'; [void]$ids.Add(${browserPid})
do { $added = $false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added = $true } } } while ($added)
$sums = foreach ($s in (Get-Counter -Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -SampleInterval 1 -MaxSamples ${seconds} -ErrorAction SilentlyContinue)) {
  $sum = 0.0; foreach ($c in $s.CounterSamples) { if ($c.InstanceName -match '^pid_(\\d+)_' -and $ids.Contains([int]$Matches[1])) { $sum += $c.CookedValue } }; $sum }
if ($sums) { ($sums | Measure-Object -Average).Average } else { 'null' }`;
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    let text = "";
    child.stdout.on("data", (chunk) => (text += chunk));
    child.on("close", () => { const n = Number.parseFloat(text.trim()); resolve(Number.isFinite(n) ? n : null); });
    child.on("error", () => resolve(null));
  });
}

async function measureRun(dist, label, round) {
  const server = await serve(dist);
  const port = server.address().port, debugPort = 9300 + Math.floor(Math.random() * 400);
  const profile = await mkdtemp(path.join(os.tmpdir(), "rhine-frame-cost-"));
  const browser = spawn(edge, ["--headless=new", "--disable-extensions", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist",
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
  let ws;
  const errors = [];
  try {
    let target;
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(200);
      try { target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((t) => t.type === "page"); } catch {}
    }
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
      const id = ++sequence;
      const timeout = setTimeout(() => reject(new Error(`${method} timeout`)), 60000);
      pending.set(id, (message) => { clearTimeout(timeout); message.error ? reject(new Error(message.error.message)) : resolve(message.result); });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    const until = async (name, expression, timeout = 90000) => {
      for (const end = Date.now() + timeout; Date.now() < end; await sleep(200)) if (await evaluate(expression).catch(() => false)) return;
      throw new Error(`Timed out: ${name}`);
    };
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Performance.enable");
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: "localStorage.setItem('rhine-settings', JSON.stringify({sound:false,music:false,reduced:false,colorTheme:'light'}));",
    });

    const sample = async () => ({
      at: performance.now(),
      stats: await evaluate(`(() => { const s = window.rhine.stats(); return { budget: s.budget, fps: s.fps, drawCalls: s.drawCalls, triangles: s.triangles,
        rendered: window.rhineSshUi?.rendering?.frames ?? null, composed: s.composedFrames ?? null }; })()`),
      metrics: Object.fromEntries((await send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value])),
    });
    const measure = async (ms, during, name) => {
      if (shots && name) {
        const { data } = await send("Page.captureScreenshot", { format: "png" });
        await writeFile(path.join(out, `${label.replace(/[^\w.-]+/g, "_")}-r${round}-${name}.png`), Buffer.from(data, "base64"));
      }
      const gpu = gpuUtilization(browser.pid, Math.max(1, Math.round(ms / 1000)));
      const a = await sample();
      await Promise.all([sleep(ms), during?.(ms)]);
      const b = await sample();
      const seconds = (b.at - a.at) / 1000;
      const rate = (pick) => { const x = pick(a), y = pick(b); return x == null || y == null ? null : (y - x) / seconds; };
      const metric = (name) => (b.metrics[name] - a.metrics[name]) / seconds;
      return {
        seconds,
        tier: b.stats.budget?.tier ?? null,
        admitted: rate((s) => s.stats.budget?.admitted),
        rendered: rate((s) => s.stats.rendered),
        composed: rate((s) => s.stats.composed),
        taskMs: metric("TaskDuration") * 1000,
        scriptMs: metric("ScriptDuration") * 1000,
        styleMs: metric("RecalcStyleDuration") * 1000,
        layoutMs: metric("LayoutDuration") * 1000,
        styleRecalcs: metric("RecalcStyleCount"),
        layouts: metric("LayoutCount"),
        heapMB: b.metrics.JSHeapUsedSize / 2 ** 20,
        drawCalls: b.stats.drawCalls ?? null,
        triangles: b.stats.triangles ?? null,
        gpu: await gpu,
      };
    };
    // A slow circle over the array: the pointer is what lifts the rate to busy.
    const wiggle = async (ms) => {
      for (let t = 0, end = Date.now() + ms; Date.now() < end; t += 0.06) {
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: width / 2 + Math.cos(t) * 140, y: height / 2 + Math.sin(t) * 90 });
        await sleep(16);
      }
    };

    const open = async () => {
      await send("Page.navigate", { url: `http://127.0.0.1:${port}/?scene=archive&frame-budget` });
      await until("scene ready", "window.rhine?.stats().ready && window.rhine.stats().mode === 'archive'");
      await sleep(6000); // the opening settles and any input hold expires
    };
    const scenarios = {};
    // The bare array: a stowed host overview is a stored preference (overview.ts COLLAPSED_KEY).
    const stowed = await send("Page.addScriptToEvaluateOnNewDocument", { source: "localStorage.setItem('rhine-ssh-overview-collapsed', '1');" });
    await open();
    scenarios["archive-idle"] = await measure(idleMs, undefined, "archive-idle");
    scenarios["archive-busy"] = await measure(busyMs, wiggle, "archive-busy");
    // Where a desktop or demo build lands: the host overview over the array.
    if (await evaluate(`!!document.querySelector('[data-action="ssh-hosts"]')`)) {
      await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: stowed.identifier });
      await send("Page.addScriptToEvaluateOnNewDocument", { source: "localStorage.setItem('rhine-ssh-overview-collapsed', '0');" });
      await open();
      scenarios["overview-idle"] = await measure(idleMs, undefined, "overview-idle");
    }
    const result = { build: label, round, scenarios, errors };
    console.log(`${label} round ${round}: ${Object.entries(scenarios).map(([name, s]) =>
      `${name} admitted ${s.admitted?.toFixed(1)}/s task ${s.taskMs.toFixed(0)}ms/s gpu ${s.gpu?.toFixed(1) ?? "?"}%`).join(" | ")}`);
    return result;
  } finally {
    if (ws?.readyState === WebSocket.OPEN) ws.close();
    browser.kill();
    server.close();
  }
}

const labels = builds.map((build) => path.relative(root, build) || ".");
const runs = [];
for (let round = 1; round <= rounds; round++)
  for (const [index, build] of builds.entries()) runs.push(await measureRun(build, labels[index], round));

const median = (list) => { const s = [...list].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const keys = ["admitted", "rendered", "composed", "taskMs", "scriptMs", "styleMs", "layoutMs", "styleRecalcs", "layouts", "heapMB", "gpu"];
const summary = {};
for (const run of runs)
  for (const [scenario, s] of Object.entries(run.scenarios))
    for (const key of keys) {
      if (s[key] == null) continue;
      ((summary[scenario] ??= {})[run.build] ??= {})[key] ??= [];
      summary[scenario][run.build][key].push(s[key]);
    }
for (const scenario of Object.values(summary))
  for (const [build, byKey] of Object.entries(scenario))
    scenario[build] = Object.fromEntries(Object.entries(byKey).map(([key, list]) => [key, { median: median(list), min: Math.min(...list), max: Math.max(...list) }]));

await writeFile(path.join(out, "report.json"), JSON.stringify({ width, height, idleMs, busyMs, rounds, builds: labels, summary, runs }, null, 2));
for (const [scenario, byBuild] of Object.entries(summary)) {
  console.log(`\n${scenario}`);
  for (const [build, byKey] of Object.entries(byBuild))
    console.log(`  ${build.padEnd(36)} ${Object.entries(byKey).map(([key, v]) =>
      `${key} ${v.median.toFixed(1)}${rounds > 1 ? ` [${v.min.toFixed(1)}–${v.max.toFixed(1)}]` : ""}`).join("  ")}`);
}
console.log(`\nreport: ${path.relative(root, path.join(out, "report.json"))}`);
