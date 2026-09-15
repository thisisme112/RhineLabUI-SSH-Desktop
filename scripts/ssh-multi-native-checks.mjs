import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { SessionRegistry } = require("../electron/session-registry.cjs");
const { PtySession } = require("../electron/session.cjs");
const { SshServices, effectiveEndpoint } = require("../electron/ssh-services.cjs");
const { buildSshArgs, resolveSshPath } = require("../electron/ssh-args.cjs");

export async function checkNativeSessions({ config, directory, wait, passed }) {
  const owner = { id: 77, isDestroyed: () => false }, output = new Map(), workers = [], prompts = [], errors = [];
  const registry = new SessionRegistry({
    resolveLaunch: launch => ({ ok: true, launch, displayTarget: launch.target }),
    resolveEndpoint: effectiveEndpoint,
    logPathFor: (_target, id) => path.join(directory, id + ".log"),
    command: (launch, logPath) => ({ file: resolveSshPath(), args: ["-F", config, ...buildSshArgs({ ...launch, logPath })] }),
    createPty: callbacks => new PtySession(callbacks),
    createServices: options => { const worker = new SshServices(options); workers.push(worker); return worker; },
    send: (_sender, channel, payload) => {
      if (channel === "session:data") output.set(payload.sessionId, (output.get(payload.sessionId) || "") + payload.data);
      if (channel === "session:prompt" && payload.data) {
        prompts.push([payload.sessionId, payload.data.kind]);
        setTimeout(() => {
          const reply = registry.answer(owner, { sessionId: payload.sessionId, id: payload.data.id,
            value: payload.data.kind === "hostkey" ? "yes" : "fixture-password" });
          if (!reply.ok) errors.push(reply.error);
        }, 5);
      }
      if (channel === "services:event" && payload.event === "auth" && payload.data) {
        const service = registry.services(payload.sessionId);
        void service?.answer(payload.data.id, payload.data.kind === "hostkey" ? "yes" : "fixture-password").then(result => { if (!result.ok) errors.push(result.error); });
      }
    },
  });
  const a = registry.reserve(owner).id, b = registry.reserve(owner).id;
  const ready = id => {
    const service = registry.services(id), state = service?.state;
    if (state?.sftp.state === "error" || state?.monitor.state === "error") throw new Error(JSON.stringify({ sftp: state.sftp, monitor: state.monitor }));
    return output.get(id)?.includes("Isolated SSH fixture") && state?.sftp.state === "ready" && state.monitor.state === "ready" && state.sample ? service : null;
  };
  try {
    const launched = await Promise.all([
      registry.start(owner, a, { target: "fixture-password", cols: 100, rows: 30 }),
      registry.start(owner, b, { target: "fixture-key", cols: 120, rows: 36 }),
    ]);
    assert.ok(launched.every(result => result.ok), JSON.stringify(launched));
    const [sa, sb] = await Promise.all([wait("session A native shell and services", () => ready(a)), wait("session B native shell and services", () => ready(b))]);
    assert.equal(registry.active().length, 2);
    assert.notEqual(launched[0].logPath, launched[1].logPath);
    assert.notEqual(sa.worker.pid, sb.worker.pid);
    assert.ok(prompts.some(([id, kind]) => id === a && kind === "password"));
    assert.ok(!prompts.some(([id, kind]) => id === b && kind === "password"));
    passed("two simultaneous ConPTY + system OpenSSH sessions own separate log files, credentials and native service workers");
    // This isolated Go shell has a scanner rather than a remote termios PTY.
    registry.write(owner, { sessionId: a, data: "ONLY_SESSION_ALPHA\r\n" });
    registry.write(owner, { sessionId: b, data: "ONLY_SESSION_BETA\r\n" });
    await wait("native independent shell replies", () => output.get(a)?.includes("fixture: ONLY_SESSION_ALPHA") && output.get(b)?.includes("fixture: ONLY_SESSION_BETA"));
    assert.ok(!output.get(a).includes("ONLY_SESSION_BETA"));
    assert.ok(!output.get(b).includes("ONLY_SESSION_ALPHA"));
    registry.resize(owner, { sessionId: a, cols: 90, rows: 32 });
    registry.resize(owner, { sessionId: b, cols: 130, rows: 38 });
    passed("independent native PTY input, output and simultaneous resize do not cross sessions");
    const rpc = async (service, method, params) => { const result = await service.call(service.id, method, params); assert.ok(result.ok, result.error); return result.result; };
    await Promise.all([rpc(sa, "mkdir", { path: "/data/multi-a" }), rpc(sb, "mkdir", { path: "/data/multi-b" })]);
    const localA = path.join(directory, "multi-a.txt"), localB = path.join(directory, "multi-b.txt");
    await fs.writeFile(localA, "ALPHA-NATIVE-FILE"); await fs.writeFile(localB, "BETA-NATIVE-FILE");
    const [ja, jb] = await Promise.all([rpc(sa, "upload", { paths: [localA], destination: "/data/multi-a" }), rpc(sb, "upload", { paths: [localB], destination: "/data/multi-b" })]);
    await wait("both concurrent native transfers complete", () => sa.state.jobs.some(job => job.id === ja[0].id && job.state === "completed") && sb.state.jobs.some(job => job.id === jb[0].id && job.state === "completed"));
    const [fa, fb] = await Promise.all([rpc(sa, "list", { path: "/data/multi-a" }), rpc(sb, "list", { path: "/data/multi-b" })]);
    assert.deepEqual(fa.entries.map(entry => entry.name), ["multi-a.txt"]);
    assert.deepEqual(fb.entries.map(entry => entry.name), ["multi-b.txt"]);
    passed("concurrent SFTP transfers, directory requests and per-second monitor streams remain session-scoped");
    const sequence = sb.state.sample.sequence;
    registry.stop(owner, a);
    await wait("native session A cleanup", () => !registry.entries.has(a));
    registry.resize(owner, { sessionId: a, cols: 200, rows: 60 });
    assert.equal(registry.answer(owner, { sessionId: a, id: 1, value: "stale" }).ok, false);
    assert.equal(sb.closed, false);
    registry.write(owner, { sessionId: b, data: "BETA_SURVIVES_ALPHA\r\n" });
    await wait("session B remains interactive and monitors after A stops", () => output.get(b)?.includes("fixture: BETA_SURVIVES_ALPHA") && sb.state.sample.sequence > sequence);
    assert.equal(registry.active().length, 1);
    assert.deepEqual(errors, []);
    passed("ending A and late resize/auth callbacks leave B's terminal, SFTP and monitor alive");
  } finally {
    await fs.writeFile(path.join(directory, "native-session-output.json"), JSON.stringify(Object.fromEntries(output), null, 2));
    registry.stopAll();
    try { await wait("all native sessions exit", () => registry.entries.size === 0, 10000); } finally {
      for (const entry of [...registry.entries.values()]) registry.release(entry);
      for (const worker of workers) worker.close();
    }
  }
}
