# GEA 用户端 Notification API 对照笔记

日期：2026-09-16。本文只做接口理解与现有只读接入对照，不修改产品代码，也不把文档中的“本地代码和测试已完成”视为目标环境或生产验收。

## 结论

当前插件已经兼容用户端 API 的**只读子集**：以当前登录身份、固定租户头读取列表与详情，并展示 `unread`、`read`、`dismissed`。官方 v1.17 规范把“业务待办”和“消息中心”定义为同一份用户通知投影，并新增/明确了完整正文、业务类型、受控跳转目标、销售计划动作提示、CAS 状态变更、原子批量已读、审批动作桥、偏好和 SSE。

所以它不是“把现有列表端点换个 URL”就能完整接入：若要扩展，应先决定产品是否从只读范围升级；任何写操作都必须携带服务端返回的 `version` 与稳定幂等键，不能由前端猜权限、拼 URL 或把通知状态当作业务审批权限。

## 官方接口（当前文档 v1.17）

| 方法与路径 | 作用 | 当前插件 |
| --- | --- | --- |
| `GET /api/v1/notifications` | 列表；`state` 或 `states`、`eventType`、`pageNo`、`pageSize` | 已接入 `state`、`pageNo`；页面大小由 Host 固定 |
| `GET /api/v1/notifications/unread-count` | 当前用户未过期未读数 | 未单独调用；列表响应中的 `unread_count` 已展示 |
| `GET /api/v1/notifications/{id}` | 当前主体、当前可信租户可见的详情 | 已接入 |
| `POST /api/v1/notifications/{id}/read` | 单条标为已读；CAS 和命令幂等 | 未接入，打开详情不会标已读 |
| `POST /api/v1/notifications/batch-read` | 1–100 条原子已读；全批预校验、同事务 CAS | 未接入 |
| `POST /api/v1/notifications/{id}/dismiss` | 忽略；CAS 和命令幂等 | 未接入；官方文档同时登记服务端 `dismissible` 强制保护待补，不能仅靠前端隐藏按钮放开 |
| `POST /api/v1/notifications/{id}/approval-action` | `APPROVE` / `REJECT` / `TRANSFER` 的站内审批动作桥 | 未接入；现有销售计划仍经自身 action 端点办理 |
| `GET` / `PUT /api/v1/notification-preferences` | 查询/更新当前用户通知偏好 | 未接入 |
| `GET /api/v1/notifications/stream` | `text/event-stream`；通知失效提示 | 未接入；官方文档将其真实失败形状、断线回放和生产可用性列为待补证据 |

### 身份、租户与结果外壳

用户端接口的 `principal` 来自当前登录主体；调用者只能提供候选租户，服务端须与登录主体的 `relTenantIds` 求交。`X-Tenant-Id` 与查询参数 `tenantId` 至少提供一个；两者都有时文档称查询参数优先。请求体不能传 `tenant`、`principal`、`operator` 或收件人。

普通 JSON 端点使用 `Result<T>` 外壳：调用方同时检查 HTTP 状态和 `success` / `code` / `errorCode`，不能假定业务错误总有特定 HTTP 状态。示例使用现有登录凭据的 `Authorization: Bearer ...` 加 `X-Tenant-Id`。本插件当前请求使用 `X-Access-Token`、`X-Tenant-Id` 和 `X-Request-Id`；租户头的语义相符，但 token 头是否被该 v1.17 服务基线接受，需要真实登录态联调确认，不能从文档或现有模拟回归推断。

### 数据与状态语义

- 状态只有 `unread`、`read`、`dismissed`。允许 `unread -> read/dismissed`、`read -> dismissed`；`dismissed` 终态。业务系统关闭待办也会置为 `dismissed`，无需客户端另造第四种状态。
- 列表按 `COALESCE(notified_at, created_at) DESC, id DESC` 排序；同一业务待办刷新后回到前面并重置为 `unread`。`unread_count` 不计已经过期的记录。
- 列表/详情可含 `content`（完整纯文本，历史数据回退 `summary`）、`business_type`、`notified_at`、`version`、`dismissible`、`interaction_request_id`、受控的 `target`、`approval`、以及销售计划的 `action_type` / `action_text`。其中业务类型仅用于展示/筛选，不是授权依据；动作文字不是 URL；`target` 不能由通知 payload 拼装。
- 详情另可提供白名单 `payload_projection` 和 `allowed_actions`。它们是服务端返回的详情数据，不是让客户端自行推导权限的依据。

### 写入与实时规则（仅为后续设计保留）

`read` / `dismiss` 的非终态改变必须带等于当前 `version` 的 `expectedVersion` 和非空稳定 `idempotencyKey`（snake_case 同样兼容）。网络结果未知时只能以**相同键、相同正文**重试；版本冲突要重新读详情，不得换键盲重试。`batch-read` 对整个批次预校验并原子提交，任意一项归属、状态或版本不符会整批回滚。

`notification.changed` SSE 只是一条失效信号：收到 `connected` 时刷新列表和未读数；收到变更时同样刷新，必要时再读该 ID 的详情。文档明确没有 SSE ID、`Last-Event-ID`、缓存或回放保证，因此重连不是补齐漏事件的证明。

## 与当前仓库的差异

| 对照点 | 现有实现 | 差异/含义 |
| --- | --- | --- |
| 读路径和身份 | Host 固定请求 `GET /api/v1/notifications` 或 `/.../{id}`，绑定当前认证身份与 `X-Tenant-Id`，浏览器不能自带 URL、租户或凭据 | 符合“主体由服务端决定、客户端不自报身份”的方向；token 传递头尚待实机确认 |
| 查询能力 | 仅允许 `pageNo`、单值 `state`、`id`；Host 设定 `pageSize` | 尚未透出 `states` 多选、`eventType`、调用方 pageSize、独立未读数 |
| 字段投影 | 仅向页面投影 ID、标题、摘要/兼容 `body`、状态、种类、事件类型、聚合 ID、时间和来源 | 未投影官方 `content`、版本、业务类型/通知时间、目标、动作、审批、Interaction Request 和详情 `allowed_actions`；当前文档也有意不透传 `payload_projection` |
| 状态操作 | 查看、刷新、筛选完全只读；详情不会标已读或审批 | 与当前产品边界一致；未实现 CAS、幂等键、回执或批量原子语义 |
| 销售计划 | Host 可把新鲜、可操作的通知当作任务发现证据，但角色审批仍要经过当前服务端授权/快照校验 | 不应把通知、通知状态或 `allowed_actions` 直接当销售计划角色权限；官方的通知审批桥也不能取代现有销售计划 action 契约 |
| 实时与偏好 | 无 SSE、无偏好 API | 若未来启用 SSE，必须做权威重读而非直接套事件 payload；偏好写入是独立产品范围 |

现有代码对异常 `Result` 已检查 `success`，并对 `NOTIFICATION_*` 错误码做特化处理；但它只覆盖当前只读流程。当前项目的说明和浏览器测试也明确写出“查看不标记已读、不审批或忽略”。

## 不可确认项与下一步

1. 官方页面的状态是“服务端源码和本地自动化测试完成，客户端联调、真实登录态、长连接、环境通知配置、部署和上线待完成”。因此文档不能证明本插件当前目标环境已部署 v1.17，也不能证明 SSE 可用。
2. 官方示例的认证头为 `Authorization: Bearer`，本插件当前使用 `X-Access-Token`。必须在不改变通知状态的真实登录态下读取列表/详情，才能确认兼容性；不能从测试夹具推断。
3. `dismiss` 的服务端强制 `dismissible` 校验仍被官方列为待补证据。即使产品决定增加忽略按钮，也应等该后端保护与直接测试补齐后再开放。
4. 若要从只读升级，推荐先做一份单独的写入设计：明确哪些动作进入插件、详情 `version` 的缓存与失效、幂等键生命周期、冲突后的用户交互、审批桥与销售计划 action 的边界，再做模拟和真实环境验收；本笔记不是实施授权。

## 来源与仓库证据

- [GEA 用户端 Notification 与通知中心 API 接入规范（v1.17，2026-09-16）](https://gea.synear.cn/docs/integration/capabilities/notification-user)：本文所有上游接口、字段、状态和待补证据的唯一外部来源。
- [现有通知接入说明](notifications-2026-09-11.md)：当前只读产品范围与既有模拟/浏览器证据。
- [Host 通知读取实现](/Users/synear/Documents/ChatGPT/dsh-gea-plugin/src/host/business.ts:924)、[安全字段投影](/Users/synear/Documents/ChatGPT/dsh-gea-plugin/src/shared/notifications.ts:38)、[浏览器收件箱](/Users/synear/Documents/ChatGPT/dsh-gea-plugin/src/client/inbox.tsx:197)：本次对照的本仓库一手证据。

已办：阅读官方 v1.17 页面，核对当前 Host、投影、页面、测试说明，形成上述只读差异表。待办：只有在产品决定扩展范围后，才需要协议设计、实现与真实环境验收。
