import type { SshSessionBank, WorkspaceSession } from "./session-bank";
import type { ArchiveShortcut } from "./workspace-store";
import { SurfaceScope } from "./surface";
import { SurfaceTransition } from "../ui-transitions";
import "./utility-panels.css";

export class TunnelPanel {
  private root = document.createElement("section");
  private scope: SurfaceScope;
  private transition: SurfaceTransition;
  private off: () => void;
  constructor(
    private bank: SshSessionBank,
    private reduced: () => boolean,
    private notify: (text: string) => void,
  ) {
    this.root.className = "ssh-utility-surface ssh-tunnel-panel";
    this.root.hidden = true;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-label", "端口转发");
    this.root.innerHTML = `<header><div><small>LOCAL PORT FORWARDING</small><strong>端口转发</strong></div><button type="button">返回</button></header><p>本地地址仅在这台设备可用，SSH 连接结束时自动关闭。可在快捷档案中新建转发入口。</p><div class="ssh-tunnel-list"></div>`;
    const stage = document.querySelector<HTMLElement>("#stage")!;
    this.scope = new SurfaceScope(stage, this.root, stage.parentElement!);
    this.transition = new SurfaceTransition(this.root, undefined, 250, 180);
    this.root
      .querySelector("header button")!
      .addEventListener("click", () => this.close());
    this.root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      }
    });
    this.off = bank.onChange((_session, event) => {
      if (
        this.scope.active &&
        (!event || event.event === "tunnel" || event.event === "stopped")
      )
        this.render();
    });
  }
  async start(session: WorkspaceSession, shortcut: ArchiveShortcut) {
    if (
      !shortcut.tunnel ||
      !window.rhineDesktop?.tunnels ||
      !session.client.active
    )
      return;
    const spec = shortcut.tunnel;
    const existing = session.services.state?.tunnels?.find(
      (t) =>
        t.state !== "closed" &&
        t.name === shortcut.name &&
        t.host === spec.host &&
        t.port === spec.port &&
        (!spec.localPort || t.localAddress.endsWith(":" + spec.localPort)),
    );
    if (existing) {
      this.notify(`转发已监听 ${existing.localAddress}`);
      return;
    }
    const result = await window.rhineDesktop.tunnels.start({
      sessionId: session.client.id,
      name: shortcut.name,
      host: spec.host,
      port: spec.port,
      localPort: spec.localPort,
    });
    this.notify(
      result.ok
        ? `转发已监听 ${result.result?.localAddress}`
        : result.error || "转发未能打开",
    );
    this.render();
  }
  open() {
    this.scope.enter();
    this.transition.show(this.reduced());
    this.render();
    this.root.querySelector<HTMLButtonElement>("button")!.focus();
  }
  private close() {
    this.transition.hide(this.reduced(), () => this.scope.leave());
  }
  private render() {
    const list = this.root.querySelector(".ssh-tunnel-list")!;
    list.replaceChildren();
    for (const session of this.bank.visibleSessions)
      for (const tunnel of session.services.state?.tunnels || []) {
        const row = document.createElement("article"),
          name = document.createElement("strong"),
          address = document.createElement("code"),
          state = document.createElement("p");
        name.textContent = `${tunnel.name} · ${session.client.displayTarget}`;
        address.textContent = `${tunnel.localAddress} → ${tunnel.host}:${tunnel.port}`;
        state.textContent =
          tunnel.state === "closed"
            ? "已关闭"
            : tunnel.error || `监听中 · ${tunnel.connections} 条 TCP 连接`;
        const copy = document.createElement("button");
        copy.type = "button";
        copy.textContent = "复制本地地址";
        copy.onclick = () => {
          void window.rhineDesktop?.clipboard?.writeText(tunnel.localAddress);
        };
        const stop = document.createElement("button");
        stop.type = "button";
        stop.textContent = "关闭转发";
        stop.disabled = tunnel.state === "closed";
        stop.onclick = () => {
          void window.rhineDesktop?.tunnels
            ?.stop({ sessionId: session.client.id, id: tunnel.id })
            .then((result) => {
              if (!result.ok) this.notify(result.error || "关闭失败");
            });
        };
        row.append(name, address, state, copy, stop);
        list.append(row);
      }
    if (!list.childElementCount)
      list.textContent = "当前没有转发，可创建一份端口转发档案。";
  }
  dispose() {
    this.off();
    this.scope.dispose();
    this.transition.dispose();
    this.root.remove();
  }
}
