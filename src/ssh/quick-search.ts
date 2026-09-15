import { SurfaceScope } from "./surface";
import { SurfaceTransition } from "../ui-transitions";
import type { SshHostCards } from "./host-cards";
import { hostLabel } from "./host-cards";
import type { SshSessionBank } from "./session-bank";
import "./utility-panels.css";

type Result = { title: string; detail: string; kind: string; open(): void };
export class SshQuickSearch {
  private root = document.createElement("section");
  private input: HTMLInputElement;
  private list: HTMLElement;
  private scope: SurfaceScope;
  private transition: SurfaceTransition;
  private abort = new AbortController();
  private results: Result[] = [];
  private index = 0;
  constructor(
    private cards: SshHostCards,
    private bank: SshSessionBank,
    private actions: {
      reduced(): boolean;
      host(alias: string): void;
      shortcut(id: string): void;
      session(key: string): void;
      bookmark(alias: string, path: string): void;
      command(id: string): void;
    },
  ) {
    this.root.className = "ssh-utility-surface ssh-quick-search";
    this.root.hidden = true;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-label", "全局检索");
    this.root.innerHTML = `<header><div><small>WORKSPACE SEARCH</small><strong>主机、档案、目录、命令与会话</strong></div><button type="button" data-search-close>返回</button></header><input type="search" aria-label="搜索工作区" placeholder="输入名称、地址、目录或命令…" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="ssh-search-results"><div id="ssh-search-results" role="listbox"></div><footer>↑ ↓ 选择 · Enter 打开 · Esc 返回 · Ctrl+Shift+K 检索</footer>`;
    this.input = this.root.querySelector("input")!;
    this.list = this.root.querySelector('[role="listbox"]')!;
    const stage = document.querySelector<HTMLElement>("#stage")!;
    this.scope = new SurfaceScope(stage, this.root, stage.parentElement!);
    this.transition = new SurfaceTransition(this.root, undefined, 250, 180);
    this.input.addEventListener("input", () => {
      this.index = 0;
      this.render();
    });
    this.root
      .querySelector("button")!
      .addEventListener("click", () => this.close());
    this.root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      }
      if (
        event.target === this.input &&
        ["ArrowUp", "ArrowDown", "Enter"].includes(event.key)
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Enter") this.choose(this.index);
        else {
          this.index = Math.max(
            0,
            Math.min(
              this.results.length - 1,
              this.index + (event.key === "ArrowUp" ? -1 : 1),
            ),
          );
          this.highlight();
        }
      }
    });
    this.list.addEventListener("click", (event) => {
      const index = (event.target as Element).closest<HTMLElement>(
        "[data-result]",
      )?.dataset.result;
      if (index !== undefined) this.choose(Number(index));
    });
    document.addEventListener(
      "keydown",
      (event) => {
        if (
          event.ctrlKey &&
          event.shiftKey &&
          !event.altKey &&
          event.key.toLowerCase() === "k"
        ) {
          event.preventDefault();
          event.stopPropagation();
          this.open();
        }
      },
      { signal: this.abort.signal },
    );
  }
  open() {
    this.scope.enter();
    this.transition.show(this.actions.reduced());
    this.render();
    this.input.focus();
    this.input.select();
  }
  private close(done?: () => void) {
    this.transition.hide(this.actions.reduced(), () => {
      this.scope.leave();
      done?.();
    });
  }
  private choose(index: number) {
    const result = this.results[index];
    if (result) this.close(() => result.open());
  }
  private render() {
    const all: Result[] = [
      ...this.bank.visibleSessions.map((s) => ({
        kind: "会话",
        title:
          s.project?.name ||
          s.client.displayTarget ||
          s.descriptor?.target ||
          "SSH",
        detail: s.recovery || s.client.status().label,
        open: () => this.actions.session(s.key),
      })),
      ...this.cards.bound.map((h) => ({
        kind: "主机",
        title: hostLabel(h),
        detail: `${h.user}@${h.hostname}:${h.port}`,
        open: () => this.actions.host(h.alias),
      })),
      ...this.cards.store!.shortcuts.map((s) => ({
        kind: s.group || "档案",
        title: s.name,
        detail: [s.path, s.tmux, s.note].filter(Boolean).join(" · "),
        open: () => this.actions.shortcut(s.id),
      })),
      ...this.cards.store!.bookmarks.map((b) => ({
        kind: "目录",
        title: b.name,
        detail: b.path,
        open: () => this.actions.bookmark(b.alias, b.path),
      })),
      ...this.cards.store!.commands.map((c) => ({
        kind: "命令",
        title: c.name,
        detail: c.command,
        open: () => this.actions.command(c.id),
      })),
    ];
    const words = this.input.value
      .trim()
      .toLocaleLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    this.results = all
      .filter((row) =>
        words.every((word) =>
          `${row.kind} ${row.title} ${row.detail}`
            .toLocaleLowerCase()
            .includes(word),
        ),
      )
      .slice(0, 80);
    this.list.replaceChildren();
    this.results.forEach((result, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.dataset.result = String(index);
      row.id = `ssh-search-result-${index}`;
      row.setAttribute("role", "option");
      const tag = document.createElement("small"),
        title = document.createElement("strong"),
        detail = document.createElement("span");
      tag.textContent = result.kind;
      title.textContent = result.title;
      detail.textContent = result.detail.slice(0, 300);
      row.append(tag, title, detail);
      this.list.append(row);
    });
    if (!this.results.length) this.list.textContent = "没有匹配结果";
    this.highlight();
  }
  private highlight() {
    this.list
      .querySelectorAll<HTMLElement>("[data-result]")
      .forEach((row, i) =>
        row.setAttribute("aria-selected", String(i === this.index)),
      );
    const selected = this.list.children[this.index] as HTMLElement | undefined;
    if (selected) {
      this.input.setAttribute("aria-activedescendant", selected.id);
      selected.scrollIntoView({ block: "nearest" });
    } else this.input.removeAttribute("aria-activedescendant");
  }
  dispose() {
    this.abort.abort();
    this.scope.dispose();
    this.transition.dispose();
    this.root.remove();
  }
}
