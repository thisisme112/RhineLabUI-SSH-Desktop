# SSH 辅助服务

桌面主进程为一个已经认证的 SSH 会话启动一个本机桥接进程。桥接通过系统 OpenSSH 建立独立 SFTP 与采集通道，二进制文件数据不经过 renderer。主终端继续使用原 ConPTY 与 xterm。

安卓使用 `cmd/session` 原生 SSH 客户端。它在认证后把同一条 `ssh.Client` transport 交给 `internal/native/authenticated.go`，复用下述 SFTP、传输和监控实现；界面与桌面共用，不需要手机提供系统 OpenSSH。见 [安卓说明](../../docs/ANDROID.md)。

## 源码

| 目录 | 用途 |
| --- | --- |
| `cmd/bridge` | JSON 行 RPC、辅助认证问答、请求生命周期。 |
| `cmd/session` | 安卓 SSH 连接、主机密钥确认、密码／公钥／交互式认证、PTY 和已认证辅助通道。 |
| `internal/native` | OpenSSH 参数、askpass、本机用户专属 IPC、Windows Job Object 子进程清理。 |
| `internal/service` | SFTP 元数据、两路传输、冲突、临时提交与恢复；采集器探测、上传、校验及启动。 |
| `cmd/monitor` | 远端 Linux 入口、逐秒循环、心跳看门狗和 NVIDIA 持续输出。 |
| `internal/monitor` | `/proc`、文件系统和 NVIDIA XML 解析、相邻采样速率。 |
| `cmd/fixture` | 本地协议验收专用 SSH/SFTP 服务器，不随桌面服务资源分发。 |

## 构建

`npm run build:ssh-services` 从源码构建本机平台桥接、Linux amd64/arm64 静态采集器及安卓 arm64/armv7/amd64 会话代理。桌面 dev、build、start 和安卓打包脚本自动运行 `--ensure`，校验源码摘要和已有二进制，未改变时复用。

编译器固定为 `toolchain.json` 中的 Go 1.27.1，Windows ZIP 的 SHA-256 同时固定。Windows 首次运行从 `go.dev/dl` 下载到项目内 `.tools/ssh-toolchain/` 并校验，再调用编译器；模块版本和内容校验记录在 `go.mod` / `go.sum`。其他本机平台需自行提供相同版本的 Go，可用 `RHINE_GO` 指定可执行文件。当前实测客户端为 Windows amd64，其他本机平台未作发行验收。

编译使用 `CGO_ENABLED=0`、`-trimpath`、`-buildvcs=false` 和 `-ldflags=-s -w`。产物在忽略 Git 的 `electron/resources/ssh-services/`，包括桥接、两种架构的采集器、依赖许可和 `manifest.json`。清单记录协议版本、采集器版本、工具链、源码摘要、每个二进制的文件名、大小和 SHA-256，以及许可文件校验值。发行 Electron 应用时必须包含整个目录；本项目现有 `start:desktop` 直接使用该目录。

Electron 启动桥接前校验其哈希。采集器以用户缓存中的 `<版本>-<二进制哈希前16位>/agent` 存放；上传使用唯一临时文件，检查完整哈希后提交并设为 0700。重连复用通过哈希检查的缓存。缓存可保留，不注册系统服务；进程随连接关闭，心跳看门狗处理本机崩溃或网络失联。

## 验证

- `npm run check:ssh-services-unit`：主进程连接参数、凭据、生命周期及故障恢复。
- `go test ./...`：在本目录用固定工具链执行，覆盖采样解析、计数回绕、看门狗、输出背压、NVIDIA 子进程清理及文件提交恢复。
- `npm run check:ssh-services`：真实系统 OpenSSH 与本机 fixture 的 SFTP、askpass、ProxyJump、文件往返与进程清理；fixture 的采样是模拟数据。
- `npm run check:ssh-workspace`：实际桌面 bundle 的文件、监控、传输、动画和响应式交互。
- `npm run check:ssh-terminal-geometry`：实际鼠标点击、ASCII/中文拖选、SGR 鼠标行列、侧栏位移，覆盖不同尺寸与 DPR。

真实 Linux / GPU 验收与限制另见 [验证记录](../../verification/SSH-WORKSPACE.md)。

## 依赖许可

`THIRD_PARTY_NOTICES.txt` 保留固定版本的完整许可，并随生成资源分发。

| 组件 | 固定版本 | 许可 |
| --- | --- | --- |
| Go runtime | 1.27.1 | BSD-3-Clause |
| github.com/pkg/sftp | 1.13.11 | BSD-2-Clause |
| github.com/Microsoft/go-winio | 0.6.2 | MIT |
| github.com/kr/fs | 0.1.0 | BSD-3-Clause |
| golang.org/x/crypto | 0.54.0 | BSD-3-Clause |
| golang.org/x/sys | 0.47.0 | BSD-3-Clause |

OpenSSH 和 `nvidia-smi` 使用宿主已安装的程序，不在本项目中再分发。浏览器侧 xterm、Three.js 等依赖继续使用原项目的 npm 许可。
