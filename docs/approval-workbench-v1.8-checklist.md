# 需求预测 Agent V1.8 迭代清单（销售计划审批工作台）

- 来源文档：`/Users/synear/Downloads/需求预测Agent_测试迭代文档_V1.8.docx`（2026-09-20，李琳 / 数智化部 生产及供应链IT组）
- 登记日期：2026-09-21
- 代码基线：`main` @ `a700c63`（GEA 0.0.76，含 APS V0.2 合并）
- 说明：本文只做需求拆解与代码落点标注，**未改动任何代码**。勾选完成以“工程改动 + 验收标准”双满足为准。

## 一、总览

| 类别 | 数量 | 编号 |
| --- | --- | --- |
| P0 阻断主流程 / 数据错误 | 2 | #11 #13 |
| P1 交互、布局与体验修复 | 15 | #01 #02 #03 #04 #05 #06 #08 #09 #10 #12 #14 #15 #16 #17 #18 |
| P2 缺陷待排查 | 1 | #07 |

归口拆分：纯前端工程直改 14 项；前端 + 后端配合 1 项（#15）；缺陷排查 3 项（#07 后端 + 主数据、#11 后端 + 前端、#13 后端为主）。

其中 #05 / #08 / #10 / #12 / #14 / #17 这 6 项在改完之后，还要同步固化到规则包。

## 二、18 项待办清单

代码落点统一指本仓库 `src/workbench/original/workbenches/regionalApproval/`（简称 `regionalApproval/`），文案在 `src/workbench/original/zh-CN.json`。

### P0 —— 阻断主流程 / 数据错误

- [x] **#11 退回操作报错，无法完成退回** — **服务端已修复，接口实测通过**（2026-09-21 闭环；客户端侧无需再改）
  - 修复验证（2026-09-21 18:13）：同一账号、同一份文档报文（`{"action":"REJECT","expectedStatus":1,"remark":"...","adjustments":[]}`）直连 `POST /sales-plan/plans/versions/{versionId}/actions`
    - `p-jxs-2026-10-00028-1` → `HTTP 200`，回执 `fromStatus=1 → toStatus=6`、`auditId=sales-plan-log:149`
    - `p-jxs-2026-10-00026-1` → `HTTP 200`，回执 `fromStatus=1 → toStatus=6`、`auditId=sales-plan-log:150`
    - 回读确认落库：`status=6`、`returnReason` 已写入、日志 `SUBMIT(0->1) -> REJECT(1->6)`
    - 对比：同日 06:21 UTC 完全相同的报文返回 `409 NOTIFICATION_PAYLOAD_INVALID：payload.plan_month 为必填字段`，期间服务端有变更
  - 遗留：客户端 UI 侧的"点退回"验收还没做（该账号没有待办任务，工作台按钮可能不可用，需要真实审批账号）；下面保留的是当时的排查证据
  - 现象：勾选组织点「退回」，填完原因确认后弹窗内报错 `GEA_HTTP_409：payload.plan_month 为必填字段`，退回提交不了。
  - 根因（证据链，全部在后端仓库 `synear-gea-boot` @ `origin/pro`）：
    1. 报错文案来自通知模块的 payload schema 校验：`NotificationEventApplicationServiceImpl.validateSchemaNode`，`path` 初始值为 `payload`，字段缺失即拼成 `payload.<字段> 为必填字段`；这条消息只可能由它产生。
    2. 退回时后端只发一条"退回回执"通知：`SalesPlanApprovalWorkflowAdapter.action()` 里 `if (rejecting || next == 5) receipt(...)`，而 `receipt()` 用的是 `payload(doc)`，该 payload 只有 `plan_id / version_id / plan_type_code / businessAction / parameters`，**没有 `plan_month`**（单测 `SalesPlanApprovalWorkflowAdapterTest` 第 195–197 行把这个不含 `plan_month` 的 map 写成了断言）。
    3. 同一 `ApprovalFlow` 的 `policyKey` / `eventType` 同时用于提报（`submit()` → `approvalPayload(doc, periodMonth)`，**有** `plan_month`）和回执（`receipt()` → `payload(doc)`，**没有**），所以两者共用同一份已发布 schema 时，回执必然校验失败。
    4. `action()` 标了 `@Transactional(rollbackFor = Exception.class)`，通知校验抛错会把整次退回一起回滚 —— 与"弹窗报错 + 队列状态不变"完全一致。
  - 为什么插件修不了：动作请求 DTO（`SalesPlanActionRequest`）只接受 `action / expectedStatus / remark / adjustments / notification`，其中 `notification` 只允许 `title`、`content` 两个文本字段（未知字段直接反序列化失败）。也就是说客户端**根本没有渠道**把 `plan_month` 送给退回接口，文档里"由前端补齐计划月份"的设想在当前契约下不可实现。
  - 后端两种改法（二选一，属后端 / 运维侧）：
    - 代码侧：让 `receipt()` 也用带月份的 payload（`approvalPayload(doc, periodMonth)` 同款字段：`plan_month` / `order_type` / `doc_no`）；
    - 配置侧：生产库里那条按 `policyKey` 发布的 payload schema 不要把 `plan_month` 列为必填，或者给回执单独发布一份 schema。
  - 官方接口文档核对（2026-09-21，`http://100.100.1.221:8080/gea-boot/doc.html` → `02 业务管理 / 销售计划｜计划管理 / action`，对应 `/v3/api-docs/02-business-management`）：
    - `POST /sales-plan/plans/versions/{versionId}/actions`，必填 header 只有 `Idempotency-Key`、`X-Request-Id`（`X-Trace-Id` 选填），鉴权走 `X-Access-Token`；
    - 请求体 `SalesPlanActionRequest` 的 `required` 只有 **`action`、`expectedStatus`**，可选 `remark`、`adjustments`、`notification{title,content}`；
    - 全量接口文档里 `plan_month` / `planMonth` 出现 **0 次** —— 客户端没有任何渠道传这个字段，文档层面坐实 #11 只能由后端修；
    - 反向发现：我们客户端实际会多发 `approvalRole`、`approvalPolicy`、`expectedSnapshot` 三个字段，这三个在官方文档里也**完全没有声明**（全量文档 0 次命中），服务端按未知字段忽略——需要和后端确认这是有意兼容还是文档漏更。
    - 生产环境同一份文档已复核（`https://gea.synear.cn/gea-boot/v3/api-docs`）：`SalesPlanActionRequest` 与内部环境完全一致，全量文档 `plan_month` / `planMonth` 命中 0 次。结论：**接口层面确实不需要月份，"退回只需要知道是哪个单据"是对的**。
    - 但 409 不来自接口入参校验，而来自服务端内部回执通知：后端流程文档 `docs/销售计划后端控制逻辑.md`（origin/pro）第 235 行写明「REJECT 或到 5 时给发起人发回执通知（幂等键 `sales-plan:receipt:{versionId}:{status}`，模板 `sales_plan_receipt`）」，而代码里这条回执用 `payload(doc)`，只带 `plan_id / version_id / plan_type_code / businessAction / parameters`。客户端请求体里可控制的字段（`action` / `expectedStatus` / `remark` / `adjustments` / `notification`）都进不了这个 payload，所以这条 409 客户端没有着力点。
  - **真实复现（2026-09-21，生产 GEA，用客户端登录数据直调）**：
    - 请求：`POST https://gea.synear.cn/gea-boot/sales-plan/plans/versions/p-jxs-2026-10-00028-1/actions`，报文只有文档声明的三个字段 `{"action":"REJECT","expectedStatus":1,"remark":"测试退回..."}`（**没有任何额外字段，也没有月份**）
    - 响应：`HTTP 409` `{"errorCode":"NOTIFICATION_PAYLOAD_INVALID","message":"payload.plan_month 为必填字段","category":"CONFLICT"}`
    - 回读该单据：`status=1`、`returnReason=null`、`updatedAt` 未变、日志只有 `SUBMIT(0->1)` —— 事务已回滚，**没有产生任何写入**
    - 结论：报文里本来就没有月份字段，仍然报 `plan_month 必填`；且 `errorCode` 明确是通知模块的 `NOTIFICATION_PAYLOAD_INVALID` —— 与客户端请求体无关，坐实是服务端回执通知那条 payload 的问题
  - 插件侧可做且值得做的只有展示层：不要在弹窗里直接显示 `GEA_HTTP_409：payload.plan_month ...` —— 这条归 #12，改完后用户至少会看到一句能看懂的话，但退回本身仍然会被后端拦住。
  - 验证前置条件：后端先改完，才谈得上"退回 → 下级收到 → 重新提报 → 再回到本节点"的回归。

- [ ] **#13 上一节点的调整结果未传递到下一节点** — 缺陷排查（后端为主）
  - 现象：山西凯胜源商贸有限公司的 SKU 10000296，上一节点把确认计划量 22 改成 13，流转到下一节点显示 8；既不是上一节点值，也不是提报端原值。
  - 要做：本节点确认计划量 = 上一节点已确认值（未改动时按继承取，不回退到提报端原值、不另取默认值）；组织行汇总（计划金额 / 确认计划金额 / 达成率）跟着继承值同步重算；连续三级流转逐级可追溯。
  - 代码落点：取值链在 `regionalApprovalQueryModel.ts`（版本取值与汇总）、`InlineSkuDetails.tsx:37`（`salesPlanEditableQuantity` 基线）、`models/salesPlanSubmitModel.ts`（提交流转）。
  - 待确认：D27（未改动节点展示口径）；本条现象本身属缺陷，不受 D27 影响。
  - 备注：与 V1.7 #20（SKU 改数后上级组织行未重算）同源，建议一起排查后再回归。
  - 排查结论（2026-09-21）：**不是后端丢数据，是客户端没把调整量发出去**。原判断“后端为主”需修正。
    - 生产数据（GEA 正式环境，计划 `p-jxs-2026-10-00027`，山西凯胜源商贸有限公司，status 3）核对 SKU 10000296：`qty=8 / regionConfirmedQty=8 / provinceConfirmedQty=8 / areaConfirmedQty=null`，`regionAdjAddQty / provinceAdjAddQty / areaAdjAddQty / …CutQty` **全部为 null**，`adjAddQty=adjCutQty=0`。即 13 从未写进服务端，连调整量字段都是空的。抽扫同期 8 张计划（约 490 个 SKU，status 1/3/4）也没有任何一个 SKU 的节点确认值 ≠ 提报值 —— 没有任何一次节点改数落过库。
    - 受控复现（夹具 + 本地 Web，`tests/pending-adjustments-web.test.mjs` 先红）：内联明细把 20 改成 22.125 → 不等 500ms 自动暂存、直接点「通过」，动作报文只有 `{"action":"APPROVE","expectedStatus":1}`，**完全没有 adjustments**。链路：通过弹窗只读本地草稿 → 草稿有 500ms 防抖还没落盘 → 弹窗读到旧草稿 → 自动提交不带调整量 → 服务端按原值流转 → 下一节点看到 8。
    - 后端核对（`synear-gea-boot` @ `pro`，`SalesPlanApplicationService`）：APPROVE 且节点 ≥ 2 时会走 `confirmNode(currentSkus, approvalNodeOrder, request.adjustments())` **真的应用调整量**；基线 `previousConfirmedQuantity` 取「本节点及以下最近一个非空的确认值」，与前端 `salesPlanEditableQuantity` 口径一致。所以服务端是吃这个字段的。
    - 附带约束（业务要知道）：多人共同审批的节点里，`!outcome.nodeCompleted()` 时带调整量会被服务端拒绝（“多人节点尚未结束，调整量请由最后一位审批人提交”）——**只有该节点最后一位审批人能带调整量**。
    - 已修：内联明细把「界面上当前显示的本节点确认量」直接交给上层（内存直连，不再依赖 500ms 防抖落盘）；通过弹窗按本次角色把它换算成调整量（`确认量 − 本节点基准`），覆盖本地草稿里的旧值（改回原值会正确算成 0 而不是残留旧调整量）；动作成功后清掉这份内存值。这样也不怕前端/后端角色口径不一致——服务端算出的一定是用户看到的那个数。
    - 验收：`tests/pending-adjustments-web.test.mjs`（复现用例，修完转绿）+ 相关 20 项回归全绿；**真机客户端 + 正式环境验收未做**，#13 暂不打勾。

### P1 —— 交互、布局与体验修复

- [ ] **#01 草稿暂存失败提示改为就近展示** — 工程直改
  - 要做：失败提示挪到出错输入框旁（红字 + 重试入口），不再用表格顶部通栏；多处失败逐处标注；重试成功即时消失、不用刷新；提示不遮挡其他列。
  - 代码落点：`InlineSkuDetails.tsx:25`（`draftState` 状态）、`InlineSkuDetails.tsx:68`（自动暂存 effect）；现提示位置在 SKU 明细表头区。
  - 待确认：D21（就地提示 / 保留表头但自动滚动 / 两者并存）。
  - 规则包：建议固化「自动暂存」相关章节。
  - 排查结论（2026-09-21）：**“暂存失败”不只是提示位置问题，背后有两个真实缺陷，已一起修**。
    - 根因一（必然失败）：Host 的 `salesPlanDraft` 用 `salesPlanAccessForRow(row, detail)` 重算编辑能力，既没带登录权限、也没带界面已选角色；账号可用角色多于一个、或该版本没有服务端能力（退回件常见）时解析不出编辑角色，直接抛 `GEA_DRAFT_NOT_EDITABLE` —— 而界面照样给出可编辑输入框，于是「改一次失败一次」。旁证：桌面运行目录 `~/Library/Application Support/dsh-gea-desktop/` 与本地 `.runtime/workbench-development/` 下**从来没有生成过 `approval-drafts` 目录**，即一次都没存成功过。
    - 根因二（改小数字时失败）：Host 校验调整量用“按状态”基线（`salesPlanEditableQuantity(sku,status)`），界面用“按节点角色”基线。角色等于当前节点 actor 时两者完全一致（实测 832 组零差异），角色不等于时才分叉（1738 组不一致）；这种情况下用户把确认计划量改小会被误判成 `STALE_DRAFT`。
    - 根因三（输入 4 位以上被清空）：输入框的值走的是展示用格式化函数 `formatExactDecimal`，会给千分位（`1111` → `1,111`）；`type=number` 不认带逗号的值，浏览器直接把整格清空。
    - 根因四（偶发收不到暂存请求）：草稿读取是异步的，读回来晚于用户输入时会把刚敲的数字覆盖成基线值，看起来像“输入被吞掉”。
    - 已做：① 界面提示改为行内红字 + 就地重试，去掉表格顶部通栏；② Host 不再用审批能力卡本地草稿（界面自 0.0.59 `2560342` 起按“详情可读即可编辑”，服务端在提交动作时才校验写权限；本地草稿不上送 GEA），只保留登录身份、快照新鲜度、数据形状三道校验；③ 草稿自身记录写入时的节点口径，读回用同一套基线；④ 输入框不再塞千分位；⑤ 读草稿改成只补用户没动过的行，不再覆盖正在输入的数字。
    - 实测（2026-09-21，本地 Web + 测试环境 GEA）：退回件 `p-jxs-2026-10-00009`（status 8、无 actionContext、无可处理通知、账号无 `sales-plan:*` 权限）改 4 位数后正常落盘，草稿文件首次生成；控制台不再出现 `GEA_DRAFT_NOT_EDITABLE`。
    - 验收边界：代码与自动化用例已绿（`tests/draft-host.test.mjs`、`tests/inline-draft-status-web.test.mjs`，含 19 项相关回归）；**真实桌面客户端 + 生产环境验收未做**，#01 暂不打勾。
    - 待拍板：是否要恢复“没审批权限就不给改数量”的严格口径。若要严格，必须同时收紧界面编辑入口，否则会重演“界面能改、一存就失败”。
    - 备注：D21 按推荐值（输入框旁就地提示）实现。

- [ ] **#02 可编辑字段底色改白、输入框改圆角** — 工程直改
  - 要做：可编辑输入框白底 + 1px 浅灰描边、聚焦转品牌色；只读字段保持无底色 / 次要文字色；圆角与下拉、按钮一致；全页同类可编辑控件一起排查（表格、抽屉、弹窗）。
  - 代码落点：`InlineSkuDetails.tsx` 输入框、`src/workbench/workbench.css` 表单控件样式。
  - 规则包：建议固化「工作台可编辑态视觉规范」。
  - 已做（2026-09-21，本地 Web 实测）：在 `src/workbench/workbench.css` 末尾加了一条只作用于工作台文档的规则，覆盖**全页同类可编辑控件**（内联明细、动作弹窗的调整数量、纠偏页、草稿抽屉）：
    - 可编辑（`:not([disabled])`）的 `input/textarea`：白底 `#fff` + `1px` 浅灰描边 `var(--bg-4)`(#c9cdd4) + 圆角 `4px`；hover 与 focus 转主色并加 2px 浅色外圈。
    - 只读 / 禁用控件保持原来的灰底无描边，用来区分「能改 / 不能改」。
    - 实测前后：`rgb(242,243,245)` 灰底 / 透明边 / 圆角 2px → `rgb(255,255,255)` / `1px #c9cdd4` / 4px。
  - 发现（本次没动，需你拍板）：`original/theme.css` 想把 `--primary-*` 映射成品牌红，但 Arco 自己的 `:root` 定义在后面生效（CSS `@import` 被提前），所以全站 `rgb(var(--primary-6))` 实际是 Arco 蓝（按钮、选中态都是蓝的）。改这一处会让全站强调色从蓝变红，属于全局视觉变更，单独定。
  - 验收：新增 `tests/editable-input-style-web.test.mjs` 断言白底 / 1px 描边 / 圆角 ≥4px / 聚焦变色；**真机客户端验收未做**，#02 暂不打勾。

- [ ] **#03 顶部控件标签加粗** — 工程直改
  - 要做：「月初 / 纠偏」切换项加粗；「计划月份」「版本」「对比」标签加粗、取值保持常规字重；同一行其他标签一并处理。
  - 代码落点：`RegionalApprovalWorkbench.tsx` 标题行 / 顶部工具栏（`columns`、`targetAmount` 附近区块）。
  - 已做（2026-09-21，本地 Web 实测）：实际落点不在 `columns` / `targetAmount`，而是标题行的 `.scope`（计划月份 / 版本 / 对比标签）与 `.orderTabs`（月初 / 纠偏切换按钮），代码在 `RegionalApprovalWorkbench.module.css`。
    - `.scope small` 加 `font-weight: 600`；`.orderTabs .arco-btn` 加 `font-weight: 600`。该行只有这三个标签，已一并覆盖。
    - 右侧下拉的取值保持常规字重（实测 400），标签 400 → 600。
    - 月初 / 纠偏 这组切换按钮是月度页与纠偏页共用的（`SalesPlanWorkbench` 传给两个页面），所以两个页面的切换项都跟着加粗。
  - 验收：`tests/editable-input-style-web.test.mjs` 增加断言（三个标签字重 ≥600、切换项 ≥600、取值仍为 400）；相关 12 项回归全绿；**真机客户端验收未做**，#03 暂不打勾。

- [ ] **#04 表格表头文字加粗** — 工程直改
  - 要做：组织队列表头与 SKU 明细表头加粗；表头底色不加深、不加分隔线；全页表格统一（含品类子表、抽屉内表格）。
  - 代码落点：`RegionalApprovalWorkbench.tsx:1808` 起的 `columns` 定义、`InlineSkuDetails.tsx` 明细表头。
  - 已做（2026-09-21，本地 Web 实测）：实测改前所有表头字重都是 500，改后统一 600，底色仍是 `#f2f3f5`（`--bg-2`）未加深、没有新增分隔线。
    - `src/workbench/workbench.css` 加 `th, .arco-table-th { font-weight: 600 }`：覆盖 Arco 队列/品类子表/纠偏表，以及弹窗里 portal 出去的表格（宿主壳本身没有表格，所以不限定作用域也能覆盖 portal）。
    - `InlineSkuDetails.module.css` 的 `.table thead th`、`RegionalApprovalLiveAdjustmentDialog.module.css` 的 `.modal th` 由 500 改 600（这两条选择器优先级更高，必须一起改）。
  - 验收：`tests/editable-input-style-web.test.mjs` 增加断言（队列与明细表头字重 ≥600、表头底色必须仍是 `rgb(242,243,245)`）；相关 15 项回归全绿；**真机客户端验收未做**，#04 暂不打勾。

- [ ] **#05 审批流程图默认收起，点击后在标题行下方展开** — 工程直改（建议同步固化）
  - 现象：五个节点的横向流程图常驻占一行，一屏只剩约 3 行明细。
  - 要做：默认收起，收起态在标题行右侧显示「当前节点：省区审批」；点击在标题行下方向下展开、再点收起；不刷新、不丢筛选与已编辑内容；同一次会话内记住展开状态。
  - 代码落点：`RegionalApprovalWorkbench.tsx:487` 附近（`progressOpen` 状态）、流程图组件渲染区。
  - 待确认：D22（收起态按当前用户所属节点 / 当前查看节点 / 已推进到的最末节点）。
  - 备注：延续 V1.7 #09，上一轮未闭环。
  - 已做（2026-09-21，本地 Web 实测）：
    - 流程条（`stageViewport`）默认收起（`display:none`，DOM 保留，不影响节点筛选逻辑），标题行右侧新增入口按钮「当前节点：X」，点开在标题行下方展开、再点收起（`aria-expanded` / `aria-controls` 齐备）。
    - 展开状态写进既有的会话级状态（`regional-approval-state.stageLaneOpen`），同一次会话刷新后保持；收起/展开只切显示，不动数据，也不重挂表格。
    - D22 取值（2026-09-21 业务口径修正）：默认节点 = **用户第一个有权限审批的节点**——先取权限码给出的审批节点，没有权限码时再用服务端给的证据（同版本可处理任务 / 角色能力）推出节点，按节点顺序取第一个；队列默认也跟着落到该节点（不再一上来就展示全部节点）。例如只被派了城市经理待办的账号，打开就是「当前节点：城市经理审批」，队列只列该节点的单。两者都推不出来时才退回「全部节点」；用户自己切到「全部节点」或别的节点后不会被自动改回。
    - 节点口径不变：流程条里每个节点仍是「切换队列节点视图」的入口；原来的「提报进度」弹窗（工具栏图表按钮）也还在，可作为全节点总览。
  - 验收：新增 `tests/stage-lane-web.test.mjs`（默认收起、入口文案、点开/收起、刷新后保持、收起不丢已改数字、无权限码账号默认落到待办节点）；`v16-web`、`role-visible-permission-web` 补了「先展开再点节点」的步骤；相关回归全绿。**真机客户端验收未做**，#05 暂不打勾。
  - 待办：改完需同步固化到规则包（本轮先记）。

- [ ] **#06 删除筛选区上方的「组织范围」标题行** — 工程直改
  - 要做：删掉「组织范围」标题文字及右侧分隔线；五个筛选框上移补位；筛选顺序、默认值、查询逻辑不变。
  - 代码落点：`zh-CN.json:469`（`organizationScope.title`）、`RegionalApprovalWorkbench.tsx:1191` 附近（`draftLiveFilters` 更新）。
  - 已做（2026-09-21，本地 Web 实测）：
    - 删掉整个 `filterHeading` 行（标题 + 它下面的分隔线），筛选行上移补位；五个筛选框的顺序、默认值、`draftLiveFilters` 更新逻辑一行未动。
    - 原来挂在标题行右侧的两个状态标签（「样例候选 · 不作用于 GEA 队列」「草稿待应用」）移到查询/重置同一格，避免窄屏下丢状态提示；窄屏容器查询里对 `filterHeading` 的三处引用一并清掉，字段名隐藏规则保留。
    - 顺手删掉已无引用的 `filters.title`（zh-CN / en-US）。
    - 实测：改大区筛选 → 队列从「共 24 条」变「共 1 条」；点「重置」回到「共 24 条」、大区回「全部大区」。（注：live 模式下筛选是选完即生效，查询按钮保持禁用，这是既有行为，不是本次改动。）
  - 验收：相关 13 项回归里 11 绿，另外 2 个是改动前就红的存量用例（`approval-visibility-web` 旧文案、`detail-summary-web` 旧汇总口径）；**真机客户端验收未做**，#06 暂不打勾。

- [ ] **#08 列名「计划/目标」改为「计划金额/目标金额」** — 工程直改（建议同步固化）
  - 要做：列名改「计划金额 / 目标金额」；取值口径不变；品类子行同名列同步改名。
  - 代码落点：`RegionalApprovalWorkbench.tsx:1808` 起的 `columns`、`zh-CN.json` `columns` 段。
  - 规则包：固化规则包列布局章节。
  - 已做（2026-09-21，本地 Web 实测）：`columns.progress` 与 `columns.categoryProgress` 一并从「计划/目标」改成「计划金额 / 目标金额」（中英同步），取值口径一行未动；品类维度打开时用的是同一个文案 key，所以子行表头同步生效。实测队列表头：组织名称 / 月度目标 / 月计划 / **计划金额 / 目标金额**。
  - 验收：`tests/editable-input-style-web.test.mjs` 的表头用例增加断言（必须出现「计划金额 / 目标金额」、不能出现「计划/目标」）；相关用例全绿。**真机客户端验收未做**，#08 暂不打勾。
  - 待办：改完需同步固化到规则包「列布局」章节（本轮先记）。

- [ ] **#09 达成率改用进度条展示，去掉「金额」字样** — 工程直改
  - 要做：达成率改细进度条 + 百分比；百分比前不再带「金额」；宽度自适应不截断；品类子行同步。
  - 代码落点：`RegionalApprovalWorkbench.tsx:1787` 已有 `Progress`（品类行），组织行进度条与 `zh-CN.json:995` 的 `amountProgress: "金额 {{progress}}"` 文案需同步调整。
  - 待确认：D23（阈值配色：<95% 红 / 95–100% 橙 / ≥100% 绿，或单色、或不按阈值）。
  - 已做（2026-09-21，本地 Web 实测）：组织行与品类子行统一成「细进度条（`Progress size='small'`）+ 百分比」，百分比前不再带「金额」；进度条宽度改成 100% 自适应列宽，不再固定 100px。
    - D23 按文档推荐值实现：<95% 红 / 95–100% 橙 / ≥100% 绿，判色函数在 `models/salesPlanProgressModel.ts` 的 `salesPlanProgressBarColor`。
    - 文案：队列列 `regionalApproval.amountProgress` 从「金额 {{progress}}%」改成「{{progress}}%」；品类子行单独那句「金额 {{progress}}」已删除（直接渲染百分比）。纠偏页的「金额进度 / 时间进度」是另一套口径，保持不动。
    - 实测（生产数据 14 行）：100.0% → 绿 `rgb(0,180,42)`；97.8/98.9/99.3/99.8% → 橙 `rgb(255,125,0)`；85.3/86.8/88.3/89.4/89.9/90.7/91.6/93.7%（含 27.3%）→ 红 `rgb(245,63,63)`；进度条宽度随列宽自适应（125–193px）。
  - 验收：新增 `tests/progress-column-web.test.mjs`（三条计划分别 50% / 97% / 120%，断言文案无「金额」、进度条存在且宽度自适应、三档配色正确）；`tests/detail-summary-web.test.mjs` 的两条旧断言（`金额 37.5%` / `金额 75.0%`）已按新口径改成纯百分比。**真机客户端验收未做**，#09 暂不打勾。
  - 待办：改完需同步固化到规则包（本轮先记）。

- [ ] **#10 去掉独立展开箭头，保留点击组织名称展开** — 工程直改（建议同步固化）
  - 要做：去掉行首独立展开箭头控件；点击组织名称展开 / 收起；名称保持蓝色 + 悬停手型；展开态用行底色或名称前置小三角体现，不新增控件列。
  - 代码落点：`RegionalApprovalWorkbench.tsx:699`（`expandedLiveGroups`）及队列行渲染。
  - 待确认：D26（名称蓝色 + 手型 / 前置静态小三角 / 「展开」文字按钮）。
  - 已做（2026-09-21，本地 Web 实测）：D26 按文档推荐值实现「名称蓝色 + 悬停手型」，并加名称前置小三角表示展开态。
    - 行首独立展开箭头整块去掉：`expandProps.icon` 返回空，展开列只留 1px 占位（图标 `display:none`），行的展开/收起改由**组织名称**统一触发（分组行展开下级、单计划行展开 SKU 明细，与原来一致）；`aria-expanded` 仍挂在名称按钮上。
    - 名称样式：`rgb(var(--primary-6))` 蓝色 + `cursor: pointer`；前置 `organizationCaret` 小三角随展开态切换（收起 ›、展开 ⌄），不再新增控件列。
    - 踩到的坑：Arco 计算固定列偏移时用 `px2Number(宽度) || 40`，展开列宽度给 0 会被当成 40，导致左侧固定列压掉后面 40px（表现为「¥50,000.00」显示成「0,000.00」、「月度目标」显示成「度目标」）。改成 `width: 1` 后偏移恢复为 1px，表格不再被切。
  - 验收：`tests/stage-lane-web.test.mjs`、`tests/editable-input-style-web.test.mjs`、`tests/progress-column-web.test.mjs`、`v16-web`、`role-visible-permission-web` 等 14 项回归全绿（这些用例本来就是点组织名称展开，改名后仍通过）；**真机客户端验收未做**，#10 暂不打勾。
  - 待办：改完需同步固化到规则包（本轮先记）。

- [ ] **#12 报错信息业务化，不出现技术错误码与字段名** — 工程直改（建议同步固化）
  - 现象：弹窗直接显示 `GEA_HTTP_409`、`payload.plan_month`。对客红线：给业务的输出不出现接口、字段名、参数名、错误码。
  - 要做：失败提示改业务语言（如「退回未成功，请稍后重试；如持续失败请联系系统管理员」）；技术细节只进日志；如需用户协助定位，给可口头转述的「错误编号」，不暴露字段名；全站同类提示（提交、暂存、查询失败、导出）一起排查。
  - 代码落点：`models/salesPlanActionModel.ts:122`（`classifySalesPlanActionError`，已把 HTTP 状态映射成业务语义），需确认弹窗展示层没有回落成原始错误文案。
  - 规则包：固化对客错误提示口径。
  - 已做（2026-09-21，本地 Web 实测）：
    - **根因**：Host 把上游报错拼成 `GEA_HTTP_409：payload.plan_month 为必填字段` 放进 RPC message，客户端 `BackendHttpError.backendMessage` 原样保留；动作弹窗此前优先展示这串原文，所以直接漏给业务。
    - 动作弹窗（退回 / 通过 两种形态的两处相同代码）统一走 `actionErrorText`：后端原文只有「像业务话术」时才透出（`businessSafeErrorMessage`：出现 `payload.` / `GEA_HTTP` / 大写下划线错误码 / `为必填字段` / `null`、`undefined` / 链接 / JSON 痕迹 / 超 80 字，一律判定为技术文案），否则换成按 HTTP 语义的业务文案。
    - 判定为技术文案时另给 6 位**错误编号**（`reportSalesPlanError`）：「（错误编号：XXXXXX，可将编号告知系统管理员）」；同一编号与控制台 `[gea-error] …` 日志一起落地，管理员按编号即可核对。
    - 样例（fixture）弹窗的失败文案也从「本地样例操作失败（{{code}}）」改成不带 code 的业务话术，code 只进控制台。
    - 全站同类提示排查：查询失败（`query.errors.*`）、纠偏列表/提交失败、重提交回执、SKU 明细读取失败、暂存失败（#01）本来就是业务文案，本轮未发现其它泄露点。
  - 验收：新增 `tests/error-copy.test.mjs`（技术文案一律不透明、业务话术正常透出、错误编号格式与日志一致）与 `tests/action-error-copy-web.test.mjs`（退回弹窗与直接「通过」失败两条路径：界面不含 `payload` / `plan_month` / `GEA_HTTP` / `NOTIFICATION_PAYLOAD_INVALID` / `必填字段`，且能拿到同一个错误编号）；相关 17 项回归全绿。**真机客户端验收未做**，#12 暂不打勾。
  - 待办：改完需同步固化到规则包「对客错误提示口径」（本轮先记）。

- [ ] **#14 差额正负配色改为「正数红、负数绿」** — 工程直改（建议同步固化）
  - 要做：差额正数红、负数绿（现在是反过来）；颜色只作用于差额数值；队列内其他差额展示位同规则；正负号保留。
  - 代码落点：`RegionalApprovalWorkbench.tsx:939`（差额计算 `amountGap`）与指标卡渲染。
  - 待确认：D24（差额「正红负绿」与达成率阈值配色是否两套口径）。

- [ ] **#15 品类行出现英文提示（文案未翻译）** — 前端 + 后端（**根因已定位**）
  - 现象：品类子行「计划金额 / 目标金额」列显示 `common.assistantSurface.regionalApproval.categoryRows.targetAmount`，同格还并列「计划金额 ¥849.60」。
  - 已定位根因：代码在 `RegionalApprovalWorkbench.tsx:1795` 调用了 `t('common.assistantSurface.regionalApproval.categoryRows.targetAmount')`，但两个语言文件的 `categoryRows` 段里**都没有 `targetAmount` 这个 key**，i18n 找不到就把 key 原样吐出来。实测两个文件的差异：
    - `zh-CN.json:987`：缺 `targetAmount`（已有 `planAmount`、`baseAmount`、`amountProgress` 等）
    - `en-US.json:987`：缺 `targetAmount`，**另外还缺 `planAmount`**（第二处隐藏缺口，英文环境下会一起漏出来）
  - 要做：补 `targetAmount` 中英文文案；排查同一组件其他未翻译文案（相邻字段、悬停提示、空态）；对全站用户可见文案扫一遍。
  - 代码落点：`src/workbench/original/zh-CN.json:987`、`src/workbench/original/en-US.json:987`、`RegionalApprovalWorkbench.tsx:1783`。
  - 待确认：D28（品类子行该列到底展示什么：仅达成率 / 目标金额 + 达成率 / 计划金额 + 达成率），决定单元格内容。
  - 规则包：对客文案不得出现内部标识。

- [ ] **#16 组织名称列宽可调整，默认宽度减少 20%** — 工程直改
  - 要做：组织名称列支持拖拽调宽（表头右侧拖拽手柄 + 左右箭头光标）；默认宽度在当前基础上减 20%，腾出的空间按比例给金额类列；列宽在同一次会话内记忆；名称过长折行不截断。
  - 代码落点：`RegionalApprovalWorkbench.tsx:1808`（`columns.organization`，当前 `width: 220`）。
  - 待确认：D25（会话内记忆 / 按用户持久保存 / 不记忆）。

- [ ] **#17 打开品类维度开关时不应自动展开品类** — 工程直改（建议同步固化）
  - 现象：打开「品类维度」后队列直接把组织行换成品类行，用户还没指定下钻哪个组织。
  - 要做：开关只改视图能力，不自动展开任何组织；组织行保持收起；关开关时恢复收起态、不保留上次展开状态。
  - 代码落点：`RegionalApprovalWorkbench.tsx:660`（`categoryComparison` 影响行数据的 useMemo）、开关渲染区。
  - 备注：与 #18 同源，建议一并修。

- [ ] **#18 品类维度下点击组织应展开品类层，而非直达 SKU 明细** — 工程直改
  - 要做：开关开启时点组织 → 先展开品类列表（一行一品类，显示 SKU 数与汇总金额）；再点品类行 → 展开该品类 SKU；层级用缩进 + 行高递进体现；开关关闭时点组织仍直达 SKU 明细（保持现状）。
  - 代码落点：`RegionalApprovalWorkbench.tsx:699`（`expandedLiveGroups`）、`aggregateRegionalApprovalLiveCategories`（`regionalApprovalQueryModel.ts:321`）。
  - 备注：与 #17 同源；V1.7 #11 已提方向，本轮细化为可验收规则。

### P2 —— 缺陷待排查

- [ ] **#07 SKU 编码未取到物料描述（跨三轮未闭环）** — 缺陷排查（后端 + 主数据）
  - 现象：部分物料（如 10005817、10004347）「物料描述」显示「未提供物料描述」，同表其他行正常（如“思念500g上海大馅馄饨三鲜(18袋)”）。
  - 要做：排查描述取值来源（主数据缺失 / 接口未下发 / 字段映射遗漏）并补齐；确实取不到的展示可指向的原因（如“主数据未维护”），不用「未提供物料描述」这种无指向占位；对当前批次全部 SKU 扫一遍，输出缺失清单给业务核实。
  - 代码落点：`src/workbench/original/contracts.ts:124`（`materialDescription?: string | null`）、SKU 明细表「物料描述」列渲染。
  - 备注：V1.6 #07 → V1.7 #13 → 本轮，连续三轮未闭环，建议立专项，不再逐轮补提；V1.7 判断为“接口未下发”，本轮证据显示要按行复核。

## 三、待确认项（D21–D28）

这些是产品或业务要先拍板的，拍完才能定实现细节。括号内为文档推荐值。

| 编号 | 事项 | 选项 | 影响 |
| --- | --- | --- | --- |
| D21 | #01 暂存失败提示的展示方式 | 输入框旁就地提示（推荐）/ 保留表头但自动滚动到出错行 / 两者并存 | 提示组件改造范围 |
| D22 | #05 收起态展示的节点口径 | 当前登录用户所属审批节点（推荐）/ 当前查看的节点 / 已推进到的最末节点 | 首屏信息，与无角色场景联动 |
| D23 | #09 达成率进度条阈值配色 | <95% 红 / 95–100% 橙 / ≥100% 绿（推荐）/ 单色品牌红 / 不按阈值着色 | 一列配色规则，需业务确认分档 |
| D24 | #14 差额配色与达成率警示色的关系 | 两套口径独立（推荐）/ 全站统一一套 | 统一则要重新定义达成率警示表达 |
| D25 | #16 列宽调整的记忆范围 | 同一次会话内记忆（推荐）/ 按用户持久保存 / 不记忆 | 持久化要后端支持用户偏好存储 |
| D26 | #10 组织名称可点击的提示方式 | 蓝色 + 悬停手型（推荐）/ 前置静态小三角 / 「展开」文字按钮 | 队列行视觉密度 |
| D27 | #13 未改动节点的展示口径 | 展示上一节点已确认值、未改动时原样继承（推荐）/ 其他 | 不影响 #13 缺陷本身，只定“未改动时”口径 |
| D28 | #15 品类子行该列展示口径 | 仅展示达成率（推荐，与组织行一致）/ 目标金额 + 达成率 / 计划金额 + 达成率 | 决定单元格内容，消除两个金额并列的歧义 |

## 四、需要别人配合的部分

| 需要谁 | 事项 | 卡点 |
| --- | --- | --- |
| 后端 | #11 退回接口 `plan_month` 必填校验；单条 / 批量退回校验一致性 | 不解决就退回不了，P0 |
| 后端 | #13 节点调整值落库与下游节点取值来源 | 不解决审批人看到的就是错的数，P0 |
| 后端 + 主数据 | #07 物料描述按行复核缺失清单 | 连续三轮未闭环 |
| 产品 / 业务 | D21–D28 八项拍板 | #01 #05 #09 #10 #13 #14 #15 #16 的实现细节都挂在这上面 |
| 规则包维护 | #05 #08 #10 #12 #14 #17 改完后同步固化 | 改完代码不等于固化完成 |

## 五、建议推进顺序

1. **先做 #11 / #13**（P0，卡住审批主流程与数值判断），#11 需要后端先给接口口径。
2. **再清 P1 里零依赖的直改**：#03 #04 #06 #08 #09 #02（这批互不干扰，可以一起改一起回归）。
3. **接着做交互类**：#05 #10 #16 #17 + #18（#17/#18 同源，一次改完一起回归开关开 / 关两条路径）。
4. **最后做文案与提示类**：#15（先补 key，D28 定了再定该列内容）、#12（统一错误提示映射，涉及面广，放最后避免和前面的改动互相干扰）。
5. **#07 单独立专项**，走主数据核对，不占本轮发布节奏。
6. 待 D21–D28 确认后，把 #05 #08 #10 #12 #14 #17 同步进规则包。

## 六、边界与提醒

### 补充修复（2026-09-21，清单外，业务现场提出）

- **队列条数与分页口径改为「外层组织行」**：原来页脚「共 N 条」和分页器按**计划条数**算，而列表显示的是**分组后的组织行**（例如 26 份计划分成 6 个大区行，页脚却写「共 28 条 / 2 页」，第 2 页还会把同一大区的计划拆一段出来重复显示，行上的「N 份计划」也跟着被截断）。
  - 改法：取数改为把每个 (期间, 状态) 分区的**完整集合**取回（单页 200 条循环补齐，并按 planId 去重），分组后按**外层行**切页；页脚、分页器、导出页脚、助手上下文里的 `pagination.total` 全部改成外层行数；每页条数从此表示「每页多少个组织行」。
  - 「当前页明细汇总」口径保持“当前页”：仍然只统计当前页组织行覆盖的那些计划（不是全量）。
  - 同时修掉一个被这次改动暴露的老问题：品类汇总请求被中断时不会复位加载态，会让表格一直压在加载遮罩上（现在只有最后一次请求能复位；分页分组也不再依赖版本汇总，避免 effect 自触发）。
  - 实测：大区维度 6 行 → 「共 6 条 / 1 页」；按客户维度 28 行 → 「共 28 条 / 2 页，每页 20 行」，组内「N 份计划」不再被拆页。

- **业务待办不再把内部标识露给业务**（列表 + 详情）：原来列表「业务类型」直接显示 `sales_forecast`，详情「来源」显示 `sales_plan.approval_required`、「关联业务标识」和「来源引用」显示 UUID，消息内容上方写着「去审批 AGENT · sales_forecast」，更多信息里是 `approval`。
  - 根因：上游通知接口把业务类型、通知类型、来源、跳转目标都按内部编码下发（见 `docs/notification-user-api-research-2026-09-16.md`：业务类型只用于展示/筛选，没有可读名称），页面把这些字段原样渲染，`aggregate_id` / `source.ref` 这类 UUID 也一起露了出来。
  - 改法（纯前端，`src/client/inbox.tsx` + `src/client/locales.ts` + `src/client/shell.css`）：加一张业务名称映射表，`sales_forecast`/`sales_plan` → 「销售计划」、`approval` → 「审批通知」、`sales_plan.approval_required` → 「销售计划审批」；没登记的编码一律降级成通用说法（业务待办 / 通知 / 业务系统），只有服务端给的可读文案才原样展示；消息内容上方的跳转提示只留业务可读部分（`AGENT` 这类技术类型不再显示）。
  - 后续按业务要求再收一次（2026-09-21，同一现场）：详情顶部的「关联业务标识」行、以及整个「更多信息」折叠块（通知类型 / 有效期至 / 技术信息）**全部去掉**——业务只看来源、创建时间、当前状态、消息主题、消息内容；`aggregate_id`、`source.ref`、`kind`、`expires_at` 只在 Host 投影里保留，页面不再渲染。相关文案 key 和 CSS 一并清掉。
  - 实测：`tests/inbox-labels.test.mjs`（新增，断言列表/详情不出现编码和 UUID、详情里没有「更多信息 / 通知类型 / 有效期至」）；在 3198 的真实数据上核对：列表业务类型 = 销售计划，详情来源 = 销售计划审批，消息内容 = 去审批 销售计划，详情除来源/创建时间/当前状态/消息主题/消息内容外无其它字段。
  - 待办：真机客户端（0.0.76）验收未做，要发一版插件才能看到；映射表目前只覆盖已知编码，上游新增业务类型时要补登记。

- **侧栏菜单整体左对齐，二级条目与一级标题对齐**：原来二级条目比一级标题多缩进 16px（二级容器 28px + 条目 28px = 56px，而一级标题文字在 12px 内边距 + 18px 图标 + 10px 间距 = 40px），视觉上「二级比一级更往里」，和「二级只差一个图标」的预期不符。
  - 改法（`src/client/shell.css`）：二级容器不再额外缩进（`padding-left: 28px` → 0，命中区和一级标题同一条左边缘），二级条目自身 `padding-left: 28px` → `40px`，文字正好落在标题文字那条竖线上。
  - 实测：`tests/web.test.mjs` 增加断言（一级标题与所有二级条目的文字 x 相同、命中区 x 相同）；夹具页面实测一级/二级文字都在 x=66、命中区都在 x=26，之前二级是 82 / 54。

- 本文档只登记，不代表任何一项已完成；勾选需同时满足“代码已改”和“文档第六节的验收标准”。
- 源文档内部有一处不一致：变更概述写“18 项中 4 项为上一轮已提出但未闭环”，但随后列了 5 项（#05 #07 #15 #17 #18）。按 5 项理解，回头可以让提出人顺手修一下文档。
- 源文档共 18 项，其中 P0 2 项、P1 15 项、P2 1 项；文档正文分节里 P1 用的是“三、”，不含 #07（#07 在“四、P2”），编号连续无缺号。
- 本轮不新增数据字段。
- 本仓库同时维护 GEA 插件与公司客户端。这 18 项都属插件页面改动，默认只构建、验证、发布 GEA 插件，不动桌面客户端。

## 七、会被本轮改动打坏、需要同步更新的现有测试

改代码前先看这几处，不然回归会红：

| 测试文件 | 断言位置 | 影响项 | 说明 |
| --- | --- | --- | --- |
| `tests/detail-summary-web.test.mjs` | 第 55 行 `toContainText('金额 37.5%')` | #09 | 组织行达成率现在就是「金额 XX%」文案，改成进度条后这条断言必须重写 |
| `tests/detail-summary-web.test.mjs` | 第 65 行 `toContainText('金额 75.0%')` | #09 #15 | 品类行同一个文案；同时该用例会点开品类行，与 #17 / #18 的展开时机直接相关 |
| `tests/detail-summary-web.test.mjs` | 第 58–66 行：切开关 → 点 `regional-approval-category-row-p-汤圆` → 期望 SKU 展开 | #17 #18 | 现在用例默认「开关一开品类行就在」，与 #17「开关不自动展开」冲突，需按新交互重写 |
| `tests/correction-web.test.mjs` | 第 114 行 `getByText('金额 50.00%')` | #09 | 同一套达成率文案，需同步改 |
| `tests/progress-display.test.mjs` | 整个用例渲染 `RegionalApprovalLiveProgress` 并校验 `progressDialog.*` 文案 | #12 | 错误 / 状态提示业务化后，这里要跟着更新 |
| `tests/v16-visual.test.mjs` | 紧凑表头、进度、内联 SKU、抽屉、私有草稿的视觉回归 | #02 #04 #05 | 视觉改动会让该用例截图基线变化 |
| `tests/inline-scroll.test.mjs` | SKU 区内部滚动后交还父级滚动 | #01 | 提示改到输入框旁会增加行高，可能影响滚动断言 |

建议：每改一项，先跑最近的用例（`node --test tests/detail-summary-web.test.mjs` 这类），确认是"断言过时"还是"改错了"。
