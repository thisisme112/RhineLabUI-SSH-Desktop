const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createDiagnosticLog, createReloadBudget, bindCrashRecovery, sanitize } = require("../electron/diagnostic-log.cjs");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rhine-diagnostic-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("diagnostics accept only fixed classifications and numeric metadata", () => {
  const clean = sanitize({ level: "error", reason: "crashed", code: 7, line: 21,
    message: "SECRET", alias: "SECRET", url: "file:///SECRET", sessionId: {},
    source: "SECRET", category: "SECRET", password: "SECRET" });
  assert.deepEqual(clean, { level: "error", reason: "crashed", code: 7, line: 21 });
});

test("writes rotate before the cap and retain at most seven valid JSONL files", t => {
  const dir = fixture(t);
  const log = createDiagnosticLog({ dir, maxBytes: 220 });
  for (let i = 0; i < 30; i++) log.write("renderer-crash", { reason: "crashed", code: i, message: "SECRET" });
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 7);
  const codes = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    assert.ok(Buffer.byteLength(text) <= 220);
    assert.ok(!text.includes("SECRET"));
    for (const line of text.trim().split("\n")) codes.push(JSON.parse(line).code);
  }
  assert.ok(codes.includes(29));
  assert.equal(log.enabled(), true);
});

test("write failures disable logging without throwing", t => {
  const dir = fixture(t);
  const file = path.join(dir, "not-a-directory");
  fs.writeFileSync(file, "fixture");
  const log = createDiagnosticLog({ dir: file });
  assert.doesNotThrow(() => log.write("app"));
  assert.equal(log.enabled(), false);
  assert.doesNotThrow(() => log.write("app"));
});

test("recovery stops owned sessions before reloading, with three attempts per rolling window", () => {
  let time = 0;
  const order = [];
  const contents = Object.assign(new EventEmitter(), { id: 9, isDestroyed: () => false,
    reload: () => order.push("reload") });
  const off = bindCrashRecovery({ contents, stopOwner: id => order.push(`stop:${id}`),
    log: () => {}, budget: createReloadBudget({ now: () => time }) });
  for (let i = 0; i < 4; i++) contents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.deepEqual(order, ["stop:9", "reload", "stop:9", "reload", "stop:9", "reload", "stop:9"]);
  time = 300000;
  contents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.equal(order.at(-1), "reload");
  off();
  assert.equal(contents.listenerCount("render-process-gone"), 0);
});

test("clean exits and disabled recovery stop owners but never reload", () => {
  for (const enabled of [true, false]) {
    let stopped = 0;
    const contents = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false,
      reload: () => assert.fail("unexpected reload") });
    bindCrashRecovery({ contents, enabled, stopOwner: () => stopped++, log: () => {} });
    contents.emit("render-process-gone", {}, { reason: enabled ? "clean-exit" : "crashed" });
    assert.equal(stopped, 1);
  }
});
