# SSH 六列工作区升级验证

日期：2026-09-13。仅升级桌面 SSH，沿用原生 TypeScript / DOM / WAAPI、Three.js 和已有 Blender 资产。本轮在 `main` 本地提交，不推送、不部署。

## 行为与边界

桌面阵列现在是主机、会话、文件、监控、命令、历史六列，使用 H / S / F / M / C / R 稳定编号。各列有目录卡和真实空状态，移除桌面的原资料内容；网页和 Wallpaper Engine 仍使用原五列、40 份资料。不同长度的列独立循环、独立记忆，坐标重定位使用各列偏移，不再计算不断膨胀的最小公倍数。

每个连接独立持有原生 PTY、认证请求、xterm、SFTP、传输和监控。先分配原生会话 ID，再绑定监听并启动，输入、尺寸、密码和辅助服务请求始终检查所属窗口与会话；启动取消、提前退出、重连后的迟到事件都不能串入其他连接。界面只挂载当前 xterm，隐藏的解析器仍处理输出及终端协议。普通连接返回同主机的活动会话，“新开会话”允许同主机并发。

文件收藏保存主机与目录；命令库支持编辑和明确选择 S 编号后插入，不补回车，多行片段要求远端开启 bracketed paste。库、编号及每台主机的侧栏宽度和页签使用版本 1 本地存储，未知或损坏版本保留原值。结束会话保留输出和历史，重启不自动恢复连接、传输或执行命令。

窗口关闭、渲染器崩溃和整页重载都会清理其原生会话。关闭时提示活动连接和传输；无法取得渲染器完整审计时，主进程保存实测字节、时长与退出状态，并关联原始日志，不推断缺失的握手事实。全部活动会话的日志均豁免清理。

## 连续画面、交互与声音

- 保留 2.1 秒二次加速的同步开盒／拉近、1.2 秒重组与原内胆坐标。操作中切换连接采用约 180ms 淡入，保留展开的包装。归位副本持有独立终端画面和标签，在原高度重组后下降；快返不恢复旧环形内构。
- Three.js 的 `Texture.clone()` 共享 `Texture.source`，曾使归位快照的图像覆盖当前终端，卡面停在 H-000。快照改为独立 `CanvasTexture`；截图和内容标识共同验证归位卡与当前卡互不覆盖。
- Ctrl+Tab 的 keyup 会落在新终端，曾导致旧 xterm 保留按键状态，返回后首次 IME / `insertText` 丢失。卸下终端前释放本地键盘状态，不向远端发送控制字符。
- 从会话目录结束未完成传输的连接时，先建立对应档案位置，再按正常开盒流程显示原位确认；避免确认区在下一帧被收起。默认聚焦“继续工作”，取消后归还终端输入。该路径先复现失败，再通过回归。
- 元信息至少 12px，主要文字 13–14px，保留暖灰／石墨、细线和克制配色。GPU 先总览后详情，进程默认折叠，180ms 数值滚动、固定单位。高 GPU 占用使用琥珀；错误和陈旧状态另行标记。
- 实体运动沿用玻璃音；认证、连接成功、意外断线和批量传输结果使用去重电子提示，手动断开不报故障。输入、输出和逐秒指标不触发声音。操作时音乐平滑降至设置值的 45%，收起恢复；技术检查不代表用户已认可最终听感。

三维场景被操作面覆盖且稳定后暂停绘制，窗口尺寸、主题或关闭时恢复；盒内纹理仅内容变化时上传，最多 15fps。隐藏图表不绘制、不运行陈旧计时器；隐藏终端不重复 fit，但仍继续解析协议和接收采样。原生像素终端仍处于缩放 stage 外，保留此前最大化清晰度与鼠标坐标修复。

## 回归结果

| 检查 | 结果与范围 |
| --- | --- |
| `check:ssh-multisession-unit` | 8 项通过：所属窗口、独立认证／输入／退出、八个注册会话、启动取消、原生回退记录、渲染端早到事件、存储、循环列、事件音去重与批次。 |
| [多会话浏览器报告](ssh-workspace-upgrade/multi/report.json) | 32 项通过，包括六列、认证隔离、后台 OTP 不抢焦点、独立目录与缓冲、指定命令插入、目录结束传输确认、保留历史、八个活动和两个已结束会话、冻结／缩放、归位快照、快返、重载后零连接。 |
| [原生双连接协议](ssh-workspace-upgrade/native-protocol.json) | 5 项通过。真实系统 OpenSSH、ConPTY 和 SFTP 服务器；两个原生 worker 的认证、输入、尺寸、并发文件操作与监控流独立，停止 A 不影响 B。监控采样内容为模拟。 |
| [Electron 多会话报告](ssh-workspace-upgrade/desktop-multisession-smoke.json) | 9 项通过。真实 Electron / preload / IPC / ConPTY，SSH 对端为隔离测试进程；独立 ID／日志／密码、迟到 resize／认证、窗口重载清理及历史回退。 |
| [Electron 终端报告](ssh-workspace-upgrade/desktop-terminal-smoke.json) | 15 项通过。原生键盘、搜索、隔离剪贴板、粘贴不补回车、字号、隐藏输出、重组／重开、退出后缩放及无渲染器错误。 |
| [DPI 与鼠标报告](ssh-workspace-upgrade/geometry.json) | 63 项通过。DPR 1 / 1.25 / 1.5 / 2，1366×768 至 3440×1440；SGR 单元坐标、英文和中文精确拖选／复制、真实页签命中、55 CSS px 侧栏拖动、模态优先级。 |
| [原工作区浏览器回归](ssh-workspace-upgrade/workspace.json) | 45 项通过。文件分页／虚拟化／选择／删除确认／传输冲突、监控节点与进程展开保留、陈旧状态、1024–2560 宽度、字号 12 / 16 / 24、暗色和减少动态效果。 |
| 共享档案与客户端检查 | 主机列 0 / 1 / 8 / 33 / 256 主机、20,000 次循环移动、原片 160 位置和原 40 份档案、SSH client、12 次快速 PTY 退出及立即停止通过。 |
| 构建与[产物隔离](ssh-workspace-upgrade/build-isolation.json) | desktop、web、wallpaper 构建通过；普通网页／壁纸中没有 SSH 会话／操作界面标识、终端模型和原生程序。 |

浏览器使用真实 DOM、xterm 与 Three.js，但传输帧来自明确标记的 fixture。八个活动会话各写入 600 行，保持独立缓冲且只有一个已挂载终端；这是功能与资源行为检查，不是八条真实远端连接的性能基准。报告的 `fastSwitchMs` 包含驱动等待，不作为动画耗时测量。

DPI 检查为 Chromium 视口与像素密度模拟，不等于多台物理显示器实测。几何及原工作区回归完成后仅调整了文字颜色和会话操作边界，未改变终端几何；最新多会话回归另覆盖尺寸变化。截图中的监控数值均为 fixture 数据。

## 画面附件

已检查稳定后的[终端与监控](ssh-workspace-upgrade/multi/03-session-monitor.png)、[命令编辑](ssh-workspace-upgrade/multi/04-command-editor.png)、[文件目录](ssh-workspace-upgrade/multi/05-file-library.png)、[传输结束确认](ssh-workspace-upgrade/multi/06-transfer-stop-confirmation.png)及[重载后命令库](ssh-workspace-upgrade/multi/11-restored-library.png)。监控和操作面截图等待淡入结束；[重组](ssh-workspace-upgrade/multi/09-reassembly.png)与[换选归位](ssh-workspace-upgrade/multi/10-outgoing-terminal.png)特意截取运动中间态。

## 验证限制

- 本轮没有重新连接之前的真实 Linux / 四张 Tesla P100 服务器。真实采集器与 NVIDIA 的既有证据见 [上一轮工作区验证](SSH-WORKSPACE.md#实际远端服务器)；本轮新增并发监控使用模拟帧，不能扩大该实机结论。
- Linux arm64 采集器仍只有交叉编译验证。传输队列不跨重启保存，不支持断点续传；完全阻塞的文件操作仍可能需要关闭文件通道后才能取消。
- node-pty 独立清理进程在快速结束时打印过 `AttachConsole failed`，主进程测试通过；这不是先前退出后 resize 的主进程异常，也不声称已修复该上游清理诊断。Three.js / ANGLE 有既有精度警告，构建有体积提示。
- 使用隔离主机配置、对端和剪贴板，不读取或修改用户真实剪贴板；附件不包含真实服务器凭据、主机配置或授权字体。

复现入口为 `package.json` 中的 `check:ssh-multisession-unit`、`check:ssh-multisession`、`check:ssh-multisession-native`、`smoke:desktop:multisession` 及既有终端／工作区／坐标检查。执行浏览器或 Electron 检查前先构建 desktop，图形验收按顺序执行。
