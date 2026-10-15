import type { MaidAssistantState } from "../maid-terminal";

/**
 * Where the terminal (ssh/terminal.ts, loaded later than the page) meets the maid's assistant (wired by the app):
 * what she adds to the corner, a look at each key before the terminal takes it, what the reader typed, and 问小克 in
 * the bar. Set once by the app; the terminal only calls them.
 */
type Panel = object;
export const terminalMaid = {
  state: (): MaidAssistantState => ({}),
  keys: (_panel: Panel, _event: KeyboardEvent): boolean => false,
  typed: (_panel: Panel, _data: string): void => {},
  ask: (): void => {},
};
