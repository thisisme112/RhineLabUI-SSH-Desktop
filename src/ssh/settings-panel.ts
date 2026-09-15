import { SurfaceScope } from "./surface";
import { SurfaceTransition } from "../ui-transitions";
import { terminalAppearance, TERMINAL_FONTS } from "./terminal-appearance";
import { sshPreferences, type SshPreferences } from "./preferences";
import {
  createWorkspaceBackup,
  readWorkspaceBackup,
  importWorkspaceBackup,
  type WorkspaceBackup,
} from "./configuration";
import type { WorkspaceStore } from "./workspace-store";
import "./utility-panels.css";

export class SshSettingsPanel {
  private root = document.createElement("section");
  private scope: SurfaceScope;
  private transition: SurfaceTransition;
  private appearanceOff: () => void;
  private preferencesOff: () => void;
  private backup?: WorkspaceBackup;
  private ticket?: string;
  private busy = false;
  private disposed = false;
  private prepared = false;
  constructor(
    private store: WorkspaceStore,
    private actions: {
      reduced(): boolean;
      system(): void;
      tunnels(): void;
      imported(): Promise<unknown>;
      notify(message: string): void;
    },
  ) {
    this.root.className = "ssh-utility-surface ssh-workspace-settings";
    this.root.hidden = true;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-label", "SSH 工作区设置");
    this.root.innerHTML = `<header><div><small>WORKSPACE SETTINGS</small><strong>SSH 工作区设置</strong></div><button type="button" data-close>返回</button></header>
      <nav><button type="button" data-system>画面与声音</button><button type="button" data-tunnels>端口转发管理</button></nav>
      <div class="ssh-settings-scroll">
      <fieldset><legend>终端文字</legend><div class="ssh-settings-grid">
        <label>字体<select data-font></select></label><label>字号 / px<input data-size type="number" min="8" max="32" step="0.5"></label>
        <label>字距 / px<input data-spacing type="number" min="-1" max="3" step="0.1"></label><label>行距 / 倍<input data-line-height type="number" min="1" max="2" step="0.05"></label>
      </div><pre class="ssh-font-preview" aria-label="终端字体预览">user@rhine:~/project$ ls -la
0123456789  ABCDEFGH  abcdefgh
total 128  │ CPU 24% │ MEM 2.8G</pre><button type="button" data-font-reset>恢复终端文字默认值</button><p>所有会话同步生效。负字距会收紧字符，过小可能重叠。</p></fieldset>
      <fieldset><legend>连接与档案</legend><label class="ssh-setting-check"><input data-reconnect type="checkbox">意外断线后自动重连</label>
      <div class="ssh-settings-grid"><label>最多重试次数<input data-attempts type="number" min="1" max="20" step="1"></label><label>档案开启动画<select data-animation><option value="full">每次完整开盒</option><option value="first">首次完整，之后快速展开</option></select></label></div>
      <p>已连接过的会话才会恢复；认证失败、指纹变化或手动结束后停止重试。项目档案可填写 tmux 名称以重新接回远端工作。</p>
      <div data-background-row hidden><label class="ssh-setting-check"><input data-background type="checkbox">安卓后台保持连接</label><p data-background-status>显示持续通知，可返回终端或全部断开。系统强制停止或应用重载仍会结束连接。</p></div></fieldset>
      <fieldset><legend>持续状态提醒</legend><label class="ssh-setting-check"><input data-alerts type="checkbox">启用提醒</label><div class="ssh-settings-grid">
      <label>CPU / %<input data-cpu type="number" min="1" max="100"></label><label>磁盘 / %<input data-disk type="number" min="1" max="100"></label><label>GPU 温度 / °C<input data-gpu type="number" min="40" max="120"></label><label>持续秒数<input data-duration type="number" min="1" max="600"></label><label>断线提醒 / 秒<input data-disconnect type="number" min="1" max="300"></label></div><p>指标持续超过阈值后提醒一次，恢复后重新计时。需要远端支持相应监控指标。</p></fieldset>
      <fieldset><legend>电脑与手机配置迁移</legend><p>包含主机、项目与快捷档案、目录收藏、命令片段、字体和工作区设置。导入后手动打开连接。</p>
      <label class="ssh-setting-check"><input data-secrets type="checkbox">同时备份加密凭据与私钥</label>
      <label class="ssh-backup-password" hidden>备份密码<input data-export-password type="password" minlength="8" maxlength="1024" autocomplete="new-password" placeholder="至少 8 个字符，请自行保管"></label><button type="button" data-export>导出配置</button>
      <div class="ssh-settings-import"><label>选择配置文件<input data-file type="file" accept=".json,application/json"></label><label data-import-password-row hidden>备份密码<input data-import-password type="password" maxlength="1024" autocomplete="off"></label><p data-preview>选择文件后显示导入内容。</p><button type="button" data-preview-import disabled>检查导入</button><button type="button" data-import disabled>导入以上内容</button></div>
      </fieldset></div><p class="ssh-settings-message" role="status" aria-live="polite"></p>`;
    const stage = document.querySelector<HTMLElement>("#stage")!;
    this.scope = new SurfaceScope(stage, this.root, stage.parentElement!);
    this.transition = new SurfaceTransition(this.root, undefined, 250, 180);
    const font = this.input<HTMLSelectElement>("font");
    for (const [id, value] of Object.entries(TERMINAL_FONTS))
      font.add(new Option(value.name, id));
    for (const field of ["font", "size", "spacing", "line-height"])
      this.input(field).addEventListener("change", () => {
        const patch = {
          font: font.value as keyof typeof TERMINAL_FONTS,
          size: this.number("size"),
          spacing: this.number("spacing"),
          lineHeight: this.number("line-height"),
        };
        if (
          ![patch.size, patch.spacing, patch.lineHeight].every(Number.isFinite)
        ) {
          this.message("请填写有效的数字");
          this.syncAppearance();
          return;
        }
        terminalAppearance.update(patch);
        this.message(terminalAppearance.error || "终端文字已应用并保存");
      });
    this.input("font-reset").addEventListener("click", () => {
      terminalAppearance.reset();
      this.message(terminalAppearance.error || "已恢复默认文字设置");
    });
    this.appearanceOff = terminalAppearance.onChange(() =>
      this.syncAppearance(),
    );
    this.preferencesOff = sshPreferences.onChange(() => this.syncPreferences());
    for (const field of [
      "reconnect",
      "attempts",
      "animation",
      "alerts",
      "cpu",
      "disk",
      "gpu",
      "duration",
      "disconnect",
    ])
      this.input(field).addEventListener("change", () =>
        this.savePreferences(),
      );
    this.input("background-row").hidden = !window.rhineDesktop?.background;
    this.input<HTMLInputElement>("background").addEventListener(
      "change",
      () => {
        void this.setBackground();
      },
    );
    this.input("close").addEventListener("click", () => this.close());
    this.input("system").addEventListener("click", () =>
      this.close(this.actions.system),
    );
    this.input("tunnels").addEventListener("click", () =>
      this.close(this.actions.tunnels),
    );
    this.root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      }
    });
    this.input<HTMLInputElement>("secrets").addEventListener("change", () => {
      this.root.querySelector<HTMLElement>(".ssh-backup-password")!.hidden =
        !this.input<HTMLInputElement>("secrets").checked;
    });
    this.input("export").addEventListener("click", () => {
      void this.export();
    });
    this.input<HTMLInputElement>("file").addEventListener("change", () => {
      void this.readFile();
    });
    this.input("preview-import").addEventListener("click", () => {
      void this.previewImport();
    });
    this.input("import").addEventListener("click", () => {
      void this.import();
    });
    this.input("import-password").addEventListener("input", () => {
      this.prepared = false;
      void this.cancelTicket();
      this.input<HTMLButtonElement>("import").disabled = true;
    });
    this.syncAppearance();
    this.syncPreferences();
  }
  private input<T extends HTMLElement = HTMLInputElement>(key: string): T {
    return this.root.querySelector<T>(`[data-${key}]`)!;
  }
  private number(key: string) {
    return this.input<HTMLInputElement>(key).valueAsNumber;
  }
  private message(text: string) {
    this.root.querySelector(".ssh-settings-message")!.textContent = text;
  }
  private syncAppearance() {
    const value = terminalAppearance.value;
    this.input<HTMLSelectElement>("font").value = value.font;
    this.input("size").value = String(value.size);
    this.input("spacing").value = String(value.spacing);
    this.input("line-height").value = String(value.lineHeight);
    const preview = this.root.querySelector<HTMLElement>(".ssh-font-preview")!;
    Object.assign(preview.style, {
      fontFamily: TERMINAL_FONTS[value.font].family,
      fontSize: value.size + "px",
      letterSpacing: value.spacing + "px",
      lineHeight: String(value.lineHeight),
    });
  }
  private syncPreferences() {
    const value = sshPreferences.value;
    this.input("reconnect").checked = value.reconnect;
    this.input("attempts").value = String(value.reconnectAttempts);
    this.input<HTMLSelectElement>("animation").value = value.animation;
    this.input("background").checked = value.background;
    this.input("alerts").checked = value.alerts.enabled;
    for (const [field, key] of [
      ["cpu", "cpu"],
      ["disk", "disk"],
      ["gpu", "gpuTemperature"],
      ["duration", "duration"],
      ["disconnect", "disconnect"],
    ] as const)
      this.input(field).value = String(value.alerts[key]);
  }
  private savePreferences() {
    const value: SshPreferences = {
      ...sshPreferences.value,
      reconnect: this.input("reconnect").checked,
      reconnectAttempts: this.number("attempts"),
      animation: this.input<HTMLSelectElement>("animation")
        .value as SshPreferences["animation"],
      alerts: {
        enabled: this.input("alerts").checked,
        cpu: this.number("cpu"),
        disk: this.number("disk"),
        gpuTemperature: this.number("gpu"),
        duration: this.number("duration"),
        disconnect: this.number("disconnect"),
      },
    };
    if (!sshPreferences.save(value)) {
      this.message(sshPreferences.error || "请填写有效范围内的设置");
      this.syncPreferences();
    } else this.message("设置已保存");
  }
  private async setBackground() {
    const input = this.input("background");
    input.disabled = true;
    try {
      const result = await window.rhineDesktop!.background!.set(input.checked);
      sshPreferences.save({
        ...sshPreferences.value,
        background: result.enabled,
      });
      input.checked = result.enabled;
      this.input("background-status").textContent = result.enabled
        ? result.notificationGranted
          ? "后台连接已启用，通知提供返回和全部断开入口。"
          : "后台连接已启用；系统未允许普通通知，可在系统应用设置中开启通知。"
        : "后台连接服务已关闭。";
    } catch (error) {
      this.message(String(error));
      input.checked = sshPreferences.value.background;
    } finally {
      input.disabled = false;
    }
  }
  open() {
    this.scope.enter();
    this.transition.show(this.actions.reduced());
    this.syncAppearance();
    this.syncPreferences();
    this.input("close").focus();
    void window.rhineDesktop?.background
      ?.status()
      .then((status) => {
        if (
          !this.disposed &&
          status.enabled !== sshPreferences.value.background
        )
          sshPreferences.save({
            ...sshPreferences.value,
            background: status.enabled,
          });
      })
      .catch((error) => this.message(String(error)));
  }
  private close(done?: () => void) {
    if (this.busy) {
      this.message("正在处理配置，请等完成后返回");
      return;
    }
    this.prepared = false;
    this.input("export-password").value = "";
    this.input("import-password").value = "";
    this.input<HTMLButtonElement>("import").disabled = true;
    void this.cancelTicket();
    this.transition.hide(this.actions.reduced(), () => {
      this.scope.leave();
      done?.();
    });
  }
  private setBusy(value: boolean) {
    this.busy = value;
    for (const key of [
      "export",
      "file",
      "preview-import",
      "import",
      "export-password",
      "import-password",
      "secrets",
    ])
      this.input(key).disabled = value;
    if (!value) {
      this.input("preview-import").disabled = !this.backup;
      this.input("import").disabled =
        !this.prepared ||
        !this.backup ||
        (!!this.backup.encrypted && !this.ticket);
    }
  }
  private async export() {
    this.setBusy(true);
    this.message("正在生成配置备份…");
    try {
      const secret = this.input("secrets").checked,
        password = secret ? this.input("export-password").value : undefined;
      if (secret && (!password || password.length < 8))
        throw new Error("请填写至少 8 个字符的备份密码");
      const backup = await createWorkspaceBackup(this.store, password);
      const result = await window.rhineDesktop!.session!.export({
        suggestedName: `RhineLab-SSH-${new Date().toISOString().slice(0, 10)}.json`,
        text: JSON.stringify(backup, null, 2) + "\n",
      });
      if (!result.ok && !result.canceled)
        throw new Error(result.error || "配置导出失败");
      this.message(result.canceled ? "已取消导出" : "配置已导出");
      this.input("export-password").value = "";
    } catch (error) {
      this.message(error instanceof Error ? error.message : String(error));
    } finally {
      this.setBusy(false);
    }
  }
  private async cancelTicket() {
    const ticket = this.ticket;
    this.ticket = undefined;
    if (ticket) await window.rhineDesktop?.migration?.cancel(ticket);
  }
  private async readFile() {
    const file = this.input<HTMLInputElement>("file").files?.[0];
    if (!file) return;
    this.setBusy(true);
    this.backup = undefined;
    this.prepared = false;
    await this.cancelTicket();
    try {
      if (file.size > 16 * 1024 * 1024) throw new Error("配置文件超过 16 MiB");
      this.backup = readWorkspaceBackup(await file.text());
      this.input("import-password-row").hidden = !this.backup.encrypted;
      const { hosts, workspace, encrypted } = this.backup;
      this.input("preview").textContent =
        `${hosts.length} 台主机 · ${workspace.shortcuts.length} 份档案 · ${workspace.bookmarks.length} 个目录 · ${workspace.commands.length} 条命令${encrypted ? " · 含加密凭据" : " · 不含凭据"}\n${hosts
          .slice(0, 8)
          .map((h) => h.name)
          .join("、")}${hosts.length > 8 ? "…" : ""}`;
      this.message(
        "已读取文件，请检查导入内容。已有主机与档案会保留，冲突内容另存。",
      );
    } catch (error) {
      this.input("preview").textContent = "文件未通过格式检查";
      this.message(String(error));
    } finally {
      this.setBusy(false);
      this.input("import").disabled = true;
    }
  }
  private async previewImport() {
    if (!this.backup) return;
    this.setBusy(true);
    try {
      await this.cancelTicket();
      if (this.backup.encrypted) {
        const result = await window.rhineDesktop!.migration!.prepareCredentials(
          {
            password: this.input("import-password").value,
            encrypted: this.backup.encrypted,
          },
        );
        if (!result.ok || !result.result)
          throw new Error(result.error || "备份解密失败");
        this.ticket = result.result.ticket;
        this.message(
          `检查完成：包含 ${result.result.keys} 把私钥、${result.result.credentials} 项凭据。点击“导入以上内容”后写入本机。`,
        );
      } else
        this.message(
          "格式检查完成。点击“导入以上内容”后合并资料，并应用字体和工作区设置。",
        );
      this.prepared = true;
      this.input("import-password").value = "";
    } catch (error) {
      this.message(String(error));
    } finally {
      this.setBusy(false);
    }
  }
  private async import() {
    if (!this.backup || !this.prepared) return;
    this.setBusy(true);
    this.message("正在导入配置…");
    try {
      const result = await importWorkspaceBackup(
        this.backup,
        this.store,
        this.ticket,
      );
      this.message(result);
      await this.actions.imported();
      this.actions.notify("SSH 配置已导入");
    } catch (error) {
      this.message(error instanceof Error ? error.message : String(error));
      await this.actions.imported();
    } finally {
      this.ticket = undefined;
      this.prepared = false;
      this.input("import-password").value = "";
      this.setBusy(false);
      this.input("import").disabled = true;
    }
  }
  dispose() {
    this.disposed = true;
    void this.cancelTicket();
    this.appearanceOff();
    this.preferencesOff();
    this.scope.dispose();
    this.transition.dispose();
    this.root.remove();
  }
}
