# 桌面版打包

把桌面应用做成可分发的 Windows 安装包与免安装版。

```sh
npm run dist          # 安装包 + 免安装版
npm run dist:dir      # 只产出未打包的目录，用来先检查内容
```

`dist` 会先跑 `build:desktop`（内含 `prebuild:desktop`，即校验 Electron 运行时与 SSH 服务二进制），再调 electron-builder。顺序不能省：electron-builder 只搬运磁盘上已有的东西，不会替你构建渲染层。

产物落在 `release/desktop/`：

| 文件 | 说明 |
| --- | --- |
| `RhineLab-Setup-1.0.0.exe` | NSIS 安装包，约 146 MB。可选安装目录、创建桌面与开始菜单快捷方式、带卸载程序 |
| `RhineLab-Portable-1.0.0.exe` | 免安装单文件，约 146 MB。运行后自解压到临时目录 |
| `win-unpacked/` | 未打包目录，2,054 个文件 / 450 MB，调试用 |

`release/` 已在 `.gitignore` 中；`release/wallpaper` 是 Wallpaper Engine 的构建输出，所以桌面产物单独放在 `release/desktop`，两者不混。

## 为什么不用 asar

`asar: false` 是有意的，不是图省事：

- **SSH 桥是子进程可执行文件**，asar 里的二进制无法被 spawn。它不是可选项——`node-pty`、`OpenConsole.exe` 与 `rhine-bridge-windows-amd64.exe` 都要真实存在于磁盘上。
- **主进程的每一条路径都以 `__dirname` 为锚点**（渲染层、图标、preload、probe、桥），全仓库没有一处使用 `process.resourcesPath`。打包后 `__dirname` 变成 `resources/app/electron`，只有文件是真实文件时这些相对路径才继续成立。

开启 asar 就需要把上述每一处改成「打包时走 `app.asar.unpacked`」，改动面覆盖 `main.cjs` 与 `ssh-services.cjs`，且任何漏改都只会在装好之后才暴露。关掉 asar 则与开发时完全一致。

代价是文件数变多（2,054 个）。渲染层与 Electron 运行时本来就占绝大部分体积，实测安装包 146 MB，与开 asar 的差别在个位数百分比。

## 为什么关掉 npmRebuild

electron-builder 默认会为 Electron 重建原生依赖，`node-pty` 因此走 node-gyp，而本机没有 Python，构建会停在 `Could not find any Python installation to use`。

`node-pty` 的产物是 N-API 扩展（`node-addon-api`），`prebuilds/win32-x64/` 下的 `pty.node`、`conpty.node`、`conpty_console_list.node` 本来就能在 Electron 下直接加载——开发时跑的正是这些，会话一直是通的。所以 `npmRebuild: false`，重建没有收益。

## 必须随包分发的内容

| 路径 | 为什么要 |
| --- | --- |
| `dist-desktop/` | 渲染层。主进程按 `<root>/dist-desktop/index.html` 加载，必须与 `electron/` 保持同级 |
| `electron/**` | `main.cjs` 与 14 个同级 `.cjs` 模块、`preload.cjs`、`assets/app-icon.ico` |
| `electron/resources/ssh-services/` | `manifest.json` + Windows 桥 + **两个 Linux 采集器**。桥本身不上传自己：它读 `manifest.json`，把 `monitor/linux/<arch>` 上传到远端主机做监控，所以这两个二进制虽从不在 Windows 上执行，也必须随包 |
| `node_modules/` | 仅生产依赖；electron-builder 自动裁掉 devDependencies |

开发面被排除：`electron/probes/**`（smoke 的渲染层探针）、`electron/fixtures/**`、`electron/ssh-config/**`、`electron/dev.cjs`、`electron/ensure.cjs`。

**不打包、由目标机器提供**：系统 OpenSSH 客户端（`C:\Windows\System32\OpenSSH\ssh.exe` 或 PATH 上的 `ssh`）。缺失时连不上主机，但应用本身照常运行。

## 身份信息

`appId: com.rhinelab.analysis-os` 与主进程 `app.setAppUserModelId()` 用的是同一个字符串。**两者必须一致**：否则钉在任务栏的快捷方式与运行中的窗口会被 Windows 当成两个应用，出现两个按钮。

安装包与免安装版都带应用图标，exe 元数据取自 `package.json`：

```
ProductName  : Rhine Lab
FileVersion  : 1.0.0
CompanyName  : LBEILC
Description  : 《明日方舟》特别映像「莱茵生命：访问」终端界面的非官方复刻，含桌面 SSH 工作区。
```

安装包的安装/卸载/页眉图标显式指向 `electron/assets/app-icon.ico`，不另存一份到 `build/`。

## 验证记录（2026-09-14）

| 项 | 结果 |
| --- | --- |
| `npm run dist` | 通过。产出 145.7 MB 安装包与 145.5 MB 免安装版 |
| 免安装版实际运行 | 通过。`RhineLab-Portable-1.0.0.exe` 自解压后启动 `Rhine Lab` 进程，窗口标题 `RHINE LAB · ANALYSIS OS`，`Responding = True`；`PrintWindow` 抓到的画面是开场的 RHINE LAB 品牌页，不是白屏 |
| 打包产物的 smoke | 通过。把 `electron/probes` 临时放回包内后运行 `Rhine Lab.exe --smoke`：除既有的 `host list opens from its keyboard shortcut` 外全通过，`problems` 为空，3D 场景在线（`canvases: 1`）。与开发运行时的结果逐项相同 |
| 桥能从打包位置启动 | 通过。直接运行 `resources/app/electron/resources/ssh-services/rhine-bridge-windows-amd64.exe` 并写入一行 JSON，进程退出码 0 并回出 `{"id":"","ok":false,"error":"invalid request"}`——它确实起得来、能解析、能应答 |
| exe 与安装包图标 | 通过。`Rhine Lab.exe`、`RhineLab-Setup-1.0.0.exe`、`RhineLab-Portable-1.0.0.exe` 三者解出的图标都是 Rhine Lab 标记，不是 Electron 默认 |

## 尚未验证

- **安装包本体没有实际安装过。** 装到用户机器上会写入 `%LOCALAPPDATA%\Programs\Rhine Lab`、注册卸载项并创建快捷方式，属于会改动系统的操作，没有在未获确认时执行。已验证的是它携带正确的负载、图标与元数据，以及同一份负载在免安装版里能正常启动。
- **SSH 会话链路没有在打包产物里跑通。** 本机这个 shell 里 ConPTY 起不来（`AttachConsole failed`），开发构建与非打包产物同样如此，已用 482a471 的 worktree 对照确认是环境限制。桥可实现被 spawn 已单独验证。
- **标题栏在开机动画期间有约 5/255 的色差。** 覆盖层按 `#E8E5E1` 绘制（实测命中该值），而开场页背景在该角落是 `#E3E0DB`，因此窗口按钮后面会有一小块略亮的矩形。档案与详情页的背景正是 `#E8E5E1`，完全融合。两个可选的收口方式：把覆盖层改成折中的 `#E5E3DE`，或把开场渐变的外圈色标由 `#e4dfdb` 改为 `#e8e5e1`（后者会动到已校准的开场画面）。开机动画是每次启动第一眼看到的东西，因此这一条留给用户定夺。
