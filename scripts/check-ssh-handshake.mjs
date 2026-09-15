import assert from "node:assert/strict";
import { HandshakeDriver, HANDSHAKE_MILESTONES } from "../src/ssh/handshake.ts";
import { DECRYPTION_END, DECRYPTION_START } from "../src/decryption.ts";
import { parseSshLine } from "../src/ssh/events.ts";

/**
 * The handshake driver is what makes the decryption animation honest: it must
 * follow real connection events and stop where the evidence stops. The tests
 * below are therefore mostly about what does NOT happen — no motion without
 * events, no rewind, and no "decrypted" ending on a connection that failed.
 */

const STEP = 1 / 60;
/** Run real frames until the spring settles, then report where it landed. */
function settle(driver, seconds = 10) {
  let last = driver.snapshot();
  for (let t = 0; t < seconds; t += STEP) last = driver.advance(STEP);
  return last;
}
const milestone = (name) => HANDSHAKE_MILESTONES[name];

// ── 1. Nothing moves without an event ──────────────────────────────────────
const idle = new HandshakeDriver();
const start = idle.snapshot();
assert.equal(start.reference, DECRYPTION_START);
assert.equal(start.frame.phase, "waiting");
assert.equal(start.clarity, 0);
assert.equal(start.frozen, false);
assert.equal(start.milestone, null);

const idleAfter = settle(idle, 30);
assert.equal(
  idleAfter.reference,
  DECRYPTION_START,
  "30s of frames with no events must change nothing",
);
assert.equal(idleAfter.clarity, 0);
assert.equal(
  idleAfter.frame.phase,
  "waiting",
  "the phase may not advance on time alone",
);

// ── 2. Each real event moves the animation to its own milestone ────────────
const walk = new HandshakeDriver();
const walkOrder = [
  ["config.loaded", "waiting"],
  ["tcp.connecting", "joining"],
  ["tcp.established", "joining"],
  ["banner.remote", "joining"],
  ["kex.algorithms", "joining"],
  ["kex.ciphers", "joining"],
  ["hostkey.received", "joining"],
  ["hostkey.verified", "connected"],
  ["auth.methods", "connected"],
  ["auth.accepted", "connected"],
  ["auth.succeeded", "connected"],
  ["session.entering", "retracting"],
  ["session.authenticated", "clear"],
];
for (const [event, phase] of walkOrder) {
  assert.equal(walk.apply(event), true, `${event} should advance the timeline`);
  const state = settle(walk);
  assert.equal(
    state.reference,
    milestone(event),
    `${event} should settle on its milestone`,
  );
  assert.equal(
    state.frame.phase,
    phase,
    `${event} belongs to decryption phase ${phase}`,
  );
  assert.equal(state.settled, true);
  if (
    phase === "waiting" ||
    phase === "joining" ||
    phase === "connected" ||
    phase === "retracting"
  )
    assert.equal(
      state.clarity,
      0,
      `${phase} is before the reveal, so the glass stays frosted`,
    );
}

// The reveal itself is traversed between two real events, not by its own timer.
const revealWalk = new HandshakeDriver();
revealWalk.apply("session.entering");
settle(revealWalk);
assert.equal(
  revealWalk.snapshot().clarity,
  0,
  "the reveal has not started yet",
);
revealWalk.apply("session.authenticated");
const samples = [];
for (let t = 0; t < 12; t += STEP) samples.push(revealWalk.advance(STEP));
const partial = samples.filter(
  (state) => state.clarity > 0 && state.clarity < 1,
);
assert.equal(samples[0].clarity, 0, "the glass starts frosted");
assert.ok(
  partial.length >= 3,
  `the glass must clear over several frames, saw ${partial.length}`,
);
assert.ok(
  partial.every((state) => state.frame.phase === "revealing"),
  "every intermediate frame belongs to the revealing phase",
);
assert.equal(samples[samples.length - 1].clarity, 1, "and it ends fully clear");

// markInteractive() completes the reveal for a session whose terminal is
// demonstrably live even if the log never printed its final line.
const prompted = new HandshakeDriver();
prompted.apply("session.entering");
settle(prompted);
assert.equal(prompted.snapshot().clarity, 0, "the shell was still starting");
assert.equal(prompted.markInteractive(), true);
const done = settle(prompted);
assert.equal(done.reference, DECRYPTION_END);
assert.equal(done.frame.phase, "clear");
assert.equal(done.clarity, 1);
assert.equal(done.milestone, "session.prompt");
assert.equal(
  prompted.markInteractive(),
  false,
  "an already clear session stays clear",
);

// A driver that already reached the end via the log is not advanced again.
assert.equal(walk.snapshot().reference, DECRYPTION_END);
assert.equal(
  walk.markInteractive(),
  false,
  "the log already finished the reveal",
);

// ── 3. A late or duplicated line never rewinds ─────────────────────────────
const late = new HandshakeDriver();
late.apply("auth.accepted");
settle(late);
const parked = late.snapshot().reference;
assert.equal(
  late.apply("tcp.established"),
  false,
  "an earlier milestone is refused",
);
assert.equal(
  late.apply("auth.accepted"),
  false,
  "a repeated milestone is refused",
);
assert.equal(settle(late).reference, parked);

// ── 4. Failures park where the evidence stopped (the acceptance criterion) ──
const FAILURE_CASES = [
  {
    name: "dns failure",
    events: ["config.loaded", "dns.failed"],
    floor: milestone("config.loaded"),
    phase: "waiting",
  },
  {
    name: "tcp timeout",
    events: ["config.loaded", "tcp.connecting", "tcp.failed"],
    floor: milestone("tcp.connecting"),
    phase: "joining",
  },
  {
    name: "kex reset (the real captured case)",
    events: [
      "config.loaded",
      "tcp.connecting",
      "tcp.established",
      "banner.local",
      "kex.algorithms",
      "kex.reset",
    ],
    floor: milestone("kex.algorithms"),
    phase: "joining",
  },
  {
    name: "host key mismatch",
    events: [
      "config.loaded",
      "tcp.connecting",
      "tcp.established",
      "kex.ciphers",
      "hostkey.received",
      "hostkey.mismatch",
    ],
    floor: milestone("hostkey.received"),
    phase: "joining",
  },
  {
    name: "authentication denied",
    events: [
      "config.loaded",
      "tcp.connecting",
      "tcp.established",
      "kex.ciphers",
      "hostkey.verified",
      "auth.methods",
      "auth.accepted",
      "auth.denied",
    ],
    floor: milestone("auth.accepted"),
    phase: "connected",
  },
];

for (const testCase of FAILURE_CASES) {
  const driver = new HandshakeDriver();
  for (const event of testCase.events) driver.apply(event);
  const stopped = settle(driver, 60);

  assert.equal(
    stopped.frozen,
    true,
    `${testCase.name}: the timeline must freeze`,
  );
  assert.equal(
    stopped.reference,
    testCase.floor,
    `${testCase.name}: must park on the last real milestone`,
  );
  assert.equal(
    stopped.frame.phase,
    testCase.phase,
    `${testCase.name}: must stay in the reached phase`,
  );
  assert.ok(
    stopped.reference < DECRYPTION_END,
    `${testCase.name}: a failed connection must never look decrypted`,
  );
  assert.equal(
    stopped.clarity,
    0,
    `${testCase.name}: the glass must not clear`,
  );

  // And it stays frozen no matter what arrives afterwards.
  assert.equal(driver.apply("session.entering"), false);
  assert.equal(driver.apply("auth.succeeded"), false);
  assert.equal(driver.markInteractive(), false);
  assert.equal(settle(driver, 30).reference, testCase.floor);
}

// ── 5. A real captured log drives the driver end to end ────────────────────
const CAPTURED = [
  "debug1: Reading configuration data C:\\\\Users\\\\operator/.ssh/config",
  "debug1: Connecting to github.com [198.18.1.17] port 22.",
  "debug1: Connection established.",
  "debug1: Local version string SSH-2.0-OpenSSH_for_Windows_9.5",
  "kex_exchange_identification: Connection closed by remote host",
  "Connection closed by 198.18.1.17 port 22",
];
const captured = new HandshakeDriver();
for (const line of CAPTURED) {
  const parsed = parseSshLine(line);
  if (parsed.matched) {
    captured.advance(STEP);
    captured.apply(parsed.event.name);
  }
}
const capturedState = settle(captured, 60);
assert.equal(capturedState.frozen, true);
assert.equal(capturedState.frame.phase, "joining");
assert.equal(capturedState.clarity, 0);
assert.equal(
  capturedState.reference,
  milestone("banner.local"),
  "it got as far as the version banner",
);

// ── 6. reset() clears everything ───────────────────────────────────────────
captured.reset();
const cleared = captured.snapshot();
assert.equal(cleared.reference, DECRYPTION_START);
assert.equal(cleared.frozen, false);
assert.equal(cleared.milestone, null);
assert.equal(cleared.clarity, 0);

// ── 7. Milestones stay inside the decryption timeline and stay ordered ──────
const ordered = Object.entries(HANDSHAKE_MILESTONES);
for (const [name, value] of ordered) {
  assert.ok(
    value >= DECRYPTION_START && value <= DECRYPTION_END,
    `${name} must sit on the timeline`,
  );
}
const byValue = [...ordered].sort((a, b) => a[1] - b[1]).map(([name]) => name);
const handshakeOrder = [
  "config.loaded",
  "tcp.connecting",
  "tcp.established",
  "banner.local",
  "banner.remote",
  "kex.algorithms",
  "kex.ciphers",
  "hostkey.received",
  "hostkey.unknown",
  "hostkey.verified",
  "auth.methods",
  "auth.offering",
  "auth.accepted",
  "auth.succeeded",
  "session.entering",
  "session.authenticated",
];
assert.deepEqual(
  byValue.filter((name) => name !== "hostkey.unknown"),
  handshakeOrder.filter((name) => name !== "hostkey.unknown"),
  "milestone order must follow the real handshake order",
);

console.log("SSH handshake driver checks passed.");
