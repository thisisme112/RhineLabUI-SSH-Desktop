/**
 * Where the window was: its position, size and whether it was maximised,
 * restored at the next start as the Unreal build does. Only placement is kept,
 * never content, and a position that no display shows any more (an unplugged
 * monitor, a changed layout) falls back to the primary display.
 *
 * Placement is a pure function of the saved state and the displays, so it can
 * be checked without Electron (scripts/check/check-window-state.mjs).
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const DEFAULT = { width: 1600, height: 900 };
const MINIMUM = { width: 1024, height: 640 };
/** The caption strip that must stay reachable to move the window back. */
const GRIP = { width: 160, height: 40 };

const finite = (value) => Number.isFinite(value) && Math.abs(value) < 100000;

function readState(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const bounds = data?.bounds;
    if (data?.version !== 1 || !bounds || !["x", "y", "width", "height"].every((key) => finite(bounds[key])))
      return null;
    return { bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, maximized: data.maximized === true };
  } catch {
    return null;
  }
}

/**
 * @param {{bounds:{x:number,y:number,width:number,height:number}, maximized:boolean} | null} state
 * @param {{workArea:{x:number,y:number,width:number,height:number}}[]} displays
 * @param {{workArea:{x:number,y:number,width:number,height:number}}} primary
 */
function placement(state, displays, primary) {
  const area = primary.workArea;
  const fit = (size, room, minimum) => Math.round(Math.max(minimum, Math.min(size, room)));
  const centred = (width, height) => ({
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  });
  if (!state) return { bounds: centred(fit(DEFAULT.width, area.width, MINIMUM.width), fit(DEFAULT.height, area.height, MINIMUM.height)), maximized: false };
  const { x, y, width, height } = state.bounds;
  // The caption must lie on a display: enough of its width, and its top inside.
  const shown = displays.find(({ workArea: a }) =>
    Math.min(x + width, a.x + a.width) - Math.max(x, a.x) >= Math.min(GRIP.width, width) &&
    y >= a.y && y + GRIP.height <= a.y + a.height);
  if (!shown) return { bounds: centred(fit(width, area.width, MINIMUM.width), fit(height, area.height, MINIMUM.height)), maximized: state.maximized };
  const a = shown.workArea;
  return {
    bounds: { x: Math.round(x), y: Math.round(y), width: fit(width, a.width, MINIMUM.width), height: fit(height, a.height, MINIMUM.height) },
    maximized: state.maximized,
  };
}

/** How far a window without a native caption lands from the bounds it was given. */
const SLACK = 4;

class WindowState {
  constructor(file) {
    this.file = file;
    this.timer = null;
    this.applied = null;
  }
  placement(displays, primary) {
    this.applied = placement(readState(this.file), displays, primary);
    return this.applied;
  }
  /** Saves the normal (unmaximised) bounds as they settle, and once more on close. */
  track(win) {
    const save = () => {
      clearTimeout(this.timer);
      this.timer = null;
      if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
      const bounds = win.getNormalBounds(), applied = this.applied?.bounds;
      // Measured on Electron 44 at 150 %: a window without a native caption is
      // created 4 px wider than asked and setBounds lands 1 px wide. Saving that
      // would grow the window on every start, so an untouched window keeps the
      // placement it was given.
      const untouched = applied && ["x", "y", "width", "height"].every((key) => Math.abs(bounds[key] - applied[key]) <= SLACK);
      this.write({ version: 1, bounds: untouched ? applied : bounds, maximized: win.isMaximized() });
    };
    const later = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(save, 400);
      this.timer.unref?.();
    };
    for (const name of ["resize", "move", "maximize", "unmaximize"]) win.on(name, later);
    win.on("close", save);
  }
  write(state) {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(state), { flag: "wx" });
      fs.renameSync(temporary, this.file);
    } catch {
      /* A placement that cannot be saved only costs the next start its position. */
    } finally {
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* best effort */ }
    }
  }
}

module.exports = { WindowState, placement, readState, DEFAULT, MINIMUM };
