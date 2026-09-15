import { SurfaceTransition } from "../ui-transitions";
import { SurfaceScope, hasSshSurface } from "./surface.ts";
import { createRollingText } from "@kitlangton/rolling-number";
import { SshPageMotion } from "./page-motion";
import "./prompt.css";

/**
 * Blocking surfaces for the decisions a connection actually needs.
 *
 * Three of these are security boundaries, not decorations:
 *   hostkey            an unknown host key must be confirmed before ssh proceeds
 *   password / …       a secret is typed here and forwarded straight to the pty
 *   failure            what went wrong, with the raw lines that prove it
 *
 * Rule R3 is the reason `failure` shows the raw log: an error message the user
 * cannot trace back to a real line is just an assertion.
 */

export type PromptRequest = (
  | {
      kind: "hostkey";
      host: string;
      keyType: string;
      fingerprint: string;
      raw: string;
    }
  | { kind: "password"; host: string; prompt: string }
  | { kind: "passphrase"; key: string; prompt: string }
  | { kind: "verification-code"; prompt: string }
  | {
      kind: "failure";
      reason: string;
      phase: string;
      timeline: { label: string; at: number; duration: number }[];
      log: readonly string[];
    }
) & { requestId?: number | string; source?: "sftp" | "monitor" | "tunnel"; canRemember?: boolean };

export type PromptActions = {
  /** `yes` / `no` written to the pty — the host key decision itself. */
  answerHostKey(accept: boolean): void;
  /** Optional persistence is handled by the owning main-process credential broker. */
  answerSecret(value: string, remember?: boolean): void;
  /** Abort the attempt (Ctrl+C on the pty). */
  cancel(): void;
  /** Dismiss a failure notice without changing the session. */
  dismiss(): void;
  retry(): void;
  /** Open the full session record from a failure notice. */
  openAudit(): void;
  /**
   * Called after a question that ended the attempt has been answered or
   * aborted: ssh is waiting on a line nobody is going to type, so there is
   * nothing left on the detail page to stay for. The session layer decides
   * where that leaves the user; the panel only knows it is finished.
   */
  leave(): void;
};

const TITLES: Record<string, string> = {
  hostkey: "主机密钥确认",
  password: "需要登录口令",
  passphrase: "需要私钥口令",
  "verification-code": "需要验证码",
  failure: "连接未建立",
};

const escape = (value: string) =>
  value.replace(/[&<>"]/g, (char) =>
    char === "&"
      ? "&amp;"
      : char === "<"
        ? "&lt;"
        : char === ">"
          ? "&gt;"
          : "&quot;",
  );

const formatDuration = (ms: number) =>
  ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`;

export class SshPromptPanel {
  private root: HTMLElement;
  private transition: SurfaceTransition;
  private body: HTMLElement;
  private title: HTMLElement;
  private rollingTitle: ReturnType<typeof createRollingText>;
  private motion = new SshPageMotion();
  private current: PromptRequest["kind"] | null = null;
  private scope: SurfaceScope;
  /** Signature of what is currently rendered, so a re-render only happens for
   *  a genuinely different question. Re-rendering a password field destroys it
   *  and takes whatever the user has typed with it. */
  private signature: string | null = null;
  private open = false;
  /** Set while a secret is in flight so it can be discarded immediately after. */
  private secret = "";
  /**
   * Bound to the document, in capture, for as long as the question is open.
   *
   * The panel used to listen on its own root, which only worked while focus
   * happened to be inside it: clicking anywhere else on the sheet moved focus
   * out, Escape then bubbled past to the archive's handler, and that handler
   * returns early whenever a prompt is open — so the key did nothing at all.
   * A blocking question owns the keyboard the whole time it is asking.
   */
  private onDocumentKeyDown = (event: KeyboardEvent) => {
    if (!this.open) return;
    this.onKeyDown(event);
  };

  constructor(
    private host: HTMLElement,
    private actions: PromptActions,
  ) {
    this.root = document.createElement("section");
    this.root.className = "ssh-prompt";
    this.root.hidden = true;
    this.root.dataset.transition = "closed";
    this.root.setAttribute("role", "alertdialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-labelledby", "ssh-prompt-title");
    this.root.innerHTML = `
      <button type="button" class="ssh-prompt-back" data-action="back">← <span>返回总览</span><kbd>ESC</kbd></button>
      <div class="ssh-prompt-panel">
        <header class="ssh-prompt-head">
          <div class="detail-kicker" data-ssh-reveal><span>SSH / ACCESS REQUEST</span><span class="ssh-prompt-kind"></span></div>
          <h2 id="ssh-prompt-title" class="ssh-prompt-title" data-ssh-reveal></h2>
          <div class="detail-rule" data-ssh-reveal></div>
          <div class="ssh-prompt-wait" data-ssh-reveal><i class="status-light" aria-hidden="true"></i><span>AWAITING INPUT / 等待输入</span></div>
        </header>
        <div class="ssh-prompt-body"></div>
      </div>`;
    this.title = this.root.querySelector<HTMLElement>(".ssh-prompt-title")!;
    this.rollingTitle = createRollingText(this.title, {
      text: "",
      duration: 460,
      motionBlur: true,
      transition: "direct",
      stagger: "none",
    });
    this.body = this.root.querySelector<HTMLElement>(".ssh-prompt-body")!;
    this.transition = new SurfaceTransition(
      this.root,
      this.root.querySelector<HTMLElement>(".ssh-prompt-panel")!,
      300,
      200,
    );
    this.scope = new SurfaceScope(host, this.root);
    this.root.addEventListener("click", (event) => this.onClick(event));
  }

  get isOpen() {
    return this.scope.active;
  }

  get kind() {
    return this.current;
  }

  /** Visible text of the surface; the smoke checks read it rather than guessing. */
  get text() {
    return (this.root.innerText || "").replace(/\s+/g, " ").trim();
  }

  show(request: PromptRequest, reduced: boolean) {
    this.current = request.kind;
    this.root.querySelector<HTMLElement>(".detail-kicker > span")!.textContent =
      request.source === "sftp"
        ? "SFTP / 文件通道认证"
        : request.source === "monitor"
          ? "MONITOR / 监控通道认证"
          : request.source === "tunnel"
            ? "TUNNEL / 端口转发认证"
          : "SSH / ACCESS REQUEST";
    this.root.dataset.kind = request.kind;
    this.root.querySelector<HTMLElement>(".ssh-prompt-kind")!.textContent =
      request.kind.toUpperCase();
    this.root.querySelector<HTMLElement>(".ssh-prompt-wait span")!.textContent =
      request.kind === "failure"
        ? "CONNECTION ENDED / 本次连接已结束"
        : request.kind === "hostkey"
          ? "AWAITING CONFIRMATION / 等待确认"
          : "AWAITING INPUT / 等待输入";
    // Only rebuild the body for a genuinely different question. Rebuilding it
    // on every state change replaces the input node and discards the answer
    // being typed — which is what "every letter flashes and disappears" was.
    //
    // A secret field belongs to its request ID and kind:
    // re-rendering one never helps, and ssh rewording its prompt mid-answer
    // must not cost the user what they have typed.
    const asksForSecret =
      request.kind === "password" ||
      request.kind === "passphrase" ||
      request.kind === "verification-code";
    const signature = asksForSecret
      ? `${request.kind}:${request.requestId ?? ""}`
      : JSON.stringify(request);
    const changed = signature !== this.signature;
    const entering = !this.open;
    if (changed) {
      this.signature = signature;
      this.root.dataset.renders = String(
        (Number(this.root.dataset.renders) || 0) + 1,
      );
      this.body.innerHTML = this.render(request);
      if (request.source) {
        const cancel = this.body.querySelector<HTMLElement>(
          '[data-action="cancel"]',
        );
        if (cancel) cancel.textContent = "取消此通道认证";
      }
      for (const child of this.body.children)
        (child as HTMLElement).dataset.sshReveal = "";
    }
    if (!this.open) {
      this.open = true;
      this.scope.enter();
      this.transition.show(reduced);
      document.addEventListener("keydown", this.onDocumentKeyDown, true);
    }
    this.host.dataset.sshPrompt = "true";
    if (changed || entering) {
      this.rollingTitle.update({
        text: TITLES[request.kind] ?? "需要处理",
        animated: !reduced,
      });
      this.motion.reveal(this.root, reduced);
    }
    // The secret field, when present, takes focus so the decision is one gesture.
    // An already-focused field is left alone: re-focusing on every update would
    // fight the caret.
    const field = this.body.querySelector<HTMLInputElement>(
      "input[type=password], input[type=text]",
    );
    if (!changed && !entering) return;
    if (field && document.activeElement !== field)
      field.focus({ preventScroll: true });
    else if (!field)
      this.body
        .querySelector<HTMLButtonElement>("button[data-action]")
        ?.focus({ preventScroll: true });
  }

  /** Never keep a secret longer than the round trip. */
  private takeSecret() {
    const value = this.secret;
    this.secret = "";
    for (const field of this.body.querySelectorAll<HTMLInputElement>("input"))
      field.value = "";
    return value;
  }

  hide(reduced: boolean, finished?: () => void) {
    document.removeEventListener("keydown", this.onDocumentKeyDown, true);
    this.secret = "";
    for (const field of this.body.querySelectorAll<HTMLInputElement>("input"))
      field.value = "";
    this.open = false;
    this.current = null;
    this.signature = null;
    this.transition.hide(reduced, () => {
      this.motion.cancel();
      this.rollingTitle.finish();
      delete this.host.dataset.sshPrompt;
      this.scope.leave();
      if (!hasSshSurface(this.host)) finished?.();
    });
  }

  private onClick(event: Event) {
    const button = (event.target as Element).closest<HTMLElement>(
      "[data-action]",
    );
    if (!button) return;
    switch (button.dataset.action) {
      case "accept-hostkey":
        this.actions.answerHostKey(true);
        break;
      case "reject-hostkey":
        this.actions.answerHostKey(false);
        break;
      case "submit-secret": {
        const value =
          this.body.querySelector<HTMLInputElement>("input")?.value ?? "";
        this.secret = "";
        this.actions.answerSecret(value, this.body.querySelector<HTMLInputElement>("[data-remember]")?.checked ?? false);
        for (const field of this.body.querySelectorAll<HTMLInputElement>(
          "input",
        ))
          field.value = "";
        break;
      }
      case "cancel":
        this.actions.cancel();
        break;
      case "retry":
        this.actions.retry();
        break;
      case "audit":
        this.actions.openAudit();
        break;
      case "dismiss":
        this.actions.dismiss();
        break;
      case "back":
        this.leave();
        break;
      default:
        break;
    }
  }

  private onKeyDown(event: KeyboardEvent) {
    if (!this.open) return;
    // The prompt owns the keyboard while it is asking; nothing may leak to the
    // archive shortcuts underneath.
    event.stopPropagation();
    if (event.key === "Enter" && this.body.querySelector("input")) {
      event.preventDefault();
      const value = this.body.querySelector<HTMLInputElement>("input")!.value;
      this.actions.answerSecret(value, this.body.querySelector<HTMLInputElement>("[data-remember]")?.checked ?? false);
      for (const field of this.body.querySelectorAll<HTMLInputElement>("input"))
        field.value = "";
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.leave();
    }
    // Ctrl+Shift+A opens the record from anywhere the panel is asking something.
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "a") {
      event.preventDefault();
      this.actions.openAudit();
    }
  }

  /**
   * The one exit shared by the corner button and Escape.
   *
   * A secret or a host key cannot be left unanswered — ssh is blocked on that
   * line — so leaving is the same decision as aborting the attempt. Only a
   * failure notice is a surface you can walk away from without changing
   * anything, and it keeps dismissing rather than leaving.
   */
  private leave() {
    if (this.current === "failure") {
      this.actions.dismiss();
      return;
    }
    if (this.current === "hostkey") this.actions.answerHostKey(false);
    else this.actions.cancel();
    this.actions.leave();
  }

  private render(request: PromptRequest): string {
    switch (request.kind) {
      case "hostkey":
        return `
          <p class="ssh-prompt-lead">这台主机的身份尚未被记录。确认指纹后再继续，否则可能正在连接一台冒充的服务器。</p>
          <dl class="ssh-prompt-facts">
            <dt>主机</dt><dd>${escape(request.host || "（见下方原始输出）")}</dd>
            <dt>密钥类型</dt><dd>${escape(request.keyType || "—")}</dd>
            <dt>指纹</dt><dd class="ssh-prompt-fingerprint">${escape(request.fingerprint || "—")}</dd>
          </dl>
          <div class="ssh-prompt-actions">
            <button type="button" data-action="accept-hostkey" class="solid-button" ${request.fingerprint ? "" : "disabled"}>TRUST HOST<span>确认并继续 →</span></button>
            <button type="button" data-action="reject-hostkey" class="export-button">拒绝</button>
          </div>
          <details class="ssh-prompt-raw"><summary>原始输出</summary><pre>${escape(request.raw)}</pre></details>`;
      case "password":
        return `
          <p class="ssh-prompt-lead">${escape(request.host)} 要求输入登录口令。${request.canRemember ? "连接后文件与监控通道会复用此次认证。" : "此请求单独认证。"}</p>
          <label class="ssh-prompt-field"><span>口令</span>
            <input type="password" autocomplete="off" spellcheck="false" /></label>
          ${request.canRemember ? '<label class="ssh-remember"><input type="checkbox" data-remember>记住此主机的密码 <small>当前 Windows 账户加密保存</small></label>' : ""}
          <div class="ssh-prompt-actions">
            <button type="button" data-action="submit-secret" class="solid-button">AUTHENTICATE<span>发送口令 →</span></button>
            <button type="button" data-action="cancel" class="export-button">中止连接</button>
          </div>
          <details class="ssh-prompt-raw"><summary>原始提示</summary><pre>${escape(request.prompt)}</pre></details>`;
      case "passphrase":
        return `
          <p class="ssh-prompt-lead">私钥 <code>${escape(request.key)}</code> 需要解锁。</p>
          <label class="ssh-prompt-field"><span>私钥口令</span>
            <input type="password" autocomplete="off" spellcheck="false" /></label>
          ${request.canRemember ? '<label class="ssh-remember"><input type="checkbox" data-remember>记住私钥口令 <small>当前 Windows 账户加密保存</small></label>' : ""}
          <div class="ssh-prompt-actions">
            <button type="button" data-action="submit-secret" class="solid-button">UNLOCK KEY<span>解锁私钥 →</span></button>
            <button type="button" data-action="cancel" class="export-button">中止连接</button>
          </div>
          <details class="ssh-prompt-raw"><summary>原始提示</summary><pre>${escape(request.prompt)}</pre></details>`;
      case "verification-code":
        return `
          <p class="ssh-prompt-lead">${escape(request.prompt || "请输入认证器显示的验证码。")}</p>
          <label class="ssh-prompt-field"><span>验证码</span>
            <input type="text" inputmode="numeric" autocomplete="one-time-code" spellcheck="false" /></label>
          <div class="ssh-prompt-actions">
            <button type="button" data-action="submit-secret" class="solid-button">VERIFY<span>发送验证码 →</span></button>
            <button type="button" data-action="cancel" class="export-button">中止连接</button>
          </div>`;
      case "failure":
        return `
          <p class="ssh-prompt-lead">${escape(request.reason)}</p>
          <ol class="ssh-prompt-timeline">
            ${request.timeline
              .map(
                (entry) =>
                  `<li><span class="ssh-prompt-phase">${escape(entry.label)}</span><span class="ssh-prompt-time">${formatDuration(entry.duration)}</span></li>`,
              )
              .join("")}
          </ol>
          <div class="ssh-prompt-actions">
            <button type="button" data-action="retry" class="solid-button">RECONNECT<span>重新连接 →</span></button>
            <button type="button" data-action="audit" class="export-button">查看完整记录</button>
            <button type="button" data-action="dismiss" class="export-button">返回档案</button>
          </div>
          <details class="ssh-prompt-raw" open><summary>ssh 原始输出（${request.log.length} 行）</summary><pre>${escape(request.log.join("\n"))}</pre></details>`;
      default:
        return "";
    }
  }

  dispose() {
    document.removeEventListener("keydown", this.onDocumentKeyDown, true);
    this.motion.cancel();
    this.rollingTitle.destroy();
    this.scope.dispose();
    this.secret = "";
    this.transition.dispose();
    this.root.remove();
  }
}
