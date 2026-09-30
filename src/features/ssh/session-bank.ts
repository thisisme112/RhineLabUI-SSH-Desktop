import { SshClient, type SshLaunchDescriptor } from "./client";
import { SshServicesClient, type ServicesEvent } from "./services";
import { SshTerminalPanel } from "./terminal";
import type { ArchiveShortcut } from "./workspace-store";

export type SessionViewState = {
  presentation: "inspection" | "waiting" | "entering" | "terminal" | "returning";
  entryGeneration: number | null;
  interactiveGeneration: number; revealed: boolean; failureShown: boolean;
  lastPhase: string; seenGeneration: number; sessionCard: number;
};
export type WorkspaceSession = {
  key: string; client: SshClient; services: SshServicesClient; panel: SshTerminalPanel;
  descriptor: SshLaunchDescriptor | null; view: SessionViewState;
  recordSaved: boolean; recordGeneration: number; manualStop: boolean;
  lastActivated: number; retiring: boolean;
  project?: ArchiveShortcut; startupGeneration: number;
  alert: string; recovery: string;
  splitKey?: string; splitRatio?: number;
  off: (() => void)[];
};

/** One parser/buffer per connection. Only the active surface is mounted. */
export class SshSessionBank {
  readonly sessions: WorkspaceSession[] = [];
  active: WorkspaceSession;
  private activation = 0;
  private listeners = new Set<(session: WorkspaceSession, event?: ServicesEvent) => void>();

  constructor(private stage: HTMLElement, private actions: {
    close(session: WorkspaceSession): void;
    audit(session: WorkspaceSession): void;
    reconnect(session: WorkspaceSession): void;
    changed?(session: WorkspaceSession, event?: ServicesEvent): void;
  }) {
    this.active = this.create();
  }
  create() {
    const client = new SshClient();
    const services = new SshServicesClient(() => client.id);
    const panel = new SshTerminalPanel(client, this.stage,
      () => this.actions.close(session), () => this.actions.audit(session),
      () => this.actions.reconnect(session), services);
    const session: WorkspaceSession = { key: crypto.randomUUID(), client, services, panel, descriptor: null,
      recordSaved: false, recordGeneration: -1, manualStop: false, off: [],
      lastActivated: ++this.activation, retiring: false,
      startupGeneration: -1, alert: "", recovery: "",
      view: { presentation: "inspection", entryGeneration: null, interactiveGeneration: -1, revealed: false, failureShown: false,
        lastPhase: "", seenGeneration: 0, sessionCard: 0 },
    };
    session.off.push(client.onChange(() => {
      services.refreshOwner();
      if (client.status().phase === "interactive") session.view.interactiveGeneration = client.generation;
      if (client.exit && session.recordGeneration !== client.generation) {
        const generation = session.recordGeneration = client.generation;
        void client.persistRecord().then(result => {
          if (client.generation !== generation || !this.sessions.includes(session)) return;
          session.recordSaved = result.ok;
          this.emit(session);
        }).catch(() => { if (client.generation === generation) this.emit(session); });
      }
      this.emit(session);
    }));
    session.off.push(services.onChange((_state, event) => this.emit(session, event)));
    this.sessions.push(session);
    return session;
  }
  onChange(listener: (session: WorkspaceSession, event?: ServicesEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(session: WorkspaceSession, event?: ServicesEvent) {
    this.actions.changed?.(session, event);
    for (const listener of this.listeners) listener(session, event);
  }
  changed(session: WorkspaceSession) { this.emit(session); }
  get visibleSessions() { return this.sessions.filter(session => !session.retiring && (session.descriptor || session.client.target)); }
  forAlias(alias: string) {
    const own = this.active;
    if (!own.retiring && own.client.target === alias && own.client.active) return own;
    const recent = this.visibleSessions.filter(session => session.client.target === alias)
      .sort((a, b) => b.lastActivated - a.lastActivated);
    return recent.find(session => session.client.active) ?? recent[0];
  }
  byKey(key: string) { return this.sessions.find(session => session.key === key); }
  activate(session: WorkspaceSession) {
    if (this.active !== session) this.active.panel.park();
    this.active = session;
    session.lastActivated = ++this.activation;
  }
  remove(session: WorkspaceSession) {
    if (session.client.active || !this.sessions.includes(session)) return false;
    for (const off of session.off) off();
    session.panel.dispose(); session.services.dispose(); session.client.dispose();
    this.sessions.splice(this.sessions.indexOf(session), 1);
    if (session === this.active) this.active = this.sessions.at(-1) ?? this.create();
    this.emit(this.active);
    return true;
  }
  dispose() {
    for (const session of this.sessions) {
      for (const off of session.off) off();
      session.manualStop = true;
      if (session.client.active) session.client.stop();
      session.panel.dispose(); session.services.dispose(); session.client.dispose();
    }
    this.sessions.length = 0;
    this.listeners.clear();
  }
}
