# WorkBuddy 未提交改动复核 · 2026-09-12

> 以下保留首次检查时的发现。用户随后授权修复；完成情况、回归结果与剩余范围见 [SSH 修复验证](SSH-REPAIR.md)。本文中的“未修复”“未提交”和测试计数描述的是修复前状态。

当前是可运行但尚未收尾的 Electron SSH 客户端。主体链路已经存在，仍有终端、认证、记录方面的真实缺陷；不能依据此前“全过”的记录直接当作完成版提交。

本轮按“看看”的范围完成检查，未修改业务代码、未提交或推送。读取了 `.workbuddy-ai/memory/2026-09-12.md`、`DESKTOP-SSH.md` 和实际源码。检查基于 `main` / `8799b03` 上的工作区改动：7 个已跟踪文件被修改，另有 35 个未跟踪文件（本报告创建前）。

## 当前已有的实现

- Electron 壳、独立 `dist-desktop` 构建、系统 SSH + ConPTY、事件日志和 IPC。
- 握手驱动玻璃解密、xterm 终端、终端输入输出速率驱动阵列。
- 主机密钥确认、口令提示、错误面板、会话记录和导出。
- 从 SSH config 读取主机并绑定到 40 张档案卡；详情包含主机信息、历史会话与事件日志，另有主机选择面板。

`DESKTOP-SSH.md:435` 仍写着“未把主机挂到档案卡上”，已经落后于 `src/ssh/host-cards.ts` 和 `src/ssh/host-detail.ts`。应以代码为准。

## 本轮检查结果

| 检查 | 本轮结果 |
| --- | --- |
| TypeScript | 通过 |
| 五组 `check:ssh*` 脚本 | 全部通过；ConPTY 子进程仍有 `AttachConsole failed` 输出 |
| `npm run build:desktop` | 通过；存在体积和重复静态/动态导入警告 |
| 桌面壳冒烟 | 14/15，仍查找已移除的 `.system-nav [data-action=session]` |
| 完整会话冒烟 | 67/68；失败断言要求 `archive-ui.inert === false`，但当时处于 detail 模式，前后 inert 集合相同，键盘仍能选档 |
| 新增针对性复现 | 下列终端、认证和历史导出缺陷已复现 |

Electron 使用默认沙箱即可运行；本轮没有传入 `--no-sandbox`。不应把此前单次环境故障固化成默认启动参数。冒烟使用独立 userData 和仓库内 fake SSH，没有连接真实服务器或修改用户 SSH 配置。网页/PWA、壁纸打包和 iPhone 本轮未重新验收。

## 优先修复的缺陷

1. **P1 · 终端隐藏时丢输出，快速开关会重复订阅。** `src/ssh/terminal.ts:161` 只在显示时订阅输出；完全收起后不再接收，重开也没有补放 client 缓存。`hide()` 把 `release()` 放在可取消的动画回调里，重开覆盖订阅句柄，旧订阅和计时器丢失释放入口。实际桌面复现：隐藏期间的标记在 client 缓存里存在，重开后屏幕没有；快速开关三轮后，client 接收 2 处标记，终端显示 8 处。应让每个会话的终端缓冲连续接收输出，并保证订阅与计时器生命周期唯一、可释放。

2. **P1 · 认证提示可能消失，连接继续等待。** `src/main.ts:1582` 空口令不发送任何输入，却仍关闭提示。实际复现后为 `promptOpen=false`、`phase=authenticating`、进程未退出。`src/main.ts:1707` 又仅按提示文本去重，提交后未清理 `handledPrompt`，服务器再次提出相同问题时不会重新显示。用源码回调重复投递同一密码提示，2 次请求只打开 1 次。应按独立请求生命周期处理，空值保留输入框或明确提交空口令，并覆盖输错后的重试。

3. **P1 · 普通终端内容会被当成连接失败证据。** `src/ssh/client.ts:247` 在进入交互状态后仍把每行远端输出交给 `parsePtyNotice`。例如查看日志时输出 `Host key verification failed.`，复现结果由 `interactive` 变成 `failed`，但 SSH 进程没有退出。交互后的远端文本不能拥有终止本机连接状态的权限；应依赖主进程退出/可信事件通道，并区分认证阶段。

4. **P1 · 历史记录导出取错会话。** `src/main.ts:1651` 显示读回的旧记录，但 `src/main.ts:1570` 的导出仍调用 `client.exportRecord()`。实际打开 `historical-fixture` 的记录后点击“导出”，文件目标却是 `current-fixture`。新启动后未运行过会话时，这条路径还会报“没有可导出的会话”。导出应使用记录面板正在显示的 `audit.current`。

5. **P2 · 已结束会话的时长继续增长。** `src/ssh/client.ts:392` 每次构建记录仍使用当前时间减开始时间，没有冻结退出时刻。控制时钟复现：退出时 1000ms，等待 10 秒再读取变成 11000ms。会影响结束后的查看和导出，应在退出事件记录最终时间。

## 其余已确认问题

- `electron/main.cjs:193` 对 `Host alpha beta` 仅给最后一个别名附加 HostName/User/Port 和原始块。复现中 alpha 字段全空，beta 正确。连接由 SSH 自己解析，因此主要影响卡片和列表展示。
- `electron/ssh-args.cjs:63` 没有按选项参数个数解析 `extraArgs`，裸字符串会被接受。`target=intended-host` 加 `['different-host', 'echo']` 会生成 `ssh … different-host echo intended-host`，实际目标与界面描述不同。复现只检查参数数组，没有执行网络连接。IPC 应使用结构化选项并验证参数个数；`-o` 的能力边界也需明确。
- `electron/session.cjs:132` / `:159` 用 JavaScript 字符串长度统计“字节”，多字节文本会算错；该指标实际衡量 PTY 文本，并非加密线路的全部网络流量。
- 新面板的退出隔离、焦点返回和新会话终端清屏仍应专项检查；现有机检通过不能替代这些交互验收。

## 仍未实现或待决定的原计划

`DESKTOP-SSH.md:424` 起记录的 CSP、日志保留/清理、端口转发可视化仍未完成。完整 SSH 事件音效映射没有接通，deny/abort/restored 和 terminal 音乐场景也尚未实现；不只是三个音色参数未定。新面板视觉与鼠标/滚轮/触摸输入仍缺完整验收。多会话、SFTP、屏幕后处理绑定属于后续设计范围，应与当前缺陷修复分开确定。

建议顺序：先修终端与认证生命周期 → 修状态来源与记录导出 → 补对应回归并更新过时冒烟/文档 → 再完成 CSP、日志管理等已有收尾项，最后验证并提交。端口转发可视化等新增交互应在基础流程稳定后继续。

## 本地复现证据

临时工具、模拟数据及报告位于 `release/workbuddy-review/`（Git 已忽略）：

- `baseline-smoke.json`：桌面 14/15。
- `session-smoke.json`：会话 67/68，含真实按键输入检查。
- `runtime-findings.json`：终端隐藏丢输出、快速开关重复输出、空口令关闭提示。
- `history-findings.json` 和 `history-export.txt`：正在查看旧记录，导出却为当前会话。
- `unit-findings.json`：错误文本误判、结束时长增长、重复密码提示、配置别名和 argv 验证。
- `runtime-review.cjs` 仅在内存中替换 Electron 的测试启动流程，沿用项目现有 IPC、preload、构建产物和业务代码；`runtime-probe.js` / `history-probe.js` 为独立页面探针，`unit-review.cjs` 为源码最小复现。
