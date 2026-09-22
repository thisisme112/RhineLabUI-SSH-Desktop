import "./theme.css";
import "./instrument.css";

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
/** `[light endpoint, dark endpoint]`. `paintTheme` interpolates between the two,
 *  and the light/dark switch is the ends of that interpolation — so a new
 *  appearance is a new pair of endpoints, never a new stylesheet. */
type Palette = Record<Token, readonly [string, string]>;

// The web shell's own paper. `glass` and `cyan` carry the values the stylesheets
// already fall back to for it, so giving them a definition here changes nothing.
const baseline: Palette = {
  ink: ["#080a08", "#e0e3dc"], muted: ["#77756d", "#a6b0b1"], line: ["#aaa59a", "#536166"],
  paper: ["#eae5e1", "#11181b"], panel: ["#edebe4", "#202a2f"], field: ["#e7e3d9", "#2a363b"],
  accent: ["#9b7247", "#c5a16b"],
  glass: ["#f0f2eb", "#17262f"], cyan: ["#477680", "#91bbc2"],
} as const;
const warm: Palette = {
  ink: ["#202d32", "#e2e9e7"], muted: ["#58686a", "#abbabf"], line: ["#aebcba", "#465a64"],
  paper: ["#eeede7", "#131e26"], panel: ["#f0f2ed", "#20313b"], field: ["#e4e9e4", "#283b45"],
  accent: ["#856432", "#d0b584"],
  glass: ["#f0f2eb", "#17262f"], cyan: ["#477680", "#91bbc2"],
} as const;
const cool: Palette = {
  ink: ["#1e2429", "#dfe6ea"], muted: ["#5c6469", "#a3b0b8"], line: ["#b3b8bc", "#3f4c57"],
  paper: ["#ecedee", "#111820"], panel: ["#f2f3f4", "#1b242e"], field: ["#e6e8ea", "#232e39"],
  accent: ["#4a6b8a", "#86b0d4"],
  glass: ["#eff1f3", "#15202a"], cyan: ["#3f6b86", "#82b2cf"],
} as const;
const sand: Palette = {
  ink: ["#2c2620", "#eae4da"], muted: ["#6b6156", "#b3a999"], line: ["#c2b6a4", "#3c362e"],
  paper: ["#efe7d9", "#080807"], panel: ["#f3ece0", "#131210"], field: ["#e8dfd0", "#1c1a17"],
  accent: ["#9a6b34", "#d9b483"],
  glass: ["#f1e9dc", "#0d0d0c"], cyan: ["#7a6a4e", "#c0ac86"],
} as const;
// ── 科幻系配色：与原版暖白/冷灰拉开明显距离，但仍走同一套双端点插值 ────────
// 每套都往一个方向推到极致：磷光绿、全息青、琥珀示波、深空紫。亮端刻意压暗、
// 暗端保留发光体的高亮文字，让"终端感"来自对比而不是花哨。
const phosphor: Palette = {
  ink: ["#12331a", "#8fffb0"], muted: ["#4d6b52", "#5c9a6e"], line: ["#a9c4ae", "#1f4630"],
  paper: ["#e6f0e4", "#030c06"], panel: ["#eef5ec", "#07180c"], field: ["#ddeadb", "#0c2413"],
  accent: ["#2f7a3d", "#4dff88"],
  glass: ["#eaf3e8", "#04170c"], cyan: ["#2f8a55", "#63f2a0"],
} as const;
const hologram: Palette = {
  ink: ["#12303a", "#9fe8ff"], muted: ["#4d6670", "#62a7bd"], line: ["#aec6cf", "#1c4553"],
  paper: ["#e5eef1", "#02141b"], panel: ["#ecf3f5", "#062029"], field: ["#dce8ec", "#0a2b36"],
  accent: ["#227a94", "#3fd8ff"],
  glass: ["#e9f1f3", "#03222c"], cyan: ["#2f8aa8", "#56e0ff"],
} as const;
const amber: Palette = {
  ink: ["#3a2a0d", "#ffd08a"], muted: ["#7a6238", "#c9a25e"], line: ["#cbb28a", "#4d3a1a"],
  paper: ["#f2ead6", "#170e02"], panel: ["#f7f0dd", "#221603"], field: ["#ece2c8", "#2e1f06"],
  accent: ["#a86a14", "#ffb347"],
  glass: ["#f3ecda", "#1d1203"], cyan: ["#96742a", "#e8b45e"],
} as const;
const nova: Palette = {
  ink: ["#2a1e3a", "#d9c6ff"], muted: ["#655a78", "#a48fc9"], line: ["#bfb3cf", "#3d2e55"],
  paper: ["#ece9f2", "#0d0716"], panel: ["#f1eef6", "#160c22"], field: ["#e6e1ee", "#1f1230"],
  accent: ["#6a3fa8", "#a87fff"],
  glass: ["#efecf4", "#120a1e"], cyan: ["#5a4a8a", "#9d8fe0"],
} as const;
const cryo: Palette = {
  ink: ["#102d35", "#c7fbff"], muted: ["#53737a", "#74aeb8"], line: ["#a8c9ce", "#174653"],
  paper: ["#e5f0f0", "#020d12"], panel: ["#edf6f5", "#061820"], field: ["#d9e9e9", "#0a2530"],
  accent: ["#007f93", "#63f3ff"],
  glass: ["#e8f3f2", "#041c25"], cyan: ["#16889a", "#7af6ff"],
} as const;
const hazard: Palette = {
  ink: ["#351b17", "#ffd7ca"], muted: ["#795852", "#c18c7e"], line: ["#d0b3aa", "#54261f"],
  paper: ["#f1e8e3", "#120403"], panel: ["#f7efeb", "#210806"], field: ["#eadbd5", "#300d09"],
  accent: ["#a62d1d", "#ff5d3e"],
  glass: ["#f2eae6", "#1b0604"], cyan: ["#8e493d", "#ff8a70"],
} as const;
const voidwave: Palette = {
  ink: ["#25263f", "#e1e4ff"], muted: ["#626580", "#9298ca"], line: ["#b8bbd1", "#30365d"],
  paper: ["#e9eaf1", "#050711"], panel: ["#f0f1f7", "#0b0f20"], field: ["#e0e2ed", "#121832"],
  accent: ["#4c51b8", "#727cff"],
  glass: ["#eceef5", "#090d1c"], cyan: ["#3e7199", "#62c8ff"],
} as const;

export const THEMES = ["warm", "cool", "sand", "phosphor", "hologram", "amber", "nova", "cryo", "hazard", "voidwave"] as const;
export type ThemeName = (typeof THEMES)[number];
const PALETTES: Record<ThemeName, Palette> = { warm, cool, sand, phosphor, hologram, amber, nova, cryo, hazard, voidwave };
const LABELS: Record<ThemeName, string> = {
  warm: "暖白", cool: "冷灰", sand: "暖砂",
  phosphor: "磷光", hologram: "全息", amber: "琥珀", nova: "深空",
  cryo: "冰核", hazard: "警戒", voidwave: "虚空",
};

/**
 * The palette picker belongs to the shells that own their own chrome (desktop
 * and Android). The web build keeps the warmer `baseline` it has always had —
 * this adds appearances, it does not restyle a host that never asked.
 */
const CHOOSABLE = ["desktop", "android"].includes(import.meta.env.MODE);
const FALLBACK: Palette = CHOOSABLE ? warm : baseline;

let current: Palette = FALLBACK;
let previous = -1;
let paletteStart = 0;
let paletteFrom: Record<string, number[]> | undefined;
const painted: Record<string, number[]> = {};
export let themeAmount = 0;
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

/** Swap the endpoint pair. The stored amount is kept, so a reader in the middle
 *  of the light-to-dark transition stays where it was, in the new colours. */
export function setPalette(name: ThemeName | undefined, reduced = true) {
  const next = name ? PALETTES[name] : undefined;
  if (name) document.documentElement.dataset.colorPalette = name;
  if (!next || next === current) return;
  paletteFrom = !reduced && Object.keys(painted).length ? { ...painted } : undefined;
  paletteStart = performance.now();
  current = next;
  previous = -1;
}
export function paintTheme(amount: number) {
  if (!paletteFrom && Math.abs(amount - previous) < .0001) return;
  previous = themeAmount = amount;
  const root = document.documentElement;
  root.dataset.darkSurface = String(amount > .0001);
  const progress = Math.min(1, (performance.now() - paletteStart) / 360);
  const mix = 1 - (1 - progress) ** 3;
  const targets = Object.fromEntries(Object.entries(current).map(([name, values]) => {
    const from = rgb(values[0]), to = rgb(values[1]);
    return [name, from.map((v, i) => v + (to[i] - v) * amount)];
  }));
  if (CHOOSABLE) {
    const surfaces = [targets.paper, targets.panel, targets.field, targets.glass];
    targets.muted = readable(targets.muted, targets.ink, surfaces, 4.5);
    root.style.setProperty('--ui-control-line', `rgb(${readable(targets.line, targets.ink, surfaces, 3).join(', ')})`);
    root.style.setProperty('--ui-focus', `rgb(${readable(targets.accent, targets.ink, surfaces, 3).join(', ')})`);
  }
  for (const [name, values] of Object.entries(current)) {
    painted[name] = targets[name].map((target, i) => {
      return Math.round(paletteFrom ? paletteFrom[name][i] + (target - paletteFrom[name][i]) * mix : target);
    });
    const value = painted[name].join(", ");
    root.style.setProperty(`--theme-${name}`, `rgb(${value})`);
    root.style.setProperty(`--theme-${name}-rgb`, value);
  }
  if (progress === 1) paletteFrom = undefined;
  for (const button of root.querySelectorAll<HTMLElement>('button[data-color-palette]')) {
    const palette = PALETTES[button.dataset.colorPalette as ThemeName];
    if (!palette) continue;
    for (const name of ['paper', 'ink', 'accent'] as const) button.style.setProperty(`--sample-${name}`, palette[name][amount >= .5 ? 1 : 0]);
  }
  // The paper we just computed is also what sits behind the top of the screen,
  // so it is what Android's status bar should be. A fixed value in index.html
  // would leave a light band above a dark theme.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", root.style.getPropertyValue("--theme-paper"));
}
export function themeSettingsMarkup(dark: boolean, theme?: ThemeName) {
  const descriptions: Record<ThemeName, string> = {
    warm: "暖白 · 实验档案", cool: "冷银 · 精密仪器", sand: "砂金 · 深色金属",
    phosphor: "磷绿 · 复古示波", hologram: "全息 · 透明网格", amber: "琥珀 · 航行仪表",
    nova: "星紫 · 光谱观测", cryo: "冰蓝 · 低温舱室", hazard: "朱红 · 工业控制", voidwave: "深空 · 轨道遥测",
  };
  const palettes = CHOOSABLE
    ? `<div class="theme-settings theme-gallery"><div><strong>配色方案</strong><span>十套光谱 / 选择你的操作界面</span></div><div class="theme-choices" role="group" aria-label="配色方案">${THEMES.map(name => `<button data-color-palette="${name}" aria-pressed="${(theme || "warm") === name}" style="--sample-paper:${PALETTES[name].paper[dark ? 1 : 0]};--sample-ink:${PALETTES[name].ink[dark ? 1 : 0]};--sample-accent:${PALETTES[name].accent[dark ? 1 : 0]}"><i class="theme-sample" aria-hidden="true"></i><b>${LABELS[name]}</b><small>${descriptions[name]}</small></button>`).join("")}</div></div>`
    : "";
  return `<div class="theme-settings"><div><strong>界面配色</strong><span>玻璃阵列随配色逐张过渡</span></div><div class="theme-choices" role="group" aria-label="界面配色"><button data-color-theme="light" aria-pressed="${!dark}">亮色</button><button data-color-theme="dark" aria-pressed="${dark}">暗色</button></div></div>${palettes}`;
}
