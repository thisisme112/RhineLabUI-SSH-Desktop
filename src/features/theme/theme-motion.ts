export type ThemeCell = { row: number; lane: number };
/** Numeric like archive-loop's cellNumber: sample() runs for every card every frame. */
const key = (cell: ThemeCell) => cell.lane * 2 ** 26 + cell.row;
const ease = (t: number) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };

/**
 * The rows turning over after a theme change (the Unreal build's ThemeCellMotion,
 * RhineThemeScene.cpp). From the selected card outward each card is pressed up
 * from below like a key: it rises, leans toward the viewer, changes to the new
 * theme edge-on at 31% of its turn in a flash of the new mark colour, and settles
 * with a small overshoot. A turn takes .6 s and starts .03 s later per row of
 * distance (a lane counts 2.2 rows). Unlike Unreal, whose far rows simply switch
 * when its 1.2 s wave ends, the delay is capped so every card on screen turns.
 */
export type FlipSample = { lift: number; tilt: number; flash: number; swap: number };
const BEFORE: FlipSample = { lift: 0, tilt: 0, flash: 0, swap: 0 };
const AFTER: FlipSample = { lift: 0, tilt: 0, flash: 0, swap: 1 };
const FLIP_TIME = .6, ROW_STEP = .03, LANE_ROWS = 2.2, LEAD = .04, LONGEST_DELAY = .9, SWAP = .31;
/** The selected file and other single meshes ease into the new theme over this long. */
const SINGLE_TIME = .45;
/** Start to the last card's settling. */
export const FLIP_SPAN = LEAD + LONGEST_DELAY + FLIP_TIME;
/** Unreal's WaveLift 60 of a 370 cm card, and WaveTilt 4 degrees, in this scene's units. */
export const FLIP_LIFT = .61, FLIP_TILT = 4 * Math.PI / 180;
export class PaletteFlip {
  private start = -10;
  private origin: ThemeCell = { row: 12, lane: 2 };
  /** Begin a wave at `time` from `origin`; `after` delays it. */
  begin(time: number, origin: ThemeCell, after = 0) { this.start = time + after; this.origin = { ...origin }; }
  active(time: number) { return time >= this.start && time - this.start < FLIP_SPAN; }
  sample(cell: ThemeCell, time: number): FlipSample {
    const t = time - this.start;
    if (t < 0) return BEFORE;
    const distance = Math.hypot(cell.row - this.origin.row, (cell.lane - this.origin.lane) * LANE_ROWS);
    const p = (t - LEAD - Math.min(LONGEST_DELAY, distance * ROW_STEP)) / FLIP_TIME;
    if (p <= 0) return BEFORE;
    if (p >= 1) return AFTER;
    const rise = Math.sin(Math.PI * Math.min(p / .62, 1));
    const settle = p > .62 ? -.12 * Math.sin(Math.PI * (p - .62) / .38) : 0;
    return {
      lift: FLIP_LIFT * (rise + settle),
      tilt: FLIP_TILT * Math.sin(Math.PI * p),
      flash: Math.exp(-(((p - SWAP) / .1) ** 2)),
      swap: p >= SWAP ? 1 : 0,
    };
  }
  /** The selected file and the other single meshes: the new theme eased in over .45 s from the start. */
  single(time: number) {
    const t = Math.min(1, Math.max(0, (time - this.start) / SINGLE_TIME));
    return t * t * (3 - 2 * t);
  }
}

/** A material wave with a frozen origin and an interruptible per-card starting colour. */
export class ThemeWave {
  target = 0;
  private start = -10;
  private origin: ThemeCell = { row: 12, lane: 2 };
  private from = new Map<number, number>();
  private latest = new Map<number, number>();
  private backgroundFrom = 0;
  set(dark: boolean, time: number, origin: ThemeCell, immediate = false) {
    const target = dark ? 1 : 0;
    if (target === this.target && !immediate) return;
    this.backgroundFrom = immediate ? target : this.background(time);
    this.from = immediate ? new Map() : new Map(this.latest);
    this.target = target; this.start = immediate ? time - 10 : time;
    this.origin = { ...origin };
  }
  background(time: number) { return this.backgroundFrom + (this.target - this.backgroundFrom) * ease((time - this.start) / .85); }
  beginFrame() { this.latest.clear(); }
  sample(cell: ThemeCell, time: number) {
    // Every card has arrived by 1.18 s (delay ≤ .6, turn .58). From then on each one reads
    // the target, and an interrupting set() starts from background(), which is the target
    // too; so nothing needs to be looked up or remembered.
    if (time - this.start >= 1.2) return this.target;
    const delay = Math.min(.6, Math.abs(cell.row - this.origin.row) * .034 + Math.abs(cell.lane - this.origin.lane) * .11);
    const from = this.from.get(key(cell)) ?? this.backgroundFrom;
    const value = from + (this.target - from) * ease((time - this.start - delay) / .58);
    this.latest.set(key(cell), value);
    return value;
  }
}
