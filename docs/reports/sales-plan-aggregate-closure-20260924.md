# 销售计划取数与需求预测度量：2026-09-24 实施及验收

## 结论

销售计划宿主聚合、读取收敛、目录观察更新和业务技能隔离已实现；真实模型已输出基地状态与品类金额占比表。目标、发货、预测输入三张 Cube 的度量已补齐并与原库 SQL 对账一致。

尚未全量闭环：四张表的去重/粒度规则、GEA 的 Z 筛选，以及 GEA 网关资源映射/授权仍有阻断。没有把这些情况包装成测试通过或“没数据”。没有发布插件/客户端版本。

## 本地实现

- `src/host/sales-plan-aggregate.ts`：新增 `kind=aggregate`，必须给 periods 返回的 periodId；宿主读取完整计划分页、按当前 versionId 读取 SKU，按 `orderType × planTypeCode × baseName × productCategName` 精确求和。M/Z 与不同业务类型分别返回，不产生跨类型总计。
- 金额与数量使用 Decimal，缺失值不补零；缺少基地/品类保留 null，零分母占比为 null。输出区分 SKU 明细条数与按 skuCode 去重的商品种数；只有 totals/bases/groups 与口径说明，不输出 SKU 或客户明细。
- 限制 500 张计划、100,000 条 SKU、300 个分组、最多 4 路并发和 1,000 个内部请求，最终仍受模型输入字节预算约束。超限要求缩小范围，不交付截断合计。
- 聚合前后复核计划总数、版本、状态、更新时间、SKU 数量；分页重复、缺页、错身份、筛选未执行、取消或换身份均失败。上游没有事务快照，不能声称跨请求原子快照。
- 同一会话每轮最多 20 次明细读取、8 次聚合；重复读取累计上限回到 8。聚合同范围缓存规范化参数顺序，重复读取保留完整汇总，不把它截成只有口径说明的开头。新一轮只清理该会话的计数与回执。
- 目录缓存和重复重放均附加最新样本观察；观察按会话/轮次隔离、换身份清空。少量空值只说明“样本为空”，不宣称整表无数据；后续非空多值能清除旧观察。
- 目录不再凭 `_sum` 后缀断定有没有合计，兼容 `total_*` 和其它合法命名。
- `gea-readonly` 使用 DSH 已有的 `includeDefaultRoots=false`：只扫描显式业务目录 `$DSH_HOME/business-skills` 和已装页面套件的 `skills/`。不扫描用户的通用开发技能。页面包自身的演示边界保留，与独立业务工具取数的边界分开解释。
- 安装额外业务技能时，将完整技能包及参考资料放在显式业务目录中；原来放在项目 `.agents/skills` 的技能不再自动进入该预设。库存、订单等页面预设没有更改。

## 真实销售计划验收

只读 GEA、未执行提交/保存/审批操作。

| 范围 | 结果 |
|---|---|
| periodId=20261001，经销 M | 28 张计划、1,143 条 SKU 明细、331 种商品、33 个基地×品类分组 |
| 金额 / 数量 | 21,453,004.90 / 283,546（单位沿用源口径） |
| 模型输入 | 最终汇总包 11,521 字节；宿主读取约 2.7 秒 |
| periodId=20261002，直营 M | 2 张计划、10 条 SKU，金额 203,666.42；单独呈现 |
| 模型验收会话 | `session-6cb253f4-a01d-4538-86ad-3f61a09face8`，9 步完成 |
| 模型行为 | skill → periods → aggregate；输出基地状态表和品类金额占比；没有逐单读取 versionSkus |
| 业务技能目录 | 10 个页面业务技能及 genui；没有 tdd/code-review/archify 等开发技能 |

模型实际交付了经销 M 的 18 条审批中、9 条退回、1 条待回写状态分布，并将直营 M 单列。Z 查询失败的缺口保留，没有将已取得的 M 汇总一并作废。

之前失败会话的 637,967 个累计工具返回字符与 121 次调用是事实；这不足以证明某次请求超出模型上下文窗口。原网关只返回 `STREAM_TRANSPORT_ERROR`，直接根因未证实。

配置中的旧模型 ID `2085162185715609601` 已不在本次发现的可用列表中；真实成功验收使用当时可用的 `2102773062849409026`。随后刷新了开发实例的模型清单，保留 high 推理档位，默认改用网关实际可用的 2075867101766672385；该模型后续 5 步完成了经销月初汇总。没有修改原始部署配置文件。

## Cube 实施

备份：`/opt/cube-core/backups/2026-09-24-forecast-closure/generated/forecast-closure-20260924-8zny2_ha/`。
生成脚本：`scripts/cube-forecast-measures.py`，默认只生成；写入前比对审计时 SHA，防止覆盖后来修改的配置。应用前备份，写文件失败回滚本次已写文件。Cube 已重启并健康。

| 模型 | 当前度量数 | 本次动作 |
|---|---:|---|
| agents_sales_forecast_detail_mi | 17 | 保留上一轮结果，未恢复有重复累加风险的预算度量 |
| agents_sales_target | 4 | 新增 target_amount_sum、dealer_count；保留 total_target_amount |
| agents_sales_shipment | 5 | 新增 shipment_quantity_sum、dealer_count、sku_count；保留 total_shipment_quantity |
| stg_sales_forecast_input | 4 | 底表已存在；新建 Cube，row_count 加三个类型受限度量 |
| agents_sales_forecast_customer_master | 1 | 不为无可加业务量的主数据表硬加 sum |
| agents_sales_plan_detail_mi | 1 | 暂不补 sum，见下方粒度阻断 |
| agents_scm_cust_plan_exe | 1 | 暂不补 sum，见下方粒度阻断 |
| agents_scm_demand_accuracy | 1 | 暂不补 sum 或简单平均准确率 |
| agents_scm_sales_accuracy | 1 | 暂不补 sum 或简单平均准确率 |

预测输入的三个度量把 SHIPMENT / TARGET / PRICE 条件固化在 measure filters 中；不是仅靠提示词要求模型带类型。价格是行均价，不冒充加权价格。使用 [Cube 官方 measure filters 契约](https://docs.cube.dev/reference/data-modeling/measures#filters)。

### 原库 SQL 与 Cube 对账

| 度量 / 范围 | 两侧结果 |
|---|---:|
| 202609 目标金额 | 626,315,919.52 |
| 202609 目标经销商数 | 8,102 |
| 202609 发货数量 | 18,092,529.811000 |
| 202609 发货经销商 / SKU 数 | 2,423 / 1,081 |
| 输入表 SHIPMENT / TARGET 同月合计 | 分别与上面发货、目标数一致 |
| 输入表 PRICE 行均价 | 127.3415704658658072 |

8 个度量的真实查询逐项一致；并非只验证 YAML 或 meta。

### 业务网关边界

通过真实 `sales_forecast` 会话读取 inspect，已看到 17 / 5 / 4 / 4 个度量，故不需要以“缓存可能没刷新”为由重启 data-query-mcp。

但查询仍被 GEA 拒绝：

- 目标表、发货表：`AI_GATEWAY_DATA_PERMISSION_DENIED`，成员未唯一匹配数据目录资源。新名与旧 `total_*` 均失败，且测试请求每次只涉及一个模型。不能再直接判成用户跨模型写错，需要 GEA 核对资源映射。
- 预测输入表：`RESOURCE_ALLOW_MISSING`，资源 `stg_sales_forecast_input`，位置 `dataScopePolicy.grants`，建议动作 `CONFIGURE_RESOURCE_ALLOW`。需要按业务授权范围配置，没有绕过或放宽权限。
- 目标旧名核验 requestId：`d910da1f-cd6f-4112-9811-39b02d5fabba`；发货旧名：`61f835a8-e014-4449-b0ae-d8f0fcac4eab`；预测输入：`0446f85f-bc2e-48d6-b3ae-0987a30170fc`。

## 尚需上游信息的阻断

### 1. 四张表的业务粒度

只读原库审计，不把 DDL 主键自动当业务唯一键。

| 表 | 已检验的文档业务键 | 重复组 | 其中数值不同 |
|---|---|---:|---:|
| 需求准确率 | month, belong_name, material_code | 835 | 635 |
| 销售准确率 | stat_month, region_code, province_region_code, material_code | 5,929 | 5,695 |
| 销售计划明细 | plane_date, cust_code, material_code, vsbed, order_status | 5,487 | 5,487 |
| 计划执行 | snapshot_date, stat_date, stat_month, cust_code, material_code, warehouse_group_type | 730 | 0（本次核对的数量金额字段） |

前三张必须提供权威业务唯一键，或批次/版本生效规则，才能确定取哪行；第四张不能只因部分数值相同就删行，还需确定是否遗漏业务键。准确率不能先取行均值再当总体准确率，也没有擅自猜 WAPE 分母。

目标表按计划月×客户、发货表按日期×客户×SKU、输入表按 record_type×日期×客户×SKU 检验均无重复；输入表 TARGET 按计划月×客户也唯一。只对这三张落地了新合计。

### 2. Z 纠偏筛选

真实上游在 `orderType=Z` 请求中返回 M。插件现在报 `GEA_AGGREGATE_FILTER_UNSUPPORTED`，不会静默求和或说“Z 没数据”。需要 GEA 修复筛选或提供权威纠偏读取入口。

### 3. 网关目录及授权

见上节，Cube 正确与当前 Agent 可以查询是独立验收项。此项由 GEA 的资源映射与授权配置完成。

## 测试和交付状态

- 类型检查、Host 定向构建通过。
- 最终 80 项定向测试与原生 model-tool-model 集成测试全部通过，见本地 `final-validation.log`。包含业务技能可见、开发技能不可见、跨会话守卫隔离、完整聚合重放、筛选被忽略、分页不完整、取消和精确求和。
- 全量首次跑 519 项：505 过、14 失败。与上一任务保存的失败名单逐条比较，13 项完全相同，新增 1 项是旧“全局清零”源码断言；已改成按会话清零并通过定向重跑。没有声称全量全绿，也没有扩修无关的旧 UI/审批测试。
- 源码继续在 `codex/preview-web-20260923` 当前开发工作树，原有未提交工作已备份；未清理其它改动、未提交/推送、未打包/发版。
- 本地证据：`.runtime/task-20260924-aggregate/` 下的聚合、模型、原库粒度、Cube 对账、网关验证及测试记录。该目录不含写入业务数据的脚本或动作。
