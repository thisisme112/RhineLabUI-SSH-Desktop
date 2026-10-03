/** Native-only features are removed from web, desktop and wallpaper bundles. */
export const isAndroid = import.meta.env.MODE === "android";
/**
 * A phone, whichever bundle it runs: the Android app, or the web app opened on one (a finger for a
 * pointer and a short side of a phone's width; tablets and touch laptops keep the desktop defaults).
 * It decides how the scene is drawn by default (render-quality.ts `mobile`, the 60 fps budget, the
 * resolution governor), not which features exist.
 */
export const isPhone = isAndroid || (typeof matchMedia === "function" && typeof screen !== "undefined"
  && matchMedia("(pointer: coarse)").matches && matchMedia("(hover: none)").matches && Math.min(screen.width, screen.height) <= 540);
