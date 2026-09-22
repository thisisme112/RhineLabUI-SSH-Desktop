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

/**
 * How much of the top-right corner Windows keeps for minimise / maximise / close.
 *
 * `titleBarOverlay` accepts a colour and a height but no width — the OS decides
 * how wide its three caption buttons are, so main can only reserve the room, and
 * this is how much to reserve: three buttons at the standard caption width, in
 * DIPs, which is the unit the overlay is measured in and so already accounts for
 * display scaling. Mirrors `CHROME_HEIGHT` in electron/main.cjs, which sets the
 * overlay's height; the two have to agree or a full-window surface reserves the
 * wrong corner. Only the frameless Windows shell has that overlay — macOS and
 * Linux desktop builds keep their native caption, and web builds have none.
 */
const WINDOW_CONTROLS_WIDTH = 138;
if (isDesktop && window.rhineDesktop?.platform === "win32")
  document.documentElement.style.setProperty(
    "--window-controls-width",
    `${WINDOW_CONTROLS_WIDTH}px`,
  );
