<!-- collaboration-record
{"kind":"change","id":"CHANGE-20260924-gea-plugin-125","date":"2026-09-24","title":"GEA 0.0.125 Agent 列表与桌面重提修复","module":"构建发布","status":"已验证待发布"}
-->
# GEA 0.0.125 Agent 列表与桌面重提修复

- 源码基线：远端 `main` 的 `842cffd3ecff3938d333a3eac1eca283504d0d50`（0.0.124）；复用本对话已有的隔离工作树，未收进原主工作区的未提交改动。
- 本次范围：[Agent 列表 MR !178](http://100.100.6.191:20656/chenyonghao/dsh-gea-plugin/merge_requests/178)、[桌面重提 MR !179](http://100.100.6.191:20656/chenyonghao/dsh-gea-plugin/merge_requests/179)，以及插件包版本与 shrinkwrap 根版本 0.0.125。管理端消息卡片 MR !162 不在本次发布范围。
- 同事记录：读取并保留主线现有的混合终态分组和测试夹具 Bug、0.0.124 发行记录；本轮新增[桌面重提](../../../../bugs/2026/09/BUG-20260924-gea-desktop-resubmit.md)与[Agent 列表](../../../../bugs/2026/09/BUG-20260924-gea-agent-picker.md)两张 Bug 卡。
- 风险：移除旧 `gea-html-inventory-all` 预设可能影响引用旧 ID 的历史会话。用户在候选补丁 SHA-256 `cc1335b0284730c6887c762a919d365f02e3760339fcc5f07b44b1bed504f3aa` 说明后明确回复“移除，然后发版”。其余删除行为为凭据读取逻辑等价迁移，定向测试覆盖 Web 和桌面入口。
- 验证：冻结依赖安装、类型检查、完整构建通过；定向 14 项 Agent 列表测试及 13 项凭据／登录测试通过；插件全量 580 项测试中 577 通过、3 跳过、0 失败。未进行真实生产计划重提或旧会话恢复验收。
- 发布技能：发行库最新主线 `1fa4e38e507f6211ccf13544e5633fa66493ec70` 的团队受管理文件与本机规则一致；本机只多钥匙串说明，状态 `current_with_local_notes`。当前仅候选已验证，尚未合并、打包或推进频道。

## 后续补记

合并、包摘要、频道和运行验收在取得事实后另行补记，不把候选写成已发布。
