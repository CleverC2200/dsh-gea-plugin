<!-- collaboration-record
{
  "kind": "change",
  "id": "CHANGE-20261112-sales-plan-feedback-release",
  "date": "2026-11-12",
  "title": "销售计划反馈修复发行 0.0.273",
  "module": "销售计划",
  "status": "已发布待验收"
}
-->

# 销售计划反馈修复发行

将 Workbench 0.1.94、0.1.95 加入既有兼容声明，接收销售计划界面与失败提示修复。身份、审批及 DMS 接口逻辑不变。

- 按用户确认调整月初计算口径并移除页面错误编号，保留纠偏口径、现有审批校验和日志。未删除文件或业务能力。
- 源码窗口使用真实接口完成三笔退回、重提和最终 DMS 提交。三笔重提成功，DMS 分别以产品停用或产品主数据缺失拒绝；页面显示具体原因，失败后未误标成功。
- 去除错误编号后，7项错误文案检查与2项提交浏览器回归通过。真实业务失败仍需补齐DMS主数据，本轮不修改主数据。
- 发布技能为本机 dsh-plugin-release 1.3.1 local_draft；正式构建、预检、下载和安装接收已完成。

## 发行回填

- 最终版本 `0.0.273`，固定来源 `c6d60fda6d71465915d0dc3fa153950bf3bff07d`。原0.0.272候选在频道写入前被最新兼容声明取代，原标签及归档保留，未提升频道。
- [GitHub Release](https://github.com/CleverC2200/dsh-gea-plugin/releases/tag/v0.0.273)，包含固定TGZ、release JSON及摘要。
- [主线检查](https://github.com/CleverC2200/dsh-gea-plugin/actions/runs/43149572318)通过；43项发行合同检查通过，源码变更为[PR #381](https://github.com/CleverC2200/dsh-gea-plugin/pull/381)及[PR #382](https://github.com/CleverC2200/dsh-gea-plugin/pull/382)。
- 最终组合为Workbench 0.1.95、Manage 0.6.3-company.65原归档、GEA 0.0.273。测试频道revision 109→110，正式频道101→102，均通过生产来源的匿名check/download。
- 固定三包构建、发布预检、required Core `0accab310546c1bc8d3ad46b8803dcbcfaa02477` 的官方隔离安装与Host/client模块图观察通过。旧Core6156856b的接收曾因服务未就绪超时，本轮接收以当前required Core为准。
- 归档SHA-256：`8d2d326426023b8809cd29ece8bd0a63efcbf0ce3f732cde18b577f123610b80`。
- 本轮未构建桌面安装包或升级用户正式设备，不将失败的DMS业务提交写成成功。
