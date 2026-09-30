/**
 * Generate the Unreal boot-animation tables from the web source of truth.
 *
 *   node scripts/export-boot-tracks.mjs
 *
 * The opening sequence is a frame-exact 25 fps choreography; retyping its
 * keyframes into C++ would guarantee drift. Instead the keyframe tables are
 * lifted out of src/boot-tracks.ts, src/boot-logo-tracks.ts and
 * src/boot-orbit-tracks.ts and emitted as prototypes/unreal/Source/
 * RhineLabViewer/RhineBootTracksData.h. Unreal only interprets them.
 *
 * Fails loudly if a table disappears or stops parsing, so a web-side rename
 * cannot silently flatten the Unreal animation.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFileSync(path.join(root, "src", file), "utf8");
const list = text => new Function(`return [${text.replace(/,\s*$/, "")}];`)();

function grab(source, pattern, label) {
  const match = source.match(pattern);
  if (!match) throw new Error(`boot track table not found: ${label}`);
  return list(match[1]);
}

const tracks = read("boot-tracks.ts");
const motion = read("boot-motion.ts");
const logo = read("boot-logo-tracks.ts");
const orbit = read("boot-orbit-tracks.ts");

const brandX = grab(tracks, /const brandX = \[([\s\S]*?)\];/, "brandX");
const brandOpacity = grab(tracks, /opacity: track\(\s*\[([\s\S]*?)\],\s*local,?\s*\)/, "brand opacity");
const highlight = grab(tracks, /const highlightKeys: readonly Key\[\] = \[([\s\S]*?)\];/, "highlightKeys");
const scan = {
  Radius: grab(tracks, /radius: value\(\[([\s\S]*?)\]\)/, "scan radius"),
  WhiteRadius: grab(tracks, /whiteRadius: value\(\[([\s\S]*?)\]\)/, "scan whiteRadius"),
  OuterStart: grab(tracks, /outerStart:\s*rad \*\s*value\(\[([\s\S]*?)\]\)/, "scan outerStart"),
  OuterSweep: grab(tracks, /outerSweep:\s*rad \*\s*value\(\[([\s\S]*?)\]\)/, "scan outerSweep"),
  WhiteStart: grab(tracks, /whiteStart:\s*rad \*\s*value\(\[([\s\S]*?)\]\)/, "scan whiteStart"),
  WhiteSweep: grab(tracks, /whiteSweep:\s*rad \*\s*value\(\[([\s\S]*?)\]\)/, "scan whiteSweep"),
  InnerRadius: grab(tracks, /innerRadius: value\(\[([\s\S]*?)\]\)/, "scan innerRadius"),
  InnerStart: grab(tracks, /innerStart:\s*rad \*\s*value\(\[([\s\S]*?)\]\)/, "scan innerStart"),
  InnerSweep: grab(tracks, /innerSweep:\s*rad \*\s*value\(\[([\s\S]*?)\]\)/, "scan innerSweep"),
  Spin: grab(tracks, /orbit:\s*rad \*\s*value\(\[([\s\S]*?)\]\)/, "scan orbit"),
  SpinRadius: grab(tracks, /orbitRadius: value\(\[([\s\S]*?)\]\)/, "scan orbitRadius"),
  DotRadius: grab(tracks, /dotRadius: value\(\[([\s\S]*?)\]\)/, "scan dotRadius"),
  BlackCap: grab(tracks, /blackCap: value\(\[([\s\S]*?)\]\)/, "scan blackCap"),
  WhiteCap: grab(tracks, /whiteCap: value\(\[([\s\S]*?)\]\)/, "scan whiteCap"),
};

// Inline tracks that live in the timeline rather than in scanTrack().
const timeline = {
  ScanRingOpacity: grab(motion, /ringOpacity:[\s\S]*?:\s*track\(\s*\[([\s\S]*?)\],\s*frame,?\s*\)/, "boot ring opacity"),
  ScanTracking: grab(motion, /scanTracking:\s*track\(\s*\[([\s\S]*?)\],\s*frame,?\s*\)/, "boot scan tracking"),
  ScanPermissionOpacity: grab(motion, /t < 21\.8\s*\?\s*progress\([^)]*\)\s*:\s*track\(\s*\[([\s\S]*?)\],\s*frame,?\s*\)/, "boot permission opacity"),
};

const draw = grab(logo, /const draw = \[([\s\S]*?)\] as const;/, "logo draw");
const logoTables = {
  DrawStart: draw.map(([frame, start]) => [frame, start]),
  DrawEnd: draw.map(([frame, , end]) => [frame, end]),
  MovingCut: grab(logo, /const movingCut = \[([\s\S]*?)\] as const;/, "logo movingCut"),
  LeftEdge: grab(logo, /const leftEdge = \[([\s\S]*?)\] as const;/, "logo leftEdge"),
  StrokeWidth: grab(logo, /strokeWidth: track\(\s*\[([\s\S]*?)\],\s*frame,?\s*\)/, "logo strokeWidth"),
  SymbolScale: grab(logo, /symbolScale: track\(\s*\[([\s\S]*?)\],\s*frame,?\s*\)/, "logo symbolScale"),
  PlusX: grab(logo, /plusX: track\(\s*\[([\s\S]*?)\],\s*frame,?\s*\)/, "logo plusX"),
  MinusX: grab(logo, /minusX: track\(\s*\[([\s\S]*?)\],\s*frame,?\s*\)/, "logo minusX"),
  MinusWidth: grab(logo, /minusWidth: track\(\s*\[([\s\S]*?)\],\s*frame,?\s*\)/, "logo minusWidth"),
  PlusAngle: grab(logo, /plusAngle: track\(\s*\[([\s\S]*?)\],\s*frame,?\s*\)/, "logo plusAngle"),
};

const sides = grab(orbit, /const sides = \[([\s\S]*?)\] as const;/, "orbit sides");
const orbitPath = grab(orbit, /const orbit = \[([\s\S]*?)\] as const;/, "orbit path");
const dotGrowth = grab(orbit, /const dotGrowth = \[([\s\S]*?)\] as const;/, "orbit dotGrowth");
const coreFlash = grab(orbit, /flash\s*\?\s*track\(\s*\[([\s\S]*?)\],\s*frame,?\s*\)/, "orbit core flash");
const coreGrow = grab(orbit, /:\s*track\(\s*\[([\s\S]*?)\],\s*frame,?\s*\)/, "orbit core grow");

// scanOrbitTrack derives nine column tables from `sides` rows of
// [frame, lx, ly, rx, ry, radius, leftStart, rightStart, leftSweep, rightSweep].
const orbitColumns = Array.from({ length: 9 }, (_, index) => sides.map(row => [row[0], row[index + 1]]));
const orbitAngle = orbitPath.map(([frame, x, y]) => [frame, Math.atan2(y - 539.5, x - 959.5)]);
const orbitRadius = orbitPath.map(([frame, x, y]) => [frame, Math.hypot(x - 959.5, y - 539.5)]);
const brandKeys = brandX.map((value, index) => [index, value]);

const tables = {
  BrandOffsetX: brandKeys,
  BrandOpacity: brandOpacity,
  Highlight: highlight,
  ...Object.fromEntries(Object.entries(scan).map(([name, value]) => [`Scan${name}`, value])),
  ...timeline,
  ...Object.fromEntries(Object.entries(logoTables).map(([name, value]) => [`Logo${name}`, value])),
  OrbitLeftX: orbitColumns[0],
  OrbitLeftY: orbitColumns[1],
  OrbitRightX: orbitColumns[2],
  OrbitRightY: orbitColumns[3],
  OrbitSideRadius: orbitColumns[4],
  OrbitLeftStart: orbitColumns[5],
  OrbitRightStart: orbitColumns[6],
  OrbitLeftSweep: orbitColumns[7],
  OrbitRightSweep: orbitColumns[8],
  OrbitAngle: orbitAngle,
  OrbitRadius: orbitRadius,
  OrbitDotGrowth: dotGrowth,
  OrbitCoreFlash: coreFlash,
  OrbitCoreGrow: coreGrow,
};

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 12, useGrouping: false });
const body = Object.entries(tables).map(([name, values]) => {
  const columns = Math.max(...values.map(row => row.length));
  const rows = values.map(row => {
    const cells = [];
    for (let i = 0; i < columns; i++) cells.push(number.format(i < row.length ? row[i] : 0));
    // C++ needs a leading digit: `.5f` is not a valid literal.
    // C++ floating literals need a decimal point (`0f` and `234f` are ill-formed),
    // and a leading digit (`.5f` is not a literal either).
    const literal = value => {
      const text = value.replace(/^-?\./, match => (match === "-." ? "-0." : "0."));
      return /[.e]/.test(text) ? text : `${text}.0`;
    };
    return `    { ${cells.map(literal).join(", ")} },`;
  }).join("\n");
  return `inline constexpr int32 ${name}_Count = ${values.length};\ninline constexpr int32 ${name}_Columns = ${columns};\ninline constexpr double ${name}[${values.length}][${columns}] = {\n${rows}\n};\n`;
}).join("\n");

const header = `// Generated by scripts/export-boot-tracks.mjs from src/boot-*.ts. Do not edit by hand.
// Rows are [frame, value...] in reference space (1920x1080, 25 fps) unless noted.
#pragma once

#include "CoreMinimal.h"

namespace RhineBootTracks {
${body}}
`;

writeFileSync(path.join(root, "prototypes", "unreal", "Source", "RhineLabViewer", "RhineBootTracksData.h"), header);
console.log(`RHINE_BOOT_TRACKS ${Object.keys(tables).length} tables, ${Object.values(tables).reduce((sum, rows) => sum + rows.length, 0)} keyframes`);