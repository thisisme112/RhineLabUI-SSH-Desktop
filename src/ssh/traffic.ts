import { quietBands, type MusicBands } from "../archive-play-motion.ts";

/**
 * Turns measured ssh traffic into the array's displacement bands.
 *
 * The project already has a `MusicBands` driver (`scene.setPlayfield`) that the
 * wallpaper build feeds from an audio spectrum. Nothing about it is
 * audio-specific — it is a three-band displacement field — so the desktop build
 * feeds it real bytes instead. That is the whole trick behind "the archive
 * array is a network activity gauge": same animation, real data (rule R1).
 *
 *   low   sustained downstream   (server → me: output of a command)
 *   mid   sustained upstream     (me → server: keystrokes, pastes)
 *   high  instantaneous downstream bursts, on a much shorter timescale
 *   activity  the loudest of the three, for overall amplitude
 */

type Sample = { at: number; bytesIn: number; bytesOut: number };

/** Window for the sustained rates. Long enough to be a rate, short enough to react. */
const WINDOW_MS = 1500;
/** Rate that maps to ~0.075 after normalization: a quiet interactive session. */
const REFERENCE_RATE = 64;
/** Rise/fall asymmetry, matching the project's spectrum envelope (16 / 3.2). */
const ATTACK = 16;
const DECAY = 3.2;
/** Bursts get their own, faster envelope so a spike reads as a spike. */
const BURST_ATTACK = 24;
const BURST_DECAY = 6;

/** log10 curve: 64 B/s → 0.08, 64 KiB/s → 0.75, 6.4 MiB/s → 1. */
export function normalizeRate(bytesPerSecond: number): number {
  // NaN and negatives mean "no measurement", which must read as quiet rather
  // than as activity. Infinity is a real (if extreme) rate and saturates.
  if (!(bytesPerSecond > 0)) return 0;
  return Math.max(
    0,
    Math.min(1, Math.log10(1 + bytesPerSecond / REFERENCE_RATE) / 4),
  );
}

const approach = (
  current: number,
  target: number,
  dt: number,
  attack: number,
  decay: number,
) =>
  current +
  (target - current) *
    (1 - Math.exp(-(target > current ? attack : decay) * dt));

export class TrafficMeter {
  private samples: Sample[] = [];
  private last: Sample | null = null;
  private rateIn = 0;
  private rateOut = 0;
  private burst = 0;
  private bands: MusicBands = quietBands();
  private lastUpdate = 0;
  private peakIn = 0;
  private peakOut = 0;

  reset() {
    this.samples = [];
    this.last = null;
    this.rateIn = 0;
    this.rateOut = 0;
    this.burst = 0;
    this.bands = quietBands();
    this.lastUpdate = 0;
    this.peakIn = 0;
    this.peakOut = 0;
  }

  /** Record a cumulative-counter reading from the session's measurement channel. */
  sample(at: number, bytesIn: number, bytesOut: number) {
    const entry: Sample = { at, bytesIn, bytesOut };
    this.samples.push(entry);
    while (this.samples.length > 2 && at - this.samples[0].at > WINDOW_MS)
      this.samples.shift();
    this.last = entry;
  }

  /** Recompute rates and envelopes. Call once per real frame. */
  update(now: number): MusicBands {
    const dt = this.lastUpdate
      ? Math.min(0.25, Math.max(0, (now - this.lastUpdate) / 1000))
      : 0;
    this.lastUpdate = now;

    const first = this.samples[0];
    const last = this.last;
    const span = first && last ? (last.at - first.at) / 1000 : 0;
    const targetIn =
      span > 0.05 ? Math.max(0, (last!.bytesIn - first.bytesIn) / span) : 0;
    const targetOut =
      span > 0.05 ? Math.max(0, (last!.bytesOut - first.bytesOut) / span) : 0;

    // Instantaneous delta over the last two readings: the short timescale.
    const previous = this.samples[this.samples.length - 2];
    const gap = previous && last ? (last.at - previous.at) / 1000 : 0;
    const targetBurst =
      gap > 0.01 ? Math.max(0, (last!.bytesIn - previous!.bytesIn) / gap) : 0;

    this.rateIn = targetIn;
    this.rateOut = targetOut;
    this.burst = targetBurst;
    if (targetIn > this.peakIn) this.peakIn = targetIn;
    if (targetOut > this.peakOut) this.peakOut = targetOut;

    const inBand = normalizeRate(targetIn);
    const outBand = normalizeRate(targetOut);
    const burstBand = normalizeRate(targetBurst);

    if (dt > 0) {
      this.bands = {
        low: approach(this.bands.low, inBand, dt, ATTACK, DECAY),
        mid: approach(this.bands.mid, outBand, dt, ATTACK, DECAY),
        high: approach(
          this.bands.high,
          burstBand,
          dt,
          BURST_ATTACK,
          BURST_DECAY,
        ),
        activity: 0,
      };
    }
    this.bands.activity = Math.max(
      this.bands.low,
      this.bands.mid,
      this.bands.high,
    );
    return this.bands;
  }

  /** Current normalized bands. */
  get value(): MusicBands {
    return this.bands;
  }

  /** Raw measured rates, kept for the session-detail surface (rule R3). */
  get measurements() {
    return {
      bytesPerSecondIn: this.rateIn,
      bytesPerSecondOut: this.rateOut,
      burstPerSecond: this.burst,
      peakBytesPerSecondIn: this.peakIn,
      peakBytesPerSecondOut: this.peakOut,
      samples: this.samples.length,
    };
  }
}
