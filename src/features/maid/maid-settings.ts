import { currentPalette } from "../theme/theme-ui";
import { mascotOf } from "../theme/theme-design";
import { LOOK_COUNT, lookName } from "./maid-lines";
import { maidPrefs, onMaidPrefs, setMaidPrefs } from "./maid-prefs";
import { maidAssistantSettingsMarkup } from "./assistant/maid-assistant-settings";

/**
 * 设置 → 看板娘 (the Unreal build's RhineSettings.cpp, 小克): how she stands in the terminal, one look after another,
 * and whether a picture gives way to the pose of the moment. The rows sit in the settings list; their clicks are
 * taken here, once, for whichever settings page is open.
 */
const who = () => mascotOf(currentPalette()) ?? "claude";

export function maidSettingsMarkup() {
  return `<div class="theme-settings maid-settings"><div><strong>看板娘 · 终端形象</strong><span>小克 / 大肥鱼在终端角落的样子 · 鼠标滚轮停在她身上也能换，右键让她先躲起来</span></div>` +
    `<div class="theme-choices" role="group" aria-label="终端形象"><button type="button" data-maid-look="-1" aria-label="上一个形象">‹</button>` +
    `<span class="maid-look-name" data-maid-look-name aria-live="polite">${lookName(who(), maidPrefs.look)}</span>` +
    `<button type="button" data-maid-look="1" aria-label="下一个形象">›</button></div></div>` +
    `<label><div><strong>跟着心情变</strong><span>选了一张姿势时：摸头、出错、庆祝、发呆会临时换成对应的动作</span></div><input type="checkbox" data-maid-reacts ${maidPrefs.reacts ? "checked" : ""}/><i class="toggle"></i></label>` +
    maidAssistantSettingsMarkup();
}

document.addEventListener("click", event => {
  const button = (event.target as Element).closest<HTMLElement>("[data-maid-look]");
  if (!button) return;
  setMaidPrefs({ look: (maidPrefs.look + Number(button.dataset.maidLook) + LOOK_COUNT) % LOOK_COUNT });
});
document.addEventListener("change", event => {
  const input = event.target as HTMLInputElement;
  if (input.matches?.("[data-maid-reacts]")) setMaidPrefs({ reacts: input.checked });
});
onMaidPrefs(() => {
  for (const name of document.querySelectorAll<HTMLElement>("[data-maid-look-name]")) name.textContent = lookName(who(), maidPrefs.look);
  for (const input of document.querySelectorAll<HTMLInputElement>("[data-maid-reacts]")) input.checked = maidPrefs.reacts;
});
