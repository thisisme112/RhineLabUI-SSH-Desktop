import type { Mascot } from "../theme/theme-design";
import { ART, maidArt, maidFace } from "./maid-art";
import {
  DISPLAY, WALK_TIME, clamp, css, disc, ease, easeOut, font, image, polyline, puppet, roundBox, scallops, spark, text,
  triangle, twinkle, walkIn, waveFill, waveLine, type Ink,
} from "./maid-draw";
import { LOOK_COUNT, lookArt, lookName, patLine, pick, uiFace, wrap } from "./maid-lines";
import { maidPrefs, setMaidPrefs } from "./maid-prefs";
import { StageCanvas } from "./stage-canvas";
import "./maid.css";

/**
 * The maid in the terminal (the Unreal build's SRhineClaudeTerminalDecor and SRhineClaudeTouch): lace (her sea) under
 * the bar, and she in the corner of the screen. Until the shell is up she stands tall at the right and says how the
 * connection goes; at work she sits small in the corner as the reader chose (her bust or one picture), says her own
 * lines (a reminder every half hour, a welcome back after three quiet minutes) and, with reacting on, takes the pose
 * of the moment. A click pats her, a right click sends her under the status line and back, the wheel over her changes
 * how she looks, and the pointer resting on her for a second and a half makes her faint.
 *
 * Drawn on the app's frame (MaidTerminal.frame) for every terminal that is on screen, on a canvas only as large as
 * her corner; the lace on its own strip.
 */
export type MaidTerminalState = {
  /** The shell is not up yet. */
  waiting: boolean;
  /** Bytes are moving either way. */
  busy: boolean;
  /** Minutes the session has run. */
  minutes: number;
  /** The session's phase (session.ts SshPhase), a question waiting for the reader, the reader's own stop. */
  phase: string;
  prompt: boolean;
  stopped: boolean;
};
/** What her assistant adds (desktop): its line over the state's and how long it stays, her face, her mouth moving, her panel open. */
export type MaidAssistantState = { line?: string; hold?: number; face?: number; mood?: number; moodAt?: number; talking?: boolean; away?: boolean };
export type MaidShared = { who: Mascot | undefined; time: number; stepIn: number; colors: { ink: Ink; paper: Ink; accent: Ink } };

type Hooks = { visible(): boolean; state(): MaidTerminalState; assistant?(): MaidAssistantState };

const all = new Set<MaidTerminal>();
const query = new URLSearchParams(location.search);
/** Her corner's canvas at most: she waiting at full height with her bubble beside her. */
const CORNER = [980, 720] as const;

export class MaidTerminal {
  private lace = new StageCanvas("maid-terminal-lace");
  private her = new StageCanvas("maid-terminal-her");
  private touch = document.createElement("div");
  private size: [number, number] = [0, 0];
  private observer: ResizeObserver;
  private laceKey = "";
  private drawn = false;
  private touchKey = "";

  private now = 0;
  private last = 0;
  private poseNow = -1;
  private posePrev = -1;
  private lookSeen = -1;
  private reactSeen = true;
  private poseAt = -100;
  private shown = "";
  private own = "";
  private lines: string[] = [];
  private shownAt = -100;
  private faint = 0;
  private ownUntil = -1;
  private quietSince = -1;
  private patAt = -100;
  private hoverAt = -1;
  private down = 0;
  private workAt = -1;
  private reminded = 0;
  private pats = 0;
  private turn = 0;
  private ownShown = false;
  private away = false;
  private ducked = false;
  private hover = false;
  private who: Mascot = "claude";
  /** ?maid-pat=N: N pats a moment after the shell is up; ?maid-tuck: she ducks then. */
  private scripted = query.has("maid-tuck") ? -2 : Number(query.get("maid-pat") ?? 0) || 0;

  constructor(private host: HTMLElement, private hooks: Hooks) {
    this.touch.className = "maid-terminal-touch";
    this.touch.hidden = true;
    host.append(this.lace.el, this.her.el, this.touch);
    this.observer = new ResizeObserver(([entry]) => { this.size = [Math.round(entry.contentRect.width), Math.round(entry.contentRect.height)]; });
    this.observer.observe(host);
    this.touch.addEventListener("pointerdown", event => {
      if (event.button === 0) { event.preventDefault(); this.pat(); MaidTerminal.sound("pat"); }
      else if (event.button === 2) { event.preventDefault(); this.duck(); }
    });
    this.touch.addEventListener("contextmenu", event => event.preventDefault());
    this.touch.addEventListener("pointerenter", () => this.setHover(true));
    this.touch.addEventListener("pointerleave", () => this.setHover(false));
    // The wheel over her changes how she looks (as 设置 does).
    this.touch.addEventListener("wheel", event => {
      event.preventDefault();
      const look = ((maidPrefs.look + (event.deltaY > 0 ? 1 : -1)) % LOOK_COUNT + LOOK_COUNT) % LOOK_COUNT;
      setMaidPrefs({ look });
      this.notice(`换成「${lookName(this.who, look)}」啦～`);
      MaidTerminal.sound("look");
    }, { passive: false });
    all.add(this);
  }

  /** The app's sounds for a pat and a new look. */
  static sound: (cue: "pat" | "look") => void = () => {};

  /** Every terminal's maid, once a frame. */
  static frame(shared: MaidShared) {
    for (const maid of all) maid.paint(shared);
  }

  dispose() {
    all.delete(this);
    this.observer.disconnect();
    this.lace.el.remove(); this.her.el.remove(); this.touch.remove();
  }

  notice(line: string) { this.say(line, 2.5); }
  private say(line: string, seconds: number) { this.own = line; this.ownUntil = this.now + seconds; }

  private pat() {
    // A pat wakes her if she had nodded off; a click brings her back up first.
    this.quietSince = this.now; this.away = false;
    if (this.ducked) { this.duck(); return; }
    if (this.now - this.patAt > 20) this.pats = 0;
    this.pats++;
    this.patAt = this.now;
    this.hoverAt = this.now;
    this.say(patLine(this.who, this.pats, this.turn++), 4);
  }

  private duck() {
    this.ducked = !this.ducked;
    this.hoverAt = this.now;
    this.say(this.ducked ? pick(this.who, "那我先退下，有事点我。", "那我先潜下去啦，有事叫我！") : pick(this.who, "我回来了，主人。", "我浮上来啦，主人！"), 3);
  }

  private setHover(on: boolean) { this.hover = on; this.hoverAt = on ? this.now : -1; if (on) { this.quietSince = this.now; this.away = false; } }

  private hide() {
    if (!this.drawn) return;
    this.drawn = false;
    this.lace.clear(); this.her.clear();
    this.laceKey = "";
    this.setTouch(0, 0);
  }

  private setTouch(w: number, h: number) {
    const key = w > 0 ? `${Math.round(w)}x${Math.round(h)}` : "";
    if (key === this.touchKey) return;
    this.touchKey = key;
    this.touch.hidden = !key;
    if (key) { this.touch.style.width = `${Math.round(w)}px`; this.touch.style.height = `${Math.round(h)}px`; }
  }

  private paint(shared: MaidShared) {
    const who = shared.who, [sw, sh] = this.size;
    if (!who || sw < 240 || sh < 160 || !this.hooks.visible()) { this.hide(); return; }
    this.drawn = true;
    this.who = who;
    const now = this.now = shared.time, k = devicePixelRatio;
    const dt = clamp(now - this.last, 0, .1);
    this.last = now;
    const { ink: cream, paper: cocoa, accent: mark } = shared.colors;

    // Lace under the bar: a cream edge and its scallops, five units into the screen. Hers is a wave rolling along.
    const laceKey = `${who}|${sw}|${k}|${cream}`;
    if (who === "deepseek" || laceKey !== this.laceKey) {
      this.laceKey = laceKey;
      const ctx = this.lace.begin(sw, 12, k);
      if (who === "deepseek") {
        waveFill(ctx, 0, sw, 5, 2.5, 34, now * 1.4, 0, css(mark, .9));
        waveLine(ctx, 0, sw, 9, 2, 34, now * 1.4 + 1.2, 1.6, css(mark, .35));
      } else {
        ctx.fillStyle = css(cream, .85); ctx.fillRect(0, 0, sw, 3);
        ctx.save(); ctx.beginPath(); ctx.rect(0, 3, sw, 5); ctx.clip();
        scallops(ctx, 0, 3, sw, 3, 10, css(cream, .85));
        ctx.restore();
      }
    }

    const st = this.hooks.state(), helper = this.hooks.assistant?.() ?? {};
    const waiting = st.waiting;
    // At work she is as the reader chose (her bust, or one picture); waiting she stands at full height.
    const chosen = clamp(maidPrefs.look, 0, LOOK_COUNT - 1), reacts = maidPrefs.reacts;
    // Another look (or her reacting turned on or off) wakes her: the reader wants to see the new one.
    if (chosen !== this.lookSeen || reacts !== this.reactSeen) { if (this.lookSeen >= 0) { this.quietSince = now; this.away = false; } this.lookSeen = chosen; this.reactSeen = reacts; }
    const bust = !waiting && chosen === 0 && maidFace(who, 0) !== undefined;
    let pose = waiting ? ART.stand : chosen >= 1 ? lookArt(chosen) : ART.lean;
    const face = helper.face ?? 0;
    if (!waiting && chosen >= 1 && reacts) {
      // A picture reacting gives way to the pose of the moment and comes back after: cross after too many pats,
      // cheering just patted, dozing left alone, bowing as the shell comes up, then by her face: mending while she
      // thinks or something went wrong, celebrating, cheering, nodding off, bowing shyly, waving surprised.
      const patted = now - this.patAt;
      const moment = patted < 2.4 && this.pats >= 6 ? ART.angry : patted < 1.8 ? ART.cheer : this.away ? ART.doze : this.workAt >= 0 && now - this.workAt < 2.5 ? ART.bow
        : face === 6 || face === 2 ? ART.fix : face === 1 ? ART.celebrate : face === 4 ? ART.cheer : face === 5 ? ART.doze : face === 7 ? ART.bow : face === 3 ? ART.wave : -1;
      if (moment >= 0) pose = moment;
    }
    if (!bust && !maidArt(who, pose)) pose = waiting ? ART.stand : ART.lean;
    if (pose !== this.poseNow) { this.posePrev = this.poseNow; this.poseNow = pose; this.poseAt = now; }
    const art = bust ? maidFace(who, 0) : maidArt(who, pose);
    const cw = Math.min(sw, CORNER[0]), ch = Math.min(sh, CORNER[1]);
    if (helper.away || !art) { this.her.clear(); this.setTouch(0, 0); return; }
    const ctx = this.her.begin(cw, ch, k);
    // The corner's canvas lies at the screen's bottom right: draw in the screen's units.
    ctx.translate(cw - sw, ch - sh);

    // Her walk in at the end of an entrance, at full height in the corner; hidden before it.
    const step = shared.stepIn;
    if (!waiting && step < WALK_TIME + .4) {
      const tall = clamp(sh * .36, 160, 280), stride = maidArt(who, ART.walk1);
      const wd = stride ? tall * stride.width / stride.height : tall * .7;
      walkIn(ctx, who, sw - 16 - wd / 2, sh + 2, tall, step, now, cream, mark);
      if (step < WALK_TIME) { this.setTouch(0, 0); return; }
    }
    // Lines of her own at work: a reminder every half hour of the session, and a welcome when the reader types again after three quiet minutes.
    const busy = st.busy;
    if (!waiting) {
      if (this.workAt < 0) this.workAt = now;
      const half = Math.floor(st.minutes / 30);
      if (half > this.reminded) this.say(who === "deepseek" ? `已经连着 ${half * 30} 分钟啦，主人喝口水、伸个懒腰！` : `已经连着 ${half * 30} 分钟了，主人喝口水吧。`, 6);
      this.reminded = half;
      if (this.quietSince < 0 || busy) { if (this.away && busy) this.say(pick(who, "欢迎回来，主人。", "主人回来啦！"), 4); this.away = false; this.quietSince = now; }
      else if (now - this.quietSince > 180) this.away = true;
      if (this.scripted !== 0 && now - this.workAt > .4) {
        if (this.scripted === -2) this.duck(); else for (let i = 0; i < this.scripted; i++) this.pat();
        this.scripted = 0;
      }
    } else { this.reminded = 0; this.quietSince = -1; this.away = false; this.ducked = false; this.workAt = -1; }
    const own = now < this.ownUntil;
    const whole = own ? this.own : helper.line ?? stateLine(who, st);
    // Back from a line of her own, the state's line is not said over again.
    font(ctx, waiting ? 17 : 14, 600, .4, uiFace());
    if (whole !== this.shown) { this.shownAt = this.ownShown && !own ? now - 1000 : now; this.shown = whole; this.lines = wrap(ctx, whole, waiting ? 380 : 320, 7); }
    this.ownShown = own;
    // Waiting she stands tall at the right; at work she sits small in the corner. Patted she is pressed down and
    // springs up; ducked she is two thirds under the status line.
    const patT = now - this.patAt, press = !waiting && patT < .22 ? Math.sin(Math.PI * patT / .22) : 0;
    const spring = !waiting && patT >= .12 && patT < .6 ? Math.sin(Math.PI * (patT - .12) / .48) : 0;
    this.down = clamp(this.down + (this.ducked && !waiting ? 1 : -1) * dt / .28);
    // Her whole figure stands taller in the corner than the leaning cut-out sits (that one keeps its size).
    const full = waiting ? Math.min(sh * .88, 600) : bust ? clamp(sh * .3, 150, 230) : pose === ART.lean || pose === ART.lookout ? clamp(sh * .24, 110, 180)
      : pose === ART.doze ? clamp(sh * .26, 120, 200) : clamp(sh * .36, 160, 280);
    const high = full * (1 - .07 * press), wide = full * art.width / art.height * (1 + .04 * press);
    const under = full * .68 * ease(this.down);
    // A mood (its cue) moves her for its first moments: a start, a shiver, a bounce, a nod off.
    const cue = waiting || this.ducked || !reacts ? 0 : helper.mood ?? 0;
    const felt = now - (helper.moodAt ?? -100);
    let mx = 0, my = 0;
    if (cue > 0 && felt >= 0 && felt < 2.6) {
      if (cue === 3) my = -14 * Math.sin(Math.PI * Math.min(felt / .35, 1));
      else if (cue === 2) mx = felt < .7 ? 3 * Math.sin(felt * 42) : 0;
      else if (cue === 1 || cue === 4) my = felt < .9 ? -9 * Math.abs(Math.sin(felt * 7)) : 0;
      else if (cue === 5) mx = 3 * Math.sin(felt * 2.2);
      else if (cue === 7) mx = felt < .5 ? 2 * Math.sin(felt * 30) : 0;
    }
    const x = sw - wide - (waiting ? 48 : 16) + mx;
    const y = sh - high + under + my + (waiting ? 0 : 2 * Math.sin(now * 1.7) + (busy ? 2.5 * Math.sin(now * 9) : 0) - 12 * spring);
    if (!waiting) this.setTouch(wide + 16, Math.max(24, full - under)); else this.setTouch(0, 0);
    // The pointer resting on her for a second and a half: she goes faint (a fifth of a second there and back), until it leaves or she is touched.
    const rested = !waiting && this.hover && this.hoverAt >= 0 && now - this.hoverAt > 1.5;
    this.faint = clamp(this.faint + (rested ? 1 : -1) * dt / .2);
    const seen = (waiting ? 1 : .94) + (.12 - (waiting ? 1 : .94)) * this.faint;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, sw, sh); ctx.clip();
    // Not reacting, the bust keeps her own face (she still blinks, and her mouth moves as she speaks).
    if (bust) puppet(ctx, who, x, y, wide, reacts ? face : 0, helper.talking ?? false, now, seen);
    else {
      // A new pose crosses over the old in a quarter of a second, each standing on the same ground at the right.
      const cross = clamp((now - this.poseAt) / .25), before = this.posePrev >= 0 && this.posePrev !== this.poseNow ? maidArt(who, this.posePrev) : undefined;
      if (cross < 1 && before) { const bw = high * before.width / before.height; image(ctx, before, x + wide - bw, y, bw, high, seen * (1 - cross)); }
      image(ctx, art as ImageBitmap, x, y, wide, high, seen * cross);
    }
    ctx.restore();
    if (patT < .7 && !waiting) {
      const hx = x + wide * .62, hy = y + high * .22;
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI * .5 + (i - 2.5) * .5, far = 20 + 52 * easeOut(patT / .7);
        twinkle(ctx, who, hx + Math.cos(a) * far, hy + Math.sin(a) * far, 6 + 3 * (i % 2), 2.2, css(i % 2 ? cream : mark, 1 - patT / .7), patT * 5 + i);
      }
    }
    // The mood's mark over her head, as a comic draws it: in over a tenth of a second, out over the last four tenths, rising a little.
    if (cue > 0 && felt >= 0 && felt < 2.6) moodMark(ctx, who, cue, felt, x, y, wide, high, seen, cream, mark);
    // Her line: it stays while she waits; at work it is said for its hold (five seconds unless told) after it changes, then goes.
    const since = now - this.shownAt, said = waiting ? 1 : 1 - clamp((since - (helper.hold ?? 5)) / .4);
    if (!this.lines.length || said <= 0) return;
    const pop = easeOut(clamp(since / .25)) * said * (1 - .88 * this.faint);
    font(ctx, waiting ? 17 : 14, 600, .4, uiFace());
    let tw = 0;
    for (const line of this.lines) tw = Math.max(tw, ctx.measureText(line).width);
    const lh = waiting ? 24 : 20, bh = (waiting ? 24 : 18) + lh * this.lines.length, bw = tw + (waiting ? 40 : 30);
    // Ducked, the bubble stays where it would be with her up, so it is not cut off by the status line. At work it
    // stands on one line and a longer answer grows it upward; waiting it hangs from beside her head.
    const top = Math.min(y - under, sh - full) + full * (waiting ? .1 : .16);
    const bx = Math.max(8, x + (waiting ? 40 : 14) - bw), by = (waiting ? top : top + 38 - bh) + 6 * (1 - pop);
    const whale = who === "deepseek";
    roundBox(ctx, bx + 4, by + 4, bw, bh, whale ? 20 : 14, css(mark, pop), whale ? 15 : 1 | 2 | 8);
    roundBox(ctx, bx, by, bw, bh, whale ? 20 : 14, css(cream, pop), whale ? 15 : 1 | 2 | 8);
    if (whale) { disc(ctx, bx + bw + 6, by + bh * .55, 5, css(cream, pop)); disc(ctx, bx + bw + 16, by + bh * .55 + 9, 3.2, css(cream, pop)); }
    let letters = Math.max(1, Math.ceil(since * 40));
    for (let i = 0; i < this.lines.length && letters > 0; letters -= [...this.lines[i++]].length)
      text(ctx, [...this.lines[i]].slice(0, letters).join(""), bx + (waiting ? 20 : 15), by + (waiting ? 13 : 10) + i * lh, css(cocoa, pop));
  }
}

/** What she says of the connection (RhineDeckTerminal.cpp, the maid's Line). */
function stateLine(who: Mascot, st: MaidTerminalState) {
  switch (st.phase) {
    case "interactive": return pick(who, "已接通，主人请吩咐。", "连上啦！主人请下令！");
    case "closed": return pick(who, "会话结束了，主人辛苦了。", "会话结束啦，主人辛苦了！");
    case "failed": return st.stopped ? "已为您断开。" : pick(who, "非常抱歉，没能接通……", "呜……没能连上……");
    default: return st.prompt ? pick(who, "主人，这里需要您来回答。", "主人，这里要你来回答哦！") : pick(who, "正在为您接通，请稍候。", "全速连接中，稍等哦～");
  }
}

function moodMark(ctx: CanvasRenderingContext2D, who: Mascot, cue: number, felt: number, x: number, y: number, wide: number, high: number, seen: number, cream: Ink, mark: Ink) {
  const a = Math.min(1, felt / .12) * Math.min(1, (2.6 - felt) / .4) * seen;
  const ex = x + wide * .64, ey = y + high * .04 - 5 * felt;
  switch (cue) {
    case 1:     // happy: three of her sparks turning about a point
      for (let i = 0; i < 3; i++) { const orbit = felt * 2.4 + i * 2.1; twinkle(ctx, who, ex + 15 * Math.cos(orbit), ey + 9 * Math.sin(orbit), 6 + i, 2.2, css(i === 1 ? cream : mark, a), orbit); }
      break;
    case 2: {   // worried: a drop of sweat beside her head, running down
      const drop = 10 * Math.min(felt / 1.2, 1);
      triangle(ctx, [ex + 20, ey + drop - 9], [ex + 25, ey + drop + 3], [ex + 15, ey + drop + 3], css(cream, a));
      disc(ctx, ex + 20, ey + drop + 4, 5.4, css(cream, a));
      break;
    }
    case 3: {   // surprised: an exclamation mark, struck
      const pop = 1 + .5 * Math.max(0, 1 - felt / .2);
      font(ctx, 30 * pop, 800, 0, DISPLAY);
      text(ctx, "!", ex, ey - 20, css(mark, a), .5);
      for (const side of [-1, 1]) polyline(ctx, [[ex + side * 13, ey - 4], [ex + side * 22, ey - 12]], 2.4, css(cream, a));
      break;
    }
    case 4:     // proud: one large spark and a small one
      spark(ctx, ex, ey - 4, 13, 3.4, css(mark, a), felt * 1.5);
      spark(ctx, ex + 18, ey - 16, 6, 2.2, css(cream, a), -felt * 2);
      break;
    case 5:     // sleepy: Z z z, each smaller and higher, one after another
      for (let i = 0; i < 3; i++) if (felt > i * .3) { font(ctx, 22 - i * 5, 800, 0, DISPLAY); text(ctx, i ? "z" : "Z", ex + i * 11, ey - 10 - i * 9, css(cream, a), .5); }
      break;
    case 6:     // thinking: three dots, one after another
      for (let i = 0; i < 3; i++) if (felt > i * .25) disc(ctx, ex - 12 + i * 12, ey - 4, 3.6, css(cream, a));
      break;
    default:    // shy: three strokes of blush over her cheek
      for (let i = 0; i < 3; i++) polyline(ctx, [[x + wide * .6 + i * 6, y + high * .31], [x + wide * .6 + i * 6 - 4, y + high * .31 + 8]], 2.2, css(mark, a));
      break;
  }
}
