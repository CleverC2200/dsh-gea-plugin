<!-- collaboration-record
{"kind":"change","id":"CHANGE-20261117-warning-scheduler-default","date":"2026-11-17","title":"修复预警调度默认配置失效","module":"产销协同预警","status":"已验证待发布"}
-->
# 修复预警调度默认配置失效

GEA 0.0.309 修复普通安装下保存检测任务报 WARNING_SCHEDULER_NOT_CONFIGURED：Host schema 产生的空调度对象不再遮蔽公司正式服务。显式调度地址仍优先；自定义部署仍须配置，身份与环境隔离保持。

关联 [BUG-20261117-warning-empty-scheduler](../../../bugs/2026/11/BUG-20261117-warning-empty-scheduler.md)。15项定向配置、路由和版本回归通过，旧版真实配置解析链已复现相同错误。正式 SDK 类型、构建、三包预检、实际来源下载与 Native 验收分别回填，不以 HTTP 200 代替保存或定时检测验收。

配套复用已发布 Workbench 0.1.129、Manage company.81 不可变归档，保留品类展开编辑及预警负责人匹配、合并推送、库存与DMS功能。无历史能力删除或修复回退；不新增数据库表、权限或配置服务，不升级Core。修复服务接线不触发真实消息发送。
