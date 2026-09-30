import type { Motif } from "./theme-design";

type Rgb = readonly number[];

/**
 * The far-layer poster (Unreal SRhineThemePoster): flat graphic design in the
 * theme's motif — grids, oversized figures, colour blocks, halftone and overprint —
 * drawn behind the interface. Unreal lays it over the fogged far rows with a
 * depth-masked post-process; here it is a canvas under the atmosphere gradients.
 *
 * Layout rule kept from Unreal: the document column (right of 60% of the width)
 * is veiled in paper for legibility, so only faint texture covers the frame and
 * every solid element, figure and caption lives in the band Z between the brand
 * and the system navigation.
 */
export type PosterState = {
  motif: Motif;
  colors: { ink: Rgb; accent: Rgb; cyan: Rgb };
  /** The selected record, `H.001`. */
  code: string;
  position: number;
  count: number;
  group: string;
  time: number;
  reduced: boolean;
};

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const easeOut = (t: number) => 1 - Math.pow(1 - clamp(t), 4);
const rgba = (c: Rgb, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${clamp(a)})`;
const CHANGE_TIME = .6;

export class ThemePoster {
  private ctx: CanvasRenderingContext2D | null;
  private signature = "";
  private code = "";
  private previous = "";
  private changeStart = -10;
  private drawnAt = -10;
  private family = "";

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d");
  }

  update(state: PosterState) {
    const ctx = this.ctx;
    if (!ctx || this.canvas.offsetParent === null && getComputedStyle(this.canvas).display === "none") return;
    if (state.code !== this.code) {
      this.previous = this.code; this.code = state.code; this.changeStart = this.previous ? state.time : -10;
    }
    const change = state.reduced ? 1 : clamp((state.time - this.changeStart) / CHANGE_TIME);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr)), height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    const signature = [state.motif, state.colors.ink, state.colors.accent, state.colors.cyan, state.code, state.position, state.count, state.group, width, height].join("|");
    const orbiting = state.motif === "orbit" && !state.reduced && state.time - this.drawnAt > .25;
    if (signature === this.signature && change >= 1 && !orbiting && this.previous === "") return;
    if (change >= 1) this.previous = "";
    this.signature = signature; this.drawnAt = state.time;
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
    if (!this.family) this.family = getComputedStyle(document.body).fontFamily;
    const scale = height / 1080;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, width / scale, 1080);
    this.draw(ctx, width / scale, 1080, state, easeOut(change));
  }

  private draw(ctx: CanvasRenderingContext2D, W: number, H: number, s: PosterState, change: number) {
    const { ink, accent, cyan } = s.colors;
    const box = (x: number, y: number, w: number, h: number, c: string) => { if (w > 0 && h > 0) { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); } };
    const disc = (x: number, y: number, r: number, c: string) => { if (r > 0) { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); } };
    const rotated = (cx: number, cy: number, w: number, h: number, a: number, c: string) => {
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(a); ctx.fillStyle = c; ctx.fillRect(-w / 2, -h / 2, w, h); ctx.restore();
    };
    const setFont = (size: number, weight: number, spacing: number) => {
      ctx.font = `${weight} ${size}px ${this.family}`;
      (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${spacing}px`;
      ctx.textBaseline = "top";
    };
    const text = (value: string, x: number, y: number, size: number, weight: number, spacing: number, c: string, alignX = 0) => {
      if (!value) return;
      setFont(size, weight, spacing);
      ctx.fillStyle = c; ctx.fillText(value, x - ctx.measureText(value).width * alignX, y);
    };
    const clip = (x: number, y: number, w: number, h: number, draw: () => void) => { ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip(); draw(); ctx.restore(); };
    /** The record figure: the old one lifts out of its line, the new one rises in. */
    const figure = (x: number, y: number, size: number, weight: number, spacing: number, c: Rgb, a: number, alignX: number, lineHeight: number) => {
      clip(-W, y, 3 * W, lineHeight, () => {
        if (change < 1 && this.previous) text(this.previous, x, y - lineHeight * .7 * change, size, weight, spacing, rgba(c, a * (1 - change)), alignX);
        text(s.code, x, y + lineHeight * .7 * (1 - change), size, weight, spacing, rgba(c, a * change), alignX);
      });
    };
    const crop = (x: number, y: number, dx: number, dy: number, c: string) => { box(dx > 0 ? x : x - 26, y, 26, 1, c); box(x, dy > 0 ? y : y - 26, 1, 26, c); };
    const index = `${String(s.position).padStart(2, "0")} / ${String(s.count).padStart(2, "0")}`;
    const zx = W * .3, zw = W * .32, zy = 96;
    const clearOf = (x: number, y: number) => x > W * .6 && y > H * .18 && y < H * .9;
    const black = (a: number) => `rgba(3,3,3,${a})`;

    switch (s.motif) {
      case "shutters": { // a twelve-column page: hairline grid and crop marks; the figure and one block in Z
        const m = 60, gw = (W - 2 * m) / 12;
        for (let k = 0; k <= 12; k++) box(m + k * gw, 0, 1, H, rgba(ink, .06));
        for (let y = 90; y < H; y += 90) box(m, y, W - 2 * m, 1, rgba(ink, .03));
        const mark = rgba(ink, .35);
        crop(m, 90, 1, 1, mark); crop(W - m, 90, -1, 1, mark); crop(m, H - 90, 1, -1, mark); crop(W - m, H - 90, -1, -1, mark);
        figure(zx, zy - 10, 150, 700, -4, ink, .08, 0, 170);
        box(zx + zw - 40, zy + 8, 40, 40, rgba(accent, .55));
        text("RHINE LAB — ARCHIVE SYSTEM", zx + zw - 40, zy + 60, 11, 600, 2.4, rgba(ink, .45), 1);
        text(`${index}   ${s.group}`, zx + zw - 40, zy + 78, 11, 400, 1.6, rgba(ink, .38), 1);
        break;
      }
      case "tide": { // night shift: water lines, and the figure as an outline in Z
        for (let y = 60; y < H; y += 54) box(0, y, W, 1, rgba(ink, .04));
        clip(zx, zy - 20, zw, 250, () => {
          setFont(150, 300, 6);
          ctx.lineWidth = 2; ctx.strokeStyle = rgba(cyan, .32);
          ctx.strokeText(s.code.replace(/^[A-Z]\./, ""), zx, zy - 40 + 120 * (1 - change));
        });
        box(zx + zw - 150, zy + 12, 10, 10, rgba(cyan, .7));
        text("NIGHT SHIFT", zx + zw - 132, zy + 8, 11, 600, 3, rgba(ink, .45));
        text(index, zx + zw - 132, zy + 26, 11, 400, 2, rgba(ink, .35));
        break;
      }
      case "hazard": { // plant signage: a striped band along the top edge, the stencil figure and a notice in Z
        const band = 26;
        clip(0, 18, W, band, () => {
          box(0, 18, W, band, rgba(accent, .22));
          for (let x = -80; x < W + 80; x += 40) rotated(x, 18 + band / 2, 16, band * 2.4, Math.PI / 4, black(.5));
        });
        figure(zx, zy - 16, 170, 700, -4, accent, .13, 0, 190);
        const bx = zx + zw - 290, by = zy + 22, edge = rgba(accent, .6);
        box(bx, by, 250, 1, edge); box(bx, by + 70, 250, 1, edge); box(bx, by, 1, 71, edge); box(bx + 250, by, 1, 71, edge);
        box(bx, by, 46, 71, rgba(accent, .5));
        text("!", bx + 23, by + 10, 36, 700, 0, black(.8), .5);
        text("CAUTION / 警戒区", bx + 60, by + 14, 14, 700, 2, rgba(accent, .7));
        text(`ZONE ${index}`, bx + 60, by + 40, 11, 400, 2, rgba(ink, .45));
        break;
      }
      case "frames": { // sterile sheet: registration crosses (kept off the document column), a hairline figure in Z
        for (let y = 90; y < H; y += 90) for (let x = 60; x < W; x += 90) {
          if (clearOf(x, y)) continue;
          box(x - 5, y, 11, 1, rgba(ink, .14)); box(x, y - 5, 1, 11, rgba(ink, .14));
        }
        figure(zx, zy - 10, 150, 300, -4, ink, .08, 0, 170);
        box(zx + zw - 260, zy + 30, 18, 18, rgba(accent, .8));
        box(zx + zw - 232, zy + 39, 232, 1, rgba(cyan, .6));
        text("STERILE FIELD / CLASS A", zx + zw - 232, zy + 48, 11, 600, 2.6, rgba(ink, .5));
        text(`FILE ${s.code}   ${index}`, zx + zw - 232, zy + 66, 11, 400, 2, rgba(ink, .4));
        break;
      }
      case "orbit": { // solid Bauhaus bodies in Z: one disc with a satellite on its orbit, a bar, the figure
        const cx = zx + zw * .62, cy = zy + 70, r = 150;
        disc(cx, cy, r, rgba(accent, .22));
        ctx.lineWidth = 1.2; ctx.strokeStyle = rgba(ink, .12); ctx.beginPath(); ctx.arc(cx, cy, r + 60, 0, Math.PI * 2); ctx.stroke();
        const angle = s.time * .05 + 2.3;
        disc(cx + (r + 60) * Math.cos(angle), cy + (r + 60) * Math.sin(angle), 10, rgba(ink, .5));
        box(zx, zy - 40, 8, 280, rgba(accent, .45));
        figure(zx + 28, zy + 20, 150, 600, -4, ink, .1, 0, 170);
        text("ORBITAL TELEMETRY", zx + 28, zy - 36, 11, 600, 3, rgba(ink, .5));
        text(`${index}   ${s.group}`, zx + 28, zy - 18, 11, 400, 2, rgba(ink, .4));
        break;
      }
      case "plates": { // overprint: a halftone ramp across the top, two plates and the figure twice in Z
        for (let y = 10; y < H * .42; y += 20) for (let x = 10; x < W; x += 20) {
          const ramp = clamp((1 - y / (H * .42)) * .8 - Math.abs(x / W - .46) * .9);
          if (ramp > .05 && !clearOf(x, y)) disc(x + (Math.floor(y / 20) % 2) * 10, y, 7 * ramp, rgba(accent, .28));
        }
        disc(zx + zw * .7, zy + 90, 120, rgba(cyan, .15));
        box(zx + zw * .42, zy + 40, 200, 150, rgba(accent, .15));
        figure(zx + 8, zy + 6, 140, 700, -4, accent, .16, 0, 165);
        figure(zx, zy, 140, 700, -4, cyan, .18, 0, 165);
        const rx = zx + zw - 20, ry = zy + 12, reg = rgba(ink, .5);
        ctx.lineWidth = 1.2; ctx.strokeStyle = reg; ctx.beginPath(); ctx.arc(rx, ry, 12, 0, Math.PI * 2); ctx.stroke();
        box(rx - 20, ry, 40, 1, reg); box(rx, ry - 20, 1, 40, reg);
        text(`RISO / 2 COLOUR   ${index}`, zx, zy - 26, 11, 600, 3, rgba(ink, .45));
        break;
      }
      case "vector": { // high-energy physics: beam guidance lines, reticles, MeV energy level
        for (let y = 40; y < H; y += 45) box(0, y, W, 1, rgba(cyan, .04));
        for (let x = 60; x < W; x += 90) box(x, 0, 1, H, rgba(ink, .03));
        const cx = zx + zw * .5, cy = zy + 65;
        // Dual accelerator rings
        ctx.lineWidth = 1.2; ctx.strokeStyle = rgba(cyan, .25); ctx.beginPath(); ctx.arc(cx, cy, 80, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = 0.8; ctx.strokeStyle = rgba(accent, .35); ctx.beginPath(); ctx.arc(cx, cy, 120, 0, Math.PI * 2); ctx.stroke();
        // Crosshair reticles
        box(cx - 140, cy, 280, 1, rgba(cyan, .2));
        box(cx, cy - 140, 1, 280, rgba(cyan, .2));
        figure(zx, zy - 12, 160, 700, -4, cyan, .15, 0, 180);
        box(zx + zw - 290, zy + 15, 270, 48, rgba(ink, .04));
        box(zx + zw - 290, zy + 15, 4, 48, rgba(cyan, .8));
        text("CHERENKOV / PARTICLE ACCELERATOR", zx + zw - 278, zy + 22, 11, 600, 2.2, rgba(cyan, .8));
        text(`BEAMLINE ${index} · 7.42 TeV`, zx + zw - 278, zy + 42, 10, 400, 1.8, rgba(ink, .45));
        break;
      }
    }
  }
}
