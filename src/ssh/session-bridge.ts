import type { DesktopSessionBridge, SshLaunchDescriptor, SshStartResult,
  SshExitInfo, SshPrompt, SshTraffic } from "./client";

export type SessionEnvelope<T> = { sessionId: string; data: T };
export type DesktopSessionsBridge = {
  onProtocol?(listener: (event: SessionEnvelope<import("./events").SshEvent>) => void): () => void;
  reserve(): Promise<{ ok: boolean; id?: string; error?: string }>;
  start(descriptor: SshLaunchDescriptor, sessionId: string): Promise<SshStartResult>;
  write(data: string, sessionId: string): void;
  resize(cols: number, rows: number, sessionId: string): void;
  stop(sessionId: string): void;
  answer(id: number, value: string, sessionId: string, remember?: boolean): Promise<{ ok: boolean; error?: string }>;
  record: DesktopSessionBridge["record"];
  export: DesktopSessionBridge["export"];
  onData(listener: (event: SessionEnvelope<string>) => void): () => void;
  onLog(listener: (event: SessionEnvelope<string>) => void): () => void;
  onPrompt(listener: (event: SessionEnvelope<SshPrompt | null>) => void): () => void;
  onTraffic(listener: (event: SessionEnvelope<SshTraffic>) => void): () => void;
  onExit(listener: (event: SessionEnvelope<SshExitInfo>) => void): () => void;
};

/** Capture the ID once. Neither a focus change nor a late reply can retarget it. */
export function bindSessionBridge(bridge: DesktopSessionsBridge, id: string): DesktopSessionBridge {
  const only = <T>(listener: (data: T) => void) => (event: SessionEnvelope<T>) => {
    if (event?.sessionId === id) listener(event.data);
  };
  return {
    ...(bridge.onProtocol ? { onProtocol: (listener: (event: import("./events").SshEvent) => void) => bridge.onProtocol!(only(listener)) } : {}),
    start: descriptor => bridge.start(descriptor, id),
    write: data => bridge.write(data, id),
    resize: (cols, rows) => bridge.resize(cols, rows, id),
    stop: () => bridge.stop(id),
    answer: (request, value, remember) => bridge.answer(request, value, id, remember),
    record: payload => bridge.record(payload), export: payload => bridge.export(payload),
    onData: listener => bridge.onData(only(listener)),
    onLog: listener => bridge.onLog(only(listener)),
    onPrompt: listener => bridge.onPrompt(only(listener)),
    onTraffic: listener => bridge.onTraffic(only(listener)),
    onExit: listener => bridge.onExit(only(listener)),
  };
}
