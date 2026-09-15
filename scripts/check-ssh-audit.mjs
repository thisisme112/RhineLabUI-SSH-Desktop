import assert from "node:assert/strict";
import {
  buildSessionRecord,
  formatSessionRecord,
  recordFileName,
  summarizeRecord,
} from "../src/ssh/audit.ts";
import { SshSessionTracker } from "../src/ssh/session.ts";
import { parseSshLine, parsePtyNotice } from "../src/ssh/events.ts";

/**
 * The record is what "every step is usable" means in the output direction: the
 * session has to leave behind something a person can read and check later.
 * These checks are mostly about traceability — every number tied to a real
 * event, every fact tied to the line that proved it.
 */

const LINES = [
  "debug1: Reading configuration data /home/operator/.ssh/config",
  "debug1: Connecting to lab-node-07 [10.20.30.41] port 22.",
  "debug1: Connection established.",
  "debug1: Local version string SSH-2.0-OpenSSH_9.5",
  "debug1: Remote protocol version 2.0, remote software version OpenSSH_9.6p1",
  "debug1: kex: algorithm: sntrup761x25519-sha512@openssh.com",
  "debug1: kex: host key algorithm: ssh-ed25519",
  "debug1: kex: server->client cipher: chacha20-poly1305@openssh.com MAC: <implicit> compression: none",
  "debug1: Server host key: ssh-ed25519 SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s",
  "debug1: Host 'lab-node-07' is known and matches the ED25519 host key.",
  "debug1: Found key in /home/operator/.ssh/known_hosts:12",
  "debug1: Authentications that can continue: publickey,password",
  "debug1: Authentication succeeded (publickey).",
  "debug1: Entering interactive session.",
  "debug1: pledge: network",
  "debug1: Sending environment.",
];

/** Build a finished-session status the way the client would. */
function finishedSession({ failed = false } = {}) {
  const tracker = new SshSessionTracker();
  // Feed at 120ms intervals on a clock that started long before the session,
  // which is exactly what the app does: the record must report relative times.
  let clock = 48_000;
  for (const line of LINES) {
    const parsed = parseSshLine(line);
    if (parsed.matched) tracker.push(parsed.event, clock);
    clock += 120;
  }
  if (failed) {
    tracker.push(
      parsePtyNotice("Permission denied (publickey,password)."),
      clock,
    );
    tracker.ended(255, clock + 40);
  } else {
    tracker.ended(0, clock + 40);
  }
  return tracker.status(clock + 100);
}

const record = buildSessionRecord({
  id: "2026-09-11T00-00-00-000Z-lab-node-07",
  target: "operator@lab-node-07",
  startedAt: "2026-09-11T00:00:00.000Z",
  durationMs: 4321,
  status: finishedSession(),
  traffic: { bytesIn: 4096, bytesOut: 512, logLines: 16, elapsedMs: 4321 },
  peakBytesPerSecondIn: 2048.7,
  peakBytesPerSecondOut: 64.2,
  exitCode: 0,
  argv: [
    "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
    "-v",
    "-E",
    "C:\\logs\\a.log",
    "operator@lab-node-07",
  ],
  logPath: "C:\\logs\\a.log",
});

// ── 1. Relative timings, real durations ────────────────────────────────────
assert.equal(
  record.phases[0].atMs,
  0,
  "the first phase is the origin, not a wall clock reading",
);
assert.ok(
  record.phases.every((entry) => entry.atMs < 60_000),
  "phase times must be relative to the session, not to the app's uptime",
);
for (const entry of record.phases) {
  assert.ok(
    entry.durationMs >= 0,
    `${entry.phase} needs a non-negative duration`,
  );
  assert.ok(entry.label.length > 0, `${entry.phase} needs a human label`);
}
assert.deepEqual(
  record.phases.map((entry) => entry.phase),
  [
    "resolving",
    "connecting",
    "handshake",
    "hostkey",
    "authenticating",
    "opening",
    "interactive",
    "closed",
  ],
);

// ── 2. Every fact carries the line that proved it ──────────────────────────
assert.ok(
  record.facts.length >= 10,
  "a real handshake produces plenty of facts",
);
for (const fact of record.facts) {
  assert.ok(fact.source.length > 0, `${fact.key} must cite its source line`);
  assert.ok(
    /^(debug\d+:|[A-Za-z_]+:)/.test(fact.source),
    `${fact.key} cites an implausible line`,
  );
  assert.equal(
    fact.value,
    fact.value.trim(),
    `${fact.key} should not carry stray whitespace`,
  );
}
const byKey = Object.fromEntries(record.facts.map((fact) => [fact.key, fact]));
assert.equal(
  byKey.hostKeyFingerprint.value,
  "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s",
);
assert.match(byKey.hostKeyFingerprint.source, /Server host key/);
assert.equal(byKey.kex.value, "sntrup761x25519-sha512@openssh.com");
assert.equal(byKey.cipher.value, "chacha20-poly1305@openssh.com");
assert.equal(byKey.authMethod.value, "publickey");
// Facts read in handshake order, not in hash order.
assert.ok(
  record.facts.findIndex((fact) => fact.key === "host") <
    record.facts.findIndex((fact) => fact.key === "hostKeyFingerprint"),
);

// ── 3. A clean ending is an outcome, not a failure ─────────────────────────
assert.equal(record.outcome, "closed");
assert.equal(
  record.failure,
  null,
  "a session that simply ended has no failure to report",
);
assert.equal(record.exitCode, 0);

const failed = buildSessionRecord({
  id: "x",
  target: "operator@lab-node-07",
  startedAt: "2026-09-11T00:00:00.000Z",
  durationMs: 900,
  status: finishedSession({ failed: true }),
  traffic: { bytesIn: 100, bytesOut: 40, logLines: 16, elapsedMs: 900 },
  peakBytesPerSecondIn: 0,
  peakBytesPerSecondOut: 0,
  exitCode: 255,
  argv: ["ssh"],
  logPath: "C:\\logs\\b.log",
});
assert.equal(failed.outcome, "failed");
assert.match(failed.failure, /认证被拒绝/);
assert.equal(failed.exitCode, 255);

// ── 4. Unknown lines survive into the record ───────────────────────────────
const noisy = new SshSessionTracker();
noisy.feed(
  `${LINES[0]}\ndebug1: Sending environment.\ndebug1: something new in a future release`,
  0,
);
const noisyRecord = buildSessionRecord({
  id: "n",
  target: "h",
  startedAt: "2026-09-11T00:00:00.000Z",
  durationMs: 10,
  status: noisy.status(10),
  traffic: { bytesIn: 0, bytesOut: 0, logLines: 3, elapsedMs: 10 },
  peakBytesPerSecondIn: 0,
  peakBytesPerSecondOut: 0,
  exitCode: null,
  argv: ["ssh"],
  logPath: "l",
});
assert.deepEqual(noisyRecord.unknownLines, [
  "debug1: Sending environment.",
  "debug1: something new in a future release",
]);

// ── 5. The text export is self-contained ───────────────────────────────────
const text = formatSessionRecord(record);
for (const needle of [
  "SSH 会话记录",
  "operator@lab-node-07",
  "阶段耗时（全部来自真实事件）",
  "协商结果与已验证事实",
  "密钥交换算法",
  "sntrup761x25519-sha512@openssh.com",
  "主机密钥指纹",
  "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s",
  "来源  debug1: Server host key",
  "流量",
  "下行合计",
  "执行的命令",
  "每条事实都附带产生它的原始输出行",
])
  assert.ok(text.includes(needle), `export must contain ${needle}`);
assert.ok(
  !text.includes("失败原因"),
  "a clean session must not print a failure line",
);
assert.ok(text.includes("结果        会话正常结束"));
assert.ok(
  !text.includes("NaN") && !text.includes("undefined"),
  "no placeholder values may leak into the export",
);

const failedText = formatSessionRecord(failed);
assert.ok(failedText.includes("失败原因"));
assert.ok(failedText.includes("认证被拒绝"));
assert.ok(failedText.includes("退出代码    255"));

assert.ok(
  recordFileName(record).startsWith("RHINE-SSH-2026-09-11T00-00-00-000Z-"),
);
assert.ok(recordFileName(record).endsWith(".txt"));
assert.match(
  summarizeRecord(record),
  /operator@lab-node-07 · 会话正常结束 · 4\.32s/,
);

// ── 6. An empty record is still honest rather than broken ──────────────────
const empty = buildSessionRecord({
  id: "e",
  target: "h",
  startedAt: "2026-09-11T00:00:00.000Z",
  durationMs: 0,
  status: new SshSessionTracker().status(0),
  traffic: { bytesIn: 0, bytesOut: 0, logLines: 0, elapsedMs: 0 },
  peakBytesPerSecondIn: 0,
  peakBytesPerSecondOut: 0,
  exitCode: null,
  argv: [],
  logPath: "",
});
const emptyText = formatSessionRecord(empty);
assert.ok(emptyText.includes("（没有记录到阶段）"));
assert.ok(emptyText.includes("（没有记录到事实）"));
assert.ok(!emptyText.includes("undefined"));

console.log("SSH session record checks passed.");
