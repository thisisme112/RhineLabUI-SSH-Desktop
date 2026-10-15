import { assetUrl } from "../../shared/asset-url";
import type { Mascot } from "../theme/theme-design";

/**
 * The two maids' pictures (public/maid, from the Unreal build's Content/Data by scripts/build/build-maid-art.mjs), in
 * the Unreal build's one numbering for both (RhineThemeFx.cpp ClaudeFiles / DeepSeekFiles): Claude's cut-outs and
 * the poses drawn of her; DeepSeek's three from her sheet (standing, saluting, leaning) and the poses drawn of her.
 *
 * They are decoded off the main thread (createImageBitmap from the fetched file). Unreal decoded a picture inside the
 * frame that first drew it, some 15 ms each, and a maid's change-over draws several at once: a 100 ms frame as her
 * theme came on (2026-10-15). Here the first ask starts the decode and answers nothing; the picture is there a frame
 * or two later, and onMaidArt tells the drawers that keep a picture (the poster) to draw again. preloadMaid asks for a
 * maid's whole set ahead of time, as soon as her theme is chosen.
 */
const FILES: Record<Mascot, readonly (string | null)[]> = {
  claude: ["standing", "lookout", "leaning", "pose-wave", "pose-tea", "pose-cheer", "pose-doze", "pose-bow", "pose-angry", "pose-fix", "pose-celebrate", "pose-walk1", "pose-walk2", null],
  deepseek: ["stand", "salute", "lean", "pose-wave", "pose-snack", "pose-cheer", "pose-doze", "pose-walk2", "pose-cross", "pose-fix", "pose-celebrate", "pose-walk1", "pose-walk2", "pose-swim"],
};
/** The numbering's names. */
export const ART = { stand: 0, lookout: 1, lean: 2, wave: 3, tea: 4, cheer: 5, doze: 6, bow: 7, angry: 8, fix: 9, celebrate: 10, walk1: 11, walk2: 12, swim: 13 } as const;
/** The bust and the face patches laid over it: 0 the bust, 1–7 the moods, 8 a blink, 9 the mouth open. */
export const FACES = ["bust", "happy", "worried", "surprised", "proud", "sleepy", "thinking", "shy", "blink", "talk"] as const;
export const MOODS = { none: 0, happy: 1, worried: 2, surprised: 3, proud: 4, sleepy: 5, thinking: 6, shy: 7 } as const;
export type Mood = keyof typeof MOODS;

type Entry = { bitmap?: ImageBitmap; failed?: boolean; promise?: Promise<ImageBitmap | undefined> };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

export function maidUrl(who: Mascot, file: string) {
  return assetUrl(`maid/${who}/${file}.webp`);
}

function load(who: Mascot, file: string): Entry {
  const key = who + "/" + file;
  let entry = entries.get(key);
  if (entry) return entry;
  entry = {};
  entries.set(key, entry);
  const own = entry;
  own.promise = fetch(maidUrl(who, file))
    .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.blob(); })
    .then(blob => createImageBitmap(blob, { premultiplyAlpha: "premultiply" }))
    .then(bitmap => { own.bitmap = bitmap; for (const listener of listeners) listener(); return bitmap; })
    .catch(() => { own.failed = true; return undefined; });
  return own;
}

/** A picture by name (`fin`, `avatar`, `bust`, `face-happy`…): there once decoded, nothing until then (its decode is started). */
export function maidPicture(who: Mascot, file: string): ImageBitmap | undefined {
  return load(who, file).bitmap;
}

/** A picture in the numbering (ART): nothing for none at that place, or while it is being decoded. */
export function maidArt(who: Mascot, index: number): ImageBitmap | undefined {
  const file = FILES[who][index];
  return file ? maidPicture(who, file) : undefined;
}

/** A face (FACES): 0 the bust. */
export function maidFace(who: Mascot, index: number): ImageBitmap | undefined {
  const name = FACES[index];
  return name ? maidPicture(who, index === 0 ? "bust" : "face-" + name) : undefined;
}

/** Every picture of a maid, decoded: resolves when all are in (or have failed). */
export function preloadMaid(who: Mascot): Promise<void> {
  const files = [...FILES[who].filter((f): f is string => !!f), ...FACES.map((f, i) => (i === 0 ? "bust" : "face-" + f)), "avatar", "fin"];
  return Promise.all(files.map(f => load(who, f).promise)).then(() => undefined);
}

/** Told whenever a picture has come in (a drawer that keeps what it drew draws again). Returns the unsubscribe. */
export function onMaidArt(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const tints = new WeakMap<CanvasImageSource, Map<string, HTMLCanvasElement>>();
/** The picture in one flat colour (her fin as a tail, a hologram's coloured ghost), made once per colour. */
export function tinted(image: ImageBitmap, color: string): HTMLCanvasElement {
  let byColor = tints.get(image);
  if (!byColor) tints.set(image, byColor = new Map());
  let canvas = byColor.get(color);
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    byColor.set(color, canvas);
  }
  return canvas;
}
