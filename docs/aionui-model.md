# 从 AionUi 获取模型配置

设置 `analysis.source` 为 `aionui`，并指定正在运行的 AionCore 本机 `backendUrl`、已启用的个人模型 `providerId` 和 `model`。完整字段见 `gea.aionui.example.json`。`contextWindow` 是部署声明的容量，示例值不是模型目录认证的上下文上限。

启动器从 `GET /api/providers` 读取所选 provider，并通过它的本机 `/models` 验证模型当前可用。启动器只接受 `127.0.0.1` 的 HTTP 后端和 `/personal/<providerId>` 模型代理。失效、禁用、缺失模型或不受支持的地址会使启动失败。直接连接模式仍只接受 HTTPS。

AionUi 管理真实模型凭证、用户登录和 `X-GEA-Agent-Code` 路由。插件仅把 AionUi 提供的本机代理凭证保存在进程内存中，不读取加密凭证库、不重新领取上游密钥、不复制 GEA 登录令牌。dsh 子进程通过环境变量获得本次本机连接的随机凭证，生成的 profile patch 和普通配置文件不包含凭证。

当前 GEA 网关要求 `messages[].content` 为字符串；dsh 通用适配器使用文本块数组。本地兼容层只将纯文本块按原顺序无分隔拼接，拒绝非文本内容和工具请求，并原样转发 SSE 字节。HTTP 200 的非 SSE 响应被明确拒绝。模型消息、流解析、取消及持久化继续由 dsh 的 `llm-pi-ai` 和标准 Session 负责。

保持 AionUi 运行并登录。AionUi 重启或切换环境后代理可能变更或失效；重新确认后端端口和 provider，再重启插件以读取新配置。不会自动切换另一个 provider 或模型。

2026-09-10 验证：当前 AionUi 两个启用模型均能完成最小请求；通过兼容层的标准 dsh Session 最小真实调用产生一条助手回答，并以 `turn/end.reason.kind=completed` 持久化。较长销售计划快照在本次限定等待时间内未取得完成记录，仍未通过真实业务分析验收。测试 GEA 真实记录、版本、SKU 和真实模型的整合验收也保持未完成。
