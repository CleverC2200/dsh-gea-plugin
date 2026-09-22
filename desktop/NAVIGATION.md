# 飞书唤醒与 aionui 接管

> 文档版本：v1.0
> 创建时间：2026-09-22
> 最后更新时间：2026-09-22 18:50（Asia/Shanghai）
> 文档状态：源码及定向自动化通过；安装包、真实 GEA/飞书待验证，未发布
> 适用范围：dev-hjg 工作区的新 Electron 壳及配套 GEA 插件；服务端沿用 Client Navigation V1/V2

| 版本 | 变更时间 | 类型 | 内容 | 兼容性 |
| --- | --- | --- | --- | --- |
| v1.0 | 2026-09-22 18:46 | 新增 | 协议接管、登录续接、目标定位、成功回执 | 保留当前 ref/v 链接；不支持其他旧 AionUi 动作 |

## 使用与支持边界

> 变更标识：新增；变更时间：2026-09-22 18:46；影响范围：桌面壳和插件；兼容性：需同时更新壳与插件；迁移动作：安装新版并启动一次，验证系统协议归属。

入口为 `aionui://open-conversation?ref=<opaque-reference>&v=1`，V2 使用 `v=2`。只接受 ref/v，各一次；Reference 为 1–512 位字母、数字、点、下划线或连字符。拒绝未知动作、版本、重复或额外字段、fragment、身份、Token、服务地址或本地路径。

点击后恢复并聚焦窗口，冷启动和运行中点击共用队列。未登录先提示登录；登录成功后使用当前用户解析目标。退出或切换账号会取消旧请求、使旧回执失效并关闭旧目标详情。

- V1：仅支持 `agentCode` 与当前 `analysisAgentCode` 相同的 GEA 页面，复用工作台会话。其他 Agent 明确提示暂不可打开，不推测页面或 preset 映射。
- V2：按当前用户通知列表中的 `interaction_request_id` 精确定位，再读取通知详情核对关系。最多扫描 50 页、每页 100 条，总解析时限 30 秒；超限提示无法定位。不会将 Interaction Request ID 当作通知 ID。
- 页面/会话就绪且对应详情实际显示后才发送 `TARGET_VISIBLE/SUCCESS`。导航不自动审批、不自动已读。
- 队列仅在内存，最多 16 条、驻留 15 分钟；读取不删除，处理完成才删除。待处理重复点击合并；完成后可再次点击定位。完全退出后需重新点击卡片。
- 错误由用户重试或关闭，不无限重试。ACK 重试复用 receipt 作为幂等键，不重复打开目标。

## 安装和回滚

Windows NSIS 通过 `installer-navigation.nsh` 写入安装范围的协议命令，路径与 `%1` 分别加引号；正式进程启动后再注册当前用户。卸载脚本只在命令精确指向自身安装路径时清理协议项，避免删掉已属于其他程序的关联。其他用户的 HKCU 不由当前用户卸载器跨用户清理。macOS DMG 配置声明 URL scheme。开发实例不注册系统协议。

新旧客户端共存时，旧客户端重新安装、更新或主动注册仍可能抢回协议。建议先退役旧客户端，再安装并启动新版；如果旧版卸载器误删关联，在旧版卸载后重新启动或修复新版。不得把安装脚本源码检查视为 Windows/macOS 实机验收。

只更新插件无法为旧壳增加协议接收能力；旧壳返回导航不可用，普通业务继续运行。回滚到已验收且具备协议能力的安装包及配套插件，重新确认系统处理程序；不要自动恢复未知旧路径。MSIX 不在本次支持范围。

## 本地接口

这些是客户端内部接口，不新增服务端 REST 契约。上游字段及权限以 GEA 在线 Client Navigation 契约为准，规范路由为 `/docs/integration/capabilities/client-navigation`；服务端契约不在本文件重复定义。

以下浏览器入口都是 `POST`、`application/json`，沿用 DSH 本地会话认证，正常外壳为 `{ "ok": true, "value": ... }`。不接受浏览器提供 Reference、租户、用户、上游 URL 或任意目标。实际 GEA 鉴权由 Host 当前登录态派生，并由服务端授权。

| 入口 | 请求 | 返回/语义 |
| --- | --- | --- |
| `/api/gea-proof/navigation/poll` | `{}`，无其他字段 | `{state,identityRevision}`；state 为 unavailable/idle/login/ready/error。ready 另有 receipt、panel，V2 另有 notificationId/interactionRequestId；error 有稳定 code，可有 receipt。并发 poll 合并。浏览器每 1500ms 读取。 |
| `/api/gea-proof/navigation/retry` | `{}`，无其他字段 | 同上；重试解析，或重试已显示目标的 ACK。当前 receipt 随重新解析改变，ACK 重试保持同一 receipt。 |
| `/api/gea-proof/navigation/finish` | `{"receipt":"<本次回执>","outcome":"visible"}` 或 dismissed | 同上；visible 只确认当前身份未过期目标，dismissed 仅丢弃当前队列项，不上报成功。过时回执拒绝。 |

`panel` 只可能是 gea-proof/gea-inbox；receipt 是 Host 生成的 UUID，只绑定当前内存任务。identityRevision 是 Host 身份变更计数，用于撤销旧页面；不代表用户 ID。错误提示覆盖失效、权限拒绝、目标不支持、扫描不完整及依赖不可用，原始上游错误正文不返回。请求结构错误沿用 Host 的统一错误外壳；错误不会产生导航成功 ACK。

桌面私有通道：`GET /navigation/pending` 返回 `{id,navigationReference,schemaVersion}` 或 null；`POST /navigation/complete` 接受 `{id}`，只删除该条，重复删除无业务副作用。继承随机回环端口和 Bearer 认证，拒绝 Origin，正文最大 64KiB，Host 连接超时 5 秒；403 表示认证拒绝，404 表示旧壳无能力，500 返回受控错误码。不得由网页直连。

## 日志与验收记录

导航专用传输绕开保存正文的 API 日志中心；Reference、Token、目标正文不进入导航日志。`GEA_CLIENT_NAVIGATION` 只记录 resolve/target-visible/complete 的阶段与受控结果，不保留原始链接。

定向验证：23 项通过、1 项依赖本地 builder 模板的既有测试跳过；包括协议、打包清单、队列、Host 身份与敏感信息、分页定位、ACK 重试，以及真实 Chrome 内的登录续接、重复唤醒、详情就绪、手动阅读和退出取消。类型检查与插件构建通过。

扩大回归未全绿：桌面最终回归 73 通过、1 失败、1 跳过（既有登录测试打包重复声明 createRequire；首次插件批处理超时在重跑中通过）。补齐 OpenSSL PATH 后插件全套 274 通过、21 失败，其中导航页面在中途修复前失败，最终定向已通过；其余含测试打包、预设/工作区依赖及页面超时，不能据此宣称完整兼容回归通过。

GEA 文档 272 项测试及生产构建通过，未部署。

待验收：NSIS 编译及 Windows/macOS 新装、升级、卸载、共存；含空格安装路径；系统有效协议处理程序；真实 GEA 用户权限和 V1/V2 目标；真实飞书有效卡片点击、登录续接、重复点击和错误回退。未生成新安装包、未部署、未上线。

协议生命周期实现参考 [Electron 深层链接文档](https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app)；安装扩展参考 [electron-builder NSIS 文档](https://www.electron.build/v26/docs/nsis/)。
