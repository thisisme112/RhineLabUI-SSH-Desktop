import { escapeHtml as esc } from "../html";
import { SshPageMotion } from "./page-motion";
import type { SshKeyEntry } from "./client";

/** Public key metadata is the only stored material exposed back to the UI. */
export class SshKeysPanel {
  private root = document.createElement("section");
  private generation = 0;
  private armed = "";
  private motion = new SshPageMotion();
  constructor(private reduced: () => boolean) {
    this.root.className = "ssh-key-library";
    this.root.innerHTML = `<div class="ssh-catalog-heading"><div><span>IDENTITY LIBRARY</span><h2>登录密钥</h2></div><button type="button" data-key-action="file">选择本机私钥 ↗</button></div>
      <p class="ssh-catalog-note">引用本机文件，或加密保存导入的私钥。多个主机可以使用同一份密钥。</p><div class="ssh-key-list"></div>
      <details class="ssh-key-import"><summary>粘贴导入私钥 ＋</summary><form autocomplete="off"><label>密钥名称<input name="name" maxlength="80" required placeholder="例如：开发环境身份"></label><label>OpenSSH / PEM 私钥<textarea name="content" rows="5" required spellcheck="false" autocomplete="off" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea></label><label>解锁口令（仅用于检查，可在连接时选择记住）<input name="passphrase" type="password" autocomplete="new-password"></label><button type="submit">加密保存密钥 ↗</button></form></details>
      <p class="ssh-key-feedback" role="status"></p>`;
    this.root.addEventListener("click", (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>(
        "[data-key-action]",
      );
      if (!button) return;
      event.stopPropagation();
      if (button.dataset.keyAction === "file") void this.pickFile();
      else if (button.dataset.keyAction === "remove")
        void this.remove(button.dataset.id!);
    });
    this.root.querySelector("form")!.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.importKey();
    });
    this.root
      .querySelector("details")!
      .addEventListener("toggle", () =>
        this.motion.reveal(this.root.querySelector("form")!, this.reduced()),
      );
  }
  mount(container: HTMLElement) {
    container.append(this.root);
    void this.refresh();
    this.motion.reveal(this.root, this.reduced());
  }
  unmount() {
    this.generation++;
    this.armed = "";
    this.root.querySelector("form")!.reset();
    this.root.remove();
    this.motion.cancel();
  }
  private feedback(message: string) {
    this.root.querySelector(".ssh-key-feedback")!.textContent = message;
  }
  private async refresh() {
    const generation = this.generation;
    const result = await window.rhineDesktop?.keys?.list().catch(() => null);
    if (generation !== this.generation) return;
    if (!result?.ok) {
      this.feedback(result?.error || "密钥库尚未就绪");
      return;
    }
    this.render(result.keys);
  }
  private render(keys: SshKeyEntry[]) {
    this.root.querySelector(".ssh-key-list")!.innerHTML = keys.length
      ? keys
          .map(
            (key) =>
              `<article class="ssh-key-row"><div><strong>${esc(key.name)}</strong><small>${esc(key.type)} · ${key.source === "file" ? "本机文件" : "加密导入"} · ${key.protected ? "有口令" : "无口令"}${key.missing ? " · 文件缺失" : ""}</small><code>${esc(key.fingerprint || "解锁后可检查公钥指纹")}</code><small>${esc(key.file || "当前系统账户加密保存")}</small>${key.hosts?.length ? `<small>用于：${esc(key.hosts.join("、"))}</small>` : ""}</div><button type="button" data-key-action="remove" data-id="${esc(key.id)}">移除</button></article>`,
          )
          .join("")
      : '<p class="ssh-catalog-empty">尚未添加登录密钥。</p>';
  }
  private async pickFile() {
    const generation = this.generation;
    try {
      const picked = await window.rhineDesktop?.hostProfiles?.pickIdentity();
      if (generation !== this.generation || !picked?.ok || !picked.file) return;
      const result = await window.rhineDesktop?.keys?.add({
        source: "file",
        file: picked.file,
      });
      if (generation !== this.generation) return;
      this.feedback(
        result?.ok
          ? "密钥已添加，可在主机配置中选择。"
          : result?.error || "密钥添加失败",
      );
      if (result?.ok) await this.refresh();
    } catch (error) {
      if (generation === this.generation)
        this.feedback(error instanceof Error ? error.message : "密钥添加失败");
    }
  }
  private async importKey() {
    const generation = this.generation,
      form = this.root.querySelector("form")!;
    if (!form.reportValidity()) return;
    const field = (name: string) =>
      form.elements.namedItem(name) as HTMLInputElement;
    const button = form.querySelector("button")!;
    button.disabled = true;
    try {
      const result = await window.rhineDesktop?.keys?.add({
        source: "import",
        name: field("name").value,
        content: field("content").value,
        passphrase: field("passphrase").value,
      });
      if (generation !== this.generation) return;
      this.feedback(
        result?.ok
          ? "私钥已加密保存，可在主机配置中选择。"
          : result?.error || "私钥未能保存",
      );
      if (result?.ok) {
        form.reset();
        this.root.querySelector("details")!.open = false;
        await this.refresh();
      }
    } catch (error) {
      if (generation === this.generation)
        this.feedback(error instanceof Error ? error.message : "私钥未能保存");
    } finally {
      button.disabled = false;
    }
  }
  private async remove(id: string) {
    if (this.armed !== id) {
      this.armed = id;
      this.feedback("再次点击移除，删除此密钥库条目；本机引用的原文件会保留。");
      return;
    }
    const generation = this.generation;
    const result = await window.rhineDesktop?.keys
      ?.remove(id)
      .catch(() => null);
    this.armed = "";
    if (generation !== this.generation) return;
    this.feedback(
      result?.ok ? "密钥已移除。" : result?.error || "密钥未能移除",
    );
    if (result?.ok) await this.refresh();
  }
}
