<!-- collaboration-record
{"kind":"change","id":"CHANGE-20261030-order-report-release-207","date":"2026-10-30","title":"订单报告独立保存插件发行准备","module":"订单工作台","status":"已合并功能待发布"}
-->
# 订单报告独立保存插件发行准备

- 来源：GEA PR #259 已合入 main（be9e861e9019be1cd83b9b2b7f5de0667991bad8），44项适用 CI 检查通过；Workbench PR #182 已合入，4项 CI 检查通过。
- 行为：人工编辑内容与完整报告快照分开保存，保留 order 身份、租户和基地范围、版本与写后回读。对应功能定向测试10项通过。
- 本轮仅将 GEA 升为 0.0.207；Workbench 0.1.44 和 Manage 0.6.3-company.40 已发布，拟复用其不可变归档。没有新增功能删除或旧修复回退。
- 同事记录核对限于本模块主线记录、上述已合并 PR 和对应已发布版本；不声明审阅全部历史。本轮没有新增业务根因，不重复建立 Bug。
- 发布规则来自用户提供的 dsh-plugin-release 1.2.0 分发包，入口摘要 6877de90286b9ca932b7a5a75ded1200518b3cfd103da81c9a40144042ff120e；未登记团队维护源，记 distributed_bundle。
- 当前状态：未发布。完成固定输入构建、三包预检、来源下载和 GitHub Release 读回后，在发行交接记录补记最终版本、摘要及频道 revision。
- 验收边界：本轮仅插件；不构建桌面客户端，不升级 Core，不触发真实业务操作。
