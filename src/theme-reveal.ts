import type { Motif } from "./theme-design";

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
 *   frames    64 px squares close towards their centres from the middle out
 *   orbit     squares close outward from the origin (the selected card), in rings
 *   plates    a 30 px halftone that drops out in scattered order over a second plate
 *
 * Without a capture (the plain web build, reduced motion) the palette simply
 * cross-fades, as it always has.
 */
export type RevealOptions = {
  motif: Motif;
  /** Applies the new palette; runs once the capture covers the page. */
  apply: () => void;
  /** Edge lines and the plates' second colour, as CSS colours. */
  accent: string;
  second: string;
  /** Where orbit's rings start, 0..1 of the viewport. */
  origin?: readonly [number, number];
  reduced: boolean;
};

const DURATION = 1000;
let running: Promise<void> | undefined;

export async function playThemeReveal(options: RevealOptions): Promise<void> {
  if (running) await running;
  running = run(options).finally(() => { running = undefined; });
  return running;
}

async function run(o: RevealOptions) {
  const capture = window.rhineDesktop?.capture;
  let image: ImageBitmap | undefined;
  if (!o.reduced && capture) {
    try {
      const bytes = await capture();
      if (bytes) image = await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/jpeg" }));
    } catch { image = undefined; }
  }
  if (!image) { o.apply(); return; }

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
  const kx = image.width / width, ky = image.height / height;
  const piece = (x0: number, y0: number, x1: number, y1: number) => {
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(width, x1); y1 = Math.min(height, y1);
    if (x1 - x0 < .5 || y1 - y0 < .5) return;
    ctx.drawImage(image!, x0 * kx, y0 * ky, (x1 - x0) * kx, (y1 - y0) * ky, x0, y0, x1 - x0, y1 - y0);
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
        const reach = Math.hypot(width / 2, height / 2);
        squares(64, (_x, _y, cx, cy) => Math.hypot(cx - width / 2, cy - height / 2) / reach * .5, .34, t, false);
        break;
      }
      case "orbit": {
        const [ox, oy] = origin;
        const reach = Math.max(Math.hypot(ox, oy), Math.hypot(width - ox, oy), Math.hypot(ox, height - oy), Math.hypot(width - ox, height - oy));
        // Rings: the distance is quantised, so whole rings close together.
        squares(56, (_x, _y, cx, cy) => Math.floor(Math.hypot(cx - ox, cy - oy) / reach * 9) / 9 * .56, .32, t, false);
        break;
      }
      case "vector": {
        const n = 16, h = height / n;
        for (let i = 0; i < n; i++) {
          const dir = i % 2 === 0 ? 1 : -1;
          const e = inOut((t - (i * .028)) / .44);
          if (e >= 1) continue;
          const w = width * (1 - e);
          const x0 = dir === 1 ? 0 : width - w;
          piece(x0, i * h, x0 + w, (i + 1) * h);
          if (e > 0) {
            ctx.fillStyle = o.accent;
            ctx.fillRect(dir === 1 ? x0 + w - 2 : x0, i * h, 2, h);
          }
        }
        break;
      }
      default: {
        const hash = (x: number, y: number) => (((Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0) % 1000) / 1000;
        squares(30, (x, y) => hash(x, y) * .6, .3, t, true);
      }
    }
  };

  draw(0);
  document.body.appendChild(canvas);
  // The picture covers the page; everything switches under it at once.
  await new Promise(requestAnimationFrame);
  o.apply();
  const start = performance.now();
  await new Promise<void>(resolve => {
    const frame = (now: number) => {
      const t = (now - start) / DURATION;
      if (t >= 1) { resolve(); return; }
      draw(t);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  canvas.remove();
  image.close();
}
