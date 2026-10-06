# 当前官方核心的插件安装与回切

本项目的发行物是普通插件包。当前登记基线为官方 Core 5bad、0.2.1-alpha.1，目标设备为本机 macOS arm64。包不携带另一套 DSH CLI、SDK、Node 或用户数据，不通过旧 standalone 启动器另起 Host。

开发依赖仍由本仓库固定 pnpm 管理。发行入口使用独立生产目录，移除开发 link、开发脚本和旧独立启动文件；Workbench、Manage、GenUI 和 Sidebar 作为同组明确 peer，由官方 profile 提供。MCP SDK 是 GEA 宿主入口的运行依赖。

准备输入时，versions.json 明确给出当前五包的 name 到版本映射。先按各 owner 的固定工具链构建；Manage 正常 prepare/prepack 的构建记录与最终输出摘要必须保留。GEA 的生产依赖使用官方 profile 的 hoisted、autoInstallPeers:false 协议安装，随后由 npm shrinkwrap 正常生成 npm-shrinkwrap.json，不手改锁节点或从旧 SDK 锁搬记录。

```sh
node scripts/prepare-package.mjs --versions /absolute/versions.json --destination /absolute/new-production-directory --pnpm /absolute/current-official-pnpm/bin/pnpm.mjs
node scripts/package.mjs --input /absolute/new-production-directory --destination /absolute/artifact-directory
```

生产目录须是新目录，不对源码 node_modules 安装。第二条命令核版本、运行依赖和 peer 声明与 shrinkwrap 一致，再按白名单检查文件、禁止机器路径与凭据、生成 tarball 和 SHA-256 收据。源码根中旧 npm-shrinkwrap 不是这一入口的输入。tar 内的 npm 锁是该包的发行依赖图收据；官方 pnpm add 不会消费它，因此不能只读这张锁就声称安装图已被冻结。

在官方客户端的插件管理页或官方 dsh plugin 命令中安装当前五个明确本地 tarball，按包的真实结果启用、重启并核实际加载路径和摘要。首次安装后，在这个实际可写的普通 profile 中由 npm shrinkwrap 捕获完整五包实际图，再通过官方 pnpm import 转为 profile 的 pnpm-lock.yaml，并冻结安装核对。Root profile 的 npm 图与包自身的 npm 图分别保存，不能用其中一张冒充另一张。官方 SDK peers 使用安装提供的唯一实例；npm --strict-peer-deps 的独立解析不等于官方 Plugin Manager 的协议。peer 警告、依赖获取成功、导出解析与真实设备功能分别记录，不使用 force、legacy-peer-deps 或版本豁免制造通过。

升级或回切前，由唯一 owner 沿正常入口退出客户端，保存当前包与 profile 输入摘要，保留原 Home、userData、workspace、documents、会话及未发送草稿。不能在运行中修改指向 immutable 源组合的 node_modules 链接或让两个 Host 共用用户目录。普通安装应在实际可写 profile 中执行，旧源组合只作为已核恢复材料；回切须核对应源、锁、包及外部依赖摘要，不删除新数据或失败记录。

空目录普通安装和 SDK 解析只是离线安装层。当前设备的启用、停启、资源与会话恢复仍须真实 Native 验收；它不代表 Windows、发布、生产或全部业务票通过。本项目不向正式 GitLab、npm、OSS 或频道写入。

## 实际安装锁的消费

```sh
# 在已安装明确五个候选包的普通 profile 目录执行，不在源码或 immutable组合里执行
npm shrinkwrap --ignore-scripts
# 使用捕获的同一完整 profile 图，消费后写摘要和原始结果
node scripts/freeze-package-profile.mjs --profile /absolute/ordinary-profile --core /absolute/registered-core --lock /absolute/profile-npm-shrinkwrap.json --receipt /absolute/lock-receipt.json
```

freeze 入口核 profile 依赖与输入 npm 图一致，拒绝 immutable源组合的模块链接，并沿官方 runProfilePnpm 调用 import 和 install --frozen-lockfile。后续升级须有新的明确五包来源和完整图；回切保原图与 pnpm 锁，拒绝未锁定的改动。冻结成功仅证明安装锁消费，不代替实际 Native功能验收。
