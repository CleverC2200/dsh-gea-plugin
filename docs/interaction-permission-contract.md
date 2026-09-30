# 交互与引用授权契约、统一架构删除进度

2026-09-30。本轮起点：GEA `a48856d`、工作台 `07f3458`。只收敛现有交互与权限边界，不推进迁移票、不升级生产客户端、不恢复已删除的跟进。

## 身份与全局反馈

GEA Host `Business` 是身份、凭据和权限的唯一权威。GEA 客户端只创建一个 reader，拥有轮询、刷新和释放；它发布 `ctx.geaIdentity` 的只读快照、订阅和 `readScope` 首次读取能力。Native、HTML、头像和全局提示消费这同一接口。HTML 注册入口必须明确传入它，不能默认新建 reader。

`shell.overlay` 挂载一份身份同步故障提示，切到 HTML、Native 或 AI 工作台仍可见；恢复后消失。读取故障不使最后确认身份变成退出。业务查询自身的错误仍由具体页面处理。iframe 消息只能请求 GEA 刷新，不能写认证状态。

## 引用授权

`packages/page-interaction` 负责点击快照、保存代次和取消；引用授权回调仍归 GEA Host。以下分支共享有效 DSH Session 检查和已登记身份归属检查，区别来自真实承载方式：

| 承载 | 必要上下文与授权 | 不增加的协议 |
|---|---|---|
| Native 真实/计划原型 | 已注册的 Native surface、当前 GEA 身份、既有 `Business.surfaceFor(Session)` 菜单与该 surface 匹配 | 不增加 HTML lease、额外确认或独立登录标志 |
| HTML 真实业务 | 现有 lease 对应 Session/plugin；已登记 owner 与当前环境/用户/租户/登录代次 principal 一致 | 不再调用 iframe commit 或 Host confirm POST |
| HTML mock | 有效 DSH Session；现有 mock lease 与 Session/plugin 匹配；真实 HTML 的旧 owner 仍不能被绕过 | 不强制 mock 获取 GEA/Gateway 身份，不把 mock 当真实数据 |

合法 Native 引用 surface 只来自目前四个实际 `bindFrame` 消费者：

| surface | Host 菜单 | 实际组件 |
|---|---|---|
| `gea-workbench` | `gea-proof` | 销售计划 Workbench |
| `gea-regional-plan` | 同名 | RegionalPlanPage / PrototypeWorkbench |
| `plan-region-category` | 同名 | CategoryPlanPage / PrototypeWorkbench |
| `plan-category-production` | 同名 | MpsPlanPage / PrototypeWorkbench |

Inbox、API Log 和任意未知字符串不因此成为引用入口。三张计划原型是静态页面；本轮保持既有 Native 引用需 GEA 登录的行为，不将它们隐式改成 HTML mock。

菜单记录来自既有 surface 接口并由 Host 归一，只证明页面上下文，不代替业务授权。身份失效清掉已有 Native 菜单上下文；页面重新报告才可继续使用。已登记 HTML Session 不能通过声称 Native surface 逃避其租约与身份归属。引用历史是采集快照，实际写业务仍重新执行 Host/Gateway 的当前权限和数据校验。

保存仍为一次授权 POST；插入前沿用既有 binding GET 检查身份代次。不能宣称只发一个 HTTP 请求。无需新增 Native 持久身份绑定或恢复框架；若未来需求超出现有上下文记录，应另行确认范围。

## 统一架构与实际删除进度

2026-09-30 的用户指令覆盖旧版退场条件：只支持当前固定源码基线与统一接口，需把现存必要调用者迁入后删除旧运行路径，不再等后续业务票。生产目录、用户持久 Session 与正式发行不在本项目修改范围。

| 路径 | 当前进度 |
|---|---|
| Manage page-mode DOM 回退 | 已删除模块与挂载、旧页面样式；只注册 settings.section / settings.plugin.item |
| 三/四字段浏览器关联并行解码 | 已删除三字段运行时分支；独立离线转换工具保留 Session ID，运行时只读四字段 |
| HTML theme DOM 观察 | 已删除 computed CSS 和 MutationObserver；直接订阅 ui-theme 的 getTheme / theme/change，页面消费公开快照 |
| legacySession、旧 Agent 资源 adapter | 仍需迁移所有实际载入页并删除，不视为完成 |
| self-report / DOM scan 双来源 | 仍需 FC 与 sample 真正主动发布目录，删除宿主扫描及桥 fallback |
| GEA 外壳 DOM 补丁 | 仍需菜单、欢迎区、入口与布局接公开接口，删除外部 DOM 猜测 |
| 旧包启动与支持矩阵 | 仍需移除旧发行包下载/回退，只加载已迁移的源码页 |

当前主题验证覆盖实际样板的浅/深色、字号和窄屏、公开事件订阅与卸载释放。父页面 CSS 修改不能伪造主题状态；样板自带资源损坏仍给出可见报错。各阶段的固定提交与测试原始输出保存于隔离项目 evidence。

## 验收范围

全局告警在 HTML/Native/AI 切页中单份可见、恢复清除；首次 scope 读取合并且普通打开不重复读取。Native 四个合法入口、未知 surface/错 Session/旧上下文；HTML 正常引用、lease/Session/plugin 不匹配及伪装 Native；mock 无 GEA 登录正例均按各自真实契约验证。

本轮只跑定向测试、source:check 和受影响构建；不跑 767 项全套、不相加冒充 08 完整迁移验收，也不重建已删除的 `07-11-afk`。
