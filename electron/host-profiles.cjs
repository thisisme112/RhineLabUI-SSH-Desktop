/** App-owned connection profiles. System SSH config remains an independent source. */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { validateLaunch } = require("./ssh-args.cjs");

const PREFIX = "rhine-profile:";
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MAX_BYTES = 2 * 1024 * 1024;
const OPTIONS = [
  "user",
  "port",
  "identityFile",
  "authMode",
  "keyId",
  "jumpHost",
  "connectTimeout",
  "keepAliveInterval",
  "keepAliveCountMax",
];
const keyFor = (id) => PREFIX + id;

function normalizeProfile(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("主机配置无效");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name))
    throw new Error("请填写 1–80 个字符的主机名称");
  const checked = validateLaunch({
    ...Object.fromEntries(OPTIONS.map((key) => [key, input[key]])),
    target: input.hostname,
  });
  if (!checked.ok) throw new Error(checked.error);
  if (checked.launch.target.startsWith(PREFIX))
    throw new Error("请填写实际主机地址或 SSH 配置别名");
  if (
    input.id !== undefined &&
    (typeof input.id !== "string" || !ID.test(input.id))
  )
    throw new Error("主机编号无效");
  const { target, ...options } = checked.launch;
  return {
    ...(input.id ? { id: input.id } : {}),
    name,
    hostname: target,
    ...options,
  };
}

class HostProfiles {
  constructor(file) {
    this.file = file;
  }

  read() {
    let stat;
    try {
      stat = fs.lstatSync(this.file);
    } catch (error) {
      if (error.code === "ENOENT") return { profiles: [], revision: "empty" };
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES)
      throw new Error("本地主机配置无法读取，请检查文件类型与大小");
    const text = fs.readFileSync(this.file, "utf8");
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("本地主机配置已损坏，原文件已保留");
    }
    if (
      !data ||
      ![1, 2].includes(data.version) ||
      !Array.isArray(data.profiles) ||
      data.profiles.length > 256
    )
      throw new Error("本地主机配置格式不受支持，原文件已保留");
    const profiles = data.profiles.map(normalizeProfile);
    if (
      profiles.some((profile) => !profile.id) ||
      new Set(profiles.map((profile) => profile.id)).size !== profiles.length
    )
      throw new Error("本地主机编号重复或缺失，原文件已保留");
    return {
      profiles,
      revision: createHash("sha256").update(text).digest("hex"),
    };
  }

  save(input, revision) {
    const data = this.read();
    if (revision !== data.revision)
      throw new Error("主机列表已更新，请返回列表刷新后再编辑");
    const profile = normalizeProfile(input);
    if (profile.id) {
      const index = data.profiles.findIndex((entry) => entry.id === profile.id);
      if (index < 0) throw new Error("这台主机已被移除，请刷新列表");
      data.profiles[index] = profile;
    } else {
      if (data.profiles.length >= 256) throw new Error("最多保存 256 台主机");
      profile.id = randomUUID();
      data.profiles.push(profile);
    }
    this.write(data.profiles);
    return { profile, revision: this.read().revision };
  }

  remove(id, revision) {
    const data = this.read();
    if (revision !== data.revision)
      throw new Error("主机列表已更新，请返回列表刷新后再编辑");
    const profiles = data.profiles.filter((profile) => profile.id !== id);
    if (profiles.length === data.profiles.length)
      throw new Error("这台主机已被移除，请刷新列表");
    this.write(profiles);
  }

  write(profiles) {
    const text = JSON.stringify({ version: 2, profiles }, null, 2) + "\n";
    if (Buffer.byteLength(text, "utf8") > MAX_BYTES)
      throw new Error("主机配置超过 2 MiB，原配置已保留，请缩短过长的连接参数");
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, text, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      fs.renameSync(temporary, this.file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  entries() {
    const { profiles, revision } = this.read();
    return {
      revision,
      hosts: profiles.map((profile) => ({
        alias: keyFor(profile.id),
        displayName: profile.name,
        source: "saved",
        hostname: profile.hostname,
        user: profile.user ?? "",
        port: profile.port === undefined ? "" : String(profile.port),
        identityFile: profile.identityFile,
        profile,
        raw: [
          `HostName ${profile.hostname}`,
          ...[
            ["user", "User"],
            ["port", "Port"],
            ["identityFile", "IdentityFile"],
            ["jumpHost", "ProxyJump"],
            ["connectTimeout", "ConnectTimeout"],
            ["keepAliveInterval", "ServerAliveInterval"],
            ["keepAliveCountMax", "ServerAliveCountMax"],
          ]
            .filter(([key]) => profile[key] !== undefined)
            .map(([key, option]) => `${option} ${profile[key]}`),
        ].join("\n"),
      })),
    };
  }

  resolve(input) {
    const target = typeof input?.target === "string" ? input.target.trim() : "";
    if (!target.startsWith(PREFIX)) return validateLaunch(input);
    const profile = this.read().profiles.find(
      (entry) => keyFor(entry.id) === target,
    );
    if (!profile) return { ok: false, error: "保存的主机不存在，请刷新列表" };
    const checked = validateLaunch({ ...profile, target: profile.hostname });
    return { ...checked, displayTarget: profile.name };
  }
}
module.exports = { HostProfiles, normalizeProfile, keyFor };
