<!-- collaboration-record
{"kind":"bug","id":"BUG-20261112-action-failure-envelope","date":"2026-11-12","title":"审批失败正文与未知结果标志丢失","module":"销售计划","category":"功能逻辑","cause":"原始遗漏","severity":"P1","status":"已发布待验收"}
-->

# 审批失败原因与未知结果

原action对HTTP200且success:false抛出通用异常，丢失DMS原因。HTTP408的未知标志在页面分类时被忽略，可能允许新幂等请求。有效退回回执后的核验失败也会再次POST。

本轮保留业务原因与明确拒绝标志；超时、断连和非法回执沿原请求核对。有效回执单独保存，之后只GET核验；身份周期、角色与实际退回节点校验保留。

- 修复来源：71fe6313、99efcbb8，页面配套bf172311。
- 72项公开Host回归通过，含HTTP200/502业务拒绝、JSON/非JSON408、M/Z重提、原请求/正文/幂等键一致及成功回执后仅GET。
- 已发布Workbench [0.1.105](https://github.com/CleverC2200/dsh-agent-workbench/releases/tag/v0.1.105)、GEA [0.0.282](https://github.com/CleverC2200/dsh-gea-plugin/releases/tag/v0.0.282)，配套Manage [0.6.3-company.69](https://github.com/CleverC2200/dsh-agent-manage/releases/tag/v0.6.3-company.69)。
- 修复PR及固定合并提交的主线CI通过；三包预检、隔离官方安装及Host/client接收通过。
- 测试频道revision 116、正式频道revision 108均通过生产来源完整下载与SHA-256核验。
- 用户设备的真实提交、退回和DMS业务结果待验收；本轮没有生产业务写入。
