import { ART, maidArt } from "./maid-art";
import { bubble, ease, easeOut, heart, hologram, holoPlatform, ink, spark, walkOut, waveFill, waveLine, whaleTail, WALK_TIME } from "./maid-draw";

/**
 * The two maids' theme change-overs (the Unreal build's SRhineThemeReveal, ERhinePoster::Maid and ::Whale), drawn by
 * theme-reveal.ts over the captured frame. `piece` is its window onto the capture where it stands (nothing without
 * a capture: then the new theme fades in under her show).
 */
export type Piece = (x0: number, y0: number, x1: number, y1: number, dx?: number) => void;

/** When she sets off walking out of the middle (MaidStep / WhaleStep), in seconds; her small self walks in on the same clock. */
export const MAID_STEP = 2, WHALE_STEP = 2.4;
export const MAID_REVEAL = MAID_STEP + WALK_TIME + .35, WHALE_REVEAL = WHALE_STEP + WALK_TIME + .35;

const win = (t: number, from: number, to: number) => Math.min(1, Math.max(0, (t - from) / (to - from)));
const cubicIn = (x: number) => { x = Math.min(1, Math.max(0, x)); return x * x * x; };
const quadOut = (x: number) => { x = Math.min(1, Math.max(0, x)); return 1 - (1 - x) * (1 - x); };
const uiFace = () => getComputedStyle(document.body).fontFamily;
const CREAM = ink("#f7ecdf"), ORANGE = ink("#d97757"), PALE = ink("#8cd9ff"), SOOT = ink("#140d0b");
const FOAM = ink("#f0f4ff"), BLUE = ink("#4d6bfe"), NAVY = ink("#182050"), SHALLOW = ink("#88b0f8");
const rgba = (c: readonly number[], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a))})`;

/** Her call on a pill at the top of the screen, typed out letter by letter. */
function pill(ctx: CanvasRenderingContext2D, x: number, w: number, h: number, line: string, letters: number, shadow: string, fill: string, color: string, spacing: number) {
  ctx.fillStyle = shadow; ctx.beginPath(); ctx.roundRect(x - w / 2 + 5, 96 + 5, w, h, h / 2); ctx.fill();
  ctx.fillStyle = fill; ctx.beginPath(); ctx.roundRect(x - w / 2, 96, w, h, h / 2); ctx.fill();
  ctx.font = `800 18px ${uiFace()}`; ctx.letterSpacing = `${spacing}px`; ctx.textBaseline = "middle"; ctx.fillStyle = color;
  const whole = ctx.measureText(line).width;
  ctx.fillText([...line].slice(0, Math.max(0, letters)).join(""), x - whole / 2, 96 + h / 2 + 1);
  ctx.letterSpacing = "0px";
}

/** Claude's change-over, T seconds in. */
export function drawMaidReveal(ctx: CanvasRenderingContext2D, T: number, width: number, height: number, piece: Piece) {
  const U = height / 1080, W = width / U, H = 1080, mid = W / 2;
  // The old frame: glitching for its first moments (bands slipping, tinted slices), then breaking up in squares from the
  // middle out, each falling in on itself; every third leaves a spark or a heart rising (drawn over everything below).
  const rising: [number, number, number, number][] = [];
  if (T < .3) {
    const bands = 14, bh = height / bands, amount = 1 - T / .3;
    for (let i = 0; i < bands; i++) {
      const slip = (i % 3 === 1 ? 26 : i % 4 === 0 ? -18 : 0) * Math.sin(T * 70 + i) * amount * U;
      piece(0, i * bh - .5, width, (i + 1) * bh + .5, slip);
      if (i % 4 === 1) { ctx.fillStyle = rgba(i % 8 === 1 ? ORANGE : PALE, .28 * amount); ctx.fillRect(slip * 1.4, i * bh, width, bh * .4); }
    }
  } else {
    const size = 54 * U, nx = Math.ceil(width / size), ny = Math.ceil(height / size), reach = Math.hypot(width / 2, height / 2);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const cx = (x + .5) * size, cy = (y + .5) * size, hash = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0;
      const delay = .3 + .55 * Math.hypot(cx - width / 2, cy - height / 2) / reach + .12 * (hash % 100) / 100;
      const e = cubicIn((T - delay) / .28);
      if (e <= 0) { piece(x * size - .5, y * size - .5, (x + 1) * size + .5, (y + 1) * size + .5); continue; }
      if (hash % 3 === 0 && T - delay < .9) rising.push([cx / U, cy / U - 90 * quadOut((T - delay) / .9), hash, (T - delay) / .9]);
      if (e >= 1) continue;
      const half = size * .5 * (1 - e);
      piece(cx - half, cy - half, cx + half, cy + half);
      ctx.fillStyle = rgba(ORANGE, .35 * e); ctx.fillRect(cx - half, cy - half, half * 2, half * 2);
    }
  }
  ctx.save(); ctx.scale(U, U);
  // A blueprint grid and a scan line over the new theme, while she is there.
  const grid = win(T, .25, .5) * (1 - win(T, MAID_STEP + .6, MAID_STEP + 1.2));
  if (grid > 0) {
    ctx.fillStyle = rgba(ORANGE, .13 * grid);
    for (let x = 0; x < W; x += 48) ctx.fillRect(x, 0, 1, H);
    for (let y = 0; y < H; y += 48) ctx.fillRect(0, y, W, 1);
  }
  const scan = win(T, .3, 1.1);
  if (scan > 0 && scan < 1) {
    const y = H * ease(scan);
    for (let i = 1; i <= 6; i++) { ctx.fillStyle = rgba(ORANGE, .12 * (1 - i / 7)); ctx.fillRect(0, y - 2 - i * 8, W, 8); }
    ctx.fillStyle = rgba(CREAM, 1); ctx.fillRect(0, y - 2, W, 4);
  }
  // HUD brackets on the screen's corners.
  const snap = win(T, .1, .45), fade = 1 - win(T, MAID_STEP + .8, MAID_STEP + 1.25), off = 40 + 40 * (1 - snap), len = 70;
  if (snap > 0 && fade > 0) {
    ctx.strokeStyle = rgba(CREAM, .9 * snap * fade); ctx.lineWidth = 4; ctx.lineCap = "butt";
    for (const [x, y, sx, sy] of [[off, off, 1, 1], [W - off, off, -1, 1], [W - off, H - off, -1, -1], [off, H - off, 1, -1]]) {
      ctx.beginPath(); ctx.moveTo(x, y + sy * len); ctx.lineTo(x, y); ctx.lineTo(x + sx * len, y); ctx.stroke();
    }
  }
  // Her hologram in the middle: built from the feet up, solid, a wave; then she walks out to the right.
  const figure = 820, feet = H - 60, step = T - MAID_STEP, leave = win(T, MAID_STEP, MAID_STEP + .6);
  const built = ease(win(T, .35, 1.25)), solid = ease(win(T, 1.2, 1.45)), wave = win(T, 1.45, 1.65);
  holoPlatform(ctx, mid, feet, 170, T, ORANGE, ORANGE, quadOut(win(T, .3, .6)) * (1 - leave));
  const standing = maidArt("claude", ART.stand);
  if (standing) { const wd = figure * standing.width / standing.height; hologram(ctx, standing, mid - wd / 2, feet - figure, wd, figure, built, solid, (1 - wave) * (1 - leave), T, ORANGE); }
  const waving = maidArt("claude", ART.wave);
  if (wave > 0 && step < 0 && waving) { const wd = figure * waving.width / waving.height; ctx.save(); ctx.globalAlpha = wave; ctx.drawImage(waving, mid - wd / 2, feet - figure, wd, figure); ctx.restore(); }
  walkOut(ctx, "claude", mid, feet, figure, step, T, CREAM, ORANGE);
  for (let i = 0; i < 16; i++) {
    const life = (T * .8 + i * .29) % 1, a = Math.sin(Math.PI * life) * win(T, .35, .6) * (1 - win(T, MAID_STEP - .1, MAID_STEP + .3));
    const x = mid + (((i * 97) % 11) - 5) * 46, y = feet - 30 - life * figure;
    if (i % 3 === 0) heart(ctx, x, y, 16, rgba(ORANGE, .85 * a));
    else spark(ctx, x, y, 8, 2.2, rgba(i % 2 ? CREAM : ORANGE, .85 * a), T * 2 + i);
  }
  for (const [x, y, hash, rise] of rising) {
    const color = rgba(hash % 2 ? ORANGE : CREAM, .9 * (1 - rise));
    if (hash % 7 < 3) heart(ctx, x, y, 16, color); else spark(ctx, x, y, 8, 2.2, color, T * 3 + hash % 10);
  }
  // What is loading, under the scan: typed, then a heart.
  const shown = win(T, .4, .55) * (1 - win(T, 2, 2.3));
  if (shown > 0) pill(ctx, mid, 600, 54, "THEME · CLAUDE MAID  ♡  小克 已就位", Math.floor((T - .45) * 40), rgba(ORANGE, shown), rgba(SOOT, .94 * shown), rgba(CREAM, shown), 1.6);
  ctx.restore();
}

/** DeepSeek's change-over, T seconds in. */
export function drawWhaleReveal(ctx: CanvasRenderingContext2D, T: number, width: number, height: number, piece: Piece, captured: boolean) {
  const U = height / 1080, W = width / U, H = 1080, mid = W / 2, phase = T * 4;
  // The sea comes up over the old frame (whose part above the water still shows), then drains away down off the new one.
  const rise = win(T, 0, .55), drain = win(T, .6, 1.2);
  const level = drain > 0 ? H * 1.08 * (1 - ease(drain)) : H * 1.08 * cubicIn(rise), surface = H - level;
  if (drain <= 0 && captured) piece(0, 0, width, Math.max(0, surface + 20) * U);
  ctx.save(); ctx.scale(U, U);
  if (level > 0) {
    waveFill(ctx, 0, W, surface, 18, 300, phase, H + 2, rgba(BLUE, 1));
    waveFill(ctx, 0, W, surface + 26, 12, 220, phase * 1.3 + 2, H + 2, rgba(NAVY, .35));
    waveLine(ctx, 0, W, surface, 18, 300, phase, 6, rgba(FOAM, 1));
    for (let i = 0; i < 30; i++) {
      const x = ((i * .618) % 1) * W, up = (T * (.6 + .4 * ((i * .37) % 1)) + i * .11) % 1, y = H - up * level;
      if (y > surface + 24) bubble(ctx, x + 12 * Math.sin(T * 3 + i), y, 6 + 12 * ((i * .29) % 1), rgba(FOAM, .7 * (1 - up * .5)));
    }
  }
  // A great whale's shadow swimming across behind, from the left: a body of discs tapering to her tail.
  const swim = win(T, .7, 2.3);
  if (swim > 0 && swim < 1) {
    const fade = Math.sin(Math.PI * swim) * .14, head = -500 + swim * (W + 1000);
    ctx.fillStyle = rgba(NAVY, fade);
    for (let i = 0; i < 14; i++) {
      const along = i / 13, x = head - along * 520, y = H * .42 + 26 * Math.sin(swim * 9 - along * 2.5), r = 120 * (1 - .8 * along * along) * (along < .15 ? .85 + along : 1);
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    whaleTail(ctx, head - 560, H * .42 + 26 * Math.sin(swim * 9 - 2.6), 220, NAVY, fade);
  }
  // She swims in from the left (bobbing), lands in the middle in a splash and waves; then she walks out.
  const figure = 820, feet = H - 60, step = T - WHALE_STEP, swimIn = win(T, .85, 1.55), landed = win(T, 1.55, 1.7);
  const swimmer = maidArt("deepseek", ART.swim);
  if (swimIn > 0 && landed < 1 && swimmer) {
    const sh = 420, sw = sh * swimmer.width / swimmer.height;
    const x = -sw + (mid + sw * .1) * easeOut(swimIn), y = H * .38 + 22 * Math.sin(T * 7);
    ctx.save(); ctx.globalAlpha = 1 - landed; ctx.drawImage(swimmer, x - sw / 2, y - sh / 2, sw, sh); ctx.restore();
    for (let i = 1; i <= 6; i++) bubble(ctx, x - sw * .5 - i * 26, y + 14 * Math.sin(T * 5 + i), 5 + i, rgba(SHALLOW, (1 - i / 7) * (1 - landed)));
  }
  if (landed > 0) {
    // The splash: drops thrown up and out from her feet, and a ring on the floor.
    const splash = win(T, 1.55, 2.2);
    if (splash < 1) {
      for (let i = 0; i < 14; i++) {
        const a = Math.PI * (1.1 + .8 * i / 13), far = 60 + 300 * easeOut(splash);
        const x = mid + Math.cos(a) * far, y = feet - 40 + Math.sin(a) * far * .9 + 500 * splash * splash;
        ctx.fillStyle = rgba(i % 2 ? BLUE : SHALLOW, 1 - splash); ctx.beginPath(); ctx.arc(x, y, 9 - 4 * splash, 0, Math.PI * 2); ctx.fill();
      }
      ctx.strokeStyle = rgba(BLUE, 1 - splash); ctx.lineWidth = 4;
      ctx.beginPath(); ctx.ellipse(mid, feet, Math.max(.1, 300 * easeOut(splash)), Math.max(.1, 60 * easeOut(splash)), 0, 0, Math.PI * 2); ctx.stroke();
    }
    const waving = maidArt("deepseek", ART.wave);
    if (step < 0 && waving) {
      const wd = figure * waving.width / waving.height, hop = 30 * Math.max(0, Math.sin(Math.PI * win(T, 1.55, 1.9)));
      ctx.save(); ctx.globalAlpha = landed; ctx.drawImage(waving, mid - wd / 2, feet - figure - hop, wd, figure); ctx.restore();
    }
    walkOut(ctx, "deepseek", mid, feet, figure, step, T, FOAM, BLUE);
  }
  // Her call, on a pill at the top.
  const shown = win(T, 1.6, 1.8) * (1 - win(T, WHALE_STEP + .3, WHALE_STEP + .6));
  if (shown > 0) {
    pill(ctx, mid, 640, 56, "THEME · DEEPSEEK WHALE  ～  大肥鱼报到！", Math.floor((T - 1.62) * 45), rgba(BLUE, shown), rgba(NAVY, .95 * shown), rgba(FOAM, shown), 1.4);
    bubble(ctx, mid + 320 - 26, 106, 7, rgba(SHALLOW, shown));
  }
  ctx.restore();
}
