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
import type { SshHostEntry } from "./client";
import { escapeHtml } from "../html";
import { MAX_HOST_GROUPS, UNGROUPED } from "./host-groups";
import "./overview.css";

type Page = "hosts" | "command" | "history" | "files" | "keys" | "editor" | "shortcut";

const COLLAPSED_KEY = "rhine-ssh-overview-collapsed";
const POSITION_KEY = "rhine-ssh-overview-position";

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
  private headers = new Map<string, HTMLElement>();
  /** `null` shows every host, `""` the ungrouped ones, otherwise a group id. */
  private groupFilter: string | null = null;
  private renaming = "";
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
  private position = { x: 0, y: 0 };
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
      <div class="ssh-overview-content"><div class="ssh-overview-hosts"><div class="ssh-overview-search"><span>⌕</span><input type="search" aria-label="搜索主机总览" placeholder="检索名称、地址、用户或档案编号" autocomplete="off"><span>悬停定位 · 单击打开</span></div><div class="ssh-overview-groups" role="group" aria-label="主机分组"></div><div class="ssh-overview-columns"><span>HOST / 主机档案</span><span>SESSION / 连接状态</span><span>LOAD / 实时占用</span></div><div class="ssh-overview-scroll"><div class="ssh-overview-host-list"></div></div><p class="ssh-overview-empty" role="status"></p></div><div class="ssh-overview-secondary" hidden></div></div>
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
    this.restorePosition();
    this.enableDragging();
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
      } else if (action === "group-create") {
        if (!this.cards.groups.atLimit && this.cards.groups.create(`分组 ${this.cards.groups.groups.length + 1}`)) {
          this.renaming = this.cards.groups.groups.at(-1)!.id;
          this.updateHosts();
        } else if (this.cards.groups.atLimit) this.actions.pageSound();
      } else if (action === "group-remove") {
        if (this.cards.groups.remove(button.dataset.groupId!)) {
          if (this.groupFilter === button.dataset.groupId) this.groupFilter = null;
          this.updateHosts();
        }
      } else if (action === "group-filter") {
        const value = button.dataset.groupId!;
        this.groupFilter = value === "" ? null : value === "__ungrouped" ? "" : value;
        this.updateHosts();
        this.actions.pageSound();
      } else if (action === "settings") this.actions.settings();
      else if (action === "search") this.actions.search();
      else if (action === "add") this.edit();
      else if (alias && action === "edit") this.edit(alias);
      else if (alias && (action === "inspect" || action === "connect")) this.actions.inspect(alias);
      else if (alias) this.actions.connect(alias, action === "new");
    });
    // A group is renamed in place: double click opens the input, Enter or blur
    // keeps the new name, Escape puts the old one back.
    const groupsRow = this.root.querySelector<HTMLElement>(".ssh-overview-groups")!;
    groupsRow.addEventListener("dblclick", (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>(
        "[data-group-name]",
      );
      if (!button?.dataset.groupId) return;
      this.renaming = button.dataset.groupId;
      this.updateHosts();
    });
    groupsRow.addEventListener("keydown", (event) => {
      if (!this.renaming) return;
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        this.commitRename();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.renaming = "";
        this.updateHosts();
      }
    });
    groupsRow.addEventListener("focusout", (event) => {
      if (this.renaming && (event.target as Element).closest(".ssh-overview-group-edit"))
        this.commitRename();
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
      requestAnimationFrame(() => this.setPosition(this.position.x, this.position.y));
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
        alert: session.alert,
        transfers: session.services.state?.jobs.filter(job => ["queued", "scanning", "transferring", "committing", "conflict"].includes(job.state)).length || 0,
      })),
      this.bank.active.key,
      this.actions.session,
      this.actions.closeSession,
    );
    if (this.visible && this.page === "hosts") this.updateHosts();
  }

  /** The overview is an instrument panel, so its heading doubles as a bounded
   * grab rail. Controls remain ordinary controls and the chosen position is
   * restored on the next launch. */
  private enableDragging() {
    const rail = this.root.querySelector<HTMLElement>(".ssh-overview-heading")!;
    rail.title = "拖动标题栏移动 · 双击归位";
    rail.addEventListener("dblclick", event => {
      if ((event.target as Element).closest("button,input,select,textarea,a")) return;
      this.setPosition(0, 0);
      try { localStorage.removeItem(POSITION_KEY); } catch { /* Memory remains usable. */ }
    });
    let pointer = -1, originX = 0, originY = 0, startX = 0, startY = 0;
    rail.addEventListener("pointerdown", event => {
      if (event.button !== 0 || (event.target as Element).closest("button,input,select,textarea,a")) return;
      pointer = event.pointerId; originX = event.clientX; originY = event.clientY;
      startX = this.position.x; startY = this.position.y;
      rail.setPointerCapture(pointer); this.glass.dataset.dragging = "true";
      event.preventDefault();
    });
    rail.addEventListener("pointermove", event => {
      if (event.pointerId !== pointer) return;
      this.setPosition(startX + event.clientX - originX, startY + event.clientY - originY);
    });
    const finish = (event: PointerEvent) => {
      if (event.pointerId !== pointer) return;
      pointer = -1; delete this.glass.dataset.dragging;
      if (rail.hasPointerCapture(event.pointerId)) rail.releasePointerCapture(event.pointerId);
      try { localStorage.setItem(POSITION_KEY, JSON.stringify(this.position)); } catch { /* Position remains usable in memory. */ }
    };
    rail.addEventListener("pointerup", finish);
    rail.addEventListener("pointercancel", finish);
    rail.addEventListener("lostpointercapture", finish);
    window.addEventListener("resize", () => this.setPosition(this.position.x, this.position.y));
  }
  private restorePosition() {
    try {
      const value = JSON.parse(localStorage.getItem(POSITION_KEY) || "null");
      if (Number.isFinite(value?.x) && Number.isFinite(value?.y)) this.position = value;
    } catch { /* Start centred when an old value cannot be read. */ }
    this.glass.style.setProperty("--overview-x", `${this.position.x}px`);
    this.glass.style.setProperty("--overview-y", `${this.position.y}px`);
    requestAnimationFrame(() => this.setPosition(this.position.x, this.position.y));
  }
  private setPosition(x: number, y: number) {
    const root = this.root.getBoundingClientRect(), panel = this.glass.getBoundingClientRect();
    if (!root.width || !panel.width) return;
    // Layout offsets ignore the stow animation. Measuring the translated rect
    // while collapsed would otherwise move the saved position on every resize.
    const baseLeft = root.left + this.glass.offsetLeft, baseTop = root.top + this.glass.offsetTop;
    const inset = 12;
    this.position.x = Math.round(Math.max(root.left + inset - baseLeft, Math.min(x, root.right - inset - baseLeft - panel.width)));
    this.position.y = Math.round(Math.max(root.top + inset - baseTop, Math.min(y, root.bottom - inset - baseTop - panel.height)));
    this.glass.style.setProperty("--overview-x", `${this.position.x}px`);
    this.glass.style.setProperty("--overview-y", `${this.position.y}px`);
  }
  /** The group chips: filter, create, rename in place, remove. */
  private renderGroups() {
    const store = this.cards.groups;
    const row = this.root.querySelector<HTMLElement>(".ssh-overview-groups")!;
    const chips = [
      `<button type="button" data-overview-action="group-filter" data-group-id="" aria-pressed="${this.groupFilter === null}">全部</button>`,
      ...store.groups.map((group) => {
        const name = escapeHtml(group.name),
          id = escapeHtml(group.id);
        return this.renaming === group.id
          ? `<span class="ssh-overview-group-edit"><input aria-label="重命名分组" value="${name}" maxlength="80" spellcheck="false"></span>`
          : `<span class="ssh-overview-group-chip"><button type="button" data-overview-action="group-filter" data-group-id="${id}" data-group-name="1" aria-pressed="${this.groupFilter === group.id}" title="双击重命名">${name}</button><button type="button" data-overview-action="group-remove" data-group-id="${id}" aria-label="删除分组" title="删除分组">×</button></span>`;
      }),
      `<button type="button" data-overview-action="group-filter" data-group-id="__ungrouped" aria-pressed="${this.groupFilter === ""}">${UNGROUPED}</button>`,
      `<button type="button" data-overview-action="group-create" ${store.atLimit ? "disabled" : ""} title="${store.atLimit ? `最多 ${MAX_HOST_GROUPS} 个分组` : "新建分组"}">＋ 新建分组</button>`,
    ];
    const markup = chips.join("");
    if (row.dataset.rendered !== markup) {
      row.dataset.rendered = markup;
      row.innerHTML = markup;
    }
    if (this.renaming) {
      const input = row.querySelector<HTMLInputElement>(".ssh-overview-group-edit input");
      if (input && document.activeElement !== input) {
        input.focus();
        input.select();
      }
    }
  }
  private commitRename() {
    if (!this.renaming) return;
    const input = this.root.querySelector<HTMLInputElement>(".ssh-overview-group-edit input");
    const id = this.renaming;
    this.renaming = "";
    if (input) this.cards.groups.rename(id, input.value);
    this.updateHosts();
  }
  private updateHosts() {
    const query = this.query.trim().toLocaleLowerCase();
    const hosts = this.cards.bound.filter((host) => {
      const groups = this.cards.groupsOf(host.alias);
      const inGroup =
        this.groupFilter === null ||
        (this.groupFilter === ""
          ? !groups.length
          : groups.includes(this.groupFilter));
      return (
        inGroup &&
        `${hostLabel(host)} ${hostSubtitle(host)} ${records[this.cards.cardOf(host.alias)!].id}`
          .toLocaleLowerCase()
          .includes(query)
      );
    });
    this.renderGroups();
    const keep = new Set(hosts.map((host) => host.alias));
    for (const [alias, row] of this.rows)
      if (!keep.has(alias)) {
        row.remove();
        this.rows.delete(alias);
      }
    // Grouped by lane. A host in several groups is listed once, under the first
    // group it belongs to, so the list stays a list of hosts rather than of
    // memberships — the archive is where one host shows up in several columns.
    const laneOrder = this.cards.laneNames;
    const claimed = new Set<string>();
    const sections: { title: string; hosts: SshHostEntry[] }[] = [];
    for (const lane of laneOrder) {
      const members = hosts.filter(
        (host) =>
          !claimed.has(host.alias) &&
          this.cards.laneNamesFor(host.alias).includes(lane),
      );
      if (!members.length) continue;
      for (const host of members) claimed.add(host.alias);
      sections.push({ title: lane, hosts: members });
    }
    const rest = hosts.filter((host) => !claimed.has(host.alias));
    if (rest.length) sections.push({ title: UNGROUPED, hosts: rest });
    const order: HTMLElement[] = [];
    for (const section of sections) {
      order.push(this.sectionHeader(section.title, section.hosts.length));
      for (const host of section.hosts) order.push(this.updateHostRow(host));
    }
    // Only re-order when it actually differs: moving a node every tick restarts
    // its transitions and drops hover.
    const current = [...this.list.children];
    if (
      current.length !== order.length ||
      order.some((node, index) => current[index] !== node)
    )
      for (const node of order) this.list.append(node);
    const titles = new Set(sections.map((section) => section.title));
    for (const [title, header] of this.headers)
      if (!titles.has(title)) {
        header.remove();
        this.headers.delete(title);
      }
    const empty = this.root.querySelector<HTMLElement>(".ssh-overview-empty")!;
    empty.hidden = hosts.length > 0;
    empty.textContent = query
      ? "没有匹配的主机。"
      : "添加第一台主机，建立你的连接档案。";
  }
  /** A group heading, reused by name so a redraw does not restart its reveal. */
  private sectionHeader(title: string, count: number) {
    let header = this.headers.get(title);
    if (!header) {
      header = document.createElement("h3");
      header.className = "ssh-overview-group";
      header.dataset.hostGroup = title;
      header.innerHTML = "<span></span><small></small>";
      this.headers.set(title, header);
    }
    const label = header.children[0] as HTMLElement,
      tally = header.children[1] as HTMLElement;
    if (label.textContent !== title) label.textContent = title;
    const size = `${String(count).padStart(2, "0")} 台`;
    if (tally.textContent !== size) tally.textContent = size;
    return header;
  }
  /** One host row, updated in place; where it sits in the list is the caller's. */
  private updateHostRow(host: SshHostEntry) {
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
      [".ssh-overview-host-state", session ? sessionState(session) : "未连接"],
      [".ssh-overview-host-load", load],
    ];
    for (const [selector, value] of values) {
      const node = row.querySelector(selector)!;
      if (node.textContent !== value) node.textContent = value;
    }
    return row;
  }
  dispose() {
    clearTimeout(this.timer);
    this.keys.unmount();
    this.transition.dispose();
    this.contentTransition.cancel();
    this.root.remove();
  }
}
