# GEA 销售计划只读插件

独立安装的 DeepSeek Harness Web 插件，使用 `dsh` profile、认证 Fetch、现有 LLM provider 和标准 Session。业务代码位于本工程；原生对话栏依赖个人 DSH fork 提供的布局接口，不执行业务审批、保存或写回。

本地发行包、空目录安装、兼容检查及受控升级/回退流程见[独立安装说明](docs/install.md)。`npm run package` 输出可核对 SHA-256 的 tarball，尚不是桌面安装器。

## 源码安装与启动

使用 Node 24，在本目录执行：

```sh
npm ci
export DSH_SOURCE_DIR=/absolute/path/to/deepseek-harness
# 先在该 DSH fork 中完成 pnpm run build。
npm run build
cp gea.direct.example.json gea.config.json
# 登录 GEA 后，插件通过 GEA 个人模型接口发现模型并直接调用。
npm start -- --config gea.config.json --runtime .runtime/fork-development --port 3198
```

`DSH_SOURCE_DIR` 选择已构建的本地 DSH fork。构建将本插件直接使用的 DSH 和 Cordis 包链接到同一 checkout，并在忽略提交的 `lib/dsh-runtime.json` 中记录路径；随后 `npm start` 可复用该路径。启动仍通过 fork 的 `dsh --profile gea-readonly-fork`，它拥有独立 Harness home，避免使用旧发布版 profile 的依赖。客户端 UI 由该 DSH Host 的模块加载器提供，不复制 DSH bundle。当前三栏版本不支持 npm `0.1.5-rc.1`，缺少 fork 路径时明确报错。`npm ci` 会恢复锁定的 npm 依赖；再次构建前需选择 fork。

使用启动日志中的带认证参数链接进入全屏登录页，默认自动加载正式环境的二维码，可切换「正式」或「测试」后直接飞书扫码登录；切换环境会自动换码，「刷新二维码」用于重试或更新过期二维码。页面不显示或要求输入服务器地址。登录后进入 GEA 导航、原销售计划审批工作台、原生 DSH 会话的三栏界面。选择组织行与分析范围，点击「预览发送范围」，核对 Host 重新获取的当前计划数据，再确认送入右侧原生 DSH 会话。左栏「DSH 对话」切换到原生对话与工作区侧栏；原生侧栏「GEA 业务版」返回工作台，往返保留当前 Session。空会话欢迎图标居于右栏内容区中央，输入框位于底部。选中 Session 不会关闭业务页面，后续输入、流式回答、取消和历史记录仍由 DSH 负责。

部署配置的 `geaEnvironments.production` 和 `geaEnvironments.test` 分别保存正式、测试 HTTPS 地址，`environment` 指定初始选项（默认 `production`）。旧单地址配置只提供对应的一个环境。工作台「切换环境 / 重新登录」返回登录页；切换会作废旧凭证、二维码、预览和进行中的模型请求，并清空当前会话选择。登录页 GEA 图标来自 AionUi 的 `packages/desktop/src/renderer/assets/logos/brand/app.png`，沿用[原工作台来源与许可证](src/workbench-original/SOURCE.md)。

`gea.config.example.json` 使用本地回执模式，只验证数据传递；真实模型使用 `gea.direct.example.json` 中 `source: "gea"`。插件通过当前 GEA 登录获取个人模型凭证、发现模型并直接调用，不依赖 AionUi 进程。`source: "aionui"` 已移除，旧配置会在启动前报 `AIONUI_RUNTIME_REMOVED`；改用 `source: "gea"`、`agentCode` 和当前 GEA 登录，无需读取 AionUi 的 provider、代理地址或凭证。

### 页面组成

| 层            | 代码                             | 职责                                                                            |
| ------------- | -------------------------------- | ------------------------------------------------------------------------------- |
| 外层 DSH 插件 | `src/client.tsx`                 | GEA 导航、独立页面 iframe、Session 选择与语言同步                               |
| 原生会话      | DSH fork `ui-layout`             | `registerConversationPanel()` 将原生 `main/conversation` 放到右侧，窄屏上下排列 |
| 独立业务文档  | `src/workbench-page.tsx`         | 登录、GEA 适配、预览与发送；不实现聊天输入框                                    |
| 原审批组件    | `src/workbench-original/`        | 从 AionUi 原源码复制的工作台、CSS、组织维度、筛选、版本、详情和导出             |
| GEA Host      | `src/business.ts`、`src/host.ts` | 持有登录凭证、固定只读查询、精确数据和持久化 Session 输入                       |

原件来源、许可证及改动范围见 [SOURCE.md](src/workbench-original/SOURCE.md)。旧的三栏仿写组件及占位对话栏已经删除。完整迁移尚未验收：审批保存/通过/退回、消息处理和独立 SKU 推理适配尚未接入；原件中的相应写操作保持禁用。当前 AionUi 源码没有单独的需求提报页面，不能把审批页或未挂载的提报模型当作已迁移页面。

GEA 地址、请求超时、分页上限、快照大小和模型预算来自部署配置。`requestTimeoutMs` 用于 GEA 查询和模型发现；`modelRequestTimeoutMs` 单独限制模型流，总时限默认 120 秒，可配置为 1–600 秒。`--runtime` 控制独立 Harness home 和工作区；`--port 0` 为自动回归分配独立端口。移动目录不需要编辑插件源码或硬编码插件路径。配置缺失或无效时启动失败。

## 数据与会话

Host 为预览生成 ID，并重新读取用户选择的当前计划详情；浏览器只提交计划标识，不提交业务对象。凭证只在 Host 内存中。重新查询、重新登录或 401 会使旧快照失效。403 保留脱敏原因，不被当成空结果。

原工作台通过七个固定读取接口访问周期、计划、详情、版本、日志、SKU 和版本对比。明确不完整的数组响应会被拒绝，不冒充完整数据。业务标识和十进制金额保留原始数值文本；超出输入字节上限时拒绝发送，不静默截断。当前分析输入来自选中计划的当前版本，预览展示所选分析范围的完整输入，不把页面正在比较的历史版本当作当前版本。

分析范围默认为「计划汇总（不含 SKU）」，只发送当前版本的头信息和明确标注来源的数量/金额汇总；缺失字段单独列出。选择「完整明细（含 SKU）」会保留完整详情，超出模型输入预算时拒绝发送并提示调整范围。两种范围都展示实际完整输入；切换范围会废弃旧预览，不自动降级或截断。

分析 preset 注册 `gea_sales_plan_read` 固定只读业务工具，按用户任务补充查询周期、列表、详情、版本、日志、SKU 与对比。查询结果保留精确数字、时间、环境和分页覆盖范围；工具调用与结果进入标准 Session，不影响浏览器已经核对的预览。它不注册 Shell、通用网络或业务写工具。模型可见输入通过标准 `user/message` 持久化；成功、失败及取消使用已有 Session 事件。取消后若已有部分文本，dsh 可以保留 `interrupted: true` 的助手消息，同时以 `turn/end.reason.kind=aborted` 结束，不能将该消息计为完整回答。

GEA token 仅保存在当前 Host 内存中；重启后需要重新登录。GEA 模式下模型凭证通过当前登录获取，不进入业务快照或 profile patch。本地 `.runtime/` 包含会话、启动认证链接及验证证据，不应发布。

## 当前验证状态

当前三栏基线使用个人 DSH fork，浏览器回归启动真实 Web profile，仅将外部 GEA/模型响应替换为固定测试服务。覆盖原工作台登录/查询/选择、独立文档与原生会话同时显示、持久化回执、窄屏排列。Host 测试覆盖精确金额、接口限制、数据身份和登录/预览失效。原工作台模型测试覆盖导出、权限和 SAVE 回读语义；这些测试不执行真实业务写回。

本次三栏重构的检查、真实查询证据和未完成项见 [2026-09-11 验收记录](docs/acceptance-2026-09-11.md)。此前的真实 GEA/模型验证记录见 [早期验收记录](docs/acceptance-2026-09-10.md)，它不能替代本次 fork + 原工作台的真实环境重新验收；独立安装包、写操作和生产验收也仍未完成。

```sh
npm run typecheck
npm test
```

`tests/fixtures/gea-approval-workspace.snapshot.json` 是脱敏、无密钥的页面/Session 事件回放夹具；它锁定查询、选择、预览、提交和回执的顺序，不代表真实 GEA 或真实模型验收。真实环境证据仍以 `docs/acceptance-2026-09-10.md` 和运行目录中的本地回执为准。

浏览器测试使用本机 Chrome，测试进程、端口和目录均由测试拥有。定向测试可运行 `node --test tests/<name>.test.mjs`。

验收指定会话使用 `npm run verify -- --runtime <runtime目录> --session <session-id>`，独立核对磁盘快照与首轮完整回答。添加 `--require-live` 还要求当前进程已登录、快照属于当前进程和环境、来源不是本机模拟服务且处于真实模型模式。它不会自动选择旧会话，不将本地回执计为真实模型验收。此入口验证落盘结果，不能替代外部模型请求比对或完整业务范围验收。`scripts/probe-gea.mjs` 仍属于旧原型诊断入口，尚未适配新版部署，不应用它宣告新版验收。

登录后的真实模型发现、正式最小推理验收与审批范围限制见[模型与审批核对](docs/model-and-approval-audit-2026-09-11.md)。

模型名称优先使用模型列表的 `name`；旧版 GEA 列表只有 ID 时，仅对已授权模型调用模型详情查询，提取 `name` 或 `modelName`。DSH 模型列表、当前选择和业务栏使用名称，推理仍使用 ID。无权获取名称或接口未提供时显示“GEA 模型（名称未提供）”，不把编号冒充名称。

原生只读工具、工具流协议、取消收尾和当前真实验收范围见[工具接入记录](docs/agent-tools-2026-09-11.md)。

AionUi 代理适配器及示例配置已删除；旧配置启动拒绝的定向回归确保不会探测本机代理或读取其凭证。此项源码独立性与“干净机器真实登录”验收分别记录。

消息待办支持独立的只读列表、未读数、分页与详情，读取 GEA `/api/v1/notifications`，保留来源引用与原始通知状态。打开详情不会标记已读或执行审批；来源引用不自动解释成 DSH Session。身份切换取消在途查询，响应失败清除旧页面结果。已完成模拟 GEA 回归及正式环境两页共 18 条消息的只读浏览器验收；处理历史仍待实现；来源 DSH Session 跳转按用户要求不在本轮迁移范围内。

消息列表可按未读、已读、已忽略筛选，切换条件自动返回第一页；已知通知状态使用当前界面语言显示。

登录后，业务版和对话版左下角头像均可打开账户菜单，包含「设置」和「退出登录」。退出会清除当前 Host 的 GEA 凭证、个人模型路由、二维码与业务缓存，并取消进行中的身份相关请求；同一服务的其他已打开页面会同步返回扫码页。DSH 工作区和历史会话保留。此操作不注销飞书或其他 GEA 客户端。

### 登录后供市场插件接入 MCP

更新后的插件在同一 Cordis 作用域提供进程内 `geaMcp` v1 服务。更新后的 `dsh-agent-manage` 自动监听登录，默认使用本插件 `analysisAgentCode` 对应的 AGENT Consumer 创建 `/ai/gateway/session` 业务会话，连接 `/ai/gateway/mcp/proxy/mcp`，发现该 Consumer 获授权的工具。市场插件可以显式配置已注册的 CLIENT_APP/AGENT Consumer，或使用 `geaMcp: false` 关闭集成。

登录凭证和委托令牌留在 GEA 的内存闭包中，仅通过受控 fetch 为 MCP 请求注入 `params._meta`；不写入业务 `arguments` 或市场配置。退出、环境切换、登录失效和卸载中止旧请求。失败后需解决授权问题并重新登录，不自动重复建会话或重放工具调用。一个登录代际共享一个挂载业务会话。普通登录和已有业务功能不依赖市场插件。本地测试不代表生产 MCP 授权及业务验收。

The in-process `geaMcp` v1 service lets the market discover authorized MCP tools after login. GEA owns credentials, session preparation and trusted metadata injection; the market owns MCP transport and tools. The default Consumer is the configured analysis Agent. Logout invalidates the capability; no secrets are persisted and failed sessions are not blindly recreated. Production acceptance remains separate.

### 退回重提的服务身份

退回状态 6–9 的重提使用 `POST /api/v1/internal/sales-plans`。Host 从当前用户可读的有效版本重新读取周期、SKU、价格与流程配置，仅接受数量修改；组织、提报人、目标和下一状态必须与 GEA 来源一致。服务账号须授予 `sales-plan:write`、事件 `sales-plan.submit`、策略 `sales-plan.default`。DMS 不参与这条调用。

部署 JSON 的 `serviceAccounts` 按环境隔离，以下只保存引用与授权范围，不保存 Secret：

```json
{
  "serviceAccounts": {
    "production": {
      "clientIdEnv": "GEA_RESUBMIT_CLIENT_ID",
      "clientSecretEnv": "GEA_RESUBMIT_CLIENT_SECRET",
      "keychainService": "gea-dsh-sales-plan-production",
      "tenantId": "0",
      "allowedUserIds": ["部署管理员批准的GEA用户ID"]
    }
  }
}
```

macOS 启动器从钥匙串中 `service=keychainService`、`account=service-account` 的项目读取包含 `clientId` 与 `secret` 的 JSON，只传入 Host 进程环境。其他平台省略 `keychainService`，由密钥管理系统注入对应的 `GEA_` 环境变量。允许的用户和租户由部署配置明确指定，只有读取权限并不会自动获得服务账号重提权限。缺少凭据或用户未获授权时，重提确认按钮保持禁用。

Host 每次发送前使用表单 `client_credentials` 获取短期 Token，不向浏览器返回凭据。相同幂等键绑定同一请求，当前登录期间的失败重试复用已核验的请求正文；结果未知时只提供原键重试。退出或重启后需重新回读计划，不能把新操作当成旧操作的重试。成功回执仍需核对新有效版本、旧版本失效和重提日志，才能视为工作台验收完成。

### 会话模式 / Session modes

新会话默认使用原版 DSH `standard`（标准）预设，不注入 GEA 业务 Persona，也不可调用 GEA MCP。另一个预设显示为「需求预测」（`gea-readonly`），包含业务 Persona、Skill 发现及加载，以及限于此预设的 GEA MCP。输入框的 Agent 预设选择器用于切换；已有消息的会话保持原预设，请新建会话后选择。左侧需求预测入口仍明确选择 `gea-readonly`。启动器在 runtime 的 `native-presets/standard` 创建真实目录，其中的配置文件链接到当前 DSH 源码中的原版标准预设；不复制或改写 DSH 的标准配置，只展示标准与需求预测两种模式。

New conversations default to DSH's unmodified `standard` preset, without the GEA business persona or GEA MCP access. The `gea-readonly` preset is displayed as Demand Forecast (需求预测), with its business persona, skill discovery/loading and scoped GEA MCP. Select the preset in a new conversation; non-empty conversations retain their composition. The launcher links the original standard preset files under runtime `native-presets/standard`, keeping the roster to standard and demand forecast.

## DMS 模拟回写

Issue #23 的独立演示支持终审停在 5、成功后进入 10、失败原键重试、未知结果对账，以及 Z 单追加/追减两笔确认。运行 `node scripts/build-dms-demo.mjs`，再用 `python3 -m http.server 3202 --bind 127.0.0.1 --directory .runtime/dms-demo` 打开模拟页。该页只使用合成样本与内存接收方，不连接真实 GEA/DMS，不影响 3201 的真实业务。复现步骤、回归证据与正式协议边界见 [DMS mock 验收](docs/dms-mock-acceptance.md)。

## 纠偏审批

销售计划工作台增加「月初 / 纠偏」切换。纠偏视图支持固定月初基准和发货指标、逐 SKU 绝对净调整、保存草稿、逐级通过/退回及退回重提；保存不会写确认量或推进状态。新的纠偏写能力要求服务端声明相应契约、窗口和当前版本权限，缺少这些信息时保持只读。

DMS 继续使用 mock。受控 GEA 终审流程可连接既有模拟接收方验证分笔回写、对账和完成状态；模拟回执不会完成真实 GEA 计划。新增适配契约、各票映射及真实环境验证边界见[纠偏验收说明](docs/correction-acceptance.md)。
