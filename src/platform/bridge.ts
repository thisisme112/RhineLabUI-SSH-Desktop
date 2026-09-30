import type {
  DesktopSessionBridge,
  CredentialState,
  SshKeyEntry,
  SshHostsResult,
  SshHostProfilesBridge,
  SessionRecordSummary,
} from "../features/ssh/client";
import type { DesktopSessionsBridge } from "../features/ssh/session-bridge";
import type {
  ServicesBridge,
  SftpBridge,
  MonitorBridge,
  TunnelsBridge,
} from "../features/ssh/services";
import type { MigrationBridge } from "../features/ssh/migration-types";
import type { SessionRecord } from "../features/ssh/audit";

/** Common native contract. Electron preload and the Android adapter publish it. */
export type PlatformBridge = {
  isDesktop: boolean;
  platform: string;
  /** Which of the two window captions to use; the OS draws it. */
  theme?: (value: "light" | "dark") => void;
  /** The window as it is now (JPEG), for the theme change-over. */
  capture?: () => Promise<Uint8Array | null>;
  versions: { electron: string; chrome: string; node: string };
  session?: DesktopSessionBridge | DesktopSessionsBridge;
  services?: ServicesBridge;
  sftp?: SftpBridge;
  monitor?: MonitorBridge;
  tunnels?: TunnelsBridge;
  background?: {
    set(
      enabled: boolean,
    ): Promise<{ enabled: boolean; notificationGranted: boolean }>;
    status(): Promise<{ enabled: boolean; notificationGranted: boolean }>;
  };
  migration?: MigrationBridge;
  /** Text-only clipboard, read only on an explicit terminal paste action. */
  clipboard?: {
    readText(): Promise<{ ok: boolean; text?: string; error?: string }>;
    writeText(text: string): Promise<{ ok: boolean; error?: string }>;
  };
  /** Renderer-side crash/error reporting into the desktop diagnostic log. */
  captureError?: (entry: {
    category: string;
    level: string;
    reason?: string;
    message?: string;
  }) => Promise<{ ok: boolean }>;
  /** Saved profiles and hosts from the user's own SSH config. */
  hosts?: () => Promise<SshHostsResult>;
  hostProfiles?: SshHostProfilesBridge;
  credentials?: {
    status(
      target: string,
    ): Promise<{ ok: boolean; state?: CredentialState; error?: string }>;
    save(request: {
      target: string;
      kind: "password" | "passphrase";
      value: string;
    }): Promise<{ ok: boolean; state?: CredentialState; error?: string }>;
    remove(request: {
      target: string;
      kind?: "password" | "passphrase";
    }): Promise<{ ok: boolean; state?: CredentialState; error?: string }>;
  };
  keys?: {
    list(): Promise<{ ok: boolean; keys: SshKeyEntry[]; error?: string }>;
    add(input: {
      name?: string;
      source: "file" | "import";
      file?: string;
      content?: string;
      passphrase?: string;
    }): Promise<{ ok: boolean; key?: SshKeyEntry; error?: string }>;
    remove(id: string): Promise<{ ok: boolean; error?: string }>;
  };
  /** Past session records, read back for the host cards. */
  records?: {
    list(): Promise<{
      ok: boolean;
      records: SessionRecordSummary[];
      dir?: string;
      error?: string;
    }>;
    read(file: string): Promise<{
      ok: boolean;
      record?: SessionRecord;
      file?: string;
      error?: string;
    }>;
    log(file: string): Promise<{
      ok: boolean;
      lines?: string[];
      truncated?: boolean;
      file?: string;
      error?: string;
    }>;
    prune(): Promise<{
      ok: boolean;
      removed: number;
      bytesFreed: number;
      errors?: string[];
    }>;
  };
};

declare global {
  interface Window {
    rhineDesktop?: PlatformBridge;
  }
}

/** Read the current adapter; Android installs it after native initialization. */
export function getPlatformBridge(): PlatformBridge | undefined {
  return typeof window === "undefined" ? undefined : window.rhineDesktop;
}
