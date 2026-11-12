<!-- collaboration-record
{"kind":"change","id":"sales-plan-submit-return-cleanup-gea-20261112","date":"2026-11-12","title":"销售预测上游原因与超时恢复协议","module":"销售计划","status":"已验证待发布"}
-->

# 销售预测失败与恢复协议

准备GEA 0.0.280，接收Workbench 0.1.103，Manage使用主线已合并的.69；保留现有兼容声明。

- 保留DMS业务原因和明确拒绝状态，HTTP200业务失败不再转成通用错误。
- HTTP408、断连、非法回执按原请求核对，明确拒绝允许人工重新校验后新提交。
- 有效退回回执后的核验失败只GET，不再次POST；保留实际接收数量/金额和身份权限校验。
- 72项Host回归及固定Core类型检查通过；独立审查发现的跨仓408分类遗漏已修复。
- 尚未正式发布，没有生产审批或DMS写入，用户客户端待验收。

相关问题：[BUG-20261112-action-failure-envelope](../../../../bugs/2026/11/BUG-20261112-action-failure-envelope.md)。
