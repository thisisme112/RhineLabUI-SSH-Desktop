import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-700.css";
import type { ITerminalOptions } from "@xterm/xterm";

export const TERMINAL_FONTS = {
  jetbrains: { name: "JetBrains Mono", family: '"JetBrains Mono", monospace' },
  plex: { name: "IBM Plex Mono", family: '"IBM Plex Mono", monospace' },
  system: {
    name: "系统等宽",
    family: '"Cascadia Mono", Consolas, "Liberation Mono", Menlo, monospace',
  },
} as const;
export type TerminalAppearance = {
  version: 1;
  font: keyof typeof TERMINAL_FONTS;
  size: number;
  spacing: number;
  lineHeight: number;
};
export const TERMINAL_FONT = TERMINAL_FONTS.jetbrains.family;
export const DEFAULT_FONT_SIZE = import.meta.env.MODE === "android" ? 11 : 13;
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;
const KEY = "rhine.ssh.terminal-appearance";
const defaults = (): TerminalAppearance => ({
  version: 1,
  font: "jetbrains",
  size: DEFAULT_FONT_SIZE,
  spacing: 0,
  lineHeight: 1.15,
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
    a.lineHeight <= 2
  );
}
class AppearanceStore {
  value = defaults();
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
        this.value = saved;
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
  }
  update(patch: Partial<Omit<TerminalAppearance, "version">>) {
    if (this.readOnly) return false;
    const next: TerminalAppearance = { ...this.value, ...patch, version: 1 };
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
  options(): ITerminalOptions {
    const a = this.value;
    return {
      fontFamily: TERMINAL_FONTS[a.font].family,
      fontSize: a.size,
      letterSpacing: a.spacing,
      lineHeight: a.lineHeight,
    };
  }
  async ready() {
    const family = TERMINAL_FONTS[this.value.font].family.split(",")[0];
    await Promise.allSettled([
      document.fonts.load(`400 14px ${family}`),
      document.fonts.load(`700 14px ${family}`),
    ]);
  }
}
export const terminalAppearance = new AppearanceStore();
