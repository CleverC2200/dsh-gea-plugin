# GEA 模型思考接入

GEA 插件在客户端工具模式中消费网关的 SSE `reasoning_content`，使用官方 DSH 的独立 `reasoning-delta` 与 `reasoning` 块。答案仍使用 text 块，思考不进入答案或工具结果。请求显式声明 `gea_tool_execution_mode: client`；原模型、Agent、身份、授权与推理档位选择保持原归属。

流式原文按请求累积，保留空白、换行和 UTF-8 分片；没有思考不生成占位块。续轮按 Core 提供的历史，从同一 assistant 的 reasoning 块读取原文，传入 `messages[].reasoning_content`，不依赖插件私有的完成标记。Core 已有展示、流记录和持久化协议，不新增独立思考数据库或修改 Core。

取消、错误和断流保留原有失败/部分状态，半成品工具不执行。历史没有思考时允许正常续轮，不以缺失字段推断遗失。原来丢弃的思考无法补回。客户端不按固定字符数截断或拒绝完整思考，也不把业务快照字节预算用于模型工具参数。当前路由提供的容量通过模型 `context.contextWindow` 交给 Core；未知容量保持未知。明确的 HTTP/SSE 上下文超限使用官方 `CONTEXT_WINDOW_EXCEEDED` 类别，压力压缩与溢出恢复沿用 Core 的条件和次数。认证、限流、普通服务失败不进入上下文恢复。

当前适配器仅请求 SSE 单 choice。多 choice 返回明确拒绝，不串联不同答案；非流式与平台托管工具未新增入口。公开历史回传的 Provider、模型范围和授权由网关校验，不按客户端显示名猜测支持，不自动删字段、换身份或换模型绕过拒绝。

普通生成允许纯思考 stop 完成，真正空响应继续失败。max-tokens 保留已经生成的文字与思考，响应中的完整和不完整工具均不执行；下一轮可回传已保存的文字与思考，原轮次仍保持 max-tokens 状态。合法 finish 后等待 DONE 或 EOF，期间继续采集 usage；没有终止时由现有空闲机制管理，心跳继续续期。

非法工具参数在正常工具完成时使整组失败，不再把宿主生成的纠错提示写成模型答案或执行同组中的部分工具。流诊断保留安全错误码/类型、字节长度，移除原响应帧、网关 message 和工具参数尾部；思考原文仅留在原会话的受控历史中。

## 验证

- `node --test tests/gea-stream.test.mjs tests/gea-messages.test.mjs tests/gea-reasoning.test.mjs` 验证解析、历史回传、截断后恢复续轮和失败边界。
- `node --test tests/gea-model-context.test.mjs tests/gea-model-idle.test.mjs tests/gea-model-core.test.mjs tests/model-http.test.mjs` 验证真实 LlmRuntime 容量、Adapter 空闲/终止协议，以及实际 Core Session 的压力压缩、溢出恢复次数、取消、max-tokens 和工具派发。Core 入口复用同组 Manage 的预设夹具与公开 SDK，只替换外部 HTTP 服务；现有 `tests/*.test.mjs` 会执行该入口。
- `tests/gea-reasoning-profile.test.mjs` 用冻结三仓与官方 Core 启动临时 profile。三插件为真实源码编译资产，外部 GEA/模型服务与可选增强是夹具，覆盖真实只读工具续轮及进程重启后的历史回传。输入由 `GEA_REASONING_INTEGRATION_INPUT` 指定，同次候选通过 `GEA_TEST_CANDIDATE` 固定。

以上离线验证不证明供应商或服务端部署成功。用户已确认管理端新构建尚未发布，因此本批不访问管理端、不做真实模型验收、不把预计拒绝当作客户端故障。待服务端发布后，用原有基地库存 Agent 和 GEA personal model 验收模型实际思考、下一轮请求、工具结果和重启恢复，再确认可对外使用。
