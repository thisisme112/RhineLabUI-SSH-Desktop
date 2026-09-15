import type { EncryptedCredentials, PortableSecrets } from "../migration-types";
import { validPortableSecrets } from "../migration-types";
const aad = new TextEncoder().encode("rhine.ssh.credentials.v1");
const base64 = (bytes: Uint8Array) => {
  let s = "";
  for (let offset = 0; offset < bytes.length; offset += 32768)
    s += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(s);
};
const bytes = (value: string) =>
  Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));
async function derive(password: string, salt: Uint8Array) {
  if (password.length < 8 || password.length > 1024)
    throw new Error("备份密码需要 8–1024 个字符");
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt.buffer as ArrayBuffer,
      iterations: 210000,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function encryptCredentials(
  value: PortableSecrets,
  password: string,
): Promise<EncryptedCredentials> {
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  if (plaintext.byteLength > 8 * 1024 * 1024)
    throw new Error("凭据备份超过 8 MiB");
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    await derive(password, salt),
    plaintext,
  );
  plaintext.fill(0);
  return {
    version: 1,
    kdf: "PBKDF2-SHA256",
    iterations: 210000,
    salt: base64(salt),
    iv: base64(iv),
    data: base64(new Uint8Array(data)),
  };
}
export async function decryptCredentials(
  packet: EncryptedCredentials,
  password: string,
): Promise<PortableSecrets> {
  if (
    !packet ||
    packet.version !== 1 ||
    packet.kdf !== "PBKDF2-SHA256" ||
    packet.iterations !== 210000 ||
    typeof packet.data !== "string" ||
    packet.data.length > 12 * 1024 * 1024
  )
    throw new Error("加密凭据格式无效");
  const salt = bytes(packet.salt),
    iv = bytes(packet.iv);
  if (salt.length !== 16 || iv.length !== 12) throw new Error("加密参数无效");
  let raw: ArrayBuffer;
  try {
    raw = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      await derive(password, salt),
      bytes(packet.data),
    );
  } catch {
    throw new Error("备份密码错误或文件已损坏");
  }
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(raw),
    );
    if (!validPortableSecrets(value)) throw new Error("凭据内容格式无效");
    return value;
  } finally {
    new Uint8Array(raw).fill(0);
  }
}
