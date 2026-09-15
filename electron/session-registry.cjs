"use strict";
const { randomUUID } = require("node:crypto");

/** The owner and ID are checked before every operation, including startup. */
class SessionRegistry {
  constructor(options) {
    this.options = options;
    this.entries = new Map();
  }
  reserve(sender) {
    const id = randomUUID();
    const entry = { id, sender, owner: sender.id, target: "", starting: false,
      canceled: false, pty: null, services: null, traffic: null, logPath: "" };
    entry.expiry = setTimeout(() => this.stop(sender, id), 30000);
    entry.expiry.unref?.();
    this.entries.set(id, entry);
    return { ok: true, id };
  }
  get(sender, id) {
    const entry = typeof id === "string" ? this.entries.get(id) : null;
    return entry && entry.owner === sender.id && !entry.canceled ? entry : null;
  }
  owns(sender, id) { return Boolean(this.get(sender, id)); }
  active(owner) {
    return [...this.entries.values()].filter(entry => !entry.canceled &&
      (owner === undefined || entry.owner === owner) && (entry.starting || entry.pty));
  }
  activeTarget(target) { return this.active().some(entry => entry.target === target); }
  get logPaths() { return [...this.entries.values()].map(entry => entry.logPath).filter(Boolean); }
  services(id) { return this.entries.get(id)?.services ?? null; }
  emit(entry, channel, data) {
    if (!entry.sender.isDestroyed()) this.options.send(entry.sender, channel, { sessionId: entry.id, data });
  }
  async start(sender, id, descriptor) {
    const entry = this.get(sender, id);
    if (!entry || entry.starting || entry.pty) return { ok: false, error: "会话已结束或已启动" };
    clearTimeout(entry.expiry);
    entry.starting = true;
    try {
      const checked = this.options.resolveLaunch(descriptor);
      if (!checked.ok) throw new Error(checked.error);
      if (checked.launch.keyId) {
        entry.keyLease = this.options.vault?.acquire(checked.launch.keyId);
        if (!entry.keyLease) throw new Error("密钥库不可用");
        checked.launch.identityFile = entry.keyLease.file;
      }
      entry.target = descriptor.target.trim();
      const endpoint = await this.options.resolveEndpoint(checked.launch);
      if (entry.canceled || sender.isDestroyed() || this.entries.get(id) !== entry)
        throw new Error("连接已取消");
      entry.logPath = this.options.logPathFor(entry.target, id);
      const command = this.options.command(checked.launch, entry.logPath);
      entry.argv = [command.file, ...command.args];
      entry.displayTarget = checked.displayTarget;
      const services = this.options.createServices({
        id, launch: checked.launch, endpoint, target: entry.target, vault: this.options.vault,
        send: event => this.options.send(sender, "services:event", event),
      });
      entry.services = services;
      this.options.send(sender, "services:event", { sessionId: id, event: "snapshot", data: services.snapshot() });
      const pty = this.options.createPty({
        onData: data => this.emit(entry, "session:data", data),
        onLog: (line, meta) => {
          services.observeLog(line);
          this.emit(entry, "session:log", meta?.trustedAuthentication === false ? "[SSH hop] " + line : line);
        },
        onPrompt: prompt => {
          services.setPrimaryPrompt(prompt);
          const value = services.automaticPrimaryAnswer?.(prompt);
          if (value !== null && value !== undefined && pty.answer(prompt.id, value).ok) return;
          this.emit(entry, "session:prompt", prompt ? { ...prompt, canRemember: services.canRememberPrimary?.(prompt) ?? false } : null);
        },
        onAuthenticated: () => services.activate(),
        onExit: info => {
          this.options.checkpoint?.(entry, info);
          services.close();
          this.emit(entry, "session:exit", info);
          this.release(entry);
        },
      });
      entry.pty = pty;
      pty.start({ ...command, logPath: entry.logPath,
        cols: Number(descriptor?.cols) || 80, rows: Number(descriptor?.rows) || 24,
        authenticationTarget: endpoint });
      entry.starting = false;
      if (this.entries.get(id) === entry) {
        entry.traffic = setInterval(() => {
          if (entry.canceled || !pty.running) return;
          this.emit(entry, "session:traffic", { bytesIn: pty.bytesIn, bytesOut: pty.bytesOut,
            logLines: pty.logLines, elapsedMs: Date.now() - pty.startedAt });
        }, 250);
        entry.traffic.unref?.();
      }
      return { ok: true, file: command.file, argv: [command.file, ...command.args],
        id, logPath: entry.logPath, startedAt: pty.startedAt, displayTarget: checked.displayTarget };
    } catch (error) {
      this.release(entry);
      return { ok: false, error: String(error?.message || error) };
    }
  }
  answer(sender, request) {
    const entry = this.get(sender, request?.sessionId);
    const prompt = entry?.services?.primaryPrompt;
    const result = entry?.pty?.answer(request?.id, request?.value) ?? { ok: false, error: "会话已结束" };
    if (result.ok) entry.services?.rememberPrimaryAnswer(prompt, request.value, request.remember === true);
    return result;
  }
  write(sender, request) {
    if (typeof request?.data !== "string") return;
    this.get(sender, request.sessionId)?.pty?.write(request.data);
  }
  resize(sender, request) {
    this.get(sender, request?.sessionId)?.pty?.resize(Number(request.cols), Number(request.rows));
  }
  stop(sender, id) {
    const entry = this.get(sender, id);
    if (!entry) return;
    entry.canceled = true;
    this.options.checkpoint?.(entry);
    entry.services?.close();
    clearInterval(entry.traffic);
    clearTimeout(entry.expiry);
    if (entry.pty) entry.pty.stop();
    else this.entries.delete(id);
  }
  stopOwner(owner) {
    for (const entry of [...this.entries.values()]) if (entry.owner === owner) this.stop(entry.sender, entry.id);
  }
  stopAll() {
    for (const entry of [...this.entries.values()]) this.stop(entry.sender, entry.id);
  }
  release(entry) {
    clearInterval(entry.traffic);
    clearTimeout(entry.expiry);
    const stopped = entry.services?.close();
    entry.pty?.dispose();
    // SFTP / monitor children can still be authenticating as the PTY exits.
    // Their last owner must finish before an imported private file is removed.
    void Promise.resolve(stopped).then(() => {
      try { entry.keyLease?.release(); } catch { /* Startup cleanup retries locked files. */ }
    });
    if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
  }
}

module.exports = { SessionRegistry };
