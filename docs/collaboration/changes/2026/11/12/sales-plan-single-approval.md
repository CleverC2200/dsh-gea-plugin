<!-- collaboration-record
{"kind":"change","id":"CHANGE-20261112-gea-single-approval","date":"2026-11-12","title":"GEA 0.0.277兼容单笔审批失败修复","module":"销售计划","status":"已发布待验收"}
-->

# GEA 0.0.277 配套单笔审批修复

对比 GEA 0.0.276，仅扩展 Workbench 0.1.100 的兼容声明并更新编译版本。Workbench 修复单笔失败原因被覆盖及明确失败后的人工提交复用旧失败结果，未知结果继续沿原请求核对。

本次没有修改 GEA 业务调用逻辑、审批权限或 DMS 主数据。Manage 复用已发布 company.67，完整三包按既有发行入口检查。用户重新勾选后点顶部通过的现场验收尚未完成，没有再次执行真实业务写入。

## 发行回填

- [0.0.277 Release](https://github.com/CleverC2200/dsh-gea-plugin/releases/tag/v0.0.277) 已发布，固定源码 3676d65d62d217ade56928a4cd74e39fa84279bf；[合并后主线 CI](https://github.com/CleverC2200/dsh-gea-plugin/actions/runs/43186739924) 通过。
- TGZ SHA-256：10bf19f83f60965fd44c72a45b6dc147448221f425acbe08e674639ea7ea5fe1。完整组合为 Workbench 0.1.100、GEA 0.0.277、Manage 0.6.3-company.67 原归档。
- 测试频道 revision 114、正式频道 revision 106 已通过生产 reader 匿名 check/download。发布预检及官方隔离安装、Host/client 模块接收通过。
- 本轮明确冻结已验收的 100/277 组合，后续主线变更另行发行；归档和标签保持原字节与来源。
- 本轮未操作用户正式客户端或再次提交真实审批/DMS。现场重新勾选后点顶部通过，仍由用户更新后验收。
