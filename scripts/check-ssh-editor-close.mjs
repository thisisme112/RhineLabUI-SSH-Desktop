/** Reproduction for "SFTP text editor cannot be closed after editing".
 *  Drives the real desktop bundle in headless Edge with the labelled workspace
 *  fixture, opens a remote file in the CodeMirror editor, edits it and then
 *  tries every exit path a user has: the 返回 button (real mouse click), the
 *  synthetic click path, and Escape. Reports the editor's live state after
 *  each attempt so the failing step is visible. */
import http from "node:http";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

const root = process.cwd(),
  dist = path.join(root, "dist-desktop"),
  out = path.join(root, "verification", "editor-close");
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
const hangSave = process.argv.includes("--hang-save");
const editorStub = `
window.__editorCalls = [];
rhineDesktop.sftp.readText = async request => {
  window.__editorCalls.push(['readText', request.path]);
  return { ok: true, result: { path: request.path, text: '# fixture\\nkey: value\\n', revision: 'rev-1', modified: Date.now(), permissions: '-rw-r--r--' } };
};
rhineDesktop.sftp.writeText = ${
    hangSave
      ? // A write whose reply never arrives: the failure a real slow SFTP
        // channel produces. The editor must still be leavable.
        `async request => { window.__editorCalls.push(['writeText', request.path]); await new Promise(() => {}); }`
      : `async request => {
  window.__editorCalls.push(['writeText', request.path]);
  return { ok: true, result: { conflict: false, document: { path: request.path, text: request.text, revision: 'rev-2', modified: Date.now(), permissions: '-rw-r--r--' } } };
}`
  };
`;
const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(
    new URL(req.url, "http://localhost").pathname,
  );
  if (pathname === "/fixture.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(
      (await readFile(
        path.join(root, "scripts/fixtures/terminal-deck-bridge.js"),
        "utf8",
      )) +
        "\n" +
        (await readFile(
          path.join(root, "scripts/fixtures/ssh-workspace-bridge.js"),
          "utf8",
        )) +
        "\n" +
        editorStub,
    );
    return;
  }
  const file = path.resolve(
    dist,
    "." + (pathname === "/" ? "/index.html" : pathname),
  );
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
const profile = await mkdtemp(path.join(os.tmpdir(), "rhine-editor-close-"));
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
    )
      errors.push(
        message.params.args
          .map((arg) => arg.value ?? arg.description)
          .join(" "),
      );
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
  const until = async (name, expression, timeout = 20000) => {
    await send("Page.bringToFront");
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await evaluate(expression)) return;
      await sleep(150);
    }
    throw new Error(`Timed out: ${name}`);
  };
  const check = async (name, expression) => {
    checks[name] = Boolean(await evaluate(expression));
    console.log(`${checks[name] ? "PASS" : "FAIL"} ${name}`);
  };
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(
      path.join(out, `${name}.png`),
      Buffer.from(data, "base64"),
    );
  };
  const editorState = `(() => { const editor = document.querySelector('.ssh-text-editor'); if (!editor) return { missing: true }; const close = editor.querySelector('[data-editor="close"]'); const rect = close.getBoundingClientRect(); const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return { hidden: editor.hidden, inert: editor.inert, transition: editor.dataset.transition, zIndex: editor.style.zIndex, opacity: getComputedStyle(editor).opacity, closeDisabled: close.disabled, closeTop: rect.y, closeRegion: getComputedStyle(close).webkitAppRegion, hit: hit ? (hit.closest('button')?.dataset.editor ?? String(hit.className).slice(0, 60) ?? hit.tagName) : null, active: String(document.activeElement?.className).slice(0, 60) }; })()`;
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
    source: `localStorage.setItem('rhine-settings', JSON.stringify({sound:false,music:false,reduced:false,superPerformance:true,colorTheme:${JSON.stringify(process.argv.includes("--dark") ? "dark" : "light")},palette:${JSON.stringify(process.argv.find(a=>a.startsWith("--palette="))?.slice(10) ?? "warm")}}));`,
  });
  await send("Page.navigate", {
    url: `http://127.0.0.1:${port}/?scene=archive`,
  });
  await until(
    "scene and hosts",
    `!!window.rhineSshUi && window.rhine?.stats().ready && window.rhineSshUi.cardOf('review-host') !== null`,
  );
  await evaluate(`rhineSshUi.connectHost('review-host')`);
  await until(
    "password prompt",
    `rhineSshUi.promptKind === 'password' && rhine.stats().sessionDeck.available`,
  );
  await evaluate(
    `rhineSshUi.answerSecret('review-secret'); __deckFixture.interactive()`,
  );
  await until(
    "operating terminal",
    `rhineSshUi.isOpen && rhineSshUi.hasFocus && rhine.stats().sessionDeck.ready`,
  );
  await until(
    "file listing",
    `Number(document.querySelector('.ssh-files-count').textContent) > 700`,
  );

  // Open config.yaml in the remote text editor, the way a user would.
  await evaluate(
    `(() => { const field = document.querySelector('.ssh-files-filter input'); field.value = 'config.yaml'; field.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
  await until(
    "config.yaml row",
    `document.querySelector('.ssh-file-name')?.textContent === 'config.yaml'`,
  );
  await evaluate(
    `document.querySelector('.ssh-file-row').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))`,
  );
  await until(
    "text editor open with content",
    `!!document.querySelector('.ssh-text-editor') && !document.querySelector('.ssh-text-editor').hidden && document.querySelector('.ssh-text-editor .cm-content')?.textContent.includes('key: value')`,
  );
  await check(
    "editor is the active surface",
    `(${editorState}).inert === false`,
  );
  await check(
    "return button is below the desktop title bar",
    `(${editorState}).closeTop >= 41`,
  );
  await check(
    "return button is excluded from the drag region",
    `(${editorState}).closeRegion === 'no-drag'`,
  );
  await shot("01-editor-open");

  // Optional visual survey: stay open so a real screenshot captures the theme.
  if (process.argv.includes("--shot-only")) {
    await until(
      "opening animation settled",
      `document.querySelector('.ssh-text-editor').dataset.transition === 'open'`,
    );
    await send("Input.insertText", { text: "edited: true\n" });
    await sleep(400);
    await shot("01-editor-themed");
    checks["shot captured"] = true;
    checks["no page errors"] = errors.length === 0;
  }

  // Let the opening fade finish; a click that lands mid-fade is the suspect.
  if (!process.argv.includes("--shot-only")) {
  await until(
    "opening animation settled",
    `document.querySelector('.ssh-text-editor').dataset.transition === 'open'`,
  );
  evidence.settled = await evaluate(editorState);

  // Edit the document, as the user does before failing to leave.
  await send("Input.insertText", { text: "edited: true\n" });
  await until(
    "unsaved marker",
    `document.querySelector('.ssh-editor-status').textContent.includes('未保存')`,
  );
  evidence.beforeClose = await evaluate(editorState);

  if (hangSave) {
    // Save over a channel that never answers, then try to leave mid-write:
    // the exact shape of "编辑完无法关闭". All exits must still work.
    await evaluate(`document.querySelector('[data-editor="save"]').click()`);
    await until(
      "write in flight",
      `document.querySelector('.ssh-editor-status').textContent.includes('正在写入')`,
    );
    evidence.duringHungSave = await evaluate(editorState);
    await check(
      "返回 stays enabled during a hung write",
      `(${editorState}).closeDisabled === false`,
    );
    await evaluate(`document.querySelector('[data-editor="close"]').click()`);
    await sleep(700);
    evidence.afterHungSaveClose = await evaluate(editorState);
    await check(
      "返回 leaves the editor during a hung write",
      `(${editorState}).hidden === true`,
    );
    checks["no page errors"] = errors.length === 0;
  } else {

  const rect = await evaluate(
    `document.querySelector('[data-editor="close"]').getBoundingClientRect().toJSON()`,
  );
  const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };

  // Attempt 0: press 返回 while the opening fade is still running.
  await evaluate(
    `document.querySelector('.ssh-file-row').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))`,
  );
  await until(
    "editor reopened",
    `!document.querySelector('.ssh-text-editor').hidden && document.querySelector('.ssh-text-editor .cm-content')?.textContent.includes('key: value')`,
  );
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...point,
    button: "left",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...point,
    button: "left",
    clickCount: 1,
  });
  await sleep(700);
  evidence.duringOpenClick = await evaluate(editorState);
  await check(
    "clicking 返回 during the opening fade closes the editor",
    `(${editorState}).hidden === true`,
  );
  await shot("00-after-mid-open-click");

  // Attempt 1: a real mouse click on 返回 · 保留草稿 after it settled.
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...point,
    button: "left",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...point,
    button: "left",
    clickCount: 1,
  });
  await sleep(700);
  evidence.afterRealClick = await evaluate(editorState);
  await check(
    "real click on 返回 closes the editor",
    `(${editorState}).hidden === true`,
  );
  await shot("02-after-real-click");

  // Attempt 2: synthetic click, in case the real event was eaten on the way.
  await evaluate(`document.querySelector('[data-editor="close"]').click()`);
  await sleep(700);
  evidence.afterSyntheticClick = await evaluate(editorState);
  await check(
    "synthetic click on 返回 closes the editor",
    `(${editorState}).hidden === true`,
  );

  // Attempt 3: Escape while the CodeMirror surface owns focus.
  await evaluate(
    `document.querySelector('.ssh-text-editor .cm-content')?.focus()`,
  );
  await send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await sleep(700);
  evidence.afterEscape = await evaluate(editorState);
  await check("Escape closes the editor", `(${editorState}).hidden === true`);

  // The complaint pairs with a session that can no longer be closed either.
  await evaluate(`rhineSshUi.closeTerminal()`);
  await sleep(1200);
  await check(
    "terminal session closes after using the editor",
    `!rhineSshUi.isOpen`,
  );
  checks["no page errors"] = errors.length === 0;
  }
  }
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
console.log(JSON.stringify({ checks, errors, evidence }, null, 2));
process.exitCode =
  Object.values(checks).every(Boolean) && !errors.length ? 0 : 1;
