const enterEase = "cubic-bezier(0.22, 1, 0.36, 1)";

/** The archive's short, staggered reveals. Never owns or replaces input nodes. */
export class SshPageMotion {
  private animations: Animation[] = [];
  private root?: HTMLElement;
  private revision = 0;

  reveal(root: HTMLElement, reduced: boolean) {
    const interrupted = new Map<Element, { opacity: string; transform: string }>();
    for (const animation of this.animations) {
      const node = (animation.effect as KeyframeEffect | null)?.target;
      if (node instanceof HTMLElement && root.contains(node)) {
        const style = getComputedStyle(node);
        interrupted.set(node, { opacity: style.opacity, transform: style.transform });
      }
    }
    this.cancel();
    this.root = root;
    root.dataset.motion = reduced ? "settled" : "entering";
    root.dataset.motionCount = String((Number(root.dataset.motionCount) || 0) + 1);
    if (reduced) return;
    const revision = this.revision;
    const marked = [...root.querySelectorAll<HTMLElement>("[data-ssh-reveal]")];
    const nodes = (marked.length ? marked : [...root.children] as HTMLElement[])
      .filter(node => !node.closest("[hidden]") && node.getClientRects().length > 0)
      .slice(0, 20);
    this.animations = nodes.map((node, index) => {
      const rule = node.classList.contains("detail-rule");
      return node.animate([
        interrupted.get(node) ?? { opacity: .15, transform: rule ? "scaleX(.08)" : "translateY(14px)" },
        { opacity: 1, transform: rule ? "scaleX(1)" : "translateY(0)" },
      ], { duration: rule ? 460 : 360, delay: Math.min(index * 28, 168), easing: enterEase, fill: "both" });
    });
    void Promise.allSettled(this.animations.map(animation => animation.finished)).then(() => {
      if (revision === this.revision) this.cancel();
    });
  }

  finish() { this.cancel(); }

  cancel() {
    this.revision++;
    for (const animation of this.animations) animation.cancel();
    this.animations = [];
    if (this.root) this.root.dataset.motion = "settled";
    this.root = undefined;
  }
}
