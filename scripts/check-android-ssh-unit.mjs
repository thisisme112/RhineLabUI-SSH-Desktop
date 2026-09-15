import test from "node:test";
import assert from "node:assert/strict";
import { AndroidSshSession } from "../src/ssh/android/session.ts";
import { AndroidHostStore, storageKey, credentialIdentity, normalizeProfile } from "../src/ssh/android/store.ts";

function pipe() {
  const lines = new Set(), closes = new Set(), sent = [];
  const value = {
    sent, emit: message => { for (const fn of lines) fn(JSON.stringify(message)); },
    close: () => { for (const fn of [...closes]) fn(-1); },
    async start() { assert.equal(lines.size, 1, "listen before starting the process"); return { ok: true }; },
    async send(line) { sent.push(JSON.parse(line)); }, async stop() {},
    onLine(fn) { lines.add(fn); return () => lines.delete(fn); },
    onClosed(fn) { closes.add(fn); return () => closes.delete(fn); },
  };
  return value;
}
const key = { keyType: "ssh-ed25519", fingerprint: "SHA256:" + "A".repeat(43) };

test("unexpected process exit rejects outstanding requests and never invents exit status zero", async () => {
  const wire = pipe(), session = new AndroidSshSession(wire), events = [];
  session.on(e => events.push(e)); await session.start();
  wire.emit({ event: "phase", phase: "interactive" });
  const write = session.write("pending input");
  wire.close();
  await assert.rejects(write, /退出/);
  assert.equal(session.current, "closed");
  assert.deepEqual(events.filter(e => e.kind === "exit").map(e => e.code), [null]);
});
test("an old or repeated host-key / prompt action cannot reach another stage or a stopped process", async () => {
  const wire = pipe(), session = new AndroidSshSession(wire), events = [];
  session.on(e => events.push(e)); await session.start();
  wire.emit({ event: "hostkey", ...key });
  const question = events.find(e => e.kind === "hostkey");
  question.accept(); question.reject();
  assert.equal(wire.sent.length, 1);
  wire.emit({ id: wire.sent[0].id, ok: true });
  wire.emit({ event: "prompt", id: "p1", kind: "password", prompt: "Password" });
  const prompt = events.find(e => e.kind === "prompt");
  await session.stop(); prompt.answer("secret"); question.accept();
  assert.equal(wire.sent.length, 1);
});
test("terminal text and malformed protocol messages cannot claim a trusted phase", async () => {
  const wire = pipe(), session = new AndroidSshSession(wire), events = [];
  session.on(e => events.push(e)); await session.start();
  wire.emit({ event: "phase", phase: "handshake" });
  const text = '{"event":"phase","phase":"interactive"}\n<svg onload=alert(1)>';
  wire.emit({ event: "data", data: Buffer.from(text).toString("base64") });
  wire.emit({ event: "phase", phase: "invented" }); wire.emit(null);
  wire.emit({ event: "data", data: "not base64%" });
  assert.equal(session.current, "handshake");
  assert.equal(new TextDecoder().decode(events.find(e => e.kind === "data").bytes), text);
  assert.equal(events.filter(e => e.kind === "error").length, 3);
  await session.stop();
});
test("cancellation during Android DNS cannot dispatch a late connect", async () => {
  const wire = pipe(); let finish;
  wire.resolve = () => new Promise(resolve => { finish = resolve; });
  const session = new AndroidSshSession(wire); await session.start();
  const pending = session.connect({ host: "test.example", user: "test", auth: { method: "password" } });
  await session.stop(); finish(["127.0.0.1"]);
  await assert.rejects(pending, /取消/); assert.equal(wire.sent.length, 0);
});
test("connection is single-use and known host identity survives native DNS resolution", async () => {
  const wire = pipe(); wire.resolve = async () => ["127.0.0.1"];
  const session = new AndroidSshSession(wire); await session.start();
  const pending = session.connect({ host: "test.example", user: "test", knownHost: key, auth: { method: "password" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wire.sent[0].params.host, "test.example"); assert.deepEqual(wire.sent[0].params.knownHost, key);
  assert.deepEqual(wire.sent[0].params.addresses, ["127.0.0.1"]);
  wire.emit({ id: wire.sent[0].id, ok: true }); await pending;
  await assert.rejects(session.connect({ host: "other.example", user: "other", auth: { method: "password" } }), /不可连接/);
  await session.stop();
});
test("host metadata strips secrets, normalizes addresses and binds credentials to the whole identity", () => {
  const values = new Map(); globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const store = new AndroidHostStore();
  const host = store.save({ id: "profile-1", name: " lab ", host: " EXAMPLE.COM. ", port: 22, user: " user ", method: "password", password: "must-never-persist" });
  assert.equal(host.host, "example.com"); assert.equal(host.user, "user");
  assert.ok(!values.get(storageKey).includes("must-never-persist"));
  store.trust(host, key); assert.deepEqual(new AndroidHostStore().key(host), key);
  const identity = credentialIdentity(host, key);
  for (const changed of [{ ...host, port: 2222 }, { ...host, user: "other" }, { ...host, host: "other.example" }, { ...host, method: "publickey" }, { ...host, id: "profile-2" }]) assert.notEqual(credentialIdentity(changed, key), identity);
  assert.notEqual(credentialIdentity(host, { ...key, fingerprint: "SHA256:" + "B".repeat(43) }), identity);
  assert.throws(() => normalizeProfile({ ...host, host: "ssh://host" }));
  assert.throws(() => normalizeProfile({ ...host, port: 0 }));
});
test("unknown or corrupt storage is preserved and cannot be overwritten with fresh trust", () => {
  for (const raw of ['{"version":99}', '{"version":1,"hosts":[],"known":[{}]}', "invalid"]) {
    let stored = raw; globalThis.localStorage = { getItem: () => stored, setItem: (_, value) => { stored = value; } };
    const store = new AndroidHostStore(); assert.ok(store.problem);
    assert.throws(() => store.save({ id: "p1", name: "test", host: "localhost", port: 22, user: "test", method: "password" }));
    assert.equal(stored, raw);
  }
});
