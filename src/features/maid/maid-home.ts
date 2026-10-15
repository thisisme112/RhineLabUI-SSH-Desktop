import "./maid.css";
import type { Mascot } from "../theme/theme-design";
import { ART, maidArt, maidUrl } from "./maid-art";
import {
  DISPLAY, WALK_TIME, clamp, css, disc, easeOut, font, ring, roundBox, scallops, slab, spark, text, twinkle, walkIn,
  waveFill, waveLine, whaleTail, type Ink,
} from "./maid-draw";
import { IDLE, greeting, patLine, pick, uiFace, wrap } from "./maid-lines";
import { StageCanvas } from "./stage-canvas";

/**
 * The maids on the label home (the Unreal build's RhineLabelHome.cpp and RhineThemeFx.cpp): the dressing of the
 * field (SRhineClaudeDecor: Claude's lace and rosette, DeepSeek's sea and life ring, pinned on again with each
 * record), the companion who leans on the way in and says how the selected host stands (SRhineClaudeCompanion), and
 * her portrait before the clock (SRhineClaudeAvatar). Only in a maid's theme; nothing is drawn in any other.
 *
 * The field's dressing is drawn only while it arrives or the record changes; she is drawn every frame she is on
 * screen (she breathes), on a canvas no larger than she and her bubble need.
 */
export type MaidColors = { ink: Ink; paper: Ink; accent: Ink; cyan: Ink };

export type MaidHomeFrame = {
  who: Mascot | undefined;
  time: number;
  /** Device pixels a stage unit. */
  k: number;
  /** The home page is on screen (the archive page of the label sheet, nothing over it). */
  shown: boolean;
  /** The field's size, stage units. */
  field: readonly [number, number];
  /** Arrivals (Unreal LabelIn): the field's dressing, her, and the way in she leans on (it slides in from the right). */
  fieldIn: number;
  herIn: number;
  slide: number;
  /** 0..1 since the selection changed. */
  change: number;
  /** What she says of the selected host. */
  line: string;
  /** Her assistant at work, its panel open, and when an answer came well (seconds on `time`'s clock). */
  working: boolean;
  panel: boolean;
  gladAt: number;
  /** Seconds into her walk in (below 0 her doorway opens; 1e9 none). */
  stepIn: number;
  colors: MaidColors;
  /** The window's size (stage units): she stands by its foot at the right. */
  window: readonly [number, number];
  /** 0 at her place, 1 up on the selected card (her panel open), eased. */
  aside: number;
  /** The pill under her bubble that opens her panel (desktop): its words, empty for none. */
  opener: string;
};

/** Her widget's box (SRhineClaudeCompanion ComputeDesiredSize), and the canvas round it: she stands taller than it and her bubble hangs off its left. */
const BOX = [332, 330] as const;
const CANVAS = [820, 700] as const;
const query = new URLSearchParams(location.search);

export class MaidHome {
  private decor = new StageCanvas("label-maid-decor");
  private her = new StageCanvas("label-maid-her");
  private box = document.createElement("div");
  private avatar = document.createElement("span");
  private decorKey = "";
  private who: Mascot | undefined;
  private shown = false;
  private slid = "";
  private companion = new Companion();
  private rect: DOMRect | null = null;
  private rectAt = 0;
  private opener = document.createElement("button");
  private openerKey = "";

  constructor(root: HTMLElement, private onPat: () => void, onOpener: () => void = () => {}) {
    root.querySelector(".label-field")!.append(this.decor.el);
    this.box.className = "label-maid";
    this.box.hidden = true;
    this.box.append(this.her.el);
    root.querySelector(".label-window")!.append(this.box);
    this.opener.type = "button";
    this.opener.className = "label-maid-opener";
    this.opener.hidden = true;
    this.opener.addEventListener("click", () => onOpener());
    root.querySelector(".label-window")!.append(this.opener);
    this.avatar.className = "label-maid-avatar";
    this.avatar.hidden = true;
    this.avatar.setAttribute("aria-hidden", "true");
    root.querySelector(".label-clock")!.before(this.avatar);
    this.box.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault();
      this.companion.pat();
      this.onPat();
    });
    this.box.addEventListener("pointerenter", () => this.companion.enter());
    this.box.addEventListener("pointerleave", () => { this.companion.hover = false; });
    // She leans a little toward the pointer: where it is across her box, measured now and then (the box moves only as it arrives).
    window.addEventListener("pointermove", event => {
      if (!this.shown) return;
      const now = performance.now();
      if (!this.rect || now - this.rectAt > 500) { this.rect = this.box.getBoundingClientRect(); this.rectAt = now; }
      const r = this.rect, unit = r.width / BOX[0];
      if (unit > 0) this.companion.toward = clamp(((event.clientX - r.left) / unit - (BOX[0] - 166)) / 700, -1, 1);
    }, { passive: true });
  }

  update(f: MaidHomeFrame) {
    const who = f.shown ? f.who : undefined;
    if (who !== this.who) {
      this.who = who;
      this.box.hidden = !who;
      this.avatar.hidden = !f.who;
      this.decorKey = "";
      if (!who) { this.decor.clear(); this.her.clear(); this.companion.reset(); }
    }
    // The portrait shows on every page that keeps the strip.
    if (f.who && this.avatar.dataset.who !== f.who) {
      this.avatar.dataset.who = f.who;
      this.avatar.style.backgroundImage = `url("${maidUrl(f.who, f.who === "deepseek" ? "bust" : "lookout")}")`;
    }
    this.shown = Boolean(who);
    const openerKey = who && f.opener ? `${f.opener}|${(f.window[0] - 372 + 480 * (1 - f.slide)).toFixed(1)}|${(f.window[1] - 150).toFixed(1)}|${(f.slide * (1 - Math.min(1, f.aside * 2))).toFixed(3)}` : "";
    if (openerKey !== this.openerKey) {
      this.openerKey = openerKey;
      this.opener.hidden = !openerKey || f.aside > .5;
      if (openerKey) {
        // Under her bubble: its bottom right 372 in from the window's right and 150 up from its foot; it fades while the panel is open.
        if (this.opener.textContent !== f.opener) this.opener.textContent = f.opener;
        this.opener.style.right = `${372 - 480 * (1 - f.slide)}px`;
        this.opener.style.bottom = "150px";
        this.opener.style.opacity = String(f.slide * (1 - Math.min(1, f.aside * 2)));
      }
    }
    if (!who) return;
    this.paintDecor(who, f);
    // She stands by the way in, which slides in from the right as the home arrives; with her panel open she steps up
    // onto the selected card (a little smaller), clear of the panel and of what the card says.
    const [ww, wh] = f.window, a = f.aside;
    const homeX = ww - 34 + 480 * (1 - f.slide), homeY = wh - 128, cardX = 464, cardY = 476;
    const x = homeX + (cardX - homeX) * a - BOX[0], y = homeY + (cardY - homeY) * a - BOX[1];
    const slide = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${(1 - .28 * a).toFixed(4)})`;
    if (slide !== this.slid) { this.slid = slide; this.box.style.transform = slide; }
    const ctx = this.her.begin(CANVAS[0], CANVAS[1], f.k);
    ctx.save();
    ctx.translate(CANVAS[0] - BOX[0], CANVAS[1] - BOX[1]);
    this.companion.paint(ctx, who, f);
    ctx.restore();
  }

  /** The field's dressing, drawn again only while it moves (its arrival, a new record) or its colours or size change. */
  private paintDecor(who: Mascot, f: MaidHomeFrame) {
    const arrived = clamp(f.fieldIn), change = clamp(f.change);
    const settled = arrived >= 1 && change >= 1;
    const key = `${who}|${f.field[0]}|${f.field[1]}|${f.k.toFixed(2)}|${f.colors.ink}|${f.colors.paper}|${f.colors.accent}|${settled ? "rest" : `${arrived.toFixed(3)}|${change.toFixed(3)}`}`;
    if (key === this.decorKey) return;
    this.decorKey = key;
    if (arrived <= 0) { this.decor.clear(); return; }
    const [w, h] = f.field, ctx = this.decor.begin(w, h, f.k), { ink: cream, paper: cocoa } = f.colors;
    const moved = Math.min(change, arrived), left = 1 - easeOut(moved), pin = 1 + .3 * left;
    const cx = w - 150, cy = 640;
    if (who === "deepseek") {
      // Hers: the sea along the head and the foot of the field (foam-white waves over a lighter swell), drawn out as it
      // arrives, and a life ring pinned on beside the chips (a size over and a quarter turn with each record).
      const foam = f.colors.paper, navy = f.colors.ink, gold = f.colors.cyan, wide = w * easeOut(arrived);
      waveFill(ctx, 0, wide, 16, 5, 52, 0, 0, css(foam, .95));
      waveLine(ctx, 0, wide, 24, 4, 52, 1.4, 2.4, css(foam, .5));
      waveFill(ctx, 0, wide - 64, h - 16, 5, 52, Math.PI, h, css(foam, .95));
      waveLine(ctx, 0, wide - 64, h - 26, 4, 52, Math.PI + 1.4, 2.4, css(foam, .5));
      const r = 42 * pin, thick = r * .42, turn = left * Math.PI / 2;
      // Eight bands round the ring, white and the field's own blue in turn, a rope round it and the hole in the middle.
      ctx.lineWidth = thick; ctx.lineCap = "butt";
      for (let i = 0; i < 8; i++) {
        ctx.strokeStyle = css(i % 2 ? navy : foam, arrived);
        ctx.beginPath(); ctx.arc(cx, cy, r, turn + i * Math.PI / 4, turn + (i + 1) * Math.PI / 4 + .002); ctx.stroke();
      }
      ring(ctx, cx, cy, r + thick * .5, 1.6, css(navy, .7 * arrived));
      ring(ctx, cx, cy, r - thick * .5, 1.6, css(navy, .7 * arrived));
      for (let i = 0; i < 4; i++) { const a = turn + Math.PI / 8 + i * Math.PI / 2; disc(ctx, cx + Math.cos(a) * r, cy + Math.sin(a) * r, 3.5, css(gold, arrived)); }
      whaleTail(ctx, cx, cy + r + thick * .5 + 30, 44, foam, .95 * arrived);
      font(ctx, 11, 800, 2.4, uiFace());
      text(ctx, "AHOY, MASTER!", cx, cy - r - thick * .5 - 30, css(navy, .85 * arrived), .5);
      return;
    }
    // Lace along the head (short of the cut corner) and the foot of the field, drawn out as it arrives.
    const pitch = 22;
    const lace = (y: number, down: boolean) => {
      const wide = (down ? w - 64 : w) * easeOut(arrived);
      ctx.save(); ctx.beginPath(); ctx.rect(0, down ? y : y - pitch, wide, pitch); ctx.clip();
      scallops(ctx, 0, y, w, y, pitch, css(cream));
      ctx.restore();
      ctx.fillStyle = css(cream); ctx.fillRect(0, down ? y - 7 : y, wide, 7);
      // An eyelet in every scallop.
      for (let x = pitch / 2; x < wide - pitch / 2; x += pitch) disc(ctx, x, y + (down ? 4 : -4), 2.2, css(cocoa, .55));
    };
    lace(7, true);
    lace(h - 7, false);
    // The rosette, beside the chips (the one clear patch of the field): a size over and a quarter turn round with
    // each record, settling; two ribbon tails under it and the words over it.
    const r = 40 * pin;
    slab(ctx, cx - 20, cy + r + 22, 30, 62, .16, css(cream, .92 * arrived));
    slab(ctx, cx + 22, cy + r + 16, 30, 50, -.2, css(cream, .92 * arrived));
    for (let i = 0; i < 14; i++) { const a = 2 * Math.PI * i / 14 + left; disc(ctx, cx + Math.cos(a) * r, cy + Math.sin(a) * r, r * .26, css(cream, arrived)); }
    disc(ctx, cx, cy, r, css(cream, arrived));
    ring(ctx, cx, cy, r * .8, 2, css(cocoa, .5 * arrived));
    spark(ctx, cx, cy, r * .56, 6 * pin, css(f.colors.accent, arrived), left * Math.PI / 2);
    font(ctx, 11, 700, 2.4, uiFace());
    text(ctx, "AT YOUR SERVICE", cx, cy - r - 30, css(cocoa, .85 * arrived), .5);
  }
}

/** SRhineClaudeCompanion: her state between frames, and her drawing in her box's units (332 × 330, her feet on its foot). */
class Companion {
  hover = false;
  toward = 0;
  private now = 0;
  private last = 0;
  private own = "";
  private ownUntil = -1;
  private status = "";
  private shownText = "";
  private shownAt = 0;
  private lines: string[] = [];
  private patAt = -100;
  private hoverAt = -100;
  private idleAt = 0;
  private arrivedAt = -1;
  private lean = 0;
  private pats = 0;
  private turn = 0;
  private greeted = false;
  private dozing = false;
  private touchAt = 0;
  private greetUntil = -1;
  private cheerUntil = -1;
  private teaUntil = -1;
  private poseAt = -100;
  private bowUntil = -1;
  private crossUntil = -1;
  private poseNow = 2;
  private posePrev = 2;
  private panelSeen = false;
  private who: Mascot = "claude";
  /** ?maid-pat=N: N pats a second after she arrives; ?maid-doze: she nods off at once (to see them). */
  private scriptedPats = Number(query.get("maid-pat") ?? 0) || 0;
  private static dozedOnce = false;

  reset() { this.greeted = false; this.arrivedAt = -1; this.dozing = false; this.ownUntil = -1; }

  private say(line: string, seconds: number) { this.own = line; this.ownUntil = this.now + seconds; this.idleAt = this.now; }

  private wake() {
    this.touchAt = this.now;
    if (!this.dozing) return;
    this.dozing = false;
    this.say(pick(this.who, "啊！主人，我、我没有偷懒！", "啊！我、我才没在海底睡觉！"), 3);
  }

  pat() {
    // Patted awake, she says so; otherwise a pat cheers her up for a moment, and past the sixth in a row she puffs up her cheeks.
    if (this.dozing) { this.wake(); this.patAt = this.now; return; }
    this.touchAt = this.now;
    if (this.now - this.patAt > 20) this.pats = 0;
    this.pats++;
    this.patAt = this.now;
    if (this.pats >= 6) { this.crossUntil = this.now + 2.6; this.cheerUntil = -1; } else this.cheerUntil = this.now + 2.2;
    this.say(patLine(this.who, this.pats, this.turn++), 4);
  }

  enter() {
    this.hover = true;
    if (this.dozing) { this.wake(); this.hoverAt = this.now; return; }
    this.touchAt = this.now;
    // She asks once in a while, not every time the pointer crosses her.
    if (this.now - this.hoverAt > 12 && this.now >= this.ownUntil && this.greeted)
      this.say(this.turn++ % 2 ? pick(this.who, "嗯？主人在看我吗？", "主人在看我吗？嘿嘿～") : pick(this.who, "需要我做什么吗？", "要出海了吗？"), 3);
    this.hoverAt = this.now;
  }

  paint(ctx: CanvasRenderingContext2D, who: Mascot, f: MaidHomeFrame) {
    this.who = who;
    const S = BOX, art = maidArt(who, ART.lean), arrived = clamp(f.herIn);
    const now = this.now = f.time;
    if (this.touchAt <= 0) this.touchAt = now;
    const dt = clamp(now - this.last, 0, .1);
    this.last = now;
    if (!art || arrived <= 0) { this.greeted = false; this.arrivedAt = -1; return; }
    // Her entrance: hidden before her walk in; she is in her own pose the moment she arrives, and greets the reader then.
    const step = f.stepIn, hold = step >= WALK_TIME ? 1 : 0;
    if (hold <= 0) { this.greeted = false; this.arrivedAt = -1; }
    const { ink: cream, paper: cocoa, accent: mark } = f.colors;
    const moved = clamp(f.change);

    // What she says. The host's line is the ground; a line of her own lies over it for a few seconds.
    if (f.line !== this.status) { this.status = f.line; this.idleAt = now; if (this.greeted) this.ownUntil = -1; if (this.dozing) this.wake(); this.touchAt = now; }
    if (arrived >= 1 && this.arrivedAt < 0) this.arrivedAt = now;
    if (!this.greeted && arrived >= 1 && hold > 0) {
      this.greeted = true;
      this.say(greeting(who), 4);
      this.greetUntil = now + 4.5;
    }
    // Left alone for a minute and a half she nods off where she stands (until the pointer or a pat wakes her).
    const scriptNow = query.has("maid-doze") && !Companion.dozedOnce && this.arrivedAt >= 0 && now - this.arrivedAt > 1.5;
    if (!this.dozing && this.greeted && ((now >= this.ownUntil && now - this.touchAt > 90) || scriptNow)) {
      this.dozing = Companion.dozedOnce = true; this.greetUntil = -1; this.say("Zzz……", 1e6);
    }
    if (this.dozing) this.idleAt = now;
    if (this.greeted && now - this.idleAt > 40 && now >= this.ownUntil) {
      const chosen = this.turn++ % IDLE[who].length;
      this.say(IDLE[who][chosen], 6);
      // The tea (or her snack) comes with the offer.
      if (chosen === 0) this.teaUntil = now + 6;
    }
    if (this.scriptedPats > 0 && this.arrivedAt >= 0 && now - this.arrivedAt > 1) { const count = this.scriptedPats; this.scriptedPats = 0; for (let i = 0; i < count; i++) this.pat(); }
    const whole = now < this.ownUntil ? this.own : this.status;
    font(ctx, 18, 600, .4, uiFace());
    if (whole !== this.shownText) { this.shownText = whole; this.shownAt = now; this.lines = wrap(ctx, whole, 400, 7); }

    // Her panel opening: she bows to take the order. An answer that came well: she celebrates for three seconds.
    if (f.panel && !this.panelSeen && this.greeted) { if (this.dozing) this.wake(); this.bowUntil = now + 2.2; this.touchAt = now; this.say(pick(who, "请吩咐，主人。", "收到！主人请下令！"), 2.5); }
    this.panelSeen = f.panel;
    const glad = now - f.gladAt;
    if (f.working || (glad >= 0 && glad < 3)) { this.touchAt = now; if (this.dozing) this.wake(); }
    // Which of her she is: dozing, cross after too many pats, cheering after a pat, bowing to her panel, celebrating an
    // answer, mending a server while she works, waving hello, offering tea, or leaning on the way in. A new pose
    // crosses over the old in a quarter of a second.
    const wanted = this.dozing ? ART.doze : now < this.crossUntil ? ART.angry : now < this.cheerUntil ? ART.cheer : now < this.bowUntil ? ART.bow
      : glad >= 0 && glad < 3 ? ART.celebrate : f.working ? ART.fix : now < this.greetUntil ? ART.wave : now < this.teaUntil ? ART.tea : ART.lean;
    if (wanted !== this.poseNow) { this.posePrev = this.poseNow; this.poseNow = wanted; this.poseAt = now; }
    const cross = clamp((now - this.poseAt) / .25);

    // Her: on the box's foot, breathing, up on her toes with each record; patted she is pressed down and springs up;
    // she leans a little toward the pointer, and stands a touch taller under it.
    const patT = now - this.patAt, press = patT < .22 ? Math.sin(Math.PI * patT / .22) : 0;
    const spring = patT >= .12 && patT < .6 ? Math.sin(Math.PI * (patT - .12) / .48) : 0;
    const bob = 2.5 * Math.sin(now * 1.7) - 16 * Math.sin(Math.PI * moved) * (1 - moved) - 20 * spring * (this.dozing ? 0 : 1);
    this.lean += ((this.dozing ? 0 : this.toward * .04) - this.lean) * Math.min(1, dt * 5);
    let x = 0, y = 0, wide = 0, high = 0;
    const place = (pose: number, picture: ImageBitmap) => {
      const tall = pose === ART.lean ? 300 : pose === ART.doze ? 320 : pose === ART.fix ? 380 : pose === ART.bow ? 460 : 470;
      const size = (this.hover ? 1.03 : 1) * tall;
      high = size * (1 - .07 * press);
      wide = size * picture.width / picture.height * (1 + .04 * press);
      // The leaning one keeps its old place; the others stand on the same ground, their right edge a little in from hers.
      x = pose === ART.lean ? S[0] - 331 - (wide - 331) / 2 : S[0] - wide - 4;
      y = S[1] - high + bob + (pose === ART.doze ? 8 * Math.sin(now * .9) : 0) + 24 * (1 - easeOut(arrived));
    };
    const draw = (pose: number, seen: number) => {
      let picture = maidArt(who, pose);
      if (!picture) { picture = art; pose = ART.lean; }
      place(pose, picture);
      const alpha = arrived * hold * seen;
      if (alpha <= 0) return;
      // Turned about her foot.
      ctx.save();
      ctx.translate(x + wide / 2, y + high); ctx.rotate(this.lean);
      ctx.globalAlpha = alpha;
      ctx.drawImage(picture, -wide / 2, -high, wide, high);
      ctx.restore();
    };
    // Her walk in, where her waving self will stand (and its last stride fading as she turns to wave).
    if (step < WALK_TIME + .4) {
      const waving = maidArt(who, ART.wave);
      if (waving) { place(ART.wave, waving); walkIn(ctx, who, x + wide / 2, y + high, high, step, now, cream, mark, arrived); }
      if (step < WALK_TIME) { this.poseNow = this.posePrev = ART.wave; this.poseAt = -100; this.touchAt = now; this.dozing = false; return; }
    }
    if (cross < 1) draw(this.posePrev, 1 - cross);
    draw(this.poseNow, cross);
    // Dozing: Z z z rising from her head, one after another.
    if (this.dozing) for (let i = 0; i < 3; i++) {
      const rise = (now * .5 + i / 3) % 1;
      font(ctx, 30 - 6 * i, 800, 0, DISPLAY);
      text(ctx, i ? "z" : "Z", x + wide * .7 + 22 * rise + 8 * i, y + high * .12 - 70 * rise, css(cream, arrived * hold * Math.sin(Math.PI * rise)), .5);
    }
    // The pat: six of her sparks thrown from her head, turning as they go.
    if (patT < .7) {
      const hx = x + wide * .62, hy = y + high * .22;
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI * .5 + (i - 2.5) * .5, far = 34 + 86 * easeOut(patT / .7);
        twinkle(ctx, who, hx + Math.cos(a) * far, hy + Math.sin(a) * far, 9 + 5 * (i % 2), 3, css(i % 2 ? cream : mark, (1 - patT / .7) * arrived * hold), patT * 5 + i);
      }
    }
    if (!this.lines.length) return;
    // The bubble, off her left and standing on one line (a longer answer grows it upward): written out again
    // whenever the line changes, forty letters a second.
    font(ctx, 18, 600, .4, uiFace());
    let tw = 0;
    for (const line of this.lines) tw = Math.max(tw, ctx.measureText(line).width);
    const lh = 26, bw = tw + 44, bh = 24 + lh * this.lines.length, bx = x + 36 - bw, by = y + 112 - bh;
    const pop = easeOut(clamp((now - this.shownAt) / .25)), lift = 8 * (1 - pop), a = arrived * hold * pop;
    if (a <= 0) return;
    // Three layers, back to front: a shadow in her colour a little off register, the cream card (its corner toward her square), the words.
    const whale = who === "deepseek";
    roundBox(ctx, bx + 5, by + 5 + lift, bw, bh, whale ? 24 : 16, css(mark, a), whale ? 15 : 1 | 2 | 8);
    roundBox(ctx, bx, by + lift, bw, bh, whale ? 24 : 16, css(cream, a), whale ? 15 : 1 | 2 | 8);
    if (whale) { disc(ctx, bx + bw + 8, by + bh + 2 + lift, 7, css(cream, a)); disc(ctx, bx + bw + 22, by + bh + 14 + lift, 4.5, css(cream, a)); }
    let letters = Math.max(1, Math.ceil((now - this.shownAt) * 40));
    for (let i = 0; i < this.lines.length && letters > 0; letters -= [...this.lines[i++]].length)
      text(ctx, [...this.lines[i]].slice(0, letters).join(""), bx + 22, by + 13 + i * lh + lift, css(cocoa, a));
    font(ctx, 11, 700, 3, uiFace());
    text(ctx, pick(who, "CLAUDE", "DEEPSEEK"), bx + 4, by - 22 + lift, css(cream, .8 * a));
    twinkle(ctx, who, bx + bw - 4, by - 2 + lift, 13, 3.4, css(mark, a), now * .8);
  }
}
