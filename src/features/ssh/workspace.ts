import { SftpPanel } from "./files-panel";
import { MonitorPanel } from "./monitor-panel";
import { TransferPanel } from "./transfer-panel";
import { SshPageMotion } from "./page-motion";
import type { SshServicesClient } from "./services";
import type { WorkspaceLayout, WorkspaceStore } from "./workspace-store";
import "./workspace.css";

export const WORKSPACE_NAV = `<nav class="ssh-workspace-tabs" role="tablist" aria-label="SSH 工作区" hidden><button type="button" role="tab" data-workspace-page="terminal" aria-controls="ssh-terminal-main">终端</button><button type="button" role="tab" data-workspace-page="files" aria-controls="ssh-workspace-files">文件</button><button type="button" role="tab" data-workspace-page="monitor" aria-controls="ssh-workspace-monitor">监控</button></nav>`;
export const WORKSPACE_SIDE = `<div class="ssh-side-divider" role="separator" tabindex="0" aria-label="调整侧栏宽度" aria-orientation="vertical" aria-valuemin="260" aria-valuemax="480" aria-valuenow="320" hidden></div><aside class="ssh-workspace-side" hidden><section id="ssh-workspace-files" class="ssh-files" role="tabpanel" aria-label="SFTP 文件" data-ssh-auxiliary hidden></section><section id="ssh-workspace-monitor" class="ssh-monitor" role="tabpanel" aria-label="主机监控" tabindex="0" data-ssh-auxiliary hidden></section></aside>`;
type Page = "terminal" | "files" | "monitor";
const WIDTH_KEY = "rhine.ssh.sidebar-width";

export class SshWorkspace {
  private files: SftpPanel;
  private monitor: MonitorPanel;
  private queue: TransferPanel;
  private motion = new SshPageMotion();
  private abort = new AbortController();
  private resize: ResizeObserver;
  private off: () => void;
  private main: HTMLElement;
  private sidebar: HTMLElement;
  private divider: HTMLElement;
  private fileRoot: HTMLElement;
  private monitorRoot: HTMLElement;
  private tabs: HTMLElement;
  private compact = false;
  private page: Page = "files";
  private visible = false;
  private initialized = false;
  private reduced = false;
  private width = 320;
  private saveLayout: ((layout: WorkspaceLayout) => void) | undefined;
  private savedSplit: Pick<WorkspaceLayout, "splitAlias" | "splitRatio"> = {};
  private actualWidth = 320;
  private dragging: {
    id: number;
    x: number;
    width: number;
    scale: number;
  } | null = null;

  constructor(
    private root: HTMLElement,
    services: SshServicesClient,
    private host: {
      fit(): void;
      focusTerminal(): void;
      fontSize(): number;
      hideTerminalTools(): void;
    },
  ) {
    this.main = root.querySelector(".ssh-terminal-main")!;
    this.sidebar = root.querySelector(".ssh-workspace-side")!;
    this.divider = root.querySelector(".ssh-side-divider")!;
    this.fileRoot = root.querySelector(".ssh-files")!;
    this.monitorRoot = root.querySelector(".ssh-monitor")!;
    this.tabs = root.querySelector(".ssh-workspace-tabs")!;
    this.tabs.hidden = false;
    root.classList.add("has-workspace");
    const toggle = root.querySelector<HTMLButtonElement>(
      ".ssh-transfer-toggle",
    )!;
    toggle.hidden = false;
    try {
      const saved = Number(localStorage.getItem(WIDTH_KEY));
      if (saved >= 260 && saved <= 480) this.width = saved;
    } catch {
      /* session defaults */
    }
    this.queue = new TransferPanel(
      root.querySelector(".ssh-transfer-drawer")!,
      toggle,
      services,
      () => this.reduced,
      () => host.fit(),
    );
    this.files = new SftpPanel(
      this.fileRoot,
      services,
      () => this.reduced,
      () => this.queue.show(),
    );
    this.monitor = new MonitorPanel(
      this.monitorRoot,
      services,
      () => this.reduced,
    );
    this.off = services.onChange((state, event) => {
      // A 1 Hz sample does not rebuild file rows or the transfer queue.
      if (event?.event !== "sample") {
        this.files.update(state);
        this.queue.update(state);
      }
      this.monitor.update(state);
    });
    this.files.update(services.state);
    this.monitor.update(services.state);
    this.queue.update(services.state);
    const options = { signal: this.abort.signal };
    this.tabs.addEventListener(
      "click",
      (event) => {
        const tab =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>("[data-workspace-page]")
            : null;
        if (tab) this.select(tab.dataset.workspacePage as Page);
      },
      options,
    );
    this.tabs.addEventListener(
      "keydown",
      (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        event.stopPropagation();
        const pages: Page[] = ["terminal", "files", "monitor"];
        const index = pages.indexOf(this.page);
        this.select(
          pages[
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? 2
                : (index + (event.key === "ArrowRight" ? 1 : 2)) % 3
          ],
          false,
        );
        this.tabs
          .querySelector<HTMLElement>(`[data-workspace-page="${this.page}"]`)!
          .focus();
      },
      options,
    );
    this.divider.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        this.dragging = {
          id: event.pointerId,
          x: event.clientX,
          width: this.actualWidth,
          scale: root.getBoundingClientRect().width / root.clientWidth || 1,
        };
        this.divider.setPointerCapture(event.pointerId);
        root.dataset.resizing = "true";
      },
      options,
    );
    this.divider.addEventListener(
      "pointermove",
      (event) => {
        if (this.dragging?.id !== event.pointerId) return;
        this.width = Math.max(
          260,
          Math.min(
            480,
            this.dragging.width +
              (this.dragging.x - event.clientX) / this.dragging.scale,
          ),
        );
        this.layout();
      },
      options,
    );
    const stop = () => {
      this.dragging = null;
      delete root.dataset.resizing;
      this.saveWidth();
      host.fit();
    };
    this.divider.addEventListener("pointerup", stop, options);
    this.divider.addEventListener("lostpointercapture", stop, options);
    this.divider.addEventListener("pointercancel", stop, options);
    this.divider.addEventListener(
      "keydown",
      (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        event.stopPropagation();
        this.width =
          event.key === "Home"
            ? 260
            : event.key === "End"
              ? 480
              : Math.max(
                  260,
                  Math.min(
                    480,
                    this.actualWidth + (event.key === "ArrowLeft" ? 20 : -20),
                  ),
                );
        this.layout();
        this.saveWidth();
      },
      options,
    );
    this.resize = new ResizeObserver(() => this.layout());
    this.resize.observe(root);
  }
  get terminalVisible() {
    return !this.compact || this.page === "terminal";
  }
  get directory() { return this.files.directory; }
  openDirectory(path: string) {
    this.select("files", false);
    return this.files.openDirectory(path);
  }
  showTransfers() { this.queue.show(); }
  setBookmarkHandler(handler: (path: string) => void, store?: WorkspaceStore, alias = "") {
    this.files.onBookmark = handler;
    this.files.setBookmarkStore(store, alias);
  }
  /** Lets the file panel hand a command to this session's shell. */
  setTerminalCommand(handler: (command: string) => boolean) {
    this.files.onTerminalCommand = handler;
  }
  setLayout(saved: WorkspaceLayout | undefined, write: (layout: WorkspaceLayout) => void) {
    this.saveLayout = write;
    if (saved) { this.width = saved.width; this.page = saved.page; this.savedSplit = { splitAlias: saved.splitAlias, splitRatio: saved.splitRatio }; this.initialized = true; }
    this.layout();
  }
  setVisible(visible: boolean) {
    this.visible = visible;
    if (visible) this.layout();
    else {
      this.files.setVisible(false);
      this.monitor.setVisible(false);
      this.queue.hide(true);
      this.motion.cancel();
      this.main.inert = true;
    }
  }
  setReduced(reduced: boolean) {
    if (this.root.dataset.workspaceReduced === String(reduced)) return;
    this.reduced = reduced;
    if (reduced) {
      this.monitor.finishMotion();
      this.files.finishMotion();
      this.queue.finishMotion();
      this.motion.finish();
    }
    this.root.dataset.workspaceReduced = String(reduced);
  }
  private saveWidth() {
    this.saveLayout?.({ ...this.savedSplit, width: this.width, page: this.page });
    try {
      localStorage.setItem(WIDTH_KEY, String(Math.round(this.width)));
    } catch {
      /* in-memory preference */
    }
  }
  layout() {
    if (!this.visible || this.root.clientWidth < 1) return;
    // The operating screen uses native viewport pixels. Keep
    // 80 monospace columns plus xterm padding before reserving a side column.
    const terminalMin = Math.ceil(this.host.fontSize() * 0.62 * 80 + 48);
    const max = Math.min(480, this.main.parentElement!.clientWidth - terminalMin - 9);
    const compact = max < 260;
    if (compact !== this.compact) {
      this.compact = compact;
      if (
        compact &&
        (!this.initialized ||
          this.main.contains(document.activeElement) ||
          this.root
            .querySelector(".ssh-terminal-tools")!
            .contains(document.activeElement))
      )
        this.page = "terminal";
    }
    this.initialized = true;
    this.actualWidth = Math.round(Math.max(260, Math.min(max, this.width)));
    this.root.style.setProperty("--ssh-sidebar-width", this.actualWidth + "px");
    this.root.dataset.workspace = compact ? "compact" : "split";
    this.divider.setAttribute("aria-valuenow", String(this.actualWidth));
    this.divider.setAttribute(
      "aria-valuemax",
      String(Math.max(260, Math.floor(max))),
    );
    this.renderPages();
  }
  select(page: Page, focus = true) {
    const changed = page !== this.page;
    this.page = page;
    if (changed) this.saveLayout?.({ ...this.savedSplit, width: this.width, page });
    this.renderPages();
    if (changed && page === "terminal")
      this.motion.reveal(this.main, this.reduced);
    if (focus) {
      if (page === "terminal") this.host.focusTerminal();
      else if (page === "files") this.files.focus();
      else this.monitor.focus();
    }
  }
  focus() {
    if (this.terminalVisible) this.host.focusTerminal();
    else if (this.page === "files") this.files.focus();
    else this.monitor.focus();
  }
  private renderPages() {
    const side = this.page !== "terminal";
    const hidingTerminal = !this.main.hidden && !this.terminalVisible;
    this.main.hidden = !this.terminalVisible;
    this.main.inert = !this.visible || !this.terminalVisible;
    if (hidingTerminal) this.host.hideTerminalTools();
    this.sidebar.hidden = !side;
    this.divider.hidden = !side || this.compact;
    this.fileRoot.hidden = this.page !== "files";
    this.monitorRoot.hidden = this.page !== "monitor";
    this.root.dataset.workspacePage = this.page;
    this.files.setVisible(this.visible && this.page === "files");
    this.monitor.setVisible(this.visible && this.page === "monitor");
    for (const tab of this.tabs.querySelectorAll<HTMLElement>(
      "[data-workspace-page]",
    )) {
      const selected = tab.dataset.workspacePage === this.page;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    this.host.fit();
  }
  dispose() {
    this.off();
    this.abort.abort();
    this.resize.disconnect();
    this.files.dispose();
    this.monitor.dispose();
    this.queue.dispose();
    this.motion.cancel();
  }
}
