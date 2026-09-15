import type { Terminal } from "@xterm/xterm";
import { showTerminalKeyboard } from "./pipe";

/** Mobile keys and pixel-to-line scrollback use the same active xterm buffer. */
export class MobileTerminalControls {
  private control = false;
  private abort = new AbortController();
  constructor(root: HTMLElement, screen: HTMLElement, private terminal: () => Terminal, private usable: () => boolean) {
    const bar = document.createElement("div"); bar.className = "ssh-mobile-keys";
    bar.innerHTML = '<button type="button" data-ssh-key="keyboard">键盘</button><button type="button" data-ssh-key="control" aria-pressed="false">Ctrl</button><button type="button" data-ssh-key="Escape">Esc</button><button type="button" data-ssh-key="Tab">Tab</button><button type="button" data-ssh-key="ArrowLeft" aria-label="左">←</button><button type="button" data-ssh-key="ArrowUp" aria-label="上">↑</button><button type="button" data-ssh-key="ArrowDown" aria-label="下">↓</button><button type="button" data-ssh-key="ArrowRight" aria-label="右">→</button>';
    root.querySelector(".ssh-terminal-foot")!.prepend(bar);
    const options = { signal: this.abort.signal };
    bar.addEventListener("pointerdown", event => event.preventDefault(), options);
    bar.addEventListener("click", event => {
      const button = (event.target as Element).closest<HTMLButtonElement>("[data-ssh-key]");
      if (!button || !usable()) return;
      if (button.dataset.sshKey === "control") { this.control = !this.control; button.setAttribute("aria-pressed", String(this.control)); return; }
      this.terminal().focus();
      if (button.dataset.sshKey === "keyboard") { void showTerminalKeyboard().catch(() => {}); return; }
      const keys: Record<string, string> = { Escape: "\x1b", Tab: "\t", ArrowLeft: "\x1b[D", ArrowRight: "\x1b[C", ArrowUp: "\x1b[A", ArrowDown: "\x1b[B" };
      this.terminal().input(keys[button.dataset.sshKey!], true);
    }, options);
    let lastY = 0, held = false, remainder = 0;
    screen.addEventListener("touchstart", event => {
      held = event.touches.length === 1 && usable(); remainder = 0;
      if (held) lastY = event.touches[0].clientY;
    }, { ...options, passive: true, capture: true });
    screen.addEventListener("touchmove", event => {
      if (!held || event.touches.length !== 1 || !usable()) return;
      const term = this.terminal(), y = event.touches[0].clientY;
      remainder += lastY - y; lastY = y;
      const line = (term.options.fontSize || 12) * (term.options.lineHeight || 1.25);
      const lines = Math.trunc(remainder / line);
      if (lines) {
        remainder -= lines * line;
        if (term.buffer.active.type === "normal") term.scrollLines(lines);
        else screen.querySelector(".xterm-screen")?.dispatchEvent(new WheelEvent("wheel", { deltaY: lines * line, bubbles: true, cancelable: true }));
      }
      event.preventDefault(); event.stopImmediatePropagation();
    }, { ...options, passive: false, capture: true });
    screen.addEventListener("touchend", () => { held = false; }, options);
    screen.addEventListener("touchcancel", () => { held = false; }, options);
    this.updateControl = () => bar.querySelector('[data-ssh-key="control"]')!.setAttribute("aria-pressed", "false");
  }
  private updateControl: () => void;
  input(data: string) {
    if (!this.control || data.length !== 1 || !this.usable()) return data;
    this.control = false; this.updateControl();
    const code = data.toUpperCase().charCodeAt(0);
    return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : data === " " ? "\0" : data;
  }
  dispose() { this.abort.abort(); }
}
