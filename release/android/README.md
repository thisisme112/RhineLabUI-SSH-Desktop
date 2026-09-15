# Rhine Lab Android 发布包

`RhineLab-Android-1.0.0.apk` 是当前项目的 Android debug 构建包，包含离线页面资源和 Android SSH 工作区。

## 安装

在 Android 设备上允许安装来自文件管理器的应用，然后打开 APK 完成安装。更新同一应用时不要先卸载旧版，否则会丢失主机、指纹和加密凭据。

## 自行构建

在仓库根目录执行：

```bash
npm ci
npm run android:build
```

构建需要 Android Studio/SDK、JDK 17 和 Gradle 8.2.1。APK 默认输出到 `android/app/build/outputs/apk/debug/app-debug.apk`。

相关源码和构建说明：

- `src/ssh/android/`：Android 工作区界面与桥接
- `android/app/src/main/`：原生 SSH、Keystore、文件选择和会话服务
- `scripts/build-android-native.mjs`：原生服务编译与校验
- `docs/ANDROID.md`：完整环境、权限、存储迁移和发布说明
