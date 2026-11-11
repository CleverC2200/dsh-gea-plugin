<!-- collaboration-record
{"kind":"change","id":"CHANGE-20261109-regional-sales-return-release","date":"2026-11-09","title":"区域大类SKU提报、退回数据及启动恢复修复","module":"销售计划与会话","status":"已发布"}
-->
# 区域销售计划与会话恢复

- 已发布 [GEA 0.0.257](https://github.com/CleverC2200/dsh-gea-plugin/releases/tag/v0.0.257)，固定源码为 [1a3ed85f](https://github.com/CleverC2200/dsh-gea-plugin/commit/1a3ed85fa0ae93c4993dcd89ee8210a9a10bbda6)，功能合并为 #344。
- 配套 [Workbench 0.1.84](https://github.com/CleverC2200/dsh-agent-workbench/releases/tag/v0.1.84) 和原包复用的 [Manage 0.6.3-company.59](https://github.com/CleverC2200/dsh-agent-manage/releases/tag/v0.6.3-company.59)。
- 按当前权限读取历史实际发货量，支持区域大类及SKU汇总中的同期、近两月实绩与实际明细金额。
- 单笔和批量退回按原 actions 合同传递当前节点修改后的完整 SKU 数量，核验接收数量、金额和原节点字段清空结果；继续退回复用现有详情及同版本审批记录，不新增后端接口或字段，后端源码保持原合同。
- 会话、工作区及页面能力等待就绪后再打开业务页；末轮开发客户端经原欢迎页进入后，首次打开销售计划正常，未手动刷新，也未新增业务写入或模型消息。末次文档自动打开和原会话自动关联未在末轮确认。
- 先前授权的单笔1笔、批量2笔已完成79条SKU真实回读；状态7/8/9继续退回通过回归，尚无新增正式样本验收。
- 两仓合并后主线 CI、固定源码构建、三包交付、发行预检、官方安装与 Host 接收通过。test/stable 频道修订为99/91，完整三包经生产来源读取器下载校验。Manage 原归档及原 release JSON 保持原字节。
- MPS 页面与配套计算改动已包含在实际下载归档中，来源为 [Workbench #272](https://github.com/CleverC2200/dsh-agent-workbench/pull/272)、[Manage #141](https://github.com/CleverC2200/dsh-agent-manage/pull/141)。
- 发布前 Workbench 主线新增 [订单 KPI #275](https://github.com/CleverC2200/dsh-agent-workbench/pull/275)；用户明确选择按已验收固定版本发布，该项留待下一版。标签、归档和历史失败证据均保留。
- 本轮只发布插件，没有升级 Core 或发布桌面安装包。
