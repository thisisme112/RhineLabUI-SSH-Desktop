import { escapeHtml as esc } from "../html";
import { records } from "../data";
import { hostLabel, type ResourceKind, type ResourceRef, type ResourceCard, type SshHostCards } from "./host-cards";
import type { SshSessionBank, WorkspaceSession } from "./session-bank";
import type { SessionRecordSummary } from "./client";
import { bytes, percent } from "./services";
import type { CommandSnippet, DirectoryBookmark } from "./workspace-store";
import { SshPageMotion } from "./page-motion";
import { ShortcutPanel } from "./shortcuts";
import type { ArchiveShortcut } from "./workspace-store";
import { snippetParameters, expandSnippet } from "./snippets";
import "./library.css";

const titles: Record<ResourceKind, [string, string, string]> = {
  host: ["HOST ARCHIVES", "主机", "保存与连接远端主机"],
  session: ["LIVE SESSIONS", "会话", "切换连接，继续各自的工作"],
  files: ["REMOTE FILES", "文件", "远端目录收藏与文件传输"],
  monitor: ["HOST TELEMETRY", "监控", "主机状态与逐秒 GPU 读数"],
  command: ["COMMAND LIBRARY", "命令", "常用片段，选定会话后插入"],
  history: ["SESSION HISTORY", "历史", "会话记录、事件与导出"],
  shortcut: ["SSH SHORTCUTS", "快捷档案", "主机、目录、监控与可编辑笔记"],
};
const busy = (state: string) => ["queued", "scanning", "transferring", "committing", "conflict"].includes(state);
export const sessionLabel = (session: WorkspaceSession) => session.client.displayTarget || session.descriptor?.displayName || session.descriptor?.target || "SSH";
export const sessionState = (session: WorkspaceSession) => session.client.pendingPrompt || session.services.state?.prompt ? "等待认证" : session.recovery || (session.client.active && session.client.status().phase === "idle" ? "正在连接" : session.client.status().label);
const when = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });
type Row = { key: string; title: string; subtitle: string; state: string; tone?: string };

export class SshLibrary {
  private shortcuts: ShortcutPanel;
  private root: HTMLElement | null = null;
  private ref: ResourceRef | null = null;
  private mountedCard = -1;
  private query = "";
  private rows = new Map<string, HTMLElement>();
  private abort?: AbortController;
  private motion = new SshPageMotion();
  private records: SessionRecordSummary[] = [];
  private historyError = "";
  private historyLoading = false;
  private historyRequest = 0;
  private offStore: () => void;
  private edit: { kind: "command" | "bookmark"; id?: string } | null = null;
  private removeArmed = "";
  private selection = new Map<ResourceKind, string>();
  private selectionHTML = "";
  revision = 0;
  constructor(private cards: SshHostCards, private bank: SshSessionBank, private actions: {
    reduced(): boolean;
    openCard(card: number): void;
    openSession(session: WorkspaceSession, page?: "terminal" | "files" | "monitor", path?: string, transfers?: boolean): void;
    connect(alias: string, path?: string): void;
    openHosts(): void;
    insert(session: WorkspaceSession, text: string): void;
    stop(session: WorkspaceSession): void;
    removeSession(session: WorkspaceSession): void;
    record(file: string): void;
    notify(message: string): void;
    shortcut(row: ArchiveShortcut): void;
  }) {
    this.shortcuts = new ShortcutPanel(cards, actions.shortcut);
    this.offStore = cards.store!.onChange(() => this.refresh());
    this.refresh();
    void this.reloadHistory();
  }
  refresh() {
    const sessions = this.bank.visibleSessions;
    const live = sessions.filter(session => session.client.active);
    this.cards.publishResources("session", sessions.map(session => ({ kind: "session", key: session.key, sessionKey: session.key,
      alias: session.descriptor?.target, title: sessionLabel(session), subtitle: "SESSION / " + sessionState(session), state: sessionState(session) })));
    this.cards.publishResources("files", [
      ...live.map(session => ({ kind: "files" as const, key: "session:" + session.key, sessionKey: session.key, alias: session.descriptor?.target,
        title: sessionLabel(session), subtitle: "SFTP / " + (session.services.state?.sftp.message.split("\n")[0] || "等待文件通道"), state: "SFTP" })),
      ...this.cards.store!.bookmarks.map(bookmark => ({ kind: "files" as const, key: "bookmark:" + bookmark.id, alias: bookmark.alias, path: bookmark.path,
        title: bookmark.name, subtitle: bookmark.path, state: "DIRECTORY" })),
    ]);
    this.cards.publishResources("monitor", live.map(session => ({ kind: "monitor", key: session.key, sessionKey: session.key, alias: session.descriptor?.target,
      title: sessionLabel(session), subtitle: "CPU / MEMORY / GPU", state: session.services.state?.monitor.state === "ready" ? "LIVE" : "WAITING" })));
    this.cards.publishResources("command", this.cards.store!.commands.map(row => ({ kind: "command", key: row.id, title: row.name, subtitle: row.command, state: "COMMAND" })));
    this.cards.publishResources("history", this.records.map(row => ({ kind: "history", key: row.file, alias: row.target, title: row.targetLabel || row.target,
      subtitle: when(row.startedAt), state: row.outcome })));
    this.revision++;
    this.shortcuts.refresh();
    this.updateRows();
  }
  async reloadHistory() {
    const request = ++this.historyRequest;
    this.historyLoading = true;
    try {
      const result = await window.rhineDesktop?.records?.list();
      if (request !== this.historyRequest) return;
      if (!result?.ok) throw new Error(result?.error || "会话记录暂时无法读取");
      this.records = result.records;
      this.historyError = "";
    } catch (error) {
      this.historyError = error instanceof Error ? error.message : String(error);
    } finally {
      if (request === this.historyRequest) { this.historyLoading = false; this.refresh(); }
    }
  }
  mount(root: HTMLElement, card: number) {
    this.unmount();
    const ref = this.cards.resourceAt(card);
    if (!ref || ref.kind === "host") return;
    if (ref.kind === "shortcut") { this.shortcuts.mount(root, ref.directory ? undefined : ref.key); return; }
    this.root = root; this.ref = ref; this.mountedCard = card;
    this.query = ""; this.edit = null; this.removeArmed = "";
    const [english, chinese, description] = titles[ref.kind];
    root.classList.add("ssh-library");
    root.dataset.sshPage = ref.kind;
    root.innerHTML = `<div class="detail-kicker"><span>FILE ${esc(records[card].id)}</span><span class="ssh-library-count"></span></div>
      <h2>${esc(ref.directory ? english : records[card].title)}</h2><div class="detail-title-cn">${esc(ref.directory ? chinese : description)}<span>${esc(chinese)}</span></div><div class="detail-rule"></div>
      <p class="ssh-library-intro">${esc(description)}</p>
      <div class="ssh-library-toolbar"><input type="search" aria-label="筛选${esc(chinese)}" placeholder="筛选${esc(chinese)}" autocomplete="off"><div class="ssh-library-tools">${this.tools(ref)}</div></div>
      <div class="ssh-library-overview" role="status"></div>
      <div class="ssh-library-list"></div><div class="ssh-library-empty" role="status"></div>
      <div class="ssh-library-selection"></div><form class="ssh-library-editor" hidden></form>
      <p class="ssh-library-feedback" role="status"></p>
      <div class="detail-footnote"><span>RHINE LAB / ${esc(english)}</span><span>${esc(records[card].id)}</span></div>`;
    this.abort = new AbortController();
    root.querySelector("input")!.addEventListener("input", event => { this.query = (event.target as HTMLInputElement).value; this.updateRows(); }, { signal: this.abort.signal });
    root.addEventListener("click", event => {
      const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-library-action]") : null;
      if (!target) return;
      event.stopPropagation();
      void this.action(target.dataset.libraryAction!, target.dataset.key || "");
    }, { signal: this.abort.signal });
    root.querySelector("form")!.addEventListener("submit", event => { event.preventDefault(); this.saveEditor(); }, { signal: this.abort.signal });
    root.addEventListener("input", event => { if ((event.target as HTMLElement).matches("[data-snippet-param]")) this.previewSnippet(); }, { signal: this.abort.signal });
    this.updateRows();
    if (!ref.directory) this.showSelection(ref.key);
    if (this.cards.store?.error) this.feedback(this.cards.store.error);
  }
  unmount() {
    this.shortcuts.unmount();
    this.abort?.abort(); this.motion.cancel(); this.rows.clear();
    this.root?.classList.remove("ssh-library");
    this.root = null; this.ref = null; this.selectionHTML = "";
  }
  private tools(ref: ResourceRef) {
    const button = (action: string, label: string) => `<button type="button" data-library-action="${action}">${label}</button>`;
    if (ref.kind === "session") return button("hosts", "建立连接 ＋");
    if (ref.kind === "files") return button("new-bookmark", "收藏目录 ＋");
    if (ref.kind === "monitor") return button("hosts", "连接主机 ↗");
    if (ref.kind === "command") return button("new-command", "新建命令 ＋");
    return button("refresh-history", "刷新 ↻") + button("prune", "清理过期记录");
  }
  private list(): Row[] {
    if (!this.ref) return [];
    const sessions = this.bank.visibleSessions;
    const makeSession = (session: WorkspaceSession): Row => ({ key: session.key, title: this.sessionName(session), subtitle: session.client.target || session.descriptor?.target || "",
      state: sessionState(session), tone: session.client.pendingPrompt || session.services.state?.prompt ? "waiting" : session.client.active ? "connected" : "ended" });
    switch (this.ref.kind) {
      case "session": return sessions.map(makeSession);
      case "files": return [
        ...sessions.filter(session => session.client.active).map(session => ({ ...makeSession(session), key: "session:" + session.key,
          subtitle: session.panel.directory || "远端文件", state: session.services.state?.sftp.message.split("\n")[0] || "等待文件通道" })),
        ...this.cards.store!.bookmarks.map(row => ({ key: "bookmark:" + row.id, title: row.name, subtitle: this.aliasLabel(row.alias) + " · " + row.path, state: "目录收藏", tone: "directory" })),
      ];
      case "monitor": return sessions.filter(session => session.client.active).map(session => {
        const state = session.services.state, sample = state?.sample;
        return { ...makeSession(session), subtitle: sample ? `CPU ${percent(sample.cpu?.usage)} · 内存 ${percent(sample.memory?.total ? sample.memory.used / sample.memory.total * 100 : null)} · GPU ${sample.gpus.length}` : state?.monitor.message.split("\n")[0] || "等待监控通道",
          state: sample ? Date.now() - state!.receivedAt > 3500 ? "数据已过期" : "每秒更新" : "等待数据", tone: "telemetry" };
      });
      case "command": return this.cards.store!.commands.map(row => ({ key: row.id, title: row.name, subtitle: row.command, state: "插入命令", tone: "command" }));
      case "history": return this.records.map(row => ({ key: row.file, title: row.targetLabel || this.aliasLabel(row.target), subtitle: when(row.startedAt) + ` · ${Math.round(row.durationMs / 1000)} 秒`, state: row.outcome, tone: "ended" }));
      default: return [];
    }
  }
  private updateRows() {
    if (!this.root || !this.ref) return;
    const list = this.list();
    const query = this.query.trim().toLocaleLowerCase();
    const filtered = list.filter(row => (this.ref!.directory || row.key === this.ref!.key) && (!query || `${row.title} ${row.subtitle} ${row.state}`.toLocaleLowerCase().includes(query)));
    this.root.querySelector(".ssh-library-count")!.textContent = String(list.length).padStart(2, "0") + " ENTRIES";
    const holder = this.root.querySelector(".ssh-library-list")!;
    const existing = new Set(filtered.map(row => row.key));
    for (const [key, node] of this.rows) if (!existing.has(key)) { node.remove(); this.rows.delete(key); }
    filtered.forEach((row, index) => {
      let node = this.rows.get(row.key);
      if (!node) {
        node = document.createElement("button"); node.className = "ssh-library-row"; node.setAttribute("type", "button");
        node.dataset.libraryAction = "open"; node.dataset.key = row.key;
        node.innerHTML = '<span class="ssh-library-row-main"><strong></strong><small></small></span><span class="ssh-library-state"></span><span aria-hidden="true">↗</span>';
        this.rows.set(row.key, node);
      }
      node.dataset.tone = row.tone || "";
      const content: [string, string][] = [["strong", row.title], ["small", row.subtitle], [".ssh-library-state", row.state]];
      for (const [selector, value] of content) { const part = node.querySelector(selector)!; if (part.textContent !== value) part.textContent = value; }
      if (holder.children[index] !== node) holder.insertBefore(node, holder.children[index] || null);
    });
    const empty = this.root.querySelector<HTMLElement>(".ssh-library-empty")!;
    empty.hidden = filtered.length > 0;
    empty.textContent = query ? "没有匹配的内容。" : this.ref.kind === "history" ? this.historyError || (this.historyLoading ? "正在读取会话记录…" : "还没有会话记录，连接结束后会自动归档。") :
      ({ session: "还没有会话。从主机列建立连接后，会话会出现在这里。", files: "还没有目录收藏或文件通道。可连接主机，也可以先收藏远端路径。", monitor: "连接主机后，这里会显示 CPU、内存和 GPU 状态。", command: "命令库为空。新建常用命令后，可选择会话插入。", host: "" } as Record<string, string>)[this.ref.kind];
    const overview = this.root.querySelector<HTMLElement>(".ssh-library-overview")!;
    const jobs = this.bank.visibleSessions.flatMap(session => session.services.state?.jobs || []);
    overview.textContent = this.ref.kind === "files" ? `传输 / ${jobs.filter(job => busy(job.state)).length} 进行中 · ${jobs.filter(job => job.state === "failed" || job.state === "uncertain").length} 需处理` : this.ref.kind === "session" ? `${this.bank.visibleSessions.filter(session => session.client.active).length} 个连接运行中 · Ctrl+Tab 切换会话` : "";
    const selected = this.ref.directory ? this.selection.get(this.ref.kind) : this.ref.key;
    if (selected && !this.edit) this.showSelection(selected, false);
    if (this.ref.kind === "command") this.updateSessionPicker();
  }
  private aliasLabel(alias: string) { const host = this.cards.bound.find(host => host.alias === alias); return host ? hostLabel(host) : alias; }
  private sessionName(session: WorkspaceSession) { return `${records[this.cards.resourceCard("session", session.key) ?? -1]?.id || "SSH"} / ${sessionLabel(session)}`; }
  private feedback(message: string) { const target = this.root?.querySelector(".ssh-library-feedback"); if (target) target.textContent = message; }
  private findSession(key: string) { return this.bank.byKey(key.replace(/^session:/, "")); }
  private showSelection(key: string, animate = true) {
    if (!this.root || !this.ref) return;
    if (this.selection.get(this.ref.kind) !== key) this.removeArmed = "";
    this.selection.set(this.ref.kind, key);
    const target = this.root.querySelector(".ssh-library-selection")!;
    if (!this.list().some(row => row.key === key)) {
      target.replaceChildren(); this.selectionHTML = ""; return;
    }
    const button = (action: string, label: string) => `<button type="button" data-library-action="${action}" data-key="${esc(key)}">${label}</button>`;
    let html = "";
    if (this.ref.kind === "command") {
      const row = this.cards.store!.commands.find(row => row.id === key);
      if (!row) return;
      html = `<div class="panel-label">${esc(row.name)}</div>${snippetParameters(row.command).map(p => `<label class="ssh-snippet-param">${esc(p.name)}<input data-snippet-param="${esc(p.name)}" value="${esc(p.value)}" maxlength="4096" spellcheck="false" placeholder="参数值"></label>`).join("")}<pre class="ssh-library-command">${esc(row.command)}</pre>${row.note ? `<p>${esc(row.note)}</p>` : ""}
        <label class="ssh-library-target">目标会话 <select aria-label="命令目标会话"></select></label><p class="ssh-library-note">插入后由你确认并按回车执行。</p><div class="ssh-library-actions">${button("insert", "插入到终端 ↗")}${button("edit-command", "编辑")}${button("remove-command", "删除")}</div>`;
    } else if (this.ref.kind === "files" && key.startsWith("bookmark:")) {
      const row = this.cards.store!.bookmarks.find(row => "bookmark:" + row.id === key);
      if (!row) return;
      html = `<div class="panel-label">${esc(this.aliasLabel(row.alias))}</div><pre>${esc(row.path)}</pre><div class="ssh-library-actions">${button("open-bookmark", this.bank.forAlias(row.alias)?.client.active ? "打开远端目录 ↗" : "连接并打开目录 ↗")}${button("edit-bookmark", "编辑")}${button("remove-bookmark", "移除收藏")}</div>`;
    } else if (this.ref.kind === "history") {
      html = `<div class="ssh-library-actions">${button("record", "阅读记录与导出 ↗")}</div>`;
    } else {
      const session = this.findSession(key);
      if (!session) return;
      const transferCount = session.services.state?.jobs.filter(job => busy(job.state)).length || 0;
      html = `<div class="panel-label">${esc(this.sessionName(session))}</div><div class="ssh-library-actions">${button("terminal", "打开终端 ↗")}${session.client.active ? button("files", "文件") + button("monitor", "监控") + button("transfers", `传输 / ${transferCount}`) + button("stop", "结束会话") : button("remove-session", "移出会话列")}</div>`;
    }
    if (this.selectionHTML === html) return;
    this.selectionHTML = html;
    const focused = target.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.libraryAction : undefined;
    const selectedSession = target.querySelector<HTMLSelectElement>("select")?.value;
    target.innerHTML = html;
    this.updateSessionPicker();
    const picker = target.querySelector<HTMLSelectElement>("select");
    if (picker && selectedSession && Array.from(picker.options).some(option => option.value === selectedSession)) picker.value = selectedSession;
    if (this.ref.kind === "command") this.previewSnippet();
    if (focused) target.querySelector<HTMLButtonElement>(`[data-library-action="${focused}"]`)?.focus({ preventScroll: true });
    if (animate) this.motion.reveal(target as HTMLElement, this.actions.reduced());
  }
  private updateSessionPicker() {
    const select = this.root?.querySelector<HTMLSelectElement>(".ssh-library-target select");
    if (!select) return;
    const sessions = this.bank.visibleSessions.filter(session => session.client.status().phase === "interactive" && session.client.active);
    const value = select.value || this.bank.active.key;
    const signature = sessions.map(session => session.key + this.sessionName(session)).join("|");
    if (select.dataset.sessions !== signature) {
      select.replaceChildren(...sessions.map(session => { const option = document.createElement("option"); option.value = session.key; option.textContent = this.sessionName(session); return option; }));
      if (!sessions.length) { const option = document.createElement("option"); option.value = ""; option.textContent = "还没有可输入的会话"; select.add(option); }
      select.dataset.sessions = signature;
      if (sessions.some(session => session.key === value)) select.value = value;
    }
    const button = this.root?.querySelector<HTMLButtonElement>('[data-library-action="insert"]');
    if (button) button.disabled = !sessions.length;
  }
  private openEditor(kind: "command" | "bookmark", id?: string) {
    if (!this.root) return;
    this.edit = { kind, id }; this.removeArmed = "";
    const editor = this.root.querySelector<HTMLFormElement>(".ssh-library-editor")!;
    const row = (kind === "command" ? this.cards.store!.commands : this.cards.store!.bookmarks).find(row => row.id === id);
    editor.hidden = false;
    editor.innerHTML = `<div class="panel-label">${id ? "编辑" : "新建"}${kind === "command" ? "命令" : "目录收藏"}</div><label>名称<input name="name" maxlength="100" required value="${esc(row?.name || "")}"></label>` +
      (kind === "command" ? `<label>命令<textarea name="command" rows="4" maxlength="16384" spellcheck="false" required></textarea></label><p>用 {{path}} 或 {{name=默认值}} 定义参数；参数会自动加 shell 引号，请勿额外包引号。填写后可预览，不自动执行。</p><label>备注<input name="note" maxlength="1000" value="${esc((row as CommandSnippet)?.note || "")}"></label>` :
        `<label>主机<select name="alias" required aria-label="目录所属主机"></select></label><label>远端目录<input name="path" maxlength="4096" spellcheck="false" placeholder="/home/user/project" required value="${esc((row as DirectoryBookmark)?.path || "")}"></label>`) +
      '<div class="ssh-library-actions"><button type="submit">保存</button><button type="button" data-library-action="cancel-edit">取消</button></div>';
    if (kind === "command") (editor.elements.namedItem("command") as HTMLTextAreaElement).value = (row as CommandSnippet)?.command || "";
    else {
      const select = editor.elements.namedItem("alias") as HTMLSelectElement;
      const aliases = new Map(this.cards.bound.map(host => [host.alias, hostLabel(host)]));
      for (const session of this.bank.visibleSessions) if (session.descriptor) aliases.set(session.descriptor.target, sessionLabel(session));
      if (row) aliases.set((row as DirectoryBookmark).alias, this.aliasLabel((row as DirectoryBookmark).alias));
      for (const [alias, label] of aliases) { const option = document.createElement("option"); option.value = alias; option.textContent = label; select.add(option); }
      if (row) select.value = (row as DirectoryBookmark).alias;
      else if (this.bank.active.descriptor) select.value = this.bank.active.descriptor.target;
    }
    this.motion.reveal(editor, this.actions.reduced());
    editor.querySelector("input")!.focus();
  }
  private saveEditor() {
    if (!this.edit || !this.root) return;
    const form = this.root.querySelector<HTMLFormElement>(".ssh-library-editor")!;
    if (!form.reportValidity()) return;
    const values = new FormData(form), value = (key: string) => String(values.get(key) || "");
    const ok = this.edit.kind === "command" ? this.cards.store!.saveCommand({ id: this.edit.id, name: value("name"), command: value("command"), note: value("note") }) : this.cards.store!.saveBookmark({ id: this.edit.id, name: value("name"), alias: value("alias"), path: value("path") });
    if (!ok) { this.feedback(this.cards.store!.error); return; }
    this.edit = null; form.hidden = true; this.feedback("已保存到本机工作区");
    const key = this.selection.get(this.ref!.kind); if (key) this.showSelection(key);
  }
  private async action(action: string, key: string) {
    if (!this.ref || !this.root) return;
    if (action === "open") { this.showSelection(key); return; }
    if (action === "hosts") { this.actions.openHosts(); return; }
    if (action === "new-command" || action === "edit-command") { this.openEditor("command", key || undefined); return; }
    if (action === "new-bookmark" || action === "edit-bookmark") { this.openEditor("bookmark", key.replace(/^bookmark:/, "") || undefined); return; }
    if (action === "cancel-edit") { this.edit = null; this.root.querySelector<HTMLFormElement>("form")!.hidden = true; return; }
    if (action.startsWith("remove-command") || action.startsWith("remove-bookmark")) {
      if (this.removeArmed !== key) { this.removeArmed = key; this.feedback("再次点击删除，确认移除这条本机资料。"); return; }
      const ok = this.cards.store!.remove(action === "remove-command" ? "command" : "bookmark", key.replace(/^bookmark:/, ""));
      this.feedback(ok ? "已移除" : this.cards.store!.error);
      if (ok) { this.selection.delete(this.ref!.kind); this.selectionHTML = ""; this.root?.querySelector(".ssh-library-selection")?.replaceChildren(); }
      return;
    }
    if (action === "insert") {
      const row = this.cards.store!.commands.find(row => row.id === key);
      const session = this.bank.byKey(this.root.querySelector<HTMLSelectElement>(".ssh-library-target select")?.value || "");
      if (row && session?.client.active && session.client.status().phase === "interactive") {
        try { this.actions.insert(session, expandSnippet(row.command, this.parameterValues())); }
        catch (error) { this.feedback(String(error)); }
      }
      else this.feedback("请选择仍在连接中的终端会话");
      return;
    }
    if (action === "open-bookmark") {
      const bookmark = this.cards.store!.bookmarks.find(row => "bookmark:" + row.id === key);
      if (!bookmark) return;
      const session = this.bank.forAlias(bookmark.alias);
      if (session?.client.active) this.actions.openSession(session, "files", bookmark.path);
      else if (this.cards.bound.some(host => host.alias === bookmark.alias) || !bookmark.alias.startsWith("rhine-profile:")) this.actions.connect(bookmark.alias, bookmark.path);
      else this.feedback("这条收藏对应的主机已被移除，请编辑收藏并选择主机。");
      return;
    }
    if (action === "record") { this.actions.record(key); return; }
    if (action === "refresh-history") { await this.reloadHistory(); return; }
    if (action === "prune") {
      const result = await window.rhineDesktop?.records?.prune().catch(() => null);
      this.feedback(result?.ok ? `已清理 ${result.removed} 个过期会话` : "部分记录暂时无法清理");
      await this.reloadHistory(); return;
    }
    const session = this.findSession(key);
    if (!session) return;
    if (action === "stop") this.actions.stop(session);
    else if (action === "remove-session") this.actions.removeSession(session);
    else this.actions.openSession(session, action === "files" || action === "monitor" ? action : "terminal", undefined, action === "transfers");
  }
  preview(card: number) {
    const ref = this.cards.resourceAt(card), record = records[card];
    if (!ref) return { key: "workspace", title: "SSH", lines: [] };
    const lines = ref.directory ? [titles[ref.kind][2], "", ...this.listForPreview(ref.kind)] : [record.abstract];
    if (ref.kind === "command" && !ref.directory) {
      const row = this.cards.store!.commands.find(row => row.id === ref.key);
      if (row) lines.splice(0, lines.length, row.command, "", row.note, "选择会话后插入 · 由你确认执行");
    }
    if (ref.kind === "monitor" && ref.sessionKey) {
      const session = this.bank.byKey(ref.sessionKey), sample = session?.services.state?.sample;
      if (session && sample) lines.splice(0, lines.length, this.sessionName(session),
        `CPU ${percent(sample.cpu?.usage)}  MEMORY ${bytes(sample.memory?.used)} / ${bytes(sample.memory?.total)}`,
        ...sample.gpus.map(gpu => `${gpu.name}  ${percent(gpu.utilization)}  VRAM ${bytes(gpu.memoryUsed)} / ${bytes(gpu.memoryTotal)}`));
    }
    return { key: ref.kind + ":" + ref.key, title: record.title, lines };
  }
  private parameterValues() { return Object.fromEntries([...this.root!.querySelectorAll<HTMLInputElement>("[data-snippet-param]")].map(input => [input.dataset.snippetParam!, input.value])); }
  private previewSnippet() {
    const key = this.selection.get("command"), row = this.cards.store!.commands.find(row => row.id === key);
    if (!row) return;
    const preview = this.root?.querySelector(".ssh-library-command");
    try { if (preview) preview.textContent = expandSnippet(row.command, this.parameterValues()); this.feedback(""); }
    catch (error) { if (preview) preview.textContent = row.command; this.feedback(String(error)); }
  }
  private listForPreview(kind: ResourceKind) {
    if (kind === "shortcut") return this.cards.store!.shortcuts.slice(0, 12).map(row => row.name + (row.path ? " / " + row.path : ""));
    if (kind === "host") return this.cards.bound.map(host => hostLabel(host) + " / " + host.hostname).slice(0, 12);
    if (kind === "command") return this.cards.store!.commands.slice(0, 12).map(row => row.name);
    if (kind === "history") return this.records.slice(0, 12).map(row => (row.targetLabel || row.target) + " / " + row.outcome);
    if (kind === "files") return [...this.bank.visibleSessions.filter(session => session.client.active).map(session => this.sessionName(session) + " / " + (session.panel.directory || "SFTP")), ...this.cards.store!.bookmarks.map(row => row.name + " / " + row.path)].slice(0, 12);
    return this.bank.visibleSessions.filter(session => kind !== "monitor" || session.client.active).slice(0, 12).map(session => {
      const sample = session.services.state?.sample;
      return sessionLabel(session) + " / " + (kind === "monitor" && sample ? `CPU ${percent(sample.cpu?.usage)}  MEM ${bytes(sample.memory?.used)}  GPU ${sample.gpus.length}` : sessionState(session));
    });
  }
  dispose() { this.offStore(); this.unmount(); }
}
