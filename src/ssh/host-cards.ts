import { archiveColumns, configureArchiveColumns, setArchiveExtension, registerArchiveRecords, type ArchiveRecord } from "../data.ts";
import type { SshHostEntry, SshHostsResult } from "./client";
import { WorkspaceStore } from "./workspace-store.ts";

const STORAGE_KEY = "rhine-host-column";
export const HOST_COLUMN = "SSH 主机";
export const HOST_LANES = [HOST_COLUMN, "主机阵列 II", "主机阵列 III", "主机阵列 IV", "主机阵列 V"] as const;
export const WORK_COLUMNS = [HOST_COLUMN, "会话", "文件", "监控", "命令", "历史", "快捷档案"] as const;
export type ResourceKind = "host" | "session" | "files" | "monitor" | "command" | "history" | "shortcut";
export type ResourceRef = { kind: ResourceKind; key: string; directory?: boolean; alias?: string; sessionKey?: string; path?: string };
export type ResourceCard = ResourceRef & { title: string; subtitle: string; state?: string };
const RESOURCE_KINDS: ResourceKind[] = ["host", "session", "files", "monitor", "command", "history", "shortcut"];
const PREFIXES = ["H", "S", "F", "M", "C", "R", "A"];
const ENGLISH = ["HOST ARCHIVES", "LIVE SESSIONS", "REMOTE FILES", "HOST TELEMETRY", "COMMAND LIBRARY", "SESSION HISTORY", "SSH SHORTCUTS"];
export type HostsLoader = () => Promise<SshHostsResult>;

function readPersisted(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return {};
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isSafeInteger(entry[1]) && entry[1] > 0));
  } catch { return {}; }
}

function record(id: string, title: string, en: string, abstract: string): ArchiveRecord {
  return { id, title, en, category: HOST_COLUMN, department: "SSH 主机", date: "本地连接档案",
    lead: "OpenSSH", clearance: "LOCAL ARCHIVE", abstract, findings: [], source: "" };
}

/** A dedicated runtime column. Authored archives never become host placeholders. */
export class SshHostCards {
  private byCard = new Map<number, SshHostEntry>();
  private byAlias = new Map<string, number>();
  private listeners = new Set<() => void>();
  private entries: SshHostEntry[] = [];
  private resources = new Map<number, ResourceRef>();
  private resourceNumbers = new Map<string, number>();
  readonly directoryCard: number;
  readonly workspace: boolean;
  readonly store: WorkspaceStore | undefined;
  configPath = "";
  profilesPath = "";
  loaded = false;

  constructor(workspace = false) {
    this.workspace = workspace;
    this.store = workspace ? new WorkspaceStore() : undefined;
    if (workspace) configureArchiveColumns(HOST_LANES, true);
    this.directoryCard = this.publish([])[0];
    if (workspace) for (const kind of RESOURCE_KINDS.slice(1)) this.publishResources(kind, []);
    if (workspace) this.publish([]);
    this.store?.onChange(() => this.assign(this.entries));
  }

  get lane() { return archiveColumns.indexOf(HOST_COLUMN); }
  hostAt(card: number) { return this.byCard.get(card); }
  cardOf(alias: string) { return this.byAlias.get(alias); }
  get bound(): readonly SshHostEntry[] { return this.entries; }
  get overflow(): readonly SshHostEntry[] { return []; }
  isDirectory(card: number) { return card === this.directoryCard; }
  resourceAt(card: number): ResourceRef | undefined {
    if (card === this.directoryCard) return { kind: "host", key: "directory", directory: true };
    const host = this.byCard.get(card);
    return host ? { kind: "host", key: host.alias, alias: host.alias } : this.resources.get(card);
  }
  resourceCard(kind: ResourceKind, key: string) {
    return [...this.resources].find(([, ref]) => ref.kind === kind && ref.key === key)?.[0];
  }
  publishResources(kind: ResourceKind, cards: readonly ResourceCard[]) {
    const lane = RESOURCE_KINDS.indexOf(kind);
    if (lane < 1) return;
    const entries = [{ kind, key: "directory", directory: true, title: WORK_COLUMNS[lane], subtitle: ENGLISH[lane] }, ...cards];
    const indexes = registerArchiveRecords(entries.map(entry => {
      const identity = `${kind}:${entry.key}`;
      if (!this.resourceNumbers.has(identity)) this.resourceNumbers.set(identity, this.store ? this.store.number(kind, entry.key, entry.directory) : entry.directory ? 0 :
        Math.max(0, ...[...this.resourceNumbers].filter(([key]) => key.startsWith(kind + ":")).map(([, n]) => n)) + 1);
      return { ...record(`${PREFIXES[lane]}-${String(this.resourceNumbers.get(identity)).padStart(3, "0")}`,
        entry.title, entry.subtitle, entry.subtitle), category: WORK_COLUMNS[lane], department: WORK_COLUMNS[lane],
        clearance: "state" in entry ? entry.state || "WORKSPACE" : "WORKSPACE" };
    }));
    for (const [index, ref] of this.resources) if (ref.kind === kind) this.resources.delete(index);
    indexes.forEach((index, i) => this.resources.set(index, entries[i]));
  }
  onChange(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async refresh(loader: HostsLoader): Promise<{ ok: boolean; error?: string }> {
    const result = await loader();
    if (!result.ok) return { ok: false, error: result.error ?? "无法读取主机档案" };
    this.configPath = result.configPath ?? "";
    this.profilesPath = result.profilesPath ?? "";
    this.loaded = true;
    this.assign(result.hosts ?? []);
    return { ok: true };
  }

  private publish(hosts: { host: SshHostEntry; slot: number }[]) {
    const entries = [
      record("H-000", "主机档案", "HOST ARCHIVES", "管理本机保存的连接、建立新会话与查看会话记录。"),
      ...hosts.map(({ host, slot }) => record(`H-${String(slot).padStart(3, "0")}`, hostLabel(host), hostLabel(host), hostSubtitle(host))),
    ];
    if (!this.workspace) return setArchiveExtension(HOST_COLUMN, entries);
    for (const shortcut of this.store!.shortcuts) {
      const number = this.store!.number("shortcut", shortcut.id);
      const entry = record(`A-${String(number).padStart(3, "0")}`, shortcut.name, "SSH SHORTCUT", shortcut.note || shortcut.path || "打开关联的 SSH 工作区");
      entry.clearance = ({ terminal: "TERMINAL", files: "DIRECTORY", monitor: "TELEMETRY", note: "NOTES", project: "PROJECT", tunnel: "TUNNEL" })[shortcut.kind];
      entries.push(entry);
    }
    entries.forEach((entry, index) => { entry.category = HOST_LANES[index % HOST_LANES.length]; });
    const indexes = registerArchiveRecords(entries);
    for (const [index, ref] of this.resources) if (ref.kind === "shortcut" && !ref.directory) this.resources.delete(index);
    this.store!.shortcuts.forEach((shortcut, i) => this.resources.set(indexes[hosts.length + 1 + i], { kind: "shortcut", key: shortcut.id, alias: shortcut.alias, path: shortcut.path }));
    for (const category of HOST_LANES) setArchiveExtension(category, entries.filter(entry => entry.category === category));
    return indexes;
  }

  private assign(hosts: SshHostEntry[]) {
    const saved = readPersisted();
    const layout = new Map<string, number>();
    const used = new Set<number>(Object.values(saved));
    const assigned = new Set<number>();
    const unique = [...new Map(hosts.map(host => [host.alias, host])).values()];
    for (const host of unique) {
      const slot = saved[host.alias];
      if (slot && !assigned.has(slot)) { layout.set(host.alias, slot); assigned.add(slot); }
    }
    let next = 1;
    for (const host of unique) {
      if (layout.has(host.alias)) continue;
      while (used.has(next)) next++;
      layout.set(host.alias, next); used.add(next++);
    }
    const ordered = unique.map(host => ({ host, slot: layout.get(host.alias)! })).sort((a, b) => a.slot - b.slot);
    const indices = this.publish(ordered);
    this.byAlias.clear(); this.byCard.clear();
    ordered.forEach(({ host }, index) => {
      this.byCard.set(indices[index + 1], host);
      this.byAlias.set(host.alias, indices[index + 1]);
    });
    this.entries = ordered.map(entry => entry.host);
    // Reserve removed numbers as well: a new host must not inherit an old
    // archive's identity or any bookmark that referred to it.
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...saved, ...Object.fromEntries(layout) })); } catch { /* Memory remains usable. */ }
    for (const listener of this.listeners) listener();
  }

  reset() {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* Memory remains usable. */ }
    this.assign(this.entries);
  }
}

export function hostSubtitle(host: SshHostEntry): string {
  if (host.hostname.startsWith("ssh://")) return host.hostname;
  const split = host.hostname.lastIndexOf("@");
  const address = host.hostname.slice(split + 1);
  const user = host.user || (split >= 0 ? host.hostname.slice(0, split) : "");
  const hostname = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
  const at = hostname ? `${user ? `${user}@` : ""}${hostname}` : user;
  return [at, host.port ? `:${host.port}` : ""].filter(Boolean).join("");
}
export const hostLabel = (host: SshHostEntry) => host.displayName || host.alias;
