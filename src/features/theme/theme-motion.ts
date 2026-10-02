export type ThemeCell = { row: number; lane: number };

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
  /** Every card has turned (false before the wave has begun). */
  done(time: number) { return time - this.start >= FLIP_SPAN; }
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
