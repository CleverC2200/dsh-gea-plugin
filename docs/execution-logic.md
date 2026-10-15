# GEA 身份、资源与执行链

本页按当前 checkout 的源码组织执行入口；工具名、策略常量、预算和配置形状以链接源码为准。页面、资源和持久 Session 的职责从 [README](../README.md) 与各 owner 的现行合同读取。在插件拆分项目中核分析发起/业务提单时，读该项目根的 `docs/agents/GLOSSARY.md`。源码存在不证明当前窗口装载、服务端部署或实际业务验收。

## 身份与执行前置

[Business](../src/host/business.ts) 持有唯一 GEA 身份、环境、凭据和登录代际。[client](../src/client.tsx) 发布一个 [只读身份 reader](../src/business-identity-client.ts) 与账户动作；Native、HTML 和账户呈现消费这个投影。读取故障保留最后确认身份，不把未知或读取失败当作主动退出。

[业务身份](../src/host/business-identity.ts) 从 Core Session 实际 preset 与 Manage 当前安装、启用状态重新核业务资源。选中的可信 profile 决定 Consumer 和明确跨 Consumer 路径；Skill 或页面可见不能授予 Consumer。真实业务工具的 `toolConsumer` 要求可信 profile。`sessionConsumer` 在无可信 profile 时使用 `analysisAgentCode` 作为普通模型默认路由；页面 Consumer 不改变模型身份。Host 模型执行和 Prompt runtime 消费同一选择，普通 Session 的业务工具仍由 `toolConsumer` 拒绝。拒权后不能换 Consumer、模型、模块或任意传输绕过。身份变化取消旧请求、失效旧 grant；用户 Core Session、历史与草稿保留。

登录环境只接受 [Host 配置](../src/shared/environments.js) 已登记的名称；client 通过 `businessAccount.startLogin` 将所选名称交给 Host，切环境会清旧二维码、凭据、预览并取消旧身份任务。只读投影同时提供当前环境与可选环境清单，端点/默认值从 [Host Config](../src/host.ts) 和公司产品配置读取，不从浏览器标签推断。

[能力声明](capability-contract.md) 定义模块可用、影响等级与 mock 边界。GEA 使用 Workbench 包登记与 Manage 资源入口，不扫描 HTML SQL、DOM 或 Skill 正文来派生权限。

[GatewayRequests](../src/host/gateway-requests.ts) 集中 GEA envelope 请求的身份代际、取消、超时、请求标识与读取处理。Business 保留登录权威和精确数字解析；模型凭据、通知与审批保留各自错误码，Gateway MCP 握手继续按独立协议校验。请求结束及正文读取后重新核原身份，旧身份迟到的 401 不得清除新登录；取消和超时分别报告，不包装成网络失败。

## 页面与独立查询

| 行为                             | 责任与一手入口                                                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 页面打开、目录、动作、引用与恢复 | 同组 [Workbench 合同](../../dsh-agent-workbench/docs/workbench-contracts.md) 和 [呈现恢复](../../dsh-agent-workbench/docs/presentation-recovery.md)；GEA [HTML adapter](../src/html-plugins.ts) 提供当前业务 grant |
| GEA 模型与业务工具               | [Host 注册](../src/host.ts)、[业务工具](../src/host/agent-tools.ts)；[标准能力边界](business-standard-capabilities.md) 保留官方 general tools 的原策略                                                             |
| Gateway 会话与 MCP               | [统一会话握手](../src/host/gateway-session.ts)、[MCP 传输](../src/host/gateway-mcp.ts)、[Cube-New client](../src/host/cube-mcp-client.ts)；保留原拒权码、HTTP/JSON 失败、路由与 Consumer 校验                      |
| 受管 SQL                         | [查询入口](../src/host/plugin-query.ts)、[物理额度](../src/shared/sql-read-limit.js)；实际端点和分页计数由源码定义                                                                                                 |
| 证据与取消                       | [MCP 证据](../src/host/mcp-read-evidence.ts)、[隔离取消信号](../src/shared/transport-signal.ts)；保留部分、失败、unknown 与来源范围                                                                                |

独立业务查询不要求先打开页面。页面动作仍只消费当前页面声明；Native 审批与 HTML 只读能力分别按原合同执行。页面的 view 或 draft 回执不等于真实业务保存/审批成功。

Native 页面授权与当前页面身份投影属于同一个 grant。打开时建立投影，当前 owner 上报可见上下文时刷新，关闭或身份撤销时释放；旧 owner 的刷新和释放不能覆盖新页面。模型只获得该页面声明的动作工具，Native 使用 `gea_workbench_apply`，HTML lease 使用 `gea_page` 读取，以及目录声明的 `gea_plugin_page_apply` 视图动作。没有页面绑定时，`gea_visible_workbench_context` 返回安全的不可用说明，不推断页面或数字。

Cube-New 的来源由 Host `cubeMcpCodes` 按环境指定。公司默认仅登记测试环境编码 `2109581866385289217`；正式环境未登记新来源时不开放查询，也不回退旧 Cube。GEA 登录、业务页面和持久会话继续保留。

Manage 只注册当前登录授权列表中的 `inspect_cube_model` 和 `query_business_data`，使用服务端原始 schema。GEA 根据发起调用的真实 Core Session preset 选择 Consumer，每次调用重新校验身份、业务资源与执行归属；业务 arguments 不能指定身份或路由。旧 `gea_gateway_catalog`、`gea_cube_query`、`gea_module_mcp` 不再注册，旧成员索引、查询拆分、修参和结果分段适配退出运行时，历史回归材料留在 `tests/fixtures/retired-query`。

`inspect_cube_model` 返回服务端原始说明，包括 View 的 `aliasMember`。客户端不再二次投影目录或替服务端判断成员发布。`query_business_data` 原样传递 `action=query`、`response_mode=inline_complete` 和具名查询；业务参数及容量约束来自当前 `tools/list` Schema，不写死旧的8条/1000行上限，也不补默认 limit。

查询入口检查度量、维度、时间、分段、嵌套筛选和排序的成员引用是否带完整前缀。裸字段在发送业务请求前返回 `GEA_CUBE_QUERY_MEMBER_REQUIRED`，提示按实际 `aliasMember` 修正；客户端不补前缀或推定 View 映射，成员存在性与授权仍由服务端判断。响应合同失败保留 `GEA_CUBE_NEW_*` 错误码，列出不符合约定的字段，按当前会话停止本轮查询。

查询优先消费本次响应的 `structuredContent`；只有文本能力时选择一份业务 JSON，不拼接说明文本，也不合并两份 rows。直返路径不调用 `resources/read`，不要求 URI、有效期或制品 SHA。原始金额、大整数、编码字符串、null和零值保持；结构化结果再序列化时保留原始数字词法形式。

当前客户端按实际交付路径校验。直返必须具备与请求对应的具名数据集、执行数、`rows`、一致的 `rowCount`、列声明和数据状态；`offset/totalRowCount/hasMorePages` 必须存在并相互一致。直返允许缺少旧交付标记 `complete/hasMore`，保留原始缺省，不补为 true/false。标记存在时必须为 `complete=true/hasMore=false`，显式截断或无效标记仍拒绝；`deliveryMode` 或拿到 rows 单独不足以证明结果有效。

`hasMorePages=true` 保留业务未读范围，下一页仍执行查询，保持原过滤条件和稳定排序。`partial` 和 `no_data` 保留原状态，不能据此补零或宣称全量。灰度时仅在实际收到旧 `resource_link` 且没有直返业务结果时，沿原业务及传输 Session 读取，并核 URI、类型、原始摘要及原完整性标记 `complete=true/hasMore=false`；不猜存储地址，也不对旧制品放宽完整性要求。该直返适配对应 2026-10-14 的客户端修复请求和 Native 回包，替代接入说明中对所有交付方式统一必填旧标记的要求。

MCP 查询默认超时300秒，显式 `mcpRequestTimeoutMs` 优先。`mcpMaxResponseBytes` 默认320 MiB，按解码后的 UTF-8 报文字节计量，覆盖结构化对象及转义文本的双份承载；这是客户端接收预算，不是服务端额度或完整100 MiB业务验收保证。读取期间超限即停止，取消仍遵循原身份代际。日志正文仍受独立4 MiB上限保护。

错误先于业务数据解析。保留服务端 `code/category/retryable/suggestedAction/retryAfterMs` 及请求/审计标识；`AI_GATEWAY_MCP_RESULT_TOO_LARGE` 要求缩小查询、减少列或分页，即使返回retryable也不原样重试，不回退 OSS。成员未发布、拒权或过期仍沿原失败与会话保护。接入依据为2026-10-14《GEA MCP 查询结果直返：调用方适配说明》，它替代前一天关于固定制品交付的说明；真实环境部署和业务联调另行确认。

`sqlReadLimit` 限定同一 Host 生命周期内对应 Consumer 的物理请求。分页、续期后的再次请求、失败和发出后的取消计数；发出前取消不计数。零额度在登录或委托前拒绝，只开放声明的一个 Consumer，其他 Consumer 直接拒绝；不能换 Consumer 继续使用额度。页数或行数超限拒绝，不截断成完整结果。销售只读自动请求另沿 Business 的 `readonlyValidation` 合同计数；历史剩余额度不授权新窗口。

业务查询/能力额度耗尽后，仍可在独立的12次读取额度内读取已取得证据，官方 standard 工具仍按原授权可用。证据读取额度耗尽则终止当前业务轮的全部工具：最终模型请求不再提供工具，迟到派发也拒绝；保留已展示证据、未读范围和缺口，直接交付结论与未完成项。下一轮重置额度并重新核对当前授权。声明值、窗口额度、记录用量与当前可用授权分别核对，见 [交付核对](delivery-check.md)。

## 异步执行与证据归属

[`PromptExecutionState`](../src/host/prompt-execution-state.ts) 私有持有工具输出、失败/拒权事实、回读视图、执行 lease 与证据 store，并在同一个 lease 内保存调用参数快照与准入 grant。[Prompt runtime](../src/host/prompt-runtime.ts) 在实际工具派发前登记执行，派发结束的唯一 post-execute 消费 token；around-dispatch 失败也撤销元数据。hooks 只转交执行句柄、Core 结果与后续 policy 决定；State 的 `finish` 与 `read` 集中结果发布、来源复核和回读投影，runtime 不再配对另一份 grant Map。原 admission 状态继续管理预算与 UI mask。

轮次、实际preset、Agent状态与store身份epoch决定执行是否仍有效。迟到失败、成功和目录事实只记到原执行；新轮或资源切换后的旧结果不能更新当前状态。原始证据写入之后再次核归属，失去归属时不向当前轮发布回执或投影；文件仍保留。回读重新核原 grant/owner/资源，视图去重也只属于当前有效执行，不由同一个Session地址直接授予。

旧磁盘证据在30分钟有效期内仍可按原grant回读：旧MCP记录必须重核确切Consumer、资源工具与资源快照，缺少授权收据就拒绝。当前原生MCP结果不进入此证据发布路径，不产生新的旧式MCP grant。

现有确定性与Host集成检查入口见 [本地检查](local-development.md)。这些实现与fixture不证明当前窗口、真实模型或业务结果已经验收。

## 分析发起与业务提单

| 路径           | 当前实现与条件                                                                                                                                                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 分析发起       | [Host](../src/host.ts) 的 `submit` 接受已核对 preview 与 workbenchContext，沿 Manage 资源和 Core Session 提交分析。它不调用业务提单接口                                                                                                                                |
| 退回重提       | [Business.salesPlanSubmit](../src/host/business.ts) 校验当前有效退回版本、周期、SKU、价格、身份、流程和原正文。当前环境须有租户/用户白名单与可用服务凭据；[service-account](../src/host/service-account.ts) 交换委托后向 `/api/v1/internal/sales-plans` 发送原幂等请求 |
| 首次提单       | 上述退回重提方法要求来源计划与状态 6–9，不提供独立首次提单流程。业务原型或规格中的首次提单合同不等于本方法已接线                                                                                                                                                       |
| 角色审批与纠偏 | [Business.salesPlanAction](../src/host/business.ts) 仍核当前身份、角色、版本、快照、服务端显式契约和原幂等意图；业务定义见 [角色规则 V1.3](../specs/sales-plan-role-approval-v1.3.md) 与 [纠偏规格](../specs/sales-plan-correction.md)                                 |

`salesPlanAction` 的 SAVE 与审批共用当前状态、有效版本和来源校验，只接受明确 `approvalRole` 或 `adjustmentMode` 的请求。0、5、10 和历史版本均拒绝写入；无角色、无调整模式的兼容 SAVE 已删除。合法角色 SAVE 仍核当前角色、服务端契约和快照，并保留原幂等意图。源码规则不证明服务端 V1.3 已部署或真实业务验收通过。

[`SalesPlanTransactions`](../src/host/sales-plan-transactions.ts) 持有本次登录内的重提与审批意图、已验证原正文、在途请求和回执。Business 保留公开写入口与登录权威，只借出当前身份、环境地址、身份取消信号和现有查询能力；退出或切换身份清空事务状态。意图登记时复制调用参数，校验、幂等指纹与发送正文使用同一快照；结果未知时只允许原键原正文重试。审批迟到的401或成功回执不能登出新身份或替换其回执。

服务凭据留在 Host，配置只存引用。未知重提结果保持原键与原正文，退出或重启后重新回读计划。HTTP 成功还须核有效版本、旧版本失效、节点字段和日志，不等于真实业务验收。角色审批不借用客户重提来生成新版本；通知位置不授予审批角色。

## 通知与日志

[Business.notifications](../src/host/business.ts) 通过固定通知端点读取列表、详情和未读数。读取不自动标已读或审批；显式 `read`、`dismiss`、`batch-read`、`approval-action` 已有 Host 接线，带当前身份、版本与幂等参数，实际权限与事务仍由服务端核对。忽略先核可忽略事实；通知审批桥与销售计划角色动作是独立接口，不将通知状态当销售审批权。通知来源引用不凭格式解释为 Core Session。

[API 日志](../src/host/api-log.ts) 记录真实 Host 上游请求并脱敏，模型请求／响应正文不保存。重发按实际目录策略、原身份代际、原正文和原幂等键校验；页面由 Workbench 呈现。[批量执行器](../src/host/api-log-batch.ts) 固定样本串行执行，逐条确认写记录，样本丢失或失效时跳过。单次与批量共用[调试互斥](../src/host/debug-run.ts)，不串行化普通业务请求。运行、日志来源及读取绑定 Host 身份代际；停止、离页和身份失效取消所属执行，已发送写请求保留结果未知。进程内保留最近20个结束批次。日志、成功提示和 mock 回执均不证明完整业务结果。

## 未完成验收与追溯

角色契约、纠偏事务及字段部署、正式 DMS、首次提单、真实模型质量、Windows 和 Native 继续依各票对应环境证据核验。受控 fixture、本地构建与历史发布不完成这些验收。[文档索引](index.md) 保留原风险与证据入口。

[0.0.100 原执行说明](history/current-docs-before-20261010/docs/execution-logic.md) 保留旧自动派生、扫描、页面 Consumer 选择、正式发布流程、失败、未验收项和独特实现理由。原命令、端口与支持矩阵仅供追溯。
