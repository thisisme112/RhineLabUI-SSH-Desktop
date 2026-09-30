# 项目结构与入口

本仓库维护 Web、Electron 桌面、Capacitor Android、Wallpaper Engine 和共享 Go SSH 服务。Unreal 已拆为独立的 RhineLab-Unreal 仓库，本机目录为 `D:\myproject\RhineLab-Unreal`。

| 目录 | 职责 |
| --- | --- |
| `src/app` | 应用装配、导航、生命周期和基础样式 |
| `src/features` | 档案、SSH、启动、主题、设置 |
| `src/platform` | Web/PWA、桌面、Android、壁纸适配 |
| `src/rendering` | Three.js 场景、画质、光照、模型和资源释放 |
| `src/shared` | 通用 UI、声音、品牌和工具 |
| `electron` | 窗口外壳、IPC、会话、凭据与原生服务；`diagnostics` 放运行验证 |
| `android` | Capacitor 工程和 Java 原生插件 |
| `services/ssh` | Go SSH/SFTP、传输、监控、隧道与本地测试服务 |
| `scripts/build`、`export`、`check`、`capture`、`lib` | 构建、导出、检查、截图、脚本公共工具 |
| `content`、`art`、`public` | 档案正文、资源制作源、运行时资源 |
| `docs/design`、`research`、`history` | 设计、研究页面、历史验证证据 |
| `.artifacts`、`.tools`、`dist*`、`release` | 本地输出、工具缓存、编译与发行产物，忽略 Git |

`src/main.ts` 是所有前端构建的薄入口。应用先装配通用界面，按平台加载 SSH 工作区。设置弹窗和 SSH 装配独立于主入口，跨模块的 getter 保持导航及会话状态实时更新。`src/platform/bridge.ts` 定义桌面和 Android 共用的原生接口，业务模块通过 `getPlatformBridge()` 读取；现有 `window.rhineDesktop` 和 SSH IPC 协议继续兼容。场景后处理装配位于 `src/rendering/scene-pipeline.ts`，模型、光照、输入运动与资源释放继续由对应模块维护。

## 开发、构建和运行

| 平台 | 开发 / 运行 | 构建 |
| --- | --- | --- |
| Web | `npm run dev:web` | `npm run build:web` |
| Electron | `npm run dev:desktop` / `npm run start:desktop` | `npm run dist:dir` |
| Android | Android Studio 打开 `android` | `npm run android:build` |
| 壁纸 | 构建后导入 Wallpaper Engine | `npm run build:wallpaper` |
| Unreal | 在独立仓库执行 `npm run start` | 独立仓库 `npm run package` |

原有 npm 命令继续可用。`启动网页.cmd` 启动网页开发，`启动终端.cmd` 与 `启动桌面终端.cmd` 启动桌面开发。Unreal 根启动脚本仅转交独立仓库的统一入口。

检查命令集中在 `scripts/check/commands.json`，npm 检查入口为 `scripts/lib/run-check.mjs`。默认输出是 `.artifacts/checks/<suite>/<UTC时间-提交号>/`，可通过 `RHINE_CHECK_RUN_ID` 关联同一次验收；显式 `--out` 仍可指定其他目录。历史截图不作为新检查的输出位置。

## Unreal 共享包

先提交源码，再执行 `npm run export:shared`，得到 `.artifacts/shared/1.0.2-shared.1/` 中的 ZIP 和锁定清单。包包含模型、可分发字体、品牌图形、动画轨道、Go 服务、协议参考及许可；测试二进制放在 `testing/`，不随产品服务目录分发。

将清单提交到 Unreal 的 `dependencies/shared.lock.json`，在 Unreal 仓库执行 `npm run shared:install -- --package <ZIP绝对路径>`。安装前检查整个 ZIP、协议、版本、源提交和每个文件的 SHA-256。升级使用独立提交，不自动追踪最新版本。不打包本地授权字体、NVIDIA 专有 SDK 或用户配置。

Web 是共享基础数据的来源；Unreal 专用材质与行为在其仓库维护。无需第三个仓库，也无需相邻目录或跨仓相对路径。
