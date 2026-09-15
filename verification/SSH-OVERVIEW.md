# SSH 总览、会话标签与凭据验证

日期：2026-09-14。范围为桌面 SSH；采用现有 TypeScript / DOM / WAAPI、Three.js 和 Blender 资产。只做本地提交，不推送或部署。

## 本轮行为

桌面主页改为居中的半透明磨砂主机总览，背后保留玻璃档案阵列。五条物理阵列只承载主机，命令、目录收藏、历史和密钥库位于总览页签。此方案取代上一轮六条功能列；稳定 H / S / C / R 编号与已有本地数据继续使用，普通网页和壁纸仍显示原资料。

悬停或键盘聚焦主机约 100ms 后，背景以 750ms 连续曲线定位；中途换目标从当前位置和速度接续，只在到达最终目标时选档。移回起始主机能取消先前目标，经过的主机不会连接。点击主机返回其最近使用的活跃会话，行末 ＋ 另开连接。

总览和终端使用横向会话标签，支持点击、左右方向键、Home / End 与 Ctrl+Tab。连续键盘切换会把焦点保留在新面板的会话标签上，不能将后续方向键误送远端。关闭后台标签保留当前输入；存在传输时显示所属会话的原位确认；最后一个标签消失后，其终端画面保留到收盒结束，再释放解析器与纹理。从总览关闭会话不会重新打开终端。

终端右上有独立、放大的收起入口和可点击的设置。设置挂在未缩放视口并进入同一个模态栈，隔离后台输入，关闭后回到当前终端。xterm 继续按原生 CSS 像素渲染；保留 2.1 秒二次加速的同步开盒与拉近、1.2 秒重组和内胆坐标。

桌面配色使用骨白／蓝石墨、冷青灰与香槟琥珀，仍保留玻璃、细线和标签。重开、收起、主动结束会话、切换标签有独立短提示，遵循已有声音开关与音量；关闭最后一个标签不会叠加收起／切换提示。认证、连接与传输声音继续去重，输入输出和逐秒监控不发声。音色技术验证不代表用户已经确认最终听感。

画面复核修正了总览玻璃底色与文字渐变不同步的问题，两者现在共享实际主题进度；保存凭据复选框使用横向排列，避免继承普通表单标签的竖排布局。配置页与密钥库附件等待主题和字段入场结束后截图。

## 总览收起与口令页退出（2026-09-14）

总览原先是一张 `inset: 0` 的全屏层，只要 `mode === "archive"` 就一直显示，面板占 `min(1320px, 74vw) × min(780px, 76vh)`，正压住三维阵列中心，而面板上没有任何关闭入口。现在标题右侧有「收起 ⇱」：玻璃面板下滑出画面，`root` 内留下一条底部标签 `▲ 主机总览 · NN 台主机 · NN 个连接`，点它或按 `Ctrl+Shift+H` 展开。收起状态记在 `localStorage` 的 `rhine-ssh-overview-collapsed`。标签上的计数与面板汇总行取自同一次统计，不会互相矛盾。

`Esc` 只在面板可见（`mode === "archive"`）且没有模态、且总览实例存在时才切换，不抢其它界面的按键。`openSshHosts()` 在总览已收起时会先展开再切到主机页，否则「切页」会落在一张看不见的面板上。

需要口令时的认证层同样盖住整个画面，并且**盖住了详情页自己的返回按钮**：`.ssh-prompt` 是 `z-index: 30` 且 `pointer-events: auto` 的整层，而 `.back-button` 在 `z-index: 4` 的 `#detail-ui` 里——按钮在渐变下透出来，看起来可用，点下去却被认证层吃掉。`Esc` 则只在焦点恰好还在面板里时才生效：面板原本只在自己的 `root` 上监听 `keydown`，焦点一旦被点到别处，事件冒泡到 `document` 后撞上 `main.ts` 里 `if (sshPromptOpen) return;` 的早退分支，键就完全没反应。

现在认证层自带左上角「← 返回总览 `ESC`」，位置与尺寸对齐详情页的 `.back-button`，同时把被盖住的那个隐藏掉（`[data-ssh-prompt="true"] :is(#detail-content, .back-button)`）。`keydown` 改挂在 `document` 的捕获阶段，面板打开期间生效、`hide()` 与 `dispose()` 成对移除，因此焦点在哪里都有效。按钮与 `Esc` 走同一个 `leave()`：`hostkey` 拒绝、其余口令与验证码中止本次尝试，随后退回主机总览；只有 `failure` 保持原有的「仅关闭」语义，因为那是可以放着不管的只读面。口令不能「不中止就退出」——ssh 正阻塞在这一行上。

验证：`npm run check:ssh-overview-collapse` 10/10 通过，覆盖面板整体滑出画面、原位置不再接收点击、下方阵列重新收到指针事件、边缘标签带实时计数、标签与快捷键都能展开、收起状态写入 `localStorage` 并在刷新后保持、以及 `Ctrl+Shift+S` 会先展开再切页。截图 [展开](overview-collapse/01-expanded.png)、[收起后](overview-collapse/02-stowed.png)、[刷新后仍收起](overview-collapse/03-stowed-after-reload.png)。`npm run check:ssh-deck-teardown` 中的 `the corner button covers the detail page's own` 断言详情页按钮已隐藏且新按钮有实际尺寸；截图 [terminal-teardown/01-prompt-back-button.png](terminal-teardown/01-prompt-back-button.png)。

## 保存密码与密钥

主机配置支持自动、密码和指定私钥。可在编辑页保存密码／私钥口令，也可在真实认证页选择记住；后者仅在认证成功后落盘。凭据使用 Electron `safeStorage`，由当前 Windows 账户加密，独立保存在 `ssh-credentials.json`。没有读取秘密的 IPC，渲染端只接收保存状态和密钥元信息。旧主机配置版本 1 可读取，新写入为版本 2。

自动填入绑定目标档案、`ssh -G` 解析的实际主机／端口／用户、实际握手指纹和所选密钥。主连接认证成功后才把本次输入提供给同目标的 SFTP／监控；每条连接的同类凭据只自动尝试一次，失败转为人工输入。跳板机和目标分别检查实际认证对端，keyboard-interactive / OTP 独立询问。旧失败请求不会使另一个会话刚保存的新密码失效。

密钥库支持 OpenSSH / PEM 文件引用和加密粘贴导入。文件引用检查内容哈希，不修改原文件；同一条密钥可关联多个主机。导入密钥仅在连接期间写到受当前账户 DACL 保护的临时目录，由引用计数管理，在最后一个原生会话和辅助 worker 退出后删除；下次启动清理异常退出残留。设置目录权限只修改 DACL，不请求特权 SACL，完整进程重启后仍能使用。

ConPTY 提示识别使用完整的认证前控制台流，原始 xterm 输出不删改。覆盖中文与空格路径、换行重绘，以及 OpenSSH 将私钥路径截为 100 个 UTF-8 字节的情况。截断路径必须唯一匹配有效 IdentityFile；宽字符行尾补位只产生有界候选，不宽泛删除真实路径空格。

主机保存成功但凭据失败时，保留同一主机 ID、版本与本次输入，重试不会新增重复主机。编辑页切离和密钥导入成功后清空秘密字段；主机和工作区 JSON 不保存明文密码、口令或私钥。

## 滚动性能

基线已经通过 ANGLE / D3D11 使用 NVIDIA GeForce RTX 5070 Ti Laptop GPU。此次优化集中于复用可见性计算的临时对象、裁剪离屏归位模型、避免克隆不可见终端，并把已回落到阵列的细微弹簧尾部并入现有实例批次。可见抽取／重组仍保留完整模型、姿态与自己的终端快照。

同一台机器，headless Edge，1920×1080、DPR 1、原默认画质；未开启超级性能模式、未关闭阴影或后期。每个场景采样约四秒，图形任务顺序执行。报告保留 [旧版原始数据](ssh-overview/performance-baseline.json) 与 [新版原始数据](ssh-overview/performance.json)。

| 主机数／场景 | 旧版帧间隔 p95 | 新版帧间隔 p95 | 绘制调用峰值：旧 → 新 |
| --- | --- | --- | --- |
| 32／快速滚轮 | 129.2ms | 21.0ms | 1174 → 230 |
| 256／快速滚轮 | 129.2ms | 20.9ms | 1190 → 230 |
| 256／静止 | 33.4ms | 8.4ms | 131 → 131 |
| 256／新总览连续悬停 | 无此入口 | 8.4ms | 新版 131 |

新版 256 主机滚轮最大帧间隔仍有 58.4ms，32 主机为 91.4ms，并不声称完全消除掉帧。`returningFiles` 仍可能约 25，因为它统计的是保留运动状态，已经不等于 25 个完整模型。新版跨主机跳转 p95 为 8.4ms，结束后归位副本释放，悬停压测没有创建 SSH 会话。

这是单机前后测量，主页布局和选档路径也随本轮改变；不能将全部收益归于某个 GPU 通道，更不是其他硬件或高 DPI 下的帧率保证。基线 32 主机静止阶段包含预热长任务，故不将其用于静止性能结论。未测 GPU 各 pass 的独立耗时。

## 回归结果

| 检查 | 结果与范围 |
| --- | --- |
| [总览与会话浏览器回归](ssh-overview/browser.json) | 53 项通过。亮／暗 1920×1080 DPR1、2560×1440 DPR1.5、1280×800 DPR1.25；编辑失败重试、保存状态、导入后清空、八个会话、真实鼠标点击设置与关闭、连续键盘标签切换、最近会话、传输确认、最后收盒及重载零连接。无页面错误。 |
| [DPI 与鼠标](ssh-overview/geometry.json) | 63 项通过。1366×768 至 3440×1440，DPR 1 / 1.25 / 1.5 / 2；SGR 鼠标行列、英文与中文精确拖选、页签命中、55 CSS px 侧栏拖动、模态优先级。 |
| [原生凭据链路](ssh-overview/native-credentials.json) | 系统 OpenSSH 与真实 SFTP 测试对端，真实 Electron / safeStorage / 沙箱 preload / IPC / ConPTY。包括保存密码、加密私钥、文件引用、中文长路径、两种 UTF-8 截断边界、错误密码只尝试一次及人工更新。 |
| [Electron 阶段一](ssh-overview/credentials-phase-1.json)／[阶段二](ssh-overview/credentials-phase-2.json) | 7 + 5 项通过，两个独立 Electron 进程。冷重启复用密码与私钥口令，主终端和 SFTP／监控不重复询问；共享密钥最后退出清理；删除密码后恢复询问；渲染元信息与应用 JSON 无明文秘密。 |
| [完整原生 SSH / SFTP](ssh-overview/native-services.json) | 16 项通过。嵌套 Unicode／二进制传输、采集器上传校验、冲突／重命名／创建目录／符号链接安全删除、等待任务取消、私钥、OTP、ProxyJump、服务取消、断线、worker 崩溃和变化的主机密钥拒绝。 |
| [原生双会话](ssh-overview/native-multisession.json) | 5 项通过，独立 ConPTY／系统 OpenSSH／SFTP、输入尺寸和并发辅助流。 |
| [Electron 多会话](ssh-overview/desktop-multisession.json) | 9 项通过。真实宿主／preload／IPC／ConPTY，独立 ID、事件与记录，迟到 resize／认证、重载清理；此报告的 SSH 对端为模拟进程。 |
| 凭据、服务与生命周期单元检查 | 凭据 14 项、服务 7 项、多会话 8 项通过。主机配置、PTY 退出竞态、客户端、事件、审计、主机、握手、流量、主机列、档案可见性与基线检查通过。Go 检查通过。 |
| 构建与[产物隔离](ssh-overview/build-isolation.json) | desktop、web、wallpaper 均通过。网页／壁纸没有总览、SSH 会话／操作 UI、xterm、凭据 IPC、终端模型或原生程序；桌面保留相应 UI 与终端资产。 |

浏览器使用实际构建产物、DOM、xterm 和 Three.js；网络与监控帧来自明确标记的测试数据。DPI 为 Chromium 仿真，不等于多台物理显示器实测。本轮未重连此前真实 Linux／Tesla P100 主机；已有采集器实机证据见 [SSH 工作区验证](SSH-WORKSPACE.md)，本轮不增加真实 GPU 采集的验收结论。

个别原生测试仍有 node-pty 独立清理进程的 `AttachConsole failed`，主进程检查通过；与原先退出后 resize 的主进程异常不同，不声称修复该上游诊断。Three.js / ANGLE 的既有精度警告和构建体积提示保留。曾出现 Rollup 内部 `Symbol(Entities)` 错误，同一源码顺序重跑三种构建通过，没有修改依赖来绕过检查。

## 画面与复现

已查看 [浅色总览](ssh-overview/overview-light.png)、[暗色总览](ssh-overview/overview-dark.png)、[八个运行会话](ssh-overview/session-tabs.png)、[操作态设置](ssh-overview/operating-settings.png)、[密钥库](ssh-overview/key-library.png)、[已保存凭据](ssh-overview/saved-credential.png) 和 [最后会话收盒中间态](ssh-overview/final-reassembly.png)。截图仅含隔离测试主机与模拟指标，未复制真实配置、私钥或授权字体资源。

先运行 `npm run build:desktop`。新增复现入口为 `check:ssh-overview`、`check:ssh-overview-performance`、`check:ssh-credentials`、`check:ssh-credentials-native`；其余继续使用原有 `check:ssh-services`、`check:ssh-multisession-native`、`smoke:desktop:multisession` 和 `check:ssh-terminal-geometry`。浏览器／Electron 图形检查顺序执行，运行数据默认放在 `.tools/`。
