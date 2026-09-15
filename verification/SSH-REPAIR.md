# 桌面 SSH 修复验证 · 2026-09-12

用户要求修复 WorkBuddy 未完成的桌面 SSH。保留已有 Electron / 系统 OpenSSH / ConPTY 实现，完成以下缺陷修复与收尾；最初的问题和复现见 [WORKBUDDY-REVIEW](WORKBUDDY-REVIEW.md)。

## 修复结果

| 问题 | 修复及证据 |
| --- | --- |
| 终端隐藏时漏输出、快速重开重复订阅 | 每个面板保持唯一输出订阅；隐藏仅释放可见性资源，新会话重建 xterm。快速切换后标记接收 2 次、显示 2 次，隐藏期间输出保留。 |
| 空口令关闭提示、相同密码问题无法重试 | 每次认证请求由主进程分配独立编号；空值保留输入，过期及重复回答被拒绝，原生提交后清除请求。真实输入事件检查仍覆盖焦点、字符累计和节点不重建。 |
| 远端普通文字伪造失败和口令提示 | 已认证后的 PTY 文字只作为终端输出；认证前的失败文字仅用于解释真实非零退出。测试输出 `Host key verification failed.` 和伪造密码提示后仍保持 interactive。 |
| 历史面板导出当前会话 | 导出使用面板正在显示的记录；当前为 retry-passhost 时，历史导出的目标为 labnode。无当前会话时也可导出历史记录。 |
| 结束时长和字节数错误 | 退出时冻结记录时钟并接收主进程最终计数；按 UTF-8 字节统计 PTY 文本，排除 SSH 协议及转发流量。 |
| `Host alpha beta` 只填充最后一个别名 | 两个别名共享块内展示信息；实际连接仍由 OpenSSH 解析配置语义。 |
| 附加参数可替换目标 | 按选项及参数个数校验，拒绝裸位置参数、缺值及危险配置项；执行目标仍为界面选择的主机。 |
| 面板打断后焦点或 inert 错乱 | 四类 SSH 面板共用模态栈，退出完成前隔离背景输入，重开延续 scope，最后恢复有效焦点。 |
| 会话启动竞态 | 拒绝并行启动，排队处理启动响应前的 IPC 事件；立即退出与启动失败不会留下错误记录元数据。 |
| 长记录越界、终端字符间距过大 | 限定弹窗网格高度，正文独立滚动、按钮保留；终端使用等宽字形，外围界面继续 MiSans。 |

## 桌面边界与记录管理

- Electron 保持 sandbox / contextIsolation，禁用 Node integration。命名 IPC 校验窗口、主框架与应用来源；阻止页面跳到其他来源，外部链接仅支持 HTTP(S) 和本地构建内的 PDF 许可。
- desktop 构建注入 CSP，脚本限定本地来源，不允许 eval 或内联脚本；既有 DOM 动画所需的内联样式继续允许。开发模式额外允许本地 Vite WebSocket。
- 记录在 `userData/ssh-logs/`，自动保留 30 天、最多 200 个会话、64 MiB。启动、保存后及主机列表手动清理共用策略，活动会话豁免；旧 JSON/log 成对处理，仅操作目录内普通文件，不递归或跟随链接。清理失败不阻断启动。
- 正常导出由原生保存对话框选择路径；测试用固定路径仅在 smoke 模式允许，且限定 `dist-desktop/`。
- SSH 模块使用构建模式隔离，网页和 wallpaper 产物不包含终端及 SSH 分块；桌面输出独立为 `dist-desktop/`。

## 验证

本机 Windows、Electron 44.3.0、Node 24.20.0；真实 Electron / preload / IPC / ConPTY，服务器使用仓库 fake SSH，独立临时用户目录及 SSH 配置。

| 检查 | 结果 |
| --- | --- |
| `npm run smoke:desktop` | 15/15；覆盖实际 Ctrl+Shift+S 入口、已完成过渡的可见主机列表、加载与 PWA 隔离 |
| `npm run dev:desktop -- --smoke` | 15/15；Vite desktop 模式、开发入口和 CSP 下正常加载 |
| `npm run smoke:desktop:session` | 85/85，无跳过；包含原有握手、解密、终端、记录、按键输入及新增生命周期/布局回归 |
| 七组 `check:ssh*` | 事件、原生会话、握手、流量、审计、客户端、主机参数与保留策略全部通过 |
| TypeScript / `npm run build:desktop` | 通过 |
| `npm run check:content` | 18/18 |
| `npm run check:viewport` | 通过 |
| `npm run build` | 通过；PWA 818 项、约 33.8 MiB，无 SSH 分块 |
| wallpaper Vite 构建 | 通过，输出到独立 `release/wallpaper-ssh-check`，无 SSH 分块；未覆盖正在使用的壁纸包 |

截图复核包括主机列表、密码提示、终端和长记录，正常内容区 1584×861，小窗口内容区 1008×601。修复前记录面板下边缘分别越界至约 1459px / 1830px；修复后为约 835px / 569px，正文可滚动至最后一节。

- [主机列表及清理入口](ssh-repair/hosts.png)
- [密码提示](ssh-repair/password.png)
- [等宽终端](ssh-repair/terminal.png)
- [长记录](ssh-repair/audit.png) · [小窗口长记录](ssh-repair/audit-small.png)
- [测试摘要及布局数值](ssh-repair/results.json)

透明 smoke 窗口可能把首次动画帧延迟到截图请求；截图工具先请求一帧，再等待真实过渡完成，避免把 opacity=0 的中间帧误当最终界面。

## 验证边界

本轮没有连接真实 SSH 服务器，也没有重做 iPhone / Safari 或 Wallpaper Engine 运行时验收。截图检查不能替代完整鼠标、触摸手感和用户试听。转发可视化、完整 SSH 音效映射、多会话与 SFTP 仍未实现。

保留的工具输出：部分 fake SSH 强制终止时，node-pty 的控制台辅助进程打印 `AttachConsole failed`，会话与检查仍正常结束、退出码为 0；三维渲染偶有既有 X4122 精度警告。没有关闭 Electron 沙箱来回避这些输出。构建仍提示主包超过 500 KiB，未在本次修复中调整整个项目的分块策略。
