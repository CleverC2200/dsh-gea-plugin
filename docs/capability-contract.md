# 能力契约（Capability Contract）与模块注册表

本文说明"每个业务模块怎么被统一接进同一个问答入口"这件事**当前怎么实现**：模块交一份
契约，宿主用一份注册表消费；页面工具、只读数据工具、模块白名单全部由它产出，宿主不再
按模块写分支。随实现一起维护。

## 1. 为什么要有它

现状是垂直分层：每个业务模块自带页面、数据、提示词和 MCP，但右侧对话只有一个入口。
没有契约时，宿主只能"认识每一个模块"：哪些页面能被改、哪个页面属于哪个 `consumerCode`、
首页问一句业务问题该去查哪张表——全靠写死在宿主代码里的名单，加一个模块就要改宿主。

契约把这件事反过来：**模块声明自己有什么，宿主只认声明**。

## 2. 一条契约有哪些字段

定义在 `src/capability/contract.ts`：

| 字段                 | 内容                                                              | 宿主拿它做什么                                    |
| -------------------- | ----------------------------------------------------------------- | ------------------------------------------------- |
| `id` / `label`       | 模块标识与展示名                                                  | 模块索引、日志、回执                              |
| `view.surface`       | 页面标识（`gea-workbench`、`gea-html-<模块id>`）                  | 页面桥白名单；不在名单里的页面声明一律不接        |
| `view.protocol`      | `self-report`（页面自己报元素）/ `dom-scan`（宿主扫同源页面）     | 记录这一屏的目录从哪来                            |
| `view.pageIds`       | 这个模块注册成哪几个页面                                          | 前端把 `pageId` 映射到 `consumerCode`，前端不写死 |
| `data.consumerCode`  | 受管只读编码                                                      | 只读数据工具的白名单与模块索引                    |
| `data.tables`        | 该模块可读的业务表                                                | 写进只读工具说明；也是 `describe` 探查的对象      |
| `data.rules`         | 从模块 `SKILL.md` 摘出的口径要点                                  | 写进只读工具说明，模型不用猜口径                  |
| `maxEffect`          | 允许被对话改到的最大影响等级（`view`/`draft`/`submit`/`approve`） | 决定这个页面能不能写草稿、能不能提交/审批         |
| `skills` / `routing` | 随附技能、负责回答哪类问题                                        | 首页问题路由（关键词）与技能挂载                  |

## 3. 契约从哪来

**默认全部由宿主从模块已有的事实派生**，模块不需要多交文件（`contractFromPlugin`）：

| 事实来源                                                | 派生出什么                                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `plugin.json`（`id`/`name`/`pages`/`gea.consumerCode`） | 模块标识、页面范围、`consumerCode`                                               |
| 模块自己的前端代码（`index.html` 等里的受管 SQL）       | `data.tables`（静态提取 `FROM/JOIN`，排除 CTE、函数与别的 schema）               |
| `skills/*/SKILL.md`                                     | `data.rules`（只摘标题带口径/规则/边界的小节，有长度上限）与一句话摘要           |
| 模块类型                                                | `view.protocol`（迁移页面 = `dom-scan`，自述页面 = `self-report`）与 `maxEffect` |

模块将来想自己声明时，同一份形状直接读模块自带的声明即可：`normalizeContract` 会做
形状校验，非法输入整份丢掉（不猜、不放宽）。

## 4. 一条契约驱动哪些行为

宿主只有一份注册表（`src/capability/registry.ts`），四处消费它：

| 消费点             | 用到的字段                           | 效果                                                       |
| ------------------ | ------------------------------------ | ---------------------------------------------------------- |
| 页面桥白名单       | `view.surface`                       | 只有装了模块、且契约里声明过的页面能被对话操作             |
| 草稿白名单         | `maxEffect`                          | 只声明"改视图"的页面，`setValue` 一律不下发                |
| 影响等级校验       | `maxEffect` + 元素 `effect`          | 契约没到 `submit`/`approve` 的页面，提交/审批类元素不下发  |
| 只读数据工具说明   | `data`                               | 工具说明里直接列出"装了哪些模块、各能读哪些表、口径是什么" |
| 受管只读白名单     | `data.consumerCode`                  | `Business.setCapabilities`：当前启用的真实合同才允许执行    |
| 状态接口的模块索引 | `view.pageIds` + `data.consumerCode` | 前端用它把页面映射到 `consumerCode`，前端不写死名单        |

## 5. 加一个模块要做什么

1. 按现有协议把页面装进客户端（`plugin.json` + `mcp.json` + `skills/*/SKILL.md` + `index.html`）。
2. 什么都不用改宿主：契约自动派生，页面桥白名单、只读工具说明、前端映射都会自动多出这一项。
3. 想让对话能改草稿，契约默认就是 `draft`（迁移页面）；想收紧成只读，把 `maxEffect` 声明成 `view`。
4. 想让对话能提交/审批，必须显式声明到 `submit`/`approve`，并让页面在元素上标 `effect`。

## 6. 边界（沿用工作台已经定下的规矩）

- 只读元素只声明、不可写；后台状态与接口凭据不进目录。
- 写只落**页面草稿**；提交/审批必须按钮当前可点 + 用户这一轮明确要求（`confirm=true`），走页面原有链路。
- 宿主不直连业务写接口；受管只读由 GEA 网关按 `consumerCode` 与用户权限裁决。

## 7. 验证

- 契约派生与注册表：`tests/capability-contract.test.mjs`。
- 契约驱动的工具说明与枚举：`tests/agent-tools.test.mjs`（"只读数据工具的说明由模块自述生成"）。
- 真机：`POST /api/gea-proof/status` 的 `value.modules` 能列出本机安装的模块、`surface` 与 `consumerCode`。

## 页面与能力分离声明（隔离开发，任务 02）

旧 `plugin.json` 未提供 `declarations` 时，仍由 `contractFromPlugin` 从现有页面、Consumer、Skill 与代码派生契约。旧消费者无需同时迁移。

新声明在 `plugin.json` 增加以下可选字段。两个文件都必须位于该安装目录内；可分别由公共工作台的页面资源与 Agent 管理的能力资源生成，部署时组合到同一个只读模块目录。当前只完成兼容接入，未迁移业务仓库，也未增加新的运行时插件或业务注册表。

```json
{ "declarations": { "page": "page.json", "capability": "capability.json" } }
```

页面声明 `page.json`：

```json
{
  "surface": "gea-html-inventory-probe",
  "protocol": "self-report",
  "pageIds": ["inventory-probe"],
  "consumerCode": "probe-consumer",
  "maxEffect": "view",
  "visible": true
}
```

能力声明 `capability.json` 使用现有 `CapabilityContract` 的字段，省略 `view`：

```json
{
  "id": "inventory-probe",
  "label": "分离声明验收",
  "enabled": true,
  "data": {
    "consumerCode": "probe-consumer",
    "tables": ["agents_scm_probe"],
    "rules": ["只读"]
  },
  "maxEffect": "view",
  "skills": ["inventory-probe"],
  "routing": { "keywords": ["验收"], "summary": "隔离只读能力" }
}
```

GEA 在注册前读取两份文件，通过 `consumerCode` 关联，核对 `pageIds` 与已安装页面完全一致，再合成现有契约。`surface` 与页面桥标识一致；`maxEffect` 必须显式声明并与安装模块的上限一致。当前 `gea-html-v2` 仅接受只读模块，因此不能通过新文件升级为 draft、submit 或 approve。显式能力层也不能超过安装模块允许的层。`mcp.json` 的受管通道校验、服务器授权、登录取消、页面租约及卸载行为仍生效；声明不授予业务权限。

重复模块 ID、surface、page ID、文件不存在、缺失页面引用、Consumer/协议不匹配与非法影响等级均中止装载，诊断包含源文件路径；冲突诊断包含双方来源。新文件解析失败不会回退旧声明。完整所选 HTML 模块集先完成校验，随后才发布 Skill、预设、路由与工具。来源字段只用于宿主诊断，不下发到浏览器目录。

公共工作台继续通过原 `agentWorkbench.register/open` 显示页面；Agent 管理继续经版本 1 的 `geaMcp` 服务、当前 Consumer 与登录生命周期挂载工具。两者不需要同时变更 API。浏览器验收使用真实源码宿主与两个模块目录，仅把外部 GEA 和模型服务替换为本机测试端点；不代表生产业务或桌面发行验收。

### 页面可见与能力启用

Workbench安全读取`page.json.visible`，只控制公开页面目录和菜单。`visible=false`保留安装包、声明资源、明确pageId的静态读取与Session归属，不移除能力。

GEA从同一`capability.json.enabled`读取能力启用状态，缺省为true，非布尔值拒绝。`enabled=false`仍注册页面，并把禁用状态传给Manage。资源选用、受管模块路由、页面工具与引用捕获据此拒绝，静态页面保留；重新启用沿原owner挂载。无需增加登录状态、Session格式或第二配置平台。

本批经销商包显式使用顶层`mode=mock`，MCP能力为空，原分页和纯计算读取固定本地输入。该声明不授权真实Consumer调用或模型Task。

### 已退出的旧协议

当前`readPluginContract`要求每个安装包提供分离声明。缺省声明、旧协议、DOM扫描与旧Host回退不属于当前受支持运行路径。历史数据和未接收候选仍保留，后续原票的真实验收条件不因本地接收改变。

### 直接执行与原生销售声明

原生销售复用 `workbenchContract` 的 `enabled` 字段，部署通过 `workbenchCapability.enabled` 提供同一事实，缺省为启用。Host 将该合同和 HTML 合同放入唯一注册表，再传给 Business；Manage 的原生资源投影读取同一声明。`analysisAgentCode` 映射到原生销售合同，不再自动成为 SQL/MCP 例外。空注册表和未登记 Consumer 都拒绝，不恢复历史消费者名单。

每个真实执行入口在认证、委托凭据或传输之前核当前合同。`enabled=false` 返回 `GEA_CAPABILITY_DISABLED`，模拟数据合同返回 `GEA_CAPABILITY_MOCK_ONLY`，未登记 Consumer 返回 `GEA_PLUGIN_CONSUMER_NOT_ALLOWED`；作用等级或层不符返回 `GEA_CAPABILITY_EFFECT_NOT_ALLOWED`。这些错误不代替 GEA 的服务端业务授权。

当前 Manage 资源仍在模型步骤与工具派发前重新检查；官方 `llm/stream` waterfall 同时保护保存的 GEA direct provider。模拟页面的原 view/context/reference 合同保持，禁真实 SQL、MCP 和模型。测试见 `tests/mock-validation-execution.test.mjs` 与 `tests/disabled-model-resource.test.mjs`，本地捕获不代表 Native 或真实服务验收。
