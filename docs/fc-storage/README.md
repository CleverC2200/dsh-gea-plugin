# 分仓业务入库清单与接线（PostgreSQL）

**状态：设计及离线接线，尚未建表/开白名单/真实入库。** 数据源编码 `dataSourceCode` 待提供。参考原版 `gea-agent-fc` 的 `planning-store.ts`、`submission-service.ts`、数据库迁移 003/005/006，以及 `browser-repository.ts`。

## 必需的3张业务表

以下是新接口适配的**建议物理表名**，不是已发布资源。仅需 `SELECT`、`INSERT` 白名单，不需要 UPDATE/DELETE。DDL在同目录 `proposed-postgresql.sql`，由管理员在目标数据源执行；Agent不会通过SQL接口建表。

| 建议物理表                      | 用途                                      | 原版对应                                 |
| ------------------------------- | ----------------------------------------- | ---------------------------------------- |
| `agent_branch_plan_version`     | 每个分仓一份完整的人工确认计划版本        | `data_service.agent_branch_plan_import`  |
| `agent_branch_cycle_version`    | 每个分仓一份完整的周期配置版本            | `data_service.agent_branch_cycle_config` |
| `agent_branch_submission_event` | 每个补货批次的确认快照、DMS状态及回执事件 | `branch_inventory_submission`            |

三张表均具有以下**物理列**：

| 列名              | PostgreSQL类型        | 含义                                                       |
| ----------------- | --------------------- | ---------------------------------------------------------- |
| `tenant_key`      | VARCHAR(128) NOT NULL | Host从可信登录身份取得的业务租户标识                       |
| `warehouse_code`  | VARCHAR(64) NOT NULL  | 真实分仓编码，保留前导零；Host核对该用户的授权分仓         |
| `entity_key`      | VARCHAR(128) NOT NULL | 计划固定`plans`；周期固定`cycles`；提交为`aiPreOrderCode`  |
| `revision`        | INTEGER NOT NULL      | 版本号，从1开始；用上一版+1插入，唯一键防止并发覆盖        |
| `payload_text`    | TEXT NOT NULL         | 完整业务内容的JSON文本；下面列出每一种内容字段             |
| `idempotency_key` | VARCHAR(128) NOT NULL | Host按数据源、身份、分仓、版本和业务内容生成的稳定写幂等键 |
| `created_by`      | VARCHAR(128) NOT NULL | Host当前可信用户，页面不能填写                             |
| `created_at`      | TIMESTAMPTZ NOT NULL  | 数据库CURRENT_TIMESTAMP，记录创建时间                      |

主键：`tenant_key + warehouse_code + entity_key + revision`。唯一键：`tenant_key + idempotency_key`。不安装触发器、不设置级联外键，不依赖Core会话表外键。

下面的字段位于 `payload_text` 中，**不是另建的物理列**。使用TEXT而非JSONB，能直接按新接口回读有界文本；不需要JSON查询函数、JSON聚合或UPSERT。整个版本单条INSERT提交，保存中途不会出现半个月计划或半套规则。

### 人工确认计划 payload_text

根对象 `{ "plans": [...] }`；数组元素：

| 字段                   | 值类型               | 业务含义                   |
| ---------------------- | -------------------- | -------------------------- |
| `warehouseCode`        | string               | 分仓编码，必须与物理列一致 |
| `warehouseName`        | string               | 分仓名称                   |
| `sku`                  | string               | 产品编码，保留前导零       |
| `productName`          | string               | 产品名称                   |
| `month`                | string YYYY-MM       | 计划自然月                 |
| `category`             | string，可空         | 产品大类                   |
| `materialGroup`        | string，可空         | 物料组                     |
| `outboundQty`          | number，0～1e9       | 人工确认出货计划量，单位件 |
| `transferQty`          | number，0～1e9       | 人工确认调拨计划量，单位件 |
| `suggestedOutboundQty` | number或null，可省略 | 导入模板建议出货量，仅留档 |
| `suggestedTransferQty` | number或null，可省略 | 导入模板建议调拨量，仅留档 |

保存前读取旧版本，按月份+SKU合并导入值，保留未修改的SKU和月份；这对应原版数据库UPSERT行为。计算时选择整个月份的人工来源，缺项不逐SKU混用BI。未知不写0，明确0允许保存。库存、同步计划源表均不回写。

### 周期配置 payload_text

根字段 `days`：默认周期整数1～365天；`rules`：规则数组。每条规则：

| 字段     | 值类型                                      | 业务含义 / 原版字段                     |
| -------- | ------------------------------------------- | --------------------------------------- |
| `level`  | sku / material-group / category / warehouse | 规则层级，按此优先级匹配                |
| `object` | string                                      | SKU、物料组、品类或分仓；原版`objectId` |
| `days`   | integer，1～365                             | 补货周期；原版`cycleDays`               |
| `from`   | YYYY-MM-DD或空串                            | 生效开始日期；原版`effectiveFrom`       |
| `to`     | YYYY-MM-DD或空串                            | 生效结束日期；原版`effectiveTo`         |
| `status` | effective / paused，可省略                  | 默认effective；暂停规则不参与计算       |

不另存原版随机规则id，以`level+object`在完整版本内唯一标识。完整版本替换规则集，保留删除/暂停历史。已回读的配置只应用于该分仓。

### 补货提交事件 payload_text

| 字段                                           | 值类型                                 | 业务含义                                                                                                                                                              |
| ---------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stage`                                        | confirmed / dms-received / dms-unknown | 已确认快照、DMS收到、DMS结果待核对                                                                                                                                    |
| `snapshotVersion`                              | string                                 | 计算输入的SHA-256指纹（日期、计划、周期、库存/订单/建议量），不是数据库事务版本                                                                                       |
| `month`                                        | YYYY-MM                                | 补货所属月份                                                                                                                                                          |
| `planRevision` / `cycleRevision`               | string                                 | 实际回读且与当前输入一致的正式版本；BI或默认周期为`0`；未保存的人工配置禁止提交                                                                                       |
| `consumptionReviewed`                          | boolean                                | 用户在确认清单勾选的复核结果；更换分仓、数量或清单会重置                                                                                                              |
| `calculationContext`                           | object                                 | asOf、warehouseCode、stockDates、planSource、cycleSource、plans、cycle、evidence（SKU、库存日期、计划月份、库存/可用量、订单剩余、在途、当月/次月计划、周期和建议量） |
| `aiPreOrderCode`                               | string                                 | DMS原始业务意图编号，也作为entity_key                                                                                                                                 |
| `rows`                                         | array                                  | 确认行，包含被调减到0的行                                                                                                                                             |
| `rows[].sku` / `productName`                   | string                                 | 产品编码、名称                                                                                                                                                        |
| `rows[].recommendedQty` / `actualQty`          | number                                 | 建议量、实际量，件                                                                                                                                                    |
| `rows[].reason`                                | string                                 | 调整理由；实际量小于建议量时必填                                                                                                                                      |
| `receipt.orderCode` / `receipt.aiPreOrderCode` | string                                 | DMS返回的订单号/意图编号，仅收到回执后记录                                                                                                                            |
| `errorCode`                                    | string，可省略                         | 可供核对的业务状态码；不存凭据或原始异常                                                                                                                              |

先保存确认快照再调用DMS，收到回执后追加事件。数据库保存成功不等于DMS下单成功，DMS暂存也不等于审核或推单。收到DMS回执但归档失败时页面保留回执，原SQL请求进入核对状态，不再自动下单。

提交前重新查询业务输入并比较快照指纹，核对正式计划和周期的最新版本；变化则要求重新确认。Host校验快照指纹、分仓、版本来源与建议量一致性；这不是数据库锁，也不替代服务端权威计算。

原版GEA审批实例/审批状态尚未恢复；这里是现有DMS链路的留档，不把DMS回执当GEA审批回执。

## 暂不入业务库的数据

草稿数量与理由、未确认导入文件、周期编辑草稿、筛选、列顺序、冻结列、布局偏好继续由现有Core/页面会话恢复合同保存。原版浏览器审计日志不单独迁移，正式计划/规则版本及提交事件本身保留变更历史。会话、消息、库存快照、货龄、基地资源等原业务来源不复制建表。

## 调用和失败流程

1. 管理员建表、发布该数据源三表的SELECT/INSERT白名单，给分仓Consumer开`API:sql:execute`能力。
2. 配置Host `fcStorage.<test|production>`，内容为`dataSourceCode`、`published:true`和`users:[{tenantId,userId,warehouses:[...]}]`。未配置时不执行SQL。通用接口本身不做人员行过滤，Host使用可信身份及显式分仓授权限制固定业务操作；如其他客户端也能直接访问该数据源，应使用租户隔离的数据源，不把SQL中tenant_key当平台强制隔离。
3. 页面“保存人工计划/保存周期规则”→Host固定命名参数SQL→统一成功码和affectedRows检查→回读并核对版本/内容→参与页面计算。
4. 网络中断、未知结果、回读失败保留原请求。“读取/核对”仅执行SELECT，按原版本核对原幂等键和内容（后续产生新版本也能确认原写入）；不会自动重复写入，也不会换键重跑。
5. 保存前检测已加载基线与库中最新版本，不一致则要求先读取重新调整；检查后的并发竞争由唯一键拒绝；保留冲突请求，由管理员确认失败后再处理，未提供自动覆盖。

## 当前接线边界

- 首版单个完整版本的UTF-8 JSON上限48KB（低于接口参数64KB上限）。超过时整体拒绝，**不拆成部分提交**。原版最多5000行导入不代表本接口首版能保存5000行；大批量需要后续的分块暂存+发布版本协议。
- 当前分层周期执行上限12条，沿用已完成的分仓SQL接线；不是原版500条能力的承诺。
- 首次选择分仓；之后页面进入/刷新会重新查库恢复该分仓的计划与周期。只记住分仓选择，不把缓存当成已保存事实。切换日期/周期保留人工计划源并重新计算。
- 消化复核已有入口，但原版“正库存批次货龄≥60天且有缺货才强制复核”的精确条件仍待确认批次明细资源；未用最大货龄冒充正库存批次。
- 本次无需真实凭据即可测试保存/回读/未知核对；真实环境仍缺dataSourceCode、建表与白名单确认。DDL未执行，未写生产或测试数据。

## 本次验证记录

- Workbench相关测试72个通过，覆盖保存入口交互、未修改SKU合并、页面应用失败不重写、重载后原请求核对、取消、DMS快照/回执顺序及其他分仓界面回归。
- Host业务入库与既有DMS测试15个通过；新增入库模块独立TypeScript检查通过。
- 分仓SQL测试28个通过，包含持久周期配置不影响其他分仓的用例。
- 分仓页面esbuild打包通过，新增业务模块lint通过，补丁空白检查通过。
- 全库检查未通过：Workbench现有reference-message类型错误；Host隔离输入缺Manage资源及部分Workbench声明；页面单独类型检查缺CSS声明和旧源码引用。运行时Session恢复测试10个通过，但另一运行时测试因缺`lib/business/inventory-dealer/sql.config.json`构建产物无法启动。
- 这些结果不等于真实PostgreSQL、服务端授权、真实DMS或窗口装载验收；没有执行DDL，也没有发起真实业务写入。
