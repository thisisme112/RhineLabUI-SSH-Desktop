import type { SessionPipe } from "./pipe";

export type SessionPhase = "idle" | "connecting" | "handshake" | "hostkey" | "authenticating" | "opening" | "interactive" | "failed" | "closed";
export type AuthRequest =
  | { method: "password"; password?: string }
  | { method: "publickey"; privateKey: string; passphrase?: string }
  | { method: "keyboard-interactive" };
export type HostKey = { keyType: string; fingerprint: string };
export type ConnectOptions = {
  host: string; port?: number; user: string; auth: AuthRequest;
  knownHost?: HostKey; timeoutMs?: number; term?: string;
  jumps?: ConnectOptions[]; keepAliveInterval?: number; keepAliveCountMax?: number;
};
export type SessionEvent =
  | { kind: "service"; event: string; data: unknown }
  | { kind: "phase"; phase: SessionPhase; detail: string }
  | { kind: "hop"; hop: number; phase: SessionPhase; detail: string }
  | { kind: "data"; bytes: Uint8Array }
  | { kind: "exit"; code: number | null; message: string }
  | { kind: "error"; message: string }
  | ({ kind: "hostkey"; hop?: number; intermediate?: boolean; accept(): void; reject(): void } & HostKey)
  | { kind: "prompt"; hop?: number; id: string; promptKind: "password" | "verification-code" | "passphrase"; prompt: string; answer(value: string): void; cancel(): void };
export type SessionListener = (event: SessionEvent) => void;
const phases = new Set<SessionPhase>(["connecting", "handshake", "hostkey", "authenticating", "opening", "interactive", "failed", "closed"]);
const errorOf = (error: unknown) => error instanceof Error ? error : new Error(String(error));

function encodeBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function decodeBase64(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

/** A single connection owns a single pipe. Only protocol events change its
 * trusted phase; terminal bytes never participate in that state machine. */
export class AndroidSshSession {
  private listeners = new Set<SessionListener>();
  private detach: (() => void)[] = [];
  private counter = 0;
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private phase: SessionPhase = "idle";
  private started = false;
  private stopped = false;
  private connecting = false;
  private exitReported = false;
  private decision = 0;
  // Assigned explicitly so Node's type stripping can import the shipped driver.
  private readonly pipe: SessionPipe;
  constructor(pipe: SessionPipe) { this.pipe = pipe; }
  on(listener: SessionListener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  get current() { return this.phase; }

  async start() {
    if (this.started || this.stopped || this.detach.length) throw new Error("此会话已使用，请新建连接");
    this.detach.push(this.pipe.onLine(line => { if (!this.stopped) this.receive(line); }));
    this.detach.push(this.pipe.onClosed(() => {
      if (this.stopped) return;
      this.stopped = true;
      this.decision++;
      this.rejectPending(new Error("SSH 代理已退出"));
      if (this.phase !== "failed" && this.phase !== "closed") this.enter("closed", "SSH 代理已退出");
      if (!this.exitReported && this.phase !== "failed") {
        this.exitReported = true;
        this.emit({ kind: "exit", code: null, message: "连接中断，未收到远端退出状态" });
      }
      this.detachListeners();
      void this.pipe.stop().catch(() => {});
    }));
    try {
      const result = await this.pipe.start();
      if (this.stopped) throw new Error("连接已取消");
      if (!result.ok) throw new Error(result.error ?? "启动 SSH 代理失败");
      this.started = true;
      return result;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async connect(options: ConnectOptions) {
    if (!this.started || this.stopped || this.connecting) throw new Error("此会话不可连接");
    this.connecting = true;
    // A Linux Go binary cannot use Android's system DNS itself. Resolve through
    // Java while retaining the original hostname for trust / credential binding.
    const first = options.jumps?.[0] ?? options;
    const addresses = await this.pipe.resolve?.(first.host);
    if (this.stopped) throw new Error("连接已取消");
    await this.request("connect", options.jumps?.length ? { ...options, jumps: options.jumps.map((hop, i) => i === 0 ? { ...hop, addresses } : hop) } : { ...options, ...(addresses ? { addresses } : {}) });
  }
  async answerHostKey(accept: boolean) { await this.request("hostkey", { accept }); }
  async rpc<T = unknown>(method: string, params: Record<string, unknown> = {}) { return await this.request("rpc", { method, params }, 65000) as T; }
  async inspectKey(privateKey: string, passphrase?: string) { return await this.request("inspect-key", { privateKey, passphrase }) as { type: string; fingerprint: string; protected: boolean }; }
  async answerPrompt(id: string, value: string, canceled = false) { await this.request("answer", { id, value, canceled }); }
  async write(data: string | Uint8Array) {
    if (this.phase !== "interactive") throw new Error("终端尚未连接");
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    for (let offset = 0; offset < bytes.length; offset += 32768)
      await this.request("write", { data: encodeBase64(bytes.subarray(offset, offset + 32768)) });
  }
  async resize(cols: number, rows: number) {
    if (this.phase !== "interactive") return;
    await this.request("resize", { cols, rows });
  }
  async stop() {
    this.stopped = true;
    this.decision++;
    this.detachListeners();
    this.rejectPending(new Error("会话已关闭"));
    if (this.phase !== "closed" && this.phase !== "failed") this.enter("closed", "已结束连接");
    await this.pipe.stop().catch(() => {});
  }
  private detachListeners() { for (const off of this.detach.splice(0)) off(); }
  private rejectPending(error: Error) {
    for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(error); }
    this.pending.clear();
  }
  private request(method: string, params: Record<string, unknown>, timeout = 15000) {
    if (!this.started || this.stopped) return Promise.reject(new Error("SSH 代理已关闭"));
    const id = String(++this.counter);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("SSH 代理响应超时")); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.pipe.send(JSON.stringify({ id, method, params })).catch(error => {
        const waiting = this.pending.get(id);
        if (!waiting) return;
        clearTimeout(waiting.timer); this.pending.delete(id); reject(errorOf(error));
      });
    });
  }
  private emit(event: SessionEvent) { for (const listener of [...this.listeners]) listener(event); }
  private enter(phase: SessionPhase, detail: string) { this.phase = phase; this.emit({ kind: "phase", phase, detail }); }
  private decide(action: () => Promise<void>) {
    const revision = ++this.decision;
    let used = false;
    return () => {
      if (used || this.stopped || revision !== this.decision || this.phase === "failed" || this.phase === "closed") return;
      used = true;
      void action().catch(error => { if (!this.stopped) this.emit({ kind: "error", message: errorOf(error).message }); });
    };
  }
  private receive(line: string) {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      message = parsed as Record<string, unknown>;
    } catch { this.emit({ kind: "error", message: "SSH 代理返回了无效消息" }); return; }
    if (typeof message.id === "string" && message.event === undefined) {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      clearTimeout(waiting.timer); this.pending.delete(message.id);
      if (message.ok === true) waiting.resolve(message.result);
      else waiting.reject(new Error(String(message.error ?? "请求失败")));
      return;
    }
    switch (message.event) {
      case "hop": this.emit({ kind: "hop", hop: Number(message.hop) || 0, phase: message.phase as SessionPhase, detail: String(message.detail || "") }); break;
      case "service": this.emit({ kind: "service", event: String(message.serviceEvent ?? ""), data: message.data }); break;
      case "phase": {
        const phase = message.phase as SessionPhase;
        if (!phases.has(phase)) { this.emit({ kind: "error", message: "SSH 代理返回了未知阶段" }); return; }
        if (phase === "failed" || phase === "closed") this.decision++;
        this.enter(phase, String(message.detail ?? "")); break;
      }
      case "hostkey": {
        if (typeof message.keyType !== "string" || typeof message.fingerprint !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(message.fingerprint)) {
          this.emit({ kind: "error", message: "SSH 代理返回了无效主机指纹" }); return;
        }
        if (!message.intermediate) this.enter("hostkey", "等待确认主机密钥");
        let accept = false;
        const decide = this.decide(() => this.answerHostKey(accept));
        this.emit({ kind: "hostkey", hop: typeof message.hop === "number" ? message.hop : undefined, intermediate: !!message.intermediate, keyType: message.keyType, fingerprint: message.fingerprint,
          accept: () => { accept = true; decide(); }, reject: () => { accept = false; decide(); } });
        break;
      }
      case "prompt": {
        if (typeof message.id !== "string" || typeof message.prompt !== "string") return;
        const id = message.id;
        let value = "", canceled = false;
        const decide = this.decide(() => this.answerPrompt(id, value, canceled));
        this.emit({ kind: "prompt", hop: typeof message.hop === "number" ? message.hop : undefined, id, promptKind: message.kind === "verification-code" ? "verification-code" : message.kind === "passphrase" ? "passphrase" : "password", prompt: message.prompt,
          answer: answer => { value = answer; decide(); }, cancel: () => { canceled = true; decide(); } });
        break;
      }
      case "data":
        if (typeof message.data === "string") {
          try { this.emit({ kind: "data", bytes: decodeBase64(message.data) }); }
          catch { this.emit({ kind: "error", message: "SSH 代理返回了无效终端数据" }); }
        }
        break;
      case "exit":
        this.exitReported = true;
        this.emit({ kind: "exit", code: typeof message.code === "number" ? message.code : null, message: String(message.message ?? "") }); break;
      case "error": this.emit({ kind: "error", message: String(message.message ?? "") }); break;
    }
  }
}
