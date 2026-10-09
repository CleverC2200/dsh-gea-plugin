# 当前开发改动清单（待用户确认，2026-09-24）

后续确认：用户在收到本清单及 D1–D3 明确说明后回复“没问题，发一版吧”，授权按全部开发改动继续提交、合并和发行。以下内容保留为确认时的审查基线；实际合并、修复与发行结果另记。

## 状态和审查范围

按用户最新要求，本阶段只梳理改动，等待确认后再提交、合并。此次发布准备尚未创建提交、合并分支、推送代码、打标签、上传发行包或修改频道。此前已完成的 Cube 服务器 7 个分段试点是另一项已落地事实。

| 项目 | 本次核对结果 |
| --- | --- |
| 当前工作树 | `/Users/synear/.codex/worktrees/adfd/dsh-gea-plugin` |
| 当前分支 / HEAD | `codex/preview-web-20260923` / `1de883bf9349ac40858ac1ae86a91a09f48fd90e` |
| 刚刷新后的远端 main | `17e9e5c536e24e13d7c201eee2828968ed4fc67d`，2026-09-24 14:07:19 +08:00 |
| 当前开发目录版本 / 主线版本 | `0.0.114` / `0.0.123` |
| 测试、正式频道 | 均为 GEA `0.0.123`；发行库 main 为 `bc52dc4a5c27ee010b06f1761f611787987313a7` |
| 已提交但不在 main 的历史 | 35 个提交，包含合并提交；main 另有 33 个本分支尚未合入的提交 |
| 未提交开发改动 | 58 个路径：29 修改、27 新增、2 删除；另有 2 个 `.DS_Store`，不视为开发交付内容 |
| 未提交审查快照 | tree `b8f7d7f322e394fb9a1675b1d40d518fd95ee7fd`；相对 HEAD 的 binary patch SHA-256 为 `ebee4f74d3826cf4ef0f813297bb8871a37185e8b4d5aa9467712173f7925eb3` |

快照通过临时 Git index 固定，没有改真实暂存区。测试结束后检查，工作区开发文件仍与这份快照一致。本清单本身不包含在上述 58 个路径中。

对已提交的 HEAD 与最新 main 做了 `git merge-tree` 预演，未报告文本冲突，得到 tree `d9da0da4f62b9ea73a7305358032d3ecefef6a3b`；预演相对 main 涉及 62 个路径，无文件删除。**该预演尚未包含上述 58 个未提交路径，不是最终候选或合并验收。** 两份路径集合有重叠，不能相加当总文件数。

## 按用户能感知的变化分组

| 编号 | 改动组 | 最终开发代码体现的行为 | 主要位置 | 交付影响 |
| --- | --- | --- | --- | --- |
| 1 | 授权目录与 Cube 专用查询入口 | 新增 `gea_cube_query` 和嵌套查询参数定义；每次读目录/业务请求重新取得授权资源，目录只展示授权资源与 inspect 的交集；取消进程级“最后被谁读取就归谁”的模型通道缓存 | `authorized-resources.ts`、`cube-query-schema.ts`、`gateway-mcp.ts`、`catalog-consumers.ts`、`agent-tools.ts` | GEA 插件；依赖网关资源发现接口 |
| 2 | 查询预检、分批与参数修正 | 在发送前核对模型、成员类别、时间、排序、分页和请求体；独立模型按组发送，单条跨模型仍拒绝；排序对象做明确的等价转换；默认 50 行，受 200 行和资源 maxRows 共同限制 | `cube-query-plan.ts`、`cube-preflight.ts`、`member-index.ts`、`cube-query-guard.ts` | GEA 插件 |
| 3 | 销售计划由宿主汇总 | 新增 `kind=aggregate`，按 periodId 读取完整分页和当前版本，用 Decimal 汇总状态、基地、品类与占比；区分 M/Z 和业务类型，校验缺页、重复、筛选失效和读取期间变化 | `sales-plan-aggregate.ts`、`business.ts`、`agent-tools.ts` | GEA 插件；不增加审批/保存权限 |
| 4 | 成功数据保留、失败隔离 | 普通 MCP 和计划汇总生成有界成功回执；后续通道失败仍保留已取得结果；失败计数按会话及 Agent 隔离，新问题/身份变化清空旧证据 | `mcp-read-evidence.ts`、`mcp-failure-guard.ts`、`business.ts`、`host.ts` | GEA 插件 |
| 5 | 减少重复探索与过量上下文 | 元数据重读返回已有结果，累计上限后停止目录探索但保留正常业务查询；大制品按需读取；目录支持相似名称、真实类型与样本观察，不将空样本推断成整表无数据 | `repeat-guard.ts`、`call-dedup.ts`、`cube-gap-ledger.ts`、`gateway-catalog.ts`、`mcp-client.ts`、`name-lookup.ts` | GEA 插件 |
| 6 | 页面意图和当前问题 | 用户提到当前页、选中行、这几个客户等页面意图时才取页面快照；每步保留当前提问，修正新一轮状态清理的会话作用域 | `page-intent.ts`、`turn-anchor.ts`、`workbench-surface.ts`、`channel.ts` | GEA 插件；改变默认取数路线 |
| 7 | 业务技能与提示词 | 安全库存、经销商采用宿主管理技能；业务范围查询无需先开页面；业务预设只扫描指定业务技能目录，避免加载开发技能；演示模块清楚标注；全局协议压缩并配合宿主校验 | `presets/gea-readonly/agent.cordis.yml`、`inventory-aqkc.skill.md`、`inventory-dealer.skill.md`、`html-plugins.ts`、`host.ts`、`registry.ts` | GEA 插件；有默认能力收窄，见下表 |
| 8 | 错误展示与诊断 | 网络失败、中止和流式网关错误转为可读原因；区分授权、资源映射和限流；资源发现日志脱敏且不能重放短期凭据 | `shared/abort.ts`、`shared/net-error.ts`、`shared/gea-stream.ts`、`api-log.ts`、`gateway-mcp.ts` | GEA 插件 |
| 9 | 桌面可选插件和开发运行图 | 从 payload 必需项、启动 bundle 和更新器可选列表移除 `@dsh-external/dsh-visualize`；开发运行图同步剔除旧 payload 中该依赖 | `desktop/prepare-payload.py`、`desktop/runtime-start.mjs`、`desktop/updates.mjs`、`scripts/desktop-dev*.mjs` | 客户端/开发启动层，不能用插件包发布冒充客户端更新 |
| 10 | Cube 运维脚本与证据 | 新增预测度量生成脚本、7 个分段生成脚本和补丁；新增取数、授权、技能与分段验收报告；更新历史度量建议的证据边界；另有 3 张 UI 审查截图变化 | `scripts/cube-*.py`、`docs/reports/`、`.impeccable/review/` | 源码、运维与说明；不会随插件发布自动执行服务器脚本 |

## 需要明确决定的删除与默认行为变化

| 编号 | 具体行为 | 来源与影响 | 待确认点 |
| --- | --- | --- | --- |
| D1 | 删除 `src/host/plan-first.ts` 和 `tests/plan-first.test.mjs`，同时移除调用计数、是否开口与暂停接线 | 分支提交 `91c565e` 引入，第 2 次取数催模型先说计划，第 5 次仍无文本则暂停；当前未提交改动取消整套机制。这是分支内试验的取消，不是已确认的 0.0.123 已发布功能回退。`cube-query-plan.ts` 做查询分组/授权校验，并非此功能的等价替代 | 保留删除，还是恢复计划检查点及相应用例 |
| D2 | 桌面移除 `@dsh-external/dsh-visualize` | 来自 `7881dc6` 及 `a742944`；改变桌面打包、运行加载、更新器与开发预览。`dsh-genui` 仍存在，但不能据此宣称旧插件的每项能力都已等价替换 | 是否接受移除；是否与 GEA 插件同批交付客户端 |
| D3 | 浏览器/终端工具与技能默认范围收窄 | 浏览器 MCP 部署改为显式 `GEA_BROWSER_MCP=1` 才挂载；`session-tool-restraint.ts` 又对所有预设隐藏浏览器工具，业务预设还隐藏 terminal/sidebar，standard/auto-negotiation 保留终端；业务技能关闭默认目录扫描 | 是否接受此范围。仅设浏览器环境开关不等于会话里就可调用浏览器，需要明确预期 |

另有一个接口前提需要知道：新增授权资源发现失败时会关闭相关业务查询，不会降级用公开 inspect 当授权。现有授权接入报告记录了真实链路成功，但完整候选尚未重做验收。

此前直接比较旧开发目录与新 main 时，浮动输入框、MPS 页面、分组 SKU 等新主线文件显示为缺失。上述已提交部分的合并预演保留了这些文件，因此**不能把这份旧目录缺失清单当成此次要执行的删除清单**。最终整合后仍须验证相关用户场景。

## 已做与尚未做的验证

- 此次 `pnpm run typecheck` 通过。
- 此次全量 `pnpm test` 完成：545 项，531 通过、14 失败，耗时约 220 秒；退出码 1。运行对象是当前开发工作树，尚未整合 main。
- 14 项失败涉及 API 日志、恢复登录权限、Z 重提、纠偏、看板汇总、模型快照、Y/DC 月份列表、通知读取、期间来源、查询超时、登录持久化及视觉布局。未逐项定位根因，不能直接归为旧问题、偶发或本次新回归。
- 既有报告另记载了授权查询、聚合、回执和技能的定向测试及真实会话证据；这些是相应历史快照的证据，不能替代最终候选的检查。
- Cube 7 个分段已在上一阶段上线，并通过 `/meta` 和 7 条真实 `/load`；这不代表新插件的 GEA 登录会话、Agent 分段选择和业务答案都已通过。
- 尚未完成：全部未提交改动与最新 main 的实际整合、最终版本号/锁文件、最终回归、MR、正式包、频道更新与客户端验收。

### 本次全量测试的失败项

1. API log center lists real Host calls, redacts credentials and replays safe reads
2. restored login reloads current grants instead of trusting persisted permissions
3. returned Z plan resubmits fixed baseline with edited correction and verifies successor node fields are empty
4. correction tab uses an explicit Z query and blocks customers without an approved monthly baseline
5. correction saves absolute drafts, approves inherited values, returns only its node, then reconciles DMS mock
6. Dashboard matches monthly detail totals and categories expand SKU
7. configured model receives the exact logged snapshot with the GEA read and skill tools and no duplicate title calls
8. one month merges Y and DC plans and synchronises the combined page with the conversation
9. GEA inbox reads preserve paging and identity, reject invalid responses and never mutate notification state
10. `tests/period-source-regression.test.mjs`
11. `tests/query-timeout-regression.test.mjs`
12. V1.6 visual: compact header, stable progress, inline SKU, drawer and persistent private drafts
13. `tests/web-login-persistence.test.mjs`
14. workbench login, brand label, avatar settings and responsive layout use the current shell

## 用户确认后的处理顺序

先确认上述改动范围和 D1–D3，再保留最新 main 的已有修复完成整合，定位失败并完成最终验证。然后形成包含版本与锁文件的提交，按确认范围创建/合并 MR，再做对应插件或客户端发行。目前停在可审阅清单阶段。
