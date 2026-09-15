import "./theme.css";
const baseline = {
  ink: ["#080a08", "#e0e3dc"], muted: ["#77756d", "#a6b0b1"], line: ["#aaa59a", "#536166"],
  paper: ["#eae5e1", "#11181b"], panel: ["#edebe4", "#202a2f"], field: ["#e7e3d9", "#2a363b"],
  accent: ["#9b7247", "#c5a16b"],
} as const;
const palette = ["desktop", "android"].includes(import.meta.env.MODE) ? {
  ink: ["#202d32", "#e2e9e7"], muted: ["#58686a", "#abbabf"], line: ["#aebcba", "#465a64"],
  paper: ["#eeede7", "#131e26"], panel: ["#f0f2ed", "#20313b"], field: ["#e4e9e4", "#283b45"],
  accent: ["#856432", "#d0b584"],
  glass: ["#f0f2eb", "#17262f"], cyan: ["#477680", "#91bbc2"],
} as const : baseline;
let previous = -1;
export let themeAmount = 0;
function rgb(hex: string) { return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); }
export function paintTheme(amount: number) {
  if (Math.abs(amount - previous) < .0001) return;
  previous = themeAmount = amount;
  const root = document.documentElement;
  root.dataset.darkSurface = String(amount > .0001);
  for (const [name, values] of Object.entries(palette)) {
    const from = rgb(values[0]), to = rgb(values[1]);
    const value = from.map((v, i) => Math.round(v + (to[i] - v) * amount)).join(", ");
    root.style.setProperty(`--theme-${name}`, `rgb(${value})`);
    root.style.setProperty(`--theme-${name}-rgb`, value);
  }
  // The paper we just computed is also what sits behind the top of the screen,
  // so it is what Android's status bar should be. A fixed value in index.html
  // would leave a light band above a dark theme.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", root.style.getPropertyValue("--theme-paper"));
}
export function themeSettingsMarkup(dark: boolean) {
  return `<div class="theme-settings"><div><strong>界面配色</strong><span>玻璃阵列随配色逐张过渡</span></div><div class="theme-choices" role="group" aria-label="界面配色"><button data-color-theme="light" aria-pressed="${!dark}">亮色</button><button data-color-theme="dark" aria-pressed="${dark}">暗色</button></div></div>`;
}
