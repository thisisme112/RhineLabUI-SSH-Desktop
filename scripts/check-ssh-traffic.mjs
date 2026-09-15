import assert from "node:assert/strict";
import { TrafficMeter, normalizeRate } from "../src/ssh/traffic.ts";

/**
 * The meter is the only thing standing between "the array responds to network
 * activity" and "the array waves at nothing". Its contract is therefore mostly
 * negative: no readings, no movement — and silence must decay back to quiet
 * rather than freezing at the last value.
 */

// ── 1. Normalisation curve ─────────────────────────────────────────────────
assert.equal(normalizeRate(0), 0);
assert.equal(normalizeRate(-100), 0, "a negative rate is not activity");
assert.equal(normalizeRate(Number.NaN), 0);
assert.equal(normalizeRate(Number.POSITIVE_INFINITY), 1);

const quiet = normalizeRate(64);
assert.ok(
  quiet > 0.05 && quiet < 0.1,
  `one reference rate should read as slight activity, got ${quiet}`,
);
// Monotonic and bounded: more bytes can never read as less activity.
let previous = -1;
for (const rate of [0, 8, 64, 512, 4096, 65536, 1048576, 16777216]) {
  const value = normalizeRate(rate);
  assert.ok(value >= previous, `normalizeRate must not decrease at ${rate}`);
  assert.ok(
    value >= 0 && value <= 1,
    `normalizeRate must stay in 0..1 at ${rate}`,
  );
  previous = value;
}
assert.equal(
  normalizeRate(6.4 * 1024 * 1024),
  1,
  "a saturated link reads as full",
);

// ── 2. No readings, no movement ────────────────────────────────────────────
const idle = new TrafficMeter();
for (let t = 0; t < 10_000; t += 250) idle.update(t);
assert.deepEqual(
  { ...idle.value },
  { low: 0, mid: 0, high: 0, activity: 0 },
  "ten seconds of frames with no readings must stay quiet",
);

// ── 3. Downstream moves the low band, upstream moves the mid band ──────────
const meter = new TrafficMeter();
const step = 250;
let clock = 0;
let bytesIn = 0;
let bytesOut = 0;
const feed = (incrementIn, incrementOut) => {
  clock += step;
  bytesIn += incrementIn;
  bytesOut += incrementOut;
  meter.sample(clock, bytesIn, bytesOut);
  return meter.update(clock);
};

// ~64 KiB/s down for two seconds.
for (let i = 0; i < 8; i++) feed(16 * 1024, 0);
assert.ok(
  meter.value.low > 0.5,
  `sustained downstream should lift the low band, got ${meter.value.low}`,
);
assert.ok(
  meter.value.mid < 0.02,
  "no upstream traffic must leave the mid band quiet",
);
assert.ok(
  meter.measurements.bytesPerSecondIn > 60_000,
  "the raw rate is kept for the detail surface",
);

// Now the same on the upstream side.
const upstream = new TrafficMeter();
let upClock = 0;
let upIn = 0;
let upOut = 0;
for (let i = 0; i < 8; i++) {
  upClock += step;
  upIn += 0;
  upOut += 16 * 1024;
  upstream.sample(upClock, upIn, upOut);
  upstream.update(upClock);
}
assert.ok(
  upstream.value.mid > 0.5,
  "sustained upstream should lift the mid band",
);
assert.ok(
  upstream.value.low < 0.02,
  "no downstream traffic must leave the low band quiet",
);

// ── 4. A burst reads on the short timescale before the average catches up ──
const burst = new TrafficMeter();
let burstClock = 0;
let burstBytes = 0;
for (let i = 0; i < 4; i++) {
  burstClock += step;
  burst.sample(burstClock, burstBytes, 0);
  burst.update(burstClock);
}
const beforeBurst = { ...burst.value };
burstClock += step;
burstBytes += 400 * 1024; // one very large chunk in a single interval
burst.sample(burstClock, burstBytes, 0);
burst.update(burstClock);
assert.ok(
  burst.value.high > beforeBurst.high,
  "a burst must lift the high band",
);
assert.ok(
  burst.value.high > burst.value.low,
  "the burst band reacts faster than the sustained average",
);

// ── 5. Silence decays back to quiet rather than freezing ───────────────────
const decay = new TrafficMeter();
let decayClock = 0;
let decayBytes = 0;
for (let i = 0; i < 8; i++) {
  decayClock += step;
  decayBytes += 32 * 1024;
  decay.sample(decayClock, decayBytes, 0);
  decay.update(decayClock);
}
assert.ok(decay.value.activity > 0.3, "traffic was flowing");
for (let i = 0; i < 400; i++) {
  decayClock += step;
  decay.sample(decayClock, decayBytes, 0); // counters frozen: nothing arrives
  decay.update(decayClock);
}
assert.ok(
  decay.value.activity < 0.01,
  `bands must fall back to quiet, got ${decay.value.activity}`,
);
assert.equal(
  decay.measurements.bytesPerSecondIn,
  0,
  "a frozen counter is zero throughput",
);

// ── 6. reset() clears the meter for a new session ──────────────────────────
decay.reset();
assert.deepEqual({ ...decay.value }, { low: 0, mid: 0, high: 0, activity: 0 });
assert.equal(decay.measurements.samples, 0);

// ── 7. Out-of-order or duplicate readings cannot produce negative activity ──
const noisy = new TrafficMeter();
noisy.sample(1000, 5000, 5000);
noisy.update(1000);
noisy.sample(1000, 5000, 5000); // same instant, same counters
noisy.update(1000);
noisy.sample(900, 100, 100); // an older stamp
const bands = noisy.update(1250);
for (const [name, value] of Object.entries(bands))
  assert.ok(
    value >= 0 && Number.isFinite(value),
    `${name} must stay a finite non-negative number`,
  );

console.log("SSH traffic meter checks passed.");
