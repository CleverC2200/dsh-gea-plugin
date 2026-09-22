# GEA 对话取数与页面联动的执行逻辑

这份文档说明"用户在业务页面右侧提问，到拿到答案"这条链路**现在是怎么执行的**，以及这条链路是怎么
从源码走到 0.0.100 这个版本的。它是实现说明，不是需求文档：每一节都能对应到仓库里的文件。

适用版本：`gea-v0.0.100`（源码提交 `9afbada`）。

---

## 一、一句话总览

把"垂直堆叠的业务模块"（页面 + 数据 + 提示词 + 查询）用一份**能力契约**统一暴露给同一个对话入口，
对话侧只认契约、不认具体页面；取数与操作一共**三条通道**（页面证据 / 页面桥 / 模块 MCP），
宿主先算出"该走哪条"再交给模型，每条通道都有硬边界、预算和止损。

> **问答侧不写 SQL**：受管只读 SQL（`/ai/gateway/sql/execute`）默认**关闭**，模型看不到
> `gea_plugin_read` 这个工具。原因与开关见第十节。

```
用户在右侧提问
      │
      ▼
┌──────────────────────────────────────────────┐
│ 宿主先算清楚：当前页是谁、命中哪个模块、该走哪条通道 │
│ （capability/* + host/page-identity.ts + channel.ts）│
└──────────────────────────────────────────────┘
      │  工具说明 = 契约编译出来的（只给名称与一句话）
      ├─────────────┬─────────────┬─────────────┬─────────────┐
      ▼             ▼             ▼             ▼
 ① gea_page    ② 页面桥       ③ gea_module_mcp  ④ gea_plugin_read（默认关闭）
 读这一屏/页面动作 改草稿/审批   模块自带查询      受管只读 SQL + 配方
      │             │             │             │
 宿主内部       AG-UI → iframe   /ai/gateway/    /ai/gateway/
 页面 context   页面执行→回执     mcp/proxy/mcp   sql/execute
```

---

## 二、分层与文件地图

| 层 | 职责 | 文件 |
|---|---|---|
| 契约层 | 每个模块声明：页面、可读数据、动作上限、技能、路由；派生出能力层 | `src/capability/{contract,registry,layers,recipes,draft}.ts` |
| 路由层 | 宿主算"当前页是谁、该走哪条通道" | `src/host/page-identity.ts`、`src/capability/channel.ts` |
| 执行层 | 四条通道各自的落地与回执 | `src/page-bridge/*`、`src/host/mcp-client.ts`、`src/host/gateway-mcp.ts`、`src/html-query.ts`、`src/host/plugin-query.ts` |
| 上下文层 | 进模型前统一压缩、按需展开 | `src/shared/payload-budget.ts`、`src/host/agent-tools.ts`、`src/html-plugins.ts` |
| 业务层 | 各模块自己的页面 / SQL / 口径 / 技能 | 插件包 `plugin.json`、`skills/*`、`index.html`；原生命中页 `src/workbench/*` |

契约**由事实派生**，不需要模块多交文件：`plugin.json`（页面）+ `mcp.json`（受管查询）+ `SKILL.md`
（口径）+ 页面里的 SQL（可读表）→ `contractFromPlugin()` 生成一份 `CapabilityContract`。

---

## 三、一次问答的完整链路

### 第 0 步：提问之前（页面打开那一刻，宿主已经做完）

| 动作 | 位置 | 结果 |
|---|---|---|
| 打开页面 | 客户端 → `/api/gea-html/<模块>/open` | 建页面 lease（空闲 5 分钟过期） |
| 记录"当前页身份" | `host/page-identity.ts`、`business.touchPageIdentity` | `{模块 id, consumerCode, 模块名, 页面工具, 是否演示页}`，**TTL 90 秒**；页面每秒轮询会刷新，切页自然换人 |
| 扫描/接自述这一屏 | `html-page-scan.ts` → `page-bridge/registry.ts` | 为该会话注册页面桥工具 + 元素目录（元素上限 300，逐条列出上限 120） |
| 原生命中页上报可见行 | `workbench/page.tsx` → `host.ts` | 只有原生工作台页有"当前可见行"快照 |

### 第 1 步：发问 → 组装模型请求

1. **用哪个 GEA agent**：`agentCode = 当前页身份对应的 consumerCode`（没页面才回落默认）；
   网关据此注入该模块的系统提示词 —— 这就是"模块技能跟着页面走"。
2. **带什么工具**：`gea_module_mcp`（说明里内嵌契约生成的**模块清单**）、
   `gea_visible_workbench_context`、`gea_page`（唯一页面入口）、页面桥工具、`gea_sales_plan_read`、
   `gea_gateway_catalog`（网关语义模型目录，执行走 MCP）、渲染类工具。
   `gea_plugin_read` 只在部署配置打开 `agentSqlRead` 时才注册；那时模块清单挂在它身上，
   MCP 说明里不再重复挂一份。
3. **说明文字只给"名称 + 一句话"**，细节按需取（见第六节）。

### 第 2 步：模型选通道（宿主已经把顺序算好）

| 问题类型 | 走哪条 | 说明 |
|---|---|---|
| "这一屏 / 这几行 / 这家客户" | `gea_page`（action=context，可带 focus）→ 拿页面证据 | 快照里已有那行就直接答，不再跨模块取数（先答后取） |
| "改草稿 / 筛选 / 审批" | 页面桥工具（`gea_plugin_page_apply` 或 `gea_workbench_apply`） | 先 `directory=true` 取字段索引，再 `invoke/setValue/select/clear` |
| "按月 / 按范围 / 跨模块" | `gea_module_mcp`（模块自带查询 + 网关 `query_business_data`）；计划事实另有 `gea_sales_plan_read` | 先只传 `consumerCode` 列工具，再 `tool` + `arguments` 调用；写入前先用 `gea_gateway_catalog` 取语义模型成员名 |

宿主侧的硬边界（避免模型自己猜）：

- 页面入口**只有一个** `gea_page`，按当前页身份路由 —— 构造上不存在"挑错模块的页面工具"。
- HTML 插件页没有可见行快照时，`gea_visible_workbench_context` 返回 `PAGE_HAS_NO_SNAPSHOT`
  + 当前页身份 + 该用哪个工具，而不是含糊的"不在业务工作台"。
- 没有打开任何页面时返回 `PAGE_NOT_IN_WORKBENCH`，并明确"不要因此拒答，走直读"。
- 同一轮里第二次读同一屏且页面没变 → `PAGE_CONTEXT_ALREADY_READ`（窗口 90 秒）。

---

## 四、通道对照

| 工具 | 是什么 | 链路 | 边界 |
|---|---|---|---|
| `gea_page` | 宿主工具：读这一屏 / 执行页面自述动作 | 宿主 `sessions.invoke` → 页面 context | 只作用于当前页；context 默认只回摘要 |
| 页面桥 `gea_plugin_page_apply` / `gea_workbench_apply` | 页面桥（**不是 MCP**）：改草稿、筛选、审批 | 对话 → AG-UI 前端工具事件 → 同源 iframe → 回执 | 只读元素永不下发写；提交/审批必须页面声明可点且带 `confirm=true`；限流与超时见第七节 |
| `gea_module_mcp` | **唯一的 MCP**：模块自带查询 | `/ai/gateway/session` 申请 → `/ai/gateway/mcp/proxy/mcp` | 只读清单过滤（`readOnlyHint:false` / `destructiveHint:true` 剔除）；权限不足按业务状态返回 |
| `gea_plugin_read`（默认**不注册**） | 受管只读 SQL + 配方 | `/ai/gateway/sql/execute` | 只允许只读语句；参数化；pageSize 钳到 200；同模块失败熔断。问答侧默认关闭，见第十节；页面自己的受控查询仍然走这条链路 |

---

## 五、页面身份：为什么需要、怎么维护

**问题**：模型手上曾同时有 9 个模块的页面工具，而"人正看着哪个页面"没有任何权威信号 —— 实测出现
"人在经销商库存页、会话还绑着客户库存"，模型读错模块后只能拒答。

**做法**：

1. 页面每一次活动（打开、每秒轮询、调用）都刷新宿主侧身份；90 秒没活动才算没有页面。
2. 页面关闭只清属于它的那一份；登录/换环境整体清空。
3. 页面入口合并为**唯一** `gea_page`，执行时按身份找到对应模块；不在当前页就没有"读错页面"这条路。
4. 模型侧 agentCode 也读这份身份，所以技能/口径跟着页面走。

---

## 六、上下文预算与渐进式暴露

原则：**固定开销按"名称 + 一句话"给，明细按需取，超预算自动压缩。**

| 位置 | 规则 | 常量 |
|---|---|---|
| 只读工具索引 | 只给"模块名 + consumerCode + 一句话 + 能力层"；表、列、配方、口径走 `describe=true` | 索引实测 12 个模块 2,199 字节 |
| 页面工具说明 | 只给数量（可操作 / 可编辑 / 提交类 / 审批类），元素目录走 `directory=true` | 91 元素页实测 19,806 → 890 字节 |
| 元素目录 | 默认只给字段索引（id / 名称 / 能否改）；要当前值再带 `values=true`；可 `focus` 收窄 | 命中一行时 250 字节 |
| 页面上下文 / 可见行 | 不带 focus 只回摘要（行数 + 字段名，**不带整行**）；带 focus 只留相关行并标注省略数 | 预算 `MODEL_PAYLOAD_BUDGET = 12_000` 字节，限 20 条 / 每条 200 字符，摘要不带样本行 |
| 重复读取 | 同一屏第二次且内容未变 → 只回 `{"unchanged":true}` | 页面级按会话记忆，登录变化清空 |

实测（同一条会话对比）：每次请求的工具定义 **46,402 → 约 10,700 字节**；页面上下文
**17,227 → 760（摘要）/ 3,096（带 focus）字节**。

---

## 七、失败语义与止损

先把失败**分类**，再决定"报错"还是"正常说明"：

| 情况 | 表现 | 理由 |
|---|---|---|
| 权限未开通（`AGENT_ACCESS_DENIED`） | **正常结果** `availability=permission-required` + 需要管理员开通 + 可先用页面/直读 | 是业务状态，不是调用失败 |
| 演示（mock）模块 | 正常结果 `availability=mock-module` | 没有真实数据通道，不去撞网关 |
| 页面没打开 / 不在工作台 | 正常结果 `PAGE_NOT_IN_WORKBENCH` | 影响"这一屏"类问题，不影响数据问题 |
| 网络 / 5xx / 协议错 / 会话失效 | 抛错（会话里显示为红色失败） | 真故障 |
| 同一模块反复失败 | 熔断：`GEA_PLUGIN_RETRY_STOPPED` | 连续 3 次 / 10 分钟窗口 |
| 网关拒绝过 MCP 会话 | 10 分钟内不再重试同一模块 | `MCP_REJECTION_TTL_MS = 10 分钟` |

能力层的策略数值集中在一处（`capability/layers.ts`），页面动作超时、限流、回执、确认都引用它：

| 层 | 超时 | 每分钟上限 | 回执 | 需复述确认 | 写业务数据 |
|---|---|---|---|---|---|
| read | 60s | 120 | 否 | 否 | 否 |
| draft | 8s | 30 | 是 | 否 | 否 |
| submit | 55s | 6 | 是 | **是** | 是 |
| approve | 55s | 6 | 是 | **是** | 是 |
| export | 60s | 12 | 否 | 否 | 否 |

---

## 八、网关 MCP 的协议细节（本轮修的真 bug）

**现象**：模块 MCP 一律失败，`tools/list` 返回 400，而会话申请与 `initialize` 都是 200。

**定位过程**（可复现）：

1. 加一个只在 `GEA_DEBUG_PROBE=1` 时注册的调试入口
   `POST /api/gea-proof/debug/mcp-probe {consumerCode}`，把每一段 HTTP 的
   请求头/请求体/状态码/响应体带回来。
2. 对比发现：`initialize`、`notifications/initialized` 都带 `MCP-Protocol-Version`，
   而 `tools/list` **没带**；把那条请求原样重放、只补这个头 → 200 并列出工具。

**修复**：`host/mcp-client.ts` 记住协商成功的协议版本，`tools/list` 与 `tools/call` 都带上
`MCP-Protocol-Version`。回归测试断言四个请求都带该头。

修复后逐个模块真跑的结果（dev 账号）：**4 个可调用**（安全库存 6 个工具、经销商库存 5、
分仓库存 5、全链路库存 5），**8 个 `AGENT_ACCESS_DENIED`**（权限未开通，需 GEA 侧开）。
完整原始报文见 `docs/reports/mcp-channel-probe-20260922.md`（同目录 `.json`）。

---

## 九、受管只读 SQL 的参数与提示

- 占位符两种都支持：`:name`（推荐）与 `?`（对象按数字键排序、数组按原序）。
- 值永远走绑定参数，不拼进 SQL；`parameters` 传空对象当没传。
- 数量对不上 → `POSITIONAL_QUERY_PARAMETER`；混用 → `MIXED_QUERY_PARAMETERS`；
  给了参数但 SQL 里没引用 → `UNUSED_QUERY_PARAMETER`。
- 失败提示**按原因分流**：参数类只说占位符写法；表/列未发布才让 `describe=true`；
  其余（例如网关受控 SQL 执行失败）提示先核对列名并收窄聚合口径。
- **配方（recipe）** 常见问题优先用，执行时不会把 `recipe` 透传给受管查询（曾经的
  `INVALID_PAYLOAD` 就是这样来的）。

---

## 十、问答侧不写 SQL（默认关闭）

**现在问答只允许用 MCP 取数**：模型工具清单里没有 `gea_plugin_read`，取数只剩
`gea_module_mcp`（模块自带查询 + 网关 `query_business_data`）、`gea_sales_plan_read`
和页面证据。开关是部署配置 `agentSqlRead`，默认 `false`。

为什么关（本机全部会话的实测，13 条失败 SQL 逐条对过真实列清单）：

| 失败类别 | 条数 | 例子 | 责任方 |
|---|---|---|---|
| 双 LIMIT：模型自己写 `limit 30`，宿主又追加分页 `LIMIT/OFFSET` | 3 | `... group by ... limit 30` | 宿主整形 |
| 日期列当文本或参数用 | 9 | `where target_month = :m`、`where target_month like '2026-1%'`、`substr(snapshot_date,1,7)` | 写法不兼容网关绑定 |
| 列名/函数不存在 | 4 | `snapshot_date`（真名 `inventory_snapshot_time`）、`sku_code`、`live_qty`（真名 `qtylive`）、`datediff` | 模型猜列名 |

而网关只回一句「受控 SQL 执行失败」（业务码 500），**不给原因码**，定位只能靠猜。

边界与后果（必须知道）：

- **只影响问答侧**。业务页面自己的受控查询、页面桥、页面证据照旧；
  `gea_plugin_read` 的代码与测试都还在，部署配置写 `agentSqlRead: true` 就能整体打开。
- **MCP 权限决定可问范围**。按 2026-09-22 的逐个探测，12 个模块里只有 4 个 MCP 可调用
  （基地安全库存 / 经销商库存 / 分仓库存 / 全链路库存），其余 8 个是 `AGENT_ACCESS_DENIED`。
  关掉 SQL 之后，这 8 个模块的问答取数会变成"没有可用通道"——要么让 GEA 侧开通 MCP 权限，
  要么把那几个模块的问答按"资料不足"如实作答。
- 通道计划 `channelPlan` 同步收口：关掉后不再出现"③受管只读"，只留"①当前页 → ②模块 MCP"。

---

## 十一、本轮从源码到 0.0.100 的发布流程

1. **刷新远端 main** → `071bb81`；从它拉 `codex/release-gea-0.0.100`。
2. **合并** `codex/page-bridge-v3`（25 个提交）。冲突 4 个文件，按"保留 main 新基线 +
   叠加契约驱动实现"解决；并修两处合并回归（契约集为空时白名单兜底、空 `parameters` 误判）。
3. **版本** 0.0.99 → 0.0.100；`pnpm release:preflight --base-tag gea-v0.0.99` 通过。
4. **候选验证**：`typecheck` 干净；host/client/workbench 构建成功；全量 367 例 / 350 过 / 17 挂，
   **失败集合与 main 基线逐条一致**（无合并回归）；新增 75 例全过。
5. **推送 + MR**：分支推送 → API 建 MR **!122** → 按本仓库约定**本地快进**
   `git push gitlab <branch>:main` → 读回 `state=merged`、`merge_commit_sha=9afbada`。
6. **打包**（在合并后的 main 上）：`pnpm package` → `cleverc2200-gea-dsh-prototype-0.0.100.tgz`，
   2,070,764 字节，sha256 `e3cc317339bb2b590ce2920d212113b26eaac01cdbb555323ed8a0498dd93459`。
7. **双通道发布**：
   - OSS（默认）：包 → `plugin-release/packages/<sha256>/`；两份频道
     `plugin-release/channels/dsh-0.1.6-{test,stable}.json` 更新为 0.0.100。
   - GitLab（过渡期，老客户端）：包提交 `e705c1d`、频道提交 `49fb570` 推到发行库 main。
8. **发布后校验**：OSS 侧逐条匿名下载 4 包 × 2 频道，sha256 全部一致；GitLab 侧
   `check_channel.py --online` 两份 `ok:true`；匿名列桶仍 403。
9. **标签**：`gea-v0.0.100` → `9afbada`（已推、已读回）。
10. **本地同步**：源码库 main = `9afbada`，发行库 main = `49fb570`。

---

## 十二、已知限制与下一步

| 项 | 现状 | 下一步 |
|---|---|---|
| 8 个模块 MCP 不可用 | 网关 `AGENT_ACCESS_DENIED`（含真实的"库存管理工作台"） | 需 GEA 侧开通 Agent/模块权限；开通后不用改代码 |
| 能力层 | 只做到"策略数值单一来源 + 契约声明/派生" | 按层拆成独立实现（读/改草稿/提交/审批/导出各一个统一实现） |
| 历史折叠 | 同屏不重复已做；旧轮次折叠未做 | 需要 DSH 支持历史改写或在会话层实现 |
| 桌面更新链路 | 未验证 | 在一台装客户端的机器上更新到 0.0.100，确认插件中心更新成功、业务页正常 |
| `render_ui` + `validate_dsh_ui` | 两个常驻工具（约 2.8KB） | 属 genui 插件，本仓库改不了；可在 genui 侧合并 |

---

## 十三、命令速查

```sh
# 用当前源码起 dev 客户端（本机 3199）
corepack pnpm start --dev --config gea.config.json \
  --runtime .runtime/workbench-development --port 3199

# 逐个模块探测 MCP（需要 GEA_DEBUG_PROBE=1 启动；原始报文会带回来）
curl -s -b <dev cookie> -X POST http://127.0.0.1:3199/api/gea-proof/debug/mcp-probe \
  -H 'content-type: application/json' -d '{"consumerCode":"branch-inventory"}'

# 发行前检查
pnpm typecheck && pnpm release:preflight -- --base-tag gea-v<上一个版本>
pnpm package

# 频道校验（GitLab 清单；OSS 清单用匿名下载 + sha256 比对）
python3 skills/dsh-plugin-release/scripts/check_channel.py channels/dsh-0.1.6-test.json \
  --repo . --online
```
