import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
const require = createRequire(import.meta.url);
const { CredentialVault } = require("../electron/credential-vault.cjs");
const { SshCredentials } = require("../electron/ssh-credentials.cjs");
const { SessionRegistry } = require("../electron/session-registry.cjs");
const { PtySession, detectPrompt } = require("../electron/session.cjs");

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
