# Cube 预设筛选试点（2026-09-24）

## 结论与状态

已从当前服务器 `GET /playground/files` 读取运行中的 YAML，并在三张对外可见模型中**上线 7 个 `segments`**。原文件先按 SHA-256 核对并备份，写入后 Cube 已重启且健康；`/meta` 和 7 条真实 `/load` 查询均通过。没有改动或发布插件、客户端版本。

这批分段用于给查询明确命名，**不会自动套用**。查询方仍须写 `query.segments`，并同时确定月份、快照等业务范围。完整业务答复的准确率暂不能用本批分段推断。

## 实际读取与试点范围

服务器：`100.100.1.228:4000`；模型路径：`/opt/cube-core/conf/model/cubes/`。改前 `/meta` 返回 45 个模型、0 个可见分段；改后为 45 个模型、7 个可见分段。`/playground/files` 返回 45 份 cube YAML 和 1 份示例 view。三个目标文件改前均无 `segments`，均为 `public: true`、`data_source: gea_agent`。

| 模型 | 新分段 | 固定条件 | 已见混用风险 |
| --- | --- | --- | --- |
| `agents_scm_safety_stock` | `month_start_version`、`rolling_version`、`correction_version` | `inventory_version` 分别为“月初”“滚动”“纠偏” | 三版本分别 119,821、139,021、79,579 行；不筛版本共 338,421 行 |
| `agents_scm_branch_plan` | `month_start_version`、`rolling_version` | `plan_version` 分别为 `MONTH_START`、`ROLLING` | 两版本各 9,327 行；不筛版本共 18,654 行 |
| `agents_sales_forecast_detail_mi` | `month_start_m`、`correction_z` | `order_type` 分别为 `M`、`Z` | 实际查询见到 M、Z 两种值；未对全量行数作推断 |

未纳入：`stg_sales_forecast_input` 当前 `public: false`，并非优先业务查询入口；其 `record_type` 应按具体问题显式选择。审批节点与促销政策的当前分组查询只见 `status=1`、`delete_status=1`，本次不重复增加状态分段。

## 改动方式与验证

- 生成脚本：[cube-segment-presets.py](../../scripts/cube-segment-presets.py)；精确改动见[补丁](cube-segment-presets-20260924.patch)。脚本输入是服务器的 `/playground/files` JSON；输出为原件、候选 YAML 和包含原件/候选 SHA-256 的 `manifest.json`。默认只生成，不连接服务器。
- 只在每个模型的 `dimensions` 前增加 `segments` 块。每段含名称、SQL、`public: true` 与适用边界说明。没有改已有度量、维度、底表、公开性或授权。
- 本地检查：三个候选均可被 PyYAML 解析；去掉新增 `segments` 后与原模型逐字段相同；生成脚本通过 Python 语法检查。
- 写入前从服务器重新读取原文件，三份当前 SHA 与候选清单完全一致。原件和候选分别保存在 `/opt/cube-core/backups/cube-segments-20260924-1790236283248/original/` 与 `candidate/`，两个目录均在 Cube 模型扫描路径之外。上传命令虽返回非零，逐份核对远端候选 SHA 后确认文件完整。
- 第一次重启使用了旧文档中的 Compose 服务名 `cube-core`，实际服务名为 `cube`；失败处理恢复原件，三份 SHA 与改前一致，`/meta` 仍是旧版本。核对 `docker compose config --services` 后，使用 `cube` 重试并成功。容器 `cube-core` 使用镜像 `local/cube-core:1.7.2`，状态 `healthy`，`/readyz` 返回 200。
- 改后 `/meta` 有 45 个模型和目标 7 个分段；三张模型原有度量、维度及其余元信息与改前逐字段一致。安全库存三个分段的 `row_count` 分别为 119,821、139,021、79,579，分仓计划两个分段分别为 9,327、9,327，均与改前按版本分组的结果相同。预测明细的 M/Z 分段分别只返回 `M`、`Z`。七条 `/load` 均返回数据且无 `error`。
- 尚未在真实 GEA 登录会话中验证网关 `inspect`、实际 Agent 是否选择分段、最终业务答案。这些不能由 Cube `/meta` 或直连 `/load` 代替。

## 未解决的口径

1. 安全库存分段只分版本，不定义“最新完整快照”。按全表最大时间取快照可能混入不完整批次；仍须确定 `target_month` 与 `inventory_snapshot_time`。
2. 分仓计划分段只分版本，不处理 `MANUAL` 对 `BI` 的业务范围覆盖规则，也不合并不同计划快照。
3. 预测明细只分 M/Z，不自动确定 `plan_month`。三张模型当前都只有 `row_count` 度量；分段不补库存量或金额合计。
4. 插件目录能列出分段名，发送前预检能校验成员类别，但不会自动向查询注入分段。要评估问答准确率，还需用真实问题比较分段选择、月份/快照条件和最终答案。

## 回滚与待办

回滚点：`/opt/cube-core/backups/cube-segments-20260924-1790236283248/original/` 中的三份原件。需要回滚时只恢复这三份文件到 `/opt/cube-core/conf/model/cubes/`，然后在 `/opt/cube-core` 执行 `docker compose restart cube`，再复核 `/meta` 和 `/load`。本次没有删除历史备份。

待办：在真实 GEA 登录身份下核对 `inspect` 是否出现这 7 个分段，并用月初、滚动、纠偏及 M/Z 问题测试 Agent 是否选对分段、月份和快照。当前没有这些会话级证据，不能声称问答准确率已提升某个百分比。
