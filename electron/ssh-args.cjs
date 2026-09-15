/**
 * ssh argv construction, owned by the main process.
 *
 * The renderer sends a *descriptor*, never a command: it can choose the target
 * and ssh options, but not the executable. That keeps the spawn boundary in the
 * privileged side while still letting the user see exactly what will run — the
 * built argv is returned to the renderer so it can be displayed verbatim (rule
 * R3: every animated value can be traced to its source).
 *
 * Two flags carry the design:
 *   -v            debug level 1, the source of every connection animation
 *
 * There is deliberately no `-E`: on Windows ssh keeps that file to itself
 * (`fs.openSync` fails with EBUSY until ssh exits), so the diagnostics are read
 * off the pty stream instead and the log file is written by the main process.
 * See electron/pty-events.cjs for the measurement behind that decision.
 */
const fs = require("node:fs");
const path = require("node:path");

/** Options a launch descriptor may set. Anything else is rejected. */
const VALUE_OPTIONS = new Set([
  "-L",
  "-R",
  "-D",
  "-o",
  "-i",
  "-p",
  "-l",
  "-J",
  "-c",
  "-m",
  "-b",
  "-e",
  "-w",
  "-W",
]);
const FLAG_OPTIONS = new Set(["-A", "-C", "-N", "-T", "-4", "-6", "-v"]);
// Local commands / config includes are inherited from the user's own config,
// never supplied by renderer JavaScript through -o or -F.
const CONFIG_OPTIONS = new Set([
  "connecttimeout",
  "connectionattempts",
  "serveraliveinterval",
  "serveralivecountmax",
  "tcpkeepalive",
  "exitonforwardfailure",
  "addressfamily",
  "batchmode",
  "preferredauthentications",
  "identitiesonly",
  "compression",
]);

/** Flags that would let the descriptor escape the boundary we just drew. */
const FORBIDDEN = new Set(["-E", "-S", "-f", "-O", "-G", "-Y", "-y"]);

function fail(message) {
  return { ok: false, error: message };
}

/**
 * Normalise and check an untrusted descriptor from the renderer.
 * Returns `{ ok: true, launch }` or `{ ok: false, error }`.
 */
function validateLaunch(input) {
  if (!input || typeof input !== "object") return fail("启动参数无效");
  const target = typeof input.target === "string" ? input.target.trim() : "";
  if (!target) return fail("缺少目标主机");
  if (target.length > 1024) return fail("目标主机过长");
  if (/\s/.test(target)) return fail("目标主机不能包含空白字符");
  if (/[\x00-\x1f\x7f;&|`$<>()\\"']/.test(target))
    return fail("目标主机包含无效字符");
  if (target.startsWith("-")) return fail("目标主机不能以连字符开头");

  const launch = { target };
  if (input.authMode !== undefined) {
    if (!["auto", "password", "key"].includes(input.authMode)) return fail("认证方式无效");
    launch.authMode = input.authMode;
  }
  if (input.keyId !== undefined && input.keyId !== "") {
    if (typeof input.keyId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.keyId)) return fail("密钥编号无效");
    launch.keyId = input.keyId;
  }
  if (launch.authMode === "key" && !launch.keyId && !input.identityFile) return fail("请选择用于登录的私钥");
  if (input.user !== undefined && input.user !== "") {
    if (
      typeof input.user !== "string" ||
      !/^[\p{L}\p{N}_.@\\-]{1,128}$/u.test(input.user.trim())
    )
      return fail("用户名包含无效字符");
    launch.user = input.user.trim();
  }
  if (input.identityFile !== undefined && input.identityFile !== "") {
    if (
      typeof input.identityFile !== "string" ||
      !input.identityFile.trim() ||
      input.identityFile.length > 4096 ||
      /[\x00-\x1f\x7f]/.test(input.identityFile)
    )
      return fail("私钥路径无效");
    launch.identityFile = input.identityFile;
  }
  if (input.jumpHost !== undefined && input.jumpHost !== "") {
    if (typeof input.jumpHost !== "string" || input.jumpHost.length > 1024)
      return fail("跳板机地址无效");
    const jumps = input.jumpHost.trim().split(",");
    if (
      jumps.some(
        (jump) =>
          !jump ||
          jump.startsWith("-") ||
          /[\s\x00-\x1f\x7f;&|`$<>()\\"']/.test(jump),
      )
    )
      return fail("跳板机请使用 [用户@]主机[:端口]，多个跳板机用逗号分隔");
    launch.jumpHost = jumps.join(",");
  }
  for (const [key, label, min, max] of [
    ["port", "端口", 1, 65535],
    ["connectTimeout", "连接超时", 1, 600],
    ["keepAliveInterval", "保活间隔", 0, 3600],
    ["keepAliveCountMax", "保活重试次数", 1, 30],
  ]) {
    if (input[key] === undefined || input[key] === "") continue;
    if (
      typeof input[key] !== "number" &&
      !(typeof input[key] === "string" && /^\d+$/.test(input[key].trim()))
    )
      return fail(`${label}必须是 ${min}–${max} 的整数`);
    const value = Number(input[key]);
    if (!Number.isInteger(value) || value < min || value > max)
      return fail(`${label}必须是 ${min}–${max} 的整数`);
    launch[key] = value;
  }
  if (input.extraArgs !== undefined) {
    if (!Array.isArray(input.extraArgs)) return fail("附加参数必须是数组");
    const extra = [];
    for (let i = 0; i < input.extraArgs.length; i++) {
      const option = input.extraArgs[i];
      if (typeof option !== "string") return fail("附加参数必须是字符串");
      if (FORBIDDEN.has(option)) return fail(`附加参数不允许使用 ${option}`);
      if (FLAG_OPTIONS.has(option)) {
        extra.push(option);
        continue;
      }
      if (!VALUE_OPTIONS.has(option)) return fail(`未知的附加参数 ${option}`);
      const value = input.extraArgs[++i];
      if (
        typeof value !== "string" ||
        !value ||
        value.startsWith("-") ||
        /[\0\r\n]/.test(value)
      )
        return fail(`${option} 缺少有效参数`);
      if (
        option === "-p" &&
        (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
      )
        return fail("端口必须是 1–65535 的整数");
      if (option === "-o") {
        const config = value.match(/^([A-Za-z]+)(?:\s*=\s*|\s+)(.+)$/);
        if (!config || !CONFIG_OPTIONS.has(config[1].toLowerCase()))
          return fail("该 SSH 配置项不能通过附加参数设置，请使用本机 ssh 配置");
      }
      extra.push(option, value);
    }
    if (extra.length) launch.extraArgs = extra;
  }
  return { ok: true, launch };
}

/**
 * @param {{target:string, logPath?:string, port?:number, identityFile?:string, extraArgs?:string[]}} launch
 */
function buildSshArgs(launch) {
  const args = ["-v"];
  if (launch.authMode === "password") args.push("-o", "PubkeyAuthentication=no", "-o", "PreferredAuthentications=password,keyboard-interactive");
  if (launch.authMode === "key") args.push("-o", "IdentitiesOnly=yes", "-o", "PreferredAuthentications=publickey,keyboard-interactive", "-o", "PasswordAuthentication=no");
  if (launch.user) args.push("-l", launch.user);
  if (launch.port !== undefined) args.push("-p", String(launch.port));
  if (launch.identityFile) args.push("-i", launch.identityFile);
  if (launch.jumpHost) args.push("-J", launch.jumpHost);
  for (const [field, option] of [
    ["connectTimeout", "ConnectTimeout"],
    ["keepAliveInterval", "ServerAliveInterval"],
    ["keepAliveCountMax", "ServerAliveCountMax"],
  ])
    if (launch[field] !== undefined)
      args.push("-o", `${option}=${launch[field]}`);
  if (launch.extraArgs?.length) args.push(...launch.extraArgs);
  args.push(launch.target);
  return args;
}

/** The system ssh, as the user's own `ssh` would be. */
function resolveSshPath() {
  const override = process.env.RHINE_SSH_PATH;
  if (override) return override;
  const candidates = [
    path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "OpenSSH",
      "ssh.exe",
    ),
    "ssh",
  ];
  for (const candidate of candidates) {
    if (candidate === "ssh") return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }
  return "ssh";
}

module.exports = { buildSshArgs, validateLaunch, resolveSshPath };
