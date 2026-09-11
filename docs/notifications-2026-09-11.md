# 消息待办只读接入

Host 使用当前登录身份读取固定的 `/api/v1/notifications` 和按 ID 定位的详情端点。分页只接受页码和状态过滤，不允许客户端提供 URL、租户或凭证。投影只包含页面字段，不透传 payload_projection、授权字段或任意来源 URL。列表保留 total、unread_count、返回数与覆盖范围；重复 ID、详情 ID 不一致及非法响应报错。

页面使用 DSH locale，显示 GEA 原始状态、类型、来源引用、关联业务标识及有效期。查看不标记已读，不审批或忽略消息，不改 DSH interaction 状态。GEA source.ref 的含义由来源系统决定，不能凭格式猜测本地 Session，因此来源会话跳转与处理历史仍未完成。

请求绑定当前身份，切换环境取消在途请求。HTTP 403 与 HTTP 200 的 NOTIFICATION_UNAUTHENTICATED 分别保留错误和登录失效；失败或刷新清空旧结果。列表与业务预览独立，读取消息不会使已核对的计划快照失效。审批页同时区分网络失败和请求超时文案。

`tests/notifications.test.mjs` 在真实 DSH profile 与 Chrome、模拟外部 GEA 下验证列表/详情、未读数、部分覆盖、字段投影、固定路由、重复记录、身份不符、403、空结果、登录过期和切换环境取消。原审批页由 tests/web.test.mjs 回归。此模拟证据不包含来源 Session 映射或写入验收。

正式环境 3201 独立进程已完成只读验收：两页 total=18、returned=18、unique=18，unread_count=3。真实浏览器第一页显示 10 行，可打开详情且无 pageerror；详情 ID 与请求一致，来源类型为 business_system。查询结果不包含来源会话映射，不能把来源引用解释成 DSH Session。原始截图及脱敏回执保留在忽略提交的 `.runtime/inbox-acceptance`，未执行标记已读或审批。

Session 页面回归增加浏览器 reload 后恢复原生回答的断言，已通过；新进程逐事件保留证据仍由 receipt.test.mjs 与源码安装验收提供。该恢复能力不等于 GEA 待办来源会话定位。
