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

1. **Cube 目录缓存没刷新**（实测 inspect 仍只显示旧度量）：缓存在网关/下游 MCP 侧，需要平台侧配合刷新；
   规约 §5 要求"查询前持有当前 inspect"，这条不解决，模型会继续以为没有度量可用。
2. **库龄资源缺 ALLOW、方案不匹配**（§16 快照）：属平台配置，参数改不动，只能如实回报。
3. `aps-plan-collaboration` 这类模块抽不出可读表（`tables: []`）：`describe` 只能如实回报。
4. 桌面更新链路与真机审批动作仍未跑（审批会写真实业务单，需要明确指令）。
