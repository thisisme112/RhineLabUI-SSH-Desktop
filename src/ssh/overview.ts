import { SurfaceTransition, ContentTransition } from "../ui-transitions";
import {
  hostLabel,
  hostSubtitle,
  type SshHostCards,
  type ResourceKind,
} from "./host-cards";
import type { SshSessionBank } from "./session-bank";
import { sessionLabel, sessionState, type SshLibrary } from "./library";
import type { SshHostsPanel } from "./hosts-panel";
import { SshKeysPanel } from "./keys-panel";
import { SessionTabs } from "./session-tabs";
import { records } from "../data";
import "./overview.css";

type Page = "hosts" | "command" | "history" | "files" | "keys" | "editor" | "shortcut";

const COLLAPSED_KEY = "rhine-ssh-overview-collapsed";

/** A stowed overview is a preference, not a mode: it survives a reload. */
function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}
function writeCollapsed(value: boolean) {
  try {
    localStorage.setItem(COLLAPSED_KEY, value ? "1" : "0");
  } catch {
    /* Memory remains usable. */
  }
}

export class SshOverview {
  readonly root = document.createElement("section");
  private content: HTMLElement;
  private hostPage: HTMLElement;
  private list: HTMLElement;
  private holder: HTMLElement;
  private glass: HTMLElement;
  private restore: HTMLElement;
  private rows = new Map<string, HTMLElement>();
  private query = "";
  private page: Page = "hosts";
  private visible = false;
  private collapsed = false;
  private timer = 0;
  private focusAlias = "";
  private transition: SurfaceTransition;
  private contentTransition = new ContentTransition();
  private tabs = new SessionTabs();
  private keys: SshKeysPanel;
  constructor(
    private cards: SshHostCards,
    private bank: SshSessionBank,
    private hosts: SshHostsPanel,
    private library: SshLibrary,
    private actions: {
      reduced(): boolean;
      preview(alias: string): void;
      inspect(alias: string): void;
      collapsedChanged(value: boolean): void;
      connect(alias: string, fresh?: boolean): void;
      session(key: string): void;
      closeSession(key: string): void;
      settings(): void;
      search(): void;
      pageSound(): void;
    },
  ) {
    this.root.className = "ssh-overview";
    this.root.hidden = true;
    this.root.setAttribute("aria-label", "SSH 主机总览");
    this.root.innerHTML = `<div class="ssh-overview-glass"><header class="ssh-overview-heading"><div><span>RHINE LAB / NETWORK OPERATIONS</span><h1>主机总览<small>HOST OVERVIEW</small></h1></div><div class="ssh-overview-heading-actions"><button type="button" data-overview-action="collapse" aria-expanded="true" title="收起总览，让出三维档案阵列 · Ctrl+Shift+H"><span>收起</span> ⇱</button><button type="button" data-overview-action="settings">设置 ⚙</button></div></header>
      <div class="ssh-overview-summary" aria-live="off"></div><nav class="ssh-overview-nav" aria-label="主机管理"><button type="button" data-overview-page="hosts" aria-current="page">主机</button><button type="button" data-overview-page="command">命令</button><button type="button" data-overview-page="files">目录收藏</button><button type="button" data-overview-page="history">历史</button><button type="button" data-overview-page="keys">密钥库</button><button type="button" data-overview-action="add">添加主机 ＋</button></nav>
      <div class="ssh-overview-content"><div class="ssh-overview-hosts"><div class="ssh-overview-search"><span>⌕</span><input type="search" aria-label="搜索主机总览" placeholder="检索名称、地址、用户或档案编号" autocomplete="off"><span>悬停定位 · 单击连接</span></div><div class="ssh-overview-columns"><span>HOST / 主机档案</span><span>SESSION / 连接状态</span><span>LOAD / 实时占用</span></div><div class="ssh-overview-scroll"><div class="ssh-overview-host-list"></div></div><p class="ssh-overview-empty" role="status"></p></div><div class="ssh-overview-secondary" hidden></div></div>
      <footer class="ssh-overview-footer"><span>LOCAL ARCHIVES <i>●</i></span><span class="ssh-overview-selection">等待选择主机</span></footer></div>
      <button type="button" class="ssh-overview-restore" data-overview-action="collapse" aria-expanded="false" title="展开主机总览 · Ctrl+Shift+H"><span>▲ 主机总览</span><small></small><kbd>Ctrl+Shift+H</kbd></button>`;
    this.content = this.root.querySelector(".ssh-overview-content")!;
    const search = document.createElement("button"); search.type = "button"; search.textContent = "全局检索 ⌕"; search.dataset.overviewAction = "search"; search.title = "主机、项目、目录、命令、会话 · Ctrl+Shift+K";
    this.root.querySelector(".ssh-overview-heading-actions")!.prepend(search);
    this.hostPage = this.root.querySelector(".ssh-overview-hosts")!;
    this.list = this.root.querySelector(".ssh-overview-host-list")!;
    const shortcutTab = document.createElement("button"); shortcutTab.type = "button";
    shortcutTab.dataset.overviewPage = "shortcut"; shortcutTab.textContent = "快捷档案";
    this.root.querySelector('[data-overview-page="command"]')!.before(shortcutTab);
    this.holder = this.root.querySelector(".ssh-overview-secondary")!;
    this.restore = this.root.querySelector(".ssh-overview-restore")!;
    this.glass = this.root.querySelector(".ssh-overview-glass")!;
    this.setCollapsed(readCollapsed(), true);
    this.transition = new SurfaceTransition(
      this.root,
      undefined,
      300,
      200,
    );
    this.keys = new SshKeysPanel(actions.reduced);
    this.root.querySelector(".ssh-overview-nav")!.before(this.tabs.root);
    this.root.querySelector("input")!.addEventListener("input", (event) => {
      this.query = (event.target as HTMLInputElement).value;
      this.updateHosts();
    });
    this.root.addEventListener("click", (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>(
        "button",
      );
      if (!button) return;
      const action = button.dataset.overviewAction,
        page = button.dataset.overviewPage as Page;
      if (page) {
        event.stopPropagation();
        this.showPage(page);
        return;
      }
      if (!action) return;
      event.stopPropagation();
      const alias =
        button.closest<HTMLElement>("[data-host-alias]")?.dataset.hostAlias;
      if (action === "collapse") {
        // The stowed sheet keeps its own affordance on screen, so this is a
        // toggle rather than a one-way exit.
        this.setCollapsed(!this.collapsed);
        this.actions.pageSound();
      } else if (action === "settings") this.actions.settings();
      else if (action === "search") this.actions.search();
      else if (action === "add") this.edit();
      else if (alias && action === "edit") this.edit(alias);
      else if (alias && action === "inspect") this.actions.inspect(alias);
      else if (alias) this.actions.connect(alias, action === "new");
    });
    const hover = (event: Event) => {
      const row = (event.target as Element).closest<HTMLElement>(
        "[data-host-alias]",
      );
      if (!row || row.dataset.hostAlias === this.focusAlias) return;
      this.focusAlias = row.dataset.hostAlias!;
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => {
        if (this.visible && !this.collapsed && this.page === "hosts")
          this.actions.preview(this.focusAlias);
      }, 100);
      this.root.querySelector(".ssh-overview-selection")!.textContent =
        row.querySelector("strong")!.textContent;
      for (const item of this.rows.values())
        item.dataset.preview = String(item === row);
    };
    this.list.addEventListener("pointerover", hover);
    this.list.addEventListener("focusin", hover);
    this.list.addEventListener("pointerleave", () => {
      clearTimeout(this.timer);
      this.focusAlias = "";
    });
    // Native overlays must not send wheel / shortcuts through to the 3D canvas.
    this.root.addEventListener("wheel", (event) => event.stopPropagation(), {
      passive: true,
    });
    this.root.addEventListener("keydown", (event) => {
      if (!this.collapsed && !event.ctrlKey) event.stopPropagation();
    });
  }
  setVisible(show: boolean, blocked = false) {
    this.root.classList.toggle("reduce-motion", this.actions.reduced());
    this.root.inert = !show || blocked;
    if (show === this.visible) return;
    this.visible = show;
    if (show) {
      this.update();
      this.transition.show(this.actions.reduced());
    } else {
      clearTimeout(this.timer);
      this.transition.hide(this.actions.reduced());
    }
  }
  /**
   * Stowing is not hiding: the sheet leaves the frame and a single edge tab
   * stays behind, so the archive array underneath is both visible and
   * interactive while the way back is never a guess.
   */
  setCollapsed(value: boolean, force = false) {
    if (!force && value === this.collapsed) return;
    const focusWasRestore = this.restore.contains(document.activeElement);
    const focusWasGlass = this.glass.contains(document.activeElement);
    this.collapsed = value;
    this.root.dataset.collapsed = String(value);
    this.glass.inert = value;
    this.glass.setAttribute("aria-hidden", String(value));
    this.restore.inert = !value;
    this.restore.setAttribute("aria-hidden", String(!value));
    writeCollapsed(value);
    this.root
      .querySelectorAll<HTMLButtonElement>('[data-overview-action="collapse"]')
      .forEach((button) =>
        button.setAttribute("aria-expanded", String(!value)),
      );
    if (value) {
      clearTimeout(this.timer);
      this.focusAlias = "";
      if (focusWasGlass) this.restore.focus({ preventScroll: true });
    }
    else {
      this.update();
      if (focusWasRestore)
        this.root
          .querySelector<HTMLButtonElement>(
            '.ssh-overview-heading-actions [data-overview-action="collapse"]',
          )
          ?.focus({ preventScroll: true });
    }
    this.actions.collapsedChanged(value);
  }
  toggleCollapsed() {
    this.setCollapsed(!this.collapsed);
  }
  get isCollapsed() {
    return this.collapsed;
  }
  showPage(page: Page, card?: number, sound = true) {
    if (page === this.page && card === undefined && page !== "editor") return;
    clearTimeout(this.timer);
    this.focusAlias = "";
    this.library.unmount();
    this.hosts.unmount();
    this.keys.unmount();
    this.page = page;
    this.holder.replaceChildren();
    this.hostPage.hidden = page !== "hosts";
    this.holder.hidden = page === "hosts";
    if (page === "hosts") this.updateHosts();
    this.root
      .querySelectorAll<HTMLElement>("[data-overview-page]")
      .forEach((button) =>
        button.setAttribute(
          "aria-current",
          button.dataset.overviewPage === page ? "page" : "false",
        ),
      );
    if (page === "keys") this.keys.mount(this.holder);
    else if (["command", "history", "files", "shortcut"].includes(page)) {
      const record =
        card ?? this.cards.resourceCard(page as ResourceKind, "directory");
      if (record !== undefined) this.library.mount(this.holder, record);
    }
    this.contentTransition.reveal(this.content, this.actions.reduced());
    if (sound) this.actions.pageSound();
  }
  edit(alias?: string) {
    this.showPage("editor");
    this.hosts.mount(
      this.holder,
      alias ? "config" : "connect",
      this.cards.bound.find((host) => host.alias === alias),
    );
  }
  get editing() {
    return this.page === "editor";
  }
  focusHost(alias?: string | null) {
    (alias
      ? this.rows
          .get(alias)
          ?.querySelector<HTMLButtonElement>(".ssh-overview-connect")
      : null
    )?.focus({ preventScroll: true });
  }
  focusSession() {
    if (!this.root.inert)
      this.tabs.root
        .querySelector<HTMLButtonElement>('[aria-selected="true"]')
        ?.focus({ preventScroll: true });
  }
  openResource(card: number) {
    const ref = this.cards.resourceAt(card);
    if (!ref) return;
    this.setCollapsed(false);
    this.showPage(
      ref.kind === "shortcut" ? "shortcut" : ref.kind === "history"
        ? "history"
        : ref.kind === "files"
          ? "files"
          : "command",
      card,
    );
  }
  update() {
    const sessions = this.bank.visibleSessions;
    // Both readings come off one count, so the stowed tab can never disagree
    // with the sheet about how many hosts and connections are live.
    const hosts = this.cards.bound.length;
    const live = sessions.filter((s) => s.client.active).length;
    this.root.querySelector(".ssh-overview-summary")!.textContent =
      `${String(hosts).padStart(2, "0")} 台主机　/　${live} 个连接　/　${sessions.filter((s) => s.client.pendingPrompt || s.services.state?.prompt).length} 待认证　/　${sessions.flatMap((s) => s.services.state?.jobs || []).filter((job) => ["queued", "scanning", "transferring", "committing", "conflict"].includes(job.state)).length} 项传输`;
    this.restore.querySelector("small")!.textContent =
      `${String(hosts).padStart(2, "0")} 台主机 · ${String(live).padStart(2, "0")} 个连接`;
    this.tabs.update(
      sessions.map((session) => ({
        key: session.key,
        label: `${records[this.cards.resourceCard("session", session.key) ?? -1]?.id || "SSH"} / ${sessionLabel(session)}`,
        state: sessionState(session),
        unread: session.unread, alert: session.alert,
        transfers: session.services.state?.jobs.filter(job => ["queued", "scanning", "transferring", "committing", "conflict"].includes(job.state)).length || 0,
      })),
      this.bank.active.key,
      this.actions.session,
      this.actions.closeSession,
    );
    if (this.visible && this.page === "hosts") this.updateHosts();
  }
  private updateHosts() {
    const query = this.query.trim().toLocaleLowerCase();
    const hosts = this.cards.bound.filter((host) =>
      `${hostLabel(host)} ${hostSubtitle(host)} ${records[this.cards.cardOf(host.alias)!].id}`
        .toLocaleLowerCase()
        .includes(query),
    );
    const keep = new Set(hosts.map((host) => host.alias));
    for (const [alias, row] of this.rows)
      if (!keep.has(alias)) {
        row.remove();
        this.rows.delete(alias);
      }
    hosts.forEach((host, index) => {
      let row = this.rows.get(host.alias);
      if (!row) {
        row = document.createElement("article");
        row.className = "ssh-overview-host";
        row.dataset.hostAlias = host.alias;
        row.innerHTML =
          '<button type="button" class="ssh-overview-connect" data-overview-action="connect"><span class="ssh-overview-host-name"><b></b><span><strong></strong><small></small></span></span><span class="ssh-overview-host-state"></span><span class="ssh-overview-host-load"></span></button><div class="ssh-overview-host-actions"><button type="button" data-overview-action="inspect" title="查看这台主机的详情">详情</button><button type="button" data-overview-action="new" title="另开一个会话">＋</button><button type="button" data-overview-action="edit">编辑</button></div>';
        this.rows.set(host.alias, row);
      }
      const session = this.bank.forAlias(host.alias),
        state = session?.services.state;
      const live = Boolean(
        state?.sample &&
        Date.now() - state.receivedAt < 3500 &&
        session?.client.active,
      );
      const sample = live ? state!.sample! : null;
      const gpuLive =
        sample?.gpuState === "live" &&
        sample.gpuAt > 0 &&
        sample.timestamp - sample.gpuAt < 3500;
      const gpuValues = gpuLive
        ? sample.gpus.flatMap((gpu) =>
            gpu.utilization === null ? [] : [gpu.utilization],
          )
        : [];
      const load = sample
        ? `CPU ${sample.cpu?.usage?.toFixed(0) ?? "—"}% · RAM ${sample.memory?.total ? Math.round((sample.memory.used / sample.memory.total) * 100) : "—"}%${sample.gpus.length ? ` · GPU ${gpuValues.length ? Math.round(Math.max(...gpuValues)) : "—"}%` : ""}`
        : state?.sample
          ? "采样已暂停"
          : "等待连接采样";
      row.dataset.connected = String(Boolean(session?.client.active));
      row.dataset.pending = String(
        Boolean(session?.client.pendingPrompt || state?.prompt),
      );
      const values = [
        ["b", records[this.cards.cardOf(host.alias)!].id],
        ["strong", hostLabel(host)],
        ["small", hostSubtitle(host)],
        [
          ".ssh-overview-host-state",
          session ? sessionState(session) : "未连接",
        ],
        [".ssh-overview-host-load", load],
      ];
      for (const [selector, value] of values) {
        const node = row.querySelector(selector)!;
        if (node.textContent !== value) node.textContent = value;
      }
      if (this.list.children[index] !== row)
        this.list.insertBefore(row, this.list.children[index] || null);
    });
    const empty = this.root.querySelector<HTMLElement>(".ssh-overview-empty")!;
    empty.hidden = hosts.length > 0;
    empty.textContent = query
      ? "没有匹配的主机。"
      : "添加第一台主机，建立你的连接档案。";
  }
  dispose() {
    clearTimeout(this.timer);
    this.keys.unmount();
    this.transition.dispose();
    this.contentTransition.cancel();
    this.root.remove();
  }
}
