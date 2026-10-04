import { artifactPath } from "../lib/artifacts.mjs";
// Screenshots the Android renderer's terminal workspace (dist-android) at a phone's size, upright and on its side,
// with a stand-in for the native SSH agent that answers a connection at once: how many rows and columns the
// terminal keeps, and how much of the screen the bars round it take, without a device.
//   node scripts/capture/capture-phone-terminal.mjs [--out .artifacts/checks/android-terminal-layout] [--check]
// `--check` asserts the terminal keeps most of the screen and nothing runs off its right edge.
import http from "node:http";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { existsSync, createReadStream, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

const root = process.cwd(), dist = path.join(root, "dist-android");
const outFlag = process.argv.indexOf("--out");
const out = path.resolve(root, outFlag >= 0 ? process.argv[outFlag + 1] : artifactPath("android-terminal-layout"));
const checking = process.argv.includes("--check");
await mkdir(out, { recursive: true });
if (!existsSync(path.join(dist, "index.html"))) throw new Error("dist-android is missing: run `npm run build:android` first");

// The Android shell as the page sees it. The SSH agent accepts any connection and prints a screen of text.
const nativeBridge = `(() => {
  const methods = (...names) => names.map(name => ({ name, rtype: name === "addListener" ? "callback" : "promise" }));
  const listeners = { line: new Set(), closed: new Set() };
  const say = (id, message) => setTimeout(() => { for (const fn of listeners.line) fn({ id, line: JSON.stringify(message) }); }, 0);
  const b64 = (text) => { let s = ""; for (const b of new TextEncoder().encode(text)) s += String.fromCharCode(b); return btoa(s); };
  const screenful = () => {
    const ruler = Array.from({ length: 16 }, (_, i) => String((i + 1) * 10).padStart(10, ".")).join("");
    const lines = ["Rhine Lab layout fixture", ruler];
    for (let i = 3; i <= 60; i++) lines.push("row " + String(i).padStart(2, "0") + "  drwxr-xr-x  4 operator operator  4096 Oct  4 20:" + String(i % 60).padStart(2, "0") + " experiment-" + i);
    return lines.join("\\r\\n") + "\\r\\noperator@fixture:~$ ";
  };
  let pipes = 0;
  window.__agent = { sizes: [], calls: [] };
  window.androidBridge = { postMessage() {} };
  window.Capacitor = {
    PluginHeaders: [
      { name: "SshSession", methods: methods("start", "resolve", "send", "stop", "keyboard", "hideKeyboard", "background", "backgroundStatus", "addListener", "removeListener") },
      { name: "SshVault", methods: methods("available", "get", "put", "remove") },
      { name: "SshDocuments", methods: methods("pickKey", "pickFiles", "downloadTarget", "publish", "cleanup", "exportText", "readClipboard", "writeClipboard") },
      { name: "App", methods: methods("addListener", "removeListener", "minimizeApp", "exitApp") },
      { name: "StatusBar", methods: methods("setOverlaysWebView", "setStyle", "setBackgroundColor", "show", "hide") },
    ],
    nativePromise(plugin, method, options) {
      window.__agent.calls.push(plugin + "." + method);
      if (plugin === "SshVault") return Promise.resolve(method === "available" ? { available: true } : {});
      if (plugin === "SshSession" && (method === "background" || method === "backgroundStatus")) return Promise.resolve({ enabled: false, notificationGranted: true });
      if (plugin === "SshSession" && method === "start") return Promise.resolve({ ok: true, id: "pipe-" + (++pipes), abi: "fixture" });
      if (plugin === "SshSession" && method === "resolve") return Promise.resolve({ addresses: ["10.20.0.12"] });
      if (plugin === "SshSession" && method === "send") {
        const request = JSON.parse(options.line), id = options.id;
        if (request.method === "connect") {
          say(id, { id: request.id, ok: true });
          for (const phase of ["connecting", "handshake", "authenticating", "opening", "interactive"]) say(id, { event: "phase", phase, detail: "fixture" });
          setTimeout(() => say(id, { event: "data", data: b64(screenful()) }), 400);
        } else if (request.method === "resize") { window.__agent.sizes.push([request.params.cols, request.params.rows]); say(id, { id: request.id, ok: true }); }
        else if (request.method === "rpc") say(id, { id: request.id, ok: false, error: "fixture: no services" });
        else say(id, { id: request.id, ok: true });
        return Promise.resolve({});
      }
      if (plugin === "SshDocuments" && method === "readClipboard") return Promise.resolve({ text: "" });
      return Promise.resolve({});
    },
    nativeCallback(plugin, method, options, callback) {
      if (plugin === "SshSession" && listeners[options?.eventName]) listeners[options.eventName].add(callback);
      return Promise.resolve("listener-" + Math.random().toString(36).slice(2));
    },
  };
  const hosts = [
    ["h1", "生产 · 网关", "gateway.example.com", 22, "ops"], ["h2", "训练集群 A100", "10.20.0.12", 2222, "root"],
    ["h3", "备份仓库", "backup.example.net", 22, "backup"],
  ].map(([id, name, host, port, user]) => ({ id, name, host, port, user, method: "password" }));
  localStorage.setItem("rhine-android-ssh-v1", JSON.stringify({ version: 1, hosts, known: [] }));
  localStorage.setItem("rhine-settings", JSON.stringify({ sound: false, music: false, reduced: true }));
})();`;

const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".glb": "model/gltf-binary", ".svg": "image/svg+xml", ".ogg": "audio/ogg", ".json": "application/json", ".png": "image/png" };
const androidCss = readdirSync(path.join(dist, "assets")).find((name) => /^android-.*\.css$/.test(name));
const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (pathname === "/native-stub.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(nativeBridge); return; }
  const file = path.resolve(dist, "." + (pathname === "/" ? "/index.html" : pathname));
  if (!file.startsWith(dist + path.sep) || !existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": `${mime[path.extname(file)] ?? "application/octet-stream"}; charset=utf-8` });
  if (file.endsWith("index.html")) res.end((await readFile(file, "utf8")).replace(/<script[^>]*type="module"/, (m) => `<script src="/native-stub.js"></script>${m}`));
  else createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port, debugPort = 9900 + (process.pid % 90);
const profile = await mkdtemp(path.join(os.tmpdir(), "rhine-phone-terminal-"));
const edge = process.env.EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const browser = spawn(edge, ["--headless=new", "--no-first-run", "--disable-extensions", "--hide-scrollbars", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const problems = [], report = [];
let ws;
try {
  let target;
  for (let i = 0; i < 60 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((t) => t.type === "page"); } catch {} }
  if (!target) throw new Error("Browser did not start");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => (ws.onopen = resolve));
  let next = 0;
  const pending = new Map(), errors = [];
  ws.onmessage = (event) => {
    const m = JSON.parse(event.data);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
    else if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, (m) => (m.error ? reject(Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); await writeFile(path.join(out, name + ".png"), Buffer.from(r.data, "base64")); };
  await send("Runtime.enable"); await send("Page.enable");
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });

  // What the terminal keeps: its grid, and every band round it with its height and how far right it reaches.
  const measure = () => evaluate(`(() => {
    const root = document.querySelector('.ssh-terminal'); if (!root) return null;
    const box = (e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
    const shown = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !e.closest('[hidden]'); };
    const bands = {};
    for (const sel of ['.ssh-terminal-bar', '.ssh-workspace-tabs', '.ssh-session-navigation', '.ssh-workspace-body', '.ssh-terminal-main', '.ssh-terminal-screen', '.ssh-workspace-side', '.ssh-terminal-foot', '.ssh-mobile-keys', '.ssh-terminal-status', '.xterm-screen']) {
      const e = root.querySelector(sel); if (e && shown(e)) bands[sel] = box(e);
    }
    const past = [];
    for (const e of root.querySelectorAll('*')) { if (!shown(e) || e.closest('.xterm, .ssh-mobile-keys, .ssh-session-tabs')) continue; const r = e.getBoundingClientRect(); if (r.right > innerWidth + 1 && r.left < innerWidth) past.push([(e.className || e.tagName).toString().slice(0, 40), Math.round(r.right)]); }
    const rows = root.querySelector('.xterm-rows');
    return { viewport: [innerWidth, innerHeight], root: box(root), page: root.dataset.workspacePage, workspace: root.dataset.workspace, design: document.querySelector('#viewport')?.dataset.design, bands, past: past.slice(0, 8),
      grid: window.__agent.sizes.at(-1) ?? null, rowsDrawn: rows ? rows.children.length : 0, fontSize: rows ? getComputedStyle(rows).fontSize : null, calls: [...new Set(window.__agent.calls)].join(',') };
  })()`);

  const viewports = [
    { name: "portrait", width: 360, height: 800 },
    { name: "landscape", width: 800, height: 360 },
  ];
  for (const viewport of viewports) {
    await send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 3, mobile: true, screenOrientation: { type: viewport.width > viewport.height ? "landscapePrimary" : "portraitPrimary", angle: 0 } });
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/?scene=archive` });
    for (let i = 0; i < 160 && !(await evaluate("!!window.rhine?.stats().ready").catch(() => false)); i++) await sleep(250);
    await sleep(2500);
    await evaluate(`(() => { document.documentElement.dataset.nativeShell = "true"; if (!document.querySelector("link[data-phone-css]")) { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "/assets/${androidCss}"; l.dataset.phoneCss = ""; document.head.append(l); } })()`);
    await sleep(600);
    await shot(`${viewport.name}-0-before`);
    // Open the first saved host from wherever the app offers it.
    const opened = await evaluate(`(() => { const b = document.querySelector('.ssh-overview-connect') ?? document.querySelector('[data-action="ssh-hosts"]'); if (!b) return 'no entry'; b.click(); return b.className || b.dataset.action; })()`);
    await sleep(1500);
    const view = () => evaluate(`(() => { const v = window.visualViewport, wide = []; for (const e of document.querySelectorAll('body *')) { const r = e.getBoundingClientRect(); if (r.width > 0 && r.right > innerWidth + 1 && getComputedStyle(e).visibility !== 'hidden') wide.push((e.id ? '#' + e.id : '.' + String(e.className).split(' ')[0]) + ':' + Math.round(r.left) + '-' + Math.round(r.right)); } return JSON.stringify({ inner: [innerWidth, innerHeight], visual: [v.width, v.height, v.scale], scroll: [document.documentElement.scrollWidth, document.body.scrollWidth], stage: document.querySelector('#stage')?.style.cssText, wide: wide.slice(0, 14) }); })()`);
    if (process.argv.includes("--probe")) console.log(viewport.name, "file page:", await view());
    // The row opens the host's file; its connect button starts the session.
    await shot(`${viewport.name}-0-file`);
    await evaluate(`(() => { const b = [...document.querySelectorAll('[data-action="ssh-connect"]')].find(e => e.getBoundingClientRect().width > 0) ?? document.querySelector('[data-action="ssh-connect"]'); b?.scrollIntoView({ block: "center" }); b?.click(); })()`);
    for (let i = 0; i < 60 && !(await evaluate(`(window.__agent.sizes.length > 0 && document.querySelector('.xterm-rows')?.children.length > 0)`).catch(() => false)); i++) await sleep(250);
    await sleep(2500);
    // The page chosen last is remembered: the terminal is asked for.
    await evaluate(`document.querySelector('.ssh-workspace-tabs [data-workspace-page="terminal"]')?.click()`);
    await sleep(1500);
    await shot(`${viewport.name}-1-terminal`);
    const terminal = await measure();
    if (process.argv.includes("--probe")) console.log(viewport.name, "terminal:", await view(), await evaluate(`document.querySelector('.ssh-terminal').style.cssText`));
    report.push({ orientation: viewport.name, screen: "terminal", opened, ...terminal });
    for (const page of ["files", "monitor"]) {
      await evaluate(`document.querySelector('.ssh-workspace-tabs [data-workspace-page="${page}"]')?.click()`);
      await sleep(1200);
      await shot(`${viewport.name}-2-${page}`);
      report.push({ orientation: viewport.name, screen: page, ...(await measure()) });
    }
  }
  await writeFile(path.join(out, "report.json"), JSON.stringify({ report, errors }, null, 2));
  for (const r of report) {
    const screen = r.bands?.[".ssh-terminal-screen"], h = r.viewport?.[1];
    console.log(`${r.orientation} ${r.viewport ? r.viewport.join("x") : "?"} ${r.screen}: opened=${r.opened} design=${r.design} workspace=${r.workspace} grid=${JSON.stringify(r.grid)} font=${r.fontSize} screen=${JSON.stringify(screen)}${screen && h ? ` (${Math.round(screen[3] / h * 100)}% of height)` : ""} past-right=${JSON.stringify(r.past)}`);
    if (r.bands) console.log("   " + Object.entries(r.bands).map(([k, v]) => `${k.replace(".ssh-", "")}=${v[2]}x${v[3]}@${v[0]},${v[1]}`).join("  "));
  }
  if (errors.length) { console.log("page errors:", errors.slice(0, 3)); problems.push("page errors"); }
  if (checking) for (const r of report) {
    if (!r.bands) { problems.push(`${r.orientation}/${r.screen}: the terminal did not open`); continue; }
    if (r.past.length) problems.push(`${r.viewport.join("x")}/${r.screen} runs off the right edge: ${JSON.stringify(r.past.slice(0, 3))}`);
    const screen = r.bands[".ssh-terminal-screen"];
    if (r.screen === "terminal" && (!screen || screen[3] < r.viewport[1] * 0.6)) problems.push(`${r.viewport.join("x")}: the terminal keeps ${screen ? screen[3] : 0} of ${r.viewport[1]} px`);
  }
} finally {
  ws?.close(); browser.kill(); server.close();
}
if (problems.length) { console.error(problems.join("\n")); process.exitCode = 1; }
