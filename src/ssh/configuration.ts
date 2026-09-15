import type { SshHostProfile, SshKeyEntry } from "./client";
import type { EncryptedCredentials } from "./migration-types";
import {
  validAppearance,
  terminalAppearance,
  type TerminalAppearance,
} from "./terminal-appearance";
import {
  sshPreferences,
  validSshPreferences,
  type SshPreferences,
} from "./preferences";
import {
  WorkspaceStore,
  validateWorkspace,
  type WorkspaceData,
  type WorkspaceLayout,
} from "./workspace-store";

type PortableHost = Omit<SshHostProfile, "id" | "identityFile" | "jumpHost"> & {
  alias: string;
  user: string;
  port: number;
  jump?: string;
};
export type WorkspaceBackup = {
  format: "rhine.ssh.workspace";
  version: 1;
  platform: "desktop" | "android";
  createdAt: string;
  hosts: PortableHost[];
  workspace: WorkspaceData;
  appearance: TerminalAppearance;
  preferences: SshPreferences;
  keys: Pick<SshKeyEntry, "id" | "name" | "fingerprint" | "type">[];
  encrypted?: EncryptedCredentials;
};
const text = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
const endpoint = (host: { hostname: string; user?: string; port?: number }) =>
  JSON.stringify([
    host.hostname.toLowerCase(),
    host.user || "",
    host.port || 22,
  ]);
const remoteAddress = (h: PortableHost) =>
  `${h.user}@${h.hostname.includes(":") ? `[${h.hostname}]` : h.hostname}:${h.port}`;
const number = (n: unknown, min: number, max: number) =>
  Number.isInteger(n) && Number(n) >= min && Number(n) <= max;

function orderedHosts(hosts: PortableHost[]): PortableHost[] {
  const ordered: PortableHost[] = [],
    done = new Set<string>();
  const visit = (host: PortableHost, trail = new Set<string>()) => {
    if (trail.has(host.alias) || trail.size > 3)
      throw new Error("跳板机存在循环或超过三层");
    if (done.has(host.alias)) return;
    if (host.jump) {
      const jump = hosts.find((h) => h.alias === host.jump);
      if (!jump) throw new Error(`${host.name} 的跳板机缺失`);
      visit(jump, new Set([...trail, host.alias]));
    }
    done.add(host.alias);
    ordered.push(host);
  };
  for (const host of hosts) {
    const trail = new Set<string>();
    let cursor: PortableHost | undefined = host;
    while (cursor?.jump) {
      if (trail.has(cursor.alias) || trail.size >= 3)
        throw new Error("跳板机存在循环或超过三层");
      trail.add(cursor.alias);
      cursor = hosts.find((h) => h.alias === cursor!.jump);
      if (!cursor) throw new Error("跳板机缺失");
    }
    visit(host);
  }
  return ordered;
}
export function readWorkspaceBackup(raw: string): WorkspaceBackup {
  if (new TextEncoder().encode(raw).byteLength > 16 * 1024 * 1024)
    throw new Error("配置文件超过 16 MiB");
  const value = JSON.parse(raw) as WorkspaceBackup;
  if (
    !value ||
    value.format !== "rhine.ssh.workspace" ||
    value.version !== 1 ||
    !["desktop", "android"].includes(value.platform) ||
    !text(value.createdAt, 40) ||
    !validAppearance(value.appearance) ||
    !validSshPreferences(value.preferences) ||
    !validateWorkspace(value.workspace) ||
    !Array.isArray(value.hosts) ||
    value.hosts.length > 256 ||
    !Array.isArray(value.keys) ||
    value.keys.length > 256 ||
    value.keys.some(
      (k) =>
        !k ||
        !text(k.id, 1024) ||
        !text(k.name, 100) ||
        !text(k.fingerprint, 256) ||
        !text(k.type, 100),
    )
  )
    throw new Error("配置格式或版本不受支持，未修改本机内容");
  for (const host of value.hosts) {
    if (
      !host ||
      !text(host.alias, 1024) ||
      !host.alias ||
      !text(host.name, 80) ||
      !host.name.trim() ||
      !text(host.hostname, 253) ||
      !/^[\w.:[\]-]+$/.test(host.hostname) ||
      !host.hostname ||
      host.hostname.startsWith("-") ||
      !text(host.user, 128) ||
      !host.user ||
      !number(host.port, 1, 65535) ||
      (host.authMode !== undefined &&
        !["auto", "password", "key"].includes(host.authMode)) ||
      (host.keyId !== undefined && !text(host.keyId, 1024)) ||
      (host.jump !== undefined && !text(host.jump, 1024)) ||
      (host.connectTimeout !== undefined &&
        !number(host.connectTimeout, 1, 600)) ||
      (host.keepAliveInterval !== undefined &&
        !number(host.keepAliveInterval, 0, 3600)) ||
      (host.keepAliveCountMax !== undefined &&
        !number(host.keepAliveCountMax, 1, 30))
    )
      throw new Error("主机配置格式无效");
  }
  if (
    new Set(value.hosts.map((h) => h.alias)).size !== value.hosts.length ||
    new Set(value.keys.map((k) => k.id)).size !== value.keys.length
  )
    throw new Error("配置含有重复编号");
  orderedHosts(value.hosts);
  const aliases = new Set(value.hosts.map((h) => h.alias));
  const needsHost = [
    ...value.workspace.bookmarks.map((b) => b.alias),
    ...value.workspace.shortcuts
      .filter((s) => s.kind !== "note")
      .map((s) => s.alias),
    ...value.workspace.shortcuts
      .map((s) => s.layout?.splitAlias)
      .filter(Boolean),
  ] as string[];
  if (needsHost.some((alias) => !aliases.has(alias)))
    throw new Error("配置中的快捷档案或目录缺少关联主机");
  if (
    value.encrypted &&
    (value.encrypted.version !== 1 ||
      value.encrypted.kdf !== "PBKDF2-SHA256" ||
      value.encrypted.iterations !== 210000 ||
      typeof value.encrypted.data !== "string" ||
      value.encrypted.data.length > 12 * 1024 * 1024 ||
      !text(value.encrypted.salt, 64) ||
      !text(value.encrypted.iv, 64))
  )
    throw new Error("凭据加密格式无效");
  return value;
}

export async function createWorkspaceBackup(
  store: WorkspaceStore,
  password?: string,
): Promise<WorkspaceBackup> {
  const bridge = window.rhineDesktop!,
    listing = await bridge.hosts!();
  if (!listing.ok) throw new Error(listing.error || "无法读取主机列表");
  if (store.error) throw new Error(store.error);
  const details = await bridge.migration!.describeHosts(
    listing.hosts.map((h) => h.alias),
  );
  if (!details.ok || !details.result || details.result.errors.length)
    throw new Error(
      details.error || details.result?.errors.join("\n") || "无法解析主机配置",
    );
  const keys = await bridge.keys!.list();
  if (!keys.ok) throw new Error(keys.error || "密钥目录无法读取");
  const hosts: PortableHost[] = details.result.hosts.map((host) => {
    const entry = listing.hosts.find((h) => h.alias === host.alias)!;
    if (host.unsupportedProxy)
      throw new Error(
        `${entry.displayName || entry.alias} 使用 ProxyCommand，需改为可迁移的跳板机配置后再导出`,
      );
    if (entry.identityFile && !entry.profile?.keyId && !host.key)
      throw new Error(
        `${entry.displayName || entry.alias} 的私钥来自系统 SSH 配置，请先保存为主机档案并关联密钥库再迁移`,
      );
    return {
      alias: host.alias,
      name: entry.displayName || entry.alias,
      hostname: host.hostname,
      user: host.user,
      port: host.port,
      authMode:
        entry.profile?.authMode ||
        (entry.profile?.keyId || entry.identityFile ? "key" : "auto"),
      keyId: entry.profile?.keyId || host.key?.id,
      connectTimeout: entry.profile?.connectTimeout,
      keepAliveInterval: entry.profile?.keepAliveInterval,
      keepAliveCountMax: entry.profile?.keepAliveCountMax,
    };
  });
  // Normalize OpenSSH's comma-separated ProxyJump into ordinary saved hosts.
  // Only concrete endpoints or exported aliases are portable; shell commands
  // and unresolved local SSH aliases never become direct remote connections.
  for (const detail of details.result.hosts) {
    const owner = hosts.find((h) => h.alias === detail.alias)!;
    let previous: string | undefined;
    for (const part of detail.jumpHost?.split(",").filter(Boolean) || []) {
      let hop = hosts.find((h) => h.alias === part);
      if (!hop) {
        const match = part.match(
          /^(?:([^@\s]+)@)?(\[[a-fA-F0-9:]+\]|[^:\s]+)(?::(\d+))?$/,
        );
        if (!match) throw new Error(`${owner.name} 的跳板机无法迁移`);
        const hostname = match[2].replace(/^\[|\]$/g, "");
        // OpenSSH can obtain a jump alias's User/HostName from config. If it is
        // not in the exported inventory, ask the native resolver for its facts.
        const resolved = await bridge.migration!.describeHosts([
          (match[1] ? match[1] + "@" : "") + match[2],
        ]);
        const found = resolved.ok ? resolved.result?.hosts[0] : undefined;
        if (!found && !match[1])
          throw new Error(`请先将跳板机 ${part} 保存为包含用户名的主机档案`);
        if (found?.jumpHost || found?.unsupportedProxy)
          throw new Error(
            `请先将跳板机 ${part} 及其完整连接链保存为主机档案再导出`,
          );
        hop = {
          alias: "jump:" + crypto.randomUUID(),
          name: part.slice(0, 80),
          hostname: found?.hostname || hostname,
          user: found?.user || match[1],
          port: Number(match[3]) || found?.port || 22,
          authMode: "auto",
          jump: previous,
        };
        hosts.push(hop);
      } else if (previous && hop.jump !== previous) {
        hop = { ...hop, alias: "jump:" + crypto.randomUUID(), jump: previous };
        hosts.push(hop);
      }
      previous = hop.alias;
    }
    if (previous) owner.jump = previous;
  }
  const backup: WorkspaceBackup = {
    format: "rhine.ssh.workspace",
    version: 1,
    platform: bridge.platform === "android" ? "android" : "desktop",
    createdAt: new Date().toISOString(),
    hosts,
    workspace: store.snapshot(),
    appearance: { ...terminalAppearance.value },
    preferences: structuredClone(sshPreferences.value),
    keys: keys.keys.map(({ id, name, fingerprint, type }) => ({
      id,
      name,
      fingerprint,
      type,
    })),
  };
  for (const detail of details.result.hosts)
    if (detail.key) backup.keys.push(detail.key);
  if (password !== undefined) {
    const result = await bridge.migration!.exportCredentials({
      password,
      targets: listing.hosts.map((h) => h.alias),
      keyIds: keys.keys.map((k) => k.id),
    });
    if (!result.ok || !result.result)
      throw new Error(result.error || "凭据加密失败");
    backup.encrypted = result.result.encrypted;
    for (const host of hosts)
      if (Object.hasOwn(result.result.keyBindings, host.alias))
        host.keyId = result.result.keyBindings[host.alias];
  }
  // Orphaned local layouts are harmless preferences, but archives/bookmarks
  // must retain an explicit, usable host binding in the exported file.
  readWorkspaceBackup(JSON.stringify(backup));
  return backup;
}

export async function importWorkspaceBackup(
  backup: WorkspaceBackup,
  store: WorkspaceStore,
  ticket?: string,
): Promise<string> {
  readWorkspaceBackup(JSON.stringify(backup));
  if (store.error || sshPreferences.error || terminalAppearance.error)
    throw new Error(
      store.error || sshPreferences.error || terminalAppearance.error,
    );
  const bridge = window.rhineDesktop!,
    local = await bridge.hosts!();
  if (!local.ok) throw new Error(local.error || "无法读取主机列表");
  const localKeys = await bridge.keys!.list();
  if (!localKeys.ok) throw new Error(localKeys.error || "无法读取密钥目录");
  const hostMap: Record<string, string> = Object.create(null),
    keyMap: Record<string, string> = Object.create(null);
  for (const key of backup.keys) {
    const match = localKeys.keys.find(
      (k) => k.fingerprint === key.fingerprint && key.fingerprint,
    );
    if (match) keyMap[key.id] = match.id;
  }
  const warnings: string[] = [];
  let created = 0,
    credentials = 0,
    revision = local.revision || "";
  const ordered = orderedHosts(backup.hosts);
  const authModeFor = (host: PortableHost) =>
    bridge.platform === "android" &&
    backup.platform === "desktop" &&
    (!host.authMode || host.authMode === "auto")
      ? host.keyId
        ? ("key" as const)
        : ("password" as const)
      : host.authMode;
  if (!ticket) {
    const missing = ordered.filter(
      (h) => authModeFor(h) === "key" && (!h.keyId || !keyMap[h.keyId]),
    );
    if (missing.length)
      throw new Error(
        `以下主机缺少对应私钥：${missing.map((h) => h.name).join("、")}。请先在密钥库导入对应私钥，或使用包含加密凭据的备份。`,
      );
  }
  if (
    local.hosts.filter((h) => h.source === "saved").length +
      ordered.filter(
        (h) =>
          !local.hosts.some(
            (e) =>
              endpoint(
                e.profile || {
                  hostname: e.hostname,
                  user: e.user,
                  port: Number(e.port) || 22,
                },
              ) === endpoint(h),
          ),
      ).length >
    256
  )
    throw new Error("合并后主机将超过 256 台，请先整理本机主机列表");
  try {
    if (ticket) {
      const imported = await bridge.migration!.importKeys(ticket);
      if (!imported.ok || !imported.result)
        throw new Error(imported.error || "私钥导入失败");
      Object.assign(keyMap, imported.result.keyMap);
    }
    for (const host of ordered) {
      const keyId = host.keyId && keyMap[host.keyId];
      const authMode = authModeFor(host);
      if (authMode === "key" && !keyId)
        throw new Error(`${host.name} 的私钥未包含在备份中，请先导入对应私钥`);
      let jumpHost: string | undefined;
      if (host.jump) {
        if (bridge.platform === "android") jumpHost = hostMap[host.jump];
        else {
          const chain: PortableHost[] = [];
          let next = backup.hosts.find((h) => h.alias === host.jump);
          while (next) {
            chain.unshift(next);
            next = backup.hosts.find((h) => h.alias === next!.jump);
          }
          jumpHost = chain.map(remoteAddress).join(",");
        }
      }
      const existing = local.hosts.find(
        (e) =>
          e.source === "saved" &&
          endpoint(e.profile!) === endpoint(host) &&
          (e.profile?.jumpHost || "") === (jumpHost || "") &&
          (e.profile?.authMode || "auto") === (authMode || "auto") &&
          (!keyId || e.profile?.keyId === keyId),
      );
      if (existing) {
        hostMap[host.alias] = existing.alias;
        continue;
      }
      if ((host.keyId && !keyId) || (host.authMode === "key" && !keyId))
        warnings.push(`${host.name}：需重新关联私钥`);
      const profile: SshHostProfile = {
        name: host.name,
        hostname: host.hostname,
        user: host.user,
        port: host.port,
        authMode,
        keyId: keyId || undefined,
        jumpHost,
        connectTimeout: host.connectTimeout,
        keepAliveInterval: host.keepAliveInterval,
        keepAliveCountMax: host.keepAliveCountMax,
      };
      const saved = await bridge.hostProfiles!.save(profile, revision);
      if (!saved.ok || !saved.profile?.id)
        throw new Error(saved.error || "主机保存失败");
      revision = saved.revision!;
      const alias = "rhine-profile:" + saved.profile.id;
      hostMap[host.alias] = alias;
      created++;
      local.hosts.push({
        alias,
        source: "saved",
        hostname: profile.hostname,
        user: profile.user!,
        port: String(profile.port),
        profile: saved.profile,
      });
    }
    const remapLayout = (layout: WorkspaceLayout): WorkspaceLayout => ({
      ...layout,
      splitAlias: layout.splitAlias
        ? hostMap[layout.splitAlias] || ""
        : undefined,
    });
    const incoming = structuredClone(backup.workspace),
      localData = store.snapshot();
    incoming.numbers = {};
    incoming.layouts = Object.fromEntries(
      Object.entries(incoming.layouts)
        .filter(([alias]) => hostMap[alias])
        .map(([alias, layout]) => [hostMap[alias], remapLayout(layout)]),
    );
    incoming.bookmarks = incoming.bookmarks.map((b) => ({
      ...b,
      alias: hostMap[b.alias],
    }));
    incoming.shortcuts = incoming.shortcuts.map((s) => ({
      ...s,
      alias: s.kind === "note" ? "" : hostMap[s.alias],
      layout: s.layout && remapLayout(s.layout),
    }));
    // Retain local items if a backup reuses an ID for different content.
    const keepBoth = <T extends { id: string }>(items: T[], existing: T[]) =>
      items.map((item) => {
        const old = existing.find((e) => e.id === item.id);
        return old && JSON.stringify(old) !== JSON.stringify(item)
          ? { ...item, id: crypto.randomUUID() }
          : item;
      });
    incoming.commands = keepBoth(incoming.commands, localData.commands);
    incoming.bookmarks = keepBoth(incoming.bookmarks, localData.bookmarks);
    incoming.shortcuts = keepBoth(incoming.shortcuts, localData.shortcuts);
    // Existing host layouts stay local; project archives carry their own layout.
    incoming.layouts = { ...incoming.layouts, ...localData.layouts };
    if (!store.merge(incoming))
      throw new Error(store.error || "工作区资料无法保存");
    if (ticket) {
      const result = await bridge.migration!.importCredentials({
        ticket,
        hosts: hostMap,
      });
      if (!result.ok || !result.result)
        throw new Error(result.error || "凭据导入失败");
      credentials = result.result.count;
    }
    terminalAppearance.update(backup.appearance);
    // Foreground permission is device-owned and only enabled by its local
    // switch. Importing settings must not request permission or start sessions.
    if (
      !sshPreferences.save({
        ...backup.preferences,
        background: sshPreferences.value.background,
      })
    )
      throw new Error(sshPreferences.error || "工作区设置未保存");
    if (bridge.platform !== "android" && backup.hosts.some((h) => h.jump))
      warnings.push(
        "电脑跳板链已转为系统 SSH 地址；跳板认证沿用本机 SSH 配置或连接时输入",
      );
    if (
      bridge.platform === "android" &&
      backup.platform === "desktop" &&
      backup.hosts.some((h) => !h.authMode || h.authMode === "auto")
    )
      warnings.push(
        "系统 SSH 自动认证已映射为指定私钥或密码；需要 OTP 的主机可改为交互式验证",
      );
    return `导入完成：新增 ${created} 台主机，${incoming.shortcuts.length} 份档案，${credentials} 项凭据。${warnings.length ? "\n" + [...new Set(warnings)].join("\n") : ""}`;
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n已新增 ${created} 台主机；已导入的密钥或资料保留，可修正后再次导入。`,
    );
  } finally {
    if (ticket) await bridge.migration!.cancel(ticket);
  }
}
