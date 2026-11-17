<!-- collaboration-record
{
  "kind": "bug",
  "id": "BUG-20261106-base-shortage-batch",
  "date": "2026-11-06",
  "title": "基地缺货总览与SKU排行读取不同批次",
  "module": "基地库存",
  "category": "数据计算",
  "cause": "原始遗漏",
  "severity": "P1",
  "status": "已修复待验证"
}
-->
# 基地缺货总览与 SKU 排行读取不同批次

更新后查询基地 SKU 缺货排行，并要求同时核对基地总览。旧实现只对 SKU 排行调用日汇总选择器；summary、locations、detail 仍直读来源 SQL。权限受限且源快照不同步时，页面及 SKU 排行有缺货，另两个出口却返回零，并可能诱发模型反复取数。

四个入口现共用 Workbench 的日汇总选择、固定批次和分页校验。原订单状态、归属、三层净缺口公式及权限不变；缺失或拒权不回退原始来源。保留旧 SKU helper 供更新过程中的旧 Host 调用。Node helper 复用已交付的 query-client 模块，避免重复打包造成错误类身份不同、丢失结构化拒权信息。

验证：实际 Host 工具回归覆盖四种 view、缺失/拒权、完整分页、身份变化和取消；受限账号四种 view 的批次、快照及总量已对账。候选尚未发布，正式更新后的 Native 问数仍须复测。修复范围不删除功能或改变权限，不需额外风险确认。

## 处理历史

| 日期 | 状态 | 证据 |
|---|---|---|
| 2026-11-06 | 已修复待验证 | current-shortage-tool 与 configured-html-query 定向测试通过；待新版本安装验收 |
