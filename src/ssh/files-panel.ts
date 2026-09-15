import { SshPageMotion } from "./page-motion";
import {
  bytes,
  remoteJoin,
  remoteParent,
  type RemoteEntry,
  type ServiceResult,
  type ServicesState,
  SshServicesClient,
} from "./services";

const markup = `
  <div class="ssh-side-kicker" data-ssh-reveal><span>FILE INDEX</span><span class="ssh-files-count">00</span></div>
  <form class="ssh-files-path-form" data-ssh-reveal>
    <button type="button" data-file-action="parent" title="上一级目录 · Backspace">↑</button>
    <input class="ssh-files-path" aria-label="远端目录路径" spellcheck="false" autocomplete="off" placeholder="远端目录">
    <button type="submit" title="读取目录">↵</button>
  </form>
  <nav class="ssh-files-breadcrumbs" aria-label="目录层级" data-ssh-reveal></nav>
  <div class="ssh-file-actions" data-ssh-reveal>
    <button type="button" data-file-action="upload">上传</button>
    <button type="button" data-file-action="upload-folder">上传目录</button>
    <button type="button" data-file-action="download">下载</button>
    <button type="button" data-file-action="mkdir">新建目录</button>
    <button type="button" data-file-action="bookmark" title="将当前远端目录存入文件列">收藏目录</button>
    <button type="button" data-file-action="refresh" class="ssh-file-refresh" title="刷新目录">↻</button>
  </div>
  <div class="ssh-files-filter" data-ssh-reveal>
    <input type="search" aria-label="筛选当前目录" placeholder="筛选当前目录" spellcheck="false">
    <select aria-label="文件排序"><option value="name">名称</option><option value="modified">修改时间</option><option value="size">大小</option><option value="kind">类型</option></select>
    <button type="button" data-file-action="hidden" aria-pressed="false" title="显示隐藏文件">·</button>
  </div>
  <div class="ssh-files-state" role="status"></div>
  <div class="ssh-files-list" role="listbox" aria-label="远端文件" aria-multiselectable="true" tabindex="0">
    <div class="ssh-files-space"><div class="ssh-file-rows"></div></div>
    <div class="ssh-files-empty"></div>
  </div>
  <div class="ssh-file-selection">
    <span class="ssh-file-info"></span>
    <button type="button" data-file-action="open">打开</button>
    <button type="button" data-file-action="properties">详情</button>
    <button type="button" data-file-action="rename">重命名</button>
    <button type="button" data-file-action="remove">删除</button>
  </div>
  <form class="ssh-file-editor" hidden>
    <div class="ssh-side-kicker"><span class="ssh-file-editor-title"></span></div>
    <p class="ssh-file-editor-description"></p>
    <input class="ssh-file-editor-name" aria-label="文件或目录名称" spellcheck="false" autocomplete="off">
    <div class="ssh-file-actions"><button type="submit" class="ssh-file-editor-submit">确认</button><button type="button" data-file-action="cancel-edit">取消</button></div>
  </form>
  <div class="ssh-files-feedback" role="status"></div>
  <button type="button" class="ssh-files-retry" data-file-action="retry" hidden>重新建立文件通道 ↗</button>
  <div class="ssh-files-drop" aria-hidden="true"><span>释放以上传至当前目录</span></div>
`;

type Edit = {
  action: string;
  sessionId: string;
  path: string;
  entries: RemoteEntry[];
};
const rowHeight = 40;

export function fileTone(entry: RemoteEntry) {
  if (entry.kind === "directory") return "directory";
  if (entry.kind === "link") return "link";
  if (/\.(?:zip|gz|tgz|bz2|xz|7z|rar|tar)$/i.test(entry.name)) return "archive";
  if (
    /\.(?:py|js|ts|tsx|jsx|go|rs|c|cpp|h|json|yaml|yml|toml|sh|md)$/i.test(
      entry.name,
    )
  )
    return "code";
  if (/\.(?:png|jpe?g|webp|svg|mp4|mp3|wav|ogg)$/i.test(entry.name))
    return "media";
  if (entry.permissions.includes("x")) return "executable";
  return "file";
}

export class SftpPanel {
  private textEditor?: import("./text-editor").RemoteTextEditor;
  private disposed = false;
  private path = "";
  private requestedPath = "";
  onBookmark: ((path: string) => void) | undefined;
  private home = "";
  private sessionId = "";
  private ready = false;
  private entries: RemoteEntry[] = [];
  private filtered: RemoteEntry[] = [];
  private selection = new Set<string>();
  private anchor = 0;
  private cursor = 0;
  private rowNodes = new Map<string, HTMLElement>();
  private loading = false;
  private showHidden = false;
  private loadRevision = 0;
  private edit: Edit | null = null;
  private editRevision = 0;
  private motion = new SshPageMotion();
  private abort = new AbortController();
  private resize: ResizeObserver;
  private visible = false;
  private dragDepth = 0;
  private completed = new Set<string>();
  private refreshTimer?: number;
  private viewport: HTMLElement;
  private rows: HTMLElement;
  private pathField: HTMLInputElement;
  private query: HTMLInputElement;
  private sort: HTMLSelectElement;
  private editor: HTMLFormElement;
  private editorName: HTMLInputElement;

  constructor(
    private root: HTMLElement,
    private services: SshServicesClient,
    private reduced: () => boolean,
    private openQueue: () => void,
  ) {
    root.innerHTML = markup;
    this.viewport = root.querySelector(".ssh-files-list")!;
    this.rows = root.querySelector(".ssh-file-rows")!;
    this.pathField = root.querySelector(".ssh-files-path")!;
    this.query = root.querySelector(".ssh-files-filter input")!;
    this.sort = root.querySelector(".ssh-files-filter select")!;
    this.editor = root.querySelector(".ssh-file-editor")!;
    this.editorName = root.querySelector(".ssh-file-editor-name")!;
    const options = { signal: this.abort.signal };
    root.querySelector("form")!.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        const input = this.pathField.value.trim();
        const requested =
          input === "~"
            ? this.home
            : input.startsWith("~/")
              ? remoteJoin(this.home, input.slice(2))
              : input.startsWith("/")
                ? input
                : remoteJoin(this.path || this.home, input);
        void this.load(requested);
      },
      options,
    );
    root.addEventListener(
      "click",
      (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const breadcrumb = target?.closest<HTMLElement>(
          "[data-remote-directory]",
        );
        if (breadcrumb) {
          void this.load(breadcrumb.dataset.remoteDirectory!);
          return;
        }
        const action =
          target?.closest<HTMLButtonElement>("[data-file-action]")?.dataset
            .fileAction;
        if (action) {
          void this.action(action);
          return;
        }
        const row = target?.closest<HTMLElement>("[data-file-index]");
        if (row)
          this.select(
            Number(row.dataset.fileIndex),
            (event as MouseEvent).ctrlKey || (event as MouseEvent).metaKey,
            (event as MouseEvent).shiftKey,
          );
      },
      options,
    );
    root.addEventListener(
      "dblclick",
      (event) => {
        const row = (event.target as Element).closest<HTMLElement>(
          "[data-file-index]",
        );
        if (row)
          void this.openEntry(this.filtered[Number(row.dataset.fileIndex)]);
      },
      options,
    );
    this.query.addEventListener(
      "input",
      () => {
        this.selection.clear();
        this.filter();
      },
      options,
    );
    this.sort.addEventListener("change", () => this.filter(), options);
    this.viewport.addEventListener("scroll", () => this.renderRows(), {
      ...options,
      passive: true,
    });
    this.viewport.addEventListener(
      "keydown",
      (event) => this.key(event),
      options,
    );
    this.editor.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        void this.submitEdit();
      },
      options,
    );
    root.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" && this.edit) {
          event.preventDefault();
          event.stopPropagation();
          this.closeEditor();
          this.viewport.focus();
        }
      },
      options,
    );
    root.addEventListener(
      "dragenter",
      (event) => {
        if (event.dataTransfer?.types.includes("Files") && this.ready) {
          event.preventDefault();
          this.dragDepth++;
          root.dataset.drop = "true";
        }
      },
      options,
    );
    root.addEventListener(
      "dragover",
      (event) => {
        if (event.dataTransfer?.types.includes("Files") && this.ready) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      },
      options,
    );
    root.addEventListener(
      "dragleave",
      () => {
        if (--this.dragDepth <= 0) {
          this.dragDepth = 0;
          delete root.dataset.drop;
        }
      },
      options,
    );
    root.addEventListener(
      "drop",
      (event) => {
        event.preventDefault();
        this.dragDepth = 0;
        delete root.dataset.drop;
        if (this.ready && !this.loading && event.dataTransfer?.files.length) {
          const id = this.sessionId;
          void this.services
            .files!.uploadDropped(id, [...event.dataTransfer.files], this.path)
            .then((result) => this.transferResult(result, id))
            .catch((error) => this.feedback(String(error)));
        }
      },
      options,
    );
    this.resize = new ResizeObserver(() => this.renderRows());
    this.resize.observe(this.viewport);
  }
  setVisible(visible: boolean) {
    const entering = visible && !this.visible;
    this.visible = visible;
    if (entering) {
      this.renderRows();
      this.motion.reveal(this.root, this.reduced());
    }
    if (!visible) {
      this.motion.cancel();
      this.dragDepth = 0;
      delete this.root.dataset.drop;
    }
  }
  get directory() { return this.path; }
  openDirectory(path: string) {
    this.requestedPath = path;
    if (this.ready) {
      this.requestedPath = "";
      return this.load(path);
    }
    return Promise.resolve();
  }
  focus() {
    this.query.focus({ preventScroll: true });
  }
  finishMotion() {
    this.motion.finish();
  }
  update(state: ServicesState | null) {
    if (!state) return;
    if (this.sessionId !== state.sessionId) {
      this.sessionId = state.sessionId;
      this.path = "";
      this.home = "";
      this.ready = false;
      this.entries = [];
      this.filtered = [];
      this.selection.clear();
      this.completed.clear();
      this.loadRevision++;
      this.closeEditor();
      this.pathField.value = "";
      this.feedback("");
      this.renderRows();
    }
    const becameReady =
      !this.ready && state.active && state.sftp.state === "ready";
    this.ready = state.active && state.sftp.state === "ready";
    if (state.sftp.home) this.home = state.sftp.home;
    const status = this.root.querySelector<HTMLElement>(".ssh-files-state")!;
    status.dataset.state = state.sftp.state;
    status.textContent = this.loading
      ? status.textContent
      : state.sftp.state === "ready"
        ? "SFTP / 文件通道已建立"
        : state.sftp.message.split("\n")[0];
    status.title = state.sftp.message;
    this.root.querySelector<HTMLElement>(".ssh-files-retry")!.hidden =
      !state.active || !["error", "unsupported"].includes(state.sftp.state);
    if (becameReady) {
      const path = this.requestedPath || this.path || this.home || ".";
      this.requestedPath = "";
      void this.load(path);
    }
    for (const job of state.jobs) {
      if (job.state === "completed" && !this.completed.has(job.id)) {
        this.completed.add(job.id);
        if (job.direction === "upload" && this.path && !this.loading) {
          clearTimeout(this.refreshTimer);
          this.refreshTimer = window.setTimeout(() => {
            if (this.ready) void this.load(this.path, true);
          }, 300);
        }
      }
    }
    this.syncActions();
    if (!this.entries.length && !this.loading) this.renderRows();
  }
  private feedback(text: string) {
    this.root.querySelector<HTMLElement>(".ssh-files-feedback")!.textContent =
      text;
  }
  private async load(requested: string, preserve = false) {
    if (!this.ready || !this.services.files) return;
    const revision = ++this.loadRevision,
      sessionId = this.sessionId;
    const before = {
      path: this.path,
      entries: this.entries,
      selected: new Set(this.selection),
    };
    this.loading = true;
    if (!preserve || requested !== this.path) this.closeEditor();
    this.feedback("");
    this.syncActions();
    const status = this.root.querySelector<HTMLElement>(".ssh-files-state")!;
    status.textContent = "正在读取目录…";
    const collected: RemoteEntry[] = [];
    let cursor = "",
      directory = requested;
    try {
      do {
        const response = await this.services.files.list({
          sessionId,
          path: directory,
          ...(cursor ? { cursor } : {}),
        });
        if (revision !== this.loadRevision || sessionId !== this.sessionId)
          return;
        if (!response.ok || !response.result)
          throw new Error(response.error || "读取目录失败");
        directory = response.result.path;
        cursor = response.result.cursor || "";
        collected.push(...response.result.entries);
        if (!this.path || directory !== this.path) {
          this.selection.clear();
          this.viewport.scrollTop = 0;
          this.cursor = this.anchor = 0;
        }
        this.path = directory;
        if (
          document.activeElement !== this.pathField ||
          this.pathField.value.trim() === requested
        )
          this.pathField.value = directory;
        this.entries = [...collected];
        this.filter(false);
        this.breadcrumbs();
        status.textContent = cursor
          ? "读取目录 · " + collected.length + " / " + response.result.total
          : "SFTP / " + collected.length + " 项";
      } while (cursor);
      const paths = new Set(this.entries.map((entry) => entry.path));
      for (const selected of this.selection)
        if (!paths.has(selected)) this.selection.delete(selected);
      if (this.visible) this.motion.reveal(this.rows, this.reduced());
    } catch (error) {
      if (revision === this.loadRevision && sessionId === this.sessionId) {
        this.feedback(String((error as Error).message || error));
        if (!collected.length) {
          this.path = before.path;
          this.entries = before.entries;
          this.selection = before.selected;
          this.filter(false);
          this.breadcrumbs();
        }
        this.pathField.value = this.path;
        status.textContent = collected.length
          ? "目录读取未完成 · 请刷新"
          : "目录读取失败 · 已保留原目录";
      }
    } finally {
      if (revision === this.loadRevision && sessionId === this.sessionId) {
        this.loading = false;
        this.renderRows();
        this.syncActions();
      }
    }
  }
  private filter(resetScroll = true) {
    const query = this.query.value.toLocaleLowerCase(),
      sort = this.sort.value;
    const collator = new Intl.Collator(undefined, {
      numeric: true,
      sensitivity: "base",
    });
    this.filtered = this.entries.filter(
      (entry) =>
        (this.showHidden || !entry.name.startsWith(".")) &&
        entry.name.toLocaleLowerCase().includes(query),
    );
    this.filtered.sort((a, b) => {
      if ((a.kind === "directory") !== (b.kind === "directory"))
        return a.kind === "directory" ? -1 : 1;
      if (sort === "size" && a.size !== b.size) return b.size - a.size;
      if (sort === "modified" && a.modified !== b.modified)
        return b.modified - a.modified;
      if (sort === "kind" && fileTone(a) !== fileTone(b))
        return fileTone(a).localeCompare(fileTone(b));
      return collator.compare(a.name, b.name);
    });
    if (resetScroll) {
      this.viewport.scrollTop = 0;
      this.cursor = this.anchor = 0;
    }
    this.root.querySelector(".ssh-files-count")!.textContent = String(
      this.filtered.length,
    ).padStart(2, "0");
    this.renderRows();
    this.syncActions();
  }
  private renderRows() {
    const count = this.filtered.length,
      start = Math.max(0, Math.floor(this.viewport.scrollTop / rowHeight) - 5);
    const end = Math.min(
      count,
      start + Math.ceil((this.viewport.clientHeight || 400) / rowHeight) + 12,
    );
    this.root.querySelector<HTMLElement>(".ssh-files-space")!.style.height =
      count * rowHeight + "px";
    this.rows.style.transform = "translateY(" + start * rowHeight + "px)";
    const visible = new Set<string>();
    for (let index = start; index < end; index++) {
      const entry = this.filtered[index];
      visible.add(entry.path);
      let row = this.rowNodes.get(entry.path);
      if (!row) {
        row = document.createElement("div");
        row.innerHTML =
          '<span class="ssh-file-glyph" aria-hidden="true"></span><span class="ssh-file-name"></span><small></small>';
        this.rowNodes.set(entry.path, row);
      }
      row.className = "ssh-file-row";
      row.dataset.fileIndex = String(index);
      row.dataset.kind = fileTone(entry);
      row.dataset.focused = String(
        index === this.cursor && document.activeElement === this.viewport,
      );
      row.dataset.sshReveal = "";
      row.id = "ssh-file-row-" + index;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(this.selection.has(entry.path)));
      row.title =
        entry.name +
        "\n" +
        entry.permissions +
        " · " +
        new Date(entry.modified).toLocaleString();
      const icon = row.children[0];
      icon.textContent =
        entry.kind === "directory" ? "▱" : entry.kind === "link" ? "↗" : "▤";
      row.children[1].textContent = entry.name;
      row.children[2].textContent =
        entry.kind === "directory"
          ? "DIR"
          : entry.kind === "link"
            ? "LINK"
            : bytes(entry.size);
      if (this.rows.children[index - start] !== row)
        this.rows.insertBefore(row, this.rows.children[index - start] ?? null);
    }
    for (const [path, node] of this.rowNodes)
      if (!visible.has(path)) {
        node.remove();
        this.rowNodes.delete(path);
      }
    if (this.cursor >= start && this.cursor < end)
      this.viewport.setAttribute(
        "aria-activedescendant",
        "ssh-file-row-" + this.cursor,
      );
    else this.viewport.removeAttribute("aria-activedescendant");
    const empty = this.root.querySelector<HTMLElement>(".ssh-files-empty")!;
    empty.hidden = count > 0;
    empty.textContent = this.loading
      ? "正在读取目录…"
      : !this.ready
        ? "文件通道准备好后将在此显示目录"
        : this.query.value
          ? "没有匹配的文件"
          : "此目录为空";
    const selected = this.selected();
    this.root.querySelector<HTMLElement>(".ssh-file-info")!.textContent =
      selected.length === 1
        ? selected[0].permissions + " · " + bytes(selected[0].size)
        : selected.length
          ? selected.length + " 项已选中"
          : "Ctrl / Shift 多选";
  }
  private breadcrumbs() {
    const root = this.root.querySelector<HTMLElement>(
      ".ssh-files-breadcrumbs",
    )!;
    const parts = this.path.split("/").filter(Boolean);
    const first = document.createElement("button");
    first.type = "button";
    first.dataset.remoteDirectory = "/";
    first.textContent = "/";
    const nodes: Node[] = [first];
    let current = "";
    parts.forEach((part, index) => {
      current += "/" + part;
      if (index < parts.length - 3) return;
      if (nodes.length > 1 || index > 0)
        nodes.push(document.createTextNode(" / "));
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.remoteDirectory = current;
      button.textContent = part;
      button.title = current;
      nodes.push(button);
    });
    root.replaceChildren(...nodes);
  }
  private selected() {
    return this.entries.filter((entry) => this.selection.has(entry.path));
  }
  private select(index: number, additive = false, range = false) {
    if (!this.filtered[index]) return;
    this.cursor = index;
    if (!additive) this.selection.clear();
    if (range) {
      for (
        let n = Math.min(index, this.anchor);
        n <= Math.max(index, this.anchor);
        n++
      )
        if (this.filtered[n]) this.selection.add(this.filtered[n].path);
    } else {
      const path = this.filtered[index].path;
      if (additive && this.selection.has(path)) this.selection.delete(path);
      else this.selection.add(path);
      this.anchor = index;
    }
    this.viewport.focus({ preventScroll: true });
    this.renderRows();
    this.syncActions();
  }
  private key(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      event.stopPropagation();
      this.selection = new Set(this.filtered.map((entry) => entry.path));
      this.renderRows();
      this.syncActions();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const index = Math.max(
        0,
        Math.min(
          this.filtered.length - 1,
          this.cursor + (event.key === "ArrowDown" ? 1 : -1),
        ),
      );
      this.select(index, event.ctrlKey, event.shiftKey);
      if (index * rowHeight < this.viewport.scrollTop)
        this.viewport.scrollTop = index * rowHeight;
      else if (
        (index + 1) * rowHeight >
        this.viewport.scrollTop + this.viewport.clientHeight
      )
        this.viewport.scrollTop =
          (index + 1) * rowHeight - this.viewport.clientHeight;
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const item = this.selected()[0];
      if (item) void this.openEntry(item);
    } else if (event.key === "Backspace") {
      event.preventDefault();
      event.stopPropagation();
      void this.load(remoteParent(this.path));
    } else if (event.key === "Delete" || event.key === "F2") {
      event.preventDefault();
      event.stopPropagation();
      void this.action(event.key === "Delete" ? "remove" : "rename");
    }
  }
  private syncActions() {
    const selected = this.selected();
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(
      "[data-file-action]",
    )) {
      const action = button.dataset.fileAction!;
      if (["hidden", "cancel-edit", "retry"].includes(action)) continue;
      button.disabled =
        !this.ready ||
        this.loading ||
        (["open", "rename", "properties"].includes(action) && selected.length !== 1) ||
        (["download", "remove"].includes(action) &&
          (!selected.length || selected.length > 256));
    }
    this.pathField.disabled = !this.ready;
  }
  private async openEntry(entry: RemoteEntry) {
    if (!entry || !this.ready || this.loading) return;
    if (entry.kind === "link") {
      const session = this.sessionId;
      try {
        const result = await this.services.files!.stat({
          sessionId: session,
          path: entry.path,
        });
        if (session !== this.sessionId) return;
        if (!result.ok || !result.result) {
          this.feedback(result.error || "无法读取链接");
          return;
        }
        if (result.result.targetKind === "directory")
          await this.load(entry.path);
        else {
          this.editEntry("properties", [entry]);
          this.editor.querySelector(
            ".ssh-file-editor-description",
          )!.textContent +=
            "\n→ " + (result.result.linkTarget || "链接目标不可用");
        }
      } catch (error) {
        if (session === this.sessionId) this.feedback(String(error));
      }
    } else if (entry.kind === "directory") await this.load(entry.path);
    else if (entry.kind === "file") {
      if (entry.size > 1048576) { this.feedback("文本编辑限 1 MiB，大文件请下载后编辑"); return; }
      const { RemoteTextEditor } = await import("./text-editor");
      if (this.disposed) return;
      this.textEditor ??= new RemoteTextEditor(this.services, this.reduced);
      await this.textEditor.open(entry.path);
    } else this.editEntry("properties", [entry]);
  }
  private async action(action: string) {
    if (action === "hidden") {
      this.showHidden = !this.showHidden;
      this.root
        .querySelector('[data-file-action="hidden"]')!
        .setAttribute("aria-pressed", String(this.showHidden));
      this.selection.clear();
      this.filter();
      return;
    }
    if (action === "cancel-edit") {
      this.closeEditor();
      this.viewport.focus();
      return;
    }
    if (action === "retry") {
      const result = await this.services.files?.reconnect({
        sessionId: this.sessionId,
      });
      if (result && !result.ok) this.feedback(result.error || "重试失败");
      return;
    }
    if (!this.ready || this.loading || !this.services.files) return;
    const sessionId = this.sessionId;
    try {
      if (action === "bookmark") this.onBookmark?.(this.path);
      else if (action === "open") { const entry = this.selected()[0]; if (entry) await this.openEntry(entry); }
      else if (action === "refresh") await this.load(this.path, true);
      else if (action === "parent") await this.load(remoteParent(this.path));
      else if (action === "upload" || action === "upload-folder")
        this.transferResult(
          await this.services.files.upload({
            sessionId,
            destination: this.path,
            directory: action === "upload-folder",
          }),
          sessionId,
        );
      else if (action === "download") {
        const selected = this.selected();
        if (selected.length && selected.length <= 256)
          this.transferResult(
            await this.services.files.download({
              sessionId,
              paths: selected.map((entry) => entry.path),
            }),
            sessionId,
          );
      } else if (["mkdir", "rename", "remove", "properties"].includes(action))
        this.editEntry(action, this.selected());
    } catch (error) {
      if (sessionId === this.sessionId) this.feedback(String(error));
    }
  }
  private transferResult(result: ServiceResult, sessionId: string) {
    if (sessionId !== this.sessionId || result.canceled) return;
    if (!result.ok) this.feedback(result.error || "无法加入传输队列");
    else {
      this.feedback("已加入传输队列");
      this.openQueue();
    }
  }
  private editEntry(action: string, entries: RemoteEntry[]) {
    if (["rename", "properties"].includes(action) && entries.length !== 1)
      return;
    if (action === "remove" && (!entries.length || entries.length > 256))
      return;
    this.edit = { action, entries, sessionId: this.sessionId, path: this.path };
    this.editRevision++;
    this.editor.hidden = false;
    this.editor.querySelector(".ssh-file-editor-title")!.textContent = (
      {
        mkdir: "NEW DIRECTORY",
        rename: "RENAME",
        remove: "CONFIRM DELETE",
        properties: "FILE DETAILS",
      } as Record<string, string>
    )[action];
    const description = this.editor.querySelector<HTMLElement>(
      ".ssh-file-editor-description",
    )!;
    description.textContent =
      action === "mkdir"
        ? this.path
        : action === "remove"
          ? "删除以下 " +
            entries.length +
            " 项，目录包含其中的内容：\n" +
            entries.map((entry) => entry.name).join("\n")
          : entries[0].path;
    this.editorName.hidden = action === "remove" || action === "properties";
    this.editorName.value = action === "rename" ? entries[0].name : "";
    const confirm = this.editor.querySelector<HTMLButtonElement>(
      ".ssh-file-editor-submit",
    )!;
    confirm.hidden = action === "properties";
    confirm.disabled = false;
    confirm.textContent = action === "remove" ? "确认删除" : "确认";
    if (action === "properties")
      description.textContent +=
        "\n" +
        entries[0].permissions +
        "\n" +
        bytes(entries[0].size) +
        "\n" +
        new Date(entries[0].modified).toLocaleString();
    this.motion.reveal(this.editor, this.reduced());
    if (!this.editorName.hidden) {
      this.editorName.focus();
      this.editorName.select();
    } else
      this.editor
        .querySelector<HTMLButtonElement>('[data-file-action="cancel-edit"]')!
        .focus();
  }
  private closeEditor() {
    this.edit = null;
    this.editRevision++;
    this.editor.hidden = true;
  }
  private async submitEdit() {
    const edit = this.edit,
      revision = this.editRevision;
    if (
      !edit ||
      !this.ready ||
      edit.sessionId !== this.sessionId ||
      !this.services.files
    )
      return;
    const name = this.editorName.value;
    if (
      edit.action !== "remove" &&
      (!name || name === "." || name === ".." || /[\/\0]/.test(name))
    ) {
      this.feedback("请输入有效的单个名称");
      return;
    }
    const button = this.editor.querySelector<HTMLButtonElement>(
      ".ssh-file-editor-submit",
    )!;
    if (button.disabled) return;
    button.disabled = true;
    try {
      let result: ServiceResult;
      if (edit.action === "mkdir")
        result = await this.services.files.mkdir({
          sessionId: edit.sessionId,
          path: remoteJoin(edit.path, name),
        });
      else if (edit.action === "rename")
        result = await this.services.files.rename({
          sessionId: edit.sessionId,
          path: edit.entries[0].path,
          destination: remoteJoin(edit.path, name),
        });
      else
        result = await this.services.files.remove({
          sessionId: edit.sessionId,
          paths: edit.entries.map((entry) => entry.path),
          recursive: true,
        });
      if (revision !== this.editRevision || edit.sessionId !== this.sessionId)
        return;
      if (result.ok) {
        this.closeEditor();
        await this.load(edit.path, true);
        this.feedback("操作已完成");
        this.viewport.focus();
      } else {
        if (edit.action === "remove") {
          const removed =
            (result.result as { removed?: string[] } | undefined)?.removed ??
            [];
          edit.entries = edit.entries.filter(
            (entry) => !removed.includes(entry.path),
          );
          await this.load(edit.path, true);
          if (this.edit === edit)
            this.editor.querySelector(
              ".ssh-file-editor-description",
            )!.textContent =
              "以下项目未删除，可核查后重试：\n" +
              edit.entries.map((entry) => entry.name).join("\n");
        }
        this.feedback(result.error || "文件操作失败");
      }
    } catch (error) {
      if (revision === this.editRevision) this.feedback(String(error));
    } finally {
      if (revision === this.editRevision) button.disabled = false;
    }
  }
  dispose() {
    this.disposed = true;
    this.textEditor?.dispose();
    this.loadRevision++;
    this.abort.abort();
    this.resize.disconnect();
    this.motion.cancel();
    clearTimeout(this.refreshTimer);
  }
}
