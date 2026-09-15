import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const require = createRequire(import.meta.url);
const {
  HostProfiles,
  keyFor,
  normalizeProfile,
} = require("../electron/host-profiles.cjs");
const { validateLaunch, buildSshArgs } = require("../electron/ssh-args.cjs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rhine-host-profiles-"));
const file = path.join(dir, "ssh-hosts.json");
const store = new HostProfiles(file);
try {
  assert.deepEqual(store.read(), { profiles: [], revision: "empty" });
  const source = {
    name: "开发服务器",
    hostname: "::1",
    user: "operator",
    port: 2222,
    identityFile: "C:/keys with spaces/开发.pem",
    jumpHost: "jump@bastion:2200",
    connectTimeout: 12,
    keepAliveInterval: 0,
    keepAliveCountMax: 5,
    password: "DO_NOT_STORE_THIS",
    privateKey: "DO_NOT_STORE_THIS",
    extraArgs: ["-N"],
  };
  const saved = store.save(source, "empty");
  const key = keyFor(saved.profile.id);
  assert.equal(store.entries().hosts[0].alias, key);
  assert.equal(store.entries().hosts[0].displayName, source.name);
  assert.deepEqual(
    new HostProfiles(file).read(),
    store.read(),
    "profiles survive a fresh application instance",
  );
  const text = fs.readFileSync(file, "utf8");
  assert.ok(
    !text.includes("DO_NOT_STORE_THIS") && !text.includes("extraArgs"),
    "only connection fields are persisted",
  );
  const renamed = store.save(
    { ...saved.profile, name: "开发服务器 · 更名" },
    saved.revision,
  );
  assert.equal(
    renamed.profile.id,
    saved.profile.id,
    "renaming keeps the archive and history key",
  );
  assert.equal(store.entries().hosts[0].alias, key);
  const afterRename = fs.readFileSync(file, "utf8");
  assert.throws(
    () =>
      store.write(
        Array.from({ length: 256 }, () => ({
          ...renamed.profile,
          identityFile: "C:/" + "密".repeat(4000),
        })),
      ),
    /超过 2 MiB/,
  );
  assert.equal(
    fs.readFileSync(file, "utf8"),
    afterRename,
    "oversized writes cannot create an unreadable store",
  );
  assert.throws(() => store.save(saved.profile, saved.revision), /已更新/);
  assert.throws(() => store.remove(saved.profile.id, saved.revision), /已更新/);
  assert.equal(
    fs.readFileSync(file, "utf8"),
    afterRename,
    "stale editors cannot overwrite newer data",
  );
  const resolved = store.resolve({
    target: key,
    port: 9999,
    extraArgs: ["-N"],
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.displayTarget, renamed.profile.name);
  assert.deepEqual(
    buildSshArgs(resolved.launch),
    [
      "-v",
      "-l",
      "operator",
      "-p",
      "2222",
      "-i",
      source.identityFile,
      "-J",
      source.jumpHost,
      "-o",
      "ConnectTimeout=12",
      "-o",
      "ServerAliveInterval=0",
      "-o",
      "ServerAliveCountMax=5",
      "::1",
    ],
    "saved host identifiers resolve to actual system SSH arguments",
  );
  const quick = validateLaunch({
    target: "user@[::1]",
    port: 2200,
    keepAliveInterval: 0,
  });
  assert.equal(quick.ok, true);
  assert.deepEqual(buildSshArgs(quick.launch), [
    "-v",
    "-p",
    "2200",
    "-o",
    "ServerAliveInterval=0",
    "user@[::1]",
  ]);
  for (const bad of [
    { user: "root;command" },
    { user: "user\nline" },
    { jumpHost: "-F other" },
    { jumpHost: "bastion,,second" },
    { jumpHost: "bastion;command" },
    { connectTimeout: 0 },
    { connectTimeout: 601 },
    { keepAliveInterval: -1 },
    { keepAliveInterval: 3601 },
    { keepAliveCountMax: 0 },
    { keepAliveCountMax: 31 },
    { port: 65536 },
    { identityFile: "file\nother" },
    { port: true },
    { port: null },
    { connectTimeout: false },
    { keepAliveInterval: null },
    { keepAliveInterval: " " },
    { keepAliveCountMax: [] },
    { identityFile: true },
  ])
    assert.equal(
      validateLaunch({ target: "host", ...bad }).ok,
      false,
      JSON.stringify(bad),
    );
  for (const bad of [
    { ...source, name: "" },
    { ...source, name: "bad\nname" },
    { ...source, hostname: "-o" },
    { ...source, hostname: key },
    { ...source, id: "../file" },
  ])
    assert.throws(() => normalizeProfile(bad));
  store.remove(saved.profile.id, renamed.revision);
  assert.equal(store.read().profiles.length, 0);
  assert.equal(
    store.resolve({ target: key }).ok,
    false,
    "removed host cannot silently connect elsewhere",
  );
  fs.writeFileSync(file, "invalid JSON", "utf8");
  assert.throws(() => store.save(source, "empty"), /损坏/);
  assert.equal(
    fs.readFileSync(file, "utf8"),
    "invalid JSON",
    "a damaged store is never replaced with an empty one",
  );
  fs.writeFileSync(file, "null", "utf8");
  assert.throws(() => store.read(), /格式不受支持/);
  assert.equal(fs.readFileSync(file, "utf8"), "null");
  assert.deepEqual(
    fs.readdirSync(dir),
    ["ssh-hosts.json"],
    "no temporary saves remain",
  );
  console.log(
    "SSH profile persistence, stable identity, stale edits, secret exclusion and launch checks passed.",
  );
} finally {
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dir).startsWith("rhine-host-profiles-"));
  fs.rmSync(dir, { recursive: true, force: true });
}
