import { getPlatformBridge } from "../../platform/bridge.ts";
import { TRANSIT_LINES, type Motif } from "./theme-design";
import { preloadMaid } from "../maid/maid-art";
import { drawMaidReveal, drawWhaleReveal, MAID_REVEAL, MAID_STEP, WHALE_REVEAL, WHALE_STEP } from "../maid/maid-reveal";

/**
 * The theme change-over (the Unreal build's RhineThemeReveal.h): the window as
 * it was is captured, laid over the page, the new palette is applied under it,
 * and the old picture leaves in pieces, each motif in its own manner. Every
 * piece crops the capture where it stands, so the picture never moves; only the
 * windows onto it close.
 *
 *   shutters  twelve columns close left to right, each wiped from its left edge
 *   tide      ten bands go down from the bottom up, a waterline at each edge
 *   hazard    72 px blocks in diagonal bands, alternate stripes first
 *   frames    forty strips run off the wall from the top at uneven speeds, a red run at each edge, after two stutters of the light
 *   orbit     squares close outward from the origin (the selected card), in rings
 *   plates    a 30 px halftone that drops out in scattered order over a second plate
 *   transit   eight bands leave from alternating ends, a station and a train of one line's colour at each edge
 *   darkroom  contact-sheet frames a hairline apart, each shuttered top to bottom behind a signal edge
 *   label     twelve columns cut through the middle, the halves parting to head and foot from the left
 *   rack      a 96-well plate drawn up column by column
 *   spark     claude, kept sweet: the old frame glitches, then breaks up in squares from the middle out, a spark or a
 *             heart rising from each; a blueprint grid and a scan line pass over the new theme while her hologram is
 *             built on its projector, comes solid and waves, then she steps out to the right through a doorway of light
 *             as her small self steps in at her place (3.35 s)
 *   bubbles   deepseek: the sea comes up over the old frame and drains off the new theme, bubbles going up through
 *             it; a whale's shadow swims across behind; she swims in, lands in a splash and waves, then walks out to
 *             the right through a column of bubbles as her small self walks in (3.75 s)
 *
 * Without a capture (the web and Android builds, reduced motion) the interface
 * and the room fade into the new theme over .45 s instead (Unreal StartThemeBlend);
 * a maid still makes her entrance over it, with nothing of the old frame (not under reduced motion).
 */
export type RevealOptions = {
  motif: Motif;
  /** Applies the new theme: once the capture covers the page (`covered`), or at once without one. */
  apply: (covered: boolean) => void;
  /** Edge lines and the plates' second colour, as CSS colours. */
  accent: string;
  second: string;
  /** Where orbit's rings start, 0..1 of the viewport. */
  origin?: readonly [number, number];
  reduced: boolean;
  /**
   * A maid's change-over: when (performance.now()) she sets off walking out of the middle, so her small self can walk
   * in at her place on the same clock (features/maid). Told once the change-over has begun.
   */
  walkAt?: (at: number) => void;
};

const DURATION = 1000;
/** A maid's change-over runs until she has walked out (features/maid/maid-reveal.ts); the others take a second. */
const durationOf = (motif: Motif) => (motif === "spark" ? MAID_REVEAL : motif === "bubbles" ? WHALE_REVEAL : 1) * 1000;
let running: Promise<void> | undefined;

export async function playThemeReveal(options: RevealOptions): Promise<void> {
  if (running) await running;
  running = run(options).finally(() => { running = undefined; });
  return running;
}

async function run(o: RevealOptions) {
  const capture = getPlatformBridge()?.capture;
  const maid = o.motif === "spark" ? "claude" : o.motif === "bubbles" ? "deepseek" : undefined;
  // Her pictures decoded before the show starts (most are in already: they are asked for when her theme is chosen).
  if (maid && !o.reduced) await Promise.race([preloadMaid(maid), new Promise(r => setTimeout(r, 900))]);
  let image: ImageBitmap | undefined;
  if (!o.reduced && capture) {
    try {
      const bytes = await capture();
      if (bytes) image = await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/jpeg" }));
    } catch { image = undefined; }
  }
  if (!image && (!maid || o.reduced)) { o.apply(false); return; }

  const dpr = window.devicePixelRatio || 1;
  const width = innerWidth, height = innerHeight;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  canvas.className = "theme-reveal";
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, { position: "fixed", inset: "0", width: `${width}px`, height: `${height}px`, zIndex: "2147483000", pointerEvents: "none" });
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  // The capture is the page at device pixels: local (CSS px) → image px.
  const kx = image ? image.width / width : 1, ky = image ? image.height / height : 1;
  /** A window onto the capture where it stands (drawn `dx` to the side for a slipping band). */
  const piece = (x0: number, y0: number, x1: number, y1: number, dx = 0) => {
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(width, x1); y1 = Math.min(height, y1);
    if (!image || x1 - x0 < .5 || y1 - y0 < .5) return;
    ctx.drawImage(image, x0 * kx, y0 * ky, (x1 - x0) * kx, (y1 - y0) * ky, x0 + dx, y0, x1 - x0, y1 - y0);
  };
  const inOut = (x: number) => { x = Math.min(1, Math.max(0, x)); return x < .5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2; };
  const cubicIn = (x: number) => { x = Math.min(1, Math.max(0, x)); return x * x * x; };
  const origin = [(o.origin?.[0] ?? .5) * width, (o.origin?.[1] ?? .5) * height];

  // Squares closing on their centres, in the order `delay` gives.
  const squares = (size: number, delay: (x: number, y: number, cx: number, cy: number) => number, each: number, t: number, plate: boolean) => {
    const nx = Math.ceil(width / size), ny = Math.ceil(height / size);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const cx = (x + .5) * size, cy = (y + .5) * size;
      const e = cubicIn((t - delay(x, y, cx, cy)) / each);
      if (e >= 1) continue;
      // Whole pieces overlap by half a pixel, or the grid shows as seams.
      const half = size * .5 * (1 - e) + (e <= 0 ? .5 : 0);
      if (plate && e > 0) {
        ctx.fillStyle = o.second; ctx.globalAlpha = .32 * (1 - e);
        ctx.fillRect(cx - half + 4, cy - half + 4, half * 2, half * 2);
        ctx.globalAlpha = 1;
      }
      piece(cx - half, cy - half, cx + half, cy + half);
    }
  };

  const draw = (t: number) => {
    ctx.clearRect(0, 0, width, height);
    switch (o.motif) {
      case "shutters": {
        const n = 12, w = width / n;
        for (let i = 0; i < n; i++) {
          const e = inOut((t - i * .045) / .42);
          if (e >= 1) continue;
          const edge = i * w + w * e;
          piece(edge, 0, (i + 1) * w + .5, height);
          if (e > 0) { ctx.fillStyle = o.accent; ctx.fillRect(edge, 0, 2, height); }
        }
        break;
      }
      case "tide": {
        const n = 10, h = height / n;
        for (let i = 0; i < n; i++) {
          const e = inOut((t - (n - 1 - i) * .05) / .45);
          if (e >= 1) continue;
          const bottom = (i + 1) * h - h * e;
          piece(0, i * h - .5, width, bottom);
          if (e > 0) { ctx.fillStyle = o.accent; ctx.globalAlpha = 1 - e * .5; ctx.fillRect(0, bottom - 2, width, 2); ctx.globalAlpha = 1; }
        }
        break;
      }
      case "hazard":
        squares(72, (x, y) => (x + y) * .018 + ((x + y) % 2) * .09, .3, t, false);
        break;
      case "frames": {
        // The old picture runs off the wall: narrow strips let go from the top at uneven moments and
        // speeds, a red run at each falling edge; the tube overhead stutters twice as it starts.
        const n = 40, w = width / n;
        const hash = (i: number, k: number) => (((Math.imul(i + 1, 73856093) ^ Math.imul(k, 19349663)) >>> 0) % 1000) / 1000;
        for (let i = 0; i < n; i++) {
          const e = cubicIn((t - .1 - hash(i, 1) * .34) / (.3 + hash(i, 2) * .24));
          if (e >= 1) continue;
          const edge = height * e;
          piece(i * w, edge, (i + 1) * w + .5, height);
          if (e <= 0) continue;
          const run = 26 + hash(i, 3) * 120;
          ctx.fillStyle = o.accent;
          ctx.fillRect(i * w, edge - 2, w + .5, 3);
          ctx.fillRect((i + .5) * w - 1.5, Math.max(0, edge - run), 3, Math.min(edge, run));
        }
        if (t < .03 || (t > .06 && t < .085)) { ctx.fillStyle = "#fff"; ctx.globalAlpha = .4; ctx.fillRect(0, 0, width, height); ctx.globalAlpha = 1; }
        break;
      }
      case "orbit": {
        const [ox, oy] = origin;
        const reach = Math.max(Math.hypot(ox, oy), Math.hypot(width - ox, oy), Math.hypot(ox, height - oy), Math.hypot(width - ox, height - oy));
        // Rings: the distance is quantised, so whole rings close together.
        squares(56, (_x, _y, cx, cy) => Math.floor(Math.hypot(cx - ox, cy - oy) / reach * 9) / 9 * .56, .32, t, false);
        break;
      }
      case "transit": {
        const n = 8, h = height / n;
        for (let i = 0; i < n; i++) {
          const right = i % 2 === 0; // even bands leave to the right, odd to the left
          const e = inOut((t - i * .04) / .42);
          if (e >= 1) continue;
          const edge = right ? width * e : width * (1 - e);
          if (right) piece(edge, i * h - .5, width, (i + 1) * h); else piece(0, i * h - .5, edge, (i + 1) * h);
          if (e <= 0) continue;
          // The closing edge is a station; a train of one line's colour trails it over the new frame.
          const train = Math.min(width * .3, 260), yc = (i + .5) * h;
          const back = right ? Math.max(0, edge - train) : edge;
          const length = right ? edge - back : Math.min(width, edge + train) - edge;
          ctx.fillStyle = TRANSIT_LINES[i % TRANSIT_LINES.length]; ctx.globalAlpha = 1 - e * .5;
          ctx.fillRect(back, yc - 6, length, 12);
          ctx.fillRect(edge - 9, yc - 9, 18, 18);
          ctx.globalAlpha = 1;
        }
        break;
      }
      case "darkroom": {
        // 3:2 frames, eight across, parting by a hairline as the change-over starts.
        const cw = width / 8, ch = cw * 2 / 3, ny = Math.ceil(height / ch);
        const gutter = 3 * Math.min(1, t * 12);
        for (let y = 0; y < ny; y++) for (let x = 0; x < 8; x++) {
          const e = inOut((t - (x + y * .6) * .034) / .34);
          if (e >= 1) continue;
          const x0 = x * cw, y0 = y * ch, x1 = x0 + cw, y1 = Math.min(y0 + ch, height);
          const top = y0 + (y1 - y0) * e;
          piece(x0 + gutter, top + (e <= 0 ? gutter : 0), x1 - gutter, y1 - gutter);
          if (e > 0) { ctx.fillStyle = o.accent; ctx.globalAlpha = 1 - e * .6; ctx.fillRect(x0 + gutter, top - 1, cw - 2 * gutter, 2); ctx.globalAlpha = 1; }
        }
        break;
      }
      case "label": {
        const n = 12, w = width / n;
        for (let i = 0; i < n; i++) {
          const e = inOut((t - i * .04) / .4);
          if (e >= 1) continue;
          const half = height / 2 * (1 - e);
          piece(i * w, 0, (i + 1) * w + .5, half);
          piece(i * w, height - half, (i + 1) * w + .5, height);
          if (e > 0) { ctx.fillStyle = o.second; ctx.fillRect(i * w, half - 4, w, 4); ctx.fillRect(i * w, height - half, w, 4); }
        }
        break;
      }
      case "rack":
        squares(width / 12, (x, y) => x * .045 + y * .008, .26, t, false);
        break;
      case "spark":
        drawMaidReveal(ctx, t * MAID_REVEAL, width, height, piece);
        break;
      case "bubbles":
        drawWhaleReveal(ctx, t * WHALE_REVEAL, width, height, piece, !!image);
        break;
      case "plates":
      default: {
        const hash = (x: number, y: number) => (((Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0) % 1000) / 1000;
        squares(30, (x, y) => hash(x, y) * .6, .3, t, true);
      }
    }
  };

  draw(0);
  document.body.appendChild(canvas);
  // The picture covers the page; everything switches under it at once (without one, the page fades under her show).
  await new Promise(requestAnimationFrame);
  o.apply(!!image);
  const start = performance.now(), length = durationOf(o.motif);
  if (maid) o.walkAt?.(start + (maid === "claude" ? MAID_STEP : WHALE_STEP) * 1000);
  await new Promise<void>(resolve => {
    const frame = (now: number) => {
      const t = (now - start) / length;
      if (t >= 1) { resolve(); return; }
      draw(t);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  canvas.remove();
  image?.close();
}
