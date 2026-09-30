import type { Terminal, IBufferCell, ITheme } from "@xterm/xterm";

import { TERMINAL_FONT } from "./terminal-appearance";
export { TERMINAL_FONT } from "./terminal-appearance";
export const TERMINAL_THEME: ITheme = {
  background: "#eeede7",
  foreground: "#202d32",
  cursor: "#9b7247",
  cursorAccent: "#eeede7",
  selectionBackground: "rgba(197,161,107,.32)",
  black: "#3a3a36",
  red: "#a8412f",
  green: "#4a6b3f",
  yellow: "#8a6a2a",
  blue: "#3d5a75",
  magenta: "#7a4a6b",
  cyan: "#3f6b66",
  white: "#d8d3cc",
  brightBlack: "#6b6a63",
  brightRed: "#c25a44",
  brightGreen: "#5f8752",
  brightYellow: "#ad8a3c",
  brightBlue: "#4f6f8c",
  brightMagenta: "#9a6287",
  brightCyan: "#528a83",
  brightWhite: "#f2efeb",
};
export const TERMINAL_DARK_THEME: ITheme = {
  ...TERMINAL_THEME,
  background: "#15232b",
  foreground: "#e2e9e7",
  cursor: "#cda265",
  cursorAccent: "#15232b",
  black: "#282a25",
  red: "#d7856e",
  green: "#a6b88a",
  yellow: "#d8b875",
  blue: "#96b2c7",
  magenta: "#b59cbd",
  cyan: "#97bcb4",
  white: "#ded8cd",
  brightBlack: "#899ba3",
  brightRed: "#efac95",
  brightGreen: "#c0d0a8",
  brightYellow: "#ead29e",
  brightBlue: "#b1cedf",
  brightMagenta: "#d3bbdc",
  brightCyan: "#b3d6d0",
  brightWhite: "#f0f4f0",
};

const ANSI = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

function cellColor(cell: IBufferCell, foreground: boolean, theme: ITheme) {
  const fallback = foreground ? theme.foreground! : theme.background!;
  if (foreground ? cell.isFgDefault() : cell.isBgDefault()) return fallback;
  const color = foreground ? cell.getFgColor() : cell.getBgColor();
  if (foreground ? cell.isFgRGB() : cell.isBgRGB())
    return `#${color.toString(16).padStart(6, "0")}`;
  if (color < 16) return theme[ANSI[color]] ?? fallback;
  if (color >= 232) {
    const c = 8 + (color - 232) * 10;
    return `rgb(${c},${c},${c})`;
  }
  const n = color - 16,
    levels = [0, 95, 135, 175, 215, 255];
  return `rgb(${levels[Math.floor(n / 36)]},${levels[Math.floor(n / 6) % 6]},${levels[n % 6]})`;
}

/** Paint the operational xterm buffer, including ANSI and alternate screen.
 * No second parser, separate dimensions, duplicated stream, or synthetic output.
 */
export function paintTerminalBuffer(
  ctx: CanvasRenderingContext2D,
  term: Terminal,
  theme: ITheme,
  rect: { x: number; y: number; width: number; height: number },
  cursor: boolean,
) {
  const buffer = term.buffer.active;
  const base = term.options.fontSize || 13;
  const family = term.options.fontFamily || TERMINAL_FONT;
  ctx.save();
  ctx.font = `400 ${base}px ${family}`;
  const advance = Math.max(1, ctx.measureText("W").width + (term.options.letterSpacing || 0));
  const rowHeight = Math.ceil(base * 1.2) * (term.options.lineHeight || 1);
  const scale = Math.min(rect.width / (term.cols * advance), rect.height / (term.rows * rowHeight));
  const fontSize = base * scale;
  // Preserve glyph advances when the packed screen and current PTY aspect
  // differ. Stretching cells independently makes ordinary text look spaced out.
  const cw = advance * scale,
    ch = rowHeight * scale;
  const cell = buffer.getNullCell();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (let row = 0; row < term.rows; row++) {
    const line = buffer.getLine(buffer.viewportY + row);
    if (!line) continue;
    for (let col = 0; col < term.cols; col++) {
      if (!line.getCell(col, cell) || !cell.getWidth()) continue;
      const x = rect.x + col * cw,
        y = rect.y + row * ch,
        width = cw * cell.getWidth();
      let fg = cellColor(cell, true, theme),
        bg = cellColor(cell, false, theme);
      if (cell.isInverse()) [fg, bg] = [bg, fg];
      ctx.globalAlpha = 1;
      if (bg !== theme.background) {
        ctx.fillStyle = bg;
        ctx.fillRect(x, y, width, ch);
      }
      if (cell.isInvisible()) continue;
      ctx.fillStyle = fg;
      ctx.globalAlpha = cell.isDim() ? 0.5 : 1;
      ctx.font = `${cell.isItalic() ? "italic " : ""}${cell.isBold() ? "700 " : "400 "}${fontSize}px ${family}`;
      ctx.fillText(cell.getChars(), x, y + ch * 0.51);
      if (cell.isUnderline())
        ctx.fillRect(x, y + ch * 0.88, width, Math.max(1, fontSize / 16));
      if (cell.isStrikethrough())
        ctx.fillRect(x, y + ch * 0.5, width, Math.max(1, fontSize / 16));
    }
  }
  ctx.globalAlpha = 1;
  if (cursor && buffer.viewportY === buffer.baseY) {
    ctx.fillStyle = theme.cursor!;
    ctx.globalAlpha = 0.65;
    ctx.fillRect(
      rect.x + buffer.cursorX * cw,
      rect.y + buffer.cursorY * ch,
      cw,
      ch,
    );
  }
  ctx.restore();
}

export type ScreenPoint = readonly [number, number];
export type ScreenProjection = {
  corners: readonly [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint];
  width: number;
  height: number;
};

/** Convert the now front-facing screen from stage units to viewport CSS pixels.
 * The working terminal must not inherit either stage scale or 3D perspective:
 * xterm's pointer coordinates, font metrics and DOM bounds must all agree.
 */
export function screenViewportRect(
  { corners: [p, q, r, s] }: ScreenProjection,
  stage: HTMLElement,
  viewport: HTMLElement,
) {
  const source = stage.getBoundingClientRect();
  const target = viewport.getBoundingClientRect();
  if (
    ![...p, ...q, ...r, ...s].every(Number.isFinite) ||
    stage.clientWidth <= 0 ||
    stage.clientHeight <= 0 ||
    target.width <= 0 ||
    target.height <= 0
  )
    return null;
  const x = (value: number) =>
    Math.round(
      source.left - target.left + (value * source.width) / stage.clientWidth,
    );
  const y = (value: number) =>
    Math.round(
      source.top - target.top + (value * source.height) / stage.clientHeight,
    );
  // Camera settling can leave a fraction of a pixel of perspective. Average
  // each pair of corners, then snap once instead of scaling a text bitmap.
  // Clamp during live window resizing so controls stay within the viewport.
  const left = Math.max(0, x((p[0] + s[0]) / 2));
  const right = Math.min(viewport.clientWidth, x((q[0] + r[0]) / 2));
  const top = Math.max(0, y((p[1] + q[1]) / 2));
  const bottom = Math.min(viewport.clientHeight, y((s[1] + r[1]) / 2));
  if (right - left < 40 || bottom - top < 40) return null;
  return { left, top, width: right - left, height: bottom - top };
}
