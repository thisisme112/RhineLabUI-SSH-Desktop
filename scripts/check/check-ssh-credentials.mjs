import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
const require = createRequire(import.meta.url);
const { CredentialVault } = require("../../electron/credential-vault.cjs");
const { SshCredentials } = require("../../electron/ssh-credentials.cjs");
const { SessionRegistry } = require("../../electron/session-registry.cjs");
const { PtySession, detectPrompt } = require("../../electron/session.cjs");

const endpoint = { host: "node.example", port: 2222, user: "operator" };
const prompt = {
  kind: "password",
  prompt: "operator@node.example's password:",
};
const fingerprint = "SHA256:FIXTURE";
const encryptionKey = randomBytes(32);
// DPAPI is tested through real Electron separately. This encryptor exercises
// persistence and account-decryption failures without reading a user's vault.
const encryption = {
  isEncryptionAvailable: () => true,
  encryptString(value) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
    const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
  },
  decryptString(bytes) {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey,
      bytes.subarray(0, 12),
    );
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  },
};
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rhine-vault-test-"));
  t.after(() => {
    assert.equal(
      path.dirname(path.resolve(directory)),
      path.resolve(os.tmpdir()),
    );
    assert(path.basename(directory).startsWith("rhine-vault-test-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, "vault.json");
  const inspect = async () => ({
    type: "ssh-ed25519",
    fingerprint,
    protected: true,
  });
  const vault = new CredentialVault(file, encryption, inspect);
  const broker = new SshCredentials({
    vault,
    target: "profile",
    endpoint,
    launch: {},
  });
  return { directory, file, vault, broker, inspect };
}

test("encrypted password survives restart and binds only after successful authentication", (t) => {
  const { file, vault, broker, inspect } = fixture(t);
  vault.put("profile", "password", "fixture-password", endpoint);
  assert(!fs.readFileSync(file, "utf8").includes("fixture-password"));
  const restarted = new CredentialVault(file, encryption, inspect);
  assert.equal(
    restarted.get("profile", "password", endpoint, "", fingerprint),
    "fixture-password",
  );
  assert.equal(
    restarted.get(
      "profile",
      "password",
      { ...endpoint, port: 22 },
      "",
      fingerprint,
    ),
    null,
  );
  assert.equal(
    restarted.get(
      "profile",
      "password",
      { ...endpoint, user: "root" },
      "",
      fingerprint,
    ),
    null,
  );
  assert.equal(
    broker.automatic(prompt, fingerprint, "password", "primary", endpoint),
    "fixture-password",
  );
  assert.equal(Object.values(vault.read().credentials)[0].fingerprint, "");
  broker.authenticated();
  assert.equal(
    Object.values(vault.read().credentials)[0].fingerprint,
    fingerprint,
  );
  assert.equal(
    restarted.get("profile", "password", endpoint, "", "SHA256:CHANGED"),
    null,
  );
  assert.equal(vault.status("profile").password, "needs-update");
});

test("unknown methods, OTP, jump ports and other accounts never get target passwords", (t) => {
  const { vault, broker } = fixture(t);
  vault.put("profile", "password", "fixture-password", endpoint);
  for (const [request, method, peer] of [
    [prompt, "", endpoint],
    [prompt, "keyboard-interactive", endpoint],
    [{ ...prompt, kind: "verification-code" }, "password", endpoint],
    [prompt, "password", undefined],
    [prompt, "password", { ...endpoint, port: 22 }],
    [prompt, "password", { ...endpoint, user: "root" }],
    [
      { ...prompt, prompt: "root@node.example's password:" },
      "password",
      endpoint,
    ],
    [{ ...prompt, prompt: "password:" }, "password", endpoint],
  ]) {
    assert.equal(
      broker.automatic(request, fingerprint, method, "primary", peer),
      null,
    );
    assert.equal(
      broker.remember(
        request,
        "must-not-persist",
        fingerprint,
        method,
        true,
        "primary",
        "primary",
        peer,
      ),
      false,
    );
  }
  assert.equal(broker.pending.size, 0);
  assert.equal(broker.attempts.size, 0);
  assert.equal(vault.status("profile").password, "saved");
});

test("a failed automatic answer is tried once; manually corrected secrets are shared only after success", (t) => {
  const { vault, broker } = fixture(t);
  vault.put("profile", "password", "wrong-fixture-password", endpoint);
  assert.equal(
    broker.automatic(prompt, fingerprint, "password", "primary", endpoint),
    "wrong-fixture-password",
  );
  assert.equal(
    broker.automatic(prompt, fingerprint, "password", "primary", endpoint),
    null,
  );
  assert.equal(vault.status("profile").password, "needs-update");
  broker.remember(
    prompt,
    "correct-fixture-password",
    fingerprint,
    "password",
    true,
    "primary",
    "primary",
    endpoint,
  );
  assert.equal(
    broker.automatic(
      prompt,
      fingerprint,
      "password",
      "sftp-before-ready",
      endpoint,
    ),
    null,
  );
  broker.authenticated();
  assert.equal(vault.status("profile").password, "saved");
  const reworded = {
    ...prompt,
    source: "sftp",
    prompt: "operator@node.example's   Password: ",
  };
  assert.equal(
    broker.automatic(reworded, fingerprint, "password", "sftp-1", endpoint),
    "correct-fixture-password",
  );
  assert.equal(
    broker.automatic(prompt, fingerprint, "password", "monitor-1", endpoint),
    "correct-fixture-password",
  );
  broker.clear();
  assert.equal(broker.memory.size, 0);
  assert.equal(broker.pending.size, 0);
});

test("private-key passphrases require the selected file and exact authentication peer", (t) => {
  const { vault } = fixture(t);
  const file = path.resolve(".tools/key with spaces"),
    other = path.resolve(".tools/other-key");
  const keyId = "657ac171-2345-4321-abcd-12abcdef7890";
  const broker = new SshCredentials({
    vault,
    target: "profile",
    endpoint,
    launch: { keyId, identityFile: file },
  });
  const request = {
    kind: "passphrase",
    key: file,
    prompt: `Enter passphrase for key '${file}':`,
  };
  vault.put(
    "profile",
    "passphrase",
    "fixture-passphrase",
    endpoint,
    keyId,
    fingerprint,
  );
  assert.equal(
    broker.automatic(
      { ...request, key: other },
      fingerprint,
      "publickey",
      "primary",
      endpoint,
    ),
    null,
  );
  assert.equal(
    broker.automatic(
      request,
      fingerprint,
      "keyboard-interactive",
      "primary",
      endpoint,
    ),
    null,
  );
  assert.equal(
    broker.automatic(request, fingerprint, "publickey", "primary", endpoint),
    "fixture-passphrase",
  );
});

test("a delayed failed attempt cannot invalidate or bind a newly saved credential", (t) => {
  const { vault, broker } = fixture(t);
  vault.put("profile", "password", "old-password", endpoint);
  assert.equal(
    broker.automatic(prompt, fingerprint, "password", "primary", endpoint),
    "old-password",
  );
  vault.put("profile", "password", "new-password", endpoint);
  assert.equal(
    broker.automatic(prompt, fingerprint, "password", "primary", endpoint),
    null,
  );
  assert.equal(vault.status("profile").password, "saved");
  assert.equal(
    vault.get("profile", "password", endpoint, "", fingerprint),
    "new-password",
  );
  const second = new SshCredentials({
    vault,
    target: "profile",
    endpoint,
    launch: {},
  });
  assert.equal(
    second.automatic(prompt, fingerprint, "password", "primary", endpoint),
    "new-password",
  );
  vault.put("profile", "password", "newer-password", endpoint);
  second.authenticated();
  assert.equal(Object.values(vault.read().credentials)[0].fingerprint, "");
});

test("OpenSSH's 100-byte key hint must identify exactly one effective selected file", (t) => {
  const { vault } = fixture(t);
  const file = path.resolve(".tools/" + "long-path/".repeat(12) + "first-key");
  const keyId = "657ac171-2345-4321-abcd-12abcdef7890";
  const request = {
    kind: "passphrase",
    key: Buffer.from(file).subarray(0, 100).toString("utf8"),
  };
  vault.put(
    "profile",
    "passphrase",
    "fixture-passphrase",
    endpoint,
    keyId,
    fingerprint,
  );
  const create = (identityFiles) =>
    new SshCredentials({
      vault,
      target: "profile",
      endpoint: { ...endpoint, identityFiles },
      launch: { keyId, identityFile: file },
    });
  assert.equal(
    create([file]).automatic(
      request,
      fingerprint,
      "publickey",
      "primary",
      endpoint,
    ),
    "fixture-passphrase",
  );
  for (const identities of [
    [file, file.replace("first-key", "second-key")],
    [file, "~/.ssh/unknown"],
    undefined,
  ])
    assert.equal(
      create(identities).automatic(
        request,
        fingerprint,
        "publickey",
        "primary",
        endpoint,
      ),
      null,
    );
});

test("a UTF-8 character truncated at byte 100 still resolves only the selected identity", (t) => {
  const { vault } = fixture(t);
  const base = path.resolve(".tools") + path.sep;
  const file = base + "a".repeat(99 - Buffer.byteLength(base)) + "中文密钥";
  const keyId = "657ac171-2345-4321-abcd-12abcdef7890";
  const hint = Buffer.from(file).subarray(0, 100).toString("utf8");
  assert(hint.endsWith("\ufffd"));
  const broker = new SshCredentials({
    vault,
    target: "profile",
    endpoint: { ...endpoint, identityFiles: [file] },
    launch: { keyId, identityFile: file },
  });
  vault.put(
    "profile",
    "passphrase",
    "fixture-passphrase",
    endpoint,
    keyId,
    fingerprint,
  );
  assert.equal(
    broker.automatic(
      { kind: "passphrase", key: hint },
      fingerprint,
      "publickey",
      "primary",
      endpoint,
    ),
    "fixture-passphrase",
  );
});

test("ConPTY soft-wrapped private-key prompts retain the full path", () => {
  const file =
    "D:\\isolated folder\\" +
    "long-path\\".repeat(9) +
    "key-657ac171-2345-4321-abcd-12abcdef7890";
  const prompt = `Enter passphrase for key '${file}':`;
  const wrapped = prompt.slice(0, 100) + "\r\n" + prompt.slice(100);
  assert.equal(detectPrompt(wrapped).key, file);
  assert.equal(detectPrompt(wrapped).prompt, prompt);
});

test("raw ConPTY scrolling and wrap-column repaint preserve the selected key prompt", () => {
  const file =
    "D:\\isolated folder\\" + "long-path\\".repeat(6) + "key-657ac171";
  const text = `Enter passphrase for key '${file}':`;
  const prefix = "\x1b[2J\x1b[H" + "debug1: fixture diagnostic\r\n".repeat(40);
  const raw =
    prefix +
    text.slice(0, 100) +
    "\r\n\x1b[31;100H" +
    text.slice(99) +
    "\x1b[1C";
  assert.equal(detectPrompt(raw, 100, 32).key, file);
  let receive;
  const prompts = [],
    output = [];
  const session = new PtySession({
    waitForData: false,
    onPrompt: (prompt) => prompt && prompts.push(prompt),
    onData: (data) => output.push(data),
    spawn: () => ({
      onData: (callback) => {
        receive = callback;
      },
      onExit() {},
      write() {},
      resize() {},
    }),
  });
  session.start({ file: "fixture", args: [], cols: 100, rows: 32 });
  for (let i = 0; i < raw.length; i += 17) receive(raw.slice(i, i + 17));
  assert.equal(prompts.at(-1).key, file);
  assert.equal(output.join(""), raw);
  session.dispose();
});

test("wide path characters and a wrap-ending space are retained", () => {
  const file = "D:\\用户\\" + "a".repeat(60) + " \\key";
  const prompt = `Enter passphrase for key '${file}':`;
  const chars = [...prompt];
  let width = 0,
    cut = 0;
  while (width < 98) width += /[用户]/u.test(chars[cut++]) ? 2 : 1;
  const raw =
    "\x1b[32;1H" +
    chars.slice(0, cut).join("") +
    "\r\n\x1b[31;98H" +
    chars.slice(cut - 1).join("");
  assert.equal(detectPrompt(raw, 98, 32).key, file);
});

test("wide-character wrap padding is resolved only against a unique configured key", (t) => {
  const { vault } = fixture(t);
  const prefix = "Enter passphrase for key '";
  const directory = path.resolve(".tools/") + path.sep;
  const first = directory + "x".repeat(99 - prefix.length - directory.length);
  const file = first + "中文密钥";
  const display = prefix + first + " \r\n\x1b[31;100H 中文密钥':";
  const request = detectPrompt("\x1b[32;1H" + display, 100, 32);
  assert.equal(request.key, first + " 中文密钥");
  assert(request.keyHints.includes(file));
  const keyId = "657ac171-2345-4321-abcd-12abcdef7890";
  vault.put(
    "profile",
    "passphrase",
    "fixture-passphrase",
    endpoint,
    keyId,
    fingerprint,
  );
  const broker = (identities) =>
    new SshCredentials({
      vault,
      target: "profile",
      endpoint: { ...endpoint, identityFiles: identities },
      launch: { keyId, identityFile: file },
    });
  assert.equal(
    broker([file]).automatic(
      request,
      fingerprint,
      "publickey",
      "primary",
      endpoint,
    ),
    "fixture-passphrase",
  );
  assert.equal(
    broker([file, first + " 中文密钥"]).automatic(
      request,
      fingerprint,
      "publickey",
      "primary",
      endpoint,
    ),
    null,
  );
});

test("unavailable encryption and malformed vaults fail without replacing originals", (t) => {
  const { file, vault, inspect } = fixture(t);
  const disabled = new CredentialVault(
    file,
    { isEncryptionAvailable: () => false },
    inspect,
  );
  assert.throws(
    () => disabled.put("profile", "password", "secret", endpoint),
    /加密存储不可用/,
  );
  assert(!fs.existsSync(file));
  for (const value of [
    "broken",
    JSON.stringify({ version: 2, credentials: {}, keys: [] }),
    JSON.stringify({ version: 1, credentials: { test: null }, keys: [] }),
  ]) {
    fs.writeFileSync(file, value);
    assert.throws(() => vault.put("profile", "password", "secret", endpoint));
    assert.equal(fs.readFileSync(file, "utf8"), value);
  }
});

test("file references remain intact; encrypted imports use refcounted private runtime files", async (t) => {
  const { directory, file, vault } = fixture(t);
  const privateText =
    "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-only\n-----END OPENSSH PRIVATE KEY-----\n";
  const reference = path.join(directory, "reference-key");
  fs.writeFileSync(reference, privateText);
  const ref = await vault.addKey({ source: "file", file: reference });
  const imported = await vault.addKey({
    source: "import",
    name: "fixture",
    content: privateText,
  });
  assert(!fs.readFileSync(file, "utf8").includes("BEGIN OPENSSH"));
  assert(!JSON.stringify(vault.listKeys()).includes("encrypted"));
  const a = vault.acquire(imported.id),
    b = vault.acquire(imported.id);
  assert.equal(a.file, b.file);
  assert.equal(fs.readFileSync(a.file, "utf8"), privateText);
  assert.throws(() => vault.removeKey(imported.id), /运行中的连接/);
  a.release();
  assert(fs.existsSync(b.file));
  b.release();
  assert(!fs.existsSync(a.file));
  b.release();
  vault.removeKey(imported.id);
  vault.removeKey(ref.id);
  assert.equal(fs.readFileSync(reference, "utf8"), privateText);
  const newRef = await vault.addKey({ source: "file", file: reference });
  fs.appendFileSync(reference, "changed");
  assert.throws(() => vault.acquire(newRef.id), /文件已变化/);
  const keep = path.join(vault.runtime, "unrelated-note.txt");
  fs.writeFileSync(keep, "keep");
  const stale = path.join(
    vault.runtime,
    "key-657ac171-2345-4321-abcd-12abcdef7890",
  );
  fs.writeFileSync(stale, "stale");
  vault.cleanupStale();
  assert(!fs.existsSync(stale));
  assert(fs.existsSync(keep));
  const restarted = new CredentialVault(file, encryption, async () => ({
    type: "ssh-ed25519",
    fingerprint,
    protected: true,
  }));
  restarted.cleanupStale();
  assert(fs.existsSync(keep));
});

test("session registry retains imported key leases until auxiliary processes stop", async () => {
  let finish,
    released = 0;
  const stopped = new Promise((resolve) => {
    finish = resolve;
  });
  const registry = new SessionRegistry({});
  const entry = {
    id: "test",
    services: { close: () => stopped },
    keyLease: { release: () => released++ },
  };
  registry.entries.set(entry.id, entry);
  registry.release(entry);
  assert.equal(registry.entries.size, 0);
  assert.equal(released, 0);
  finish();
  await Promise.resolve();
  assert.equal(released, 1);
});

const hopEndpoint = { host: "bastion.example", port: 22, user: "jump" };
const hopPrompt = { kind: "password", prompt: "jump@bastion.example's password:" };
const hopFingerprint = "SHA256:HOPFIXTURE";
function jumpBroker(vault) {
  return new SshCredentials({
    vault,
    target: "profile",
    endpoint: { ...endpoint, viaProxy: true },
    launch: { jumpHost: "jump@bastion.example:22" },
    hops: [{ target: "hop", label: "堡垒机", endpoint: hopEndpoint, launch: {} }],
    label: "节点",
  });
}

test("each saved jump host answers with its own secret and never with another's", (t) => {
  const { vault } = fixture(t);
  vault.put("profile", "password", "target-secret", endpoint);
  vault.put("hop", "password", "hop-secret", hopEndpoint);
  const broker = jumpBroker(vault);
  assert.equal(broker.automatic(hopPrompt, hopFingerprint, "password", "primary", hopEndpoint), "hop-secret");
  // The destination's account asked by the jump host's handshake, and the
  // jump host's account asked by the destination's, belong to nobody.
  assert.equal(broker.automatic(prompt, hopFingerprint, "password", "primary", hopEndpoint), null);
  assert.equal(broker.automatic(hopPrompt, fingerprint, "password", "primary", endpoint), null);
  assert.equal(broker.automatic(prompt, fingerprint, "password", "primary", endpoint), "target-secret");
  broker.authenticated();
  const bound = Object.fromEntries(Object.values(vault.read().credentials).map((item) => [item.target, item.fingerprint]));
  assert.deepEqual(bound, { profile: fingerprint, hop: hopFingerprint });
  // A hop answer that failed is tried once and then invalidated for that hop only.
  const retry = jumpBroker(vault);
  assert.equal(retry.automatic(hopPrompt, hopFingerprint, "password", "primary", hopEndpoint), "hop-secret");
  assert.equal(retry.automatic(hopPrompt, hopFingerprint, "password", "primary", hopEndpoint), null);
  assert.equal(vault.status("hop").password, "needs-update");
  assert.equal(vault.status("profile").password, "saved");
});

test("a secret typed for a jump host is saved under that host once the destination authenticates", (t) => {
  const { vault } = fixture(t);
  const broker = jumpBroker(vault);
  assert.equal(broker.remember(hopPrompt, "typed-hop-secret", hopFingerprint, "password", true, "primary", "primary", hopEndpoint), true);
  assert.equal(vault.status("hop").password, "none");
  broker.authenticated();
  assert.equal(vault.get("hop", "password", hopEndpoint, "", hopFingerprint), "typed-hop-secret");
  assert.equal(vault.status("profile").password, "none");
});

test("prompts name the jump host that asks", (t) => {
  const { vault } = fixture(t);
  const broker = jumpBroker(vault);
  assert.deepEqual(broker.asking(hopPrompt, hopEndpoint), { asking: "跳板机 堡垒机 · jump@bastion.example:22", jump: true });
  assert.deepEqual(broker.asking(prompt, endpoint), { asking: "节点 · operator@node.example:2222", jump: false });
  // Before the handshake line is read, the password prompt's account decides.
  assert.deepEqual(broker.asking(hopPrompt, undefined), { asking: "跳板机 堡垒机 · jump@bastion.example:22", jump: true });
  // A free-form jump host is named by its address.
  const relay = { host: "relay.example", port: 2200, user: "relay" };
  assert.deepEqual(broker.asking({ kind: "password", prompt: "relay@relay.example's password:" }, relay), { asking: "跳板机 relay@relay.example:2200", jump: true });
});

test("saved jump hosts resolve into one -J chain with each hop's own scope", (t) => {
  const { directory } = fixture(t);
  const { HostProfiles } = require("../../electron/host-profiles.cjs");
  const profiles = new HostProfiles(path.join(directory, "ssh-hosts.json"));
  const save = (profile) => profiles.save(profile, profiles.read().revision).profile;
  const outer = save({ name: "外层", hostname: "outer.example", user: "o", port: 2201, authMode: "password", jumpHost: "corp-gw" });
  const inner = save({ name: "内层", hostname: "fe80::1", user: "i", authMode: "password", jumpHostId: outer.id });
  const target = save({ name: "目标", hostname: "node.example", user: "operator", port: 2222, authMode: "password", connectTimeout: 10, jumpHostId: inner.id });
  const resolved = profiles.resolve({ target: "rhine-profile:" + target.id });
  assert(resolved.ok, resolved.error);
  assert.equal(resolved.launch.jumpHost, "corp-gw,o@outer.example:2201,i@[fe80::1]");
  assert.equal(resolved.launch.connectTimeout, undefined);
  assert.deepEqual(resolved.hops.map((hop) => [hop.target, hop.label, hop.launch.target, hop.launch.user]),
    [["rhine-profile:" + outer.id, "外层", "outer.example", "o"], ["rhine-profile:" + inner.id, "内层", "fe80::1", "i"]]);
  assert.equal(resolved.jumpAlias, "rhine-profile:" + inner.id);
  assert.match(profiles.entries().hosts.find((host) => host.profile.id === target.id).raw, /^ProxyJump corp-gw → 外层 → 内层$/m);
  // A temporary connection may go through a saved jump host too.
  const quick = profiles.resolve({ target: "admin@quick.example", jumpHostId: outer.id, connectTimeout: 9 });
  assert.equal(quick.launch.jumpHost, "corp-gw,o@outer.example:2201");
  assert.equal(quick.hops.length, 1);
  // A free-form jump host naming a saved one is that saved host.
  const named = save({ name: "按名称", hostname: "named.example", jumpHost: "外层" });
  assert.equal(profiles.resolve({ target: "rhine-profile:" + named.id }).launch.jumpHost, "corp-gw,o@outer.example:2201");
  const addressed = save({ name: "按地址", hostname: "addressed.example", jumpHost: "o@outer.example:2201" });
  assert.equal(profiles.resolve({ target: "rhine-profile:" + addressed.id }).hops[0].label, "外层");
});

test("the jump host next to the destination brings its own key through a ProxyCommand", (t) => {
  const { directory } = fixture(t);
  const { HostProfiles } = require("../../electron/host-profiles.cjs");
  const { buildSshArgs, resolveSshPath } = require("../../electron/ssh-args.cjs");
  const profiles = new HostProfiles(path.join(directory, "ssh-hosts.json"));
  const save = (profile) => profiles.save(profile, profiles.read().revision).profile;
  const outer = save({ name: "外层", hostname: "outer.example", user: "o" });
  const keyed = save({ name: "带钥", hostname: "keyed.example", user: "k", port: 2202, authMode: "key", identityFile: "C:/keys 100%/hop key", jumpHostId: outer.id });
  const target = save({ name: "目标", hostname: "node.example", user: "operator", authMode: "password", jumpHostId: keyed.id });
  const resolved = profiles.resolve({ target: "rhine-profile:" + target.id });
  assert.deepEqual(resolved.hops.map((hop) => [hop.label, hop.proxy ?? false, hop.launch.identityFile]),
    [["外层", false, undefined], ["带钥", true, "C:/keys 100%/hop key"]]);
  const args = buildSshArgs(resolved.launch, { config: "C:/cfg/ssh config" });
  assert(!args.includes("-J"));
  assert.equal(args.find((value) => value.startsWith("ProxyCommand=")),
    `ProxyCommand="${resolveSshPath()}" -F "C:/cfg/ssh config" -v -i "C:/keys 100%%/hop key" -o IdentitiesOnly=yes -l k -p 2202 -J o@outer.example -W [%h]:%p keyed.example`);
  // A vault key waits for the session's lease; until then the hop still goes through -J.
  const vaultKeyed = save({ ...keyed, identityFile: undefined, keyId: "657ac171-2345-4321-abcd-12abcdef7890" });
  const leased = profiles.resolve({ target: "rhine-profile:" + target.id });
  assert.equal(vaultKeyed.keyId, leased.launch.proxyHop.keyId);
  const unleased = buildSshArgs(leased.launch);
  assert(!unleased.some((value) => value.startsWith("ProxyCommand=")));
  assert.equal(unleased[unleased.indexOf("-J") + 1], "o@outer.example,k@keyed.example:2202");
  assert.equal(leased.hops[1].launch.keyId, vaultKeyed.keyId);
  // A password hop never runs as a ProxyCommand, whatever its key file.
  save({ ...vaultKeyed, keyId: undefined, identityFile: "C:/keys/unused", authMode: "password" });
  assert.equal(profiles.resolve({ target: "rhine-profile:" + target.id }).launch.proxyHop, undefined);
});

test("jump chains refuse loops, a fourth hop, missing hosts and removing a host in use", (t) => {
  const { directory } = fixture(t);
  const { HostProfiles } = require("../../electron/host-profiles.cjs");
  const file = path.join(directory, "ssh-hosts.json");
  const profiles = new HostProfiles(file);
  const save = (profile) => profiles.save(profile, profiles.read().revision).profile;
  const a = save({ name: "A", hostname: "a.example" });
  const b = save({ name: "B", hostname: "b.example", jumpHostId: a.id });
  assert.throws(() => save({ ...a, jumpHostId: b.id }), /循环/);
  assert.throws(() => save({ ...a, jumpHostId: a.id }), /自己/);
  const c = save({ name: "C", hostname: "c.example", jumpHostId: b.id });
  const d = save({ name: "D", hostname: "d.example", jumpHostId: c.id });
  assert.equal(profiles.resolve({ target: "rhine-profile:" + d.id }).hops.length, 3);
  assert.throws(() => save({ name: "E", hostname: "e.example", jumpHostId: d.id }), /超过 3 跳/);
  assert.throws(() => profiles.remove(a.id, profiles.read().revision), /「B」经由这台主机跳转/);
  // A reference broken outside the app is reported when connecting.
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.profiles = data.profiles.filter((profile) => profile.id !== a.id);
  fs.writeFileSync(file, JSON.stringify(data));
  const broken = profiles.resolve({ target: "rhine-profile:" + b.id });
  assert.equal(broken.ok, false);
  assert.match(broken.error, /「B」的跳板机已不在主机档案中/);
});
