/**
 * Which group each host belongs to.
 *
 * A view concept, like `rhine-host-column` — it never reaches the host profile
 * the main process stores, so grouping a machine cannot change how it connects.
 * A host may sit in several groups; the archive shows it once per group.
 */
export type HostGroup = { id: string; name: string; aliases: string[] };
export type HostGroupsData = { version: 1; groups: HostGroup[] };

export const HOST_GROUPS_KEY = "rhine.ssh.host-groups";
/** The archive renders one column per lane, so the lane pool bounds the groups. */
export const MAX_HOST_GROUPS = 9;
export const UNGROUPED = "未分组";

const text = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length <= limit && !value.includes("\0");
const validGroup = (value: unknown): value is HostGroup => {
  if (!value || typeof value !== "object") return false;
  const row = value as HostGroup;
  return (
    text(row.id, 100) &&
    Boolean(row.id) &&
    text(row.name, 80) &&
    Boolean(row.name.trim()) &&
    Array.isArray(row.aliases) &&
    row.aliases.length <= 1000 &&
    row.aliases.every((alias) => text(alias, 1024) && Boolean(alias))
  );
};
export function validateHostGroups(value: unknown): value is HostGroupsData {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as HostGroupsData).version === 1 &&
      Array.isArray((value as HostGroupsData).groups) &&
      (value as HostGroupsData).groups.length <= MAX_HOST_GROUPS &&
      (value as HostGroupsData).groups.every(validGroup) &&
      new Set((value as HostGroupsData).groups.map((row) => row.id)).size ===
        (value as HostGroupsData).groups.length,
  );
}

export class HostGroupStore {
  private data: HostGroupsData = { version: 1, groups: [] };
  private listeners = new Set<() => void>();
  private storage: Pick<Storage, "getItem" | "setItem">;
  /** Set when stored data could not be read; the raw value is left untouched. */
  error = "";
  private readOnly = false;

  constructor(storage: Pick<Storage, "getItem" | "setItem"> = localStorage) {
    this.storage = storage;
    try {
      const raw = storage.getItem(HOST_GROUPS_KEY);
      if (!raw) return;
      const value = JSON.parse(raw);
      if (!validateHostGroups(value))
        throw new Error("主机分组数据格式异常，原数据已保留");
      this.data.groups = value.groups.map((row) => ({
        id: row.id,
        name: row.name.trim(),
        aliases: [...new Set(row.aliases)],
      }));
    } catch (error) {
      this.readOnly = true;
      this.error =
        error instanceof Error ? error.message : "主机分组数据无法读取，原数据已保留";
    }
  }

  get groups(): readonly HostGroup[] {
    return this.data.groups;
  }
  get atLimit() {
    return this.data.groups.length >= MAX_HOST_GROUPS;
  }
  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  group(id: string) {
    return this.data.groups.find((row) => row.id === id);
  }
  /** Every group this alias is in, in group order. */
  groupsOf(alias: string) {
    return this.data.groups
      .filter((row) => row.aliases.includes(alias))
      .map((row) => row.id);
  }

  create(name: string) {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 80 || this.atLimit) return false;
    return this.write([
      ...this.data.groups,
      { id: crypto.randomUUID(), name: trimmed, aliases: [] },
    ]);
  }
  rename(id: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 80 || !this.group(id)) return false;
    return this.write(
      this.data.groups.map((row) =>
        row.id === id ? { ...row, name: trimmed } : row,
      ),
    );
  }
  remove(id: string) {
    if (!this.group(id)) return false;
    return this.write(this.data.groups.filter((row) => row.id !== id));
  }
  setMembership(alias: string, id: string, member: boolean) {
    if (!alias || !this.group(id)) return false;
    return this.write(
      this.data.groups.map((row) => {
        if (row.id !== id) return row;
        const aliases = member
          ? [...new Set([...row.aliases, alias])]
          : row.aliases.filter((value) => value !== alias);
        return { ...row, aliases };
      }),
    );
  }
  /** Drop aliases that no longer exist, so a removed host leaves no lane behind. */
  prune(liveAliases: readonly string[]) {
    const live = new Set(liveAliases);
    const next = this.data.groups.map((row) => ({
      ...row,
      aliases: row.aliases.filter((alias) => live.has(alias)),
    }));
    if (JSON.stringify(next) === JSON.stringify(this.data.groups)) return true;
    return this.write(next);
  }

  /**
   * The archive's columns, derived from the groups that actually hold a host.
   *
   * A group with no hosts deliberately gets no column: every lane the scene
   * renders has to have records behind it, so an empty one would either render
   * blank or fall back to repeating another group's files.
   */
  lanes(liveAliases: readonly string[]) {
    const live = new Set(liveAliases);
    const lanes = this.data.groups
      .filter((row) => row.aliases.some((alias) => live.has(alias)))
      .map((row) => row.name);
    const ungrouped = liveAliases.filter(
      (alias) => !this.data.groups.some((row) => row.aliases.includes(alias)),
    );
    if (ungrouped.length) lanes.push(UNGROUPED);
    return lanes.length ? lanes : [UNGROUPED];
  }

  private write(groups: HostGroup[]) {
    if (this.readOnly) {
      this.error = "主机分组数据无法写入，已保留原数据";
      return false;
    }
    const next: HostGroupsData = { version: 1, groups };
    if (!validateHostGroups(next)) return false;
    try {
      this.storage.setItem(HOST_GROUPS_KEY, JSON.stringify(next));
    } catch {
      this.error = "主机分组无法保存";
      return false;
    }
    this.data = next;
    for (const listener of this.listeners) listener();
    return true;
  }
}
