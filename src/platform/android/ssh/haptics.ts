/**
 * Light haptic feedback for touch controls (Android WebView's Vibration API; the
 * app holds the VIBRATE permission). Off when the person turned it off
 * (`localStorage["rhine-haptics"] === "off"`) or asked for reduced motion.
 */
const enabled = () => {
  try { if (localStorage.getItem("rhine-haptics") === "off") return false; } catch { /* private mode: keep the default */ }
  return !matchMedia("(prefers-reduced-motion: reduce)").matches;
};
const pulse = (pattern: number | number[]) => { if (enabled()) try { navigator.vibrate?.(pattern); } catch { /* not supported here */ } };
export const haptics = {
  /** A key on the bar. */
  tick: () => pulse(8),
  /** A mode was switched on (Ctrl locked). */
  lock: () => pulse(14),
  /** A connection reached its shell. */
  success: () => pulse([10, 40, 16]),
  /** A connection failed or a session ended badly. */
  failure: () => pulse([30, 50, 30]),
};
