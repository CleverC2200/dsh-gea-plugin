# GEA 原生只读工具与取消收尾

`gea_sales_plan_read` 通过 DSH `tools.register(defineTool(...))` 注册 periods、list、detail、versions、logs、versionSkus、compare 七种固定读取。工具不接受 URL、凭证或租户覆盖；GEA 根据当前 Host 身份决定数据可见性。查询与页面预览状态独立，模型补充读取不会使用户已经核对的预览失效。

结果包含环境、抓取时间、原查询、coverage 和精确 JSON。分页结果保留 total/current/size/pages，单页不足时标为 partial；明细类仍拒绝不完整数组、计划/版本身份不一致及超出输入预算的结果，不静默裁剪。原生工具卡展示 GEA 与查询种类；工具输入、输出和失败通过标准 Session 事件持久化。

GEA SSE 适配器仅接受本次请求已提供的工具名，拼接交错的调用参数，验证调用 ID 唯一、参数为 JSON 对象，并使用配置中的 maxSnapshotBytes 限制累计工具参数。仅在完整 tool_calls 结束后发布可执行调用；EOF、length、名称越权、重复 ID 或损坏参数不会成为可执行工具块。

取消原因由 Harness 用作 Session 的 turn/end 值。Node Fetch 会为抛出的对象原因添加不可枚举的 stack，破坏 Harness 对无损 JSON 的要求。transportSignal 使用传输层自有 AbortError 中继取消，保留原始原因不变；中继监听器在结束后释放。回归覆盖实际模型→工具→模型回路、403、非法查询字段、超限、超时和取消后的 turn/end，不以连接关闭替代 Session 完整性。

无密钥预期文件 `tests/fixtures/gea-agent-tools.snapshot.json` 在真实 dsh profile 测试中对比事件顺序、参数、分页结果与结束状态。它覆盖固定只读工具回路，不能替代消息待办、业务写入或生产 GEA 工具调用验收。

本轮在原运行进程完成正式汇总分析：Session `session-45bc6243-e7a1-4923-8315-0373c8683199`，模型 `2075867101766672385`，实际名称 liteLLM-deepseek-chat，首轮 completed。`verify --require-live` 核对了快照哈希与当前进程身份。该进程仍运行更新前的插件，不能把这条证据算作新工具实机验收。模型答案中“记录数相同所以不是明细缺失”的推断依据不足；新 persona 明确禁止这种推断，实际回答质量仍需后续复核。

正式页面已用浏览器确认原审批工作台、liteLLM-deepseek-chat 名称与原生输入框同时显示。再次读取四条正式计划详情均未返回 actionContext、allowedActions 或 snapshotHash；不能从可读状态推断写权限。本机参考后端的动作枚举仅 APPROVE/REJECT，与来源页面的 SAVE/修正协议不同，需确认正式写入能力和接口版本后接通。

发行包 0.0.2 的独立进程已完成正式工具验收：Session session-8919186e-2bc5-42fd-8e0e-3cef7315af65，模型 liteLLM-deepseek-chat，一次 gea_sales_plan_read 调用查询 list/pageNo=1/pageSize=1，返回 1 条、total=6、coverage=partial，tool/result 为成功，turn/end 为 completed。模型回答正确区分单页与全量。该进程与原进程显示的用户/租户一致；总数与早前 4 条不同，变化原因未归因。新版再次读取的详情仍无 actionContext。原始业务结果保留在忽略提交的运行目录中。

新版汇总 Session session-06ce53ae-2b8e-4f14-9b82-030eaccbf4f6 首轮通过 verify --require-live；第二轮按明确范围执行 versions 与 versionSkus 两次读取。versions 成功，完整 SKU 输出因 SNAPSHOT_TOO_LARGE 被拒绝，两轮均 completed。第二轮 completed 只表示交互结束，不表示 SKU 分析完成。模型仍将版本列表结果用于排除差异原因，依据不足，业务推理质量保持 partial；完整 SKU 输入、独立建议与业务写入均不计为已验收。

工具 status 参数允许周期接口的字符串状态与计划列表接口的整数状态，Host 按读取种类校验；整数计划状态的模型→工具→GEA 请求已纳入回归。
