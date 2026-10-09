<!-- collaboration-record
{"kind":"change","id":"CHANGE-20260928-returned-role-approval","date":"2026-09-28","title":"退回计划按审批角色重审当前版本","module":"销售计划","status":"已发布待验收"}
-->
# 退回计划按审批角色重审当前版本

- 基线：`a2144c67891b37492e4ec96ef4721b312b4794b3`；分支 `codex/returned-plan-approval`；范围为 GEA 审批客户端及 Host，不改版本/依赖/桌面壳/后端。
- 退回单通过改为当前版本角色审批；单笔、批量、混合选择均不再依赖客户重提服务账号。保留权限、版本、快照和契约检查。
- 仅服务端明确支持角色契约时发送操作角色和快照，旧服务基础字段兼容保留。
- 问题：[BUG-20260928-returned-role-approval](../../../../bugs/2026/09/BUG-20260928-returned-role-approval.md)。已核对原桌面凭据加载与混合终态分组修复，均保留。
- 审查：[历史行为、删除范围和用户授权](../../../../../reviews/returned-plan-approval-20260928.md)。用户已明确要求提交 MR 并合并；尚未授权发行。
- 验证：60 项不同用例、类型检查、插件构建通过；具体文件与覆盖见审查记录。使用受控服务，真实后端联调尚未完成。
- 技能：团队来源 `4db0c2a7b62072fa6b667a85d840893811f95c5d`；17 个受管理文件一致，状态 `current_with_local_notes`。
- MR 与候选 SHA 在 MR 创建后记录；本次不发布插件或客户端。

2026-09-28：GEA 0.0.135经MR !206、!207合并发布；四份频道和8个不同包地址匿名校验通过。发行回执：docs/releases/gea-0.0.135-verification.json。Windows实机更新与真实后端审批仍待验收。
