import { sigil } from "../../shared/sigil";

/**
 * The label design's shared parts (the Unreal build's RhineLabel.h): its timing,
 * the figure that resolves digit by digit, the 5 × 5 mark, the convex outline
 * the archive cuts out of a frame, and the zone a point of the window lies in.
 */

/** Timing in seconds: a block settles, a figure resolves, a page turns. */
export const CUT = .1, BLOCK = .5, DECODE = .7, LIFT = .6, PAGE = 1.2;

/** The sheet in stage units (the stage is 1080 tall). */
export const TOP = 72, FOOT = 136, FIELD = 704, SPINE = 64, BAND = 26, RULE = 3;

/** A CSS cubic-bezier as a function of time, by bisection (it is monotonic in x). */
function bezier(x1: number, y1: number, x2: number, y2: number) {
  const at = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let low = 0, high = 1, t = x;
    for (let i = 0; i < 24; i++) {
      t = (low + high) / 2;
      if (at(x1, x2, t) < x) low = t; else high = t;
    }
    return at(y1, y2, t);
  };
}
/** One curve for arrivals, one for long moves (RhineLabel::Settle, Glide). */
export const settle = bezier(.16, 1, .3, 1);
export const glide = bezier(.65, 0, .35, 1);
export const SETTLE_CSS = "cubic-bezier(.16, 1, .3, 1)";

/**
 * A figure that has not resolved yet shows another digit every 1/24 s; digits
 * lock from the left as `progress` runs from 0 to 1 (RhineLabel::Resolve).
 */
export function resolve(final: string, progress: number, time: number) {
  if (progress >= 1) return final;
  const tick = Math.floor(time * 24);
  let out = "";
  for (let i = 0; i < final.length; i++) {
    const c = final[i];
    if (c < "0" || c > "9" || progress * final.length > i + 1) { out += c; continue; }
    let h = (Math.imul(i, 374761393) + Math.imul(tick, 668265263)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    out += String((h >>> 16) % 10);
  }
  return out;
}

/**
 * The 5 × 5 mark of a host as SVG cells. While it turns from `from`, the cells
 * change over along the diagonal and reach the far corner at `turn` 1.
 */
export function sigilCells(key: string, from: string | undefined, turn: number) {
  const now = sigil(key), before = from === undefined ? 0 : sigil(from);
  let cells = "";
  for (let row = 0; row < 5; row++) for (let column = 0; column < 5; column++) {
    const turned = turn * 9 >= row + column + .5 || turn >= 1;
    if (((turned ? now : before) >>> (row * 5 + column)) & 1) cells += `<rect x="${column}" y="${row}" width="1.02" height="1.02"/>`;
  }
  return cells;
}
/** Which cells the mark shows at `turn`: equal keys mean an unchanged picture. */
export const sigilStep = (turn: number) => turn >= 1 ? 9 : Math.floor(turn * 9 + .5);

/** The convex outline of a set of points (Andrew's monotone chain), drawn in by `inset` towards its middle. */
export function outline(points: [number, number][], inset = 0): [number, number][] {
  if (points.length < 3) return [];
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const turn = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const hull: [number, number][] = [];
  for (let pass = 0; pass < 2; pass++) {
    const base = hull.length;
    for (let i = 0; i < sorted.length; i++) {
      const point = sorted[pass ? sorted.length - 1 - i : i];
      while (hull.length >= base + 2 && turn(hull[hull.length - 2], hull[hull.length - 1], point) <= 0) hull.pop();
      hull.push(point);
    }
    hull.pop();
  }
  if (hull.length < 3) return [];
  const mx = hull.reduce((s, p) => s + p[0], 0) / hull.length, my = hull.reduce((s, p) => s + p[1], 0) / hull.length;
  return hull.map(([x, y]) => {
    const dx = mx - x, dy = my - y, d = Math.hypot(dx, dy) || 1;
    return [x + dx / d * inset, y + dy / d * inset];
  });
}

/** An outline as an SVG path, moved by (dx, dy). */
export const outlinePath = (hull: readonly [number, number][], dx = 0, dy = 0) =>
  hull.length < 3 ? "" : `M${hull.map(([x, y]) => `${(x - dx).toFixed(1)},${(y - dy).toFixed(1)}`).join("L")}Z`;

/** "B—07": the zone of an eight by six sheet that a point of the window lies in (SRhineZoneFrame::Zone). */
export function zone(x: number, y: number, width: number, height: number) {
  const column = Math.min(8, Math.max(1, Math.floor((x - BAND) / Math.max(1, (width - BAND) / 8)) + 1));
  const row = Math.min(5, Math.max(0, Math.floor((y - BAND) / Math.max(1, (height - BAND) / 6))));
  return `${String.fromCharCode(65 + row)}—${String(column).padStart(2, "0")}`;
}

const svg = (width: number, height: number, body: string, className = "") =>
  `<svg${className ? ` class="${className}"` : ""} viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true" focusable="false">${body}</svg>`;

/** Three chevrons pointing up (SRhineMark kind 0), 30 × 76. */
export const chevrons = () => svg(30, 76, Array.from({ length: 3 }, (_, i) => {
  const y = i * 27;
  return `<polygon points="0,${y + 12} 15,${y} 15,${y + 10} 0,${y + 22}"/><polygon points="15,${y} 30,${y + 12} 30,${y + 22} 15,${y + 10}"/>`;
}).join(""), "label-chevrons");

/** A band of slashes `width` long (SRhineMark kind 1), 16 tall. */
export function slashes(width: number) {
  let body = "";
  for (let x = 0; x + 16 <= width; x += 20) body += `<polygon points="${x + 7},0 ${x + 16},0 ${x + 9},16 ${x},16"/>`;
  return svg(width, 16, body, "label-slashes");
}

/**
 * What a host offers as a square pictogram (SRhinePicto): 0 terminal, 1 files,
 * 2 monitor, 3 tunnel. Lit: a solid tile with its top-right corner cut and the
 * mark in the ground colour; unlit: a 3 px outline and the mark in ink.
 */
export function picto(kind: number) {
  const u = 36 / 36, o = (64 - 36) / 2;
  const bar = (x: number, y: number, w: number, h: number) => `<rect class="label-picto-mark" x="${o + x * u}" y="${o + y * u}" width="${w * u}" height="${h * u}"/>`;
  let mark = "";
  if (kind === 0) mark = `<polygon class="label-picto-mark" points="${o + 4},${o + 8} ${o + 16},${o + 18} ${o + 4},${o + 28} ${o + 4},${o + 22} ${o + 9},${o + 18} ${o + 4},${o + 14}"/>` + bar(18, 24, 14, 4);
  else if (kind === 1) mark = bar(4, 6, 28, 6) + bar(4, 15, 28, 6) + bar(4, 24, 18, 6);
  else if (kind === 2) mark = bar(4, 18, 7, 14) + bar(14.5, 8, 7, 24) + bar(25, 13, 7, 19);
  else mark = bar(4, 13, 10, 10) + bar(22, 13, 10, 10) + bar(14, 16.5, 8, 3);
  return svg(64, 64, `<polygon class="label-picto-tile" points="0,0 50,0 64,14 64,64 0,64"/><path class="label-picto-frame" d="M0,0H64V64H0Z M3,3V61H61V3Z" fill-rule="evenodd"/>${mark}`, "label-picto");
}
