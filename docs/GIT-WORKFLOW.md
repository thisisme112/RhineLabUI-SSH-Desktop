# Git 工作流

两个产品仓库分别维护 `main`，保持可构建。功能、修复、重构使用 `feat/<topic>`、`fix/<topic>`、`refactor/<topic>`；实验使用 `experiment/<topic>`。仅维护旧版时建立 `release/<version>`，不设长期 `develop` 或平台开发主线。

任务从最新 `origin/main` 建分支。每个任务使用仓库外的独立 worktree。改动、对应检查和必要文档放在同一 PR，目录搬迁与逻辑调整分开提交。日常 PR 使用 squash；此次迁移保留按功能拆开的提交。

合并后清理已完成的分支和干净 worktree。存在暂存、未提交或未跟踪文件时先保存并核对；不要把 stash 当作唯一备份。

现有 `1.0.0`、`1.0.2` 标签保留。以后本仓库按 `web-v*`、`desktop-v*`、`android-v*` 标记产品发布，Unreal 使用自己的 `v*`。共享包单独使用 `<产品版本>-shared.<序号>`，锁定清单包含源提交和包哈希。

## 2026-09-30 迁移记录

原本地 `main` 与远程 `main` 没有共同祖先。整合分支以远程已发布的 `9357e4b` 为基础，迁入当前源码，保留网页 SSH 演示和 CI；没有合并不相关历史或强推。

原分支保存在 `archive/20260930/*`。三个 worktree 的原 HEAD、分支、暂存/未暂存补丁和改动文件摘要保存在本机 `D:\myproject\.rhine-migration\20260930`，Git bundle 同目录。主工作区和 Android 暂存改动另有 `wip-0`、`wip-1` checkpoint；旧 stash 未删除。

新 Unreal 仓库提取了原 `prototypes/unreal` 目录历史，`archive/source-import` 保存提取结果。结构调整发生在新提交中，原仓库和发布历史未重写。旧 `unreal 5.8` 工程单独归档，不作为活动工程。

主目录当前使用 `integrate/repository-cleanup`；本地 `main` 已重新指向并跟踪 `origin/main`。源码 checkpoint 位于 `checkpoint/20260930/main`。旧 Unreal / upload-clean / 已完成桌面任务分支仅保留 archive 引用；桌面与迁移临时 worktree 的本地产物先归档后移除。Android worktree 的 12 项暂存改动原样保留，可继续开发或按 checkpoint 核对后收尾。

旧工程、重复工程与旧发行包保存在上述迁移目录的 `original-prototypes`、`original-verification`、`original-reference`、`old-releases` 中。当前远程未改写；Unreal 仓库尚未配置远程地址，首次发布时再添加独立远程。

备份包括未提交文件；bundle 仅保存 Git 对象与引用。恢复工作区内容时同时使用相应文件清单和补丁，先在临时目录核对。归档与 checkpoint 不推送为产品分支。
