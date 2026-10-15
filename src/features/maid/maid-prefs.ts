import { LOOK_COUNT } from "./maid-lines";

/**
 * How she stands in the terminal (the Unreal build's FRhineClaude TerminalLook / TerminalReacts): one of the looks
 * (maid-lines.ts LOOKS, 0 her bust), and whether a picture gives way to the pose of the moment. Kept in this browser;
 * the wheel over her and 设置 → 外观 change it.
 */
const KEY = "rhine-maid";
type MaidPrefs = { look: number; reacts: boolean };
const listeners = new Set<() => void>();

function read(): MaidPrefs {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<MaidPrefs>;
    const look = Number(value.look);
    return { look: Number.isInteger(look) && look >= 0 && look < LOOK_COUNT ? look : 0, reacts: value.reacts !== false };
  } catch {
    return { look: 0, reacts: true };
  }
}
const prefs = read();

export const maidPrefs: Readonly<MaidPrefs> = prefs;

export function setMaidPrefs(change: Partial<MaidPrefs>) {
  if (change.look !== undefined) prefs.look = ((change.look % LOOK_COUNT) + LOOK_COUNT) % LOOK_COUNT;
  if (change.reacts !== undefined) prefs.reacts = change.reacts;
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private window: this session only */ }
  for (const listener of listeners) listener();
}

export function onMaidPrefs(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
