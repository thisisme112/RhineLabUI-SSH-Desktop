/** Text-only clipboard boundary. Never truncate commands silently. */
const MAX_CLIPBOARD_BYTES = 1024 * 1024;

function validateText(text) {
  if (typeof text !== "string") return "剪贴板内容必须是文本";
  if (Buffer.byteLength(text, "utf8") > MAX_CLIPBOARD_BYTES)
    return "文本超过 1 MiB，请分段操作";
  return null;
}

// Electron 44 moved the native clipboard API onto promises (readText():
// Promise<string>, writeText(): Promise<void>); awaiting also accepts the
// synchronous stand-ins used by smoke runs and tests.
function createTextClipboard(clipboard) {
  return {
    async readText() {
      try {
        const text = await clipboard.readText();
        const error = validateText(text);
        return error ? { ok: false, error } : { ok: true, text };
      } catch {
        return { ok: false, error: "无法读取剪贴板，请重试" };
      }
    },
    async writeText(text) {
      const error = validateText(text);
      if (error) return { ok: false, error };
      try {
        await clipboard.writeText(text);
        return { ok: true };
      } catch {
        return { ok: false, error: "无法写入剪贴板，请重试" };
      }
    },
  };
}

module.exports = { createTextClipboard, MAX_CLIPBOARD_BYTES };
