// Unit checks for the palette flip wave (src/features/theme/theme-motion.ts PaletteFlip): timings and amplitudes are the Unreal build's.
import assert from "node:assert/strict";
import test from "node:test";
import { FLIP_LIFT, FLIP_TILT, PaletteFlip } from "../../src/features/theme/theme-motion.ts";

const origin = { row: 12, lane: 2 };
const at = (flip, cell, t) => flip.sample(cell, 10 + t);
const wave = () => { const flip = new PaletteFlip(); flip.begin(10, origin); return flip; };

test("nothing moves before the wave starts or after it has ended", () => {
  const flip = wave();
  assert.deepEqual(at(flip, origin, -0.01), { lift: 0, tilt: 0, flash: 0 });
  assert.deepEqual(at(flip, origin, 2.5), { lift: 0, tilt: 0, flash: 0 });
  assert.equal(flip.active(9.99), false);
  assert.equal(flip.active(10.5), true);
  assert.equal(flip.active(12.5), false);
});

test("the selected card turns first: it peaks at the middle of its .6 s turn", () => {
  const flip = wave();
  const top = at(flip, origin, 0.3);
  assert.ok(Math.abs(top.lift - FLIP_LIFT) < 1e-6, `lift ${top.lift}`);
  assert.ok(Math.abs(top.tilt - FLIP_TILT) < 1e-6);
  assert.ok(at(flip, origin, 0.05).lift < top.lift && at(flip, origin, 0.55).lift < top.lift);
});

test("a card further out starts later, by .03 s a row and .09 s a lane", () => {
  const flip = wave();
  const far = { row: origin.row + 10, lane: origin.lane };
  assert.equal(at(flip, far, 0.29).lift, 0, "still waiting");
  assert.ok(at(flip, far, 0.31).lift > 0, "started after .3 s");
  const sideways = { row: origin.row, lane: origin.lane + 2 };
  assert.equal(at(flip, sideways, 0.17).lift, 0);
  assert.ok(at(flip, sideways, 0.19).lift > 0);
});

test("the flash rises and falls inside the turn, peaking a little before the top", () => {
  const flip = wave();
  const samples = Array.from({ length: 61 }, (_, i) => at(flip, origin, i * 0.01).flash);
  const peak = samples.indexOf(Math.max(...samples));
  assert.ok(peak >= 18 && peak <= 24, `flash peaks at ${peak * 10} ms`);
  assert.ok(Math.max(...samples) > 0.99);
  assert.equal(samples[0], 0);
  assert.equal(samples[60], 0);
});

test("the whole wave lasts about 1.2 s plus one turn, whatever the distance", () => {
  const flip = wave();
  const corner = { row: origin.row + 40, lane: origin.lane + 6 };
  let lastMoving = 0;
  for (let t = 0; t < 3; t += 0.01) if (at(flip, corner, t).lift > 0) lastMoving = t;
  assert.ok(lastMoving <= 1.8 + 0.01, `the farthest card is still moving at ${lastMoving.toFixed(2)} s`);
});

test("a delayed wave waits for the change-over's reveal", () => {
  const flip = new PaletteFlip();
  flip.begin(10, origin, 0.35);
  assert.equal(flip.active(10.2), false);
  assert.equal(flip.sample(origin, 10.2).lift, 0);
  assert.ok(flip.sample(origin, 10.65).lift > 0);
});
