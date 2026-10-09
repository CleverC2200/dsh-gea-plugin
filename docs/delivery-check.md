# 只读交付核对与接续

公开 interface 是 `checkDelivery(request, { observedAt? })`，位于 `scripts/delivery-check.mjs`。它读取固定回执，返回同次观察派生的阶段、预算、一致性和接续；不写单票、运行登记或用户状态，不启动进程、不派工、不恢复自动化，也不新增授权。

```sh
pnpm run delivery:check --input request.json
pnpm run delivery:check --input request.json --continuation
pnpm run test:delivery
```

CLI 成功生成报告退出0，请求无效或不可读退出2。**退出0只表示报告已生成**：机器输出 `consistency.generated:true`、`exitZeroMeans:"report-generated-only"`、`acceptance:"not-evaluated"`。消费者必须读取 `consistency.status`、所需 `stages` 和 `continuation`，不能把退出0、observed或阶段完成当作质量通过、原票 done 或业务验收。预算超额、来源漂移和旧状态副本矛盾可在退出0的报告中明确 failed；缺证保持 unknown。

## 原有回执与输入范围

请求沿用 schemaVersion 1 的受控引用：

```json
{
  "root": "/absolute/frozen-input",
  "projectId": "plugin-split",
  "tasks": [
    {
      "id": "06",
      "ticket": { "id": "ticket06", "path": "06.md" },
      "candidate": { "id": "candidate06", "path": "candidate.json" },
      "delivery": { "id": "delivery06", "path": "delivery.json" },
      "inputs": [{ "id": "calls", "path": "calls.json" }]
    }
  ]
}
```

引用必须在显式 root 的词法与物理范围内。每份元数据至多1MiB，最多100票，来源 id 必须唯一。Session/persistentRoots 只声明持久范围和观察目录存在性；读取范围守卫拒绝持久数据重叠、敏感目标、越界 symlink 和不可确认硬链接，检查不会遍历 Session。输出保留来源 id、实际 SHA256 和本次观察时间，不复制原文、认证日志、URL 或凭据。

单票唯一标题编号和 Status 是原执行状态来源；目标与原依赖不靠接续摘要改写。候选保持原 clean/dirty、commit、files、checkout 合同。无 checkout 的 `recorded-snapshot` 只证明固定候选记录；完整 checkout 证明保留实际 Git/index/源码摘要与 unsupported Git 精确 unknown。离线检查保留独立集合、counts、来源摘要、原观察时间及历史/当前关系，未来记录、skip、失败、来源冲突不能复用为通过。

冻结装配复用当前 `source-profile` 的唯一组合校验：纯 reader 在 `source-combination-integrity.mjs`，source-profile 继续导出同一 `readSourceCombination`，当前五源输入、资源排除与原准备/选择/恢复职责保留。交付核对不传 Core 参数触发 Git，也不执行准备、切换或恢复。完整性、授权、依赖、运行归属、选择、工具终态和业务阶段继续分别输出；记录性运行证据不证明现在仍监听、登录或装载。

授权仍来自已存在 `authorization-readiness` 和 `human-instruction` 格式，要求原 human/official-user-message 及作用范围。fixture 的人类来源是明确测试输入，不能充当实际授权。暂停、拒绝、冲突、原票依赖、配置、审核、运行归属和观察不足分别保留。正常 command exit、turn completed 与 UI timer 不是同一事实。

## 同次派生字段

在既有 `delivery.json` 中声明目标和绑定的回执，不新增持久完成表：

```json
{
  "taskId": "06",
  "projectId": "plugin-split",
  "requiredChecks": ["behavior"],
  "checks": [],
  "goal": { "id": "full-route", "stages": ["offline-checks", "model"] },
  "budget": { "receipts": [{ "sourceId": "calls", "caseId": "read-one" }] }
}
```

`goal.stages` 是调用者显式冻结的目标范围，必须是已有阶段名且不重复。completed 仅表示声明范围已证明，保留原 executionStatus；不会把原票标 done。没有明确目标或就绪证据，接续返回 unknown 及最小补充条件。调用者需用原规格核对目标范围，不能用缩小声明替代全路线验收。

`budget.receipts` 绑定已有只读结果的 `case` 和 `at`，同一 case 只接受一个观察，避免把同一窗口的更新快照重复累加。沿用 SQL/REST/models/modelTasks/businessWrites 等既有字段，重复别名必须相等，缺失或无效计数保持 unknown；不从 launcher、退出或 UI 动作推导物理次数。已确认值与 completeness 分开，只有同一显式作用范围的回执才累加。单份来源保留 observedAt 和 terminalSnapshotAt；截止不得晚于回执或本次报告。窗口、receipt、累计用量不混成一个“当前预算”。

现有 `readonlyValidation.limits/spent` 派生 `unspentRecorded`；超额返回 failed，缺额/用量返回 unknown。`usableNow` 始终 unknown：旧窗口的未用额度不能授予新的窗口或模型/业务操作。`afterCutoff` 和 `effectsAfterCutoff` 保持 unknown；原 r7 setup failure 的 businessRequests/modelsAndWrites 未知不会被后来的正常退出或已确认0覆盖。

`reconciliation` 可显式引用历史投影，profile 仅支持 `call-budget`、`current-status`、`candidate-snapshot`。它检查既有 readonly48 格式内的 SQL计数/摘要、关闭窗口/激活、停止/恢复冲突；不以投影授予授权或业务通过。明确已标历史的激活字段保留历史，不要求清零。不可变候选 `installed:false` 输出 historical-source-snapshot / installedAtCapture，不冒充当前未安装，也不改原文件。其它格式或缺有效来源时间保持 unknown。这是窄格式重放，不宣称理解任意自由文本或全部旧状态。

`continuation` 包含声明目标、固定候选与输入摘要、已验范围、剩余阶段、在途工具观察、独立下一动作与停止条件。状态分为 actionable、external-conditions、user-paused、dependency-unmet、completed、unknown。预算或来源冲突阻止同票 can-continue；一个原票依赖或外部停点不阻断另一个独立、已授权且就绪的任务。only external 只有所有剩余均有明确外部条件时成立；缺来源不猜成外部等待。所有输出 `performsActions:false`。

`--continuation` 返回同一报告的接续视图，不重新读取或另建权威。当前运行所有者、有效授权、运行窗口及原自动化是否暂停仍由原回执负责；输出仅供维护者选择下一步。

测试通过公开 checkDelivery / CLI，用可抛弃 fixture 验证真实字节保护、来源、时间、预算、目标与接续。原始 r7 副本和既有公共回归保留；这些本地检查不证明 Native、模型、业务读取或远端 CI。
