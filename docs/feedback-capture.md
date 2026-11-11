# 会话反馈与请求材料

会话反馈由 Core 的现有弹窗发起，GEA Host 收集目标会话材料，使用提交时当前登录账号的业务 Token 和可信租户上传。官方会话日志按目标会话导出，不要求历史登录账号与当前账号一致，不套用个人记忆的会话归属限制。需同时装载适配后的 Core `command-feedback`、`ui-message-feedback`、`api-remotes`，以及 GEA 和 Workbench；版本号相同不证明这些开发产物已经装载。源码验收所需 Core 由 `scripts/ci-core-policy.json` 的 required 输入确定，Workbench 由 `scripts/quality-peer-baseline.json` 固定；旧 Core 或旧 Workbench 不具备本次提交接口。

## 材料与边界

- `gea-requests.jsonl` 是独立轻量清单，记录当前 GEA 部署及已确认模型路由的每次实际 HTTP 发送。请求号由公共发送位置生成；协议内 SSE、JSON-RPC、工具和业务幂等字段保留原值。
- 发起位置传递真实 Core Session；子任务按现有父子谱系归入根会话。页面请求通过 Workbench 的现有 owner 取得 Session 和失效信号。共享准备及缓存结果引用已经发生的请求，命中缓存不新建请求。
- `gea-diagnostics.jsonl` 保存模型消费者实际收到的片段、一次拼接结果及终态。配置 `feedbackCapture` 控制会话/profile 字节数与保留时间；关闭、截断、过期或写入失败均注明缺失，清单独立保存。
- 原有 API 日志只按本会话的实际请求号导出；沿用正文脱敏和内存淘汰。导航与凭据相关接口只保存元数据。
- 请求清单、D 点及 API 材料按环境、用户、租户、会话隔离，仅归集当前登录身份的材料；其他登录身份的采集材料不混入，并注明覆盖缺失。官方会话日志通过官方接口取得，历史覆盖不足保留缺失说明。

## 提交与重试

官方 v4 会话日志必须通过 Core 的官方 flush/read 接口成功取得。清单、D 点及 API 材料按完整行取得固定前缀，再冻结描述、ZIP 原字节、小写 UUID 提交号和身份归属。容量不足先省略 API 原文，再省略 D 点；官方日志和可读清单不静默截尾。

上传走当前业务 Token 和可信租户，不新增 Gateway Session。只有服务端有效回执才显示反馈号。失败保留描述及同进程固定包；同一身份、描述不变的手动重试复用提交号和字节，每次 HTTP 仍产生新请求号。切换用户、租户或环境后重新提交，按当前身份重新冻结并使用新提交号，不重传原身份的失败包。修改描述重新冻结；Host 重启不自动补传。

反馈上传与管理端查询不回填原问题会话。服务端 A/B/C、Nginx 透传与兜底、详情匹配及下载权限须分别核验，上传成功不代表材料齐全。本期无发布动作。

## 维护入口

- [公共清单与 D 点](../src/host/request-capture.ts)
- [固定打包与上传](../src/host/feedback-submit.ts)
- [公共 HTTP 发送](../src/host/api-log.ts)
- [模型实际消费](../src/shared/gea-stream.ts)

参数和上限从 Host Config 查询，接口字段以测试管理端对接文档为准。定向回归覆盖请求清单超过内存上限、共享准备、身份隔离、D 点异常、模型解析、MCP 重连、SQL 共享和固定包重传；实际装载及测试环境回执单独留证。
