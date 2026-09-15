import { parsePtyNotice, parseSshLine, type SshEvent } from "./events.ts";
import { SshSessionTracker, type SshStatus } from "./session.ts";
import { HandshakeDriver, type HandshakeSnapshot } from "./handshake.ts";
import { TrafficMeter } from "./traffic.ts";
import type { ServicesBridge, SftpBridge, MonitorBridge, TunnelsBridge } from "./services";
import { bindSessionBridge, type DesktopSessionsBridge } from "./session-bridge.ts";
import type { MigrationBridge } from "./migration-types";
import {
  buildSessionRecord,
  formatSessionRecord,
  recordFileName,
  type SessionRecord,
} from "./audit.ts";

/**
 * Renderer-side view of one ssh session.
 *
 * It owns no transport of its own: the pty and its event log live in the main
 * process, and this class only turns the event stream into a state the UI can
 * draw. That keeps the rule that matters — nothing here advances on a timer.
 */

export type SshConnectionOptions = {
  user?: string;
  port?: number;
  identityFile?: string;
  authMode?: "auto" | "password" | "key";
  keyId?: string;
  jumpHost?: string;
  connectTimeout?: number;
  keepAliveInterval?: number;
  keepAliveCountMax?: number;
};

export type SshHostProfile = SshConnectionOptions & {
  id?: string;
  name: string;
  hostname: string;
};

export type CredentialState = { password: "none" | "saved" | "needs-update"; passphrase: "none" | "saved" | "needs-update"; available: boolean };
export type SshKeyEntry = { id: string; name: string; source: "file" | "import"; file?: string; type: string; fingerprint: string; protected: boolean; missing?: boolean; hosts?: string[] };

export type SshHostsResult = {
  ok: boolean;
  hosts: SshHostEntry[];
  configPath?: string;
  profilesPath?: string;
  revision?: string;
  error?: string;
};

export type SshHostProfilesBridge = {
  save(
    profile: SshHostProfile,
    revision: string,
  ): Promise<{
    ok: boolean;
    profile?: SshHostProfile;
    revision?: string;
    error?: string;
  }>;
  remove(
    id: string,
    revision: string,
  ): Promise<{ ok: boolean; error?: string }>;
  pickIdentity(): Promise<{
    ok: boolean;
    canceled?: boolean;
    file?: string;
    error?: string;
  }>;
};

export type SshLaunchDescriptor = SshConnectionOptions & {
  /** `host` or `user@host`, exactly as typed. */
  target: string;
  displayName?: string;
  extraArgs?: string[];
  cols?: number;
  rows?: number;
};

export type SshStartResult =
  | {
      ok: true;
      argv: string[];
      logPath: string;
      file: string;
      id?: string;
      startedAt?: number;
      displayTarget?: string;
    }
  | { ok: false; error: string };

export type SshExitInfo = {
  exitCode: number | null;
  signal?: number;
  logPath: string;
  bytesIn: number;
  bytesOut: number;
  logLines: number;
  elapsedMs?: number;
};

export type SshPrompt = { id: number; canRemember?: boolean } & (
  | { kind: "password"; prompt: string; host: string }
  | { kind: "passphrase"; prompt: string; key: string }
  | { kind: "hostkey"; prompt: string; host: string }
  | { kind: "verification-code"; prompt: string }
);

export type SshTraffic = {
  bytesIn: number;
  bytesOut: number;
  logLines: number;
  elapsedMs: number;
};

/** A saved profile or a host read by the main process from SSH config. */
export type SshHostEntry = {
  alias: string;
  displayName?: string;
  source?: "config" | "saved";
  profile?: SshHostProfile;
  hostname: string;
  user: string;
  port: string;
  identityFile?: string;
  /** The verbatim config block the entry was read from (its own evidence). */
  raw?: string;
};

/** One stored session record, as listed by the main process. */
export type SessionRecordSummary = {
  file: string;
  id: string;
  target: string;
  targetLabel?: string;
  startedAt: string;
  durationMs: number;
  outcome: string;
  summary: string;
  bytesIn: number;
  bytesOut: number;
  exitCode: number | null;
  logPath: string;
};

/** The surface `electron/preload.cjs` exposes. Deliberately small. */
export type DesktopSessionBridge = {
  /** Protocol facts from native SSH implementations, separate from terminal text. */
  onProtocol?(listener: (event: SshEvent) => void): () => void;
  start(descriptor: SshLaunchDescriptor): Promise<SshStartResult>;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  stop(): void;
  answer(id: number, value: string, remember?: boolean): Promise<{ ok: boolean; error?: string }>;
  record(
    payload: SessionRecord,
  ): Promise<{ ok: boolean; file?: string; error?: string }>;
  export(payload: {
    suggestedName: string;
    text: string;
    target?: string;
  }): Promise<{
    ok: boolean;
    file?: string;
    canceled?: boolean;
    error?: string;
  }>;
  onData(listener: (data: string) => void): () => void;
  onLog(listener: (line: string) => void): () => void;
  onPrompt(listener: (prompt: SshPrompt | null) => void): () => void;
  onTraffic(listener: (traffic: SshTraffic) => void): () => void;
  onExit(listener: (info: SshExitInfo) => void): () => void;
};

declare global {
  interface Window {
    rhineDesktop?: {
      isDesktop: boolean;
      platform: string;
      /** Which of the two window captions to use; the OS draws it. */
      theme?: (value: "light" | "dark") => void;
      versions: { electron: string; chrome: string; node: string };
      session?: DesktopSessionBridge | DesktopSessionsBridge;
      services?: ServicesBridge;
      sftp?: SftpBridge;
      monitor?: MonitorBridge;
      tunnels?: TunnelsBridge;
      background?: { set(enabled: boolean): Promise<{ enabled: boolean; notificationGranted: boolean }>; status(): Promise<{ enabled: boolean; notificationGranted: boolean }> };
      migration?: MigrationBridge;
      /** Text-only clipboard, read only on an explicit terminal paste action. */
      clipboard?: {
        readText(): Promise<{ ok: boolean; text?: string; error?: string }>;
        writeText(text: string): Promise<{ ok: boolean; error?: string }>;
      };
      /** Saved profiles and hosts from the user's own SSH config. */
      hosts?: () => Promise<SshHostsResult>;
      hostProfiles?: SshHostProfilesBridge;
      credentials?: {
        status(target: string): Promise<{ ok: boolean; state?: CredentialState; error?: string }>;
        save(request: { target: string; kind: "password" | "passphrase"; value: string }): Promise<{ ok: boolean; state?: CredentialState; error?: string }>;
        remove(request: { target: string; kind?: "password" | "passphrase" }): Promise<{ ok: boolean; state?: CredentialState; error?: string }>;
      };
      keys?: {
        list(): Promise<{ ok: boolean; keys: SshKeyEntry[]; error?: string }>;
        add(input: { name?: string; source: "file" | "import"; file?: string; content?: string; passphrase?: string }): Promise<{ ok: boolean; key?: SshKeyEntry; error?: string }>;
        remove(id: string): Promise<{ ok: boolean; error?: string }>;
      };
      /** Past session records, read back for the host cards. */
      records?: {
        list(): Promise<{
          ok: boolean;
          records: SessionRecordSummary[];
          dir?: string;
          error?: string;
        }>;
        read(file: string): Promise<{
          ok: boolean;
          record?: SessionRecord;
          file?: string;
          error?: string;
        }>;
        log(file: string): Promise<{
          ok: boolean;
          lines?: string[];
          truncated?: boolean;
          file?: string;
          error?: string;
        }>;
        prune(): Promise<{
          ok: boolean;
          removed: number;
          bytesFreed: number;
          errors?: string[];
        }>;
      };
    };
    /**
     * Automation surface for the session layer, mirroring the existing
     * `window.rhine` review controls. Used by the desktop smoke checks.
     */
    rhineSsh?: SshClient;
    /** The terminal surface, exposed for the same reason. */
    rhineSshUi?: {
      startSession(
        target: string | SshLaunchDescriptor,
      ): Promise<SshStartResult>;
      reconnect(): Promise<SshStartResult>;
      openTerminal(): void;
      closeTerminal(): void;
      readonly isOpen: boolean;
      readonly hasFocus: boolean;
      readonly promptKind: string | null;
      readonly promptOpen: boolean;
      readonly promptText: string;
      answerHostKey(accept: boolean): void;
      answerSecret(value: string): void;
      dismissPrompt(): void;
      openAudit(): void;
      closeAudit(): void;
      readonly auditOpen: boolean;
      readonly auditText: string;
      exportRecord(target?: string): Promise<{
        ok: boolean;
        file?: string;
        canceled?: boolean;
        error?: string;
        record?: SessionRecord;
      }>;
      openHosts(): void;
      closeHosts(): void;
      readonly hostsOpen: boolean;
      readonly hostDirectoryCard: number;
      readonly hostList: readonly SshHostEntry[];
      /** Connect to an alias from its card's context (selects + lifts it). */
      connectHost(alias: string): void;
      /** The card index an alias is bound to, or null. */
      cardOf(alias: string): number | null;
      /** The alias bound to a card index, or null. */
      hostAt(card: number): string | null;
      readonly boundHosts: readonly string[];
      readonly overflowHosts: readonly string[];
      reloadHosts(): Promise<{ ok: boolean; error?: string }>;
    };
  }
}

export class SshClient {
  private tracker = new SshSessionTracker();
  /** Turns real events into the detail reveal's timeline (see handshake.ts). */
  private driver = new HandshakeDriver();
  /** Turns measured bytes into the array's displacement bands (traffic.ts). */
  private trafficMeter = new TrafficMeter();
  private hasSession = false;
  private starting = false;
  private queued: (() => void)[] = [];
  private revision = 0;
  private authenticated = false;
  private ptyFailure: SshEvent | null = null;
  private endedAt: number | null = null;
  private answering = false;
  private listeners = new Set<(status: SshStatus) => void>();
  private unsubscribes: (() => void)[] = [];
  /** Raw pty bytes, for the terminal surface added in a later stage. */
  private transcript = "";
  /** Every log line, including ones the parser does not know (rule R3/R4). */
  private log: string[] = [];
  private prompt: SshPrompt | null = null;
  private exitInfo: SshExitInfo | null = null;
  private live: SshTraffic = {
    bytesIn: 0,
    bytesOut: 0,
    logLines: 0,
    elapsedMs: 0,
  };
  private clock = 0;
  /** Subscribers to raw terminal bytes, for the terminal surface to render. */
  private outputListeners = new Set<(chunk: string) => void>();
  /** Partial pty line while scanning for notices that never reach the log. */
  private ptyPending = "";
  /** What the session was launched with, for its own record (rule R5). */
  private meta: {
    id: string;
    target: string;
    displayTarget: string;
    argv: string[];
    logPath: string;
    startedAt: string;
  } | null = null;
  private startedAtMs = 0;
  private scopedBridge: DesktopSessionBridge | null = null;
  private cancelStarting = false;

  get id() { return this.meta?.id ?? ""; }

  static get available(): boolean {
    return Boolean(window.rhineDesktop?.session);
  }

  private bridge(): DesktopSessionBridge {
    if (this.scopedBridge) return this.scopedBridge;
    const session = window.rhineDesktop?.session;
    if (!session) throw new Error("会话桥未就绪：当前不是桌面构建");
    // Legacy transport fixtures keep exercising the original protocol parser.
    if ("reserve" in session) return bindSessionBridge(session, this.id);
    return session;
  }

  /** Monotonic milliseconds; falls back to Date.now where unavailable. */
  private now(): number {
    const value =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    this.clock = Math.max(this.clock, value);
    return this.clock;
  }

  async start(descriptor: SshLaunchDescriptor): Promise<SshStartResult> {
    if (this.active) return { ok: false, error: "已有会话在运行" };
    this.reset();
    this.scopedBridge = null;
    this.cancelStarting = false;
    this.hasSession = true;
    this.starting = true;
    this.revision++;
    this.startedAtMs = this.now();
    const startedAt = new Date().toISOString();
    this.meta = {
      id: `${startedAt.replace(/[:.]/g, "-")}-${this.revision}`,
      target: descriptor.target.trim(),
      displayTarget: descriptor.displayName || descriptor.target.trim(),
      argv: [],
      logPath: "",
      startedAt,
    };
    this.emit();
    const size = { cols: descriptor.cols ?? 80, rows: descriptor.rows ?? 24 };
    let result: SshStartResult;
    try {
      const transport = window.rhineDesktop?.session;
      if (!transport) throw new Error("会话桥未就绪");
      if ("reserve" in transport) {
        const reservation = await transport.reserve();
        if (!reservation.ok || !reservation.id) throw new Error(reservation.error || "无法分配会话");
        this.meta!.id = reservation.id;
        this.scopedBridge = bindSessionBridge(transport, reservation.id);
        if (this.cancelStarting) { this.scopedBridge.stop(); throw new Error("连接已取消"); }
      } else this.scopedBridge = transport;
      const bridge = this.bridge();
      this.bind(bridge);
      this.emit();
      result = await bridge.start({ ...descriptor, ...size });
    } catch (error) {
      result = { ok: false, error: String(error) };
    }
    this.starting = false;
    if (!result.ok) {
      this.hasSession = false;
      this.endedAt = this.now();
      this.tracker.ended(-1, this.endedAt, result.error);
      this.queued = [];
      this.unbind();
      this.emit();
      return result;
    }
    this.meta = {
      id: result.id ?? this.meta!.id,
      target: descriptor.target.trim(),
      displayTarget:
        result.displayTarget ||
        descriptor.displayName ||
        descriptor.target.trim(),
      argv: result.argv,
      logPath: result.logPath,
      startedAt:
        result.startedAt === undefined
          ? startedAt
          : new Date(result.startedAt).toISOString(),
    };
    // IPC can deliver output before invoke resolves. Publish metadata before
    // consuming those events, especially an immediate process exit.
    const queued = this.queued;
    this.queued = [];
    for (const consume of queued) consume();
    this.emit();
    return result;
  }

  private reset() {
    this.unbind();
    this.tracker.reset(this.now());
    this.driver.reset();
    this.trafficMeter.reset();
    this.transcript = "";
    this.ptyPending = "";
    this.log = [];
    this.prompt = null;
    this.exitInfo = null;
    this.meta = null;
    this.endedAt = null;
    this.ptyFailure = null;
    this.authenticated = false;
    this.answering = false;
    this.queued = [];
    this.live = { bytesIn: 0, bytesOut: 0, logLines: 0, elapsedMs: 0 };
  }

  private bind(bridge: DesktopSessionBridge) {
    const revision = this.revision;
    const receive =
      <T>(consume: (value: T) => void) =>
      (value: T) => {
        if (revision !== this.revision || this.exitInfo) return;
        if (this.starting) this.queued.push(() => consume(value));
        else consume(value);
      };
    this.unsubscribes = [
      ...(bridge.onProtocol ? [bridge.onProtocol(receive<SshEvent>(event => {
        this.log.push(event.raw);
        if (["auth.succeeded", "session.entering", "session.authenticated"].includes(event.name)) {
          this.authenticated = true; this.ptyFailure = null; this.prompt = null;
        }
        this.tracker.push(event, this.now()); this.driver.apply(event.name); this.emit();
      }))] : []),
      bridge.onData(
        receive<string>((data) => {
          this.transcript = (this.transcript + data).slice(-200_000);
          for (const listener of this.outputListeners) listener(data);
          // Untrusted remote text must never end a live session. Retain a pre-
          // authentication notice only as an explanation for a real failed exit.
          this.ptyPending = (this.ptyPending + data).slice(-4096);
          const parts = this.ptyPending.split(/\r?\n/);
          this.ptyPending = parts.pop() ?? "";
          for (const line of parts) {
            const notice = !this.authenticated ? parsePtyNotice(line) : null;
            if (notice) this.ptyFailure = notice;
          }
          // First bytes from a session that has actually entered interactive
          // mode: the terminal is live, so the glass may finish clearing. Driven
          // by arriving output, never by elapsed time.
          if (
            !this.driver.snapshot().frozen &&
            this.tracker.status(this.now()).phase === "interactive"
          )
            this.driver.markInteractive();
          this.emit();
        }),
      ),
      bridge.onLog(
        receive<string>((line) => {
          this.log.push(line);
          const parsed = parseSshLine(line);
          // The remote owns everything after shell entry. Keep those lines
          // readable, but they cannot change the verified host or connection.
          if (
            parsed.matched &&
            this.tracker.status(this.now()).phase === "interactive"
          ) {
            this.emit();
            return;
          }
          // Unmatched lines are still kept above: the raw stream is the audit.
          if (parsed.matched) {
            if (
              [
                "auth.succeeded",
                "session.entering",
                "session.authenticated",
              ].includes(parsed.event.name)
            ) {
              this.authenticated = true;
              this.ptyFailure = null;
              this.prompt = null;
            }
            this.tracker.push(parsed.event, this.now());
            this.driver.apply(parsed.event.name);
          } else this.tracker.feed(line, this.now());
          this.emit();
        }),
      ),
      bridge.onPrompt(
        receive<SshPrompt | null>((prompt) => {
          // Authentication prompts do not move the timeline: the log lines that
          // accompany them already did, and a prompt means "waiting for a person",
          // which is a state the UI shows rather than a stage to advance past.
          this.prompt = this.authenticated ? null : prompt;
          this.emit();
        }),
      ),
      bridge.onTraffic(
        receive<SshTraffic>((traffic) => {
          this.live = traffic;
          // Stamped with the renderer's monotonic clock: the rates are consumed
          // here, so they must be measured against the same clock that reads them.
          this.trafficMeter.sample(
            this.now(),
            traffic.bytesIn,
            traffic.bytesOut,
          );
          this.emit();
        }),
      ),
      bridge.onExit(
        receive<SshExitInfo>((info) => {
          this.endedAt = this.now();
          this.exitInfo = {
            ...info,
            elapsedMs:
              info.elapsedMs ?? Math.max(0, this.endedAt - this.startedAtMs),
          };
          this.prompt = null;
          if (info.exitCode !== 0 && !this.authenticated && this.ptyFailure) {
            this.tracker.push(this.ptyFailure, this.endedAt);
            this.driver.apply(this.ptyFailure.name);
          }
          // An exit status is evidence even when the log said nothing terminal.
          this.tracker.ended(info.exitCode, this.endedAt);
          this.driver.apply("session.closed");
          this.trafficMeter.sample(this.endedAt, info.bytesIn, info.bytesOut);
          this.trafficMeter.update(this.endedAt);
          this.unbind();
          this.emit();
        }),
      ),
    ];
  }

  private unbind() {
    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];
  }

  write(data: string) {
    this.bridge().write(data);
  }

  resize(cols: number, rows: number) {
    this.bridge().resize(cols, rows);
  }

  stop() {
    this.cancelStarting = true;
    this.scopedBridge?.stop();
  }

  /** A reply is bound to one request; duplicate/stale clicks cannot feed a shell. */
  async answerPrompt(value: string, remember = false) {
    const pending = this.prompt;
    if (!pending || !this.active || this.answering)
      return { ok: false, error: "当前没有待回答的请求" };
    if (!value || /[\r\n\0]/.test(value))
      return { ok: false, error: "请输入一行非空内容" };
    this.answering = true;
    const revision = this.revision;
    try {
      const result = await this.bridge().answer(pending.id, value, remember);
      if (
        revision === this.revision &&
        result.ok &&
        this.prompt?.id === pending.id
      ) {
        this.prompt = null;
        this.emit();
      }
      return result;
    } finally {
      this.answering = false;
    }
  }

  get active() {
    return this.starting || (this.hasSession && !this.exitInfo);
  }
  get generation() {
    return this.revision;
  }

  onChange(listener: (status: SshStatus) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Raw terminal bytes as they arrive. Separate from `onChange`, which fires on
   * derived state: the terminal must render bytes in order and without
   * re-rendering the whole transcript on every event.
   */
  onOutput(listener: (chunk: string) => void) {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  /**
   * Advance the reveal timeline by a real frame delta and report where it is.
   * Returns null until a session has been started, so the caller can hand the
   * scene back to its own clock.
   */
  tick(dt: number): HandshakeSnapshot | null {
    if (!this.hasSession) return null;
    // Bands decay on their own envelope, so they must be advanced every frame
    // even when no new traffic reading arrived.
    this.trafficMeter.update(this.now());
    return this.driver.advance(dt);
  }

  get handshake(): HandshakeSnapshot {
    return this.driver.snapshot();
  }

  /** Measured traffic, in the shape `scene.setPlayfield` consumes. */
  get meter(): TrafficMeter {
    return this.trafficMeter;
  }

  private emit() {
    const status = this.status();
    for (const listener of this.listeners) listener(status);
  }

  status(): SshStatus {
    return this.tracker.status(this.endedAt ?? this.now());
  }

  /** Terminal bytes so far. The terminal surface owns rendering them. */
  get output() {
    return this.transcript;
  }

  /** Every log line verbatim — what "show the raw stream" displays. */
  get rawLog(): readonly string[] {
    return this.log;
  }

  get pendingPrompt(): SshPrompt | null {
    return this.prompt;
  }

  /** The target the current (or last) session was launched with, if any. */
  get target(): string | null {
    return this.meta?.target ?? null;
  }

  get displayTarget(): string | null {
    return this.meta?.displayTarget ?? null;
  }

  get exit(): SshExitInfo | null {
    return this.exitInfo;
  }

  /**
   * The session's record of itself: phase timings, negotiated values with the
   * lines that proved them, and measured traffic. Null before any session ran.
   */
  buildRecord(): SessionRecord | null {
    if (!this.meta || !this.meta.argv.length) return null;
    const traffic = this.traffic;
    const meter = this.trafficMeter.measurements;
    return buildSessionRecord({
      id: this.meta.id,
      target: this.meta.target,
      targetLabel: this.meta.displayTarget,
      startedAt: this.meta.startedAt,
      durationMs: traffic.elapsedMs,
      status: this.status(),
      traffic,
      peakBytesPerSecondIn: meter.peakBytesPerSecondIn,
      peakBytesPerSecondOut: meter.peakBytesPerSecondOut,
      exitCode: this.exitInfo?.exitCode ?? null,
      argv: this.meta.argv,
      logPath: this.meta.logPath,
    });
  }

  /** Persist the record beside its raw event log. */
  async persistRecord(): Promise<{
    ok: boolean;
    file?: string;
    error?: string;
  }> {
    const record = this.buildRecord();
    if (!record) return { ok: false, error: "没有可记录会话" };
    return this.bridge().record(record);
  }

  /** Write the readable export; without `target` the user picks a location. */
  async exportRecord(
    target?: string,
    record = this.buildRecord(),
  ): Promise<{
    ok: boolean;
    file?: string;
    canceled?: boolean;
    error?: string;
    record?: SessionRecord;
  }> {
    if (!record) return { ok: false, error: "没有可导出的会话" };
    const result = await this.bridge().export({
      suggestedName: recordFileName(record),
      text: formatSessionRecord(record),
      target,
    });
    return { ...result, record };
  }

  /** Live byte counters, the fuel for the traffic-driven array wave (rule R1:
   * the wave is driven by measured bytes, never by a decorative loop).
   */
  get traffic(): SshTraffic {
    return this.exitInfo
      ? {
          bytesIn: this.exitInfo.bytesIn,
          bytesOut: this.exitInfo.bytesOut,
          logLines: this.exitInfo.logLines,
          elapsedMs: this.exitInfo.elapsedMs!,
        }
      : {
          ...this.live,
          elapsedMs: this.hasSession
            ? Math.max(0, this.now() - this.startedAtMs)
            : 0,
        };
  }

  dispose() {
    this.unbind();
    this.listeners.clear();
    this.outputListeners.clear();
  }
}
