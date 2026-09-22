import { SshPageMotion } from "./page-motion";
import type { WorkspaceStore } from "./workspace-store";
import {
  bytes,
  remoteJoin,
  remoteParent,
  type RemoteEntry,
  type ServiceResult,
  type ServicesState,
  SshServicesClient,
} from "./services";

/**
 * Hairline glyphs for the toolbar.
 *
 * The buttons are drawings only — the Chinese label each one stands for lives in
 * its `title` and `aria-label`, so it is still spoken and still available on
 * hover, but it no longer sets the width of a 320 px column. Same technique as
 * the trend line in monitor-panel.ts: inline SVG in `currentColor`, no icon font
 * and no emoji.
 */
const FILE_ICONS = {
  upload:
    '<path d="M8 2.6V10M4.9 5.7 8 2.6l3.1 3.1M3.1 10.4v1.7a1.4 1.4 0 0 0 1.4 1.4h7a1.4 1.4 0 0 0 1.4-1.4v-1.7"/>',
  uploadFolder:
    '<path d="M2 12.1V4.4a1.1 1.1 0 0 1 1.1-1.1h2.5l1.3 1.6h5.9a1.1 1.1 0 0 1 1.1 1.1v6.1a1.1 1.1 0 0 1-1.1 1.1H3.1A1.1 1.1 0 0 1 2 12.1Z"/><path d="M8 11.2V7.4M6.3 9.1 8 7.4l1.7 1.7"/>',
  download:
    '<path d="M8 2.6V10M4.9 6.9 8 10l3.1-3.1M3.1 10.4v1.7a1.4 1.4 0 0 0 1.4 1.4h7a1.4 1.4 0 0 0 1.4-1.4v-1.7"/>',
  mkdir:
    '<path d="M2 12.1V4.4a1.1 1.1 0 0 1 1.1-1.1h2.5l1.3 1.6h5.9a1.1 1.1 0 0 1 1.1 1.1v6.1a1.1 1.1 0 0 1-1.1 1.1H3.1A1.1 1.1 0 0 1 2 12.1Z"/><path d="M8 7.2v4M6 9.2h4"/>',
  bookmarkAdd:
    '<path d="M3.9 3.1A1.1 1.1 0 0 1 5 2h6a1.1 1.1 0 0 1 1.1 1.1v10.6L8 11.1l-4.1 2.6Z"/><path d="M8 5.4v3.2M6.4 7h3.2"/>',
  bookmarkList:
    '<path d="M3.9 3.1A1.1 1.1 0 0 1 5 2h6a1.1 1.1 0 0 1 1.1 1.1v10.6L8 11.1l-4.1 2.6Z"/>',
  refresh: '<path d="M13.1 8a5.1 5.1 0 1 1-1.5-3.6"/><path d="M13.3 2.5v3h-3"/>',
  eye: '<path d="M1.7 8S4.1 3.9 8 3.9 14.3 8 14.3 8 11.9 12.1 8 12.1 1.7 8 1.7 8Z"/><circle cx="8" cy="8" r="2.1"/>',
  eyeOff:
    '<path d="M6.5 4a6.9 6.9 0 0 1 1.5-.1c3.9 0 6.3 4.1 6.3 4.1a12.6 12.6 0 0 1-1.9 2.5M4 5.2A12.7 12.7 0 0 0 1.7 8S4.1 12.1 8 12.1a6.6 6.6 0 0 0 1.8-.2"/><path d="M2.6 2.6 13.4 13.4"/>',
};
function icon(name: keyof typeof FILE_ICONS) {
  return `<svg class="ssh-file-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${FILE_ICONS[name]}</svg>`;
}

const markup = `
  <div class="ssh-side-kicker" data-ssh-reveal><span>FILE INDEX</span><span class="ssh-files-count">00</span></div>
  <form class="ssh-files-path-form" data-ssh-reveal>
    <button type="button" data-file-action="parent" title="上一级目录 · Backspace">↑</button>
    <input class="ssh-files-path" aria-label="远端目录路径" spellcheck="false" autocomplete="off" placeholder="远端目录">
    <button type="submit" title="读取目录">↵</button>
  </form>
  <nav class="ssh-files-breadcrumbs" aria-label="目录层级" data-ssh-reveal></nav>
  <div class="ssh-file-actions ssh-file-toolbar" data-ssh-reveal>
    <button type="button" data-file-action="upload" title="上传文件" aria-label="上传文件">${icon("upload")}</button>
    <button type="button" data-file-action="upload-folder" title="上传目录" aria-label="上传目录">${icon("uploadFolder")}</button>
    <button type="button" data-file-action="download" title="下载所选" aria-label="下载所选">${icon("download")}</button>
    <button type="button" data-file-action="mkdir" title="新建目录" aria-label="新建目录">${icon("mkdir")}</button>
    <button type="button" data-file-action="bookmark" title="将当前目录存入收藏" aria-label="将当前目录存入收藏">${icon("bookmarkAdd")}</button>
    <button type="button" data-file-action="bookmarks" aria-expanded="false" aria-controls="ssh-files-bookmarks" title="收藏的目录" aria-label="收藏的目录">${icon("bookmarkList")}</button>
    <button type="button" data-file-action="refresh" class="ssh-file-refresh" title="刷新目录" aria-label="刷新目录">${icon("refresh")}</button>
    <div class="ssh-files-bookmarks" id="ssh-files-bookmarks" role="group" aria-label="收藏的目录" hidden></div>
  </div>
  <div class="ssh-files-filter" data-ssh-reveal>
    <input type="search" aria-label="筛选当前目录" placeholder="筛选当前目录" spellcheck="false">
    <select aria-label="文件排序"><option value="name">名称</option><option value="modified">修改时间</option><option value="size">大小</option><option value="kind">类型</option></select>
    <button type="button" data-file-action="hidden" aria-pressed="false" title="显示隐藏文件和文件夹" aria-label="显示隐藏文件和文件夹"><span class="ssh-file-icon-eye">${icon("eye")}</span><span class="ssh-file-icon-eye-off">${icon("eyeOff")}</span></button>
  </div>
  <div class="ssh-files-state" role="status"></div>
  <div class="ssh-files-list" role="listbox" aria-label="远端文件" aria-multiselectable="true" tabindex="0">
    <div class="ssh-files-space"><div class="ssh-file-rows"></div></div>
    <div class="ssh-files-empty"></div>
  </div>
  <div class="ssh-files-menu" id="ssh-files-menu" role="group" aria-label="文件操作" hidden></div>
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
const HIDDEN_KEY = "rhine-ssh-files-hidden";

/** Showing dotfiles is a preference, not a per-visit toggle: it survives a
 *  reload, the same way the stowed overview does. */
function readHiddenPref() {
  try {
    return localStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}
/** POSIX single-quote quoting, so a path with spaces or quotes still reaches the
 *  shell as one argument. */
function shellQuote(value: string) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
function writeHiddenPref(value: boolean) {
  try {
    localStorage.setItem(HIDDEN_KEY, value ? "1" : "0");
  } catch {
    /* Memory remains usable. */
  }
}

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
  /** Writes one shell command to this session's terminal. Returns false when
   *  there is no interactive shell to receive it, so the menu can hide the
   *  entry rather than offer something that would do nothing. */
  onTerminalCommand: ((command: string) => boolean) | undefined;
  private bookmarkStore?: WorkspaceStore;
  private bookmarkAlias = "";
  private offBookmarks?: () => void;
  private bookmarkSignature = "";
  private bookmarkList: HTMLElement;
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
  private showHidden = readHiddenPref();
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
  private fileMenu: HTMLElement;

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
    this.bookmarkList = root.querySelector(".ssh-files-bookmarks")!;
    this.fileMenu = root.querySelector(".ssh-files-menu")!;
    this.editor = root.querySelector(".ssh-file-editor")!;
    this.editorName = root.querySelector(".ssh-file-editor-name")!;
    // The stored preference decides the toggle's state, not the markup default.
    root
      .querySelector('[data-file-action="hidden"]')!
      .setAttribute("aria-pressed", String(this.showHidden));
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
        const button = target?.closest<HTMLButtonElement>("[data-file-action]");
        if (button) {
          void this.action(button.dataset.fileAction!, button);
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
    // The bookmark menu is a popover, so a click anywhere else dismisses it. The
    // root listener above has already run by the time this fires, which is why
    // the toggle's own click is excluded rather than the menu being reopened.
    document.addEventListener(
      "click",
      (event) => {
        if (this.bookmarkList.hidden) return;
        const target = event.target instanceof Element ? event.target : null;
        if (
          target?.closest(
            '[data-file-action="bookmarks"], .ssh-files-bookmarks',
          )
        )
          return;
        this.closeBookmarks(false);
      },
      options,
    );
    this.bookmarkList.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        this.closeBookmarks(true);
      },
      options,
    );
    root.addEventListener(
      "contextmenu",
      (event) => {
        const target = event.target instanceof Element ? event.target : null;
        // Only the file list answers; the path field and the toolbar keep the
        // browser's own menu so text editing still works there.
        if (!target?.closest(".ssh-files-list")) return;
        event.preventDefault();
        const row = target.closest<HTMLElement>("[data-file-index]");
        const index = row ? Number(row.dataset.fileIndex) : -1;
        // Right-clicking outside the current selection retargets it, the way
        // every desktop file manager behaves.
        if (index >= 0) {
          const entry = this.filtered[index];
          if (entry && !this.selection.has(entry.path)) this.select(index);
        }
        this.openFileMenu(index, (event as MouseEvent).clientX, (event as MouseEvent).clientY);
      },
      options,
    );
    this.fileMenu.addEventListener(
      "click",
      (event) => {
        const button = (event.target as Element).closest<HTMLElement>(
          "[data-menu-action]",
        );
        if (!button) return;
        const action = button.dataset.menuAction!;
        this.closeFileMenu(false);
        if (action === "copy-path" || action === "copy-name") {
          void this.copyToClipboard(action);
          return;
        }
        void this.action(action, button as HTMLButtonElement);
      },
      options,
    );
    this.fileMenu.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        this.closeFileMenu(true);
      },
      options,
    );
    document.addEventListener(
      "click",
      (event) => {
        if (this.fileMenu.hidden) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest(".ssh-files-menu")) return;
        this.closeFileMenu(false);
      },
      options,
    );
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
      // Both popovers point at rows that are about to be hidden.
      this.closeFileMenu(false);
      this.closeBookmarks(false);
    }
  }
  setBookmarkStore(store: WorkspaceStore | undefined, alias: string) {
    this.offBookmarks?.();
    this.offBookmarks = undefined;
    if (this.disposed) return;
    this.bookmarkStore = store;
    this.bookmarkAlias = alias;
    this.bookmarkSignature = "";
    this.offBookmarks = store?.onChange(() => this.renderBookmarks());
    this.renderBookmarks();
  }
  private hostBookmarks() {
    return this.bookmarkStore?.bookmarks.filter(row => row.alias === this.bookmarkAlias) ?? [];
  }
  private renderBookmarks() {
    const bookmarks = this.hostBookmarks();
    const signature = JSON.stringify(bookmarks);
    if (signature !== this.bookmarkSignature) {
      this.bookmarkSignature = signature;
      this.bookmarkList.replaceChildren();
      if (bookmarks.length) {
        for (const row of bookmarks) {
          const button = document.createElement("button");
          button.type = "button";
          button.dataset.fileAction = "open-bookmark";
          button.dataset.bookmarkId = row.id;
          // The full path is the point of the menu — it is what the old
          // select only showed once an option was opened.
          button.title = row.path;
          const name = document.createElement("strong");
          name.textContent = row.name;
          const path = document.createElement("span");
          path.textContent = row.path;
          button.append(name, path);
          this.bookmarkList.append(button);
        }
      } else {
        const empty = document.createElement("p");
        empty.className = "ssh-files-bookmarks-empty";
        empty.textContent = "当前主机暂无收藏";
        this.bookmarkList.append(empty);
        this.closeBookmarks(false);
      }
    }
    this.syncActions();
  }
  private toggleBookmarks() {
    if (this.bookmarkList.hidden) {
      this.bookmarkList.hidden = false;
      this.root
        .querySelector('[data-file-action="bookmarks"]')!
        .setAttribute("aria-expanded", "true");
      this.bookmarkList
        .querySelector<HTMLButtonElement>("[data-file-action]")
        ?.focus();
    } else this.closeBookmarks(false);
  }
  private closeBookmarks(restoreFocus: boolean) {
    if (this.bookmarkList.hidden) return;
    this.bookmarkList.hidden = true;
    const toggle = this.root.querySelector<HTMLButtonElement>(
      '[data-file-action="bookmarks"]',
    )!;
    toggle.setAttribute("aria-expanded", "false");
    if (restoreFocus) toggle.focus();
  }
  /**
   * What the right-click menu offers, decided once from the state it opened in.
   *
   * Items carry `data-menu-action`, not `data-file-action`: the toolbar's
   * disabled-state pass walks every `[data-file-action]` in the panel, and a
   * menu that changed under the pointer as the selection changed would fight it.
   */
  private fileMenuItems(index: number) {
    const entry = index >= 0 ? this.filtered[index] : undefined;
    const selection = this.selected();
    const items: { action: string; label: string; disabled?: boolean }[] = [];
    if (entry) {
      items.push({
        action: "open",
        label: entry.kind === "directory" ? "打开目录" : "打开",
      });
      // Only offered when a shell is actually there to receive it.
      if (entry.kind === "directory" && this.onTerminalCommand)
        items.push({ action: "cd-here", label: "在终端中进入" });
      items.push({
        action: "download",
        label: "下载",
        disabled: !selection.length || selection.length > 256,
      });
      items.push({
        action: "rename",
        label: "重命名",
        disabled: selection.length !== 1,
      });
      items.push({
        action: "properties",
        label: "详情",
        disabled: selection.length !== 1,
      });
      items.push({
        action: "remove",
        label: "删除",
        disabled: !selection.length || selection.length > 256,
      });
      if (window.rhineDesktop?.clipboard) {
        items.push({
          action: "copy-path",
          label: "复制路径",
          disabled: !selection.length,
        });
        items.push({
          action: "copy-name",
          label: "复制文件名",
          disabled: selection.length !== 1,
        });
      }
    } else {
      items.push({ action: "mkdir", label: "新建目录" });
      items.push({ action: "upload", label: "上传文件" });
      items.push({ action: "upload-folder", label: "上传目录" });
      items.push({
        action: "hidden",
        label: this.showHidden ? "隐藏点文件" : "显示隐藏文件",
      });
    }
    items.push({ action: "refresh", label: "刷新" });
    return items;
  }
  private openFileMenu(index: number, clientX: number, clientY: number) {
    this.closeBookmarks(false);
    this.fileMenu.replaceChildren(
      ...this.fileMenuItems(index).map((item) => {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.menuAction = item.action;
        button.textContent = item.label;
        button.disabled = Boolean(item.disabled);
        return button;
      }),
    );
    this.fileMenu.hidden = false;
    // The SSH surface sits inside a scaled stage, so a pointer position has to be
    // converted back into the panel's own pixels before it can place anything;
    // offsetWidth/offsetHeight are already in that space.
    const rect = this.root.getBoundingClientRect();
    const scale = rect.width / this.root.clientWidth || 1;
    const x = Math.max(
      0,
      Math.min(
        this.root.clientWidth - this.fileMenu.offsetWidth,
        (clientX - rect.left) / scale,
      ),
    );
    const y = Math.max(
      0,
      Math.min(
        this.root.clientHeight - this.fileMenu.offsetHeight,
        (clientY - rect.top) / scale,
      ),
    );
    this.fileMenu.style.left = `${x}px`;
    this.fileMenu.style.top = `${y}px`;
    this.fileMenu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }
  private closeFileMenu(restoreFocus: boolean) {
    if (this.fileMenu.hidden) return;
    this.fileMenu.hidden = true;
    if (restoreFocus) this.viewport.focus();
  }
  private async copyToClipboard(kind: "copy-path" | "copy-name") {
    const selection = this.selected();
    if (!selection.length) return;
    const bridge = window.rhineDesktop?.clipboard;
    if (!bridge) {
      this.feedback("当前环境不支持复制远端路径");
      return;
    }
    const text =
      kind === "copy-path"
        ? selection.map((entry) => entry.path).join("\n")
        : selection[0].name;
    try {
      const result = await bridge.writeText(text);
      this.feedback(result.ok ? "已复制到剪贴板" : result.error || "复制失败");
    } catch (error) {
      this.feedback(String(error));
    }
  }
  private runInTerminal(path: string) {
    if (this.onTerminalCommand?.(`cd ${shellQuote(path)}`))
      this.feedback("已在终端中切换目录");
    else this.feedback("终端当前无法接收命令");
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
    // The rows the menu points at are about to be replaced.
    this.closeFileMenu(false);
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
    const bookmarks = this.hostBookmarks();
    const menu = this.root.querySelector<HTMLButtonElement>(
      '[data-file-action="bookmarks"]',
    )!;
    menu.disabled = !this.ready || this.loading || !bookmarks.length;
    menu.title = bookmarks.length
      ? `收藏的目录 · ${bookmarks.length}`
      : "当前主机暂无收藏";
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(
      "[data-file-action]",
    )) {
      const action = button.dataset.fileAction!;
      if (["hidden", "bookmarks", "cancel-edit", "retry"].includes(action))
        continue;
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
  private async action(action: string, button?: HTMLButtonElement) {
    if (action === "hidden") {
      this.showHidden = !this.showHidden;
      writeHiddenPref(this.showHidden);
      this.root
        .querySelector('[data-file-action="hidden"]')!
        .setAttribute("aria-pressed", String(this.showHidden));
      this.selection.clear();
      this.filter();
      return;
    }
    if (action === "bookmarks") {
      this.toggleBookmarks();
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
      else if (action === "cd-here") {
        const entry = this.selected()[0];
        if (entry?.kind === "directory") this.runInTerminal(entry.path);
      } else if (action === "open-bookmark") {
        const bookmark = this.hostBookmarks().find(
          row => row.id === button?.dataset.bookmarkId,
        );
        this.closeBookmarks(false);
        if (bookmark) await this.openDirectory(bookmark.path);
      }
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
    this.offBookmarks?.();
    this.offBookmarks = undefined;
    this.bookmarkStore = undefined;
    this.onBookmark = undefined;
    this.textEditor?.dispose();
    this.loadRevision++;
    this.abort.abort();
    this.resize.disconnect();
    this.motion.cancel();
    clearTimeout(this.refreshTimer);
  }
}
