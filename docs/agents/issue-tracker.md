# 票据跟踪入口

在插件拆分项目中领取或更新票据时，从该项目根的 `docs/agents/issue-tracker.md`、`docs/agents/triage-labels.md` 与当前任务 `integration-set.json` 读取票据、目标仓库和状态；涉及授权及跨聊天交接时，读该项目根的 `docs/agents/current-handoff-rules.md`。独立仓库或 CI checkout 按本票既有候选输入与有效授权工作。

[原公司 GitLab 与纠偏开工记录](../history/current-docs-before-20261010/docs/agents/issue-tracker.md) 按原字节保留，包含规格 #26、执行票 #27–#33、原基线和分支。它不定位本轮 checkout，也不授予正式 GitLab 写权限。现有业务规格和验收缺口按 [文档索引](../index.md) 进入。
