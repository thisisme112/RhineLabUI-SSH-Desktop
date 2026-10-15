/**
 * A canvas laid out in the units of what it sits in (stage units on the label sheet, CSS pixels elsewhere), its
 * pixels at `k` device pixels a unit so it stays sharp under the stage's scale. It is sized only when its size
 * changes; begin() clears it and leaves its units as the drawing's.
 */
export class StageCanvas {
  readonly el = document.createElement("canvas");
  readonly ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private k = 0;
  private blank = true;

  constructor(className: string) {
    this.el.className = className;
    this.el.setAttribute("aria-hidden", "true");
    this.ctx = this.el.getContext("2d")!;
  }

  /** Clears it at w × h units, `k` device pixels each (two and a half at most: past that nobody sees the difference). */
  begin(w: number, h: number, k: number) {
    k = Math.min(2.5, Math.max(.5, k));
    const pw = Math.max(1, Math.round(w * k)), ph = Math.max(1, Math.round(h * k));
    if (w !== this.w || h !== this.h || Math.abs(k - this.k) > .01) {
      this.w = w; this.h = h; this.k = k;
      this.el.width = pw; this.el.height = ph;
      this.el.style.width = `${w}px`;
      this.el.style.height = `${h}px`;
    } else if (!this.blank) {
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.clearRect(0, 0, pw, ph);
    }
    this.ctx.setTransform(pw / w, 0, 0, ph / h, 0, 0);
    this.ctx.globalAlpha = 1;
    this.blank = false;
    return this.ctx;
  }

  /** Clears it once (nothing to draw any more). */
  clear() {
    if (this.blank) return;
    this.blank = true;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.el.width, this.el.height);
  }
}
