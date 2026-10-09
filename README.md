# GEA 身份与受控执行插件

当前候选、固定 Core 和同组 checkout 从项目根 `docs/agents/current-development.md` 引用的任务 `integration-set.json` 读取。输入检查仅证明候选，当前选择和实际装载须有对应窗口回执。

| module | 当前职责与入口 |
|---|---|
| GEA Host | [Host 入口](src/host.ts)、[业务执行](src/host/business.ts) 持有唯一 GEA 身份、凭据、Consumer 授权、业务规则和执行额度 |
| GEA client | [客户端入口](src/client.tsx)、[身份读取](src/business-identity-client.ts) 只读投影身份，并提供账户动作 |
| Workbench | 同组 [原业务源码及许可证](../dsh-agent-workbench/src/workbench/original/SOURCE.md)，负责页面、HTML、布局、动作、引用和页面与 Session 的关联 |
| Manage | 同组资源目录负责 Agent、提示词、Skill、MCP 配置和纯计算 |
| Core | 登记的官方源码持有 Session、原生对话、输入、持久记录与用户草稿 |

GEA 不另建页面 Session 或通用页面 owner。登录、退出、过期、切用户/租户/环境由 GEA Host 统一处理；客户端和 iframe 不保存另一份认证权威。登录展示、页面可见或 Skill 可见均不能替代服务端授权。

## 工程入口

工具链、scripts、peer 和公开导出以 `package.json` 为准，准备和按需检查见 [本地开发](docs/local-development.md)。GEA 只构建 `src/host.ts`、`src/client.tsx`，产物是 `lib/host.js`、`lib/client.js`；业务页面由 Workbench 构建。

工程知识检查使用同组 Workbench 的公共 CLI，配置见 [活跃参考声明](docs/agent-knowledge.json)。`check:knowledge` 检查本地链接、命令和源码路径；公共导出、声明与可执行结构的注释对照通过 CLI 的 `--compare-ref` 参数核验。它不证明所有自然语言、产品行为或运行验收正确。

```sh
corepack pnpm run check:knowledge
corepack pnpm run test:build
```

源码启动、检查和组合使用 [源码组合说明](docs/plugin-split-validation.md) 中的明确五源输入，由 [source-profile](scripts/source-profile.mjs) 统一核 source、commit、integration、依赖和完整产物摘要。缺来源、损坏资产或选择摘要不一致时拒绝，不下载旧包、不重建冻结资产、不改用户默认模型。完整选择可按原摘要读回；失败和 unknown 不自动重写、重试或回切。

源码 Host 沿 [start](scripts/start.mjs) 与公开 [runSourceProfile](scripts/start-isolated-validation.mjs) 使用固定官方 Core，仅按有效窗口授权运行，先完成 [窗口准入与离线冻结](docs/window-launch-admission.md)；省略窗口也拒绝。普通插件 tgz、npm shrinkwrap、实际 profile 锁与恢复见 [安装说明](docs/install.md)。离线安装检查不能替代 Native、Windows、真实业务或生产验收；旧公司壳不属于当前官方客户端目标。

## 身份、额度与取消

[业务身份](src/host/business-identity.ts) 从 Core Session 的实际 preset 与 Manage 当前安装、启用状态重新核资源。环境、租户和用户共同限定页面与保存引用；退出或身份切换使旧请求与授权失效。普通 Skill Session 不能声明业务 Consumer，跨业务路径只能来自可信 profile。凭据和委托 Token 留在 Host，不进入工具 arguments、浏览器、业务快照或配置文件。

HTML launch 与 MCP 共用 [网关握手](src/host/gateway-session.ts)。拒权原码、HTTP/JSON 失败、Consumer 不匹配和不完整会话保留；身份失效后的迟到成功不能恢复授权。工具发现保存服务端路由，未知或冲突路由拒绝；失败不能通过换 Consumer、模型或模块绕过权限。

只读 SQL 的 `sqlReadLimit` 包含 `consumerCode`、`maxRequests`、`maxPagesPerQuery`、`maxRowsPerQuery`，限定同一 Host 生命周期的物理请求。分页、续期后的再次请求、失败与发出后的取消均计数；发出前取消不计数。零额度在登录或委托前拒绝，其他 Consumer 不共享额度。超出页数或行数上限时拒绝，不截断成完整结果。额度不授予数据、模型或写权限，见 [物理额度实现](src/shared/sql-read-limit.js)。销售只读验收的自动请求另沿 Business 的 `readonlyValidation` 合同计数。

缺字段、空数据、拒权、不完整结果与 unknown 分别表达，不用零或成功补齐未知。读取结果保留十进制、来源、时间、环境和分页覆盖；超出模型输入预算时拒绝发送，不静默截断。取消后的部分文本和 `turn/end.reason.kind=aborted` 不能算完整回答。取消用 [隔离信号](src/shared/transport-signal.ts)，完整性条件见 [MCP 证据](src/host/mcp-read-evidence.ts)。

## 保留的业务口径

销售计划预览由 Host 重新读取用户选择的当前版本，浏览器只提交标识。重新查询、登录或 401 使旧快照失效；403 保留脱敏原因。汇总与完整 SKU 明细均展示实际完整输入，历史对比版本不当当前版本，切换范围废弃旧预览。

业务写仍受现有窗口、角色、服务端契约、当前版本与幂等限制。退回状态 6–9 的重提只允许数量修改；Host 核周期、SKU、价格、组织、提报人、目标、流程和下一状态。服务账号按环境隔离，配置只保存凭据引用；缺权限或凭据保持拒绝。结果未知时只能沿原幂等键处理，退出或重启后需重新回读计划。成功回执还须核新有效版本、旧版本失效与日志，不能从 HTTP 成功推断完整业务验收。

通知读取不标已读、不执行审批，来源引用不自动解释为 DSH Session。退出 GEA 清除当前 Host 凭据、模型路由与身份缓存并取消在途请求，Core 工作区、历史会话和草稿保留。DMS 与明确 mock 页面使用模拟输入，mock 回执不完成真实计划；隐藏页面不等于停用执行。页面规则见 [能力契约](docs/capability-contract.md)。原审批算法、金额、草稿、纠偏、逐级审批和 SAVE 回读合同不因工程清理改变。

## 验证与历史

适用测试集合与通过事实归每次 evidence，本 README 不复制持续绿色状态。源码、离线组合、远端 CI、实际安装、Native、真实数据、模型与业务写分别报告。

[清理前 README](docs/history/README-pre-agent-environment-04.md)、[清理前开发说明](docs/history/local-development-pre-agent-environment-04.md)、[清理前 AGENTS](docs/history/AGENTS-pre-agent-environment-04.md) 按基线 `1e8dd6caee3cce298b9c015506b32c8d6d1c1f5d` 原字节留存，包含历史验收、旧 Core 与公司桌面说明；它们不作为当前命令或支持接口。历史失败、许可证和用户数据保留。

本目录只用于隔离开发，不向正式 GitLab、OSS、npm 或频道写入，不修改正式客户端运行目录。真实开窗、正式查询、模型与业务写继续按原有效授权处理。
