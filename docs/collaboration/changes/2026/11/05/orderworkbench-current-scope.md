<!-- collaboration-record
{"kind":"change","id":"CHANGE-20261105-orderworkbench-current-scope","date":"2026-11-05","title":"补交订单工作台货龄卡片范围提示并独立升版","module":"订单工作台","status":"待发布"}
-->
# 订单工作台遗漏文案补发

货龄卡片在有有效值时显示“当前范围”，缺数仍沿用原状态；指标值、口径、阈值和其他卡片不变。修复已通过 [Workbench #246](https://github.com/CleverC2200/dsh-agent-workbench/pull/246) 合入 main，6 项定向卡片/部分指标检查及全部 PR CI 通过。

已逐项对照本次工作台旧工作树与 main：卡片明细联动、导入预览与按钮、导入超时、加载和跨页面缓存已包含；仅该文案遗漏。旧副本、格式差异及其他任务的未提交内容不随本次提交。

候选组合 Workbench 0.1.68 / Manage 0.6.3-company.53 / GEA 0.0.237。Workbench 0.1.67 与 GEA 0.0.236 正由并行 PR 占用，保留其版本。GEA 仅升版及追加 Workbench 兼容声明；Manage 不含新改动，复用已核验的 53 版归档。

最终固定构建、三包兼容预检和实际频道下载分别留证，直接检查发布包的货龄状态函数。使用当前登记 rc.2 Core，不升级 Core、不构建桌面、不访问业务数据。此记录不将 Native、用户设备升级或业务验收标记为完成。
