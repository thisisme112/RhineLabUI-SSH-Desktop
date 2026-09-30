// Native ipcContext wiring; context getters preserve live session ownership.
module.exports = runtimeContext => {
function registerSessionIpc() {
  const handle = (channel, listener) => runtimeContext.ipcMain.handle(channel, (event, ...args) => {
    if (!runtimeContext.trustedSender(event)) return { ok: false, error: "请求来源无效" };
    const id = args[0]?.sessionId;
    if (id !== undefined && !runtimeContext.sessions.owns(event.sender, id)) return { ok: false, error: "会话已结束或不属于当前窗口" };
    return listener(event, ...args);
  });
  const recordsDir = () => runtimeContext.path.join(runtimeContext.app.getPath("userData"), "ssh-logs");
  const profiles = new runtimeContext.HostProfiles(runtimeContext.path.join(runtimeContext.app.getPath("userData"), "ssh-hosts.json"));
  const vault = new runtimeContext.CredentialVault(runtimeContext.path.join(runtimeContext.app.getPath("userData"), "ssh-credentials.json"), runtimeContext.safeStorage,
    (content, passphrase) => runtimeContext.inspectPrivateKey(runtimeContext.serviceExecutable(), content, passphrase));
  try { vault.cleanupStale(); } catch (error) { console.error("密钥临时文件清理失败:", error.message); }
  runtimeContext.sessions = new runtimeContext.SessionRegistry({
    vault,
    resolveLaunch: descriptor => profiles.resolve(descriptor),
    resolveEndpoint: launch => (!runtimeContext.SESSION_SMOKE && !runtimeContext.SMOKE) || runtimeContext.CREDENTIAL_SMOKE ? runtimeContext.effectiveEndpoint(launch) : Promise.resolve(undefined),
    createPty: callbacks => new runtimeContext.PtySession(callbacks),
    createServices: options => runtimeContext.EDITOR_SMOKE ? new (require("../fixtures/editor-services.cjs"))(options) : new runtimeContext.SshServices({ ...options,
      disabled: !runtimeContext.CREDENTIAL_SMOKE && (runtimeContext.SESSION_SMOKE || runtimeContext.SMOKE) && process.env.RHINE_SERVICES_SMOKE !== "1" }),
    logPathFor: runtimeContext.logPathFor, send: runtimeContext.send,
    checkpoint: (entry, info) => {
      try {
        if (!entry.logPath) return;
        const file = entry.logPath.replace(/\.log$/, ".json");
        let existing = null;
        try { existing = JSON.parse(runtimeContext.fs.readFileSync(file, "utf8")); } catch { /* first checkpoint */ }
        const record = runtimeContext.lifecycleRecord(entry, info, existing);
        if (record) runtimeContext.fs.writeFileSync(file, JSON.stringify(record, null, 2), "utf8");
        runtimeContext.logDiagnostic("session-lifecycle", {
          sessionId: entry.id,
          alias: entry.target,
          reason: record?.outcome,
          code: info?.exitCode ?? null,
        });
      } catch (error) {
        console.error("SSH 会话记录未能保存:", String(error?.message || error));
      }
    },
    command: (launch, logPath) => {
      const { file, prefixArgs } = runtimeContext.resolveSshCommand();
      return { file, args: [...prefixArgs,
        ...(((!runtimeContext.SESSION_SMOKE && !runtimeContext.SMOKE) || runtimeContext.CREDENTIAL_SMOKE) && process.env.RHINE_SSH_CONFIG ? ["-F", process.env.RHINE_SSH_CONFIG] : []),
        ...runtimeContext.buildSshArgs({ ...launch, logPath })] };
    },
  });
  // Exercise the real IPC/preload in smoke runs without touching the user's
  // system clipboard, which may contain private text or non-text formats.
  let smokeClipboardText = "";
  const textClipboard = runtimeContext.createTextClipboard(runtimeContext.SMOKE || runtimeContext.SESSION_SMOKE ? {
    readText: () => smokeClipboardText,
    writeText: (text) => { smokeClipboardText = text; },
  } : runtimeContext.clipboard);
  handle("terminal:clipboard-read", () => textClipboard.readText());
  handle("terminal:clipboard-write", (_event, text) => textClipboard.writeText(text));
  /**
   * Renderer crash/error reports. The renderer sends whitelisted metadata
   * only; everything is funneled through the same sanitizer as main-side
   * events, so unexpected fields are dropped, not logged.
   */
  handle("diagnostic:event", (_event, entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { ok: false };
    runtimeContext.logDiagnostic("renderer-error", {
      level: "error",
      reason: entry.reason === "rejection" ? "rejection" : "error",
    });
    return { ok: true };
  });
  const prune = () => {
    try {
      return runtimeContext.pruneRecords(recordsDir(), {
        exclude: runtimeContext.sessions.logPaths,
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
      runtimeContext.fs.mkdirSync(dir, { recursive: true });
      const id = String(record?.id ?? Date.now()).replace(
        /[^A-Za-z0-9._-]/g,
        "_",
      );
      const file = runtimeContext.path.join(dir, `${id}.json`);
      runtimeContext.fs.writeFileSync(file, JSON.stringify(record, null, 2), "utf8");
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
        (runtimeContext.SMOKE || runtimeContext.SESSION_SMOKE) && typeof target === "string" && target
          ? target
          : null;
      if (file && runtimeContext.path.dirname(runtimeContext.path.resolve(file)) !== runtimeContext.outputDir)
        return { ok: false, error: "测试导出路径无效" };
      if (!file) {
        const window = runtimeContext.BrowserWindow.fromWebContents(event.sender);
        const result = await runtimeContext.dialog.showSaveDialog(window, {
          title: String(suggestedName).endsWith(".json") ? "导出 SSH 配置" : "导出会话记录",
          defaultPath: runtimeContext.path.join(
            runtimeContext.app.getPath("documents"),
            String(suggestedName || "ssh-session.txt"),
          ),
          filters: String(suggestedName).endsWith(".json") ? [{ name: "JSON 配置", extensions: ["json"] }] : [{ name: "文本", extensions: ["txt"] }],
        });
        if (result.canceled || !result.filePath)
          return { ok: false, canceled: true };
        file = result.filePath;
      }
      runtimeContext.fs.writeFileSync(file, String(text ?? ""), "utf8");
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
        runtimeContext.path.join(runtimeContext.app.getPath("home"), ".ssh", "config");
      const missing = !runtimeContext.fs.existsSync(configPath);
      const configured = missing ? [] : runtimeContext.parseHostConfig(runtimeContext.fs.readFileSync(configPath, "utf8"));
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
      if (payload?.profile?.id && runtimeContext.sessions.activeTarget(runtimeContext.keyFor(payload.profile.id)))
        return { ok: false, error: "请先断开这台主机的会话再修改配置" };
      return { ok: true, ...profiles.save(payload?.profile, payload?.revision) };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  handle("hosts:remove", (_event, payload) => {
    try {
      if (runtimeContext.sessions.activeTarget(runtimeContext.keyFor(payload?.id)))
        return { ok: false, error: "请先断开这台主机的会话再移除配置" };
      profiles.remove(payload?.id, payload?.revision);
      vault.remove(runtimeContext.keyFor(payload.id));
      return { ok: true };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  handle("hosts:identity", async (event) => {
    const result = await runtimeContext.dialog.showOpenDialog(runtimeContext.BrowserWindow.fromWebContents(event.sender), {
      title: "选择 SSH 私钥文件",
      defaultPath: runtimeContext.path.join(runtimeContext.app.getPath("home"), ".ssh"),
      properties: ["openFile"],
    });
    return { ok: !result.canceled, canceled: result.canceled, file: result.filePaths[0] };
  });

  handle("credentials:status", async (_event, target) => {
    try {
      if (typeof target !== "string" || !target || target.length > 1024) throw new Error("主机编号无效");
      const checked = profiles.resolve({ target });
      if (!checked.ok) throw new Error(checked.error);
      const endpoint = await runtimeContext.effectiveEndpoint(checked.launch);
      const identity = checked.launch.keyId || (checked.launch.identityFile ? require("../ssh-credentials.cjs").keyPath(checked.launch.identityFile) : "");
      return { ok: true, state: vault.status(target, endpoint, identity) };
    }
    catch (error) { return { ok: false, error: error.message }; }
  });
  handle("credentials:save", async (_event, request) => {
    try {
      if (!["password", "passphrase"].includes(request?.kind)) throw new Error("凭据类型无效");
      const checked = profiles.resolve({ target: request.target });
      if (!checked.ok) throw new Error(checked.error);
      const endpoint = await runtimeContext.effectiveEndpoint(checked.launch);
      const identity = request.kind === "passphrase" ? checked.launch.keyId || (checked.launch.identityFile ? runtimeContext.path.resolve(checked.launch.identityFile).replaceAll("\\", "/").toLowerCase() : "") : "";
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
  const migration = new (require("../ssh-migration.cjs").SshMigration)(vault, profiles, runtimeContext.effectiveEndpoint);
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
      if (!runtimeContext.fs.existsSync(dir)) return { ok: true, records: [], dir };
      const records = [];
      for (const name of runtimeContext.fs.readdirSync(dir)) {
        if (!recordFilePattern.test(name)) continue;
        const file = runtimeContext.path.join(dir, name);
        try {
          runtimeContext.recordPath(dir, file);
        } catch {
          continue;
        }
        try {
          const record = JSON.parse(runtimeContext.fs.readFileSync(file, "utf8"));
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
      const target = runtimeContext.recordPath(dir, file);
      return {
        ok: true,
        record: JSON.parse(runtimeContext.fs.readFileSync(target, "utf8")),
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
      const target = runtimeContext.recordPath(dir, file);
      if (!runtimeContext.fs.existsSync(target)) return { ok: false, error: "事件日志不存在" };
      const text = runtimeContext.fs.readFileSync(target, "utf8");
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

  handle("session:reserve", event => runtimeContext.sessions.reserve(event.sender));
  handle("session:start", (event, request) => runtimeContext.sessions.start(event.sender, request?.sessionId, request?.descriptor));
  handle("session:answer", (event, reply) => runtimeContext.sessions.answer(event.sender, reply));
  const serviceFor = id => {
    const entry = runtimeContext.sessions.entries.get(id);
    return entry && !entry.canceled && entry.pty?.running && !entry.services?.closed ? entry.services : null;
  };
  const servicesChanged = () => ({ ok: false, error: "会话已变化，请重新操作" });
  const validRemote = (value) => typeof value === "string" && value.length > 0 && value.length <= 8192 && !value.includes("\0");
  handle("services:snapshot", (_event, request) => ({ ok: true, result: runtimeContext.sessions.services(request?.sessionId)?.snapshot() ?? null }));
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
    const picked = await runtimeContext.dialog.showOpenDialog(runtimeContext.BrowserWindow.fromWebContents(event.sender), {
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
      || !data.paths.every((file) => typeof file === "string" && runtimeContext.path.isAbsolute(file) && runtimeContext.fs.existsSync(file)))
      return { ok: false, error: "拖入文件无效" };
    return service.call(data.sessionId, "upload", { paths: data.paths, destination: data.destination });
  });
  handle("sftp:download", async (event, data) => {
    const service = serviceFor(data?.sessionId);
    if (!service) return servicesChanged();
    if (!Array.isArray(data.paths) || !data.paths.length || data.paths.length > 256 || !data.paths.every(validRemote))
      return { ok: false, error: "下载目标无效" };
    const picked = await runtimeContext.dialog.showOpenDialog(runtimeContext.BrowserWindow.fromWebContents(event.sender), {
      title: "选择下载目录", defaultPath: runtimeContext.app.getPath("downloads"), properties: ["openDirectory", "createDirectory"],
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

  runtimeContext.ipcMain.on("session:input", (event, request) => {
    if (runtimeContext.trustedSender(event)) runtimeContext.sessions.write(event.sender, request);
  });
  runtimeContext.ipcMain.on("session:resize", (event, request) => {
    if (runtimeContext.trustedSender(event)) runtimeContext.sessions.resize(event.sender, request);
  });
  runtimeContext.ipcMain.on("session:stop", (event, request) => {
    if (runtimeContext.trustedSender(event)) runtimeContext.sessions.stop(event.sender, request?.sessionId);
  });
}

function registerShellIpc() {
  // The theme change-over captures the window as it is, to break it up over the new theme.
  runtimeContext.ipcMain.handle("shell:capture", async (event) => {
    const image = await event.sender.capturePage();
    return image.isEmpty() ? null : image.toJPEG(90);
  });
  runtimeContext.ipcMain.on("shell:theme", (event, value) => {
    const win = runtimeContext.BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const theme = value === "dark" ? "dark" : "light";
    const chrome = runtimeContext.CHROME[theme];
    try {
      win.setTitleBarOverlay({ ...chrome, height: runtimeContext.CHROME_HEIGHT });
      runtimeContext.appliedChrome = { theme, ...chrome, height: runtimeContext.CHROME_HEIGHT, error: null };
    } catch (error) {
      runtimeContext.appliedChrome = { theme, error: String(error?.message ?? error) };
    }
  });
}
return { registerSessionIpc, registerShellIpc };
};
