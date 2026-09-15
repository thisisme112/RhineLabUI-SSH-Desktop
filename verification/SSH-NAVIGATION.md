# SSH 总览、模型读取与终端返回

2026-09-14，根据用户对后续修改的反馈修复桌面导航。沿用原生 DOM / Three.js 与既有模型。

## 原因与行为

此前总览虽可收起，桌面 CSS 仍无条件隐藏 `#archive-ui` 和系统导航，选档说明与按钮随之消失；三维单击只调用选档，没有打开事件；终端收起回调直接切到全局总览，跳过当前主机详情。

- 总览的展开状态同时管理档案界面的显示和输入。收起玻璃面板设为 `inert`，边缘标签接回焦点；展开后边缘标签退出键盘导航。面板收起与整个总览的淡入淡出各自使用独立的动画属性。
- 桌面增加模型打开回调。首次点其他模型选中，点击已选中模型进入详情；在详情点击有会话的模型重新打开终端。
- 手动抽出只从所选模型开始，按相机的竖直投影将指针距离转换为高度。保留悬停时的实际高度、物理横向／纵深位置和原镜头；超过四成松手后接续原抽取动画。短拉、反向放回、失焦与触摸取消均不提交打开。
- 非抽出拖动继续使用现有两轨反解、自由转向和实际松手速度。普通网页、壁纸未绑定新的打开回调。
- 终端返回当前主机，保留连接、同一缓冲、页签和正文节点；相机回到详情后恢复操作按钮焦点。快速重开接续当前收盒进度。退出回调检查页面与选档是否已改变，避免覆盖后续导航；最后会话移除仍进入全局总览。
- 总览每行新增“详情”；阵列对已有会话提供终端按钮。修正五列主机在详情页序号可能显示 `-1` 的问题。

## 复现与检查

```powershell
npm run build:desktop
node --experimental-strip-types --test scripts/check-archive-pull.mjs
node --experimental-strip-types scripts/check-archive-drag.mjs
node scripts/check-terminal-deck.mjs --navigation --out .tools/ssh-navigation-review
node scripts/check-terminal-deck.mjs --multi --out .tools/ssh-navigation-multisession
npm run smoke:desktop:terminal
npm run build
npm run dist
```

浏览器检查使用真实 DOM、Three.js、xterm、鼠标和触摸事件；SSH 传输由仓库的 `ssh-multi-bridge.js` 测试替身提供，不代表真实服务器认证或实机触摸验收。检查包含 1920×1080 / DPR 1、1366×768 / DPR 1.25、2560×1440 / DPR 1.5，以及明暗和减少动态效果。

## 验证结果

| 检查 | 结果 | 覆盖范围 |
| --- | --- | --- |
| 抽出手势 | 7 / 7 | 投影比例、抖动、反向取消、最高高度、接管归位中的模型后打开或放回。 |
| 新增导航 | 26 / 26 | 真实滚轮后点击、鼠标与触摸抽出、取消、认证返回、终端收起与外部重开、后台输出保留、途中反向与后续导航优先、三种分辨率、重载和减少动态效果；无页面错误。 |
| 总览与多会话回归 | 53 / 53 | 八个独立会话、后台认证与输出、文件与监控页、输入路由、传输中结束确认、标签关闭与最后会话收盒；无页面错误。 |
| Electron / ConPTY | 15 / 15 | 原生键盘往返、收起期间输出、重开、搜索、复制粘贴、字号、退出后缩放；无渲染器错误。SSH 对端仍为本地测试替身。 |
| 原自由拖动 | 通过 | 原 `check-archive-drag.mjs` 的投影、转向及松手速度／持续惯性检查。 |
| 构建与提交隔离 | 通过 | 桌面、网页、Windows 便携版与安装包构建成功；网页产物没有 SSH 专用模块，PWA 正常生成。仅本次暂存内容独立导出后通过 TypeScript 检查。 |

数据见 [导航报告](ssh-navigation/navigation-report.json)、[多会话报告](ssh-navigation/multisession-report.json)、[原生终端报告](ssh-navigation/desktop-terminal-smoke.json) 与 [构建记录](ssh-navigation/build-report.json)。

已目视复核 [总览收起后](ssh-navigation/02-collapsed-archive.png)、[抽出过程中](ssh-navigation/03-manual-extraction.png)、[终端返回主机](ssh-navigation/04-returned-to-host.png) 和 [1366×768 布局](ssh-navigation/05-archive-1366-light.png)。其余尺寸、暗色和减少动态效果截图保存在同目录。截图反映当前工作区使用的既有终端内胆；本次提交未包含原先的内胆改版、窗口和安卓工作。

本机输出为 `release/desktop/RhineLab-Portable-1.0.0.exe` 和 `release/desktop/RhineLab-Setup-1.0.0.exe`。打包后的渲染模块与本次验证构建逐字节一致，包内不含测试对端与烟雾检查记录；未安装、未发布、未推送。
