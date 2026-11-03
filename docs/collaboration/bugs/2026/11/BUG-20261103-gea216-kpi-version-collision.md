<!-- collaboration-record
{"kind":"bug","id":"BUG-20261103-gea216-kpi-version-collision","date":"2026-11-03","title":"GEA 216 同版本不同归档导致 KPI 插件更新后启动失败","module":"插件更新","category":"构建发布","cause":"旧代码或旧产物","severity":"P1","status":"修复中"}
-->
# GEA 216 同版本不同归档导致 KPI 插件更新后启动失败

20261103.1 桌面包内置 Workbench 0.1.50、Manage 0.6.3-company.46 和 GEA 0.0.216。后续订单 KPI 组合升级到 Workbench 0.1.51、Manage 0.6.3-company.47；其 GEA 已包含 #288 的技能声明修复，但仍使用 0.0.216。

两份 GEA 归档摘要分别为 `05aebeb4843ca295249583fa220f579eb0eade3b7f88258657c3d1f95a78d3f9` 和 `27ba6ae8b27f9d8e2941cb8223120bfc515368c953d38a0059bf69b69c2a1915`。前者不含 operations-order-kpi-details，后者包含。旧 profile 的更新计划仅选择两个配套包，未替换版本相同的 GEA。

现场启动错误为 `MISSING_SKILL_REFERENCE`，指向 inventory-orderworkbench 的 page.json 与 capability.json。GEA 启动失败后撤销身份和更新接口，页面持续返回 404。较早的等待 agentResources、userAgents 记录不是最终失败原因。

功能来源为 Manage #116、Workbench #208、GEA #288；后续组合发布为 Workbench #210、Manage #117、GEA #290。旧桌面包来源为 GEA #287。首次安装新版组合通过，不能代替旧桌面包的实际升级验收。

本次使用新的 GEA 版本 0.0.218，保留两份历史归档和标签。tests/plugin-release.test.mjs 从实际包版本生成更新计划，覆盖旧 profile 无归档摘要以及两份 216 归档的恢复选择。216 时得到 current，218 时选择 GEA 升级；相关资源和声明检查同时通过。

用户已授权修复插件并生成新安装包。必要验收包含最终三包安装、身份及更新接口、旧故障组合恢复、覆盖安装与会话保留。源码检查、隔离验收、正式发布和员工设备验收分别报告；发布证据跟随本次修复 PR。

## 处理历史

| 日期 | 状态 | 证据 |
|---|---|---|
| 2026-11-03 | 已定位，修复中 | 现场后台错误、两份实际归档、公开更新计划重放与版本回归 |
