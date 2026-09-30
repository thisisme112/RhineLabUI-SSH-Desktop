import { deflateRawSync, inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";

export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const table = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
export function safeName(name) {
  if (!name || name.includes("\\") || name.includes(":") || name.includes("\0") || name.startsWith("/") || name.split("/").some(p => !p || p === "." || p === "..")) throw new Error(`Unsafe package path: ${name}`);
  return name;
}
/** Deterministic ZIP with regular files, UTF-8 names and no machine metadata. */
export function writeZip(files) {
  const chunks = [], central = []; let offset = 0;
  for (const [name, raw] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    safeName(name); const label = Buffer.from(name), data = deflateRawSync(raw), crc = crc32(raw);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(label.length, 26);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8); record.writeUInt16LE(8, 10); record.writeUInt16LE(33, 14); record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(raw.length, 24); record.writeUInt16LE(label.length, 28); record.writeUInt32LE(offset, 42);
    chunks.push(local, label, data); central.push(record, label); offset += local.length + label.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}
export function readZip(bytes) {
  const end = bytes.length - 22;
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 20)) throw new Error("Unsupported or truncated shared ZIP");
  const count = bytes.readUInt16LE(end + 10), directorySize = bytes.readUInt32LE(end + 12); let at = bytes.readUInt32LE(end + 16), total = 0;
  if (at + directorySize !== end || count > 10000) throw new Error("Invalid shared ZIP directory");
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) throw new Error("Invalid ZIP entry");
    const flags = bytes.readUInt16LE(at + 8), method = bytes.readUInt16LE(at + 10), crc = bytes.readUInt32LE(at + 16), compressed = bytes.readUInt32LE(at + 20), size = bytes.readUInt32LE(at + 24), length = bytes.readUInt16LE(at + 28), extra = bytes.readUInt16LE(at + 30), comment = bytes.readUInt16LE(at + 32), offset = bytes.readUInt32LE(at + 42);
    const name = safeName(bytes.subarray(at + 46, at + 46 + length).toString("utf8"));
    if (flags !== 0x800 || method !== 8 || files.has(name) || (bytes.readUInt32LE(at + 38) >>> 16 & 0xf000) === 0xa000 || size > 256 * 1024 * 1024 || (total += size) > 1024 * 1024 * 1024) throw new Error("Unsupported, duplicate or oversized ZIP entry");
    if (offset + 30 > bytes.readUInt32LE(end + 16) || bytes.readUInt32LE(offset) !== 0x04034b50) throw new Error("Invalid ZIP local header");
    const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    if (start + compressed > bytes.readUInt32LE(end + 16)) throw new Error("ZIP data exceeds archive");
    const data = inflateRawSync(bytes.subarray(start, start + compressed), { maxOutputLength: size + 1 });
    if (data.length !== size || crc32(data) !== crc) throw new Error(`ZIP checksum mismatch: ${name}`);
    files.set(name, data); at += 46 + length + extra + comment;
  }
  if (at !== end) throw new Error("ZIP directory length mismatch");
  return files;
}
export function validatePackage(files, lock) {
  const manifest = JSON.parse(files.get("manifest.json")?.toString() ?? "null");
  if (!manifest || manifest.schemaVersion !== 1 || manifest.protocol !== 1 || manifest.version !== lock.version || manifest.sourceCommit !== lock.sourceCommit) throw new Error("Shared package version/source/protocol mismatch");
  if (!manifest.files || Object.keys(manifest.files).length + 1 !== files.size) throw new Error("Shared package file list mismatch");
  for (const [name, entry] of Object.entries(manifest.files)) {
    safeName(name); const bytes = files.get(name);
    if (!bytes || bytes.length !== entry.size || sha256(bytes) !== entry.sha256) throw new Error(`Shared file hash mismatch: ${name}`);
  }
  return manifest;
}
