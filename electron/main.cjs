/**
 * Desktop shell entry point.
 *
 * Runs the existing 3D app with a sandboxed preload and scoped SSH/ConPTY
 * sessions. Named IPC owns config reading, record storage and native exports.
 *
 * Two ways to load:
 *   RHINE_DEV_URL=http://127.0.0.1:5173  → dev server (hot reload)
 *   otherwise                            → dist-desktop/index.html built with
 *                                          `vite build --mode desktop`
 */
const { app, BrowserWindow, clipboard, dialog, ipcMain, shell, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { fileURLToPath } = require("node:url");
const { PtySession } = require("./session.cjs");
const { SessionRegistry } = require("./session-registry.cjs");
const { lifecycleRecord } = require("./session-checkpoint.cjs");
const { parseHostConfig } = require("./ssh-config.cjs");
const { HostProfiles, keyFor } = require("./host-profiles.cjs");
const { recordPath, pruneRecords } = require("./session-records.cjs");
const { buildSshArgs, resolveSshPath } = require("./ssh-args.cjs");
const { createTextClipboard } = require("./terminal-clipboard.cjs");
const { SshServices, effectiveEndpoint, serviceExecutable } = require("./ssh-services.cjs");
const { CredentialVault, inspectPrivateKey } = require("./credential-vault.cjs");
const { createDiagnosticLog, bindCrashRecovery, sanitize } = require("./diagnostic-log.cjs");

const DEV_URL = process.env.RHINE_DEV_URL || "";
const SMOKE =
  process.argv.includes("--smoke") || process.env.RHINE_SMOKE === "1";
/** Developer diagnostics: --debug or RHINE_DEBUG=1 mirrors renderer consoles. */
const DEBUG =
  process.argv.includes("--debug") || process.env.RHINE_DEBUG === "1";
const SESSION_SMOKE = process.argv.includes("--session-smoke");
const TERMINAL_SMOKE = SESSION_SMOKE && process.argv.includes("--terminal-deck-only");
const HOST_SMOKE = SESSION_SMOKE && process.argv.includes("--host-management-only");
const MULTI_SMOKE = SESSION_SMOKE && process.argv.includes("--multisession-only");
const EDITOR_SMOKE = SESSION_SMOKE && process.argv.includes("--editor-only");
const CREDENTIAL_SMOKE = SESSION_SMOKE && process.argv.includes("--credentials-only");
const root = path.join(__dirname, "..");
// The desktop bundle has its own output directory: `npm run build` (web) and
// the desktop build used to share `dist/`, so whichever ran last silently
// decided what the desktop smoke loaded.
const outputDir = path.join(root, "dist-desktop");
const indexPath = path.join(outputDir, "index.html");
/** Temp profile created for a smoke run, cleaned up when it ends. */
let smokeProfile = null;
if (SMOKE || SESSION_SMOKE) {
  // Isolate the smoke's profile so session records do not land in the user's
  // real one — but keep it OUT of the project tree. A Chromium profile inside
  // `dist-desktop/` sat under the dev server's file watcher, and its locked
  // `Network/Cookies` crashed Vite with EBUSY mid-run.
  const requested = CREDENTIAL_SMOKE && process.env.RHINE_CREDENTIAL_PROFILE;
  if (requested && (!path.resolve(requested).startsWith(path.join(root, ".tools", "ssh-fixtures") + path.sep) || path.basename(requested) !== "credentials-profile"))
    throw new Error("Credential smoke profile must be inside its isolated fixture directory");
  const profile = requested || fs.mkdtempSync(path.join(os.tmpdir(), "rhine-smoke-"));
  fs.mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
  app.setPath("sessionData", profile);
  smokeProfile = requested ? null : profile;
} else {
  /**
   * Chromium puts HTTP and GPU caches under `sessionData`. Its default is the
   * roaming `userData` directory on Windows, which is also the directory most
   * likely to be redirected, synchronised or left with a locked `Cache.old`.
   * Keep durable settings in userData, but put disposable Chromium state in a
   * local, explicitly-created directory. This must run before `ready` and
   * before the first BrowserWindow, otherwise Chromium has already selected
   * the failing cache path.
   */
  const localRoot = process.env.LOCALAPPDATA || os.tmpdir();
  const profileName = path.basename(app.getPath("userData"));
  const sessionData = path.join(localRoot, profileName, "ChromiumSession-v2");
  try {
    fs.mkdirSync(sessionData, { recursive: true });
    app.setPath("sessionData", sessionData);
  } catch (error) {
    // A cache is optional. Preserve startup if an unusually locked-down host
    // rejects the preferred local directory; Chromium can use its fallback.
    console.warn("Chromium 缓存目录不可用:", String(error?.message || error));
  }
}

// Two Chromium processes writing the same profile race while renaming Cache
// and GPUCache on Windows (ERROR_ACCESS_DENIED / 0x5). This app exposes one
// desktop window, so a second launch should activate it rather than open a
// second writer against the same profile.
const hasSingleInstanceLock =
  SMOKE || SESSION_SMOKE || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
// Electron is a GUI-subsystem binary on Windows, so stdout is not reliably
// attached to the parent console. Always land the report on disk as well.
const reportPath =
  process.env.RHINE_SMOKE_REPORT ||
  path.join(
    outputDir,
    EDITOR_SMOKE ? "desktop-editor-smoke.json" : MULTI_SMOKE ? "desktop-multisession-smoke.json" : HOST_SMOKE ? "desktop-hosts-smoke.json" : TERMINAL_SMOKE ? "desktop-terminal-smoke.json" : SESSION_SMOKE ? "desktop-session-smoke.json" : "desktop-smoke.json",
  );

function report(payload) {
  try {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(payload, null, 2), "utf8");
  } catch (error) {
    console.error("failed to write smoke report:", error);
  }
  console.log("SMOKE_JSON " + JSON.stringify(payload));
}

/** Renderer problems we want to surface instead of silently showing white. */
const problems = [];
const trustedWindows = new Set();
/**
 * Persistent diagnostics under userData/logs. Created lazily because
 * app.getPath("userData") is only meaningful after app is ready — smoke runs
 * have already repointed it by then, so create on first window instead.
 */
let diagnostics = null;
function diagnosticLog() {
  if (!diagnostics && !SMOKE && !SESSION_SMOKE)
    diagnostics = createDiagnosticLog({
      dir: path.join(app.getPath("userData"), "logs"),
    });
  return diagnostics;
}
function logDiagnostic(category, entry = {}) {
  try {
    const clean = sanitize(entry);
    diagnosticLog()?.write(category, clean);
    if (DEBUG && !SMOKE && !SESSION_SMOKE)
      console.log(`DIAG[${category}] ${JSON.stringify(clean)}`);
  } catch {
    /* diagnostics must never break the caller */
  }
}

function appUrl(url) {
  try {
    const value = new URL(url);
    if (DEV_URL) return value.origin === new URL(DEV_URL).origin;
    value.hash = "";
    value.search = "";
    return (
      value.protocol === "file:" &&
      path.resolve(fileURLToPath(value)).toLowerCase() ===
        indexPath.toLowerCase()
    );
  } catch {
    return false;
  }
}

function trustedSender(event) {
  return (
    trustedWindows.has(event.sender.id) &&
    event.senderFrame === event.sender.mainFrame &&
    appUrl(event.senderFrame.url)
  );
}

function describeConsoleEvent(args) {
  const [first, level, message, line, sourceId] = args;
  // Electron ≥37 passes a single details object; older builds pass positionals.
  const raw =
    first && typeof first === "object" && "message" in first ? first : null;
  const rawLevel = raw ? raw.level : level;
  const text = raw ? raw.message : message;
  const severity =
    typeof rawLevel === "string"
      ? rawLevel
      : (["debug", "info", "warning", "error"][rawLevel] ?? "info");
  return {
    severity,
    message: String(text ?? "").slice(0, 1500),
    line: raw ? raw.lineNumber : line,
    source: String((raw ? raw.sourceId : sourceId) ?? "") || undefined,
  };
}

function watchRenderer(contents) {
  contents.on("console-message", (...args) => {
    const entry = describeConsoleEvent(args);
    if (process.env.RHINE_SMOKE_VERBOSE === "1" && (SMOKE || SESSION_SMOKE))
      console.log(
        `RENDERER[${entry.severity}] ${entry.source ?? ""}:${entry.line ?? ""} ${entry.message}`,
      );
    if ((SMOKE || SESSION_SMOKE) && (entry.severity === "error" || entry.severity === "warning"))
      problems.push({ kind: "console", ...entry });
    if (DEBUG || entry.severity === "error" || entry.severity === "warning")
      logDiagnostic(entry.severity === "error" ? "console-error" : entry.severity === "warning" ? "console-warning" : "console-info", {
        level: entry.severity,
        line: entry.line,
        source: !entry.source ? "unknown" : appUrl(entry.source) || entry.source.startsWith("file:") ? "app" : "external",
      });
  });
  contents.on("did-fail-load", (_event, code, description, url) => {
    if (SMOKE || SESSION_SMOKE) problems.push({ kind: "did-fail-load", code, description, url });
    logDiagnostic("did-fail-load", { level: "error", code });
  });
  contents.on("render-process-gone", (_event, details) => {
    if (SMOKE || SESSION_SMOKE) problems.push({ kind: "render-process-gone", reason: details.reason });
    logDiagnostic("renderer-crash", {
      level: "error",
      reason: details.reason,
      code: details.exitCode,
    });
  });
  contents.on("preload-error", (_event, preloadPath, error) => {
    problems.push({
      kind: "preload-error",
      preloadPath,
      message: String(error),
    });
    logDiagnostic("preload-error", {
      level: "error",
      reason: path.basename(preloadPath),
      message: String(error),
    });
  });
  contents.on("did-finish-load", () => logDiagnostic("app", { level: "info", reason: "load-finished" }));
  contents.on("responsive", () => logDiagnostic("app", { level: "info", reason: "responsive" }));
  contents.on("unresponsive", () => {
    problems.push({ kind: "unresponsive" });
    logDiagnostic("renderer-hang", { level: "warning" });
  });
}

app.on("child-process-gone", (_event, details) => {
  if (SMOKE || SESSION_SMOKE) problems.push({ kind: "child-process-gone", reason: details.reason, type: details.type });
  logDiagnostic(details.type === "GPU" ? "gpu" : "child-process", {
    level: "error", reason: details.reason, code: details.exitCode,
  });
});

// ── session ─────────────────────────────────────────────────────────────────
let sessions = null;
let quitApproved = false;
let closeQuestion = null;
/** Test-seam capabilities; a stand-in that cannot report a channel is skipped. */
const seam = { consoleChild: false };

/**
 * The system ssh, plus an explicit test seam. `RHINE_SSH_PREFIX` lets the
 * session checks drive a stand-in through the real code path, including the
 * arguments this process builds — nothing else may set the executable.
 */
function resolveSshCommand() {
  const file = process.env.RHINE_SSH_PATH || resolveSshPath();
  const raw = process.env.RHINE_SSH_PREFIX;
  return { file, prefixArgs: raw ? raw.split("\u0000").filter(Boolean) : [] };
}

function logPathFor(target, id) {
  const dir = path.join(app.getPath("userData"), "ssh-logs");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safe = target.replace(/[^A-Za-z0-9._@-]/g, "_").slice(0, 60);
  return path.join(dir, `${id || `${stamp}-${safe}`}.log`);
}

function send(target, channel, payload) {
  if (!target.isDestroyed()) target.send(channel, payload);
}

function confirmShutdown(win) {
  if (closeQuestion) return closeQuestion;
  const active = sessions?.active() ?? [];
  if (!active.length) return Promise.resolve(true);
  const jobs = active.reduce((total, entry) => total + (entry.services?.snapshot().jobs ?? [])
    .filter(job => !["completed", "canceled", "failed"].includes(job.state)).length, 0);
  closeQuestion = dialog.showMessageBox(win, {
    type: "question", title: "结束 SSH 工作区", message: `还有 ${active.length} 个 SSH 会话正在运行`,
    detail: jobs ? `退出将断开连接并取消 ${jobs} 项未完成传输。` : "退出将断开这些连接；会话记录会保留。",
    buttons: ["继续工作", "断开并退出"], defaultId: 0, cancelId: 0, noLink: true,
  }).then(result => result.response === 1).finally(() => { closeQuestion = null; });
  return closeQuestion;
}


/**
 * Locate a real console-capable Node for the session stand-in.
 *
 * Measured: a pty-hosted `electron.exe` delivers zero bytes on its stdout with
 * or without ELECTRON_RUN_AS_NODE, because it is a GUI-subsystem binary that
 * detaches from the pseudoconsole. `node.exe` delivers normally. This only
 * affects the test seam — production spawns `ssh.exe`, a console application.
 */
function resolveNodeForTest() {
  const explicit = process.env.RHINE_NODE_PATH || process.env.npm_node_execpath;
  if (explicit && fs.existsSync(explicit)) return explicit;
  try {
    const found = require("node:child_process")
      .execSync("where node", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && fs.existsSync(line));
    if (found) return found;
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * The window's own chrome.
 *
 * Windows draws the caption itself, so the only way to stop it being the default
 * white is to take the title bar away and colour the overlay Electron puts back
 * in its place. The overlay accepts `#RRGGBBAA`, and a fully transparent one
 * lets the page show through — which is the only value that can be right for
 * every surface at once, since the strip sits above a three-dimensional array,
 * an SSH terminal and a settings sheet that all paint their own background.
 *
 * Only the symbols still need a colour: they are drawn on top of whatever is
 * behind, so they have to contrast with the page rather than with the overlay.
 * The renderer reports which of the two it needs over `shell:theme`.
 */
const CHROME = {
  light: { color: "#00000000", symbolColor: "#202d32" },
  dark: { color: "#00000000", symbolColor: "#e2e9e7" },
};
/** Matches `.titlebar-drag` in src/app/style.css, which is what makes the window
 *  movable once it has no native caption. The width the overlay keeps for its
 *  buttons is mirrored in src/platform/desktop/desktop.ts, which is where a full-window surface
 *  is told how much room to leave for them. */
const CHROME_HEIGHT = 40;
const FRAMELESS = process.platform === "win32";

/**
 * What the caption is currently set to.
 *
 * Electron has `setTitleBarOverlay` but no getter for it — measured on 44.3.0,
 * `typeof win.getTitleBarOverlay === "undefined"` — so the applied value is
 * recorded here. Without it a caption that silently failed to update is
 * indistinguishable from one that updated correctly. The smoke run reports it.
 */
let appliedChrome = null;

/** The renderer owns the theme setting; the caption is drawn by the OS, so main
 *  has to be told. Only the two palettes above are reachable: the payload is a
 *  name, never a colour. */


function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: !(SMOKE || SESSION_SMOKE),
    backgroundColor: "#e8e5e1",
    title: "RHINE LAB · ANALYSIS OS",
    icon: path.join(__dirname, "assets", "app-icon.ico"),
    autoHideMenuBar: true,
    ...(FRAMELESS
      ? {
          titleBarStyle: "hidden",
          titleBarOverlay: { ...CHROME.light, height: CHROME_HEIGHT },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep the render loop alive; the smoke window is never focused.
      backgroundThrottling: false,
    },
  });
  trustedWindows.add(win.webContents.id);
  const contentsId = win.webContents.id;
  win.on("close", event => {
    if (quitApproved || SMOKE || SESSION_SMOKE || !sessions?.active(contentsId).length) return;
    event.preventDefault();
    void confirmShutdown(win).then(confirmed => {
      if (!confirmed || win.isDestroyed()) return;
      quitApproved = true;
      sessions.stopOwner(contentsId);
      win.close();
    });
  });
  win.on("closed", () => {
    trustedWindows.delete(contentsId);
    sessions?.stopOwner(contentsId);
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!appUrl(url)) event.preventDefault();
  });
  // A fresh renderer has no old session bank. Close its previous native owners
  // on reload as well as on crashes, without treating hash navigation as exit.
  win.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) sessions?.stopOwner(contentsId);
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  // Crash recovery: rebuild the window after a renderer crash. The registry
  // already stopped this window's native sessions, so nothing replays; the
  // fresh page never reconnects on its own — the user reopens sessions.
  bindCrashRecovery({
    contents: win.webContents,
    stopOwner: id => sessions?.stopOwner(id),
    log: logDiagnostic,
    enabled: !SMOKE && !SESSION_SMOKE,
  });
  if (SMOKE || SESSION_SMOKE) {
    // A window created with `show: false` reports document.hidden === true,
    // which parks the entry gate in its "sound not ready" error branch. Stay
    // shown but fully transparent instead.
    win.setOpacity(0);
    win.showInactive();
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    else if (url.startsWith("file:")) {
      try {
        const file = fileURLToPath(url);
        if (
          file.startsWith(outputDir + path.sep) &&
          path.extname(file).toLowerCase() === ".pdf"
        )
          void shell.openPath(file);
      } catch {
        /* Unrecognised links have no native action. */
      }
    }
    return { action: "deny" };
  });
  watchRenderer(win.webContents);
  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadFile(indexPath);
  return win;
}





/** Renderer probes live as real files under electron/probes/ (see that folder). */


/**
 * Drives the whole chain the way the UI will: renderer → preload bridge → IPC
 * → main (pty + stream split) → IPC → renderer → state machine. The stand-in
 * keeps it offline and deterministic; every other component is the real one.
 */






/**
 * The reported bug: after editing a remote file, the editor's 返回·保留草稿
 * button "does nothing". This drives the whole thing in the real desktop
 * window — frameless caption overlay, scaled stage — with REAL mouse input
 * events, and records what every click actually hit.
 */


/** Real host editor, IPC persistence and ConPTY; only the SSH peer is a fixture. */


/**
 * Types into the password field with real input events.
 *
 * Synthetic `KeyboardEvent`s cannot reproduce the user's report: untrusted
 * events have no default action, so a character never actually lands in the
 * field. `sendInputEvent` goes through the browser's input pipeline the way a
 * keystroke does, which is the only way to see focus or re-render problems.
 */






/**
 * Visual evidence: a run with no console errors can still be a blank window.
 * Measure the captured bitmap instead of trusting it — a uniform surface has a
 * dominant-colour share near 1 and almost no luma spread.
 */


/** Visual evidence: a "no console errors" run can still be a blank window. */




/**
 * The taskbar groups and picks its icon by AppUserModelID. Unpackaged Electron
 * has none, so the button is Electron's rather than the window's; naming the
 * app here is what makes `BrowserWindow({ icon })` reach the taskbar too.
 * Stable on purpose — changing it strands any existing pinned shortcut.
 */
if (process.platform === "win32") app.setAppUserModelId("com.rhinelab.analysis-os");

app.on("second-instance", () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

const smokeContext = {
  get fs() { return fs; },
  get path() { return path; },
  get MULTI_SMOKE() { return MULTI_SMOKE; },
  get HOST_SMOKE() { return HOST_SMOKE; },
  get TERMINAL_SMOKE() { return TERMINAL_SMOKE; },
  get EDITOR_SMOKE() { return EDITOR_SMOKE; },
  get outputDir() { return outputDir; },
  get app() { return app; },
  get seam() { return seam; },
  get problems() { return problems; },
  get report() { return report; },
  get sessions() { return sessions; },
  set sessions(value) { sessions = value; },
  get CHROME_HEIGHT() { return CHROME_HEIGHT; },
  get reportPath() { return reportPath; },
  get DEV_URL() { return DEV_URL; },
  get FRAMELESS() { return FRAMELESS; },
  get CHROME() { return CHROME; },
  get appliedChrome() { return appliedChrome; },
  set appliedChrome(value) { appliedChrome = value; },
  get electronDir() { return __dirname; },
};
const { PROBE, START, readProbe, runSessionSmoke, runMultisessionSmoke, runTerminalDeckSmoke, runEditorSmoke, runHostManagementSmoke, PROMPT_STATE, runTypingCheck, wait, analyze, capture, runSmoke } = require("./diagnostics/smoke.cjs")(smokeContext);

const ipcContext = {
  get EDITOR_SMOKE() { return EDITOR_SMOKE; },
  get ipcMain() { return ipcMain; },
  get trustedSender() { return trustedSender; },
  get sessions() { return sessions; },
  set sessions(value) { sessions = value; },
  get path() { return path; },
  get app() { return app; },
  get HostProfiles() { return HostProfiles; },
  get CredentialVault() { return CredentialVault; },
  get safeStorage() { return safeStorage; },
  get inspectPrivateKey() { return inspectPrivateKey; },
  get serviceExecutable() { return serviceExecutable; },
  get SessionRegistry() { return SessionRegistry; },
  get SESSION_SMOKE() { return SESSION_SMOKE; },
  get SMOKE() { return SMOKE; },
  get CREDENTIAL_SMOKE() { return CREDENTIAL_SMOKE; },
  get effectiveEndpoint() { return effectiveEndpoint; },
  get PtySession() { return PtySession; },
  get SshServices() { return SshServices; },
  get logPathFor() { return logPathFor; },
  get send() { return send; },
  get fs() { return fs; },
  get lifecycleRecord() { return lifecycleRecord; },
  get logDiagnostic() { return logDiagnostic; },
  get resolveSshCommand() { return resolveSshCommand; },
  get buildSshArgs() { return buildSshArgs; },
  get createTextClipboard() { return createTextClipboard; },
  get clipboard() { return clipboard; },
  get pruneRecords() { return pruneRecords; },
  get outputDir() { return outputDir; },
  get BrowserWindow() { return BrowserWindow; },
  get dialog() { return dialog; },
  get parseHostConfig() { return parseHostConfig; },
  get keyFor() { return keyFor; },
  get recordPath() { return recordPath; },
  get CHROME() { return CHROME; },
  get CHROME_HEIGHT() { return CHROME_HEIGHT; },
  get appliedChrome() { return appliedChrome; },
  set appliedChrome(value) { appliedChrome = value; },
  get electronDir() { return __dirname; },
};
const { registerSessionIpc, registerShellIpc } = require("./ipc/register.cjs")(ipcContext);

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  if (CREDENTIAL_SMOKE && (!process.env.RHINE_CREDENTIAL_FIXTURE || !process.env.RHINE_SSH_CONFIG)) throw new Error("Isolated SSH credential fixture is required");
  if ((SMOKE || SESSION_SMOKE) && !CREDENTIAL_SMOKE) {
    // Drive a stand-in through the real code path: same argv builder, same pty,
    // same stream split, same IPC. Only the network and the binary are replaced.
    const node = resolveNodeForTest();
    process.env.RHINE_SSH_PATH = node || process.execPath;
    process.env.RHINE_SSH_PREFIX = path.join(
      root,
      "scripts",
      "fixtures",
      "fake-ssh.mjs",
    );
    seam.consoleChild = Boolean(node);
    if (!node)
      problems.push({
        kind: "test-seam",
        message:
          "no console-capable node found; terminal byte checks will be skipped",
      });
    // Deterministic host list, and a stand-in that stays up long enough for the
    // terminal checks to run.
    process.env.RHINE_SSH_CONFIG = path.join(
      root,
      "scripts",
      "fixtures",
      "ssh-config",
    );
    process.env.FAKE_SSH_HOLD_MS = process.env.FAKE_SSH_HOLD_MS || (HOST_SMOKE || MULTI_SMOKE || EDITOR_SMOKE ? "90000" : TERMINAL_SMOKE ? "30000" : "8000");
  }
  registerShellIpc();
  registerSessionIpc();
  const win = createWindow();
  if (!SMOKE && !SESSION_SMOKE) {
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
    return;
  }
  let ok = false;
  try {
    ok = CREDENTIAL_SMOKE
      ? await require("../scripts/check/ssh-credentials-native-checks.cjs").run({ win, sessions, app, report, problems })
      : SESSION_SMOKE ? await runSessionSmoke(win) : await runSmoke(win);
  } catch (error) {
    problems.push({ kind: "smoke-threw", message: String(error?.stack || error) });
    // `before`/`after` belong to the other smoke; this one needs its own result
    // so a throw still says what the probe observed.
    report({ checks: {}, skipped: [], failed: ["smoke threw"], problems });
  }
  sessions?.stopAll();
  for (const entry of [...(sessions?.entries.values() ?? [])]) sessions.release(entry);
  app.exit(ok ? 0 : 1);
});

app.on("quit", () => {
  if (!smokeProfile) return;
  try {
    fs.rmSync(smokeProfile, { recursive: true, force: true });
  } catch {
    /* the OS will clean its own temp directory */
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", event => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!quitApproved && !SMOKE && !SESSION_SMOKE && win && sessions?.active().length) {
    event.preventDefault();
    void confirmShutdown(win).then(confirmed => {
      if (confirmed) { quitApproved = true; sessions.stopAll(); app.quit(); }
    });
    return;
  }
  sessions?.stopAll();
});
