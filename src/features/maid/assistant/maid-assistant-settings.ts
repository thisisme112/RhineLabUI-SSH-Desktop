import { MaidAssistant, defaultLink, maidAssistant, type Link } from "./maid-assistant";

/**
 * 设置 → 看板娘, the assistant's half (the Unreal build's RhineSettings.cpp, desktop only): each maid's key (typed here
 * and sealed in the main process; never shown again), the workspace of an organisation key, each maid's link (the API's
 * shape, where it is, the model, the quick model; DeepSeek's thinking and her fill-in-the-middle endpoint), the models
 * and how hard Claude thinks, and what she may do: the command history, the terminal shared, read-only commands let
 * through, completion, remarks, keeping the conversations, a greeting or a new start, and the API's own words for the
 * last failure.
 */
let greet: (text: string) => void = () => {};
/** How the settings' 打个招呼 reaches her (the workbench asks with what she can see). */
export function setMaidGreeter(fn: (text: string) => void) { greet = fn; }
const notices: Record<string, string> = {};
const escape = (value: string) => value.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

type LinkField = "base" | "model" | "fast" | "fim";
const FIELD_HINT: Record<LinkField, [string, string]> = {
  base: ["https://api.anthropic.com", "https://api.deepseek.com（Anthropic 格式填 …/anthropic）"],
  model: ["模型 ID，可填任意名字", "模型 ID，可填任意名字"],
  fast: ["补全和主动搭话用的模型", "补全和主动搭话用的模型"],
  fim: ["", "FIM 接入点，留空则用快速模型补全"],
};

/** The rows' dynamic words, keyed by data-maid-bind. */
function binds(): Record<string, string> {
  const a = maidAssistant;
  const keyStatus = (deep: boolean) => notices[deep ? "deepseekKey" : "claudeKey"]
    || (a.keySourceOf(deep) === "saved" ? (deep ? "已保存，加密存于本机 · 鲸娘主题里由大肥鱼应答" : "已保存，加密存于本机")
      : a.keySourceOf(deep) === "env" ? `使用环境变量 ${deep ? "DEEPSEEK_API_KEY" : "ANTHROPIC_API_KEY"}` : deep ? "未设置 · platform.deepseek.com 创建" : "未设置");
  const model = (deep: boolean) => { const at = a.modelIndexOf(deep); return at >= 0 ? MaidAssistant.modelsOf(deep)[at].note : "自定义：" + a.modelOf(deep); };
  const shape = (deep: boolean) => a.linkOf(deep).format === "openai" ? "POST <接入点>/chat/completions · Bearer key" : "POST <接入点>/v1/messages · x-api-key";
  const thinking = a.linkOf(true).thinking;
  const who = a.isDeepSeek ? "大肥鱼" : "小克";
  return {
    claudeKey: keyStatus(false), deepseekKey: keyStatus(true),
    workspace: a.workspace ? "请求会带上这个工作区" : "组织级 key 才需要 · Console → Settings → Workspaces",
    claudeFormat: shape(false), deepseekFormat: shape(true),
    claudeBase: a.endpoint(false, a.linkOf(false).format === "openai" ? "/chat/completions" : "/v1/messages"),
    deepseekBase: a.endpoint(true, a.linkOf(true).format === "openai" ? "/chat/completions" : "/v1/messages"),
    claudeModelName: "对话用 · 当前 " + a.modelOf(false), deepseekModelName: "对话用 · 当前 " + a.modelOf(true),
    claudeFast: "补全、主动搭话用（不思考）", deepseekFast: "补全、主动搭话用（不思考）",
    deepseekFim: a.linkOf(true).fim ? "FIM 补全：只续写当前这一行，不思考" : "留空：用快速模型的 JSON 补全",
    claudeModel: model(false), deepseekModel: model(true),
    effort: ["回得快，适合简单的事", "快和细之间", "想得最周到，回得慢一些"][a.effortIndex],
    deepseekThinking: thinking === 0 ? "不思考，回得最快" : thinking === 4 ? "不发送思考参数（其他 OpenAI 兼容服务用）" : "思考过程会折叠显示在对话里",
    history: `${a.historyChoice === 2 ? "打字时灰字提示，→ 填入" : a.historyChoice === 1 ? "只给 AI 补全参考" : "不再记录新命令"} · 已记 ${a.historyCount} 条，加密存于本机`,
    share: a.sharesTerminal ? `最近 40 行会随问题发给 ${a.isDeepSeek ? "DeepSeek" : "Anthropic"}` : "她看不到终端里的内容",
    trust: a.trustsReading ? "ls、cat、df、journalctl… 不带管道和重定向时直接跑；密钥类文件仍会问" : "在终端里执行、读文件前都等你点「运行」",
    complete: a.completes === 2 ? "停止打字 0.7 秒后发送光标附近 30 行 · → 填入" : a.completes === 1 ? "Ctrl+Enter 或 Ctrl+Shift+Space · → 填入" : "任何主题下都可用",
    proactive: a.proactive ? "触发时自动发送该命令和它的输出（至多 25 行）" : "她只在被问到时才联网",
    persist: a.persists ? "每台主机的对话都加密保存在本机" : "关闭应用后她不记得之前的对话",
    talk: a.isBusy ? "正在问…" : a.lastError ? "上次出错，原因见下" : a.replySerial > 0 ? `${who}：${a.reply}` : `模型 ${a.modelName}`,
    error: a.lastError ? "上次出错：" + a.lastError : "",
  };
}

/** Which chip of each row is chosen. */
function chosen(): Record<string, number> {
  const a = maidAssistant;
  return {
    claudeFormat: a.linkOf(false).format === "openai" ? 1 : 0, deepseekFormat: a.linkOf(true).format === "openai" ? 1 : 0,
    claudeModel: a.modelIndexOf(false), deepseekModel: a.modelIndexOf(true), effort: a.effortIndex, deepseekThinking: a.linkOf(true).thinking,
    history: a.historyChoice, share: a.sharesTerminal ? 1 : 0, trust: a.trustsReading ? 1 : 0, complete: a.completes, proactive: a.proactive, persist: a.persists ? 1 : 0, talk: -1,
  };
}

const row = (name: string, bind: string, controls: string) =>
  `<div class="theme-settings maid-row"><div><strong>${name}</strong><span data-maid-bind="${bind}">${escape(binds()[bind] ?? "")}</span></div><div class="theme-choices maid-controls">${controls}</div></div>`;
const chips = (key: string, names: string[]) => names.map((name, i) => `<button type="button" data-maid-chip="${key}" data-value="${i}" aria-pressed="${chosen()[key] === i}">${name}</button>`).join("");
const input = (key: string, hint: string, value = "", password = false) =>
  `<input class="maid-setting-input" data-maid-input="${key}" type="${password ? "password" : "text"}" placeholder="${escape(hint)}" value="${escape(value)}" spellcheck="false" autocomplete="off"/>`;
const button = (action: string, key: string, label: string) => `<button type="button" data-maid-${action}="${key}">${label}</button>`;

function linkRows(deep: boolean) {
  const who = deep ? "DeepSeek" : "Claude", k = deep ? "deepseek" : "claude", link = maidAssistant.linkOf(deep);
  const field = (field: LinkField, name: string, bind: string) =>
    row(`${who} ${name}`, bind, input(`${k}:${field}`, FIELD_HINT[field][deep ? 1 : 0], link[field]) + button("save", `${k}:${field}`, "保存") + button("default", `${k}:${field}`, "默认"));
  return row(`${who} 接口`, `${k}Format`, chips(`${k}Format`, ["Anthropic 格式", "OpenAI 格式"]))
    + field("base", "接入点", `${k}Base`) + field("model", "模型名", `${k}ModelName`) + field("fast", "快速模型", `${k}Fast`);
}

/** The rows, for the settings list (desktop, where the assistant is). */
export function maidAssistantSettingsMarkup() {
  if (!maidAssistant.available) return "";
  void maidAssistant.refreshKeys();
  const models = (deep: boolean) => MaidAssistant.modelsOf(deep).map(m => m.name);
  return `<div class="maid-assistant-settings">`
    + `<p class="maid-settings-head">看板娘 · 对话助手<small>小克（Claude 主题）和大肥鱼（鲸娘主题）用你自己的 API key 应答；key 加密存于本机，只在主进程里使用</small></p>`
    + row("Claude key", "claudeKey", input("claudeKey", "sk-ant-…  粘贴后点保存", "", true) + button("save", "claudeKey", "保存") + button("clear", "claudeKey", "清除"))
    + row("Workspace ID", "workspace", input("workspace", "wrkspc_…  留空表示 key 已绑定工作区", maidAssistant.workspace) + button("save", "workspace", "保存"))
    + linkRows(false)
    + row("Claude 模型", "claudeModel", chips("claudeModel", models(false)))
    + row("Claude 思考", "effort", chips("effort", ["轻松", "适中", "认真"]))
    + row("DeepSeek key", "deepseekKey", input("deepseekKey", "sk-…  DeepSeek 开放平台的 key，粘贴后点保存", "", true) + button("save", "deepseekKey", "保存") + button("clear", "deepseekKey", "清除"))
    + row("DeepSeek 模型", "deepseekModel", chips("deepseekModel", models(true)))
    + linkRows(true)
    + row("DeepSeek 思考", "deepseekThinking", chips("deepseekThinking", ["关", "低", "高", "最高", "服务器默认"]))
    + row("DeepSeek 补全", "deepseekFim", input("deepseek:fim", FIELD_HINT.fim[1], maidAssistant.linkOf(true).fim) + button("save", "deepseek:fim", "保存") + button("default", "deepseek:fim", "默认"))
    + row("命令历史", "history", chips("history", ["不记录", "只记录", "记录并补全"]) + button("forget", "history", "清空"))
    + row("终端内容", "share", chips("share", ["不共享", "提问时附带最近一屏"]))
    + row("她执行命令", "trust", chips("trust", ["每条都问我", "只读的自动放行"]))
    + row("终端补全", "complete", chips("complete", ["关", "按快捷键", "停顿时自动"]))
    + row("主动搭话", "proactive", chips("proactive", ["关", "报错时", "报错和偶尔闲聊"]))
    + row("跨重启保留", "persist", chips("persist", ["关", "保留对话"]))
    + row("对话", "talk", chips("talk", ["打个招呼", "重新开始"]))
    + `<p class="maid-settings-error" data-maid-bind="error">${escape(binds().error)}</p>`
    + `<p class="maid-settings-note">在 Claude 或 DeepSeek 主题下，主页点她脚边的「和小克说话」、终端里点工具栏的「问小克」「问大肥鱼」就能和她说话（上面几项两位共用）。她可以替你选主机、发起连接、切换侧栏；要在远程主机上运行的命令，会先在对话面板里等你点「运行」。Max 和 Team 订阅每月附带 API 额度，在 claude.ai 的 Billing 里关联 Console 组织后创建 key；DeepSeek 的 key 在 platform.deepseek.com 创建。</p>`
    + `</div>`;
}

function refresh() {
  const words = binds(), picks = chosen();
  for (const node of document.querySelectorAll<HTMLElement>("[data-maid-bind]")) {
    const value = words[node.dataset.maidBind!] ?? "";
    if (node.textContent !== value) node.textContent = value;
  }
  for (const chip of document.querySelectorAll<HTMLElement>("[data-maid-chip]")) chip.setAttribute("aria-pressed", String(picks[chip.dataset.maidChip!] === Number(chip.dataset.value)));
}
maidAssistant.onChange(() => { if (document.querySelector(".maid-assistant-settings")) refresh(); });

function choose(key: string, i: number) {
  const a = maidAssistant;
  const format = (deep: boolean) => a.setLink(deep, { ...a.linkOf(deep), format: i ? "openai" : "anthropic" });
  switch (key) {
    case "claudeFormat": format(false); break;
    case "deepseekFormat": format(true); break;
    case "claudeModel": a.setModelOf(false, i); break;
    case "deepseekModel": a.setModelOf(true, i); break;
    case "effort": a.setEffort(i); break;
    case "deepseekThinking": a.setLink(true, { ...a.linkOf(true), thinking: i }); break;
    case "history": a.setHistoryMode(i); break;
    case "share": a.setShareTerminal(i === 1); break;
    case "trust": a.setTrustReading(i === 1); break;
    case "complete": a.setComplete(i); break;
    case "proactive": a.setProactive(i); break;
    case "persist": a.setPersist(i === 1); break;
    case "talk": if (i === 0) greet(a.isDeepSeek ? "你好，大肥鱼！" : "你好，小克。"); else { a.reset(); delete notices.claudeKey; delete notices.deepseekKey; } break;
  }
  refresh();
}

async function save(key: string, root: Element) {
  const a = maidAssistant, field = root.querySelector<HTMLInputElement>(`[data-maid-input="${key}"]`), value = field?.value ?? "";
  if (key === "claudeKey" || key === "deepseekKey") {
    const error = await a.saveKey(key === "deepseekKey", value);
    notices[key] = error || "已保存，加密存于本机";
    if (!error && field) field.value = "";
  } else if (key === "workspace") { a.setWorkspace(value); if (field) field.value = a.workspace; }
  else {
    const [who, part] = key.split(":") as ["claude" | "deepseek", keyof Link];
    const deep = who === "deepseek";
    a.setLink(deep, { ...a.linkOf(deep), [part]: value });
    if (field) field.value = String(a.linkOf(deep)[part]);
  }
  refresh();
}

document.addEventListener("click", event => {
  const target = (event.target as Element).closest<HTMLElement>("[data-maid-chip],[data-maid-save],[data-maid-clear],[data-maid-default],[data-maid-forget]");
  if (!target || !target.closest(".maid-assistant-settings")) return;
  const root = target.closest(".maid-assistant-settings")!;
  if (target.dataset.maidChip) choose(target.dataset.maidChip, Number(target.dataset.value));
  else if (target.dataset.maidSave) void save(target.dataset.maidSave, root);
  else if (target.dataset.maidClear) {
    const deep = target.dataset.maidClear === "deepseekKey";
    notices[target.dataset.maidClear] = "已清除";
    void maidAssistant.forgetKey(deep).then(refresh);
  } else if (target.dataset.maidDefault) {
    const [who, part] = target.dataset.maidDefault.split(":") as ["claude" | "deepseek", keyof Link];
    const deep = who === "deepseek", fallback = defaultLink(deep);
    maidAssistant.setLink(deep, { ...maidAssistant.linkOf(deep), [part]: fallback[part] });
    const field = root.querySelector<HTMLInputElement>(`[data-maid-input="${target.dataset.maidDefault}"]`);
    if (field) field.value = String(maidAssistant.linkOf(deep)[part]);
    refresh();
  } else if (target.dataset.maidForget) { maidAssistant.forgetHistory(); refresh(); }
});
document.addEventListener("keydown", event => {
  const field = (event.target as Element).closest?.<HTMLInputElement>("[data-maid-input]");
  if (!field || event.key !== "Enter") return;
  event.preventDefault();
  void save(field.dataset.maidInput!, field.closest(".maid-assistant-settings")!);
});
