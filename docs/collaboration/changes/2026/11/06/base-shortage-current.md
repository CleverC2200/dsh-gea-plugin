<!-- collaboration-record
{
  "kind": "change",
  "id": "CHANGE-20261106-base-shortage-current",
  "date": "2026-11-06",
  "title": "基地缺货各出口统一到页面日汇总",
  "module": "基地库存",
  "status": "待提交"
}
-->
# 基地缺货各出口统一到页面日汇总

本轮客户端验收发现 SKU 排行已使用日汇总，其余缺货工具仍走旧来源。本次统一基地 summary、locations、detail、sku-ranking 的批次选择，完整保留既有缺口公式、权限、分页及取消语义。未变的分仓、全链与经销商模块不在本次修改范围。

基线：Workbench 7ef172eb、GEA 32e301d0；相对前次已核主线无新同事记录。历史 SKU 合并、正缺口去重计数及 Session 恢复修复均保留；旧公开 helper 保留供协调更新使用，无能力删除。

定向检查：GEA 工具及受控查询 37 项、Workbench 缺货/日汇总/页面范围等 39 项通过。当前账号真实四入口对账一致；候选未发布，后续须完成 CI、构建、来源读回及正式客户端验收。原始受限数据和完整会话只存本地任务证据，不上传。

发布技能：本机 dsh-plugin-release 1.3.0（local_draft，未登记团队维护仓）；使用已登记 GitHub/OSS 目的地，不修改 Core 或权限。
