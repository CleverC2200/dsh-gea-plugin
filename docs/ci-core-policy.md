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
