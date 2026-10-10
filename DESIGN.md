# GEA 视觉资源入口

业务页面、公共布局和共享样式由同组 Workbench 持有。改页面、日志中心或认证呈现时，先读 [Workbench 页面合同](../dsh-agent-workbench/docs/workbench-contracts.md)，主题资源以该仓 `theme/tokens.css` 和页面实际作者源为准。GEA client 只提供身份投影和账户动作，不维护另一套页面视觉系统。

[原 GEA Workbench 设计说明](docs/history/current-docs-before-20261010/DESIGN.md) 按原字节保留，包含接口日志中心的紧凑布局、状态文字、脱敏证据和交互理由。它用于追溯已迁移页面，不作为当前公共 token、断点或页面归属的第二权威。需要改变原产品要求时，结合有效需求和当前 Workbench 实现判断。

[设计 JSON](.impeccable/design.json) 的标题标明历史范围，色值、token、组件、HTML/CSS 仍为原数据；完整原 JSON 见 [原件](docs/history/current-docs-before-20261010/.impeccable/design.json)。[日志中心资料](.impeccable/surfaces/src-workbench-api-log-center-tsx.md) 只路由到当前 Workbench 作者源与 GEA Host 执行规则。
