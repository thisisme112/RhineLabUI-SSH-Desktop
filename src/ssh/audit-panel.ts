import { SurfaceTransition } from "../ui-transitions";
import { SurfaceScope, hasSshSurface } from "./surface.ts";
import { summarizeRecord, type SessionRecord } from "./audit.ts";
import { SshPageMotion } from "./page-motion";
import "./audit-panel.css";

/**
 * The session's record, readable and exportable.
 *
 * Every row here is traceable: a phase duration came from an event's arrival
 * time, and every negotiated value carries the raw ssh line it was read from.
 * That is the point — a summary the user cannot audit is just a claim.
 */

const OUTCOME_LABEL: Record<SessionRecord["outcome"], string> = {
  interactive: "会话已建立",
  closed: "会话正常结束",
  failed: "连接失败",
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
  ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : `${(ms / 1000).toFixed(2)}s`;

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
};

export class SshAuditPanel {
  private root: HTMLElement;
  private transition: SurfaceTransition;
  private body: HTMLElement;
  private summary: HTMLElement;
  private outcome: HTMLElement;
  private scope: SurfaceScope;
  private open = false;
  private record: SessionRecord | null = null;
  private motion = new SshPageMotion();

  constructor(
    private host: HTMLElement,
    private onExport: () => void,
    private onClose: () => void,
  ) {
    this.root = document.createElement("section");
    // `ssh-record` distinguishes this surface from the host picker, which
    // deliberately shares the `.ssh-audit` layout classes.
    this.root.className = "ssh-audit ssh-record";
    this.root.hidden = true;
    this.root.dataset.transition = "closed";
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-label", "SSH 会话记录");
    this.root.innerHTML = `
      <div class="terminal-modal ssh-audit-panel">
        <div class="modal-top"><span>RHINE LAB / SESSION RECORD</span><button type="button" data-action="close" aria-label="关闭会话记录">CLOSE <span>×</span></button></div>
        <header class="ssh-audit-head" data-ssh-reveal>
          <h2>SESSION RECORD<small>会话记录</small></h2>
          <span class="ssh-audit-outcome"></span>
        </header>
        <p class="ssh-audit-summary" data-ssh-reveal></p>
        <div class="ssh-audit-body"></div>
        <div class="detail-actions ssh-audit-actions" data-ssh-reveal><button type="button" class="solid-button" data-action="export">EXPORT RECORD<span>导出记录 →</span></button></div>
      </div>`;
    this.body = this.root.querySelector<HTMLElement>(".ssh-audit-body")!;
    this.summary = this.root.querySelector<HTMLElement>(".ssh-audit-summary")!;
    this.outcome = this.root.querySelector<HTMLElement>(".ssh-audit-outcome")!;
    this.transition = new SurfaceTransition(
      this.root,
      this.root.querySelector<HTMLElement>(".ssh-audit-panel")!,
      300,
      200,
    );
    this.scope = new SurfaceScope(host, this.root);
    this.root.addEventListener("click", (event) => {
      const action = (event.target as Element).closest<HTMLElement>(
        "[data-action]",
      )?.dataset.action;
      if (action === "export") this.onExport();
      else if (action === "close") this.onClose();
    });
    this.root.addEventListener("keydown", (event) => {
      if (!this.open) return;
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        this.onClose();
      }
    });
  }

  get isOpen() {
    return this.scope.active;
  }

  get current() {
    return this.record;
  }

  show(record: SessionRecord, reduced: boolean) {
    this.record = record;
    this.summary.textContent = summarizeRecord(record);
    this.outcome.textContent = OUTCOME_LABEL[record.outcome];
    this.outcome.dataset.outcome = record.outcome;
    this.body.innerHTML = this.render(record);
    for (const child of this.body.children) (child as HTMLElement).dataset.sshReveal = "";
    if (!this.open) {
      this.open = true;
      this.scope.enter();
      this.transition.show(reduced);
    }
    this.motion.reveal(this.root, reduced);
    this.root
      .querySelector<HTMLButtonElement>("[data-action=export]")
      ?.focus({ preventScroll: true });
  }

  hide(reduced: boolean, finished?: () => void) {
    this.open = false;
    this.transition.hide(reduced, () => {
      this.motion.cancel();
      this.scope.leave();
      if (!hasSshSurface(this.host)) finished?.();
    });
  }

  private render(record: SessionRecord): string {
    const phaseRows = record.phases.length
      ? record.phases
          .map(
            (entry) => `
        <li>
          <span class="ssh-audit-phase">${escape(entry.label)}</span>
          <span class="ssh-audit-at">@${formatDuration(entry.atMs)}</span>
          <span class="ssh-audit-duration">${formatDuration(entry.durationMs)}</span>
        </li>`,
          )
          .join("")
      : '<li class="ssh-audit-empty">没有记录到阶段</li>';

    const factRows = record.facts.length
      ? record.facts
          .map(
            (fact) => `
        <li>
          <span class="ssh-audit-fact-label">${escape(fact.label)}</span>
          <span class="ssh-audit-fact-value">${escape(fact.value)}</span>
          <span class="ssh-audit-fact-source">${escape(fact.source)}</span>
        </li>`,
          )
          .join("")
      : '<li class="ssh-audit-empty">没有记录到事实</li>';

    const unknown = record.unknownLines.length
      ? `<details class="ssh-audit-raw"><summary>未识别的事件行（${record.unknownLines.length} 行，原样保留）</summary><pre>${escape(record.unknownLines.join("\n"))}</pre></details>`
      : "";

    return `
      <section>
        <h3>阶段耗时</h3>
        <ol class="ssh-audit-phases">${phaseRows}</ol>
      </section>
      <section>
        <h3>协商结果与已验证事实</h3>
        <ul class="ssh-audit-facts">${factRows}</ul>
      </section>
      <section>
        <h3>流量</h3>
        <dl class="ssh-audit-grid">
          <dt>下行合计</dt><dd>${formatBytes(record.traffic.bytesIn)}</dd>
          <dt>上行合计</dt><dd>${formatBytes(record.traffic.bytesOut)}</dd>
          <dt>下行峰值</dt><dd>${formatBytes(record.traffic.peakBytesPerSecondIn)}/s</dd>
          <dt>上行峰值</dt><dd>${formatBytes(record.traffic.peakBytesPerSecondOut)}/s</dd>
          <dt>事件行数</dt><dd>${record.traffic.logLines}</dd>
        </dl>
      </section>
      <section>
        <h3>执行的命令</h3>
        <pre class="ssh-audit-command">${escape(record.argv.join(" "))}</pre>
        <p class="ssh-audit-path">事件日志 ${escape(record.logPath)}</p>
      </section>
      ${unknown}`;
  }

  dispose() {
    this.motion.cancel();
    this.scope.dispose();
    this.transition.dispose();
    this.root.remove();
  }
}
