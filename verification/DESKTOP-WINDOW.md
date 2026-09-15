# 桌面窗口外形与应用图标

日期：2026-09-14。范围为 Electron desktop 外壳（`electron/`），不改渲染层布局。

## 问题

窗口用的是默认外框：Windows 自己画的标题栏是系统浅色，跟应用的骨白／石墨配色无关；任务栏和 Alt+Tab 显示的是 Electron 的默认图标（`BrowserWindow` 既没有 `icon`，仓库里也没有任何 `.ico`）。窗口本身是这套界面里唯一没有被设计过的一块。

## 窗口外形

Windows 的标题栏由系统绘制，唯一能改掉它的办法是**去掉标题栏**，再用 Electron 放回去的 overlay 上色：

```js
titleBarStyle: "hidden",
titleBarOverlay: { color: "#e8e5e1", symbolColor: "#202d32", height: 40 },
```

两个颜色就是 `#stage` 自己的底色和 `--theme-ink`，所以标题栏读起来是页面的一部分而不是套在外面的一圈框。取值只对 `win32` 生效，其它平台保留各自的原生外框。

去掉标题栏会把「拖动窗口」一起带走，所以渲染层补了一条 **`.titlebar-drag`**：`#stage` 的子元素，`-webkit-app-region: drag`，高度 `calc(40px / var(--stage-scale, 1))`——`#stage` 是缩放的 1920×1080 面，要拿到真实的 40 窗口像素就得除掉缩放比，和 `wallpaper-effects.ts` 的 `--ui-*` 是同一个写法。这条带子只盖住品牌字标（top 114）与系统导航（top 124）之上那条空带；窗口在网页构建里不生成它。

它顺带解决了两件事：`openModal` 会把 `#stage` 的子元素全部置为 inert，`SurfaceScope` 也会（口令、记录、终端），所以带子在任何一个界面需要点击时自动让开。双击标题栏最大化、最大化按钮的贴靠布局都由 overlay 的原生按钮保留。

主题跟随：标题栏由系统绘制，读不到 CSS 变量，所以渲染层在 `savePrefs()` 里通过 `shell:theme` 报回当前主题，主进程只接受 `light` / `dark` 两个名字（不接受颜色），再调 `setTitleBarOverlay`。

## 应用图标

`npm run build:app-icon` 生成 `electron/assets/app-icon.ico`，7 个尺寸（16 / 24 / 32 / 48 / 64 / 128 / 256），每个条目是 PNG，Vista 以后直接支持。产物入库，`BrowserWindow({ icon })` 直接读它。

图形沿用 `src/brand.ts` 的同一个标记，构图与 `scripts/build-icons.mjs` 导出的主屏图标一致——不另造标识。区别只有一处：标记是 2.1:1 的宽扁形，按宽度塞进正方形会在上下留出大片底色，128 及以上这样正好（和主屏图标一致），16–48 就会让 26 单位的笔画落到两个像素以下、`+` / `−` 直接糊掉。所以小尺寸按更满的填充率绘制，**画的内容没变，只是画得更大**。

`scripts/build-icons.mjs` 依赖 `sharp`，而本仓库并不依赖它（那个脚本靠外部 `SHARP_MODULE`）。这个脚本改用仓库里本来就有的 Chromium——check 脚本驱动的同一个 headless Edge——逐尺寸原生渲染，而不是把大图缩小，细线标记正需要这样。另外 Win32 下设了 `app.setAppUserModelId`：未打包的 Electron 没有 AUMID，任务栏按钮会归到 Electron 自己名下并用它的图标，`BrowserWindow({ icon })` 也就到不了任务栏。

## 验证

`npm run smoke:desktop` 15/15 之外新增三项（截图见不了标题栏，所以只能在主进程侧断言）：

| 断言 | 依据 |
| --- | --- |
| `window caption follows the application palette` | 主进程记录每次真正应用的 overlay 取值。Electron 有 `setTitleBarOverlay` 但**没有** getter（已实测：44.3.0 上 `typeof win.getTitleBarOverlay === "undefined"`），不记录就无从区分「改成功了」和「悄悄没改」。断言主题名、`color`、`symbolColor`、`height` 与上报主题一致且无异常 |
| `the renderer reports its theme to the window` | `window.rhineDesktop.theme` 存在 |
| `the frameless window has a drag region the caption's height` | `.titlebar-drag` 计算样式为 `drag`，实测高度 40（±1） |

实际取值随 `SMOKE_JSON.chrome` 一起输出：

```json
{ "frameless": true,
  "applied": { "theme": "light", "color": "#e8e5e1", "symbolColor": "#202d32", "height": 40, "error": null },
  "content": [1600, 900], "window": [1600, 900] }
```

`content` 与 `window` 相等即没有原生标题栏占用；改前分别是 `[1584, 861]` 与 `[1600, 900]`（39px 标题栏 + 边框）。

主题切换实测（临时步骤，驱动应用自己的 `[data-color-theme]` 委托监听，观察后已移除）：点击前 `{theme:"light", color:"#e8e5e1"}`，点击后 `{theme:"dark", color:"#131e26", symbolColor:"#e2e9e7"}`，两次 `error` 均为 `null`。

窗口外框本身用 `scripts/capture-desktop-window.ps1` 抓取整窗——`capturePage()` 只有网页内容，抓不到系统绘制的标题栏。该脚本用 `PrintWindow`（`PW_RENDERFULLCONTENT`）让 DWM 渲染窗口本身，因此不抬升窗口、不读屏，也碰不到用户当时的前台窗口（第一次用的 `CopyFromScreen` 正是抓到了用户的前台窗口，已弃用）。它默认跑一个临时 profile，以免入库的截图带上用户自己保存的主机：

- [窗口整体：无原生标题栏，左上为页面底色，右上为应用墨色的 − □ ✕](desktop-window/window-light.png)

图标各尺寸由 `.ico` 中直接解出：[256](desktop-window/icon-256.png)、[128](desktop-window/icon-128.png)、[64](desktop-window/icon-64.png)、[48](desktop-window/icon-48.png)、[32](desktop-window/icon-32.png)、[24](desktop-window/icon-24.png)、[16](desktop-window/icon-16.png)。另核对了 ICO 结构：7 个条目、偏移与长度均在文件内、每段以 PNG 签名开头。

`npm run smoke:desktop:terminal` 8/8 通过。视口高度因标题栏消失而增加 39px，SSH 终端的 DOM 投影按新视口重新计算后正常。

## 未能验证的部分

深色标题栏**像素**没有核对：要看到它需要让应用以深色主题启动并抓到真实窗口，而抓屏会覆盖用户当前的前台窗口（第一次尝试如此，已放弃）。已验证的是同一段代码路径在深色下把 `#131e26` / `#e2e9e7` 交给了系统且未报错，浅色的像素结果与此一致。

`npm run smoke:desktop:session` 在本机 18/71 失败，失败项与本次改动无关：node-pty 的 `conpty_console_list_agent.js` 抛 `AttachConsole failed`——这个 shell 里 ConPTY 起不来。已用 482a471 的 worktree 跑同一命令对照，**失败项名称与数量完全一致（18/71）**。`npm run smoke:desktop` 与 `smoke:desktop:terminal` 的 `host list opens from its keyboard shortcut` 一项在基线上同样失败，属既有遗留（总览提交 482a471 只更新了 `--multi` 路径），非本轮引入。
