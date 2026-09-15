# SSH 工作区与终端排版：编译和打包记录

2026-09-15。基于 `0cc2ea3` 完成本轮 SSH 工作区改进。功能、入口和适用边界见 [使用说明](../docs/SSH-WORKSPACE-SETTINGS.md)。

用户明确要求“不用测试”：本轮仅进行源码检查、TypeScript 类型检查、原生编译、构建和安装包文件检查。没有启动应用测试，没有安装 APK、接管手机或执行真实主机操作；此前的实机结果不作为本轮新增功能的验收结果。

## 变更范围

- 终端使用随包 JetBrains Mono／IBM Plex Mono 或系统等宽字体，移除 MiSans 比例字体。电脑默认 13px、安卓 11px；字号 8–32px、字距 −1～3px、行距 1～2 倍可调整。保留旧的手动字号，所有会话和盒内预览共用设置。
- 项目档案、绝对目录与命名 tmux、电脑双终端／手机标签、分组置顶排序、静态未读／传输状态、统一检索、参数化命令和独立开盒动画偏好。
- 自动重连与持续监控提醒；安卓可选前台连接服务、通知操作和最多三层跳板机。
- SFTP UTF-8 文本编辑、高亮、差异对照、版本冲突检查与草稿；本机回环端口转发与显式关闭。
- 电脑／安卓 JSON 配置迁移与可选加密凭据备份，导入前预览、不自动连接或信任新主机。

## 已完成的编译

| 项目 | 结果 |
| --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit` | 通过 |
| Electron main、preload、SSH services、migration 的 `node --check` | 通过 |
| `npm run build:ssh-services` | Go 1.27.1 编译通过；Windows amd64 桥接、Linux amd64／arm64 监控、Android arm64／armv7／amd64 会话程序 |
| `npm run build:desktop` | TypeScript、Vite desktop renderer 构建通过 |
| Android Vite renderer + `cap sync android` | 通过；最终 APK 使用最后一次成功构建的 renderer |
| Android 原生资源打包 + `node scripts/android-build.mjs` | Java／Gradle `assembleDebug` 通过，136 个任务，最终构建 `BUILD SUCCESSFUL` |
| electron-builder Windows NSIS + portable | 两种产物均成功生成；`--publish never`，未推送或发布 |

Android renderer 构建曾出现一次 Rollup 内部错误 `Cannot define property Symbol(Entities), object is not extensible`；未改源码、单独重跑后成功。使用 Node 24.20.0、Vite 7.3.6，未因该错误更改工具链。

Windows 包使用当前工作区已有的打包配置，输出到新的 `release/ssh-workspace-20260915/` 目录。未终止用户正在运行的旧便携版，未覆盖旧 EXE。原有窗口、图标和打包配置的未提交改动保持原状，不混入本次 SSH 提交；因此本地安装包还包含这些已存在的工作区改动。

## 安装包文件检查

静态读取解包目录、APK ZIP、DEX 和编译后的 manifest，未运行产物：

- Windows 和 Android 均包含两种等宽字体的 Latin 400／700 WOFF2、终端排版、编辑器、设置、检索、重连提醒和转发模块；配置迁移代码已并入设置模块。
- 两端包含 `SSH-UI-NOTICES.txt`，其中保留字体、CodeMirror、xterm 及依赖的许可证，汇集 28 个包。
- 补齐字体和编辑器的 npm 锁文件；25 个相关运行时依赖的锁定版本与本次实际构建使用的版本一致。仅更新锁文件，没有执行安装脚本。
- Windows 包内 Electron main／preload／services／migration 与本轮源文件一致；SSH 原生文件和 notices 的 SHA256、大小全部匹配 manifest。打包步骤未破坏原生桥接文件校验。
- APK 包含 `SshConnectionService` 类与服务声明，以及 connectedDevice 前台服务、通知和唤醒锁权限。三种 ABI 的 `librhine-session.so` 均与原生 manifest SHA256 一致。
- 原生源码摘要：`5e55b3d35cc20d850e3bf09d5c7722fc930b375f7f2338d1b327d05181e373ac`。

文件检查结果见 [artifacts.json](ssh-workspace-settings/artifacts.json)。以下文件均位于 `release/ssh-workspace-20260915/`，同目录提供 `SHA256SUMS.txt`：

| 文件 | 字节数 | SHA256 |
| --- | ---: | --- |
| `RhineLab-Android-1.0.0-workspace-20260915.apk` | 52,303,960 | `6145c63fedf6a1033b15c34c2fb0b4cbe4c71d9e59caa7d0d5ec2dcad4b9c084` |
| `RhineLab-Portable-1.0.0-workspace-20260915.exe` | 163,294,055 | `25a149d25c0278cd4e6528fa5dcfeeee8290b39c120537f86c80486079038935` |
| `RhineLab-Setup-1.0.0-workspace-20260915.exe` | 163,515,390 | `f4462c84edd3703d270492501f4efd446e39391799d01f28927595332fc143da` |

## 使用边界

tmux 需远端已安装且使用兼容的 POSIX shell。安卓前台服务默认关闭，不能保证系统强制停止或厂商省电回收后的连接存活。SFTP 文本限普通 UTF-8 文件、1 MiB；协议没有通用 CAS，最终提交存在极短外部并发窗口，草稿仅在所属会话内存中。转发仅监听 `127.0.0.1`，SSH 结束后关闭，自动重连不悄悄恢复旧转发。配置迁移不承诺替代电脑系统 SSH 的 ProxyCommand、ssh-agent 或中间跳板认证配置。

上述为本轮实现和编译结果；新交互、手机显示效果、后台存活及真实服务器兼容性仍由用户实际使用确认。
