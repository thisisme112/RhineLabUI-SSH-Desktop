# RhineLab

Web、Electron 桌面、Android 与 Wallpaper Engine 共用的三维档案和 SSH 工作区。Unreal 原生实现已拆为独立仓库。

- [项目结构与全部入口](docs/REPOSITORY.md)
- [Git 分支与迁移记录](docs/GIT-WORKFLOW.md)
- [桌面 SSH](docs/DESKTOP-SSH.md) · [Android](docs/ANDROID.md) · [桌面打包](docs/DESKTOP-PACKAGING.md)
- [视觉基准](docs/design/visual-baseline.md) · [SSH 设计记录](docs/design/ssh-workflow.md)

```powershell
npm ci
npm run dev:web
npm run dev:desktop
```

构建：`npm run build:web`、`npm run dist:dir`、`npm run android:build`、`npm run build:wallpaper`。

检查：`npm run check:content`、`npm run check:ssh-multisession-unit`、`npm run check:ssh-services-unit`、`npm run check:shared`。每次检查生成独立的忽略 Git 的输出目录。

共享包：`npm run export:shared`，供独立 Unreal 仓库按锁定清单安装。本地授权字体、用户主机与凭据、SDK 和构建缓存不提交。

原项目：[LBEILC/RhineLabUI](https://github.com/LBEILC/RhineLabUI.git)。源代码遵循 MIT；第三方字体与资源按各自许可分发。
