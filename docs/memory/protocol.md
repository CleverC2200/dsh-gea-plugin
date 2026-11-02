# 个人记忆网关合同

可执行响应类型位于 `src/shared/memory-contract.ts`。网关以 POST `/v1/memory/<endpoint>` 接收 JSON，成功返回 `{success:true,result}`，失败返回 `{success:false,errorCode}`。Host 浏览器入口为 POST `/api/gea-proof/memory/<endpoint>`，沿用 `{ok,value/error}`。仅 Host 向固定网关发送 `X-Access-Token` 与 `X-GEA-Environment`。网关按固定环境在线校验 `/sys/user/getUserInfo`；请求体不得含 scope、用户、租户、bank、URI 或任意转发地址。

普通客户端的 Host schema 与部署解析共用公司 HTTPS 默认入口，定义在 `src/shared/memory-gateway.js`。缺省配置仅在读取时补齐，已有 `gea.config.json` 不会被重写。显式自定义 URL 优先，空 URL 保持禁用；私网 HTTP 仍需显式开启。Desktop 将已安装的 `dsh-personal-memory` 沿现有可选插件流程装配，禁用选择继续保存在原 optional state。

| endpoint   | 请求                                                                                   | 响应                            |
| ---------- | -------------------------------------------------------------------------------------- | ------------------------------- |
| state      | `{}`                                                                                   | MemoryState                     |
| list       | `{query?:string,category?:background/preference/habit}`                                | `{scope,state,items}`           |
| get        | `{id}`                                                                                 | `{scope,item}`                  |
| settings   | `{generationEnabled,expectedRevision,operationId}`                                     | MemoryOperation                 |
| recall     | `{query}`                                                                              | `{scope,memories:MemoryItem[]}` |
| generate   | `{operationId,expectedRevision,bankGeneration,source:{sessionId,messageId,time},text}` | MemoryOperation                 |
| update     | `{id,category,content,expectedVersion,expectedRevision,bankGeneration,operationId}`    | MemoryOperation                 |
| delete     | `{id,expectedVersion,expectedRevision,bankGeneration,operationId}`                     | MemoryOperation                 |
| clear      | `{confirmation:"清空",expectedRevision,bankGeneration,operationId}`                    | MemoryOperation                 |
| source     | Host 浏览器路由 `{id}`，公司网关无此入口                                               | `{scope,sessionId}`             |
| operations | `{operationId}`                                                                        | MemoryOperation                 |

scope 为 `{environment,tenantId,userId}`。state 为 `{scope,generationEnabled,revision,bankGeneration,count,updatedAt,pendingCleanup?}`，其中 pendingCleanup 为 `{operationId,kind:settings/delete/clear}`，初始关闭，revision 与 bankGeneration 初始为 0。item 为 `{id,category,title,content,version,manuallyEdited,source:{sessionId,messageId,time},updatedAt}`。operation 为 `{scope,operationId,status,state?,errorCode?}`。status 限 completed/processing/failed/unknown。写操作 ID 为 8–128 位字母、数字、下划线或连字符；同 scope 同 ID 同请求回读同一操作；处理中或未知结果可随后端核查转为最终回执，不同请求返回 MEMORY_OPERATION_CONFLICT。版本不符返回 MEMORY_VERSION_CONFLICT。

`gateway/personal_memory.py` 的 Metadata 是持久化元数据 owner，SQLite FULL synchronous。`transaction()` 使用一个 RLock 与 BEGIN IMMEDIATE；短事务只读取或写入元数据，不在全局 DB 锁内等待 HTTP/模型。列表先取元数据快照，释放事务后在总时限内读取正文，返回前重核 revision/generation。自动任务捕获 scope 的 revision 和 generation；按 scope 串行锁只登记候选及重核 enabled/revision/generation 后切换当前版本。候选的远端 retain/轮询不占控制操作的锁，SQLite transaction 仅包短元数据操作。手工编辑、删除、清空沿该 scope 锁串行，提高 revision；清空先提高 generation，旧任务不再进入当前 bank。Hindsight 是正文唯一存储，documents 表登记稳定条目 ID 与当前物理 document 指针、分类、标题、版本、人工编辑、来源、时间与删除标识。`bank_id(scope,generation)` 是唯一映射。列表仅回读当前代次未删除的登记 document，不能从后端枚举重建已删除条目。

每个 SQLite 文件只由一个网关 ThreadingHTTPServer 持有。POSIX server 启动先取得规范化元数据路径旁的独占文件锁，进程退出由内核释放；其他 server 不能接管仍存活的 owner。新 owner 将前任留下的 processing 自动任务标为 failed，有候选时在同一事务登记清理，无候选的模型阶段也结束为 failed。它不重放原始输入或采用中断任务的迟到候选。人工 processing 回到 unknown，随后按原后端操作核查。所有权不依赖 PID，容器重启复用 PID 不会认领旧任务仍在运行。

generate 和 recall 只暴露为 Host-only geaMemory 方法；浏览器不能提交原始输入建立自动生成任务。GEA 确证登录失效才返回 MEMORY_UNAUTHENTICATED；Hindsight401是 MEMORY_BACKEND_UNAVAILABLE，不得退出 GEA。所有成功回执带已验证 scope。

自动生成只处理 pre-step 已按 enabled/revision/bankGeneration 准入的当前新增原始 user 输入，在对应 turn/end 后后台调用。session/event 的 user/message 为已准入消息补真实来源时间，不能凭事件重新准入旧消息。插件正常装载即注册 hooks，没有额外 enabled 总开关。关闭生成不影响召回；不能以 turn/end 时临时读取的 enabled 回扫历史。

服务端模型配置仅从 MEMORY_MODEL_URL、MEMORY_MODEL_KEY、MEMORY_MODEL_NAME 读取，不下发客户端。提取只产出 background/preference/habit 的最多五个短条目，要求原文证据；引用、假设、凭据和不稳定任务排除。无候选不写 document。topic_key 是稳定主题元数据，用于更新未手编条目。手编条目作为只读约束，再做独立保护判断，只有明确与全部手编事实无矛盾的候选允许保存；新 ID 不能绕过，同类无关新事实仍可保存。unknown/processing 的手编请求阻止新自动准入。

只有模型连接建立时的 URLError(ConnectionRefusedError) 会在当前模型调用内重试一次，每次沿用原请求超时。HTTP 响应失败、已接收请求后断连、身份及 Hindsight 请求都不进入该重试；整个生成操作和已提交写入不重放。再次被拒绝时保留原失败回执，未来新回合可重新准入。

每个自动 operation 保存请求 SHA256，禁止保存原始输入和记忆正文。pending_retains 在后端提交前持久化 document、bank代次、稳定后端 UUID 与条目元数据；正文仅在 Hindsight。异步 ACK 后查询 operation completed 才登记可召回条目。明确失败返回 failed，提交后状态不明返回 unknown，重复请求和重启回读不重发 retain。关闭生成会隔离未确认候选，保留此前确认的当前版本；清理完成才确认关闭。API 日志仅保留调用审计元数据，禁止保存输入、记忆或编辑正文与重放请求。
update 在 scope 锁内比对条目 version、scope revision 与 bankGeneration，先提高 revision，再以稳定后端 operation ID 写入独立候选物理 document。pending_edits 只保存候选与原当前物理 ID、分类、标题、版本、来源、时间、控制版本和后端操作 ID，operations.request 保存请求指纹，不保存编辑正文。后端回执未知或 not_found 保持 unknown；operations 只核查，不重发 retain。显式 update 重试必须匹配原请求指纹，重新核当前版本、物理指针、代次、清理归属及原操作未终止，才以原后端 UUID 和原物理候选幂等重发客户端提供的正文。processing 只查询；完成、失败、被控制操作放弃或已进入清理的请求不能重发。提交在途登记阻止清理提前删除该后端操作，关闭、删除、清空先把候选标为放弃，再等待既有 IO 结束。只有 completed 且控制版本仍有效时才切换当前指针、增加条目版本并设置人工编辑标记；旧物理版本在同一事务进入持久清理。失败或被放弃的候选保留原当前版本的内容、版本、来源和人工标记。未知编辑期间仍可读取和召回已确认的原当前版本，新自动生成和其他人工编辑保持阻断。失败和冲突保留 UI 草稿，清理后可用新操作 ID 重试。

会话归属只由 Host 的 MemorySessionLedger 保存在 profileContext.dir/personal-memory-sessions.json，以 dsh-atomic-write 的 withFileLock 串行写入并原子替换。缺失表示尚未绑定，损坏或读写失败拒绝授权。geaMemory.bindSession(sessionId,signal) 仅供 Host 插件在 recall/capture 路径调用，先在线确认当前 scope，再检查已有绑定、inspect 会话存在并落盘。没有浏览器绑定入口。来源按钮只提交当前条目 ID，Host 取当前身份的条目、核 ledger、通过 sessionController.inspect 验证会话与原 user/message 存在，然后返回 sessionId；client 仅调用 Core uiWorkspace.openSession 并关闭设置。未知绑定、其他账号绑定、缺失会话或消息均不返回来源内容。所有模型 provider 和 compaction 入口沿同一 ledger 核对归属，恢复和 fork 继承限制。缺少可信绑定的记忆历史拒绝认领；切账号中止旧模型等待，即使 provider 忽略 abort，也不发布迟到结果。

删除、清空与关闭的清理回执

自动更新先写独立候选 document，确认成功且控制版本仍有效时，才切换当前条目的物理指针。条目 ID 保持稳定。候选超时或结果未知时，旧版本仍参与列表与召回，所有被放弃候选立即登记持久 cleanups。重启后的查询及新生成/编辑准入会继续清理，无需先关闭、删除或清空。迟到完成的被放弃候选不能再采用，清理后原操作仍报告 failed；同一批次已经采用的版本保持有效。切换后的旧物理版本也沿 cleanups 清理。pending_retains 仅保存逻辑条目与候选物理 ID、后端 UUID 和元数据，不保存正文。

单删先持久化条目 tombstone，提高 revision 并退出召回。清空先提高 revision 与 bankGeneration，所有分类立即进入新空代次。两者保持生成开关值及聊天记录。已提交的候选与未知人工编辑也加入清理目标。未确认的人工编辑继续从原当前物理指针返回匹配的正文和元数据。

cleanups 逐步持久化后端终态、物理删除及待删除的父/子 operation ID。正在处理的后端任务等待自然 completed/failed；cancelled 不能证明正在执行的 IO 已停止，因此保留 unknown。文档或 bank 删除前后都检查该 bank 的归纳/图维护任务，完成后再清除含原文的 terminal 父/子 operations。删除完成后清除本地旧行的 title/source/topic_key，只保留 tombstone 所需信息。失败或未知保留任务，重启后的 state/list/get/recall 和 operations 会继续核查。新控制操作串行，未知控制操作期间不能切回旧 bank 或重新提交自动生成；查询和同 ID 重试复用同一任务。

控制操作接管候选时，在同一事务把原生成或编辑标为放弃，按代次、物理 ID 和后端 UUID 合并清理目标并继承已确认进度；迟到原请求不能另建第二个清理所有者。清理任务移除和 completed/failed 回执在同一事务提交。旧重复任务的恢复只能使用同一 scope 已持久完成的整 bank 清空凭证，核完整 clear 顺序、回执代次和该代次没有 pending 写入。当前代次已经前进、其他 scope 的回执或后端 not_found 本身都不能证明清理完成。

部署前必须关闭该 Hindsight 实例的原始 LLM trace，并处理本票已知合成数据的旧 trace。已安装版本的 document/bank/operation 删除不会移除 PostgreSQL llm_requests；仅关闭新 trace 也不会删除旧记录。该前提及实证入口由根规格与 research/deletion-retention.md 维护，服务器验收票确认后才能声明存活记忆副本已清理。备份/WAL 的即时擦除不在声明范围；恢复备份时须同时恢复删除元数据并重放 tombstone/废弃代次清理，完成前保持隔离。
