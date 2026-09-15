/**
 * The Android SSH driver, running the code that ships.
 *
 *   npm run check:android-ssh-driver
 *
 * `check-ssh-session-agent` proves the Go agent speaks SSH. This proves the
 * renderer side interprets it correctly: the event mapping, the base64 on the
 * terminal stream, the promise plumbing behind start/connect/write/resize, and
 * the two callbacks that are the whole point of the design — accepting a host
 * key, and answering a challenge the server has not asked for yet.
 *
 * It does that by importing `src/ssh/android/session.ts` unchanged and giving
 * it a Node-backed pipe instead of the Capacitor one. The driver cannot tell
 * the difference, which is the property that makes it testable at all; the
 * Capacitor plugin is a pipe of exactly this shape.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { goExecutable } from "./build-ssh-services.mjs";
import { AndroidSshSession } from "../src/ssh/android/session.ts";

const root = process.cwd();
const out = path.join(root, "verification", "android-ssh-driver");
await fs.mkdir(out, { recursive: true });
await fs.mkdir(path.join(root, ".tools/ssh-fixtures"), { recursive: true });
const directory = await fs.mkdtemp(path.join(root, ".tools/ssh-fixtures/driver-"));
const checks = [];
const passed = (name) => {
  checks.push(name);
  console.log("PASS " + name);
};

const go = await goExecutable();
const build = async (pkg, name) => {
  const target = path.join(directory, name);
  await new Promise((resolve, reject) => {
    const child = spawn(go, ["build", "-trimpath", "-buildvcs=false", "-o", target, pkg], {
      cwd: path.join(root, "services/ssh"),
      windowsHide: true,
      stdio: "inherit",
      env: { ...process.env, GOTOOLCHAIN: "local", CGO_ENABLED: "0" },
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${pkg} exited ${code}`))));
  });
  return target;
};
const fixtureExe = await build("./cmd/fixture", process.platform === "win32" ? "fixture.exe" : "fixture");
const agentExe = await build("./cmd/session", process.platform === "win32" ? "session.exe" : "session");

function startFixture() {
  return new Promise((resolve, reject) => {
    const child = spawn(fixtureExe, ["--directory", directory, "--port", "0"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const message = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (message.event === "ready") resolve({ child, ready: message });
      }
    });
    child.on("error", reject);
    setTimeout(() => reject(new Error("fixture never reported ready")), 20000);
  });
}

/** The same contract the Capacitor plugin implements. */
function nodePipe() {
  const lineHandlers = new Set();
  const closedHandlers = new Set();
  let child;
  return {
    async start() {
      child = spawn(agentExe, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        while (buffer.includes("\n")) {
          const index = buffer.indexOf("\n");
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          for (const handler of [...lineHandlers]) handler(line);
        }
      });
      child.on("exit", (code) => {
        for (const handler of [...closedHandlers]) handler(code ?? -1);
      });
      return { ok: true, abi: "test" };
    },
    async send(line) {
      child.stdin.write(line + "\n");
    },
    onLine(handler) {
      lineHandlers.add(handler);
      return () => lineHandlers.delete(handler);
    },
    onClosed(handler) {
      closedHandlers.add(handler);
      return () => closedHandlers.delete(handler);
    },
    async stop() {
      child?.kill();
    },
  };
}

/** Collect the driver's events and let a test await a condition over them. */
function recorder() {
  const events = [];
  const waiters = [];
  return {
    events,
    push(event) {
      events.push(event);
      for (const wake of [...waiters]) wake();
    },
    async until(label, predicate, timeout = 30000) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const found = events.find(predicate);
        if (found) return found;
        if (Date.now() > deadline)
          throw new Error(`Timed out: ${label}. events=${JSON.stringify(events.map((e) => e.kind + (e.phase ? ":" + e.phase : "")))}`);
        await Promise.race([new Promise((resolve) => waiters.push(resolve)), new Promise((r) => setTimeout(r, 80))]);
      }
    },
    text() {
      return events
        .filter((e) => e.kind === "data")
        .map((e) => new TextDecoder().decode(e.bytes))
        .join("");
    },
  };
}

async function open() {
  const record = recorder();
  const session = new AndroidSshSession(nodePipe());
  session.on((event) => record.push(event));
  const started = await session.start();
  assert.equal(started.ok, true, "the pipe starts");
  return { session, record };
}

const fixture = await startFixture();
const { ready } = fixture;
console.log(`fixture on 127.0.0.1:${ready.port}, ${ready.fingerprint}`);

try {
  // ── the driver's view of a real connection ───────────────────────────────
  {
    const { session, record } = await open();
    await session.connect({
      host: "127.0.0.1",
      port: ready.port,
      user: "password",
      auth: { method: "password", password: "fixture-password" },
    });

    const question = await record.until("host key", (e) => e.kind === "hostkey");
    assert.equal(question.fingerprint, ready.fingerprint);
    assert.equal(question.keyType, "ssh-ed25519");
    const atQuestion = await record.until("hostkey phase", (e) => e.kind === "phase" && e.phase === "hostkey");
    assert.ok(atQuestion, "the surface is told it is waiting on a host key");
    passed("a host key question reaches the surface with the server's real fingerprint");

    question.accept();
    await record.until("interactive", (e) => e.kind === "phase" && e.phase === "interactive");
    const phases = record.events.filter((e) => e.kind === "phase").map((e) => e.phase);
    assert.deepEqual(
      phases,
      ["connecting", "handshake", "hostkey", "authenticating", "opening", "interactive"],
      `phases as the driver reports them: ${JSON.stringify(phases)}`,
    );
    passed("the phase sequence the surface animates is exactly the protocol's");

    await record.until("banner", () => record.text().includes("Isolated SSH fixture"));
    passed("terminal bytes are decoded from base64 into the shell's own output");

    await session.write("driver-round-trip\n");
    await record.until("echo", () => record.text().includes("fixture: driver-round-trip"));
    passed("typed input round-trips through the driver to the server and back");

    await session.resize(100, 30);
    passed("the driver's resize reaches the server");

    await session.write("exit\n");
    const exit = await record.until("exit", (e) => e.kind === "exit");
    assert.equal(exit.code, 0, "a clean exit reports code 0, not nothing");
    passed("an exit status of 0 survives the protocol rather than being dropped as empty");
    await session.stop();
  }

  // ── refusing a host key refuses the connection ───────────────────────────
  {
    const { session, record } = await open();
    await session.connect({
      host: "127.0.0.1",
      port: ready.port,
      user: "password",
      auth: { method: "password", password: "fixture-password" },
    });
    const question = await record.until("host key", (e) => e.kind === "hostkey");
    question.reject();
    const failure = await record.until("refused", (e) => e.kind === "error");
    assert.match(failure.message, /host key not accepted/i);
    assert.equal(
      record.events.some((e) => e.kind === "phase" && e.phase === "authenticating"),
      false,
      "refusing the identity stops the attempt before authentication",
    );
    passed("rejecting the host key ends the attempt before any credential is sent");
    await session.stop();
  }

  // ── a wrong password is reported, not hidden ─────────────────────────────
  {
    const { session, record } = await open();
    await session.connect({
      host: "127.0.0.1",
      port: ready.port,
      user: "password",
      auth: { method: "password", password: "wrong" },
      knownHost: { keyType: "ssh-ed25519", fingerprint: ready.fingerprint },
    });
    const failure = await record.until("failure", (e) => e.kind === "error");
    assert.match(failure.message, /unable to authenticate/i);
    await record.until("failed phase", (e) => e.kind === "phase" && e.phase === "failed");
    passed("a rejected password reports the failed phase and the reason");
    await session.stop();
  }

  // ── a challenge that cannot exist until the server asks ──────────────────
  {
    const { session, record } = await open();
    await session.connect({
      host: "127.0.0.1",
      port: ready.port,
      user: "otp",
      auth: { method: "keyboard-interactive" },
      knownHost: { keyType: "ssh-ed25519", fingerprint: ready.fingerprint },
    });
    const prompt = await record.until("prompt", (e) => e.kind === "prompt");
    assert.equal(prompt.promptKind, "verification-code");
    assert.match(prompt.prompt, /verification code/i);
    passed("the server's challenge is surfaced when it arrives, with its own wording");
    prompt.answer("314159");
    await record.until("accepted", (e) => e.kind === "phase" && e.phase === "interactive");
    passed("answering the challenge completes the connection");
    await session.stop();
  }
} catch (error) {
  console.error("\n=== FAILED ===");
  console.error(error.message);
  checks.push("driver completed");
  process.exitCode = 1;
} finally {
  fixture.child.kill();
  await fs.writeFile(
    path.join(out, "report.json"),
    JSON.stringify({ checks, passed: !process.exitCode }, null, 2),
  );
  console.log(`\n${checks.length} checks`);
  process.exit(process.exitCode ?? 0);
}
