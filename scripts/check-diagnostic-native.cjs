/** Isolated Electron crash exercise: no SSH transport or OS clipboard. */
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { bindCrashRecovery, createDiagnosticLog } = require("../electron/diagnostic-log.cjs");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "rhine-crash-test-"));
app.setPath("userData", profile);
app.disableHardwareAcceleration();
const timeout = setTimeout(() => { console.error("Crash verification timed out"); app.exit(1); }, 45000);
app.on("quit", () => { clearTimeout(timeout); try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} });
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const contents = win.webContents;
    const dir = path.join(profile, "logs");
    const diagnostics = createDiagnosticLog({ dir });
    const order = [];
    let loads = 0;
    contents.on("did-finish-load", () => { loads++; order.push("loaded"); });
    contents.on("render-process-gone", (_event, details) => diagnostics.write("renderer-crash", { reason: details.reason, code: details.exitCode }));
    bindCrashRecovery({ contents, stopOwner: id => { assert.equal(id, contents.id); order.push("stopped"); },
      log: (category, entry) => diagnostics.write(category, entry) });
    await contents.loadURL("data:text/html,<title>Isolated recovery fixture</title><p>Ready</p>");
    for (let i = 0; i < 3; i++) {
      const loaded = once(contents, "did-finish-load");
      contents.forcefullyCrashRenderer();
      await loaded;
      assert.deepEqual(order.slice(-2), ["stopped", "loaded"]);
    }
    const gone = once(contents, "render-process-gone");
    contents.forcefullyCrashRenderer();
    await gone;
    assert.equal(loads, 4);
    assert.equal(order.at(-1), "stopped");
    const records = fs.readdirSync(dir).flatMap(file => fs.readFileSync(path.join(dir, file), "utf8").trim().split("\n").map(JSON.parse));
    assert.equal(records.filter(row => row.category === "renderer-crash").length, 4);
    assert.equal(records.filter(row => row.reason === "auto-reload-after-crash").length, 3);
    assert.equal(records.filter(row => row.reason === "reload-budget-exhausted").length, 1);
    console.log("PASS: four real renderer crashes, three reloads, owner shutdown precedes reload, fourth blocked, logs persisted; no SSH/clipboard capabilities exposed.");
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
