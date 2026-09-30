import { artifactPath } from "../lib/artifacts.mjs";
/**
 * Records the Electron desktop bundle through its real flow — stills plus timed
 * frame sequences of every transition — so the Unreal port is judged against
 * what the desktop actually does, not against memory.
 *
 *   npm run build:desktop
 *   node scripts/capture/capture-web-flow.mjs [--out .artifacts/checks/web-flow] [--width 1600 --height 900]
 *
 * Output: <out>/<theme>-<state>.png, <out>/seq-<name>/NN-<ms>.jpg and
 * report.json (DOM buttons, stats, frame timings, page errors).
 */
import http from "node:http";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

const root = process.cwd(), dist = path.join(root, "dist-desktop");
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const out = path.resolve(root, arg("--out", artifactPath("web-flow")));
const width = Number(arg("--width", "1600")), height = Number(arg("--height", "900"));
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
if (!existsSync(path.join(dist, "index.html"))) throw new Error("dist-desktop missing: run npm run build:desktop");

const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".glb": "model/gltf-binary",
  ".svg": "image/svg+xml", ".ogg": "audio/ogg", ".json": "application/json", ".png": "image/png", ".webp": "image/webp", ".hdr": "application/octet-stream" };
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
  if (file.endsWith("index.html"))
    res.end((await readFile(file, "utf8")).replace('<script type="module"', '<script src="/fixture.js"></script><script type="module"'));
  else createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port, debugPort = 9650 + (process.pid % 150);
const profile = await mkdtemp(path.join(os.tmpdir(), "rhine-web-flow-"));
const browser = spawn("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", [
  "--headless=new", "--disable-extensions", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
  "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--enable-gpu", "--use-angle=d3d11",
  "--ignore-gpu-blocklist", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`, "about:blank",
], { windowsHide: true, stdio: "ignore" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errors = [], report = { width, height, stills: [], sequences: {}, dom: {}, stats: {} };
let ws;
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
    if (message.method === "Runtime.exceptionThrown")
      errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
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
  const until = async (name, expression, timeout = 60000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await evaluate(expression)) return; await sleep(150); }
    throw new Error(`Timed out: ${name}`);
  };
  const still = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(out, `${name}.png`), Buffer.from(data, "base64"));
    report.stills.push(name);
    console.log(`still ${name}`);
  };
  /** Runs `action`, then grabs frames as fast as capture allows for `ms`. */
  const record = async (name, action, ms) => {
    const dir = path.join(out, `seq-${name}`);
    await mkdir(dir, { recursive: true });
    const frames = [];
    const start = Date.now();
    await evaluate(action);
    while (Date.now() - start < ms) {
      const at = Date.now() - start;
      const { data } = await send("Page.captureScreenshot", { format: "jpeg", quality: 72 });
      const file = `${String(frames.length).padStart(2, "0")}-${String(at).padStart(5, "0")}.jpg`;
      await writeFile(path.join(dir, file), Buffer.from(data, "base64"));
      frames.push(at);
    }
    report.sequences[name] = { action, ms, frames };
    console.log(`sequence ${name}: ${frames.length} frames`);
  };
  /** Visible buttons and headings, to compare wording and layout boxes. */
  const dom = async (name) => {
    report.dom[name] = await evaluate(`[...document.querySelectorAll('button,h1,h2,[role=tab],a')]
      .filter(el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && +s.opacity > 0.05 && !el.closest('[hidden],[inert]'); })
      .map(el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return { tag: el.tagName, text: el.textContent.trim().replace(/\\s+/g, ' ').slice(0, 60), cls: String(el.className).slice(0, 60),
        box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], font: s.fontSize + ' ' + s.fontWeight + ' ' + s.fontFamily.split(',')[0], color: s.color }; })`);
  };
  /**
   * Every visible element that owns text, plus every painted box (background,
   * border, shadow, backdrop blur), in 1920x1080 design units. Covers the whole
   * viewport: the host overview lives outside #stage.
   */
  const spec = async (name) => {
    report.spec ??= {};
    report.boxes ??= {};
    const result = await evaluate(`(() => {
      const view = document.querySelector('#viewport'); const v = view.getBoundingClientRect(); const k = 1920 / v.width;
      const visible = (el, c, r) => r.width >= 1 && r.height >= 1 && c.visibility !== 'hidden' && c.display !== 'none' && !el.closest('[hidden],[inert],[aria-hidden=true]');
      const alpha = el => { let o = 1; for (let p = el; p && p !== view; p = p.parentElement) o *= +getComputedStyle(p).opacity; return +o.toFixed(2); };
      const box = r => ({ x: Math.round((r.x - v.x) * k), y: Math.round((r.y - v.y) * k), w: Math.round(r.width * k), h: Math.round(r.height * k) });
      const text = [], boxes = [];
      for (const el of view.querySelectorAll('*')) {
        if (el.closest('#three-scene,svg,canvas')) continue;
        const r = el.getBoundingClientRect(); const c = getComputedStyle(el);
        if (!visible(el, c, r)) continue;
        const o = alpha(el); if (o < 0.05) continue;
        const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim().replace(/\\s+/g, ' ');
        if (own) text.push({ text: own.slice(0, 50), cls: String(el.className).slice(0, 40), ...box(r),
          size: c.fontSize, weight: c.fontWeight, family: c.fontFamily.split(',')[0].replace(/"/g, ''), spacing: c.letterSpacing, line: c.lineHeight, color: c.color, opacity: o });
        const painted = (c.backgroundColor !== 'rgba(0, 0, 0, 0)' && c.backgroundColor !== 'transparent') || c.backgroundImage !== 'none'
          || ['Top','Right','Bottom','Left'].some(s => parseFloat(c['border' + s + 'Width']) > 0 && c['border' + s + 'Style'] !== 'none') || c.boxShadow !== 'none' || (c.backdropFilter && c.backdropFilter !== 'none');
        if (painted && !el.closest('.boot')) boxes.push({ tag: el.tagName, cls: String(el.className).slice(0, 40), ...box(r), bg: c.backgroundColor, image: c.backgroundImage.slice(0, 120),
          border: ['Top','Right','Bottom','Left'].map(s => c['border' + s + 'Width'] + ' ' + c['border' + s + 'Color']).join(' | '), radius: c.borderRadius, shadow: c.boxShadow.slice(0, 120), backdrop: c.backdropFilter, opacity: o });
      }
      return { text, boxes }; })()`);
    report.spec[name] = result.text;
    report.boxes[name] = result.boxes;
  };
  const click = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('missing ${selector.replace(/'/g, "")}'); el.click(); return true; })()`;

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });

  for (const theme of ["light", "dark"]) {
    const p = theme === "light" ? "light" : "dark";
    await send("Page.navigate", { url: "about:blank" });
    await sleep(200);
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `localStorage.clear(); localStorage.setItem('rhine-settings', JSON.stringify({sound:false,music:false,reduced:false,colorTheme:'${theme}'}));`,
    });
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/?scene=archive` });
    await until("scene ready", `window.rhine?.stats().ready && window.rhine.stats().mode === 'archive'`);
    await until("overview", `!!document.querySelector('.ssh-overview:not([hidden]) .ssh-overview-glass')`);
    await sleep(4500);
    await still(`${p}-01-home`);
    await dom(`${p}-home`); await spec(`${p}-home`);
    if (theme === "light") {
      await record("collapse", click('.ssh-overview-heading-actions [data-overview-action="collapse"]'), 1400);
    } else await evaluate(click('.ssh-overview-heading-actions [data-overview-action="collapse"]'));
    await sleep(1200);
    await still(`${p}-02-collapsed`);
    await dom(`${p}-collapsed`); await spec(`${p}-collapsed`);
    report.stats[`${p}-collapsed`] = await evaluate(`({ selected: rhine.stats().selected, index: rhine.stats().selectedIndex })`);
    if (theme === "light") {
      await record("select-next", `rhine.select(rhine.stats().selectedIndex + 1)`, 2200);
      await sleep(600);
      await still(`${p}-03-selected`);
      report.stats[`${p}-selected`] = await evaluate(`({ selected: rhine.stats().selected, index: rhine.stats().selectedIndex })`);
      await record("select-back", `rhine.select(rhine.stats().selectedIndex - 1)`, 1600);
      await sleep(800);
      await record("restore", click(".ssh-overview-restore"), 1400);
      await sleep(600);
      // Host detail, reached the way a person does: the row's 详情 action.
      await record("host-detail", click('[data-host-alias="review-host"] [data-overview-action="inspect"]'), 6000);
    } else {
      await evaluate(click(".ssh-overview-restore"));
      await sleep(1200);
      await evaluate(click('[data-host-alias="review-host"] [data-overview-action="inspect"]'));
      await sleep(6000);
    }
    await still(`${p}-04-host-detail`);
    await dom(`${p}-host-detail`); await spec(`${p}-host-detail`);
    report.stats[`${p}-detail`] = await evaluate(`({ selected: rhine.stats().selected, index: rhine.stats().selectedIndex, mode: rhine.stats().mode })`);
    if (theme === "dark") break;
    // Connecting: the fixture walks a real handshake log and stops at a password prompt.
    const connect = await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(el => /CONNECT/.test(el.textContent) && el.getBoundingClientRect().width > 0 && !el.closest('[hidden],[inert]')); if (!b) return null; const t = b.textContent.trim(); b.click(); return t; })()`);
    report.connectButton = connect;
    if (connect) {
      await record("connect", "true", 2600);
      await still("light-05-auth");
      await dom("light-auth");
      await evaluate(`(() => { const input = [...document.querySelectorAll('input[type=password]')].find(el => el.getBoundingClientRect().width > 0); if (!input) return false; input.value = 'secret'; input.dispatchEvent(new Event('input', { bubbles: true })); input.form ? input.form.requestSubmit() : input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
      await record("interactive", `window.__deckFixture.interactive(), true`, 4500);
      await still("light-06-terminal");
      await dom("light-terminal");
    }
    await evaluate(`document.querySelector('[data-action="back"]')?.click(), true`);
    await sleep(2500);
    await still("light-07-back");
  }
  await writeFile(path.join(out, "report.json"), JSON.stringify({ ...report, errors }, null, 2));
  console.log(errors.length ? `errors: ${errors.join(" | ")}` : "no page errors");
} finally {
  if (ws?.readyState === WebSocket.OPEN) ws.close();
  browser.kill();
  server.close();
}
