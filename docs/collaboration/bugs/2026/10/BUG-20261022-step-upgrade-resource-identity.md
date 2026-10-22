<!-- collaboration-record
{"kind":"bug","id":"BUG-20261022-step-upgrade-resource-identity","date":"2026-10-22","title":"分步升级的业务资源身份冲突使 GEA 后台无法启动","module":"插件更新","category":"功能逻辑","cause":"原始遗漏","severity":"P1","status":"已修复待验证"}
-->

# 分步升级的资源身份冲突

Workbench 0.1.22、Manage 0.6.3-company.25 与 GEA 0.0.182 的实际安装组合中，旧订单履约资源的 orderfulfillment-preview 与 GEA 策略中的 order01 冲突。HTML 资源注册抛出的 INVALID_AGENT_RESOURCE_IDENTITY 中断整个 GEA Host，身份和更新接口一并不可用。隔离 profile 使用同字节原包已复现；三包最终组合通过不能证明分步升级安全。

修复保留该资源的身份拒绝，不注册其 Agent、Skill 或受控能力，不覆盖 GEA 策略。页面授权明确提示更新 Workbench 并重启，其他资源、身份和更新服务继续工作。有效 Consumer、mock、禁用、页面绑定与服务端授权规则保持。

发布前必须在自有 profile 中逐包安装，每步由新进程核 ACTIVE Host、模块归属、安装字节、SDK、客户端图、身份和更新接口。release:preflight 绑定实际中间观察回执，缺任何步骤或最终仍有冲突即拒绝发布。旧更新器必须先升级 GEA 保护版并重启，再升级配套包。

本次源码回归已复现原启动错误并通过定向修复检查。真实历史包的逐步安装、新进程验收、CI、合并、测试频道、Native 与正式频道按本次 PR 和发布回执分别核验；本卡不提前声明这些阶段通过。不改变已有包字节，不读取或迁移用户凭据、会话和草稿。
