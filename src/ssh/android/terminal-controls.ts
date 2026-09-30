import type { Terminal } from "@xterm/xterm";
import { MAX_FONT_SIZE, MIN_FONT_SIZE, terminalAppearance } from "../terminal-appearance";
import { haptics } from "./haptics";
import { showTerminalKeyboard } from "./pipe";
import { AndroidTerminalInput } from "./terminal-input";
import { AndroidTerminalSelection } from "./terminal-selection";

/**
 * The key bar. One scrolling row, so the keys a shell needs on a phone (the ones a
 * soft keyboard hides behind a symbol page) are a tap away: `data-ssh-key` names a
 * key the terminal encodes (its cursor-key mode decides the escape), `data-ssh-text`
 * is sent as it is.
 */
const KEYS: readonly (readonly [attribute: "key" | "text", value: string, label: string, aria?: string])[] = [
  ["key", "keyboard", "键盘"], ["key", "control", "Ctrl"], ["key", "Escape", "Esc"], ["key", "Tab", "Tab"],
  ["key", "ArrowLeft", "←", "左"], ["key", "ArrowUp", "↑", "上"], ["key", "ArrowDown", "↓", "下"], ["key", "ArrowRight", "→", "右"],
  ["key", "Home", "Home"], ["key", "End", "End"], ["key", "PageUp", "PgUp"], ["key", "PageDown", "PgDn"],
  ["text", "|", "|"], ["text", "~", "~"], ["text", "/", "/"], ["text", "-", "-"], ["text", "_", "_"],
  ["key", "CtrlC", "^C", "中断 Ctrl+C"], ["key", "CtrlD", "^D", "结束输入 Ctrl+D"],
];
const REPEAT = new Set(["ArrowLeft", "ArrowUp", "ArrowDown", "ArrowRight", "PageUp", "PageDown"]);
/** A key held this long starts repeating, then repeats at this interval. */
const REPEAT_DELAY = 380, REPEAT_EVERY = 55;
const LOCK_HOLD = 450;
const MIN_FLING = 0.25; // px per ms

/** Mobile keys and pixel-to-line scrollback use the same active xterm buffer. */
export class MobileTerminalControls {
  /** `once`: the next character is a control character; `lock`: every one is, until turned off. */
  private control: "off" | "once" | "lock" = "off";
  private abort = new AbortController();
  private keyboard: AndroidTerminalInput;
  private selection: AndroidTerminalSelection;
  private readonly terminal: () => Terminal;
  private readonly usable: () => boolean;
  private fling = 0;
  private repeatTimer = 0;
  constructor(root: HTMLElement, screen: HTMLElement, terminal: () => Terminal, usable: () => boolean, copy: () => void) {
    this.terminal = terminal;
    this.usable = usable;
    this.keyboard = new AndroidTerminalInput(screen, terminal, usable);
    // Install before scroll handling so a long-press drag owns its gesture.
    this.selection = new AndroidTerminalSelection(root, screen, terminal, usable, copy);
    const bar = document.createElement("div"); bar.className = "ssh-mobile-keys";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "终端按键");
    bar.innerHTML = KEYS.map(([attribute, value, label, aria]) => {
      const pressed = value === "control" ? ' aria-pressed="false"' : "";
      const name = aria ? ` aria-label="${aria}"` : "";
      const data = attribute === "key" ? `data-ssh-key="${value}"` : `data-ssh-text="${value}"`;
      return `<button type="button" ${data}${pressed}${name}>${label}</button>`;
    }).join("");
    root.querySelector(".ssh-terminal-foot")!.prepend(bar);
    const options = { signal: this.abort.signal };
    bar.addEventListener("pointerdown", event => event.preventDefault(), options);
    const control = bar.querySelector<HTMLButtonElement>('[data-ssh-key="control"]')!;
    this.updateControl = () => {
      control.setAttribute("aria-pressed", String(this.control !== "off"));
      control.dataset.locked = String(this.control === "lock");
    };

    // Ctrl: a tap arms the next character, a second tap disarms, a long press locks it on.
    let holdTimer = 0, held = false;
    control.addEventListener("pointerdown", () => {
      held = false;
      holdTimer = window.setTimeout(() => { held = true; this.control = "lock"; this.updateControl(); haptics.lock(); }, LOCK_HOLD);
    }, options);
    const release = () => window.clearTimeout(holdTimer);
    control.addEventListener("pointerup", release, options);
    control.addEventListener("pointercancel", release, options);
    control.addEventListener("pointerleave", release, options);
    control.addEventListener("click", () => {
      if (!this.usable() || held) return;
      this.control = this.control === "off" ? "once" : "off";
      this.updateControl();
    }, options);

    // Cursor and paging keys repeat while held: pointerdown sends the first, the click that follows is ignored.
    const send = (button: HTMLButtonElement) => {
      this.terminal().focus();
      const name = button.dataset.sshKey, text = button.dataset.sshText;
      haptics.tick();
      if (name === "keyboard") { void showTerminalKeyboard().catch(() => {}); return; }
      const data = text ?? (name ? this.sequence(name) : undefined);
      if (data) this.terminal().input(data, true);
    };
    let repeated: HTMLButtonElement | undefined;
    let press = 0;
    const stopRepeat = () => { window.clearTimeout(this.repeatTimer); window.clearInterval(this.repeatTimer); this.repeatTimer = 0; };
    // The click that follows a press pointerdown already sent has to be ignored, and it arrives after
    // pointerup, pointerout and pointerleave: on a touch screen the browser fires those first, so
    // forgetting the key on pointerleave let that click send the key a second time (one tap moved
    // two lines). The key is forgotten a moment after the press ends instead; if no click comes
    // (the finger moved off, the bar scrolled) nothing is left waiting for one.
    const forgetLater = () => {
      stopRepeat();
      const at = press;
      window.setTimeout(() => { if (press === at) repeated = undefined; }, 600);
    };
    bar.addEventListener("pointerdown", event => {
      const button = (event.target as Element).closest<HTMLButtonElement>("[data-ssh-key]");
      if (!button || !this.usable() || !REPEAT.has(button.dataset.sshKey!)) return;
      repeated = button;
      press += 1;
      send(button);
      stopRepeat();
      this.repeatTimer = window.setTimeout(() => { this.repeatTimer = window.setInterval(() => { if (this.usable()) send(button); else stopRepeat(); }, REPEAT_EVERY); }, REPEAT_DELAY);
    }, options);
    for (const type of ["pointercancel", "pointerleave", "pointerup"]) bar.addEventListener(type, forgetLater, options);
    bar.addEventListener("click", event => {
      const button = (event.target as Element).closest<HTMLButtonElement>("[data-ssh-key], [data-ssh-text]");
      if (!button || !this.usable() || button.dataset.sshKey === "control") return;
      if (button === repeated) { repeated = undefined; return; }
      send(button);
    }, options);

    // One finger scrolls (with a fling), two fingers pinch the font size.
    let lastY = 0, dragging = false, remainder = 0, lastT = 0, velocity = 0;
    let pinch: { distance: number; size: number; at: number } | undefined;
    const lineHeight = () => { const term = this.terminal(); return (term.options.fontSize || 12) * (term.options.lineHeight || 1.25); };
    const scrollBy = (pixels: number) => {
      const term = this.terminal(), line = lineHeight();
      remainder += pixels;
      const lines = Math.trunc(remainder / line);
      if (!lines) return;
      remainder -= lines * line;
      if (term.buffer.active.type === "normal") term.scrollLines(lines);
      else screen.querySelector(".xterm-screen")?.dispatchEvent(new WheelEvent("wheel", { deltaY: lines * line, bubbles: true, cancelable: true }));
    };
    const stopFling = () => { window.cancelAnimationFrame(this.fling); this.fling = 0; };
    const distance = (event: TouchEvent) => Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY);
    screen.addEventListener("touchstart", event => {
      stopFling();
      if (event.touches.length === 2 && this.usable()) {
        dragging = false;
        pinch = { distance: distance(event), size: terminalAppearance.value.size, at: 0 };
        return;
      }
      pinch = undefined;
      dragging = event.touches.length === 1 && this.usable(); remainder = 0; velocity = 0;
      if (dragging) { lastY = event.touches[0].clientY; lastT = performance.now(); }
    }, { ...options, passive: true, capture: true });
    screen.addEventListener("touchmove", event => {
      if (pinch && event.touches.length === 2 && this.usable()) {
        // The font store refits the grid, so it is asked at most every 90 ms and only when a step is crossed.
        const now = performance.now();
        const size = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round((pinch.size * distance(event) / pinch.distance) * 2) / 2));
        if (size !== terminalAppearance.value.size && now - pinch.at > 90) { pinch.at = now; terminalAppearance.update({ size }); }
        event.preventDefault(); event.stopImmediatePropagation();
        return;
      }
      if (!dragging || event.touches.length !== 1 || !this.usable()) return;
      const y = event.touches[0].clientY, now = performance.now(), dy = lastY - y;
      // Velocity over the last few moves, for the fling when the finger lifts.
      velocity = now > lastT ? velocity * 0.6 + (dy / (now - lastT)) * 0.4 : velocity;
      lastY = y; lastT = now;
      scrollBy(dy);
      event.preventDefault(); event.stopImmediatePropagation();
    }, { ...options, passive: false, capture: true });
    const end = () => {
      const start = velocity;
      const wasDragging = dragging;
      dragging = false; pinch = undefined;
      if (!wasDragging || Math.abs(start) < MIN_FLING || performance.now() - lastT > 80) return;
      // Coasting: the finger's last speed, decaying about 6% a frame (a 60 Hz frame is 16.7 ms).
      let speed = start, previous = performance.now();
      const step = (now: number) => {
        const dt = Math.min(48, now - previous); previous = now;
        speed *= Math.pow(0.94, dt / 16.7);
        if (Math.abs(speed) < 0.03 || !this.usable()) { this.fling = 0; return; }
        scrollBy(speed * dt);
        this.fling = window.requestAnimationFrame(step);
      };
      this.fling = window.requestAnimationFrame(step);
    };
    screen.addEventListener("touchend", end, options);
    screen.addEventListener("touchcancel", () => { dragging = false; pinch = undefined; stopFling(); }, options);
  }
  private updateControl: () => void;
  /** The escape sequence a named key sends, following the cursor-key mode the program chose. */
  private sequence(name: string) {
    const application = this.terminal().modes.applicationCursorKeysMode;
    const cursor = (final: string) => (application ? `\x1bO${final}` : `\x1b[${final}`);
    switch (name) {
      case "Escape": return "\x1b";
      case "Tab": return "\t";
      case "ArrowUp": return cursor("A");
      case "ArrowDown": return cursor("B");
      case "ArrowRight": return cursor("C");
      case "ArrowLeft": return cursor("D");
      case "Home": return cursor("H");
      case "End": return cursor("F");
      case "PageUp": return "\x1b[5~";
      case "PageDown": return "\x1b[6~";
      case "CtrlC": return "\x03";
      case "CtrlD": return "\x04";
      default: return undefined;
    }
  }
  input(data: string) {
    if (this.control === "off" || data.length !== 1 || !this.usable()) return data;
    if (this.control === "once") { this.control = "off"; this.updateControl(); }
    const code = data.toUpperCase().charCodeAt(0);
    return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : data === " " ? "\0" : data;
  }
  suspend() {
    this.keyboard.reset(); this.selection.reset();
    window.cancelAnimationFrame(this.fling); this.fling = 0;
    window.clearTimeout(this.repeatTimer); window.clearInterval(this.repeatTimer); this.repeatTimer = 0;
    this.control = "off"; this.updateControl();
  }
  dispose() { this.suspend(); this.keyboard.dispose(); this.selection.dispose(); this.abort.abort(); }
}
