# 插件拆分：隔离验证入口

用于迁移任务 01：在 macOS 上启动从 DSH 官方源码构建的 Web 核心，或叠加三个公司插件进行隔离验证。组合模式已验证工作台页面、Agent 管理及本地回执会话；它不代表真实业务、增强插件或 Electron 壳已通过验收。

```sh
node scripts/start-isolated-validation.mjs
# 默认读取同级 deepseek-harness；须先按其锁文件安装并执行完整 build。
node scripts/start-isolated-validation.mjs --core /absolute/path/to/deepseek-harness
# 三个插件先对同一份核心声明做检查并构建，再启动组合：
corepack pnpm run source:build
node scripts/start-isolated-validation.mjs --plugins
# 仅在需要历史对照时显式选择 payload：
node scripts/start-isolated-validation.mjs --payload /absolute/path/to/payload
```

每次创建新的 `.runtime/plugin-split-validation/run-*`，包含独立 HOME、DSH profile、工作区、临时文件、日志及版本证据。启动后用输出的本地 URL 打开页面；Ctrl-C 只停止本次进程组。保留该目录供检查，不自动删除用户数据。

隔离由 macOS `sandbox-exec` 执行：进程只可写本次目录，禁止所有出站网络，仅允许在回环地址监听并接受浏览器连接。payload 与原 checkout 都在沙箱外，只读。该入口在其他系统直接失败，不静默降级为无隔离启动。

启动子进程采用环境变量白名单，不继承账号、Token、代理、Node 注入配置或桌面控制连接。源码模式通过官方构建后的 dsh CLI 启动原生 Web profile。`--plugins` 将三个插件的已构建文件复制进本次 profile，核心依赖统一解析到选定源码；公司插件之间指向本次快照，不修改原仓库依赖图。组合和旧 payload 模式的 GEA 两个环境地址均指向不可用的本地端口，使用 receipt 模式，Agent 管理来源为空。不读取正式登录数据、不拉 HTML 频道、不安装或升级插件、不挂公司资源套件。

源码模式初次打开预览提示后，可选择“稍后配置”进入离线主界面，无需输入模型凭据。旧 payload 对照模式显示登录未连接、业务 HTML 入口禁用和空资源列表；它的前端环境标签可能仍展示“正式”，但两个实际地址均为本地，标签不能作为环境证据。

源码模式按上游浏览器自动化约定加载 `pin-browse-picker.overlay.yml`，目录选择使用页内选择器；当前结果不覆盖原生文件选择器。

## 证据

- `provenance.json`：源码或 payload 模式、包版本、manifest/锁摘要、核心 SHA 与脏状态、启动器提交与源码摘要、运行目录及限制。源码包版本清单是构建输入清单，不等于全部包都已挂载。
- `home/profiles/plugin-split-validation`：独立 profile；旧 payload 模式另外生成 `deployment.patch.json`。
- `server.log`：私有日志，可能包含本实例的临时访问 Token，不要上传或公开。
- `process.json`、`exit.json`：本次进程及退出结果。
- `company-plugins.json`：组合模式三个插件的版本、源码提交、脏状态与入口文件摘要。

2026-09-29 新适配基线：官方 master 的 `4878cdabd87d4041bdaff61d04c966883b9fd07a`，源码版本 `0.2.0-rc.1`。完整构建及隔离原生 Web 页面启动已验证。保留的历史对照为 payload 0.0.25、DSH 0.1.6-alpha.1-company.1、GEA 0.0.130、工作台 0.1.1、Agent 管理 0.6.3-company.6、插件中心 1.4.3-company.35。

GEA 源码为 0.0.135，原开发锁仍保留 DSH 0.1.5-rc.2。`source:check` 生成临时 TypeScript 映射，统一使用新核心已构建声明；`source:build` 使用同一映射构建三个插件，不把旧锁下的类型检查当作新组合证据。Agent 管理的 UI primitives 开发依赖链接同级核心，其运行 peer 声明选定的 0.2 版本。新核心预设使用声明式注册，组合保留 `auto-negotiation` 和 `gea-readonly` ID。工作台调用本项目核心的 `uiWorkspace.selectSession` 扩展，在切换会话时保留业务面板。

GenUI 0.11.1-preview.2 和增强侧栏 0.19.1 不声明支持 DSH 0.2，当前由核心版本守卫停用，没有授予豁免。该状态必须在验收中单独报告；不能把缺少增强能力的启动称作完整功能通过。

## 验证和恢复

```sh
corepack pnpm run test:isolated-validation
corepack pnpm run source:check
corepack pnpm run test:source
```

自动化测试分别通过 CLI 启动最小源码构建和 payload 替身，验证页面响应、环境白名单、目录外写入被拒绝、出站网络被拒绝以及停止后端口关闭。真实源码构建的启动与界面访问另行记录；测试替身不替代真实运行证据。

`test:source` 将产品集成测试切到源码组合，外部业务和模型端点限于测试自建的回环服务，测试自己提供临时证书和凭据。它不使用禁止出网的人工检查沙箱，因为用例需要访问回环 fixture；它也不读取生产配置。用例保留业务断言，预览提示选择器兼容新旧标题，会话读取选择实际最高日志代数。旧 `test` 入口仍用于原锁的历史对照，不能作为 0.2 组合验收。

本入口不改原应用、payload 或正式数据，不需要对正式环境回滚。停止本次进程后即可回到原工作方式；重跑创建另一份干净目录，旧证据保留。
