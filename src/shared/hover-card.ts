import "./hover-card.css";
import { motifOf } from "../features/theme/theme-design";

/**
 * The hover detail card (the Unreal build's RhineHoverCard.h): the row under the
 * pointer, enlarged. One card for the whole page, laid out as ObsidianUI's Hover
 * Image (obsidianui.dev/docs/hover-img) and moving like a drop of water:
 *
 *   - centred on the pointer, kept 16 px inside the viewport, and it stays with
 *     the hand: a critically damped spring (FOLLOW: a thirtieth of a second
 *     behind, 32 px at 960 px/s) where a 0.4 s tween trailed by three times that;
 *   - it swells out of the pointer with a small overshoot (0.3 s) and is gone
 *     0.16 s after the pointer leaves the list. Moving from one row to the next
 *     does not close it: the new content slides in like a reel (0.24 s) while
 *     the card's window grows or shrinks to it, in the direction the pointer went;
 *   - it stretches along its travel and narrows across it; when the pointer
 *     stops, the stretch swings back through a slight squash before the card
 *     rounds off (an under-damped spring on the stretch alone: the place itself
 *     never overshoots);
 *   - its type is larger than the rows it explains, and it sits on a large soft
 *     shadow.
 *
 * Both springs take their exact step over the frame's time, so a slow frame
 * cannot throw the card. Each motif still dresses it its own way (hover-card.css).
 */
export type HoverContent = {
  title: string;
  kicker?: string;
  rows: readonly (readonly [string, string])[];
  /** Which --theme-signal-N colours the card's mark. */
  series?: number;
};

/** A leave only counts once no other row has been entered (the gap between two rows). */
const GRACE = 70, REEL = 240, GROW = 300, SHRINK = 160, INSET = 16;
/** How closely the card keeps to the pointer (1/s), how far it may stretch, and how the stretch swings back. */
const FOLLOW = 60, MAX_STRETCH = .16, WOBBLE = 24, WOBBLE_DAMPING = .42;
const outQuad = (t: number) => { t = Math.min(1, Math.max(0, t)); return 1 - (1 - t) * (1 - t); };
/** Out-back with a small overshoot (about 5 %). */
const outBack = (t: number) => { t = Math.min(1, Math.max(0, t)) - 1; return 1 + 2.25 * t * t * t + 1.25 * t * t; };

type Size = { w: number; h: number };
let card: HTMLElement | undefined;
let reelWindow: HTMLElement | undefined;
let faces: HTMLElement[] = [];
let sizes: Size[] = [{ w: 0, h: 0 }, { w: 0, h: 0 }];
let front = 0;
let owner: HTMLElement | undefined;
let content: ((el: HTMLElement) => HoverContent | null) | undefined;
let pointer = { x: 0, y: 0 }, lastY = 0;
let position = { x: 0, y: 0 }, velocity = { x: 0, y: 0 }, axis = { x: 1, y: 0 }, stretch = 0, stretchVelocity = 0, tickedAt = 0, snap = false;
let wanted = false, leaveAt = -1, reelAt = -1, reelDirection = 1;
let scale = 0, scaleFrom = 0, scaleTo = 0, scaleAt = 0, scaleFor = 0;
let frame = 0, refresh = 0;
let reduced = () => false;
let onShow: (() => void) | undefined;

export function configureHoverCards(options: { reduced: () => boolean; onShow?: () => void }) {
  reduced = options.reduced;
  onShow = options.onShow;
}

function element() {
  if (card) return card;
  card = document.createElement("div");
  card.className = "rhine-hover-card";
  card.setAttribute("role", "tooltip");
  card.hidden = true;
  card.innerHTML = '<i class="rhine-hover-mark" aria-hidden="true"></i><div class="rhine-hover-window"><div class="rhine-hover-face"><small></small><strong></strong><dl></dl></div><div class="rhine-hover-face" aria-hidden="true" hidden><small></small><strong></strong><dl></dl></div></div>';
  reelWindow = card.querySelector<HTMLElement>(".rhine-hover-window")!;
  faces = [...card.querySelectorAll<HTMLElement>(".rhine-hover-face")];
  document.body.append(card);
  return card;
}

function fill(face: HTMLElement, value: HoverContent) {
  face.querySelector("small")!.textContent = value.kicker ?? "";
  face.querySelector("strong")!.textContent = value.title;
  const list = face.querySelector("dl")!;
  // Rows are reused so a card that refreshes every half second never relays out its text nodes.
  while (list.children.length > value.rows.length * 2) list.lastElementChild!.remove();
  value.rows.forEach(([label, text], i) => {
    let dt = list.children[i * 2] as HTMLElement | undefined, dd = list.children[i * 2 + 1] as HTMLElement | undefined;
    if (!dt) { dt = document.createElement("dt"); list.append(dt); }
    if (!dd) { dd = document.createElement("dd"); list.append(dd); }
    if (dt.textContent !== label) dt.textContent = label;
    if (dd.textContent !== text) dd.textContent = text;
  });
  element().style.setProperty("--card-series", `var(--theme-signal-${(value.series ?? 0) % 5}, var(--theme-accent))`);
}

/** The card round its window (padding and border), which the motif decides. */
let chrome: Size = { w: 0, h: 0 };
/** A face's own size, and the card's chrome: measured when the content changes, not every frame. */
function measure(index: number) {
  const face = faces[index], c = element();
  sizes[index] = { w: face.offsetWidth, h: face.offsetHeight };
  chrome = { w: c.offsetWidth - reelWindow!.offsetWidth, h: c.offsetHeight - reelWindow!.offsetHeight };
}

function startScale(to: number, duration: number, now: number) {
  scaleFrom = scale; scaleTo = to; scaleAt = now; scaleFor = duration;
}

function tick(now: number) {
  frame = 0;
  const c = element();
  const still = reduced();
  const dt = Math.min(.1, Math.max(0, (now - tickedAt) / 1000));
  tickedAt = now;
  // Leaving the list: a row's leave only counts once no other row has been entered.
  if (leaveAt >= 0 && now - leaveAt >= GRACE) { leaveAt = -1; wanted = false; owner = undefined; content = undefined; startScale(0, SHRINK, now); }
  // The drop swells past its size and settles; it leaves without a bounce.
  scale = still ? scaleTo : scaleFrom + (scaleTo - scaleFrom) * (scaleTo > scaleFrom ? outBack : outQuad)(scaleFor > 0 ? (now - scaleAt) / scaleFor : 1);
  if (scale <= .001 && !wanted) { c.hidden = true; return; }

  // The reel: both faces slide by the window's height; the window follows the content's size.
  const p = still || reelAt < 0 ? 1 : outQuad((now - reelAt) / REEL), back = front ^ 1;
  const size = p >= 1 ? sizes[front] : { w: sizes[back].w + (sizes[front].w - sizes[back].w) * p, h: sizes[back].h + (sizes[front].h - sizes[back].h) * p };
  reelWindow!.style.width = `${size.w}px`;
  reelWindow!.style.height = `${size.h}px`;
  faces[front].style.transform = `translateY(${((1 - p) * reelDirection * size.h).toFixed(1)}px)`;
  faces[back].hidden = p >= 1;
  if (p < 1) faces[back].style.transform = `translateY(${(-p * reelDirection * size.h).toFixed(1)}px)`;

  // Centred on the pointer, kept inside the viewport.
  const w = size.w + chrome.w, h = size.h + chrome.h;
  const aim = {
    x: innerWidth > w + 2 * INSET ? Math.min(Math.max(pointer.x, w / 2 + INSET), innerWidth - w / 2 - INSET) : innerWidth / 2,
    y: innerHeight > h + 2 * INSET ? Math.min(Math.max(pointer.y, h / 2 + INSET), innerHeight - h / 2 - INSET) : innerHeight / 2,
  };
  if (snap || still) { position = { ...aim }; velocity = { x: 0, y: 0 }; stretch = stretchVelocity = 0; snap = false; }
  else {
    // The place: critically damped towards the pointer, the exact step over dt.
    const decay = Math.exp(-FOLLOW * dt);
    for (const k of ["x", "y"] as const) {
      const offset = position[k] - aim[k], impulse = velocity[k] + FOLLOW * offset;
      position[k] = aim[k] + (offset + impulse * dt) * decay;
      velocity[k] = (impulse - FOLLOW * (offset + impulse * dt)) * decay;
    }
    // The stretch: as much as the card travels, along the way it travels. Under-damped
    // (the exact step again), so a stop swings it through a slight squash before it rests.
    const speed = Math.hypot(velocity.x, velocity.y);
    if (speed > 40) axis = { x: velocity.x / speed, y: velocity.y / speed };
    const want = Math.min(MAX_STRETCH, speed / 6000);
    const a = WOBBLE * WOBBLE_DAMPING, wd = WOBBLE * Math.sqrt(1 - WOBBLE_DAMPING * WOBBLE_DAMPING);
    const x0 = stretch - want, v0 = stretchVelocity, e = Math.exp(-a * dt), cos = Math.cos(wd * dt), sin = Math.sin(wd * dt);
    stretch = want + e * (x0 * cos + (v0 + a * x0) / wd * sin);
    stretchVelocity = e * (v0 * cos - (a * v0 + WOBBLE * WOBBLE * x0) / wd * sin);
  }
  // Longer along the travel, narrower across it, about the card's centre.
  const give = Math.min(.2, Math.max(-.08, stretch)), whole = Math.max(scale, .001);
  const along = whole * (1 + give), across = whole * (1 - .6 * give), skew = (along - across) * axis.x * axis.y;
  c.style.transform = `translate3d(${(position.x - w / 2).toFixed(1)}px, ${(position.y - h / 2).toFixed(1)}px, 0) matrix(${(along * axis.x * axis.x + across * axis.y * axis.y).toFixed(4)}, ${skew.toFixed(4)}, ${skew.toFixed(4)}, ${(along * axis.y * axis.y + across * axis.x * axis.x).toFixed(4)}, 0, 0)`;

  if (wanted && owner && content && now - refresh > 500) {
    refresh = now;
    const value = owner.isConnected ? content(owner) : null;
    if (value) { fill(faces[front], value); measure(front); } else hideAll();
  }
  frame = requestAnimationFrame(tick);
}

function show(el: HTMLElement, read: (el: HTMLElement) => HoverContent | null) {
  const value = read(el);
  if (!value) return;
  const c = element(), now = performance.now();
  leaveAt = -1;
  if (wanted && el === owner) return;
  owner = el; content = read; refresh = now;
  c.dataset.motif = motifOf(document.documentElement.dataset.colorPalette);
  c.hidden = false;
  if (scale <= .02 && !wanted) {
    // Nothing on screen: the card starts under the pointer.
    front = 0; faces[1].hidden = true;
    fill(faces[0], value); measure(0); sizes[1] = sizes[0];
    reelAt = -1; snap = true;
  } else {
    // A card is up (or still leaving): the new content enters from the side the pointer went.
    front ^= 1;
    faces[front].hidden = false;
    fill(faces[front], value); measure(front);
    reelAt = now; reelDirection = pointer.y >= lastY ? 1 : -1;
  }
  lastY = pointer.y;
  if (!wanted) { wanted = true; startScale(1, GROW, now); onShow?.(); }
  if (!frame) frame = requestAnimationFrame(tick);
}

/** The pointer left the card's row: it closes unless another row is entered at once. */
function release() {
  if (wanted && leaveAt < 0) leaveAt = performance.now();
  if (!frame && card && !card.hidden) frame = requestAnimationFrame(tick);
}

/** Close now: a press, a scroll, or the rows under the pointer were rebuilt. */
function hideAll() {
  leaveAt = -1; owner = undefined; content = undefined;
  if (!wanted) return;
  wanted = false; startScale(0, SHRINK, performance.now());
  if (!frame) frame = requestAnimationFrame(tick);
}
export const hide = hideAll;

/**
 * Cards for every `selector` match inside `root`. `read` is asked again every
 * half second while the card is up, so live values stay live.
 */
export function bindHoverCards(root: HTMLElement, selector: string, read: (el: HTMLElement) => HoverContent | null, signal?: AbortSignal) {
  root.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    pointer = { x: e.clientX, y: e.clientY };
    if (card && !card.hidden && !frame) frame = requestAnimationFrame(tick);
    const el = (e.target as Element).closest<HTMLElement>(selector);
    if (!el || !root.contains(el) || e.buttons) { if (owner && root.contains(owner)) release(); return; }
    show(el, read);
  }, { signal });
  root.addEventListener("pointerleave", () => { if (!owner || root.contains(owner)) release(); }, { signal });
  root.addEventListener("pointerdown", () => hideAll(), { signal });
  root.addEventListener("wheel", () => hideAll(), { signal, passive: true });
}
