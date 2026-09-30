/**
 * What a colour palette carries besides colours (ported from the Unreal build's
 * RhineTheme.h, 2026-09-25/26): the figure its change-over, poster, icons and
 * side-column entrance are drawn in (its "motif"), and, for the four themes that
 * came from Unreal, the room and the archive by role.
 *
 * Unreal keeps one brightness per theme; here every palette has a light and a
 * dark end, so a themed scene is a `[light, dark]` pair like the palettes are.
 * The Unreal side stays in RhineTheme.cpp; when a value changes, change both.
 */
export type Motif = "shutters" | "tide" | "hazard" | "frames" | "orbit" | "plates" | "vector";

export type SceneEnd = { background: string; fog: string; floor: string };
export type Roles = { shell: string; cover: string; core: string; metal: string; mark: string; label: string };
export type Role = keyof Roles;

/**
 * How a theme lights the room, as multiples of what the shell already does at
 * that end (Unreal's Exposure / Cube / Fill are engine units, so they are kept
 * here relative to the two measured looks: paper for the light end, night for the
 * dark one) and the cast the image-based light takes (Unreal's CubeTint).
 */
export type Room = { exposure: number; env: number; fill: number; tint?: string };

export type ThemeDesign = {
  motif: Motif;
  /** Small caps line of the theme's name card (`RHINE / ARCHIVE`). */
  latin: string;
  caption: string;
  /** `[light, dark]`. Absent: the scene keeps the shell's own light and dark rooms. */
  scene?: readonly [SceneEnd, SceneEnd];
  /** `[light, dark]` lighting. Absent: the shell's own exposure, light and fill. */
  room?: readonly [Room, Room];
  /** `[light, dark]` archive colours by role. Absent: the measured per-surface tables. */
  roles?: readonly [Roles, Roles];
};

export const DESIGNS = {
  warm: { motif: "shutters", latin: "RHINE / ARCHIVE", caption: "暖纸 · 墨色 · 香槟金 — 实验档案" },
  cool: { motif: "tide", latin: "COOL / SILVER", caption: "冷银 · 石墨 — 精密仪器" },
  sand: { motif: "plates", latin: "SAND / GILT", caption: "砂金 · 深色金属 — 档案暗房" },
  cherenkov: {
    motif: "vector", latin: "CHERENKOV / ACCELERATOR", caption: "切伦科夫蓝 · 紫外电离 — 高能粒子加速器",
    scene: [
      { background: "#edf8fa", fog: "#edf8fa", floor: "#dbecef" },
      { background: "#01090f", fog: "#010c14", floor: "#05131a" },
    ],
    room: [{ exposure: 1.02, env: 1.05, fill: 1, tint: "#e0f8ff" }, { exposure: 0.96, env: 0.88, fill: 0.95, tint: "#00e5ff" }],
    roles: [
      { shell: "#dbecef", cover: "#eef9fa", core: "#c2dce3", metal: "#93b5bf", mark: "#5b21d6", label: "#f7fdfe" },
      { shell: "#18323d", cover: "#0f2630", core: "#071720", metal: "#6694a3", mark: "#00f0ff", label: "#dffbff" },
    ],
  },
  phosphor: { motif: "frames", latin: "PHOSPHOR / GREEN", caption: "磷绿 · 黑底 — 复古示波" },
  hologram: { motif: "orbit", latin: "HOLOGRAM / CYAN", caption: "全息青 · 透明网格" },
  amber: { motif: "hazard", latin: "AMBER / INSTRUMENT", caption: "琥珀 · 航行仪表" },
  nova: { motif: "orbit", latin: "NOVA / SPECTRUM", caption: "星紫 · 光谱观测" },
  cryo: { motif: "tide", latin: "CRYO / CHAMBER", caption: "冰蓝 · 低温舱室" },
  hazard: { motif: "hazard", latin: "HAZARD / RED", caption: "朱红 · 工业控制" },
  voidwave: { motif: "orbit", latin: "VOIDWAVE / ORBIT", caption: "深空 · 轨道遥测" },
  industrial: {
    motif: "hazard", latin: "INDUSTRIAL / CAUTION", caption: "石墨黑 · 安全黄 — 工业控制",
    scene: [
      { background: "#e8e6df", fog: "#e8e6df", floor: "#dcdad2" },
      { background: "#111214", fog: "#111214", floor: "#1a1b1e" },
    ],
    // RhineTheme.cpp hazard: exposure .95, cube .55, fill .2 against night's 1.0 / .65 / .22.
    room: [{ exposure: 1, env: 1, fill: 1 }, { exposure: 0.95, env: 0.85, fill: 0.91, tint: "#f4efe4" }],
    roles: [
      { shell: "#d9d8d2", cover: "#e6e5df", core: "#b8b7b0", metal: "#9a9ea3", mark: "#e0a800", label: "#f3f1ea" },
      { shell: "#3b3d42", cover: "#2e3035", core: "#1c1d20", metal: "#c8ccd0", mark: "#ffd12a", label: "#e8e4d8" },
    ],
  },
  clinic: {
    motif: "frames", latin: "CLINICAL / STERILE", caption: "冷白 · 纯黑 · 信号橙 — 无菌舱室",
    scene: [
      { background: "#f2f4f5", fog: "#f0f3f4", floor: "#e6eaec" },
      { background: "#0c1216", fog: "#101820", floor: "#141c21" },
    ],
    // clinic: 1.55 / .95 / .55 against paper's 1.6 / .9 / .6.
    room: [{ exposure: 0.97, env: 1.06, fill: 0.92, tint: "#eef3f7" }, { exposure: 1, env: 1, fill: 1 }],
    roles: [
      { shell: "#f3f5f6", cover: "#f6f8f9", core: "#dde3e6", metal: "#a9b2b8", mark: "#ff5a1f", label: "#ffffff" },
      { shell: "#59636a", cover: "#46515a", core: "#1d262c", metal: "#c4ccd2", mark: "#ff7a45", label: "#e6edf1" },
    ],
  },
  orbit: {
    motif: "orbit", latin: "ORBITAL / TELEMETRY", caption: "深海军蓝 · 电光蓝 — 轨道遥测",
    scene: [
      { background: "#eef0fa", fog: "#eef0fa", floor: "#e0e3f3" },
      { background: "#080c22", fog: "#080c22", floor: "#0f1536" },
    ],
    // orbit: .95 / .6 / .22 against night's 1.0 / .65 / .22.
    room: [{ exposure: 1, env: 1, fill: 1 }, { exposure: 0.95, env: 0.92, fill: 1, tint: "#dde4ff" }],
    roles: [
      { shell: "#d6daf0", cover: "#e4e7f7", core: "#b4bade", metal: "#8890c0", mark: "#3550e0", label: "#f5f6ff" },
      { shell: "#373f6e", cover: "#283060", core: "#12173a", metal: "#c4cbef", mark: "#5b79ff", label: "#e9ecff" },
    ],
  },
  riso: {
    motif: "plates", latin: "RISO / OVERPRINT", caption: "奶油纸 · 荧光粉 · 印刷蓝 — 套色印刷",
    scene: [
      { background: "#f3ebd9", fog: "#f3ebd9", floor: "#e8dfc9" },
      { background: "#161425", fog: "#161425", floor: "#201d34" },
    ],
    // print: 1.55 / .9 / .6 against paper's 1.6 / .9 / .6.
    room: [{ exposure: 0.97, env: 1, fill: 1, tint: "#fdf0e2" }, { exposure: 1, env: 1, fill: 1 }],
    roles: [
      { shell: "#f2e7d3", cover: "#f7eedd", core: "#e8d9c0", metal: "#b5ab9c", mark: "#ff4f9a", label: "#fbf6ec" },
      { shell: "#4a4560", cover: "#3a3652", core: "#1c1a30", metal: "#cfc6b4", mark: "#ff6fae", label: "#f3ebd9" },
    ],
  },
} as const satisfies Record<string, ThemeDesign>;

/** The measured web paper and night role colours the role tables are relative to (Unreal `paper` / `night`). */
export const REFERENCE_ROLES: readonly [Roles, Roles] = [
  { shell: "#f0e7df", cover: "#fcf3e8", core: "#e2dad4", metal: "#b9b4ad", mark: "#d8c29a", label: "#eae5dc" },
  { shell: "#6f8188", cover: "#62747e", core: "#1b2c35", metal: "#b7c7c9", mark: "#c7a679", label: "#30464e" },
];

export function roleOf(surface: string): Role {
  if (surface.includes("Frosted_Polymer")) return "cover";
  if (surface.includes("Titanium_Fasteners")) return "metal";
  if (surface.includes("Index_Inlay") || surface.includes("Amber_Optical_Inlay") || surface.includes("Champagne_Index")) return "mark";
  if (surface.includes("Printed_Label")) return "label";
  if (surface.includes("Internal_Ceramic") || surface.includes("Optical") || surface.includes("Subsurface_Optics")) return "core";
  return "shell";
}

export function motifOf(name: string | undefined): Motif {
  return (DESIGNS as Record<string, ThemeDesign>)[name ?? ""]?.motif ?? "shutters";
}

// ── Glyphs ──────────────────────────────────────────────────────────────────

/** The motif as a 32-unit mark (RhineThemeFx.cpp ThemeMotif at full reveal), in `currentColor`. */
export function motifGlyph(motif: Motif): string {
  const u = (v: number) => +(v * 32).toFixed(2);
  const line = (points: number[][], width = 1.7) =>
    `<polyline points="${points.map(([x, y]) => `${u(x)},${u(y)}`).join(" ")}" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linejoin="round"/>`;
  const box = (x: number, y: number, w: number, h: number) => `<rect x="${u(x)}" y="${u(y)}" width="${u(w)}" height="${u(h)}" fill="currentColor"/>`;
  let body = "";
  switch (motif) {
    case "shutters":
      for (let i = 0; i < 3; i++) body += box(.17 + i * .25, .14, .11, .72);
      break;
    case "tide":
      for (let row = 0; row < 2; row++)
        body += line(Array.from({ length: 13 }, (_, i) => [.09 + .82 * i / 12, .36 + row * .28 + .085 * Math.sin(i * .9)]));
      break;
    case "hazard":
      for (let i = 0; i < 3; i++) { const x = .25 + i * .24; body += line([[x - .15, .83], [x + .15, .17]], 2.6); }
      break;
    case "frames":
      for (let i = 0; i < 4; i++) {
        const x = i % 2 ? .85 : .15, y = i >> 1 ? .85 : .15;
        body += line([[x + (i % 2 ? -.22 : .22), y], [x, y], [x, y + (i >> 1 ? -.22 : .22)]]);
      }
      break;
    case "orbit":
      body += line(Array.from({ length: 25 }, (_, i) => { const a = -Math.PI / 2 + 2 * Math.PI * i / 24; return [.5 + .34 * Math.cos(a), .5 + .34 * Math.sin(a)]; })) + box(.78, .45, .12, .12);
      break;
    case "plates":
      body += line([[.17, .22], [.68, .22], [.68, .73], [.17, .73], [.17, .22]]) + line([[.32, .28], [.83, .28], [.83, .79], [.32, .79], [.32, .28]]);
      break;
    case "vector":
      body += line(Array.from({ length: 25 }, (_, i) => { const a = 2 * Math.PI * i / 24; return [.5 + .36 * Math.cos(a), .5 + .36 * Math.sin(a)]; }), 1.4) +
        line([[.5, .08], [.5, .24]], 2) + line([[.5, .76], [.5, .92]], 2) +
        line([[.08, .5], [.24, .5]], 2) + line([[.76, .5], [.92, .5]], 2) +
        box(.44, .44, .12, .12);
      break;
  }
  return `<svg class="theme-glyph" viewBox="0 0 32 32" aria-hidden="true" focusable="false">${body}</svg>`;
}

// ── Icons ───────────────────────────────────────────────────────────────────
// One icon set drawn six ways (RhineThemeIcons.h): the same shapes in the theme's
// own print technique, so the file and monitor pages carry the theme and not only
// its colours.

export type IconName =
  | "folder" | "file" | "link" | "archive" | "image" | "exec" | "up"
  | "cpu" | "memory" | "disk" | "gpu" | "net" | "star" | "edit" | "hidden";

type Body = readonly [number, number, number, number];
type Path = readonly (readonly [number, number])[];
const star: Path = Array.from({ length: 11 }, (_, i) => {
  const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? .2 : .44;
  return [.5 + Math.cos(a) * r, .54 + Math.sin(a) * r] as const;
});
const SHAPES: Record<IconName, { bodies?: Body[]; lines?: Path[] }> = {
  folder: { bodies: [[.06, .3, .94, .86], [.06, .16, .44, .3]] },
  file: { bodies: [[.2, .08, .8, .92]], lines: [[[.32, .38], [.68, .38]], [[.32, .54], [.68, .54]], [[.32, .7], [.56, .7]]] },
  link: { bodies: [[.12, .12, .88, .88]], lines: [[[.34, .66], [.68, .32]], [[.44, .32], [.68, .32], [.68, .56]]] },
  archive: { bodies: [[.14, .12, .86, .88]], lines: [[[.14, .36], [.86, .36]], [[.46, .12], [.46, .36]], [[.54, .12], [.54, .36]], [[.4, .56], [.6, .56]]] },
  image: { bodies: [[.1, .16, .9, .84]], lines: [[[.18, .74], [.4, .48], [.56, .64], [.66, .54], [.82, .74]], [[.64, .3], [.72, .3]]] },
  exec: { bodies: [[.08, .14, .92, .86]], lines: [[[.24, .36], [.42, .5], [.24, .64]], [[.5, .66], [.74, .66]]] },
  up: { lines: [[[.5, .86], [.5, .16]], [[.24, .42], [.5, .16], [.76, .42]]] },
  cpu: { bodies: [[.24, .24, .76, .76]], lines: [
    [[.36, .06], [.36, .24]], [[.64, .06], [.64, .24]], [[.36, .76], [.36, .94]], [[.64, .76], [.64, .94]],
    [[.06, .36], [.24, .36]], [[.06, .64], [.24, .64]], [[.76, .36], [.94, .36]], [[.76, .64], [.94, .64]]] },
  memory: { bodies: [[.06, .3, .94, .7]], lines: [
    [[.26, .42], [.26, .58]], [[.42, .42], [.42, .58]], [[.58, .42], [.58, .58]], [[.74, .42], [.74, .58]], [[.2, .7], [.2, .84]], [[.8, .7], [.8, .84]]] },
  disk: { bodies: [[.14, .22, .86, .78]], lines: [[[.14, .4], [.86, .4]], [[.68, .6], [.76, .6]]] },
  gpu: { bodies: [[.06, .24, .94, .76]], lines: [[[.14, .76], [.14, .9]], [[.3, .76], [.3, .9]]] },
  net: { lines: [[[.34, .86], [.34, .14]], [[.18, .3], [.34, .14], [.5, .3]], [[.66, .14], [.66, .86]], [[.5, .7], [.66, .86], [.82, .7]]] },
  star: { lines: [star] },
  edit: { lines: [[[.2, .8], [.26, .6], [.7, .16], [.84, .3], [.4, .74], [.2, .8]], [[.6, .26], [.74, .4]]] },
  hidden: { lines: [[[.08, .5], [.3, .3], [.5, .24], [.7, .3], [.92, .5], [.7, .7], [.5, .76], [.3, .7], [.08, .5]], [[.16, .86], [.84, .14]]] },
};

/**
 * An icon in the motif's technique. Colours come from the theme's tokens:
 * `currentColor` for the ink, `--theme-cyan` / `--theme-accent` for the second
 * plate, `--theme-paper` for stencil cut-outs.
 */
export function themeIcon(name: IconName, motif: Motif, className = "ssh-theme-icon"): string {
  const shape = SHAPES[name];
  const bodies = shape.bodies ?? [], lines = shape.lines ?? [];
  const k = 16, stroke = 1.2;
  const p = (v: number) => +(v * k).toFixed(2);
  const rect = (b: Body, attrs: string) => `<rect x="${p(b[0])}" y="${p(b[1])}" width="${p(b[2] - b[0])}" height="${p(b[3] - b[1])}" ${attrs}/>`;
  const poly = (path: Path, attrs: string, dx = 0) => `<polyline points="${path.map(([x, y]) => `${p(x + dx)},${p(y + dx)}`).join(" ")}" fill="none" stroke-linejoin="round" stroke-linecap="round" ${attrs}/>`;
  const outline = (w = stroke) => bodies.map(b => rect(b, `fill="none" stroke="currentColor" stroke-width="${w}"`)).join("") + lines.map(l => poly(l, `stroke="currentColor" stroke-width="${w}"`)).join("");
  let body = "";
  switch (motif) {
    case "hazard": // solid blocks, details cut out in the paper colour
      body = bodies.map(b => rect(b, 'fill="currentColor"')).join("") +
        lines.map(l => poly(l, `stroke="${bodies.length ? "var(--theme-paper)" : "currentColor"}" stroke-width="${stroke * 1.3}"`)).join("");
      break;
    case "plates": { // a second plate slightly off register under the outline
      const plate = bodies.length
        ? bodies.map(b => rect([b[0] + .09, b[1] + .09, b[2] + .09, b[3] + .09], 'fill="var(--theme-cyan)" fill-opacity=".55"')).join("")
        : lines.map(l => poly(l, `stroke="var(--theme-cyan)" stroke-opacity=".6" stroke-width="${stroke * 1.4}"`, .08)).join("");
      body = plate + outline();
      break;
    }
    case "frames": // a hairline and one signal dot
      body = outline(Math.max(1, stroke * .8)) + rect([.78, .02, .98, .22], 'fill="var(--theme-accent)"');
      break;
    case "orbit": // an outline over a faint ring
      body = `<circle cx="8" cy="8" r="8" fill="none" stroke="var(--theme-cyan)" stroke-opacity=".45" stroke-width="${stroke}"/>` + outline();
      break;
    case "vector": // high-energy hairline with pulse nodes
      body = outline(Math.max(1, stroke * .8)) +
        `<circle cx="8" cy="8" r="1.3" fill="var(--theme-cyan)"/>` +
        `<circle cx="13" cy="3" r="1" fill="var(--theme-accent)"/>`;
      break;
    default:
      body = outline();
  }
  return `<svg class="${className}" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${body}</svg>`;
}
