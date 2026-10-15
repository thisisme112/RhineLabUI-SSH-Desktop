import type { Terminal } from "@xterm/xterm";
import { LOOK_COUNT, lookName, pick } from "../maid-lines";
import { maidPrefs, setMaidPrefs } from "../maid-prefs";
import type { Mascot } from "../../theme/theme-design";
import { MOOD, maidAssistant, type RunTool, type ToolCall, type ToolDone } from "./maid-assistant";
import { FAILURES, RISKS, SUCCESSES, bubbled, hasAny, holdOf, isOneLine, isReading, isSecretPath, remarkHoldOf } from "./maid-safety";

/**
 * The workbench's half of the maid (the Unreal build's RhineClaudeUi.cpp): what she is told of the workbench with
 * each question, the tools she works with and the reader's say over them, a command run in plain sight in the
 * reader's own shell and read back by a marker it prints when done, the line her bubble shows and her face, what
 * she says unasked on a command the reader ran, and command completion (asked for, or from the reader's record).
 */
export type MaidHost = { key: string; name: string; user: string; host: string; port: string; password: boolean; state: string };
/** The session on show, as she reads and types into it. */
export type MaidSession = {
  key: string;
  generation: number;
  hostKey: string;
  running: boolean;
  reachedShell: boolean;
  interactive: boolean;
  prompt: boolean;
  term: Terminal;
  /** Bytes typed into it, and a number that changes whenever what it shows does. */
  sent: number;
  shown: number;
  send(data: string): void;
  filesReady: boolean;
  readFile(path: string): Promise<{ ok: boolean; text?: string; error?: string }>;
};
export type WorkbenchHooks = {
  who(): Mascot;
  hosts(): MaidHost[];
  selected(): number;
  page(): "terminal" | "host_file" | "hosts" | "home";
  session(): MaidSession | null;
  /** The selected host has a session running. */
  selectedRunning(): boolean;
  monitor(): string;
  focusHost(index: number): void;
  connectSelected(): void;
  openTerminal(): void;
  closeTerminal(): void;
  openHostFile(): void;
  showHome(overview: boolean): void;
  openSettings(section: string): void;
  setTheme(name: string): string | null;
  setTerminalStyle(size: number, line: number): Promise<{ size: number; line: number }>;
  setWindow(mode: "windowed" | "maximized" | "fullscreen"): void;
  setSound(on: boolean, volume: number): number;
  copy(text: string): void;
  disconnectSelected(): void;
  selectPanel(page: "terminal" | "files" | "monitor"): boolean;
  openPanel(): void;
  play(cue: "confirm" | "ui-tick" | "scan" | "open" | "page-close"): void;
};

type Asking = { kind: "run" | "read" | "act"; entry: number; subject: string; timeout: number; done: ToolDone; act?: () => { text: string; error: boolean } };
type Run = { command: string; nonce: string; entry: number; session: string; generation: number; timeout: number; startedAt: number; from: number; done: ToolDone };
const time = () => performance.now() / 1000;
const MARK = "█";

/** The lines of a terminal's buffer, its scrollback and screen, trimmed at the end. */
function lines(term: Terminal) {
  const buffer = term.buffer.active, out: string[] = [];
  for (let i = 0; i < buffer.length; i++) out.push(buffer.getLine(i)?.translateToString(true) ?? "");
  while (out.length && !out.at(-1)) out.pop();
  return out;
}
/** The screen's rows with the cursor drawn in as █. */
function screenWithCursor(term: Terminal) {
  const buffer = term.buffer.active, rows: string[] = [];
  const cursorRow = buffer.baseY + buffer.cursorY;
  for (let i = buffer.viewportY; i < buffer.viewportY + term.rows && i < buffer.length; i++) {
    const line = buffer.getLine(i)?.translateToString(false) ?? "";
    if (i === cursorRow) {
      const chars = [...line];
      while (chars.length < buffer.cursorX) chars.push(" ");
      chars.splice(buffer.cursorX, 0, MARK);
      rows.push(chars.join("").trimEnd());
    } else rows.push(line.trimEnd());
  }
  return rows;
}
/** The cursor's line split at the cursor (the right without its trailing blanks). */
function cursorRow(term: Terminal) {
  for (const row of screenWithCursor(term)) {
    const at = row.indexOf(MARK);
    if (at >= 0) return { left: row.slice(0, at), right: row.slice(at + 1).trimEnd() };
  }
  return null;
}
const alternate = (term: Terminal) => term.buffer.active.type === "alternate";

export class MaidWorkbench {
  /** Her panel is open. */
  panelOpen = false;
  /** A step waiting on the reader (its entry in the log), and a command of hers running in the terminal. */
  asking: Asking | null = null;
  run: Run | null = null;
  mood = 0;
  moodAt = -100;
  gladAt = -100;
  remarkLine = "";
  remarkAt = -100;
  /** The grey suggestion after the cursor, whether it is from the reader's record, and the strip's note. */
  suggestion = "";
  fromHistory = false;
  stripNote = "";
  stripNoteUntil = 0;
  private recent: string[] = [];
  private lastRemarkAt = -100;
  private watchAt = -1;
  private watchLines = 0;
  private watchSerial = "";
  private watchShown = 0;
  private changedAt = 0;
  private command = "";
  private prompt = "";
  private promptSerial = "";
  private lineFresh = true;
  private lineTyped = "";
  private lineExact = false;
  private typedLetters = 0;
  private typedAt = -1;
  private keyAt = -100;
  private autoAt = -100;
  private completeSerial = "";
  private completeSent = 0;
  private historyTyped = "";
  private historyDismissed = "";
  private historyKey = "";
  private followed = "";
  private replySeen = 0;
  private runLookedAt = 0;

  constructor(private hooks: WorkbenchHooks) {}

  // ── Her bubble and her face ────────────────────────────────────────────────

  /** Her own line over the state's (a question waiting, her work, her answer, a remark), or empty. */
  override() { return this.line(""); }
  /** What her bubble says: a question waiting, her work, her answer, a remark, or the host's state. */
  line(status: string) {
    const a = maidAssistant, who = this.hooks.who();
    if (this.asking) return pick(who, "主人，这一步要您在对话面板里点头。", "主人，这一步要你在对话面板里点头哦！");
    if (a.isBusy) return this.run ? "正在终端里跑命令……" : "……让我想想。";
    if (a.replySerial > 0 && time() - a.repliedAt < holdOf(a.reply)) return this.panelOpen ? [...a.reply].slice(0, 36).join("") + ([...a.reply].length > 36 ? "……" : "") : bubbled(a.reply);
    if (this.remarkLine && time() - this.remarkAt < remarkHoldOf(this.remarkLine)) return this.remarkLine;
    return status;
  }
  /** How long a line of hers stays in the terminal's bubble. */
  hold() {
    const a = maidAssistant;
    return a.isBusy || this.asking ? 600 : a.replySerial > 0 && time() - a.repliedAt < holdOf(a.reply) ? holdOf(a.reply)
      : this.remarkLine && time() - this.remarkAt < remarkHoldOf(this.remarkLine) ? remarkHoldOf(this.remarkLine) : 5;
  }
  /** Her face: a mood for six seconds (or as long as the remark it came with), thinking while she works. */
  face() {
    const now = time();
    if (this.mood > 0 && (now - this.moodAt < 6 || (this.remarkLine && this.remarkAt >= this.moodAt - 1 && now - this.remarkAt < remarkHoldOf(this.remarkLine)))) return this.mood;
    return this.asking || maidAssistant.isBusy ? MOOD.thinking : 0;
  }
  /** Her mouth moves forty letters a second as the bubble writes, four seconds at most. */
  talking() {
    const a = maidAssistant, now = time();
    if (a.replySerial > 0 && now - a.repliedAt < Math.min(4, [...a.reply].length / 40)) return true;
    return Boolean(this.remarkLine) && now - this.remarkAt < Math.min(4, [...this.remarkLine].length / 40);
  }

  // ── What she sees ──────────────────────────────────────────────────────────

  context() {
    const h = this.hooks, hosts = h.hosts(), selected = hosts[h.selected()];
    const out: string[] = [];
    const d = new Date(), pad = (n: number) => String(n).padStart(2, "0");
    out.push(`时间：${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`);
    out.push(`页面：${({ terminal: "终端", host_file: "主机档案页", hosts: "主机总览", home: "主页档案阵列" })[h.page()]}`);
    out.push(selected ? `选中主机：${selected.name}（${selected.user}@${selected.host}:${selected.port}，${selected.password ? "密码认证" : "密钥认证"}，${selected.state}）` : "选中主机：无");
    out.push(`主机列表（${hosts.length} 台）：${hosts.slice(0, 60).map(host => `${host.name}[${host.state}]`).join("、")}`);
    const monitor = h.monitor();
    if (monitor) out.push(monitor);
    if (this.recent.length) out.push("最近执行的命令：\n" + this.recent.join("\n"));
    const session = h.session();
    if (!maidAssistant.sharesTerminal) out.push("终端内容：未共享");
    else if (!session?.reachedShell) out.push("终端内容：当前没有已接通的会话");
    else out.push("<terminal_screen>\n" + lines(session.term).slice(-40).join("\n").slice(-4000) + "\n</terminal_screen>");
    return out.join("\n");
  }

  /** Why she may not type at the shell now (empty: she may). */
  private shellRefusal() {
    const session = this.hooks.session();
    if (!session?.running || !session.reachedShell || !session.interactive) return "当前没有已接通的会话。";
    if (session.prompt) return "会话正在等主人回答一个问题。";
    if (alternate(session.term)) return "终端里正开着一个全屏程序（编辑器、分页器之类）。";
    if (this.run) return "上一条命令还在运行。";
    // At a prompt and nothing typed after it: the text before the cursor ends in a prompt sign.
    const row = cursorRow(session.term);
    if (!row) return "看不到光标。";
    const before = row.left.trimEnd();
    if (!before) return "看不到提示符，可能有程序在运行。";
    return /[$#>%❯»]$/.test(before) && !row.right ? "" : "终端不在空的提示符上：可能有程序在运行，或者主人已经输入了一半。";
  }

  // ── What she does ──────────────────────────────────────────────────────────

  /** Puts the reader's words to her with what she can see (her panel's field, the ideas in it). */
  ask(text: string) {
    const h = this.hooks, hosts = h.hosts(), host = hosts[h.selected()];
    if (maidAssistant.currentConversation < 0) {
      this.followed = (host?.key ?? "") + (maidAssistant.isDeepSeek ? "|deepseek" : "");
      maidAssistant.followHost(host?.key ?? "", host?.name ?? "");
    }
    const run: RunTool = (call, done) => this.runTool(call, done);
    maidAssistant.ask(text, this.context(), run);
  }

  /** Stops her: a command already typed keeps running in the shell; she just stops waiting for it. */
  stop() {
    this.asking = null;
    this.run = null;
    maidAssistant.stop();
  }

  private runTool(call: ToolCall, done: ToolDone) {
    const a = maidAssistant, h = this.hooks, input = call.input, hosts = h.hosts();
    const str = (key: string) => typeof input[key] === "string" ? (input[key] as string) : "";
    const num = (key: string) => typeof input[key] === "number" ? (input[key] as number) : 0;
    const terminal = h.page() === "terminal";
    // Something she did in the workbench, as it stands in her panel.
    const did = (what: string, subject: string, outcome: string, error: boolean) => {
      const at = a.addEntry("action", what, subject);
      a.updateEntry(at, error ? "failed" : "done", outcome);
      done(outcome, error);
    };
    // Something of hers that waits for the reader's 好的 before it is done.
    const askFirst = (what: string, subject: string, act: () => { text: string; error: boolean }) => {
      this.asking = { kind: "act", subject, timeout: 0, done, act, entry: a.addEntry("action", what, subject, "waiting") };
      this.setMood(MOOD.thinking);
      h.openPanel();
    };
    switch (call.name) {
      case "select_host": {
        const wanted = str("name").trim();
        let found = hosts.findIndex(host => host.name.toLowerCase() === wanted.toLowerCase());
        if (found < 0) {
          // One host whose name holds what was asked for, and only one.
          const matching = wanted ? hosts.map((host, i) => host.name.includes(wanted) ? i : -1).filter(i => i >= 0) : [];
          if (matching.length !== 1) { did("选择主机", wanted, matching.length ? "有不止一台主机的名字里有这几个字，请用完整的名字。" : "主机列表里没有这个名字。", true); return; }
          found = matching[0];
        }
        if (terminal) { did("选择主机", wanted, "终端开着的时候不能换主机，请主人先收起终端。", true); return; }
        h.focusHost(found);
        this.followed = hosts[found].key + (a.isDeepSeek ? "|deepseek" : "");
        did("选择主机", hosts[found].name, `已选中 ${hosts[found].name}。`, false);
        return;
      }
      case "connect_host": {
        const host = hosts[h.selected()];
        if (!host) { did("连接主机", "", "没有选中的主机。", true); return; }
        if (h.selectedRunning()) { h.openTerminal(); did("连接主机", host.name, `${host.name} 已有会话在运行，已切到它的终端。`, false); return; }
        h.connectSelected();
        did("连接主机", host.name, `已开始连接 ${host.name}；需要口令或确认主机指纹时由主人回答。`, false);
        return;
      }
      case "open_panel": {
        const panel = str("panel") as "terminal" | "files" | "monitor";
        if (!["terminal", "files", "monitor"].includes(panel)) { did("切换侧栏", panel, "没有这个面板。", true); return; }
        if (!terminal || !h.session()?.reachedShell || !h.selectPanel(panel)) { did("切换侧栏", panel, "要先有一个接通的会话，并且终端开着。", true); return; }
        did("切换侧栏", panel, "已切换。", false);
        return;
      }
      case "draft_command": {
        const command = str("command");
        if (!command || command.length > 1000 || !isOneLine(command)) { did("填写命令", command, "命令要是一行纯文本，不能有换行或控制字符。", true); return; }
        const why = this.shellRefusal();
        if (why) { did("填写命令", command, why, true); return; }
        if (!terminal) h.openTerminal();
        h.session()!.send(command);
        did("填写命令（未执行）", command, "已填到提示符后面，没有执行。请主人检查后自己按回车。", false);
        return;
      }
      case "read_terminal": {
        if (!a.sharesTerminal) { did("读取终端", "", "主人没有共享终端（设置 → 看板娘 → 终端内容）。", true); return; }
        const session = h.session();
        if (!session?.reachedShell) { did("读取终端", "", "当前没有已接通的会话。", true); return; }
        const count = Math.min(200, Math.max(1, Math.round(num("lines"))));
        did("读取终端", `最近 ${count} 行`, lines(session.term).slice(-count).join("\n").slice(-16000), false);
        return;
      }
      case "run_command": {
        const command = str("command").trim(), reason = str("reason").trim(), timeout = Math.min(600, Math.max(5, Math.round(num("timeout_seconds") || 30)));
        const what = reason || "运行命令";
        // What would break the end marker that follows it: a newline, a comment, a trailing & or ;.
        const wrong = !command || command.length > 2000 || !isOneLine(command) ? "命令要是一行纯文本，不能有换行或控制字符。"
          : /[&;\\]$/.test(command) ? "命令不能以 & ; 或 \\ 结尾（后台运行和续行不支持）。"
          : command.startsWith("#") || command.includes(" #") ? "命令里不要带 # 注释。" : "";
        if (wrong) { did(what, command, wrong, true); return; }
        const why = this.shellRefusal();
        if (why) { did(what, command, why, true); return; }
        // Read-only commands go through by themselves when the reader allows it; anything else waits for 运行.
        if (a.trustsReading && isReading(command)) { this.startRun(command, timeout, a.addEntry("action", what, command, "running"), done); return; }
        this.asking = { kind: "run", subject: command, timeout, done, entry: a.addEntry("action", what, command, "waiting") };
        this.setMood(MOOD.thinking);
        h.openPanel();
        return;
      }
      case "read_file": {
        const path = str("path").trim();
        if (!path || path.length > 1024 || !isOneLine(path)) { did("读取文件", path, "路径无效。", true); return; }
        if (!h.session()?.filesReady) { did("读取文件", path, "这台主机的文件服务还没有就绪（会话接通后才有）。", true); return; }
        if (a.trustsReading && !isSecretPath(path)) { this.readFile(path, a.addEntry("action", "读取文件", path, "running"), done); return; }
        this.asking = { kind: "read", subject: path, timeout: 0, done, entry: a.addEntry("action", isSecretPath(path) ? "读取文件（看起来是密钥或凭据）" : "读取文件", path, "waiting") };
        this.setMood(MOOD.thinking);
        h.openPanel();
        return;
      }
      case "navigate": {
        const page = str("page"), section = str("settings_section");
        if (page === "settings") { h.openSettings(section); did("打开设置", section === "none" ? "" : section, "已打开设置。", false); return; }
        if (page === "terminal") {
          if (!h.selectedRunning()) { did("打开终端", "", "选中的主机没有在运行的会话，先用 connect_host 连接。", true); return; }
          h.openTerminal();
          did("打开终端", hosts[h.selected()]?.name ?? "", "已切到终端。", false);
          return;
        }
        if (terminal) h.closeTerminal();
        if (page === "host_file") {
          if (!hosts[h.selected()]) { did("打开档案", "", "没有选中的主机。", true); return; }
          h.openHostFile();
          did("打开档案", hosts[h.selected()].name, "已打开它的档案页。", false);
          return;
        }
        h.showHome(page === "hosts");
        did("切换页面", page === "hosts" ? "主机总览" : "主页档案阵列", terminal ? "已切换；终端收起了，会话还在运行。" : "已切换。", false);
        return;
      }
      case "set_theme": {
        const label = h.setTheme(str("theme"));
        if (!label) { did("换主题", str("theme"), "没有这个主题。", true); return; }
        did("换主题", label, `已换成「${label}」。`, false);
        return;
      }
      case "set_terminal_style": {
        void h.setTerminalStyle(num("font_size"), num("line_height")).then(result => did("调整终端文字", `字号 ${result.size} · 行高 ${result.line.toFixed(2)}`, "已调整。", false));
        return;
      }
      case "set_window": {
        const mode = str("mode") === "fullscreen" ? "fullscreen" : str("mode") === "maximized" ? "maximized" : "windowed";
        h.setWindow(mode);
        did("切换窗口", { windowed: "窗口", maximized: "最大化", fullscreen: "全屏" }[mode], mode === "fullscreen" ? "已全屏，按 F11 可以退出。" : "已切换。", false);
        return;
      }
      case "set_sound": {
        const on = input.enabled === true, volume = h.setSound(on, num("volume"));
        did("设置音效", on ? `开 · 音量 ${Math.round(volume * 100)}%` : "关", "已设置。", false);
        return;
      }
      case "set_my_look": {
        const looks = ["bust", "standing", "chin", "lookout", "wave", "tea", "cheer", "bow", "cross", "mend", "celebrate", "doze"];
        const at = looks.indexOf(str("look"));
        if (at < 0 || at >= LOOK_COUNT) { did("换形象", str("look"), "没有这个样子。", true); return; }
        setMaidPrefs({ look: at, reacts: input.react === true });
        did("换形象", lookName(h.who(), at) + (maidPrefs.reacts ? " · 跟着心情变" : " · 保持不动"), "已换好。", false);
        return;
      }
      case "copy_text": {
        const text = str("text");
        if (!text || text.length > 20000) { did("复制到剪贴板", "", "内容为空或太长。", true); return; }
        h.copy(text);
        did("复制到剪贴板", text.slice(0, 400), "已放进剪贴板。", false);
        return;
      }
      case "send_key": {
        const keys: Record<string, [string, string]> = {
          ctrl_c: ["Ctrl+C（中断）", "\x03"], ctrl_d: ["Ctrl+D（结束输入）", "\x04"], ctrl_z: ["Ctrl+Z（挂起）", "\x1a"], q: ["q", "q"], escape: ["Esc", "\x1b"],
          enter: ["回车", "\r"], space: ["空格", " "], y: ["y", "y"], n: ["n", "n"],
        };
        const key = keys[str("key")], reason = str("reason").trim(), session = h.session();
        if (!key) { did("按键", str("key"), "没有这个键。", true); return; }
        if (!session?.running || !session.reachedShell) { did("按键", key[0], "当前没有已接通的会话。", true); return; }
        const sessionKey = session.key, generation = session.generation;
        askFirst(reason || "在终端里按键", "按 " + key[0], () => {
          const now = h.session();
          if (!now || now.key !== sessionKey || now.generation !== generation || !now.running) return { text: "会话已经换了或结束了，没有按。", error: true };
          if (h.page() !== "terminal") h.openTerminal();
          now.send(key[1]);
          return { text: `已按 ${key[0]}。要看结果可以用 read_terminal。`, error: false };
        });
        return;
      }
      case "disconnect_host": {
        const host = hosts[h.selected()];
        if (!host || !h.selectedRunning()) { did("断开连接", "", "选中的主机没有在运行的会话。", true); return; }
        const reason = str("reason").trim(), name = host.name;
        askFirst(reason || "断开连接", "断开 " + name, () => {
          if (!h.selectedRunning()) return { text: "会话已经结束了。", error: true };
          h.disconnectSelected();
          return { text: `已断开 ${name}。`, error: false };
        });
        return;
      }
    }
    did("未知操作", call.name, "没有这个工具。", true);
  }

  /** The reader's answer to the step waiting on them. */
  answer(allow: boolean) {
    const asking = this.asking;
    if (!asking) return;
    this.asking = null;
    const a = maidAssistant;
    if (!allow) {
      a.updateEntry(asking.entry, "refused", "主人拒绝了");
      asking.done("主人拒绝了这一步，没有执行。先问主人想怎么做，不要换个写法再试。", true);
      return;
    }
    a.updateEntry(asking.entry, "running", "");
    if (asking.kind === "read") { this.readFile(asking.subject, asking.entry, asking.done); return; }
    if (asking.kind === "act") {
      const result = asking.act?.() ?? { text: "没有可做的事。", error: false };
      a.updateEntry(asking.entry, result.error ? "failed" : "done", result.text);
      asking.done(result.text, result.error);
      return;
    }
    // The prompt may have moved on while the reader was deciding.
    const why = this.shellRefusal();
    if (why) { a.updateEntry(asking.entry, "failed", why); asking.done(why, true); return; }
    this.startRun(asking.subject, asking.timeout, asking.entry, asking.done);
  }

  private readFile(path: string, entry: number, done: ToolDone) {
    const session = this.hooks.session();
    if (!session?.filesReady) { maidAssistant.updateEntry(entry, "failed", "文件服务不可用"); done("这台主机的文件服务不可用。", true); return; }
    // ~/ is the home directory, which the SFTP channel starts in.
    void session.readFile(path.startsWith("~/") ? path.slice(2) : path).then(result => {
      if (!result.ok || result.text === undefined) { maidAssistant.updateEntry(entry, "failed", result.error ?? "读取失败"); done("读不了：" + (result.error ?? "读取失败"), true); return; }
      const text = result.text, cut = text.length > 60000;
      maidAssistant.updateEntry(entry, "done", `${text.length} 字`);
      done(cut ? text.slice(0, 60000) + "\n……（文件太长，后面的部分没有读）" : text, false);
    });
  }

  private startRun(command: string, timeout: number, entry: number, done: ToolDone) {
    const session = this.hooks.session()!;
    this.run = { command, nonce: String(10000 + Math.floor(Math.random() * 90000)), entry, session: session.key, generation: session.generation, timeout, startedAt: time(),
      from: Math.max(0, lines(session.term).length - 1), done };
    if (this.hooks.page() !== "terminal") this.hooks.openTerminal();
    // Typed into the reader's own shell, in plain sight. A space first keeps it out of a history that ignores such
    // lines; pagers are turned off for it; and after it a marker carrying its exit status, written so that the
    // marker's text never appears in the command as typed (the shell's echo must not be mistaken for the end).
    session.send(` PAGER=cat ${command}; printf '%s_%s_%s_%s\\n' __RHINE DONE $? ${this.run.nonce}\r`);
  }

  private tickRun(now: number) {
    const run = this.run;
    if (!run || now - this.runLookedAt < .2) return;
    this.runLookedAt = now;
    const end = (state: "done" | "failed", shown: string, told: string, error: boolean) => {
      this.run = null;
      maidAssistant.updateEntry(run.entry, state, shown);
      run.done(told, error);
    };
    const session = this.hooks.session();
    if (!session || session.key !== run.session || session.generation !== run.generation || !session.running) { end("failed", "会话断开了", "会话在命令运行时断开了。", true); return; }
    const rows = lines(session.term), from = rows.length > run.from ? run.from : 0, tail = "_" + run.nonce, mark = "__RHINE_DONE_";
    let found = -1, code = 0;
    for (let i = from; i < rows.length && found < 0; i++) {
      const row = rows[i].trimEnd(), at = row.indexOf(mark);
      if (at < 0 || !row.endsWith(tail)) continue;
      found = i;
      code = parseInt(row.slice(at + mark.length, row.length - tail.length), 10) || 0;
    }
    // What it printed: after the line the command was typed on (the last that carries the marker's pieces), up to the marker.
    const printed = (until: number) => {
      let start = from;
      for (let i = from; i < until; i++) if (rows[i].includes("__RHINE DONE")) start = i + 1;
      const first = Math.max(start, until - 200);
      return ((first > start ? `……（前面 ${first - start} 行省略）\n` : "") + rows.slice(first, until).map(row => row + "\n").join("")).slice(-16000);
    };
    if (found >= 0) {
      const out = printed(found);
      end(code === 0 ? "done" : "failed", `退出码 ${code}\n` + out, `exit status: ${code}\n${out}`, false);
      return;
    }
    if (now - run.startedAt > run.timeout) {
      const out = printed(rows.length);
      end("failed", `${run.timeout} 秒后仍未结束\n` + out, `still running after ${run.timeout} s (it may be waiting for input; the user can press Ctrl+C). Output so far:\n${out}`, true);
    }
  }

  private setMood(mood: number) { this.mood = mood; this.moodAt = time(); }

  // ── What she says unasked ──────────────────────────────────────────────────

  /** Enter at a shell: the command for her record and the recent list, and its output watched for a remark. */
  private watchCommand(session: MaidSession) {
    const a = maidAssistant;
    // The line as typed, when that is all of it (the echo may not be on the screen yet as Enter goes in).
    const exact = !this.lineFresh && this.lineExact && this.promptSerial === session.key ? this.lineTyped : null;
    // The command itself, for her record: the line as typed when that is all of it, else the cursor's line past the prompt it began with.
    if (!this.lineFresh && this.promptSerial === session.key && !this.run && session.reachedShell && !alternate(session.term) && !session.prompt) {
      let command = "";
      if (exact !== null) command = exact;
      else { const row = cursorRow(session.term); if (this.prompt && row && row.left.startsWith(this.prompt)) command = (row.left + row.right).slice(this.prompt.length); }
      a.recordCommand(session.hostKey, command.trimEnd());
    }
    this.lineFresh = true;
    this.historyDismissed = "";
    // Only a line entered at a live shell, by the reader: not an answer to a question, nor her own command.
    if (this.run || !session.reachedShell || !session.interactive || session.prompt) return;
    const row = cursorRow(session.term);
    this.command = (exact !== null ? exact : row ? (row.left + row.right).replace(MARK, "") : "").trim().slice(0, 300);
    if (this.command && !alternate(session.term)) { this.recent.push(this.command); if (this.recent.length > 20) this.recent.shift(); }
    if (a.proactive === 0) return;
    this.watchLines = lines(session.term).length;
    this.watchSerial = session.key;
    this.watchShown = session.shown;
    this.watchAt = this.changedAt = time();
  }

  private askRemark(trigger: string, command: string, output: string) {
    const a = maidAssistant;
    // She does not talk over herself: not while an answer is being fetched or stands in her bubble, nor twice at once.
    if (a.isBusy || a.isRemarking || !a.hasKey) return;
    if (a.replySerial > 0 && time() - a.repliedAt < holdOf(a.reply)) return;
    const urgent = trigger === "error" || trigger === "risky";
    if (time() - this.lastRemarkAt < (urgent ? 6 : 40)) return;
    this.lastRemarkAt = time();
    // Her face answers at once; the words follow when they arrive.
    if (urgent) this.setMood(trigger === "error" ? MOOD.surprised : MOOD.worried);
    void a.remark(trigger, command, output).then(({ say, mood }) => {
      if (say) { this.remarkLine = say; this.remarkAt = time(); }
      if (mood) this.setMood(mood);
    });
  }

  private tickWatch(now: number, session: MaidSession | null) {
    if (this.watchAt < 0) return;
    if (!session || session.key !== this.watchSerial || !session.running) { this.watchAt = -1; return; }
    if (session.shown !== this.watchShown) { this.watchShown = session.shown; this.changedAt = now; }
    // The output has stood still for a second and a bit, or the command has run ten seconds: look at what there is.
    const settled = now - this.changedAt > 1.2 && now - this.watchAt > .6;
    if (!settled && now - this.watchAt < 10) return;
    this.watchAt = -1;
    const rows = lines(session.term);
    const from = rows.length > this.watchLines ? Math.max(this.watchLines, rows.length - 25) : Math.max(0, rows.length - 25);
    const output = rows.slice(from).map(row => row + "\n").join("");
    const printed = output.toLowerCase(), typed = this.command.toLowerCase(), mode = maidAssistant.proactive;
    const trigger = hasAny(printed, FAILURES) ? "error" : hasAny(typed, RISKS) ? "risky"
      : mode < 2 ? "" : hasAny(printed, SUCCESSES) ? "success" : this.command && Math.random() < .18 ? "random" : "";
    if (trigger) this.askRemark(trigger, this.command, output.slice(-3000));
  }

  // ── Completion ─────────────────────────────────────────────────────────────

  /** What the reader typed into the shell (terminal.ts onData). */
  watchTyping(sent: string) {
    const session = this.hooks.session();
    if (!session) return;
    // The terminal's own replies to the host (cursor position, device attributes, focus, colour queries) come the
    // same way as keys, and are not typing.
    if (/^\x1b(\[[\d;?>=]*[cRnIOt]|\][\s\S]*(\x07|\x1b\\)|P[\s\S]*\x1b\\)$/.test(sent)) return;
    const now = time();
    this.keyAt = now;
    // The first key of a line: what stands left of the cursor now (the key is not echoed yet) is the prompt.
    if (this.lineFresh) {
      this.lineFresh = false;
      const row = session.reachedShell ? cursorRow(session.term) : null;
      this.prompt = row && !row.right ? row.left : "";
      this.promptSerial = session.key;
      this.lineTyped = "";
      this.lineExact = true;
    }
    // The line as typed: letters add to it, a backspace takes one back, the part before an Enter is its end.
    const enter = sent.indexOf("\r"), before = enter >= 0 ? sent.slice(0, enter) : sent;
    if (sent === "\x7f" || sent === "\b") { if (!this.lineTyped) this.lineExact = false; else this.lineTyped = this.lineTyped.slice(0, -1); }
    else if (isOneLine(before)) this.lineTyped += before;
    else this.lineExact = false;
    if (enter >= 0) this.watchCommand(session);
    // An interrupt or end of input leaves the line: the next key begins another.
    if (sent.includes("\x03") || sent.includes("\x04")) this.lineFresh = true;
    if (sent === "\x7f" || sent === "\b") {
      this.typedLetters = Math.max(0, this.typedLetters - 1); this.typedAt = now;
      if (this.suggestion) { this.suggestion = ""; maidAssistant.cancelCompletion(); }
      return;
    }
    const plain = Boolean(sent) && isOneLine(sent);
    if (!plain) { this.typedLetters = 0; this.typedAt = -1; this.suggestion = ""; return; }
    this.typedLetters += sent.length;
    // Typing what the suggestion says keeps the rest of it; anything else drops it.
    if (this.suggestion) {
      if (this.suggestion.startsWith(sent)) {
        this.suggestion = this.suggestion.slice(sent.length);
        this.completeSent = session.sent + sent.length;
        if (this.suggestion) return;
      } else { this.suggestion = ""; maidAssistant.cancelCompletion(); }
    }
    this.typedAt = now;
  }

  private note(text: string) { this.suggestion = ""; this.stripNote = text; this.stripNoteUntil = time() + 3; }

  requestCompletion() {
    const a = maidAssistant;
    if (!a.completes) { this.note("终端补全未开启：设置 → 看板娘"); return; }
    if (!a.hasKey) { this.note("还没有 API key：设置 → 看板娘"); return; }
    const session = this.hooks.session();
    if (!session?.running || !session.reachedShell || !session.interactive || session.prompt || alternate(session.term)) { this.note("当前没有停在提示符上的会话"); return; }
    // The last thirty lines, the cursor drawn in, what was run lately, and what the reader ran on this host before.
    const screen = screenWithCursor(session.term).slice(-30).join("\n") + "\n";
    const recent = this.recent.map(command => command + "\n").join("");
    const history = a.historyChoice ? a.historyFor(session.hostKey, 40) : "";
    this.suggestion = ""; this.fromHistory = false; this.stripNote = "";
    this.completeSerial = session.key; this.completeSent = session.sent;
    void a.complete(screen.slice(-4000), recent, history).then(insert => {
      if (insert === null) return;
      // The line has moved on since (another session in front, or something typed): the answer is for a line that is gone.
      const now = this.hooks.session();
      if (!now || now.key !== this.completeSerial || now.sent !== this.completeSent) return;
      if (!insert) { this.stripNote = "没有可补全的内容"; this.stripNoteUntil = time() + 2; }
      else { this.suggestion = insert; this.fromHistory = false; }
    });
  }

  /** A key in the terminal: the completion's chords and the suggestion's keys. Returns true when it is taken here. */
  chord(event: KeyboardEvent) {
    if (event.type !== "keydown") return false;
    // Two chords ask for it: an input method may keep Ctrl+Shift+Space for itself, and Ctrl+Enter means nothing to a terminal.
    if (event.ctrlKey && !event.altKey && ((event.shiftKey && event.code === "Space") || (!event.shiftKey && event.key === "Enter"))) {
      this.requestCompletion();
      return true;
    }
    if (!this.suggestion && !maidAssistant.isCompleting) return false;
    if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return false;
    const bare = !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey;
    // The right arrow or End types it (no Enter with it), as a shell's own suggestions are taken.
    if (bare && (event.key === "ArrowRight" || event.key === "End") && this.suggestion) {
      const taken = this.suggestion;
      this.suggestion = "";
      maidAssistant.cancelCompletion();
      this.hooks.session()?.send(taken);
      // Typed for the reader: it is part of the line as typed.
      if (!this.lineFresh) this.lineTyped += taken;
      return true;
    }
    const editing = !bare || ["Escape", "Tab", "Enter", "Backspace", "Delete", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "PageUp", "PageDown", "ArrowRight", "End"].includes(event.key);
    if (!editing) return false;
    // Esc drops it (one from her record stays dropped for this much of the line); the other keys drop it and go on.
    if (this.fromHistory && bare && event.key === "Escape") this.historyDismissed = this.historyTyped;
    this.suggestion = "";
    maidAssistant.cancelCompletion();
    return bare && event.key === "Escape";
  }

  private tickHistory(now: number, session: MaidSession | null) {
    const a = maidAssistant;
    // Only while the reader is typing a line whose prompt is known, at a shell.
    if (a.historyChoice !== 2 || this.lineFresh || !this.prompt || now - this.keyAt > 4 || this.run || !session) return;
    if (session.key !== this.promptSerial || !session.running || !session.reachedShell || alternate(session.term) || session.prompt) return;
    // Looked at again only when something came back or went out.
    const seen = `${session.shown}|${session.sent}`;
    if (seen === this.historyKey) return;
    this.historyKey = seen;
    const row = cursorRow(session.term);
    const atEnd = Boolean(row && !row.right && row.left.startsWith(this.prompt));
    this.historyTyped = atEnd ? row!.left.slice(this.prompt.length) : "";
    const full = atEnd && this.historyTyped !== this.historyDismissed ? a.fromHistory(session.hostKey, this.historyTyped) : "";
    if (full) {
      // One from her record stands in for an asked-for one only if none is showing.
      if (!this.suggestion || this.fromHistory) { this.suggestion = full.slice(this.historyTyped.length); this.fromHistory = true; a.cancelCompletion(); }
    } else if (this.fromHistory) this.suggestion = "";
  }

  /** The strip at the foot of the terminal: how to take the suggestion, or why there is none (empty: none). */
  strip() {
    if (this.suggestion) return this.fromHistory ? "→ 填入历史命令 · ESC 取消" : "→ 填入灰色建议 · ESC 取消";
    if (maidAssistant.isCompleting) return "正在补全…";
    return time() < this.stripNoteUntil ? this.stripNote : "";
  }

  // ── Every frame ────────────────────────────────────────────────────────────

  tick() {
    const a = maidAssistant, h = this.hooks, now = time();
    a.setDeepSeek(h.who() === "deepseek");
    // Her conversation follows the host the reader selects (once she is not at work).
    const hosts = h.hosts(), host = hosts[h.selected()], key = host?.key ?? "";
    const followed = key + (a.isDeepSeek ? "|deepseek" : "");
    if (a.isBusy) this.followed = key + (a.conversationIsDeepSeek ? "|deepseek" : "");
    if (followed !== this.followed && !a.isBusy) { this.followed = followed; a.followHost(key, host?.name ?? ""); }
    // An answer shows on her face: glad when it came, worried when it went wrong.
    if (a.replySerial !== this.replySeen) {
      this.replySeen = a.replySerial;
      this.mood = a.lastError ? MOOD.worried : MOOD.happy;
      if (!a.lastError) this.gladAt = now;
      this.moodAt = now - (a.lastError ? 0 : 3);
    }
    const session = h.session();
    this.tickRun(now);
    this.tickWatch(now, session);
    this.tickHistory(now, session);
    // Completion by itself: the reader has stopped typing for seven tenths of a second with something on the line, at a shell.
    if (this.typedAt >= 0 && now - this.typedAt > .7) {
      this.typedAt = -1;
      if (a.completes === 2 && this.typedLetters >= 2 && now - this.autoAt > 1.2 && a.hasKey && !a.isCompleting && !this.suggestion && !this.run
        && session?.running && session.reachedShell && !alternate(session.term) && !session.prompt) { this.autoAt = now; this.requestCompletion(); }
    }
  }
}

export { lines as terminalLines, screenWithCursor, cursorRow };
