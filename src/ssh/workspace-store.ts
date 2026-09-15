export type CommandSnippet = { id: string; name: string; command: string; note: string };
export type DirectoryBookmark = { id: string; alias: string; path: string; name: string };
export type WorkspaceLayout = { width: number; page: "terminal" | "files" | "monitor"; splitAlias?: string; splitRatio?: number };
export type ArchiveShortcut = {
  id: string; name: string; kind: "terminal" | "files" | "monitor" | "note" | "project" | "tunnel";
  alias: string; path: string; note: string; autoOpen: boolean;
  group?: string; pinned?: boolean; order?: number;
  tmux?: string; layout?: WorkspaceLayout;
  tunnel?: { localPort: number; host: string; port: number };
};
export type WorkspaceData = {
  version: 1;
  commands: CommandSnippet[];
  bookmarks: DirectoryBookmark[];
  numbers: Record<string, number>;
  layouts: Record<string, WorkspaceLayout>;
  shortcuts: ArchiveShortcut[];
};
const KEY = "rhine.ssh.workspace";
const empty = (): WorkspaceData => ({ version: 1, commands: [], bookmarks: [], numbers: {}, layouts: {}, shortcuts: [] });
const text = (value: unknown, limit: number): value is string => typeof value === "string" && value.length <= limit && !value.includes("\0");
function validShortcut(value: unknown): value is ArchiveShortcut {
  if (!value || typeof value !== "object") return false;
  const row = value as ArchiveShortcut;
  return text(row.id, 100) && Boolean(row.id) && text(row.name, 100) && Boolean(row.name.trim()) &&
    ["terminal", "files", "monitor", "note", "project", "tunnel"].includes(row.kind) &&
    text(row.alias, 1024) && (row.kind === "note" || Boolean(row.alias)) &&
    text(row.note, 16000) && typeof row.autoOpen === "boolean" && text(row.path, 4096) &&
    (!row.path || row.path.startsWith("/") && !/[\x00-\x1f\x7f]/.test(row.path)) &&
    (!["files", "project"].includes(row.kind) || Boolean(row.path)) &&
    (row.group === undefined || text(row.group, 80)) &&
    (row.pinned === undefined || typeof row.pinned === "boolean") &&
    (row.order === undefined || Number.isSafeInteger(row.order) && Math.abs(row.order) <= 1000000) &&
    (row.tmux === undefined || text(row.tmux, 80) && (!row.tmux || /^[a-zA-Z0-9_-]+$/.test(row.tmux))) &&
    (row.layout === undefined || validLayout(row.layout)) &&
    (row.kind !== "tunnel" || Boolean(row.tunnel && Number.isInteger(row.tunnel.localPort) && row.tunnel.localPort >= 0 && row.tunnel.localPort <= 65535 && text(row.tunnel.host, 253) && /^[a-zA-Z0-9.:[\]_-]+$/.test(row.tunnel.host) && Number.isInteger(row.tunnel.port) && row.tunnel.port > 0 && row.tunnel.port <= 65535));
}
export function validLayout(layout: WorkspaceLayout) {
  return layout && Number.isFinite(layout.width) && layout.width >= 260 && layout.width <= 480 && ["terminal", "files", "monitor"].includes(layout.page) &&
    (layout.splitAlias === undefined || text(layout.splitAlias, 1024)) &&
    (layout.splitRatio === undefined || Number.isFinite(layout.splitRatio) && layout.splitRatio >= .25 && layout.splitRatio <= .75);
}
export function validateWorkspace(value: unknown): value is WorkspaceData {
  if (!value || typeof value !== "object") return false;
  const data = value as WorkspaceData;
  return data.version === 1 && Array.isArray(data.commands) && data.commands.length <= 1000 && data.commands.every(row => row && text(row.id, 100) && !!row.id && text(row.name, 100) && text(row.command, 16384) && text(row.note, 1000) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(row.command)) &&
    Array.isArray(data.bookmarks) && data.bookmarks.length <= 1000 && data.bookmarks.every(row => row && text(row.id, 100) && text(row.alias, 1024) && text(row.path, 4096) && row.path.startsWith("/") && !/[\x00-\x1f\x7f]/.test(row.path) && text(row.name, 100)) &&
    Array.isArray(data.shortcuts) && data.shortcuts.length <= 1000 && data.shortcuts.every(validShortcut) && new Set(data.shortcuts.map(row => row.id)).size === data.shortcuts.length &&
    new Set(data.commands.map(row => row.id)).size === data.commands.length && new Set(data.bookmarks.map(row => row.id)).size === data.bookmarks.length &&
    !!data.layouts && !Array.isArray(data.layouts) && typeof data.layouts === "object" && Object.keys(data.layouts).length <= 5000 && Object.values(data.layouts).every(validLayout);
}

/** Local library only. No credentials, session restoration or command execution. */
export class WorkspaceStore {
  private data = empty();
  private listeners = new Set<() => void>();
  private storage: Pick<Storage, "getItem" | "setItem">;
  error = "";
  private readOnly = false;
  constructor(storage: Pick<Storage, "getItem" | "setItem"> = localStorage) {
    this.storage = storage;
    try {
      const raw = storage.getItem(KEY);
      if (!raw) return;
      const value = JSON.parse(raw);
      if (value?.version !== 1 || !Array.isArray(value.commands) || !Array.isArray(value.bookmarks))
        throw new Error("工作区资料版本无法读取，原数据已保留");
      if (value.commands.length > 1000 || value.bookmarks.length > 1000) throw new Error("工作区资料超过可读取范围");
      for (const row of value.commands) if (!text(row.id, 100) || !text(row.name, 100) || !text(row.command, 16384) || !text(row.note, 1000)) throw new Error("命令资料格式异常，原数据已保留");
      for (const row of value.bookmarks) if (!text(row.id, 100) || !text(row.alias, 1024) || !text(row.path, 4096) || !text(row.name, 100)) throw new Error("目录资料格式异常，原数据已保留");
      this.data.commands = value.commands;
      this.data.bookmarks = value.bookmarks;
      const shortcuts = value.shortcuts ?? [];
      if (!Array.isArray(shortcuts) || shortcuts.length > 1000 || shortcuts.some(row => !validShortcut(row)) || new Set(shortcuts.map(row => row.id)).size !== shortcuts.length) throw new Error("快捷档案格式异常，原数据已保留");
      this.data.shortcuts = shortcuts;
      for (const [key, number] of Object.entries(value.numbers || {}))
        if (Number.isSafeInteger(number) && Number(number) >= 0 && key.length <= 1200) this.data.numbers[key] = Number(number);
      for (const [key, layout] of Object.entries(value.layouts || {}) as [string, WorkspaceLayout][])
        if (layout && Number.isFinite(layout.width) && ["terminal", "files", "monitor"].includes(layout.page))
          this.data.layouts[key] = { width: Math.max(260, Math.min(480, layout.width)), page: layout.page, ...(typeof layout.splitAlias === "string" ? { splitAlias: layout.splitAlias, splitRatio: Math.max(.25, Math.min(.75, layout.splitRatio || .5)) } : {}) };
    } catch (error) {
      this.readOnly = true;
      this.error = error instanceof Error ? error.message : "工作区资料无法读取，原数据已保留";
    }
  }
  get commands(): readonly CommandSnippet[] { return this.data.commands; }
  get bookmarks(): readonly DirectoryBookmark[] { return this.data.bookmarks; }
  get shortcuts(): readonly ArchiveShortcut[] { return [...this.data.shortcuts].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (a.group || "").localeCompare(b.group || "") || (a.order || 0) - (b.order || 0)); }
  snapshot(): WorkspaceData { return structuredClone(this.data); }
  merge(value: WorkspaceData) {
    if (!validateWorkspace(value)) { this.error = "导入的工作区资料格式无效"; return false; }
    const merge = <T extends { id: string }>(a: T[], b: T[]) => [...new Map([...a, ...b].map(row => [row.id, row])).values()];
    const next = { ...this.data, commands: merge(this.data.commands, value.commands), bookmarks: merge(this.data.bookmarks, value.bookmarks), shortcuts: merge(this.data.shortcuts, value.shortcuts), layouts: { ...this.data.layouts, ...value.layouts } };
    if (!validateWorkspace(next)) { this.error = "合并后的资料超过存储限制"; return false; }
    return this.write(next);
  }
  saveShortcut(input: Omit<ArchiveShortcut, "id"> & { id?: string }) {
    const row: ArchiveShortcut = { id: input.id || crypto.randomUUID(), name: input.name.trim(), kind: input.kind, alias: input.kind === "note" ? "" : input.alias,
      path: ["terminal", "files", "project"].includes(input.kind) ? input.path.trim() : "", note: input.note, autoOpen: input.kind !== "note" && input.autoOpen,
      group: input.group?.trim() || "", pinned: !!input.pinned, order: input.order || 0,
      ...(input.kind === "project" ? { tmux: input.tmux || "", layout: input.layout || { width: 320, page: "files" } } : {}),
      ...(input.kind === "tunnel" ? { tunnel: input.tunnel } : {}) };
    if (!validShortcut(row)) {
      this.error = "请检查名称、主机、绝对目录、端口和 tmux 名称（字母、数字、下划线或连字符）"; return false;
    }
    const shortcuts = [...this.data.shortcuts]; const index = shortcuts.findIndex(s => s.id === row.id);
    if (index < 0) { if (shortcuts.length >= 1000) { this.error = "最多保存 1000 份快捷档案"; return false; } shortcuts.push(row); } else shortcuts[index] = row;
    return this.write({ ...this.data, shortcuts });
  }
  removeShortcut(id: string) { return this.write({ ...this.data, shortcuts: this.data.shortcuts.filter(s => s.id !== id) }); }
  moveShortcut(id: string, direction: -1 | 1) {
    const rows = [...this.shortcuts]; const index = rows.findIndex(row => row.id === id); const next = index + direction;
    if (index < 0 || !rows[next] || rows[index].group !== rows[next].group || !!rows[index].pinned !== !!rows[next].pinned) return false;
    [rows[index], rows[next]] = [rows[next], rows[index]];
    return this.write({ ...this.data, shortcuts: rows.map((row, order) => ({ ...row, order })) });
  }
  onChange(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private write(next: WorkspaceData, emit = true) {
    if (this.readOnly) return false;
    try {
      this.storage.setItem(KEY, JSON.stringify(next));
      this.data = next; this.error = "";
      if (emit) for (const listener of this.listeners) listener();
      return true;
    } catch {
      this.error = "本机存储空间不足，修改尚未保存";
      return false;
    }
  }
  number(kind: string, key: string, directory = false) {
    const identity = kind + ":" + key;
    if (this.data.numbers[identity] !== undefined) return this.data.numbers[identity];
    const next = directory ? 0 : Math.max(0, ...Object.entries(this.data.numbers).filter(([id]) => id.startsWith(kind + ":")).map(([, value]) => value)) + 1;
    const numbers = { ...this.data.numbers, [identity]: next };
    if (!this.write({ ...this.data, numbers }, false)) this.data.numbers = numbers;
    return next;
  }
  saveCommand(input: Omit<CommandSnippet, "id"> & { id?: string }) {
    const row = { ...input, id: input.id || crypto.randomUUID(), name: input.name.trim(), command: input.command.replace(/[\r\n]+$/, ""), note: input.note.trim() };
    if (!row.name || !row.command.trim() || !text(row.name, 100) || !text(row.command, 16384) || !text(row.note, 1000) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(row.command)) {
      this.error = "请填写名称和命令；命令不能包含终端控制字符"; return false;
    }
    const commands = [...this.data.commands];
    const index = commands.findIndex(item => item.id === row.id);
    if (index < 0) { if (commands.length >= 1000) { this.error = "命令库已达到 1000 条"; return false; } commands.push(row); }
    else commands[index] = row;
    return this.write({ ...this.data, commands });
  }
  saveBookmark(input: Omit<DirectoryBookmark, "id"> & { id?: string }) {
    const existing = this.data.bookmarks.find(row => row.alias === input.alias && row.path === input.path);
    const row = { ...input, id: input.id || existing?.id || crypto.randomUUID(), name: input.name.trim() };
    if (!row.name || !row.alias || !row.path.startsWith("/") || !text(row.name, 100) || !text(row.path, 4096) || !text(row.alias, 1024)) {
      this.error = "请选择主机，填写名称和以 / 开头的远端目录"; return false;
    }
    const bookmarks = [...this.data.bookmarks];
    const index = bookmarks.findIndex(item => item.id === row.id);
    if (index < 0) { if (bookmarks.length >= 1000) { this.error = "目录收藏已达到 1000 条"; return false; } bookmarks.push(row); }
    else bookmarks[index] = row;
    return this.write({ ...this.data, bookmarks });
  }
  remove(kind: "command" | "bookmark", id: string) {
    return this.write({ ...this.data, ...(kind === "command" ? { commands: this.data.commands.filter(row => row.id !== id) } : { bookmarks: this.data.bookmarks.filter(row => row.id !== id) }) });
  }
  layout(alias: string) { return this.data.layouts[alias]; }
  saveLayout(alias: string, layout: WorkspaceLayout) {
    if (!alias) return;
    this.write({ ...this.data, layouts: { ...this.data.layouts, [alias]: layout } }, false);
  }
}
