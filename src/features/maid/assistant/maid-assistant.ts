import type { MaidBridge, MaidKeySource, MaidWho } from "../../../platform/bridge";
import { COMPLETER, COMPLETION_SCHEMA, PERSONA, REMARKER, REMARK_SCHEMA, TOOLS, WHALE_PERSONA, WHALE_REMARKER } from "./maid-prompts";
import { looksSecret } from "./maid-safety";

/**
 * The maids answer for real (the Unreal build's RhineClaude.h / RhineClaude.cpp, desktop only): what the reader types
 * to her goes to her API with what she can see of the workbench, and she works through tools the workbench runs
 * (maid-workbench.ts). Claude's through the Claude API (POST /v1/messages), DeepSeek's through the DeepSeek API (POST
 * /chat/completions, the OpenAI shape), each by her link (设置 → 看板娘): the API's shape, where it is, the model, a
 * quicker model for completion and remarks, how hard she thinks, and for completion a fill-in-the-middle endpoint.
 *
 * Her key is the reader's own, sealed in the main process (electron/maid-assistant.cjs) and never in this page: a
 * request names the URL and the body, and the main process adds the key. What comes back from a host is data she is
 * told not to take orders from; anything that changes a host waits for the reader.
 *
 * Her conversations are kept by host: each saved host has its own, as many as the reader begins, each deleted by
 * itself; the panel follows the host the reader selects to that host's latest, never while she is at work. Each
 * remembers whose it is (Claude's or DeepSeek's) and the shape its history is in. Beside the API's history runs the
 * Log, what her panel shows. With 跨重启保留 on both are written sealed after every answer and read back at start.
 *
 * Command completion and her remarks are requests of their own, outside the conversation, to her quick model with
 * thinking off; the reader's command history (a record on this machine) helps the first and suggests as they type.
 */
export type EntryKind = "user" | "claude" | "action" | "error" | "thought";
export type EntryState = "none" | "waiting" | "running" | "done" | "failed" | "refused";
export type Entry = { kind: EntryKind; text: string; subject: string; outcome: string; state: EntryState; at: number };
export type ToolCall = { id: string; name: string; input: Record<string, unknown> };
export type ToolDone = (result: string, error: boolean) => void;
export type RunTool = (call: ToolCall, done: ToolDone) => void;
export type Link = { format: "anthropic" | "openai"; base: string; model: string; fast: string; fim: string; thinking: number };
export type ModelChoice = { id: string; name: string; note: string };
type Json = Record<string, unknown>;
export type Conversation = {
  id: string; host: string; hostName: string; title: string; historyModel: string;
  deepSeek: boolean; format: string; created: number; updated: number; messages: Json[]; log: Entry[];
};
type CommandUse = { host: string; text: string; at: number };

export const MOODS = ["none", "happy", "worried", "surprised", "proud", "sleepy", "thinking", "shy"] as const;
export const MOOD = { none: 0, happy: 1, worried: 2, surprised: 3, proud: 4, sleepy: 5, thinking: 6, shy: 7 } as const;
export const EFFORTS = ["low", "medium", "high"] as const;

const MODELS: Record<MaidWho, ModelChoice[]> = {
  claude: [
    { id: "claude-opus-5-5", name: "Opus 5.5", note: "最聪明，慢一些、贵一些" },
    { id: "claude-sonnet-5-5", name: "Sonnet 5.5", note: "聪明又快，日常推荐" },
    { id: "claude-haiku-5-5", name: "Haiku 5.5", note: "最快最省，适合简单的事" },
    { id: "claude-fable-5-1", name: "Fable 5.1", note: "新一代模型" },
  ],
  deepseek: [
    { id: "deepseek-flash", name: "DeepSeek Flash", note: "V4.1 Flash：快又省，日常推荐" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", note: "更聪明，适合难题，慢一些" },
  ],
};

export function defaultLink(deep: boolean): Link {
  return deep
    ? { format: "openai", base: "https://api.deepseek.com", model: "deepseek-flash", fast: "deepseek-flash", fim: "https://api.deepseek.com/beta/completions", thinking: 2 }
    : { format: "anthropic", base: "https://api.anthropic.com", model: "claude-sonnet-5-5", fast: "claude-haiku-5-5", fim: "", thinking: 4 };
}

const STORE = "rhine-maid-assistant";
const who = (deep: boolean): MaidWho => deep ? "deepseek" : "claude";
const now = () => Date.now();
const json = (value: unknown) => JSON.stringify(value);
const parse = (text: string): Json | null => { try { const value = JSON.parse(text); return value && typeof value === "object" ? value : null; } catch { return null; } };
const errorOf = (root: Json | null) => {
  const error = root?.error as Json | undefined;
  return error && typeof error === "object" ? `${error.type ? `${String(error.type)}: ` : ""}${String(error.message ?? "")}` : "";
};

export class MaidAssistant {
  log: Entry[] = [];
  /** Changes whenever the log does (the panel rebuilds from it), and whenever the conversations do. */
  logRevision = 0;
  conversationRevision = 0;
  /** Her last answer (or what went wrong, in her words), a number that changes with each, and when (performance seconds). */
  reply = "";
  replySerial = 0;
  repliedAt = 0;
  /** The API's own words for the last failure, for the settings row; empty after a success. */
  lastError = "";
  keys: Record<MaidWho, MaidKeySource> = { claude: "", deepseek: "" };
  encryptionAvailable = true;

  private deepSeek = false;
  private links: [Link, Link] = [defaultLink(false), defaultLink(true)];
  private effort = 2;
  private shareTerminal = false;
  private persist = false;
  private trustReading = false;
  private completeMode = 0;
  private proactiveMode = 0;
  private historyMode = 2;
  private workspaceId = "";
  private conversations: Conversation[] = [];
  private current = -1;
  private messages: Json[] = [];
  private historyModel = "";
  private busy = false;
  private remarking = false;
  private completing = false;
  private completeTurn = 0;
  private runTool: RunTool | null = null;
  private round: ToolCall[] = [];
  private pending: ToolCall[] = [];
  private results: Json[] = [];
  private turn = 0;
  private rounds = 0;
  private commands: CommandUse[] = [];
  private listeners = new Set<() => void>();
  private requestId = "";

  constructor(private bridge: MaidBridge | undefined) {
    this.loadStore();
    void this.refreshKeys();
    void this.loadCommands();
    if (this.persist) void this.loadHistory();
  }

  get available() { return Boolean(this.bridge); }
  onChange(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed() { for (const listener of this.listeners) listener(); }

  // ── Who, keys, settings ────────────────────────────────────────────────────

  get isDeepSeek() { return this.deepSeek; }
  setDeepSeek(on: boolean) { if (on !== this.deepSeek) { this.deepSeek = on; this.changed(); } }
  keySourceOf(deep: boolean) { return this.keys[who(deep)]; }
  get keySource() { return this.keySourceOf(this.deepSeek); }
  get hasKey() { return Boolean(this.keySource); }
  hasKeyOf(deep: boolean) { return Boolean(this.keySourceOf(deep)); }
  async refreshKeys() {
    const result = await this.bridge?.keys().catch(() => undefined);
    if (result?.ok && result.keys) { this.keys = result.keys; this.encryptionAvailable = result.available !== false; this.changed(); }
  }
  async saveKey(deep: boolean, key: string) {
    if (!this.bridge) return "桌面版才能保存密钥";
    const result = await this.bridge.saveKey(who(deep), key).catch(error => ({ ok: false, error: String(error), keys: undefined }));
    if (!result.ok) return result.error ?? "没能保存";
    if (result.keys) this.keys = result.keys;
    this.lastError = "";
    this.changed();
    return "";
  }
  async forgetKey(deep: boolean) {
    const result = await this.bridge?.forgetKey(who(deep)).catch(() => undefined);
    if (result?.keys) this.keys = result.keys;
    this.changed();
  }

  linkOf(deep: boolean) { return this.links[deep ? 1 : 0]; }
  setLink(deep: boolean, link: Link) {
    const fallback = defaultLink(deep), to: Link = { ...link, format: link.format === "openai" ? "openai" : "anthropic" };
    to.base = to.base.trim() || fallback.base;
    to.model = to.model.trim() || fallback.model;
    to.fast = to.fast.trim() || to.model;
    to.fim = to.fim.trim();
    to.thinking = Math.min(4, Math.max(0, Math.round(to.thinking)));
    this.links[deep ? 1 : 0] = to;
    this.saveStore();
  }
  /** The official Anthropic API (its extras are sent only there: fallbacks, compaction, betas, workspaces). */
  isAnthropicProper(deep: boolean) { const link = this.linkOf(deep); return link.format === "anthropic" && link.base.includes("api.anthropic.com"); }
  /** A full URL on a maid's base: a base given with its path already is the URL itself. */
  endpoint(deep: boolean, path: string) {
    const base = this.linkOf(deep).base.replace(/\/+$/, "");
    return /\/(messages|completions)$/.test(base) ? base : base + path;
  }
  static modelsOf(deep: boolean) { return MODELS[who(deep)]; }
  get models() { return MaidAssistant.modelsOf(this.deepSeek); }
  modelIndexOf(deep: boolean) { return MODELS[who(deep)].findIndex(model => model.id === this.linkOf(deep).model); }
  get modelIndex() { return this.modelIndexOf(this.deepSeek); }
  setModelOf(deep: boolean, index: number) { const model = MODELS[who(deep)][index]; if (model) this.setLink(deep, { ...this.linkOf(deep), model: model.id }); }
  setModel(index: number) { this.setModelOf(this.deepSeek, index); }
  modelOf(deep: boolean) { return this.linkOf(deep).model; }
  get model() { return this.modelOf(this.deepSeek); }
  get modelName() { const at = this.modelIndex; return at >= 0 ? this.models[at].name : this.model; }
  get effortIndex() { return this.effort; }
  setEffort(index: number) { this.effort = Math.min(2, Math.max(0, index)); this.saveStore(); }
  get workspace() { return this.workspaceId; }
  setWorkspace(id: string) { this.workspaceId = id.trim().slice(0, 128); this.saveStore(); }
  get sharesTerminal() { return this.shareTerminal; }
  setShareTerminal(on: boolean) { this.shareTerminal = on; this.saveStore(); }
  get persists() { return this.persist; }
  setPersist(on: boolean) { this.persist = on; this.saveStore(); if (on) this.saveHistory(); else void this.bridge?.remove("history"); }
  get trustsReading() { return this.trustReading; }
  setTrustReading(on: boolean) { this.trustReading = on; this.saveStore(); }
  /** Command completion: 0 off, 1 on a chord, 2 also by itself when the typing stops. */
  get completes() { return this.completeMode; }
  setComplete(mode: number) { this.completeMode = Math.min(2, Math.max(0, mode)); this.saveStore(); if (!this.completeMode) this.cancelCompletion(); }
  /** She speaks unasked: 0 never, 1 when a command fails or is risky, 2 also when one goes well and now and then. */
  get proactive() { return this.proactiveMode; }
  setProactive(mode: number) { this.proactiveMode = Math.min(2, Math.max(0, mode)); this.saveStore(); }
  /** The command history: 0 keeps nothing, 1 keeps it, 2 also suggests from it as the reader types. */
  get historyChoice() { return this.historyMode; }
  setHistoryMode(mode: number) { this.historyMode = Math.min(2, Math.max(0, mode)); this.saveStore(); }
  get isBusy() { return this.busy; }
  get isRemarking() { return this.remarking; }
  get isCompleting() { return this.completing; }
  cancelCompletion() { this.completeTurn++; this.completing = false; }

  private loadStore() {
    let root: Json | null = null;
    try { root = parse(localStorage.getItem(STORE) ?? ""); } catch { root = null; }
    if (!root) return;
    const bool = (key: string, fallback: boolean) => typeof root![key] === "boolean" ? root![key] as boolean : fallback;
    const int = (key: string, fallback: number, max: number) => typeof root![key] === "number" ? Math.min(max, Math.max(0, Math.round(root![key] as number))) : fallback;
    this.shareTerminal = bool("shareTerminal", false);
    this.persist = bool("persist", false);
    this.trustReading = bool("trustReading", false);
    this.completeMode = int("completeMode", 0, 2);
    this.proactiveMode = int("proactive", 0, 2);
    this.historyMode = int("history", 2, 2);
    this.effort = int("effort", 2, 2);
    this.workspaceId = typeof root.workspace === "string" ? root.workspace : "";
    for (const [index, key] of ["claudeLink", "deepseekLink"].entries()) {
      const saved = root[key] as Partial<Link> | undefined;
      if (!saved || typeof saved !== "object") continue;
      const link = { ...defaultLink(index === 1) };
      if (saved.format === "openai" || saved.format === "anthropic") link.format = saved.format;
      for (const field of ["base", "model", "fast", "fim"] as const) if (typeof saved[field] === "string") link[field] = saved[field];
      if (typeof saved.thinking === "number") link.thinking = Math.min(4, Math.max(0, Math.round(saved.thinking)));
      this.links[index] = link;
    }
  }
  private saveStore() {
    try {
      localStorage.setItem(STORE, json({ shareTerminal: this.shareTerminal, persist: this.persist, trustReading: this.trustReading, completeMode: this.completeMode,
        proactive: this.proactiveMode, history: this.historyMode, effort: this.effort, workspace: this.workspaceId, claudeLink: this.links[0], deepseekLink: this.links[1] }));
    } catch { /* private window: this session only */ }
    this.changed();
  }

  // ── The log ────────────────────────────────────────────────────────────────

  addEntry(kind: EntryKind, text: string, subject = "", state: EntryState = "none") {
    this.log.push({ kind, text, subject, outcome: "", state, at: now() });
    this.logRevision++;
    this.changed();
    return this.log.length - 1;
  }
  updateEntry(index: number, state: EntryState, outcome: string) {
    const entry = this.log[index];
    if (!entry) return;
    entry.state = state; entry.outcome = outcome;
    this.logRevision++;
    this.changed();
  }

  // ── Conversations ──────────────────────────────────────────────────────────

  get allConversations(): readonly Conversation[] { return this.conversations; }
  get currentConversation() { return this.current; }
  get conversationIsDeepSeek() { return this.conversations[this.current]?.deepSeek ?? this.deepSeek; }
  private stash() { const c = this.conversations[this.current]; if (c) { c.messages = this.messages; c.log = this.log; c.historyModel = this.historyModel; } }
  private unstash(index: number) {
    const c = this.conversations[index];
    if (!c) return;
    this.current = index;
    this.messages = c.messages; this.log = c.log; this.historyModel = c.historyModel;
    this.round = []; this.pending = []; this.results = [];
    this.logRevision++; this.conversationRevision++;
    this.changed();
  }
  private latestFor(host: string) {
    let best = -1;
    this.conversations.forEach((c, i) => { if (c.host === host && c.deepSeek === this.deepSeek && (best < 0 || c.updated > this.conversations[best].updated)) best = i; });
    return best;
  }
  /** The conversations of a host, latest first. */
  conversationsFor(host: string) {
    return this.conversations.map((c, i) => [c, i] as const).filter(([c]) => c.host === host && c.deepSeek === this.deepSeek)
      .sort(([a], [b]) => b.updated - a.updated).map(([, i]) => i);
  }
  entryCount(index: number) { return index === this.current ? this.log.length : this.conversations[index]?.log.length ?? 0; }
  /** Shows a host's latest conversation (a new, empty one when it has none). Not while she is at work. */
  followHost(host: string, hostName: string) {
    const shown = this.conversations[this.current];
    if (this.busy || (shown && shown.host === host && shown.deepSeek === this.deepSeek)) return;
    const latest = this.latestFor(host);
    if (latest >= 0) { this.stash(); this.unstash(latest); return; }
    this.newConversation(host, hostName);
  }
  /** Begins another conversation for a host and shows it (the empty one on show is kept instead of a second). */
  newConversation(host: string, hostName: string) {
    if (this.busy) return;
    const shown = this.conversations[this.current];
    if (shown && shown.host === host && shown.deepSeek === this.deepSeek && !this.log.length && !this.messages.length) return;
    this.stash();
    this.conversations.push({ id: crypto.randomUUID(), host, hostName, title: "", historyModel: "", deepSeek: this.deepSeek, format: "", created: now(), updated: now(), messages: [], log: [] });
    this.unstash(this.conversations.length - 1);
    this.saveHistory();
  }
  switchConversation(index: number) {
    if (this.busy || !this.conversations[index]) return false;
    if (index !== this.current) { this.stash(); this.unstash(index); this.saveHistory(); }
    return true;
  }
  /** Deletes one (stopping her first if it is hers at work); the one on show then is that host's next latest, or a new one. */
  deleteConversation(index: number) {
    const gone = this.conversations[index];
    if (!gone) return;
    if (index === this.current && this.busy) this.stop();
    this.stash();
    const shown = index === this.current;
    this.conversations.splice(index, 1);
    if (shown) {
      this.current = -1;
      this.messages = []; this.log = []; this.historyModel = "";
      const next = this.latestFor(gone.host);
      if (next >= 0) this.unstash(next); else this.newConversation(gone.host, gone.hostName);
    } else if (this.current > index) this.current--;
    this.conversationRevision++; this.logRevision++;
    this.saveHistory();
    if (this.persist && !this.conversations.some(c => c.log.length || c.messages.length)) void this.bridge?.remove("history");
    this.changed();
  }
  /** Begins the conversation on show again (its history and log; it keeps its place and host). */
  reset() {
    this.messages = []; this.round = []; this.pending = []; this.results = []; this.log = []; this.historyModel = "";
    this.turn++; this.logRevision++; this.conversationRevision++; this.busy = false;
    const c = this.conversations[this.current];
    if (c) { c.title = ""; c.updated = now(); c.messages = this.messages; c.log = this.log; }
    this.saveHistory();
    this.changed();
  }

  private saveHistory() {
    if (!this.persist || !this.bridge) return;
    this.stash();
    // Sealed like the key: the conversations may hold what the terminal showed. One never spoken in is not kept.
    const kept = this.conversations.filter(c => c.messages.length || c.log.length).map(c => ({
      ...c, log: c.log.map(entry => ({ ...entry, outcome: entry.outcome.slice(-20000) })),
    }));
    void this.bridge.write("history", json({ conversations: kept, current: this.conversations[this.current]?.id ?? "" }));
  }
  private async loadHistory() {
    const result = await this.bridge?.read("history").catch(() => undefined);
    const root = result?.ok && result.text ? parse(result.text) : null;
    const list = Array.isArray(root?.conversations) ? root!.conversations as Partial<Conversation>[] : [];
    if (!list.length || this.conversations.some(c => c.log.length)) return;
    for (const one of list) {
      if (!one || typeof one !== "object") continue;
      const deepSeek = one.deepSeek === true;
      this.conversations.push({
        id: typeof one.id === "string" && one.id ? one.id : crypto.randomUUID(), host: String(one.host ?? ""), hostName: String(one.hostName ?? ""),
        title: String(one.title ?? ""), historyModel: String(one.historyModel ?? ""), deepSeek, format: String(one.format ?? (deepSeek ? "openai" : "anthropic")),
        created: Number(one.created) || now(), updated: Number(one.updated) || now(), messages: Array.isArray(one.messages) ? one.messages : [],
        // What was waiting or running when the app closed did not finish.
        log: (Array.isArray(one.log) ? one.log : []).map(entry => entry.state === "waiting" || entry.state === "running" ? { ...entry, state: "failed" as const, outcome: "应用关闭时还没有完成" } : entry),
      });
    }
    const shown = this.conversations.findIndex(c => c.id === root?.current);
    if (shown >= 0) this.unstash(shown);
    this.conversationRevision++;
    this.changed();
  }

  // ── The command history ────────────────────────────────────────────────────

  get historyCount() { return this.commands.length; }
  recordCommand(host: string, command: string) {
    if (this.historyMode === 0 || !command || command.startsWith(" ") || command.length > 1000 || /[\x00-\x1f\x7f]/.test(command)) return;
    const text = command.trim();
    if (!text || looksSecret(text)) return;
    // Used again, it moves to the end: the newest is the one suggested.
    this.commands = this.commands.filter(use => !(use.host === host && use.text === text));
    this.commands.push({ host, text, at: now() });
    if (this.commands.length > 2000) this.commands.splice(0, this.commands.length - 2000);
    void this.bridge?.write("commands", json({ commands: this.commands }));
  }
  /** The whole command the reader most likely means by what they typed: the latest on this host that begins with it, else on any. */
  fromHistory(host: string, typed: string) {
    if (!typed.trimStart()) return "";
    let elsewhere = "";
    for (let i = this.commands.length - 1; i >= 0; i--) {
      const use = this.commands[i];
      if (use.text.length <= typed.length || !use.text.startsWith(typed)) continue;
      if (use.host === host) return use.text;
      elsewhere ||= use.text;
    }
    return elsewhere;
  }
  /** The last `count` different commands on a host, one to a line, oldest first. */
  historyFor(host: string, count: number) {
    const picked: string[] = [];
    for (let i = this.commands.length - 1; i >= 0 && picked.length < count; i--) if (this.commands[i].host === host) picked.push(this.commands[i].text);
    return picked.reverse().map(line => line + "\n").join("");
  }
  forgetHistory() { this.commands = []; void this.bridge?.remove("commands"); this.changed(); }
  private async loadCommands() {
    const result = await this.bridge?.read("commands").catch(() => undefined);
    const root = result?.ok && result.text ? parse(result.text) : null;
    if (Array.isArray(root?.commands)) this.commands = (root!.commands as CommandUse[]).filter(use => use && typeof use.text === "string" && use.text);
  }

  // ── Asking ─────────────────────────────────────────────────────────────────

  private finish(line: string, error = "") {
    this.busy = false;
    const c = this.conversations[this.current];
    if (c) { c.updated = now(); this.conversationRevision++; }
    if (!error) this.addEntry("claude", line);
    else { const at = this.addEntry("error", line); this.updateEntry(at, "none", error); }
    this.reply = line;
    this.lastError = error;
    this.replySerial++;
    this.repliedAt = performance.now() / 1000;
    this.saveHistory();
    this.changed();
  }

  /** Sends what the reader typed with what she can see right now, and runs the tool loop; the answer arrives in `reply`. */
  ask(text: string, context: string, run: RunTool) {
    const said = text.trim();
    if (this.busy || !said) return;
    if (!this.hasKey) {
      this.finish(this.deepSeek ? "主人，我还没有 DeepSeek 的钥匙！请在 设置 → 看板娘 里填入 API key。" : "主人，我还没有钥匙。请在 设置 → 看板娘 里填入 API key。");
      return;
    }
    if (!this.conversations[this.current]) this.newConversation("", "");
    // The API sums up old turns itself; this is only the stop for a conversation that never ends.
    if (this.messages.length >= 1000) this.messages.splice(0);
    const c = this.conversations[this.current];
    if (c) {
      const shape = this.linkOf(c.deepSeek).format;
      if (!c.format) c.format = shape;
      if (c.format !== shape) {
        this.messages.splice(0); this.historyModel = ""; c.format = shape;
        this.addEntry("error", "接口格式换了：从这里起重新开始上下文（上面的话还在面板里）。");
      }
    }
    const deep = this.conversationIsDeepSeek;
    // Another model from here on: the thinking in her earlier turns was signed by the one before, and is let go.
    if (this.linkOf(deep).format === "anthropic" && this.historyModel && this.historyModel !== this.modelOf(deep))
      for (const turn of this.messages) {
        if (turn.role !== "assistant" || !Array.isArray(turn.content)) continue;
        const kept = (turn.content as Json[]).filter(block => block?.type !== "thinking" && block?.type !== "redacted_thinking");
        // A turn of nothing but thinking keeps a word, so the turns still alternate.
        turn.content = kept.length ? kept : [{ type: "text", text: "…" }];
      }
    this.historyModel = this.modelOf(deep);
    this.messages.push({ role: "user", content: `<context>\n${context}\n</context>\n\n${said}` });
    if (c) { if (!c.title) c.title = [...said.replace(/\n/g, " ")].slice(0, 28).join(""); c.updated = now(); this.conversationRevision++; }
    this.addEntry("user", said);
    this.runTool = run;
    this.rounds = 0;
    this.busy = true;
    this.changed();
    this.send();
  }

  /** Ends what she is doing: the request out is let go, tools not yet run are called off (the history stays whole). */
  stop() {
    if (!this.busy) return;
    this.turn++;
    if (this.requestId) void this.bridge?.cancel(this.requestId);
    if (this.round.length) {
      for (const call of this.round) {
        if (this.results.some(result => result.tool_use_id === call.id)) continue;
        this.results.push({ type: "tool_result", tool_use_id: call.id, content: "主人叫停了，没有执行。", is_error: true });
      }
      this.appendResults();
      this.round = []; this.pending = []; this.results = [];
    }
    for (const entry of this.log) if (entry.state === "waiting" || entry.state === "running") { entry.state = "refused"; entry.outcome = "已叫停"; }
    this.finish(this.conversationIsDeepSeek ? "收到主人，我停下啦！" : "好的主人，我停下了。");
  }

  private send() { if (this.linkOf(this.conversationIsDeepSeek).format === "openai") this.sendOpenAI(); else this.sendAnthropic(); }

  private async post(deep: boolean, url: string, body: Json, timeout: number, extra: { beta?: string; workspace?: string } = {}) {
    const id = crypto.randomUUID();
    this.requestId = id;
    const auth = this.linkOf(deep).format === "openai" ? "bearer" as const : "anthropic" as const;
    const result = await this.bridge!.request({ id, who: who(deep), url, body: json(body), auth, timeout, ...extra })
      .catch(error => ({ ok: false, status: 0, text: "", error: String(error) }));
    if (this.requestId === id) this.requestId = "";
    return result;
  }

  private sendAnthropic() {
    const deep = this.conversationIsDeepSeek, proper = this.isAnthropicProper(deep), link = this.linkOf(deep);
    const body: Json = { model: link.model, max_tokens: 16000 };
    // How hard she thinks: Claude's effort; on another server her link's thinking (off, or an effort; or nothing).
    const levels = ["", "low", "high", "max"];
    const output: Json = {};
    if (!deep) output.effort = EFFORTS[this.effort];
    else if (link.thinking >= 1 && link.thinking <= 3) output.effort = levels[link.thinking];
    if (Object.keys(output).length) body.output_config = output;
    if (deep && link.thinking === 0) body.thinking = { type: "disabled" };
    body.system = deep ? WHALE_PERSONA : PERSONA;
    // Strict tools are Anthropic's own.
    body.tools = proper ? TOOLS : TOOLS.map(({ strict: _strict, ...tool }) => tool);
    body.messages = this.messages;
    if (proper) {
      // A request the safeguards decline is tried again on the model Anthropic names for that category; a long
      // conversation is summed up on the server as it nears the limit (its block comes back in her turn).
      body.fallbacks = "default";
      body.cache_control = { type: "ephemeral" };
      body.context_management = { edits: [{ type: "compact_20260112" }] };
    }
    const sent = this.turn;
    void this.post(deep, this.endpoint(deep, "/v1/messages"), body, 180, proper ? { beta: "server-side-fallback-2026-07-01,compact-2026-01-12", workspace: this.workspaceId || undefined } : {})
      .then(result => { if (sent === this.turn) this.receiveAnthropic(result.status, result.text, result.ok); });
  }

  private receiveAnthropic(code: number, text: string, connected: boolean) {
    // Whatever went wrong, the history stays as it is: a question with no answer is followed by the next one.
    if (!connected || code === 0) { this.finish("主人，我连不上外面的网络……", "no connection"); return; }
    const root = parse(text);
    if (code !== 200 || !root) {
      const why = `HTTP ${code} ${errorOf(root)}`.trim();
      this.finish(code === 401 ? "主人，这把钥匙打不开门，请检查 API key。" : code === 429 ? "主人，问得太快了，请稍等一下再问我。" : code >= 500 ? "主人，那边现在很忙，过一会儿再试试吧。"
        : why.includes("credit balance") ? "主人，这个月的 API 额度用完了。" : "主人，这次没问成。原因我记在 设置 → 看板娘 里了。", why);
      return;
    }
    const ended = String(root.stop_reason ?? "");
    const content = Array.isArray(root.content) ? root.content as Json[] : null;
    if (ended === "refusal") { this.finish("主人，这件事我帮不上忙。", "refusal"); return; }
    if (!content) { this.finish("主人，我没听清……", "empty response"); return; }
    // Her turn goes back exactly as it came (thinking blocks and all).
    this.messages.push({ role: "assistant", content });
    let said = "", thought = "";
    this.round = []; this.pending = []; this.results = [];
    for (const block of content) {
      if (block?.type === "text") said += String(block.text ?? "");
      else if (block?.type === "thinking") thought += String(block.thinking ?? "");
      else if (block?.type === "tool_use" && ended === "tool_use")
        this.round.push({ id: String(block.id), name: String(block.name), input: block.input && typeof block.input === "object" ? block.input as Json : {} });
    }
    this.afterTurn(said.trim(), thought.trim(), "主人，这件事我做了二十多步还没做完，先停在这里，您看看要不要继续。");
  }

  private sendOpenAI() {
    const deep = this.conversationIsDeepSeek, link = this.linkOf(deep);
    const body: Json = { model: link.model, max_tokens: 16000 };
    // Thinking (DeepSeek's switch, and how hard), unless it is left to the server.
    if (link.thinking <= 3) {
      body.thinking = { type: link.thinking ? "enabled" : "disabled" };
      if (link.thinking) body.reasoning_effort = ["", "low", "high", "max"][link.thinking];
    }
    body.messages = [{ role: "system", content: deep ? WHALE_PERSONA : PERSONA }, ...this.messages];
    body.tools = TOOLS.map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }));
    const sent = this.turn;
    void this.post(deep, this.endpoint(deep, "/chat/completions"), body, 180).then(result => { if (sent === this.turn) this.receiveOpenAI(result.status, result.text, result.ok); });
  }

  private receiveOpenAI(code: number, text: string, connected: boolean) {
    const whale = this.conversationIsDeepSeek;
    if (!connected || code === 0) { this.finish(whale ? "主人，我游不出去……网络连不上！" : "主人，我连不上外面的网络……", "no connection"); return; }
    const root = parse(text);
    if (code !== 200 || !root) {
      const why = `HTTP ${code} ${errorOf(root)}`.trim();
      this.finish(code === 401 ? "主人，这把钥匙打不开门！检查一下 API key 吧。" : code === 402 ? "主人，账户的余额用完啦，充一点我才能继续游～"
        : code === 429 ? "主人问得太快啦，等我喘口气再问！" : code >= 500 ? "主人，那边浪太大了，过一会儿再试试吧。" : "主人，这次没问成，原因记在 设置 → 看板娘 里了。", why);
      return;
    }
    const choice = Array.isArray(root.choices) ? (root.choices as Json[])[0] : undefined;
    const message = choice?.message as Json | undefined;
    if (!message || typeof message !== "object") { this.finish("主人，我没听清……", "empty response"); return; }
    // Her turn back into the history: what she said, what she reasoned (DeepSeek wants it sent back with every later
    // request of a conversation with tools), and the calls she made.
    const said = String(message.content ?? ""), reasoned = String(message.reasoning_content ?? "");
    const assistant: Json = { role: "assistant", content: said };
    if (reasoned) assistant.reasoning_content = reasoned;
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls as Json[] : [];
    if (calls.length) assistant.tool_calls = calls;
    this.messages.push(assistant);
    this.round = []; this.pending = []; this.results = [];
    for (const call of calls) {
      const fn = call?.function as Json | undefined;
      if (!fn) continue;
      this.round.push({ id: String(call.id), name: String(fn.name), input: parse(String(fn.arguments ?? "")) ?? {} });
    }
    this.afterTurn(said.trim(), reasoned.trim(), "主人，这件事我扑腾了二十多步还没做完，先停在这里，你看看要不要继续？");
  }

  /** Her turn read: what she thought stands folded, what she said on her way to the tools stands too, then the tools. */
  private afterTurn(said: string, thought: string, tooLong: string) {
    if (thought) this.addEntry("thought", thought);
    if (!this.round.length) { this.finish(said || "……"); return; }
    if (said) this.addEntry("claude", said);
    this.pending = [...this.round];
    if (++this.rounds > 25) {
      this.pending = [];
      this.stop();
      this.reply = tooLong;
      const last = this.log.at(-1);
      if (last) { last.text = tooLong; this.logRevision++; }
      this.changed();
      return;
    }
    this.runNext();
  }

  /** This round's results into the history, in the shape of the conversation's API. */
  private appendResults() {
    if (this.linkOf(this.conversationIsDeepSeek).format === "openai") {
      for (const result of this.results)
        this.messages.push({ role: "tool", tool_call_id: result.tool_use_id, content: (result.is_error ? "（出错）" : "") + String(result.content) });
      return;
    }
    this.messages.push({ role: "user", content: this.results });
  }

  private runNext() {
    if (!this.pending.length) {
      // Every result of the round, then on to her next turn.
      this.appendResults();
      this.round = []; this.results = [];
      this.send();
      return;
    }
    const call = this.pending.shift()!, sent = this.turn;
    const done: ToolDone = (outcome, error) => {
      // Stopped, or begun again, while the reader was deciding.
      if (sent !== this.turn) return;
      const result: Json = { type: "tool_result", tool_use_id: call.id, content: outcome || "（没有输出）" };
      if (error) result.is_error = true;
      this.results.push(result);
      this.runNext();
    };
    if (this.runTool) this.runTool(call, done); else done("no tool runner", true);
  }

  // ── Quick answers: completion, remarks ─────────────────────────────────────

  /** One short JSON answer through a maid's link (her quick model, no thinking). */
  private async askJson(deep: boolean, system: string, schema: Json, user: string, maxTokens: number): Promise<{ answer: Json | null; error: string }> {
    const link = this.linkOf(deep);
    if (link.format === "openai") {
      const body = {
        model: link.fast, max_tokens: maxTokens, response_format: { type: "json_object" }, ...(link.thinking <= 3 ? { thinking: { type: "disabled" } } : {}),
        messages: [{ role: "system", content: `${system}\n\n只输出一个 JSON 对象（json），符合这个 JSON Schema：${json(schema)}` }, { role: "user", content: user }],
      };
      const result = await this.bridge!.request({ who: who(deep), url: this.endpoint(deep, "/chat/completions"), body: json(body), auth: "bearer", timeout: 30 }).catch(() => ({ ok: false, status: 0, text: "" }));
      const root = parse(result.text);
      const content = (((root?.choices as Json[] | undefined)?.[0]?.message) as Json | undefined)?.content;
      const answer = result.status === 200 && typeof content === "string" ? parse(content) : null;
      return answer ? { answer, error: "" } : { answer: null, error: `HTTP ${result.status} ${errorOf(root)}`.trim() };
    }
    const proper = this.isAnthropicProper(deep);
    const body: Json = {
      model: link.fast, max_tokens: maxTokens, thinking: { type: "disabled" },
      // Anthropic holds the reply to the schema; another server is told it in words.
      output_config: proper ? { effort: "low", format: schema } : { effort: "low" },
      system: proper ? system : `${system}\n\n只输出一个 JSON 对象，不要别的文字，符合这个 JSON Schema：${json(schema)}`,
      messages: [{ role: "user", content: user }],
    };
    const result = await this.bridge!.request({ who: who(deep), url: this.endpoint(deep, "/v1/messages"), body: json(body), auth: "anthropic", timeout: 30, workspace: proper && this.workspaceId ? this.workspaceId : undefined })
      .catch(() => ({ ok: false, status: 0, text: "" }));
    const root = parse(result.text);
    if (result.status === 200 && root?.stop_reason === "end_turn" && Array.isArray(root.content)) {
      const said = (root.content as Json[]).filter(block => block?.type === "text").map(block => String(block.text ?? "")).join("");
      const answer = parse(said);
      if (answer) return { answer, error: "" };
    }
    return { answer: null, error: `HTTP ${result.status} ${errorOf(root) || String(root?.stop_reason ?? "")}`.trim() };
  }

  /**
   * Asks for the rest of the command line. `screen` is the terminal's last lines with the cursor drawn as █; `recent`
   * the commands run lately; `history` the reader's own on this host. Resolves with the text to type at the cursor
   * (empty for nothing, or a failure); a newer request, or cancelCompletion, drops an older one's answer (null).
   */
  async complete(screen: string, recent: string, history: string): Promise<string | null> {
    if (!this.hasKey || !screen || !this.bridge) return "";
    const sent = ++this.completeTurn;
    this.completing = true;
    const link = this.linkOf(this.deepSeek);
    let insert = "", error = "";
    if (!link.fim) {
      const user = `<recent_commands>\n${recent}</recent_commands>\n<history>\n${history}</history>\n<screen>\n${screen}</screen>`;
      const result = await this.askJson(this.deepSeek, COMPLETER, COMPLETION_SCHEMA, user, 512);
      insert = typeof result.answer?.insert === "string" ? result.answer.insert : "";
      error = result.error;
    } else {
      // Fill in the middle (DeepSeek's /beta/completions): what the reader ran before and the screen up to the cursor
      // as the text before the gap; what comes back goes into the gap, up to the line's end.
      const cursor = screen.indexOf("█");
      const before = ("# Shell commands this user ran on this host before, oldest first:\n" + history + recent + "\n# The terminal now (the last line is being typed):\n"
        + (cursor >= 0 ? screen.slice(0, cursor) : screen)).slice(-6000);
      const body = { model: link.fast, prompt: before, suffix: "", max_tokens: 64, stop: ["\n"] };
      const result = await this.bridge.request({ who: who(this.deepSeek), url: link.fim, body: json(body), auth: link.format === "openai" ? "bearer" : "anthropic", timeout: 20 })
        .catch(() => ({ ok: false, status: 0, text: "" }));
      const root = parse(result.text), text = ((root?.choices as Json[] | undefined)?.[0]?.text);
      if (result.status === 200 && typeof text === "string") insert = text.split("\n")[0].trimEnd();
      else error = `FIM HTTP ${result.status} ${errorOf(root)}`.trim();
    }
    // Asked again, or called off, since.
    if (sent !== this.completeTurn) return null;
    this.completing = false;
    if (error) { this.lastError = "补全 " + error; this.changed(); }
    // What is typed for the reader is one plain line, whatever came back.
    if (/[\x00-\x1f\x7f]/.test(insert) || insert.length > 400) insert = "";
    return insert;
  }

  /** A remark of her own on a command and what it printed: one short line (empty: nothing to say) and a mood. */
  async remark(trigger: string, command: string, output: string): Promise<{ say: string; mood: number }> {
    if (!this.hasKey || this.remarking || !this.bridge) return { say: "", mood: 0 };
    this.remarking = true;
    const user = `<trigger>${trigger}</trigger>\n<command>${command}</command>\n<output>\n${output}\n</output>`;
    const result = await this.askJson(this.deepSeek, this.deepSeek ? WHALE_REMARKER : REMARKER, REMARK_SCHEMA, user, 300);
    this.remarking = false;
    if (!result.answer) { this.lastError = "搭话 " + result.error; this.changed(); return { say: "", mood: 0 }; }
    const mood = Math.max(0, MOODS.indexOf(String(result.answer.mood ?? "none") as typeof MOODS[number]));
    return { say: [...String(result.answer.say ?? "").trim()].slice(0, 120).join(""), mood };
  }
}

/**
 * In a dev server only, ?maid-stand-in=PORT stands a local stand-in of the two APIs in for the desktop's bridge (its
 * /claude, /deepseek and /fim; the key is not needed there), to see her panel and her tools without the desktop shell.
 */
function devBridge(): MaidBridge | undefined {
  if (!import.meta.env.DEV) return undefined;
  const port = new URLSearchParams(location.search).get("maid-stand-in");
  if (!port || !/^\d+$/.test(port)) return undefined;
  const keys = { claude: "env" as const, deepseek: "env" as const };
  return {
    keys: async () => ({ ok: true, keys, available: true }),
    saveKey: async () => ({ ok: true, keys }),
    forgetKey: async () => ({ ok: true, keys }),
    request: async request => {
      const path = request.url.includes("/beta/completions") || request.url.endsWith("/fim") ? "fim" : request.auth === "bearer" ? "deepseek" : "claude";
      try {
        const response = await fetch(`http://127.0.0.1:${port}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: request.body });
        return { ok: true, status: response.status, text: await response.text() };
      } catch (error) { return { ok: false, status: 0, text: "", error: String(error) }; }
    },
    cancel: async () => ({ ok: true }),
    read: async name => ({ ok: true, text: localStorage.getItem("dev-maid-" + name) ?? "" }),
    write: async (name, text) => { localStorage.setItem("dev-maid-" + name, text); return { ok: true }; },
    remove: async name => { localStorage.removeItem("dev-maid-" + name); return { ok: true }; },
    window: async () => ({ ok: true }),
  };
}

/** The one assistant (desktop: the bridge is there; elsewhere it answers that it cannot). */
export const maidAssistant = new MaidAssistant(typeof window !== "undefined" ? window.rhineDesktop?.maid ?? devBridge() : undefined);
