# 模块 MCP 通道逐个探测（2026-09-22）

对象：`codex/page-bridge-v3` 工作树，dev 运行时（`GEA_DEBUG_PROBE=1`），生产环境
`https://gea.synear.cn/gea-boot`，登录账号 `10006800`（principal `2079086499998507009`）。

原始报文：同目录 `mcp-channel-probe-20260922.json`（每个模块的会话申请与代理调用，
请求体/响应体截到 1200 字符；token 类字段由 api-log 过滤，不落盘）。

## 怎么跑的

临时调试入口（只在 `GEA_DEBUG_PROBE=1` 时注册）：

```sh
curl -s -b <dev cookie> -X POST http://127.0.0.1:3199/api/gea-proof/debug/mcp-probe \
  -H 'content-type: application/json' -d '{"consumerCode":"base-safety-stock"}'
```

它按线上同样的顺序走一遍：`/ai/gateway/session` → `/ai/gateway/mcp/proxy/mcp` 的
`initialize` → `notifications/initialized` → `tools/list`，并把每段 HTTP 的
请求头/请求体/状态码/响应体带回来。

## 结果

| consumerCode | 模块 | 可否调用 | 工具数 | 失败原因 |
|---|---|---|---|---|
| base-safety-stock | 安全库存 | ✅ | 6 |  |
| dealer-inventory-replenishment | 经销商库存 | ✅ | 5 |  |
| branch-inventory | 分仓库存 | ✅ | 5 |  |
| full-chain-inventory | 全链路库存 | ✅ | 5 |  |
| inventory-personal-workbench | 库存管理工作台 | ❌ |  | `AGENT_ACCESS_DENIED`：当前用户无权访问该Agent |
| customer-inventory-preview | 客户库存（演示） | ❌ |  | 同上 |
| orderworkbench-preview | 订单工作台（演示） | ❌ |  | 同上 |
| orderfulfillment-preview | 订单履约（演示） | ❌ |  | 同上 |
| aps-board-collaboration | APS 产销协同看板（演示） | ❌ |  | 同上 |
| aps-demand-collaboration | APS 需求运营（演示） | ❌ |  | 同上 |
| aps-delivery-collaboration | APS 交付运营（演示） | ❌ |  | 同上 |
| aps-plan-collaboration | APS 产销协同工作台（演示） | ❌ |  | 同上 |

4 个可调用，8 个不可调用；8 个都是**权限**问题（网关在会话阶段就拒），不是代码问题。

## 修掉的一个真 bug：`tools/list` 缺协议版本头

修复前的原始报文（`base-safety-stock`，见 JSON 里 `raw`）：

| 步骤 | 请求头 | 状态 |
|---|---|---|
| `/ai/gateway/session` | version=2025-06-18 | 200（accessDecision ALLOW，拿到 delegation） |
| proxy `initialize` | version=2025-06-18 | 200 |
| proxy `notifications/initialized` | version=2025-06-18 | 202 |
| proxy `tools/list` | **无 `MCP-Protocol-Version`** | **400** |

同一会话下把那条 `tools/list` 原样重放、只补上 `MCP-Protocol-Version: 2025-06-18`
→ **200**，能列出 6 个工具。也就是说网关要求每个请求都带协议版本，而
`listModuleTools()` 只发了 `content-type` 与 `accept`（`initialize` /
`notifications/initialized` 都带了，`tools/call` 也漏了）。

修复：`src/host/mcp-client.ts` 记住协商成功的版本，`tools/list` 与 `tools/call`
都带上 `MCP-Protocol-Version`。回归测试：
`tests/module-mcp.test.mjs`（断言四个请求都带该头）。

## 仍未解决（需要网关/权限侧）

8 个模块在 `/ai/gateway/session` 就返回 `accessDecision.code=AGENT_ACCESS_DENIED`
（"当前用户无权访问该Agent"）。这属于 Agent 权限配置，需要在 GEA 侧给账号开通；
其中 `inventory-personal-workbench`（库存管理工作台）是真实模块，只是这个账号没权限。
在开通之前，宿主侧已经做了止损：这类失败 10 分钟内不再重试，演示模块直接不走 MCP。

## 补充：8 个到底是谁、真正要开通的只有 1 个（2026-09-22 复核）

12 个 consumerCode 与页面、结果对照（`mode` 取自插件包 `plugin.json`）：

| consumerCode | 模块 / 页面 | 页面 id | 页面 mode | 会话结果 | 工具数 |
|---|---|---|---|---|---|
| `base-safety-stock` | 安全库存 | inventory-aqkc | 真实 | ✅ ALLOW | 6 |
| `dealer-inventory-replenishment` | 经销商库存 | inventory-dealer | 真实 | ✅ ALLOW | 5 |
| `branch-inventory` | 分仓库存 | inventory-fc | 真实 | ✅ ALLOW | 5 |
| `full-chain-inventory` | 全链路库存 | inventory-qll | 真实 | ✅ ALLOW | 5 |
| **`inventory-personal-workbench`** | **库存管理工作台** | inventory-personal | **真实** | ❌ `AGENT_ACCESS_DENIED` | — |
| `customer-inventory-preview` | 客户库存（演示） | inventory-customer | mock | ❌ 同上 | — |
| `orderworkbench-preview` | 订单工作台（演示） | inventory-orderworkbench | mock | ❌ 同上 | — |
| `orderfulfillment-preview` | 订单履约（演示） | inventory-orderfulfillment | mock | ❌ 同上 | — |
| `aps-board-collaboration` | 产销协同看板（演示） | inventory-apsboard | mock | ❌ 同上 | — |
| `aps-demand-collaboration` | 需求运营（演示） | inventory-apsdemand | mock | ❌ 同上 | — |
| `aps-delivery-collaboration` | 交付运营（演示） | inventory-apsdelivery | mock | ❌ 同上 | — |
| `aps-plan-collaboration` | 产销协同工作台（演示） | inventory-apsplan | mock | ❌ 同上 | — |

**所以真正需要 GEA 开通权限的只有 1 个：`inventory-personal-workbench`（库存管理工作台）。**
另外 7 个是 `mode: mock` 的演示模块——页面数字本来就是原型数据，宿主在能力契约里已标记
`mock`，`gea_module_mcp` 遇到它们直接回 `availability=mock-module`，**不会去网关撞权限**。
之前"8 个模块要开权限"的说法过粗，按实际影响只有 1 个。

### 为什么判定是权限侧而不是我们没传凭据

8 个被拒的请求与 4 个通过的请求**形状完全一致**，只差 `consumerCode`：

```json
POST https://gea.synear.cn/gea-boot/ai/gateway/session
content-type: application/json
{"consumerType":"AGENT","consumerCode":"<模块>","conversationId":"<uuid>","requestId":"<uuid>","channel":"MCP_CLIENT"}
```

网关的回复（HTTP 200、`success:true`，也就是"受理成功但业务拒绝"）：

```json
{"success":true,"code":200,"result":{
  "accessDecision":{"allowed":false,"code":"AGENT_ACCESS_DENIED","stage":"AGENT","message":"当前用户无权访问该Agent"},
  "gatewayContext":{"tenantId":"0","principalType":"USER","principalId":"2079086499998507009","username":"10006800",
    "consumerType":"AGENT","consumerCode":"inventory-personal-workbench","agentId":"inventory-personal-workbench",
    "channel":"MCP_CLIENT","roleCodes":[],"departIds":["2081225579385356290"],"platformSuperAdmin":false},
  "effectiveCapabilityCodes":[], "delegationToken":null}}
```

三条判据：

1. **身份传到了**：网关回填了 `principalId/username/tenantId/departIds`，说明用的是当前登录用户，
   不是匿名或空凭据；被拒不是"没带凭证"。
2. **能力清单为空**：`effectiveCapabilityCodes: []`（0 条）——这个账号在这些 agentCode 上一条
   能力码都没有；对照 `base-safety-stock` 的 ALLOW 回复里有 `MCP:mcp.gateway.session`、
   `MCP_TOOL:…:query_business_data` 等。权限是**按 Agent/consumerCode 逐个配**的。
3. **拒绝发生在 `stage=AGENT`**：还没走到 MCP 网关本身，也没有 delegationToken；
   也就是说请求根本没被执行层看到，是权限判定先拦下的。

结论：**我们这边不需要改代码**；给账号 `10006800`（principal `2079086499998507009`）在
GEA 侧开通 `inventory-personal-workbench` 这个 Agent 的访问权限即可，开通后不用重发版本。
