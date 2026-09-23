# 问答取数：Cube 度量补充方案（业务核对版）

日期：2026-09-23 ｜ 环境：生产 Cube（`/opt/cube-core/conf/model/cubes/*.yml`）

## 一、这是什么、要你核对什么

对话里问数时，模型要把问题翻译成 Cube 查询。Cube **只能对语义模型里预先定义的「度量（measures）」做合计 / 平均 / 计数**；目前 39 个模型里只有 3 个有度量，其余只能把明细行拉下来自己加 —— 结果是：一轮十几步、上下文被塞进十几万字符、还可能因为数据授权上限被截断而算错。

我们准备给这些模型**补度量**。一个度量就是一句固化下来的口径：`字段 + 汇总方式（求和 / 均值 / 计数）`。补完之后，"某基地某品类库存合计多少"这类问题一次调用就能出结果。

**需要你核对三件事**：① 每个字段该不该合计；② 汇总方式对不对（数量 / 金额用求和，比率 / 天数 / 单价只能用均值）；③ 同一张表里**哪些字段是不同口径、绝不能在同一个合计里相加**。第 6 节是待确认清单，也可以直接在表里改。

## 二、判定规则（我们按这个分类，如有例外请指出）

| 字段类型 | 建议度量 | 举例 | 说明 |
|---|---|---|---|
| 数量、金额、次数 | `sum` | 库存量、计划量、金额、订单量 | 可加，但必须先钉住时间 / 版本等口径维度 |
| 比率、天数、单价、系数 | `avg`（必要时 `max` / `min`） | 周转天数、达成率、单价、增长率、货龄天数 | 求和没有业务含义 |
| 对象个数 | `count_distinct` | SKU 数、客户数、仓库数 | 用编码字段去重计数 |
| 行数 | `count` | 明细行数 | 同时用于判断"是否被截断" |
| 标识、状态、编码 | 不建度量 | id、*_code、status、delete_status | 只能筛选 / 分组 |

## 三、全局注意事项（所有模型通用）

- **行粒度**：这些表大多**没有声明主键**，同一个对象会有多行（不同快照 / 版本 / 月份 / 批次）。求和前必须把这些区分维度**钉成唯一取值**（或按它们分组展示），否则同一个对象会被重复累加。
- **口径互斥**：同一张表里"月初量 / 最终量""现存 / 可用""订单量 / 已分配量"等常常不能相加，下面每个模型的「口径与禁令」会写明。
- **时间字段有两种**：真正的 `time` 类型可以按时间过滤 / 按月分组；像 `plane_date` 这种是**字符串**，只能按实际文本值过滤。
- **跨模型不能混算**：一次查询只能一个模型，跨表要先各自算再在回答里合并。
- **数量与金额不能混**：金额字段与数量字段要分成不同度量。

## 四、按业务域的度量方案

### 库存 / 货龄

#### `agents_scm_branch_inventory_snapshot`
- 用途：分仓库存快照
- 字段：维度 17 个，**当前 0 个度量**
- 口径与禁令：分仓库存快照：先钉快照日与仓库；live_qty（现存）与 available_qty（可用）是两个口径，不可相加。

| 字段 | 建议度量名 | 类型 | 字段含义 | 口径提示 / 待确认 |
|---|---|---|---|---|
| `id` | （不建） | 不建 | 本表记录主键/记录编号，用于定位一条明细；不是客户、 | 状态 / 编码 / 标识：不求和 |
| `live_qty` | `live_qty_sum` | sum | 源分仓库存批次表的现存库存数量 live_qty，在 | 数量 / 金额：可合计，但要先钉口径 |
| `available_qty` | `available_qty_sum` | sum | 源分仓库存批次表的可用库存数量 available_ | 数量 / 金额：可合计，但要先钉口径 |

#### `agents_scm_inventory_age`
- 用途：仓库 SKU 批次货龄日快照
- 字段：维度 23 个，**当前 0 个度量**
- 口径与禁令：库龄明细：qty / qtylive / qtyonhold / qtyallocated / qtylocked / qtyorder 是不同占用口径，不可无条件相加；productage 是货龄天数，只能均值/最大。

| 字段 | 建议度量名 | 类型 | 字段含义 | 口径提示 / 待确认 |
|---|---|---|---|---|
| `id` | （不建） | 不建 | 目标库自增主键。 本表记录主键/记录编号，用于定位一 | 状态 / 编码 / 标识：不求和 |
| `qtylive` | `qtylive_sum` | sum | 可用库存，来源 o_storage.qtylive。 | 数量 / 金额：可合计，但要先钉口径 |
| `qty` | `qty_sum` | sum | 现库存，来源 o_storage.qty。 | 数量 / 金额：可合计，但要先钉口径 |
| `qtyonhold` | `qtyonhold_sum` | sum | 冻结库存，来源 o_storage.qtyonhol | 数量 / 金额：可合计，但要先钉口径 |
| `qtyallocated` | `qtyallocated_sum` | sum | 已分配库存，来源 o_storage.qtyallo | 数量 / 金额：可合计，但要先钉口径 |
| `qtylocked` | `qtylocked_sum` | sum | 锁定库存，来源 o_storage.qtylocke | 数量 / 金额：可合计，但要先钉口径 |
| `qtyorder` | `qtyorder_sum` | sum | 订单库存，来源 o_storage.qtyorder | 数量 / 金额：可合计，但要先钉口径 |
| `productage` | `productage_avg` | avg | 库存货龄，来源 o_storage.producta | 比率 / 天数 / 单价：只能均值（或最大最小） |

#### `agents_scm_cust_inventory_daily`
- 用途：经销商进销存日快照
- 字段：维度 37 个，**当前 0 个度量**
- 口径与禁令：经销商进销存日快照：先钉 stat_date / 客户 / SKU；stock_qty 与 normal_stock_qty 是不同库存口径；*_avg 已是日均，不要累加，也不要与 *_7days 混加。

| 字段 | 建议度量名 | 类型 | 字段含义 | 口径提示 / 待确认 |
|---|---|---|---|---|
| `id` | （不建） | 不建 | 本表记录主键/记录编号，用于定位一条明细；不是客户、 | 状态 / 编码 / 标识：不求和 |
| `measure_unit` | （不建） | 不建 | 源商品计量单位字段；单位编码/名称字典未确认，展示原 | 单位 / 标签类字段：不求和 |
| `stock_qty` | `stock_qty_sum` | sum | 本行库存数量；限定库存日、客户、SKU 及库存来源后 | 数量 / 金额：可合计，但要先钉口径 |
| `in_transit_qty` | `in_transit_qty_sum` | sum | 在途库存/箱，来源 pack_unitqty（已发货 | 数量 / 金额：可合计，但要先钉口径 |
| `normal_stock_qty` | `normal_stock_qty_sum` | sum | 正常库存/箱，来源 normal_stock_qty | 数量 / 金额：可合计，但要先钉口径 |
| `stock_amt` | `stock_amt_sum` | sum | 本行库存金额；与 stock_qty 和价格口径共同 | 数量 / 金额：可合计，但要先钉口径 |
| `sales_qty_7days_avg` | `sales_qty_7days_avg_avg` | avg | 源表提供的近 7 天日均销量；不再除以 7，也不能跨 | 比率 / 天数 / 单价：只能均值（或最大最小） |
| `sales_qty_7days` | `sales_qty_7days_sum` | sum | 源表提供的近 7 天销量；滚动窗口存在重叠，不跨统计 | 数量 / 金额：可合计，但要先钉口径 |
| `sales_qty_30days_avg` | `sales_qty_30days_avg_avg` | avg | 源表提供的近 30 天日均销量；不再除以 30，不直 | 比率 / 天数 / 单价：只能均值（或最大最小） |
| `sales_qty_30days` | `sales_qty_30days_sum` | sum | 源表提供的近 30 天销量；连续统计日窗口重叠，不能 | 数量 / 金额：可合计，但要先钉口径 |
| `sales_amt_30days` | `sales_amt_30days_sum` | sum | 源表提供的近 30 天销售金额；是滚动窗口值，不能按 | 数量 / 金额：可合计，但要先钉口径 |
| `sales_amt_30days_avg` | `sales_amt_30days_avg_avg` | avg | 源表提供的近 30 天日均销售金额；不是 30 天总 | 比率 / 天数 / 单价：只能均值（或最大最小） |
| `cif_price` | `cif_price_avg` | avg | 统一到岸价，来源 cif_price；用于库存价值与 | 比率 / 天数 / 单价：只能均值（或最大最小） |

#### `agents_scm_cust_stock_age_governed`
- 用途：客户库存货龄（治理口径）
- 字段：维度 17 个，**当前 0 个度量**
- 口径与禁令：客户货龄：stock_qty（库存）与 final_qty（期末）口径不同，分开合计。

| 字段 | 建议度量名 | 类型 | 字段含义 | 口径提示 / 待确认 |
|---|---|---|---|---|
| `id` | （不建） | 不建 | 本表记录主键/记录编号，用于定位一条明细；不是客户、 | 状态 / 编码 / 标识：不求和 |
| `stock_qty` | `stock_qty_sum` | sum | 本行库存数量；限定库存日、客户、SKU 及库存来源后 | 数量 / 金额：可合计，但要先钉口径 |
| `final_qty` | `final_qty_sum` | sum | 源货龄表的 final_qty 数量原值；与 sto | 数量 / 金额：可合计，但要先钉口径 |

#### `agents_scm_wl_cust_stock_age_governed`
- 用途：文沥来源客户库存货龄
- 字段：维度 17 个，**当前 0 个度量**
- 口径与禁令：文沥口径客户货龄：stock_qty 与 final_qty 分开合计，跨口径不可加。

| 字段 | 建议度量名 | 类型 | 字段含义 | 口径提示 / 待确认 |
|---|---|---|---|---|
| `id` | （不建） | 不建 | 本表记录主键/记录编号，用于定位一条明细；不是客户、 | 状态 / 编码 / 标识：不求和 |
| `stock_qty` | `stock_qty_sum` | sum | 本行库存数量；限定库存日、客户、SKU 及库存来源后 | 数量 / 金额：可合计，但要先钉口径 |
| `final_qty` | `final_qty_sum` | sum | 源货龄表的 final_qty 数量原值；与 sto | 数量 / 金额：可合计，但要先钉口径 |

#### `v_agents_scm_customer_inventory_age`
- 用途：客户货龄统一视图
- 字段：维度 12 个，**当前 0 个度量**

| 字段 | 建议度量名 | 类型 | 字段含义 | 口径提示 / 待确认 |
|---|---|---|---|---|
| `id` | （不建） | 不建 | 来源表的记录 ID；UNION ALL 两侧可能重复 | 状态 / 编码 / 标识：不求和 |
| `stock_qty` | `stock_qty_sum` | sum | 本行库存数量；限定库存日、客户、SKU 及库存来源后 | 数量 / 金额：可合计，但要先钉口径 |
| `final_qty` | `final_qty_sum` | sum | 源货龄表的 final_qty 数量原值；与 sto | 数量 / 金额：可合计，但要先钉口径 |

#### `agents_scm_branch_operation_fact`
- 用途：分仓经营指标事实（指标名 + 指标值）
- 字段：维度 24 个，**当前 0 个度量**
- 口径与禁令：指标事实表（metric_group + metric_name + metric_value）：必须「先按指标名筛选再汇总」，跨 metric_name 直接求和会串口径。

| 字段 | 建议度量名 | 类型 | 字段含义 | 口径提示 / 待确认 |
|---|---|---|---|---|
| `id` | （不建） | 不建 | 本表记录主键/记录编号，用于定位一条明细；不是客户、 | 状态 / 编码 / 标识：不求和 |
| `metric_value` | `metric_value_sum` | sum | 指标值；与 metric_group、metric_ | 数量 / 金额：可合计，但要先钉口径 |

#### `agents_scm_cust_pickup_point`
- 用途：客户默认发货提货点当前关系，每 cust_code + warehouse_group_id 一行。保留未匹配或关闭提货点；需同时看匹配标记与 active_f
- 字段：维度 25 个，**当前 0 个度量**
- 数值字段：无（该表没有可合计的数值列，**建议不建度量**）
#### `agents_scm_cust_inventory_daily_keys`
- 用途：库存快照业务键视图，按 stat_date + cust_code + material_code 去重，再补客户销售组织编码；组织仅在该客户存在唯一组织组合时
- 字段：维度 6 个，**当前 0 个度量**
- 数值字段：无（该表没有可合计的数值列，**建议不建度量**）
#### `agents_scm_customer_saleable_material`
- 用途：客户可售商品当前关系，以源记录 ID 保留多条来源记录；只同步 status=1/delete_status=1，不额外过滤日期或商品销售状态。用于范围查询，不
- 字段：维度 8 个，**当前 0 个度量**

| 字段 | 建议度量名 | 类型 | 字段含义 | 口径提示 / 待确认 |
|---|---|---|---|---|
| `source_record_id` | （不建） | 不建 | 源表 id，不生成新业务编号。 来源记录的稳定标识， | 状态 / 编码 / 标识：不求和 |

### 订单 / 履约 / 调拨

#### `agents_scm_branch_pending_order`
- 用途：分仓待发 / 备单
- 字段：维度 23 个，**当前 0 个度量**
- 口径与禁令：待发订单：order_qty（订单量）与 allocated_qty（已分配量）是两个口径；缺口建议用「订单量 − 已分配量」的派生度量。

| 字段 | 建议度量名 | 类型 | 字段含义 | 口径提示 / 待确认 |
|---|---|---|---|---|
| `id` | （不建） | 不建 | 本表记录主键/记录编号，用于定位一条明细；不是客户、 | 状态 / 编码 / 标识：不求和 |
| `order_qty` | `order_qty_sum` | sum | 本条备单明细的订单数量；按仓库、执行单、SKU 等业 | 数量 / 金额：可合计，但要先钉口径 |
| `allocated_qty` | `allocated_qty_sum` | sum | 本条备单明细已经分配的数量；与订单数量比较前应确认相 | 数量 / 金额：可合计，但要先钉口径 |

#### `agents_scm_branch_pending_order_gea`
- 用途：分仓待发 / 备单（GEA 口径）
- 字段：维度 17 个，**当前 0 个度量**

| 字段 | 建议度量名 | 类型 | 字段含义 | 口径提示 / 待确认 |
|---|---|---|---|---|
| `id` | （不建） | 不建 | 本表记录主键/记录编号，用于定位一条明细；不是客户、 | 状态 / 编码 / 标识：不求和 |
| `order_qty` | `order_qty_sum` | sum | 本条备单明细的订单数量；按仓库、执行单、SKU 等业 | 数量 / 金额：可合计，但要先钉口径 |
| `allocated_qty` | `allocated_qty_sum` | sum | 本条备单明细已经分配的数量；与订单数量比较前应确认相 | 数量 / 金额：可合计，但要先钉口径 |

#### `agents_scm_order_fulfillment`
- 用途：订单履约与缺货
- 字段：维度 45 个，**当前 0 个度量**
- 口径与禁令：订单履约：need_qty_origin（需求量）、outqty（缺货量）、qtyshipped（已发量）口径不同，逐项合计，不要相加成「总量」。

| 字段 | 建议度量名 | 类型 | 字段含义 | 口径提示 / 待确认 |
|---|---|---|---|---|
| `id` | （不建） | 不建 | 目标库自增主键。 本表记录主键/记录编号，用于定位一 | 状态 / 编码 / 标识：不求和 |
| `order_qty_origin` | `order_qty_origin_sum` | sum | 订单数量。 本表来源的客户/物料订单数量；订单执行快 | 数量 / 金额：可合计，但要先钉口径 |
| `need_qty_origin` | `need_qty_origin_sum` | sum | 需求数量。 来源订单需求数量；与订单数量 order | 数量 / 金额：可合计，但要先钉口径 |
| `pack_unitqty` | `pack_unitqty_sum` | sum | 订单执行源字段 pack_unitqty 原值；在本 | 数量 / 金额：可合计，但要先钉口径 |
| `qtyshipped` | `qtyshipped_sum` | sum | 发货量。 该订单执行明细在选定快照时点的发货量；不是 | 数量 / 金额：可合计，但要先钉口径 |
| `outqty` | `outqty_sum` | sum | 缺货量。 来源订单执行口径缺货数量；不同于未发货量， | 数量 / 金额：可合计，但要先钉口径 |

#### `agents_scm_branch_customer_transfer`
- 用途：分仓-客户调拨发货
- 字段：维度 14 个，**当前 0 个度量**
- 口径与禁令：分仓-客户调拨：branch_ship_qty / factory_ship_qty / total_ship_qty 是三个口径（分仓发 / 工厂发 / 合计），不要同时相加。

| 字段 | 建议度量名 | 类型 | 字段含义 | 口径提示 / 待确认 |
|---|---|---|---|---|
| `id` | （不建） | 不建 | 本表记录主键/记录编号，用于定位一条明细；不是客户、 | 状态 / 编码 / 标识：不求和 |
| `branch_ship_qty` | `branch_ship_qty_sum` | sum | 该发货日、客户及组织维度的分仓发货数量，来源 fc_ | 数量 / 金额：可合计，但要先钉口径 |
| `factory_ship_qty` | `factory_ship_qty_sum` | sum | 该发货日、客户及组织维度的工厂发货数量，来源 act | 数量 / 金额：可合计，但要先钉口径 |
| `total_ship_qty` | `total_ship_qty_sum` | sum | 该发货日、客户及组织维度的总体发货数量，来源 all | 数量 / 金额：可合计，但要先钉口径 |

#### `agents_scm_cust_plan_exe`
- 用途：客户计划执行
- 字段：维度 38 个，**当前 0 个度量**
- 口径与禁令：客户计划执行：plannum 与 allnum 口径互斥；gc_ / fc_ 前缀分别是工厂仓 / 分仓口径，不可相加。

| 字段 | 建议度量名 | 类型 | 字段含义 | 口径提示 / 待确认 |
|---|---|---|---|---|
| `id` | （不建） | 不建 | 本表记录主键/记录编号，用于定位一条明细；不是客户、 | 状态 / 编码 / 标识：不求和 |
| `allnum` | `allnum_sum` | sum | 最终计划量，来源 allnum。 来源最终/合计销售 | 数量 / 金额：可合计，但要先钉口径 |
| `order_qty_origin` | `order_qty_origin_sum` | sum | 下单量。 本表来源的客户/物料订单数量；订单执行快照 | 数量 / 金额：可合计，但要先钉口径 |
| `act_dl_qty` | `act_dl_qty_sum` | sum | 实际发货量。 计划执行快照中的实际发货量；对应统计期 | 数量 / 金额：可合计，但要先钉口径 |
| `gc_order_qty_origin` | `gc_order_qty_origin_sum` | sum | 工厂下单量。 计划执行口径的工厂下单数量；属于工厂分 | 数量 / 金额：可合计，但要先钉口径 |
| `fc_order_qty_origin` | `fc_order_qty_origin_sum` | sum | 分仓下单量。 计划执行口径的分仓下单数量；属于分仓分 | 数量 / 金额：可合计，但要先钉口径 |
| `gc_act_dl_qty` | `gc_act_dl_qty_sum` | sum | 工厂发货量。 计划执行口径的工厂实际发货数量；与总体 | 数量 / 金额：可合计，但要先钉口径 |
| `fc_act_dl_qty` | `fc_act_dl_qty_sum` | sum | 分仓发货量。 计划执行口径的分仓实际发货数量；与总体 | 数量 / 金额：可合计，但要先钉口径 |
| `order_qty_origin_bal` | `order_qty_origin_bal_sum` | sum | 剩余订单量。 源计划执行口径的剩余订单数量；具体扣减 | 数量 / 金额：可合计，但要先钉口径 |
| `plannum` | `plannum_sum` | sum | 月初计划量。 月初销售计划数量；与最终计划 alln | 数量 / 金额：可合计，但要先钉口径 |
| `ycplanamount` | `ycplanamount_sum` | sum | 月初计划金额。 月初计划金额；与最终计划金额 mon | 数量 / 金额：可合计，但要先钉口径 |
| `monthamount` | `monthamount_sum` | sum | 最终计划金额。 最终销售计划金额；与月初计划金额、预 | 数量 / 金额：可合计，但要先钉口径 |

#### `agents_scm_cust_plan_order_analysis_governed`
- 用途：客户计划订单分析（治理口径）
- 字段：维度 38 个，**当前 0 个度量**
- 口径与禁令：订单分析：ship_* / unship_* / total_* 是不同环节口径，逐项合计；budget_rate 是比率。

| 字段 | 建议度量名 | 类型 | 字段含义 | 口径提示 / 待确认 |
|---|---|---|---|---|
| `id` | （不建） | 不建 | 本表记录主键/记录编号，用于定位一条明细；不是客户、 | 状态 / 编码 / 标识：不求和 |
| `simulation_need_amount` | `simulation_need_amount_sum` | sum | 预订单的需求推演金额，来源 simulation_n | 数量 / 金额：可合计，但要先钉口径 |
| `ship_qty` | `ship_qty_sum` | sum | 本计划月份在该预订单快照下的已发货数量；是源表月度执 | 数量 / 金额：可合计，但要先钉口径 |
| `ship_amount` | `ship_amount_sum` | sum | 本计划月份在该预订单快照下的已发货金额；连续快照可能 | 数量 / 金额：可合计，但要先钉口径 |
| `unship_qty` | `unship_qty_sum` | sum | 该预订单快照的未发货数量；与已发货量区分，不直接认定 | 数量 / 金额：可合计，但要先钉口径 |
| `unship_amount` | `unship_amount_sum` | sum | 该预订单快照的未发货金额；不是库存金额或预订单建议金 | 数量 / 金额：可合计，但要先钉口径 |
| `total_qty` | `total_qty_sum` | sum | 源预订单表 all_qty 的合计数量；与 ship | 数量 / 金额：可合计，但要先钉口径 |
| `total_amount` | `total_amount_sum` | sum | 源预订单表 all_amount 的合计金额；与已发 | 数量 / 金额：可合计，但要先钉口径 |
| `budget_rate` | `budget_rate_avg` | avg | 源预订单预算比率，原值来自 budget_rate； | 比率 / 天数 / 单价：只能均值（或最大最小） |
| `planned_qty` | `planned_qty_sum` | sum | 源预订单 allnum 的最终计划数量；不是生产计划 | 数量 / 金额：可合计，但要先钉口径 |
| `planned_qty_rate` | `planned_qty_rate_avg` | avg | 源预订单计划量比率，来源 plannum_rate； | 比率 / 天数 / 单价：只能均值（或最大最小） |
| `daily_sales` | （不建） | 待定 | 预订单计算使用的日销量指标；源回看窗口及单位未确认， | 字段名看不出单位，请顾问确认能否相加 |
| `stock_qty` | `stock_qty_sum` | sum | 本行库存数量；限定库存日、客户、SKU 及库存来源后 | 数量 / 金额：可合计，但要先钉口径 |
| `in_transit_qty` | `in_transit_qty_sum` | sum | 预订单来源模型的在途库存数量；未在此表确认具体发货/ | 数量 / 金额：可合计，但要先钉口径 |
| `turnover_days` | `turnover_days_avg` | avg | 预订单库存周转天数指标；分子分母和异常值处理以源公式 | 比率 / 天数 / 单价：只能均值（或最大最小） |
| `target_inventory` | `target_inventory_sum` | sum | 预订单模型的目标库存数量；与基地安全库存模型的同名字 | 数量 / 金额：可合计，但要先钉口径 |
| `label_turnover_days` | `label_turnover_days_avg` | avg | 预订单按商品标签配置/计算的周转天数；不是当前周转天 | 比率 / 天数 / 单价：只能均值（或最大最小） |
| `avg_stock_age` | `avg_stock_age_avg` | avg | 预订单的平均库存货龄指标；权重及源计量单位未确认，不 | 比率 / 天数 / 单价：只能均值（或最大最小） |
| `pre_order_qty` | `pre_order_qty_sum` | sum | 预订单建议数量，工作台预加购物车使用的默认数量；不代 | 数量 / 金额：可合计，但要先钉口径 |

#### `agents_scm_customer_receive`
- 用途：客户收货地当前关系，一客可多地址，以 source_record_id 标识来源地址记录。查实际收货地使用 receive_* 和 goods_address；
- 字段：维度 24 个，**当前 0 个度量**
- 数值字段：无（该表没有可合计的数值列，**建议不建度量**）
#### `agents_scm_customer_car`
- 用途：客户车辆/车型约束同步明细，来源 view_customer_car_info；按组织、客户、提货点和车辆属性区分，source_record_id 为属性组合
- 字段：维度 12 个，**当前 0 个度量**
- 口径与禁令：车销折扣：min_discount_num / max_discount_num 是折扣上下限，不是可加数量 —— 不建 sum。

| 字段 | 建议度量名 | 类型 | 字段含义 | 口径提示 / 待确认 |
|---|---|---|---|---|
| `min_discount_num` | （不建） | 不建 | 源车辆约束字段 mindiscountnum 的下限 | 上下限（折扣/阈值类）：不是可加量，不建 sum |
| `max_discount_num` | （不建） | 不建 | 源车辆约束字段 maxdiscountnum 的上限 | 上下限（折扣/阈值类）：不是可加量，不建 sum |

#### `agents_scm_customer_car_current`
- 用途：客户车辆最新批次视图，严格选择全表 MAX(sync_batch_time)，再按唯一客户组织组合补组织编码。最新批次缺少某客户时不回退旧批次。用于当前车辆约束
- 字段：维度 14 个，**当前 0 个度量**

| 字段 | 建议度量名 | 类型 | 字段含义 | 口径提示 / 待确认 |
|---|---|---|---|---|
| `min_discount_num` | （不建） | 不建 | 源车辆约束字段 mindiscountnum 的下限 | 上下限（折扣/阈值类）：不是可加量，不建 sum |
| `max_discount_num` | （不建） | 不建 | 源车辆约束字段 maxdiscountnum 的上限 | 上下限（折扣/阈值类）：不是可加量，不建 sum |

### 销售计划 / 预算

#### `agents_sales_plan_detail_mi`
- 用途：DMS 月度销售计划明细
- 字段：维度 31 个，**当前 0 个度量**
- 口径与禁令：月度销售计划明细：未声明主键；plannum（月初量）与 allnum（最终量）口径互斥，不可加进同一合计；tz_add_plan / tz_sub_plan 是调整组成量，建议用「追加 − 追减」的派生净额。

| 字段 | 建议度量名 | 类型 | 字段含义 | 口径提示 / 待确认 |
|---|---|---|---|---|
| `plannum` | `plannum_sum` | sum | 计划量。 月初销售计划数量；与最终计划 allnum | 数量 / 金额：可合计，但要先钉口径 |
| `tz_add_plan` | `tz_add_plan_sum` | sum | 追加量。 月度销售计划追加数量原值；是否已包含于最终 | 数量 / 金额：可合计，但要先钉口径 |
| `tz_sub_plan` | `tz_sub_plan_sum` | sum | 追减量。 月度销售计划追减数量原值；正负号约定未确认 | 数量 / 金额：可合计，但要先钉口径 |
| `tzplannum` | `tzplannum_sum` | sum | 调整量。 月度销售计划调整量原值；与追加、追减的公式 | 数量 / 金额：可合计，但要先钉口径 |
| `allnum` | `allnum_sum` | sum | 合计。 来源最终/合计销售计划数量；是计划值，不是实 | 数量 / 金额：可合计，但要先钉口径 |
| `ycplanamount` | `ycplanamount_sum` | sum | 月初计划金额。 月初计划金额；与最终计划金额 mon | 数量 / 金额：可合计，但要先钉口径 |
| `monthamount` | `monthamount_sum` | sum | 最终计划金额。 最终销售计划金额；与月初计划金额、预 | 数量 / 金额：可合计，但要先钉口径 |

#### `agents_scm_branch_plan`
- 用途：分仓计划（目标 + 增长率）
- 字段：维度 28 个，**当前 0 个度量**
- 口径与禁令：分仓计划：current_inventory_qty / shipment_plan_qty / transfer_plan_qty 是不同计划口径；*_growth_rate 是比率，只能均值。

| 字段 | 建议度量名 | 类型 | 字段含义 | 口径提示 / 待确认 |
|---|---|---|---|---|
| `id` | （不建） | 不建 | 本表记录主键/记录编号，用于定位一条明细；不是客户、 | 状态 / 编码 / 标识：不求和 |
| `current_inventory_qty` | `current_inventory_qty_sum` | sum | 分仓计划计算使用的当前库存数量；为计划计算输入，不代 | 数量 / 金额：可合计，但要先钉口径 |
| `replenishment_cycle_days` | `replenishment_cycle_days_avg` | avg | 补货周期天数，用于库存/补货计算；不是任务生成频率或 | 比率 / 天数 / 单价：只能均值（或最大最小） |
| `bi_target_amount` | `bi_target_amount_sum` | sum | 该分仓目标月份的 BI 预算目标金额；相同分仓/月预 | 数量 / 金额：可合计，但要先钉口径 |
| `reference_shipment_qty` | `reference_shipment_qty_sum` | sum | 计算分仓计划所用的历史参考发货量；当前源实现采用上月 | 数量 / 金额：可合计，但要先钉口径 |
| `history_same_period_growth_rate` | `history_same_period_growth_rate_avg` | avg | 分仓计划使用的历史同期增长率；是比率而非数量，缺失项 | 比率 / 天数 / 单价：只能均值（或最大最小） |
| `recent_three_month_growth_rate` | `recent_three_month_growth_rate_avg` | avg | 分仓计划使用的近三月增长率项；不与其他增长率直接加总 | 比率 / 天数 / 单价：只能均值（或最大最小） |
| `branch_growth_rate` | `branch_growth_rate_avg` | avg | 分仓计划使用的综合增长率项；与 target_gro | 比率 / 天数 / 单价：只能均值（或最大最小） |
| `shipment_plan_qty` | `shipment_plan_qty_sum` | sum | 基于上月实际出库与预算加权增长的计划量；未知为NUL | 数量 / 金额：可合计，但要先钉口径 |
| `transfer_plan_qty` | `transfer_plan_qty_sum` | sum | 分仓调拨计划数量；当前同步实现缺少独立已确认调拨结果 | 数量 / 金额：可合计，但要先钉口径 |
| `expected_month_end_inventory_qty` | `expected_month_end_inventory_qty_sum` | sum | 分仓预估月末库存量；当前同步缺少独立已确认结果时为  | 数量 / 金额：可合计，但要先钉口径 |
| `target_growth_rate` | `target_growth_rate_avg` | avg | 分仓基准月预算环比增长率；按精确上月对齐，不使用跨缺 | 比率 / 天数 / 单价：只能均值（或最大最小） |

#### `agents_scm_branch_production_plan`
- 用途：分仓生产计划
- 字段：维度 10 个，**当前 0 个度量**
- 口径与禁令：分仓生产计划：planned_qty 可按基地/月合计。

| 字段 | 建议度量名 | 类型 | 字段含义 | 口径提示 / 待确认 |
|---|---|---|---|---|
| `id` | （不建） | 不建 | 本表记录主键/记录编号，用于定位一条明细；不是客户、 | 状态 / 编码 / 标识：不求和 |
| `planned_qty` | `planned_qty_sum` | sum | 该完工日、提货点、SKU 的计划生产数量；不是预订单 | 数量 / 金额：可合计，但要先钉口径 |

#### `agent_branch_plan_import`
- 用途：分仓商品月度计划（人工导入）
- 字段：维度 14 个，**当前 0 个度量**
- 口径与禁令：人工导入的分仓月度计划：outbound_qty / transfer_qty 是确认量，suggested_* 是建议量（仅留档），两者不可相加。

| 字段 | 建议度量名 | 类型 | 字段含义 | 口径提示 / 待确认 |
|---|---|---|---|---|
| `outbound_qty` | `outbound_qty_sum` | sum | 确认出货计划量，按分仓月份SKU优先参与补货计算。 | 数量 / 金额：可合计，但要先钉口径 |
| `transfer_qty` | `transfer_qty_sum` | sum | 确认调拨计划量，按分仓月份SKU优先参与补货计算。 | 数量 / 金额：可合计，但要先钉口径 |
| `suggested_outbound_qty` | `suggested_outbound_qty_sum` | sum | 导入模板建议出货计划量；缺失为NULL，仅留档。 | 数量 / 金额：可合计，但要先钉口径 |
| `suggested_transfer_qty` | `suggested_transfer_qty_sum` | sum | 导入模板建议调拨计划量；缺失为NULL，仅留档。 | 数量 / 金额：可合计，但要先钉口径 |

#### `agents_scm_branch_budget_monthly`
- 用途：分仓月度预算
- 字段：维度 15 个，**当前 0 个度量**
- 口径与禁令：分仓月度预算：budget_mny 可加；total_rate / history_rate / avg_3month_rate / growth_factor 是比率或系数，只能均值。

| 字段 | 建议度量名 | 类型 | 字段含义 | 口径提示 / 待确认 |
|---|---|---|---|---|
| `budget_mny` | `budget_mny_sum` | sum | 当前 year_month、shipping_cod | 数量 / 金额：可合计，但要先钉口径 |
| `pre_mny` | `pre_mny_sum` | sum | 同一提货点上一个自然月的预算金额，是环比的分母；不是 | 数量 / 金额：可合计，但要先钉口径 |
| `ly_same_mny` | `ly_same_mny_sum` | sum | 同一提货点去年同月的预算金额，是同比的分母；缺失或零 | 数量 / 金额：可合计，但要先钉口径 |
| `total_rate` | `total_rate_avg` | avg | 本月预算/上月预算-1；上月缺失或为0时NULL。 | 比率 / 天数 / 单价：只能均值（或最大最小） |
| `history_rate` | `history_rate_avg` | avg | 本月预算/去年同月预算-1；同期缺失或为0时NULL | 比率 / 天数 / 单价：只能均值（或最大最小） |
| `avg_3month_rate` | `avg_3month_rate_avg` | avg | 本月及前两自然月环比均值；忽略NULL，全部缺失为N | 比率 / 天数 / 单价：只能均值（或最大最小） |
| `growth_factor` | `growth_factor_avg` | avg | NVL(total_rate,0)*0.4+NVL( | 比率 / 天数 / 单价：只能均值（或最大最小） |
| `recent_rate_count` | `recent_rate_count_avg` | avg | 本月及前两自然月中有效环比增长率的个数，取值 0–3 | 比率 / 天数 / 单价：只能均值（或最大最小） |

### 需求预测

#### `agents_sales_forecast_detail_mi`
- 用途：AI 需求预测明细
- 字段：维度 51 个，**当前 0 个度量**
- 口径与禁令：*_share / *_rate / probability / landed_price 是比率或单价，只能均值；predicted_*_amount / predicted_quantity 可合计，但要先钉预测批次或版本。

| 字段 | 建议度量名 | 类型 | 字段含义 | 口径提示 / 待确认 |
|---|---|---|---|---|
| `id` | （不建） | 不建 | 本表记录主键/记录编号，用于定位一条明细；不是客户、 | 状态 / 编码 / 标识：不求和 |
| `sku_code` | （不建） | 不建 | SKU编码。 需求预测中的商品/SKU 编码；作为业 | 状态 / 编码 / 标识：不求和 |
| `category_budget_share` | `category_budget_share_avg` | avg | 品类预算份额。 品类预算占比，在同品类多个 SKU  | 比率 / 天数 / 单价：只能均值（或最大最小） |
| `category_budget_amount` | `category_budget_amount_sum` | sum | 品类预算金额。 品类预算金额，重复在同月、客户、or | 数量 / 金额：可合计，但要先钉口径 |
| `delivery_probability` | `delivery_probability_avg` | avg | 发货发生概率。 当前客户 SKU 的发货发生概率原值 | 比率 / 天数 / 单价：只能均值（或最大最小） |
| `probability_sample_size` | `probability_sample_size_avg` | avg | 概率样本量。 概率模型使用的样本数量；样本观察窗口由 | 比率 / 天数 / 单价：只能均值（或最大最小） |
| `probability_positive_count` | `probability_positive_count_avg` | avg | 概率正例数。 概率样本中的正例数量；正例定义与观察窗 | 比率 / 天数 / 单价：只能均值（或最大最小） |
| `category_conditional_share` | `category_conditional_share_avg` | avg | 品类内条件份额。 在品类已发生条件下的 SKU 份额 | 比率 / 天数 / 单价：只能均值（或最大最小） |
| `category_sku_share` | `category_sku_share_avg` | avg | 品类内SKU份额。 SKU 在所属品类内的份额；用于 | 比率 / 天数 / 单价：只能均值（或最大最小） |
| `is_business_review_added` | （不建） | 不建 | 是否业务审核新增。 是否为业务审核新增商品标记；现有 | 0/1 标记：不求和；要统计就是条件计数 |
| `is_fallback_used` | （不建） | 不建 | 是否使用回退。 是否使用预测回退策略的源标记；现有模 | 0/1 标记：不求和；要统计就是条件计数 |
| `predicted_share` | `predicted_share_avg` | avg | 预测份额。 当前预测范围内 SKU 预测金额份额；需 | 比率 / 天数 / 单价：只能均值（或最大最小） |
| `predicted_sales_amount` | `predicted_sales_amount_sum` | sum | 预测销额。 模型给出的客户 SKU 权威预测销售金额 | 数量 / 金额：可合计，但要先钉口径 |
| `landed_price_excl_tax` | `landed_price_excl_tax_avg` | avg | 未税到岸价。 SKU 未税到岸单价；换算金额前核对对 | 比率 / 天数 / 单价：只能均值（或最大最小） |
| `predicted_quantity` | `predicted_quantity_sum` | sum | 预测数量。 模型给出的客户 SKU 预测数量；按未税 | 数量 / 金额：可合计，但要先钉口径 |
| `quantity_sales_amount` | `quantity_sales_amount_sum` | sum | 数量对应销额。 预测数量乘未税到岸单价得到的数量对应 | 数量 / 金额：可合计，但要先钉口径 |
| `quantity_amount_diff` | `quantity_amount_diff_sum` | sum | 数量金额差额。 数量对应金额减预测金额的差值，可正可 | 数量 / 金额：可合计，但要先钉口径 |
| `actual_sales_amount` | `actual_sales_amount_sum` | sum | 实际销额。 目标月客户 SKU 实际发货销售金额；目 | 数量 / 金额：可合计，但要先钉口径 |
| `actual_sales_quantity` | `actual_sales_quantity_sum` | sum | 实际发货数量。 目标月客户 SKU 实际发货数量；是 | 数量 / 金额：可合计，但要先钉口径 |
| `is_ai_new_candidate` | （不建） | 不建 | 1=客户当前可售、但预测时点前无该客户历史发货的AI | 0/1 标记：不求和；要统计就是条件计数 |
| `is_split` | （不建） | 不建 | 1=已进入AI拆分并承接目标；0=可售范围内未拆分S | 0/1 标记：不求和；要统计就是条件计数 |

#### `stg_sales_forecast_input`
- 用途：需求预测输入
- 字段：维度 25 个，**当前 0 个度量**
- 口径与禁令：预测输入：shipment_quantity / target_amount 可合计；untaxed_landed_price 是单价，只能均值。

| 字段 | 建议度量名 | 类型 | 字段含义 | 口径提示 / 待确认 |
|---|---|---|---|---|
| `dealer_code` | （不建） | 不建 | 需求预测中的经销商编码；跨表匹配 cust_code | 状态 / 编码 / 标识：不求和 |
| `sku_code` | （不建） | 不建 | 需求预测中的商品/SKU 编码；作为业务标识使用，不 | 状态 / 编码 / 标识：不求和 |
| `shipment_quantity` | `shipment_quantity_sum` | sum | SHIPMENT 类型输入记录中的历史发货数量；只统 | 数量 / 金额：可合计，但要先钉口径 |
| `untaxed_landed_price` | `untaxed_landed_price_avg` | avg | PRICE 类型输入记录的未税到岸单价；与数量单位匹 | 比率 / 天数 / 单价：只能均值（或最大最小） |
| `target_amount` | `target_amount_sum` | sum | TARGET 类型输入记录的目标金额；按客户和计划月 | 数量 / 金额：可合计，但要先钉口径 |

#### `agents_sales_forecast_customer_master`
- 用途：客户分类和客户组当前快照，每客户 cust_code 一行。用于审批业务类型识别，不包含发货或库存。NULL 保留源缺失，不根据客户名称猜测分类；不是历史归属快
- 字段：维度 6 个，**当前 0 个度量**
- 数值字段：无（该表没有可合计的数值列，**建议不建度量**）
### 促销 / 配置 / 主数据

#### `agents_scm_promotion_policy`
- 用途：促销政策
- 字段：维度 37 个，**当前 0 个度量**
- 口径与禁令：促销政策：promotion_limit、usable_quantity、used_quantity 可合计；status / delete_status 是状态码，不能求和。

| 字段 | 建议度量名 | 类型 | 字段含义 | 口径提示 / 待确认 |
|---|---|---|---|---|
| `id` | （不建） | 不建 | 本表记录主键/记录编号，用于定位一条明细；不是客户、 | 状态 / 编码 / 标识：不求和 |
| `source_id` | （不建） | 不建 | 源记录 ID。来源政策头表记录标识。 | 状态 / 编码 / 标识：不求和 |
| `promotion_limit` | `promotion_limit_sum` | sum | 政策赠品限量。政策主表赠品限量 decimal(32 | 数量 / 金额：可合计，但要先钉口径 |
| `status` | （不建） | 不建 | 政策状态原值。同步保留 status=1；是否在有效 | 状态 / 编码 / 标识：不求和 |
| `delete_status` | （不建） | 不建 | 删除状态原值。按上游同步约定保留 delete_st | 状态 / 编码 / 标识：不求和 |
| `usable_quantity` | `usable_quantity_sum` | sum | 赠品限量（usable_quantity）。文档定义 | 数量 / 金额：可合计，但要先钉口径 |
| `used_quantity` | `used_quantity_sum` | sum | 当前已使用赠品数量。当前已使用赠品数量；不同政策的赠 | 数量 / 金额：可合计，但要先钉口径 |
| `promotion_business_type` | （不建） | 不建 | 政策业务类型原始编码。政策业务类型：0=默认，1=大 | 状态 / 编码 / 标识：不求和 |

#### `agents_scm_promotion_policy_scope`
- 用途：促销政策适用范围明细，每 range_record_id 一条范围。先区分 data_type，再按对象编码、scope_level、提货点和产品判断；org/
- 字段：维度 26 个，**当前 0 个度量**

| 字段 | 建议度量名 | 类型 | 字段含义 | 口径提示 / 待确认 |
|---|---|---|---|---|
| `id` | （不建） | 不建 | 本表记录主键/记录编号，用于定位一条明细；不是客户、 | 状态 / 编码 / 标识：不求和 |
| `promotion_limit` | `promotion_limit_sum` | sum | 范围赠品限量。范围行携带的赠品限量 decimal( | 数量 / 金额：可合计，但要先钉口径 |
| `status` | （不建） | 不建 | 政策状态原值。同步保留 status=1；是否在有效 | 状态 / 编码 / 标识：不求和 |
| `delete_status` | （不建） | 不建 | 删除状态原值。按上游同步约定保留 delete_st | 状态 / 编码 / 标识：不求和 |

#### `agents_scm_promotion_policy_scope_view`
- 用途：政策范围与政策主表按 promotion_code 关联的当前视图，一条范围一行。政策属性来自主表，范围对象来自范围表。视图筛选双方 status/delete
- 字段：维度 52 个，**当前 0 个度量**

| 字段 | 建议度量名 | 类型 | 字段含义 | 口径提示 / 待确认 |
|---|---|---|---|---|
| `scope_id` | （不建） | 不建 | 适用范围明细主键。 政策适用范围本地明细 ID，来源 | 状态 / 编码 / 标识：不求和 |
| `promotion_policy_id` | （不建） | 不建 | 促销政策主表主键。 本地政策主表 ID，来源 p.i | 状态 / 编码 / 标识：不求和 |
| `promotion_source_id` | （不建） | 不建 | 视图中政策主表 source_id，上游政策来源记录 | 状态 / 编码 / 标识：不求和 |
| `promotion_business_type` | （不建） | 不建 | 政策业务类型原始编码。政策业务类型：0=默认，1=大 | 状态 / 编码 / 标识：不求和 |
| `promotion_limit` | `promotion_limit_sum` | sum | 政策赠品限量。政策主表赠品限量 decimal(32 | 数量 / 金额：可合计，但要先钉口径 |
| `usable_quantity` | `usable_quantity_sum` | sum | 赠品限量（usable_quantity）。文档定义 | 数量 / 金额：可合计，但要先钉口径 |
| `used_quantity` | `used_quantity_sum` | sum | 当前已使用赠品数量。当前已使用赠品数量；不同政策的赠 | 数量 / 金额：可合计，但要先钉口径 |
| `policy_status` | （不建） | 不建 | 政策主表状态，视图仅保留 1；不是适用范围行状态。 | 状态 / 编码 / 标识：不求和 |
| `policy_delete_status` | （不建） | 不建 | 政策主表删除/有效标记，视图仅保留 1，不将其反解为 | 状态 / 编码 / 标识：不求和 |
| `scope_status` | （不建） | 不建 | 适用范围明细状态，视图仅保留 1；与主表状态分别保存 | 状态 / 编码 / 标识：不求和 |
| `scope_delete_status` | （不建） | 不建 | 适用范围明细删除/有效标记，视图仅保留 1。 | 状态 / 编码 / 标识：不求和 |

#### `agent_branch_cycle_config`
- 用途：分仓补货周期配置。每个 warehouse_id 一条规则集合；用于解释分仓补货周期，rules 是 JSON 文本。不要当销售提报窗口，也不能将多条 JSON
- 字段：维度 4 个，**当前 0 个度量**
- 数值字段：无（该表没有可合计的数值列，**建议不建度量**）
#### `agents_scm_plan_workflow_config`
- 用途：DMS 计划审批节点配置的全量镜像，每源 id 一行。当前有效节点需显式筛选 status=1、delete_status=1 和 type_code；exam
- 字段：维度 19 个，**当前 0 个度量**

| 字段 | 建议度量名 | 类型 | 字段含义 | 口径提示 / 待确认 |
|---|---|---|---|---|
| `id` | （不建） | 不建 | 源表 id，保持原值，不在业务库重新生成。 本表记录 | 状态 / 编码 / 标识：不求和 |
| `status` | （不建） | 不建 | 工作流源记录状态；当前流程读取只接受 status= | 状态 / 编码 / 标识：不求和 |
| `delete_status` | （不建） | 不建 | 源删除/有效标记；本 DMS 同步约定 delete | 状态 / 编码 / 标识：不求和 |

#### `agents_dim_cust_detail_df`
- 用途：客户销售组织维度映射。用于客户到销售组、省区、大区的归属查询；未声明客户编码唯一。关联业务事实前检查同一客户是否只有一个组织组合，避免多行放大数量。 先读取表与
- 字段：维度 8 个，**当前 0 个度量**
- 数值字段：无（该表没有可合计的数值列，**建议不建度量**）
### 参照：已有度量的模型

#### `agents_sales_shipment`（已有度量，作参照）
- 用途：按发货日期、经销商和 SKU 唯一记录实际发货数量及销售组织、商品维度。该表只提供发货数量，不提供发货金额；需要金额时必须使用已发布且口径明确的价格或金额事实，
- 已有度量 5 个：row_count、dealer_count、sku_count、shipment_day_count、shipment_quantity
- 口径与禁令：已有度量（参照写法）：row_count / dealer_count / sku_count / shipment_day_count / shipment_quantity。
- 数值字段：无（该表没有可合计的数值列，**建议不建度量**）
#### `agents_sales_target`（已有度量，作参照）
- 用途：按月份和经销商唯一记录销售目标金额及销售组织归属。目标金额在本 Cube 内每个经销商每月只有一行，可直接按月份、组织或经销商汇总。
- 已有度量 3 个：row_count、dealer_count、target_amount
- 口径与禁令：已有度量（参照写法）：row_count / dealer_count / target_amount 等。
- 数值字段：无（该表没有可合计的数值列，**建议不建度量**）

## 五、问答场景覆盖（补完度量后这些都能一次问出来）

| 业务问题（举例） | 需要哪个模型的哪个度量 |
|---|---|
| 某基地某品类的库存合计 / 有多少 SKU | agents_scm_safety_stock：current_inventory_sum、sku_count（已上线） |
| 低于安全库存的 SKU 有几个 / 库存缺口多少 | agents_scm_safety_stock：low_stock_sku_count、inventory_gap_sum（已上线） |
| 某分仓 / 某仓库的现存与可用库存合计 | agents_scm_branch_inventory_snapshot：live_qty_sum、available_qty_sum |
| 货龄分布：平均货龄、最长货龄、各口径库存 | agents_scm_inventory_age 及 *_stock_age：qty_sum、productage_avg、productage_max |
| 各经营指标的当月值（按指标名） | agents_scm_branch_operation_fact：metric_value_sum（先按 metric_name 筛选） |
| 经销商库存合计 / 在途 / 近 30 天销量 | agents_scm_cust_inventory_daily：stock_qty_sum、in_transit_qty_sum、sales_qty_30days_sum |
| 待发订单量 / 已分配量 / 未分配缺口 | agents_scm_branch_pending_order：order_qty_sum、allocated_qty_sum、缺口派生 |
| 缺货订单量、缺货 SKU 数 | agents_scm_order_fulfillment：outqty_sum、need_qty_origin_sum、sku_count |
| 分仓 / 工厂到客户的发货量 | agents_scm_branch_customer_transfer：branch_ship_qty_sum、factory_ship_qty_sum |
| 本月计划量合计 / 追加追减净额 / 计划金额 | agents_sales_plan_detail_mi：plannum_sum、allnum_sum、adjust_net_sum、monthamount_sum |
| 分仓补货计划量 / 目标金额 | agents_scm_branch_plan：shipment_plan_qty_sum、bi_target_amount_sum |
| 分仓生产计划量 | agents_scm_branch_production_plan：planned_qty_sum |
| 预算金额与历史同比 | agents_scm_branch_budget_monthly：budget_mny_sum、avg_3month_rate_avg |
| 预测数量 / 金额合计、预测达成情况 | agents_sales_forecast_detail_mi：predicted_quantity_sum、predicted_sales_amount_sum |
| 实际发货量、发货 SKU 数、发货天数 | agents_sales_shipment：shipment_quantity、sku_count、shipment_day_count（已有） |
| 客户目标金额合计 | agents_sales_target：target_amount（已有） |
| 促销额度与已用 / 可用数量 | agents_scm_promotion_policy：promotion_limit_sum、used_quantity_sum、usable_quantity_sum |

## 六、待业务确认清单

1. **可加性**：第 4 节里标「待定」的字段，请确认单位与口径（能不能相加）。
2. **口径互斥**：每个模型「口径与禁令」里列的组合（现存 / 可用、月初量 / 最终量、订单量 / 已分配量……）是否认可"分开合计"。
3. **比率类**：周转天数、达成率、折扣上下限、单价、增长率统一用 `avg`，个别需要 `max` / `min` 的请标注。
4. **主键 / 行粒度**：`agents_sales_plan_detail_mi` 等表没有声明主键，请确认"按哪些维度组合才是唯一一条记录"。
5. **时间字段**：`plane_date` 是字符串，请确认实际取值格式（`YYYYMM` 还是 `YYYY-MM-DD`）。
6. **优先顺序**：如果一次不能全做，请标出最常用的 5–10 个模型，我们优先上线。

## 七、附：已完成的试点（供参考改造前后差别）

`agents_scm_safety_stock` 已按本方案补了 17 个度量 + 1 个「最新快照」分段，真机对照：

- 库存合计：改造前 **100 行 / 123,534 字符**（且可能是被截断的子集）→ 改造后 **1 行 / 1,520 字符**
- "低于安全库存的 SKU 数"：改造前**答不出** → 改造后 **1 行（61 / 253）**
- 按基地分组：改造前要拉明细本地加 → 改造后 **5 行**
