# Cube MCP 发送前预检与通道标注（2026-09-23）

依据：`GEA-CubeMCP外部调用规约-20260923(1).md` 的 **Agent 执行硬规则 G1–G8** 与 **§17 发送前预检**。
改动范围：只改 DSH/GEA 插件（宿主侧）。**没有改 Cube 侧 MCP，也没有改生产授权。**

## 一句话

规约把责任写死了：**发送前的确定性校验必须由调用层做，LLM 只提业务意图**。
原来这些约束全靠提示词，线上结果是"发出去被网关拒 → 模型读错误文本 → 改一次"，
一轮里十几步返工。这次把能确定性判断的四类错误挪到宿主闸门，并把"哪张表用哪条通道查"
告诉模型。

## 改了什么

| 项 | 位置 | 说明 |
| --- | --- | --- |
| 出站预检闸门 | `src/host/cube-preflight.ts`（新增） | G3 结构 / G4 单模型 / G5 成员与类别 / G6 排序分页筛选，一次列全同类问题并给出 `path` |
| 接进发送点 | `src/host/agent-tools.ts` | `gea_module_mcp` 调 `query_business_data` 前调用闸门；清单不在手时**先补读一次 inspect**（G5 要求持有当前 inspect） |
| 成员清单增强 | `src/host/member-index.ts` | 清单额外记时间成员（`time`），用于判断 `timeDimensions` 用得对不对 |
| 模型 → consumerCode | `src/host/catalog-consumers.ts`（新增） | 目录会话看到的模型，就是这个 consumerCode 能查的模型；目录明细直接标出来 |
| 模块清单反向标模型 | `src/host/agent-tools.ts`、`src/host/catalog-consumers.ts` | `gea_module_mcp` 列工具时一并给出该 consumerCode 能读到的模型名（只给名字） |
| 通道白名单 | `src/host/business.ts` | 受管通道额外允许宿主自己的分析身份（`analysisAgentCode`），它不是"换身份探测"，而是与目录通道对齐 |
| 目录缓存随身份失效 | `src/host.ts` | 换账号/环境时清空成员清单与模型→通道映射 |
| 限流 | `src/host/gateway-mcp.ts`、`src/host/mcp-client.ts` | HTTP 429 + `Retry-After` 与 **HTTP 200 + 业务信封**两种限流都认，给等待时间 |
| 权限诊断 | `src/host/mcp-client.ts` | 保留 `reasonCode/resourceCode/configurationPath/decisionId`，"缺哪一项"能说清 |
| 结构性缺口账本 | `src/host/cube-gap-ledger.ts`（新增） | 某个（模块 + 模型）确认取不到时记一笔，第二次同样组合直接给结论；TTL 10 分钟、换身份清空 |
| 同类问题一次全改 | `src/host/mcp-client.ts` | 网关一次只报一个位置，提示里补上"其它 query 的同类问题一并核对"（规约 §17） |
| 请求体体积 | `src/host/cube-preflight.ts` | `CUBE_MAX_REQUEST_CHARS=32000`，超了拦下并给拆调用建议（规约 §17.8） |
| 提示词瘦身 | `src/host.ts` | 宿主已确定性拦下的写法规则从提示词删掉，只留"业务意图怎么表达" |

## 为什么这样改

1. **位置**：规约 §17 明确"发送前预检必须由调用层确定性执行"。提示词是软的，且每次都要占上下文；
   宿主闸门可单测、可验收。线上已经验证过"说明里写只读一次，模型没读"这类事。
2. **不做完整 JSON Schema 引擎**：网关同步给外部的 Schema 把 `queries.items.properties` 简化为空
   （规约 §4 自己写明），本地拿它做全量校验只会给出"通过"的假安全感。所以用"结构 + 成员目录"
   两层确定性校验，覆盖 §17.4–17.6 的实际失效模式，且不新增依赖。
3. **跨模型给拆分方案，不是只报错**：G4 要求拆成多次调用，所以拦下时直接按模型分组给出
   "每次该带哪些成员"，一步到位，避免"改一个再撞一个"。
4. **不猜授权**：资源 ALLOW、方案匹配、用户业务范围只有网关知道（§12）。本地只判"必然被拒"的形态，
   权限相关一律如实回报并保留诊断字段，不把"没授权"说成"参数错"。
5. **不做按问题特化的规则**：所有判据都是"Cube 通用形状 + inspect 成员目录"，没有任何一条认识
   "库龄""安全库存""销售计划"这种业务词。

## 边界与取舍

- **limit 上限用"拦下 + 给分页方案"，不用静默钳制**：静默把 5000 改成 1000，模型会以为拿到了全量。
  当前阈值 `CUBE_MAX_LIMIT = 1000`，只挡"明显想拉全表"的写法；真实行数/字节闸门仍在网关。
  规约 §16 明确某个 Agent 的 maxRows/maxBytes 不能外推到别的 Agent，所以这里不假装是授权上限。
- **可见 ≠ 已授权**：模型→consumerCode 只回答"用哪条通道"，目录里同时写明"不代表每行数据都已授权"。
- **清单不在手时不编造结论**：只做形状校验，成员存在性与类别校验留到清单拿到之后（fail-open，
  宁可漏拦也不拿旧清单拦住对的成员）。

## 怎么验收

单测按规约 §18 的反向清单逐条钉（`tests/cube-preflight.test.mjs`、`tests/catalog-consumers.test.mjs`、
`tests/module-mcp.test.mjs`、`tests/gateway-mcp.test.mjs`）：

- 格式反向：裸字段、缺 `query` 外壳、`order` 对象数组、未知 query 字段、字符串 `limit`、
  重复 `name`、超过 8 项 —— 全部本地拦下、不发请求；
- 模型反向：different 模型混在一次调用里 —— 发送前拒绝并给拆分方案；
- 语义反向：数值维度放进 `measures`、字符串日期放进 `timeDimensions` —— 发送前拒绝；
- 权限反向：失败不被当作空数据或成功，诊断字段保留；
- 限流：429 与 200 信封都给等待建议，不当作参数错误。

## 还没做 / 需要外部配合

### 追加一轮（同一会话 session-af74ce65 的复盘后修复）

那次一轮 117 步、224 次调用、11 分钟，最后被用户中止。复盘出三件事，都已修：

| 问题 | 修法 | 位置 |
| --- | --- | --- |
| 点停止后界面显示 `Error: [object Object]` | 中止信号的对象 reason（dsh 中止时携带）在最早边界翻成可读的 `GEA_TURN_ABORTED: 已中止…`；中止不计熔断、不计白跑 | `src/shared/abort.ts`（新增）、`mcp-client.ts`、`gateway-mcp.ts`、`agent-tools.ts` |
| 首步目录失败只报 `GEA_CATALOG_RESOURCE_MISSING: tools=5`，真因被吞 | 拿不到制品 URI 时把原始返回前 200 字带出来；同时支持 inspect 直接内联 JSON | `src/host/agent-tools.ts` |
| 同一份东西被反复读（同一模型明细 31 次、索引 24 次、同一条计划查询 15 次） | 新增重复读闸门：同一 key 最多认真回 2 次，一轮累计重复 8 次就停手；换问题（新一轮）自动清零 | `src/host/repeat-guard.ts`（新增）、`agent-tools.ts`、`turn-anchor.ts`、`host.ts` |

### 再追加一轮（"年月误拦"复盘）

截图里的 `入参预检未通过：filters 里出现了只有年月的值 2026-10` 是**误伤**：那次过滤的
`agents_sales_plan_detail_mi.plane_date` 声明类型是 **string**、真实值就是 `2026-01`…`2026-08`
这种文本年月，拿 `2026-10` 过滤它是合法写法（实测 `contains "2026-10"` 就是它的正常用法）。
而提示里"写完整日期 / 用该月第一天"的导向在这列上**必然 0 行**，等于把人往更错的方向推。

| 问题 | 修法 | 位置 |
| --- | --- | --- |
| 年月拦截拿单个样本（safety_stock.target_month 是真 date 列）当全局规则，误伤文本年月列 | 改成**按类型判**：只有目录里声明 time 的成员才拦；string 年月列与"类型未知"一律放行；提示改成"筛整月用 timeDimensions/dateRange 或 gte+lt，不要 equals 该月第一天" | `src/host/cube-query-guard.ts`、`cube-preflight.ts` |
| 取样一次传 6 个成员，一个错名字就整批"取不到样例值" | 改成**一个成员一条具名查询**（一条 tool 调用最多 6 条），坏成员不拖垮整批；并把 `limit 1` 改成 `limit 5`，直接给**取值分布**（只有空串 / 只有一个值 / 覆盖哪些月份） | `src/host/agent-tools.ts`、`gateway-catalog.ts` |
| 模型一直靠"猜一个取值去过滤"，0 行后换写法继续试 | 提示词加一条通用做法：**先看分布，再定过滤**——把成员当维度 + 配一个度量 group by 一次就能看到有没有值、有哪些值 | `src/host.ts` |
| 维度在这张模型里不可用（`region_name` 全空、`order_status` 只有一个值）时没人说清 | 取样结果直接标注"只有空串/只有一个取值：它答不了『有哪些取值』这类问题，请换模型或链路" | `gateway-catalog.ts` |

### 再追加一轮（取样跟制品 + 停手整轮生效 + 页面意图门控）

| 问题 | 修法 | 位置 |
| --- | --- | --- |
| 取样走 SDK 客户端、不跟 `resource_link`，6 个成员全被报成"取不到行"，模型据此写下"这张表没有品类字段" | 取样没有内联行时把制品读回来；解析同时支持 `datasets[]` 与 `queryArtifact.resources[].contents[].text`；文案改成"不能据此断言这张表没有数据/没有这个维度" | `agent-tools.ts`、`gateway-catalog.ts` |
| 停手只对当前工具生效，模型换个工具接着试（第 40 步停手后还跑了 15 步） | 新增整轮闸门 `business.turnStopped`：一旦触发，本轮所有取数工具只回"已停手" | `business.ts`、`agent-tools.ts` |
| 模型没用上已经拿到的数字 | 提示词两条硬规则：已拿到的数字必须写进答复（缺口只写缺的那层）；说"没有某个字段"前先回目录确认 | `host.ts` |
| 页面开着时位置提示与通道顺序默认引导"读这一屏"，一进对话就把整屏塞进上下文 | **默认不读页面**：新增页面意图判定（`page-intent.ts`，命中"这一屏/这几行/展开/选中/这单/当前页"等指代才算）；快照工具在生成前用宿主记录的本轮原话判意图，没有意图直接回 `PAGE_INTENT_MISSING`；位置提示与通道顺序同步改成"默认不要读" | `page-intent.ts`（新增）、`agent-tools.ts`、`workbench-surface.ts`、`channel.ts`、`business.ts`、`host.ts` |

1. **Cube 目录缓存没刷新**（实测 inspect 仍只显示旧度量）：缓存在网关/下游 MCP 侧，需要平台侧配合刷新；
   规约 §5 要求"查询前持有当前 inspect"，这条不解决，模型会继续以为没有度量可用。
2. **库龄资源缺 ALLOW、方案不匹配**（§16 快照）：属平台配置，参数改不动，只能如实回报。
3. `aps-plan-collaboration` 这类模块抽不出可读表（`tables: []`）：`describe` 只能如实回报。
4. 桌面更新链路与真机审批动作仍未跑（审批会写真实业务单，需要明确指令）。
