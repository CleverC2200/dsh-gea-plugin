<!-- collaboration-record
{"kind":"change","id":"CHANGE-20261112-gea-stale-recovery-release","date":"2026-11-12","title":"GEA 0.0.275配套销售计划恢复发行","module":"插件发行","status":"已发布待验收"}
-->

# GEA 0.0.275配套发行

仅扩展 Workbench 0.1.98 兼容范围，接收销售计划具体冲突提示、旧版本与过期草稿恢复；既有身份、权限、DMS和整组更新流程保留。

- 固定来源 `a781d3b72587a01300f3b180e9e1467a4c897485`，[PR #387](https://github.com/CleverC2200/dsh-gea-plugin/pull/387)与[合并后主线检查](https://github.com/CleverC2200/dsh-gea-plugin/actions/runs/43172009776)通过。
- [GEA 0.0.275 Release](https://github.com/CleverC2200/dsh-gea-plugin/releases/tag/v0.0.275)已发布；归档SHA-256为 `1407d9b6cb049918a8a8a968d9717d83ead13be95ba3f905e066415a7a7131aa`。
- 最终组合为Workbench 0.1.98、GEA 0.0.275、Manage 0.6.3-company.66原归档；测试112、正式104均通过生产reader匿名下载、摘要及安装图校验。
- 43项发行合同、固定required Core的类型检查、发布预检、官方隔离安装与Host/client模块图接收通过。
- 首个频道写入前主线新增 `0b618c7da05c84f8742670a3e0b030f0d3be82aa`，仅涉及Windows验收测试编码与记录。已逐项确认运行代码、构建、版本、锁、预设及locale输入不变，保留原固定标签和已验证归档，没有移动标签或同版重打。
- 本次仅插件发行；未再次执行业务审批或DMS提交，未更改主数据或员工设备。发布技能为本机dsh-plugin-release 1.3.1 local_draft。
