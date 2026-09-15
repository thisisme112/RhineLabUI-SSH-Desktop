# SSH 主机档案列与页面动效

验证日期：2026-09-12。用户要求将 SSH 与原页面的动效、元素和档案阵列结合，本轮仅完善桌面 SSH，保留已经认可的盒内终端与自动开盒；只本地提交，不推送。

## 档案入口与连接管理

桌面使用第六列「SSH 主机」，第一份 `H-000` 为目录，其后为每台主机的独立档案。目录在导航初始化前注册；原五列 40 份内容没有被主机占用，`content/archives.json` 继续保持原约束。顶部独立 SSH 按钮和管理弹窗已移除，`Ctrl+Shift+S` 直接读取目录。

运行时扩展由 [src/data.ts](../src/data.ts) 与 [src/ssh/host-cards.ts](../src/ssh/host-cards.ts) 管理。已保存主机和 SSH config 主机全部进入专属列；改名保留 `H-` 编号，删除后的编号不分配给新主机。八个原导航刻度显示当前选择附近的窗口，支持长列双向循环及各列的选择记忆。三维场景单独保存实际档案索引，避免超过 32 行后仅靠模型 slot 反查选档产生重叠；坐标重置按各列共同的行周期执行。

目录通过原详情页签提供「主机档案／建立连接／会话记录」，具体主机提供「概述／连接配置／会话记录／事件日志」。主机列表复用搜索、来源筛选和结果行，读取档案后从原位置的 CONNECT 建立连接。表单、历史和动作使用原详情布局、细线与按钮样式。

后台列表或会话记录刷新不会重建正在编辑的输入框。切换页签保留本次运行中的草稿；保存失败保留字段和值，过期 revision 被主进程拒绝后，可明确选择「重新读取配置（放弃此草稿）」恢复最新配置。输入区的方向键和回车不触发阵列导航；Esc 先返回档案概述，再退出详情，Tab 可以到达原页面控件。

目录的会话页显示全部历史；删除主机后仍能读取和导出旧记录。列表优先使用记录保存的 `targetLabel`，旧版无名称的记录提供可读回退，不在正常标题中展示内部 UUID。活动主机修改保护、单会话、SSH 参数校验、密码不落盘和文件 revision 校验继续使用既有后端。

## 认证与页面过渡

[src/ssh/page-motion.ts](../src/ssh/page-motion.ts) 使用原生 Web Animations：内容 360ms、细线 460ms、逐项延迟 28ms（上限 168ms），复用原缓动。同一元素的过渡被打断时从当前透明度和位移衔接；减少动态效果时直接显示。

密码、私钥口令、验证码、主机指纹和失败提示共用原档案右侧位置。标题使用既有 `createRollingText` 的 460ms direct 模式，细线、等待标记、说明、输入和操作错峰进入。输入在入场期间即可使用；字段归属真实请求 ID 和类型，同一请求的重复状态更新不会替换字段或抢走焦点。等待小点仅表示正在等用户输入，成功和开盒仍由实际会话状态驱动。

完整记录沿用原索引弹窗的框架，保留可滚动正文、显示记录的导出、进退过渡与焦点恢复。认证退出完成前继续隔离背景输入，之后恢复原档案内容。亮暗配色、紧凑窗口和减少动态效果沿用已有设置。

## 验证结果

| 检查 | 结果与范围 |
| --- | --- |
| `npm run build:desktop` | 通过。TypeScript、档案导出和 Vite 桌面构建完成，以下 UI 检查使用此产物。 |
| `npm run check:ssh-column` | 通过。0／1／8／33／256 台主机，原 40 份档案隔离、稳定编号、改名、移除、编号不复用、双向循环及长坐标周期。 |
| `check:ssh-profiles`、`check:ssh-client`、`check:ssh-handshake`、`check:ssh-audit` | 通过。主机持久化与参数、会话请求及可信状态、握手映射和记录回归。 |
| `check:ssh-pty-lifecycle` | 通过。12 次快速原生退出及立即停止，未出现退出后 resize 的主进程未捕获异常。 |
| `npm run smoke:desktop:hosts` | **62/62**。第六列导航、搜索与来源、原生 Enter 保存、完整参数、ConPTY 输入输出、活动配置保护、失败与冲突恢复、草稿、重连、改名及删除历史、长列循环、焦点、暗色、小窗口和减少动效。 |
| `npm run smoke:desktop:session` | **87/87，无跳过**。真实请求编号、密钥接受／拒绝、密码、输入焦点、动画期间原生逐字输入、可信状态、隐藏输出、记录和导出、连续打断后的输入隔离。 |
| `npm run smoke:desktop:terminal` | **8/8**。原包装与终端内胆、投影屏幕上的原生键盘往返、重组后保留输出、退出后可读、事件排重及退出后缩放。 |
| `npm run smoke:desktop` | **15/15**。实际 Electron 入口、原生快捷键进入嵌入目录、preload、WebGL、开场和桌面 PWA 隔离。 |

四个桌面冒烟共 **172 项通过**。完整结果与图片清单见 [report.json](ssh-archive-ui/report.json)，原始检查分别为 [hosts.json](ssh-archive-ui/hosts.json)、[session.json](ssh-archive-ui/session.json)、[terminal.json](ssh-archive-ui/terminal.json) 和 [desktop.json](ssh-archive-ui/desktop.json)。

主机 UI 冒烟在隔离配置中通过原生表单创建 36 台主机，加上目录与两台配置主机形成 39 项长列，验证超过 32 行仍能选择每一项，跨首尾与切列返回保持正确。小窗口实际内容区域为 1008×601；编辑区没有横向溢出，滚动能到达保存和保存并连接。主机与会话测试按顺序运行，避免 Electron 窗口争抢焦点。

所有会话检查使用实际 Electron、沙箱 preload、IPC 与 Windows ConPTY，SSH 对端由 `scripts/fixtures/fake-ssh.mjs` 提供。测试写入临时 userData，不修改实际主机配置。它们证明本机流程与 UI 输入输出链路可用，不等同于真实远端服务器、私钥或跳板认证验收；本轮未进行壁纸构建或验收。

构建仍有既有的大 chunk 提示，部分三维检查有 Three.js X4122 精度警告；快速结束 PTY 时 node-pty 辅助进程可能输出 `AttachConsole failed`，相关测试退出码为 0。此前用户报告的主进程 `Cannot resize a pty that has already exited` 未复现。

## 画面复核

以下均为本轮通过的实际 Electron 检查截图；密码进入帧刻意保留过渡状态，完成帧展示已连续输入四个字符后的稳定页面。

- [主机配置：亮色](ssh-archive-ui/editor-light.png)、[目录与来源筛选](ssh-archive-ui/list-light.png)。
- [主机进入三维终端](ssh-archive-ui/connected.png)、[完整会话记录](ssh-archive-ui/audit.png)。
- [暗色配置](ssh-archive-ui/editor-dark.png)、[紧凑窗口底部操作](ssh-archive-ui/editor-compact.png)。
- [密码页进入中](ssh-archive-ui/password-entering.png)、[密码页输入完成](ssh-archive-ui/password-ready.png)、[暗色与减少动态效果](ssh-archive-ui/password-dark-reduced.png)。

已检查详情对齐、标题与正文可读性、操作区和页脚间距、紧凑窗口滚动，以及认证时左侧真实输出与右侧输入的并置。视觉方向仍以用户后续实际使用反馈为准。
