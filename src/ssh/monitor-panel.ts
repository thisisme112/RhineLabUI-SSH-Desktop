import { createRollingText } from "@kitlangton/rolling-number";
import { SshPageMotion } from "./page-motion";
import {
  bytes,
  percent,
  type GPU,
  type HistoryPoint,
  type ServicesState,
  SshServicesClient,
} from "./services";

const chart =
  '<svg class="ssh-trend" viewBox="0 0 300 44" preserveAspectRatio="none" role="img"><path class="ssh-trend-grid" d="M0 1H300M0 22H300M0 43H300"/><path class="ssh-trend-line"/></svg>';
const markup = `
  <div class="ssh-side-kicker" data-ssh-reveal><span>HOST TELEMETRY</span><span>01 s</span></div>
  <div class="ssh-monitor-status" role="status" data-ssh-reveal><i aria-hidden="true"></i><span></span></div>
  <div class="ssh-monitor-host" data-ssh-reveal><strong></strong><span></span></div>
  <div class="ssh-host-metrics" data-ssh-reveal>
    <section class="ssh-metric" data-metric="cpu"><div class="ssh-side-kicker">CPU <span>占用</span></div><div class="ssh-metric-value">—</div>${chart}<small></small></section>
    <section class="ssh-metric" data-metric="memory"><div class="ssh-side-kicker">MEMORY <span>内存</span></div><div class="ssh-metric-value">—</div>${chart}<small></small></section>
  </div>
  <div class="ssh-monitor-summary" data-ssh-reveal></div>
  <div class="ssh-monitor-section" data-ssh-reveal><div class="ssh-side-kicker"><span>NVIDIA / GPU</span><span>01 s</span></div><p class="ssh-gpu-status"></p><div class="ssh-gpu-overview" aria-label="GPU 总览"></div><div class="ssh-monitor-gpus"></div></div>
  <div class="ssh-monitor-section" data-ssh-reveal><div class="ssh-side-kicker"><span>FILESYSTEM</span><span>10 s</span></div><div class="ssh-monitor-disks"></div></div>
  <p class="ssh-monitor-errors" role="status"></p>
  <div class="ssh-monitor-legend" data-ssh-reveal><span>最近 5 分钟</span><span>低占用 — 高占用</span><i></i></div>
  <button type="button" class="ssh-monitor-retry" hidden>重新启动监控 ↗</button>
`;

export function trendPath(
  history: HistoryPoint[],
  select: (point: HistoryPoint) => number | null,
  end: number,
) {
  let path = "",
    previous = 0;
  for (const point of history) {
    const value = select(point);
    if (point.receivedAt < end - 300000) continue;
    if (value == null || !Number.isFinite(value)) {
      previous = 0;
      continue;
    }
    const x = Math.max(
      0,
      Math.min(300, (point.receivedAt - end + 300000) / 1000),
    );
    const y = 43 - Math.max(0, Math.min(100, value)) * 0.42;
    path += `${previous && point.receivedAt - previous < 3000 ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    previous = point.receivedAt;
  }
  return path;
}

const tone = (value: number | null) =>
  value == null
    ? "unknown"
    : value >= 90
      ? "high"
      : value >= 65
        ? "medium"
        : "low";
const ratio = (used: number | null, total: number | null) =>
  used != null && total ? (used / total) * 100 : null;
const unit = (value: number | null, suffix: string) =>
  value == null ? "—" : Math.round(value) + suffix;
const rate = (value: number | null) =>
  value == null ? "—" : bytes(value) + "/s";

class Reading {
  private rolling: ReturnType<typeof createRollingText>;
  constructor(readonly node: HTMLElement) {
    const number = document.createElement("span"), suffix = document.createElement("span");
    number.className = "ssh-reading-number"; suffix.className = "ssh-reading-unit"; suffix.textContent = "%";
    node.replaceChildren(number, suffix);
    this.rolling = createRollingText(number, {
      text: "—",
      duration: 180,
      motionBlur: false,
      transition: "direct",
      stagger: "none",
    });
  }
  set(value: number | null, animated: boolean) {
    const known = value != null && Number.isFinite(value);
    this.node.dataset.unknown = String(!known);
    this.rolling.update({ text: known ? percent(value).replace("%", "") : "—", animated });
  }
  finish() {
    this.rolling.finish();
  }
  dispose() {
    this.rolling.destroy();
  }
}

type GpuView = {
  root: HTMLElement;
  usage: Reading;
  memory: Reading;
  processes: Map<string, HTMLElement>;
};

/** Samples update existing nodes so selection, GPU disclosure and scroll stay put. */
export class MonitorPanel {
  private motion = new SshPageMotion();
  private abort = new AbortController();
  private visible = false;
  private state: ServicesState | null = null;
  private session = "";
  private sequence = -1;
  private receivedAt = 0;
  private cpu: Reading;
  private memory: Reading;
  private gpus = new Map<string, GpuView>();
  private disks = new Map<string, HTMLElement>();
  private summary = new Map<string, HTMLElement>();
  private overview = new Map<string, HTMLElement>();
  private staleTimer = 0;

  constructor(
    private root: HTMLElement,
    private services: SshServicesClient,
    private reduced: () => boolean,
  ) {
    root.innerHTML = markup;
    this.cpu = new Reading(
      root.querySelector('[data-metric="cpu"] .ssh-metric-value')!,
    );
    this.memory = new Reading(
      root.querySelector('[data-metric="memory"] .ssh-metric-value')!,
    );
    root.querySelector(".ssh-monitor-retry")!.addEventListener(
      "click",
      () => {
        const session = services.sessionId;
        void services
          .retryMonitor()
          ?.then((result) => {
            if (!result.ok && session === services.sessionId)
              root.querySelector(".ssh-monitor-errors")!.textContent =
                result.error || "监控启动失败";
          })
          .catch(() => {
            if (session === services.sessionId)
              root.querySelector(".ssh-monitor-errors")!.textContent =
                "监控启动失败";
          });
      },
      { signal: this.abort.signal },
    );
    document.addEventListener("visibilitychange", () => {
      this.syncTimer();
      if (this.visible && !document.hidden) this.render(true);
    }, { signal: this.abort.signal });
  }

  setVisible(visible: boolean) {
    const entering = visible && !this.visible;
    this.visible = visible;
    this.syncTimer();
    if (entering) {
      this.render(true);
      this.motion.reveal(this.root, this.reduced());
    }
    if (!visible) this.finishMotion();
  }
  private syncTimer() {
    if (this.staleTimer) window.clearInterval(this.staleTimer);
    this.staleTimer = this.visible && !document.hidden ? window.setInterval(() => this.renderStatus(), 1000) : 0;
  }
  focus() {
    this.root.focus({ preventScroll: true });
  }
  finishMotion() {
    this.motion.finish();
    this.cpu.finish();
    this.memory.finish();
    for (const gpu of this.gpus.values()) {
      gpu.usage.finish();
      gpu.memory.finish();
    }
  }
  update(state: ServicesState | null) {
    this.state = state;
    if ((state?.sessionId ?? "") !== this.session) {
      this.session = state?.sessionId ?? "";
      this.sequence = -1;
      this.receivedAt = 0;
      for (const gpu of this.gpus.values()) {
        gpu.usage.dispose();
        gpu.memory.dispose();
        gpu.root.remove();
      }
      this.gpus.clear();
      this.disks.clear();
      this.summary.clear();
      this.overview.clear();
      this.root.querySelector(".ssh-gpu-overview")!.replaceChildren();
      this.root.querySelector(".ssh-monitor-disks")!.replaceChildren();
      this.root.querySelector(".ssh-monitor-summary")!.replaceChildren();
      this.cpu.set(null, false);
      this.memory.set(null, false);
      for (const node of this.root.querySelectorAll(
        ".ssh-monitor-host strong, .ssh-monitor-host > span, .ssh-metric small, .ssh-gpu-status, .ssh-monitor-errors",
      ))
        node.textContent = "";
      for (const node of this.root.querySelectorAll(".ssh-trend-line"))
        node.setAttribute("d", "");
    }
    if (this.visible && !document.hidden) this.render();
  }
  private renderStatus() {
    const state = this.state;
    const stale = Boolean(
      state?.sample &&
      (!state.active ||
        state.monitor.state !== "ready" ||
        Date.now() - state.receivedAt > 3000),
    );
    this.root.dataset.stale = String(stale);
    const status = this.root.querySelector<HTMLElement>(".ssh-monitor-status")!;
    status.dataset.state = stale
      ? "stale"
      : (state?.monitor.state ?? "waiting");
    status.querySelector("span")!.textContent = stale
      ? `采样已暂停 · ${state?.receivedAt ? new Date(state.receivedAt).toLocaleTimeString() : "—"} 最后更新`
      : state?.monitor.state === "ready"
        ? "实时采样 · 每秒更新"
        : state?.monitor.message?.split("\n")[0] || "连接后自动开始监控";
    status.title = state?.monitor.message || "";
    this.root.querySelector<HTMLElement>(".ssh-monitor-retry")!.hidden =
      !state?.active || !["error", "unsupported"].includes(state.monitor.state);
  }
  private render(force = false) {
    this.renderStatus();
    const state = this.state,
      sample = state?.sample;
    if (
      !state ||
      !sample ||
      (!force &&
        sample.sequence === this.sequence &&
        state.receivedAt === this.receivedAt)
    )
      return;
    this.sequence = sample.sequence;
    this.receivedAt = state.receivedAt;
    const animate = this.visible && !this.reduced();
    const memory = sample.memory;
    this.root.querySelector(".ssh-monitor-host strong")!.textContent =
      sample.hostname;
    this.root.querySelector(".ssh-monitor-host > span")!.textContent =
      `运行 ${Math.floor(sample.uptime / 86400)} 天 ${Math.floor(sample.uptime / 3600) % 24} 时`;
    const cpuValue = sample.cpu?.usage ?? null,
      memoryValue = memory ? ratio(memory.used, memory.total) : null;
    this.cpu.set(cpuValue, animate);
    this.memory.set(memoryValue, animate);
    for (const [name, value, select] of [
      ["cpu", cpuValue, (point: HistoryPoint) => point.cpu],
      ["memory", memoryValue, (point: HistoryPoint) => point.memory],
    ] as const) {
      const metric = this.root.querySelector<HTMLElement>(
        `[data-metric="${name}"]`,
      )!;
      metric.dataset.tone = tone(value);
      metric
        .querySelector("svg")!
        .setAttribute(
          "aria-label",
          `${name === "cpu" ? "CPU" : "内存"}占用，最近五分钟`,
        );
      metric
        .querySelector(".ssh-trend-line")!
        .setAttribute("d", trendPath(state.history, select, state.receivedAt));
    }
    this.root.querySelector('[data-metric="cpu"] small')!.textContent =
      sample.cpu
        ? `${sample.cpu.cores} 核 · LOAD ${sample.cpu.load.map((n) => n.toFixed(1)).join(" / ")}`
        : "CPU 数据不可用";
    this.root.querySelector('[data-metric="memory"] small')!.textContent =
      memory
        ? `${bytes(memory.used)} / ${bytes(memory.total)}`
        : "内存数据不可用";
    const details: [string, string][] = [
      [
        "SWAP",
        memory ? `${bytes(memory.swapUsed)} / ${bytes(memory.swapTotal)}` : "—",
      ],
      [
        "DISK I/O",
        `读 ${rate(sample.diskIO.read)} · 写 ${rate(sample.diskIO.write)}`,
      ],
      ...sample.networks.map((net): [string, string] => [
        net.name,
        `↓ ${rate(net.receive)} · ↑ ${rate(net.send)}`,
      ]),
    ];
    const summaryRoot = this.root.querySelector(".ssh-monitor-summary")!;
    for (const [key, value] of details) {
      let row = this.summary.get(key);
      if (!row) {
        row = document.createElement("div");
        row.append(
          document.createElement("span"),
          document.createElement("span"),
        );
        summaryRoot.append(row);
        this.summary.set(key, row);
      }
      row.children[0].textContent = key;
      row.children[1].textContent = value;
    }
    for (const [key, row] of this.summary)
      if (!details.some(([name]) => key === name)) {
        row.remove();
        this.summary.delete(key);
      }
    const diskRoot = this.root.querySelector(".ssh-monitor-disks")!;
    for (const disk of sample.disks) {
      let row = this.disks.get(disk.mount);
      if (!row) {
        row = document.createElement("div");
        row.className = "ssh-disk";
        row.innerHTML =
          '<div><strong></strong><span></span></div><div class="ssh-meter"><i></i></div><small></small>';
        diskRoot.append(row);
        this.disks.set(disk.mount, row);
      }
      const value = ratio(disk.used, disk.total);
      row.dataset.tone = tone(value);
      row.querySelector("strong")!.textContent = disk.mount;
      row.querySelector("strong")!.title = disk.device;
      row.querySelector("span")!.textContent = percent(value);
      row.querySelector<HTMLElement>("i")!.style.width =
        Math.min(100, value || 0) + "%";
      row.querySelector("small")!.textContent =
        `${bytes(disk.used)} / ${bytes(disk.total)} · 可用 ${bytes(disk.available)}`;
    }
    for (const [key, row] of this.disks)
      if (!sample.disks.some((disk) => disk.mount === key)) {
        row.remove();
        this.disks.delete(key);
      }
    const gpuStatus = this.root.querySelector<HTMLElement>(".ssh-gpu-status")!;
    const gpuStale =
      !sample.gpuAt ||
      sample.timestamp - sample.gpuAt > 3000 ||
      sample.gpuState !== "live";
    gpuStatus.textContent = gpuStale
      ? sample.gpuError ||
        (sample.gpuState === "starting"
          ? "正在等待 NVIDIA 数据…"
          : "NVIDIA 采样暂不可用")
      : `${sample.gpus.length} 台设备 · nvidia-smi`;
    gpuStatus.dataset.stale = String(gpuStale);
    const overview = this.root.querySelector(".ssh-gpu-overview")!;
    for (const gpu of sample.gpus) {
      let row = this.overview.get(gpu.uuid);
      if (!row) {
        row = document.createElement("button"); row.setAttribute("type", "button");
        row.className = "ssh-gpu-overview-row";
        row.innerHTML = '<span></span><strong></strong><span></span><i aria-hidden="true"></i>';
        row.addEventListener("click", () => this.gpus.get(gpu.uuid)?.root.scrollIntoView({ block: "nearest", behavior: this.reduced() ? "instant" : "smooth" }), { signal: this.abort.signal });
        this.overview.set(gpu.uuid, row); overview.append(row);
      }
      row.dataset.tone = tone(gpu.utilization);
      row.children[0].textContent = String(gpu.index).padStart(2, "0");
      row.children[1].textContent = gpu.name;
      row.children[2].textContent = percent(gpu.utilization);
      row.title = `GPU ${gpu.index} · 显存 ${bytes(gpu.memoryUsed)} / ${bytes(gpu.memoryTotal)} · ${unit(gpu.temperature, " °C")}`;
      row.style.setProperty("--gpu-load", Math.max(0, Math.min(100, gpu.utilization || 0)) + "%");
    }
    for (const [key, row] of this.overview) if (!sample.gpus.some(gpu => gpu.uuid === key)) { row.remove(); this.overview.delete(key); }
    for (const gpu of sample.gpus)
      this.renderGpu(gpu, state, gpuStale, animate);
    for (const [key, view] of this.gpus)
      if (!sample.gpus.some((gpu) => gpu.uuid === key)) {
        view.usage.dispose();
        view.memory.dispose();
        view.root.remove();
        this.gpus.delete(key);
      }
    this.root.querySelector(".ssh-monitor-errors")!.textContent = (
      sample.errors || []
    ).join(" · ");
  }
  private renderGpu(
    gpu: GPU,
    state: ServicesState,
    stale: boolean,
    animated: boolean,
  ) {
    let view = this.gpus.get(gpu.uuid);
    if (!view) {
      const root = document.createElement("section");
      root.className = "ssh-gpu";
      root.innerHTML = `<header><span></span><strong></strong></header><div class="ssh-gpu-readings"><div><small>GPU 占用</small><div class="ssh-gpu-usage ssh-metric-value"></div></div><div><small>显存占用</small><div class="ssh-gpu-memory ssh-metric-value"></div></div></div>${chart}<div class="ssh-gpu-vram"></div><div class="ssh-gpu-thermals"></div><details class="ssh-gpu-processes"><summary></summary><div class="ssh-gpu-process-list"></div></details>`;
      view = {
        root,
        usage: new Reading(root.querySelector(".ssh-gpu-usage")!),
        memory: new Reading(root.querySelector(".ssh-gpu-memory")!),
        processes: new Map(),
      };
      this.gpus.set(gpu.uuid, view);
      this.root.querySelector(".ssh-monitor-gpus")!.append(root);
      root.querySelector("details")!.addEventListener("toggle", () => {
        const latest = this.state?.sample?.gpus.find(item => item.uuid === gpu.uuid);
        if (latest && this.visible && !document.hidden) this.renderProcesses(latest, this.gpus.get(gpu.uuid)!);
      }, { signal: this.abort.signal });
    }
    const root = view.root;
    root.dataset.stale = String(stale);
    root.dataset.tone = tone(gpu.utilization);
    root.title = gpu.uuid;
    root.querySelector("header span")!.textContent = String(gpu.index).padStart(
      2,
      "0",
    );
    root.querySelector("header strong")!.textContent = gpu.name;
    view.usage.set(gpu.utilization, animated);
    view.memory.set(ratio(gpu.memoryUsed, gpu.memoryTotal), animated);
    root
      .querySelector("svg")!
      .setAttribute("aria-label", `GPU ${gpu.index} 占用，最近五分钟`);
    root.querySelector(".ssh-trend-line")!.setAttribute(
      "d",
      trendPath(
        state.history,
        (point) =>
          point.gpus.find((item) => item.uuid === gpu.uuid)?.utilization ??
          null,
        state.receivedAt,
      ),
    );
    root.querySelector(".ssh-gpu-vram")!.textContent =
      `${bytes(gpu.memoryUsed)} / ${bytes(gpu.memoryTotal)}`;
    root.querySelector(".ssh-gpu-thermals")!.textContent =
      `${unit(gpu.temperature, " °C")} · ${unit(gpu.power, " W")} / ${unit(gpu.powerLimit, " W")} · 风扇 ${percent(gpu.fan)}`;
    root.querySelector("summary")!.textContent =
      `GPU 进程 / ${gpu.processes.length}`;
    this.renderProcesses(gpu, view);
  }
  private renderProcesses(gpu: GPU, view: GpuView) {
    const root = view.root;
    if (!root.querySelector<HTMLDetailsElement>("details")!.open) return;
    const keys = new Set<string>();
    for (const process of gpu.processes) {
      const key = `${process.pid}:${process.type}:${process.name}`;
      keys.add(key);
      let row = view.processes.get(key);
      if (!row) {
        row = document.createElement("div");
        row.className = "ssh-gpu-process";
        row.innerHTML = "<span></span><strong></strong><span></span>";
        view.processes.set(key, row);
        root.querySelector(".ssh-gpu-process-list")!.append(row);
      }
      row.children[0].textContent = String(process.pid);
      row.children[1].textContent = process.name;
      row.children[2].textContent = bytes(process.memory);
      row.title = `${process.name} · ${process.type}`;
    }
    for (const [key, row] of view.processes)
      if (!keys.has(key)) {
        row.remove();
        view.processes.delete(key);
      }
  }
  dispose() {
    clearInterval(this.staleTimer);
    this.abort.abort();
    this.motion.cancel();
    this.cpu.dispose();
    this.memory.dispose();
    for (const gpu of this.gpus.values()) {
      gpu.usage.dispose();
      gpu.memory.dispose();
    }
  }
}
