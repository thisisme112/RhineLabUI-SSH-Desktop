/** Reference coordinates remain exact during the film and at 1920 × 1080. */
export function openingLayout(width: number, height: number) {
  width = Math.max(1, width); height = Math.max(1, height);
  const scale = Math.min(height / 1080, width / 1280);
  return { width: width / scale, height: height / scale, scale, kind: "opening" as const };
}
export type PageLayout = "portrait" | "compact" | "desktop";
/**
 * `held` keeps the layout a page had before a software keyboard took part of its height.
 * Under a finger the desktop sheet (1080 units tall, scaled to fit) is only readable at close to its own size:
 * a tablet on its side reads the compact layout, at one CSS pixel to the unit, until it is 900 px tall.
 */
export function viewportLayout(width: number, height: number, coarse: boolean, cinematic = false, held?: PageLayout) {
  width = Math.max(1, width);
  height = Math.max(1, height);
  if (cinematic) return {
    width: 1920, height: 1080, scale: Math.min(width / 1920, height / 1080),
    kind: "cinematic" as const,
  };
  const portrait = held ? held === "portrait" : width / height < 1.05;
  const compact = held ? held !== "desktop" : portrait || width < 1100 || (coarse && height < 900);
  const scale = compact ? 1 : height / 1080;
  return { width: width / scale, height: height / scale, scale,
    kind: portrait ? "portrait" as const : compact ? "compact" as const : "desktop" as const };
}

/** Preserve the long-lens perspective. Reframe only the camera, never the card. */
export function archiveFraming(width: number, height: number, span: number, detail: number, compact: boolean) {
  const aspect = width / height;
  const portrait = aspect < 1.05;
  const baseSpan = span + (5.9 - span) * detail;
  const portraitDetailSpan = Math.max(6.3 / aspect, 3.7 * height / Math.max(100, 0.54 * height - 156));
  const viewSpan = portrait
    ? Math.max(baseSpan, 8.4 / aspect + (portraitDetailSpan - 8.4 / aspect) * detail)
    : Math.max(baseSpan, baseSpan * (16 / 9) / aspect);
  return {
    span: viewSpan,
    portrait,
    // Portrait selection is deliberately above its title and navigation.
    previewY: portrait ? 0.36 : 0.5,
    detailX: portrait ? 0.5 : compact ? 0.27 : 550 / 1920,
    detailY: portrait ? 0.27 + 34 / height : compact ? 0.49 : 560 / 1080,
  };
}
