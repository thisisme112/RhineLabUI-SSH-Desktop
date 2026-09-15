# RHINE LAB · 桌面 SSH 客户端 —— 工作流 × 设计语言 结合规范

> **当前状态（2026-09-15）**：电脑与安卓共用 SSH 档案、并发会话标签、终端、文件和监控界面。新增可编辑的主机／目录／监控／笔记快捷档案，终端改为 Blender MCP 制作的无边框屏幕，默认字号电脑 13px、安卓 12px。SSH 阵列停止自动起伏，保留原选档和开盒动画。使用说明见 [桌面 SSH](docs/DESKTOP-SSH.md) 与 [安卓 SSH](docs/ANDROID.md)，本次编译与打包记录见 [SSH-ARCHIVES-ANDROID](verification/SSH-ARCHIVES-ANDROID.md)。下文 §1–9 为原设计与研究记录，其中规划项不代表现行功能；§11 为各阶段历史记录。
>
> 早期单会话缺陷修复见 [SSH-REPAIR](verification/SSH-REPAIR.md)，事件通道根因见 [SSH-EVENT-CHANNEL](verification/SSH-EVENT-CHANNEL.md)。SSH 代码仅在 desktop / android 构建启用，网页与壁纸继续各自的入口。用户已确认此前安卓版可以使用；本次按“不用测试”要求只编译和打包，未作新版运行时验收。

> **三维终端更新（2026-09-12）**：主机卡使用原 Blender 外壳及标签，内构换为有厚度的终端。盒内鉴权、连接后画面及可操作 xterm 共用会话数据；进入交互态后先拆盒，再由镜头放大，DOM 终端按屏幕四角投影。收起会话继续运行，退出保留输出。终端现在保留完整 PTY 原始流，包括鉴权诊断和 VT 控制序列，避免 Windows 缩放重画破坏光标位置；事件记录识别重画，连接后远端文本不能改写可信状态。退出竞态与验证见 [TERMINAL-DECK](verification/TERMINAL-DECK.md)。

> **交互沿用**：主机总览收起后保留原档案说明、读取按钮和导航，边缘标签可重新展开。认证页提供返回入口；放大终端可收起到当前主机详情，也能从详情、模型或会话标签重新打开。内胆保留五层拆解与一键重组，模型源文件为 `art/build_terminal.py`、`art/ssh-terminal.blend`；`src/ssh/terminal-deck-parts.ts` 只加载 GLB 并更新材质及状态，不生成模型几何。

> 本文回答一个问题：**如何保证 SSH 工作流的每一步都与本项目既有的设计语言和动画有机结合，且每一步都可被利用。**
>
> 结论：可行，前提是把"动画"从装饰改造成**仪表盘**——每个动画都由真实连接事件驱动，每个工作流步骤都有对应的可视化呈现，每个步骤的产物都能被后续步骤复用、被用户查阅。
>
> 本文中所有关于本项目的引用均标注 `文件:行`；所有关于 SSH 行为的结论均标注"实测"或"OpenSSH 标准输出格式"。

---

## 1. 技术可行性（已实测，非推断）

| # | 结论 | 证据 |
| --- | --- | --- |
| 1 | **`ssh -v` 产出结构化事件流，可直接当状态机输入** | 实测：`debug1: Reading configuration data` → `Connecting to <host> [<ip>] port <port>.` → `Connection established.` → `Local version string SSH-2.0-OpenSSH_for_Windows_9.5` |
| 2 | ⚠️ **`ssh -E <file>` 在 Windows 上无法在服务期内被读取** | 实测：ssh 以独占共享模式打开该文件，会话期间 `fs.openSync` 一直返回 `EBUSY`（预持句柄会让 ssh 直接报 `Couldn't open logfile`；命名管道能连上但被缓冲）。日志只在 ssh 关闭 stderr 时一次性落出——**事件通道在连接过程中是死的**。因此改为不带 `-E`，在主进程从 pty 流里分离诊断行，日志文件由本进程自己写。见 [SSH-EVENT-CHANNEL](verification/SSH-EVENT-CHANNEL.md) |
| 3 | **node-pty 在本机可用，无需 Visual Studio 构建工具** | 实测：`node-pty@1.1.0` 起真实 ConPTY 跑 `cmd.exe`，收到完整 ANSI 序列 `\x1b[?9001h…PTY_OK` |
| 4 | **node-pty 是 N-API 扩展，Electron 下预期免重编译** | `node-pty` 依赖 `node-addon-api ^7.1.0`；`lib/utils.js:19` 从 `prebuilds/win32-x64/` 加载（该目录自带 `pty.node`/`conpty.node`/`conpty.dll`/`OpenConsole.exe`） |
| 5 | 本机 SSH 客户端可用 | `OpenSSH_for_Windows_9.5p2`，`C:\Windows\System32\OpenSSH\ssh.exe` |
| 6 | ⚠️ **一个安装坑必须提前处理** | npm 11 的 `allowScripts` 门禁会跳过 node-pty 的 install 脚本，必须先 `npm install-scripts approve node-pty` |
| 7 | ⚠️ 本机网络走 TUN/fake-IP 代理 | 实测：`github.com` 解析到 `198.18.1.17`，22 端口被远端关闭。**公网 SSH 目标可能不通**；内网 / 直连 IP 目标不受影响 |

**架构结论**：用 `node-pty` 起系统 `ssh.exe`，**不实现 SSH 协议**。这样 `~/.ssh/config`、`known_hosts`、ssh-agent、ProxyJump、跳板机全部免费继承，私钥永不进入网页层。

### 1.1 三通道设计

| 通道 | 载体 | 承载内容 | 消费者 |
| --- | --- | --- | --- |
| **会话通道** | node-pty | 完整 PTY 输出，含鉴权、shell、程序输出和 VT 控制序列 | 唯一 xterm 及其三维屏幕投影 |
| **事件通道** | 旁路观察同一路 PTY 流（见 §1 第 2 条） | 鉴权诊断；ConPTY 缩放重画不重复计入 | 状态机 → 连接表现与记录 |
| **测量通道** | 本机计算 | PTY 文本 UTF-8 字节率、阶段耗时 | 阵列波纹、会话详情；未测量 RTT 或重传 |

`electron/session.cjs` 将原始输出完整交给终端，`electron/pty-events.cjs` 同时提取诊断与认证提示，日志文件由主进程写入。2026-09-12 的盒内终端实现撤回了此前“从终端剔除诊断行”的方式：ConPTY 缩放后会按原行号重画屏幕，删行会让光标与实际输出错位。鉴权内容保留在同一终端的滚动历史中。

> 诊断行按已知 SSH 格式识别；进入交互态后，远端文字只能显示或记录，不能改写已验证的主机信息和连接状态。远端 `cat` 出一个 `Permission denied (...)` 不能结束会话。

### 1.2 桌面构建模式：14 处必改点（已逐一定位）

新增 `--mode desktop`（Electron 用 `file://` 加载）时，以下位置必须改或被 gate 掉。遗漏任何一条都会导致白屏或静默失效。

| # | 位置 | 必须做的事 |
| --- | --- | --- |
| 1 | `vite.config.ts:16` | `base` 扩为 `mode === "wallpaper" \|\| mode === "desktop" ? "./" : "/"`，否则 `file://` 下 `/assets/…` 全部失效 |
| 2 | `vite.config.ts:24-31` | 加 desktop 分支，**绝不注入 `wallpaper/host.js`**（见下方硬陷阱） |
| 3 | `src/wallpaper.ts:2` | `data-wallpaper` 标记是三个壁纸 CSS 的生效开关，desktop 需独立标记 |
| 4 | `src/pwa.ts:25, 50` | desktop 也必须跳过（`file://` 下 `isSecureContext` 与 `serviceWorker` 均不可依赖），否则设置面板出现离线段并尝试注册 SW |
| 5 | `src/main.ts:220` | StartupGate 条件按 Electron 策略重定 |
| 6 | `src/main.ts:250, 662, 1048, 1139, 1159, 1163, 1205` | 这些位置把"宿主能力"与 `isWallpaper` 绑定；desktop 下 `wallpaperHost()` 恒为 undefined，需逐条决定启用或排除 |
| 7 | `src/main.ts:1086` | ⚠️ **硬陷阱**：`await window.rhineWallpaperPropertiesReady`——若复用了 `host.js`，它在 `location.protocol === "file:"` 时**不触发 fallback resolve**（`wallpaper/host.js:22-23`），会**永久挂起 `start()`**，表现为白屏 |
| 8 | `src/main.ts:1111-1114` | 音频解锁策略需另定 |
| 9 | `src/asset-url.ts:6` | 依赖 `BASE_URL`，前提是 #1 已改 |
| 10 | `index.html:11,12,18` | manifest / apple-touch-icon / favicon 为根相对路径，建议照 `scripts/build-wallpaper.mjs:19` 加断言（匹配 `/\b(?:src\|href)=["']\//` 即抛错） |
| 11 | `scripts/build-wallpaper.mjs:9-13` | 类比一份 desktop 校验脚本；**不要**跑 `scripts/build-pwa.mjs` |
| 12 | `package.json:16-17` | 新增 `build:desktop`，照 `:17` 串联 `patch-rolling-number → export-records → tsc → vite build --mode desktop` |
| 13 | `src/quality-settings.ts:11` | desktop 走原生 `<select>` 分支即可，无需改 |
| 14 | 全仓 | **目前不存在任何 Electron 代码或依赖**，从零开始 |

> `src/wallpaper.ts:1` 是全项目**唯一**的 `import.meta.env.MODE` 使用点（已全量确认），所以模式分流的总开关只有一处，新增 desktop 的成本可控。

---

## 2. 事件清单（动画的燃料）

### 2.1 成功路径

| 事件名 | 来源行 | 可提取字段 | 实测 |
| --- | --- | --- | --- |
| `config.loaded` | `debug1: Reading configuration data <path>` | 配置文件路径 | ✅ |
| `tcp.connecting` | `debug1: Connecting to <host> [<ip>] port <port>.` | host、ip、port | ✅ |
| `tcp.established` | `debug1: Connection established.` | — | ✅ |
| `identity.scanned` | `debug1: identity file <path> type <N>` | 密钥路径、类型（`-1` = 不存在） | ✅ |
| `banner.local` | `debug1: Local version string <banner>` | 本端版本 | ✅ |
| `banner.remote` | `debug1: Remote protocol version 2.0, remote software version <v>` | 远端软件与版本 | OpenSSH 标准格式 |
| `kex.algorithms` | `debug1: kex: algorithm: <a>` / `kex: host key algorithm: <b>` | KEX、主机密钥算法 | OpenSSH 标准格式 |
| `kex.ciphers` | `debug1: kex: server->client cipher: <c> MAC: <m> compression: <z>` | 双向密码套件、MAC、压缩 | OpenSSH 标准格式 |
| `hostkey.received` | `debug1: Server host key: <type> SHA256:<fp>` | 密钥类型、**指纹** | OpenSSH 标准格式 |
| `hostkey.verified` | `debug1: Host '<h>' is known and matches the <type> host key.` | known_hosts 行号 | OpenSSH 标准格式 |
| `auth.methods` | `debug1: Authentications that can continue: <list>` | 可用认证方式（真实列表） | OpenSSH 标准格式 |
| `auth.offering` | `debug1: Offering public key: <path> …` | 正在尝试的密钥 | OpenSSH 标准格式 |
| `auth.accepted` | `debug1: Server accepts key: <path>` | 被接受的密钥 | OpenSSH 标准格式 |
| `auth.succeeded` | `debug1: Authentication succeeded (<method>).` | 最终认证方式 | OpenSSH 标准格式 |
| `session.entering` | `debug1: Entering interactive session.` | — | OpenSSH 标准格式 |

### 2.2 失败路径（同样是"可利用"的状态，不是异常）

| 事件名 | 来源行 | 用户可做的决策 |
| --- | --- | --- |
| `dns.failed` | `ssh: Could not resolve hostname <h>` | 改主机名 / 展开发起配置 |
| `tcp.timeout` | `ssh: connect to host <h> port <p>: Connection timed out` | 改端口 / 检查代理 |
| `tcp.refused` | `… Connection refused` | 检查服务是否在跑 |
| `kex.reset` | `kex_exchange_identification: Connection closed by remote host` | **实测已见**；常由代理/防火墙造成 |
| `hostkey.unknown` | `The authenticity of host '<h>' can't be established.` | **指纹确认（必须阻断）** |
| `hostkey.mismatch` | `WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!` | **高危阻断 + 展示差异** |
| `auth.denied` | `Permission denied (publickey,password).` | 换密钥 / 换认证方式 / 查看可用方式 |
| `session.closed` | `Connection to <h> closed.` | 重连 / 查看日志 |

> **解析降级规则**：任何未匹配的 debug 行不得丢弃——原样进入"原始事件流"面板。未识别阶段显示"未知阶段（已连接）"，**绝不伪造进度条**。

---

## 3. 状态机（21 态，全部由真实事件驱动）

| # | 状态 | 触发事件 | 复用的动画原语 | 此步产物（可被后续利用） | 用户可操作 |
| --- | --- | --- | --- | --- | --- |
| 0 | `boot` | 应用启动 | `boot.ts` 逐字输入 + Logo 绘制 | 解锁声音、加载主机清单 | 跳过开场 |
| 1 | `array` | 进入阵列 | 循环档案阵列 | — | 方向键 / 拖动 / 滚轮 / 检索 |
| 2 | `host.selected` | 选中主机 | 抬起 0.4 + 波浪 + **滚动标题/编号** | 记住该列选择 | Enter 连接 / 查看配置 |
| 3 | `resolving` | `config.loaded` | 正文红条锁住（`DocumentDecryption`） | 解析出的最终配置（可展开） | 取消 |
| 4 | `connecting` | `tcp.connecting` | `DecryptionController` **grow 第一段**（左端→中） | 解析到的真实 ip:port | 取消 |
| 5 | `tcp.ready` | `tcp.established` | grow 中点 `markers` 出现 | **TCP 建连耗时** | — |
| 6 | `banner` | `banner.local` / `banner.remote` | 顶部滚动标签显示真实版本 | 对端软件与版本 | 查看原始行 |
| 7 | `kex` | `kex.algorithms` / `kex.ciphers` | grow 第二段（右端→中）→ 两线合拢 | **算法套件全文**（会话详情页） | 查看套件 |
| 8 | `hostkey.review` | `hostkey.received` | **保密等级扫描线** + 指纹分段显现 | **指纹写入 known_hosts** | **确认 / 拒绝** |
| 9 | `hostkey.mismatch` | 指纹不符 | 红色警示 + 拒绝降落 | 差异对照（旧 vs 新） | 中止 / 查看 known_hosts |
| 10 | `auth.available` | `auth.methods` | 正文揭示**真实**可用方式 | 认证方式列表 | 选择方式 |
| 11 | `auth.key` | `auth.offering` / `auth.accepted` | 盖板自上而下变清晰（`glassRevealAtHeight`） | 命中的密钥路径 | — |
| 12 | `auth.password` | pty 检测到口令提示 | **复用 boot 逐字输入** | — | 输入口令 |
| 13 | `auth.kbdint` | pty 检测到验证码提示 | 逐字输入 + 分段 | — | 输入 2FA |
| 14 | `connected` | `auth.succeeded` | 保持态（`phase === "connected"`） | 认证方式与耗时 | — |
| 15 | `session.opening` | `session.entering` | **retracting → revealing**（clarity 0→1） | — | — |
| 16 | `interactive` | 首个 shell 提示符 | `clear` + HUD 曲面 + xterm.js | 会话开始 | 全部终端操作 |
| 17 | `resize` | 窗口尺寸变化 | 终端重排 + 微量形变 | 终端尺寸 | 拖窗口 |
| 18 | `forwarding` | 隧道建立 | **`relayPulse` / `projectRelay`**（既有接力原语） | 转发规则 | 管理隧道 |
| 19 | `traffic` | 持续测量 | **`setPlayfield(bands)`** 阵列波纹 | 实时字节率 / RTT | 观察 |
| 20 | `closed` | `session.closed` / 进程退出 | 卡片错峰下落归位 | **审计日志**（时长、流量、命令历史） | 重连 / 导出 |

---

## 4. 六个既有原语的复用方式（本方案的核心）

### 4.1 `DecryptionController` —— 握手过程（最重要）

`src/decryption.ts:120` 已经把连接过程切成**六个阶段**，与 SSH 握手几乎一一对应：

```
waiting → joining → connected → retracting → revealing → clear
```

| 既有阶段 | 时间轴（原片秒） | SSH 语义 |
| --- | --- | --- |
| `waiting` | < 34.24 | 解析配置、DNS |
| `joining` | 34.24–36.04，`GROW` 两段自两端向中央合拢 | TCP 建连 + 版本交换 + KEX 协商 |
| `connected` | 36.04–37.72，`RETRACT` 保持 | 主机密钥校验 + 用户认证（"已连上，正在验证"） |
| `retracting` | 37.72–38.84，线向中央收束 | 认证通过、请求 PTY、启动 shell |
| `revealing` | 38.84–39.56，`REVEAL` clarity 0→1 | 会话就绪，终端由磨砂变清晰 |
| `clear` | ≥ 39.56 | 交互中 |

**关键接口**：`DecryptionController.update(dt, ready, reduced, referenceTime?)`（`src/decryption.ts:148`）。
第 4 个参数 `referenceTime` **允许整条时间轴被外部时间源驱动**——这是本方案能成立的技术支点。

**采用混合驱动策略（关键设计决策）**：

- **阶段切换点由真实事件决定**——`tcp.established` 到达才允许进入 `joining` 的后半段；`auth.succeeded` 到达才允许进入 `retracting`。
- **阶段内插值沿用既有曲线**——`GROW` / `RETRACT` / `REVEAL` 的单调三次插值（`sampleCurve`，`src/decryption.ts:15`）原样保留。

这样同时满足两个约束：**手感不破坏设计语言**，**进度不伪造**。慢的服务器就是慢——线就停在 `joining` 的中间，这是诚实的信息。

> 已有的 `ready` 门控（`src/scene.ts:1351`：`detail > .78 && this.lift.value > 3.3`）天然防止"卡片还没升起就开始解密"，可直接复用于"卡片还没升起就不发起连接"。

### 4.2 `DocumentDecryption` —— 信息披露节奏

`src/document-decryption.ts:6` 的红色遮挡条覆盖在**真实 DOM 文本**上，按行依次退开（总 0.95s，每行延迟 0.22，缓动 `document-decryption.ts:92`）。

**复用方式**：连接过程中，主机详情页的字段被红条锁住，随着事件到达**逐条揭示**：

| 字段 | 揭示时机 |
| --- | --- |
| 解析后的 ip:port | `tcp.connecting` |
| 远端软件版本 | `banner.remote` |
| 算法套件 | `kex.algorithms` |
| 主机密钥指纹 | `hostkey.received` |
| 实际认证方式 | `auth.succeeded` |

**这不是装饰**：揭示 = 该信息**已被本次连接验证**。未揭示的字段就是未验证的，语义严格成立。

### 4.3 `glassRevealAtHeight` —— 可信度建立

`src/glass-reveal.ts:33` 提供自上而下、带羽化边（`FEATHER = 0.12`）的清晰化前沿，粗糙度在 `FROSTED_ROUGHNESS = 0.42` 与 `CLEAR_ROUGHNESS = 0.025` 之间。

**复用方式**：卡片盖板的磨砂→清晰 = **本次会话的可信度**。三档语义：

| 视觉 | 真实含义 |
| --- | --- |
| 全磨砂 | 未连接 / 未验证 |
| 部分清晰（前沿停在中间） | 正在验证（指纹未确认 / 认证未完成） |
| 全清晰 | 已认证 + 指纹已确认，可以输入 |

对指纹不匹配的主机，**前沿永不越过 0**，并且盖板保留警示色。用户一眼能看出"这台机器我没真正验证过"。

### 4.4 `setPlayfield(MusicBands)` —— 实时网络流量

`src/scene.ts:126`：
```ts
setPlayfield(enabled: boolean, bands: MusicBands, strength: number, flatten: number, target: string | null, breathing = true)
```

这个接口原本接收**音乐频谱**驱动阵列波纹。**复用方式**：把终端 I/O 的**真实字节率**映射成 `MusicBands`。

| 频段 | 映射 |
| --- | --- |
| 低频 | 下行字节率（服务器→我） |
| 中频 | 上行字节率（我→服务器） |
| 高频 | 包速率 / 命令速率 |

于是整个档案阵列变成一块**实时网络活动仪表**：安静时只有呼吸，`apt upgrade` 时整片起伏，`tail -f` 时持续高频细纹。**这是"有机结合"最强的一处**——同一套动效，同时服务于"好看"和"告诉你现在网络上发生了什么"。

### 4.5 `relayPulse` / `projectRelay` —— 端口转发

`src/scene.ts:134/138/145` 已有一套"接力"原语（原本用于波纹接力小游戏）。**复用方式**：每一条 `-L`/`-R`/`-D` 转发规则 = 一条可见的接力通道；数据经过时脉冲一次，方向由 `projectRelay` 投影到对应卡片。

**这不是装饰**：脉冲频率 = 隧道真实吞吐；哪条隧道在动、往哪个方向动，一眼可见。

### 4.6 滚动数字 / 滚动标题（Rolling Number）—— 所有瞬时量

项目已把 `@kitlangton/rolling-number` 用于编号与标题（460ms，direct 模式，快速输入衔接）。**复用方式**：把**一切持续变化的真实测量值**交给它：

- 会话时长、上下行字节数、当前 RTT、发包数
- 连接耗时（分阶段：DNS、TCP、KEX、认证各占多少毫秒）
- 隧道流量

同一套技法，从"装饰性滚动"变成"读数在跳"。

### 4.7 输入隔离：`inert` 已经免费给你

本项目所有模态/查看器都靠快照 `#stage` 子节点并 `inert=true` 来隔离输入（`main.ts:568-571`、`model-viewer.ts:198-204`）。而三维侧的浏览入口 `canBrowse()`（`scene.ts:811-820`）包含一条判断：

```ts
!this.container.closest("[inert]")
```

**含义**：只要终端面板按既有方式挂载，阵列会自动停止接受拖动、悬停与滚轮——**不需要写任何新代码**。这是"有机结合"的另一半：不是把两个系统缝起来，而是复用同一套隔离语义。

配套事实：
- `#modal-root`（`main.ts:87`）是**唯一**在模态打开时不被置 inert 的 `#stage` 子节点（过滤条件在 `main.ts:568-570`，恢复在 `:593`）——常驻终端的挂载位置应参考这个语义。
- `scene.update(time, cinematic?)`（`scene.ts:1141`）**唯一调用方是 `main.ts:957`**。终端全屏时，照抄查看器的做法（`main.ts:957` 的 `if (!viewer?.isOpen …)`）即可暂停主场景绘制。
- `setHover` 是 **private**（`scene.ts:822`），不属于对外 API；对外可用的相关入口是 `select`、`setMode`、`setPlayfield`、`relayPulse`、`projectRelay`、`decryptionFrame`、`finishDecryption`、`detailVisibility`。

### 4.8 三个影响架构的事实

**① 已有现成的"外部控制面"范例**：`window.rhine`（`main.ts:1222-1263`）暴露了 `seek(t)` / `archive()` / `detail()` / `select(i)` / `stats()` / `playBootPreview()`。SSH 客户端的调试与控制入口照抄这个模式即可，不必另造。

**② 最值得照抄的范式是 `bootFrame()`**（`main.ts:883-930`）：把一条实测时间轴写成 `(t) => ({ reveal, lift, zoom, time })` 交给场景（`scene.ts:1141` 的 `cinematic` 参数），实现**时间轴与渲染彻底分离**。SSH 的"登录 → 鉴权 → 连接 → 断开"四段可以直接写成同样的 `(t) => ({...})`。

**③ 两套后处理目前只在壁纸构建里接线**：`HudProjection` 与 `ScreenFinish` 仅在 `wallpaper-effects.ts:36-37` 实例化，而该文件只在 `if (isWallpaper)` 分支构造（`main.ts:1205`）。**桌面构建若要 HUD 曲面与屏幕质感（颗粒/色散/暗角），必须自己 `new` 并每帧 `update()`。**

> 顺带更正一个易混点：项目**没有屏幕空间扫描线后处理**。状态 8 用的"保密等级扫描线"是**投影在三维模型上**的效果（`DESIGN.md:43`），不是全屏滤镜。

**零依赖、可直接搬走的 10 个原语**（纯函数或零依赖类，不需要 Three.js）：
`damp()`（`motion.ts:110`，临界阻尼弹簧）、`sampleCurve()`（`decryption.ts:15`）、`track()`（`boot-tracks.ts:5`）、`SurfaceTransition`（`ui-transitions.ts:5`）、`ArchiveMomentum`（`archive-drag.ts:96`）、`StartupGate`（`startup.ts:9`）、`glassRevealAtHeight()`（`glass-reveal.ts:33`）、`projectHudPoint()`（`hud-projection.ts:4`）、`paintTheme()`（`theme-ui.ts:10`）、`TerminalAudio` 与 `synthesizeSound()`（`audio.ts`）。

其中 **`StartupGate`（`startup.ts:9`）尤其值得注意**：它已有 `"loading" | "waiting" | "starting" | "error" | "started"` 五态、20s 超时（`startup.ts:68`）与失败重试——**这正是 SSH 连接状态机需要的形状**，可以直接照抄骨架。

---

## 5. 三条不可违背的规则

> 这三条是"每一步都可被利用"的判据。任何一条被违反，该动画必须重做或删除。

### R1 · 有源驱动（No data, no animation）

每个动画必须绑定一个**真实事件**或**真实测量值**。找不到数据源的动画不允许存在。
- ✅ 线合拢 = KEX 协商完成
- ❌ 循环播放的扫描线（没有对应的真实扫描行为）
- ✅ 例外：纯装饰的**静态**纹理与排版不受此约束，但它们不参与状态表达。

### R2 · 可中断、可回退、可接管

任何阶段用户都能取消；取消后从**当前显示状态**继续，不跳变。
既有实现已经这么做了：`SurfaceTransition.run()`（`src/ui-transitions.ts:34`）从 `getComputedStyle` 读当前透明度/位移接续；`DecryptionController.update()`（`src/decryption.ts:176`）在重新进入时从当前 clarity 接续。**新代码必须遵守同一标准。**

### R3 · 可见即可查

动画呈现的每一个量，都必须能展开看到**原始出处**：算法名、完整指纹、真实耗时、`ssh -v` 的原始行。
动画是表盘面，原始数据是表盘背面。**做不到这一点的动画就是在撒谎。**

### R4 · 诚实降级

解析失败、事件缺失、未知阶段 → 显示"未知阶段"，**绝不填充假进度**。

### R5 · 双向可利用

"每一步都可被利用"包含两个方向：

- **输入侧**：用户的每一次操作都产生可复用的产物（指纹入库、密钥记住、隧道保存、命令历史）。
- **输出侧**：系统的每一个状态都可被观察、查询、导出（阶段耗时、算法套件、流量统计、审计日志）。

---

## 6. 页面清单

| 页面 | 复用骨架 | 进入/退出过渡 | 承载的工作流步骤 |
| --- | --- | --- | --- |
| **主机阵列** | 现有阵列（`scene.ts`） | 现有 | 选择目标（列 = 环境分组） |
| **主机详情** | 现有详情页（`renderDetail`） | 现有 | 配置、已知指纹、上次连接 |
| **握手页** | 新建，用 `DecryptionController` | `SurfaceTransition` 300/200ms | 状态 3–15 全过程 |
| **指纹确认** | 新建（模态） | 同上，**阻断式** | 状态 8–9，安全决策点 |
| **认证页** | 新建，复用 boot 逐字输入 | 同上 | 状态 12–13 |
| **终端面板**（新增） | 复用 360° 查看器的进出场（320/220ms）+ 项目的表面过渡与 `inert` 隔离 | 状态 16–19 |
| **会话详情** | 复用 360° 查看器骨架 | 同上 | 算法套件、隧道、统计 |
| **日志/审计** | 复用详情页 tab 机制（概述/研究记录/访问日志） | `ContentTransition` 150ms | 状态 20，命令历史 |
| **错误页** | 复用模态 | `SurfaceTransition` | 全部失败路径，每种独立视觉与音效语义 |

### 6.1 终端的挂载点与焦点接管（8 处让路点）

终端是全应用**第一个需要长期独占键盘**的组件，而现有代码从未遇到过这种组件。以下位置必须处理：

| # | 位置 | 问题 | 处理 |
| --- | --- | --- | --- |
| 1 | `main.ts:810` | `const typing = e.target instanceof HTMLInputElement` —— **只豁免 input**，终端若用 `<textarea>` / `[contenteditable]` / 自绘光标，`/`(847)、方向键(852-863)、Enter(864)、Escape(811) 会被全局监听抢走 | 扩展该判定，或在终端容器上于**捕获阶段** `stopPropagation` |
| 2 | `main.ts:798` | 全局键处理入口，`!started` 时无任何按键 | 终端判定必须插在业务分支之前 |
| 3 | `main.ts:800/801/806` | 三个早退分支（查看器打开 / 小游戏接管 / 模态关闭中） | 明确终端与它们的优先级顺序 |
| 4 | `main.ts:816-833` | Tab 焦点环选择器为 `button,input,select,summary,[tabindex="0"]`，**不含 textarea、`[contenteditable]`、`[tabindex="-1"]`** | 补齐，否则 Tab 会跳过或误锁终端 |
| 5 | `audio.ts:342-343` | 捕获阶段监听所有 `keydown` 来解锁 AudioContext | ⚠️ 若终端在捕获阶段 `stopPropagation`，会**连带挡掉音频解锁**（首次播放不触发）。注意注册顺序与时机 |
| 6 | `main.ts:568-570` | `#modal-root` 是唯一不被模态 inert 的 `#stage` 子节点 | 常驻终端挂载点参考此语义；**不要绕过** inert 隔离 |
| 7 | `hud-projection.ts:31` | HUD 曲面投影是 opt-in 列表 | 终端若要跟随曲面，加进 `panels`；`.hud-surface` 由 `hud-projection.ts:42-43` 自动添加 |
| 8 | 层级 | 现有 z-index：`.modal-backdrop` 20、`.pwa-update-notice` 12、`.relay-*` 7、`.workbench` 5 | 终端需自定 z-index 与 `pointer-events`，并考虑 `fit()` 的 `--stage-scale` 缩放（`main.ts:279-320`） |

> 补充：本项目**没有 Ctrl / Alt / Meta 组合快捷键**（全仓确认，修饰键只有 Shift+Tab）。所以 `Ctrl+C`、`Ctrl+D`、`Ctrl+Z` 等终端控制键**目前完全空闲**——这对终端是好消息，冲突面比预想小得多。

---

## 7. 明确不做的事

1. **不做假进度条**。握手没有"百分比"，只有阶段。
2. **不做与状态无关的装饰动画**（违反 R1）。
3. **不把"解密动画"宣传成加密**。它只是表演；安全性来自 SSH 本身。
4. **不在网页层接触私钥**。口令只经 pty 转发，不落盘、不入日志。
5. **不因动画拖慢连接**。动画跟随事件；事件不等待动画（`reduced` 模式下直接跳到最终态，既有逻辑已支持）。

---

## 8. 实施顺序与验收口径

| 台阶 | 内容 | 验收口径（对应本文规则） |
| --- | --- | --- |
| **0** ✅ | Electron 壳 + `--mode desktop` | **已完成，13/13 通过**——见 §11 |
| **1** ✅ | pty + `ssh -E` 事件解析 + 状态机（无 UI） | **已完成**——事件层与传输层均有检查覆盖，见 §11 |
| **2** ✅ | 握手页：把状态机接到 `DecryptionController` | **已完成**——成功与失败两条路径都在运行中的应用里验证，见 §11 |
| **3** ✅ | 终端页：xterm.js + 流量波纹 | **已完成**——31 项冒烟断言覆盖，见 §11 |
| **4** ✅ | 指纹确认 + 认证页 + 错误页 | **已完成**——两个分支与口令路径均在运行中的应用里验证，见 §11 |
| **5** ✅ | 会话详情 + 审计日志 | **已完成**——记录、导出、持久化与主机入口均在运行中的应用里验证，见 §11 |
| **6** ✅ | 事件通道修复：从 pty 分离诊断行 | **已完成**——真实 `ssh.exe` 检查断言"会话进行中就能读到事件"，见 §11 |

---

## 9. 音效映射（SSH 事件 → 既有音色）

项目已建立一条明确的音效语义约定（`verification/AUDIO-DESIGN.md:65`），**必须沿用而不是另起一套**：

| 音色族 | 语义 | 既有用法 |
| --- | --- | --- |
| **玻璃**（`glass()`，五组不等间隔共鸣 + 1.2ms 接触起音） | **实体运动** | 切档、切列、抽取、落定、阵列入场、拆解/重组、返回 |
| **电子音**（`tone()` 纯正弦阶梯） | **系统 / OS 语义** | 窗口开合、系统操作、启动标志、整块文字、确认 |
| **原片采样**（`key`，三个 38ms 短音） | **逐字输入**（专用） | 开场逐字输入 |

另有明确禁令：**不给悬停、也不给所有文字更新配音**（`AUDIO-DESIGN.md:65`）。

### 9.1 映射表

| SSH 事件 | 语义归属 | 复用音色 | 依据 |
| --- | --- | --- | --- |
| 选中主机（抬起） | 实体运动 | `tick` / `column` | 与切档/切列同族 |
| 发起连接（卡片升起） | 实体运动 | `open` | 语义 = 抽取档案，完全对应 |
| `config.loaded` | 系统 | `ui-tick` | 系统操作 |
| `tcp.connecting` | 系统 | `ui-tick` | 同上 |
| `tcp.established` | 系统 | `confirm` | 一次小确认 |
| `banner.remote` | 系统 | `text-reveal` | 语义 = 整块数据显现 |
| `kex.algorithms` | 系统 | `text-reveal` | 同上 |
| **`hostkey.received`（需确认）** | 系统 | **`scan`** | 语义 = 权限扫描/身份核验，**完美对应** |
| 指纹确认通过 | 系统 | `confirm` | — |
| **指纹不匹配** | 系统 | ⚠️ **缺音色** | 见 9.2 |
| `auth.offering` / `auth.accepted` | 系统 | `ui-tick` | — |
| 口令 / 2FA 逐字输入 | 逐字 | `key` | 与开场逐字同族 |
| `auth.succeeded` | 系统 | `welcome` | 语义 = 通过/欢迎，开放和声 |
| `session.entering`（终端就绪） | 实体运动 | `assemble` | 语义 = 部件归位，会话组装完成 |
| 打开终端窗口 | 系统 | `page-open` | — |
| 关闭终端窗口 | 系统 | `page-close` | — |
| 端口转发建立 | 实体运动 | `explode` | 语义 = 结构展开 |
| 断开连接 / 关闭会话 | 实体运动 | `back` | 语义 = 返回/收回 |
| 重连 | 系统 | `ui-tick` | — |

### 9.2 音色缺口（必须新增）

现有 17 类音色里**没有任何"失败/警告/拒绝"语义**。SSH 至少需要三类新增，且**必须用既有的 `tone()` 电子音族**（纯正弦阶梯，`audio.ts`），不得引入新的音色族——否则会破坏"电子音 = 系统语义"的约定：

| 新增 | 触发 | 建议形态 |
| --- | --- | --- |
| `deny` | 认证失败、指纹不匹配 | 下行双音（与 `confirm` 的上行形成镜像） |
| `abort` | 超时、连接被拒、KEX 重置 | 短促下扫，无长尾 |
| `restored` | 断线重连成功 | `confirm` 的变体，音高略低以示"恢复"而非"初次" |

### 9.3 必须遵守的既有约束

- **节流**：`key` 最小间隔 24ms；`tick`/`column` 55ms；其他同类 120ms；活动音效组上限 10（超出踢最旧）（`audio.ts:582-592`）。**流量驱动的高频事件绝不能直接触发音效**——否则 `tail -f` 会把音效系统打爆。
- **音乐闪避**：`open / brand / welcome / array / explode / assemble` 触发时音乐压到 0.65，0.9s 恢复（`audio.ts:599-606`）。连接过程中的连续事件会反复触发闪避，需要重新评估。
- **三轨配乐**的场景比例已有四档：boot `[0.48,0.32,0.18]` / archive `[0.9,0.72,0.65]` / detail `[0.72,0.36,0.12]` / viewer `[0.8,0.24,0.28]`（`audio.ts:561-566`），切换 1.1s 渐变。**终端会话应新增 `terminal` 档位**，而不是复用 detail。
- ⚠️ **授权注意**：逐字输入用的三个 38ms 原片短音（`typing-samples.ts`）**不纳入 MIT 声明**（`public/audio/README.md:10`）。自用无碍，对外分发需处理。

---

## 10. 待补充

### 用户报告的缺陷与修复（2026-09-11）

**报告**：点击 SESSION 输入密码时，每敲一个字母界面闪一下然后消失；面板无法关闭；反复点击后页面卡死。

**复现**：此前的密码场景全部是**直接调用 UI API**（`ui.answerSecret("hunter2")`），从来没有真正往输入框里敲过键——所以这个缺陷一直在测试覆盖之外。补上了 `runTypingCheck`：通过主机选择面进入密码提示，然后用 `webContents.sendInputEvent` 发**真实按键**（合成 `KeyboardEvent` 没有默认行为，字符根本不会落进输入框，无法复现）。

**两个真实缺陷**：

1. **`show()` 无条件重建 `body.innerHTML`**。每次重建都销毁输入框节点，连同用户已输入的内容一起丢掉——这就是"每敲一个字闪一下然后消失"。现在只在**请求确实变化时**才重建（按内容签名比对）；输入框已有焦点时也不再重复 `focus()`，避免与光标打架。
2. **`inert` 的恢复挂在动画完成回调上**（更严重，"卡死"的成因）。`SurfaceTransition` 在被打断时会 reject `finished` promise，`.catch(() => {})` 把它吞掉，于是 `complete()` 永不执行、`restoreSiblings()` 永不执行——**`#stage` 的每个子元素永久停在 `inert`**，整个应用点什么都没反应，面板自然也关不掉。

四个面板（终端、决断、记录、主机）各自复制了这套快照逻辑，所以缺陷有四个副本。已抽成共享的 `src/ssh/surface.ts`：

- **进入是幂等的**（重复进入不再 `append` 已挂载的节点——移动节点会丢焦点）；
- **2026-09-12 修订**：四类面板共用同一模态栈。退出完成前保留输入隔离，重开取消退出并延续原 scope；同步释放只用于销毁，避免过渡中背景被误操作；
- 已断开的节点不再尝试恢复。

**验证**：新增 6 项"打断测试"断言——连续在淡出中途打开另一个面板，最后断言无残留面板、`inert` 数量回到基线、导航与档案阵列仍可交互（`ArrowDown` 后选中项确实变化）。另加 4 项打字断言：焦点保持、字符累积、输入框未被重建、**打字期间渲染增量为 0**。

**仍存在的测试盲区**：这一轮暴露的最大教训是"直接调 API 的测试测不到输入路径"。同类风险仍在：鼠标拖动、滚轮、触摸手势都还没有用真实输入事件验证过。


**已记录的缺口**（都不影响已完成的连接工作流，但需要在继续开发前处理）：

- [x] **桌面 CSP**：构建注入本地脚本、资源和 blob worker 策略；禁用内联脚本及 eval，保留既有 DOM 动画所需的内联样式。Electron 继续启用 sandbox / contextIsolation，IPC 验证窗口、主框架和来源。
- [x] **日志保留与清理**：`userData/ssh-logs/` 保留 30 天、最多 200 个会话、64 MiB。启动及保存记录后清理，主机面板也提供入口；活动会话豁免，旧 JSON/log 成对处理，不递归、不跟随链接。
- [ ] **端口转发可视化**：目前只支持校验后的参数及本机 SSH 配置，没有隧道管理界面。
- [x] **本机截图复核**：核对密码提示、终端和长记录面板，修复记录越界与终端非等宽字符间距。小窗口也检查了记录的滚动与按钮可见性；完整鼠标、触摸及用户听感验收仍不在本轮结论内。
- [ ] 屏幕后处理（颗粒/色散/暗角）与"连接质量"的绑定关系——需先决定桌面构建是否接线 `ScreenFinish`。
- [ ] 多标签会话与阵列的对应关系（多个会话同时存在时的视觉分层）
- [ ] SFTP 面板的设计语言落点
- [ ] 完整 SSH 事件音效映射、`deny` / `abort` / `restored` 音色和 terminal 配乐场景均尚未接通，不只是波形参数待定。

**与规范原计划的偏差**（记录清楚，避免下次误以为已实现）：

- §6 的**主机档案卡绑定已实现**：桌面模式按列把主机分配到 40 个档案位置并保存映射；对应详情展示配置、历史会话和事件日志。超出 40 个的主机仍可从独立列表进入，原 `content/archives.json` 内容保持独立。
- **会话终端是主机档案卡的内容，不是独立窗口**（2026-09-12）：有会话时卡片正文区即终端，随卡片骨架渲染；揭示复用解密动画（clarity → `--reveal`），`metadata` 显示会话验证过的事实，操作按钮变形为 DISCONNECT。无卡片归属的主机保留浮层终端。见 [SSH-EVENT-CHANNEL](verification/SSH-EVENT-CHANNEL.md)。
- **会话同时是三维档案的内容**（2026-09-12 第二版）：有会话的详情卡里，左侧模型的内构换成有厚度的终端舱（`src/ssh/terminal-deck.ts`），屏幕画真实鉴权日志（pty 前的 `ssh -v` 行）与无头 xterm 镜像（pty 后的输入输出）；`interactive` 时盖板+螺丝+标签竖直升起开盒，终端舱前移放大到操作尺寸。DOM 终端仍是输入与全彩回显的操作面。
- §4.2 计划的"用 `DocumentDecryption` 的红条逐条揭示主机信息"未采用：握手过程太快，逐条揭示来不及读。改为在**会话记录**里给出每条事实及其来源行——信息密度更高，且随时可查。

---

## 11. 实施记录

### 台阶 0 · Electron 壳 + `--mode desktop`（已完成）

**改动清单**（对原作者代码的修改只占 3 个文件，其余为新增）：

| 文件 | 改动 |
| --- | --- |
| `vite.config.ts` | `base` 增加 desktop 分支；新增 `desktop-index` 插件（仅剥离 manifest link，**不注入 host.js**）；新增 watcher 忽略 `**/*.tmpdir/**` |
| `src/desktop.ts` | **新增** — `isDesktop` 判定 + `data-desktop` 标记，照 `wallpaper.ts` 的写法 |
| `src/pwa.ts` | 2 处门禁加上 `isDesktop` |
| `package.json` | `main: electron/main.cjs`；新增 `dev:desktop` / `build:desktop` / `start:desktop` / `smoke:desktop` 及对应 `pre*` 钩子 |
| `electron/` | **新增** — `main.cjs`（窗口 + 冒烟测试）、`preload.cjs`、`dev.cjs`（一键启动器）、`ensure.cjs`（二进制补拉） |

**冒烟测试**（`npm run smoke:desktop`，13 项断言全部通过，退出码 0，控制台零问题）：

```
loads from file://           PASS     3D scene live (WebGL)      PASS
desktop flag set             PASS     startup entered boot       PASS
preload bridge exposed       PASS     loading overlay retired    PASS
stage rendered               PASS     entry screen not blank     PASS
PWA surface removed          PASS     boot screen not blank      PASS
no service worker            PASS     running screen not blank   PASS
entry gate accepted input    PASS
```

截图证据：`dist/desktop-smoke-{entry,boot,running}.png`（1584×861），亮度跨度 0.9、颜色数 20–72 —— 确认**不是白屏**。

**过程中发现的三个坑**（都已解决，记录备查）：

1. **Electron 44 没有 `postinstall` 钩子**——它的 `package.json` 里根本没有 `scripts` 字段，所以 `npm ci` 之后二进制不存在，首次启动会报 "Electron failed to install correctly"。已由 `electron/ensure.cjs` 在 `predev:desktop` / `prebuild:desktop` 自动补拉。
2. **`show: false` 的窗口会让 `document.hidden` 为真**——`StartupGate.enter()` 里 `if (unlocked && !document.hidden)` 判否，直接掉进"声音未就绪"错误分支。冒烟测试改用 `opacity: 0 + showInactive()`，并关掉 `backgroundThrottling`。
3. **启动闸门不接受合成键盘事件**——`startup.ts:32` 的 keydown 只处理 Tab，Enter/Space 交给原生 `<button>` 激活。冒烟测试必须驱动 `.entry-start` 的真实 `click()`，而不是派发 `PointerEvent`/`KeyboardEvent`。

**验证过的、无需改动的部分**（原先担心的 14 处必改点，实际只有 3 处需要动）：

- `main.ts:1086` 的 `await window.rhineWallpaperPropertiesReady` **本就有 `if (isWallpaper)` 保护**，不注入 host.js 就不会挂起
- `main.ts:1087/1090`、`1159`、`1163-1204`、`1205-1219` 的宿主相关分支在 desktop 下静默 no-op，行为等同网页版
- `asset-url.ts` 的 `BASE_URL` 前缀在 `base: "./"` 下自然正确，GLB 与字体全部加载成功（`canvases: 1` 即证明 WebGL 场景与模型都起来了）

**回归**：`npm run build`（网页版）仍然通过，1.49s，退出码 0。

### 台阶 1 · 事件解析与连接状态机（事件层已完成）

**新增文件**：

| 文件 | 职责 |
| --- | --- |
| `src/ssh/events.ts` | OpenSSH debug 行 → 结构化事件。30 条匹配规则，覆盖成功路径 17 类 + 失败路径 7 类 |
| `src/ssh/session.ts` | 连接状态机。10 个 phase、单调推进、终态粘滞、停滞检测、事实台账、时间轴 |
| `scripts/check-ssh-events.mjs` | 42 条解析断言 + 状态机行为断言（`npm run check:ssh`） |

**设计要点**（都直接对应 §5 的规则）：

- **parser 永不抛异常**：不认识的行返回 `{ matched: false, raw }`，调用方必须原样保留（R4）。
- **状态机不接受时间驱动**：`tick()` 只能置 `stalled` 标志，**永不推进 phase**——测试里有一条专门断言 `idle` 状态在 `t=10⁹ms` 时仍然是 `idle`（R1）。
- **停滞不是进度**：超过阶段 deadline 只标记 `stalled`，`phase` 与 `label` 保持不变；指纹确认与认证阶段 deadline 为 `Infinity`（因为它们本就在等真人）（R4）。
- **事实台账带出处**：每个 `SshFact` 都持有产生它的原始事件与原始行，供 UI 展开查看（R3）。
- **时间轴只记录真实发生的转换**，不是从事件流反推（见下方缺陷 ②）（R5）。

**两处由测试抓出的真实缺陷**（都已修复）：

1. **失败原因取错了行**。原始实现用「最后一个事件」描述失败，而 OpenSSH 在 `kex_exchange_identification: Connection closed by remote host` 之后还会打印一行 `Connection closed by …`，于是诊断信息退化成无信息量的"连接已关闭"。现在单独记录**导致失败的那个事件**，输出为 `密钥交换阶段被对端中断：Connection closed by remote host`。
2. **时间轴记录了从未发生的转换**。终态是粘滞的（`failed` 之后不再迁移），但时间轴原先是从事件流反推 phase，于是把后来的 `Connection closed` 记成了 `failed → closed`。现在时间轴由**状态机实际执行的转换**追加而成。

**测试覆盖**：真实抓包 fixture（本机 `ssh -v` 打 github.com 的 11 行，含 TUN 代理导致的真实 `kex.reset`）+ 标准 OpenSSH 格式的成功路径 fixture + 5 类失败 fixture；断言涵盖解析字段、原始行保留、单调性、终态粘滞、停滞语义、时间轴时长非负、fact 出处、`reset()` 清空。

**仍待完成**：`node-pty` 起 `ssh.exe`、`-E` 日志 tail、IPC 通道与 preload 暴露（台阶 1b）。

### 台阶 1 · 传输层与 IPC（已完成）

| 文件 | 职责 |
| --- | --- |
| `electron/ssh-args.cjs` | **argv 构造 + 启动描述符校验**。主进程拥有可执行文件，渲染层只能送描述符 |
| `electron/session.cjs` | pty 会话：spawn、`-E` 增量 tail、prompt 检测、byte 计数、resize、stop。**不依赖 electron**，可在纯 Node 下测试 |
| `electron/preload.cjs` | 手工枚举的会话桥：`start/write/resize/stop` + `onData/onLog/onPrompt/onTraffic/onExit`，**不暴露 `ipcRenderer`** |
| `electron/main.cjs` | IPC 处理器、日志落盘（`userData/ssh-logs/`）、250ms 流量测量通道 |
| `src/ssh/client.ts` | 渲染层会话客户端：把事件流变成 UI 可画的状态；暴露 `window.rhineSsh` 自动化面（对齐既有 `window.rhine` 惯例） |
| `scripts/check-ssh-session.mjs` | 会话层端到端检查（真实 ConPTY + 真实日志 tail + 真实状态机） |
| `scripts/fixtures/fake-ssh.mjs` | ssh 替身：接收真实 argv，把 debug 流**逐行增量**写进 `-E` 目标，再在 pty 上打印提示符 |

**安全边界**：渲染层送的是 `{ target, port?, identityFile?, extraArgs? }`，**不能指定可执行文件**；`-E`/`-S`/`-f`/`-O` 等保留参数被拒绝；目标不能是裸 flag、不能含空白。构造出的 argv 原样返回给渲染层显示（R3）。

**两项检查**（`npm run check:ssh-session` 与 `npm run smoke:desktop:session`）覆盖的重点是**增量性**：如果事件只在进程结束后才出现，那么连接过程中的每个动画都是假的。检查断言第一条日志在会话总时长的一半之前到达，且运行期采样到 ≥3 个不同 phase。

**端到端冒烟 13/13 通过**（退出码 0，无跳过）：渲染层 → preload → IPC → 主进程（pty + `-E` tail）→ IPC → 渲染层 → 状态机。其中 `pty carried session bytes` 与 `terminal received the prompt` 证明**终端通道**（94 字节）与**事件通道**（19 行）确实分离——终端里一个 `debug1:` 都没有。

**过程中的三个发现**：

1. **`electron.exe` 不能作为 pty 子进程替身**。实测：`node.exe` 在 ConPTY 里正常输出 84 字节；`electron.exe` 无论是否加 `ELECTRON_RUN_AS_NODE` 都是 **0 字节**——它是 GUI 子系统程序，会与伪控制台脱离。这只影响测试台（生产跑的是 `ssh.exe`，标准控制台程序），测试台改为显式解析真实 `node.exe`，找不到时**标记为跳过而不是静默通过**。
2. **node-pty 在 Windows 上 kill pty 会起 `conpty_console_list_agent`**，无控制台可 attach 时抛 `AttachConsole failed`；检查脚本因此需要显式 `process.exit(0)`（所有断言已跑完）。已确认**不残留孤儿进程**（运行前后 node/conhost 进程数一致）。
3. **Electron 报 CSP 缺失警告**。已记录，待台阶 3 与终端面板一并处理（需要连带验证 `file://` 下的策略语义）。

**node-pty 不需要为 Electron 重编译**：实测 `ELECTRON_RUN_AS_NODE=1 electron.exe` 加载 `node-pty` 并成功起 ConPTY（`exit=0 contains=true`），确认 N-API 预编译二进制可直接复用。

### 台阶 2 · 用真实事件驱动解密动画（已完成）

**核心实现**：`src/ssh/handshake.ts` 的 `HandshakeDriver`。

约定（§4.1 的混合驱动策略落地）：

- **相位切换点来自真实事件**——每个 `debug1:` 事件映射到解密时间轴上的一个里程碑秒数（`HANDSHAKE_MILESTONES`，16 条）。
- **里程碑之间的插值沿用项目自己的曲线与弹簧**——用 `damp()`（`motion.ts:110`，临界阻尼，rate 3.4）追赶目标，而不是新写一套缓动。
- **没有事件就没有运动**：`advance(dt)` 只把参考时间推向"最后一个真实事件要求的位置"，事件停了动画就停。**慢的服务器就是慢**。
- **终态冻结**：任何失败事件把 `frozen` 置位，时间轴停在真正到达的阶段，后续事件一律拒绝。

**接进场景**：`scene.ts` 新增一个公开接缝 `setDecryptionReference(seconds | null)`，在 `decryption.update(..., referenceTime)` 的第 4 个参数上优先于影片时间轴；`main.ts` 的 `frame()` 里通过一个只在 desktop 构建安装的 `sshFrame` 钩子，每帧用**真实帧间隔**（并 clamp 到 0.25s，防止窗口切回来时快进）推进驱动。

**运行中的应用里验证的轨迹**（`dist/desktop-session-smoke.json`，每相位记录 clarity 最低→最高）：

```
成功连接：  waiting 0→0 → joining 0→0 → connected 0→0 → retracting 0→0 → revealing 0.18→1 → clear 1→1
被拒绝：    waiting 0→0 → joining 0→0 → connected 0→0        ← 停在这里，玻璃始终未变清晰
```

失败那条的驱动落点：`{reference: 36.5, target: 36.5, frozen: true, milestone: "auth.methods", clarity: 0, settled: true}` —— 真实事件链是 `resolving → connecting → handshake → authenticating → failed`，动画就停在 `auth.methods` 对应的位置。

**单元检查**（`npm run check:ssh-handshake`）额外覆盖：30 秒空帧不产生任何位移（R1 的硬断言）、迟到或重复事件不回退、五条失败路径各自的落点与相位、`reset()` 清空、里程碑顺序与真实握手顺序一致。

**一个被测试暴露的调参问题**：临界阻尼有很长的指数尾巴，`SETTLE_EPSILON = 1e-4` 时间轴秒意味着最后一毫秒要走约 4 秒，`phase` 会长时间停在错误的边界一侧。已改为 `1e-3`（时间轴的 1 毫秒，视觉上无差别）。

### 台阶 3 · 终端面板与流量仪表（已完成）

**新增文件**：

| 文件 | 职责 |
| --- | --- |
| `src/ssh/terminal.ts` / `terminal.css` | xterm.js 会话面板：真实字节入、真实按键出，复用项目的表面过渡与 `inert` 隔离 |
| `src/ssh/traffic.ts` | 把测量字节换算成 `MusicBands`（低频=下行、中频=上行、高频=突发），供 `scene.setPlayfield` 消费 |
| `scripts/check-ssh-traffic.mjs` | 流量计单位检查（归一化曲线、静默衰减、上下行分离、突发） |
| `electron/probes/session-probe.js` | 冒烟探针（见下方工程注记） |

**键盘接管的决定**（§6.1 列出的冲突点在这里落地）：

- 终端打开期间，全局 `keydown` **整体让路**，只保留 `Ctrl+Shift+E` 关闭。全项目没有其他 Ctrl/Alt/Meta 快捷键，所以不会撞车。
- **Escape 交给 shell**，不用于关闭面板——vim、less、readline 都需要它。这是终端与应用快捷键的正面冲突，选择让终端赢，并把关闭做成显式和弦。

**面板外观沿用设计语言**，没有另起一套深色终端：暖灰白底、单一暖色强调（琥珀光标与选区）、发丝分隔线，页脚三个数字（↓/↑ 速率、会话时长）全部来自真实测量。

**流量 → 阵列的映射**（实测证据，来自冒烟报告）：

```
会话前    bands { low: 0,      activity: 0 }
会话中    bands { low: 0.2147, activity: 0.2147 }
```

终端画面（真实 pty 往返）：`operator@lab-node-07:~$ ping[fake-ssh] pingoperator@lab-node-07:~$`

**工程注记**：探针原本是 `main.cjs` 里一段 130 行的模板字面量，结果 `const SESSION_PROBE = \`…\`` 在模块加载时求值成了 `NaN`（`typeof` 报 `number`、`String().length` 为 3），导致整轮冒烟以"全部断言失败且无任何错误信息"的形式静默失败。**现象未能最终定因**，但把探针移到 `electron/probes/session-probe.js` 作为真实文件后问题消失。教训是明确的：不要把上百行代码塞进模板字面量，它会同时失去语法高亮、lint 覆盖和转义常识（`'ping\r'` 得写成 `'ping\\r'`）。

### 台阶 4 · 安全决策面（已完成）

**新增文件**：`src/ssh/prompt.ts` / `prompt.css`——一个面板承载四种状态：`hostkey`（阻断式确认）、`password` / `passphrase` / `verification-code`（口令输入）、`failure`（失败与原始证据）。

**这一层是真实的安全边界，不是装饰**：

- **指纹确认阻断工作流**：ssh 停下来等 `yes/no`，面板出现，未回答之前不继续。
- **口令只在内存里过一遍**：`answerSecret()` 把值写给 pty 后立即清空输入框，不进日志、不进配置、不进任何存储。测试断言面板文本中不残留 `hunter2`。
- **失败页展示原始证据**：阶段时间轴 + 完整的 `ssh -v` 原始行（R3）。拒绝主机密钥时给出的原因是"主机密钥与已知记录不符"，而不是一个退出码。

**过程中发现并修复的三个真实缺陷**（全部在生产路径上，不只是测试问题）：

1. **pty 提示符里夹着 ANSI 转义序列**。实测原始字节是
   `operator@passhost's password:\u001b[1C\u001b]0;…\u0007`
   ——冒号后那个空格被 `\x1b[1C`（光标前移）替代，窗口标题序列跟在后面。原来的 `'s password:\s*$` **永远匹配不上**，真 ssh 也一样。现在先剥离 OSC/CSI 转义、再取最后一行非空文本、用整行锚定匹配。
2. **Windows ConPTY 的行终止符是 `\r` 不是 `\n`**。发 `\n` 会被回显但**不会提交行**，于是确认框永远等不到答复。改用 `\r`（POSIX tty 也会把 CR 翻译成 NL，两个平台都正确）。
3. **用户拒绝主机密钥后日志里没有任何终止事件**。ssh 只把 `Host key verification failed.` 打到 pty 就退出了。补了两条真实信号通路：pty 通知解析（**窄集合**，只接受明确失败；正常结束交给退出码，避免用户 `cat` 一个含该文本的文件就误判会话结束），以及 `SshSessionTracker.ended(exitCode)`——退出状态本身就是证据。

**另一处竞态**：pty 的问题提示可能**早于** `-E` 日志里的指纹行到达（两个通道独立轮询）。让用户确认一个还没读到的指纹，正是"没有证据的断言"。现在指纹到达后会重新渲染面板；指纹尚未读到时也如实显示空值而不是编造。

**证据**（`dist/desktop-session-smoke.json`，40 项断言全部通过）：

| 场景 | 结果 |
| --- | --- |
| 未知主机密钥 | 面板出现，类型 `hostkey`，**显示真实指纹** `SHA256:uNiVztks…D2s` |
| 确认并继续 | 会话建立（`reachedInteractive: true`，退出码 0） |
| 拒绝 | `phase=failed`，退出码 255，原因"主机密钥与已知记录不符" |
| 需要口令 | 面板出现，类型 `password`；提供口令后会话建立，退出码 0 |

### 台阶 5 · 会话记录与主机入口（已完成）

**新增文件**：

| 文件 | 职责 |
| --- | --- |
| `src/ssh/audit.ts` | 纯函数：把会话状态变成结构化记录 + 可读的文本导出 |
| `src/ssh/audit-panel.ts` / `audit-panel.css` | 会话记录面板：阶段耗时、协商结果、流量、执行的命令 |
| `src/ssh/hosts-panel.ts` / `hosts-panel.css` | 主机选择面：列出用户 `~/.ssh/config` 里的主机 |
| `scripts/check-ssh-audit.mjs` | 记录与导出的单元检查 |
| `electron/probes/session-probe.js` | 新增 `hostPickerCheck` / `auditCheck` 两个场景 |

**记录的两个方向都闭环了**（R5）：

- **输出侧**：每个会话自动在其事件日志旁写一份 JSON 记录；面板展示的阶段耗时来自事件到达时刻，每条协商结果都附**产生它的原始行**；文本导出可读、可脱离本应用使用。
- **输入侧**：主机选择面读的是用户自己的 `~/.ssh/config`——客户端本来就继承这份配置的全部设置，所以列出的也应该是同一批主机。点一行即建连，这是整条工作流的入口。

**一个设计取舍**：主机列表**只读不解析语义**。它报告 `Host` 行的 `Hostname` / `User` / `Port`，但不试图复刻 ssh 的配置合并规则——真正生效的参数永远以 ssh 自己解析的为准。面板文案也如实这么写。

**一处真实缺陷**（由导出文件暴露）：

1. **正常结束被写成"失败原因"**。`ended(0)` 把结束语塞进了 `failure` 字段，导出里出现"失败原因 会话正常结束"。已改为：`failure` 只在 `phase === "failed"` 时非空——正常结束有 *结果*，没有 *原因*。
2. **阶段时间是页面时钟而非会话相对时间**。导出里出现 `@26.85s`，读起来像"会话第 26 秒"，实际是页面启动以来的毫秒数。已在记录构建时减去首个阶段的时刻。

**一处测试自身的缺陷**：记录面板与主机选择面**故意共用** `.ssh-audit` 布局类，于是探针的 `.ssh-audit-body` 选择器抓到了主机列表，导致四条断言读到错误的文本。已给记录面板加独立的 `ssh-record` 标识，并在注释里写明两者为何共用样式。

**两处流程缺陷**（都不是功能 bug，但会让验证结果失真）：

1. **网页构建与桌面构建共用 `dist/`**。回归时最后跑 `npm run build`（网页版）会覆盖桌面产物，于是会话冒烟静默地加载了网页版——`window.rhineSsh` 不存在，结果表现为"全部 55 项断言失败"。桌面构建已改为独立输出 `dist-desktop/`（`.gitignore` 同步），与壁纸版用 `release/wallpaper` 是同一个道理。
2. **检查脚本会因为字段缺失而崩溃**而不是报告失败。`password.panelTextAfter.includes(...)` 在场景提前返回时抛 `TypeError`，整轮结果退化成一条 "smoke threw"。已改为 `has(value, needle)` 形式的防御性断言，并让异常路径也带上探针结果。

**实测证据**（55 项断言全部通过）：

```
主机选择器：点击测试别名 → 会话建立 ✓（session-smoke 下走替身，不碰真机；本机地址已省略）
导出文件：  dist/session-record-export.txt（76 行，含每条事实的来源行）
持久化：    userData/ssh-logs/<id>.json（含 phases 与带 source 的 facts）
```

---

### 台阶 6 · 事件通道：真实客户端（已完成）

**用户报告**：点击连接、输入口令后似乎登录失败；再次点击连接提示"已有会话正在进行"。

**根因**（实测，非推断）：`ssh -E <file>` 在 Windows 上把该文件以独占共享模式打开。会话进行中主进程的 `fs.openSync(logPath, "r")` **始终返回 `EBUSY`**——实测连续 6 秒打开失败，直到 ssh 退出前关闭 stderr 才可读。于是：

- 事件通道在连接过程中是死的，握手事件全部在**结束前的一瞬间**抵达（实测：22 行全部落在 2493ms，会话 3476ms 结束）；
- `auth.succeeded` / `session.entering` 永远到不了 → 相位停在 `authenticating` → **终端不会打开** → 用户认为"登录失败"；
- ssh 其实还活着 → 再次点击连接正确地报告"已有会话正在进行"。

口令本身没有问题：用真实 `ssh-keygen -y`（同样的 /dev/tty 读取路径）验证过，键入的密钥被真实 OpenSSH 接受。

**排除的替代方案**（都实测过）：预持文件句柄 → ssh 直接 `Couldn't open logfile`（Broken pipe）退出；`-E \\.\pipe\…` → 能连上但被缓冲，直到对端关闭才有数据；`cmd.exe 2>` 重定向 → 可以流式读取，但会多一层进程，杀掉 cmd 会留下孤儿 `ssh.exe`。

**采用**：不带 `-E`，让诊断行走 pty，在主进程按行分离（`electron/pty-events.cjs`）。实测不带 `-E` 时这些行完整、增量、不折行（100 列下 108 字符的行也没被 ConPTY 折行）。日志文件改由主进程自己写，审计轨迹因此更可靠。

| 文件 | 改动 |
| --- | --- |
| `electron/pty-events.cjs` | **新增** — 诊断行识别与流分离，纯逻辑、可单测 |
| `electron/session.cjs` | 去掉文件 tail；改为分流 + 自写日志；未终止片段有 150ms 兜底释放 |
| `electron/ssh-args.cjs` | `buildSshArgs` 不再下发 `-E` |
| `scripts/fixtures/fake-ssh.mjs` | 替身改为把诊断写到 stderr（真实客户端不带 `-E` 时的行为） |
| `scripts/check-ssh-real-client.mjs` | **新增** — 跑真实 `ssh.exe` 的检查 |
| `src/ssh/events.ts` | `kex.reset` 接受 `debug1:` 前缀（真实客户端就是这么输出的） |

**验证**：新增的 `npm run check:ssh-real-client` 断言"第一条诊断行早于会话时长的一半"、"会话进行中日志文件可读且已含 `debug1:`"、"相位在 ssh 运行期间真的推进"。实测第一行落在 368ms / 共 3483ms（10%）；修复前是 2493ms / 3476ms（72%）且中途文件打不开。七组 `check:ssh*` 与 `tsc` / `build:desktop` 全部通过。

**验证边界**：本轮仍未连接真实 SSH 服务器（只跑了真实客户端），Electron 桌面冒烟因本机 shell 无法启动 GPU 进程而未能重跑——`check-ssh-real-client` 与 `check-ssh-session` 已覆盖其传输层与状态机部分。

---

*本规范是"动画即仪表盘"这一约束的具体化。评审任何新增动画时，先问：它由什么真实数据驱动（R1）？能否被中断（R2）？用户能否查到原始出处（R3）？三个问题有一个答不上来，就不要加。*
