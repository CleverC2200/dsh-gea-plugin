# 交互与引用授权契约、旧适配退场清单

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

## 当前旧适配使用者与退场条件

清单以当前源码入口和可复现 fixture 为证据，不把开发启动器声明的旧包称为已在本次隔离 profile 安装。当前源码迁移产物只有 `dsh-agent-workbench/business/inventory-fc` 明确采用 `agentResources`；开发启动器 `scripts/start.mjs` 仍声明旧 APS/base/dealer/chain 等发布包及三个 mock 包，本轮没有运行下载或发布脚本。

| 适配 / 所属模块 | 现有消费者与保留原因 | 可验证删除条件 | 对应后续范围（不派单） |
|---|---|---|---|
| `legacySession` / `src/html-client.tsx` | 没有 `agentResources` 的旧 HTML 包、HTML sample 和 mock；仍承载当前 DSH Session，不能借此改旧 Session 的 preset | 支持清单中所有真实包完成资源声明迁移，mock/session 复用明确接新接口；旧 preset 缺失、Session 切换、刷新与引用测试均保留并通过；入口没有此分支消费者 | 12 基地、14 全链、16 经销商、17 APS 及 26 旧库存兼容收口；mock 对应 20–22 |
| 旧 Agent 资源适配 / `src/html-plugins.ts` | `loadedAgentResources` 未启用时读取旧 skill/预设包；当前源码 FC 已走 Agent Manage loader，但旧 FC 发布包入口及未迁移模块仍可配置 | 活跃真实 manifest 全有 declarations + Agent Manage agentResources，旧 skill/profile 发布路径无消费者；旧发行组合兼容验收完成 | 09 升级组合、12/14/16/17 业务迁移、26 兼容收口 |
| self-report / DOM-scan 双来源 / `src/html-client.tsx`、`src/html-plugins.ts` | Host 仍为所有 HTML 注入扫描器；当前 FC `source/inventory-light-plugins/src/channel.js` 使用 v1 context，不等同已有 v2 元素自报目录。sample、自报 probe 和扫描 probe 测试分别覆盖两源；优先明确自报，扫描作现存页面兜底 | 每个活跃页面发布完整、有效且可撤销的自报元素目录；缺失/空目录不会错误启用能力；实际 roots 清单不再依赖扫描，取消、重绑、卸载和动作校验测试通过 | 各页面迁移验收 + 26，不按代码外观硬合并两源 |
| 三/四字段浏览器关联 / `dsh-agent-workbench/src/workbench.ts` | 旧 sessionStorage 三字段记录仍可由受支持 mock、通用无 scope 页面及 example fixture 导入；有业务 scope 页面会先核 identity 再决定复用。新写入是四字段 | 支持的升级组合完成存储转换，所有允许导入的旧记录已被覆盖或有明确不再支持依据；同实例持久 Session 不误删、缺失 Session 显式失败、scope 切换和四字段重载均通过 | 09 升级组合、26；本轮不新建永久兼容开关 |
| GEA 壳层 DOM 适配 / `src/client.tsx` | 固定 document title、替换宿主“新会话/思考中”文案、抽屉定位/折叠宽度、欢迎区/对话栏 chrome、Agent 卡片排序等；当前共享壳布局仍使用这些原生 DOM 位置 | 宿主/工作台提供对应公开 slot、locale 或 layout 快照后逐项替换；宽窄屏、切页、刷新、历史、设置、会话生命周期保持；找不到公开 seam 时不绕回新观察器 | 02 工作台边界的后续收口、23–25 原型迁移、27/28 销售计划承载迁移 |
| HTML theme DOM 观察 / `src/html-client.tsx` | 读取 ui-theme 的 CSS 输出，转送 iframe；自身不持有 theme 设置，不能误当新的全局主题状态 | 现有宿主提供可订阅的同等主题投影，iframe 色彩/字体和重新连接行为不变，卸载后订阅释放；保留 theme-state 测试 | 公共样式接线后续收口，非业务指标改造 |
| Manage 旧 page-mode DOM 回退 / `dsh-agent-manage/src/client/page-mode.tsx` | 入口 `src/client/index.ts` 在缺少 `settings.section` 的旧宿主上挂市场页面；当前同级源码有该槽位时不重复挂载 | 所有支持宿主组合提供 settings.section，旧 profile 不再属于支持矩阵；设置入口、禁用/卸载和双表面互斥测试通过 | 03 Manage 整合支持矩阵及 26 兼容收口，不改生产支持范围 |

本轮直接移除的未使用扩展入口仅为 HTML 注册函数的隐式 reader 创建。其他兼容路径有真实调用或支持矩阵责任，只有满足对应退场条件后才能删除。

## 验收范围

全局告警在 HTML/Native/AI 切页中单份可见、恢复清除；首次 scope 读取合并且普通打开不重复读取。Native 四个合法入口、未知 surface/错 Session/旧上下文；HTML 正常引用、lease/Session/plugin 不匹配及伪装 Native；mock 无 GEA 登录正例均按各自真实契约验证。

本轮只跑定向测试、source:check 和受影响构建；不跑 767 项全套、不相加冒充 08 完整迁移验收，也不重建已删除的 `07-11-afk`。
