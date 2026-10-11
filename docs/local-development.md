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

只读交付一致性检查使用 `pnpm run delivery:check --input request.json`，failed/unknown 返回非零；人工浏览报告使用 `pnpm run delivery:report --input request.json`，短接续增加 `--continuation`。预算、阶段、原依赖与授权从同次固定回执读取派生，详见 [交付核对 interface](delivery-check.md)。`pnpm run test:delivery` 只运行本地 fixture 回归。报告命令退出0只表示生成成功，检查命令退出0只证明一致性；两者都不授予业务验收、不启动应用或恢复自动化。

按授权启动与切换时复用 [源码组合说明](plugin-split-validation.md) 的明确五源和自有 runtime。可构建不等于窗口已获授权。旧 desktop:dev 使用已安装公司壳，属于历史入口，不作为当前官方客户端协议。

## Window fixture 的固定输入

`tests/fixtures/source-window.mjs` 在创建临时目录前读取 `GEA_TEST_CANDIDATE_INPUTS`，也接受显式 `inputFile` 参数。输入文件使用三仓候选检查已有的 `core` 提交与 `repositories` 记录，并声明绝对 `corePath` 和 `historicalFailure: { file, sha256 }`。每个仓的 `path` 为绝对路径，`head` 为已冻结的提交；历史失败文件保持原字节，摘要不匹配即拒绝。

fixture 调用声明的 Workbench `verify-candidate-input.mjs`，检查干净三仓、包身份、锁和固定 Core。Core 包从声明路径内的真实 package manifest 定位，Cordis 的公开 types 导出必须与 Workbench 官方 SDK 输入相同。当前 G fixture 仅复制本 checkout 的启动脚本用于离线行为回归，不从目录层数寻找邻仓或重新选择源组合。

```sh
node --test tests/source-window-input.test.mjs
GEA_TEST_CANDIDATE_INPUTS=/absolute/candidate-input.json node --test tests/window-launch-admission.test.mjs tests/source-selection-start.test.mjs
```

第一条是 Node-only 的前置拒绝检查，不需要 Core、依赖安装或服务。第二条要求实际固定 Core、三仓和历史证据，沿原 Window admission 及预算保护验证本地 fixture 行为。两者都不代替源码全量 profile、Native、业务或模型验收；完整 `test` 的失败状态继续按原回执记录。

## Codex Local environments

仓内 `.codex/environments/environment.toml` 是实际配置。默认 setup 只核工具，安装由明确选择的 Action 执行，不自动构建。Actions 的命令、cwd 与是否持续 watch 按该文件核对，需要不同范围时运行公开命令，不新增任务识别或编排器。

配置存在与命令行通过不证明应用内 setup/Action 已验。实际新任务需核 cwd、工具、冻结锁和结果；安装与完整构建不和 watch 并发。

## 可选本地采样

```sh
corepack pnpm observe --task build --source terminal --condition existing-layout
corepack pnpm observe:report
corepack pnpm test:observe
```

采样仅主动调用时启用，普通命令不增加后台服务。来源和缓存条件是人工标签，默认 unknown；记录白名单任务、时间、退出/取消、版本、锁和 Git 摘要，不记录源码、业务内容、环境值或完整参数。原终端输出未由它存档或脱敏，依赖 reused 不等于构建缓存命中。

仅显式采样空间时扫描本仓相应目录，不扫描共享 store。APFS 目录占用与文件系统剩余空间分别报告。记录不能作为完整输入或跳过验证依据；轮转仅限自身合法完成记录，不删除依赖、未知或在途记录。Windows 保持普通命令，POSIX 采样不是跨平台验收。

开发 pnpm 锁、普通包 npm shrinkwrap 与实际 profile 锁有不同归属，沿 [安装说明](install.md) 的协议，不将开发检查当发布授权。原过程记录见 [历史开发说明](history/local-development-pre-agent-environment-04.md)。

三核心普通包的明确输入、构建来源核对与用户安装步骤见 [三包交付入口](package-delivery.md)。`delivery:packages` 只做本地打包，`test:delivery:packages` 覆盖前置失败传播、保密诊断与归档来源，普通 profile 安装及公开 Loader/设置接收须使用同次明确输入独立留证；脚本存在或历史夹具通过不证明本 checkout 已接收。

## 普通 bundle 启动

GEA 的 [公开 Config schema](../src/host.ts) 为空配置提供 [公司产品定义](../desktop/company.config.json) 中的端点、分页、超时、模型与 Consumer 默认。模型模式为 `model`，来源为 `gea`；启动不登录、不请求外部业务，也不替换官方 standard 或 Core 的默认模型选择。显式配置继续优先。

环境地址从 Host 部署配置解析，见 [环境合同](../src/shared/environments.js)。没有显式环境 map 且基址为公司默认时，Host 使用产品定义中的正式/测试双环境；显式自定义单一基址仅开放当前环境。client 的 `businessAccount.startLogin` 只传环境名称，Host 先切换已配置环境并清旧二维码、凭据和预览，再准备新二维码。只读投影发布当前 environment 与可选 environments，不另建浏览器登录权威。

未设置 `runtimeDir` 时，Host 从官方 `profileContext.dir` 派生 `gea/` 专用持久目录。显式目录必须是可创建的绝对目录。普通插件登录由 GEA Host 在此目录写入权限为 0600 的 `web-login.json`，默认不依赖旧启动器变量；`GEA_WEB_LOGIN_PERSIST=0` 仍可明确关闭，旧公司桌面的私有凭据通道保留其原归属。

发行 manifest 要求同批 Workbench/Manage exact peers。GenUI/Sidebar 维持 exact optional peers，不随三主插件自动启用。未安装或停用辅助插件时，只报告其真实缺席状态；官方 standard 和已配置业务授权保护保持原接口。

`node --run test:fixture-inputs` 是无 SDK 的输入拒绝回归，也由现有 delivery fixture CI 执行。它不代替需要固定官方输入的 `test:window`；远端 workflow 的配置与实际执行结果分别记录。

冷 runner 直接调用 `node scripts/run-quality-ci.mjs --prepare-sdk --prepare-inputs --core-source <固定来源>`，避免依赖安装前的 pnpm run 检查。普通本地 `pnpm quality:ci` 运行同一入口。质量阶段分别保存 fast、contracts、full 状态到 `quality-checks.json`，fast 各检查保存 `.runtime/quality-fast.json`；前项红不挡后项，整体仍非零。输入或准备失败立即拒绝。

## 异步执行与确定性检查

[`PromptExecutionState`](../src/host/prompt-execution-state.ts) 私有持有工具输出状态、执行 lease 与证据 store；[`prompt-runtime`](../src/host/prompt-runtime.ts) 接入真实 Host hooks。迟到的失败、成功和回读视图不进入新轮次或新资源的状态，持久化期间失去归属也不发布当前证据。预算与 UI mask 继续由原 admission 状态管理；详细执行条件见 [执行链](execution-logic.md)。

| 检查范围 | 现有入口与边界 |
|---|---|
| 执行状态、lease与真实文件 IO 的确定性回归 | `test:prompt-execution` 不要求 SDK 或工程依赖，运行要求从 package.json 的 engines 读取；Host 集成另由 [execution-convergence.test.mjs](../tests/execution-convergence.test.mjs) 在已准备官方依赖的 checkout 覆盖旧错误和资源准入/回读 |
| 三包打包与安装/Loader接收的确定性失败 | `test:delivery:packages` 自建 fixture Core与发布输入，重放历史 APS入口/销售Skill缺失，运行不依赖兄弟仓或现成Core；正式普通profile接收另见 [打包与接收](package-delivery.md) |
| Window输入拒绝与原行为 | `test:fixture-inputs` 只核输入；`test:window` 使用明确冻结Core、三仓和历史证据，保留原准入和预算门禁 |

上述 Node-only 检查由 [delivery fixture CI](../.github/workflows/delivery-fixtures.yml) 登记。workflow配置、局部检查通过、真实Host集成、当前窗口装载和业务验收分别留证；脚本存在不证明已经运行。
