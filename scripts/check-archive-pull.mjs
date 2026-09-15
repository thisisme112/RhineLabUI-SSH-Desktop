import test from "node:test";
import assert from "node:assert/strict";
import { ArchivePull } from "../src/archive-pull.ts";

const start = (projection = { x: 0, y: -100 }) => {
  const pull = new ArchivePull();
  pull.start(100, 400, projection, .4, 4.05);
  return pull;
};

test("small pointer jitter remains a click without extracting", () => {
  const pull = start();
  assert.equal(pull.move(103, 395), true);
  assert.equal(pull.active, false);
  assert.equal(pull.ready, false);
  assert.equal(pull.height, .4);
});

test("pull height follows the camera projection at different display scales", () => {
  for (const scale of [.65, 1, 1.5, 2]) {
    const pull = start({ x: 20 * scale, y: -100 * scale });
    assert.equal(pull.move(100 + 40 * scale, 400 - 200 * scale), true);
    assert.ok(Math.abs(pull.height - 2.4) < 1e-9);
    assert.equal(pull.ready, true);
  }
});

test("reversing a pull before release cancels the opening threshold", () => {
  const pull = start();
  pull.move(100, 200);
  assert.equal(pull.ready, true);
  pull.move(100, 380);
  assert.equal(pull.ready, false);
  assert.ok(Math.abs(pull.height - .6) < 1e-9);
  pull.move(100, 450);
  assert.equal(pull.height, .4);
});

test("a plane drag can turn upward without turning into extraction", () => {
  for (const point of [[125, 400], [100, 425], [125, 380]]) {
    const pull = start();
    assert.equal(pull.move(...point), false);
    assert.equal(pull.move(100, 100), false);
    assert.equal(pull.active, false);
  }
});

test("overshoot stays within the existing extraction height; cancel clears state", () => {
  const pull = start();
  pull.move(100, -2000);
  assert.equal(pull.height, 4.05);
  pull.reset();
  assert.equal(pull.ready, false);
  assert.equal(pull.move(100, -2200), false);
});

test("taking over a returning, fully raised model can still commit", () => {
  const pull = start();
  pull.start(100, 400, {x:0,y:-100}, 4.05, 4.05);
  pull.move(100, 380);
  assert.equal(pull.ready, true);
  assert.equal(pull.progress, 1);
});

test("a returning model can also be pulled back below the opening threshold", () => {
  const pull = start();
  pull.start(100, 400, {x:0,y:-100}, 3, 4.05);
  pull.move(100, 380);
  assert.equal(pull.ready, true);
  pull.move(100, 620);
  assert.equal(pull.ready, false);
  assert.ok(Math.abs(pull.height - .8) < 1e-9);
  pull.move(100, 800);
  assert.equal(pull.height, .4);
});
