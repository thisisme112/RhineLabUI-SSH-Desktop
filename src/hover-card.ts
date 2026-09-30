import "./hover-card.css";
import { motifOf } from "./theme-design";

/**
 * The drop-follow detail card (the Unreal build's RhineHoverCard.h). One card
 * for the whole page: it grows out of the pointer, trails it on a spring and
 * stretches along its travel like a drop, then settles back into shape. Each
 * motif dresses it differently (hover-card.css).
 */
export type HoverContent = {
  title: string;
  kicker?: string;
  rows: readonly (readonly [string, string])[];
  /** Which --theme-signal-N colours the card's mark. */
  series?: number;
};

const DELAY = 250, GROW = .32, SHRINK = .15, STIFFNESS = 190, DAMPING = 24, STRETCH = .16;
const OFFSET_X = 16, OFFSET_Y = 18;

let card: HTMLElement | undefined;
let owner: HTMLElement | undefined;
let content: ((el: HTMLElement) => HoverContent | null) | undefined;
let pointer = { x: 0, y: 0 };
let position = { x: 0, y: 0 }, velocity = { x: 0, y: 0 };
let shownAt = 0, hiddenAt = 0, visible = false, frame = 0, last = 0, refresh = 0, pending = 0;
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
  card.innerHTML = '<i class="rhine-hover-mark" aria-hidden="true"></i><small></small><strong></strong><dl></dl>';
  document.body.append(card);
  return card;
}

function fill(value: HoverContent) {
  const c = element();
  c.querySelector("small")!.textContent = value.kicker ?? "";
  c.querySelector("strong")!.textContent = value.title;
  const list = c.querySelector("dl")!;
  // Rows are reused so a card that refreshes every half second never relays out its text nodes.
  while (list.children.length > value.rows.length * 2) list.lastElementChild!.remove();
  value.rows.forEach(([label, text], i) => {
    let dt = list.children[i * 2] as HTMLElement | undefined, dd = list.children[i * 2 + 1] as HTMLElement | undefined;
    if (!dt) { dt = document.createElement("dt"); list.append(dt); }
    if (!dd) { dd = document.createElement("dd"); list.append(dd); }
    if (dt.textContent !== label) dt.textContent = label;
    if (dd.textContent !== text) dd.textContent = text;
  });
  c.style.setProperty("--card-series", `var(--theme-signal-${(value.series ?? 0) % 5}, var(--theme-accent))`);
}

/** Where the card wants to be: beside the pointer, turned inward at the viewport's edges. */
function target(c: HTMLElement) {
  const w = c.offsetWidth, h = c.offsetHeight;
  const flipX = pointer.x + OFFSET_X + w > innerWidth - 8, flipY = pointer.y + OFFSET_Y + h > innerHeight - 8;
  c.dataset.flip = `${flipX ? "x" : ""}${flipY ? "y" : ""}`;
  return {
    x: Math.max(8, flipX ? pointer.x - OFFSET_X - w : pointer.x + OFFSET_X),
    y: Math.max(8, flipY ? pointer.y - OFFSET_Y - h : pointer.y + OFFSET_Y),
    ox: flipX ? w + OFFSET_X : -OFFSET_X,
    oy: flipY ? h + OFFSET_Y : -OFFSET_Y,
  };
}

const easeOutBack = (x: number) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2; };

function tick(now: number) {
  frame = 0;
  const c = element();
  const dt = Math.min(.05, last ? (now - last) / 1000 : 1 / 60);
  last = now;
  const goal = target(c);
  const still = reduced();
  if (still) { position = { x: goal.x, y: goal.y }; velocity = { x: 0, y: 0 }; }
  else {
    // Semi-implicit spring, sub-stepped so a slow frame cannot overshoot wildly.
    for (let step = 0, n = Math.ceil(dt / (1 / 120)); step < n; step++) {
      const h = dt / n;
      velocity.x += (STIFFNESS * (goal.x - position.x) - DAMPING * velocity.x) * h;
      velocity.y += (STIFFNESS * (goal.y - position.y) - DAMPING * velocity.y) * h;
      position.x += velocity.x * h; position.y += velocity.y * h;
    }
  }
  const age = (now - (visible ? shownAt : hiddenAt)) / 1000;
  const scale = still ? (visible ? 1 : 0) : visible ? easeOutBack(Math.min(1, age / GROW)) : 1 - Math.min(1, age / SHRINK) ** 2;
  // The drop: longer along the travel, narrower across it.
  const speed = Math.hypot(velocity.x, velocity.y);
  const s = still ? 0 : Math.min(STRETCH, speed / 4000);
  const cos = speed > 1 ? velocity.x / speed : 1, sin = speed > 1 ? velocity.y / speed : 0;
  const along = scale * (1 + s), across = scale * (1 - s * .6);
  const a = along * cos * cos + across * sin * sin, b = (along - across) * cos * sin, d = along * sin * sin + across * cos * cos;
  c.style.transformOrigin = `${goal.ox}px ${goal.oy}px`;
  c.style.transform = `translate3d(${position.x.toFixed(1)}px, ${position.y.toFixed(1)}px, 0) matrix(${a.toFixed(4)}, ${b.toFixed(4)}, ${b.toFixed(4)}, ${d.toFixed(4)}, 0, 0)`;
  if (!visible && scale <= 0) { c.hidden = true; last = 0; return; }
  if (visible && owner && content && now - refresh > 500) {
    refresh = now;
    const value = owner.isConnected ? content(owner) : null;
    if (value) fill(value); else hide();
  }
  frame = requestAnimationFrame(tick);
}

function show(el: HTMLElement, read: (el: HTMLElement) => HoverContent | null) {
  const value = read(el);
  if (!value) return;
  const c = element();
  owner = el; content = read;
  fill(value);
  refresh = performance.now();
  c.dataset.motif = motifOf(document.documentElement.dataset.colorPalette);
  if (!visible) {
    const wasHidden = c.hidden;
    visible = true; shownAt = performance.now();
    c.hidden = false;
    if (wasHidden) {
      const goal = target(c);
      position = { x: goal.x, y: goal.y }; velocity = { x: 0, y: 0 };
    }
    onShow?.();
  }
  if (!frame) frame = requestAnimationFrame(tick);
}

export function hide() {
  window.clearTimeout(pending); pending = 0;
  owner = undefined; content = undefined;
  if (!visible) return;
  visible = false; hiddenAt = performance.now();
  if (!frame) frame = requestAnimationFrame(tick);
}

/**
 * Cards for every `selector` match inside `root`. `read` is asked again every
 * half second while the card is up, so live values stay live.
 */
export function bindHoverCards(root: HTMLElement, selector: string, read: (el: HTMLElement) => HoverContent | null, signal?: AbortSignal) {
  root.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    pointer = { x: e.clientX, y: e.clientY };
    const el = (e.target as Element).closest<HTMLElement>(selector);
    if (!el || !root.contains(el) || e.buttons) { if (owner && root.contains(owner)) hide(); return; }
    if (el === owner) return;
    window.clearTimeout(pending);
    // Once a card is up it follows straight to the next item.
    if (visible) show(el, read);
    else pending = window.setTimeout(() => { pending = 0; if (el.matches(":hover")) show(el, read); }, DELAY);
  }, { signal });
  root.addEventListener("pointerleave", () => { if (!owner || root.contains(owner)) hide(); }, { signal });
  root.addEventListener("pointerdown", () => hide(), { signal });
  root.addEventListener("wheel", () => hide(), { signal, passive: true });
}
