import type { AudioPreferences } from "./audio";

export function audioSettingsMarkup(prefs: AudioPreferences) {
  return `<div class="audio-settings">${(
    [
      ["sound", "soundVolume", "INTERFACE SOUND", "操作、连接与换主题音效 · 音色随主题变化"],
      ["music", "musicVolume", "BACKGROUND MUSIC", "观测室 · 背景音乐"],
    ] as const
  )
    .map(
      ([toggle, volume, title, description]) => `<div class="audio-setting">
    <label class="audio-toggle"><div><strong>${title}</strong><span>${description}</span></div><input type="checkbox" data-pref="${toggle}" ${prefs[toggle] ? "checked" : ""}/><i class="toggle"></i></label>
    <label class="audio-volume"><span>${toggle === "sound" ? "音效" : "音乐"}音量</span><input aria-label="${toggle === "sound" ? "音效" : "音乐"}音量" data-volume="${volume}" type="range" min="0" max="100" step="1" value="${Math.round(prefs[volume] * 100)}"/><output>${Math.round(prefs[volume] * 100)}%</output></label>${toggle === "sound" ? '<button type="button" class="audio-preview" data-action="sound-preview">试听当前主题音色 ↗</button>' : ""}
  </div>`,
    )
    .join("")}</div>`;
}
