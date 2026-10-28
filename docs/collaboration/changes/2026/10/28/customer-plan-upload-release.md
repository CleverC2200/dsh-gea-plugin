<!-- collaboration-record
{
  "kind": "change",
  "id": "CHANGE-20261028-customer-plan-upload-gea",
  "date": "2026-10-28",
  "title": "客户库存计划表发行配套兼容声明",
  "module": "插件发行",
  "status": "准备中"
}
-->

# 客户库存计划表发行准备

为已合并的客户库存 Cube 范围映射 #231 准备发行。GEA 保持尚未发布的 0.0.194，Workbench 使用主线 0.1.34；Manage 为已合并的 #95 升至 0.6.3-company.34，本次只在 GEA 既有 exact OR 范围新增该配套版本，保留全部历史范围。无业务代码、权限或数据协议修改，无删除或历史修复回退。

采用用户提供的 dsh-plugin-release 1.0.0 分发包规则；未登记新团队 Skill 来源。配套版本经 PR 合入 main 后固定输入构建，并核验三包交付和发布预检。本轮仅上传固定插件包及发布元数据，不更新正式或测试频道；缺少受信频道签名配置，自动发现更新和设备安装不属于已完成验收。不构建桌面或升级 Core，不向 GitLab 或 npm 发布。当前尚未上传。
