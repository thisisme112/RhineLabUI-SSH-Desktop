/** One modal stack per stage, shared by the desktop surfaces. */
type Stack = {
  active: SurfaceScope[];
  scopes: Set<SurfaceScope>;
  baseline: Map<HTMLElement, boolean>;
  detach: () => void;
};
const stacks = new WeakMap<HTMLElement, Stack>();
const focusables =
  'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary,[tabindex="0"]';
const canFocus = (node: HTMLElement) =>
  node.isConnected &&
  !node.closest("[inert],[hidden]") &&
  node.getClientRects().length > 0;

function stackFor(host: HTMLElement): Stack {
  const existing = stacks.get(host);
  if (existing) return existing;
  const stack: Stack = {
    active: [],
    scopes: new Set(),
    baseline: new Map(),
    detach: () => {},
  };
  stacks.set(host, stack);
  const isolate = (event: Event) => {
    const top = stack.active.at(-1);
    if (!top) return;
    if (
      !(event.target instanceof Node) ||
      !top.element.contains(event.target)
    ) {
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
    } else if (event instanceof KeyboardEvent && event.key === "Tab") {
      if (event.ctrlKey) return;
      // Tab / Shift+Tab are terminal input (completion, TUI navigation).
      // The terminal has its own explicit close chord for leaving the screen.
      if (event.target instanceof Element && event.target.closest(".xterm"))
        return;
      const nodes = [
        ...top.element.querySelectorAll<HTMLElement>(focusables),
      ].filter(canFocus);
      const first = nodes[0],
        last = nodes.at(-1);
      if (!first) {
        event.preventDefault();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !nodes.includes(document.activeElement as HTMLElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };
  const events = [
    "keydown",
    "click",
    "pointerdown",
    "pointermove",
    "pointerup",
    "wheel",
  ];
  for (const event of events)
    host.ownerDocument.addEventListener(event, isolate, {
      capture: true,
      passive: false,
    });
  stack.detach = () => {
    for (const event of events)
      host.ownerDocument.removeEventListener(event, isolate, true);
    stacks.delete(host);
  };
  return stack;
}

export function hasSshSurface(host: HTMLElement) {
  return Boolean(stacks.get(host)?.active.length);
}

/** Android's back button must leave the top utility surface before the shell. */
export function backSshUtility(host: HTMLElement) {
  const top = stacks.get(host)?.active.at(-1)?.element;
  if (!top?.classList.contains("ssh-utility-surface")) return false;
  top.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  return true;
}

export class SurfaceScope {
  private stack: Stack;
  private previousFocus: HTMLElement | null = null;

  constructor(
    private host: HTMLElement,
    readonly element: HTMLElement,
    private mount: HTMLElement = host,
  ) {
    this.stack = stackFor(host);
    this.stack.scopes.add(this);
  }

  get active() {
    return this.stack.active.includes(this);
  }

  enter() {
    if (this.active) {
      this.stack.active.splice(this.stack.active.indexOf(this), 1);
      this.stack.active.push(this);
      this.sync();
      return;
    }
    this.previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (!this.stack.active.length) {
      this.stack.baseline.clear();
      const surfaces = new Set(
        [...this.stack.scopes].map((scope) => scope.element),
      );
      const background = [...this.host.children, ...(this.host.parentElement?.children ?? [])];
      for (const child of background)
        if (child instanceof HTMLElement && child !== this.host && !surfaces.has(child))
          this.stack.baseline.set(child, child.inert);
    }
    if (this.element.parentElement !== this.mount)
      this.mount.append(this.element);
    this.stack.active.push(this);
    this.sync();
  }

  /** An interrupted exit retains this scope; reopening never snapshots again. */
  leave() {
    const index = this.stack.active.indexOf(this);
    if (index < 0) return;
    const wasTop = this.stack.active.at(-1) === this;
    this.stack.active.splice(index, 1);
    this.sync();
    if (wasTop) {
      const top = this.stack.active.at(-1)?.element;
      if (
        this.previousFocus &&
        canFocus(this.previousFocus) &&
        (!top || top.contains(this.previousFocus))
      )
        this.previousFocus.focus({ preventScroll: true });
      else
        top
          ?.querySelector<HTMLElement>(focusables)
          ?.focus({ preventScroll: true });
    }
    this.previousFocus = null;
  }

  private sync() {
    const top = this.stack.active.at(-1);
    for (const [node, inert] of this.stack.baseline)
      if (node.isConnected) node.inert = top ? true : inert;
    for (const scope of this.stack.scopes) {
      const order = this.stack.active.indexOf(scope);
      scope.element.inert = order >= 0 && scope !== top;
      // A viewport-mounted terminal cannot sit above a decision surface in
      // the scaled stage's stacking context. Retain its DOM and buffer while
      // that surface owns focus; the model remains visible behind the prompt.
      scope.element.dataset.surfaceCovered = String(
        order >= 0 && scope !== top && scope.mount !== scope.host && top?.mount === scope.host,
      );
      scope.element.style.zIndex = order >= 0 ? String(30 + order) : "";
    }
    if (!top) this.stack.baseline.clear();
  }

  dispose() {
    this.leave();
    this.stack.scopes.delete(this);
    if (!this.stack.scopes.size) this.stack.detach();
  }
}
