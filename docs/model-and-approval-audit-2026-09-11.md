# 正式环境模型与审批范围核对

## 模型

登录后调用 GEA 个人凭证与模型列表接口；原生 DSH 模型目录列出实际返回的模型。优先选择部署配置中仍然存在的模型，否则选择接口返回的第一个模型，并更新 DSH 默认选择。准备分析时重新核对当前登录下的模型，凭证不会返回浏览器。页面上的“已获取模型”只代表发现成功，不代表推理验收。

2026-09-11 正式环境返回模型 `2075867101766672385`，原先固定配置为 `2085162185715609601`。真实 DSH 会话 `session-990de108-cbc5-445e-905c-546580cb50a8` 通过 `gea-analysis` 返回“GEA 模型连接成功。”，Session 日志记录模型 `2075867101766672385`，`turn/end.reason.kind=completed`。此证据证明最小文本推理链路，不替代完整业务分析或 Agent 工具验收；脱敏日志保存在忽略的 `.runtime/model-live-evidence.json`。

## 审批范围

同次正式登录在租户 0 下，无月份、类型、状态筛选查询 `/sales-plan/plans?pageNo=1&pageSize=1000`，接口返回 `total=4`、`pages=1`、`size=200`：3 条状态 1、1 条状态 5，均为 Y 计划。周期接口返回 1 个周期。200 是服务器分页上限，不是浏览器丢弃了后续记录。

已对照本机 AionUi/AionCore 源码：AionUi 请求 `/api/gea/sales-plan/plans`，AionCore 转发到同一 GEA `/sales-plan/plans`，携带当前用户凭证和租户信息。插件使用同一路径和身份头。

本机 GEA 后端源码的 `SalesPlanController.page` 调用 `SalesPlanQueryApplicationService.page` 和 `SalesPlanDocMapper.selectWorkbench`，查询 `plan_doc`，要求租户匹配、`is_effective=1`、`is_deleted=0`，并应用 `SalesPlanDataScopeResolver` 的组织/客户权限。源码解释接口范围，但本次未验证正式部署的后端提交版本或读取数据库，不能据此断言缺失记录的具体原因。

待补充一条正式环境中应显示的审批编号或截图，核对其审批类型、租户、当前有效版本、组织权限与接口返回。不得通过改租户或绕过权限制造更多记录。当前销售计划工作台不等于所有审批或通用消息待办。

## 检查

构建、类型检查和 51 项回归通过；模型回归覆盖配置模型已失效时改用实际返回模型，及流式完成、截断、取消、切换环境中断。原生模型目录的真实查询返回正式模型且没有 provider failure。
