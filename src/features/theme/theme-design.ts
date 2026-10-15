/**
 * The themes (the Unreal build's RhineTheme.h / RhineTheme.cpp, 2026-09-25 to
 * 10-02). Each is one complete mood with a fixed brightness, and it changes
 * more than colour: the figure its change-over, poster, icons, cues and corner
 * card are drawn in (its "motif"), the room, and the archive by role.
 *
 * `paper` and `night` are the measured web look, light and dark; they keep the
 * shell's own room and per-surface tables. The Unreal side stays in
 * RhineTheme.cpp: when a value changes, change both.
 */
export const THEMES = ["paper", "night", "hazard", "clinic", "orbit", "print", "transit", "slate", "reagent", "cryo", "claude", "deepseek"] as const;
export type ThemeName = (typeof THEMES)[number];

/** The figure a theme draws in; one per theme, named after the change-over it makes. */
export type Motif = "shutters" | "tide" | "hazard" | "frames" | "orbit" | "plates" | "transit" | "darkroom" | "label" | "rack" | "spark" | "bubbles";

/** The themes with a maid in them (features/maid): Claude's 小克 and DeepSeek's 大肥鱼. */
export type Mascot = "claude" | "deepseek";
export function mascotOf(name: string | undefined): Mascot | undefined {
  return name === "claude" || name === "deepseek" ? name : undefined;
}

export type SceneEnd = { background: string; fog: string; floor: string };
export type Roles = { shell: string; cover: string; core: string; metal: string; mark: string; label: string };
export type Role = keyof Roles;

/**
 * How a theme lights the room, as multiples of the measured look of its own
 * brightness (Unreal's Exposure / Cube / Fill are engine units, so they are kept
 * relative to paper's 1.6 / .9 / .6 for a light theme and night's 1.0 / .65 / .22
 * for a dark one), and the cast the image-based light takes (Unreal's CubeTint).
 */
export type Room = { exposure: number; env: number; fill: number; tint?: string };

export type ThemeDesign = {
  motif: Motif;
  /** The theme's name, `莱茵 · 纸档`. */
  label: string;
  /** Small caps line of the theme's name card (`RHINE / ARCHIVE`). */
  latin: string;
  caption: string;
  dark: boolean;
  room: Room;
  /** Absent: the scene keeps the shell's own room for this brightness. */
  scene?: SceneEnd;
  /** Absent: the measured per-surface tables. */
  roles?: Roles;
  /** The one flat colour the label design sets beside ground and ink (RhineChrome.h LabelSignal); absent: its first signal. */
  signal?: string;
};

const MEASURED: Room = { exposure: 1, env: 1, fill: 1 };
export const DESIGNS: Record<ThemeName, ThemeDesign> = {
  paper: { motif: "shutters", label: "莱茵 · 纸档", latin: "RHINE / ARCHIVE", caption: "暖纸 · 墨色 · 香槟金 — 实验档案", dark: false, room: MEASURED, signal: "#20c997" },
  night: { motif: "tide", label: "莱茵 · 夜间", latin: "RHINE / NIGHT SHIFT", caption: "深青灰 · 象牙白 · 冷青 — 夜间值守", dark: true, room: MEASURED, signal: "#e4f03a" },
  hazard: {
    motif: "hazard", label: "工业 · 警戒", latin: "INDUSTRIAL / CAUTION", caption: "石墨黑 · 安全黄 — 工业控制", dark: true, signal: "#ffd400",
    // exposure .95, cube .55, fill .2 against night's 1.0 / .65 / .22.
    room: { exposure: .95, env: .846, fill: .909, tint: "#f4efe4" },
    scene: { background: "#111214", fog: "#111214", floor: "#1a1b1e" },
    roles: { shell: "#3b3d42", cover: "#2e3035", core: "#1c1d20", metal: "#c8ccd0", mark: "#ffd12a", label: "#e8e4d8" },
  },
  clinic: {
    motif: "frames", label: "医疗 · 隔离", latin: "CLINICAL / QUARANTINE", caption: "手术白 · 墨黑 · 动脉红 — 隔离病区", dark: false, signal: "#c4161c",
    // A ward under tube light: hotter than paper and with little fill, so the white burns and the shadows
    // stay hard; a green cast, and far rows that sink into a grey-green haze (RhineTheme.cpp: 1.72 / .68 / .22
    // against paper's 1.6 / .9 / .6).
    room: { exposure: 1.1, env: .72, fill: .34, tint: "#cfe8dc" },
    scene: { background: "#e3eae8", fog: "#a4b3ad", floor: "#cbd5d1" },
    roles: { shell: "#e2e9e8", cover: "#ecf1f0", core: "#b7c2c0", metal: "#869292", mark: "#c4161c", label: "#ffffff" },
  },
  orbit: {
    motif: "orbit", label: "轨道 · 遥测", latin: "ORBITAL / TELEMETRY", caption: "深海军蓝 · 电光蓝 — 轨道遥测", dark: true,
    room: { exposure: .95, env: .923, fill: 1, tint: "#dde4ff" },
    scene: { background: "#080c22", fog: "#080c22", floor: "#0f1536" },
    roles: { shell: "#373f6e", cover: "#283060", core: "#12173a", metal: "#c4cbef", mark: "#5b79ff", label: "#e9ecff" },
  },
  print: {
    motif: "plates", label: "复古 · 印刷", latin: "RISO / OVERPRINT", caption: "奶油纸 · 荧光粉 · 印刷蓝 — 套色印刷", dark: false,
    room: { exposure: .969, env: 1, fill: 1, tint: "#fdf0e2" },
    scene: { background: "#f3ebd9", fog: "#f3ebd9", floor: "#e8dfc9" },
    roles: { shell: "#f2e7d3", cover: "#f7eedd", core: "#e8d9c0", metal: "#b5ab9c", mark: "#ff4f9a", label: "#fbf6ec" },
  },
  // A route map: white sheet, near-black type, and a colour per line (TRANSIT_LINES).
  transit: {
    motif: "transit", label: "都市 · 线路", latin: "TRANSIT / LINE MAP", caption: "线路白 · 五色干线 · 换乘站 — 城市轨交图", dark: false, signal: "#e63b2e",
    room: { exposure: .969, env: 1.056, fill: .967, tint: "#fffdf8" },
    scene: { background: "#f5f4ef", fog: "#f5f4ef", floor: "#eaeae4" },
    roles: { shell: "#f0efe9", cover: "#f7f6f1", core: "#dcdbd3", metal: "#a5a69f", mark: "#e5312f", label: "#ffffff" },
  },
  // A contact sheet at night: frames, sprocket holes, edge codes and a ringed pick, in a developer tool's slate.
  slate: {
    motif: "darkroom", label: "石板 · 夜间", latin: "SLATE / NIGHT SHEET", caption: "石板蓝灰 · 天青焦点 · 状态绿 — 开发者夜间印样", dark: true,
    room: { exposure: 1.25, env: 1.154, fill: 1.591, tint: "#eef4ff" },
    scene: { background: "#0b1222", fog: "#0f172a", floor: "#192134" },
    roles: { shell: "#2a3650", cover: "#232e45", core: "#131c30", metal: "#aebbd3", mark: "#4ade80", label: "#f8fafc" },
  },
  // The theme the label design was drawn for: cool white stock, ink, a lemon block and mint.
  reagent: {
    motif: "label", label: "试剂 · 标签", latin: "REAGENT / LABEL", caption: "冷白 · 墨黑 · 柠檬色块 · 薄荷 — 试剂标签", dark: false, signal: "#e4f03a",
    room: { exposure: .969, env: 1.056, fill: .967, tint: "#f1f7f3" },
    scene: { background: "#eceee9", fog: "#eceee9", floor: "#e0e4de" },
    roles: { shell: "#eef0ec", cover: "#f6f8f5", core: "#d8ddd8", metal: "#a2a9a4", mark: "#12b886", label: "#ffffff" },
  },
  // The label's cold store: spruce black, frost type, a mint signal and lime; a 96-well plate.
  cryo: {
    motif: "rack", label: "冷库 · 夜间", latin: "CRYO / NIGHT STOCK", caption: "云杉黑 · 霜白 · 薄荷信号 · 青柠 — 冷库孔板", dark: true, signal: "#3debb0",
    room: { exposure: 1, env: 1, fill: 1.136, tint: "#e4fff4" },
    scene: { background: "#08100e", fog: "#0b1311", floor: "#111c19" },
    roles: { shell: "#2a3a34", cover: "#22322c", core: "#121d19", metal: "#a9bdb4", mark: "#3debb0", label: "#e7f0eb" },
  },
  // Claude (Unreal 2026-10-13): the maid the Chinese fan art draws the model as. Three flat inks cut like paper on a
  // warm black: cream for type and lace, the terracotta of her hair as the one signal, the apricot of its highlights as
  // the second ink. It draws with lace scallops, ribbons and the eight-spoke spark she wears, and it has pictures of her
  // in it (public/maid/claude). Exposure .98, cube .6, fill .22 against night's 1.0 / .65 / .22.
  claude: {
    motif: "spark", label: "克劳德 · 女仆", latin: "CLAUDE / MAID", caption: "焦糖黑 · 奶油白 · 陶土橙 — 橙发女仆 Claude 娘", dark: true, signal: "#d97757",
    room: { exposure: .98, env: .923, fill: 1, tint: "#ffe3d2" },
    scene: { background: "#120b09", fog: "#0e0807", floor: "#1d1411" },
    roles: { shell: "#3a2a25", cover: "#2e211d", core: "#1a110f", metal: "#d8c8ba", mark: "#d97757", label: "#f7ecdf" },
  },
  // DeepSeek (Unreal 2026-10-15): the whale the model is drawn as, a lively maid with a whale's tail (the fans call her
  // 大肥鱼). Light where Claude's is dark: a sea-foam sheet, deep-sea navy for type, the brand's blue as the one signal
  // and a little gold from her embroidery as the second; waves and bubbles. 1.55 / .95 / .6 against paper's 1.6 / .9 / .6.
  deepseek: {
    motif: "bubbles", label: "深求 · 鲸娘", latin: "DEEPSEEK / WHALE", caption: "海沫白 · 深海藏青 · 鲸蓝 — 鲸尾女仆大肥鱼", dark: false, signal: "#4d6bfe",
    room: { exposure: .969, env: 1.056, fill: 1, tint: "#eef3ff" },
    scene: { background: "#eef2ff", fog: "#e8eeff", floor: "#f8faff" },
    roles: { shell: "#e6ecff", cover: "#f3f6ff", core: "#d5ddf6", metal: "#a3acc8", mark: "#4d6bfe", label: "#ffffff" },
  },
};

/** Transit is the one theme with more than two inks: a route map has a colour per line. */
export const TRANSIT_LINES = ["#0072ce", "#e5312f", "#00a44a", "#f5a800", "#7a3ea8"] as const;

/**
 * Where a palette name saved before the themes came from Unreal (a palette plus
 * a light/dark switch) lands now: `[when it was light, when it was dark]`.
 */
const LEGACY: Record<string, readonly [ThemeName, ThemeName]> = {
  warm: ["paper", "night"], industrial: ["hazard", "hazard"], clinic: ["clinic", "clinic"], orbit: ["orbit", "orbit"], riso: ["print", "print"],
  cool: ["clinic", "slate"], sand: ["print", "hazard"], cherenkov: ["clinic", "slate"], phosphor: ["reagent", "cryo"],
  hologram: ["clinic", "slate"], amber: ["print", "hazard"], nova: ["print", "orbit"], cryo: ["clinic", "slate"],
  hazard: ["transit", "hazard"], voidwave: ["orbit", "orbit"],
};
export function legacyTheme(palette: string | undefined, dark: boolean): ThemeName {
  const pair = LEGACY[palette ?? "warm"] ?? LEGACY.warm;
  return pair[dark ? 1 : 0];
}
export function isTheme(name: unknown): name is ThemeName {
  return (THEMES as readonly unknown[]).includes(name);
}

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
  return isTheme(name) ? DESIGNS[name].motif : "shutters";
}

// ── Glyphs ──────────────────────────────────────────────────────────────────

/** The motif as a 32-unit mark (RhineThemeFx.cpp ThemeMotif at full reveal), in `currentColor`. */
export function motifGlyph(motif: Motif): string {
  const u = (v: number) => +(v * 32).toFixed(2);
  const line = (points: number[][], width = 1.7) =>
    `<polyline points="${points.map(([x, y]) => `${u(x)},${u(y)}`).join(" ")}" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linejoin="round"/>`;
  const box = (x: number, y: number, w: number, h: number) => `<rect x="${u(x)}" y="${u(y)}" width="${u(w)}" height="${u(h)}" fill="currentColor"/>`;
  const ring = (x: number, y: number, r: number, width: number) => `<circle cx="${u(x)}" cy="${u(y)}" r="${u(r)}" fill="none" stroke="currentColor" stroke-width="${width}"/>`;
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
    case "transit": // one route with a 45 degree bend and a station at each end
      body += line([[.1, .72], [.4, .72], [.6, .52], [.9, .52]], 4.2) + ring(.1, .72, .11, 1.9) + ring(.9, .52, .11, 1.9);
      break;
    case "darkroom": // a frame of film and its sprocket holes
      body += line([[.1, .3], [.9, .3], [.9, .7], [.1, .7], [.1, .3]], 2.2);
      for (let i = 0; i < 4; i++) body += box(.16 + i * .2, .11, .1, .09) + box(.16 + i * .2, .8, .1, .09);
      break;
    case "label": // a host mark in miniature: a 3x3 of solid cells
      [1, 1, 0, 1, 0, 1, 0, 1, 1].forEach((on, i) => { if (on) body += box(.08 + (i % 3) * .29, .08 + Math.floor(i / 3) * .29, .26, .26); });
      break;
    case "spark": // the spark she wears: eight spokes about a clear centre
      for (let i = 0; i < 8; i++) {
        const a = -Math.PI / 2 + i * Math.PI / 4;
        body += line([[.5 + Math.cos(a) * .13, .5 + Math.sin(a) * .13], [.5 + Math.cos(a) * .42, .5 + Math.sin(a) * .42]], 3.2);
      }
      break;
    case "bubbles": // three bubbles rising one after another, the largest last
      for (let i = 0; i < 3; i++) body += ring(.28 + i * .22, .36 - i * .06, .08 + i * .045, 1.6);
      break;
    case "rack": // six wells of a plate, filled
      for (let i = 0; i < 6; i++) {
        const x = .2 + Math.floor(i / 2) * .3, y = .32 + (i % 2) * .36;
        body += ring(x, y, .13, 1.45) + box(x - .07, y - .07, .14, .14);
      }
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
    case "transit": // a bolder line, and a route-coloured bar under it like a line on a map
      body = outline(stroke * 1.4) + rect([0, .93, 1, 1], 'fill="var(--theme-signal-1)"');
      break;
    case "darkroom": // a fine outline, and the crop marks a contact sheet is marked with in grease pencil
      body = outline(Math.max(1, stroke * .9)) +
        poly([[-.04, .16], [-.04, -.04], [.16, -.04]], `stroke="var(--theme-accent)" stroke-width="${stroke * 1.2}"`) +
        poly([[1.04, .84], [1.04, 1.04], [.84, 1.04]], `stroke="var(--theme-accent)" stroke-width="${stroke * 1.2}"`);
      break;
    case "rack": // a fine outline with one well in the corner, filled in the second ink
      body = outline(Math.max(1, stroke * .9)) +
        `<circle cx="${p(.86)}" cy="${p(.14)}" r="${p(.12)}" fill="none" stroke="var(--theme-signal-1)" stroke-width="${stroke}"/>` +
        rect([.81, .09, .91, .19], 'fill="var(--theme-signal-1)"');
      break;
    case "label": // a heavy outline with a solid lemon tab at its head, a reagent label's colour code
      body = rect([0, 0, .3, .3], 'fill="#e4f03a"') + outline(stroke * 1.6);
      break;
    case "spark": // claude: a fine outline, and her spark on the corner in the second (apricot) ink
      body = outline() + Array.from({ length: 4 }, (_, i) => {
        const dx = Math.cos(i * Math.PI / 4) * .14, dy = Math.sin(i * Math.PI / 4) * .14;
        return poly([[.88 - dx, .12 - dy], [.88 + dx, .12 + dy]], `stroke="var(--theme-cyan)" stroke-width="${stroke}"`);
      }).join("");
      break;
    case "bubbles": { // deepseek: round and bubbly, a heavy outline with soft corners and two gold bubbles rising off the corner
      const w = stroke * 1.4;
      body = bodies.map(b => { const r = p(Math.min(b[2] - b[0], b[3] - b[1]) * .34); return rect(b, `rx="${r}" ry="${r}" fill="none" stroke="currentColor" stroke-width="${w}"`); }).join("") +
        lines.map(l => poly(l, `stroke="currentColor" stroke-width="${w}"`)).join("") +
        `<circle cx="${p(.87)}" cy="${p(.13)}" r="${p(.08)}" fill="none" stroke="var(--theme-cyan)" stroke-width="${stroke}"/>` +
        `<circle cx="${p(.98)}" cy="${p(-.02)}" r="${p(.045)}" fill="none" stroke="var(--theme-cyan)" stroke-width="${stroke}"/>`;
      break;
    }
    default:
      body = outline();
  }
  // The darkroom's crop marks and the whale's bubbles sit just outside the icon.
  return `<svg class="${className}" viewBox="0 0 16 16" aria-hidden="true" focusable="false"${motif === "darkroom" || motif === "bubbles" ? ' overflow="visible"' : ""}>${body}</svg>`;
}
