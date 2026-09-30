export const modalContext = {
  get modal() { return modal; },
  set modal(value: typeof modal) { modal = value; },
  get ready() { return ready; },
  set ready(value: typeof ready) { ready = value; },
  get desktopModalScope() { return desktopModalScope; },
  set desktopModalScope(value: typeof desktopModalScope) { desktopModalScope = value; },
  get previousFocus() { return previousFocus; },
  set previousFocus(value: typeof previousFocus) { previousFocus = value; },
  get modalSiblings() { return modalSiblings; },
  set modalSiblings(value: typeof modalSiblings) { modalSiblings = value; },
  get $() { return $; },
  get modalClosing() { return modalClosing; },
  set modalClosing(value: typeof modalClosing) { modalClosing = value; },
  get historyNav() { return historyNav; },
  get searchQuery() { return searchQuery; },
  set searchQuery(value: typeof searchQuery) { searchQuery = value; },
  get filter() { return filter; },
  set filter(value: typeof filter) { filter = value; },
  get audio() { return audio; },
  get modalTransition() { return modalTransition; },
  set modalTransition(value: typeof modalTransition) { modalTransition = value; },
  get prefs() { return prefs; },
  get mode() { return mode; },
  set mode(value: typeof mode) { mode = value; },
  get workbench() { return workbench; },
  set workbench(value: typeof workbench) { workbench = value; },
  get desktopShell() { return desktopShell; },
  get openSettingsSection() { return openSettingsSection; },
  set openSettingsSection(value: typeof openSettingsSection) { openSettingsSection = value; },
  get hostAtCard() { return hostAtCard; },
  get saved() { return saved; },
  get scene() { return scene; },
  set scene(value: typeof scene) { scene = value; },
  get superPerformanceEnabled() { return superPerformanceEnabled; },
  get effectiveRenderQuality() { return effectiveRenderQuality; },
  get motionSettingsMarkup() { return motionSettingsMarkup; },
};
import * as modalController from "../features/settings/modal-controller";
import { createRollingClock } from "../shared/rolling-clock";
import { InspectionOverlay } from "../rendering/inspection-overlay";
import { DocumentDecryption } from "../features/archives/document-decryption";
import "../features/archives/document-decryption.css";
import "../features/archives/decryption.css";
import { escapeHtml } from "../shared/html";
import { normalizeQuality, qualityPresets, type QualityPreset, type RenderQuality } from "../rendering/render-quality";
import { qualityMarkup, syncQualityUI } from "../features/settings/quality-settings";
import { superPerformanceQuality, wallpaperQuality } from "../platform/wallpaper/wallpaper-quality";
import "@kitlangton/rolling-number/styles.css";
import "./style.css";
import "../features/settings/quality-settings.css";
import "./responsive.css";
import { viewportLayout, openingLayout } from "../rendering/viewport-layout";
import { assetUrl } from "../shared/asset-url";
import { initPwa, pwaSettingsMarkup } from "../platform/pwa/pwa";
import { initNativeShell } from "../platform/android/native";
import { createRollingNumber, createRollingText } from "@kitlangton/rolling-number";
import { ArchiveScene } from "../rendering/scene";
import { ModelViewer } from "../rendering/model-viewer";
import { ContentTransition, SurfaceTransition } from "../shared/ui-transitions";
import { HistoryNav, type AppScreen } from "./history-nav";
import { BootSequence } from "../features/boot/boot";
import { loadBootWebfonts } from "../features/boot/boot-lettering";
import { wrap, type ArchiveNavigation } from "../features/archives/archive-loop";
import {
  records,
  categories,
  archiveColumns,
  columnFiles,
  fileLocation,
  archiveFiles,
  isActiveArchive,
} from "../features/archives/data";
import { TerminalAudio, VOICES } from "../shared/audio";
import { motifOf } from "../features/theme/theme-design";
import { ThemePoster } from "../features/theme/theme-poster";
import { setSurfacePalette } from "../features/theme/theme-material";
import { playThemeReveal } from "../features/theme/theme-reveal";
import { showThemeMark } from "../features/theme/theme-mark";
import { configureHoverCards } from "../shared/hover-card";
import { audioSettingsMarkup } from "../features/settings/audio-settings";
import { StartupGate } from "../features/boot/startup";
import { isWallpaper, wallpaperHost, wallpaperFrame, type WallpaperProperties } from "../platform/wallpaper/wallpaper";
import { isDesktop } from "../platform/desktop/desktop";
import { isAndroid } from "../platform/android/android";
import { FrameBudget, ResolutionGovernor, ANDROID_RATES, DESKTOP_RATES } from "../rendering/frame-budget";
import { hostLabel, hostSubtitle, SshHostCards } from "../features/ssh/host-cards";
import {
  hostDetailMarkup,
  hostLogMarkup,
  hostOverviewMarkup,
  hostSessionsMarkup,
  hostDirectoryMarkup,
  directorySessionsMarkup,
  type HostDetailData,
  type HostLiveFacts,
} from "../features/ssh/host-detail";
import type { SshClient, SshLaunchDescriptor } from "../features/ssh/client";
import type { SshTerminalPanel } from "../features/ssh/terminal";
import type { SshHostsPanel } from "../features/ssh/hosts-panel";
import type { SshPageMotion } from "../features/ssh/page-motion";
import type { SshSessionBank } from "../features/ssh/session-bank";
import type { SshLibrary } from "../features/ssh/library";
import "../features/boot/startup.css";
import "../platform/wallpaper/wallpaper.css";
import { Workbench } from "../platform/wallpaper/workbench";
let workbench: Workbench | undefined;
import { ArchivePlayground } from "../platform/wallpaper/archive-playground";
import { ARRAY_OPENING_END, openingShowsDetail } from "../platform/wallpaper/wallpaper-opening";
import { currentPalette, paintTheme, paletteRgb, setPalette, signalsOf, themeSettingsMarkup, THEMES, type ThemeName } from "../features/theme/theme-ui";
import { settingsNavigation, type SettingsSection } from "../features/settings/settings-navigation";
let openSettingsSection: (section: SettingsSection) => void = () => {};
let playground: ArchivePlayground | undefined;
import { WallpaperEffects } from "../platform/wallpaper/wallpaper-effects";
import { WallpaperBackground } from "../platform/wallpaper/wallpaper-background";
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
let inspectSshHost: (alias: string, fresh?: boolean) => void = () => {};
let openHostSession: (alias: string) => void = () => {};
let stopSshSession: () => void = () => {};
let switchSshSession: (direction: number) => void = () => {};
let sshBank: SshSessionBank | undefined;
let sshLibrary: SshLibrary | undefined;
let openSshShortcut: (id: string, force?: boolean) => void = () => {};
let sshOverview: import("../features/ssh/overview").SshOverview | undefined;
let portals: import("./portals").SpatialPortals | undefined;
let desktopModalScope: import("../features/ssh/surface").SurfaceScope | undefined;
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
const demoSsh = !isDesktop && !isAndroid && !isWallpaper && new URLSearchParams(location.search).get("ssh-demo") !== "0";
const hostCards = isDesktop || isAndroid || demoSsh ? new SshHostCards(true) : undefined;
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
import { logo, brandHeading } from "../shared/brand";

// The desktop launcher verifies its Vite mode. Keeping this compile-time
// gate lets web and wallpaper builds omit the SSH terminal and native bridge.
const desktopShell = isDesktop || isAndroid || demoSsh;
// Never forward exception messages: they can contain terminal or file contents.
if (window.rhineDesktop?.captureError) {
  const report = (kind: "error" | "rejection") => {
    try {
      void window.rhineDesktop?.captureError?.({
        category: "renderer-error", level: "error", reason: kind,
      }).catch(() => { /* reporting failure must not trigger another rejection */ });
    } catch { /* the bridge may be gone during shutdown */ }
  };
  window.addEventListener("error", () => report("error"));
  window.addEventListener("unhandledrejection", () => report("rejection"));
}

$("#stage").innerHTML = `
  ${isDesktop ? '<div class="titlebar-drag" aria-hidden="true"></div>' : ""}
  <div id="three-scene" class="three-scene"></div>
  ${desktopShell ? '<canvas id="theme-poster" class="theme-poster" aria-hidden="true"></canvas>' : ""}
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
    ${demoSsh ? '<button class="demo-ssh-entry" data-action="ssh-hosts">SSH 演示入口 <span>↗</span><small>仅展示界面，不连接真实主机</small></button>' : ""}
    <div class="archive-callout"><div class="eyebrow">INTERNAL DATABASE <span>／</span> <span id="archive-category">机构档案</span></div><button class="file-title" data-action="open">FILE NUMBER: <span id="selected-id">X-<span id="selected-code">001</span></span><span class="file-open">↗</span></button><div class="callout-rule"><i></i></div><div class="file-summary"><span id="selected-title">莱茵生命</span><span id="selected-clearance">BUSINESS AREA</span></div><button class="read-file" data-action="open">ACCESS FILE <span>→</span></button>${desktopShell ? '<button class="archive-session" data-action="ssh-terminal" hidden>打开终端 <span>↗</span></button><p class="archive-pull-hint">点击选中模型读取，或按住向上抽出</p>' : ""}</div>
    <div id="hover-label" class="hover-label" hidden>X-<span id="hover-code">001</span> / <span id="hover-title"></span></div>
    <div class="archive-counter"><span class="tiny-label">ARCHIVE / SELECT</span><div><span id="selected-number">01</span><i>/</i><span class="count-total">12</span></div></div>
    <div class="archive-navigation"><button data-action="prev" aria-label="上一个档案">←</button><div id="file-ticks" class="file-ticks"></div><button data-action="next" aria-label="下一个档案">→</button></div>
    <div class="column-navigation"><button data-action="column-prev" aria-label="上一列">↑</button><div><span id="column-number">COLUMN <span id="column-index">03</span> / ${String(archiveColumns.length).padStart(2, "0")}</span><strong id="column-name">机构档案</strong></div><button data-action="column-next" aria-label="下一列">↓</button></div>
    <div class="archive-hint"><kbd>←</kbd> <kbd>→</kbd> 前后档案 <span>／</span> <kbd>↑</kbd> <kbd>↓</kbd> 切换列 <span>／</span> <kbd>ENTER</kbd> 读取</div>
  </section>
  <section id="detail-ui" class="detail-ui" aria-label="档案内容" hidden>
    <button class="back-button" data-action="back">← <span>ARCHIVE OVERVIEW</span><small>ESC</small></button>
    <div class="object-caption"><span id="object-id">NO.001</span><div>INTERNAL DATABASE</div><small>DRAG TO INSPECT <span>↔</span></small><button class="viewer-open" data-action="model-viewer">360° 查看文档模型 <span>↗</span></button></div>
    <article id="detail-content" class="detail-content"></article>
  </section>
  <div class="powered">POWERED BY <b>RHINE LAB</b><i></i></div>
  <footer class="system-footer"><span><i class="status-light"></i> ${desktopShell ? "SSH WORKSPACE" : "SESSION AUTHORIZED"}${demoSsh ? ' · 演示模式' : ""}${isWallpaper ? '<button type="button" class="three-toggle" data-action="toggle-three" aria-pressed="true" title="卸载三维模型，保留 2D 界面">3D 开启</button>' : ''}</span><span>${desktopShell ? "REMOTE SESSION" : "JOYCE MOORE"} <i>／</i> <span id="clock">00:00:00</span></span><button data-action="replay" title="重播启动流程">REINITIALIZE ↗</button></footer>
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
const storedPrefs = readLocal<Partial<{ sound: boolean; music: boolean; soundVolume: number; musicVolume: number; reduced: boolean; quality: boolean; rendering: RenderQuality; renderingChosen: boolean; superPerformance: boolean; colorTheme: "light" | "dark"; palette: ThemeName }>>("rhine-settings", {});
const prefs = {
  sound: true,
  music: storedPrefs.sound ?? true,
  soundVolume: .55,
  musicVolume: .5,
  reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
  quality: true,
  superPerformance: false,
  ...storedPrefs,
  // A phone starts on the `mobile` preset and stays there until a preset or a control is picked in
  // settings (`renderingChosen`); older installs saved the desktop default without ever choosing it.
  rendering: isAndroid && storedPrefs.renderingChosen !== true
    ? { ...qualityPresets.mobile }
    : normalizeQuality(storedPrefs.rendering, storedPrefs.quality !== false),
  colorTheme: storedPrefs.colorTheme === "dark" ? "dark" : "light",
  // Which pair of endpoints the light/dark interpolation runs between. An
  // unknown or absent name leaves the shell's own default in place.
  palette: (THEMES as readonly string[]).includes(storedPrefs.palette ?? "")
    ? (storedPrefs.palette as ThemeName)
    : undefined,
};
setPalette(prefs.palette);
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
configureHoverCards({ reduced: () => prefs.reduced, onShow: () => audio.play("hover") });
setSurfacePalette(prefs.palette ?? "warm");
audio.setVoice(VOICES[motifOf(prefs.palette)]);
/**
 * The theme change-over: the new theme's sound, then the window as it was
 * leaves in the new motif's pieces while the palette and the 3D surfaces
 * switch underneath at once.
 */
let markedPalette: ThemeName = prefs.palette ?? "warm";
function changePalette(name: ThemeName, origin: readonly [number, number]) {
  const motif = motifOf(name);
  // The corner card (theme-mark.ts) follows once the change-over has cleared the screen.
  showThemeMark({ stage: $("#stage"), from: markedPalette, to: name, reduced: prefs.reduced, visible: () => mode === "archive" && (scene?.sessionDeckFocus ?? 0) < 0.05 && !document.querySelector(".modal-backdrop:not([hidden])") });
  markedPalette = name;
  audio.setVoice(VOICES[motif]);
  audio.play("theme");
  const [light, dark] = signalsOf(name);
  const signals = prefs.colorTheme === "dark" ? dark : light;
  void playThemeReveal({
    motif,
    apply: () => { setPalette(name, true); setSurfacePalette(name); scene?.flipPalette(signals[0]); },
    accent: signals[0],
    second: signals[1],
    origin,
    reduced: prefs.reduced,
  });
}
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
/** One remembered card per lane. Host grouping rebuilds the lane set at runtime,
 *  so this is resized to match rather than built once and assumed fixed. */
const columnMemory = archiveColumns.map((_, lane) => columnFiles(lane)[0]);
function syncColumnMemory() {
  while (columnMemory.length < archiveColumns.length)
    columnMemory.push(columnFiles(columnMemory.length)[0]);
  columnMemory.length = archiveColumns.length;
  for (let lane = 0; lane < columnMemory.length; lane++)
    if (!columnFiles(lane).includes(columnMemory[lane]))
      columnMemory[lane] = columnFiles(lane)[0];
}
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
document.documentElement.dataset.superPerformance = String(superPerformanceEnabled());
function savePrefs() {
  saveAudioPrefs();
  document.documentElement.dataset.superPerformance = String(superPerformanceEnabled());
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
  document.querySelectorAll<HTMLElement>("button[data-color-palette]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.colorPalette === prefs.palette)));
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
let resizeTimer = 0;
/**
 * Re-measure the WebGL targets. A phone's soft keyboard slides in over a few
 * frames and each of them changes the viewport: reallocating the composer's
 * targets, the AO and bokeh buffers for every one is a visible hitch, so on
 * Android the last size wins after the animation has settled.
 */
function resizeScenes() {
  if (!isAndroid) { scene?.resize(); viewer?.resize(); return; }
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => { scene?.resize(); viewer?.resize(); }, 140);
}
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
    resizeScenes();
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
  // A cell crossed by a drag, a coast or a wheel run: the counters follow, the
  // titles wait and turn over once, when the plane settles (scene.onSettle).
  const passing = Boolean(scene?.coasting);
  scene?.select(selected, navigation);
  updateSelection(navigation, passing);
  const columnMove = navigation && "axis" in navigation && navigation.axis === "lane";
  if (!silent) audio.play(columnMove ? "column" : "tick", columnMove ? navigation.direction * .45 : 0, passing ? .35 : 1);
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
function updateSelection(navigation?: ArchiveNavigation, passing = false) {
  const r = records[selected];
  const host = hostAtCard(selected);
  const { lane } = fileLocation(selected);
  const files = columnFiles(lane);
  const animated = !prefs.reduced && mode === "archive" && !passing;
  if (!passing) {
    $("#selected-id").firstChild!.textContent = `${r.id.slice(0, 2)}`;
    selectionTitle.update({ text: host ? hostLabel(host) : r.title, animated });
    clearanceTitle.update({ text: host ? hostStateLabel(selected) : r.clearance, animated });
    categoryTitle.update({ text: host ? hostSubtitle(host) || r.category : r.category, animated });
  }
  const direction =
    navigation && "axis" in navigation
      ? navigation.direction > 0
        ? "up"
        : "down"
      : "auto";
  if (!passing) selectedCode.update({
    value: Number(r.id.slice(2)),
    animated,
    direction,
  });
  fileCounter.update({
    value: files.indexOf(selected) + 1,
    animated,
    direction:
      navigation && "axis" in navigation && navigation.axis === "row"
        ? direction
        : "auto",
  });
  $(".count-total").textContent = String(files.length).padStart(2, "0");
  columnCounter.update({
    value: lane + 1,
    animated,
    direction:
      navigation && "axis" in navigation && navigation.axis === "lane"
        ? direction
        : "auto",
  });
  if (!passing) columnTitle.update({ text: archiveColumns[lane], animated });
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
  $(".viewer-open").innerHTML = isDesktop && host ? '拆解模型 <span>↗</span>' : '360° 查看文档模型 <span>↗</span>';
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

function openModal(kind: NonNullable<typeof modal>): void { return modalController.openModal(modalContext, kind); }
function closeModal(afterClose?: () => void): void { return modalController.closeModal(modalContext, afterClose); }
function renderModal(): void { return modalController.renderModal(modalContext); }
function renderResults(): void { return modalController.renderResults(modalContext); }
function updateQualitySummary(): void { return modalController.updateQualitySummary(modalContext); }
function motionSettingsMarkup() {
  return `<div id="motion-preference-note" class="motion-preference-note"><p>${prefs.reduced
    ? `当前已减少动态效果。${matchMedia("(prefers-reduced-motion: reduce)").matches ? "系统也请求减少动画，可仅为本站启用完整动效。" : "关闭上方开关可恢复完整动效。"}`
    : "当前使用完整动效。"}</p>${prefs.reduced ? '<button data-action="enable-motion">启用完整动效并重播 ↻</button>' : ""}</div>`;
}
function settingsMarkup(): string { return modalController.settingsMarkup(modalContext); }

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
    configureAudio();
  }
  if ((e.target as HTMLElement).id === "archive-search") {
    searchQuery = (e.target as HTMLInputElement).value;
    renderResults();
  }
});
document.addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement;
  if (el.dataset.volume === "musicVolume" || el.dataset.volume === "soundVolume") {
    prefs[el.dataset.volume] = Number(el.value) / 100;
    saveAudioPrefs();
    if (el.dataset.volume === "soundVolume") audio.play("confirm");
  }
  if (el.id === "quality-preset" && Object.hasOwn(qualityPresets, el.value)) {
    prefs.rendering = { ...qualityPresets[el.value as QualityPreset] };
    prefs.renderingChosen = true;
    savePrefs();
  } else if (el.dataset.quality) {
    const key = el.dataset.quality as keyof RenderQuality;
    prefs.rendering = normalizeQuality({ ...prefs.rendering, [key]: key === "antialias" ? el.value : Number(el.value) });
    prefs.renderingChosen = true;
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
  const paletteButton = (e.target as Element).closest<HTMLElement>("button[data-color-palette]");
  if (paletteButton) {
    const name = paletteButton.dataset.colorPalette as ThemeName;
    if ((THEMES as readonly string[]).includes(name) && name !== prefs.palette) {
      prefs.palette = name;
      savePrefs();
      changePalette(name, [e.clientX / innerWidth, e.clientY / innerHeight]);
    }
    return;
  }
  if ((e.target as Element).closest('[data-action="sound-preview"]')) { audio.play("confirm"); return; }
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
  if (action === "model-viewer" && isDesktop && hostAtCard(selected)) { inspectSshHost(hostAtCard(selected)!.alias); return; }
  if (action === "model-viewer" && mode === "detail" && scene) {
    const activeScene = scene;
    // Safari does not always focus a button when it is tapped. Capture the
    // actual opener so closing the modal reliably restores the right control.
    el.focus({ preventScroll: true });
    viewer ??= new ModelViewer($(isDesktop ? "#viewport" : "#stage"), () => { historyNav.leave("viewer"); audio.setScene(mode); audio.play("page-close"); }, (sound) => audio.play(sound === "tick" ? "ui-tick" : sound));
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
  // A portal page covers the archive: only Escape reaches it.
  if (portals?.isPageOpen) {
    if (e.key === "Escape") { e.preventDefault(); portals.escape(); }
    return;
  }
  if (e.key === "Escape" && !modal && portals?.escape()) { e.preventDefault(); return; }
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
  if (["ArrowLeft", "ArrowRight"].includes(e.key) && mode !== "boot") {
    e.preventDefault();
    stepFile(e.key === "ArrowLeft" ? -1 : 1);
  }
  if (["ArrowUp", "ArrowDown"].includes(e.key) && mode !== "boot") {
    e.preventDefault();
    stepColumn(e.key === "ArrowUp" ? -1 : 1);
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
// The frame rate follows what is on screen (frame-budget.ts). Scripted browsers keep every frame
// unless ?frame-budget asks for the gate, and ?no-frame-budget turns it off; the wallpaper host paces itself.
const budgetQuery = new URLSearchParams(location.search);
const frameBudget = !isWallpaper && !budgetQuery.has("no-frame-budget") && (budgetQuery.has("frame-budget") || !navigator.webdriver)
  ? new FrameBudget(isAndroid ? ANDROID_RATES : DESKTOP_RATES) : undefined;
if (frameBudget) {
  // Input is motion the eye follows: hold the full rate for two seconds after it.
  for (const type of ["pointerdown", "pointermove", "pointerup", "wheel", "keydown", "touchstart", "touchmove"])
    window.addEventListener(type, () => frameBudget.busy(performance.now(), 2000), { passive: true, capture: true });
}
// The far-layer poster (theme-poster.ts): the theme's flat graphic behind the archive and its detail page.
const posterCanvas = desktopShell ? $<HTMLCanvasElement>("#theme-poster") : undefined;
const poster = posterCanvas ? new ThemePoster(posterCanvas) : undefined;
function updatePoster(time: number, amount: number) {
  if (!poster || !posterCanvas) return;
  const show = ready && (mode === "archive" || mode === "detail") && !sshSurfaceActive() && !viewer?.isOpen && !portals?.isPageOpen;
  posterCanvas.dataset.on = String(show);
  if (!show) return;
  const name = currentPalette();
  const { lane } = fileLocation(selected);
  const files = columnFiles(lane);
  poster.update({
    motif: motifOf(name),
    colors: { ink: paletteRgb(name, "ink", amount), accent: paletteRgb(name, "accent", amount), cyan: paletteRgb(name, "cyan", amount) },
    // The figure reads as the card's own number: X-001 becomes X.001.
    code: records[selected].id.replace("-", "."),
    position: files.indexOf(selected) + 1,
    count: files.length,
    group: archiveColumns[lane],
    time,
    reduced: prefs.reduced,
  });
}
// A phone that cannot hold its budget renders smaller instead of stuttering (frame-budget.ts ResolutionGovernor).
const governor = frameBudget && isAndroid ? new ResolutionGovernor() : undefined;
let governedAt = 0;
function governResolution(ms: number) {
  if (!governor || !frameBudget) return;
  const tier = frameBudget.tier;
  // Idle and background frames are held back on purpose: they are not the scene's cost.
  if (tier === "idle" || tier === "background") { governedAt = 0; return; }
  const dt = governedAt ? ms - governedAt : 0;
  governedAt = ms;
  const next = dt > 0 ? governor.observe(ms, dt, 1000 / 60) : null;
  if (next !== null) scene?.setDynamicScale(next);
}
let budgetMotion = 0, budgetSelected = -1;
/** Whether this animation frame does the full work. Everything not announced here is caught by motionSignature. */
function budgetAdmit(ms: number) {
  if (!frameBudget) return true;
  if (mode === "boot" || !ready || threeState === "loading" || viewer?.isOpen || playground?.active || scene?.flipActive) frameBudget.busy(ms, 250);
  else if (sshSurfaceActive() || modal) frameBudget.active(ms, 500);
  // Only a desktop window that lost focus drops to the background rate: a phone app that is not in front is not ticking.
  return frameBudget.admit(ms, isDesktop && document.visibilityState === "visible" && !document.hasFocus());
}
function frame(ms: number) {
  if (!wallpaperFrame(ms)) { requestAnimationFrame(frame); return; }
  if (document.hidden) { requestAnimationFrame(frame); return; }
  if (!budgetAdmit(ms)) { requestAnimationFrame(frame); return; }
  governResolution(ms);
  workbench?.tick();
  portals?.sync();
  scene?.setPageCovered(Boolean(portals?.isPageOpen));
  const time = ms / 1000;
  const theme = scene?.themeAmount ?? (prefs.colorTheme === "dark" ? 1 : 0);
  paintTheme(theme);
  updatePoster(time, theme);
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
  if (frameBudget && scene) {
    // Motion nobody announced (a new animation in the scene) still lifts the rate for half a second.
    const motion = scene.motionSignature();
    if (Math.abs(motion - budgetMotion) > 1e-4) frameBudget.busy(ms, 500);
    budgetMotion = motion;
    if (selected !== budgetSelected) { budgetSelected = selected; frameBudget.active(ms); }
  }
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
    // The digits roll on the compositor (WAAPI), not on this loop, so the clock does not lift the rate.
    updateFooterClock(new Date(), !prefs.reduced);
  }
  frameCount++;
  if (ms - frameStart > 1000) {
    fps = (frameCount * 1000) / (ms - frameStart);
    frameStart = ms;
    frameCount = 0;
    $("#three-scene").dataset.fps = String(Math.round(fps));
    if (frameBudget) $("#three-scene").dataset.budget = frameBudget.tier;
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
    scene.onSettle = () => { if (mode === "archive") updateSelection(); };
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
    if (scene) {
      bindScene(scene);
      scene.onContextLost = () => window.rhineDesktop?.captureError?.({ category: "renderer-error", level: "warning", reason: "error" }).catch(() => {});
    }
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
    // Opens the preferences sheet. Automation needs this because an SSH surface
    // guards the document against events from outside itself, so a check cannot
    // reach the settings button in the shell behind it.
    settings: () => openModal("settings"),
    stats: () => ({
      ...scene?.getStats(),
      threeState,
      fps: Math.round(fps),
      flipping: Boolean(scene?.flipActive),
      budget: frameBudget ? { tier: frameBudget.tier, admitted: frameBudget.admitted, skipped: frameBudget.skipped, refreshMs: Math.round(frameBudget.refreshMs * 10) / 10 } : null,
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
export const sshWorkspaceContext = {
  get $() { return $; },
  get sshBank() { return sshBank; },
  set sshBank(value: typeof sshBank) { sshBank = value; },
  get portals() { return portals; },
  set portals(value: typeof portals) { portals = value; },
  get prefs() { return prefs; },
  get audio() { return audio; },
  get openHostSession() { return openHostSession; },
  set openHostSession(value: typeof openHostSession) { openHostSession = value; },
  get started() { return started; },
  set started(value: typeof started) { started = value; },
  get mode() { return mode; },
  set mode(value: typeof mode) { mode = value; },
  get modal() { return modal; },
  set modal(value: typeof modal) { modal = value; },
  get viewer() { return viewer; },
  set viewer(value: typeof viewer) { viewer = value; },
  get playground() { return playground; },
  set playground(value: typeof playground) { playground = value; },
  get sshSurfaceActive() { return sshSurfaceActive; },
  set sshSurfaceActive(value: typeof sshSurfaceActive) { sshSurfaceActive = value; },
  get sshTerminalPending() { return sshTerminalPending; },
  set sshTerminalPending(value: typeof sshTerminalPending) { sshTerminalPending = value; },
  get sshOverview() { return sshOverview; },
  set sshOverview(value: typeof sshOverview) { sshOverview = value; },
  get openModal() { return openModal; },
  get sshClient() { return sshClient; },
  set sshClient(value: typeof sshClient) { sshClient = value; },
  get desktopModalScope() { return desktopModalScope; },
  set desktopModalScope(value: typeof desktopModalScope) { desktopModalScope = value; },
  get sshSurfaceBack() { return sshSurfaceBack; },
  set sshSurfaceBack(value: typeof sshSurfaceBack) { sshSurfaceBack = value; },
  get sshTerminal() { return sshTerminal; },
  set sshTerminal(value: typeof sshTerminal) { sshTerminal = value; },
  get selected() { return selected; },
  set selected(value: typeof selected) { selected = value; },
  get sshPromptOpen() { return sshPromptOpen; },
  set sshPromptOpen(value: typeof sshPromptOpen) { sshPromptOpen = value; },
  get auditOpen() { return auditOpen; },
  set auditOpen(value: typeof auditOpen) { auditOpen = value; },
  get setMode() { return setMode; },
  get patchHostState() { return patchHostState; },
  get closeSshTerminal() { return closeSshTerminal; },
  set closeSshTerminal(value: typeof closeSshTerminal) { closeSshTerminal = value; },
  get openSshTerminal() { return openSshTerminal; },
  set openSshTerminal(value: typeof openSshTerminal) { openSshTerminal = value; },
  get notify() { return notify; },
  get select() { return select; },
  get pendingDetailFocus() { return pendingDetailFocus; },
  set pendingDetailFocus(value: typeof pendingDetailFocus) { pendingDetailFocus = value; },
  get scene() { return scene; },
  set scene(value: typeof scene) { scene = value; },
  get sshDetailMotion() { return sshDetailMotion; },
  set sshDetailMotion(value: typeof sshDetailMotion) { sshDetailMotion = value; },
  get sshTabMotion() { return sshTabMotion; },
  set sshTabMotion(value: typeof sshTabMotion) { sshTabMotion = value; },
  get hostCards() { return hostCards; },
  get demoSsh() { return demoSsh; },
  get syncColumnMemory() { return syncColumnMemory; },
  get updateSelection() { return updateSelection; },
  get hostAtCard() { return hostAtCard; },
  get sshHosts() { return sshHosts; },
  set sshHosts(value: typeof sshHosts) { sshHosts = value; },
  get renderDetail() { return renderDetail; },
  get renderResults() { return renderResults; },
  get activeTab() { return activeTab; },
  set activeTab(value: typeof activeTab) { activeTab = value; },
  get setTab() { return setTab; },
  get connectHostAlias() { return connectHostAlias; },
  set connectHostAlias(value: typeof connectHostAlias) { connectHostAlias = value; },
  get openSshHosts() { return openSshHosts; },
  set openSshHosts(value: typeof openSshHosts) { openSshHosts = value; },
  get ready() { return ready; },
  set ready(value: typeof ready) { ready = value; },
  get closeModal() { return closeModal; },
  get pruneSshHistory() { return pruneSshHistory; },
  set pruneSshHistory(value: typeof pruneSshHistory) { pruneSshHistory = value; },
  get refreshHostDetailData() { return refreshHostDetailData; },
  get closeSshAudit() { return closeSshAudit; },
  set closeSshAudit(value: typeof closeSshAudit) { closeSshAudit = value; },
  get cancelSshPrompt() { return cancelSshPrompt; },
  set cancelSshPrompt(value: typeof cancelSshPrompt) { cancelSshPrompt = value; },
  get sshLibrary() { return sshLibrary; },
  set sshLibrary(value: typeof sshLibrary) { sshLibrary = value; },
  get openStoredRecord() { return openStoredRecord; },
  set openStoredRecord(value: typeof openStoredRecord) { openStoredRecord = value; },
  get stopSshSession() { return stopSshSession; },
  set stopSshSession(value: typeof stopSshSession) { stopSshSession = value; },
  get switchSshSession() { return switchSshSession; },
  set switchSshSession(value: typeof switchSshSession) { switchSshSession = value; },
  get inspectSshHost() { return inspectSshHost; },
  set inspectSshHost(value: typeof inspectSshHost) { inspectSshHost = value; },
  get historyNav() { return historyNav; },
  get superPerformanceEnabled() { return superPerformanceEnabled; },
  get effectiveRenderQuality() { return effectiveRenderQuality; },
  get openSshShortcut() { return openSshShortcut; },
  set openSshShortcut(value: typeof openSshShortcut) { openSshShortcut = value; },
  get syncArchiveChrome() { return syncArchiveChrome; },
  get sshFrame() { return sshFrame; },
  set sshFrame(value: typeof sshFrame) { sshFrame = value; },
  get sshAfterFrame() { return sshAfterFrame; },
  set sshAfterFrame(value: typeof sshAfterFrame) { sshAfterFrame = value; },
  get openSettingsSection() { return openSettingsSection; },
  set openSettingsSection(value: typeof openSettingsSection) { openSettingsSection = value; },
};
if (desktopShell) {
  void import("../features/ssh/bootstrap").then(module => module.initSshWorkspace(sshWorkspaceContext));
}
if (import.meta.hot) import.meta.hot.dispose(() => audio.dispose());
