import type {
  DesktopSessionBridge,
  CredentialState,
  SavedCredential,
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
  /** Desktop only: the window was minimised, hidden or brought back. */
  onWindowState?: (listener: (state: { minimized: boolean; visible: boolean }) => void) => () => void;
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
    /** What is saved for whom — never a secret. Desktop only. */
    list?(): Promise<{ ok: boolean; entries: SavedCredential[]; available?: boolean; error?: string }>;
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
  /** The maids' assistant (electron/maid-assistant.cjs). Desktop only; the key is never handed back. */
  maid?: MaidBridge;
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

export type MaidWho = "claude" | "deepseek";
export type MaidKeySource = "saved" | "env" | "";
export type MaidBridge = {
  keys(): Promise<{ ok: boolean; keys?: Record<MaidWho, MaidKeySource>; available?: boolean; error?: string }>;
  saveKey(who: MaidWho, key: string): Promise<{ ok: boolean; keys?: Record<MaidWho, MaidKeySource>; error?: string }>;
  forgetKey(who: MaidWho): Promise<{ ok: boolean; keys?: Record<MaidWho, MaidKeySource>; error?: string }>;
  request(request: { id?: string; who: MaidWho; url: string; body: string; auth: "anthropic" | "bearer"; beta?: string; workspace?: string; timeout?: number }):
    Promise<{ ok: boolean; status: number; text: string; error?: string }>;
  cancel(id: string): Promise<{ ok: boolean }>;
  read(name: "history" | "commands"): Promise<{ ok: boolean; text?: string; error?: string }>;
  write(name: "history" | "commands", text: string): Promise<{ ok: boolean; error?: string }>;
  remove(name: "history" | "commands"): Promise<{ ok: boolean; error?: string }>;
  window(mode: "windowed" | "maximized" | "fullscreen"): Promise<{ ok: boolean; error?: string }>;
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
