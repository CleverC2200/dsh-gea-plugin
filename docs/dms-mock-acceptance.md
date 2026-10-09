# DMS 模拟回写验收（Issue #23）

本页保留原DMS mock规则与历史，当前统一接收入口见下文。依据用户提供的《销售计划_审批状态码统一口径_V1.2》§6：只回写状态 5；成功后同步设置状态 10、SYNCED、finished_at；失败保持 5；Z 单拆分追加/追减；PLANE_NUM 使用源 plan_id。用户明确要求 DMS 只做模拟效果，其他业务继续使用真实 GEA。

## 当前实现与复现

2026-10-08的47接收沿固定36候选源码ZIP恢复，不把原dirty来源改写为提交。Workbench `prototypes/dms` 拥有原PC视图与内存模拟器，Manage `src/inventory-compute/dms-mock-packets.ts` 维护数量和分笔纯计算，`business-resources/inventory-dms` 是唯一解释资源。GEA的旧独立demo、模型、构建入口已退出；纠偏fixture导入Workbench公共 `./dms-mock`。

在当前隔离Workbench执行 `node scripts/build-dms-prototype.mjs`，由当前统一页面装配加载 `lib/prototypes/dms`，通过原型演示菜单打开 `inventory-dms`。页面仅使用合成样本，上下文标记 `DMS_MOCK`、`simulated=true`、`realWriteback=false`，MCP能力为空。刷新或重置清空模拟事实；按官方Session范围只恢复计划/单据/场景选择。实际装载、引用与PC视觉由47同组owner验收，离线检查不代Native。

计划类型支持Y/XN/DC/FC/JD/TM，单据类型M/Z。点击原“模拟品类终审”按钮后进入5，再选择回写场景。

| 场景 | 预期状态与证据 |
| --- | --- |
| 成功 | 5 → 10；SYNCED 和完成时间同时出现；记录 DMS_SYNC |
| 明确失败 | 保持 5、FAILED、无完成时间；记录失败；选成功后按原键重试 |
| 接收前超时 | 保持 5、UNKNOWN；禁用重投；对账确认缺报文后才允许原键重试 |
| 已接收但回执丢失 | 保持 5、UNKNOWN；对账回读已有回执直接完成，投递次数不增加 |
| Z 单仅追加已接收 | 对账后仍为 5，只有一笔回执；原键重试补追减，实际入库总数为 2 |
| 重复回执 | 状态仍为 10；完成时间不变；不重复记录 DMS_SYNC 或实际入库 |
| 错误来源/旧版本/冲突回执 | 批次校验失败，不部分更新回执，不改变终态 |

## 报文与来源规则

M 单生成一笔 MONTHLY 模拟报文。Z 单生成 ADD、CUT 两笔独立报文，追加和追减数量均为非负十进制数，按三位小数保存；不把两笔相抵为净变化。模拟中即使某一笔为零也保留两笔以验证完整回执门槛；真实零值报文策略未确认。

每笔键由源计划、版本、M/Z 和分笔类型构成，重试保持原键。模拟接收方为每个键只生成一个 DMS 自有 ID，并独立记录源计划/版本关系。只有全部预期分笔回执通过身份、时间和唯一 ID 校验后才完成。

**已核对的外部字段名只有 `PLANE_NUM = plan_id`。** sourceVersionId、operation、items、key 和回执字段均是模拟结构，不能当作正式 DMS JSON 协议。正式 M/Z 全字段映射、认证、HTTP 端点、零值处理、事务持久化与真实接收回执均未接入，也不是本次 mock 验收的完成声明。

## 历史验证记录

下列2026-09-12记录仅为原独立demo历史，其命令已退出，不作47当前运行证明。

2026-09-12：

- `node --test tests/mock-dms.test.mjs tests/mock-sales-plan.test.mjs`：8 项通过；包含六种计划类型 × M/Z 的 12 组成功路径，失败、超时、回执丢失、Z 部分回写、错误回执和重复回执。
- `node --test tests/dms-demo-web.test.mjs`：Chrome 浏览器回归，覆盖明确失败重试、两种未知结果、Z 部分回写补齐、重复回执与源单映射；断言无页面异常和外部请求。
- `npm run typecheck` 与 `tsc --noEmit -p demos/dms/tsconfig.json`：主源码与演示源码分别检查。
- Chrome 人工控制复核：M 回执丢失后 1 次投递/1 笔入库，对账进入 10；重复回执完成时间不变；JD/Z 追加单成功时保持 5，补齐后 2 次投递/2 笔入库进入 10。页面显示同步状态、完成时间、报文、来源 ID 和日志。

独立模拟页通过不代表生产工作台与 DMS 联调通过。#20 完整真实终审验收与 #22 非标准链真实身份验收仍单独保留，模拟不会写入它们的业务单据。
