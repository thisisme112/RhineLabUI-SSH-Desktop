import { DESIGNS, motifGlyph, motifOf, type ThemeDesign } from "./theme-design";
import { LABELS, THEMES, type ThemeName } from "./theme-ui";

/**
 * The corner card a theme change leaves behind (the Unreal build's MakeThemeMark,
 * RhineThemeScene.cpp): the theme's own motif, its number, and its name turning
 * over letter by letter into the new one. It slides in a moment after the change
 * has begun, holds, and fades: 1.7 s in all. Home only, and not under reduced
 * motion, where a theme is simply applied.
 */
const LIFE = 1700;
const ENTER = 200;
const FADE_FROM = 1400;
let card: HTMLElement | undefined;
let timer = 0;
let animations: Animation[] = [];

export type ThemeMarkOptions = {
  stage: HTMLElement;
  /** The theme it turns over from; nothing turns when it is the first. */
  from?: ThemeName;
  to: ThemeName;
  reduced: boolean;
  /** Asked when the card would appear: whether the home is what is on screen. */
  visible: () => boolean;
  /** The change-over covers the screen at first: the card waits for it to clear. */
  delay?: number;
};

export function showThemeMark(o: ThemeMarkOptions) {
  window.clearTimeout(timer);
  if (o.reduced) { hideThemeMark(); return; }
  // A sheet in the top layer (the settings that offered the choice) hides anything under it, so the
  // card waits for the home to be what is on screen, looking again a few times a second.
  const attempt = (tries: number) => {
    if (o.visible()) place(o);
    else if (tries < 80) timer = window.setTimeout(() => attempt(tries + 1), 250);
  };
  timer = window.setTimeout(() => attempt(0), o.delay ?? 300);
}

export function hideThemeMark() {
  window.clearTimeout(timer);
  for (const a of animations) a.cancel();
  animations = [];
  card?.remove();
  card = undefined;
}

function place(o: ThemeMarkOptions) {
  hideThemeMark();
  const design = (DESIGNS as Record<string, ThemeDesign>)[o.to];
  const index = THEMES.indexOf(o.to) + 1;
  const el = document.createElement("aside");
  el.className = "theme-mark";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = `<i class="theme-mark-bar"></i><span class="theme-mark-glyph">${motifGlyph(motifOf(o.to))}</span>` +
    `<div class="theme-mark-text"><small>THEME ${String(index).padStart(2, "0")} / ${THEMES.length} · ${design?.latin ?? o.to.toUpperCase()}</small><strong></strong></div>`;
  // Fixed to the window and appended to the body, so no panel of the stage can stand over it.
  document.body.append(el);
  card = el;
  flipName(el.querySelector("strong")!, o.from ? LABELS[o.from] : "", LABELS[o.to]);
  const life = el.animate([
    { opacity: 0, transform: "translateX(-18px)", offset: 0 },
    { opacity: 1, transform: "translateX(0)", offset: ENTER / LIFE },
    { opacity: 1, transform: "translateX(0)", offset: FADE_FROM / LIFE },
    { opacity: 0, transform: "translateX(0)", offset: 1 },
  ], { duration: LIFE, easing: "linear", fill: "both" });
  animations.push(life);
  life.finished.then(() => { if (card === el) hideThemeMark(); }, () => {});
}

/** Each letter turns over on its own, left to right, from the old name to the new. */
function flipName(target: HTMLElement, from: string, to: string) {
  const length = Math.max(from.length, to.length);
  for (let i = 0; i < length; i++) {
    const slot = document.createElement("span");
    slot.className = "theme-mark-letter";
    const before = document.createElement("b"), after = document.createElement("b");
    before.textContent = from[i] ?? " ";
    after.textContent = to[i] ?? " ";
    slot.append(before, after);
    target.append(slot);
    const delay = ENTER + i * 55;
    if (from) {
      animations.push(before.animate([{ transform: "rotateX(0)", opacity: 1 }, { transform: "rotateX(-90deg)", opacity: 0 }], { duration: 170, delay, easing: "cubic-bezier(.5,0,1,1)", fill: "both" }));
      animations.push(after.animate([{ transform: "rotateX(90deg)", opacity: 0 }, { transform: "rotateX(0)", opacity: 1 }], { duration: 200, delay: delay + 170, easing: "cubic-bezier(0,0,.2,1)", fill: "both" }));
    } else {
      before.hidden = true;
    }
  }
}
