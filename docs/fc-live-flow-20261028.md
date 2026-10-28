# 分仓补货真实接口验收（2026-10-28）

已通过接口级闭环：原表计划/周期 UPSERT → 回读 → 计算与人工确认 → 确认事件入库 → DMS 测试暂存 → 回执事件入库 → 重复提交和重建持久化控制器后回读原单。

测试单 **S00700199**：客户/地址 49001039，产品 10000362 数量 10、10000363 数量 55，共 65 件。只发生一次真实 DMS 下单 POST。DMS 全局预订单号 `AId8b6d5f687b7da6472d55ab232fd79`，页面批次号 `AI7ee1792066e9456241899871528293`。两者均保留在回执，不能混用。

使用独立测试仓 `FCIT-46f55706-8f07-438f-9b23-40261f5d8a11` 保存验收计划、周期、计算输入；DMS 使用用户已提供的测试客户和商品。库存/计算输入是明确标注的验收数据，不是实时业务库存验收。验收数据与回执保留供复核。此前另一组独立 UPSERT 测试数据已精确清理并回读确认不存在。

## 存储与接线

只新建 `data_service.agent_branch_submission_event`，无自定义触发器、无会话外键；平台当前测试租户已发布 SELECT、INSERT。计划/周期复用 `data_service.agent_branch_plan_import` 和 `data_service.agent_branch_cycle_config`，通过 `/ai/sql/execute` 写入。DDL 由用户授权的管理员连接执行，业务写入没有绕过接口。

Host 配置新增显式兼容模式（放入现有 Host 的 `fcStorage.test`，替换占位符）：

```json
{
  "dataSourceCode": "Postgres-Data-service",
  "published": true,
  "planningLayout": "legacy",
  "warehouseIds": { "<真实分仓编码>": "<原表warehouse_id>" },
  "users": [
    { "tenantId": "<当前测试租户>", "userId": "<获准用户>", "warehouses": ["<真实分仓编码>"] }
  ]
}
```

`warehouseIds` 必须由部署方核实，不能把页面传入的分仓编码直接当原表主键。Host 校验用户/仓范围后生成固定命名参数 SQL；页面不能传表名或 SQL。未选择 legacy 时保留先前追加版本表模式，避免破坏已有配置。

计划按原版 `(warehouse_id,target_month,sku)` UPSERT；提交完整已加载集合，保存时只写实际变化行，遗漏旧 SKU 会拒绝。周期写 JSONB 数组，规则映射为原版 id/level/objectId/cycleDays/status/effectiveFrom/effectiveTo；非7天的通用周期转成数组末尾的仓级兜底规则，不抢显式规则优先级。

计划/周期采用内容哈希版本，回执事件继续用递增整数版本。过期基线拒绝保存；未知写入保留原键并仅回读核对。旧表没有原子 CAS 列，因此“读取基线→UPSERT”之间的跨客户端竞争仍沿用原版更新语义，不能宣称获得分布式并发锁或历史版本回放。

## 验收边界

- 同批两行新增、冲突更新、相同幂等键重放、周期 JSONB 更新，均通过真实接口验证。
- 确认事件 revision=1，DMS 回执 revision=2，回读 stage=dms-received、单号匹配；重复提交未新增订单。
- 定向回归覆盖旧表适配、重复提交、失败恢复、同月多批次等；多批次及丢失归档响应场景的组合测试是离线验证，不冒充本次第二张真实 DMS 单。
- SQL 单次默认最多200个参数、100行。当前计划生成器每变化行11参数，加2个公共参数，最多18个变化行；超限明确拒绝，不拆分成部分成功。页面完整配置与确认快照仍受既有48KB限制，周期显式规则最多12条。大批导入尚未完成验收，需要服务端支持更大的原子批次或后续版本协议。
- 这次使用真实页面持久化类、计算函数、Host存储/DMS适配器及真实远端接口；没有替换当前桌面插件，也没有进行已安装客户端的按钮操作验收。
- 未修改其他对话的源码、PR、CI或已安装桌面版本。源码仍在本任务隔离目录，后续需与最新版本合并、装载专用测试配置并验收页面。

证据在本任务父目录 `acceptance-20261028/`：`live-flow-manifest.json`、`live-flow-sql.jsonl`、`submission-event-publication.json`、`create-submission-event.sql`、`schema-target-verification.json`。没有保存密钥或 token。
