<!-- collaboration-record
{"kind":"change","id":"CHANGE-20261112-mps-inbound-release","date":"2026-11-12","title":"MPS入库修复兼容组合 0.0.278","module":"主生产计划(MPS)","status":"已验证待发布"}
-->

# MPS入库修复兼容组合

接收Workbench 0.1.101与Manage company.68，追加精确兼容版本并保留原兼容范围。身份、受控SQL、更新与保留数据协议保持。

- 历史修复审查：保留截止日快照、NULL与真实零区分、重复日拒收及原回归保护。没有删除文件或取消业务能力。生产入库由截止日单值改为日流量月累计，属于用户明确要求的修复。
- 本轮仅发布插件组合，不构建桌面安装器，不修改源数据；安装更新、实际加载和页面数据核对单独验收。
- 使用本机dsh-plugin-release 1.3.1 local_draft，未声明团队技能已同步。
