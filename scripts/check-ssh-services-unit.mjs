import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  SshServices,
  buildAuxiliaryArgs,
  validSample,
} = require("../electron/ssh-services.cjs");
const { authenticationMatches } = require("../electron/session.cjs");

test("only the destination authentication starts services through ProxyJump", () => {
  const target = {
    host: "host.example",
    port: 2222,
    user: "operator",
    viaProxy: true,
  };
  const peer = { host: "host.example", port: 2222, user: "operator" };
  assert(
    !authenticationMatches(
      'Authenticated to host.example ([127.0.0.1]:2222) using "publickey".',
      target,
      peer,
    ),
  );
  assert(
    !authenticationMatches(
      "debug1: Entering interactive session.",
      target,
      peer,
    ),
  );
  assert(
    !authenticationMatches(
      'Authenticated to gateway (via proxy) using "password".',
      target,
      peer,
    ),
  );
  assert(
    !authenticationMatches(
      'Authenticated to host.example (via proxy) using "password".',
      target,
      { ...peer, user: "jump" },
    ),
  );
  assert(
    !authenticationMatches(
      'Authenticated to host.example (via proxy) using "password".',
      target,
      { ...peer, port: 22 },
    ),
  );
  assert(
    authenticationMatches(
      'Authenticated to host.example (via proxy) using "password".',
      target,
      peer,
    ),
  );
  assert(
    authenticationMatches(
      'Authenticated to host.example ([127.0.0.1]:2222) using "password".',
      { ...target, viaProxy: false },
      peer,
    ),
  );
});

test("auxiliary sessions preserve connection options without duplicating forwarding", () => {
  const args = buildAuxiliaryArgs({
    target: "fixture",
    user: "operator",
    port: 2222,
    identityFile: "C:/test/key",
    jumpHost: "gateway",
    keepAliveInterval: 10,
    extraArgs: [
      "-L",
      "6000:localhost:60",
      "-A",
      "-N",
      "-C",
      "-o",
      "ConnectTimeout=8",
      "-o",
      "ExitOnForwardFailure=yes",
    ],
  });
  for (const value of [
    "fixture",
    "operator",
    "2222",
    "C:/test/key",
    "gateway",
    "-C",
    "ConnectTimeout=8",
    "ClearAllForwardings=yes",
    "ForwardAgent=no",
    "RemoteCommand=none",
    "PermitLocalCommand=no",
  ])
    assert(args.includes(value), value);
  for (const value of [
    "-L",
    "-A",
    "-N",
    "6000:localhost:60",
    "ExitOnForwardFailure=yes",
  ])
    assert(!args.includes(value), value);
  assert.equal(args.at(-1), "fixture");
});

const auth = (id, overrides = {}) => ({
  id,
  connection: "connection-a",
  source: "sftp",
  kind: "password",
  prompt: "operator@fixture's password: ",
  fingerprint: "SHA256:FIXTURE",
  diagnostics: "",
  method: "password",
  peer: { host: "fixture", port: 22, user: "operator" },
  ...overrides,
});
test("secrets are fingerprint-bound, used once per prompt/connection, and absent from snapshots", async () => {
  const published = [],
    calls = [];
  const service = new SshServices({
    id: "test",
    launch: { target: "fixture" },
    endpoint: { host: "fixture", port: 22, user: "operator" },
    disabled: true,
    send: (event) => published.push(event),
  });
  service.rpc = async (method, params) => {
    calls.push({ method, params });
    return { ok: true };
  };
  service.observeLog("debug1: Authenticating to fixture:22 as 'operator'");
  service.observeLog("debug1: Server host key: ssh-ed25519 SHA256:FIXTURE");
  service.observeLog("debug1: Next authentication method: password");
  service.rememberPrimaryAnswer(auth("primary"), "never-serialized-secret");
  service.activate();
  service.receive({ event: "auth", data: auth("a") });
  await Promise.resolve();
  assert.equal(calls[0].params.value, "never-serialized-secret");
  service.receive({
    event: "auth",
    data: auth("b", {
      connection: "other",
      kind: "verification-code",
      prompt: "Password OTP:",
    }),
  });
  assert.equal(
    service.state.prompt.id,
    "b",
    "an automatically answered request cannot cover an OTP request",
  );
  service.receive({ event: "authClosed", data: { id: "b" } });
  service.receive({ event: "authClosed", data: { id: "a" } });
  service.receive({ event: "auth", data: auth("c") });
  assert.equal(
    calls.length,
    1,
    "a failed credential is not retried indefinitely",
  );
  assert.equal(service.state.prompt.id, "c");
  service.receive({ event: "authClosed", data: { id: "c" } });
  service.receive({
    event: "auth",
    data: auth("d", { connection: "new", fingerprint: "SHA256:CHANGED" }),
  });
  assert.equal(service.state.prompt.id, "d");
  assert.equal(calls.length, 1);
  assert(
    !JSON.stringify(service.snapshot()).includes("never-serialized-secret"),
  );
  assert(!JSON.stringify(published).includes("never-serialized-secret"));
  assert.equal((await service.answer("stale", "anything")).ok, false);
  assert.equal(
    (await service.call("stale-session", "list", { path: "/" })).ok,
    false,
  );
  service.close();
  assert.equal(service.credentialBroker.memory.size, 0);
  assert.equal(service.auth.size, 0);
});

test("keyboard-interactive primary secrets are never cached", () => {
  const service = new SshServices({
    id: "otp",
    launch: { target: "fixture" },
    send() {},
  });
  service.observeLog("debug1: Server host key: ssh-ed25519 SHA256:FIXTURE");
  service.observeLog(
    "debug1: Next authentication method: keyboard-interactive",
  );
  service.rememberPrimaryAnswer(auth("primary"), "OTP-test-value");
  assert.equal(service.credentialBroker.memory.size, 0);
  service.close();
});

test("closed service refuses updates and retains only bounded trend points", () => {
  const service = new SshServices({
    id: "history",
    launch: { target: "fixture" },
    send() {},
  });
  for (let sequence = 1; sequence <= 400; sequence++) {
    const sample = {
      sequence,
      timestamp: Date.now() + sequence * 1000,
      hostname: "fixture",
      uptime: 1,
      cpu: { usage: 25, cores: 2, load: [1, 1, 1] },
      memory: null,
      diskIO: { read: null, write: null },
      disks: [],
      networks: [],
      gpus: [
        {
          uuid: "GPU-fixture",
          index: 0,
          name: "fixture",
          utilization: 25,
          memoryUsed: 1024,
          memoryTotal: 2048,
          temperature: null,
          power: null,
          powerLimit: null,
          fan: null,
          processes: [
            {
              pid: 1,
              name: "large-process-name",
              type: "C",
              memory: 1,
              gpu: "GPU-fixture",
            },
          ],
        },
      ],
      gpuAt: Date.now(),
      gpuState: "live",
    };
    assert(validSample(sample));
    service.receive({ event: "sample", data: sample });
  }
  assert.equal(service.state.history.length, 300);
  assert(!JSON.stringify(service.state.history).includes("large-process-name"));
  assert(
    !validSample({
      sequence: 1,
      timestamp: 1,
      gpus: "bad",
      disks: [],
      networks: [],
    }),
  );
  service.close();
  service.receive({
    event: "capability",
    data: { service: "monitor", state: "ready" },
  });
  assert.equal(service.state.monitor.state, "stopped");
});

test("interrupted transfers retry from owned paths after a worker restart", async () => {
  const service = new SshServices({
    id: "restart",
    launch: { target: "fixture" },
    send() {},
  });
  const calls = [];
  service.rpc = async (method, params) => {
    calls.push({ method, params });
    return { ok: true, result: [] };
  };
  service.workerGeneration = 1;
  service.receive({
    event: "transfer",
    data: {
      id: "old",
      direction: "upload",
      source: "C:/approved/input",
      destination: "/home/operator",
      state: "failed",
    },
  });
  service.workerGeneration = 2;
  service.state.sftp.state = "ready";
  assert(
    (
      await service.call("restart", "retry", {
        id: "old",
        source: "C:/not-approved",
      })
    ).ok,
  );
  assert.deepEqual(calls, [
    {
      method: "upload",
      params: { paths: ["C:/approved/input"], destination: "/home/operator" },
    },
  ]);
  assert.equal(
    (await service.call("restart", "retry", { id: "old" })).ok,
    false,
  );
  service.workerGeneration = 1;
  service.receive({
    event: "transfer",
    data: {
      id: "uncertain",
      direction: "download",
      state: "uncertain",
      retryable: false,
    },
  });
  service.workerGeneration = 2;
  assert.equal(
    (await service.call("restart", "retry", { id: "uncertain" })).ok,
    false,
  );
  assert.equal(calls.length, 1);
  service.close();
});

test("malformed metrics are rejected and stale GPU samples leave gaps", () => {
  const service = new SshServices({
    id: "samples",
    launch: { target: "fixture" },
    send() {},
  });
  const sample = {
    sequence: 1,
    timestamp: 20000,
    hostname: "fixture",
    uptime: 1,
    cpu: null,
    memory: null,
    diskIO: { read: null, write: null },
    disks: [],
    networks: [],
    gpus: [],
    gpuAt: 0,
    gpuState: "unavailable",
  };
  for (const patch of [
    { diskIO: null },
    { networks: [null] },
    { disks: [{}] },
    { cpu: { usage: 1, cores: 1, load: "bad" } },
    { gpus: [null] },
    { errors: [null] },
  ]) {
    assert(!validSample({ ...sample, ...patch }));
  }
  const gpu = {
    uuid: "GPU-test",
    name: "fixture",
    index: 0,
    utilization: 85,
    memoryUsed: 1,
    memoryTotal: 2,
    temperature: null,
    power: null,
    powerLimit: null,
    fan: null,
    processes: [],
  };
  service.receive({
    event: "sample",
    data: { ...sample, gpus: [gpu], gpuAt: 10000, gpuState: "error" },
  });
  assert.equal(service.state.history[0].gpus[0].utilization, null);
  service.receive({
    event: "capability",
    data: { service: "monitor", state: "probing" },
  });
  service.receive({ event: "sample", data: { ...sample, timestamp: 15000 } });
  assert.equal(
    service.state.sample.timestamp,
    15000,
    "new collector may restart after a clock correction",
  );
  service.close();
});
