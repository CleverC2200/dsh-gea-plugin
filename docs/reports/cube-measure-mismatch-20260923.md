# Cube 查询把数值字段放进 measures 被拒（2026-09-23）

## 现象

对话侧生成了一条 Cube 查询，把数值字段放进了 `measures`；但这些 cube 的语义模型**一个
measure 都没定义（全部字段都是 dimensions）**，上游 Cube MCP 直接拒绝查询计划。

## 我们这边的原始证据

真机会话 `session-ccb7d377-b2be-49ec-9493-5b08be42f309`（全链路库存，0.0.103）里的工具调用：

```json
{"consumerCode":"full-chain-inventory","tool":"query_business_data","arguments":{
  "action":"query",
  "queries":[{"name":"age_dates","query":{
    "measures":["agents_scm_inventory_age.qty"],
    "dimensions":["agents_scm_inventory_age.snapshot_date"],
    "order":{"agents_scm_inventory_age.snapshot_date":"desc"},
    "limit":5}}]}}
```

同一次调用我们收到的错误文本是：

```
Error: GEA_MCP_TOOL_ERROR: 网关策略未配置数据授权
```

而 Cube 侧日志里的拒绝原因是"未定义 measure / 查询计划被拒"。**两边的错误名字对不上**：
同一个失败，我们这边看到的是"策略未配置"，Cube 侧看到的是"measure 未定义"——排查时
很容易各自往错的方向找（我们一开始就在查授权/权限）。建议 Cube 侧把 plan 拒绝原因
（未定义 measure/member、聚合不允许等）透到错误文本里，网关别统一裹成"策略未配置"。

## 我们这边确实有责任的部分

1. 目录里 Cube 自己已经写了这句话：「**此包全部列均为 dimensions，不在 measures 中引用；
   不自动生成 SUM 指标**」，模型也看到了（在成员明细那次返回里），但还是把 `qty` 写进
   `measures`——说明这条只写在**模型描述**里、埋在长文本中间，约束力不够。
2. 我们自己的输出当时没有一条**明确动作规则**：索引行只写"维度 17 / 度量 0 / 分段 0"，
   没有告诉模型"度量为 0 意味着数值字段也只能放 dimensions"。
3. 每轮注入的取数协议（`gea:gateway-mcp-protocol`）当时也没提 measures/dimensions。

## 已做的修复（本轮）

| 位置 | 改动 |
|---|---|
| `src/host/gateway-catalog.ts` 索引 | 度量数为 0 的模型直接在行内标注「（无度量：所有成员都是维度，只放 dimensions）」，并在末尾补一句总规则：只有列在"度量"里的成员才写进 measures |
| `src/host/gateway-catalog.ts` 成员明细 | 没有度量的模型输出「度量：无（这个模型没有定义 measure：所有成员一律放 dimensions，数值字段也不要写进 measures）」，表头也加同一句规则 |
| `src/host.ts` 注入协议 | 新增一条：成员放 dimensions 还是 measures 由目录标出的类型决定；标了"无度量"的模型全部放 dimensions，写进 measures 会被上游拒绝整批查询计划 |
| `src/host/agent-tools.ts` 目录工具说明 | 同步这条规则，模型在调目录前就知道 |
| `tests/gateway-catalog.test.mjs` | 钉住索引/明细两种输出都必须带这条规则，且**有度量**的模型不能被误标"无度量" |

## 仍然需要 Cube 侧配合

- 把 plan 拒绝原因透出来（现在统一是"网关策略未配置数据授权"，与真实原因不符）。
- 如果这些 cube 确实应当有 measure（比如库存量、需求量），把它们定义为 measure；
  否则我们会一直按"全部是维度"的约定生成查询——这需要和语义模型维护方对齐口径。
