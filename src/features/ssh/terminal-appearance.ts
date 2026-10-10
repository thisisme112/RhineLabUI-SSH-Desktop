import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-700.css";
import type { ITerminalOptions } from "@xterm/xterm";

export const TERMINAL_FONTS = {
  // The theme's own face (THEME_TYPE); its family is resolved against the theme in use.
  theme: { name: "随主题", family: "" },
  jetbrains: { name: "JetBrains Mono", family: '"JetBrains Mono", monospace' },
  plex: { name: "IBM Plex Mono", family: '"IBM Plex Mono", monospace' },
  system: {
    name: "系统等宽",
    family: '"Cascadia Mono", Consolas, "Liberation Mono", Menlo, monospace',
  },
  consolas: { name: "Consolas", family: 'Consolas, "Cascadia Mono", "Liberation Mono", Menlo, monospace' },
} as const;
type TerminalType = { font: Exclude<keyof typeof TERMINAL_FONTS, "theme">; size: number; spacing: number; lineHeight: number };
/** What the settings' own figures stand for: a theme's type is read as a departure from this. */
const REFERENCE_TYPE: TerminalType = { font: "jetbrains", size: 13, spacing: 0, lineHeight: 1.15 };
/**
 * Each theme sets its terminal in its own face, size, tracking and leading (the Unreal build's
 * RhineTheme.cpp TerminalType, figure for figure). The settings add to it: a size of 15, two over
 * the default, shows 16 under a theme whose own size is 14.
 */
const THEME_TYPE: Record<string, TerminalType> = {
  paper: { font: "plex", size: 13.5, spacing: 0, lineHeight: 1.2 },       // a typed record
  night: { font: "jetbrains", size: 13, spacing: 0, lineHeight: 1.15 },
  hazard: { font: "consolas", size: 14, spacing: .2, lineHeight: 1.1 },   // a control readout, set tight
  clinic: { font: "system", size: 13, spacing: 0, lineHeight: 1.2 },
  orbit: { font: "system", size: 13, spacing: .3, lineHeight: 1.15 },     // telemetry, tracked out
  print: { font: "plex", size: 14, spacing: .3, lineHeight: 1.15 },       // the proof's typed copy
  transit: { font: "plex", size: 13, spacing: 0, lineHeight: 1.2 },
  slate: { font: "jetbrains", size: 13, spacing: 0, lineHeight: 1.25 },
  reagent: { font: "consolas", size: 13.5, spacing: .1, lineHeight: 1.15 },
  cryo: { font: "system", size: 13.5, spacing: .2, lineHeight: 1.2 },
};
const themeType = () => THEME_TYPE[document.documentElement.dataset.colorPalette ?? ""] ?? REFERENCE_TYPE;
/** The cursor shapes the Unreal build offers (方块 / 竖线 / 下划线), as xterm names them. */
export const TERMINAL_CURSORS = { block: "方块", bar: "竖线", underline: "下划线" } as const;
export type TerminalAppearance = {
  version: 1;
  font: keyof typeof TERMINAL_FONTS;
  size: number;
  spacing: number;
  lineHeight: number;
  /** Absent in settings and backups saved before the cursor could be chosen. */
  cursor?: keyof typeof TERMINAL_CURSORS;
  blink?: boolean;
};
export const TERMINAL_FONT = TERMINAL_FONTS.jetbrains.family;
export const DEFAULT_FONT_SIZE = import.meta.env.MODE === "android" ? 11 : 13;
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;
const KEY = "rhine.ssh.terminal-appearance";
// The Unreal build's FRhineTerminalLook defaults: a blinking bar.
const defaults = (): Required<TerminalAppearance> => ({
  version: 1,
  font: "theme",
  size: DEFAULT_FONT_SIZE,
  spacing: 0,
  lineHeight: 1.15,
  cursor: "bar",
  blink: true,
});
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
export function validAppearance(value: unknown): value is TerminalAppearance {
  const a = value as TerminalAppearance;
  return (
    !!a &&
    a.version === 1 &&
    Object.hasOwn(TERMINAL_FONTS, a.font) &&
    Number.isFinite(a.size) &&
    a.size >= 8 &&
    a.size <= 32 &&
    Number.isFinite(a.spacing) &&
    a.spacing >= -1 &&
    a.spacing <= 3 &&
    Number.isFinite(a.lineHeight) &&
    a.lineHeight >= 1 &&
    a.lineHeight <= 2 &&
    (a.cursor === undefined || Object.hasOwn(TERMINAL_CURSORS, a.cursor)) &&
    (a.blink === undefined || typeof a.blink === "boolean")
  );
}
class AppearanceStore {
  value: Required<TerminalAppearance> = defaults();
  error = "";
  private readOnly = false;
  private listeners = new Set<() => void>();
  constructor() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (!validAppearance(saved))
          throw new Error("字体设置版本无法读取，原数据已保留");
        this.value = { ...defaults(), ...saved };
      } else {
        const size = Number(
          localStorage.getItem("rhine-ssh-terminal-font-size"),
        );
        if (size >= MIN_FONT_SIZE && size <= MAX_FONT_SIZE)
          this.value.size = size;
      }
    } catch (error) {
      this.readOnly = true;
      this.error = String(error);
    }
    // A change of theme changes the type under the same settings (theme-ui.ts sets the attribute).
    new MutationObserver(() => { for (const listener of this.listeners) listener(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ["data-color-palette"] });
  }
  /** The type on screen: the theme's, moved by as much as the settings stand off their defaults. */
  get resolved() {
    const a = this.value, theme = themeType();
    return {
      family: TERMINAL_FONTS[a.font === "theme" ? theme.font : a.font].family,
      size: Math.round(clamp(a.size + theme.size - REFERENCE_TYPE.size, MIN_FONT_SIZE, MAX_FONT_SIZE) * 2) / 2,
      spacing: Math.round(clamp(a.spacing + theme.spacing - REFERENCE_TYPE.spacing, -1, 3) * 10) / 10,
      lineHeight: Math.round(clamp(a.lineHeight + theme.lineHeight - REFERENCE_TYPE.lineHeight, 1, 2) * 100) / 100,
    };
  }
  update(patch: Partial<Omit<TerminalAppearance, "version">>) {
    if (this.readOnly) return false;
    const next: Required<TerminalAppearance> = { ...this.value, ...patch, version: 1 };
    next.cursor ??= this.value.cursor;
    next.blink ??= this.value.blink;
    next.size = Math.round(clamp(next.size, 8, 32) * 2) / 2;
    next.spacing = Math.round(clamp(next.spacing, -1, 3) * 10) / 10;
    next.lineHeight = Math.round(clamp(next.lineHeight, 1, 2) * 100) / 100;
    if (!validAppearance(next)) return false;
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
      this.error = "";
    } catch {
      this.error = "字体设置未能保存，本次会话仍会应用";
    }
    this.value = next;
    for (const listener of this.listeners) listener();
    return true;
  }
  reset() {
    return this.update(defaults());
  }
  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** A program may still set its own shape (DECSCUSR); reduced motion keeps the cursor steady. */
  options(reduced = false): ITerminalOptions {
    const a = this.value, type = this.resolved;
    return {
      fontFamily: type.family,
      fontSize: type.size,
      letterSpacing: type.spacing,
      lineHeight: type.lineHeight,
      cursorStyle: a.cursor,
      cursorBlink: a.blink && !reduced,
    };
  }
  async ready() {
    const family = this.resolved.family.split(",")[0];
    await Promise.allSettled([
      document.fonts.load(`400 14px ${family}`),
      document.fonts.load(`700 14px ${family}`),
    ]);
  }
}
export const terminalAppearance = new AppearanceStore();
