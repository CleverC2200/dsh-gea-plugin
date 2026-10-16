# CI Core 门禁策略

当前交付基线固定为 Core `0.2.0-rc.2`。阻断与兼容输入统一维护在 `scripts/ci-core-policy.json`；`supported-cores.json` 保留更完整的兼容目录。

`candidate-quality` 只运行 required 基线。rc.2 的质量、适用的 Windows 归档及安全检查仍是合并条件。最终门禁继续拒绝失败、取消、缺失或跳过的必需任务。

`candidate-compatibility` 通过 `workflow_dispatch` 独立运行 alpha，仍使用冻结的三仓完整 SHA 和同一必需检查与受影响测试命令。失败保留在该工作流的日志、产物及结论中。它不作为 required merge context，也不要求它完成或成功后才接收 rc.2。

合并核验必须绑定候选组或实际 main 的完整三仓输入，核 rc.2 必需任务和适用的安全检查。按工作流身份单独记录 alpha，不再以“所有 check-run 一律成功”判断。alpha 未运行或失败不能记成兼容通过；只凭任务名包含 alpha 也不能豁免其他检查。

本次只调整 CI 接收范围。插件包版本、锁文件、业务断言、预算、Core 源码及私有 Core 的验收范围保持原约定。在途运行仍按原双 Core 定义解释。将策略应用到重新审查并冻结的输入组后，分别核验候选组和合并后的实际 main。

GitHub 全量集合的停用、受影响选择与缓存规则见[当前 CI 规则](../../dsh-agent-workbench/docs/ci-required-and-affected.md)。Core 的 required/compatibility 范围保持本页定义。

2026-10-14 的 [PR 59](https://github.com/CleverC2200/dsh-gea-plugin/pull/59) 曾按固定产品提交 `99067baee958a2260ef3735c6b82818253e4906b` 使用单票定向接收例外。该 PR 已合并，本轮统一选择入口替代其临时路由。后续 PR、main 与手动兼容运行均不恢复 GitHub 全量集合；更新事务、签名来源、包版本及公共 Loader 测试按实际改动选择，业务断言保持原样。

## Frozen business repair exception

The user authorized merging the 2026-10-14 business repair group without full tests. The `business-profile` lane is limited to the reviewed product commits declared in `scripts/business-profile-ci.mjs`, plus the listed CI and evidence files. It validates all three actual source checkouts against those commits. A different product source rejects this lane; other PR branches keep the normal gates. Same-tree main and explicit main dispatch can use the targeted lane. The existing final aggregate still rejects failed, cancelled, skipped or missing jobs, and branch protection is unchanged.

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

产品固定 `8299eb35752dca9f3bcbb6b8daa9e3dd6098ad28`，仅登记用户确认的正式 Cube 来源 `MCP:mcp.cube`，保留测试编码并升版。定向七文件覆盖来源准入与请求路由、WeKnora、包版本及发行声明；三仓冻结、静态检查、构建、macOS 隔离及最终聚合保持必需。没有修改 Core、业务授权或未知来源拒绝规则。在线更新由用户从正式详情页操作，源码定向通过不等于真实业务验收。
