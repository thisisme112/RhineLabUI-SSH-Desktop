import { parseSshLine, type SshEvent, type SshEventName } from "./events.ts";

/**
 * Connection phase derived only from real OpenSSH events.
 *
 * Rules this file exists to enforce (DESKTOP-SSH.md):
 *  - R1  no event, no movement. Nothing here is time-driven; `tick()` can only
 *        raise a `stalled` flag, never advance a phase.
 *  - R3  every phase and every fact keeps the raw line that produced it.
 *  - R4  an unrecognised or missing event degrades honestly: the phase stays
 *        where the evidence left it and the UI is told it is stalled.
 */

export type SshPhase =
  | "idle"
  | "resolving"
  | "connecting"
  | "handshake"
  | "hostkey"
  | "authenticating"
  | "opening"
  | "interactive"
  | "failed"
  | "closed";

/** Monotonic rank; a later event never moves the phase backwards. */
const RANK: Record<SshPhase, number> = {
  idle: 0,
  resolving: 1,
  connecting: 2,
  handshake: 3,
  hostkey: 4,
  authenticating: 5,
  opening: 6,
  interactive: 7,
  failed: 8,
  closed: 9,
};

const PHASE_OF: Partial<Record<SshEventName, SshPhase>> = {
  "config.loaded": "resolving",
  "tcp.connecting": "connecting",
  "tcp.established": "handshake",
  "banner.local": "handshake",
  "banner.remote": "handshake",
  "kex.algorithms": "handshake",
  "kex.ciphers": "handshake",
  "hostkey.received": "hostkey",
  "hostkey.unknown": "hostkey",
  "hostkey.verified": "authenticating",
  "auth.methods": "authenticating",
  "auth.offering": "authenticating",
  "auth.accepted": "authenticating",
  "auth.succeeded": "opening",
  "session.entering": "interactive",
  "session.authenticated": "interactive",
};

const FAILURE_PHASE: Partial<Record<SshEventName, SshPhase>> = {
  "dns.failed": "failed",
  "tcp.failed": "failed",
  "kex.reset": "failed",
  "hostkey.mismatch": "failed",
  "auth.denied": "failed",
  "session.closed": "closed",
};

/**
 * How long a phase may stay silent before the UI says so out loud. `Infinity`
 * means the phase legitimately waits for a human (fingerprint prompt, password,
 * or an idle interactive session).
 */
export const PHASE_DEADLINE: Record<SshPhase, number> = {
  idle: 5_000,
  resolving: 8_000,
  connecting: 20_000,
  handshake: 20_000,
  hostkey: Number.POSITIVE_INFINITY,
  authenticating: Number.POSITIVE_INFINITY,
  opening: 15_000,
  interactive: Number.POSITIVE_INFINITY,
  failed: Number.POSITIVE_INFINITY,
  closed: Number.POSITIVE_INFINITY,
};

/** Display label for the phase — used verbatim by the UI. */
export const PHASE_LABEL: Record<SshPhase, string> = {
  idle: "准备中",
  resolving: "解析配置与主机",
  connecting: "建立 TCP 连接",
  handshake: "版本交换与密钥协商",
  hostkey: "核验主机密钥",
  authenticating: "身份认证",
  opening: "请求终端会话",
  interactive: "会话已建立",
  failed: "连接失败",
  closed: "连接已关闭",
};

/** Which raw fields become user-visible "verified facts" (rule R3). */
const FACT_KEYS: Partial<Record<SshEventName, [string, string][]>> = {
  "config.loaded": [["configPath", "path"]],
  "tcp.connecting": [
    ["host", "host"],
    ["address", "address"],
    ["port", "port"],
  ],
  "banner.local": [["localBanner", "banner"]],
  "banner.remote": [
    ["remoteProtocol", "protocol"],
    ["remoteSoftware", "software"],
  ],
  "kex.algorithms": [
    ["kex", "kex"],
    ["hostKeyAlgorithm", "hostKeyAlgorithm"],
  ],
  "kex.ciphers": [
    ["cipher", "cipher"],
    ["mac", "mac"],
    ["compression", "compression"],
  ],
  "hostkey.received": [
    ["hostKeyType", "type"],
    ["hostKeyFingerprint", "fingerprint"],
  ],
  "hostkey.verified": [
    ["knownHosts", "knownHosts"],
    ["knownHostsLine", "line"],
  ],
  "auth.methods": [["authMethods", "list"]],
  "auth.accepted": [["authKey", "target"]],
  "auth.succeeded": [["authMethod", "method"]],
};

export type SshFact = {
  key: string;
  value: string;
  event: SshEvent;
  /** Milliseconds since the session started; -1 when unknown. */
  at: number;
};

export type SshTimelineEntry = {
  phase: SshPhase;
  label: string;
  /** Milliseconds since session start. */
  at: number;
  /** Milliseconds spent in the phase before the next one began, or -1 if current. */
  duration: number;
};

/** Everything the UI and the audit log need, derived from events alone. */
export type SshStatus = {
  phase: SshPhase;
  label: string;
  /** Latest event, whatever it was. */
  last: SshEvent | null;
  /** Set when the current phase outran its deadline. Purely informational. */
  stalled: boolean;
  stalledFor: number;
  /** Failure reason for terminal phases, taken from the event detail. */
  failure: string | null;
  facts: Record<string, SshFact>;
  timeline: SshTimelineEntry[];
  /** Lines OpenSSH printed that this parser does not know about. Kept, never dropped. */
  unknownLines: string[];
  eventCount: number;
};

export class SshSessionTracker {
  private phase: SshPhase = "idle";
  private started: number | null = null;
  private phaseAt = 0;
  private last: SshEvent | null = null;
  /**
   * The event that actually ended the connection. OpenSSH usually prints a
   * second, uninformative "Connection closed by …" line afterwards; reporting
   * that instead of the cause would hide the diagnosis.
   */
  private failureEvent: SshEvent | null = null;
  /** Reason recorded by `ended()` when no log line explained the ending. */
  private endNote: string | null = null;
  private events: { event: SshEvent; at: number }[] = [];
  /** Transitions the machine actually made — never recomputed from events. */
  private transitions: { phase: SshPhase; at: number }[] = [];
  private facts: Record<string, SshFact> = {};
  private unknown: string[] = [];

  reset(now = 0) {
    this.phase = "idle";
    this.started = null;
    this.phaseAt = now;
    this.last = null;
    this.failureEvent = null;
    this.endNote = null;
    this.events = [];
    this.transitions = [];
    this.facts = {};
    this.unknown = [];
  }

  /** Consume one parsed log line. `now` is a monotonic millisecond clock. */
  push(event: SshEvent, now: number) {
    if (this.started === null) this.started = now;
    this.last = event;
    this.events.push({ event, at: now });

    const failure = FAILURE_PHASE[event.name];
    const next = failure ?? PHASE_OF[event.name];
    // A late success event must not resurrect a finished connection, and a
    // lower-ranked success event must not rewind a phase already reached.
    if (next && RANK[next] > RANK[this.phase] && !this.isTerminal()) {
      this.phase = next;
      this.phaseAt = now;
      // The timeline is a log of real transitions. Deriving it from the event
      // stream instead would record moves the sticky-phase rules refused.
      this.transitions.push({ phase: next, at: now });
      if (failure) this.failureEvent = event;
    }

    for (const [key, field] of FACT_KEYS[event.name] ?? []) {
      const value = event.detail[field];
      if (value === undefined || value === "") continue;
      this.facts[key] = { key, value, event, at: this.elapsed(now) };
    }
    return this;
  }

  /** Feed a whole log file or chunk. Returns the parsed events in order. */
  feed(text: string, now: number, step = 1) {
    const accepted: SshEvent[] = [];
    let clock = now;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parsed = parseSshLine(line);
      if (!parsed.matched) {
        this.unknown.push(parsed.raw);
        continue;
      }
      this.push(parsed.event, clock);
      accepted.push(parsed.event);
      clock += step;
    }
    return accepted;
  }

  /**
   * Raise the stall flag when the current phase has been silent too long.
   * Deliberately returns nothing that could be mistaken for progress.
   */
  tick(now: number) {
    return this.status(now).stalled;
  }

  /**
   * The ssh process ended. An exit status is real evidence even when the log
   * printed nothing terminal — answering "no" to an unknown host key is exactly
   * that case. Existing terminal states are left alone.
   */
  ended(exitCode: number | null, now: number, note?: string) {
    if (this.isTerminal()) return false;
    this.phase = exitCode === 0 ? "closed" : "failed";
    this.phaseAt = now;
    this.transitions.push({ phase: this.phase, at: now });
    // A clean exit has no failure to report; the outcome already says "closed".
    this.endNote =
      exitCode === 0
        ? null
        : (note ?? `ssh 以退出代码 ${exitCode ?? "?"} 结束，日志中没有终止行`);
    return true;
  }

  private isTerminal() {
    return this.phase === "failed" || this.phase === "closed";
  }

  private elapsed(now: number) {
    return this.started === null ? -1 : Math.max(0, now - this.started);
  }

  status(now: number): SshStatus {
    const deadline = PHASE_DEADLINE[this.phase];
    const stalledFor = Number.isFinite(deadline)
      ? Math.max(0, now - this.phaseAt)
      : 0;
    return {
      phase: this.phase,
      label: PHASE_LABEL[this.phase],
      last: this.last,
      stalled: Number.isFinite(deadline) && stalledFor >= deadline,
      stalledFor,
      // `failure` explains a failure. A session that simply ended has an
      // outcome, not a reason, and saying otherwise reads as an error.
      failure:
        this.phase === "failed"
          ? this.failureEvent
            ? describeFailure(this.failureEvent)
            : (this.endNote ?? describeFailure(this.last))
          : null,
      facts: { ...this.facts },
      timeline: this.buildTimeline(now),
      unknownLines: [...this.unknown],
      eventCount: this.events.length,
    };
  }

  private buildTimeline(now: number): SshTimelineEntry[] {
    return this.transitions.map((entry, index) => {
      const next = this.transitions[index + 1];
      return {
        phase: entry.phase,
        label: PHASE_LABEL[entry.phase],
        at: entry.at,
        duration: Math.max(0, (next ? next.at : now) - entry.at),
      };
    });
  }
}

function describeFailure(event: SshEvent | null): string | null {
  if (!event) return "连接已结束";
  if (event.name === "session.closed") return "连接已关闭";
  const reason = event.detail.reason ?? event.detail.methods ?? "";
  const table: Partial<Record<SshEventName, string>> = {
    "dns.failed": "无法解析主机名",
    "tcp.failed": "无法建立 TCP 连接",
    "kex.reset": "密钥交换阶段被对端中断",
    "hostkey.mismatch": "主机密钥与已知记录不符",
    "auth.denied": "认证被拒绝",
    "session.closed": "连接已关闭",
  };
  const base = table[event.name] ?? "连接失败";
  return reason ? `${base}：${reason}` : base;
}
