"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const pbkdf2 = promisify(crypto.pbkdf2);
const aad = Buffer.from("rhine.ssh.credentials.v1");
const text = (v, max) =>
  typeof v === "string" && v.length <= max && !v.includes("\0");
function validate(value) {
  if (
    !value ||
    value.version !== 1 ||
    !Array.isArray(value.keys) ||
    value.keys.length > 256 ||
    !Array.isArray(value.credentials) ||
    value.credentials.length > 1024 ||
    value.keys.some(
      (k) =>
        !k ||
        !text(k.id, 1024) ||
        !k.id ||
        !text(k.name, 80) ||
        !text(k.privateKey, 131072) ||
        !k.privateKey ||
        (k.passphrase !== undefined && !text(k.passphrase, 16384)),
    ) ||
    new Set(value.keys.map((k) => k.id)).size !== value.keys.length ||
    value.credentials.some(
      (c) =>
        !c ||
        !text(c.target, 1024) ||
        !c.target ||
        !["password", "passphrase"].includes(c.kind) ||
        !text(c.value, 16384) ||
        !c.value ||
        /[\r\n]/.test(c.value) ||
        !text(c.host, 253) ||
        !Number.isInteger(c.port) ||
        c.port < 1 ||
        c.port > 65535 ||
        !text(c.user, 128) ||
        (c.keyId !== undefined && !text(c.keyId, 1024)) ||
        (c.fingerprint !== undefined &&
          (!text(c.fingerprint, 256) ||
            (c.fingerprint &&
              !/^SHA256:[A-Za-z0-9+/=]{1,128}$/.test(c.fingerprint)))),
    )
  )
    throw new Error("凭据内容格式无效");
}
async function derive(password, salt) {
  if (!text(password, 1024) || password.length < 8)
    throw new Error("备份密码需要 8–1024 个字符");
  return pbkdf2(password, salt, 210000, 32, "sha256");
}
async function encrypt(value, password) {
  const salt = crypto.randomBytes(16),
    iv = crypto.randomBytes(12),
    key = await derive(password, salt);
  const plain = Buffer.from(JSON.stringify(value));
  if (plain.length > 8 * 1024 * 1024) throw new Error("凭据备份超过 8 MiB");
  try {
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    const data = Buffer.concat([
      cipher.update(plain),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return {
      version: 1,
      kdf: "PBKDF2-SHA256",
      iterations: 210000,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      data: data.toString("base64"),
    };
  } finally {
    plain.fill(0);
    key.fill(0);
  }
}
async function decrypt(packet, password) {
  if (
    !packet ||
    packet.version !== 1 ||
    packet.kdf !== "PBKDF2-SHA256" ||
    packet.iterations !== 210000 ||
    !text(packet.data, 12 * 1024 * 1024) ||
    !text(packet.salt, 64) ||
    !text(packet.iv, 64)
  )
    throw new Error("加密凭据格式无效");
  const salt = Buffer.from(packet.salt, "base64"),
    iv = Buffer.from(packet.iv, "base64"),
    data = Buffer.from(packet.data, "base64");
  if (salt.length !== 16 || iv.length !== 12 || data.length < 16)
    throw new Error("加密参数无效");
  const key = await derive(password, salt);
  let raw;
  try {
    const cipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    cipher.setAuthTag(data.subarray(-16));
    raw = Buffer.concat([cipher.update(data.subarray(0, -16)), cipher.final()]);
    const value = JSON.parse(raw.toString("utf8"));
    validate(value);
    return value;
  } catch {
    throw new Error("备份密码错误或文件已损坏");
  } finally {
    key.fill(0);
    raw?.fill(0);
  }
}
class SshMigration {
  constructor(vault, profiles, endpoint) {
    this.vault = vault;
    this.profiles = profiles;
    this.endpoint = endpoint;
    this.tickets = new Map();
  }
  async describeHosts(targets) {
    if (
      !Array.isArray(targets) ||
      targets.length > 512 ||
      !targets.every((t) => text(t, 1024))
    )
      throw new Error("主机范围无效");
    const hosts = [],
      errors = [];
    for (const alias of targets) {
      try {
        const checked = this.profiles.resolve({ target: alias });
        if (!checked.ok) throw new Error(checked.error);
        const resolved = await this.endpoint(checked.launch);
        let key;
        if (checked.launch.identityFile && !checked.launch.keyId) {
          const file = checked.launch.identityFile,
            stat = fs.statSync(file);
          if (!stat.isFile() || stat.size > 131072)
            throw new Error("私钥文件无法读取");
          const metadata = await this.vault.inspectKey(
            fs.readFileSync(file, "utf8"),
            "",
          );
          key = {
            id: "file:" + alias,
            name: path.basename(file).slice(0, 80),
            type: metadata.type,
            fingerprint: metadata.fingerprint,
          };
        }
        hosts.push({
          alias,
          hostname: resolved.host,
          user: resolved.user,
          port: resolved.port,
          jumpHost: checked.launch.jumpHost || resolved.proxyJump,
          unsupportedProxy: !!resolved.proxyCommand && !resolved.proxyJump,
          key,
        });
      } catch (error) {
        errors.push(alias + ": " + error.message);
      }
    }
    return { hosts, errors };
  }
  ticket(id) {
    const value = this.tickets.get(id);
    if (!value || value.expires < Date.now()) {
      this.tickets.delete(id);
      throw new Error("凭据导入预览已过期，请重新读取备份");
    }
    return value;
  }
  async exportCredentials({ password, targets, keyIds }) {
    if (
      !Array.isArray(targets) ||
      targets.length > 512 ||
      !targets.every((t) => text(t, 1024)) ||
      !Array.isArray(keyIds) ||
      keyIds.length > 256
    )
      throw new Error("备份范围无效");
    const stored = this.vault.read(),
      value = { version: 1, keys: [], credentials: [] },
      keyBindings = {};
    const portableIds = new Map();
    for (const key of stored.keys.filter((k) => keyIds.includes(k.id))) {
      let privateKey;
      if (key.source === "file") {
        const stat = fs.statSync(key.file);
        if (!stat.isFile() || stat.size > 131072)
          throw new Error("密钥文件无法备份");
        privateKey = fs.readFileSync(key.file, "utf8");
        if (
          crypto.createHash("sha256").update(privateKey).digest("hex") !==
          key.contentHash
        )
          throw new Error("密钥文件已经变化，请先在密钥库更新");
      } else privateKey = this.vault.decrypt(key.encrypted);
      const phrase = Object.values(stored.credentials).find(
        (c) => c.kind === "passphrase" && c.identity === key.id && !c.invalid,
      );
      value.keys.push({
        id: key.id,
        name: key.name,
        privateKey,
        ...(phrase ? { passphrase: this.vault.decrypt(phrase.encrypted) } : {}),
      });
      portableIds.set(key.id, key.id);
    }
    for (const target of targets) {
      const checked = this.profiles.resolve({ target });
      if (!checked.ok) continue;
      const endpoint = await this.endpoint(checked.launch);
      const binding = JSON.stringify([
        String(endpoint.host).toLowerCase(),
        endpoint.port,
        endpoint.user,
      ]);
      let identity =
        checked.launch.keyId ||
        (checked.launch.identityFile
          ? require("./ssh-credentials.cjs").keyPath(
              checked.launch.identityFile,
            )
          : "");
      if (checked.launch.identityFile && !checked.launch.keyId) {
        const file = checked.launch.identityFile,
          stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > 131072)
          throw new Error("私钥文件无法备份");
        const id = "file:" + target,
          phrase = Object.values(stored.credentials).find(
            (c) =>
              c.target === target &&
              c.identity === identity &&
              c.kind === "passphrase" &&
              !c.invalid,
          );
        value.keys.push({
          id,
          name: path.basename(file).slice(0, 80),
          privateKey: fs.readFileSync(file, "utf8"),
          ...(phrase
            ? { passphrase: this.vault.decrypt(phrase.encrypted) }
            : {}),
        });
        portableIds.set(identity, id);
        keyBindings[target] = id;
      } else if (identity)
        keyBindings[target] = portableIds.get(identity) || identity;
      for (const entry of Object.values(stored.credentials).filter(
        (c) =>
          c.target === target &&
          c.binding === binding &&
          !c.invalid &&
          (c.kind === "password" || c.identity === identity),
      ))
        value.credentials.push({
          target,
          kind: entry.kind,
          value: this.vault.decrypt(entry.encrypted),
          host: endpoint.host,
          port: endpoint.port,
          user: endpoint.user,
          keyId:
            entry.kind === "passphrase"
              ? portableIds.get(entry.identity) || entry.identity
              : undefined,
          fingerprint: entry.fingerprint,
        });
    }
    validate(value);
    return { encrypted: await encrypt(value, password), keyBindings };
  }
  async prepareCredentials({ password, encrypted }) {
    const value = await decrypt(encrypted, password),
      ticket = crypto.randomUUID();
    for (const [id, old] of this.tickets)
      if (old.expires < Date.now()) this.tickets.delete(id);
    if (this.tickets.size >= 4) throw new Error("请先关闭已有导入预览");
    this.tickets.set(ticket, {
      value,
      keyMap: {},
      expires: Date.now() + 10 * 60 * 1000,
    });
    setTimeout(this.tickets.delete.bind(this.tickets, ticket), 600000).unref();
    return {
      ticket,
      keys: value.keys.length,
      credentials: value.credentials.length,
    };
  }
  async importKeys(id) {
    const ticket = this.ticket(id);
    for (const key of ticket.value.keys)
      if (!ticket.keyMap[key.id]) {
        const digest = crypto
            .createHash("sha256")
            .update(key.privateKey)
            .digest("hex"),
          existing = this.vault
            .read()
            .keys.find((k) => k.contentHash === digest);
        const saved =
          existing ||
          (await this.vault.addKey({
            source: "import",
            name: key.name,
            content: key.privateKey,
            passphrase: key.passphrase,
          }));
        ticket.keyMap[key.id] = saved.id;
      }
    return { keyMap: { ...ticket.keyMap } };
  }
  async importCredentials({ ticket: id, hosts }) {
    const ticket = this.ticket(id);
    if (!hosts || typeof hosts !== "object" || Object.keys(hosts).length > 512)
      throw new Error("主机映射无效");
    const operations = [];
    for (const item of ticket.value.credentials) {
      const target = Object.hasOwn(hosts, item.target)
        ? hosts[item.target]
        : undefined;
      if (!target) continue;
      const checked = this.profiles.resolve({ target });
      if (!checked.ok) throw new Error(checked.error);
      const endpoint = await this.endpoint(checked.launch);
      if (
        String(endpoint.host).toLowerCase() !== item.host.toLowerCase() ||
        endpoint.user !== item.user ||
        endpoint.port !== item.port
      )
        throw new Error("凭据目标与导入主机不一致，未写入凭据");
      const identity =
        item.kind === "passphrase" ? ticket.keyMap[item.keyId] : "";
      if (
        item.kind === "passphrase" &&
        (!identity || checked.launch.keyId !== identity)
      )
        continue;
      operations.push({ item, target, endpoint, identity });
    }
    const before = this.vault.read();
    try {
      for (const { item, target, endpoint, identity } of operations)
        this.vault.put(
          target,
          item.kind,
          item.value,
          endpoint,
          identity,
          item.fingerprint || "",
        );
    } catch (error) {
      this.vault.write(before);
      throw error;
    }
    this.tickets.delete(id);
    return { count: operations.length };
  }
  cancel(id) {
    this.tickets.delete(id);
  }
}
module.exports = { SshMigration };
