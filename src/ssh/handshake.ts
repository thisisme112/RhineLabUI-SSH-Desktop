import { damp, type Spring } from "../motion.ts";
import {
  DECRYPTION_END,
  DECRYPTION_START,
  decryptionFrame,
  type DecryptionFrame,
} from "../decryption.ts";
import type { SshEventName } from "./events.ts";

/**
 * Drives the existing decryption timeline from real SSH events.
 *
 * The deal this file makes (DESKTOP-SSH.md §4.1):
 *   - the *phase switch points* come from real events, so a connection that
 *     never negotiates never looks like one that did;
 *   - the *interpolation between them* reuses the project's own curve and
 *     critically-damped spring, so the feel is unchanged.
 *
 * Nothing here advances on a timer. `advance()` only ever moves the reference
 * toward the milestone the last real event asked for, so when events stop the
 * animation settles and stops with them — a slow server simply looks slow, and
 * a failed handshake parks at the stage it actually reached instead of playing
 * through to "decrypted".
 */

/** Reference seconds on the original decryption timeline, per real event. */
export const HANDSHAKE_MILESTONES: Partial<Record<SshEventName, number>> = {
  "config.loaded": 34.16,
  "tcp.connecting": 34.24,
  "tcp.established": 34.44,
  "banner.local": 34.56,
  "banner.remote": 34.68,
  "kex.algorithms": 34.9,
  "kex.ciphers": 35.3,
  "hostkey.received": 35.9,
  "hostkey.unknown": 35.94,
  "hostkey.verified": 36.2,
  "auth.methods": 36.5,
  "auth.offering": 36.9,
  "auth.accepted": 37.2,
  "auth.succeeded": 37.66,
  "session.entering": 38.3,
  // `pledge: network` is OpenSSH saying the interactive session is up. The
  // glass-clearing phase (38.84–39.56) is traversed by the spring between
  // these two real events rather than by a timer of its own.
  "session.authenticated": DECRYPTION_END,
};

/** Events after which the connection is over and the timeline must stop. */
const TERMINAL: ReadonlySet<SshEventName> = new Set<SshEventName>([
  "dns.failed",
  "tcp.failed",
  "kex.reset",
  "hostkey.mismatch",
  "auth.denied",
  "session.closed",
]);

/**
 * Chase rate for the spring. Sits between the scene's material blend (2.8) and
 * its lift (4.2): fast enough to feel like it is following the connection, slow
 * enough that a burst of log lines reads as one movement rather than a jump.
 */
const CHASE_RATE = 3.4;
/**
 * A millisecond of timeline counts as arrived. Critical damping has a long
 * exponential tail; without a snap the frame would sit 0.0001s short of the
 * final milestone for seconds, leaving `phase` on the wrong side of a boundary
 * that is meant to mark "the session is up".
 */
const SETTLE_EPSILON = 1e-3;

/** Milestones are real events, plus the first shell prompt seen on the pty. */
export type HandshakeMilestone = SshEventName | "session.prompt";

export type HandshakeSnapshot = {
  /** Where the animation currently is, in decryption-timeline seconds. */
  reference: number;
  /** Where the last real event asked it to go. */
  target: number;
  frame: DecryptionFrame;
  /** Clarity 0..1 — the glass clearing as the session becomes usable. */
  clarity: number;
  /** True once a terminal event arrived: the timeline is parked for good. */
  frozen: boolean;
  /** The event that set the current target. */
  milestone: HandshakeMilestone | null;
  /** True when the spring has settled on the target (no motion in progress). */
  settled: boolean;
};

export class HandshakeDriver {
  private spring: Spring = { value: DECRYPTION_START, velocity: 0 };
  private target = DECRYPTION_START;
  private frozen = false;
  private milestone: HandshakeMilestone | null = null;

  reset() {
    this.spring.value = DECRYPTION_START;
    this.spring.velocity = 0;
    this.target = DECRYPTION_START;
    this.frozen = false;
    this.milestone = null;
  }

  /**
   * Feed one real event. Returns true when it moved the target forward.
   * Terminal events freeze the timeline where it stands.
   */
  apply(name: SshEventName): boolean {
    if (TERMINAL.has(name)) {
      this.frozen = true;
      return false;
    }
    if (this.frozen) return false;
    const next = HANDSHAKE_MILESTONES[name];
    // Monotonic: a late or duplicated line must never rewind the animation.
    if (next === undefined || next <= this.target) return false;
    this.target = next;
    this.milestone = name;
    return true;
  }

  /** The first shell prompt arrived: the session is genuinely usable. */
  markInteractive(): boolean {
    if (this.frozen || this.target >= DECRYPTION_END) return false;
    this.target = DECRYPTION_END;
    this.milestone = "session.prompt";
    return true;
  }

  /** Advance by a real elapsed time. Does nothing once settled. */
  advance(dt: number) {
    if (dt <= 0) return this.snapshot();
    // A frozen timeline still settles onto the milestone it reached.
    damp(this.spring, this.target, CHASE_RATE, dt);
    if (
      Math.abs(this.spring.value - this.target) < SETTLE_EPSILON &&
      Math.abs(this.spring.velocity) < SETTLE_EPSILON
    ) {
      this.spring.value = this.target;
      this.spring.velocity = 0;
    }
    return this.snapshot();
  }

  snapshot(): HandshakeSnapshot {
    const reference = Math.max(
      DECRYPTION_START,
      Math.min(DECRYPTION_END, this.spring.value),
    );
    const frame = decryptionFrame(reference);
    return {
      reference,
      target: this.target,
      frame,
      clarity: frame.clarity,
      frozen: this.frozen,
      milestone: this.milestone,
      settled: Math.abs(this.spring.value - this.target) < SETTLE_EPSILON,
    };
  }
}
