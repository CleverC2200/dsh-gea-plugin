# 插件拆分：隔离验证入口

用于迁移任务 01：在 macOS 上启动从 DSH 官方源码构建的 Web 核心，或叠加三个公司插件进行隔离验证。组合模式已验证工作台页面、Agent 管理及本地回执会话；它不代表真实业务、增强插件或 Electron 壳已通过验收。

```sh
node scripts/start-isolated-validation.mjs
# 默认读取同级 deepseek-harness；须先按其锁文件安装并执行完整 build。
node scripts/start-isolated-validation.mjs --core /absolute/path/to/deepseek-harness
# 三个公司插件与固定 GenUI 副本先检查并构建，再启动组合：
corepack pnpm run source:build
node scripts/start-isolated-validation.mjs --plugins
# 仅在需要历史对照时显式选择 payload：
node scripts/start-isolated-validation.mjs --payload /absolute/path/to/payload
```

每次创建新的 `.runtime/plugin-split-validation/run-*`，包含独立 HOME、DSH profile、工作区、临时文件、日志及版本证据。启动后用输出的本地 URL 打开页面；Ctrl-C 只停止本次进程组。保留该目录供检查，不自动删除用户数据。

隔离由 macOS `sandbox-exec` 执行：进程只可写本次目录，禁止所有出站网络，仅允许在回环地址监听并接受浏览器连接。payload 与原 checkout 都在沙箱外，只读。该入口在其他系统直接失败，不静默降级为无隔离启动。

启动子进程采用环境变量白名单，不继承账号、Token、代理、Node 注入配置或桌面控制连接。源码模式通过官方构建后的 dsh CLI 启动原生 Web profile。`--plugins` 将三个公司插件与 GenUI 的已构建文件复制进本次 profile，核心依赖统一解析到选定源码；公司插件之间指向本次快照，不修改原仓库依赖图。组合和旧 payload 模式的 GEA 两个环境地址均指向不可用的本地端口，使用 receipt 模式，Agent 管理来源为空。不读取正式登录数据、不拉 HTML 频道、不安装或升级插件、不挂公司资源套件。

源码模式初次打开预览提示后，可选择“稍后配置”进入离线主界面，无需输入模型凭据。旧 payload 对照模式显示登录未连接、业务 HTML 入口禁用和空资源列表；它的前端环境标签可能仍展示“正式”，但两个实际地址均为本地，标签不能作为环境证据。

源码模式按上游浏览器自动化约定加载 `pin-browse-picker.overlay.yml`，目录选择使用页内选择器；当前结果不覆盖原生文件选择器。

组合的初始模型选择写入 profile 自己的 `cordis.patch.yml`，使新核心配置编辑器可以保存模型发现结果和推理档位；仅在文件不存在时初始化，重启不覆盖已保存的选择。业务接入等部署参数继续走命令行覆盖层。

## 证据

- `provenance.json`：源码或 payload 模式、包版本、manifest/锁摘要、核心 SHA 与脏状态、启动器提交与源码摘要、运行目录及限制。源码包版本清单是构建输入清单，不等于全部包都已挂载。
- `home/profiles/plugin-split-validation`：独立 profile；旧 payload 模式另外生成 `deployment.patch.json`。
- `server.log`：私有日志，可能包含本实例的临时访问 Token，不要上传或公开。
- `process.json`、`exit.json`：本次进程及退出结果。
- `company-plugins.json`：组合模式三个公司插件与 GenUI 的版本、源码提交、脏状态与入口文件摘要。

2026-09-29 新适配基线：官方 master 的 `4878cdabd87d4041bdaff61d04c966883b9fd07a`，源码版本 `0.2.0-rc.1`。完整构建及隔离原生 Web 页面启动已验证。保留的历史对照为 payload 0.0.25、DSH 0.1.6-alpha.1-company.1、GEA 0.0.130、工作台 0.1.1、Agent 管理 0.6.3-company.6、插件中心 1.4.3-company.35。

GEA 源码为 0.0.135，原开发锁仍保留 DSH 0.1.5-rc.2。`source:check` 生成临时 TypeScript 映射，统一使用新核心已构建声明；`source:build` 在检查后构建三个公司插件与 GenUI，不把旧锁下的类型检查当作新组合证据。Agent 管理的 UI primitives 开发依赖链接同级核心，其运行 peer 声明选定的 0.2 版本。新核心预设使用声明式注册，组合保留 `auto-negotiation` 和 `gea-readonly` ID。工作台调用本项目核心的 `uiWorkspace.selectSession` 扩展，在切换会话时保留业务面板。

源码组合中的 GenUI 改用同级独立 `dsh-genui` checkout，固定官方适配提交 `382db5575ad3068efeff0322eec9cc499f79ae01`（PR #231）。入口会核对提交号，复制构建产物和 Skill 资源，并在 `company-plugins.json` 记录 SHA、脏状态及摘要。依赖统一绑定选定核心，与 GEA 共享 Cordis。此提交的包版本仍为 0.11.2，但 npm 0.11.2 尚不含此适配，不能互换。原 package.json/发行锁保留旧依赖，仅源码验证入口选择此副本。

新副本须按其 `packageManager` 使用 pnpm 11.7.0，先执行 `corepack pnpm install --frozen-lockfile --prefer-offline`、`corepack pnpm run check`。`source:check` 已包含 GenUI 对当前核心声明的检查，`source:build` 包含其官方构建。无需更改 peer 范围或授予加载豁免。增强侧栏 0.19.1 仍由版本守卫停用，尚未升级验收。

## 验证和恢复

```sh
corepack pnpm run test:isolated-validation
corepack pnpm run source:check
corepack pnpm run test:source
```

自动化测试分别通过 CLI 启动最小源码构建和 payload 替身，验证页面响应、环境白名单、目录外写入被拒绝、出站网络被拒绝以及停止后端口关闭。真实源码构建的启动与界面访问另行记录；测试替身不替代真实运行证据。

`test:source` 将产品集成测试切到源码组合，外部业务和模型端点限于测试自建的回环服务，测试自己提供临时证书和凭据。它不使用禁止出网的人工检查沙箱，因为用例需要访问回环 fixture；它也不读取生产配置。用例保留业务断言，预览提示选择器兼容新旧标题，会话读取选择实际最高日志代数。旧 `test` 入口仍用于原锁的历史对照，不能作为 0.2 组合验收。

全套测试开始前只构建已有的 `workbench-example` 测试夹具；仅测试显式设置 `workbenchExample: true` 时才复制到隔离快照，用来验证两个业务实例之间的会话和草稿隔离。默认组合不启用它，不新增示例发行插件。测试的回执读取同时识别旧工具块与新 tool-role 消息，并校验调用身份，避免空结果数组掩盖失败。

2026-09-29 接入 GenUI 前，全套源码回归为 679 项、670 通过、9 失败（含一个父测试失败）；随后 10 项定向复测通过。接入官方固定源码后，GenUI 与提示词相关 19 项全通过，另有浏览器测试验证真实回复卡片、本地输入保存及刷新恢复；模型端点是本地 fixture。全套 680 项中 679 通过、1 个接口日志页面测试失败；将该测试原有的目录加载等待移到数量文案断言之前后，最后 21 项定向复测全部通过。没有再次运行全套，不推算新的全套通过数，也不将重叠测试计数相加。

新版原生统计组件按内容宽度显示。本轮布局验收保留与输入卡同中心线、不越界、位于输入卡上方和输入卡贴底的要求，不再要求旧宽条两侧内缩最多 16px。月初/纠偏入口按当前业务源码继续保留。界面截图使用测试数据，不能作为真实业务验收。

本入口不改原应用、payload 或正式数据，不需要对正式环境回滚。停止本次进程后即可回到原工作方式；重跑创建另一份干净目录，旧证据保留。
