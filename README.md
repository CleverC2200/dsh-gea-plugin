# GEA 销售计划只读插件

独立安装的 DeepSeek Harness Web 插件，使用 `dsh` profile、认证 Fetch、现有 LLM provider 和标准 Session。业务代码位于本工程；通用工作台插件负责页面目录与 HTML 呈现。本隔离项目只支持 repositories.json 登记的未修改官方源码 4878cdab 与同组插件候选，不使用旧 npm 核心或旧包运行回退。

本地发行包、空目录安装、兼容检查及受控升级/回退流程见[独立安装说明](docs/install.md)。`pnpm run package` 输出可核对 SHA-256 的 tarball，尚不是桌面安装器。

## 源码安装与启动

按需构建、watch 和 Codex 原生环境配置见[本地开发说明](docs/local-development.md)。

使用 Node 24 和 package.json 固定的 pnpm 版本，在本目录执行（发行包的 npm shrinkwrap 安装协议保持不变）：

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run build
cp gea.direct.example.json gea.config.json
# 登录 GEA 后，插件通过 GEA 个人模型接口发现模型并直接调用。
pnpm start --dev --config gea.config.json --runtime .runtime/workbench-development --port 3198
```

需要持续编译时，另开一个终端运行 `pnpm dev`，再刷新客户端页面即可加载最新 bundle。

桌面端调试运行 `pnpm desktop:dev`。它复用本机已安装的 Electron 运行时，只将当前项目的 GEA 插件源码挂入桌面进程；不会写入正式插件版本目录，也不会改变正式插件版本号。改动 UI 后重新编译，在桌面菜单选择“视图 → 重新加载”即可查看。

开发启动通过安装依赖中的 `dsh --profile gea-workbench`，并把当前源码目录挂进独立 Harness home；改完源码后重新构建并刷新客户端即可看到，不需要先安装插件。`pnpm dev` 持续编译 Host、Client 和 Workbench，`--dev` 同时启用 profile 的实时 patch 重载。发行包仍使用不带 `--dev` 的安装启动方式。profile 保留官方 `ui-layout`，启用 `@cleverc2200/dsh-agent-workbench`；本轮官方装配必须解析同组官方 SDK 产物。原生聊天、输入框及 Session 继续由 DSH 提供。

使用启动日志中的带认证参数链接进入全屏登录页，默认自动加载正式环境的二维码，可切换「正式」或「测试」后直接飞书扫码登录；切换环境会自动换码，「刷新二维码」用于重试或更新过期二维码。页面不显示或要求输入服务器地址。登录后进入 GEA 导航、原销售计划审批工作台、原生 DSH 会话的三栏界面。选择组织行与分析范围，点击「预览发送范围」，核对 Host 重新获取的当前计划数据，再确认送入右侧原生 DSH 会话。左栏「DSH 对话」切换到原生对话与工作区侧栏；原生侧栏「GEA 业务版」返回工作台，往返保留当前 Session。空会话欢迎图标居于右栏内容区中央，输入框位于底部。选中 Session 不会关闭业务页面，后续输入、流式回答、取消和历史记录仍由 DSH 负责。

部署配置的 `geaEnvironments.production` 和 `geaEnvironments.test` 分别保存正式、测试 HTTPS 地址，`environment` 指定初始选项（默认 `production`）。旧单地址配置只提供对应的一个环境。工作台「切换环境 / 重新登录」返回登录页；切换会作废旧凭证、二维码、预览和进行中的模型请求，并清空当前会话选择。登录页 GEA 图标来自 AionUi 的 `packages/desktop/src/renderer/assets/logos/brand/app.png`，沿用[原工作台来源与许可证](src/workbench/original/SOURCE.md)。

`gea.config.example.json` 使用本地回执模式，只验证数据传递；真实模型使用 `gea.direct.example.json` 中 `source: "gea"`。插件通过当前 GEA 登录获取个人模型凭证、发现模型并直接调用，不依赖 AionUi 进程。`source: "aionui"` 已移除，旧配置会在启动前报 `AIONUI_RUNTIME_REMOVED`；改用 `source: "gea"`、`agentCode` 和当前 GEA 登录，无需读取 AionUi 的 provider、代理地址或凭证。

### 页面组成

| 层            | 代码                             | 职责                                                                            |
| ------------- | -------------------------------- | ------------------------------------------------------------------------------- |
| 外层 DSH 插件 | `src/client.tsx`                 | GEA 导航、独立页面 iframe、Session 选择与语言同步                               |
| 通用工作台 | [独立工作台仓库](http://100.100.6.191:20656/chenyonghao/dsh-agent-workbench) | 页面目录、HTML呈现、插件公共规范；原生布局与会话归官方宿主 |
| 示例 Agent | `packages/workbench-example/` | 独立插件验证多页面接入，仅在 `workbenchExample: true` 时加载 |
| 独立业务文档  | `src/workbench/page.tsx`         | 登录、GEA 适配、预览与发送；不实现聊天输入框                                    |
| 原审批组件    | `src/workbench/original/`        | 从 AionUi 原源码复制的工作台、CSS、组织维度、筛选、版本、详情和导出             |
| GEA Host      | `src/host/business.ts`、`src/host.ts` | 持有登录凭证、固定只读查询、精确数据和持久化 Session 输入                       |

### 源码目录

| 目录 | 职责 |
| --- | --- |
| `src/client.tsx` | 唯一业务身份与账户动作的只读客户端投影 |
| `src/host/` | GEA Host 业务编排、身份和权限边界、MCP、服务账号与工作流配置 |
| `src/shared/` | Host 与构建脚本共用的环境解析、错误脱敏、流解析、取消信号和通知投影 |
| Workbench `src/workbench/` | 原独立业务文档、工作流加载器及审批页面；GEA只提供实际业务adapter |
| `src/mocks/` | 仅供测试和演示使用的 DMS、销售计划模拟实现 |

GEA构建入口只有 `src/host.ts`、`src/client.tsx`，产物为 `lib/host.js`、`lib/client.js`；Native页面与通用桥从GEA构建退出。

原件来源、许可证及改动范围见 [Workbench SOURCE.md](../dsh-agent-workbench/src/workbench/original/SOURCE.md)。职责迁移保留原SQL、审批角色、金额、草稿与结果校验口径；源码候选仍需主任务完成同组正式UI对照和真实授权运行，不能将源码与离线通过当作实际提交/审批结果。

GEA 地址、请求超时、分页上限、快照大小和模型预算来自部署配置。`requestTimeoutMs` 用于普通 GEA 查询和模型发现；`mcpRequestTimeoutMs` 单独限制 MCP 网关请求，默认 60 秒，可配置为 1–120 秒，旧配置不填时自动使用默认值；`modelRequestTimeoutMs` 单独限制模型流，总时限默认 120 秒，可配置为 1–600 秒。`--runtime` 控制独立 Harness home 和工作区；`--port 0` 为自动回归分配独立端口。移动目录不需要编辑插件源码或硬编码插件路径。配置缺失或无效时启动失败。

## 数据与会话

Host 为预览生成 ID，并重新读取用户选择的当前计划详情；浏览器只提交计划标识，不提交业务对象。凭证只在 Host 内存中。重新查询、重新登录或 401 会使旧快照失效。403 保留脱敏原因，不被当成空结果。

原工作台通过七个固定读取接口访问周期、计划、详情、版本、日志、SKU 和版本对比。明确不完整的数组响应会被拒绝，不冒充完整数据。业务标识和十进制金额保留原始数值文本；超出输入字节上限时拒绝发送，不静默截断。当前分析输入来自选中计划的当前版本，预览展示所选分析范围的完整输入，不把页面正在比较的历史版本当作当前版本。

分析范围默认为「计划汇总（不含 SKU）」，只发送当前版本的头信息和明确标注来源的数量/金额汇总；缺失字段单独列出。选择「完整明细（含 SKU）」会保留完整详情，超出模型输入预算时拒绝发送并提示调整范围。两种范围都展示实际完整输入；切换范围会废弃旧预览，不自动降级或截断。

分析 preset 注册 `gea_sales_plan_read` 固定只读业务工具，按用户任务补充查询周期、列表、详情、版本、日志、SKU 与对比。查询结果保留精确数字、时间、环境和分页覆盖范围；工具调用与结果进入标准 Session，不影响浏览器已经核对的预览。它不注册 Shell、通用网络或业务写工具。模型可见输入通过标准 `user/message` 持久化；成功、失败及取消使用已有 Session 事件。取消后若已有部分文本，dsh 可以保留 `interrupted: true` 的助手消息，同时以 `turn/end.reason.kind=aborted` 结束，不能将该消息计为完整回答。

GEA token 仅保存在当前 Host 内存中；重启后需要重新登录。GEA 模式下模型凭证通过当前登录获取，不进入业务快照或 profile patch。本地 `.runtime/` 包含会话、启动认证链接及验证证据，不应发布。

扫码登录页会显示二维码准备、等待扫码与过期状态，并提示在手机飞书中确认登录。二维码过期后可刷新；支持系统“减少动态效果”设置，中文和英文提示保持一致。

## 当前验证状态

当前三栏使用隔离项目登记的未修改官方源码 4878cdab 与同组插件候选与独立工作台插件，浏览器回归启动真实 Web profile，仅将外部 GEA/模型响应替换为固定测试服务。覆盖原工作台登录/查询/选择、独立文档与原生会话同时显示、持久化回执、窄屏排列。Host 测试覆盖精确金额、接口限制、数据身份和登录/预览失效。原工作台模型测试覆盖导出、权限和 SAVE 回读语义；这些测试不执行真实业务写回。

本次三栏重构的检查、真实查询证据和未完成项见 [2026-09-11 验收记录](docs/acceptance-2026-09-11.md)。此前的真实 GEA/模型验证记录见 [早期验收记录](docs/acceptance-2026-09-10.md)，它不能替代当前发布版 DSH + 工作台插件的真实环境验收；独立安装包、写操作和生产验收也仍未完成。

```sh
pnpm run typecheck
pnpm test
```

`tests/fixtures/gea-approval-workspace.snapshot.json` 是脱敏、无密钥的页面/Session 事件回放夹具；它锁定查询、选择、预览、提交和回执的顺序，不代表真实 GEA 或真实模型验收。真实环境证据仍以 `docs/acceptance-2026-09-10.md` 和运行目录中的本地回执为准。

浏览器测试使用本机 Chrome，测试进程、端口和目录均由测试拥有。定向测试可运行 `node --test tests/<name>.test.mjs`。

验收指定会话使用 `pnpm run verify --runtime <runtime目录> --session <session-id>`，独立核对磁盘快照与首轮完整回答。添加 `--require-live` 还要求当前进程已登录、快照属于当前进程和环境、来源不是本机模拟服务且处于真实模型模式。它不会自动选择旧会话，不将本地回执计为真实模型验收。此入口验证落盘结果，不能替代外部模型请求比对或完整业务范围验收。`scripts/probe-gea.mjs` 仍属于旧原型诊断入口，尚未适配新版部署，不应用它宣告新版验收。

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

工具发现时，GEA 从网关返回的 `_meta.sourceCode` 保存工具路由；调用时自动注入 `params._meta.mcpCode`。模型只填写业务参数。路由随当前登录会话失效，未知或冲突路由会明确报错。支持 JSON 与 SSE 工具列表。

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

macOS 的 GEA 插件部署入口从钥匙串中 `service=keychainService`、`account=service-account` 的项目读取包含 `clientId` 与 `secret` 的 JSON，只传入 Host 进程环境；Web 和桌面启动都调用这个入口。其他平台省略 `keychainService`，由密钥管理系统注入对应的 `GEA_` 环境变量。桌面端须在自己的 `userData/gea.config.json` 中配置同一段不含密钥的 `serviceAccounts` 引用；插件更新不会覆盖已有的用户配置。允许的用户和租户由部署配置明确指定，只有读取权限并不会自动获得服务账号重提权限。缺少凭据或用户未获授权时，重提确认按钮保持禁用。

Host 每次发送前使用表单 `client_credentials` 获取短期 Token，不向浏览器返回凭据。相同幂等键绑定同一请求，当前登录期间的失败重试复用已核验的请求正文；结果未知时只提供原键重试。退出或重启后需重新回读计划，不能把新操作当成旧操作的重试。成功回执仍需核对新有效版本、旧版本失效和重提日志，才能视为工作台验收完成。

### 会话模式 / Session modes

新会话默认使用公司标准预设（显示名在 `scripts/deployment.mjs` 的 `DEFAULT_PRESET_NAME`，组合逐字节沿用 DSH 原版，不注入 GEA 业务 Persona，也不可调用 GEA MCP）。业务侧预设显示为「销售计划Agent」（`gea-readonly`），包含业务 Persona、Skill 发现及加载，以及限于此预设的 GEA MCP。每个随客户端安装的 HTML 业务插件还会生成一个自己的预设，显示名与简介分别取自仓库 `presets/agent-presets.json` 与 `presets/agent-capabilities.json`（改文案不必重发插件包）；`presets/agent-presets.json` 的 `hidden` 列表用于下架不想再出现的模块，宿主每次启动还会清掉这些模块和演示模块在老版本里留下的预设目录。演示（mock）模块没有真实数据通道、答不了业务问题，因此既不生成预设，也不占左侧业务菜单——页面照装，只是没有可选的会话助手。输入框的 Agent 预设选择器用于切换；已有消息的会话保持原预设，请新建会话后选择。左侧销售计划入口仍明确选择 `gea-readonly`。

New conversations default to the company standard preset (display name from `DEFAULT_PRESET_NAME` in `scripts/deployment.mjs`; the composition byte-for-byte matches DSH's original, without the GEA business persona or GEA MCP access). The business preset is displayed as 销售计划Agent (`gea-readonly`), with its business persona, skill discovery/loading and scoped GEA MCP. Every installed HTML business plugin also gets its own preset whose name and summary come from `presets/agent-presets.json` and `presets/agent-capabilities.json` in this repo (renaming never requires republishing a plugin); the `hidden` list in `presets/agent-presets.json` retires modules from the roster, and every start also removes the preset directories those modules and the mock demos left behind in older builds. Mock (demo) modules have no live data channel and cannot answer business questions, so they get no preset and take no business-menu slot — the page stays installed, it just stops offering a selectable assistant. Select the preset in a new conversation; non-empty conversations retain their composition.

## DMS 模拟回写

Issue #23 的独立演示支持终审停在 5、成功后进入 10、失败原键重试、未知结果对账，以及 Z 单追加/追减两笔确认。运行 `node scripts/build-dms-demo.mjs`，再用 `python3 -m http.server 3202 --bind 127.0.0.1 --directory .runtime/dms-demo` 打开模拟页。该页只使用合成样本与内存接收方，不连接真实 GEA/DMS，不影响 3201 的真实业务。复现步骤、回归证据与正式协议边界见 [DMS mock 验收](docs/dms-mock-acceptance.md)。

## 纠偏审批

销售计划工作台增加「月初 / 纠偏」切换。纠偏视图支持固定月初基准和发货指标、逐 SKU 绝对净调整、保存草稿、逐级通过/退回及退回重提；保存不会写确认量或推进状态。新的纠偏写能力要求服务端声明相应契约、窗口和当前版本权限，缺少这些信息时保持只读。

DMS 继续使用 mock。受控 GEA 终审流程可连接既有模拟接收方验证分笔回写、对账和完成状态；模拟回执不会完成真实 GEA 计划。新增适配契约、各票映射及真实环境验证边界见[纠偏验收说明](docs/correction-acceptance.md)。

## 多 Agent 页面

通用工作台接口及职责见 [工作台说明](http://100.100.6.191:20656/chenyonghao/dsh-agent-workbench/-/blob/main/README.md)。GEA 作为其中一个业务插件注册页面；其他 Agent 通过同一接口加入。按“页面＋业务实例”关联 Session，切换与刷新恢复各自会话；只展示页面不会自动向模型发送业务数据。工作台在独立仓库维护，通过固定 Git 提交依赖，且不依赖 GEA 业务代码。

定向验收：`node --test tests/published-runtime.test.mjs tests/workbench-pages.test.mjs`。此次只使用本地测试服务，未对真实审批业务执行写入。

## 公共工作台依赖

公共工作台已迁至独立私有仓库 http://100.100.6.191:20656/chenyonghao/dsh-agent-workbench 。本仓库通过固定 Git 提交依赖其构建产物，不再维护或编译工作台源码。安装开发依赖需要该仓库的读取权限；桌面分发仍携带已安装产物，最终用户不需要 Git 凭据。工作台的控制器测试在独立仓库维护，GEA 保留业务和集成测试。

## 标准 bundle

本隔离项目的 `pnpm start` 只启动当前源码组合，以 `scripts/current-core.json` 登记核心版本、官方来源与本地适配提交。`--bundle` 和 installed payload 旧启动方式不再支持。连接配置通过独立 profile overlay 提供；正常开发默认加载工作台构建的 FC v2 资源，缺少产物时明确失败，不下载旧包或修补旧 HTML。发行、上传和生产客户端仍不在本项目授权范围。

官方来源为 `4878cdabd87d4041bdaff61d04c966883b9fd07a`（0.2.0-rc.1）；当前本地适配为 `8a719b445e3bee8d79daa3c83fc3b4b1a7b64def`。本轮适配前的 `d640266aeadf5ab4a2c6f80cfd7fb9e59861651f` 也是本地提交，不能作为纯官方来源。启动回执分别记录 `upstream` 与 `adaptation`。

缺失工作台时报 `WORKBENCH_MISSING`；非 0.1.x 公共接口版本时报 `WORKBENCH_INCOMPATIBLE`。工作台控制器测试已迁至独立仓库，GEA 保留跨插件浏览器集成测试。发行包由明确文件清单校验，拒绝本机路径和凭据。

账号菜单显示 GEA 登录接口 `userInfo.avatar` 提供的头像（飞书同步头像）；缺失或加载失败时回退姓名首字。旧版保存的登录未包含头像，需要退出后重新扫码。

## 审批查询诊断

流程配置加载失败时，审批页明确显示流程配置错误，并保留脱敏的请求阶段、HTTP 状态、请求编号和跟踪编号，供技术支持定位。访问令牌、委托令牌和未定义的上游响应字段不会返回浏览器。

需求预测预设的进度说明和最终回答跟随用户语言；中文问题使用中文。Skill 的本地参考文件通过 Manage 的 `skill_reference_read` 按技能名及正文链接的相对路径只读加载，支持 `offset`/`limit` 分段读取。MCP 资源读取只接收服务返回的 URI，本地 `file://` 链接会被拦截并提示正确工具。

Demand Forecast follows the user's language for both progress and final answers. Its Manage-owned `skill_reference_read` tool reads local references linked by a visible skill, with `offset`/`limit` pagination. MCP resource reads use server-returned URIs; local `file://` links are rejected with guidance to the correct reader.

### 历史隔离共享主题适配（不用于规格41）

本项目受控源码组合的导航、会话工具栏与原生输入框边框消费工作台共享语义变量；未安装共享资源时保留原有边框后备值。资源由同级工作台 `theme/` 维护并编入宿主，GEA 不保存第二套主题状态。业务页面主题迁移不在此适配中。

### 页面与能力分离声明

页面与能力可以使用独立声明文件，并经现有契约入口装载；旧业务包继续兼容。格式、权限约束与兼容入口删除条件见 [能力契约](docs/capability-contract.md#页面与能力分离声明隔离开发任务-02)。本项属于隔离源码迁移，不是发行变更。
分仓页的“解读能力”来自 Agent Manage 的 `pageAgents`，仅显示已安装且当前 GEA 登录授权的预设。切换时工作台按预设选择独立 Session，GEA 的 `/agents` 与 `/open` 分别校验名单、实际 Session 预设及 Consumer；页面 SQL 仍用分仓页面自己的受管身份。环境、租户、用户共同限定 Session 与引用身份；登录变化会清空旧能力列表。页面引用只接受当前 ready 筛选范围和快照版本；切页、重新查询或会话切换后需重新引用。既有页面请求在会话切换时取消，新会话重新读取当前筛选页。

## 源码组合维护

隔离源码工具共用 `scripts/source-composition.mjs` 的六插件清单（含插件中心）、构建差异、快照资源及核心包扫描范围。`source:check` 检查当前核心声明，`source:build` 依次构建；启动器装配同一组合。预设由 YAML 节点转换，保留 `!!js` 标签，结构不兼容时报告输入文件。主会话读取来自核心 `uiSession.mainSessionId`，槽位通过 `inject.hooks` 订阅；新建会话按钮和输入底栏使用核心语义标记。此组合要求同次更新核心、工作台与 GEA。

### 历史 HTML 样板主题同步（不用于规格41）

公共工作台的 `lib/samples/html-table.html` 仅用于验证；`GEA_TEST_SOURCE_CORE=1 node --test tests/html-shared-theme-web.test.mjs` 通过临时 mock 描述加载，不新增发行插件或真实库存页面。页面内嵌同版 1.0.0 资源，保留现有 sandbox/CSP。

首次 `ready` 只登记当前 iframe 的来源，等当前租约完成后才发送带会话身份的 `connect` 并转移端口；等待期间再次切换会话，由新租约就绪接续握手。重复 `ready` 只连接一次，卸载后不补发，页面无需定时重试。

主题承载器通过 `getTheme()` 与 `theme/change` 发布公开 `{colorScheme, fontSize, tokens}` 快照；页面使用本地共享样式与 `--dsw-*` overrides 呈现。Session、租约、来源和卸载边界不变，父页面 CSS 不构成主题通知。样板自身资源损坏仍报错。

业务页右侧 Agent 欢迎区、简介、建议按钮与输入区底座同样消费 `--workbench-*` 语义颜色，随宿主明暗切换；不保留固定的浅色渐变。HTML主题浏览器用例同时断言这一原生会话区域、往返切换、建议按钮填入和键盘焦点，避免只验证中央iframe。

### 分仓试点资源组合

任务06的页面由同级工作台构建到 `lib/business/inventory-fc`，能力资源源文件归 Agent Manage。`agentResources.provider=dsh-agent-manage` 的显式分离包调用其资源装载器并替换既有 preset 提示词；Consumer、surface、pageIds、maxEffect 由当前声明校验器验证。GEA 保留登录、只读执行和接口日志，资源声明不增加业务权限。`GEA_HTML_PLUGIN_ROOTS` 只接受当前 v2 资源；不含声明的旧包拒绝装载，移除选择不会恢复旧资源。

`/api/gea-html/plugins` 保留 `agentResources` 的公开 provider/prompt 声明和页面需要的 skillName/skillDescription，不返回 skillText；已装载的 Skill、profile 和内部来源路径仅供宿主使用，不进入浏览器目录。资源装载、提示词安装和生命周期继续由原 loader 执行。

页面引用保存会核对实际 Session；HTML 页还需提供当前页面租约，匹配页面与 Session，受业务身份约束。注销清空引用同时取消在途写入。对声明了引用范围的页面，待提交的行快照在范围、就绪状态或已显示内容改变时取消，已保存快照保持原来的不可变语义。旧页面不接入受管预设名单，显式 Agent Manage 页面仍执行07的本地预设及服务端权限校验。

### 08 原生页面身份与目录发现

原生销售计划、区域计划、品类计划、MPS和业务待办，与HTML业务页使用同一Host身份scope；身份变化清理页面关联并为仍显示的原生页恢复当前身份关联，不删除宿主持久Session。原生未登录页面使用独立匿名关联，保留登录/页面入口；已登录关联不能在该状态下恢复。挂载页只在仍为当前页面时重试一次被导航取消的open，不把取消结果当成功。

原生业务页订阅公共 `panelInfo`：切到后台释放页面绑定和会话呈现登记，再次成为当前页时恢复合法关联；保留的页面 DOM 与持久 Session 不删除。待办入口作为 `sidebar.footer.action` 的普通布局内容，不使用外壳绝对定位或旧宿主结构选择器。

`business-identity-client` 在同一GEA客户端内共享轮询和页面打开得到的Host scope；旧请求迟到不能倒退身份，已取消读取不发布身份事件。读取有5秒超时并接受调用方取消。目录发现独立启动；身份观察失败不能阻止元数据注册，真正打开HTML页仍由Host核scope和权限。卸载取消身份观察及目录请求，不再安排下一次轮询。本次接口配套同级源码工作台08候选验证，类型门禁使用`source:check`；普通独立依赖的旧声明不代表该源码组合。

### 唯一 HTML 资源与页面协议

本隔离项目只支持 `gea-html-v2` 与独立 page/capability、Agent Manage prompt/Skill 声明。旧 manifest 直接拒绝，不自动生成资源、不复用旧 Session。页面通过唯一 MessageChannel 主动发布 `{type: "catalog", session, elements}`，所有调用和动作回执携带当前 Session，宿主不再注入扫描器或默认扫描来源。FC 筛选、刷新与草稿字段复用原有 React 回调；目录来自当前分页与已确认状态，加载时撤回读数。mock 不获取 GEA 凭据，能力上限和正式业务写权限保持原声明。审批文档只承载审批功能，HTML 页由统一承载器打开，不再嵌套第二条 HTML 通道。

页面关闭、租约过期、身份失效或资源停用统一撤回该租约拥有的当前页身份、能力目录与上下文缓存；迟到调用拒绝旧租约。清理旧页面不清除同一 Session 上另一页面的当前身份，不删除持久 Session 或改写已选 Agent。

同页重开先撤旧租约，再登记新租约的身份；资源停用同时取消仍在进行的打开请求，迟到完成不能重新登记页面。

### 当前源码支持范围

唯一 HTML 发布方是工作台内已迁移 FC 源码；本地样板/mock 以同一 v2 与显式资源声明验证。审批、区域计划、品类计划、MPS 原型、业务待办、设置、接口日志与原生对话仍由现有源码入口承载。旧启动器声明的 APS/base/dealer/chain 等九个下载包未属于本次源码 profile 的载入组合，已删除下载、旧包修补和支持声明；没有将这些包或后续业务迁移票算作已迁移。本地源码支持清单以实际组合、资源文件与定向验收为证据。

外壳导航、欢迎、等待文案、工具栏和全屏占位通过当前正式座位/布局命令实现。标题、列尺寸、三种会话呈现和占位生命周期由布局拥有者管理；提示词通过原生 InputActions 写入。GEA 不观察或修改其他组件的内部 DOM。账号菜单只操作自己的 DOM refs 和浮层。

### 本地组合切换与恢复

当前源码profile将插件、页面、Skill、主题及覆盖配置保存为独立 `source-combinations/<id>` 快照，记录完整资源SHA-256、源码提交、锁文件摘要和核心提交。启动前校验实际资源；缺失、残留或被改写的文件拒绝载入。准备新组合不会覆盖已选组合，`selectSourceCombination(runtime, id, core)` 仅在Host停止时选用完整本地快照。启动锁与选择共用同一排他文件；异常退出留下锁时先核对记录PID及进程是否已停止，再移除该锁，不能强制抢占运行中的Host。

更新和恢复保持同一 `home`、工作目录与可编辑profile配置，只替换源码profile的模块链接和只读覆盖配置。Host重启产生新业务身份scope；旧页面lease不能恢复，保留Session日志也不授予旧scope权限。这里不运行旧安装payload或旧资源适配，也不写远端频道。09的本地模拟频道与浏览器恢复记录由 `tests/branch-stock-upgrade-web.test.mjs` 生成，外部GEA/模型仅用loopback fixture。

已有08源码profile的实体 `node_modules` 在停机后先显式执行一次 `upgradeSourceProfileLayout(runtime)`；该步骤把原代码目录移到同运行目录的备份，Session、home存储和用户配置不移动。然后选择已校验的当前接口快照。后续启动只使用组合模块链接，不保留旧格式运行时适配。依赖图的实际链接、传递依赖文件、核心构建产物和锁摘要一并校验；固定HEAD下重建造成字节变化也拒绝恢复，需保留或重新准备原依赖产物。普通 `pnpm start` 的默认页面也由所选快照提供。

### 本地更新比较与失败状态

`readSourceUpdateBaseline(runtime, core)` 从实际已选快照读取版本、组件资源摘要、Git source来源/提交和核心基线，并返回用于恢复的组合id及manifest摘要。`applySourceUpdate(runtime, proposal, { core, releases })` 使用现有发行模块的`verifyReleaseHistory`及版本比较；仅处理`current-source-update-v1`本地file频道引用，不访问正式发行地址。每个组件声明`version/sha256/source`、本地引用文件的`downloadSha256/url`及`compatible.core/interface/workbench`；引用文件只指定已校验的当前接口快照及包名，实际组件字节仍由09完整快照校验负责。

准备在独立快照完成；锁内重读最新组合，只核对本次目标组件的完整基线并保留其他组件的后续更新。同版不同摘要、来源改变、过期基线、降级、坏下载、实际package版本不符及兼容范围不符均拒绝。合并重新接好插件间依赖与当前覆盖配置/预设，校验新组合后才原子选择。`succeeded`仅表示本地选择写入并读回验证完成，不代替Host启动验收。

每次操作保存`source-update-<id>.json`：部分准备失败为`prepare-failed`，写入失败为`write-failed`，读回失败为`readback-failed`，记录成功准备项、失败项和实际选择观察。无法观察时为`unknown`，不能自动回滚或报完整成功；重新调用读取API取得当前id与manifest摘要后，使用`selectSourceCombination(runtime, recoveryId, core, { expected: current })`在锁内再次验证当前状态，旧恢复请求拒绝。明确恢复保留发行摘要历史、原Session和用户数据。

入口先固定请求数据，不在异步准备后继续使用调用者可变对象。组件来源在准备时写入受快照摘要保护的元数据，Git remote后续变化不会改写历史来源；09未记录该信息的快照需按固定登记来源重新准备，不能在更新时追溯补猜来源。本地引用还绑定完整manifest摘要，选择记录绑定同一摘要。新发布的兼容范围与快照声明取交集，已装和新增组件的完整清单都需兼容；有效范围保存在组合快照，重启及明确恢复不会丢失约束或发行摘要历史。

准备阶段保存引用绑定的manifest摘要；锁内合并再次核对该摘要，并用读取时固定的资源/依赖期望验证复制结果。等待锁时同步改写候选清单及依赖，也不能借重新扫描清单把变动后的字节授信。

合并覆盖配置、核心/业务预设和锁文件时，校验本次实际读取的字节再用于转换；不能先验一份文件、后来读取变动后的配置并重新生成摘要授信。资源被改写的失败不会触发旧清单整体覆盖或自动恢复。

在公共 `workbench-conversation` 矮面板内，GEA自有欢迎内容限制高度并独立滚动，头像和间距收紧；输入与工具栏保留可见，介绍和推荐问题不删。适配跟随面板高度，不按整个窗口高度猜测半屏会话，也不修改核心DOM或重建会话。

账户入口通过当前 `settings.launcher` 接口和 `openSettings` 动作提供自有按钮；页面引用通过 `conversation.user.text` 只读显示投影进入原生消息与队列，不扫描或修改宿主 DOM。页面发现的网络/HTTP 失败保留可见错误和手动重试入口；不后台循环重试，不把失败当作未安装。Skill 名称和说明直接使用 Agent Manage 的 YAML 解析结果。

## 规格41的官方入口适配候选

当前客户端贡献 `gea-proof` 的原文档位置与必要受控连接，以及 `gea-inbox`、`gea-api-log` 原生页面；区域／品类／MPS HTML 原文与目录移入 Workbench 的独立静态资源，按选页 HTTP 装载。GEA 不再注册定制侧栏导航、Conversation 壳槽或读取 `uiSession.mainSessionId`。HTML 安装根交给 Workbench Host 登记、读取 manifest 与安全呈现，GEA 只接收原声明并检查业务能力。`cordis.patch.yml` 和 `deploymentPatch` 不再禁用官方布局。

`tsconfig.official.json` 检查本插件运行入口及传递依赖，精确消费官方标准声明；未装配的示例独立包不属于本轮三插件类型门禁。旧六插件装配、主题同步和定制 Core 测试保持历史用途，其通过不能证明本次官方组合。现有审批、计划和库存业务桥的显式会话／引用／受控操作接续清单由规格41票04维护，静态呈现通过不等于这部分已验收。原业务源码、持久 Session、认证和历史材料均保留。

## 当前消费者与同组源码依赖

本隔离候选的 Workbench、GenUI、BetterSidebar 开发依赖明确 link 到本票同级固定源码；退出旧 npm GenUI/Sidebar 和旧 Git Workbench 作为新组合输入。正式发布不在授权范围。官方 SDK 在类型/运行装配中仍使用同组4878标准产物，开发工具锁不作为官方运行证明。

Page interaction 的 browser 实现与 wire/reference 公共资源归 Workbench。GEA src/page-interaction 只持有受控引用 Host，src/page-bridge/capability持有实际执行与规则，退出旧兼容 re-export 与独立 page-interaction/example 插件装载。原审批源及其业务规则保留；共同受控 frame 与显式 Session 生命周期由 Workbench承载。HTML startup只读声明/执行 metadata，不读 HTML/Skill/prompt正文，不进行源码 DOM/SQL扫描。

行为验证与真实授权分开：明确管理端未授权项可按本轮分类跳过或用显式mock验收输入，普通500/超时/空结果不推断权限；不在生产请求中自动mock降级。

### 规格42页面与业务 seam

Native/HTML 页面源码、样式、静态 Fetch、bundle 构建、通用 queue/catalog/动作/引用及 owner 释放由 Workbench 持有。GEA `build:plugin` 只构建 `host,client`；不再提供 `/api/gea-proof/workbench(.js/.css)`、`surface`、`agui/workbench` 或 `workbench/context` 页面编排接口。

GEA Host 向现有 `workbenchPages.registerBusinessPage` 登记实际业务 grant，集中保持官方选用资源/Session、Consumer、身份代际、受管 SQL、审批业务规则、validated visible context 和取消。GEA client 只提供唯一业务身份与账户动作的只读投影。两种 HTML 页面动作及内容引用由 Workbench 使用自己的 authenticated Fetch 和 exact owner 处理；GEA不保存第二份通用页面owner/队列。`/api/gea-html/identity` 是当前身份投影，不授予业务能力。

纯 §5.5 预测计算由 Manage 的 `forecast_compute` 提供，沿当前会话工作区核对已安装启用的 `sinian-demand-baseline`；GEA 不注册纯计算、Skill 正文或参考读取工具。原公式与十进制版本保持，计算来源 hash/完整用户 JSON 核对不授予 Consumer 权限。官方 Skill catalog/loader 保持原文，GEA 仅追加身份、实际业务事实、证据和执行限制。
