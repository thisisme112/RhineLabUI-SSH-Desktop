/** Native-only features are removed from web, desktop and wallpaper bundles. */
export const isAndroid = import.meta.env.MODE === "android";
