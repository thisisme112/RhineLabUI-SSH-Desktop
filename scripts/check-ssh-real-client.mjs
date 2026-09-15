/**
 * The real `ssh.exe`, driven through the real transport.
 *
 * Every other SSH check runs a stand-in. That is why a whole class of defect
 * survived: `ssh -E <file>` looked fine in the fixture, because the fixture
 * writes that file incrementally by construction. Measured against
 * OpenSSH_for_Windows_9.5p2, ssh opens the `-E` file exclusively — `fs.open`
 * fails with EBUSY until ssh closes it, so the diagnostics arrived after the
 * connection was over and every animation was a replay rather than a report.
 *
 * This check runs the actual client and asserts the property the fixture could
 * never disprove: the event stream is readable *while the session is still
 * running*.
 *
 * No server is involved. A refused connection still performs configuration
 * parsing, DNS and a TCP connect, which is enough to watch the phase machine
 * move through real states at real times.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SshSessionTracker } from "../src/ssh/session.ts";

const require = createRequire(import.meta.url);
const { PtySession } = require("../electron/session.cjs");
const { buildSshArgs, resolveSshPath } = require("../electron/ssh-args.cjs");

const ssh = resolveSshPath();
if (!existsSync(ssh)) {
  console.log("real ssh client not found; skipping the real-client check");
  process.exit(0);
}

const workdir = mkdtempSync(path.join(tmpdir(), "rhine-ssh-real-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const { parseSshLine } = await import("../src/ssh/events.ts");

// ── a refused connection still negotiates far enough to be worth watching ──
const logPath = path.join(workdir, "events.log");
const tracker = new SshSessionTracker();
const tty = [];
const sampled = [];
const started = Date.now();
let firstLogAt = -1;
let exitAt = -1;
let exited = null;
let logWhileRunning = null;

const session = new PtySession({
  onData: (chunk) => tty.push(chunk),
  onLog: (line) => {
    if (firstLogAt < 0) firstLogAt = Date.now();
    const parsed = parseSshLine(line);
    if (parsed.matched) tracker.push(parsed.event, Date.now());
  },
  onExit: (info) => {
    exitAt = Date.now();
    exited = info;
  },
});

session.start({
  file: ssh,
  args: [
    ...buildSshArgs({ target: "probe@127.0.0.1", port: 2222 }),
    "-o",
    "ConnectTimeout=6",
  ],
  logPath,
  cols: 100,
  rows: 30,
});

const sampler = setInterval(() => {
  sampled.push(tracker.status(Date.now()).phase);
  // The assertion the old design failed: the file has to be readable now, not
  // once ssh has finished with it.
  if (logWhileRunning === null && Date.now() - started > 1200) {
    try {
      logWhileRunning = readFileSync(logPath, "utf8");
    } catch (error) {
      logWhileRunning = `UNREADABLE: ${error.code}`;
    }
  }
}, 20);

const deadline = Date.now() + 30000;
while (!exited && Date.now() < deadline) await sleep(25);
clearInterval(sampler);
session.dispose();

const endedAt = Date.now();
const total = Math.max(1, endedAt - started);
// The exit status is evidence too: the client calls this, because a real
// failure often explains itself only through the code ssh returned.
tracker.ended(exited?.exitCode ?? null, endedAt);
const status = tracker.status(endedAt);

assert.ok(exited, "the real client must exit, one way or another");
assert.ok(
  firstLogAt > 0,
  "the real client must produce at least one diagnostic line",
);

// The load-bearing one. With `-E` every line landed in the same late burst.
assert.ok(
  firstLogAt - started < total * 0.5,
  `diagnostics must stream while connecting, not at the end (first line at ${
    firstLogAt - started
  }ms of ${total}ms)`,
);

// …and readable from disk mid-session, which an exclusively held file is not.
assert.ok(
  typeof logWhileRunning === "string" &&
    !logWhileRunning.startsWith("UNREADABLE") &&
    /debug1:/.test(logWhileRunning),
  `the event log must be readable while ssh is running (got ${String(
    logWhileRunning,
  ).slice(0, 80)})`,
);

assert.equal(sampled[0], "idle", "nothing moves before the first real line");
// The first lines arrive together, so the sampler can miss a short phase that
// the machine genuinely passed through; the machine's own transition log is the
// honest record of how far the real connection got.
const live = [...new Set(sampled.filter((phase) => phase !== "idle"))];
assert.ok(
  live.length >= 2,
  `the phase must actually move while ssh is running, saw: ${live.join(", ")}`,
);
assert.ok(
  status.timeline.length >= 3,
  `the real connection must cross several phases, saw: ${status.timeline
    .map((entry) => entry.phase)
    .join(", ")}`,
);

// Exact raw terminal output and an independently readable event record.
const text = tty.join("");
assert.ok(
  /debug1:/.test(text),
  "the terminal retains real authentication output",
);
assert.ok(
  /debug1:/.test(readFileSync(logPath, "utf8")),
  "the log file carries the diagnostics",
);
assert.ok(
  !buildSshArgs({ target: "h", port: 2222 }).includes("-E"),
  "the event log belongs to this process, not to ssh",
);

// The ending is explained by the line that caused it, not by a bare exit code.
assert.equal(status.phase, "failed", "a refused connection ends in failure");
assert.ok(
  status.failure && status.failure.length > 0,
  "the failure carries the reason ssh gave",
);
assert.ok(
  status.unknownLines.length < status.eventCount,
  "a real client still emits lines this parser understands",
);

rmSync(workdir, { recursive: true, force: true });
console.log(
  `SSH real client (${path.basename(ssh)}) checks passed — first line at ${
    firstLogAt - started
  }ms of ${total}ms, phases: ${live.join(", ")}`,
);

// node-pty's console-list agent can leave a handle behind after a pty is
// killed; end explicitly rather than waiting on it.
process.exit(0);
