/**
 * One primary SSH session owns its file and monitor workers. The renderer can
 * request enumerated operations, never an executable, shell command or local
 * path. File bytes remain in the native worker rather than crossing Electron.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");
const { buildSshArgs, resolveSshPath } = require("./ssh-args.cjs");
const { SshCredentials } = require("./ssh-credentials.cjs");

const RESOURCES = path.join(__dirname, "resources", "ssh-services");
const OPTIONS = new Set(["-i", "-p", "-l", "-J", "-c", "-m", "-b", "-o"]);
const FLAGS = new Set(["-4", "-6", "-C"]);
const CONFIG = new Set([
  "connecttimeout",
  "connectionattempts",
  "serveraliveinterval",
  "serveralivecountmax",
  "tcpkeepalive",
  "addressfamily",
  "preferredauthentications",
  "identitiesonly",
  "compression",
  "batchmode",
]);
const END_STATES = new Set(["completed", "failed", "canceled", "uncertain"]);
const resultError = (error) => ({
  ok: false,
  error: String(error?.message || error),
});

function connectionArgs(launch) {
  const filtered = [];
  const extra = launch.extraArgs || [];
  for (let index = 0; index < extra.length; index++) {
    const flag = extra[index];
    if (FLAGS.has(flag)) filtered.push(flag);
    else if (OPTIONS.has(flag)) {
      const value = extra[++index];
      if (
        flag !== "-o" ||
        CONFIG.has(String(value).split(/[=\s]/, 1)[0].toLowerCase())
      )
        filtered.push(flag, value);
    } else if (["-L", "-R", "-D", "-W", "-w", "-e"].includes(flag)) index++;
  }
  const args = buildSshArgs({ ...launch, extraArgs: filtered });
  if (process.env.RHINE_SSH_CONFIG)
    args.unshift("-F", process.env.RHINE_SSH_CONFIG);
  return args;
}

function buildAuxiliaryArgs(launch) {
  return [
    "-T",
    "-o",
    "RequestTTY=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "RemoteCommand=none",
    ...connectionArgs(launch),
  ];
}

function effectiveEndpoint(launch, executable = resolveSshPath()) {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ["-G", ...connectionArgs(launch)],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error)
          return reject(new Error(String(stderr || error.message).trim()));
        const fields = {}, identityFiles = [];
        for (const line of stdout.split(/\r?\n/)) {
          const match = line.match(/^(\S+)\s+(.+)$/);
          if (match?.[1] === "identityfile") identityFiles.push(match[2]);
          if (match && !Object.hasOwn(fields, match[1]))
            fields[match[1]] = match[2];
        }
        if (!fields.hostname) return reject(new Error("无法解析 SSH 目标主机"));
        resolve({
          host: fields.hostname,
          port: Number(fields.port) || 22,
          user: fields.user || "",
          viaProxy: [fields.proxyjump, fields.proxycommand].some(
            (value) => value && value !== "none",
          ),
          proxyJump: fields.proxyjump && fields.proxyjump !== "none" ? fields.proxyjump : undefined,
          proxyCommand: fields.proxycommand && fields.proxycommand !== "none",
          ...(launch.identityFile ? { identityFiles } : {}),
        });
      },
    );
  });
}

function serviceExecutable(resources = RESOURCES) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(resources, "manifest.json"), "utf8"),
  );
  const os = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const entry = manifest.files?.["bridge/" + os + "/" + arch];
  if (
    manifest.protocol !== 1 ||
    !entry ||
    path.basename(entry.name) !== entry.name ||
    !/^[a-f0-9]{64}$/.test(entry.sha256)
  )
    throw new Error("SSH 后台资源清单无效，请重新构建桌面版");
  const file = path.join(resources, entry.name);
  const digest = createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
  if (digest !== entry.sha256)
    throw new Error("SSH 后台程序校验失败，请重新构建桌面版");
  return file;
}
function historyPoint(sample) {
  const gpuLive =
    sample.gpuState === "live" &&
    sample.gpuAt > 0 &&
    sample.timestamp - sample.gpuAt <= 3000;
  return {
    timestamp: sample.timestamp,
    receivedAt: Date.now(),
    cpu: sample.cpu?.usage ?? null,
    memory: sample.memory?.total
      ? (sample.memory.used / sample.memory.total) * 100
      : null,
    gpus: sample.gpus.map((gpu) => ({
      uuid: gpu.uuid,
      utilization: gpuLive ? gpu.utilization : null,
      memoryUsed: gpuLive ? gpu.memoryUsed : null,
    })),
  };
}
function validSample(sample) {
  const number = (value) => Number.isFinite(value) && value >= 0;
  const metric = (value) => value === null || number(value);
  const string = (value, limit = 4096) =>
    typeof value === "string" && value.length <= limit;
  return (
    sample &&
    Number.isSafeInteger(sample.sequence) &&
    sample.sequence > 0 &&
    number(sample.timestamp) &&
    string(sample.hostname, 1024) &&
    number(sample.uptime) &&
    (sample.cpu === null ||
      (sample.cpu &&
        metric(sample.cpu.usage) &&
        Number.isSafeInteger(sample.cpu.cores) &&
        Array.isArray(sample.cpu.load) &&
        sample.cpu.load.length <= 3 &&
        sample.cpu.load.every(number))) &&
    (sample.memory === null ||
      (sample.memory &&
        ["total", "used", "available", "swapTotal", "swapUsed"].every((key) =>
          number(sample.memory[key]),
        ))) &&
    sample.diskIO &&
    metric(sample.diskIO.read) &&
    metric(sample.diskIO.write) &&
    Array.isArray(sample.gpus) &&
    sample.gpus.length <= 256 &&
    Array.isArray(sample.networks) &&
    sample.networks.length <= 4096 &&
    Array.isArray(sample.disks) &&
    sample.disks.length <= 4096 &&
    sample.disks.every(
      (disk) =>
        disk &&
        string(disk.mount) &&
        string(disk.device) &&
        ["total", "used", "available"].every((key) => number(disk[key])),
    ) &&
    sample.networks.every(
      (net) =>
        net && string(net.name, 256) && metric(net.receive) && metric(net.send),
    ) &&
    number(sample.gpuAt) &&
    ["starting", "live", "error", "unavailable"].includes(sample.gpuState) &&
    (sample.gpuError === undefined || string(sample.gpuError)) &&
    (sample.errors === undefined ||
      (Array.isArray(sample.errors) &&
        sample.errors.length <= 64 &&
        sample.errors.every((value) => string(value)))) &&
    sample.gpus.every(
      (gpu) =>
        gpu &&
        string(gpu.uuid, 256) &&
        string(gpu.name, 1024) &&
        Number.isSafeInteger(gpu.index) &&
        [
          "utilization",
          "memoryUsed",
          "memoryTotal",
          "temperature",
          "power",
          "powerLimit",
          "fan",
        ].every((key) => metric(gpu[key])) &&
        Array.isArray(gpu.processes) &&
        gpu.processes.length <= 16384 &&
        gpu.processes.every(
          (process) =>
            process &&
            Number.isSafeInteger(process.pid) &&
            string(process.name) &&
            string(process.type, 64) &&
            metric(process.memory) &&
            string(process.gpu, 256),
        ),
    )
  );
}
class SshServices {
  constructor({
    id,
    launch,
    send,
    resources = RESOURCES,
    disabled = false,
    executable = resolveSshPath(),
    vault, target, endpoint,
  }) {
    this.id = id;
    this.launch = launch;
    this.credentialBroker = new SshCredentials({ vault, target, endpoint, launch });
    this.send = send;
    this.resources = resources;
    this.disabled = disabled;
    this.executable = executable;
    this.worker = null;
    this.workerGeneration = 0;
    this.counter = 0;
    this.pending = new Map();
    this.jobWorkers = new Map();
    this.requeuing = new Set();
    this.sampleSequence = 0;
    this.auth = new Map();
    this.answeringAuth = new Set();
    this.primaryPrompt = null;
    this.primaryFingerprint = "";
    this.primaryMethod = "";
    this.primaryPeer = null;
    this.authenticated = false;
    this.closed = false;
    this.state = {
      sessionId: id,
      active: true,
      sftp: { state: "waiting", message: "等待 SSH 鉴权" },
      monitor: { state: "waiting", message: "等待 SSH 鉴权" },
      jobs: [],
      sample: null,
      receivedAt: 0,
      history: [],
      prompt: null,
    };
  }
  publish(event, data) {
    if (this.closed && event !== "stopped") return;
    this.send({ sessionId: this.id, event, data });
  }
  observeLog(line) {
    if (this.authenticated) return;
    const peer = line.match(/^debug1: Authenticating to (.+?):(\d+) as '(.+?)'/);
    if (peer) {
      this.primaryPeer = { host: peer[1].replace(/^\[|\]$/g, ""), port: Number(peer[2]), user: peer[3] };
      this.primaryFingerprint = "";
      this.primaryMethod = "";
    }
    const fingerprint = line.match(
      /Server host key: \S+ (SHA256:[A-Za-z0-9+/=]+)/,
    );
    if (fingerprint) this.primaryFingerprint = fingerprint[1];
    const method = line.match(/Next authentication method: (\S+)/);
    if (method) this.primaryMethod = method[1];
  }
  setPrimaryPrompt(prompt) {
    this.primaryPrompt = prompt;
  }
  automaticPrimaryAnswer(prompt) {
    if (this.closed || this.authenticated || this.primaryMethod === "keyboard-interactive") return null;
    return this.credentialBroker.automatic(prompt, this.primaryFingerprint, this.primaryMethod, "primary", this.primaryPeer);
  }
  canRememberPrimary(prompt) {
    return Boolean(this.primaryFingerprint) && this.credentialBroker.identity(prompt, this.primaryMethod, this.primaryPeer) !== null;
  }
  rememberPrimaryAnswer(prompt, value, remember = false) {
    if (this.closed || this.authenticated) return;
    this.credentialBroker.remember(prompt, value, this.primaryFingerprint, this.primaryMethod, remember, "primary", "primary", this.primaryPeer);
  }
  activate() {
    if (this.closed || this.authenticated) return;
    this.authenticated = true;
    try { this.credentialBroker.authenticated(); }
    catch (error) { this.publish("credential-error", { message: error.message }); }
    if (this.disabled) {
      this.receive({
        event: "capability",
        data: {
          service: "sftp",
          state: "unsupported",
          message: "当前隔离测试未启用文件服务",
        },
      });
      this.receive({
        event: "capability",
        data: {
          service: "monitor",
          state: "unsupported",
          message: "当前隔离测试未启用监控服务",
        },
      });
      return;
    }
    void this.startWorker();
  }
  async startWorker() {
    if (this.worker || this.closed || !this.authenticated) return;
    try {
      const file = serviceExecutable(this.resources);
      const env = { ...process.env };
      for (const name of [
        "RHINE_ASKPASS",
        "RHINE_AUTH_PIPE",
        "RHINE_AUTH_TOKEN",
        "RHINE_AUTH_SOURCE",
      ])
        delete env[name];
      const worker = spawn(file, [], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });
      this.worker = worker;
      const generation = ++this.workerGeneration;
      let buffer = "",
        diagnostic = "";
      const decoder = new StringDecoder("utf8");
      worker.stdout.on("data", (chunk) => {
        if (this.worker !== worker || this.closed) return;
        buffer += decoder.write(chunk);
        if (buffer.length > 8 * 1024 * 1024) {
          worker.kill();
          return;
        }
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          try {
            const message = JSON.parse(line);
            if (message.id) {
              const pending = this.pending.get(message.id);
              if (pending && pending.generation === generation) {
                this.pending.delete(message.id);
                clearTimeout(pending.timer);
                pending.resolve(
                  message.ok
                    ? { ok: true, result: message.result }
                    : resultError(message.error || "后台请求失败"),
                );
              }
            } else if (message.sessionId === this.id) this.receive(message);
          } catch {
            diagnostic = "后台服务返回了无效数据";
            worker.kill();
            return;
          }
        }
      });
      worker.stderr.on("data", (chunk) => {
        diagnostic = (diagnostic + chunk.toString()).slice(-4096);
      });
      worker.stdin.on("error", () => {});
      const ended = (error) => {
        if (this.worker !== worker) return;
        this.worker = null;
        for (const [id, pending] of this.pending) {
          if (pending.generation !== generation) continue;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.resolve(resultError(error || diagnostic || "后台服务已退出"));
        }
        this.auth.clear();
        this.answeringAuth.clear();
        this.state.prompt = null;
        for (const job of this.state.jobs) {
          if (!END_STATES.has(job.state)) {
            job.state = job.state === "committing" ? "uncertain" : "failed";
            job.error = "后台服务中断，请检查传输结果";
            job.rate = 0;
          }
          if (job.state === "uncertain") {
            job.retryable = false;
            job.error =
              "写入期间后台服务中断，请检查目标与下方恢复文件，再重新选择文件传输";
          }
          this.publish("transfer", job);
        }
        this.publish("auth", null);
        if (!this.closed) {
          for (const service of ["sftp", "monitor"])
            this.receive({
              event: "capability",
              data: {
                service,
                state: "error",
                message: String(
                  error?.message ||
                    error ||
                    diagnostic ||
                    "后台服务已退出，可重试",
                ),
              },
            });
        }
      };
      worker.once("error", ended);
      worker.once("exit", () => ended());
      const result = await this.rpc("configure", {
        sessionId: this.id,
        ssh: {
          executable: this.executable,
          args: buildAuxiliaryArgs(this.launch),
        },
        resources: this.resources,
      });
      if (!result.ok && !this.closed) throw new Error(result.error);
    } catch (error) {
      for (const service of ["sftp", "monitor"])
        this.receive({
          event: "capability",
          data: { service, state: "error", message: error.message },
        });
    }
  }
  receive(message) {
    if (this.closed) return;
    const { event, data } = message;
    if (event === "capability" && ["sftp", "monitor"].includes(data?.service)) {
      if (data.service === "monitor" && data.state === "probing")
        this.sampleSequence = 0;
      this.state[data.service] = { ...data };
      if (data.state === "ready") {
        try { this.credentialBroker.authenticated(data.service); }
        catch (error) { this.publish("credential-error", { message: error.message }); }
      }
      this.publish(event, data);
    } else if (event === "tunnel" && typeof data?.id === "string") {
      this.state.tunnels ??= [];
      const index = this.state.tunnels.findIndex(t => t.id === data.id);
      if (index < 0) this.state.tunnels.push(data); else this.state.tunnels[index] = data;
      this.publish(event, data);
    } else if (event === "transfer" && typeof data?.id === "string") {
      this.jobWorkers.set(data.id, this.workerGeneration);
      const index = this.state.jobs.findIndex((job) => job.id === data.id);
      if (index >= 0) this.state.jobs[index] = data;
      else if (this.state.jobs.length < 1000) this.state.jobs.push(data);
      this.publish(event, data);
    } else if (event === "sample" && validSample(data)) {
      if (data.sequence <= this.sampleSequence) return;
      this.sampleSequence = data.sequence;
      this.state.sample = data;
      this.state.receivedAt = Date.now();
      this.state.history.push(historyPoint(data));
      if (this.state.history.length > 300)
        this.state.history.splice(0, this.state.history.length - 300);
      this.publish(event, { sample: data, receivedAt: this.state.receivedAt });
    } else if (event === "auth" && typeof data?.id === "string") {
      this.auth.set(data.id, data);
      data.canRemember = Boolean(data.fingerprint) && this.credentialBroker.identity(data, data.method, data.peer) !== null;
      const value = data.fingerprint === this.primaryFingerprint
        ? this.credentialBroker.automatic(data, data.fingerprint, data.method, data.connection || data.source, data.peer)
        : null;
      if (value !== null) {
        this.answeringAuth.add(data.id);
        void this.rpc("answer", { id: data.id, value }).then(
          (result) => {
            if (!result.ok && this.auth.has(data.id)) {
              this.answeringAuth.delete(data.id);
              this.publishPrompt();
            }
          },
        );
      } else this.publishPrompt();
    } else if (event === "authClosed") {
      this.auth.delete(data?.id);
      this.answeringAuth.delete(data?.id);
      this.publishPrompt();
    }
  }
  publishPrompt() {
    this.state.prompt =
      [...this.auth.values()].find(
        (prompt) => !this.answeringAuth.has(prompt.id),
      ) || null;
    this.publish("auth", this.state.prompt);
  }
  async answer(id, value, canceled = false, remember = false) {
    const prompt = this.auth.get(id);
    if (!prompt || this.closed || this.answeringAuth.has(id))
      return resultError("认证请求已结束");
    if (
      typeof value !== "string" ||
      value.length > 16384 ||
      /[\0\r\n]/.test(value)
    )
      return resultError("口令格式无效");
    if (!canceled) this.credentialBroker.remember(prompt, value, prompt.fingerprint,
      prompt.method, remember, prompt.connection || prompt.source, prompt.source, prompt.peer);
    this.answeringAuth.add(id);
    const result = await this.rpc("answer", { id, value, canceled });
    if (!result.ok) this.answeringAuth.delete(id);
    this.publishPrompt();
    return result;
  }
  rpc(method, params = {}) {
    if (this.closed || !this.worker)
      return Promise.resolve(resultError("后台服务尚未就绪"));
    const worker = this.worker,
      generation = this.workerGeneration;
    const id = String(++this.counter);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(resultError("后台操作超时，请刷新后核查结果"));
      }, 65000);
      timer.unref();
      this.pending.set(id, { resolve, timer, generation });
      worker.stdin.write(
        JSON.stringify({ id, method, params }) + "\n",
        (error) => {
          if (!error || !this.pending.has(id)) return;
          this.pending.delete(id);
          clearTimeout(timer);
          resolve(resultError(error));
        },
      );
    });
  }
  async call(sessionId, method, params) {
    if (sessionId !== this.id || this.closed)
      return resultError("会话已变化，请重新操作");
    if (["filesRetry", "monitorRetry"].includes(method) && !this.worker) {
      await this.startWorker();
      return this.worker ? { ok: true } : resultError("后台服务无法启动");
    }
    if (
      ["upload", "download"].includes(method) &&
      this.state.jobs.length + (params?.paths?.length || 0) > 1000
    )
      return resultError("本次会话的传输队列已满");
    if (
      method === "retry" &&
      this.jobWorkers.has(params?.id) &&
      this.jobWorkers.get(params.id) !== this.workerGeneration
    ) {
      const job = this.state.jobs.find((job) => job.id === params.id);
      if (
        !job ||
        !["failed", "canceled"].includes(job.state) ||
        job.retryable === false
      )
        return resultError("请先检查目标与保留的恢复文件，再重新选择文件传输");
      if (job.retried || this.requeuing.has(job.id))
        return resultError("该任务已经重新加入队列");
      if (this.state.sftp.state !== "ready" || this.state.jobs.length >= 1000)
        return resultError("请先恢复文件连接，或重新建立会话");
      this.requeuing.add(job.id);
      try {
        const result = await this.rpc(job.direction, {
          paths: [job.source],
          destination: job.destination,
        });
        if (result.ok) {
          job.retried = true;
          this.publish("transfer", job);
        }
        return result;
      } finally {
        this.requeuing.delete(job.id);
      }
    }
    return this.rpc(method, params);
  }
  snapshot() {
    return this.state;
  }
  close() {
    this.credentialBroker.clear();
    if (this.closed) return this.closeResult;
    this.closed = true;
    this.state.active = false;
    this.auth.clear();
    this.answeringAuth.clear();
    this.primaryPrompt = null;
    this.primaryFingerprint = "";
    this.state.prompt = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(resultError("会话已结束"));
    }
    this.pending.clear();
    this.state.sftp = { state: "stopped", message: "SSH 会话已结束" };
    this.state.monitor = { state: "stopped", message: "SSH 会话已结束" };
    for (const tunnel of this.state.tunnels || []) { tunnel.state = "closed"; tunnel.connections = 0; }
    for (const job of this.state.jobs)
      if (!END_STATES.has(job.state)) {
        job.state = job.state === "committing" ? "uncertain" : "canceled";
        job.error = "SSH 会话已结束";
        job.rate = 0;
      }
    const worker = this.worker;
    this.closeResult = worker && worker.exitCode === null && worker.signalCode === null
      ? new Promise(resolve => worker.once("exit", resolve)) : Promise.resolve();
    if (worker) {
      worker.stdin.end(JSON.stringify({ id: "stop", method: "stop" }) + "\n");
      const timer = setTimeout(() => worker.kill(), 1800);
      timer.unref();
      worker.once("exit", () => clearTimeout(timer));
    }
    this.publish("stopped", this.state);
    return this.closeResult;
  }
}
module.exports = {
  SshServices,
  buildAuxiliaryArgs,
  effectiveEndpoint,
  serviceExecutable,
  validSample,
};
