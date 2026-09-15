# SSH 主机管理与快速连接

> 本文保留第一版主机管理的实现与验证记录。用户随后要求将入口、配置和动效融入原档案页面；顶部按钮、独立管理弹窗和前 40 个档案绑定方案已由专属第六列替代。当前用法及验证见 [SSH 主机档案列与页面动效](SSH-ARCHIVE-UI.md)。

验证日期：2026-09-12。用户选择优先完善主机管理与快速连接，继续保留已认可的三维包装、标签、鉴权和终端操作。仅修改本地项目并提交，不推送。

## 使用行为

桌面顶部提供 **SSH 主机** 入口，保留 `Ctrl+Shift+S`。列表可搜索名称、地址或用户，并按全部、已保存、SSH config 筛选。支持新增、编辑、移除、快速连接与保存并连接；完整用法见 [桌面 SSH 说明](../docs/DESKTOP-SSH.md)。

表单支持名称、目标地址、用户名、端口、私钥路径、跳板机、连接超时、保活间隔和重试次数。新连接默认端口 22、超时 10 秒、保活 30 秒／3 次；清空可沿用系统 SSH 配置。以 SSH config 主机新建时保留原别名，避免把 `Host`、`Match`、跳板等继承规则平铺成不完整副本。

保存主机时回车执行保存；快速连接时回车执行连接。每种模式只有一个原生 submit 按钮，避免 Chromium 把隐藏的保存按钮当作快速连接的默认动作。保存失败时保留表单节点与内容，异步刷新和文件选择不会回填到已经离开的编辑表单。`Esc` 先返回列表再关闭窗口，`Tab` 保留当前模态焦点，小窗口正文可滚动到操作按钮。

结束后的终端提供“重新连接”。保存主机重新解析当前配置，快速连接保留本次完整参数；重连仍经过真实 SSH 认证。新会话清除旧终端缓冲，连接失败仍使用原认证失败面板。快速连接没有档案卡时使用常规终端，保存且绑定档案的主机继续自动开盒进入三维终端。

## 持久化与稳定关联

[electron/host-profiles.cjs](../electron/host-profiles.cjs) 管理 `userData/ssh-hosts.json`，不改写 `%USERPROFILE%/.ssh/config`。格式 version 1，最多 256 个主机，文件最多 2 MiB。

- 白名单只保存连接字段，不保存密码、私钥内容或任意额外参数。私钥选择器只返回文件路径，由系统 SSH 自己读取密钥。
- 每台保存主机具有 UUID，内部使用 `rhine-profile:<uuid>` 关联档案与历史。主进程解析为真实目标和选项后才启动系统 SSH；内部标识不作为 SSH 目标，也不用于界面标题。
- 改名保持同一档案位置和历史关联；历史记录的 `targetLabel` 保留连接当时的名称，旧版没有此字段的记录仍可读取。
- 文件 SHA-256 revision 拒绝过期编辑；写入临时文件后再原子替换。写入前校验 UTF-8 体积，读取失败、格式损坏、过大或不支持的文件不会被空配置覆盖。
- 活动会话关联的主机不能修改或移除，限制在主进程执行。移除主机后原系统配置和历史文件保留，历史继续按既有策略清理。

SSH 参数仍由主进程构造，新增 `-l`、`-J`、`ConnectTimeout`、`ServerAliveInterval` 和 `ServerAliveCountMax`。数值必须为相应范围的整数，0 只在保活间隔中有效；拒绝控制字符和不合法的目标／跳板参数。原 CSP、Electron 沙箱、IPC 来源校验和单会话限制保持启用。

## 验证

| 检查 | 结果和范围 |
| --- | --- |
| `npm run check:ssh-profiles` | 通过。新实例读回、中文名称、IPv6、带空格／中文的密钥路径、保活 0、稳定 UUID、旧 revision 拒绝、字段白名单、参数边界、删除后拒绝连接、损坏文件保留、超大写入保留原文件。 |
| `check:ssh-host`、`check:ssh-client`、`check:ssh-audit`、`check:ssh-handshake` | 通过。原主机解析、参数边界、会话生命周期、认证请求、记录与状态驱动回归。 |
| `check:ssh-pty-lifecycle`、`check:ssh-session` | 通过。12 次快速原生退出及立即停止、真实 ConPTY 流、尺寸变更和日志排重；未出现此前的主进程 resize 未捕获异常。 |
| `npm run smoke:desktop:hosts` | 41/41。实际 desktop bundle、Electron 沙箱 preload、磁盘保存与 ConPTY。验证原生回车保存／快速连接、保存并连接、实际 argv、终端键盘往返、活动配置保护、保存失败值保留、两种重连、改名后旧历史可读、移除、明暗与小窗口、Tab／Esc 与焦点恢复。 |
| `npm run smoke:desktop:session` | 85/85，无跳过。保留认证、输入、可信状态、导出、隐藏输出和模态过渡回归。旧的来源检查改为对照实际 loader 与列表条目，适配列表标题从路径变为主机数量。 |
| `npm run smoke:desktop:terminal` | 8/8。实际盒内终端、原生输入、收起／重开、退出后显示、事件排重与退出后 resize。 |
| `npm run smoke:desktop` | 15/15。桌面入口、快捷键、preload、实际 WebGL、开场及 PWA 隔离。 |
| `npm run build:desktop`、`npm run build` | 通过。网页 PWA 为 818 项、33.8 MiB。 |
| `npx vite build --mode wallpaper --outDir .tools/host-management-wallpaper` | 通过。独立目录编译检查，未覆盖使用中的壁纸发行包。网页与壁纸产物不包含 SSH 终端、主机编辑器或终端内胆资源。 |

逐项结果及构建资源检查见 [report.json](ssh-hosts/report.json) 和 [regression.json](ssh-hosts/regression.json)。主机管理冒烟会使用临时 userData 和专用 SSH config，自动结束测试会话，不写用户的实际主机配置。测试替身提供协商与 shell 文本，不等同于真实 SSH 服务器、真实私钥认证或远端跳板链路的成功验收。

已检查实际 Electron 的亮色表单与列表、保存主机进入三维终端、暗色表单以及 1024×640 小窗口滚动区域。截图在弹窗进入完成后额外等待 450ms，避免将过渡中的叠影当成静态画面。

- [亮色编辑表单](ssh-hosts/editor-light.png)、[列表和来源筛选](ssh-hosts/list-light.png)。
- [保存主机进入三维终端](ssh-hosts/connected.png)。
- [暗色编辑表单](ssh-hosts/editor-dark.png)、[小窗口滚动到底部操作区](ssh-hosts/editor-compact.png)。

保留既有 Vite 大 chunk 提示与偶发 Three.js X4122 精度警告；强制终止测试 PTY 时 node-pty 辅助进程仍可能打印 `AttachConsole failed`，相关测试退出码为 0。未通过停用沙箱或吞掉主进程异常来隐藏这些输出。
