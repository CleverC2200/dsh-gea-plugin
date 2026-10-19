# 签名插件来源与独立 release

Host 使用 [createPluginReleaseSource](../src/host/plugin-release-source.ts) 检查频道并下载已验证归档。配置必须显式声明 `channel`、`channelUrl`、`allowed` 的 HTTPS origin/pathPrefix、`authenticationRef` 和 Ed25519 `trustedKeys` 的 keyId/publicKeyPem。pathPrefix 以 `/` 起止；URL 不含凭据、查询、fragment、编码路径或反斜杠。没有默认 OSS 地址或认证引用。

调用者提供 `resolveAuthentication(reference, url, signal)` 与绝对 `trustDirectory`。认证引用由 Host 按已批准读取凭据解析，返回本次请求 headers；业务 token 与 client 登录投影不参与。所有请求拒绝重定向。`check(signal)` 返回频道当前发布的已验证 PluginRelease，`download(release, absoluteCacheDirectory, signal)` 返回持久 tgz 路径。来源失败清除下载资格，原 inventory 由调用者保留。检查串行，迟到检查不能覆盖新检查；没有当前成功检查时不能下载。

频道 envelope 为 `keyId/payloadBase64/signatureBase64`，签名验证原始 payload 字节。payload 使用 [PluginChannel](../src/shared/plugin-release.d.mts)，包含 schema 1、channel、正整数 revision、ISO issuedAt/expiresAt 和一至三个唯一公司包的 release 引用。未来时间容差五分钟，过期频道拒绝。release URL 的路径必须包含 release JSON 的 sha256 独立段，tgz URL 同样包含 tgz sha256。来源依次验证可信 key、频道签名、release hash、tgz size/hash、tar 路径及链接、最终 manifest 与 release 安装图。系统 tar 仅列表或读取 manifest，接受调用取消并对每次读取限时 30 秒，不解压归档到目录；归档不得含 node_modules、链接或越界路径。

schema 1 可附带 `companionReleases`，此时 `releases` 只包含 GEA，companions 包含 Workbench/Manage 引用，两数组合计仍不超过三个包且不得重复。旧 GEA 忽略此字段，仅获得可独立安装的 GEA 更新；支持此字段的 GEA 验签后合并检查同一 payload 的全部引用，保持完整图与各包的来源、摘要和版本高水位保护。频道无需临时切换或修改客户端 URL。签名和单包 merge 保留分区，不能把 companions 平铺回旧 reader 的 `releases`。

trustDirectory 内 approved-channel.json 以 0600 写入并 fsync 后原子替换。它保存频道 revision/payload 摘要和各包已批准版本/摘要，暂时从频道省略的包仍保留历史准入，不能借此重置回退或同版换内容保护，不含凭据。重建 source 后继续拒绝旧 revision、相同 revision 的不同 payload、包版本回退与同版换内容。损坏回执报错，不重置为首次检查。单 Host 持有该目录，调用者应保持这个归属。缓存目录为 0700，tgz 为 0600；下载失败移除本次 partial，已验证 tgz 保留供官方安装器的 file 引用和恢复使用。

[planPluginUpdate](../src/shared/plugin-release.mjs) 接收 release、实际固定 Core 的 head/version/sdk 及已安装 manifest。Core SDK 版本由可信宿主读取，不从频道选择。被替换包必须已安装；更新不降级，不执行同版本替换。`dataCompatibility.kind=preserve` 才能自动计划，migration-required 必须先完成独立迁移。计划用替换后的完整图检查 candidate 与所有已安装消费者的必需/可选 peers，以及公司包 dependencies；可选 peer 缺席可接受，已安装时必须满足。结果为 ready/current/blocked；没有静默更新依赖。

不兼容诊断保留实际 semver 范围。`requirements.required` 限4096字符并校验真实 semver 范围；包名和版本继续限160字符。较长的有效 exact OR 不得使其它可执行更新计划失效，真实不兼容仍显示 blocked。

## 列表与批量更新

公司 Core 保留官方插件页及顺序，只扩展已安装卡片。顶部刷新通过 `plugins.list.tools` 提供的 `registerRefresh` 同时检查公司插件。列表与详情共用同一个更新客户端和 Host 状态；关闭页面取消页面检查，已经受理的安装仍由 Host 持有。中文说明与无个人账号前缀的展示名使用官方 `locale/*.json` 元信息协议，安装标识保持原值。

`update-all` 接收一至三个唯一包的固定 planId。Host 在同一所有权内下载全部归档，取得原 profile 锁后重新核来源、基线、逐包条件及最终组合，只调用一次原包管理器。它使用一份完整备份和一份操作回执。明确失败且确认写者停止时恢复整组；写者或设置归属不明时保持 unknown，不覆盖用户修改。单包路径复用同一实现。

批量回执在原单包字段之外保存 `targets`，每项包含包名、目标版本、摘要与归档路径。重建 Host 时恢复全部行的待重启状态。只有新进程中的每个目标 Host/client 都有对应版本和实际装载归属，且安装图仍匹配，整组才 completed，并保存各自 completionProofs。安装成功和原进程内重建控制器均不算加载完成。

存在待重启且无进行中或未知操作时，桌面显示一键重启。操作调用公司 Core 的无参数桥，复用原任务确认与 Host 收尾；取消不留下延迟重启。普通浏览器不显示不可用的重启按钮。设置中的 GEA 接口日志复用 Workbench 原日志页面及身份投影，不迁移业务认证权威。

未装载的插件不生成更新计划，列表显示启用并重启的原因；受理前再次核装载状态。更新流程不自动启用插件。

## 生成独立发布输入

[source publication formatter](../scripts/production-manifest.mjs) 保留源码已有 peer 约束，包括经 GEA 实际消费接口验证的 Manage `.12 || .14 || .15` exact OR。验证覆盖 business-resources、user-agent-cube 与 forecast-source，不声明其它 Manage 版本或全部功能兼容。只有源码没有 companion peer 时才按明确版本输入生成 exact peer；辅助能力仍是 optional。普通三包交付按最终 manifest 完整图验证，不以三个版本相等或 GEA peer 字符串相等代替兼容性。semver 是明确的运行依赖，生产 stage 正常生成的 shrinkwrap 包含它。

`pnpm release:preflight --input /absolute/preflight.json` 检查本次正式发行候选。`create-plugin-release.mjs --archive /absolute/final.tgz --metadata /absolute/metadata.json --preflight /absolute/preflight.json --destination /absolute/new-output` 在写单包 release 前强制执行同一检查，archive 与 metadata 必须属于该输入。普通 `delivery:packages` 仍只负责三包打包，不要求正式发行的部署或升级起点。

preflight 使用以下文件合同，所有路径为绝对路径。sources、targets 与交付清单必须各含三个唯一公司包。`requiredCommits` 必须非空，记录本版必含的原提交或合并提交；每项必须是实际 source HEAD 的祖先。其它来源的明确排除仍由本票的来源清单说明，不能用排除记录代替必含提交。

```json
{
  "schemaVersion": 1,
  "deliveryManifest": "/absolute/ordinary-delivery/manifest.json",
  "sources": [
    {
      "name": "COMPANY_PACKAGE",
      "path": "/absolute/source",
      "head": "FULL_SHA",
      "requiredCommits": ["REQUIRED_SOURCE_OR_MERGE_SHA"]
    }
  ],
  "targets": [
    {
      "archive": "/absolute/ordinary-delivery/packages/final.tgz",
      "metadata": "/absolute/metadata.json"
    }
  ],
  "deployed": [
    {
      "id": "deployed-profile-or-channel",
      "installed": ["FULL_INSTALLED_MANIFESTS"]
    }
  ],
  "supportedStarts": [
    {
      "id": "supported-start",
      "core": {
        "head": "FULL_CORE_SHA",
        "version": "CORE_VERSION",
        "sdk": { "SDK_PACKAGE": "ACTUAL_VERSION" }
      },
      "installed": ["FULL_INSTALLED_MANIFESTS"]
    }
  ]
}
```

上例只展示每类一项。`deployed` 与 `supportedStarts` 均不可为空，每个 installed 包含完整消费者 manifest，包括非公司包；三个公司 manifest 还必须带实际部署归档的 `artifactSha256`。部署快照由发行 owner 从批准的真实频道、归档和安装图准备，并保留观察时间及来源证据。历史重放若复用当前未变消费者，须在原证据中说明，不能称为历史整图观察。Core 使用实际宿主固定的 head/version/sdk。缺公司包、缺 SDK 或缺归档身份都拒绝，不以三个手填版本替代图。 第三方 manifest 按规划器实际消费的版本、全部 peer 和公司包 dependency 校验；没有对应 peer 的 optional metadata 不形成约束。原始完整图保留，公司发行 manifest 继续严格解析。

门禁核实际 source HEAD 与源码修改范围，复用普通交付对 lib/client 生成输出的允许规则，生成输出仍须逐字节匹配构建回执与最终 TGZ。它读取 `deliveryManifest`，将每包的 archive 路径、sha256、name/version、source.head/path、锁和 buildReceipt 摘要绑定到实际文件。构建回执沿[普通交付合同](package-delivery.md)，每个输出同时核当前源码目录和 tar 内字节；相同版本的旧包不能借新 HEAD 的声明通过。

每个目标版本必须不低于所有 deployed 与 supportedStarts 中该包的版本；同版本必须使用相同归档字节。门禁逐步调用真实 `planPluginUpdate`，最多枚举三个包的六种顺序，每一步保留未替换消费者与 Core SDK，并用 `validatePluginCombination` 核最终图。功能名后缀仍按同一版本比较器处理，无合法路径即拒绝。三包同版同字节的频道提升允许 planner 返回 current。

metadata 只提供 artifactUrl、已登记 supportedCores、dataCompatibility 和 notes；版本、requires、完整 peer/dependency 图、size/hash 来自最终归档。destination 必须不存在。输出包含 release 文件路径、摘要、preflight 输入与交付清单摘要、各起点的合法顺序及 published=false，不上传 OSS、不更新频道。`test:release-contract` 将公开 CLI 的来源、身份和路径回归纳入 `quality:fast --source-only` 与现有 source CI。`release:preflight --desktop --base-tag <tag>` 保留桌面安装包原有版本准备职责，不代替插件发行门禁。

[mergePluginChannelRelease/signPluginChannel](../scripts/plugin-channel.mjs) 用显式旧频道、一个新引用、递增 revision 和时间生成完整的新签名 envelope，保留已有其他包引用，尚未在频道出现的包可独立加入。部署方持有私钥并负责原子替换频道。此处函数只生成对象；没有网络或频道写入能力。真实 OSS 地址、凭据、公钥与部署验收仍需明确输入。

本地 `test:release-source` 使用真实 Ed25519 密钥、真实 tar 和受控 fetch；它验证签名链、篡改/回退、完整 peers、固定 Core、持久回执与实际 conditional exports。fixture 测试不证明真实 OSS、官方安装器、Native 自替换、发布或业务验收。

## 官方插件页接线与部署输入

GEA client 使用官方既有的 `plugins.detail.actions`、`plugins.detail.badge` 和 `plugins.detail.section` 扩展位，向 Workbench、Manage、GEA 三个 bundle 的详情贡献检查、单包更新、状态与版本；公司 Core 的列表扩展见下文。它等待公开 slots、locale、modules 与 settingsNavigation 服务，不要求额外的 Core 更新 provider。中英文随官方 locale 切换；按钮和状态使用官方公共组件与主题，样式随贡献生命周期装载和释放。非目标 bundle、row 与 item 不贡献内容。Host 通过已认证的 `connection.fetch` 注册 status/check/update/update-all/observed 五个 POST 路由，不另建业务登录权威。普通详情关闭中止本页检查与轮询；已提交更新另持有最长两分钟的客户端观察，到真实待重启、完成、恢复、失败或观察到期时释放，安装仍由 Host 生命周期持有。官方列表、详情卸载等控件继续由官方锁和更新前后的基线检查保护。

每次 GEA client 挂载以新 pageIdentity 调用公开 status，按原 nonce 与真实 Loader 观察合同读取 Host 的持久状态。仅实际进行中或待重启的操作恢复上述有界观察，不重发 check/update；无操作即结束，初始状态读取失败最多尝试三次。新 Host 已装载目标而 client 尚未真实就绪时继续有界观察；合法 observed ACK 后再次读取同一 page 的 status，以 Host 最新状态判断是否完成，原 Host 仍为旧版本时照常提示重启。GEA 自有 shell.overlay 使用公共 Toast 呈现进度、待重启与未确认结果，提供返回插件管理及适用的一键重启；浮层本身不保活轮询。传输失败或观察超时只提示未确认，不修改 Host 状态；只有真实活动状态才能恢复进度提示。

`pluginUpdates` 是可选部署配置，省略或配置不完整时三包状态为 blocked，不使用旧 unsigned 频道、默认生产地址或凭据。有效配置包含 `source`（上述来源配置）、`core`（下面的显式来源证明）、`checkTimeoutMs`（1000–120000）和 `pollIntervalMs`（1000–30000）。本接线只支持 `source.authenticationRef="anonymous"`，认证解析器返回空 headers；公网 OSS origin/prefix 也必须显式填写。已核旧 OSS 匿名读取能力不提供新签名频道 URL 或公钥，二者仍需部署输入。

`core` 是部署方明确准入的来源记录，包含绝对 `root`、完整 `head`、`version` 与 `{path,sha256}` artifacts。来源记录及摘要由受信部署方提供，Host 不从当前文件自动生成批准摘要。不能把任意配置 head 当已验证来源，也不能把版本相同视为构建来源相同。两种布局共用四个关键公开 SDK 的实际解析及文件校验，覆盖 app-boot、cordis、plugin-manager、atomic-write 的实际 Node import 主导出，以及 plugin-manager/operations 子路径。缺文件、错摘要、缺实际解析或不完整配置均拒绝。

- 源码布局省略 `kind`，或显式使用 `kind: "source"`。Host 核 installAnchor 位于 root、真实 Git HEAD、干净 tracked 源码、CLI name/version，再从该源码读取 SDK 版本。artifacts 使用 root 下 apps、packages 或 vendor 路径。
- 桌面布局显式使用 `kind: "desktop"`。root 指实际 app.asar 或同布局的部署根，不要求 Git。Host 核顶层 package.json 的 `@deepseek-ai/dsh-desktop`、version、dshBuildCommit 与 `dshBuildDirty: false`，再核 dsh/package.json 的 `@deepseek-ai/dsh-desktop-runtime` 与 version。安装锚必须等于该 runtime 下的 dsh/node_modules/@deepseek-ai/dsh/package.json，并匹配 CLI name/version。四个关键 SDK 必须实际解析到该 runtime 对应包，磁盘 manifest 与解析缓存的 name/version/exports/main 一致。完整 SDK 版本表来自受摘要保护的 runtime dependencies，并逐包核安装 manifest 的 name 与 exact version。

桌面 artifacts 还必须包含 package.json、lib/main.js、dsh/package.json、CLI 安装锚 manifest、dsh-desktop-host 的 package.json 与 lib/index.js，以及四个关键 SDK 的 package.json。每个路径核实际文件范围、唯一性与摘要；SDK 条件导出按 Node import 条件选取，不能用未加载 default 的摘要替代实际入口。这里只验证明确批准的安装材料，受信 owner 构建与装配记录、实际进程及 Native 接收仍各自留证。

Host 证明来自公开 Loader 的唯一启用 entry、ACTIVE Fiber、实际 import namespace 与 callback 一致，以及该 namespace 的 `pluginPackageVersion` 编译常量。client 读取公开 `ctx.modules.loadCache` 的 materialized exports，核 ACTIVE Fiber/callback，再读取相同编译常量。`desiredArtifactRevision` 只绑定当前公开 graph；它不证明 cache 实际加载了该修订。报告是已认证受控 client 的观察，不是远端密码学证明。Host 严格解析报告，绑定 process/page/nonce 和过期时间，再核自身 ACTIVE 版本及当前目标 graph；任意 `{kind:"active"}`、旧 process、错误 nonce、版本或目标修订均拒绝。03 的持久回执只在真实新 Host 进程与匹配 client 观察成立后完成；缺证明保持 pending/unknown。详情分别呈现 Host 与 client 实际观察版本，缺失观察显示未确认。

`waiting-lock` 与 `snapshotting` 分别显示等待其它插件操作与备份中；安装、验证、恢复、待重启和 unknown 使用 Host 的实际状态。

## 分层验证

`test:plugin-updates` 使用 `GEA_PLUGIN_UPDATE_SDK` 的绝对路径运行固定官方公开安装/锁源码合同、Host 路由与恢复回归、真实 pnpm 临时 profile 安装，以及实际生产构建的 client 在官方 Slots/Renderer 下的浏览器行为。浏览器测试检查已构建 `lib/client.js` 的依赖装载、按钮、错误、待重启、关闭/重入、样式及 effect 释放。来源使用本地生成的 Ed25519 签名与临时 TGZ，网络读取由受控 fixture 提供；安装使用官方 `runProfilePnpm` 与项目锁定的 pnpm 实际执行。新子进程通过公开 Host Loader、clientModules graph 和实际 client factory 证明新版本加载。原有故障恢复、锁冲突与 unknown 合同保留。

普通 CI 的受影响集合登记实际安装和浏览器测试；`typecheck:plugin-updates` 核未修改 SDK 的现有详情接口，不要求另一个 UI 候选。完整发行图校验和来源准入继续由普通包/发布入口负责。局部通过不代替远端完整 CI、Native、Windows 或业务验收。

验证明确批准的安装版时，将 `GEA_PLUGIN_UPDATE_DESKTOP_PROOF` 指向上述 `kind: "desktop"` 证明 JSON 的绝对路径，执行 `test:plugin-updates:desktop`。该独立验收入口要求调用者事先准备受保护的安装布局或只读快照；不会发现、复制或修改当前 App。它使用同一 Host 路由、实际 packaged SDK runner、真实 pnpm 与新子进程 Host/client 观察，并验证下面的 desktop release 准入。它不属于冷 CI 的默认输入，没有证明文件时立即失败，不静默跳过。

## 为已批准 desktop 构建生成 release

`create-plugin-release.mjs` 默认继续只接受已登记源码 Core。若要为明确批准的 desktop 构建准备本地 release，可加 `--desktop-core-proof /absolute/proof.json`，并使用 `node --expose-internals` 启动该命令。`release:preflight --input ... --desktop-core-proof ...` 与投影 CLI 复用同一 Core reader 与固定工具 SDK 的公开包解析器，验证安装布局、摘要与 SDK 解析；不会执行证明根内的代码。metadata.supportedCores 中额外的构建必须与验证返回的 head/version 完全匹配。普通来源登记、完整归档图和任意 head 的拒绝保持原规则；同版本不等于同构建。

输出仍是本地 release JSON 与 `published: false`。签名频道部署、正式 OSS、当前客户端安装、Native 和业务验收需要各自的有效输入与验收记录。

单包发行频道允许只发布 GEA。没有当前 release 的已安装包保持版本并显示“此频道尚未发布该插件”，不进入检查忙碌或更新计划；每次实际更新仍按当前全部已安装消费者校验替换后的完整图。

## 官方 Core 桌面包的公司包装

`desktop/official-branding.mjs` 在官方 electron-builder 配置上恢复 GEA Desktop 名称、App ID、Dock 图标及应用内图标资源。公司欢迎页只调用官方已有的工作台入口，不提供 DeepSeek 账号或 API Key 入口；未登录的桌面客户端打开 Workbench 现有公司扫码页，身份仍由 GEA Host 确认。保留官方运行时布局和校验回调，不修改 Core 源码。Core 的 About 内容仍由官方实现持有。

换装后由随包的更新适配命令调用 `desktop/configure-official-updates.mjs`。命令要求退出客户端、使用目标 App 的 Electron Node、匹配已安装三包版本，并通过原 Core reader 和签名发行检查；只替换原配置中的 Core 证明。来源、其它配置、WeKnora 和既有安装回执保留，原配置及回执先保存到 profile 的 `gea/plugin-updates/core-switches/`。同版本但不同构建仍分别验明，不添加任意构建回退。
