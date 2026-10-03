import "./portals.css";
import type { Sound } from "../shared/audio";
import { getPlatformBridge } from "../platform/bridge";
import { motifGlyph, motifOf } from "../features/theme/theme-design";
import { bytes, type TransferJob } from "../features/ssh/services";
import { transferStateLabels } from "../features/ssh/transfer-panel";
import { sessionLabel, sessionState } from "../features/ssh/library";
import { hostLabel, hostSubtitle } from "../features/ssh/host-cards";
import type { SshHostEntry, SavedCredential } from "../features/ssh/client";
import type { SshSessionBank, WorkspaceSession } from "../features/ssh/session-bank";

/**
 * The archive's three portals (the Unreal build's RhineExperience.cpp and
 * RhinePortalPages.cpp). A small launcher under the brand keeps them folded
 * away; opened, three cards fan out of it, and a card grows into its page.
 * The pages are working pages, not showcases:
 *
 *   01 会话中枢   every connection: enter, reconnect, its record (phases, facts,
 *                failure, the last ssh lines), export, disconnect and close;
 *                then the saved session records
 *   02 观测穹顶   one tile per connected host refreshed each second, the hosts
 *                not connected (connect from here), every transfer in one queue
 *   03 凭据保管库 what is saved for which host, bound to which endpoint and host
 *                key, what has gone stale or lost its host, cleared from here
 *
 * Text from hosts and records only ever goes in through textContent, and the
 * vault page is given metadata only: no secret ever reaches the renderer.
 */
type Deps = {
  bank: () => SshSessionBank | undefined;
  reduced: () => boolean;
  sound: (cue: Sound) => void;
  openSession: (session: WorkspaceSession) => void;
  reconnect: (session: WorkspaceSession) => void;
  /** Disconnect if live, then close the session's tab. */
  close: (session: WorkspaceSession) => void;
  /** The session's readable record, written where the person chooses. */
  exportSession: (session: WorkspaceSession) => void;
  connect: (alias: string) => void;
  openRecord: (file: string) => void;
  openOverview: () => void;
  hosts: () => readonly SshHostEntry[];
  /** Whether the archive home is showing, so the launcher may too. */
  home: () => boolean;
};

const PAGES = [
  { name: "会话中枢", code: "01  /  SESSION RECORD", subtitle: "SESSION RECORD  /  每条连接的状态、时长与流量，以及保存的会话记录" },
  { name: "观测穹顶", code: "02  /  MONITOR BOARD", subtitle: "MONITOR BOARD  /  所有在线主机的实时占用与传输" },
  { name: "凭据保管库", code: "03  /  CREDENTIAL VAULT", subtitle: "CREDENTIAL VAULT  /  本机保存的口令、私钥口令与私钥文件" },
] as const;
const ENDED = new Set<TransferJob["state"]>(["completed", "failed", "canceled", "uncertain"]);
const KINDS = { password: "登录口令", passphrase: "私钥口令" } as const;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};
const pad = (n: number) => String(n).padStart(2, "0");
const pct = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "—" : Math.round(value) + "%";
const duration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} 秒` : s < 3600 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${Math.floor(s / 3600)} 时 ${Math.floor(s / 60) % 60} 分`;
};
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${two(Math.floor(s / 60))}:${two(s % 60)}`;
};
const account = (endpoint: { host: string; port: number | string; user: string }) =>
  `${endpoint.user ? endpoint.user + "@" : ""}${endpoint.host}:${endpoint.port || 22}`;

export class SpatialPortals {
  private launcher: HTMLButtonElement;
  private drawer: HTMLElement;
  private sheet: HTMLElement;
  private body: HTMLElement;
  private notice: HTMLElement;
  private open = false;
  private page = 0;
  private timer = 0;
  private noticeTimer = 0;
  private generation = 0;
  private shown = false;
  /** The session whose record is unfolded on the first page. */
  private expanded = "";
  /** A destructive action waits for a second click on the same button. */
  private armed = "";
  private armTimer = 0;
  private busy = false;

  constructor(private stage: HTMLElement, private deps: Deps) {
    this.launcher = el("button", "portal-launcher");
    this.launcher.type = "button";
    this.launcher.title = "会话中枢 · 观测穹顶 · 凭据保管库";
    this.launcher.setAttribute("aria-expanded", "false");
    this.launcher.innerHTML = '<span class="portal-launcher-glyph"></span><strong>空间入口</strong><small>03</small><i aria-hidden="true">▾</i>';
    this.drawer = el("div", "portal-drawer");
    this.drawer.setAttribute("role", "group");
    this.drawer.setAttribute("aria-label", "空间入口");
    PAGES.forEach((page, i) => {
      const card = el("button", "portal-card");
      card.type = "button";
      card.dataset.portal = String(i + 1);
      card.style.setProperty("--i", String(i));
      card.append(el("small", "", page.code), el("span", "portal-card-mark"), el("strong", "", page.name + "   ↗"));
      this.drawer.append(card);
    });
    this.sheet = el("section", "portal-sheet");
    this.sheet.setAttribute("aria-modal", "true");
    this.sheet.setAttribute("role", "dialog");
    this.sheet.hidden = true;
    this.sheet.innerHTML = '<div class="portal-sheet-inner"><header><span>RHINE LAB     /     SPATIAL INDEX</span><button type="button" class="portal-back">← 返回档案阵列 <small>ESC</small></button></header><h2></h2><p class="portal-subtitle"></p><div class="portal-layout"><div class="portal-emblem" aria-hidden="true"></div><div class="portal-main"><p class="portal-notice" role="status" aria-live="polite"></p><div class="portal-body"></div></div></div><footer>SPATIAL INTERFACE     /     RHINE LAB ANALYSIS OS</footer></div>';
    this.body = this.sheet.querySelector(".portal-body")!;
    this.notice = this.sheet.querySelector(".portal-notice")!;
    stage.append(this.launcher, this.drawer, this.sheet);
    this.launcher.addEventListener("click", () => this.setOpen(!this.open));
    this.drawer.addEventListener("click", (e) => {
      const card = (e.target as Element).closest<HTMLElement>("[data-portal]");
      if (card) this.show(Number(card.dataset.portal), card);
    });
    this.sheet.querySelector(".portal-back")!.addEventListener("click", () => this.show(0));
    this.sheet.addEventListener("click", (e) => {
      const button = (e.target as Element).closest<HTMLButtonElement>("button[data-portal-action]");
      if (button && !button.disabled) void this.act(button);
    });
  }

  get isPageOpen() { return this.page > 0; }

  /** The label design's 04 空间入口 opens and folds the cards from the top strip. */
  toggle() { this.setOpen(!this.open); }

  /** Esc: the page first, then the drawer. */
  escape() {
    if (this.page) { this.show(0); return true; }
    if (this.open) { this.setOpen(false); return true; }
    return false;
  }

  /** Called each frame: the launcher follows the home, and hides with it. */
  sync() {
    const shown = this.deps.home() && !this.page;
    if (shown === this.shown) return;
    this.shown = shown;
    this.stage.classList.toggle("portals-available", shown);
    if (!shown && this.open) this.setOpen(false, true);
  }

  setOpen(open: boolean, quiet = false) {
    if (open === this.open) return;
    this.open = open;
    if (!quiet) this.deps.sound(open ? "page-open" : "page-close");
    this.stage.classList.toggle("portals-open", open);
    this.launcher.setAttribute("aria-expanded", String(open));
    this.launcher.querySelector("strong")!.textContent = open ? "收起入口" : "空间入口";
  }

  private show(page: number, from?: HTMLElement) {
    if (page === this.page) return;
    this.deps.sound(page ? "page-open" : "page-close");
    const generation = ++this.generation;
    window.clearInterval(this.timer);
    this.timer = 0;
    this.expanded = "";
    this.disarm();
    this.say("");
    const reduced = this.deps.reduced();
    if (!page) {
      this.page = 0;
      const card = this.drawer.querySelector<HTMLElement>(`[data-portal="${this.sheet.dataset.page}"]`);
      const done = () => { if (generation === this.generation) { this.sheet.hidden = true; this.body.replaceChildren(); } };
      if (reduced || !card) { done(); return; }
      this.sheet.animate([{ clipPath: "inset(0 0 0 0)" }, { clipPath: this.clipFor(card) }], { duration: 420, easing: "cubic-bezier(.55,0,.8,.2)", fill: "forwards" }).finished.then(done, done);
      return;
    }
    this.page = page;
    this.setOpen(false, true);
    const info = PAGES[page - 1];
    this.sheet.dataset.page = String(page);
    this.sheet.querySelector("h2")!.textContent = info.name;
    this.sheet.querySelector(".portal-subtitle")!.textContent = info.subtitle;
    this.sheet.querySelector(".portal-emblem")!.innerHTML = motifGlyph(motifOf(document.documentElement.dataset.colorPalette)) + `<b>0${page}</b>`;
    this.body.replaceChildren(el("p", "portal-empty", "正在读取…"));
    this.sheet.hidden = false;
    this.sheet.querySelector<HTMLElement>(".portal-back")!.focus({ preventScroll: true });
    // The page grows out of the card that was clicked.
    if (!reduced && from) {
      this.sheet.getAnimations().forEach(a => a.cancel());
      this.sheet.animate([{ clipPath: this.clipFor(from) }, { clipPath: "inset(0 0 0 0)" }], { duration: 640, easing: "cubic-bezier(.16,1,.3,1)" });
      this.sheet.querySelector<HTMLElement>(".portal-sheet-inner")!.animate(
        [{ opacity: 0, transform: "translateY(30px)" }, { opacity: 0, offset: .45 }, { opacity: 1, transform: "none" }],
        { duration: 760, easing: "cubic-bezier(.16,1,.3,1)" });
    }
    void this.render(page, generation, true);
    if (page !== 3) this.timer = window.setInterval(() => void this.render(page, generation), page === 2 ? 1000 : 3000);
  }

  private clipFor(node: HTMLElement) {
    const card = node.getBoundingClientRect(), box = this.sheet.getBoundingClientRect();
    const px = (v: number) => Math.max(0, v).toFixed(1) + "px";
    return `inset(${px(card.top - box.top)} ${px(box.right - card.right)} ${px(box.bottom - card.bottom)} ${px(card.left - box.left)})`;
  }

  /**
   * Rebuild the page's rows. The periodic refresh leaves a page alone while
   * text in it is selected, and gives focus back to the same control after.
   */
  private async render(page: number, generation: number, forced = false) {
    const selection = getSelection();
    if (!forced && selection && !selection.isCollapsed && this.sheet.contains(selection.anchorNode)) return;
    const nodes = page === 1 ? await this.sessions() : page === 2 ? this.board() : await this.vault();
    if (generation !== this.generation || this.page !== page) return;
    const focused = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>("[data-portal-key]")?.dataset.portalKey;
    const scroll = this.body.scrollTop;
    this.body.replaceChildren(...nodes);
    this.body.scrollTop = scroll;
    if (focused) this.body.querySelector<HTMLElement>(`[data-portal-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }
  private refresh() { void this.render(this.page, this.generation, true); }

  private say(text: string) {
    window.clearTimeout(this.noticeTimer);
    this.notice.textContent = text;
    if (text) this.noticeTimer = window.setTimeout(() => (this.notice.textContent = ""), 6000);
  }
  private disarm() {
    window.clearTimeout(this.armTimer);
    this.armed = "";
  }

  private section(title: string, count?: number) {
    const head = el("h3", "portal-section", title);
    if (count != null) head.append(el("span", "", pad(count)));
    return head;
  }

  private row(cells: string[], state?: string) {
    const row = el("div", "portal-row");
    if (state) row.dataset.state = state;
    cells.filter(Boolean).forEach((text, i) => row.append(el(i ? "span" : "strong", "", text)));
    return row;
  }

  /** A text action; `confirm` is the label of its second, committing click. */
  private action(label: string, action: string, data: Record<string, string> = {}, options: { confirm?: string; quiet?: boolean } = {}) {
    const button = el("button", "portal-action" + (options.quiet ? " portal-action-quiet" : ""));
    button.type = "button";
    button.dataset.portalAction = action;
    Object.assign(button.dataset, data);
    const key = [action, ...Object.values(data)].join(":");
    button.dataset.portalKey = key;
    if (options.confirm) button.dataset.confirm = options.confirm;
    const armed = this.armed === key;
    button.textContent = armed ? options.confirm! : label;
    if (armed) button.dataset.armed = "true";
    return button;
  }
  private actions(...buttons: HTMLElement[]) {
    const box = el("div", "portal-actions");
    box.append(...buttons);
    return box;
  }

  private session(key: string | undefined) {
    return key ? this.deps.bank()?.byKey(key) : undefined;
  }

  private async act(button: HTMLButtonElement) {
    const { portalAction: action, portalKey: key = "", confirm } = button.dataset;
    // A destructive action is armed by the first click and done by the second.
    if (confirm && this.armed !== key) {
      this.disarm();
      this.armed = key;
      this.armTimer = window.setTimeout(() => { this.armed = ""; this.refresh(); }, 4000);
      this.refresh();
      return;
    }
    this.disarm();
    const session = this.session(button.dataset.session);
    switch (action) {
      case "enter":
        if (session) { this.show(0); this.deps.openSession(session); }
        return;
      case "reconnect":
        if (session) { this.show(0); this.deps.reconnect(session); }
        return;
      case "expand":
        this.expanded = this.expanded === button.dataset.session ? "" : button.dataset.session ?? "";
        this.refresh();
        return;
      case "export":
        if (session) this.deps.exportSession(session);
        return;
      case "close":
        if (session) { this.deps.close(session); this.say(`已关闭 ${sessionLabel(session)}`); this.refresh(); }
        return;
      case "overview":
        this.show(0);
        this.deps.openOverview();
        return;
      case "connect":
        if (button.dataset.alias) { this.show(0); this.deps.connect(button.dataset.alias); }
        return;
      case "record":
        if (button.dataset.file) { this.show(0); this.deps.openRecord(button.dataset.file); }
        return;
      case "monitor": {
        const result = await session?.services.retryMonitor();
        this.say(result?.ok === false ? `监控未能重启：${result.error ?? "未知原因"}` : "已请求重新启动监控");
        return;
      }
      case "cancel":
      case "retry": {
        const files = getPlatformBridge()?.sftp, sessionId = session?.services.sessionId, id = button.dataset.job;
        if (!files || !sessionId || !id) return;
        const result = action === "cancel" ? await files.cancel({ sessionId, id }) : await files.retry({ sessionId, id });
        if (!result.ok) this.say(`${action === "cancel" ? "取消" : "重试"}失败：${result.error ?? "未知原因"}`);
        return;
      }
      case "forget": {
        if (this.busy) return;
        const credentials = getPlatformBridge()?.credentials, target = button.dataset.target;
        if (!credentials || !target) return;
        const kind = button.dataset.kind === "password" || button.dataset.kind === "passphrase" ? button.dataset.kind : undefined;
        this.busy = true;
        try {
          const result = await credentials.remove({ target, kind });
          this.say(result.ok ? `已清除 ${button.dataset.what ?? "凭据"}。` : `清除失败：${result.error ?? "未知原因"}`);
        } finally {
          this.busy = false;
        }
        this.refresh();
        return;
      }
    }
  }

  // ── 01 会话中枢 ────────────────────────────────────────────────────────────
  private async sessions() {
    const out: HTMLElement[] = [];
    const live = this.deps.bank()?.visibleSessions ?? [];
    const online = live.filter(session => session.client.active).length;
    const waiting = live.filter(session => session.client.pendingPrompt || session.services.state?.prompt).length;
    out.push(el("p", "portal-summary", `${pad(live.length)} 条连接  /  ${pad(online)} 在线  /  ${pad(waiting)} 等待认证`));
    out.push(this.section("当前连接", live.length));
    if (!live.length) out.push(el("p", "portal-empty", "目前没有连接。选择一份主机档案，建立第一条连接。"));
    for (const session of live) out.push(...this.sessionRow(session));
    const result = await getPlatformBridge()?.records?.list().catch(() => null);
    const records = result?.ok ? result.records : [];
    out.push(this.section("会话记录", records.length));
    if (!records.length) out.push(el("p", "portal-empty", result?.ok === false ? result.error || "会话记录读取失败" : "尚无保存的会话记录。"));
    for (const record of records.slice(0, 40)) {
      const row = this.row([record.targetLabel || record.target, new Date(record.startedAt).toLocaleString(), duration(record.durationMs),
        `↓ ${bytes(record.bytesIn)} · ↑ ${bytes(record.bytesOut)}`, record.outcome], record.exitCode ? "failed" : "ended");
      row.append(this.actions(this.action("查看 ↗", "record", { file: record.file })));
      out.push(row);
    }
    out.push(this.actions(this.action("打开主机总览 ↗", "overview")));
    return out;
  }

  private sessionRow(session: WorkspaceSession) {
    const client = session.client, status = client.status(), traffic = client.traffic, active = client.active;
    const waiting = Boolean(client.pendingPrompt || session.services.state?.prompt);
    const jobs = (session.services.state?.jobs ?? []).filter(job => !ENDED.has(job.state)).length;
    const time = !client.target ? "未启动" : active ? `时长 ${clock(traffic.elapsedMs)}` : "已结束";
    const row = this.row([sessionLabel(session), client.target ?? "", sessionState(session),
      `${time} · ↓ ${bytes(traffic.bytesIn)} · ↑ ${bytes(traffic.bytesOut)} · ${jobs} 项传输${waiting ? " · 等待认证" : ""}`],
      waiting ? "waiting" : status.phase === "failed" ? "failed" : active ? "live" : "ended");
    const key = { session: session.key };
    row.append(this.actions(
      this.action("进入 ↗", "enter", key),
      ...(!active && session.descriptor ? [this.action("重连", "reconnect", key)] : []),
      this.action(this.expanded === session.key ? "收起记录" : "展开记录", "expand", key),
      this.action("导出", "export", key),
      this.action(active ? "断开并关闭" : "关闭", "close", key, { confirm: active ? "确认断开" : undefined, quiet: true }),
    ));
    if (this.expanded !== session.key) return [row];
    // The record: phase timeline with durations, facts, failure, the last 40 ssh lines.
    const record = el("div", "portal-record");
    record.append(el("h4", "", "TIMELINE / 阶段"));
    for (const step of status.timeline) record.append(el("div", "portal-mono", `${step.label}  ${Math.round(step.duration)} ms`));
    const facts = Object.values(status.facts);
    if (facts.length) {
      record.append(el("h4", "", "FACTS / 连接事实"));
      for (const fact of facts) record.append(el("div", "portal-mono", `${fact.key}  ${fact.value}`));
    }
    if (status.failure) record.append(el("h4", "", "FAILURE / 失败原因"), el("p", "portal-failure", status.failure));
    const log = client.rawLog;
    record.append(el("h4", "", `SSH LOG / 最近 ${Math.min(40, log.length)} 行`), el("pre", "portal-log", log.slice(-40).join("\n")));
    return [row, record];
  }

  // ── 02 观测穹顶 ────────────────────────────────────────────────────────────
  private board() {
    const out: HTMLElement[] = [];
    const sessions = this.deps.bank()?.visibleSessions ?? [];
    const live = sessions.filter(session => session.client.active);
    const sampling = live.filter(session => session.services.state?.monitor.state === "ready").length;
    out.push(el("p", "portal-summary", `${pad(live.length)} 个连接  /  ${pad(sampling)} 台实时采样`));
    out.push(this.section("在线主机", live.length));
    if (!live.length) out.push(el("p", "portal-empty", "还没有在线的连接。连接后，主机的 CPU、内存、磁盘、网络与 GPU 会在这里实时汇总。"));
    else {
      const grid = el("div", "portal-tiles");
      for (const session of live) grid.append(this.tile(session));
      out.push(grid);
    }
    // Hosts without a live connection: connect from here.
    const watched = new Set(live.map(session => session.client.target));
    const idle = this.deps.hosts().filter(host => !watched.has(host.alias));
    if (idle.length) {
      out.push(this.section("未连接的主机", idle.length));
      for (const host of idle) {
        const row = this.row([hostLabel(host), hostSubtitle(host) || "使用 SSH 配置"], "ended");
        row.append(this.actions(this.action("连接 ↗", "connect", { alias: host.alias })));
        out.push(row);
      }
    }
    // Every session's transfers in one queue, unfinished first.
    const jobs = sessions.flatMap(session => (session.services.state?.jobs ?? []).map(job => ({ session, job })))
      .sort((a, b) => Number(ENDED.has(a.job.state)) - Number(ENDED.has(b.job.state)));
    out.push(this.section("传输队列", jobs.length));
    if (!jobs.length) out.push(el("p", "portal-empty", "没有传输任务。"));
    for (const { session, job } of jobs.slice(0, 200)) {
      const progress = job.bytesTotal > 0 ? `${bytes(job.bytesDone)} / ${bytes(job.bytesTotal)}` : "";
      const row = this.row([`${job.direction === "upload" ? "↑" : "↓"}  ${job.name}`, transferStateLabels[job.state], progress,
        job.state === "transferring" && job.rate > 0 ? `${bytes(job.rate)}/s` : "", sessionLabel(session), job.error ?? ""],
        job.state === "failed" || job.state === "uncertain" ? "failed" : ENDED.has(job.state) ? "ended" : "live");
      const data = { session: session.key, job: job.id };
      const buttons = [];
      if (!ENDED.has(job.state)) buttons.push(this.action("取消", "cancel", data, { quiet: true }));
      if ((job.state === "failed" || job.state === "canceled") && job.retryable !== false && !job.retried) buttons.push(this.action("重试", "retry", data));
      if (buttons.length) row.append(this.actions(...buttons));
      out.push(row);
    }
    return out;
  }

  private tile(session: WorkspaceSession) {
    const state = session.services.state, sample = state?.sample;
    const tile = el("div", "portal-tile");
    tile.append(el("small", "", sessionLabel(session)), el("strong", "", sample?.hostname ?? "等待采样…"));
    const monitor = state?.monitor;
    tile.append(el("p", "portal-tile-status", !state ? "等待认证后开始采样"
      : sample && (monitor?.state !== "ready" || Date.now() - state.receivedAt > 3000) ? "采样已暂停 · 显示最后一次读数"
      : monitor?.state === "ready" ? "实时采样 · 每秒更新" : monitor?.message || "等待采样"));
    const memory = sample?.memory ? sample.memory.used / sample.memory.total * 100 : null;
    const disk = sample?.disks.filter(d => d.total > 0).sort((a, b) => b.used / b.total - a.used / a.total)[0];
    const gpus = sample?.gpus ?? [];
    const gpu = gpus.length ? gpus.reduce((sum, g) => sum + (g.utilization ?? 0), 0) / gpus.length : null;
    const vramUsed = gpus.reduce((sum, g) => sum + (g.memoryUsed ?? 0), 0), vramTotal = gpus.reduce((sum, g) => sum + (g.memoryTotal ?? 0), 0);
    const metrics: [string, number | null, number, string][] = [
      ["CPU", sample?.cpu?.usage ?? null, 0, sample?.cpu ? `${sample.cpu.cores} 核 · LOAD ${sample.cpu.load[0]?.toFixed(2) ?? "—"}` : ""],
      ["内存", memory, 1, sample?.memory ? `${bytes(sample.memory.used)} / ${bytes(sample.memory.total)}` : ""],
      ["磁盘", disk ? disk.used / disk.total * 100 : null, 4, disk ? `${disk.mount} · ${bytes(disk.available)} 可用` : ""],
    ];
    if (gpus.length) metrics.push([`GPU × ${gpus.length}`, gpu, 2, gpus[0].name], ["显存", vramTotal ? vramUsed / vramTotal * 100 : null, 3, vramTotal ? `${bytes(vramUsed)} / ${bytes(vramTotal)}` : ""]);
    for (const [label, value, series, detail] of metrics) {
      const line = el("div", "portal-meter");
      line.style.setProperty("--series", `var(--theme-signal-${series})`);
      line.style.setProperty("--value", Math.max(0, Math.min(100, value ?? 0)) + "%");
      line.append(el("span", "", label), el("b", "", pct(value)), el("i"));
      if (detail) line.append(el("small", "", detail));
      tile.append(line);
    }
    if (sample) {
      const received = sample.networks.reduce((sum, n) => sum + Math.max(0, n.receive ?? 0), 0);
      const sent = sample.networks.reduce((sum, n) => sum + Math.max(0, n.send ?? 0), 0);
      tile.append(el("p", "", `NET ↓ ${bytes(received)}/s · ↑ ${bytes(sent)}/s    运行 ${Math.floor(sample.uptime / 86400)} 天 ${Math.floor(sample.uptime / 3600) % 24} 时`));
    }
    const jobs = (state?.jobs ?? []).filter(job => !ENDED.has(job.state)).length;
    tile.append(el("p", "", jobs ? `传输中 ${jobs} 项` : "无进行中的传输"));
    const key = { session: session.key };
    tile.append(this.actions(this.action("进入 ↗", "enter", key),
      ...(monitor && (monitor.state === "error" || monitor.state === "unsupported") ? [this.action("重新启动监控 ↗", "monitor", key)] : [])));
    return tile;
  }

  // ── 03 凭据保管库 ──────────────────────────────────────────────────────────
  private async vault() {
    const out: HTMLElement[] = [];
    const bridge = getPlatformBridge();
    const [hostsResult, listed, keys] = await Promise.all([
      bridge?.hosts?.().catch(() => null), bridge?.credentials?.list?.().catch(() => null), bridge?.keys?.list().catch(() => null)]);
    const hosts = hostsResult?.ok ? hostsResult.hosts : [];
    const keyNames = new Map((keys?.ok ? keys.keys : []).map(key => [key.id, key.name]));
    if (!listed?.ok) {
      out.push(el("p", "portal-empty", listed?.error || "此平台不提供凭据清单，请在各主机的连接配置里查看保存状态。"));
      return [...out, ...this.keyRows(keys?.ok ? keys.keys : [])];
    }
    const entries = listed.entries;
    const stale = entries.filter(entry => entry.invalid).length;
    out.push(el("p", "portal-summary", `${pad(entries.length)} 条凭据  /  ${pad(stale)} 条需重新保存  /  ${listed.available === false ? "系统加密不可用" : "系统加密保存，只存于本机"}`));
    const claimed = new Set<SavedCredential>();
    out.push(this.section("主机", hosts.length));
    if (!hosts.length) out.push(el("p", "portal-empty", "这里还没有主机。"));
    for (const host of hosts) {
      const own = entries.filter(entry => entry.target === host.alias);
      own.forEach(entry => claimed.add(entry));
      const head = this.row([hostLabel(host), account({ host: host.hostname, port: host.port, user: host.user })], own.some(e => e.invalid) ? "failed" : own.length ? "live" : "ended");
      if (own.length) head.append(this.actions(this.action("清除此主机全部", "forget", { target: host.alias, what: `${hostLabel(host)} 的全部凭据` }, { confirm: "确认清除全部", quiet: true })));
      const block = el("div", "portal-host");
      block.append(head);
      const profile = host.profile;
      if (profile?.keyId) block.append(el("p", "portal-mono", `私钥  ${keyNames.get(profile.keyId) ?? "密钥库中已移除的私钥"}`));
      else if (profile?.identityFile || host.identityFile) block.append(el("p", "portal-mono", `私钥文件  ${profile?.identityFile || host.identityFile}`));
      const jump = profile?.jumpHostId ? hosts.find(other => other.profile?.id === profile.jumpHostId) : undefined;
      if (profile?.jumpHostId) block.append(el("p", "portal-mono", `经由跳板  ${jump ? hostLabel(jump) : "已不在主机档案中"}（跳板的凭据保存在它自己的档案下）`));
      if (!own.length) block.append(el("p", "portal-empty", "未保存凭据：连接时在认证提示里勾选“记住”即可。"));
      for (const entry of own) block.append(this.entryRow(entry));
      out.push(block);
    }
    // Entries whose host no longer exists: nothing will ever read them.
    const orphans = entries.filter(entry => !claimed.has(entry));
    if (orphans.length) {
      out.push(this.section("无主条目：对应的主机档案已删除", orphans.length));
      for (const entry of orphans) {
        const block = el("div", "portal-host");
        block.append(el("p", "portal-mono", entry.target), this.entryRow(entry));
        out.push(block);
      }
    }
    out.push(...this.keyRows(keys?.ok ? keys.keys : []));
    out.push(el("p", "portal-note", "口令经系统加密（DPAPI）保存在本机，页面只显示保存状态与绑定，从不显示内容。"));
    return out;
  }

  private entryRow(entry: SavedCredential) {
    const fingerprint = entry.fingerprint ? `主机密钥 ${entry.fingerprint.slice(0, 22)}…` : "未绑定主机密钥";
    const row = this.row([KINDS[entry.kind], entry.endpoint ? account(entry.endpoint) : "端点未知", fingerprint, entry.key, entry.invalid ? "需重新保存" : "有效"],
      entry.invalid ? "failed" : "live");
    row.classList.add("portal-entry");
    row.append(this.actions(this.action("清除", "forget", { target: entry.target, kind: entry.kind, what: KINDS[entry.kind] }, { confirm: "确认清除", quiet: true })));
    return row;
  }

  private keyRows(entries: { name: string; type: string; fingerprint: string; protected: boolean; hosts?: string[]; missing?: boolean }[]) {
    const out: HTMLElement[] = [this.section("私钥文件", entries.length)];
    if (!entries.length) out.push(el("p", "portal-empty", "尚未登记私钥。在主机设置里可以选择或导入私钥。"));
    for (const key of entries)
      out.push(this.row([key.name, key.type, key.fingerprint, key.protected ? "有口令保护" : "无口令", key.hosts?.length ? `${key.hosts.length} 台主机` : "未绑定"],
        key.missing ? "failed" : "live"));
    return out;
  }
}
