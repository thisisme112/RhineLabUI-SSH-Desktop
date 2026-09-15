import type { ServiceResult } from "./services";
export type EncryptedCredentials = {
  version: 1;
  kdf: "PBKDF2-SHA256";
  iterations: 210000;
  salt: string;
  iv: string;
  data: string;
};
export type PortableSecrets = {
  version: 1;
  keys: { id: string; name: string; privateKey: string; passphrase?: string }[];
  credentials: {
    target: string;
    kind: "password" | "passphrase";
    value: string;
    host: string;
    port: number;
    user: string;
    keyId?: string;
    fingerprint?: string;
  }[];
};
export type MigrationBridge = {
  describeHosts(targets: string[]): Promise<
    ServiceResult<{
      hosts: {
        alias: string;
        hostname: string;
        user: string;
        port: number;
        jumpHost?: string;
        unsupportedProxy?: boolean;
        key?: { id: string; name: string; fingerprint: string; type: string };
      }[];
      errors: string[];
    }>
  >;
  exportCredentials(request: {
    password: string;
    targets: string[];
    keyIds: string[];
  }): Promise<
    ServiceResult<{
      encrypted: EncryptedCredentials;
      keyBindings: Record<string, string>;
    }>
  >;
  prepareCredentials(request: {
    password: string;
    encrypted: EncryptedCredentials;
  }): Promise<
    ServiceResult<{ ticket: string; keys: number; credentials: number }>
  >;
  importKeys(
    ticket: string,
  ): Promise<ServiceResult<{ keyMap: Record<string, string> }>>;
  importCredentials(request: {
    ticket: string;
    hosts: Record<string, string>;
  }): Promise<ServiceResult<{ count: number }>>;
  cancel(ticket: string): Promise<void>;
};
export function validPortableSecrets(value: unknown): value is PortableSecrets {
  const p = value as PortableSecrets;
  const text = (v: unknown, max: number): v is string =>
    typeof v === "string" && v.length <= max && !v.includes("\0");
  return (
    !!p &&
    p.version === 1 &&
    Array.isArray(p.keys) &&
    p.keys.length <= 256 &&
    p.keys.every(
      (k) =>
        !!k &&
        text(k.id, 1024) &&
        !!k.id &&
        text(k.name, 80) &&
        text(k.privateKey, 131072) &&
        !!k.privateKey &&
        (k.passphrase === undefined || text(k.passphrase, 16384)),
    ) &&
    new Set(p.keys.map((k) => k.id)).size === p.keys.length &&
    Array.isArray(p.credentials) &&
    p.credentials.length <= 1024 &&
    p.credentials.every(
      (c) =>
        !!c &&
        text(c.target, 1024) &&
        !!c.target &&
        ["password", "passphrase"].includes(c.kind) &&
        text(c.value, 16384) &&
        !!c.value &&
        !/[\r\n]/.test(c.value) &&
        text(c.host, 253) &&
        Number.isInteger(c.port) &&
        c.port > 0 &&
        c.port < 65536 &&
        text(c.user, 128) &&
        (c.keyId === undefined || text(c.keyId, 1024)) &&
        (c.fingerprint === undefined ||
          (text(c.fingerprint, 256) &&
            (!c.fingerprint ||
              /^SHA256:[A-Za-z0-9+/=]{1,128}$/.test(c.fingerprint)))),
    )
  );
}
