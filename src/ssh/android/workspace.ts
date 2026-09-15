import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import "./workspace.css";
import { escapeHtml as html } from "../../html";
import { ContentTransition, SurfaceTransition } from "../../ui-transitions";
import { SurfaceScope } from "../surface";
import { AndroidSshSession, type AuthRequest, type HostKey, type SessionEvent, type SessionPhase } from "./session";
import { createCapacitorPipe, showTerminalKeyboard } from "./pipe";
import { AndroidHostStore, credentialIdentity, endpoint, normalizeProfile, type HostProfile } from "./store";
import { credentialVault } from "./vault";

type Route = "list" | "host" | "edit" | "terminal";
type Connection = {
  client: AndroidSshSession; host: HostProfile; phase: SessionPhase; detail: string;
  key?: HostKey; save?: AuthRequest; usingSaved: boolean;
};
const phaseLabels: Record<SessionPhase, string> = {
  idle: "准备连接", connecting: "正在连接", handshake: "正在握手", hostkey: "确认主机身份",
  authenticating: "正在认证", opening: "正在打开终端", interactive: "已连接", failed: "连接失败", closed: "已断开",
};
const authLabels = { password: "密码", publickey: "私钥", "keyboard-interactive": "交互式验证" };
const active = (connection?: Connection) => Boolean(connection && connection.phase !== "failed" && connection.phase !== "closed");
const address = (host: HostProfile) => `${host.user}@${host.host.includes(":") ? `[${host.host}]` : host.host}:${host.port}`;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Mobile SSH is a viewport surface; the archive underneath retains its layout
 * and selection. A collapsed terminal keeps this same xterm and native pipe. */
export class AndroidSshWorkspace {
  readonly element = document.createElement("section");
  private scope: SurfaceScope;
  private transition: SurfaceTransition;
  private contentTransition = new ContentTransition();
  private store = new AndroidHostStore();
  private route: Route = "list";
  private selected = "";
  private closing = false;
  private generation = 0;
  private connecting = false;
  private connection?: Connection;
  private cancelDecision?: () => void;
  private decisionSubmit?: (form: HTMLFormElement) => Promise<void> | void;
  private vaultAvailable = false;
  private terminal?: Terminal;
  private fitAddon = new FitAddon();
  private searchAddon = new SearchAddon();
  private resizeFrame = 0;
  private control = false;
  private inputChain: Promise<void> = Promise.resolve();
  private content: HTMLElement;
  private terminalPage: HTMLElement;
  private decision: HTMLElement;
  private resizeObserver: ResizeObserver;
  private themeObserver: MutationObserver;

  constructor(stage: HTMLElement, mount: HTMLElement, private reduced: () => boolean, private changed: (open: boolean, connected: boolean) => void, private notify: (message: string) => void) {
    const root = this.element;
    root.className = "android-ssh";
    root.hidden = true;
    root.setAttribute("role", "dialog"); root.setAttribute("aria-modal", "true"); root.setAttribute("aria-label", "SSH 主机工作区");
    root.innerHTML = `<header class="as-header"><button data-mobile-ssh="back" aria-label="返回上一级">← <span>返回</span></button><div><span>RHINE LAB / REMOTE ACCESS</span><strong data-as-title>SSH 主机</strong></div><button data-mobile-ssh="home">档案</button></header>
      <div class="as-content"></div>
      <section class="as-terminal-page" hidden aria-label="SSH 终端">
        <div class="as-terminal-status"><span data-as-status></span><button data-mobile-ssh="disconnect">结束连接</button></div>
        <div class="as-search" hidden><input type="search" aria-label="搜索终端输出" placeholder="搜索输出" autocomplete="off"><button data-mobile-ssh="search-prev" aria-label="上一个搜索结果">↑</button><button data-mobile-ssh="search-next" aria-label="下一个搜索结果">↓</button><button data-mobile-ssh="search-close" aria-label="关闭搜索">×</button></div>
        <div class="as-terminal" aria-label="终端输入与输出"></div>
        <nav class="as-keys" aria-label="终端扩展按键"><button data-mobile-ssh="keyboard">键盘</button><button data-key="escape">Esc</button><button data-key="tab">Tab</button><button data-mobile-ssh="ctrl" aria-pressed="false">Ctrl</button><button data-key="left" aria-label="左方向键">←</button><button data-key="up" aria-label="上方向键">↑</button><button data-key="down" aria-label="下方向键">↓</button><button data-key="right" aria-label="右方向键">→</button><button data-key="interrupt">^C</button></nav>
        <div class="as-tools"><button data-mobile-ssh="search">查找</button><button data-mobile-ssh="paste">粘贴文本</button><button data-mobile-ssh="copy">复制输出</button><button data-mobile-ssh="smaller" aria-label="缩小终端字号">A−</button><button data-mobile-ssh="larger" aria-label="放大终端字号">A＋</button></div>
      </section><p class="as-notice" role="status" hidden></p><div class="as-decision" hidden></div>`;
    this.content = root.querySelector(".as-content")!;
    this.terminalPage = root.querySelector(".as-terminal-page")!;
    this.decision = root.querySelector(".as-decision")!;
    mount.append(root);
    this.scope = new SurfaceScope(stage, root, mount);
    this.transition = new SurfaceTransition(root, undefined, 300, 200);
    root.addEventListener("click", this.click);
    root.addEventListener("submit", this.submit);
    root.addEventListener("keydown", event => {
      if (event.key === "Escape" && !(event.target as Element).closest(".xterm")) { event.preventDefault(); this.back(); }
      // The archive's hotkeys must never also see terminal/form input.
      event.stopPropagation();
    });
    root.addEventListener("pointerdown", event => {
      if ((event.target as Element).closest("[data-key],[data-mobile-ssh=ctrl]")) event.preventDefault();
    });
    root.addEventListener("change", event => {
      const input = event.target as HTMLInputElement;
      if (input.name === "key-file") void this.readKey(input);
    });
    root.querySelector<HTMLInputElement>(".as-search input")!.addEventListener("input", () => this.search());
    this.resizeObserver = new ResizeObserver(this.scheduleFit);
    this.resizeObserver.observe(root.querySelector(".as-terminal")!);
    window.visualViewport?.addEventListener("resize", this.viewport);
    window.visualViewport?.addEventListener("scroll", this.viewport);
    window.addEventListener("resize", this.viewport);
    this.themeObserver = new MutationObserver(() => this.paintTerminal());
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-dark-surface"] });
    void credentialVault.available().then(value => { this.vaultAvailable = value; });
  }
  get isOpen() { return this.scope.active; }
  open() {
    this.closing = false;
    this.scope.enter(); this.element.inert = false;
    this.viewport(); this.transition.show(this.reduced());
    if (!this.cancelDecision) this.show("list");
    else this.decision.querySelector<HTMLElement>("input,textarea,button")?.focus({ preventScroll: true });
    this.publish();
  }
  back(): boolean {
    if (!this.isOpen) return false;
    if (this.closing) return true;
    if (this.cancelDecision) { this.cancelDecision(); return true; }
    if (this.route === "terminal") { this.selected = this.connection?.host.id ?? ""; this.show("host"); }
    else if (this.route === "edit") this.show(this.selected ? "host" : "list");
    else if (this.route === "host") this.show("list");
    else this.close();
    return true;
  }
  private close() {
    if (this.cancelDecision) { this.cancelDecision(); }
    this.closing = true; this.terminal?.blur();
    this.transition.hide(this.reduced(), () => { this.scope.leave(); this.closing = false; this.publish(); });
  }
  private publish() { this.changed(this.isOpen, this.connection?.phase === "interactive"); }
  private show(route: Route) {
    this.dismissDecision();
    this.route = route; this.element.dataset.route = route;
    this.content.hidden = route === "terminal";
    this.terminalPage.hidden = route !== "terminal";
    this.element.querySelector<HTMLElement>(".as-notice")!.hidden = true;
    const title = this.element.querySelector<HTMLElement>("[data-as-title]")!;
    title.textContent = route === "list" ? "SSH 主机" : route === "edit" ? this.selected ? "编辑主机" : "添加主机" : (route === "terminal" ? this.connection?.host : this.store.host(this.selected))?.name ?? "主机";
    if (route === "list") this.renderList();
    else if (route === "host") this.renderHost();
    else if (route === "edit") this.renderEdit();
    else { this.ensureTerminal(); this.paintTerminal(); this.updateStatus(); this.scheduleFit(); }
    if (route !== "terminal") {
      this.terminal?.blur(); this.content.scrollTop = 0;
      this.contentTransition.reveal(this.content, this.reduced());
      this.content.querySelector<HTMLElement>("[data-heading]")?.focus({ preventScroll: true });
    }
  }
  private renderList() {
    const connection = this.connection;
    this.content.innerHTML = `<div class="as-heading"><div><span>HOST DIRECTORY</span><h2 data-heading tabindex="-1">远程主机 <small>${String(this.store.hosts.length).padStart(2, "0")}</small></h2></div><button class="as-primary" data-mobile-ssh="add" ${this.store.problem ? "disabled" : ""}>＋ 添加</button></div>
      ${connection ? `<button class="as-resume" data-mobile-ssh="terminal"><span><i class="as-dot" data-phase="${connection.phase}"></i>${html(connection.host.name)} <small>${phaseLabels[connection.phase]}</small></span><strong>${active(connection) ? "打开终端" : "查看输出"} ↗</strong></button>` : ""}
      ${this.store.problem ? `<p class="as-error">${html(this.store.problem)}</p>` : ""}
      <div class="as-host-list">${this.store.hosts.length ? this.store.hosts.map((host, index) => `<button class="as-host-row" data-host-id="${html(host.id)}"><span class="as-index">${String(index + 1).padStart(2, "0")}</span><span><strong>${html(host.name)}</strong><small>${html(address(host))}</small></span><span class="as-host-method">${authLabels[host.method]} <b>↗</b></span></button>`).join("") : `<div class="as-empty"><span>NO HOSTS SAVED</span><h3>从一台主机开始</h3><p>保存地址和登录方式，连接后在这里管理终端。</p><button class="as-primary" data-mobile-ssh="add" ${this.store.problem ? "disabled" : ""}>添加 SSH 主机 →</button></div>`}</div>
      <p class="as-footnote">收起终端或返回档案时保留连接。退出应用后需重新连接。</p>`;
  }
  private renderHost() {
    const host = this.store.host(this.selected);
    if (!host) { this.show("list"); return; }
    const connection = this.connection?.host.id === host.id ? this.connection : undefined;
    const key = this.store.key(host), busy = active(connection);
    this.content.innerHTML = `<div class="as-heading"><div><span>HOST OVERVIEW</span><h2 data-heading tabindex="-1">${html(host.name)}</h2></div><i class="as-dot" data-phase="${connection?.phase ?? "idle"}"></i></div>
      <dl class="as-facts"><div><dt>主机地址</dt><dd>${html(host.host)}</dd></div><div><dt>端口</dt><dd>${host.port}</dd></div><div><dt>登录用户</dt><dd>${html(host.user)}</dd></div><div><dt>认证方式</dt><dd>${authLabels[host.method]}</dd></div></dl>
      <section class="as-connection"><span>CONNECTION</span><h3 data-as-status>${connection ? phaseLabels[connection.phase] : "尚未连接"}</h3><p class="as-detail">${html(connection?.detail ?? "连接前将核对这台主机的身份。")}</p>
        <div class="as-actions">${connection ? '<button class="as-primary" data-mobile-ssh="terminal">打开终端 ↗</button>' : ""}${busy ? '<button data-mobile-ssh="disconnect">结束连接</button>' : `<button class="${connection ? "" : "as-primary"}" data-mobile-ssh="connect">${connection ? "重新连接" : "连接主机 →"}</button>`}</div></section>
      <details class="as-security"><summary>主机身份与保存的凭据</summary><p>${key ? "已确认主机指纹" : "首次连接时确认主机指纹"}</p>${key ? `<code>${html(key.keyType)}<br>${html(key.fingerprint)}</code>` : ""}<div class="as-actions"><button data-mobile-ssh="forget-credential" ${!key || busy ? "disabled" : ""}>清除已存凭据</button><button data-mobile-ssh="forget-key" ${!key || busy ? "disabled" : ""}>重新确认指纹</button></div></details>
      <div class="as-actions as-host-tools"><button data-mobile-ssh="edit" ${busy ? "disabled" : ""}>编辑主机</button><button data-mobile-ssh="remove" ${busy ? "disabled" : ""}>移除主机</button></div>`;
  }
  private renderEdit() {
    const host = this.store.host(this.selected);
    this.content.innerHTML = `<div class="as-heading"><div><span>CONNECTION PROFILE</span><h2 data-heading tabindex="-1">${host ? "连接配置" : "添加 SSH 主机"}</h2></div></div><form class="as-form" data-form="host">
      <label>主机名称 <input name="name" maxlength="80" value="${html(host?.name ?? "")}" placeholder="例如：实验室服务器" autocomplete="off"></label>
      <label>主机名或 IP <input name="host" required maxlength="253" value="${html(host?.host ?? "")}" placeholder="server.example.com" autocapitalize="off" spellcheck="false" autocomplete="off"></label>
      <div class="as-form-row"><label>端口 <input name="port" type="number" inputmode="numeric" required min="1" max="65535" value="${host?.port ?? 22}"></label><label>登录用户 <input name="user" required maxlength="128" value="${html(host?.user ?? "")}" placeholder="用户名" autocapitalize="off" spellcheck="false" autocomplete="off"></label></div>
      <label>认证方式 <select name="method">${Object.entries(authLabels).map(([method, label]) => `<option value="${method}" ${method === (host?.method ?? "password") ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      <p>密码与私钥在连接时输入，可选择加密保存在此手机上。验证码每次单独输入。</p><p class="as-form-error" role="alert" hidden></p>
      <div class="as-actions"><button class="as-primary" type="submit">保存主机 →</button><button type="button" data-mobile-ssh="back">取消</button></div></form>`;
  }
  private message(message: string) {
    if (!this.isOpen) { this.notify(message); return; }
    const node = this.element.querySelector<HTMLElement>(".as-notice")!;
    node.textContent = message; node.hidden = false;
  }
  private updateStatus() {
    const connection = this.connection;
    this.element.dataset.phase = connection?.phase ?? "idle";
    this.element.querySelector<HTMLElement>(".as-terminal-status [data-as-status]")!.textContent = connection ? phaseLabels[connection.phase] + (connection.phase === "closed" || connection.phase === "failed" ? ` · ${connection.detail}` : "") : "尚未连接";
    this.terminalPage.querySelector<HTMLButtonElement>('[data-mobile-ssh="disconnect"]')!.disabled = !active(connection);
    if (this.route === "host") this.renderHost();
    if (this.route === "list") this.renderList();
    this.publish();
  }
  private ask(title: string, markup: string, submit: (form: HTMLFormElement) => Promise<void> | void, cancel: () => void) {
    this.dismissDecision();
    this.decision.innerHTML = `<form class="as-decision-panel as-form" data-form="decision" role="dialog" aria-modal="true" aria-label="${html(title)}"><span>RHINE LAB / SSH</span><h2>${html(title)}</h2>${markup}<p class="as-form-error" role="alert" hidden></p></form>`;
    this.decision.hidden = false;
    this.cancelDecision = cancel; this.decisionSubmit = submit;
    this.content.inert = this.terminalPage.inert = true;
    this.element.querySelector<HTMLElement>(".as-header")!.inert = true;
    if (this.isOpen) requestAnimationFrame(() => this.decision.querySelector<HTMLElement>("input:not([type=checkbox]):not([type=file]),textarea,button")?.focus({ preventScroll: true }));
    else this.notify("SSH 连接需要确认，请从 SSH 入口继续");
  }
  private dismissDecision() {
    this.cancelDecision = undefined; this.decisionSubmit = undefined;
    this.decision.hidden = true; this.decision.replaceChildren();
    this.content.inert = this.terminalPage.inert = false;
    this.element.querySelector<HTMLElement>(".as-header")!.inert = false;
  }
  private confirm(title: string, message: string, button: string, action: () => Promise<void> | void) {
    this.ask(title, `<p>${html(message)}</p><div class="as-actions"><button class="as-primary" type="submit">${html(button)}</button><button type="button" data-mobile-ssh="cancel">取消</button></div>`, async () => { await action(); this.dismissDecision(); }, () => this.dismissDecision());
  }
  private rememberMarkup(label: string) {
    return this.vaultAvailable ? `<label class="as-remember"><input type="checkbox" name="remember">${label}，加密保存在此手机</label>` : '<p class="as-footnote">此设备当前无法安全保存凭据，仅用于本次连接。</p>';
  }
  private async connect(host: HostProfile, replace = false) {
    if (this.connecting) return;
    if (active(this.connection)) {
      if (this.connection!.host.id === host.id) { this.show("terminal"); return; }
      if (!replace) {
        this.confirm("切换连接", `将结束 ${this.connection!.host.name} 的连接，再连接 ${host.name}。`, "结束并连接", () => { this.dismissDecision(); void this.connect(host, true); }); return;
      }
    }
    this.connecting = true;
    const generation = ++this.generation;
    await this.connection?.client.stop();
    if (generation !== this.generation) { this.connecting = false; return; }
    this.ensureTerminal(); this.terminal!.reset(); this.control = false;
    this.element.querySelector('[data-mobile-ssh="ctrl"]')!.setAttribute("aria-pressed", "false");
    const client = new AndroidSshSession(createCapacitorPipe());
    const connection: Connection = { client, host: { ...host }, phase: "idle", detail: "准备 SSH 连接", key: this.store.key(host), usingSaved: false };
    this.connection = connection; this.updateStatus();
    client.on(event => { if (generation === this.generation) this.receive(connection, event); });
    try {
      let auth: AuthRequest | undefined;
      if (connection.key && this.vaultAvailable && host.method !== "keyboard-interactive") {
        auth = await credentialVault.get(credentialIdentity(host, connection.key));
        if (auth?.method !== host.method) auth = undefined;
        connection.usingSaved = Boolean(auth);
      }
      if (generation !== this.generation) return;
      if (!auth && host.method === "publickey") auth = await this.requestKey(connection);
      if (generation !== this.generation) return;
      auth ??= host.method === "keyboard-interactive" ? { method: "keyboard-interactive" } : { method: "password" };
      await client.start();
      if (generation !== this.generation) { await client.stop(); return; }
      connection.detail = "正在解析地址并连接"; this.updateStatus();
      await client.connect({ host: host.host, port: host.port, user: host.user, auth, knownHost: connection.key });
    } catch (error) {
      if (generation === this.generation) {
        connection.phase = "failed"; connection.detail = errorText(error); connection.save = undefined;
        this.dismissDecision(); this.updateStatus(); await client.stop();
      }
    } finally { if (generation === this.generation) this.connecting = false; }
  }
  private requestKey(connection: Connection): Promise<AuthRequest> {
    return new Promise((resolve, reject) => {
      this.ask("私钥登录", `<p>${html(address(connection.host))}</p><label>选择私钥文件 <input name="key-file" type="file"></label><label>或粘贴私钥 <textarea name="privateKey" rows="5" required spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea></label><label>私钥口令（如有）<input name="passphrase" type="password" autocomplete="off"></label>${this.rememberMarkup("保存此私钥及口令")}<div class="as-actions"><button class="as-primary" type="submit">连接 →</button><button type="button" data-mobile-ssh="cancel">取消</button></div>`, form => {
        const data = new FormData(form), key = String(data.get("privateKey") ?? "").trim();
        if (!key.includes("PRIVATE KEY-----") || key.length > 256 * 1024) throw new Error("请选择或粘贴有效的私钥文件（不超过 256 KiB）");
        const auth: AuthRequest = { method: "publickey", privateKey: key, passphrase: String(data.get("passphrase") ?? "") };
        if (data.has("remember")) connection.save = auth;
        this.dismissDecision(); resolve(auth);
      }, () => { this.dismissDecision(); reject(new Error("已取消连接")); });
    });
  }
  private async readKey(input: HTMLInputElement) {
    const file = input.files?.[0], panel = input.closest("form");
    if (!file || !panel) return;
    try {
      if (file.size > 256 * 1024) throw new Error("私钥文件超过 256 KiB");
      const content = await file.text();
      if (input.isConnected && panel === this.decision.querySelector("form")) panel.querySelector<HTMLTextAreaElement>('[name="privateKey"]')!.value = content;
    } catch (error) { this.formError(panel, error); }
    input.value = "";
  }
  private receive(connection: Connection, event: SessionEvent) {
    if (event.kind === "data") { this.terminal!.write(event.bytes); return; }
    if (event.kind === "phase") {
      connection.phase = event.phase; connection.detail = event.detail;
      if (event.phase === "failed" || event.phase === "closed") { connection.save = undefined; this.dismissDecision(); }
      this.updateStatus();
      if (event.phase === "interactive") {
        this.dismissDecision();
        if (this.isOpen && this.route === "host" && this.selected === connection.host.id) this.show("terminal");
        void this.saveCredential(connection);
        this.scheduleFit();
      }
    } else if (event.kind === "hostkey") {
      this.ask("确认主机身份", `<p>${html(address(connection.host))}</p><p>请核对服务器提供的指纹。确认后记住这台主机，指纹变化时会停止连接。</p><code>${html(event.keyType)}<br>${html(event.fingerprint)}</code><div class="as-actions"><button class="as-primary" type="submit">信任并继续</button><button type="button" data-mobile-ssh="cancel">取消连接</button></div>`, () => {
        connection.key = { keyType: event.keyType, fingerprint: event.fingerprint };
        this.store.trust(connection.host, connection.key);
        this.dismissDecision(); event.accept();
      }, () => { this.dismissDecision(); event.reject(); });
    } else if (event.kind === "prompt") {
      const password = event.promptKind === "password";
      this.ask(password ? "输入登录密码" : "交互式验证", `<p>${html(address(connection.host))}</p><p class="as-server-prompt">${html(event.prompt)}</p><label>${password ? "密码" : "服务器要求的回答"}<input name="answer" type="password" required maxlength="8192" autocomplete="${password ? "off" : "one-time-code"}"></label>${password ? this.rememberMarkup("保存密码") : '<p class="as-footnote">此回答仅用于本次验证，不保存。</p>'}<div class="as-actions"><button class="as-primary" type="submit">验证并连接 →</button><button type="button" data-mobile-ssh="cancel">取消连接</button></div>`, form => {
        const data = new FormData(form), value = String(data.get("answer") ?? "");
        if (password && data.has("remember")) connection.save = { method: "password", password: value };
        this.dismissDecision(); event.answer(value);
      }, () => { this.dismissDecision(); event.cancel(); });
    } else if (event.kind === "error") {
      connection.detail = event.message + (connection.usingSaved && connection.phase === "failed" ? "；可在主机身份与凭据中清除已存凭据后重试。" : "");
      this.updateStatus();
      if (connection.phase !== "failed") this.message(connection.detail);
    } else if (event.kind === "exit") {
      connection.detail = event.code === null ? event.message || "连接中断，未收到退出状态" : `远端退出码 ${event.code}${event.message ? " · " + event.message : ""}`;
      this.updateStatus();
    }
  }
  private async saveCredential(connection: Connection) {
    const auth = connection.save; connection.save = undefined;
    if (!auth || !connection.key || !this.vaultAvailable) return;
    try {
      await credentialVault.put(credentialIdentity(connection.host, connection.key), auth);
      if (this.connection === connection) this.message("登录凭据已加密保存于此手机");
    } catch (error) { this.message(errorText(error)); }
  }
  private async stop() {
    const connection = this.connection;
    ++this.generation; this.connecting = false; this.dismissDecision();
    if (connection) {
      connection.save = undefined;
      await connection.client.stop(); connection.phase = "closed"; connection.detail = "已手动结束连接";
      this.updateStatus();
    }
  }
  private ensureTerminal() {
    if (this.terminal) return;
    let fontSize = 14;
    try { fontSize = Math.min(24, Math.max(12, Number(localStorage.getItem("rhine-android-terminal-size")) || 14)); } catch {}
    const terminal = new Terminal({ fontFamily: '"Cascadia Mono", "Roboto Mono", monospace', fontSize, lineHeight: 1.18, scrollback: 6000, cursorBlink: true, allowProposedApi: false, convertEol: false, allowTransparency: false, scrollOnUserInput: true });
    this.terminal = terminal;
    terminal.loadAddon(this.fitAddon); terminal.loadAddon(this.searchAddon);
    terminal.open(this.element.querySelector(".as-terminal")!);
    terminal.onData(data => {
      if (this.control && data.length === 1 && /[a-z@\[\\\]\^_?]/i.test(data)) {
        data = data === "?" ? "\x7f" : String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31);
        this.control = false; this.element.querySelector('[data-mobile-ssh="ctrl"]')!.setAttribute("aria-pressed", "false");
      }
      this.write(data);
    });
    terminal.onResize(size => {
      const connection = this.connection;
      if (connection?.phase === "interactive") void connection.client.resize(size.cols, size.rows).catch(error => { if (this.connection === connection && active(connection)) this.message(errorText(error)); });
    });
    this.paintTerminal();
  }
  private write(data: string) {
    const connection = this.connection, generation = this.generation;
    if (connection?.phase !== "interactive") return;
    this.inputChain = this.inputChain.then(async () => {
      if (generation === this.generation && connection.phase === "interactive") await connection.client.write(data);
    }).catch(error => { if (generation === this.generation && connection.phase === "interactive") this.message(errorText(error)); });
  }
  private paintTerminal() {
    if (!this.terminal) return;
    const dark = document.documentElement.dataset.darkSurface === "true";
    this.terminal.options.theme = dark ? { background: "#172126", foreground: "#e0e3dc", cursor: "#c5a16b", selectionBackground: "#4c626a" } : { background: "#eeece6", foreground: "#202d32", cursor: "#856432", selectionBackground: "#d2c4ae" };
  }
  private viewport = () => {
    const viewport = window.visualViewport;
    this.element.style.height = `${viewport?.height ?? innerHeight}px`;
    this.element.style.top = `${viewport?.offsetTop ?? 0}px`;
    this.scheduleFit();
  };
  private scheduleFit = () => {
    cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = requestAnimationFrame(() => {
      if (!this.isOpen || this.closing || this.route !== "terminal" || !this.terminal || !this.decision.hidden) return;
      this.fitAddon.fit();
      if (this.connection?.phase === "interactive") void this.connection.client.resize(this.terminal.cols, this.terminal.rows).catch(() => {});
    });
  };
  private search(previous = false) {
    const value = this.element.querySelector<HTMLInputElement>(".as-search input")!.value;
    if (!value) { this.searchAddon.clearDecorations(); return; }
    const found = previous ? this.searchAddon.findPrevious(value) : this.searchAddon.findNext(value);
    if (!found) this.message("没有找到匹配的输出");
  }
  private async forgetCredential(host: HostProfile) {
    const key = this.store.key(host);
    if (key && this.vaultAvailable) await credentialVault.remove(credentialIdentity(host, key));
  }
  private formError(form: Element, error: unknown) {
    const node = form.querySelector<HTMLElement>(".as-form-error");
    if (node) { node.textContent = errorText(error); node.hidden = false; }
    else this.message(errorText(error));
  }
  private submit = (event: SubmitEvent) => {
    event.preventDefault(); event.stopPropagation();
    const form = event.target as HTMLFormElement;
    void (async () => {
      const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (submit?.disabled) return;
      if (submit) submit.disabled = true;
      try {
        if (form.dataset.form === "decision") await this.decisionSubmit?.(form);
        else if (form.dataset.form === "host") {
          const data = new FormData(form), previous = this.store.host(this.selected);
          const host = normalizeProfile({ id: this.selected || crypto.randomUUID(), name: String(data.get("name") ?? ""), host: String(data.get("host") ?? ""), port: Number(data.get("port")), user: String(data.get("user") ?? ""), method: String(data.get("method")) as HostProfile["method"] });
          if (previous && (endpoint(previous) !== endpoint(host) || previous.user !== host.user || previous.method !== host.method)) await this.forgetCredential(previous);
          this.store.save(host); this.selected = host.id; this.show("host");
        }
      } catch (error) { this.formError(form, error); }
      finally { if (submit?.isConnected) submit.disabled = false; }
    })();
  };
  private click = (event: MouseEvent) => {
    const target = (event.target as Element).closest<HTMLButtonElement>("button");
    if (!target || target.disabled) return;
    const action = target.dataset.mobileSsh;
    if (!action && !target.dataset.hostId && !target.dataset.key) return;
    event.stopPropagation();
    const host = this.store.host(this.selected);
    const run = async () => {
      if (target.dataset.hostId) { this.selected = target.dataset.hostId; this.show("host"); return; }
      if (target.dataset.key) {
        const keys: Record<string, string> = { escape: "\x1b", tab: "\t", left: "\x1b[D", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", interrupt: "\x03" };
        this.write(keys[target.dataset.key] ?? ""); return;
      }
      if (action === "back") this.back();
      if (action === "home") this.close();
      if (action === "cancel") this.cancelDecision?.();
      if (action === "add") { this.selected = ""; this.show("edit"); }
      if (action === "edit") this.show("edit");
      if (action === "connect" && host) await this.connect(host);
      if (action === "terminal" && this.connection) this.show("terminal");
      if (action === "disconnect" && active(this.connection)) this.confirm("结束连接", `结束 ${this.connection!.host.name} 的 SSH 连接？当前输出会保留。`, "结束连接", () => this.stop());
      if (action === "remove" && host) this.confirm("移除主机", `移除 ${host.name} 的配置和保存的凭据？`, "移除", async () => { await this.forgetCredential(host); this.store.remove(host.id); this.selected = ""; this.show("list"); });
      if (action === "forget-credential" && host) this.confirm("清除已存凭据", "下次连接需要重新输入密码或私钥。", "清除凭据", async () => { await this.forgetCredential(host); this.message("已清除保存的登录凭据"); });
      if (action === "forget-key" && host) {
        if (active(this.connection) && endpoint(this.connection!.host) === endpoint(host)) throw new Error("请先结束此主机的连接");
        this.confirm("重新确认主机指纹", "确认服务器确实更换了密钥后，再清除旧指纹。此地址的已存凭据也会清除，下次连接重新核对。", "清除并重新核对", async () => {
          for (const item of this.store.hosts.filter(item => endpoint(item) === endpoint(host))) await this.forgetCredential(item);
          this.store.forget(host); this.renderHost();
        });
      }
      if (action === "keyboard") { this.terminal?.focus(); await showTerminalKeyboard(); }
      if (action === "ctrl") { this.control = !this.control; target.setAttribute("aria-pressed", String(this.control)); }
      if (action === "search") { this.element.querySelector<HTMLElement>(".as-search")!.hidden = false; this.element.querySelector<HTMLInputElement>(".as-search input")!.focus(); this.scheduleFit(); }
      if (action === "search-prev" || action === "search-next") this.search(action === "search-prev");
      if (action === "search-close") { this.element.querySelector<HTMLElement>(".as-search")!.hidden = true; this.searchAddon.clearDecorations(); this.scheduleFit(); }
      if (action === "smaller" || action === "larger") {
        const size = Math.max(12, Math.min(24, (this.terminal!.options.fontSize ?? 14) + (action === "larger" ? 1 : -1)));
        this.terminal!.options.fontSize = size; try { localStorage.setItem("rhine-android-terminal-size", String(size)); } catch {}
        this.scheduleFit();
      }
      if (action === "paste") {
        const generation = this.generation;
        this.ask("粘贴到终端", '<p>粘贴后先检查内容，插入时不追加回车。</p><textarea name="paste" rows="6" maxlength="1048576" required aria-label="待插入终端的文本" spellcheck="false"></textarea><div class="as-actions"><button class="as-primary" type="submit">插入终端</button><button type="button" data-mobile-ssh="cancel">取消</button></div>', form => {
          if (generation !== this.generation || this.connection?.phase !== "interactive") throw new Error("连接已经改变，请重新操作");
          this.terminal!.paste(String(new FormData(form).get("paste") ?? "")); this.dismissDecision(); this.scheduleFit();
        }, () => { this.dismissDecision(); this.scheduleFit(); });
      }
      if (action === "copy") {
        const buffer = this.terminal!.buffer.active, lines: string[] = [];
        for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
        const text = this.terminal!.getSelection() || lines.join("\n").trimEnd();
        // An explicit selectable sheet works without clipboard permission and
        // never reads or overwrites the user's clipboard automatically.
        this.ask("复制终端输出", '<p>长按文本选择并复制。</p><textarea name="output" rows="9" readonly aria-label="可复制的终端输出"></textarea><div class="as-actions"><button type="submit" class="as-primary">返回终端</button></div>', () => { this.dismissDecision(); this.scheduleFit(); }, () => { this.dismissDecision(); this.scheduleFit(); });
        this.decision.querySelector<HTMLTextAreaElement>("textarea")!.value = text;
      }
    };
    void run().catch(error => this.message(errorText(error)));
  };
  dispose() {
    void this.stop(); this.resizeObserver.disconnect(); this.themeObserver.disconnect();
    window.visualViewport?.removeEventListener("resize", this.viewport); window.visualViewport?.removeEventListener("scroll", this.viewport); window.removeEventListener("resize", this.viewport);
    cancelAnimationFrame(this.resizeFrame); this.transition.dispose(); this.contentTransition.cancel(); this.scope.dispose(); this.terminal?.dispose(); this.element.remove();
  }
}
