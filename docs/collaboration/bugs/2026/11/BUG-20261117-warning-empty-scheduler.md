<!-- collaboration-record
{"kind":"bug","id":"BUG-20261117-warning-empty-scheduler","date":"2026-11-17","title":"空的预警调度配置遮蔽公司默认服务","module":"产销协同预警","category":"配置","cause":"原始遗漏","severity":"P1","status":"已修复"}
-->
# 空的预警调度配置遮蔽公司默认服务

普通安装未填写 warningSchedulerEnvironments 时，公开 Host Config 将其解析成空对象。Transport 只用空值合并选择默认值，空对象因此遮蔽已登记的公司调度服务；保存检测任务和核验接收人均在发请求前报 WARNING_SCHEDULER_NOT_CONFIGURED。服务本身已部署，重新部署 XXL-JOB 无法修复这个客户端配置问题。

在框架实际空配置输入与 Business.warningScheduler 调用之间加入回归，旧逻辑稳定复现相同错误。Transport 将空配置视为未配置，只有公司正式基址可采用已登记 HTTPS 地址；非空显式配置优先，自定义基址不回退公司服务。原身份、租户、环境、取消和请求出口检查保留。没有扩展受控 SQL 或白名单权限。

定向配置、路由与版本回归15项通过，包括自定义部署未注册时零网络请求。正式 SDK 类型、固定输入构建、实际来源和客户端接收分别按发行记录回填。真实通知不作为本轮测试发送；不改动负责人清单、任务业务数据或另一对话的数据结构。

回归直接覆盖框架实际传入的空对象到真实 Business 调度请求。实际 Host Config 解析已现场复现该输入；实际服务连通另行验证。公开 Config 与无关模块不修改。

0.0.309 已发布并安装，源码与验证层级见[发行变更记录](../../../changes/2026/11/17/warning-scheduler-default.md)。空配置到真实 Business 请求的相关回归、服务连接和正式来源核验通过。Native 人员搜索与负责人清单已验证；原值保存未出现完成反馈，真实任务保存及执行没有触发，保留业务验收限制。原失败发生在任务配置与持久化之前，不自动重放。
