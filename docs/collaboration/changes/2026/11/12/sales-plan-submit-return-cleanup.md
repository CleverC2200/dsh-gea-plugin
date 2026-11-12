<!-- collaboration-record
{"kind":"change","id":"sales-plan-submit-return-cleanup-gea-20261112","date":"2026-11-12","title":"销售预测上游原因与超时恢复协议","module":"销售计划","status":"已发布待验收"}
-->

# 销售预测失败与恢复协议

已发布Workbench [0.1.105](https://github.com/CleverC2200/dsh-agent-workbench/releases/tag/v0.1.105)、GEA [0.0.282](https://github.com/CleverC2200/dsh-gea-plugin/releases/tag/v0.0.282)，配套Manage [0.6.3-company.69](https://github.com/CleverC2200/dsh-agent-manage/releases/tag/v0.6.3-company.69)。

- 保留DMS业务原因和明确拒绝状态，HTTP200业务失败不再转成通用错误。
- HTTP408、断连、非法回执按原请求核对，明确拒绝允许人工重新校验后新提交。
- 有效退回回执后的核验失败只GET，不再次POST；保留实际接收数量/金额和身份权限校验。
- 72项Host回归及固定Core类型检查通过；独立审查发现的跨仓408分类遗漏已修复。
- 修复PR及固定合并提交的主线CI通过；三包预检、隔离官方安装及Host/client接收通过。
- 测试频道revision 116、正式频道revision 108均通过生产来源完整下载与SHA-256核验。
- 用户设备的真实提交、退回和DMS业务结果待验收；本轮没有生产业务写入。

相关问题：[BUG-20261112-action-failure-envelope](../../../../bugs/2026/11/BUG-20261112-action-failure-envelope.md)。
