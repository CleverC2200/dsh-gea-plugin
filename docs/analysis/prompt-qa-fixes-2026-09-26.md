# 提示词优化 QA 修复验收（2026-09-26）

用户授权：本会话“同意修复建议”，对应上一轮 QA-01～QA-04。固定基线 `66c1ff5aabd45e27eb6111ed349b08df6ae56a03`。修改仅在 `codex/gea-prompt-optimization` 隔离工作树；业务套件本轮不变。

四项问题已修复，原始复现的 11 个场景全部通过；新增边界回归 29 项通过。完整回归 617 项：613 通过、1 失败、3 项原有跳过；失败的旧布局用例单独复测通过，保留偶发失败风险。

| 问题 | 修复行为 | 验证 |
|---|---|---|
| QA-01 跨轮无法回读纯计算结果 | 对真实用户消息中的完整 provided/mock JSON 建立输入摘要，绑定当前身份、会话与计算规则版本；回读重新核对来源 | 同轮、跨轮、进程重启可读；跨会话、模型仅声明 provided、live 输入拒绝跨轮复用 |
| QA-02 null 导致整个计算批次失败 | 十进制数量/增长字段及 eligible/seasonal 接受 null；计算器逐行处理缺口 | 缺增长行 partial，缺基础量/资格行 blocked，正常行继续；不补零、不输出虚构最终值；JSON 数字仍被 Schema 拒绝 |
| QA-03 能力加载失败留下状态 | 先查 Skill、检查取消和轮次，再创建候选状态、替换原生工具限制并提交 | 无效 Skill、取消、目录失败、限制器失败不扩包、不提额；已有成功能力保留，重启只恢复成功加载 |
| QA-04 UI 颜色校验漏拦 | 与当前渲染器一致：trim、ASCII/Unicode 正负号、小数点形式；覆盖 hero/stat.delta | 原三种绕过全部拒绝，保留带业务含义的中性文字和普通数值 |

## 验证记录

- `pnpm run build:host`、`pnpm run typecheck`：通过。锁文件、依赖和前端源码无变化。
- 首批定向回归：36/36 通过，含授权 Cube、网关过期/撤权、流 usage 及 Prompt Runtime。
- 扩展回归：29/29 通过，包含真实 Harness、用户来源证明、null/精度、加载取消与 native mask 生命周期。
- 原始复现重跑：11 个场景通过；Node 含父测试计 12/12。与原脚本相比仅输出目录与结果元数据改变，断言保持不变；实际加载四个销售预测 Skill。
- 四个实际 Skill 下首轮仍为 system 1,564 + tools 7,008 = **8,572 字符**。这是字符数，不是模型 token 或生产全部插件的占用。
- Standards 独立审查：0 项；Spec 独立审查：0 项。两路只读检查源码，不冒充重复执行测试。
- 完整回归：617 项，613 通过、1 失败、3 项原有跳过，耗时约 262 秒。失败是 `tests/client-shell-feedback.test.mjs:155` 的抽屉 `display` 断言（none vs flex）；同一代码单独复测 1/1 通过。没有修改或放宽该断言，也不把首跑失败覆盖成通过。
- 新收集的验证风险 QA-05：已有布局用例在整套执行时，历史对话抽屉 aria-expanded 已为 true，但 display 尚为 none。单独复测约 14 秒通过；疑似异步 UI 更新的等待不足，尚未确认根因。这不计入四项修复的失败，但完整回归不能声称一次全绿。证据：[全套日志](qa-fixes-2026-09-26/full.log)、[单独复测](qa-fixes-2026-09-26/shell-recheck.log)。

可重复运行：

```sh
pnpm run build:host
node --test tests/prompt-runtime.test.mjs tests/prompt-qa-regression.test.mjs
node --test docs/analysis/qa-fixes-2026-09-26/recheck.mjs
```

最后一个脚本默认读取兄弟 `company-agent-suites/suites/sinian-demand-forecast` 工作树，也可通过 `GEA_QA_SUITE_ROOT` 指定。常规 tests 使用自包含 Skill fixture，不依赖兄弟仓库。

## 保留的边界

- 仅有完整、可匹配的用户 JSON 才建立可跨轮复用的计算来源。口头声明、模型自造输入、页面快照、live 输入均没有新增豁免；从自然语言整理出来但没有对应完整 JSON 的输入仍不能跨轮回读。
- 原 30 分钟证据有效期、身份/会话检查、原文摘要校验、查询授权链保留。不是无限期缓存，也不代表输入已通过业务核验。
- 没有改公式、50/50 默认权重、候选规则、金额定价或生产后台权限。原 TypeScript/Python 14 组对照继续通过。
- 本地 fixture 替代外部模型和业务接口；没有真实模型答案质量、生产权限、生产 UI RGB 或发布安装验收结论。

## 历史修复与交付范围

远端 `gitlab` 的 `main` 当前仍为 `13a35ea39570172b8eef80cde8f5895c41719322`，已只读核对并 fetch。原优化提交 `66c1ff5` 在其上；此次只增加已批准 QA 修复。原过期网关停止、跨 consumer 证据隔离、重复工具预算、精确十进制、编码入口和审批控制不删除；对应旧回归保留。没有删除文件、依赖、API、测试或频道条目。

原失败报告与红灯产物保留在 [原 QA 报告](prompt-qa-findings-2026-09-26.md) 和 `qa-2026-09-26/`。修复后证据单独在 [结果 JSON](qa-fixes-2026-09-26/results.json)、[复现日志](qa-fixes-2026-09-26/reproduction.log) 与 [复验脚本](qa-fixes-2026-09-26/recheck.mjs)。

未推送、合并、发布、安装或切换本机客户端。本轮授权是源码修复；新组合仍需后续发布安装后才对客户端新会话生效。
