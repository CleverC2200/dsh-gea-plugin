# Cube 增量候选与验收边界

这是本地待审候选，**未部署、未重启 Cube、未修改 GEA 授权资源**。

- `agents_sales_forecast_detail_mi.yml`：以 2026-09-26 只读取得的当前 Cube 文件为基线，保留 51 个维度、`row_count` 和两个 segment，增加材料中的 9 项指标。M预测限定拆分行；M实际含全部M行；原表Z只是纠偏子集。
- `agents_sales_forecast_effective_revision.yml`：采用附件的 Z 优先、无 Z 回退 M 的 SQL。保留未被纠偏的 M 行。补正描述，避免把 M 实际误限为拆分行。同版本业务键重复、历史单位、回填和完整快照仍需真实核验，SQL不会自动消重。
- `fixtures.json`、`Q01.cube-query.json`：来自业务材料的合成样本与查询示例，不是真实业务数据。
- `validate_candidate.py`：基于材料中的离线校验器适配本增量候选；执行确切 measure SQL 与 effective SQL，验证 M实际未拆分行、Z覆盖、月份、金额、数量及份额。它使用 SQLite 兼容夹具，不能替代目标 Cube 编译和真实 GEA 查询。
- `preservation-report.json`：对当前来源快照的名称、SQL、类型、主键、public 属性做保留检查。描述有针对性修正，未称全文无改动。

复跑：`uv run --no-project --python /usr/bin/python3 --with pyyaml python validate_candidate.py`（在本目录）。

进入线上前，仍需要：
1. 目标 Cube 编译与真实单位/历史回填对账；同一月份×版本×客户×SKU的唯一性检查。
2. 确认正式缺货口径，不能把零库存行数或安全库存不足当实际订单缺口。
3. 按实际 consumer 登记受控模型及资源；复测行/字段授权、M/Z筛选和全链/产销可见范围。
4. 在批准的发布窗口部署和读回；然后同身份、同模型重跑业务验收。

源码、离线计算、Cube服务、GEA授权及安装客户端属于不同验收层，不能互相代替。
