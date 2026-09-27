# 产销指标数据映射

以下是业务映射线索，不是已授权的可执行SQL。先从当前APS授权目录匹配实际模型与成员；原schema限定SQL片段仅供核对，不能直接提交禁止schema前缀的受控SQL入口。

**已有数字化映射（持续补充）：**

以下逐项记录附件已提供的表、字段及表达式。“已提供”表示资料中存在，不代表已连接数据库或完成执行验证。已有信息应作为取数入口使用，不因局部缺失忽略整项映射；缺失部分必须列明，不依据业务量名称猜字段。正式计算还需运行时确认查询权限、字段存在、必要过滤、粒度及数据覆盖。

| 指标 | 附件已提供的数据源 | 已提供字段及含义 | 已有过滤、关联或字段公式 | 待补充或核验 |
|---|---|---|---|---|
| 作废率 | `hive.dw.dws_scm_cust_cancel_change_qty a`；客户维表 `hive.dw.dim_cust c` | `cancel_qty`：作废量；`order_qty`：下单量。原字段说明混入“OMS原始需求量”“发货数量”，存在冲突 | `a.cust_code=c.cust_code`，LEFT JOIN；`a.order_typename='作废率'`；附件字段公式 `cancel_qty/order_qty` | 时间字段、12小时条件是否已在底表实现、按订单张数或商品量、聚合方式、维表唯一性及口径冲突 |
| 改单率 | `hive.dw.dws_scm_cust_cancel_change_qty a`；`hive.dw.dim_cust c` | `cancel_qty`：此指标下附件指向改单量，但通用名称说明为作废量；`order_qty`：有效报单量，名称说明为下单量 | `a.cust_code=c.cust_code`，LEFT JOIN；`a.order_typename='改单率'`；附件字段公式 `cancel_qty/order_qty` | 时间字段、锁定窗口、作废排除、绝对值是否已处理、聚合及阈值冲突；不能把字段名当最终业务含义 |
| 订单满足率-缺货量 | `scm_dev.dwd_scm_shortage_supply_match` | 已开订单需求量、发货量对应字段未提供 | 业务公式：已开订单商品数量－已发货量；技术公式未提供 | 数量字段、时间归属、已开状态过滤、粒度、是否截零及数量单位 |
| 订单满足率 | `scm_dev.dwd_scm_execute_final` | `need_qty_origin`：附件映射为OMS原始需求量；`qtyshipped`：发货数量 | 附件单行表达式 `1-((need_qty_origin-qtyshipped)/need_qty_origin)`；按已确认数量加权业务公式，汇总表达式为 `SUM(qtyshipped)/SUM(need_qty_origin)`，后者是本稿推导，不是附件原SQL | 日期字段、主键、零发货覆盖、单位换算、改单/主辅单处理后需求字段是否仍等同原始需求、超发及过滤规则 |
| 准交率 | `scm_dev.dws_scm_order_trace_final` | `is_ontime`：准交标识；`executeorderno`：附件计数使用的订单号 | `COUNT(DISTINCT IF(is_ontime=1,executeorderno,NULL))/COUNT(DISTINCT executeorderno)` | 应交订单池过滤、交期及实际交付字段、+12小时是否已实现、未交覆盖和拆单准交归并 |
| 可发货天数 | `hive.dw.dws_scm_stock_daily_plan_summary_result_final` | 附件“计算公式和表结构字段映射”栏提供 `zhouzhuan_keyong_sub_qty_order`，未明确是否为结果字段或基础量 | 未提供字段级公式；保留业务公式：可用库存/((月度需求计划+月度调拨出库计划×0.5)/当月天数) | 该字段含义及单位、日期、可用库存/需求计划/调拨计划字段、版本、10/20/月末取样与平均算法 |
| 未开订单-订单缺货量 | `scm_dev.dws_scm_order_trace_final` | 未开需求量、可用库存量对应字段未提供 | 业务公式 `MAX(未开订单需求量-可用库存量,0)`；技术表达式未提供 | 未开状态、下发T/W状态、时间、需求/库存字段、关联粒度、共享库存分配及去重规则 |
| 大日期数量 | `hive.dw.dwd_scm_material_age_his` | `inv_qty`：库存量；`age_days`：附件年龄过滤字段；`dt`：日分区字段 | 附件过滤 `age_days>60`；按数量业务定义推导：指定同一 `dt` 下筛选后汇总 `inv_qty` | `dt`格式及覆盖、数量单位、库存范围、库龄计算基准及重复记录规则 |
| 产品新鲜度 | 附件说明“数据源同大日期数量，需要新增计算”，因此来源指向 `hive.dw.dwd_scm_material_age_his` | 复用 `inv_qty`、`age_days`、`dt`；专门结果字段未提供 | 按业务公式推导：同一快照与范围内，`1-SUM(CASE WHEN age_days>60 THEN inv_qty ELSE 0 END)/SUM(inv_qty)`；这是未经执行的候选表达式；age_days为NULL时会落入ELSE 0，不能直接采用，必须按指标定义的缺失保护处理 | 同口径总库存范围、零分母、单位；附件工单/入库和月报备注是否另属其他指标需核对 |
| 生产计划达成率 | `hive.dw.dwd_prod_schedule_detail` | `deliv_qty`：实际生产量；`order_qty`：同期计划量 | 附件字段公式 `deliv_qty/order_qty`；按跨周期业务规则推导 `SUM(deliv_qty)/SUM(order_qty)` | 实际及计划日期字段、计划版本、工厂/产线/SKU字段、唯一记录粒度和排除规则 |
| 需求预测准确率 | `scm_dev.dwd_scm_demand_accuracy` | 下单量、发货量、初版计划量、纠偏计划量对应字段未提供 | 业务算法已由用户确认，见上文；附件“发货量÷预测量”说明不作为准确率算法 | 单品/月份/基地等字段、版本标识、下单和发货映射、初版/纠偏计划映射；纠偏字段待补充，不能直接生成最终准确率 |
| 销售提报准确率 | `scm_dev.dwd_scm_sales_accuracy`（月）；`hive.dw.ads_scm_cust_deliv_daily`（日） | 业务量对应字段未提供 | 按销售提报主体分别应用附件偏差公式及初版/纠偏加权，技术公式未提供 | 月表是否存基础量或结果、日月表关系、关联键、计划版本、下单/发货字段；原公式初版项写“初版需求预测准确率”，需核对名称，不跨主体混取 |
| 销售预算达成率 | `doris_dw.ads_sales_prov_budget_act_monthly` | `BQ_XSE`：本期销额；`YS_XSE`：预算额 | 附件字段公式 `BQ_XSE/YS_XSE`；月度只用不含税收入，年度按月度均值 | 月份及维度字段、预算版本、收入是否已不含税、预算重复粒度与聚合算法 |
| 任务完成率 | 任务台账，技术表名未提供 | 任务ID、应完成时间、完成/验收状态等字段未提供 | 业务公式：按要求完成任务数/同期应完成任务数 | 具体表、字段、任务池与验收规则、取消处理、严重及健康阈值冲突 |
| 任务数 | 任务台账，技术表名未提供 | 未提供 | 业务公式：待办+在办+已办结事项数，按唯一事项统计 | 任务表、ID、状态、时间归属和去重；不能将台账名称当数据库表名 |
| 超时订单数 | 未提供 | 未提供 | 只有业务定义，无字段公式 | 表、订单/节点键、时间字段、时效配置、暂停及去重规则 |
| 预警订单数 | 未提供 | 未提供 | 只有业务定义，无字段公式 | 表、订单/节点键、规则和版本、命中时间、解除状态及去重 |
| 需求预测达成率 | 未提供正式表名；附件截图是业务线索，不构成表字段映射 | 未提供 | 业务公式：月累计发货量/整月需求预测量 | 发货及计划来源、字段、主体、版本、月份与关联方式；不自动复用准确率表 |
| 销售提报达成率 | 未提供正式表名 | 未提供 | 业务公式：月累计发货量/整月销售提报量 | 发货与提报来源、字段、版本、月份和关联方式；日发货表仅可作为待核验候选，不视为已确认映射 |

订单满足率已提供的分析维度：`belong_base`＝所属基地，`product_categ_name`＝品类大类，`region_name`＝大区，`province_region_name`＝省区。订单主键字段未在本附件该行给出，不猜测。其他指标不自动继承这些维度字段。

已有技术片段只表达已知条件，不是完整可执行查询：

```sql
-- 作废率：附件原有表关联与业务类型条件
FROM hive.dw.dws_scm_cust_cancel_change_qty a
LEFT JOIN hive.dw.dim_cust c ON a.cust_code = c.cust_code
WHERE a.order_typename = '作废率'

-- 改单率：相同表关联，业务类型改为
WHERE a.order_typename = '改单率'

-- 大日期数量：在已明确的同一日分区内，再应用附件原过滤
WHERE age_days > 60
```

时间字段、日期筛选值及其他条件未补齐前，不将这些片段当作完整查询直接执行。字段映射已提供且足够、必要条件已核实、工具有权限时才取数计算；只缺不影响目标的辅助字段时完成可支持部分，不机械地要求全部字段齐全。

后续补充按指标更新：`业务量→系统/表→字段→日期归属→版本→关联键→过滤/排除→聚合/去重→单位换算→确认状态`。优先保留已提供内容，新增信息核对冲突后更新对应项。


## 当前接入边界

- 销售计划提报结果、计划结果：业务源data_service.agents_sales_plan_detail_mi，对应授权Cube模型agents_sales_plan_detail_mi。plannum_sum和allnum_sum单位件，分别汇总不相加；plane_date与load_time按实际期间核对。实时审批另用在线接口。该源不替代需求预测准确率表。
- 库存qtylive对应agents_scm_inventory_age.available_qty_sum，单位件，限一个快照日期和时刻。productage/snapshot_date不能仅凭名称当作其他表age_days/dt的已验证同义映射。
- 物理表→授权资源/模型→成员→业务粒度→过滤/版本→单位→覆盖逐项确认。未提供关联键不猜跨表关联；资料列名不直接当Cube完整成员名。
- 公式明确但技术映射缺失，可以解释算法或对用户明确提供的数据计算，不能编造当前值；辅助字段缺失不阻断独立可支持部分。
