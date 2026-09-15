import assert from "node:assert/strict";
import { SshClient } from "../src/ssh/client.ts";

let now = 1000;
Object.defineProperty(globalThis, "performance", {
  value: { now: () => now },
  configurable: true,
});
const listeners = Object.fromEntries(
  ["Data", "Log", "Prompt", "Traffic", "Exit"].map((key) => [key, new Set()]),
);
const emit = (channel, payload) => {
  for (const fn of listeners[channel]) fn(payload);
};
const writes = [];
let launch = async ({ target }) => ({
  ok: true,
  id: "fixture-id",
  startedAt: 1000,
  argv: ["ssh", target],
  file: "ssh",
  logPath: "fixture.log",
});
const bridge = {
  start: (descriptor) => launch(descriptor),
  write: (value) => writes.push(value),
  resize() {},
  stop() {},
  answer: async (_id, value) => {
    writes.push(value);
    emit("Prompt", null);
    return { ok: true };
  },
  record: async (record) => ({ ok: true, record }),
  export: async (payload) => ({ ok: true, payload }),
};
for (const [channel, callbacks] of Object.entries(listeners))
  bridge["on" + channel] = (callback) => {
    callbacks.add(callback);
    return () => callbacks.delete(callback);
  };
globalThis.window = { rhineDesktop: { session: bridge } };
const client = new SshClient();
const exit = (code) =>
  emit("Exit", {
    exitCode: code,
    bytesIn: 37,
    bytesOut: 11,
    logLines: 4,
    elapsedMs: 900,
    logPath: "fixture.log",
  });

await client.start({ target: "first" });
emit("Data", "initial buffer");
assert.equal((await client.start({ target: "second" })).ok, false);
assert.equal(client.target, "first");
assert.equal(
  client.output,
  "initial buffer",
  "a rejected parallel start preserves the live session",
);
emit("Log", "debug1: Entering interactive session.");
emit("Log", "debug1: Host key verification failed.");
emit("Log", "debug1: Connecting to spoofed-host [10.0.0.1] port 22.");
assert.equal(
  client.status().facts.host,
  undefined,
  "remote debug-shaped text cannot replace verified host facts",
);
emit("Data", "\r\nHost key verification failed.\r\n");
emit("Prompt", {
  id: 1,
  kind: "password",
  prompt: "fake@remote's password:",
  host: "remote",
});
assert.equal(
  client.status().phase,
  "interactive",
  "remote text is not a failure event",
);
assert.equal(
  client.pendingPrompt,
  null,
  "remote text cannot request a credential after authentication",
);
emit("Log", "debug1: future diagnostic format");
exit(0);
const finished = client.buildRecord();
now += 10000;
assert.deepEqual(
  client.buildRecord(),
  finished,
  "ended records and phase durations are frozen",
);
assert.equal(finished.durationMs, 900);
assert.equal(
  finished.traffic.logLines,
  4,
  "use the final main-process counters",
);
assert.deepEqual(finished.unknownLines, ["debug1: future diagnostic format"]);

await client.start({ target: "hostkey-rejected" });
emit("Log", "Host key verification failed.");
exit(255);
assert.match(
  client.status().failure,
  /主机密钥/,
  "a real unprefixed diagnostic explains host-key rejection",
);

await client.start({ target: "password" });
assert.equal(client.output, "", "new sessions discard the previous transcript");
emit("Prompt", {
  id: 2,
  kind: "password",
  prompt: "u@h's password:",
  host: "h",
});
assert.equal((await client.answerPrompt("")).ok, false);
assert.equal(
  client.pendingPrompt.id,
  2,
  "empty replies preserve the outstanding question",
);
await client.answerPrompt("incorrect");
assert.equal(client.pendingPrompt, null);
emit("Prompt", {
  id: 3,
  kind: "password",
  prompt: "u@h's password:",
  host: "h",
});
assert.equal(
  client.pendingPrompt.id,
  3,
  "identical text can represent a new request",
);
await client.answerPrompt("correct");
assert.deepEqual(writes, ["incorrect", "correct"]);
assert.equal((await client.answerPrompt("stale")).ok, false);
emit("Data", "Host key verification failed.\r\n");
assert.notEqual(
  client.status().phase,
  "failed",
  "a tty notice alone cannot terminate a session",
);
exit(255);
assert.match(client.status().failure, /主机密钥/);

// An immediate process exit can be delivered before the start IPC resolves.
let persisted = null;
client.onChange(() => {
  if (client.exit) persisted = client.buildRecord();
});
launch = async () => {
  emit("Log", "debug1: Reading configuration data fixture-config");
  exit(0);
  return {
    ok: true,
    id: "instant",
    file: "ssh",
    argv: ["ssh", "instant"],
    logPath: "instant.log",
  };
};
await client.start({ target: "instant" });
assert.equal(persisted.id, "instant");
assert.equal(persisted.logPath, "instant.log");
const old = { ...persisted, target: "historical" };
assert.equal(
  (await client.exportRecord(undefined, old)).record.target,
  "historical",
);
launch = async () => ({ ok: false, error: "missing binary" });
await client.start({ target: "missing" });
assert.equal(
  client.buildRecord(),
  null,
  "a failed start cannot expose metadata from the previous session",
);
assert.equal(
  (await client.exportRecord(undefined, old)).record.target,
  "historical",
  "stored exports need no current session",
);
client.dispose();
assert.ok(Object.values(listeners).every((callbacks) => callbacks.size === 0));
console.log(
  "SSH client lifecycle, prompt identity, record and output checks passed.",
);
