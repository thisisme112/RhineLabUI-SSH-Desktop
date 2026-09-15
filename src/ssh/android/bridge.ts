import { AndroidSshSession, type AuthRequest, type HostKey, type SessionEvent, type ConnectOptions } from "./session";
import { createCapacitorPipe, nativeBackground } from "./pipe";
import { AndroidHostStore, credentialIdentity, normalizeProfile, type HostProfile } from "./store";
import { credentialVault, encryptedStore } from "./vault";
import { documents } from "./documents";
import { androidMigration } from "./migration";
import type { DesktopSessionsBridge, SessionEnvelope } from "../session-bridge";
import type { SshHostProfile, SshKeyEntry, SshPrompt, SshTraffic, SshExitInfo, SessionRecordSummary, CredentialState, SshLaunchDescriptor } from "../client";
import type { SshEvent, SshEventName } from "../events";
import type { SessionRecord } from "../audit";
import type { Capability, HostSnapshot, ServicesState, ServicesEvent, TransferJob, ServiceResult, SftpBridge, TunnelState } from "../services";

class Signal<T> {
  private listeners = new Set<(value: T) => void>();
  on = (listener: (value: T) => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  emit(value: T) { for (const listener of this.listeners) listener(value); }
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const attempt = async <T>(run: () => Promise<T>): Promise<ServiceResult<T>> => {
  try { return { ok: true, result: await run() }; } catch (error) { return { ok: false, error: errorText(error) }; }
};
const aliasOf = (host: HostProfile) => "rhine-profile:" + host.id;
const profileOf = (host: HostProfile): SshHostProfile => ({ id: host.id, name: host.name, hostname: host.host, user: host.user, port: host.port,
  authMode: host.method === "publickey" ? "key" : host.method === "keyboard-interactive" ? "auto" : "password", keyId: host.keyId,
  jumpHost: host.jumpHost, connectTimeout: host.connectTimeout, keepAliveInterval: host.keepAliveInterval, keepAliveCountMax: host.keepAliveCountMax });
const stagedIdentity = (host: HostProfile) => JSON.stringify(["rhine-android-credential-pending-v1", host.id, host.host, host.port, host.user, host.method, host.keyId || ""]);
const boundIdentity = (host: HostProfile, key: HostKey) => host.keyId ? credentialIdentity(host, key) + ":" + host.keyId : credentialIdentity(host, key);
const keyIdentity = (id: string) => "rhine-android-key-v1:" + id;
const KEY_META = "rhine.android.keys.v1", HISTORY = "rhine.android.history.v1";
const boundedText = (value: unknown, limit: number): value is string => typeof value === "string" && value.length <= limit && !value.includes("\0");
function validKey(value: unknown): value is SshKeyEntry {
  if (!value || typeof value !== "object") return false;
  const key = value as SshKeyEntry;
  return boundedText(key.id, 128) && Boolean(key.id) && boundedText(key.name, 100) &&
    key.source === "import" && boundedText(key.type, 100) && boundedText(key.fingerprint, 256) && typeof key.protected === "boolean";
}
function validHistory(value: unknown): value is SessionRecordSummary {
  if (!value || typeof value !== "object") return false;
  const row = value as SessionRecordSummary;
  return boundedText(row.id, 128) && Boolean(row.id) && row.file === row.id && boundedText(row.target, 1024) &&
    (row.targetLabel === undefined || boundedText(row.targetLabel, 1024)) && boundedText(row.startedAt, 40) && Number.isFinite(Date.parse(row.startedAt)) &&
    Number.isFinite(row.durationMs) && row.durationMs >= 0 && boundedText(row.outcome, 100) && boundedText(row.summary, 4096) &&
    Number.isSafeInteger(row.bytesIn) && row.bytesIn >= 0 && Number.isSafeInteger(row.bytesOut) && row.bytesOut >= 0 &&
    (row.exitCode === null || Number.isSafeInteger(row.exitCode)) && boundedText(row.logPath, 4096);
}
type Connection = {
  id: string; agent: AndroidSshSession; profile?: HostProfile; started: number; stopped: boolean; interactive: boolean;
  bytesIn: number; bytesOut: number; lines: number; decoder: TextDecoder; off?: () => void;
  prompt?: { id: number; answer(value: string, remember: boolean): Promise<void> }; promptId: number;
  state: ServicesState; auth?: AuthRequest; remember: boolean; key?: HostKey; cols: number; rows: number;
  failedCredential: boolean; trafficTimer?: number; resizeTimer?: number; route?: string[]; autoAnswered?: boolean;
  writes: Promise<void>;
  hops?: { profile: HostProfile; auth: AuthRequest; key?: HostKey; remember: boolean; autoAnswered?: boolean }[];
};

/** Android supplies only transport and OS operations. The renderer, animation,
 * session tabs, SFTP and monitoring UI are shared with the desktop app. */
export async function initAndroidBridge() {
  const hosts = new AndroidHostStore();
  const connections = new Map<string, Connection>();
  const data = new Signal<SessionEnvelope<string>>(), log = new Signal<SessionEnvelope<string>>();
  const protocol = new Signal<SessionEnvelope<SshEvent>>(), prompts = new Signal<SessionEnvelope<SshPrompt | null>>();
  const traffic = new Signal<SessionEnvelope<SshTraffic>>(), exits = new Signal<SessionEnvelope<SshExitInfo>>();
  const serviceEvents = new Signal<ServicesEvent>();
  let keys: SshKeyEntry[] = [], history: SessionRecordSummary[] = [], keysProblem = "", historyProblem = "";
  const available = await credentialVault.available();
  try {
    const raw = localStorage.getItem(KEY_META);
    if (raw) { const parsed = JSON.parse(raw); if (parsed.version !== 1 || !Array.isArray(parsed.keys) || parsed.keys.length > 256 || !parsed.keys.every(validKey) || new Set(parsed.keys.map((key: SshKeyEntry) => key.id)).size !== parsed.keys.length) throw new Error(); keys = parsed.keys; }
  } catch { keysProblem = "密钥目录无法读取，原数据已保留"; }
  try {
    const raw = localStorage.getItem(HISTORY);
    if (raw) { const parsed = JSON.parse(raw); if (parsed.version !== 1 || !Array.isArray(parsed.records) || parsed.records.length > 1000 || !parsed.records.every(validHistory) || new Set(parsed.records.map((row: SessionRecordSummary) => row.id)).size !== parsed.records.length) throw new Error(); history = parsed.records; }
  } catch { historyProblem = "会话历史无法读取，原数据已保留"; }
  const findHost = (alias: string) => hosts.host(alias.replace(/^rhine-profile:/, ""));
  const requireHost = (alias: string) => { const host = findHost(alias); if (!host) throw new Error("主机档案不存在"); return host; };
  const activeHost = (id: string) => [...connections.values()].some(c => !c.stopped && (c.profile?.id === id || c.route?.includes(id)));
  const revision = () => JSON.stringify(hosts.hosts);
  const get = (id: string) => { const c = connections.get(id); if (!c || c.stopped) throw new Error("会话已结束"); return c; };
  const emitServices = (event: ServicesEvent) => serviceEvents.emit(structuredClone(event));
  const fact = (c: Connection, name: SshEventName, detail: Record<string, string>, raw: string) => {
    if (c.stopped) return;
    c.lines++; protocol.emit({ sessionId: c.id, data: { name, detail, raw } });
  };
  const reportTraffic = (c: Connection) => traffic.emit({ sessionId: c.id, data: { bytesIn: c.bytesIn, bytesOut: c.bytesOut, logLines: c.lines, elapsedMs: Date.now() - c.started } });
  const failCredential = async (c: Connection) => {
    if (!c.profile || !c.auth) return;
    const identity = c.key ? boundIdentity(c.profile, c.key) : stagedIdentity(c.profile);
    await encryptedStore.put(identity + ":failed", true).catch(() => {});
  };
  const finish = (c: Connection, code: number | null) => {
    if (c.stopped) return;
    c.stopped = true; clearInterval(c.trafficTimer); clearTimeout(c.resizeTimer); c.prompt = undefined;
    const tail = c.decoder.decode(); if (tail) data.emit({ sessionId: c.id, data: tail });
    prompts.emit({ sessionId: c.id, data: null }); reportTraffic(c);
    c.state.active = false; c.state.prompt = null;
    c.state.sftp = { state: "closed", message: "会话已结束" }; c.state.monitor = { state: "closed", message: "会话已结束" };
    for (const tunnel of c.state.tunnels || []) { tunnel.state = "closed"; tunnel.connections = 0; }
    for (const job of c.state.jobs) if (["queued", "scanning", "transferring", "committing", "conflict"].includes(job.state)) { job.state = "canceled"; job.error = "会话已结束"; }
    emitServices({ sessionId: c.id, event: "stopped", data: c.state });
    exits.emit({ sessionId: c.id, data: { exitCode: code, logPath: "", bytesIn: c.bytesIn, bytesOut: c.bytesOut, logLines: c.lines, elapsedMs: Date.now() - c.started } });
    c.auth = undefined; c.hops = undefined; c.off?.(); void c.agent.stop().finally(() => cleanupUploads(c, true));
  };
  await nativeBackground.onDisconnect(() => {
    for (const c of connections.values()) if (!c.stopped) finish(c, 0);
  });
  await nativeBackground.onError(event => { for (const c of connections.values()) if (!c.stopped) emitServices({ sessionId: c.id, event: "credential-error", data: { message: event.message } }); });
  const ask = (c: Connection, request: Omit<SshPrompt, "id">, answer: (value: string, remember: boolean) => Promise<void>) => {
    if (c.stopped) return;
    const id = ++c.promptId; c.prompt = { id, answer };
    prompts.emit({ sessionId: c.id, data: { ...request, id } as SshPrompt });
  };
  const savedAuth = async (host: HostProfile, includeRestricted = false) => {
    const key = hosts.key(host);
    for (const identity of [key ? boundIdentity(host, key) : "", stagedIdentity(host)]) {
      if (!identity) continue;
      if (!includeRestricted) {
        if (await encryptedStore.get<boolean>(identity + ":failed")) continue;
        const fingerprint = await encryptedStore.get<string>(identity + ":fingerprint");
        if (fingerprint && fingerprint !== key?.fingerprint) continue;
      }
      const value = await credentialVault.get(identity); if (value) return value;
    }
  };
  const persistAuth = async (c: Connection) => {
    if (!c.remember || !c.profile || !c.key || !c.auth || c.auth.method === "keyboard-interactive") return;
    const identity = boundIdentity(c.profile, c.key);
    await credentialVault.put(identity, c.auth);
    await encryptedStore.remove(identity + ":failed");
    await credentialVault.remove(stagedIdentity(c.profile));
    await encryptedStore.remove(stagedIdentity(c.profile) + ":fingerprint");
  };
  const downloads = new Map<string, { uri: string; root: string }>();
  const uploads = new Set<{ sessionId: string; root: string; jobs?: string[] }>();
  const publishing = new Set<string>();
  const published = new Set<string>();
  async function cleanupUploads(c: Connection, ended = false) {
    for (const batch of uploads) {
      if (batch.sessionId !== c.id || !ended && (!batch.jobs || !batch.jobs.every(id => c.state.jobs.some(job => job.id === id && job.state === "completed")))) continue;
      uploads.delete(batch);
      await documents.cleanup({ path: batch.root }).catch(() => {});
    }
  }
  async function handleService(c: Connection, event: Extract<SessionEvent, { kind: "service" }>) {
    if (c.stopped) return;
    if (event.event === "capability") {
      const value = event.data as Capability & { service: "sftp" | "monitor" };
      if (!["sftp", "monitor"].includes(value.service)) return;
      c.state[value.service] = value; emitServices({ sessionId: c.id, event: "capability", data: value });
    } else if (event.event === "sample") {
      const sample = event.data as HostSnapshot, receivedAt = Date.now();
      c.state.sample = sample; c.state.receivedAt = receivedAt;
      c.state.history.push({ timestamp: sample.timestamp, receivedAt, cpu: sample.cpu?.usage ?? null, memory: sample.memory?.total ? sample.memory.used / sample.memory.total * 100 : null,
        gpus: (sample.gpus ?? []).map(g => ({ uuid: g.uuid, utilization: g.utilization, memoryUsed: g.memoryUsed })) });
      c.state.history = c.state.history.slice(-300);
      emitServices({ sessionId: c.id, event: "sample", data: { sample, receivedAt } });
    } else if (event.event === "tunnel") {
      const tunnel = event.data as TunnelState, rows = c.state.tunnels ??= [];
      const index = rows.findIndex(row => row.id === tunnel.id); if (index < 0) rows.push(tunnel); else rows[index] = tunnel;
      emitServices({ sessionId: c.id, event: "tunnel", data: tunnel });
    } else if (event.event === "transfer") {
      let job = event.data as TransferJob;
      const target = downloads.get(job.id);
      if (target && job.state === "completed") {
        if (publishing.has(job.id) || published.has(job.id)) return;
        publishing.add(job.id);
        emitJob(c, { ...job, state: "committing", error: "正在保存到手机目录" });
        try {
          await documents.publish({ path: job.destination, uri: target.uri }); published.add(job.id);
          await documents.cleanup({ path: job.destination }).catch(() => {});
          job = { ...job, destination: "所选手机目录 / " + job.name };
        }
        catch (error) { job = { ...job, state: "failed", error: errorText(error), recoveryPaths: [job.destination], retryable: true }; }
        publishing.delete(job.id);
      }
      emitJob(c, job);
      if (job.direction === "upload" && job.state === "completed") await cleanupUploads(c);
    }
  }
  function emitJob(c: Connection, job: TransferJob) {
    const index = c.state.jobs.findIndex(j => j.id === job.id);
    if (index < 0) c.state.jobs.push(job); else c.state.jobs[index] = job;
    emitServices({ sessionId: c.id, event: "transfer", data: job });
  }
  const receive = (c: Connection, event: SessionEvent) => {
    if (c.stopped) return;
    const hop = "hop" in event && event.hop !== undefined ? c.hops?.[event.hop] : undefined;
    const host = hop?.profile || c.profile;
    if (event.kind === "service") { void handleService(c, event).catch(error => log.emit({ sessionId: c.id, data: errorText(error) })); return; }
    if (event.kind === "data") { c.bytesIn += event.bytes.byteLength; data.emit({ sessionId: c.id, data: c.decoder.decode(event.bytes, { stream: true }) }); return; }
    if (event.kind === "exit") { finish(c, event.code); return; }
    if (event.kind === "error") { log.emit({ sessionId: c.id, data: event.message }); return; }
    if (!host) return;
    if (event.kind === "hop") {
      log.emit({ sessionId: c.id, data: `跳板 ${host.name} / ${event.phase}: ${event.detail}` });
      if (hop && event.phase === "failed" && /authenticat|permission denied/i.test(event.detail)) {
        c.failedCredential = true; void failCredential({ ...c, ...hop });
      }
      if (hop && event.phase === "opening") {
        hop.key ??= hosts.key(host);
        void persistAuth({ ...c, ...hop }).catch(error => emitServices({ sessionId: c.id, event: "credential-error", data: { message: errorText(error) } }));
      }
      return;
    }
    if (event.kind === "hostkey") {
      const key = { keyType: event.keyType, fingerprint: event.fingerprint };
      if (hop) hop.key = key;
      if (!event.intermediate) {
        c.key = key;
        fact(c, "hostkey.received", { type: event.keyType, fingerprint: event.fingerprint }, JSON.stringify({ event: "hostkey", keyType: event.keyType, fingerprint: event.fingerprint }));
        fact(c, "hostkey.unknown", {}, "首次连接，等待确认主机指纹");
      }
      ask(c, { kind: "hostkey", prompt: `确认${event.intermediate ? "跳板机 " : "主机 "}${host.name} (${host.host}:${host.port}) 的密钥？\n${event.keyType}\n${event.fingerprint}`, host: host.host } as Omit<SshPrompt, "id">, async value => {
        if (value === "yes") { hosts.trust(host, key); event.accept(); } else event.reject();
      }); return;
    }
    if (event.kind === "prompt") {
      const owner = hop || c;
      if (!owner.autoAnswered && event.promptKind !== "verification-code") {
        owner.autoAnswered = true;
        void savedAuth(host).then(saved => {
          if (c.stopped) return;
          const value = event.promptKind === "password" && saved?.method === "password" ? saved.password : event.promptKind === "passphrase" && saved?.method === "publickey" ? saved.passphrase : undefined;
          if (value !== undefined) { owner.auth = saved; owner.remember = true; if (host.id === c.profile?.id) { c.auth = saved; c.remember = true; } event.answer(value); }
          else receive(c, event);
        }).catch(() => receive(c, event));
        return;
      }
      ask(c, { kind: event.promptKind, prompt: `${host.name} / ${host.user}@${host.host}\n${event.prompt}`, host: host.host, key: host.name, canRemember: available && event.promptKind !== "verification-code" } as Omit<SshPrompt, "id">, async (value, remember) => {
        const auth = event.promptKind === "password" ? { method: "password" as const, password: value } : hop?.auth || c.auth;
        if (event.promptKind === "passphrase" && auth?.method === "publickey") auth.passphrase = value;
        if (hop && auth) { hop.auth = auth; hop.remember = remember; }
        if (host.id === c.profile?.id) { c.auth = auth; c.remember = remember; }
        event.answer(value);
      }); return;
    }
    const raw = JSON.stringify({ event: "phase", phase: event.phase, detail: event.detail });
    switch (event.phase) {
      case "connecting": fact(c, "tcp.connecting", { host: host.host, port: String(host.port) }, raw); break;
      case "handshake": fact(c, "tcp.established", {}, raw); break;
      case "authenticating":
        c.key ??= hosts.key(host);
        if (c.key) fact(c, "hostkey.received", { type: c.key.keyType, fingerprint: c.key.fingerprint }, raw);
        fact(c, "hostkey.verified", {}, raw); fact(c, "auth.offering", { method: host.method }, raw); break;
      case "opening":
        fact(c, "auth.succeeded", { method: host.method }, raw); fact(c, "session.entering", {}, raw);
        void persistAuth(c).catch(error => emitServices({ sessionId: c.id, event: "credential-error", data: { message: errorText(error) } })); break;
      case "interactive":
        c.interactive = true; fact(c, "session.authenticated", {}, raw);
        c.state.active = true; emitServices({ sessionId: c.id, event: "snapshot", data: c.state });
        void c.agent.resize(c.cols, c.rows).catch(() => {}); c.auth = undefined; c.hops = undefined; break;
      case "failed": {
        const name: SshEventName = /host key changed/i.test(event.detail) ? "hostkey.mismatch" : /authenticat|permission denied/i.test(event.detail) ? "auth.denied" : "tcp.failed";
        fact(c, name, { reason: event.detail, message: event.detail }, raw);
        if (name === "auth.denied" && !c.failedCredential) void failCredential(c);
        finish(c, null); break;
      }
    }
  };
  const connect = async (c: Connection) => {
    if (!c.profile || !c.auth || c.stopped) return;
    const options = (hop: NonNullable<Connection["hops"]>[number]): ConnectOptions => ({ host: hop.profile.host, port: hop.profile.port, user: hop.profile.user, auth: hop.auth, knownHost: hosts.key(hop.profile), timeoutMs: (hop.profile.connectTimeout || 15) * 1000, keepAliveInterval: hop.profile.keepAliveInterval ?? 30, keepAliveCountMax: hop.profile.keepAliveCountMax ?? 3 });
    const hops = c.hops!;
    await c.agent.connect({ ...options(hops[hops.length - 1]), jumps: hops.slice(0, -1).map(options) });
  };
  const startConnection = async (c: Connection, descriptor: SshLaunchDescriptor) => {
    if (descriptor.extraArgs?.length) throw new Error("安卓不接受系统 SSH 命令行参数");
    const stored = findHost(descriptor.target);
    const split = descriptor.target.lastIndexOf("@");
    c.profile = stored ?? normalizeProfile({ id: c.id, name: descriptor.displayName || descriptor.target, host: descriptor.target.slice(split + 1), user: descriptor.user || (split >= 0 ? descriptor.target.slice(0, split) : ""), port: descriptor.port || 22,
      method: descriptor.authMode === "key" ? "publickey" : descriptor.authMode === "auto" ? "keyboard-interactive" : "password", keyId: descriptor.keyId, jumpHost: descriptor.jumpHost, connectTimeout: descriptor.connectTimeout, keepAliveInterval: descriptor.keepAliveInterval, keepAliveCountMax: descriptor.keepAliveCountMax });
    c.cols = descriptor.cols || 80; c.rows = descriptor.rows || 24;
    await c.agent.start(); if (c.stopped) throw new Error("连接已取消");
    const chain = [c.profile], seen = new Set([c.profile.id]);
    while (chain[0].jumpHost) {
      const jump = findHost(chain[0].jumpHost!);
      if (!jump) throw new Error("跳板机不存在，请从已保存主机中选择");
      if (seen.has(jump.id) || chain.length >= 4) throw new Error("跳板机不能循环引用，最多三层");
      seen.add(jump.id); chain.unshift(jump);
    }
    c.route = chain.map(host => host.id);
    c.hops = [];
    for (const profile of chain) {
      const saved = available ? await savedAuth(profile) : undefined;
      let auth: AuthRequest = saved ?? { method: profile.method === "keyboard-interactive" ? "keyboard-interactive" : "password" };
      if (profile.method === "publickey" && auth.method !== "publickey") {
        const key = keys.find(k => k.id === profile.keyId), secret = key && await encryptedStore.get<{ privateKey: string }>(keyIdentity(key.id));
        if (!key || !secret) throw new Error(`${profile.name}：请先在密钥库导入并关联私钥`);
        auth = { method: "publickey", privateKey: secret.privateKey };
      }
      if (c.stopped) throw new Error("连接已取消");
      c.hops.push({ profile, auth, remember: Boolean(saved), autoAnswered: !!saved, key: hosts.key(profile) });
    }
    const target = c.hops[c.hops.length - 1]; c.auth = target.auth; c.remember = target.remember;
    await connect(c);
  };
  const session: DesktopSessionsBridge = {
    async reserve() {
      if ([...connections.values()].filter(c => !c.stopped).length >= 12) return { ok: false, error: "最多同时打开 12 个连接，请先结束一个会话" };
      const id = crypto.randomUUID(), agent = new AndroidSshSession(createCapacitorPipe());
      const c: Connection = { id, agent, started: Date.now(), stopped: false, interactive: false, bytesIn: 0, bytesOut: 0, lines: 0, decoder: new TextDecoder(), promptId: 0, remember: false, cols: 80, rows: 24, failedCredential: false,
        writes: Promise.resolve(),
        state: { sessionId: id, active: false, sftp: { state: "waiting", message: "等待 SSH 连接" }, monitor: { state: "waiting", message: "等待 SSH 连接" }, jobs: [], sample: null, receivedAt: 0, history: [], prompt: null } };
      c.off = agent.on(event => receive(c, event)); connections.set(id, c); return { ok: true, id };
    },
    async start(descriptor, id) {
      let c: Connection | undefined;
      try {
        c = get(id); await startConnection(c, descriptor);
        if (!c.stopped) c.trafficTimer = window.setInterval(() => reportTraffic(c!), 500);
        return { ok: true, id, startedAt: c.started, argv: ["rhine-session", descriptor.target], logPath: "", file: "rhine-session", displayTarget: descriptor.displayName || c.profile!.name };
      } catch (error) { if (c) finish(c, null); return { ok: false, error: errorText(error) }; }
    },
    write(value, id) { const c = connections.get(id); if (!c?.interactive || c.stopped) return; c.writes = c.writes.then(async () => {
      if (c.stopped) return; await c.agent.write(value); c.bytesOut += new TextEncoder().encode(value).length;
    }).catch(error => log.emit({ sessionId: id, data: errorText(error) })); },
    resize(cols, rows, id) { const c = connections.get(id); if (!c || c.stopped) return; c.cols = cols; c.rows = rows; clearTimeout(c.resizeTimer); c.resizeTimer = window.setTimeout(() => { void c.agent.resize(c.cols, c.rows).catch(() => {}); }, 60); },
    stop(id) { const c = connections.get(id); if (c) finish(c, null); },
    async answer(id, value, owner, remember = false) {
      try { const c = get(owner), pending = c.prompt; if (!pending || pending.id !== id) throw new Error("认证请求已结束"); c.prompt = undefined; prompts.emit({ sessionId: owner, data: null }); await pending.answer(value, remember); return { ok: true }; }
      catch (error) { return { ok: false, error: errorText(error) }; }
    },
    async record(record) {
      try {
        if (historyProblem) throw new Error(historyProblem);
        await encryptedStore.put("rhine-android-record-v1:" + record.id, record);
        history = history.filter(r => r.id !== record.id);
        history.unshift({ file: record.id, id: record.id, target: record.target, targetLabel: record.targetLabel, startedAt: record.startedAt, durationMs: record.durationMs, outcome: record.outcome, summary: record.failure || record.outcome,
          bytesIn: record.traffic.bytesIn, bytesOut: record.traffic.bytesOut, exitCode: record.exitCode, logPath: "" });
        await pruneHistory(); return { ok: true, file: record.id };
      } catch (error) { return { ok: false, error: errorText(error) }; }
    },
    async export(payload) { try { const result = await documents.exportText(payload); return { ok: !result.canceled, ...result }; } catch (error) { return { ok: false, error: errorText(error) }; } },
    onData: data.on, onLog: log.on, onProtocol: protocol.on, onPrompt: prompts.on, onTraffic: traffic.on, onExit: exits.on,
  };
  const rpc = <T>(id: string, method: string, params: Record<string, unknown> = {}) => attempt(() => get(id).agent.rpc<T>(method, params));
  const sftp: SftpBridge = {
    readText: r => rpc(r.sessionId, "readText", r), writeText: r => rpc(r.sessionId, "writeText", r),
    list: r => rpc(r.sessionId, "list", r), stat: r => rpc(r.sessionId, "stat", r), mkdir: r => rpc(r.sessionId, "mkdir", r), rename: r => rpc(r.sessionId, "rename", r),
    remove: r => attempt(async () => { const removed: string[] = [], errors: { path: string; error: string }[] = []; for (const path of r.paths) { const result = await rpc(r.sessionId, "remove", { path, recursive: r.recursive }); if (result.ok) removed.push(path); else errors.push({ path, error: result.error! }); } return { removed, errors }; }),
    async upload(r) {
      try {
        const c = get(r.sessionId), selected = await documents.pickFiles(r);
        if (selected.canceled) return { ok: false, canceled: true };
        if (c.stopped) { await documents.cleanup({ path: selected.root }); throw new Error("会话已结束，请重新选择上传文件"); }
        const batch: { sessionId: string; root: string; jobs?: string[] } = { sessionId: c.id, root: selected.root }; uploads.add(batch);
        const result = await rpc<TransferJob[]>(r.sessionId, "upload", { paths: selected.paths, destination: r.destination });
        if (result.ok) { batch.jobs = (result.result || []).map(job => job.id); await cleanupUploads(c); }
        return result;
      } catch (error) { return { ok: false, error: errorText(error) }; }
    },
    uploadDropped: async () => ({ ok: false, error: "请使用上传按钮选择手机文件" }),
    async download(r) {
      try {
        const target = await documents.downloadTarget(); if (target.canceled) return { ok: false, canceled: true };
        const result = await rpc<TransferJob[]>(r.sessionId, "download", { paths: r.paths, destination: target.directory });
        for (const job of result.result || []) downloads.set(job.id, { uri: target.uri, root: target.directory });
        const c = get(r.sessionId);
        for (const job of result.result || []) { const current = c.state.jobs.find(j => j.id === job.id); if (current?.state === "completed") void handleService(c, { kind: "service", event: "transfer", data: current }); }
        return result;
      } catch (error) { return { ok: false, error: errorText(error) }; }
    },
    cancel: r => rpc(r.sessionId, "cancel", r),
    async retry(r) {
      const c = connections.get(r.sessionId), job = c?.state.jobs.find(j => j.id === r.id), target = downloads.get(r.id);
      if (c && job?.recoveryPaths?.length && target) { void handleService(c, { kind: "service", event: "transfer", data: { ...job, state: "completed", error: undefined, recoveryPaths: undefined } }); return { ok: true, result: [job] }; }
      const result = await rpc<TransferJob[]>(r.sessionId, "retry", r);
      if (target) for (const row of result.result || []) downloads.set(row.id, target);
      if (result.ok && c) {
        for (const batch of uploads) if (batch.sessionId === c.id && batch.jobs?.includes(r.id)) batch.jobs = batch.jobs.filter(id => id !== r.id).concat((result.result || []).map(row => row.id));
        await cleanupUploads(c);
      }
      return result;
    },
    conflict: r => rpc(r.sessionId, "conflict", r), reconnect: r => rpc(r.sessionId, "filesRetry"),
  };
  async function pruneHistory() {
    if (historyProblem) throw new Error(historyProblem);
    const keep = history.filter((r, i) => i < 100 && Date.parse(r.startedAt) > Date.now() - 30 * 86400000);
    const removed = history.filter(r => !keep.includes(r));
    localStorage.setItem(HISTORY, JSON.stringify({ version: 1, records: keep })); history = keep;
    for (const row of removed) await encryptedStore.remove("rhine-android-record-v1:" + row.id);
    return removed.length;
  }
  const credentialState = async (target: string): Promise<CredentialState> => {
    const host = requireHost(target); const auth = available ? await savedAuth(host, true) : undefined;
    const identity = hosts.key(host) ? boundIdentity(host, hosts.key(host)!) : stagedIdentity(host);
    const failed = available && await encryptedStore.get<boolean>(identity + ":failed");
    return { available, password: auth?.method === "password" ? failed ? "needs-update" : "saved" : "none", passphrase: auth?.method === "publickey" && auth.passphrase ? failed ? "needs-update" : "saved" : "none" };
  };
  const pickedKeys = new Map<string, { name: string; content: string }>();
  window.rhineDesktop = {
    isDesktop: false, platform: "android", versions: { electron: "", chrome: "WebView", node: "" }, session, sftp,
    background: nativeBackground,
    migration: androidMigration(hosts, () => keys, savedAuth, stagedIdentity),
    tunnels: { list: r => rpc(r.sessionId, "tunnels"), start: r => rpc(r.sessionId, "startTunnel", r), stop: r => rpc(r.sessionId, "stopTunnel", r) },
    hosts: async () => ({ ok: !hosts.problem, error: hosts.problem, revision: revision(), hosts: hosts.hosts.map(host => ({ alias: aliasOf(host), displayName: host.name, source: "saved", hostname: host.host, user: host.user, port: String(host.port), profile: profileOf(host) })) }),
    hostProfiles: {
      async save(input, expected) {
        try {
          if (expected && expected !== revision()) throw new Error("主机配置已变化，请重新读取后保存");
          if (input.id && activeHost(input.id)) throw new Error("请先结束此主机的活动连接再修改配置");
          if (input.identityFile) throw new Error("安卓请从密钥库选择私钥");
          const seen = new Set([input.id]); let jump = input.jumpHost;
          while (jump) { const hop = findHost(jump); if (!hop || seen.has(hop.id) || seen.size > 3) throw new Error("请选择有效跳板机，最多三层且不能循环引用"); seen.add(hop.id); jump = hop.jumpHost; }
          const host = hosts.save({ id: input.id || crypto.randomUUID(), name: input.name, host: input.hostname, port: input.port || 22, user: input.user || "", method: input.authMode === "key" ? "publickey" : input.authMode === "auto" ? "keyboard-interactive" : "password", keyId: input.authMode === "key" ? input.keyId : undefined, jumpHost: input.jumpHost, connectTimeout: input.connectTimeout, keepAliveInterval: input.keepAliveInterval, keepAliveCountMax: input.keepAliveCountMax });
          return { ok: true, profile: profileOf(host), revision: revision() };
        } catch (error) { return { ok: false, error: errorText(error) }; }
      },
      async remove(id, expected) { try { if (expected && expected !== revision()) throw new Error("主机配置已变化，请重新读取"); if (activeHost(id)) throw new Error("请先结束此主机的活动连接"); hosts.remove(id); return { ok: true }; } catch (error) { return { ok: false, error: errorText(error) }; } },
      async pickIdentity() { try { const result = await documents.pickKey(); if (result.canceled) return { ok: false, canceled: true }; const token = "android-key:" + crypto.randomUUID(); pickedKeys.clear(); pickedKeys.set(token, { name: result.name!, content: result.content! }); return { ok: true, file: token }; } catch (error) { return { ok: false, error: errorText(error) }; } },
    },
    credentials: {
      async status(target) { try { return { ok: true, state: await credentialState(target) }; } catch (error) { return { ok: false, error: errorText(error) }; } },
      async save(r) { try {
        const host = requireHost(r.target); let auth: AuthRequest;
        if (r.kind === "password") auth = { method: "password", password: r.value };
        else { const secret = host.keyId && await encryptedStore.get<{ privateKey: string }>(keyIdentity(host.keyId)); if (!secret) throw new Error("请先选择密钥库中的私钥"); auth = { method: "publickey", privateKey: secret.privateKey, passphrase: r.value }; }
        const key = hosts.key(host), identity = key ? boundIdentity(host, key) : stagedIdentity(host);
        await credentialVault.put(identity, auth); await encryptedStore.remove(identity + ":failed"); return { ok: true, state: await credentialState(r.target) };
      } catch (error) { return { ok: false, error: errorText(error) }; } },
      async remove(r) { try { const host = requireHost(r.target), key = hosts.key(host); if (key) await credentialVault.remove(boundIdentity(host, key)); await credentialVault.remove(stagedIdentity(host)); return { ok: true, state: await credentialState(r.target) }; } catch (error) { return { ok: false, error: errorText(error) }; } },
    },
    keys: {
      list: async () => ({ ok: !keysProblem, error: keysProblem || undefined, keys: keys.map(k => ({ ...k, hosts: hosts.hosts.filter(h => h.keyId === k.id).map(h => h.name) })) }),
      async add(input) {
        const agent = new AndroidSshSession(createCapacitorPipe());
        try {
          if (keysProblem) throw new Error(keysProblem);
          const picked = input.file && pickedKeys.get(input.file); if (input.file) pickedKeys.delete(input.file);
          const content = input.content || (picked && picked.content); if (!content) throw new Error("请选择或粘贴私钥");
          if (keys.length >= 256) throw new Error("密钥库已满");
          await agent.start(); const inspected = await agent.inspectKey(content, input.passphrase);
          const key: SshKeyEntry = { id: crypto.randomUUID(), name: (input.name || (picked && picked.name) || "SSH 私钥").slice(0, 80), source: "import", ...inspected };
          await encryptedStore.put(keyIdentity(key.id), { privateKey: content });
          localStorage.setItem(KEY_META, JSON.stringify({ version: 1, keys: [...keys, key] })); keys.push(key); return { ok: true, key };
        } catch (error) { return { ok: false, error: errorText(error) }; } finally { await agent.stop(); }
      },
      async remove(id) { try { if (keysProblem) throw new Error(keysProblem); if (hosts.hosts.some(h => h.keyId === id)) throw new Error("请先在关联主机中更换此密钥"); await encryptedStore.remove(keyIdentity(id)); keys = keys.filter(k => k.id !== id); localStorage.setItem(KEY_META, JSON.stringify({ version: 1, keys })); return { ok: true }; } catch (error) { return { ok: false, error: errorText(error) }; } },
    },
    services: { snapshot: async id => ({ ok: true, result: id && connections.has(id) ? structuredClone(connections.get(id)!.state) : null }), answer: async () => ({ ok: false, error: "此请求已结束" }), onEvent: serviceEvents.on },
    monitor: { retry: r => rpc(r.sessionId, "monitorRetry") },
    clipboard: { readText: async () => { try { return { ok: true, ...(await documents.readClipboard()) }; } catch (error) { return { ok: false, error: errorText(error) }; } }, writeText: async text => { try { await documents.writeClipboard({ text }); return { ok: true }; } catch (error) { return { ok: false, error: errorText(error) }; } } },
    records: {
      list: async () => ({ ok: !historyProblem, records: history, error: historyProblem || undefined }),
      read: async file => { try { if (!history.some(r => r.id === file)) throw new Error("记录不存在"); const record = await encryptedStore.get<SessionRecord>("rhine-android-record-v1:" + file); return { ok: Boolean(record), record, file }; } catch (error) { return { ok: false, error: errorText(error) }; } },
      log: async file => { const record = history.some(r => r.id === file) && await encryptedStore.get<SessionRecord>("rhine-android-record-v1:" + file); return { ok: Boolean(record), lines: record ? record.facts.map(f => f.source) : [] }; },
      prune: async () => { try { return { ok: true, removed: await pruneHistory(), bytesFreed: 0 }; } catch (error) { return { ok: false, removed: 0, bytesFreed: 0, errors: [errorText(error)] }; } },
    },
  };
  window.addEventListener("pagehide", () => { pickedKeys.clear(); for (const c of connections.values()) finish(c, null); });
}
