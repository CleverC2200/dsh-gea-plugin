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

插件列表更新是可选能力。GEA 的状态与安全原因类型从自身生产数据推导，不强制导入尚未部署的官方 UI 类型；运行时仅在 `pluginUpdates` 的 v1 注册能力存在时接入。开发新 UI 候选时，显式设置 `GEA_PLUGIN_UPDATE_SDK` 和 `GEA_PLUGIN_UPDATE_CANDIDATE_CORE` 的绝对路径，执行 `typecheck:plugin-updates`，它把 GEA provider 和原因数据核对到该候选的权威 UI 合同。旧 Core 编译通过不证明具备新界面，候选合同通过也不证明部署完成。

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

## Cube-New 直返定向验证

`node --test tests/cube-direct-mcp.test.mjs tests/cube-new.test.mjs tests/mcp-response.test.mjs tests/gateway-mcp.test.mjs` 核标准MCP直返、文本回退、旧链接灰度、分页完整性、精度、错误、路由和接收预算。它只使用本地结构示例，不请求真实业务。完整质量入口保持原样；全量测试、真实部署、实际规模内存与代理超时另留证。

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

发行 manifest 保留 Workbench/Manage 已有 peer 约束；未声明的源码 companion link 才从明确输入投影 exact peer。完整组合与独立 release 见 [签名插件来源](plugin-release-source.md)。GenUI/Sidebar 维持 exact optional peers，不随三主插件自动启用。未安装或停用辅助插件时，只报告其真实缺席状态；官方 standard 和已配置业务授权保护保持原接口。

`node --run test:fixture-inputs` 是无 SDK 的输入拒绝回归，也由现有 delivery fixture CI 执行。它不代替需要固定官方输入的 `test:window`；远端 workflow 的配置与实际执行结果分别记录。

冷 runner 直接调用 `node scripts/run-quality-ci.mjs --input <三仓冻结 JSON> --final-group-sha256 <原始字节 SHA256> --final-group-workbench <绝对 Workbench 源路径> --prepare-sdk --prepare-inputs --core-source <已观察固定 Git 源>`；本地 `pnpm quality:ci --` 传入相同参数。公开 Workbench reader 先核实际三仓 HEAD、包身份、锁和 Core，缺少显式输入或原字节哈希立即拒绝；旧 `--phase input` 不再写历史 peer。普通 push/PR 通过 committed baseline 仅替换 own event，dispatch 必须声明完整三仓 tuple，两类验收回执分别记录。质量阶段保存 fast 与 required-and-affected 状态到 `quality-checks.json`，选择依据保存 `quality-test-plan.json`。GitHub 不再执行全量集合；Profile 准备仅在受影响集合需要时执行。具体规则与缓存拒绝条件见[当前 CI 规则](../../dsh-agent-workbench/docs/ci-required-and-affected.md)。前项红不挡后项，整体仍非零；输入或准备失败立即拒绝。

Linux `quality.yml` 将同一个 CLI 分为 `--stage prepare`、`build`、`checks`、`tests` 和 `summary`。省略 `--stage` 仍完整运行，`--phase` 继续选择原质量 lane。各步骤传入同一组参数，包含 `--prepare-sdk --prepare-inputs --input <冻结 JSON> --core-source <固定 Git 源> --final-group-sha256 <原始字节 SHA256> --final-group-workbench <绝对源路径>`。

阶段回执写入本 job 的 `quality-stages.json`，绑定原输入哈希、lane、完整三仓与测试计划，保存阶段起止、耗时和独立检查结果。准备执行 SDK、依赖和私有 Workbench worktree 准备；构建执行候选包、资产与所需浏览器/桌面准备。后续进程重新走公开源码准入、SDK 和现有准备回执检查，并从冻结源码重建 `GEA_TEST_*` 环境，不读取上一 shell 的环境。GEA/Manage 的构建输出另按字节摘要核对；不能仅凭阶段 JSON 证明产物有效。

`checks` 收集 final-group 与 fast；其失败后 `tests` 仍运行原必选与受影响集合，保持并行 2 和拒绝必选 skip。准备或构建失败阻止依赖步骤。汇总拒绝失败、缺失、running、skip 或取消，上传 `quality-stages.json` 与原质量回执。GitHub step summary 是结束时的耗时摘要，不是实时 API。macOS 与最终 `candidate-quality` 继续使用原强制门禁。阶段状态只属于当前 job，不是跨任务状态或未来执行许可。

`node --test scripts/run-quality-ci-stages.test.mjs` 通过公开 CLI 验证真实临时 Git 输入、跨进程恢复、实际 fixture 测试、失败与取消。独立 checkout 可用 `GEA_FINAL_GROUP_WORKBENCH_SOURCE` 和 `GEA_FINAL_GROUP_MANAGE_SOURCE` 指向本票登记的只读 peer 源码。安装/编译命令使用受控 OS adapter，不安装依赖或构建产品；这些结果不代替远端完整 CI、真实 SDK 编译、Native 或业务验收。

## 异步执行与确定性检查

[`PromptExecutionState`](../src/host/prompt-execution-state.ts) 私有持有工具输出状态、执行 lease 与证据 store；[`prompt-runtime`](../src/host/prompt-runtime.ts) 接入真实 Host hooks。迟到的失败、成功和回读视图不进入新轮次或新资源的状态，持久化期间失去归属也不发布当前证据。预算与 UI mask 继续由原 admission 状态管理；详细执行条件见 [执行链](execution-logic.md)。

| 检查范围                                  | 现有入口与边界                                                                                                                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 执行状态、lease与真实文件 IO 的确定性回归 | `test:prompt-execution` 不要求 SDK 或工程依赖，运行要求从 package.json 的 engines 读取；Host 集成另由 [execution-convergence.test.mjs](../tests/execution-convergence.test.mjs) 在已准备官方依赖的 checkout 覆盖旧错误和资源准入/回读 |
| 三包打包与安装/Loader接收的确定性失败     | `test:delivery:packages` 自建 fixture Core与发布输入，重放历史 APS入口/销售Skill缺失，运行不依赖兄弟仓或现成Core；正式普通profile接收另见 [打包与接收](package-delivery.md)                                                           |
| Window输入拒绝与原行为                    | `test:fixture-inputs` 只核输入；`test:window` 使用明确冻结Core、三仓和历史证据，保留原准入和预算门禁                                                                                                                                  |

上述 Node-only 检查由 [delivery fixture CI](../.github/workflows/delivery-fixtures.yml) 登记。workflow配置、局部检查通过、真实Host集成、当前窗口装载和业务验收分别留证；脚本存在不证明已经运行。
