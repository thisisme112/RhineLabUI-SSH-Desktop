export type ThemeCell = { row: number; lane: number };
const key = (cell: ThemeCell) => `${cell.lane}:${cell.row}`;
const ease = (t: number) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };

/**
 * The rows turning over after a theme change (the Unreal build's ThemeCellMotion,
 * RhineThemeScene.cpp): from the selected card outward each card rises, leans
 * forward and settles, and at the top of its turn flashes the new theme's mark
 * colour. Timings are Unreal's: a card's turn takes .6 s, each row starts .03 s
 * after the one before it, and the whole wave lasts 1.2 s.
 */
export type FlipSample = { lift: number; tilt: number; flash: number };
const NONE: FlipSample = { lift: 0, tilt: 0, flash: 0 };
const FLIP_TIME = .6, ROW_STEP = .03, LANE_STEP = .09, WAVE_TIME = 1.2;
/** Unreal's WaveLift 60 of a 370 cm card, and WaveTilt 4 degrees, in this scene's units. */
export const FLIP_LIFT = .61, FLIP_TILT = 4 * Math.PI / 180;
export class PaletteFlip {
  private start = -10;
  private origin: ThemeCell = { row: 12, lane: 2 };
  /** Begin a wave at `time` from `origin`; `after` delays it (the change-over's own reveal runs first). */
  begin(time: number, origin: ThemeCell, after = 0) { this.start = time + after; this.origin = { ...origin }; }
  active(time: number) { return time >= this.start && time - this.start < WAVE_TIME + FLIP_TIME; }
  sample(cell: ThemeCell, time: number): FlipSample {
    const t = time - this.start;
    if (t < 0 || t > WAVE_TIME + FLIP_TIME) return NONE;
    const delay = Math.min(WAVE_TIME - FLIP_TIME * .5, Math.abs(cell.row - this.origin.row) * ROW_STEP + Math.abs(cell.lane - this.origin.lane) * LANE_STEP);
    const p = (t - delay) / FLIP_TIME;
    if (p <= 0 || p >= 1) return NONE;
    const arc = Math.sin(Math.PI * p);
    // The flash peaks a little before the top of the turn (Unreal swaps the material at P = .31).
    const flash = Math.max(0, 1 - Math.abs(p - .34) / .26);
    return { lift: arc * FLIP_LIFT, tilt: arc * FLIP_TILT, flash: flash * flash * (3 - 2 * flash) };
  }
}

/** A material wave with a frozen origin and an interruptible per-card starting colour. */
export class ThemeWave {
  target = 0;
  private start = -10;
  private origin: ThemeCell = { row: 12, lane: 2 };
  private from = new Map<string, number>();
  private latest = new Map<string, number>();
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
    const delay = Math.min(.6, Math.abs(cell.row - this.origin.row) * .034 + Math.abs(cell.lane - this.origin.lane) * .11);
    const from = this.from.get(key(cell)) ?? this.backgroundFrom;
    const value = from + (this.target - from) * ease((time - this.start - delay) / .58);
    this.latest.set(key(cell), value);
    return value;
  }
}
