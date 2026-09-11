# GEA 销售计划只读插件

独立安装的 DeepSeek Harness Web 插件，使用 `dsh` profile、认证 Fetch、现有 LLM provider 和标准 Session。业务代码位于本工程；原生对话栏依赖个人 DSH fork 提供的布局接口，不执行业务审批、保存或写回。

## 安装与启动

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

使用启动日志中的带认证参数链接进入全屏登录页，选择「正式」或「测试」后飞书扫码登录。页面不显示或要求输入服务器地址。登录后进入 GEA 导航、原销售计划审批工作台、原生 DSH 会话的三栏界面。选择组织行与分析范围，点击「预览发送范围」，核对 Host 重新获取的当前计划数据，再确认送入右侧原生 DSH 会话。选中 Session 不会关闭业务页面，后续输入、流式回答、取消和历史记录仍由 DSH 负责。

部署配置的 `geaEnvironments.production` 和 `geaEnvironments.test` 分别保存正式、测试 HTTPS 地址，`environment` 指定初始选项（默认 `production`）。旧单地址配置只提供对应的一个环境。工作台「切换环境 / 重新登录」返回登录页；切换会作废旧凭证、二维码、预览和进行中的模型请求，并清空当前会话选择。登录页 GEA 图标来自 AionUi 的 `packages/desktop/src/renderer/assets/logos/brand/app.png`，沿用[原工作台来源与许可证](src/workbench-original/SOURCE.md)。

`gea.config.example.json` 使用本地回执模式，只验证数据传递；真实模型使用 `gea.direct.example.json` 中 `source: "gea"`。插件通过当前 GEA 登录获取个人模型凭证、发现模型并直接调用，不依赖 AionUi 进程。`source: "aionui"` 是保留的旧配置兼容路径，当前三栏验收不使用它。

### 页面组成

| 层            | 代码                             | 职责                                                                            |
| ------------- | -------------------------------- | ------------------------------------------------------------------------------- |
| 外层 DSH 插件 | `src/client.tsx`                 | GEA 导航、独立页面 iframe、Session 选择与语言同步                               |
| 原生会话      | DSH fork `ui-layout`             | `registerConversationPanel()` 将原生 `main/conversation` 放到右侧，窄屏上下排列 |
| 独立业务文档  | `src/workbench-page.tsx`         | 登录、GEA 适配、预览与发送；不实现聊天输入框                                    |
| 原审批组件    | `src/workbench-original/`        | 从 AionUi 原源码复制的工作台、CSS、组织维度、筛选、版本、详情和导出             |
| GEA Host      | `src/business.ts`、`src/host.ts` | 持有登录凭证、固定只读查询、精确数据和持久化 Session 输入                       |

原件来源、许可证及改动范围见 [SOURCE.md](src/workbench-original/SOURCE.md)。旧的三栏仿写组件及占位对话栏已经删除。完整迁移尚未验收：审批保存/通过/退回、消息待办和独立 SKU 推理适配尚未接入；原件中的相应写操作保持禁用。当前 AionUi 源码没有单独的需求提报页面，不能把审批页或未挂载的提报模型当作已迁移页面。

GEA 地址、请求超时、分页上限、快照大小和模型预算来自部署配置。`requestTimeoutMs` 用于 GEA 查询和模型发现；`modelRequestTimeoutMs` 单独限制模型流，总时限默认 120 秒，可配置为 1–600 秒。`--runtime` 控制独立 Harness home 和工作区；`--port 0` 为自动回归分配独立端口。移动目录不需要编辑插件源码或硬编码插件路径。配置缺失或无效时启动失败。

## 数据与会话

Host 为预览生成 ID，并重新读取用户选择的当前计划详情；浏览器只提交计划标识，不提交业务对象。凭证只在 Host 内存中。重新查询、重新登录或 401 会使旧快照失效。403 保留脱敏原因，不被当成空结果。

原工作台通过七个固定读取接口访问周期、计划、详情、版本、日志、SKU 和版本对比。明确不完整的数组响应会被拒绝，不冒充完整数据。业务标识和十进制金额保留原始数值文本；超出输入字节上限时拒绝发送，不静默截断。当前分析输入来自选中计划的当前版本，预览展示所选分析范围的完整输入，不把页面正在比较的历史版本当作当前版本。

分析范围默认为「计划汇总（不含 SKU）」，只发送当前版本的头信息和明确标注来源的数量/金额汇总；缺失字段单独列出。选择「完整明细（含 SKU）」会保留完整详情，超出模型输入预算时拒绝发送并提示调整范围。两种范围都展示实际完整输入；切换范围会废弃旧预览，不自动降级或截断。

分析 preset 不注册 Shell、网络或业务写工具。模型可见输入通过标准 `user/message` 持久化；成功、失败及取消使用已有 Session 事件。取消后若已有部分文本，dsh 可以保留 `interrupted: true` 的助手消息，同时以 `turn/end.reason.kind=aborted` 结束，不能将该消息计为完整回答。

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
