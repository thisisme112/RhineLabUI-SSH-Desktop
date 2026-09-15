/** Runtime/visual checks against the actual desktop bundle, with a labelled
 * transport fixture. Actual SSH transport is covered separately by its checks.
 */
import http from "node:http";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

const root = process.cwd(),
  dist = path.join(root, "dist-desktop");
const outFlag = process.argv.indexOf("--out");
if (outFlag >= 0 && !process.argv[outFlag + 1])
  throw new Error("--out requires a directory");
const out =
  outFlag >= 0
    ? path.resolve(root, process.argv[outFlag + 1])
    : path.join(root, "verification", "terminal-deck");
let missingTerminal = false;
await mkdir(out, { recursive: true });
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".glb": "model/gltf-binary",
  ".svg": "image/svg+xml",
  ".ogg": "audio/ogg",
  ".json": "application/json",
};
const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(
    new URL(req.url, "http://localhost").pathname,
  );
  if (pathname === "/fixture.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    if (process.argv.includes("--multi") || process.argv.includes("--navigation")) {
      createReadStream(path.join(root, "scripts/fixtures/ssh-multi-bridge.js")).pipe(res);
      return;
    }
    if (process.argv.includes("--workspace")) {
      res.end(
        (await readFile(
          path.join(root, "scripts/fixtures/terminal-deck-bridge.js"),
          "utf8",
        )) +
          "\n" +
          (await readFile(
            path.join(root, "scripts/fixtures/ssh-workspace-bridge.js"),
            "utf8",
          )),
      );
      return;
    }
    createReadStream(
      path.join(root, "scripts/fixtures/terminal-deck-bridge.js"),
    ).pipe(res);
    return;
  }
  const file = path.resolve(
    dist,
    "." + (pathname === "/" ? "/index.html" : pathname),
  );
  // The insert is built in code, so the only way the deck can still fail to
  // load is the packaging box it sits in.
  if (missingTerminal && /archive-assembly[.\w-]*\.glb$/.test(pathname)) {
    res.writeHead(404).end();
    return;
  }
  if (!file.startsWith(dist + path.sep) || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    "content-type": `${mime[path.extname(file)] ?? "application/octet-stream"}; charset=utf-8`,
  });
  if (file.endsWith("index.html"))
    res.end(
      (await readFile(file, "utf8")).replace(
        '<script type="module"',
        '<script src="/fixture.js"></script><script type="module"',
      ),
    );
  else createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port,
  debugPort = 9400 + (process.pid % 400);
const profile = await mkdtemp(path.join(os.tmpdir(), "rhine-terminal-review-"));
const browser = spawn(
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  [
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
  ],
  { windowsHide: true, stdio: "ignore" },
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = {},
  errors = [],
  evidence = {};
let expectModelFailure = false;
let ws;
try {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(200);
    try {
      target = (
        await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
      ).find((t) => t.type === "page");
    } catch {}
  }
  if (!target) throw new Error("Browser did not start");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
    if (message.method === "Runtime.exceptionThrown")
      errors.push(
        message.params.exceptionDetails.exception?.description ??
          message.params.exceptionDetails.text,
      );
    if (
      message.method === "Runtime.consoleAPICalled" &&
      message.params.type === "error"
    ) {
      const detail = message.params.args
        .map((arg) => arg.value ?? arg.description)
        .join(" ");
      if (expectModelFailure && detail.includes("终端模型载入失败"))
        evidence.expectedModelFailure = detail;
      else errors.push(detail);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(
        () => reject(new Error(`${method} timeout`)),
        30000,
      );
      pending.set(id, (message) => {
        clearTimeout(timeout);
        if (message.error) reject(new Error(message.error.message));
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
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      );
    return result.result.value;
  };
  const until = async (name, expression, timeout = 45000) => {
    await send("Page.bringToFront");
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await evaluate(expression)) return;
      await sleep(150);
    }
    evidence.timeout = await evaluate(
      `({ stats: window.rhine?.stats(), phase: window.rhineSsh?.status(), hidden: document.hidden, focus: document.activeElement?.outerHTML.slice(0,300), prompt: window.rhineSshUi?.promptKind, viewer: document.querySelector('.model-viewer')?.outerHTML.slice(0,400), terminal: document.querySelector('.ssh-terminal')?.outerHTML.slice(0,1200) })`,
    );
    evidence.toolsAtTimeout = await evaluate(
      `({ query: document.querySelector('.ssh-terminal-query')?.value, count: document.querySelector('.ssh-terminal-search-count')?.textContent, tools: document.querySelector('.ssh-terminal-tools')?.outerHTML, feedback: document.querySelector('.ssh-terminal-tool-feedback')?.textContent })`,
    );
    await shot("failure");
    throw new Error(`Timed out: ${name}`);
  };
  const check = async (name, expression) => {
    checks[name] = Boolean(await evaluate(expression));
    console.log(`${checks[name] ? "PASS" : "FAIL"} ${name}`);
  };
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(out, `${name}.png`), Buffer.from(data, "base64"));
  };
  const key = async (key, code, keyCode, modifiers = 0) => {
    for (const type of ["rawKeyDown", "keyUp"])
      await send("Input.dispatchKeyEvent", {
        type,
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        modifiers,
      });
  };
  const run = async () => {
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Network.enable");
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `if (!localStorage.getItem('rhine-settings')) localStorage.setItem('rhine-settings', JSON.stringify({sound:false,music:false,reduced:false,superPerformance:${process.argv.includes("--fast")}}));`,
    });
    await send("Page.navigate", {
      url: `http://127.0.0.1:${port}/?scene=archive`,
    });
    await until(
      "scene and hosts",
      `window.rhine?.stats().ready && window.rhineSshUi?.cardOf('review-host') !== null && !!window.rhineSshUi`,
    );
    if (process.argv.includes("--navigation")) {
      const { checkSshNavigation } = await import("./ssh-navigation-checks.mjs");
      await checkSshNavigation({ evaluate, until, check, shot, key, send, sleep, evidence });
      return;
    }
    if (process.argv.includes("--multi")) {
      if (process.argv.includes("--performance")) {
        const { checkOverviewPerformance } = await import("./ssh-overview-performance.mjs");
        await checkOverviewPerformance({ evaluate, until, check, shot, send, sleep, evidence });
        return;
      }
      const { checkSshMultisession } = await import("./ssh-multi-browser-checks.mjs");
      await checkSshMultisession({ evaluate, until, check, shot, key, send, sleep, evidence });
      return;
    }
    await evaluate(`rhineSshUi.connectHost('review-host')`);
    await until(
      "password prompt and model",
      `rhineSshUi.promptKind === 'password' && rhine.stats().sessionDeck.available && rhine.stats().cameraDetail > .99`,
    );
    await check(
      "authentication keeps the package assembled",
      `rhine.stats().sessionDeck.progress === 0 && !rhineSshUi.isOpen`,
    );
    await check(
      "real authentication log is retained",
      `rhineSsh.rawLog.some(line => line.includes('curve25519-sha256'))`,
    );
    await shot("01-authentication");
    await evaluate(`rhineSshUi.answerSecret('review-secret')`);
    await sleep(500);
    await check(
      "authentication alone does not open a shell",
      `rhine.stats().sessionDeck.progress === 0 && !rhineSshUi.isOpen`,
    );
    await evaluate(`(() => {
    window.__deckOpeningFrames = [];
    const started = performance.now();
    const sample = () => {
      const stats = rhine.stats();
      const elapsedMs = performance.now() - started;
      window.__deckOpeningFrames.push({ elapsedMs, progress: stats.sessionDeck.progress,
        focus: stats.sessionDeck.focus, camera: stats.cameraPosition,
        fieldOfView: stats.fieldOfView, screen: stats.sessionDeck.screen });
      if (!stats.sessionDeck.ready && elapsedMs < 10000) requestAnimationFrame(sample);
    };
    sample();
    __deckFixture.interactive();
  })()`);
    await until("opening begins", `rhine.stats().sessionDeck.progress > .2`);
    await shot("02-unpacking");
    await until("opening midpoint", `rhine.stats().sessionDeck.progress > .5`);
    await shot("02-unpacking-mid");
    await until(
      "opening approaches screen",
      `rhine.stats().sessionDeck.progress > .8`,
    );
    await shot("02-unpacking-near");
    await until(
      "operating terminal",
      `rhineSshUi.isOpen && rhineSshUi.hasFocus && rhine.stats().sessionDeck.ready`,
    );
    await sleep(700);
    evidence.openingFrames = await evaluate(`window.__deckOpeningFrames`);
    await shot("03-operating");
    if (process.argv.includes("--geometry")) {
      const { checkTerminalGeometry } =
        await import("./terminal-geometry-checks.mjs");
      await checkTerminalGeometry({
        evaluate,
        until,
        check,
        shot,
        key,
        send,
        sleep,
        evidence,
      });
      return;
    }
    if (process.argv.includes("--workspace")) {
      const { checkSshWorkspace } = await import("./ssh-workspace-checks.mjs");
      await checkSshWorkspace({
        evaluate,
        until,
        check,
        shot,
        key,
        send,
        sleep,
        evidence,
      });
      return;
    }
    if (process.argv.includes("--tools")) {
      const { checkTerminalTools } =
        await import("./terminal-tools-checks.mjs");
      await checkTerminalTools({
        evaluate,
        until,
        check,
        shot,
        key,
        send,
        sleep,
        evidence,
      });
      return;
    }
    await check(
      "terminal operates on the projected model screen",
      `document.querySelector('.ssh-terminal')?.dataset.presentation === 'deck' && !document.querySelector('#host-session')`,
    );
    await check(
      "secret is absent from visible output",
      `!document.querySelector('.ssh-terminal').textContent.includes('review-secret')`,
    );
    await send("Input.insertText", { text: "printf 终端检查" });
    await key("Enter", "Enter", 13);
    await until(
      "keyboard round trip",
      `document.querySelector('.ssh-terminal .xterm-rows')?.textContent.includes('result: printf 终端检查')`,
    );
    checks["real input and output use the same terminal"] = true;
    await check(
      "PTY dimensions follow the operating surface",
      `__deckFixture.sizes.length > 0 && __deckFixture.sizes.at(-1)[0] >= 80 && __deckFixture.sizes.at(-1)[1] >= 20`,
    );
    await key("Escape", "Escape", 27);
    await check(
      "Escape reaches the remote application",
      `__deckFixture.writes.includes('\x1b') && rhineSshUi.isOpen`,
    );
    await key("Tab", "Tab", 9);
    await check(
      "Tab reaches terminal completion",
      `__deckFixture.writes.includes('\t') && rhineSshUi.hasFocus`,
    );
    await key("ArrowUp", "ArrowUp", 38);
    await check(
      "arrow keys reach remote applications",
      `__deckFixture.writes.includes('\x1b[A') && rhineSshUi.hasFocus`,
    );
    await shot("04-input-output");
    await evaluate(
      `rhineSshUi.closeTerminal(); __deckFixture.output(${JSON.stringify("\r\nHIDDEN_OUTPUT_MARKER\r\n")})`,
    );
    await until(
      "package reassembled",
      `rhine.stats().sessionDeck.progress === 0`,
    );
    await check(
      "closing preserves the connection",
      `rhineSsh.active && !rhineSshUi.isOpen`,
    );
    await until(
      "focus returns after reassembly",
      `document.activeElement === document.querySelector('#host-connect')`,
    );
    checks["closing restores a visible host action"] = true;
    await evaluate(`__deckFixture.output(${JSON.stringify("\x1b[6n")})`);
    await until(
      "hidden protocol response",
      String.raw`__deckFixture.writes.some(value => /^\x1b\[\d+;\d+R$/.test(value))`,
    );
    checks["collapsed terminal still answers protocol queries"] = true;
    await shot("05-reassembled");
    await evaluate(`rhineSshUi.openTerminal()`);
    await until("reopened", `rhineSshUi.isOpen && rhineSshUi.hasFocus`);
    await check(
      "hidden output survives reopening",
      `document.querySelector('.ssh-terminal .xterm-rows').textContent.includes('HIDDEN_OUTPUT_MARKER')`,
    );
    await evaluate(`rhineSshUi.closeTerminal()`);
    await sleep(60);
    await evaluate(`rhineSshUi.openTerminal()`);
    await until(
      "interrupted close reopens",
      `rhineSshUi.isOpen && rhineSshUi.hasFocus`,
    );
    await check(
      "rapid reopening retains one xterm",
      `document.querySelectorAll('.ssh-terminal .xterm').length === 1`,
    );
    await evaluate(
      `__deckFixture.output(${JSON.stringify("\x1b[?1049h\x1b[2J\x1b[H\x1b[38;2;231;74;52mTRUECOLOR 中文\x1b[0m\r\nFULLSCREEN_APPLICATION")})`,
    );
    await until(
      "alternate screen",
      `document.querySelector('.xterm-rows').textContent.includes('FULLSCREEN_APPLICATION')`,
    );
    await check(
      "ANSI truecolor and wide characters render",
      `Array.from(document.querySelectorAll('.xterm-rows span')).some(node => node.textContent.includes('TRUECOLOR') && getComputedStyle(node).color === 'rgb(231, 74, 52)') && document.querySelector('.xterm-rows').textContent.includes('中文')`,
    );
    await evaluate(`rhineSshUi.closeTerminal()`);
    await until(
      "alternate screen packed",
      `rhine.stats().sessionDeck.progress === 0 && !rhineSshUi.isOpen`,
    );
    await shot("07-alternate-packed");
    await evaluate(`rhineSshUi.openTerminal()`);
    await until("alternate screen reopened", `rhineSshUi.hasFocus`);
    await check(
      "alternate screen survives packing",
      `document.querySelector('.xterm-rows').textContent.includes('FULLSCREEN_APPLICATION')`,
    );
    await evaluate(
      `__deckFixture.output(${JSON.stringify("\x1b[?1049l\r\nNORMAL_RESTORED\r\n")})`,
    );
    await until(
      "normal buffer restored",
      `document.querySelector('.xterm-rows').textContent.includes('HIDDEN_OUTPUT_MARKER') && document.querySelector('.xterm-rows').textContent.includes('NORMAL_RESTORED')`,
    );
    checks["alternate screen returns to the same normal buffer"] = true;
    for (const [width, height] of [
      [1366, 768],
      [2560, 1440],
    ]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sleep(700);
      await check(
        `screen remains inside ${width}x${height}`,
        `(() => { const r = document.querySelector('.ssh-terminal').getBoundingClientRect(); return r.x >= 0 && r.y >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; })()`,
      );
      await shot(`06-${width}x${height}`);
    }
    await evaluate(`__deckFixture.end(0)`);
    await check(
      "disconnect keeps output available",
      `rhineSshUi.isOpen && document.querySelector('.ssh-terminal .xterm-rows').textContent.includes('HIDDEN_OUTPUT_MARKER')`,
    );
    evidence.final = await evaluate(
      `({stats:rhine.stats(),sizes:__deckFixture.sizes,phase:rhineSsh.status().phase})`,
    );

    await send("Emulation.setDeviceMetricsOverride", {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await evaluate(`rhineSshUi.closeTerminal()`);
    await until("before reconnect", `rhine.stats().sessionDeck.progress === 0`);
    await evaluate(`rhineSshUi.connectHost('review-host')`);
    await until("new authentication", `rhineSshUi.promptKind === 'password'`);
    await check(
      "new session clears old terminal content",
      `!rhineSsh.output.includes('HIDDEN_OUTPUT_MARKER') && !document.querySelector('.ssh-terminal .xterm')`,
    );
    await evaluate(`rhineSshUi.answerSecret('fail')`);
    await until("failed connection", `rhineSsh.status().phase === 'failed'`);
    await check(
      "authentication failure leaves the package closed",
      `rhine.stats().sessionDeck.progress === 0 && !rhineSshUi.isOpen`,
    );
    await shot("08-failed-authentication");
    await evaluate(`rhineSshUi.dismissPrompt()`);
    await sleep(250);
    await evaluate(`document.querySelector('#host-last-terminal').click()`);
    await until(
      "failed output opens",
      `rhineSshUi.isOpen && document.querySelector('.ssh-terminal').dataset.transition === 'open'`,
    );
    await check(
      "failed output remains readable without unpacking",
      `rhine.stats().sessionDeck.progress === 0 && !rhineSsh.active && !document.querySelector('.ssh-terminal-auth').hidden && document.querySelector('.ssh-terminal-auth').textContent.includes('Permission denied')`,
    );
    await shot("08-failed-output");
    await evaluate(`rhineSshUi.closeTerminal()`);
    await until("failed output closed", `!rhineSshUi.isOpen`);
    await evaluate(`rhineSshUi.connectHost('review-host')`);
    await until("retry authentication", `rhineSshUi.promptKind === 'password'`);
    await evaluate(
      `rhineSshUi.answerSecret('retry-secret'); __deckFixture.interactive()`,
    );
    await until(
      "retry opening begins",
      `rhine.stats().sessionDeck.progress > .15`,
    );
    await key("Escape", "Escape", 27);
    await until(
      "opening cancelled",
      `rhine.stats().sessionDeck.progress === 0 && !rhineSshUi.isOpen`,
    );
    await check(
      "opening can be cancelled without disconnecting",
      `rhineSsh.active`,
    );
    await evaluate(`rhineSshUi.openTerminal()`);
    await until("retry ready", `rhineSshUi.hasFocus`);
    await check(
      "reconnected terminal has one fresh buffer",
      `document.querySelectorAll('.ssh-terminal .xterm').length === 1 && !document.querySelector('.ssh-terminal').textContent.includes('HIDDEN_OUTPUT_MARKER')`,
    );
    await evaluate(`__deckFixture.end(0)`);

    // Apply the existing settings in an isolated profile; reload the actual app.
    await evaluate(
      `localStorage.setItem('rhine-settings', JSON.stringify({...JSON.parse(localStorage.getItem('rhine-settings')),colorTheme:'dark',reduced:true}))`,
    );
    await send("Page.reload");
    await until(
      "reduced dark scene",
      `window.rhine?.stats().ready && !!window.rhineSshUi`,
    );
    await evaluate(`rhineSshUi.connectHost('review-host')`);
    await until(
      "reduced dark auth",
      `rhineSshUi.promptKind === 'password' && rhine.stats().sessionDeck.available`,
    );
    await evaluate(
      `rhineSshUi.answerSecret('dark-secret'); __deckFixture.interactive()`,
    );
    await until(
      "reduced dark operation",
      `rhineSshUi.hasFocus && rhine.stats().sessionDeck.ready`,
    );
    // #15232b, not terminal.css's own #232521: the host overview landed
    // (482a471) with the desktop palette and re-declares the terminal's
    // variables so the terminal matches its cyan ground. This expectation still
    // named the pre-overview value.
    await check(
      "dark theme reaches both terminal presentations",
      `document.querySelector('.ssh-terminal').dataset.dark === 'true' && getComputedStyle(document.querySelector('.ssh-terminal')).backgroundColor === 'rgb(21, 35, 43)'`,
    );
    await shot("09-dark-reduced-motion");
    await evaluate(`rhineSshUi.closeTerminal()`);
    await sleep(100);
    await check(
      "reduced motion reassembles immediately",
      `rhine.stats().motion.reduced && rhine.stats().sessionDeck.progress === 0 && !rhineSshUi.isOpen`,
    );
    await evaluate(`__deckFixture.end(0)`);

    missingTerminal = true;
    expectModelFailure = true;
    await send("Page.reload");
    await until(
      "fallback scene",
      `window.rhine?.stats().ready && !!window.rhineSshUi`,
    );
    await evaluate(`rhineSshUi.connectHost('review-host')`);
    await until(
      "fallback authentication",
      `rhineSshUi.promptKind === 'password'`,
    );
    await evaluate(
      `rhineSshUi.answerSecret('fallback-secret'); __deckFixture.interactive()`,
    );
    await until(
      "fallback terminal",
      `rhineSshUi.hasFocus && document.querySelector('.ssh-terminal')?.dataset.presentation === 'window'`,
    );
    await send("Input.insertText", { text: "fallback-input" });
    await key("Enter", "Enter", 13);
    await until(
      "fallback round trip",
      `document.querySelector('.xterm-rows').textContent.includes('result: fallback-input')`,
    );
    await check(
      "missing model preserves a working terminal",
      `!rhine.stats().sessionDeck.available && rhineSsh.active`,
    );
    await shot("10-model-fallback");
    await check("frame loop stays alive", `rhine.stats().fps > 0`);
  };
  await run();
  checks["no page errors"] = errors.length === 0;
} catch (error) {
  errors.push(String(error));
  checks["driver completed"] = false;
  console.error(String(error));
} finally {
  await writeFile(
    path.join(out, "report.json"),
    JSON.stringify({ checks, errors, evidence }, null, 2),
  );
  if (ws?.readyState === WebSocket.OPEN) ws.close();
  browser.kill();
  server.close();
}
console.log(JSON.stringify({ checks, errors }, null, 2));
process.exitCode =
  Object.values(checks).every(Boolean) && !errors.length ? 0 : 1;
