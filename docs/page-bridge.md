# 页面桥（Page Bridge）：让右侧对话读写中间工作台

本文说明"右侧对话读中间工作台数据、代替人工操作页面元素"这套能力**当前怎么实现**、
边界在哪、以及怎么接入一个新页面。随实现一起维护。

## 1. 目标与红线

| 要求 | 实现方式 |
| --- | --- |
| 能读中间工作台的页面数据 | 页面自述"元素 + 当前值"，只读元素也列出来（模型读得到） |
| 能代替人工操作页面元素动作 | 页面声明元素支持的操作（`actions`）与可编辑字段（`editable`），模型只用 4 个通用动词操作 |
| 不允许改只读元素 | 只读元素出现在"只读元素"清单里，`setValue`/`invoke` 一律被宿主拒绝 |
| 不允许碰后台元素 | 后台状态、内部缓存、接口凭据**不进入元素清单**；调用未声明的 id 直接 `UNKNOWN_ELEMENT` |
| 审批允许（走页面原链路） | 页面只在按钮**当前可点**时声明 `action:approve` / `action:reject`；执行等价于人工点同一次按钮，权限/状态/快照仍由页面与 GEA 合同校验 |
| 保存调整仍必须人工 | 页面不声明"保存"动作；对话只能改**草稿**（确认计划量输入框），落库仍要人工点保存 |

## 2. 一次调用的链路

```
中间页面(iframe)              宿主(插件 Host)                    右侧对话(模型)
  │ ① 每 1.2s 轮询 {sessionId, toolMessages, catalog}
  │ ─────────────────────────────────────────────▶ │
  │                                  ② 校验目录 → 为该会话注册工具
  │                                  ③ 模型调工具 → 硬校验 → 入队
  │ ◀──── ④ TOOL_CALL_START / ARGS / END ────────── │ ◀── 模型发起
  │ ⑤ 业务执行（改视图 / 填草稿）
  │ ────── ⑥ tool 消息回填 ───────────────────────▶ │
  │                                  ⑦ 等状态刷新 → 结果回给模型
```

对应代码：

| 步骤 | 位置 |
| --- | --- |
| ① 页面轮询 | `src/page-bridge/client.ts`（`startPageBridgeClient`）、`src/workbench/page.tsx` |
| ② 目录校验 + 注册工具 | `src/host.ts`（路由 `agui/workbench`）→ `src/page-bridge/registry.ts`（`declare`） |
| ③ 调用与硬校验 | `src/page-bridge/registry.ts`（`invoke`）→ `src/page-bridge/catalog.ts`（`resolvePageAction`） |
| ④ 事件下发 | `src/page-bridge/host.ts`（`pull`） |
| ⑤ 业务执行 | 页面自己的 `apply`（例如 `RegionalApprovalWorkbench` 的动作分支） |
| ⑥ 结果回填 | `src/page-bridge/client.ts`（`role: "tool"` 消息） |
| ⑦ 结果信封 | `src/page-bridge/registry.ts`（`applied` / `snapshotAfterApply` / `state`） |

事件与消息的形状对齐 AG-UI 的"前端工具"（`TOOL_CALL_START/ARGS/END`、`role:"tool"` + `error`），
但不引 `@ag-ui/core`：字段名一致，将来换官方包或换成 SSE 是机械替换。见 `src/page-bridge/protocol.ts`。

## 3. 模块职责

| 文件 | 职责 | 是否含业务词 |
| --- | --- | --- |
| `src/page-bridge/protocol.ts` | AG-UI 事件/消息形状、长度与数量上限、入站校验 | 无 |
| `src/page-bridge/catalog.ts` | 能力目录校验、编译成工具说明与参数表、调用前的元素级硬校验 | 无 |
| `src/page-bridge/host.ts` | 会话级队列：`enqueue / pull / take / wait / reset` + TTL | 无 |
| `src/page-bridge/registry.ts` | 按会话注册/注销工具、策略收口、调用编排、结果信封 | 无 |
| `src/page-bridge/client.ts` | 浏览器侧运行时：轮询、累积参数、交业务执行、回填、心跳 | 无 |
| `src/page-bridge/index.ts` | 对外出口 + `PAGE_BRIDGE_VERSION` / 能力清单 | 无 |

业务侧只保留三件事：**声明**、**执行**、**状态快照**。

## 4. 契约

### 4.1 页面能力目录（页面 → 宿主）

```ts
{
  surface: "gea-workbench",          // 页面标识，宿主用白名单判断"允不允许被对话改"
  tool: "gea_workbench_apply",       // 工具名
  description: "……",                 // 工具总述（业务写）
  reasonField: "reason",             // 可选：为什么改这一屏
  elements: [                        // 页面渲染出来的元素
    { id: "row:p-1", role: "row", label: "经销渠道虚拟二",
      value: "¥3,888,792.00", actions: ["expand", "openDetail", "select"] },
    { id: "field:p-1:sku:1001:qty", role: "field", label: "…确认计划量",
      value: "939", editable: true },
    { id: "collection:p-1:qty", role: "collection", label: "该行确认计划量",
      members: ["field:p-1:sku:1001:qty"] },
    { id: "stage", role: "control", label: "审批阶段", value: "area",
      options: ["all", "area", "province"] }
  ],
  // 兼容形态：页面自定义动作名（旧写法，逐步迁移到 elements）
  actions: [ /* { name, description, scope, params } */ ]
}
```

| 元素字段 | 含义 |
| --- | --- |
| `id` | 稳定 id（允许 `:` 分层），模型引用它 |
| `role` | `row` / `field` / `control` / `collection` |
| `label` | 人能看到的文案，模型靠它对齐用户的话 |
| `value` | 当前值；只读元素也带，供模型读 |
| `options` | 可选值（下拉/分段控件） |
| `actions` | 该元素支持的操作名，`invoke` 只能从这里选 |
| `editable` | 只有 `field`（后续含 `control`）且为 true 才允许 `setValue` |
| `members` | `collection` 的成员元素 id，用于"这一列一起改" |

GEA 工作台当前上报的元素 id 约定：

| 元素 id | role | 说明 |
| --- | --- | --- |
| `row:<planId>` | row | 计划行，`actions: expand / collapse / openDetail / select` |
| `detail` | control | 打开中的详情抽屉，`actions: close` |
| `stage` | control | 审批阶段，`editable` + `options` |
| `filter:<field>` | control | 五个筛选控件（areaCode/provinceCode/orgCode/dealerCode/status），`editable` + `options` |
| `filters` | control | 筛选复位，`actions: reset` |
| `pager` | control | 分页，`editable`（当前页） |
| `field:<planId>:<skuCode>:qty` | field | 已展开行的"确认计划量"，`editable` |
| `collection:<planId>:qty` | collection | 该行全部确认计划量字段，用于"一起改成同一个值" |
| `action:approve` / `action:reject` | control | 工具栏的通过 / 退回，**只在按钮当前可点时声明**（和人工能点的范围一致） |
| `dialog:approval` | control | 打开中的审批对话框：`confirm` / `cancel`（通过是"一步到位"，对话框不渲染） |
| `dialog:approval:remark` | field | 退回理由输入框（`editable`），仅在退回对话框里出现 |

审批元素走的还是页面原有链路：`invoke action:approve` 等价于人工点"通过"，
`invoke dialog:approval confirm` 等价于人工点对话框里的确认；权限、状态、
快照校验仍由页面与 GEA 合同负责。所以"对话执行审批"没有绕过任何人工路径，
只是替人点了同一次按钮。

上限（`catalog.ts` 的 `PAGE_CATALOG_LIMITS`）：元素 ≤ 300、说明总长 ≤ 20000 字符、
说明里逐条列出的实例元素 ≤ 120（其余折叠成一行规则，不逐条列）；
校验失败一律 `INVALID_PAGE_CATALOG`，不注册工具。
说明超长时是**截断说明**而不是不注册：页面元素多（20 行 + 展开字段）时工具必须还在。

页面自己必须先落在这些上限里（`src/workbench/workbench-elements.ts`）：

| 真实数据的坑 | 页面侧的处理 |
| --- | --- |
| 客户筛选有几十项，超过选项上限 24 | 只上报前 24 项，并在 label 里写“共 N 项，只列出前 24 项，也可直接填名称或编码”；值本身照样能填 |
| 个别 SKU 的确认量、行金额、退回理由是**空串** | 空串一律省略 `value`（不是上报空值） |
| 展开行很多时元素总数会超过 300 | 先保“控件 + 行”（动作/对话框/筛选/分页），再保集合与字段 |

反例见回归用例 `tests/workbench-elements.test.mjs`：最坏输入必须能通过宿主校验，
否则会被判 `INVALID_PAGE_CATALOG`，这一屏对对话来说就等于“没有能力”。

### 4.2 通用动词（宿主 → 模型）

工具参数固定为 `kind` + `target` / `targets` / `action` / `value` + `reason`：

| `kind` | 含义 | 必填 |
| --- | --- | --- |
| `invoke` | 执行元素声明的动作 | `target`、`action` |
| `setValue` | 往可编辑元素写值（可用 `targets`/`collection` 批量） | `target` 或 `targets`、`value` |
| `select` | 选中元素 | `targets` |
| `clear` | 关闭当前浮层 / 复位 | 无 |

工具说明由目录**自动生成**：分「可操作元素」「只读元素」两段，逐条写 id、role、label、
当前值、可选值、是否可编辑、可执行动作。所以新增页面元素不需要改工具定义。

### 4.3 页面结果与宿主信封

页面执行完成后回填 AG-UI 的 tool 消息：

```ts
{ id: "…", role: "tool", toolCallId, content: "…", error?: "…" }
```

宿主把它包成给模型的结果：

```ts
{
  source: "PAGE_BRIDGE", protocol: "ag-ui-frontend-tool", authority: "view-only",
  tool: { toolCallName, toolCallId }, kind,
  applied,               // 页面是否真的应用
  snapshotAfterApply,    // 拿到的是不是"改动后"的页面状态
  page,                  // 页面自己的回报（JSON 可解析时是对象）
  state,                 // 业务提供的当前页面状态
  availability?, code?, error?, reason?
}
```

## 5. 策略收口（宿主侧硬校验）

| 规则 | 位置 | 失败码 |
| --- | --- | --- |
| 只允许白名单页面被对话改动 | `host.ts` 的 `allowSurfaces` | 不注册工具（fail-closed） |
| 写字段按页面放开 | `host.ts` 的 `dataActionSurfaces` | `DATA_ACTION_NOT_ALLOWED` |
| 元素必须来自声明 | `catalog.ts` `resolvePageAction` | `UNKNOWN_ELEMENT` |
| 只读元素不能被改 | 同上 | `ELEMENT_NOT_EDITABLE` |
| 动作必须是元素声明的 | 同上 | `ACTION_NOT_ALLOWED` |
| 缺 target / value / action | 同上 | `MISSING_TARGET` / `MISSING_VALUE` / `MISSING_ACTION` |
| 目录非法 | `catalog.ts` `validatePageCatalog` | `INVALID_PAGE_CATALOG` |

页面声明来自浏览器，按**不可信输入**处理：所有"能不能改"的判断都在宿主做，
页面侧再兜一层（例如编辑权限）。测试断言：整轮操作不触达任何 GEA 写接口
（`/actions`、`/submit`、`/sales-plan/action`）。

## 6. 生命周期

| 事件 | 行为 |
| --- | --- |
| 页面首次声明 | 为该会话注册 agent 作用域工具（`agent.ctx.tools.register`，返回 disposer） |
| 目录内容变化 | 注销旧的、注册新的（按目录 JSON 去重） |
| 30 秒不再声明 | 视为页面已关闭，注销工具 |
| 身份变化（登录/登出/换环境） | `watchIdentity → disposeAll()` |
| 调用超时（默认 4s） | 返回 `PAGE_TOOL_PENDING`，不假装成功 |
| 应用成功但状态没回来（默认 2s） | 返回 `PAGE_STATE_REFRESHING`，并注明"附的是改动前状态" |

## 7. 接入一个新页面

0. **先看这个页面属于哪个模块**：宿主不再手写白名单，`allowSurfaces` / `dataActionSurfaces`
   都来自能力契约（见 [capability-contract.md](./capability-contract.md)）。新模块只要把
   `plugin.json` / `SKILL.md` / 页面装进客户端，契约自动派生。
1. 宿主编排处把页面接上：`createPageToolRegistry(ctx, bridge, { allowSurfaces: registry.surfaces(), dataActionSurfaces: registry.draftSurfaces(), allowsEffect: registry.allows })`。
2. 页面侧用 `startPageBridgeClient({ endpoint, request, sessionId, apply, catalog })` 启动：
   - `catalog()` 返回该页面**当前**的元素清单；
   - `apply(args, meta)` 把 4 个通用动词落到页面自己的状态上，返回 `{ applied, error? }`。
3. 宿主路由接收 `{ sessionId, toolMessages, catalog }`，调用 `pageTools.declare()` 与 `bridge.pull()`。
4. 业务提供 `stateSnapshot(sessionId)`（可选）：桥用它判断"改动后的状态是否已回填"。

**从 web 迁过来的业务页面不用走上面 2-4 步**：宿主把适配器脚本注入页面
（`src/html-page-scan.ts` + `html-plugins.ts` 的 `page-bridge` 方法），页面自己不用改。
两种来源的取舍与试点结论见 [page-bridge-v2-pilot.md](./page-bridge-v2-pilot.md)。

最小 `apply` 形状：

```ts
apply: (args) => {
  const kind = String(args.kind);
  if (kind === "invoke") return invokeElement(String(args.target), String(args.action));
  if (kind === "setValue") return setElementValue(targetList(args), String(args.value));
  if (kind === "select") return selectElements(targetList(args));
  if (kind === "clear") return clearOverlay();
  return { applied: false, error: "UNKNOWN_VERB" };
}
```

## 8. 验证

| 检查 | 命令 | 覆盖点 |
| --- | --- | --- |
| 类型 | `corepack pnpm typecheck` | 契约不被绕过 |
| 端到端（模型工具环） | `node --test tests/agent-tools.test.mjs` | 声明→注册→调用→回填→结果信封；策略拒绝；不触达写接口 |
| 只读/可编辑元素边界 | `node --test tests/agent-tools.test.mjs` | 「元素目录：只读元素改不动，只有可编辑字段才下发到页面」「元素很多时工具仍要注册」 |
| 模型工具清单 | `node --test tests/model.test.mjs` | 只在页面声明的会话里出现该工具 |
| 模型读数据（不依赖页面） | `node --test tests/read-paging.test.mjs` | `versionSkus` 分页投影：`partial` + `nextPageNo`；超预算自动缩页 |
| 页面渲染与状态 | `node --test tests/workbench-*.test.mjs tests/month-aggregation-context-web.test.mjs` | 页面行为不回退 |

关键回归用例：

1. 页面同步的可见页快照**不能被工作台自己的实时查询清掉**（`clearQuery` 曾经误清）。
2. 只读元素上的 `setValue` 被宿主拒绝且**不下发**；同一轮里可编辑字段正常下发。
3. 非白名单页面的声明不注册任何工具。
4. 改完拿到的是 `snapshotAfterApply: true` 的状态。

## 9. 已知限制与后续

- GEA 工作台**已迁移到 `elements`**（行 / 抽屉 / 阶段 / 5 个筛选 / 分页 / SKU 字段 / 集合）；
  旧的动作名形态仍被桥支持，留给尚未迁移的页面过渡使用。
- 审批类元素（通过/退回）**已开放**，但只声明"按钮当前可点"的行，且需要用户明确指令
  （见预设措辞：执行前复述"对象 + 动作 + 依据"）。保存调整仍是"草稿 + 人工点击"。
  宿主侧另加一道硬规则：标了 `effect: submit/approve` 的元素**没有 `confirm=true` 一律不下发**。
- 迁移过来的业务页面（`gea-html-<模块id>`）**已接入**：宿主注入适配器扫这一屏、按原生输入
  方式改草稿；页面不用改。契约决定它能不能写草稿（默认 `draft`，只读页面声明 `view`）。
- 切页/切会话/关页面时，页面目录与"这一屏"的可见上下文都会**立刻撤掉**，不留给下一屏
  （`workbenchCatalog([])` 返回 `null`、桥关闭时补报一次 `catalog: null`）。
- "改草稿"统一走一层实现（`src/capability/draft.ts`）：限流、超时、回执、确认策略与可追溯
  记录都在那里，页面只声明能力；结果信封里带回 `draft.id` 与 `outcome`。
- 传输是 HTTP 轮询；换成 SSE 只需要替换 `client.ts` 的取事件方式与 `host.ts` 的路由形态。
- 桥当前以"仓库内共用模块"形态维护（`src/page-bridge/`），接口稳定后可抽成独立插件
  （新仓库 + 渠道）或并进 `@cleverc2200/dsh-agent-workbench`。

## 10. 配套的两条边界（和工作台对话一起定下来的）

| 场景 | 行为 | 位置 |
| --- | --- | --- |
| 只查数据、不需要页面 | 模型用 `gea_plugin_read`（只读 SQL/接口）直接查，**不会去开浏览器** | `src/host/agent-tools.ts` 的 `gea_plugin_read`；复用 `business.pluginSql` |
| 在工作台会话里扒页面 | 该会话按前缀禁用全部浏览器/MCP 工具（`denyGlobalToolsInWorkbench`），只剩页面桥能改这一屏 | `src/page-bridge/registry.ts` |
| 普通通用对话 | **不受限制**：浏览器/MCP 照旧可用 | 同上（只在 `gea-workbench` surface 的会话生效） |

也就是说：**页面桥负责"改这一屏"，`gea_plugin_read` 负责"查数据"，
浏览器 MCP 只在工作台会话里被关掉。** 三者边界不重叠。
