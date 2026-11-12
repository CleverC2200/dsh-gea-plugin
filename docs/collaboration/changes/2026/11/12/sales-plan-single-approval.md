<!-- collaboration-record
{"kind":"change","id":"CHANGE-20261112-gea-single-approval","date":"2026-11-12","title":"GEA 0.0.277兼容单笔审批失败修复","module":"销售计划","status":"已验证待发布"}
-->

# GEA 0.0.277 配套单笔审批修复

对比 GEA 0.0.276，仅扩展 Workbench 0.1.100 的兼容声明并更新编译版本。Workbench 修复单笔失败原因被覆盖及明确失败后的人工提交复用旧失败结果，未知结果继续沿原请求核对。

本次没有修改 GEA 业务调用逻辑、审批权限或 DMS 主数据。Manage 复用已发布 company.67，完整三包按既有发行入口检查。用户重新勾选后点顶部通过的现场验收尚未完成，没有再次执行真实业务写入。
