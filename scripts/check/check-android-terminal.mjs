import { artifactPath } from "../lib/artifacts.mjs";
/** Actual xterm + Android input/touch controls in a Chromium mobile viewport. */
import { createServer } from "vite";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
const server = await createServer({
  server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
  configFile: false,
});
await server.listen();
const profile = await mkdtemp(path.join(os.tmpdir(), "rhine-android-input-"));
const port = 9500 + (process.pid % 400);
const child = spawn(
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  [
    "--headless=new",
    "--no-first-run",
    "--disable-extensions",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { windowsHide: true, stdio: "ignore" },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
let ws;
try {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(200);
    try {
      target = (
        await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      ).find((t) => t.type === "page");
    } catch {}
  }
  assert.ok(target, "browser ready");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let next = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails)
      throw Error(
        r.exceptionDetails.text + JSON.stringify(r.exceptionDetails.exception),
      );
    return r.result.value;
  };
  const check = async (name, expression) => {
    assert.equal(await evaluate(expression), true, name);
    checks.push(name);
    console.log("PASS " + name);
  };
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 2,
  });
  await send("Page.navigate", {
    url: `http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/android-terminal.html`,
  });
  for (let i = 0; i < 100 && !(await evaluate("!!window.ready")); i++)
    await sleep(100);
  await check("real xterm mounted", "!!window.ready");
  await evaluate(
    `fixture.writes.length=0; for(const c of ['!','@','#','#','/','/']) { fixture.key229(); fixture.edit(c); }`,
  );
  await sleep(30);
  await check(
    "symbols and deliberate repeats are sent exactly once",
    `fixture.writes.join('')==='!@##//' && fixture.term.textarea.value===''`,
  );
  await evaluate(
    `fixture.writes.length=0; fixture.key229();fixture.composition('compositionstart','');fixture.composition('compositionupdate','ni');fixture.edit('ni','insertCompositionText','ni',true);`,
  );
  await check(
    "uncommitted composition is not sent",
    `fixture.writes.length===0`,
  );
  await evaluate(
    `fixture.composition('compositionend','你');fixture.edit('你','insertText','你');fixture.key229();fixture.edit('!');`,
  );
  await sleep(30);
  await check(
    "Chinese commit followed by punctuation is not duplicated",
    `fixture.writes.join('')==='你!'`,
  );
  await evaluate(
    `fixture.writes.length=0;for(const c of ['好','好']){fixture.key229();fixture.composition('compositionstart','');fixture.edit(c,'insertCompositionText',c,true);fixture.composition('compositionend',c);fixture.edit(c,'insertFromComposition',c);}`,
  );
  await sleep(30);
  await check(
    "consecutive identical IME commits are retained",
    `fixture.writes.join('')==='好好'`,
  );
  await evaluate(
    `fixture.writes.length=0;fixture.composition('compositionstart','');fixture.edit('cancel','insertCompositionText','cancel',true);fixture.composition('compositionend','');`,
  );
  await sleep(30);
  await check(
    "cancelled composition sends nothing",
    `fixture.writes.length===0`,
  );
  await evaluate(
    `fixture.key229();fixture.edit(null,'deleteContentBackward','');fixture.key229();fixture.edit(null,'insertLineBreak','');`,
  );
  await check(
    "soft keyboard delete and enter work",
    String.raw`fixture.writes.join('')==='\x7f\r'`,
  );
  await evaluate(`fixture.writes.length=0; window.editsCancelled = ['deleteContentBackward','insertLineBreak'].every(inputType => {
    const event = new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true });
    fixture.term.textarea.dispatchEvent(event); return event.defaultPrevented;
  })`);
  await check(
    "empty helper textarea still supports backspace and enter",
    String.raw`editsCancelled && fixture.writes.join('')==='\x7f\r'`,
  );
  await evaluate(`fixture.writes.length=0; fixture.term.focus()`);
  await send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
  });
  await send("Input.dispatchKeyEvent", {
    type: "char",
    key: "a",
    text: "a",
    unmodifiedText: "a",
    windowsVirtualKeyCode: 65,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
  });
  await check(
    "physical keyboard printable input is sent once",
    `fixture.writes.join('')==='a'`,
  );
  await evaluate(
    `fixture.writes.length=0;fixture.composition('compositionstart','');fixture.composition('compositionend','stale');fixture.hide();fixture.show();`,
  );
  await sleep(30);
  await check("hiding cancels pending input", `fixture.writes.length===0`);
  await evaluate(`fixture.term.focus()`);
  await send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "c",
    code: "KeyC",
    windowsVirtualKeyCode: 67,
    modifiers: 2,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "c",
    code: "KeyC",
    windowsVirtualKeyCode: 67,
    modifiers: 2,
  });
  await check(
    "hardware Ctrl+C still interrupts",
    String.raw`fixture.writes.join('')==='\x03'`,
  );
  const cell = await evaluate(
    `(()=>{const r=document.querySelector('.xterm-screen').getBoundingClientRect();return {x:r.left,y:r.top,w:r.width/fixture.term.cols,h:r.height/fixture.term.rows}})()`,
  );
  const touch = async (
    type,
    x = cell.x + cell.w * 2,
    y = cell.y + cell.h * 0.5,
  ) =>
    send("Input.dispatchTouchEvent", {
      type,
      touchPoints:
        type === "touchEnd" || type === "touchCancel" ? [] : [{ x, y, id: 1 }],
    });
  await touch("touchStart");
  await sleep(600);
  await touch("touchEnd");
  await check(
    "long press selects a word and shows copy actions",
    `fixture.term.getSelection()==='hello'&&!document.querySelector('.ssh-mobile-selection').hidden`,
  );
  await evaluate(`document.querySelector('[data-selection=copy]').click()`);
  await check(
    "selected text reaches Android clipboard bridge",
    `fixture.clipboard.text==='hello'`,
  );
  await evaluate(`document.querySelector('[data-selection=cancel]').click()`);
  await touch("touchStart", cell.x + cell.w * 6.5);
  await sleep(600);
  await touch("touchMove", cell.x + cell.w * 6, cell.y + cell.h * 2.5);
  await touch("touchMove", cell.x + cell.w * 6, cell.y + cell.h * 1.5);
  await touch("touchEnd");
  await check(
    "long press drag expands across rows and wide characters",
    `fixture.term.getSelection().includes('中文')&&fixture.term.getSelection().includes('second')`,
  );
  await evaluate(`document.querySelector('[data-selection=copy]').click()`);
  await check(
    "multiline selection preserves Unicode",
    String.raw`fixture.clipboard.text.includes('中文')&&fixture.clipboard.text.includes('\nsecond')`,
  );
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  await mkdir(artifactPath("android-terminal"), { recursive: true });
  await writeFile(
    artifactPath("android-terminal/selection.png"),
    Buffer.from(screenshot.data, "base64"),
  );
  await evaluate(`document.querySelector('[data-selection=cancel]').click()`);
  await touch("touchStart");
  await touch("touchMove", cell.x + cell.w * 2, cell.y + cell.h * 4);
  await sleep(600);
  await touch("touchEnd");
  await check(
    "ordinary swipe does not start a selection",
    `!fixture.term.hasSelection()&&document.querySelector('.ssh-mobile-selection').hidden`,
  );
  await touch("touchStart");
  await touch("touchCancel");
  await sleep(600);
  await check(
    "cancelled gesture does not select later",
    `!fixture.term.hasSelection()`,
  );
  // --- key bar, Ctrl lock, repeat, pinch, fling and edge scroll ---------------------------------
  const pointer = (selector, type) =>
    evaluate(`document.querySelector('${selector}').dispatchEvent(new PointerEvent('${type}', { bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true }))`);
  // A real touch: pointerup, then pointerout and pointerleave, and only then the click.
  const lift = async (selector) => { await pointer(selector, "pointerup"); await pointer(selector, "pointerout"); await pointer(selector, "pointerleave"); };
  const tap = async (selector) => { await pointer(selector, "pointerdown"); await lift(selector); await evaluate(`document.querySelector('${selector}').click()`); };
  await check("the key bar carries the keys a shell needs on a phone",
    `['Home','End','PageUp','PageDown','CtrlC','CtrlD'].every(k => document.querySelector('[data-ssh-key="'+k+'"]')) && ['|','~','/','-','_'].every(t => document.querySelector('[data-ssh-text="'+t+'"]'))`);
  await check("the key bar scrolls sideways instead of squeezing its keys",
    `(() => { const bar = document.querySelector('.ssh-mobile-keys'); return getComputedStyle(bar).overflowX === 'auto' && bar.scrollWidth >= bar.clientWidth && [...bar.children].every(b => b.getBoundingClientRect().width >= 43 && b.getBoundingClientRect().height >= 39); })()`);
  await evaluate(`fixture.writes.length=0`);
  for (const key of ["ArrowLeft", "Home", "End", "PageUp", "PageDown", "CtrlC"]) await tap(`[data-ssh-key="${key}"]`);
  await tap('[data-ssh-text="|"]');
  await check("named keys send their sequences and literal keys their character",
    String.raw`fixture.writes.join('')==='\x1b[D\x1b[H\x1b[F\x1b[5~\x1b[6~\x03|'`);
  await evaluate(`fixture.writes.length=0; fixture.term.write('\x1b[?1h')`);
  await sleep(50);
  for (const key of ["ArrowUp", "Home"]) await tap(`[data-ssh-key="${key}"]`);
  await check("cursor keys follow application mode (SS3)", String.raw`fixture.writes.join('')==='\x1bOA\x1bOH'`);
  await evaluate(`fixture.writes.length=0`);
  await tap('[data-ssh-key="ArrowUp"]');
  await tap('[data-ssh-key="ArrowDown"]');
  await check("one tap on an arrow key sends it once (the click after pointerleave is not a second press)",
    String.raw`fixture.writes.join('')==='\x1bOA\x1bOB'`);
  await evaluate(`fixture.term.write('\x1b[?1l')`);
  await evaluate(`fixture.writes.length=0`);
  await pointer('[data-ssh-key="ArrowDown"]', "pointerdown");
  await sleep(1000);
  await lift('[data-ssh-key="ArrowDown"]');
  const held = await evaluate(`fixture.writes.length`);
  await evaluate(`document.querySelector('[data-ssh-key="ArrowDown"]').click()`);
  await check("a held arrow key repeats, and its click is not sent twice",
    `${held >= 6 && held <= 16 && (await evaluate(`fixture.writes.length`)) === held}`);
  await sleep(200);
  await evaluate(`fixture.writes.length=0`);
  await pointer('[data-ssh-key="control"]', "pointerdown");
  await sleep(600);
  await pointer('[data-ssh-key="control"]', "pointerup");
  await evaluate(`document.querySelector('[data-ssh-key="control"]').click()`);
  await check("a long press locks Ctrl on", `document.querySelector('[data-ssh-key="control"]').dataset.locked === 'true' && document.querySelector('[data-ssh-key="control"]').getAttribute('aria-pressed') === 'true'`);
  await evaluate(`fixture.term.input('c', true); fixture.term.input('d', true)`);
  await check("a locked Ctrl turns every character into a control character", String.raw`fixture.writes.join('')==='\x03\x04'`);
  await tap('[data-ssh-key="control"]');
  await evaluate(`fixture.writes.length=0; fixture.term.input('c', true)`);
  await check("a tap turns a locked Ctrl off", `fixture.writes.join('')==='c' && document.querySelector('[data-ssh-key="control"]').dataset.locked === 'false'`);
  await evaluate(`fixture.writes.length=0`);
  await tap('[data-ssh-key="control"]');
  await evaluate(`fixture.term.input('c', true); fixture.term.input('c', true)`);
  await check("an armed Ctrl applies to one character only", String.raw`fixture.writes.join('')==='\x03c'`);

  // The grid for the gesture tests: 200 numbered lines.
  await evaluate(`fixture.term.reset(); fixture.term.write(Array.from({ length: 200 }, (_, i) => 'line ' + String(i).padStart(3, '0')).join('\\r\\n') + '\\r\\n')`);
  await sleep(200);
  const box = await evaluate(`(()=>{const r=document.querySelector('.xterm-screen').getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height}})()`);
  const finger = (type, points) => send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  const cx = box.x + box.w / 2;
  const size0 = await evaluate(`fixture.term.options.fontSize`);
  await finger("touchStart", [[cx - 40, box.y + box.h / 2], [cx + 40, box.y + box.h / 2]]);
  await sleep(30);
  for (const spread of [70, 100, 130, 160]) { await finger("touchMove", [[cx - spread, box.y + box.h / 2], [cx + spread, box.y + box.h / 2]]); await sleep(110); }
  await finger("touchEnd", []);
  const size1 = await evaluate(`fixture.term.options.fontSize`);
  await check("pinching out makes the font larger", `${size1 > size0}`);
  await finger("touchStart", [[cx - 160, box.y + box.h / 2], [cx + 160, box.y + box.h / 2]]);
  await sleep(30);
  for (const spread of [120, 80, 40]) { await finger("touchMove", [[cx - spread, box.y + box.h / 2], [cx + spread, box.y + box.h / 2]]); await sleep(110); }
  await finger("touchEnd", []);
  const size2 = await evaluate(`fixture.term.options.fontSize`);
  await check("pinching in makes it smaller again, within 8 to 32", `${size2 < size1 && size2 >= 8 && size2 <= 32}`);
  await evaluate(`fixture.appearance.update({ size: 13 })`);
  await sleep(200);

  await evaluate(`fixture.term.scrollToBottom()`);
  const y0 = await evaluate(`fixture.term.buffer.active.viewportY`);
  await finger("touchStart", [[cx, box.y + box.h * 0.2]]);
  for (let i = 1; i <= 8; i++) { await finger("touchMove", [[cx, box.y + box.h * 0.2 + i * 14]]); await sleep(16); }
  await finger("touchEnd", []);
  const releasedAt = await evaluate(`fixture.term.buffer.active.viewportY`);
  await sleep(500);
  const coasted = await evaluate(`fixture.term.buffer.active.viewportY`);
  await check("dragging down scrolls back through the history", `${releasedAt < y0}`);
  await check("a quick flick keeps coasting after the finger lifts", `${coasted < releasedAt}`);
  await sleep(1500);
  const rest = await evaluate(`fixture.term.buffer.active.viewportY`);
  await sleep(300);
  await check("the coasting settles", `${(await evaluate(`fixture.term.buffer.active.viewportY`)) === rest}`);

  await evaluate(`fixture.term.scrollToLine(80)`);
  await sleep(100);
  const grid = await evaluate(`(()=>{const r=document.querySelector('.xterm-screen').getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height}})()`);
  await touch("touchStart", cx, grid.y + grid.h * 0.3);
  await sleep(650);
  const before = await evaluate(`fixture.term.buffer.active.viewportY`);
  await touch("touchMove", cx, grid.y + grid.h - 6);
  await sleep(900);
  await touch("touchEnd");
  const after = await evaluate(`fixture.term.buffer.active.viewportY`);
  await check("dragging a selection to the bottom edge scrolls on and extends it",
    `${after > before && (await evaluate(`fixture.term.getSelection().split('\\n').length`)) > 8}`);
  await evaluate(`document.querySelector('[data-selection=cancel]').click()`);
  const settled = await evaluate(`fixture.term.buffer.active.viewportY`);
  await sleep(400);
  await check("the edge scroll stops when the selection ends", `${(await evaluate(`fixture.term.buffer.active.viewportY`)) === settled}`);
  const out = path.resolve(artifactPath("android-terminal"));
  await mkdir(out, { recursive: true });
  await writeFile(
    path.join(out, "report.json"),
    JSON.stringify({ checks }, null, 2),
  );
  console.log(`${checks.length} checks passed`);
} finally {
  ws?.close();
  child.kill();
  await server.close();
}
