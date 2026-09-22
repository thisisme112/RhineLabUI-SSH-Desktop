import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import type { IDisposable, Terminal } from "@xterm/xterm";
import { SurfaceTransition } from "../ui-transitions";
import { SshPageMotion } from "./page-motion";
import type { SshClient } from "./client";
import { terminalAppearance, TERMINAL_FONTS, DEFAULT_FONT_SIZE, MIN_FONT_SIZE, MAX_FONT_SIZE } from "./terminal-appearance";

const HIGHLIGHT_LIMIT = 1000;

export const TERMINAL_TOOLS_MARKUP = `
  <div class="ssh-terminal-tools" id="ssh-terminal-tools" hidden inert>
    <div class="ssh-terminal-find-row" data-ssh-reveal>
      <label class="ssh-terminal-find">
        <span>查找输出</span>
        <input type="search" class="ssh-terminal-query" placeholder="输入要查找的文字"
          maxlength="512" autocomplete="off" autocapitalize="off" spellcheck="false"
          aria-describedby="ssh-terminal-search-count">
      </label>
      <output id="ssh-terminal-search-count" class="ssh-terminal-search-count" aria-live="polite">输入文字开始查找</output>
      <button type="button" data-terminal-tool="previous" title="上一项 · Shift+Enter" aria-label="上一个匹配结果" disabled>↑</button>
      <button type="button" data-terminal-tool="next" title="下一项 · Enter" aria-label="下一个匹配结果" disabled>↓</button>
      <button type="button" data-terminal-tool="case" title="区分大小写" aria-label="区分大小写" aria-pressed="false">Aa</button>
      <button type="button" data-terminal-tool="return" title="收起操作区并返回终端输入 · Esc">返回输入 ↵</button>
    </div>
    <div class="ssh-terminal-tool-actions" data-ssh-reveal>
      <button type="button" data-terminal-tool="copy" title="复制选中输出 · Ctrl+C / Ctrl+Shift+C" disabled>复制选中</button>
      <button type="button" data-terminal-tool="paste" title="粘贴到终端 · Ctrl+V / Ctrl+Shift+V / Shift+Insert / ⌘V" disabled>粘贴</button>
      <div class="ssh-terminal-font" role="group" aria-label="终端字号">
        <span>字号</span>
        <button type="button" data-terminal-tool="smaller" aria-label="减小终端字号">A−</button>
        <button type="button" data-terminal-tool="font" title="恢复默认字号">${DEFAULT_FONT_SIZE}</button>
        <input class="ssh-terminal-font-value" type="number" min="8" max="32" step="0.5" value="${DEFAULT_FONT_SIZE}" aria-label="终端字号，8 到 32 像素">
        <button type="button" data-terminal-tool="larger" aria-label="增大终端字号">A+</button>
      </div>
      <span class="ssh-terminal-tool-hint">Enter 下一项 · Shift+Enter 上一项</span>
    </div>
    <div class="ssh-terminal-typography" data-ssh-reveal>
      <label>字体<select data-terminal-appearance="font">${Object.entries(TERMINAL_FONTS).map(([id, font]) => `<option value="${id}">${font.name}</option>`).join("")}</select></label>
      <label>字距<input type="number" data-terminal-appearance="spacing" min="-1" max="3" step="0.1" aria-label="字距，像素"><span>px</span></label>
      <label>行距<input type="number" data-terminal-appearance="lineHeight" min="1" max="2" step="0.05" aria-label="行距倍数"><span>倍</span></label>
      <button type="button" data-terminal-tool="appearance-reset">恢复排版</button>
    </div>
  </div>`;

export function isTerminalToolShortcut(event: KeyboardEvent) {
  const key = event.key.toLowerCase();
  if (event.altKey) return false;
  return (
    (event.ctrlKey && !event.metaKey &&
      (key === "v" || (event.shiftKey && ["f", "p", "c"].includes(key)))) ||
    (event.metaKey && !event.ctrlKey && !event.shiftKey && key === "v") ||
    (event.shiftKey && !event.ctrlKey && !event.metaKey && key === "insert")
  );
}

/** Tools live in the existing terminal footer and use its only xterm buffer. */
export class TerminalTools {
  private panel: HTMLElement;
  private toggle: HTMLButtonElement;
  private query: HTMLInputElement;
  private count: HTMLOutputElement;
  private feedback: HTMLElement;
  private buttons: Record<string, HTMLButtonElement> = {};
  private transition: SurfaceTransition;
  private motion = new SshPageMotion();
  private events = new AbortController();
  private term?: Terminal;
  private search?: SearchAddon;
  private subscriptions: IDisposable[] = [];
  private expanded = false;
  private searching = false;
  private caseSensitive = false;
  private dark = false;
  private reduced = false;
  private operation = 0;
  private clipboardBusy = false;
  private feedbackTimer?: number;
  get fontSize() { return terminalAppearance.value.size; }
  private offAppearance: () => void;

  constructor(
    private root: HTMLElement,
    private client: SshClient,
    private host: {
      visible(): boolean;
      hasShell(): boolean;
      fit(): void;
      focus(): void;
    },
  ) {
    this.panel = root.querySelector<HTMLElement>(".ssh-terminal-tools")!;
    this.toggle = root.querySelector<HTMLButtonElement>(
      ".ssh-terminal-shortcut",
    )!;
    this.query = root.querySelector<HTMLInputElement>(".ssh-terminal-query")!;
    this.count = root.querySelector<HTMLOutputElement>(
      ".ssh-terminal-search-count",
    )!;
    this.feedback = root.querySelector<HTMLElement>(
      ".ssh-terminal-tool-feedback",
    )!;
    for (const button of this.panel.querySelectorAll<HTMLButtonElement>(
      "[data-terminal-tool]",
    ))
      this.buttons[button.dataset.terminalTool!] = button;
    this.transition = new SurfaceTransition(this.panel, undefined, 220, 160);
    const options = { signal: this.events.signal };
    this.panel.querySelector<HTMLInputElement>(".ssh-terminal-font-value")!.addEventListener("change", event => {
      const value = Number((event.target as HTMLInputElement).value);
      if (Number.isFinite(value)) this.setFontSize(value);
    }, options);
    this.panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-terminal-appearance]").forEach(input => {
      input.addEventListener("change", () => {
        const key = input.dataset.terminalAppearance!;
        terminalAppearance.update({ [key]: key === "font" ? input.value : Number(input.value) });
        if (terminalAppearance.error) this.message(terminalAppearance.error);
      }, options);
    });
    this.offAppearance = terminalAppearance.onChange(() => this.applyTypography());
    this.toggle.addEventListener(
      "click",
      () => (this.expanded ? this.close() : this.show()),
      options,
    );
    this.query.addEventListener(
      "input",
      (event) => {
        if (!(event instanceof InputEvent) || !event.isComposing)
          this.find(1, true);
      },
      options,
    );
    this.query.addEventListener(
      "compositionend",
      () => this.find(1, true),
      options,
    );
    this.panel.addEventListener(
      "click",
      (event) => {
        const action =
          event.target instanceof Element
            ? event.target.closest<HTMLButtonElement>("[data-terminal-tool]")
                ?.dataset.terminalTool
            : undefined;
        switch (action) {
          case "previous":
            this.find(-1);
            break;
          case "next":
            this.find(1);
            break;
          case "case":
            this.caseSensitive = !this.caseSensitive;
            this.buttons.case.setAttribute(
              "aria-pressed",
              String(this.caseSensitive),
            );
            // Force a fresh result set even when the search text is unchanged.
            this.search?.clearDecorations();
            this.find(1, true);
            break;
          case "return":
            this.close();
            break;
          case "copy":
            void this.copy();
            break;
          case "paste":
            void this.paste();
            break;
          case "smaller":
            this.setFontSize(this.fontSize - 1);
            break;
          case "larger":
            this.setFontSize(this.fontSize + 1);
            break;
          case "font":
            this.setFontSize(DEFAULT_FONT_SIZE);
            break;
          case "appearance-reset":
            terminalAppearance.reset();
            break;
        }
      },
      options,
    );
    root.addEventListener("keydown", (event) => this.onKey(event), {
      ...options,
      capture: true,
    });
    // Only a mouse selection copies automatically; search and programmatic
    // selections must not overwrite the system clipboard.
    const screen = root.querySelector<HTMLElement>(".ssh-terminal-screen")!;
    let selecting = false;
    screen.addEventListener("mousedown", event => {
      selecting = event.button === 0 && this.available;
    }, options);
    document.addEventListener("mouseup", event => {
      if (!selecting || event.button !== 0) return;
      selecting = false;
      // xterm finalizes its selection in its own document mouseup listener.
      window.setTimeout(() => {
        if (this.available && this.term?.hasSelection()) void this.copy();
      }, 0);
    }, options);
    window.addEventListener("blur", () => { selecting = false; }, options);
    root.querySelector(".ssh-terminal-screen")!.addEventListener(
      "contextmenu",
      (event) => {
        if (!this.available || !this.host.hasShell()) return;
        event.preventDefault();
        this.show(false);
      },
      options,
    );
    this.updateFontControls();
  }

  attach(term: Terminal) {
    this.term = term;
    this.applyTypography();
    this.search = new SearchAddon({ highlightLimit: HIGHLIGHT_LIMIT });
    term.loadAddon(this.search);
    this.subscriptions = [
      this.search.onDidChangeResults(({ resultIndex, resultCount }) => {
        if (!this.expanded || !this.query.value) return;
        this.count.textContent =
          resultCount === 0
            ? "没有匹配结果"
            : resultIndex < 0
              ? `至少 ${resultCount} 项`
              : `${resultIndex + 1} / ${resultCount}`;
        this.count.dataset.empty = String(resultCount === 0);
        this.buttons.previous.disabled = this.buttons.next.disabled =
          resultCount === 0;
      }),
      term.onSelectionChange(() => this.sync()),
    ];
    this.sync();
  }

  private get available() {
    return this.host.visible() && !this.root.inert;
  }

  private get canPaste() {
    return (
      this.available &&
      this.host.hasShell() &&
      this.client.active &&
      this.client.status().phase === "interactive"
    );
  }

  sync() {
    this.toggle.hidden = !this.host.hasShell() || !this.host.visible();
    // Keep a clicked control focused while its clipboard request is pending.
    // Disabling it here would blur it and invalidate that very paste request.
    this.buttons.copy.disabled = !this.term?.hasSelection();
    this.buttons.paste.disabled = !this.canPaste;
  }

  setAppearance(dark: boolean, reduced: boolean) {
    if (reduced && !this.reduced) {
      this.transition.finish();
      this.motion.finish();
    }
    const themeChanged = dark !== this.dark;
    this.dark = dark;
    this.reduced = reduced;
    if (themeChanged && this.searching) {
      this.search?.clearDecorations();
      this.find(1, true);
    }
  }

  private show(focusSearch = false) {
    if (!this.available || !this.host.hasShell()) return;
    if (!this.expanded) {
      const fresh = this.panel.hidden;
      this.expanded = true;
      this.panel.inert = false;
      this.toggle.setAttribute("aria-expanded", "true");
      this.transition.show(this.reduced);
      if (fresh) this.motion.reveal(this.panel, this.reduced);
      // Reserve the final height once. Animating height would make ConPTY
      // redraw on every animation frame and disturb full-screen programs.
      this.host.fit();
      if (this.query.value && (focusSearch || !this.term?.hasSelection()))
        this.find(1, true);
    }
    if (focusSearch) {
      this.query.focus({ preventScroll: true });
      this.query.select();
    } else if (this.term?.hasSelection())
      this.buttons.copy.focus({ preventScroll: true });
    else this.query.focus({ preventScroll: true });
    this.sync();
  }

  private close(restoreFocus = true, immediate = false) {
    this.expanded = false;
    this.panel.inert = true;
    this.toggle.setAttribute("aria-expanded", "false");
    this.stopSearch();
    this.transition.hide(immediate || this.reduced, () => {
      this.motion.cancel();
      this.host.fit();
    });
    if (restoreFocus) this.host.focus();
  }

  private stopSearch() {
    if (this.searching) {
      this.search?.clearDecorations();
      this.term?.clearSelection();
    }
    this.searching = false;
    this.count.textContent = "输入文字开始查找";
    delete this.count.dataset.empty;
    this.buttons.previous.disabled = this.buttons.next.disabled = true;
  }

  private find(direction: 1 | -1, incremental = false) {
    if (
      !this.expanded ||
      !this.available ||
      !this.search ||
      !this.term?.element
    )
      return;
    if (!this.query.value) {
      this.stopSearch();
      return;
    }
    this.searching = true;
    const match = this.dark ? "#554936" : "#dbccb7";
    const active = this.dark ? "#84633e" : "#c6a575";
    const border = this.dark ? "#cda265" : "#9b7247";
    const options: ISearchOptions = {
      incremental,
      caseSensitive: this.caseSensitive,
      decorations: {
        matchBackground: match,
        matchOverviewRuler: border,
        activeMatchBackground: active,
        activeMatchBorder: border,
        activeMatchColorOverviewRuler: border,
      },
    };
    if (direction === -1) this.search.findPrevious(this.query.value, options);
    else this.search.findNext(this.query.value, options);
  }

  private onKey(event: KeyboardEvent) {
    if (!this.available || event.isComposing) return;
    if (event.target instanceof Element && event.target.closest(".ssh-terminal") !== this.root) return;
    if (
      event.target instanceof Element &&
      event.target.closest(
        "[data-ssh-auxiliary], .ssh-workspace-tabs, .ssh-side-divider",
      )
    )
      return;
    const inTools =
      event.target instanceof Node && this.panel.contains(event.target);
    const copySelection = event.key.toLowerCase() === "c" &&
      !event.altKey && !event.shiftKey && (event.ctrlKey !== event.metaKey) &&
      this.term?.hasSelection();
    if (isTerminalToolShortcut(event) || copySelection) {
      const key = event.key.toLowerCase();
      if (
        ["c", "v", "insert"].includes(key) &&
        event.target instanceof Element &&
        !event.target.closest(".xterm") &&
        event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
      ) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (key === "f") {
        this.show(true);
        if (this.query.value && !this.searching) this.find(1, true);
      }
      if (key === "p") this.expanded ? this.close() : this.show();
      if (key === "c") void this.copy();
      if (key === "v" || key === "insert") void this.paste();
    } else if (inTools && event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.close();
    } else if (event.target === this.query && event.key === "Enter") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.find(event.shiftKey ? -1 : 1);
    }
  }

  private setFontSize(size: number) {
    if (!this.available || !this.term) return;
    terminalAppearance.update({ size });
  }

  private applyTypography() {
    if (this.term) this.term.options = terminalAppearance.options();
    this.updateFontControls();
    // Font loading must complete before FitAddon measures the cell grid.
    void terminalAppearance.ready().then(() => { if (this.term) this.host.fit(); });
  }

  private updateFontControls() {
    this.panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-terminal-appearance]").forEach(input => {
      const key = input.dataset.terminalAppearance as "font" | "spacing" | "lineHeight";
      if (document.activeElement !== input) input.value = String(terminalAppearance.value[key]);
    });
    this.panel.querySelector<HTMLInputElement>(".ssh-terminal-font-value")!.value = String(this.fontSize);
    this.buttons.font.textContent = String(this.fontSize);
    this.buttons.font.setAttribute(
      "aria-label",
      `当前字号 ${this.fontSize}，恢复默认字号 ${DEFAULT_FONT_SIZE}`,
    );
    this.buttons.smaller.disabled = this.fontSize === MIN_FONT_SIZE;
    this.buttons.larger.disabled = this.fontSize === MAX_FONT_SIZE;
  }

  private message(text: string) {
    window.clearTimeout(this.feedbackTimer);
    this.feedback.textContent = text;
    this.feedback.hidden = !text;
    this.feedback.title = text;
    if (text)
      this.feedbackTimer = window.setTimeout(() => this.message(""), 4500);
  }

  private async copy() {
    if (!this.available || !this.term || this.clipboardBusy) return;
    const text = this.term.getSelection();
    if (!text) {
      this.message("先选择要复制的输出");
      return;
    }
    const clipboard = window.rhineDesktop?.clipboard;
    if (!clipboard) {
      this.message("剪贴板不可用");
      return;
    }
    const operation = ++this.operation;
    this.clipboardBusy = true;
    this.sync();
    try {
      const result = await clipboard.writeText(text);
      if (operation === this.operation && this.available)
        this.message(result.ok ? "已复制选中输出" : result.error || "复制失败");
    } catch {
      if (operation === this.operation && this.available)
        this.message("复制失败，请重试");
    } finally {
      if (operation === this.operation) {
        this.clipboardBusy = false;
        this.sync();
      }
    }
  }

  private async paste() {
    if (!this.canPaste || !this.term || this.clipboardBusy) return;
    const clipboard = window.rhineDesktop?.clipboard;
    if (!clipboard) {
      this.message("剪贴板不可用");
      return;
    }
    const term = this.term,
      generation = this.client.generation;
    const focus = document.activeElement;
    const operation = ++this.operation;
    this.clipboardBusy = true;
    this.sync();
    try {
      const result = await clipboard.readText();
      // A delayed read must not cross a collapse, reconnect or focus change.
      if (
        operation !== this.operation ||
        term !== this.term ||
        generation !== this.client.generation ||
        !this.canPaste
      )
        return;
      if (document.activeElement !== focus) {
        this.message("已取消粘贴");
        return;
      }
      if (!result.ok) {
        this.message(result.error || "粘贴失败");
        return;
      }
      if (!result.text) {
        this.message("剪贴板中没有文本");
        return;
      }
      term.paste(result.text);
      this.host.focus();
      this.message("已粘贴");
    } catch {
      if (operation === this.operation && this.available)
        this.message("粘贴失败，请重试");
    } finally {
      if (operation === this.operation) {
        this.clipboardBusy = false;
        this.sync();
      }
    }
  }

  suspend() {
    this.operation++;
    this.clipboardBusy = false;
    this.close(false, true);
    this.message("");
  }

  resetSession() {
    this.suspend();
    this.query.value = "";
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions = [];
    // The old xterm owns and disposes its addon along with its buffer.
    this.search = undefined;
    this.term = undefined;
  }

  dispose() {
    this.offAppearance();
    this.resetSession();
    this.events.abort();
    this.transition.dispose();
    this.motion.cancel();
  }
}
