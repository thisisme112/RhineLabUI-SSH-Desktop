import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import {
  StreamLanguage,
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { unifiedMergeView } from "@codemirror/merge";
import { SurfaceScope } from "./surface";
import { SurfaceTransition } from "../ui-transitions";
import { terminalAppearance, TERMINAL_FONTS } from "./terminal-appearance";
import type { RemoteTextDocument, SshServicesClient } from "./services";
import "./utility-panels.css";

type Draft = { original: RemoteTextDocument; text: string; owner: string };
const language = (path: string): Extension =>
  /\.(json|jsonc)$/i.test(path)
    ? json()
    : /\.(js|jsx|mjs|cjs|ts|tsx)$/i.test(path)
      ? javascript({
          typescript: /\.tsx?$/.test(path),
          jsx: /\.[jt]sx$/.test(path),
        })
      : /\.py$/i.test(path)
        ? python()
        : /\.ya?ml$/i.test(path)
          ? StreamLanguage.define(yaml)
          : /\.(sh|bash|zsh)$|\/(\.bashrc|\.profile|\.zshrc)$/i.test(path)
            ? StreamLanguage.define(shell)
            : [];

export class RemoteTextEditor {
  private root = document.createElement("section");
  private scope: SurfaceScope;
  private transition: SurfaceTransition;
  private view?: EditorView;
  private diff = new Compartment();
  private drafts = new Map<string, Draft>();
  private draft?: Draft;
  private comparison?: RemoteTextDocument;
  private comparing = false;
  private busy = false;
  private revision = 0;
  private offAppearance: () => void;
  constructor(
    private services: SshServicesClient,
    private reduced: () => boolean,
  ) {
    this.root.className = "ssh-utility-surface ssh-text-editor";
    this.root.hidden = true;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-label", "远端文本编辑器");
    this.root.innerHTML = `<header><div><small>SFTP / TEXT EDITOR</small><strong class="ssh-editor-path"></strong></div><button type="button" data-editor="close">返回 · 保留草稿</button></header><nav><button type="button" data-editor="save">保存 · Ctrl+S</button><button type="button" data-editor="diff">比较修改</button><button type="button" data-editor="remote">读取远端对照</button><button type="button" data-editor="use-remote" hidden>采用远端内容</button><button type="button" data-editor="reviewed" hidden>已核对 · 以本地内容保存</button></nav><p class="ssh-editor-status" role="status"></p><div class="ssh-code-editor"></div><footer>UTF-8 · 最大 1 MiB · 草稿仅保留到应用关闭</footer>`;
    this.root.querySelector("footer")!.textContent =
      "UTF-8 · 最大 1 MiB · 草稿保留到移出会话或关闭应用";
    const stage = document.querySelector<HTMLElement>("#stage")!;
    this.scope = new SurfaceScope(stage, this.root, stage.parentElement!);
    this.transition = new SurfaceTransition(this.root, undefined, 250, 180);
    this.root.addEventListener("click", (event) => {
      const action = (event.target as Element).closest<HTMLElement>(
        "[data-editor]",
      )?.dataset.editor;
      // Never gated on `busy`: a write that never settles would otherwise trap
      // the reader in the editor with no way out.
      if (action === "close") this.close();
      if (action === "save") void this.save();
      if (action === "remote") void this.readRemote();
      if (action === "diff") {
        this.comparing = !this.comparing;
        this.showDiff();
      }
      if (
        action === "use-remote" &&
        this.comparison &&
        this.draft &&
        !this.busy
      ) {
        this.draft.original = this.comparison;
        this.draft.text = this.comparison.text;
        this.comparison = undefined;
        this.createView();
        this.status("已采用远端版本");
      }
      if (
        action === "reviewed" &&
        this.comparison &&
        this.draft &&
        !this.busy
      ) {
        this.draft.original = this.comparison;
        this.comparison = undefined;
        this.showDiff();
        void this.save();
      }
    });
    this.root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        // Same rule as the 返回 button: a write that never settles must not
        // trap the reader in the editor with no way out.
        this.close();
      }
    });
    this.offAppearance = terminalAppearance.onChange(() => this.appearance());
  }
  async open(path: string) {
    if (this.busy) return;
    this.keepDraft();
    if (!this.drafts.has(path) && this.drafts.size >= 32) {
      this.scope.enter();
      this.transition.show(this.reduced());
      this.status(
        "已有 32 份未保存草稿，请先保存或采用远端版本，再打开更多文件。",
      );
      return;
    }
    const owner = this.services.state?.sessionId;
    if (!owner || !this.services.files) return;
    const revision = ++this.revision;
    this.busy = true;
    this.draft = undefined;
    this.comparison = undefined;
    this.view?.destroy();
    this.view = undefined;
    this.root.querySelector(".ssh-editor-path")!.textContent = path;
    this.scope.enter();
    this.transition.show(this.reduced());
    this.status("正在读取远端文件…");
    try {
      const result = await this.services.files.readText({
        sessionId: owner,
        path,
      });
      if (revision !== this.revision) return;
      if (owner !== this.services.state?.sessionId)
        throw new Error("连接已变化，请重新打开文件");
      if (!result.ok || !result.result)
        throw new Error(result.error || "读取失败");
      const old = this.drafts.get(path);
      this.draft =
        old && old.text !== old.original.text
          ? { ...old, owner }
          : { original: result.result, text: result.result.text, owner };
      if (this.draft.original.revision !== result.result.revision) {
        this.comparison = result.result;
        this.comparing = true;
      }
      this.createView();
      this.status(
        this.comparison
          ? "远端内容已变化。上方删除色是远端版本，下方新增色是本地草稿；核对后再保存。"
          : old && old.text !== old.original.text
            ? "已恢复本地草稿"
            : "文件已读取",
      );
    } catch (error) {
      this.status(String(error));
    } finally {
      this.busy = false;
      this.controls();
    }
  }
  private appearance() {
    const a = terminalAppearance.value;
    this.root.style.setProperty(
      "--ssh-editor-font",
      TERMINAL_FONTS[a.font].family,
    );
    this.root.style.setProperty(
      "--ssh-editor-size",
      Math.max(11, a.size) + "px",
    );
    this.view?.requestMeasure();
  }
  private createView() {
    this.view?.destroy();
    if (!this.draft) return;
    const draft = this.draft;
    const separator = draft.original.text.includes("\r\n") ? "\r\n" : "\n";
    this.view = new EditorView({
      parent: this.root.querySelector(".ssh-code-editor")!,
      state: EditorState.create({
        doc: draft.text,
        extensions: [
          basicSetup,
          language(draft.original.path),
          EditorState.lineSeparator.of(separator),
          syntaxHighlighting(
            HighlightStyle.define([
              {
                tag: [tags.keyword, tags.bool, tags.null],
                color: "var(--theme-accent, #986c3e)",
              },
              {
                tag: [tags.string, tags.regexp],
                color: "var(--theme-cyan, #477680)",
              },
              {
                tag: [tags.number, tags.typeName, tags.propertyName],
                color: "var(--theme-cyan, #477680)",
              },
              {
                tag: [tags.comment, tags.meta],
                color: "var(--theme-muted, #6d787b)",
                fontStyle: "italic",
              },
            ]),
          ),
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                void this.save();
                return true;
              },
            },
          ]),
          this.diff.of([]),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              draft.text = update.state.sliceDoc();
              this.status("有未保存的修改");
            }
          }),
          EditorView.theme({
            "&": {
              height: "100%",
              fontSize: "var(--ssh-editor-size)",
              backgroundColor: "transparent",
            },
            ".cm-scroller": {
              overflow: "auto",
              fontFamily: "var(--ssh-editor-font)",
              lineHeight: "1.4",
            },
            ".cm-gutters": {
              backgroundColor: "transparent",
              color: "inherit",
              borderRight: "1px solid #80808040",
            },
            ".cm-content": { caretColor: "currentColor" },
            ".cm-activeLine": { backgroundColor: "#80808010" },
            ".cm-activeLineGutter": { backgroundColor: "#80808020" },
          }),
        ],
      }),
    });
    this.appearance();
    this.showDiff();
    this.view.focus();
  }
  private showDiff() {
    this.view?.dispatch({
      effects: this.diff.reconfigure(
        this.comparing && this.draft
          ? unifiedMergeView({
              original: this.comparison?.text ?? this.draft.original.text,
              mergeControls: false,
              highlightChanges: true,
              syntaxHighlightDeletions: true,
            })
          : [],
      ),
    });
    this.controls();
  }
  private controls() {
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(
      "[data-editor]",
    )) {
      const action = button.dataset.editor;
      // `close` stays enabled: a read or write that never settles must not
      // seal the reader in with no way out.
      button.disabled = action !== "close" && (this.busy || !this.draft);
      if (action === "reviewed" || action === "use-remote")
        button.hidden = !this.comparison;
      if (action === "save") button.disabled ||= !!this.comparison;
      if (action === "diff")
        button.setAttribute("aria-pressed", String(this.comparing));
    }
  }
  /**
   * Reads the file back after a failed write.
   *
   * The one thing the reader needs to know is whether their text is on the
   * server, and the reply cannot answer that once it has failed: a dropped or
   * timed-out response looks exactly like a rejected write. The file can.
   */
  private async settleFailedSave(
    submitted: string,
    draft: Draft,
    failure: string,
  ) {
    const owner = this.services.state?.sessionId;
    if (!owner || owner !== draft.owner || !this.services.files) {
      this.status(`保存失败 · ${failure}`, "failed");
      return;
    }
    try {
      const read = await this.services.files.readText({
        sessionId: owner,
        path: draft.original.path,
      });
      if (read.ok && read.result?.text === submitted) {
        draft.original = read.result;
        this.keepDraft();
        this.showDiff();
        this.status("保存成功 · 远端内容与本次提交一致（写入已生效）", "saved");
        return;
      }
      this.status(
        read.ok
          ? `保存失败 · 远端内容与本次提交不一致，改动仍在本地草稿`
          : `保存失败 · ${failure}`,
        "failed",
      );
    } catch {
      this.status(`保存失败 · ${failure}`, "failed");
    }
  }
  private status(text: string, state: "saved" | "failed" | "" = "") {
    const node = this.root.querySelector<HTMLElement>(".ssh-editor-status")!;
    node.textContent = text;
    if (state) node.dataset.state = state;
    else delete node.dataset.state;
    this.controls();
  }
  private keepDraft() {
    if (!this.draft) return;
    this.draft.text = this.view?.state.sliceDoc() ?? this.draft.text;
    if (this.draft.text === this.draft.original.text)
      this.drafts.delete(this.draft.original.path);
    else this.drafts.set(this.draft.original.path, this.draft);
  }
  private async readRemote() {
    if (!this.draft || this.busy || !this.services.files) return;
    const draft = this.draft;
    this.busy = true;
    this.controls();
    try {
      const owner = this.services.state?.sessionId;
      if (!owner) throw new Error("请先重新连接这台主机");
      const result = await this.services.files.readText({
        sessionId: owner,
        path: draft.original.path,
      });
      if (owner !== this.services.state?.sessionId)
        throw new Error("会话已变化，请重新读取");
      if (!result.ok || !result.result)
        throw new Error(result.error || "读取失败");
      draft.owner = owner;
      this.comparison = result.result;
      this.comparing = true;
      this.showDiff();
      this.status(
        "已读取远端版本供比较，本地草稿仍保留。核对后选择采用远端或保存本地内容。",
      );
    } catch (error) {
      this.status(String(error));
    } finally {
      this.busy = false;
      this.controls();
    }
  }
  private async save() {
    if (!this.draft || this.busy || this.comparison || !this.services.files)
      return;
    const draft = this.draft;
    if (draft.owner !== this.services.state?.sessionId) {
      this.status("连接已变化，请先读取远端对照；本地草稿仍保留");
      return;
    }
    this.keepDraft();
    this.busy = true;
    // A write over a slow channel can take a while, and a click that answers
    // with nothing looks exactly like a click that did nothing.
    this.status("正在写入远端…");
    this.controls();
    const submitted = draft.text;
    try {
      const result = await this.services.files.writeText({
        sessionId: draft.owner,
        path: draft.original.path,
        text: submitted,
        revision: draft.original.revision,
      });
      if (draft.owner !== this.services.state?.sessionId)
        throw new Error("连接已变化，保存结果需重新读取确认");
      if (!result.ok || !result.result)
        throw new Error(result.error || "保存失败");
      if (result.result.conflict) {
        this.comparison = result.result.document;
        this.comparing = true;
        this.showDiff();
        this.status(
          result.result.saved
            ? "本次内容已提交，但远端随后又有修改；请读取差异确认当前版本。"
            : "远端文件已修改，本次未覆盖新版本。请核对差异后再保存。",
        );
      } else {
        draft.original = result.result.document;
        this.keepDraft();
        this.showDiff();
        this.status(
          draft.text === submitted
            ? "保存成功 · 已写入远端"
            : "保存成功 · 提交的版本已写入，之后继续输入的内容尚未保存",
          "saved",
        );
      }
    } catch (error) {
      // A write reported as failed may still have landed — the reply is what
      // failed, not necessarily the write. The file itself is the only witness,
      // so read it back and compare before telling the reader their work is lost.
      await this.settleFailedSave(submitted, draft, String(error));
    } finally {
      this.busy = false;
      this.controls();
    }
  }
  close() {
    // Keeping the draft is best-effort; leaving is not. A view torn down
    // mid-comparison must not leave the reader stuck in the surface.
    try {
      this.keepDraft();
    } catch {
      /* The draft stays as it was. */
    }
    this.transition.hide(this.reduced(), () => this.scope.leave());
    // Left now rather than when the fade ends, so the deck behind this surface
    // takes input again from the first frame instead of 180 ms later. `leave`
    // is idempotent, so the transition's own call costs nothing.
    this.scope.leave();
  }
  dispose() {
    this.revision++;
    this.offAppearance();
    this.view?.destroy();
    this.transition.dispose();
    this.scope.dispose();
    this.root.remove();
  }
}
