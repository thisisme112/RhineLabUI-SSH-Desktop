import {
  records,
  categories,
  archiveColumns,
  columnFiles,
  fileLocation,
  archiveFiles,
  isActiveArchive,
} from "../archives/data";
import { escapeHtml } from "../../shared/html";
import { ContentTransition, SurfaceTransition } from "../../shared/ui-transitions";
import { settingsNavigation, type SettingsSection } from "./settings-navigation";
import { hostLabel, hostSubtitle, SshHostCards } from "../ssh/host-cards";
import { isWallpaper, wallpaperHost, wallpaperFrame, type WallpaperProperties } from "../../platform/wallpaper/wallpaper";
import { currentPalette, paintTheme, paletteRgb, setPalette, signalsOf, themeSettingsMarkup, THEMES, type ThemeName } from "../theme/theme-ui";
import { audioSettingsMarkup } from "./audio-settings";
import { qualityMarkup, syncQualityUI } from "./quality-settings";
import { initPwa, pwaSettingsMarkup } from "../../platform/pwa/pwa";
import { assetUrl } from "../../shared/asset-url";

type ModalContext = typeof import("../../app/application").modalContext;

export function openModal(runtimeContext: ModalContext, kind: NonNullable<typeof runtimeContext.modal>) {
  if (!runtimeContext.ready) return;
  if (!runtimeContext.modal && !runtimeContext.desktopModalScope) {
    runtimeContext.previousFocus = document.activeElement as HTMLElement;
    runtimeContext.modalSiblings = [...runtimeContext.$("#stage").children]
      .filter((node): node is HTMLElement => node instanceof HTMLElement && node.id !== "modal-root")
      .map((node) => ({ node, inert: node.inert }));
    runtimeContext.modalSiblings.forEach(({ node }) => (node.inert = true));
  }
  runtimeContext.modalClosing = false;
  runtimeContext.modal = kind;
  runtimeContext.historyNav.enter("modal");
  runtimeContext.desktopModalScope?.enter();
  runtimeContext.searchQuery = "";
  runtimeContext.filter = "全部档案";
  runtimeContext.audio.play("page-open");
  renderModal(runtimeContext);
}

export function closeModal(runtimeContext: ModalContext, afterClose?: () => void) {
  if (!runtimeContext.modal) {
    afterClose?.();
    return;
  }
  if (runtimeContext.modalClosing) return;
  // Consumed as the close begins, not when its animation ends: a back press
  // arriving during the transition must not fire a second close.
  runtimeContext.historyNav.leave("modal");
  runtimeContext.modalClosing = true;
  runtimeContext.audio.play("page-close");
  runtimeContext.modalTransition!.hide(runtimeContext.prefs.reduced, () => {
    runtimeContext.modal = null;
    runtimeContext.modalClosing = false;
    runtimeContext.$("#modal-root").replaceChildren();
    runtimeContext.modalTransition = undefined;
    if (runtimeContext.desktopModalScope) runtimeContext.desktopModalScope.leave();
    else {
      runtimeContext.modalSiblings.forEach(({ node, inert }) => (node.inert = inert));
      runtimeContext.modalSiblings = [];
      runtimeContext.$("#archive-ui").inert = runtimeContext.mode !== "archive" || Boolean(runtimeContext.workbench?.enabled);
      runtimeContext.$("#detail-ui").inert = runtimeContext.mode !== "detail";
      runtimeContext.previousFocus?.focus({ preventScroll: true });
    }
    afterClose?.();
  });
}

export function renderModal(runtimeContext: ModalContext) {
  if (!runtimeContext.modal) return;
  runtimeContext.modalTransition?.dispose();
  runtimeContext.$("#modal-root").innerHTML =
    `<div class="modal-backdrop"><section class="terminal-modal ${runtimeContext.modal === "settings" ? "settings-modal" : ""}" role="dialog" aria-modal="true" aria-label="${runtimeContext.modal === "settings" ? "系统设置" : runtimeContext.modal === "saved" ? "收藏档案" : "档案检索"}"><div class="modal-top"><span>RHINE LAB / ${runtimeContext.modal === "settings" ? "SYSTEM PREFERENCES" : "ARCHIVE DIRECTORY"}</span><button data-action="close-modal" aria-label="关闭窗口">CLOSE <span>×</span></button></div>${runtimeContext.modal === "settings" ? settingsMarkup(runtimeContext) : `<h2>${runtimeContext.modal === "saved" ? "SAVED ARCHIVES" : "ARCHIVE INDEX"}<small>${runtimeContext.modal === "saved" ? "收藏档案" : "内部档案检索"}</small></h2><div class="search-field"><span>⌕</span><input id="archive-search" type="search" autocomplete="off" placeholder="输入档案编号、名称或科室" aria-label="检索档案"/><span class="key">ESC</span></div><div class="category-filters">${categories.map((c, i) => `<button data-filter="${escapeHtml(c)}" class="${i === 0 ? "active" : ""}">${escapeHtml(c)}</button>`).join("")}</div><div class="result-header"><span>FILE / 档案</span><span>DEPARTMENT / 科室</span><span>ACCESS</span></div><div id="search-results" class="search-results"></div><div class="modal-bottom"><span id="result-count"></span><span>INTERNAL DATABASE <i>●</i> CONNECTED</span></div>`}</section></div>`;
  const backdrop = runtimeContext.$(".modal-backdrop");
  backdrop.hidden = true;
  runtimeContext.modalTransition = new SurfaceTransition(backdrop, runtimeContext.$(".terminal-modal"));
  runtimeContext.modalTransition.show(runtimeContext.prefs.reduced);
  if (runtimeContext.modal === "settings") {
    updateQualitySummary(runtimeContext);
    if (runtimeContext.desktopShell) {
      const heading = document.querySelector('.settings-modal h2')!;
      heading.textContent = '系统设置';
      heading.insertAdjacentHTML('afterend', settingsNavigation('appearance'));
      backdrop.querySelector('.settings-sections')!.addEventListener('click', event => {
        const section = (event.target as Element).closest<HTMLElement>('[data-settings-section]')?.dataset.settingsSection as SettingsSection | undefined;
        if (section && section !== 'appearance') closeModal(runtimeContext, () => runtimeContext.openSettingsSection(section));
      });
    }
  }
  if (runtimeContext.modal !== "settings") {
    renderResults(runtimeContext);
    requestAnimationFrame(() => {
      if (backdrop.isConnected && !runtimeContext.modalClosing) runtimeContext.$("#archive-search").focus();
    });
  } else
    requestAnimationFrame(() => {
      if (backdrop.isConnected && !runtimeContext.modalClosing) runtimeContext.$('[data-action="close-modal"]').focus();
    });
  runtimeContext.$("#modal-root")
    .querySelector(".modal-backdrop")
    ?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeModal(runtimeContext);
    });
}

export function renderResults(runtimeContext: ModalContext) {
  const results = archiveFiles()
    .map((i) => ({ r: records[i], i, host: runtimeContext.hostAtCard(i) }))
    .filter(
      ({ r, host }) =>
        (runtimeContext.modal !== "saved" || runtimeContext.saved.has(r.id)) &&
        (runtimeContext.filter === "全部档案" || r.category === runtimeContext.filter) &&
        (host
          ? `${r.id} ${hostLabel(host)} ${host.hostname} ${host.user} ${r.title} ${r.en} ${r.department} ${r.lead}`
          : `${r.id} ${r.title} ${r.en} ${r.department} ${r.lead}`
        )
          .toLowerCase()
          .includes(runtimeContext.searchQuery.toLowerCase()),
    );
  runtimeContext.$("#search-results").innerHTML = results.length
    ? results
        .map(
          ({ r, i, host }) =>
            `<button class="result-row" data-result="${i}"><span class="result-name"><b>${r.id}</b><span>${escapeHtml(host ? hostLabel(host) : r.title)}<small>${escapeHtml(host ? hostSubtitle(host) || "SSH 主机" : r.en)}</small></span>${runtimeContext.saved.has(r.id) ? "<i>＋</i>" : ""}</span><span>${escapeHtml(host ? "SSH 主机" : r.department)}</span><span>${host ? "SSH HOST" : r.clearance === "RESTRICTED" ? "CATALOG ONLY" : "AUTHORIZED"} <i>↗</i></span></button>`,
        )
        .join("")
    : `<div class="empty-results"><span>∅</span><strong>${runtimeContext.modal === "saved" && !runtimeContext.searchQuery ? "尚无收藏档案" : "没有匹配的档案"}</strong><p>${runtimeContext.modal === "saved" && !runtimeContext.searchQuery ? "读取档案时，选择 SAVE ARCHIVE 将其保存在此处。" : "尝试其他名称、档案编号，或切换科室分类。"}</p><button data-action="reset-search">${runtimeContext.modal === "saved" ? "查看全部档案 →" : "重置检索 →"}</button></div>`;
  runtimeContext.$("#result-count").textContent =
    `${String(results.length).padStart(2, "0")} RECORDS FOUND`;
}

export function updateQualitySummary(runtimeContext: ModalContext) {
  const summary = document.querySelector("#quality-summary");
  if (!summary) return;
  if (!runtimeContext.scene) { summary.textContent = "3D 已关闭 · 三维模型与渲染资源已释放"; return; }
  const canvas = runtimeContext.scene.renderer.domElement;
  const metrics = JSON.parse(canvas.parentElement?.dataset.renderQuality ?? "{}");
  summary.textContent = `${runtimeContext.superPerformanceEnabled() ? "超级性能模式已启用 · 画质设置暂被覆盖，关闭后恢复 · " : ""}实际渲染 ${canvas.width} × ${canvas.height} · ${runtimeContext.effectiveRenderQuality().antialias === "smaa" ? "SMAA" : "原始抗锯齿"} · 纹理 ${metrics.anisotropy ?? 1}×${metrics.limited ? " · 已达到缓冲上限" : ""}`;
}

export function settingsMarkup(runtimeContext: ModalContext) {
  return `<h2>SYSTEM SETTINGS<small>终端偏好设置</small></h2><p class="settings-intro">JOYCE MOORE <span>·</span> SESSION AUTHORIZED</p>${isWallpaper ? '<p class="wallpaper-settings-note">每次启动都会读取 Wallpaper Engine 中的设置。在此修改仅对当前运行生效，无法持久保存；如需保留，请在 Wallpaper Engine 的壁纸属性中调整。</p>' : ""}<div class="settings-list">${themeSettingsMarkup(runtimeContext.prefs.colorTheme === "dark", runtimeContext.prefs.palette)}${!isWallpaper ? `<label><div><strong>SUPER PERFORMANCE</strong><span>降低三维画质和渲染分辨率，保留完整动效；关闭后恢复原画质</span></div><input type="checkbox" data-pref="superPerformance" ${runtimeContext.prefs.superPerformance ? "checked" : ""}/><i class="toggle"></i></label>` : ""}${runtimeContext.workbench?.settingsMarkup() ?? ""}${audioSettingsMarkup(runtimeContext.prefs)}<label><div><strong>REDUCED MOTION</strong><span>跳过开机动画，简化选档、镜头和文字动效</span></div><input type="checkbox" data-pref="reduced" ${runtimeContext.prefs.reduced ? "checked" : ""}/><i class="toggle"></i></label></div>${runtimeContext.motionSettingsMarkup()}${qualityMarkup(runtimeContext.prefs.rendering)}${pwaSettingsMarkup()}<div class="settings-shortcuts">${isWallpaper ? '<span>DESKTOP CONTROLS</span><p>拖动阵列或点击界面按钮浏览档案。桌面模式下，方向键与滚轮可能无法传入壁纸。</p>' : `<span>KEYBOARD CONTROLS</span><p><kbd>←</kbd><kbd>→</kbd> 切列 <kbd>↑</kbd><kbd>↓</kbd> 选档 <kbd>ENTER</kbd> 读取${runtimeContext.desktopShell ? "·连接" : ""} <kbd>/</kbd> 检索 <kbd>ESC</kbd> 返回${runtimeContext.desktopShell ? ' <kbd>CTRL</kbd>+<kbd>SHIFT</kbd>+<kbd>S</kbd> 主机列表 <kbd>CTRL</kbd>+<kbd>SHIFT</kbd>+<kbd>E</kbd> 收起终端' : ""}</p>`}</div><div class="settings-bottom">${!isWallpaper && document.fullscreenEnabled ? '<button data-action="fullscreen">FULLSCREEN <span>↗</span></button>' : ''}<button data-action="restart">REINITIALIZE SYSTEM <span>↻</span></button></div><div class="modal-bottom"><span>ANALYSIS OS / 1.0 · 使用 MiSans 字体（小米） <a href="${assetUrl("fonts/MiSans-license.pdf")}" target="_blank" rel="noopener">字体许可</a></span><span>POWERED BY RHINE LAB</span></div>`;
}
