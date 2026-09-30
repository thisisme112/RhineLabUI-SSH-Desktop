import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "../../src/android.css";
import { MobileTerminalControls } from "../../src/ssh/android/terminal-controls";
import { terminalAppearance } from "../../src/ssh/terminal-appearance";
import {
  TerminalTools,
  TERMINAL_TOOLS_MARKUP,
} from "../../src/ssh/terminal-tools";
const root = document.querySelector<HTMLElement>(".ssh-terminal")!;
const screen = root.querySelector<HTMLElement>(".ssh-terminal-screen")!;
root
  .querySelector("footer")!
  .insertAdjacentHTML("beforeend", TERMINAL_TOOLS_MARKUP);
const writes: string[] = [],
  clipboard = { text: "", writes: [] as string[] };
(window as any).rhineDesktop = {
  clipboard: {
    writeText: async (text: string) => {
      clipboard.text = text;
      clipboard.writes.push(text);
      return { ok: true };
    },
  },
};
let usable = true;
const term = new Terminal({
  cols: 32,
  rows: 20,
  fontSize: 13,
  allowProposedApi: true,
  scrollback: 100,
});
term.open(screen);
const tools = new TerminalTools(
  root,
  { active: true, status: () => ({ phase: "interactive" }) } as any,
  {
    visible: () => usable,
    hasShell: () => true,
    fit: () => {},
    focus: () => term.focus(),
  },
);
tools.attach(term);
const controls = new MobileTerminalControls(
  root,
  screen,
  () => term,
  () => usable,
  () => {
    void tools.copy();
  },
);
term.onData((text) => writes.push(controls.input(text)));
term.write("hello 中文 /tmp/file.txt\r\nsecond line\r\n", () => {
  (window as any).ready = true;
});
(window as any).fixture = {
  term,
  writes,
  clipboard,
  controls,
  appearance: terminalAppearance,
  hide() {
    usable = false;
    controls.suspend();
  },
  show() {
    usable = true;
  },
  key229() {
    term.textarea!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Unidentified",
        keyCode: 229,
        bubbles: true,
      }),
    );
  },
  edit(
    data: string | null,
    type = "insertText",
    value = data ?? "",
    composing = false,
  ) {
    term.textarea!.value = value;
    term.textarea!.dispatchEvent(
      new InputEvent("input", {
        data,
        inputType: type,
        isComposing: composing,
        bubbles: true,
        composed: true,
      }),
    );
  },
  composition(type: string, data: string) {
    term.textarea!.dispatchEvent(
      new CompositionEvent(type, { data, bubbles: true }),
    );
  },
};
term.focus();
