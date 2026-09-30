# 2026-09-30 仓库整理验收

## 交付结果

主项目位于 `D:\myproject\RhineLab`，包含 Web、Electron、Android、壁纸及 Go SSH 服务。Unreal 独立位于 `D:\myproject\RhineLab-Unreal`，通过带版本与 SHA-256 的共享包安装资源和服务，不再读取相邻仓库源码。目录职责和日常入口见 [REPOSITORY.md](../REPOSITORY.md)，分支规则见 [GIT-WORKFLOW.md](../GIT-WORKFLOW.md)。

前端按 app、features、platform、rendering、shared 分层；SSH 装配、设置弹窗、平台桥和场景后处理分别归位。Electron IPC 注册与运行诊断拆出主文件。构建、导出、检查和截图脚本分组，检查输出集中到 `.artifacts/checks/<suite>/<run-id>`。研究资料与原验收资料移入 docs，旧工程、重复工程、会话记录和旧发行包保留在迁移备份。

## Git 状态

- 当前主工作区：`integrate/repository-cleanup`，以远程发布提交 `9357e4b` 为基础；验收代码提交 `d20d00a`。
- 本地 `main` 跟踪 `origin/main`，此次未推送、强推或改写远程。
- 原分支和 stash 有 `archive/20260930/*` 引用；原工作区有 `wip-0`、`wip-1` checkpoint。旧 stash 保留。
- Android worktree 的 12 项暂存改动原样保留；已完成桌面与临时整合 worktree 在保留本地产物后移除。
- Unreal 使用 `main`，验收代码提交 `28353a3`；`archive/source-import` 保留提取历史，尚未配置独立远程。

## 共享依赖

Unreal 锁定 `1.0.2-shared.1`，来源为 Web 提交 `927351abd02868326c74d68094d15a34f41366ad`。之后的 Web 提交涉及诊断、检查和文档，不改变该共享包。ZIP 包含 785 个文件，SHA-256 为 `541e35dd5e25040affe7fe82e4cdb52c1a5908f223c34230d157b1f69de6b7af`。

损坏 ZIP 会在写入前拒绝且保留原安装，缺失生成依赖会明确失败；恢复后依赖检查通过。包与清单位于 Web 的 `.artifacts/shared/1.0.2-shared.1`。Unreal 的 NVIDIA 授权插件、原始烘焙帧和视频在本机保留，不进入共享包。

## 验证结果

| 范围 | 结果 |
| --- | --- |
| Web | TypeScript、生产构建及 PWA 构建通过 |
| Electron | `dist:dir` 通过；最新发行目录实机启动，原生桥、SSH 工作区及场景加载通过 |
| Android | 原生 Gradle APK 构建通过；最新终端检查 34 项全部通过 |
| 壁纸 | 构建通过，833 个文件，约 35.4 MiB |
| SSH 与交互 | 内容、Go 服务、凭据、多会话、剪贴板、主题、帧预算及编辑器关闭相关检查通过；原生终端 15 项、原生编辑器 10 项通过 |
| 共享包 | 单元检查与真实安装通过，损坏/缺失依赖拒绝检查通过 |
| Unreal | 独立构建与打包通过；修复干净构建下 Unity 翻译单元冲突 |
| Unreal 工作区 | 本机真实 SSH/SFTP fixture、双向文件哈希、凭据与跳板配置检查通过 |
| Unreal 完整工作台 | 84 项全部通过，包括 IME、ConPTY、主题、动画一致性及 4K60 / 1440p120 视频采样覆盖率 |

最新 Android 报告：`.artifacts/checks/android-terminal/20260930T151350Z-d20d00a/report.json`。

最新桌面发行包报告：`.artifacts/checks/desktop-package/2026-09-30T15-14-31-240Z/report.json`。

Unreal 完整报告：独立仓库 `.artifacts/checks/unreal-prototype/20260930T150623Z-28353a3/report.json`。较早的并行运行中视频性能未达标，保留原报告；最终使用新打包成品单独运行，两个视频覆盖率检查均达到原有 98% 门槛，未放宽门槛。

DLSS5 实验成品和授权 SDK 已保留；此次没有重新构建或验收 DLSS5 专项。新机器仍需按 Unreal README 安装 UE/C++ 工具链、授权 NVIDIA 插件及烘焙视频。

## 恢复资料

迁移目录：`D:\myproject\.rhine-migration\20260930`。原 `state.json`、文件副本、二进制补丁、迁移前 bundle 保留。最终引用和提交保存在 `final-web.bundle`、`final-unreal.bundle`，Unreal LFS 对象另存 `unreal-lfs-objects`；bundle 本身不包含 LFS 内容。`final-state.json` 和 `final-backup.sha256.json` 记录最终状态及备份摘要。

恢复时先在新目录验证 bundle，再还原需要的 LFS 对象和未提交文件；不要将 archive/checkpoint 分支当作产品分支发布。
