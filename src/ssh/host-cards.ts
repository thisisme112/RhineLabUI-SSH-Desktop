import { archiveColumns, configureArchiveColumns, setArchiveExtension, registerArchiveRecords, type ArchiveRecord } from "../data.ts";
import type { SshHostEntry, SshHostsResult } from "./client";
import { HostGroupStore, UNGROUPED } from "./host-groups.ts";
import { WorkspaceStore } from "./workspace-store.ts";

const STORAGE_KEY = "rhine-host-column";
export const HOST_COLUMN = "SSH 主机";
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
  /** The last cards handed to `publishResources`, so a lane rebuild can re-register
   *  them: `configureArchiveColumns` clears the record table they live in. */
  private resourceCards = new Map<ResourceKind, readonly ResourceCard[]>();
  /** Re-resolved on every publish: a lane rebuild clears the record table, so
   *  the directory's index is not fixed for the life of the catalogue. */
  directoryCard = 0;
  readonly workspace: boolean;
  readonly store: WorkspaceStore | undefined;
  /** Which group each host belongs to. Desktop only, like the workspace store. */
  readonly groups: HostGroupStore;
  private lanes: string[] = [HOST_COLUMN];
  configPath = "";
  profilesPath = "";
  loaded = false;

  constructor(workspace = false) {
    this.workspace = workspace;
    this.store = workspace ? new WorkspaceStore() : undefined;
    this.groups = new HostGroupStore();
    if (workspace) {
      this.lanes = this.groups.lanes([]);
      // No filler: an empty lane would repeat another group's files.
      configureArchiveColumns(this.lanes, false);
    }
    this.publish([]);
    if (workspace) for (const kind of RESOURCE_KINDS.slice(1)) this.publishResources(kind, []);
    if (workspace) this.publish([]);
    this.store?.onChange(() => this.assign(this.entries));
    this.groups.onChange(() => this.assign(this.entries));
  }

  get lane() { return archiveColumns.indexOf(this.lanes[0]); }
  /** The lane names the archive is currently showing, in column order. */
  get laneNames(): readonly string[] { return this.lanes; }
  /** The group ids a host belongs to. */
  groupsOf(alias: string) {
    return this.groups.groupsOf(alias);
  }
  /** The group names a host is listed under, in column order. */
  laneNamesFor(alias: string): readonly string[] {
    return this.lanesFor(alias, this.workspace ? this.lanes : [HOST_COLUMN]);
  }
  /** Whether a lane belongs to this catalogue. With grouping every group lane
   *  does, not just the first, so callers cannot compare against `lane`. */
  ownsLane(lane: number) {
    const name = archiveColumns[lane];
    return name === undefined
      ? false
      : this.workspace
        ? this.lanes.includes(name)
        : name === HOST_COLUMN;
  }
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
    this.resourceCards.set(kind, cards);
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

  /**
   * One record per host per lane it belongs to.
   *
   * A record's lane is derived from its `category`, so a host in two groups
   * cannot be one record in two columns — it is two records that carry the same
   * card number and differ only in id. The first lane also holds the directory
   * card and the shortcut archives, which belong to no group.
   */
  private publish(hosts: { host: SshHostEntry; slot: number }[]) {
    const lanes = this.workspace ? this.lanes : [HOST_COLUMN];
    const entry = (lane: string, id: string, title: string, en: string, abstract: string) => {
      const row = record(id, title, en, abstract);
      row.category = lane;
      return row;
    };
    const entries: ArchiveRecord[] = [
      entry(lanes[0], "H-000", "主机档案", "HOST ARCHIVES", "管理本机保存的连接、建立新会话与查看会话记录。"),
    ];
    // Position in `entries` is not the registered index — `registerArchiveRecords`
    // reuses the index of a record it has seen before — so placement is recorded
    // against the array and resolved through the indexes it hands back.
    const placement: { at: number; host: SshHostEntry; lane: string }[] = [];
    for (const { host, slot } of hosts) {
      const number = `H-${String(slot).padStart(3, "0")}`;
      this.lanesFor(host.alias, lanes).forEach((lane, index) => {
        const row = entry(lane, index === 0 ? number : `${number}@${lane}`, hostLabel(host), hostLabel(host), hostSubtitle(host));
        row.label = number;
        placement.push({ at: entries.push(row) - 1, host, lane });
      });
    }
    if (!this.workspace) {
      const indexes = setArchiveExtension(HOST_COLUMN, entries);
      this.directoryCard = indexes[0];
      return { members: placement.map(item => ({ card: indexes[item.at], host: item.host, lane: item.lane })) };
    }
    const shortcutStart = entries.length;
    for (const shortcut of this.store!.shortcuts) {
      const number = this.store!.number("shortcut", shortcut.id);
      const row = entry(lanes[0], `A-${String(number).padStart(3, "0")}`, shortcut.name, "SSH SHORTCUT", shortcut.note || shortcut.path || "打开关联的 SSH 工作区");
      row.clearance = ({ terminal: "TERMINAL", files: "DIRECTORY", monitor: "TELEMETRY", note: "NOTES", project: "PROJECT", tunnel: "TUNNEL" })[shortcut.kind];
      entries.push(row);
    }
    const registered = registerArchiveRecords(entries);
    this.directoryCard = registered[0];
    for (const [index, ref] of this.resources) if (ref.kind === "shortcut" && !ref.directory) this.resources.delete(index);
    this.store!.shortcuts.forEach((shortcut, i) => this.resources.set(registered[shortcutStart + i], { kind: "shortcut", key: shortcut.id, alias: shortcut.alias, path: shortcut.path }));
    for (const lane of lanes) setArchiveExtension(lane, entries.filter(row => row.category === lane));
    return { members: placement.map(item => ({ card: registered[item.at], host: item.host, lane: item.lane })) };
  }

  /** The lanes a host appears in: every group it is in, or the ungrouped lane. */
  private lanesFor(alias: string, lanes: readonly string[]) {
    if (!this.workspace) return [lanes[0]];
    const names = this.groups
      .groupsOf(alias)
      .map(id => this.groups.group(id)?.name ?? "")
      .filter(name => lanes.includes(name));
    // No group means the ungrouped lane, which `lanes()` only omits when no
    // ungrouped host is left — and then this is not called for one.
    return names.length ? names : [UNGROUPED];
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
    const aliases = ordered.map(entry => entry.host.alias);
    // Grouping follows the hosts that exist: a removed host must not keep a lane
    // alive, and a new group only becomes a column once something is in it.
    if (this.workspace) {
      this.groups.prune(aliases);
      const lanes = this.groups.lanes(aliases);
      if (lanes.join(" ") !== this.lanes.join(" ")) {
        this.lanes = lanes;
        // Reconfiguring clears the record table, so everything registered in it
        // — the resource lanes included — has to be put back.
        configureArchiveColumns(lanes, false);
        for (const [kind, cards] of this.resourceCards) this.publishResources(kind, cards);
      }
    }
    const { members } = this.publish(ordered);
    this.byAlias.clear(); this.byCard.clear();
    for (const { card, host } of members) {
      this.byCard.set(card, host);
      if (!this.byAlias.has(host.alias)) this.byAlias.set(host.alias, card);
    }
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
