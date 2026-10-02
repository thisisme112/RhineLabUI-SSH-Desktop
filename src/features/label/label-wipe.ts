import { glide, resolve } from "./label-kit";

/**
 * The page turn, set like a label coming off the printer (the Unreal build's
 * SRhinePageWipe, RhineLabel.h). The new page is covered at once by twelve ink
 * columns, so the change itself is never seen; across them the page's figure is
 * printed in the ground colour, resolving digit by digit, with its name on a
 * signal tab. After a hold every column is cut through the middle and the halves
 * feed apart to head and foot in hard steps, one column after another from the
 * left, signal on every cut. The archive model is the only thing let through:
 * its outline's bounding box is left open.
 *
 * One canvas over the whole viewport (the overview sheet sits above the stage),
 * drawn in stage units; it is empty and hidden while no page is turning.
 */
export type PageTurn = {
  /** The area that turns, in stage units: left, top, right, bottom. */
  area: readonly [number, number, number, number];
  figure: string;
  caption: string;
  /** Seconds: a document tab turns in about a second, whole pages take two. */
  length: number;
};

const COLUMNS = 12, FEED = 7, GUTTER = 2, EDGE = 4;

export class LabelWipe {
  readonly canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d");
  /** The figure, the tab and the note, laid out once per resolved figure and cropped into each piece. */
  private print = document.createElement("canvas");
  private printed = "";
  private turn: PageTurn | null = null;
  private start = 0;
  private colors = { ink: "#111", paper: "#eee", faint: "rgba(238,238,238,.5)", rule: "rgba(238,238,238,.14)", signal: "#2c9", onSignal: "#111" };

  constructor(viewport: HTMLElement) {
    this.canvas.className = "label-wipe";
    this.canvas.setAttribute("aria-hidden", "true");
    this.canvas.hidden = true;
    viewport.append(this.canvas);
  }

  get active() { return this.turn !== null; }

  begin(turn: PageTurn, time: number) {
    this.turn = turn;
    this.start = time;
    this.printed = "";
    // The theme's inks, read once per turn.
    const style = getComputedStyle(this.canvas);
    const rgb = (name: string, fallback: string) => style.getPropertyValue(`--theme-${name}-rgb`).trim() || fallback;
    const paper = rgb("paper", "238,238,233"), ink = rgb("ink", "17,18,16");
    this.colors = {
      ink: `rgb(${ink})`, paper: `rgb(${paper})`, faint: `rgba(${paper},.5)`, rule: `rgba(${paper},.14)`,
      signal: `rgb(${rgb("signal", "32,201,151")})`, onSignal: `rgb(${rgb("on-signal", ink)})`,
    };
    this.canvas.hidden = false;
  }

  /**
   * Draws the turn at `time`. `scale` is the stage's (window pixels per stage unit), `hole` the archive's
   * outline on the stage. Returns whether a turn is still running.
   */
  draw(time: number, scale: number, hole: readonly [number, number][]) {
    const turn = this.turn, ctx = this.ctx;
    if (!turn || !ctx) return false;
    const t = time - this.start, length = Math.max(.3, turn.length);
    if (t < 0 || t > length) {
      this.turn = null;
      this.canvas.hidden = true;
      return false;
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.round(this.canvas.clientWidth * dpr), height = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);

    const [left, top, right, bottom] = turn.area, w = right - left, h = bottom - top;
    if (w <= COLUMNS * GUTTER || h <= 0) return true;
    // A third of the time held covered, then each column takes .3 of it to part, the last finishing at the end.
    const hold = .32 * length, part = .3 * length, stagger = (length - hold - part) / (COLUMNS - 1), wide = (w - GUTTER * (COLUMNS - 1)) / COLUMNS;
    const gap = bounds(hole);
    const fill = (x0: number, y0: number, x1: number, y1: number, color: string) => {
      ctx.fillStyle = color;
      if (!gap || x1 <= gap[0] || x0 >= gap[2] || y1 <= gap[1] || y0 >= gap[3]) { ctx.fillRect(x0, y0, x1 - x0, y1 - y0); return; }
      ctx.fillRect(x0, y0, x1 - x0, gap[1] - y0);
      ctx.fillRect(x0, gap[3], x1 - x0, y1 - gap[3]);
      const a = Math.max(y0, gap[1]), b = Math.min(y1, gap[3]);
      ctx.fillRect(x0, a, gap[0] - x0, b - a);
      ctx.fillRect(gap[2], a, x1 - gap[2], b - a);
    };
    const figure = resolve(turn.figure, t / (hold * .85), t);
    this.layout(turn, figure, wide, scale * dpr);
    const k = scale * dpr;
    for (let i = 0; i < COLUMNS; i++) {
      const p = Math.min(1, Math.max(0, (t - hold - i * stagger) / part));
      // Fed out like label stock: the halves move in hard steps, not a glide.
      const fed = Math.floor(glide(p) * FEED) / FEED;
      if (fed >= 1) continue;
      const x = left + i * (wide + GUTTER), half = h * .5 * (1 - fed);
      // The ink runs over the gutter (nothing shows between columns); the column line is printed on it.
      fill(x, top, x + wide + GUTTER, top + half, this.colors.ink);
      fill(x, bottom - half, x + wide + GUTTER, bottom, this.colors.ink);
      if (i > 0) {
        fill(x - GUTTER, top, x - GUTTER + 1, top + half, this.colors.rule);
        fill(x - GUTTER, bottom - half, x - GUTTER + 1, bottom, this.colors.rule);
      }
      // What is printed across the columns, cropped into every piece that is left.
      for (const [y0, y1] of [[top, top + half], [bottom - half, bottom]]) {
        if (y1 - y0 < .5) continue;
        ctx.drawImage(this.print, (x - left) * k, (y0 - top) * k, wide * k, (y1 - y0) * k, x, y0, wide, y1 - y0);
      }
      if (half > 34) {
        ctx.fillStyle = this.colors.faint;
        ctx.font = `700 11px "JetBrains Mono", monospace`;
        ctx.letterSpacing = "1.76px";
        ctx.textBaseline = "top";
        ctx.fillText(String(i + 1).padStart(2, "0"), x + 8, top + 10);
      }
      if (fed > 0) {
        fill(x, top + half - EDGE, x + wide, top + half, this.colors.signal);
        fill(x, bottom - half, x + wide, bottom - half + EDGE, this.colors.signal);
      }
    }
    return true;
  }

  /** The print layer: the figure, its name on a signal tab and the note, at the area's size in device pixels. */
  private layout(turn: PageTurn, figure: string, wide: number, k: number) {
    const key = `${figure}|${turn.caption}|${k}|${turn.area.join(",")}|${this.colors.paper}`;
    if (key === this.printed) return;
    this.printed = key;
    const [left, top, right, bottom] = turn.area, w = right - left, h = bottom - top;
    const canvas = this.print, ctx = canvas.getContext("2d")!;
    canvas.width = Math.max(1, Math.round(w * k));
    canvas.height = Math.max(1, Math.round(h * k));
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // The figure stands on its capitals, centred at 46% of the area (Barlow's capitals are .7 of the size).
    const cap = Math.min(h * .34, w * .26), px = cap / .7, cy = h * .46, x = wide * .5;
    ctx.fillStyle = this.colors.paper;
    ctx.font = `700 ${px}px "Barlow Condensed", "MiSans", sans-serif`;
    ctx.letterSpacing = "0px";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(figure, x, cy + cap * .5);
    if (turn.caption) {
      ctx.font = `700 15px "MiSans", "Microsoft YaHei", sans-serif`;
      ctx.letterSpacing = ".8px";
      ctx.textBaseline = "top";
      const text = ctx.measureText(turn.caption).width, ty = cy + cap * .5 + 22;
      ctx.fillStyle = this.colors.signal;
      ctx.fillRect(x, ty, text + 28, 34);
      ctx.fillStyle = this.colors.onSignal;
      ctx.fillText(turn.caption, x + 14, ty + 8);
    }
    ctx.fillStyle = this.colors.faint;
    ctx.font = `700 11px "JetBrains Mono", monospace`;
    ctx.letterSpacing = "1.76px";
    ctx.textBaseline = "top";
    ctx.fillText("RHINE LAB — LABEL SYSTEM / PAGE TURN", x, h - 34);
  }
}

/** The bounding box of an outline, or nothing. */
function bounds(points: readonly [number, number][]): [number, number, number, number] | null {
  if (points.length < 3) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
}
