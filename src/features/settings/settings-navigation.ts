export type SettingsSection = "appearance" | "terminal" | "connection" | "security" | "data";
const SECTIONS: [SettingsSection, string][] = [["appearance", "外观"], ["terminal", "终端"], ["connection", "连接"], ["security", "安全"], ["data", "数据"]];
/** "01" for the appearance section, "05" for data: the label design prints it as the sheet's giant figure. */
export const settingsSectionNumber = (section: SettingsSection) => String(SECTIONS.findIndex(([id]) => id === section) + 1).padStart(2, "0");
export function settingsNavigation(active: SettingsSection) {
  return `<span class="settings-figure label-figure" data-slit aria-hidden="true">${settingsSectionNumber(active)}</span><nav class="settings-sections" aria-label="设置分类">${SECTIONS.map(([id, label], i) => `<button type="button" data-settings-section="${id}" aria-current="${active === id ? "page" : "false"}"><b aria-hidden="true">${String(i + 1).padStart(2, "0")}</b>${label}</button>`).join("")}</nav>`;
}
