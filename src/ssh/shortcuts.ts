import { escapeHtml as esc } from "../html";
import { hostLabel, type SshHostCards } from "./host-cards";
import type { ArchiveShortcut } from "./workspace-store";
import "./shortcuts.css";

const labels = { project: "项目工作区", terminal: "终端", files: "远端目录", monitor: "主机监控", tunnel: "端口转发", note: "运维笔记" };
export class ShortcutPanel {
  private root?: HTMLElement;
  private key?: string;
  private edit?: string;
  private armed = "";
  private rendered = "";
  private abort?: AbortController;
  constructor(private cards: SshHostCards, private open: (shortcut: ArchiveShortcut) => void) {}
  mount(root: HTMLElement, key?: string) {
    this.unmount(); this.root = root; this.key = key; root.classList.add("ssh-shortcuts"); this.render();
    this.abort = new AbortController();
    root.addEventListener("click", event => {
      const button = (event.target as Element).closest<HTMLButtonElement>("[data-shortcut-action]");
      if (!button) return; event.stopPropagation();
      const id = button.dataset.id || "", action = button.dataset.shortcutAction;
      if (action === "new" || action === "edit") { this.edit = id; this.editor(); }
      else if (action === "cancel") { this.edit = undefined; this.render(); }
      else if (action === "read") { const row = this.cards.store!.shortcuts.find(s => s.id === id); if (row) this.open(row); }
      else if (action === "up" || action === "down") { this.cards.store!.moveShortcut(id, action === "up" ? -1 : 1); this.render(); }
      else if (action === "pin") { const row = this.cards.store!.shortcuts.find(s => s.id === id); if (row) this.cards.store!.saveShortcut({ ...row, pinned: !row.pinned }); this.render(); }
      else if (action === "remove") {
        if (this.armed !== id) { this.armed = id; this.feedback("再次点击移除，确认删除这份快捷档案。主机和会话保留。"); return; }
        if (!this.cards.store!.removeShortcut(id)) this.feedback(this.cards.store!.error);
        else { this.key = undefined; this.armed = ""; this.render(); }
      }
    }, { signal: this.abort.signal });
    root.addEventListener("submit", event => {
      event.preventDefault(); event.stopPropagation();
      const form = event.target as HTMLFormElement; if (!form.reportValidity()) return;
      const data = new FormData(form), text = (name: string) => String(data.get(name) || "");
      const existing = this.cards.store!.shortcuts.find(row => row.id === this.edit);
      const ok = this.cards.store!.saveShortcut({ id: this.edit || undefined, name: text("name"), kind: text("kind") as ArchiveShortcut["kind"], alias: text("alias"), path: text("path"), note: text("note"), autoOpen: data.has("autoOpen"),
        group: text("group"), pinned: data.has("pinned"), order: existing?.order ?? this.cards.store!.shortcuts.length,
        tmux: text("tmux"), layout: { width: Number(text("width")) || 320, page: text("page") as "terminal" | "files" | "monitor", splitAlias: text("splitAlias"), splitRatio: existing?.layout?.splitRatio || .5 },
        tunnel: { localPort: Number(text("localPort")), host: text("tunnelHost"), port: Number(text("tunnelPort")) } });
      if (!ok) this.feedback(this.cards.store!.error);
      else { this.edit = undefined; this.render(); this.feedback("档案已保存，三维阵列同步更新。"); }
    }, { signal: this.abort.signal });
  }
  refresh() { if (this.root && this.edit === undefined) this.render(); }
  private host(alias: string) { const host = this.cards.bound.find(h => h.alias === alias); return host ? hostLabel(host) : "主机已移除，请重新关联"; }
  private feedback(text: string) { const target = this.root?.querySelector(".ssh-shortcut-feedback"); if (target) target.textContent = text; }
  private render() {
    if (!this.root) return;
    const rows = this.cards.store!.shortcuts.filter(s => !this.key || s.id === this.key);
    const markup = `<div class="ssh-catalog-heading"><div><span>SSH ARCHIVES</span><h2>${this.key ? esc(rows[0]?.name || "快捷档案") : "快捷档案"}</h2></div><button type="button" data-shortcut-action="new">新建 ＋</button></div>
      <p class="ssh-catalog-note">打开项目即可连接主机、进入目录并恢复 tmux。可按分组整理和置顶常用档案。</p>
      <div class="ssh-shortcut-list">${rows.map(row => `<article><div class="ssh-shortcut-heading"><strong>${row.pinned ? "◆ " : ""}${esc(row.name)}</strong><span>${esc(row.group || "未分组")} / ${labels[row.kind]}</span></div>
      ${row.kind !== "note" ? `<p class="ssh-shortcut-address">${esc(this.host(row.alias))}${row.path ? " · " + esc(row.path) : ""}</p>` : ""}
      ${row.note ? `<p class="ssh-shortcut-note">${esc(row.note)}</p>` : ""}
      ${row.tmux ? `<p>tmux / ${esc(row.tmux)}</p>` : ""}${row.tunnel ? `<p>127.0.0.1:${row.tunnel.localPort || "自动"} → ${esc(row.tunnel.host)}:${row.tunnel.port}</p>` : ""}
      <div class="ssh-shortcut-actions"><button type="button" data-shortcut-action="read" data-id="${esc(row.id)}">${row.kind === "note" ? "读取档案" : "打开" + labels[row.kind]} ↗</button><button type="button" data-shortcut-action="edit" data-id="${esc(row.id)}">编辑</button><button type="button" data-shortcut-action="pin" data-id="${esc(row.id)}">${row.pinned ? "取消置顶" : "置顶"}</button><button type="button" data-shortcut-action="up" data-id="${esc(row.id)}" aria-label="上移">↑</button><button type="button" data-shortcut-action="down" data-id="${esc(row.id)}" aria-label="下移">↓</button><button type="button" data-shortcut-action="remove" data-id="${esc(row.id)}">移除</button></div></article>`).join("") || '<p class="ssh-catalog-empty">还没有快捷档案。可以先为常用项目创建一张目录卡。</p>'}</div><p class="ssh-shortcut-feedback" role="status"></p>`;
    if (markup !== this.rendered) { this.root.innerHTML = markup; this.rendered = markup; }
  }
  private editor() {
    if (!this.root) return;
    this.rendered = "";
    const row = this.cards.store!.shortcuts.find(s => s.id === this.edit);
    this.root.innerHTML = `<h2>${row ? "编辑" : "新建"}快捷档案</h2><form class="ssh-shortcut-editor">
      <label>档案名称<input name="name" maxlength="100" required value="${esc(row?.name || "")}" placeholder="例如：项目日志"></label>
      <label>打开内容<select name="kind">${Object.entries(labels).map(([key, label]) => `<option value="${key}" ${key === (row?.kind || "project") ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      <label>分组<input name="group" maxlength="80" list="ssh-archive-groups" value="${esc(row?.group || "")}" placeholder="例如：生产、开发、个人"><datalist id="ssh-archive-groups">${[...new Set(this.cards.store!.shortcuts.map(row => row.group).filter(Boolean))].map(group => `<option value="${esc(group!)}">`).join("")}</datalist></label>
      <label class="ssh-shortcut-auto"><input type="checkbox" name="pinned" ${row?.pinned ? "checked" : ""}>置顶档案</label>
      <label data-shortcut-host>关联主机<select name="alias" required><option value="">选择主机</option>${this.cards.bound.map(host => `<option value="${esc(host.alias)}" ${host.alias === row?.alias ? "selected" : ""}>${esc(hostLabel(host))}</option>`).join("")}</select></label>
      <label data-shortcut-path>远端目录<input name="path" maxlength="4096" value="${esc(row?.path || "")}" placeholder="/srv/project"></label>
      <div data-shortcut-project>
        <label>tmux 会话名<input name="tmux" maxlength="80" pattern="[a-zA-Z0-9_-]*" value="${esc(row?.tmux || "")}" placeholder="project-a（留空使用普通 shell）"></label>
        <label>项目侧栏<select name="page">${["files", "monitor", "terminal"].map(page => `<option value="${page}" ${page === (row?.layout?.page || "files") ? "selected" : ""}>${page === "files" ? "文件" : page === "monitor" ? "监控" : "仅终端"}</option>`).join("")}</select></label>
        <label>侧栏宽度<input name="width" type="number" min="260" max="480" value="${row?.layout?.width || 320}"></label>
        <label>第二终端主机<select name="splitAlias"><option value="">单终端</option>${this.cards.bound.map(host => `<option value="${esc(host.alias)}" ${row?.layout?.splitAlias === host.alias ? "selected" : ""}>${esc(hostLabel(host))}</option>`).join("")}</select></label>
      </div>
      <div data-shortcut-tunnel>
        <label>本地端口<input name="localPort" type="number" min="0" max="65535" value="${row?.tunnel?.localPort ?? 0}" placeholder="0 自动分配"></label>
        <label>目标地址<input name="tunnelHost" maxlength="253" value="${esc(row?.tunnel?.host || "127.0.0.1")}"></label>
        <label>目标端口<input name="tunnelPort" type="number" min="1" max="65535" value="${row?.tunnel?.port || 8080}"></label>
      </div>
      <label>档案正文<textarea name="note" rows="6" maxlength="16000" placeholder="用途、操作说明、项目备忘…"></textarea></label>
      <label class="ssh-shortcut-auto"><input type="checkbox" name="autoOpen" ${row?.autoOpen !== false ? "checked" : ""}>读取档案后自动连接并打开</label>
      <p class="ssh-catalog-note" data-shortcut-help></p><div class="ssh-shortcut-actions"><button type="submit">保存档案 ↗</button><button type="button" data-shortcut-action="cancel">取消</button></div></form><p class="ssh-shortcut-feedback" role="status"></p>`;
    this.root.querySelector<HTMLTextAreaElement>("textarea")!.value = row?.note || "";
    const kind = this.root.querySelector<HTMLSelectElement>('[name="kind"]')!;
    const update = () => {
      const note = kind.value === "note", path = ["terminal", "files", "project"].includes(kind.value);
      const alias = this.root!.querySelector<HTMLSelectElement>('[name="alias"]')!; alias.required = !note; alias.disabled = note;
      this.root!.querySelector<HTMLElement>("[data-shortcut-host]")!.hidden = note;
      this.root!.querySelector<HTMLElement>("[data-shortcut-path]")!.hidden = !path;
      const field = this.root!.querySelector<HTMLInputElement>('[name="path"]')!; field.disabled = !path; field.required = ["files", "project"].includes(kind.value);
      this.root!.querySelector<HTMLInputElement>('[name="autoOpen"]')!.parentElement!.hidden = note;
      for (const type of ["project", "tunnel"]) { const section = this.root!.querySelector<HTMLElement>(`[data-shortcut-${type}]`)!; section.hidden = kind.value !== type; section.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input,select").forEach(input => input.disabled = kind.value !== type); }
      this.root!.querySelector("[data-shortcut-help]")!.textContent = kind.value === "project" ? "每次读取恢复项目目录、侧栏与命名 tmux；远端没有 tmux 时保留普通 shell 并提示。双终端仅在电脑宽屏显示，手机使用标签。" : kind.value === "tunnel" ? "通过关联主机转发到目标地址，仅监听本机回环地址。连接结束时转发关闭。" : kind.value === "terminal" ? "填写目录时，每次打开都会新建一个会话并切换到该目录。正文只展示，不会当作命令执行。" : kind.value === "files" ? "填写以 / 开头的目录。打开后直接进入该主机的 SFTP 文件页。" : note ? "笔记保存在本机，读取时保留原来的档案抽取动画。" : "打开后显示该主机的 CPU、内存、磁盘、网络和支持的 GPU 指标。";
    };
    kind.addEventListener("change", update, { signal: this.abort?.signal }); update();
    this.root.querySelector<HTMLInputElement>('[name="name"]')!.focus({ preventScroll: true });
  }
  unmount() { this.abort?.abort(); this.root?.classList.remove("ssh-shortcuts"); this.root = undefined; this.edit = undefined; this.rendered = ""; }
}
