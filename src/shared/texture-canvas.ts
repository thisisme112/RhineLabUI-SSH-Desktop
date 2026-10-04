/**
 * The 2D context of a canvas that is drawn in order to become a WebGL texture.
 *
 * Such a canvas stays in memory. A GPU-backed 2D canvas is a context of its own: handing it to
 * WebGL makes the two wait for each other in the GPU process, and the frame that uploaded a
 * card's printed label and its terminal screen stalled 35 to 50 ms there with almost no script
 * running (2026-10-04; 14 ms with the canvases in memory, on the archive home and under the
 * host overview alike). `willReadFrequently` is how a page asks for a canvas kept in memory.
 * It only counts on a canvas's first getContext call, so every such canvas gets its context here.
 */
export function textureContext(canvas: HTMLCanvasElement) {
  return canvas.getContext("2d", { willReadFrequently: true })!;
}
