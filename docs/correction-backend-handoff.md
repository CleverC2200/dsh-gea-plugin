# 纠偏接口对接清单

## 当前范围与历史

2026-10-19 销售计划审批纠偏任务已获准在隔离工作树实现 Workbench、GEA Host 和业务后端。原始 checkout、正式 GitLab、生产审批与 DMS、安装及发布仍在保护范围内。本轮验证使用隔离数据或外部 HTTP 替身。

此前后端 MR !116 已关闭且未合并，相关分支和工作副本已撤销。该历史不授予本轮执行权限，也不表示当前后端已经部署。

## 公开读写合同

沿现有 `/sales-plan/plans` REST 入口使用 camelCase 字段。页面与页面动作归 Workbench，身份、凭据与受控接入归 GEA Host；业务后端负责实时权限、事务、节点写入与业务日志。

| 入口或能力                                            | 本轮合同                                                                                                                                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 周期查询                                              | 支持 `planType=CORRECTION`，返回真实纠偏周期                                                                                                                                                                                                     |
| `GET /sales-plan/plans`                               | 支持 `orderType=Z`、周期、类型、状态和分页；返回 `monthlyApproved`、`hasCorrection`、`mPlanQty/mPlanAmount`、`shipQty/shipAmount`、`corrPlanQty/corrPlanAmount`、`prevAdjAddQty/prevAdjCutQty`、服务端百分比 `amountProgress/correctionProgress` |
| 列表汇总                                              | 同一筛选范围的 `summary={targetAmount,planAmount,diffAmount,planQty}`，不使用当前页合计替代全量汇总                                                                                                                                              |
| `GET /sales-plan/plans/{planId}`                      | `currentVersion/skus/versions/logs`，以及 `actionContext`、`correctionContext`；SKU 保留冻结 `qty/corrBaseQty/amt/price`、提报端调整及四节点六字段，提供 `nodeAdjAddQty/nodeAdjCutQty/editable`                                                  |
| `actionContext`                                       | 当前 `versionId/status/nodeOrder/allowedActions/snapshotHash`；引擎节点 2/3/4/5 对应 region/province/area/category。仅当前真实可操作人取得动作能力，其他情况只读                                                                                 |
| `correctionContext`                                   | `contract=absolute-net-v1`、`monthlyApproved=true`、`approvalOpen=true` 才允许纠偏写入                                                                                                                                                           |
| `POST /sales-plan/plans/versions/{versionId}/actions` | `action=SAVE/APPROVE/REJECT`、`adjustmentMode=ABSOLUTE_NET`、`expectedStatus`、`expectedSnapshot`、`approvalRole`，以及 SKU 的 `[{skuCode,adjustQty}]`；请求头保留 `Idempotency-Key` 和 `X-Request-Id`。退回使用 `remark`，不传调整明细          |

`adjustQty` 是相对冻结月初基准的独立绝对净调整。SAVE 只保存当前节点四个调整字段，不推进状态或改确认值。APPROVE 写当前节点六字段，确认金额等于冻结 `amt` 加分别舍入的追加金额减追减金额。REJECT 仅清当前节点六字段。M 单保持既有调整语义。

Host 将已验证的模式、快照与节点角色一同发给后端。调用方省略角色时，只可绑定本次校验得到的唯一授权角色。结果未知后，原键只能重放冻结的原请求；新快照不能改写已发送意图。

## 验收边界

发货数据按本轮确认的数据源、客户、日期及单位映射由服务端读取；缺失保持缺失，不补零。客户端消费服务端进度、汇总和编辑能力。未提 Z 的终审 M 客户返回只读记录，月初数量与金额沿当前有效终审 M；生成 Z 后沿冻结快照。

HTTP 成功之后仍需读回同一版本、节点六字段、冻结基准、其他节点及动作日志。Host 透传这些字段，不重新计算金额，也不把服务端缺失能力补成可写。`tests/sales-plan-action.test.mjs` 的 Business 公开入口与外部 HTTP 替身验证不代表真实 Core profile、已部署后端、生产审批或 DMS 验收通过。
