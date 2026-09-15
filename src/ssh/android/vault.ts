import { registerPlugin } from "@capacitor/core";
import type { AuthRequest } from "./session";
type NativeVault = {
  available(): Promise<{ available: boolean }>;
  get(options: { key: string }): Promise<{ value?: string }>;
  put(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
};
const native = registerPlugin<NativeVault>("SshVault");
export const encryptedStore = {
  async get<T>(key: string): Promise<T | undefined> {
    const raw = (await native.get({ key })).value;
    return raw ? JSON.parse(raw) as T : undefined;
  },
  put: (key: string, value: unknown) => native.put({ key, value: JSON.stringify(value) }),
  remove: (key: string) => native.remove({ key }),
};
export const credentialVault = {
  async available() { try { return (await native.available()).available; } catch { return false; } },
  async get(key: string): Promise<AuthRequest | undefined> {
    const raw = (await native.get({ key })).value;
    if (!raw) return;
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.method === "password" && typeof value.password === "string") return { method: "password", password: value.password };
    if (value.method === "publickey" && typeof value.privateKey === "string" && (value.passphrase === undefined || typeof value.passphrase === "string"))
      return { method: "publickey", privateKey: value.privateKey, passphrase: value.passphrase };
    throw new Error("保存的凭据无法读取，请清除后重新保存");
  },
  async put(key: string, auth: AuthRequest) {
    if (auth.method === "keyboard-interactive") throw new Error("交互式验证码不保存");
    await native.put({ key, value: JSON.stringify(auth) });
  },
  remove: (key: string) => native.remove({ key }),
};
