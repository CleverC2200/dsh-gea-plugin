# 插件拆分：隔离验证入口

用于迁移任务 01：在 macOS 上启动从 DSH 官方源码构建的 Web 核心，建立可重复的运行基线。公司插件的完整兼容适配仍待完成；当前原生核心启动不代表三个公司插件已经接入，也不验证 Electron 壳。

```sh
node scripts/start-isolated-validation.mjs
# 默认读取同级 deepseek-harness；须先按其锁文件安装并执行完整 build。
node scripts/start-isolated-validation.mjs --core /absolute/path/to/deepseek-harness
# 仅在需要历史对照时显式选择 payload：
node scripts/start-isolated-validation.mjs --payload /absolute/path/to/payload
```

每次创建新的 `.runtime/plugin-split-validation/run-*`，包含独立 HOME、DSH profile、工作区、临时文件、日志及版本证据。启动后用输出的本地 URL 打开页面；Ctrl-C 只停止本次进程组。保留该目录供检查，不自动删除用户数据。

隔离由 macOS `sandbox-exec` 执行：进程只可写本次目录，禁止所有出站网络，仅允许在回环地址监听并接受浏览器连接。payload 与原 checkout 都在沙箱外，只读。该入口在其他系统直接失败，不静默降级为无隔离启动。

启动子进程采用环境变量白名单，不继承账号、Token、代理、Node 注入配置或桌面控制连接。源码模式通过官方构建后的 dsh CLI 启动原生 Web profile，尚未挂载公司业务插件。旧 payload 对照模式下，GEA 两个环境地址均指向不可用的本地端口，使用 receipt 模式，Agent 管理来源为空。两种模式都不读取正式登录数据、不拉 HTML 频道、不安装或升级插件、不挂公司资源套件。

源码模式初次打开预览提示后，可选择“稍后配置”进入离线主界面，无需输入模型凭据。旧 payload 对照模式显示登录未连接、业务 HTML 入口禁用和空资源列表；它的前端环境标签可能仍展示“正式”，但两个实际地址均为本地，标签不能作为环境证据。

源码模式按上游浏览器自动化约定加载 `pin-browse-picker.overlay.yml`，目录选择使用页内选择器；当前结果不覆盖原生文件选择器。

## 证据

- `provenance.json`：源码或 payload 模式、包版本、manifest/锁摘要、核心 SHA 与脏状态、启动器提交与源码摘要、运行目录及限制。源码包版本清单是构建输入清单，不等于全部包都已挂载。
- `home/profiles/plugin-split-validation`：独立 profile；旧 payload 模式另外生成 `deployment.patch.json`。
- `server.log`：私有日志，可能包含本实例的临时访问 Token，不要上传或公开。
- `process.json`、`exit.json`：本次进程及退出结果。

2026-09-29 新适配基线：官方 master 的 `4878cdabd87d4041bdaff61d04c966883b9fd07a`，源码版本 `0.2.0-rc.1`。完整构建及隔离原生 Web 页面启动已验证。保留的历史对照为 payload 0.0.25、DSH 0.1.6-alpha.1-company.1、GEA 0.0.130、工作台 0.1.1、Agent 管理 0.6.3-company.6、插件中心 1.4.3-company.35。

GEA 源码为 0.0.135，现有开发锁仍依赖 DSH 0.1.5-rc.2。对新核心声明的定向检查已经发现会话选择、消息/工具结果结构和图标导出差异；新核心也不再扫描旧 Agent 预设目录。正式迁移前必须完成适配与运行验证，不以修改版本范围或豁免代替兼容验证。

## 验证和恢复

```sh
corepack pnpm run test:isolated-validation
corepack pnpm run typecheck
```

自动化测试分别通过 CLI 启动最小源码构建和 payload 替身，验证页面响应、环境白名单、目录外写入被拒绝、出站网络被拒绝以及停止后端口关闭。真实源码构建的启动与界面访问另行记录；测试替身不替代真实运行证据。

本入口不改原应用、payload 或正式数据，不需要对正式环境回滚。停止本次进程后即可回到原工作方式；重跑创建另一份干净目录，旧证据保留。
