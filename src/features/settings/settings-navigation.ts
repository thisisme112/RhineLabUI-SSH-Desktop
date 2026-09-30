export type SettingsSection = "appearance" | "terminal" | "connection" | "security" | "data";
export function settingsNavigation(active: SettingsSection) {
  const sections: [SettingsSection, string][] = [["appearance", "外观"], ["terminal", "终端"], ["connection", "连接"], ["security", "安全"], ["data", "数据"]];
  return `<nav class="settings-sections" aria-label="设置分类">${sections.map(([id, label]) => `<button type="button" data-settings-section="${id}" aria-current="${active === id ? "page" : "false"}">${label}</button>`).join("")}</nav>`;
}
