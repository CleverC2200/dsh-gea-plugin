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

插件更新使用官方 `plugins.detail.actions`、`plugins.detail.badge` 和 `plugins.detail.section` 扩展位，等待公开 slots、locale 与 modules 服务就绪后向三个公司 bundle 贡献内容。定向类型检查只需将 `GEA_PLUGIN_UPDATE_SDK` 指向未修改、已准备的官方 SDK 绝对路径，再运行 `typecheck:plugin-updates`。该检查包含实际详情 TSX、公共组件与本地样式声明；部署配置和分层验证见 [签名插件来源](plugin-release-source.md)。

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

提交昂贵的候选 CI 前，先用本仓 `corepack pnpm quality:fast --source-only <改动文件...>`。它复用 lint、format:check、知识及 Prompt 声明检查，并执行环境与发行兼容 fixture，不准备 SDK或构建；省略文件则沿用仓内默认扫描范围。默认 fast 在源码检查失败时记录跳过依赖 SDK 的检查与测试，并返回失败。

冷 runner 直接调用 `node scripts/run-quality-ci.mjs --input <三仓冻结 JSON> --final-group-sha256 <原始字节 SHA256> --final-group-workbench <绝对 Workbench 源路径> --prepare-sdk --prepare-inputs --core-source <已观察固定 Git 源>`；本地 `pnpm quality:ci --` 传入相同参数。公开 Workbench reader 先核实际三仓 HEAD、包身份、锁和 Core，缺少显式输入或原字节哈希立即拒绝；旧 `--phase input` 不再写历史 peer。普通 push/PR 通过 committed baseline 仅替换 own event，dispatch 必须声明完整三仓 tuple，两类验收回执分别记录。质量阶段保存 fast 与 required-and-affected 状态到 `quality-checks.json`，选择依据保存 `quality-test-plan.json`。GitHub 不再执行全量集合；Profile 准备仅在受影响集合需要时执行。具体规则与缓存拒绝条件见[当前 CI 规则](../../dsh-agent-workbench/docs/ci-required-and-affected.md)。独立源码检查保留各自结果；checks 失败会阻断后续测试，整体仍非零。输入或准备失败立即拒绝。

Linux [quality workflow](../.github/workflows/quality.yml) 在 scope 后由 source-plan 冻结适用范围和正式计划，再启动适用的 producer 与 Mac。source-plan 仅 checkout 同组三仓/Core、写原候选并运行公开 `--stage plan --test-shards auto --test-file-concurrency 3 --test-timings scripts/quality-test-timings.json`，不安装或编译；小 control 只有计划与来源，没有产物或依赖准入权。early planner 收齐每个 required Core 后生成原正式计划的全部非空片，最多14个 worker、`max-parallel: 14`，不填空片。普通入口文件并发仍为2，Linux 各阶段显式3、Mac保持默认2；算法、容量拒绝和历史来源见 [测试执行合同](ci-test-execution.md)。历史样本未知耗时仍为 null，不证明新候选的性能通过。

每个 required Core 的 producer 只执行一次 `prepare`、`build`、`checks`，用原输入哈希、lane、完整三仓和执行计划形成 `quality-stages.json`。准备安装声明的原锁、SDK及私有 Workbench worktree；构建生成候选包、资产和必要浏览器/桌面输出。GEA/Manage 输出按字节摘要冻结。producer 复用 source-plan 的正式计划，在候选构建前用 --source-only --checks-only 执行 lint、format、knowledge、prompt-execution 四项静态检查，并以 `--source-receipt-out .runtime/quality-source-checks.json --input-sha256 <原候选哈希>` 保存完整结果。`checks --source-check-receipt FILE` 继续核 final-group，fast 只在原输入 SHA、实际 HEAD、全部源码字节、Node 与平台相同且四项均通过时复用回执，然后执行官方类型检查；失败、缺项、部分文件检查或源码漂移均拒绝。环境与发行兼容合同的三个实际文件纳入 required 池，由构建后的严格执行器各执行一次，失败仍拒绝，真实运行窗口与环境准入没有退场。普通本地 source-only 不带 checks-only 时仍执行六项检查。checks 失败阻断 Chrome 快照与准备物导出，worker 不会收到可执行输入，最终结果保留原失败。准备或构建失败也不能发布可执行输入。

producer 将原 candidate、阶段/执行计划、来源回执、binding 原字节及准备物摘要发布为小 index；大 bundle 每 Core 只导出、上传一次，保留1天。worker 在 producer 构建期间以一次活调用准备固定源码和独立的五组锁，保留最多双安装及 Workbench→inventory 顺序。GEA 依赖所需 GenUI 产物留到接收后；没有可重放的 source-ready token 或第二次调用接受旧 modules。新增 source-plan 的四仓 checkout 与小 control 传输都计入真实成本，不假称提前启动必然更快。

[小控制入口](../scripts/quality-worker-control.mjs) 用原 plan、control 原字节 SHA 和实际源码校验早期 matrix。worker 仅有界等待同 repo/run/attempt/head/Core 的唯一成功 producer，核 API artifact 唯一 ID 后用 runner 既有 gh 下载到空私有 inbox，并再次核身份；失败、取消、超时、API 错误、缺失/重复/漂移均拒绝。请求和下载受同一单调时限及原 owned cancellation/drain 约束。接收仍完整核原 manifest/binding/tar，final 收齐原 producer indexes，复核早期 control/allocation 与原 catalog 精确一致，source-plan 也列入 required jobs。产物名包含 run_attempt，拒绝旧 attempt；大产物压缩等级1不变。

producer 的 SDK 产物缓存供全部已准入 lane 使用，业务 lane 只决定测试范围。固定源码先核输入，再定位 SDK 输出与恢复缓存；是否可复用仍由原 SDK 身份及字节校验决定，缺失时按原锁准备，损坏或身份漂移直接拒绝。保存使用本次 restore 的原 key，不扩大匹配范围。

包下载缓存仅保留 producer 的 `~/.npm`、`~/.cache/node/corepack` 和固定 Manage pnpm store 恢复/保存，沿原四仓锁 key、恢复前缀和成功 prepare 后的原 `cache-primary-key`。C3i 的 v8 worker restore 加安装未证明净收益，本轮回撤 worker locator/restore；历史观测保留。各 worker 仍按原 manager/锁独立 fresh 安装，缓存不含 `node_modules` 或构建物，也不替代源码/锁/integrity 检查。producer save、所有独立安装和 post 尾部均计入600秒。

[worker 输入入口](../scripts/quality-worker-inputs.mjs) 在同一次活调用中完成提前五锁、有界接收和 GEA 锁安装，保留原配置/源码/锁前后检查。Manage 与 GEA 声明兼容时，可提前用 Manage 自身解析的 `@playwright/test → playwright → playwright-core` 精确 Node bin 运行 Linux `install-deps chromium`；三包完整相对文件字节、模式、内链、bin 在执行前后及 GEA 安装后须相同。只支持当前 Linux 闭包及 Darwin 专用的已知 optional fsevents 声明；版本或已知形状执行前不兼容才明确 deferred 到原晚段，IO/损坏/权限/命令非零/取消或执行后漂移均失败。不会把任意 optional 依赖忽略为通过。

随后仍核 SDK inventory、Workbench 资产和原浏览器门禁。缺物或环境漂移直接拒绝，不回退到编译。原 quality CLI 再走来源、SDK consumer/Web/flock、Workbench/upstream/browser及阶段产物校验，从冻结源码重建 `GEA_TEST_*`；`--stage tests --execution-plan FILE --test-shard ID` 只执行分配的非空片。inputs-ready 不代表质量或测试通过；提前安装与 APT 的净收益仍待 fresh hosted completed。

browser 计划另由 producer 的 `quality-shards --mode prepare-browser --root W` 冻结实际 `/opt/google/chrome` 发行树到 `W/.quality-system-chrome`。快照绑定系统包来源、完整字节/模式/内链清单和真实版本，沿同一 manifest/bundle 运输。 来源root和子目录记录真实普通权限（无特殊位，最多0777），准备物和worker目录统一为0755；sourceRootMode与各目录sourceMode受原摘要绑定，复制中变化仍拒绝。来源root的type/mode/realpath在准备诊断和回执中留证。当前 launch 未启用 setuid sandbox；仅精确 chrome-sandbox 的来源04755记录为准备物0755，其他特殊模式仍拒绝，tar不放宽。worker 先保留原镜像 Chrome 版本观察，再核收到快照并仅在本job新Linux VM只读bind到原系统路径；Chrome channel、严格版本及Chrome/Chromium双launch保持。挂载覆盖测试，job最后 `if: always()` 核快照未改并卸载固定自有挂载；准备、挂载或清理失败均使job失败，无原系统版本或下载fallback。不在开发者本机运行挂载命令。新增发行树体积和准备/下载/挂载/清理墙钟计入下一hosted实测，不能从fixture绿推定600秒通过。

`quality-test-execution-plan.json` 保留完整选择、平台委派、片清单、工具链和输入摘要。tests 与本地默认 full 共用 [执行模块](../scripts/quality-test-execution.mjs)，保存真实 Node reporter 回执并核文件清单严格相等、每个文件只开始/完成一次、case 全通过和 child 退出。结果写 `quality-test-execution.json`，原 reporter JSON 在 `quality-test-results/<executionId>/`。空平台集合明确 not-applicable，不启动 Node 自动发现；重复、缺失、片外文件、失败、取消、skip/todo、signal、非终结或旧输入均拒绝。单片 passed 不能替代完整平台证明。

macOS 对每个 required Core 保留独立原生隔离测试，通过本机 SDK 的 concrete cache roots 恢复准备物并完整校验；不使用 Linux SDK。原测试同样生成真实 Node 机器回执，独立 plan/build 摘要绑定本平台原 candidate、SDK receipt、Node/OS/arch及run/attempt。最终跨平台核同 Core、三仓和锁摘要，保留不同绝对路径形成的各自原输入哈希。

`candidate-quality` 始终汇总小 catalogue 与每片/Mac 回执，不下载大 bundle。它核完整一次执行覆盖，并通过 [hosted budget](../scripts/quality-hosted-budget.mjs) 读取当前 run attempt 的 REST run 和全分页 jobs，分别保存 `coverage.json`、`hosted-budget.json`、`hosted-snapshot.json` 到本轮 `quality-a<attempt>-final` artifact。排队、准备、运输、锁安装、cache save、汇总与上传尾部都属于实际墙钟。门内 in-gate 结果只量到判定时刻，`completedMeasurement:false`；workflow 完成后还须从外部用 completed 模式及原 gateDecision 复核全部 job 和 final 上传尾部，才可声明完整600秒结果。compatibility 使用独立 `compatibility-final` 汇总其原上游状态，不代替 required 验收。

本次仅合入已验证的选择与分片，不新增实验分支的600秒性能硬阻断。原源码准入、静态检查、构建、macOS隔离、逐文件完整覆盖及必需上游状态仍全部阻断；身份或功能状态未知同样拒绝。`hosted-budget.json` 的性能失败或未知保持原样，600秒目标仍待完成，不因功能门禁通过而改记达标。

本地省略 `--stage` 仍完整运行，`--phase` 选择原质量 lane；显式分阶段仍可使用 prepare/build/checks/tests/summary。`--stage verify-tests [--test-results FILE]` 只读核当前执行计划、build摘要和完整平台回执；本地 summary 继续复核实际准备/构建产物。`--test-shards N` 只改变完整集合分组。阶段状态只属于当前 job；本地或 fixture 通过不代表真实 VM、完整 workflow、业务、发布或600秒验收。

`node --test scripts/run-quality-ci-stages.test.mjs` 通过公开 CLI 验证真实临时 Git 输入、跨进程恢复、实际 fixture 测试、失败与取消。独立 checkout 可用 `GEA_FINAL_GROUP_WORKBENCH_SOURCE` 和 `GEA_FINAL_GROUP_MANAGE_SOURCE` 指向本票登记的只读 peer 源码。安装/编译命令使用受控 OS adapter，不安装依赖或构建产品；这些结果不代替远端完整 CI、真实 SDK 编译、Native 或业务验收。

## 异步执行与确定性检查

[`PromptExecutionState`](../src/host/prompt-execution-state.ts) 私有持有工具输出状态、参数快照、grant、执行 lease 与证据 store；[`prompt-runtime`](../src/host/prompt-runtime.ts) 接入真实 Host hooks。迟到的失败、成功和回读视图不进入新轮次或新资源的状态，持久化期间失去归属也不发布当前证据。业务工具权限与页面引用继续由原 admission 状态管理；详细执行条件见 [执行链](execution-logic.md)。

| 检查范围                                  | 现有入口与边界                                                                                                                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 执行元数据、发布与回读政策                | `node --test tests/prompt-execution-policy.test.mjs tests/prompt-execution-tools.test.mjs`；准备本仓依赖与官方rc.2工具，后者使用真实Core Tools、GEA Business、Manage计算器                                                            |
| 执行状态、lease与真实文件 IO 的确定性回归 | `test:prompt-execution` 不要求 SDK 或工程依赖，运行要求从 package.json 的 engines 读取；Host 集成另由 [execution-convergence.test.mjs](../tests/execution-convergence.test.mjs) 在已准备官方依赖的 checkout 覆盖旧错误和资源准入/回读 |
| 三包打包与安装/Loader接收的确定性失败     | `test:delivery:packages` 自建 fixture Core与发布输入，重放历史 APS入口/销售Skill缺失，运行不依赖兄弟仓或现成Core；正式普通profile接收另见 [打包与接收](package-delivery.md)                                                           |
| Window输入拒绝与原行为                    | `test:fixture-inputs` 只核输入；`test:window` 使用明确冻结Core、三仓和历史证据，保留原准入和预算门禁                                                                                                                                  |

上述 Node-only 检查由 [delivery fixture CI](../.github/workflows/delivery-fixtures.yml) 登记。workflow配置、局部检查通过、真实Host集成、当前窗口装载和业务验收分别留证；脚本存在不证明已经运行。

普通文档只有在同组三仓的实际非空差分全为导航或 docs Markdown，且无运行源码或测试消费者时，才进入 docs 范围。source-plan 仍核原候选字节、实际三仓 HEAD、包、锁和 Core，并核差分空白与知识声明；同 tuple 的回执声明构建、测试、Mac 不适用。最终聚合拒绝缺失回执、来源变化、检查失败或被误执行的任务。其他输入继续普通 required-and-affected，不能用 Markdown 扩展名豁免 Prompt、Skill 或业务资源。

桌面可独立执行的现有 CJS/MJS unit 回归进入受影响候选池，已有聚合入口的子测试通过 testOwners 只执行一次。Electron、完整包、真实 Loader 接收及在线更新仍使用各自手动验收入口。`test:full` 明确运行全部顶层源码测试、contract 与 browser 文件；旧 `test:ci-full` 余集入口已退役。该手动入口需要相应用途的完整冻结环境，不能把未准备环境的失败解释为产品失败。

同仓 PR/main 的 delivery 合同归 candidate-quality 精确选择，独立 delivery job 明确跳过，不重复启动 runner 或运行整组 fixture；手动及外仓 PR 仍保留普通离线 fixture 入口。已封存票的 branch/SHA 定向分派及纯路由测试已退役，历史授权和失败证据保持。

Profile 准备在一次调用内复用已准入的 Core 身份与资产摘要，独立资源复制和无 readScope 的文件读取局部并行。每个 case 仍有独立 runtime、配置、selection、窗口、预算、Host、Session 和清理。没有跨 case 授权缓存；源码、锁、外部依赖及接收后的完整性检查仍执行。实际准备、执行、队列和完整600秒测量分别留证。

`installer-timing.test.cjs`、`windows-directory-installer.test.cjs` 与 `installer-differential.test.mjs` 需要显式固定的 GEA_BUILDER_LIB，保留在原手动 desktop unit 入口，不纳入普通候选池。Electron、layered smoke、installer-portability 同样保留实际产物前置，不能用条件 skip 产生源码 CI 通过。

依赖审查只对 PR 中实际消费的 GEA manifest/lock 变化运行，与 Manage 使用同版 dependency-review-action v5 和 high 阻断级别。适用性来自同一实际变化计划并绑定正式 plan，最终聚合在适用时要求成功，无关文档/CSS 的明确不适用不能借用缺失或取消的适用结果。
