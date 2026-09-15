"use strict";

/** A native fallback when reload/close prevents the renderer's richer audit.
 * Unknown protocol facts stay empty; the original event log remains linked.
 */
function lifecycleRecord(entry, info = {}, existing = null, now = Date.now()) {
  const pty = entry.pty;
  if (!entry.logPath || !pty?.startedAt || !entry.argv?.length) return null;
  const durationMs = Math.max(0, info.elapsedMs ?? now - pty.startedAt);
  const exitCode = info.exitCode ?? null;
  const failed = !entry.canceled && exitCode !== null && exitCode !== 0;
  const outcome = failed ? "failed" : "closed";
  return {
    id: entry.id, target: entry.target, targetLabel: entry.displayTarget || entry.target,
    startedAt: new Date(pty.startedAt).toISOString(), durationMs, outcome,
    failure: failed ? `SSH 进程退出，状态码 ${exitCode}` : null, exitCode,
    phases: [...(existing?.phases || []).filter(phase => !["closed", "failed"].includes(phase.phase)),
      { phase: outcome, label: failed ? "连接结束（异常）" : "连接已结束", atMs: durationMs, durationMs: 0 }],
    facts: existing?.facts || [],
    traffic: { bytesIn: info.bytesIn ?? pty.bytesIn, bytesOut: info.bytesOut ?? pty.bytesOut,
      logLines: info.logLines ?? pty.logLines, events: existing?.traffic?.events || 0,
      peakBytesPerSecondIn: existing?.traffic?.peakBytesPerSecondIn || 0,
      peakBytesPerSecondOut: existing?.traffic?.peakBytesPerSecondOut || 0 },
    unknownLines: existing?.unknownLines || [], argv: entry.argv, logPath: entry.logPath,
  };
}

module.exports = { lifecycleRecord };
