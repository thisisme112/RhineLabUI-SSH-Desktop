// Screenshots the Android renderer (dist-android) at phone sizes, portrait and landscape, with a stand-in for
// the Capacitor native bridge: the layout, type size and touch-target checks run without a device.
//   node scripts/capture-phone-layout.mjs [--out verification/android-phone] [--check]
// `--check` also asserts touch targets and readable type on each screen (used by check:android-layout).
import http from "node:http";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

const root = process.cwd(), dist = path.join(root, "dist-android");
const outFlag = process.argv.indexOf("--out");
const out = path.resolve(root, outFlag >= 0 ? process.argv[outFlag + 1] : "verification/android-phone");
const checking = process.argv.includes("--check");
await mkdir(out, { recursive: true });
if (!existsSync(path.join(dist, "index.html"))) throw new Error("dist-android is missing: run `npm run build:android` first");

// What the Android shell provides to the page, reduced to answers a layout review needs.
const nativeBridge = `(() => {
  const methods = (...names) => names.map(name => ({ name, rtype: name === "addListener" ? "callback" : "promise" }));
  window.androidBridge = { postMessage() {} };
  window.Capacitor = {
    PluginHeaders: [
      { name: "SshSession", methods: methods("start", "resolve", "send", "stop", "keyboard", "hideKeyboard", "background", "backgroundStatus", "addListener", "removeListener") },
      { name: "SshVault", methods: methods("available", "get", "put", "remove") },
      { name: "SshDocuments", methods: methods("pickKey", "pickFiles", "downloadTarget", "publish", "cleanup", "exportText", "readClipboard", "writeClipboard") },
      { name: "App", methods: methods("addListener", "removeListener", "minimizeApp", "exitApp") },
      { name: "StatusBar", methods: methods("setOverlaysWebView", "setStyle", "setBackgroundColor") },
    ],
    nativePromise(plugin, method) {
      if (plugin === "SshVault") return Promise.resolve(method === "available" ? { available: true } : {});
      if (plugin === "SshSession" && (method === "background" || method === "backgroundStatus")) return Promise.resolve({ enabled: false, notificationGranted: true });
      if (plugin === "SshSession" && method === "start") return Promise.reject(new Error("no device"));
      if (plugin === "SshDocuments" && method === "readClipboard") return Promise.resolve({ text: "" });
      return Promise.resolve({});
    },
    nativeCallback() { return Promise.resolve("listener-" + Math.random().toString(36).slice(2)); },
  };
  const hosts = [
    ["h1", "生产 · 网关", "gateway.example.com", 22, "ops"], ["h2", "训练集群 A100", "10.20.0.12", 2222, "root"],
    ["h3", "备份仓库", "backup.example.net", 22, "backup"], ["h4", "开发机", "dev.example.org", 22, "lab"],
    ["h5", "监控节点", "10.20.0.30", 22, "monitor"], ["h6", "跳板机", "jump.example.com", 22, "jump"],
  ].map(([id, name, host, port, user]) => ({ id, name, host, port, user, method: "password" }));
  localStorage.setItem("rhine-android-ssh-v1", JSON.stringify({ version: 1, hosts, known: [] }));
  localStorage.setItem("rhine-settings", JSON.stringify({ sound: false, music: false, reduced: false }));
})();`;

const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".glb": "model/gltf-binary", ".svg": "image/svg+xml", ".ogg": "audio/ogg", ".json": "application/json", ".png": "image/png" };
const requested = [];
const androidCss = (await import("node:fs")).readdirSync(path.join(dist, "assets")).find((name) => /^android-.*\.css$/.test(name));
const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (/android|native-stub/.test(pathname)) requested.push(pathname);
  if (pathname === "/native-stub.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(nativeBridge); return; }
  const file = path.resolve(dist, "." + (pathname === "/" ? "/index.html" : pathname));
  if (!file.startsWith(dist + path.sep) || !existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": `${mime[path.extname(file)] ?? "application/octet-stream"}; charset=utf-8` });
  if (file.endsWith("index.html")) res.end((await readFile(file, "utf8")).replace(/<script[^>]*type="module"/, (m) => `<script src="/native-stub.js"></script>${m}`));
  else createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port, debugPort = 9700 + (process.pid % 200);
const profile = await mkdtemp(path.join(os.tmpdir(), "rhine-phone-"));
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
  const pending = new Map();
  const errors = [], consoleLog = [];
  ws.onmessage = (event) => {
    const m = JSON.parse(event.data);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
    else if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    else if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type)) consoleLog.push(m.params.type + ": " + m.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 200));
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

  // Touch targets under 40 CSS px and text under 11 px are what a thumb and a 560 dpi panel punish.
  const audit = (screen, viewport) => evaluate(`(() => {
    const visible = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > .05 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && !e.closest('[hidden],[inert]'); };
    const label = (e) => (e.getAttribute('aria-label') || e.textContent || e.className || e.tagName).toString().trim().replace(/\\s+/g, ' ').slice(0, 24);
    const small = [], tiny = [];
    for (const e of document.querySelectorAll('button, [role=button], a[href], input:not([type=hidden]), select, textarea')) {
      if (!visible(e)) continue;
      const r = e.getBoundingClientRect();
      if (Math.min(r.width, r.height) < 36 && r.width * r.height < 40 * 40) small.push([label(e), Math.round(r.width), Math.round(r.height)]);
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent.trim(); if (!text || !n.parentElement || !visible(n.parentElement)) continue;
      const scale = +getComputedStyle(document.querySelector('#stage')).getPropertyValue('--stage-scale') || 1;
      const size = parseFloat(getComputedStyle(n.parentElement).fontSize) * (n.parentElement.closest('#stage') ? scale : 1);
      if (size < 10.5 && !seen.has(text.slice(0, 20))) { seen.add(text.slice(0, 20)); tiny.push([text.slice(0, 20), Math.round(size * 10) / 10]); }
    }
    return { small: small.slice(0, 12), smallCount: small.length, tiny: tiny.slice(0, 12), tinyCount: tiny.length, overflowX: document.documentElement.scrollWidth > innerWidth + 1, headingClipped: (() => { const a = document.querySelector('.ssh-overview-heading-actions'); if (!a) return false; return [...a.children].some(b => { const r = b.getBoundingClientRect(); return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1); }); })(), nativeShell: document.documentElement.dataset.nativeShell ?? null, startup: window.rhine.stats().startup, mode: window.rhine.stats().mode, toast: document.querySelector('#toast')?.textContent ?? null, cssLinks: [...document.querySelectorAll('link[rel=stylesheet]')].map(l => l.href.split('/').pop()).join(','), cap: [window.Capacitor?.getPlatform?.(), window.Capacitor?.isNativePlatform?.(), !!window.androidBridge, document.querySelector('meta[name=rhine-host]')?.content], layout: document.querySelector('#stage')?.dataset.layout ?? null, columnsDisplay: (document.querySelector('.ssh-overview-columns') ? getComputedStyle(document.querySelector('.ssh-overview-columns')).display : null), innerWidth };
  })()`).then((r) => { report.push({ screen, viewport, ...r }); return r; });

  const viewports = [
    { name: "portrait", width: 360, height: 800 },
    { name: "landscape", width: 800, height: 360 },
  ];
  const screens = [
    ["home", `1`],
    ["overview", `(window.rhineSshUi && document.querySelector('.ssh-overview')) ? 1 : 1`],
    ["host-editor", `document.querySelector('.ssh-overview [data-overview-action="host-add"], .ssh-overview [data-action="add-host"], .ssh-overview-add')?.click(), 1`],
    ["settings", `rhine.settings(), 1`],
  ];
  for (const viewport of viewports) {
    await send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 3, mobile: true, screenOrientation: { type: viewport.width > viewport.height ? "landscapePrimary" : "portraitPrimary", angle: 0 } });
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/?scene=archive` });
    for (let i = 0; i < 160 && !(await evaluate("!!window.rhine?.stats().ready").catch(() => false)); i++) await sleep(250);
    await sleep(2500);
    // initNativeShell (src/native.ts) sets this attribute and loads android.css once the Capacitor
    // platform answers; the stand-in bridge does the same here so the phone rules apply.
    await evaluate(`(() => { document.documentElement.dataset.nativeShell = "true"; if (!document.querySelector("link[data-phone-css]")) { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "/assets/${androidCss}"; l.dataset.phoneCss = ""; document.head.append(l); } })()`);
    await sleep(600);
    for (const [name, action] of screens) {
      await evaluate(action).catch(() => {});
      await sleep(1600);
      await shot(`${viewport.name}-${name}`);
      await audit(name, viewport.name);
      if (name === "settings") await evaluate(`document.querySelector('[data-action="close-modal"]')?.click()`).catch(() => {});
    }
  }
  await writeFile(path.join(out, "report.json"), JSON.stringify({ report, errors }, null, 2));
  for (const r of report) console.log(`${r.viewport}/${r.screen}: ${r.smallCount} small targets, ${r.tinyCount} tiny texts${r.overflowX ? ", HORIZONTAL OVERFLOW" : ""} [startup=${r.startup} mode=${r.mode} toast=${JSON.stringify(r.toast)} css=${r.cssLinks} cap=${JSON.stringify(r.cap)} shell=${r.nativeShell} layout=${r.layout} columns=${r.columnsDisplay} w=${r.innerWidth}]`);
  console.log("requested:", [...new Set(requested)].join(", "));
  if (consoleLog.length) console.log("console:", [...new Set(consoleLog)].slice(0, 6).join(" | "));
  if (errors.length) { console.log("page errors:", errors.slice(0, 3)); problems.push("page errors"); }
  if (checking) for (const r of report) {
    if (r.overflowX) problems.push(`${r.viewport}/${r.screen} scrolls sideways`);
    if (["home", "overview"].includes(r.screen) && r.smallCount > 0) problems.push(`${r.viewport}/${r.screen} has ${r.smallCount} touch targets under 36 px: ${JSON.stringify(r.small.slice(0, 4))}`);
    if (["home", "overview"].includes(r.screen) && r.headingClipped) problems.push(`${r.viewport}/${r.screen}: the overview actions run off the screen`);
  }
} finally {
  ws?.close(); browser.kill(); server.close();
}
if (problems.length) { console.error(problems.join("\n")); process.exitCode = 1; }
