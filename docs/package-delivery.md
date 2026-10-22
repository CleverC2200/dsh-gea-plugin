# 三包本地交付入口

`delivery:packages` 为 [支持的官方 Core](../scripts/supported-cores.json) 生成同一组三个普通插件包、SHA256SUMS、manifest.json 和面向用户的 INSTALL.md。两版固定 Core 与各自 exact SDK peers 由该声明统一登记，不能据旧单版说明排除其中一版。用户安装与升级步骤见 [安装说明](install.md)；同次生成的 INSTALL.md 绑定具体包集合。

此入口只做当前明确的三包交付。它不构建 owner 源码，不安装 profile、不启动客户端、不登录、不访问模型或业务，也不发布到远端。GenUI/Sidebar 是可选增强，三核心正常安装不得强制要求它们。未安装或未启用辅助插件时不具备其专用工具。三个 tgz 仍需要联网获取普通 npm 运行依赖，不能称为离线自包含。

## 准备输入

在各自隔离 checkout 先按 owner 固定工具链完成构建。Workbench 完整构建还需 APS 子目录独立 package-lock 的冻结安装。Manage 正常 prepare/prepack 的构建应有实际记录，普通 raw pack 可在已完成生命周期后使用 `npm pack --ignore-scripts`，本入口只整理发布元数据。各仓自有依赖和输出不能共享。

request.json 的所有输入路径须为绝对路径，destination 必须是不存在的新目录，且不能落在源码 checkout 或 Core 内。命令不依赖调用者 cwd。以下路径、提交与版本都是占位输入，须以同次冻结记录和 [支持声明](../scripts/supported-cores.json) 替换；用户安装说明不包含这些源码路径。

```json
{
  "core": {
    "path": "/absolute/registered-core",
    "head": "REGISTERED_CORE_HEAD",
    "version": "REGISTERED_CORE_VERSION"
  },
  "pnpm": "/absolute/registered-core/apps/desktop/node_modules/pnpm/bin/pnpm.mjs",
  "versions": {
    "@cleverc2200/dsh-agent-workbench": "REQUESTED_WORKBENCH_VERSION",
    "dsh-agent-manage": "REQUESTED_MANAGE_VERSION",
    "@cleverc2200/gea-dsh-prototype": "REQUESTED_GEA_VERSION",
    "@changfenhuang/dsh-genui": "0.11.3",
    "dsh-better-sidebar": "0.24.1"
  },
  "repositories": [
    {
      "repo": "dsh-agent-workbench",
      "path": "/absolute/workbench",
      "head": "FULL_SOURCE_SHA",
      "archive": "/absolute/workbench-raw.tgz",
      "buildReceipt": "/absolute/workbench-build.json"
    },
    {
      "repo": "dsh-agent-manage",
      "path": "/absolute/manage",
      "head": "FULL_SOURCE_SHA",
      "archive": "/absolute/manage-raw.tgz",
      "buildReceipt": "/absolute/manage-build.json"
    },
    {
      "repo": "dsh-gea-plugin",
      "path": "/absolute/gea",
      "head": "FULL_SOURCE_SHA",
      "buildReceipt": "/absolute/gea-build.json"
    }
  ]
}
```

[productionManifest](../scripts/production-manifest.mjs) 从源码 manifest 生成发行图：移除开发脚本/工作区及源码入口，SDK 按双版支持声明核 exact OR；Workbench/Manage 保留源码已声明的必需 peer 约束，源码未声明时才使用明确输入的 exact peer，GenUI/Sidebar 使用 exact optional peers，MCP SDK保留实际运行依赖。它不复制另一套宿主SDK。

三主包的 versions 必须等于对应 owner 当前 manifest 的真实 version。版本改变须先在 owner 修改 manifest 并重新构建；交付不再重贴已编译 JS 的版本。各 owner 构建生成 Host/client 共用的不可变 pluginPackageVersion，交付在创建输出前执行可信 owner 的本地 generator --check，最终 raw/final TGZ 继续按既有输出摘要核字节。不会为证明版本执行来源不明的归档 JS。

versions 的两个辅助版本是 optional peer 的 exact 发布元数据，复用 productionManifest 时仍须明确填写；它们不增加交付 tgz、不自动安装辅助插件，也不把辅助能力变成三核心启动前提。入口在创建 destination 前调用同一 productionManifest 校验，缺少版本会失败且不运行 prepare。

构建回执必须包含实际执行命令、退出码、源码提交和锁摘要，并列出本次编译输出的路径/摘要。最少覆盖 manifest 的 Host 和 client 公共导出；需要交付的其它构建输出也应登记。output.path 相对对应 source checkout，sha256 核当前文件与 raw/final tar 同名文件，拒绝把旧 tgz 归到新构建下。command.cwd 要与源码实际目录一致。例：

```json
{
  "command": {
    "file": "corepack",
    "args": ["pnpm", "run", "build:plugin"],
    "cwd": "/absolute/gea"
  },
  "exitCode": 0,
  "sourceHead": "FULL_SOURCE_SHA",
  "lockSha256": "SHA256_OF_PNPM_LOCK",
  "outputs": [
    { "path": "lib/host.js", "sha256": "ACTUAL_SHA256" },
    { "path": "lib/client.js", "sha256": "ACTUAL_SHA256" }
  ]
}
```

回执是调用者提供的实际命令记录，本入口核绑定与文件摘要，不将任意 passed 字段当运行证明。正常构建产生的 tracked `lib/`、`client/` 差异允许保留，源码其它修改必须提交；不会清理原工作树或删除历史失败。

## 执行与输出

```sh
# 在本 GEA checkout 中调用；CLI 的两个路径始终绝对
corepack pnpm run delivery:packages --input /absolute/request.json --destination /absolute/new-delivery
corepack pnpm run test:delivery:packages
```

入口首先核全部输入、固定 Core、源码 HEAD/锁、构建产物、W/M raw 包公共 exports 和 exact SDK peers。全部通过后，按 GEA source 的明确 cwd 串行复用 prepare-package、package-companion 和 package。三包全部检查通过才移动最终包目录并写成功 manifest。失败返回非零，不输出成功回执，不执行后续打包步骤；已创建的本次失败目录保留，不覆盖或自动重试。

终端只输出固定诊断码或成功文件清单。子命令的诊断落在本次 evidence/command-N.log，权限 0600；含 token、Authorization、Bearer、password、secret、credential 的行整体遮蔽，避免 URL 搜索把 token 带进会话。日志用于排查，不是启动或业务证据。前置失败发生在写输出前时只返回固定错误码。

成功目录含 packages 下的三个 tgz、SHA256SUMS、INSTALL.md、manifest.json 和 evidence 元数据/锁/安全诊断。成功后移除本次新建生产 stage 及其 node_modules，保留生成图的锁。manifest 的 source/build 绝对路径只用于私有来源核对，不是用户安装前提；包内不能含开发 link、机器路径、强制辅助插件或另一份 SDK。

`manifest.status=packaged` 只证明本次打包与静态合同。普通三包的官方 PluginManager 安装、Loader、资源及预设接收统一进入 `delivery:reception`，不再手工生成接受结论。Native、真实模型和业务仍分别验证。包自身 shrinkwrap 不能代替 profile 锁，不能将本机 SDK source link 写进用户安装步骤。

## 普通安装与 Host 接收

```sh
corepack pnpm run delivery:reception --manifest /absolute/delivery/manifest.json --core /absolute/registered-core --pnpm /absolute/registered-core/apps/desktop/node_modules/pnpm/bin/pnpm.mjs --home /absolute/new-home --evidence /absolute/new-evidence
```

五个参数都是绝对路径，Home 和 evidence 的父目录已存在，而这两个目标目录必须不存在并互不包含。入口先核所选固定 Core、manifest.supportedCores 和三份 tar 的名称、版本及摘要，再独占新 Home 和独立 evidence。同一 manifest.core 保留构建来源，两次接收的 ACCEPTANCE.core 分别记录实际宿主，两次 artifactSetSha256 必须一致。它复用已验证的普通 profile harness，顺序执行官方安装及实际 Loader/公共服务观察，不复用旧用户 patch、辅助包、SDK source link 或凭据。不启动 Native，不调用模型或业务，对观察过程的出网尝试直接拒绝。

安装成功后还必须确认三 Host、三个 client graph 入口、所有已声明 SDK peer 的实际宿主路由、七个业务资源（含受控只读客户库存）、十份文档的完整 standard 和智能编排默认。客户库存已按正式受控只读声明发布预设；订单工作台和订单履约模拟预览仍不得出现在初始预设清单。任何一步失败返回非零，保留失败 Home、阶段及私有诊断，不执行下一步，不生成 ACCEPTANCE.json。终端只输出稳定错误码或成功阶段，不输出原日志。

仅成功接收在新 evidence 中生成 ACCEPTANCE.json，绑定交付 manifest、实际三 tar 集合、安装及观察回执 SHA，以及同一个 Core/Profile。`result.json` 为本次入口结果。接收入口不改原 tgz、manifest 或已有交付文件，打包仍只称 packaged。浏览器执行、Native、业务和真实模型不在这个接收结论内。

本地回归为 `test:delivery:packages`。历史 observe-02 投影有两项真实失败：默认 APS 入口缺失，销售资源缺四份 Skill。fixtures 保存原文件摘要，用相同语义检查分别证明失败；observe-03 仅用于绿色语义重放，其历史回执没有新的集合绑定，不能据此生成新的接收证明。

## 检查执行环境

`npm run test:delivery:packages` 是本地与 `.github/workflows/delivery-fixtures.yml` 的同一条 Node fixture 检查命令，只需 package.json 声明的 semver 运行依赖，不需要 Core 或兄弟仓库，不调用服务。原九项打包检查在临时目录运行生产 CLI 副本，临时 descriptor 对应 fixture Core 的真实 Git HEAD；生产 `current-core.json` 不变。Manage repository 使用保留来源提交的固定 fixture，继续验证真实历史 Git 元数据与运行依赖的区别。

这些 fixture 证明确定性失败传播、保密输出、归档及回执合同，不能代替 `delivery:reception` 的实际安装和 Host 观察，也不能证明远端 CI 已经运行。正式接收只认可明确 packaged 或 installed-and-host-observed 输入状态，任一已有状态都重新执行本次完整接收。失败或缺省 process/scope、包集合绑定不符均拒绝生成接受结论。

可选官方 CLI 语法为 `dsh plugin --profile <name> add <tgz绝对路径>`，已核固定 Core apps/cli/src/args.ts 的实际命令帮助。默认交付 INSTALL.md 以 GUI 操作为主。

Workbench 的 `lib/business/**/build-inputs.json` 是含源码构建路径的开发来源记录，companion curation 会从新包移除这些文件。原 raw tar 与 source 文件保持不变，收据记录每个 excludedProvenanceFiles 的路径/摘要及 raw archive SHA；页面 HTML、代码与公共 exports 仍逐项核验。来源 metadata 不作为运行资产随用户包交付。

独立单包 release、签名频道和完整组合计划见 [签名插件来源](plugin-release-source.md)。三包交付沿最终 manifest 检查所有消费者的实际 peer ranges，保留已有 exact 约束；版本号独立不代表组合自动兼容。

## 公司桌面构建

公司完整桌面包可只携带三个必要插件，GenUI 仍为可选第四包，现有配置和卸载选择保留。构建版本使用用户确认的完整版本号；Core 身份仍由实际 launcher/runtime 的产品版本、App 的干净提交与完整字节证明确定，不能把带日期的桌面构建版本当成 Core runtime 版本。当前明确登记公司 Core `8cfb899ccf21d3662421b99b5f4627842ef712ea`，允许原 `639ed015397290b3745d163aafe02ffee4aa3f84` 的证明刷新，未知 Core 继续拒绝。

## 当前目标组合验收

后续发行统一面向最新验证通过的三插件组合，不枚举历史版本组合，不要求逐包升级顺序及中间重启回执。`release:preflight` 使用当前 `environment` 的固定 Core、SDK 与完整消费者图，只校验替换三个公司包后的最终组合；保留不可变归档、来源、构建、已部署版本高水位与同版本字节保护。

最终三包通过 `delivery:reception` 核官方安装、ACTIVE Host、资源、预设与客户端装载图。真实客户端的下载、安装、重启、Host/client 版本及配置和会话保留分别验收。资源 Consumer 与 GEA 策略冲突时，该资源不进入 Manage 或能力注册表，其页面提示更新 Workbench 并重启；其他资源、身份与更新接口继续运行。
