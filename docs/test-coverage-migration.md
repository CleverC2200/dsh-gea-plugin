# 端到端测试首批分层与覆盖对应

原清单来自 GEA PR #225 的 109 个 Profile 依赖文件、290 项测试。此表登记首批去向；参数化场景和公共夹具断言的完整本地索引由本票保留。未列为迁移的场景全部继续原链路。

## 首批变化

| 原文件                               | 目标与验证行为                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `tests/progress-column-web.test.mjs` | 真实浏览器：生产进度列、百分比与红橙绿阈值；保留所有原展示断言                                                |
| `tests/variance-color-web.test.mjs`  | 真实浏览器：正负差额、普通指标字色、短金额与精确 title；保留所有原展示断言                                    |
| `tests/action-errors.test.mjs`       | 真实 Business.salesPlanAction + errorEnvelope：权限 / 角色 / 当前版本 / workflow 仍生产执行，只替换外部 fetch |

原身份、Session、页面动作、保存/重提回读、装载/更新/恢复测试保留。页面测试采用真实 React 页面、生产样式和现有 WorkbenchHostProvider；每例新 Context 与本地 HTTP 服务，同文件只共享不可变 bundle 和 Browser。外部响应是固定样本，不作为权限验证结果。

## 并行执行

source-quality 的联合检查按 Profile 与其他文件数量动态分片，最多 16 个 job，单 job 资源和文件并发不变。适用集合少于两文件保持单 job；分片编号、总数、冻结输入、完整执行回执及汇总必须一致。40 个并发额度为账号共享额度，不保证本次同时获得全部位置。

## 原 109 文件对应

| 原文件                                              | 原 CI 测试项 | 当前去向                                                                                                      |
| --------------------------------------------------- | -----------: | ------------------------------------------------------------------------------------------------------------- |
| `tests/returned-resubmit-web.test.mjs`              |           17 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/source-update-web.test.mjs`                  |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/native-page-identity-web.test.mjs`           |            6 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/branch-stock-web.test.mjs`                   |            6 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/branch-stock-lifecycle-web.test.mjs`         |            6 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/returned-review-reject-web.test.mjs`         |            4 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/returned-review-roles-web.test.mjs`          |            4 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/prompt-qa-regression.test.mjs`               |           17 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/page-reference-columns-web.test.mjs`         |            4 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/page-reference-identity-web.test.mjs`        |            4 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/role-approval-host.test.mjs`                 |            4 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/branch-stock-upgrade-web.test.mjs`           |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/group-selection-web.test.mjs`                |            3 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/branch-stock-export-context.test.mjs`        |            3 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/approval-draft-web.test.mjs`                 |            3 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/variance-color-web.test.mjs`                 |            3 | 真实浏览器：正负差额、普通指标字色、短金额与精确 title；保留所有原展示断言                                    |
| `tests/auth.test.mjs`                               |            4 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/workbench-host.test.mjs`                     |           10 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/agent-tools.test.mjs`                        |           24 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/correction-web.test.mjs`                     |            2 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/receipt.test.mjs`                            |            2 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/page-interaction-web.test.mjs`               |            2 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/pending-adjustments-web.test.mjs`            |            2 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/reject-dialog-close-web.test.mjs`            |            2 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/logout.test.mjs`                             |            2 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/model.test.mjs`                              |            2 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/branch-stock-ability-web.test.mjs`           |            2 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/read-paging.test.mjs`                        |            2 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/prompt-v2.test.mjs`                          |           13 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/save-host.test.mjs`                          |            2 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/evidence-budget-stop.test.mjs`               |            2 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/approval-notification-decoupled.test.mjs`    |            2 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/draft-host.test.mjs`                         |            2 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/workflow-config.test.mjs`                    |            7 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/notifications.test.mjs`                      |           10 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/v16-visual.test.mjs`                         |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/gea-reasoning-profile.test.mjs`              |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/gea-reasoning-effort.test.mjs`               |            4 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/page-interaction-workbenches.test.mjs`       |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/client-shell-feedback.test.mjs`              |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/v16-web.test.mjs`                            |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/web.test.mjs`                                |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/html-shared-theme-web.test.mjs`              |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/approval-visibility-web.test.mjs`            |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/sidebar-source-web.test.mjs`                 |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/batch-province-outcome-web.test.mjs`         |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/shared-theme-source-web.test.mjs`            |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/split-declarations-web.test.mjs`             |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/lifecycle.test.mjs`                          |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/composer-stats-placement.test.mjs`           |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/genui-source-web.test.mjs`                   |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/category-plan-page.test.mjs`                 |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/resubmit-web.test.mjs`                       |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/composer-stats-web.test.mjs`                 |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/mps-plan-page.test.mjs`                      |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/correction-resubmit-web.test.mjs`            |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/page-reference-reload-web.test.mjs`          |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/role-visible-permission-web.test.mjs`        |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/native-status-projection-web.test.mjs`       |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/stage-lane-web.test.mjs`                     |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/approval-roles-refresh-web.test.mjs`         |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/workbench-status-identity-race-web.test.mjs` |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/progress-column-web.test.mjs`                |            1 | 真实浏览器：生产进度列、百分比与红橙绿阈值；保留所有原展示断言                                                |
| `tests/current-startup-web.test.mjs`                |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/sales-result-runtime.test.mjs`               |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/action-error-copy-web.test.mjs`              |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/month-aggregation-context-web.test.mjs`      |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/inline-draft-status-web.test.mjs`            |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/approval-batch-selection-web.test.mjs`       |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/branch-stock-identity-owner-web.test.mjs`    |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/settings-nav-order-web.test.mjs`             |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/stage-progress-detail-web.test.mjs`          |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/global-identity-error-web.test.mjs`          |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/partial-evidence.test.mjs`                   |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/detail-summary-web.test.mjs`                 |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/gea-model.test.mjs`                          |           10 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/html-identity-discovery-web.test.mjs`        |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/branch-stock-context-text.test.mjs`          |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/save-web.test.mjs`                           |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/workbench-boot.test.mjs`                     |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/verify-workbench.test.mjs`                   |            4 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/api-log-web.test.mjs`                        |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/html-self-report-web.test.mjs`               |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/authorized-cube-loop.test.mjs`               |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/regional-plan-page.test.mjs`                 |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/native-reference-authority.test.mjs`         |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/html-plugin-public-resources.test.mjs`       |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/details.test.mjs`                            |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/gea-model-identity.test.mjs`                 |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/aps-sql-consumer.test.mjs`                   |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/detail-budget.test.mjs`                      |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/mcp-evidence-loop.test.mjs`                  |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/selection.test.mjs`                          |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/resubmit-host.test.mjs`                      |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/branch-stock-agent.test.mjs`                 |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/approval-permissions.test.mjs`               |            2 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/safety-stock-prompt.test.mjs`                |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/sales-readonly-host.test.mjs`                |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/dealer-prompt.test.mjs`                      |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/environments.test.mjs`                       |            4 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/action-errors.test.mjs`                      |            1 | 真实 Business.salesPlanAction + errorEnvelope：权限 / 角色 / 当前版本 / workflow 仍生产执行，只替换外部 fetch |
| `tests/plugin-sql-delegation-expiry.test.mjs`       |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/profile-lifecycle.test.mjs`                  |            2 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/shared-theme-native-web.test.mjs`            |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/core-default-slots-web.test.mjs`             |            1 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/profile-before-start-cleanup.test.mjs`       |            4 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/profile-cube-boundary.test.mjs`              |            3 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/catalog-scene-input.test.mjs`                |            5 | 保留原场景及断言；尚未迁移                                                                                    |
| `tests/receipt-classification.test.mjs`             |            8 | 保留原场景及断言；尚未迁移                                                                                    |

## 验证与性能边界

逐项断言、参数化输入、公共 fixture 及跨层代表共同核对。隔离用例覆盖前例成功、失败、取消和浏览器关闭后，下一例 cookie、localStorage、sessionStorage、window 状态与业务数据仍独立。

性能比较绑定同一组产品源码、Core、Node、浏览器、机器与并发条件。首批分层收益与增加 job 的整轮墙钟变化分别记录；同时报告累计 runner 分钟和缓存状态。无固定十分钟完成门槛；原超时和取消保护保留。完整运行未完成或输入不可比时，不宣称整轮提速。
