import type { AuthRequest, HostKey } from "./session";

export type HostProfile = { id: string; name: string; host: string; port: number; user: string; method: AuthRequest["method"]; keyId?: string; jumpHost?: string; connectTimeout?: number; keepAliveInterval?: number; keepAliveCountMax?: number };
type SavedHostKey = HostKey & { endpoint: string };
type Data = { version: 1; hosts: HostProfile[]; known: SavedHostKey[] };
export const storageKey = "rhine-android-ssh-v1";
const methods = new Set(["password", "publickey", "keyboard-interactive"]);
export function normalizeHost(value: string) {
  const host = value.trim().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "").toLowerCase();
  if (!host || host.length > 253 || /[\s\x00-\x1f\x7f/@?#\\]/.test(host)) throw new Error("请输入主机名或 IP 地址，不包含 ssh://、端口或用户名");
  try {
    const parsed = new URL(`https://${host.includes(":") ? `[${host}]` : host}/`);
    return parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  } catch { throw new Error("主机名或 IP 地址格式不正确"); }
}
export function normalizeProfile(profile: HostProfile): HostProfile {
  const host = normalizeHost(profile.host), user = profile.user.trim(), name = profile.name.trim();
  if (!user || user.length > 128 || /[\x00-\x1f\x7f]/.test(user)) throw new Error("请输入有效的登录用户名");
  if (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) throw new Error("端口应为 1–65535");
  if (!methods.has(profile.method)) throw new Error("请选择认证方式");
  if (name.length > 80 || !profile.id || profile.id.length > 80) throw new Error("主机名称过长");
  if (profile.jumpHost !== undefined && (typeof profile.jumpHost !== "string" || profile.jumpHost.length > 180 || /[\x00-\x1f]/.test(profile.jumpHost))) throw new Error("跳板机档案无效");
  return { id: profile.id, name: name || host, host, port: profile.port, user, method: profile.method,
    ...(typeof profile.keyId === "string" && profile.keyId.length <= 100 ? { keyId: profile.keyId } : {}),
    ...(profile.jumpHost ? { jumpHost: profile.jumpHost } : {}),
    ...Object.fromEntries((["connectTimeout", "keepAliveInterval", "keepAliveCountMax"] as const)
      .filter(key => Number.isInteger(profile[key]) && profile[key]! >= 0 && profile[key]! <= 3600).map(key => [key, profile[key]])),
  };
}
export const endpoint = (host: Pick<HostProfile, "host" | "port">) => JSON.stringify([normalizeHost(host.host), host.port]);
export const credentialIdentity = (host: HostProfile, key: HostKey) => JSON.stringify(["rhine-ssh-v1", host.id, normalizeHost(host.host), host.port, host.user, host.method, key.keyType, key.fingerprint]);
const validKey = (key: HostKey) => typeof key.keyType === "string" && /^[\w@.+-]{1,100}$/.test(key.keyType) && typeof key.fingerprint === "string" && /^SHA256:[A-Za-z0-9+/]{43}$/.test(key.fingerprint);

/** Only connection metadata and explicitly accepted host identities go here.
 * Unknown/corrupt versions stay untouched; no silent reset of trust records. */
export class AndroidHostStore {
  private data: Data = { version: 1, hosts: [], known: [] };
  readonly problem: string | undefined;
  constructor() {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      const value = JSON.parse(raw) as Data;
      if (value.version !== 1 || !Array.isArray(value.hosts) || !Array.isArray(value.known) || value.hosts.length > 256 || value.known.length > 512) throw new Error();
      const hosts = value.hosts.map(normalizeProfile);
      if (new Set(hosts.map(h => h.id)).size !== hosts.length || value.known.some(k => !k || typeof k.endpoint !== "string" || !validKey(k))) throw new Error();
      this.data = { version: 1, hosts, known: value.known.map(k => ({ endpoint: k.endpoint, keyType: k.keyType, fingerprint: k.fingerprint })) };
    } catch { this.problem = "本地 SSH 配置无法读取，已保留原数据；请先恢复配置后再修改。"; }
  }
  get hosts(): readonly HostProfile[] { return this.data.hosts; }
  host(id: string) { return this.data.hosts.find(h => h.id === id); }
  key(host: HostProfile): HostKey | undefined {
    const key = this.data.known.find(k => k.endpoint === endpoint(host));
    return key && { keyType: key.keyType, fingerprint: key.fingerprint };
  }
  save(profile: HostProfile) {
    const host = normalizeProfile(profile);
    const hosts = this.data.hosts.filter(h => h.id !== host.id);
    if (hosts.length >= 256) throw new Error("最多保存 256 台主机");
    const index = this.data.hosts.findIndex(h => h.id === host.id);
    hosts.splice(index < 0 ? hosts.length : index, 0, host);
    this.write({ ...this.data, hosts });
    return host;
  }
  remove(id: string) { this.write({ ...this.data, hosts: this.data.hosts.filter(h => h.id !== id) }); }
  trust(host: HostProfile, key: HostKey) {
    if (!validKey(key)) throw new Error("主机指纹格式不正确");
    const address = endpoint(host);
    const known = this.data.known.filter(k => k.endpoint !== address);
    if (known.length >= 512) throw new Error("已保存主机指纹过多");
    this.write({ ...this.data, known: [...known, { endpoint: address, keyType: key.keyType, fingerprint: key.fingerprint }] });
  }
  forget(host: HostProfile) { this.write({ ...this.data, known: this.data.known.filter(k => k.endpoint !== endpoint(host)) }); }
  private write(data: Data) {
    if (this.problem) throw new Error(this.problem);
    localStorage.setItem(storageKey, JSON.stringify(data));
    this.data = data;
  }
}
