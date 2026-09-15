import type { MigrationBridge, PortableSecrets } from "../migration-types";
import type { SshKeyEntry } from "../client";
import type { AuthRequest } from "./session";
import type { AndroidHostStore, HostProfile } from "./store";
import { encryptedStore } from "./vault";
import { encryptCredentials, decryptCredentials } from "./portable-crypto";
import type { ServiceResult } from "../services";

const keyIdentity = (id: string) => "rhine-android-key-v1:" + id;
const run = async <T>(action: () => Promise<T>): Promise<ServiceResult<T>> => {
  try {
    return { ok: true, result: await action() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
export function androidMigration(
  hosts: AndroidHostStore,
  keys: () => readonly SshKeyEntry[],
  auth: (host: HostProfile) => Promise<AuthRequest | undefined>,
  pendingIdentity: (host: HostProfile) => string,
): MigrationBridge {
  type Ticket = {
    value: PortableSecrets;
    keyMap: Record<string, string>;
    expires: number;
  };
  const tickets = new Map<string, Ticket>();
  const get = (id: string) => {
    const t = tickets.get(id);
    if (!t || t.expires < Date.now()) {
      tickets.delete(id);
      throw new Error("导入预览已过期，请重新读取备份");
    }
    return t;
  };
  const findHost = (alias: string) =>
    hosts.host(alias.replace(/^rhine-profile:/, ""));
  return {
    describeHosts: (targets) =>
      run(async () => ({
        hosts: targets.map((alias) => {
          const host = findHost(alias);
          if (!host) throw new Error("主机档案不存在");
          return {
            alias,
            hostname: host.host,
            port: host.port,
            user: host.user,
            jumpHost: host.jumpHost,
          };
        }),
        errors: [],
      })),
    exportCredentials: (request) =>
      run(async () => {
        const value: PortableSecrets = {
            version: 1,
            keys: [],
            credentials: [],
          },
          keyBindings: Record<string, string> = Object.create(null);
        for (const key of keys().filter((k) => request.keyIds.includes(k.id))) {
          const secret = await encryptedStore.get<{ privateKey: string }>(
            keyIdentity(key.id),
          );
          if (!secret) throw new Error(`无法读取私钥 ${key.name}`);
          value.keys.push({
            id: key.id,
            name: key.name,
            privateKey: secret.privateKey,
          });
        }
        for (const target of request.targets) {
          const host = findHost(target);
          if (!host) continue;
          let keyId = host.keyId;
          const saved = await auth(host);
          if (saved?.method === "publickey") {
            if (!keyId) {
              keyId = "legacy:" + target;
              value.keys.push({
                id: keyId,
                name: host.name,
                privateKey: saved.privateKey,
              });
            }
            const key = value.keys.find((k) => k.id === keyId);
            if (key && saved.passphrase) key.passphrase = saved.passphrase;
          }
          if (keyId) keyBindings[target] = keyId;
          const secret =
            saved?.method === "password"
              ? saved.password
              : saved?.method === "publickey"
                ? saved.passphrase
                : undefined;
          if (secret !== undefined)
            value.credentials.push({
              target,
              kind: saved!.method === "password" ? "password" : "passphrase",
              value: secret,
              host: host.host,
              port: host.port,
              user: host.user,
              keyId,
              fingerprint: hosts.key(host)?.fingerprint,
            });
        }
        return {
          encrypted: await encryptCredentials(value, request.password),
          keyBindings,
        };
      }),
    prepareCredentials: (request) =>
      run(async () => {
        const value = await decryptCredentials(
          request.encrypted,
          request.password,
        );
        for (const [id, ticket] of tickets)
          if (ticket.expires < Date.now()) tickets.delete(id);
        if (tickets.size >= 4) throw new Error("请先关闭已有导入预览");
        const ticket = crypto.randomUUID();
        tickets.set(ticket, {
          value,
          keyMap: Object.create(null),
          expires: Date.now() + 600000,
        });
        setTimeout(tickets.delete.bind(tickets, ticket), 600000);
        return {
          ticket,
          keys: value.keys.length,
          credentials: value.credentials.length,
        };
      }),
    importKeys: (id) =>
      run(async () => {
        const ticket = get(id);
        for (const key of ticket.value.keys) {
          if (ticket.keyMap[key.id]) continue;
          let match: SshKeyEntry | undefined;
          for (const local of keys()) {
            const stored = await encryptedStore.get<{ privateKey: string }>(
              keyIdentity(local.id),
            );
            if (stored?.privateKey === key.privateKey) {
              match = local;
              break;
            }
          }
          if (match) ticket.keyMap[key.id] = match.id;
          else {
            const result = await window.rhineDesktop!.keys!.add({
              source: "import",
              name: key.name,
              content: key.privateKey,
              passphrase: key.passphrase,
            });
            if (!result.ok || !result.key)
              throw new Error(result.error || "密钥导入失败");
            ticket.keyMap[key.id] = result.key.id;
          }
        }
        return { keyMap: { ...ticket.keyMap } };
      }),
    importCredentials: (request) =>
      run(async () => {
        const ticket = get(request.ticket),
          operations: {
            identity: string;
            auth: AuthRequest;
            fingerprint?: string;
          }[] = [];
        for (const item of ticket.value.credentials) {
          const alias = Object.hasOwn(request.hosts, item.target)
            ? request.hosts[item.target]
            : undefined;
          if (!alias) continue;
          const host = findHost(alias);
          if (
            !host ||
            host.host.toLowerCase() !== item.host.toLowerCase() ||
            host.port !== item.port ||
            host.user !== item.user
          )
            throw new Error("凭据目标与导入主机不一致，未写入凭据");
          let auth: AuthRequest;
          if (item.kind === "password") {
            if (host.method !== "password") continue;
            auth = { method: "password", password: item.value };
          } else {
            const keyId = item.keyId && ticket.keyMap[item.keyId];
            if (!keyId || host.keyId !== keyId || host.method !== "publickey")
              continue;
            const secret = await encryptedStore.get<{ privateKey: string }>(
              keyIdentity(keyId),
            );
            if (!secret) throw new Error("导入私钥无法读取");
            auth = {
              method: "publickey",
              privateKey: secret.privateKey,
              passphrase: item.value,
            };
          }
          operations.push({
            identity: pendingIdentity(host),
            auth,
            fingerprint: item.fingerprint,
          });
        }
        const before: { key: string; value: unknown }[] = [];
        try {
          for (const op of operations) {
            // Imported fingerprints constrain credential reuse; they never add a
            // host to known_hosts. Trust is still confirmed during SSH handshake.
            for (const [key, value] of [
              [op.identity, op.auth],
              [op.identity + ":fingerprint", op.fingerprint || ""],
              [op.identity + ":failed", false],
            ] as const) {
              before.push({ key, value: await encryptedStore.get(key) });
              await encryptedStore.put(key, value);
            }
          }
        } catch (error) {
          for (const old of before.reverse()) {
            if (old.value === undefined) await encryptedStore.remove(old.key);
            else await encryptedStore.put(old.key, old.value);
          }
          throw error;
        }
        tickets.delete(request.ticket);
        return { count: operations.length };
      }),
    async cancel(id) {
      tickets.delete(id);
    },
  };
}
