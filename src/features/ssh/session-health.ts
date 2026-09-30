import type { SshSessionBank, WorkspaceSession } from "./session-bank";
import { sshPreferences } from "./preferences";

type Episode = { since: number; last: number; sent: boolean; message: string };
type Health = {
  live: boolean;
  generation: number;
  blocked: boolean;
  attempts: number;
  due: number;
  reconnecting: boolean;
  connectedAt: number;
  episodes: Map<string, Episode>;
};
/** Only observed transport failures initiate recovery. Shell output is never an authority. */
export class SessionHealth {
  private states = new Map<string, Health>();
  private off: () => void;
  private timer: number;
  private abort = new AbortController();
  constructor(
    private bank: SshSessionBank,
    private reconnect: (session: WorkspaceSession) => Promise<unknown>,
    private notify: (message: string) => void,
  ) {
    this.off = bank.onChange((session) => this.observe(session));
    this.timer = window.setInterval(() => this.tick(), 1000);
    window.addEventListener("online", () => this.tick(), {
      signal: this.abort.signal,
    });
  }
  cancel(session: WorkspaceSession) {
    const state = this.states.get(session.key);
    if (state) {
      state.blocked = true;
      state.due = 0;
    }
    session.recovery = "";
    this.bank.changed(session);
  }
  private observe(session: WorkspaceSession) {
    let h = this.states.get(session.key);
    if (!h) {
      h = {
        live: false,
        generation: -1,
        blocked: false,
        attempts: 0,
        due: 0,
        reconnecting: false,
        connectedAt: 0,
        episodes: new Map(),
      };
      this.states.set(session.key, h);
    }
    const status = session.client.status();
    if (session.client.generation !== h.generation) {
      h.generation = session.client.generation;
      if (!h.reconnecting) {
        h.blocked = false;
        h.attempts = 0;
        h.live = false;
      }
      h.due = 0;
      session.recovery = "";
    }
    if (
      status.last &&
      ["auth.denied", "hostkey.mismatch"].includes(status.last.name)
    )
      h.blocked = true;
    if (status.phase === "interactive" && session.client.active) {
      if (!h.connectedAt) h.connectedAt = Date.now();
      h.live = true;
      h.due = 0;
      session.recovery = "";
      if (Date.now() - h.connectedAt > 30000) h.attempts = 0;
    } else if (!session.client.active) h.connectedAt = 0;
  }
  private tick() {
    const now = Date.now(),
      pref = sshPreferences.value;
    for (const key of this.states.keys())
      if (!this.bank.byKey(key)) this.states.delete(key);
    for (const session of this.bank.visibleSessions) {
      this.observe(session);
      const h = this.states.get(session.key)!;
      if (session.manualStop) {
        h.blocked = true;
        h.due = 0;
      }
      const disconnected =
        h.live &&
        !session.client.active &&
        !session.manualStop &&
        session.client.exit?.exitCode !== 0;
      if (
        pref.reconnect &&
        disconnected &&
        !h.blocked &&
        !h.reconnecting &&
        h.attempts < pref.reconnectAttempts
      ) {
        if (!h.due) h.due = now + Math.min(30000, 2000 * 2 ** h.attempts);
        if (!navigator.onLine) session.recovery = "等待网络恢复";
        else if (now < h.due)
          session.recovery = `${Math.ceil((h.due - now) / 1000)} 秒后重连 · ${h.attempts + 1}/${pref.reconnectAttempts}`;
        else {
          h.reconnecting = true;
          h.attempts++;
          h.due = 0;
          session.recovery = "正在重新连接";
          void this.reconnect(session)
            .catch(() => {})
            .finally(() => {
              h.reconnecting = false;
            });
        }
      } else if (!h.reconnecting)
        session.recovery =
          disconnected && h.attempts >= pref.reconnectAttempts
            ? "自动重连已停止"
            : "";
      const unavailable =
        h.live &&
        !session.manualStop &&
        session.client.status().phase !== "interactive" &&
        (session.client.active || session.client.exit?.exitCode !== 0);
      const values = new Map<string, string>();
      const state = session.services.state,
        sample = state?.sample;
      if (pref.alerts.enabled) {
        if (unavailable) values.set("disconnect", "连接意外断开，尚未恢复");
        if (
          sample &&
          state &&
          now - state.receivedAt < 3500 &&
          session.client.active
        ) {
          if (sample.cpu?.usage != null && sample.cpu.usage >= pref.alerts.cpu)
            values.set("cpu", `CPU ≥ ${pref.alerts.cpu}%`);
          for (const disk of sample.disks)
            if (
              disk.total > 0 &&
              (disk.used / disk.total) * 100 >= pref.alerts.disk
            )
              values.set(
                "disk:" + disk.mount,
                `${disk.mount} 磁盘 ≥ ${pref.alerts.disk}%`,
              );
          if (sample.gpuAt && Math.abs(sample.timestamp - sample.gpuAt) < 5000)
            for (const gpu of sample.gpus)
              if (
                gpu.temperature != null &&
                gpu.temperature >= pref.alerts.gpuTemperature
              )
                values.set(
                  "gpu:" + gpu.uuid,
                  `${gpu.name} ≥ ${pref.alerts.gpuTemperature}°C`,
                );
        }
      }
      for (const key of h.episodes.keys())
        if (!values.has(key)) h.episodes.delete(key);
      for (const [key, message] of values) {
        let episode = h.episodes.get(key);
        if (!episode || now - episode.last > 3500) {
          episode = { since: now, last: now, sent: false, message };
          h.episodes.set(key, episode);
        }
        episode.last = now;
        if (
          !episode.sent &&
          now - episode.since >=
            (key === "disconnect"
              ? pref.alerts.disconnect
              : pref.alerts.duration) *
              1000
        ) {
          episode.sent = true;
          this.notify(
            `${session.project?.name || session.client.displayTarget || session.client.target}：${message}`,
          );
        }
      }
      session.alert = [...h.episodes.values()]
        .filter((e) => e.sent)
        .map((e) => e.message)
        .join(" · ");
      this.bank.changed(session);
    }
  }
  dispose() {
    this.off();
    clearInterval(this.timer);
    this.abort.abort();
  }
}
