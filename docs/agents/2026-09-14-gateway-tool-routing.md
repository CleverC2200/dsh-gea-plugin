# GEA MCP 工具路由

网关的 tools/list 通过每个工具的 `_meta.sourceCode` 提供服务编码，tools/call 从 `params._meta.mcpCode` 读取该编码。GEA 0.0.3 注入登录身份时未传递路由，内置工具因缺少 `mcp.gateway.session` 被拒绝。

GEA 0.0.4 在登录所属 fetch 中读取 JSON/SSE 发现结果，按工具名保存路由并附加到调用元数据。分页累积映射，新的第一页替换旧映射；未知、缺失和歧义路由拒绝执行。调用方无法覆盖身份或路由。DSH 核心、公共工作台及 Agent Manage 无需为该修复改动。

回归覆盖内置与远端工具、伪造元数据、SSE 响应保留、分页与刷新，以及登出后的旧连接失效。桌面插件图测试覆盖构建产物中的发现、实际调用与退出清理。
