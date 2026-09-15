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

const DEV_URL = process.env.RHINE_DEV_URL || "";
const SMOKE =
  process.argv.includes("--smoke") || process.env.RHINE_SMOKE === "1";
const SESSION_SMOKE = process.argv.includes("--session-smoke");
const TERMINAL_SMOKE = SESSION_SMOKE && process.argv.includes("--terminal-deck-only");
const HOST_SMOKE = SESSION_SMOKE && process.argv.includes("--host-management-only");
const MULTI_SMOKE = SESSION_SMOKE && process.argv.includes("--multisession-only");
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
}
// Electron is a GUI-subsystem binary on Windows, so stdout is not reliably
// attached to the parent console. Always land the report on disk as well.
const reportPath =
  process.env.RHINE_SMOKE_REPORT ||
  path.join(
    outputDir,
    MULTI_SMOKE ? "desktop-multisession-smoke.json" : HOST_SMOKE ? "desktop-hosts-smoke.json" : TERMINAL_SMOKE ? "desktop-terminal-smoke.json" : SESSION_SMOKE ? "desktop-session-smoke.json" : "desktop-smoke.json",
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
    if (process.env.RHINE_SMOKE_VERBOSE === "1")
      console.log(
        `RENDERER[${entry.severity}] ${entry.source ?? ""}:${entry.line ?? ""} ${entry.message}`,
      );
    if (entry.severity === "error" || entry.severity === "warning")
      problems.push({ kind: "console", ...entry });
  });
  contents.on("did-fail-load", (_event, code, description, url) => {
    problems.push({ kind: "did-fail-load", code, description, url });
  });
  contents.on("render-process-gone", (_event, details) => {
    problems.push({ kind: "render-process-gone", reason: details.reason });
  });
  contents.on("preload-error", (_event, preloadPath, error) => {
    problems.push({
      kind: "preload-error",
      preloadPath,
      message: String(error),
    });
  });
}

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
function registerSessionIpc() {
  const handle = (channel, listener) => ipcMain.handle(channel, (event, ...args) => {
    if (!trustedSender(event)) return { ok: false, error: "请求来源无效" };
    const id = args[0]?.sessionId;
    if (id !== undefined && !sessions.owns(event.sender, id)) return { ok: false, error: "会话已结束或不属于当前窗口" };
    return listener(event, ...args);
  });
  const recordsDir = () => path.join(app.getPath("userData"), "ssh-logs");
  const profiles = new HostProfiles(path.join(app.getPath("userData"), "ssh-hosts.json"));
  const vault = new CredentialVault(path.join(app.getPath("userData"), "ssh-credentials.json"), safeStorage,
    (content, passphrase) => inspectPrivateKey(serviceExecutable(), content, passphrase));
  try { vault.cleanupStale(); } catch (error) { console.error("密钥临时文件清理失败:", error.message); }
  sessions = new SessionRegistry({
    vault,
    resolveLaunch: descriptor => profiles.resolve(descriptor),
    resolveEndpoint: launch => (!SESSION_SMOKE && !SMOKE) || CREDENTIAL_SMOKE ? effectiveEndpoint(launch) : Promise.resolve(undefined),
    createPty: callbacks => new PtySession(callbacks),
    createServices: options => new SshServices({ ...options,
      disabled: !CREDENTIAL_SMOKE && (SESSION_SMOKE || SMOKE) && process.env.RHINE_SERVICES_SMOKE !== "1" }),
    logPathFor, send,
    checkpoint: (entry, info) => {
      try {
        if (!entry.logPath) return;
        const file = entry.logPath.replace(/\.log$/, ".json");
        let existing = null;
        try { existing = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* first checkpoint */ }
        const record = lifecycleRecord(entry, info, existing);
        if (record) fs.writeFileSync(file, JSON.stringify(record, null, 2), "utf8");
      } catch (error) {
        console.error("SSH 会话记录未能保存:", String(error?.message || error));
      }
    },
    command: (launch, logPath) => {
      const { file, prefixArgs } = resolveSshCommand();
      return { file, args: [...prefixArgs,
        ...(((!SESSION_SMOKE && !SMOKE) || CREDENTIAL_SMOKE) && process.env.RHINE_SSH_CONFIG ? ["-F", process.env.RHINE_SSH_CONFIG] : []),
        ...buildSshArgs({ ...launch, logPath })] };
    },
  });
  // Exercise the real IPC/preload in smoke runs without touching the user's
  // system clipboard, which may contain private text or non-text formats.
  let smokeClipboardText = "";
  const textClipboard = createTextClipboard(SMOKE || SESSION_SMOKE ? {
    readText: () => smokeClipboardText,
    writeText: (text) => { smokeClipboardText = text; },
  } : clipboard);
  handle("terminal:clipboard-read", () => textClipboard.readText());
  handle("terminal:clipboard-write", (_event, text) => textClipboard.writeText(text));
  const prune = () => {
    try {
      return pruneRecords(recordsDir(), {
        exclude: sessions.logPaths,
      });
    } catch (error) {
      return {
        ok: false,
        removed: 0,
        bytesFreed: 0,
        errors: [String(error.message || error)],
      };
    }
  };
  prune();
  handle("records:prune", () => prune());

  /**
   * Persist the session record next to its raw event log. The renderer owns
   * parsing; writing files stays here.
   */
  handle("session:record", (_event, record) => {
    try {
      const dir = recordsDir();
      fs.mkdirSync(dir, { recursive: true });
      const id = String(record?.id ?? Date.now()).replace(
        /[^A-Za-z0-9._-]/g,
        "_",
      );
      const file = path.join(dir, `${id}.json`);
      fs.writeFileSync(file, JSON.stringify(record, null, 2), "utf8");
      prune();
      return { ok: true, file };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  });

  /**
   * Export the human-readable record. `target` lets automation skip the dialog;
   * without it the user picks a location, which is what a desktop app should do.
   */
  handle("session:export", async (event, payload) => {
    try {
      const { suggestedName, text, target } = payload ?? {};
      if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 16 * 1024 * 1024) return { ok: false, error: "导出文本超过 16 MiB 或格式无效" };
      let file =
        (SMOKE || SESSION_SMOKE) && typeof target === "string" && target
          ? target
          : null;
      if (file && path.dirname(path.resolve(file)) !== outputDir)
        return { ok: false, error: "测试导出路径无效" };
      if (!file) {
        const window = BrowserWindow.fromWebContents(event.sender);
        const result = await dialog.showSaveDialog(window, {
          title: String(suggestedName).endsWith(".json") ? "导出 SSH 配置" : "导出会话记录",
          defaultPath: path.join(
            app.getPath("documents"),
            String(suggestedName || "ssh-session.txt"),
          ),
          filters: String(suggestedName).endsWith(".json") ? [{ name: "JSON 配置", extensions: ["json"] }] : [{ name: "文本", extensions: ["txt"] }],
        });
        if (result.canceled || !result.filePath)
          return { ok: false, canceled: true };
        file = result.filePath;
      }
      fs.writeFileSync(file, String(text ?? ""), "utf8");
      return { ok: true, file };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  });

  /**
   * Hosts the user already has, read from their own `~/.ssh/config`.
   *
   * A listing aid only: the settings that actually apply to a connection are
   * whatever ssh itself resolves, so this parser deliberately stays shallow and
   * reports what it could read rather than pretending to be a config engine.
   */
  handle("hosts:list", () => {
    try {
      const configPath =
        process.env.RHINE_SSH_CONFIG ||
        path.join(app.getPath("home"), ".ssh", "config");
      const missing = !fs.existsSync(configPath);
      const configured = missing ? [] : parseHostConfig(fs.readFileSync(configPath, "utf8"));
      const saved = profiles.entries();
      const hosts = [...configured.map((host) => ({ ...host, source: "config" })), ...saved.hosts];
      return { ok: true, hosts, configPath, missing, profilesPath: profiles.file, revision: saved.revision };
    } catch (error) {
      return {
        ok: false,
        error: String((error && error.message) || error),
        hosts: [],
      };
    }
  });

  handle("hosts:save", (_event, payload) => {
    try {
      if (payload?.profile?.id && sessions.activeTarget(keyFor(payload.profile.id)))
        return { ok: false, error: "请先断开这台主机的会话再修改配置" };
      return { ok: true, ...profiles.save(payload?.profile, payload?.revision) };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  handle("hosts:remove", (_event, payload) => {
    try {
      if (sessions.activeTarget(keyFor(payload?.id)))
        return { ok: false, error: "请先断开这台主机的会话再移除配置" };
      profiles.remove(payload?.id, payload?.revision);
      vault.remove(keyFor(payload.id));
      return { ok: true };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  handle("hosts:identity", async (event) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: "选择 SSH 私钥文件",
      defaultPath: path.join(app.getPath("home"), ".ssh"),
      properties: ["openFile"],
    });
    return { ok: !result.canceled, canceled: result.canceled, file: result.filePaths[0] };
  });

  handle("credentials:status", async (_event, target) => {
    try {
      if (typeof target !== "string" || !target || target.length > 1024) throw new Error("主机编号无效");
      const checked = profiles.resolve({ target });
      if (!checked.ok) throw new Error(checked.error);
      const endpoint = await effectiveEndpoint(checked.launch);
      const identity = checked.launch.keyId || (checked.launch.identityFile ? require("./ssh-credentials.cjs").keyPath(checked.launch.identityFile) : "");
      return { ok: true, state: vault.status(target, endpoint, identity) };
    }
    catch (error) { return { ok: false, error: error.message }; }
  });
  handle("credentials:save", async (_event, request) => {
    try {
      if (!["password", "passphrase"].includes(request?.kind)) throw new Error("凭据类型无效");
      const checked = profiles.resolve({ target: request.target });
      if (!checked.ok) throw new Error(checked.error);
      const endpoint = await effectiveEndpoint(checked.launch);
      const identity = request.kind === "passphrase" ? checked.launch.keyId || (checked.launch.identityFile ? path.resolve(checked.launch.identityFile).replaceAll("\\", "/").toLowerCase() : "") : "";
      if (request.kind === "passphrase" && !identity) throw new Error("请先为主机选择私钥");
      vault.put(request.target, request.kind, request.value, endpoint, identity);
      return { ok: true, state: vault.status(request.target) };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  handle("credentials:remove", (_event, request) => {
    try {
      if (typeof request?.target !== "string" || !["password", "passphrase", undefined].includes(request.kind)) throw new Error("凭据请求无效");
      vault.remove(request.target, request.kind); return { ok: true, state: vault.status(request.target) };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  handle("keys:list", () => {
    try {
      const hosts = profiles.entries().hosts;
      return { ok: true, keys: vault.listKeys().map(key => ({ ...key, hosts: hosts.filter(host => host.profile.keyId === key.id).map(host => host.displayName) })) };
    } catch (error) { return { ok: false, error: error.message, keys: [] }; }
  });
  handle("keys:add", async (_event, input) => {
    try { return { ok: true, key: await vault.addKey(input) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  handle("keys:remove", (_event, id) => {
    try {
      if (profiles.read().profiles.some(profile => profile.keyId === id)) throw new Error("请先从引用此密钥的主机配置中解除关联");
      vault.removeKey(id); return { ok: true };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  const migration = new (require("./ssh-migration.cjs").SshMigration)(vault, profiles, effectiveEndpoint);
  for (const method of ["describeHosts", "exportCredentials", "prepareCredentials", "importKeys", "importCredentials", "cancel"]) handle("migration:" + method, async (_event, request) => {
    try { return { ok: true, result: await migration[method](request) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });

  /**
   * Session records written beside their raw event logs. The archive's host
   * cards list these in their 会话记录 tab: reading back what a past session
   * proved is part of the workflow, not a separate tool.
   */
  const recordFilePattern = /^.+\.json$/;
  handle("records:list", () => {
    try {
      const dir = recordsDir();
      if (!fs.existsSync(dir)) return { ok: true, records: [], dir };
      const records = [];
      for (const name of fs.readdirSync(dir)) {
        if (!recordFilePattern.test(name)) continue;
        const file = path.join(dir, name);
        try {
          recordPath(dir, file);
        } catch {
          continue;
        }
        try {
          const record = JSON.parse(fs.readFileSync(file, "utf8"));
          records.push({
            file,
            id: String(record.id ?? name.replace(/\.json$/, "")),
            target: String(record.target ?? ""),
            targetLabel: typeof record.targetLabel === "string" ? record.targetLabel : "",
            startedAt: String(record.startedAt ?? ""),
            durationMs: Number(record.durationMs) || 0,
            outcome: String(record.outcome ?? ""),
            summary: String(record.summary ?? ""),
            bytesIn: Number(record.traffic?.bytesIn) || 0,
            bytesOut: Number(record.traffic?.bytesOut) || 0,
            exitCode: record.exitCode ?? null,
            logPath: typeof record.logPath === "string" ? record.logPath : "",
          });
        } catch {
          // A record that does not parse is reported as unreadable, not hidden.
          records.push({
            file,
            id: name,
            target: "",
            startedAt: "",
            durationMs: 0,
            outcome: "unreadable",
            summary: "记录文件无法解析",
            bytesIn: 0,
            bytesOut: 0,
            exitCode: null,
            logPath: "",
          });
        }
      }
      records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      return { ok: true, records, dir };
    } catch (error) {
      return {
        ok: false,
        error: String((error && error.message) || error),
        records: [],
      };
    }
  });

  /** Read one full record back (feeds the existing session-record surface). */
  handle("records:read", (_event, file) => {
    try {
      const dir = recordsDir();
      const target = recordPath(dir, file);
      return {
        ok: true,
        record: JSON.parse(fs.readFileSync(target, "utf8")),
        file: target,
      };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  });

  /** Read the raw `ssh -v` event log belonging to a record (capped at the tail). */
  handle("records:log", (_event, file) => {
    try {
      const dir = recordsDir();
      const target = recordPath(dir, file);
      if (!fs.existsSync(target)) return { ok: false, error: "事件日志不存在" };
      const text = fs.readFileSync(target, "utf8");
      const lines = text.split(/\r?\n/).filter((line) => line.trim());
      return {
        ok: true,
        lines: lines.slice(-200),
        truncated: lines.length > 200,
        file: target,
      };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  });

  handle("session:reserve", event => sessions.reserve(event.sender));
  handle("session:start", (event, request) => sessions.start(event.sender, request?.sessionId, request?.descriptor));
  handle("session:answer", (event, reply) => sessions.answer(event.sender, reply));
  const serviceFor = id => {
    const entry = sessions.entries.get(id);
    return entry && !entry.canceled && entry.pty?.running && !entry.services?.closed ? entry.services : null;
  };
  const servicesChanged = () => ({ ok: false, error: "会话已变化，请重新操作" });
  const validRemote = (value) => typeof value === "string" && value.length > 0 && value.length <= 8192 && !value.includes("\0");
  handle("services:snapshot", (_event, request) => ({ ok: true, result: sessions.services(request?.sessionId)?.snapshot() ?? null }));
  handle("services:answer", (_event, data) => serviceFor(data?.sessionId)?.answer(data?.id, data?.value, data?.canceled === true, data?.remember === true) ?? servicesChanged());
  for (const [channel, method] of [
    ["sftp:list", "list"], ["sftp:stat", "stat"], ["sftp:mkdir", "mkdir"], ["sftp:rename", "rename"],
  ]) handle(channel, (_event, data) => {
    const service = serviceFor(data?.sessionId);
    if (!service) return servicesChanged();
    if (!validRemote(data.path) || (method === "rename" && !validRemote(data.destination)))
      return { ok: false, error: "文件路径无效" };
    return service.call(data.sessionId, method, { path: data.path, destination: data.destination, cursor: data.cursor });
  });
  for (const method of ["readText", "writeText"]) handle("sftp:" + method, (_event, data) => {
    const service = serviceFor(data?.sessionId);
    if (!service) return servicesChanged();
    if (!validRemote(data.path) || (method === "writeText" && (typeof data.text !== "string" || Buffer.byteLength(data.text, "utf8") > 1048576 || typeof data.revision !== "string" || !/^[a-f0-9]{64}$/.test(data.revision)))) return { ok: false, error: "文本或文件版本无效" };
    return service.call(data.sessionId, method, { path: data.path, text: data.text, revision: data.revision });
  });
  for (const [action, method] of [["list", "tunnels"], ["start", "startTunnel"], ["stop", "stopTunnel"]]) handle("tunnels:" + action, (_event, data) => {
    const service = serviceFor(data?.sessionId);
    if (!service) return servicesChanged();
    if (action === "start" && (typeof data.name !== "string" || data.name.length > 100 || typeof data.host !== "string" || !/^[a-zA-Z0-9.:\[\]_-]{1,253}$/.test(data.host) || !Number.isInteger(data.port) || data.port < 1 || data.port > 65535 || !Number.isInteger(data.localPort) || data.localPort < 0 || data.localPort > 65535)) return { ok: false, error: "转发参数无效" };
    return service.call(data.sessionId, method, { id: data.id, name: data.name, host: data.host, port: data.port, localPort: data.localPort });
  });
  handle("sftp:remove", async (_event, data) => {
    const service = serviceFor(data?.sessionId);
    if (!service) return servicesChanged();
    if (!Array.isArray(data.paths) || !data.paths.length || data.paths.length > 256 || !data.paths.every(validRemote))
      return { ok: false, error: "删除目标无效" };
    const removed = [], errors = [];
    for (const file of data.paths) {
      if (serviceFor(data.sessionId) !== service) { errors.push({ path: file, error: "会话已变化" }); break; }
      const result = await service.call(data.sessionId, "remove", { path: file, recursive: data.recursive === true });
      if (result.ok) removed.push(file); else errors.push({ path: file, error: result.error });
    }
    return { ok: errors.length === 0, result: { removed, errors }, error: errors.length ? errors.map((entry) => entry.path + ": " + entry.error).join("\n") : undefined };
  });
  handle("sftp:upload", async (event, data) => {
    const service = serviceFor(data?.sessionId);
    if (!service) return servicesChanged();
    if (!validRemote(data.destination)) return { ok: false, error: "上传目录无效" };
    const picked = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: data.directory ? "选择上传文件夹" : "选择上传文件",
      properties: data.directory ? ["openDirectory", "multiSelections"] : ["openFile", "multiSelections"],
    });
    if (picked.canceled) return { ok: false, canceled: true };
    if (serviceFor(data.sessionId) !== service) return servicesChanged();
    return service.call(data.sessionId, "upload", { paths: picked.filePaths, destination: data.destination });
  });
  handle("sftp:drop", (event, data) => {
    const service = serviceFor(data?.sessionId);
    if (!service) return servicesChanged();
    // Paths come exclusively from preload's webUtils.getPathForFile(File).
    if (!validRemote(data.destination) || !Array.isArray(data.paths) || !data.paths.length || data.paths.length > 256
      || !data.paths.every((file) => typeof file === "string" && path.isAbsolute(file) && fs.existsSync(file)))
      return { ok: false, error: "拖入文件无效" };
    return service.call(data.sessionId, "upload", { paths: data.paths, destination: data.destination });
  });
  handle("sftp:download", async (event, data) => {
    const service = serviceFor(data?.sessionId);
    if (!service) return servicesChanged();
    if (!Array.isArray(data.paths) || !data.paths.length || data.paths.length > 256 || !data.paths.every(validRemote))
      return { ok: false, error: "下载目标无效" };
    const picked = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: "选择下载目录", defaultPath: app.getPath("downloads"), properties: ["openDirectory", "createDirectory"],
    });
    if (picked.canceled) return { ok: false, canceled: true };
    if (serviceFor(data.sessionId) !== service) return servicesChanged();
    return service.call(data.sessionId, "download", { paths: data.paths, destination: picked.filePaths[0] });
  });
  for (const [channel, method] of [
    ["sftp:cancel", "cancel"], ["sftp:retry", "retry"], ["sftp:conflict", "conflict"],
    ["sftp:reconnect", "filesRetry"], ["monitor:retry", "monitorRetry"],
  ]) handle(channel, (_event, data) => serviceFor(data?.sessionId)?.call(data.sessionId, method, {
    id: data.id, choice: data.choice, all: data.all === true, conflictId: data.conflictId,
  }) ?? servicesChanged());

  ipcMain.on("session:input", (event, request) => {
    if (trustedSender(event)) sessions.write(event.sender, request);
  });
  ipcMain.on("session:resize", (event, request) => {
    if (trustedSender(event)) sessions.resize(event.sender, request);
  });
  ipcMain.on("session:stop", (event, request) => {
    if (trustedSender(event)) sessions.stop(event.sender, request?.sessionId);
  });
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
 * The window's own chrome, in the application's palette.
 *
 * Windows draws the caption itself, so the only way to stop it being the
 * default white is to take the title bar away and colour the overlay Electron
 * puts back in its place. These are the stage's own values — its background and
 * `--theme-ink` — so the caption reads as part of the page instead of a frame
 * bolted around it. The renderer reports theme changes over `shell:theme`.
 */
const CHROME = {
  light: { color: "#e8e5e1", symbolColor: "#202d32" },
  dark: { color: "#131e26", symbolColor: "#e2e9e7" },
};
/** Matches `.titlebar-drag` in src/style.css, which is what makes the window
 *  movable once it has no native caption. */
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
function registerShellIpc() {
  ipcMain.on("shell:theme", (event, value) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const theme = value === "dark" ? "dark" : "light";
    const chrome = CHROME[theme];
    try {
      win.setTitleBarOverlay({ ...chrome, height: CHROME_HEIGHT });
      appliedChrome = { theme, ...chrome, height: CHROME_HEIGHT, error: null };
    } catch (error) {
      appliedChrome = { theme, error: String(error?.message ?? error) };
    }
  });
}

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
  win.webContents.on("render-process-gone", () => sessions?.stopOwner(contentsId));
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

/** Renderer probes live as real files under electron/probes/ (see that folder). */
function readProbe(name) {
  return fs.readFileSync(path.join(__dirname, "probes", name), "utf8");
}

/**
 * Drives the whole chain the way the UI will: renderer → preload bridge → IPC
 * → main (pty + stream split) → IPC → renderer → state machine. The stand-in
 * keeps it offline and deterministic; every other component is the real one.
 */
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
  if (MULTI_SMOKE) return runMultisessionSmoke(win);
  if (HOST_SMOKE) return runHostManagementSmoke(win);
  if (TERMINAL_SMOKE) return runTerminalDeckSmoke(win);
  // Where the probe should write its export, so automation never opens a dialog.
  const exportPath = path.join(outputDir, "session-record-export.txt");
  try {
    fs.rmSync(exportPath, { force: true });
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
    if (fs.existsSync(exportPath))
      exported = fs.readFileSync(exportPath, "utf8");
  } catch {
    /* reported through the checks below */
  }
  let persisted = null;
  try {
    const dir = path.join(app.getPath("userData"), "ssh-logs");
    const files = fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((name) => name.endsWith(".json"))
          .map((name) => ({
            name,
            at: fs.statSync(path.join(dir, name)).mtimeMs,
          }))
          .sort((a, b) => b.at - a.at)
      : [];
    if (files.length)
      persisted = JSON.parse(
        fs.readFileSync(path.join(dir, files[0].name), "utf8"),
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
    "pty carried session bytes": seam.consoleChild
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
    problems,
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
  report(payload);
  console.log(
    "SESSION_SMOKE_JSON " +
      JSON.stringify({ checks, skipped, failed, problems }),
  );
  return failed.length === 0;
}

async function runMultisessionSmoke(win) {
  const result = await win.webContents.executeJavaScript(readProbe("multisession-probe.js"));
  const checks = result?.checks || {};
  if (result?.error) problems.push({ kind: "multisession-probe", message: result.error });
  checks["two native sessions are still alive before reload"] = sessions.active().length === 2;
  const loaded = new Promise(resolve => win.webContents.once("did-finish-load", resolve));
  win.webContents.reload();
  await loaded;
  const deadline = Date.now() + 15000;
  let fresh = false;
  while (Date.now() < deadline) {
    fresh = await win.webContents.executeJavaScript("Boolean(window.rhineSshUi && window.rhineSshUi.sessions.length === 0)");
    if (fresh && sessions.entries.size === 0) break;
    await wait(100);
  }
  checks["reload stops the old native owners and creates no automatic connection"] = fresh && sessions.entries.size === 0;
  checks["native reload checkpoints retain all live session histories"] = Boolean(result?.liveIds?.length) && result.liveIds.every(id => {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "ssh-logs", id + ".json"), "utf8"));
      return record.id === id && record.outcome === "closed" && record.traffic.bytesIn > 0;
    } catch { return false; }
  });
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  report({ checks, failed, result, problems, scope: "Actual Electron/preload/IPC/ConPTY; SSH peer simulated." });
  return !failed.length && !problems.some(problem => problem.severity !== "warning");
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
  checks["no native renderer errors"] = problems.filter(item => item.severity !== "warning").length === 0;
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  const evidence = await win.webContents.executeJavaScript("window.__nativeDeckProbe.evidence");
  report({ checks, failed, result, evidence, shots: [opened, reopened, terminalTools], problems });
  return failed.length === 0;
}

/** Real host editor, IPC persistence and ConPTY; only the SSH peer is a fixture. */
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
    problems.push({ kind: "host-probe", message: String(error) });
    await shot("hosts-failure");
  }
  const checks = await win.webContents.executeJavaScript("window.__hostManagementProbe?.checks || {}");
  checks["no renderer or host probe errors"] = problems.filter((item) => item.severity !== "warning").length === 0;
  checks["host management workflow completed"] = await win.webContents.executeJavaScript("window.__hostManagementProbe?.complete === true");
  checks["every visual checkpoint produced an image"] = shots.length >= 5 && shots.every((item) => item.bytes > 10000);
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  report({ checks, failed, shots, problems });
  return failed.length === 0;
}

/**
 * Types into the password field with real input events.
 *
 * Synthetic `KeyboardEvent`s cannot reproduce the user's report: untrusted
 * events have no default action, so a character never actually lands in the
 * field. `sendInputEvent` goes through the browser's input pipeline the way a
 * keystroke does, which is the only way to see focus or re-render problems.
 */
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

/**
 * Visual evidence: a run with no console errors can still be a blank window.
 * Measure the captured bitmap instead of trusting it — a uniform surface has a
 * dominant-colour share near 1 and almost no luma spread.
 */
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

/** Visual evidence: a "no console errors" run can still be a blank window. */
async function capture(win, name) {
  try {
    const image = await win.webContents.capturePage();
    const file = path.join(
      path.dirname(reportPath),
      `desktop-smoke-${name}.png`,
    );
    fs.writeFileSync(file, image.toPNG());
    return { name, file, bytes: fs.statSync(file).size, ...analyze(image) };
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
      before.protocol === "file:" || Boolean(DEV_URL),
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
      if (!FRAMELESS) return true;
      const wanted = after.colorTheme === "dark" ? CHROME.dark : CHROME.light;
      return (
        appliedChrome?.error === null &&
        appliedChrome.theme === after.colorTheme &&
        appliedChrome.color === wanted.color &&
        appliedChrome.symbolColor === wanted.symbolColor &&
        appliedChrome.height === CHROME_HEIGHT
      );
    })(),
    "the renderer reports its theme to the window": after.themeReported === true,
    "the frameless window has a drag region the caption's height":
      !FRAMELESS ||
      (after.dragRegion?.region === "drag" &&
        Math.abs(after.dragRegion.height - CHROME_HEIGHT) <= 1),
  };
  const failed = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  const onlyBenign = problems.filter(
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
            frameless: FRAMELESS,
            applied: appliedChrome,
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
  report({
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

/**
 * The taskbar groups and picks its icon by AppUserModelID. Unpackaged Electron
 * has none, so the button is Electron's rather than the window's; naming the
 * app here is what makes `BrowserWindow({ icon })` reach the taskbar too.
 * Stable on purpose — changing it strands any existing pinned shortcut.
 */
if (process.platform === "win32") app.setAppUserModelId("com.rhinelab.analysis-os");

app.whenReady().then(async () => {
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
    process.env.FAKE_SSH_HOLD_MS = process.env.FAKE_SSH_HOLD_MS || (HOST_SMOKE || MULTI_SMOKE ? "90000" : TERMINAL_SMOKE ? "30000" : "8000");
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
      ? await require("../scripts/ssh-credentials-native-checks.cjs").run({ win, sessions, app, report, problems })
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
