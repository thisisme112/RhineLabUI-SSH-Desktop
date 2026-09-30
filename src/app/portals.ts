import "./portals.css";
import type { Sound } from "../shared/audio";
import { motifGlyph, motifOf } from "../features/theme/theme-design";
import { bytes } from "../features/ssh/services";
import { sessionLabel, sessionState } from "../features/ssh/library";
import type { SshSessionBank, WorkspaceSession } from "../features/ssh/session-bank";

/**
 * The archive's three portals (the Unreal build's RhineExperience.cpp and
 * RhinePortalPages.cpp). A small launcher under the brand keeps them folded
 * away; opened, three cards fan out of it, and a card grows into its page:
 *
 *   01 会话中枢   every live connection and the saved session records
 *   02 观测穹顶   one tile per connected host, figures refreshed each second
 *   03 凭据保管库 what is saved in the credential vault and the key files
 *
 * Text from hosts and records only ever goes in through textContent.
 */
type Deps = {
  bank: () => SshSessionBank | undefined;
  reduced: () => boolean;
  sound: (cue: Sound) => void;
  openSession: (session: WorkspaceSession) => void;
  /** Whether the archive home is showing, so the launcher may too. */
  home: () => boolean;
};

const PAGES = [
  { name: "会话中枢", code: "01  /  SESSION RECORD", subtitle: "SESSION RECORD  /  每条连接的状态、时长与流量，以及保存的会话记录" },
  { name: "观测穹顶", code: "02  /  MONITOR BOARD", subtitle: "MONITOR BOARD  /  所有在线主机的实时占用与传输" },
  { name: "凭据保管库", code: "03  /  CREDENTIAL VAULT", subtitle: "CREDENTIAL VAULT  /  本机保存的口令、私钥口令与私钥文件" },
] as const;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};
const pct = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "—" : Math.round(value) + "%";
const duration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} 秒` : s < 3600 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${Math.floor(s / 3600)} 时 ${Math.floor(s / 60) % 60} 分`;
};

export class SpatialPortals {
  private launcher: HTMLButtonElement;
  private drawer: HTMLElement;
  private sheet: HTMLElement;
  private body: HTMLElement;
  private open = false;
  private page = 0;
  private timer = 0;
  private generation = 0;
  private shown = false;

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
    this.sheet.innerHTML = '<div class="portal-sheet-inner"><header><span>RHINE LAB     /     SPATIAL INDEX</span><button type="button" class="portal-back">← 返回档案阵列 <small>ESC</small></button></header><h2></h2><p class="portal-subtitle"></p><div class="portal-layout"><div class="portal-emblem" aria-hidden="true"></div><div class="portal-body"></div></div><footer>SPATIAL INTERFACE     /     RHINE LAB ANALYSIS OS</footer></div>';
    this.body = this.sheet.querySelector(".portal-body")!;
    stage.append(this.launcher, this.drawer, this.sheet);
    this.launcher.addEventListener("click", () => this.setOpen(!this.open));
    this.drawer.addEventListener("click", (e) => {
      const card = (e.target as Element).closest<HTMLElement>("[data-portal]");
      if (card) this.show(Number(card.dataset.portal), card);
    });
    this.sheet.querySelector(".portal-back")!.addEventListener("click", () => this.show(0));
    this.sheet.addEventListener("click", (e) => {
      const button = (e.target as Element).closest<HTMLElement>("[data-session]");
      const session = button && this.deps.bank()?.byKey(button.dataset.session!);
      if (session) { this.show(0); this.deps.openSession(session); }
    });
  }

  get isPageOpen() { return this.page > 0; }

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
    void this.render(page, generation);
    if (page !== 3) this.timer = window.setInterval(() => void this.render(page, generation), page === 2 ? 1000 : 3000);
  }

  private clipFor(node: HTMLElement) {
    const card = node.getBoundingClientRect(), box = this.sheet.getBoundingClientRect();
    const px = (v: number) => Math.max(0, v).toFixed(1) + "px";
    return `inset(${px(card.top - box.top)} ${px(box.right - card.right)} ${px(box.bottom - card.bottom)} ${px(card.left - box.left)})`;
  }

  private async render(page: number, generation: number) {
    const nodes = page === 1 ? await this.sessions() : page === 2 ? this.board() : await this.vault();
    if (generation !== this.generation || this.page !== page) return;
    const scroll = this.body.scrollTop;
    this.body.replaceChildren(...nodes);
    this.body.scrollTop = scroll;
  }

  private section(title: string, count?: number) {
    const head = el("h3", "portal-section", title);
    if (count != null) head.append(el("span", "", String(count).padStart(2, "0")));
    return head;
  }

  private row(cells: string[], state?: string) {
    const row = el("div", "portal-row");
    if (state) row.dataset.state = state;
    cells.forEach((text, i) => row.append(el(i ? "span" : "strong", "", text)));
    return row;
  }

  private async sessions() {
    const out: HTMLElement[] = [];
    const live = this.deps.bank()?.visibleSessions ?? [];
    out.push(this.section("当前连接", live.length));
    if (!live.length) out.push(el("p", "portal-empty", "目前没有连接。选择一份主机档案，建立第一条连接。"));
    for (const session of live) {
      const state = session.services.state;
      const row = this.row([sessionLabel(session), sessionState(session),
        state?.sample ? state.sample.hostname : "—",
        `传输 ${state?.jobs.length ?? 0}`], session.client.active ? "live" : "ended");
      const open = el("button", "portal-action", "打开终端 ↗");
      open.type = "button";
      open.dataset.session = session.key;
      row.append(open);
      out.push(row);
    }
    const result = await window.rhineDesktop?.records?.list().catch(() => null);
    const records = result?.ok ? result.records : [];
    out.push(this.section("会话记录", records.length));
    if (!records.length) out.push(el("p", "portal-empty", result?.ok === false ? result.error || "会话记录读取失败" : "尚无保存的会话记录。"));
    for (const record of records.slice(0, 40))
      out.push(this.row([record.targetLabel || record.target, new Date(record.startedAt).toLocaleString(), duration(record.durationMs),
        `↓ ${bytes(record.bytesIn)} · ↑ ${bytes(record.bytesOut)}`, record.outcome], record.exitCode ? "failed" : "ended"));
    return out;
  }

  private board() {
    const out: HTMLElement[] = [];
    const live = (this.deps.bank()?.visibleSessions ?? []).filter(session => session.client.active);
    out.push(this.section("在线主机", live.length));
    if (!live.length) { out.push(el("p", "portal-empty", "没有在线主机。连接后，这里会为每台主机显示一块实时看板。")); return out; }
    const grid = el("div", "portal-tiles");
    for (const session of live) {
      const state = session.services.state, sample = state?.sample;
      const tile = el("button", "portal-tile");
      tile.type = "button";
      tile.dataset.session = session.key;
      tile.append(el("small", "", sessionLabel(session)), el("strong", "", sample?.hostname ?? "等待采样…"));
      const memory = sample?.memory ? sample.memory.used / sample.memory.total * 100 : null;
      const gpus = sample?.gpus ?? [];
      const gpu = gpus.length ? gpus.reduce((sum, g) => sum + (g.utilization ?? 0), 0) / gpus.length : null;
      const vramUsed = gpus.reduce((sum, g) => sum + (g.memoryUsed ?? 0), 0), vramTotal = gpus.reduce((sum, g) => sum + (g.memoryTotal ?? 0), 0);
      const vram = vramTotal ? vramUsed / vramTotal * 100 : null;
      const metrics: [string, number | null, number][] = [["CPU", sample?.cpu?.usage ?? null, 0], ["内存", memory, 1]];
      if (gpus.length) metrics.push([`GPU × ${gpus.length}`, gpu, 2], ["显存", vram, 3]);
      for (const [label, value, series] of metrics) {
        const line = el("div", "portal-meter");
        line.style.setProperty("--series", `var(--theme-signal-${series})`);
        line.style.setProperty("--value", Math.max(0, Math.min(100, value ?? 0)) + "%");
        line.append(el("span", "", label), el("b", "", pct(value)), el("i"));
        tile.append(line);
      }
      const jobs = state?.jobs ?? [];
      tile.append(el("p", "", jobs.length ? `传输队列 ${jobs.length} 项` : "无传输任务"));
      grid.append(tile);
    }
    out.push(grid);
    return out;
  }

  private async vault() {
    const out: HTMLElement[] = [];
    const desktop = window.rhineDesktop;
    const hosts = await desktop?.hosts?.().catch(() => null);
    const list = hosts?.ok ? hosts.hosts : [];
    const states = await Promise.all(list.map(host => desktop?.credentials?.status(host.alias).catch(() => null)));
    const saved = list.map((host, i) => ({ host, state: states[i]?.state }))
      .filter(({ state }) => state && (state.password !== "none" || state.passphrase !== "none"));
    const label = (value: string) => value === "saved" ? "已保存" : value === "needs-update" ? "需要更新" : "—";
    out.push(this.section("已保存的凭据", saved.length));
    if (!saved.length) out.push(el("p", "portal-empty", states.some(s => s?.state?.available === false) ? "系统凭据保管不可用。" : "尚未在本机保存任何口令。"));
    for (const { host, state } of saved)
      out.push(this.row([host.displayName || host.alias, `${host.user ? host.user + "@" : ""}${host.hostname}:${host.port || "22"}`,
        `口令 ${label(state!.password)}`, `私钥口令 ${label(state!.passphrase)}`],
        state!.password === "needs-update" || state!.passphrase === "needs-update" ? "failed" : "live"));
    const keys = await desktop?.keys?.list().catch(() => null);
    const entries = keys?.ok ? keys.keys : [];
    out.push(this.section("私钥文件", entries.length));
    if (!entries.length) out.push(el("p", "portal-empty", "尚未登记私钥。在主机设置里可以选择或导入私钥。"));
    for (const key of entries)
      out.push(this.row([key.name, key.type, key.fingerprint, key.protected ? "有口令保护" : "无口令", key.hosts?.length ? `${key.hosts.length} 台主机` : "未绑定"],
        key.missing ? "failed" : "live"));
    out.push(el("p", "portal-note", "口令经系统加密（DPAPI）保存在本机，页面只显示保存状态，从不显示内容。"));
    return out;
  }
}
