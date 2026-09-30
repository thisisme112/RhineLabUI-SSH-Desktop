import type { Terminal } from "@xterm/xterm";

type CellPoint = { col: number; row: number };

/** Touch selection uses xterm cells, including wide characters and scrollback. */
export class AndroidTerminalSelection {
  private events = new AbortController();
  private timer?: number;
  private start?: { x: number; y: number; term: Terminal };
  private anchor?: { start: number; end: number };
  private actions: HTMLElement;
  private selecting = false;
  constructor(
    private root: HTMLElement,
    private screen: HTMLElement,
    private terminal: () => Terminal,
    private usable: () => boolean,
    copy: () => void,
  ) {
    this.actions = document.createElement("div");
    this.actions.className = "ssh-mobile-selection";
    this.actions.hidden = true;
    this.actions.setAttribute("role", "toolbar");
    this.actions.setAttribute("aria-label", "终端文字选择");
    this.actions.innerHTML =
      '<span>拖动扩选</span><button type="button" data-selection="copy">复制选中</button><button type="button" data-selection="all">全选</button><button type="button" data-selection="cancel">取消</button>';
    root.querySelector(".ssh-terminal-foot")!.prepend(this.actions);
    const options = { signal: this.events.signal, capture: true };
    this.actions.addEventListener(
      "pointerdown",
      (event) => event.preventDefault(),
      options,
    );
    this.actions.addEventListener(
      "click",
      (event) => {
        const action = (event.target as Element).closest<HTMLElement>(
          "[data-selection]",
        )?.dataset.selection;
        if (!this.usable()) {
          this.reset();
          return;
        }
        if (action === "copy") copy();
        if (action === "all") this.terminal().selectAll();
        if (action === "cancel") this.reset();
      },
      options,
    );
    screen.addEventListener(
      "touchstart",
      (event) => {
        window.clearTimeout(this.timer);
        this.selecting = false;
        this.start = undefined;
        if (event.touches.length !== 1 || !this.usable()) return;
        const point = event.touches[0];
        this.start = {
          x: point.clientX,
          y: point.clientY,
          term: this.terminal(),
        };
        this.timer = window.setTimeout(() => {
          const start = this.start;
          if (!start || !this.usable() || start.term !== this.terminal())
            return;
          const cell = this.cell(start.x, start.y);
          if (!cell) return;
          this.selecting = true;
          this.word(cell);
          this.actions.hidden = false;
        }, 500);
      },
      { ...options, passive: true },
    );
    screen.addEventListener(
      "touchmove",
      (event) => {
        if (!this.start) return;
        if (
          event.touches.length !== 1 ||
          !this.usable() ||
          this.start.term !== this.terminal()
        ) {
          this.reset();
          return;
        }
        const point = event.touches[0];
        if (!this.selecting) {
          if (
            Math.hypot(
              point.clientX - this.start.x,
              point.clientY - this.start.y,
            ) > 10
          ) {
            window.clearTimeout(this.timer);
            this.start = undefined;
          }
          return;
        }
        this.last = { x: point.clientX, y: point.clientY };
        this.extend();
        this.edgeScroll();
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      { ...options, passive: false },
    );
    screen.addEventListener(
      "touchend",
      (event) => {
        window.clearTimeout(this.timer);
        this.stopEdge();
        this.start = undefined;
        if (this.selecting) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        this.selecting = false;
      },
      { ...options, passive: false },
    );
    screen.addEventListener("touchcancel", () => this.reset(), options);
    screen.addEventListener(
      "contextmenu",
      (event) => {
        // Android may dispatch this before touchend for the same long press.
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      options,
    );
  }
  private last?: { x: number; y: number };
  private edge = 0;
  /** Grow the selection from its word to the cell under the finger. */
  private extend() {
    if (!this.last || !this.anchor) return;
    const cell = this.cell(this.last.x, this.last.y);
    if (!cell) return;
    const term = this.terminal(),
      end = cell.row * term.cols + cell.col;
    const first = Math.min(this.anchor.start, end),
      last = Math.max(this.anchor.end, end + this.width(cell));
    term.select(first % term.cols, Math.floor(first / term.cols), last - first);
  }
  /**
   * A finger held near the top or bottom edge of the screen keeps scrolling the
   * scrollback under it (about 16 lines a second) and the selection follows.
   */
  private edgeScroll() {
    const bounds = this.screen.querySelector(".xterm-screen")?.getBoundingClientRect();
    const direction = !bounds || !this.last ? 0 : this.last.y < bounds.top + 28 ? -1 : this.last.y > bounds.bottom - 28 ? 1 : 0;
    if (!direction) { this.stopEdge(); return; }
    if (this.edge) return;
    this.edge = window.setInterval(() => {
      const at = this.screen.querySelector(".xterm-screen")?.getBoundingClientRect();
      if (!this.selecting || !this.last || !at || !this.usable()) { this.stopEdge(); return; }
      const toward = this.last.y < at.top + 28 ? -1 : this.last.y > at.bottom - 28 ? 1 : 0;
      if (!toward) { this.stopEdge(); return; }
      this.terminal().scrollLines(toward);
      this.extend();
    }, 60);
  }
  private stopEdge() { window.clearInterval(this.edge); this.edge = 0; }
  private cell(x: number, y: number): CellPoint | undefined {
    const term = this.terminal(),
      bounds = this.screen
        .querySelector(".xterm-screen")
        ?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return;
    let col = Math.max(
      0,
      Math.min(
        term.cols - 1,
        Math.floor(((x - bounds.left) / bounds.width) * term.cols),
      ),
    );
    const row =
      term.buffer.active.viewportY +
      Math.max(
        0,
        Math.min(
          term.rows - 1,
          Math.floor(((y - bounds.top) / bounds.height) * term.rows),
        ),
      );
    if (term.buffer.active.getLine(row)?.getCell(col)?.getWidth() === 0)
      col = Math.max(0, col - 1);
    return { col, row };
  }
  private width(point: CellPoint) {
    return (
      this.terminal()
        .buffer.active.getLine(point.row)
        ?.getCell(point.col)
        ?.getWidth() || 1
    );
  }
  private word(point: CellPoint) {
    const term = this.terminal(),
      line = term.buffer.active.getLine(point.row);
    let left = point.col,
      right = point.col + this.width(point);
    const word = (col: number) =>
      /[\p{L}\p{N}_./:@~+-]/u.test(line?.getCell(col)?.getChars() || " ");
    if (word(point.col)) {
      while (left > 0) {
        const previous =
          left - (line?.getCell(left - 1)?.getWidth() === 0 ? 2 : 1);
        if (previous < 0 || !word(previous)) break;
        left = previous;
      }
      while (right < term.cols && word(right))
        right += line?.getCell(right)?.getWidth() || 1;
    }
    this.anchor = {
      start: point.row * term.cols + left,
      end: point.row * term.cols + right,
    };
    term.select(left, point.row, right - left);
  }
  reset() {
    window.clearTimeout(this.timer);
    this.stopEdge();
    this.timer = undefined;
    this.start = undefined;
    this.selecting = false;
    this.anchor = undefined;
    this.actions.hidden = true;
    this.terminal().clearSelection();
  }
  dispose() {
    this.reset();
    this.events.abort();
    this.actions.remove();
  }
}
