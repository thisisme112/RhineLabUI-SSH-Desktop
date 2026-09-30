import type { Terminal } from "@xterm/xterm";

/** Android IMEs deliver edits, not reliable keypresses. Own text commits so
 * xterm's keyCode-229 textarea diff timer cannot replay already-sent symbols. */
export class AndroidTerminalInput {
  private events = new AbortController();
  private composing = false;
  private pending: { text: string; term: Terminal } | undefined;
  private timer?: number;
  constructor(
    private screen: HTMLElement,
    private terminal: () => Terminal,
    private usable: () => boolean,
  ) {
    const options = { capture: true, signal: this.events.signal };
    const textarea = (event: Event) =>
      event.target === this.terminal().textarea;
    screen.addEventListener(
      "keydown",
      (event) => {
        if (!textarea(event)) return;
        if (!this.usable()) {
          this.reset();
          event.stopImmediatePropagation();
          return;
        }
        if (!this.composing) this.flush();
        if (
          this.composing ||
          event.isComposing ||
          event.keyCode === 229 ||
          event.key === "Dead" ||
          (!event.ctrlKey &&
            !event.metaKey &&
            !event.altKey &&
            [...event.key].length === 1)
        )
          event.stopImmediatePropagation();
      },
      options,
    );
    screen.addEventListener(
      "keypress",
      (event) => {
        if (
          textarea(event) &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey
        )
          event.stopImmediatePropagation();
      },
      options,
    );
    screen.addEventListener(
      "compositionstart",
      (event) => {
        if (!textarea(event)) return;
        event.stopImmediatePropagation();
        this.flush();
        this.composing = true;
      },
      options,
    );
    screen.addEventListener(
      "compositionupdate",
      (event) => {
        if (!textarea(event)) return;
        event.stopImmediatePropagation();
        this.preview(event.data);
      },
      options,
    );
    screen.addEventListener(
      "compositionend",
      (event) => {
        if (!textarea(event)) return;
        event.stopImmediatePropagation();
        this.composing = false;
        this.preview("");
        this.pending = { text: event.data, term: this.terminal() };
        this.timer = window.setTimeout(() => this.flush(), 0);
      },
      options,
    );
    screen.addEventListener(
      "beforeinput",
      (event) => {
        if (
          !(event instanceof InputEvent) ||
          !textarea(event) ||
          !this.usable() ||
          this.composing ||
          event.isComposing ||
          !event.cancelable
        )
          return;
        const keys: Record<string, string> = {
          deleteContentBackward: "\x7f",
          deleteContentForward: "\x1b[3~",
          insertLineBreak: "\r",
          insertParagraph: "\r",
        };
        const key = keys[event.inputType];
        if (!key) return;
        // The helper textarea is empty after a commit: deleting from it may
        // produce no input event at all. Own this edit before the browser acts.
        event.preventDefault();
        event.stopImmediatePropagation();
        this.flush();
        this.terminal().input(key, true);
      },
      options,
    );
    screen.addEventListener(
      "input",
      (event) => {
        if (!(event instanceof InputEvent)) return;
        if (!textarea(event)) return;
        event.stopImmediatePropagation();
        if (!this.usable()) {
          this.reset();
          return;
        }
        if (this.composing || event.isComposing) return;
        // WebView can emit one last input after compositionend. It is the same
        // commit, not another character. A subsequent keydown flushes this first.
        if (
          this.pending &&
          (event.inputType === "insertFromComposition" ||
            event.inputType === "insertCompositionText" ||
            event.data === this.pending.text)
        ) {
          this.flush();
          return;
        }
        this.flush();
        const term = this.terminal();
        if (event.inputType === "deleteContentBackward")
          term.input("\x7f", true);
        else if (event.inputType === "deleteContentForward")
          term.input("\x1b[3~", true);
        else if (
          event.inputType === "insertLineBreak" ||
          event.inputType === "insertParagraph"
        )
          term.input("\r", true);
        else if (event.inputType === "insertFromPaste")
          term.paste(event.data ?? term.textarea?.value ?? "");
        else if (event.inputType.startsWith("insert"))
          term.input(event.data ?? term.textarea?.value ?? "", true);
        if (term.textarea) term.textarea.value = "";
      },
      options,
    );
    screen.addEventListener(
      "blur",
      (event) => {
        if (textarea(event)) this.reset();
      },
      options,
    );
  }
  private preview(text: string) {
    const view = this.screen.querySelector<HTMLElement>(".composition-view");
    if (view) {
      const term = this.terminal();
      view.style.left = term.textarea?.style.left ?? "";
      view.style.top = term.textarea?.style.top ?? "";
      view.style.fontFamily = term.options.fontFamily ?? "monospace";
      view.style.fontSize = `${term.options.fontSize || 13}px`;
      view.textContent = text;
      view.classList.toggle("active", Boolean(text));
    }
  }
  private flush() {
    window.clearTimeout(this.timer);
    this.timer = undefined;
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return;
    if (pending.term === this.terminal() && this.usable() && pending.text)
      pending.term.input(pending.text, true);
    if (pending.term.textarea) pending.term.textarea.value = "";
  }
  reset() {
    window.clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
    this.composing = false;
    this.preview("");
    if (this.terminal().textarea) this.terminal().textarea!.value = "";
  }
  dispose() {
    this.reset();
    this.events.abort();
  }
}
