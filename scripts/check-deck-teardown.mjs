/**
 * The terminal's own teardown — "拆解终端 / 一键重组" — driven in headless Edge.
 *
 *   npm run check:deck-teardown
 *
 * Verifies the three things that are easy to get wrong and impossible to see in
 * a unit test: the stack really separates and comes back, the corner the button
 * sits in is genuinely clickable while the terminal owns the screen, and the
 * operating xterm stays off the model while the plates are apart.
 *
 * Reports land in verification/terminal-teardown/.
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
const outDir = path.join(root, "verification", "terminal-teardown");
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

const debugPort = 9341;
const profile = path.join(os.tmpdir(), `rhine-teardown-${process.pid}`);
// The same flags the deck harness uses: without the backgrounding switches the
// render loop is throttled in headless, and every frame-driven animation (the
// opening, the teardown spring) crawls instead of running.
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
  // A bare timeout says nothing about why; the state it timed out in does.
  const state = await evaluate(
    `({ deck: rhine?.stats()?.sessionDeck, phase: rhineSsh?.status()?.phase, open: rhineSshUi?.isOpen, prompt: rhineSshUi?.promptKind, tools: document.querySelector('.deck-tools')?.outerHTML.slice(0, 200) })`,
  );
  throw new Error(`Timed out: ${label} — ${JSON.stringify(state)}`);
};
const checks = {};
const evidence = {};
const probe = (name) =>
  evaluate(
    `(() => { const t = document.querySelector('.deck-tools'); return { inert: t?.inert, hidden: t?.hidden, stageInert: document.querySelector('#stage')?.inert, viewportInert: document.querySelector('#viewport')?.inert }; })()`,
  ).then((value) => {
    evidence[name] = value;
  });
const check = async (name, expression) => {
  checks[name] = Boolean(await evaluate(expression));
  console.log(`${checks[name] ? "PASS" : "FAIL"} ${name}`);
};
const shot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(outDir, `${name}.png`), Buffer.from(data, "base64"));
};
/** A real pointer press at the button's own centre: this is what proves the
 *  control is on top of the operating terminal rather than behind it. */
const clickAtCentre = async (selector) => {
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
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/?scene=archive` });
  await until("rhineSshUi", `Boolean(window.rhineSshUi)`);
  await until("hosts loaded", `window.rhineSshUi.cardOf("demo-box") !== null`);

  await evaluate(`window.rhineSshUi.connectHost("demo-box")`);
  await until("password prompt", `window.rhineSshUi.promptKind === "password"`);

  // The question's own corner: the detail page's back button used to sit here,
  // covered by this layer, visibly dead. The button that answers must be real.
  await check(
    "the corner button covers the detail page's own",
    `getComputedStyle(document.querySelector('.back-button')).visibility === 'hidden' && document.querySelector('.ssh-prompt-back')?.getBoundingClientRect().width > 0`,
  );
  await shot("01-prompt-back-button");
  await probe("whilePromptOpen");

  await evaluate(`window.rhineSshUi.answerSecret("review-secret")`);
  await until("interactive phase", `rhineSsh?.status().phase === "interactive"`);
  await sleep(500);
  await probe("afterPromptClosed");
  // The auto-reveal belongs to the app's own timing; the documented manual
  // path is what this check needs, so it uses that rather than depending on it.
  await evaluate(`window.rhineSshUi.isOpen || window.rhineSshUi.openTerminal()`);
  await until(
    "operating terminal",
    `rhineSshUi.isOpen && rhine.stats().sessionDeck.ready`,
  );
  await sleep(600);
  await probe("atOperatingSize");
  // The terminal is modal: SurfaceScope makes every sibling inert and swallows
  // their events, so the teardown has to be offered from the terminal's own bar
  // rather than from the scene. This is the assertion that keeps it reachable.
  await check(
    "teardown is offered from the surface that owns the screen",
    `(() => { const b = document.querySelector('.ssh-terminal-teardown'); return b && !b.hidden && !b.closest('[inert]'); })()`,
  );
  await check(
    "the scene control stays out of the way until there is something to reassemble",
    `document.querySelector('.deck-tools').hidden === true`,
  );
  await shot("02-operating-and-teardown");

  // A real pointer press, so the click goes through hit-testing rather than
  // straight to the handler.
  await clickAtCentre(".ssh-terminal-teardown");
  await until("stack separates", `rhine.stats().sessionDeck.spread > .3`);
  await shot("03-separating");
  await check(
    "the operating terminal steps off the moving screen",
    `!rhineSshUi.isOpen && rhine.stats().sessionDeck.progress === 1`,
  );
  await until("stack fully apart", `rhine.stats().sessionDeck.spread > .99`);
  await sleep(400);
  await check(
    "the package stays open while the stack is apart",
    `rhine.stats().sessionDeck.state === 'open' && rhine.stats().sessionDeck.progress === 1`,
  );
  await check(
    "the camera opens up to frame the whole stack",
    `rhine.stats().sessionDeck.inspecting && rhine.stats().fieldOfView < 26`,
  );
  await shot("04-separated");
  await check(
    "the way back out is offered once the terminal has stepped off",
    `!document.querySelector('.deck-tools').hidden && !document.querySelector('.deck-tools').inert`,
  );

  await clickAtCentre('[data-deck-action="assemble"]');
  await until("stack reassembles", `rhine.stats().sessionDeck.spread < .01`);
  await until("terminal returns", `rhineSshUi.isOpen && rhineSshUi.hasFocus`);
  await check(
    "reassembly gives the screen back to the terminal",
    `rhine.stats().sessionDeck.spread === 0 && rhine.stats().sessionDeck.ready`,
  );
  await shot("05-reassembled");

  // The stack has to survive being packed away mid-inspection: the returning
  // card would otherwise be filed away with its plates still spread.
  await clickAtCentre(".ssh-terminal-teardown");
  await until("separated again", `rhine.stats().sessionDeck.spread > .5`);
  await evaluate(`window.rhineSshUi.closeTerminal()`);
  await until("packed from separated", `rhine.stats().sessionDeck.progress === 0`);
  await sleep(400);
  await check(
    "packing a separated stack puts the plates back",
    `rhine.stats().sessionDeck.spread === 0`,
  );
  await shot("06-packed-from-separated");
  await check("frame loop stays alive", `Number(document.querySelector("#three-scene")?.dataset.fps ?? 0) > 0`);
} catch (driverError) {
  console.log("\n=== driver error ===");
  console.log(String(driverError));
  checks["driver completed"] = false;
} finally {
  await writeFile(
    path.join(outDir, "report.json"),
    JSON.stringify({ checks, errors, evidence }, null, 2),
  );
  console.log("\n=== evidence ===");
  console.log(JSON.stringify(evidence, null, 2));
  console.log("\n=== errors ===");
  console.log(errors.length ? errors.join("\n") : "(none)");
  console.log(JSON.stringify(checks, null, 2));
  ws.close();
  edge.kill();
  server.close();
  process.exitCode = Object.values(checks).every(Boolean) && !errors.length ? 0 : 1;
}
