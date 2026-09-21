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

| 字段 | 内容 | 宿主拿它做什么 |
| --- | --- | --- |
| `id` / `label` | 模块标识与展示名 | 模块索引、日志、回执 |
| `view.surface` | 页面标识（`gea-workbench`、`gea-html-<模块id>`） | 页面桥白名单；不在名单里的页面声明一律不接 |
| `view.protocol` | `self-report`（页面自己报元素）/ `dom-scan`（宿主扫同源页面） | 记录这一屏的目录从哪来 |
| `view.pageIds` | 这个模块注册成哪几个页面 | 前端把 `pageId` 映射到 `consumerCode`，前端不写死 |
| `data.consumerCode` | 受管只读编码 | 只读数据工具的白名单与模块索引 |
| `data.tables` | 该模块可读的业务表 | 写进只读工具说明；也是 `describe` 探查的对象 |
| `data.rules` | 从模块 `SKILL.md` 摘出的口径要点 | 写进只读工具说明，模型不用猜口径 |
| `maxEffect` | 允许被对话改到的最大影响等级（`view`/`draft`/`submit`/`approve`） | 决定这个页面能不能写草稿、能不能提交/审批 |
| `skills` / `routing` | 随附技能、负责回答哪类问题 | 首页问题路由（关键词）与技能挂载 |

## 3. 契约从哪来

**默认全部由宿主从模块已有的事实派生**，模块不需要多交文件（`contractFromPlugin`）：

| 事实来源 | 派生出什么 |
| --- | --- |
| `plugin.json`（`id`/`name`/`pages`/`gea.consumerCode`） | 模块标识、页面范围、`consumerCode` |
| 模块自己的前端代码（`index.html` 等里的受管 SQL） | `data.tables`（静态提取 `FROM/JOIN`，排除 CTE、函数与别的 schema） |
| `skills/*/SKILL.md` | `data.rules`（只摘标题带口径/规则/边界的小节，有长度上限）与一句话摘要 |
| 模块类型 | `view.protocol`（迁移页面 = `dom-scan`，自述页面 = `self-report`）与 `maxEffect` |

模块将来想自己声明时，同一份形状直接读模块自带的声明即可：`normalizeContract` 会做
形状校验，非法输入整份丢掉（不猜、不放宽）。

## 4. 一条契约驱动哪些行为

宿主只有一份注册表（`src/capability/registry.ts`），四处消费它：

| 消费点 | 用到的字段 | 效果 |
| --- | --- | --- |
| 页面桥白名单 | `view.surface` | 只有装了模块、且契约里声明过的页面能被对话操作 |
| 草稿白名单 | `maxEffect` | 只声明"改视图"的页面，`setValue` 一律不下发 |
| 影响等级校验 | `maxEffect` + 元素 `effect` | 契约没到 `submit`/`approve` 的页面，提交/审批类元素不下发 |
| 只读数据工具说明 | `data` | 工具说明里直接列出"装了哪些模块、各能读哪些表、口径是什么" |
| 受管只读白名单 | `data.consumerCode` | `Business.setPluginConsumers`：装了什么模块才允许读什么 |
| 状态接口的模块索引 | `view.pageIds` + `data.consumerCode` | 前端用它把页面映射到 `consumerCode`，前端不写死名单 |

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
