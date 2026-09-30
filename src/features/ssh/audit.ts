import { PHASE_LABEL, type SshPhase, type SshStatus } from "./session.ts";
import type { SshTraffic } from "./client.ts";

/**
 * The session's own record of itself.
 *
 * Rule R5 says "every step is usable" in two directions: the user's actions
 * produce reusable output, and the system's state is observable and exportable.
 * This module is the second half. Everything in a record came from a real event
 * or a real measurement — including, for every fact, the raw line that proved
 * it, so the exported file stands on its own as evidence rather than summary.
 */

export type AuditPhase = {
  phase: SshPhase;
  label: string;
  /** Milliseconds from session start. */
  atMs: number;
  durationMs: number;
};

export type AuditFact = {
  key: string;
  label: string;
  value: string;
  /** The ssh output line this value was read from. */
  source: string;
};

export type SessionRecord = {
  id: string;
  target: string;
  targetLabel?: string;
  startedAt: string;
  durationMs: number;
  outcome: "interactive" | "closed" | "failed";
  failure: string | null;
  exitCode: number | null;
  phases: AuditPhase[];
  facts: AuditFact[];
  traffic: {
    bytesIn: number;
    bytesOut: number;
    logLines: number;
    events: number;
    peakBytesPerSecondIn: number;
    peakBytesPerSecondOut: number;
  };
  unknownLines: string[];
  argv: string[];
  logPath: string;
};

/** Human labels for the fact keys the tracker produces. */
const FACT_LABELS: Record<string, string> = {
  configPath: "配置文件",
  host: "主机",
  address: "地址",
  port: "端口",
  localBanner: "本端版本",
  remoteProtocol: "对端协议",
  remoteSoftware: "对端软件",
  kex: "密钥交换算法",
  hostKeyAlgorithm: "主机密钥算法",
  cipher: "密码套件",
  mac: "消息认证码",
  compression: "压缩",
  hostKeyType: "主机密钥类型",
  hostKeyFingerprint: "主机密钥指纹",
  knownHosts: "已知主机文件",
  knownHostsLine: "已知主机行号",
  authMethods: "可用认证方式",
  authKey: "使用的密钥",
  authMethod: "实际认证方式",
};

export type RecordInput = {
  id: string;
  target: string;
  targetLabel?: string;
  startedAt: string;
  durationMs: number;
  status: SshStatus;
  traffic: SshTraffic;
  peakBytesPerSecondIn: number;
  peakBytesPerSecondOut: number;
  exitCode: number | null;
  argv: string[];
  logPath: string;
};

/**
 * Build the record from the state that actually accumulated. Facts carry the
 * raw line that produced them; unknown lines are kept rather than dropped.
 */
export function buildSessionRecord(input: RecordInput): SessionRecord {
  const { status } = input;
  // Phase timestamps arrive on the app's monotonic clock; the record reports
  // them relative to the session's own start so the numbers mean what they say.
  const origin = status.timeline[0]?.at ?? 0;
  const phases: AuditPhase[] = status.timeline.map((entry) => ({
    phase: entry.phase,
    label: entry.label,
    atMs: Math.max(0, entry.at - origin),
    durationMs: entry.duration,
  }));

  const facts: AuditFact[] = Object.values(status.facts).map((fact) => ({
    key: fact.key,
    label: FACT_LABELS[fact.key] ?? fact.key,
    value: fact.value,
    source: fact.event.raw,
  }));
  // Stable, readable order: the order the keys first appear in FACT_LABELS.
  const order = Object.keys(FACT_LABELS);
  facts.sort((a, b) => {
    const ai = order.indexOf(a.key);
    const bi = order.indexOf(b.key);
    return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi);
  });

  const outcome: SessionRecord["outcome"] =
    status.phase === "failed"
      ? "failed"
      : status.phase === "closed"
        ? "closed"
        : "interactive";

  return {
    id: input.id,
    target: input.target,
    ...(input.targetLabel ? { targetLabel: input.targetLabel } : {}),
    startedAt: input.startedAt,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    outcome,
    failure: status.failure,
    exitCode: input.exitCode,
    phases,
    facts,
    traffic: {
      bytesIn: input.traffic.bytesIn,
      bytesOut: input.traffic.bytesOut,
      logLines: input.traffic.logLines,
      events: status.eventCount,
      peakBytesPerSecondIn: Math.round(input.peakBytesPerSecondIn),
      peakBytesPerSecondOut: Math.round(input.peakBytesPerSecondOut),
    },
    unknownLines: [...status.unknownLines],
    argv: [...input.argv],
    logPath: input.logPath,
  };
}

const formatDuration = (ms: number) =>
  ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : `${(ms / 1000).toFixed(2)}s`;

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
};

const pad = (value: string, width: number) =>
  value + " ".repeat(Math.max(0, width - [...value].length));

const OUTCOME_LABEL: Record<SessionRecord["outcome"], string> = {
  interactive: "会话已建立",
  closed: "会话正常结束",
  failed: "连接失败",
};

/**
 * Plain-text export. Deliberately mirrors the archive export: UTF-8, no markup,
 * readable without this application.
 */
export function formatSessionRecord(record: SessionRecord): string {
  const lines: string[] = [];
  lines.push("RHINE LAB · ANALYSIS OS — SSH 会话记录");
  lines.push("=".repeat(48));
  lines.push("");
  lines.push(`会话编号    ${record.id}`);
  lines.push(`目标        ${record.targetLabel || record.target}`);
  lines.push(`开始时间    ${record.startedAt}`);
  lines.push(`总耗时      ${formatDuration(record.durationMs)}`);
  lines.push(`结果        ${OUTCOME_LABEL[record.outcome]}`);
  if (record.failure) lines.push(`失败原因    ${record.failure}`);
  if (record.exitCode !== null) lines.push(`退出代码    ${record.exitCode}`);
  lines.push("");

  lines.push("阶段耗时（全部来自真实事件）");
  lines.push("-".repeat(48));
  const width = Math.max(
    6,
    ...record.phases.map((entry) => [...entry.label].length),
  );
  for (const entry of record.phases)
    lines.push(
      `  ${pad(entry.label, width)}  ${formatDuration(entry.durationMs).padStart(9)}   @${formatDuration(entry.atMs)}`,
    );
  if (!record.phases.length) lines.push("  （没有记录到阶段）");
  lines.push("");

  lines.push("协商结果与已验证事实");
  lines.push("-".repeat(48));
  if (!record.facts.length) lines.push("  （没有记录到事实）");
  for (const fact of record.facts) {
    lines.push(`  ${fact.label}：${fact.value}`);
    lines.push(`    来源  ${fact.source}`);
  }
  lines.push("");

  lines.push("终端文本流量（UTF-8，不含 SSH 协议与转发流量）");
  lines.push("-".repeat(48));
  lines.push(`  下行合计    ${formatBytes(record.traffic.bytesIn)}`);
  lines.push(`  上行合计    ${formatBytes(record.traffic.bytesOut)}`);
  lines.push(
    `  下行峰值    ${formatBytes(record.traffic.peakBytesPerSecondIn)}/s`,
  );
  lines.push(
    `  上行峰值    ${formatBytes(record.traffic.peakBytesPerSecondOut)}/s`,
  );
  lines.push(`  事件行数    ${record.traffic.logLines}`);
  lines.push("");

  lines.push("执行的命令");
  lines.push("-".repeat(48));
  lines.push(`  ${record.argv.join(" ")}`);
  lines.push(`  事件日志    ${record.logPath}`);
  lines.push("");

  if (record.unknownLines.length) {
    lines.push(`未识别的事件行（${record.unknownLines.length} 行，原样保留）`);
    lines.push("-".repeat(48));
    for (const line of record.unknownLines) lines.push(`  ${line}`);
    lines.push("");
  }

  lines.push("-".repeat(48));
  lines.push("每条事实都附带产生它的原始输出行；阶段耗时取自事件到达时刻。");
  return lines.join("\n");
}

/** Filename for an export, matching the archive naming style. */
export function recordFileName(record: SessionRecord): string {
  const stamp = record.startedAt.replace(/[:.]/g, "-");
  const safe = (record.targetLabel || record.target)
    .replace(/[^\p{L}\p{N}._@-]/gu, "_")
    .slice(0, 48);
  return `RHINE-SSH-${stamp}-${safe}.txt`;
}

/** One-line summary for the terminal footer or a list. */
export function summarizeRecord(record: SessionRecord): string {
  const parts = [
    record.targetLabel || record.target,
    OUTCOME_LABEL[record.outcome],
    formatDuration(record.durationMs),
    `↓${formatBytes(record.traffic.bytesIn)}`,
    `↑${formatBytes(record.traffic.bytesOut)}`,
  ];
  return parts.join(" · ");
}

export { PHASE_LABEL };
