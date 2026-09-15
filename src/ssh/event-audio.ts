import type { Sound } from "../audio";
import type { WorkspaceSession } from "./session-bank";

type Seen = { generation: number; connected: boolean; ended: boolean; prompts: Set<string>; jobs: Map<string, string>; batch: Set<string>; timer?: ReturnType<typeof setTimeout> };
/** Real state transitions only: output, charts and repeated snapshots are silent. */
export class SshEventAudio {
  private seen = new Map<string, Seen>();
  private play: (sound: Sound) => void;
  constructor(play: (sound: Sound) => void) { this.play = play; }
  update(session: WorkspaceSession) {
    const client = session.client;
    let state = this.seen.get(session.key);
    if (!state || state.generation !== client.generation) {
      clearTimeout(state?.timer);
      state = { generation: client.generation, connected: false, ended: false, prompts: new Set(), jobs: new Map(), batch: new Set() };
      this.seen.set(session.key, state);
    }
    const prompt = client.pendingPrompt ? "primary:" + client.pendingPrompt.id : session.services.state?.prompt ? "aux:" + session.services.state.prompt.id : "";
    if (prompt && !state.prompts.has(prompt)) { state.prompts.add(prompt); this.play("ssh-auth"); }
    if (client.status().phase === "interactive" && !state.connected) { state.connected = true; this.play("ssh-connected"); }
    if (client.exit && !state.ended) {
      state.ended = true;
      if (session.manualStop) this.play("ssh-ended");
      if (state.connected && !session.manualStop && client.exit.exitCode !== 0) this.play("ssh-disconnected");
    }
    const jobs = session.services.state?.jobs ?? [];
    let changed = false;
    for (const job of jobs) {
      if (state.jobs.get(job.id) === job.state) continue;
      if (!state.jobs.has(job.id) && ["completed", "failed", "canceled", "uncertain"].includes(job.state)) {
        state.jobs.set(job.id, job.state); continue;
      }
      state.jobs.set(job.id, job.state); state.batch.add(job.id); changed = true;
    }
    if (!changed) return;
    clearTimeout(state.timer);
    if (!state.batch.size || jobs.some(job => state!.batch.has(job.id) && ["queued", "scanning", "transferring", "committing", "conflict"].includes(job.state))) return;
    const batch = state;
    state.timer = setTimeout(() => {
      const statuses = [...batch.batch].map(id => batch.jobs.get(id));
      batch.batch.clear();
      if (statuses.some(status => status === "failed" || status === "uncertain")) this.play("ssh-transfer-failed");
      else if (statuses.includes("completed")) this.play("ssh-transfer-complete");
    }, 350);
  }
  remove(key: string) { clearTimeout(this.seen.get(key)?.timer); this.seen.delete(key); }
  dispose() { for (const state of this.seen.values()) clearTimeout(state.timer); this.seen.clear(); }
}
