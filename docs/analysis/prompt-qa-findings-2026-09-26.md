# 提示词优化独立验收问题单

> 历史快照：下文记录 66c1ff5 上的原始失败，原始证据未覆盖。修复结果见 [QA 修复验收](prompt-qa-fixes-2026-09-26.md)。
日期：2026-09-26。结论：**发现 4 个可复现问题，尚未修复。** 本轮只新增测试与问题记录，没有改生产代码、安装客户端、提交或发布。

## 测试范围

- GEA：`66c1ff5aabd45e27eb6111ed349b08df6ae56a03`，业务套件：`891c123b416631711477b0831d23d10374d83c14`。
- 复跑原有定向用例 24 项：全部通过。
- 新增 11 个验收场景：7 通过，4 失败。Node 报告还会把失败的父测试组计 1 项，所以终端是 12 项、5 失败；业务问题仍为 4 项。
- 使用真实 Harness 进程与工具执行链，模型输出/业务接口由本地 fixture 驱动。纯计算、权限模拟、工具状态和恢复逻辑可据此判断；不是生产 LLM 回答质量、生产权限配置或桌面安装验收。
- 首轮实际加载四个预测 Skill 的目录；没有装入全部生产 HTML 页面包。CodeGraph 索引未覆盖新代码，问题定位按当前源文件核对。

## 问题优先顺序

| 编号 | 等级 | 问题 | 影响 |
|---|---|---|---|
| QA-01 | P2，优先处理 | 纯计算大结果跨轮回读失效 | 下一轮想看剩余明细也被迫重新计算；原文件并未删除 |
| QA-02 | P2，优先处理 | 缺失值契约与工具 Schema 不一致 | 一行 null 导致整批拒绝，正常行无法继续 |
| QA-03 | P2 | 失败加载留下工具包/额度状态 | 失败回执与真实状态不一致，后续只查看能力也能激活残留配置 |
| QA-04 | P2 | UI 语义校验覆盖不全 | 空格、Unicode 减号和 hero.delta 可绕过自动颜色限制 |

### QA-01：原结果仍在，但下一轮读不到

步骤：在测试用户消息中明确提供 24 行 JSON 输入，调用 `gea_forecast_compute`（data_mode=provided，测试数据），得到带 `evidenceId` 的 partial 投影；同一用户、同一会话下一轮只要求补充明细，不改变数据、页面或权限，调用 `gea_evidence_read`。

实际：`GEA_EVIDENCE_STALE: 页面或临时结果需要重新读取。`

对照：同轮计算后立即回读成功，返回 1,000 字符。最初还用 mock 输入复现；最终脚本改为 provided 输入后仍失败。不是模型选择错误或文件缺失。

原因：[临时证据标识](</Users/synear/.codex/worktrees/gea-prompt-optimization/dsh-gea-plugin/src/host/prompt-runtime.ts:105>) 包含轮次 revision；计算结果没有独立证据类型，也走临时结果分支。[回读判断](</Users/synear/.codex/worktrees/gea-prompt-optimization/dsh-gea-plugin/src/host/prompt-runtime.ts:653>) 在新用户轮次拒绝它。

建议：区分页面快照、用户提供数据的确定性计算及来自受权查询的计算；能复用的纯计算按身份/输入/规则版本校验。live 来源仍应保留授权链，不能简单放开所有过期引用。

证据：[跨轮错误](</Users/synear/.codex/worktrees/gea-prompt-optimization/dsh-gea-plugin/docs/analysis/qa-2026-09-26/followup-evidence.json>)；复现脚本同时包含同轮成功对照。

### QA-02：null 和省略，同为缺失但结果不同

步骤：两行预测输入，第一行 `target_mom_growth=null`，第二行完全有效。

实际：整个工具调用被拒：`invalid arguments: "records[0].target_mom_growth" must be a string`，没有进入逐行计算。

对照：只把第一行该字段省略，其余输入不变，得到 `calculated=1, partial=1`。

依据：[套件数据约定](</Users/synear/.codex/worktrees/gea-prompt-optimization/company-agent-suites/suites/sinian-demand-forecast/references/data-contract.md:34>) 明确写“null 不补零”，eligible 也允许 null/缺失表示阻断；[工具 Schema](</Users/synear/.codex/worktrees/gea-prompt-optimization/dsh-gea-plugin/src/host/forecast-compute.ts:237>) 却把这些小数参数限定为非空类型的 string。严格校验确实按 Schema 工作，问题是业务约定与新工具的输入表示没有对齐。

建议：明确工具层的缺失值契约，允许受控 nullable 表示，或在进入整批 Schema 校验前规范化；继续保留十进制字符串和大整数精度保护，不为兼容空值重新接受不安全浮点数。

证据：[工具拒绝回执](</Users/synear/.codex/worktrees/gea-prompt-optimization/dsh-gea-plugin/docs/analysis/qa-2026-09-26/null-growth-result.json>)；[结果汇总](</Users/synear/.codex/worktrees/gea-prompt-optimization/dsh-gea-plugin/docs/analysis/qa-2026-09-26/results.json>) 有省略字段的成功对照。

### QA-03：失败调用不是原子操作

步骤：新会话调用 `gea_capabilities(pack="ui", skill="no-such-business-rule", complex=true)`，再用空参数查看能力状态。

实际：第一次返回 `GEA_SKILL_UNAVAILABLE`，但之后状态是 `loaded=["ui"]`、`callLimit=40`。紧接失败的模型请求尚未看到 UI 工具；后续仅查看能力后，`render_ui` 与 `validate_dsh_ui` 出现在目录中。

原因：[执行顺序](</Users/synear/.codex/worktrees/gea-prompt-optimization/dsh-gea-plugin/src/host/prompt-runtime.ts:430>) 先更新工具包和额度，再查 Skill；校验抛错时没有回滚。这个现象不等于已经绕过后台业务权限，但会造成工具可见性、额度、失败回执和恢复状态不一致。

建议：先完成参数、Skill 和能力可用性校验，再一次性更新状态和 mask；失败或取消不应留下未成功提交的配置。

证据：[失败与残留状态](</Users/synear/.codex/worktrees/gea-prompt-optimization/dsh-gea-plugin/docs/analysis/qa-2026-09-26/failed-capability-state.json>)，含后续两次模型请求的工具清单。

### QA-04：校验与渲染器支持的数值形式不同

在业务 Agent 已加载 UI 包后，使用真实 `render_ui(spec=...)`：

| 输入 | 实际结果 |
|---|---|
| table 单元格 `"+10"` | 被 `GEA_UI_BUSINESS_SEMANTICS` 拦截，符合预期 |
| table 单元格 `" +10"` | 放行，返回“已渲染 UI” |
| table 单元格 `"−10"`（Unicode 减号） | 放行，返回“已渲染 UI” |
| `hero.delta="+10"` | 放行，返回“已渲染 UI” |

原因：[业务校验](</Users/synear/.codex/worktrees/gea-prompt-optimization/dsh-gea-plugin/src/host/prompt-policy.ts:113>) 只检查 stat.delta，以及字符串开头的 ASCII 正负号；没有 trim，也不覆盖 hero.delta。当前 GenUI 渲染器的 `deltaTone` 会 trim 并识别 Unicode 减号，hero 也会单独渲染 delta。因此仅靠换写法就能进入自动涨跌着色路径。

工具放行和“已渲染”回执已实测；颜色分类依据当前依赖的 `src/client/blocks/charts.tsx:87`、`render-node.tsx:307` 和 CSS。未用生产页面截图量测最终 RGB。

建议：校验复用与渲染器一致的规范化规则，并覆盖所有带 delta 的组件；不能只补一句提示词。

证据：[三种有效 spec 的工具回执](</Users/synear/.codex/worktrees/gea-prompt-optimization/dsh-gea-plugin/docs/analysis/qa-2026-09-26/ui-guard-variants.json>)。早期探针曾传错 render_ui 的根参数，已改为真实 spec 形状；该次无效输入不计入本结论。

## 已通过的新增场景

1. 实际四个预测 Skill 目录下首轮 system 1,564 字符、tools 7,008 字符，合计 **8,572 字符**，仍低于 12,000。不是 token 数或生产全插件组合大小。
2. 复杂额度在下一用户轮次由 40 恢复为 20。
3. 同一 Skill 正文仍可见时，重复加载结果从 1,121 字符缩为 155 字符，不再复制正文。
4. 省略缺失增长规划时，正常行继续计算，缺失行标 partial。
5. 同轮可以回读计算结果原文。
6. ASCII 正负号表格受到业务 UI 校验拦截。
7. 真正停止并重启 Harness、重新登录后，同会话成功加载的 UI 能力可恢复。

前三个问题重复运行均出现；UI 三种正确 spec 在两次运行均放行。没有因第一次失败就改程序或修改原用例。

## 复现与产物

工作目录：`/Users/synear/.codex/worktrees/gea-prompt-optimization/dsh-gea-plugin`。需使用已构建的该提交，依赖沿用当前冻结安装；业务套件默认读取兄弟工作树，也可用 `GEA_QA_SUITE_ROOT` 指定其 `suites/sinian-demand-forecast` 目录。

```sh
node --test docs/analysis/qa-2026-09-26/reproduce.mjs
```

该命令当前预期退出码为 1，因为记录的是未修复问题。脚本创建隔离服务和数据目录，结束时关闭并清理，不连接生产模型或执行业务写入。

- [可运行复现脚本](</Users/synear/.codex/worktrees/gea-prompt-optimization/dsh-gea-plugin/docs/analysis/qa-2026-09-26/reproduce.mjs>)
- [结果 JSON](</Users/synear/.codex/worktrees/gea-prompt-optimization/dsh-gea-plugin/docs/analysis/qa-2026-09-26/results.json>)
- [复现日志](</Users/synear/.codex/worktrees/gea-prompt-optimization/dsh-gea-plugin/docs/analysis/qa-2026-09-26/reproduction.log>)
- [原用例复跑日志](</Users/synear/.codex/worktrees/gea-prompt-optimization/dsh-gea-plugin/docs/analysis/qa-2026-09-26/baseline.log>)
- [提交和构建摘要](</Users/synear/.codex/worktrees/gea-prompt-optimization/dsh-gea-plugin/docs/analysis/qa-2026-09-26/manifest.json>)

本轮未修复、未提交、未发布。建议先处理跨轮回读和缺失值批处理，再修失败加载的原子性和 UI 校验。
