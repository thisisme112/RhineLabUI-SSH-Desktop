/**
 * The host overview's row buttons, driven in headless Edge against dist-desktop.
 *
 *   npm run build:desktop && npm run check:ssh-overview-actions
 *
 * 重连 / 断开 / 复制 / 删除 sit on each row. What is worth asserting is the behaviour a unit test
 * cannot see: the buttons appear when the row is hovered and the other rows step back, 复制 makes a
 * saved copy named 副本 (then 副本 2), 删除 asks twice and refuses a host that comes from the ssh
 * config, and 连接 starts a session and then reads 重连 with 断开 available.
 *
 * The desktop bridge is the review one plus an in-memory host-profile store, so saving and removing
 * are the real renderer code paths against a fake main process. Reports land in
 * verification/overview-actions/.
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
const outDir = path.join(root, "verification", "overview-actions");
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

/** The review bridge, then a profile store: one saved host beside the config's demo-box. */
const PROFILES = `(() => {
  const saved = [{ id: "p-1", name: "生产机", hostname: "10.0.0.5", user: "ops", port: 22 }];
  let revision = 1, serial = 1;
  const config = window.rhineDesktop.hosts;
  window.rhineDesktop.hosts = async () => {
    const base = await config();
    return { ...base, revision: String(revision), hosts: [
      ...base.hosts.map(host => ({ ...host, source: "config" })),
      ...saved.map(profile => ({ alias: "rhine-profile:" + profile.id, displayName: profile.name, source: "saved",
        hostname: profile.hostname, user: profile.user ?? "", port: String(profile.port ?? ""), identityFile: profile.identityFile, profile: { ...profile },
        raw: "HostName " + profile.hostname })),
    ] };
  };
  window.rhineDesktop.hostProfiles = {
    save: async (profile, rev) => {
      if (rev !== String(revision)) return { ok: false, error: "主机档案已在别处修改" };
      const id = profile.id ?? "p-" + (++serial + 1);
      const row = { ...profile, id };
      const index = saved.findIndex(item => item.id === id);
      if (index >= 0) saved[index] = row; else saved.push(row);
      revision++;
      return { ok: true, profile: row, revision: String(revision) };
    },
    remove: async (id, rev) => {
      if (rev !== String(revision)) return { ok: false, error: "主机档案已在别处修改" };
      const index = saved.findIndex(item => item.id === id);
      if (index < 0) return { ok: false, error: "找不到这台主机" };
      saved.splice(index, 1); revision++;
      return { ok: true };
    },
    pickIdentity: async () => ({ ok: false, canceled: true }),
  };
  window.__starts = 0;
  const start = window.rhineDesktop.session.start;
  window.rhineDesktop.session.start = async (...args) => { window.__starts++; return start(...args); };
})();`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  if (filePath === "/fake-desktop-bridge.js") {
    res.writeHead(200, { "content-type": MIME[".js"] });
    createReadStream(path.join(root, "scripts", "repro-deck", "fake-desktop-bridge.js")).pipe(res);
    return;
  }
  if (filePath === "/profiles-bridge.js") {
    res.writeHead(200, { "content-type": MIME[".js"] });
    res.end(PROFILES);
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
        '<script src="./fake-desktop-bridge.js"></script>\n    <script src="./profiles-bridge.js"></script>\n    <script type="module"',
      ),
    );
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(disk)] ?? "application/octet-stream" });
  createReadStream(disk).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const debugPort = 9357;
const profile = path.join(os.tmpdir(), `rhine-actions-${process.pid}`);
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
    const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
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
    errors.push(`console.error: ${message.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
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
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails)
    throw new Error(`evaluate failed: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ""}`);
  return result.result?.value;
};
const until = async (label, expression, timeoutMs = 20000) => {
  await send("Page.bringToFront");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await sleep(150);
  }
  const rows = await evaluate(`[...document.querySelectorAll('.ssh-overview-host strong')].map(n => n.textContent)`);
  throw new Error(`Timed out: ${label} — rows: ${JSON.stringify(rows)}`);
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
const rowOf = (name) =>
  `[...document.querySelectorAll('.ssh-overview-host')].find(row => row.querySelector('strong').textContent === ${JSON.stringify(name)})`;
const names = `[...document.querySelectorAll('.ssh-overview-host strong')].map(n => n.textContent)`;
const point = async (expression) =>
  evaluate(`(() => { const r = (${expression})?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
const hover = async (name) => {
  const box = await point(`${rowOf(name)}.querySelector('.ssh-overview-connect')`);
  if (!box) throw new Error(`no row for ${name}`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await sleep(500);
};
const click = async (name, action) => {
  await hover(name);
  const box = await point(`${rowOf(name)}.querySelector('[data-overview-action="${action}"]')`);
  if (!box) throw new Error(`no ${action} button for ${name}`);
  for (const type of ["mousePressed", "mouseReleased"])
    await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
};
const label = (name, action) => evaluate(`${rowOf(name)}.querySelector('[data-overview-action="${action}"]').textContent`);

try {
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.removeItem('rhine-ssh-overview-collapsed');` });
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/?scene=archive` });
  await until("overview with two hosts", `window.rhine?.stats().ready && document.querySelectorAll('.ssh-overview-host').length === 2`, 40000);
  await sleep(600);

  await hover("生产机");
  await check(
    "the row's buttons appear on hover, and the other row steps back",
    `(() => { const on = ${rowOf("生产机")}, off = ${rowOf("demo-box")}; return getComputedStyle(on.querySelector('.ssh-overview-host-actions')).opacity === '1' && getComputedStyle(off.querySelector('.ssh-overview-host-actions')).opacity === '0' && Number(getComputedStyle(off).opacity) < 0.9 && Number(getComputedStyle(on).opacity) === 1; })()`,
  );
  await check(
    "a host that is not connected has no 断开",
    `getComputedStyle(${rowOf("生产机")}.querySelector('[data-overview-action="disconnect"]')).display === 'none'`,
  );
  await check("the button beside 复制 is 删除, and the connect button reads 连接", `(${JSON.stringify(await label("生产机", "remove"))}) === '删除' && (${JSON.stringify(await label("生产机", "reconnect"))}).startsWith('连接')`);
  await shot("01-hover");

  await click("生产机", "duplicate");
  await until("the copy appears", `${names}.includes('生产机 副本')`);
  await check("复制 adds a saved copy named 副本", `${names}.includes('生产机 副本') && ${names}.length === 3`);
  await check(
    "the copy keeps the endpoint",
    `${rowOf("生产机 副本")}.querySelector('small').textContent.includes('ops@10.0.0.5')`,
  );
  await sleep(1600);
  await click("生产机", "duplicate");
  await until("the second copy appears", `${names}.includes('生产机 副本 2')`);
  await check("a second copy is 副本 2", `${names}.includes('生产机 副本 2') && ${names}.length === 4`);
  await shot("02-copied");

  await click("demo-box", "remove");
  await check(
    "a host from the ssh config says where to delete it and stays",
    `(${JSON.stringify(await label("demo-box", "remove"))}).includes('SSH config') && ${names}.length === 4`,
  );
  await sleep(300);
  await click("生产机 副本 2", "remove");
  await check(
    "the first 删除 click only asks",
    `(${JSON.stringify(await label("生产机 副本 2", "remove"))}) === '确认删除？' && ${rowOf("生产机 副本 2")}.querySelector('[data-overview-action="remove"]').dataset.armed === 'true' && ${names}.length === 4`,
  );
  await shot("03-confirm");
  await click("生产机 副本 2", "remove");
  await until("the copy is removed", `!${names}.includes('生产机 副本 2')`);
  await check("the second click removes the host", `${names}.length === 3 && ${names}.includes('生产机 副本')`);

  await click("demo-box", "reconnect");
  await until("a session starts", `window.__starts >= 1`, 8000);
  await check("连接 starts a session", `window.__starts === 1`);
  // Connecting opens the host's own page and the overview steps aside; Escape brings the archive back.
  for (const type of ["rawKeyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until("the overview returns", `!document.querySelector('.ssh-overview').inert && ${rowOf("demo-box")}?.dataset.connected === 'true'`, 15000).catch(async (error) => {
    console.log(await evaluate(`JSON.stringify({ inert: document.querySelector('.ssh-overview').inert, mode: document.querySelector('#stage')?.dataset.mode, connected: ${rowOf("demo-box")}?.dataset.connected })`));
    throw error;
  });
  await sleep(300);
  await check(
    "a live host reads 重连 and offers 断开",
    `(() => { const row = ${rowOf("demo-box")}; return row.dataset.connected === 'true' && row.querySelector('[data-overview-action="reconnect"]').textContent.startsWith('重连') && getComputedStyle(row.querySelector('[data-overview-action="disconnect"]')).display !== 'none'; })()`,
  );
} catch (driverError) {
  console.log("\n=== driver error ===");
  console.log(String(driverError));
  checks["driver completed"] = false;
} finally {
  await writeFile(path.join(outDir, "report.json"), JSON.stringify({ checks, errors }, null, 2));
  console.log("\n=== errors ===");
  console.log(errors.length ? errors.join("\n") : "(none)");
  console.log(JSON.stringify(checks, null, 2));
  ws.close();
  edge.kill();
  server.close();
  process.exitCode = Object.values(checks).every(Boolean) && !errors.length ? 0 : 1;
}
