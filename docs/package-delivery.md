# 三包本地交付入口

`delivery:packages` 为登记的官方 0.2.1-alpha.1 / Core 5bad 生成三个普通插件包、SHA256SUMS、manifest.json 和面向用户的 INSTALL.md。用户在客户端侧栏“插件”中“添加插件”，输入本地 tgz 的绝对路径，逐个安装后“立即启用”。顺序是 Workbench、Manage、GEA。已安装同名包时使用官方升级提示，保留用户数据。0.2.0-rc.2 不兼容。

此入口只做当前明确的三包交付。它不构建 owner 源码，不安装 profile、不启动客户端、不登录、不访问模型或业务，也不发布到远端。GenUI/Sidebar 是可选增强，三核心正常安装不得强制要求它们。未安装或未启用辅助插件时不具备其专用工具。三个 tgz 仍需要联网获取普通 npm 运行依赖，不能称为离线自包含。

## 准备输入

在各自隔离 checkout 先按 owner 固定工具链完成构建。Workbench 完整构建还需 APS 子目录独立 package-lock 的冻结安装。Manage 正常 prepare/prepack 的构建应有实际记录，普通 raw pack 可在已完成生命周期后使用 `npm pack --ignore-scripts`，本入口只整理发布元数据。各仓自有依赖和输出不能共享。

request.json 的所有输入路径须为绝对路径，destination 必须是不存在的新目录，且不能落在源码 checkout 或 Core 内。命令不依赖调用者 cwd。以下占位路径由调用者替换，用户安装说明不包含这些源码路径。

```json
{
  "core": {
    "path": "/absolute/registered-core",
    "head": "5badb15009ae1756c3afe0ae0cef1faafc290ccc",
    "version": "0.2.1-alpha.1"
  },
  "pnpm": "/absolute/registered-core/apps/desktop/node_modules/pnpm/bin/pnpm.mjs",
  "versions": {
    "@cleverc2200/dsh-agent-workbench": "0.1.1-candidate.installable.20261009.1",
    "dsh-agent-manage": "0.6.3-company.6.candidate.installable.20261009.1",
    "@cleverc2200/gea-dsh-prototype": "0.0.135-candidate.installable.20261009.1",
    "@changfenhuang/dsh-genui": "0.11.3",
    "dsh-better-sidebar": "0.24.1"
  },
  "repositories": [
    {"repo": "dsh-agent-workbench", "path": "/absolute/workbench", "head": "FULL_SOURCE_SHA", "archive": "/absolute/workbench-raw.tgz", "buildReceipt": "/absolute/workbench-build.json"},
    {"repo": "dsh-agent-manage", "path": "/absolute/manage", "head": "FULL_SOURCE_SHA", "archive": "/absolute/manage-raw.tgz", "buildReceipt": "/absolute/manage-build.json"},
    {"repo": "dsh-gea-plugin", "path": "/absolute/gea", "head": "FULL_SOURCE_SHA", "buildReceipt": "/absolute/gea-build.json"}
  ]
}
```

versions 的两个辅助版本是 optional peer 的 exact 发布元数据，复用 productionManifest 时仍须明确填写；它们不增加交付 tgz、不自动安装辅助插件，也不把辅助能力变成三核心启动前提。入口在创建 destination 前调用同一 productionManifest 校验，缺少版本会失败且不运行 prepare。

构建回执必须包含实际执行命令、退出码、源码提交和锁摘要，并列出本次编译输出的路径/摘要。最少覆盖 manifest 的 Host 和 client 公共导出；需要交付的其它构建输出也应登记。output.path 相对对应 source checkout，sha256 核当前文件与 raw/final tar 同名文件，拒绝把旧 tgz 归到新构建下。command.cwd 要与源码实际目录一致。例：

```json
{
  "command": {"file": "corepack", "args": ["pnpm", "run", "build:plugin"], "cwd": "/absolute/gea"},
  "exitCode": 0,
  "sourceHead": "FULL_SOURCE_SHA",
  "lockSha256": "SHA256_OF_PNPM_LOCK",
  "outputs": [
    {"path": "lib/host.js", "sha256": "ACTUAL_SHA256"},
    {"path": "lib/client.js", "sha256": "ACTUAL_SHA256"}
  ]
}
```

回执是调用者提供的实际命令记录，本入口核绑定与文件摘要，不将任意 passed 字段当运行证明。正常构建产生的 tracked `lib/`、`client/` 差异允许保留，源码其它修改必须提交；不会清理原工作树或删除历史失败。

## 执行与输出

```sh
# 在本 GEA checkout 中调用；CLI 的两个路径始终绝对
corepack pnpm run delivery:packages -- --input /absolute/request.json --destination /absolute/new-delivery
corepack pnpm run test:delivery:packages
```

入口首先核全部输入、固定 Core、源码 HEAD/锁、构建产物、W/M raw 包公共 exports 和 exact SDK peers。全部通过后，按 GEA source 的明确 cwd 串行复用 prepare-package、package-companion 和 package。三包全部检查通过才移动最终包目录并写成功 manifest。失败返回非零，不输出成功回执，不执行后续打包步骤；已创建的本次失败目录保留，不覆盖或自动重试。

终端只输出固定诊断码或成功文件清单。子命令的诊断落在本次 evidence/command-N.log，权限 0600；含 token、Authorization、Bearer、password、secret、credential 的行整体遮蔽，避免 URL 搜索把 token 带进会话。日志用于排查，不是启动或业务证据。前置失败发生在写输出前时只返回固定错误码。

成功目录含 packages 下的三个 tgz、SHA256SUMS、INSTALL.md、manifest.json 和 evidence 元数据/锁/安全诊断。成功后移除本次新建生产 stage 及其 node_modules，保留生成图的锁。manifest 的 source/build 绝对路径只用于私有来源核对，不是用户安装前提；包内不能含开发 link、机器路径、强制辅助插件或另一份 SDK。

`manifest.status=packaged` 只证明本次打包与静态合同。官方 PluginManager 安装、Loader 装载、配置/预设公开结果和 Native 由接收者另行验证。沿 [现有安装说明](install.md) 的官方 runProfilePnpm 与 freeze-package-profile 协议验证新普通 profile 的完整实际图。包自身 shrinkwrap 不能代替 profile 锁，不能将本机 SDK source link 写进用户安装步骤。

可选官方 CLI 语法为 `dsh plugin --profile <name> add <tgz绝对路径>`，已核固定 Core apps/cli/src/args.ts 的实际命令帮助。默认交付 INSTALL.md 以 GUI 操作为主。

Workbench 的 `lib/business/**/build-inputs.json` 是含源码构建路径的开发来源记录，companion curation 会从新包移除这些文件。原 raw tar 与 source 文件保持不变，收据记录每个 excludedProvenanceFiles 的路径/摘要及 raw archive SHA；页面 HTML、代码与公共 exports 仍逐项核验。来源 metadata 不作为运行资产随用户包交付。
