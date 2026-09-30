import test from "node:test";
import assert from "node:assert/strict";
import { readZip, writeZip, safeName, sha256, validatePackage } from "../lib/shared-package.mjs";
const make = () => {
  const data = Buffer.from("终端\n"), version = "1.0.2-shared.1", sourceCommit = "a".repeat(40);
  const manifest = { schemaVersion: 1, protocol: 1, version, sourceCommit, files: { "models/sample.txt": { size: data.length, sha256: sha256(data) } } };
  return { files: new Map([["models/sample.txt", data], ["manifest.json", Buffer.from(JSON.stringify(manifest))]]), lock: { version, sourceCommit }, manifest };
};
test("shared archives reproduce exact bytes and preserve Unicode", () => {
  const { files, lock } = make(), bytes = writeZip(files);
  assert.deepEqual(writeZip(files), bytes); const decoded = readZip(bytes);
  assert.equal(decoded.get("models/sample.txt").toString(), "终端\n"); assert.equal(validatePackage(decoded, lock).protocol, 1);
});
test("corruption, truncation and file substitution fail verification", () => {
  const { files, lock } = make(), bytes = writeZip(files);
  assert.throws(() => readZip(bytes.subarray(0, -2))); bytes[45] ^= 1; assert.throws(() => readZip(bytes));
  files.set("models/sample.txt", Buffer.from("changed")); assert.throws(() => validatePackage(files, lock), /hash mismatch/);
});
test("unsupported protocol, different source and unlisted files fail", () => {
  const { files, lock, manifest } = make(); assert.throws(() => validatePackage(files, { ...lock, sourceCommit: "b".repeat(40) }));
  manifest.protocol = 2; files.set("manifest.json", Buffer.from(JSON.stringify(manifest))); assert.throws(() => validatePackage(files, lock));
  manifest.protocol = 1; files.set("manifest.json", Buffer.from(JSON.stringify(manifest))); files.set("extra", Buffer.from("x")); assert.throws(() => validatePackage(files, lock));
});
test("paths escaping the installation directory are rejected", () => {
  for (const name of ["../outside", "/outside", "C:/outside", "a\\b", "a/../b", "a//b"]) assert.throws(() => safeName(name));
});
