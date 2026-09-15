# Rhine Lab UI

这是一个基于原项目构建的 Rhine Lab 交互式界面与桌面 SSH 工作区。

原项目仓库：<https://github.com/LBEILC/RhineLabUI.git>

本仓库保留原项目的视觉方向和三维档案交互，并在其基础上加入桌面端工作区、SSH 终端、移动端入口、主题适配和展开式便携构建。仓库中不包含真实主机配置、密码、私钥、访问令牌或本机字体授权包；测试中的密码、主机和密钥均为 fixture。

## 主要改动

- `src/main.ts`：桌面/Android 构建入口、SSH 工作区接入、主机列表、终端入口、主题和启动流程。
- `src/style.css`、`src/theme.css`、`src/startup.css`：桌面窗口、SSH 卡片、暗色主题、启动页和响应式布局；暗色启动页按钮使用可读的前景色和边线。
- `src/ssh/`：SSH 主机档案、认证提示、终端、会话、历史、传输、端口转发、设置和 Android 工作区界面。
- `electron/main.cjs`、`electron/preload.cjs`：沙箱化 Electron 主进程、CSP、来源校验、IPC、ConPTY、系统 SSH 和本地会话记录。
- `electron/*.cjs`：SSH 参数、凭据保险库、主机档案、会话生命周期、日志和服务桥接实现。
- `services/ssh/`：Windows/Android 使用的原生 SSH 服务和认证桥接；仅使用运行时生成的随机令牌。
- `scripts/fixtures/`、`scripts/check-*.mjs`：匿名的假 SSH 服务、单元检查和桌面/Android 回归检查，不连接真实主机。
- `electron-builder.yml`、`electron/assets/`、`scripts/build-app-icon.mjs`：桌面打包配置和应用图标。
- `docs/`、`verification/`：构建、桌面 SSH、移动端和回归验证说明。
- `content/archives.json`、`content/README.md`：档案正文和内容维护规则。

## 环境要求

- Node.js 22 或更新版本
- npm
- Windows 桌面构建需要 Electron 依赖和系统 `ssh.exe`
- Android 构建需要 Android Studio、SDK 和 Capacitor 环境

首次安装依赖：

```bash
npm ci
```

## 开发和构建

网页开发：

```bash
npm run dev
```

网页生产构建：

```bash
npm run build
```

桌面开发：

```bash
npm run dev:desktop
```

桌面展开目录构建（推荐用于便携运行）：

```bash
npm run dist:dir
```

输出目录为 `release/desktop/win-unpacked/`。直接运行其中的 `Rhine Lab.exe`，不会产生单文件 Portable 每次启动时的重复解压。

桌面安装包和单文件 Portable：

```bash
npm run dist
```

如果需要发布展开式便携包，把 `release/desktop/win-unpacked/` 的内容压缩成 ZIP。解压后双击根目录的 `Rhine Lab.exe` 即可。

Android：

```bash
npm run android:build
```

当前 Android APK 位于 [`release/android/`](release/android/)，安装和更新注意事项见其中的 README；完整 Android 构建说明见 [`docs/ANDROID.md`](docs/ANDROID.md)。

## 自定义位置

- 档案名称、分类和正文：编辑 `content/archives.json`，然后运行 `npm run export:archives`。
- 颜色、字体、按钮和布局：编辑 `src/style.css`、`src/theme.css`、`src/responsive.css` 及对应的 `src/ssh/*.css`。
- 启动动画轨迹：编辑 `src/boot-motion.ts`、`src/boot-tracks.ts`、`src/boot-orbit-tracks.ts` 和 `src/boot-logo-tracks.ts`。
- 三维档案和终端模型：编辑 `art/` 中的 Blender 源文件/脚本，再按项目文档重新导出资源。
- Electron 窗口、IPC 和安全策略：编辑 `electron/main.cjs`、`electron/preload.cjs`。
- SSH 参数和会话行为：编辑 `electron/ssh-args.cjs`、`electron/session.cjs`、`electron/session-registry.cjs` 以及 `src/ssh/`。
- 桌面打包名称、图标和输出目录：编辑 `electron-builder.yml`。

修改 Electron 主进程或预加载脚本后，需要重新启动桌面应用；仅修改 `src/` 时可使用 Vite 开发服务器热更新。

## 验证

常用检查：

```bash
npm run check:content
npm run check:ssh
npm run check:ssh-session
npm run check:ssh-terminal-deck
npm run build:desktop
```

桌面检查使用匿名 fixture，不代表已经连接或验收真实 SSH 服务器。真实主机、密码、私钥和会话日志只保存在本机用户数据目录，不应提交到 Git。

## 许可和资源

源代码沿用原项目许可；第三方字体、Three.js、CodeMirror、xterm 和其他依赖遵循各自许可证。正式字体授权包位于本机的忽略目录，不随仓库分发。三维源文件和参考素材的再制作范围请参阅 `DESIGN.md` 及 `docs/`。
