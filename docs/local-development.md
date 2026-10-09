# 本地依赖与按需检查

工具链与精确版本从 `package.json` 的 engines、packageManager 和 devDependencies 读取，固定依赖由 `pnpm-lock.yaml` 提供。Core 与 peer 来自本任务冻结输入；Node 兼容范围不代表每个补丁版已验。

```sh
corepack pnpm --version
corepack pnpm install --frozen-lockfile --prefer-offline
```

每工作树保留自己的 node_modules、lib 和临时目录，仅复用 package store。不要混用 npm 安装开发依赖，不复制其他工作树可写输出。`verifyDepsBeforeRun: error` 拒绝过期依赖，不自动安装；只读知识检查无需产品依赖。

| 目的                   | 当前入口                            |
| ---------------------- | ----------------------------------- |
| 工程导航与源码声明     | `corepack pnpm run check:knowledge` |
| 监听 Host 与 client    | `corepack pnpm dev`                 |
| 只构建 Host            | `corepack pnpm build:host`          |
| 只构建 client          | `corepack pnpm build:client`        |
| 构建 GEA 插件          | `corepack pnpm build:plugin`        |
| 类型检查               | `corepack pnpm typecheck`           |
| 固定官方 Core 类型检查 | `corepack pnpm typecheck:official`  |
| 构建目标与 watch 合同  | `corepack pnpm test:build`          |

完整 build 也仅构建 GEA host/client；页面在同组 Workbench 按自己的工具链构建。watch 只编译，不启动应用，勿并发写同一输出。官方类型检查需要明确准备的只读 SDK 与 peer 声明，不能以旧 SDK 或历史产物代替当前输入。

只读交付核对使用 `pnpm run delivery:check --input request.json`；短接续增加 `--continuation`。预算、阶段、原依赖与授权从同次固定回执读取派生，详见 [交付核对 interface](delivery-check.md)。`pnpm run test:delivery` 只运行本地 fixture 回归。CLI 退出0仅表示报告生成，消费者需读取报告状态；此入口不启动应用或恢复自动化。

按授权启动与切换时复用 [源码组合说明](plugin-split-validation.md) 的明确五源和自有 runtime。可构建不等于窗口已获授权。旧 desktop:dev 使用已安装公司壳，属于历史入口，不作为当前官方客户端协议。

## Codex Local environments

仓内 `.codex/environments/environment.toml` 是实际配置。默认 setup 只核工具，安装由明确选择的 Action 执行，不自动构建。Actions 的命令、cwd 与是否持续 watch 按该文件核对，需要不同范围时运行公开命令，不新增任务识别或编排器。

配置存在与命令行通过不证明应用内 setup/Action 已验。实际新任务需核 cwd、工具、冻结锁和结果；安装与完整构建不和 watch 并发。本次清理不改变用户配置或清理脚本。

## 可选本地采样

```sh
corepack pnpm observe --task build --source terminal --condition existing-layout
corepack pnpm observe:report
corepack pnpm test:observe
```

采样仅主动调用时启用，普通命令不增加后台服务。来源和缓存条件是人工标签，默认 unknown；记录白名单任务、时间、退出/取消、版本、锁和 Git 摘要，不记录源码、业务内容、环境值或完整参数。原终端输出未由它存档或脱敏，依赖 reused 不等于构建缓存命中。

仅显式采样空间时扫描本仓相应目录，不扫描共享 store。APFS 目录占用与文件系统剩余空间分别报告。记录不能作为完整输入或跳过验证依据；轮转仅限自身合法完成记录，不删除依赖、未知或在途记录。Windows 保持普通命令，POSIX 采样不是跨平台验收。

开发 pnpm 锁、普通包 npm shrinkwrap 与实际 profile 锁有不同归属，沿 [安装说明](install.md) 的协议，不将开发检查当发布授权。原过程记录见 [历史开发说明](history/local-development-pre-agent-environment-04.md)。

## 当前候选的质量检查

自己的源码与依赖准备后，`corepack pnpm quality:fast` 检查增量 lint、格式、官方类型、活跃工程引用与质量 CLI 反例。它允许未提交修改。固定基线为 `041ef35e16effcf98ffe3b252b64512c704dc29a`，只有基线后未变化的旧债务可保留；缺目标、工具失败、摘要变化和 ignore 绕过都拒绝。`corepack pnpm lint:audit` 与 `corepack pnpm format:audit` 检查全量债务，不能把增量通过写成全量 audit 通过。

`corepack pnpm quality:ci --input /absolute/path/candidate-input.json` 要求干净且固定的三仓输入，先核实际 Git SHA、完整历史与原锁，再只读核 Manage 的公开 SDK 工具、原上游依赖和 Workbench 的共享候选检查。它运行同一 `quality:fast`、`test:contracts` 与完整 `test`。CI 自身绑定事件实际 SHA，peer 使用命令内冻结的兼容提交；本地最终整合组合另有自己的回执，不能把两个 tuple 视为同一组合。

首次准备使用独立目录，三仓源码放在 `<job-root>/candidate/<repo>`，官方 Core 放在 `<job-root>/official-latest-standard`，原 link 依赖放在 `<job-root 的父目录>/current-mainline-closeout-44`。先按公开输入阶段生成声明，再显式准备：

```sh
node scripts/run-quality-ci.mjs --phase input --root /absolute/job-root --sha ACTUAL_GEA_COMMIT
corepack pnpm quality:ci --input /absolute/job-root/candidate-input.json --prepare-sdk --core-source https://github.com/deepseek-ai/deepseek-harness.git --prepare-inputs
```

准备阶段仅在独立 checkout 内按原工具链与冻结锁安装、编译库及 Core 静态网页。原 GenUI npm 资产与 Sidebar Git 源及摘要由 `scripts/quality-upstreams.json` 固定，`corepack pnpm quality:upstreams --root /absolute/upstream-root` 默认只读验证，增加 `--prepare` 才下载和构建。现有共享或借用目录拒绝准备写入。它不启动 Native、业务或模型请求，也不修改用户运行目录。首次 CI 需要明确的 peer contents-read 凭据，未配置时失败；最终 always 聚合拒绝失败、跳过、取消与缺结果。

完整 CI 显式开启源码窗口 fixture，Chromium 准备在本组 `.quality-browser` 中，所有服务和模拟模型端点只接受 loopback。完整 `test` 使用公开 reporter 拒绝必需测试的 skip，不能只按 Node 退出码把未执行的源码窗口称为全绿。该范围是源码 Host/profile 与本地 Web 集成，不能称为真实业务、模型服务或 Native 验收。
