import type { Mascot } from "../theme/theme-design";
import { ART, maidArt } from "./maid-art";
import {
  DISPLAY, bubble, clamp, css, disc, ease, easeOut, font, heart, hologram, holoPlatform, image, polyline, ring, roundBox, spark, text,
  walkOut, waveFill, waveLine, whaleTail, ink, type Ink,
} from "./maid-draw";
import { uiFace } from "./maid-lines";
import { StageCanvas } from "./stage-canvas";
import "./maid.css";

/**
 * The maids' own start-ups (the Unreal build's SRhineClaudeOpening and SRhineWhaleOpening), in place of the opening
 * film in their themes:
 *
 *   Claude    a self-check typed line by line on her dark, hearts filling as she is built as a hologram on its
 *             projector, solid, online; she waves and greets the reader by the hour
 *   DeepSeek  a dive log under sonar pings in the deep, bubbles filling as she swims up round the screen, lands in
 *             a splash, online; she greets the captain
 *
 * Done (or any key), it leaves over the home as the home arrives: Claude's ground breaks up in squares from the middle
 * out, DeepSeek's sea drains down, and she walks out through her doorway as her small self walks in at her place.
 */
export const CLAUDE_OPENING = {
  lines: ["> 初始化女仆核心", "> 载入性格模块 · 温柔 / 认真", "> 表情与动作 · 9 FACES · 11 POSES", "> 红茶服务", "> SSH 工作台", "> 主机档案"],
  lineAt: (i: number) => .5 + .5 * i, rate: 45, settle: .15,
  projectAt: .8, syncFrom: 1, syncTo: 3.6, solidFrom: 3.4, solidTo: 3.9, onlineAt: 3.9, waveAt: 3.95, greetAt: 4.15, end: 5.6, stepFrom: 1.5,
} as const;
export const WHALE_OPENING = {
  lines: ["> 声呐自检", "> 鲸歌模块 · 活泼 / 话痨", "> 表情与动作 · 9 FACES · 12 POSES", "> 鲷鱼烧储备", "> SSH 航线", "> 主机档案"],
  lineAt: (i: number) => .5 + .45 * i, rate: 48, settle: .12,
  sonarAt: [.3, 1.5, 2.7], riseFrom: 1, riseTo: 3.3, landAt: 3.4, onlineAt: 3.7, greetAt: 3.9, end: 5.4, stepFrom: 1.5,
} as const;
/** How long the leaving lasts (Unreal: her opening is shown 3.2 s after it begins to leave). */
const LEAVE = 3.2;

const backOut = (t: number) => { t = clamp(t) - 1; return 1 + 2.70158 * t * t * t + 1.70158 * t * t; };
const mix = (a: Ink, b: Ink, t: number): Ink => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const frac = (x: number) => x - Math.floor(x);
const length = (s: string) => [...s].length;
const left = (s: string, n: number) => [...s].slice(0, Math.max(0, n)).join("");

export type OpeningCue = "column" | "ui-tick" | "confirm" | "scan" | "array" | "tick" | "brand" | "welcome" | "open";
type Colors = { ground: Ink; cream: Ink; mark: Ink };

export class MaidOpening {
  private canvas = new StageCanvas("maid-opening");
  private who: Mascot = "claude";
  private startedAt = -1;
  private leaveAt = -1;
  private leaveFrom = 0;
  private before = -1;
  private hosts: () => number = () => 0;
  private colors: Colors = { ground: [0, 0, 0], cream: [255, 255, 255], mark: [255, 0, 0] };
  private size: [number, number] = [0, 0];

  constructor(private host: HTMLElement, private sound: (cue: OpeningCue, gain?: number, pan?: number) => void) {
    this.canvas.el.hidden = true;
    host.append(this.canvas.el);
    const measure = () => { this.size = [host.clientWidth, host.clientHeight]; };
    measure();
    new ResizeObserver(measure).observe(host);
  }

  /** Her start-up is on screen (playing, or leaving). */
  get active() { return this.startedAt >= 0; }
  /** Playing, not yet leaving: what is under it is covered. */
  get covering() { return this.startedAt >= 0 && this.leaveAt < 0; }

  start(who: Mascot, time: number, hosts: () => number, colors: Colors) {
    this.who = who; this.startedAt = time; this.leaveAt = -1; this.before = -1; this.hosts = hosts; this.colors = colors;
    this.canvas.el.hidden = false;
  }

  /** It leaves now (done, or a key): from where it stands. */
  leave(time: number) {
    if (!this.covering) return;
    this.leaveFrom = time - this.startedAt;
    this.leaveAt = time;
    this.sound("open", 1.1);
  }

  /** Seconds into her walk out of it (the home's companion walks in on this clock); 1e9 when it is not leaving, -100 before. */
  stepIn(time: number) {
    if (this.startedAt < 0) return 1e9;
    if (this.leaveAt < 0) return -100;
    return time - this.leaveAt - (this.who === "deepseek" ? WHALE_OPENING.stepFrom : CLAUDE_OPENING.stepFrom);
  }

  /** Draws this frame. Returns false once it is over (and hidden). */
  update(time: number) {
    if (this.startedAt < 0) return false;
    const end = this.who === "deepseek" ? WHALE_OPENING.end : CLAUDE_OPENING.end;
    const t = time - this.startedAt;
    if (this.leaveAt < 0 && t >= end) this.leave(time);
    const gone = this.leaveAt >= 0 ? time - this.leaveAt : -1;
    if (gone >= LEAVE) { this.stop(); return false; }
    if (gone < 0) this.cues(t);
    const [w, h] = this.size;
    if (w < 100 || h < 100) return true;
    const ctx = this.canvas.begin(w, h, devicePixelRatio);
    const u = h / 980;
    ctx.scale(u, u);
    const T = gone >= 0 ? this.leaveFrom : t;
    if (this.who === "deepseek") paintWhale(ctx, T, gone, w / u, this.hosts());
    else paintClaude(ctx, T, gone, w / u, this.hosts(), this.colors);
    return true;
  }

  stop() {
    this.startedAt = -1; this.leaveAt = -1;
    this.canvas.clear();
    this.canvas.el.hidden = true;
  }

  /** Its sounds, on the moments it draws (RhineLabelBoot.cpp TickOpening). */
  private cues(t: number) {
    const before = this.before;
    this.before = t;
    if (before < 0) return;
    const passed = (at: number) => before < at && t >= at;
    if (this.who === "deepseek") {
      const o = WHALE_OPENING;
      if (passed(.2)) this.sound("column", .9);
      for (const at of o.sonarAt) if (passed(at)) this.sound("scan");
      o.lines.forEach((line, i) => {
        const letters = (clock: number) => clamp(Math.floor((clock - o.lineAt(i)) * o.rate), 0, length(line));
        if (Math.floor(letters(t) / 3) !== Math.floor(letters(before) / 3)) this.sound("ui-tick", .85, -.2);
        if (passed(o.lineAt(i) + length(line) / o.rate + o.settle)) this.sound("confirm", .8, -.15);
      });
      for (let i = 0; i < 12; i++) if (passed(o.riseFrom + (o.riseTo - o.riseFrom) * (i + 1) / 12)) this.sound("tick", .75, -.2);
      if (passed(o.landAt)) this.sound("open", 1.1, .3);
      if (passed(o.onlineAt)) this.sound("brand", .9, .3);
      if (passed(o.greetAt)) this.sound("welcome", .9, .35);
      return;
    }
    const o = CLAUDE_OPENING;
    if (passed(.15)) this.sound("column", .9);
    if (passed(.3)) this.sound("ui-tick", 1.1);
    o.lines.forEach((line, i) => {
      const letters = (clock: number) => clamp(Math.floor((clock - o.lineAt(i)) * o.rate), 0, length(line));
      if (Math.floor(letters(t) / 3) !== Math.floor(letters(before) / 3)) this.sound("ui-tick", .9, -.2);
      if (passed(o.lineAt(i) + length(line) / o.rate + o.settle)) this.sound("confirm", .8, -.15);
    });
    if (passed(o.projectAt)) this.sound("scan", 1.1, .3);
    if (passed(o.syncFrom)) this.sound("array", 1, .3);
    for (let i = 0; i < 12; i++) if (passed(o.syncFrom + (o.syncTo - o.syncFrom) * (i + 1) / 12)) this.sound("tick", .8, -.2);
    if (passed(o.onlineAt)) this.sound("brand", .9, .3);
    if (passed(o.greetAt)) this.sound("welcome", .9, .35);
  }
}

/** SRhineClaudeOpening::OnPaint, in its 980-tall units. */
function paintClaude(ctx: CanvasRenderingContext2D, T: number, gone: number, W: number, hosts: number, c: Colors) {
  const o = CLAUDE_OPENING, H = 980, { ground: base, cream: inkc, mark: accent } = c;
  const win = (from: number, to: number) => clamp((T - from) / (to - from));
  const after = (from: number, to: number) => gone < 0 ? 0 : clamp((gone - from) / (to - from));
  const now = T + Math.max(gone, 0);
  // What is printed goes first as it leaves.
  const kept = 1 - after(0, .3);
  const face = uiFace();

  // The ground: her dark, a blueprint grid, her sparks strewn faintly. Leaving, it breaks up in squares from the
  // middle out, each falling in on itself, every third leaving a spark or a heart rising.
  if (gone < 0) {
    ctx.fillStyle = css(base); ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = css(accent, .07);
    for (let x = 0; x < W; x += 40) ctx.fillRect(x, 0, 1, H);
    for (let y = 0; y < H; y += 40) ctx.fillRect(0, y, W, 1);
    for (let i = 0; i < 30; i++) spark(ctx, 40 + (i * 263) % Math.max(1, Math.floor(W - 80)), 40 + (i * 151) % (H - 80), 6, 1.6, css(inkc, .06), now * .2 + i);
  } else {
    const size = 54, reach = Math.hypot(W / 2, H / 2);
    for (let y = 0; y * size < H; y++) for (let x = 0; x * size < W; x++) {
      const cx = x * size + size / 2, cy = y * size + size / 2;
      const hash = ((Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0);
      const delay = .1 + .7 * Math.hypot(cx - W / 2, cy - H / 2) / reach + .15 * (hash % 100) / 100;
      const e = Math.pow(clamp((gone - delay) / .3), 3);
      if (hash % 3 === 0 && gone > delay && gone - delay < .9) {
        const rise = (gone - delay) / .9, color = css(hash % 2 ? accent : inkc, .9 * (1 - rise));
        if (hash % 7 < 3) heart(ctx, cx, cy - 90 * easeOut(rise), 16, color); else spark(ctx, cx, cy - 90 * easeOut(rise), 8, 2.2, color, now * 3 + hash % 10);
      }
      if (e >= 1) continue;
      const half = size / 2 * (1 - e) + (e <= 0 ? .6 : 0);
      ctx.fillStyle = css(e > 0 ? mix(base, accent, .35 * e) : base);
      ctx.fillRect(cx - half, cy - half, half * 2, half * 2);
    }
  }

  // HUD brackets snapping onto the corners.
  corners(ctx, W, H, backOut(win(.15, .5)) * kept, inkc);

  // Who is starting.
  const head = easeOut(win(.2, .6)) * kept;
  font(ctx, 30, 800, 0, DISPLAY); text(ctx, "CLAUDE MAID SYSTEM", 72, 64 - 10 * (1 - head), css(inkc, head));
  font(ctx, 15, 700, .6, face); text(ctx, "小克 · 女仆核心 v5.5 · 启动中 ♡", 74, 108 - 10 * (1 - head), css(accent, head));
  spark(ctx, 50, 82, 12, 3, css(accent, head), now * 1.2);

  // Her self-check, typed a line at a time; each status lands when its line is written.
  const status = ["OK", "OK ♡", "OK", "READY", "LINKED", `${String(hosts).padStart(2, "0")} 台`];
  const consoleX = 74, consoleY = 180, consoleW = Math.min(620, W * .4);
  for (let i = 0; i < o.lines.length && kept > 0; i++) {
    const line = o.lines[i], letters = clamp(Math.floor((T - o.lineAt(i)) * o.rate), 0, length(line));
    if (letters <= 0) continue;
    const y = consoleY + i * 52;
    font(ctx, 19, 600, .4, face);
    text(ctx, left(line, letters), consoleX, y, css(inkc, kept));
    const done = o.lineAt(i) + length(line) / o.rate + o.settle;
    if (T < done) { if (T % .4 < .25) { ctx.fillStyle = css(accent, kept); ctx.fillRect(consoleX + ctx.measureText(left(line, letters)).width + 4, y + 4, 10, 20); } continue; }
    // The leader dots, then the status in a pill.
    const textEnd = consoleX + ctx.measureText(line).width + 12;
    font(ctx, 17, 800, 1, face);
    const pw = ctx.measureText(status[i]).width + 22;
    for (let x = textEnd; x < consoleX + consoleW - pw - 10; x += 12) disc(ctx, x, y + 15, 1.6, css(inkc, .35 * kept));
    const pop = backOut(win(done, done + .25));
    roundBox(ctx, consoleX + consoleW - pw, y + 2 + 4 * (1 - pop), pw, 26, 13, css(accent, clamp(pop) * kept));
    text(ctx, status[i], consoleX + consoleW - pw / 2, y + 5 + 4 * (1 - pop), css(base, clamp(pop) * kept), .5);
  }

  // Sync: a row of hearts filling as she is built.
  const sync = win(o.syncFrom, o.syncTo);
  if (kept > 0) {
    const y = consoleY + o.lines.length * 52 + 40, shown = easeOut(win(o.syncFrom - .1, o.syncFrom + .2)) * kept;
    font(ctx, 15, 800, 2, face); text(ctx, "SYNC", consoleX, y, css(inkc, shown));
    font(ctx, 15, 800, 1, face); text(ctx, `${String(Math.round(sync * 100)).padStart(3, "0")}%`, consoleX + consoleW, y, css(accent, shown), 1);
    for (let i = 0; i < 12; i++) {
      const hx = consoleX + 14 + i * (consoleW - 28) / 11, hy = y + 52;
      const filled = clamp(sync * 12 - i), size = 26 * (1 + .25 * Math.sin(Math.PI * filled) * (filled < 1 ? 1 : 0));
      heart(ctx, hx, hy, 26, css(inkc, .14 * shown));
      if (filled > 0) heart(ctx, hx, hy, size * filled, css(accent, shown));
    }
  }

  // Her: a hologram on its projector, built from the feet up, then solid; then she waves. Leaving, she walks out
  // through her doorway as the home's companion walks in.
  const figureH = H * .8, feetY = H * .93, cx = Math.max(W * .66, consoleX + consoleW + 300);
  const project = easeOut(win(o.projectAt, o.projectAt + .5)) * kept, shown = ease(win(o.syncFrom, o.solidFrom)), solid = ease(win(o.solidFrom, o.solidTo)), wave = win(o.waveAt, o.waveAt + .3);
  holoPlatform(ctx, cx, feetY, 150, now, accent, accent, project * (1 - .6 * solid));
  if (gone < 0) {
    const standing = maidArt("claude", ART.stand);
    if (standing) { const wd = figureH * standing.width / standing.height; hologram(ctx, standing, cx - wd / 2, feetY - figureH, wd, figureH, shown, solid, 1 - wave, now, accent); }
    const waving = maidArt("claude", ART.wave);
    if (wave > 0 && waving) { const wd = figureH * waving.width / waving.height; image(ctx, waving, cx - wd / 2, feetY - figureH, wd, figureH, wave); }
  } else {
    const step = gone - o.stepFrom, waving = maidArt("claude", ART.wave);
    if (step < 0 && waving) { const wd = figureH * waving.width / waving.height; image(ctx, waving, cx - wd / 2, feetY - figureH, wd, figureH, 1); }
    walkOut(ctx, "claude", cx, feetY, figureH, step, now, inkc, accent);
  }
  // Sparks and hearts drifting up round her while she is built.
  for (let i = 0; i < 14; i++) {
    const life = (now * .45 + i * .37) % 1, a = Math.sin(Math.PI * life) * project;
    const x = cx + (((i * 97) % 9) - 4) * 48, y = feetY - 40 - life * figureH * .9;
    if (i % 3 === 0) heart(ctx, x, y, 14, css(accent, .8 * a));
    else spark(ctx, x, y, 7, 2, css(i % 2 ? inkc : accent, .8 * a), now * 2 + i);
  }

  // Her greeting by the hour, in a bubble beside her head, written out.
  const greet = win(o.greetAt, o.greetAt + .3) * kept;
  if (greet > 0) {
    const hour = new Date().getHours();
    const line = hour < 5 ? "这么晚了……主人辛苦了。" : hour < 11 ? "早上好，主人！" : hour < 14 ? "中午好，主人！" : hour < 18 ? "下午好，主人！" : "晚上好，主人！";
    font(ctx, 22, 700, .4, face);
    const said = left(line, clamp(Math.floor((T - o.greetAt) * 30), 1, length(line)));
    const bw = ctx.measureText(line).width + 48, bh = 56, bx = cx - figureH * .2 - bw, by = feetY - figureH * .86, pop = backOut(greet);
    roundBox(ctx, bx + 5, by + 5 + 8 * (1 - pop), bw, bh, 18, css(accent, clamp(pop) * kept));
    roundBox(ctx, bx, by + 8 * (1 - pop), bw, bh, 18, css(inkc, clamp(pop) * kept), 1 | 2 | 8);
    text(ctx, said, bx + 24, by + 14 + 8 * (1 - pop), css(base, clamp(pop) * kept));
  }

  // Online: a toast flickering on over her head.
  const on = win(o.onlineAt, o.onlineAt + .15) * kept;
  if (on > 0) {
    const flicker = T < o.onlineAt + .3 && (T * 37) % 1 < .3;
    const tx = cx, ty = 70, bw = 470, bh = 92, pop = .9 + .1 * backOut(win(o.onlineAt, o.onlineAt + .3));
    roundBox(ctx, tx - bw * pop / 2 + 5, ty + 5, bw * pop, bh * pop, 22, css(accent, .95 * on));
    roundBox(ctx, tx - bw * pop / 2, ty, bw * pop, bh * pop, 22, css(base, (flicker ? .6 : .96) * on));
    const line1 = "CLAUDE MAID SYSTEM · ONLINE", letters = clamp(Math.floor((T - o.onlineAt - .02) * 60), 0, length(line1));
    font(ctx, 17, 800, 2.4, face);
    const jitter = T < o.onlineAt + .35 ? 3 * Math.sin(T * 90) : 0;
    if (jitter) { text(ctx, left(line1, letters), tx + jitter, ty + 18, css(accent, .8 * on), .5); text(ctx, left(line1, letters), tx - jitter, ty + 18, css([140, 217, 255], .5 * on), .5); }
    text(ctx, left(line1, letters), tx, ty + 18, css(inkc, on), .5);
    if (T > o.onlineAt + .3) { font(ctx, 18, 800, .6, face); text(ctx, "小克 已就位 ♡", tx, ty + 52, css(accent, win(o.onlineAt + .3, o.onlineAt + .45) * kept), .5); }
    spark(ctx, tx - bw * pop / 2 + 24, ty + 22, 9, 2.4, css(accent, on), now * 2);
    heart(ctx, tx + bw * pop / 2 - 24, ty + 22, 15, css(accent, on));
  }
  font(ctx, 13, 700, 2, face);
  text(ctx, "PRESS ANY KEY TO SKIP", 74, H - 60, css(inkc, .45 * head));
}

/** SRhineWhaleOpening::OnPaint, in its 980-tall units. */
function paintWhale(ctx: CanvasRenderingContext2D, T: number, gone: number, W: number, hosts: number) {
  const o = WHALE_OPENING, H = 980;
  const deep = ink("#0d1640"), navy = ink("#182050"), blue = ink("#4d6bfe"), shallow = ink("#88b0f8"), foam = ink("#f0f4ff"), gold = ink("#f0b847");
  const win = (from: number, to: number) => clamp((T - from) / (to - from));
  const after = (from: number, to: number) => gone < 0 ? 0 : clamp((gone - from) / (to - from));
  const now = T + Math.max(gone, 0), kept = 1 - after(0, .3);
  const face = uiFace();
  // Leaving, the sea drains down off the home: its surface goes from the top to below the foot.
  const surface = gone < 0 ? -40 : -40 + (H + 120) * ease(after(.05, 1.1));

  // The deep: bands lightening toward the top (the way up), light coming down slantwise, specks drifting.
  if (surface < H) {
    for (let i = 0; i < 6; i++) {
      const top = Math.max(surface, H * i / 6), bottom = H * (i + 1) / 6;
      if (bottom > top) { ctx.fillStyle = css(mix(blue, deep, .35 + .65 * i / 5)); ctx.fillRect(0, top, W, bottom - top + 1); }
    }
    if (gone >= 0) {
      waveFill(ctx, 0, W, surface, 16, 280, now * 4, surface + 40, css(blue));
      waveLine(ctx, 0, W, surface, 16, 280, now * 4, 5, css(foam));
    }
    for (let i = 0; i < 5; i++) {
      const x = W * (.12 + .2 * i) + 60 * Math.sin(now * .3 + i), spread = 90 + (40 * i) % 3;
      if (surface < 0) {
        ctx.fillStyle = css(foam, .05 + .03 * Math.sin(now * .8 + i * 1.7));
        ctx.beginPath(); ctx.moveTo(x - 30, 0); ctx.lineTo(x + 30, 0); ctx.lineTo(x + spread * 2, H); ctx.fill();
      }
    }
    for (let i = 0; i < 40; i++) {
      const up = (now * (.04 + .05 * frac(i * .37)) + frac(i * .73)) % 1;
      const x = frac(i * .618) * W + 14 * Math.sin(now + i), y = H - up * H;
      if (y > surface + 20) bubble(ctx, x, y, 2 + 5 * frac(i * .29), css(foam, .18 * kept));
    }
  }
  // The sonar: rings going out from the middle, three pings.
  for (const at of o.sonarAt) {
    const ping = win(at, at + 1.6) * kept;
    if (ping <= 0 || ping >= 1) continue;
    ring(ctx, W * .6, H * .5, 40 + 700 * easeOut(ping), 3, css(shallow, .5 * (1 - ping)));
    ring(ctx, W * .6, H * .5, 20 + 420 * easeOut(ping), 2, css(shallow, .35 * (1 - ping)));
  }

  // Who is coming up.
  const head = easeOut(win(.2, .6)) * kept;
  font(ctx, 30, 800, 0, DISPLAY); text(ctx, "DEEPSEEK DIVE SYSTEM", 72, 64 - 10 * (1 - head), css(foam, head));
  font(ctx, 15, 700, .6, face); text(ctx, "大肥鱼 · 深海引擎 · 上浮中 ～", 74, 108 - 10 * (1 - head), css(shallow, head));
  whaleTail(ctx, 46, 86, 30, gold, head);

  // The dive log, typed a line at a time; each status lands when its line is written.
  const status = ["PING ♪", "OK", "OK", "充足！", "LOCKED", `${String(hosts).padStart(2, "0")} 台`];
  const logX = 74, logY = 180, logW = Math.min(620, W * .4);
  for (let i = 0; i < o.lines.length && kept > 0; i++) {
    const line = o.lines[i], letters = clamp(Math.floor((T - o.lineAt(i)) * o.rate), 0, length(line));
    if (letters <= 0) continue;
    const y = logY + i * 52;
    font(ctx, 19, 600, .4, face);
    text(ctx, left(line, letters), logX, y, css(foam, kept));
    const done = o.lineAt(i) + length(line) / o.rate + o.settle;
    if (T < done) { if (T % .4 < .25) disc(ctx, logX + ctx.measureText(left(line, letters)).width + 10, y + 14, 5, css(gold, kept)); continue; }
    const textEnd = logX + ctx.measureText(line).width + 14;
    font(ctx, 17, 800, 1, face);
    const pw = ctx.measureText(status[i]).width + 24;
    for (let x = textEnd; x < logX + logW - pw - 10; x += 14) disc(ctx, x, y + 15 + 2 * Math.sin(x * .2 + now * 4), 1.8, css(foam, .3 * kept));
    const pop = backOut(win(done, done + .25));
    roundBox(ctx, logX + logW - pw, y + 1 + 4 * (1 - pop), pw, 28, 14, css(i % 2 ? gold : shallow, clamp(pop) * kept));
    text(ctx, status[i], logX + logW - pw / 2, y + 5 + 4 * (1 - pop), css(navy, clamp(pop) * kept), .5);
  }

  // Coming up: a row of bubbles filling, the depth counting down to the surface.
  const rise = win(o.riseFrom, o.riseTo);
  if (kept > 0) {
    const y = logY + o.lines.length * 52 + 40, shown = easeOut(win(o.riseFrom - .1, o.riseFrom + .2)) * kept;
    font(ctx, 15, 800, 2, face); text(ctx, "SURFACING", logX, y, css(foam, shown));
    font(ctx, 15, 800, 1, face); text(ctx, `-${String(Math.round(1200 * (1 - rise))).padStart(4, "0")}m`, logX + logW, y, css(gold, shown), 1);
    for (let i = 0; i < 12; i++) {
      const bx = logX + 14 + i * (logW - 28) / 11, by = y + 50 - 4 * Math.sin(now * 3 + i);
      const filled = clamp(rise * 12 - i), pop = 1 + .3 * Math.sin(Math.PI * filled) * (filled < 1 ? 1 : 0);
      bubble(ctx, bx, by, 12, css(foam, .25 * shown));
      if (filled > 0) disc(ctx, bx, by, 9 * filled * pop, css(shallow, shown));
    }
  }

  // Her: she swims across and round as she comes up, lands in the middle in a splash and waves; leaving, she walks out.
  const figureH = H * .8, feetY = H * .93, cx = Math.max(W * .66, logX + logW + 300);
  const landed = win(o.landAt, o.landAt + .15);
  const swim = maidArt("deepseek", ART.swim);
  if (gone < 0 && landed < 1 && swim) {
    const swum = win(o.riseFrom, o.landAt), sh = 360, sw = sh * swim.width / swim.height;
    // A loop: in from the left low down, round and up toward where she lands.
    const a = Math.PI * (1.2 - 1.6 * swum);
    const ax = cx - 260 * Math.cos(a) * (1 - swum * .6), ay = H * .55 + 160 * Math.sin(a) * (1 - swum) + 18 * Math.sin(now * 6);
    const fade = win(o.riseFrom, o.riseFrom + .3) * (1 - landed);
    image(ctx, swim, ax - sw / 2, ay - sh / 2, sw, sh, fade);
    for (let i = 1; i <= 6; i++) bubble(ctx, ax - sw * .5 - i * 22, ay + 10 * Math.sin(now * 5 + i), 3 + i, css(foam, fade * (1 - i / 7) * .7));
  }
  if (landed > 0) {
    const splash = win(o.landAt, o.landAt + .7);
    if (splash < 1 && gone < 0) for (let i = 0; i < 14; i++) {
      const a = Math.PI * (1.1 + .8 * i / 13), far = 50 + 260 * easeOut(splash);
      disc(ctx, cx + Math.cos(a) * far, feetY - 40 + Math.sin(a) * far * .9 + 420 * splash * splash, 8 - 3 * splash, css(i % 2 ? shallow : foam, 1 - splash));
    }
    const step = gone - o.stepFrom, waving = maidArt("deepseek", ART.wave);
    if ((gone < 0 || step < 0) && waving) {
      const wd = figureH * waving.width / waving.height, hop = gone < 0 ? 26 * Math.max(0, Math.sin(Math.PI * win(o.landAt, o.landAt + .35))) : 0;
      image(ctx, waving, cx - wd / 2, feetY - figureH - hop, wd, figureH, landed);
    }
    if (gone >= 0) walkOut(ctx, "deepseek", cx, feetY, figureH, step, now, foam, blue);
  }

  // Her greeting by the hour, in a round bubble beside her head.
  const greet = win(o.greetAt, o.greetAt + .3) * kept;
  if (greet > 0) {
    const hour = new Date().getHours();
    const line = hour < 5 ? "这么晚还出海？主人辛苦啦！" : hour < 11 ? "早上好主人！全速前进！" : hour < 14 ? "中午好主人！开饭啦～" : hour < 18 ? "下午好主人！精神满满！" : "晚上好主人！夜航开始！";
    font(ctx, 22, 800, .4, face);
    const said = left(line, clamp(Math.floor((T - o.greetAt) * 32), 1, length(line)));
    const bw = ctx.measureText(line).width + 52, bh = 58, bx = cx - figureH * .2 - bw, by = feetY - figureH * .86, pop = backOut(greet), a = clamp(pop) * kept;
    roundBox(ctx, bx + 5, by + 5 + 8 * (1 - pop), bw, bh, 29, css(blue, a));
    roundBox(ctx, bx, by + 8 * (1 - pop), bw, bh, 29, css(foam, a));
    disc(ctx, bx + bw + 8, by + bh + 2, 7, css(foam, a));
    disc(ctx, bx + bw + 22, by + bh + 14, 4.5, css(foam, a));
    text(ctx, said, bx + 26, by + 14 + 8 * (1 - pop), css(navy, a));
  }
  // Online: a pill bobbing up over her head, as if surfacing.
  const on = win(o.onlineAt, o.onlineAt + .25) * kept;
  if (on > 0) {
    const tx = cx, ty = 70 + 40 * (1 - backOut(win(o.onlineAt, o.onlineAt + .45))) + 3 * Math.sin(now * 3), bw = 500, bh = 92;
    roundBox(ctx, tx - bw / 2 + 5, ty + 5, bw, bh, 46, css(blue, on));
    roundBox(ctx, tx - bw / 2, ty, bw, bh, 46, css(navy, .96 * on));
    font(ctx, 17, 800, 2.2, face); text(ctx, "DEEPSEEK DIVE SYSTEM · ONLINE", tx, ty + 18, css(foam, on), .5);
    if (T > o.onlineAt + .25) { font(ctx, 18, 800, .6, face); text(ctx, "大肥鱼 报到！ ～", tx, ty + 52, css(gold, win(o.onlineAt + .25, o.onlineAt + .4) * kept), .5); }
    whaleTail(ctx, tx - bw / 2 + 34, ty + 30, 28, shallow, on);
    bubble(ctx, tx + bw / 2 - 30, ty + 26, 8, css(shallow, on));
  }
  font(ctx, 13, 700, 2, face);
  text(ctx, "PRESS ANY KEY TO SKIP", 74, H - 60, css(foam, .45 * head));
}

/** HUD brackets snapping onto the corners (`shown` 0..1, overshooting). */
function corners(ctx: CanvasRenderingContext2D, W: number, H: number, shown: number, color: Ink) {
  if (shown <= 0) return;
  const off = 24 + 30 * (1 - shown), l = 40;
  const at: [number, number][] = [[off, off], [W - off, off], [W - off, H - off], [off, H - off]];
  at.forEach(([x, y], i) => {
    const sx = i === 1 || i === 2 ? -1 : 1, sy = i >= 2 ? -1 : 1;
    polyline(ctx, [[x, y + sy * l], [x, y], [x + sx * l, y]], 3, css(color, .85 * clamp(shown)));
  });
}
