export type SshPreferences = {
  version: 1;
  reconnect: boolean;
  reconnectAttempts: number;
  background: boolean;
  animation: "full" | "first";
  alerts: {
    enabled: boolean;
    cpu: number;
    disk: number;
    gpuTemperature: number;
    duration: number;
    disconnect: number;
  };
};
const KEY = "rhine.ssh.preferences";
const defaults = (): SshPreferences => ({
  version: 1,
  reconnect: true,
  reconnectAttempts: 5,
  background: false,
  animation: "full",
  alerts: {
    enabled: true,
    cpu: 95,
    disk: 90,
    gpuTemperature: 85,
    duration: 30,
    disconnect: 8,
  },
});
export function validSshPreferences(value: unknown): value is SshPreferences {
  const v = value as SshPreferences;
  const range = (n: number, a: number, b: number) =>
    Number.isFinite(n) && n >= a && n <= b;
  return (
    !!v &&
    v.version === 1 &&
    typeof v.reconnect === "boolean" &&
    Number.isInteger(v.reconnectAttempts) &&
    range(v.reconnectAttempts, 1, 20) &&
    typeof v.background === "boolean" &&
    ["full", "first"].includes(v.animation) &&
    !!v.alerts &&
    typeof v.alerts.enabled === "boolean" &&
    range(v.alerts.cpu, 1, 100) &&
    range(v.alerts.disk, 1, 100) &&
    range(v.alerts.gpuTemperature, 40, 120) &&
    range(v.alerts.duration, 1, 600) &&
    range(v.alerts.disconnect, 1, 300)
  );
}
class Preferences {
  value = defaults();
  error = "";
  private readOnly = false;
  private listeners = new Set<() => void>();
  constructor() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const v = JSON.parse(raw);
        if (!validSshPreferences(v))
          throw new Error("SSH 设置版本无法读取，原数据已保留");
        this.value = v;
      }
    } catch (error) {
      this.error = String(error);
      this.readOnly = true;
    }
  }
  save(value: SshPreferences) {
    if (this.readOnly || !validSshPreferences(value)) return false;
    try {
      localStorage.setItem(KEY, JSON.stringify(value));
      this.value = structuredClone(value);
      this.error = "";
      for (const listener of this.listeners) listener();
      return true;
    } catch {
      this.error = "设置无法保存，请检查本机存储空间";
      return false;
    }
  }
  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
export const sshPreferences = new Preferences();
