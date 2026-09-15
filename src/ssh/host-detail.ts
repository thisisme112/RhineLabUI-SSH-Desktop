import { escapeHtml } from "../html";
import type { SshHostEntry, SessionRecordSummary } from "./client";
import { hostLabel, hostSubtitle } from "./host-cards";
import "./host-detail.css";

/**
 * The host card's detail surface.
 *
 * Same skeleton, same classes, same transitions as the archive's fiction
 * detail (`renderDetail` in main.ts) — only the data source changes: the
 * user's own ssh config and the session records their connections produced.
 * The dedicated host column uses the same visual language (R3: every value
 * shown here carries the source it was read from).
 */

export type HostDetailData = {
  /** Stored sessions for this host, newest first; null while loading. */
  records: SessionRecordSummary[] | null;
  recordsError?: string;
  /** Raw `ssh -v` lines of the newest session; null while loading. */
  latestLog: string[] | null;
  logTruncated?: boolean;
};

const formatWhen = (iso: string) => {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return iso || "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`;
};

const formatDuration = (ms: number) => {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 0)}s`;
  return `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
};

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes < 1) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
};

const orDefault = (value: string | undefined, fallback: string) =>
  value && value.trim()
    ? escapeHtml(value)
    : `<i class="host-default">${escapeHtml(fallback)}</i>`;

/**
 * Facts the live session has actually verified, shown in the card's existing
 * metadata grid. Nothing appears here that a real `ssh -v` line did not prove
 * (rule R3): before the handshake has said it, the cell stays as the card read
 * it from the config.
 */
export type HostLiveFacts = {
  address?: string;
  cipher?: string;
  authMethod?: string;
};

/** The whole `#detail-content` innerHTML for a host-bound card. */
export function hostDetailMarkup(args: {
  host: SshHostEntry;
  cardId: string;
  position: string;
  state: string;
  configPath: string;
  /** True while this host has a session, in which case the one action button
   *  leads to the session terminal instead of starting a new connection. */
  live?: boolean;
  retained?: boolean;
  /** Verified values from the running session, when there is one. */
  facts?: HostLiveFacts | null;
}): string {
  const { host, cardId, position, state, configPath, live, retained, facts } =
    args;
  const subtitle = hostSubtitle(host);
  const verified = (
    value: string | undefined,
    fallback: string,
    note: string,
  ) =>
    value
      ? `${escapeHtml(value)}<small class="host-verified">${escapeHtml(note)}</small>`
      : orDefault(fallback, "按 ssh 配置解析");
  // Keep local settings and history readable beside the physical terminal.
  const body = `<div class="detail-tabs" role="tablist"><button id="tab-overview" class="active" role="tab" aria-controls="tab-panel" aria-selected="true" data-tab="overview">01 <span>概述</span></button><button id="tab-config" role="tab" aria-controls="tab-panel" aria-selected="false" data-tab="config">02 <span>连接配置</span></button><button id="tab-notes" role="tab" aria-controls="tab-panel" aria-selected="false" data-tab="notes">03 <span>会话记录</span></button><button id="tab-history" role="tab" aria-controls="tab-panel" aria-selected="false" data-tab="history">04 <span>事件日志</span></button><i class="tab-indicator" aria-hidden="true"></i></div>
  <div id="tab-panel" class="tab-panel" role="tabpanel"></div>`;
  const actions = live
    ? `<button id="host-connect" class="solid-button" data-action="ssh-terminal">↗ OPEN TERMINAL<span>打开这次会话</span></button>`
    : `<button id="host-connect" class="solid-button" data-action="ssh-connect">⇄ CONNECT<span>连接这台主机</span></button>`;
  return `
  <div class="detail-kicker"><span>FILE ${escapeHtml(cardId)} / SSH HOST</span><span id="host-state">${escapeHtml(state)}</span></div>
  <h2>${escapeHtml(hostLabel(host))}</h2><div class="detail-title-cn">${escapeHtml(subtitle || "使用 ssh 配置中的默认值")}<span>SSH 主机</span></div>
  <div class="detail-rule"></div>
  <dl class="metadata"><div><dt>HOSTNAME / 地址</dt><dd>${verified(facts?.address, host.hostname, "已验证")}</dd></div><div><dt>USER / 用户</dt><dd>${orDefault(host.user, "按 ssh 配置解析")}</dd></div><div><dt>PORT / 端口</dt><dd>${orDefault(host.port, "22（默认）")}</dd></div><div><dt>STATUS / 状态</dt><dd><i></i><span id="host-state-side">${escapeHtml(state)}</span></dd></div></dl>
  ${body}
  <div class="detail-actions">${actions}<button class="export-button" data-action="ssh-new-session">新开会话 ＋</button><button id="host-disconnect" class="export-button" data-action="ssh-disconnect" ${live ? "" : "hidden"}>结束会话</button><button id="host-last-terminal" class="export-button" data-action="ssh-terminal" ${retained && !live ? "" : "hidden"}>查看终端输出 ↗</button></div>
  <div class="detail-footnote"><span title="${escapeHtml(configPath)}">SSH HOST · ${host.source === "saved" ? "本机保存" : "SSH config"}</span><span>${position}</span></div>`;
}

/** The first archive in the dedicated host column is its directory. */
export function hostDirectoryMarkup(hosts: readonly SshHostEntry[], loaded: boolean): string {
  const saved = hosts.filter(host => host.source === "saved").length;
  return `<div class="detail-kicker"><span>FILE H-000 / LOCAL DIRECTORY</span><span>SSH HOST ARCHIVES</span></div>
    <h2>HOST ARCHIVES</h2><div class="detail-title-cn">主机档案<span>连接从这里开始</span></div><div class="detail-rule"></div>
    <dl class="metadata"><div><dt>HOSTS / 主机</dt><dd id="host-directory-total">${loaded ? String(hosts.length).padStart(2, "0") : "正在读取…"}</dd></div><div><dt>SOURCES / 来源</dt><dd id="host-directory-sources">本机 ${saved} · SSH config ${hosts.length - saved}</dd></div></dl>
    <div class="detail-tabs" role="tablist"><button id="tab-overview" class="active" role="tab" aria-controls="tab-panel" aria-selected="true" data-tab="overview">01 <span>主机档案</span></button><button id="tab-config" role="tab" aria-controls="tab-panel" aria-selected="false" data-tab="config">02 <span>建立连接</span></button><button id="tab-notes" role="tab" aria-controls="tab-panel" aria-selected="false" data-tab="notes">03 <span>会话记录</span></button><i class="tab-indicator" aria-hidden="true"></i></div>
    <div id="tab-panel" class="tab-panel" role="tabpanel"></div>
    <div class="detail-actions host-directory-actions"><button class="solid-button" data-action="ssh-new">＋ NEW CONNECTION<span>建立连接</span></button><button class="export-button" data-action="ssh-refresh">刷新档案 ↻</button></div>
    <div class="detail-footnote"><span>LOCAL HOST ARCHIVES</span><span>H-000</span></div>`;
}

export function directorySessionsMarkup(data: HostDetailData): string {
  const header = '<div class="panel-label">ALL SESSIONS / 全部会话记录</div>';
  if (data.records === null) return `${header}<p class="host-loading">正在读取会话记录…</p>`;
  if (data.recordsError) return `${header}<p class="log-note">${escapeHtml(data.recordsError)}</p>`;
  return `${header}${data.records.length ? `<ol class="host-sessions">${data.records.map(record => `<li><button type="button" class="host-session-row host-directory-session" data-record-file="${escapeHtml(record.file)}"><span>${escapeHtml(record.targetLabel || (record.target.startsWith("rhine-profile:") ? "主机会话" : record.target))}<small>${formatWhen(record.startedAt)}</small></span><span>${escapeHtml(record.outcome)}</span><b>${formatDuration(record.durationMs)}</b></button></li>`).join("")}</ol>` : '<p class="log-note">还没有会话记录。连接结束后会自动归档。</p>'}<p class="log-note">移除主机后仍可在此查看记录。</p><button type="button" class="export-button host-prune" data-action="ssh-prune">清理过期记录 ↗</button>`;
}

/** 01 概述: the config block this host was read from, plus the last session. */
export function hostOverviewMarkup(
  host: SshHostEntry,
  data: HostDetailData,
): string {
  const latest = data.records?.[0];
  return `<div class="panel-label">${host.source === "saved" ? "CONNECTION / 连接参数" : "SSH CONFIG / 配置来源"}</div><pre class="host-raw">${escapeHtml(host.raw?.trim() || `Host ${hostLabel(host)}`)}</pre>${host.identityFile && host.source !== "saved" ? `<p class="log-note">IdentityFile ${escapeHtml(host.identityFile)}</p>` : ""}<div class="panel-label">LAST SESSION / 最近会话</div>${
    data.records === null
      ? `<p class="host-loading">正在读取会话记录…</p>`
      : latest
        ? `<div class="log-row"><span>${formatWhen(latest.startedAt)}</span><span>${escapeHtml(latest.outcome || "—")}</span><b>${formatDuration(latest.durationMs)} · ↓${formatBytes(latest.bytesIn)} ↑${formatBytes(latest.bytesOut)}</b></div>`
        : `<p class="log-note">还没有连接过。第一次会话结束后，记录会自动保存在这里。</p>`
  }`;
}

/** 03 会话记录: every stored session for this host; a row opens the full record. */
export function hostSessionsMarkup(
  host: SshHostEntry,
  data: HostDetailData,
): string {
  if (data.records === null)
    return `<div class="panel-label">SESSIONS / 会话记录</div><p class="host-loading">正在读取会话记录…</p>`;
  if (data.recordsError)
    return `<div class="panel-label">SESSIONS / 会话记录</div><p class="log-note">${escapeHtml(data.recordsError)}</p>`;
  if (!data.records.length)
    return `<div class="panel-label">SESSIONS / 会话记录</div><p class="log-note">这台主机还没有已保存的会话记录。记录与原始事件日志并排存放在用户数据目录的 ssh-logs 里。</p>`;
  return `<div class="panel-label">SESSIONS / 会话记录 · ${data.records.length}</div><ol class="host-sessions">${data.records
    .map(
      (record) =>
        `<li><button type="button" class="host-session-row" data-record-file="${escapeHtml(record.file)}"><span>${formatWhen(record.startedAt)}</span><span>${escapeHtml(record.outcome || "—")}</span><b>${formatDuration(record.durationMs)} · ↓${formatBytes(record.bytesIn)} ↑${formatBytes(record.bytesOut)}</b></button></li>`,
    )
    .join(
      "",
    )}</ol><p class="log-note">点击一条记录查看完整协商结果、阶段耗时与原始出处。</p>`;
}

/** 04 事件日志: the raw `ssh -v` lines of the newest session (rule R3). */
export function hostLogMarkup(
  host: SshHostEntry,
  data: HostDetailData,
): string {
  if (data.latestLog === null)
    return `<div class="panel-label">EVENT LOG / 事件日志</div><p class="host-loading">${data.records === null ? "正在读取事件日志…" : "没有可显示的事件日志。"}</p>`;
  if (!data.latestLog.length)
    return `<div class="panel-label">EVENT LOG / 事件日志</div><p class="log-note">最近会话没有留下事件日志。</p>`;
  return `<div class="panel-label">EVENT LOG / 最近会话的 ssh -v 原始输出${data.logTruncated ? "（末尾 200 行）" : ""}</div><pre class="host-raw host-log">${escapeHtml(data.latestLog.join("\n"))}</pre>`;
}
