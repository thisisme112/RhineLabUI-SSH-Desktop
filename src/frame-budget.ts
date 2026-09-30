/**
 * The frame rate follows what is on screen (ported from the Unreal build's
 * RhineFrameBudget.cpp). The array's rows only breathe on 8 and 13 second
 * periods, so a resting home has nothing to show at 120 Hz: rendering it that
 * often kept a core and the GPU busy for nothing (and on a phone it is heat).
 *
 *   busy        the opening, anything moving, input within the last two seconds
 *   active      a selection just made, a rolling number turning, an SSH surface
 *   idle        nothing moves
 *   background  the window has lost focus (desktop shells only)
 *
 * The gate is pure: `admit` is asked once per animation frame and says whether
 * this frame should do the full work. Callers report what they saw with
 * `busy` / `active`; nothing here reads the DOM, so it can be unit tested.
 */
export type BudgetTier = "busy" | "active" | "idle" | "background";

export interface BudgetRates {
  /** Cap while busy; Infinity follows the display. */
  busy: number;
  active: number;
  idle: number;
  background: number;
}

export const DESKTOP_RATES: BudgetRates = { busy: Infinity, active: 60, idle: 30, background: 15 };
/** A phone's scene is not worth the heat above 60. */
export const ANDROID_RATES: BudgetRates = { busy: 60, active: 60, idle: 30, background: 15 };

/**
 * Dynamic resolution for a phone: when the frames it is asked for keep arriving
 * later than the budget allows, the render size steps down (never below `min`);
 * once they have kept up for a good while it steps back up. Idle frames are
 * skipped on purpose and never count: only frames at a busy or active rate do.
 * A step up that is followed by another step down within `retry` ms is taken as
 * the ceiling, so the size settles instead of oscillating.
 */
export class ResolutionGovernor {
  factor = 1;
  private readonly min: number;
  private readonly step: number;
  private slowMs = 0;
  private fastMs = 0;
  private lastChange = -1e9;
  private ceiling = 1;
  private raisedAt = -1e9;

  constructor(min = 0.6, step = 0.1) { this.min = min; this.step = step; }

  /**
   * One rendered frame took `dtMs` since the previous one, against a budget of `targetMs`.
   * Returns the new factor when it changed, else null.
   */
  observe(now: number, dtMs: number, targetMs: number): number | null {
    // A stall (tab switch, keyboard, GC) is not the scene's cost.
    if (dtMs > 250 || dtMs <= 0) return null;
    if (dtMs > targetMs * 1.35) { this.slowMs += dtMs; this.fastMs = 0; }
    else { this.slowMs = Math.max(0, this.slowMs - dtMs); this.fastMs = dtMs < targetMs * 1.08 ? this.fastMs + dtMs : 0; }
    if (this.slowMs > 1500 && this.factor > this.min + 1e-6) {
      this.slowMs = 0; this.fastMs = 0;
      // Too soon after a step up: that size was too much.
      if (now - this.raisedAt < 15000) this.ceiling = Math.max(this.min, Math.round((this.factor - this.step) * 100) / 100);
      this.factor = Math.max(this.min, Math.round((this.factor - this.step) * 100) / 100);
      this.lastChange = now;
      return this.factor;
    }
    if (this.fastMs > 6000 && this.factor < this.ceiling - 1e-6 && now - this.lastChange > 10000) {
      this.fastMs = 0;
      this.factor = Math.min(this.ceiling, Math.round((this.factor + this.step) * 100) / 100);
      this.lastChange = now; this.raisedAt = now;
      return this.factor;
    }
    return null;
  }
}

export class FrameBudget {
  private last = -Infinity;
  private previous = 0;
  private refresh = 1000 / 60;
  private busyUntil = 0;
  private activeUntil = 0;
  private current: BudgetTier = "busy";
  /** Frames the gate let through / held back, for the debug read-out. */
  admitted = 0;
  skipped = 0;

  // Assigned explicitly so Node's type stripping can import this file for its unit test.
  private readonly rates: BudgetRates;
  constructor(rates: BudgetRates) { this.rates = rates; }

  get tier() { return this.current; }
  /** The rate the current tier allows. */
  get fps() { return this.rates[this.current]; }
  /** The display's own frame time, estimated from the animation frames it has been asked for. */
  get refreshMs() { return this.refresh; }

  /** Something moved or the person did something: hold the full rate for `holdMs`. */
  busy(now: number, holdMs = 600) {
    this.busyUntil = Math.max(this.busyUntil, now + holdMs);
  }

  /** Softer than busy: a selection, a rolling number. */
  active(now: number, holdMs = 3200) {
    this.activeUntil = Math.max(this.activeUntil, now + holdMs);
  }

  /** True when this animation frame should do the full work. */
  admit(now: number, background = false): boolean {
    const delta = now - this.previous;
    this.previous = now;
    // Every rAF tick arrives here, admitted or not, so the deltas are the display's own.
    if (delta > 2 && delta < 60) this.refresh += (delta - this.refresh) * 0.1;
    this.current = now < this.busyUntil ? "busy" : now < this.activeUntil ? "active" : background ? "background" : "idle";
    // A backgrounded window never runs faster than its own tier, however busy it was.
    if (background && this.current !== "background") this.current = "background";
    const fps = this.rates[this.current];
    if (!Number.isFinite(fps) || fps <= 0) { this.last = now; this.admitted++; return true; }
    const interval = 1000 / fps;
    // Half a display frame of slack, so a 60 fps target on a 120 Hz panel lands on every second tick.
    if (now - this.last >= interval - this.refresh * 0.5) {
      this.last = now;
      this.admitted++;
      return true;
    }
    this.skipped++;
    return false;
  }
}
