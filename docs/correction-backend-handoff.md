# 纠偏接口对接清单

## 职责范围

按用户要求，本任务只允许修改 DSH 客户端、插件相关代码。GEA 管理端及其后端由其他同事负责，本任务不再修改、合并或部署该仓库。

此前后端 MR !116 已关闭且未合并，相关本地/远端分支和工作副本已撤销。以下是插件当前依赖的接口契约，供后端同事核对，不表示接口已经具备，也不指定其内部实现。

| 接口能力 | 插件所需内容 |
| --- | --- |
| 周期查询 | 支持 planType=CORRECTION，返回真实纠偏周期 |
| 计划列表 | 支持 orderType=Z、periodId、planTypeCode、status 和分页；不能混入其他周期的月初单 |
| 客户与指标 | monthlyApproved、hasCorrection、mPlanQty/mPlanAmount、corrPlanQty/corrPlanAmount；未提纠偏的客户如何返回只读记录需约定 |
| 发货指标 | shipQty/shipAmount 的数据源及月度统计口径需确认；缺失不能当作零 |
| 详情 | correctionContext 与 actionContext：当前版本、状态、节点、allowedActions、snapshotHash；服务端校验真实可操作人 |
| 操作 | SAVE/APPROVE/REJECT；插件发送 adjustmentMode=ABSOLUTE_NET、expectedSnapshot、SKU adjustQty 与幂等键 |

业务口径：保存不推进审批、不写确认值；通过按固定基准加绝对净调整计算；退回仅清发起节点。审批权限分可处理、只读、不可见；XN 跳过区域节点。具体服务端实现由后端负责人决定。

DSH 本次保留纠偏周期筛选、角色状态可见范围、错误分类和读取失败显示缺失值等修改。后端契约未具备时，插件不会伪造数据或放开审批。既有客户端测试使用受控服务，不能替代与实际 GEA 接口联调。
