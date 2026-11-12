<!-- collaboration-record
{"kind":"bug","id":"BUG-20261112-action-failure-envelope","date":"2026-11-12","title":"审批失败正文与未知结果标志丢失","module":"销售计划","category":"功能逻辑","cause":"原始遗漏","severity":"P1","status":"已验证待发布"}
-->

# 审批失败原因与未知结果

原action对HTTP200且success:false抛出通用异常，丢失DMS原因。HTTP408的未知标志在页面分类时被忽略，可能允许新幂等请求。有效退回回执后的核验失败也会再次POST。

本轮保留业务原因与明确拒绝标志；超时、断连和非法回执沿原请求核对。有效回执单独保存，之后只GET核验；身份周期、角色与实际退回节点校验保留。

- 修复来源：71fe6313、99efcbb8，页面配套bf172311。
- 72项公开Host回归通过，含HTTP200/502业务拒绝、JSON/非JSON408、M/Z重提、原请求/正文/幂等键一致及成功回执后仅GET。
- 拟发布GEA 0.0.280，配套Workbench 0.1.103；尚未做用户设备或生产DMS验收。
