# 从 AionUi 获取模型配置

设置 `analysis.source` 为 `aionui`，并指定正在运行的 AionCore 本机 `backendUrl`、已启用的个人模型 `providerId` 和 `model`。完整字段见 `gea.aionui.example.json`。`contextWindow` 是部署声明的容量，示例值不是模型目录认证的上下文上限。

启动器从 `GET /api/providers` 读取所选 provider，并通过它的本机 `/models` 验证模型当前可用。启动器只接受 `127.0.0.1` 的 HTTP 后端和 `/personal/<providerId>` 模型代理。失效、禁用、缺失模型或不受支持的地址会使启动失败。直接连接模式仍只接受 HTTPS。

AionUi 管理真实模型凭证、用户登录和 `X-GEA-Agent-Code` 路由。插件仅把 AionUi 提供的本机代理凭证保存在进程内存中，不读取加密凭证库、不重新领取上游密钥、不复制 GEA 登录令牌。dsh 子进程通过环境变量获得本次本机连接的随机凭证，生成的 profile patch 和普通配置文件不包含凭证。

当前 GEA 网关要求 `messages[].content` 为字符串；dsh 通用适配器使用文本块数组。本地兼容层只将纯文本块按原顺序无分隔拼接，拒绝非文本内容和工具请求，并原样转发 SSE 字节。HTTP 200 的非 SSE 响应被明确拒绝。模型消息、流解析、取消及持久化继续由 dsh 的 `llm-pi-ai` 和标准 Session 负责。

保持 AionUi 运行并登录。AionUi 重启或切换环境后代理可能变更或失效；重新确认后端端口和 provider，再重启插件以读取新配置。不会自动切换另一个 provider 或模型。

2026-09-10 验证：AionUi 模型通过标准 dsh Session 完成测试 GEA 的真实单计划分析，首轮约 74 秒，结束原因是 `completed`，助手消息未标记中断；同会话追问也正常完成。独立磁盘读回验证了预览快照的 SHA-256，当前进程、登录状态及环境来源均匹配。该证据证明单计划链路，不代表全部 Issue 或全量 SKU 验收完成；详细范围及剩余项见 [验收记录](acceptance-2026-09-10.md)。
