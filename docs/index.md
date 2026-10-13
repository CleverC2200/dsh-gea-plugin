# GEA 文档索引

本索引区分现行接口、有效业务要求与原始证据。先核项目根开发导航、本票 integration-set、实际 checkout/HEAD/dirty，再按任务选择下列入口。精确版本、脚本、默认值、安装元数据和公开导出从本 checkout 源码与配置读取，不从旧验收记录推断。

## 当前需要核对的风险

- 模型 Consumer、业务工具可信资源与页面身份的当前规则见 [执行链](execution-logic.md)。普通 Session 保留默认模型路由；页面可见不授予业务 Consumer。

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

## 日期证据、研究与交付记录

- [2026-09-10 验收记录](acceptance-2026-09-10.md)
- [三栏工作台验收记录](acceptance-2026-09-11.md)
- [通用 Agent 工作台验收（2026-09-14）](acceptance-workbench-2026-09-14.md)
- [GEA 原生只读工具与取消收尾](agent-tools-2026-09-11.md)
- [账号头像、复制与 MCP 资源读取](agents/2026-09-14-avatar-clipboard-resources.md)
- [桌面公司 MCP 插件遗漏修复](agents/2026-09-14-desktop-company-mcp.md)
- [GEA MCP 工具路由](agents/2026-09-14-gateway-tool-routing.md)
- [aps-business-prompt-v2-review-2026-09-27.html](analysis/aps-business-prompt-v2-review-2026-09-27.html)
- [产销协同业务提示词 V2 评审](analysis/aps-business-prompt-v2-review-2026-09-27.md)
- [产销协同与分仓联合优化交付](analysis/aps-fc-joint-delivery-2026-09-27.md)
- [分仓三轮Web问答日志诊断](analysis/branch-web-log-diagnosis-2026-09-27.md)
- [Cube 汇总能力补齐与验收（2026-09-27）](analysis/cube-summary-delivery-2026-09-27.md)
- [GEA 全局、Agent、工具与 Skill 提示词审计](analysis/prompt-audit-2026-09-25.md)
- [Agent / Skill 编写样例（待实施，不是已生效配置）](analysis/prompt-design-drafts-2026-09-26.md)
- [prompt-inventory-qa-2026-09-26.html](analysis/prompt-inventory-qa-2026-09-26.html)
- [六个业务 Agent 的真实问答测试与根因（2026-09-26）](analysis/prompt-inventory-qa-2026-09-26.md)
- [prompt-optimization-delivery-2026-09-25.html](analysis/prompt-optimization-delivery-2026-09-25.html)
- [GEA 提示词优化交付记录](analysis/prompt-optimization-delivery-2026-09-25.md)
- [GEA 提示词与调用链优化方案](analysis/prompt-optimization-plan-2026-09-25.md)
- [提示词优化独立验收问题单](analysis/prompt-qa-findings-2026-09-26.md)
- [prompt-qa-fixes-2026-09-26.html](analysis/prompt-qa-fixes-2026-09-26.html)
- [提示词优化 QA 修复验收（2026-09-26）](analysis/prompt-qa-fixes-2026-09-26.md)
- [prompt-remediation-plan-2026-09-26.html](analysis/prompt-remediation-plan-2026-09-26.html)
- [GEA Agent / Skill 修订方案：业务材料评估与九类问题治理](analysis/prompt-remediation-plan-2026-09-26.md)
- [prompt-remediation-plan-v2-2026-09-26.html](analysis/prompt-remediation-plan-v2-2026-09-26.html)
- [GEA 优化方案 V2：先修链路，再用真实效果决定结构](analysis/prompt-remediation-plan-v2-2026-09-26.md)
- [prompt-v2-delivery-2026-09-26.html](analysis/prompt-v2-delivery-2026-09-26.html)
- [GEA Prompt V2：实施结果、效果对比与剩余问题](analysis/prompt-v2-delivery-2026-09-26.md)
- [Cube 增量候选与验收边界](analysis/prompt-v2-delivery/cube-candidate/README.md)
- [prompt-v3-delivery-2026-09-26.html](analysis/prompt-v3-delivery-2026-09-26.html)
- [非权限项第三轮：修复与复测结果](analysis/prompt-v3-delivery-2026-09-26.md)
- [权限事项：仅记录，待用户与同事确认](analysis/prompt-v3-delivery/permission-followup.md)
- [客户端更新后插件加载失败排查清单](client-update-issue-checklist.md)
- [团队 Bug 与更新记录](collaboration/INDEX.md)
- [新会话 Agent 列表有重复和演示入口](collaboration/bugs/2026/09/BUG-20260924-gea-agent-picker.md)
- [桌面端退回计划无法重提](collaboration/bugs/2026/09/BUG-20260924-gea-desktop-resubmit.md)
- [混合终态的审批分组可选但动作被整体锁住](collaboration/bugs/2026/09/BUG-20260924-group-terminal-block.md)
- [业务模块测试夹具错误内联 ESM 依赖](collaboration/bugs/2026/09/BUG-20260924-test-module-loading.md)
- [金额默认长数字且模型答复单位与汇总口径不稳](collaboration/bugs/2026/09/BUG-20260925-gea-amount-display.md)
- [成员样例混合查询遇资源歧义时丢弃其它已授权样例](collaboration/bugs/2026/09/BUG-20260925-gea-sample-ambiguity.md)
- [网关业务会话过期后仍尝试取数且提示检查查询字段](collaboration/bugs/2026/09/BUG-20260925-gea-session-expiry.md)
- [工具已返回成员或状态字典却被最终答复否认](collaboration/bugs/2026/09/BUG-20260926-prompt-fact-use.md)
- [新增托管Prompt与Skill未显式进入打包白名单](collaboration/bugs/2026/09/BUG-20260926-prompt-pack-files.md)
- [Cube操作符预检缺口](collaboration/bugs/2026/09/BUG-20260927-cube-operator-preflight.md)
- [DSML协议文本漏检](collaboration/bugs/2026/09/BUG-20260927-dsml-spaced-calls.md)
- [ASAR依赖解析回归](collaboration/bugs/2026/09/BUG-20260927-layered-runtime-resolution.md)
- [模型总时限与诊断](collaboration/bugs/2026/09/BUG-20260927-model-total-timeout.md)
- [插件历史占用持续增长](collaboration/bugs/2026/09/BUG-20260927-plugin-history-growth.md)
- [Skill分页参数误填](collaboration/bugs/2026/09/BUG-20260927-skill-paging-path.md)
- [Windows 安装耗时](collaboration/bugs/2026/09/BUG-20260927-windows-install-io.md)
- [业务卡片输出恢复](collaboration/bugs/2026/09/BUG-20260928-business-card-output.md)
- [桌面0.0.26频道兼容](collaboration/bugs/2026/09/BUG-20260928-desktop26-channel-compat.md)
- [证据额度耗尽后结束工具阶段](collaboration/bugs/2026/09/BUG-20260928-evidence-budget-stop.md)
- [退回计划的通过错误依赖客户重提服务账号](collaboration/bugs/2026/09/BUG-20260928-returned-role-approval.md)
- [销售结果跨来源月份格式](collaboration/bugs/2026/09/BUG-20260928-sales-month-encoding.md)
- [可发现Skill的两阶段加载问题](collaboration/bugs/2026/09/BUG-20260928-skill-selection.md)
- [Bug 分类表 2026/09](collaboration/bugs/2026/09/INDEX.md)
- [更新记录 2026/09/24](collaboration/changes/2026/09/24/INDEX.md)
- [GEA 0.0.125 Agent 列表与桌面重提修复](collaboration/changes/2026/09/24/gea-plugin-125.md)
- [GEA 授权取数、计划汇总与桌面运行配置发行整合](collaboration/changes/2026/09/24/gea-query-release.md)
- [更新记录 2026/09/25](collaboration/changes/2026/09/25/INDEX.md)
- [GEA Agent 查询止损与金额易读展示候选](collaboration/changes/2026/09/25/gea-agent-query-reliability.md)
- [更新记录 2026/09/26](collaboration/changes/2026/09/26/INDEX.md)
- [GEA 0.0.127 Prompt与证据链发布](collaboration/changes/2026/09/26/gea-prompt-release.md)
- [更新记录 2026/09/27](collaboration/changes/2026/09/27/INDEX.md)
- [桌面0.0.24](collaboration/changes/2026/09/27/desktop-install-storage-024.md)
- [客户端0.0.25](collaboration/changes/2026/09/27/desktop-runtime-fix-025.md)
- [GEA 0.0.128](collaboration/changes/2026/09/27/gea-128-aps-fc.md)
- [GEA 0.0.130](collaboration/changes/2026/09/27/gea-inventory-recovery-130.md)
- [GEA 0.0.129 页面选择与短引用](collaboration/changes/2026/09/27/gea-page-interaction-129.md)
- [更新记录 2026/09/28](collaboration/changes/2026/09/28/INDEX.md)
- [隐藏三个演示 Agent 并保留业务页面](collaboration/changes/2026/09/28/gea-hide-preview-agents.md)
- [GEA 0.0.134 发布范围](collaboration/changes/2026/09/28/gea-plugin-134.md)
- [GEA 0.0.135](collaboration/changes/2026/09/28/gea-plugin-135.md)
- [恢复月初与纠偏切换入口](collaboration/changes/2026/09/28/gea-restore-plan-tabs.md)
- [退回计划按审批角色重审当前版本](collaboration/changes/2026/09/28/gea-returned-role-approval.md)
- [更新月份 2026/09](collaboration/changes/2026/09/INDEX.md)
- [纠偏审批实现与验收](correction-acceptance.md)
- [纠偏功能交付审查记录](correction-review.md)
- [客户端本轮修改事项](desktop-change-backlog-20260927.md)
- [Windows 安装与历史占用优化：实施记录](desktop-install-storage-implementation-20260927.md)
- [DMS 模拟回写验收（Issue #23）](dms-mock-acceptance.md)
- [GEA Prompt优化：管理端改动与协调交接](handoff/prompt-admin-coordination-2026-09-26.md)
- [分辨率适配改动记录（供决策）](layout-adaptation-log.md)
- [正式环境模型与审批范围核对](model-and-approval-audit-2026-09-11.md)
- [GEA 用户端 Notification API 对照笔记](notification-user-api-research-2026-09-16.md)
- [消息待办只读接入](notifications-2026-09-11.md)
- [页面交互基础版](page-interaction-basic.md)
- [PC 分辨率适配审计（只记录，未改动）](pc-resolution-audit.md)
- [历史插件占用：诊断与清理范围](plugin-storage-retention-20260927.md)
- [GEA 0.0.14](releases/0.0.14.md)
- [GEA 0.0.15](releases/0.0.15.md)
- [GEA 0.0.16](releases/0.0.16.md)
- [GEA 0.0.17：角色审批与流程通知分离](releases/0.0.17.md)
- [GEA 0.0.63](releases/0.0.63.md)
- [GEA 0.0.64](releases/0.0.64.md)
- [GEA 0.0.65](releases/0.0.65.md)
- [GEA 0.0.66](releases/0.0.66.md)
- [GEA 0.0.67](releases/0.0.67.md)
- [GEA 0.0.68](releases/0.0.68.md)
- [GEA 0.0.18](releases/gea-0.0.18.md)
- [GEA 0.0.19-beta.2（测试频道）](releases/gea-0.0.19-beta.2.md)
- [GEA 0.0.24](releases/gea-0.0.24.md)
- [GEA 0.0.25](releases/gea-0.0.25.md)
- [GEA 0.0.50](releases/gea-0.0.50.md)
- [GEA 0.0.51](releases/gea-0.0.51.md)
- [GEA 0.0.52](releases/gea-0.0.52.md)
- [GEA 0.0.53](releases/gea-0.0.53.md)
- [GEA 0.0.54](releases/gea-0.0.54.md)
- [GEA 0.0.55](releases/gea-0.0.55.md)
- [GEA 0.0.56](releases/gea-0.0.56.md)
- [GEA 0.0.58](releases/gea-0.0.58.md)
- [GEA 0.0.59](releases/gea-0.0.59.md)
- [GEA 0.0.60](releases/gea-0.0.60.md)
- [Cube MCP 发送前预检与通道标注（2026-09-23）](reports/cube-mcp-preflight-20260923.md)
- [Cube 查询把数值字段放进 measures 被拒（2026-09-23）](reports/cube-measure-mismatch-20260923.md)
- [问答取数：Cube 度量补充方案（业务核对版）](reports/cube-measure-proposal-20260923.md)
- [Cube 成员名护栏：把"猜错成员名"拦在发出去之前（2026-09-23）](reports/cube-member-guard-20260923.md)
- [Cube 预设筛选试点（2026-09-24）](reports/cube-segment-presets-20260924.md)
- [经销商查询执行问题修复（2026-09-24）](reports/dealer-query-evidence-20260924.md)
- [给 GEA 网关侧的三条改进请求（2026-09-23）](reports/gea-gateway-requests-20260923.md)
- [MCP 授权资源接口接入与查询执行验收](reports/mcp-authorized-resources-20260924.md)
- [模块 MCP 通道逐个探测（2026-09-22）](reports/mcp-channel-probe-20260922.md)
- [查询部分成功后的错误收口修复](reports/partial-query-evidence-20260924.md)
- [销售计划提示词交付包 · 与插件实测的对齐（2026-09-23）](reports/prompt-package-alignment-20260923.md)
- [当前开发改动清单（待用户确认，2026-09-24）](reports/release-change-inventory-20260924.md)
- [安全库存 Agent 指令对齐（2026-09-24）](reports/safety-stock-prompt-alignment-20260924.md)
- [销售计划取数与需求预测度量：2026-09-24 实施及验收](reports/sales-plan-aggregate-closure-20260924.md)
- [DeepSeek 官方客户端：更新、下载、安装与存储对照](research/deepseek-official-desktop-comparison-20260927.md)
- [DeepSeek 官方桌面：核心与插件存储、恢复及旧版本占用](research/deepseek-official-storage-20260927.md)
- [DeepSeek 官方桌面客户端：更新、下载、缓存与恢复研究](research/deepseek-official-updates-20260927.md)
- [GEA 0.0.128 发布审查](reviews/aps-fc-release-20260927.md)
- [桌面 0.0.24 提交与发布范围](reviews/desktop-0.0.24-release-20260927.md)
- [GEA 0.0.135提交审查](reviews/gea-0.0.135-release-20260928.md)
- [GEA 0.0.130 提交审查](reviews/inventory-recovery-release-20260927.md)
- [页面选择交互发行审查](reviews/page-interaction-release-20260927.md)
- [GEA 0.0.127 提交与历史修复审查](reviews/prompt-release-20260926.md)
- [月初与纠偏入口恢复：提交审查](reviews/restore-plan-tabs-20260928.md)
- [退回计划按角色重审：提交审查](reviews/returned-plan-approval-20260928.md)
- [销售结果查询修复：MR提交审查](reviews/sales-result-query-fix-2026-09-28.md)
- [销售计划客户端审批纠偏功能理解](sales-plan-client-approval-correction-research-2026-09-13.md)
- [干净源码目录验收](source-install-acceptance-2026-09-11.md)
- [UI 全家桶兼容迁移验收（2026-09-15）](ui-bundle-migration-20260915.md)
- [Windows 0.0.23 候选：2026-09-27 第二次实机报告](windows-install-result-0.0.23-20260927.md)
- [Windows 安装提速：2026-09-27 实机结果](windows-install-result-20260927.md)
- [Windows 安装慢：同盘移动诊断候选](windows-install-speed-20260927.md)
- [Windows 0.0.24 启动与更新状态回归](windows-layered-update-regression-20260927.md)

## 旧公司桌面说明

- [Windows 安装诊断（一次运行）](../desktop/INSTALL-DIAGNOSTICS-README.md)
- [飞书唤醒与 aionui 接管](../desktop/NAVIGATION.md)
- [GEA Electron 桌面](../desktop/README.md)
- [应用图标](../desktop/build/README.md)
- [插件市场运行状态修复（2026-09-14）](../desktop/patches/README.md)

## 旧Agent过程记录与任务草稿

- [Agent Note: Keep the GEA approval workspace read-only](../.agents/notes/implemented/feature/2026-09-11-approval-workspace-ui.md)
- [Agent Note: GEA 审批工作台保持只读](../.agents/notes/implemented/feature/2026-09-11-approval-workspace-ui.zh.md)
- [Agent Note: Keep the forecast surface separate from dsh chat ownership](../.agents/notes/implemented/feature/2026-09-11-forecast-surface-composition.md)
- [Agent Note: 预测业务 Surface 与 dsh 对话归属分离](../.agents/notes/implemented/feature/2026-09-11-forecast-surface-composition.zh.md)
- [Read-only GEA notifications](../.agents/notes/implemented/feature/2026-09-11-readonly-notifications.md)
- [GEA Desktop business distribution](../.agents/notes/implemented/feature/2026-09-15-desktop-business-distribution.md)
- [Desktop login initialization](../.agents/notes/implemented/feature/2026-09-15-desktop-login-startup.md)
- [Desktop release check scope](../.agents/notes/implemented/feature/2026-09-15-desktop-release-check-scope.md)
- [Login and desktop waiting states](../.agents/notes/implemented/feature/2026-09-15-welcoming-login-states.md)
- [销售计划只读插件任务拆分草稿](../.scratch/sales-plan-readonly/README.md)
- [01：独立安装后跑通登录、单页查询与 Session 读回](../.scratch/sales-plan-readonly/issues/01-installable-tracer.md)
- [02：登录过期后恢复查询，并隔离不同环境的数据](../.scratch/sales-plan-readonly/issues/02-login-recovery.md)
- [03：按周期筛选和分页，并发送准确的计划记录](../.scratch/sales-plan-readonly/issues/03-filtered-plan-list.md)
- [04：查看计划详情和版本，并保留所选数据到 Session](../.scratch/sales-plan-readonly/issues/04-plan-details-versions.md)
- [05：查看版本 SKU，并预览可发送的数据范围](../.scratch/sales-plan-readonly/issues/05-version-skus-snapshot.md)
- [06：用真实模型分析选中的单条计划快照](../.scratch/sales-plan-readonly/issues/06-real-model-analysis.md)
- [07：正确处理分析中断、取消与显式重试](../.scratch/sales-plan-readonly/issues/07-analysis-failure-recovery.md)
- [08：交付包含版本和 SKU 的可追溯真实分析](../.scratch/sales-plan-readonly/issues/08-complete-readonly-analysis.md)

## 已有历史快照

- [AGENTS.md](history/AGENTS-pre-agent-environment-04.md)
- [GEA 销售计划只读插件](history/README-pre-agent-environment-04.md)
- [能力契约（Capability Contract）与模块注册表](history/capability-contract-pre-agent-environment-04.md)
- [当前官方核心的插件安装与回切](history/install-before-installable-delivery.md)
- [本地依赖与按需构建](history/local-development-pre-agent-environment-04.md)

## 受保护设计数据

- [2026-09-17 历史设计 JSON](../.impeccable/design.json)：仅标题增加历史范围；token、组件、HTML、CSS 原样保留，当前主题与页面归属从 [设计入口](../DESIGN.md) 读取。
