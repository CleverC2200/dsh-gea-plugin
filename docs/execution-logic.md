# GEA 身份、资源与执行链

本页按当前 checkout 的源码组织执行入口；工具名、策略常量、预算和配置形状以链接源码为准。页面、资源和持久 Session 的职责从 [README](../README.md) 与各 owner 的现行合同读取；分析发起/业务提单的词义见项目 [共享词汇](../../../../../docs/agents/GLOSSARY.md)。源码存在不证明当前窗口装载、服务端部署或实际业务验收。

## 身份与执行前置

[Business](../src/host/business.ts) 持有唯一 GEA 身份、环境、凭据和登录代际。[client](../src/client.tsx) 发布一个 [只读身份 reader](../src/business-identity-client.ts) 与账户动作；Native、HTML 和账户呈现消费这个投影。读取故障保留最后确认身份，不把未知或读取失败当作主动退出。

[业务身份](../src/host/business-identity.ts) 从 Core Session 实际 preset 与 Manage 当前安装、启用状态重新核业务资源。选中的可信 profile 决定 Consumer 和明确跨 Consumer 路径；Skill 或页面可见不能授予 Consumer。真实业务工具的 `toolConsumer` 要求可信 profile。`sessionConsumer` 在无 profile 时仍读取已绑定非 mock 页面的 Consumer，继而回退 `analysisAgentCode`；Host 模型执行和 Prompt runtime 实际消费这条路径。该接线须与目标资源身份规则继续核迁移边界，不能把页面回退写为已删除。拒权后不能换 Consumer、模型、模块或任意传输绕过。身份变化取消旧请求、失效旧 grant；用户 Core Session、历史与草稿保留。

登录环境只接受 [Host 配置](../src/shared/environments.js) 已登记的名称；client 通过 `businessAccount.startLogin` 将所选名称交给 Host，切环境会清旧二维码、凭据、预览并取消旧身份任务。只读投影同时提供当前环境与可选环境清单，端点/默认值从 [Host Config](../src/host.ts) 和公司产品配置读取，不从浏览器标签推断。

[能力声明](capability-contract.md) 定义模块可用、影响等级与 mock 边界。GEA 使用 Workbench 包登记与 Manage 资源入口，不扫描 HTML SQL、DOM 或 Skill 正文来派生权限。

## 页面与独立查询

| 行为                             | 责任与一手入口                                                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 页面打开、目录、动作、引用与恢复 | 同组 [Workbench 合同](../../dsh-agent-workbench/docs/workbench-contracts.md) 和 [呈现恢复](../../dsh-agent-workbench/docs/presentation-recovery.md)；GEA [HTML adapter](../src/html-plugins.ts) 提供当前业务 grant |
| GEA 模型与业务工具               | [Host 注册](../src/host.ts)、[业务工具](../src/host/agent-tools.ts)；[标准能力边界](business-standard-capabilities.md) 保留官方 general tools 的原策略                                                             |
| Gateway 会话与 MCP               | [统一会话握手](../src/host/gateway-session.ts)、[MCP 传输](../src/host/gateway-mcp.ts)、[MCP client](../src/host/mcp-client.ts)；保留原拒权码、HTTP/JSON 失败、路由与 Consumer 校验                                |
| 受管 SQL                         | [查询入口](../src/host/plugin-query.ts)、[物理额度](../src/shared/sql-read-limit.js)；实际端点和分页计数由源码定义                                                                                                 |
| 证据与取消                       | [MCP 证据](../src/host/mcp-read-evidence.ts)、[隔离取消信号](../src/shared/transport-signal.ts)；保留部分、失败、unknown 与来源范围                                                                                |

独立业务查询不要求先打开页面。页面动作仍只消费当前页面声明；Native 审批与 HTML 只读能力分别按原合同执行。页面的 view 或 draft 回执不等于真实业务保存/审批成功。

`sqlReadLimit` 限定同一 Host 生命周期内对应 Consumer 的物理请求。分页、续期后的再次请求、失败和发出后的取消计数；发出前取消不计数。零额度在登录或委托前拒绝，只开放声明的一个 Consumer，其他 Consumer 直接拒绝；不能换 Consumer 继续使用额度。页数或行数超限拒绝，不截断成完整结果。销售只读自动请求另沿 Business 的 `readonlyValidation` 合同计数；历史剩余额度不授权新窗口。

业务查询/能力额度耗尽后，仍可在独立的12次读取额度内读取已取得证据，官方 standard 工具仍按原授权可用。证据读取额度耗尽则终止当前业务轮的全部工具：最终模型请求不再提供工具，迟到派发也拒绝；保留已展示证据、未读范围和缺口，直接交付结论与未完成项。下一轮重置额度并重新核对当前授权。声明值、窗口额度、记录用量与当前可用授权分别核对，见 [交付核对](delivery-check.md)。

## 异步执行与证据归属

[`PromptExecutionState`](../src/host/prompt-execution-state.ts) 私有持有工具输出、失败/拒权事实、回读视图、执行 lease 与证据 store。[Prompt runtime](../src/host/prompt-runtime.ts) 在实际工具派发前登记执行，派发结束的唯一 post-execute 消费 token；around-dispatch 失败也撤销元数据。原 admission 状态继续管理预算与 UI mask。

轮次、实际preset、Agent状态与store身份epoch决定执行是否仍有效。迟到失败、成功和目录事实只记到原执行；新轮或资源切换后的旧结果不能更新当前状态。原始证据写入之后再次核归属，失去归属时不向当前轮发布回执或投影；文件仍保留。回读重新核原 grant/owner/资源，视图去重也只属于当前有效执行，不由同一个Session地址直接授予。

现有确定性与Host集成检查入口见 [本地检查](local-development.md)。这些实现与fixture不证明当前窗口、真实模型或业务结果已经验收。

## 分析发起与业务提单

| 路径           | 当前实现与条件                                                                                                                                                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 分析发起       | [Host](../src/host.ts) 的 `submit` 接受已核对 preview 与 workbenchContext，沿 Manage 资源和 Core Session 提交分析。它不调用业务提单接口                                                                                                                                |
| 退回重提       | [Business.salesPlanSubmit](../src/host/business.ts) 校验当前有效退回版本、周期、SKU、价格、身份、流程和原正文。当前环境须有租户/用户白名单与可用服务凭据；[service-account](../src/host/service-account.ts) 交换委托后向 `/api/v1/internal/sales-plans` 发送原幂等请求 |
| 首次提单       | 上述退回重提方法要求来源计划与状态 6–9，不提供独立首次提单流程。业务原型或规格中的首次提单合同不等于本方法已接线                                                                                                                                                       |
| 角色审批与纠偏 | [Business.salesPlanAction](../src/host/business.ts) 仍核当前身份、角色、版本、快照、服务端显式契约和原幂等意图；业务定义见 [角色规则 V1.3](../specs/sales-plan-role-approval-v1.3.md) 与 [纠偏规格](../specs/sales-plan-correction.md)                                 |

当前 `salesPlanAction` 还保留未携带 `approvalRole`/`adjustmentMode` 的兼容 SAVE 分支：它拒绝状态 5，其他状态需服务端明确 SAVE 能力、有效版本和快照；它没有单独拒绝状态 10。V1.3 的状态 10 只读目标与该分支的差距仍需原票核实现和部署，不因文档更新视为已退出。

服务凭据留在 Host，配置只存引用。未知重提结果保持原键与原正文，退出或重启后重新回读计划。HTTP 成功还须核有效版本、旧版本失效、节点字段和日志，不等于真实业务验收。角色审批不借用客户重提来生成新版本；通知位置不授予审批角色。

## 通知与日志

[Business.notifications](../src/host/business.ts) 通过固定通知端点读取列表、详情和未读数。读取不自动标已读或审批；显式 `read`、`dismiss`、`batch-read`、`approval-action` 已有 Host 接线，带当前身份、版本与幂等参数，实际权限与事务仍由服务端核对。忽略先核可忽略事实；通知审批桥与销售计划角色动作是独立接口，不将通知状态当销售审批权。通知来源引用不凭格式解释为 Core Session。

[API 日志](../src/host/api-log.ts) 记录真实 Host 上游请求并脱敏。重发按实际目录策略、原身份代际、原正文和原幂等键校验；页面由 Workbench 呈现。日志、成功提示和 mock 回执均不证明完整业务结果。

## 未完成验收与追溯

角色契约、纠偏事务及字段部署、正式 DMS、首次提单、真实模型质量、Windows 和 Native 继续依各票对应环境证据核验。受控 fixture、本地构建与历史发布不完成这些验收。[文档索引](index.md) 保留原风险与证据入口。

[0.0.100 原执行说明](history/current-docs-before-20261010/docs/execution-logic.md) 保留旧自动派生、扫描、页面 Consumer 选择、正式发布流程、失败、未验收项和独特实现理由。原命令、端口与支持矩阵仅供追溯。
