# Cube 成员名护栏：把"猜错成员名"拦在发出去之前（2026-09-23）

## 一、根因

提示词里"成员名照抄目录"约束过多次仍反复出错，原因是这条链路上缺的不是提醒，是校验：

1. **成员名是数据，不是习惯**：真名只存在于 inspect 产物里（`agents_scm_safety_stock` 有 55 个维度、0 度量），
   模型要跨步骤记住并在参数里逐字写对。
2. **模型会在同一步里并行发"读目录"和"发查询"**：实测 step36 两条调用落在同一个回合，
   查询参数在目录结果回来之前就定型了——"先查目录再照抄"这种情况下物理上无法生效。
3. **宿主不校验**：工具名有 `didYouMean`、年月值有预检，**成员名一个都没校验**，错的直接发到 Cube。
4. **网关把原因吞了**：Cube 说 member not found，到客户端只剩 `MCP_UPSTREAM_TOOL_ERROR`
   （无 `details`、`suggestedAction=CHECK_UPSTREAM_LOGS`），模型拿不到"名字写错了"的反馈。

实测数据（出问题那一轮，`session-a783024c`）：**19 次目录调用**（同一个模型 9 次）、**23 次查询里 2 次**
写了不存在的成员（`category_name`、`category_1_name`；真名是 `product_categ_name`）。
只读 A/B 对照确认真名可用、错名必被下游拒（见 `gea-gateway-requests-20260923.md` 第 5 节）。

## 二、改了什么（客户端侧，不依赖服务端）

| # | 改动 | 位置 |
| --- | --- | --- |
| 1 | **成员清单索引**：读 inspect 时按模型缓存成员（维度/度量/分段），10 分钟有效 | `src/host/member-index.ts`（新） |
| 2 | **发查询前逐字校验** `dimensions/measures/filters/order`：不认识的成员**不发出去**，就地回"最像的真名 + 这个模型有哪些成员"；把维度写进 measures 也拦下（上游必拒） | `src/host/agent-tools.ts` |
| 3 | **失败回填**：网关只回"下游工具执行失败"时，借同一条会话补读一次目录再判断，判出来就把失败换成"照着改就能过"的提示 | `src/host/agent-tools.ts` |
| 4 | **错误文案**：删掉"这是网关下游的错误，不是参数问题"，改成"先自查成员名与 measures 写法" | `src/host/mcp-client.ts` |
| 5 | **大结果护栏**：行数正好等于 limit 时提示"别把这一页当全量"；制品贴着授权上限时提示先缩列收窄；同一段重复读时提示"你刚读过" | `src/host/mcp-client.ts` |
| 6 | **协议补两句**：成员名只能逐字来自目录、读目录与发查询不许并行；被回"下游工具执行失败"时先自查这两件 | `src/host.ts` |
| 7 | **制品完整正文接口**：`McpModule.artifact()`，给宿主自己用（清单索引），模型仍只看分段 | `src/host/mcp-client.ts` |

顺带修掉一个真 bug：`extractArtifactUri` 会把宿主自己内联的 `【结果内容 data-artifact://…】` 的右括号
吃进地址里，拿它读资源会被网关回"Resource 不存在"。

## 三、验证

- 单测：`tests/member-index.test.mjs`（6 条：解析、拦截、最像的真名、模型不在清单不误判、
  measures 错位、成员名收全、过期不拦）+ `tests/module-mcp.test.mjs` 新增 3 条大结果护栏；
- 定向回归：module-mcp / member-index / agent-tools / gateway-catalog **57 条全绿**，`tsc` 通过，构建通过；
- **真机只读验证**（`base-safety-stock`，prod）：索引解析出 **39 个模型**、`agents_scm_safety_stock` 55 个维度；
  发来的 `category_name` / `category_1_name` 被拦下，提示里给出的真名是 `product_categ_name`；
  把 `current_inventory` 写进 measures 也被拦下并说明"这个模型没有度量"。

## 四、还没做的

- 端到端真机验收（在预览里问一次"各基地的品类结果占比"看护栏是否按预期出现）——需要起预览；
- 网关侧改进（成员错误用 `VALIDATION` + `details.path`、审计别标"拒绝"）已写进
  `gea-gateway-requests-20260923.md` 第 5 节，等平台侧排期。
