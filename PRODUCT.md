# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- 作者本人：日常把它当 SSH 工作区用（主机档案、终端、文件与传输），同时作为桌面与壁纸。
- 《明日方舟》爱好者：通过网页、Wallpaper Engine 创意工坊和安卓包看档案与三维场景，还原度和观感优先。

## Product Purpose

《明日方舟》特别映像「莱茵生命：访问」终端界面的非官方复刻，并在这套界面里做了一个真实可用的桌面 SSH 工作区。Web、Electron 桌面、Android 与 Wallpaper Engine 共用同一份前端。

## Positioning

工具藏在作品里：主机就是档案阵列里的一张档案，连接、认证、传输都用档案系统的语言呈现。它既是可以每天用的 SSH 客户端，也是一件可以只看不用的复刻作品。

## Operating Context

- 桌面窗口无原生标题栏，整个舞台按 1920×1080 缩放；窄屏和竖屏改用真实像素布局。
- 手机横屏、竖屏与触摸手势都有独立适配；安卓端通过 Capacitor 打包。
- 壁纸版运行在 Wallpaper Engine 里，页面隐藏时停止三维绘制。
- Unreal 原生实现在独立仓库，颜色与主题数值两边各存一份。

## Capabilities and Constraints

- 三维档案阵列、档案详情与解密动画、检索、收藏、设置。
- SSH：主机档案与分组、快捷档案、命令片段、目录收藏、历史、密钥库、终端、文件、传输、隧道、监控、审计。
- 十套主题（纸档、夜间、警戒、隔离、遥测、印刷、线路、石板、标签、冷库），各有自己的切换动画。
- 两种版式：标签系统与经典。
- 网页版的 SSH 是演示入口，真实连接在桌面与安卓端。

## Brand Commitments

- **还原原片终端观感是硬约束。** 布局、字体（MiSans）、暖纸配色、开场动画按原片来，不以常规网页规范为准。设计评审不得把这些当作问题。
- 品牌标志与「RHINE LAB · ANALYSIS OS」字标沿用原版排版。
- 非官方复刻；第三方字体与资源按各自许可分发。

## Evidence on Hand

- 视觉与行为基准：`docs/design/visual-baseline.md`
- SSH 设计记录：`docs/design/ssh-workflow.md`
- 主题定义：`src/features/theme/theme-design.ts`
- 没有用户评价、使用数据或对外宣传文案，后续工作不得编造。

## Product Principles

1. 先是原片，再是网页：与原片冲突时，原片优先。
2. 工具必须真的好用：SSH 相关界面的可读性和操作效率不为观感让步。
3. 一套语言贯穿所有平台：桌面、手机、壁纸看到的是同一个系统。
4. 每个主题都是完整的一套，不是换色。
