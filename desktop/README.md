# GEA Electron 桌面包

此目录提供独立桌面壳，使用 Electron 44.0.0、官方 DSH 0.1.5-rc.2 和随包 Node.js 24.14.1，不修改 DSH 源码。Mac Apple Silicon 生成 DMG，Windows x64 生成 NSIS EXE。产物未配置发行签名或公证，没有自动更新。

应用自带已安装的对应平台依赖与 300 项插件清单，并包含 GEA 内嵌的独立工作台和示例 Agent。默认启用兼容的 base/web、GEA、workbench、dsh-plugin、visualize、agent-plugins-market；已知不兼容的 UI 全家桶保留代码但不启用。精简版中，266 项以已安装代码提供，另外 34 项保留归档，避免同一插件同时包含安装代码和归档。完整清单见资源目录 payload/plugins.json。内置运行环境不需要首次联网安装；GEA 登录、模型服务和外部插件服务仍需要网络与相应权限。

首次启动填写 GEA 地址和模型 ID，随后扫码登录。应用菜单提供连接设置、打开数据目录、重新启动和开发者工具。配置和会话保存于 Electron userData（macOS 的 Application Support/dsh-gea-desktop、Windows 的 AppData/dsh-gea-desktop）；卸载安装包不删除这些数据。DSH_GEA_DESKTOP_DATA 可覆盖整个应用数据目录，供隔离验收。安装包不包含任何真实配置、凭据或会话。

桌面 shell 只加载自己的设置页和它启动的 DSH loopback 地址。渲染器关闭 Node 集成、开启 sandbox/contextIsolation；设置 IPC 仅接受设置页主 frame。DSH 使用随包上游 Node 子进程和随机 loopback 端口、原生启动令牌。profile 的 node_modules 指向不可变的内置插件目录；更新应用后重建该链接。当前版本更新插件需重建安装包，不支持向内置图直接安装或更新插件。

关闭应用会请求启动器停止后端，超时后清理该应用的进程组；Windows 使用进程树终止兜底。Mac 会验证实际退出行为；Windows 在获得目标平台之前仅做交叉构建与静态校验。

## 构建

使用 electron-builder 26.15.3。electron-builder.cjs 从 `.runtime/electron-build/mac/payload` 或 `win/payload` 读取完整平台运行目录，其中包含 Node、生产 node_modules、插件归档、示例配置和 runtime-start.mjs 的 start.mjs 副本。依赖安装使用相应平台参数，不能复用 macOS 原生模块作为 Windows 依赖。

运行 `node --test desktop/config.test.cjs`，然后以 `GEA_DESKTOP_TARGET=mac` 或 `win` 调用 electron-builder，使用 `--projectDir desktop --config electron-builder.cjs` 和相应 `--mac --arm64` / `--win --x64`。当前 payload 准备过程保留在本机发行目录，尚未封装成独立的全自动 CI 构建命令。

## 精简与计时

`trim-payload.py <source> <target>` 创建新运行目录，移除源码映射、Node 开发头文件/手册和已安装插件的重复归档；保留全部运行代码、类型声明、npm、许可证及未安装插件归档。逐文件删除记录和耗时保存在目标平台目录的 trim-report.json。通过 GEA_DESKTOP_PAYLOAD_ROOT 选择精简运行目录，旧产物不覆盖。

`time-command.py <record.json> <command...>` 记录命令、UTC 起止时间、墙钟耗时和退出码，并保存同名日志。Mac 与 Windows 并行打包时分别计时，不能将两者相加当作总等待时间。

## 桌面品牌与首次提示

应用和安装器使用 src/gea-logo.png 的 GEA 图标。onboarding.mjs 在后端启动前保留已有 YAML 设置及注释，并将 ui-onboarding.welcomeNoticeVersion 设为固定 DSH 0.1.5-rc.2 的 2026-08-13.1，从而跳过该版本的内测声明；升级 DSH 时应复核此版本。首次连接配置页保持不变。准备 payload 时同时复制 runtime-start.mjs 为 start.mjs，并复制 onboarding.mjs。
