import "./theme.css";
import "../../app/instrument.css";
import { DESIGNS, THEMES, isTheme, motifGlyph, type ThemeName } from "./theme-design";
export { THEMES, isTheme, type ThemeName } from "./theme-design";

type Token =
  | "ink"
  | "muted"
  | "line"
  | "paper"
  | "panel"
  | "field"
  | "accent"
  | "glass"
  | "cyan";
type Palette = Record<Token, string>;

/** The interface tokens of each theme (RhineTheme.cpp FRhineTheme, `paper` and `night` the measured web look). */
const PALETTES: Record<ThemeName, Palette> = {
  paper: { ink: "#202d32", muted: "#58686a", line: "#aebcba", paper: "#eeede7", panel: "#f0f2ed", field: "#e4e9e4", accent: "#856432", glass: "#f0f2eb", cyan: "#477680" },
  night: { ink: "#e2e9e7", muted: "#abbabf", line: "#465a64", paper: "#131e26", panel: "#20313b", field: "#283b45", accent: "#d0b584", glass: "#17262f", cyan: "#91bbc2" },
  hazard: { ink: "#ecebe4", muted: "#9c9a92", line: "#3a3b3e", paper: "#111214", panel: "#1a1b1e", field: "#222326", accent: "#ffd12a", glass: "#16171a", cyan: "#ffd12a" },
  clinic: { ink: "#0b0d0e", muted: "#586063", line: "#bcc6c3", paper: "#eef1f0", panel: "#f7f9f8", field: "#e2e8e6", accent: "#c4161c", glass: "#f3f6f5", cyan: "#4b6a66" },
  orbit: { ink: "#eef1ff", muted: "#8d95c2", line: "#29305c", paper: "#080c22", panel: "#0f1536", field: "#161d45", accent: "#5b79ff", glass: "#0c1230", cyan: "#8aa6ff" },
  print: { ink: "#1c1a2c", muted: "#6a6578", line: "#d4cab7", paper: "#f3ebd9", panel: "#f8f2e4", field: "#ebe0cb", accent: "#ff4f9a", glass: "#f6efe1", cyan: "#2d5bff" },
  transit: { ink: "#16181d", muted: "#6b6f78", line: "#d4d5d0", paper: "#f5f4ef", panel: "#fbfbf8", field: "#eaeae4", accent: "#e5312f", glass: "#f8f8f4", cyan: "#0072ce" },
  slate: { ink: "#f8fafc", muted: "#94a3b8", line: "#2b364b", paper: "#0f172a", panel: "#192134", field: "#222c41", accent: "#3b82f6", glass: "#141d31", cyan: "#38bdf8" },
  reagent: { ink: "#0e100f", muted: "#5d6561", line: "#c8cdc8", paper: "#eceee9", panel: "#f4f5f1", field: "#e0e4de", accent: "#12b886", glass: "#f1f2ee", cyan: "#0b7a63" },
  cryo: { ink: "#e7f0eb", muted: "#8fa39a", line: "#24332d", paper: "#0b1311", panel: "#111c19", field: "#17241f", accent: "#3debb0", glass: "#0f1916", cyan: "#c9f25c" },
  claude: { ink: "#f7ecdf", muted: "#a8948a", line: "#3d2a25", paper: "#140d0b", panel: "#1d1411", field: "#271a16", accent: "#d97757", glass: "#18100e", cyan: "#f0b392" },
  deepseek: { ink: "#182050", muted: "#5d6b98", line: "#c3cdee", paper: "#eef2ff", panel: "#f8faff", field: "#e1e8ff", accent: "#4d6bfe", glass: "#f4f7ff", cyan: "#f0b847" },
};

/**
 * The wallpaper offers no themes: Wallpaper Engine's own light/dark property
 * picks `paper` or `night`, and those keep the warmer paper the web shell had
 * before the themes came from Unreal.
 */
const CHOOSABLE = import.meta.env.MODE !== "wallpaper";
const BASELINE: Partial<Record<ThemeName, Palette>> = CHOOSABLE ? {} : {
  paper: { ink: "#080a08", muted: "#77756d", line: "#aaa59a", paper: "#eae5e1", panel: "#edebe4", field: "#e7e3d9", accent: "#9b7247", glass: "#f0f2eb", cyan: "#477680" },
  night: { ink: "#e0e3dc", muted: "#a6b0b1", line: "#536166", paper: "#11181b", panel: "#202a2f", field: "#2a363b", accent: "#c5a16b", glass: "#17262f", cyan: "#91bbc2" },
};
const paletteOf = (name: ThemeName) => BASELINE[name] ?? PALETTES[name];

/**
 * Five representative colours per theme, chosen to hold together on its paper
 * (RhineTheme.cpp Chrome Signals): monitor series CPU, memory, disk, GPU,
 * network, and the file kinds folder, link, archive, image, executable.
 */
const SIGNALS: Record<ThemeName, readonly string[]> = {
  paper: ["#477680", "#9a6a1f", "#7a4a6b", "#b04a34", "#4a7a3f"],
  night: ["#91bbc2", "#d8b875", "#c3a3cc", "#e08f76", "#a6c48a"],
  hazard: ["#ffd12a", "#ff7a2c", "#e8e4d8", "#4fd1c5", "#a3e635"],
  clinic: ["#c4161c", "#4b6a66", "#586063", "#a8741a", "#5b4a78"],
  orbit: ["#5b79ff", "#3de0c8", "#b8c0ff", "#ff7ad9", "#ffd166"],
  print: ["#ff4f9a", "#2d5bff", "#e0a100", "#00a88f", "#7b3fbf"],
  transit: ["#0072ce", "#e5312f", "#00a44a", "#d99000", "#7a3ea8"],
  slate: ["#3b82f6", "#4ade80", "#f59e0b", "#a78bfa", "#38bdf8"],
  reagent: ["#12b886", "#b8c41c", "#5d6561", "#f2643f", "#0b7a63"],
  cryo: ["#3debb0", "#c9f25c", "#8fa39a", "#ff8a6b", "#5fd1c1"],
  claude: ["#d97757", "#f0b392", "#f7ecdf", "#d9b26a", "#9dbfae"],
  deepseek: ["#4d6bfe", "#f0b847", "#88b0f8", "#ff7a9a", "#2fc4b2"],
};
export function signalsOf(name: ThemeName): readonly string[] {
  return SIGNALS[name];
}
/** The label design's one flat colour (RhineChrome.h LabelSignal): the theme's own, else its first signal. */
export function labelSignal(name: ThemeName): string {
  return DESIGNS[name].signal ?? SIGNALS[name][0];
}

/** A theme's token as `[r, g, b]`, for canvases that paint outside CSS. */
export function paletteRgb(name: ThemeName, token: Token): number[] {
  return rgb(paletteOf(name)[token]);
}
export const hexRgb = (hex: string) => rgb(hex);
export function currentPalette(): ThemeName {
  const name = document.documentElement.dataset.colorPalette;
  return isTheme(name) ? name : "paper";
}

/** A change without the screen captured fades the interface over this long, with the room (Unreal BlendTime). */
const FADE = 450;
let current: ThemeName = "paper";
let previous = -1;
let paletteStart = 0;
let paletteFrom: Record<string, number[]> | undefined;
const painted: Record<string, number[]> = {};
/** How dark the picture is, 0 to 1: the scene eases it between two themes of different brightness. */
export let themeAmount = 0;
/** Counts the times paintTheme rewrote the `--theme-*` properties, so a per-frame reader can skip getComputedStyle until it changes. */
export let paintRevision = 0;
function rgb(hex: string) { return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); }
function luminance(color: number[]) {
  return color.map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; })
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
}
function readable(color: number[], ink: number[], surfaces: number[][], minimum: number) {
  for (let step = 0; step <= 100; step++) {
    const candidate = color.map((v, i) => Math.round(v + (ink[i] - v) * step / 100));
    const light = luminance(candidate);
    if (surfaces.every(bg => (Math.max(light, luminance(bg)) + .05) / (Math.min(light, luminance(bg)) + .05) >= minimum)) return candidate;
  }
  return ink;
}

/**
 * Switch the interface to a theme. `fade` mixes it in from what is painted now;
 * otherwise (a change-over that covers the screen, start-up, reduced motion) it
 * is simply applied.
 */
export function setPalette(name: ThemeName, fade = false) {
  document.documentElement.dataset.colorPalette = name;
  document.documentElement.dataset.themeDark = String(DESIGNS[name].dark);
  if (name === current && previous >= 0) return;
  paletteFrom = fade && Object.keys(painted).length ? { ...painted } : undefined;
  paletteStart = performance.now();
  current = name;
  previous = -1;
}

/** Paint the `--theme-*` properties. `amount` is how dark the picture is now (the scene's themeAmount). */
export function paintTheme(amount: number) {
  if (!paletteFrom && Math.abs(amount - previous) < .0001) return;
  previous = themeAmount = amount;
  paintRevision++;
  const root = document.documentElement;
  // The interface names the new theme at once and mixes in from the old one.
  root.dataset.darkSurface = String(DESIGNS[current].dark);
  const progress = Math.min(1, (performance.now() - paletteStart) / FADE);
  const mix = 1 - (1 - progress) ** 3;
  const palette = paletteOf(current);
  const targets: Record<string, number[]> = Object.fromEntries(Object.entries(palette).map(([name, hex]) => [name, rgb(hex)]));
  if (CHOOSABLE) {
    const surfaces = [targets.paper, targets.panel, targets.field, targets.glass];
    targets.muted = readable(targets.muted, targets.ink, surfaces, 4.5);
    root.style.setProperty('--ui-control-line', `rgb(${readable(targets.line, targets.ink, surfaces, 3).join(', ')})`);
    root.style.setProperty('--ui-focus', `rgb(${readable(targets.accent, targets.ink, surfaces, 3).join(', ')})`);
  }
  signalsOf(current).forEach((hex, i) => (targets[`signal-${i}`] = rgb(hex)));
  // The label design's three inks (Unreal RhineLabel::Ink): ground, ink and one flat signal colour, and
  // what is printed on the signal: the darker of the two inks, unless the signal itself is dark.
  targets.signal = rgb(labelSignal(current));
  const [darker, lighter] = luminance(targets.paper) < luminance(targets.ink) ? [targets.paper, targets.ink] : [targets.ink, targets.paper];
  targets["on-signal"] = luminance(targets.signal) > .2 ? darker : lighter;
  // The signal where it is printed on ink, if it reads there (3:1), else the ground (RhineLabel::SignalOn).
  const contrast = (a: number[], b: number[]) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
  targets["signal-on-ink"] = contrast(targets.signal, targets.ink) >= 3 ? targets.signal : targets.paper;
  for (const [name, target] of Object.entries(targets)) {
    const from = paletteFrom?.[name];
    painted[name] = target.map((value, i) => Math.round(from ? from[i] + (value - from[i]) * mix : value));
    const value = painted[name].join(", ");
    root.style.setProperty(`--theme-${name}`, `rgb(${value})`);
    root.style.setProperty(`--theme-${name}-rgb`, value);
  }
  if (progress === 1) paletteFrom = undefined;
  // The paper we just computed is also what sits behind the top of the screen,
  // so it is what Android's status bar should be. A fixed value in index.html
  // would leave a light band above a dark theme.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", root.style.getPropertyValue("--theme-paper"));
}

/**
 * The theme gallery (Unreal RhineSettings.cpp): each theme's number, motif,
 * name, Latin line, brightness and caption on its own colours. The wallpaper,
 * which offers no themes, keeps a light/dark pair.
 */
export function themeSettingsMarkup(theme: ThemeName) {
  if (!CHOOSABLE)
    return `<div class="theme-settings"><div><strong>界面配色</strong><span>玻璃阵列随配色逐张过渡</span></div><div class="theme-choices" role="group" aria-label="界面配色"><button data-color-palette="paper" aria-pressed="${theme !== "night"}">亮色</button><button data-color-palette="night" aria-pressed="${theme === "night"}">暗色</button></div></div>`;
  const cards = THEMES.map((name, index) => {
    const design = DESIGNS[name], palette = PALETTES[name];
    return `<button data-color-palette="${name}" aria-pressed="${theme === name}" style="--sample-paper:${palette.paper};--sample-ink:${palette.ink};--sample-accent:${palette.accent}">` +
      `<i class="theme-sample" aria-hidden="true"></i>${motifGlyph(design.motif)}<span class="theme-number" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span>` +
      `<b>${design.label}</b><small>${design.latin} · ${design.dark ? "DARK" : "LIGHT"}</small><em>${design.caption}</em></button>`;
  }).join("");
  return `<div class="theme-settings theme-gallery"><div><strong>主题</strong><span>${THEMES.length} 套 · 各自的明暗、材质、远景海报与转场</span></div><div class="theme-choices" role="group" aria-label="主题">${cards}</div></div>`;
}
