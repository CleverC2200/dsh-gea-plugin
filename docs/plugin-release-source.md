# 签名插件来源与独立 release

Host 使用 [createPluginReleaseSource](../src/host/plugin-release-source.ts) 检查频道并下载已验证归档。配置必须显式声明 `channel`、`channelUrl`、`allowed` 的 HTTPS origin/pathPrefix、`authenticationRef` 和 Ed25519 `trustedKeys` 的 keyId/publicKeyPem。pathPrefix 以 `/` 起止；URL 不含凭据、查询、fragment、编码路径或反斜杠。没有默认 OSS 地址或认证引用。

调用者提供 `resolveAuthentication(reference, url, signal)` 与绝对 `trustDirectory`。认证引用由 Host 按已批准读取凭据解析，返回本次请求 headers；业务 token 与 client 登录投影不参与。所有请求拒绝重定向。`check(signal)` 返回三个已验证 PluginRelease，`download(release, absoluteCacheDirectory, signal)` 返回持久 tgz 路径。来源失败清除下载资格，原 inventory 由调用者保留。检查串行，迟到检查不能覆盖新检查；没有当前成功检查时不能下载。

频道 envelope 为 `keyId/payloadBase64/signatureBase64`，签名验证原始 payload 字节。payload 使用 [PluginChannel](../src/shared/plugin-release.d.mts)，包含 schema 1、channel、正整数 revision、ISO issuedAt/expiresAt 和三个唯一包的 release 引用。未来时间容差五分钟，过期频道拒绝。release URL 的路径必须包含 release JSON 的 sha256 独立段，tgz URL 同样包含 tgz sha256。来源依次验证可信 key、频道签名、release hash、tgz size/hash、tar 路径及链接、最终 manifest 与 release 安装图。系统 tar 仅列表或读取 manifest，接受调用取消并对每次读取限时 30 秒，不解压归档到目录；归档不得含 node_modules、链接或越界路径。

trustDirectory 内 approved-channel.json 以 0600 写入并 fsync 后原子替换。它保存频道 revision/payload 摘要和三包已批准版本/摘要，不含凭据。重建 source 后继续拒绝旧 revision、相同 revision 的不同 payload、包版本回退与同版换内容。损坏回执报错，不重置为首次检查。单 Host 持有该目录，调用者应保持这个归属。缓存目录为 0700，tgz 为 0600；下载失败移除本次 partial，已验证 tgz 保留供官方安装器的 file 引用和恢复使用。

[planPluginUpdate](../src/shared/plugin-release.mjs) 接收 release、实际固定 Core 的 head/version/sdk 及已安装 manifest。Core SDK 版本由可信宿主读取，不从频道选择。被替换包必须已安装；更新不降级，不执行同版本替换。`dataCompatibility.kind=preserve` 才能自动计划，migration-required 必须先完成独立迁移。计划用替换后的完整图检查 candidate 与所有已安装消费者的必需/可选 peers，以及公司包 dependencies；可选 peer 缺席可接受，已安装时必须满足。结果为 ready/current/blocked；没有静默更新依赖。

## 生成独立发布输入

[source publication formatter](../scripts/production-manifest.mjs) 保留源码已有 peer 约束，包括当前 exact Manage peer。只有源码没有 companion peer 时才按明确版本输入生成 exact peer；辅助能力仍是 optional。普通三包交付按最终 manifest 完整图验证，不以三个版本相等或 GEA peer 字符串相等代替兼容性。semver 是明确的运行依赖，生产 stage 正常生成的 shrinkwrap 包含它。

`node scripts/create-plugin-release.mjs --archive /absolute/final.tgz --metadata /absolute/metadata.json --destination /absolute/new-output` 从最终归档投影单包 release。metadata 只提供 artifactUrl、已登记 supportedCores、dataCompatibility 和 notes；版本、requires、完整 peer/dependency 图、size/hash 来自归档。destination 必须不存在。输出包含 release 文件路径、摘要和 published=false，不上传 OSS、不更新频道。

[mergePluginChannelRelease/signPluginChannel](../scripts/plugin-channel.mjs) 用显式旧频道、一个新引用、递增 revision 和时间生成完整的新签名 envelope，保留另两包引用。部署方持有私钥并负责原子替换频道。此处函数只生成对象；没有网络或频道写入能力。真实 OSS 地址、凭据、公钥与部署验收仍需明确输入。

本地 `test:release-source` 使用真实 Ed25519 密钥、真实 tar 和受控 fetch；它验证签名链、篡改/回退、完整 peers、固定 Core、持久回执与实际 conditional exports。fixture 测试不证明真实 OSS、官方安装器、Native 自替换、发布或业务验收。

## 官方插件页接线与部署输入

GEA 的 Host/client 实际入口挂接更新能力。client 只在官方 `pluginUpdates.version=1` 与公开 `modules` 服务同时存在时注册三个包的 provider；缺失或其它版本不接管插件页。页面仅显示现有正式更新状态。Host 通过已认证的 `connection.fetch` 注册 status/check/update/observed 四个 POST 路由，不另建业务登录权威。检查使用部署声明的真实超时 AbortSignal；页面关闭中止检查与轮询，已接受安装由 Host 生命周期持有。

`pluginUpdates` 是可选部署配置，省略或配置不完整时三包状态为 blocked，不使用旧 unsigned 频道、默认生产地址或凭据。有效配置包含 `source`（上述来源配置）、`core`（下面的显式来源证明）、`checkTimeoutMs`（1000–120000）和 `pollIntervalMs`（1000–30000）。本接线只支持 `source.authenticationRef="anonymous"`，认证解析器返回空 headers；公网 OSS origin/prefix 也必须显式填写。已核旧 OSS 匿名读取能力不提供新签名频道 URL 或公钥，二者仍需部署输入。

`core` 是部署方明确准入的来源记录，包含绝对 `root`、完整 `head`、`version` 与 `{path,sha256}` artifacts。来源记录及摘要由受信部署方提供，Host 不从当前文件自动生成批准摘要。不能把任意配置 head 当已验证来源，也不能把版本相同视为构建来源相同。两种布局共用四个关键公开 SDK 的实际解析及文件校验，覆盖 app-boot、cordis、plugin-manager、atomic-write 的实际 Node import 主导出，以及 plugin-manager/operations 子路径。缺文件、错摘要、缺实际解析或不完整配置均拒绝。

- 源码布局省略 `kind`，或显式使用 `kind: "source"`。Host 核 installAnchor 位于 root、真实 Git HEAD、干净 tracked 源码、CLI name/version，再从该源码读取 SDK 版本。artifacts 使用 root 下 apps、packages 或 vendor 路径。
- 桌面布局显式使用 `kind: "desktop"`。root 指实际 app.asar 或同布局的部署根，不要求 Git。Host 核顶层 package.json 的 `@deepseek-ai/dsh-desktop`、version、dshBuildCommit 与 `dshBuildDirty: false`，再核 dsh/package.json 的 `@deepseek-ai/dsh-desktop-runtime` 与 version。安装锚必须等于该 runtime 下的 dsh/node_modules/@deepseek-ai/dsh/package.json，并匹配 CLI name/version。四个关键 SDK 必须实际解析到该 runtime 对应包，磁盘 manifest 与解析缓存的 name/version/exports/main 一致。完整 SDK 版本表来自受摘要保护的 runtime dependencies，并逐包核安装 manifest 的 name 与 exact version。

桌面 artifacts 还必须包含 package.json、lib/main.js、dsh/package.json、CLI 安装锚 manifest、dsh-desktop-host 的 package.json 与 lib/index.js，以及四个关键 SDK 的 package.json。每个路径核实际文件范围、唯一性与摘要；SDK 条件导出按 Node import 条件选取，不能用未加载 default 的摘要替代实际入口。这里只验证明确批准的安装材料，受信 owner 构建与装配记录、实际进程及 Native 接收仍各自留证。

Host 证明来自公开 Loader 的唯一启用 entry、ACTIVE Fiber、实际 import namespace 与 callback 一致，以及该 namespace 的 `pluginPackageVersion` 编译常量。client 读取公开 `ctx.modules.loadCache` 的 materialized exports，核 ACTIVE Fiber/callback，再读取相同编译常量。`desiredArtifactRevision` 只绑定当前公开 graph；它不证明 cache 实际加载了该修订。报告是已认证受控 client 的观察，不是远端密码学证明。Host 严格解析报告，绑定 process/page/nonce 和过期时间，再核自身 ACTIVE 版本及当前目标 graph；任意 `{kind:"active"}`、旧 process、错误 nonce、版本或目标修订均拒绝。03 的持久回执只在真实新 Host 进程与匹配 client 观察成立后完成；缺证明保持 pending/unknown。Host/client 版本不一致时官方单一 runningVersion 字段省略。

`waiting-lock`、`snapshotting` 暂投影为“已提交”；正式独立阶段由 01 复核补修，不误报为安装中。

## 显式源码合同

`test:contracts` 和已准备 SDK 的 `quality:ci` 会运行 `test:plugin-updates`，包括 03 恢复合同及 04 的真实公开 Host Loader/clientModules 接线、严格绑定、页面取消与请求超时测试。local 必须明确提供 `GEA_PLUGIN_UPDATE_SDK` 与 `GEA_PLUGIN_UPDATE_CANDIDATE_CORE`；03 核未变公开源码摘要，不能用任意旧 SDK 伪证新操作语义。`typecheck:plugin-updates` 使用同样的显式 SDK 输入和 candidate UI 的公开源码合同做定向类型检查。

定向合同、类型检查和 Host/client build 不代表 cold CI、普通发行或桌面装配已准入新 Core。当前发行登记仍需按新的实际 head、SDK 和来源证据更新；没有真实签名 URL/key 或 Core 部署记录时实际更新与 Native 验收保持 blocked。
