import type { Terminal } from "@xterm/xterm";

/**
 * The completion in the terminal (the Unreal build's ClaudeSuggestion and MakeClaudeStrip): the suggested rest of the
 * line drawn in grey after the cursor, and a slip at the foot of the screen saying how to take it, or why there is
 * none. In any theme. Laid over the screen, never in it: nothing is typed until the reader takes it.
 */
export class TerminalGhost {
  private ghost = document.createElement("span");
  private strip = document.createElement("span");
  private shownGhost = "";
  private shownStrip = "";
  private place = "";

  constructor(private host: HTMLElement) {
    this.ghost.className = "maid-ghost";
    this.strip.className = "maid-strip";
    this.ghost.hidden = this.strip.hidden = true;
    this.ghost.setAttribute("aria-hidden", "true");
    this.strip.setAttribute("role", "status");
    host.append(this.ghost, this.strip);
  }

  /** This frame's suggestion and note, for a terminal (none: both go). */
  update(term: Terminal | null, suggestion: string, note: string) {
    if (note !== this.shownStrip) { this.shownStrip = note; this.strip.textContent = note; this.strip.hidden = !note; }
    const buffer = term?.buffer.active;
    // Only at the live screen's cursor (not scrolled back), on the normal screen.
    const text = term && buffer && buffer.type === "normal" && buffer.viewportY === buffer.baseY ? suggestion : "";
    if (!text || !term) { if (this.shownGhost) { this.shownGhost = ""; this.ghost.hidden = true; } return; }
    const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
    if (!screen || !term.cols || !term.rows) return;
    const at = screen.getBoundingClientRect(), base = this.host.getBoundingClientRect();
    const cell = at.width / term.cols, row = at.height / term.rows;
    const place = `${(at.left - base.left + buffer!.cursorX * cell).toFixed(1)},${(at.top - base.top + buffer!.cursorY * row).toFixed(1)},${row.toFixed(2)},${term.options.fontSize}`;
    if (place !== this.place) {
      this.place = place;
      this.ghost.style.left = `${at.left - base.left + buffer!.cursorX * cell}px`;
      this.ghost.style.top = `${at.top - base.top + buffer!.cursorY * row}px`;
      this.ghost.style.height = this.ghost.style.lineHeight = `${row}px`;
      this.ghost.style.fontFamily = String(term.options.fontFamily ?? "monospace");
      this.ghost.style.fontSize = `${term.options.fontSize ?? 13}px`;
      this.ghost.style.letterSpacing = `${term.options.letterSpacing ?? 0}px`;
    }
    if (text !== this.shownGhost) { this.shownGhost = text; this.ghost.textContent = text; }
    this.ghost.hidden = false;
  }
}
