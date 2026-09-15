import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SshSessionTracker } from "../src/ssh/session.ts";

const require = createRequire(import.meta.url);
const { PtySession, detectPrompt } = require("../electron/session.cjs");
const {
  isEventLine,
  couldBecomeEvent,
  stripAnsi,
  PtyEventSplitter,
} = require("../electron/pty-events.cjs");
const {
  buildSshArgs,
  validateLaunch,
  resolveSshPath,
} = require("../electron/ssh-args.cjs");

/**
 * End-to-end check of the session layer: a real ConPTY running a stand-in for
 * ssh, a real pty stream split into diagnostics and session bytes, and the real
 * state machine consuming the result. Only the network is faked.
 *
 * The load-bearing assertion is incrementality: if the events only showed up
 * after the process exited, every connection animation would be a lie, because
 * there would be nothing real driving it while the connection was happening.
 * That is exactly what `ssh -E` did on Windows — see pty-events.cjs.
 */
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeSsh = path.join(root, "scripts", "fixtures", "fake-ssh.mjs");
const workdir = mkdtempSync(path.join(tmpdir(), "rhine-ssh-check-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── buildSshArgs: -v first, target last, and no -E ─────────────────────────
assert.deepEqual(buildSshArgs({ target: "user@host" }), ["-v", "user@host"]);
assert.deepEqual(
  buildSshArgs({
    target: "host",
    port: 2222,
    identityFile: "/home/u/.ssh/id_ed25519",
    extraArgs: ["-L", "8080:localhost:80"],
  }),
  [
    "-v",
    "-p",
    "2222",
    "-i",
    "/home/u/.ssh/id_ed25519",
    "-L",
    "8080:localhost:80",
    "host",
  ],
);
// `-E` would move the diagnostics somewhere only ssh can read.
assert.ok(
  !buildSshArgs({ target: "h", logPath: "x.log" }).includes("-E"),
  "the event log is written by this process, not by ssh",
);

// ── validateLaunch: the spawn boundary ─────────────────────────────────────
assert.equal(validateLaunch({ target: "user@host" }).ok, true);
assert.equal(
  validateLaunch({ target: "  host  " }).launch.target,
  "host",
  "target is trimmed",
);
assert.equal(validateLaunch({ target: "" }).ok, false);
assert.equal(validateLaunch(null).ok, false);
assert.equal(
  validateLaunch({ target: "-oProxyCommand=calc" }).ok,
  false,
  "a target may not be a flag",
);
assert.equal(
  validateLaunch({ target: "a b" }).ok,
  false,
  "no whitespace in the target",
);
assert.equal(validateLaunch({ target: "h", port: 0 }).ok, false);
assert.equal(validateLaunch({ target: "h", port: 70000 }).ok, false);
assert.equal(
  validateLaunch({ target: "h", port: "2222" }).launch.port,
  2222,
  "numeric strings are accepted",
);
assert.equal(
  validateLaunch({ target: "h", extraArgs: "-L" }).ok,
  false,
  "extraArgs must be an array",
);
assert.equal(
  validateLaunch({ target: "h", extraArgs: ["-E", "/tmp/evil"] }).ok,
  false,
  "-E is reserved for the event log",
);
assert.equal(validateLaunch({ target: "h", extraArgs: ["--evil"] }).ok, false);
assert.deepEqual(
  validateLaunch({ target: "h", extraArgs: ["-L", "1:2:3"] }).launch.extraArgs,
  ["-L", "1:2:3"],
);

// Main owns the executable; the renderer can never name one.
assert.ok(typeof resolveSshPath() === "string" && resolveSshPath().length > 0);
assert.ok(
  !/node_modules/.test(resolveSshPath()),
  "the default ssh is the system one",
);

// ── prompt matcher ─────────────────────────────────────────────────────────
assert.deepEqual(detectPrompt("jo@lab's password: "), {
  kind: "password",
  prompt: "jo@lab's password:",
  host: "jo@lab",
});
assert.equal(
  detectPrompt("Enter passphrase for key '/k/id_ed25519': ").kind,
  "passphrase",
);
assert.equal(detectPrompt("Verification code: ").kind, "verification-code");
assert.equal(
  detectPrompt("user@host:~$ "),
  null,
  "a shell prompt is not an authentication prompt",
);
assert.equal(detectPrompt(""), null);

// ── the stream split, unit-tested apart from any pty ───────────────────────
assert.equal(
  isEventLine("debug1: Server host key: ssh-ed25519 SHA256:abc"),
  true,
);
assert.equal(isEventLine("OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2"), true);
assert.equal(isEventLine("Permission denied (publickey,password)."), true);
assert.equal(
  isEventLine("operator@lab-node-07:~$"),
  false,
  "a shell prompt is session text",
);
assert.equal(
  isEventLine("Permission denied (publickey,password).", false),
  false,
  "once a shell is live, remote text is never read as a notice",
);
assert.equal(
  isEventLine("debug1: pledge: network", false),
  true,
  "debug lines stay diagnostics for the whole session",
);
// A held fragment must not stall ordinary output: prompts and echoes are
// released at once, only a possible diagnostic is allowed to wait.
assert.equal(couldBecomeEvent("operator@lab's password: "), false);
assert.equal(couldBecomeEvent("d"), true, "'d' could still become 'debug…'");
assert.equal(couldBecomeEvent("debug1: Server host"), true);
assert.equal(
  couldBecomeEvent("\x1b[?25hdeb"),
  true,
  "ANSI prefixes cannot hide split diagnostics",
);
{
  const events = [];
  const text = [];
  const split = new PtyEventSplitter({
    onEvent: (line) => events.push(line),
    onText: (chunk) => text.push(chunk),
  });
  // One write carrying a debug line, a prompt with no newline, and a split line.
  split.push("debug1: Authentications that can continue: publickey\r\n");
  split.push("operator@lab's password: ");
  split.push("debug1: Server host ");
  split.push("key: ssh-ed25519 SHA256:abc\r\n");
  split.drain();
  assert.deepEqual(events, [
    "debug1: Authentications that can continue: publickey",
    "debug1: Server host key: ssh-ed25519 SHA256:abc",
  ]);
  assert.equal(
    text.join(""),
    "operator@lab's password: ",
    "the prompt reached the terminal immediately, unterminated",
  );
  assert.equal(split.pending, "");
}

{
  const events = [];
  const split = new PtyEventSplitter({ onEvent: (line) => events.push(line) });
  const line = "debug1: Authentications that can continue: publickey,password";
  split.push(line + "\r\n");
  // The resize control itself may span reads, as may the redrawn diagnostic.
  split.push("\x1b[?25l\x1b[8;40;");
  split.push("132t\x1b[Hdeb");
  split.push(line.slice(3) + "\x1b[K\r\n\x1b[2;1H\x1b[?25h");
  assert.deepEqual(
    events,
    [line],
    "resize redraw is not new authentication evidence",
  );
  split.push(line + "\r\n");
  assert.deepEqual(
    events,
    [line, line],
    "a later identical auth retry remains a real event",
  );
}

// A larger workspace also makes ConPTY pad rows with spaces instead of CSI K.
// Initial diagnostics can themselves be padded; compare both directions while
// preserving subsequent real repeats and the exact emitted diagnostic text.
{
  const line =
    "debug1: kex: server->client cipher: chacha20-poly1305@openssh.com MAC: <implicit> compression: none";
  for (const [initial, redraw] of [
    [line, line + "       "],
    [line + "   ", line],
  ]) {
    const stream = `\x1b[?25l\x1b[8;40;150t\x1b[H${redraw}\r\n\x1b[?25h`;
    for (let cut = 0; cut <= stream.length; cut++) {
      const events = [];
      const split = new PtyEventSplitter({
        onEvent: (value) => events.push(value),
      });
      split.push(initial + "\r\n");
      split.push(stream.slice(0, cut));
      split.push(stream.slice(cut));
      split.push(line + "\r\n");
      assert.deepEqual(
        events,
        [initial, line],
        `padded redraw split ${cut} is not another event`,
      );
    }
  }
}

// Captured from the real desktop footer resize: ConPTY may repaint without
// CSI 8, using only cursor hide + home and row erases. Test every chunk split.
{
  const old = "debug1: kex: host key algorithm: ssh-ed25519";
  const fresh = "debug1: pledge: network";
  const repaint = `\x1b[?25l\x1b[H${old}\x1b[K\r\n${fresh}\r\noperator@lab:~$\x1b[K\x1b[?25h`;
  for (let cut = 0; cut <= repaint.length; cut++) {
    const events = [];
    const split = new PtyEventSplitter({
      onEvent: (line) => events.push(line),
    });
    split.push(old + "\r\n");
    split.push(repaint.slice(0, cut));
    split.push(repaint.slice(cut));
    assert.deepEqual(
      events,
      [old, fresh],
      `height redraw split ${cut} retains only new diagnostics`,
    );
    split.push(old + "\r\n");
    assert.deepEqual(
      events,
      [old, fresh, old],
      "repeated diagnostics after redraw remain observable",
    );
  }
  const events = [];
  const split = new PtyEventSplitter({ onEvent: (line) => events.push(line) });
  split.push(old + "\r\n");
  split.push(`\x1b[?25l\x1b[Hscreen\r\n\x1b[2;1H\x1b[?25h${old}\r\n`);
  assert.deepEqual(
    events,
    [old, old],
    "a cursor restore before a diagnostic ends deduplication immediately",
  );
}

/** The stand-in picks its scenario from the target name (see fake-ssh.mjs). */
const TARGETS = {
  success: "operator@lab-node-07",
  rejected: "operator@reject-host",
};

/** Run one fake session to completion and return everything observed. */
async function runFakeSession({
  mode = "success",
  gap = 40,
  hold = 700,
  stopAfter = 0,
  resizeAtInteractive = false,
} = {}) {
  const logPath = path.join(workdir, `${mode}-${Date.now()}.log`);
  const target = TARGETS[mode] ?? TARGETS.success;
  const args = buildSshArgs({ target, logPath });
  const tracker = new SshSessionTracker();
  const observed = [];
  const tty = [];
  const prompts = [];
  const started = Date.now();
  let firstLogAt = -1;
  let exited = null;

  const session = new PtySession({
    onData: (chunk) => tty.push(chunk),
    onPrompt: (prompt) => prompts.push(prompt),
    onLog: (line) => {
      if (firstLogAt < 0) firstLogAt = Date.now();
      const parsed = parse(line);
      if (parsed) tracker.push(parsed, Date.now());
    },
    onExit: (info) => {
      exited = info;
    },
  });

  session.start({
    file: process.execPath,
    args: [fakeSsh, ...args],
    logPath,
    cols: 100,
    rows: 30,
    env: {
      ...process.env,
      FAKE_SSH_GAP_MS: String(gap),
      FAKE_SSH_HOLD_MS: String(hold),
    },
  });

  let stopped = false,
    resized = false;
  const sampler = setInterval(() => {
    observed.push(tracker.status(Date.now()).phase);
    if (
      resizeAtInteractive &&
      !resized &&
      tracker.status(Date.now()).phase === "interactive"
    ) {
      resized = session.resize(150, 38);
    }
    if (stopAfter && !stopped && Date.now() - started > stopAfter) {
      stopped = true;
      session.stop();
    }
  }, 10);

  const deadline = Date.now() + 20000;
  while (!exited && Date.now() < deadline) await sleep(25);
  clearInterval(sampler);
  const endedAt = Date.now();
  if (!exited) session.stop();
  await sleep(150);
  session.dispose();

  return {
    logPath,
    tracker,
    status: tracker.status(endedAt),
    tty: tty.join(""),
    prompts,
    exited,
    started,
    endedAt,
    firstLogAt,
    observed,
    resized,
    logText: readFileSync(logPath, "utf8"),
  };
}

/** The parser lives in TypeScript; load it once through the same stripper. */
const { parseSshLine } = await import("../src/ssh/events.ts");
function parse(line) {
  const parsed = parseSshLine(line);
  return parsed.matched ? parsed.event : null;
}

// ── 1. Success path ────────────────────────────────────────────────────────
const ok = await runFakeSession({ mode: "success" });

assert.equal(ok.exited.exitCode, 0, "fake ssh should exit cleanly");
assert.equal(
  ok.status.phase,
  "interactive",
  "the machine must reach interactive from real events",
);
assert.equal(ok.status.failure, null);
assert.equal(ok.status.facts.host.value, "lab-node-07");
assert.equal(
  ok.status.facts.hostKeyFingerprint.value,
  "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s",
);
assert.equal(ok.status.facts.authMethod.value, "publickey");

// The whole point: events arrived *while* the connection was happening.
assert.ok(ok.firstLogAt > 0, "at least one log line must have been observed");
const total = ok.endedAt - ok.started;
assert.ok(
  ok.firstLogAt - ok.started < total * 0.5,
  `events must stream in, not arrive at the end (first line at ${ok.firstLogAt - ok.started}ms of ${total}ms)`,
);
const distinct = new Set(ok.observed);
// Nothing may move before the first real line arrives, and once lines do
// arrive the phase must advance through several states while ssh is running.
assert.equal(
  ok.observed[0],
  "idle",
  "no event has arrived yet, so the phase must still be idle",
);
const live = ok.observed.filter((phase) => phase !== "idle");
assert.ok(
  new Set(live).size >= 3,
  `the live phase must move through several states, saw: ${[...new Set(live)].join(", ")}`,
);
assert.equal(
  ok.observed[ok.observed.length - 1],
  "interactive",
  "the sampled phase ends interactive",
);

// The exact terminal stream includes authentication and preserves VT positions.
assert.ok(
  ok.tty.includes("operator@lab-node-07:~$"),
  "the pty carries the session prompt",
);
assert.ok(
  /debug1:/.test(ok.tty),
  "authentication belongs in the real terminal stream and its scrollback",
);
assert.ok(/debug1:/.test(ok.logText), "the log file carries the debug stream");
assert.ok(
  ok.exited.bytesIn > 0,
  "pty byte counter must be live for the traffic wave",
);
assert.equal(
  ok.exited.logLines,
  19,
  "every emitted line must reach the consumer",
);
assert.equal(
  ok.tracker.status(ok.endedAt).unknownLines.length,
  0,
  "the fake emits only known lines",
);

// ── 2. Rejection path ──────────────────────────────────────────────────────
const rejected = await runFakeSession({ mode: "rejected", gap: 20, hold: 50 });
assert.equal(
  rejected.exited.exitCode,
  255,
  "ssh reports 255 for a rejected connection",
);
assert.equal(rejected.status.phase, "failed");
assert.match(rejected.status.failure, /认证被拒绝/);
assert.match(rejected.status.failure, /publickey,password/);
assert.deepEqual(
  rejected.status.timeline.map((entry) => entry.phase),
  ["resolving", "connecting", "handshake", "authenticating", "failed"],
  "the timeline is the real path the evidence took",
);

// ── 3. Resize reaches the pty ──────────────────────────────────────────────
const resized = await runFakeSession({
  mode: "success",
  gap: 30,
  hold: 900,
  resizeAtInteractive: true,
});
assert.equal(resized.exited.exitCode, 0);
assert.equal(resized.resized, true);
assert.equal(
  resized.exited.logLines,
  19,
  "ConPTY resize redraws must not duplicate the event record",
);
let probeExit = null;
let probeData = false;
const probe = new PtySession({
  onData: () => {
    probeData = true;
  },
  onLog: () => {
    probeData = true;
  },
  onExit: (info) => (probeExit = info),
});
probe.start({
  file: process.execPath,
  args: [
    fakeSsh,
    ...buildSshArgs({
      target: "operator@h",
      logPath: path.join(workdir, "resize.log"),
    }),
  ],
  logPath: path.join(workdir, "resize.log"),
  cols: 80,
  rows: 24,
  env: { ...process.env, FAKE_SSH_HOLD_MS: "1200" },
});
assert.equal(probe.resize(132, 43), true, "a valid resize is accepted");
assert.equal(probe.resize(0, 43), false, "a zero column count is rejected");
assert.equal(probe.resize(NaN, 10), false, "a non-numeric size is rejected");
for (let i = 0; i < 100 && !probeData; i++) await sleep(10);
await sleep(0); // node-pty marks Windows ready after forwarding first data.
assert.ok(probeData, "the input pipe became ready");
assert.equal(probe.write("echo hi\r"), true, "input reaches the pty");
const bytesBefore = probe.bytesOut;
probe.write("中文🙂\r");
assert.equal(
  probe.bytesOut - bytesBefore,
  Buffer.byteLength("中文🙂\r"),
  "traffic counts UTF-8 bytes, not UTF-16 code units",
);
const stoppedAt = Date.now();
probe.stop();
// Wait for the real exit rather than a fixed sleep: `running` also reads false
// while the fallback kill timer is armed, which is not the same thing as ended.
let stopMs = -1;
for (let i = 0; i < 100 && !probeExit; i++) await sleep(50);
if (probeExit) stopMs = Date.now() - stoppedAt;
assert.ok(probeExit, "stop() must produce a real exit report");
assert.ok(
  stopMs < 3000,
  `stop() should end the session promptly, took ${stopMs}ms`,
);
assert.equal(probe.running, false, "stop() must end the session");
assert.equal(probe.write("x"), false, "a stopped session refuses input");
probe.dispose();

// ── 4. Stop on a still-running session reports a real exit ─────────────────
const long = await runFakeSession({
  mode: "success",
  gap: 20,
  hold: 4000,
  stopAfter: 350,
});
assert.ok(long.exited, "stopping must still produce an exit report");
assert.notEqual(
  long.exited.exitCode,
  0,
  "an interrupted ssh does not exit cleanly",
);

rmSync(workdir, { recursive: true, force: true });
console.log(
  "SSH session (pty, stream split, incremental events) checks passed.",
);

// Every assertion above has run. node-pty's Windows console-list agent can
// leave a handle behind after a pty is killed (it reports "AttachConsole
// failed" when the parent has no console to attach to), so end explicitly
// rather than waiting on a handle this script does not own.
process.exit(0);
