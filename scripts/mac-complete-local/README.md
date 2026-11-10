# 公司 Mac 签名与公证发版

Mac 默认入口是 `package:desktop:mac`，`package:desktop:mac:signed` 和 `build.mjs` 调用同一流程。它从固定 Core 完整构建，签署内嵌原生文件及 App，完成 App 和 DMG 的 Apple 公证、票据装订、严格验签、Gatekeeper、运行时冒烟与离线首次安装检查。检查全部通过后才整理可交付 DMG、在线更新 ZIP、blockmap、Nightly 清单和成功回执。缺少凭据、公证拒绝或验收失败均停止，不回退临时签名。旧 `package-desktop.mjs --target mac` 拒绝出包。

DMG 装订公证票据后会改变文件大小和摘要，交付前使用最终文件更新清单中的 DMG 大小与 SHA-512；ZIP 的大小和摘要必须与原清单一致，否则停止交付。electron-builder 原清单另存 `builder-update-info.json`，成功回执记录最终交付文件的大小与 SHA-256。

## 本机入口

默认复用 `~/Library/Application Support/GEA/signing/.env.macos`，也可用 `GEA_MAC_SIGNING_CONFIG_DIR` 指定独立私有目录。配置沿用固定 Core 的 `.env.macos` 字段，应用 ID 为 `com.cleverc2200.gea.desktop`；证书、p12 密码及公证密钥保存在源码树外。每个新版本都重新执行签名与公证。

```sh
# 检查配置及真实证书签名，不构建客户端、不提交公证材料
node scripts/mac-complete-local/signing.mjs /absolute/company-core --check

# 校验既有固定输入及桌面版本标签，不读取签名凭据
node scripts/mac-complete-local/full-source.mjs /absolute/company-core /absolute/gea /absolute/input.json --plan

# 默认签名、公证和在线更新构建
corepack pnpm run package:desktop:mac /absolute/company-core /absolute/gea /absolute/input.json
```

`input.json` 使用 `windows-complete-local/input.mjs` 的公司三包、独立个人记忆插件及 required Core 合同，正式构建仍要求已合并的发行源码和绑定 Core、全部包摘要的 annotated 桌面标签。个人记忆归档须包含编译后的设置客户端及独立来源提交。输出在 `$RUNNER_TEMP/gea-mac-source`。成功回执列出交付文件大小和 SHA-256；`release-plan.json` 核完整更新载荷，失败保留原诊断，不输出可交付安装包。

显式 `--candidate` 允许本地未合入源码，先核版本尚未发布，不创建远端标签、不上传包、不修改频道。候选仍必须签名、公证及通过全部验收。旧调用中的 `--online-update` 继续接受，在线更新现在默认开启。

## GitHub Actions

`delivery-fixtures.yml` 的 Mac 完整交付与 `mac-source-package.yml` 共用同一流程，只接收主线手动发版。正常发版提供既有固定 `desktop_input`；签名及公证凭据只在 `macos-release` environment 中配置，该环境的部署分支必须限制为 `main`。

| Environment Secret             | 内容                                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GEA_MACOS_SIGNING_P12_BASE64` | 含私钥的 p12 原件 Base64                                                                                                                              |
| `GEA_MACOS_NOTARY_KEY_BASE64`  | App Store Connect API 私钥 p8 原件 Base64                                                                                                             |
| `GEA_MACOS_SIGNING_ENV`        | 完整 `.env.macos` 配置，包含 p12 密码、签名身份、Team ID、Key ID、Issuer ID；其中 `CSC_LINK=developer-id-application.p12`、`APPLE_API_KEY=AuthKey.p8` |

工作流在独立 runner 临时目录以私有权限生成三个凭据文件，先验证 Apple 公证服务认证，再进入签名构建；结束或失败均移除这三个文件。PR 和非主线运行不进入签名 job。凭据不进入源码、构建回执或产物上传。`signing_check_only=true` 只验证凭据与真实签名身份，不构建或提交 App，也不交付安装包。

签名工作流最多等待 120 分钟。Apple 未完成公证时仍保持等待，超时或失败只上传 JSON、日志等诊断。DMG、ZIP 和更新清单仅在成功后作为独立产物上传；该步骤不上传 OSS、不发布 GitHub Release，也不推进正式频道。

## 分发与更新验收

App 在签名前写入公司更新地址 `https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/electron/mac-arm64/`；DMG 下载继续使用公司 `client-release/raw/`。不接入上游 Core 的更新或强制更新服务。正式分发必须使用[统一交付入口](../desktop-release.md)，同时发布安装包和完整更新载荷，不能只上传 DMG。公网发布与实际客户端安装更新分别验收。

旧 App 缺少 `app-update.yml` 时需要先手动安装新签名、公证 DMG，后续才可应用内下载、验签、替换和重启。代码合并、签名检查、Apple 公证、Gatekeeper、真实设备升级及正式分发分别记录，公证排队和本机隔离源测试均不代表已完成公网交付。
