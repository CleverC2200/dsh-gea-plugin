# GEA Electron 桌面

桌面壳固定 Electron 44.0.0、官方 DSH 0.1.5-rc.2、Node.js 24.14.1 和安装工具 pnpm 11.19.0。只交付 macOS Apple Silicon DMG 与 Windows x64 NSIS。安装包不携带维护者凭据。

## 独立插件版本

首次从 payload 基线启动。菜单“插件版本 → 准备本地插件包”接收已构建 tgz，复制基线的代码与锁到用户目录暂存区，通过官方 `dsh plugin` 安装到该区。pnpm 由 payload/tools 提供，不调用同事机器上的开发工具。官方依赖逐项固定，安装后核对版本与公司插件的共享 Cordis 解析。

准备完成不会改变当前进程。组合存于 userData/plugins/versions，version.json 记录实际版本、依赖和锁校验值；“切换已准备版本并重启”串行停止当前后端、原子写选择、启动新组合。Electron 与内置 payload 不被修改。版本目录包含独立解析的完整图，避免官方 DSH 安装优先解析规则导致仍加载内置旧插件。

配置在 userData/gea.config.json，会话、设置与工作区在 userData/data。切换只更新 profile 的受管插件链接与清单，保留数据。DSH_GEA_DESKTOP_DATA 可指定隔离验收目录。普通 node_modules 目录不会被自动覆盖。准备区只复制包、代码、锁，不复制连接配置、账号或会话。

#37 只承诺手动选择已准备版本，不将自动回退列为已验收能力。不得把登录失败或外部 GEA 网络不可用作为后端启动失败。

## 构建和验证

使用 electron-builder 26.15.3，`GEA_DESKTOP_PAYLOAD_ROOT` 指向新构建根，包含 mac/payload、win/payload。各 payload 必须包含相应平台 Node、生产依赖、标准发行包、pnpm 11.19.0 工具与 runtime-start.mjs 的 start.mjs 副本、onboarding.mjs。不能把 Mac 原生模块复用到 Windows。

`node --test desktop/config.test.cjs desktop/onboarding.test.mjs desktop/plugin-store.test.mjs` 验证配置、提示、版本目录与数据保护。指定 `GEA_DESKTOP_TEST_GRAPH` 运行 desktop/runtime-graph.test.mjs 验证外置启动；指定 `GEA_DESKTOP_BASELINE`、`GEA_DESKTOP_NEXT` 运行 desktop/version-switch.test.mjs 验证实际页面版本切换。

Windows 路径使用 file URL 动态导入、junction 与带引号的固定工具路径；在 Mac 的交叉检查不等于真实 Windows 验收。最终安装包交付票还需目标平台首次启动、升级、失败恢复证据及签名状态。

`time-command.py` 记录打包起止时间与耗时，`trim-payload.py` 与 `verify-trim.py` 用于精简旧 payload 的可审核副本。不得覆盖已有产物或运行中的数据目录。
