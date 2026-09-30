// Native smokeContext wiring; context getters preserve live session ownership.
module.exports = runtimeContext => {
const PROBE = `(() => {
  const stage = document.querySelector('#stage');
  return {
    base: document.baseURI,
    protocol: location.protocol,
    desktopFlag: document.documentElement.dataset.desktop ?? null,
    desktopBridge: typeof window.rhineDesktop === 'object' && window.rhineDesktop !== null,
    hasStage: !!stage,
    stageMode: stage?.dataset.mode ?? null,
    canvases: document.querySelectorAll('canvas').length,
    loading: !!document.querySelector('#loading'),
    entryState: document.querySelector('#loading')?.dataset.entry ?? null,
    loadingText: (document.querySelector('#loading')?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
    pwaSection: !!document.querySelector('#pwa-settings'),
    navButtons: document.querySelectorAll('.system-nav button').length,
    sessionEntry: !!window.rhineSshUi?.openHosts,
    rhineSshLoaded: typeof window.rhineSsh === 'object' && window.rhineSsh !== null,
    serviceWorker: 'serviceWorker' in navigator ? !!navigator.serviceWorker.controller : null,
    // The caption is the OS's, so the page's side of it is the theme it
    // reported and the drag region that stands in for the title bar.
    colorTheme: document.documentElement.dataset.darkSurface === 'true' ? 'dark' : 'light',
    themeReported: typeof window.rhineDesktop?.theme === 'function',
    dragRegion: (() => {
      const strip = document.querySelector('.titlebar-drag');
      if (!strip) return null;
      const style = getComputedStyle(strip);
      return { height: Math.round(strip.getBoundingClientRect().height),
        region: style.webkitAppRegion ?? style.getPropertyValue('-webkit-app-region') };
    })(),
  };
})()`;

const START = `(() => {
  // The gate listens for a real "click" and lets the native <button> own
  // Enter/Space, so drive the button itself rather than synthesising keys.
  const button = document.querySelector('#loading .entry-start');
  if (!button) return 'no-entry-button';
  button.click();
  return 'clicked';
})()`;

function readProbe(name) {
  return runtimeContext.fs.readFileSync(runtimeContext.path.join(runtimeContext.electronDir, "probes", name), "utf8");
}

async function runSessionSmoke(win) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("did-finish-load timeout")),
      30000,
    );
    win.webContents.once("did-finish-load", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  // Let main.ts finish booting so window.rhineSsh exists.
  await wait(3000);
  if (runtimeContext.MULTI_SMOKE) return runMultisessionSmoke(win);
  if (runtimeContext.HOST_SMOKE) return runHostManagementSmoke(win);
  if (runtimeContext.TERMINAL_SMOKE) return runTerminalDeckSmoke(win);
  if (runtimeContext.EDITOR_SMOKE) return runEditorSmoke(win);
  // Where the probe should write its export, so automation never opens a dialog.
  const exportPath = runtimeContext.path.join(runtimeContext.path.dirname(runtimeContext.reportPath), "session-record-export.txt");
  try {
    runtimeContext.fs.rmSync(exportPath, { force: true });
  } catch {
    /* nothing to remove */
  }
  await win.webContents.executeJavaScript(
    `window.__auditExportPath = ${JSON.stringify(exportPath)}; true`,
  );
  // Does executeJavaScript await a promise in this sandbox? Everything below
  // depends on it, so check rather than assume.
  const bridge = await win.webContents.executeJavaScript(
    `(async () => { await new Promise(r => setTimeout(r, 50)); return { awaited: true, value: 42 }; })()`,
  );
  console.log("SESSION_SMOKE_BRIDGE " + JSON.stringify(bridge ?? null));
  // An async throw inside executeJavaScript resolves to undefined and would
  // otherwise surface only as "every check failed"; capture it instead. The
  // probe file defines `window.__sessionProbe`; the harness calls it here.
  const wrapper = `(async () => { try { ${readProbe("session-probe.js")}
    return await window.__sessionProbe(); } catch (error) { return { error: String((error && error.stack) || error) }; } })()`;
  let result = await win.webContents.executeJavaScript(wrapper);
  if (result === undefined || result === null) {
    console.log(
      "SESSION_SMOKE_BRIDGE return was empty; falling back to the stashed result",
    );
    result = (await win.webContents.executeJavaScript(
      `window.__sessionSmokeResult ?? null`,
    )) ?? {
      error: "probe returned nothing and stashed nothing",
    };
  }
  const ok = result.success ?? {};
  const rejected = result.rejected ?? {};
  const term = ok.interactive ?? {};
  const hostkey = result.hostkeyAccepted ?? {};
  const hostkeyAccepted = result.hostkeyAccepted ?? {};
  const hostkeyRejected = result.hostkeyRejected ?? {};
  const password = result.passwordGiven ?? {};
  const picker = result.hostPicker ?? {};
  const interrupt = result.interrupt ?? {};
  // A check harness must report a missing field, not crash on it.
  const has = (value, needle) =>
    typeof value === "string" && value.includes(needle);

  // The readable export, and the JSON record the app persisted by itself.
  let exported = null;
  try {
    if (runtimeContext.fs.existsSync(exportPath))
      exported = runtimeContext.fs.readFileSync(exportPath, "utf8");
  } catch {
    /* reported through the checks below */
  }
  let persisted = null;
  try {
    const dir = runtimeContext.path.join(runtimeContext.app.getPath("userData"), "ssh-logs");
    const files = runtimeContext.fs.existsSync(dir)
      ? runtimeContext.fs
          .readdirSync(dir)
          .filter((name) => name.endsWith(".json"))
          .map((name) => ({
            name,
            at: runtimeContext.fs.statSync(runtimeContext.path.join(dir, name)).mtimeMs,
          }))
          .sort((a, b) => b.at - a.at)
      : [];
    if (files.length)
      persisted = JSON.parse(
        runtimeContext.fs.readFileSync(runtimeContext.path.join(dir, files[0].name), "utf8"),
      );
  } catch {
    /* reported through the checks below */
  }

  // The user's report: typing into the password field made it flash and the
  // surface became unclosable. Reproduce it with real input events.
  const typing = await runTypingCheck(win);
  const regression = await win.webContents.executeJavaScript(
    readProbe("regression-probe.js"),
  );
  const argv = Array.isArray(ok.argv) ? ok.argv : [];
  const flagAt = argv.indexOf("-v");
  const checks = {
    "lifecycle regression scenarios completed":
      Boolean(regression) && !regression.error,
    ...regression?.checks,
    "renderer client available": !result.error && !ok.error,
    "session reached interactive": ok.interactivePhase === "interactive",
    "session ended cleanly after exit": ok.finalPhase === "closed",
    // The invariant is the flag triplet, not a fixed offset: a test seam may
    // prepend an interpreter and a script ahead of it.
    "argv carries -v and no -E":
      flagAt >= 0 && !argv.includes("-E"),
    "target is the last argument":
      argv.length > 0 && argv[argv.length - 1] === "operator@lab-node-07",
    "host key fingerprint captured":
      ok.facts?.hostKeyFingerprint ===
      "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s",
    "auth method captured": ok.facts?.authMethod === "publickey",
    // The timeline is the real path; a clean exit appends its terminal state.
    "timeline is the real path":
      Array.isArray(ok.timeline) &&
      ok.timeline.slice(0, 7).join() ===
        "resolving,connecting,handshake,hostkey,authenticating,opening,interactive" &&
      ok.timeline[ok.timeline.length - 1] === "closed",
    "terminal received the prompt": ok.terminalHasPrompt === true,
    "terminal retains real authentication output": ok.terminalHasDebug === true,
    "every log line parsed":
      (ok.unknownLines?.length ?? -1) === 0 && ok.rawLogLines === 19,
    "exit reported": Boolean(ok.exit) && ok.exit.exitCode === 0,
    "log lines counted": (ok.traffic?.logLines ?? 0) > 0,
    // Skipped, not silently passed, when the stand-in cannot expose a console.
    "pty carried session bytes": runtimeContext.seam.consoleChild
      ? (ok.traffic?.bytesIn ?? 0) > 0
      : null,

    // ── the reveal is driven by the connection, in the running application ──
    "scene reveal ended fully clear":
      ok.decryption?.phase === "clear" && (ok.decryption?.clarity ?? 0) > 0.99,
    "scene reveal passed through real stages":
      Array.isArray(ok.decryptionSamples) &&
      ok.decryptionSamples.length >= 3 &&
      ok.decryptionSamples[0][0] === "waiting" &&
      ok.decryptionSamples.some(([phase]) => phase === "joining"),
    "scene reveal never ran ahead": (ok.decryptionSamples ?? []).every(
      ([phase]) =>
        [
          "waiting",
          "joining",
          "connected",
          "retracting",
          "revealing",
          "clear",
        ].includes(phase),
    ),
    "scene reveal travelled gradually": (ok.decryptionSamples ?? []).some(
      ([phase, low, high]) => phase === "revealing" && high - low > 0.5,
    ),
    "handshake settled on the last real milestone":
      ok.handshake?.milestone === "session.prompt" ||
      ok.handshake?.target >= 39.56,

    // ── a rejected connection must never look decrypted (rule R1) ───────────
    "rejected session failed": rejected.phase === "failed",
    "rejected session froze the timeline": rejected.handshake?.frozen === true,
    "rejected session left the glass frosted":
      (rejected.decryption?.clarity ?? -1) === 0,
    "rejected session never entered the reveal": !(
      rejected.decryptionSamples ?? []
    ).some(([phase]) => ["retracting", "revealing", "clear"].includes(phase)),
    "rejected session opened no terminal":
      (rejected.interactive ?? null) === null,

    // ── the terminal surface, exercised while the session is live ───────────
    "terminal opened on interactive": term.autoOpened === true,
    "xterm surface mounted": term.mounted === true,
    "terminal holds the keyboard": term.focused === true,
    "global shortcuts yielded to the terminal": term.guardHeld === true,
    "keystrokes reached the program and came back": term.roundTrip === true,
    "measured bytes moved the array bands":
      (term.bandsAfter?.activity ?? 0) > 0,
    "array bands were quiet before any session":
      (result.bandsBeforeSession?.activity ?? -1) === 0,
    "renderer async bridge works": bridge?.awaited === true,

    // ── the host key decision: it must block, and both answers must matter ──
    "unknown host key blocked the workflow":
      hostkey.opened === true && hostkey.kind === "hostkey",
    "confirmation shows the real fingerprint": has(
      hostkey.text,
      "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s",
    ),
    "accepting the key lets the session proceed":
      hostkeyAccepted.reachedInteractive === true &&
      hostkeyAccepted.exitCode === 0,
    "rejecting the key ends the connection":
      hostkeyRejected.phase === "failed" && hostkeyRejected.exitCode === 255,
    "rejection is explained, not just reported as a code": has(
      hostkeyRejected.failure,
      "主机密钥",
    ),

    // ── the secret path ────────────────────────────────────────────────────
    "password prompt blocked the workflow":
      password.opened === true && password.kind === "password",
    "supplying the password completes the connection":
      password.reachedInteractive === true && password.exitCode === 0,
    "no secret is left in the surface":
      password.panelTextAfter !== undefined &&
      hostkeyRejected.panelTextAfter !== undefined &&
      !has(password.panelTextAfter, "hunter2") &&
      !has(hostkeyRejected.panelTextAfter, "yes"),

    // ── the session's own record, and its export (rule R5) ──────────────────
    "session record surface opened": result.audit?.open === true,
    "record lists phase timings": /阶段耗时/.test(result.audit?.text ?? ""),
    "record shows the negotiated suite":
      /密钥交换算法/.test(result.audit?.text ?? "") &&
      /chacha20-poly1305/.test(result.audit?.text ?? ""),
    "record cites the raw line for each fact": /debug1: Server host key/.test(
      result.audit?.text ?? "",
    ),
    "record shows measured traffic":
      /下行合计/.test(result.audit?.text ?? "") &&
      /事件行数/.test(result.audit?.text ?? ""),
    "record export wrote a readable file":
      exported !== null && /SSH 会话记录/.test(exported),
    "export contains the fingerprint and its source":
      exported !== null &&
      /SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s/.test(exported) &&
      /debug1: Server host key/.test(exported),
    "session record surface closed": result.audit?.closed === true,
    "record persisted next to its event log":
      persisted !== null &&
      Array.isArray(persisted?.phases) &&
      persisted.phases.length >= 4,
    "persisted record kept the raw sources":
      persisted !== null &&
      persisted.facts.some((fact) => /^debug1:/.test(fact.source)),

    // ── the entry point: pick a host from the user's own config ────────────
    "host picker opened": picker.open === true,
    "host picker read the real ssh config":
      picker.count >= 1 &&
      picker.configMatches === true &&
      /ssh[-\\/]?config$/.test((picker.source ?? "").trim()),
    "host picker listed the configured host": (picker.list ?? []).some(
      (entry) => entry.alias && entry.alias.length > 0,
    ),
    "connecting from the picker brought a session up":
      picker.reachedInteractive === true,
    "host picker closed after connecting": picker.closed === true,

    // ── typing into the password field, with real input events ─────────────
    "password field received focus": typing.appeared?.focused === true,
    "password field is not inert": typing.appeared?.inert === false,
    "typed characters accumulate": (typing.settled?.valueLength ?? 0) === 4,
    "password field keeps focus while typing": typing.settled?.focused === true,
    "typing never re-created the field": typing.settled?.marker === "original",
    "typing caused no re-render": typing.rendersDuringTyping === 0,
    "password page uses a staggered entrance while accepting input": typing.appeared?.motionCount > 0 && typing.steps.some(step => step.animations > 0 && step.valueLength > 0),
    "authentication shares the archive detail alignment": typing.settled?.aligned === true,
    "prompt surface stays open while typing":
      typing.settled?.present === true &&
      typing.settled?.hidden === false &&
      typing.settled?.transition === "open",

    // ── an interrupted transition must not freeze the application ──────────
    "interrupted surfaces left every panel closed":
      (interrupt.after?.visiblePanels?.length ?? -1) === 0,
    "interrupted surfaces left nothing extra inert":
      (interrupt.after?.inertChildren?.length ?? -1) ===
      (interrupt.baseline ?? -2),
    "interrupted surfaces left the nav usable":
      interrupt.after?.navInert === false,
    "interrupted surfaces preserved the archive input state":
      interrupt.after?.archiveInert ===
      interrupt.baselineNames?.includes("archive-ui"),
    "the archive still responds to the keyboard": interrupt.moved === true,
    "no surface was left open":
      interrupt.panelStates?.audit === false &&
      interrupt.panelStates?.hosts === false &&
      interrupt.panelStates?.prompt === false &&
      interrupt.panelStates?.terminal === false,
  };
  const skipped = Object.entries(checks)
    .filter(([, value]) => value === null)
    .map(([name]) => name);
  for (const name of skipped) delete checks[name];
  const failed = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  const payload = {
    checks,
    skipped,
    failed,
    result: { ...result, typing, regression },
    problems: runtimeContext.problems,
  };
  console.log(
    "SESSION_SMOKE_RESULT " +
      JSON.stringify({
        type: typeof result,
        value:
          typeof result === "object" ? undefined : String(result).slice(0, 200),
        keys: result && typeof result === "object" ? Object.keys(result) : null,
        serialized: (() => {
          try {
            return JSON.stringify(result) === undefined ? "undefined" : "ok";
          } catch (error) {
            return "throws: " + String(error);
          }
        })(),
      }),
  );
  runtimeContext.report(payload);
  console.log(
    "SESSION_SMOKE_JSON " +
      JSON.stringify({ checks, skipped, failed, problems: runtimeContext.problems }),
  );
  return failed.length === 0;
}

async function runMultisessionSmoke(win) {
  const result = await win.webContents.executeJavaScript(readProbe("multisession-probe.js"));
  const checks = result?.checks || {};
  if (result?.error) runtimeContext.problems.push({ kind: "multisession-probe", message: result.error });
  checks["two native sessions are still alive before reload"] = runtimeContext.sessions.active().length === 2;
  const loaded = new Promise(resolve => win.webContents.once("did-finish-load", resolve));
  win.webContents.reload();
  await loaded;
  const deadline = Date.now() + 15000;
  let fresh = false;
  while (Date.now() < deadline) {
    fresh = await win.webContents.executeJavaScript("Boolean(window.rhineSshUi && window.rhineSshUi.sessions.length === 0)");
    if (fresh && runtimeContext.sessions.entries.size === 0) break;
    await wait(100);
  }
  checks["reload stops the old native owners and creates no automatic connection"] = fresh && runtimeContext.sessions.entries.size === 0;
  checks["native reload checkpoints retain all live session histories"] = Boolean(result?.liveIds?.length) && result.liveIds.every(id => {
    try {
      const record = JSON.parse(runtimeContext.fs.readFileSync(runtimeContext.path.join(runtimeContext.app.getPath("userData"), "ssh-logs", id + ".json"), "utf8"));
      return record.id === id && record.outcome === "closed" && record.traffic.bytesIn > 0;
    } catch { return false; }
  });
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  runtimeContext.report({ checks, failed, result, problems: runtimeContext.problems, scope: "Actual Electron/preload/IPC/ConPTY; SSH peer simulated." });
  return !failed.length && !runtimeContext.problems.some(problem => problem.severity !== "warning");
}

async function runTerminalDeckSmoke(win) {
  const result = await win.webContents.executeJavaScript(readProbe("terminal-deck-probe.js"));
  if (!result) throw new Error("Native terminal probe returned no result");
  const opened = await capture(win, "terminal-deck-native");
  await win.webContents.insertText("native_key_check");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
  await win.webContents.executeJavaScript("window.__nativeDeckProbe.input()");
  const reopened = await capture(win, "terminal-deck-reopened");
  await win.webContents.executeJavaScript("window.__nativeDeckProbe.tools()");
  const terminalTools = await capture(win, "terminal-tools");
  const checks = await win.webContents.executeJavaScript("window.__nativeDeckProbe.end()");
  win.setSize(1200, 760);
  await wait(350);
  checks["native window resize after exit remains responsive"] = await win.webContents.executeJavaScript("window.rhine.stats().ready && window.rhineSsh.exit !== null");
  checks["no native renderer errors"] = runtimeContext.problems.filter(item => item.severity !== "warning").length === 0;
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  const evidence = await win.webContents.executeJavaScript("window.__nativeDeckProbe.evidence");
  runtimeContext.report({ checks, failed, result, evidence, shots: [opened, reopened, terminalTools], problems: runtimeContext.problems });
  return failed.length === 0;
}

async function runEditorSmoke(win) {
  const step = (expression) =>
    win.webContents.executeJavaScript(
      `(async () => { try { ${expression} } catch (error) { return { error: String(error?.stack || error) }; } })()`,
    );
  await win.webContents.executeJavaScript(
    readProbe("editor-close-probe.js") + "\nwindow.__editorProbeReady = true;",
  );
  const opened = await step(`return await window.__editorProbe.openEditor();`);
  if (opened?.error) throw new Error("Editor probe: " + JSON.stringify(opened));
  const shotOpen = await capture(win, "editor-open");
  const edited = await step(`return await window.__editorProbe.edit();`);
  // Real mouse click, at the button's own coordinates, the way a user does it.
  const clickClose = async () => {
    const rect = await step(`return window.__editorProbe.state().buttonRect;`);
    if (!rect || rect.error) throw new Error("Editor close geometry: " + JSON.stringify(rect));
    const point = { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    win.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
    win.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
    return point;
  };
  const clickedAt = await clickClose();
  await wait(800);
  const afterRealClick = await step(`return window.__editorProbe.state();`);
  const shotAfterClick = await capture(win, "editor-after-click");
  // Synthetic fallback, in case the real event never reached the element.
  await step(`document.querySelector('[data-editor="close"]')?.click(); return true;`);
  await wait(800);
  const afterSynthetic = await step(`return window.__editorProbe.state();`);
  const checks = {
    "editor probe ran": !opened?.error,
    "editor opened with content": opened && opened.hidden === false && opened.transition === "open",
    "return button is enabled before click": edited && edited.closeDisabled === false,
    "return button is below the native title bar":
      edited && edited.buttonRect?.y >= runtimeContext.CHROME_HEIGHT + 1,
    "return button explicitly opts out of window dragging":
      edited && edited.buttonRegion === "no-drag",
    "button is not covered by another element": edited && edited.hit === "close",
    "real click reached the return button":
      (afterRealClick?.events ?? []).some((event) => event.type === "click" && event.target === "close") ||
      (afterRealClick?.events ?? []).length === 0,
    "real click closed the editor": afterRealClick && afterRealClick.hidden === true,
    "synthetic click closed the editor": afterSynthetic && afterSynthetic.hidden === true,
    "no native renderer errors": runtimeContext.problems.filter((item) => item.severity !== "warning").length === 0,
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  runtimeContext.report({ checks, failed, evidence: { opened, edited, clickedAt, afterRealClick, afterSynthetic }, shots: [shotOpen, shotAfterClick], problems: runtimeContext.problems });
  return failed.length === 0;
}

async function runHostManagementSmoke(win) {
  const shots = [];
  const step = (method) => win.webContents.executeJavaScript(
    `(async () => { try { return await window.__hostManagementProbe.${method}(); } catch (error) { return { error: String(error.stack || error) }; } })()`,
  ).then((result) => {
    if (result?.error) throw new Error(result.error);
    return result;
  });
  const key = (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    if (keyCode === "Return")
      win.webContents.sendInputEvent({ type: "char", keyCode: "\r", modifiers });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  };
  const shot = async (name) => { await wait(450); shots.push(await capture(win, name)); };
  try {
    await win.webContents.executeJavaScript(readProbe("host-management-probe.js") + "\ntrue;");
    await step("prepare");
    await win.webContents.insertText("开发服务器");
    await shot("hosts-editor-light");
    key("Return");
    await step("saved");
    await shot("hosts-list-light");
    await step("staleEditor");
    await step("connectSaved");
    await shot("hosts-connected");
    await win.webContents.insertText("profile_round_trip");
    key("Return");
    await step("guardAndReconnect");
    await step("auditSnapshot");
    await shot("ssh-audit-page");
    await step("closeAuditSnapshot");
    await step("historyAndRemove");
    key("Escape");
    await step("prepareQuick");
    key("Return");
    await step("quickConnected");
    await win.webContents.insertText("quick_round_trip");
    key("Return");
    await step("quickReconnect");
    await step("darkEditor");
    await shot("hosts-editor-dark");
    win.setSize(1024, 640);
    await wait(550);
    await step("compactLayout");
    await shot("hosts-editor-compact");
    key("Tab");
    await step("focusWrapped");
    key("Escape");
    await step("editorEscaped");
    key("Escape");
    await step("finished");
    await step("reducedMotion");
    await shot("ssh-password-dark-reduced");
    await step("endReduced");
  } catch (error) {
    runtimeContext.problems.push({ kind: "host-probe", message: String(error) });
    await shot("hosts-failure");
  }
  const checks = await win.webContents.executeJavaScript("window.__hostManagementProbe?.checks || {}");
  checks["no renderer or host probe errors"] = runtimeContext.problems.filter((item) => item.severity !== "warning").length === 0;
  checks["host management workflow completed"] = await win.webContents.executeJavaScript("window.__hostManagementProbe?.complete === true");
  checks["every visual checkpoint produced an image"] = shots.length >= 5 && shots.every((item) => item.bytes > 10000);
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  runtimeContext.report({ checks, failed, shots, problems: runtimeContext.problems });
  return failed.length === 0;
}

const PROMPT_STATE = `(() => {
  const root = document.querySelector('.ssh-prompt');
  const input = root ? root.querySelector('input') : null;
  return {
    present: Boolean(root && input),
    kind: root ? root.dataset.kind : null,
    inert: root ? root.inert : null,
    hidden: root ? root.hidden : null,
    transition: root ? root.dataset.transition : null,
    renders: root ? root.dataset.renders : null,
    motionCount: root ? Number(root.dataset.motionCount || 0) : 0,
    animations: root ? root.getAnimations({subtree:true}).filter(animation => !(animation instanceof CSSAnimation) && animation.playState === 'running').length : 0,
    aligned: root ? Math.abs(root.querySelector('.ssh-prompt-panel').getBoundingClientRect().left - document.querySelector('#detail-content').getBoundingClientRect().left) < 2 : false,
    marker: input ? input.dataset.probeMark || null : null,
    active: document.activeElement ? (document.activeElement.tagName + '.' + (document.activeElement.className || '')) : null,
    focused: input ? document.activeElement === input : false,
    value: input ? input.value : null,
    valueLength: input ? input.value.length : null,
    title: root ? (root.querySelector('.ssh-prompt-title')?.textContent || '') : null,
  };
})()`;

async function runTypingCheck(win) {
  const steps = [];
  const read = async (label) => {
    const state = await win.webContents.executeJavaScript(PROMPT_STATE);
    steps.push({ label, ...state });
    return state;
  };

  // Go through the picker exactly as a person would.
  await win.webContents.executeJavaScript(
    `window.rhineSshUi.openHosts(); true`,
  );
  await wait(900);
  await win.webContents.executeJavaScript(`
    const row = [...document.querySelectorAll('.ssh-hosts-row')].find(r => r.dataset.alias === 'passhost');
    if (row) row.click();
    true`);
  for (let i = 0; i < 100; i++) {
    if (await win.webContents.executeJavaScript("Boolean(document.querySelector('#host-connect') && !document.querySelector('#detail-content').inert)")) break;
    await wait(50);
  }
  await win.webContents.executeJavaScript("document.querySelector('#host-connect')?.click(); true");
  for (let i = 0; i < 120; i++) {
    await wait(30);
    const state = await win.webContents.executeJavaScript(PROMPT_STATE);
    // Type during entry: the motion must never delay or discard real input.
    if (state.present && state.hidden === false && state.focused)
      break;
  }
  // Mark the field so a re-render can be detected: replacing the input loses
  // whatever the user typed, which is exactly what the report describes.
  await win.webContents.executeJavaScript(
    `(() => { const i = document.querySelector('.ssh-prompt input'); if (i) i.dataset.probeMark = 'original'; return true; })()`,
  );
  const appeared = await read("prompt open");
  for (const char of ["a", "b", "c", "d"]) {
    win.webContents.sendInputEvent({ type: "char", keyCode: char });
    await wait(char === "a" ? 40 : 200);
    await read(`after typing ${char}`);
    if (char === "a") await capture(win, "ssh-password-entering");
  }
  const settled = await read("after typing");
  await capture(win, "ssh-password-ready");
  // Renders are counted cumulatively on the root, so the step that matters is
  // the increase across the typing itself.
  const rendersDuringTyping =
    Number(settled.renders ?? 0) - Number(appeared.renders ?? 0);
  return { appeared, settled, steps, rendersDuringTyping };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function analyze(image) {
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap(); // BGRA
  const stride = Math.max(1, Math.floor(Math.sqrt((width * height) / 40000)));
  const buckets = new Map();
  let count = 0,
    sum = 0,
    min = 255,
    max = 0;
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const i = (y * width + x) * 4;
      const b = bitmap[i],
        g = bitmap[i + 1],
        r = bitmap[i + 2];
      const luma = (r * 299 + g * 587 + b * 114) / 1000;
      sum += luma;
      count++;
      if (luma < min) min = luma;
      if (luma > max) max = luma;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
  }
  const dominant = Math.max(0, ...buckets.values());
  return {
    size: `${width}x${height}`,
    sampled: count,
    meanLuma: +(sum / count).toFixed(1),
    lumaRange: +((max - min) / 255).toFixed(3),
    distinctColors: buckets.size,
    dominantShare: +(dominant / count).toFixed(3),
  };
}

async function capture(win, name) {
  try {
    const image = await win.webContents.capturePage();
    const file = runtimeContext.path.join(
      runtimeContext.path.dirname(runtimeContext.reportPath),
      `desktop-smoke-${name}.png`,
    );
    runtimeContext.fs.writeFileSync(file, image.toPNG());
    return { name, file, bytes: runtimeContext.fs.statSync(file).size, ...analyze(image) };
  } catch (error) {
    return { name, error: String(error) };
  }
}

async function runSmoke(win) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("did-finish-load timeout")),
      30000,
    );
    win.webContents.once("did-finish-load", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await wait(3500);
  const before = await win.webContents.executeJavaScript(PROBE);
  const shotBefore = await capture(win, "entry");
  const dispatched = await win.webContents.executeJavaScript(START);
  await wait(4000);
  const shotBoot = await capture(win, "boot");
  await wait(5000);
  const after = await win.webContents.executeJavaScript(PROBE);
  const shotAfter = await capture(win, "running");
  // Guarded: if the page never finished initialising, this must be reported as
  // a failing check rather than blowing up the whole smoke run.
  const rhineType = await win.webContents.executeJavaScript(
    "typeof window.rhine",
  );
  let hostEntry = false;
  if (rhineType === "object") {
    await win.webContents.executeJavaScript("window.rhine.archive(); true");
    await wait(300);
    await win.webContents.executeJavaScript("document.querySelector('[data-overview-action=collapse]')?.click(); true");
    await wait(300);
    win.webContents.sendInputEvent({
      type: "keyDown",
      keyCode: "S",
      modifiers: ["control", "shift"],
    });
    win.webContents.sendInputEvent({
      type: "keyUp",
      keyCode: "S",
      modifiers: ["control", "shift"],
    });
    await wait(400);
    // A transparent test window can defer its first animation frame. Request
    // one, then inspect the visible surface rather than only its open flag.
    await win.webContents.capturePage();
    hostEntry = await win.webContents.executeJavaScript(
      `(async () => {
        for (let i = 0; i < 50; i++) {
          const overview = document.querySelector('.ssh-overview');
          if (overview && !overview.hidden && !overview.inert && overview.dataset.collapsed !== 'true' &&
              overview.dataset.transition === 'open' && overview.querySelector('[data-overview-page="hosts"]')?.getAttribute('aria-current') === 'page')
            return overview.getBoundingClientRect().height > 0;
          const panel = document.querySelector('.ssh-hosts');
          if (panel && document.querySelector('#detail-ui')?.dataset.transition === 'open' && !document.querySelector('#detail-content')?.inert)
            return Boolean(window.rhineSshUi?.hostsOpen) &&
              getComputedStyle(panel).opacity === '1' && panel.getBoundingClientRect().height > 0;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return false;
      })()`,
    );
    await win.webContents.executeJavaScript(
      "window.rhineSshUi?.closeHosts(); true",
    );
  }

  const checks = {
    // Dev mode deliberately loads from the Vite server instead of file://.
    "loads from the app origin":
      before.protocol === "file:" || Boolean(runtimeContext.DEV_URL),
    "desktop flag set": before.desktopFlag === "true",
    "preload bridge exposed": before.desktopBridge === true,
    "stage rendered": before.hasStage && before.navButtons > 0,
    // The entry point of the whole SSH workflow. Its absence is what a wrong
    // build mode looked like from the outside, so it is asserted directly.
    "host list opens from its keyboard shortcut":
      before.sessionEntry === true && hostEntry,
    "session layer loaded": before.rhineSshLoaded === true,
    "PWA surface removed": before.pwaSection === false,
    "no service worker": before.serviceWorker === false,
    "entry gate accepted input": dispatched === "clicked",
    "3D scene live (WebGL)": after.canvases > 0,
    "startup entered boot":
      after.stageMode === "boot" ||
      after.stageMode === "archive" ||
      after.stageMode === "detail",
    "loading overlay retired": after.loading === false,
    // A blank surface is one flat colour: no luma spread, one bucket.
    // The entry gate is deliberately near-flat (mean luma ~228 of 255), so
    // dominantShare alone would misjudge it; luma spread is the honest signal.
    "entry screen not blank":
      shotBefore.lumaRange > 0.3 && shotBefore.distinctColors > 5,
    "boot screen not blank":
      shotBoot.lumaRange > 0.3 && shotBoot.distinctColors > 5,
    "running screen not blank":
      shotAfter.lumaRange > 0.3 && shotAfter.distinctColors > 5,
    // The caption belongs to Windows, so it can never appear in a capturePage
    // shot. What can be asserted is that the overlay carries the palette the
    // renderer reported, and that the window has a region to be dragged by.
    "window caption follows the application palette": (() => {
      if (!runtimeContext.FRAMELESS) return true;
      const wanted = after.colorTheme === "dark" ? runtimeContext.CHROME.dark : runtimeContext.CHROME.light;
      return (
        runtimeContext.appliedChrome?.error === null &&
        runtimeContext.appliedChrome.theme === after.colorTheme &&
        runtimeContext.appliedChrome.color === wanted.color &&
        runtimeContext.appliedChrome.symbolColor === wanted.symbolColor &&
        runtimeContext.appliedChrome.height === runtimeContext.CHROME_HEIGHT
      );
    })(),
    "the renderer reports its theme to the window": after.themeReported === true,
    "the frameless window has a drag region the caption's height":
      !runtimeContext.FRAMELESS ||
      (after.dragRegion?.region === "drag" &&
        Math.abs(after.dragRegion.height - runtimeContext.CHROME_HEIGHT) <= 1),
  };
  const failed = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  const onlyBenign = runtimeContext.problems.filter(
    (p) =>
      !(
        p.kind === "console" &&
        /Autofill|DevTools|Electron Security Warning|THREE\.WebGLProgram|X4122/i.test(
          p.message,
        )
      ),
  );

  console.log(
    "SMOKE_JSON " +
      JSON.stringify(
        {
          checks,
          failed,
          before,
          after,
          // The caption is invisible to capturePage and Electron has no getter
          // for it, so the applied palette is reported here or not at all.
          chrome: {
            frameless: runtimeContext.FRAMELESS,
            applied: runtimeContext.appliedChrome,
            content: win.getContentSize(),
            window: win.getSize(),
          },
          shots: [shotBefore, shotBoot, shotAfter],
          problems: onlyBenign,
        },
        null,
        2,
      ),
  );
  runtimeContext.report({
    checks,
    failed,
    before,
    after,
    shots: [shotBefore, shotBoot, shotAfter],
    problems: onlyBenign,
  });
  return (
    failed.length === 0 &&
    onlyBenign.filter((p) => p.severity !== "warning").length === 0
  );
}
return { PROBE, START, readProbe, runSessionSmoke, runMultisessionSmoke, runTerminalDeckSmoke, runEditorSmoke, runHostManagementSmoke, PROMPT_STATE, runTypingCheck, wait, analyze, capture, runSmoke };
};
