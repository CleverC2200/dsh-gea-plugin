<!-- collaboration-record
{"kind":"change","id":"CHANGE-20261117-warning-owner-sandbox-companion","date":"2026-11-17","title":"配套通知负责人沙箱保存修复","module":"产销协同预警","status":"已发布"}
-->
# 配套通知负责人沙箱保存修复

GEA 0.0.310 在保留0.0.309空配置修复的基础上，补充兼容 Workbench 0.1.130。Workbench修复正式工作台安全沙箱中负责人原生表单不提交的问题；语义、约束验证及原沙箱权限保留，点击和隐式回车复用同一白名单保存函数。Manage company.81复用既有归档，无数据库或权限变更。

真实沙箱回归在旧实现失败，修复后4项负责人页面测试通过。GEA原49项配置、权限、DMS默认值、发行合同回归继续核对；固定构建、三包预检、实际来源与Native验收另行回填。没有任务创建、实际推送或DMS业务操作；不修改其他数据结构。

[PR449](https://github.com/CleverC2200/dsh-gea-plugin/pull/449) 已合并，固定源`0b0ec3388513ffed863d2f45e43acc4949ff9378`。[GEA0.0.310发行](https://github.com/CleverC2200/dsh-gea-plugin/releases/tag/v0.0.310) 与 [Workbench0.1.130发行](https://github.com/CleverC2200/dsh-agent-workbench/releases/tag/v0.1.130) 已读回，test141/stable133整组下载与摘要、固定构建回执、正式预检和隔离安装Host观察通过。130项Workbench受影响回归和57项GEA回归、相应类型及静态检查、两仓CI通过。

本机已安装130/310/81并重启，Core不变。Native原值保存正常返回14条负责人清单、刷新及受控回读内容一致，保存版本推进；此前309保存无反馈边界已修复。原登录配置和其他五个开发工作树摘要保持。未创建、执行真实检测任务、推送消息或操作DMS；失败的原检测任务不自动重放，需用户重新保存。
