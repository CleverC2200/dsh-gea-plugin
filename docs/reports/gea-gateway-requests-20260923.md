# 给 GEA 网关侧的三条改进请求（2026-09-23）

以下都是客户端实测到的原样证据，不是猜测。相关代码已经按"客户端能做的先做掉"处理，
这三条是**必须服务端配合**的部分。

## 1. `query_business_data` 的 `queries` 需要真的 schema

现状（我们探测到的原样定义）：

```json
{"name":"query_business_data",
 "inputSchema":{"type":"object","properties":{
   "action":{"type":"string","enum":["inspect","query"],"description":"…"},
   "queries":{"type":"array","description":"query 时传 1 到 8 个具名 Cube JSON Query。",
              "items":{"type":"object","properties":{}}},
   "response_mode":{"type":"string","enum":["resource","inline_complete"]}},
  "required":["action","queries"]}}
```

`queries.items.properties` 是**空的**：模型看不到 `dimensions / measures / filters /
order / limit` 的形状，只能猜；猜错被 `AI_SCHEMA_INVALID` 拦下之后再改——每一次都是
"先错一次"。实测错误：

```json
{"businessCode":"AI_SCHEMA_INVALID","suggestedAction":"FIX_ARGUMENTS",
 "details":{"stage":"ARGUMENT_VALIDATION","path":"queries[0].query.order"},
 "message":"queries[0].query.order：order 数组元素必须为 [成员,方向]；推荐使用对象 {成员名: asc或desc}",
 "requestId":"54fa2ee8-fd5d-421a-a7d2-a830e0f876cc","traceId":"9354475a-5081-4520-821f-701414a89e46"}
```

请求：把 `queries`（至少 `order` 的两种合法形状、`filters` 的 `{member,operator,values}`、
日期成员用 `YYYY-MM-DD`）写进 `inputSchema`。schema 一旦有了，客户端会把提示词里那几行
"临时说明"删掉，以 schema 为唯一契约。

## 2. 失败信封请统一到一处

客户端实测收到过三种长相：

1. 顶层：`{"success":false,"businessCode":"MCP_UPSTREAM_TOOL_ERROR",…}`；
2. 藏在结果里：`{"result":{"isError":true,"structuredContent":{…同上…},"content":[…]}}`；
3. `content[].text` 是**对象**（不是字符串），内容同 `structuredContent`。

请求：统一成 `result.structuredContent` + `result.isError=true`，`content[].text` 只放
同一份内容的字符串形式（或直接省略）。现在客户端为了兼容三种长相写了分支，别家客户端
大概率是直接踩坑（我们这边以前的症状就是"报错当成数据展示"）。

## 3. 下游失败要带真实原因，并把 requestId 透下去

现状：

```json
{"businessCode":"MCP_UPSTREAM_TOOL_ERROR","category":"UPSTREAM",
 "suggestedAction":"CHECK_UPSTREAM_LOGS",
 "message":"下游工具执行失败，请按 requestId 查看下游工具错误记录",
 "requestId":"37fff70a-0705-4f82-892c-41b10229096e",
 "traceId":"63ebc93d-eac1-4ff0-b978-bd49df230322",
 "auditId":"0de9fbd3-1535-45f5-adf5-71f6aee157a0"}
```

但按这三个号在 cube-core（`cube-core` 容器，2026-09-23 01:20–01:35 UTC 窗口）里搜
**一条都没有**：`docker logs --since 6h cube-core | grep -E "37fff70a|63ebc93d|0de9fbd3"`
无输出。也就是说 `CHECK_UPSTREAM_LOGS` 现在查不到东西。

请求：要么把下游的真实原因（Cube 的 `queryId` / 报错原文）直接放进 `message`，
要么把 `requestId/traceId` 透传到下游日志里。两条都不做，这句 `suggestedAction`
就是空头支票。

## 4. 补充（同日，来自桌面端真实截图）：分类会把写法问题标成授权问题

`AI_GATEWAY_DATA_PERMISSION_DENIED` 还被用在"跨模型查询"上：

```json
{"businessCode":"AI_GATEWAY_DATA_PERMISSION_DENIED","code":"AI_GATEWAY_DATA_PERMISSION_DENIED",
 "category":"AUTHORIZATION","success":false,
 "requestId":"be732058-e66e-4b63-b252-09cf230f8125",
 "traceId":"1ba26e37-253d-42d6-9093-641873f7d6c6",
 "message":"Cube 查询成员未唯一匹配数据目录资源；模型须与 dataAssetCode 一致，跨模型查询请分别调用"}
```

这条的真实含义是"一次查询里混了多个模型"（`details` 里也没有 `path`，只有 message），
但码和 `category` 都指向"授权"。按授权去排查会白跑；客户端现在只能靠 message 里的
关键词（`dataAssetCode` / 未唯一匹配）把它归类成写法问题。

请求：跨模型/成员不匹配这类**参数与数据目录**问题，请用 `VALIDATION` 类码
（并带上 `details.path`），别复用 `AUTHORIZATION` 的码。

## 附：平台直挂的 `mcp__gea-gateway__*` 不走本仓库的翻译

桌面端同时存在 `dsh-agent-manage` 直挂的 `mcp__gea-gateway__*` 工具（含它自己的
`dsh_read_resource`）。模型一旦走那条路，失败就是**原始 JSON 报文**（截图里
`Error: {"retryable":false,"businessCode":"MCP_UPSTREAM_TOOL_ERROR",…}`），
宿主这边的错误翻译、资源内联与熔断都不生效。我们已在注入协议里要求统一经
`gea_module_mcp` 调用；如果希望彻底避免两条路并存，需要 agent-manage 侧调整直挂策略。

## 客户端已经做掉的部分（不需要服务端配合）

- 失败优先判定（顶层 / structuredContent / 对象 text 三种都认），不再把失败当数据；
- 按错误类型给动作：参数校验类允许改参数重调、权限类如实说明、下游类给 requestId 与
  `retryable` 指引；
- 工具入参 schema 两级取用：`gea_module_mcp` 摘要照旧，`tool=名称 + schema=true` 回服务端
  完整定义（2KB 上限）；服务端没声明的形状如实写"未声明"，不另造契约。
