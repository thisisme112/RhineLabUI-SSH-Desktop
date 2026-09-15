import assert from "node:assert/strict";
import {
  parseSshLine,
  parsePtyNotice,
  TERMINAL_EVENTS,
} from "../src/ssh/events.ts";
import { SshSessionTracker, PHASE_DEADLINE } from "../src/ssh/session.ts";

/**
 * The captured fixture is verbatim output from
 * `ssh -E <log> -v -o BatchMode=yes git@github.com` on this machine
 * (OpenSSH_for_Windows_9.5p2), with the local account name replaced.
 * The 198.18.1.17 address is this machine's TUN proxy, which is why the
 * remote closes during identification — a real kex.reset, not a mock.
 */
const CAPTURED_RESET = [
  "OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2",
  "debug1: Reading configuration data C:\\\\Users\\\\operator/.ssh/config",
  "debug1: Connecting to github.com [198.18.1.17] port 22.",
  "debug1: fd 4 clearing O_NONBLOCK",
  "debug1: Connection established.",
  "debug1: identity file C:\\\\Users\\\\operator/.ssh/id_rsa type -1",
  "debug1: identity file C:\\\\Users\\\\operator/.ssh/id_ecdsa type -1",
  "debug1: identity file C:\\\\Users\\\\operator/.ssh/id_ed25519 type -1",
  "debug1: Local version string SSH-2.0-OpenSSH_for_Windows_9.5",
  "kex_exchange_identification: Connection closed by remote host",
  "Connection closed by 198.18.1.17 port 22",
].join("\n");

/** Standard OpenSSH debug1 formats for the full success path. */
const SUCCESS = [
  "OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2",
  "debug1: Reading configuration data C:\\\\Users\\\\operator/.ssh/config",
  "debug1: Connecting to lab-node-07 [10.20.30.41] port 22.",
  "debug1: Connection established.",
  "debug1: identity file C:\\\\Users\\\\operator/.ssh/id_ed25519 type 3",
  "debug1: Local version string SSH-2.0-OpenSSH_for_Windows_9.5",
  "debug1: Remote protocol version 2.0, remote software version OpenSSH_9.6p1 Ubuntu-3ubuntu13.5",
  "debug1: kex: algorithm: sntrup761x25519-sha512@openssh.com",
  "debug1: kex: host key algorithm: ssh-ed25519",
  "debug1: kex: server->client cipher: chacha20-poly1305@openssh.com MAC: <implicit> compression: none",
  "debug1: kex: client->server cipher: chacha20-poly1305@openssh.com MAC: <implicit> compression: none",
  "debug1: Server host key: ssh-ed25519 SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s",
  "debug1: Host 'lab-node-07' is known and matches the ED25519 host key.",
  "debug1: Found key in C:\\\\Users\\\\operator/.ssh/known_hosts:12",
  "debug1: Authentications that can continue: publickey,password",
  "debug1: Offering public key: C:\\\\Users\\\\operator/.ssh/id_ed25519 ED25519 SHA256:AAAAC3NzaC1lZDI1NTE5AAAAIExample",
  "debug1: Server accepts key: C:\\\\Users\\\\operator/.ssh/id_ed25519 ED25519 SHA256:AAAAC3NzaC1lZDI1NTE5AAAAIExample",
  "debug1: Authentication succeeded (publickey).",
  "debug1: Entering interactive session.",
  "debug1: pledge: network",
].join("\n");

const FAILURES = {
  dns: "ssh: Could not resolve hostname nope.invalid: Name or service not known",
  timeout: "ssh: connect to host 10.20.30.41 port 22: Connection timed out",
  refused: "ssh: connect to host 10.20.30.41 port 22: Connection refused",
  denied: "Permission denied (publickey,password).",
  mismatch: [
    "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
    "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @",
    "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
  ].join("\n"),
};

// ── 1. Parser: line → event ────────────────────────────────────────────────
const PARSE_CASES = [
  [
    "debug1: Reading configuration data /home/u/.ssh/config",
    "config.loaded",
    { path: "/home/u/.ssh/config" },
  ],
  [
    "debug1: Connecting to host.example [1.2.3.4] port 2222.",
    "tcp.connecting",
    { host: "host.example", address: "1.2.3.4", port: "2222" },
  ],
  [
    "debug1: Connecting to 1.2.3.4 port 22.",
    "tcp.connecting",
    { host: "1.2.3.4", port: "22" },
  ],
  ["debug1: Connection established.", "tcp.established", {}],
  [
    "debug2: identity file /home/u/.ssh/id_rsa type -1",
    "identity.scanned",
    { path: "/home/u/.ssh/id_rsa", present: "false" },
  ],
  [
    "debug1: identity file /home/u/.ssh/id_ed25519 type 3",
    "identity.scanned",
    { present: "true" },
  ],
  [
    "debug1: Local version string SSH-2.0-OpenSSH_9.5",
    "banner.local",
    { banner: "SSH-2.0-OpenSSH_9.5" },
  ],
  [
    "debug1: Remote protocol version 2.0, remote software version OpenSSH_9.6p1",
    "banner.remote",
    { protocol: "2.0", software: "OpenSSH_9.6p1" },
  ],
  [
    "debug1: kex: algorithm: curve25519-sha256",
    "kex.algorithms",
    { kex: "curve25519-sha256" },
  ],
  [
    "debug1: kex: host key algorithm: rsa-sha2-512",
    "kex.algorithms",
    { hostKeyAlgorithm: "rsa-sha2-512" },
  ],
  [
    "debug1: kex: server->client cipher: aes256-gcm@openssh.com MAC: <implicit> compression: none",
    "kex.ciphers",
    {
      direction: "server->client",
      cipher: "aes256-gcm@openssh.com",
      mac: "<implicit>",
      compression: "none",
    },
  ],
  [
    "debug1: Server host key: ssh-ed25519 SHA256:abc123",
    "hostkey.received",
    { type: "ssh-ed25519", fingerprint: "SHA256:abc123" },
  ],
  [
    "debug1: Host 'h' is known and matches the ED25519 host key.",
    "hostkey.verified",
    { host: "h", type: "ED25519" },
  ],
  [
    "debug1: Found key in /home/u/.ssh/known_hosts:12",
    "hostkey.verified",
    { knownHosts: "/home/u/.ssh/known_hosts", line: "12" },
  ],
  [
    "The authenticity of host 'h (1.2.3.4)' can't be established.",
    "hostkey.unknown",
    { host: "h (1.2.3.4)" },
  ],
  [
    "ED25519 key fingerprint is SHA256:abc123.",
    "hostkey.unknown",
    { type: "ED25519", fingerprint: "SHA256:abc123" },
  ],
  ["debug1: Host key verification failed.", "hostkey.mismatch", {}],
  [
    "debug1: Authentications that can continue: publickey,password,keyboard-interactive",
    "auth.methods",
    { methods: "publickey,password,keyboard-interactive" },
  ],
  [
    "debug1: Offering public key: /home/u/.ssh/id_ed25519 ED25519 SHA256:xyz",
    "auth.offering",
    { target: "/home/u/.ssh/id_ed25519 ED25519", fingerprint: "SHA256:xyz" },
  ],
  [
    "debug1: Server accepts key: /home/u/.ssh/id_ed25519 ED25519 SHA256:xyz",
    "auth.accepted",
    { fingerprint: "SHA256:xyz" },
  ],
  [
    "debug1: Authentication succeeded (publickey).",
    "auth.succeeded",
    { method: "publickey" },
  ],
  ["debug1: Entering interactive session.", "session.entering", {}],
  ["debug1: pledge: network", "session.authenticated", { pledge: "network" }],
  [
    FAILURES.dns,
    "dns.failed",
    { host: "nope.invalid", reason: "Name or service not known" },
  ],
  [
    FAILURES.timeout,
    "tcp.failed",
    { host: "10.20.30.41", port: "22", reason: "Connection timed out" },
  ],
  [FAILURES.refused, "tcp.failed", { reason: "Connection refused" }],
  [
    "kex_exchange_identification: Connection closed by remote host",
    "kex.reset",
    { reason: "Connection closed by remote host" },
  ],
  [FAILURES.denied, "auth.denied", { methods: "publickey,password" }],
  [
    "Connection closed by 1.2.3.4 port 22",
    "session.closed",
    { host: "1.2.3.4", port: "22" },
  ],
  ["Connection to h closed.", "session.closed", { host: "h" }],
];

for (const [line, name, detail] of PARSE_CASES) {
  const parsed = parseSshLine(line);
  assert.ok(parsed.matched, `should match: ${line}`);
  assert.equal(parsed.event.name, name, `event name for: ${line}`);
  const expected = detail ?? {};
  for (const [key, value] of Object.entries(expected))
    assert.equal(
      parsed.event.detail[key],
      value,
      `${name}.${key} for: ${line}`,
    );
  assert.equal(
    parsed.event.raw,
    line,
    "raw line must be preserved verbatim (R3)",
  );
}

// Unknown lines are a legitimate result, never a crash and never dropped (R4).
for (const line of [
  "OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2",
  "debug1: fd 4 clearing O_NONBLOCK",
  "debug1: Sending environment.",
  "",
  "   ",
]) {
  const parsed = parseSshLine(line);
  assert.equal(parsed.matched, false, `should not match: ${line}`);
  assert.equal(parsed.raw, line, "unmatched line must be kept verbatim");
}

// ── 2. Success path reaches `interactive` ──────────────────────────────────
const tracker = new SshSessionTracker();
const successEvents = tracker.feed(SUCCESS, 1000);
let status = tracker.status(1000 + successEvents.length);

assert.equal(status.phase, "interactive");
assert.equal(status.failure, null);
assert.equal(status.stalled, false);
assert.equal(
  status.unknownLines.length,
  1,
  "only the version banner line is unknown",
);

// Every phase the evidence moved through is recorded, including the two that
// only exist to hold a user decision (`hostkey`) or a session setup step.
const phases = status.timeline.map((entry) => entry.phase);
assert.deepEqual(phases, [
  "resolving",
  "connecting",
  "handshake",
  "hostkey",
  "authenticating",
  "opening",
  "interactive",
]);

// Every phase boundary is recorded with a real timestamp and a duration (R5).
for (const entry of status.timeline) {
  assert.ok(
    entry.at >= 1000,
    `timeline entry ${entry.phase} needs an arrival time`,
  );
  assert.ok(
    entry.duration >= 0,
    `timeline entry ${entry.phase} needs a non-negative duration`,
  );
}

// Facts carry the raw line that produced them (R3).
assert.equal(status.facts.host.value, "lab-node-07");
assert.equal(status.facts.address.value, "10.20.30.41");
assert.equal(
  status.facts.remoteSoftware.value,
  "OpenSSH_9.6p1 Ubuntu-3ubuntu13.5",
);
assert.equal(status.facts.kex.value, "sntrup761x25519-sha512@openssh.com");
assert.equal(status.facts.hostKeyAlgorithm.value, "ssh-ed25519");
assert.equal(status.facts.cipher.value, "chacha20-poly1305@openssh.com");
assert.equal(
  status.facts.hostKeyFingerprint.value,
  "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s",
);
assert.equal(status.facts.knownHostsLine.value, "12");
assert.equal(status.facts.authMethods.value, "publickey password");
assert.equal(status.facts.authMethod.value, "publickey");
assert.match(
  status.facts.hostKeyFingerprint.event.raw,
  /^debug1: Server host key:/,
);
assert.equal(status.eventCount, successEvents.length);

// ── 3. Monotonic: late or repeated events never rewind a phase ─────────────
const strayPort = parseSshLine("debug1: Connection established.");
tracker.push(strayPort.event, 9999);
assert.equal(
  tracker.status(9999).phase,
  "interactive",
  "a late success event must not rewind",
);

// ── 4. Terminal states are sticky ──────────────────────────────────────────
const reset = new SshSessionTracker();
reset.feed(CAPTURED_RESET, 0);
const resetStatus = reset.status(0);
assert.equal(resetStatus.phase, "failed", "kex reset ends the connection");
assert.equal(
  resetStatus.last.name,
  "session.closed",
  "the last real line is kept as-is",
);
assert.match(resetStatus.failure, /密钥交换阶段被对端中断/);
assert.match(resetStatus.failure, /Connection closed by remote host/);
assert.deepEqual(
  resetStatus.timeline.map((entry) => entry.phase),
  ["resolving", "connecting", "handshake", "failed"],
);
assert.ok(
  resetStatus.unknownLines.includes("debug1: fd 4 clearing O_NONBLOCK"),
);

// A trailing "Connection closed" must not overwrite the more useful failure.
const trailing = new SshSessionTracker();
trailing.feed(CAPTURED_RESET, 0);
trailing.push(
  parseSshLine("Connection closed by 198.18.1.17 port 22").event,
  50,
);
assert.equal(trailing.status(50).phase, "failed", "failed stays failed");
assert.match(trailing.status(50).failure, /密钥交换阶段/);

// ── 5. Every failure fixture lands in `failed` with a readable reason ──────
for (const [kind, text] of Object.entries(FAILURES)) {
  const machine = new SshSessionTracker();
  machine.feed(text, 0);
  const result = machine.status(0);
  assert.equal(result.phase, "failed", `${kind} should fail`);
  assert.ok(
    result.failure && result.failure.length > 4,
    `${kind} needs a reason`,
  );
  assert.equal(
    result.stalled,
    false,
    `${kind} is terminal, so it never stalls`,
  );
}

// A refused connection keeps the port it tried, for the diagnostic page.
const refused = new SshSessionTracker();
refused.feed(FAILURES.refused, 0);
assert.equal(
  refused.status(0).facts.port,
  undefined,
  "no TCP fact was ever emitted",
);

// ── 6. R1/R4: time alone never advances a phase, only flags a stall ────────
const idle = new SshSessionTracker();
assert.equal(idle.status(10 ** 9).phase, "idle", "no events, no movement");
idle.tick(10 ** 9);
assert.equal(
  idle.status(10 ** 9).phase,
  "idle",
  "tick() must not advance anything",
);

const stalled = new SshSessionTracker();
stalled.push(
  parseSshLine("debug1: Connecting to slow.example [10.0.0.9] port 22.").event,
  1000,
);
const deadline = PHASE_DEADLINE.connecting;
assert.equal(stalled.status(1000 + deadline - 1).stalled, false);
const late = stalled.status(1000 + deadline);
assert.equal(late.stalled, true, "silence past the deadline is reported");
assert.equal(late.phase, "connecting", "a stall is not progress");
assert.equal(late.label, "建立 TCP 连接");

// Phases that legitimately wait for a human never report a stall.
const waiting = new SshSessionTracker();
waiting.push(
  parseSshLine("debug1: Server host key: ssh-ed25519 SHA256:abc").event,
  0,
);
assert.equal(
  waiting.status(10 ** 9).stalled,
  false,
  "fingerprint confirmation waits for the user",
);

// ── 7. Reset clears everything ─────────────────────────────────────────────
tracker.reset(0);
const cleared = tracker.status(0);
assert.equal(cleared.phase, "idle");
assert.equal(cleared.eventCount, 0);
assert.deepEqual(cleared.facts, {});
assert.deepEqual(cleared.unknownLines, []);
assert.deepEqual(cleared.timeline, []);

assert.ok(
  TERMINAL_EVENTS.has("auth.denied") && !TERMINAL_EVENTS.has("auth.accepted"),
);

// ── 8. Notices that only ever appear on the pty ────────────────────────────
// Answering "no" to an unknown host key prints nothing to the debug log, so the
// terminal stream is the only evidence for that ending.
assert.equal(
  parsePtyNotice("Host key verification failed.").name,
  "hostkey.mismatch",
);
assert.equal(
  parsePtyNotice("Permission denied (publickey,password).").name,
  "auth.denied",
);
assert.equal(
  parsePtyNotice("ssh: connect to host 10.0.0.1 port 22: Connection timed out")
    .name,
  "tcp.failed",
);
assert.equal(
  parsePtyNotice(
    "ssh: Could not resolve hostname nope: Name or service not known",
  ).name,
  "dns.failed",
);
assert.equal(
  parsePtyNotice(
    "kex_exchange_identification: Connection closed by remote host",
  ).name,
  "kex.reset",
);
assert.equal(
  parsePtyNotice("Host key verification failed.\r").name,
  "hostkey.mismatch",
  "CRLF is handled",
);

// The pty also carries everything the shell prints. None of it may be mistaken
// for a failure — this is the property that keeps the terminal usable.
for (const line of [
  "total 12",
  "drwxr-xr-x  4 operator operator 4096 Sep 11 12:00 .",
  "operator@host:~$ ls -la",
  "Permission denied", // no trailing parenthesised method list
  "host key verification failed", // lower case, not the exact notice
  "Connection to host closed.", // the debug/log form, not the pty notice
  "error: something failed in my program",
  "",
  "   ",
]) {
  assert.equal(
    parsePtyNotice(line),
    null,
    `must not be read as a notice: ${JSON.stringify(line)}`,
  );
}

// ── 9. An exit status is evidence even with a silent log ───────────────────
const silent = new SshSessionTracker();
silent.push(
  parseSshLine("debug1: Connecting to newhost [10.20.30.41] port 22.").event,
  1000,
);
assert.equal(silent.status(1000).phase, "connecting");
assert.equal(silent.ended(255, 2000), true, "a non-zero exit ends the session");
const afterExit = silent.status(2000);
assert.equal(afterExit.phase, "failed");
assert.match(afterExit.failure, /255/, "the reason names the real exit code");
assert.deepEqual(
  afterExit.timeline.map((entry) => entry.phase),
  ["connecting", "failed"],
);

const cleanExit = new SshSessionTracker();
cleanExit.push(parseSshLine("debug1: Entering interactive session.").event, 0);
assert.equal(cleanExit.ended(0, 100), true);
assert.equal(cleanExit.status(100).phase, "closed");

// A real terminal event outranks a later exit status.
const explained = new SshSessionTracker();
explained.feed(
  "debug1: Connecting to h [10.0.0.1] port 22.\nkex_exchange_identification: Connection closed by remote host",
  0,
);
assert.match(explained.status(0).failure, /密钥交换阶段/);
assert.equal(
  explained.ended(255, 10),
  false,
  "an explained failure is not overwritten",
);
assert.match(
  explained.status(10).failure,
  /密钥交换阶段/,
  "and keeps its specific reason",
);

console.log("SSH event parsing and connection state machine checks passed.");
