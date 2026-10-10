# 当前三核心插件安装

同一组三包支持 [登记的官方 Core](../scripts/supported-cores.json) 中的两版客户端及各自 exact SDK peers。三个普通插件为 Workbench、Manage、GEA，具体包版本、SHA256SUMS 和安装说明由 [三包交付入口](package-delivery.md) 同次生成。SDK peer 仅声明登记两版固定 SDK 的精确版本 OR；实际接收必须使用对应宿主提供的唯一实例。


在客户端侧栏“插件”选择“添加插件”，在包名输入框填写 tgz 的本地绝对路径。按 Workbench、Manage、GEA 顺序逐个安装，每次完成后“立即启用”。已安装同名包时按官方升级提示操作，保留 Session、草稿、用户配置与历史。需要联网获取普通 npm 运行依赖。

宿主 installation 提供 SDK，三个包不含另一套 CLI、SDK 或用户数据，不要求源码 checkout 或本机 link。GenUI/Sidebar 为可选已安装增强，不强制安装；只有实际安装并启用的辅助能力才可用。安装不自动登录或发起业务、模型任务。GEA Host 仍为唯一身份与凭据 owner。

## 开发接收验证

打包、普通 profile 安装、Loader/公开设置/预设接收和 Native 分别出回执。三个 tar 经官方 PluginManager 的正常入口安装到新的实际可写隔离 profile，不借用旧用户 patch、源码 SDK link 或预装辅助包来证明三包可安装。核实际 manifest、公共 exports、SDK peers 的版本与 installation 解析路径，并逐文件比较归档。验证仅使用获准的隔离 profile 与窗口 owner，不借用已有用户 profile 或在途窗口。

包自身 npm-shrinkwrap 是发行依赖图，不是官方 profile 的 pnpm 消费图。安装完成后在该新普通 profile 捕获完整实际 npm 图，再由现有 freeze 入口使用官方 runProfilePnpm import 和 frozen install：

```sh
# cwd 为刚完成三包安装的新隔离普通 profile
npm shrinkwrap --ignore-scripts
# 以下路径均使用本次明确的绝对输入
node /absolute/gea-checkout/scripts/freeze-package-profile.mjs --profile /absolute/new-profile --core /absolute/registered-core --lock /absolute/new-profile/npm-shrinkwrap.json --receipt /absolute/lock-receipt.json
```

freeze 拒绝 immutable source-combination 模块链接、另一张同目录 package-lock、profile/npm 图不符、非官方 hoisted/autoInstallPeers:false 协议与不支持的 Core。它只证明实际安装锁已消费，不代替 Loader、Native、业务或模型验收。安装退出 0 或 peer 警告不能单独证明 SDK 正确解析。

如已安装可选 Sidebar，另外核它的 Schemastery 依赖是否遮住 Host SDK。冲突应明确诊断并按该可选插件的有效修复办理，不能用用户本机源码 link 或版本豁免掩盖。没有额外插件时以官方完整标准能力为准，不宣称有未安装的第三方工具。

本项目只做隔离开发，不向正式 GitLab、npm、OSS 或频道写入，不改正式 App 或已有用户数据。之前的五包与 source-link 操作材料按原字节保存在 [历史安装说明](history/install-before-installable-delivery.md)，仅供追溯。
