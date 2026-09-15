import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
const require = createRequire(import.meta.url);
const { validateLaunch, buildSshArgs } = require("../electron/ssh-args.cjs");
const { parseHostConfig } = require("../electron/ssh-config.cjs");
const { pruneRecords, recordPath } = require("../electron/session-records.cjs");

const hosts = parseHostConfig(
  'Host alpha beta\n HostName fixture.internal\n User operator\n Port 2222\n IdentityFile "C:/key path/id"\nMatch all\n User wrong\nHost *\n Port 22\nHost alpha\n User override\n',
);
assert.equal(hosts.length, 2);
for (const host of hosts) {
  assert.equal(host.hostname, "fixture.internal");
  assert.equal(host.user, "operator");
  assert.equal(host.port, "2222");
  assert.equal(host.identityFile, "C:/key path/id");
  assert.match(host.raw, /HostName fixture.internal/);
}
for (const extraArgs of [
  ["other-host", "command"],
  ["-L"],
  ["-p", "0"],
  ["-p", "-N"],
  ["-o"],
  ["-o", "ProxyCommand=anything"],
  ["-o", "LocalCommand=anything"],
  ["-o", "RemoteCommand=anything"],
  ["-F", "other-config"],
  ["-q"],
  ["-E", "elsewhere"],
])
  assert.equal(
    validateLaunch({ target: "host", extraArgs }).ok,
    false,
    String(extraArgs),
  );
assert.equal(validateLaunch({ target: "host\0" }).ok, false);
assert.equal(
  validateLaunch({ target: "host", identityFile: "path\ncommand" }).ok,
  false,
);
const valid = validateLaunch({
  target: "user@[::1]",
  extraArgs: ["-L", "8080:localhost:80", "-o", "ConnectTimeout=10", "-N"],
});
assert.equal(valid.ok, true);
assert.equal(
  buildSshArgs({ ...valid.launch, logPath: "events.log" }).at(-1),
  "user@[::1]",
);

const dir = fs.mkdtempSync(path.join(tmpdir(), "rhine-record-check-"));
const now = Date.now();
function pair(id, age, legacy = false) {
  const log = path.join(dir, id + ".log");
  const json = path.join(
    dir,
    id + (legacy ? "-different-stamp" : "") + ".json",
  );
  fs.writeFileSync(log, "example diagnostic\n");
  fs.writeFileSync(json, JSON.stringify({ logPath: log }));
  for (const file of [log, json])
    fs.utimesSync(file, (now - age) / 1000, (now - age) / 1000);
  return { log, json };
}
try {
  const old = pair("old", 31 * 86400000, true);
  const current = pair("current", 40 * 86400000);
  const recent = pair("recent", 1000);
  const unrelated = path.join(dir, "keep.txt");
  fs.writeFileSync(unrelated, "not an app record");
  const result = pruneRecords(dir, { now, exclude: [current.log] });
  assert.equal(result.removed, 1);
  assert.ok(
    !fs.existsSync(old.log) && !fs.existsSync(old.json),
    "legacy pairs age out together",
  );
  assert.ok(
    fs.existsSync(current.log) && fs.existsSync(current.json),
    "never prune the live session",
  );
  assert.ok(fs.existsSync(recent.log));
  pair("older-recent", 2000);
  assert.equal(pruneRecords(dir, { now, sessions: 1 }).removed, 2);
  assert.ok(fs.existsSync(recent.log), "count policy keeps the newest session");
  assert.equal(pruneRecords(dir, { now, bytes: 1 }).removed, 1);
  assert.ok(fs.existsSync(unrelated), "only app record extensions qualify");
  assert.throws(() => recordPath(dir, path.join(dir, "..", "outside.json")));
  assert.throws(() => recordPath(dir, unrelated));
} finally {
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(tmpdir()));
  assert.ok(path.basename(dir).startsWith("rhine-record-check-"));
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(
  "SSH host aliases, launch options, record paths and retention checks passed.",
);
