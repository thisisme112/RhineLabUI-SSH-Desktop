export type SessionTab = { key: string; label: string; state: string; unread?: boolean; alert?: string; transfers?: number };

/** Stable nodes preserve focus while traffic and authentication update tab state. */
export class SessionTabs {
  readonly root = document.createElement("div");
  private nodes = new Map<string, HTMLElement>();
  private change: (key: string) => void = () => {};
  private close: (key: string) => void = () => {};
  constructor() {
    this.root.className = "ssh-session-tabs";
    this.root.setAttribute("role", "tablist");
    this.root.setAttribute("aria-label", "SSH 会话");
    this.root.addEventListener("click", (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>(
        "button",
      );
      if (!button) return;
      event.stopPropagation();
      const key =
        button.closest<HTMLElement>("[data-session-key]")!.dataset.sessionKey!;
      if (button.dataset.sessionClose) this.close(key);
      else this.change(key);
    });
    this.root.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
        return;
      event.preventDefault();
      event.stopPropagation();
      const tabs = [
        ...this.root.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
      ];
      const currentTab = document.activeElement
        ?.closest("[data-session-key]")
        ?.querySelector<HTMLButtonElement>('[role="tab"]');
      const current = tabs.indexOf(currentTab!);
      const index =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
              tabs.length;
      const target = tabs[index];
      if (!target) return;
      const key =
        target.closest<HTMLElement>("[data-session-key]")!.dataset.sessionKey!;
      const surface = this.root.closest(".ssh-terminal")
        ? ".ssh-terminal"
        : ".ssh-overview";
      target.click();
      // Switching remounts a different terminal panel. Keep keyboard focus on
      // its corresponding tab so a second arrow does not go to the shell.
      requestAnimationFrame(() => {
        const selected = document.querySelector<HTMLButtonElement>(
          `${surface} [data-session-key="${CSS.escape(key)}"] [role="tab"]`,
        );
        if (selected && !selected.closest("[hidden],[inert]"))
          selected.focus({ preventScroll: true });
      });
    });
  }
  update(
    items: SessionTab[],
    current: string,
    change: (key: string) => void,
    close: (key: string) => void,
  ) {
    this.change = change;
    this.close = close;
    const keys = new Set(items.map((item) => item.key));
    for (const [key, node] of this.nodes)
      if (!keys.has(key)) {
        node.remove();
        this.nodes.delete(key);
      }
    items.forEach((item, index) => {
      let node = this.nodes.get(item.key);
      if (!node) {
        node = document.createElement("div");
        node.className = "ssh-session-tab";
        node.dataset.sessionKey = item.key;
        node.innerHTML =
          '<button type="button" role="tab"><i aria-hidden="true"></i><span></span><small></small></button><button type="button" class="ssh-tab-close" data-session-close="true">×</button>';
        this.nodes.set(item.key, node);
      }
      const tab = node.querySelector<HTMLButtonElement>('[role="tab"]')!,
        selected = item.key === current;
      const changed = tab.getAttribute("aria-selected") !== String(selected);
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      tab.title = [item.label, item.state, item.unread ? "有未读输出" : "", item.alert, item.transfers ? `${item.transfers} 项传输` : ""].filter(Boolean).join(" · ");
      node.dataset.unread = String(!!item.unread);
      node.dataset.alert = String(!!item.alert);
      node.dataset.active = String(selected);
      node.dataset.pending = String(item.state.includes("认证"));
      for (const [selector, value] of [
        ["span", item.label],
        ["small", [item.alert ? "⚠" : "", item.unread ? "●" : "", item.state, item.transfers ? `⇅ ${item.transfers}` : ""].filter(Boolean).join(" ")],
      ]) {
        const part = tab.querySelector(selector)!;
        if (part.textContent !== value) part.textContent = value;
      }
      node
        .querySelector(".ssh-tab-close")!
        .setAttribute("aria-label", `结束并关闭 ${item.label}`);
      if (this.root.children[index] !== node)
        this.root.insertBefore(node, this.root.children[index] || null);
      if (selected && changed)
        requestAnimationFrame(() => {
          if (!node!.isConnected) return;
          const left = node!.offsetLeft,
            right = left + node!.offsetWidth;
          if (left < this.root.scrollLeft) this.root.scrollLeft = left;
          else if (right > this.root.scrollLeft + this.root.clientWidth)
            this.root.scrollLeft = right - this.root.clientWidth;
        });
    });
    this.root.hidden = items.length === 0;
  }
}
