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
