import type { Mascot } from "../../theme/theme-design";
import { maidUrl } from "../maid-art";
import { bubble, clamp, css, disc, ease, easeOut, font, heart, polyline, puppet, roundBox, scallops, spark, text, triangle, twinkle, waveFill, whaleTail, type Ink } from "../maid-draw";
import { LOOK_COUNT, lookName, pick, uiFace } from "../maid-lines";
import { maidPrefs, setMaidPrefs } from "../maid-prefs";
import { StageCanvas } from "../stage-canvas";
import { MaidAssistant, maidAssistant, type Entry } from "./maid-assistant";
import type { MaidWorkbench } from "./maid-workbench";
import "./maid-panel.css";

/**
 * Her panel (the Unreal build's MakeClaudePanel, RebuildClaudeLog, SRhineClaudePanelBack and SRhineClaudeBoot): a card
 * at the right of the window, its back drawn (her lace or her sea, a stitched seam, her bow or her tail, sparks), her
 * bust at its head breathing and blinking and talking with her mood, what she is doing, the conversation of the host
 * on show (and that host's others, and a new one), a drawer with her model, how hard she thinks and how she looks,
 * the whole log selectable with a 复制 on each entry, the reader's 运行 / 不要 on a step waiting for them, and the
 * field. As it opens, a scan builds the card and she comes online.
 */
export type PanelHooks = {
  who(): Mascot;
  reduced(): boolean;
  selectedHost(): { key: string; name: string } | null;
  play(cue: "scan" | "page-close" | "ui-tick" | "confirm" | "welcome" | "back"): void;
  colors(): { ink: Ink; paper: Ink; accent: Ink; panel: Ink };
  /** Device pixels a CSS pixel of the panel (it is scaled with the window, as the stage is). */
  density(): number;
  closed(): void;
};

const STATES: Record<Entry["state"], string> = { none: "", waiting: "等你确认", running: "进行中", done: "完成啦", failed: "失败了", refused: "没有执行" };
const IDEAS = ["帮我看看刚才的报错", "磁盘还剩多少空间？", "服务器负载怎么样？", "最近的系统日志有异常吗？", "你会做些什么呀？"];
const time = () => performance.now() / 1000;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", content?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
};
const clock = (at: number) => new Date(at).toTimeString().slice(0, 5);
const day = (at: number) => { const d = new Date(at); return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${clock(at)}`; };
const backOut = (t: number) => { t = clamp(t) - 1; return 1 + 2.70158 * t * t * t + 1.70158 * t * t; };

export class MaidPanel {
  readonly root = el("section", "maid-panel");
  private card = el("div", "maid-panel-card");
  private back = new StageCanvas("maid-panel-back");
  private boot = new StageCanvas("maid-panel-boot");
  private head = new StageCanvas("maid-panel-bust");
  private name = el("b", "maid-panel-name");
  private state = el("span", "maid-panel-state");
  private dot = el("i", "maid-panel-dot");
  private stopButton = el("button", "maid-pill maid-pill-accent", "停一下");
  private modelButton = el("button", "maid-pill maid-pill-field");
  private thread = el("button", "maid-pill maid-thread");
  private newButton = el("button", "maid-pill maid-pill-accent", "+ 新对话");
  private threads = el("div", "maid-threads");
  private options = el("div", "maid-options");
  private logBox = el("div", "maid-log");
  private field = el("input", "maid-field") as HTMLInputElement;
  private send = el("button", "maid-pill maid-pill-accent maid-send");
  private hint = el("p", "maid-hint");
  private open = false;
  private openedAt = -10;
  private chimed = true;
  private logShown = -1;
  private logCount = 0;
  private logAnimFrom = 0;
  private threadsOpen = false;
  private threadsShown = -1;
  private optionsOpen = false;
  private optionsShown = "";
  private thoughtsOpen = new Set<number>();
  private deleteArmed = "";
  private deleteArmedAt = 0;
  private headKey = "";
  private size: [number, number] = [0, 0];
  private backAt = -10;
  private backKey = "";

  constructor(host: HTMLElement, private workbench: MaidWorkbench, private hooks: PanelHooks) {
    this.root.hidden = true;
    this.root.dataset.surfaceCompanion = "";
    this.root.setAttribute("aria-label", "看板娘对话");
    this.root.setAttribute("role", "complementary");
    const content = el("div", "maid-panel-content");
    // The head: her bust popping up from her feet, her name and spark, what she is doing, and the buttons.
    const headRow = el("div", "maid-panel-head");
    const who = el("div", "maid-panel-who");
    const title = el("div", "maid-panel-title");
    title.append(this.name, el("span", "maid-panel-spark", "✳"));
    const status = el("div", "maid-panel-status");
    status.append(this.dot, this.state);
    who.append(title, status);
    const close = el("button", "maid-pill maid-pill-field maid-close", "×");
    close.setAttribute("aria-label", "收起对话");
    headRow.append(this.head.el, who, this.stopButton, this.modelButton, close);
    const threadRow = el("div", "maid-thread-row");
    threadRow.append(this.thread, this.newButton);
    const input = el("div", "maid-input");
    const spark = el("span", "maid-input-spark", "✳");
    this.field.type = "text";
    this.field.maxLength = 4000;
    this.field.setAttribute("aria-label", "和她说话");
    input.append(spark, this.field, this.send);
    content.append(headRow, threadRow, this.threads, this.options, this.logBox, input, this.hint);
    this.card.append(this.back.el, content, this.boot.el);
    this.root.append(this.card);
    host.append(this.root);
    this.threads.hidden = this.options.hidden = true;
    new ResizeObserver(([entry]) => { this.size = [Math.round(entry.contentRect.width), Math.round(entry.contentRect.height)]; }).observe(this.card);

    close.addEventListener("click", () => this.toggle());
    this.stopButton.addEventListener("click", () => this.workbench.stop());
    this.modelButton.addEventListener("click", () => { this.optionsOpen = !this.optionsOpen; this.optionsShown = ""; this.hooks.play("ui-tick"); });
    this.thread.addEventListener("click", () => { this.threadsOpen = !this.threadsOpen; this.threadsShown = -1; this.hooks.play("ui-tick"); });
    this.newButton.addEventListener("click", () => {
      const host = this.hooks.selectedHost();
      maidAssistant.newConversation(host?.key ?? "", host?.name ?? "");
      this.field.focus();
      this.hooks.play("confirm");
    });
    const submit = () => {
      const said = this.field.value.trim();
      if (!said || maidAssistant.isBusy) return;
      this.workbench.ask(said);
      this.field.value = "";
      this.field.focus();
    };
    this.send.addEventListener("click", submit);
    this.field.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); submit(); }
      else if (event.key === "Escape") { event.preventDefault(); this.toggle(); }
      event.stopPropagation();
    });
    // Her ticket's buttons and the log's copies, by delegation (the log is rebuilt whole).
    this.root.addEventListener("click", event => {
      const target = (event.target as Element).closest<HTMLElement>("[data-maid]");
      if (!target) return;
      const action = target.dataset.maid!, value = target.dataset.value ?? "";
      if (action === "allow" || action === "deny") this.workbench.answer(action === "allow");
      else if (action === "copy") void navigator.clipboard?.writeText(value);
      else if (action === "idea") this.workbench.ask(value);
      else if (action === "thought") { const i = Number(value); if (!this.thoughtsOpen.delete(i)) this.thoughtsOpen.add(i); this.logShown = -1; this.hooks.play("ui-tick"); }
      else if (action === "switch") { const at = maidAssistant.allConversations.findIndex(c => c.id === value); if (maidAssistant.switchConversation(at)) { this.threadsOpen = false; this.field.focus(); this.hooks.play("ui-tick"); } }
      else if (action === "delete") {
        if (this.deleteArmed !== value) { this.deleteArmed = value; this.deleteArmedAt = time(); this.threadsShown = -1; this.hooks.play("ui-tick"); return; }
        this.deleteArmed = "";
        maidAssistant.deleteConversation(maidAssistant.allConversations.findIndex(c => c.id === value));
        this.hooks.play("back");
      } else if (action === "model") { maidAssistant.setModel(Number(value)); this.optionsShown = ""; this.hooks.play("ui-tick"); }
      else if (action === "effort") { if (maidAssistant.isDeepSeek) maidAssistant.setLink(true, { ...maidAssistant.linkOf(true), thinking: Number(value) }); else maidAssistant.setEffort(Number(value)); this.optionsShown = ""; this.hooks.play("ui-tick"); }
      else if (action === "look") { setMaidPrefs({ look: (maidPrefs.look + Number(value) + LOOK_COUNT) % LOOK_COUNT }); this.optionsShown = ""; this.hooks.play("ui-tick"); }
      else if (action === "react") { setMaidPrefs({ reacts: value === "1" }); this.optionsShown = ""; this.hooks.play("ui-tick"); }
      else if (action === "reset") { this.workbench.stop(); maidAssistant.reset(); this.thoughtsOpen.clear(); this.hooks.play("ui-tick"); }
    });
  }

  get isOpen() { return this.open; }

  /** Opens it: the last few entries pop in one after another, the scan builds the card, she comes online. */
  show() {
    if (this.open) return;
    this.open = true;
    this.workbench.panelOpen = true;
    this.openedAt = time();
    this.chimed = this.hooks.reduced();
    this.logShown = -1;
    this.logCount = this.logAnimFrom = Math.max(0, maidAssistant.log.length - 5);
    this.root.hidden = false;
    this.root.dataset.reduced = String(this.hooks.reduced());
    requestAnimationFrame(() => { this.root.dataset.open = "true"; this.field.focus({ preventScroll: true }); });
    this.hooks.play("scan");
  }
  toggle() {
    if (!this.open) { this.show(); return; }
    this.open = false;
    this.workbench.panelOpen = false;
    this.optionsOpen = this.threadsOpen = false;
    this.root.dataset.open = "false";
    this.hooks.play("page-close");
    window.setTimeout(() => { if (!this.open) { this.root.hidden = true; this.back.clear(); this.boot.clear(); } }, this.hooks.reduced() ? 0 : 260);
    this.hooks.closed();
  }

  /** Once a frame while it is up. */
  frame() {
    if (this.root.hidden) return;
    const a = maidAssistant, who = this.hooks.who(), now = time(), colors = this.hooks.colors();
    this.root.dataset.who = who;
    if (this.name.textContent !== pick(who, "小克", "大肥鱼")) this.name.textContent = pick(who, "小克", "大肥鱼");
    const dots = "·".repeat(1 + Math.floor(now * 3) % 3);
    const state = this.workbench.asking ? pick(who, "等主人点头哦～", "等主人点头！") : this.workbench.run ? pick(who, "在终端里干活中", "在终端里扑腾中") + dots
      : a.isBusy ? pick(who, "认真思考中", "潜水思考中") + dots : !a.hasKey ? "还没有钥匙…去 设置 → 看板娘 填 API key" : (who === "deepseek" ? `随时出发！  ${a.modelName}` : `随时待命～  ${a.modelName}`);
    if (this.state.textContent !== state) this.state.textContent = state;
    this.dot.dataset.busy = String(a.isBusy);
    this.stopButton.hidden = !a.isBusy;
    this.newButton.hidden = a.isBusy;
    const model = `${a.modelName}  ${this.optionsOpen ? "▴" : "▾"}`;
    if (this.modelButton.textContent !== model) this.modelButton.textContent = model;
    const c = a.allConversations[a.currentConversation];
    const thread = `${c?.hostName || "未选主机"}  ·  ${c?.title || "新对话"}  ${this.threadsOpen ? "▴" : "▾"}`;
    if (this.thread.textContent !== thread) this.thread.textContent = thread;
    this.field.disabled = a.isBusy;
    const placeholder = a.isBusy ? pick(who, "小克正在努力中…", "大肥鱼全速运转中…") : pick(who, "跟小克说点什么吧～", "跟大肥鱼说点什么吧！");
    if (this.field.placeholder !== placeholder) this.field.placeholder = placeholder;
    const sendText = a.isBusy ? "…" : pick(who, "发送 ♡", "发送 ～");
    if (this.send.textContent !== sendText) this.send.textContent = sendText;
    const hint = a.trustsReading ? "Enter 发送 · Esc 收起 · 只读命令会直接执行，其他的先等你同意" : "Enter 发送 · Esc 收起 · 她要执行的命令都会先等你同意";
    if (this.hint.textContent !== hint) this.hint.textContent = hint;
    if (this.deleteArmed && now - this.deleteArmedAt > 3) { this.deleteArmed = ""; this.threadsShown = -1; }
    this.threads.hidden = !this.threadsOpen;
    if (this.threadsOpen && a.conversationRevision !== this.threadsShown) this.renderThreads();
    this.options.hidden = !this.optionsOpen;
    const optionsKey = `${who}|${a.modelIndex}|${a.effortIndex}|${a.linkOf(true).thinking}|${maidPrefs.look}|${maidPrefs.reacts}|${a.isBusy}`;
    if (this.optionsOpen && optionsKey !== this.optionsShown) { this.optionsShown = optionsKey; this.renderOptions(who); }
    if (a.logRevision !== this.logShown || (this.workbench.asking && this.logBox.dataset.asking !== String(this.workbench.asking.entry))) { this.logShown = a.logRevision; this.renderLog(who); }
    // Her panel's start-up chimes as the scan passes and she comes online.
    if (!this.chimed && now - this.openedAt > .78) { this.chimed = true; this.hooks.play("welcome"); }
    this.paintBack(who, now, colors);
    this.paintBust(who, now);
    this.paintBoot(who, now, colors);
  }

  private renderThreads() {
    const a = maidAssistant;
    this.threadsShown = a.conversationRevision;
    const shown = a.allConversations[a.currentConversation], host = shown?.host ?? this.hooks.selectedHost()?.key ?? "";
    const mine = a.conversationsFor(host);
    this.threads.replaceChildren(el("p", "maid-threads-title", `${shown?.hostName || "未选主机"} 的对话 · ${mine.length} 段`));
    for (const index of mine) {
      const c = a.allConversations[index], on = index === a.currentConversation, armed = this.deleteArmed === c.id;
      const row = el("div", "maid-thread-item");
      row.dataset.on = String(on);
      const pick = el("button", "maid-thread-pick");
      pick.dataset.maid = "switch"; pick.dataset.value = c.id;
      pick.disabled = a.isBusy;
      pick.append(el("i"), el("b", "", c.title || "新对话"), el("small", "", `${a.entryCount(index)} 条 · ${day(c.updated)}`));
      // Deleting: a second press within three seconds.
      const remove = el("button", armed ? "maid-pill maid-pill-accent" : "maid-pill maid-pill-ring", armed ? "确认删除" : "×");
      remove.dataset.maid = "delete"; remove.dataset.value = c.id;
      remove.setAttribute("aria-label", "删除这段对话");
      row.append(pick, remove);
      this.threads.append(row);
    }
  }

  private renderOptions(who: Mascot) {
    const a = maidAssistant;
    const chips = (action: string, names: string[], current: number) => {
      const box = el("div", "maid-chips");
      names.forEach((name, i) => { const chip = el("button", i === current ? "maid-pill maid-pill-accent" : "maid-pill maid-pill-soft", name); chip.dataset.maid = action; chip.dataset.value = String(i); box.append(chip); });
      return box;
    };
    const models = MaidAssistant.modelsOf(who === "deepseek"), at = a.modelIndex;
    const nodes: Node[] = [
      el("p", "maid-section", "模型"), chips("model", models.map(m => m.name), at),
      el("p", "maid-note", `${at >= 0 ? models[at].note : "自定义模型 " + a.model} · 下一句话起生效`),
      el("p", "maid-section", "思考"),
      who === "deepseek" ? chips("effort", ["关", "低", "高", "最高", "服务器默认"], a.linkOf(true).thinking) : chips("effort", ["轻松", "适中", "认真"], a.effortIndex),
      el("p", "maid-section", "终端里的我"),
    ];
    const look = el("div", "maid-look");
    const prev = el("button", "maid-pill maid-pill-accent", "‹"), next = el("button", "maid-pill maid-pill-accent", "›");
    prev.dataset.maid = next.dataset.maid = "look"; prev.dataset.value = "-1"; next.dataset.value = "1";
    look.append(prev, el("span", "maid-look-name", lookName(who, maidPrefs.look)), next);
    if (!a.isBusy) { const reset = el("button", "maid-pill maid-pill-ring maid-reset", "清空对话"); reset.dataset.maid = "reset"; look.append(reset); }
    nodes.push(look, chips("react", ["表情动作跟着心情变", "保持不动"], maidPrefs.reacts ? 0 : 1), el("p", "maid-note", "选中的样子是她没事时的样子 · 在终端里对着她滚动滚轮也能换"));
    // "react" chips carry 0 for on: flip the values.
    nodes[nodes.length - 2].childNodes.forEach((chip, i) => { (chip as HTMLElement).dataset.value = i === 0 ? "1" : "0"; });
    this.options.replaceChildren(...nodes);
  }

  private renderLog(who: Mascot) {
    const a = maidAssistant, log = a.log, count = log.length, now = time();
    const asking = this.workbench.asking;
    this.logBox.dataset.asking = asking ? String(asking.entry) : "";
    // Entries that came since the last build pop in, one after another (all from the start when the log was begun again).
    if (count < this.logCount) { this.logCount = this.logAnimFrom = 0; }
    if (count > this.logCount) this.logAnimFrom = this.logCount;
    this.logCount = count;
    const popping = (node: HTMLElement, index: number) => {
      if (index < this.logAnimFrom || this.hooks.reduced()) return node;
      node.classList.add("maid-pop");
      node.style.animationDelay = `${.08 + Math.min(index - this.logAnimFrom, 6) * .07 + (now - this.openedAt < .7 ? .7 - (now - this.openedAt) : 0)}s`;
      return node;
    };
    const copy = (value: string) => { const b = el("button", "maid-pill maid-pill-ring maid-copy", "复制"); b.dataset.maid = "copy"; b.dataset.value = value; return b; };
    const nodes: HTMLElement[] = [];
    if (!count) {
      // A greeting, and a few things to ask her with a click.
      const c = a.allConversations[a.currentConversation];
      const hello = el("div", "maid-hello");
      const ideas = el("div", "maid-chips maid-ideas");
      for (const idea of IDEAS) { const b = el("button", "maid-pill maid-pill-idea", idea); b.dataset.maid = "idea"; b.dataset.value = idea; ideas.append(b); }
      hello.append(el("span", "maid-hello-spark", "✳"), el("b", "", pick(who, "主人好～我是小克！", "主人好！我是大肥鱼！")),
        el("p", "", (c?.hostName ? `这是「${c.hostName}」的一段新对话。` : "") + pick(who, "看报错、查日志、检查服务，或者在服务器上帮您做点事都可以交给我。要执行的命令会先在这里等您同意～",
          "看报错、翻日志、查服务，或者去服务器上帮你干活，统统交给我！要执行的命令会先在这里等你点头～")), ideas);
      nodes.push(popping(hello, 0));
    }
    for (let i = Math.max(0, count - 120); i < count; i++) {
      const entry = log[i], when = clock(entry.at);
      const copied = entry.text + (entry.subject ? "\n" + entry.subject : "") + (entry.outcome ? "\n" + entry.outcome : "");
      let node: HTMLElement;
      if (entry.kind === "thought") {
        // What she thought before answering: folded to a pill under her side, the words under it once unfolded.
        const open = this.thoughtsOpen.has(i);
        node = el("div", "maid-entry maid-thought");
        const fold = el("button", "maid-pill maid-pill-ring", `${pick(who, "小克", "大肥鱼")} 思考了 ${[...entry.text].length} 字  ${open ? "▴" : "▾"}`);
        fold.dataset.maid = "thought"; fold.dataset.value = String(i);
        node.append(fold);
        if (open) node.append(el("pre", "maid-thought-text", entry.text));
      } else if (entry.kind === "user") {
        // The reader's words: a bubble in her colour on the right, its top right corner tucked.
        node = el("div", "maid-entry maid-user");
        const caption = el("div", "maid-caption");
        caption.append(copy(copied), el("span", "", `${pick(who, "主人", "主人")} · ${when}`));
        node.append(caption, el("div", "maid-bubble maid-bubble-user", entry.text));
      } else if (entry.kind !== "action") {
        // Hers: her little bust at the side and a cream bubble, its top left corner tucked toward her; a failure outlined in her colour.
        const error = entry.kind === "error";
        node = el("div", "maid-entry maid-her");
        node.dataset.error = String(error);
        const face = el("span", "maid-face");
        face.style.backgroundImage = `url("${maidUrl(who, "bust")}")`;
        const side = el("div", "maid-her-side");
        const caption = el("div", "maid-caption");
        caption.append(el("span", "", `${pick(who, "小克", "大肥鱼")}${error ? " · 出错了 · " : " · "}${when}`), copy(copied));
        const bubbleBox = el("div", "maid-bubble maid-bubble-her");
        bubbleBox.append(el("div", "", entry.text));
        if (entry.outcome) bubbleBox.append(el("div", "maid-bubble-outcome", entry.outcome.slice(-4000)));
        side.append(caption, bubbleBox);
        node.append(face, side);
      } else {
        // Something she does: a ticket with its state on a tag, the command in the terminal's face, the reader's
        // buttons while it waits on them, and what came of it.
        const waiting = entry.state === "waiting", hot = waiting || entry.state === "failed";
        node = el("div", "maid-entry maid-ticket");
        node.dataset.waiting = String(waiting);
        const top = el("div", "maid-ticket-top");
        const tag = el("span", "maid-tag", STATES[entry.state]);
        tag.dataset.hot = String(hot);
        top.append(tag, el("span", "maid-ticket-text", entry.text), copy(copied));
        node.append(top);
        if (entry.subject) node.append(el("pre", "maid-subject", entry.subject));
        if (waiting && asking?.entry === i) {
          const buttons = el("div", "maid-ticket-buttons");
          const yes = el("button", "maid-pill maid-pill-accent maid-big", asking.kind === "read" ? pick(who, "让她读 ♡", "让她读 ～") : asking.kind === "act" ? pick(who, "好的 ♡", "好的 ～") : pick(who, "运行 ♡", "运行 ～"));
          const no = el("button", "maid-pill maid-pill-ring maid-big", "不要");
          yes.dataset.maid = "allow"; no.dataset.maid = "deny";
          buttons.append(yes, no);
          node.append(buttons);
        }
        if (entry.outcome) node.append(el("pre", "maid-outcome", entry.outcome.length > 4000 ? "……\n" + entry.outcome.slice(-4000) : entry.outcome));
      }
      nodes.push(popping(node, i));
    }
    this.logBox.replaceChildren(...nodes);
    this.logBox.scrollTop = this.logBox.scrollHeight;
  }

  /** Her bust at the panel's head: popping up from her feet a moment after the card, breathing, blinking, her mood on her face. */
  private paintBust(who: Mascot, now: number) {
    const popped = Math.max(.01, backOut((now - this.openedAt - (this.hooks.reduced() ? .1 : .45)) / .42));
    const ctx = this.head.begin(150, 150, this.hooks.density());
    ctx.translate(75, 150); ctx.scale(popped, popped); ctx.translate(-75, -150);
    puppet(ctx, who, 0, 0, 150, this.workbench.face(), this.workbench.talking(), now);
  }

  /** The card's back (SRhineClaudePanelBack): the card off register, sparks, the seam, lace or sea, the bow or the tail. */
  private paintBack(who: Mascot, now: number, c: { ink: Ink; paper: Ink; accent: Ink; panel: Ink }) {
    const [sw, sh] = this.size;
    if (sw < 60 || sh < 60) return;
    // Once it has opened, the back moves slowly (her sparks turn, her tail flicks now and then): drawn ten times a
    // second for Claude, thirty for the whale, and again at once when its size or colours change.
    const key = `${who}|${sw}|${sh}|${this.hooks.density()}|${c.panel}|${c.ink}|${c.accent}`;
    if (key === this.backKey && now - this.openedAt > 1.2 && now - this.backAt < (who === "deepseek" ? 1 / 30 : .1)) return;
    this.backKey = key;
    this.backAt = now;
    const ctx = this.back.begin(sw + 40, sh + 40, this.hooks.density());
    ctx.translate(20, 20);
    const open = clamp((now - this.openedAt) / .5), seen = 1, r = 22, w = sw - 7, h = sh - 7;
    const base = c.panel, inkc = c.ink, accent = c.accent;
    roundBox(ctx, 7, 7, w, h, r, css(accent, .9 * seen));
    roundBox(ctx, 0, 0, w, h, r, css(base, seen));
    // Her sparks, strewn on a loose grid and turning very slowly, faint.
    ctx.save(); ctx.beginPath(); ctx.rect(10, 10, w - 20, h - 20); ctx.clip();
    for (let row = 0; row * 74 < h; row++) for (let col = 0; col * 74 < w; col++) {
      const x = 30 + col * 74 + (row % 2) * 37, y = 30 + row * 74;
      if ((row * 7 + col * 3) % 4 === 0) twinkle(ctx, who, x, y, 7, 1.6, css(inkc, .07), now * .15 + row + col);
      else disc(ctx, x, y, 1.6, css(inkc, .07));
    }
    ctx.restore();
    // The soft disc behind her bust.
    disc(ctx, 90, 30, 60, css(accent, .2));
    // A stitched seam nine units in.
    const stitch = css(inkc, .28);
    for (let x = 9 + r; x + 7 < w - 9 - r; x += 13) { polyline(ctx, [[x, 9], [x + 7, 9]], 1.4, stitch); polyline(ctx, [[x, h - 9], [x + 7, h - 9]], 1.4, stitch); }
    for (let y = 9 + r; y + 7 < h - 9 - r; y += 13) { polyline(ctx, [[9, y], [9, y + 7]], 1.4, stitch); polyline(ctx, [[w - 9, y], [w - 9, y + 7]], 1.4, stitch); }
    // Lace above the top edge and below the foot, unrolled from the left as the panel opens; hers the sea, rolling.
    const run = (w - 2 * r) * easeOut(open);
    if (who === "deepseek" && run > 1) {
      waveFill(ctx, r, r + run, 1, 4, 30, now * 1.5, -8, css(inkc, .92));
      waveFill(ctx, r, r + run, h - 1, 4, 30, now * 1.5 + Math.PI, h + 8, css(inkc, .92));
    } else if (run > 1) {
      ctx.save(); ctx.beginPath(); ctx.rect(r, -12, run, 13); ctx.clip(); scallops(ctx, r, 1, w - r, 1, 14, css(inkc, .92)); ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.rect(r, h - 1, run, 13); ctx.clip(); scallops(ctx, r, h - 1, w - r, h - 1, 14, css(inkc, .92)); ctx.restore();
    }
    // The apron bow on the top edge, right of the middle (it pops in last); hers her tail, flicking now and then.
    const pop = clamp((open - .6) / .4), k = pop <= 0 ? 0 : 1 + .35 * Math.sin(Math.PI * pop) * (1 - pop);
    if (k > 0 && who === "deepseek") {
      const cx = w * .72, cy = 6, flick = .12 * Math.sin(now * 2.2) * Math.max(0, Math.sin(now * .9));
      whaleTail(ctx, cx + flick * 40, cy - 14, 54 * k, accent, 1);
      bubble(ctx, cx + 30, cy - 34 - 6 * Math.sin(now * 2), 5 * k, css(accent, .8));
      bubble(ctx, cx + 42, cy - 52 - 5 * Math.sin(now * 2.4), 3.5 * k, css(accent, .6));
    } else if (k > 0) {
      const cx = w * .72, cy = 2, ribbon = css(accent), knot = css(inkc);
      triangle(ctx, [cx, cy], [cx - 30 * k, cy - 15 * k], [cx - 30 * k, cy + 15 * k], ribbon);
      triangle(ctx, [cx, cy], [cx + 30 * k, cy - 15 * k], [cx + 30 * k, cy + 15 * k], ribbon);
      triangle(ctx, [cx - 3 * k, cy + 2 * k], [cx - 14 * k, cy + 30 * k], [cx - 5 * k, cy + 27 * k], ribbon);
      triangle(ctx, [cx + 3 * k, cy + 2 * k], [cx + 14 * k, cy + 30 * k], [cx + 5 * k, cy + 27 * k], ribbon);
      disc(ctx, cx, cy, 9 * k, knot);
      spark(ctx, cx, cy, 6.5 * k, 1.8, ribbon, now * .6);
    }
  }

  /** Her start-up as the panel opens (SRhineClaudeBoot): a scan builds the card over a grid, tracers, brackets, sparks streaming to her bust, the rings, ONLINE. */
  private paintBoot(who: Mascot, now: number, c: { ink: Ink; paper: Ink; accent: Ink; panel: Ink }) {
    const t = this.hooks.reduced() ? -1 : now - this.openedAt;
    const [sw, sh] = this.size;
    if (t < 0 || t > 1.8 || sw < 80 || sh < 80) { if (this.headKey !== "off") { this.headKey = "off"; this.boot.clear(); } return; }
    this.headKey = "on";
    const ctx = this.boot.begin(sw + 80, sh + 80, this.hooks.density());
    ctx.translate(40, 40);
    const w = sw - 7, h = sh - 7, r = 22, bustX = 89, bustY = 30, whale = who === "deepseek";
    const win = (from: number, to: number) => clamp((t - from) / (to - from));
    const base = c.panel, inkc = c.ink, accent = c.accent;
    const token = (x: number, y: number, size: number, color: string) => whale ? bubble(ctx, x, y, size * .42, color) : heart(ctx, x, y, size, color);
    // The card not yet there: a blueprint grid under the scan line, which comes down from the top.
    const scan = h * ease(win(.18, .8));
    if (scan < h) {
      ctx.save(); ctx.beginPath(); ctx.rect(-2, scan, w + 4, h - scan + 2); ctx.clip();
      roundBox(ctx, 0, 0, w, h, r, css(base));
      ctx.fillStyle = css(accent, .16);
      for (let x = 18; x < w; x += 24) ctx.fillRect(x, 0, 1, h);
      for (let y = 18; y < h; y += 24) ctx.fillRect(0, y, w, 1);
      const cols = Math.max(1, Math.floor(w / 24)), rows = Math.max(1, Math.floor(h / 24));
      for (let i = 0; i < 26; i++) { ctx.fillStyle = css(i % 3 ? accent : inkc, .5); ctx.fillRect(18 + 24 * ((i * 7 + 3) % cols) - 2, 18 + 24 * ((i * 11 + Math.floor(now * 9)) % rows) - 2, 5, 5); }
      ctx.restore();
      if (scan > 0) {
        const dy = scan < r ? r - scan : scan > h - r ? scan - (h - r) : 0, inset = r - Math.sqrt(Math.max(0, r * r - dy * dy));
        for (let i = 1; i <= 6; i++) { ctx.fillStyle = css(accent, .13 * (1 - i / 7)); ctx.fillRect(inset, scan - 2 - i * 5, w - 2 * inset, 5); }
        ctx.fillStyle = css(inkc, .95); ctx.fillRect(inset, scan - 1.5, w - 2 * inset, 3);
        const percent = Math.round(100 * scan / h);
        roundBox(ctx, w - 118, scan - 26, 104, 20, 10, css(accent, .95));
        font(ctx, 11, 800, .4, uiFace());
        text(ctx, whale ? `同步中 ${percent}% ～` : `同步中 ${percent}% ♡`, w - 66, scan - 22, css(base), .5);
      }
    }
    // HUD brackets snapping onto the corners.
    const inB = backOut(win(.05, .4)), fadeB = 1 - win(1.35, 1.75);
    if (win(.05, .4) > 0 && fadeB > 0) {
      const off = 6 + 26 * (1 - inB), l = 24, color = css(inkc, .9 * fadeB);
      const corners: [number, number][] = [[-off, -off], [w + off, -off], [w + off, h + off], [-off, h + off]];
      corners.forEach(([x, y], i) => { const sx = i === 1 || i === 2 ? -1 : 1, sy = i >= 2 ? -1 : 1; polyline(ctx, [[x, y + sy * l], [x, y], [x + sx * l, y]], 2.6, color); });
    }
    // Her sparks and little hearts streaming in to where her bust is.
    for (let i = 0; i < 18; i++) {
      const start = i * .025, u = win(start, start + .55);
      if (u <= 0 || u >= 1) continue;
      const angle = i * 2.39996 + .4, far = (180 + 90 * ((i * 37) % 5) / 4) * (1 - easeOut(u));
      const x = bustX + Math.cos(angle) * far, y = bustY + Math.sin(angle) * .8 * far, fade = Math.sin(Math.PI * u);
      if (i % 3 === 0) token(x, y, 11, css(accent, fade)); else spark(ctx, x, y, 5 + (i % 2) * 2, 1.8, css(i % 2 ? inkc : accent, fade), now * 3 + i);
    }
    // Two rings of dashes spinning up round her bust, ticks and a heart riding the outer one.
    const inR = backOut(win(.3, .75)), fadeR = 1 - win(1.35, 1.8);
    if (win(.3, .75) > 0 && fadeR > 0) {
      const r1 = 70 * inR, r2 = 84 * inR, spin = now * 1.6;
      for (let i = 0; i < 28; i++) { const a0 = spin + i * Math.PI * 2 / 28, a1 = a0 + Math.PI * 2 / 28 * .55; polyline(ctx, [[bustX + Math.cos(a0) * r1, bustY + Math.sin(a0) * r1], [bustX + Math.cos(a1) * r1, bustY + Math.sin(a1) * r1]], 2, css(inkc, .75 * fadeR)); }
      for (let arc = 0; arc < 3; arc++) {
        const path: [number, number][] = [];
        for (let i = 0; i <= 12; i++) { const a = -spin * .8 + arc * Math.PI * 2 / 3 + i * (Math.PI * 2 / 3 * .62) / 12; path.push([bustX + Math.cos(a) * r2, bustY + Math.sin(a) * r2]); }
        polyline(ctx, path, 3, css(accent, .9 * fadeR));
      }
      const a = -spin * .8 + Math.PI * .3;
      token(bustX + Math.cos(a) * r2, bustY + Math.sin(a) * r2, 13, css(inkc, fadeR));
    }
    // Online: a toast flickering on in the middle (a glitch for its first moments), written out, then gone.
    const u = win(.78, .95), fadeT = 1 - win(1.5, 1.8);
    if (u > 0 && fadeT > 0) {
      const flicker = t < 1 && (t * 37) % 1 < .3, cx = w / 2, cy = h * .5, bw = whale ? 324 : 300, bh = 74, pop = .9 + .1 * backOut(u);
      roundBox(ctx, cx - bw * pop / 2 + 4, cy - bh * pop / 2 + 4, bw * pop, bh * pop, 18, css(accent, .9 * fadeT));
      roundBox(ctx, cx - bw * pop / 2, cy - bh * pop / 2, bw * pop, bh * pop, 18, css(base, .94 * fadeT * (flicker ? .6 : 1)));
      const line1 = whale ? "DEEPSEEK DIVE SYSTEM · ONLINE" : "CLAUDE MAID SYSTEM · ONLINE", letters = Math.max(0, Math.min([...line1].length, Math.floor((t - .82) * 60)));
      const face = uiFace();
      font(ctx, 13, 800, 2, face);
      const shown = [...line1].slice(0, letters).join("");
      if (t < 1.05) { const j = 2.5 * Math.sin(t * 90); text(ctx, shown, cx + j, cy - 24, css(accent, .8 * fadeT), .5); text(ctx, shown, cx - j, cy - 24, css([140, 217, 255], .5 * fadeT), .5); }
      text(ctx, shown, cx, cy - 24, css(inkc, fadeT), .5);
      if (t > 1) { font(ctx, 15, 800, .6, face); text(ctx, whale ? "大肥鱼 已就位 ～" : "小克 已就位 ♡", cx, cy + 4, css(accent, fadeT * win(1, 1.12)), .5); }
      spark(ctx, cx - bw * pop / 2 + 18, cy - bh * pop / 2 + 16, 7, 2, css(accent, fadeT), now * 2);
      if (whale) whaleTail(ctx, cx + bw * pop / 2 - 18, cy - bh * pop / 2 + 18, 22, accent, fadeT);
      else heart(ctx, cx + bw * pop / 2 - 18, cy - bh * pop / 2 + 16, 11, css(accent, fadeT));
    }
  }
}
