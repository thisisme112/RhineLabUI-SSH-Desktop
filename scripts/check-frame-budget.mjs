// Unit checks for the frame gate (src/frame-budget.ts): the rates each tier admits on a 120 Hz and a 60 Hz display.
import assert from "node:assert/strict";
import test from "node:test";
import { ANDROID_RATES, DESKTOP_RATES, FrameBudget, ResolutionGovernor } from "../src/frame-budget.ts";

/** Run `seconds` of animation frames at `hz`; `each(now, budget)` may report busy/active before the gate is asked. */
function run(budget, hz, seconds, each = () => {}, background = false, start = 1000) {
  const step = 1000 / hz;
  let admitted = 0;
  for (let now = start; now < start + seconds * 1000; now += step) {
    each(now, budget);
    if (budget.admit(now, background)) admitted++;
  }
  return admitted / seconds;
}
const near = (actual, expected, tolerance = expected * 0.08 + 1) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected about ${expected} fps, measured ${actual.toFixed(1)}`);

test("an untouched scene idles at 30 fps on a 120 Hz display", () => {
  const budget = new FrameBudget(DESKTOP_RATES);
  run(budget, 120, 1); // let the refresh estimate settle
  near(run(budget, 120, 4, () => {}, false, 3000), 30);
  assert.equal(budget.tier, "idle");
});

test("an untouched scene idles at 30 fps on a 60 Hz display", () => {
  const budget = new FrameBudget(DESKTOP_RATES);
  run(budget, 60, 1);
  near(run(budget, 60, 4, () => {}, false, 3000), 30);
});

test("busy follows the display on desktop and stops at 60 on a phone", () => {
  const desktop = new FrameBudget(DESKTOP_RATES);
  near(run(desktop, 120, 3, (now, b) => b.busy(now, 600)), 120);
  const phone = new FrameBudget(ANDROID_RATES);
  run(phone, 120, 1, (now, b) => b.busy(now, 600));
  near(run(phone, 120, 3, (now, b) => b.busy(now, 600), false, 3000), 60);
});

test("active holds 60 fps", () => {
  const budget = new FrameBudget(DESKTOP_RATES);
  run(budget, 120, 1);
  near(run(budget, 120, 3, (now, b) => b.active(now, 3200), false, 3000), 60);
  assert.equal(budget.tier, "active");
});

test("a background window drops to 15 fps however busy it was", () => {
  const budget = new FrameBudget(DESKTOP_RATES);
  run(budget, 120, 1, (now, b) => b.busy(now, 5000));
  near(run(budget, 120, 4, (now, b) => b.busy(now, 5000), true, 3000), 15);
  assert.equal(budget.tier, "background");
});

test("busy decays back to idle once nothing has moved for its hold time", () => {
  const budget = new FrameBudget(DESKTOP_RATES);
  run(budget, 120, 1);
  budget.busy(2000, 500);
  run(budget, 120, 0.4, () => {}, false, 2000);
  assert.equal(budget.tier, "busy");
  run(budget, 120, 1, () => {}, false, 2600);
  assert.equal(budget.tier, "idle");
});

test("input during idle is admitted at once, not on the idle grid", () => {
  const budget = new FrameBudget(DESKTOP_RATES);
  run(budget, 120, 2);
  const now = 3000 + 4 * (1000 / 120);
  budget.busy(now, 2000);
  assert.equal(budget.admit(now), true);
  assert.equal(budget.admit(now + 1000 / 120), true);
});

/** Feed `seconds` of frames of `dt` ms; returns the factors the governor announced. */
function feed(governor, start, seconds, dt, target = 1000 / 60) {
  const changes = [];
  for (let now = start; now < start + seconds * 1000; now += dt) {
    const next = governor.observe(now, dt, target);
    if (next !== null) changes.push([Math.round(now), next]);
  }
  return changes;
}

test("frames that keep up leave the resolution alone", () => {
  const governor = new ResolutionGovernor();
  assert.deepEqual(feed(governor, 0, 30, 16.7), []);
  assert.equal(governor.factor, 1);
});

test("a run of slow frames steps the resolution down, one step at a time, never below the floor", () => {
  const governor = new ResolutionGovernor(0.6, 0.1);
  const changes = feed(governor, 0, 30, 34);
  assert.deepEqual(changes.map(([, f]) => f), [0.9, 0.8, 0.7, 0.6]);
  assert.equal(governor.factor, 0.6);
  // The first step needs about 1.5 s of slowness, not one bad frame.
  assert.ok(changes[0][0] >= 1400 && changes[0][0] < 2000, `first step at ${changes[0][0]} ms`);
});

test("a single stall is not the scene's fault", () => {
  const governor = new ResolutionGovernor();
  feed(governor, 0, 5, 16.7);
  assert.equal(governor.observe(6000, 900, 16.7), null);
  feed(governor, 6100, 5, 16.7);
  assert.equal(governor.factor, 1);
});

test("once the frames keep up again the resolution steps back up, slowly", () => {
  const governor = new ResolutionGovernor();
  feed(governor, 0, 4, 34);          // down to 0.8 or so
  const low = governor.factor;
  assert.ok(low < 1);
  const ups = feed(governor, 10000, 60, 16.7);
  assert.ok(ups.length >= 1, "it recovers");
  assert.ok(ups[0][0] - 10000 >= 5900, "not before six seconds of good frames");
  assert.ok(governor.factor > low);
});

test("a step up that immediately proves too much becomes the ceiling", () => {
  const governor = new ResolutionGovernor(0.6, 0.1);
  feed(governor, 0, 3, 34);                          // down to 0.8
  const before = governor.factor;
  const up = feed(governor, 10000, 8, 16.7);         // recovers one step, to 0.9
  assert.ok(up.length >= 1);
  const raised = governor.factor;
  assert.ok(raised > before);
  const raisedAt = up[0][0];
  feed(governor, raisedAt + 500, 3, 34);             // slow again within 15 s: that size failed
  assert.ok(governor.factor <= before + 1e-9, `back to ${governor.factor}`);
  const later = feed(governor, raisedAt + 30000, 60, 16.7);
  assert.ok(later.every(([, f]) => f <= before + 1e-9), "it does not climb back to the size that failed");
});