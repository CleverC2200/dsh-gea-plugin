# 当前能力声明与受控执行

## 普通会话与运行态诊断

GEA 在模型步骤按实际 Core 会话预设限制受控业务工具。普通预设可加载规则 Skill；当前预设声明可用的受管 Cube 来源，或个人 Agent 显式引用一个可信已安装 Cube 来源时，可发现服务端为该 Consumer 发布的 Cube 与知识库 MCP 工具。智能编排保留 `auto-negotiation` 预设，通过 Manage 受管来源以 `workbench` 编码发起模型及 MCP 请求，独立查询无需绑定页面。来源必须已安装、启用且无错误；来源失效、身份变化或引用撤销时，同时限制模型工具清单和直接派发，取消所属在途请求并拒绝迟到结果。官方通用工具和用户独立 MCP 保留。直接派发仍按原业务 guard 校验，角色名称与子智能体 persona 不授予 Consumer 身份；个人引用由 GEA Host 反查来源 owner 和 Consumer，不接受用户填入 Consumer、Token 或网关地址。页面工具还要求同会话当前页面身份已绑定，界面菜单可见不能代替页面绑定。

`gea_runtime_diagnose` 是所有会话可用的只读诊断工具。只返回当前调用 Agent、实际 preset、父会话 ID、资源安装及启用状态、声明 Consumer、页面是否绑定、登录布尔状态、工具名称和最近最多20条工具错误码。它不读取配置或凭据，不返回业务正文、工具参数或历史问题，不请求业务接口或模型。`businessAuthorization=not-checked` 明确保留服务端授权未核结论。无调用 Agent 与无业务预设仍保留 `GEA_BUSINESS_PROFILE_REQUIRED`，错误说明分别给出调用归属缺失与预设身份缺失；未绑定页面给出 `PAGE_NOT_BOUND` 原因。

独立 MCP 的结果保留独立来源与原 GEA 失败，不能据此宣称页面确定性计算或 GEA 授权恢复。当前诊断工具和离线/Core 检查不证明同事电脑会话或真实模型行为通过。

能力形状定义在 [contract](../src/capability/contract.ts)，装载由 [readPluginContract](../src/capability/declarations.ts) 校验，[registry](../src/capability/registry.ts) 管本 Host 安装能力。页面、Skill 和能力声明不授予服务端业务权限。

## HTML 声明输入

默认智能编排 `auto-negotiation` 的已启用受管 `workbench` 来源可读取已安装的固定库存查询：分仓库存、目标及补货沿 `gea_branch_inventory`；当前缺口沿 `gea_current_shortage` 并明确基地或分仓范围。只复用 SQL 定义，实际委托始终使用该会话的 `workbench` Consumer，不借用页面 Consumer，不扩大服务器行/字段权限，也不回退 Cube 重算。来源撤销、替换或身份变化会取消在途读取；普通会话与个人 Cube 引用不因此获得固定库存工具。

当前 [HTML 装载入口](../src/html-plugins.ts) 要求安装包明确提供 page/capability 分离声明，以及 Manage 的 Agent 资源贡献。`plugin.json` 声明如下引用，文件必须位于该安装目录内：

```json
{ "declarations": { "page": "page.json", "capability": "capability.json" } }
```

| 事实                  | 当前来源与条件                                              |
| --------------------- | ----------------------------------------------------------- |
| 模块、页面与 Consumer | plugin.json 的实际安装元数据，pageIds 与页面声明完全一致    |
| 页面 surface/protocol | page.json 明确声明，当前协议为 self-report                  |
| 数据 tables/rules     | capability.json 提供，不扫描 HTML SQL、DOM 或 Skill 正文    |
| 能力 enabled          | capability.json，缺省 true，非布尔值拒绝                    |
| maxEffect/layers      | 明确能力声明，不能超过安装模块允许的影响等级和层            |
| Agent prompt/Skill    | Manage 从安装资源管理，不由页面或 GEA Client 建另一目录权威 |

HTML 的 `gea-html-v2` 当前只接收只读模块，不能通过声明升级成 draft、submit 或 approve。MCP 的 provider/transport/contract 与 AGENT Consumer 必须匹配；真实模块的 MCP 声明为 governed-sql-read，mock 模块的能力列表为空。`contractFromPlugin` 只提供已校验安装元数据的基础形状，缺声明不会沿旧路径自动派生。

缺文件、路径越界、缺页面引用、Consumer/协议不匹配、非法等级、重复模块/surface/page ID 都拒绝。诊断保留来源路径，重复项说明双方来源；解析失败不回退旧协议。资源与页面生命周期、取消和 owner 释放仍沿 Workbench/Manage 的公开入口，GEA 只提供业务 grant 和执行条件。

## 可见、启用与身份

GEA Client 的 `businessAccount` 与 `geaIdentity` 共用一份 Host 只读投影。`status.environment` 是当前环境，`status.environments` 是部署已配置的可选环境，不含地址或凭据。工作台把用户选择传给 `startLogin(signal, environment)`；GEA Client 只调用现有 `login/start { environment }` 并刷新 Host 投影。环境切换、清除旧身份/二维码和取消旧代际由 Host `loginStart` 统一执行，客户端不另建环境切换或登录权威。`/api/gea-html/identity` 的环境列表变化会通知投影订阅者，取消或被新读取取代的响应不能覆盖当前投影。

普通插件的空设置采用 `desktop/company.config.json` 已登记的正式/测试地址，默认正式。Host Config 保留显式 `environment` 和 `geaEnvironments`；自定义单地址且没有环境映射时仍只提供该环境，不将用户配置改到公司默认端点。

Workbench 读取 `page.json.visible`，只控制目录和菜单。隐藏页面保留安装、声明与原 Session 归属，不等于停用能力。

`capability.json.enabled=false` 仍保留静态页面，将禁用状态传给 Manage，并拒绝资源选择、受管读取、页面动作和引用捕获。重新启用沿原 owner，不新增登录状态、Session 格式或第二配置平台。

原生销售沿 `workbenchCapability.enabled` 提供同一启用事实，缺省启用；`analysisAgentCode` 映射到实际原生合同，不是 SQL/MCP 例外。空注册表和未登记 Consumer 拒绝，不恢复历史名单。

真实入口在认证、委托或传输前检查合同。禁用返回 `GEA_CAPABILITY_DISABLED`，mock 合同返回 `GEA_CAPABILITY_MOCK_ONLY`，未登记 Consumer 返回 `GEA_PLUGIN_CONSUMER_NOT_ALLOWED`，影响等级或层不符返回 `GEA_CAPABILITY_EFFECT_NOT_ALLOWED`。这些结果不能代替服务端业务授权。

Manage 的当前安装与启用状态在模型步骤和工具派发前重新核对；GEA direct provider 也受当前资源保护。身份切换使旧请求失效。mock 页面可沿原 view/context/reference 行为运行，禁止真实 SQL、MCP、模型和业务写；模拟来源不伪装成真实授权。

## 验证与历史

能力合同、声明、取消、mock/disabled 执行的现有测试分别位于 `tests/capability-contract.test.mjs`、`tests/split-declarations.test.mjs`、`tests/mock-validation-execution.test.mjs` 和 `tests/disabled-model-resource.test.mjs`。按每次有效输入与 evidence 记录结果；本地合同不证明 Native 或真实服务验收。

[原能力文档](history/capability-contract-pre-agent-environment-04.md) 按清理前基线保留原字节，其中自动派生、DOM 扫描、旧 adapter 与兼容接入的描述是历史，不作为当前支持行为。公共类型、业务 Prompt/Skill、runtime 字符串和执行规则未由本次文档/注释清理修改。

## HTML Agent 配置查询

当已安装 HTML manifest 声明 `sqlConfig: "sql.config.json"` 时，所属页面的 `readSql` 只接受 `{ queryId, parameters }`。GEA Host 校验同目录配置的 Agent 标识和参数，从配置解析 SQL 或固定 Cube 查询，并使用该页面声明的 Consumer 与统一业务身份执行。Cube 通过已授权模块 MCP 调用，页面不能提交成员、路由或任意查询；单月参数绑定为该月实际日期范围，分页、缺值及 partial 状态保留。页面提交 SQL、Consumer 或数据源等额外字段会被拒绝。没有 sqlConfig 的旧页面继续使用原有接口。

配置查询的 LIMIT/OFFSET 和配对计数由配置负责，Host 不叠加请求级分页。返回权限列和结构化失败保留；取消、身份变化、未发布资源和权限拒绝不触发直连回退。配置注册并不代表源表字段已发布或已获用户权限。五个页面及验证状态见相邻 Workbench 的 `docs/unified-gea-adaptation-20261019.md`。

## 当前订单与缺货独立问数

`gea_current_shortage` 只对基地、分仓、全链及产销协同的可信 Session profile 开放，不依赖页面绑定，也不打开模型自由 SQL 开关。Host 从实际 Session 决定 Consumer，解析对应已安装页面的 `current-shortage.summary/detail` 固定配置；调用者仅提供基地名称、分仓编码、SKU、品类和明细页码。业务身份、已安装启用状态在执行前后复核，身份变化或取消不发布迟到结果。

此入口复用页面 SQL 和同一网关授权，不查询 Cube、不用本地库回退。完整范围汇总与地点+SKU分页分别声明覆盖范围；缺少返回列、异常行或不完整页不能转成零值。共享库存缺口不能分摊为订单缺口或影响订单数。旧 Skill 的 Cube 说明继续适用于其它已发布指标，当前订单及缺货的固定入口由 Host 提供明确路由，不覆盖用户自定义提示词或 Skill。

## 分仓 DMS 专用动作

分仓页面通过部署显式配置的 `dms` 用户映射开放专用暂存与免登 grant；不修改通用 HTML 工具的只读 maxEffect。凭据、当前身份复核和持久提交回执由 Host 管理，当前页面 owner 取消会撤销在途调用。协议、配置与未知结果处理见 [分仓 DMS 对接](dms-branch-integration.md)。
