import { createRollingClock } from "./rolling-clock";
import { InspectionOverlay } from "./inspection-overlay";
import { DocumentDecryption } from "./document-decryption";
import "./document-decryption.css";
import "./decryption.css";
import { escapeHtml } from "./html";
import { normalizeQuality, qualityPresets, type QualityPreset, type RenderQuality } from "./render-quality";
import { qualityMarkup, syncQualityUI } from "./quality-settings";
import { superPerformanceQuality, wallpaperQuality } from "./wallpaper-quality";
import "@kitlangton/rolling-number/styles.css";
import "./style.css";
import "./quality-settings.css";
import "./responsive.css";
import { viewportLayout, openingLayout } from "./viewport-layout";
import { assetUrl } from "./asset-url";
import { initPwa, pwaSettingsMarkup } from "./pwa";
import { initNativeShell } from "./native";
import { createRollingNumber, createRollingText } from "@kitlangton/rolling-number";
import { ArchiveScene } from "./scene";
import { ModelViewer } from "./model-viewer";
import { ContentTransition, SurfaceTransition } from "./ui-transitions";
import { HistoryNav, type AppScreen } from "./history-nav";
import { BootSequence } from "./boot";
import { loadBootWebfonts } from "./boot-lettering";
import { wrap, type ArchiveNavigation } from "./archive-loop";
import {
  records,
  categories,
  archiveColumns,
  columnFiles,
  fileLocation,
  archiveFiles,
  isActiveArchive,
} from "./data";
import { TerminalAudio } from "./audio";
import { audioSettingsMarkup } from "./audio-settings";
import { StartupGate } from "./startup";
import { isWallpaper, wallpaperHost, wallpaperFrame, type WallpaperProperties } from "./wallpaper";
import { isDesktop } from "./desktop";
import { isAndroid } from "./android";
import { hostLabel, hostSubtitle, SshHostCards } from "./ssh/host-cards";
import {
  hostDetailMarkup,
  hostLogMarkup,
  hostOverviewMarkup,
  hostSessionsMarkup,
  hostDirectoryMarkup,
  directorySessionsMarkup,
  type HostDetailData,
  type HostLiveFacts,
} from "./ssh/host-detail";
import type { SshClient, SshLaunchDescriptor } from "./ssh/client";
import type { SshTerminalPanel } from "./ssh/terminal";
import type { SshHostsPanel } from "./ssh/hosts-panel";
import type { SshPageMotion } from "./ssh/page-motion";
import type { SshSessionBank } from "./ssh/session-bank";
import type { SshLibrary } from "./ssh/library";
import "./startup.css";
import "./wallpaper.css";
import { Workbench } from "./workbench";
let workbench: Workbench | undefined;
import { ArchivePlayground } from "./archive-playground";
import { ARRAY_OPENING_END, openingShowsDetail } from "./wallpaper-opening";
import { paintTheme, themeSettingsMarkup } from "./theme-ui";
let playground: ArchivePlayground | undefined;
import { WallpaperEffects } from "./wallpaper-effects";
import { WallpaperBackground } from "./wallpaper-background";
let wallpaperEffects: WallpaperEffects | undefined;
/**
 * Desktop SSH: per-frame hook for the connection timeline. Installed only in
 * the desktop build; called before the scene updates so the reveal it feeds is
 * the one drawn this frame.
 */
let sshFrame: ((time: number) => void) | undefined;
let sshAfterFrame: (() => void) | undefined;
let sshTerminalPending = false;
let sshSurfaceActive = () => false;
let sshSurfaceBack = () => false;
/** Desktop SSH: the session terminal surface, when it has been created. */
let sshTerminal: SshTerminalPanel | undefined;
let closeSshTerminal: (() => void) | undefined;
/**
 * Desktop SSH: bring the session terminal back by hand. Given a slot, it is
 * projected onto that card's 3D terminal; without a model it falls back to
 * the conventional terminal surface.
 */
let openSshTerminal: (() => void) | undefined;
let closeSshAudit: (() => void) | undefined;
/** Desktop SSH: opens the host picker (assigned in the desktop block). */
let openSshHosts: () => void = () => {};
/** Desktop SSH: connect to a host alias (assigned in the desktop block). */
let connectHostAlias: (alias: string, newSession?: boolean) => void = () => {};
let openHostSession: (alias: string) => void = () => {};
let stopSshSession: () => void = () => {};
let switchSshSession: (direction: number) => void = () => {};
let sshBank: SshSessionBank | undefined;
let sshLibrary: SshLibrary | undefined;
let openSshShortcut: (id: string, force?: boolean) => void = () => {};
let sshOverview: import("./ssh/overview").SshOverview | undefined;
let desktopModalScope: import("./ssh/surface").SurfaceScope | undefined;
/** Desktop SSH: open a stored session record in the record surface. */
let openStoredRecord: (file: string) => void = () => {};
/** Desktop SSH: the blocking decision surface (host key, secret, failure). */
let sshPromptOpen = false;
let cancelSshPrompt: (() => void) | undefined;
/** Desktop SSH: the session record surface. */
let auditOpen = false;
let sshHosts: SshHostsPanel | undefined;
let sshDetailMotion: SshPageMotion | undefined;
let sshTabMotion: SshPageMotion | undefined;
let pendingSshDetailMotion = false;
let pruneSshHistory: () => void = () => {};
/**
 * Desktop SSH: the dedicated host column is registered before navigation.
 * Host archives share the original HUD and detail surfaces while authored
 * archives keep their own records and positions.
 */
const hostCards = isDesktop || isAndroid ? new SshHostCards(true) : undefined;
/** The session client, once the desktop layer has loaded. */
let sshClient: SshClient | undefined;
const hostAtCard = (card: number) => hostCards?.hostAt(card);
/**
 * Live state label for a bound card. Only the session's own target can be
 * anything but 未连接: there is one session at a time, so the label never
 * pretends two hosts are connected at once.
 */
function hostStateLabel(card: number): string {
  const host = hostAtCard(card);
  if (!host) return "";
  const client = sshBank?.forAlias(host.alias)?.client ?? sshClient;
  if (!client || client.target !== host.alias) return "SSH · 未连接";
  switch (client.status().phase) {
    case "resolving":
    case "connecting":
    case "handshake":
    case "hostkey":
    case "authenticating":
      return "SSH · 连接中";
    case "opening":
      return "SSH · 建立会话";
    case "interactive":
      return "SSH · 已连接";
    case "closed":
      return "SSH · 会话已结束";
    case "failed":
      return "SSH · 连接失败";
    default:
      return "SSH · 未连接";
  }
}

/**
 * Whether this card's host currently has a session. The terminal is reachable
 * from the moment a connection starts — watching the handshake is part of the
 * point — until the session has ended.
 */
function sessionLiveFor(card: number): boolean {
  const host = hostAtCard(card);
  const client = host ? sshBank?.forAlias(host.alias)?.client ?? sshClient : undefined;
  if (!host || !client?.target) return false;
  return client.target === host.alias && client.active;
}

/**
 * What the running session has proven so far, in the shape the card's existing
 * metadata grid wants. Empty until `ssh -v` says it (rule R3): the card keeps
 * showing what the config said until the connection itself has verified more.
 */
function verifiedFacts(client = sshClient): HostLiveFacts {
  if (!client?.target) return {};
  const facts = client.status().facts;
  return {
    address: facts.address?.value,
    cipher: facts.cipher?.value,
    authMethod: facts.authMethod?.value,
  };
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
import { logo, brandHeading } from "./brand";

// The desktop launcher verifies its Vite mode. Keeping this compile-time
// gate lets web and wallpaper builds omit the SSH terminal and native bridge.
// The web build exposes a safe, read-only SSH showcase.  It reuses the real
// workspace UI with fixture hosts, but never attempts to access a native SSH
// bridge (browsers cannot open the local ssh/PTY APIs).
const demoSsh = !isDesktop && !isAndroid && !isWallpaper;
const desktopShell = isDesktop || isAndroid || demoSsh;

$("#stage").innerHTML = `
  ${isDesktop ? '<div class="titlebar-drag" aria-hidden="true"></div>' : ""}
  <div id="three-scene" class="three-scene"></div>
  <div class="scene-atmosphere archive-atmosphere"></div>
  <div id="boot-background" class="boot-background"><svg viewBox="0 0 1920 1080" preserveAspectRatio="none"><g fill="none" stroke="#fff" stroke-width="3"><path d="M-210 705C-45 705 182 704 247 567C337 377 99 306 4 435S27 680 169 631C309 584 227 314 279 111S568-113 568-113"/><path d="M1560-80C1374 114 1671 168 1601 323S1371 367 1431 480S1692 666 1559 787S1329 886 1498 1130"/><circle cx="1450" cy="648" r="346"/><circle cx="1450" cy="648" r="348"/></g></svg></div>
  <header class="brand">${brandHeading}</header>
  <nav class="system-nav" aria-label="系统导航">
    ${desktopShell ? `<button data-action="ssh-hosts">主机总览 <span>↗</span></button>${demoSsh ? '<span class="demo-badge">SSH 演示模式</span>' : ""}` : ""}
    <button data-action="search"><span class="nav-glyph">⌕</span> ${desktopShell ? "WORKSPACE INDEX" : "ARCHIVE INDEX"} <span class="key">/</span></button>
    <button data-action="saved" aria-label="查看收藏档案" title="收藏档案">＋ SAVED <span id="saved-count">00</span></button>
    <button class="settings-button" data-action="settings" aria-label="系统设置" title="系统设置"><span class="settings-glyph" aria-hidden="true">◷</span><span class="settings-label">设置</span></button>
  </nav>
  <button id="skip" class="skip" data-action="skip">ENTER SYSTEM <span>↗</span></button>
  <section id="boot" class="boot" aria-label="系统启动">
    <div class="access-text">ACCESS</div>
    <div class="boot-logo">${logo}</div>
    <div class="auth-status"><span>▪</span> <span id="auth-message"></span><i></i></div>
    <div class="scan"><svg viewBox="0 0 1920 1080" aria-hidden="true"><g fill="none" stroke="#080a08" stroke-width="2" stroke-linecap="round"><path/><path stroke="#fff"/><path/><path/><path/><path/><circle class="orbit-dot" r="8" fill="#ed821b" stroke="none"/><circle class="orbit-dot" r="8" fill="#ed821b" stroke="none"/><circle class="scan-core" cx="960" cy="540" r="5" fill="#080a08" stroke="none"/></g></svg><span>PERMISSION AUTHORIZED</span></div>
    <div class="welcome"><div class="welcome-panel"></div><div class="welcome-heading">WELCOME TO</div><div class="welcome-company"><strong>RHINE LAB.LLC.</strong><strong class="welcome-highlight" aria-hidden="true">RHINE LAB.LLC.</strong></div><div class="welcome-database">INTERNAL DATABASE</div><div class="welcome-logo">${logo}</div></div>
  </section>
  <svg id="inspection-marks" viewBox="0 0 1920 1080" aria-hidden="true"><path id="inspection-lines"/><g id="inspection-corners"></g><circle id="inspection-point" r="1.8"/></svg>
  <div id="inspection-text" aria-hidden="true">CONFIDENTIALITY:<strong>GENERAL BUSINESS USE</strong></div>
  <section id="archive-ui" class="archive-ui" aria-label="档案选择">
    <div class="archive-callout"><div class="eyebrow">INTERNAL DATABASE <span>／</span> <span id="archive-category">机构档案</span></div><button class="file-title" data-action="open">FILE NUMBER: <span id="selected-id">X-<span id="selected-code">001</span></span><span class="file-open">↗</span></button><div class="callout-rule"><i></i></div><div class="file-summary"><span id="selected-title">莱茵生命</span><span id="selected-clearance">BUSINESS AREA</span></div><button class="read-file" data-action="open">ACCESS FILE <span>→</span></button>${desktopShell ? '<button class="archive-session" data-action="ssh-terminal" hidden>打开终端 <span>↗</span></button><p class="archive-pull-hint">点击选中模型读取，或按住向上抽出</p>' : ""}</div>
    <div id="hover-label" class="hover-label" hidden>X-<span id="hover-code">001</span> / <span id="hover-title"></span></div>
    <div class="archive-counter"><span class="tiny-label">ARCHIVE / SELECT</span><div><span id="selected-number">01</span><i>/</i><span class="count-total">12</span></div></div>
    <div class="archive-navigation"><button data-action="prev" aria-label="上一个档案">↑</button><div id="file-ticks" class="file-ticks"></div><button data-action="next" aria-label="下一个档案">↓</button></div>
    <div class="column-navigation"><button data-action="column-prev" aria-label="上一列">←</button><div><span id="column-number">COLUMN <span id="column-index">03</span> / ${String(archiveColumns.length).padStart(2, "0")}</span><strong id="column-name">机构档案</strong></div><button data-action="column-next" aria-label="下一列">→</button></div>
    <div class="archive-hint"><kbd>←</kbd> <kbd>→</kbd> 切换列 <span>／</span> <kbd>↑</kbd> <kbd>↓</kbd> 前后档案 <span>／</span> <kbd>ENTER</kbd> 读取</div>
  </section>
  <section id="detail-ui" class="detail-ui" aria-label="档案内容" hidden>
    <button class="back-button" data-action="back">← <span>ARCHIVE OVERVIEW</span><small>ESC</small></button>
    <div class="object-caption"><span id="object-id">NO.001</span><div>INTERNAL DATABASE</div><small>DRAG TO INSPECT <span>↔</span></small><button class="viewer-open" data-action="model-viewer">360° 查看文档模型 <span>↗</span></button></div>
    <article id="detail-content" class="detail-content"></article>
  </section>
  <div class="powered">POWERED BY <b>RHINE LAB</b><i></i></div>
    <footer class="system-footer"><span><i class="status-light"></i> ${desktopShell ? "SSH WORKSPACE" : "SESSION AUTHORIZED"}${demoSsh ? ' · 演示模式' : ''}${isWallpaper ? '<button type="button" class="three-toggle" data-action="toggle-three" aria-pressed="true" title="卸载三维模型，保留 2D 界面">3D 开启</button>' : ''}</span><span>${desktopShell ? "REMOTE SESSION" : "JOYCE MOORE"} <i>／</i> <span id="clock">00:00:00</span></span><button data-action="replay" title="重播启动流程">REINITIALIZE ↗</button></footer>
  <div id="pwa-update-notice" class="pwa-update-notice" role="status" hidden><span>新版本已就绪</span><button data-pwa-action="update">更新并重启 ↻</button></div>
  <div id="modal-root"></div><div id="toast" class="toast" role="status"></div>
  <div id="loading" class="loading"><div class="loading-mark">${logo}</div><span>CONNECTING TO INTERNAL DATABASE</span><i></i></div>
`;

$("#boot-background").insertAdjacentHTML(
  "beforeend",
  '<div class="boot-white"></div>',
);
const bootSequence = new BootSequence($("#stage"));
$("#viewport").insertAdjacentHTML("beforeend", '<button class="mobile-entry" data-action="skip">进入档案 <span>→</span></button>');

type Mode = "boot" | "archive" | "detail";
let mode: Mode = "boot",
  selected = 0,
  bootStart = 0,
  lastStep = "",
  ready = false;
let modal: "search" | "saved" | "settings" | null = null,
  searchQuery = "",
  filter = "全部档案";
let activeTab = "overview";
const reviewParams = new URLSearchParams(location.search);
let frozenTime =
  reviewParams.get("freeze") === "1"
    ? Number(reviewParams.get("time") ?? 0)
    : null;
if (reviewParams.get("review") === "1") {
  $("#stage").dataset.review = "true";
  window.addEventListener("message", (event) => {
    if (
      event.origin !== location.origin ||
      event.source !== window.parent ||
      event.data?.type !== "rhine-review-frame"
    )
      return;
    const t = Number(event.data.time);
    if (!Number.isFinite(t) || t < 0 || t >= 35) return;
    frozenTime = t;
    if (ready && mode !== "boot") setMode("boot");
  });
}
let toastTimer: ReturnType<typeof setTimeout>;
let previousFocus: HTMLElement | null = null;
const detailTransition = new SurfaceTransition($("#detail-ui"), undefined, 180, 180);
const tabTransition = new ContentTransition();
let modalTransition: SurfaceTransition | undefined;
let modalClosing = false;
let modalSiblings: { node: HTMLElement; inert: boolean }[] = [];
let pendingDetailFocus = false;
let bookmarkFeedback: Animation | undefined;
function readLocal<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}
const saved = new Set<string>(readLocal<string[]>("rhine-saved", []));
const storedPrefs = readLocal<Partial<{ sound: boolean; music: boolean; soundVolume: number; musicVolume: number; reduced: boolean; quality: boolean; rendering: RenderQuality; superPerformance: boolean; colorTheme: "light" | "dark" }>>("rhine-settings", {});
const prefs = {
  sound: true,
  music: storedPrefs.sound ?? true,
  soundVolume: .55,
  musicVolume: .5,
  reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
  quality: true,
  superPerformance: false,
  ...storedPrefs,
  rendering: normalizeQuality(storedPrefs.rendering, storedPrefs.quality !== false),
  colorTheme: storedPrefs.colorTheme === "dark" ? "dark" : "light",
};
paintTheme(prefs.colorTheme === "dark" ? 1 : 0);
const rollingMotion = {
  duration: 460,
  motionBlur: true,
  animated: !prefs.reduced,
};
const updateFooterClock = createRollingClock($("#clock"));
const numberOptions = {
  ...rollingMotion,
  locales: "en-US",
  format: { minimumIntegerDigits: 2, useGrouping: false },
};
const fileCounter = createRollingNumber($("#selected-number"), {
  ...numberOptions,
  value: 1,
});
const columnCounter = createRollingNumber($("#column-index"), {
  ...numberOptions,
  value: 3,
});
const codeOptions = {
  ...numberOptions,
  format: { minimumIntegerDigits: 3, useGrouping: false },
  value: 1,
};
const textOptions = {
  ...rollingMotion,
  transition: "direct" as const,
  stagger: "none" as const,
};
const selectionTitle = createRollingText($("#selected-title"), {
  ...textOptions,
  text: $("#selected-title").textContent ?? "",
});
const columnTitle = createRollingText($("#column-name"), {
  ...textOptions,
  text: $("#column-name").textContent ?? "",
});
const hoverTitle = createRollingText($("#hover-title"), { ...textOptions, text: "" });
const categoryTitle = createRollingText($("#archive-category"), {
  ...textOptions,
  text: $("#archive-category").textContent ?? "",
});
const clearanceTitle = createRollingText($("#selected-clearance"), {
  ...textOptions,
  text: $("#selected-clearance").textContent ?? "",
});
const rollingTitles = [selectionTitle, columnTitle, hoverTitle, categoryTitle, clearanceTitle];
const selectedCode = createRollingNumber($("#selected-code"), codeOptions);
const hoverCode = createRollingNumber($("#hover-code"), codeOptions);
const audio = new TerminalAudio();
let musicSuppressed = false;
function configureAudio() { audio.configure({ ...prefs, music: prefs.music && !musicSuppressed }); }
configureAudio();
const reviewEntry = reviewParams.has("scene") || reviewParams.has("time") || reviewParams.get("review") === "1";
let started = false;
const loading = $("#loading");
// The entry screen uses the actual viewport, including portrait phones; the
// reference animation still uses its calibrated 1920 x 1080 stage.
$("#viewport").append(loading);
$("#stage").inert = true;
$(".mobile-entry").inert = true;
const entry = !isWallpaper && !reviewEntry && (prefs.sound || prefs.music) ? new StartupGate({
  root: loading,
  unlock: () => audio.unlock(),
  cancel: () => audio.cancelEntry(),
  start: silent => completeStartup(silent),
}) : undefined;
if (entry) {
  audio.holdForEntry();
  if (prefs.music) void audio.prepareMusic().catch(() => { /* Entry offers retry. */ });
}
let audioPreview = false, audioPreviewRequest = 0;
let scene: ArchiveScene | undefined;
let threeState: "on" | "closing" | "off" | "loading" = "on";
let resumeCell: { lane: number; row: number } | undefined;
let resumeSelection = -1;
let viewer: ModelViewer | undefined;
/**
 * Android's back gesture, and the browser's own back button, as one level of
 * the app. Constructed here only because the state it reads is declared here;
 * `restore` cannot run until a screen has actually been entered.
 */
const historyNav = new HistoryNav(restoreScreen, !isDesktop && !isWallpaper && !isAndroid);
function restoreScreen(screen: AppScreen) {
  if (screen === "modal" && modal) closeModal();
  else if (screen === "viewer" && viewer?.isOpen) viewer.close();
  else if (screen === "detail" && mode === "detail") {
    setMode("archive");
    audio.play("back");
  }
}
/**
 * The one way out of a screen, shared by Escape and by a history pop so the two
 * cannot drift apart. Returns whether the press was consumed.
 */
function goBack(): boolean {
  if (isAndroid && sshSurfaceBack()) return true;
  if (modal) {
    closeModal();
    return true;
  }
  if (viewer?.isOpen) {
    viewer.close();
    return true;
  }
  if (isAndroid && sshPromptOpen) { cancelSshPrompt?.(); return true; }
  if (isAndroid && auditOpen) { closeSshAudit?.(); return true; }
  if (isAndroid && (sshTerminal?.isOpen || sshTerminalPending)) { closeSshTerminal?.(); return true; }
  if (isAndroid && sshOverview?.editing) { sshOverview.showPage("hosts"); return true; }
  if (mode === "detail" || (mode === "boot" && ready)) {
    audio.play(mode === "detail" ? "back" : "ui-tick");
    setMode("archive");
    return true;
  }
  return false;
}
const accessLog: { id: string; time: string }[] = [];
const columnMemory = archiveColumns.map((_, lane) => columnFiles(lane)[0]);
function recordAccess() {
  accessLog.unshift({
    id: records[selected].id,
    time: new Date().toLocaleTimeString("en-GB"),
  });
}
function saveAudioPrefs() {
  try {
    localStorage.setItem("rhine-settings", JSON.stringify(prefs));
  } catch {}
  configureAudio();
}
function superPerformanceEnabled() { return isWallpaper ? wallpaperHost()?.properties.superperformance?.value === true : prefs.superPerformance; }
function effectiveRenderQuality() { return superPerformanceEnabled() ? superPerformanceQuality : prefs.rendering; }
function savePrefs() {
  saveAudioPrefs();
  if (prefs.reduced) {
    sshDetailMotion?.finish();
    sshTabMotion?.finish();
    sshHosts?.finishMotion();
    rollingTitles.forEach(title => title.finish());
    detailTransition.finish();
    modalTransition?.finish();
    tabTransition.cancel();
    bookmarkFeedback?.cancel();
  }
  scene?.setReduced(prefs.reduced);
  scene?.setTheme(prefs.colorTheme === "dark", prefs.reduced || !started);
  // The window caption is drawn by the OS, so it cannot follow a CSS variable.
  if (desktopShell)
    window.rhineDesktop?.theme?.(prefs.colorTheme === "dark" ? "dark" : "light");
  document.querySelectorAll<HTMLElement>("[data-color-theme]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.colorTheme === prefs.colorTheme)));
  scene?.setSuperPerformance(superPerformanceEnabled());
  viewer?.setSuperPerformance(superPerformanceEnabled());
  scene?.setQuality(effectiveRenderQuality());
  viewer?.setQuality(effectiveRenderQuality());
  syncQualityUI(prefs.rendering);
  updateQualitySummary();
  fileCounter.update({ animated: !prefs.reduced && mode === "archive" });
  rollingTitles.forEach(title => title.update({ animated: !prefs.reduced && mode === "archive" }));
  columnCounter.update({ animated: !prefs.reduced && mode === "archive" });
  selectedCode.update({ animated: !prefs.reduced && mode === "archive" });
  hoverCode.update({ animated: !prefs.reduced && mode === "archive" });
  $("#stage").classList.toggle("reduce-motion", prefs.reduced);
  syncWallpaperBackground();
}
let previousLayout = "";
function fit() {
  const stage = $("#stage");
  const viewport = $("#viewport");
  const coarse = matchMedia("(pointer: coarse)").matches;
  const reference = reviewParams.has("time") || reviewParams.get("review") === "1";
  const { width, height, scale, kind } = mode === "boot" && !reference
    ? openingLayout(viewport.clientWidth, viewport.clientHeight)
    : viewportLayout(viewport.clientWidth, viewport.clientHeight, coarse, mode === "boot");
  stage.style.width = `${width}px`;
  stage.style.height = `${height}px`;
  stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
  stage.dataset.layout = kind;
  stage.dataset.touch = String(coarse);
  viewport.dataset.mobileBoot = String(mode === "boot" && (coarse || viewport.clientWidth < 1100));
  stage.style.setProperty("--stage-scale", String(scale));
  stage.style.setProperty("--opening-width", `${width}px`);
  stage.style.setProperty("--opening-height", `${height}px`);
  stage.style.setProperty("--opening-scan-scale", String(Math.min(1, width / 1920)));
  stage.dataset.openingPortrait = String(width < height);
  // The software keyboard resizes dialogs without recomposing the 3D scene.
  const visible = window.visualViewport;
  const stageTop = (viewport.clientHeight - height * scale) / 2;
  stage.style.setProperty("--modal-top", `${Math.max(0, (visible?.offsetTop ?? 0) - stageTop) / scale}px`);
  stage.style.setProperty("--modal-height", `${Math.min(height, (visible?.height ?? viewport.clientHeight) / scale)}px`);
  $("#viewport").style.setProperty("--scale", String(scale));
  const marks = document.querySelector("#inspection-marks");
  marks?.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const layoutKey = JSON.stringify([width, height, scale, kind, devicePixelRatio]);
  if (layoutKey !== previousLayout) {
    previousLayout = layoutKey;
    scene?.resize();
    viewer?.resize();
  }
  updateQualitySummary();
  // Re-measure line covers and tab underline after wrapping changes.
  requestAnimationFrame(() => {
    documentDecryption.refresh();
    const tab = document.querySelector<HTMLElement>(".detail-tabs button.active");
    const indicator = document.querySelector<HTMLElement>(".tab-indicator");
    if (tab && indicator) indicator.style.transform = `translateX(${tab.offsetLeft}px) scaleX(${tab.offsetWidth})`;
  });
}
window.addEventListener("resize", fit);
window.visualViewport?.addEventListener("resize", fit);
window.visualViewport?.addEventListener("scroll", fit);
matchMedia("(pointer: coarse)").addEventListener("change", fit);
fit();
$("#file-ticks").innerHTML = columnFiles(fileLocation(selected).lane)
  .map(
    (index) => `<button data-select="${index}"></button>`,
  )
  .join("");
const fileTicks = [...$("#file-ticks").querySelectorAll<HTMLButtonElement>("button")];

function syncArchiveChrome(collapsed = sshOverview?.isCollapsed ?? false) {
  const expanded = desktopShell && !collapsed && mode === "archive";
  $("#stage").dataset.sshOverviewExpanded = String(expanded);
  const hidden = mode !== "archive" || Boolean(workbench?.enabled) || expanded;
  const blocked = Boolean(modal) || sshSurfaceActive();
  $("#archive-ui").inert = hidden || blocked;
  $("#archive-ui").setAttribute("aria-hidden", String(hidden));
  $(".system-nav").inert = mode === "boot" || blocked || expanded;
}

function setMode(next: Mode) {
  if (workbench?.enabled && next === "detail") next = "archive";
  const previousMode = mode;
  if (next !== "detail" && previousMode === "detail") sshHosts?.unmount();
  if (next === "detail" && previousMode === "archive") sshOverview?.showPage("hosts", undefined, false);
  rollingTitles.forEach(title => title.update({ animated: !prefs.reduced && next === "archive" }));
  if (next !== "archive") {
    rollingTitles.forEach(title => title.finish());
    hoverCode.finish();
    $("#hover-label").hidden = true;
  }
  if (next === "detail" && mode !== "detail") recordAccess();
  mode = next;
  // The archive is the base of the stack, not a level in it: entering the
  // detail is one level deeper, and leaving it gives that level back.
  if (previousMode !== "detail" && next === "detail") historyNav.enter("detail");
  else if (previousMode === "detail" && next !== "detail") historyNav.leave("detail");
  syncWallpaperBackground();
  audio.setScene(next);
  if (next !== "boot" && audioPreview) {
    audioPreview = false;
    audioPreviewRequest++;
    configureAudio();
  }
  $("#stage").dataset.mode = next;
  workbench?.syncVisibility();
  if (previousMode !== next) fit();
  $("#boot").inert = next !== "boot";
  $("#boot").setAttribute("aria-hidden", String(next !== "boot"));
  syncArchiveChrome();
  $(".system-footer").inert = next === "boot" || Boolean(modal);
  if (next === "detail") {
    if (desktopShell) $(".back-button span").textContent = sshOverview?.isCollapsed ? "返回主机阵列" : "返回主机总览";
    if (previousMode !== "detail") detailTransition.show(prefs.reduced);
  } else if (previousMode === "detail" || (next === "boot" && !$("#detail-ui").hidden)) {
    pendingDetailFocus = false;
    tabTransition.cancel();
    detailTransition.hide(prefs.reduced || next === "boot");
    if (!modal && next === "archive") $(".read-file").focus({ preventScroll: true });
  }
  $("#detail-ui").inert = next !== "detail" || Boolean(modal);
  scene?.setMode(next === "boot" ? "hidden" : next);
  if (next !== "boot") {
    bootSequence.reset();
    $(".file-title").firstChild!.textContent = "FILE NUMBER: ";
    $("#stage").dataset.boot = "done";
  }
  if (next === "detail" && previousMode !== "detail") {
    renderDetail();
    pendingDetailFocus = true;
    if (!scene) {
      $("#detail-content").style.opacity = "1";
      $("#detail-content").style.translate = "0 0";
      $("#detail-content").inert = false;
    }
  }
}
function select(index: number, navigation?: ArchiveNavigation, silent = false) {
  if (!isActiveArchive(index)) return;
  selected = index;
  columnMemory[fileLocation(selected).lane] = selected;
  if (mode === "detail") setMode("archive");
  activeTab = "overview";
  scene?.select(selected, navigation);
  updateSelection(navigation);
  const columnMove = navigation && "axis" in navigation && navigation.axis === "lane";
  if (!silent) audio.play(columnMove ? "column" : "tick", columnMove ? navigation.direction * .45 : 0);
}
function stepFile(direction: number) {
  const files = columnFiles(fileLocation(selected).lane);
  if (files.length < 2) return;
  select(
    files[(files.indexOf(selected) + direction + files.length) % files.length],
    { axis: "row", direction },
  );
}
function stepColumn(direction: number) {
  const lane = fileLocation(selected).lane;
  const next = wrap(lane + direction, archiveColumns.length);
  select(columnMemory[next], { axis: "lane", direction });
}
function updateSelection(navigation?: ArchiveNavigation) {
  const r = records[selected];
  const host = hostAtCard(selected);
  const { lane } = fileLocation(selected);
  const files = columnFiles(lane);
  $("#selected-id").firstChild!.textContent = `${r.id.slice(0, 2)}`;
  selectionTitle.update({ text: host ? hostLabel(host) : r.title, animated: !prefs.reduced && mode === "archive" });
  clearanceTitle.update({ text: host ? hostStateLabel(selected) : r.clearance, animated: !prefs.reduced && mode === "archive" });
  categoryTitle.update({ text: host ? hostSubtitle(host) || r.category : r.category, animated: !prefs.reduced && mode === "archive" });
  const direction =
    navigation && "axis" in navigation
      ? navigation.direction > 0
        ? "up"
        : "down"
      : "auto";
  selectedCode.update({
    value: Number(r.id.slice(2)),
    animated: !prefs.reduced && mode === "archive",
    direction,
  });
  fileCounter.update({
    value: files.indexOf(selected) + 1,
    animated: !prefs.reduced && mode === "archive",
    direction:
      navigation && "axis" in navigation && navigation.axis === "row"
        ? direction
        : "auto",
  });
  $(".count-total").textContent = String(files.length).padStart(2, "0");
  columnCounter.update({
    value: lane + 1,
    animated: !prefs.reduced && mode === "archive",
    direction:
      navigation && "axis" in navigation && navigation.axis === "lane"
        ? direction
        : "auto",
  });
  columnTitle.update({ text: archiveColumns[lane], animated: !prefs.reduced && mode === "archive" });
  $<HTMLButtonElement>('[data-action="column-prev"]').disabled = false;
  $<HTMLButtonElement>('[data-action="column-next"]').disabled = false;
  const firstTick = Math.max(0, Math.min(files.indexOf(selected) - 3, files.length - fileTicks.length));
  fileTicks.forEach((button, slot) => {
    const index = files[firstTick + slot];
    button.hidden = index === undefined;
    if (index === undefined) { delete button.dataset.select; return; }
    const record = records[index];
    const tickHost = hostAtCard(index);
    const label = tickHost ? `主机 ${hostLabel(tickHost)}` : `档案 ${record.id} ${record.title}`;
    button.dataset.select = String(index);
    button.setAttribute("aria-label", `选择${label}`);
    button.title = `${record.id} · ${tickHost ? hostLabel(tickHost) : record.title}`;
    button.classList.toggle("selected", index === selected);
    button.classList.toggle("host", Boolean(tickHost));
    button.setAttribute("aria-pressed", String(index === selected));
  });
  $("#saved-count").textContent = String(saved.size).padStart(2, "0");
  if (desktopShell) {
    $(".read-file").firstChild!.textContent = host ? "查看主机详情 " : "读取档案 ";
    const session = host ? sshBank?.forAlias(host.alias) : undefined;
    const entry = $(".archive-session");
    entry.hidden = !session?.client.target;
    entry.firstChild!.textContent = session?.client.active ? "打开终端 " : "查看终端输出 ";
  }
}
function replayBoot(forcePreview = false) {
  if (!ready) return;
  closeModal(() => replayBootAfterModal(forcePreview));
}
function replayBootAfterModal(forcePreview: boolean) {
  bootStart = performance.now() / 1000 - 1.76;
  frozenTime = null;
  lastStep = "";
  // The opening has no back stack: whatever was open before it is gone.
  historyNav.reset();
  setMode(prefs.reduced && !forcePreview ? "archive" : "boot");
  audio.restartBoot();
  scene?.select(0);
  selected = 0;
  updateSelection();
  if (!forcePreview) audio.play("ui-tick");
}
function openFile() {
  if (!ready) return;
  closeModal(() => {
    setMode("detail");
    audio.play("open");
    const shortcut = hostCards?.resourceAt(selected);
    if (shortcut?.kind === "shortcut" && !shortcut.directory) openSshShortcut(shortcut.key);
  });
}
function toggleSaved() {
  const id = records[selected].id;
  if (saved.has(id)) saved.delete(id);
  else saved.add(id);
  try {
    localStorage.setItem("rhine-saved", JSON.stringify([...saved]));
  } catch {}
  $("#saved-count").textContent = String(saved.size).padStart(2, "0");
  const button = $<HTMLButtonElement>('[data-action="bookmark"]');
  const added = saved.has(id);
  button.firstChild!.textContent = added ? "− REMOVE FROM SAVED" : "＋ SAVE ARCHIVE";
  button.querySelector("span")!.textContent = added ? "已收藏" : "收藏档案";
  button.setAttribute("aria-pressed", String(added));
  bookmarkFeedback?.cancel();
  if (!prefs.reduced) bookmarkFeedback = button.animate(
    [{ backgroundColor: "#67634c" }, { backgroundColor: "#252820" }],
    { duration: 220, easing: "ease-out" },
  );
  audio.play("confirm");
  notify(saved.has(id) ? "档案已加入收藏" : "已取消收藏");
}
function renderDetail() {
  tabTransition.cancel();
  sshHosts?.unmount();
  sshLibrary?.unmount();
  sshDetailMotion?.cancel();
  const r = records[selected];
  $("#object-id").textContent = r.id.startsWith("X-") ? "NO." + r.id.slice(2) : r.id.replace("-", ".");
  const host = hostAtCard(selected);
  const directory = hostCards?.isDirectory(selected);
  const content = $("#detail-content");
  const resource = hostCards?.resourceAt(selected);
  if (desktopShell) $(".object-caption > small").textContent = host && sshBank?.forAlias(host.alias)
    ? "点击模型打开终端 · 拖动检查 ↔" : "拖动检查模型 ↔";
  content.classList.toggle("ssh-detail", Boolean(resource));
  content.classList.toggle("ssh-directory", Boolean(directory));
  if (resource && resource.kind !== "host") {
    content.setAttribute("tabindex", "-1");
    if (sshLibrary) sshLibrary.mount(content, selected);
    else content.innerHTML = '<p class="host-loading">正在读取工作区…</p>';
    documentDecryption.reset(content, true);
    for (const child of content.children) (child as HTMLElement).dataset.sshReveal = "";
    pendingSshDetailMotion = true;
    return;
  }
  if (host || directory) {
    // Host archives reuse the detail skeleton and show local connection data.
    if (hostDetailAlias !== (host?.alias ?? "")) hostDetailData = { records: null, latestLog: null };
    content.innerHTML = host ? hostDetailMarkup({
      host,
      cardId: r.id,
      position: `${String(hostCards!.bound.findIndex(entry => entry.alias === host.alias) + 1).padStart(2, "0")} / ${String(hostCards!.bound.length).padStart(2, "0")}`,
      state: hostStateLabel(selected),
      configPath: (host.source === "saved" ? hostCards?.profilesPath : hostCards?.configPath) ?? "",
      live: sessionLiveFor(selected),
      retained: Boolean(sshBank?.forAlias(host.alias)),
      facts: sshBank?.forAlias(host.alias) ? verifiedFacts(sshBank.forAlias(host.alias)!.client) : {},
    }) : hostDirectoryMarkup(hostCards!.bound, hostCards!.loaded);
    $("#detail-content").setAttribute("tabindex", "-1");
    // These are already-readable local connection settings, not secret output.
    documentDecryption.reset($("#detail-content"), true);
    setTab(activeTab, false);
    for (const child of content.children) (child as HTMLElement).dataset.sshReveal = "";
    pendingSshDetailMotion = true;
    void refreshHostDetailData(host?.alias ?? "");
    return;
  }
  pendingSshDetailMotion = false;
  $("#detail-content").innerHTML = `
  <div class="detail-kicker"><span>FILE ${r.id}</span><span>${escapeHtml(r.clearance)}</span></div>
  <h2>${escapeHtml(r.en)}</h2><div class="detail-title-cn">${escapeHtml(r.title)}<span>${escapeHtml(r.category)}</span></div>
  <div class="detail-rule"></div>
  <dl class="metadata"><div><dt>DEPARTMENT / 科室</dt><dd>${escapeHtml(r.department)}</dd></div><div><dt>COLLECTION / 编目范围</dt><dd>${escapeHtml(r.date)}</dd></div><div><dt>RELATED / 相关人物</dt><dd>${escapeHtml(r.lead)}</dd></div><div><dt>STATUS / 状态</dt><dd><i></i>${r.clearance === "RESTRICTED" ? "目录访问" : "已归档 · 可读取"}</dd></div></dl>
  <div class="detail-tabs" role="tablist"><button id="tab-overview" class="active" role="tab" aria-controls="tab-panel" aria-selected="true" data-tab="overview">01 <span>概述</span></button><button id="tab-notes" role="tab" aria-controls="tab-panel" aria-selected="false" data-tab="notes">02 <span>研究记录</span></button><button id="tab-history" role="tab" aria-controls="tab-panel" aria-selected="false" data-tab="history">03 <span>访问日志</span></button><i class="tab-indicator" aria-hidden="true"></i></div>
  <div id="tab-panel" class="tab-panel" role="tabpanel">${overview()}</div>
  <div class="detail-actions"><button class="solid-button" data-action="bookmark">${saved.has(r.id) ? "− REMOVE FROM SAVED" : "＋ SAVE ARCHIVE"}<span>${saved.has(r.id) ? "已收藏" : "收藏档案"}</span></button><a class="export-button" href="${assetUrl(`archives/RHINE-LAB-${r.id}.txt`)}" download="RHINE-LAB-${r.id}.txt" aria-label="导出 ${r.id} 档案">EXPORT <span>↓</span></a></div>
  <div class="detail-footnote"><a href="${escapeHtml(r.source)}" target="_blank" rel="noopener">设定参考 ↗</a><span>${String(selected + 1).padStart(3, "0")} / ${String(archiveFiles().length).padStart(3, "0")}</span></div>`;
  $("#detail-content").setAttribute("tabindex", "-1");
  $('[data-action="bookmark"]').setAttribute("aria-pressed", String(saved.has(r.id)));
  documentDecryption.reset($("#detail-content"), prefs.reduced || !scene || scene.decryptionFrame.phase === "clear");
  setTab(activeTab, false);
}
function overview() {
  return `<div class="panel-label">ABSTRACT / 摘要</div><p>${escapeHtml(records[selected].abstract)}</p>`;
}
function setTab(tab: string, sound = true) {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>(".detail-tabs [data-tab]")];
  if (!tabs.some(button => button.dataset.tab === tab)) tab = "overview";
  if (sound && tab === activeTab) return;
  activeTab = tab;
  tabs.forEach((b) => {
    const active = (b as HTMLElement).dataset.tab === tab;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", String(active));
    b.setAttribute("tabindex", active ? "0" : "-1");
  });
  const tabButton = document.querySelector<HTMLButtonElement>(
    `.detail-tabs [data-tab="${tab}"]`,
  );
  const panel = document.querySelector<HTMLElement>("#tab-panel");
  const indicator = document.querySelector<HTMLElement>(".tab-indicator");
  // Host configuration and records use the same tabs as ordinary archives.
  if (!tabButton || !panel || !indicator) return;
  const r = records[selected];
  const host = hostAtCard(selected);
  const directory = hostCards?.isDirectory(selected);
  const wasLoading = Boolean(panel.querySelector(".host-loading"));
  sshHosts?.unmount();
  sshTabMotion?.cancel();
  $("#detail-content").dataset.sshPage = host || directory ? tab : "";
  const actions = $("#detail-content").querySelector<HTMLElement>(":scope > .detail-actions");
  if (actions) actions.hidden = Boolean((host || directory) && tab === "config");
  indicator.style.transition = sound ? "" : "none";
  indicator.style.transform = `translateX(${tabButton.offsetLeft}px) scaleX(${tabButton.offsetWidth})`;
  panel.setAttribute("aria-labelledby", tabButton.id);
  const workspace = directory && tab === "overview" ? "list" : (host || directory) && tab === "config" ? host ? "config" : "connect" : null;
  if (workspace) {
    panel.replaceChildren();
    if (sshHosts) sshHosts.mount(panel, workspace, host);
    else panel.innerHTML = '<p class="host-loading">正在读取主机档案…</p>';
  } else panel.innerHTML = directory ? directorySessionsMarkup(hostDetailData) : host
    ? tab === "overview"
      ? hostOverviewMarkup(host, hostDetailData)
      : tab === "notes"
        ? hostSessionsMarkup(host, hostDetailData)
        : hostLogMarkup(host, hostDetailData)
    : tab === "overview"
      ? overview()
      : tab === "notes"
        ? `<div class="panel-label">RESEARCH NOTES / 研究记录</div><ol class="research-notes">${r.findings.map((f, i) => `<li><span>${String(i + 1).padStart(2, "0")}</span>${escapeHtml(f)}</li>`).join("")}</ol>`
        : `<div class="panel-label">ACCESS LOG / 本次访问</div>${accessLog
            .filter((entry) => entry.id === r.id)
            .slice(0, 4)
            .map(
              (entry) =>
                `<div class="log-row"><span>${entry.time}</span><span>JOYCE MOORE</span><b>READ AUTHORIZED</b></div>`,
            )
            .join(
              "",
            )}<p class="log-note">本次会话已通过身份验证。档案内容以当前终端可访问范围展示。</p>`;
  panel.scrollTop = 0;
  documentDecryption.refresh();
  if (sound) {
    if (host || directory) {
      if (!workspace) sshTabMotion?.reveal(panel, prefs.reduced);
    } else tabTransition.reveal(panel, prefs.reduced);
    audio.play("ui-tick");
  } else if (wasLoading && !workspace && (host || directory)) sshTabMotion?.reveal(panel, prefs.reduced);
}
/**
 * Host detail data: stored sessions and the newest raw event log, loaded
 * through the desktop bridge. `hostDetailGeneration` invalidates stale fills
 * when the user moves to another card before the reads come back.
 */
let hostDetailData: HostDetailData = { records: null, latestLog: null };
let hostDetailAlias = "";
let hostDetailGeneration = 0;
async function refreshHostDetailData(alias: string) {
  const generation = ++hostDetailGeneration;
  hostDetailAlias = alias;
  hostDetailData = { records: null, latestLog: null };
  const bridge = window.rhineDesktop?.records;
  if (!bridge) {
    hostDetailData = { records: [], latestLog: [] };
    patchHostDetail();
    return;
  }
  const list = await bridge.list();
  if (generation !== hostDetailGeneration) return;
  if (!list.ok) {
    hostDetailData = { records: [], recordsError: list.error ?? "无法读取会话记录", latestLog: [] };
    patchHostDetail();
    return;
  }
  // A session's target is the alias as typed, optionally with a user@ prefix.
  const mine = alias ? list.records.filter((record) => record.target === alias || record.target.endsWith(`@${alias}`)) : list.records;
  hostDetailData.records = mine;
  patchHostDetail();
  if (!alias) return;
  const latestWithLog = mine.find((record) => record.logPath);
  if (!latestWithLog) {
    hostDetailData.latestLog = [];
    patchHostDetail();
    return;
  }
  const log = await bridge.log(latestWithLog.logPath);
  if (generation !== hostDetailGeneration) return;
  hostDetailData.latestLog = log.ok ? (log.lines ?? []) : [];
  hostDetailData.logTruncated = Boolean(log.truncated);
  patchHostDetail();
}
/** Re-render the active tab if the detail surface still shows this host. */
function patchHostDetail() {
  if (mode !== "detail") return;
  if (sshHosts?.isOpen) return;
  if ((hostAtCard(selected)?.alias ?? (hostCards?.isDirectory(selected) ? "" : null)) !== hostDetailAlias) return;
  setTab(activeTab, false);
}
/** Patch the two live state labels without rebuilding the whole surface. */
function patchHostState(card: number) {
  const label = hostStateLabel(card);
  const kicker = $("#host-state");
  if (kicker) kicker.textContent = label;
  const side = $("#host-state-side");
  if (side) side.textContent = label;
  const live = sessionLiveFor(card);
  if (desktopShell) $(".object-caption > small").textContent = sshBank?.forAlias(hostAtCard(card)?.alias ?? "")
    ? "点击模型打开终端 · 拖动检查 ↔" : "拖动检查模型 ↔";
  const action = $("#host-connect");
  if (action) {
    action.dataset.action = live ? "ssh-terminal" : "ssh-connect";
    action.innerHTML = live
      ? "↗ OPEN TERMINAL<span>打开这次会话</span>"
      : "⇄ CONNECT<span>连接这台主机</span>";
  }
  const disconnect = $("#host-disconnect"), retained = $("#host-last-terminal");
  if (disconnect) disconnect.hidden = !live;
  if (retained) retained.hidden = live || !sshBank?.forAlias(hostAtCard(card)?.alias ?? "");
}
function notify(message: string) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 2600);
}

function openModal(kind: NonNullable<typeof modal>) {
  if (!ready) return;
  if (!modal && !desktopModalScope) {
    previousFocus = document.activeElement as HTMLElement;
    modalSiblings = [...$("#stage").children]
      .filter((node): node is HTMLElement => node instanceof HTMLElement && node.id !== "modal-root")
      .map((node) => ({ node, inert: node.inert }));
    modalSiblings.forEach(({ node }) => (node.inert = true));
  }
  modalClosing = false;
  modal = kind;
  historyNav.enter("modal");
  desktopModalScope?.enter();
  searchQuery = "";
  filter = "全部档案";
  audio.play("page-open");
  renderModal();
}
function closeModal(afterClose?: () => void) {
  if (!modal) {
    afterClose?.();
    return;
  }
  if (modalClosing) return;
  // Consumed as the close begins, not when its animation ends: a back press
  // arriving during the transition must not fire a second close.
  historyNav.leave("modal");
  modalClosing = true;
  audio.play("page-close");
  modalTransition!.hide(prefs.reduced, () => {
    modal = null;
    modalClosing = false;
    $("#modal-root").replaceChildren();
    modalTransition = undefined;
    if (desktopModalScope) desktopModalScope.leave();
    else {
      modalSiblings.forEach(({ node, inert }) => (node.inert = inert));
      modalSiblings = [];
      $("#archive-ui").inert = mode !== "archive" || Boolean(workbench?.enabled);
      $("#detail-ui").inert = mode !== "detail";
      previousFocus?.focus({ preventScroll: true });
    }
    afterClose?.();
  });
}
function renderModal() {
  if (!modal) return;
  modalTransition?.dispose();
  $("#modal-root").innerHTML =
    `<div class="modal-backdrop"><section class="terminal-modal ${modal === "settings" ? "settings-modal" : ""}" role="dialog" aria-modal="true" aria-label="${modal === "settings" ? "系统设置" : modal === "saved" ? "收藏档案" : "档案检索"}"><div class="modal-top"><span>RHINE LAB / ${modal === "settings" ? "SYSTEM PREFERENCES" : "ARCHIVE DIRECTORY"}</span><button data-action="close-modal" aria-label="关闭窗口">CLOSE <span>×</span></button></div>${modal === "settings" ? settingsMarkup() : `<h2>${modal === "saved" ? "SAVED ARCHIVES" : "ARCHIVE INDEX"}<small>${modal === "saved" ? "收藏档案" : "内部档案检索"}</small></h2><div class="search-field"><span>⌕</span><input id="archive-search" type="search" autocomplete="off" placeholder="输入档案编号、名称或科室" aria-label="检索档案"/><span class="key">ESC</span></div><div class="category-filters">${categories.map((c, i) => `<button data-filter="${escapeHtml(c)}" class="${i === 0 ? "active" : ""}">${escapeHtml(c)}</button>`).join("")}</div><div class="result-header"><span>FILE / 档案</span><span>DEPARTMENT / 科室</span><span>ACCESS</span></div><div id="search-results" class="search-results"></div><div class="modal-bottom"><span id="result-count"></span><span>INTERNAL DATABASE <i>●</i> CONNECTED</span></div>`}</section></div>`;
  const backdrop = $(".modal-backdrop");
  backdrop.hidden = true;
  modalTransition = new SurfaceTransition(backdrop, $(".terminal-modal"));
  modalTransition.show(prefs.reduced);
  if (modal === "settings") updateQualitySummary();
  if (modal !== "settings") {
    renderResults();
    requestAnimationFrame(() => {
      if (backdrop.isConnected && !modalClosing) $("#archive-search").focus();
    });
  } else
    requestAnimationFrame(() => {
      if (backdrop.isConnected && !modalClosing) $('[data-action="close-modal"]').focus();
    });
  $("#modal-root")
    .querySelector(".modal-backdrop")
    ?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeModal();
    });
}
function renderResults() {
  const results = archiveFiles()
    .map((i) => ({ r: records[i], i, host: hostAtCard(i) }))
    .filter(
      ({ r, host }) =>
        (modal !== "saved" || saved.has(r.id)) &&
        (filter === "全部档案" || r.category === filter) &&
        (host
          ? `${r.id} ${hostLabel(host)} ${host.hostname} ${host.user} ${r.title} ${r.en} ${r.department} ${r.lead}`
          : `${r.id} ${r.title} ${r.en} ${r.department} ${r.lead}`
        )
          .toLowerCase()
          .includes(searchQuery.toLowerCase()),
    );
  $("#search-results").innerHTML = results.length
    ? results
        .map(
          ({ r, i, host }) =>
            `<button class="result-row" data-result="${i}"><span class="result-name"><b>${r.id}</b><span>${escapeHtml(host ? hostLabel(host) : r.title)}<small>${escapeHtml(host ? hostSubtitle(host) || "SSH 主机" : r.en)}</small></span>${saved.has(r.id) ? "<i>＋</i>" : ""}</span><span>${escapeHtml(host ? "SSH 主机" : r.department)}</span><span>${host ? "SSH HOST" : r.clearance === "RESTRICTED" ? "CATALOG ONLY" : "AUTHORIZED"} <i>↗</i></span></button>`,
        )
        .join("")
    : `<div class="empty-results"><span>∅</span><strong>${modal === "saved" && !searchQuery ? "尚无收藏档案" : "没有匹配的档案"}</strong><p>${modal === "saved" && !searchQuery ? "读取档案时，选择 SAVE ARCHIVE 将其保存在此处。" : "尝试其他名称、档案编号，或切换科室分类。"}</p><button data-action="reset-search">${modal === "saved" ? "查看全部档案 →" : "重置检索 →"}</button></div>`;
  $("#result-count").textContent =
    `${String(results.length).padStart(2, "0")} RECORDS FOUND`;
}
function updateQualitySummary() {
  const summary = document.querySelector("#quality-summary");
  if (!summary) return;
  if (!scene) { summary.textContent = "3D 已关闭 · 三维模型与渲染资源已释放"; return; }
  const canvas = scene.renderer.domElement;
  const metrics = JSON.parse(canvas.parentElement?.dataset.renderQuality ?? "{}");
  summary.textContent = `${superPerformanceEnabled() ? "超级性能模式已启用 · 画质设置暂被覆盖，关闭后恢复 · " : ""}实际渲染 ${canvas.width} × ${canvas.height} · ${effectiveRenderQuality().antialias === "smaa" ? "SMAA" : "原始抗锯齿"} · 纹理 ${metrics.anisotropy ?? 1}×${metrics.limited ? " · 已达到缓冲上限" : ""}`;
}
function motionSettingsMarkup() {
  return `<div id="motion-preference-note" class="motion-preference-note"><p>${prefs.reduced
    ? `当前已减少动态效果。${matchMedia("(prefers-reduced-motion: reduce)").matches ? "系统也请求减少动画，可仅为本站启用完整动效。" : "关闭上方开关可恢复完整动效。"}`
    : "当前使用完整动效。"}</p>${prefs.reduced ? '<button data-action="enable-motion">启用完整动效并重播 ↻</button>' : ""}</div>`;
}
function settingsMarkup() {
  return `<h2>SYSTEM SETTINGS<small>终端偏好设置</small></h2><p class="settings-intro">JOYCE MOORE <span>·</span> SESSION AUTHORIZED</p>${isWallpaper ? '<p class="wallpaper-settings-note">每次启动都会读取 Wallpaper Engine 中的设置。在此修改仅对当前运行生效，无法持久保存；如需保留，请在 Wallpaper Engine 的壁纸属性中调整。</p>' : ""}<div class="settings-list">${themeSettingsMarkup(prefs.colorTheme === "dark")}${!isWallpaper ? `<label><div><strong>SUPER PERFORMANCE</strong><span>降低三维画质和渲染分辨率，保留完整动效；关闭后恢复原画质</span></div><input type="checkbox" data-pref="superPerformance" ${prefs.superPerformance ? "checked" : ""}/><i class="toggle"></i></label>` : ""}${workbench?.settingsMarkup() ?? ""}${audioSettingsMarkup(prefs)}<label><div><strong>REDUCED MOTION</strong><span>跳过开机动画，简化选档、镜头和文字动效</span></div><input type="checkbox" data-pref="reduced" ${prefs.reduced ? "checked" : ""}/><i class="toggle"></i></label></div>${motionSettingsMarkup()}${qualityMarkup(prefs.rendering)}${pwaSettingsMarkup()}<div class="settings-shortcuts">${isWallpaper ? '<span>DESKTOP CONTROLS</span><p>拖动阵列或点击界面按钮浏览档案。桌面模式下，方向键与滚轮可能无法传入壁纸。</p>' : `<span>KEYBOARD CONTROLS</span><p><kbd>←</kbd><kbd>→</kbd> 切列 <kbd>↑</kbd><kbd>↓</kbd> 选档 <kbd>ENTER</kbd> 读取${desktopShell ? "·连接" : ""} <kbd>/</kbd> 检索 <kbd>ESC</kbd> 返回${desktopShell ? ' <kbd>CTRL</kbd>+<kbd>SHIFT</kbd>+<kbd>S</kbd> 主机列表 <kbd>CTRL</kbd>+<kbd>SHIFT</kbd>+<kbd>E</kbd> 收起终端' : ""}</p>`}</div><div class="settings-bottom">${!isWallpaper && document.fullscreenEnabled ? '<button data-action="fullscreen">FULLSCREEN <span>↗</span></button>' : ''}<button data-action="restart">REINITIALIZE SYSTEM <span>↻</span></button></div><div class="modal-bottom"><span>ANALYSIS OS / 1.0 · 使用 MiSans 字体（小米） <a href="${assetUrl("fonts/MiSans-license.pdf")}" target="_blank" rel="noopener">字体许可</a></span><span>POWERED BY RHINE LAB</span></div>`;
}

document.addEventListener("input", (e) => {
  const slider = e.target as HTMLInputElement;
  if (slider.dataset.quality) {
    const output = document.querySelector<HTMLOutputElement>(`[data-quality-output="${slider.dataset.quality}"]`);
    if (output) output.value = `${slider.value}%`;
  }
  const volume = e.target as HTMLInputElement;
  if (volume.dataset.volume === "musicVolume" || volume.dataset.volume === "soundVolume") {
    prefs[volume.dataset.volume] = Number(volume.value) / 100;
    volume.closest("label")?.querySelector("output")?.replaceChildren(`${volume.value}%`);
    saveAudioPrefs();
  }
  if ((e.target as HTMLElement).id === "archive-search") {
    searchQuery = (e.target as HTMLInputElement).value;
    renderResults();
  }
});
document.addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement;
  if (el.id === "quality-preset" && Object.hasOwn(qualityPresets, el.value)) {
    prefs.rendering = { ...qualityPresets[el.value as QualityPreset] };
    savePrefs();
  } else if (el.dataset.quality) {
    const key = el.dataset.quality as keyof RenderQuality;
    prefs.rendering = normalizeQuality({ ...prefs.rendering, [key]: key === "antialias" ? el.value : Number(el.value) });
    savePrefs();
  }
  if (el.dataset.pref) {
    const key = el.dataset.pref;
    if (key === "sound" || key === "music" || key === "reduced" || key === "quality" || key === "superPerformance") prefs[key] = el.checked;
    if (key === "sound" || key === "music") saveAudioPrefs(); else savePrefs();
    if (key === "reduced") $("#motion-preference-note").outerHTML = motionSettingsMarkup();
    audio.play("confirm");
  }
});
document.addEventListener("click", (e) => {
  const themeButton = (e.target as Element).closest<HTMLElement>("[data-color-theme]");
  if (themeButton) { prefs.colorTheme = themeButton.dataset.colorTheme === "dark" ? "dark" : "light"; savePrefs(); return; }
  if (!started) return;
  if (modalClosing) return;
  const el = (e.target as Element).closest<HTMLElement>("button");
  if (!el) return;
  if (el.dataset.select) {
    select(Number(el.dataset.select));
    return;
  }
  if (el.dataset.result) {
    const index = Number(el.dataset.result);
    closeModal(() => {
      select(index);
      openFile();
    });
    return;
  }
  if (el.dataset.filter) {
    filter = el.dataset.filter;
    document
      .querySelectorAll("[data-filter]")
      .forEach((b) =>
        b.classList.toggle(
          "active",
          (b as HTMLElement).dataset.filter === filter,
        ),
      );
    renderResults();
    return;
  }
  if (el.dataset.tab) {
    setTab(el.dataset.tab);
    return;
  }
  if (el.dataset.recordFile) {
    openStoredRecord(el.dataset.recordFile);
    return;
  }
  const action = el.dataset.action;
  if (action === "toggle-three") { void toggleThree(); return; }
  if (action === "ssh-connect" || action === "ssh-new-session") {
    const host = hostAtCard(selected);
    if (host) connectHostAlias(host.alias, action === "ssh-new-session");
    return;
  }
  if (action === "ssh-hosts") { openSshHosts(); return; }
  if (action === "ssh-new") { setTab("config"); return; }
  if (action === "ssh-refresh") { void sshHosts?.refresh(); return; }
  if (action === "ssh-prune") { pruneSshHistory(); return; }
  if (action === "ssh-terminal") {
    const host = hostAtCard(selected);
    if (host) openHostSession(host.alias);
    else openSshTerminal?.();
    return;
  }
  if (action === "ssh-disconnect") {
    stopSshSession();
    return;
  }
  if (action === "sound-preview") audio.play("confirm");
  if (action === "skip") {
    setMode("archive");
    audio.play("confirm");
  }
  if (action === "prev") stepFile(-1);
  if (action === "next") stepFile(1);
  if (action === "column-prev") stepColumn(-1);
  if (action === "column-next") stepColumn(1);
  if (action === "open") openFile();
  if (action === "model-viewer" && mode === "detail" && scene) {
    const activeScene = scene;
    // Safari does not always focus a button when it is tapped. Capture the
    // actual opener so closing the modal reliably restores the right control.
    el.focus({ preventScroll: true });
    viewer ??= new ModelViewer($("#stage"), () => { historyNav.leave("viewer"); audio.setScene(mode); audio.play("page-close"); }, (sound) => audio.play(sound === "tick" ? "ui-tick" : sound));
    historyNav.enter("viewer");
    audio.setScene("viewer");
    viewer.setSuperPerformance(superPerformanceEnabled());
    viewer.setQuality(effectiveRenderQuality());
    scene.finishDecryption();
    viewer.open(
      records[selected].id,
      records[selected].title,
      () => activeScene.createAssemblyModel(),
      prefs.reduced,
    );
    audio.play("page-open");
  }
  if (action === "back") {
    setMode("archive");
    audio.play("back");
  }
  if (action === "search" || action === "saved" || action === "settings") {
    el.focus({ preventScroll: true });
    openModal(action);
  }
  if (action === "close-modal") closeModal();
  if (action === "bookmark") toggleSaved();
  if (action === "reset-search") {
    modal = "search";
    searchQuery = "";
    filter = "全部档案";
    renderModal();
  }
  if (action === "replay" || action === "restart") {
    replayBoot();
  }
  if (action === "enable-motion") {
    prefs.reduced = false;
    savePrefs();
    replayBoot();
  }
  if (action === "fullscreen" && document.fullscreenEnabled) {
    if (document.fullscreenElement) void document.exitFullscreen();
    else
      void document.documentElement
        .requestFullscreen()
        .catch(() => notify("请使用浏览器的全屏快捷键 F11"));
  }
});
document.addEventListener("keydown", (e) => {
  if (!started) return;
  if (desktopShell && e.ctrlKey && e.key === "Tab" && !modal && !auditOpen && !viewer?.isOpen) {
    e.preventDefault();
    switchSshSession(e.shiftKey ? -1 : 1);
    return;
  }
  // A pending question outranks everything, including the terminal: it is a
  // security decision, and the panel handles its own Escape.
  if (sshPromptOpen) return;
  // The session record is a reading surface; Escape closes it.
  if (auditOpen) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeSshAudit?.();
    }
    return;
  }
  // The session terminal is also reachable by hand. It opens itself when ssh
  // reports an interactive session, but a surface the user cannot summon is a
  // surface they are stuck without — so this chord works from anywhere.
  if (desktopShell && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "t") {
    e.preventDefault();
    // In the session's own card this is just opening the file; only a host
    // without a card to belong to gets the floating surface.
    const host = hostAtCard(selected);
    if (host && sshBank?.forAlias(host.alias)) openHostSession(host.alias);
    else openSshTerminal?.();
    return;
  }
  // The session terminal owns the keyboard while it is open. Escape in
  // particular must reach the shell (vim, less, readline all need it), so the
  // panel is closed with a chord instead — the app has no other Ctrl/Alt/Meta
  // shortcut to collide with.
  if (sshTerminal?.isOpen) {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "e") {
      e.preventDefault();
      closeSshTerminal?.();
    }
    return;
  }
  if (sshTerminalPending) {
    if (e.key === "Escape" || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "e")) {
      e.preventDefault(); closeSshTerminal?.();
    }
    return;
  }
  if (sshSurfaceActive()) return;
  // Host picker, from anywhere the array is on screen.
  if (desktopShell && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "s") {
    e.preventDefault();
    openSshHosts();
    return;
  }
  // Stow or restore the overview sheet. The array underneath stays live either
  // way, so this is the keyboard's version of the edge tab.
  if (
    desktopShell &&
    e.ctrlKey &&
    e.shiftKey &&
    e.key.toLowerCase() === "h" &&
    mode === "archive" &&
    !modal
  ) {
    e.preventDefault();
    sshOverview?.toggleCollapsed();
    audio.play("ui-tick");
    return;
  }
  if (viewer?.isOpen) return;
  if (playground?.active && !modal) {
    if (e.key === "Escape") { e.preventDefault(); playground.stop(); }
    else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", "/"].includes(e.key) && !(e.target instanceof HTMLButtonElement)) e.preventDefault();
    return;
  }
  if (modalClosing) {
    e.preventDefault();
    return;
  }
  const typing = e.target instanceof Element && Boolean(e.target.closest("input,select,textarea,summary,[contenteditable=true]"));
  if (e.key === "Escape") {
    // Same path as a history pop (see `goBack`), so Escape and the Android back
    // gesture can never disagree about what "back" means.
    goBack();
    return;
  }
  if (modal && e.key === "Tab") {
    const focusables = [
      ...$("#modal-root").querySelectorAll<HTMLElement>(
        'button,input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]',
      ),
    ];
    const visible = focusables.filter(el => el.getClientRects().length > 0);
    const first = visible[0],
      last = visible.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
    return;
  }
  if (typing || modal || !ready) return;
  if (
    (e.target as HTMLElement).dataset.tab &&
    ["ArrowLeft", "ArrowRight"].includes(e.key)
  ) {
    e.preventDefault();
    const tabs = [...document.querySelectorAll<HTMLButtonElement>(".detail-tabs [data-tab]")].map(button => button.dataset.tab!);
    setTab(
      tabs[wrap(tabs.indexOf(activeTab) + (e.key === "ArrowRight" ? 1 : -1), tabs.length)],
    );
    $<HTMLButtonElement>(`[data-tab="${activeTab}"]`).focus();
    return;
  }
  if (e.key === "/") {
    e.preventDefault();
    if (mode === "boot") setMode("archive");
    openModal("search");
  }
  if (e.key === "ArrowLeft" && mode !== "boot") {
    e.preventDefault();
    stepColumn(-1);
  }
  if (e.key === "ArrowRight" && mode !== "boot") {
    e.preventDefault();
    stepColumn(1);
  }
  if (["ArrowUp", "ArrowDown"].includes(e.key) && mode !== "boot") {
    e.preventDefault();
    stepFile(e.key === "ArrowUp" ? -1 : 1);
  }
  if (
    e.key === "Enter" &&
    (document.activeElement === document.body ||
      document.activeElement?.id === "detail-content" ||
      ["prev", "next", "column-prev", "column-next"].includes(
        (document.activeElement as HTMLElement)?.dataset.action ?? "",
      ) ||
      (document.activeElement as HTMLElement)?.dataset.select)
  ) {
    e.preventDefault();
    if (mode === "boot") setMode("archive");
    else if (mode === "archive") openFile();
    else if (mode === "detail") {
      // Enter again on a host card connects — the same key that opened it.
      const host = hostAtCard(selected);
      if (host) connectHostAlias(host.alias);
    }
  }
});

const ease = (t: number) => {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
};
function bootFrame(t: number) {
  if (isWallpaper && !scene && frozenTime === null && t >= 21.9) {
    setMode("archive");
    return undefined;
  }
  if (isWallpaper && frozenTime === null && t >= ARRAY_OPENING_END &&
      !openingShowsDetail(wallpaperHost()?.properties.openingdetail?.value, !!workbench?.enabled)) {
    setMode("archive");
    return undefined;
  }
  audio.updateBoot(t, frozenTime !== null);
  const motion = bootSequence.update(t);
  if (workbench?.enabled && frozenTime === null) {
    const end = openingShowsDetail(wallpaperHost()?.properties.openingdetail?.value, true) ? 35 : ARRAY_OPENING_END;
    if (t > end - .35) $(".powered").style.opacity = String(1 - ease((t - end + .35) / .35));
  }
  let step: string = motion.step;
  if (t >= 22) {
    step = "array";
  }
  if (t >= 25.68) {
    step = "select";
  }
  if (t >= 28.3) {
    step = "inspect";
  }
  if (step !== lastStep) {
    $("#stage").dataset.boot = step;
    lastStep = step;
  }
  $(".file-title").firstChild!.textContent =
    step === "array"
      ? "SELECTING FILES...".slice(0, Math.max(0, Math.floor((t - 21.94) * 18)))
      : "FILE NUMBER: ";
  $("#stage").style.setProperty(
    "--entry-opacity",
    String(ease((t - 21.9) / 0.13)),
  );
  $(".callout-rule").style.transform = `scaleX(${ease((t - 22.08) / 0.9)})`;
  const reveal = ease((t - 22) / 0.4),
    lift = ease((t - 26) / 1.8),
    zoom = 0.55 * ease((t - 27.3) / 1.65) + 0.45 * ease((t - 29.0) / 5.0);
  if (t >= 35) {
    setMode("detail");
    return undefined;
  }
  return { reveal, lift, zoom, time: t };
}

const inspectionOverlay = new InspectionOverlay();
const documentDecryption = new DocumentDecryption();
// A newly opened archive can introduce another font shard. Re-measure its
// redaction lines after font swap while retaining the current reveal progress.
document.fonts.addEventListener("loadingdone", () => documentDecryption.refresh());

let lastTime = 0,
  frameCount = 0,
  frameStart = performance.now(),
  fps = 0;
function frame(ms: number) {
  if (!wallpaperFrame(ms)) { requestAnimationFrame(frame); return; }
  if (document.hidden) { requestAnimationFrame(frame); return; }
  workbench?.tick();
  const time = ms / 1000;
  const theme = scene?.themeAmount ?? (prefs.colorTheme === "dark" ? 1 : 0);
  paintTheme(theme);
  viewer?.setTheme(theme);
  playground?.tick(time);
  const cinema =
    mode === "boot" && ready
      ? bootFrame(frozenTime ?? time - bootStart)
      : undefined;
  wallpaperEffects?.update(time, prefs.reduced);
  sshFrame?.(time);
  // The calibrated 2D opening fully covers the scene until array entry.
  if (!viewer?.isOpen && (!cinema || cinema.time >= 21.9)) scene?.update(time, cinema);
  sshAfterFrame?.();
  sshOverview?.setVisible(mode === "archive" && ready, Boolean(modal) || sshSurfaceActive());
  if (desktopShell) syncArchiveChrome();
  if (pendingSshDetailMotion && mode === "detail" && (!scene || scene.detailVisibility >= .1)) {
    pendingSshDetailMotion = false;
    sshDetailMotion?.reveal($("#detail-content"), prefs.reduced);
  }
  viewer?.update(time);
  if (threeState === "closing" && scene?.presentationHidden) releaseThree();
  playground?.position();
  if (scene && mode === "detail") {
    documentDecryption.update(time, scene.decryptionFrame, prefs.reduced);
    $("#detail-content").style.opacity = String(scene.detailVisibility * (1 - scene.sessionDeckFocus));
    $("#detail-content").style.translate =
      `0 ${(1 - scene.detailVisibility) * 18}px`;
    $("#detail-content").inert = scene.detailVisibility < 0.1 || scene.sessionDeckFocus > .05 || sshSurfaceActive();
    if (pendingDetailFocus && scene.detailVisibility >= 0.1 && scene.sessionDeckFocus < .01 && !modal && !viewer?.isOpen && !sshSurfaceActive() && !sshTerminalPending) {
      $("#detail-content").focus({ preventScroll: true });
      pendingDetailFocus = false;
    }
  }
  $("#stage").style.setProperty("--detail-shade", String(mode === "boot" ? 0 : scene?.detailVisibility ?? 0));
  const currentScene = scene;
  if (currentScene) inspectionOverlay.render(currentScene.decryptionFrame,
    (x, y) => currentScene.projectCard(x, y), Boolean(cinema));
  if (Math.floor(time) !== lastTime) {
    lastTime = Math.floor(time);
    updateFooterClock(new Date(), !prefs.reduced);
  }
  frameCount++;
  if (ms - frameStart > 1000) {
    fps = (frameCount * 1000) / (ms - frameStart);
    frameStart = ms;
    frameCount = 0;
    $("#three-scene").dataset.fps = String(Math.round(fps));
    $("#three-scene").dataset.renderStats = JSON.stringify(scene?.getStats() ?? { loaded: false, drawCalls: 0, triangles: 0 });
  }
  requestAnimationFrame(frame);
}
function bindScene(scene: ArchiveScene, cell?: { lane: number; row: number }) {
    scene.onPreviewCommit = (index, cell) => { if (mode === "archive" && !modal && !sshSurfaceActive()) select(index, { cell }, true); };
    scene.select(selected, cell ? { cell } : undefined);
    scene.onSelect = (i, cell) => {
      if (mode !== "archive" || modal || viewer?.isOpen) return;
      select(i, cell ? { cell } : undefined);
    };
    if (desktopShell) {
      scene.renderer.domElement.setAttribute("aria-label", "三维主机阵列，拖动或滚轮浏览；点击选中模型或向上抽出读取详情");
      scene.onOpen = (index, cell) => {
        if (modal || viewer?.isOpen || sshSurfaceActive() || sshTerminalPending) return;
        if (mode === "archive" && sshOverview?.isCollapsed) {
          if (index !== selected) select(index, { cell });
          openFile();
        } else if (mode === "detail" && index === selected) {
          const host = hostAtCard(selected);
          if (host && sshBank?.forAlias(host.alias)) openHostSession(host.alias);
          else if (hostCards?.resourceAt(selected)?.kind === "shortcut") openSshShortcut(hostCards.resourceAt(selected)!.key, true);
        }
      };
    }
    scene.onNavigate = (axis, direction) => {
      if (mode !== "archive" || modal || viewer?.isOpen) return;
      if (axis === "lane") stepColumn(direction);
      else stepFile(direction);
    };
    scene.onHover = (i) => {
      const label = $("#hover-label");
      if (i === null) {
        label.hidden = true;
        hoverCode.finish();
        hoverTitle.finish();
        return;
      }
      const animated = !prefs.reduced && mode === "archive";
      const hoverHost = hostAtCard(i);
      label.firstChild!.textContent = records[i].id.slice(0, 2);
      hoverCode.update({
        value: Number(records[i].id.slice(2)),
        animated: !label.hidden && animated,
      });
      hoverTitle.update({
        text: hoverHost ? `${hostLabel(hoverHost)} · ${hostStateLabel(i).replace("SSH · ", "")}` : records[i].title,
        animated: !label.hidden && animated,
      });
      label.hidden = false;
      // Prepare the first visible value so the next hover can animate immediately.
      hoverCode.update({ animated });
      hoverTitle.update({ animated });
    };
}
function syncThreeButton() {
  $("#stage").dataset.threeState = threeState;
  syncWallpaperBackground();
  const button = document.querySelector<HTMLButtonElement>('[data-action="toggle-three"]');
  if (!button) return;
  button.textContent = threeState === "loading" ? "3D 载入中…" : threeState === "closing" ? "3D 关闭中…" : threeState === "off" ? "3D 关闭" : "3D 开启";
  button.disabled = threeState === "loading";
  button.setAttribute("aria-pressed", String(threeState === "on"));
  button.title = threeState === "off" ? "重新载入三维模型" : threeState === "closing" ? "取消关闭，恢复三维画面" : "卸载三维模型，保留 2D 界面";
}
function releaseThree() {
  if (!scene) return;
  resumeCell = { ...scene.getStats().selectedCell }; resumeSelection = selected;
  viewer?.dispose(); viewer = undefined;
  scene.dispose(); scene = undefined;
  if (mode === "detail") {
    $("#detail-content").style.opacity = "1";
    $("#detail-content").style.translate = "0 0";
    $("#detail-content").inert = false;
    documentDecryption.reset($("#detail-content"), true);
  }
  threeState = "off"; syncThreeButton();
  $("#hover-label").hidden = true;
  delete $("#three-scene").dataset.renderQuality;
  updateQualitySummary();
}
async function toggleThree() {
  if (!isWallpaper || !ready || threeState === "loading") return;
  if (threeState === "closing") {
    scene?.setPresentationVisible(true, prefs.reduced);
    threeState = "on"; syncThreeButton(); return;
  }
  if (scene) {
    playground?.stop();
    threeState = "closing"; syncThreeButton();
    scene.setPresentationVisible(false, prefs.reduced);
    if (prefs.reduced) releaseThree();
    return;
  }
  threeState = "loading"; syncThreeButton();
  let next: ArchiveScene | undefined;
  try {
    next = new ArchiveScene($("#three-scene"));
    next.renderer.domElement.style.opacity = "0";
    next.setPresentationVisible(false, true);
    await next.load();
    next.setMode(mode === "detail" ? "detail" : "archive");
    bindScene(next, resumeSelection === selected ? resumeCell : undefined);
    next.revealImmediately();
    scene = next;
    scene.setTheme(prefs.colorTheme === "dark", true);
    scene.setArchiveCoverage(wallpaperHost()?.properties.archivecoverage?.value === "extra");
    savePrefs();
    scene.setPresentationVisible(true, prefs.reduced);
    threeState = "on"; syncThreeButton();
  } catch (error) {
    next?.dispose(); scene = undefined;
    threeState = "off"; syncThreeButton();
    notify("三维模型载入失败，请点击 3D 关闭重试。");
    console.error(error);
  }
}

async function start() {
  try {
    if (isWallpaper) await window.rhineWallpaperPropertiesReady;
    if (!isWallpaper || wallpaperHost()?.properties.load3donstartup?.value !== false) {
      scene = new ArchiveScene($("#three-scene"));
      scene.setTheme(prefs.colorTheme === "dark", true);
      scene.setArchiveCoverage(wallpaperHost()?.properties.archivecoverage?.value === "extra");
    } else {
      threeState = "off";
      syncThreeButton();
    }
    await Promise.all([
      scene?.load(),
      loadBootWebfonts(),
      // With unicode-range faces, preload the opening's actual characters,
      // not every font shard. Other archive text loads on demand.
      document.fonts.load("300 20px MiSans", "ACCESS WELCOME TO INTERNAL DATABASE"),
      document.fonts.load("400 20px MiSans", "身份信息确认请求已接收开始处理权限验证通过欢迎访问莱茵生命内部资料档案编号保密级别商业区选择档案：0123456789 JOYCE MOORE"),
      document.fonts.load("600 20px MiSans", "SYNTHESIZE INFORMATION ANALYSIS OS"),
      document.fonts.load("700 20px MiSans", "RHINE LAB WELCOME TO INTERNAL DATABASE"),
    ]);
    if (scene) bindScene(scene);
    savePrefs();
    ready = true;
    select(0);
    if (entry) entry.ready();
    else {
      if (isWallpaper) {
        // CEF allows automatic audio; never block the visual on audio policy or decoding.
        await Promise.race([audio.unlock(), new Promise(resolve => setTimeout(resolve, 3000))]);
      }
      completeStartup(false);
    }
  } catch (error) {
    console.error(error);
    $("#loading").innerHTML =
      '<div class="error-state"><strong>CONNECTION INTERRUPTED</strong><p>三维档案资源未能载入。请确认浏览器已启用硬件加速，然后重新连接。</p><button>RECONNECT →</button></div>';
    $("#loading button").addEventListener("click", () => location.reload());
  }
}
function completeStartup(silent: boolean) {
  if (started || !ready) return;
  started = true;
  if (silent) {
    prefs.sound = false;
    prefs.music = false;
    saveAudioPrefs();
  }
  audio.releaseEntry();
  audio.restartBoot();
  const fade = prefs.reduced ? 0 : 600;
  bootStart = performance.now() / 1000 - (reviewParams.has("time") ? Number(reviewParams.get("time")) : 1.76);
  if (!reviewParams.has("time")) bootStart += fade / 1000;
  setMode("boot");
  if (reviewParams.get("scene") === "archive" || (prefs.reduced && !reviewParams.has("time"))) setMode("archive");
  if (reviewParams.get("scene") === "detail") setMode("detail");
  if (isWallpaper && wallpaperHost()?.properties.boot?.value === false) setMode("archive");
  $("#stage").inert = false;
  $(".mobile-entry").inert = false;
  loading.classList.add("loaded");
  loading.inert = true;
  setTimeout(() => {
    const restoreFocus = loading.contains(document.activeElement) || document.activeElement === document.body;
    loading.remove();
    if (entry && restoreFocus) {
      const skip = $("#skip");
      const target = mode === "boot" ? skip.getClientRects().length ? skip : $(".mobile-entry") : $(".read-file");
      target.focus({ preventScroll: true });
    }
  }, fade);
  requestAnimationFrame(frame);
  // Do not compete with entry audio/font downloads. Full offline installation
  // begins after startup is complete and remains atomic.
  setTimeout(() => void initPwa(notify), 1500);
  // A no-op outside the Android shell; it answers the system back button with
  // the same `goBack` Escape and a browser pop take.
  if (isAndroid) void initNativeShell(goBack, () => sshBank?.sessions.some(session => session.client.active || !!session.recovery && session.recovery !== "自动重连已停止" && !session.manualStop) ?? false).catch(error => notify(`安卓导航初始化失败：${error instanceof Error ? error.message : String(error)}`));
}
updateSelection();
const customBackground = isWallpaper ? new WallpaperBackground($("#stage"), notify) : undefined;
function syncWallpaperBackground(retry = false) {
  customBackground?.update(wallpaperHost()?.properties ?? {}, mode !== "boot" && (threeState === "off" || threeState === "loading"), prefs.reduced, retry);
}
if (isWallpaper) {
  const apply = (properties: WallpaperProperties) => {
    const theme = properties.colortheme?.value;
    if (theme === "light" || theme === "dark") prefs.colorTheme = theme;
    scene?.setArchiveCoverage(properties.archivecoverage?.value === "extra" || wallpaperHost()?.properties.archivecoverage?.value === "extra");
    for (const key of ["sound", "music", "reduced"] as const)
      if (typeof properties[key]?.value === "boolean") prefs[key] = properties[key].value as boolean;
    for (const key of ["soundVolume", "musicVolume"] as const) {
      const value = properties[key.toLowerCase()]?.value;
      if (typeof value === "number" && Number.isFinite(value)) prefs[key] = Math.max(0, Math.min(1, value / 100));
    }
    const qualityProperties = { ...wallpaperHost()?.properties, ...properties };
    if (Object.keys(properties).some(key => key === "renderquality" || key.startsWith("quality")))
      prefs.rendering = wallpaperQuality(qualityProperties, prefs.rendering);
    savePrefs();
    if (properties.customwallpaperfile || properties.customwallpaper?.value === true) syncWallpaperBackground(true);
    if (properties.boot?.value === false && started && mode === "boot") setMode("archive");
    // Keep an already-open settings surface in sync without replacing focused controls.
    document.querySelectorAll<HTMLInputElement>("[data-pref]").forEach(input => {
      const key = input.dataset.pref as "sound" | "music" | "reduced";
      if (key in prefs) input.checked = prefs[key];
    });
    for (const key of ["soundVolume", "musicVolume"] as const) {
      const input = document.querySelector<HTMLInputElement>(`[data-volume="${key}"]`);
      if (input) { input.value = String(Math.round(prefs[key] * 100)); input.closest("label")?.querySelector("output")?.replaceChildren(`${input.value}%`); }
    }
  };
  window.addEventListener("rhine-wallpaper-properties", event => apply((event as CustomEvent<WallpaperProperties>).detail));
  let pausedAt: number | undefined;
  const pause = () => {
    const paused = wallpaperHost()?.paused ?? false;
    if (paused && pausedAt === undefined) pausedAt = performance.now();
    if (!paused && pausedAt !== undefined) {
      if (started && mode === "boot") bootStart += (performance.now() - pausedAt) / 1000;
      pausedAt = undefined;
    }
    audio.setHostPaused(paused);
  };
  window.addEventListener("rhine-wallpaper-pause", pause);
  apply(wallpaperHost()?.properties ?? {});
  pause();
}
if (isWallpaper) {
  workbench = new Workbench($("#stage"), () => {
    if (ready && mode !== "boot") setMode("archive");
  }, lane => {
    if (ready && !modal) select(columnMemory[lane]);
  });
  playground = new ArchivePlayground($("#stage"), () => scene,
    () => ({ enabled: !!workbench?.enabled && mode === "archive" && ready, paused: Boolean(modal) || modalClosing || Boolean(wallpaperHost()?.paused) || document.hidden, reduced: prefs.reduced }),
    value => { musicSuppressed = value; configureAudio(); }, () => audio.play("tick"));
  wallpaperEffects = new WallpaperEffects($("#stage"), () => scene);
  document.addEventListener("click", event => {
    const button = (event.target as Element).closest<HTMLElement>("[data-workbench-mode]");
    if (button) closeModal(() => { workbench!.setEnabled(button.dataset.workbenchMode === "workbench"); });
  });
}
void start();
// Deterministic review controls: the running application, never a video surrogate.
Object.assign(window, {
  rhine: {
    // The review button supplies a real user activation. Preferences stay local to this preview.
    playBootPreview: async (music = false) => {
      if (!ready || !navigator.userActivation.isActive) return false;
      const request = ++audioPreviewRequest;
      audioPreview = true;
      audio.configure({ ...prefs, sound: true, music });
      const unlocked = await audio.unlock();
      if (request !== audioPreviewRequest) return false;
      if (!unlocked) {
        audioPreview = false;
        configureAudio();
        return false;
      }
      replayBoot(true);
      return true;
    },
    seek: (t: number) => {
      setMode("boot");
      bootStart = performance.now() / 1000 - t;
      lastStep = "";
    },
    archive: () => setMode("archive"),
    detail: () => openFile(),
    select: (i: number) => select(i),
    stats: () => ({
      ...scene?.getStats(),
      threeState,
      fps: Math.round(fps),
      mode,
      ready,
      startup: started ? "started" : entry?.phase ?? "loading",
      motion: { reduced: prefs.reduced, systemReduced: matchMedia("(prefers-reduced-motion: reduce)").matches },
      bootTime: mode === "boot" ? started ? (frozenTime ?? performance.now() / 1000 - bootStart) + 5 : 6.76 : null,
      selected: records[selected].id,
      selectedIndex: selected,
      saved: [...saved],
      audio: audio.stats(),
      wallpaper: isWallpaper ? wallpaperHost() : null,
    }),
  },
});
// Desktop host: the ssh session layer. Created at module scope (not inside
// start()) so an automation surface exists even while the entry gate is still
// holding the app, and loaded dynamically so web/wallpaper bundles stay free of
// terminal code they never run.
if (desktopShell) {
  $("#stage").dataset.sshWorkspace = "true";
  void import("./ssh/session-bank").then(async ({ SshSessionBank }) => {
    if (isAndroid) await import("./ssh/android/bridge").then(module => module.initAndroidBridge());
    type WorkspaceSession = import("./ssh/session-bank").WorkspaceSession;
    const bank = new SshSessionBank($("#stage"), {
      close: session => { if (session === current) close(); },
      audit: session => { activateContext(session, false); openAudit(); },
      reconnect: session => { void reconnect(session); },
    });
    sshBank = bank;
    let current = bank.active;
    let client = current.client;
    let services = current.services;
    let panel = current.panel;
    const { sshPreferences } = await import("./ssh/preferences");
    const openedArchives = new Set<string>();
    let openWorkspacePreferences = () => openModal("settings");
    let openQuickSearch = () => {};
    let cancelRecovery = (_session: WorkspaceSession) => {};
    sshClient = client;
    const { hasSshSurface, backSshUtility, SurfaceScope } = await import("./ssh/surface");
    desktopModalScope = new SurfaceScope($("#stage"), $("#modal-root"), $("#viewport"));
    $("#modal-root").classList.add("ssh-settings-root");
    sshSurfaceActive = () => hasSshSurface($("#stage"));
    sshSurfaceBack = () => backSshUtility($("#stage"));
    let terminalRequested = false;
    let terminalClosing = false;
    let interactiveGeneration = -1;
    let restoreTerminalFocus = false;
    sshTerminal = panel;

    /** Closing the enlarged terminal returns to its host, retaining the session. */
    const close = (feedback = true, destination: "host" | "overview" | "inspect" | "stay" = "host") => {
      if (feedback && (terminalRequested || panel.isOpen)) audio.play("ssh-collapse");
      // A navigation away from an inspection must also cancel a pending
      // reassembly, or its completion would reopen the terminal over that page.
      if (destination !== "inspect" && (deckInspecting || deckReassembling)) {
        deckInspecting = false;
        deckReassembling = false;
        deck?.setExploded(false, true);
        syncDeckTools();
      }
      terminalRequested = false;
      sshTerminalPending = false;
      terminalClosing = panel.isOpen || panel.isClosing;
      if (destination !== "inspect") {
        revealed = true;
        current.view.revealed = true;
      }
      const closing = current;
      const closingMode = mode, closingCard = selected;
      panel.hide(prefs.reduced, () => {
        if (closing !== current) return;
        terminalClosing = false;
        if (destination === "inspect" || destination === "stay" || terminalRequested || sshPromptOpen || auditOpen) return;
        // A later navigation owns the page, even while this surface is still
        // fading out. Do not take it back or move focus after the user leaves.
        if (destination === "host" && (mode !== closingMode || selected !== closingCard)) return;
        if (destination === "overview") {
          setMode("archive"); sshOverview?.setVisible(true);
          sshOverview?.focusHost(client.target);
        } else {
          const card = cards.cardOf(client.target ?? "");
          if (card !== undefined && (mode !== "detail" || selected !== card)) openHostCard(card);
          if (mode === "detail") patchHostState(selected);
          // Wait for the camera and cover to return before focusing the
          // original controls; their DOM and scroll position stay intact.
          restoreTerminalFocus = true;
        }
      });
    };
    closeSshTerminal = close;
    openSshTerminal = () => {
      if (!client.target) {
        notify("还没有进行中的会话，先在主机详情里连接");
        return;
      }
      if (terminalRequested && panel.isOpen && mode === "detail" && selected === sessionCard) { panel.focus(); return; }
      if (revealed && !terminalRequested) audio.play("ssh-open");
      const selectedResource = cards.resourceAt(selected);
      const anchorMatches = selectedResource?.sessionKey === current.key || selectedResource?.alias === client.target;
      const card = anchorMatches ? selected : cards.cardOf(client.target) ?? cards.directoryCard;
      if (card !== undefined && selected !== card) select(card, undefined, true);
      if (card !== undefined && mode !== "detail") setMode("detail");
      sessionCard = card ?? selected;
      current.view.sessionCard = sessionCard;
      terminalRequested = true;
      pendingDetailFocus = false;
      restoreTerminalFocus = false;
      terminalClosing = false;
      sshTerminalPending = !panel.isOpen;
      panel.setCloseLabel("收起 · 返回主机");
      if (panel.isClosing) panel.show(prefs.reduced, panel.isProjected ? scene?.projectSessionScreen() : null);
      if (panel.isOpen) panel.focus();
    };

    // ── blocking decision surfaces ─────────────────────────────────────────
    const { SshPromptPanel } = await import("./ssh/prompt");
    const { SshAuditPanel } = await import("./ssh/audit-panel");
    /**
     * Enter is CR on a Windows ConPTY: writing a bare LF echoes but never
     * submits the line, so ssh would sit on its question forever. CR is also
     * what a POSIX tty translates to a newline, so it is correct on both.
     */
    let lastConnection: SshLaunchDescriptor | null = null;
    let handledPrompt: string | null = null;
    let failureShown = false;

    const audit = new SshAuditPanel(
      $("#stage"),
      () => void exportRecord(),
      () => closeAudit(),
    );
    const { SshPageMotion } = await import("./ssh/page-motion");
    sshDetailMotion = new SshPageMotion();
    sshTabMotion = new SshPageMotion();
    // The desktop catalog is registered before navigation is built.
    const cards = hostCards!;
    const loadHosts = () => {
      if (demoSsh) return Promise.resolve({ ok: true, hosts: [
        { alias: "demo-gateway", displayName: "演示网关", hostname: "gateway.demo.invalid", user: "demo", port: "22", source: "saved" as const },
        { alias: "demo-lab", displayName: "演示实验室", hostname: "lab.demo.invalid", user: "analyst", port: "2222", source: "saved" as const },
      ] });
      const bridge = window.rhineDesktop;
      if (!bridge?.hosts) return Promise.resolve({ ok: false, hosts: [], error: "宿主未提供主机列表" });
      return bridge.hosts();
    };
    cards.onChange(() => {
      sshOverview?.update();
      for (let lane = 0; lane < columnMemory.length; lane++) {
        if (!columnFiles(lane).includes(columnMemory[lane])) columnMemory[lane] = columnFiles(lane)[0];
      }
      if (!isActiveArchive(selected)) {
        const wasDetail = mode === "detail";
        select(columnFiles(fileLocation(selected).lane)[0] ?? cards.directoryCard);
        if (wasDetail) setMode("detail");
        return;
      }
      if (fileLocation(selected).lane === cards.lane) scene?.select(selected);
      updateSelection();
      if (mode === "detail" && cards.isDirectory(selected)) {
        const total = $("#host-directory-total"), sources = $("#host-directory-sources");
        if (total) total.textContent = String(cards.bound.length).padStart(2, "0");
        const savedCount = cards.bound.filter(host => host.source === "saved").length;
        if (sources) sources.textContent = `本机 ${savedCount} · SSH config ${cards.bound.length - savedCount}`;
      } else if (mode === "detail" && hostAtCard(selected) && !sshHosts?.isEditing) renderDetail();
      if (modal === "search" || modal === "saved") renderResults();
    });
    // ── host management and quick connections ──────────────────────────────
    const { SshHostsPanel } = await import("./ssh/hosts-panel");
    const openHostCard = (card: number) => {
      const ref = cards.resourceAt(card);
      if (sshOverview && ref && ref.kind !== "host" && ref.kind !== "shortcut") { setMode("archive"); sshOverview.openResource(card); return; }
      if (card !== selected) select(card);
      if (mode !== "detail") { activeTab = "overview"; setMode("detail"); }
      else if (activeTab !== "overview") setTab("overview");
    };
    const hosts = new SshHostsPanel(
      loadHosts,
      target => typeof target === "string" ? connectHostAlias(target) : connectLaunch(target),
      {
        profiles: window.rhineDesktop?.hostProfiles,
        loaded: async result => { if (result.ok) await cards.refresh(() => Promise.resolve(result)); },
        activeTarget: () => bank.forAlias(hostAtCard(selected)?.alias ?? "")?.client.active ? hostAtCard(selected)!.alias : null,
        reduced: () => prefs.reduced,
        openHost: alias => { const card = cards.cardOf(alias); if (card !== undefined) openHostCard(card); },
        cardId: alias => { const card = cards.cardOf(alias); return card === undefined ? "" : records[card].id; },
        saved: (alias, connect) => {
          if (sshOverview?.editing) {
            sshOverview.showPage("hosts"); notify("主机及所选凭据已保存");
            if (connect) connectHostAlias(alias);
            return;
          }
          const card = cards.cardOf(alias);
          if (card !== undefined) {
            activeTab = "overview";
            if (selected === card && mode === "detail") renderDetail();
            else openHostCard(card);
          }
          notify("主机已保存到 SSH 档案列");
          if (connect) connectHostAlias(alias);
        },
        removed: () => { if (sshOverview?.editing) sshOverview.showPage("hosts"); notify("主机已移除，会话历史已保留"); },
        back: () => {
          if (sshOverview?.editing) { sshOverview.showPage("hosts"); return; }
          if (activeTab !== "overview") { setTab("overview"); $("#tab-overview")?.focus({ preventScroll: true }); }
          else closeHosts();
        },
      },
    );
    sshHosts = hosts;
    function closeHosts() {
      if (mode === "detail" && cards.isDirectory(selected)) setMode("archive");
      else if (hosts.isEditing) setTab("overview");
    }
    openSshHosts = () => {
      if (sshSurfaceActive() || !ready) return;
      // A stowed sheet cannot be routed to: bring it back before choosing a page.
      if (sshOverview) { sshOverview.setCollapsed(false); closeModal(() => { setMode("archive"); sshOverview!.showPage("hosts"); }); return; }
      closeModal(() => { openHostCard(cards.directoryCard); audio.play("open"); });
    };
    pruneSshHistory = () => {
      const button = document.querySelector<HTMLButtonElement>('[data-action="ssh-prune"]');
      if (button?.disabled) return;
      if (button) button.disabled = true;
      void window.rhineDesktop?.records?.prune().then(result => {
        notify(result.ok ? `已清理 ${result.removed} 个过期会话` : "部分记录暂时无法清理");
        if (mode === "detail") void refreshHostDetailData(hostAtCard(selected)?.alias ?? "");
      }).catch(() => notify("清理失败，稍后可重试")).finally(() => { if (button) button.disabled = false; });
    };
    function openAudit() {
      const record = client.buildRecord();
      if (!record) return;
      hidePrompt();
      auditOpen = true;
      audit.show(record, prefs.reduced);
    }
    function closeAudit() {
      auditOpen = false;
      audit.hide(prefs.reduced, () => {
        if (sshTerminal?.isOpen) sshTerminal.focus();
      });
      // Reading the audit temporarily covers a request; it does not answer it.
      handledPrompt = null;
      updateSessionUi(client.status());
    }
    closeSshAudit = () => closeAudit();
    async function exportRecord(target?: string) {
      const result = await client.exportRecord(target, audit.current ?? client.buildRecord());
      if (result.ok && result.file) notify(`会话记录已导出到 ${result.file}`);
      else if (!result.ok && !("canceled" in result && result.canceled)) notify(`导出失败：${result.error ?? "未知原因"}`);
      return result;
    }

    let auxiliaryRequest: { id: string; sessionId: string } | null = null;
    let promptOwner: WorkspaceSession | null = null;
    let promptRequestId: number | null = null;
    const answer = async (value: string, remember = false) => {
      const owner = promptOwner, request = auxiliaryRequest;
      if (!owner || owner !== current || (!request && owner.client.pendingPrompt?.id !== promptRequestId)) return;
      const result = request ? await owner.services.answer(value, false, request, remember) : await owner.client.answerPrompt(value, remember);
      if (!result.ok) notify(result.error ?? "请求未能提交");
    };
    const answerHostKey = (accept: boolean) => {
      if (accept && !(auxiliaryRequest ? services.state?.prompt?.fingerprint : client.status().facts.hostKeyFingerprint?.value)) return;
      void answer(accept ? "yes" : "no");
    };
    const answerSecret = (value: string, remember = false) => { void answer(value, remember); };

    const prompt = new SshPromptPanel($("#stage"), {
      // The host key answer is the decision itself: ssh is waiting on this line.
      answerHostKey,
      // The main process owns reuse; explicit remember requests use the vault.
      answerSecret,
      cancel: () => {
        if (promptOwner !== current) return;
        if (auxiliaryRequest) {
          void services.answer("", true, auxiliaryRequest).then(result => { if (!result.ok) notify(result.error || "认证请求已结束"); });
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
        if (mode === "detail") setMode("archive");
        audio.play("back");
      },
    });
    const showPrompt = (request: Parameters<typeof prompt.show>[0]) => {
      if (!request.source) auxiliaryRequest = null;
      promptOwner = current;
      promptRequestId = client.pendingPrompt?.id ?? null;
      sshPromptOpen = true;
      prompt.show(request, prefs.reduced);
    };
    function hidePrompt() {
      sshPromptOpen = false;
      auxiliaryRequest = null;
      promptOwner = null;
      promptRequestId = null;
      prompt.hide(prefs.reduced);
    }
    cancelSshPrompt = () => {
      if (promptOwner === current && client.pendingPrompt) { current.manualStop = true; client.stop(); }
      hidePrompt();
    };
    const startSession = async (input: string | SshLaunchDescriptor, reuse?: WorkspaceSession, background = false, project?: import("./ssh/workspace-store").ArchiveShortcut) => {
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
        notify(saved ? "目录已加入收藏" : cards.store?.error || "目录未能保存");
      });
      const result = await context.client.start({ cols: 100, rows: 30, ...descriptor });
      if (!result.ok && context === current && !background) {
        failureShown = true;
        sshPromptOpen = true;
        prompt.show({ kind: "failure", reason: result.error, phase: "failed", timeline: [], log: [] }, prefs.reduced);
      }
      sshLibrary?.refresh();
      return result;
    };
    const reconnect = async (context = current) => {
      const descriptor = context.descriptor ?? lastConnection;
      if (!descriptor) return { ok: false as const, error: "没有可重新连接的主机" };
      hidePrompt();
      return startSession(descriptor, context);
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
        openSshTerminal?.();
        return;
      }
      const card = anchor ?? cards.cardOf(alias);
      if (card !== undefined && card !== selected) select(card);
      if (card !== undefined && mode !== "detail") setMode("detail");
      audio.play("open");
      void startSession(descriptor);
    };
    connectHostAlias = (alias: string, newSession = false) => {
      const host = [...cards.bound, ...cards.overflow].find(entry => entry.alias === alias);
      if (demoSsh) {
        const card = cards.cardOf(alias);
        if (card !== undefined && card !== selected) select(card);
        if (card !== undefined && mode !== "detail") setMode("detail");
        notify("SSH 演示模式：此页面不会连接真实主机");
        return;
      }
      connectLaunch({ target: alias, displayName: host ? hostLabel(host) : alias }, newSession);
    };
    openHostSession = alias => {
      const context = bank.forAlias(alias);
      if (context) { activateContext(context, panel.isOpen); openSshTerminal?.(); }
      else connectHostAlias(alias);
    };
    openStoredRecord = (file: string) => {
      const bridge = window.rhineDesktop?.records;
      if (!bridge) return;
      void bridge.read(file).then((result) => {
        if (!result.ok || !result.record) {
          notify(`无法读取会话记录：${result.error ?? "未知原因"}`);
          return;
        }
        hidePrompt();
        auditOpen = true;
        audit.show(result.record, prefs.reduced);
      });
    };

    // The terminal appears when ssh says the session is interactive — the same
    // event that finishes the glass reveal, so the two agree by construction.
    let lastPhase = "";
    let seenGeneration = client.generation;
    let sessionCard = selected;
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
      if (fast && feedback) audio.play("ssh-switch");
      saveContext();
      hidePrompt();
      bank.activate(next);
      current = next; client = next.client; services = next.services; panel = next.panel;
      sshClient = client; sshTerminal = panel;
      ({ interactiveGeneration, revealed, failureShown, lastPhase, seenGeneration, sessionCard } = next.view);
      lastConnection = next.descriptor;
      handledPrompt = null;
      restoreTerminalFocus = false;
      terminalClosing = false;
      terminalRequested = fast;
      sshTerminalPending = false;
      if (fast) {
        sessionCard = selected;
        current.view.sessionCard = selected;
        revealed = true;
        panel.setAppearance(prefs.colorTheme === "dark", prefs.reduced);
        panel.show(prefs.reduced, scene?.projectSessionScreen());
      }
      deck?.bind(client, panel);
      updateSelection();
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
      panel.onTeardown = () => setDeckInspecting(true);
      const items = bank.visibleSessions.map(session => ({ key: session.key,
        label: `${records[cards.resourceCard("session", session.key) ?? -1]?.id || "SSH"} / ${session.client.displayTarget || session.descriptor?.displayName || session.descriptor?.target || "SSH"}`,
        state: session.client.pendingPrompt || session.services.state?.prompt ? "等待认证" : session.recovery || session.client.status().label,
        unread: session.unread, alert: session.alert,
        transfers: session.services.state?.jobs.filter(job => ["queued", "scanning", "transferring", "committing", "conflict"].includes(job.state)).length || 0 }));
      panel.setSessionNavigation(items, current.key, key => {
        const next = bank.byKey(key);
        if (next) { activateContext(next, true); openSshTerminal?.(); }
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
          if (operating) openSshTerminal?.();
        } else if (operating || (scene?.sessionDeckFocus ?? 0) > .001) {
          // Keep the final parser and texture until its own package has shut.
          // The closing tab is removed immediately, so it cannot be resumed.
          retiringLastSession = context;
          close(false, "overview");
          syncSessionNavigation(); sshOverview?.update();
          return;
        } else {
          activateContext(bank.create(), false, false);
          setMode("archive");
        }
      }
      bank.remove(context); eventAudio.remove(context.key); library.refresh(); syncSessionNavigation(); sshOverview?.update();
      if (restoreFocus) { if (panel.isOpen) panel.focus(); else sshOverview?.focusSession(); }
    }
    function requestStop(context: WorkspaceSession, remove = false) {
      if (!context.client.active) { if (remove) removeClosedSession(context); return; }
      const stop = () => {
        if (remove) closingSessions.add(context.key);
        context.manualStop = true; context.client.stop(); notify("已请求结束这次会话");
      };
      const pending = context.services.state?.jobs.some(job => ["queued", "scanning", "transferring", "committing", "conflict"].includes(job.state));
      if (pending) {
        activateContext(context, panel.isOpen);
        // A request from the library must establish this session's archive
        // anchor before its confirmation surface can survive the next frame.
        openSshTerminal?.();
        syncSessionNavigation(); panel.confirmStop(stop);
      } else stop();
    }
    stopSshSession = () => requestStop(bank.forAlias(hostAtCard(selected)?.alias ?? "") ?? current);
    switchSshSession = direction => {
      const items = bank.visibleSessions;
      if (items.length < 2) return;
      const next = items[wrap(items.indexOf(current) + direction, items.length)];
      activateContext(next, panel.isOpen);
      openSshTerminal?.();
    };
    /**
     * Bring the terminal up once a session exists.
     *
     * Reachable by hand too (Ctrl+Shift+T, and the archive's own way of
     * opening the session's card): a surface that only ever appears by itself
     * leaves the user with nothing to do if it does not.
     */
    function revealTerminal(status: ReturnType<SshClient["status"]> = client.status()) {
      if (revealed || panel.isOpen || auditOpen || !client.target) return;
      if (status.phase !== "interactive") return;
      openSshTerminal?.();
      revealed = true;
    }
    const updateSessionUi = (status: ReturnType<SshClient["status"]>) => {
      if (seenGeneration !== client.generation) {
        seenGeneration = client.generation;
        terminalRequested = false;
        terminalClosing = false;
        sshTerminalPending = false;
        interactiveGeneration = -1;
        // A reconnect closes the package on its own schedule, so the stack is
        // put back in one step rather than springing shut inside it.
        deckInspecting = false;
        deckReassembling = false;
        deck?.setExploded(false, true);
        syncDeckTools();
        panel.hide(true);
        scene?.setSessionDeckState("packed");
        sessionCard = cards.resourceAt(selected)?.alias === client.target ? selected : cards.cardOf(client.target ?? "") ?? selected;
        revealed = false;
        failureShown = false;
        handledPrompt = null;
      }
      if (status.phase === "interactive") interactiveGeneration = client.generation;
      if (status.phase === "failed" && interactiveGeneration !== client.generation) {
        terminalRequested = false; sshTerminalPending = false;
      }
      // The session's card mirrors the live state in the HUD and the detail.
      const targetCard = client.target ? cards.cardOf(client.target) : undefined;
      if (targetCard !== undefined && status.phase !== lastPhase) {
        lastPhase = status.phase;
        updateSelection();
        if (mode === "detail" && selected === targetCard) patchHostState(targetCard);
      }
      if (auditOpen) return;
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
        sshPromptOpen = true;
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
          prefs.reduced,
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
    const { TerminalDeck } = await import("./ssh/terminal-deck");
    let deck: Awaited<ReturnType<typeof TerminalDeck.load>> | null = null;
    let deckOwner: ArchiveScene | null = null;
    let deckLoading: ArchiveScene | null = null;
    let deckBroken: ArchiveScene | null = null;
    /**
     * The terminal's own "拆解档案", in place.
     *
     * The package stays open while the stack is apart — that is what the extra
     * term in `setSessionDeckState` below is for — and the real xterm steps off
     * the screen, because an exploded panel is no longer where the projection
     * says it is. Reassembly puts it back, which is the whole loop: separate to
     * look at the machine, close it up to use it.
     *
     * The two ends of that loop are in different places, and deliberately so.
     * Opening it is offered from the terminal bar, because `SurfaceScope` makes
     * the terminal modal — everything beside it is inert and its events are
     * swallowed — so a control drawn in the scene cannot be reached while the
     * terminal is open, which is exactly when the deck is at operating size.
     * Closing it is offered in the scene, which is interactive again the moment
     * the terminal steps off the screen.
     */
    let deckInspecting = false;
    let deckReassembling = false;
    const deckTools = document.createElement("div");
    deckTools.className = "deck-tools";
    deckTools.hidden = true;
    deckTools.innerHTML = `<span class="deck-tools-label">TERMINAL / 终端内胆已拆解</span><button type="button" data-deck-action="assemble" aria-pressed="false"><span>−</span> 一键重组</button>`;
    $("#viewport").append(deckTools);
    deckTools.addEventListener("click", event => {
      const button = (event.target as Element).closest<HTMLButtonElement>("[data-deck-action]");
      if (!button || button.disabled || !deck) return;
      event.stopPropagation();
      setDeckInspecting(false);
    });
    panel.onTeardown = () => setDeckInspecting(true);
    function setDeckInspecting(value: boolean) {
      if (value === deckInspecting || !deck) return;
      deckInspecting = value;
      deck.setExploded(value);
      audio.play(value ? "explode" : "assemble");
      if (value) {
        // The xterm is pinned to four corners of a screen that is about to move
        // away from them, so it leaves first. Inspection keeps the card
        // underneath, which is what is being inspected.
        if (terminalRequested || panel.isOpen) close(true, "inspect");
        deckReassembling = false;
      } else {
        // Reopen only once the plates are home, so the terminal does not land
        // on a stack that is still closing.
        deckReassembling = true;
      }
      syncDeckTools();
    }
    /** The bar's entry point: only offered once there is a stack at full size. */
    function syncDeckTools() {
      const ready = scene?.sessionDeckReady ?? false;
      panel.setTeardownAvailable(ready && !deckInspecting);
      deckTools.hidden = !deckInspecting || mode !== "detail" || selected !== sessionCard;
      for (const button of deckTools.querySelectorAll<HTMLButtonElement>("[data-deck-action]")) {
        const assemble = button.dataset.deckAction === "assemble";
        button.disabled = deckReassembling && assemble;
        button.setAttribute("aria-pressed", String(assemble));
      }
    }
    const ensureDeck = () => {
      const owner = scene;
      if (!owner || deckBroken === owner || deckLoading === owner || (deckOwner === owner && owner.hasSessionDeck)) return;
      deckLoading = owner;
      void TerminalDeck.load(client, panel, () => owner.createAssemblyModel()).then(created => {
        if (scene !== owner) { created.dispose(); return; }
        deck = created; deckOwner = owner; owner.setSessionDeck(created);
      }).catch(error => {
        if (scene !== owner) return;
        deckBroken = owner;
        console.error("终端模型载入失败：", error);
        notify("终端模型载入失败，已保留常规终端入口");
      }).finally(() => { if (deckLoading === owner) deckLoading = null; });
    };

    const { SshLibrary } = await import("./ssh/library");
    const { SshEventAudio } = await import("./ssh/event-audio");
    const eventAudio = new SshEventAudio(sound => audio.play(sound));
    let pendingCommand: { key: string; generation: number; text: string } | null = null;
    let pendingWorkspacePage: { key: string; page: "terminal" | "files" | "monitor"; path?: string; transfers?: boolean } | null = null;
    const openWorkspace = (context: WorkspaceSession, page: "terminal" | "files" | "monitor" = "terminal", path?: string, transfers?: boolean) => {
      activateContext(context, panel.isOpen);
      pendingWorkspacePage = { key: context.key, page, path, transfers };
      openSshTerminal?.();
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
      reduced: () => prefs.reduced,
      openCard: openHostCard,
      openSession: openWorkspace,
      connect: (alias, path) => {
        connectHostAlias(alias);
        pendingWorkspacePage = { key: current.key, page: "files", path };
      },
      openHosts: openSshHosts,
      insert: (context, text) => {
        openWorkspace(context, "terminal");
        pendingCommand = { key: context.key, generation: context.client.generation, text };
      },
      stop: requestStop,
      removeSession: context => {
        if (!context.client.active) { removeClosedSession(context); notify("会话已移出，历史记录仍然保留"); }
      },
      record: openStoredRecord,
      notify,
      shortcut: row => openSshShortcut(row.id, true),
    });
    const directoryOnConnect = new Map<string, { path: string; generation: number }>();
    const { TunnelPanel } = await import("./ssh/tunnel-panel");
    const tunnelPanel = new TunnelPanel(bank, () => prefs.reduced, notify);
    const pendingTunnels = new Map<string, { shortcut: import("./ssh/workspace-store").ArchiveShortcut; generation: number }>();
    function startPendingTunnel(context: WorkspaceSession) {
      const request = pendingTunnels.get(context.key);
      if (!request) return;
      if (context.client.generation !== request.generation || context.manualStop || context.client.exit) { pendingTunnels.delete(context.key); return; }
      if (!context.client.active || context.client.status().phase !== "interactive" || !context.services.state || ["waiting", "closed"].includes(context.services.state.sftp.state)) return;
      pendingTunnels.delete(context.key);
      void tunnelPanel.start(context, request.shortcut);
    }
    openSshShortcut = (id, force = false) => {
      const row = cards.store!.shortcuts.find(s => s.id === id);
      const card = cards.resourceCard("shortcut", id);
      if (!row || card === undefined) return;
      if (selected !== card) select(card);
      if (mode !== "detail") setMode("detail");
      if (row.kind === "note" || !force && !row.autoOpen) return;
      const host = cards.bound.find(h => h.alias === row.alias);
      if (!host) { notify("关联主机已移除，请编辑这份档案重新选择主机"); return; }
      const terminalDirectory = row.kind === "terminal" && Boolean(row.path);
      if (row.kind === "project") {
        const existing = bank.visibleSessions.find(session => session.project?.id === row.id && session.client.active);
        if (existing) activateContext(existing, panel.isOpen);
        else void startSession({ target: row.alias, displayName: hostLabel(host) }, undefined, false, row);
        pendingWorkspacePage = { key: current.key, page: row.layout?.page || "files", path: row.layout?.page === "files" ? row.path : undefined };
        openSshTerminal?.();
        return;
      }
      connectLaunch({ target: row.alias, displayName: hostLabel(host) }, terminalDirectory, card);
      pendingWorkspacePage = { key: current.key, page: row.kind === "tunnel" ? "terminal" : row.kind, path: row.kind === "files" ? row.path : undefined };
      if (terminalDirectory) directoryOnConnect.set(current.key, { path: row.path, generation: client.generation });
      if (row.kind === "tunnel") { pendingTunnels.set(current.key, { shortcut: structuredClone(row), generation: client.generation }); startPendingTunnel(current); }
    };
    sshLibrary = library;
    const { SshOverview } = await import("./ssh/overview");
    const overview = sshOverview = new SshOverview(cards, bank, hosts, library, {
      reduced: () => prefs.reduced,
      collapsedChanged: value => syncArchiveChrome(value),
      inspect: alias => { const card = cards.cardOf(alias); if (card !== undefined) { openHostCard(card); audio.play("open"); } },
      preview: alias => { const card = cards.cardOf(alias); if (card !== undefined && mode === "archive" && !modal && !sshSurfaceActive()) scene?.previewArchive(card); },
      connect: (alias, fresh) => connectHostAlias(alias, fresh),
      session: key => { const context = bank.byKey(key); if (context) openWorkspace(context); },
      closeSession: key => { const context = bank.byKey(key); if (context) requestStop(context, true); },
      settings: () => openWorkspacePreferences(), search: () => openQuickSearch(), pageSound: () => audio.play("ui-tick"),
    });
    $("#viewport").append(overview.root);
    $("#viewport").dataset.sshOverview = "true";
    if (mode === "detail" && cards.resourceAt(selected)?.kind !== "host") renderDetail();

    let previous = 0;
    sshFrame = (time: number) => {
      // A real frame delta, clamped so a stalled or backgrounded window cannot
      // fast-forward the reveal when it resumes.
      const dt = previous ? Math.min(0.25, Math.max(0, time - previous)) : 0;
      previous = time;
      const snapshot = client.tick(dt);
      panel.setAppearance(prefs.colorTheme === "dark", prefs.reduced);
      // null means no session has run yet: hand the scene back to its own clock.
      scene?.setDecryptionReference(snapshot && mode === "detail" && selected === sessionCard ? snapshot.reference : null);
      // The session's own card carries the session as its contents: auth log
      // behind the frosted cover first, open lid and operating size once the
      // session is interactive. Any other view is an ordinary file.
      // A deck failure must never take the frame loop down with it — the
      // archive, the prompt and the DOM terminal all outrank the 3D mirror.
      const resource = mode !== "boot" ? cards.resourceAt(selected) : undefined;
      const host = hostAtCard(selected);
      if ((terminalRequested || deckInspecting || deckReassembling) && (mode !== "detail" || selected !== sessionCard)) close(false, "stay");
      if (deckOwner === scene && scene && !scene.hasSessionDeck) {
        deckBroken = scene; deckOwner = null; deck = null;
        notify("三维终端已停用，会话继续保留在常规终端中");
      }
      if (resource && scene) ensureDeck();
      const held = selected === sessionCard && (terminalRequested || terminalClosing || (scene?.sessionDeckFocus ?? 0) > 0);
      const bound = held ? current : resource?.sessionKey ? bank.byKey(resource.sessionKey) : resource?.alias ? bank.forAlias(resource.alias) : undefined;
      if (deck && deckOwner === scene && resource) {
        deck.setCard(records[selected].id);
        deck.bind(bound?.client ?? client, bound?.panel ?? panel);
        const screenSession = held || resource.kind === "session" && !resource.directory;
        if (screenSession && bound?.client.target) deck.setHost(bound.client.target, sessionLabelFor(bound));
        else if (host) deck.setHost(host.alias, hostLabel(host));
        else { const preview = library.preview(selected); deck.setPreview(preview.key, preview.title, preview.lines); }
      }
      const operating = interactiveGeneration === client.generation && selected === sessionCard;
      // Inspecting holds the package open the same way operating does; without
      // that term the lid would swing shut the moment the terminal stepped off
      // the screen, with the stack already separated inside it.
      scene?.setSessionOpeningDuration(sshPreferences.value.animation === "first" && openedArchives.has(records[selected]?.id || "") ? .6 : 2.1);
      scene?.setSessionDeckState(resource ? ((terminalRequested || terminalClosing || deckInspecting) && operating ? "open" : "packed") : "off");
      $("#stage").dataset.sshDeck = String(Boolean(resource && scene?.hasSessionDeck));
      const covered = panel.isOpen && !panel.isClosing && !sshPromptOpen && !auditOpen && !modal && !viewer?.isOpen;
      scene?.setSessionSurfaceCovered(covered && panel.isProjected);
      audio.setOperating(covered);
      // SSH traffic belongs in the measured indicators. The archive only moves
      // in response to browsing, selection and extraction.
      scene?.setAmbientMotion(false);
      scene?.setPlayfield(false, client.meter.value, 0, 0, null, false);
    };

    // Map the native-pixel terminal after the camera update, so its rectangle
    // follows this frame's model during resize and an interrupted close.
    sshAfterFrame = () => {
      if (retiringLastSession && (retiringLastSession !== current ||
        !panel.isOpen && !panel.isClosing && (scene?.sessionDeckFocus ?? 0) < .001)) {
        const retired = retiringLastSession; retiringLastSession = null;
        removeClosedSession(retired);
      }
      // The plates are home: hand the screen back to the terminal. Waiting for
      // the spring rather than a timer keeps this tied to what is on screen.
      if (deckReassembling && (scene?.sessionDeckSpread ?? 0) < 0.01) {
        deckReassembling = false;
        deckInspecting = false;
        syncDeckTools();
        openSshTerminal?.();
      }
      syncDeckTools();
      $("#stage").style.setProperty("--ssh-focus", String(scene?.sessionDeckFocus ?? 0));
      if (restoreTerminalFocus && !sshSurfaceActive() && (scene?.sessionDeckFocus ?? 0) < .01) {
        const connect = $("#host-connect");
        const button = mode === "detail"
          ? connect && !connect.closest("[inert],[hidden]") ? connect : $("#tab-overview")
          : $(".read-file");
        if (button && !button.closest("[inert],[hidden]")) {
          button.focus({ preventScroll: true }); restoreTerminalFocus = false;
        }
      }
      if (panel.isOpen && panel.isProjected && scene === deckBroken) panel.show(prefs.reduced);
      const projection = scene?.projectSessionScreen();
      if ((panel.isOpen || panel.isClosing) && panel.isProjected && projection) panel.setProjection(projection);
      if (panel.isOpen && !panel.isClosing && !prompt.isOpen && !audit.isOpen) {
        openedArchives.add(records[selected]?.id || "");
        if (!document.hidden && panel.isUsable) current.unread = false;
        const splitOwner = current, splitPeer = bank.byKey(current.splitKey || "");
        panel.setSplit(splitPeer?.panel, current.splitRatio || current.project?.layout?.splitRatio || .5,
          ratio => saveSplit(splitOwner, splitPeer?.descriptor?.target || "", ratio),
          () => chooseSplit(splitOwner, "none"));
        if (!document.hidden && splitPeer?.panel.isUsable) splitPeer.unread = false;
        if (pendingWorkspacePage?.key === current.key) {
          const request = pendingWorkspacePage; pendingWorkspacePage = null;
          panel.selectPage(request.page);
          if (request.path) void panel.openDirectory(request.path);
          if (request.transfers) panel.showTransfers();
        }
        if (pendingCommand) {
          const request = pendingCommand; pendingCommand = null;
          if (request.key === current.key && request.generation === client.generation) {
            if (!panel.pasteCommand(request.text)) notify("当前会话无法安全插入该片段；多行命令需要终端启用括号粘贴");
          }
        }
      }
      if (!terminalRequested || panel.isOpen || prompt.isOpen || audit.isOpen || modal || viewer?.isOpen) return;
      const card = cards.resourceAt(sessionCard) ? sessionCard : undefined;
      // A failed connection has no shell to unpack, but its output action must
      // still open the retained authentication log instead of waiting forever.
      const endedBeforeShell = !client.active && interactiveGeneration !== client.generation;
      if (card === undefined || !scene || deckBroken === scene || endedBeforeShell) {
        panel.show(prefs.reduced);
        sshTerminalPending = false;
      } else if (scene.sessionDeckReady && projection) {
        panel.show(prefs.reduced, projection);
        sshTerminalPending = false;
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
      if (event?.event === "credential-error") notify(`${sessionLabelFor(context)}：${event.data.message}`);
      if (closingSessions.has(context.key) && context.client.exit) {
        closingSessions.delete(context.key);
        void context.client.persistRecord().catch(() => {}).finally(() => removeClosedSession(context));
      }
      if (context === current && (!event || ["auth", "snapshot", "stopped"].includes(event.event))) updateSessionUi(client.status());
      const recordKey = context.key + ":" + context.client.generation;
      if (context.recordSaved && !savedRecords.has(recordKey)) {
        savedRecords.add(recordKey); void library.reloadHistory();
        if (hostAtCard(selected)?.alias === context.client.target) void refreshHostDetailData(context.client.target!);
      }
      if (!catalogTimer) catalogTimer = window.setTimeout(() => {
        catalogTimer = 0; library.refresh(); syncSessionNavigation(); overview.update();
      }, 120);
    });
    const { SessionHealth } = await import("./ssh/session-health");
    const health = new SessionHealth(bank, context => startSession(context.descriptor!, context, true), notify);
    cancelRecovery = context => health.cancel(context);
    const { SshQuickSearch } = await import("./ssh/quick-search");
    const quickSearch = new SshQuickSearch(cards, bank, {
      reduced: () => prefs.reduced, host: alias => connectHostAlias(alias), shortcut: id => openSshShortcut(id, true),
      session: key => { const context = bank.byKey(key); if (context) openWorkspace(context); },
      bookmark: (alias, path) => { const context = bank.forAlias(alias); if (context?.client.active) openWorkspace(context, "files", path); else { connectHostAlias(alias); pendingWorkspacePage = { key: current.key, page: "files", path }; } },
      command: id => { const card = cards.resourceCard("command", id); if (card !== undefined) { close(false, "overview"); setMode("archive"); overview.openResource(card); } },
    });
    openQuickSearch = () => quickSearch.open();
    const { SshSettingsPanel } = await import("./ssh/settings-panel");
    const workspaceSettings = new SshSettingsPanel(cards.store!, {
      reduced: () => prefs.reduced, system: () => openModal("settings"), tunnels: () => tunnelPanel.open(),
      imported: async () => { await hosts.refresh(); library.refresh(); overview.update(); syncSessionNavigation(); }, notify,
    });
    openWorkspacePreferences = () => workspaceSettings.open();
    void hosts.refresh().then(() => {
      overview.update();
      if (mode === "detail" && cards.isDirectory(selected) && !hosts.isOpen) setTab(activeTab, false);
    });
    syncSessionNavigation();
    Object.assign(window, {
      rhineSsh: client,
      rhineSshUi: {
        startSession,
        reconnect,
        openTerminal: () => openSshTerminal?.(),
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
        openHosts: () => openSshHosts(),
        closeHosts: () => closeHosts(),
        get hostsOpen() {
          return mode === "detail" && cards.isDirectory(selected);
        },
        get hostDirectoryCard() { return cards.directoryCard; },
        get hostList() {
          return hosts.items;
        },
        // ── host cards: the array as the host list ─────────────────────────
        connectHost: (alias: string) => connectHostAlias(alias),
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
        get rendering() { return scene?.sessionRendering; },
        activateSession: (key: string) => { const context = bank.byKey(key); if (context) openWorkspace(context); },
        stopSession: (key: string) => { const context = bank.byKey(key); if (context) requestStop(context); },
        resourceCard: (kind: import("./ssh/host-cards").ResourceKind, key = "directory") => cards.resourceCard(kind, key),
      },
    });
    Object.defineProperty(window, "rhineSsh", { configurable: true, get: () => client });
    if (import.meta.hot) import.meta.hot.dispose(() => {
      workspaceSettings.dispose(); tunnelPanel.dispose(); quickSearch.dispose(); health.dispose(); clearTimeout(catalogTimer); offBank(); overview.dispose(); desktopModalScope?.dispose(); library.dispose(); eventAudio.dispose(); bank.dispose(); prompt.dispose(); audit.dispose(); hosts.dispose(); deckTools.remove();
    });
  });
}
if (import.meta.hot) import.meta.hot.dispose(() => audio.dispose());
