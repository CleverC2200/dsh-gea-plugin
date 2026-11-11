# CI Core 门禁策略

日常源码分片由 `scripts/source-check-shards.mjs` 按完整 Linux 选中集合分配。小集合在一个 worker 内完成准备、构建、检查及测试；达到分片条件时，普通文件与 Profile 文件共用同组 worker，分片不截断覆盖。最终门禁核 HEAD、输入、构建摘要及每个原始执行计划，拒绝缺片、取消、跳过、重复和输入变化。

PR 与 main push 由 `.github/workflows/source-quality.yml` 按实际 Git 差异选择检查。纯说明文档只完成适用性判断与必需状态汇总；包内 Prompt、Skill、资源声明及其资产走资源检查；代码与未知输入保留工程检查。`candidate-quality` 拒绝失败、取消、缺失或非预期跳过的适用检查。工程检查读取固定配套源码，按影响计划准备所需依赖与构建。分类、CLI 和资源检查边界见[共享日常 CI 规则](../../dsh-agent-workbench/docs/ci-required-and-affected.md)。

独立三仓联合验收由 `.github/workflows/quality.yml` 的手动 `workflow_dispatch` 执行，最终检查名为 `joint-quality`，不再作为日常合并条件。手动 alpha compatibility 入口保留。日常绿灯只证明实际选中的源码集合，不能表示完整三仓或客户端验收通过。

## 按需 CI 恢复

Ubuntu source workers 在浏览器依赖安装前，使用 Linux Kernel Archives 与 MIT 的 Ubuntu HTTPS 镜像，保留 Ubuntu 的索引签名校验；索引刷新遇到任何来源错误均失败，并受五分钟步骤预算限制。DNS 解析记录随步骤保存。Playwright 的系统依赖安装和原测试集合保持必需。

失败后使用现有预算 CLI 读取同一 run/head 的完整 attempt 历史，显式请求恢复判断。先在环境中提供只读 `GITHUB_TOKEN`：

```sh
GITHUB_REPOSITORY=CleverC2200/dsh-gea-plugin GITHUB_RUN_ID=<run-id> GITHUB_RUN_ATTEMPT=<attempt> node scripts/quality-hosted-budget.mjs --source-report /absolute/source-report.json --mode completed --retry-plan
```

`recovery.action` 为 `diagnose` 时，先核失败日志、容量诊断或缺失 producer；准备失败和同阶段再次失败均进入此状态。`retry-failed-only` 仅表示首次行为检查失败可考虑只重跑失败项，实际操作仍需本票授权。执行前在同一命令追加 `--request-retry failed`，该准入在诊断、未知或运行未结束时退出非零；`--request-retry all` 一律拒绝。只有准入退出零后才串接既有 `gh run rerun --failed`。该 CLI 只读，不执行重跑或后台轮询，也不能拦截执行者直接调用 GitHub。修复输入或获得能区分故障原因的新证据后，再选择对应的最小验证。进度只报告新失败、诊断、输入变化、完成或待用户动作；作业完成计数不单独触发说明。

依赖策略使用成功 producer 输出的 artifact ID、attempt 和回执摘要。失败项重跑不按 consumer attempt 推算产物名称；固定源码、Core、原锁、管理器、Node、平台、架构和原生依赖内容核验保持。分片汇总另读同一 run 的最新 job 清单，验证每份回执确由对应 attempt 的成功 worker 产生，再逐份核原始计划与精确覆盖。 GitHub 会把复用 job 的 run_attempt 标为新轮次；实际 producer 由原始执行时间、runner、steps 与各 attempt 的完整历史清单一致性确定，不单独相信该字段。失败分片保留独立 attempt 证据，当前分片产物只替换自己的摘要入口。正式输入回执也从实际 source-plan producer 的 attempt 定位。

## 日常计时参考

准备前成本摘要和最终 Markdown 摘要复用选测计划的 `reasons`，按变更展示触发文件数量、Profile 数量及主要测试消费者，并保留准备条件和分片信息。实际规则与直接、传递消费数量读取选择器同次记录的来源元数据。单项触发集合及归并 owner 后的来源类别均可能重叠，不能相加作为总数；旧计划缺来源元数据时保持未知，不推断完整依赖路径。文件数量不代表全部成本，准备要求不证明准备完成，测试计时也不包含准备、构建、调度和收尾。

日常分片上传 `quality-test-results/` 的逐文件报告，失败或取消时保留已有部分报告。完成的同轮全部执行回执可在对应干净 GEA 源码上刷新参考：

```sh
node scripts/quality-test-timings.mjs --plan /absolute/quality-test-execution-plan.json --execution /absolute/worker-1/quality-test-execution.json --execution /absolute/worker-2/quality-test-execution.json --output /absolute/new-timings.json
```

单 worker 只传一次 `--execution`。必须是同一冻结计划的完整成功覆盖，部分或取消结果不能更新参考。输出只用于排程，保留来源、共享源码、包清单和锁文件摘要。日常最终任务另存功能准入和 600 秒预算判断，任务内观察不含后续清理；完整耗时结论需在运行结束后使用 completed 模式核对。核对后更新原 `scripts/quality-test-timings.json`，旧运行和报告保留。

下文描述手动三仓流程及其历史范围，涉及联合合并门禁的旧说明不再适用于日常 PR/main。

当前交付基线为公司 fork 中基于官方 `0.2.0-rc.2` 的欢迎区与工作台 UI 接口候选，配套 Workbench 通过公开接口贡献文案、标题和展开状态。确切提交由下述策略文件固定。此登记只固定源码验证输入，不切换正式客户端或发布频道。阻断与兼容输入统一维护在 `scripts/ci-core-policy.json`；`supported-cores.json` 保留更完整的兼容目录。桌面新装配和启动按同一 required 输入核实际构建；包内携带该策略及支持目录，历史已登记 Core 只用于旧配置证明的升级核对。

手动 `joint-quality` 只运行 required 基线。rc.2 的质量、适用的 Windows 归档及安全检查仍是联合验收条件。最终门禁继续拒绝失败、取消、缺失或跳过的必需任务。

Windows 插件更新原生回归由 [`ci-windows-update.mjs`](../scripts/ci-windows-update.mjs) 按实际 event HEAD 与 base 的完整 diff 判定，覆盖更新 Host/共享实现、安装 fixture、原生入口、依赖锁与工作流。适用时在 `windows-2025` 执行；其他改动在轻量 Linux job 写明确 `not-applicable` 回执。`windows-plugin-update` 始终属于最终聚合依赖和必需 job，失败、取消、缺失或跳过不能放行，不再依赖单次任务分支名。

该原生检查只验证本次源码对固定 GEA 157 unsigned Windows runtime / Core `639ed015397290b3745d163aafe02ffee4aa3f84` 的安装事务行为；下载的安装器原 SHA256、URL 和证据范围集中在上述模块，并在运行回执中保留。它不证明当前 required Core 的联合验收，也不证明桌面 UI、正式签名或发行。当前 Core 的 Linux/macOS 质量仍按原冻结三仓输入独立判定。

`candidate-compatibility` 通过 `workflow_dispatch` 独立运行 alpha，仍使用冻结的三仓完整 SHA 和同一必需检查与受影响测试命令。失败保留在该工作流的日志、产物及结论中。它不作为 required merge context，也不要求它完成或成功后才接收 rc.2。

手动联合验收必须绑定候选组或实际 main 的完整三仓输入，核 rc.2 必需任务和适用的安全检查。按工作流身份单独记录 alpha，不再以“所有 check-run 一律成功”判断。alpha 未运行或失败不能记成兼容通过；只凭任务名包含 alpha 也不能豁免其他检查。

原策略只调整 CI 接收范围。本次插件设置工作将 required 输入改为用户授权的公司 fork 候选；官方上游与旧私有候选仍保留各自来源，不能互相替代验收。业务断言、预算与最终门禁保持。在途运行仍按原双 Core 定义解释。将策略应用到重新审查并冻结的输入组后，分别核验候选组和合并后的实际 main。

GitHub 全量集合的停用、受影响选择与缓存规则见[当前 CI 规则](../../dsh-agent-workbench/docs/ci-required-and-affected.md)。Core 的 required/compatibility 范围保持本页定义。

2026-10-14 的 [PR 59](https://github.com/CleverC2200/dsh-gea-plugin/pull/59) 曾按固定产品提交 `99067baee958a2260ef3735c6b82818253e4906b` 使用单票定向接收例外。该 PR 已合并，本轮统一选择入口替代其临时路由。后续 PR、main 与手动兼容运行均不恢复 GitHub 全量集合；更新事务、签名来源、包版本及公共 Loader 测试按实际改动选择，业务断言保持原样。

普通文档范围由同组 Workbench 的实际影响选择器判定。只有非空且无运行或测试消费者的导航/docs Markdown 差分才不准备 SDK、不构建及不跑 Mac；来源、差分空白、知识和绑定同 tuple 的明确不适用回执仍是最终条件。源码范围继续必需检查和精确一次执行覆盖。

以下单票例外仅保留历史授权、冻结输入和原失败记录。对应的当前可执行 branch/SHA 分派与纯授权路由测试已经退役，后续候选统一走普通受影响选择，不再使用历史阶段例外。

## Frozen business repair exception

The user authorized merging the 2026-10-14 business repair group without full tests. The `business-profile` lane is limited to the reviewed product commits declared in [原 business-profile-ci 实现](https://github.com/CleverC2200/dsh-gea-plugin/blob/25860b5d73fca73238acc6365c33e848bacaa905/scripts/business-profile-ci.mjs), plus the listed CI and evidence files. It validates all three actual source checkouts against those commits. A different product source rejects this lane; other PR branches keep the normal gates. Same-tree main and explicit main dispatch can use the targeted lane. The existing final aggregate still rejects failed, cancelled, skipped or missing jobs, and branch protection is unchanged.

Targeted checks retain static gates and builds. Workbench runs the new-conversation/inventory/company/version cases and the sidebar browser file. Manage runs business resources, raw MCP scope, bundled tools and the real Core business-admission file; existing Windows archive and security lanes remain. GEA runs reasoning, history, identity/budgets, Cube-New, HTTP errors and plugin-update regressions. This is source acceptance, not real model, business, Native or release acceptance. The separate CI optimization and new query direct-return work are excluded.

## PR 63 MCP client acceptance

The user explicitly approved targeted acceptance and merge after the original required-and-affected run selected retired desktop/package and business-tool tests with failures. The original run 38572409432 and its raw gate log remain failure evidence; it is not a passing full-suite result.

`mcp-client-repair` accepts only PR 63's same-repository branch and the exact three product commits in `mcpClientSources`, followed by the existing CI/evidence allowlist. Each actual checkout and HEAD is verified. A source change, fork or different PR branch rejects the exception; same-source main and explicit main dispatch can validate the merged tree. The rc.2 final aggregate, static checks, builds and main protection remain required.

The selected tests cover direct structured/text results, historical resource integrity, paging and numeric precision, malformed response stopping, identity/Consumer admission, cancellation, Host settings and the exception's rejection cases. Runtime/browser and the historical full-suite failures remain outside this single-ticket acceptance; installed-client and real MCP evidence belongs to the earlier 0.0.144 candidate.

冻结来源与历史例外统一由同组 Workbench 的 `scripts/ci-source-policy.mjs` 维护；本仓只适配已登记的事件与原 MCP 修复角色。workflow 先取得固定 Workbench 源码，联合 runner 读取 tuple 中的实际路径。例外分支、来源 SHA、路径范围和 required Core 均未扩张。

## PR 75 知识接入阶段例外

用户在本聊天明确要求“跳过这个200的校验”，仅放行知识接入 PR 75 的源码合并。原205文件运行保留取消记录，不记为通过。`knowledge-merge` 保留固定rc.2、三仓原字节准入、静态检查、构建、macOS隔离、知识/网关/身份/预算/Cube定向测试及原最终聚合，main保护不变。

本次产品源码固定为 GEA `60c9ce95b883485c79d77c6cb855ae4735d288e1`、Workbench `29d851d71bdbe4c490a246ab20447c76c19ae957`、Manage `307303d5532f4250879008573b329cf4bb202ff3`。GEA只允许本例外的五个CI及说明文件作为后续补充，实际HEAD或其它产品文件变化均拒绝。选择器只接收同仓PR75的原分支，以及从原main直接合并该树的一次main事件；其它PR、后续main提交和手动运行回到普通流程。完整205文件选择、最终安装客户端、知识迁移、上游正文完整性及正式发行仍待验。

## PR 76 插件更新定向接收

用户于 2026-10-16 明确要求只跑本次插件更新必要的定向校验，不跑原 181 文件集合。`plugin-update-pr` 仅接收 PR 76 的固定产品提交 b9e8008、固定三仓与列出的 CI/文档补充；额外产品修改、fork、其他分支或不匹配来源拒绝。仅该树的直接普通合并可复用本次范围，后续 main 与 dispatch 返回原路径。

范围固定为更新控制器、签名及防回退、真实安装锁、浏览器详情页、构建及包版本、账户接线、快速知识库/Gateway 回归和定向路由的拒绝检查。保留原静态检查、构建、macOS 隔离及最终聚合；分支保护保持。原运行 38831523874 按用户要求取消，不能记为通过。定向源码接收不代表 OSS 或当前客户端更新验收。

## PR 80 完整桌面首次安装

用户要求仅跑四插件首次安装、品牌与登录接线、基地库存新资源影响的校验。固定产品提交 `28767e17a547110095cffcac181f9940ade74b74`；来源、分支、三仓产品输入及 CI 补充白名单由 `desktopBootstrapAuthorization` 定义，不匹配输入拒绝。GEA 定向六文件覆盖初始化、品牌、账户与多技能装配、严格配套版本及路由拒绝条件；Workbench/Manage 沿既有 required-and-affected。静态检查、构建、macOS 隔离和原最终聚合保持必需，分支保护不变。Mac/Windows 包和真实公司登录另行验收，源码 CI 不代替客户端结论。原运行 38857068175 的格式失败保留，不重跑旧输入。

## 同基线桌面更新证明刷新

完整包在旧配置上补齐实际 App 的更新证明，固定产品提交 `3ead615b946d5a18bdf8be3d1bdfba52a337e920`，来源及范围仍由 `desktopBootstrapAuthorization` 约束。沿用上述六文件定向集合与全部必需门禁；仅承认原 rc.2/639ed 基线，保留配置、WeKnora 和历史回执。原 PR 80 及其 CI 通过记录保留。

## Windows ASAR 路径补修

产品固定 `f0fae2cef4234381f0ac1ff69c757567ecfc99de`，仅将封包读取路径转换为本机分隔符。定向执行品牌测试与范围准入测试两个文件；三仓冻结、静态检查、构建、macOS 隔离及最终聚合保持必需。Mac 与插件包内容不变，复用已通过证据；Windows 新输入单独构建验收。

## 正式 Cube 157 配置补修

产品固定 `f75eeab0e5fd4ac0e7d795d2e854f4d6cf1a5cb3`，仅登记用户确认的正式 Cube 来源 `MCP:mcp.cube`，保留测试编码并升版。定向七文件覆盖来源准入与请求路由、WeKnora、包版本及发行声明；三仓冻结、静态检查、构建、macOS 隔离及最终聚合保持必需。没有修改 Core、业务授权或未知来源拒绝规则。在线更新由用户从正式详情页操作，源码定向通过不等于真实业务验收。

## Windows 157 安装缓存补修

固定产品 `dd8ceb412afcaac2de8a3a9f57fd32286b648c5f`，复用已通过 Mac 隔离与当前 profile 联合安装的缓存修补。Windows 157 完整包也沿用旧 profile 的缓存，未知或部分安装仍拒绝，失败回执保留。定向三个文件仅检查初始化、品牌封包与来源准入；其他必需门禁和 Core 保持，插件157归档复用正式已发字节。
