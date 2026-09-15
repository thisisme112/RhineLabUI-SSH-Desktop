# 桌面 SSH 事件通道修复 · 2026-09-12

用户报告：SSH 界面已融入设计语言，但功能不可用——点击连接、输入口令后似乎登录失败，再次点击连接提示"已有会话正在进行"。

## 根因

`ssh -E <file>` 在 Windows 上不可用，因为 **ssh 以独占共享模式持有该文件，会话期间谁也读不到**。

| 实测 | 结果 |
| --- | --- |
| 会话进行中反复 `fs.openSync(logPath, "r")` | 连续 6 秒全部 `EBUSY`，直到 ssh 关闭 stderr 才成功 |
| 22 行 debug 抵达时刻 | **2493ms**（会话 3476ms 结束）——集中在结束前的一瞬间 |
| 主进程先持句柄再让 ssh 打开 | ssh 直接 `Couldn't open logfile …: Broken pipe` 退出 |
| `-E \\.\pipe\…` | 能连上，但被缓冲，对端关闭前没有任何数据 |
| `cmd.exe /c ssh … 2> file` | 可以流式读取，但多一层进程，杀 cmd 会留下孤儿 `ssh.exe` |
| 不带 `-E`，诊断行走 pty | 完整、增量、不折行；第一行 396ms，100 列下 108 字符的行未被 ConPTY 折行 |

于是握手事件在连接过程中根本不存在：`auth.succeeded` / `session.entering` 永远到不了，相位停在 `authenticating`，**终端不会打开**，用户据此判断"登录失败"；而 ssh 其实还活着，所以再次点击时"已有会话正在进行"是诚实的。

口令链路本身没有问题：用真实 `ssh-keygen -y`（与 ssh 相同的 /dev/tty 读取路径）验证，键入的密钥被真实 OpenSSH 接受并回显了公钥。

## 修复

不带 `-E`，在主进程从同一路 pty 流里按行分离诊断行，日志文件由主进程自己写。

| 文件 | 改动 |
| --- | --- |
| `electron/pty-events.cjs` | **新增** — 诊断行识别（`debug\d+:`、版本横幅、若干无条件提示）与流分离；纯逻辑、可单测 |
| `electron/session.cjs` | 去掉 `-E` 文件 tail；改为分流 + 自写日志；未终止片段 150ms 兜底释放 |
| `electron/ssh-args.cjs` | `buildSshArgs` 不再下发 `-E` |
| `electron/main.cjs` | 冒烟断言改为"带 `-v`、不带 `-E`"；注释同步 |
| `scripts/fixtures/fake-ssh.mjs` | 替身把诊断写到 stderr（真实客户端不带 `-E` 时的行为），不再是写到文件 |
| `scripts/check-ssh-real-client.mjs` | **新增** — 跑真实 `ssh.exe` 的检查 |
| `src/ssh/events.ts` | `kex.reset` 接受 `debug1:` 前缀；真实客户端就是这么输出的 |

分离规则保持保守，避免把远端文字误当诊断：

- 只有 ssh 自己才会写出的模式被认领；
- **进入交互态后不再解释无条件提示**（远端 `cat` 出一个 `Permission denied (...)` 不能结束会话）；
- 未终止片段只在看起来像诊断行开头时才短暂保留，口令提示与 shell 回显立即放行，不增加输入延迟。

## 验证

| 检查 | 结果 |
| --- | --- |
| `npm run check:ssh-real-client`（新增） | 通过——第一行 368ms / 共 3483ms（10%）；中途可读日志；相位在 ssh 运行期间推进到 `failed` |
| `npm run check:ssh-session` | 通过——新增分流单测（含"提示未换行也立即到达终端"） |
| `check:ssh` / `check:ssh-handshake` / `check:ssh-traffic` / `check:ssh-audit` / `check:ssh-client` / `check:ssh-host` | 全部通过 |
| `npm run build:desktop`（含 `tsc`） | 通过 |

新增检查里最能说明问题的一条：**会话进行中读取日志文件必须成功且已含 `debug1:`**。修复前这条必然失败（`EBUSY`）。

顺带修正：`check-ssh-session.mjs` 里"已停止的会话拒绝输入"原本依赖 400ms 固定等待，实测 ConPTY 结束需要约 470ms，属偶发；已改为等待真实 exit 事件。

## 会话终端：从浮层改为档案卡的内容

用户确认方向："要跟原来的设计元素有机结合，利用原来的"。原先终端是一个盖在应用上的独立浮层；现在它是**主机档案卡正文本身**：

- **卡片自己的骨架承载会话**。主机卡详情沿用同一个 kicker、标题、分隔线、`metadata` 四格、`detail-actions` 按钮与脚注；有会话时，正文区（原本放 tabs 的位置）放的是 `#host-session` 槽位，终端嵌在里面。没有新增面板或窗口——同一张卡片换了一种内容。
- **揭示复用解密动画**。`sshFrame` 每帧把 `HandshakeSnapshot.clarity` 写成槽位的 `--reveal`，终端的可见度与磨砂模糊跟随同一条握手时间轴：玻璃没清之前，会话在那里但读不清；clear 时完全显现。驱动源是真实事件（R1）。
- **`metadata` 显示会话验证过的事实**。HOSTNAME 格在连接验证出真实地址后显示该值并附"已验证"小标；没有证据前保持显示配置原值（R3/R4）。
- **操作按钮随会话变形**：无会话 `⇄ CONNECT`，有会话 `⏻ DISCONNECT`。同一个 `solid-button`。
- **阵列输入隔离复用既有 `inert` 语义**（`canBrowse()` 已识别，零新代码）；返回阵列走卡片既有的 back 路径；Escape 始终交给 shell。
- `Ctrl+Shift+T` 与既有 `Ctrl+Shift+S/E/A` 同族，作为手动入口；没有卡片可归属的主机（溢出列表）仍用浮层，浮层仍等 `interactive` 才出现。
- 每代会话只自动揭示一次：流量读数每 250ms 重跑 `updateSessionUi`，没有 `revealed` 守卫的话，用户在阵列页手动关掉的浮层会立刻被顶回来。

`SshTerminalPanel.show(reduced, slot?)` 增加嵌入模式：嵌入时不做模态隔离、去掉 dialog 语义、随卡片重渲染前 `detach()`。浮层行为不变。

## 会话即档案内容：三维终端舱（2026-09-12 第二版）

用户反馈嵌入卡片的终端"直接在这个窗口也太不美观了"，明确方向：打开终端时，左侧三维模型的**内构**换成有厚度的终端，保留外侧包装盒与标签；终端屏幕显示真实鉴权内容和连接后的输入输出；连接成功后包装盒自动拆解打开，终端放大供操作。

- **`src/ssh/terminal-deck.ts`（新增）**：`TerminalDeck` —— 圆角厚板机身（深色陶瓷质感）+ 金属边框 + CanvasTexture 屏幕 + 状态灯，尺寸按内构腔体（信息基板 4.80×3.47、盖板下厚度）定。屏幕内容不是贴图，来自两个真实数据源：pty 建立前画 `client.rawLog` 的 `ssh -v` 鉴权行（identity file、主机密钥证明、认证方式——鉴权内容本身）；有输出后切换为无头 xterm 镜像（与 DOM 终端吃同一份字节流，转义序列、全屏应用落位一致）。页脚是真实流量读数，与 DOM 面板同规则。
- **场景替换（`scene.setSessionDeckState`）**：`deckBlend` 在磨砂盖板尚未变清时把内构网格换成终端舱（交换被磨砂遮蔽）；`openBlend` 在 `interactive` 时让盖板+螺丝+标签**竖直升起**（沿用抽取只许竖直升降的规则）离盒，终端舱前移 0.55、放大 1.5 倍到操作尺寸。减少动态效果时直接到位。
- **操作面不变**：右侧卡正文里的 DOM 终端仍是输入与全彩回显的表面；三维屏幕是同一会话的镜像，两边永远不会不一致。
- **换卡安全**：`select()` 克隆选中模型归位时剔除终端舱克隆体，并把盖板/标签/内构复位——归位副本是一张普通档案。`appearance` 的三个遍历对非 Mesh 子节点加了守卫（终端舱是 Group）。
- **接线**：`sshFrame` 每帧求值目标状态（detail + 会话所属卡 + 相位），变化时下发；终端舱懒创建，场景被卸载重建后会重新创建并重新 attach。
- 断开（`exit`）即 `off`：盖板回落、内构恢复，档案回到普通文件；失败保持 `connecting`，鉴权日志留在磨砂玻璃后。

## 验证边界

- 未连接真实 SSH 服务器，只跑了真实 `ssh.exe` 客户端（连到本地拒绝的端口）。
- Electron 桌面冒烟（`smoke:desktop:session`）在本机 shell 无法启动 GPU 进程，未能重跑；其传输层与状态机部分已由上面两个检查覆盖。
- 修改 `electron/*.cjs`（主进程）后必须**重启桌面应用**：Vite dev server 只热更新渲染层，主进程不会自动重载。
- 未覆盖：鼠标/触摸手感、用户听感、多会话、SFTP、端口转发可视化。
- 终端舱未经实机目检：机身配色/尺寸、盖板升起高度（4.6 单位）、放大幅度（×1.5）与前移量（0.55）是按既有构图估的初值，需用户看过效果后校准；三维屏幕为单行文字镜像（未逐格还原文本颜色），全彩回显以 DOM 终端为准。
