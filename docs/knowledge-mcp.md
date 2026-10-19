# 知识 MCP 接入

GEA Host 沿 [执行链](execution-logic.md) 持有唯一登录身份、当前业务 Session、委托凭据与 MCP 传输。Manage 通过既有 GEA 工具接口注册服务端授权 Schema，Core 持有实际 Session。工具调用从当前业务 preset 解析 Agent Consumer，不切换为示例客户端身份。

## 目录与问答

仅接纳 MCP 来源 `mcp.weknora` 的 `weknora_list_knowledge_bases` 与 `weknora_ask`。Cube 使用其独立来源配置及结果合同；知识工具不受 Cube 是否配置影响。

目录调用使用空 arguments。GEA 在每次问答发送前读取当前身份与 Consumer 下的实时目录，只保留具备 ASK 动作的 GEA 知识库 ID，并一次校验全部目标。任一目标不可用时返回当前目录，要求重新选择；同名知识库也不自动替换 ID。空目录、发现失败或执行归属变化时不发送问答。目录不落盘、不跨次复用，健康连接继续使用。最终人员、Consumer、同实例和空间授权仍由服务端判断。

问答的 query 是1至4000字符的完整问题；knowledgeBaseIds 是1至20个不重复的 GEA ID。Agent 根据当前对话补齐追问语义；客户端不把上一轮聊天当作 WeKnora 已持有的上下文。业务参数不传用户、登录凭据、Consumer、租户或 Session。

响应优先消费 structuredContent；没有结构化结果时只解析一份业务 JSON。目录允许数组，问答保留 COMPLETED、answer、references，以及响应提供的 requestId、traceId、auditId。工具成功 envelope 存在时须为 success=true/code=SUCCESS，并保留外层标识。引用必须归属本次选择的知识库。空目录、未完成答案、无效结构和异常引用不构造可信答案。

问答工具结果额外保留 `gatewayTrace`，只包含 HTTP 响应头中的 requestId、traceId、auditId。业务正文的原有标识保持原值；正文和引用不改写。失败或未完成响应的诊断也保留可用网关标识。目录成功结果继续使用原数组或原成功 envelope。

现有响应的 COMPLETED 只作为服务端原字段保留。GEA 在答案对象追加 `geaCompletion`，其 status 为 UNKNOWN，并说明尚未取得可验证的生成结束依据，不能报告完整成功。正文、引用及业务标识保持原值；客户端不按长度、句尾、引用数量或错误提示文字猜测完成状态。本次仅修改客户端，不声明服务端生成状态已经修复。

知识结果不进入 Cube 数据集解析，不调用 resources/read，不产生旧式可复用授权收据，也不做 LightRAG chunks 解码。长答案及完整引用按本次 MCP 接收预算保留，模型输出仍应说明来源与范围。

## 失败与生命周期

问答不自动重试。普通 HTTP 404 或明确会话失效时，GEA 只撤销失败执行所用且仍在缓存中的连接；迟到失败不清除并发建立的新连接。下次明确发起问题时按当前身份重新建连并读取目录。明确资源不存在或拒权保留业务错误，不因该错误反复建连；超时、限流和远程失败保持原语义。目录和 Cube 保留既有安全传输恢复。

非 2xx 正文按 MCP 接收预算且最多64 KiB读取，只接收已校验的业务码、短原因、重试信息与请求标识，并保留 HTTP 状态。无效、超限或不安全正文回退为 HTTP 失败；正文任意 details、HTML、堆栈和凭据不进入工具错误。HTTP 网关标识仍以 gateway 前缀区别于业务标识。

当前业务资源、实际 Agent Consumer、登录身份与取消信号在发送前后校验。退出、切用户、租户、环境、业务 preset 或资源停用后，迟到结果不能返回到新的执行；用户 Session、草稿与历史保持。

LightRAG 旧工具未注册、旧问答结果解码已删除，现行业务指引使用新知识工具；不存在旧库回退。冻结的历史记录与测试归档保留原件。知识依据不改变受控指标、公式、过滤条件或页面协议。

## 验证与外部条件

现有 Core Tools → Manage → GEA Host → 模拟 MCP 服务的验证位于 `tests/knowledge-mcp.test.mjs`，与当前 Cube、网关、Prompt 和 Manage 生命周期检查一起验证。它不调用真实服务，不证明安装启用、真实模型表现或知识迁移完成。

真实联调须确认具体环境、人员接入、实际 Agent Consumer、两个子工具与目标库 ASK 授权。2026-10-14 资料中的 test007、gea-client 和客户订单拒权均为历史观察，不作为当前授权。LightRAG 内容导出、WeKnora 内容迁入及完整性验收另行处理。

当前 DSH 的个人 Agent 沿其已保存且仍有效的来源关联取得实际 Consumer，再按服务端授权使用知识工具。关联停用、来源撤销与身份切换同时撤销知识调用；该关联不授予页面动作或业务写入。当前客户端联调输入与结果由本轮验证记录负责。
