/**
 * Desktop (Electron) shell detection.
 *
 * The desktop build is served from `file://`, so every web-only surface has to
 * stay off: no service worker, no install prompt, and no offline cache — those
 * all silently fail or throw under a file origin. Wallpaper mode already had to
 * solve the same problem (see `wallpaper.ts`); this is the second host, so the
 * check lives next to it rather than inside it.
 */
export const isDesktop = import.meta.env.MODE === "desktop";
if (isDesktop) document.documentElement.dataset.desktop = "true";
