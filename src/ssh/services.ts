export type ServiceResult<T = unknown> = {
  ok: boolean;
  result?: T;
  error?: string;
  canceled?: boolean;
};
export type Capability = {
  state: string;
  message: string;
  home?: string;
  pid?: number;
  cache?: string;
};
export type RemoteEntry = {
  name: string;
  path: string;
  kind: "file" | "directory" | "link" | "special";
  size: number;
  modified: number;
  permissions: string;
};
export type DirectoryPage = {
  path: string;
  entries: RemoteEntry[];
  total: number;
  cursor: string;
};
export type TransferJob = {
  id: string;
  direction: "upload" | "download";
  name: string;
  source: string;
  destination: string;
  state:
    | "queued"
    | "scanning"
    | "transferring"
    | "committing"
    | "conflict"
    | "completed"
    | "failed"
    | "canceled"
    | "uncertain";
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  skipped: number;
  rate: number;
  error?: string;
  recoveryPaths?: string[];
  retried?: boolean;
  retryable?: boolean;
  conflict?: {
    id: string;
    path: string;
    directory: boolean;
    sourceSize: number;
    existingSize: number;
  } | null;
};
export type GPUProcess = {
  pid: number;
  name: string;
  type: string;
  memory: number | null;
  gpu: string;
};
export type GPU = {
  uuid: string;
  index: number;
  name: string;
  utilization: number | null;
  memoryUsed: number | null;
  memoryTotal: number | null;
  temperature: number | null;
  power: number | null;
  powerLimit: number | null;
  fan: number | null;
  processes: GPUProcess[];
};
export type HostSnapshot = {
  sequence: number;
  timestamp: number;
  hostname: string;
  uptime: number;
  cpu: { usage: number | null; cores: number; load: number[] } | null;
  memory: {
    total: number;
    used: number;
    available: number;
    swapTotal: number;
    swapUsed: number;
  } | null;
  disks: {
    mount: string;
    device: string;
    total: number;
    used: number;
    available: number;
  }[];
  diskIO: { read: number | null; write: number | null };
  networks: { name: string; receive: number | null; send: number | null }[];
  gpus: GPU[];
  gpuAt: number;
  gpuState: string;
  gpuError?: string;
  errors?: string[];
};
export type HistoryPoint = {
  timestamp: number;
  receivedAt: number;
  cpu: number | null;
  memory: number | null;
  gpus: {
    uuid: string;
    utilization: number | null;
    memoryUsed: number | null;
  }[];
};
export type AuxiliaryAuthRequest = {
  id: string;
  connection: string;
  source: "sftp" | "monitor" | "tunnel";
  kind: "password" | "passphrase" | "hostkey" | "verification-code";
  prompt: string;
  fingerprint: string;
  diagnostics: string;
  canRemember?: boolean;
};
export type ServicesState = {
  sessionId: string;
  active: boolean;
  sftp: Capability;
  monitor: Capability;
  jobs: TransferJob[];
  tunnels?: TunnelState[];
  sample: HostSnapshot | null;
  receivedAt: number;
  history: HistoryPoint[];
  prompt: AuxiliaryAuthRequest | null;
};
export type ServicesEvent =
  | { sessionId: string; event: "snapshot" | "stopped"; data: ServicesState }
  | {
      sessionId: string;
      event: "capability";
      data: Capability & { service: "sftp" | "monitor" };
    }
  | {
      sessionId: string;
      event: "sample";
      data: { sample: HostSnapshot; receivedAt: number };
    }
  | { sessionId: string; event: "transfer"; data: TransferJob }
  | { sessionId: string; event: "tunnel"; data: TunnelState }
  | { sessionId: string; event: "credential-error"; data: { message: string } }
  | { sessionId: string; event: "auth"; data: AuxiliaryAuthRequest | null };
export type ServicesBridge = {
  snapshot(sessionId?: string): Promise<ServiceResult<ServicesState | null>>;
  answer(request: {
    sessionId: string;
    id: string;
    value: string;
    canceled?: boolean;
    remember?: boolean;
  }): Promise<ServiceResult>;
  onEvent(listener: (event: ServicesEvent) => void): () => void;
};
type SessionRequest = { sessionId: string };
export type RemoteTextDocument = { path: string; text: string; revision: string; modified: number; permissions: string };
export type SftpBridge = {
  readText(request: SessionRequest & { path: string }): Promise<ServiceResult<RemoteTextDocument>>;
  writeText(request: SessionRequest & { path: string; text: string; revision: string }): Promise<ServiceResult<{ saved: boolean; conflict?: boolean; document: RemoteTextDocument }>>;
  list(
    request: SessionRequest & { path: string; cursor?: string },
  ): Promise<ServiceResult<DirectoryPage>>;
  stat(
    request: SessionRequest & { path: string },
  ): Promise<
    ServiceResult<{
      entry: RemoteEntry;
      linkTarget?: string;
      targetKind?: RemoteEntry["kind"];
    }>
  >;
  mkdir(request: SessionRequest & { path: string }): Promise<ServiceResult>;
  rename(
    request: SessionRequest & { path: string; destination: string },
  ): Promise<ServiceResult>;
  remove(
    request: SessionRequest & { paths: string[]; recursive: boolean },
  ): Promise<
    ServiceResult<{
      removed: string[];
      errors: { path: string; error: string }[];
    }>
  >;
  upload(
    request: SessionRequest & { destination: string; directory?: boolean },
  ): Promise<ServiceResult<TransferJob[]>>;
  uploadDropped(
    sessionId: string,
    files: File[],
    destination: string,
  ): Promise<ServiceResult<TransferJob[]>>;
  download(
    request: SessionRequest & { paths: string[] },
  ): Promise<ServiceResult<TransferJob[]>>;
  cancel(request: SessionRequest & { id: string }): Promise<ServiceResult>;
  retry(
    request: SessionRequest & { id: string },
  ): Promise<ServiceResult<TransferJob[]>>;
  conflict(
    request: SessionRequest & {
      id: string;
      conflictId: string;
      choice: string;
      all: boolean;
    },
  ): Promise<ServiceResult>;
  reconnect(request: SessionRequest): Promise<ServiceResult>;
};
export type MonitorBridge = {
  retry(request: SessionRequest): Promise<ServiceResult>;
};
export type TunnelState = { id: string; name: string; state: "listening" | "closed"; localAddress: string; host: string; port: number; connections: number; error?: string };
export type TunnelsBridge = {
  list(request: SessionRequest): Promise<ServiceResult<TunnelState[]>>;
  start(request: SessionRequest & { name: string; host: string; port: number; localPort: number }): Promise<ServiceResult<TunnelState>>;
  stop(request: SessionRequest & { id: string }): Promise<ServiceResult>;
};

export class SshServicesClient {
  private value: ServicesState | null = null;
  private listeners = new Set<
    (state: ServicesState | null, event?: ServicesEvent) => void
  >();
  private off: (() => void) | undefined;
  private revision = 0;
  private ownerId = "";
  readonly available = Boolean(
    window.rhineDesktop?.services && window.rhineDesktop?.sftp,
  );
  constructor(private owner?: () => string) {
    const bridge = window.rhineDesktop?.services;
    if (!bridge) return;
    this.off = bridge.onEvent((event) => this.receive(event));
    if (owner && !owner()) return;
    const revision = this.revision;
    void bridge
      .snapshot(owner?.())
      .then((result) => {
        if (revision === this.revision && result.ok && result.result) {
          this.receive({
            sessionId: result.result.sessionId,
            event: "snapshot",
            data: result.result,
          });
        }
      })
      .catch(() => {});
  }
  get state() {
    return this.value;
  }
  refreshOwner() {
    if (!this.owner) return;
    const id = this.owner();
    if (id === this.ownerId) return;
    this.ownerId = id;
    this.value = null;
    const revision = ++this.revision;
    for (const listener of this.listeners) listener(null);
    if (!id) return;
    void window.rhineDesktop?.services?.snapshot(id).then(result => {
      if (revision === this.revision && this.owner?.() === id && result.ok && result.result)
        this.receive({ sessionId: id, event: "snapshot", data: result.result });
    }).catch(() => {});
  }
  get sessionId() {
    return this.value?.sessionId ?? "";
  }
  get files() {
    return window.rhineDesktop?.sftp;
  }
  onChange(
    listener: (state: ServicesState | null, event?: ServicesEvent) => void,
  ) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private receive(event: ServicesEvent) {
    if (this.owner && event.sessionId !== this.owner()) return;
    this.revision++;
    if (event.event === "snapshot") this.value = event.data;
    else {
      if (!this.value || this.value.sessionId !== event.sessionId) return;
      switch (event.event) {
        case "stopped":
          this.value = event.data;
          break;
        case "capability":
          this.value[event.data.service] = event.data;
          break;
        case "auth":
          this.value.prompt = event.data;
          break;
        case "tunnel": {
          const rows = this.value.tunnels ??= [];
          const index = rows.findIndex(row => row.id === event.data.id);
          if (index < 0) rows.push(event.data); else rows[index] = event.data;
          break;
        }
        case "transfer": {
          const index = this.value.jobs.findIndex(
            (job) => job.id === event.data.id,
          );
          if (index >= 0) this.value.jobs[index] = event.data;
          else this.value.jobs.push(event.data);
          break;
        }
        case "sample": {
          const { sample, receivedAt } = event.data;
          this.value.sample = sample;
          this.value.receivedAt = receivedAt;
          this.value.history.push({
            timestamp: sample.timestamp,
            receivedAt,
            cpu: sample.cpu?.usage ?? null,
            memory: sample.memory?.total
              ? (sample.memory.used / sample.memory.total) * 100
              : null,
            gpus: sample.gpus.map((gpu) => ({
              uuid: gpu.uuid,
              utilization: gpu.utilization,
              memoryUsed: gpu.memoryUsed,
            })),
          });
          if (this.value.history.length > 300)
            this.value.history.splice(0, this.value.history.length - 300);
          break;
        }
      }
    }
    for (const listener of this.listeners) listener(this.value, event);
  }
  answer(
    value: string,
    canceled = false,
    expected?: { id: string; sessionId: string },
    remember = false,
  ) {
    const prompt = this.value?.prompt;
    if (
      !prompt ||
      (expected &&
        (expected.id !== prompt.id || expected.sessionId !== this.sessionId))
    )
      return Promise.resolve({ ok: false, error: "认证请求已结束" });
    return window.rhineDesktop!.services!.answer({
      sessionId: this.sessionId,
      id: prompt.id,
      value,
      canceled,
      remember,
    });
  }
  retryMonitor() {
    return window.rhineDesktop?.monitor?.retry({ sessionId: this.sessionId });
  }
  dispose() {
    this.off?.();
    this.listeners.clear();
    this.value = null;
  }
}

export const bytes = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value < 1024) return Math.round(value) + " B";
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let n = value / 1024,
    index = 0;
  while (n >= 1024 && index < units.length - 1) {
    n /= 1024;
    index++;
  }
  return n.toFixed(n >= 100 ? 0 : 1) + " " + units[index];
};
export const percent = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value)
    ? "—"
    : Math.min(100, Math.max(0, value)).toFixed(0) + "%";
export const remoteJoin = (directory: string, name: string) =>
  directory.replace(/\/$/, "") + "/" + name;
export const remoteParent = (directory: string) =>
  directory.slice(0, directory.lastIndexOf("/")) || "/";
