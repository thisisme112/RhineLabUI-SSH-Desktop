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
// The Unreal build's SshWorkbenchPawn::JumpChain and android/bridge.ts: at most
// three saved jump hosts, never back to a host already on the way.
const JUMP_HOPS = 3;

function normalizeProfile(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("主机配置无效");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name))
    throw new Error("请填写 1–80 个字符的主机名称");
  // A saved jump host is referenced by its id, as the Unreal build stores
  // JumpHostId, so it keeps its own address, key and saved secret. The
  // free-form jumpHost (an ssh config alias or user@host:port) is then unused.
  let jumpHostId;
  if (input.jumpHostId !== undefined && input.jumpHostId !== "") {
    if (typeof input.jumpHostId !== "string" || !ID.test(input.jumpHostId))
      throw new Error("跳板机档案无效");
    if (input.jumpHostId === input.id) throw new Error("主机不能经由自己跳转");
    jumpHostId = input.jumpHostId;
  }
  const checked = validateLaunch({
    ...Object.fromEntries(
      OPTIONS.map((key) => [key, key === "jumpHost" && jumpHostId ? undefined : input[key]]),
    ),
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
    ...(jumpHostId ? { jumpHostId } : {}),
  };
}

/** `[user@]host[:port]` of a free-form jump host, or null for anything else. */
function jumpAddress(value) {
  const match = String(value).match(/^(?:([^@\s]+)@)?(\[[^\]\s]+\]|[^:@\s]+)(?::(\d+))?$/);
  return match && { user: match[1] || "", host: match[2].replace(/^\[|\]$/g, "").toLowerCase(), port: Number(match[3]) || 22 };
}

/**
 * The saved host a profile jumps through: its jumpHostId, or a free-form jump
 * host that names a saved one by alias, name or user@host:port (the Unreal
 * build migrates those the same way when it loads hosts).
 */
function jumpOf(profile, profiles) {
  if (profile.jumpHostId) {
    const hop = profiles.find((entry) => entry.id === profile.jumpHostId);
    if (!hop) throw new Error(`「${profile.name}」的跳板机已不在主机档案中，请在连接配置里重新选择。`);
    return hop;
  }
  const jump = profile.jumpHost;
  if (!jump || jump.includes(",")) return null;
  const at = jumpAddress(jump);
  return profiles.find((entry) => entry.id !== profile.id && (keyFor(entry.id) === jump || entry.name === jump ||
    (at && entry.hostname.toLowerCase() === at.host && (entry.port ?? 22) === at.port && (!at.user || entry.user === at.user)))) ?? null;
}

/** Saved jump hosts in the order ssh meets them: outermost first. */
function jumpChain(profile, profiles) {
  const chain = [], seen = new Set([profile.id]);
  for (let at = profile, hop; (hop = jumpOf(at, profiles)); at = hop) {
    if (seen.has(hop.id)) throw new Error("跳板机链路形成了循环，请检查各主机的跳板机设置。");
    if (chain.length >= JUMP_HOPS) throw new Error("跳板机链路超过 3 跳。");
    seen.add(hop.id);
    chain.unshift(hop);
  }
  return chain;
}

/**
 * ConnectTimeout also bounds the wait for the destination's banner, and through
 * a jump host that wait includes the questions the jump host asks: a jump
 * password typed slower than the timeout would end the session with 255. The
 * jump itself keeps the system's TCP timeout.
 */
function withoutJumpTimeout(checked) {
  if (checked.ok && checked.launch.jumpHost) delete checked.launch.connectTimeout;
  return checked;
}

/** One `-J` entry, spelled out so ssh needs nothing from its config to find the hop. */
const jumpSpec = (hop) =>
  (hop.user ? hop.user + "@" : "") +
  (hop.hostname.includes(":") ? `[${hop.hostname}]` : hop.hostname) +
  (hop.port !== undefined ? ":" + hop.port : "");

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
    // A loop, a missing hop or a fourth hop is refused here, not at connect time.
    jumpChain(profile, data.profiles);
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
    const dependent = profiles.find((profile) => profile.jumpHostId === id);
    if (dependent)
      throw new Error(`「${dependent.name}」经由这台主机跳转，请先在它的连接配置里改掉跳板机`);
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
      hosts: profiles.map((profile) => {
        // Saved jump hosts are named, outermost first; a broken chain says so.
        let jump = profile.jumpHost;
        try {
          const chain = jumpChain(profile, profiles);
          if (chain.length) jump = [chain[0].jumpHost, ...chain.map((hop) => hop.name)].filter(Boolean).join(" → ");
        } catch (error) {
          jump = "# " + error.message;
        }
        return {
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
              ["connectTimeout", "ConnectTimeout"],
              ["keepAliveInterval", "ServerAliveInterval"],
              ["keepAliveCountMax", "ServerAliveCountMax"],
            ]
              .filter(([key]) => profile[key] !== undefined)
              .map(([key, option]) => `${option} ${profile[key]}`),
            ...(jump === undefined ? [] : [jump.startsWith("#") ? jump : `ProxyJump ${jump}`]),
          ].join("\n"),
        };
      }),
    };
  }

  /**
   * A launch for a saved host or a typed descriptor. Saved jump hosts (also
   * for a temporary connection, by `jumpHostId`) are spelled out as one -J
   * chain, and listed as `hops` so each answers with its own saved secret.
   */
  resolve(input) {
    const target = typeof input?.target === "string" ? input.target.trim() : "";
    const saved = target.startsWith(PREFIX);
    if (!saved && !input?.jumpHostId) return withoutJumpTimeout(validateLaunch(input));
    const { profiles } = this.read();
    let profile;
    if (saved) {
      profile = profiles.find((entry) => keyFor(entry.id) === target);
      if (!profile) return { ok: false, error: "保存的主机不存在，请刷新列表" };
    } else {
      if (typeof input.jumpHostId !== "string" || !ID.test(input.jumpHostId))
        return { ok: false, error: "跳板机档案无效" };
      profile = { name: String(input.displayName || target), jumpHostId: input.jumpHostId };
    }
    let chain;
    try {
      chain = jumpChain(profile, profiles);
    } catch (error) {
      return { ok: false, error: error.message };
    }
    const descriptor = saved ? { ...profile, target: profile.hostname } : { ...input };
    // A free-form jump host on the outermost saved hop is still the first one met.
    const specs = (hops) => [chain[0].jumpHost, ...hops.map(jumpSpec)].filter(Boolean).join(",");
    if (chain.length) descriptor.jumpHost = specs(chain);
    const checked = withoutJumpTimeout(validateLaunch(descriptor));
    if (!checked.ok) return checked;
    // -J gives a hop only its user, host and port (its config may add an
    // IdentityFile). The hop next to the destination may bring its own key:
    // it then runs as a ProxyCommand with it, once the session has its file
    // (a vault key is leased like the destination's); until then -J stands.
    const keyed = chain.at(-1);
    const keyHop = keyed && keyed.authMode !== "password" && (keyed.keyId || keyed.identityFile) ? keyed : null;
    if (keyHop)
      checked.launch.proxyHop = {
        host: keyHop.hostname,
        ...(keyHop.user ? { user: keyHop.user } : {}),
        ...(keyHop.port !== undefined ? { port: keyHop.port } : {}),
        ...(keyHop.keyId ? { keyId: keyHop.keyId } : { identityFile: keyHop.identityFile }),
        ...(specs(chain.slice(0, -1)) ? { jumpHost: specs(chain.slice(0, -1)) } : {}),
      };
    return {
      ...checked,
      ...(saved ? { displayTarget: profile.name } : {}),
      // A vault key is offered only by the ProxyCommand hop, so only that hop
      // can have its passphrase answered by key identity.
      hops: chain.map((hop) => ({
        target: keyFor(hop.id),
        label: hop.name,
        launch: validateLaunch({ target: hop.hostname, user: hop.user, port: hop.port,
          ...(hop === keyHop && hop.keyId ? { keyId: hop.keyId } : { identityFile: hop.identityFile }) }).launch,
        ...(hop === keyHop ? { proxy: true } : {}),
      })),
      // The saved host this one jumps through directly, for the migration export.
      ...(chain.length ? { jumpAlias: keyFor(chain[chain.length - 1].id) } : {}),
    };
  }
}
module.exports = { HostProfiles, normalizeProfile, keyFor, jumpChain };
