// Unit checks for the theme turn-over wave (src/features/theme/theme-motion.ts PaletteFlip): the motion is the Unreal build's ThemeCellMotion.
import assert from "node:assert/strict";
import test from "node:test";
import { FLIP_LIFT, FLIP_SPAN, FLIP_TILT, PaletteFlip } from "../../src/features/theme/theme-motion.ts";

const origin = { row: 12, lane: 2 };
const at = (flip, cell, t) => flip.sample(cell, 10 + t);
const wave = () => { const flip = new PaletteFlip(); flip.begin(10, origin); return flip; };
// The selected card's turn starts after the .04 s lead and takes .6 s.
const turn = (p) => 0.04 + p * 0.6;

test("before its turn a card shows the old theme, after it the new one", () => {
  const flip = wave();
  assert.deepEqual(at(flip, origin, -0.01), { lift: 0, tilt: 0, flash: 0, swap: 0 });
  assert.deepEqual(at(flip, origin, 0.03), { lift: 0, tilt: 0, flash: 0, swap: 0 });
  assert.deepEqual(at(flip, origin, FLIP_SPAN + 0.1), { lift: 0, tilt: 0, flash: 0, swap: 1 });
  assert.equal(flip.active(9.99), false);
  assert.equal(flip.active(10.5), true);
  assert.equal(flip.active(10 + FLIP_SPAN + 0.01), false);
});

test("a card changes edge-on at 31% of its turn, in its flash", () => {
  const flip = wave();
  assert.equal(at(flip, origin, turn(0.30)).swap, 0);
  assert.equal(at(flip, origin, turn(0.32)).swap, 1);
  const samples = Array.from({ length: 61 }, (_, i) => at(flip, origin, turn(i / 60)).flash);
  const peak = samples.indexOf(Math.max(...samples));
  assert.ok(Math.abs(peak / 60 - 0.31) <= 1 / 60, `the flash peaks at ${(peak / 60).toFixed(2)} of the turn`);
  assert.ok(Math.max(...samples) > 0.99);
  assert.ok(samples[0] < 0.01 && samples[60] < 0.01);
});

test("a card rises to the full lift at 31%, leans most at the middle, and settles with an overshoot", () => {
  const flip = wave();
  assert.ok(Math.abs(at(flip, origin, turn(0.31)).lift - FLIP_LIFT) < 1e-3, "the top of the rise");
  assert.ok(Math.abs(at(flip, origin, turn(0.5)).tilt - FLIP_TILT) < 1e-9, "the most lean");
  assert.ok(at(flip, origin, turn(0.8)).lift < 0, "below its row for a moment before it settles");
});

test("a card further out starts later, by .03 s a row and .066 s a lane", () => {
  const flip = wave();
  const far = { row: origin.row + 10, lane: origin.lane };
  assert.equal(at(flip, far, turn(0) + 0.29).lift, 0, "still waiting");
  assert.ok(at(flip, far, turn(0) + 0.31).lift > 0, "started after .3 s");
  const sideways = { row: origin.row, lane: origin.lane + 2 };
  assert.equal(at(flip, sideways, turn(0) + 0.13).lift, 0);
  assert.ok(at(flip, sideways, turn(0) + 0.14).lift > 0);
});

test("every card has turned by the end of the wave, however far it is", () => {
  const flip = wave();
  for (const cell of [{ row: origin.row + 40, lane: origin.lane + 6 }, { row: origin.row - 30, lane: origin.lane - 4 }])
    assert.equal(at(flip, cell, FLIP_SPAN).swap, 1);
});

test("the selected file eases into the new theme over .45 s", () => {
  const flip = wave();
  assert.equal(flip.single(9.9), 0);
  assert.ok(Math.abs(flip.single(10.225) - 0.5) < 1e-9);
  assert.equal(flip.single(10.45), 1);
  assert.equal(flip.single(12), 1);
});

test("a delayed wave waits", () => {
  const flip = new PaletteFlip();
  flip.begin(10, origin, 0.35);
  assert.equal(flip.active(10.2), false);
  assert.equal(flip.sample(origin, 10.2).swap, 0);
  assert.ok(flip.sample(origin, 10.35 + turn(0.2)).lift > 0);
});
