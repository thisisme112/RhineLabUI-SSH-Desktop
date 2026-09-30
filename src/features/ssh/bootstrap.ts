import { getPlatformBridge } from "../../platform/bridge.ts";
import { isAndroid } from "../../platform/android/android";
import type { SshClient, SshLaunchDescriptor } from "./client";
import {
  records,
  categories,
  archiveColumns,
  columnFiles,
  fileLocation,
  archiveFiles,
  isActiveArchive,
} from "../archives/data";
import { hostLabel, hostSubtitle, SshHostCards } from "./host-cards";
import { wrap, type ArchiveNavigation } from "../archives/archive-loop";
import { ArchiveScene } from "../../rendering/scene";
import { ModelViewer } from "../../rendering/model-viewer";

type SshWorkspaceContext = typeof import("../../app/application").sshWorkspaceContext;

/** Wire SSH surfaces to the shell; getters keep navigation and session state live. */
export function initSshWorkspace(shell: SshWorkspaceContext) {

  shell.$("#stage").dataset.sshWorkspace = "true";
  void import("./session-bank").then(async ({ SshSessionBank }) => {
    if (isAndroid) await import("../../platform/android/ssh/bridge").then(module => module.initAndroidBridge());
    type WorkspaceSession = import("./session-bank").WorkspaceSession;
    const bank = new SshSessionBank(shell.$("#stage"), {
      close: session => { if (session === current) close(); },
      audit: session => { activateContext(session, false); openAudit(); },
      reconnect: session => { void reconnect(session); },
    });
    shell.sshBank = bank;
    void import("../../app/portals").then(({ SpatialPortals }) => {
      shell.portals = new SpatialPortals(shell.$("#stage"), {
        bank: () => shell.sshBank,
        reduced: () => shell.prefs.reduced,
        sound: cue => shell.audio.play(cue),
        openSession: session => { if (session.client.target) shell.openHostSession(session.client.target); },
        home: () => shell.started && shell.mode === "archive" && !shell.modal && !shell.viewer?.isOpen && !shell.playground?.active
          && !shell.sshSurfaceActive() && !shell.sshTerminalPending && (shell.sshOverview?.isCollapsed ?? true),
      });
    });
    let current = bank.active;
    let client = current.client;
    let services = current.services;
    let panel = current.panel;
    const { sshPreferences } = await import("./preferences");
    const openedArchives = new Set<string>();
    let openWorkspacePreferences = () => shell.openModal("settings");
    let openQuickSearch = () => {};
    let cancelRecovery = (_session: WorkspaceSession) => {};
    shell.sshClient = client;
    const { hasSshSurface, backSshUtility, SurfaceScope } = await import("./surface");
    shell.desktopModalScope = new SurfaceScope(shell.$("#stage"), shell.$("#modal-root"), shell.$("#viewport"));
    shell.$("#modal-root").classList.add("ssh-settings-root");
    shell.sshSurfaceActive = () => hasSshSurface(shell.$("#stage"));
    shell.sshSurfaceBack = () => backSshUtility(shell.$("#stage"));
    let terminalRequested = false;
    let terminalClosing = false;
    let interactiveGeneration = -1;
    let restoreTerminalFocus = false;
    shell.sshTerminal = panel;

    /** Closing the enlarged terminal returns to its host, retaining the session. */
    const close = (feedback = true, destination: "host" | "overview" | "inspect" | "stay" = "host") => {
      if (feedback && (terminalRequested || panel.isOpen)) shell.audio.play("ssh-collapse");
      current.view.entryGeneration = null;
      current.view.presentation = "returning";
      terminalRequested = false;
      shell.sshTerminalPending = false;
      terminalClosing = panel.isOpen || panel.isClosing;
      if (destination !== "inspect") {
        revealed = true;
        current.view.revealed = true;
      }
      const closing = current;
      const closingMode = shell.mode, closingCard = shell.selected;
      panel.hide(shell.prefs.reduced, () => {
        if (closing !== current) return;
        terminalClosing = false;
        if (destination === "inspect" || destination === "stay" || terminalRequested || shell.sshPromptOpen || shell.auditOpen) return;
        // A later navigation owns the page, even while this surface is still
        // fading out. Do not take it back or move focus after the user leaves.
        if (destination === "host" && (shell.mode !== closingMode || shell.selected !== closingCard)) return;
        if (destination === "overview") {
          shell.setMode("archive"); shell.sshOverview?.setVisible(true);
          shell.sshOverview?.focusHost(client.target);
        } else {
          const card = cards.cardOf(client.target ?? "");
          if (card !== undefined && (shell.mode !== "detail" || shell.selected !== card)) openHostCard(card);
          if (shell.mode === "detail") shell.patchHostState(shell.selected);
          // Wait for the camera and cover to return before focusing the
          // original controls; their DOM and scroll position stay intact.
          restoreTerminalFocus = false;
          restoreTerminalFocus = true;
        }
      });
    };
    shell.closeSshTerminal = close;
    shell.openSshTerminal = () => {
      if (shell.viewer?.isOpen && shell.viewer.root.dataset.kind === "terminal") { shell.viewer.enterPrimary(); return; }
      if (!client.target) {
        shell.notify("还没有进行中的会话，先在主机详情里连接");
        return;
      }
      if (terminalRequested && panel.isOpen && shell.mode === "detail" && shell.selected === sessionCard) { panel.focus(); return; }
      if (revealed && !terminalRequested) shell.audio.play("ssh-open");
      const selectedResource = cards.resourceAt(shell.selected);
      const anchorMatches = selectedResource?.sessionKey === current.key || selectedResource?.alias === client.target;
      const card = anchorMatches ? shell.selected : cards.cardOf(client.target) ?? cards.directoryCard;
      if (card !== undefined && shell.selected !== card) shell.select(card, undefined, true);
      if (card !== undefined && shell.mode !== "detail") shell.setMode("detail");
      sessionCard = card ?? shell.selected;
      current.view.sessionCard = sessionCard;
      current.view.entryGeneration = client.generation;
      current.view.presentation = "entering";
      terminalRequested = true;
      shell.pendingDetailFocus = false;
      restoreTerminalFocus = false;
      terminalClosing = false;
      shell.sshTerminalPending = !panel.isOpen;
      panel.setCloseLabel("收起 · 返回主机");
      if (panel.isClosing) panel.show(shell.prefs.reduced, panel.isProjected ? shell.scene?.projectSessionScreen() : null);
      if (panel.isOpen) panel.focus();
    };

    // ── blocking decision surfaces ─────────────────────────────────────────
    const { SshPromptPanel } = await import("./prompt");
    const { SshAuditPanel } = await import("./audit-panel");
    /**
     * Enter is CR on a Windows ConPTY: writing a bare LF echoes but never
     * submits the line, so ssh would sit on its question forever. CR is also
     * what a POSIX tty translates to a newline, so it is correct on both.
     */
    let lastConnection: SshLaunchDescriptor | null = null;
    let handledPrompt: string | null = null;
    let failureShown = false;

    const audit = new SshAuditPanel(
      shell.$("#stage"),
      () => void exportRecord(),
      () => closeAudit(),
    );
    const { SshPageMotion } = await import("./page-motion");
    shell.sshDetailMotion = new SshPageMotion();
    shell.sshTabMotion = new SshPageMotion();
    // The desktop catalog is registered before navigation is built.
    const cards = shell.hostCards!;
    const loadHosts = () => {
      if (shell.demoSsh) return Promise.resolve({ ok: true, hosts: [
        { alias: "demo-gateway", displayName: "演示网关", hostname: "gateway.demo.invalid", user: "demo", port: "22", source: "saved" as const },
        { alias: "demo-lab", displayName: "演示实验室", hostname: "lab.demo.invalid", user: "analyst", port: "2222", source: "saved" as const },
      ] });
      const bridge = getPlatformBridge();
      if (!bridge?.hosts) return Promise.resolve({ ok: false, hosts: [], error: "宿主未提供主机列表" });
      return bridge.hosts();
    };
    cards.onChange(() => {
      shell.sshOverview?.update();
      shell.syncColumnMemory();
      if (!isActiveArchive(shell.selected)) {
        const wasDetail = shell.mode === "detail";
        shell.select(columnFiles(fileLocation(shell.selected).lane)[0] ?? cards.directoryCard);
        if (wasDetail) shell.setMode("detail");
        return;
      }
      if (cards.ownsLane(fileLocation(shell.selected).lane)) shell.scene?.select(shell.selected);
      shell.updateSelection();
      if (shell.mode === "detail" && cards.isDirectory(shell.selected)) {
        const total = shell.$("#host-directory-total"), sources = shell.$("#host-directory-sources");
        if (total) total.textContent = String(cards.bound.length).padStart(2, "0");
        const savedCount = cards.bound.filter(host => host.source === "saved").length;
        if (sources) sources.textContent = `本机 ${savedCount} · SSH config ${cards.bound.length - savedCount}`;
      } else if (shell.mode === "detail" && shell.hostAtCard(shell.selected) && !shell.sshHosts?.isEditing) shell.renderDetail();
      if (shell.modal === "search" || shell.modal === "saved") shell.renderResults();
    });
    // ── host management and quick connections ──────────────────────────────
    const { SshHostsPanel } = await import("./hosts-panel");
    const openHostCard = (card: number) => {
      const ref = cards.resourceAt(card);
      if (shell.sshOverview && ref && ref.kind !== "host" && ref.kind !== "shortcut") { shell.setMode("archive"); shell.sshOverview.openResource(card); return; }
      if (card !== shell.selected) shell.select(card);
      if (shell.mode !== "detail") { shell.activeTab = "overview"; shell.setMode("detail"); }
      else if (shell.activeTab !== "overview") shell.setTab("overview");
    };
    const hosts = new SshHostsPanel(
      loadHosts,
      target => typeof target === "string" ? shell.connectHostAlias(target) : connectLaunch(target),
      {
        profiles: getPlatformBridge()?.hostProfiles,
        loaded: async result => { if (result.ok) await cards.refresh(() => Promise.resolve(result)); },
        activeTarget: () => bank.forAlias(shell.hostAtCard(shell.selected)?.alias ?? "")?.client.active ? shell.hostAtCard(shell.selected)!.alias : null,
        reduced: () => shell.prefs.reduced,
        openHost: alias => { const card = cards.cardOf(alias); if (card !== undefined) openHostCard(card); },
        cardId: alias => { const card = cards.cardOf(alias); return card === undefined ? "" : records[card].id; },
        groups: () => cards.groups,
        saved: (alias, connect) => {
          if (shell.sshOverview?.editing) {
            shell.sshOverview.showPage("hosts"); shell.notify("主机及所选凭据已保存");
            if (connect) shell.connectHostAlias(alias);
            return;
          }
          const card = cards.cardOf(alias);
          if (card !== undefined) {
            shell.activeTab = "overview";
            if (shell.selected === card && shell.mode === "detail") shell.renderDetail();
            else openHostCard(card);
          }
          shell.notify("主机已保存到 SSH 档案列");
          if (connect) shell.connectHostAlias(alias);
        },
        removed: () => { if (shell.sshOverview?.editing) shell.sshOverview.showPage("hosts"); shell.notify("主机已移除，会话历史已保留"); },
        back: () => {
          if (shell.sshOverview?.editing) { shell.sshOverview.showPage("hosts"); return; }
          if (shell.activeTab !== "overview") { shell.setTab("overview"); shell.$("#tab-overview")?.focus({ preventScroll: true }); }
          else closeHosts();
        },
      },
    );
    shell.sshHosts = hosts;
    function closeHosts() {
      if (shell.mode === "detail" && cards.isDirectory(shell.selected)) shell.setMode("archive");
      else if (hosts.isEditing) shell.setTab("overview");
    }
    shell.openSshHosts = () => {
      if (shell.viewer?.isOpen) { shell.viewer.close(() => shell.openSshHosts()); return; }
      if (shell.sshSurfaceActive() || !shell.ready) return;
      // A stowed sheet cannot be routed to: bring it back before choosing a page.
      if (shell.sshOverview) { shell.sshOverview.setCollapsed(false); shell.closeModal(() => { shell.setMode("archive"); shell.sshOverview!.showPage("hosts"); }); return; }
      shell.closeModal(() => { openHostCard(cards.directoryCard); shell.audio.play("open"); });
    };
    shell.pruneSshHistory = () => {
      const button = document.querySelector<HTMLButtonElement>('[data-action="ssh-prune"]');
      if (button?.disabled) return;
      if (button) button.disabled = true;
      void getPlatformBridge()?.records?.prune().then(result => {
        shell.notify(result.ok ? `已清理 ${result.removed} 个过期会话` : "部分记录暂时无法清理");
        if (shell.mode === "detail") void shell.refreshHostDetailData(shell.hostAtCard(shell.selected)?.alias ?? "");
      }).catch(() => shell.notify("清理失败，稍后可重试")).finally(() => { if (button) button.disabled = false; });
    };
    function openAudit() {
      const record = client.buildRecord();
      if (!record) return;
      hidePrompt();
      shell.auditOpen = true;
      audit.show(record, shell.prefs.reduced);
    }
    function closeAudit() {
      shell.auditOpen = false;
      audit.hide(shell.prefs.reduced, () => {
        if (shell.sshTerminal?.isOpen) shell.sshTerminal.focus();
      });
      // Reading the audit temporarily covers a request; it does not answer it.
      handledPrompt = null;
      updateSessionUi(client.status());
    }
    shell.closeSshAudit = () => closeAudit();
    async function exportRecord(target?: string) {
      const result = await client.exportRecord(target, audit.current ?? client.buildRecord());
      if (result.ok && result.file) shell.notify(`会话记录已导出到 ${result.file}`);
      else if (!result.ok && !("canceled" in result && result.canceled)) shell.notify(`导出失败：${result.error ?? "未知原因"}`);
      return result;
    }

    let auxiliaryRequest: { id: string; sessionId: string } | null = null;
    let promptOwner: WorkspaceSession | null = null;
    let promptRequestId: number | null = null;
    const answer = async (value: string, remember = false) => {
      const owner = promptOwner, request = auxiliaryRequest;
      if (!owner || owner !== current || (!request && owner.client.pendingPrompt?.id !== promptRequestId)) return;
      const result = request ? await owner.services.answer(value, false, request, remember) : await owner.client.answerPrompt(value, remember);
      if (!result.ok) shell.notify(result.error ?? "请求未能提交");
    };
    const answerHostKey = (accept: boolean) => {
      if (accept && !(auxiliaryRequest ? services.state?.prompt?.fingerprint : client.status().facts.hostKeyFingerprint?.value)) return;
      void answer(accept ? "yes" : "no");
    };
    const answerSecret = (value: string, remember = false) => { void answer(value, remember); };

    const prompt = new SshPromptPanel(shell.$("#stage"), {
      // The host key answer is the decision itself: ssh is waiting on this line.
      answerHostKey,
      // The main process owns reuse; explicit remember requests use the vault.
      answerSecret,
      cancel: () => {
        if (promptOwner !== current) return;
        current.view.entryGeneration = null;
        if (auxiliaryRequest) {
          void services.answer("", true, auxiliaryRequest).then(result => { if (!result.ok) shell.notify(result.error || "认证请求已结束"); });
        } else { current.manualStop = true; client.stop(); }
        hidePrompt();
      },
      dismiss: () => hidePrompt(),
      retry: () => {
        void reconnect();
      },
      openAudit: () => openAudit(),
      // The attempt is over and the card it ran on has nothing live left on it,
      // so the question's exit is also the way back to the host overview — the
      // same place Escape lands when it leaves the detail view.
      leave: () => {
        if (shell.mode === "detail") shell.setMode("archive");
        shell.audio.play("back");
      },
    });
    const showPrompt = (request: Parameters<typeof prompt.show>[0]) => {
      if (!request.source) auxiliaryRequest = null;
      promptOwner = current;
      promptRequestId = client.pendingPrompt?.id ?? null;
      shell.sshPromptOpen = true;
      prompt.show(request, shell.prefs.reduced);
    };
    function hidePrompt() {
      shell.sshPromptOpen = false;
      auxiliaryRequest = null;
      promptOwner = null;
      promptRequestId = null;
      prompt.hide(shell.prefs.reduced);
    }
    shell.cancelSshPrompt = () => {
      current.view.entryGeneration = null;
      if (promptOwner === current && client.pendingPrompt) { current.manualStop = true; client.stop(); }
      hidePrompt();
    };
    const startSession = async (input: string | SshLaunchDescriptor, reuse?: WorkspaceSession, background = false, project?: import("./workspace-store").ArchiveShortcut, enter = false) => {
      if (shell.demoSsh) { shell.notify("SSH 演示模式：此页面不会连接真实主机"); return; }
      if (reuse?.client.active) return { ok: false as const, error: "这次会话仍在运行" };
      const descriptor = typeof input === "string" ? { target: input } : { ...input, ...(input.extraArgs ? { extraArgs: [...input.extraArgs] } : {}) };
      const context = reuse ?? (current.descriptor || client.target ? bank.create() : current);
      context.descriptor = descriptor;
      if (project) context.project = structuredClone(project);
      context.manualStop = false;
      context.recordSaved = false;
      if (!background) { activateContext(context, false); lastConnection = descriptor; handledPrompt = null; failureShown = false; }
      context.panel.setTarget(context.project?.name || descriptor.displayName || descriptor.target);
      context.panel.setLayout(context.project?.layout ?? cards.store?.layout(descriptor.target), layout => {
        const savedLayout = context.project?.layout ?? cards.store?.layout(descriptor.target);
        const splitAlias = context.splitKey === undefined ? savedLayout?.splitAlias : bank.byKey(context.splitKey)?.descriptor?.target || "";
        const nextLayout = { ...layout, splitAlias, splitRatio: context.splitRatio ?? savedLayout?.splitRatio };
        if (context.project?.kind === "project") {
          const saved = cards.store!.shortcuts.find(row => row.id === context.project!.id);
          if (saved) { context.project = { ...saved, layout: { ...saved.layout, ...nextLayout } }; cards.store!.saveShortcut(context.project); }
        } else cards.store?.saveLayout(descriptor.target, nextLayout);
      });
      context.panel.onCancelRecovery = () => cancelRecovery(context);
      context.panel.setBookmarkHandler(path => {
        const saved = cards.store?.saveBookmark({ alias: descriptor.target, path, name: path.split("/").filter(Boolean).at(-1) || "/" });
        shell.notify(saved ? "目录已加入收藏" : cards.store?.error || "目录未能保存");
      }, cards.store, descriptor.target);
      context.view.entryGeneration = enter || project ? context.client.generation + 1 : null;
      context.view.presentation = enter || project ? "waiting" : "inspection";
      const result = await context.client.start({ cols: 100, rows: 30, ...descriptor });
      if (!result.ok && context === current && !background) {
        failureShown = true;
        shell.sshPromptOpen = true;
        prompt.show({ kind: "failure", reason: result.error, phase: "failed", timeline: [], log: [] }, shell.prefs.reduced);
      }
      shell.sshLibrary?.refresh();
      return result;
    };
    const reconnect = async (context = current) => {
      const descriptor = context.descriptor ?? lastConnection;
      if (!descriptor) return { ok: false as const, error: "没有可重新连接的主机" };
      hidePrompt();
      return startSession(descriptor, context, false, undefined, true);
    };
    /**
     * Connect from a card's context: the alias's card becomes the selection
     * and rises into the detail view, so the handshake plays out as that
     * card's own decryption (the glass frosts over and re-clears on events).
     */
    const connectLaunch = (descriptor: SshLaunchDescriptor, forceNew = false, anchor?: number) => {
      const alias = descriptor.target;
      const existing = bank.forAlias(alias);
      if (!forceNew && existing?.client.active) {
        activateContext(existing, panel.isOpen);
        shell.openSshTerminal?.();
        return;
      }
      const card = anchor ?? cards.cardOf(alias);
      if (card !== undefined && card !== shell.selected) shell.select(card);
      if (card !== undefined && shell.mode !== "detail") shell.setMode("detail");
      shell.audio.play("open");
      void startSession(descriptor, undefined, false, undefined, true);
    };
    shell.connectHostAlias = (alias: string, newSession = false) => {
      connectLaunch({ target: alias, displayName: alias }, newSession);
    };
    /** The overview's 重连: end this host's live session (if any) and connect it again in the same tab. */
    const reconnectHostAlias = (alias: string) => {
      const context = bank.forAlias(alias);
      if (!context) { shell.connectHostAlias(alias); return; }
      const card = cards.cardOf(alias);
      if (card !== undefined && card !== shell.selected) shell.select(card);
      if (card !== undefined && shell.mode !== "detail") shell.setMode("detail");
      shell.audio.play("open");
      void (async () => {
        if (context.client.active) {
          context.manualStop = true; context.client.stop();
          // The exit arrives from the main process; the tab can start again once it has.
          for (let waited = 0; context.client.active && waited < 4000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
          if (context.client.active) { shell.notify("连接还没有结束，请稍后再试"); return; }
        }
        await reconnect(context);
      })();
    };
    shell.openHostSession = alias => {
      const context = bank.forAlias(alias);
      if (context) { activateContext(context, panel.isOpen); shell.openSshTerminal?.(); }
      else shell.connectHostAlias(alias);
    };
    shell.openStoredRecord = (file: string) => {
      const bridge = getPlatformBridge()?.records;
      if (!bridge) return;
      void bridge.read(file).then((result) => {
        if (!result.ok || !result.record) {
          shell.notify(`无法读取会话记录：${result.error ?? "未知原因"}`);
          return;
        }
        hidePrompt();
        shell.auditOpen = true;
        audit.show(result.record, shell.prefs.reduced);
      });
    };

    // The terminal appears when ssh says the session is interactive — the same
    // event that finishes the glass reveal, so the two agree by construction.
    let lastPhase = "";
    let seenGeneration = client.generation;
    let sessionCard = shell.selected;
    /**
     * Auto-reveal happens once per session. Traffic readings re-run this on
     * every tick, so without the flag a terminal the user closed by hand in
     * the array would pop straight back open.
     */
    let revealed = false;
    function saveContext() {
      Object.assign(current.view, { interactiveGeneration, revealed, failureShown, lastPhase, seenGeneration, sessionCard });
    }
    function activateContext(next: WorkspaceSession, keepOperating: boolean, feedback = true) {
      if (next === current) return;
      const fast = keepOperating && panel.isOpen && !panel.isClosing &&
        next.view.interactiveGeneration === next.client.generation;
      if (fast && feedback) shell.audio.play("ssh-switch");
      saveContext();
      hidePrompt();
      bank.activate(next);
      current = next; client = next.client; services = next.services; panel = next.panel;
      shell.sshClient = client; shell.sshTerminal = panel;
      ({ interactiveGeneration, revealed, failureShown, lastPhase, seenGeneration, sessionCard } = next.view);
      lastConnection = next.descriptor;
      handledPrompt = null;
      restoreTerminalFocus = false;
      terminalClosing = false;
      terminalRequested = fast;
      shell.sshTerminalPending = false;
      if (fast) {
        sessionCard = shell.selected;
        current.view.sessionCard = shell.selected;
        revealed = true;
        panel.setAppearance(shell.prefs.colorTheme === "dark", shell.prefs.reduced);
        panel.show(shell.prefs.reduced, shell.scene?.projectSessionScreen());
      }
      deck?.bind(client, panel);
      shell.updateSelection();
      updateSessionUi(client.status());
      syncSessionNavigation();
    }
    function syncSessionNavigation() {
      for (const context of bank.visibleSessions) context.panel.setRecovery(context.recovery);
      panel.onSettings = () => openWorkspacePreferences();
      panel.onSearch = () => openQuickSearch();
      panel.onCancelRecovery = () => cancelRecovery(current);
      panel.onSplitSelect = value => chooseSplit(current, value);
      panel.setSplitOptions([
        ...bank.visibleSessions.filter(session => session !== current).map(session => ({ value: "session:" + session.key, label: session.project?.name || session.client.displayTarget || session.descriptor?.target || "SSH" })),
        ...cards.bound.map(host => ({ value: "host:" + host.alias, label: "新连接 / " + hostLabel(host) })),
      ]);
      const items = bank.visibleSessions.map(session => ({ key: session.key,
        label: `${records[cards.resourceCard("session", session.key) ?? -1]?.id || "SSH"} / ${session.client.displayTarget || session.descriptor?.displayName || session.descriptor?.target || "SSH"}`,
        state: session.client.pendingPrompt || session.services.state?.prompt ? "等待认证" : session.recovery || session.client.status().label,
        alert: session.alert,
        transfers: session.services.state?.jobs.filter(job => ["queued", "scanning", "transferring", "committing", "conflict"].includes(job.state)).length || 0 }));
      panel.setSessionNavigation(items, current.key, key => {
        const next = bank.byKey(key);
        if (next) { activateContext(next, true); shell.openSshTerminal?.(); }
      }, () => requestStop(current), key => { const context = bank.byKey(key); if (context) requestStop(context, true); });
    }
    const closingSessions = new Set<string>();
    let retiringLastSession: WorkspaceSession | null = null;
    function removeClosedSession(context: WorkspaceSession) {
      if (context.client.active || !bank.sessions.includes(context)) return;
      const restoreFocus = document.activeElement?.closest<HTMLElement>("[data-session-key]")?.dataset.sessionKey === context.key;
      context.retiring = true;
      if (context === current) {
        const operating = terminalRequested || panel.isOpen || panel.isClosing;
        const next = bank.visibleSessions.find(item => item !== context);
        if (next) {
          activateContext(next, operating, false);
          if (operating) shell.openSshTerminal?.();
        } else if (operating || (shell.scene?.sessionDeckFocus ?? 0) > .001) {
          // Keep the final parser and texture until its own package has shut.
          // The closing tab is removed immediately, so it cannot be resumed.
          retiringLastSession = context;
          close(false, "overview");
          syncSessionNavigation(); shell.sshOverview?.update();
          return;
        } else {
          activateContext(bank.create(), false, false);
          shell.setMode("archive");
        }
      }
      bank.remove(context); eventAudio.remove(context.key); library.refresh(); syncSessionNavigation(); shell.sshOverview?.update();
      if (restoreFocus) { if (panel.isOpen) panel.focus(); else shell.sshOverview?.focusSession(); }
    }
    function requestStop(context: WorkspaceSession, remove = false) {
      if (!context.client.active) { if (remove) removeClosedSession(context); return; }
      const stop = () => {
        if (remove) closingSessions.add(context.key);
        context.manualStop = true; context.client.stop(); shell.notify("已请求结束这次会话");
      };
      const pending = context.services.state?.jobs.some(job => ["queued", "scanning", "transferring", "committing", "conflict"].includes(job.state));
      if (pending) {
        activateContext(context, panel.isOpen);
        // A request from the library must establish this session's archive
        // anchor before its confirmation surface can survive the next frame.
        shell.openSshTerminal?.();
        syncSessionNavigation(); panel.confirmStop(stop);
      } else stop();
    }
    shell.stopSshSession = () => requestStop(bank.forAlias(shell.hostAtCard(shell.selected)?.alias ?? "") ?? current);
    shell.switchSshSession = direction => {
      const items = bank.visibleSessions;
      if (items.length < 2) return;
      const next = items[wrap(items.indexOf(current) + direction, items.length)];
      activateContext(next, panel.isOpen);
      shell.openSshTerminal?.();
    };
    /**
     * Bring the terminal up once a session exists.
     *
     * Reachable by hand too (Ctrl+Shift+T, and the archive's own way of
     * opening the session's card): a surface that only ever appears by itself
     * leaves the user with nothing to do if it does not.
     */
    function revealTerminal(status: ReturnType<SshClient["status"]> = client.status()) {
      if (revealed || panel.isOpen || shell.auditOpen || shell.viewer?.isOpen || !client.target || current.view.entryGeneration !== client.generation) return;
      if (status.phase !== "interactive") return;
      shell.openSshTerminal?.();
      revealed = true;
    }
    const updateSessionUi = (status: ReturnType<SshClient["status"]>) => {
      if (seenGeneration !== client.generation) {
        seenGeneration = client.generation;
        terminalRequested = false;
        terminalClosing = false;
        shell.sshTerminalPending = false;
        interactiveGeneration = -1;
        // A reconnect closes the package on its own schedule, so the stack is
        // put back in one step rather than springing shut inside it.
        panel.hide(true);
        shell.scene?.setSessionDeckState("packed");
        sessionCard = cards.resourceAt(shell.selected)?.alias === client.target ? shell.selected : cards.cardOf(client.target ?? "") ?? shell.selected;
        revealed = false;
        failureShown = false;
        handledPrompt = null;
      }
      if (status.phase === "interactive") interactiveGeneration = client.generation;
      if (status.phase === "failed" && interactiveGeneration !== client.generation) {
        terminalRequested = false; shell.sshTerminalPending = false;
      }
      // The session's card mirrors the live state in the HUD and the detail.
      const targetCard = client.target ? cards.cardOf(client.target) : undefined;
      if (targetCard !== undefined && status.phase !== lastPhase) {
        lastPhase = status.phase;
        shell.updateSelection();
        if (shell.mode === "detail" && shell.selected === targetCard) shell.patchHostState(targetCard);
      }
      if (shell.auditOpen) return;
      revealTerminal(status);
      // A pending question blocks the workflow until it is answered.
      const pending = client.pendingPrompt;
      const key = pending ? "primary:" + pending.id : null;
      const auxiliary = !pending && services.state?.active ? services.state.prompt : null;
      if (!pending && !auxiliary) {
        handledPrompt = null;
        if (prompt.kind && prompt.kind !== "failure") hidePrompt();
      }
      if (auxiliary) {
        const auxiliaryKey = `auxiliary:${services.sessionId}:${auxiliary.id}`;
        if (auxiliaryKey !== handledPrompt) {
          handledPrompt = auxiliaryKey;
          auxiliaryRequest = { id: auxiliary.id, sessionId: services.sessionId };
          const shared = { requestId: auxiliaryKey, source: auxiliary.source, canRemember: auxiliary.canRemember };
          if (auxiliary.kind === "hostkey") showPrompt({ ...shared, kind: "hostkey", host: client.displayTarget || client.target || "", keyType: "", fingerprint: auxiliary.fingerprint, raw: auxiliary.diagnostics + "\n" + auxiliary.prompt });
          else if (auxiliary.kind === "password") showPrompt({ ...shared, kind: "password", host: client.displayTarget || client.target || "", prompt: auxiliary.prompt });
          else if (auxiliary.kind === "passphrase") showPrompt({ ...shared, kind: "passphrase", key: auxiliary.prompt.match(/['\"]([^'\"]+)['\"]/)?.[1] || "SSH 私钥", prompt: auxiliary.prompt });
          else showPrompt({ ...shared, kind: "verification-code", prompt: auxiliary.prompt });
        }
      } else if (pending?.kind === "hostkey") {
        // The pty question can arrive a poll before the `-E` tail reads the
        // `Server host key:` line. Asking someone to confirm a fingerprint we
        // have not read yet would be an assertion without evidence, so re-render
        // as soon as the real value lands.
        const fingerprint = status.facts.hostKeyFingerprint?.value ?? "";
        const hostKeyKey = `${key}:${fingerprint}`;
        if (hostKeyKey !== handledPrompt) {
          handledPrompt = hostKeyKey;
          showPrompt({
            kind: "hostkey",
            requestId: pending.id,
            host: status.facts.host?.value ?? pending.host,
            keyType: status.facts.hostKeyType?.value ?? "",
            fingerprint,
            raw: client.rawLog.slice(-6).join("\n"),
          });
        }
      } else if (pending && key !== handledPrompt) {
        handledPrompt = key;
        if (pending.kind === "password") {
          showPrompt({ kind: "password", host: pending.host, prompt: pending.prompt, requestId: pending.id, canRemember: pending.canRemember });
        } else if (pending.kind === "passphrase") {
          showPrompt({ kind: "passphrase", key: pending.key, prompt: pending.prompt, requestId: pending.id, canRemember: pending.canRemember });
        } else {
          showPrompt({ kind: "verification-code", prompt: pending.prompt, requestId: pending.id });
        }
      }
      // Failures get their own surface, with the raw lines that prove them.
      if (status.phase === "failed" && !failureShown && interactiveGeneration !== client.generation) {
        failureShown = true;
        hidePrompt();
        shell.sshPromptOpen = true;
        prompt.show(
          {
            kind: "failure",
            reason: status.failure ?? "连接失败",
            phase: status.phase,
            timeline: status.timeline.map((entry) => ({
              label: entry.label,
              at: entry.at,
              duration: entry.duration,
            })),
            log: client.rawLog,
          },
          shell.prefs.reduced,
        );
      }
    };

    /**
     * The session as the card's contents (ssh/terminal-deck.ts): while the
     * handshake runs, the deck sits behind the frosted cover showing the real
     * authentication log; once ssh reports interactive, the lid lifts and the
     * deck comes forward at operating size. Created lazily and re-created if
     * the scene was reloaded (a disposed scene takes its deck with it).
     */
    const { TerminalDeck, TERMINAL_INSPECTION_PARTS } = await import("./terminal-deck");
    let deck: Awaited<ReturnType<typeof TerminalDeck.load>> | null = null;
    let deckOwner: ArchiveScene | null = null;
    let deckLoading: ArchiveScene | null = null;
    let deckBroken: ArchiveScene | null = null;
    let inspectionTicket = 0;
    shell.inspectSshHost = (alias, fresh = false) => {
      if (shell.viewer?.isOpen) return;
      const host = [...cards.bound, ...cards.overflow].find(entry => entry.alias === alias);
      const existing = fresh ? undefined : bank.forAlias(alias);
      const card = cards.cardOf(alias);
      if (card !== undefined) openHostCard(card);
      if (existing) { activateContext(existing, false); existing.view.presentation = "inspection"; existing.view.entryGeneration = null; }
      const owner = shell.scene;
      const ticket = ++inspectionTicket;
      const session = existing ?? current;
      const generation = session.client.generation;
      shell.viewer ??= new ModelViewer(shell.$("#viewport"), () => { shell.historyNav.leave("viewer"); shell.audio.setScene(shell.mode); }, sound => shell.audio.play(sound === "tick" ? "ui-tick" : sound));
      shell.historyNav.enter("viewer"); shell.audio.setScene("viewer");
      shell.viewer.setSuperPerformance(shell.superPerformanceEnabled()); shell.viewer.setQuality(shell.effectiveRenderQuality());
      shell.viewer.open(card === undefined ? "SSH" : records[card].id, host ? hostLabel(host) : alias,
        () => owner ? TerminalDeck.inspection(session.client, session.panel, () => owner.createAssemblyModel()) : Promise.reject(new Error("模型场景不可用")),
        shell.prefs.reduced, { kind: "terminal", parts: TERMINAL_INSPECTION_PARTS, exploded: true,
          primary: { label: "进入终端 ↗", run: () => {
            if (ticket !== inspectionTicket || session.client.generation !== generation || (card !== undefined && shell.selected !== card)) return;
            if (existing?.client.active) { activateContext(existing, false); shell.openSshTerminal?.(); }
            else connectLaunch({ target: alias, displayName: host ? hostLabel(host) : alias }, fresh);
          } },
        });
    };
    const ensureDeck = () => {
      const owner = shell.scene;
      if (!owner || deckBroken === owner || deckLoading === owner || (deckOwner === owner && owner.hasSessionDeck)) return;
      deckLoading = owner;
      void TerminalDeck.load(client, panel, () => owner.createAssemblyModel()).then(created => {
        if (shell.scene !== owner) { created.dispose(); return; }
        deck = created; deckOwner = owner; owner.setSessionDeck(created);
      }).catch(error => {
        if (shell.scene !== owner) return;
        deckBroken = owner;
        console.error("终端模型载入失败：", error);
        shell.notify("终端模型载入失败，已保留常规终端入口");
      }).finally(() => { if (deckLoading === owner) deckLoading = null; });
    };

    const { SshLibrary } = await import("./library");
    const { SshEventAudio } = await import("./event-audio");
    const eventAudio = new SshEventAudio(sound => shell.audio.play(sound));
    let pendingCommand: { key: string; generation: number; text: string } | null = null;
    let pendingWorkspacePage: { key: string; page: "terminal" | "files" | "monitor"; path?: string; transfers?: boolean } | null = null;
    const openWorkspace = (context: WorkspaceSession, page: "terminal" | "files" | "monitor" = "terminal", path?: string, transfers?: boolean) => {
      activateContext(context, panel.isOpen);
      pendingWorkspacePage = { key: context.key, page, path, transfers };
      shell.openSshTerminal?.();
    };
    function saveSplit(context: WorkspaceSession, alias: string, ratio = context.splitRatio || .5) {
      context.splitRatio = ratio;
      if (context.project) {
        const row = cards.store!.shortcuts.find(row => row.id === context.project!.id);
        if (row) { context.project = { ...row, layout: { width: 320, page: "terminal", ...row.layout, splitAlias: alias, splitRatio: ratio } }; cards.store!.saveShortcut(context.project); }
      } else if (context.descriptor) {
        const layout = cards.store!.layout(context.descriptor.target) || { width: 320, page: "terminal" as const };
        cards.store!.saveLayout(context.descriptor.target, { ...layout, splitAlias: alias, splitRatio: ratio });
      }
    }
    function chooseSplit(context: WorkspaceSession, value: string) {
      if (value === "none") { context.splitKey = ""; context.panel.setSplit(undefined); saveSplit(context, ""); return; }
      let peer: WorkspaceSession | undefined;
      if (value.startsWith("session:")) peer = bank.byKey(value.slice(8));
      else if (value.startsWith("host:")) {
        const host = cards.bound.find(host => host.alias === value.slice(5));
        if (!host) return;
        peer = bank.create(); context.splitKey = peer.key;
        void startSession({ target: host.alias, displayName: hostLabel(host) }, peer, true);
      }
      if (!peer || peer === context) return;
      context.splitKey = peer.key;
      context.panel.selectPage("terminal"); peer.panel.selectPage("terminal");
      saveSplit(context, peer.descriptor?.target || peer.client.target || "");
      syncSessionNavigation();
    }
    const library = new SshLibrary(cards, bank, {
      reduced: () => shell.prefs.reduced,
      openCard: openHostCard,
      openSession: openWorkspace,
      connect: (alias, path) => {
        connectLaunch({ target: alias });
        pendingWorkspacePage = { key: current.key, page: "files", path };
      },
      openHosts: shell.openSshHosts,
      insert: (context, text) => {
        openWorkspace(context, "terminal");
        pendingCommand = { key: context.key, generation: context.client.generation, text };
      },
      stop: requestStop,
      removeSession: context => {
        if (!context.client.active) { removeClosedSession(context); shell.notify("会话已移出，历史记录仍然保留"); }
      },
      record: shell.openStoredRecord,
      notify: shell.notify,
      shortcut: row => shell.openSshShortcut(row.id, true),
    });
    const directoryOnConnect = new Map<string, { path: string; generation: number }>();
    const { TunnelPanel } = await import("./tunnel-panel");
    const tunnelPanel = new TunnelPanel(bank, () => shell.prefs.reduced, shell.notify);
    const pendingTunnels = new Map<string, { shortcut: import("./workspace-store").ArchiveShortcut; generation: number }>();
    function startPendingTunnel(context: WorkspaceSession) {
      const request = pendingTunnels.get(context.key);
      if (!request) return;
      if (context.client.generation !== request.generation || context.manualStop || context.client.exit) { pendingTunnels.delete(context.key); return; }
      if (!context.client.active || context.client.status().phase !== "interactive" || !context.services.state || ["waiting", "closed"].includes(context.services.state.sftp.state)) return;
      pendingTunnels.delete(context.key);
      void tunnelPanel.start(context, request.shortcut);
    }
    shell.openSshShortcut = (id, force = false) => {
      const row = cards.store!.shortcuts.find(s => s.id === id);
      const card = cards.resourceCard("shortcut", id);
      if (!row || card === undefined) return;
      if (shell.selected !== card) shell.select(card);
      if (shell.mode !== "detail") shell.setMode("detail");
      if (row.kind === "note" || !force && !row.autoOpen) return;
      const host = cards.bound.find(h => h.alias === row.alias);
      if (!host) { shell.notify("关联主机已移除，请编辑这份档案重新选择主机"); return; }
      const terminalDirectory = row.kind === "terminal" && Boolean(row.path);
      if (row.kind === "project") {
        const existing = bank.visibleSessions.find(session => session.project?.id === row.id && session.client.active);
        if (existing) activateContext(existing, panel.isOpen);
        else void startSession({ target: row.alias, displayName: hostLabel(host) }, undefined, false, row);
        pendingWorkspacePage = { key: current.key, page: row.layout?.page || "files", path: row.layout?.page === "files" ? row.path : undefined };
        shell.openSshTerminal?.();
        return;
      }
      connectLaunch({ target: row.alias, displayName: hostLabel(host) }, terminalDirectory, card);
      pendingWorkspacePage = { key: current.key, page: row.kind === "tunnel" ? "terminal" : row.kind, path: row.kind === "files" ? row.path : undefined };
      if (terminalDirectory) directoryOnConnect.set(current.key, { path: row.path, generation: client.generation });
      if (row.kind === "tunnel") { pendingTunnels.set(current.key, { shortcut: structuredClone(row), generation: client.generation }); startPendingTunnel(current); }
    };
    shell.sshLibrary = library;
    const { SshOverview } = await import("./overview");
    const overview = shell.sshOverview = new SshOverview(cards, bank, hosts, library, {
      reduced: () => shell.prefs.reduced,
      collapsedChanged: value => shell.syncArchiveChrome(value),
      inspect: alias => { const card = cards.cardOf(alias); if (card !== undefined) { openHostCard(card); shell.audio.play("open"); } },
      preview: alias => { const card = cards.cardOf(alias); if (card !== undefined && shell.mode === "archive" && !shell.modal && !shell.sshSurfaceActive()) shell.scene?.previewArchive(card); },
      connect: (alias, fresh) => shell.connectHostAlias(alias, fresh),
      reconnect: alias => reconnectHostAlias(alias),
      disconnect: alias => { const context = bank.forAlias(alias); if (context) requestStop(context); },
      duplicate: async alias => {
        const result = await hosts.duplicate(alias);
        if (result.ok) shell.notify("已复制主机，口令需在首次连接时输入");
        return result;
      },
      remove: async alias => {
        // A live session keeps its host: end it first, as the host editor's own remove does.
        if (bank.forAlias(alias)?.client.active) return { ok: false, error: "先断开会话" };
        const result = await hosts.removeByAlias(alias);
        if (result.ok) shell.notify("主机已移除，会话历史已保留");
        return result;
      },
      session: key => { const context = bank.byKey(key); if (context) openWorkspace(context); },
      closeSession: key => { const context = bank.byKey(key); if (context) requestStop(context, true); },
      settings: () => openWorkspacePreferences(), search: () => openQuickSearch(), pageSound: () => shell.audio.play("ui-tick"),
    });
    shell.$("#viewport").append(overview.root);
    shell.$("#viewport").dataset.sshOverview = "true";
    if (shell.mode === "detail" && cards.resourceAt(shell.selected)?.kind !== "host") shell.renderDetail();

    let previous = 0;
    shell.sshFrame = (time: number) => {
      // A real frame delta, clamped so a stalled or backgrounded window cannot
      // fast-forward the reveal when it resumes.
      const dt = previous ? Math.min(0.25, Math.max(0, time - previous)) : 0;
      previous = time;
      const snapshot = client.tick(dt);
      panel.setAppearance(shell.prefs.colorTheme === "dark", shell.prefs.reduced);
      // null means no session has run yet: hand the scene back to its own clock.
      shell.scene?.setDecryptionReference(snapshot && shell.mode === "detail" && shell.selected === sessionCard ? snapshot.reference : null);
      // The session's own card carries the session as its contents: auth log
      // behind the frosted cover first, open lid and operating size once the
      // session is interactive. Any other view is an ordinary file.
      // A deck failure must never take the frame loop down with it — the
      // archive, the prompt and the DOM terminal all outrank the 3D mirror.
      const resource = shell.mode !== "boot" ? cards.resourceAt(shell.selected) : undefined;
      const host = shell.hostAtCard(shell.selected);
      if (terminalRequested && (shell.mode !== "detail" || shell.selected !== sessionCard)) close(false, "stay");
      if (deckOwner === shell.scene && shell.scene && !shell.scene.hasSessionDeck) {
        deckBroken = shell.scene; deckOwner = null; deck = null;
        shell.notify("三维终端已停用，会话继续保留在常规终端中");
      }
      if (resource && shell.scene) ensureDeck();
      const held = shell.selected === sessionCard && (terminalRequested || terminalClosing || (shell.scene?.sessionDeckFocus ?? 0) > 0);
      const bound = held ? current : resource?.sessionKey ? bank.byKey(resource.sessionKey) : resource?.alias ? bank.forAlias(resource.alias) : undefined;
      if (deck && deckOwner === shell.scene && resource) {
        deck.setCard(records[shell.selected].id);
        deck.bind(bound?.client ?? client, bound?.panel ?? panel);
        const screenSession = held || resource.kind === "session" && !resource.directory;
        if (screenSession && bound?.client.target) deck.setHost(bound.client.target, sessionLabelFor(bound));
        else if (host) deck.setHost(host.alias, hostLabel(host));
        else { const preview = library.preview(shell.selected); deck.setPreview(preview.key, preview.title, preview.lines); }
      }
      const operating = interactiveGeneration === client.generation && shell.selected === sessionCard;
      // Inspecting holds the package open the same way operating does; without
      // that term the lid would swing shut the moment the terminal stepped off
      // the screen, with the stack already separated inside it.
      shell.scene?.setSessionOpeningDuration(sshPreferences.value.animation === "first" && openedArchives.has(records[shell.selected]?.id || "") ? .6 : 2.1);
      shell.scene?.setSessionDeckState(resource ? ((terminalRequested || terminalClosing) && operating ? "open" : "packed") : "off");
      shell.$("#stage").dataset.sshDeck = String(Boolean(resource && shell.scene?.hasSessionDeck));
      const covered = panel.isOpen && !panel.isClosing && !shell.sshPromptOpen && !shell.auditOpen && !shell.modal && !shell.viewer?.isOpen;
      shell.scene?.setSessionSurfaceCovered(covered && panel.isProjected);
      shell.audio.setOperating(covered);
      // SSH traffic belongs in the measured indicators. The archive only moves
      // in response to browsing, selection and extraction.
      shell.scene?.setAmbientMotion(false);
      shell.scene?.setPlayfield(false, client.meter.value, 0, 0, null, false);
    };

    // Map the native-pixel terminal after the camera update, so its rectangle
    // follows this frame's model during resize and an interrupted close.
    shell.sshAfterFrame = () => {
      if (retiringLastSession && (retiringLastSession !== current ||
        !panel.isOpen && !panel.isClosing && (shell.scene?.sessionDeckFocus ?? 0) < .001)) {
        const retired = retiringLastSession; retiringLastSession = null;
        removeClosedSession(retired);
      }
      shell.$("#stage").style.setProperty("--ssh-focus", String(shell.scene?.sessionDeckFocus ?? 0));
      if (restoreTerminalFocus && !shell.sshSurfaceActive() && (shell.scene?.sessionDeckFocus ?? 0) < .01) {
        const connect = shell.$("#host-connect");
        const button = shell.mode === "detail"
          ? connect && !connect.closest("[inert],[hidden]") ? connect : shell.$("#tab-overview")
          : shell.$(".read-file");
        if (button && !button.closest("[inert],[hidden]")) {
          button.focus({ preventScroll: true }); restoreTerminalFocus = false;
        }
      }
      if (panel.isOpen && panel.isProjected && shell.scene === deckBroken) panel.show(shell.prefs.reduced);
      const projection = shell.scene?.projectSessionScreen();
      if ((panel.isOpen || panel.isClosing) && panel.isProjected && projection) panel.setProjection(projection);
      if (panel.isOpen && !panel.isClosing && !prompt.isOpen && !audit.isOpen) {
        current.view.presentation = "terminal";
        openedArchives.add(records[shell.selected]?.id || "");
        const splitOwner = current, splitPeer = bank.byKey(current.splitKey || "");
        panel.setSplit(splitPeer?.panel, current.splitRatio || current.project?.layout?.splitRatio || .5,
          ratio => saveSplit(splitOwner, splitPeer?.descriptor?.target || "", ratio),
          () => chooseSplit(splitOwner, "none"));
        if (pendingWorkspacePage?.key === current.key) {
          const request = pendingWorkspacePage; pendingWorkspacePage = null;
          panel.selectPage(request.page);
          if (request.path) void panel.openDirectory(request.path);
          if (request.transfers) panel.showTransfers();
        }
        if (pendingCommand) {
          const request = pendingCommand; pendingCommand = null;
          if (request.key === current.key && request.generation === client.generation) {
            if (!panel.pasteCommand(request.text)) shell.notify("当前会话无法安全插入该片段；多行命令需要终端启用括号粘贴");
          }
        }
      }
      if (!terminalRequested || panel.isOpen || prompt.isOpen || audit.isOpen || shell.modal || shell.viewer?.isOpen) return;
      const card = cards.resourceAt(sessionCard) ? sessionCard : undefined;
      // A failed connection has no shell to unpack, but its output action must
      // still open the retained authentication log instead of waiting forever.
      const endedBeforeShell = !client.active && interactiveGeneration !== client.generation;
      if (card === undefined || !shell.scene || deckBroken === shell.scene || endedBeforeShell) {
        panel.show(shell.prefs.reduced);
        shell.sshTerminalPending = false;
      } else if (shell.scene.sessionDeckReady && projection && shell.scene.sessionDeckFocus >= 1) {
        panel.show(shell.prefs.reduced, projection);
        shell.sshTerminalPending = false;
      }
    };

    const sessionLabelFor = (context: WorkspaceSession) => context.client.displayTarget || context.descriptor?.displayName || context.descriptor?.target || "SSH";
    const savedRecords = new Set<string>();
    let catalogTimer = 0;
    const offBank = bank.onChange((context, event) => {
      startPendingTunnel(context);
      const project = context.project;
      if (project && context.startupGeneration !== context.client.generation && context.client.active && context.client.status().phase === "interactive") {
        context.startupGeneration = context.client.generation;
        const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
        const command = `cd -- ${quote(project.path)}` + (project.tmux ? ` && if command -v tmux >/dev/null 2>&1; then tmux new-session -A -s ${quote(project.tmux)} -c ${quote(project.path)}; else printf '%s\\n' 'tmux is not installed; continuing in a regular shell.'; fi` : "");
        context.client.write(command + "\r");
        if (project.layout?.splitAlias && context.splitKey === undefined) {
          const host = cards.bound.find(host => host.alias === project.layout!.splitAlias);
          if (host) {
            const peer = bank.create(); context.splitKey = peer.key; context.splitRatio = project.layout.splitRatio || .5;
            void startSession({ target: host.alias, displayName: hostLabel(host) }, peer, true);
          }
        }
      }
      const directory = directoryOnConnect.get(context.key);
      if (directory && context.client.generation === directory.generation && context.client.active && context.client.status().phase === "interactive") {
        directoryOnConnect.delete(context.key);
        context.client.write("cd -- '" + directory.path.replaceAll("'", "'\\''") + "'\r");
      } else if (directory && (!context.client.active || context.client.generation !== directory.generation)) directoryOnConnect.delete(context.key);
      eventAudio.update(context);
      if (event?.event === "credential-error") shell.notify(`${sessionLabelFor(context)}：${event.data.message}`);
      if (closingSessions.has(context.key) && context.client.exit) {
        closingSessions.delete(context.key);
        void context.client.persistRecord().catch(() => {}).finally(() => removeClosedSession(context));
      }
      if (context === current && (!event || ["auth", "snapshot", "stopped"].includes(event.event))) updateSessionUi(client.status());
      const recordKey = context.key + ":" + context.client.generation;
      if (context.recordSaved && !savedRecords.has(recordKey)) {
        savedRecords.add(recordKey); void library.reloadHistory();
        if (shell.hostAtCard(shell.selected)?.alias === context.client.target) void shell.refreshHostDetailData(context.client.target!);
      }
      if (!catalogTimer) catalogTimer = window.setTimeout(() => {
        catalogTimer = 0; library.refresh(); syncSessionNavigation(); overview.update();
      }, 120);
    });
    const { SessionHealth } = await import("./session-health");
    const health = new SessionHealth(bank, context => startSession(context.descriptor!, context, true), shell.notify);
    cancelRecovery = context => health.cancel(context);
    const { SshQuickSearch } = await import("./quick-search");
    const quickSearch = new SshQuickSearch(cards, bank, {
      reduced: () => shell.prefs.reduced, host: alias => shell.connectHostAlias(alias), shortcut: id => shell.openSshShortcut(id, true),
      session: key => { const context = bank.byKey(key); if (context) openWorkspace(context); },
      bookmark: (alias, path) => { const context = bank.forAlias(alias); if (context?.client.active) openWorkspace(context, "files", path); else { connectLaunch({ target: alias }); pendingWorkspacePage = { key: current.key, page: "files", path }; } },
      command: id => { const card = cards.resourceCard("command", id); if (card !== undefined) { close(false, "overview"); shell.setMode("archive"); overview.openResource(card); } },
    });
    openQuickSearch = () => quickSearch.open();
    const { SshSettingsPanel } = await import("./settings-panel");
    const workspaceSettings = new SshSettingsPanel(cards.store!, {
      reduced: () => shell.prefs.reduced, system: () => shell.openModal("settings"), tunnels: () => tunnelPanel.open(),
      security: () => { close(false, "overview"); shell.setMode("archive"); overview.showPage("keys"); },
      imported: async () => { await hosts.refresh(); library.refresh(); overview.update(); syncSessionNavigation(); }, notify: shell.notify,
    });
    openWorkspacePreferences = () => workspaceSettings.open();
    shell.openSettingsSection = section => workspaceSettings.open(section);
    void hosts.refresh().then(() => {
      overview.update();
      if (shell.mode === "detail" && cards.isDirectory(shell.selected) && !hosts.isOpen) shell.setTab(shell.activeTab, false);
    });
    syncSessionNavigation();
    Object.assign(window, {
      rhineSsh: client,
      rhineSshUi: {
        startSession,
        reconnect,
        openTerminal: () => shell.openSshTerminal?.(),
        closeTerminal: close,
        get isOpen() {
          return panel.isOpen;
        },
        get hasFocus() {
          return panel.hasFocus;
        },
        get promptKind() {
          return prompt.kind;
        },
        get promptOpen() {
          return prompt.isOpen;
        },
        get promptText() {
          return prompt.text;
        },
        answerHostKey,
        answerSecret,
        dismissPrompt: () => hidePrompt(),
        openAudit: () => openAudit(),
        closeAudit: () => closeAudit(),
        get auditOpen() {
          return audit.isOpen;
        },
        get auditText() {
          return (audit.current && (document.querySelector(".ssh-record .ssh-audit-body")?.textContent ?? "")) || "";
        },
        exportRecord,
        openHosts: () => shell.openSshHosts(),
        closeHosts: () => closeHosts(),
        get hostsOpen() {
          return shell.mode === "detail" && cards.isDirectory(shell.selected);
        },
        get hostDirectoryCard() { return cards.directoryCard; },
        get hostList() {
          return hosts.items;
        },
        // ── host cards: the array as the host list ─────────────────────────
        connectHost: (alias: string) => shell.connectHostAlias(alias),
        cardOf: (alias: string) => cards.cardOf(alias) ?? null,
        hostAt: (card: number) => cards.hostAt(card)?.alias ?? null,
        get boundHosts() {
          return cards.bound.map((entry) => entry.alias);
        },
        get overflowHosts() {
          return cards.overflow.map((entry) => entry.alias);
        },
        reloadHosts: async () => {
          return hosts.refresh();
        },
        get sessions() { return bank.visibleSessions.map(context => ({ key: context.key, id: context.client.id, target: context.client.target, phase: context.client.status().phase, active: context.client.active,
          bufferLines: context.panel.screenTerminal.buffer.active.length, directory: context.panel.directory, sampleSequence: context.services.state?.sample?.sequence ?? 0 })); },
        get activeSessionKey() { return current.key; },
        get rendering() { return shell.scene?.sessionRendering; },
        activateSession: (key: string) => { const context = bank.byKey(key); if (context) openWorkspace(context); },
        stopSession: (key: string) => { const context = bank.byKey(key); if (context) requestStop(context); },
        resourceCard: (kind: import("./host-cards").ResourceKind, key = "directory") => cards.resourceCard(kind, key),
      },
    });
    Object.defineProperty(window, "rhineSsh", { configurable: true, get: () => client });
    if (import.meta.hot) import.meta.hot.dispose(() => {
      workspaceSettings.dispose(); tunnelPanel.dispose(); quickSearch.dispose(); health.dispose(); clearTimeout(catalogTimer); offBank(); overview.dispose(); shell.desktopModalScope?.dispose(); library.dispose(); eventAudio.dispose(); bank.dispose(); prompt.dispose(); audit.dispose(); hosts.dispose(); inspectionTicket++;
    });
  });

}
