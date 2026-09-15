import { Terminal } from "@xterm/xterm";
import { isAndroid } from "../android";
import type { MobileTerminalControls } from "./android/terminal-controls";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";
import { SurfaceTransition } from "../ui-transitions";
import { SurfaceScope } from "./surface.ts";
import type { SshClient } from "./client";
import type { SshServicesClient } from "./services";
import type { WorkspaceLayout } from "./workspace-store";
import { SshWorkspace, WORKSPACE_NAV, WORKSPACE_SIDE } from "./workspace";
import { SessionTabs } from "./session-tabs";
import { terminalAppearance } from "./terminal-appearance";
import {
  TerminalTools,
  TERMINAL_TOOLS_MARKUP,
  isTerminalToolShortcut,
} from "./terminal-tools";
import {
  TERMINAL_THEME,
  TERMINAL_DARK_THEME,
  screenViewportRect,
  type ScreenProjection,
} from "./terminal-screen";

const MARKUP = `
  <header class="ssh-terminal-bar">
    <span class="ssh-terminal-target"></span>
    <span class="ssh-terminal-phase" role="status"></span>
    ${WORKSPACE_NAV}
    <button type="button" class="ssh-terminal-audit">会话记录</button>
    <button type="button" class="ssh-terminal-reconnect" hidden>重新连接 ↻</button>
    <button type="button" class="ssh-terminal-recovery" hidden title="点击停止自动重连"></button>
    <button type="button" class="ssh-terminal-search-all" title="检索主机、档案、命令和会话 · Ctrl+Shift+K">检索 ⌕</button>
    <select class="ssh-terminal-split-select" aria-label="选择第二终端" title="在右侧打开另一个终端"><option value="">分屏…</option></select>
    <button type="button" class="ssh-terminal-teardown" title="把终端内胆拆开查看 · 就地拆解" hidden>拆解终端 ＋</button>
    <button type="button" class="ssh-terminal-settings" title="系统设置">设置 ⚙</button>
    <button type="button" class="ssh-terminal-close" title="收起终端，返回这台主机的详情 · Ctrl+Shift+E">收起 · 返回主机</button>
  </header>
  <div class="ssh-workspace-body">
    <div id="ssh-terminal-main" class="ssh-terminal-main" role="tabpanel" aria-label="终端">
      <div class="ssh-terminal-screen"></div>
      <pre class="ssh-terminal-auth" hidden aria-label="SSH 认证原始输出"></pre>
    </div>
    ${WORKSPACE_SIDE}
  </div>
  <section id="ssh-transfer-drawer" class="ssh-transfer-drawer" data-ssh-auxiliary aria-label="传输队列" hidden></section>
  <footer class="ssh-terminal-foot">
    ${TERMINAL_TOOLS_MARKUP}
    <div class="ssh-terminal-status">
      <span class="ssh-terminal-stat" data-stat="down" title="终端文本 UTF-8 下行速率">↓ 0 B/s</span>
      <span class="ssh-terminal-stat" data-stat="up" title="终端文本 UTF-8 上行速率">↑ 0 B/s</span>
      <span class="ssh-terminal-stat" data-stat="elapsed">00:00</span>
      <button type="button" class="ssh-transfer-toggle" aria-controls="ssh-transfer-drawer" aria-expanded="false" hidden>传输 / 00</button>
      <span class="ssh-terminal-stat ssh-terminal-exit" hidden></span>
      <span class="ssh-terminal-tool-feedback" role="status" hidden></span>
      <button type="button" class="ssh-terminal-shortcut" aria-controls="ssh-terminal-tools" aria-expanded="false"
        title="终端操作 · Ctrl+Shift+P；查找输出 · Ctrl+Shift+F">终端操作 <span>⌃⇧P</span></button>
    </div>
  </footer>`;

const formatRate = (n: number) =>
  !Number.isFinite(n) || n < 1
    ? "0 B/s"
    : n < 1024
      ? `${Math.round(n)} B/s`
      : n < 1048576
        ? `${(n / 1024).toFixed(1)} KiB/s`
        : `${(n / 1048576).toFixed(2)} MiB/s`;
const formatElapsed = (ms: number) => {
  const n = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
};

/** One xterm for the entire session: packed screen, operation, hidden output,
 * scrollback, ANSI apps and reconnection all share this buffer and dimensions.
 */
export class SshTerminalPanel {
  private sessionTabs = new SessionTabs();
  onSettings: () => void = () => {};
  onSearch: () => void = () => {};
  onCancelRecovery: () => void = () => {};
  onSplitSelect: (value: string) => void = () => {};
  private embedded = false;
  private splitPeer?: SshTerminalPanel;
  private splitWrapper?: HTMLElement;
  private splitSignature = "";
  private splitClose?: () => void;
  private splitDragging = false;
  /**
   * Separate the model's plates for inspection.
   *
   * The entry point is here rather than in the scene because this surface is
   * modal by construction: `SurfaceScope` marks every other viewport sibling
   * inert and swallows events outside itself, so a control drawn beside the
   * model is unreachable for exactly as long as the terminal is open — which
   * is when the deck is at operating size and worth taking apart.
   */
  onTeardown: () => void = () => {};
  private root: HTMLElement;
  private screen: HTMLElement;
  private auth: HTMLElement;
  private phaseLabel: HTMLElement;
  private stats: Record<string, HTMLElement> = {};
  private exitLabel: HTMLElement;
  private transition: SurfaceTransition;
  private term: Terminal;
  private mobileControls?: MobileTerminalControls;
  private disposed = false;
  private tools: TerminalTools;
  private workspace?: SshWorkspace;
  private fit = new FitAddon();
  private offOutput: () => void;
  private offChange: () => void;
  private statsTimer: number | null = null;
  private resizeObserver?: ResizeObserver;
  private scope: SurfaceScope;
  private open = false;
  private generation = -1;
  private reduced = false;
  private hasShell = false;
  private projectionHost: HTMLElement;
  private viewport: HTMLElement;
  private fitFrame = 0;
  dark = false;
  screenRevision = 0;

  constructor(
    private client: SshClient,
    host: HTMLElement,
    onRequestClose: () => void,
    onRequestAudit: () => void,
    onRequestReconnect: () => void = () => {},
    services?: SshServicesClient,
  ) {
    this.projectionHost = host;
    this.viewport = host.parentElement ?? host;
    this.root = document.createElement("section");
    this.root.className = "ssh-terminal";
    this.root.hidden = true;
    this.root.dataset.transition = "closed";
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-label", "SSH 会话终端");
    this.root.innerHTML = MARKUP;
    const idPrefix = "ssh-" + crypto.randomUUID() + "-";
    const ids = new Map<string, string>();
    for (const node of this.root.querySelectorAll<HTMLElement>("[id]")) { ids.set(node.id, idPrefix + node.id); node.id = idPrefix + node.id; }
    for (const node of this.root.querySelectorAll<HTMLElement>("[aria-controls],[aria-describedby],[for]")) for (const attr of ["aria-controls", "aria-describedby", "for"]) {
      const value = node.getAttribute(attr); if (value) node.setAttribute(attr, value.split(" ").map(id => ids.get(id) || id).join(" "));
    }
    this.screen = this.root.querySelector<HTMLElement>(".ssh-terminal-screen")!;
    this.auth = this.root.querySelector<HTMLElement>(".ssh-terminal-auth")!;
    this.phaseLabel = this.root.querySelector<HTMLElement>(
      ".ssh-terminal-phase",
    )!;
    this.exitLabel =
      this.root.querySelector<HTMLElement>(".ssh-terminal-exit")!;
    for (const node of this.root.querySelectorAll<HTMLElement>("[data-stat]"))
      this.stats[node.dataset.stat!] = node;
    this.tools = new TerminalTools(this.root, client, {
      visible: () => this.open && (this.workspace?.terminalVisible ?? true),
      hasShell: () => this.hasShell,
      fit: () => {
        this.screenRevision++;
        this.workspace?.layout();
        this.scheduleFit();
      },
      focus: () => this.focus(),
    });
    this.term = this.createTerminal();
    if (isAndroid) void import("./android/terminal-controls").then(({ MobileTerminalControls }) => {
      if (!this.disposed) this.mobileControls = new MobileTerminalControls(this.root, this.screen, () => this.term,
        () => this.open && !this.root.inert && this.hasShell && (this.workspace?.terminalVisible ?? true));
    });
    if (services?.available)
      this.workspace = new SshWorkspace(this.root, services, {
        fit: () => this.scheduleFit(),
        focusTerminal: () => this.focusTerminal(),
        fontSize: () => this.tools.fontSize,
        hideTerminalTools: () => this.tools.suspend(),
      });
    this.generation = client.generation;
    if (client.output) this.term.write(client.output);
    this.offOutput = client.onOutput((chunk) => this.term.write(chunk));
    this.offChange = client.onChange((status) => {
      if (this.generation !== client.generation) {
        this.generation = client.generation;
        this.hasShell = false;
        // Discard pending parser writes as well as the old visible buffer.
        this.tools.resetSession();
        this.term.dispose();
        this.screen.replaceChildren();
        this.term = this.createTerminal();
        this.screenRevision++;
        if (this.open) this.mount();
      }
      if (status.phase === "interactive") this.hasShell = true;
      if (client.displayTarget) this.setTarget(client.displayTarget);
      this.syncInput();
      if (this.open) this.render();
    });
    this.transition = new SurfaceTransition(this.root, undefined, 180, 160);
    // xterm measures pointer coordinates and glyphs in CSS pixels. Keeping it
    // outside the scaled stage avoids both enlarged text rasters and mismatched
    // selection / SGR mouse coordinates. The 3D screen still owns the framing.
    this.scope = new SurfaceScope(host, this.root, this.viewport);
    this.root
      .querySelector(".ssh-terminal-close")!
      .addEventListener("click", () => this.embedded ? this.splitClose?.() : onRequestClose());
    this.root.querySelector(".ssh-terminal-settings")!.addEventListener("click", () => this.onSettings());
    this.root.querySelector(".ssh-terminal-search-all")!.addEventListener("click", () => this.onSearch());
    this.root.querySelector(".ssh-terminal-recovery")!.addEventListener("click", () => this.onCancelRecovery());
    const splitSelect = this.root.querySelector<HTMLSelectElement>(".ssh-terminal-split-select")!;
    splitSelect.hidden = isAndroid;
    splitSelect.addEventListener("change", () => { this.onSplitSelect(splitSelect.value); splitSelect.value = ""; });
    this.root
      .querySelector(".ssh-terminal-teardown")!
      .addEventListener("click", () => this.onTeardown());
    this.root
      .querySelector(".ssh-terminal-audit")!
      .addEventListener("click", onRequestAudit);
    this.root
      .querySelector(".ssh-terminal-reconnect")!
      .addEventListener("click", onRequestReconnect);
  }

  private createTerminal() {
    const term = new Terminal({
      cols: 100,
      rows: 30,
      ...terminalAppearance.options(),
      cursorBlink: !this.reduced,
      convertEol: false,
      scrollback: 5000,
      theme: this.screenTheme,
      allowProposedApi: true,
      disableStdin: true,
    });
    this.fit = new FitAddon();
    term.loadAddon(this.fit);
    // The application chords must never also send a control character to SSH.
    term.attachCustomKeyEventHandler(
      (event) =>
        this.open &&
        !this.root.inert &&
        !isTerminalToolShortcut(event) &&
        !(event.ctrlKey && event.key === "Tab") &&
        !(
          event.ctrlKey &&
          event.shiftKey &&
          ["e", "t", "k"].includes(event.key.toLowerCase())
        ),
    );
    term.onData((data) => {
      // disableStdin and the modal scope gate keyboard input. Protocol replies
      // (cursor position, device attributes) must also work while collapsed.
      if (this.client.active && this.client.status().phase === "interactive")
        this.client.write(this.mobileControls?.input(data) ?? data);
    });
    term.onResize(({ cols, rows }) => {
      this.screenRevision++;
      if (this.client.active) this.client.resize(cols, rows);
    });
    term.onWriteParsed(() => {
      this.screenRevision++;
    });
    term.onScroll(() => {
      this.screenRevision++;
    });
    this.tools.attach(term);
    return term;
  }

  get screenTerminal() {
    return this.term;
  }
  setRecovery(message: string) {
    const button = this.root.querySelector<HTMLButtonElement>(".ssh-terminal-recovery")!;
    button.hidden = !message; button.textContent = message ? message + " · 停止" : "";
  }
  get screenTheme() {
    return this.dark ? TERMINAL_DARK_THEME : TERMINAL_THEME;
  }
  get isOpen() {
    return this.scope.active || this.embedded;
  }
  get isClosing() {
    return this.root.dataset.transition === "closing";
  }
  get isProjected() {
    return this.root.dataset.presentation === "deck";
  }
  get hasFocus() {
    return this.open && this.root.contains(document.activeElement);
  }
  get isUsable() { return this.open && !this.root.closest("[inert],[hidden]") && (this.workspace?.terminalVisible ?? true); }

  setAppearance(dark: boolean, reduced: boolean) {
    if (this.root.dataset.dark === String(dark) && reduced === this.reduced) return;
    if (dark !== this.dark) {
      this.dark = dark;
      this.term.options.theme = this.screenTheme;
      this.screenRevision++;
    }
    if (reduced !== this.reduced) {
      this.reduced = reduced;
      this.term.options.cursorBlink = !reduced;
    }
    this.root.dataset.dark = String(dark);
    this.root.classList.toggle("reduce-motion", reduced);
    this.tools.setAppearance(dark, reduced);
    this.workspace?.setReduced(reduced);
    this.splitPeer?.setAppearance(dark, reduced);
  }

  setSplitOptions(options: { value: string; label: string }[]) {
    const signature = JSON.stringify(options); if (signature === this.splitSignature) return;
    this.splitSignature = signature;
    const select = this.root.querySelector<HTMLSelectElement>(".ssh-terminal-split-select")!;
    select.replaceChildren(new Option("分屏…", ""), new Option("收起第二终端", "none"), ...options.map(option => new Option(option.label, option.value)));
  }
  setSplit(peer: SshTerminalPanel | undefined, ratio = .5, changed: (ratio: number) => void = () => {}, close: () => void = () => {}) {
    if (peer === this || isAndroid || !this.open || this.root.clientWidth < 960 || peer?.disposed) peer = undefined;
    if (peer !== this.splitPeer) {
      this.clearSplit();
      if (peer) {
        this.splitPeer = peer;
        const wrapper = this.splitWrapper = document.createElement("div"); wrapper.className = "ssh-dual-layout";
        const body = this.root.querySelector<HTMLElement>(".ssh-workspace-body")!;
        body.before(wrapper); wrapper.append(body);
        const divider = document.createElement("div"); divider.className = "ssh-dual-divider"; divider.tabIndex = 0; divider.setAttribute("role", "separator"); divider.setAttribute("aria-orientation", "vertical"); divider.setAttribute("aria-label", "调整两个终端的宽度"); divider.setAttribute("aria-valuemin", "25"); divider.setAttribute("aria-valuemax", "75");
        wrapper.append(divider, peer.root); this.root.classList.add("has-dual-terminal");
        peer.embedded = true; peer.splitClose = close; peer.open = true; peer.root.classList.add("ssh-split-secondary"); peer.root.removeAttribute("aria-modal"); peer.root.setAttribute("role", "group"); peer.root.inert = false; peer.root.hidden = false;
        peer.setCloseLabel("收起分屏"); peer.transition.show(true); peer.workspace?.setVisible(true); peer.syncInput(); peer.render(); peer.mount();
        peer.resizeObserver = new ResizeObserver(() => peer.scheduleFit()); peer.resizeObserver.observe(peer.screen);
        peer.statsTimer = window.setInterval(() => peer.render(), 250);
        peer.setAppearance(this.dark, this.reduced);
        let currentRatio = ratio;
        const move = (value: number) => { const r = currentRatio = Math.max(.25, Math.min(.75, value)); wrapper.style.setProperty("--ssh-split-ratio", r * 100 + "%"); divider.setAttribute("aria-valuenow", String(Math.round(r * 100))); this.workspace?.layout(); peer.workspace?.layout(); };
        let dragging = -1;
        divider.addEventListener("pointerdown", event => { if (event.button !== 0) return; event.preventDefault(); dragging = event.pointerId; this.splitDragging = true; divider.setPointerCapture(event.pointerId); });
        divider.addEventListener("pointermove", event => { if (dragging === event.pointerId) { const rect = wrapper.getBoundingClientRect(); move((event.clientX - rect.left) / rect.width); } });
        const finish = () => { if (dragging < 0) return; dragging = -1; this.splitDragging = false; changed(currentRatio); };
        divider.addEventListener("pointerup", finish); divider.addEventListener("lostpointercapture", finish); divider.addEventListener("pointercancel", finish);
        divider.addEventListener("keydown", event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); move(event.key === "Home" ? .25 : event.key === "End" ? .75 : Number(divider.getAttribute("aria-valuenow")) / 100 + (event.key === "ArrowLeft" ? -.05 : .05)); changed(currentRatio); } });
      }
    }
    if (this.splitWrapper && !this.splitDragging) {
      const value = Math.max(.25, Math.min(.75, ratio)) * 100 + "%";
      if (this.splitWrapper.style.getPropertyValue("--ssh-split-ratio") !== value) {
        this.splitWrapper.style.setProperty("--ssh-split-ratio", value);
        this.splitWrapper.querySelector("[role=separator]")!.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
      }
    }
  }
  private clearSplit() {
    this.splitDragging = false;
    const peer = this.splitPeer; this.splitPeer = undefined;
    if (peer) { peer.embedded = false; peer.splitClose = undefined; peer.root.classList.remove("ssh-split-secondary"); peer.root.setAttribute("role", "dialog"); peer.root.setAttribute("aria-modal", "true"); peer.park(); }
    if (this.splitWrapper) { const body = this.splitWrapper.querySelector<HTMLElement>(":scope > .ssh-workspace-body"); if (body) this.splitWrapper.before(body); this.splitWrapper.remove(); this.splitWrapper = undefined; }
    this.root.classList.remove("has-dual-terminal");
  }

  show(reduced: boolean, projection?: ScreenProjection | null) {
    if (projection) this.setProjection(projection);
    else {
      this.root.dataset.presentation = "window";
      this.root.style.removeProperty("transform");
      this.root.style.removeProperty("left");
      this.root.style.removeProperty("top");
      this.root.style.removeProperty("width");
      this.root.style.removeProperty("height");
    }
    if (this.open) {
      this.focus();
      return;
    }
    this.open = true;
    this.scope.enter();
    this.transition.show(reduced);
    this.workspace?.setVisible(true);
    this.syncInput();
    this.render();
    this.mount();
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(this.screen);
    this.statsTimer = window.setInterval(() => this.render(), 250);
  }

  setProjection(projection: ScreenProjection) {
    const bounds = screenViewportRect(
      projection,
      this.projectionHost,
      this.viewport,
    );
    if (!bounds) return false;
    // The physical display finishes the same unboxing animation, then the
    // mobile operating surface uses the full visible viewport in native pixels.
    if (isAndroid) {
      const viewport = window.visualViewport;
      bounds.left = viewport?.offsetLeft || 0; bounds.top = viewport?.offsetTop || 0;
      bounds.width = Math.round(viewport?.width || this.viewport.clientWidth);
      bounds.height = Math.round(viewport?.height || this.viewport.clientHeight);
    }
    this.root.dataset.presentation = "deck";
    // Opening is still drawn by the real model. Once usable, a flat pixel-aligned
    // surface follows its corners without resampling text through a homography.
    for (const key of ["left", "top", "width", "height"] as const) {
      const value = `${bounds[key]}px`;
      if (this.root.style[key] !== value) this.root.style[key] = value;
    }
    return true;
  }

  private mount() {
    requestAnimationFrame(() => {
      if (!this.open) return;
      if (!this.term.element) this.term.open(this.screen);
      this.fitTerminal();
      if (!this.root.inert && !this.embedded) this.focus();
    });
  }

  hide(reduced: boolean, finished?: () => void) {
    this.clearSplit();
    // Switching on Ctrl+Tab's keydown moves the real keyup to the next surface.
    // Release xterm's keyboard bookkeeping before detaching, so returning to
    // this parser also accepts IME/insertText input without another keystroke.
    this.term.textarea?.dispatchEvent(new KeyboardEvent("keyup", { key: "Control", code: "ControlLeft", keyCode: 17 }));
    this.open = false;
    this.tools.suspend();
    this.workspace?.setVisible(false);
    this.syncInput();
    this.term.blur();
    this.releaseVisible();
    this.transition.hide(reduced, () => {
      this.scope.leave();
      finished?.();
    });
  }

  /** Detached DOM retains this session's parser, scrollback and file state. */
  park() {
    this.hide(true, () => this.root.remove());
  }

  selectPage(page: "terminal" | "files" | "monitor") { this.workspace?.select(page); }
  openDirectory(path: string) { return this.workspace?.openDirectory(path); }
  get directory() { return this.workspace?.directory || ""; }
  showTransfers() { this.workspace?.showTransfers(); }
  setBookmarkHandler(handler: (path: string) => void) { this.workspace?.setBookmarkHandler(handler); }
  setLayout(saved: WorkspaceLayout | undefined, write: (layout: WorkspaceLayout) => void) { this.workspace?.setLayout(saved, write); }
  pasteCommand(text: string) {
    if (this.open && !this.root.inert && this.hasShell && this.client.active) {
      text = text.replace(/[\r\n]+$/, "");
      if (/[\r\n]/.test(text) && !this.term.modes.bracketedPasteMode) return false;
      this.selectPage("terminal");
      this.term.paste(text);
      this.focusTerminal();
      return true;
    }
    return false;
  }
  setSessionNavigation(sessions: { key: string; label: string; state: string }[], current: string,
    change: (key: string) => void, stop: () => void, close?: (key: string) => void) {
    let nav = this.root.querySelector<HTMLElement>(".ssh-session-navigation");
    if (!nav) {
      nav = document.createElement("div"); nav.className = "ssh-session-navigation";
      nav.innerHTML = '<span class="ssh-session-pending" role="status"></span>';
      nav.prepend(this.sessionTabs.root);
      this.root.querySelector(".ssh-terminal-bar")!.after(nav);
    }
    this.sessionTabs.update(sessions, current, change, close ?? (() => stop()));
    nav.hidden = sessions.length === 0;
    this.root.classList.toggle("has-session-navigation", !nav.hidden);
  }

  confirmStop(stop: () => void) {
    const nav = this.root.querySelector<HTMLElement>(".ssh-session-navigation");
    if (!nav) return;
    const pending = nav.querySelector<HTMLElement>(".ssh-session-pending")!;
    pending.replaceChildren();
    const message = document.createTextNode("有未完成传输，结束会话会取消传输。 ");
    const confirm = document.createElement("button"); confirm.textContent = "确认结束";
    const cancel = document.createElement("button"); cancel.textContent = "继续工作";
    const expected = this.client.generation;
    confirm.onclick = () => { pending.replaceChildren(); if (this.client.generation === expected) stop(); };
    cancel.onclick = () => { pending.replaceChildren(); this.focus(); };
    pending.append(message, confirm, cancel); cancel.focus();
  }

  setTarget(target: string) {
    this.root.querySelector(".ssh-terminal-target")!.textContent = target;
  }
  setCloseLabel(text: string) {
    this.root.querySelector(".ssh-terminal-close")!.textContent = text;
  }
  /** Offered only once the model has reached operating size and there is a
   *  stack on screen to take apart. */
  setTeardownAvailable(value: boolean) {
    this.root.querySelector<HTMLButtonElement>(".ssh-terminal-teardown")!.hidden = !value;
  }
  focus() {
    if (!this.open || this.root.inert) return;
    const continueWorking = this.root.querySelector<HTMLButtonElement>(".ssh-session-pending button:last-child");
    if (continueWorking) { continueWorking.focus({ preventScroll: true }); return; }
    if (this.workspace) this.workspace.focus();
    else this.focusTerminal();
  }
  private focusTerminal() {
    if (!this.open || this.root.inert) return;
    if (this.hasShell) this.term.focus();
    else
      this.root
        .querySelector<HTMLButtonElement>(".ssh-terminal-close")!
        .focus({ preventScroll: true });
  }

  private syncInput() {
    // xterm's disableStdin also disables automatic terminal protocol replies.
    // Keep those live when packed; inert and the key handler gate user input.
    this.term.options.disableStdin =
      !this.client.active || this.client.status().phase !== "interactive";
    this.screen.inert = !this.open;
  }

  private releaseVisible() {
    if (this.fitFrame) cancelAnimationFrame(this.fitFrame);
    this.fitFrame = 0;
    if (this.statsTimer !== null) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
  }

  private scheduleFit() {
    if (this.fitFrame) return;
    this.fitFrame = requestAnimationFrame(() => { this.fitFrame = 0; this.fitTerminal(); });
  }

  private fitTerminal() {
    if (
      !this.open ||
      !this.term.element ||
      this.screen.hidden ||
      (this.workspace && !this.workspace.terminalVisible) ||
      this.screen.clientWidth < 40 ||
      this.screen.clientHeight < 40
    )
      return;
    try {
      this.fit.fit();
    } catch {
      /* A pending layout is retried by ResizeObserver. */
    }
  }

  private render() {
    const status = this.client.status();
    if (status.phase === "interactive") this.hasShell = true;
    const wasHidden = this.screen.hidden;
    this.screen.hidden = !this.hasShell;
    this.auth.hidden = this.hasShell;
    if (!this.hasShell) {
      const pending = this.client.pendingPrompt?.prompt;
      this.auth.textContent =
        [...this.client.rawLog, ...(pending ? [pending] : [])].join("\n") ||
        "等待 SSH 客户端输出…";
      this.auth.scrollTop = this.auth.scrollHeight;
    }
    if (wasHidden && this.hasShell) {
      this.fitTerminal();
      if (!this.embedded) this.focus();
    }
    this.phaseLabel.textContent = status.label;
    this.phaseLabel.dataset.phase = status.phase;
    this.phaseLabel.dataset.stalled = String(status.stalled);
    const meter = this.client.meter.measurements;
    this.stats.down.textContent = `↓ ${formatRate(meter.bytesPerSecondIn)}`;
    this.stats.up.textContent = `↑ ${formatRate(meter.bytesPerSecondOut)}`;
    this.stats.elapsed.textContent = formatElapsed(
      this.client.traffic.elapsedMs,
    );
    const exit = this.client.exit;
    this.root.querySelector<HTMLButtonElement>(
      ".ssh-terminal-reconnect",
    )!.hidden = this.client.active || !this.client.target;
    this.exitLabel.hidden = !exit && !status.failure;
    this.exitLabel.textContent = exit
      ? `会话已结束 · 代码 ${exit.exitCode ?? "?"}`
      : (status.failure ?? "");
    this.tools.sync();
  }

  dispose() {
    this.clearSplit();
    this.disposed = true;
    this.mobileControls?.dispose();
    this.open = false;
    this.releaseVisible();
    this.offOutput();
    this.offChange();
    this.scope.dispose();
    this.transition.dispose();
    this.tools.dispose();
    this.workspace?.dispose();
    this.term.dispose();
    this.root.remove();
  }
}

export { PHASE_LABEL } from "./session.ts";
