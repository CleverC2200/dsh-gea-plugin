<!-- collaboration-record
{"kind":"change","id":"CHANGE-20261117-warning-scheduler-default","date":"2026-11-17","title":"修复预警调度默认配置失效","module":"产销协同预警","status":"已发布"}
-->
# 修复预警调度默认配置失效

GEA 0.0.309 修复普通安装下保存检测任务报 WARNING_SCHEDULER_NOT_CONFIGURED：Host schema 产生的空调度对象不再遮蔽公司正式服务。显式调度地址仍优先；自定义部署仍须配置，身份与环境隔离保持。

关联 [BUG-20261117-warning-empty-scheduler](../../../bugs/2026/11/BUG-20261117-warning-empty-scheduler.md)。15项定向配置、路由和版本回归通过，旧版真实配置字段解析链已复现相同错误。正式 SDK 类型、构建、三包预检、实际来源下载与 Native 验收分别回填，不以 HTTP 200 代替保存或定时检测验收。

配套复用已发布 Workbench 0.1.129、Manage company.81 不可变归档，保留品类展开编辑及预警负责人匹配、合并推送、库存与DMS功能。无历史能力删除或修复回退；不新增数据库表、权限或配置服务，不升级Core。修复服务接线不触发真实消息发送。

回归直接覆盖框架实际传入的空对象到真实 Business 调度请求。实际 Host Config 解析已现场复现该输入；实际服务连通另行验证。公开 Config 与无关模块不修改。

GEA 0.0.309 已通过 [PR #446](https://github.com/CleverC2200/dsh-gea-plugin/pull/446) 合并，固定发布源码为 `a7d9d030c57fa300410d06294d3082d45be393a9`；[发行记录](https://github.com/CleverC2200/dsh-gea-plugin/releases/tag/v0.0.309) 已读回。test 140、stable 132 整组三包生产来源下载与摘要核验通过；Workbench 0.1.129、Manage company.81 复用原归档。49项相关回归、正式 Core 类型、静态检查、固定输入构建、三包预检与隔离 Host 安装加载通过。

正式客户端已安装 309 并正常退出、重新启动，Core 保持原版。Native 页面已验证人员搜索结果及14条负责人清单；原值保存尝试未观察到完成反馈，已取消，不能据此声称页面保存通过。没有创建、执行真实检测任务或发送通知。实际 Host 配置解析及调度服务连接、轮询、XXL无写入参数校验已验证；真实任务保存与定时执行仍待业务重试确认。登录和配置文件、其他数据开发工作树保持不变。

后续负责人保存无反馈的沙箱边界已在Workbench130/GEA310修复并通过正式客户端原值保存与回读，见[配套发行](warning-owner-sandbox-companion.md)。309原验收记录按当时事实保留。
