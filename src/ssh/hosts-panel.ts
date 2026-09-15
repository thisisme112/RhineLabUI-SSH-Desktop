import { escapeHtml } from "../html";
import { hostLabel, hostSubtitle } from "./host-cards";
import { SshPageMotion } from "./page-motion";
import type { SshHostEntry, SshHostProfile, SshHostProfilesBridge, SshHostsResult, SshLaunchDescriptor } from "./client";
import "./hosts-panel.css";

type Page = "list" | "connect" | "config";
type Options = {
  profiles?: SshHostProfilesBridge;
  loaded(result: SshHostsResult): Promise<void>;
  activeTarget(): string | null;
  reduced(): boolean;
  openHost(alias: string): void;
  saved(alias: string, connect: boolean): void;
  removed(): void;
  back(): void;
  cardId(alias: string): string;
};
const optionNames = ["user", "port", "identityFile", "authMode", "keyId", "jumpHost", "connectTimeout", "keepAliveInterval", "keepAliveCountMax"] as const;
const numeric = new Set<string>(["port", "connectTimeout", "keepAliveInterval", "keepAliveCountMax"]);

/** A page inside the selected archive, sharing its tabs, scrolling and focus. */
export class SshHostsPanel {
  private root: HTMLElement;
  private list: HTMLElement;
  private note: HTMLElement;
  private search: HTMLInputElement;
  private form: HTMLFormElement;
  private browser: HTMLElement;
  private message: HTMLElement;
  private motion = new SshPageMotion();
  private hosts: SshHostEntry[] = [];
  private revision = "";
  private editRevision = "";
  private editing: string | undefined;
  private editorMode: "quick" | "saved" = "saved";
  private source = "all";
  private route = "";
  private page: Page = "list";
  private busy = false;
  private deleteArmed = false;
  private request = 0;
  private editorGeneration = 0;
  private credentialTarget = "";
  private drafts = new Map<string, { values: SshHostProfile; revision: string }>();

  constructor(
    private loader: () => Promise<SshHostsResult>,
    private onConnect: (target: string | SshLaunchDescriptor) => void,
    private options: Options,
  ) {
    this.root = document.createElement("div");
    this.root.className = "ssh-hosts";
    this.root.innerHTML = `
      <div class="ssh-hosts-browser">
        <div class="search-field" data-ssh-reveal><span>⌕</span><input type="search" aria-label="搜索主机" placeholder="检索名称、地址或用户" autocomplete="off"><small class="ssh-hosts-count"></small></div>
        <div class="category-filters" role="group" aria-label="主机来源" data-ssh-reveal><button type="button" data-source="all" class="active" aria-pressed="true">全部主机</button><button type="button" data-source="saved" aria-pressed="false">已保存</button><button type="button" data-source="config" aria-pressed="false">SSH config</button></div>
        <ul class="ssh-hosts-list" data-ssh-reveal></ul>
        <p class="ssh-hosts-note" role="status"></p>
      </div>
      <form class="ssh-host-editor" hidden autocomplete="off">
        <div class="ssh-host-editor-head" data-ssh-reveal><span class="panel-label">CONNECTION / 连接配置</span><button type="button" class="export-button" data-action="back">返回档案 ↗</button></div>
        <div class="category-filters ssh-host-mode" role="group" aria-label="连接方式" data-ssh-reveal><button type="button" data-mode="saved" class="active" aria-pressed="true">保存主机</button><button type="button" data-mode="quick" aria-pressed="false">临时连接</button></div>
        <p class="ssh-host-config-note" hidden data-ssh-reveal>来自 SSH config；保存后新建主机档案，并继续继承该别名的配置。</p>
        <fieldset class="ssh-host-fields">
          <label class="ssh-host-wide" data-ssh-reveal><span class="ssh-host-name-label">NAME / 名称</span><input name="name" maxlength="80" required placeholder="例如：开发服务器"></label>
          <label data-ssh-reveal>HOST / 主机地址<input name="hostname" required maxlength="1024" placeholder="主机名、IP 或配置别名" spellcheck="false"></label>
          <label data-ssh-reveal>USER / 用户名<input name="user" maxlength="128" placeholder="使用 SSH 配置" spellcheck="false"></label>
          <label data-ssh-reveal>PORT / 端口<input name="port" type="number" min="1" max="65535" step="1" placeholder="22"></label>
          <label data-ssh-reveal>AUTHENTICATION / 登录方式<select name="authMode"><option value="password">密码登录</option><option value="key">指定私钥</option><option value="auto">跟随系统 SSH 配置</option></select></label>
          <label class="ssh-host-wide" data-key-choice data-ssh-reveal>IDENTITY / 登录密钥<span class="ssh-host-key"><select name="keyId"><option value="">使用下方已有私钥路径</option></select><button type="button" class="export-button" data-action="identity">选择本机私钥 ↗</button></span></label>
          <div class="ssh-host-wide ssh-host-credential" data-ssh-reveal><p class="ssh-credential-state" role="status"></p><label class="ssh-remember"><input type="checkbox" name="rememberCredential">保存或更新<span data-credential-label>登录密码</span></label><input name="credential" type="password" autocomplete="new-password" placeholder="留空保留已保存的凭据" maxlength="16384" hidden><small>由当前 Windows 账户加密，下次连接自动使用。</small><button type="button" class="export-button" data-action="forget-credential" hidden>删除已保存凭据</button></div>
          <details class="ssh-host-wide" data-ssh-reveal><summary>连接选项 <span>跳板机 · 超时 · 保活</span></summary><div class="ssh-host-fields ssh-host-advanced">
            <label class="ssh-host-wide">IDENTITY FILE / 已有私钥路径<input name="identityFile" placeholder="已有配置可继续使用；密钥库选择优先" spellcheck="false"></label>
            <label class="ssh-host-wide">JUMP HOST / 跳板机<input name="jumpHost" placeholder="user@bastion:22，或配置别名" spellcheck="false"></label>
            <label>连接超时（秒）<input name="connectTimeout" type="number" min="1" max="600" step="1" placeholder="使用 SSH 配置"></label>
            <label>保活间隔（秒，0 为关闭）<input name="keepAliveInterval" type="number" min="0" max="3600" step="1" placeholder="使用 SSH 配置"></label>
            <label>保活重试次数<input name="keepAliveCountMax" type="number" min="1" max="30" step="1" placeholder="使用 SSH 配置"></label>
          </div></details>
        </fieldset>
        <p class="ssh-host-editor-note" data-ssh-reveal>可选择本机私钥，或从总览的密钥库粘贴导入。验证码在每次连接时单独输入。</p>
        <p class="ssh-host-editor-message" role="status" aria-live="polite"></p>
        <button type="button" class="export-button ssh-host-reload" data-action="reload-editor" hidden>重新读取配置（放弃此草稿） ↻</button>
        <div class="detail-actions ssh-host-editor-actions" data-ssh-reveal><button type="submit" class="solid-button" data-intent="save">SAVE HOST<span>保存主机</span></button><button type="button" class="export-button" data-intent="save-connect">保存并连接 ↗</button><button type="button" class="solid-button" data-intent="connect" hidden>CONNECT<span>建立临时连接 →</span></button></div>
        <button type="button" class="export-button ssh-host-remove" data-action="remove" hidden>移除此主机 −</button>
      </form>`;
    this.list = this.root.querySelector(".ssh-hosts-list")!;
    this.note = this.root.querySelector(".ssh-hosts-note")!;
    this.search = this.root.querySelector("input[type=search]")!;
    this.form = this.root.querySelector("form")!;
    this.browser = this.root.querySelector(".ssh-hosts-browser")!;
    this.message = this.root.querySelector(".ssh-host-editor-message")!;
    if (import.meta.env.MODE === "android") {
      this.field("user").required = true; this.field("user").placeholder = "远端登录用户名";
      this.root.querySelector('option[value="auto"]')!.textContent = "交互式验证 / OTP";
      this.root.querySelector(".ssh-host-credential > small")!.textContent = "由 Android 安全密钥库加密，下次连接自动使用。";
      this.root.querySelector('[data-source="config"]')!.remove();
      this.field("identityFile").closest("label")!.hidden = true;
      this.field("jumpHost").placeholder = "选择已保存的跳板机，留空直连";
      this.field("jumpHost").setAttribute("list", "ssh-jump-hosts");
      const jumpList = document.createElement("datalist"); jumpList.id = "ssh-jump-hosts"; this.root.append(jumpList);
      this.root.querySelector(".ssh-host-advanced")!.closest("details")!.querySelector("summary")!.textContent = "跳板机、超时与保活";
      this.root.querySelector(".ssh-host-editor-note")!.textContent = "导入手机中的私钥后可供多个主机使用。验证码每次单独输入。";
    }
    this.search.addEventListener("input", () => this.renderList());
    this.form.addEventListener("submit", event => {
      event.preventDefault();
      void this.submit((event.submitter as HTMLButtonElement | null)?.dataset.intent ?? (this.editorMode === "quick" ? "connect" : "save"));
    });
    this.form.addEventListener("input", () => { this.deleteArmed = false; this.message.textContent = ""; });
    this.form.addEventListener("change", event => {
      const name = (event.target as HTMLInputElement).name;
      if (name === "authMode") { this.field("credential").value = ""; this.syncAuthentication(); void this.refreshCredentials(); }
      if (name === "rememberCredential") this.field("credential").hidden = !this.field("rememberCredential").checked;
    });
    this.root.addEventListener("click", event => {
      const button = (event.target as Element).closest<HTMLButtonElement>("button");
      if (!button || button.disabled) return;
      event.stopPropagation();
      if (button.dataset.source) {
        this.source = button.dataset.source;
        this.root.querySelectorAll<HTMLButtonElement>("[data-source]").forEach(node => {
          const active = node.dataset.source === this.source;
          node.classList.toggle("active", active); node.setAttribute("aria-pressed", String(active));
        });
        this.renderList(); this.motion.reveal(this.list, this.options.reduced());
      } else if (button.dataset.mode) {
        this.editorMode = button.dataset.mode === "quick" ? "quick" : "saved";
        this.syncMode();
        this.motion.reveal(this.form.querySelector(".ssh-host-editor-actions")!, this.options.reduced());
      } else if (button.dataset.alias) this.options.openHost(button.dataset.alias);
      else if (button.dataset.action === "back") this.options.back();
      else if (button.dataset.action === "identity") void this.pickIdentity();
      else if (button.dataset.action === "forget-credential") void this.forgetCredential();
      else if (button.dataset.action === "remove") void this.remove();
      else if (button.dataset.action === "reload-editor") void this.reloadEditor();
      else if (button.dataset.intent && button.type !== "submit") void this.submit(button.dataset.intent);
    });
    // Text editing, arrows and Enter belong to the page. Escape returns to
    // its archive tab; Tab continues through the existing detail navigation.
    this.root.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); this.options.back(); }
      if (!(event.ctrlKey && event.shiftKey)) event.stopPropagation();
    });
    this.form.querySelector("details")!.addEventListener("toggle", event => {
      if ((event.target as HTMLDetailsElement).open)
        this.motion.reveal(this.form.querySelector(".ssh-host-advanced")!, this.options.reduced());
    });
  }

  get isOpen() { return this.root.isConnected; }
  get items(): readonly SshHostEntry[] { return this.hosts; }
  get isEditing() { return this.isOpen && !this.form.hidden; }
  private field(name: string) { return this.form.elements.namedItem(name) as HTMLInputElement; }

  mount(container: HTMLElement, page: Page, host?: SshHostEntry) {
    const route = `${page}:${host?.alias ?? ""}`;
    if (route !== this.route) { this.rememberDraft(); this.editorGeneration++; }
    const changed = route !== this.route;
    this.page = page;
    this.route = route;
    this.browser.hidden = page !== "list";
    this.form.hidden = page === "list";
    if (page !== "list" && changed) {
      if (page === "config") this.editorMode = "saved";
      const draft = this.drafts.get(route);
      const values: SshHostProfile = draft?.values ?? host?.profile ?? (host
        ? { name: `${hostLabel(host)} 副本`, hostname: host.alias }
        : { name: "", hostname: "", authMode: "password", port: 22, connectTimeout: 10, keepAliveInterval: 30, keepAliveCountMax: 3 });
      this.editing = values.id;
      this.editRevision = draft?.revision ?? this.revision;
      this.deleteArmed = false;
      this.form.reset();
      for (const name of ["name", "hostname", ...optionNames] as const)
        this.field(name).value = values[name] === undefined ? "" : String(values[name]);
      this.field("authMode").value = values.authMode || "auto";
      this.credentialTarget = host?.alias || "";
      this.syncAuthentication();
      void this.refreshKeys(values.keyId);
      this.form.querySelector<HTMLElement>(".ssh-host-mode")!.hidden = page === "config";
      this.form.querySelector<HTMLElement>(".ssh-host-config-note")!.hidden = !host || Boolean(host.profile);
      this.form.querySelector<HTMLButtonElement>("[data-action=remove]")!.hidden = !this.editing;
      this.message.textContent = "";
      this.form.querySelector<HTMLButtonElement>("[data-action=reload-editor]")!.hidden = true;
      this.syncMode();
    }
    if (page === "list") this.renderList();
    container.append(this.root);
    if (page !== "list") { this.syncAuthentication(); void this.refreshCredentials(); if (!changed) void this.refreshKeys(); }
    this.motion.reveal(this.root, this.options.reduced());
  }

  private rememberDraft() {
    if (this.route && !this.form.hidden)
      this.drafts.set(this.route, { values: this.values(false), revision: this.editRevision });
  }
  unmount() { this.rememberDraft(); this.editorGeneration++; this.field("credential").value = ""; this.field("rememberCredential").checked = false; this.motion.cancel(); this.root.remove(); }
  finishMotion() { this.motion.finish(); }

  async refresh() {
    const request = ++this.request;
    let result: SshHostsResult;
    try { result = await this.loader(); }
    catch (error) { result = { ok: false, hosts: [], error: String(error) }; }
    if (request !== this.request) return result;
    if (result.ok) {
      this.hosts = result.hosts ?? [];
      const jumps = this.root.querySelector("#ssh-jump-hosts");
      if (jumps) jumps.replaceChildren(...this.hosts.map(host => new Option(hostLabel(host), host.alias)));
      this.revision = result.revision ?? "";
      await this.options.loaded(result);
    }
    this.note.textContent = result.ok ? "" : result.error ?? "无法读取主机档案";
    this.renderList();
    return result;
  }

  private renderList() {
    const query = this.search.value.trim().toLocaleLowerCase();
    const filtered = this.hosts.filter(entry =>
      (this.source === "all" || (entry.source ?? "config") === this.source) &&
      [hostLabel(entry), entry.hostname, entry.user].join(" ").toLocaleLowerCase().includes(query));
    this.root.querySelector(".ssh-hosts-count")!.textContent = String(filtered.length).padStart(2, "0");
    this.list.innerHTML = filtered.length ? filtered.map(entry => `
      <li><button type="button" class="result-row ssh-hosts-row" data-alias="${escapeHtml(entry.alias)}"><span class="result-name"><b>${escapeHtml(this.options.cardId(entry.alias))}</b><span>${escapeHtml(hostLabel(entry))}<small>${escapeHtml(hostSubtitle(entry) || "使用 SSH 配置")}</small></span></span><span class="ssh-hosts-source">${entry.source === "saved" ? "已保存" : "SSH config"}</span><span aria-hidden="true">↗</span></button></li>`).join("")
      : `<li class="ssh-hosts-empty">${this.hosts.length ? "没有匹配的主机" : "这里还没有主机。选择“建立连接”添加第一份主机档案。"}</li>`;
  }

  private syncMode() {
    const quick = this.editorMode === "quick";
    this.form.querySelector<HTMLElement>(".ssh-host-credential")!.hidden = quick;
    this.field("name").required = !quick;
    this.form.querySelector(".ssh-host-name-label")!.textContent = quick ? "NAME / 名称（可选）" : "NAME / 名称";
    this.root.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach(button => {
      const active = button.dataset.mode === this.editorMode;
      button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active));
    });
    for (const button of this.form.querySelectorAll<HTMLButtonElement>("[data-intent]")) {
      const intent = button.dataset.intent;
      button.hidden = intent === "connect" ? !quick : quick;
      button.type = intent === (quick ? "connect" : "save") ? "submit" : "button";
    }
    this.setBusy(this.busy);
  }
  private values(fallbackName = true): SshHostProfile {
    const options: Record<string, string | number> = {};
    for (const key of optionNames) {
      const value = this.field(key).value.trim();
      if (value !== "") options[key] = numeric.has(key) ? Number(value) : value;
    }
    return { ...(this.editing ? { id: this.editing } : {}), name: this.field("name").value.trim() || (fallbackName ? this.field("hostname").value.trim() : ""), hostname: this.field("hostname").value.trim(), ...options };
  }
  private setBusy(value: boolean) {
    this.busy = value;
    this.form.querySelector<HTMLFieldSetElement>("fieldset")!.disabled = value;
    for (const button of this.form.querySelectorAll<HTMLButtonElement>("button")) button.disabled = value || button.hidden;
    if (!this.options.profiles)
      this.form.querySelectorAll<HTMLButtonElement>("[data-intent^=save],[data-action=identity]").forEach(button => button.disabled = true);
  }
  private async submit(intent: string) {
    if (this.busy || !this.form.reportValidity()) return;
    const values = this.values();
    if (intent === "connect") {
      const { hostname, name, id: _id, ...options } = values;
      this.onConnect({ target: hostname, displayName: name, ...options }); return;
    }
    if (!this.options.profiles) return;
    const route = this.route, generation = this.editorGeneration;
    const credential = this.field("rememberCredential").checked ? this.field("credential").value : "";
    const credentialKind = values.authMode === "key" ? "passphrase" : "password";
    this.setBusy(true); this.message.textContent = "正在保存…";
    try {
      const result = await this.options.profiles.save(values, this.editRevision);
      if (!result.ok || !result.profile?.id) throw new Error(result.error || "主机保存失败");
      const savedTarget = `rhine-profile:${result.profile.id}`;
      this.drafts.set(route, { values: result.profile, revision: result.revision || this.editRevision });
      if (route === this.route && generation === this.editorGeneration) {
        this.editing = result.profile.id; this.editRevision = result.revision || this.editRevision;
        this.credentialTarget = savedTarget;
      }
      if (credential) {
        const saved = await window.rhineDesktop?.credentials?.save({ target: savedTarget,
          kind: credentialKind, value: credential });
        if (!saved?.ok) throw new Error(`主机已保存；凭据未保存：${saved?.error || "加密存储不可用"}`);
        if (route === this.route && generation === this.editorGeneration) this.field("credential").value = "";
      }
      const refreshed = await this.refresh();
      if (!refreshed.ok) throw new Error("主机已保存，列表刷新失败。请返回主机档案后刷新。");
      this.setBusy(false);
      this.drafts.delete(route);
      if (this.isOpen && route === this.route && generation === this.editorGeneration) {
        this.route = ""; // Do not remember the completed edit when routing away.
        this.options.saved(`rhine-profile:${result.profile.id}`, intent === "save-connect");
      }
    } catch (error) {
      if (route === this.route && generation === this.editorGeneration) {
        this.message.textContent = error instanceof Error ? error.message : String(error);
        this.form.querySelector<HTMLButtonElement>("[data-action=reload-editor]")!.hidden = false;
      }
    } finally { this.setBusy(false); }
  }
  private async reloadEditor() {
    if (this.busy) return;
    const route = this.route, generation = this.editorGeneration, page = this.page;
    const container = this.root.parentElement;
    this.setBusy(true);
    try {
      const result = await this.refresh();
      if (!this.isEditing || route !== this.route || generation !== this.editorGeneration || !container) return;
      if (!result.ok) { this.message.textContent = result.error ?? "配置读取失败"; return; }
      const host = this.hosts.find(entry => route === `config:${entry.alias}`);
      if (page === "config" && !host) { this.options.back(); return; }
      this.drafts.delete(route);
      this.route = "";
      this.mount(container, page, host);
      this.message.textContent = "已载入最新配置";
    } finally { this.setBusy(false); }
  }
  private async remove() {
    if (!this.editing || this.busy || !this.options.profiles) return;
    if (!this.deleteArmed) { this.deleteArmed = true; this.message.textContent = "再次点击“移除此主机”确认。会话历史继续保留。"; return; }
    const route = this.route, generation = this.editorGeneration;
    this.setBusy(true);
    try {
      const result = await this.options.profiles.remove(this.editing, this.editRevision);
      if (!result.ok) throw new Error(result.error || "主机移除失败");
      this.drafts.delete(route);
      this.route = "";
      await this.refresh();
      this.options.removed();
    } catch (error) {
      if (route === this.route && generation === this.editorGeneration) this.message.textContent = error instanceof Error ? error.message : String(error);
    } finally { this.setBusy(false); }
  }
  private async pickIdentity() {
    if (!this.options.profiles) return;
    const generation = this.editorGeneration;
    try {
      const result = await this.options.profiles.pickIdentity();
      if (!this.isEditing || generation !== this.editorGeneration) return;
      if (result.ok && result.file) {
        const added = await window.rhineDesktop?.keys?.add({ source: "file", file: result.file });
        if (!this.isEditing || generation !== this.editorGeneration) return;
        if (added?.ok && added.key) {
          await this.refreshKeys(added.key.id);
          this.field("authMode").value = "key"; this.syncAuthentication();
        } else if (!window.rhineDesktop?.keys) this.field("identityFile").value = result.file;
        else this.message.textContent = added?.error || "密钥无法读取";
      }
      else if (result.error) this.message.textContent = result.error;
    } catch (error) { if (this.isEditing && generation === this.editorGeneration) this.message.textContent = String(error); }
  }
  private syncAuthentication() {
    const key = this.field("authMode").value === "key";
    this.form.querySelector<HTMLElement>("[data-key-choice]")!.hidden = !key;
    this.form.querySelector<HTMLElement>("[data-credential-label]")!.textContent = key ? "私钥口令" : "登录密码";
    this.field("credential").hidden = !this.field("rememberCredential").checked;
  }
  private async refreshKeys(selected = this.field("keyId").value) {
    const generation = this.editorGeneration;
    const result = await window.rhineDesktop?.keys?.list().catch(() => null);
    if (!result?.ok || generation !== this.editorGeneration) return;
    const select = this.field("keyId") as unknown as HTMLSelectElement;
    select.replaceChildren(new Option(import.meta.env.MODE === "android" ? "请选择已导入私钥" : "使用已有私钥路径", ""), ...result.keys.map(key => new Option(`${key.name} · ${key.type}${key.missing ? " · 文件缺失" : ""}`, key.id)));
    select.value = selected || "";
    if (selected && !select.value) { select.add(new Option("原密钥已移除，请重新选择", selected)); select.value = selected; }
  }
  private async refreshCredentials() {
    const target = this.credentialTarget, generation = this.editorGeneration;
    const node = this.form.querySelector<HTMLElement>(".ssh-credential-state")!;
    if (!target) { node.textContent = "尚未保存登录凭据"; return; }
    const result = await window.rhineDesktop?.credentials?.status(target).catch(() => null);
    if (generation !== this.editorGeneration || target !== this.credentialTarget) return;
    const state = result?.state?.[this.field("authMode").value === "key" ? "passphrase" : "password"];
    node.textContent = result && !result.ok ? result.error || "凭据状态不可用" : state === "saved" ? "凭据已加密保存 · 留空保留" : state === "needs-update" ? "保存的凭据未通过认证，请更新" : "尚未保存登录凭据";
    this.form.querySelector<HTMLButtonElement>("[data-action=forget-credential]")!.hidden = !state || state === "none";
  }
  private async forgetCredential() {
    const target = this.credentialTarget, generation = this.editorGeneration;
    const result = await window.rhineDesktop?.credentials?.remove({ target,
      kind: this.field("authMode").value === "key" ? "passphrase" : "password" }).catch(() => null);
    if (generation !== this.editorGeneration || target !== this.credentialTarget) return;
    if (!result?.ok) this.message.textContent = result?.error || "凭据删除失败";
    else { this.field("credential").value = ""; await this.refreshCredentials(); }
  }
  dispose() { this.request++; this.editorGeneration++; this.motion.cancel(); this.root.remove(); this.drafts.clear(); }
}
