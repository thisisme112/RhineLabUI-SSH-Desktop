# SSH 终端搜索、剪贴板与字号

2026-09-13。用户认可同步拆盒与拉近后要求继续完善 SSH。本次只修改桌面 SSH；沿用既有原生实现、三维模型和已确认的动画参数。本地提交，不推送。

## 使用与实现

原终端页脚右侧“终端操作”展开搜索和操作两行；也可在输出上点右键。使用原生 `SurfaceTransition` 与 `SshPageMotion`，进入 220ms 淡入并错峰显示内容，退出 160ms；中途反向保留当前状态，减少动态效果直接完成。一次预留最终高度，关闭后再归还空间，不逐帧改变终端行列数。

- `Ctrl+Shift+F` 聚焦搜索，`Enter`／`Shift+Enter` 导航，`Aa` 区分大小写。新依赖为 MIT 的 `@xterm/addon-search@0.16.0`，搜索同一个 xterm 的活动缓冲区及 5000 行回滚内容，支持中文和自动折行；达到高亮上限时显示下限数量。切换大小写主动清除插件缓存，避免沿用旧结果。
- `Ctrl+Shift+C` 复制终端选择，`Ctrl+Shift+V` 粘贴，`Ctrl+Shift+P` 展开／收起操作区。搜索框内的复制／粘贴作用于该输入框；操作区内 `Esc` 收起并返回终端，终端输入中的普通 `Ctrl+C`／`Ctrl+F`、`Esc`、`Tab` 和方向键继续发往远端。
- 字号范围 12–24、默认 16；点击中间数值恢复默认。单独保存在 `rhine-ssh-terminal-font-size`，重连和下次启动保留。改字号后重新 fit 并通知远端实际行列数。
- 搜索词不落盘，重连时清空；断线保留搜索与复制，停用粘贴。关闭操作区清理搜索高亮；收起终端继续解析输出和响应协议，保持唯一 xterm。

剪贴板只提供文本读写，经既有来源校验的 preload／IPC 进入 Electron `clipboard`。读取只由粘贴动作触发，返回时核对终端实例、会话代次、可输入状态及焦点；收起、重连或焦点改变时不再发送。通过 `term.paste()` 保留 xterm 的换行规范化与 bracketed paste，不追加回车；空文本、系统错误与超过 1 MiB 的内容在原页脚反馈，不截取部分命令。

源码入口：[终端工具](../src/ssh/terminal-tools.ts)、[终端接入](../src/ssh/terminal.ts)、[文本剪贴板边界](../electron/terminal-clipboard.cjs)。完整操作说明见 [桌面 SSH](../docs/DESKTOP-SSH.md#终端搜索与常用操作)。

## 原生重绘修正

原生检查发现：展开页脚或改字号后，ConPTY 部分重绘只有 `CSI ?25l`、`CSI H` 与行末清除，没有 `CSI 8;rows;cols t`。此前事件观察器只识别后一种尺寸标记，会将重绘中的旧鉴权行再次记入日志。

`PtyEventSplitter` 现在也识别隐藏光标后回到原点的重绘，并跨数据块记住隐藏状态。只排除重绘范围内已经观察过的同一条诊断；新诊断和光标恢复后的真正重复事件继续保留。原始终端数据不删改，也不改变交互后的可信状态规则。另外保留以 `debug1` 或 `debug1:` 结尾的分块，避免把尚未收完整的诊断前缀提前当作普通文本释放。

确定性检查覆盖实测重绘片段的每一个分块位置，以及重绘中的新诊断、光标恢复后的同名诊断。原生运行中，展开操作区前、改字号后、退出时的日志均为 19 行；证据见 [原生报告](ssh-terminal-tools/native/report.json)。

## 验证

| 检查 | 结果与范围 |
| --- | --- |
| `npm run build:desktop` | TypeScript 与桌面构建通过。未构建壁纸。 |
| `npm run check:ssh-clipboard` | 4/4，通过。验证 UTF-8 大小边界、空文本、Unicode 与换行、无效 IPC 数据、异常隔离，使用内存替身。 |
| `npm run check:ssh-terminal-tools` | 42/42，通过。真实 desktop bundle 与 xterm，浏览器 transport／剪贴板替身。覆盖搜索、折行、大小写、实时更新、全屏缓冲区、快捷键、bracketed paste、延迟粘贴取消、字号持久化、动画打断、暗色与小窗口。[报告](ssh-terminal-tools/browser/report.json)。 |
| `npm run smoke:desktop:terminal` | 15/15，通过。实际 Electron、preload、IPC 与 ConPTY；搜索和复制实际 PTY 输出，粘贴文本进入 PTY，改字号及退出后缩放正常，日志不重复。[报告](ssh-terminal-tools/native/report.json)。 |
| `npm run smoke:desktop:session` | 87/87，通过，无跳过。认证输入、主机档案入口、会话生命周期、输入隔离、记录和导出均通过。[报告](ssh-terminal-tools/session/report.json)。 |
| `node scripts/check-terminal-deck.mjs --out verification/ssh-terminal-tools/deck` | 31/31，通过。已有拆盒、拉近、重组、隐藏输出、终端协议、重连和模型失败降级均正常。[报告](ssh-terminal-tools/deck/report.json)。 |
| `npm run check:ssh-session` | 通过。包括重绘分块回归和真实 ConPTY 会话测试。 |
| `npm run check:ssh-pty-lifecycle` | 通过。退出间隙、启动尺寸及 12 次真实 ConPTY 快速退出，未出现主进程 resize 异常。 |
| `npm run check:ssh-real-client` | 通过。实际系统 `ssh.exe` 连接本机拒绝端口，验证失败输出和退出。 |

截图已逐张检查：[浅色搜索](ssh-terminal-tools/browser/tools-light-search.png)、[暗色搜索](ssh-terminal-tools/browser/tools-dark-search.png)、[1024×640](ssh-terminal-tools/browser/tools-dark-1024x640.png)、[800×600](ssh-terminal-tools/browser/tools-dark-800x600.png)、[原生桌面](ssh-terminal-tools/native/desktop-smoke-terminal-tools.png)。小窗口压缩页脚间距并保留两行操作；800×600、字号 18 时仍保留 7 行终端内容。

仓库保留关键截图及逐项结果，报告省略本轮未修改的开盒逐帧采样。完整运行产物保存在本机 `.tools/ssh-terminal-tools-full-run-20260913/`。

自动化始终使用独立配置和隔离剪贴板，未读取或覆盖用户系统剪贴板。原生测试的 SSH 对端仍为本地 fake SSH；这不等于已验收用户的真实远端服务器，也没有借此声称已测试操作系统剪贴板里的现有内容。保留既有 Vite 大 chunk 警告、Three.js 精度警告与 node-pty 辅助进程偶发的 `AttachConsole failed` 输出，相关测试退出码为 0。
