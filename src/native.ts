/**
 * The Capacitor Android shell.
 *
 * The Android build uses a local HTTPS origin and native SSH plugins. Native
 * navigation is independent of browser history, so WebView reloads cannot leave
 * stale history entries behind the app's screens. Web/desktop/wallpaper builds
 * neither invoke this module's native operations nor carry its plugins.
 *
 *   - the hardware and gesture back button, which is not a history event in the
 *     shell and so has to be answered explicitly (see `src/history-nav.ts` for
 *     the browser's version of the same idea);
 *   - a status bar that can be told which of the two palettes it is over.
 */

import { isAndroid } from "./android";

interface CapacitorBridge {
  isNativePlatform?: () => boolean;
}

const bridge = () =>
  (window as Window & { Capacitor?: CapacitorBridge }).Capacitor;

export const isNativeShell = () => isAndroid && bridge()?.isNativePlatform?.() === true;

export async function initNativeShell(goBack: () => boolean, hasActiveSession: () => boolean) {
  if (!isNativeShell()) return;
  await import("./android.css");
  document.documentElement.dataset.nativeShell = "true";

  const [{ App }, { StatusBar, Style }] = await Promise.all([
    import("@capacitor/app"),
    import("@capacitor/status-bar"),
  ]);

  // The shell's back is answered here rather than left to the WebView: the
  // app has its own idea of "one level up" (the same one Escape and a browser
  // pop take), and only when that runs out should the app actually close.
  await App.addListener("backButton", () => {
    if (goBack()) return;
    // Returning to the launcher must not destroy an active SSH connection.
    if (hasActiveSession()) void App.minimizeApp();
    else void App.exitApp();
  });

  // Android WebView does not consistently publish status-bar safe-area env
  // values. Keep the system bar outside the content instead of covering inputs.
  await StatusBar.setOverlaysWebView({ overlay: false });
  const paint = () => {
    const dark = document.documentElement.dataset.darkSurface === "true";
    void StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light });
    const color = getComputedStyle(document.documentElement).getPropertyValue("--theme-paper").trim();
    const channels = color.match(/\d+/g);
    if (channels?.length === 3)
      void StatusBar.setBackgroundColor({ color: "#" + channels.map(v => Number(v).toString(16).padStart(2, "0")).join("") });
  };
  paint();
  new MutationObserver(paint).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-dark-surface"],
  });
}
