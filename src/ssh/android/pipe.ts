import { registerPlugin } from "@capacitor/core";

export interface SessionPipe {
  start(): Promise<{ ok: boolean; error?: string; abi?: string }>;
  resolve?(host: string): Promise<string[]>;
  send(line: string): Promise<void>;
  onLine(handler: (line: string) => void): () => void;
  onClosed(handler: (code: number) => void): () => void;
  stop(): Promise<void>;
}
type NativeEvent = { id: string; line?: string; code?: number };
type NativeSession = {
  start(): Promise<{ ok: boolean; id: string; abi: string }>;
  resolve(options: { host: string }): Promise<{ addresses: string[] }>;
  send(options: { id: string; line: string }): Promise<void>;
  stop(options: { id: string }): Promise<void>;
  keyboard(): Promise<void>;
  background(options: { enabled: boolean }): Promise<{ enabled: boolean; notificationGranted: boolean }>;
  backgroundStatus(): Promise<{ enabled: boolean; notificationGranted: boolean }>;
  addListener(event: "line" | "closed", handler: (event: NativeEvent) => void): Promise<{ remove(): Promise<void> }>;
  addListener(event: "disconnectAll", handler: () => void): Promise<{ remove(): Promise<void> }>;
  addListener(event: "backgroundError", handler: (event: { message: string }) => void): Promise<{ remove(): Promise<void> }>;
};
const plugin = registerPlugin<NativeSession>("SshSession");
export const showTerminalKeyboard = () => plugin.keyboard();
export const nativeBackground = { set: (enabled: boolean) => plugin.background({ enabled }), status: () => plugin.backgroundStatus(), onDisconnect: (handler: () => void) => plugin.addListener("disconnectAll", handler), onError: (handler: (event: { message: string }) => void) => plugin.addListener("backgroundError", handler) };

/** Each pipe owns a token. Late process events cannot reach a new connection. */
export function createCapacitorPipe(): SessionPipe {
  const lines = new Set<(line: string) => void>();
  const closed = new Set<(code: number) => void>();
  let id = "", canceled = false, used = false;
  const early: { type: "line" | "closed"; event: NativeEvent }[] = [];
  let listeners: { remove(): Promise<void> }[] = [];
  const remove = async () => { const handles = listeners.splice(0); await Promise.allSettled(handles.map(h => h.remove())); };
  const receive = (type: "line" | "closed", event: NativeEvent) => {
    if (canceled) return;
    if (!id) { if (early.length < 16) early.push({ type, event }); return; }
    if (id !== event.id) return;
    if (type === "line" && typeof event.line === "string") for (const fn of lines) fn(event.line);
    if (type === "closed") for (const fn of closed) fn(event.code ?? -1);
  };
  return {
    async start() {
      if (used || canceled) throw new Error("此管道已使用");
      used = true;
      try {
        listeners.push(await plugin.addListener("line", e => receive("line", e)));
        if (canceled) throw new Error("连接已取消");
        listeners.push(await plugin.addListener("closed", e => receive("closed", e)));
        if (canceled) throw new Error("连接已取消");
        const result = await plugin.start(); id = result.id;
        if (canceled) { await plugin.stop({ id }); throw new Error("连接已取消"); }
        for (const e of early.splice(0)) receive(e.type, e.event);
        return result;
      } catch (error) { await remove(); throw error; }
    },
    async resolve(host) { return (await plugin.resolve({ host })).addresses; },
    send: line => id && !canceled ? plugin.send({ id, line }) : Promise.reject(new Error("SSH 代理尚未就绪")),
    onLine(fn) { lines.add(fn); return () => { lines.delete(fn); }; },
    onClosed(fn) { closed.add(fn); return () => { closed.delete(fn); }; },
    async stop() {
      canceled = true;
      const stopping = id; id = "";
      await remove();
      if (stopping) await plugin.stop({ id: stopping });
    },
  };
}
