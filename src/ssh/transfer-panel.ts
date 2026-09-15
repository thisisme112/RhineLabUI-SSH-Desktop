import { SurfaceTransition } from "../ui-transitions";
import { SshPageMotion } from "./page-motion";
import {
  bytes,
  type ServicesState,
  type TransferJob,
  SshServicesClient,
} from "./services";

const ended = new Set(["completed", "failed", "canceled", "uncertain"]);
const labels: Record<TransferJob["state"], string> = {
  queued: "等待传输",
  scanning: "扫描目录",
  transferring: "传输中",
  committing: "正在完成写入",
  conflict: "同名文件待处理",
  completed: "已完成",
  failed: "失败",
  canceled: "已取消",
  uncertain: "写入结果待核实",
};
type Row = { root: HTMLElement; conflictId: string };

export class TransferPanel {
  private transition: SurfaceTransition;
  private motion = new SshPageMotion();
  private abort = new AbortController();
  private rows = new Map<string, Row>();
  private state: ServicesState | null = null;
  private session = "";
  private busy = new Set<string>();
  private open = false;
  private list: HTMLElement;
  private feedback: HTMLElement;

  constructor(
    private root: HTMLElement,
    private toggle: HTMLButtonElement,
    private services: SshServicesClient,
    private reduced: () => boolean,
    private layout: () => void,
  ) {
    root.innerHTML = `<div class="ssh-transfer-head"><span>TRANSFER QUEUE / 传输队列</span><small>同时传输 2 项</small><button type="button" data-transfer-action="close" aria-label="收起传输队列">收起 ↓</button></div><div class="ssh-transfer-list" tabindex="0" aria-label="文件传输列表"></div><div class="ssh-transfer-feedback" role="status"></div>`;
    this.list = root.querySelector(".ssh-transfer-list")!;
    this.feedback = root.querySelector(".ssh-transfer-feedback")!;
    this.transition = new SurfaceTransition(root, undefined, 240, 180);
    const options = { signal: this.abort.signal };
    toggle.addEventListener(
      "click",
      () => (this.open ? this.hide() : this.show(true)),
      options,
    );
    root.addEventListener(
      "click",
      (event) => {
        const target =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>("[data-transfer-action]")
            : null;
        if (!target) return;
        const action = target.dataset.transferAction!;
        if (action === "close") {
          this.hide();
          return;
        }
        const row = target.closest<HTMLElement>("[data-job]");
        if (row) void this.action(row.dataset.job!, action);
      },
      options,
    );
    root.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          this.hide();
        }
      },
      options,
    );
  }
  show(focus = false) {
    if (!this.open) {
      this.open = true;
      this.root.inert = false;
      this.toggle.setAttribute("aria-expanded", "true");
      this.transition.show(this.reduced());
      this.motion.reveal(this.root, this.reduced());
      this.layout();
    }
    if (focus) this.list.focus({ preventScroll: true });
  }
  hide(immediate = false) {
    const restore = this.root.contains(document.activeElement);
    this.open = false;
    this.root.inert = true;
    this.toggle.setAttribute("aria-expanded", "false");
    this.transition.hide(immediate || this.reduced(), () => {
      this.motion.cancel();
      this.layout();
    });
    if (restore && !immediate) this.toggle.focus({ preventScroll: true });
  }
  finishMotion() {
    this.transition.finish();
    this.motion.finish();
  }
  update(state: ServicesState | null) {
    this.state = state;
    if (this.session !== (state?.sessionId ?? "")) {
      this.session = state?.sessionId ?? "";
      this.rows.clear();
      this.busy.clear();
      this.list.replaceChildren();
      this.feedback.textContent = "";
      this.hide(true);
    }
    const jobs = state?.jobs ?? [],
      active = jobs.filter((job) => !ended.has(job.state)).length;
    const conflicts = jobs.filter((job) => job.state === "conflict").length;
    this.toggle.textContent = conflicts
      ? `传输 · ${conflicts} 项待处理`
      : `传输 / ${String(active).padStart(2, "0")}`;
    this.toggle.dataset.attention = String(conflicts > 0);
    this.toggle.title = `本会话 ${jobs.length} 项传输，${active} 项进行中`;
    this.list.dataset.empty = String(jobs.length === 0);
    for (const job of jobs) this.renderJob(job);
    for (const [id, row] of this.rows)
      if (!jobs.some((job) => job.id === id)) {
        row.root.remove();
        this.rows.delete(id);
      }
  }
  private renderJob(job: TransferJob) {
    let row = this.rows.get(job.id);
    if (!row) {
      const root = document.createElement("article");
      root.className = "ssh-transfer-job";
      root.dataset.job = job.id;
      root.innerHTML =
        '<div class="ssh-transfer-info"><span class="ssh-transfer-direction"></span><strong class="ssh-transfer-name"></strong><span class="ssh-transfer-state"></span><button type="button" data-transfer-action="cancel">取消</button><button type="button" data-transfer-action="retry" hidden>重试</button></div><div class="ssh-transfer-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100"><i></i></div><div class="ssh-transfer-detail"><span></span><span></span></div><p class="ssh-transfer-error"></p><div class="ssh-transfer-conflict" hidden></div>';
      row = { root, conflictId: "" };
      this.rows.set(job.id, row);
      this.list.prepend(root);
    }
    const root = row.root;
    root.dataset.state = job.state;
    root.querySelector(".ssh-transfer-direction")!.textContent =
      job.direction === "upload" ? "↑" : "↓";
    root.querySelector(".ssh-transfer-name")!.textContent = job.name;
    root.querySelector<HTMLElement>(".ssh-transfer-name")!.title =
      job.source + " → " + job.destination;
    root.querySelector(".ssh-transfer-state")!.textContent = labels[job.state];
    const cancel = root.querySelector<HTMLButtonElement>(
      '[data-transfer-action="cancel"]',
    )!;
    const retry = root.querySelector<HTMLButtonElement>(
      '[data-transfer-action="retry"]',
    )!;
    cancel.hidden = ended.has(job.state);
    cancel.disabled = !this.state?.active || this.busy.has(job.id);
    retry.hidden = !["failed", "canceled", "uncertain"].includes(job.state);
    retry.textContent = job.retried
      ? "已重试"
      : job.retryable === false
        ? "请核查文件"
        : job.state === "uncertain"
          ? "核实并重试"
          : "重试";
    retry.disabled =
      !this.state?.active ||
      this.busy.has(job.id) ||
      this.state.sftp.state !== "ready" ||
      job.retried === true ||
      job.retryable === false;
    const progress = root.querySelector<HTMLElement>(".ssh-transfer-progress")!;
    const value =
      job.state === "completed"
        ? 100
        : job.bytesTotal
          ? Math.min(100, (job.bytesDone / job.bytesTotal) * 100)
          : 0;
    progress.querySelector<HTMLElement>("i")!.style.width = value + "%";
    progress.setAttribute("aria-label", job.name + " 传输进度");
    progress.setAttribute("aria-valuenow", String(Math.round(value)));
    root.querySelector(".ssh-transfer-detail span")!.textContent =
      `${bytes(job.bytesDone)} / ${bytes(job.bytesTotal)} · ${job.filesDone} / ${job.filesTotal} 项${job.skipped ? ` · 跳过 ${job.skipped}` : ""}`;
    root.querySelector(".ssh-transfer-detail span:last-child")!.textContent =
      job.state === "transferring" ? bytes(job.rate) + "/s" : "";
    root.querySelector(".ssh-transfer-error")!.textContent =
      (job.error || "") +
      (job.state === "uncertain" && job.recoveryPaths?.length
        ? " · 恢复文件：" +
          job.recoveryPaths
            .map((file) =>
              job.direction === "download"
                ? job.destination + "/" + file
                : file,
            )
            .join("、")
        : "");
    const conflict = root.querySelector<HTMLElement>(".ssh-transfer-conflict")!;
    conflict.hidden = job.state !== "conflict" || !job.conflict;
    if (job.conflict && row.conflictId !== job.conflict.id) {
      row.conflictId = job.conflict.id;
      conflict.innerHTML =
        '<p></p><span></span><div><button type="button" data-transfer-action="skip">跳过</button><button type="button" data-transfer-action="overwrite">覆盖</button><button type="button" data-transfer-action="keep-both">保留两者</button><label><input type="checkbox">应用到此任务后续冲突</label></div>';
      conflict.querySelector("p")!.textContent = job.conflict.path;
      conflict.querySelector("span")!.textContent = job.conflict.directory
        ? "同名目录已存在，可合并目录或保留两者"
        : `已有 ${bytes(job.conflict.existingSize)} · 传入 ${bytes(job.conflict.sourceSize)}`;
      conflict.querySelector(
        '[data-transfer-action="overwrite"]',
      )!.textContent = job.conflict.directory ? "合并目录" : "覆盖";
    }
    for (const button of conflict.querySelectorAll<HTMLButtonElement>("button"))
      button.disabled = this.busy.has(job.id) || !this.state?.active;
  }
  private async action(id: string, action: string) {
    const state = this.state,
      job = state?.jobs.find((job) => job.id === id),
      bridge = this.services.files;
    if (!state?.active || !job || !bridge || this.busy.has(id)) return;
    const sessionId = state.sessionId;
    this.busy.add(id);
    this.renderJob(job);
    this.feedback.textContent = "";
    try {
      const result =
        action === "cancel"
          ? await bridge.cancel({ sessionId, id })
          : action === "retry"
            ? await bridge.retry({ sessionId, id })
            : job.conflict
              ? await bridge.conflict({
                  sessionId,
                  id,
                  conflictId: this.rows.get(id)!.conflictId,
                  choice: action,
                  all:
                    this.rows
                      .get(id)!
                      .root.querySelector<HTMLInputElement>(
                        ".ssh-transfer-conflict input",
                      )?.checked ?? false,
                })
              : { ok: false, error: "冲突已处理" };
      if (sessionId === this.session)
        this.feedback.textContent = result.ok
          ? ""
          : result.error || "操作未完成";
    } catch (error) {
      if (sessionId === this.session) this.feedback.textContent = String(error);
    } finally {
      if (sessionId === this.session) {
        this.busy.delete(id);
        const current = this.state?.jobs.find((job) => job.id === id);
        if (current) this.renderJob(current);
      }
    }
  }
  dispose() {
    this.abort.abort();
    this.transition.dispose();
    this.motion.cancel();
  }
}
