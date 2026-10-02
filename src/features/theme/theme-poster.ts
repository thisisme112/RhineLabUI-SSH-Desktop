import { sigil } from "../../shared/sigil";
import { TRANSIT_LINES, type Motif } from "./theme-design";

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
  /** `signal` is the label design's one flat colour (RhineChrome.h LabelSignal). */
  colors: { ink: Rgb; accent: Rgb; cyan: Rgb; paper: Rgb; signal: Rgb };
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
const LINES: Rgb[] = TRANSIT_LINES.map(hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)));
const CHANGE_TIME = .6;
/**
 * The label design's figures (Unreal RhineFont::Display, Barlow Condensed 800), which
 * features/label/label.css ships; a condensed system face stands in until it loads.
 */
const DISPLAY = `"Barlow Condensed", Bahnschrift, "Arial Narrow", "Roboto Condensed", sans-serif-condensed, sans-serif`;
/** Its small figures and notes (RhineFont::Terminal): the terminal's JetBrains Mono, else the system mono. */
const MONO = `"JetBrains Mono", "Cascadia Mono", Consolas, monospace`;

export class ThemePoster {
  private ctx: CanvasRenderingContext2D | null;
  private signature = "";
  private code = "";
  private previous = "";
  private changeStart = -10;
  private drawnAt = -10;
  private family = "";
  /** The canvas's CSS size, kept by a ResizeObserver: reading it off the element each frame forced a layout. */
  private cssWidth = 0;
  private cssHeight = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d");
    new ResizeObserver(([entry]) => {
      this.cssWidth = Math.round(entry.contentRect.width);
      this.cssHeight = Math.round(entry.contentRect.height);
    }).observe(canvas);
    // A canvas keeps the fallback face a draw fell back to: a face that loads later
    // (a MiSans subset, the mono or display face) draws the poster again.
    document.fonts.addEventListener("loadingdone", () => { this.signature = ""; });
  }

  update(state: PosterState) {
    const ctx = this.ctx;
    // Not laid out yet, or not rendered at all (an observed 0 × 0).
    if (!ctx || !this.cssWidth || !this.cssHeight) return;
    if (state.code !== this.code) {
      this.previous = this.code; this.code = state.code; this.changeStart = this.previous ? state.time : -10;
    }
    const change = state.reduced ? 1 : clamp((state.time - this.changeStart) / CHANGE_TIME);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(this.cssWidth * dpr)), height = Math.max(1, Math.round(this.cssHeight * dpr));
    const { ink, accent, cyan, paper, signal } = state.colors;
    const signature = [state.motif, ink, accent, cyan, paper, signal, state.code, state.position, state.count, state.group, width, height].join("|");
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
    const { ink, accent, cyan, paper, signal } = s.colors;
    const box = (x: number, y: number, w: number, h: number, c: string) => { if (w > 0 && h > 0) { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); } };
    const disc = (x: number, y: number, r: number, c: string) => { if (r > 0) { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); } };
    /** A circle's outline `width` thick, inside its radius as Slate draws a rounded box's. */
    const ring = (x: number, y: number, r: number, width: number, c: string) => {
      if (r <= 0) return;
      ctx.lineWidth = width; ctx.strokeStyle = c;
      ctx.beginPath(); ctx.arc(x, y, Math.max(0, r - width / 2), 0, Math.PI * 2); ctx.stroke();
    };
    const rotated = (cx: number, cy: number, w: number, h: number, a: number, c: string) => {
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(a); ctx.fillStyle = c; ctx.fillRect(-w / 2, -h / 2, w, h); ctx.restore();
    };
    const setFont = (size: number, weight: number, spacing: number, face = this.family) => {
      ctx.font = `${weight} ${size}px ${face}`;
      ctx.fontStretch = face === DISPLAY ? "condensed" : "normal";
      ctx.letterSpacing = `${spacing}px`;
      ctx.textBaseline = "top";
    };
    const text = (value: string, x: number, y: number, size: number, weight: number, spacing: number, c: string, alignX = 0, face?: string) => {
      if (!value) return;
      setFont(size, weight, spacing, face);
      ctx.fillStyle = c; ctx.fillText(value, x - ctx.measureText(value).width * alignX, y);
    };
    const clip = (x: number, y: number, w: number, h: number, draw: () => void) => { ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip(); draw(); ctx.restore(); };
    /** The record figure: the old one lifts out of its line, the new one rises in. */
    const figure = (x: number, y: number, size: number, weight: number, spacing: number, c: Rgb, a: number, alignX: number, lineHeight: number, face?: string) => {
      clip(-W, y, 3 * W, lineHeight, () => {
        if (change < 1 && this.previous) text(this.previous, x, y - lineHeight * .7 * change, size, weight, spacing, rgba(c, a * (1 - change)), alignX, face);
        text(s.code, x, y + lineHeight * .7 * (1 - change), size, weight, spacing, rgba(c, a * change), alignX, face);
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
        ring(cx, cy, r + 60, 1.2, rgba(ink, .12));
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
        ring(rx, ry, 12, 1.2, reg);
        box(rx - 20, ry, 40, 1, reg); box(rx, ry - 20, 1, 40, reg);
        text(`RISO / 2 COLOUR   ${index}`, zx, zy - 26, 11, 600, 3, rgba(ink, .45));
        break;
      }
      case "transit": { // a route map behind everything, kept off the document column; in Z the figure, a line badge and the column as a strip of stations
        // Each route: its height as a share of the sheet, then two 45° bends as (x share, drop).
        const routes = [[.14, .18, 90, .50, -70], [.34, .30, -110, .72, 60], [.58, .10, 70, .42, 100], [.80, .24, -90, .66, -50], [.95, .36, -60, .84, 0]] as const;
        // Three windows that together leave out the document column.
        for (const [wx, wy, ww, wh] of [[0, 0, W * .6, H], [W * .6, 0, W * .4, H * .18], [W * .6, H * .9, W * .4, H * .1]]) clip(wx, wy, ww, wh, () => {
          ctx.lineWidth = 24; ctx.lineJoin = "miter";
          routes.forEach(([share, x1, dy1, x2, dy2], r) => {
            const y0 = share * H, y1 = y0 + dy1, y2 = y1 + dy2;
            ctx.strokeStyle = rgba(LINES[r], .14);
            ctx.beginPath();
            ctx.moveTo(-40, y0); ctx.lineTo(W * x1, y0); ctx.lineTo(W * x1 + Math.abs(dy1), y1);
            ctx.lineTo(W * x2, y1); ctx.lineTo(W * x2 + Math.abs(dy2), y2); ctx.lineTo(W + 40, y2);
            ctx.stroke();
          });
        });
        for (const [share, x1, dy1, x2] of routes) for (const [x, y] of [[W * x1, share * H], [W * x2, share * H + dy1]]) {
          if (clearOf(x, y)) continue;
          disc(x, y, 12, rgba(paper, .7));
          ring(x, y, 12, 4, rgba(ink, .26));
        }
        figure(zx, zy - 10, 150, 700, -4, ink, .07, 0, 170);
        const bx = zx + zw - 196;
        disc(bx - 34, zy + 34, 27, rgba(cyan, .92));
        text(String(s.position).padStart(2, "0"), bx - 34, zy + 20, 24, 700, 0, "rgba(255,255,255,.95)", .5);
        box(bx, zy + 28, 196, 12, rgba(accent, .85));
        text(`TRANSIT / LINE ${index}`, bx, zy + 48, 11, 600, 2.4, rgba(ink, .5));
        text(s.group, bx, zy + 66, 11, 400, 1.6, rgba(ink, .4));
        const sy = zy + 214, stops = Math.min(14, Math.max(2, s.count));
        const here = s.count > 1 ? Math.round((s.position - 1) * (stops - 1) / (s.count - 1)) : 0;
        box(zx, sy - 5, zw, 10, rgba(cyan, .55));
        for (let i = 0; i < stops; i++) {
          const x = zx + zw * i / (stops - 1);
          if (i === here) { disc(x, sy, 17, rgba(paper, 1)); ring(x, sy, 17, 6, rgba(ink, .85)); disc(x, sy, 6, rgba(accent, 1)); }
          else { disc(x, sy, 9, rgba(paper, 1)); ring(x, sy, 9, 3.5, rgba(ink, .55)); }
        }
        break;
      }
      case "darkroom": { // a roll's edges across the sheet, faint; in Z a contact sheet with the selected record's frame ringed in grease pencil
        for (let x = 20; x < W; x += 34) { box(x, 14, 14, 20, rgba(ink, .09)); box(x, H - 34, 14, 20, rgba(ink, .09)); }
        for (let x = 40, code = 0; x < W; x += 170, code++) text(`${(code >> 1) + 1}${code % 2 ? "A" : ""}`, x, 40, 10, 600, 1.6, rgba(cyan, .3));
        const fw = 114, fh = 76, gap = 10, rows = 102, sx = zx, sy = zy + 20;
        const selected = Math.max(0, s.position - 1) % 8;
        for (let i = 0; i < 8; i++) {
          const x = sx + (i % 4) * (fw + gap), y = sy + (i >> 2) * rows;
          // Frames are not pictures of anything: a tone, a ground and a lamp, differing frame to frame.
          const hash = Math.imul(i + 1, 2654435761) >>> 0;
          const r1 = hash % 100 / 100, r2 = (hash >>> 8) % 100 / 100;
          box(x, y, fw, fh, rgba(ink, .05 + .09 * r1));
          box(x, y + fh * (.55 + .2 * r2), fw, fh * (.45 - .2 * r2), rgba(ink, .08));
          disc(x + fw * (.25 + .5 * r2), y + fh * (.3 + .2 * r1), 8 + 10 * r1, rgba(ink, .14 + .1 * r2));
          text(`${(i >> 1) + 1}${i % 2 ? "A" : ""}`, x, y + fh + 5, 10, 600, 1.4, rgba(cyan, .7));
        }
        const cx = sx + (selected % 4) * (fw + gap) + fw / 2, cy = sy + (selected >> 2) * rows + fh / 2;
        ring(cx, cy, 70, 3.2, rgba(accent, .85));
        ring(cx + 4, cy - 3, 73, 1.6, rgba(accent, .5));
        text(`CONTACT SHEET   ${index}`, sx, zy - 16, 11, 600, 2.6, rgba(ink, .5));
        text(`FRAME ${s.code}   ${s.group}`, sx, zy + 2, 11, 400, 1.6, rgba(ink, .4));
        break;
      }
      case "label": { // a reagent label: zone rulers along the top (01–12) and down the left (A–F); in Z the figure slit by a strip of stock, the signal block with the lot, and the record's 5 × 5 mark
        const col = W / 12;
        box(0, 46, W, 2, rgba(ink, .14));
        for (let k = 0; k < 12; k++) {
          box(k * col, 38, 1, 18, rgba(ink, .16));
          text(String(k + 1).padStart(2, "0"), k * col + 8, 20, 11, 700, 0, rgba(ink, .24), 0, MONO);
        }
        for (let k = 0; k < 6; k++) {
          const y = 90 + k * (H - 120) / 6;
          box(18, y, 16, 1, rgba(ink, .16));
          text(String.fromCharCode(65 + k), 20, y + 6, 11, 700, 0, rgba(ink, .24), 0, MONO);
        }
        figure(zx, zy - 14, 200, 800, 0, ink, .1, 0, 200, DISPLAY);
        box(zx, zy + 88, zw * .78, 7, rgba(paper, .9));
        const bx = zx + zw - 150, by = zy + 6;
        box(bx, by, 150, 62, rgba(signal, .9));
        text("REAGENT", bx + 12, by + 8, 24, 700, 1.5, rgba(ink, .85), 0, DISPLAY);
        text(`LOT ${index}`, bx + 12, by + 38, 11, 700, 0, rgba(ink, .7), 0, MONO);
        const bits = sigil(s.code), cell = 11, mx = bx + 150 - 5 * cell, my = by + 80;
        for (let k = 0; k < 25; k++) if (bits & (1 << k)) box(mx + (k % 5) * cell, my + Math.floor(k / 5) * cell, cell - 1, cell - 1, rgba(ink, .55));
        text(s.group, bx, my + 5 * cell + 10, 11, 400, 1.6, rgba(ink, .4));
        break;
      }
      case "rack": { // frost ticks across the sheet; in Z a 96-well plate with the selected record's well lit and its column half lit, the figure behind, the store's temperature above
        for (let y = 70; y < H; y += 70) for (let x = 50; x < W; x += 140) if (!clearOf(x, y)) box(x + (Math.floor(y / 70) % 2) * 70, y, 12, 1, rgba(ink, .07));
        figure(zx, zy - 20, 200, 800, 0, ink, .07, 0, 200, DISPLAY);
        const pitch = 24, px = zx + zw - 12 * pitch, py = zy + 24;
        const selected = Math.max(0, s.position - 1) % 96, column = Math.floor(selected / 8), row = selected % 8;
        for (let x = 0; x < 12; x++) {
          const cx = px + x * pitch + pitch / 2;
          text(String(x + 1), cx, py - 20, 9, 700, 0, rgba(ink, .3), .5, MONO);
          for (let y = 0; y < 8; y++) {
            const cy = py + y * pitch + pitch / 2;
            if (x === column && y === row) disc(cx, cy, pitch * .42, rgba(signal, .95));
            else if (x === column) disc(cx, cy, pitch * .3, rgba(signal, .28));
            ring(cx, cy, pitch * .38, 1.2, rgba(ink, .22));
          }
        }
        for (let y = 0; y < 8; y++) text(String.fromCharCode(65 + y), px - 14, py + y * pitch + 5, 9, 700, 0, rgba(ink, .3), 0, MONO);
        text("CRYO STOCK  −80 °C", zx, zy - 30, 11, 700, 11 * .16, rgba(signal, .7), 0, MONO);
        text(`WELL ${String.fromCharCode(65 + row)}${column + 1}   ${index}   ${s.group}`, zx, zy - 12, 11, 400, 1.6, rgba(ink, .4));
        break;
      }
    }
  }
}
