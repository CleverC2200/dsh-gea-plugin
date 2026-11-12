# GEA 文档索引

本索引区分现行接口、有效业务要求与原始证据。先核项目根开发导航、本票 integration-set、实际 checkout/HEAD/dirty，再按任务选择下列入口。精确版本、脚本、默认值、安装元数据和公开导出从本 checkout 源码与配置读取，不从旧验收记录推断。

## 当前需要核对的风险

- 模型 Consumer、业务工具可信资源与页面身份的当前规则见 [执行链](execution-logic.md)。普通 Session 保留默认模型路由；个人 Agent 沿实际 Core revision 的可信 Cube 引用反查来源 owner 与 Consumer，未引用不开放工具。页面可见不授予业务 Consumer。

- 真实角色审批仍须服务端支持显式角色合同、组织授权、快照与事务；[V1.3 业务规则](../specs/sales-plan-role-approval-v1.3.md) 明确覆盖旧通知节点授予权限、状态10可SAVE等冲突口径。当前 Host 的 SAVE 状态与角色校验见 [执行链](execution-logic.md)。原 [角色重审记录](reviews/returned-plan-approval-20260928.md) 保留未做真实后端联调的范围，不能用历史发行补齐。
- [纠偏合同](correction-backend-handoff.md) 与 [原验收](correction-acceptance.md) 仍需确认字段、absolute-net事务、显式零、实际流程与当前环境权限。DMS 按 [模拟记录](dms-mock-acceptance.md) 只完成模拟，不完成真实计划或正式DMS。
- 分析发起、首次提单与退回重提按 [执行链](execution-logic.md) 区分。退回重提有Host接线，当前环境凭据与真实回读验收需对应证据；它不提供独立首次提单。
- 通知读取不自动写；当前Host已有显式状态/审批命令，见 [执行链](execution-logic.md)。原 [只读接入](notifications-2026-09-11.md) 和 [v1.17 对照](notification-user-api-research-2026-09-16.md) 是日期证据，不代表当前全部实现只读或目标服务已部署。
- 页面回执、Core Session恢复与冷重启后的引用正文可读分开核对，见同组 [Workbench 恢复](../../dsh-agent-workbench/docs/presentation-recovery.md)。页面草稿与业务保存分开；原未完成项不因文档路由替换关闭。
- 原 [事实采用](collaboration/bugs/2026/09/BUG-20260926-prompt-fact-use.md)、[单位与金额](collaboration/bugs/2026/09/BUG-20260925-gea-amount-display.md)、[模型时限](collaboration/bugs/2026/09/BUG-20260927-model-total-timeout.md) 的真实模型或来源缺口保留。有限样本、fixture和提示词改动不等于全部业务回答正确。
- [三包交付](package-delivery.md) 的 packaged、普通安装/Loader接收和Native/Windows/真实业务分别留证；历史接收失败、缺集合绑定、旧公司桌面Windows与签名边界均按原记录保留。本次整理不运行应用、不补写通过结论。

下列日期记录中的“当前”“已完成”“未完成”、本机路径、端口、版本与授权均限原时间和输入。历史发行指令仅用于追溯，不能授权正式GitLab、OSS、npm、频道或正式客户端操作。原法律、业务Prompt/Skill、产品HTML、失败与回执保持原字节；历史断链或缺失本地证据按原路径记录，不伪造补齐。现行入口被改写的原文与摘要映射见 [本次历史快照](history/current-docs-before-20261010/INDEX.md)。

## 现行工程与执行入口

- [GEA 工程入口](../AGENTS.md)
- [GEA 视觉资源入口](../DESIGN.md)
- [GEA 插件产品职责](../PRODUCT.md)
- [GEA 身份与受控执行插件](../README.md)
- [GEA 静态架构入口](../archify.md)
- [票据跟踪入口](agents/issue-tracker.md)
- [AionUi 模型路径追溯](aionui-model.md)
- [Business roles and official standard capabilities](business-standard-capabilities.md)
- [当前能力声明与受控执行](capability-contract.md)
- [只读交付核对与接续](delivery-check.md)
- [GEA 身份、资源与执行链](execution-logic.md)
- [HTML 页面适配入口](html-plugin-adaptation-checklist.md)
- [当前三核心插件安装](install.md)
- [交互与引用授权入口](interaction-permission-contract.md)
- [本地依赖与按需检查](local-development.md)
- [串行合并源码候选与未启用边界](serial-merge-controller.md)
- [三包本地交付入口](package-delivery.md)
- [页面自述试点追溯](page-bridge-v2-pilot.md)
- [页面桥与 GEA 执行边界](page-bridge.md)
- [原正式发行流程追溯](plugin-release-update-guide.md)
- [当前官方客户端与源码组合验证](plugin-split-validation.md)
- [侧栏与页面验证入口](sidebar-e2e.md)
- [当前 source Host 窗口准入](window-launch-admission.md)

- [接口日志中心：现行归属入口](../.impeccable/surfaces/src-workbench-api-log-center-tsx.md)

## 业务要求与后端合同

这些正文保留有效需求、覆盖关系和未验收边界。规格中的旧开工路径、原工具结论与测试策略只描述原输入；执行时沿当前导航与授权复核，不恢复旧路径。

- [需求预测 Agent V1.8 迭代清单（销售计划审批工作台）](approval-workbench-v1.8-checklist.md)
- [纠偏接口对接清单](correction-backend-handoff.md)
- [销售计划 · 右侧 AI 会话区原型说明 V1](prototypes/sales-plan-conversation-spec-v1.md)
- [销售计划客户端审批纠偏规格草案](../specs/sales-plan-correction.md)
- [sales-plan-readonly-plugin.md](../specs/sales-plan-readonly-plugin.md)
- [销售计划 · 可见性、角色审批与流程通知统一口径 V1.3](../specs/sales-plan-role-approval-v1.3.md)

## 受保护业务Skill

按功能与资源归属消费原件，不作为通用Agent工程指令重写。未修改正文或运行字符串。

- [安全库存](../presets/inventory-aqkc.skill.md)
- [经销商库存](../presets/inventory-dealer.skill.md)
- [分仓库存](../presets/inventory-fc.skill.md)
- [全链路库存](../presets/inventory-qll.skill.md)

## 产品与法律原件

按功能与资源归属消费原件，不作为通用Agent工程指令重写。未修改正文或运行字符串。

- [THIRD_PARTY_DESKTOP_NOTICES.txt](../desktop/THIRD_PARTY_DESKTOP_NOTICES.txt)
- [setup.html](../desktop/setup.html)
- [sales-plan-conversation-prototype-v1.html](prototypes/sales-plan-conversation-prototype-v1.html)

## 历史追溯

日期验收、研究与发行记录保留其原提交、输入和环境范围。只有追溯对应业务缺口时才读取，不作为日常实现入口，也不能证明当前服务、安装或发布状态。

历史资料通过文件名或 Git 提交检索。旧工程 AGENTS/README 快照已从工作树退场，需要还原时读取[清理前固定提交](https://github.com/CleverC2200/dsh-gea-plugin/tree/b5feb8a1f33cdc683c012f8292c328cac17276b8/docs/history)。原始失败、未完成业务要求与实际测试输入继续保留。
