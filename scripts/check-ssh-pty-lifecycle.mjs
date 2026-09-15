import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PtySession } = require("../electron/session.cjs");
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Models node-pty's first-data ordering and native-exit / public-exit gap. */
class DeferredPty {
  ready = false;
  dead = false;
  deferred = [];
  sizes = [];
  writes = [];
  kills = 0;
  onData(callback) {
    this.data = callback;
  }
  onExit(callback) {
    this.exit = callback;
  }
  perform(operation) {
    if (this.ready) operation();
    else this.deferred.push(operation);
  }
  resize(cols, rows) {
    this.perform(() => {
      if (this.dead)
        throw new Error("Cannot resize a pty that has already exited");
      this.sizes.push([cols, rows]);
    });
  }
  write(data) {
    this.perform(() => {
      if (this.dead) throw new Error("pty input is closed");
      this.writes.push(data);
    });
  }
  kill() {
    this.perform(() => {
      this.kills++;
      this.dead = true;
      this.exit({ exitCode: 143 });
    });
  }
  output(data) {
    this.data(data);
    this.ready = true;
    this.deferred.splice(0).forEach((operation) => operation());
  }
}

const spawned = [];
const exits = [];
const prompts = [];
let resizeDuringData = false;
const session = new PtySession({
  spawn: () => {
    const target = new DeferredPty();
    spawned.push(target);
    return target;
  },
  waitForData: true,
  onData: () => {
    if (resizeDuringData) session.resize(118, 37);
  },
  onPrompt: (prompt) => prompts.push(prompt),
  onExit: (exit) => exits.push(exit),
});
const start = () => session.start({ file: "fixture", args: [], logPath: "" });

start();
assert.equal(session.resize(90, 27), true);
assert.equal(session.resize(120, 40), true);
assert.equal(session.write("too early"), false);
assert.equal(session.bytesOut, 0);
assert.equal(
  spawned[0].deferred.length,
  0,
  "startup must not enter node-pty's deferred queue",
);
resizeDuringData = true;
spawned[0].output("opening\r\n");
assert.equal(
  spawned[0].deferred.length,
  0,
  "the first data callback still precedes native readiness",
);
await nextTurn();
resizeDuringData = false;
assert.deepEqual(
  spawned[0].sizes,
  [[118, 37]],
  "only the latest startup size is applied",
);
assert.equal(session.write("中文🙂\r"), true);
assert.equal(session.bytesOut, Buffer.byteLength("中文🙂\r"));
assert.equal(session.resize(Infinity, 24), false);
assert.equal(session.resize(80, 0), false);
assert.equal(session.resize(32768, 24), false);

spawned[0].output("operator@host's password: ");
const prompt = prompts.at(-1);
assert.ok(prompt?.id);
spawned[0].dead = true; // Native process ended; final output has not drained.
const written = session.bytesOut;
assert.equal(
  session.resize(100, 30),
  false,
  "late native resize must not escape to Electron",
);
assert.equal(session.write("late input"), false);
assert.equal(
  session.answer(prompt.id, "secret").ok,
  false,
  "an undelivered password cannot report success",
);
assert.equal(session.bytesOut, written, "rejected writes are not traffic");
assert.equal(exits.length, 0, "failed resize cannot fabricate an exit event");
spawned[0].exit({ exitCode: 255 });
assert.equal(exits.length, 1);
assert.equal(exits[0].exitCode, 255);
assert.equal(session.resize(80, 24), false);
assert.equal(session.write("after exit"), false);

start();
session.resize(160, 50);
spawned[1].dead = true;
assert.doesNotThrow(() => spawned[1].output("final output\r\n"));
await nextTurn();
assert.equal(
  spawned[1].deferred.length,
  0,
  "queued startup resize stays caught when native exit wins",
);
assert.equal(exits.length, 1);
spawned[1].exit({ exitCode: 7 });

start();
session.resize(150, 45);
assert.equal(session.stop(), true);
assert.equal(session.stop(), false, "stop is idempotent even before readiness");
assert.equal(session.running, false);
assert.equal(session.resize(90, 30), false);
assert.equal(session.write("after stop"), false);
spawned[2].output("starting\r\n");
await nextTurn();
assert.equal(spawned[2].kills, 1);
assert.deepEqual(spawned[2].sizes, [], "stop cancels the pending resize");

start();
session.resize(132, 43);
spawned[3].output("new session\r\n");
await nextTurn();
spawned[0].data("stale bytes");
spawned[0].exit({ exitCode: 99 });
assert.equal(
  session.running,
  true,
  "retired callbacks cannot terminate a replacement session",
);
assert.deepEqual(spawned[3].sizes, [[132, 43]]);
assert.equal(session.write("new input"), true);
assert.equal(session.stop(), true);
assert.equal(session.resize(80, 24), false);
assert.equal(session.write("late input"), false);
assert.equal(exits.length, 4);
session.dispose();

// Real Windows ConPTY: resize every millisecond, including before first data
// and between the native process exit and node-pty's public onExit callback.
let nativeSessions = 0;
for (let index = 0; index < 12; index++) {
  let exit = null;
  const live = new PtySession({
    onExit: (value) => {
      exit = value;
    },
  });
  live.start({
    file: process.execPath,
    args: [
      "-e",
      "process.stdout.write('quick exit\\r\\n'); setTimeout(() => process.exit(0), 15)",
    ],
    logPath: "",
  });
  let tick = 0;
  live.resize(100, 30);
  const resizeTimer = setInterval(
    () => live.resize(80 + (tick++ % 40), 24 + (tick % 15)),
    1,
  );
  const deadline = Date.now() + 5000;
  try {
    while (!exit && Date.now() < deadline) await sleep(5);
    assert.ok(exit, "quick native process must report its real exit");
    assert.equal(exit.exitCode, 0);
    assert.equal(live.resize(132, 43), false);
    assert.equal(live.write("after exit"), false);
    nativeSessions++;
  } finally {
    clearInterval(resizeTimer);
    live.stop();
    live.dispose();
  }
}

// Stop immediately, before the first data event, with no explicit child output.
let earlyExit = null;
const early = new PtySession({
  onExit: (value) => {
    earlyExit = value;
  },
});
early.start({
  file: process.execPath,
  args: ["-e", "setTimeout(() => process.exit(0), 2000)"],
  logPath: "",
});
const stoppedAt = Date.now();
assert.equal(early.stop(), true);
while (!earlyExit && Date.now() - stoppedAt < 4000) await sleep(10);
assert.ok(earlyExit, "stopping before data still reports the real exit");
assert.ok(
  Date.now() - stoppedAt < 1800,
  "an early stop does not wait for natural process exit",
);
assert.equal(early.resize(80, 24), false);
early.dispose();

console.log(
  `PTY lifecycle checks passed; ${nativeSessions} rapid native exits plus an immediate stop.`,
);
// node-pty's console-list helper can outlive an already completed Windows test.
process.exit(0);
