import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const { WindowState, placement, readState } = require("../../electron/window-state.cjs");

const display = (x, y, width, height) => ({ workArea: { x, y, width, height } });
const primary = display(0, 0, 1920, 1040);
const right = display(1920, 0, 2560, 1400);
const saved = (x, y, width = 1400, height = 820, maximized = false) => ({ bounds: { x, y, width, height }, maximized });

// No saved placement: the default size, centred on the primary display.
assert.deepEqual(placement(null, [primary], primary), { bounds: { x: 160, y: 70, width: 1600, height: 900 }, maximized: false });
// A small display still gets the minimum size, never more than it can show.
const small = display(0, 0, 1280, 680);
assert.deepEqual(placement(null, [small], small).bounds, { x: 0, y: 0, width: 1280, height: 680 });
// A window on the second display stays there, maximised or not.
assert.deepEqual(placement(saved(2100, 120, 1400, 820, true), [primary, right], primary), { bounds: { x: 2100, y: 120, width: 1400, height: 820 }, maximized: true });
// Its display unplugged: back to the primary, keeping the size and the maximised flag.
assert.deepEqual(placement(saved(2100, 120, 1400, 820, true), [primary], primary), { bounds: { x: 260, y: 110, width: 1400, height: 820 }, maximized: true });
// The caption above the top of every display could not be grabbed again.
assert.equal(placement(saved(100, -60), [primary], primary).bounds.y, 110);
// Mostly off the left edge with too little caption showing: recentred.
assert.equal(placement(saved(-1300, 100), [primary], primary).bounds.x, 260);
// Enough caption showing on an edge: kept as it was.
assert.equal(placement(saved(-1200, 100), [primary], primary).bounds.x, -1200);
// A size larger than its display is fitted to it, never below the minimum.
assert.deepEqual(placement(saved(0, 0, 4000, 3000), [primary], primary).bounds, { x: 0, y: 0, width: 1920, height: 1040 });
assert.deepEqual(placement(saved(10, 10, 300, 200), [primary], primary).bounds, { x: 10, y: 10, width: 1024, height: 640 });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rhine-window-state-"));
try {
  const file = path.join(dir, "window-state.json");
  assert.equal(readState(file), null, "no file is no placement");
  for (const text of ["broken", JSON.stringify({ version: 2, bounds: { x: 0, y: 0, width: 1, height: 1 } }), JSON.stringify({ version: 1, bounds: { x: "0", y: 0, width: 1600, height: 900 } }), JSON.stringify({ version: 1, bounds: { x: 1e9, y: 0, width: 1600, height: 900 } })]) {
    fs.writeFileSync(file, text);
    assert.equal(readState(file), null, `rejected: ${text}`);
  }
  const state = new WindowState(file);
  state.write({ version: 1, bounds: { x: 40, y: 50, width: 1500, height: 860 }, maximized: true });
  assert.deepEqual(readState(file), { bounds: { x: 40, y: 50, width: 1500, height: 860 }, maximized: true });
  assert.deepEqual(state.placement([primary], primary), { bounds: { x: 40, y: 50, width: 1500, height: 860 }, maximized: true });
  assert.deepEqual(fs.readdirSync(dir), ["window-state.json"], "no temporary file is left behind");
  // A window without a native caption lands a few pixels from what it was given;
  // untouched, it keeps that placement instead of growing on every start.
  const handlers = {};
  let normal = { x: 40, y: 50, width: 1504, height: 861 }, maximized = false;
  state.track({ on: (name, fn) => (handlers[name] = fn), isDestroyed: () => false, isMinimized: () => false, isFullScreen: () => false,
    isMaximized: () => maximized, getNormalBounds: () => normal });
  handlers.close();
  assert.deepEqual(readState(file), { bounds: { x: 40, y: 50, width: 1500, height: 860 }, maximized: false });
  normal = { x: 300, y: 50, width: 1504, height: 861 }; maximized = true;
  handlers.close();
  assert.deepEqual(readState(file), { bounds: normal, maximized: true }, "a moved window is saved where it is");
} finally {
  assert.ok(path.basename(dir).startsWith("rhine-window-state-"));
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log("Window placement: default, small displays, second and unplugged displays, edges and persistence checks passed.");
