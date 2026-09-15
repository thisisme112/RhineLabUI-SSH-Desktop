# 盒内 SSH 终端与 PTY 退出竞态

> 2026-09-15：当前模型已恢复 Blender MCP 制作流程并改为无边框显示层，电脑及安卓共用。本文的截图、测试和“代码生成内胆”描述均属之前版本；最新实现与本次仅编译打包的范围见 [SSH-ARCHIVES-ANDROID](SSH-ARCHIVES-ANDROID.md)。

验证日期：2026-09-12。仅用于 Electron desktop 构建；沿用项目原生 TypeScript、Three.js、Vite 与 Blender MCP 流程。

## 实际行为

主机档案保留原玻璃包装盒、标签、品牌路径和外壳细节。只隐藏包装里的原 optical-core / optical-lenses，替换为有厚度的终端内胆；普通档案与阵列继续使用原模型。内胆自 2026-09-14 起改为代码生成（见「内胆由代码生成」）。

连接期间，盒内显示当前 SSH 客户端产生的鉴权事件和待回答提示。密码、私钥口令及验证码仍在认证面板填写，不能由包装动画或前端计时器假定认证成功。收到进入交互会话的事件后，包装拆解与镜头转正、拉近同步进行：紧固件略领先，盖板随镜头移动，背板略跟随。内胆保持实际尺寸及局部位置；选档抽取继续遵守既有竖直升降规则。

整个会话只有一个 xterm，持续接收完整 PTY 流。盒内会话画面读取该 xterm 的活动缓冲区，操作态把同一个 DOM 终端按三维屏幕四角投影。投影在当帧相机更新后计算，窗口缩放、开盒和反向收起使用一致的屏幕位置；没有在右侧详情另建终端。

- `Ctrl+Shift+E` 收起并重组包装，连接、输出解析与终端协议回复继续运行。`Esc`、`Tab` 和方向键在操作态传给远端程序。
- 收起完成后焦点回到主机操作按钮；退出过渡结束前保持输入隔离。快速重开沿当前状态继续。
- 会话结束后保留输出；开始新会话时销毁旧 xterm 及尚未完成的解析任务，避免旧数据进入新会话。
- 鉴权失败不自动拆盒。“查看终端输出”可打开保留的鉴权记录，不等待一个不会发生的成功事件。
- 模型载入失败时提供常规终端，会话与页面帧循环继续工作。减少动态效果时开盒、重组和镜头直接到位，明暗配色与原设置共用。

## 开盒与拉近同步（2026-09-13）

用户要求边拆盒边拉近，动作稍微放慢并采用先慢后快的非线性速度。主体时间由 1.6 秒延长到 2.1 秒，镜头与包装共同使用 `t²` 进度，移除此前镜头从 42% 才开始、拆解在 48% 就完成的分段。盖板直接跟随此进度，紧固件及背板只作轻微层次差异，不再叠加另一段等待和缓动。镜头保留原有跟随阻尼，使末端平稳接入操作态；收起仍为 1.2 秒，途中反向从当前进度继续。

`npm run build:desktop` 通过。复用既有 `node scripts/check-terminal-deck.mjs --out .tools/terminal-opening-review`，31/31 通过，涵盖取消开盒、快速重开、终端协议和输出、不同窗口、减少动效及模型失败降级。`npm run smoke:desktop:terminal` 8/8 通过，实际 Electron / ConPTY 的键盘往返、收起后保留输出、退出后缩放均正常；SSH 对端仍为测试替身。

本轮另记录了 356 帧实际镜头与屏幕投影；主体进度完成时约 2110ms。在 1920×1080 检查中，终端投影左边缘高度依次如下，显示镜头前段缓慢、后段加速。最后一行是主体进度到达终点的当帧，镜头此后按既有阻尼继续收敛至操作构图。

| 主体进度 | 实际时间 | 共享位移进度 | 投影高度 |
| --- | --- | --- | --- |
| 0% | 0ms | 0% | 397px |
| 25% | 528ms | 6.2% | 404px |
| 50% | 1055ms | 25.0% | 433px |
| 约 75% | 1585ms | 55.7% | 498px |
| 100% | 2110ms | 100% | 635px |

已查看 [前段](terminal-opening/early.png)、[中段](terminal-opening/middle.png)、[后段](terminal-opening/near.png) 及 [操作态](terminal-opening/operating.png)，确认拆解与拉近重叠进行。逐帧投影数据见 [opening-frames.json](terminal-opening/opening-frames.json)，完整功能检查见 [browser-report.json](terminal-opening/browser-report.json) 和 [native-report.json](terminal-opening/native-report.json)。未改动模型资产。

## 内胆由代码生成（2026-09-14）

内胆原先由 Blender 导出的 `src/ssh/assets/ssh-terminal.glb` 提供。改为 [src/ssh/terminal-deck-parts.ts](../src/ssh/terminal-deck-parts.ts) 程序化生成，原因有两条：部件必须可按名字寻址才能分别拆开查看，而烘焙的 GLB 里没有任何信息说明哪个网格是主板、哪个是背板；表面必须跟随应用自己的明暗配色，而烘焙材质做不到。该 GLB 及其运行时引用已移除，原 [生成脚本](../art/build_terminal.py) 与 [Blender 源场景](../art/ssh-terminal.blend) 作为出处保留。

尺寸沿用原约束，因为屏幕平面是三方共用的单一真源——`terminal-screen.ts` 的 DOM 投影、`scene.ts` 的操作镜头与 CanvasTexture 的宽高比都读它：

| 项 | 值 |
| --- | --- |
| 屏幕 | 宽 4.17、高 2.22，中心 `[0, 1.565, 0.139]` |
| 机身 | 宽 4.40、高 2.50 |
| 叠层总厚 | 0.259（z 自 0.139 向后至 −0.120），仍在原包装内部空间内 |

五块具名薄板，与档案查看器 `model-viewer.ts` 的 `PARTS` 同构，各带装配位 `z`、拆开位移 `depth` 与对角位移 `slide`：

| 部件 | 装配 z | depth | slide |
| --- | --- | --- | --- |
| 边框与指示窗 | 0.096 | +1.30 | `[-1.39, 0.98]` |
| 屏幕面板 | 0.139 | +0.50 | `[-0.70, 0.49]` |
| 散热槽组 | −0.001 | +0.05 | `[0, 0]` |
| 主板与接口 | −0.045 | −0.45 | `[0.70, −0.49]` |
| 背板框架 | −0.108 | −1.00 | `[1.39, −0.98]` |

`slide` 与 `depth` 同样重要。`model-viewer.ts` 只沿 z 移动，但那个查看器允许自由旋转视角；终端deck 只从档案自己的近正面角度观看，纯沿 z 展开的叠层会被自己的前面板挡住。因此各板同时沿对角线位移，镜头不动也能看清分层；扇形以屏幕为中心对称，构图仍落在相机原本的瞄准点上。

科幻感来自四处：`RoundedBoxGeometry` 倒角、板间暗色细缝、琥珀自发光指示窗与灯位、屏幕背光。**背光由真实连接阶段驱动**（`client.status().phase`）：认证中呼吸、交互态稳定、失败转红——不写与状态无关的循环动画（`DESKTOP-SSH.md` 规则 R1）。机身刻意比档案纸张更深，两种配色下都是：第一版把机身调到与纸张同色，结果五块板读成一片白。

## 拆解终端 / 一键重组（2026-09-14）

装配态下终端栏提供「拆解终端 ＋」，点击后内胆五板沿对角散开、镜头后拉把整叠收进画面、真实 xterm 从屏幕上撤走（投影锚点随屏幕板移动，DOM 覆盖层不能再钉在原处）。散开期间包装保持开启——这正是 `setSessionDeckState` 表达式里多一个 `deckInspecting` 项的原因，否则终端一撤、盒盖就会合上，而里面已经拆开。

两个入口分处两地，是有意为之。**进入**拆解由终端栏提供，因为 `SurfaceScope` 让终端成为模态面：其余视口兄弟节点被置为 inert、其事件也被吞掉，所以画在模型旁边的控件在终端打开期间根本点不到——而那正是 deck 处于操作尺寸、值得拆开的时候。**退出**由场景右下角的 `deck-tools` 提供，终端一旦离开屏幕，场景立即恢复可交互。

关闭终端或结束会话会一并结束拆解并立即复位，避免把拆开的卡片归档回阵列之后再打开。减少动态效果时，拆开与复位直接到位。

## Blender 源文件

原包装仍由 `ArchiveScene.createAssemblyModel()` 创建，复用原盖板材质与动态标签。只对拆解包装的部件组施加变换，未改写原外壳资源。

## 用户报告的主进程异常

原异常为 `WindowsPtyAgent.resize: Cannot resize a pty that has already exited`，由 Electron 的 `session:resize` 进入 `PtySession.resize()`。原生 ConPTY 已结束与 node-pty 转发最终 `onExit` 之间存在间隔，仅检查 JavaScript 对象是否非空无法避免异常。

Windows 上还有启动顺序问题：node-pty 1.1.0 先转发首次 data，再设置自己的 ready 标记。在首次 data 回调内直接 resize，会进入它的延后执行队列；此后抛错的位置已脱离调用方的 try/catch。

[electron/session.cjs](../electron/session.cjs) 现在自行管理这一段生命周期：

1. 启动时仅保留最后一次尺寸请求；首次 data 整个回调结束后，通过 `setImmediate` 才允许调用原生 PTY。
2. `stop()` 立即标记停止并清除待发尺寸，此后拒绝输入和 resize；尚未 ready 时待启动回调完成再结束进程。
3. 在原生 resize、write、kill 边界捕获退出竞态。写入未成功时不增加输出字节数，认证回复也不报告成功。
4. 最终状态及退出码仍由真正的 `onExit` 提供。回调绑定各自的 PTY，旧实例事件不能结束新会话。

未使用全局 uncaughtException 吞错，也未伪造正常退出码。

## 原始流与事件记录

ConPTY 调整大小时会重画屏幕，并使用原来的绝对光标位置。此前从输出中删掉 SSH 诊断行，会让 xterm 的屏幕行号与 ConPTY 不一致；缩放后也可能把同一批诊断重复写入日志。

现在 xterm 接收完整原始流，包括真实鉴权诊断和 VT 控制序列。`PtyEventSplitter` 只旁路观察事件与认证提示，不修改终端数据。它识别 ConPTY 的尺寸通知与重画范围，对该范围里已观察到的诊断按出现次数排重；后续真正再次发生的同名认证事件仍可记录。覆盖了带 ANSI 前缀、跨数据块的诊断及没有 debug 前缀的主机密钥拒绝原因。

进入交互态后，远端输出中形似 `debug1:` 的文字可以显示或记录，但不能改写已验证主机、认证方法或连接状态。盒内预览支持 ANSI / truecolor、中文宽字符及 alternate screen；收起时保留协议自动回复，避免全屏程序因等待光标位置或设备属性回复而停住。

## 验证记录

| 验证 | 结果与范围 |
| --- | --- |
| `npm run check:ssh-pty-lifecycle` | 通过。确定性模拟首次 data 顺序、原生退出与 onExit 间隙、停止后输入、认证发送失败和旧实例回调；另完成 12 次真实 ConPTY 快速退出，每毫秒 resize，以及启动后立即停止。 |
| `npm run check:ssh-session` | 通过。真实 ConPTY 与 fake SSH，保留鉴权流；缩放前后事件记录仍为 19 行，无重复累加。 |
| `npm run check:ssh-client`、`check:ssh`、`check:ssh-handshake`、`check:ssh-host` | 通过。会话生命周期、认证、可信状态、事件解析、主机读取及桌面边界。 |
| `npm run check:ssh-real-client` | 通过。真实系统 `ssh.exe` 连接本机拒绝端口，验证实际失败输出与退出；这不是成功连接服务器的验收。 |
| `npm run smoke:desktop:session` | 85/85，通过，无跳过。实际 Electron、preload IPC、ConPTY 与本地 fake SSH。 |
| `npm run check:ssh-terminal-deck` | 31/31，通过。实际 desktop bundle 的浏览器回归，使用明确标识的 transport fixture。涵盖鉴权保持包装、成功开盒、投影输入、关闭及重开、协议回复、ANSI / 中文 / alternate screen、断线与重连、失败输出、快速反向、明暗及减少动态效果、模型失败降级。逐项结果见 [report.json](terminal-deck/report.json)。 |
| `npm run check:ssh-deck-teardown` | 10/10，通过。终端内胆拆解：终端栏入口可用、内胆沿对角散开、盒盖保持开启、镜头后拉、xterm 从移动的屏幕上撤走、场景侧「一键重组」可点、重组后终端回到屏幕、拆开状态下收起会把板复位。见 [terminal-teardown](terminal-teardown/report.json)。 |
| `npm run smoke:desktop:terminal` | 8/8，通过。实际 Electron `file://` 加载原包装及新内胆，键盘经 ConPTY 往返、隐藏输出保留、退出后输出可读、日志不重复及退出后窗口 resize。见 [native-report.json](terminal-deck/native-report.json)。 |
| `npm run check:viewport` | 通过。原有视口布局规则回归。 |
| Web / desktop / wallpaper 构建 | 均通过。Web PWA 为 818 项、33.8 MiB；网页和壁纸不包含 SSH 终端模块或内胆资源。壁纸检查输出到独立目录，未覆盖用户使用中的发行包。 |

内胆改为代码生成后，本项不再需要拦截任何内胆资源：`dist/` 与 `dist-desktop/` 中都已不含 `ssh-terminal-*.glb`（原为 294 KB）。

本轮检查过 1920×1080、1366×768、2560×1440 画面以及实际 Electron 窗口截图。代表画面：

- [鉴权与原包装](terminal-deck/01-authentication.png)、[拆解过程](terminal-deck/02-unpacking.png)、[操作态](terminal-deck/03-operating.png)。
- 终端口令页左上角返回：[terminal-teardown/01-prompt-back-button.png](terminal-teardown/01-prompt-back-button.png)。
- 终端内胆拆开：[操作态与栏内入口](terminal-teardown/02-operating-and-teardown.png)、[散开中](terminal-teardown/03-separating.png)、[完全散开](terminal-teardown/04-separated.png)、[重组后](terminal-teardown/05-reassembled.png)。
- [收起后保留全屏程序](terminal-deck/07-alternate-packed.png)、[暗色与减少动态效果](terminal-deck/09-dark-reduced-motion.png)。
- [失败后的输出查看](terminal-deck/08-failed-output.png)。
- [Electron 原生终端](terminal-deck/11-native-terminal.png)、[原生键盘输入与重开](terminal-deck/12-native-reopened.png)。

浏览器驱动显式保持前台焦点并禁用测试 profile 的扩展。此前 headless 页面被判为后台后，项目按正常规则暂停帧循环，造成过等待超时；修正的是测试驱动，未取消产品对 `document.hidden` 的暂停处理。最终截图等待终端淡入结束，避免将过渡中的两层画面误判为文字叠影。

保留既有构建大 chunk 警告与偶发 Three.js X4122 精度警告。原生生命周期测试的 node-pty 辅助进程偶有 `AttachConsole failed` 输出，测试退出码为 0；未再出现用户报告的主进程 resize 未捕获异常。

本轮未成功连接用户的真实远端 SSH 服务器。浏览器 fixture 与原生 fake SSH 只用于验证交互及本地进程链路，不冒充远端鉴权结果；真实远端交互和最终视觉方向仍待用户实际使用确认。
