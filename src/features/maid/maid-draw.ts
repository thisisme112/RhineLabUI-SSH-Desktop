import type { Mascot } from "../theme/theme-design";
import { ART, FACES, maidArt, maidFace, maidPicture, tinted } from "./maid-art";

/**
 * The maids' drawing, on a 2D canvas, as the Unreal build draws it (RhineThemeFx.cpp): her spark, lace scallops,
 * hearts, bubbles, waves, the whale's tail, the hologram she is built as, the doorway of light she steps through, her
 * walk out of the middle of the screen and in at her place, and her bust with a face laid over it. Colours are
 * `[r, g, b]` and an opacity; the canvas's own transform gives the units.
 */
export type Ink = readonly [number, number, number];
export const ink = (hex: string): Ink => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as unknown as Ink;
export const css = (c: Ink, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a))})`;
type Ctx = CanvasRenderingContext2D;

export const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const ease = (t: number) => { t = clamp(t); return t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2; };
export const easeOut = (t: number) => 1 - (1 - clamp(t)) ** 4;
const TAU = Math.PI * 2;

export function disc(ctx: Ctx, x: number, y: number, r: number, color: string) {
  if (r <= 0) return;
  ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
}
/** A circle's outline `width` thick, inside its radius (as Slate draws a rounded box's). */
export function ring(ctx: Ctx, x: number, y: number, r: number, width: number, color: string) {
  if (r <= 0) return;
  ctx.lineWidth = width; ctx.strokeStyle = color;
  ctx.beginPath(); ctx.arc(x, y, Math.max(0, r - width / 2), 0, TAU); ctx.stroke();
}
export function polyline(ctx: Ctx, points: readonly (readonly [number, number])[], width: number, color: string) {
  if (points.length < 2) return;
  ctx.lineWidth = width; ctx.strokeStyle = color; ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.beginPath(); ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
  ctx.stroke();
}

/** A box with rounded corners; `corners` says which (1 top left, 2 top right, 4 bottom right, 8 bottom left). */
export function roundBox(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, color: string, corners = 15) {
  if (w <= 0 || h <= 0) return;
  const k = Math.min(r, w / 2, h / 2), at = (bit: number) => corners & bit ? k : 0;
  ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x, y, w, h, [at(1), at(2), at(4), at(8)]); ctx.fill();
}
/** A box turned about its centre. */
export function slab(ctx: Ctx, cx: number, cy: number, w: number, h: number, turn: number, color: string) {
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(turn); ctx.fillStyle = color; ctx.fillRect(-w / 2, -h / 2, w, h); ctx.restore();
}
export function triangle(ctx: Ctx, a: readonly [number, number], b: readonly [number, number], c: readonly [number, number], color: string) {
  ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(c[0], c[1]); ctx.fill();
}
/** The label design's figures (RhineFont::Display). */
export const DISPLAY = `"Barlow Condensed", Bahnschrift, "Arial Narrow", "Roboto Condensed", sans-serif-condensed, sans-serif`;
/** Sets the font as RhineFont::Get(size, weight, spacing) does, the line's top at y. */
export function font(ctx: Ctx, size: number, weight: number, spacing: number, face: string) {
  ctx.font = `${weight} ${size}px ${face}`;
  ctx.fontStretch = face === DISPLAY ? "condensed" : "normal";
  ctx.letterSpacing = `${spacing}px`;
  ctx.textBaseline = "top";
}
/** Text with its top at y, `alignX` of its width left of x (0 from the left, .5 centred, 1 to the right). */
export function text(ctx: Ctx, value: string, x: number, y: number, color: string, alignX = 0) {
  if (!value) return;
  ctx.fillStyle = color;
  ctx.fillText(value, alignX ? x - ctx.measureText(value).width * alignX : x, y);
}

/** Her spark: eight spokes about a clear centre; `draw` lays them one after another (0..1). */
export function spark(ctx: Ctx, cx: number, cy: number, r: number, width: number, color: string, turn = 0, draw = 1) {
  if (r <= 0) return;
  for (let i = 0; i < 8; i++) {
    const shown = clamp(draw * 8 - i);
    if (shown <= 0) break;
    const a = turn - Math.PI / 2 + i * Math.PI / 4, hub = r * .3, c = Math.cos(a), s = Math.sin(a);
    polyline(ctx, [[cx + c * hub, cy + s * hub], [cx + c * (hub + (r - hub) * shown), cy + s * (hub + (r - hub) * shown)]], width, color);
  }
}

/** Lace: discs of `pitch` along A→B (the caller clips them to the edge they hang from). */
export function scallops(ctx: Ctx, ax: number, ay: number, bx: number, by: number, pitch: number, color: string) {
  const length = Math.hypot(bx - ax, by - ay);
  if (length <= 0 || pitch <= 0) return;
  const sx = (bx - ax) / length * pitch, sy = (by - ay) / length * pitch;
  for (let i = 0, n = Math.ceil(length / pitch); i < n; i++) disc(ctx, ax + sx * (i + .5), ay + sy * (i + .5), pitch / 2, color);
}

export function heart(ctx: Ctx, cx: number, cy: number, size: number, color: string) {
  const r = size * .27;
  disc(ctx, cx - r * .95, cy - r * .35, r, color);
  disc(ctx, cx + r * .95, cy - r * .35, r, color);
  ctx.fillStyle = color; ctx.beginPath();
  ctx.moveTo(cx - r * 1.9, cy - r * .1); ctx.lineTo(cx + r * 1.9, cy - r * .1); ctx.lineTo(cx, cy + size * .5); ctx.fill();
}

export function bubble(ctx: Ctx, cx: number, cy: number, r: number, color: string) {
  if (r <= 0) return;
  ring(ctx, cx, cy, r, Math.max(1.2, r * .17), color);
  disc(ctx, cx - r * .36, cy - r * .36, r * .2, color);
}

/** Her spark, or for the whale a bubble that wobbles as it turns with a small one riding beside it (RhineFx::Twinkle). */
export function twinkle(ctx: Ctx, who: Mascot, cx: number, cy: number, r: number, width: number, color: string, turn: number) {
  if (who !== "deepseek") { spark(ctx, cx, cy, r, width, color, turn); return; }
  const wob = 1 + .06 * Math.sin(turn * 3);
  bubble(ctx, cx, cy, r * .62 * wob, color);
  bubble(ctx, cx + r * .62, cy - r * .55, r * .26, color);
}

export function waveLine(ctx: Ctx, x0: number, x1: number, y: number, amp: number, len: number, phase: number, width: number, color: string) {
  if (x1 <= x0) return;
  const points: [number, number][] = [];
  for (let x = x0; x < x1 + 4; x += 4) { const cx = Math.min(x, x1); points.push([cx, y + amp * Math.sin(cx / len * TAU + phase)]); }
  polyline(ctx, points, width, color);
}

/** The water under a wave line down to `bottom`. */
export function waveFill(ctx: Ctx, x0: number, x1: number, y: number, amp: number, len: number, phase: number, bottom: number, color: string) {
  if (x1 <= x0) return;
  ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(x0, bottom);
  for (let x = x0; x < x1 + 4; x += 4) { const cx = Math.min(x, x1); ctx.lineTo(cx, y + amp * Math.sin(cx / len * TAU + phase)); }
  ctx.lineTo(x1, bottom); ctx.closePath(); ctx.fill();
}

/** Her tail's fluke, its notch at (cx, cy): her own fin, tinted; two triangles' flukes until it has come in. */
export function whaleTail(ctx: Ctx, cx: number, cy: number, size: number, color: Ink, alpha: number) {
  if (size <= 0 || alpha <= 0) return;
  const fin = maidPicture("deepseek", "fin");
  if (fin) {
    const w = 1.1 * size, h = w * fin.height / Math.max(1, fin.width);
    ctx.save(); ctx.globalAlpha *= alpha;
    ctx.drawImage(tinted(fin, css(color)), cx - w / 2, cy - .631 * h, w, h);
    ctx.restore();
    return;
  }
  const s = size, c = css(color, alpha);
  const tri = (a: number[], b: number[], d: number[]) => { ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(cx + a[0] * s, cy + a[1] * s); ctx.lineTo(cx + b[0] * s, cy + b[1] * s); ctx.lineTo(cx + d[0] * s, cy + d[1] * s); ctx.fill(); };
  tri([0, 0], [-.52, -.34], [-.2, .06]); tri([-.52, -.34], [-.36, .02], [-.2, .06]);
  tri([0, 0], [.52, -.34], [.2, .06]); tri([.52, -.34], [.36, .02], [.2, .06]);
  disc(ctx, cx - .44 * s, cy - .22 * s, .1 * s, c); disc(ctx, cx + .44 * s, cy - .22 * s, .1 * s, c);
  tri([-.14, .02], [.14, .02], [0, .5]);
}

/**
 * Her picture as a projection being built: 96 strips, shown from the feet up (`shown`), parted by gaps that close as it
 * comes solid (`solid`), a few slipping sideways; a tinted ghost beside each while it is not solid, and a bright line
 * with a glow where it is being built.
 */
export function hologram(ctx: Ctx, art: ImageBitmap | undefined, x: number, y: number, w: number, h: number, shown: number, solid: number, opacity: number, time: number, tint: Ink) {
  if (!art || opacity <= 0 || shown <= 0 || w <= 0 || h <= 0) return;
  const n = 96, strip = h / n, gap = .45 * (1 - clamp(solid)), sh = art.height / n;
  const ghost = solid < 1 ? tinted(art, css(tint)) : undefined;
  ctx.save();
  for (let i = 0; i < n; i++) {
    if ((n - 1 - i) / n > shown) continue;
    const slip = (i * 7) % 9 === 0 ? 10 * (1 - solid) * Math.sin(time * 37 + i) : 0;
    const dy = y + i * strip, dh = strip * (1 - gap), sy = i * sh, sHeight = sh * (1 - gap);
    ctx.globalAlpha = opacity;
    ctx.drawImage(art, 0, sy, art.width, sHeight, x + slip, dy, w, dh);
    if (ghost) { ctx.globalAlpha = opacity * .4 * (1 - solid); ctx.drawImage(ghost, 0, sy, art.width, sHeight, x + slip + 4, dy, w, dh); }
  }
  ctx.restore();
  if (shown < 1) {
    const edge = y + h * (1 - shown);
    ctx.fillStyle = `rgba(255,245,230,${opacity})`; ctx.fillRect(x - 30, edge - 1.5, w + 60, 3);
    for (let i = 1; i <= 4; i++) { ctx.fillStyle = css(tint, opacity * .16 * (1 - i / 5)); ctx.fillRect(x - 30, edge + 1.5 + (i - 1) * 6, w + 60, 6); }
  }
}

/** The projector she stands on: a glow going up and three dashed rings turning in perspective. */
export function holoPlatform(ctx: Ctx, cx: number, cy: number, r: number, time: number, ringColor: Ink, glow: Ink, opacity: number) {
  if (opacity <= 0) return;
  for (let j = 0; j < 12; j++) { ctx.fillStyle = css(glow, opacity * .11 * (1 - j / 12)); ctx.fillRect(cx - r * .85, cy - (j + 1) * 26, r * 1.7, 26); }
  for (let k = 0; k < 3; k++) {
    const rr = r * (1 + k * .24), spin = time * (k % 2 ? -.9 : .7), dashes = 30 + k * 8, color = css(ringColor, opacity * (1 - k * .25));
    for (let i = 0; i < dashes; i++) {
      const a0 = spin + i * TAU / dashes, a1 = a0 + TAU / dashes * .55;
      polyline(ctx, [[cx + Math.cos(a0) * rr, cy + Math.sin(a0) * rr * .24], [cx + Math.cos(a1) * rr, cy + Math.sin(a1) * rr * .24]], 2.4, color);
    }
  }
}

// ── Her walk ────────────────────────────────────────────────────────────────

/** Seconds of the walk through the doorway (RhineFx::ClaudeWalkTime); the doorway opens over the fifth before it. */
export const WALK_TIME = 1;
const walkFrame = (who: Mascot, step: number) => maidArt(who, Math.floor(clamp(step, 0, WALK_TIME - .01) / .25) % 2 ? ART.walk2 : ART.walk1);
/** How far along her walk (0..1): the first step taken a little slowly, then an even pace. */
const walkPart = (step: number) => { const t = clamp(step / WALK_TIME); return (t < .2 ? 2.5 * t * t : t - .1) / .9; };
/** Up on her toes between footfalls. */
const walkBob = (step: number, high: number) => step <= 0 ? 0 : -high * .012 * Math.abs(Math.sin(Math.PI * Math.min(step, WALK_TIME) / .25));
/** The doorway's light: opening over the fifth of a second before the walk, gone three tenths after it. */
export const doorOpen = (step: number) => clamp((step + .2) / .2) * (1 - clamp((step - WALK_TIME) / .3));

/** A doorway of light at x: a bright seam grown from its middle, a glow, sparks drifting along it; hers a column of bubbles round a ripple. */
export function doorway(ctx: Ctx, who: Mascot, x: number, top: number, bottom: number, open: number, time: number, cream: Ink, orange: Ink, opacity: number) {
  if (open <= 0 || opacity <= 0) return;
  const mid = (top + bottom) / 2, half = (bottom - top) / 2 * easeOut(Math.min(1, open * 1.4));
  if (who === "deepseek") {
    const ripple: [number, number][] = [];
    for (let y = mid - half; y <= mid + half; y += 6) ripple.push([x + 3 * Math.sin(y / 22 + time * 6), y]);
    polyline(ctx, ripple, 7, css(orange, .18 * open * opacity));
    polyline(ctx, ripple, 2.2, css(cream, .8 * open * opacity));
    for (let i = 0; i < 12; i++) {
      const life = (time * (.5 + .25 * ((i * .37) % 1)) + i * .083) % 1, r = (bottom - top) * (.012 + .02 * ((i * .61) % 1));
      bubble(ctx, x + 10 * Math.sin(time * 3 + i * 1.7), mid + half - life * 2 * half, r, css(i % 3 ? orange : cream, open * opacity * Math.sin(Math.PI * life)));
    }
    return;
  }
  for (let i = 3; i >= 1; i--) { ctx.fillStyle = css(orange, .13 * open * opacity); ctx.fillRect(x - i * 5, mid - half, i * 10, 2 * half); }
  ctx.fillStyle = css(cream, open * opacity); ctx.fillRect(x - 1.5, mid - half, 3, 2 * half);
  disc(ctx, x, mid - half, 4, css(cream, open * opacity)); disc(ctx, x, mid + half, 4, css(cream, open * opacity));
  for (let i = 0; i < 5; i++) {
    const life = (time * .7 + i * .2) % 1;
    spark(ctx, x + 7 * Math.sin(time * 3 + i * 2), mid + half - life * 2 * half, 5 + (i % 2) * 2, 1.8, css(i % 2 ? cream : orange, open * opacity * Math.sin(Math.PI * life)), time * 2 + i);
  }
}

export function image(ctx: Ctx, art: ImageBitmap, x: number, y: number, w: number, h: number, alpha: number) {
  if (alpha <= 0) return;
  ctx.save(); ctx.globalAlpha *= alpha; ctx.drawImage(art, x, y, w, h); ctx.restore();
}

/** She leaves the middle of the screen: from her wave into her stride, out to the right through her doorway (gone past it). */
export function walkOut(ctx: Ctx, who: Mascot, feetX: number, feetY: number, high: number, step: number, time: number, cream: Ink, orange: Ink, opacity = 1) {
  const stride = walkFrame(who, step);
  if (!stride || opacity <= 0) return;
  const wide = high * stride.width / stride.height, gap = high * .03, edge = feetX + wide / 2 + gap;
  doorway(ctx, who, edge, feetY - high * 1.04, feetY + high * .02, doorOpen(step), time, cream, orange, opacity);
  if (step < 0) return;
  const turn = clamp(step / .12), waving = maidArt(who, ART.wave);
  if (turn < 1 && waving) { const ww = high * waving.width / waving.height; image(ctx, waving, feetX - ww / 2, feetY - high, ww, high, (1 - turn) * opacity); }
  const part = walkPart(step);
  if (part >= 1) return;
  const cx = feetX + part * (wide + gap);
  ctx.save(); ctx.beginPath(); ctx.rect(feetX - 2 * wide, feetY - high * 1.3, edge - (feetX - 2 * wide), high * 1.4); ctx.clip();
  image(ctx, stride, cx - wide / 2, feetY - high + walkBob(step, high), wide, high, turn * opacity);
  ctx.restore();
}

/**
 * She comes in at her place through a doorway at her left, on the same clock as walkOut; arrived (step ≥ WALK_TIME),
 * a puff of sparks and hearts (bubbles, hers) over the change to her own pose, which her owner draws.
 * Returns false while she is still on her way (the owner draws nothing of her own yet).
 */
export function walkIn(ctx: Ctx, who: Mascot, feetX: number, feetY: number, high: number, step: number, time: number, cream: Ink, orange: Ink, opacity = 1): boolean {
  const stride = walkFrame(who, step);
  if (!stride || opacity <= 0) return step >= WALK_TIME;
  const wide = high * stride.width / stride.height, gap = high * .03, edge = feetX - wide / 2 - gap;
  doorway(ctx, who, edge, feetY - high * 1.04, feetY + high * .02, doorOpen(step), time, cream, orange, opacity);
  if (step < 0) return false;
  if (step >= WALK_TIME) {
    const puff = (step - WALK_TIME) / .35;
    if (puff < 1) for (let i = 0; i < 10; i++) {
      const a = i * TAU / 10 + .3, r = high * (.22 + .2 * easeOut(puff)), x = feetX + Math.cos(a) * r * .7, y = feetY - high * .5 + Math.sin(a) * r;
      const color = css(i % 2 ? cream : orange, (1 - puff) * opacity);
      if (i % 3 === 0 && who === "deepseek") bubble(ctx, x, y, high * .02, color);
      else if (i % 3 === 0) heart(ctx, x, y, high * .045, color);
      else spark(ctx, x, y, high * .025, Math.max(1.6, high * .006), color, time * 3 + i);
    }
    return true;
  }
  const cx = feetX - (1 - walkPart(step)) * (wide + gap);
  ctx.save(); ctx.beginPath(); ctx.rect(edge, feetY - high * 1.3, feetX + 2 * wide - edge, high * 1.4); ctx.clip();
  image(ctx, stride, cx - wide / 2, feetY - high + walkBob(step, high), wide, high, opacity);
  ctx.restore();
  return false;
}

// ── Her bust and face ───────────────────────────────────────────────────────

/** Where the face patches lie on each bust, in its own 1024 pixels. */
const FACE_RECT: Record<Mascot, readonly [number, number, number, number]> = { claude: [300, 270, 340, 270], deepseek: [330, 290, 330, 250] };

/**
 * Her bust in a `size` square at (x, y), breathing and swaying about the middle of her shoulders, with the mood's face
 * (MOODS) laid over it; with none, a blink now and then, and the mouth moving while she talks.
 */
export function puppet(ctx: Ctx, who: Mascot, x: number, y: number, size: number, mood: number, talking: boolean, time: number, alpha = 1) {
  const bust = maidFace(who, 0);
  if (!bust || size <= 0 || alpha <= 0) return;
  const breath = .008 * Math.sin(time * 1.7), sway = .014 * Math.sin(time * .75) + .006 * Math.sin(time * 1.9);
  ctx.save();
  ctx.translate(x + size / 2, y + size);
  ctx.rotate(sway); ctx.scale(1, 1 + breath);
  ctx.translate(-size / 2, -size);
  ctx.globalAlpha *= alpha;
  ctx.drawImage(bust, 0, 0, size, size);
  let face = Math.max(0, Math.min(7, mood));
  if (face === 0) {
    const cycle = 3.6 + .9 * Math.sin(Math.floor(time / 4.1) * 2.3);
    if (time % cycle < .13) face = 8;
    else if (talking && time % .26 < .13) face = 9;
  }
  const patch = face ? maidFace(who, face) : undefined;
  if (patch) {
    const k = size / 1024, [fx, fy, fw, fh] = FACE_RECT[who];
    ctx.drawImage(patch, fx * k, fy * k, fw * k, fh * k);
  }
  ctx.restore();
}

export { FACES };
