/**
 * The Android SSH transport, driven against a real SSH server.
 *
 *   npm run check:ssh-session-agent
 *
 * `services/ssh/cmd/session` exists because Android has no OpenSSH and will not
 * let a sandboxed app execute one it wrote. It speaks the protocol itself, so
 * the one thing worth checking is that it really speaks it: this runs it
 * against the repository's own fixture server — a genuine `x/crypto/ssh`
 * server with password, public-key and keyboard-interactive authentication —
 * and asserts the whole path, not a stand-in for it.
 *
 * The fixture is the target, the agent is the client, and neither is mocked.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { goExecutable } from "./build-ssh-services.mjs";

const root = process.cwd();
const out = path.join(root, "verification", "ssh-session-agent");
await fs.mkdir(out, { recursive: true });
await fs.mkdir(path.join(root, ".tools/ssh-fixtures"), { recursive: true });
const directory = await fs.mkdtemp(path.join(root, ".tools/ssh-fixtures/agent-"));
const checks = [];
const passed = (name) => {
  checks.push(name);
  console.log("PASS " + name);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const go = await goExecutable();
const build = async (pkg, name) => {
  const target = path.join(directory, name);
  await new Promise((resolve, reject) => {
    const child = spawn(
      go,
      ["build", "-trimpath", "-buildvcs=false", "-o", target, pkg],
      {
        cwd: path.join(root, "services/ssh"),
        windowsHide: true,
        stdio: "inherit",
        env: { ...process.env, GOTOOLCHAIN: "local", CGO_ENABLED: "0" },
      },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${pkg} build exited ${code}`)),
    );
  });
  return target;
};
const fixtureExe = await build(
  "./cmd/fixture",
  process.platform === "win32" ? "fixture.exe" : "fixture",
);
const agentExe = await build(
  "./cmd/session",
  process.platform === "win32" ? "session.exe" : "session",
);

/** Start the fixture server and wait for its `ready` line. */
function startFixture() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      fixtureExe,
      ["--directory", directory, "--port", "0"],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let buffer = "";
    let diagnostic = "";
    child.stderr.on("data", (chunk) => (diagnostic += chunk));
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
    setTimeout(() => reject(new Error("fixture never reported ready: " + diagnostic)), 20000);
  });
}

/**
 * Drive one agent process the way the Android plugin will: requests out on
 * stdin, events and replies back on stdout.
 */
/** Every agent this run started, so a failure mid-test cannot leave one alive
 *  holding the event loop open and turning a failed assertion into a hang. */
const agents = [];

class Agent {
  constructor() {
    this.events = [];
    this.waiters = [];
    this.replies = new Map();
    this.counter = 0;
    this.exited = new Promise((resolve) => (this.resolveExit = resolve));
    this.child = spawn(agentExe, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    agents.push(this);
    let buffer = "";
    this.stderr = "";
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => (this.stderr += chunk));
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const message = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (message.id !== undefined && message.event === undefined) {
          this.replies.get(message.id)?.(message);
          this.replies.delete(message.id);
        } else {
          this.events.push(message);
          for (const waiter of [...this.waiters]) waiter();
        }
      }
    });
    this.child.on("exit", () => this.resolveExit());
  }

  send(method, params = {}) {
    const id = String(++this.counter);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30000);
      this.replies.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  /** Wait until an event satisfies `predicate`, scanning what already arrived. */
  async until(label, predicate, timeout = 30000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const found = this.events.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out: ${label}. events=${JSON.stringify(this.events)} stderr=${this.stderr}`,
        );
      }
      await Promise.race([
        new Promise((resolve) => this.waiters.push(resolve)),
        sleep(100),
      ]);
    }
  }

  phases() {
    return this.events.filter((e) => e.event === "phase").map((e) => e.phase);
  }

  /** Everything the server has sent on the terminal stream, decoded. */
  output() {
    return this.events
      .filter((e) => e.event === "data")
      .map((e) => Buffer.from(e.data, "base64").toString("utf8"))
      .join("");
  }

  async stop() {
    await this.send("stop").catch(() => {});
    this.child.kill();
    await this.exited;
  }
}

const fixture = await startFixture();
const { ready } = fixture;
console.log(`fixture on 127.0.0.1:${ready.port}, ${ready.fingerprint}`);

try {
  // ── the full happy path, over a real SSH handshake ───────────────────────
  {
    const agent = new Agent();
    const reply = await agent.send("connect", {
      host: "127.0.0.1",
      port: ready.port,
      user: "password",
      auth: { method: "password", password: "fixture-password" },
    });
    assert.equal(reply.ok, true, "connect is accepted");

    // The identity question comes before any credential, which is the whole
    // reason the callback blocks the handshake.
    const question = await agent.until("host key question", (e) => e.event === "hostkey");
    assert.equal(question.fingerprint, ready.fingerprint);
    assert.equal(question.keyType, "ssh-ed25519");
    passed("the agent asks about the host key, with the server's real fingerprint");

    await agent.send("hostkey", { accept: true });
    await agent.until("interactive", (e) => e.event === "phase" && e.phase === "interactive");

    const phases = agent.phases();
    const order = ["connecting", "handshake", "authenticating", "opening", "interactive"];
    assert.deepEqual(
      phases.filter((p) => order.includes(p)),
      order,
      `phases in protocol order, got ${JSON.stringify(phases)}`,
    );
    passed("every stage is reported in the order the protocol performs them");

    const banner = await agent.until("shell banner", (e) =>
      e.event === "data" && Buffer.from(e.data, "base64").toString("utf8").includes("Isolated SSH fixture"),
    );
    assert.ok(banner);
    passed("the shell's own output arrives on the terminal stream");

    // Real input, real round trip through the server's scanner.
    await agent.send("write", { data: Buffer.from("hello\n").toString("base64") });
    await agent.until("echo", () => agent.output().includes("fixture: hello"));
    passed("input reaches the server and its answer comes back");

    const resize = await agent.send("resize", { cols: 100, rows: 30 });
    assert.equal(resize.ok, true, "window-change is accepted by the server");
    passed("the terminal can be resized after the shell is up");

    await agent.send("write", { data: Buffer.from("exit\n").toString("base64") });
    const exit = await agent.until("exit", (e) => e.event === "exit");
    assert.equal(exit.code, 0);
    assert.ok(agent.phases().includes("closed"));
    passed("closing the shell reports an exit status and a closed phase");
    await agent.stop();
  }

  // ── the host key is a security boundary ──────────────────────────────────
  {
    const agent = new Agent();
    await agent.send("connect", {
      host: "127.0.0.1",
      port: ready.port,
      user: "password",
      auth: { method: "password", password: "fixture-password" },
      knownHost: { keyType: "ssh-ed25519", fingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    });
    const failure = await agent.until("mismatch", (e) => e.event === "error");
    assert.match(failure.message, /host key changed/i);
    assert.equal(
      agent.events.some((e) => e.event === "hostkey"),
      false,
      "a recorded mismatch is refused, never put back to the user as a question",
    );
    passed("a changed host key is refused without asking");
    await agent.stop();
  }

  // ── a remembered key is not asked about again ────────────────────────────
  {
    const agent = new Agent();
    await agent.send("connect", {
      host: "127.0.0.1",
      port: ready.port,
      user: "password",
      auth: { method: "password", password: "fixture-password" },
      knownHost: { keyType: "ssh-ed25519", fingerprint: ready.fingerprint },
    });
    await agent.until("interactive", (e) => e.event === "phase" && e.phase === "interactive");
    assert.equal(
      agent.events.some((e) => e.event === "hostkey"),
      false,
      "an already-accepted key is silent",
    );
    passed("an accepted host key is not asked about a second time");
    await agent.stop();
  }

  // ── public key authentication, including a passphrase ────────────────────
  {
    const identity = await fs.readFile(ready.identity, "utf8");
    const agent = new Agent();
    await agent.send("connect", {
      host: "127.0.0.1",
      port: ready.port,
      user: "key",
      auth: { method: "publickey", privateKey: identity },
      knownHost: { keyType: "ssh-ed25519", fingerprint: ready.fingerprint },
    });
    await agent.until("key auth", (e) => e.event === "phase" && e.phase === "interactive");
    passed("public key authentication completes");
    await agent.stop();
  }
  {
    const encrypted = await fs.readFile(ready.encryptedIdentity, "utf8");
    const agent = new Agent();
    await agent.send("connect", {
      host: "127.0.0.1",
      port: ready.port,
      user: "key",
      auth: { method: "publickey", privateKey: encrypted, passphrase: "fixture-passphrase" },
      knownHost: { keyType: "ssh-ed25519", fingerprint: ready.fingerprint },
    });
    await agent.until("encrypted key auth", (e) => e.event === "phase" && e.phase === "interactive");
    passed("an encrypted private key is unlocked with its passphrase");
    await agent.stop();
  }
  {
    const encrypted = await fs.readFile(ready.encryptedIdentity, "utf8");
    const agent = new Agent();
    await agent.send("connect", {
      host: "127.0.0.1",
      port: ready.port,
      user: "key",
      auth: { method: "publickey", privateKey: encrypted },
      knownHost: { keyType: "ssh-ed25519", fingerprint: ready.fingerprint },
    });
    const failure = await agent.until("passphrase needed", (e) => e.event === "error");
    assert.match(failure.message, /passphrase/i);
    passed("a locked key without its passphrase says so, rather than failing obscurely");
    await agent.stop();
  }

  // ── keyboard-interactive, answered when the server asks ──────────────────
  {
    const agent = new Agent();
    await agent.send("connect", {
      host: "127.0.0.1",
      port: ready.port,
      user: "otp",
      auth: { method: "keyboard-interactive" },
      knownHost: { keyType: "ssh-ed25519", fingerprint: ready.fingerprint },
    });
    // The prompt cannot exist before the server asks for it, which is exactly
    // why this is an event and not a parameter of connect.
    const prompt = await agent.until("otp prompt", (e) => e.event === "prompt");
    assert.equal(prompt.kind, "verification-code");
    passed("a keyboard-interactive challenge is put to the caller when it arrives");

    await agent.send("answer", { id: prompt.id, value: "314159" });
    await agent.until("otp accepted", (e) => e.event === "phase" && e.phase === "interactive");
    passed("answering it completes the connection");
    await agent.stop();
  }
  {
    const agent = new Agent();
    await agent.send("connect", {
      host: "127.0.0.1",
      port: ready.port,
      user: "otp",
      auth: { method: "keyboard-interactive" },
      knownHost: { keyType: "ssh-ed25519", fingerprint: ready.fingerprint },
    });
    const prompt = await agent.until("otp prompt again", (e) => e.event === "prompt");
    await agent.send("answer", { id: prompt.id, value: "000000" });
    const failure = await agent.until("otp rejected", (e) => e.event === "error");
    assert.match(failure.message, /unable to authenticate|otp rejected/i);
    passed("a wrong code fails the connection instead of appearing to succeed");
    await agent.stop();
  }

  // ── a wrong password is reported, not swallowed ──────────────────────────
  {
    const agent = new Agent();
    await agent.send("connect", {
      host: "127.0.0.1",
      port: ready.port,
      user: "password",
      auth: { method: "password", password: "not-the-password" },
      knownHost: { keyType: "ssh-ed25519", fingerprint: ready.fingerprint },
    });
    const failure = await agent.until("auth failure", (e) => e.event === "error");
    assert.match(failure.message, /unable to authenticate/i);
    assert.ok(agent.phases().includes("failed"));
    passed("a rejected password reports a failed phase and the reason");
    await agent.stop();
  }
} catch (error) {
  console.error("\n=== FAILED ===");
  console.error(error.message);
  checks.push("driver completed");
  process.exitCode = 1;
} finally {
  fixture.child.kill();
  for (const agent of agents) agent.child.kill();
  await fs.writeFile(
    path.join(out, "report.json"),
    JSON.stringify({ checks, passed: !process.exitCode }, null, 2),
  );
  console.log(`\n${checks.length} checks`);
  // Nothing should still be holding the loop; if something is, say so instead
  // of hanging and looking like a timeout.
  process.exit(process.exitCode ?? 0);
}
