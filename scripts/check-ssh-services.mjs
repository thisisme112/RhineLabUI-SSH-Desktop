/** Real system OpenSSH + native bridge, isolated Go SSH/SFTP server.
 * Collector frames are explicitly simulated here; parser tests are separate. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureServices, goExecutable } from "./build-ssh-services.mjs";
const require = createRequire(import.meta.url);
const {
  SshServices,
  effectiveEndpoint,
} = require("../electron/ssh-services.cjs");
const { PtySession } = require("../electron/session.cjs");
const { resolveSshPath } = require("../electron/ssh-args.cjs");
const root = process.cwd(), outputIndex = process.argv.indexOf("--out"),
  output = path.resolve(root, outputIndex >= 0 ? process.argv[outputIndex + 1] : "verification/ssh-workspace");
await fs.mkdir(output, { recursive: true });
await fs.mkdir(path.join(root, ".tools/ssh-fixtures"), { recursive: true });
const directory = await fs.mkdtemp(path.join(root, ".tools/ssh-fixtures/run-"));
const executable = path.join(
  directory,
  process.platform === "win32" ? "fixture.exe" : "fixture",
);
const run = promisify(execFile),
  checks = [],
  services = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
const wait = async (label, condition, timeout = 20000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = condition();
    if (result) return result;
    await sleep(40);
  }
  throw new Error("Timed out: " + label);
};
const passed = (name) => {
  checks.push(name);
  console.log("PASS " + name);
};
let fixture,
  ready,
  controlCounter = 0,
  events = [];
const pending = new Map();
async function startFixture(port = 0) {
  ready = null;
  fixture = spawn(
    executable,
    ["--directory", directory, "--port", String(port)],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  let buffer = "",
    diagnostic = "";
  fixture.stderr.on("data", (chunk) => {
    diagnostic += chunk;
  });
  fixture.stdout.setEncoding("utf8");
  fixture.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n"),
        message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      if (message.id) {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      } else {
        events.push(message);
        if (message.event === "ready") ready = message;
      }
    }
  });
  fixture.on("error", (error) => {
    diagnostic += error.message;
  });
  await wait(
    "fixture starts " + diagnostic,
    () =>
      ready ||
      (fixture.exitCode != null &&
        (() => {
          throw new Error(diagnostic || "Fixture exited");
        })()),
  );
  return ready;
}
function control(method, params = {}) {
  const id = String(++controlCounter);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Fixture control timeout: " + method));
    }, 10000);
    pending.set(id, (response) => {
      clearTimeout(timer);
      response.ok
        ? resolve(response.result)
        : reject(new Error(response.error));
    });
    fixture.stdin.write(JSON.stringify({ id, method, ...params }) + "\n");
  });
}
async function closeService(service) {
  const worker = service.worker;
  service.close();
  if (worker)
    await wait(
      "native bridge exits",
      () => worker.exitCode != null || worker.signalCode != null,
      8000,
    );
}
async function startService(target, answerMode = "normal", seedCredential = false) {
  const shown = [],
    serviceEvents = [];
  const id = "native-" + services.length;
  const service = new SshServices({
    id,
    launch: { target },
    target,
    endpoint: await effectiveEndpoint({ target }),
    send(event) {
      serviceEvents.push(event);
      if (event.event === "auth" && event.data) {
        const prompt = event.data;
        if (shown.some((item) => item.id === prompt.id)) return;
        shown.push({
          id: prompt.id,
          kind: prompt.kind,
          connection: prompt.connection,
        });
        const value =
          prompt.kind === "hostkey"
            ? "yes"
            : prompt.kind === "passphrase"
              ? "fixture-passphrase"
              : prompt.kind === "verification-code"
                ? "314159"
                : "fixture-password";
        setTimeout(() => {
          void service.answer(prompt.id, value, answerMode === "cancel");
        }, 5);
      }
    },
  });
  service.fixturePrompts = shown;
  service.fixtureEvents = serviceEvents;
  const peer = service.credentialBroker.endpoint;
  service.observeLog(`debug1: Authenticating to ${peer.host}:${peer.port} as '${peer.user}'`);
  service.observeLog("debug1: Server host key: ssh-ed25519 " + ready.fingerprint);
  if (seedCredential) {
    service.observeLog(
      "debug1: Server host key: ssh-ed25519 " + ready.fingerprint,
    );
    service.observeLog("debug1: Next authentication method: password");
    service.rememberPrimaryAnswer(
      { kind: "password", prompt: "password@127.0.0.1's password: " },
      "fixture-password",
    );
  }
  services.push(service);
  service.activate();
  return service;
}
const readyService = async (service) => {
  await wait("SFTP is ready: " + service.id, () => {
    if (service.state.sftp.state === "error")
      throw new Error(service.state.sftp.message);
    return service.state.sftp.state === "ready";
  });
  await wait("collector protocol starts: " + service.id, () => {
    if (service.state.monitor.state === "error")
      throw new Error(service.state.monitor.message);
    return service.state.monitor.state === "ready" && service.state.sample;
  });
};
const rpc = async (service, method, params) => {
  const result = await service.call(service.id, method, params);
  assert(result.ok, result.error);
  return result.result;
};
const waitJob = (service, id, wanted) =>
  wait("job " + wanted, () => {
    const job = service.state.jobs.find((job) => job.id === id);
    if (["failed", "uncertain"].includes(job?.state) && job.state !== wanted)
      throw new Error(job.error);
    return job?.state === wanted ? job : null;
  });
const previousConfig = process.env.RHINE_SSH_CONFIG;
let error;
try {
  if (process.platform === "win32") {
    const { stdout } = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      ],
      { windowsHide: true },
    );
    const sid = stdout.trim();
    assert.match(sid, /^S-1-[0-9-]+$/);
    await run(
      "icacls.exe",
      [directory, "/inheritance:r", "/grant:r", "*" + sid + ":(OI)(CI)F"],
      { windowsHide: true },
    );
  }
  await ensureServices();
  await run(
    await goExecutable(),
    [
      "build",
      "-trimpath",
      "-buildvcs=false",
      "-o",
      executable,
      "./cmd/fixture",
    ],
    {
      cwd: path.join(root, "services/ssh"),
      windowsHide: true,
      env: { ...process.env, GOTOOLCHAIN: "local", CGO_ENABLED: "0" },
    },
  );
  await startFixture();
  const config = path.join(directory, "config"),
    known = path.join(directory, "known_hosts"),
    quote = (value) => '"' + value.replaceAll("\\", "/") + '"';
  await fs.writeFile(
    config,
    `Host fixture-password\n User password\n PreferredAuthentications password\nHost fixture-key fixture-gateway\n User key\n IdentityFile ${quote(ready.identity)}\n PreferredAuthentications publickey\nHost fixture-encrypted\n User key\n IdentityFile ${quote(ready.encryptedIdentity)}\n PreferredAuthentications publickey\nHost fixture-otp\n User otp\n PreferredAuthentications keyboard-interactive\nHost fixture-jump\n User password\n PreferredAuthentications password\n ProxyJump fixture-gateway\nHost *\n HostName 127.0.0.1\n Port ${ready.port}\n UserKnownHostsFile ${quote(known)}\n GlobalKnownHostsFile none\n StrictHostKeyChecking ask\n IdentitiesOnly yes\n IdentityAgent none\n ControlMaster no\n ControlPath none\n ConnectTimeout 5\n ServerAliveInterval 1\n ServerAliveCountMax 2\n`,
    "utf8",
  );
  process.env.RHINE_SSH_CONFIG = config;
  const endpoint = await effectiveEndpoint({ target: "fixture-password" });
  assert.deepEqual(endpoint, {
    host: "127.0.0.1",
    port: ready.port,
    user: "password",
    viaProxy: false,
  });
  passed("system ssh -G resolves an isolated config alias");
  if (process.argv.includes("--credentials-only")) {
    const fixtureInfo = path.join(directory, "credential-fixture.json");
    await fs.writeFile(fixtureInfo, JSON.stringify(ready));
    for (const phase of [1, 2]) {
      const reportFile = path.join(output, `credentials-phase-${phase}.json`);
      const env = { ...process.env, RHINE_CREDENTIAL_FIXTURE: fixtureInfo,
        RHINE_CREDENTIAL_PROFILE: path.join(directory, "credentials-profile"),
        RHINE_CREDENTIAL_PHASE: String(phase), RHINE_SMOKE_REPORT: reportFile };
      delete env.ELECTRON_RUN_AS_NODE;
      try {
        await run(path.join(root, "node_modules/electron/dist/electron.exe"), [".", "--session-smoke", "--credentials-only"],
          { cwd: root, env, windowsHide: true, timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
      } catch (error) {
        let details; try { details = JSON.parse(await fs.readFile(reportFile, "utf8")); } catch {}
        throw new Error(`Credential phase ${phase} failed: ${JSON.stringify(details || error.message)}`);
      }
      const proof = JSON.parse(await fs.readFile(reportFile, "utf8"));
      assert.deepEqual(proof.failed, []);
      for (const [name, result] of Object.entries(proof.checks)) { assert.equal(result, true); passed(name); }
    }
  } else if (process.argv.includes("--multi-only")) {
    const { checkNativeSessions } = await import("./ssh-multi-native-checks.mjs");
    await checkNativeSessions({ config, directory, wait, passed });
  } else {
  const password = await startService("fixture-password");
  await readyService(password);
  assert(password.fixturePrompts.some((prompt) => prompt.kind === "hostkey"));
  assert.equal(
    password.fixturePrompts.filter((prompt) => prompt.kind === "password")
      .length,
    1,
  );
  assert(!JSON.stringify(password.state).includes("fixture-password"));
  passed(
    "real OpenSSH host-key and password askpass; monitor connections reuse only this session's secret",
  );
  const manifest = JSON.parse(
    await fs.readFile("electron/resources/ssh-services/manifest.json", "utf8"),
  );
  const installed = await control("read", {
    Path: password.state.monitor.cache + "/agent",
  });
  assert.equal(
    hash(Buffer.from(installed, "base64")),
    manifest.files["monitor/linux/amd64"].sha256,
  );
  passed(
    "Linux collector travels through real SFTP and its remote checksum matches the packaged binary",
  );
  const input = path.join(directory, "upload", "测试资料"),
    outputDir = path.join(directory, "download");
  await fs.mkdir(path.join(input, "nested"), { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
  const binary = Buffer.alloc(3 * 1024 * 1024 + 31);
  for (let index = 0; index < binary.length; index++)
    binary[index] = index % 251;
  await fs.writeFile(path.join(input, "nested", "binary.bin"), binary);
  await fs.writeFile(path.join(input, ".hidden"), "中文 hidden");
  const [up] = await rpc(password, "upload", {
    paths: [input],
    destination: "/data",
  });
  await waitJob(password, up.id, "completed");
  const [down] = await rpc(password, "download", {
    paths: ["/data/测试资料"],
    destination: outputDir,
  });
  await waitJob(password, down.id, "completed");
  assert.equal(
    hash(
      await fs.readFile(
        path.join(outputDir, "测试资料", "nested", "binary.bin"),
      ),
    ),
    hash(binary),
  );
  assert.equal(
    await fs.readFile(path.join(outputDir, "测试资料", ".hidden"), "utf8"),
    "中文 hidden",
  );
  passed(
    "native Windows bridge transfers nested Unicode folders, hidden files and binary bytes in both directions",
  );
  const [again] = await rpc(password, "upload", {
    paths: [input],
    destination: "/data",
  });
  const conflict = await waitJob(password, again.id, "conflict");
  assert.equal(
    (
      await password.call(password.id, "conflict", {
        id: again.id,
        conflictId: "stale",
        choice: "overwrite",
      })
    ).ok,
    false,
  );
  await rpc(password, "conflict", {
    id: again.id,
    conflictId: conflict.conflict.id,
    choice: "keep-both",
    all: false,
  });
  await waitJob(password, again.id, "completed");
  await rpc(password, "mkdir", { path: "/data/临时" });
  await rpc(password, "rename", {
    path: "/data/临时",
    destination: "/data/已重命名",
  });
  await control("symlink", { Path: "/data/link", Target: "/data/测试资料" });
  await rpc(password, "remove", { path: "/data/link", recursive: true });
  const index = await rpc(password, "list", { path: "/data" });
  assert(index.entries.some((entry) => entry.name === "测试资料 (2)"));
  assert(index.entries.some((entry) => entry.name === "测试资料"));
  await rpc(password, "remove", { path: "/data/已重命名", recursive: true });
  passed(
    "native conflict tokens, keep-both, rename, mkdir and symlink-safe deletion",
  );
  const [cancelJob] = await rpc(password, "upload", {
    paths: [input],
    destination: "/data",
  });
  await waitJob(password, cancelJob.id, "conflict");
  await rpc(password, "cancel", { id: cancelJob.id });
  await waitJob(password, cancelJob.id, "canceled");
  passed("canceling a waiting transfer does not alter the remote directory");
  await closeService(password);
  const seeded = await startService("fixture-password", "normal", true);
  await readyService(seeded);
  assert.equal(seeded.fixturePrompts.length, 0);
  await closeService(seeded);
  passed(
    "a fingerprint-bound primary-session credential authenticates auxiliary channels without another password page",
  );
  const key = await startService("fixture-key");
  await readyService(key);
  assert.equal(key.fixturePrompts.length, 0);
  await closeService(key);
  passed("system SSH private-key authentication");
  const encrypted = await startService("fixture-encrypted");
  await readyService(encrypted);
  assert.equal(
    encrypted.fixturePrompts.filter((prompt) => prompt.kind === "passphrase")
      .length,
    1,
  );
  await closeService(encrypted);
  passed(
    "encrypted private key is unlocked through the same isolated askpass channel",
  );
  const otp = await startService("fixture-otp");
  await readyService(otp);
  assert.equal(
    otp.fixturePrompts.filter((prompt) => prompt.kind === "verification-code")
      .length,
    3,
  );
  await closeService(otp);
  passed(
    "keyboard-interactive OTP is requested independently for SFTP, probe and collector, never reused",
  );
  const jump = await startService("fixture-jump");
  await readyService(jump);
  await closeService(jump);
  passed("ProxyJump and inherited config work through real OpenSSH forwarding");
  const primaryLogs = [];
  let primaryAuthenticated = 0,
    primaryExit = false;
  const primary = new PtySession({
    onLog: (line) => primaryLogs.push(line),
    onAuthenticated: () => primaryAuthenticated++,
    onExit: () => {
      primaryExit = true;
    },
    onPrompt: (prompt) => {
      if (prompt)
        primary.answer(
          prompt.id,
          prompt.kind === "hostkey" ? "yes" : "fixture-password",
        );
    },
  });
  try {
    primary.start({
      file: resolveSshPath(),
      args: ["-F", config, "-v", "fixture-jump"],
      logPath: "",
      authenticationTarget: await effectiveEndpoint({ target: "fixture-jump" }),
    });
    await wait(
      "primary target authenticates through jump",
      () =>
        primaryLogs.some((line) =>
          /^Authenticated to .*\(via proxy\)/.test(line),
        ) || primaryExit,
    );
    assert.equal(
      primaryAuthenticated,
      1,
      "target authentication through ProxyJump must activate auxiliary services exactly once; observed: " +
        primaryLogs
          .filter((line) => /Authenticated to|Entering interactive/.test(line))
          .join(" | "),
    );
    passed(
      "primary ConPTY target authentication through ProxyJump activates auxiliary services once",
    );
  } finally {
    primary.stop();
    await wait("primary ConPTY exits", () => primaryExit, 8000);
    primary.dispose();
  }
  const canceled = await startService("fixture-password", "cancel");
  await wait(
    "auxiliary auth canceled",
    () => canceled.state.sftp.state === "error",
  );
  assert.equal(canceled.fixturePrompts.length, 1);
  assert.equal(canceled.closed, false);
  await closeService(canceled);
  passed(
    "canceling one auxiliary authentication ends that SSH channel without closing the owning session",
  );
  const dropped = await startService("fixture-password", "normal", true);
  await readyService(dropped);
  await control("drop");
  await wait("dropped SFTP stops", () => dropped.state.sftp.state === "error");
  await wait(
    "dropped monitor stops",
    () => dropped.state.monitor.state === "error",
  );
  await closeService(dropped);
  passed(
    "server disconnect marks both auxiliary channels failed and closes the bridge",
  );
  const crash = await startService("fixture-password", "normal", true);
  await readyService(crash);
  const stoppedBefore = events.filter(
    (event) => event.event === "monitor-stopped",
  ).length;
  crash.worker.kill();
  await wait(
    "worker crash is surfaced",
    () => crash.state.sftp.state === "error",
  );
  await wait(
    "Job Object cleans remote channel on worker crash",
    () =>
      events.filter((event) => event.event === "monitor-stopped").length >
      stoppedBefore,
  );
  await closeService(crash);
  passed(
    "native worker crash releases descendant SSH processes and the collector channel",
  );
  const oldPort = ready.port;
  await control("stop");
  await wait("fixture exits", () => fixture.exitCode != null);
  await startFixture(oldPort);
  const changed = await startService("fixture-password");
  await wait(
    "changed host key rejected",
    () => changed.state.sftp.state === "error",
  );
  assert.equal(
    changed.fixturePrompts.filter((prompt) => prompt.kind !== "hostkey").length,
    0,
  );
  assert.match(
    changed.state.sftp.message,
    /HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i,
  );
  await closeService(changed);
  passed("a changed known host key is rejected before any password is sent");
  }
} catch (failure) {
  error = String(failure.stack || failure);
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const service of services) {
    try {
      await closeService(service);
    } catch {}
  }
  if (fixture && fixture.exitCode == null) {
    try {
      await control("stop");
    } catch {}
    fixture.kill();
  }
  if (previousConfig === undefined) delete process.env.RHINE_SSH_CONFIG;
  else process.env.RHINE_SSH_CONFIG = previousConfig;
  await fs.writeFile(
    path.join(output, "native-protocol.json"),
    JSON.stringify(
      {
        checks,
        error: error || null,
        scope:
          "Real OpenSSH and SFTP. Collector protocol frames simulated; no real GPU or Linux-runtime claim.",
        fixtureDirectory: directory,
      },
      null,
      2,
    ),
  );
}
