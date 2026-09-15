# 构建发布物

本目录只跟踪适合放入 GitHub 的发布物。Android APK 位于 `release/android/`。

Windows 安装程序、单文件 Portable 和展开式便携 ZIP 体积较大，其中单文件 EXE 超过 GitHub 普通仓库的 100 MiB 单文件限制，因此保留在本地构建输出中，不直接提交到 Git。需要 Windows 发布包时执行：

```bash
npm run dist
npm run dist:dir
```

展开式便携版位于 `release/desktop/win-unpacked/`，解压后直接运行 `Rhine Lab.exe`；它不会在每次启动时重复自解压。
